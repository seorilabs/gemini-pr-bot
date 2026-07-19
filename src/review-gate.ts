export const REVIEW_GATE_CONTEXT_STATUSES = ["sufficient", "insufficient"] as const;
export type ReviewGateContextStatus = (typeof REVIEW_GATE_CONTEXT_STATUSES)[number];

export const REVIEW_GATE_TESTABILITIES = ["automated", "manual", "not_applicable"] as const;
export type ReviewGateTestability = (typeof REVIEW_GATE_TESTABILITIES)[number];

export const REVIEW_GATE_COVERAGES = ["covered", "missing", "unknown"] as const;
export type ReviewGateCoverage = (typeof REVIEW_GATE_COVERAGES)[number];

export const REVIEW_GATE_FATAL_OUTCOMES = [
  "deterministic_crash",
  "permanent_data_loss_or_corruption",
  "exploitable_security_or_privacy_exposure",
  "primary_flow_unusable",
] as const;
export type ReviewGateFatalOutcome = (typeof REVIEW_GATE_FATAL_OUTCOMES)[number];

export type ReviewGateTestEvidence = {
  file: string;
  testName: string;
  assertionQuote: string;
  /** Provider explanation is used only to bind natural-language ACs to grounded code. */
  explanationKo?: string;
};

export type ReviewGateCodeEvidence = {
  file: string;
  line: number;
  codeQuote: string;
};

export type ReviewGateCriterion = {
  id: string;
  sourceQuote: string;
  testability: ReviewGateTestability;
  coverage: ReviewGateCoverage;
  testEvidence: ReviewGateTestEvidence | null;
};

export type ReviewGateFatalBlocker = {
  file: string;
  line: number;
  codeQuote: string;
  outcome: ReviewGateFatalOutcome;
  trigger: string;
  causalChain: string;
  causalEvidence: ReviewGateCodeEvidence[];
};

export type ReviewGateResponse = {
  contextStatus: ReviewGateContextStatus;
  testInventoryComplete: boolean;
  criteria: ReviewGateCriterion[];
  fatalBlockers: ReviewGateFatalBlocker[];
  abstainReasons: string[];
};

export type ReviewGateParseResult =
  | { ok: true; value: ReviewGateResponse }
  | { ok: false; errors: string[] };

export type ReviewGateVerdict = "PASS" | "FAIL" | "ABSTAIN";
export type ReviewGateFailureKind = "fatal" | "missing_tests" | null;

export type ReviewGateDecision = {
  verdict: ReviewGateVerdict;
  failureKind: ReviewGateFailureKind;
  reasons: string[];
  missingCriteria: ReviewGateCriterion[];
  fatalBlockers: ReviewGateFatalBlocker[];
};

export type ReviewGateEvidenceValidators = {
  sourceQuote?: (criterion: ReviewGateCriterion) => boolean;
  testEvidence?: (criterion: ReviewGateCriterion, evidence: ReviewGateTestEvidence) => boolean;
  fatalBlocker?: (blocker: ReviewGateFatalBlocker) => boolean;
};

export type ReviewGateEvaluationOptions = {
  /** Whether the host supplied an exhaustive current-HEAD test inventory. */
  testInventoryComplete: boolean;
  /** Product changes may use non-automated classifications only when the AC text explicitly supports them. */
  requiresAutomatedEvidence?: boolean;
  /** Deterministic lower bound from explicit AC checklists/sections in trusted text. */
  minimumAcceptanceCriteria?: number;
  /** Exact checklist/section items extracted by the host from trusted text. */
  explicitAcceptanceCriteria?: readonly string[];
  /** Do not allow prose inferred by the model to replace host-recognized AC items. */
  requiresExplicitAcceptanceCriteria?: boolean;
  evidenceValidators?: ReviewGateEvidenceValidators;
};

export type ReviewGateEvaluation = {
  response: ReviewGateResponse | null;
  parseErrors: string[];
  decision: ReviewGateDecision;
};

const CONTEXT_STATUS_SET = new Set<string>(REVIEW_GATE_CONTEXT_STATUSES);
const TESTABILITY_SET = new Set<string>(REVIEW_GATE_TESTABILITIES);
const COVERAGE_SET = new Set<string>(REVIEW_GATE_COVERAGES);
const FATAL_OUTCOME_SET = new Set<string>(REVIEW_GATE_FATAL_OUTCOMES);

