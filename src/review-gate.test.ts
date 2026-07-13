import assert from "node:assert/strict";
import test from "node:test";
import {
  decideReviewGate,
  evaluateReviewGate,
  parseReviewGateResponse,
  type ReviewGateEvaluationOptions,
  type ReviewGateResponse,
} from "./review-gate.js";

const HOST_COMPLETE: ReviewGateEvaluationOptions = { testInventoryComplete: true };

function coveredCriterion(
  id = "AC-1",
  sourceQuote = "저장 후 다시 열어도 값이 유지된다.",
) {
  return {
    id,
    source_quote: sourceQuote,
    testability: "automated",
    coverage: "covered",
    test_evidence: {
      file: "src/save.test.ts",
      test_name: "저장값을 복원한다",
      assertion_quote: "assert.equal(restored.value, expected)",
    },
  };
}

function missingCriterion(id = "AC-1") {
  return {
    id,
    source_quote: "저장 후 다시 열어도 값이 유지된다.",
    testability: "automated",
    coverage: "missing",
    test_evidence: null,
  };
}

function wireResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    context_status: "sufficient",
    test_inventory_complete: true,
    criteria: [coveredCriterion()],
    fatal_blockers: [],
    abstain_reasons: [],
    ...overrides,
  };
}

function fatalBlocker(index = 1) {
  return {
    file: `src/fatal-${index}.ts`,
    line: index,
    code_quote: "throw new Error('fatal')",
    outcome: "deterministic_crash",
    trigger: "사용자가 기본 저장 동작을 실행한다.",
    causal_chain: "저장 호출 -> 무조건 throw -> 프로세스 종료",
    causal_evidence: [
      {
        file: `src/fatal-${index}.ts`,
        line: index,
        code_quote: "throw new Error('fatal')",
      },
      {
        file: `src/fatal-${index}.ts`,
        line: index + 1,
        code_quote: "process.exit(1)",
      },
    ],
  };
}

test("strict parser accepts the exact schema and maps it to camelCase", () => {
  const parsed = parseReviewGateResponse(JSON.stringify(wireResponse()));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.contextStatus, "sufficient");
  assert.equal(parsed.value.testInventoryComplete, true);
  assert.equal(parsed.value.criteria[0]?.testEvidence?.testName, "저장값을 복원한다");
});

test("all automated criteria covered produces PASS", () => {
  const result = evaluateReviewGate(JSON.stringify(wireResponse()), HOST_COMPLETE);
  assert.equal(result.decision.verdict, "PASS");
});

test("an unchanged current-HEAD test can pass even when the overall inventory is partial", () => {
  const result = evaluateReviewGate(
    JSON.stringify(wireResponse({ test_inventory_complete: false })),
    { testInventoryComplete: false },
  );
  assert.equal(result.decision.verdict, "PASS");
});

test("manual and not-applicable criteria are nonblocking", () => {
  const response = wireResponse({
    criteria: [
      {
        id: "AC-1",
        source_quote: "실기기에서 화면이 자연스럽게 보인다.",
        testability: "manual",
        coverage: "unknown",
        test_evidence: null,
      },
      {
        id: "AC-2",
        source_quote: "릴리스 문구를 갱신한다.",
        testability: "not_applicable",
        coverage: "unknown",
        test_evidence: null,
      },
    ],
  });
  assert.equal(evaluateReviewGate(JSON.stringify(response), HOST_COMPLETE).decision.verdict, "PASS");
});

test("product-logic changes cannot pass with only manual or not-applicable criteria", () => {
  const response = wireResponse({
    criteria: [
      {
        id: "AC-1",
        source_quote: "화면에서 직접 동작을 확인한다.",
        testability: "manual",
        coverage: "unknown",
        test_evidence: null,
      },
    ],
  });
  assert.equal(
    evaluateReviewGate(JSON.stringify(response), {
      testInventoryComplete: true,
      requiresAutomatedEvidence: true,
    }).decision.verdict,
    "ABSTAIN",
  );
});

test("the model cannot pass after omitting explicit acceptance checklist items", () => {
  assert.equal(
    evaluateReviewGate(JSON.stringify(wireResponse()), {
      testInventoryComplete: true,
      minimumAcceptanceCriteria: 2,
    }).decision.verdict,
    "ABSTAIN",
  );
});

test("runtime policy cannot infer acceptance criteria from ordinary prose", () => {
  assert.equal(
    evaluateReviewGate(JSON.stringify(wireResponse()), {
      testInventoryComplete: true,
      requiresExplicitAcceptanceCriteria: true,
      explicitAcceptanceCriteria: [],
    }).decision.verdict,
    "ABSTAIN",
  );
});

