import assert from "node:assert/strict";
import test from "node:test";
import {
  formatReviewGateCheckOutput,
  formatReviewGateFinding,
  type ReviewGatePublicFatalFinding,
  type ReviewGatePublicFinding,
} from "./review-gate-format.js";

function fatalFinding(
  overrides: Partial<ReviewGatePublicFatalFinding> = {},
): ReviewGatePublicFatalFinding {
  return {
    kind: "fatal_defect",
    title: "저장 시 프로세스가 종료됩니다",
    problem: "정상적인 저장 경로에서 예외가 항상 발생합니다.",
    trigger: "사용자가 기본 저장 버튼을 누릅니다.",
    evidence: {
      file: "src/save.ts",
      line: 42,
      code: "throw new Error('fatal');",
    },
    impact: "저장 기능을 사용할 수 없고 입력한 내용이 유실됩니다.",
    requiredAction: "정상 저장 경로의 예외를 제거하고 회귀 테스트를 추가해야 합니다.",
    fingerprint: "fatal-save-42",
    ...overrides,
  };
}

function missingTestFinding(): ReviewGatePublicFinding {
  return {
    kind: "missing_acceptance_test",
    title: "세션 복원 인수조건을 검증하지 않습니다",
    problem: "명시된 세션 복원 동작을 검증하는 자동화 테스트가 없습니다.",
    trigger: "저장된 세션을 다시 불러오는 코드가 변경되거나 회귀합니다.",
    evidence: {
      acceptanceCriterion: "앱을 다시 열어도 기존 세션이 유지된다.",
      testInventoryComplete: true,
      testFilesInspected: 17,
    },
    impact: "세션 복원이 깨져도 병합 전에 발견할 수 없습니다.",
    requiredAction: "저장 후 재실행했을 때 세션이 복원되는 테스트를 추가해야 합니다.",
    fingerprint: "missing-session-restore-test",
  };
}

