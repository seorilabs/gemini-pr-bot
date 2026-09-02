import type {
  MiniMaxCandidateVerification,
  MiniMaxCodeEvidence,
  MiniMaxReviewCandidate,
} from "./minimax-review.js";
import {
  fingerprintReviewFinding,
  type FatalFindingCandidate,
  type MissingTestsFindingCandidate,
  type ReviewFindingCandidate,
  type ReviewFindingEvidence,
} from "./review-finding-ledger.js";
import {
  formatReviewGateFinding,
  type ReviewGatePublicFinding,
} from "./review-gate-format.js";
import { buildChangedLineEvidence } from "./review-grounding.js";
import { isExplicitlyManualAcceptanceCriterion } from "./review-acceptance-coverage.js";

export const REVIEW_GATE_PIPELINE_MAX_FINDINGS = 2 as const;

export type ReviewGatePipelineInput = {
  candidates: readonly MiniMaxReviewCandidate[];
  verifications: readonly MiniMaxCandidateVerification[];
  /** Trusted host extraction. AC-1 is the first item, AC-2 the second, and so on. */
  explicitAcceptanceCriteria: readonly string[];
  /** True only when the host supplied an exhaustive current-HEAD test inventory. */
  testInventoryComplete: boolean;
  testInventoryFileCount: number;
  /** Full current-HEAD contents keyed by repository-relative path. */
  currentHeadFileContents: Readonly<Record<string, string>>;
  /** Host-visible PR patches keyed by repository-relative path. */
  visibleChangedPatches: Readonly<Record<string, string>>;
};

export type ReviewGateCandidateRejectionCode =
  | "candidate_limit_exceeded"
  | "candidate_ids_invalid"
  | "verification_set_mismatch"
  | "verification_not_confirmed"
  | "acceptance_criterion_not_exact"
  | "manual_acceptance_criterion"
  | "test_inventory_incomplete"
  | "missing_test_shape_invalid"
  | "fatal_shape_invalid"
  | "fatal_code_not_grounded"
  | "fatal_root_not_added"
  | "fatal_symbol_not_grounded"
  | "fatal_causal_chain_invalid"
  | "fatal_outcome_not_direct"
  | "verifier_evidence_not_grounded"
  | "public_finding_invalid";

export type RejectedReviewGateCandidate = {
  candidateId: string;
  code: ReviewGateCandidateRejectionCode;
  /** Internal diagnostics only. Never publish this text in a GitHub review. */
  reason: string;
};

export type AcceptedReviewGateCandidate = {
  candidateId: string;
  ledgerCandidate: ReviewFindingCandidate;
  publicFinding: ReviewGatePublicFinding;
};

export type ReviewGatePipelineResult = {
  /** False means the candidate/verifier collection itself violated the host protocol. */
  inputValid: boolean;
  accepted: AcceptedReviewGateCandidate[];
  rejected: RejectedReviewGateCandidate[];
  ledgerCandidates: ReviewFindingCandidate[];
  publicFindings: ReviewGatePublicFinding[];
};

type CandidateValidationResult =
  | AcceptedReviewGateCandidate
  | { rejection: RejectedReviewGateCandidate };

const SIMPLE_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
export const SYMBOL_MAX_DISTANCE = 200;
/**
 * Turns parsed MiniMax candidate/verifier results into host-grounded findings.
 *
 * Parsing proves only the wire shape. This function supplies the trust
 * boundary: it checks trusted AC text, exhaustive inventory state, and exact
 * current-HEAD code before anything can become a blocking public finding.
 */
