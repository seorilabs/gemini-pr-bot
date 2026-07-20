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

test("Godot SceneTree probe의 _run과 _check는 실패 exit가 있을 때만 실행 테스트 근거다", () => {
  const file = "tools/core_probe.gd";
  const geneticsFile = "packages/product-core/src/domain/genetics.gd";
  const source = [
    "extends SceneTree",
    'const Genetics := preload("res://packages/product-core/src/domain/genetics.gd")',
    'const Collections := preload("res://packages/product-core/src/domain/collections.gd")',
    "var _failures: Array = []",
    "func _initialize() -> void:",
    "\t_run()",
    "func _check(cond: bool, msg: String) -> void:",
    "\tif not cond:",
    "\t\t_failures.append(msg)",
    "func _run() -> void:",
    '\t_check(Genetics.morph_phenotype(["hypo", "hypo"]) == "super_hypo" and Genetics.morph_phenotype(["hypo", "normal"]) == "hypo", "super hypo homo vs het")',
    '\t_check(Collections.morph_total() == 9, "collection morph total")',
    "\tGenetics.normalize_lizard_morph(super_legacy)",
    '\t_check(super_legacy.genotype == ["snow", "snow"], "legacy normalize")',
    "\tif not _failures.is_empty():",
    "\t\tquit(1)",
    "\tquit(0)",
  ].join("\n");
  const geneticsSource = [
    "static func normalize_lizard_morph(visual: Dictionary) -> int:",
    '\tvisual["genotype"] = normalize_genotype(visual.get("genotype", null), String(visual.get("morph_id", "normal")))',
    "\treturn OK",
    "static func unrelated_helper() -> void:",
    "\thidden_unrelated_identifier()",
  ].join("\n");
  const reviewContext = context({ [file]: source, [geneticsFile]: geneticsSource });

  assert.equal(
    isGroundedTestEvidence(
      reviewContext,
      criterion('`morph_phenotype([hypo,hypo])` → `super_hypo`, `[hypo,normal]` → `hypo`'),
      {
        file,
        testName: "_run",
        assertionQuote: '_check(Genetics.morph_phenotype(["hypo", "hypo"]) == "super_hypo" and Genetics.morph_phenotype(["hypo", "normal"]) == "hypo", "super hypo homo vs het")',
      },
    ),
    true,
  );
  assert.equal(
    isGroundedTestEvidence(
      reviewContext,
      criterion('`collections.gd`의 `morph_total`이 9를 반환한다.'),
      {
        file,
        testName: "_run",
        assertionQuote: '_check(Collections.morph_total() == 9, "collection morph total")',
      },
    ),
    true,
  );
  assert.equal(
    isGroundedTestEvidence(
      reviewContext,
      criterion('`normalize_genotype`이 기존 세이브를 복원한다.'),
      {
        file,
        testName: "_run",
        assertionQuote: '_check(super_legacy.genotype == ["snow", "snow"], "legacy normalize")',
      },
    ),
    true,
  );
  assert.equal(
    isGroundedTestEvidence(
      reviewContext,
      criterion('`hidden_unrelated_identifier`가 호출된다.'),
      {
        file,
        testName: "_run",
        assertionQuote: '_check(super_legacy.genotype == ["snow", "snow"], "legacy normalize")',
      },
    ),
    false,
  );

  const noFailureExit = source.replace("\t\tquit(1)", "\t\tquit(0)");
  assert.equal(
    isGroundedTestEvidence(
      context({ [file]: noFailureExit }),
      criterion('`collections.gd`의 `morph_total`이 9를 반환한다.'),
      {
        file,
        testName: "_run",
        assertionQuote: '_check(Collections.morph_total() == 9, "collection morph total")',
      },
    ),
    false,
  );
  assert.equal(
    isGroundedTestEvidence(
      context({ "src/player.gd": source }),
      criterion('`collections.gd`의 `morph_total`이 9를 반환한다.'),
      {
        file: "src/player.gd",
        testName: "_run",
        assertionQuote: '_check(Collections.morph_total() == 9, "collection morph total")',
      },
    ),
    false,
  );
});

