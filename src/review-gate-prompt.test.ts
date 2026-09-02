import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REVIEW_GATE_PROMPT_VERSION,
  buildReviewGateCandidateSystemPrompt,
  buildReviewGateCandidateUserPrompt,
  buildReviewGateVerifierSystemPrompt,
} from "./review-gate-prompt.js";

const guidePrompt = () => buildReviewGateCandidateSystemPrompt({ acceptanceGuideMode: true });
const conservativePrompt = () => buildReviewGateCandidateSystemPrompt({ acceptanceGuideMode: false });

test("가이드 모드 프롬프트는 Host 후보의 필드를 그대로 복사하도록 요구한다", () => {
  const prompt = guidePrompt();
  assert.match(prompt, /Host Evidence Candidates JSON line의 file, line, test_name, quote를 그대로 복사/u);
  assert.match(prompt, /후보 목록에 없는 file, test_name, line, assertion_quote는 어떤 이유로도 만들지 마세요/u);
});

test("가이드 모드 프롬프트는 소스 근거도 후보 선택으로 제한한다", () => {
  const prompt = guidePrompt();
  // v1은 후보 밖의 "현재 HEAD 구현 한 줄"을 허용해 host inventory 밖 근거를 유도했다.
  assert.doesNotMatch(prompt, /정확한 현재 HEAD 구현 한 줄을 근거로 사용할 수 있습니다/u);
  assert.match(prompt, /kind가 source인 후보를 선택해 증명하세요/u);
  assert.match(prompt, /후보가 목록에 없으면 covered가 아니라 unknown/u);
});

test("가이드 모드 프롬프트는 quote 전사 실패를 막는 규칙을 포함한다", () => {
  const prompt = guidePrompt();
  assert.match(prompt, /멀티라인 후보의 assertion_quote는 opening line만 남기지 말고/u);
  assert.match(prompt, /context_hint 문구를 섞지 마세요/u);
  assert.match(prompt, /실행 명령 자체를 assertion_quote로 만들지 마세요/u);
});

test("가이드 모드 프롬프트는 완전히 입증된 결함 후보를 허용한다", () => {
  const prompt = guidePrompt();
  assert.doesNotMatch(prompt, /candidates는 항상 빈 배열로 제출/u);
  assert.match(prompt, /허용 후보는 최대 2개이며 fatal_defect 또는 missing_acceptance_test뿐입니다/u);
  assert.match(prompt, /후보가 없더라도 acceptance_coverage는 모두 채우고 candidates만 빈 배열로 제출하세요/u);
  assert.match(prompt, /일반 코드 리뷰, 개선 제안, 스타일, 유지보수성, 잠재 위험, 검증 요청은 출력하지 마세요/u);
});

test("보수적 게이트 프롬프트는 가이드 모드와 분리된다", () => {
  const conservative = conservativePrompt();
  assert.notEqual(conservative, guidePrompt());
  assert.match(conservative, /허용 후보는 최대 2개이며 fatal_defect 또는 missing_acceptance_test뿐입니다/u);
  assert.doesNotMatch(conservative, /candidates는 항상 빈 배열로 제출/u);
  // 후속 턴 규칙은 보수 게이트 전용으로 남는다.
  assert.match(conservative, /review_round가 2 이상이면/u);
  assert.doesNotMatch(guidePrompt(), /review_round가 2 이상이면/u);
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

test("프롬프트 버전은 가이드 모드 v6 MiniMax를 가리킨다", () => {
  // 버전 문자열은 review_runs 테이블의 회귀 측정 단위이자 게이트 캐시 격리 키다.
  // v6: 검증자 입력을 후보 파일 발췌로 축소하고 후보별 격리 호출로 바꿨다.
  assert.equal(REVIEW_GATE_PROMPT_VERSION, "acceptance-guide-v6-minimax");
});

const candidateUserInput = {
  headSha: "1c3aa42fa140fa411ee4f2260e8effb325c6f695",
  changeClass: "product_logic" as const,
  testInventoryComplete: false,
  testInventoryFileCount: 0,
  fatalContextComplete: true,
  explicitAcceptanceCriteria: ["정상 진행 tier 1..3 입력에서 보상량이 반환된다."],
  evidenceCandidatesText: "(current-HEAD evidence candidate 없음)",
  trustedRequest: "",
  ledgerText: "",
  reviewGateMarkdown: "# Pull Request Merge Gate Context\n(body)",
  acceptanceGuideMode: true,
};

test("후보 유저 프롬프트는 host 사실·인수조건·placeholder·모드별 지시문을 순서대로 담는다", () => {
  const prompt = buildReviewGateCandidateUserPrompt(candidateUserInput);
  const lines = prompt.split("\n");
  assert.equal(lines[0], `Gate version: ${REVIEW_GATE_PROMPT_VERSION}`);
  assert.equal(lines[1], "## Host 검증 사실");
  assert.equal(lines[2], "head_sha: 1c3aa42fa140fa411ee4f2260e8effb325c6f695");
  assert.equal(lines[6], "fatal_context_complete: true");
  assert.match(prompt, /^## Host가 추출한 명시적 인수조건\nAC-1: 정상 진행 tier 1\.\.3 입력에서 보상량이 반환된다\.$/mu);
  assert.match(prompt, /^## 신뢰된 명시 요청\n\(없음\)$/mu);
  assert.match(prompt, /^## 지적 원장\n\(이전 지적 없음\)$/mu);
  assert.match(prompt, /# Pull Request Merge Gate Context\n\(body\)/u);
  assert.ok(prompt.endsWith("확실한 후보가 없으면 candidates는 빈 배열입니다."));

  const conservative = buildReviewGateCandidateUserPrompt({
    ...candidateUserInput,
    acceptanceGuideMode: false,
    explicitAcceptanceCriteria: [],
    ledgerText: "- fp state=open kind=fatal target=a.gd#f",
    trustedRequest: "이 PR을 코드리뷰해줘.",
  });
  assert.match(conservative, /^\(명시적 인수조건 없음\)$/mu);
  assert.match(conservative, /^- fp state=open kind=fatal target=a\.gd#f$/mu);
  assert.match(conservative, /^이 PR을 코드리뷰해줘\.$/mu);
  assert.ok(conservative.endsWith("확실한 후보가 없으면 빈 배열을 제출하세요."));
});
