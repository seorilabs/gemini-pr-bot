import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REVIEW_GATE_PROMPT_VERSION,
  buildReviewGateCoverageSystemPrompt,
  buildReviewGateCoverageUserPrompt,
  buildReviewGateDefectSystemPrompt,
  buildReviewGateDefectUserPrompt,
  buildReviewGateVerifierSystemPrompt,
} from "./review-gate-prompt.js";

const guideCoverage = () => buildReviewGateCoverageSystemPrompt({ acceptanceGuideMode: true });
const guideDefect = () => buildReviewGateDefectSystemPrompt({ acceptanceGuideMode: true });
const conservativeCoverage = () => buildReviewGateCoverageSystemPrompt({ acceptanceGuideMode: false });
const conservativeDefect = () => buildReviewGateDefectSystemPrompt({ acceptanceGuideMode: false });

test("가이드 커버리지 프롬프트는 Host 후보의 필드를 그대로 복사하도록 요구한다", () => {
  const prompt = guideCoverage();
  assert.match(prompt, /Host Evidence Candidates JSON line의 file, line, test_name, quote를 그대로 복사/u);
  assert.match(prompt, /후보 목록에 없는 file, test_name, line, assertion_quote는 어떤 이유로도 만들지 마세요/u);
});

test("가이드 커버리지 프롬프트는 소스 근거도 후보 선택으로 제한한다", () => {
  const prompt = guideCoverage();
  // v1은 후보 밖의 "현재 HEAD 구현 한 줄"을 허용해 host inventory 밖 근거를 유도했다.
  assert.doesNotMatch(prompt, /정확한 현재 HEAD 구현 한 줄을 근거로 사용할 수 있습니다/u);
  assert.match(prompt, /kind가 source인 후보를 선택해 증명하세요/u);
  assert.match(prompt, /후보가 목록에 없으면 covered가 아니라 unknown/u);
});

test("가이드 커버리지 프롬프트는 quote 전사 실패를 막는 규칙을 포함한다", () => {
  const prompt = guideCoverage();
  assert.match(prompt, /멀티라인 후보의 assertion_quote는 opening line만 남기지 말고/u);
  assert.match(prompt, /context_hint 문구를 섞지 마세요/u);
  assert.match(prompt, /실행 명령 자체를 assertion_quote로 만들지 마세요/u);
});

test("커버리지 패스와 결함 패스는 후보 종류와 규칙을 서로 나눈다", () => {
  // v7: 한 호출이 커버리지 행과 diff 전체를 함께 다루던 구조를 두 호출로 나눴다.
  const coverage = guideCoverage();
  const defect = guideDefect();
  assert.match(coverage, /허용 후보는 최대 2개이며 missing_acceptance_test뿐입니다/u);
  assert.match(coverage, /후보가 없더라도 acceptance_coverage는 모두 채우고 candidates만 빈 배열로 제출하세요/u);
  assert.doesNotMatch(coverage, /fatal_defect는 정상 또는 필수 경로에서/u);
  assert.doesNotMatch(coverage, /후보 예시 1/u);

  assert.match(defect, /허용 후보는 최대 2개이며 fatal_defect뿐입니다/u);
  assert.match(defect, /fatal_defect는 정상 또는 필수 경로에서 확정적으로 크래시/u);
  assert.match(defect, /치명 결함은 같은 파일의 현재 HEAD 정확한 코드 2~6개로 도달 경로를 제시/u);
  assert.match(defect, /후보 예시 2: 주석이나 문서가 명시한 정상 입력 범위/u);
  assert.doesNotMatch(defect, /acceptance_coverage/u);
  assert.doesNotMatch(defect, /Host Evidence Candidates/u);

  for (const prompt of [coverage, defect]) {
    assert.match(prompt, /일반 코드 리뷰, 개선 제안, 스타일, 유지보수성, 잠재 위험, 검증 요청은 출력하지 마세요/u);
    assert.match(prompt, /정의된 submit_review 도구를 정확히 한 번 사용하세요/u);
    assert.doesNotMatch(prompt, /candidates는 항상 빈 배열로 제출/u);
  }
});

test("보수적 게이트 프롬프트는 가이드 모드와 분리된다", () => {
  assert.notEqual(conservativeCoverage(), guideCoverage());
  assert.notEqual(conservativeDefect(), guideDefect());
  assert.match(conservativeCoverage(), /허용 후보는 최대 2개이며 missing_acceptance_test뿐입니다/u);
  assert.match(conservativeDefect(), /허용 후보는 최대 2개이며 fatal_defect뿐입니다/u);
  assert.match(conservativeDefect(), /refuted 상태는 현재 Changed Files에/u);
  // 후속 턴 규칙은 보수 게이트 전용으로 남는다.
  assert.match(conservativeCoverage(), /review_round가 2 이상이면/u);
  assert.match(conservativeDefect(), /review_round가 2 이상이면/u);
  assert.doesNotMatch(guideCoverage(), /review_round가 2 이상이면/u);
  assert.doesNotMatch(guideDefect(), /review_round가 2 이상이면/u);
});

test("검증자 프롬프트는 반증 우선 규칙을 유지한다", () => {
  const prompt = buildReviewGateVerifierSystemPrompt();
  assert.match(prompt, /반증 우선 검증자/u);
  assert.match(prompt, /전달된 후보는 신뢰하지 마세요/u);
});

