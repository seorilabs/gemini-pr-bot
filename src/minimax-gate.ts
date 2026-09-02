/**
 * One bounded MiniMax review-gate request: call, strict parse, and at most one
 * format-correction re-request. Shared by the bot's AI client and the local
 * gate probe so both exercise the identical retry contract.
 */
import { callMiniMaxMessages, type MiniMaxHttpOptions } from "./minimax-client.js";
import {
  MINIMAX_REVIEW_MODEL,
  type MiniMaxMessagesRequest,
  type MiniMaxReviewParseResult,
} from "./minimax-review.js";

export type MiniMaxGateResult<T> = {
  selectedProvider: "minimax";
  provider: "minimax";
  model: typeof MINIMAX_REVIEW_MODEL;
  text: string;
  value: T;
};

export type MiniMaxGateRequestUsage = {
  phase: string;
  model: typeof MINIMAX_REVIEW_MODEL;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
};

export type MiniMaxGateRequestOptions<T> = {
  http: MiniMaxHttpOptions;
  buildRequest: () => MiniMaxMessagesRequest;
  parseResponse: (response: unknown) => MiniMaxReviewParseResult<T>;
  originalUserPrompt: string;
  /** Human label for logs and errors, e.g. "후보 추출" or "후보 반증 C-1". */
  phaseLabel: string;
  /** Re-request once with the validation errors appended when the first output fails strict parsing. */
  repairInvalidOutput?: boolean;
  onRequestCompleted?: (usage: MiniMaxGateRequestUsage) => void;
};

export async function executeMiniMaxGateRequest<T>(
  options: MiniMaxGateRequestOptions<T>,
): Promise<MiniMaxGateResult<T>> {
  const repairInvalidOutput = options.repairInvalidOutput ?? true;
  const request = options.buildRequest();
  const response = await callGateMessages(request, options.phaseLabel, options);
  let parsed = options.parseResponse(response);

  if (!parsed.ok && repairInvalidOutput) {
    const repairPrompt = [
      options.originalUserPrompt,
      "",
      "이전 출력은 서버 검증을 통과하지 못했습니다.",
      `검증 오류: ${parsed.errors.slice(0, 8).join(" | ")}`,
      "정의된 submit_review 도구를 호출하는 형식의 JSON을 정확히 다시 제출하세요.",
    ].join("\n");
    const repairRequest: MiniMaxMessagesRequest = {
      ...request,
      messages: [{ role: "user", content: [{ type: "text", text: repairPrompt }] }],
    };
    const repairResponse = await callGateMessages(repairRequest, `${options.phaseLabel} 형식 보정`, options);
    parsed = options.parseResponse(repairResponse);
  }

  if (!parsed.ok) {
    throw new Error(`MiniMax ${options.phaseLabel} output failed validation: ${parsed.errors.join(" | ")}`);
  }

  return {
    selectedProvider: "minimax",
    provider: "minimax",
    model: MINIMAX_REVIEW_MODEL,
    text: JSON.stringify(parsed.value),
    value: parsed.value,
  };
}

async function callGateMessages<T>(
  request: MiniMaxMessagesRequest,
  phaseLabel: string,
  options: MiniMaxGateRequestOptions<T>,
): Promise<unknown> {
  const startedAt = Date.now();
  const response = await callMiniMaxMessages(request, options.http);
  const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  options.onRequestCompleted?.({
    phase: phaseLabel,
    model: MINIMAX_REVIEW_MODEL,
    inputTokens: usage?.input_tokens || 0,
    outputTokens: usage?.output_tokens || 0,
    elapsedMs: Date.now() - startedAt,
  });
  return response;
}
