import assert from "node:assert/strict";
import test from "node:test";
import {
  isPeripheralAcceptanceCriterion,
  resolveReviewTurnVerdict,
} from "./review-turn.js";

const coreItem = {
  label: "AC-1 · 저장 결과가 유지된다.",
  reason: "현재 HEAD에서 테스트 근거를 확인하지 못했습니다.",
  requiredAction: "저장 회귀 테스트를 추가해 주세요.",
  peripheral: false,
} as const;

const peripheralItem = {
  label: "AC-2 · 버튼 문구가 변경된다.",
  reason: "현재 HEAD에서 문구 근거를 확인하지 못했습니다.",
  requiredAction: "최종 문구 위치를 댓글로 알려 주세요.",
  peripheral: true,
} as const;

test("첫 리뷰와 두 번째 리뷰의 불확실성은 보류하지 않고 후속 대응을 요청한다", () => {
  assert.equal(resolveReviewTurnVerdict("ABSTAIN", 1, [peripheralItem]), "FOLLOW_UP");
  assert.equal(resolveReviewTurnVerdict("ABSTAIN", 2, [peripheralItem]), "FOLLOW_UP");
});

test("세 번째 이후 리뷰도 핵심 범위가 남으면 후속 대응을 계속 요청한다", () => {
  assert.equal(resolveReviewTurnVerdict("ABSTAIN", 3, [coreItem]), "FOLLOW_UP");
  assert.equal(resolveReviewTurnVerdict("ABSTAIN", 5, [peripheralItem, coreItem]), "FOLLOW_UP");
});

test("여러 리뷰 턴 뒤 지엽적 항목만 남았을 때만 판정 보류한다", () => {
  assert.equal(resolveReviewTurnVerdict("ABSTAIN", 3, [peripheralItem]), "ABSTAIN");
  assert.equal(resolveReviewTurnVerdict("ABSTAIN", 4, []), "FOLLOW_UP");
});

test("확정 PASS와 FAIL은 review round 정책이 바꾸지 않는다", () => {
  assert.equal(resolveReviewTurnVerdict("PASS", 1, []), "PASS");
  assert.equal(resolveReviewTurnVerdict("FAIL", 1, [coreItem]), "FAIL");
});

test("표현·시각 조건만 지엽적으로 분류하고 고위험 조건은 제외한다", () => {
  assert.equal(isPeripheralAcceptanceCriterion("버튼 라벨 문구와 아이콘 색상을 맞춘다."), true);
  assert.equal(isPeripheralAcceptanceCriterion("결제 데이터 삭제 경고 문구를 저장한다."), false);
});
