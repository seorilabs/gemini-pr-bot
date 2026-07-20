import type { MiniMaxAcceptanceCoverage } from "./minimax-review.js";
import type { ReviewGateCriterion, ReviewGateTestEvidence } from "./review-gate.js";
import {
  isGroundedTestExecutionEvidence,
  isGroundedTestEvidence,
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

    const groundedLine = resolveCurrentHeadEvidenceLine(
      context.currentHeadFileContents[item.testEvidence.file],
      item.testEvidence.assertionQuote,
      item.testEvidence.line,
    );
    if (groundedLine === null) {
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
        explanationKo: item.testEvidence.explanationKo,
      },
    };
    const evidence: ReviewGateTestEvidence = criterion.testEvidence!;
    const groundedAsTest =
      isGroundedTestEvidence(context, criterion, evidence) ||
      isGroundedTestExecutionEvidence(context, criterion, evidence) ||
      isGroundedTestMatrixEvidence(context, criterion, evidence);
    const groundedAsSource = isGroundedSourceContractEvidence(context, criterion, evidence);
    if (!groundedAsTest && !groundedAsSource) {
      validationErrors.push(`${expectedId}: test_evidence_not_grounded`);
      continue;
    }

    const normalizedCriterion = normalizeReviewAcceptanceEvidence(source);
    groundedAcceptanceCriteria.add(normalizedCriterion);
    groundedTestEvidence.set(normalizedCriterion, {
      file: item.testEvidence.file,
      line: groundedLine,
      testName: item.testEvidence.testName,
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
