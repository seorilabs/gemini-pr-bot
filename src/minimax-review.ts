/**
 * Pure request/response helpers for MiniMax-M3's Anthropic-compatible
 * Messages API. HTTP, authentication, retries, and timeouts intentionally live
 * in the caller.
 */

export const MINIMAX_REVIEW_MODEL = "MiniMax-M3" as const;
export const MINIMAX_ANTHROPIC_MESSAGES_PATH = "/anthropic/v1/messages" as const;
export const MINIMAX_REVIEW_TOOL_NAME = "submit_review" as const;
export const MINIMAX_REVIEW_MAX_CANDIDATES = 2 as const;
export const MINIMAX_REVIEW_MAX_ACCEPTANCE_CRITERIA = 32 as const;

export const MINIMAX_FATAL_OUTCOMES = [
  "deterministic_crash",
  "permanent_data_loss_or_corruption",
  "exploitable_security_or_privacy_exposure",
  "primary_flow_unusable",
] as const;
export type MiniMaxFatalOutcome = (typeof MINIMAX_FATAL_OUTCOMES)[number];

export const MINIMAX_REVIEW_CANDIDATE_KINDS = [
  "fatal_defect",
  "missing_acceptance_test",
] as const;
export type MiniMaxReviewCandidateKind = (typeof MINIMAX_REVIEW_CANDIDATE_KINDS)[number];

export const MINIMAX_VERIFICATION_VERDICTS = ["confirmed", "rejected", "uncertain"] as const;
export type MiniMaxVerificationVerdict = (typeof MINIMAX_VERIFICATION_VERDICTS)[number];

export const MINIMAX_ACCEPTANCE_COVERAGE_STATUSES = ["covered", "missing", "unknown"] as const;
export type MiniMaxAcceptanceCoverageStatus =
  (typeof MINIMAX_ACCEPTANCE_COVERAGE_STATUSES)[number];

export type MiniMaxCodeEvidence = {
  file: string;
  line: number;
  codeQuote: string;
  explanationKo: string;
};

export type MiniMaxAcceptanceTestEvidence = {
  file: string;
  line: number;
  testName: string;
  assertionQuote: string;
  explanationKo: string;
};

export type MiniMaxAcceptanceCoverage = {
  criterionId: string;
  acceptanceCriterion: string;
  status: MiniMaxAcceptanceCoverageStatus;
  testEvidence: MiniMaxAcceptanceTestEvidence | null;
};

export type MiniMaxReviewCandidate = {
  candidateId: string;
  kind: MiniMaxReviewCandidateKind;
  titleKo: string;
  problemKo: string;
  triggerKo: string;
  impactKo: string;
  fixKo: string;
  file: string | null;
  symbol: string | null;
  line: number | null;
  codeQuote: string | null;
  fatalOutcome: MiniMaxFatalOutcome | null;
  criterionId: string | null;
  acceptanceCriterion: string | null;
  testSearchSummaryKo: string | null;
  evidence: MiniMaxCodeEvidence[];
};

export type MiniMaxReviewResult = {
  acceptanceCoverage: MiniMaxAcceptanceCoverage[];
  candidates: MiniMaxReviewCandidate[];
};

export type MiniMaxCandidateVerification = {
  candidateId: string;
  verdict: MiniMaxVerificationVerdict;
  reasonKo: string;
  evidence: MiniMaxCodeEvidence[];
};

export type MiniMaxVerificationResult = {
  verifications: MiniMaxCandidateVerification[];
};

export type MiniMaxReviewResponseSource = "tool_use" | "text";

export type MiniMaxReviewParseResult<T> =
  | { ok: true; value: T; source: MiniMaxReviewResponseSource }
  | ParseFailure;