test("Godot _init 테스트와 조건문 기반 smoke assertion을 실행 근거로 인정한다", () => {
  const lucidFile = "tests/draw_rules_smoke.gd";
  const lucidSource = [
    "extends SceneTree",
    "var failures := 0",
    "func _init() -> void:",
    "\t_test_halfmove_clock_and_undo()",
    "\t_test_fifty_move_draw()",
    "\tquit(1 if failures > 0 else 0)",
    "func _test_halfmove_clock_and_undo() -> void:",
    "\t_expect(engine.halfmove_clock == 2, \"second quiet piece move increments halfmove clock\")",
    "func _test_fifty_move_draw() -> void:",
    "\t_expect(engine.status.get(\"reason\") == \"fifty_move\", \"fifty-move draw exposes canonical reason\")",
    "func _expect(condition: bool, message: String) -> void:",
    "\tif not condition:",
    "\t\tfailures += 1",
  ].join("\n");
  assert.equal(
    isGroundedTestEvidence(
      context({ [lucidFile]: lucidSource }),
      criterion("폰 이동과 포획은 하프무브 클록을 0으로, 그 외 수는 1씩 증가시킵니다."),
      {
        file: lucidFile,
        testName: "_test_halfmove_clock_and_undo",
        assertionQuote: '_expect(engine.halfmove_clock == 2, "second quiet piece move increments halfmove clock")',
        explanationKo: "조용한 기물 이동 시 클록이 증가하고, 폰 이동이나 포획 시 0으로 초기화됨을 검증합니다.",
      },
    ),
    true,
  );
  assert.equal(
    isGroundedTestEvidence(
      context({ [lucidFile]: lucidSource }),
      criterion("100 하프무브에서 fifty_move 무승부로 종료합니다."),
      {
        file: lucidFile,
        testName: "_test_fifty_move_draw",
        assertionQuote: '_expect(engine.status.get("reason") == "fifty_move", "fifty-move draw exposes canonical reason")',
        explanationKo: "100 하프무브에서 fifty_move 사유로 무승부가 종료됨을 검증합니다.",
      },
    ),
    true,
  );

  const foamFile = "godot/tests/smoke_scene.gd";
  const foamSource = [
    "extends SceneTree",
    "func _initialize() -> void:",
    "\t_run_smoke.call_deferred()",
    "func _run_smoke() -> void:",
    "\tif kind not in expected_dirt_by_level[gated_level]:",
    "\t\t_fail(\"spawned locked dirt\")",
    "func _fail(message: String) -> void:",
    "\tquit(1)",
  ].join("\n");
  assert.equal(
    isGroundedTestEvidence(
      context({ [foamFile]: foamSource }),
      criterion("`_spawn_dirt`가 초반 레벨에서 허용 종류만으로 type_pool을 구성한다."),
      {
        file: foamFile,
        testName: "_run_smoke",
        assertionQuote: "if kind not in expected_dirt_by_level[gated_level]:",
        explanationKo: "실제 _spawn_dirt 결과가 초반 레벨의 허용 type_pool만 사용하는지 검증합니다.",
      },
    ),
    true,
  );
});

test("Godot call_deferred 문자열 runner와 API 계약 smoke 호출을 실행 근거로 인정한다", () => {
  const file = "tools/headless_smoke.gd";
  const filler = Array.from({ length: 450 }, (_, index) => `\tvar filler_${index} := ${index}`);
  const source = [
    "extends SceneTree",
    "func _initialize() -> void:",
    '\tcall_deferred("_run")',
    "func _run() -> void:",
    ...filler,
    '\tmain._notifier.schedule("egg_hatch", 60, "테스트 알림", "본문")',
    '\tmain._notifier.cancel("egg_hatch")',
    '\tif main._notifier._resolve_plugin() != null:',
    '\t\t_fail("expected null fallback")',
    "func _fail(message: String) -> void:",
    "\tquit(1)",
  ].join("\n");
  const reviewContext = context({ [file]: source });

  assert.equal(
    isGroundedTestEvidence(
      reviewContext,
      criterion("Notifier 포트가 태그 인자를 받는 `schedule`/`cancel(tag)`로 확장된다."),
      {
        file,
        testName: "_run",
        assertionQuote: 'main._notifier.schedule("egg_hatch", 60, "테스트 알림", "본문")',
        explanationKo: "태그 기반 schedule과 cancel 포트 호출이 headless smoke에서 실행됩니다.",
      },
    ),
    true,
  );
  assert.equal(
    isGroundedTestEvidence(
      reviewContext,
      criterion("headless 환경에서 no-op 폴백이 유지된다."),
      {
        file,
        testName: "_run",
        assertionQuote: "if main._notifier._resolve_plugin() != null:",
        explanationKo: "플러그인이 없는 headless 환경에서 null 폴백을 검증합니다.",
      },
    ),
    true,
  );
  assert.equal(
    isGroundedTestEvidence(
      reviewContext,
      criterion("알림이 사용자에게 정확히 한 번 표시된다."),
      {
        file,
        testName: "_run",
        assertionQuote: 'main._notifier.schedule("egg_hatch", 60, "테스트 알림", "본문")',
        explanationKo: "알림 표시 횟수를 검증합니다.",
      },
    ),
    false,
  );
});

test("Godot test 함수의 if와 _fail 조합은 자연어 인수조건의 assertion 근거다", () => {
  const file = "godot/tests/dirt_progression_test.gd";
  const source = [
    "extends SceneTree",
    "func test_unlock_curve(DirtProgression: GDScript) -> bool:",
    "\tvar actual := DirtProgression.allowed_types_for_level(level)",
    "\tif actual != expected_dirt_by_level[level]:",
    "\t\t_fail(\"unexpected dirt unlocks\")",
    "\t\treturn false",
    "\treturn true",
  ].join("\n");
  assert.equal(
    isGroundedTestEvidence(
      context({ [file]: source }),
      criterion("레벨별 허용 오염 종류 커브를 정의한다."),
      {
        file,
        testName: "test_unlock_curve",
        assertionQuote: "if actual != expected_dirt_by_level[level]:",
        explanationKo: "레벨별 허용 오염 종류 커브가 기대 목록과 같은지 검증합니다.",
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
  const godotFile = "tools/vacuous_probe.gd";
  const godotSource = [
    "extends SceneTree",
    "func _initialize() -> void:",
    "\t_run()",
    "func _run() -> void:",
    '\t_check(true, "always passes")',
    "\tquit(1)",
  ].join("\n");
  assert.equal(
    isGroundedTestEvidence(context({ [godotFile]: godotSource }), criterion("항상 참이다."), {
      file: godotFile,
      testName: "_run",
      assertionQuote: '_check(true, "always passes")',
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
