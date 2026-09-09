import assert from "node:assert/strict";
import test from "node:test";
import type {
  MiniMaxCandidateVerification,
  MiniMaxReviewCandidate,
} from "./minimax-review.js";
import {
  SYMBOL_MAX_DISTANCE,
  evaluateMiniMaxReviewGateCandidates,
  isAdvisoryDefectCandidate,
  normalizeRepositoryPath,
  storedReviewFindingBlocks,
  type ReviewGatePipelineInput,
} from "./review-gate-pipeline.js";
import type { StoredReviewFinding } from "./review-finding-ledger.js";

const ACCEPTANCE_CRITERION = "앱을 다시 열어도 기존 세션이 유지된다.";
const FATAL_FILE = "src/save.ts";
const FATAL_SOURCE = [
  "export function saveDraft(value: string | null) {",
  "  if (value === null) {",
  '    storage.remove("save-record");',
  "  }",
  "}",
].join("\n");

test("검증 모델이 확인하고 host AC 원문과 전체 인벤토리가 일치한 테스트 누락만 변환한다", () => {
  const result = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [missingCandidate()],
    verifications: [verification()],
  }));

  assert.equal(result.inputValid, true);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.ledgerCandidates[0]?.kind, "missing_tests");
  assert.equal(result.ledgerCandidates[0]?.trigger, ACCEPTANCE_CRITERION);
  assert.equal(result.publicFindings[0]?.kind, "missing_acceptance_test");
  assert.match(result.publicFindings[0]?.fingerprint || "", /^[a-f0-9]{64}$/u);
  if (result.publicFindings[0]?.kind === "missing_acceptance_test") {
    assert.deepEqual(result.publicFindings[0].evidence, {
      acceptanceCriterion: ACCEPTANCE_CRITERION,
      testInventoryComplete: true,
      testFilesInspected: 17,
    });
    assert.match(result.publicFindings[0].problem, /자동화 테스트/u);
  }
});

test("AC ID 또는 원문이 host 추출 결과와 조금이라도 다르면 테스트 누락을 거부한다", () => {
  const wrongId = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [missingCandidate({ criterionId: "AC-2" })],
    verifications: [verification()],
  }));
  assert.equal(wrongId.accepted.length, 0);
  assert.equal(wrongId.rejected[0]?.code, "acceptance_criterion_not_exact");

  const paraphrase = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [missingCandidate({ acceptanceCriterion: "앱을 다시 열면 기존 세션이 유지된다." })],
    verifications: [verification()],
  }));
  assert.equal(paraphrase.accepted.length, 0);
  assert.equal(paraphrase.rejected[0]?.code, "acceptance_criterion_not_exact");
});

test("전체 테스트 인벤토리가 불완전하거나 파일 수가 유효하지 않으면 누락 판정을 막는다", () => {
  const incomplete = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [missingCandidate()],
    verifications: [verification()],
    testInventoryComplete: false,
  }));
  assert.equal(incomplete.rejected[0]?.code, "test_inventory_incomplete");

  const invalidCount = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [missingCandidate()],
    verifications: [verification()],
    testInventoryFileCount: -1,
  }));
  assert.equal(invalidCount.rejected[0]?.code, "test_inventory_incomplete");
});

test("수동·육안·실기기 확인을 명시한 인수조건은 자동화 테스트 누락으로 차단하지 않는다", () => {
  for (const criterion of [
    "실제 기기에서 직접 확인한다.",
    "시각 검증은 리뷰에 위임한다.",
    "Visual verification is required on a real device.",
    "(사람) AIT 콘솔 승인 상태를 확인한다 — 코드 범위 밖 운영자 작업.",
  ]) {
    const result = evaluateMiniMaxReviewGateCandidates(input({
      candidates: [missingCandidate({ acceptanceCriterion: criterion })],
      verifications: [verification()],
      explicitAcceptanceCriteria: [criterion],
    }));
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected[0]?.code, "manual_acceptance_criterion");
  }
});

test("테스트 누락 후보에 임의 symbol이나 코드 위치가 섞이면 거부한다", () => {
  const result = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [missingCandidate({ symbol: "restoreSession" })],
    verifications: [verification()],
  }));

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.code, "missing_test_shape_invalid");
});

