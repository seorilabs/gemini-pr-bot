import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { App } from "octokit";
import pino from "pino";
import { loadConfig } from "./config.js";
import { TtlSet } from "./dedupe.js";
import { STALE_REVIEW_SELF_TRIGGER_EVENT } from "./events.js";
import { PrBot } from "./bot.js";
import { StaleReviewMonitor, staleSelfTriggerDedupeKey, staleSelfTriggerPayload } from "./stale.js";
import { MysqlWorkflowStore, WorkflowEngine } from "./workflow.js";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const config = loadConfig();
const deliveries = new TtlSet(config.deliveryTtlMs);

const app = new App({
  appId: config.githubAppId,
  privateKey: config.githubPrivateKey,
  webhooks: {
    secret: config.githubWebhookSecret,
  },
});

const bot = new PrBot(config, logger);
const workflowEngine =
  config.workflowStore === "mysql"
    ? new WorkflowEngine(app, bot, new MysqlWorkflowStore(config, logger), config, logger)
    : null;
const staleReviewMonitor = new StaleReviewMonitor(app, config, logger, async (octokit, request) => {
  const payload = staleSelfTriggerPayload(request);
  if (workflowEngine) {
    return workflowEngine.enqueueSynthetic(
      STALE_REVIEW_SELF_TRIGGER_EVENT,
      staleSelfTriggerDedupeKey(request),
      payload,
    );
  }

  await bot.processEvent(octokit, STALE_REVIEW_SELF_TRIGGER_EVENT, payload);
  return true;
});

function deliveryIdFromEvent(event: any): string | undefined {
  return event.id || event.delivery || event.payload?.delivery;
}

async function handleWebhookEvent(eventName: string, event: any, fallback: () => void): Promise<void> {
  if (!workflowEngine) {
    fallback();
    return;
  }

  await workflowEngine.enqueue(eventName, {
    id: deliveryIdFromEvent(event),
    name: eventName,
    payload: event.payload,
  });
}

app.webhooks.on("issue_comment.created", async (event) => {
  await handleWebhookEvent("issue_comment", event, () => bot.scheduleIssueComment(event));
});

app.webhooks.on("pull_request_review_comment.created", async (event) => {
  await handleWebhookEvent("pull_request_review_comment", event, () => bot.scheduleReviewComment(event));
});

app.webhooks.on("pull_request_review.submitted", async (event) => {
  await handleWebhookEvent("pull_request_review", event, () => bot.schedulePullRequestReview(event));
});

app.webhooks.on(["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"], async (event) => {
  await handleWebhookEvent("pull_request", event, () => bot.schedulePullRequest(event));
});

app.webhooks.onError((error) => {
  logger.error({ error }, "webhook dispatch failed");
});

function writeText(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error("Webhook payload too large");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
      writeText(res, 200, "ok\n");
      return;
    }

    if (req.method !== "POST" || url.pathname !== "/github/webhook") {
      writeText(res, 404, "not found\n");
      return;
    }

    const delivery = String(req.headers["x-github-delivery"] || "");
    const name = String(req.headers["x-github-event"] || "");
    const signature = String(req.headers["x-hub-signature-256"] || "");
    if (!delivery || !name || !signature) {
      writeText(res, 400, "missing github webhook headers\n");
      return;
    }

    if (deliveries.has(delivery)) {
      logger.info({ delivery, event: name }, "duplicate webhook delivery ignored");
      writeText(res, 202, "duplicate\n");
      return;
    }

    const payload = await readBody(req, config.maxWebhookBodyBytes);
    deliveries.add(delivery);

    try {
      await app.webhooks.verifyAndReceive({
        id: delivery,
        name,
        signature,
        payload,
      });
    } catch (error) {
      deliveries.delete(delivery);
      throw error;
    }

    writeText(res, 202, "accepted\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ error }, "webhook request rejected");
    writeText(res, 400, `${message}\n`);
  }
});

setInterval(() => deliveries.deleteExpired(), Math.min(config.deliveryTtlMs, 60_000)).unref();

let shuttingDown = false;

function closeServer(): Promise<void> {
  return new Promise((resolve) => {
    server.close((error) => {
      if (error) {
        logger.warn({ error }, "HTTP server close returned an error");
      }
      resolve();
    });
    server.closeIdleConnections?.();
  });
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.warn({ signal }, "shutdown signal received");

  const forceExitTimer = setTimeout(() => {
    logger.error({ signal }, "shutdown grace period exceeded");
    server.closeAllConnections?.();
    process.exit(1);
  }, config.shutdownGraceMs).unref();

  try {
    await Promise.all([closeServer(), staleReviewMonitor.stop(), workflowEngine?.stop(), bot.shutdown(signal)]);
    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExitTimer);
    logger.error({ error, signal }, "shutdown failed");
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

if (workflowEngine) {
  await workflowEngine.start();
}
staleReviewMonitor.start();

server.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      org: config.githubOrg,
      provider: config.geminiProvider,
      model: config.geminiModel || "default",
      reviewProviders: config.aiReviewProviders,
      reviewProviderWeights: config.aiReviewProviderWeights,
      reviewProviderFallbackOrder: config.aiReviewProviderFallbackOrder,
      copilotModel: config.copilotModel || "default",
      cursorModel: config.cursorModel || "default",
      workflowStore: config.workflowStore,
      allowPublicRepos: config.allowPublicRepos,
      autoReviewOnOpen: config.autoReviewOnOpen,
      autoReviewOnSynchronize: config.autoReviewOnSynchronize,
      autoReviewIgnoredRepositories: [...config.autoReviewIgnoredRepositories],
      deepRepoContextMode: config.deepRepoContextMode,
      deepRepoContextMaxFiles: config.deepRepoContextMaxFiles,
      deepRepoContextMaxBytes: config.deepRepoContextMaxBytes,
      quotaTelegramNotifyEnabled: config.quotaTelegramNotifyEnabled,
      staleReviewCloseEnabled: config.staleReviewCloseEnabled,
      staleReviewThresholdMs: config.staleReviewThresholdMs,
      staleReviewScanIntervalMs: config.staleReviewScanIntervalMs,
    },
    "Seori review bot listening",
  );
});
