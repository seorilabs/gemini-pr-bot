import assert from "node:assert/strict";
import test from "node:test";
import type { MiniMaxAcceptanceCoverage } from "./minimax-review.js";
import {
  evaluateReviewAcceptanceCoverage,
  mergeStickyAcceptanceCoverage,
  normalizeReviewAcceptanceEvidence,
} from "./review-acceptance-coverage.js";
import {
  buildReviewEvidenceCandidates,
  type ReviewGroundingContext,
} from "./review-grounding.js";

function context(
  currentHeadFileContents: Record<string, string> = {},
  visibleChangedPatches: Record<string, string> = {},
): ReviewGroundingContext {
  return { currentHeadFileContents, visibleChangedPatches };
}

function coverage(
  acceptanceCriterion: string,
  overrides: Partial<MiniMaxAcceptanceCoverage> = {},
): MiniMaxAcceptanceCoverage {
  return {
    criterionId: "AC-1",
    acceptanceCriterion,
    status: "covered",
    testEvidence: null,
    ...overrides,
  };
}

test("명시적 인수조건이 없으면 테스트 근거 없이 완료된다", () => {
  const result = evaluateReviewAcceptanceCoverage(context(), [], []);

  assert.equal(result.complete, true, JSON.stringify(result.validationErrors));
  assert.deepEqual([...result.groundedAcceptanceCriteria], []);
  assert.deepEqual([...result.groundedTestEvidence], []);
  assert.deepEqual(result.validationErrors, []);
});

test("명시적으로 수동 검증을 요구하는 인수조건은 비차단이다", () => {
  for (const criterion of [
    "수동으로 화면을 확인한다.",
    "직접 확인 후 승인한다.",
    "육안으로 색상을 비교한다.",
    "시각 검증은 리뷰에 위임한다.",
    "실기기에서 진동을 확인한다.",
    "Manual QA is required.",
    "Visual inspection is required.",
    "Check this on a real device.",
  ]) {
    const result = evaluateReviewAcceptanceCoverage(context(), [criterion], []);
    assert.equal(result.complete, true, criterion);
    assert.deepEqual(result.validationErrors, [], criterion);
  }
});

test("missing과 unknown 커버리지는 완료로 판정하지 않는다", () => {
  const criterion = "저장 후 다시 열어도 값이 유지된다.";

  for (const status of ["missing", "unknown"] as const) {
    const result = evaluateReviewAcceptanceCoverage(
      context(),
      [criterion],
      [coverage(criterion, { status })],
    );
    assert.equal(result.complete, false, status);
    assert.deepEqual(result.validationErrors, [`AC-1: acceptance_coverage_${status}`]);
  }
});

test("host AC의 ID 순서와 원문이 정확히 일치해야 한다", () => {
  const criteria = ["첫 번째 값을 저장한다.", "두 번째 값을 복원한다."];
  const result = evaluateReviewAcceptanceCoverage(context(), criteria, [
    coverage(criteria[0]!, { criterionId: "AC-2" }),
    coverage("바꿔 쓴 인수조건", { criterionId: "AC-2" }),
  ]);

  assert.equal(result.complete, false);
  assert.deepEqual(result.validationErrors, [
    "AC-1: acceptance_coverage_identity_mismatch",
    "AC-2: acceptance_coverage_identity_mismatch",
  ]);
});

test("조작된 파일 또는 current HEAD와 다른 assertion 라인은 거부한다", () => {
  const criterion = "Calling `restartLoad` keeps `savedValue`.";
  const file = "src/save.test.ts";
  const source = [
    'test("restartLoad keeps savedValue", () => {',
    "  assert.equal(restartLoad(), savedValue);",
    "});",
  ].join("\n");
  const evidence = {
    file,
    line: 2,
    testName: "restartLoad keeps savedValue",
    assertionQuote: "assert.equal(restartLoad(), savedValue);",
    explanationKo: "재실행 후 저장값을 직접 비교합니다.",
  };

  const fabricatedPath = evaluateReviewAcceptanceCoverage(
    context({ [file]: source }),
    [criterion],
    [coverage(criterion, { testEvidence: { ...evidence, file: "src/fake.test.ts" } })],
  );
  const fabricatedLine = evaluateReviewAcceptanceCoverage(
    context({ [file]: source }),
    [criterion],
    [coverage(criterion, {
      testEvidence: { ...evidence, assertionQuote: "assert.equal(restartLoad(), otherValue);" },
    })],
  );

  assert.equal(fabricatedPath.complete, false);
  assert.equal(fabricatedLine.complete, false);
  assert.deepEqual(fabricatedPath.validationErrors, ["AC-1: test_evidence_line_not_grounded"]);
  assert.deepEqual(fabricatedLine.validationErrors, ["AC-1: test_evidence_line_not_grounded"]);
});

