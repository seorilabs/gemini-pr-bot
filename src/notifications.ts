import { createHash } from "node:crypto";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import type { AiReviewProviderName, Config } from "./config.js";
import type { AiProviderQuotaEvent } from "./ai-client.js";
import type { MiniMaxGateResponse } from "./minimax-gate.js";

type Logger = {
  info: (value: unknown, message?: string) => void;
  warn: (value: unknown, message?: string) => void;
};

export type ApprovalNotificationMode = "manual" | "force_manual" | "review" | "review_gate" | "agent";

export type ApprovalNotification = {
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  headSha: string;
  sender: string;
  source: string;
  reason: string;
  mode: ApprovalNotificationMode;
};

export type ReviewAuditContext = {
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  headSha: string;
  workflowId?: number;
};

export type ReviewAuditSession = ReviewAuditContext & {
  parentId: string;
  threadName: string;
};

export type ReviewAuditEntry = {
  entryKey: string;
  title: string;
  text: string;
};

type NotificationAttachment = {
  filename: string;
  contentType: string;
  base64: string;
};

type NotificationThread = {
  parentId: string;
  name: string;
  plain?: boolean;
};

type NotificationPayloadOptions = {
  attachment?: NotificationAttachment;
  thread?: NotificationThread;
};

type QuotaProviderSummary = {
  count: number;
  firstAt: string;
  lastAt: string;
  cooldownUntil: string;
  lastError: string;
  kinds: Set<string>;
};

type NotificationAck = { accepted?: boolean; id?: string; error?: string };

const SUBJECT = "ops.notification.v1.seori-review";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const modeLabels: Record<ApprovalNotificationMode, string> = {
  manual: "명시 승인",
  force_manual: "검증 스킵 승인",
  review: "자동 리뷰 승인",
  review_gate: "보수적 Gate 승인",
  agent: "에이전트 승인",
};

