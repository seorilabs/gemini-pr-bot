import assert from "node:assert/strict";
import test from "node:test";

import { buildLargeFileDigest } from "./github.js";
import type { MiniMaxCandidateVerification, MiniMaxReviewCandidate } from "./minimax-review.js";
import { decodeReviewGateCache, encodeReviewGateCache } from "./review-gate-cache.js";
import { evaluateMiniMaxReviewGateCandidates } from "./review-gate-pipeline.js";
import { REVIEW_GATE_PROMPT_VERSION } from "./review-gate-prompt.js";
import {
  VERIFICATION_CALL_FAILED_PREFIX,
  VERIFIER_MAX_REFERENCED_PATHS,
  VERIFIER_PATCH_CHARS_PER_PATH,
  buildReviewGateVerifierUserPrompt,
  formatVerificationCallFailure,
  hasVerificationCallFailure,
  mergedLineWindows,
  referencedCandidatePaths,
  renderNumberedExcerpt,
  verifyReviewGateCandidatesIsolated,
} from "./review-gate-verifier-input.js";

const FILE = "godot/scripts/reward_tiers.gd";
const FILE_LINES = [
  "extends RefCounted",
  "",
  "## 일일 보상 티어 테이블. 정상 진행에서 tier는 1..3을 전달받는다.",
  "const REWARD_TIERS: Array[int] = [10, 20, 30]",
  "",
  "static func reward_for_tier(tier: int) -> int:",
  "\treturn REWARD_TIERS[tier]",
];
const FILE_CONTENT = `${FILE_LINES.join("\n")}\n`;

function fatalCandidate(overrides: Partial<MiniMaxReviewCandidate> = {}): MiniMaxReviewCandidate {
  return {
    candidateId: "C-1",
    kind: "fatal_defect",
    titleKo: "tier 3 입력에서 배열 범위를 벗어난다",
    problemKo: "REWARD_TIERS는 3개인데 tier를 그대로 인덱스로 사용한다.",
    triggerKo: "정상 진행에서 tier 3을 전달하면 발생한다.",
    impactKo: "보상 계산이 확정적으로 크래시한다.",
    fixKo: "tier - 1을 clamp해 인덱스로 사용한다.",
    file: FILE,
    symbol: "reward_for_tier",
    line: 7,
    codeQuote: "\treturn REWARD_TIERS[tier]",
    fatalOutcome: "deterministic_crash",
    criterionId: null,
    acceptanceCriterion: null,
    testSearchSummaryKo: null,
    evidence: [
      { file: FILE, line: 4, codeQuote: "const REWARD_TIERS: Array[int] = [10, 20, 30]", explanationKo: "배열 크기는 3이다." },
      { file: FILE, line: 7, codeQuote: "\treturn REWARD_TIERS[tier]", explanationKo: "tier를 그대로 인덱스로 사용한다." },
    ],
    ...overrides,
  };
}

function missingTestCandidate(): MiniMaxReviewCandidate {
  return {
    ...fatalCandidate(),
    candidateId: "C-2",
    kind: "missing_acceptance_test",
    titleKo: "AC-1 테스트가 없다",
    file: null,
    symbol: null,
    line: null,
    codeQuote: null,
    fatalOutcome: null,
    criterionId: "AC-1",
    acceptanceCriterion: "정상 진행 tier 1..3 입력에서 보상량이 반환된다.",
    testSearchSummaryKo: "전체 인벤토리에 대응 테스트가 없다.",
    evidence: [],
  };
}

function verification(candidateId: string, verdict: MiniMaxCandidateVerification["verdict"]): MiniMaxCandidateVerification {
  return {
    candidateId,
    verdict,
    reasonKo: "현재 HEAD에서 동일 root line을 확인했습니다.",
    evidence: verdict === "uncertain"
      ? []
      : [
          { file: FILE, line: 4, codeQuote: "const REWARD_TIERS: Array[int] = [10, 20, 30]", explanationKo: "배열 크기는 3이다." },
          { file: FILE, line: 7, codeQuote: "\treturn REWARD_TIERS[tier]", explanationKo: "root line이다." },
        ],
  };
}

function promptInput(candidate: MiniMaxReviewCandidate, overrides: Record<string, unknown> = {}) {
  return {
    headSha: "1c3aa42fa140fa411ee4f2260e8effb325c6f695",
    changeClass: "product_logic" as const,
    testInventoryComplete: true,
    testInventoryFileCount: 3,
    fatalContextComplete: true,
    candidate,
    explicitAcceptanceCriteria: ["정상 진행 tier 1..3 입력에서 보상량이 반환된다."],
    evidenceCandidatesText: '{"id":"E-1","kind":"test","file":"tests/test_reward.gd","line":9,"test_name":"test_tier","quote":"assert_eq(reward_for_tier(1), 10)"}',
    currentHeadFileContents: { [FILE]: FILE_CONTENT },
    visibleChangedPatches: { [FILE]: `@@ -0,0 +1,7 @@\n${FILE_LINES.map((line) => `+${line}`).join("\n")}` },
    ...overrides,
  };
}

