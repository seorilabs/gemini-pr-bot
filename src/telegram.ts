import { connect, type NatsConnection } from "@nats-io/transport-node";
import type { AiReviewProviderName, Config } from "./config.js";
import type { AiProviderQuotaEvent } from "./gemini.js";

type Logger = {
  info: (value: unknown, message?: string) => void;
  warn: (value: unknown, message?: string) => void;
};

export type ApprovalNotificationMode = "manual" | "review" | "agent";

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

type QuotaProviderSummary = {
  count: number;
  firstAt: string;
  lastAt: string;
  cooldownUntil: string;
  lastError: string;
  kinds: Set<string>;
};

const modeLabels: Record<ApprovalNotificationMode, string> = {
  manual: "명시 승인",
  review: "자동 리뷰 승인",
  agent: "에이전트 승인",
};

function singleLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export class ApprovalTelegramNotifier {
  private nc: NatsConnection | null = null;
  private readonly quotaSummary = new Map<AiReviewProviderName, QuotaProviderSummary>();
  private lastQuotaSummaryAt = 0;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async notifyApproval(notification: ApprovalNotification): Promise<void> {
    if (!this.config.approvalTelegramNotifyEnabled) {
      return;
    }

    await this.publishText(this.approvalMessage(notification), "approval telegram notification", {
      repo: notification.repoFullName,
      prNumber: notification.prNumber,
      headSha: notification.headSha,
    });
  }

  async notifyQuotaEvent(event: AiProviderQuotaEvent): Promise<void> {
    if (!this.config.quotaTelegramNotifyEnabled) {
      return;
    }

    this.recordQuotaEvent(event);
    const now = Date.parse(event.occurredAt);
    if (
      this.lastQuotaSummaryAt > 0 &&
      now - this.lastQuotaSummaryAt < this.config.quotaTelegramSummaryIntervalMs
    ) {
      return;
    }

    await this.publishText(this.quotaMessage(event), "quota telegram notification", {
      provider: event.provider,
      kind: event.kind,
      selectedProvider: event.selectedProvider,
    });
    this.lastQuotaSummaryAt = now;
  }

  async close(): Promise<void> {
    await this.resetConnection();
  }

  private async connection(): Promise<NatsConnection> {
    if (!this.nc) {
      this.nc = await connect({ servers: this.config.natsServerUrl });
      this.logger.info(
        {
          server: this.config.natsServerUrl,
          subject: this.subject(),
        },
        "connected to NATS for telegram notifications",
      );
    }
    return this.nc;
  }

  private async resetConnection(): Promise<void> {
    const nc = this.nc;
    this.nc = null;
    if (!nc) {
      return;
    }

    try {
      await nc.drain();
    } catch (error) {
      this.logger.warn({ error }, "NATS telegram connection close failed");
    }
  }

  private subject(): string {
    return `telegram.${this.config.approvalTelegramBot}.${this.config.approvalTelegramChannel}`;
  }

  private async publishText(text: string, logName: string, context: Record<string, unknown>): Promise<void> {
    const subject = this.subject();

    try {
      if (process.env.NODE_ENV === "local") {
        this.logger.info({ subject, text, ...context }, `${logName} dry-run`);
        return;
      }

      const nc = await this.connection();
      nc.publish(subject, JSON.stringify({ text }));
      await nc.flush();
      this.logger.info({ subject, ...context }, `${logName} published`);
    } catch (error) {
      await this.resetConnection();
      this.logger.warn({ error, subject, ...context }, `${logName} failed`);
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
      "[Seori PR 승인]",
      `저장소: ${notification.repoFullName}`,
      `PR: #${notification.prNumber} ${singleLine(notification.prTitle, 120)}`,
      `URL: ${notification.prUrl}`,
      `HEAD: ${notification.headSha.slice(0, 12)}`,
      `방식: ${modeLabels[notification.mode]}`,
      `트리거: ${notification.source}`,
      `요청자: @${notification.sender}`,
      `사유: ${singleLine(notification.reason, 300)}`,
    ].join("\n");
  }

  private quotaMessage(event: AiProviderQuotaEvent): string {
    const providers = [...this.quotaSummary.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, summary]) =>
        [
          `- ${provider}: ${summary.count}회`,
          `  작업: ${[...summary.kinds].sort().join(", ")}`,
          `  첫 감지: ${summary.firstAt}`,
          `  마지막 감지: ${summary.lastAt}`,
          `  cooldown 해제 예정: ${summary.cooldownUntil}`,
          `  마지막 오류: ${singleLine(summary.lastError, 240)}`,
        ].join("\n"),
      );

    return [
      "[Seori AI 쿼타 요약]",
      `감지 시각: ${event.occurredAt}`,
      `이번 감지: ${event.provider} (${event.kind})`,
      `선택 provider: ${event.selectedProvider}`,
      `라우팅: ${this.config.aiReviewProviders.join(", ")}`,
      `가중치: ${Object.entries(this.config.aiReviewProviderWeights)
        .map(([provider, weight]) => `${provider}:${weight}`)
        .join(", ")}`,
      `fallback: ${this.config.aiReviewProviderFallbackOrder.join(", ")}`,
      "",
      "쿼타/Rate limit 의심 이벤트:",
      ...providers,
      "",
      "참고: CLI/API 오류에서 실제 잔여 쿼터는 노출되지 않아, 감지 오류와 cooldown 기준으로 요약합니다.",
    ].join("\n");
  }
}