test("confirmed가 아닌 rejected 또는 uncertain 후보는 공개 지적으로 만들지 않는다", () => {
  for (const verdict of ["rejected", "uncertain"] as const) {
    const result = evaluateMiniMaxReviewGateCandidates(input({
      candidates: [missingCandidate()],
      verifications: [verification({ verdict })],
    }));
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected[0]?.code, "verification_not_confirmed");
  }
});

test("현재 HEAD의 정확한 symbol, 순차 인과 근거와 종단 결과가 있는 치명 결함을 변환한다", () => {
  const result = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate()],
    verifications: [fatalVerification()],
  }));

  assert.equal(result.inputValid, true);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.accepted.length, 1);
  const ledger = result.ledgerCandidates[0];
  assert.equal(ledger?.kind, "fatal");
  assert.equal(ledger?.trigger, "src/save.ts#saveDraft");
  assert.equal(ledger?.evidence.length, 2);
  const published = result.publicFindings[0];
  assert.equal(published?.kind, "fatal_defect");
  if (published?.kind === "fatal_defect") {
    assert.deepEqual(published.evidence, {
      file: FATAL_FILE,
      line: 3,
      code: 'storage.remove("save-record");',
    });
    assert.match(published.title, /저장 데이터/u);
  }
});

test("모델의 발생 조건 문구가 바뀌어도 host-stable fatal fingerprint는 유지된다", () => {
  const first = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate()],
    verifications: [fatalVerification()],
  }));
  const second = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate({ triggerKo: "빈 값으로 저장을 다시 시도합니다." })],
    verifications: [fatalVerification()],
  }));

  assert.equal(first.publicFindings[0]?.fingerprint, second.publicFindings[0]?.fingerprint);
  assert.notEqual(first.publicFindings[0]?.trigger, second.publicFindings[0]?.trigger);
});

test("현재 HEAD에 없는 exact quote는 치명 결함을 거부한다", () => {
  const result = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate({
      line: 3,
      codeQuote: 'storage.wipe("save-record");',
      evidence: [
        codeEvidence(2, "if (value === null) {"),
        codeEvidence(3, 'storage.wipe("save-record");'),
      ],
    })],
    verifications: [fatalVerification({
      evidence: [codeEvidence(3, 'storage.wipe("save-record");')],
    })],
  }));

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.code, "fatal_code_not_grounded");
});

test("line 번호만 어긋나고 quote가 파일에서 유일하면 현재 HEAD 줄로 교정한다", () => {
  // M3는 정확한 코드 줄을 짚고도 줄 번호를 한두 칸 밀어 보내는 일이 잦다.
  // 유일하게 일치하는 줄로만 교정하므로 근거는 여전히 현재 HEAD에 묶여 있다.
  const result = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate({
      line: 4,
      evidence: [
        codeEvidence(1, "export function saveDraft(value: string | null) {"),
        codeEvidence(4, 'storage.remove("save-record");'),
      ],
    })],
    verifications: [fatalVerification({
      evidence: [codeEvidence(4, 'storage.remove("save-record");')],
    })],
  }));

  assert.deepEqual(result.rejected, []);
  assert.equal(result.accepted.length, 1);
  const finding = result.publicFindings[0];
  if (finding?.kind === "fatal_defect") {
    assert.equal(finding.evidence.line, 3);
  }
});

test("같은 코드가 파일에 여러 번 나오면 교정하지 않고 거부한다", () => {
  const duplicated = [
    "export function saveDraft(value: string | null) {",
    '  storage.remove("save-record");',
    '  storage.remove("save-record");',
    "}",
  ].join("\n");
  const result = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate({
      line: 4,
      codeQuote: 'storage.remove("save-record");',
      evidence: [
        codeEvidence(1, "export function saveDraft(value: string | null) {"),
        codeEvidence(4, 'storage.remove("save-record");'),
      ],
    })],
    verifications: [fatalVerification({
      evidence: [codeEvidence(4, 'storage.remove("save-record");')],
    })],
    currentHeadFileContents: { [FATAL_FILE]: duplicated },
  }));

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.code, "fatal_code_not_grounded");
});

test("현재 파일에 존재하지만 PR에서 추가되지 않은 기존 치명 코드는 차단하지 않는다", () => {
  const result = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate()],
    verifications: [fatalVerification()],
    visibleChangedPatches: {
      [FATAL_FILE]: "@@ -5,0 +5,1 @@\n+// unrelated change",
    },
  }));

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.code, "fatal_root_not_added");
});

