import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewGateCriterion, ReviewGateFatalBlocker } from "./review-gate.js";
import {
  buildChangedLineEvidence,
  buildReviewEvidenceCandidates,
  formatReviewEvidenceCandidates,
  isGroundedFatalBlocker,
  isGroundedTestEvidence,
  isGroundedTestEvidenceBundle,
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

test("큰 Godot smoke에서는 AC와 직접 겹치는 후반 assertion을 후보 예산 안에 우선 포함한다", () => {
  const file = "tools/core_probe.gd";
  const noise = Array.from(
    { length: 180 },
    (_, index) => `\t_check(noise_${index} == ${index}, "unrelated probe ${index}")`,
  );
  const target =
    '_check(sim_8h == 28800.0, "AC-2: plan(28800, cap) reflects the full 8h absence as the settlement window")';
  const source = [
    "extends SceneTree",
    "var failures := 0",
    "func _init() -> void:",
    "\t_run()",
    "func _run() -> void:",
    ...noise,
    `\t${target}`,
    "\tquit(1 if failures > 0 else 0)",
  ].join("\n");

  const unranked = buildReviewEvidenceCandidates(
    { [file]: source },
    { maxChars: 2_000 },
  );
  const ranked = buildReviewEvidenceCandidates(
    { [file]: source },
    {
      maxChars: 2_000,
      acceptanceCriteria: [
        "첫 조건",
        "`offline_settlement.plan()`이 8시간 부재를 정산하며 sim=28800으로 반영한다.",
      ],
    },
  );

  assert.equal(unranked.some((candidate) => candidate.quote === target), false);
  assert.equal(ranked.some((candidate) => candidate.quote === target), true);
});

test("Contributor가 지정한 대형 Godot 테스트와 AC 주석은 prompt 파일 예산과 무관하게 우선 검색된다", () => {
  const file = "tests/main_ui_smoke_runner.gd";
  const noise = Array.from(
    { length: 220 },
    (_, index) => `\t_expect_true(noise_${index}, "unrelated ${index}")`,
  );
  const target =
    '_expect_true(scene.enemy_hp < 999.0, "combat resumes after the regression cinematic ends")';
  const source = [
    "extends SceneTree",
    "var failures := 0",
    "func _init() -> void:",
    "\t_test_regression_buttons_signal()",
    "\tquit(1 if failures > 0 else 0)",
    "func _test_regression_buttons_signal() -> void:",
    "\t# [#206][AC-2] 연출 중 전투 틱 정지와 종료 후 재개를 검증한다.",
    ...noise,
    `\t${target}`,
  ].join("\n");
  const candidates = buildReviewEvidenceCandidates(
    { [file]: source },
    {
      maxChars: 2_500,
      acceptanceCriteria: ["연출 중 전투 틱이 정지되고 종료 후 재개된다."],
      referenceText: `${file}::_test_regression_buttons_signal의 enemy_hp assertion을 확인해 주세요.`,
    },
  );
  const selected = candidates.find((candidate) => candidate.quote === target);

  assert.ok(selected);
  assert.match(selected.contextHint || "", /AC-2/);
});

test("로컬 테스트 helper 호출을 따라 설명용 dotted 설정 경로를 결속한다", () => {
  const file = "functions/src/saveSchema.test.ts";
  const source = [
    "function normalizeSettings(settings: Record<string, unknown>) {",
    "  return normalizeSaveState({ system: { settings } }).save.system.settings;",
    "}",
    'test("회귀 시네마틱 토글을 라운드트립한다", () => {',
    "  assert.equal(normalizeSettings({ regressionCinematic: false }).regressionCinematic, false);",
    "});",
  ].join("\n");
  const evidence = {
    file,
    testName: "회귀 시네마틱 토글을 라운드트립한다",
    assertionQuote:
      "assert.equal(normalizeSettings({ regressionCinematic: false }).regressionCinematic, false);",
    explanationKo: "회귀 시네마틱 설정값이 라운드트립 뒤에도 유지됩니다.",
  };

  assert.equal(
    isGroundedTestEvidence(
      context({ [file]: source }),
      criterion("`system.settings`에 회귀 시네마틱 토글이 저장·복원된다."),
      evidence,
    ),
    true,
  );
});

test("#227 다중 AC 근거는 대형 smoke와 TypeScript helper 사이에서도 모두 후보 예산에 남는다", () => {
  const noise = Array.from(
    { length: 210 },
    (_, index) => `\t_expect_true(noise_${index}, "unrelated smoke ${index}")`,
  );
  const uiComponentsFile = "tests/ui_components_runner.gd";
  const mainUiFile = "tests/main_ui_smoke_runner.gd";
  const gddFile = "tests/gdd_acceptance_runner.gd";
  const schemaFile = "functions/src/saveSchema.test.ts";
  const sources = {
    [uiComponentsFile]: [
      "extends SceneTree",
      "var failures := 0",
      "func _init() -> void:",
      "\t_test_regression_sequence()",
      "\tquit(1 if failures > 0 else 0)",
      "func _test_regression_sequence() -> void:",
      "\t# [AC-1] 회귀 연출 sequence 완료 뒤 상태를 원복한다.",
      ...noise,
      '\t_expect_true(sequence.rewind_count == 1, "regression sequence rewinds exactly once")',
      '\t_expect_true(aura.animation == "idle", "aura animation returns to idle")',
      '\t_expect_true(whiteout.modulate.a == 0.0, "whiteout is cleared after sequence")',
    ].join("\n"),
    [mainUiFile]: [
      "extends SceneTree",
      "var failures := 0",
      "func _init() -> void:",
      "\t_test_regression_runtime()",
      "\t_test_regression_toggle_off()",
      "\tquit(1 if failures > 0 else 0)",
      "func _test_regression_runtime() -> void:",
      "\t# [AC-2] 연출 중 전투를 정지하고 종료 뒤 재개한다.",
      '\t_expect_true(scene.combat_frozen, "combat remains frozen during regression cinematic")',
      '\t_expect_true(scene.enemy_hp < 999.0, "combat resumes after regression cinematic ends")',
      "func _test_regression_toggle_off() -> void:",
      "\t# [AC-4] 사용자 설정이 OFF면 연출을 건너뛴다.",
      '\t_expect_true(scene.regression_skip_count == 1, "dedicated toggle OFF skips regression cinematic")',
    ].join("\n"),
    [gddFile]: [
      "extends SceneTree",
      "var failures := 0",
      "func _init() -> void:",
      "\t_test_regression_reset_contract()",
      "\tquit(1 if failures > 0 else 0)",
      "func _test_regression_reset_contract() -> void:",
      "\t# [AC-3] GDD 회귀 연출은 tower와 stage를 함께 초기화한다.",
      '\t_expect_true(state.tower == 0, "gdd regression resets tower")',
      '\t_expect_true(state.stage == 0, "gdd regression resets stage")',
    ].join("\n"),
    [schemaFile]: [
      "function normalizeSettings(settings: Record<string, unknown>) {",
      "  return normalizeSaveState({ system: { settings } }).save.system.settings;",
      "}",
      'test("regression cinematic setting round-trip", () => {',
      "  // [AC-5] system.settings 값을 저장하고 복원한다.",
      "  assert.equal(normalizeSettings({ regressionCinematic: false }).regressionCinematic, false);",
      "});",
    ].join("\n"),
  };
  const candidates = buildReviewEvidenceCandidates(sources, {
    acceptanceCriteria: [
      "Regression Cinematic sequence가 완료되면 상태와 시각 효과가 원복된다.",
      "연출 중 전투가 정지하고 종료 뒤 다시 진행된다.",
      "GDD 회귀 연출은 tower와 stage를 초기화한다.",
      "전용 토글 OFF에서는 회귀 연출을 건너뛴다.",
      "`system.settings.regressionCinematic` 설정이 저장·복원된다.",
    ],
    referenceText: [
      `AC-1 ${uiComponentsFile}::_test_regression_sequence sequence rewind aura whiteout`,
      `AC-2 ${mainUiFile}::_test_regression_runtime combat frozen resumes`,
      `AC-3 ${gddFile}::_test_regression_reset_contract tower stage`,
      `AC-4 ${mainUiFile}::_test_regression_toggle_off dedicated toggle OFF skip`,
      `AC-5 ${schemaFile} normalizeSettings regressionCinematic system.settings`,
    ].join("\n"),
  });
  const quotes = candidates.map((candidate) => candidate.quote).join("\n");

  for (const expected of [
    "regression sequence rewinds exactly once",
    "aura animation returns to idle",
    "whiteout is cleared after sequence",
    "combat remains frozen during regression cinematic",
    "combat resumes after regression cinematic ends",
    "dedicated toggle OFF skips regression cinematic",
    "gdd regression resets tower",
    "gdd regression resets stage",
    "normalizeSettings({ regressionCinematic: false })",
  ]) {
    assert.match(quotes, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.ok(formatReviewEvidenceCandidates(candidates).length <= 40_000);
});

test("Godot _expect_eq와 _expect_true bundle을 실행 assertion으로 검증한다", () => {
  const file = "tests/main_ui_smoke_runner.gd";
  const source = [
    "extends SceneTree",
    "var failures := 0",
    "func _init() -> void:",
    "\t_test_regression_buttons_signal()",
    "\tquit(1 if failures > 0 else 0)",
    "func _test_regression_buttons_signal() -> void:",
    '\t_expect_eq(scene.enemy_hp, 999.0, "combat tick is frozen while the regression cinematic plays")',
    '\t_expect_eq(scene.state["progress"]["towerIndex"], 1, "regression confirm resets to tower 1")',
    '\t_expect_eq(scene.state["progress"]["stageIndex"], 1, "regression confirm signal resets stage")',
    '\t_expect_true(scene.enemy_hp < 999.0, "combat resumes after the regression cinematic ends")',
  ].join("\n");
  const sourceQuote =
    "연출 중 전투 틱이 정지되고, 연출 종료 후 Tower 1 Stage 1 상태가 정확히 반영된다.";
  const evidence = [
    {
      file,
      line: 7,
      testName: "_test_regression_buttons_signal",
      assertionQuote:
        '_expect_eq(scene.enemy_hp, 999.0, "combat tick is frozen while the regression cinematic plays")',
      explanationKo: "연출 중 전투 틱 정지를 검증합니다.",
    },
    {
      file,
      line: 8,
      testName: "_test_regression_buttons_signal",
      assertionQuote:
        '_expect_eq(scene.state["progress"]["towerIndex"], 1, "regression confirm resets to tower 1")',
      explanationKo: "Tower 1 상태를 검증합니다.",
    },
    {
      file,
      line: 9,
      testName: "_test_regression_buttons_signal",
      assertionQuote:
        '_expect_eq(scene.state["progress"]["stageIndex"], 1, "regression confirm signal resets stage")',
      explanationKo: "Stage 1 상태를 검증합니다.",
    },
    {
      file,
      line: 10,
      testName: "_test_regression_buttons_signal",
      assertionQuote:
        '_expect_true(scene.enemy_hp < 999.0, "combat resumes after the regression cinematic ends")',
      explanationKo: "연출 종료 후 전투 재개를 검증합니다.",
    },
  ];
  const candidates = buildReviewEvidenceCandidates(
    { [file]: source },
    { acceptanceCriteria: [sourceQuote] },
  );
  const reviewContext = {
    currentHeadFileContents: { [file]: source },
    visibleChangedPatches: {},
    evidenceCandidates: candidates,
  };
  const acceptance = criterion(sourceQuote);

  assert.equal(isGroundedTestEvidence(reviewContext, acceptance, evidence[0]!), true);
  assert.equal(isGroundedTestEvidenceBundle(reviewContext, acceptance, evidence), true);
});

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

test("#179 Python 멀티라인 assertion은 전체 호출과 표기 차이를 current HEAD 근거로 결속한다", () => {
  const file = "tools/check_release_workflow_contract.py";
  const source = [
    "class ReleaseWorkflowContractTest(unittest.TestCase):",
    "    def test_deploy_all_forwards_google_play_inputs(self) -> None:",
    '        reusable_path = ("jobs", "google-play", "with")',
    "        self.assertEqual(",
    "            {",
    '                "track": scalar(self.workflow_lines, reusable_path, "track"),',
    '                "release_status": scalar(self.workflow_lines, reusable_path, "release_status"),',
    "            },",
    "            {",
    '                "track": "${{ inputs.google_play_track }}",',
    '                "release_status": "${{ inputs.google_play_release_status }}",',
    "            },",
    "        )",
  ].join("\n");
  const sourceQuote =
    "`Deploy All`의 `jobs.google-play.with`가 `track: ${{ inputs.google_play_track }}`와 `release_status: ${{ inputs.google_play_release_status }}`를 reusable workflow에 전달합니다.";
  const candidates = buildReviewEvidenceCandidates(
    { [file]: source },
    { acceptanceCriteria: [sourceQuote] },
  );
  const candidate = candidates.find((item) =>
    item.testName === "test_deploy_all_forwards_google_play_inputs" &&
    item.quote.startsWith("self.assertEqual("));

  assert.ok(candidate);
  assert.match(candidate.quote, /inputs\.google_play_track/);
  assert.match(candidate.quote, /inputs\.google_play_release_status/);
  assert.equal(
    isGroundedTestEvidence(
      { currentHeadFileContents: { [file]: source }, visibleChangedPatches: {}, evidenceCandidates: candidates },
      criterion(sourceQuote),
      {
        file,
        line: candidate.line,
        testName: candidate.testName,
        assertionQuote: candidate.quote,
        explanationKo: "Deploy All 입력 전달 계약 전체를 비교합니다.",
      },
    ),
    true,
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

test("대형 테스트 인벤토리와 긴 reference에서도 evidence 후보 정렬이 이벤트 루프를 분 단위로 막지 않는다", () => {
  // happy-farm#388 회귀: comparator 안에서 reference 전체를 재토큰화하면
  // 정렬 한 번에 수 분이 걸려 liveness probe가 봇을 재시작시킨다.
  const contents: Record<string, string> = {};
  for (let fileIndex = 0; fileIndex < 30; fileIndex += 1) {
    const lines = [`describe("suite ${fileIndex}", () => {`];
    for (let testIndex = 0; testIndex < 20; testIndex += 1) {
      lines.push(`test("sheet impression guard ${fileIndex}-${testIndex}", () => {`);
      for (let assertIndex = 0; assertIndex < 4; assertIndex += 1) {
        lines.push(
          `  expect(trackAdRewardImpression_${fileIndex}_${testIndex}_${assertIndex}(gameState, sheetType)).toBe(${assertIndex});`,
        );
      }
      lines.push("});");
    }
    lines.push("});");
    contents[`apps/ait/src/__tests__/case${fileIndex}.test.tsx`] = lines.join("\n");
  }
  const referenceText = Array.from(
    { length: 250 },
    (_, index) =>
      `- contributor_note_${index}: sheet impression collection_screen guard trackAdRewardImpression gameState 재발화 없음 검증 ${index}`,
  ).join("\n");
  const acceptanceCriteria = [
    "같은 시트가 열려 있는 동안 gameState가 갱신되어도 `trackAdRewardImpression`이 추가 발화되지 않는다.",
    "시트를 닫았다가 다시 열면 impression이 다시 1회 발화된다.",
    "shop 시트 열림 1회당 impression은 정확히 2건 발화된다.",
    "welcomeBack impression의 기존 가드 동작에 회귀가 없다.",
    "재발화 없음을 검증하는 테스트를 추가한다.",
  ];

  const start = performance.now();
  const candidates = buildReviewEvidenceCandidates(contents, {
    acceptanceCriteria,
    referenceText,
  });
  const elapsedMs = performance.now() - start;

  assert.ok(candidates.length > 0);
  // 수정 전 구현은 이 입력에서 분 단위로 걸린다. CPU가 느린 러너를 감안해
  // 넉넉히 20초를 상한으로 둔다.
  assert.ok(
    elapsedMs < 20_000,
    `evidence 후보 정렬이 ${Math.round(elapsedMs)}ms 걸렸습니다 (상한 20000ms)`,
  );
});