test("이름 있는 실행 테스트의 실제 assertion은 인수조건을 충족한다", () => {
  const criterion = "Calling `restartLoad` keeps `savedValue`.";
  const file = "src/save.test.ts";
  const source = [
    'test("restartLoad keeps savedValue", () => {',
    "  const restored = restartLoad();",
    "  assert.equal(restored, savedValue);",
    "});",
  ].join("\n");
  const result = evaluateReviewAcceptanceCoverage(
    context({ [file]: source }, { [file]: "@@ -0,0 +1,4 @@\n+test(...)" }),
    [criterion],
    [coverage(criterion, {
      testEvidence: {
        file,
        line: 3,
        testName: "restartLoad keeps savedValue",
        assertionQuote: "assert.equal(restored, savedValue);",
        explanationKo: "재실행 결과와 저장값을 직접 비교합니다.",
      },
    })],
  );

  assert.equal(result.complete, true);
  assert.deepEqual(
    [...result.groundedAcceptanceCriteria],
    [normalizeReviewAcceptanceEvidence(criterion)],
  );
  assert.deepEqual(
    result.groundedTestEvidence.get(normalizeReviewAcceptanceEvidence(criterion)),
    { file, line: 3, testName: "restartLoad keeps savedValue", kind: "test" },
  );
  assert.deepEqual(result.validationErrors, []);
});

test("모델 줄 번호가 어긋나도 현재 HEAD의 유일한 exact assertion으로 재결속한다", () => {
  const criterion = "Calling `restartLoad` keeps `savedValue`.";
  const file = "src/save.test.ts";
  const assertionQuote = "assert.equal(restored, savedValue);";
  const source = [
    'test("restartLoad keeps savedValue", () => {',
    "  const restored = restartLoad();",
    `  ${assertionQuote}`,
    "});",
  ].join("\n");
  const evidence = {
    file,
    line: 2,
    testName: "restartLoad keeps savedValue",
    assertionQuote,
    explanationKo: "재실행 결과와 저장값을 직접 비교합니다.",
  };

  const rebound = evaluateReviewAcceptanceCoverage(
    context({ [file]: source }),
    [criterion],
    [coverage(criterion, { testEvidence: evidence })],
  );
  const ambiguous = evaluateReviewAcceptanceCoverage(
    context({ [file]: `${source}\n${assertionQuote}` }),
    [criterion],
    [coverage(criterion, { testEvidence: evidence })],
  );

  assert.equal(rebound.complete, true);
  assert.equal(
    rebound.groundedTestEvidence.get(normalizeReviewAcceptanceEvidence(criterion))?.line,
    3,
  );
  assert.equal(ambiguous.complete, false);
  assert.deepEqual(ambiguous.validationErrors, ["AC-1: test_evidence_line_not_grounded"]);
});

test("Godot 멀티라인 assertion의 continuation 표기를 제외하고 현재 HEAD에 재결속한다", () => {
  const criterion = "레거시 알림 세이브가 `notify_pending` 구조로 무손실 이전된다.";
  const file = "tools/core_probe.gd";
  const assertionQuote =
    '_check((legacy_save.get("notify_pending", {}) as Dictionary).get("care_reminder", 0) == 111';
  const source = [
    "extends SceneTree",
    "var failures := 0",
    "func _initialize() -> void:",
    "\t_run()",
    "func _run() -> void:",
    "\tvar legacy_save := {}",
    `${assertionQuote} \\`,
    '\t\tand int(legacy_save.get("notify_last_fired", 0)) == 222, "lossless migration")',
    "\tquit(1 if failures > 0 else 0)",
    "func _check(condition: bool, message: String) -> void:",
    "\tif not condition:",
    "\t\tfailures += 1",
  ].join("\n");
  const result = evaluateReviewAcceptanceCoverage(
    context({ [file]: source }),
    [criterion],
    [coverage(criterion, {
      testEvidence: {
        file,
        line: 999,
        testName: "_run",
        assertionQuote,
        explanationKo: "레거시 예약과 발송 이력을 새 구조로 무손실 이전하는지 확인합니다.",
      },
    })],
  );

  assert.equal(result.complete, true);
  assert.equal(
    result.groundedTestEvidence.get(normalizeReviewAcceptanceEvidence(criterion))?.line,
    7,
  );
  assert.deepEqual(result.validationErrors, []);
});

test("Godot SceneTree _init에서 직접 실행되는 assertion을 테스트 근거로 인정한다", () => {
  const criterion = "난이도 1~9 각각 depth, blunder_prob, eval_noise를 정의한다.";
  const file = "tests/chess_engine_smoke.gd";
  const source = [
    "extends SceneTree",
    "var failures := 0",
    "func _init() -> void:",
    "\tfor level in range(1, 10):",
    "\t\tvar profile := engine.get_ai_difficulty_profile(level)",
    '\t\t_expect(profile.has("depth") and profile.has("blunder_prob") and profile.has("eval_noise"), "complete AI profile")',
    "\tquit(1 if failures > 0 else 0)",
    "func _expect(condition: bool, message: String) -> void:",
    "\tif not condition:",
    "\t\tfailures += 1",
  ].join("\n");
  const result = evaluateReviewAcceptanceCoverage(
    context({ [file]: source }),
    [criterion],
    [coverage(criterion, {
      testEvidence: {
        file,
        line: 6,
        testName: "_init",
        assertionQuote: '_expect(profile.has("depth") and profile.has("blunder_prob") and profile.has("eval_noise"), "complete AI profile")',
        explanationKo: "각 난이도 프로필이 세 필드를 모두 제공하는지 검증합니다.",
      },
    })],
  );

  assert.equal(result.complete, true);
  assert.equal(
    result.groundedTestEvidence.get(normalizeReviewAcceptanceEvidence(criterion))?.kind,
    "test",
  );
});

