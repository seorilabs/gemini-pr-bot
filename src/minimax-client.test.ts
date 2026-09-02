import assert from "node:assert/strict";
import test from "node:test";

import {
  MINIMAX_ANTHROPIC_VERSION,
  MINIMAX_DEFAULT_BASE_URL,
  buildMiniMaxTextRequest,
  callMiniMaxMessages,
  extractMiniMaxText,
} from "./minimax-client.js";
import { MINIMAX_ANTHROPIC_MESSAGES_PATH, buildMiniMaxCoverageRequest } from "./minimax-review.js";

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

test("성공 응답은 요청을 무가공 전송하고 body를 무가공 반환한다", async () => {
  const request = buildMiniMaxCoverageRequest({ systemPrompt: "system", userPrompt: "user" });
  const upstream = { type: "message", role: "assistant", content: [], usage: { input_tokens: 1 } };
  const seen: { url?: string; init?: RequestInit } = {};
  const fetchImpl: typeof fetch = async (url, init) => {
    seen.url = String(url);
    seen.init = init;
    return jsonResponse(upstream);
  };

  const response = await callMiniMaxMessages(request, {
    apiKey: "test-key",
    timeoutMs: 5_000,
    fetchImpl,
  });

  assert.equal(seen.url, `${MINIMAX_DEFAULT_BASE_URL}${MINIMAX_ANTHROPIC_MESSAGES_PATH}`);
  assert.equal(seen.init?.method, "POST");
  const headers = seen.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer test-key");
  assert.equal(headers["anthropic-version"], MINIMAX_ANTHROPIC_VERSION);
  assert.equal(headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(seen.init?.body)), request);
  assert.deepEqual(response, upstream);
});

test("HTTP 429는 상태 코드와 Retry-After 기반 retryDelayMs를 오류 메시지에 싣는다", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response("too many requests", { status: 429, headers: { "retry-after": "7" } });

  await assert.rejects(
    callMiniMaxMessages(buildMiniMaxTextRequest({ systemPrompt: "", userPrompt: "p", maxTokens: 128 }), {
      apiKey: "k",
      timeoutMs: 5_000,
      fetchImpl,
    }),
    (error: Error) => {
      assert.match(error.message, /MiniMax HTTP 429/u);
      assert.match(error.message, /retryDelayMs: 7000/u);
      return true;
    },
  );
});

test("base_resp 오류 봉투는 HTTP 200이어도 quota 키워드와 함께 거부된다", async () => {
  const fetchImpl: typeof fetch = async () =>
    jsonResponse({ base_resp: { status_code: 1008, status_msg: "insufficient balance" } });

  await assert.rejects(
    callMiniMaxMessages(buildMiniMaxTextRequest({ systemPrompt: "", userPrompt: "p", maxTokens: 128 }), {
      apiKey: "k",
      timeoutMs: 5_000,
      fetchImpl,
    }),
    (error: Error) => {
      assert.match(error.message, /MiniMax API error 1008/u);
      assert.match(error.message, /insufficient quota/u);
      return true;
    },
  );
});

test("base_resp status_code 0은 정상으로 통과한다", async () => {
  const upstream = { base_resp: { status_code: 0, status_msg: "success" }, content: [] };
  const fetchImpl: typeof fetch = async () => jsonResponse(upstream);

  const response = await callMiniMaxMessages(
    buildMiniMaxTextRequest({ systemPrompt: "", userPrompt: "p", maxTokens: 128 }),
    { apiKey: "k", timeoutMs: 5_000, fetchImpl },
  );
  assert.deepEqual(response, upstream);
});

test("타임아웃이 지나면 시간 초과 오류를 던진다", async () => {
  const fetchImpl: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });

  await assert.rejects(
    callMiniMaxMessages(buildMiniMaxTextRequest({ systemPrompt: "", userPrompt: "p", maxTokens: 128 }), {
      apiKey: "k",
      timeoutMs: 20,
      fetchImpl,
    }),
    /MiniMax request timed out after 20ms/u,
  );
});

test("buildMiniMaxTextRequest는 tools 없는 freeform 요청을 만든다", () => {
  const request = buildMiniMaxTextRequest({ systemPrompt: "sys", userPrompt: "user", maxTokens: 3072 });
  assert.equal(request.model, "MiniMax-M3");
  assert.equal(request.system, "sys");
  assert.equal(request.max_tokens, 3072);
  assert.equal(request.stream, false);
  assert.ok(!("tools" in request));
});

test("extractMiniMaxText는 thinking 블록을 무시하고 text 블록만 잇는다", () => {
  const text = extractMiniMaxText({
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "내부 추론" },
      { type: "text", text: "첫 문단" },
      { type: "text", text: "둘째 문단" },
    ],
  });
  assert.equal(text, "첫 문단\n둘째 문단");
  assert.equal(extractMiniMaxText({ content: [] }), "");
  assert.equal(extractMiniMaxText(null), "");
});
