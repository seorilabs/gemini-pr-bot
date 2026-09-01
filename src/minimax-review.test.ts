import assert from "node:assert/strict";
import test from "node:test";
import {
  MINIMAX_ANTHROPIC_MESSAGES_PATH,
  MINIMAX_REVIEW_MAX_ACCEPTANCE_CRITERIA,
  MINIMAX_REVIEW_MAX_CANDIDATES,
  MINIMAX_REVIEW_MODEL,
  MINIMAX_REVIEW_TOOL_NAME,
  buildMiniMaxReviewRequest,
  buildMiniMaxVerificationRequest,
  parseMiniMaxReviewPayload,
  parseMiniMaxReviewResponse,
  parseMiniMaxVerificationPayload,
  parseMiniMaxVerificationResponse,
} from "./minimax-review.js";

function fatalCandidate(id = "C-1", line = 42): Record<string, unknown> {
  return {
    candidate_id: id,
    kind: "fatal_defect",
    title_ko: "필수 저장 경로에서 항상 예외가 발생합니다",
    problem_ko: "저장 함수가 입력과 관계없이 예외를 던집니다.",
    trigger_ko: "사용자가 정상적인 저장 버튼을 누르면 발생합니다.",
    impact_ko: "핵심 저장 흐름을 사용할 수 없습니다.",
    fix_ko: "무조건 발생하는 예외를 제거하고 정상 저장 테스트를 추가해야 합니다.",
    file: "src/save.ts",
    symbol: "save",
    line,
    code_quote: 'throw new Error("저장 실패")',
    fatal_outcome: "deterministic_crash",
    criterion_id: null,
    acceptance_criterion: null,
    test_search_summary_ko: null,
    evidence: [
      {
        file: "src/save.ts",
        line,
        code_quote: 'throw new Error("저장 실패")',
        explanation_ko: "정상 저장 경로에서 직접 예외를 던지는 현재 HEAD 코드입니다.",
      },
    ],
  };
}

function missingTestCandidate(id = "C-1"): Record<string, unknown> {
  return {
    candidate_id: id,
    kind: "missing_acceptance_test",
    title_ko: "명시된 복원 동작을 검증하는 테스트가 없습니다",
    problem_ko: "자동화 가능한 인수조건과 대응하는 테스트가 없습니다.",
    trigger_ko: "저장값 복원 동작이 변경되어 회귀할 때 검출되지 않습니다.",
    impact_ko: "인수조건이 깨진 채 병합될 수 있습니다.",
    fix_ko: "현재 HEAD의 복원 동작을 직접 단언하는 테스트를 추가해야 합니다.",
    file: null,
    symbol: "restoreSavedValue",
    line: null,
    code_quote: null,
    fatal_outcome: null,
    criterion_id: "AC-1",
    acceptance_criterion: "저장 후 다시 열어도 값이 유지된다.",
    test_search_summary_ko: "전체 테스트 목록과 본문을 검색했지만 복원값 단언을 찾지 못했습니다.",
    evidence: [],
  };
}

function acceptanceCoverage(
  status: "covered" | "missing" | "unknown" = "missing",
  id = "AC-1",
  source = "저장 후 다시 열어도 값이 유지된다.",
): Record<string, unknown> {
  return {
    criterion_id: id,
    acceptance_criterion: source,
    status,
    test_evidence:
      status === "covered"
        ? {
            file: "src/save.test.ts",
            line: 28,
            test_name: "저장값을 다시 복원한다",
            assertion_quote: "assert.equal(restored.value, expected)",
            explanation_ko: "저장한 값과 다시 불러온 값을 직접 비교하는 단언입니다.",
          }
        : null,
    supporting_test_evidence: [],
  };
}

function reviewPayload(
  candidates: unknown[] = [],
  coverage: unknown[] = [],
): Record<string, unknown> {
  return {
    acceptance_coverage: coverage,
    candidates,
  };
}