export type MiniMaxMessagesRequest = {
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
  tools: Array<{
    name: typeof MINIMAX_REVIEW_TOOL_NAME;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
  // MiniMax's compatibility endpoint supports only auto/none. The host still
  // rejects every response except one valid submit_review call (or strict JSON
  // text fallback).
  tool_choice: { type: "auto" };
};

export type MiniMaxReviewRequestOptions = {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
};

export type MiniMaxReviewParseOptions = {
  /**
   * Host-extracted acceptance criteria in source order. The model must return
   * exactly one AC-1..N coverage row per source string, without paraphrasing.
   */
  expectedAcceptanceCriteria?: readonly string[];
};

export type MiniMaxVerificationParseOptions = {
  /**
   * Require one verification per candidate, in the supplied order. Supplying
   * kinds lets the host allow inventory-grounded missing-test confirmation
   * without weakening fatal-defect evidence requirements.
   */
  expectedCandidates?: ReadonlyArray<
    Pick<MiniMaxReviewCandidate, "candidateId" | "kind">
  >;
  /** @deprecated Prefer expectedCandidates so kind-specific evidence is enforced. */
  expectedCandidateIds?: readonly string[];
};

type ReviewPhase = "candidate" | "verification";

const CANDIDATE_RESULT_KEYS = ["acceptance_coverage", "candidates"] as const;
const ACCEPTANCE_COVERAGE_KEYS = [
  "criterion_id",
  "acceptance_criterion",
  "status",
  "test_evidence",
] as const;
const ACCEPTANCE_TEST_EVIDENCE_KEYS = [
  "file",
  "line",
  "test_name",
  "assertion_quote",
  "explanation_ko",
] as const;
const CANDIDATE_KEYS = [
  "candidate_id",
  "kind",
  "title_ko",
  "problem_ko",
  "trigger_ko",
  "impact_ko",
  "fix_ko",
  "file",
  "symbol",
  "line",
  "code_quote",
  "fatal_outcome",
  "criterion_id",
  "acceptance_criterion",
  "test_search_summary_ko",
  "evidence",
] as const;
const VERIFICATION_RESULT_KEYS = ["verifications"] as const;
const VERIFICATION_KEYS = ["candidate_id", "verdict", "reason_ko", "evidence"] as const;
const EVIDENCE_KEYS = ["file", "line", "code_quote", "explanation_ko"] as const;

const CANDIDATE_KIND_SET = new Set<string>(MINIMAX_REVIEW_CANDIDATE_KINDS);
const FATAL_OUTCOME_SET = new Set<string>(MINIMAX_FATAL_OUTCOMES);
const VERDICT_SET = new Set<string>(MINIMAX_VERIFICATION_VERDICTS);
const COVERAGE_STATUS_SET = new Set<string>(MINIMAX_ACCEPTANCE_COVERAGE_STATUSES);
const HANGUL_PATTERN = /\p{Script=Hangul}/u;
const CANDIDATE_ID_PATTERN = /^C-[1-2]$/;
const CRITERION_ID_PATTERN = /^AC-[1-9]\d*$/;

const CODE_EVIDENCE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["file", "line", "code_quote", "explanation_ko"],
  properties: {
    file: { type: "string", minLength: 1, maxLength: 500 },
    line: { type: "integer", minimum: 1 },
    code_quote: { type: "string", minLength: 1, maxLength: 2_000 },
    explanation_ko: {
      type: "string",
      minLength: 1,
      maxLength: 600,
      description: "이 코드가 주장에 어떤 근거가 되는지 설명하는 한글 문장",
    },
  },
};

const ACCEPTANCE_TEST_EVIDENCE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [...ACCEPTANCE_TEST_EVIDENCE_KEYS],
  properties: {
    file: { type: "string", minLength: 1, maxLength: 500 },
    line: { type: "integer", minimum: 1 },
    test_name: { type: "string", minLength: 1, maxLength: 500 },
    assertion_quote: { type: "string", minLength: 1, maxLength: 2_000 },
    explanation_ko: {
      type: "string",
      minLength: 1,
      maxLength: 600,
      description: "이 테스트 단언이 인수조건을 어떻게 증명하는지 설명하는 한글 문장",
    },
  },
};

/** Build the candidate-discovery request. */
export function buildMiniMaxReviewRequest(
  options: MiniMaxReviewRequestOptions,
): MiniMaxMessagesRequest {
  return buildRequest("candidate", options);
}

/** Build the adversarial verification request for at most two candidates. */
export function buildMiniMaxVerificationRequest(
  options: MiniMaxReviewRequestOptions,
): MiniMaxMessagesRequest {
  return buildRequest("verification", options);
}

function buildRequest(
  phase: ReviewPhase,
  options: MiniMaxReviewRequestOptions,
): MiniMaxMessagesRequest {
  const systemPrompt = requirePrompt(options.systemPrompt, "systemPrompt");
  const userPrompt = requirePrompt(options.userPrompt, "userPrompt");
  const maxTokens = options.maxTokens ?? (phase === "candidate" ? 8_192 : 4_096);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 524_288) {
    throw new RangeError("maxTokens must be a safe integer between 1 and 524288");
  }

  return {
    model: MINIMAX_REVIEW_MODEL,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userPrompt }],
      },
    ],
    max_tokens: maxTokens,
    temperature: 1,
    top_p: 0.95,
    thinking: { type: "adaptive" },
    service_tier: "standard",
    stream: false,
    tools: [phase === "candidate" ? candidateTool() : verificationTool()],
    tool_choice: { type: "auto" },
  };
}