test("병합 창은 겹치거나 인접한 구간을 합치고 파일 경계에서 잘린다", () => {
  assert.deepEqual(mergedLineWindows([100, 250], 200, 1_000), [[1, 450]]);
  assert.deepEqual(mergedLineWindows([100, 700], 200, 1_000), [[1, 300], [500, 900]]);
  assert.deepEqual(mergedLineWindows([950], 200, 1_000), [[750, 1_000]]);
  assert.deepEqual(mergedLineWindows([0, 1_001, Number.NaN], 200, 1_000), []);
});

test("발췌는 현재 HEAD 줄번호를 접두어로 붙이고 CRLF와 끝 개행을 만들지 않는다", () => {
  const excerpt = renderNumberedExcerpt("a\r\nb\r\nc\r\n", [2], 0);
  assert.equal(excerpt, "L2: b");
  const twoBlocks = renderNumberedExcerpt(Array.from({ length: 20 }, (_, index) => `line${index + 1}`).join("\n"), [2, 18], 1);
  assert.equal(twoBlocks, "L1: line1\nL2: line2\nL3: line3\n  ...\nL17: line17\nL18: line18\nL19: line19");
  assert.equal(renderNumberedExcerpt("a\nb", [9], 3), "(지목한 줄이 현재 HEAD 파일 범위를 벗어남)");
});

test("발췌 줄 형식은 대형 파일 digest가 쓰는 L번호 형식과 같다", () => {
  const content = Array.from({ length: 60 }, (_, index) => `var value_${index + 1} := ${index + 1}`).join("\n");
  const digest = buildLargeFileDigest(content, "@@ -30,1 +30,1 @@\n-old\n+var value_30 := 30");
  assert.ok(digest);
  const digestLine = digest.markdown.split("\n").find((row) => row.startsWith("L30: "));
  const excerptLine = renderNumberedExcerpt(content, [30], 0);
  assert.equal(digestLine, excerptLine);
});

test("후보 경로는 정규화·중복 제거되고 candidate.file이 먼저 오며 상한을 지킨다", () => {
  const candidate = fatalCandidate({
    file: `./${FILE}`,
    evidence: Array.from({ length: 9 }, (_, index) => ({
      file: index === 0 ? FILE : `src/other_${index}.gd`,
      line: index + 1,
      codeQuote: "x",
      explanationKo: "근거",
    })),
  });
  const paths = referencedCandidatePaths(candidate);
  assert.equal(paths.length, VERIFIER_MAX_REFERENCED_PATHS);
  assert.equal(paths[0]?.path, FILE);
  assert.deepEqual(paths[0]?.lines, [1, 7]);
});