export function evaluateMiniMaxReviewGateCandidates(
  input: ReviewGatePipelineInput,
): ReviewGatePipelineResult {
  const protocolError = validateCandidateProtocol(input.candidates, input.verifications);
  if (protocolError) {
    return pipelineResult(
      false,
      [],
      input.candidates.map((candidate) => rejection(candidate, protocolError.code, protocolError.reason)),
    );
  }

  const accepted: AcceptedReviewGateCandidate[] = [];
  const rejected: RejectedReviewGateCandidate[] = [];
  for (let index = 0; index < input.candidates.length; index += 1) {
    const candidate = input.candidates[index]!;
    const verification = input.verifications[index]!;
    const result = validateCandidate(input, candidate, verification);
    if ("rejection" in result) {
      rejected.push(result.rejection);
    } else {
      accepted.push(result);
    }
  }

  return pipelineResult(true, accepted, rejected);
}

function pipelineResult(
  inputValid: boolean,
  accepted: AcceptedReviewGateCandidate[],
  rejected: RejectedReviewGateCandidate[],
): ReviewGatePipelineResult {
  return {
    inputValid,
    accepted,
    rejected,
    ledgerCandidates: accepted.map((item) => item.ledgerCandidate),
    publicFindings: accepted.map((item) => item.publicFinding),
  };
}

function validateCandidateProtocol(
  candidates: readonly MiniMaxReviewCandidate[],
  verifications: readonly MiniMaxCandidateVerification[],
): Pick<RejectedReviewGateCandidate, "code" | "reason"> | null {
  if (candidates.length > REVIEW_GATE_PIPELINE_MAX_FINDINGS) {
    return {
      code: "candidate_limit_exceeded",
      reason: `후보 수 ${candidates.length}건이 host 상한 ${REVIEW_GATE_PIPELINE_MAX_FINDINGS}건을 초과했습니다.`,
    };
  }

  const expectedIds = candidates.map((_, index) => `C-${index + 1}`);
  if (
    candidates.some((candidate, index) => candidate.candidateId !== expectedIds[index]) ||
    new Set(candidates.map((candidate) => candidate.candidateId)).size !== candidates.length
  ) {
    return {
      code: "candidate_ids_invalid",
      reason: "후보 ID가 C-1부터 순서대로 유일하게 배정되지 않았습니다.",
    };
  }

  if (
    verifications.length !== candidates.length ||
    verifications.some((verification, index) => verification.candidateId !== expectedIds[index])
  ) {
    return {
      code: "verification_set_mismatch",
      reason: "모든 후보에 대해 같은 순서의 검증 결과가 정확히 하나씩 필요합니다.",
    };
  }
  return null;
}

function validateCandidate(
  input: ReviewGatePipelineInput,
  candidate: MiniMaxReviewCandidate,
  verification: MiniMaxCandidateVerification,
): CandidateValidationResult {
  if (verification.verdict !== "confirmed") {
    return rejected(
      candidate,
      "verification_not_confirmed",
      `검증 모델 판정이 confirmed가 아니라 ${verification.verdict}입니다.`,
    );
  }

  if (candidate.kind === "missing_acceptance_test") {
    return validateMissingTestCandidate(input, candidate);
  }
  return validateFatalCandidate(input, candidate, verification);
}