function verification(
  id = "C-1",
  verdict: "confirmed" | "rejected" | "uncertain" = "rejected",
): Record<string, unknown> {
  return {
    candidate_id: id,
    verdict,
    reason_ko:
      verdict === "confirmed"
        ? "현재 HEAD에서도 같은 실행 경로와 결과가 직접 확인됩니다."
        : verdict === "rejected"
          ? "현재 HEAD에는 예외 전에 정상 반환하는 보호 조건이 있어 주장이 성립하지 않습니다."
          : "제공된 현재 HEAD 문맥만으로는 주장이나 반증을 확정할 수 없습니다.",
    evidence:
      verdict === "uncertain"
        ? []
        : [
            {
              file: "src/save.ts",
              line: 40,
              code_quote: "if (isValid(input)) return save(input)",
              explanation_ko:
                verdict === "confirmed"
                  ? "정상 입력도 예외 경로에 도달함을 보여주는 코드입니다."
                  : "정상 입력은 예외에 도달하지 않고 저장됨을 보여주는 코드입니다.",
            },
          ],
  };
}

function messagesResponse(
  input: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "MiniMax-M3",
    content: [
      { type: "thinking", thinking: "private reasoning", signature: "sig" },
      {
        type: "tool_use",
        id: "tool_test",
        name: MINIMAX_REVIEW_TOOL_NAME,
        input,
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  };
}

test("candidate request uses MiniMax-M3 conservative Anthropic Messages defaults", () => {
  const request = buildMiniMaxReviewRequest({
    systemPrompt: "고정된 시스템 규칙",
    userPrompt: "PR 현재 HEAD 문맥",
  });

  assert.equal(MINIMAX_ANTHROPIC_MESSAGES_PATH, "/anthropic/v1/messages");
  assert.equal(request.model, MINIMAX_REVIEW_MODEL);
  assert.equal(request.system, "고정된 시스템 규칙");
  assert.deepEqual(request.messages, [
    { role: "user", content: [{ type: "text", text: "PR 현재 HEAD 문맥" }] },
  ]);
  assert.deepEqual(request.thinking, { type: "adaptive" });
  assert.equal(request.temperature, 1);
  assert.equal(request.top_p, 0.95);
  assert.equal(request.service_tier, "standard");
  assert.equal(request.stream, false);
  assert.equal(request.max_tokens, 24_576);
  assert.deepEqual(request.tool_choice, { type: "auto" });
  assert.equal(request.tools.length, 1);
  assert.equal(request.tools[0]?.name, MINIMAX_REVIEW_TOOL_NAME);

  const schema = request.tools[0]?.input_schema as any;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["acceptance_coverage", "candidates"]);
  assert.equal(
    schema.properties.acceptance_coverage.maxItems,
    MINIMAX_REVIEW_MAX_ACCEPTANCE_CRITERIA,
  );
  assert.equal(schema.properties.acceptance_coverage.items.additionalProperties, false);
  assert.deepEqual(schema.properties.acceptance_coverage.items.properties.status.enum, [
    "covered",
    "missing",
    "unknown",
  ]);
  assert.equal(schema.properties.candidates.maxItems, MINIMAX_REVIEW_MAX_CANDIDATES);
  assert.equal(schema.properties.candidates.items.additionalProperties, false);
  assert.ok(schema.properties.candidates.items.required.includes("title_ko"));
  assert.ok(schema.properties.candidates.items.required.includes("symbol"));
  assert.ok(schema.properties.candidates.items.required.includes("test_search_summary_ko"));
});

test("verification request has its own strict verifier schema and smaller default output", () => {
  const request = buildMiniMaxVerificationRequest({
    systemPrompt: "반증을 우선하는 검증 규칙",
    userPrompt: "후보와 현재 HEAD 근거",
  });
  assert.equal(request.max_tokens, 8_192);
  const schema = request.tools[0]?.input_schema as any;
  assert.deepEqual(schema.required, ["verifications"]);
  assert.equal(schema.properties.verifications.maxItems, 2);
  assert.deepEqual(schema.properties.verifications.items.properties.verdict.enum, [
    "confirmed",
    "rejected",
    "uncertain",
  ]);
  assert.ok(schema.properties.verifications.items.required.includes("reason_ko"));
});