test("검증자 프롬프트는 전체 diff 없이 후보 파일 발췌·패치·host 사실만 담는다", () => {
  const prompt = buildReviewGateVerifierUserPrompt(promptInput(fatalCandidate({ file: `./${FILE}` })));
  assert.match(prompt, new RegExp(`^Gate version: ${REVIEW_GATE_PROMPT_VERSION}$`, "mu"));
  assert.match(prompt, /^## Host 검증 사실$/mu);
  assert.match(prompt, /^test_inventory_complete: true$/mu);
  assert.match(prompt, /^AC-1: 정상 진행 tier 1\.\.3 입력에서 보상량이 반환된다\.$/mu);
  assert.match(prompt, new RegExp(`^### ${FILE.replace(/[./]/gu, "\\$&")}$`, "mu"));
  assert.match(prompt, /^L7: \treturn REWARD_TIERS\[tier\]$/mu);
  assert.match(prompt, /^#### 변경 패치$/mu);
  assert.match(prompt, /^\+const REWARD_TIERS/mu);
  assert.match(prompt, /"candidateId": "C-1"/u);
  assert.match(prompt, /candidate_id "C-1"/u);
  assert.doesNotMatch(prompt, /Pull Request Merge Gate Context|## Changed Files|## Current Changed File Contents/u);
  assert.doesNotMatch(prompt, /## Host Evidence Candidates/u);
});

test("missing_acceptance_test 후보에만 Host Evidence Candidates 인벤토리를 준다", () => {
  const prompt = buildReviewGateVerifierUserPrompt(promptInput(missingTestCandidate()));
  assert.match(prompt, /^## Host Evidence Candidates$/mu);
  assert.match(prompt, /test_reward\.gd/u);
  assert.match(prompt, /\(후보가 파일을 지목하지 않음\)/u);
});

test("host가 본문을 확보하지 못한 경로는 안내 문구를 남기고 패치는 예산 안에서 잘린다", () => {
  const longPatch = `@@ -0,0 +1,1 @@\n+${"x".repeat(VERIFIER_PATCH_CHARS_PER_PATH * 2)}`;
  const prompt = buildReviewGateVerifierUserPrompt(
    promptInput(fatalCandidate(), {
      currentHeadFileContents: {},
      visibleChangedPatches: { [FILE]: longPatch },
    }),
  );
  assert.match(prompt, /\(현재 HEAD 본문을 host가 확보하지 못함\)/u);
  assert.ok(prompt.length < longPatch.length);
  assert.match(prompt, /\.\.\.truncated\.\.\./u);
});

test("후보 하나의 검증 호출이 실패하면 그 후보만 host uncertain으로 남고 나머지는 유지된다", async () => {
  const candidates = [fatalCandidate(), missingTestCandidate()];
  const result = await verifyReviewGateCandidatesIsolated(candidates, async (candidate) => {
    if (candidate.candidateId === "C-2") {
      throw new Error("MiniMax request timed out after 300000ms");
    }
    return verification("C-1", "confirmed");
  });
  assert.deepEqual(result.verifications.map((item) => `${item.candidateId}:${item.verdict}`), ["C-1:confirmed", "C-2:uncertain"]);
  assert.deepEqual(result.verifications[1]?.evidence, []);
  assert.match(result.verifications[1]?.reasonKo ?? "", /\p{Script=Hangul}/u);
  assert.deepEqual(result.failures, [{ candidateId: "C-2", message: "MiniMax request timed out after 300000ms" }]);

  const formatted = formatVerificationCallFailure(result.failures[0]!);
  assert.equal(formatted, `${VERIFICATION_CALL_FAILED_PREFIX}C-2: MiniMax request timed out after 300000ms`);
  assert.equal(hasVerificationCallFailure([formatted]), true);
  assert.equal(hasVerificationCallFailure(["AC-1: acceptance_coverage_unknown"]), false);
  assert.equal(hasVerificationCallFailure(null), false);

  const pipeline = evaluateMiniMaxReviewGateCandidates({
    candidates,
    verifications: result.verifications,
    explicitAcceptanceCriteria: ["정상 진행 tier 1..3 입력에서 보상량이 반환된다."],
    testInventoryComplete: true,
    testInventoryFileCount: 3,
    currentHeadFileContents: { [FILE]: FILE_CONTENT },
    visibleChangedPatches: { [FILE]: `@@ -0,0 +1,7 @@\n${FILE_LINES.map((line) => `+${line}`).join("\n")}` },
  });
  assert.equal(pipeline.inputValid, true);
  assert.deepEqual(pipeline.accepted.map((item) => item.candidateId), ["C-1"]);
  assert.deepEqual(pipeline.rejected.map((item) => `${item.candidateId}:${item.code}`), ["C-2:verification_not_confirmed"]);

  const envelope = {
    schemaVersion: 3 as const,
    acceptanceCoverage: [
      {
        criterionId: "AC-1",
        acceptanceCriterion: "정상 진행 tier 1..3 입력에서 보상량이 반환된다.",
        status: "missing" as const,
        testEvidence: null,
        supportingTestEvidence: [],
      },
    ],
    candidates,
    verifications: result.verifications,
  };
  const decoded = decodeReviewGateCache(
    JSON.stringify(encodeReviewGateCache(envelope)),
    ["정상 진행 tier 1..3 입력에서 보상량이 반환된다."],
  );
  assert.deepEqual(decoded?.verifications, result.verifications);
});

test("검증자가 다른 candidate_id를 돌려주면 실패로 기록하고 순서를 보존한다", async () => {
  const candidates = [fatalCandidate(), missingTestCandidate()];
  const result = await verifyReviewGateCandidatesIsolated(candidates, async (candidate) =>
    verification(candidate.candidateId === "C-1" ? "C-2" : "C-2", "confirmed"),
  );
  assert.deepEqual(result.verifications.map((item) => `${item.candidateId}:${item.verdict}`), ["C-1:uncertain", "C-2:confirmed"]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]?.message ?? "", /candidate_id "C-2"/u);
});

test("후보가 없으면 호출 없이 빈 결과를 돌려준다", async () => {
  let calls = 0;
  const result = await verifyReviewGateCandidatesIsolated([], async () => {
    calls += 1;
    return verification("C-1", "confirmed");
  });
  assert.equal(calls, 0);
  assert.deepEqual(result, { verifications: [], failures: [] });
});