test("검증자 프롬프트는 발췌 입력 계약을 설명한다", () => {
  // v6부터 검증자는 전체 diff 대신 후보 파일의 L번호 발췌만 받는다.
  const prompt = buildReviewGateVerifierSystemPrompt();
  assert.match(prompt, /`L줄번호: 원문` 형식/u);
  assert.match(prompt, /code_quote는 접두어를 제외한 원문 줄 그대로/u);
  assert.match(prompt, /발췌 밖의 경로나 줄, 전달되지 않은 파일은 인용하지 마세요/u);
  assert.match(prompt, /본문이 발췌에 없으면 uncertain/u);
});

test("프롬프트 버전은 가이드 모드 v7 MiniMax를 가리킨다", () => {
  // 버전 문자열은 review_runs 테이블의 회귀 측정 단위이자 게이트 캐시 격리 키다.
  // v6: 검증자 입력을 후보 파일 발췌로 축소하고 후보별 격리 호출로 바꿨다.
  // v7: 후보 추출을 커버리지 패스와 결함 패스로 분할했다.
  assert.equal(REVIEW_GATE_PROMPT_VERSION, "acceptance-guide-v7-minimax");
});

const hostFacts = {
  headSha: "1c3aa42fa140fa411ee4f2260e8effb325c6f695",
  changeClass: "product_logic" as const,
  testInventoryComplete: false,
  testInventoryFileCount: 0,
  fatalContextComplete: true,
};

test("커버리지 유저 프롬프트는 인수조건·인벤토리·출처만 담고 diff는 담지 않는다", () => {
  const prompt = buildReviewGateCoverageUserPrompt({
    ...hostFacts,
    explicitAcceptanceCriteria: ["정상 진행 tier 1..3 입력에서 보상량이 반환된다."],
    evidenceCandidatesText: '{"id":"E-1","kind":"test","file":"tests/a.gd","line":3,"test_name":"t","quote":"assert_eq(1, 1)"}',
    trustedRequest: "",
    acceptanceSourceText: "### PR body\n- [ ] 정상 진행 tier 1..3 입력에서 보상량이 반환된다.",
    reviewRound: 1,
    previousReviewHeadSha: null,
    previousReviewBody: "",
    contributorResponses: "",
    acceptanceGuideMode: true,
  });
  const lines = prompt.split("\n");
  assert.equal(lines[0], `Gate version: ${REVIEW_GATE_PROMPT_VERSION}`);
  assert.equal(lines[1], "## Host 검증 사실");
  assert.match(prompt, /^## Host가 추출한 명시적 인수조건\nAC-1: 정상 진행 tier 1\.\.3 입력에서 보상량이 반환된다\.$/mu);
  assert.match(prompt, /^## Host Evidence Candidates$/mu);
  assert.match(prompt, /tests\/a\.gd/u);
  assert.match(prompt, /^## Trusted Acceptance Sources$/mu);
  assert.match(prompt, /^review_round: 1$/mu);
  assert.match(prompt, /^\(none - first review turn\)$/mu);
  assert.match(prompt, /^## 신뢰된 명시 요청\n\(없음\)$/mu);
  assert.doesNotMatch(prompt, /## Changed Files|## Current Changed File Contents|## Deep Repository Context|## 지적 원장/u);
  assert.ok(prompt.endsWith("확실한 후보가 없으면 candidates는 빈 배열입니다."));
  assert.match(prompt, /missing_acceptance_test 후보로 최대 2개/u);
});

test("결함 유저 프롬프트는 게이트 마크다운과 원장을 담고 인벤토리는 담지 않는다", () => {
  const prompt = buildReviewGateDefectUserPrompt({
    ...hostFacts,
    explicitAcceptanceCriteria: [],
    trustedRequest: "이 PR을 코드리뷰해줘.",
    ledgerText: "- fp state=open kind=fatal target=a.gd#f",
    reviewGateMarkdown: "# Pull Request Merge Gate Context\n## Changed Files\n(body)",
    acceptanceGuideMode: false,
  });
  assert.match(prompt, /^\(명시적 인수조건 없음\)$/mu);
  assert.match(prompt, /^이 PR을 코드리뷰해줘\.$/mu);
  assert.match(prompt, /^- fp state=open kind=fatal target=a\.gd#f$/mu);
  assert.match(prompt, /# Pull Request Merge Gate Context\n## Changed Files\n\(body\)/u);
  assert.doesNotMatch(prompt, /## Host Evidence Candidates|## Trusted Acceptance Sources/u);
  assert.ok(prompt.endsWith("확실한 후보가 없으면 빈 배열을 제출하세요."));

  const guide = buildReviewGateDefectUserPrompt({
    ...hostFacts,
    explicitAcceptanceCriteria: [],
    trustedRequest: "",
    ledgerText: "",
    reviewGateMarkdown: "(body)",
    acceptanceGuideMode: true,
  });
  assert.match(guide, /^## 지적 원장\n\(이전 지적 없음\)$/mu);
  assert.ok(guide.endsWith("확실한 후보가 없으면 candidates는 빈 배열입니다."));
});