test("request builder preserves system/user boundaries and validates inputs", () => {
  const request = buildMiniMaxReviewRequest({
    systemPrompt: "  시스템 앞뒤 공백도 그대로 둔다  ",
    userPrompt: "  사용자 문맥도 그대로 둔다  ",
    maxTokens: 12_345,
  });
  assert.equal(request.system, "  시스템 앞뒤 공백도 그대로 둔다  ");
  assert.equal(request.messages[0]?.content[0]?.text, "  사용자 문맥도 그대로 둔다  ");
  assert.equal(request.max_tokens, 12_345);

  assert.throws(
    () => buildMiniMaxReviewRequest({ systemPrompt: " ", userPrompt: "문맥" }),
    /systemPrompt must be a non-empty string/,
  );
  assert.throws(
    () => buildMiniMaxReviewRequest({ systemPrompt: "규칙", userPrompt: "\n" }),
    /userPrompt must be a non-empty string/,
  );
  assert.throws(
    () =>
      buildMiniMaxReviewRequest({
        systemPrompt: "규칙",
        userPrompt: "문맥",
        maxTokens: 524_289,
      }),
    /maxTokens/,
  );
});

test("tool_use submit_review candidate response is mapped to typed camelCase fields", () => {
  const parsed = parseMiniMaxReviewResponse(
    messagesResponse(reviewPayload([fatalCandidate()])),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.source, "tool_use");
  assert.equal(parsed.value.candidates[0]?.candidateId, "C-1");
  assert.equal(parsed.value.candidates[0]?.symbol, "save");
  assert.equal(parsed.value.candidates[0]?.fatalOutcome, "deterministic_crash");
  assert.equal(parsed.value.candidates[0]?.evidence[0]?.explanationKo.includes("현재 HEAD"), true);
});

