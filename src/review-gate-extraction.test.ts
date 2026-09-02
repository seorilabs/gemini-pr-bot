import assert from "node:assert/strict";
import test from "node:test";

import type { MiniMaxReviewCandidate, MiniMaxReviewResult } from "./minimax-review.js";
import {
  COVERAGE_CALL_FAILED_PREFIX,
  DEFECT_CALL_FAILED_PREFIX,
  extractReviewGateCandidatesIsolated,
  formatExtractionFailure,
  hasGateCallFailure,
  mergeReviewGateCandidates,
  unknownAcceptanceCoverage,
} from "./review-gate-extraction.js";
import { VERIFICATION_CALL_FAILED_PREFIX } from "./review-gate-verifier-input.js";

const CRITERIA = ["정상 진행 tier 1..3 입력에서 보상량이 반환된다.", "빈 점수 목록에서도 평균 계산이 안전하다."];

function candidate(kind: MiniMaxReviewCandidate["kind"], titleKo: string): MiniMaxReviewCandidate {
  return {
    candidateId: "C-1",
    kind,
    titleKo,
    problemKo: "문제",
    triggerKo: "조건",
    impactKo: "영향",
    fixKo: "수정",
    file: kind === "fatal_defect" ? "a.gd" : null,
    symbol: null,
    line: kind === "fatal_defect" ? 3 : null,
    codeQuote: kind === "fatal_defect" ? "return x[3]" : null,
    fatalOutcome: kind === "fatal_defect" ? "deterministic_crash" : null,
    criterionId: kind === "fatal_defect" ? null : "AC-1",
    acceptanceCriterion: kind === "fatal_defect" ? null : CRITERIA[0]!,
    testSearchSummaryKo: kind === "fatal_defect" ? null : "대응 테스트 없음",
    evidence: [],
  };
}

function coverageResult(candidates: MiniMaxReviewCandidate[] = []): MiniMaxReviewResult {
  return {
    acceptanceCoverage: CRITERIA.map((criterion, index) => ({
      criterionId: `AC-${index + 1}`,
      acceptanceCriterion: criterion,
      status: index === 0 ? "missing" : "covered",
      testEvidence: index === 0
        ? null
        : { file: "tests/t.gd", line: 9, testName: "test_avg", assertionQuote: "assert_eq(avg([]), 0.0)", explanationKo: "빈 목록 검증" },
      supportingTestEvidence: [],
    })),
    candidates,
  };
}

test("두 패스가 성공하면 fatal 후보를 앞에 두고 최대 2건으로 다시 번호를 매긴다", async () => {
  const result = await extractReviewGateCandidatesIsolated(CRITERIA, {
    coverage: async () => coverageResult([candidate("missing_acceptance_test", "AC-1 테스트 없음")]),
    defect: async () => ({
      acceptanceCoverage: [],
      candidates: [candidate("fatal_defect", "인덱스 초과"), { ...candidate("fatal_defect", "0 나눗셈"), candidateId: "C-2" }],
    }),
  });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.acceptanceCoverage.map((row) => row.status), ["missing", "covered"]);
  assert.deepEqual(result.candidates.map((item) => `${item.candidateId}:${item.kind}:${item.titleKo}`), [
    "C-1:fatal_defect:인덱스 초과",
    "C-2:fatal_defect:0 나눗셈",
  ]);
});

test("커버리지 패스가 실패하면 모든 인수조건을 unknown으로 합성하고 실패를 기록한다", async () => {
  const result = await extractReviewGateCandidatesIsolated(CRITERIA, {
    coverage: async () => {
      throw new Error("MiniMax request timed out after 300000ms");
    },
    defect: async () => ({ acceptanceCoverage: [], candidates: [candidate("fatal_defect", "인덱스 초과")] }),
  });
  assert.deepEqual(result.acceptanceCoverage, unknownAcceptanceCoverage(CRITERIA));
  assert.equal(result.acceptanceCoverage[0]?.testEvidence, null);
  assert.deepEqual(result.candidates.map((item) => item.candidateId), ["C-1"]);
  assert.deepEqual(result.failures, [{ pass: "coverage", message: "MiniMax request timed out after 300000ms" }]);
  assert.equal(formatExtractionFailure(result.failures[0]!), `${COVERAGE_CALL_FAILED_PREFIX} MiniMax request timed out after 300000ms`);
});