function validateMissingTestCandidate(
  input: ReviewGatePipelineInput,
  candidate: MiniMaxReviewCandidate,
): CandidateValidationResult {
  if (
    candidate.file !== null ||
    candidate.symbol !== null ||
    candidate.line !== null ||
    candidate.codeQuote !== null ||
    candidate.fatalOutcome !== null ||
    candidate.evidence.length !== 0 ||
    !candidate.criterionId ||
    !candidate.acceptanceCriterion ||
    !candidate.testSearchSummaryKo
  ) {
    return rejected(
      candidate,
      "missing_test_shape_invalid",
      "테스트 누락 후보에 코드 위치가 섞였거나 필수 인수조건/검색 요약이 없습니다.",
    );
  }

  const criterionIndex = criterionIndexFromId(candidate.criterionId);
  const trustedCriterion = criterionIndex === null
    ? undefined
    : input.explicitAcceptanceCriteria[criterionIndex];
  if (
    trustedCriterion === undefined ||
    exactProse(trustedCriterion) !== exactProse(candidate.acceptanceCriterion)
  ) {
    return rejected(
      candidate,
      "acceptance_criterion_not_exact",
      "후보의 AC ID와 원문이 host가 추출한 명시적 인수조건에 정확히 대응하지 않습니다.",
    );
  }

  if (isExplicitlyManualAcceptanceCriterion(trustedCriterion)) {
    return rejected(
      candidate,
      "manual_acceptance_criterion",
      "명시적으로 수동·육안·실기기 확인을 요구한 인수조건은 자동화 테스트 누락으로 차단하지 않습니다.",
    );
  }

  if (
    input.testInventoryComplete !== true ||
    !Number.isSafeInteger(input.testInventoryFileCount) ||
    input.testInventoryFileCount < 0
  ) {
    return rejected(
      candidate,
      "test_inventory_incomplete",
      "host가 현재 HEAD의 전체 테스트 인벤토리를 확인하지 못했습니다.",
    );
  }

  const ledgerCandidate: MissingTestsFindingCandidate = {
    kind: "missing_tests",
    category: "missing_acceptance_test",
    file: null,
    symbol: null,
    // Trusted AC text remains stable when the model paraphrases its trigger.
    trigger: trustedCriterion,
    acceptanceCriterion: trustedCriterion,
    evidence: [
      {
        kind: "acceptance_criterion",
        file: null,
        line: null,
        symbol: null,
        quote: trustedCriterion,
      },
      {
        kind: "test_inventory",
        file: null,
        line: null,
        symbol: null,
        // Deliberately exclude the file count so unrelated test additions do
        // not make the same missing-test finding look materially new.
        quote: "현재 HEAD의 전체 테스트 인벤토리 검색 완료",
      },
    ],
  };
  const publicFinding: ReviewGatePublicFinding = {
    kind: "missing_acceptance_test",
    title: candidate.titleKo,
    problem: candidate.problemKo,
    trigger: candidate.triggerKo,
    impact: candidate.impactKo,
    requiredAction: candidate.fixKo,
    evidence: {
      acceptanceCriterion: trustedCriterion,
      testInventoryComplete: true,
      testFilesInspected: input.testInventoryFileCount,
    },
    fingerprint: fingerprintReviewFinding(ledgerCandidate),
  };
  return validatePublicFinding(candidate, ledgerCandidate, publicFinding);
}