test("전체 입력 범위를 도는 실행 테스트의 loop와 내부 assertion을 매트릭스 근거로 인정한다", () => {
  const criterion = "테스트가 1~9 전체 프로필의 차이를 검증한다.";
  const file = "tests/chess_engine_smoke.gd";
  const source = [
    "extends SceneTree",
    "var failures := 0",
    "func _init() -> void:",
    "\tvar signatures := {}",
    "\tfor level in range(1, 10):",
    "\t\tvar profile := engine.get_ai_difficulty_profile(level)",
    "\t\tvar signature := str(profile)",
    '\t\t_expect(not signatures.has(signature), "AI profile is unique")',
    "\t\tsignatures[signature] = true",
    "\tquit(1 if failures > 0 else 0)",
    "func _expect(condition: bool, message: String) -> void:",
    "\tif not condition:",
    "\t\tfailures += 1",
  ].join("\n");
  const result = evaluateReviewAcceptanceCoverage(
    context({ [file]: source }),
    [criterion],
    [coverage(criterion, {
      testEvidence: {
        file,
        line: 5,
        testName: "_init",
        assertionQuote: "for level in range(1, 10):",
        explanationKo: "1부터 9까지 모든 프로필의 조합이 서로 다른지 검증합니다.",
      },
    })],
  );

  assert.equal(result.complete, true, JSON.stringify(result.validationErrors));
  assert.deepEqual(result.validationErrors, []);
});

test("함수의 특정 테이블 사용 조건은 현재 HEAD의 정확한 소스 연결 근거로 인정한다", () => {
  const criterion = "choose_ai_move()는 해당 프로필 테이블을 사용한다.";
  const file = "scripts/chess_engine.gd";
  const source = [
    "func get_ai_difficulty_profile(level: int) -> Dictionary:",
    "\treturn AI_DIFFICULTY_PROFILES[level]",
    "func choose_ai_move(level: int) -> Dictionary:",
    "\tvar profile := get_ai_difficulty_profile(level)",
    '\tvar depth := int(profile["depth"])',
  ].join("\n");
  const result = evaluateReviewAcceptanceCoverage(
    context({ [file]: source }),
    [criterion],
    [coverage(criterion, {
      testEvidence: {
        file,
        line: 4,
        testName: "choose_ai_move",
        assertionQuote: "var profile := get_ai_difficulty_profile(level)",
        explanationKo: "AI 이동 선택 함수가 난이도 프로필을 조회해 사용합니다.",
      },
    })],
  );

  assert.equal(result.complete, true);
  assert.deepEqual(
    result.groundedTestEvidence.get(normalizeReviewAcceptanceEvidence(criterion)),
    { file, line: 4, testName: "choose_ai_move", kind: "source" },
  );
});