const RESPONSE_KEYS = [
  "context_status",
  "test_inventory_complete",
  "criteria",
  "fatal_blockers",
  "abstain_reasons",
] as const;
const CRITERION_KEYS = ["id", "source_quote", "testability", "coverage", "test_evidence"] as const;
const TEST_EVIDENCE_KEYS = ["file", "test_name", "assertion_quote"] as const;
const FATAL_BLOCKER_KEYS = [
  "file",
  "line",
  "code_quote",
  "outcome",
  "trigger",
  "causal_chain",
  "causal_evidence",
] as const;
const CODE_EVIDENCE_KEYS = ["file", "line", "code_quote"] as const;

/**
 * Parse the model's exact wire schema. This deliberately does not extract code
 * fences, repair JSON, coerce values, accept aliases, or ignore unknown fields.
 */
export function parseReviewGateResponse(text: string): ReviewGateParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      errors: [`$: invalid JSON (${error instanceof Error ? error.message : String(error)})`],
    };
  }

  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: ["$: expected an object"] };
  }

  validateExactKeys(raw, RESPONSE_KEYS, "$", errors);

  const contextStatus = readEnum(raw.context_status, CONTEXT_STATUS_SET, "$.context_status", errors);
  const testInventoryComplete = readBoolean(
    raw.test_inventory_complete,
    "$.test_inventory_complete",
    errors,
  );
  const criteria = readArray(raw.criteria, "$.criteria", errors, parseCriterion);
  const fatalBlockers = readArray(raw.fatal_blockers, "$.fatal_blockers", errors, parseFatalBlocker);
  const abstainReasons = readArray(raw.abstain_reasons, "$.abstain_reasons", errors, parseNonEmptyString);

  if (fatalBlockers && fatalBlockers.length > 2) {
    errors.push("$.fatal_blockers: expected at most 2 items");
  }
  if (criteria && criteria.length > 32) {
    errors.push("$.criteria: expected at most 32 items");
  }
  if (abstainReasons && abstainReasons.length > 8) {
    errors.push("$.abstain_reasons: expected at most 8 items");
  }
  if (criteria) {
    criteria.forEach((criterion, index) => {
      const expectedId = `AC-${index + 1}`;
      if (criterion.id !== expectedId) {
        errors.push(`$.criteria[${index}].id: expected ${JSON.stringify(expectedId)}`);
      }
      if (testInventoryComplete === false && criterion.coverage === "missing") {
        errors.push(
          `$.criteria[${index}].coverage: incomplete test inventory requires "unknown" instead of "missing"`,
        );
      }
    });
  }

  if (
    errors.length > 0 ||
    !contextStatus ||
    testInventoryComplete === null ||
    !criteria ||
    !fatalBlockers ||
    !abstainReasons
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      contextStatus: contextStatus as ReviewGateContextStatus,
      testInventoryComplete,
      criteria,
      fatalBlockers,
      abstainReasons,
    },
  };
}