test("host-extracted explicit criteria require distinct exact one-to-one mappings", () => {
  const duplicated = wireResponse({
    criteria: [coveredCriterion("AC-1"), coveredCriterion("AC-2")],
  });
  assert.equal(
    evaluateReviewGate(JSON.stringify(duplicated), {
      testInventoryComplete: true,
      explicitAcceptanceCriteria: [
        "저장 후 다시 열어도 값이 유지된다.",
        "로그아웃하면 세션이 폐기된다.",
      ],
    }).decision.verdict,
    "ABSTAIN",
  );

  const replaced = wireResponse({
    criteria: [
      coveredCriterion("AC-1", "저장 후 다시 열어도 값이 유지된다."),
      coveredCriterion("AC-2", "README 문구를 갱신한다."),
    ],
  });
  assert.equal(
    evaluateReviewGate(JSON.stringify(replaced), {
      testInventoryComplete: true,
      explicitAcceptanceCriteria: [
        "저장 후 다시 열어도 값이 유지된다.",
        "로그아웃하면 세션이 폐기된다.",
      ],
    }).decision.verdict,
    "ABSTAIN",
  );

  const mapped = wireResponse({
    criteria: [
      coveredCriterion("AC-1", "저장 후 다시 열어도 값이 유지된다."),
      coveredCriterion("AC-2", "로그아웃하면 세션이 폐기된다."),
    ],
  });
  assert.equal(
    evaluateReviewGate(JSON.stringify(mapped), {
      testInventoryComplete: true,
      requiresExplicitAcceptanceCriteria: true,
      explicitAcceptanceCriteria: [
        "저장 후 다시 열어도 값이 유지된다.",
        "로그아웃하면 세션이 폐기된다.",
      ],
    }).decision.verdict,
    "PASS",
  );

  const extra = wireResponse({
    criteria: [
      coveredCriterion("AC-1", "저장 후 다시 열어도 값이 유지된다."),
      coveredCriterion("AC-2", "README 문구를 갱신한다."),
    ],
  });
  assert.equal(
    evaluateReviewGate(JSON.stringify(extra), {
      testInventoryComplete: true,
      requiresExplicitAcceptanceCriteria: true,
      explicitAcceptanceCriteria: ["저장 후 다시 열어도 값이 유지된다."],
    }).decision.verdict,
    "ABSTAIN",
  );
});

test("missing automated coverage always holds for manual confirmation", () => {
  const complete = wireResponse({ criteria: [missingCriterion()] });
  assert.equal(evaluateReviewGate(JSON.stringify(complete), HOST_COMPLETE).decision.verdict, "ABSTAIN");

  const modelIncomplete = wireResponse({
    test_inventory_complete: false,
    criteria: [missingCriterion()],
  });
  assert.equal(evaluateReviewGate(JSON.stringify(modelIncomplete), HOST_COMPLETE).decision.verdict, "ABSTAIN");

  assert.equal(
    evaluateReviewGate(JSON.stringify(complete), { testInventoryComplete: false }).decision.verdict,
    "ABSTAIN",
  );
});

test("unknown automated coverage abstains", () => {
  const response = wireResponse({
    criteria: [
      {
        id: "AC-1",
        source_quote: "값이 유지된다.",
        testability: "automated",
        coverage: "unknown",
        test_evidence: null,
      },
    ],
  });
  assert.equal(evaluateReviewGate(JSON.stringify(response), HOST_COMPLETE).decision.verdict, "ABSTAIN");
});

test("a schema-valid fatal blocker fails and exposes exact evidence", () => {
  const result = evaluateReviewGate(
    JSON.stringify(wireResponse({ fatal_blockers: [fatalBlocker()] })),
    HOST_COMPLETE,
  );
  assert.equal(result.decision.verdict, "FAIL");
  assert.equal(result.decision.fatalBlockers[0]?.line, 1);
});

test("a grounded fatal blocker can fail without acceptance criteria", () => {
  const result = evaluateReviewGate(
    JSON.stringify(wireResponse({ criteria: [], fatal_blockers: [fatalBlocker()] })),
    HOST_COMPLETE,
  );
  assert.equal(result.decision.verdict, "FAIL");
  assert.equal(result.decision.fatalBlockers.length, 1);
});

test("fatal output still abstains when the model declares uncertainty", () => {
  const result = evaluateReviewGate(
    JSON.stringify(
      wireResponse({
        fatal_blockers: [fatalBlocker()],
        abstain_reasons: ["호출 대상 구현이 보이지 않는다."],
      }),
    ),
    HOST_COMPLETE,
  );
  assert.equal(result.decision.verdict, "ABSTAIN");
  assert.equal(result.decision.fatalBlockers.length, 0);
});

test("a grounded fatal blocker remains the only FAIL reason when test coverage is unresolved", () => {
  const result = evaluateReviewGate(
    JSON.stringify(
      wireResponse({
        criteria: [missingCriterion()],
        fatal_blockers: [fatalBlocker()],
      }),
    ),
    HOST_COMPLETE,
  );
  assert.equal(result.decision.verdict, "FAIL");
  assert.deepEqual(result.decision.missingCriteria, []);
  assert.equal(result.decision.fatalBlockers.length, 1);
  assert.equal(result.decision.reasons.length, 1);
});

