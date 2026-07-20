import {
  parseMiniMaxReviewPayload,
  parseMiniMaxVerificationPayload,
  type MiniMaxAcceptanceCoverage,
  type MiniMaxCandidateVerification,
  type MiniMaxReviewCandidate,
} from "./minimax-review.js";

export const REVIEW_GATE_CACHE_SCHEMA_VERSION = 3 as const;

export type MiniMaxReviewGateCacheEnvelope = {
  schemaVersion: typeof REVIEW_GATE_CACHE_SCHEMA_VERSION;
  acceptanceCoverage: MiniMaxAcceptanceCoverage[];
  candidates: MiniMaxReviewCandidate[];
  verifications: MiniMaxCandidateVerification[];
};

const ROOT_KEYS = [
  "acceptance_coverage",
  "candidates",
  "schemaVersion",
  "verifications",
] as const;

/**
 * Encode a validated in-memory envelope as the exact cache wire shape.
 *
 * MiniMax payload fields stay in snake_case so a cache hit goes through the
 * same strict parser as a fresh model response.
 */
export function encodeReviewGateCache(
  envelope: MiniMaxReviewGateCacheEnvelope,
): Record<string, unknown> {
  return {
    schemaVersion: envelope.schemaVersion,
    acceptance_coverage: envelope.acceptanceCoverage.map((coverage) => ({
      criterion_id: coverage.criterionId,
      acceptance_criterion: coverage.acceptanceCriterion,
      status: coverage.status,
      test_evidence: coverage.testEvidence
        ? {
            file: coverage.testEvidence.file,
            line: coverage.testEvidence.line,
            test_name: coverage.testEvidence.testName,
            assertion_quote: coverage.testEvidence.assertionQuote,
            explanation_ko: coverage.testEvidence.explanationKo,
          }
        : null,
      supporting_test_evidence: (coverage.supportingTestEvidence || []).map((evidence) => ({
        file: evidence.file,
        line: evidence.line,
        test_name: evidence.testName,
        assertion_quote: evidence.assertionQuote,
        explanation_ko: evidence.explanationKo,
      })),
    })),
    candidates: envelope.candidates.map((candidate) => ({
      candidate_id: candidate.candidateId,
      kind: candidate.kind,
      title_ko: candidate.titleKo,
      problem_ko: candidate.problemKo,
      trigger_ko: candidate.triggerKo,
      impact_ko: candidate.impactKo,
      fix_ko: candidate.fixKo,
      file: candidate.file,
      symbol: candidate.symbol,
      line: candidate.line,
      code_quote: candidate.codeQuote,
      fatal_outcome: candidate.fatalOutcome,
      criterion_id: candidate.criterionId,
      acceptance_criterion: candidate.acceptanceCriterion,
      test_search_summary_ko: candidate.testSearchSummaryKo,
      evidence: candidate.evidence.map((evidence) => ({
        file: evidence.file,
        line: evidence.line,
        code_quote: evidence.codeQuote,
        explanation_ko: evidence.explanationKo,
      })),
    })),
    verifications: envelope.verifications.map((verification) => ({
      candidate_id: verification.candidateId,
      verdict: verification.verdict,
      reason_ko: verification.reasonKo,
      evidence: verification.evidence.map((evidence) => ({
        file: evidence.file,
        line: evidence.line,
        code_quote: evidence.codeQuote,
        explanation_ko: evidence.explanationKo,
      })),
    })),
  };
}

/**
 * Decode and revalidate cached MiniMax output against the current host ACs.
 * Invalid, stale, or non-canonical cache data is always treated as a miss.
 */
export function decodeReviewGateCache(
  input: string | unknown,
  expectedAcceptanceCriteria: readonly string[],
): MiniMaxReviewGateCacheEnvelope | null {
  const raw = decodeJson(input);
  if (!isRecord(raw) || !hasExactKeys(raw, ROOT_KEYS)) {
    return null;
  }
  if (
    raw.schemaVersion !== REVIEW_GATE_CACHE_SCHEMA_VERSION ||
    !Array.isArray(raw.acceptance_coverage) ||
    !Array.isArray(raw.candidates) ||
    !Array.isArray(raw.verifications)
  ) {
    return null;
  }
  if (
    !cachedCoverageMatchesHost(raw.acceptance_coverage, expectedAcceptanceCriteria) ||
    !cachedCandidateCriteriaMatchHost(raw.candidates, expectedAcceptanceCriteria)
  ) {
    return null;
  }

  const review = parseMiniMaxReviewPayload(
    {
      acceptance_coverage: raw.acceptance_coverage,
      candidates: raw.candidates,
    },
    { expectedAcceptanceCriteria },
  );
  if (!review.ok) {
    return null;
  }

  const verification = parseMiniMaxVerificationPayload(
    { verifications: raw.verifications },
    {
      expectedCandidates: review.value.candidates.map(({ candidateId, kind }) => ({
        candidateId,
        kind,
      })),
    },
  );
  if (!verification.ok) {
    return null;
  }

  return {
    schemaVersion: REVIEW_GATE_CACHE_SCHEMA_VERSION,
    acceptanceCoverage: review.value.acceptanceCoverage,
    candidates: review.value.candidates,
    verifications: verification.value.verifications,
  };
}

function cachedCoverageMatchesHost(
  coverage: readonly unknown[],
  expectedAcceptanceCriteria: readonly string[],
): boolean {
  return (
    coverage.length === expectedAcceptanceCriteria.length &&
    coverage.every((entry, index) =>
      isRecord(entry) &&
      entry.criterion_id === `AC-${index + 1}` &&
      entry.acceptance_criterion === expectedAcceptanceCriteria[index]
    )
  );
}

function cachedCandidateCriteriaMatchHost(
  candidates: readonly unknown[],
  expectedAcceptanceCriteria: readonly string[],
): boolean {
  return candidates.every((candidate) => {
    if (!isRecord(candidate) || candidate.kind !== "missing_acceptance_test") {
      return true;
    }
    if (typeof candidate.criterion_id !== "string") {
      return false;
    }
    const match = /^AC-([1-9]\d*)$/u.exec(candidate.criterion_id);
    if (!match) {
      return false;
    }
    const criterionIndex = Number(match[1]) - 1;
    return candidate.acceptance_criterion === expectedAcceptanceCriteria[criterionIndex];
  });
}

function decodeJson(input: unknown): unknown {
  if (typeof input !== "string") {
    return input;
  }
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}