function requirePrompt(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function candidateTool(): MiniMaxMessagesRequest["tools"][number] {
  return {
    name: MINIMAX_REVIEW_TOOL_NAME,
    description:
      "모든 인수조건의 현재 HEAD 테스트 커버리지를 순서대로 제출하고, 완전히 입증된 치명 결함 또는 전체 테스트 검색으로 입증된 테스트 누락 후보를 최대 2개 제출합니다.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: [...CANDIDATE_RESULT_KEYS],
      properties: {
        acceptance_coverage: {
          type: "array",
          maxItems: MINIMAX_REVIEW_MAX_ACCEPTANCE_CRITERIA,
          description:
            "Host가 제공한 모든 인수조건을 AC-1부터 원문과 순서 그대로 한 번씩 분류합니다. 인수조건이 없으면 빈 배열입니다.",
          items: {
            type: "object",
            additionalProperties: false,
            required: [...ACCEPTANCE_COVERAGE_KEYS],
            properties: {
              criterion_id: { type: "string", pattern: "^AC-[1-9][0-9]*$" },
              acceptance_criterion: { type: "string", minLength: 1, maxLength: 2_000 },
              status: { enum: [...MINIMAX_ACCEPTANCE_COVERAGE_STATUSES] },
              test_evidence: {
                anyOf: [ACCEPTANCE_TEST_EVIDENCE_SCHEMA, { type: "null" }],
              },
            },
          },
        },
        candidates: {
          type: "array",
          maxItems: MINIMAX_REVIEW_MAX_CANDIDATES,
          items: {
            type: "object",
            additionalProperties: false,
            required: [...CANDIDATE_KEYS],
            properties: {
              candidate_id: { type: "string", pattern: "^C-[1-2]$" },
              kind: { enum: [...MINIMAX_REVIEW_CANDIDATE_KINDS] },
              title_ko: { type: "string", minLength: 1, maxLength: 120 },
              problem_ko: { type: "string", minLength: 1, maxLength: 800 },
              trigger_ko: { type: "string", minLength: 1, maxLength: 800 },
              impact_ko: { type: "string", minLength: 1, maxLength: 800 },
              fix_ko: { type: "string", minLength: 1, maxLength: 800 },
              file: { type: ["string", "null"], minLength: 1, maxLength: 500 },
              symbol: { type: ["string", "null"], minLength: 1, maxLength: 300 },
              line: { type: ["integer", "null"], minimum: 1 },
              code_quote: { type: ["string", "null"], minLength: 1, maxLength: 2_000 },
              fatal_outcome: { anyOf: [{ enum: [...MINIMAX_FATAL_OUTCOMES] }, { type: "null" }] },
              criterion_id: {
                anyOf: [{ type: "string", pattern: "^AC-[1-9][0-9]*$" }, { type: "null" }],
              },
              acceptance_criterion: { type: ["string", "null"], minLength: 1, maxLength: 2_000 },
              test_search_summary_ko: { type: ["string", "null"], minLength: 1, maxLength: 1_000 },
              evidence: {
                type: "array",
                maxItems: 6,
                items: CODE_EVIDENCE_SCHEMA,
              },
            },
          },
        },
      },
    },
  };
}

function verificationTool(): MiniMaxMessagesRequest["tools"][number] {
  return {
    name: MINIMAX_REVIEW_TOOL_NAME,
    description:
      "각 후보가 틀렸거나 이미 수정되었다는 반증을 우선 탐색한 뒤 확인, 기각 또는 불확실 판정을 한글 근거와 함께 제출합니다.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["verifications"],
      properties: {
        verifications: {
          type: "array",
          maxItems: MINIMAX_REVIEW_MAX_CANDIDATES,
          items: {
            type: "object",
            additionalProperties: false,
            required: [...VERIFICATION_KEYS],
            properties: {
              candidate_id: { type: "string", pattern: "^C-[1-2]$" },
              verdict: { enum: [...MINIMAX_VERIFICATION_VERDICTS] },
              reason_ko: { type: "string", minLength: 1, maxLength: 1_000 },
              evidence: {
                type: "array",
                maxItems: 6,
                items: CODE_EVIDENCE_SCHEMA,
              },
            },
          },
        },
      },
    },
  };
}

/** Parse and strictly validate a candidate-discovery Messages API response. */
export function parseMiniMaxReviewResponse(
  response: unknown,
  options: MiniMaxReviewParseOptions = {},
): MiniMaxReviewParseResult<MiniMaxReviewResult> {
  const payload = extractSubmitReviewPayload(response);
  if (!payload.ok) {
    return payload;
  }
  const parsed = validateCandidateResult(payload.value, options);
  return parsed.ok ? { ok: true, value: parsed.value, source: payload.source } : parsed;
}

/** Parse and strictly validate an adversarial-verifier Messages API response. */
export function parseMiniMaxVerificationResponse(
  response: unknown,
  options: MiniMaxVerificationParseOptions = {},
): MiniMaxReviewParseResult<MiniMaxVerificationResult> {
  const payload = extractSubmitReviewPayload(response);
  if (!payload.ok) {
    return payload;
  }
  const parsed = validateVerificationResult(payload.value, options);
  return parsed.ok ? { ok: true, value: parsed.value, source: payload.source } : parsed;
}

/** Strictly validate an already extracted candidate payload. */
export function parseMiniMaxReviewPayload(
  payload: unknown,
  options: MiniMaxReviewParseOptions = {},
): MiniMaxReviewParseResult<MiniMaxReviewResult> {
  const parsed = validateCandidateResult(payload, options);
  return parsed.ok ? { ok: true, value: parsed.value, source: "text" } : parsed;
}