test("insufficient context and explicit abstain reasons abstain", () => {
  const insufficient = wireResponse({
    context_status: "insufficient",
    abstain_reasons: ["관련 테스트 본문이 제공되지 않았다."],
  });
  assert.equal(evaluateReviewGate(JSON.stringify(insufficient), HOST_COMPLETE).decision.verdict, "ABSTAIN");

  const explicit = wireResponse({ abstain_reasons: ["서로 상충하는 근거가 있다."] });
  assert.equal(evaluateReviewGate(JSON.stringify(explicit), HOST_COMPLETE).decision.verdict, "ABSTAIN");
});

test("malformed and incomplete responses abstain instead of being normalized", () => {
  for (const raw of ["{}", "```json\n{}\n```", '{"context_status":"sufficient"']) {
    const result = evaluateReviewGate(raw, HOST_COMPLETE);
    assert.equal(result.response, null);
    assert.equal(result.decision.verdict, "ABSTAIN");
    assert.ok(result.parseErrors.length > 0);
  }
});

test("unknown enums, unknown fields, and missing required fields are rejected", () => {
  const cases = [
    wireResponse({ context_status: "maybe" }),
    { ...wireResponse(), surprise: true },
    wireResponse({ criteria: [coveredCriterion("AC-2")] }),
    (() => {
      const response = wireResponse();
      delete response.criteria;
      return response;
    })(),
  ];

  for (const value of cases) {
    assert.equal(parseReviewGateResponse(JSON.stringify(value)).ok, false);
  }
});

test("covered criteria require complete evidence and missing criteria require null evidence", () => {
  const missingEvidence = { ...coveredCriterion(), test_evidence: null };
  const unexpectedEvidence = {
    ...missingCriterion(),
    test_evidence: coveredCriterion().test_evidence,
  };

  assert.equal(
    parseReviewGateResponse(JSON.stringify(wireResponse({ criteria: [missingEvidence] }))).ok,
    false,
  );
  assert.equal(
    parseReviewGateResponse(JSON.stringify(wireResponse({ criteria: [unexpectedEvidence] }))).ok,
    false,
  );
});

test("manual and not-applicable criteria require unknown coverage without evidence", () => {
  for (const testability of ["manual", "not_applicable"]) {
    const invalid = {
      id: "AC-1",
      source_quote: "사람이 확인한다.",
      testability,
      coverage: "missing",
      test_evidence: null,
    };
    assert.equal(
      parseReviewGateResponse(JSON.stringify(wireResponse({ criteria: [invalid] }))).ok,
      false,
    );
  }
});

test("fatal blockers require exact fields, 2-6 causal lines, and at most two blockers", () => {
  const incomplete = fatalBlocker() as Record<string, unknown>;
  delete incomplete.code_quote;
  const incompleteCausalChain = {
    ...fatalBlocker(),
    causal_evidence: fatalBlocker().causal_evidence.slice(0, 1),
  };

  assert.equal(
    parseReviewGateResponse(JSON.stringify(wireResponse({ fatal_blockers: [incomplete] }))).ok,
    false,
  );
  assert.equal(
    parseReviewGateResponse(
      JSON.stringify(wireResponse({ fatal_blockers: [incompleteCausalChain] })),
    ).ok,
    false,
  );
  assert.equal(
    parseReviewGateResponse(
      JSON.stringify(wireResponse({ fatal_blockers: [fatalBlocker(1), fatalBlocker(2), fatalBlocker(3)] })),
    ).ok,
    false,
  );
});

test("untrusted evidence validator results and exceptions become ABSTAIN", () => {
  const parsed = parseReviewGateResponse(
    JSON.stringify(wireResponse({ fatal_blockers: [fatalBlocker()] })),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const rejected = decideReviewGate(parsed.value, {
    testInventoryComplete: true,
    evidenceValidators: { fatalBlocker: () => false },
  });
  assert.equal(rejected.verdict, "ABSTAIN");

  const throws = decideReviewGate(parsed.value, {
    testInventoryComplete: true,
    evidenceValidators: {
      sourceQuote: () => {
        throw new Error("context lookup failed");
      },
    },
  });
  assert.equal(throws.verdict, "ABSTAIN");
});

test("trusted evidence validators preserve the normal verdict", () => {
  const result = evaluateReviewGate(JSON.stringify(wireResponse()), {
    testInventoryComplete: true,
    evidenceValidators: {
      sourceQuote: () => true,
      testEvidence: () => true,
      fatalBlocker: () => true,
    },
  });
  assert.equal(result.decision.verdict, "PASS");
});

test("domain decision API abstains when no explicit acceptance criteria exist", () => {
  const response: ReviewGateResponse = {
    contextStatus: "sufficient",
    testInventoryComplete: false,
    criteria: [],
    fatalBlockers: [],
    abstainReasons: [],
  };
  assert.equal(decideReviewGate(response, { testInventoryComplete: false }).verdict, "ABSTAIN");
});