function validateFatalCandidate(
  input: ReviewGatePipelineInput,
  candidate: MiniMaxReviewCandidate,
  verification: MiniMaxCandidateVerification,
): CandidateValidationResult {
  if (
    !candidate.file ||
    !candidate.symbol ||
    candidate.line === null ||
    !candidate.codeQuote ||
    !candidate.fatalOutcome ||
    candidate.criterionId !== null ||
    candidate.acceptanceCriterion !== null ||
    candidate.testSearchSummaryKo !== null
  ) {
    return rejected(
      candidate,
      "fatal_shape_invalid",
      "치명 결함 후보에 file, line, symbol, outcome 또는 코드 근거가 빠졌습니다.",
    );
  }

  const candidateFile = candidate.file;
  const candidateSymbol = candidate.symbol;
  const candidateLine = candidate.line;
  const candidateCodeQuote = candidate.codeQuote;
  const fatalOutcome = candidate.fatalOutcome;
  const path = normalizeRepositoryPath(candidateFile);
  const content = path ? normalizedContentMap(input.currentHeadFileContents).get(path) : undefined;
  if (!path || content === undefined || !isExactCurrentLine(content, candidateLine, candidateCodeQuote)) {
    return rejected(
      candidate,
      "fatal_code_not_grounded",
      "대표 file:line:code_quote가 현재 HEAD의 정확한 코드 한 줄과 일치하지 않습니다.",
    );
  }

  const normalizedPatches = Object.fromEntries(normalizedContentMap(input.visibleChangedPatches));
  const addedRootLine = buildChangedLineEvidence(normalizedPatches).get(path)?.get(candidateLine);
  if (normalizedCode(addedRootLine || "") !== normalizedCode(candidateCodeQuote)) {
    return rejected(
      candidate,
      "fatal_root_not_added",
      "대표 치명 원인 file:line:code_quote가 현재 PR patch의 추가된 줄과 정확히 일치하지 않습니다.",
    );
  }

  const causalError = validateCausalEvidence(
    candidate,
    content,
    path,
    candidateLine,
    candidateCodeQuote,
  );
  if (causalError) {
    return rejected(candidate, causalError.code, causalError.reason);
  }

  if (!isSymbolGrounded(content, candidateSymbol, candidate.evidence)) {
    return rejected(
      candidate,
      "fatal_symbol_not_grounded",
      "지목한 symbol을 인과 근거와 가까운 현재 HEAD 코드에서 확인하지 못했습니다.",
    );
  }

  if (!hasDirectOutcomeSignature(fatalOutcome, candidateCodeQuote)) {
    return rejected(
      candidate,
      "fatal_outcome_not_direct",
      "종단 코드 한 줄이 주장한 치명 결과를 직접 발생시키는 서명을 포함하지 않습니다.",
    );
  }

  const verifierRooted = verification.evidence.length > 0 &&
    verification.evidence.every((evidence) => isGroundedCodeEvidence(input, evidence)) &&
    verification.evidence.some((evidence) => sameCodeEvidence(evidence, {
      file: candidateFile,
      line: candidateLine,
      codeQuote: candidateCodeQuote,
    }));
  if (!verifierRooted) {
    return rejected(
      candidate,
      "verifier_evidence_not_grounded",
      "confirmed 검증 결과가 현재 HEAD에서 확인되는 동일 종단 근거를 독립적으로 인용하지 않았습니다.",
    );
  }

  const ledgerEvidence: ReviewFindingEvidence[] = candidate.evidence.map((evidence) => ({
    kind: "code",
    file: path,
    line: evidence.line,
    symbol: candidateSymbol,
    quote: evidence.codeQuote,
  }));
  const ledgerCandidate: FatalFindingCandidate = {
    kind: "fatal",
    category: "fatal_defect",
    outcome: fatalOutcome,
    file: path,
    symbol: candidateSymbol,
    // Stable host-owned trigger prevents paraphrases from creating duplicates.
    trigger: `${path}#${candidateSymbol}`,
    evidence: ledgerEvidence,
  };
  const publicFinding: ReviewGatePublicFinding = {
    kind: "fatal_defect",
    title: candidate.titleKo,
    problem: candidate.problemKo,
    trigger: candidate.triggerKo,
    impact: candidate.impactKo,
    requiredAction: candidate.fixKo,
    evidence: {
      file: path,
      line: candidateLine,
      code: candidateCodeQuote,
    },
    fingerprint: fingerprintReviewFinding(ledgerCandidate),
  };
  return validatePublicFinding(candidate, ledgerCandidate, publicFinding);
}

