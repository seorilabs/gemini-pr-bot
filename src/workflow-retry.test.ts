import assert from "node:assert/strict";
import test from "node:test";
import {
  isGitHubServerError,
  transientGitHubRetryDelayMs,
} from "./workflow-retry.js";

const CREATED_AT = "2026-07-20T00:00:00.000Z";
const RETRY_WINDOW_MS = 30 * 60 * 1000;
const MAX_DELAY_MS = 5 * 60 * 1000;

test("GitHub API 5xx만 장기 transient retry 대상으로 분류한다", () => {
  assert.equal(
    isGitHubServerError({
      status: 503,
      request: { url: "https://api.github.com/repos/seorilabs/app/pulls/42/commits" },
    }),
    true,
  );
  assert.equal(
    isGitHubServerError({
      response: {
        status: 502,
        url: "https://api.github.com/repos/seorilabs/app/pulls/42",
      },
    }),
    true,
  );
  assert.equal(
    isGitHubServerError({
      status: 422,
      request: { url: "https://api.github.com/repos/seorilabs/app/pulls/42" },
    }),
    false,
  );
  assert.equal(
    isGitHubServerError({
      status: 503,
      request: { url: "https://example.com/api" },
    }),
    false,
  );
});

test("GitHub 5xx는 30분 창 안에서 30초부터 최대 5분까지 지수 backoff한다", () => {
  const error = {
    status: 503,
    request: { url: "https://api.github.com/repos/seorilabs/app/pulls/42/commits" },
  };
  const createdAtMs = Date.parse(CREATED_AT);

  assert.equal(
    transientGitHubRetryDelayMs(
      error,
      CREATED_AT,
      RETRY_WINDOW_MS,
      MAX_DELAY_MS,
      createdAtMs + 60_000,
    ),
    30_000,
  );
  assert.equal(
    transientGitHubRetryDelayMs(
      error,
      CREATED_AT,
      RETRY_WINDOW_MS,
      MAX_DELAY_MS,
      createdAtMs + 11 * 60_000,
    ),
    120_000,
  );
  assert.equal(
    transientGitHubRetryDelayMs(
      error,
      CREATED_AT,
      RETRY_WINDOW_MS,
      MAX_DELAY_MS,
      createdAtMs + 26 * 60_000,
    ),
    240_000,
  );
  assert.equal(
    transientGitHubRetryDelayMs(
      error,
      CREATED_AT,
      RETRY_WINDOW_MS,
      MAX_DELAY_MS,
      createdAtMs + RETRY_WINDOW_MS,
    ),
    null,
  );
});

test("비 GitHub 오류와 잘못된 생성 시각은 transient retry하지 않는다", () => {
  assert.equal(
    transientGitHubRetryDelayMs(
      new Error("socket failed"),
      CREATED_AT,
      RETRY_WINDOW_MS,
      MAX_DELAY_MS,
    ),
    null,
  );
  assert.equal(
    transientGitHubRetryDelayMs(
      {
        status: 503,
        request: { url: "https://api.github.com/repos/seorilabs/app/pulls/42" },
      },
      "invalid-date",
      RETRY_WINDOW_MS,
      MAX_DELAY_MS,
    ),
    null,
  );
});