test("host acceptance criteria map one-to-one to ordered positive coverage", () => {
  const expected = [
    "저장 후 다시 열어도 값이 유지된다.",
    "로그아웃하면 세션이 폐기된다.",
    "오프라인 상태는 아직 판정하지 않는다.",
  ];
  const payload = reviewPayload([], [
    acceptanceCoverage("covered", "AC-1", expected[0]),
    acceptanceCoverage("missing", "AC-2", expected[1]),
    acceptanceCoverage("unknown", "AC-3", expected[2]),
  ]);
  const parsed = parseMiniMaxReviewResponse(messagesResponse(payload), {
    expectedAcceptanceCriteria: expected,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.acceptanceCoverage.length, 3);
  assert.equal(parsed.value.acceptanceCoverage[0]?.status, "covered");
  assert.equal(parsed.value.acceptanceCoverage[0]?.testEvidence?.testName, "저장값을 다시 복원한다");
  assert.equal(
    parsed.value.acceptanceCoverage[0]?.testEvidence?.assertionQuote,
    "assert.equal(restored.value, expected)",
  );
  assert.equal(parsed.value.acceptanceCoverage[1]?.testEvidence, null);
  assert.equal(parsed.value.acceptanceCoverage[2]?.criterionId, "AC-3");
});

test("empty host acceptance criteria require empty coverage", () => {
  assert.equal(
    parseMiniMaxReviewPayload(reviewPayload(), { expectedAcceptanceCriteria: [] }).ok,
    true,
  );
  const invented = parseMiniMaxReviewPayload(
    reviewPayload([], [acceptanceCoverage("unknown")]),
    { expectedAcceptanceCriteria: [] },
  );
  assert.equal(invented.ok, false);
  if (!invented.ok) {
    assert.ok(invented.errors.some((error) => error.includes("one result per host")));
  }
});

test("coverage rejects omitted or renumbered rows and host-binds echoed prose", () => {
  const expected = [
    "저장 후 다시 열어도 값이 유지된다.",
    "로그아웃하면 세션이 폐기된다.",
  ];

  const omitted = parseMiniMaxReviewPayload(
    reviewPayload([], [acceptanceCoverage("covered", "AC-1", expected[0])]),
    { expectedAcceptanceCriteria: expected },
  );
  assert.equal(omitted.ok, false);
  if (!omitted.ok) {
    assert.ok(omitted.errors.some((error) => error.includes("one result per host")));
  }

  const untrustedEcho = parseMiniMaxReviewPayload(
    reviewPayload([], [
      acceptanceCoverage("covered", "AC-1", expected[1]),
      acceptanceCoverage("covered", "AC-2", expected[0]),
    ]),
    { expectedAcceptanceCriteria: expected },
  );
  assert.equal(untrustedEcho.ok, true);
  if (untrustedEcho.ok) {
    assert.deepEqual(
      untrustedEcho.value.acceptanceCoverage.map((entry) => entry.acceptanceCriterion),
      expected,
    );
  }

  const wrongId = parseMiniMaxReviewPayload(
    reviewPayload([], [
      acceptanceCoverage("covered", "AC-2", expected[0]),
      acceptanceCoverage("covered", "AC-1", expected[1]),
    ]),
    { expectedAcceptanceCriteria: expected },
  );
  assert.equal(wrongId.ok, false);
  if (!wrongId.ok) {
    assert.ok(wrongId.errors.some((error) => error.includes('expected "AC-1"')));
  }

  const paraphrased = parseMiniMaxReviewPayload(
    reviewPayload([], [
      acceptanceCoverage("covered", "AC-1", "저장값이 유지된다."),
      acceptanceCoverage("covered", "AC-2", expected[1]),
    ]),
    { expectedAcceptanceCriteria: expected },
  );
  assert.equal(paraphrased.ok, true);
  if (paraphrased.ok) {
    assert.equal(paraphrased.value.acceptanceCoverage[0]?.acceptanceCriterion, expected[0]);
  }
});

test("host criteria rebind both coverage and missing-test candidate prose", () => {
  const expected = ["저장 후 다시 열어도 값이 유지된다."];
  const coverage = acceptanceCoverage("missing", "AC-1", "모델이 바꿔 쓴 문장");
  const candidate = missingTestCandidate();
  candidate.acceptance_criterion = "무시해야 하는 또 다른 문장";

  const parsed = parseMiniMaxReviewPayload(reviewPayload([candidate], [coverage]), {
    expectedAcceptanceCriteria: expected,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.acceptanceCoverage[0]?.acceptanceCriterion, expected[0]);
  assert.equal(parsed.value.candidates[0]?.acceptanceCriterion, expected[0]);
});

test("covered requires exact test evidence while missing and unknown require null", () => {
  const coveredWithoutEvidence = acceptanceCoverage("covered");
  coveredWithoutEvidence.test_evidence = null;
  const missingWithEvidence = acceptanceCoverage("covered", "AC-2", "로그아웃한다.");
  missingWithEvidence.status = "missing";
  const unknownWithEvidence = acceptanceCoverage("covered", "AC-3", "오프라인이다.");
  unknownWithEvidence.status = "unknown";

  const parsed = parseMiniMaxReviewPayload(
    reviewPayload([], [coveredWithoutEvidence, missingWithEvidence, unknownWithEvidence]),
  );
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.ok(parsed.errors.some((error) => error.includes("covered status requires")));
  assert.ok(parsed.errors.some((error) => error.includes("missing status requires null")));
  assert.ok(parsed.errors.some((error) => error.includes("unknown status requires null")));
});

test("composite coverage accepts at most three additional current-HEAD evidence rows", () => {
  const row = acceptanceCoverage("covered");
  row.supporting_test_evidence = [
    {
      file: "src/save.test.ts",
      line: 31,
      test_name: "저장값을 다시 복원한다",
      assertion_quote: "assert.equal(restored.haptics, false)",
      explanation_ko: "재실행 후 햅틱 설정도 함께 복원되는지 확인합니다.",
    },
  ];
  const parsed = parseMiniMaxReviewPayload(reviewPayload([], [row]));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.acceptanceCoverage[0]?.supportingTestEvidence?.length, 1);
});

test("coverage and test evidence reject unknown fields and invalid Korean explanation", () => {
  const row = acceptanceCoverage("covered");
  row.confidence = 1;
  const evidence = row.test_evidence as Record<string, unknown>;
  evidence.explanation_ko = "Exact assertion match";
  evidence.extra = "not allowed";
  const parsed = parseMiniMaxReviewPayload(reviewPayload([], [row]));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.ok(parsed.errors.some((error) => error.includes("confidence: unexpected field")));
  assert.ok(parsed.errors.some((error) => error.includes("extra: unexpected field")));
  assert.ok(
    parsed.errors.some(
      (error) => error.includes("explanation_ko") && error.includes("Korean"),
    ),
  );
});

test("missing-test candidate must reference a matching missing coverage row", () => {
  const absent = parseMiniMaxReviewPayload(reviewPayload([missingTestCandidate()]));
  assert.equal(absent.ok, false);
  if (!absent.ok) {
    assert.ok(absent.errors.some((error) => error.includes("missing from acceptance_coverage")));
  }

  const covered = parseMiniMaxReviewPayload(
    reviewPayload([missingTestCandidate()], [acceptanceCoverage("covered")]),
  );
  assert.equal(covered.ok, false);
  if (!covered.ok) {
    assert.ok(covered.errors.some((error) => error.includes('status must be "missing"')));
  }

  const mismatchedSource = acceptanceCoverage("missing");
  mismatchedSource.acceptance_criterion = "다른 인수조건이다.";
  const mismatch = parseMiniMaxReviewPayload(
    reviewPayload([missingTestCandidate()], [mismatchedSource]),
  );
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) {
    assert.ok(mismatch.errors.some((error) => error.includes("must match acceptance_coverage")));
  }
});

