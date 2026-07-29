import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCEPTANCE_GUIDE_ITEM_MARKER_PREFIX,
  ACCEPTANCE_GUIDE_PUBLICATION_MARKER,
  acceptanceGuideCheckState,
  buildAcceptanceGuide,
  formatAcceptanceGuideThread,
  isAcceptanceGuideThreadBody,
} from "./acceptance-guide.js";

test("명시적 인수조건이 없으면 정의 요청 한 건만 만든다", () => {
  const guide = buildAcceptanceGuide({
    headSha: "abc123",
    explicitAcceptanceCriteria: [],
    coveredCriteria: [],
    manualCriteria: [],
    abstainItems: [],
    findings: [],
  });

  assert.equal(guide.items.length, 1);
  assert.equal(guide.items[0]?.id, "AC-정의");
  assert.match(guide.summary, /승인이나 코드 품질 판정이 아닙니다/u);
  assert.match(guide.summary, new RegExp(ACCEPTANCE_GUIDE_PUBLICATION_MARKER));
});

test("AC 소명 항목과 확정 테스트 누락을 중복 없이 안내한다", () => {
  const criterion = "저장 실패 시 기존 데이터를 보존한다.";
  const guide = buildAcceptanceGuide({
    headSha: "abc123",
    explicitAcceptanceCriteria: [criterion],
    coveredCriteria: [],
    manualCriteria: [],
    abstainItems: [{
      label: `AC-1 · ${criterion}`,
      reason: "현재 HEAD에서 테스트 근거를 찾지 못했습니다.",
      requiredAction: "테스트 또는 소명 근거를 알려 주세요.",
    }, {
      label: "자동 검증 결과 구조",
      reason: "모델 응답 구조가 잘못됐습니다.",
      requiredAction: "다시 리뷰해 주세요.",
    }],
    findings: [{
      kind: "missing_acceptance_test",
      title: "인수조건 테스트 누락",
      problem: "직접 검증하는 테스트가 없습니다.",
      trigger: "저장 실패",
      impact: "회귀를 막을 수 없습니다.",
      requiredAction: "직접 검증하는 테스트를 추가해 주세요.",
      evidence: {
        acceptanceCriterion: criterion,
        testInventoryComplete: true,
      },
    }],
  });

  assert.equal(guide.items.length, 1);
  assert.equal(guide.items[0]?.id, "AC-1");
  assert.doesNotMatch(guide.summary, /자동 검증 결과 구조/u);
});

test("가이드 스레드는 Resolve 안내와 추적 marker를 포함한다", () => {
  const body = formatAcceptanceGuideThread({
    id: "AC-2",
    label: "오프라인 재시도를 정의한다.",
    reason: "재시도 횟수가 명시되지 않았습니다.",
    requiredAction: "최대 횟수와 실패 처리를 명시해 주세요.",
  });

  assert.match(body, /Resolve/u);
  assert.match(body, new RegExp(ACCEPTANCE_GUIDE_ITEM_MARKER_PREFIX));
  assert.match(body, new RegExp(ACCEPTANCE_GUIDE_PUBLICATION_MARKER));
  assert.equal(isAcceptanceGuideThreadBody(body), true);
  assert.equal(isAcceptanceGuideThreadBody("일반 리뷰 댓글"), false);
});

test("required check는 Seori 가이드 스레드의 Resolve 상태만 집계한다", () => {
  const markerBody = `<!-- ${ACCEPTANCE_GUIDE_ITEM_MARKER_PREFIX}abc -->`;
  const blocked = acceptanceGuideCheckState([
    { isResolved: true, bodies: [markerBody] },
    { isResolved: false, bodies: [markerBody, "소명 답글"] },
    { isResolved: false, bodies: ["다른 리뷰어의 미해결 지적"] },
  ]);

  assert.equal(blocked.total, 2);
  assert.equal(blocked.unresolved, 1);
  assert.equal(blocked.conclusion, "action_required");

  const passed = acceptanceGuideCheckState([
    { isResolved: true, bodies: [markerBody] },
  ]);
  assert.equal(passed.conclusion, "success");
  assert.match(passed.summary, /approval이나 코드 품질 승인이 아닙니다/u);
});