export function decideReviewGate(
  response: ReviewGateResponse,
  options: ReviewGateEvaluationOptions,
): ReviewGateDecision {
  if (response.contextStatus === "insufficient") {
    return abstain(["자동 판정에 필요한 현재 HEAD 근거가 충분하지 않습니다."]);
  }

  if (response.abstainReasons.length > 0) {
    return abstain(["모델이 현재 근거만으로 판정을 확정하지 못했습니다."]);
  }

  const invalidEvidence = validateReviewGateEvidence(response, options.evidenceValidators);
  if (invalidEvidence.length > 0) {
    return abstain(invalidEvidence);
  }

  const automated = response.criteria.filter((criterion) => criterion.testability === "automated");
  const missing = automated.filter((criterion) => criterion.coverage === "missing");
  const unknown = automated.filter((criterion) => criterion.coverage === "unknown");
  const inventoryComplete = options.testInventoryComplete && response.testInventoryComplete;

  if (response.fatalBlockers.length > 0) {
    return {
      verdict: "FAIL",
      failureKind: "fatal",
      reasons: response.fatalBlockers.map(
        (blocker) => `${blocker.file}:${blocker.line}에서 ${fatalOutcomeLabel(blocker.outcome)}이 확인됐습니다.`,
      ),
      missingCriteria: [],
      fatalBlockers: response.fatalBlockers,
    };
  }

  const explicitCriteria = [...new Set(
    (options.explicitAcceptanceCriteria || [])
      .map(normalizeAcceptanceCriterion)
      .filter(Boolean),
  )];
  if (options.requiresExplicitAcceptanceCriteria && explicitCriteria.length === 0) {
    return abstain(["명시적인 인수조건을 찾지 못해 자동 판정을 생략했습니다."]);
  }

  if (response.criteria.length === 0) {
    return abstain(["명시적인 인수조건이 없어 테스트 게이트를 판정할 수 없습니다."]);
  }

  const normalizedSourceQuotes = response.criteria.map((criterion) =>
    normalizeAcceptanceCriterion(criterion.sourceQuote),
  );
  if (new Set(normalizedSourceQuotes).size !== normalizedSourceQuotes.length) {
    return abstain(["서로 다른 인수조건이 같은 원문을 중복 인용해 자동 판정을 확정할 수 없습니다."]);
  }

  const missingExplicitCriteria = explicitCriteria.filter(
    (criterion) => !normalizedSourceQuotes.includes(criterion),
  );
  if (
    missingExplicitCriteria.length > 0 ||
    (options.requiresExplicitAcceptanceCriteria && normalizedSourceQuotes.length !== explicitCriteria.length)
  ) {
    return abstain([
      "명시적 인수조건과 모델 결과가 정확히 대응하지 않아 자동 판정을 확정할 수 없습니다.",
    ]);
  }

  const minimumAcceptanceCriteria = Math.max(0, options.minimumAcceptanceCriteria || 0);
  if (response.criteria.length < minimumAcceptanceCriteria) {
    return abstain([
      `명시된 인수조건 ${minimumAcceptanceCriteria}개 중 ${response.criteria.length}개만 추출돼 자동 판정을 확정할 수 없습니다.`,
    ]);
  }

  if (options.requiresAutomatedEvidence) {
    const unsupportedNonAutomated = response.criteria.filter(
      (criterion) =>
        criterion.testability !== "automated" &&
        !isExplicitNonAutomatedCriterion(criterion.sourceQuote),
    );
    if (unsupportedNonAutomated.length > 0) {
      return abstain([
        "제품 동작 인수조건이 자동화 대상이 아닌 것으로 분류됐지만 원문에서 수동 검증 근거를 찾지 못했습니다.",
      ]);
    }
  }

  if (missing.length > 0) {
    if (inventoryComplete) {
      return {
        verdict: "FAIL",
        failureKind: "missing_tests",
        reasons: ["현재 HEAD의 전체 테스트를 확인했지만 자동화 가능한 인수조건을 검증하는 테스트가 없습니다."],
        missingCriteria: missing,
        fatalBlockers: [],
      };
    }
    return abstain(["현재 HEAD 테스트 목록이 일부만 제공돼 테스트 누락 여부를 확정할 수 없습니다."]);
  }

  if (unknown.length > 0) {
    return abstain(["자동화 가능한 인수조건의 테스트 근거를 현재 HEAD에서 확인할 수 없습니다."]);
  }

  return {
    verdict: "PASS",
    failureKind: null,
    reasons: ["모든 자동화 대상 인수조건이 테스트로 확인되었고 명백한 치명 결함이 없습니다."],
    missingCriteria: [],
    fatalBlockers: [],
  };
}

export function evaluateReviewGate(text: string, options: ReviewGateEvaluationOptions): ReviewGateEvaluation {
  const parsed = parseReviewGateResponse(text);
  if (!parsed.ok) {
    return {
      response: null,
      parseErrors: parsed.errors,
      decision: abstain(["모델 응답 형식이 올바르지 않아 자동 판정을 확정할 수 없습니다."]),
    };
  }

  return {
    response: parsed.value,
    parseErrors: [],
    decision: decideReviewGate(parsed.value, options),
  };
}

/**
 * Cross-check model quotes against trusted host context. Missing validators are
 * intentionally skipped; a validator rejection or exception always abstains.
 */
