import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewGateCriterion, ReviewGateFatalBlocker } from "./review-gate.js";
import {
  buildChangedLineEvidence,
  isGroundedFatalBlocker,
  isGroundedTestEvidence,
  sameFatalBlockerSet,
  type ReviewGroundingContext,
} from "./review-grounding.js";

function context(
  currentHeadFileContents: Record<string, string>,
  visibleChangedPatches: Record<string, string> = {},
): ReviewGroundingContext {
  return { currentHeadFileContents, visibleChangedPatches };
}

function criterion(sourceQuote: string): ReviewGateCriterion {
  return {
    id: "AC-1",
    sourceQuote,
    testability: "automated",
    coverage: "covered",
    testEvidence: null,
  };
}

test("test evidence requires a real assertion near a nontrivial test name", () => {
  const file = "src/save.test.ts";
  const source = [
    'test("저장값을 복원한다", () => {',
    "  const restored = restore(saved);",
    "  assert.equal(restored.value, expected);",
    "});",
  ].join("\n");
  const reviewContext = context({ [file]: source });

  assert.equal(
    isGroundedTestEvidence(
      reviewContext,
      criterion("저장값을 복원한다."),
      {
        file,
        testName: "저장값을 복원한다",
        assertionQuote: "assert.equal(restored.value, expected);",
      },
    ),
    true,
  );
  assert.equal(
    isGroundedTestEvidence(reviewContext, criterion("저장 후 값이 유지된다."), {
      file,
      testName: "t",
      assertionQuote: "=",
    }),
    false,
  );
});

test("test evidence supports XCTest and .NET test naming conventions", () => {
  assert.equal(
    isGroundedTestEvidence(
      context({
        "MyAppTests/FooTests.swift":
          "func testRestore() {\n  XCTAssertEqual(restored.value, expected)\n}",
      }),
      criterion("복원된 `restored.value`가 기대값과 같다."),
      {
        file: "MyAppTests/FooTests.swift",
        testName: "testRestore",
        assertionQuote: "XCTAssertEqual(restored.value, expected)",
      },
    ),
    true,
  );
  assert.equal(
    isGroundedTestEvidence(
      context({
        "Project.Tests/FooTests.cs":
          "[Test]\npublic void RestoresValue() {\n  Assert.Equal(expected, restored.Value);\n}",
      }),
      criterion("복원된 `restored.Value`가 기대값과 같다."),
      {
        file: "Project.Tests/FooTests.cs",
        testName: "RestoresValue",
        assertionQuote: "Assert.Equal(expected, restored.Value);",
      },
    ),
    true,
  );
});

test("generic declarations and cross-language semantic guesses cannot ground a criterion", () => {
  const file = "src/account.test.ts";
  const source = [
    'test("deletes unrelated admin flag", () => {',
    "  expect(adminEnabled).toBe(false);",
    "});",
  ].join("\n");
  const reviewContext = context({ [file]: source });

  assert.equal(
    isGroundedTestEvidence(reviewContext, criterion("계정 저장 후 복원"), {
      file,
      testName: "test",
      assertionQuote: "expect(adminEnabled).toBe(false);",
    }),
    false,
  );
  assert.equal(
    isGroundedTestEvidence(reviewContext, criterion("계정 저장 후 복원"), {
      file,
      testName: "deletes unrelated admin flag",
      assertionQuote: "expect(adminEnabled).toBe(false);",
    }),
    false,
  );
});

test("a bare comparison that cannot fail the test is not assertion evidence", () => {
  const file = "src/save.test.ts";
  const source = [
    'test("저장 상태를 계산한다", () => {',
    "  const same = restored.value === expected;",
    "});",
  ].join("\n");
  assert.equal(
    isGroundedTestEvidence(context({ [file]: source }), criterion("저장 상태를 계산한다."), {
      file,
      testName: "저장 상태를 계산한다",
      assertionQuote: "restored.value === expected",
    }),
    false,
  );
});

