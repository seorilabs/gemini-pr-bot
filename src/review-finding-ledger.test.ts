import assert from "node:assert/strict";
import test from "node:test";
import {
  createStoredReviewFinding,
  fingerprintReviewFinding,
  hashReviewFindingEvidence,
  parseStoredReviewFinding,
  reconcileReviewFindingLedger,
  refuteReviewFinding,
  shouldReuseReviewFindingSnapshot,
  type FatalFindingCandidate,
  type ReviewFindingEvidence,
} from "./review-finding-ledger.js";

const HEAD_1 = { headSha: "head-1", contextHash: "context-1" };
const HEAD_2 = { headSha: "head-2", contextHash: "context-2" };

test("semantic fingerprint uses the AC hash or fatal outcome and stable target", () => {
  const fatal = fatalCandidate();
  const moved = fatalCandidate({ evidence: [codeEvidence(999)] });
  assert.equal(fingerprintReviewFinding(fatal), fingerprintReviewFinding(moved));

  const otherOutcome = fatalCandidate({ outcome: "primary_flow_unusable" });
  assert.notEqual(fingerprintReviewFinding(fatal), fingerprintReviewFinding(otherOutcome));

  const missingA = missingTestsCandidate("저장하면 목록에 즉시 표시된다.");
  const missingB = missingTestsCandidate("  저장하면   목록에 즉시 표시된다.  ");
  assert.equal(fingerprintReviewFinding(missingA), fingerprintReviewFinding(missingB));
  assert.notEqual(
    fingerprintReviewFinding(missingA),
    fingerprintReviewFinding(missingTestsCandidate("삭제하면 목록에서 사라진다.")),
  );
});

test("evidence hash is order and line movement invariant but changes with evidence content", () => {
  const first = codeEvidence(12);
  const second: ReviewFindingEvidence = {
    kind: "code",
    file: "src/save.ts",
    line: 30,
    symbol: "saveDraft",
    quote: "await storage.remove(id)",
  };
  assert.equal(
    hashReviewFindingEvidence([first, second]),
    hashReviewFindingEvidence([{ ...second, line: 300 }, { ...first, line: 120 }]),
  );
  assert.notEqual(
    hashReviewFindingEvidence([first]),
    hashReviewFindingEvidence([{ ...first, quote: "await storage.put(id, value)" }]),
  );
});

test("same HEAD and context reuses the stored result", () => {
  assert.equal(shouldReuseReviewFindingSnapshot(HEAD_1, { ...HEAD_1 }), true);
  assert.equal(
    shouldReuseReviewFindingSnapshot(HEAD_1, { ...HEAD_1, contextHash: "changed" }),
    false,
  );
  assert.equal(shouldReuseReviewFindingSnapshot(HEAD_1, HEAD_2), false);
  assert.equal(shouldReuseReviewFindingSnapshot(null, HEAD_1), false);
});

test("persisted finding decoder rejects corrupt hashes and accepts a valid snapshot", () => {
  const finding = createStoredReviewFinding(fatalCandidate(), HEAD_1);
  assert.deepEqual(parseStoredReviewFinding(JSON.parse(JSON.stringify(finding))), finding);
  assert.throws(
    () => parseStoredReviewFinding({ ...finding, evidenceHash: "0".repeat(64) }),
    /hashes do not match/u,
  );
});