/** Strictly validate an already extracted verifier payload. */
export function parseMiniMaxVerificationPayload(
  payload: unknown,
  options: MiniMaxVerificationParseOptions = {},
): MiniMaxReviewParseResult<MiniMaxVerificationResult> {
  const parsed = validateVerificationResult(payload, options);
  return parsed.ok ? { ok: true, value: parsed.value, source: "text" } : parsed;
}

type ExtractedPayload =
  | { ok: true; value: unknown; source: MiniMaxReviewResponseSource }
  | ParseFailure;

function extractSubmitReviewPayload(responseInput: unknown): ExtractedPayload {
  const response = decodeJsonDocument(responseInput, "$response");
  if (!response.ok) {
    return response;
  }
  if (!isRecord(response.value)) {
    return fail("$response: expected an object");
  }

  const baseResponse = response.value.base_resp;
  if (baseResponse !== undefined) {
    if (!isRecord(baseResponse)) {
      return fail("$response.base_resp: expected an object");
    }
    if (baseResponse.status_code !== 0 && baseResponse.status_code !== "0") {
      return fail(
        `$response.base_resp: MiniMax API error ${String(baseResponse.status_code)} (${String(baseResponse.status_msg || "unknown")})`,
      );
    }
  }

  if (response.value.type !== "message") {
    return fail('$response.type: expected "message"');
  }
  if (response.value.role !== "assistant") {
    return fail('$response.role: expected "assistant"');
  }
  if (response.value.stop_reason === "max_tokens") {
    return fail("$response.stop_reason: truncated response is not valid review evidence");
  }
  if (!Array.isArray(response.value.content)) {
    return fail("$response.content: expected an array");
  }

  const toolPayloads: unknown[] = [];
  const textBlocks: string[] = [];
  const errors: string[] = [];
  for (const [index, block] of response.value.content.entries()) {
    const path = `$response.content[${index}]`;
    if (!isRecord(block) || typeof block.type !== "string") {
      errors.push(`${path}: expected a typed content block`);
      continue;
    }
    if (block.type === "thinking") {
      if (typeof block.thinking !== "string") {
        errors.push(`${path}.thinking: expected a string`);
      }
      continue;
    }
    if (block.type === "text") {
      if (typeof block.text !== "string") {
        errors.push(`${path}.text: expected a string`);
      } else if (block.text.trim()) {
        textBlocks.push(block.text);
      }
      continue;
    }
    if (block.type === "tool_use") {
      if (block.name !== MINIMAX_REVIEW_TOOL_NAME) {
        errors.push(`${path}.name: unexpected tool ${JSON.stringify(block.name)}`);
      } else if (!("input" in block)) {
        errors.push(`${path}.input: missing tool input`);
      } else {
        toolPayloads.push(block.input);
      }
      continue;
    }
    errors.push(`${path}.type: unsupported content block ${JSON.stringify(block.type)}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  if (toolPayloads.length > 1) {
    return fail(`$response.content: expected exactly one ${MINIMAX_REVIEW_TOOL_NAME} call`);
  }
  if (toolPayloads.length === 1) {
    if (response.value.stop_reason !== "tool_use") {
      return fail('$response.stop_reason: expected "tool_use" for submit_review');
    }
    return { ok: true, value: toolPayloads[0], source: "tool_use" };
  }

  if (textBlocks.length === 0) {
    return fail(`$response.content: missing ${MINIMAX_REVIEW_TOOL_NAME} call or JSON text fallback`);
  }
  const textPayload = decodeJsonDocument(textBlocks.join("\n"), "$response.content.text");
  return textPayload.ok
    ? { ok: true, value: textPayload.value, source: "text" }
    : textPayload;
}

type ParseFailure = { ok: false; errors: string[] };
type ValidationResult<T> = { ok: true; value: T } | ParseFailure;

function validateCandidateResult(
  raw: unknown,
  options: MiniMaxReviewParseOptions,
): ValidationResult<MiniMaxReviewResult> {
  if (!isRecord(raw)) {
    return fail("$: expected an object");
  }
  const errors: string[] = [];
  validateExactKeys(raw, CANDIDATE_RESULT_KEYS, "$", errors);
  const acceptanceCoverage = validateAcceptanceCoverage(
    raw.acceptance_coverage,
    options.expectedAcceptanceCriteria,
    errors,
  );
  if (!Array.isArray(raw.candidates)) {
    errors.push("$.candidates: expected an array");
    return { ok: false, errors };
  }
  if (raw.candidates.length > MINIMAX_REVIEW_MAX_CANDIDATES) {
    errors.push(`$.candidates: expected at most ${MINIMAX_REVIEW_MAX_CANDIDATES} items`);
  }

  const candidates: MiniMaxReviewCandidate[] = [];
  for (const [index, candidate] of raw.candidates.entries()) {
    const parsed = validateCandidate(candidate, index);
    if (parsed.ok) {
      candidates.push(parsed.value);
    } else {
      errors.push(...parsed.errors);
    }
  }
  if (acceptanceCoverage) {
    for (const [index, candidate] of candidates.entries()) {
      if (candidate.kind !== "missing_acceptance_test") {
        continue;
      }
      const coverage = acceptanceCoverage.find(
        (entry) => entry.criterionId === candidate.criterionId,
      );
      if (!coverage) {
        errors.push(
          `$.candidates[${index}].criterion_id: missing from acceptance_coverage`,
        );
        continue;
      }
      if (coverage.acceptanceCriterion !== candidate.acceptanceCriterion) {
        errors.push(
          `$.candidates[${index}].acceptance_criterion: must match acceptance_coverage`,
        );
      }
      if (coverage.status !== "missing") {
        errors.push(
          `$.candidates[${index}].criterion_id: acceptance_coverage status must be "missing"`,
        );
      }
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: { acceptanceCoverage: acceptanceCoverage!, candidates } };
}

function validateAcceptanceCoverage(
  raw: unknown,
  expectedAcceptanceCriteria: readonly string[] | undefined,
  errors: string[],
): MiniMaxAcceptanceCoverage[] | null {
  const path = "$.acceptance_coverage";
  if (!Array.isArray(raw)) {
    errors.push(`${path}: expected an array`);
    return null;
  }
  if (raw.length > MINIMAX_REVIEW_MAX_ACCEPTANCE_CRITERIA) {
    errors.push(
      `${path}: expected at most ${MINIMAX_REVIEW_MAX_ACCEPTANCE_CRITERIA} items`,
    );
  }
  if (
    expectedAcceptanceCriteria &&
    expectedAcceptanceCriteria.length > MINIMAX_REVIEW_MAX_ACCEPTANCE_CRITERIA
  ) {
    errors.push(
      `$options.expectedAcceptanceCriteria: expected at most ${MINIMAX_REVIEW_MAX_ACCEPTANCE_CRITERIA} items`,
    );
  }
  expectedAcceptanceCriteria?.forEach((criterion, index) => {
    readString(
      criterion,
      `$options.expectedAcceptanceCriteria[${index}]`,
      errors,
      2_000,
    );
  });
  if (expectedAcceptanceCriteria && raw.length !== expectedAcceptanceCriteria.length) {
    errors.push(`${path}: expected exactly one result per host acceptance criterion`);
  }

  const coverage: MiniMaxAcceptanceCoverage[] = [];
  for (const [index, entry] of raw.entries()) {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${entryPath}: expected an object`);
      continue;
    }
    validateExactKeys(entry, ACCEPTANCE_COVERAGE_KEYS, entryPath, errors);

    const criterionId = readString(entry.criterion_id, `${entryPath}.criterion_id`, errors, 80);
    const expectedId = `AC-${index + 1}`;
    if (criterionId && (!CRITERION_ID_PATTERN.test(criterionId) || criterionId !== expectedId)) {
      errors.push(`${entryPath}.criterion_id: expected ${JSON.stringify(expectedId)}`);
    }
    const acceptanceCriterion = readString(
      entry.acceptance_criterion,
      `${entryPath}.acceptance_criterion`,
      errors,
      2_000,
    );
    const expectedSource = expectedAcceptanceCriteria?.[index];
    if (acceptanceCriterion && expectedSource !== undefined && acceptanceCriterion !== expectedSource) {
      errors.push(`${entryPath}.acceptance_criterion: must exactly match the host source`);
    }
    const status = readEnum(entry.status, COVERAGE_STATUS_SET, `${entryPath}.status`, errors);
    const testEvidence = readAcceptanceTestEvidence(
      entry.test_evidence,
      `${entryPath}.test_evidence`,
      errors,
    );

    if (status === "covered" && testEvidence === null) {
      errors.push(`${entryPath}.test_evidence: covered status requires test evidence`);
    }
    if ((status === "missing" || status === "unknown") && entry.test_evidence !== null) {
      errors.push(`${entryPath}.test_evidence: ${status} status requires null`);
    }

    if (criterionId && acceptanceCriterion && status && testEvidence !== undefined) {
      coverage.push({
        criterionId,
        acceptanceCriterion,
        status: status as MiniMaxAcceptanceCoverageStatus,
        testEvidence,
      });
    }
  }
  return coverage;
}