test("치명 원인 patch가 보이지 않거나 added line의 코드가 다르면 차단하지 않는다", () => {
  const hiddenPatch = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate()],
    verifications: [fatalVerification()],
    visibleChangedPatches: {},
  }));
  assert.equal(hiddenPatch.rejected[0]?.code, "fatal_root_not_added");

  const differentAddedCode = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate()],
    verifications: [fatalVerification()],
    visibleChangedPatches: {
      [FATAL_FILE]: addedLinePatch(3, 'storage.set("save-record", value);'),
    },
  }));
  assert.equal(differentAddedCode.rejected[0]?.code, "fatal_root_not_added");
});

test("symbol이 근거에서 200줄보다 멀리 떨어져 있으면 같은 실행 경로로 간주하지 않는다", () => {
  const longSource = [
    "function saveDraft() {}",
    ...Array.from({ length: 205 }, (_, index) => `const filler${index} = ${index};`),
    "if (value === null) {",
    'storage.remove("save-record");',
  ].join("\n");
  const candidate = fatalCandidate({
    line: 208,
    codeQuote: 'storage.remove("save-record");',
    evidence: [
      codeEvidence(207, "if (value === null) {"),
      codeEvidence(208, 'storage.remove("save-record");'),
    ],
  });
  const result = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [candidate],
    verifications: [fatalVerification({
      evidence: [codeEvidence(208, 'storage.remove("save-record");')],
    })],
    currentHeadFileContents: { [FATAL_FILE]: longSource },
    visibleChangedPatches: {
      [FATAL_FILE]: addedLinePatch(208, 'storage.remove("save-record");'),
    },
  }));

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.code, "fatal_symbol_not_grounded");
});

test("파일·모듈 수식이 붙은 symbol은 마지막 식별자로 재바인딩해 인정하고 ledger에는 실제 식별자를 남긴다", () => {
  const qualified = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate({ symbol: "save.saveDraft" })],
    verifications: [fatalVerification()],
  }));

  assert.deepEqual(qualified.rejected, []);
  assert.equal(qualified.accepted.length, 1);
  assert.equal(qualified.ledgerCandidates[0]?.symbol, "saveDraft");
  assert.equal(qualified.ledgerCandidates[0]?.trigger, "src/save.ts#saveDraft");

  const bare = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate()],
    verifications: [fatalVerification()],
  }));
  assert.equal(qualified.publicFindings[0]?.fingerprint, bare.publicFindings[0]?.fingerprint);
});

test("수식을 벗겨낸 식별자도 현재 HEAD 근거 범위에 없으면 치명 결함을 계속 거부한다", () => {
  const result = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate({ symbol: "save.persistDraft" })],
    verifications: [fatalVerification()],
  }));

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.code, "fatal_symbol_not_grounded");
});

test("인과 근거가 하나뿐이거나 대표 종단 위치로 끝나지 않으면 거부한다", () => {
  const oneEvidence = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate({ evidence: [codeEvidence(3, 'storage.remove("save-record");')] })],
    verifications: [fatalVerification()],
  }));
  assert.equal(oneEvidence.rejected[0]?.code, "fatal_causal_chain_invalid");

  const wrongOrder = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate({
      evidence: [
        codeEvidence(3, 'storage.remove("save-record");'),
        codeEvidence(2, "if (value === null) {"),
      ],
    })],
    verifications: [fatalVerification()],
  }));
  assert.equal(wrongOrder.rejected[0]?.code, "fatal_causal_chain_invalid");
});

test("종단 코드가 주장한 치명 결과를 직접 발생시키지 않으면 거부한다", () => {
  const source = [
    "export function saveDraft(value: string | null) {",
    "  if (value === null) {",
    "    return false;",
    "  }",
    "}",
  ].join("\n");
  const candidate = fatalCandidate({
    defectOutcome: "primary_flow_unusable",
    line: 3,
    codeQuote: "return false;",
    evidence: [codeEvidence(2, "if (value === null) {"), codeEvidence(3, "return false;")],
  });
  const result = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [candidate],
    verifications: [fatalVerification({ evidence: [codeEvidence(3, "return false;")] })],
    currentHeadFileContents: { [FATAL_FILE]: source },
    visibleChangedPatches: { [FATAL_FILE]: addedLinePatch(3, "return false;") },
  }));

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.code, "fatal_outcome_not_direct");
});

