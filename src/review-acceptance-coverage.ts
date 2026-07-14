import type { MiniMaxAcceptanceCoverage } from "./minimax-review.js";
import type { ReviewGateCriterion, ReviewGateTestEvidence } from "./review-gate.js";
import {
  isGroundedTestEvidence,
  type ReviewGroundingContext,
} from "./review-grounding.js";

export type ReviewAcceptanceCoverageEvaluation = {
  complete: boolean;
  groundedAcceptanceCriteria: Set<string>;
  validationErrors: string[];
};

const MANUAL_ACCEPTANCE_CRITERION_PATTERN =
  /수동|직접\s*확인|육안|실(?:제\s*)?기기|manual|visual|real\s+device/iu;

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

    const rawLine = context.currentHeadFileContents[item.testEvidence.file]
      ?.split(/\r?\n/gu)[item.testEvidence.line - 1];
    if (
      rawLine === undefined ||
      normalizeReviewAcceptanceEvidence(rawLine) !==
        normalizeReviewAcceptanceEvidence(item.testEvidence.assertionQuote)
    ) {
      validationErrors.push(`${expectedId}: test_evidence_line_not_grounded`);
      continue;
    }

    const criterion: ReviewGateCriterion = {
      id: item.criterionId,
      sourceQuote: source,
      testability: "automated",
      coverage: "covered",
      testEvidence: {
        file: item.testEvidence.file,
        testName: item.testEvidence.testName,
        assertionQuote: item.testEvidence.assertionQuote,
      },
    };
    const evidence: ReviewGateTestEvidence = criterion.testEvidence!;
    if (!isGroundedTestEvidence(context, criterion, evidence)) {
      validationErrors.push(`${expectedId}: test_evidence_not_grounded`);
      continue;
    }

    groundedAcceptanceCriteria.add(normalizeReviewAcceptanceEvidence(source));
  }

  return {
    complete: validationErrors.length === 0,
    groundedAcceptanceCriteria,
    validationErrors,
  };
}

export function isExplicitlyManualAcceptanceCriterion(source: string): boolean {
  return MANUAL_ACCEPTANCE_CRITERION_PATTERN.test(source);
}

export function normalizeReviewAcceptanceEvidence(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}