test("lucid-chess PR 125의 다섯 인수조건을 현재 HEAD 테스트와 소스 근거로 모두 결속한다", () => {
  const criteria = [
    "난이도 1~9가 세 가지 강도 파라미터를 모두 정의합니다.",
    "AI 착수 선택이 프로필 테이블을 사용합니다.",
    "깊이는 비감소하고 실수 확률과 평가 노이즈는 감소합니다.",
    "인접 난이도에 동일한 전체 파라미터 조합이 없습니다.",
    "테스트가 9개 프로필의 차이를 검증합니다.",
  ];
  const testFile = "tests/chess_engine_smoke.gd";
  const sourceFile = "scripts/chess_engine.gd";
  const testSource = [
    "extends SceneTree",
    "var failures := 0",
    "func _init() -> void:",
    "\tvar previous_profile: Dictionary = {}",
    "\tvar profile_signatures := {}",
    "\tfor level in range(1, 10):",
    "\t\tvar profile: Dictionary = ai_test.get_ai_difficulty_profile(level)",
    '\t\t_expect(profile.has("depth") and profile.has("blunder_prob") and profile.has("eval_noise"), "level %d exposes a complete AI profile" % level)',
    '\t\tvar signature := "%d|%.3f|%.1f" % [int(profile["depth"]), float(profile["blunder_prob"]), float(profile["eval_noise"])]',
    '\t\t_expect(not profile_signatures.has(signature), "level %d AI profile is unique" % level)',
    "\t\tprofile_signatures[signature] = true",
    "\t\tif not previous_profile.is_empty():",
    '\t\t\t_expect(int(profile["depth"]) >= int(previous_profile["depth"]), "level %d search depth is monotonic" % level)',
    '\t\t\t_expect(float(profile["blunder_prob"]) < float(previous_profile["blunder_prob"]), "level %d blunder probability decreases" % level)',
    '\t\t\t_expect(float(profile["eval_noise"]) < float(previous_profile["eval_noise"]), "level %d evaluation noise decreases" % level)',
    "\t\tprevious_profile = profile",
    "\tquit(1 if failures > 0 else 0)",
    "func _expect(condition: bool, message: String) -> void:",
    "\tif not condition:",
    "\t\tfailures += 1",
  ].join("\n");
  const source = [
    "const AI_DIFFICULTY_PROFILES := {",
    '\t1: {"depth": 1, "blunder_prob": 0.55, "eval_noise": 45.0},',
    '\t2: {"depth": 1, "blunder_prob": 0.45, "eval_noise": 36.0},',
    '\t3: {"depth": 2, "blunder_prob": 0.32, "eval_noise": 28.0},',
    '\t4: {"depth": 2, "blunder_prob": 0.23, "eval_noise": 21.0},',
    '\t5: {"depth": 2, "blunder_prob": 0.15, "eval_noise": 15.0},',
    '\t6: {"depth": 2, "blunder_prob": 0.09, "eval_noise": 10.0},',
    '\t7: {"depth": 3, "blunder_prob": 0.04, "eval_noise": 6.0},',
    '\t8: {"depth": 3, "blunder_prob": 0.01, "eval_noise": 3.0},',
    '\t9: {"depth": 3, "blunder_prob": 0.0, "eval_noise": 0.0},',
    "}",
    "func choose_ai_move(level: int) -> Dictionary:",
    "\tvar profile := get_ai_difficulty_profile(level)",
    '\tvar depth := int(profile["depth"])',
  ].join("\n");
  const evidence = [
    {
      file: sourceFile,
      line: 2,
      testName: "AI_DIFFICULTY_PROFILES",
      assertionQuote: '1: {"depth": 1, "blunder_prob": 0.55, "eval_noise": 45.0},',
      explanationKo: "상수에 레벨 1~9가 depth, blunder_prob, eval_noise를 모두 정의합니다.",
    },
    {
      file: sourceFile,
      line: 14,
      testName: "choose_ai_move",
      assertionQuote: "var profile := get_ai_difficulty_profile(level)",
      explanationKo: "AI 착수 선택이 난이도 프로필 테이블 조회 결과를 사용합니다.",
    },
    {
      file: testFile,
      line: 14,
      testName: "_init",
      assertionQuote: '_expect(float(profile["blunder_prob"]) < float(previous_profile["blunder_prob"]), "level %d blunder probability decreases" % level)',
      explanationKo: "깊이는 비감소하고 실수 확률과 평가 노이즈는 단계마다 감소하는지 검증합니다.",
    },
    {
      file: testFile,
      line: 10,
      testName: "_init",
      assertionQuote: '_expect(not profile_signatures.has(signature), "level %d AI profile is unique" % level)',
      explanationKo: "각 레벨 profile signature가 unique해서 중복 조합이 없습니다.",
    },
    {
      file: testFile,
      line: 6,
      testName: "_init",
      assertionQuote: "for level in range(1, 10):",
      explanationKo: "1부터 9까지 모든 프로필의 전체 파라미터 차이를 검증합니다.",
    },
  ];
  const result = evaluateReviewAcceptanceCoverage(
    context({ [testFile]: testSource, [sourceFile]: source }),
    criteria,
    criteria.map((criterion, index) => ({
      criterionId: `AC-${index + 1}`,
      acceptanceCriterion: criterion,
      status: "covered" as const,
      testEvidence: evidence[index]!,
    })),
  );

  assert.equal(result.complete, true, JSON.stringify(result.validationErrors));
  assert.deepEqual(result.validationErrors, []);
  assert.deepEqual(
    [...result.groundedTestEvidence.values()].map((item) => item.kind),
    ["source", "source", "test", "test", "test"],
  );
});