export function validateReviewGateEvidence(
  response: ReviewGateResponse,
  validators: ReviewGateEvidenceValidators | undefined,
): string[] {
  if (!validators) {
    return [];
  }

  const errors: string[] = [];
  for (const criterion of response.criteria) {
    if (validators.sourceQuote && !safeValidate(() => validators.sourceQuote!(criterion))) {
      errors.push(`${criterion.id}: 인수조건 원문을 신뢰 가능한 컨텍스트에서 확인할 수 없습니다.`);
    }
    if (
      criterion.coverage === "covered" &&
      criterion.testEvidence &&
      validators.testEvidence &&
      !safeValidate(() => validators.testEvidence!(criterion, criterion.testEvidence!))
    ) {
      errors.push(`${criterion.id}: 테스트 근거를 현재 HEAD 컨텍스트에서 확인할 수 없습니다.`);
    }
  }

  if (validators.fatalBlocker) {
    for (const blocker of response.fatalBlockers) {
      if (!safeValidate(() => validators.fatalBlocker!(blocker))) {
        errors.push(`${blocker.file}:${blocker.line}: 치명 결함 근거를 변경 diff에서 확인할 수 없습니다.`);
      }
    }
  }
  return errors;
}

function parseCriterion(value: unknown, path: string, errors: string[]): ReviewGateCriterion | null {
  if (!isRecord(value)) {
    errors.push(`${path}: expected an object`);
    return null;
  }
  validateExactKeys(value, CRITERION_KEYS, path, errors);

  const id = readNonEmptyString(value.id, `${path}.id`, errors);
  const sourceQuote = readNonEmptyString(value.source_quote, `${path}.source_quote`, errors);
  const testability = readEnum(value.testability, TESTABILITY_SET, `${path}.testability`, errors);
  const coverage = readEnum(value.coverage, COVERAGE_SET, `${path}.coverage`, errors);
  const testEvidence = parseNullableTestEvidence(value.test_evidence, `${path}.test_evidence`, errors);

  if (coverage === "covered" && testEvidence === null) {
    errors.push(`${path}.test_evidence: coverage "covered" requires test evidence`);
  }
  if ((coverage === "missing" || coverage === "unknown") && testEvidence !== null) {
    errors.push(`${path}.test_evidence: coverage "${coverage}" requires null`);
  }
  if (testability && testability !== "automated" && coverage && coverage !== "unknown") {
    errors.push(`${path}.coverage: testability "${testability}" requires coverage "unknown"`);
  }

  if (!id || !sourceQuote || !testability || !coverage || testEvidence === undefined) {
    return null;
  }
  return {
    id,
    sourceQuote,
    testability: testability as ReviewGateTestability,
    coverage: coverage as ReviewGateCoverage,
    testEvidence,
  };
}

function parseNullableTestEvidence(
  value: unknown,
  path: string,
  errors: string[],
): ReviewGateTestEvidence | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    errors.push(`${path}: expected an object or null`);
    return undefined;
  }
  validateExactKeys(value, TEST_EVIDENCE_KEYS, path, errors);
  const file = readNonEmptyString(value.file, `${path}.file`, errors);
  const testName = readNonEmptyString(value.test_name, `${path}.test_name`, errors);
  const assertionQuote = readNonEmptyString(value.assertion_quote, `${path}.assertion_quote`, errors);
  if (!file || !testName || !assertionQuote) {
    return undefined;
  }
  return { file, testName, assertionQuote };
}

function parseFatalBlocker(value: unknown, path: string, errors: string[]): ReviewGateFatalBlocker | null {
  if (!isRecord(value)) {
    errors.push(`${path}: expected an object`);
    return null;
  }
  validateExactKeys(value, FATAL_BLOCKER_KEYS, path, errors);
  const file = readNonEmptyString(value.file, `${path}.file`, errors);
  const line = readPositiveInteger(value.line, `${path}.line`, errors);
  const codeQuote = readNonEmptyString(value.code_quote, `${path}.code_quote`, errors);
  const outcome = readEnum(value.outcome, FATAL_OUTCOME_SET, `${path}.outcome`, errors);
  const trigger = readNonEmptyString(value.trigger, `${path}.trigger`, errors);
  const causalChain = readNonEmptyString(value.causal_chain, `${path}.causal_chain`, errors);
  const causalEvidence = readArray(
    value.causal_evidence,
    `${path}.causal_evidence`,
    errors,
    parseCodeEvidence,
  );
  if (causalEvidence && (causalEvidence.length < 2 || causalEvidence.length > 6)) {
    errors.push(`${path}.causal_evidence: expected 2 to 6 items`);
  }
  if (!file || line === null || !codeQuote || !outcome || !trigger || !causalChain || !causalEvidence) {
    return null;
  }
  return {
    file,
    line,
    codeQuote,
    outcome: outcome as ReviewGateFatalOutcome,
    trigger,
    causalChain,
    causalEvidence,
  };
}