test("advisory 등급은 치명 서명 없이도 나머지 근거가 모두 남으면 통과한다", () => {
  // 한 줄 정규식 서명은 크래시나 삭제를 증명할 수 있어도 일반 오동작을 표현할
  // 수 없다. advisory 후보는 서명만 면제하고 root 실재·추가줄·인과 근거·symbol·
  // verifier 확인은 치명 등급과 동일하게 요구한다.
  const source = [
    "func _on_hint_pressed(event):",
    "  if event.is_pressed():",
    "    accept_event()",
    "  return",
  ].join("\n");
  const file = "src/ui/hint_panel.gd";
  const candidate = fatalCandidate({
    file,
    symbol: "accept_event",
    line: 3,
    codeQuote: "accept_event()",
    defectOutcome: "deterministic_misbehavior",
    evidence: [
      { file, line: 2, codeQuote: "if event.is_pressed():", explanationKo: "정상 입력 경로입니다." },
      { file, line: 3, codeQuote: "accept_event()", explanationKo: "스크롤 입력을 가로챕니다." },
    ],
  });
  const result = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [candidate],
    verifications: [fatalVerification({
      evidence: [{ file, line: 3, codeQuote: "accept_event()", explanationKo: "동일 종단 근거입니다." }],
    })],
    currentHeadFileContents: { [file]: source },
    visibleChangedPatches: { [file]: addedLinePatch(3, "accept_event()") },
  }));

  assert.deepEqual(result.rejected, []);
  assert.equal(result.accepted.length, 1);
  const finding = result.publicFindings[0];
  assert.equal(finding?.kind, "fatal_defect");
  if (finding?.kind === "fatal_defect") {
    assert.equal(finding.severity, "advisory");
  }
  assert.equal(result.ledgerCandidates[0]?.kind, "fatal");
});

test("advisory 등급은 선언된 의도를 담은 근거 줄을 함께 요구한다", () => {
  // root 한 줄만 받으면 "선언된 의도"가 모델 산문에만 존재하게 되어, 새로 추가된
  // 어떤 비교나 반환도 확정 오동작으로 통과할 수 있다. 의도 줄도 현재 HEAD에
  // 실재해야 한다.
  const source = [
    "## 남은 시도가 1회 이상이면 도전할 수 있다.",
    "static func can_challenge(remaining: int) -> bool:",
    "\treturn remaining > 1",
  ].join("\n");
  const file = "godot/scripts/challenge_rules.gd";
  const root = { file, line: 3, codeQuote: "\treturn remaining > 1", explanationKo: "경계값을 반대로 적용합니다." };
  const intent = {
    file,
    line: 1,
    codeQuote: "## 남은 시도가 1회 이상이면 도전할 수 있다.",
    explanationKo: "같은 파일이 선언한 의도입니다.",
  };
  const rootOnly = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate({
      file,
      symbol: "can_challenge",
      line: 3,
      codeQuote: "\treturn remaining > 1",
      defectOutcome: "deterministic_misbehavior",
      evidence: [root],
    })],
    verifications: [fatalVerification({ evidence: [root] })],
    currentHeadFileContents: { [file]: source },
    visibleChangedPatches: { [file]: addedLinePatch(3, "\treturn remaining > 1") },
  }));
  assert.equal(rootOnly.accepted.length, 0);
  assert.equal(rootOnly.rejected[0]?.code, "fatal_causal_chain_invalid");

  const withIntent = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate({
      file,
      symbol: "can_challenge",
      line: 3,
      codeQuote: "\treturn remaining > 1",
      defectOutcome: "deterministic_misbehavior",
      evidence: [intent, root],
    })],
    verifications: [fatalVerification({ evidence: [root] })],
    currentHeadFileContents: { [file]: source },
    visibleChangedPatches: { [file]: addedLinePatch(3, "\treturn remaining > 1") },
  }));
  assert.deepEqual(withIntent.rejected, []);
  assert.equal(withIntent.accepted.length, 1);
});

test("치명 등급은 근거가 하나뿐이면 계속 거부한다", () => {
  const result = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate({ evidence: [codeEvidence(3, 'storage.remove("save-record");')] })],
    verifications: [fatalVerification()],
  }));
  assert.equal(result.rejected[0]?.code, "fatal_causal_chain_invalid");
});