test("lizard 알림 smoke의 실제 근거는 미검증 attendance 항목만 보류한다", () => {
  const criteria = [
    "Notifier 포트가 태그 인자를 받는 `schedule`/`cancel(tag)`로 확장되고 기존 케어 알림 동작이 회귀 없이 유지된다",
    "알 인큐베이션 시작 시 부화 예상 시각으로 `egg_hatch` 알림이 예약되고, 앱 내 부화 처리 시 취소된다",
    "출석 미수령 상태로 하루가 지나면 `attendance` 리마인드가 1회 예약된다",
    "하루 발송 총량이 1건을 넘지 않는 우선순위 규칙이 `arbitrate` 테스트로 고정된다",
    "세이브의 기존 `care_notify_pending_at`/`care_notify_last_fired`가 새 구조(`notify_pending`/`notify_last_fired`)로 무손실 마이그레이션된다",
    "headless/플러그인 미탑재 환경에서 no-op 폴백이 유지된다",
  ];
  const smokeFile = "tools/headless_smoke.gd";
  const coreFile = "tools/core_probe.gd";
  const filler = Array.from({ length: 450 }, (_, index) => `\tvar filler_${index} := ${index}`);
  const smokeSource = [
    "extends SceneTree",
    "func _initialize() -> void:",
    '\tcall_deferred("_run")',
    "func _run() -> void:",
    ...filler,
    '\tmain._notifier.schedule("egg_hatch", 60, "테스트 알림", "본문")',
    '\tmain._notifier.cancel("egg_hatch")',
    '\tif not (main._save().get("notify_pending", {}) as Dictionary).has("egg_hatch"):',
    '\t\t_fail("Incubating egg did not schedule an egg_hatch notification")',
    '\tif main._notifier._resolve_plugin() != null:',
    '\t\t_fail("Notifier resolved a plugin in headless")',
    "func _fail(message: String) -> void:",
    "\tquit(1)",
  ].join("\n");
  const migrationQuote =
    '_check((legacy_save.get("notify_pending", {}) as Dictionary).get("care_reminder", 0) == 111';
  const coreSource = [
    "extends SceneTree",
    "var failures := 0",
    "func _initialize() -> void:",
    "\t_run()",
    "func _run() -> void:",
    '    var legacy_save := {"care_notify_pending_at": 111, "care_notify_last_fired": 222}',
    `${migrationQuote} \\`,
    '\t\tand int(legacy_save.get("notify_last_fired", 0)) == 222, "notify legacy migration lossless")',
    "\tvar conflict := Notifications.arbitrate(candidates, 86400)",
    '\t_check(conflict.size() == 1 and conflict[0].tag == "egg_hatch", "arbitrate keeps higher priority")',
    "\tquit(1 if failures > 0 else 0)",
    "func _check(condition: bool, message: String) -> void:",
    "\tif not condition:",
    "\t\tfailures += 1",
  ].join("\n");
  const modelCoverage: MiniMaxAcceptanceCoverage[] = [
    coverage(criteria[0]!, {
      testEvidence: {
        file: smokeFile,
        line: 2151,
        testName: "_run",
        assertionQuote: 'main._notifier.schedule("egg_hatch", 60, "테스트 알림", "본문")',
        explanationKo: "태그 기반 schedule과 cancel 포트 호출을 smoke에서 실행합니다.",
      },
    }),
    coverage(criteria[1]!, {
      criterionId: "AC-2",
      testEvidence: {
        file: smokeFile,
        line: 2121,
        testName: "_run",
        assertionQuote: 'if not (main._save().get("notify_pending", {}) as Dictionary).has("egg_hatch"):',
        explanationKo: "인큐베이션 중 egg_hatch 슬롯이 예약되는지 검증합니다.",
      },
    }),
    coverage(criteria[2]!, { criterionId: "AC-3", status: "unknown" }),
    coverage(criteria[3]!, {
      criterionId: "AC-4",
      testEvidence: {
        file: coreFile,
        line: 294,
        testName: "_run",
        assertionQuote: '_check(conflict.size() == 1 and conflict[0].tag == "egg_hatch", "arbitrate keeps higher priority")',
        explanationKo: "arbitrate가 충돌 시 우선순위가 높은 알림만 유지하는지 검증합니다.",
      },
    }),
    coverage(criteria[4]!, {
      criterionId: "AC-5",
      testEvidence: {
        file: coreFile,
        line: 274,
        testName: "_run",
        assertionQuote: migrationQuote,
        explanationKo: "레거시 예약과 발송 이력을 notify_pending과 notify_last_fired로 이전합니다.",
      },
    }),
    coverage(criteria[5]!, {
      criterionId: "AC-6",
      testEvidence: {
        file: smokeFile,
        line: 2147,
        testName: "_run",
        assertionQuote: "if main._notifier._resolve_plugin() != null:",
        explanationKo: "플러그인 없는 headless 환경에서 null no-op 폴백을 검증합니다.",
      },
    }),
  ];

  const result = evaluateReviewAcceptanceCoverage(
    context({ [smokeFile]: smokeSource, [coreFile]: coreSource }),
    criteria,
    modelCoverage,
  );

  assert.equal(result.complete, false);
  assert.deepEqual(result.validationErrors, ["AC-3: acceptance_coverage_unknown"]);
  assert.deepEqual([...result.groundedAcceptanceCriteria], [
    normalizeReviewAcceptanceEvidence(criteria[0]!),
    normalizeReviewAcceptanceEvidence(criteria[1]!),
    normalizeReviewAcceptanceEvidence(criteria[3]!),
    normalizeReviewAcceptanceEvidence(criteria[4]!),
    normalizeReviewAcceptanceEvidence(criteria[5]!),
  ]);
});