function parseCodeEvidence(
  value: unknown,
  path: string,
  errors: string[],
): ReviewGateCodeEvidence | null {
  if (!isRecord(value)) {
    errors.push(`${path}: expected an object`);
    return null;
  }
  validateExactKeys(value, CODE_EVIDENCE_KEYS, path, errors);
  const file = readNonEmptyString(value.file, `${path}.file`, errors);
  const line = readPositiveInteger(value.line, `${path}.line`, errors);
  const codeQuote = readNonEmptyString(value.code_quote, `${path}.code_quote`, errors);
  if (!file || line === null || !codeQuote) {
    return null;
  }
  return { file, line, codeQuote };
}

function parseNonEmptyString(value: unknown, path: string, errors: string[]): string | null {
  return readNonEmptyString(value, path, errors);
}

function readArray<T>(
  value: unknown,
  path: string,
  errors: string[],
  parseItem: (item: unknown, itemPath: string, itemErrors: string[]) => T | null,
): T[] | null {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected an array`);
    return null;
  }
  const result: T[] = [];
  value.forEach((item, index) => {
    const parsed = parseItem(item, `${path}[${index}]`, errors);
    if (parsed !== null) {
      result.push(parsed);
    }
  });
  return result;
}

function readEnum(value: unknown, allowed: Set<string>, path: string, errors: string[]): string | null {
  if (typeof value !== "string" || !allowed.has(value)) {
    errors.push(`${path}: unexpected enum value ${JSON.stringify(value)}`);
    return null;
  }
  return value;
}

function readBoolean(value: unknown, path: string, errors: string[]): boolean | null {
  if (typeof value !== "boolean") {
    errors.push(`${path}: expected a boolean`);
    return null;
  }
  return value;
}

function readNonEmptyString(value: unknown, path: string, errors: string[]): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${path}: expected a non-empty string`);
    return null;
  }
  return value;
}

function readPositiveInteger(value: unknown, path: string, errors: string[]): number | null {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    errors.push(`${path}: expected a positive integer`);
    return null;
  }
  return Number(value);
}

function validateExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  errors: string[],
): void {
  const expectedSet = new Set(expected);
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) {
      errors.push(`${path}.${key}: required field is missing`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) {
      errors.push(`${path}.${key}: unknown field`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeValidate(validate: () => boolean): boolean {
  try {
    return validate() === true;
  } catch {
    return false;
  }
}

function normalizeAcceptanceCriterion(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

function isExplicitNonAutomatedCriterion(value: string): boolean {
  return /(?:수동|실제\s*기기|실기기|직접[^.!?\n]{0,30}(?:확인|검증)|육안|시각|스크린샷|문서|릴리스\s*(?:문구|노트)|메타데이터|이미지|아이콘|\bmanual(?:ly)?\b|\breal[ -]?device\b|\bvisual(?:ly)?\b|\bscreenshot\b|\bdocs?\b|\bdocumentation\b|\brelease notes?\b|\bmetadata\b|\bassets?\b|\bicons?\b|\breadme\b)/iu.test(
    value,
  );
}

function abstain(reasons: string[]): ReviewGateDecision {
  return {
    verdict: "ABSTAIN",
    failureKind: null,
    reasons,
    missingCriteria: [],
    fatalBlockers: [],
  };
}

function fatalOutcomeLabel(outcome: ReviewGateFatalOutcome): string {
  const labels: Record<ReviewGateFatalOutcome, string> = {
    deterministic_crash: "일반 경로의 확정적 크래시",
    permanent_data_loss_or_corruption: "영구 데이터 손실 또는 손상",
    exploitable_security_or_privacy_exposure: "악용 가능한 보안 또는 개인정보 노출",
    primary_flow_unusable: "핵심 사용자 흐름 사용 불가",
  };
  return labels[outcome];
}