function readAcceptanceTestEvidence(
  raw: unknown,
  path: string,
  errors: string[],
): MiniMaxAcceptanceTestEvidence | null | undefined {
  if (raw === null) {
    return null;
  }
  if (!isRecord(raw)) {
    errors.push(`${path}: expected an object or null`);
    return undefined;
  }
  validateExactKeys(raw, ACCEPTANCE_TEST_EVIDENCE_KEYS, path, errors);
  const file = readString(raw.file, `${path}.file`, errors, 500);
  const line = readPositiveInteger(raw.line, `${path}.line`, errors);
  const testName = readString(raw.test_name, `${path}.test_name`, errors, 500);
  const assertionQuote = readString(
    raw.assertion_quote,
    `${path}.assertion_quote`,
    errors,
    2_000,
  );
  const explanationKo = readKoreanString(
    raw.explanation_ko,
    `${path}.explanation_ko`,
    errors,
    600,
  );
  if (!file || !line || !testName || !assertionQuote || !explanationKo) {
    return undefined;
  }
  return { file, line, testName, assertionQuote, explanationKo };
}

function validateCandidate(raw: unknown, index: number): ValidationResult<MiniMaxReviewCandidate> {
  const path = `$.candidates[${index}]`;
  if (!isRecord(raw)) {
    return fail(`${path}: expected an object`);
  }
  const errors: string[] = [];
  validateExactKeys(raw, CANDIDATE_KEYS, path, errors);

  const expectedId = `C-${index + 1}`;
  const candidateId = readString(raw.candidate_id, `${path}.candidate_id`, errors, 8);
  if (candidateId && (!CANDIDATE_ID_PATTERN.test(candidateId) || candidateId !== expectedId)) {
    errors.push(`${path}.candidate_id: expected ${JSON.stringify(expectedId)}`);
  }
  const kind = readEnum(raw.kind, CANDIDATE_KIND_SET, `${path}.kind`, errors);
  const titleKo = readKoreanString(raw.title_ko, `${path}.title_ko`, errors, 120);
  const problemKo = readKoreanString(raw.problem_ko, `${path}.problem_ko`, errors, 800);
  const triggerKo = readKoreanString(raw.trigger_ko, `${path}.trigger_ko`, errors, 800);
  const impactKo = readKoreanString(raw.impact_ko, `${path}.impact_ko`, errors, 800);
  const fixKo = readKoreanString(raw.fix_ko, `${path}.fix_ko`, errors, 800);
  const file = readNullableString(raw.file, `${path}.file`, errors, 500);
  const symbol = readNullableString(raw.symbol, `${path}.symbol`, errors, 300);
  const line = readNullablePositiveInteger(raw.line, `${path}.line`, errors);
  const codeQuote = readNullableString(raw.code_quote, `${path}.code_quote`, errors, 2_000);
  const fatalOutcome = readNullableEnum(
    raw.fatal_outcome,
    FATAL_OUTCOME_SET,
    `${path}.fatal_outcome`,
    errors,
  );
  const criterionId = readNullableString(raw.criterion_id, `${path}.criterion_id`, errors, 80);
  const acceptanceCriterion = readNullableString(
    raw.acceptance_criterion,
    `${path}.acceptance_criterion`,
    errors,
    2_000,
  );
  const testSearchSummaryKo = readNullableKoreanString(
    raw.test_search_summary_ko,
    `${path}.test_search_summary_ko`,
    errors,
    1_000,
  );
  const evidence = readEvidenceArray(raw.evidence, `${path}.evidence`, errors);

  if (kind === "fatal_defect") {
    requirePresent(file, `${path}.file`, errors);
    requirePresent(symbol, `${path}.symbol`, errors);
    requirePresent(line, `${path}.line`, errors);
    requirePresent(codeQuote, `${path}.code_quote`, errors);
    requirePresent(fatalOutcome, `${path}.fatal_outcome`, errors);
    requireNull(criterionId, `${path}.criterion_id`, errors);
    requireNull(acceptanceCriterion, `${path}.acceptance_criterion`, errors);
    requireNull(testSearchSummaryKo, `${path}.test_search_summary_ko`, errors);
    if (evidence && evidence.length === 0) {
      errors.push(`${path}.evidence: fatal defect requires at least one code record`);
    }
    if (
      evidence &&
      file &&
      line &&
      codeQuote &&
      !evidence.some(
        (entry) => entry.file === file && entry.line === line && entry.codeQuote === codeQuote,
      )
    ) {
      errors.push(`${path}.evidence: must include the exact root file, line, and code_quote`);
    }
  }
  if (kind === "missing_acceptance_test") {
    requireNull(file, `${path}.file`, errors);
    requireNull(line, `${path}.line`, errors);
    requireNull(codeQuote, `${path}.code_quote`, errors);
    requireNull(fatalOutcome, `${path}.fatal_outcome`, errors);
    requirePresent(criterionId, `${path}.criterion_id`, errors);
    if (criterionId && !CRITERION_ID_PATTERN.test(criterionId)) {
      errors.push(`${path}.criterion_id: expected an AC-N identifier`);
    }
    requirePresent(acceptanceCriterion, `${path}.acceptance_criterion`, errors);
    requirePresent(testSearchSummaryKo, `${path}.test_search_summary_ko`, errors);
    if (evidence && evidence.length !== 0) {
      errors.push(`${path}.evidence: missing-test candidate must use an empty code evidence array`);
    }
  }

  if (
    errors.length > 0 ||
    !candidateId ||
    !kind ||
    !titleKo ||
    !problemKo ||
    !triggerKo ||
    !impactKo ||
    !fixKo ||
    file === undefined ||
    symbol === undefined ||
    line === undefined ||
    codeQuote === undefined ||
    fatalOutcome === undefined ||
    criterionId === undefined ||
    acceptanceCriterion === undefined ||
    testSearchSummaryKo === undefined ||
    !evidence
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      candidateId,
      kind: kind as MiniMaxReviewCandidateKind,
      titleKo,
      problemKo,
      triggerKo,
      impactKo,
      fixKo,
      file,
      symbol,
      line,
      codeQuote,
      fatalOutcome: fatalOutcome as MiniMaxFatalOutcome | null,
      criterionId,
      acceptanceCriterion,
      testSearchSummaryKo,
      evidence,
    },
  };
}