test("empty candidate list is valid and two candidates is the hard maximum", () => {
  const empty = parseMiniMaxReviewPayload(reviewPayload());
  assert.equal(empty.ok, true);

  const two = parseMiniMaxReviewPayload(
    reviewPayload(
      [fatalCandidate("C-1", 42), missingTestCandidate("C-2")],
      [acceptanceCoverage("missing")],
    ),
  );
  assert.equal(two.ok, true);

  const three = parseMiniMaxReviewPayload(
    reviewPayload(
      [fatalCandidate("C-1", 42), missingTestCandidate("C-2"), fatalCandidate("C-1", 43)],
      [acceptanceCoverage("missing")],
    ),
  );
  assert.equal(three.ok, false);
  if (three.ok) return;
  assert.ok(three.errors.some((error) => error.includes("expected at most 2 items")));
});

test("candidate IDs must be sequential and result objects reject unknown fields", () => {
  const wrongId = parseMiniMaxReviewPayload(reviewPayload([fatalCandidate("C-2")]));
  assert.equal(wrongId.ok, false);
  if (!wrongId.ok) {
    assert.ok(wrongId.errors.some((error) => error.includes('expected "C-1"')));
  }

  const candidate = fatalCandidate();
  candidate.confidence = 0.99;
  const extraCandidateField = parseMiniMaxReviewPayload(reviewPayload([candidate]));
  assert.equal(extraCandidateField.ok, false);
  if (!extraCandidateField.ok) {
    assert.ok(extraCandidateField.errors.some((error) => error.includes("confidence: unexpected field")));
  }

  const extraRootField = parseMiniMaxReviewPayload({ ...reviewPayload(), summary: "통과" });
  assert.equal(extraRootField.ok, false);
  if (!extraRootField.ok) {
    assert.ok(extraRootField.errors.some((error) => error.includes("summary: unexpected field")));
  }
});

test("every human-readable candidate field must contain Korean", () => {
  const candidate = fatalCandidate();
  candidate.title_ko = "Deterministic crash";
  candidate.impact_ko = "No save possible";
  const parsed = parseMiniMaxReviewPayload(reviewPayload([candidate]));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.ok(parsed.errors.some((error) => error.includes("title_ko") && error.includes("Korean")));
  assert.ok(parsed.errors.some((error) => error.includes("impact_ko") && error.includes("Korean")));
});

test("fatal candidate requires exact root evidence and rejects test-gap-only fields", () => {
  const missingRootEvidence = fatalCandidate();
  missingRootEvidence.evidence = [
    {
      file: "src/save.ts",
      line: 41,
      code_quote: "save(input)",
      explanation_ko: "예외 호출 직전의 코드만 보입니다.",
    },
  ];
  const parsed = parseMiniMaxReviewPayload(reviewPayload([missingRootEvidence]));
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.ok(parsed.errors.some((error) => error.includes("exact root")));
  }

  // M3가 습관적으로 채우는 잉여 AC 연결은 오류가 아니라 드롭 대상이다.
  const polluted = fatalCandidate();
  polluted.criterion_id = "AC-1";
  polluted.acceptance_criterion = "저장한다.";
  polluted.test_search_summary_ko = "테스트가 없습니다.";
  const pollutedResult = parseMiniMaxReviewPayload(reviewPayload([polluted]));
  assert.equal(pollutedResult.ok, true);
  if (pollutedResult.ok) {
    assert.equal(pollutedResult.value.candidates[0]?.criterionId, null);
    assert.equal(pollutedResult.value.candidates[0]?.acceptanceCriterion, null);
    assert.equal(pollutedResult.value.candidates[0]?.testSearchSummaryKo, null);
  }
});

