import assert from "node:assert/strict";
import test from "node:test";
import type { Config } from "./config.js";
import type { AiProviderQuotaEvent } from "./ai-client.js";
import { notificationErrorMessage, OperationsNotifier } from "./notifications.js";

const config = {
  reviewDiscordAuditEnabled: true,
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

test("PR 링크를 부모로 만들고 MiniMax HTTP 응답 원문을 Discord 쓰레드 첨부로 보낸다", async () => {
  const notifier = new OperationsNotifier(config, logger);
  const published: unknown[][] = [];
  const internals = notifier as unknown as {
    publishText: (...args: unknown[]) => Promise<boolean>;
  };
  internals.publishText = async (...args) => {
    published.push(args);
    return true;
  };

  const session = await notifier.startReviewAudit({
    repoFullName: "seorilabs/happy-farm",
    prNumber: 466,
    prTitle: "수확 보상 회귀 수정",
    prUrl: "https://github.com/seorilabs/happy-farm/pull/466",
    headSha: "1234567890abcdef",
    workflowId: 987,
  });
  assert.ok(session);
  await notifier.notifyMiniMaxResponse(session, {
    phase: "결함 후보 탐색",
    model: "MiniMax-M3",
    status: 200,
    ok: true,
    contentType: "application/json; charset=utf-8",
    requestId: "req-123",
    rawBody: '{"content":[{"type":"thinking","thinking":"원문"}]}',
    receivedAt: "2026-09-08T00:00:00.000Z",
  });

  assert.equal(published.length, 2);
  assert.match(String(published[0]?.[1]), /pull\/466/u);
  const options = published[1]?.[4] as {
    thread: { parentId: string; name: string; plain: boolean };
    attachment: { filename: string; contentType: string; base64: string };
  };
  assert.equal(options.thread.parentId, session!.parentId);
  assert.equal(options.thread.plain, false);
  assert.match(options.attachment.filename, /^minimax-/u);
  assert.equal(options.attachment.contentType, "application/json");
  assert.equal(
    Buffer.from(options.attachment.base64, "base64").toString("utf8"),
    '{"content":[{"type":"thinking","thinking":"원문"}]}',
  );
});