test("vacuous assertions and assertion-shaped strings are not test evidence", () => {
  const vacuousFile = "src/vacuous.test.ts";
  const stringFile = "src/string.test.ts";
  const reviewContext = context({
    [vacuousFile]: [
      'test("저장 후 다시 열어도 값이 유지된다", () => {',
      "  assert.equal(1, 1);",
      "});",
    ].join("\n"),
    [stringFile]: [
      'test("저장 후 다시 열어도 값이 유지된다", () => {',
      "  console.log('assert.equal(loadValue(), savedValue);');",
      "});",
    ].join("\n"),
  });
  const acceptance = criterion("저장 후 다시 열어도 값이 유지된다");

  assert.equal(
    isGroundedTestEvidence(reviewContext, acceptance, {
      file: vacuousFile,
      testName: "저장 후 다시 열어도 값이 유지된다",
      assertionQuote: "assert.equal(1, 1);",
    }),
    false,
  );
  assert.equal(
    isGroundedTestEvidence(reviewContext, acceptance, {
      file: stringFile,
      testName: "저장 후 다시 열어도 값이 유지된다",
      assertionQuote: "assert.equal(loadValue(), savedValue);",
    }),
    false,
  );
});

test("a partial keyword overlap does not prove the full acceptance behavior", () => {
  const file = "src/save.test.ts";
  const source = [
    'test("저장 버튼의 값이 표시된다", () => {',
    '  assert.equal(saveButton.value, "hello");',
    "});",
  ].join("\n");
  assert.equal(
    isGroundedTestEvidence(
      context({ [file]: source }),
      criterion("저장 후 다시 열어도 값이 유지된다."),
      {
        file,
        testName: "저장 버튼의 값이 표시된다",
        assertionQuote: 'assert.equal(saveButton.value, "hello");',
      },
    ),
    false,
  );
});

test("commented and explicitly skipped tests cannot be used as evidence", () => {
  const commentedFile = "src/commented.test.ts";
  const skippedFile = "src/skipped.test.ts";
  const disabledFile = "Project.Tests/DisabledTests.cs";
  const reviewContext = context({
    [commentedFile]: [
      'test("저장값을 복원한다", () => {',
      "  // assert.equal(restored.value, expected);",
      "});",
    ].join("\n"),
    [skippedFile]: [
      'test("저장값을 복원한다", { skip: true }, () => {',
      "  assert.equal(restored.value, expected);",
      "});",
    ].join("\n"),
    [disabledFile]: [
      "[Test]",
      "[Ignore]",
      "public void RestoresValue() {",
      "  Assert.Equal(expected, restored.Value);",
      "}",
    ].join("\n"),
  });
  const criterionValue = criterion("`restored.value`를 복원한다.");

  assert.equal(
    isGroundedTestEvidence(reviewContext, criterionValue, {
      file: commentedFile,
      testName: "저장값을 복원한다",
      assertionQuote: "assert.equal(restored.value, expected);",
    }),
    false,
  );
  assert.equal(
    isGroundedTestEvidence(reviewContext, criterionValue, {
      file: skippedFile,
      testName: "저장값을 복원한다",
      assertionQuote: "assert.equal(restored.value, expected);",
    }),
    false,
  );
  assert.equal(
    isGroundedTestEvidence(reviewContext, criterion("`restored.Value`를 복원한다."), {
      file: disabledFile,
      testName: "RestoresValue",
      assertionQuote: "Assert.Equal(expected, restored.Value);",
    }),
    false,
  );
});

test("commented test blocks, skipped suites, and unregistered helpers are not executable tests", () => {
  const commentedFile = "src/legacy.test.ts";
  const skippedSuiteFile = "src/skipped-suite.test.ts";
  const helperFile = "src/helper.test.ts";
  const reviewContext = context({
    [commentedFile]: [
      "/* disabled legacy test",
      'test("restartLoad keeps savedValue", () => {',
      "  assert.equal(restartLoad(), savedValue);",
      "});",
      "*/",
    ].join("\n"),
    [skippedSuiteFile]: [
      'describe.skip("legacy", () => {',
      "  beforeEach(() => setup());",
      "  const fixture = createFixture();",
      "  configure(fixture);",
      "  prepare(fixture);",
      '  test("restartLoad keeps savedValue", () => {',
      "    assert.equal(restartLoad(), savedValue);",
      "  });",
      "});",
    ].join("\n"),
    [helperFile]: [
      "function verifyRestartLoadHelper() {",
      "  assert.equal(restartLoad(), savedValue);",
      "}",
    ].join("\n"),
  });
  const acceptance = criterion("Calling `restartLoad` keeps `savedValue`.");
  const evidence = {
    testName: "restartLoad keeps savedValue",
    assertionQuote: "assert.equal(restartLoad(), savedValue);",
  };

  assert.equal(
    isGroundedTestEvidence(reviewContext, acceptance, { file: commentedFile, ...evidence }),
    false,
  );
  assert.equal(
    isGroundedTestEvidence(reviewContext, acceptance, { file: skippedSuiteFile, ...evidence }),
    false,
  );
  assert.equal(
    isGroundedTestEvidence(reviewContext, acceptance, {
      file: helperFile,
      testName: "verifyRestartLoadHelper",
      assertionQuote: evidence.assertionQuote,
    }),
    false,
  );
});