test("advisory 등급도 종단 근거가 주석 줄이면 거부한다", () => {
  const source = [
    "func _on_hint_pressed(event):",
    "  if event.is_pressed():",
    "    # accept_event()",
    "  return",
  ].join("\n");
  const file = "src/ui/hint_panel.gd";
  const result = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate({
      file,
      symbol: "accept_event",
      line: 3,
      codeQuote: "# accept_event()",
      defectOutcome: "deterministic_misbehavior",
      evidence: [
        { file, line: 2, codeQuote: "if event.is_pressed():", explanationKo: "정상 입력 경로입니다." },
        { file, line: 3, codeQuote: "# accept_event()", explanationKo: "주석입니다." },
      ],
    })],
    verifications: [fatalVerification({
      evidence: [{ file, line: 3, codeQuote: "# accept_event()", explanationKo: "동일 종단 근거입니다." }],
    })],
    currentHeadFileContents: { [file]: source },
    visibleChangedPatches: { [file]: addedLinePatch(3, "# accept_event()") },
  }));

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.code, "advisory_root_not_executable");
});

test("치명 등급은 advisory 도입 뒤에도 직접 서명을 계속 요구한다", () => {
  const accepted = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate()],
    verifications: [fatalVerification()],
  }));
  const finding = accepted.publicFindings[0];
  assert.equal(finding?.kind, "fatal_defect");
  if (finding?.kind === "fatal_defect") {
    assert.equal(finding.severity, "fatal");
  }
});

test("verifier가 같은 종단 근거를 현재 HEAD에서 독립적으로 인용하지 못하면 거부한다", () => {
  const missingRoot = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate()],
    verifications: [fatalVerification({ evidence: [codeEvidence(2, "if (value === null) {")] })],
  }));
  assert.equal(missingRoot.rejected[0]?.code, "verifier_evidence_not_grounded");

  const hallucinated = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate()],
    verifications: [fatalVerification({
      evidence: [codeEvidence(3, 'storage.delete("save-record");')],
    })],
  }));
  assert.equal(hallucinated.rejected[0]?.code, "verifier_evidence_not_grounded");
});

test("후보 상한, 순차 ID, 후보별 검증 집합을 protocol 수준에서 강제한다", () => {
  const tooManyCandidates = [
    missingCandidate({ candidateId: "C-1" }),
    missingCandidate({ candidateId: "C-2" }),
    missingCandidate({ candidateId: "C-3" }),
  ];
  const tooMany = evaluateMiniMaxReviewGateCandidates(input({
    candidates: tooManyCandidates,
    verifications: [
      verification({ candidateId: "C-1" }),
      verification({ candidateId: "C-2" }),
      verification({ candidateId: "C-3" }),
    ],
  }));
  assert.equal(tooMany.inputValid, false);
  assert.equal(tooMany.accepted.length, 0);
  assert.ok(tooMany.rejected.every((item) => item.code === "candidate_limit_exceeded"));

  const wrongId = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [missingCandidate({ candidateId: "C-2" })],
    verifications: [verification({ candidateId: "C-2" })],
  }));
  assert.equal(wrongId.inputValid, false);
  assert.equal(wrongId.rejected[0]?.code, "candidate_ids_invalid");

  const missingVerification = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [missingCandidate()],
    verifications: [],
  }));
  assert.equal(missingVerification.inputValid, false);
  assert.equal(missingVerification.rejected[0]?.code, "verification_set_mismatch");
});

function input(overrides: Partial<ReviewGatePipelineInput> = {}): ReviewGatePipelineInput {
  return {
    candidates: [],
    verifications: [],
    explicitAcceptanceCriteria: [ACCEPTANCE_CRITERION],
    testInventoryComplete: true,
    testInventoryFileCount: 17,
    currentHeadFileContents: { [FATAL_FILE]: FATAL_SOURCE },
    visibleChangedPatches: {
      [FATAL_FILE]: addedLinePatch(3, 'storage.remove("save-record");'),
    },
    ...overrides,
  };
}

function addedLinePatch(line: number, code: string): string {
  return `@@ -${line},0 +${line},1 @@\n+${code}`;
}

