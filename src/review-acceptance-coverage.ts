import type { MiniMaxAcceptanceCoverage } from "./minimax-review.js";
import type { ReviewGateCriterion, ReviewGateTestEvidence } from "./review-gate.js";
import {
  isGroundedTestExecutionEvidence,
  isGroundedTestEvidence,
  isGroundedTestEvidenceBundle,
  isGroundedSourceContractEvidence,
  isGroundedTestMatrixEvidence,
  type ReviewGroundingContext,
} from "./review-grounding.js";

export type ReviewAcceptanceCoverageEvaluation = {
  complete: boolean;
  groundedAcceptanceCriteria: Set<string>;
  groundedTestEvidence: Map<string, GroundedAcceptanceTestEvidence>;
  validationErrors: string[];
};

export type GroundedAcceptanceTestEvidence = {
  file: string;
  line: number;
  testName: string;
  kind: "test" | "source";
};

const MANUAL_ACCEPTANCE_CRITERION_PATTERN =
  /수동|시각\s*(?:검증|확인)|직접\s*확인|육안|실(?:제\s*)?기기|manual|visual|real\s+device/iu;

/**
 * Evaluates MiniMax's acceptance-test coverage only against host-owned inputs.
 * Model-declared coverage is never enough by itself: an automated criterion
 * needs an exact current-HEAD assertion line inside a real executable test.
 */
export function evaluateReviewAcceptanceCoverage(
  context: ReviewGroundingContext,
  explicitAcceptanceCriteria: readonly string[],
  coverage: readonly MiniMaxAcceptanceCoverage[],
): ReviewAcceptanceCoverageEvaluation {
  const groundedAcceptanceCriteria = new Set<string>();
  const groundedTestEvidence = new Map<string, GroundedAcceptanceTestEvidence>();
  const validationErrors: string[] = [];

  for (let index = 0; index < explicitAcceptanceCriteria.length; index += 1) {
    const source = explicitAcceptanceCriteria[index]!;
    if (isExplicitlyManualAcceptanceCriterion(source)) {
      continue;
    }

    const expectedId = `AC-${index + 1}`;
    const item = coverage[index];
    if (
      !item ||
      item.criterionId !== expectedId ||
      item.acceptanceCriterion !== source
    ) {
      validationErrors.push(`${expectedId}: acceptance_coverage_identity_mismatch`);
      continue;
    }
    if (item.status !== "covered") {
      validationErrors.push(`${expectedId}: acceptance_coverage_${item.status}`);
      continue;
    }
    if (!item.testEvidence) {
      validationErrors.push(`${expectedId}: test_evidence_required`);
      continue;
    }
    const evidenceItems = [item.testEvidence, ...(item.supportingTestEvidence || [])];
    const uniqueEvidence = new Set(
      evidenceItems.map((evidence) =>
        `${evidence.file}:${evidence.testName}:${normalizeReviewAcceptanceEvidence(evidence.assertionQuote)}`),
    );
    if (
      evidenceItems.length > 4 ||
      uniqueEvidence.size !== evidenceItems.length
    ) {
      validationErrors.push(`${expectedId}: test_evidence_bundle_invalid`);
      continue;
    }
    const hostCandidates = evidenceItems.map((evidence) =>
      context.evidenceCandidates?.find((candidate) =>
        candidate.file === evidence.file &&
        candidate.testName === evidence.testName &&
        normalizeReviewAcceptanceEvidence(candidate.quote) ===
          normalizeReviewAcceptanceEvidence(evidence.assertionQuote)),
    );
    if (context.evidenceCandidates && hostCandidates.some((candidate) => !candidate)) {
      validationErrors.push(`${expectedId}: test_evidence_not_in_host_inventory`);
      continue;
    }
    const groundedLines = evidenceItems.map((evidence, evidenceIndex) =>
      hostCandidates[evidenceIndex]?.line ?? resolveCurrentHeadEvidenceLine(
        context.currentHeadFileContents[evidence.file],
        evidence.assertionQuote,
        evidence.line,
      ),
    );
    if (groundedLines.some((line) => line === null)) {
      validationErrors.push(`${expectedId}: test_evidence_line_not_grounded`);
      continue;
    }
    const criterionBase: Omit<ReviewGateCriterion, "testEvidence"> = {
      id: item.criterionId,
      sourceQuote: source,
      testability: "automated",
      coverage: "covered",
    };
    const gateEvidence: ReviewGateTestEvidence[] = evidenceItems.map((evidence) => ({
      file: evidence.file,
      testName: evidence.testName,
      assertionQuote: evidence.assertionQuote,
      explanationKo: evidence.explanationKo,
    }));
    const compositeValidationError = compositeAcceptanceValidationError(
      source,
      gateEvidence,
    );
    if (compositeValidationError) {
      validationErrors.push(`${expectedId}: ${compositeValidationError}`);
      continue;
    }
    const groundedKinds = gateEvidence.map((evidence) => {
      const criterion: ReviewGateCriterion = { ...criterionBase, testEvidence: evidence };
      if (
        isGroundedTestEvidence(context, criterion, evidence) ||
        isGroundedTestExecutionEvidence(context, criterion, evidence) ||
        isGroundedTestMatrixEvidence(context, criterion, evidence)
      ) {
        return "test" as const;
      }
      return isGroundedSourceContractEvidence(context, criterion, evidence)
        ? "source" as const
        : null;
    });
    const bundleCriterion: ReviewGateCriterion = {
      ...criterionBase,
      testEvidence: gateEvidence[0]!,
    };
    const groundedAsBundle = isGroundedTestEvidenceBundle(
      context,
      bundleCriterion,
      gateEvidence,
    );
    const primaryGroundedIndex = groundedKinds.findIndex(Boolean);
    const groundedAsTest = primaryGroundedIndex >= 0
      ? groundedKinds[primaryGroundedIndex] === "test"
      : groundedAsBundle;
    const groundedAsSource = primaryGroundedIndex >= 0 &&
      groundedKinds[primaryGroundedIndex] === "source";
    if (!groundedAsTest && !groundedAsSource) {
      validationErrors.push(`${expectedId}: test_evidence_not_grounded`);
      continue;
    }

    const normalizedCriterion = normalizeReviewAcceptanceEvidence(source);
    groundedAcceptanceCriteria.add(normalizedCriterion);
    const publicEvidenceIndex = primaryGroundedIndex >= 0 ? primaryGroundedIndex : 0;
    const publicEvidence = evidenceItems[publicEvidenceIndex]!;
    groundedTestEvidence.set(normalizedCriterion, {
      file: publicEvidence.file,
      line: groundedLines[publicEvidenceIndex]!,
      testName: publicEvidence.testName,
      kind: groundedAsSource ? "source" : "test",
    });
  }

  return {
    complete: validationErrors.length === 0,
    groundedAcceptanceCriteria,
    groundedTestEvidence,
    validationErrors,
  };
}