function validateVerificationResult(
  raw: unknown,
  options: MiniMaxVerificationParseOptions,
): ValidationResult<MiniMaxVerificationResult> {
  if (!isRecord(raw)) {
    return fail("$: expected an object");
  }
  const errors: string[] = [];
  validateExactKeys(raw, VERIFICATION_RESULT_KEYS, "$", errors);
  if (!Array.isArray(raw.verifications)) {
    errors.push("$.verifications: expected an array");
    return { ok: false, errors };
  }
  if (raw.verifications.length > MINIMAX_REVIEW_MAX_CANDIDATES) {
    errors.push(`$.verifications: expected at most ${MINIMAX_REVIEW_MAX_CANDIDATES} items`);
  }

  if (options.expectedCandidates && options.expectedCandidateIds) {
    errors.push("$options: expectedCandidates and expectedCandidateIds are mutually exclusive");
  }
  const expectedCandidates = options.expectedCandidates;
  const expectedIds = expectedCandidates?.map((candidate) => candidate.candidateId) ?? options.expectedCandidateIds;
  if (expectedIds && expectedIds.length > MINIMAX_REVIEW_MAX_CANDIDATES) {
    errors.push(`$options.expectedCandidates: expected at most ${MINIMAX_REVIEW_MAX_CANDIDATES} items`);
  }
  if (expectedIds && new Set(expectedIds).size !== expectedIds.length) {
    errors.push("$options.expectedCandidates: duplicate candidate ID");
  }
  expectedCandidates?.forEach((candidate, index) => {
    if (!CANDIDATE_ID_PATTERN.test(candidate.candidateId)) {
      errors.push(`$options.expectedCandidates[${index}].candidateId: expected C-1 or C-2`);
    }
    if (!CANDIDATE_KIND_SET.has(candidate.kind)) {
      errors.push(`$options.expectedCandidates[${index}].kind: unexpected candidate kind`);
    }
  });
  if (expectedCandidates && expectedCandidates.some((candidate, index) => candidate.candidateId !== `C-${index + 1}`)) {
    errors.push("$options.expectedCandidates: candidate IDs must be sequential");
  }
  if (expectedIds && raw.verifications.length !== expectedIds.length) {
    errors.push("$.verifications: expected exactly one result per supplied candidate");
  }

  const verifications: MiniMaxCandidateVerification[] = [];
  for (const [index, verification] of raw.verifications.entries()) {
    const parsed = validateVerification(verification, index);
    if (parsed.ok) {
      verifications.push(parsed.value);
      const expectedId = expectedIds?.[index] ?? `C-${index + 1}`;
      if (parsed.value.candidateId !== expectedId) {
        errors.push(
          `$.verifications[${index}].candidate_id: expected ${JSON.stringify(expectedId)}`,
        );
      }
      if (
        parsed.value.verdict === "confirmed" &&
        parsed.value.evidence.length === 0 &&
        expectedCandidates?.[index]?.kind !== "missing_acceptance_test"
      ) {
        errors.push(
          `$.verifications[${index}].evidence: confirmed fatal defect requires current-HEAD code evidence`,
        );
      }
    } else {
      errors.push(...parsed.errors);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: { verifications } };
}

function validateVerification(
  raw: unknown,
  index: number,
): ValidationResult<MiniMaxCandidateVerification> {
  const path = `$.verifications[${index}]`;
  if (!isRecord(raw)) {
    return fail(`${path}: expected an object`);
  }
  const errors: string[] = [];
  validateExactKeys(raw, VERIFICATION_KEYS, path, errors);
  const candidateId = readString(raw.candidate_id, `${path}.candidate_id`, errors, 8);
  if (candidateId && !CANDIDATE_ID_PATTERN.test(candidateId)) {
    errors.push(`${path}.candidate_id: expected C-1 or C-2`);
  }
  const verdict = readEnum(raw.verdict, VERDICT_SET, `${path}.verdict`, errors);
  const reasonKo = readKoreanString(raw.reason_ko, `${path}.reason_ko`, errors, 1_000);
  const evidence = readEvidenceArray(raw.evidence, `${path}.evidence`, errors);
  if (verdict === "rejected" && evidence?.length === 0) {
    errors.push(`${path}.evidence: ${verdict} verdict requires current-HEAD evidence`);
  }

  if (errors.length > 0 || !candidateId || !verdict || !reasonKo || !evidence) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      candidateId,
      verdict: verdict as MiniMaxVerificationVerdict,
      reasonKo,
      evidence,
    },
  };
}