function missingCandidate(
  overrides: Partial<MiniMaxReviewCandidate> = {},
): MiniMaxReviewCandidate {
  return {
    candidateId: "C-1",
    kind: "missing_acceptance_test",
    titleKo: "세션 복원 테스트가 없습니다",
    problemKo: "명시된 세션 복원 동작을 검증하는 자동화 테스트가 없습니다.",
    triggerKo: "세션 복원 코드가 변경되어 회귀합니다.",
    impactKo: "세션 복원이 깨져도 병합 전에 발견할 수 없습니다.",
    fixKo: "저장 후 다시 실행했을 때 세션이 복원되는 테스트를 추가해야 합니다.",
    file: null,
    symbol: null,
    line: null,
    codeQuote: null,
    defectOutcome: null,
    criterionId: "AC-1",
    acceptanceCriterion: ACCEPTANCE_CRITERION,
    testSearchSummaryKo: "현재 HEAD의 전체 테스트 파일을 검색했지만 관련 테스트가 없습니다.",
    evidence: [],
    ...overrides,
  };
}

function fatalCandidate(
  overrides: Partial<MiniMaxReviewCandidate> = {},
): MiniMaxReviewCandidate {
  return {
    candidateId: "C-1",
    kind: "fatal_defect",
    titleKo: "저장 데이터가 영구 삭제됩니다",
    problemKo: "빈 저장값을 처리하는 정상 경로가 기존 저장 데이터를 삭제합니다.",
    triggerKo: "사용자가 빈 값으로 기존 초안을 저장합니다.",
    impactKo: "기존 저장 데이터가 영구 삭제되어 복구할 수 없습니다.",
    fixKo: "빈 값 검증을 삭제 호출보다 먼저 수행하고 회귀 테스트를 추가해야 합니다.",
    file: FATAL_FILE,
    symbol: "saveDraft",
    line: 3,
    codeQuote: 'storage.remove("save-record");',
    defectOutcome: "permanent_data_loss_or_corruption",
    criterionId: null,
    acceptanceCriterion: null,
    testSearchSummaryKo: null,
    evidence: [
      codeEvidence(2, "if (value === null) {"),
      codeEvidence(3, 'storage.remove("save-record");'),
    ],
    ...overrides,
  };
}

function verification(
  overrides: Partial<MiniMaxCandidateVerification> = {},
): MiniMaxCandidateVerification {
  return {
    candidateId: "C-1",
    verdict: "confirmed",
    reasonKo: "전체 테스트 인벤토리에서 해당 인수조건 테스트를 찾지 못했습니다.",
    evidence: [],
    ...overrides,
  };
}

function fatalVerification(
  overrides: Partial<MiniMaxCandidateVerification> = {},
): MiniMaxCandidateVerification {
  return verification({
    reasonKo: "현재 HEAD에서 삭제 호출과 동일한 종단 근거를 다시 확인했습니다.",
    evidence: [codeEvidence(3, 'storage.remove("save-record");')],
    ...overrides,
  });
}

function codeEvidence(line: number, codeQuote: string) {
  return {
    file: FATAL_FILE,
    line,
    codeQuote,
    explanationKo: "현재 HEAD의 실행 경로를 직접 보여주는 코드입니다.",
  };
}

test("인덱스 접근 root는 서명 키워드 없이도 deterministic_crash로 인정한다", () => {
  const source = [
    "const TIERS = [10, 20, 30];",
    "export function rewardForTier(tier: number) {",
    "  return TIERS[tier];",
    "}",
  ].join("\n");
  const candidate = fatalCandidate({
    defectOutcome: "deterministic_crash",
    symbol: "rewardForTier",
    line: 3,
    codeQuote: "return TIERS[tier];",
    evidence: [codeEvidence(1, "const TIERS = [10, 20, 30];"), codeEvidence(3, "return TIERS[tier];")],
  });
  const result = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [candidate],
    verifications: [fatalVerification({ evidence: [codeEvidence(3, "return TIERS[tier];")] })],
    currentHeadFileContents: { [FATAL_FILE]: source },
    visibleChangedPatches: { [FATAL_FILE]: addedLinePatch(3, "return TIERS[tier];") },
  }));
  assert.equal(result.accepted.length, 1);
});