function validateCausalEvidence(
  candidate: MiniMaxReviewCandidate,
  content: string,
  normalizedPath: string,
  candidateLine: number,
  candidateCodeQuote: string,
): Pick<RejectedReviewGateCandidate, "code" | "reason"> | null {
  if (candidate.evidence.length < 2) {
    return {
      code: "fatal_causal_chain_invalid",
      reason: "치명 결함에는 시작 원인과 종단 결과를 포함한 코드 근거가 최소 2개 필요합니다.",
    };
  }

  const keys = new Set<string>();
  let previousLine = 0;
  for (const evidence of candidate.evidence) {
    if (
      normalizeRepositoryPath(evidence.file) !== normalizedPath ||
      evidence.line <= previousLine ||
      evidence.line - candidate.evidence[0]!.line > SYMBOL_MAX_DISTANCE ||
      !isExactCurrentLine(content, evidence.line, evidence.codeQuote)
    ) {
      return {
        code: "fatal_causal_chain_invalid",
        reason: "인과 근거는 같은 파일에서 현재 HEAD와 일치하며 200줄 안에서 위에서 아래 순서여야 합니다.",
      };
    }
    const key = `${normalizedPath}:${evidence.line}:${normalizedCode(evidence.codeQuote)}`;
    if (keys.has(key)) {
      return {
        code: "fatal_causal_chain_invalid",
        reason: "인과 근거에 같은 코드 위치가 중복됐습니다.",
      };
    }
    keys.add(key);
    previousLine = evidence.line;
  }

  const terminal = candidate.evidence.at(-1)!;
  if (
    terminal.line !== candidateLine ||
    normalizeRepositoryPath(terminal.file) !== normalizedPath ||
    normalizedCode(terminal.codeQuote) !== normalizedCode(candidateCodeQuote)
  ) {
    return {
      code: "fatal_causal_chain_invalid",
      reason: "인과 근거의 마지막 항목이 대표 종단 file:line:code_quote와 일치하지 않습니다.",
    };
  }
  return null;
}

function isGroundedCodeEvidence(
  input: ReviewGatePipelineInput,
  evidence: MiniMaxCodeEvidence,
): boolean {
  const path = normalizeRepositoryPath(evidence.file);
  if (!path) {
    return false;
  }
  const content = normalizedContentMap(input.currentHeadFileContents).get(path);
  return content !== undefined && isExactCurrentLine(content, evidence.line, evidence.codeQuote);
}

function validatePublicFinding(
  candidate: MiniMaxReviewCandidate,
  ledgerCandidate: ReviewFindingCandidate,
  publicFinding: ReviewGatePublicFinding,
): CandidateValidationResult {
  try {
    // The public formatter is the final Korean/readability policy. Validate it
    // here so an accepted finding is guaranteed to be publishable later.
    formatReviewGateFinding(publicFinding);
  } catch (error) {
    return rejected(
      candidate,
      "public_finding_invalid",
      `공개 리뷰 형식 검증 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { candidateId: candidate.candidateId, ledgerCandidate, publicFinding };
}

function isSymbolGrounded(
  content: string,
  symbol: string,
  evidence: readonly MiniMaxCodeEvidence[],
): boolean {
  if (!symbol.trim() || /[\r\n]/u.test(symbol)) {
    return false;
  }
  const lines = content.split(/\r?\n/u);
  const firstEvidenceLine = evidence[0]?.line || 1;
  const lastEvidenceLine = evidence.at(-1)?.line || firstEvidenceLine;
  const start = Math.max(0, firstEvidenceLine - SYMBOL_MAX_DISTANCE - 1);
  const end = Math.min(lines.length, lastEvidenceLine);
  const window = lines.slice(start, end).join("\n");
  if (SIMPLE_IDENTIFIER_PATTERN.test(symbol)) {
    return new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(symbol)}(?![A-Za-z0-9_$])`, "u").test(window);
  }
  return window.includes(symbol);
}