test("테스트 추가 인수조건은 실행 manifest와 실제 executable test를 함께 결속한다", () => {
  const criterion = "레벨별 순수 함수 유닛 테스트를 추가한다.";
  const manifest = "package.json";
  const testFile = "godot/tests/dirt_progression_test.gd";
  const result = evaluateReviewAcceptanceCoverage(
    context({
      [manifest]: [
        "{",
        '  "scripts": {',
        '    "test:core": "CORE_TEST_SCENE=res://tests/dirt_progression_test.gd bash scripts/test_core.sh",',
        "  }",
        "}",
      ].join("\n"),
      [testFile]: [
        "extends SceneTree",
        "func test_unlock_curve() -> bool:",
        "\treturn true",
      ].join("\n"),
    }),
    [criterion],
    [coverage(criterion, {
      testEvidence: {
        file: manifest,
        line: 2,
        testName: "test:core",
        assertionQuote: '"test:core": "CORE_TEST_SCENE=res://tests/dirt_progression_test.gd bash scripts/test_core.sh"',
        explanationKo: "순수 로직 테스트인 dirt_progression_test.gd가 test:core 스크립트에 통합되어 실행됨을 확인합니다.",
      },
    })],
  );

  assert.equal(result.complete, true);
  assert.deepEqual(result.validationErrors, []);
  assert.equal(
    result.groundedTestEvidence.get(normalizeReviewAcceptanceEvidence(criterion))?.line,
    3,
  );
});

test("skip된 테스트와 무의미한 assertion은 근거가 아니다", () => {
  const skippedCriterion = "Calling `restartLoad` keeps `savedValue`.";
  const skippedFile = "src/skipped.test.ts";
  const skippedSource = [
    'test.skip("restartLoad keeps savedValue", () => {',
    "  assert.equal(restartLoad(), savedValue);",
    "});",
  ].join("\n");
  const skipped = evaluateReviewAcceptanceCoverage(
    context({ [skippedFile]: skippedSource }),
    [skippedCriterion],
    [coverage(skippedCriterion, {
      testEvidence: {
        file: skippedFile,
        line: 2,
        testName: "restartLoad keeps savedValue",
        assertionQuote: "assert.equal(restartLoad(), savedValue);",
        explanationKo: "재실행 결과를 비교합니다.",
      },
    })],
  );

  const vacuousCriterion = "저장 후 값이 유지된다.";
  const vacuousFile = "src/vacuous.test.ts";
  const vacuousSource = [
    'test("저장 후 값이 유지된다", () => {',
    "  assert.equal(1, 1);",
    "});",
  ].join("\n");
  const vacuous = evaluateReviewAcceptanceCoverage(
    context({ [vacuousFile]: vacuousSource }),
    [vacuousCriterion],
    [coverage(vacuousCriterion, {
      testEvidence: {
        file: vacuousFile,
        line: 2,
        testName: "저장 후 값이 유지된다",
        assertionQuote: "assert.equal(1, 1);",
        explanationKo: "상수를 비교합니다.",
      },
    })],
  );

  assert.equal(skipped.complete, false);
  assert.equal(vacuous.complete, false);
  assert.deepEqual(skipped.validationErrors, ["AC-1: test_evidence_not_grounded"]);
  assert.deepEqual(vacuous.validationErrors, ["AC-1: test_evidence_not_grounded"]);
});

test("#179처럼 첫 줄이 같은 Python 멀티라인 assertion도 line-aware 묶음으로 검증한다", () => {
  const criterion =
    "`Deploy All`의 `jobs.google-play.with`가 `track: ${{ inputs.google_play_track }}`와 `release_status: ${{ inputs.google_play_release_status }}`를 reusable workflow에 전달합니다.";
  const file = "tools/check_release_workflow_contract.py";
  const source = [
    "class ReleaseWorkflowContractTest(unittest.TestCase):",
    "    def test_deploy_all_forwards_google_play_inputs(self) -> None:",
    '        start, end, _indent = block_for(self.workflow_lines, ("jobs", "google-play", "with"))',
    "        reusable_inputs = self.workflow_lines[start:end]",
    "        self.assertIn(",
    '            "      track: ${{ inputs.google_play_track }}", reusable_inputs',
    "        )",
    "        self.assertIn(",
    '            "      release_status: ${{ inputs.google_play_release_status }}",',
    "            reusable_inputs,",
    "        )",
  ].join("\n");
  const candidates = buildReviewEvidenceCandidates(
    { [file]: source },
    { acceptanceCriteria: [criterion] },
  );
  const assertions = candidates.filter((candidate) =>
    candidate.testName === "test_deploy_all_forwards_google_play_inputs" &&
    candidate.quote.startsWith("self.assertIn("));
  assert.equal(assertions.length, 2);
  assert.notEqual(assertions[0]?.line, assertions[1]?.line);
  assert.notEqual(assertions[0]?.quote, assertions[1]?.quote);
  const evidence = assertions.map((candidate) => ({
    file: candidate.file,
    line: candidate.line,
    testName: candidate.testName,
    assertionQuote: candidate.quote,
    explanationKo: "Google Play 입력 전달 값을 직접 확인합니다.",
  }));

  const result = evaluateReviewAcceptanceCoverage(
    {
      currentHeadFileContents: { [file]: source },
      visibleChangedPatches: {},
      evidenceCandidates: candidates,
    },
    [criterion],
    [coverage(criterion, {
      testEvidence: evidence[0],
      supportingTestEvidence: [evidence[1]!],
    })],
  );

  assert.equal(result.complete, true, JSON.stringify(result.validationErrors));
  assert.deepEqual(result.validationErrors, []);
});

