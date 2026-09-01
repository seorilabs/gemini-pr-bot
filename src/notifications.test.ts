import assert from "node:assert/strict";
import test from "node:test";
import type { Config } from "./config.js";
import type { AiProviderQuotaEvent } from "./ai-client.js";
import { notificationErrorMessage, OperationsNotifier } from "./notifications.js";

const config = {
  quotaDiscordNotifyEnabled: true,
  quotaDiscordSummaryIntervalMs: 60 * 60 * 1000,
  natsServerUrl: "nats://operator:secret@nats.private.example:4222",
  aiReviewProviders: ["minimax"],
  aiReviewProviderWeights: { minimax: 100 },
  aiReviewProviderFallbackOrder: ["minimax"],
} as Config;

const logger = {
  info: () => undefined,
  warn: () => undefined,
};

function quotaEvent(occurredAt: string): AiProviderQuotaEvent {
  return {
    provider: "minimax",
    selectedProvider: "minimax",
    kind: "review",
    occurredAt,
    cooldownMs: 60 * 60 * 1000,
    cooldownUntil: "2026-08-18T13:00:00.000Z",
    errorMessage: "quota exceeded",
  };
}

test("NATS 오류 로그에서 설정 주소와 user:pass@host를 제거한다", () => {
  const error = [
    "connect failed",
    config.natsServerUrl,
    "operator:secret@nats.private.example:4222",
    "nats://fallback.private.example:4222",
  ].join(" ");

  const message = notificationErrorMessage(error, config.natsServerUrl);

  assert.doesNotMatch(message, /operator|secret|nats\.private\.example|fallback\.private\.example/);
  assert.match(message, /\[REDACTED\]/);
});

test("quota 알림 실패 뒤에도 요약 주기 동안 재전송하지 않는다", async () => {
  const notifier = new OperationsNotifier(config, logger);
  let publishAttempts = 0;
  const internals = notifier as unknown as {
    publishText: (...args: unknown[]) => Promise<boolean>;
  };
  internals.publishText = async () => {
    publishAttempts += 1;
    return false;
  };

  await notifier.notifyQuotaEvent(quotaEvent("2026-08-18T12:00:00.000Z"));
  await notifier.notifyQuotaEvent(quotaEvent("2026-08-18T12:01:00.000Z"));

  assert.equal(publishAttempts, 1);
});
