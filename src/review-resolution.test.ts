import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveReviewGateSecondOpinion,
  shouldRunReviewGateSecondOpinion,
} from "./review-resolution.js";
import { evaluateReviewGate, type ReviewGateEvaluation } from "./review-gate.js";

const OPTIONS = { testInventoryComplete: true };

test("a strong second-opinion PASS resolves a primary abstention", () => {
  assert.equal(
    resolveReviewGateSecondOpinion(abstainEvaluation(), passEvaluation()).decision.verdict,
    "PASS",
  );
});

test("a second-opinion blocker cannot block when the primary abstained", () => {
  const result = resolveReviewGateSecondOpinion(abstainEvaluation(), missingTestsEvaluation());
  assert.equal(result.decision.verdict, "ABSTAIN");
  assert.equal(result.decision.failureKind, null);
});

test("the same exhaustive missing-test result from both models remains blocking", () => {
  const result = resolveReviewGateSecondOpinion(
    missingTestsEvaluation(),
    missingTestsEvaluation(),
  );
  assert.equal(result.decision.verdict, "FAIL");
  assert.equal(result.decision.failureKind, "missing_tests");
});

test("model disagreement becomes an approval-free internal abstention", () => {
  const result = resolveReviewGateSecondOpinion(missingTestsEvaluation(), passEvaluation());
  assert.equal(result.decision.verdict, "ABSTAIN");
  assert.match(result.decision.reasons[0] || "", /approval을 제출하지 않습니다/u);
});

test("host-confirmed missing tests remain blocking when second opinion is disabled", () => {
  assert.equal(shouldRunReviewGateSecondOpinion(missingTestsEvaluation(), false), false);
  assert.equal(shouldRunReviewGateSecondOpinion(missingTestsEvaluation(), true), true);
  assert.equal(shouldRunReviewGateSecondOpinion(abstainEvaluation(), false), true);
});

function passEvaluation(): ReviewGateEvaluation {
  return evaluateReviewGate(JSON.stringify(wireResponse("covered")), OPTIONS);
}

function missingTestsEvaluation(): ReviewGateEvaluation {
  return evaluateReviewGate(JSON.stringify(wireResponse("missing")), OPTIONS);
}

function abstainEvaluation(): ReviewGateEvaluation {
  return evaluateReviewGate(
    JSON.stringify({
      ...wireResponse("covered"),
      context_status: "insufficient",
      abstain_reasons: ["근거 부족"],
    }),
    OPTIONS,
  );
}

function wireResponse(coverage: "covered" | "missing"): Record<string, unknown> {
  return {
    context_status: "sufficient",
    test_inventory_complete: true,
    criteria: [
      {
        id: "AC-1",
        source_quote: "뒤로가기를 누르면 일시정지 메뉴가 열린다.",
        testability: "automated",
        coverage,
        test_evidence: coverage === "covered"
          ? {
              file: "tests/pause_test.gd",
              test_name: "test_back_opens_pause",
              assertion_quote: "assert_true(pause_menu.visible)",
            }
          : null,
      },
    ],
    fatal_blockers: [],
    abstain_reasons: [],
  };
}
