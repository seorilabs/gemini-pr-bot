import assert from "node:assert/strict";
import test from "node:test";
import type {
  MiniMaxAcceptanceCoverage,
  MiniMaxCandidateVerification,
  MiniMaxReviewCandidate,
} from "./minimax-review.js";
import { buildReviewGateDisclosure } from "./review-gate-disclosure.js";
import type { ReviewGatePipelineResult } from "./review-gate-pipeline.js";

const AC_1 = "앱을 다시 열어도 기존 세션이 유지된다.";
const AC_2 = "네트워크가 끊겨도 작성 중인 내용이 보존된다.";

test("부분 보류 결과는 통과한 인수조건과 애매한 인수조건을 분리한다", () => {
  const disclosure = buildReviewGateDisclosure({
    explicitAcceptanceCriteria: [AC_1, AC_2],
    acceptanceCoverage: [covered("AC-1", AC_1), unknown("AC-2", AC_2)],
    groundedAcceptanceCriteria: new Set([AC_1.toLowerCase()]),
    coverageValidationErrors: ["AC-2: acceptance_coverage_unknown"],
    fatalContextComplete: true,
    pipeline: pipeline(),
    candidates: [],
    verifications: [],
    unconfirmedOpenFindings: [],
  });

  assert.deepEqual(disclosure.coveredCriteria, [{
    criterionId: "AC-1",
    acceptanceCriterion: AC_1,
    file: "src/session.test.ts",
    line: 27,
    testName: "재실행 후 기존 세션을 복원한다",
    evidenceKind: "test",
  }]);
  assert.equal(disclosure.fatalCheckPassed, true);
  assert.equal(disclosure.abstainItems.length, 1);
  assert.match(disclosure.abstainItems[0]?.label || "", /AC-2/);
  assert.match(disclosure.abstainItems[0]?.reason || "", /커버리지를 확정하지 못했습니다/);
  assert.match(disclosure.abstainItems[0]?.requiredAction || "", /테스트의 파일/);
});

test("복합 plan 근거에서 빠진 rollover assertion을 Contributor에게 정확히 요청한다", () => {
  const criterion = "plan 결과가 sim=28800, rollover=0이다.";
  const disclosure = buildReviewGateDisclosure({
    explicitAcceptanceCriteria: [criterion],
    acceptanceCoverage: [covered("AC-1", criterion)],
    groundedAcceptanceCriteria: new Set(),
    coverageValidationErrors: ["AC-1: test_evidence_missing_rollover_assertion"],
    fatalContextComplete: true,
    pipeline: pipeline(),
    candidates: [],
    verifications: [],
    unconfirmedOpenFindings: [],
  });

  assert.match(disclosure.abstainItems[0]?.reason || "", /sim=28800만 확인/);
  assert.match(
    disclosure.abstainItems[0]?.requiredAction || "",
    /rollover_seconds == 0.*supporting evidence/,
  );
});

test("locale 묶음에서 빠진 en-US assertion을 Contributor에게 정확히 요청한다", () => {
  const criterion =
    "신규 라벨을 ko-KR/en-US 및 나머지 6개 로케일에 추가하고 `pnpm check:i18n`이 통과한다.";
  const disclosure = buildReviewGateDisclosure({
    explicitAcceptanceCriteria: [criterion],
    acceptanceCoverage: [covered("AC-1", criterion)],
    groundedAcceptanceCriteria: new Set(),
    coverageValidationErrors: ["AC-1: test_evidence_missing_en_us_catalog_assertion"],
    fatalContextComplete: true,
    pipeline: pipeline(),
    candidates: [],
    verifications: [],
    unconfirmedOpenFindings: [],
  });

  assert.match(disclosure.abstainItems[0]?.reason || "", /en-US.*assertion/);
  assert.match(disclosure.abstainItems[0]?.requiredAction || "", /en-US.*supporting evidence/);
});

