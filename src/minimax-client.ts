/**
 * HTTP executor for MiniMax-M3's Anthropic-compatible Messages API.
 * Request/response schemas live in minimax-review.ts; this module owns only
 * transport, authentication, timeouts, and error-envelope translation.
 *
 * Error messages intentionally embed the numeric HTTP status, a body snippet,
 * and quota keywords ("rate limit", "insufficient quota", `retryDelayMs: <ms>`)
 * so the existing provider cooldown/quota string contract in ai-client keeps
 * working without a separate error-mapping layer.
 */
import {
  MINIMAX_ANTHROPIC_MESSAGES_PATH,
  MINIMAX_REVIEW_MODEL,
  type MiniMaxMessagesRequest,
} from "./minimax-review.js";
import { truncate } from "./text.js";

export const MINIMAX_DEFAULT_BASE_URL = "https://api.minimax.io" as const;
export const MINIMAX_ANTHROPIC_VERSION = "2023-06-01" as const;

export type MiniMaxHttpOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

/** Freeform request without tools; the response is read as plain text blocks. */
export type MiniMaxTextMessagesRequest = {
  model: typeof MINIMAX_REVIEW_MODEL;
  system: string;
  messages: Array<{
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  }>;
  max_tokens: number;
  temperature: 1;
  top_p: 0.95;
  thinking: { type: "adaptive" };
  service_tier: "standard";
  stream: false;
};

export function buildMiniMaxTextRequest(options: {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
}): MiniMaxTextMessagesRequest {
  return {
    model: MINIMAX_REVIEW_MODEL,
    system: options.systemPrompt,
    messages: [{ role: "user", content: [{ type: "text", text: options.userPrompt }] }],
    max_tokens: options.maxTokens,
    temperature: 1,
    top_p: 0.95,
    thinking: { type: "adaptive" },
    service_tier: "standard",
    stream: false,
  };
}

export async function callMiniMaxMessages(
  body: MiniMaxMessagesRequest | MiniMaxTextMessagesRequest,
  options: MiniMaxHttpOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl || MINIMAX_DEFAULT_BASE_URL}${MINIMAX_ANTHROPIC_MESSAGES_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "anthropic-version": MINIMAX_ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`MiniMax request timed out after ${options.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const bodySnippet = truncate(await response.text().catch(() => ""), 600);
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const retryHint =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? ` retryDelayMs: ${Math.ceil(retryAfterSeconds * 1000)}`
        : "";
    throw new Error(`MiniMax HTTP ${response.status}: ${bodySnippet}${retryHint}`);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error("MiniMax returned invalid JSON");
  }

  assertMiniMaxEnvelopeOk(parsed);
  return parsed;
}

/**
 * MiniMax wraps API-level failures in a `base_resp` envelope even on HTTP 200.
 * Reject them here so the strict submit_review parser never sees them; attach
 * quota keywords for known quota codes so cooldown handling engages.
 */
function assertMiniMaxEnvelopeOk(response: unknown): void {
  if (!response || typeof response !== "object") {
    return;
  }
  const baseResp = (response as { base_resp?: unknown }).base_resp;
  if (!baseResp || typeof baseResp !== "object") {
    return;
  }
  const statusCode = (baseResp as { status_code?: unknown }).status_code;
  if (statusCode === undefined || statusCode === 0 || statusCode === "0") {
    return;
  }
  const statusMsg = (baseResp as { status_msg?: unknown }).status_msg;
  const quotaHint = statusCode === 1002 ? " (rate limit)" : statusCode === 1008 ? " (insufficient quota)" : "";
  throw new Error(`MiniMax API error ${String(statusCode)}: ${String(statusMsg ?? "unknown")}${quotaHint}`);
}

/** Joins assistant text blocks; thinking blocks are internal and ignored. */
export function extractMiniMaxText(response: unknown): string {
  if (!response || typeof response !== "object") {
    return "";
  }
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}