test("치명 결함 리뷰는 판단에 필요한 다섯 항목과 추적 표식을 모두 보여준다", () => {
  const output = formatReviewGateCheckOutput({
    headSha: "abc1234",
    verdict: "FAIL",
    findings: [fatalFinding()],
    htmlMarkers: ["seori-review-status:action-required head=abc1234"],
  });

  assert.equal(output.conclusion, "action_required");
  assert.equal(output.title, "치명 결함 확인");
  assert.match(output.summary, /확정 근거 1건/);
  assert.match(output.text, /### 1\. 치명 결함 · 저장 시 프로세스가 종료됩니다/);
  assert.match(output.text, /\*\*문제\*\*/);
  assert.match(output.text, /\*\*발생 조건\*\*/);
  assert.match(output.text, /\*\*현재 HEAD 근거\*\*/);
  assert.match(output.text, /`src\/save\.ts:42`/);
  assert.match(output.text, /```typescript\nthrow new Error\('fatal'\);\n```/);
  assert.match(output.text, /\*\*실제 영향\*\*/);
  assert.match(output.text, /\*\*필요한 수정 또는 테스트\*\*/);
  assert.match(output.text, /<!-- seori-review-status:action-required head=abc1234 -->/);
  assert.match(output.text, /<!-- seori-finding:fatal-save-42 -->/);
  assert.doesNotMatch(output.text, /발생합니다\\\./);
});

test("테스트 누락 리뷰는 인수조건과 전체 테스트 인벤토리 근거를 함께 보여준다", () => {
  const output = formatReviewGateCheckOutput({
    headSha: "def5678",
    verdict: "FAIL",
    findings: [missingTestFinding()],
  });

  assert.equal(output.title, "인수조건 테스트 누락");
  assert.match(output.text, /인수조건 테스트 누락/);
  assert.match(output.text, /관련 인수조건/);
  assert.match(output.text, /앱을 다시 열어도 기존 세션이 유지된다/);
  assert.match(output.text, /전체 테스트 인벤토리 확인 완료 \(17개 테스트 파일\)/);
  assert.match(output.text, /관련 자동화 테스트를 찾지 못했습니다/);
  assert.doesNotMatch(output.text, /src\/session\.ts/);
  assert.match(output.text, /세션이 복원되는 테스트를 추가해야 합니다/);
});

test("전체 테스트 인벤토리를 확인하지 않은 테스트 누락 지적은 게시하지 않는다", () => {
  const finding = missingTestFinding();
  const incomplete = {
    ...finding,
    evidence: { ...finding.evidence, testInventoryComplete: false },
  } as unknown as ReviewGatePublicFinding;

  assert.throws(
    () => formatReviewGateFinding(incomplete),
    /전체 테스트 인벤토리 확인/,
  );
});

test("통과 결과는 영문 판정값 없이 한글 check output을 만든다", () => {
  const output = formatReviewGateCheckOutput({
    headSha: "abc1234",
    verdict: "PASS",
    htmlMarkers: ["seori-review-status:no-action head=abc1234"],
  });

  assert.equal(output.conclusion, "success");
  assert.equal(output.title, "보수적 게이트 통과");
  assert.match(output.text, /판정: \*\*통과\*\*/);
  assert.doesNotMatch(output.text, /\bPASS\b|\bFAIL\b|\bABSTAIN\b/);
});

test("인수조건이 없는 fatal-only 통과 사유도 한글로 명확히 표시한다", () => {
  const output = formatReviewGateCheckOutput({
    headSha: "abc1234",
    verdict: "PASS",
    passSummaryKo: "명시적 인수조건이 없어 치명 결함만 검사했고 증명된 결함이 없습니다.",
  });

  assert.match(output.summary, /치명 결함만 검사/);
  assert.match(output.text, /증명된 결함이 없습니다/);
});

test("통과 결과는 확인한 인수조건과 현재 HEAD 테스트 근거를 읽기 쉽게 보여준다", () => {
  const output = formatReviewGateCheckOutput({
    headSha: "abc1234",
    verdict: "PASS",
    passSummaryKo: "모든 자동 인수조건의 현재 테스트 근거를 확인했습니다.",
    coveredCriteria: [
      {
        criterionId: "AC-1",
        acceptanceCriterion: "앱을 다시 열어도 기존 세션이 유지된다.",
        file: "src/session.test.ts",
        line: 27,
        testName: "재실행 후 기존 세션을 복원한다",
      },
    ],
  });

  assert.match(output.text, /### 확인한 인수조건 테스트/);
  assert.match(output.text, /\*\*AC-1\*\*/);
  assert.match(output.text, /앱을 다시 열어도 기존 세션이 유지된다/);
  assert.match(output.text, /`src\/session\.test\.ts:27`/);
  assert.match(output.text, /`재실행 후 기존 세션을 복원한다`/);
});

test("자동 판정 보류는 모델 사유나 작성자 행동 요구 없이 병합 비차단을 알린다", () => {
  const output = formatReviewGateCheckOutput({
    headSha: "abc1234",
    verdict: "ABSTAIN",
    fatalCheckPassed: true,
    coveredCriteria: [
      {
        criterionId: "AC-1",
        acceptanceCriterion: "앱을 다시 열어도 기존 세션이 유지된다.",
        file: "src/session.test.ts",
        line: 27,
        testName: "재실행 후 기존 세션을 복원한다",
      },
    ],
    abstainItems: [{
      label: "AC-2 · 네트워크가 끊겨도 작성 중인 내용이 보존된다.",
      reason: "현재 HEAD에서 이 인수조건의 자동화 테스트 커버리지를 확정하지 못했습니다.",
    }],
  });

  assert.equal(output.conclusion, "neutral");
  assert.equal(output.title, "자동 판정 보류 · 병합 비차단");
  assert.match(output.summary, /병합을 차단하지 않습니다/);
  assert.match(output.text, /### 확인 완료 \(PASS\)/);
  assert.match(output.text, /치명 결함 검사/);
  assert.match(output.text, /AC-1/);
  assert.match(output.text, /`src\/session\.test\.ts:27`/);
  assert.match(output.text, /### 판정 보류 항목/);
  assert.match(output.text, /AC-2/);
  assert.match(output.text, /커버리지를 확정하지 못했습니다/);
  assert.match(output.text, /추가 확인이나 수정을 요구하지 않습니다/);
  assert.doesNotMatch(output.text, /\bABSTAIN\b|해주세요|추가하세요|확인하세요|수정하세요/);
});

test("세부 정보가 없는 예외 보류도 공개용 기본 사유를 표시한다", () => {
  const output = formatReviewGateCheckOutput({
    headSha: "abc1234",
    verdict: "ABSTAIN",
  });

  assert.match(output.text, /확정적으로 통과한 세부 항목이 없습니다/);
  assert.match(output.text, /자동 판정 근거/);
  assert.match(output.text, /세부 판정을 확정하지 못했습니다/);
});

test("차단 지적의 핵심 설명이 없거나 한글이 아니면 게시하지 않는다", () => {
  assert.throws(
    () => formatReviewGateFinding(fatalFinding({ impact: "" })),
    /finding\.impact/,
  );
  assert.throws(
    () => formatReviewGateFinding(fatalFinding({ problem: "Always throws an exception." })),
    /한글 설명/,
  );
  assert.throws(
    () => formatReviewGateFinding(fatalFinding({ problem: "Always throws an exception 오류" })),
    /한글 설명/,
  );
  assert.throws(
    () => formatReviewGateFinding(fatalFinding({
      problem: "This change always throws an exception during every normal save request and breaks all persisted records 오류입니다.",
    })),
    /한글 설명/,
  );
  assert.throws(
    () => formatReviewGateFinding(fatalFinding({ evidence: { file: "src/save.ts", line: 0, code: "throw err" } })),
    /1 이상의 정수/,
  );
});

test("공개 설명은 영문 고유명사와 코드 경로가 섞인 자연스러운 한글을 허용한다", () => {
  const output = formatReviewGateFinding(fatalFinding({
    problem: "GitHub Actions의 Docker Buildx 단계에서 ARM64 이미지 빌드가 항상 실패합니다.",
    trigger: "`src/build.ts`의 buildImage 함수를 호출하면 registry.vzyx.xyz 업로드가 시작됩니다.",
  }));

  assert.match(output, /GitHub Actions의 Docker Buildx 단계/);
  assert.match(output, /src\/build\.ts/);
});

test("차단 지적은 최대 두 건으로 제한하고 비차단 결과에 섞이지 않는다", () => {
  assert.throws(
    () => formatReviewGateCheckOutput({ headSha: "abc", verdict: "FAIL", findings: [] }),
    /1~2개/,
  );
  assert.throws(
    () => formatReviewGateCheckOutput({
      headSha: "abc",
      verdict: "FAIL",
      findings: [fatalFinding(), fatalFinding(), fatalFinding()],
    }),
    /1~2개/,
  );
  assert.throws(
    () => formatReviewGateCheckOutput({
      headSha: "abc",
      verdict: "PASS",
      findings: [fatalFinding()],
    }),
    /비차단 판정/,
  );
});

test("코드 fence와 HTML 표식에 포함된 종료 문자열을 안전하게 처리한다", () => {
  const finding = fatalFinding({
    evidence: {
      file: "src/template.ts",
      line: 7,
      code: "const value = ```unsafe```;",
    },
    fingerprint: "fp-->injected",
  });
  const output = formatReviewGateCheckOutput({
    headSha: "abc",
    verdict: "FAIL",
    findings: [finding],
    htmlMarkers: ["marker-->injected\nnext"],
  });

  assert.match(output.text, /````typescript\nconst value = ```unsafe```;\n````/);
  assert.doesNotMatch(output.text, /<!-- marker-->injected/);
  assert.doesNotMatch(output.text, /<!-- seori-finding:fp-->injected/);
  assert.match(output.text, /<!-- marker-injected next -->/);
});