function readEvidenceArray(
  raw: unknown,
  path: string,
  errors: string[],
): MiniMaxCodeEvidence[] | null {
  if (!Array.isArray(raw)) {
    errors.push(`${path}: expected an array`);
    return null;
  }
  if (raw.length > 6) {
    errors.push(`${path}: expected at most 6 items`);
  }
  const evidence: MiniMaxCodeEvidence[] = [];
  for (const [index, entry] of raw.entries()) {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${entryPath}: expected an object`);
      continue;
    }
    validateExactKeys(entry, EVIDENCE_KEYS, entryPath, errors);
    const file = readString(entry.file, `${entryPath}.file`, errors, 500);
    const line = readPositiveInteger(entry.line, `${entryPath}.line`, errors);
    const codeQuote = readString(entry.code_quote, `${entryPath}.code_quote`, errors, 2_000);
    const explanationKo = readKoreanString(
      entry.explanation_ko,
      `${entryPath}.explanation_ko`,
      errors,
      600,
    );
    if (file && line && codeQuote && explanationKo) {
      evidence.push({ file, line, codeQuote, explanationKo });
    }
  }
  return evidence;
}

function decodeJsonDocument(
  input: unknown,
  path: string,
): ValidationResult<unknown> {
  if (typeof input !== "string") {
    return { ok: true, value: input };
  }
  let document = input.trim();
  const fence = document.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/iu);
  if (fence) {
    document = fence[1]!.trim();
  }
  try {
    return { ok: true, value: JSON.parse(document) };
  } catch (error) {
    return fail(
      `${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function validateExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  errors: string[],
): void {
  const expectedSet = new Set(expected);
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push(`${path}.${key}: missing required field`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) {
      errors.push(`${path}.${key}: unexpected field`);
    }
  }
}

function readString(
  raw: unknown,
  path: string,
  errors: string[],
  maxLength: number,
): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    errors.push(`${path}: expected a non-empty string`);
    return null;
  }
  if (raw.length > maxLength) {
    errors.push(`${path}: expected at most ${maxLength} characters`);
    return null;
  }
  return raw;
}