test("same semantic finding is updated instead of duplicated", () => {
  const previous = createStoredReviewFinding(fatalCandidate(), HEAD_1);
  const changedEvidence = fatalCandidate({
    evidence: [{ ...codeEvidence(25), quote: "throw new Error('영구 실패')" }],
  });
  const result = reconcileReviewFindingLedger([previous], {
    identity: HEAD_2,
    candidates: [changedEvidence],
    evidenceInventory: { complete: true, evidenceHashes: [] },
    regressionEvidence: [],
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.transitions.length, 1);
  assert.equal(result.transitions[0]?.kind, "updated");
  assert.equal(result.publishable.length, 1);
  assert.equal(result.findings[0]?.firstSeenHeadSha, HEAD_1.headSha);
  assert.equal(result.findings[0]?.lastSeenHeadSha, HEAD_2.headSha);
});

test("duplicate candidates in one review collapse and merge their evidence", () => {
  const one = fatalCandidate();
  const two = fatalCandidate({
    evidence: [{ ...codeEvidence(19), quote: "return corruptedValue" }],
  });
  const result = reconcileReviewFindingLedger([], {
    identity: HEAD_1,
    candidates: [one, two, one],
    evidenceInventory: { complete: true, evidenceHashes: [] },
    regressionEvidence: [],
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.candidate.evidence.length, 2);
  assert.equal(result.transitions[0]?.kind, "created");
});

test("new HEAD resolves an open finding only when exact evidence is proven absent", () => {
  const previous = createStoredReviewFinding(fatalCandidate(), HEAD_1);
  const resolved = reconcileReviewFindingLedger([previous], {
    identity: HEAD_2,
    candidates: [],
    evidenceInventory: { complete: true, evidenceHashes: [] },
    regressionEvidence: [],
  });
  assert.equal(resolved.findings[0]?.state, "resolved");
  assert.equal(resolved.transitions[0]?.kind, "resolved");

  const modelOmission = reconcileReviewFindingLedger([previous], {
    identity: HEAD_2,
    candidates: [],
    evidenceInventory: { complete: true, evidenceHashes: [previous.evidenceHash] },
    regressionEvidence: [],
  });
  assert.equal(modelOmission.findings[0]?.state, "open");
  assert.equal(modelOmission.transitions[0]?.kind, "unchanged");

  const incompleteInventory = reconcileReviewFindingLedger([previous], {
    identity: HEAD_2,
    candidates: [],
    evidenceInventory: { complete: false, evidenceHashes: [] },
    regressionEvidence: [],
  });
  assert.equal(incompleteInventory.findings[0]?.state, "open");

  const laterCompleteInventory = reconcileReviewFindingLedger(incompleteInventory.findings, {
    identity: HEAD_2,
    candidates: [],
    evidenceInventory: { complete: true, evidenceHashes: [] },
    regressionEvidence: [],
  });
  assert.equal(laterCompleteInventory.findings[0]?.state, "resolved");

  const sameHead = reconcileReviewFindingLedger([previous], {
    identity: { ...HEAD_1, contextHash: "new-context" },
    candidates: [],
    evidenceInventory: { complete: true, evidenceHashes: [] },
    regressionEvidence: [],
  });
  assert.equal(sameHead.findings[0]?.state, "open");

  const sameHeadWithDirectCounterevidence = reconcileReviewFindingLedger([previous], {
    identity: { ...HEAD_1, contextHash: "grounded-context" },
    candidates: [],
    evidenceInventory: {
      complete: false,
      evidenceHashes: [],
      provenAbsentFingerprints: [previous.semanticFingerprint],
    },
    regressionEvidence: [],
  });
  assert.equal(sameHeadWithDirectCounterevidence.findings[0]?.state, "resolved");
});

test("한 finding의 직접 반증은 다른 finding의 불완전한 inventory와 독립적으로 해소된다", () => {
  const fixed = createStoredReviewFinding(
    missingTestsCandidate("저장 후 목록에 즉시 표시된다."),
    HEAD_1,
  );
  const stillUnknown = createStoredReviewFinding(
    missingTestsCandidate("삭제 후 목록에서 즉시 사라진다."),
    HEAD_1,
  );

  const result = reconcileReviewFindingLedger([fixed, stillUnknown], {
    identity: HEAD_2,
    candidates: [],
    evidenceInventory: {
      complete: false,
      evidenceHashes: [stillUnknown.evidenceHash],
      provenAbsentFingerprints: [fixed.semanticFingerprint],
    },
    regressionEvidence: [],
  });

  const byFingerprint = new Map(
    result.findings.map((finding) => [finding.semanticFingerprint, finding]),
  );
  assert.equal(byFingerprint.get(fixed.semanticFingerprint)?.state, "resolved");
  assert.equal(byFingerprint.get(stillUnknown.semanticFingerprint)?.state, "open");
});

test("maintainer-refuted tombstone suppresses a repeated model finding", () => {
  const previous = createStoredReviewFinding(fatalCandidate(), HEAD_1);
  const refuted = refuteReviewFinding(
    previous,
    HEAD_1,
    "src/save.ts:12의 null guard 때문에 이 경로는 실행되지 않습니다.",
  );
  const result = reconcileReviewFindingLedger([refuted], {
    identity: HEAD_2,
    candidates: [fatalCandidate()],
    evidenceInventory: { complete: true, evidenceHashes: [previous.evidenceHash] },
    regressionEvidence: [],
  });

  assert.equal(result.findings[0]?.state, "refuted");
  assert.equal(result.transitions[0]?.kind, "suppressed");
  assert.deepEqual(result.publishable, []);
});

test("refuted finding reopens only with grounded regression evidence on its target symbol", () => {
  const previous = createStoredReviewFinding(fatalCandidate(), HEAD_1);
  const refuted = refuteReviewFinding(previous, HEAD_1, "null guard가 추가됐습니다.");
  const wrongSymbol = reconcileReviewFindingLedger([refuted], {
    identity: HEAD_2,
    candidates: [fatalCandidate()],
    evidenceInventory: { complete: true, evidenceHashes: [] },
    regressionEvidence: [
      { file: "src/save.ts", symbol: "loadDraft", diffEvidence: "+ return null" },
    ],
  });
  assert.equal(wrongSymbol.findings[0]?.state, "refuted");

  const regression = reconcileReviewFindingLedger([refuted], {
    identity: HEAD_2,
    candidates: [fatalCandidate()],
    evidenceInventory: { complete: true, evidenceHashes: [] },
    regressionEvidence: [
      { file: "src/save.ts", symbol: "saveDraft", diffEvidence: "- if (value == null) return" },
    ],
  });
  assert.equal(regression.findings[0]?.state, "open");
  assert.equal(regression.transitions[0]?.kind, "reopened");
  assert.equal(regression.publishable.length, 1);
});

test("a resolved semantic finding reopens as the same ledger entry", () => {
  const original = createStoredReviewFinding(fatalCandidate(), HEAD_1);
  const resolved = reconcileReviewFindingLedger([original], {
    identity: HEAD_2,
    candidates: [],
    evidenceInventory: { complete: true, evidenceHashes: [] },
    regressionEvidence: [],
  }).findings[0];
  assert.ok(resolved);

  const result = reconcileReviewFindingLedger([resolved], {
    identity: { headSha: "head-3", contextHash: "context-3" },
    candidates: [fatalCandidate()],
    evidenceInventory: { complete: true, evidenceHashes: [] },
    regressionEvidence: [],
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.transitions[0]?.kind, "reopened");
  assert.equal(result.findings[0]?.firstSeenHeadSha, HEAD_1.headSha);
});

function fatalCandidate(
  overrides: Partial<FatalFindingCandidate> = {},
): FatalFindingCandidate {
  return {
    kind: "fatal",
    category: "correctness",
    outcome: "permanent_data_loss_or_corruption",
    file: "src/save.ts",
    symbol: "saveDraft",
    trigger: "기존 초안을 저장한다",
    evidence: [codeEvidence(12)],
    ...overrides,
  };
}

function missingTestsCandidate(acceptanceCriterion: string) {
  return {
    kind: "missing_tests" as const,
    category: "acceptance-test",
    acceptanceCriterion,
    file: "src/save.ts",
    symbol: "saveDraft",
    trigger: "저장 버튼을 누른다",
    evidence: [
      {
        kind: "acceptance_criterion" as const,
        file: null,
        line: null,
        symbol: null,
        quote: acceptanceCriterion,
      },
      {
        kind: "test_inventory" as const,
        file: null,
        line: null,
        symbol: null,
        quote: "inventory:complete:no-matching-test",
      },
    ],
  };
}

function codeEvidence(line: number): ReviewFindingEvidence {
  return {
    kind: "code",
    file: "src/save.ts",
    line,
    symbol: "saveDraft",
    quote: "await storage.remove(id)",
  };
}