function singleLine(value: string, maxLength: number): string {
  const normalized = value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/[A-Za-z0-9_-]{80,}/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function notificationErrorMessage(value: string, natsServerUrl: string, maxLength = 300): string {
  let redacted = value;
  for (const configuredServer of natsServerUrl.split(",").map((server) => server.trim()).filter(Boolean)) {
    redacted = redacted.replaceAll(configuredServer, "[REDACTED]");
    try {
      const serverUrl = new URL(configuredServer);
      if (serverUrl.host) redacted = redacted.replaceAll(serverUrl.host, "[REDACTED]");
    } catch {
      // connect() will report malformed server URLs; the exact value was already removed above.
    }
  }
  redacted = redacted
    .replace(/\b(?:nats|tls|ws|wss):\/\/[^\s,;]+/gi, "[REDACTED]")
    .replace(/\b[^\s/:@]+:[^\s/@]+@[^\s,;]+/g, "[REDACTED]");
  return singleLine(redacted, maxLength);
}

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

export class OperationsNotifier {
  private nc: NatsConnection | null = null;
  private readonly quotaSummary = new Map<AiReviewProviderName, QuotaProviderSummary>();
  private lastQuotaSummaryAt = 0;

  constructor(private readonly config: Config, private readonly logger: Logger) {}

  async notifyApproval(notification: ApprovalNotification): Promise<void> {
    if (!this.config.approvalDiscordNotifyEnabled) return;
    await this.publishText(
      stableId("approval", notification.repoFullName, String(notification.prNumber), notification.headSha, notification.mode),
      this.approvalMessage(notification),
      "approval Discord notification",
      { repo: notification.repoFullName, prNumber: notification.prNumber, headSha: notification.headSha },
    );
  }

  async startReviewAudit(context: ReviewAuditContext): Promise<ReviewAuditSession | null> {
    if (!this.config.reviewDiscordAuditEnabled) return null;
    const workflowIdentity = context.workflowId === undefined ? "direct" : String(context.workflowId);
    const parentId = stableId(
      "review-audit",
      context.repoFullName,
      String(context.prNumber),
      context.headSha,
      workflowIdentity,
    );
    const repoName = context.repoFullName.split("/").at(-1) || context.repoFullName;
    const session: ReviewAuditSession = {
      ...context,
      parentId,
      threadName: `${repoName} #${context.prNumber} 리뷰 로그 ${context.headSha.slice(0, 12)}`.slice(0, 100),
    };
    const accepted = await this.publishText(
      parentId,
      this.reviewAuditRootMessage(session),
      "review Discord audit root",
      {
        repo: context.repoFullName,
        prNumber: context.prNumber,
        headSha: context.headSha,
        workflowId: context.workflowId,
      },
    );
    return accepted ? session : null;
  }

  async notifyReviewAuditEntry(
    session: ReviewAuditSession | null,
    entry: ReviewAuditEntry,
  ): Promise<void> {
    if (!session) return;
    const contentHash = createHash("sha256").update(entry.text).digest("hex");
    await this.publishText(
      stableId("review-audit-entry", session.parentId, entry.entryKey, contentHash),
      [`**${entry.title}**`, "", entry.text].join("\n"),
      "review Discord audit entry",
      {
        repo: session.repoFullName,
        prNumber: session.prNumber,
        headSha: session.headSha,
        entryKey: entry.entryKey,
      },
      {
        thread: { parentId: session.parentId, name: session.threadName, plain: false },
      },
    );
  }

  async notifyMiniMaxResponse(
    session: ReviewAuditSession | null,
    response: MiniMaxGateResponse,
  ): Promise<void> {
    if (!session) return;
    const bodyHash = createHash("sha256").update(response.rawBody).digest("hex");
    const phaseSlug = response.phase
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "response";
    const contentType = (response.contentType?.split(";", 1)[0]?.trim() || "text/plain").slice(0, 100);
    const extension = contentType === "application/json" ? "json" : "txt";
    const filename = `minimax-${phaseSlug}-${bodyHash.slice(0, 12)}.${extension}`.slice(0, 120);
    const byteLength = Buffer.byteLength(response.rawBody, "utf8");
    const text = [
      `단계: ${response.phase}`,
      `모델: ${response.model}`,
      `HTTP: ${response.status} ${response.ok ? "성공" : "실패"}`,
      `수신: ${response.receivedAt}`,
      response.requestId ? `request id: \`${singleLine(response.requestId, 160)}\`` : "request id: 응답 헤더에 없음",
      byteLength > 0
        ? `원문: \`${filename}\` 첨부 · ${byteLength.toLocaleString("en-US")} bytes`
        : "원문: 빈 응답 body",
    ].join("\n");
    await this.publishText(
      stableId("review-audit-minimax", session.parentId, response.phase, bodyHash),
      [`**MiniMax API 응답 원문**`, "", text].join("\n"),
      "MiniMax Discord audit response",
      {
        repo: session.repoFullName,
        prNumber: session.prNumber,
        headSha: session.headSha,
        phase: response.phase,
        status: response.status,
        bodyBytes: byteLength,
      },
      {
        thread: { parentId: session.parentId, name: session.threadName, plain: false },
        ...(byteLength > 0
          ? {
              attachment: {
                filename,
                contentType,
                base64: Buffer.from(response.rawBody, "utf8").toString("base64"),
              },
            }
          : {}),
      },
    );
  }

  async notifyQuotaEvent(event: AiProviderQuotaEvent): Promise<void> {
    if (!this.config.quotaDiscordNotifyEnabled) return;
    this.recordQuotaEvent(event);
    const now = Date.parse(event.occurredAt);
    if (this.lastQuotaSummaryAt > 0 && now - this.lastQuotaSummaryAt < this.config.quotaDiscordSummaryIntervalMs) return;
    this.lastQuotaSummaryAt = now;
    const accepted = await this.publishText(
      stableId("quota", event.provider, event.kind, event.occurredAt),
      this.quotaMessage(event),
      "quota Discord notification",
      { provider: event.provider, kind: event.kind, selectedProvider: event.selectedProvider },
    );
    if (accepted) {
      this.quotaSummary.clear();
    }
  }

  async close(): Promise<void> {
    await this.resetConnection();
  }

  private async connection(): Promise<NatsConnection> {
    if (!this.nc) {
      this.nc = await connect({ servers: this.config.natsServerUrl, name: "seori-pr-bot-notifications" });
      this.logger.info({ subject: SUBJECT }, "connected to NATS for operations notifications");
    }
    return this.nc;
  }

  private async resetConnection(): Promise<void> {
    const nc = this.nc;
    this.nc = null;
    if (!nc) return;
    try {
      await nc.drain();
    } catch (error) {
      this.logger.warn({
        error: notificationErrorMessage(error instanceof Error ? error.message : String(error), this.config.natsServerUrl),
      }, "NATS notification connection close failed");
    }
  }

  private async publishText(
    id: string,
    text: string,
    logName: string,
    context: Record<string, unknown>,
    options: NotificationPayloadOptions = {},
  ): Promise<boolean> {
    try {
      if (process.env.NODE_ENV === "local") {
        this.logger.info({ subject: SUBJECT, id, ...context }, `${logName} dry-run`);
        return true;
      }
      const nc = await this.connection();
      const response = await nc.request(
        SUBJECT,
        encoder.encode(JSON.stringify({
          version: 1,
          id,
          source: "seori-pr-bot",
          text,
          occurredAt: new Date().toISOString(),
          ...options,
        })),
        { timeout: 5_000 },
      );
      const ack = JSON.parse(decoder.decode(response.data)) as NotificationAck;
      if (!ack.accepted) throw new Error(ack.error || "notification rejected");
      this.logger.info({ subject: SUBJECT, id, ...context }, `${logName} accepted`);
      return true;
    } catch (error) {
      await this.resetConnection();
      this.logger.warn({
        error: notificationErrorMessage(error instanceof Error ? error.message : String(error), this.config.natsServerUrl),
        subject: SUBJECT,
        id,
        ...context,
      }, `${logName} failed`);
      return false;
    }
  }

  private recordQuotaEvent(event: AiProviderQuotaEvent): void {
    const existing = this.quotaSummary.get(event.provider);
    if (!existing) {
      this.quotaSummary.set(event.provider, {
        count: 1,
        firstAt: event.occurredAt,
        lastAt: event.occurredAt,
        cooldownUntil: event.cooldownUntil,
        lastError: event.errorMessage,
        kinds: new Set([event.kind]),
      });
      return;
    }
    existing.count += 1;
    existing.lastAt = event.occurredAt;
    existing.cooldownUntil = event.cooldownUntil;
    existing.lastError = event.errorMessage;
    existing.kinds.add(event.kind);
  }

  private approvalMessage(notification: ApprovalNotification): string {
    return [
      "✅ **Seori PR 승인**",
      `저장소: ${notification.repoFullName}`,
      `PR: [#${notification.prNumber} ${singleLine(notification.prTitle, 120)}](${notification.prUrl})`,
      `HEAD: \`${notification.headSha.slice(0, 12)}\``,
      `방식: ${modeLabels[notification.mode]} · 트리거: ${notification.source}`,
      `요청자: @${notification.sender}`,
      `사유: ${singleLine(notification.reason, 300)}`,
    ].join("\n");
  }

  private reviewAuditRootMessage(session: ReviewAuditSession): string {
    return [
      "🔎 **Seori PR 리뷰 로그**",
      `저장소: ${session.repoFullName}`,
      `PR: [#${session.prNumber} ${singleLine(session.prTitle, 120)}](${session.prUrl})`,
      `HEAD: \`${session.headSha.slice(0, 12)}\``,
      session.workflowId === undefined ? "실행: 직접 실행" : `workflow: \`${session.workflowId}\``,
      "서리 리뷰, 잔소리 리뷰, MiniMax API 응답 원문은 이 메시지의 쓰레드에 기록됩니다.",
    ].join("\n");
  }

  private quotaMessage(event: AiProviderQuotaEvent): string {
    const providers = [...this.quotaSummary.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, summary]) => [
        `- **${provider}** ${summary.count}회 · ${[...summary.kinds].sort().join(", ")}`,
        `  감지 ${summary.firstAt} ~ ${summary.lastAt} · cooldown ${summary.cooldownUntil}`,
        `  오류: ${singleLine(summary.lastError, 240)}`,
      ].join("\n"));
    return [
      "⚠️ **Seori AI 쿼타 요약**",
      `감지: ${event.provider} (${event.kind}) · 선택 provider: ${event.selectedProvider}`,
      `라우팅: ${this.config.aiReviewProviders.join(", ")}`,
      `가중치: ${Object.entries(this.config.aiReviewProviderWeights).map(([provider, weight]) => `${provider}:${weight}`).join(", ")}`,
      `fallback: ${this.config.aiReviewProviderFallbackOrder.join(", ")}`,
      "",
      ...providers,
      "",
      "실제 잔여 쿼터는 provider 응답에 없어 감지 오류와 cooldown을 보고합니다.",
    ].join("\n");
  }
}
