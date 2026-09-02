/**
 * Candidate extraction for the Seori review gate as two isolated MiniMax
 * requests.
 *
 * The former single request classified every acceptance criterion and hunted
 * fatal defects over the whole PR diff at once. MiniMax-M3 latency and
 * max_tokens truncation follow the tokens it generates (thinking included), so
 * large coverage output plus large diff input regularly crossed the request
 * timeout. The coverage pass now sees only the criteria and the host evidence
 * inventory; the defect pass sees the diff and current-HEAD code but produces
 * at most two candidates. One failing pass degrades only its own half.
 */
import type {
  MiniMaxAcceptanceCoverage,
  MiniMaxReviewCandidate,
  MiniMaxReviewResult,
} from "./minimax-review.js";
import { MINIMAX_REVIEW_MAX_CANDIDATES } from "./minimax-review.js";
import { VERIFICATION_CALL_FAILED_PREFIX } from "./review-gate-verifier-input.js";

export const COVERAGE_CALL_FAILED_PREFIX = "coverage_call_failed:";
export const DEFECT_CALL_FAILED_PREFIX = "defect_call_failed:";

/** validation_errors entries that mark a run as degraded by a failed model call. */
const GATE_CALL_FAILED_PREFIXES = [
  COVERAGE_CALL_FAILED_PREFIX,
  DEFECT_CALL_FAILED_PREFIX,
  VERIFICATION_CALL_FAILED_PREFIX,
] as const;

export type ReviewGateExtractionPass = "coverage" | "defect";

export type ReviewGateExtractionFailure = { pass: ReviewGateExtractionPass; message: string };

export type ReviewGateExtraction = {
  acceptanceCoverage: MiniMaxAcceptanceCoverage[];
  /** Fatal candidates first, then missing-test candidates, renumbered C-1..C-N and capped at two. */
  candidates: MiniMaxReviewCandidate[];
  failures: ReviewGateExtractionFailure[];
};

export type ReviewGateExtractionCalls = {
  /** Null when there is no acceptance criterion to classify. */
  coverage: (() => Promise<MiniMaxReviewResult>) | null;
  /** Null when defect review is disabled. */
  defect: (() => Promise<MiniMaxReviewResult>) | null;
};

/**
 * Runs both passes in parallel. A rejected pass becomes host-synthesized
 * contract defaults (every criterion `unknown`, or no fatal candidate) plus a
 * failure entry. Throws only when every pass that ran failed, so the caller's
 * existing "could not produce validated evidence" path still applies.
 */
export async function extractReviewGateCandidatesIsolated(
  explicitAcceptanceCriteria: readonly string[],
  calls: ReviewGateExtractionCalls,
): Promise<ReviewGateExtraction> {
  const [coverage, defect] = await Promise.all([
    settle(calls.coverage),
    settle(calls.defect),
  ]);
  const ran = [coverage, defect].filter((outcome) => outcome !== null);
  const failed = ran.filter((outcome) => outcome!.status === "rejected");
  if (ran.length > 0 && failed.length === ran.length) {
    const messages = [
      coverage?.status === "rejected" ? `coverage: ${errorMessage(coverage.reason)}` : null,
      defect?.status === "rejected" ? `defect: ${errorMessage(defect.reason)}` : null,
    ].filter(Boolean);
    throw new Error(`MiniMax review gate extraction failed: ${messages.join(" | ")}`);
  }

  const failures: ReviewGateExtractionFailure[] = [];
  let acceptanceCoverage: MiniMaxAcceptanceCoverage[] = [];
  let missingTestCandidates: MiniMaxReviewCandidate[] = [];
  if (coverage?.status === "fulfilled") {
    acceptanceCoverage = coverage.value.acceptanceCoverage;
    missingTestCandidates = coverage.value.candidates;
  } else {
    acceptanceCoverage = unknownAcceptanceCoverage(explicitAcceptanceCriteria);
    if (coverage?.status === "rejected") {
      failures.push({ pass: "coverage", message: errorMessage(coverage.reason) });
    }
  }
  let fatalCandidates: MiniMaxReviewCandidate[] = [];
  if (defect?.status === "fulfilled") {
    fatalCandidates = defect.value.candidates;
  } else if (defect?.status === "rejected") {
    failures.push({ pass: "defect", message: errorMessage(defect.reason) });
  }

  return {
    acceptanceCoverage,
    candidates: mergeReviewGateCandidates(fatalCandidates, missingTestCandidates),
    failures,
  };
}

/** Fatal candidates outrank missing-test candidates when the two passes exceed the cap together. */
export function mergeReviewGateCandidates(
  fatalCandidates: readonly MiniMaxReviewCandidate[],
  missingTestCandidates: readonly MiniMaxReviewCandidate[],
): MiniMaxReviewCandidate[] {
  return [...fatalCandidates, ...missingTestCandidates]
    .slice(0, MINIMAX_REVIEW_MAX_CANDIDATES)
    .map((candidate, index) => ({ ...candidate, candidateId: `C-${index + 1}` }));
}

/** Contract-valid coverage rows for a failed coverage pass: nothing is proven, nothing is claimed missing. */
export function unknownAcceptanceCoverage(
  explicitAcceptanceCriteria: readonly string[],
): MiniMaxAcceptanceCoverage[] {
  return explicitAcceptanceCriteria.map((criterion, index) => ({
    criterionId: `AC-${index + 1}`,
    acceptanceCriterion: criterion,
    status: "unknown",
    testEvidence: null,
    supportingTestEvidence: [],
  }));
}

export function formatExtractionFailure(failure: ReviewGateExtractionFailure): string {
  const prefix = failure.pass === "coverage" ? COVERAGE_CALL_FAILED_PREFIX : DEFECT_CALL_FAILED_PREFIX;
  return `${prefix} ${failure.message}`;
}

/** True when a recorded run was degraded by any failed model call and must not be reused as a cache hit. */
export function hasGateCallFailure(validationErrors: readonly string[] | null | undefined): boolean {
  return Boolean(
    validationErrors?.some((entry) => GATE_CALL_FAILED_PREFIXES.some((prefix) => entry.startsWith(prefix))),
  );
}

async function settle<T>(call: (() => Promise<T>) | null): Promise<PromiseSettledResult<T> | null> {
  if (!call) {
    return null;
  }
  const [outcome] = await Promise.allSettled([call()]);
  return outcome!;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