test("#387 locale catalog 근거는 CI command token과 분리하고 전체 locale 묶음을 요구한다", () => {
  const criterion =
    "신규 탭 라벨 문구를 ko-KR/en-US(및 나머지 6개 로케일) catalog에 추가하고 `pnpm check:i18n`이 통과한다.";
  const file = "packages/farm-ui/src/__tests__/shopTabs.test.ts";
  const source = [
    "describe('상점 탭 라벨 i18n 커버리지', () => {",
    "  it('ko-KR catalog에 4개 탭 라벨이 정의돼 있다', () => {",
    "    expect(koFarmMessages.shopTabExpand).toBe('확장');",
    "  });",
    "  it('en-US catalog에 4개 탭 라벨이 정의돼 있다', () => {",
    "    expect(enFarmMessages.shopTabExpand).toBe('Expand');",
    "  });",
    "  it('나머지 6개 로케일에도 4개 탭 라벨이 존재한다', () => {",
    "    expect(otherCatalogs).toHaveLength(6);",
    "    for (const catalog of otherCatalogs) {",
    "      expect(catalog.shopTabExpand.trim().length).toBeGreaterThan(0);",
    "    }",
    "  });",
    "});",
  ].join("\n");
  const candidates = buildReviewEvidenceCandidates(
    { [file]: source },
    { acceptanceCriteria: [criterion] },
  );
  const evidence = (quote: string) => {
    const candidate = candidates.find((item) => item.quote === quote);
    assert.ok(candidate, quote);
    return {
      file: candidate.file,
      line: candidate.line,
      testName: candidate.testName,
      assertionQuote: candidate.quote,
      explanationKo: `${candidate.testName} 검증입니다.`,
    };
  };
  const ko = evidence("expect(koFarmMessages.shopTabExpand).toBe('확장');");
  const en = evidence("expect(enFarmMessages.shopTabExpand).toBe('Expand');");
  const remaining = evidence("expect(otherCatalogs).toHaveLength(6);");
  const groundedContext: ReviewGroundingContext = {
    currentHeadFileContents: { [file]: source },
    visibleChangedPatches: {},
    evidenceCandidates: candidates,
  };

  const complete = evaluateReviewAcceptanceCoverage(
    groundedContext,
    [criterion],
    [coverage(criterion, {
      testEvidence: ko,
      supportingTestEvidence: [en, remaining],
    })],
  );
  const missingEnglish = evaluateReviewAcceptanceCoverage(
    groundedContext,
    [criterion],
    [coverage(criterion, {
      testEvidence: ko,
      supportingTestEvidence: [remaining],
    })],
  );

  assert.equal(complete.complete, true, JSON.stringify(complete.validationErrors));
  assert.deepEqual(complete.validationErrors, []);
  assert.deepEqual(missingEnglish.validationErrors, [
    "AC-1: test_evidence_missing_en_us_catalog_assertion",
  ]);
});

test("#126처럼 두 설정의 저장과 재실행 복원은 같은 테스트의 근거 묶음으로 검증한다", () => {
  const criterion = "두 설정을 `user://lucid_chess_settings.json`에 저장하고 다시 실행할 때 복원합니다.";
  const file = "tests/feedback_settings_smoke.gd";
  const source = [
    "extends SceneTree",
    'const SETTINGS_PATH := "user://lucid_chess_settings.json"',
    "var failures := 0",
    "func _init() -> void:",
    "\t_run()",
    "func _run() -> void:",
    "\tvar saved_settings := _read_settings()",
    '\t_expect(saved_settings.get("sound_enabled", true) == false, "sound setting persists through the UI toggle")',
    '\t_expect(saved_settings.get("haptics_enabled", true) == false, "haptics setting persists through the UI toggle")',
    "\tvar restored = scene.instantiate()",
    '\t_expect(not restored.sound_enabled, "sound setting restores after relaunch")',
    '\t_expect(not restored.haptics_enabled, "haptics setting restores after relaunch")',
    "\tquit(1 if failures > 0 else 0)",
  ].join("\n");
  const candidates = buildReviewEvidenceCandidates({ [file]: source });
  const evidence = (quote: string) => {
    const candidate = candidates.find((item) => item.quote === quote);
    assert.ok(candidate, quote);
    return {
      file: candidate.file,
      line: candidate.line,
      testName: candidate.testName,
      assertionQuote: candidate.quote,
      explanationKo: "Host가 추출한 current HEAD assertion입니다.",
    };
  };
  const savedSound = evidence('_expect(saved_settings.get("sound_enabled", true) == false, "sound setting persists through the UI toggle")');
  const savedHaptics = evidence('_expect(saved_settings.get("haptics_enabled", true) == false, "haptics setting persists through the UI toggle")');
  const restoredSound = evidence('_expect(not restored.sound_enabled, "sound setting restores after relaunch")');
  const restoredHaptics = evidence('_expect(not restored.haptics_enabled, "haptics setting restores after relaunch")');
  const groundedContext: ReviewGroundingContext = {
    currentHeadFileContents: { [file]: source },
    visibleChangedPatches: {},
    evidenceCandidates: candidates,
  };

  const complete = evaluateReviewAcceptanceCoverage(
    groundedContext,
    [criterion],
    [coverage(criterion, {
      testEvidence: savedSound,
      supportingTestEvidence: [savedHaptics, restoredSound, restoredHaptics],
    })],
  );
  const incomplete = evaluateReviewAcceptanceCoverage(
    groundedContext,
    [criterion],
    [coverage(criterion, {
      testEvidence: savedSound,
      supportingTestEvidence: [savedHaptics, restoredSound],
    })],
  );
  const omittedFromHostInventory = evaluateReviewAcceptanceCoverage(
    {
      ...groundedContext,
      evidenceCandidates: candidates.filter((candidate) =>
        candidate.quote !== restoredHaptics.assertionQuote),
    },
    [criterion],
    [coverage(criterion, {
      testEvidence: savedSound,
      supportingTestEvidence: [savedHaptics, restoredSound, restoredHaptics],
    })],
  );

  assert.equal(complete.complete, true, JSON.stringify(complete.validationErrors));
  assert.deepEqual(complete.validationErrors, []);
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.validationErrors, ["AC-1: test_evidence_not_grounded"]);
  assert.equal(omittedFromHostInventory.complete, false);
  assert.deepEqual(omittedFromHostInventory.validationErrors, [
    "AC-1: test_evidence_not_in_host_inventory",
  ]);
});