/**
 * Model line numbers are hints, not identity. Rebind an exact assertion quote
 * to the current HEAD when it occurs once, while rejecting fabricated or
 * ambiguous quotes.
 */
function resolveCurrentHeadEvidenceLine(
  content: string | undefined,
  assertionQuote: string,
  proposedLine: number,
): number | null {
  if (!content) {
    return null;
  }
  const expected = normalizeReviewAcceptanceEvidence(assertionQuote);
  const lines = content.split(/\r?\n/gu);
  const proposed = lines[proposedLine - 1];
  if (proposed !== undefined && normalizedEvidenceLine(proposed) === normalizedEvidenceLine(expected)) {
    return proposedLine;
  }

  const matches: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (normalizedEvidenceLine(lines[index] || "") === normalizedEvidenceLine(expected)) {
      matches.push(index + 1);
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

function normalizedEvidenceLine(value: string): string {
  return normalizeReviewAcceptanceEvidence(value)
    .replace(/,$/u, "")
    .replace(/\\$/u, "")
    .trim();
}

export function isExplicitlyManualAcceptanceCriterion(source: string): boolean {
  return MANUAL_ACCEPTANCE_CRITERION_PATTERN.test(source);
}

export function normalizeReviewAcceptanceEvidence(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

function compositeAcceptanceValidationError(
  source: string,
  evidence: readonly ReviewGateTestEvidence[],
): string | null {
  const normalizedSource = normalizeReviewAcceptanceEvidence(source);
  const requiresPlanOutputs =
    /\bplan\s*\(/iu.test(normalizedSource) &&
    /\bsim(?:_seconds)?\s*=\s*28800/iu.test(normalizedSource) &&
    /\brollover(?:_seconds)?\s*=\s*0/iu.test(normalizedSource);
  if (!requiresPlanOutputs) {
    return null;
  }
  const assertionLines = evidence
    .map((item) => normalizeReviewAcceptanceEvidence(item.assertionQuote))
    .filter((line) => /(?:\b|_)(?:assert\w*|expect|check\w*)\s*\(/iu.test(line));
  const hasSimAssertion = assertionLines.some((line) =>
    /\bsim(?:_seconds|_\w*)?\b/iu.test(line) &&
    /(?:==|equal\w*\s*\().*\b28800(?:\.0)?\b/iu.test(line));
  const hasRolloverAssertion = assertionLines.some((line) =>
    /\brollover(?:_seconds|_\w*)?\b/iu.test(line) &&
    /(?:==|equal\w*\s*\().*\b0(?:\.0)?\b/iu.test(line));
  if (!hasSimAssertion) {
    return "test_evidence_missing_sim_assertion";
  }
  return hasRolloverAssertion ? null : "test_evidence_missing_rollover_assertion";
}

/**
 * A grounded PASS for an unchanged HEAD is monotonic. A later model turn may
 * add better evidence, but it cannot erase host-validated evidence from an
 * earlier run of the same prompt contract and commit.
 */
export function mergeStickyAcceptanceCoverage(
  explicitAcceptanceCriteria: readonly string[],
  current: readonly MiniMaxAcceptanceCoverage[],
  currentGrounded: ReadonlySet<string>,
  prior: readonly MiniMaxAcceptanceCoverage[],
  priorGrounded: ReadonlySet<string>,
): MiniMaxAcceptanceCoverage[] {
  return explicitAcceptanceCriteria.map((criterion, index) => {
    const normalized = normalizeReviewAcceptanceEvidence(criterion);
    const currentItem = current[index];
    const priorItem = prior[index];
    if (currentItem && currentGrounded.has(normalized)) {
      return currentItem;
    }
    if (
      priorItem &&
      priorItem.criterionId === `AC-${index + 1}` &&
      priorItem.acceptanceCriterion === criterion &&
      priorGrounded.has(normalized)
    ) {
      return priorItem;
    }
    return currentItem || {
      criterionId: `AC-${index + 1}`,
      acceptanceCriterion: criterion,
      status: "unknown",
      testEvidence: null,
      supportingTestEvidence: [],
    };
  });
}
