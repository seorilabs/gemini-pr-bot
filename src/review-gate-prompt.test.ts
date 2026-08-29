import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REVIEW_GATE_PROMPT_VERSION,
  buildReviewGateCandidateSystemPrompt,
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

test("가이드 모드 프롬프트는 결함 탐지를 계속 금지한다", () => {
  const prompt = guidePrompt();
  assert.match(prompt, /candidates는 항상 빈 배열로 제출/u);
  assert.match(prompt, /치명 결함, 일반 코드 결함, 스타일, 리팩터링 또는 개선 제안을 찾지 마세요/u);
});

test("보수적 게이트 프롬프트는 가이드 모드와 분리된다", () => {
  const conservative = conservativePrompt();
  assert.notEqual(conservative, guidePrompt());
  assert.match(conservative, /허용 후보는 최대 2개이며 fatal_defect 또는 missing_acceptance_test뿐입니다/u);
  assert.doesNotMatch(conservative, /candidates는 항상 빈 배열로 제출/u);
});

test("검증자 프롬프트는 반증 우선 규칙을 유지한다", () => {
  const prompt = buildReviewGateVerifierSystemPrompt();
  assert.match(prompt, /반증 우선 검증자/u);
  assert.match(prompt, /전달된 후보는 신뢰하지 마세요/u);
});

test("프롬프트 버전은 가이드 모드 v2를 가리킨다", () => {
  // 버전 문자열은 review_runs 테이블의 회귀 측정 단위다.
  assert.equal(REVIEW_GATE_PROMPT_VERSION, "acceptance-guide-v2-gemini");
});