test("나눗셈 root는 deterministic_crash로 인정하고, 일반 호출 root는 계속 거부한다", () => {
  const divisionSource = [
    "export function average(total: number, count: number) {",
    "  return total / count;",
    "}",
  ].join("\n");
  const division = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate({
      defectOutcome: "deterministic_crash",
      symbol: "average",
      line: 2,
      codeQuote: "return total / count;",
      evidence: [codeEvidence(1, "export function average(total: number, count: number) {"), codeEvidence(2, "return total / count;")],
    })],
    verifications: [fatalVerification({ evidence: [codeEvidence(2, "return total / count;")] })],
    currentHeadFileContents: { [FATAL_FILE]: divisionSource },
    visibleChangedPatches: { [FATAL_FILE]: addedLinePatch(2, "return total / count;") },
  }));
  assert.equal(division.accepted.length, 1);

  const plainSource = [
    "export function run(value: string) {",
    "  return doWork(value);",
    "}",
  ].join("\n");
  const plain = evaluateMiniMaxReviewGateCandidates(input({
    candidates: [fatalCandidate({
      defectOutcome: "deterministic_crash",
      symbol: "run",
      line: 2,
      codeQuote: "return doWork(value);",
      evidence: [codeEvidence(1, "export function run(value: string) {"), codeEvidence(2, "return doWork(value);")],
    })],
    verifications: [fatalVerification({ evidence: [codeEvidence(2, "return doWork(value);")] })],
    currentHeadFileContents: { [FATAL_FILE]: plainSource },
    visibleChangedPatches: { [FATAL_FILE]: addedLinePatch(2, "return doWork(value);") },
  }));
  assert.equal(plain.accepted.length, 0);
  assert.equal(plain.rejected[0]?.code, "fatal_outcome_not_direct");
});

test("검증자 발췌가 재사용하는 grounding 상수와 경로 정규화를 export한다", () => {
  assert.equal(SYMBOL_MAX_DISTANCE, 200);
  assert.equal(normalizeRepositoryPath("./a/b.gd"), "a/b.gd");
  assert.equal(normalizeRepositoryPath("a\\b.gd"), "a/b.gd");
  assert.equal(normalizeRepositoryPath("../a.gd"), null);
  assert.equal(normalizeRepositoryPath("/abs.gd"), null);
});

test("advisory 결함은 Seori 판정을 막지 않고 치명 결함과 테스트 누락만 막는다", () => {
  // 잔소리는 advisory 지적을 게시하지만 병합 게이트는 치명 등급만 본다.
  assert.equal(storedReviewFindingBlocks(storedFinding("permanent_data_loss_or_corruption")), true);
  assert.equal(storedReviewFindingBlocks(storedFinding("deterministic_crash")), true);
  assert.equal(storedReviewFindingBlocks(storedFinding("deterministic_misbehavior")), false);
  assert.equal(storedReviewFindingBlocks(storedMissingTestFinding()), true);
});

function storedFinding(outcome: string): StoredReviewFinding {
  return {
    ...storedBase(),
    candidate: {
      kind: "fatal",
      category: "fatal_defect",
      outcome,
      file: FATAL_FILE,
      symbol: "saveDraft",
      trigger: `${FATAL_FILE}#saveDraft`,
      evidence: [{ kind: "code", file: FATAL_FILE, line: 3, symbol: "saveDraft", quote: "x" }],
    },
  };
}

function storedMissingTestFinding(): StoredReviewFinding {
  return {
    ...storedBase(),
    candidate: {
      kind: "missing_tests",
      category: "missing_acceptance_test",
      acceptanceCriterion: ACCEPTANCE_CRITERION,
      file: null,
      symbol: null,
      trigger: ACCEPTANCE_CRITERION,
      evidence: [{ kind: "acceptance_criterion", file: null, line: null, symbol: null, quote: ACCEPTANCE_CRITERION }],
    },
  };
}

function storedBase() {
  return {
    semanticFingerprint: "f".repeat(64),
    evidenceHash: "e".repeat(64),
    state: "open" as const,
    firstSeenHeadSha: "abc1234",
    lastSeenHeadSha: "abc1234",
    lastEvaluatedHeadSha: "abc1234",
    contextHash: "c".repeat(64),
    refutation: null,
  };
}

test("advisory 후보 판정은 게이트 입력 필터가 공유하는 하나의 기준을 쓴다", () => {
  // Seori 판정 입력(bot.ts)과 공개 보류 항목(disclosure)이 서로 다른 기준을 쓰면
  // 한쪽만 advisory를 걸러 "보류인데 보류 항목이 없는" 상태가 만들어진다.
  assert.equal(isAdvisoryDefectCandidate(fatalCandidate({ defectOutcome: "deterministic_misbehavior" })), true);
  assert.equal(isAdvisoryDefectCandidate(fatalCandidate({ defectOutcome: "deterministic_crash" })), false);
  assert.equal(isAdvisoryDefectCandidate(fatalCandidate({ defectOutcome: "primary_flow_unusable" })), false);
  assert.equal(isAdvisoryDefectCandidate(missingCandidate()), false);
});
