import { connect, type NatsConnection } from "@nats-io/transport-node";
import type { Config } from "./config.js";

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

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async notifyApproval(notification: ApprovalNotification): Promise<void> {
    if (!this.config.approvalTelegramNotifyEnabled) {
      return;
    }

    const subject = this.subject();
    const text = this.message(notification);

    try {
      if (process.env.NODE_ENV === "local") {
        this.logger.info({ subject, text }, "approval telegram notification dry-run");
        return;
      }

      const nc = await this.connection();
      nc.publish(subject, JSON.stringify({ text }));
      await nc.flush();
      this.logger.info(
        {
          subject,
          repo: notification.repoFullName,
          prNumber: notification.prNumber,
          headSha: notification.headSha,
        },
        "approval telegram notification published",
      );
    } catch (error) {
      await this.resetConnection();
      this.logger.warn(
        {
          error,
          subject,
          repo: notification.repoFullName,
          prNumber: notification.prNumber,
          headSha: notification.headSha,
        },
        "approval telegram notification failed",
      );
    }
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
        "connected to NATS for approval telegram notifications",
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
      this.logger.warn({ error }, "NATS approval telegram connection close failed");
    }
  }

  private subject(): string {
    return `telegram.${this.config.approvalTelegramBot}.${this.config.approvalTelegramChannel}`;
  }

  private message(notification: ApprovalNotification): string {
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
}