test("결함 패스가 실패하면 커버리지와 테스트 누락 후보는 유지하고 실패만 기록한다", async () => {
  const result = await extractReviewGateCandidatesIsolated(CRITERIA, {
    coverage: async () => coverageResult([candidate("missing_acceptance_test", "AC-1 테스트 없음")]),
    defect: async () => {
      throw new Error("MiniMax 결함 후보 탐색 output failed validation: $response.stop_reason: truncated response is not valid review evidence");
    },
  });
  assert.deepEqual(result.candidates.map((item) => `${item.candidateId}:${item.kind}`), ["C-1:missing_acceptance_test"]);
  assert.equal(result.failures[0]?.pass, "defect");
  assert.ok(formatExtractionFailure(result.failures[0]!).startsWith(DEFECT_CALL_FAILED_PREFIX));
});

test("실행된 패스가 모두 실패하면 기존 ABSTAIN 경로를 위해 throw한다", async () => {
  await assert.rejects(
    extractReviewGateCandidatesIsolated(CRITERIA, {
      coverage: async () => {
        throw new Error("timeout");
      },
      defect: async () => {
        throw new Error("truncated");
      },
    }),
    /MiniMax review gate extraction failed: coverage: timeout \| defect: truncated/u,
  );
  await assert.rejects(
    extractReviewGateCandidatesIsolated([], { coverage: null, defect: async () => { throw new Error("only"); } }),
    /defect: only/u,
  );
});

test("인수조건이 없으면 커버리지 패스를 건너뛰고, 결함 리뷰가 꺼져 있으면 결함 패스를 건너뛴다", async () => {
  let coverageCalls = 0;
  const defectOnly = await extractReviewGateCandidatesIsolated([], {
    coverage: null,
    defect: async () => ({ acceptanceCoverage: [], candidates: [] }),
  });
  assert.deepEqual(defectOnly, { acceptanceCoverage: [], candidates: [], failures: [] });

  const coverageOnly = await extractReviewGateCandidatesIsolated(CRITERIA, {
    coverage: async () => {
      coverageCalls += 1;
      return coverageResult();
    },
    defect: null,
  });
  assert.equal(coverageCalls, 1);
  assert.deepEqual(coverageOnly.candidates, []);
  assert.deepEqual(coverageOnly.failures, []);

  const nothing = await extractReviewGateCandidatesIsolated([], { coverage: null, defect: null });
  assert.deepEqual(nothing, { acceptanceCoverage: [], candidates: [], failures: [] });
});

test("병합은 fatal 우선·상한 2·순차 번호를 보장한다", () => {
  const merged = mergeReviewGateCandidates(
    [candidate("fatal_defect", "A")],
    [candidate("missing_acceptance_test", "B"), { ...candidate("missing_acceptance_test", "C"), candidateId: "C-2" }],
  );
  assert.deepEqual(merged.map((item) => `${item.candidateId}:${item.titleKo}`), ["C-1:A", "C-2:B"]);
});

test("어느 모델 호출이든 실패한 실행은 캐시 재사용 대상에서 제외된다", () => {
  assert.equal(hasGateCallFailure([`${COVERAGE_CALL_FAILED_PREFIX} timeout`]), true);
  assert.equal(hasGateCallFailure([`${DEFECT_CALL_FAILED_PREFIX} truncated`]), true);
  assert.equal(hasGateCallFailure([`${VERIFICATION_CALL_FAILED_PREFIX}C-2: timeout`]), true);
  assert.equal(hasGateCallFailure(["AC-1: acceptance_coverage_unknown"]), false);
  assert.equal(hasGateCallFailure(null), false);
  assert.equal(hasGateCallFailure(undefined), false);
});