test("동일 HEAD에서 host가 검증한 AC PASS는 이후 모델의 unknown으로 후퇴하지 않는다", () => {
  const criterion = "저장 후 다시 실행해 값을 복원한다.";
  const grounded = normalizeReviewAcceptanceEvidence(criterion);
  const prior = coverage(criterion, {
    testEvidence: {
      file: "tests/settings.test.ts",
      line: 3,
      testName: "restores settings",
      assertionQuote: "assert.equal(restored, saved);",
      explanationKo: "저장값을 복원합니다.",
    },
  });
  const current = coverage(criterion, { status: "unknown" });

  assert.deepEqual(
    mergeStickyAcceptanceCoverage(
      [criterion],
      [current],
      new Set(),
      [prior],
      new Set([grounded]),
    ),
    [prior],
  );
  assert.deepEqual(
    mergeStickyAcceptanceCoverage(
      [criterion],
      [current],
      new Set(),
      [],
      new Set(),
    ),
    [current],
  );
});

test("plan 결과의 sim과 rollover를 모두 요구하는 AC는 두 assertion을 함께 검증한다", () => {
  const criterion =
    "`offline_settlement.plan()`이 8시간 이상 부재를 정산 구간으로 반영하는 단위 테스트가 추가된다 (`core_probe.gd` — `plan(28800, cap)` → sim=28800, rollover=0).";
  const file = "tools/core_probe.gd";
  const setup =
    'var plan_8h := OfflineSettlementUseCase.plan(28800.0, Consts.MAX_OFFLINE_SECONDS)';
  const simAssertion =
    '_check(float(plan_8h.get("sim_seconds", 0.0)) == 28800.0, "AC-2: sim_seconds == 28800")';
  const rolloverAssertion =
    '_check(float(plan_8h.get("rollover_seconds", -1.0)) == 0.0, "AC-2: rollover_seconds == 0")';
  const source = [
    "extends SceneTree",
    'const OfflineSettlementUseCase := preload("res://domain/offline_settlement.gd")',
    'const Consts := preload("res://domain/constants.gd")',
    "var failures := 0",
    "func _init() -> void:",
    "\t_run()",
    "func _run() -> void:",
    `\t${setup}`,
    `\t${simAssertion}`,
    `\t${rolloverAssertion}`,
    "\tquit(1 if failures > 0 else 0)",
  ].join("\n");
  const candidates = buildReviewEvidenceCandidates(
    { [file]: source },
    { acceptanceCriteria: [criterion] },
  );
  const evidence = (quote: string) => {
    const candidate = candidates.find((item) => item.quote === quote);
    assert.ok(candidate, quote);
    return {
      file: candidate.file,
      line: candidate.line,
      testName: candidate.testName,
      assertionQuote: candidate.quote,
      explanationKo: "Host가 추출한 current HEAD 근거입니다.",
    };
  };
  const groundedContext: ReviewGroundingContext = {
    currentHeadFileContents: { [file]: source },
    visibleChangedPatches: {},
    evidenceCandidates: candidates,
  };

  const incomplete = evaluateReviewAcceptanceCoverage(
    groundedContext,
    [criterion],
    [coverage(criterion, {
      testEvidence: evidence(simAssertion),
      supportingTestEvidence: [evidence(setup)],
    })],
  );
  const complete = evaluateReviewAcceptanceCoverage(
    groundedContext,
    [criterion],
    [coverage(criterion, {
      testEvidence: evidence(simAssertion),
      supportingTestEvidence: [evidence(setup), evidence(rolloverAssertion)],
    })],
  );

  assert.deepEqual(incomplete.validationErrors, [
    "AC-1: test_evidence_missing_rollover_assertion",
  ]);
  assert.equal(complete.complete, true, JSON.stringify(complete.validationErrors));
});
