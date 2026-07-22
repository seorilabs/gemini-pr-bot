import assert from "node:assert/strict";
import test from "node:test";

import {
  REVIEW_GATE_CACHE_SCHEMA_VERSION,
  decodeReviewGateCache,
  encodeReviewGateCache,
  filterReviewGateCacheCandidates,
  type MiniMaxReviewGateCacheEnvelope,
} from "./review-gate-cache.js";

const ACCEPTANCE_CRITERION = "저장 후 다시 열어도 값이 유지된다.";

function validEnvelope(): MiniMaxReviewGateCacheEnvelope {
  return {
    schemaVersion: REVIEW_GATE_CACHE_SCHEMA_VERSION,
    acceptanceCoverage: [
      {
        criterionId: "AC-1",
        acceptanceCriterion: ACCEPTANCE_CRITERION,
        status: "missing",
        testEvidence: null,
        supportingTestEvidence: [],
      },
    ],
    candidates: [
      {
        candidateId: "C-1",
        kind: "missing_acceptance_test",
        titleKo: "저장값 복원 인수조건 테스트가 없습니다",
        problemKo: "명시된 복원 동작을 직접 검증하는 테스트가 없습니다.",
        triggerKo: "저장값 복원 동작이 변경되어도 테스트가 회귀를 잡지 못합니다.",
        impactKo: "인수조건이 깨진 채 병합될 수 있습니다.",
        fixKo: "저장 후 복원된 값을 직접 비교하는 테스트를 추가해야 합니다.",
        file: null,
        symbol: null,
        line: null,
        codeQuote: null,
        fatalOutcome: null,
        criterionId: "AC-1",
        acceptanceCriterion: ACCEPTANCE_CRITERION,
        testSearchSummaryKo: "현재 HEAD의 전체 테스트 파일을 확인했지만 대응 단언이 없습니다.",
        evidence: [],
      },
    ],
    verifications: [
      {
        candidateId: "C-1",
        verdict: "confirmed",
        reasonKo: "전체 테스트 목록에서도 해당 인수조건을 직접 검증하는 단언이 없습니다.",
        evidence: [],
      },
    ],
  };
}

test("valid cache envelope roundtrips through exact MiniMax wire fields", () => {
  const envelope = validEnvelope();
  const encoded = encodeReviewGateCache(envelope);

  assert.deepEqual(Object.keys(encoded).sort(), [
    "acceptance_coverage",
    "candidates",
    "schemaVersion",
    "verifications",
  ]);
  assert.deepEqual(Object.keys((encoded.acceptance_coverage as any[])[0]).sort(), [
    "acceptance_criterion",
    "criterion_id",
    "status",
    "supporting_test_evidence",
    "test_evidence",
  ]);
  assert.equal((encoded.candidates as any[])[0].candidate_id, "C-1");
  assert.equal((encoded.verifications as any[])[0].reason_ko.includes("인수조건"), true);

  assert.deepEqual(
    decodeReviewGateCache(JSON.stringify(encoded), [ACCEPTANCE_CRITERION]),
    envelope,
  );
  assert.deepEqual(decodeReviewGateCache(encoded, [ACCEPTANCE_CRITERION]), envelope);
});

test("empty arrays are a valid cache entry when the host has no acceptance criteria", () => {
  const envelope: MiniMaxReviewGateCacheEnvelope = {
    schemaVersion: REVIEW_GATE_CACHE_SCHEMA_VERSION,
    acceptanceCoverage: [],
    candidates: [],
    verifications: [],
  };

  const encoded = encodeReviewGateCache(envelope);
  assert.deepEqual(encoded, {
    schemaVersion: 3,
    acceptance_coverage: [],
    candidates: [],
    verifications: [],
  });
  assert.deepEqual(decodeReviewGateCache(encoded, []), envelope);
});

test("camelCase wire fields and unknown root fields are rejected", () => {
  const encoded = encodeReviewGateCache(validEnvelope());
  const { acceptance_coverage, ...withoutSnakeCaseCoverage } = encoded;

  assert.equal(
    decodeReviewGateCache(
      { ...withoutSnakeCaseCoverage, acceptanceCoverage: acceptance_coverage },
      [ACCEPTANCE_CRITERION],
    ),
    null,
  );
  assert.equal(
    decodeReviewGateCache({ ...encoded, metadata: {} }, [ACCEPTANCE_CRITERION]),
    null,
  );
  assert.equal(
    decodeReviewGateCache({ ...encoded, schemaVersion: 1 }, [ACCEPTANCE_CRITERION]),
    null,
  );
});

test("cache acceptance coverage is revalidated against the current host criteria", () => {
  const encoded = encodeReviewGateCache(validEnvelope());

  assert.equal(decodeReviewGateCache(encoded, ["다른 인수조건"]), null);
  assert.equal(decodeReviewGateCache(encoded, []), null);

  const corruptedCandidate = structuredClone(encoded);
  (corruptedCandidate.candidates as Array<Record<string, unknown>>)[0]!.acceptance_criterion =
    "다른 인수조건";
  assert.equal(
    decodeReviewGateCache(corruptedCandidate, [ACCEPTANCE_CRITERION]),
    null,
  );
});

test("malformed candidates and verifications are rejected on cache hits", () => {
  const encoded = encodeReviewGateCache(validEnvelope());
  const malformedCandidate = structuredClone(encoded);
  (malformedCandidate.candidates as Array<Record<string, unknown>>)[0]!.title_ko =
    "English only";
  assert.equal(
    decodeReviewGateCache(malformedCandidate, [ACCEPTANCE_CRITERION]),
    null,
  );

  const malformedVerification = structuredClone(encoded);
  (malformedVerification.verifications as Array<Record<string, unknown>>)[0]!.candidate_id =
    "C-2";
  assert.equal(
    decodeReviewGateCache(malformedVerification, [ACCEPTANCE_CRITERION]),
    null,
  );
});

test("non-JSON strings and non-object inputs are cache misses", () => {
  assert.equal(decodeReviewGateCache("not json", []), null);
  assert.equal(decodeReviewGateCache(null, []), null);
  assert.equal(decodeReviewGateCache([], []), null);
});

test("suppressed candidate 뒤의 후보와 verifier는 C-1부터 다시 결합한다", () => {
  const envelope = validEnvelope();
  const secondCandidate = {
    ...envelope.candidates[0]!,
    candidateId: "C-2",
    titleKo: "두 번째 인수조건 테스트가 없습니다",
  };
  const secondVerification = {
    ...envelope.verifications[0]!,
    candidateId: "C-2",
  };
  const filtered = filterReviewGateCacheCandidates(
    {
      ...envelope,
      candidates: [...envelope.candidates, secondCandidate],
      verifications: [...envelope.verifications, secondVerification],
    },
    (candidate) => candidate.candidateId === "C-2",
  );

  assert.deepEqual(filtered.candidates.map((candidate) => candidate.candidateId), ["C-1"]);
  assert.deepEqual(filtered.verifications.map((verification) => verification.candidateId), ["C-1"]);
  assert.equal(filtered.candidates[0]?.titleKo, "두 번째 인수조건 테스트가 없습니다");
});
