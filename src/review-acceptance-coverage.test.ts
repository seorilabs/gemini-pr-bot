import assert from "node:assert/strict";
import test from "node:test";
import type { MiniMaxAcceptanceCoverage } from "./minimax-review.js";
import {
  evaluateReviewAcceptanceCoverage,
  normalizeReviewAcceptanceEvidence,
} from "./review-acceptance-coverage.js";
import type { ReviewGroundingContext } from "./review-grounding.js";

function context(
  currentHeadFileContents: Record<string, string> = {},
  visibleChangedPatches: Record<string, string> = {},
): ReviewGroundingContext {
  return { currentHeadFileContents, visibleChangedPatches };
}

function coverage(
  acceptanceCriterion: string,
  overrides: Partial<MiniMaxAcceptanceCoverage> = {},
): MiniMaxAcceptanceCoverage {
  return {
    criterionId: "AC-1",
    acceptanceCriterion,
    status: "covered",
    testEvidence: null,
    ...overrides,
  };
}

test("명시적 인수조건이 없으면 테스트 근거 없이 완료된다", () => {
  const result = evaluateReviewAcceptanceCoverage(context(), [], []);

  assert.equal(result.complete, true);
  assert.deepEqual([...result.groundedAcceptanceCriteria], []);
  assert.deepEqual(result.validationErrors, []);
});

test("명시적으로 수동 검증을 요구하는 인수조건은 비차단이다", () => {
  for (const criterion of [
    "수동으로 화면을 확인한다.",
    "직접 확인 후 승인한다.",
    "육안으로 색상을 비교한다.",
    "실기기에서 진동을 확인한다.",
    "Manual QA is required.",
    "Visual inspection is required.",
    "Check this on a real device.",
  ]) {
    const result = evaluateReviewAcceptanceCoverage(context(), [criterion], []);
    assert.equal(result.complete, true, criterion);
    assert.deepEqual(result.validationErrors, [], criterion);
  }
});

test("missing과 unknown 커버리지는 완료로 판정하지 않는다", () => {
  const criterion = "저장 후 다시 열어도 값이 유지된다.";

  for (const status of ["missing", "unknown"] as const) {
    const result = evaluateReviewAcceptanceCoverage(
      context(),
      [criterion],
      [coverage(criterion, { status })],
    );
    assert.equal(result.complete, false, status);
    assert.deepEqual(result.validationErrors, [`AC-1: acceptance_coverage_${status}`]);
  }
});

test("host AC의 ID 순서와 원문이 정확히 일치해야 한다", () => {
  const criteria = ["첫 번째 값을 저장한다.", "두 번째 값을 복원한다."];
  const result = evaluateReviewAcceptanceCoverage(context(), criteria, [
    coverage(criteria[0]!, { criterionId: "AC-2" }),
    coverage("바꿔 쓴 인수조건", { criterionId: "AC-2" }),
  ]);

  assert.equal(result.complete, false);
  assert.deepEqual(result.validationErrors, [
    "AC-1: acceptance_coverage_identity_mismatch",
    "AC-2: acceptance_coverage_identity_mismatch",
  ]);
});

test("조작된 파일 또는 current HEAD와 다른 assertion 라인은 거부한다", () => {
  const criterion = "Calling `restartLoad` keeps `savedValue`.";
  const file = "src/save.test.ts";
  const source = [
    'test("restartLoad keeps savedValue", () => {',
    "  assert.equal(restartLoad(), savedValue);",
    "});",
  ].join("\n");
  const evidence = {
    file,
    line: 2,
    testName: "restartLoad keeps savedValue",
    assertionQuote: "assert.equal(restartLoad(), savedValue);",
    explanationKo: "재실행 후 저장값을 직접 비교합니다.",
  };

  const fabricatedPath = evaluateReviewAcceptanceCoverage(
    context({ [file]: source }),
    [criterion],
    [coverage(criterion, { testEvidence: { ...evidence, file: "src/fake.test.ts" } })],
  );
  const fabricatedLine = evaluateReviewAcceptanceCoverage(
    context({ [file]: source }),
    [criterion],
    [coverage(criterion, {
      testEvidence: { ...evidence, assertionQuote: "assert.equal(restartLoad(), otherValue);" },
    })],
  );

  assert.equal(fabricatedPath.complete, false);
  assert.equal(fabricatedLine.complete, false);
  assert.deepEqual(fabricatedPath.validationErrors, ["AC-1: test_evidence_line_not_grounded"]);
  assert.deepEqual(fabricatedLine.validationErrors, ["AC-1: test_evidence_line_not_grounded"]);
});

test("이름 있는 실행 테스트의 실제 assertion은 인수조건을 충족한다", () => {
  const criterion = "Calling `restartLoad` keeps `savedValue`.";
  const file = "src/save.test.ts";
  const source = [
    'test("restartLoad keeps savedValue", () => {',
    "  const restored = restartLoad();",
    "  assert.equal(restored, savedValue);",
    "});",
  ].join("\n");
  const result = evaluateReviewAcceptanceCoverage(
    context({ [file]: source }, { [file]: "@@ -0,0 +1,4 @@\n+test(...)" }),
    [criterion],
    [coverage(criterion, {
      testEvidence: {
        file,
        line: 3,
        testName: "restartLoad keeps savedValue",
        assertionQuote: "assert.equal(restored, savedValue);",
        explanationKo: "재실행 결과와 저장값을 직접 비교합니다.",
      },
    })],
  );

  assert.equal(result.complete, true);
  assert.deepEqual(
    [...result.groundedAcceptanceCriteria],
    [normalizeReviewAcceptanceEvidence(criterion)],
  );
  assert.deepEqual(result.validationErrors, []);
});

test("skip된 테스트와 무의미한 assertion은 근거가 아니다", () => {
  const skippedCriterion = "Calling `restartLoad` keeps `savedValue`.";
  const skippedFile = "src/skipped.test.ts";
  const skippedSource = [
    'test.skip("restartLoad keeps savedValue", () => {',
    "  assert.equal(restartLoad(), savedValue);",
    "});",
  ].join("\n");
  const skipped = evaluateReviewAcceptanceCoverage(
    context({ [skippedFile]: skippedSource }),
    [skippedCriterion],
    [coverage(skippedCriterion, {
      testEvidence: {
        file: skippedFile,
        line: 2,
        testName: "restartLoad keeps savedValue",
        assertionQuote: "assert.equal(restartLoad(), savedValue);",
        explanationKo: "재실행 결과를 비교합니다.",
      },
    })],
  );

  const vacuousCriterion = "저장 후 값이 유지된다.";
  const vacuousFile = "src/vacuous.test.ts";
  const vacuousSource = [
    'test("저장 후 값이 유지된다", () => {',
    "  assert.equal(1, 1);",
    "});",
  ].join("\n");
  const vacuous = evaluateReviewAcceptanceCoverage(
    context({ [vacuousFile]: vacuousSource }),
    [vacuousCriterion],
    [coverage(vacuousCriterion, {
      testEvidence: {
        file: vacuousFile,
        line: 2,
        testName: "저장 후 값이 유지된다",
        assertionQuote: "assert.equal(1, 1);",
        explanationKo: "상수를 비교합니다.",
      },
    })],
  );

  assert.equal(skipped.complete, false);
  assert.equal(vacuous.complete, false);
  assert.deepEqual(skipped.validationErrors, ["AC-1: test_evidence_not_grounded"]);
  assert.deepEqual(vacuous.validationErrors, ["AC-1: test_evidence_not_grounded"]);
});
