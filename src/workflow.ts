import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import mysql, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import type { App } from "octokit";
import type { Config } from "./config.js";
import type { PrBot, WorkflowCheckRecord } from "./bot.js";
import { metrics, type WorkflowQueueMetric } from "./metrics.js";

type Logger = {
  info: (value: unknown, message?: string) => void;
  warn: (value: unknown, message?: string) => void;
  error: (value: unknown, message?: string) => void;
};

type WebhookEvent = {
  id?: string;
  name?: string;
  payload: any;
};

type WorkflowRow = RowDataPacket & {
  id: number;
  dedupe_key: string;
  event_name: string;
  payload_json: string;
  attempts: number;
  max_attempts: number;
  check_run_id: number | null;
};

type WorkflowQueueMetricRow = RowDataPacket & {
  status: string;
  event_name: string;
  row_count: number | string;
  ready_count: number | string;
  oldest_age_seconds: number | string | null;
};

export type WorkflowRun = {
  id: number;
  dedupeKey: string;
  eventName: string;
  payload: any;
  attempts: number;
  maxAttempts: number;
  checkRunId: number | null;
};

export class MysqlWorkflowStore {
  private readonly pool: Pool;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.pool = mysql.createPool({
      host: config.mysqlHost,
      port: config.mysqlPort,
      user: config.mysqlUser,
      password: config.mysqlPassword,
      database: config.mysqlDatabase,
      waitForConnections: true,
      connectionLimit: 5,
      namedPlaceholders: false,
    });
  }

  async init(): Promise<void> {
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS gemini_pr_bot_workflows (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        dedupe_key VARCHAR(255) NOT NULL,
        event_name VARCHAR(80) NOT NULL,
        payload_json LONGTEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'queued',
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 3,
        lease_owner VARCHAR(160) NULL,
        lease_expires_at DATETIME(3) NULL,
        next_run_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        check_run_id BIGINT UNSIGNED NULL,
        check_kind VARCHAR(32) NULL,
        repo_full_name VARCHAR(255) NULL,
        pr_number INT NULL,
        head_sha VARCHAR(64) NULL,
        last_error TEXT NULL,
        started_at DATETIME(3) NULL,
        completed_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_gemini_pr_bot_workflows_dedupe (dedupe_key),
        KEY idx_gemini_pr_bot_workflows_ready (status, next_run_at),
        KEY idx_gemini_pr_bot_workflows_lease (status, lease_expires_at),
        KEY idx_gemini_pr_bot_workflows_pr (repo_full_name, pr_number, head_sha)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  async enqueue(eventName: string, dedupeKey: string, payload: any, delayMs = 0): Promise<boolean> {
    const payloadJson = JSON.stringify(payload);
    const [result] = await this.pool.execute<ResultSetHeader>(
      `
      INSERT IGNORE INTO gemini_pr_bot_workflows
        (dedupe_key, event_name, payload_json, status, max_attempts, next_run_at)
      VALUES (?, ?, ?, 'queued', ?, TIMESTAMPADD(MICROSECOND, ?, CURRENT_TIMESTAMP(3)))
      `,
      [dedupeKey, eventName, payloadJson, this.config.workflowMaxAttempts, delayMs * 1000],
    );
    return result.affectedRows > 0;
  }

  async leaseNext(workerId: string): Promise<WorkflowRun | null> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<WorkflowRow[]>(
        `
        SELECT
          id,
          dedupe_key,
          event_name,
          payload_json,
          attempts,
          max_attempts,
          check_run_id
        FROM gemini_pr_bot_workflows
        WHERE
          attempts < max_attempts
          AND (
            (status = 'queued' AND next_run_at <= CURRENT_TIMESTAMP(3))
            OR (status = 'running' AND lease_expires_at < CURRENT_TIMESTAMP(3))
          )
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
        `,
      );

      const row = rows[0];
      if (!row) {
        await connection.commit();
        return null;
      }

      await connection.execute(
        `
        UPDATE gemini_pr_bot_workflows
        SET
          status = 'running',
          attempts = attempts + 1,
          lease_owner = ?,
          lease_expires_at = TIMESTAMPADD(MICROSECOND, ?, CURRENT_TIMESTAMP(3)),
          started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3)),
          last_error = NULL
        WHERE id = ?
        `,
        [workerId, this.config.workflowLeaseMs * 1000, row.id],
      );

      await connection.commit();

      return {
        id: row.id,
        dedupeKey: row.dedupe_key,
        eventName: row.event_name,
        payload: JSON.parse(row.payload_json),
        attempts: row.attempts + 1,
        maxAttempts: row.max_attempts,
        checkRunId: row.check_run_id,
      };
    } catch (error) {
      await rollbackQuietly(connection, this.logger);
      throw error;
    } finally {
      connection.release();
    }
  }

  async recordCheckRun(id: number, record: WorkflowCheckRecord): Promise<void> {
    await this.pool.execute(
      `
      UPDATE gemini_pr_bot_workflows
      SET
        check_run_id = ?,
        check_kind = ?,
        repo_full_name = ?,
        pr_number = ?,
        head_sha = ?
      WHERE id = ?
      `,
      [record.checkRunId, record.kind, record.repoFullName, record.prNumber, record.headSha, id],
    );
  }

  async complete(id: number): Promise<void> {
    await this.pool.execute(
      `
      UPDATE gemini_pr_bot_workflows
      SET
        status = 'completed',
        lease_owner = NULL,
        lease_expires_at = NULL,
        completed_at = CURRENT_TIMESTAMP(3),
        last_error = NULL
      WHERE id = ?
      `,
      [id],
    );
  }

  async fail(run: WorkflowRun, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const willRetry = run.attempts < run.maxAttempts;
    const retryDelaySeconds = Math.min(300, 15 * 2 ** Math.max(0, run.attempts - 1));
    await this.pool.execute(
      `
      UPDATE gemini_pr_bot_workflows
      SET
        status = ?,
        lease_owner = NULL,
        lease_expires_at = NULL,
        next_run_at = IF(? = 'queued', TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3)), next_run_at),
        completed_at = IF(? = 'failed', CURRENT_TIMESTAMP(3), completed_at),
        last_error = ?
      WHERE id = ?
      `,
      [
        willRetry ? "queued" : "failed",
        willRetry ? "queued" : "failed",
        retryDelaySeconds,
        willRetry ? "queued" : "failed",
        truncateError(message),
        run.id,
      ],
    );
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  async queueMetrics(): Promise<WorkflowQueueMetric[]> {
    const [rows] = await this.pool.execute<WorkflowQueueMetricRow[]>(`
      SELECT
        status,
        event_name,
        COUNT(*) AS row_count,
        SUM(CASE WHEN status = 'queued' AND next_run_at <= CURRENT_TIMESTAMP(3) THEN 1 ELSE 0 END) AS ready_count,
        MAX(TIMESTAMPDIFF(MICROSECOND, created_at, CURRENT_TIMESTAMP(3))) / 1000000 AS oldest_age_seconds
      FROM gemini_pr_bot_workflows
      GROUP BY status, event_name
      ORDER BY status, event_name
    `);

    return rows.map((row) => ({
      status: row.status,
      eventName: row.event_name,
      count: Number(row.row_count || 0),
      readyCount: Number(row.ready_count || 0),
      oldestAgeSeconds: Number(row.oldest_age_seconds || 0),
    }));
  }
}