test("fatal candidate requires a stable symbol while missing-test symbol may be null", () => {
  const fatalWithoutSymbol = fatalCandidate();
  fatalWithoutSymbol.symbol = null;
  const fatalParsed = parseMiniMaxReviewPayload(reviewPayload([fatalWithoutSymbol]));
  assert.equal(fatalParsed.ok, false);
  if (!fatalParsed.ok) {
    assert.ok(fatalParsed.errors.some((error) => error.includes("symbol: required")));
  }

  const missingWithoutVisibleSymbol = missingTestCandidate();
  missingWithoutVisibleSymbol.symbol = null;
  const missingParsed = parseMiniMaxReviewPayload(
    reviewPayload([missingWithoutVisibleSymbol], [acceptanceCoverage("missing")]),
  );
  assert.equal(missingParsed.ok, true);
  if (missingParsed.ok) {
    assert.equal(missingParsed.value.candidates[0]?.symbol, null);
  }
});

test("missing-test candidate requires an AC mapping and Korean exhaustive-search summary", () => {
  const missingMapping = missingTestCandidate();
  missingMapping.criterion_id = null;
  missingMapping.acceptance_criterion = null;
  missingMapping.test_search_summary_ko = "No tests found";
  const parsed = parseMiniMaxReviewPayload(
    reviewPayload([missingMapping], [acceptanceCoverage("missing")]),
  );
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.ok(parsed.errors.some((error) => error.includes("criterion_id: required")));
  assert.ok(parsed.errors.some((error) => error.includes("acceptance_criterion: required")));
  assert.ok(parsed.errors.some((error) => error.includes("test_search_summary_ko") && error.includes("Korean")));
});

