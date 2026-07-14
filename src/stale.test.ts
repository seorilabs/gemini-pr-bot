import assert from "node:assert/strict";
import test from "node:test";
import { botStatusMarker } from "./identity.js";
import { latestReviewSignal } from "./stale.js";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const BOT_USER = { login: "seorilabs-seori-pr-bot[bot]", type: "Bot" };

function issueComment(body: string, createdAt: string) {
  return { body, created_at: createdAt, user: BOT_USER };
}

function review(body: string, submittedAt: string) {
  return { body, submitted_at: submittedAt, user: BOT_USER };
}

function actionRequired(kind: string, headSha = HEAD): string {
  return `<!-- ${botStatusMarker("action-required")} kind=${kind} head=${headSha} -->`;
}

function noActionRequired(headSha = HEAD): string {
  return `<!-- ${botStatusMarker("no-action-required")} head=${headSha} -->`;
}

test("a newer current-HEAD no-action marker resolves an older action-required signal", () => {
  const signal = latestReviewSignal(
    [
      issueComment(actionRequired("review-test"), "2026-07-14T00:00:00Z"),
      issueComment(noActionRequired(), "2026-07-14T00:01:00Z"),
    ],
    [],
    HEAD,
  );

  assert.equal(signal, null);
});

test("a newer actionable review signal remains stale-close eligible", () => {
  const signal = latestReviewSignal(
    [
      issueComment(noActionRequired(), "2026-07-14T00:00:00Z"),
      issueComment(actionRequired("review-test"), "2026-07-14T00:01:00Z"),
    ],
    [],
    HEAD,
  );

  assert.equal(signal?.actionKind, "review-test");
});

test("a no-action marker for another HEAD cannot resolve the current signal", () => {
  const signal = latestReviewSignal(
    [
      issueComment(actionRequired("review-fatal"), "2026-07-14T00:00:00Z"),
      issueComment(noActionRequired(OTHER_HEAD), "2026-07-14T00:01:00Z"),
    ],
    [],
    HEAD,
  );

  assert.equal(signal?.actionKind, "review-fatal");
});

test("legacy kind=review resolves older blockers and is not stale-close eligible", () => {
  const signal = latestReviewSignal(
    [issueComment(actionRequired("review-test"), "2026-07-14T00:00:00Z")],
    [review(actionRequired("review"), "2026-07-14T00:01:00Z")],
    HEAD,
  );

  assert.equal(signal, null);
});

test("review-test and review-fatal markers both remain actionable", () => {
  assert.equal(
    latestReviewSignal(
      [issueComment(actionRequired("review-test"), "2026-07-14T00:00:00Z")],
      [],
      HEAD,
    )?.actionKind,
    "review-test",
  );
  assert.equal(
    latestReviewSignal(
      [],
      [review(actionRequired("review-fatal"), "2026-07-14T00:00:00Z")],
      HEAD,
    )?.actionKind,
    "review-fatal",
  );
});

test("a same-second no-action marker wins the timestamp tie", () => {
  const signal = latestReviewSignal(
    [
      issueComment(actionRequired("review-test"), "2026-07-14T00:00:00Z"),
      issueComment(noActionRequired(), "2026-07-14T00:00:00Z"),
    ],
    [],
    HEAD,
  );

  assert.equal(signal, null);
});