export class WorkflowEngine {
  private readonly workerId = `${os.hostname()}-${process.pid}-${randomUUID()}`;
  private running = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly app: App,
    private readonly bot: PrBot,
    private readonly store: MysqlWorkflowStore,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    await this.store.init();
    this.running = true;
    this.loopPromise = this.loop();
    this.logger.info(
      {
        workerId: this.workerId,
        pollIntervalMs: this.config.workflowPollIntervalMs,
        leaseMs: this.config.workflowLeaseMs,
      },
      "workflow worker started",
    );
  }

  async enqueue(eventName: string, event: WebhookEvent): Promise<void> {
    const dedupeKey = this.dedupeKey(eventName, event);
    const inserted = await this.store.enqueue(eventName, dedupeKey, event.payload);
    metrics.recordWorkflowEnqueued(eventName, "webhook", inserted);
    this.logger.info(
      {
        event: eventName,
        dedupeKey,
        inserted,
        repo: event.payload.repository?.full_name,
        action: event.payload.action,
      },
      "workflow enqueued",
    );
  }

  async enqueueSynthetic(eventName: string, dedupeKey: string, payload: any, delayMs = 0): Promise<boolean> {
    const inserted = await this.store.enqueue(eventName, dedupeKey, payload, delayMs);
    metrics.recordWorkflowEnqueued(eventName, "synthetic", inserted);
    this.logger.info(
      {
        event: eventName,
        dedupeKey,
        inserted,
        delayMs,
        repo: payload.repository?.full_name,
        action: payload.action,
      },
      "synthetic workflow enqueued",
    );
    return inserted;
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
    await this.store.end();
  }

  async queueMetrics(): Promise<WorkflowQueueMetric[]> {
    return this.store.queueMetrics();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        let processed = false;
        do {
          processed = await this.processOne();
        } while (this.running && processed);
      } catch (error) {
        this.logger.error({ error }, "workflow worker loop failed");
      }

      if (this.running) {
        await delay(this.config.workflowPollIntervalMs);
      }
    }
  }

  private async processOne(): Promise<boolean> {
    const run = await this.store.leaseNext(this.workerId);
    if (!run) {
      return false;
    }

    this.logger.info(
      {
        workflowId: run.id,
        event: run.eventName,
        attempt: run.attempts,
        maxAttempts: run.maxAttempts,
      },
      "workflow leased",
    );
    metrics.recordWorkflowLeased(run.eventName);

    const startedAt = Date.now();
    try {
      const installationId = run.payload.installation?.id;
      if (!installationId) {
        throw new Error("Webhook payload does not include installation.id");
      }

      const installationToken = await this.createInstallationToken(installationId);
      const octokit = await this.app.getInstallationOctokit(installationId);
      await this.bot.processEvent(octokit, run.eventName, run.payload, {
        checkRunId: run.checkRunId,
        installationId,
        installationToken,
        recordCheckRun: (record) => this.store.recordCheckRun(run.id, record),
        enqueueSynthetic: (eventName, dedupeKey, payload, delayMs) =>
          this.enqueueSynthetic(eventName, dedupeKey, payload, delayMs),
      });
      await this.store.complete(run.id);
      metrics.recordWorkflowCompleted(run.eventName, elapsedSecondsSince(startedAt));
      this.logger.info({ workflowId: run.id, event: run.eventName }, "workflow completed");
    } catch (error) {
      await this.store.fail(run, error);
      metrics.recordWorkflowFailed(run.eventName, run.attempts >= run.maxAttempts, elapsedSecondsSince(startedAt));
      this.logger.error(
        {
          error,
          workflowId: run.id,
          event: run.eventName,
          attempt: run.attempts,
          maxAttempts: run.maxAttempts,
        },
        "workflow failed",
      );
    }

    return true;
  }

  private async createInstallationToken(installationId: number): Promise<string | undefined> {
    try {
      const result = await (this.app as any).octokit.rest.apps.createInstallationAccessToken({
        installation_id: installationId,
      });
      return result.data.token;
    } catch (error) {
      this.logger.warn({ error }, "installation token unavailable for deep repo context");
      return undefined;
    }
  }

  private dedupeKey(eventName: string, event: WebhookEvent): string {
    if (event.id) {
      return event.id;
    }

    const payload = JSON.stringify(event.payload);
    return `${eventName}:${createHash("sha256").update(payload).digest("hex")}`;
  }
}

async function rollbackQuietly(connection: PoolConnection, logger: Logger): Promise<void> {
  try {
    await connection.rollback();
  } catch (error) {
    logger.warn({ error }, "workflow transaction rollback failed");
  }
}

function truncateError(value: string): string {
  return value.length > 65_000 ? `${value.slice(0, 64_000)}\n...truncated...` : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function elapsedSecondsSince(startedAtMs: number): number {
  return (Date.now() - startedAtMs) / 1000;
}