test("strict JSON text and a single JSON fence are accepted only as fallback", () => {
  const payload = reviewPayload(
    [missingTestCandidate()],
    [acceptanceCoverage("missing")],
  );
  const rawJson = messagesResponse(payload, {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    stop_reason: "end_turn",
  });
  const rawParsed = parseMiniMaxReviewResponse(rawJson);
  assert.equal(rawParsed.ok, true);
  if (rawParsed.ok) assert.equal(rawParsed.source, "text");

  const fenced = messagesResponse(payload, {
    content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` }],
    stop_reason: "end_turn",
  });
  assert.equal(parseMiniMaxReviewResponse(fenced).ok, true);

  const proseWrapped = messagesResponse(payload, {
    content: [{ type: "text", text: `검토 결과입니다.\n${JSON.stringify(payload)}` }],
    stop_reason: "end_turn",
  });
  const invalid = parseMiniMaxReviewResponse(proseWrapped);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.ok(invalid.errors.some((error) => error.includes("invalid JSON")));
});

test("tool response cannot bypass strict validation through an accompanying text block", () => {
  const invalidPayload = reviewPayload([{ title_ko: "불완전" }]);
  const response = messagesResponse(invalidPayload, {
    content: [
      { type: "text", text: JSON.stringify(reviewPayload()) },
      {
        type: "tool_use",
        id: "tool_test",
        name: MINIMAX_REVIEW_TOOL_NAME,
        input: invalidPayload,
      },
    ],
  });
  assert.equal(parseMiniMaxReviewResponse(response).ok, false);
});

test("Messages envelope rejects API errors, truncation, unexpected tools, and duplicate submissions", () => {
  const apiError = messagesResponse(reviewPayload(), {
    base_resp: { status_code: 1001, status_msg: "invalid request" },
  });
  assert.equal(parseMiniMaxReviewResponse(apiError).ok, false);

  const truncated = messagesResponse(reviewPayload(), { stop_reason: "max_tokens" });
  assert.equal(parseMiniMaxReviewResponse(truncated).ok, false);

  const unexpectedTool = messagesResponse(reviewPayload(), {
    content: [{ type: "tool_use", id: "x", name: "other_tool", input: {} }],
  });
  assert.equal(parseMiniMaxReviewResponse(unexpectedTool).ok, false);

  const duplicate = messagesResponse(reviewPayload(), {
    content: [
      { type: "tool_use", id: "a", name: MINIMAX_REVIEW_TOOL_NAME, input: reviewPayload() },
      { type: "tool_use", id: "b", name: MINIMAX_REVIEW_TOOL_NAME, input: reviewPayload() },
    ],
  });
  const duplicateParsed = parseMiniMaxReviewResponse(duplicate);
  assert.equal(duplicateParsed.ok, false);
  if (!duplicateParsed.ok) {
    assert.ok(duplicateParsed.errors.some((error) => error.includes("exactly one")));
  }
});

test("Messages response can be supplied as serialized JSON and rejects malformed JSON", () => {
  const serialized = JSON.stringify(messagesResponse(reviewPayload()));
  assert.equal(parseMiniMaxReviewResponse(serialized).ok, true);

  const invalid = parseMiniMaxReviewResponse("{not json}");
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.ok(invalid.errors[0]?.includes("invalid JSON"));
});

test("verifier maps confirmed/rejected/uncertain results and checks expected IDs", () => {
  const payload = {
    verifications: [verification("C-1", "rejected"), verification("C-2", "uncertain")],
  };
  const parsed = parseMiniMaxVerificationResponse(messagesResponse(payload), {
    expectedCandidates: [
      { candidateId: "C-1", kind: "fatal_defect" },
      { candidateId: "C-2", kind: "missing_acceptance_test" },
    ],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.verifications[0]?.verdict, "rejected");
  assert.equal(parsed.value.verifications[0]?.reasonKo.includes("보호 조건"), true);
  assert.equal(parsed.value.verifications[1]?.evidence.length, 0);

  const missingResult = parseMiniMaxVerificationPayload(
    { verifications: [verification("C-1", "rejected")] },
    { expectedCandidateIds: ["C-1", "C-2"] },
  );
  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) {
    assert.ok(missingResult.errors.some((error) => error.includes("one result per supplied candidate")));
  }
});

test("confirmed and rejected verifier verdicts require current-HEAD evidence", () => {
  const rejected = verification("C-1", "rejected");
  rejected.evidence = [];
  const rejectedParsed = parseMiniMaxVerificationPayload({ verifications: [rejected] });
  assert.equal(rejectedParsed.ok, false);
  if (!rejectedParsed.ok) {
    assert.ok(rejectedParsed.errors.some((error) => error.includes("rejected verdict requires")));
  }

  const confirmed = verification("C-1", "confirmed");
  confirmed.evidence = [];
  assert.equal(parseMiniMaxVerificationPayload({ verifications: [confirmed] }).ok, false);

  const uncertain = verification("C-1", "uncertain");
  assert.equal(parseMiniMaxVerificationPayload({ verifications: [uncertain] }).ok, true);
});

test("confirmed missing-test candidate may rely on host exhaustive inventory without code evidence", () => {
  const missingConfirmed = verification("C-1", "confirmed");
  missingConfirmed.evidence = [];
  const allowed = parseMiniMaxVerificationPayload(
    { verifications: [missingConfirmed] },
    {
      expectedCandidates: [{ candidateId: "C-1", kind: "missing_acceptance_test" }],
    },
  );
  assert.equal(allowed.ok, true);

  const fatalConfirmed = verification("C-1", "confirmed");
  fatalConfirmed.evidence = [];
  const fatalRejected = parseMiniMaxVerificationPayload(
    { verifications: [fatalConfirmed] },
    { expectedCandidates: [{ candidateId: "C-1", kind: "fatal_defect" }] },
  );
  assert.equal(fatalRejected.ok, false);

  const missingRejected = verification("C-1", "rejected");
  missingRejected.evidence = [];
  const rejectionWithoutCoveringTest = parseMiniMaxVerificationPayload(
    { verifications: [missingRejected] },
    {
      expectedCandidates: [{ candidateId: "C-1", kind: "missing_acceptance_test" }],
    },
  );
  assert.equal(rejectionWithoutCoveringTest.ok, false);
});

test("verifier rejects English public reasons, unknown fields, and invalid enums", () => {
  const english = verification();
  english.reason_ko = "The guard disproves this finding.";
  const englishResult = parseMiniMaxVerificationPayload({ verifications: [english] });
  assert.equal(englishResult.ok, false);
  if (!englishResult.ok) {
    assert.ok(englishResult.errors.some((error) => error.includes("reason_ko") && error.includes("Korean")));
  }

  const unknown = verification();
  unknown.confidence = 1;
  const unknownResult = parseMiniMaxVerificationPayload({ verifications: [unknown] });
  assert.equal(unknownResult.ok, false);
  if (!unknownResult.ok) {
    assert.ok(unknownResult.errors.some((error) => error.includes("confidence: unexpected field")));
  }

  const invalidVerdict = verification();
  invalidVerdict.verdict = "probably_confirmed";
  const invalidVerdictResult = parseMiniMaxVerificationPayload({ verifications: [invalidVerdict] });
  assert.equal(invalidVerdictResult.ok, false);
  if (!invalidVerdictResult.ok) {
    assert.ok(invalidVerdictResult.errors.some((error) => error.includes("verdict: unexpected enum")));
  }
});

test("비-covered 행의 빈 test_evidence 객체는 null로 정규화되어 통과한다", () => {
  const emptyObject = { ...acceptanceCoverage("unknown"), test_evidence: {} };
  const emptyValues = {
    ...acceptanceCoverage("unknown"),
    test_evidence: { file: "", line: null, test_name: "", assertion_quote: "", explanation_ko: null },
  };
  for (const entry of [emptyObject, emptyValues]) {
    const parsed = parseMiniMaxReviewResponse(
      messagesResponse(reviewPayload([], [entry])),
      { expectedAcceptanceCriteria: ["저장 후 다시 열어도 값이 유지된다."] },
    );
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.acceptanceCoverage[0]?.testEvidence, null);
    }
  }
});

test("비-covered 행에 실제 내용이 있는 test_evidence는 여전히 거부된다", () => {
  const withContent = {
    ...acceptanceCoverage("unknown"),
    test_evidence: {
      file: "src/save.test.ts",
      line: 28,
      test_name: "저장값을 다시 복원한다",
      assertion_quote: "assert.equal(restored.value, expected)",
      explanation_ko: "단언입니다.",
    },
  };
  const parsed = parseMiniMaxReviewResponse(
    messagesResponse(reviewPayload([], [withContent])),
    { expectedAcceptanceCriteria: ["저장 후 다시 열어도 값이 유지된다."] },
  );
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.ok(parsed.errors.some((error) => error.includes("requires null")));
  }
});

test("비-covered 행의 누락·비정형 evidence 키는 계약 기본값으로 정규화된다", () => {
  const absentKeys = { ...acceptanceCoverage("unknown") } as Record<string, unknown>;
  delete absentKeys.test_evidence;
  delete absentKeys.supporting_test_evidence;
  const junkShapes = {
    ...acceptanceCoverage("unknown"),
    test_evidence: "없음",
    supporting_test_evidence: "없음",
  };
  for (const entry of [absentKeys, junkShapes]) {
    const parsed = parseMiniMaxReviewResponse(
      messagesResponse(reviewPayload([], [entry])),
      { expectedAcceptanceCriteria: ["저장 후 다시 열어도 값이 유지된다."] },
    );
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.acceptanceCoverage[0]?.testEvidence, null);
      assert.deepEqual(parsed.value.acceptanceCoverage[0]?.supportingTestEvidence, []);
    }
  }
});

test("candidates 키가 통째로 빠지면 빈 배열로 정규화된다", () => {
  const payload = { acceptance_coverage: [acceptanceCoverage("unknown")] };
  const parsed = parseMiniMaxReviewResponse(messagesResponse(payload), {
    expectedAcceptanceCriteria: ["저장 후 다시 열어도 값이 유지된다."],
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.value.candidates, []);
  }
});

test("무의미 키만 든 test_evidence 객체도 null로 정규화된다", () => {
  const garbage = {
    ...acceptanceCoverage("unknown"),
    test_evidence: { $text: "근거를 찾지 못했습니다." },
  };
  const parsed = parseMiniMaxReviewResponse(
    messagesResponse(reviewPayload([], [garbage])),
    { expectedAcceptanceCriteria: ["저장 후 다시 열어도 값이 유지된다."] },
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.acceptanceCoverage[0]?.testEvidence, null);
  }
});