test("a test name cannot borrow an assertion from a later test block", () => {
  const file = "src/account.test.ts";
  const source = [
    'test("저장 조건", () => {',
    "  save(account);",
    "});",
    'test("삭제 조건", () => {',
    "  assert.equal(deleted, true);",
    "});",
  ].join("\n");
  assert.equal(
    isGroundedTestEvidence(
      context({ [file]: source }),
      criterion("계정을 저장한다."),
      {
        file,
        testName: "저장 조건",
        assertionQuote: "assert.equal(deleted, true);",
      },
    ),
    false,
  );
});

test("a fatal blocker needs a visible added root and an ordered direct terminal outcome", () => {
  const file = "src/save.ts";
  const source = [
    "export function save() {",
    "  cache.clear();",
    "  throw new Error('fatal');",
    "}",
  ].join("\n");
  const patch = [
    "@@ -1,2 +1,4 @@",
    " export function save() {",
    "+  cache.clear();",
    "+  throw new Error('fatal');",
    " }",
  ].join("\n");
  const reviewContext = context({ [file]: source }, { [file]: patch });
  const blocker: ReviewGateFatalBlocker = {
    file,
    line: 3,
    codeQuote: "throw new Error('fatal');",
    outcome: "deterministic_crash",
    trigger: "사용자가 저장을 실행한다.",
    causalChain: "저장 진입 -> 캐시 제거 -> 확정 예외",
    causalEvidence: [
      { file, line: 2, codeQuote: "cache.clear();" },
      { file, line: 3, codeQuote: "throw new Error('fatal');" },
    ],
  };

  assert.equal(
    isGroundedFatalBlocker(reviewContext, buildChangedLineEvidence(reviewContext.visibleChangedPatches), blocker),
    true,
  );
});

test("safe deny rules and ordinary false returns cannot be fatal terminal evidence", () => {
  const flowFile = "src/flow.ts";
  const rulesFile = "firestore.rules";
  const flowSource = "export function run() {\n  audit();\n  return false;\n}";
  const flowPatch = "@@ -1,1 +1,4 @@\n+export function run() {\n+  audit();\n+  return false;\n+}";
  const rulesSource = "match /users/{id} {\n  audit();\n  allow read: if false;\n}";
  const rulesPatch = "@@ -1,1 +1,4 @@\n+match /users/{id} {\n+  audit();\n+  allow read: if false;\n+}";
  const reviewContext = context(
    { [flowFile]: flowSource, [rulesFile]: rulesSource },
    { [flowFile]: flowPatch, [rulesFile]: rulesPatch },
  );
  const changed = buildChangedLineEvidence(reviewContext.visibleChangedPatches);

  assert.equal(
    isGroundedFatalBlocker(reviewContext, changed, {
      file: flowFile,
      line: 3,
      codeQuote: "return false;",
      outcome: "primary_flow_unusable",
      trigger: "사용자가 핵심 흐름을 실행한다.",
      causalChain: "실행 진입 -> 감사 -> false 반환",
      causalEvidence: [
        { file: flowFile, line: 2, codeQuote: "audit();" },
        { file: flowFile, line: 3, codeQuote: "return false;" },
      ],
    }),
    false,
  );
  assert.equal(
    isGroundedFatalBlocker(reviewContext, changed, {
      file: rulesFile,
      line: 3,
      codeQuote: "allow read: if false;",
      outcome: "exploitable_security_or_privacy_exposure",
      trigger: "외부 사용자가 사용자 문서를 읽는다.",
      causalChain: "읽기 요청 -> 감사 -> 읽기 규칙",
      causalEvidence: [
        { file: rulesFile, line: 2, codeQuote: "audit();" },
        { file: rulesFile, line: 3, codeQuote: "allow read: if false;" },
      ],
    }),
    false,
  );
});