function hasDirectOutcomeSignature(
  outcome: NonNullable<MiniMaxReviewCandidate["fatalOutcome"]>,
  sourceLine: string,
): boolean {
  const line = executableCode(sourceLine);
  const crash = /\b(?:throw|panic!?|fatalerror|abort|raise)\b|assert\s*\(\s*false/iu;
  if (outcome === "deterministic_crash") {
    // 서명 키워드 없이도 결정적 크래시를 직접 일으키는 관용구:
    // 인덱스 접근(범위 초과), 나눗셈·나머지(0 나눗셈). 정확한 line·quote
    // grounding과 verifier 확인이 오탐을 계속 막는다.
    const subscriptAccess = /\w\s*\[[^\]]+\]/u;
    const divisionOrModulo = /[^\s/*]\s*[/%]\s*[^\s/*=]/u;
    return crash.test(line) || subscriptAccess.test(line) || divisionOrModulo.test(line);
  }
  if (outcome === "permanent_data_loss_or_corruption") {
    const destructive =
      /\b(?:clear|delete|destroy|drop|erase|purge|remove|truncate|unlink|wipe)\s*(?:\(|\b)/iu;
    const persistentTarget =
      /\b(?:account|collection|database|db|document|file|firestore|persistent|record|save|storage|store|table|user)\w*\b/iu;
    return destructive.test(line) && persistentTarget.test(line);
  }
  if (outcome === "exploitable_security_or_privacy_exposure") {
    return (
      /\ballow\s+(?:read|write|create|update|delete)(?:\s*,\s*(?:read|write|create|update|delete))*\s*:\s*if\s+true\b/iu.test(line) ||
      /\b(?:rejectunauthorized|verify[_-]?(?:ssl|tls|certificate))\b\s*[:=]\s*false\b/iu.test(line) ||
      /\b(?:log|print|send|return)\w*\s*\([^)]*\b(?:password|secret|token|credential|private[_-]?key)\b/iu.test(line)
    );
  }
  // A UI flag or return value alone cannot prove the primary flow is unusable.
  return crash.test(line);
}

function executableCode(sourceLine: string): string {
  const trimmed = sourceLine.normalize("NFKC").trim();
  if (/^(?:\/\/|#|\/\*|\*)/u.test(trimmed)) {
    return "";
  }
  return trimmed.replace(/\s+\/\/.*$/u, "").replace(/\s+#.*$/u, "");
}

function sameCodeEvidence(
  left: Pick<MiniMaxCodeEvidence, "file" | "line" | "codeQuote">,
  right: Pick<MiniMaxCodeEvidence, "file" | "line" | "codeQuote">,
): boolean {
  return normalizeRepositoryPath(left.file) === normalizeRepositoryPath(right.file) &&
    left.line === right.line &&
    normalizedCode(left.codeQuote) === normalizedCode(right.codeQuote);
}

function isExactCurrentLine(content: string, line: number, codeQuote: string): boolean {
  if (!Number.isSafeInteger(line) || line < 1 || /[\r\n]/u.test(codeQuote)) {
    return false;
  }
  const currentLine = content.split(/\r?\n/u)[line - 1];
  return currentLine !== undefined && normalizedCode(currentLine) === normalizedCode(codeQuote);
}

function normalizedContentMap(contents: Readonly<Record<string, string>>): Map<string, string> {
  const result = new Map<string, string>();
  for (const [file, content] of Object.entries(contents)) {
    const path = normalizeRepositoryPath(file);
    if (path && !result.has(path)) {
      result.set(path, content);
    }
  }
  return result;
}

export function normalizeRepositoryPath(value: string): string | null {
  const normalized = value.normalize("NFKC").trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === ".." || part === "")
  ) {
    return null;
  }
  return normalized;
}

function criterionIndexFromId(id: string): number | null {
  const match = id.match(/^AC-([1-9]\d*)$/u);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value - 1 : null;
}

function exactProse(value: string): string {
  return value.normalize("NFKC").replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}

function normalizedCode(value: string): string {
  return value.normalize("NFKC").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function rejection(
  candidate: MiniMaxReviewCandidate,
  code: ReviewGateCandidateRejectionCode,
  reason: string,
): RejectedReviewGateCandidate {
  return { candidateId: candidate.candidateId, code, reason };
}

function rejected(
  candidate: MiniMaxReviewCandidate,
  code: ReviewGateCandidateRejectionCode,
  reason: string,
): { rejection: RejectedReviewGateCandidate } {
  return { rejection: rejection(candidate, code, reason) };
}