function readKoreanString(
  raw: unknown,
  path: string,
  errors: string[],
  maxLength: number,
): string | null {
  const value = readString(raw, path, errors, maxLength);
  if (value && !HANGUL_PATTERN.test(value)) {
    errors.push(`${path}: expected a Korean human-readable field`);
    return null;
  }
  return value;
}

function readNullableString(
  raw: unknown,
  path: string,
  errors: string[],
  maxLength: number,
): string | null | undefined {
  if (raw === null) {
    return null;
  }
  return readString(raw, path, errors, maxLength) ?? undefined;
}

function readNullableKoreanString(
  raw: unknown,
  path: string,
  errors: string[],
  maxLength: number,
): string | null | undefined {
  if (raw === null) {
    return null;
  }
  return readKoreanString(raw, path, errors, maxLength) ?? undefined;
}

function readPositiveInteger(raw: unknown, path: string, errors: string[]): number | null {
  if (!Number.isSafeInteger(raw) || (raw as number) < 1) {
    errors.push(`${path}: expected a positive safe integer`);
    return null;
  }
  return raw as number;
}

function readNullablePositiveInteger(
  raw: unknown,
  path: string,
  errors: string[],
): number | null | undefined {
  if (raw === null) {
    return null;
  }
  return readPositiveInteger(raw, path, errors) ?? undefined;
}

function readEnum(
  raw: unknown,
  values: Set<string>,
  path: string,
  errors: string[],
): string | null {
  if (typeof raw !== "string" || !values.has(raw)) {
    errors.push(`${path}: unexpected enum value ${JSON.stringify(raw)}`);
    return null;
  }
  return raw;
}

function readNullableEnum(
  raw: unknown,
  values: Set<string>,
  path: string,
  errors: string[],
): string | null | undefined {
  if (raw === null) {
    return null;
  }
  return readEnum(raw, values, path, errors) ?? undefined;
}

function requirePresent(
  value: string | number | null | undefined,
  path: string,
  errors: string[],
): void {
  if (value === null || value === undefined) {
    errors.push(`${path}: required for this candidate kind`);
  }
}

function requireNull(value: unknown, path: string, errors: string[]): void {
  if (value !== null) {
    errors.push(`${path}: must be null for this candidate kind`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(...errors: string[]): ParseFailure {
  return { ok: false, errors };
}