test("unrelated normal lines, config roots, and invisible patches cannot become fatal", () => {
  const productFile = "src/ok.ts";
  const productSource = "export function ok() {\n  cache.clear();\n  return true;\n}";
  const productPatch = "@@ -1,2 +1,3 @@\n export function ok() {\n+  cache.clear();\n+  return true;\n }";
  const fabricated: ReviewGateFatalBlocker = {
    file: productFile,
    line: 2,
    codeQuote: "cache.clear();",
    outcome: "primary_flow_unusable",
    trigger: "사용자가 정상 동작을 실행한다.",
    causalChain: "정상 진입 -> 캐시 제거 -> 핵심 흐름 사용 불가",
    causalEvidence: [
      { file: productFile, line: 2, codeQuote: "cache.clear();" },
      { file: productFile, line: 3, codeQuote: "return true;" },
    ],
  };
  const visible = context({ [productFile]: productSource }, { [productFile]: productPatch });
  assert.equal(
    isGroundedFatalBlocker(visible, buildChangedLineEvidence(visible.visibleChangedPatches), fabricated),
    false,
  );
  assert.equal(
    isGroundedFatalBlocker(
      visible,
      buildChangedLineEvidence(visible.visibleChangedPatches),
      {
        ...fabricated,
        outcome: "permanent_data_loss_or_corruption",
        causalEvidence: [
          { file: productFile, line: 1, codeQuote: "export function ok() {" },
          { file: productFile, line: 2, codeQuote: "cache.clear();" },
        ],
      },
    ),
    false,
  );

  const configFile = "package.json";
  const configPatch = '@@ -1,1 +1,2 @@\n {\n+  "start": "exit 1"';
  const configBlocker: ReviewGateFatalBlocker = {
    ...fabricated,
    file: configFile,
    line: 2,
    codeQuote: '"start": "exit 1"',
    outcome: "deterministic_crash",
    causalEvidence: [
      { file: configFile, line: 1, codeQuote: "{" },
      { file: configFile, line: 2, codeQuote: '"start": "exit 1"' },
    ],
  };
  const configContext = context(
    { [configFile]: '{\n  "start": "exit 1"\n}' },
    { [configFile]: configPatch },
  );
  assert.equal(
    isGroundedFatalBlocker(
      configContext,
      buildChangedLineEvidence(configContext.visibleChangedPatches),
      configBlocker,
    ),
    false,
  );

  const invisibleContext = context({ [productFile]: productSource });
  assert.equal(
    isGroundedFatalBlocker(
      invisibleContext,
      buildChangedLineEvidence(invisibleContext.visibleChangedPatches),
      fabricated,
    ),
    false,
  );
});

test("fatal confirmation requires the exact same nonempty signature set", () => {
  const blocker: ReviewGateFatalBlocker = {
    file: "src/save.ts",
    line: 3,
    codeQuote: "throw new Error('fatal');",
    outcome: "deterministic_crash",
    trigger: "사용자가 저장을 실행한다.",
    causalChain: "저장 진입 -> 확정 예외",
    causalEvidence: [
      { file: "src/save.ts", line: 2, codeQuote: "save();" },
      { file: "src/save.ts", line: 3, codeQuote: "throw new Error('fatal');" },
    ],
  };
  assert.equal(sameFatalBlockerSet([blocker], [{ ...blocker }]), true);
  assert.equal(
    sameFatalBlockerSet([blocker], [{ ...blocker, line: 4 }]),
    false,
  );
  assert.equal(
    sameFatalBlockerSet(
      [blocker],
      [
        {
          ...blocker,
          causalEvidence: [
            { file: "src/save.ts", line: 1, codeQuote: "debugOnly();" },
            { file: "src/save.ts", line: 3, codeQuote: "throw new Error('fatal');" },
          ],
        },
      ],
    ),
    false,
  );
  assert.equal(sameFatalBlockerSet([], []), false);
});
