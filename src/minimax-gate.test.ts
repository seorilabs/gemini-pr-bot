import assert from "node:assert/strict";
import test from "node:test";

import { executeMiniMaxGateRequest, type MiniMaxGateRequestUsage } from "./minimax-gate.js";
import { buildMiniMaxVerificationRequest, parseMiniMaxVerificationResponse } from "./minimax-review.js";

function toolResponse(verifications: unknown[]): Response {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "MiniMax-M3",
      stop_reason: "tool_use",
      usage: { input_tokens: 120, output_tokens: 40 },
      content: [{ type: "tool_use", id: "call_1", name: "submit_review", input: { verifications } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function validVerification(candidateId = "C-2") {
  return {
    candidate_id: candidateId,
    verdict: "uncertain",
    reason_ko: "현재 HEAD 발췌만으로 판정하지 못했습니다.",
    evidence: [],
  };
}

function gateOptions(fetchImpl: typeof fetch, usages: MiniMaxGateRequestUsage[]) {
  return {
    http: { apiKey: "test-key", timeoutMs: 5_000, fetchImpl },
    buildRequest: () => buildMiniMaxVerificationRequest({ systemPrompt: "system", userPrompt: "user prompt" }),
    parseResponse: (response: unknown) =>
      parseMiniMaxVerificationResponse(response, {
        expectedCandidates: [{ candidateId: "C-2", kind: "fatal_defect" as const }],
      }),
    originalUserPrompt: "user prompt",
    phaseLabel: "후보 반증 C-2",
    onRequestCompleted: (usage: MiniMaxGateRequestUsage) => {
      usages.push(usage);
    },
  };
}

test("형식이 틀린 첫 응답은 검증 오류를 덧붙여 한 번만 다시 요청한다", async () => {
  const prompts: string[] = [];
  const usages: MiniMaxGateRequestUsage[] = [];
  let calls = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body));
    prompts.push(body.messages[0].content[0].text);
    return calls === 1
      ? toolResponse([validVerification("C-1")])
      : toolResponse([validVerification("C-2")]);
  };

  const result = await executeMiniMaxGateRequest(gateOptions(fetchImpl, usages));
  assert.equal(calls, 2);
  assert.equal(result.value.verifications[0]?.candidateId, "C-2");
  assert.equal(result.provider, "minimax");
  assert.equal(prompts[0], "user prompt");
  assert.match(prompts[1] ?? "", /^user prompt\n\n이전 출력은 서버 검증을 통과하지 못했습니다\.\n검증 오류: .*expected "C-2"/u);
  assert.deepEqual(usages.map((usage) => usage.phase), ["후보 반증 C-2", "후보 반증 C-2 형식 보정"]);
  assert.equal(usages[0]?.inputTokens, 120);
  assert.equal(usages[0]?.outputTokens, 40);
  assert.ok((usages[0]?.elapsedMs ?? -1) >= 0);
});

test("보정 요청도 실패하면 phase 라벨이 담긴 오류를 던지고, 보정을 끄면 재요청하지 않는다", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return toolResponse([validVerification("C-1")]);
  };
  await assert.rejects(
    executeMiniMaxGateRequest(gateOptions(fetchImpl, [])),
    /MiniMax 후보 반증 C-2 output failed validation: .*expected "C-2"/u,
  );
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    executeMiniMaxGateRequest({ ...gateOptions(fetchImpl, []), repairInvalidOutput: false }),
    /후보 반증 C-2 output failed validation/u,
  );
  assert.equal(calls, 1);
});

test("전송 오류는 그대로 전파되고 usage 관찰자는 호출되지 않는다", async () => {
  const usages: MiniMaxGateRequestUsage[] = [];
  const fetchImpl: typeof fetch = async () => new Response("upstream busy", { status: 503 });
  await assert.rejects(executeMiniMaxGateRequest(gateOptions(fetchImpl, usages)), /MiniMax HTTP 503/u);
  assert.equal(usages.length, 0);
});