test("독립 검증이 불확실한 후보는 후보 제목과 불확실 범위를 공개한다", () => {
  const candidate = fatalCandidate();
  const disclosure = buildReviewGateDisclosure({
    explicitAcceptanceCriteria: [],
    acceptanceCoverage: [],
    groundedAcceptanceCriteria: new Set(),
    coverageValidationErrors: [],
    fatalContextComplete: true,
    pipeline: pipeline({
      rejected: [{
        candidateId: "C-1",
        code: "verification_not_confirmed",
        reason: "내부 모델 사유는 공개하지 않습니다.",
      }],
    }),
    candidates: [candidate],
    verifications: [{
      candidateId: "C-1",
      verdict: "uncertain",
      reasonKo: "호출 경로가 더 필요합니다.",
      evidence: [],
    }],
    unconfirmedOpenFindings: [],
  });

  assert.equal(disclosure.fatalCheckPassed, false);
  assert.match(disclosure.abstainItems[0]?.label || "", /치명 결함 후보 C-1 · 저장 경로가 중단됩니다/);
  assert.match(disclosure.abstainItems[0]?.reason || "", /확정도 기각도 하지 못했습니다/);
  assert.doesNotMatch(disclosure.abstainItems[0]?.reason || "", /호출 경로/);
});

test("불완전한 코드 문맥과 검증 결과 구조 오류는 각각 보류 사유로 표시한다", () => {
  const disclosure = buildReviewGateDisclosure({
    explicitAcceptanceCriteria: [],
    acceptanceCoverage: [],
    groundedAcceptanceCriteria: new Set(),
    coverageValidationErrors: [],
    fatalContextComplete: false,
    pipeline: pipeline({
      inputValid: false,
      rejected: [{
        candidateId: "C-1",
        code: "verification_set_mismatch",
        reason: "내부 진단",
      }],
    }),
    candidates: [],
    verifications: [],
    unconfirmedOpenFindings: [],
  });

  assert.equal(disclosure.fatalCheckPassed, false);
  assert.deepEqual(
    disclosure.abstainItems.map((item) => item.label),
    ["자동 검증 결과 구조", "치명 결함 검사"],
  );
  assert.match(disclosure.abstainItems[0]?.reason || "", /일대일로 대응하지 않아/);
  assert.match(disclosure.abstainItems[1]?.reason || "", /코드 또는 패치 문맥/);
});

test("구조 오류에 후보별 진단이 없어도 공개용 보류 사유를 남긴다", () => {
  const disclosure = buildReviewGateDisclosure({
    explicitAcceptanceCriteria: [],
    acceptanceCoverage: [],
    groundedAcceptanceCriteria: new Set(),
    coverageValidationErrors: [],
    fatalContextComplete: true,
    pipeline: pipeline({ inputValid: false }),
    candidates: [],
    verifications: [],
    unconfirmedOpenFindings: [],
  });

  assert.equal(disclosure.abstainItems.length, 1);
  assert.equal(disclosure.abstainItems[0]?.label, "자동 검증 결과 구조");
  assert.match(disclosure.abstainItems[0]?.reason || "", /호스트 검증 규칙/);
});

function covered(criterionId: string, acceptanceCriterion: string): MiniMaxAcceptanceCoverage {
  return {
    criterionId,
    acceptanceCriterion,
    status: "covered",
    testEvidence: {
      file: "src/session.test.ts",
      line: 27,
      testName: "재실행 후 기존 세션을 복원한다",
      assertionQuote: "assert.equal(restored, previous);",
      explanationKo: "현재 세션 복원 동작을 검증합니다.",
    },
  };
}

function unknown(criterionId: string, acceptanceCriterion: string): MiniMaxAcceptanceCoverage {
  return {
    criterionId,
    acceptanceCriterion,
    status: "unknown",
    testEvidence: null,
  };
}

function pipeline(overrides: Partial<ReviewGatePipelineResult> = {}): ReviewGatePipelineResult {
  return {
    inputValid: true,
    accepted: [],
    rejected: [],
    ledgerCandidates: [],
    publicFindings: [],
    ...overrides,
  };
}

function fatalCandidate(): MiniMaxReviewCandidate {
  return {
    candidateId: "C-1",
    kind: "fatal_defect",
    titleKo: "저장 경로가 중단됩니다",
    problemKo: "저장 요청에서 실행 경로가 중단될 가능성이 있습니다.",
    triggerKo: "사용자가 저장 버튼을 누릅니다.",
    impactKo: "작성한 내용이 저장되지 않을 수 있습니다.",
    fixKo: "저장 호출 경로를 다시 확인해야 합니다.",
    file: "src/save.ts",
    symbol: "saveDraft",
    line: 42,
    codeQuote: "throw error;",
    fatalOutcome: "deterministic_crash",
    criterionId: null,
    acceptanceCriterion: null,
    testSearchSummaryKo: null,
    evidence: [],
  };
}
