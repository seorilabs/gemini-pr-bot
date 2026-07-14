import { sameFatalBlockerSet } from "./review-grounding.js";
import type { ReviewGateEvaluation } from "./review-gate.js";

export function resolveReviewGateSecondOpinion(
  primary: ReviewGateEvaluation,
  secondOpinion: ReviewGateEvaluation,
): ReviewGateEvaluation {
  if (primary.decision.verdict === "ABSTAIN") {
    if (secondOpinion.decision.verdict === "PASS") {
      return secondOpinion;
    }
    return inconclusive(
      primary,
      "2차 모델만 차단 근거를 제시했거나 판정을 확정하지 못해 병합을 차단하지 않습니다.",
    );
  }

  if (primary.decision.verdict === "FAIL" && secondOpinion.decision.verdict === "FAIL") {
    const fatalConfirmed =
      primary.decision.failureKind === "fatal" &&
      secondOpinion.decision.failureKind === "fatal" &&
      sameFatalBlockerSet(
        primary.decision.fatalBlockers,
        secondOpinion.decision.fatalBlockers,
      );
    const missingTestsConfirmed =
      primary.decision.failureKind === "missing_tests" &&
      secondOpinion.decision.failureKind === "missing_tests" &&
      sameMissingCriteriaSet(
        primary.decision.missingCriteria,
        secondOpinion.decision.missingCriteria,
      );
    if (fatalConfirmed || missingTestsConfirmed) {
      return primary;
    }
  }

  return inconclusive(
    primary,
    "1차와 2차 모델의 판정이 일치하지 않아 병합을 차단하지 않습니다.",
  );
}

function sameMissingCriteriaSet(
  left: ReviewGateEvaluation["decision"]["missingCriteria"],
  right: ReviewGateEvaluation["decision"]["missingCriteria"],
): boolean {
  const normalize = (value: string): string =>
    value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
  const normalized = (criteria: typeof left): string[] =>
    criteria.map((criterion) => normalize(criterion.sourceQuote)).sort();
  return left.length > 0 && JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

function inconclusive(
  evaluation: ReviewGateEvaluation,
  reason: string,
): ReviewGateEvaluation {
  return {
    ...evaluation,
    decision: {
      verdict: "ABSTAIN",
      failureKind: null,
      reasons: [reason],
      missingCriteria: [],
      fatalBlockers: [],
    },
  };
}
