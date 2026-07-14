import { createHash } from "node:crypto";

export const REVIEW_FINDING_STATES = ["open", "resolved", "refuted"] as const;
export type ReviewFindingState = (typeof REVIEW_FINDING_STATES)[number];

export type ReviewFindingEvidence = {
  kind: "acceptance_criterion" | "code" | "test" | "test_inventory" | "diff";
  file: string | null;
  line: number | null;
  symbol: string | null;
  quote: string;
};

type ReviewFindingCandidateBase = {
  /** Stable host-owned category, not free-form model prose. */
  category: string;
  file: string | null;
  /** Stable qualified symbol when one is available. */
  symbol: string | null;
  /** Stable reproduction condition, preferably supplied by the host. */
  trigger: string;
  evidence: readonly ReviewFindingEvidence[];
};

export type MissingTestsFindingCandidate = ReviewFindingCandidateBase & {
  kind: "missing_tests";
  acceptanceCriterion: string;
};

export type FatalFindingCandidate = ReviewFindingCandidateBase & {
  kind: "fatal";
  outcome: string;
};

export type ReviewFindingCandidate = MissingTestsFindingCandidate | FatalFindingCandidate;

export type ReviewFindingSnapshotIdentity = {
  headSha: string;
  contextHash: string;
};

export type ReviewFindingRefutation = {
  headSha: string;
  contextHash: string;
  maintainerEvidence: string;
};

export type StoredReviewFinding = {
  semanticFingerprint: string;
  evidenceHash: string;
  state: ReviewFindingState;
  candidate: ReviewFindingCandidate;
  firstSeenHeadSha: string;
  lastSeenHeadSha: string;
  lastEvaluatedHeadSha: string;
  contextHash: string;
  refutation: ReviewFindingRefutation | null;
};

export type ReviewFindingRegressionEvidence = {
  file: string;
  symbol: string | null;
  /** A host-grounded diff quote or digest for changes made after refutation. */
  diffEvidence: string;
};

export type ReviewFindingEvidenceInventory = {
  /** False means that absence cannot be used as proof that a finding was fixed. */
  complete: boolean;
  evidenceHashes: readonly string[];
  /**
   * Findings whose exact evidence is independently proven absent on this HEAD.
   * This lets one grounded fix resolve even when another finding's context is
   * incomplete and the global inventory therefore remains partial.
   */
  provenAbsentFingerprints?: readonly string[];
};

export type ReviewFindingLedgerInput = {
  identity: ReviewFindingSnapshotIdentity;
  candidates: readonly ReviewFindingCandidate[];
  evidenceInventory: ReviewFindingEvidenceInventory;
  regressionEvidence: readonly ReviewFindingRegressionEvidence[];
};

export type ReviewFindingTransitionKind =
  | "created"
  | "updated"
  | "reopened"
  | "resolved"
  | "unchanged"
  | "suppressed";

export type ReviewFindingTransition = {
  kind: ReviewFindingTransitionKind;
  semanticFingerprint: string;
  finding: StoredReviewFinding;
};

export type ReviewFindingLedgerResult = {
  findings: StoredReviewFinding[];
  transitions: ReviewFindingTransition[];
  /** New or materially updated findings that warrant creating/updating a GitHub thread. */
  publishable: StoredReviewFinding[];
};

/**
 * A semantic identity deliberately excludes line numbers and evidence quotes.
 * Consequently, a finding that moves within the same target is updated rather
 * than posted as a duplicate.
 */
export function fingerprintReviewFinding(candidate: ReviewFindingCandidate): string {
  validateCandidate(candidate);
  const subject = candidate.kind === "missing_tests"
    ? { acceptanceCriterionHash: hashAcceptanceCriterion(candidate.acceptanceCriterion) }
    : { outcome: normalizeToken(candidate.outcome) };
  return versionedHash("review-finding:v1", {
    category: normalizeToken(candidate.category),
    kind: candidate.kind,
    ...subject,
    file: normalizeFile(candidate.file),
    symbol: normalizeSemanticText(candidate.symbol),
    trigger: normalizeSemanticText(candidate.trigger)?.toLowerCase() || null,
  });
}

export function hashAcceptanceCriterion(acceptanceCriterion: string): string {
  const normalized = normalizeSemanticText(acceptanceCriterion);
  if (!normalized) {
    throw new Error("acceptanceCriterion must not be empty");
  }
  return sha256(normalized.toLowerCase());
}

/**
 * Evidence order and line-number movement are ignored, while the evidence kind,
 * file, symbol, and normalized quote must still match. This keeps an unchanged
 * defect grounded when surrounding edits merely move its line number.
 */
export function hashReviewFindingEvidence(
  evidence: readonly ReviewFindingEvidence[],
): string {
  if (evidence.length === 0) {
    throw new Error("evidence must contain at least one item");
  }
  const canonical = evidence.map((item) => {
    const quote = normalizeEvidenceQuote(item.quote);
    if (!quote) {
      throw new Error("evidence quote must not be empty");
    }
    return {
      kind: item.kind,
      file: normalizeFile(item.file),
      symbol: normalizeSemanticText(item.symbol),
      quote,
    };
  });
  const unique = [...new Map(
    canonical.map((item) => [stableStringify(item), item]),
  ).values()].sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  return versionedHash("review-evidence:v1", unique);
}

export function shouldReuseReviewFindingSnapshot(
  previous: ReviewFindingSnapshotIdentity | null | undefined,
  current: ReviewFindingSnapshotIdentity,
): boolean {
  if (!previous) {
    return false;
  }
  const previousHead = previous.headSha.trim();
  const previousContext = previous.contextHash.trim();
  return previousHead.length > 0 &&
    previousContext.length > 0 &&
    previousHead === current.headSha.trim() &&
    previousContext === current.contextHash.trim();
}

export function createStoredReviewFinding(
  candidate: ReviewFindingCandidate,
  identity: ReviewFindingSnapshotIdentity,
): StoredReviewFinding {
  validateIdentity(identity);
  return {
    semanticFingerprint: fingerprintReviewFinding(candidate),
    evidenceHash: hashReviewFindingEvidence(candidate.evidence),
    state: "open",
    candidate: cloneCandidate(candidate),
    firstSeenHeadSha: identity.headSha.trim(),
    lastSeenHeadSha: identity.headSha.trim(),
    lastEvaluatedHeadSha: identity.headSha.trim(),
    contextHash: identity.contextHash.trim(),
    refutation: null,
  };
}

/** Runtime-decodes persisted rows so corrupt or old-schema JSON stays isolated. */
export function parseStoredReviewFinding(value: unknown): StoredReviewFinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored review finding must be an object");
  }
  const finding = value as Partial<StoredReviewFinding>;
  if (
    typeof finding.semanticFingerprint !== "string" ||
    typeof finding.evidenceHash !== "string" ||
    !REVIEW_FINDING_STATES.includes(finding.state as ReviewFindingState) ||
    !finding.candidate ||
    typeof finding.firstSeenHeadSha !== "string" ||
    typeof finding.lastSeenHeadSha !== "string" ||
    typeof finding.lastEvaluatedHeadSha !== "string" ||
    typeof finding.contextHash !== "string" ||
    (finding.refutation !== null && finding.refutation !== undefined &&
      (typeof finding.refutation !== "object" ||
        typeof finding.refutation.headSha !== "string" ||
        typeof finding.refutation.contextHash !== "string" ||
        typeof finding.refutation.maintainerEvidence !== "string"))
  ) {
    throw new Error("stored review finding has an invalid shape");
  }
  validateIdentity({ headSha: finding.firstSeenHeadSha, contextHash: finding.contextHash });
  if (!finding.lastSeenHeadSha.trim() || !finding.lastEvaluatedHeadSha.trim()) {
    throw new Error("stored review finding has an empty HEAD identity");
  }
  const candidate = cloneCandidate(finding.candidate);
  const semanticFingerprint = fingerprintReviewFinding(candidate);
  const evidenceHash = hashReviewFindingEvidence(candidate.evidence);
  if (semanticFingerprint !== finding.semanticFingerprint || evidenceHash !== finding.evidenceHash) {
    throw new Error("stored review finding hashes do not match its candidate");
  }
  return {
    semanticFingerprint,
    evidenceHash,
    state: finding.state as ReviewFindingState,
    candidate,
    firstSeenHeadSha: finding.firstSeenHeadSha.trim(),
    lastSeenHeadSha: finding.lastSeenHeadSha.trim(),
    lastEvaluatedHeadSha: finding.lastEvaluatedHeadSha.trim(),
    contextHash: finding.contextHash.trim(),
    refutation: finding.refutation
      ? {
          headSha: finding.refutation.headSha.trim(),
          contextHash: finding.refutation.contextHash.trim(),
          maintainerEvidence: finding.refutation.maintainerEvidence.trim(),
        }
      : null,
  };
}

export function refuteReviewFinding(
  finding: StoredReviewFinding,
  identity: ReviewFindingSnapshotIdentity,
  maintainerEvidence: string,
): StoredReviewFinding {
  validateIdentity(identity);
  const normalizedEvidence = normalizeSemanticText(maintainerEvidence);
  if (!normalizedEvidence) {
    throw new Error("maintainerEvidence must not be empty");
  }
  return {
    ...finding,
    state: "refuted",
    lastEvaluatedHeadSha: identity.headSha.trim(),
    contextHash: identity.contextHash.trim(),
    refutation: {
      headSha: identity.headSha.trim(),
      contextHash: identity.contextHash.trim(),
      maintainerEvidence: normalizedEvidence,
    },
  };
}

/**
 * Reconciles model candidates with host-grounded evidence. Model omission alone
 * never resolves an open finding: resolution additionally requires either a
 * new HEAD plus a complete inventory, or per-finding host proof that the exact
 * evidence is absent (for example a grounded test for the previously missing AC).
 */
export function reconcileReviewFindingLedger(
  stored: readonly StoredReviewFinding[],
  input: ReviewFindingLedgerInput,
): ReviewFindingLedgerResult {
  validateIdentity(input.identity);
  const identity = normalizedIdentity(input.identity);
  const currentCandidates = collapseCandidates(input.candidates);
  const currentByFingerprint = new Map(
    currentCandidates.map((candidate) => [fingerprintReviewFinding(candidate), candidate]),
  );
  const storedByFingerprint = collapseStoredFindings(stored);
  const evidenceHashes = new Set(input.evidenceInventory.evidenceHashes.map((value) => value.trim()));
  const provenAbsentFingerprints = new Set(
    (input.evidenceInventory.provenAbsentFingerprints || []).map((value) => value.trim()),
  );
  const transitions: ReviewFindingTransition[] = [];

  for (const [semanticFingerprint, candidate] of currentByFingerprint) {
    const previous = storedByFingerprint.get(semanticFingerprint);
    if (!previous) {
      const finding = createStoredReviewFinding(candidate, identity);
      storedByFingerprint.set(semanticFingerprint, finding);
      transitions.push({ kind: "created", semanticFingerprint, finding });
      continue;
    }

    if (previous.state === "refuted" && !hasRegressionEvidence(previous, candidate, identity, input.regressionEvidence)) {
      const finding = evaluatedAt(previous, identity);
      storedByFingerprint.set(semanticFingerprint, finding);
      transitions.push({ kind: "suppressed", semanticFingerprint, finding });
      continue;
    }

    const evidenceHash = hashReviewFindingEvidence(candidate.evidence);
    const candidateChanged = stableStringify(previous.candidate) !== stableStringify(candidate);
    const evidenceChanged = previous.evidenceHash !== evidenceHash;
    const finding: StoredReviewFinding = {
      ...previous,
      evidenceHash,
      state: "open",
      candidate: cloneCandidate(candidate),
      lastSeenHeadSha: identity.headSha,
      lastEvaluatedHeadSha: identity.headSha,
      contextHash: identity.contextHash,
      refutation: null,
    };
    const kind: ReviewFindingTransitionKind = previous.state === "resolved" || previous.state === "refuted"
      ? "reopened"
      : candidateChanged || evidenceChanged
        ? "updated"
        : "unchanged";
    storedByFingerprint.set(semanticFingerprint, finding);
    transitions.push({ kind, semanticFingerprint, finding });
  }

  for (const [semanticFingerprint, previous] of storedByFingerprint) {
    if (currentByFingerprint.has(semanticFingerprint)) {
      continue;
    }
    // Compare with the last HEAD where the finding itself was observed. A first
    // pass on the new HEAD may have an incomplete inventory; a later complete
    // pass on that same HEAD must still be able to prove the fix.
    const newHead = previous.lastSeenHeadSha !== identity.headSha;
    const independentlyProvenAbsent = provenAbsentFingerprints.has(semanticFingerprint);
    const exactEvidenceGone = independentlyProvenAbsent ||
      (input.evidenceInventory.complete && !evidenceHashes.has(previous.evidenceHash));
    if (
      previous.state === "open" &&
      exactEvidenceGone &&
      (newHead || independentlyProvenAbsent)
    ) {
      const finding: StoredReviewFinding = {
        ...previous,
        state: "resolved",
        lastEvaluatedHeadSha: identity.headSha,
        contextHash: identity.contextHash,
      };
      storedByFingerprint.set(semanticFingerprint, finding);
      transitions.push({ kind: "resolved", semanticFingerprint, finding });
      continue;
    }
    const finding = evaluatedAt(previous, identity);
    storedByFingerprint.set(semanticFingerprint, finding);
    transitions.push({ kind: "unchanged", semanticFingerprint, finding });
  }

  transitions.sort((left, right) => left.semanticFingerprint.localeCompare(right.semanticFingerprint));
  const findings = [...storedByFingerprint.values()].sort((left, right) =>
    left.semanticFingerprint.localeCompare(right.semanticFingerprint)
  );
  return {
    findings,
    transitions,
    publishable: transitions
      .filter((transition) => ["created", "updated", "reopened"].includes(transition.kind))
      .map((transition) => transition.finding),
  };
}

function collapseCandidates(
  candidates: readonly ReviewFindingCandidate[],
): ReviewFindingCandidate[] {
  const collapsed = new Map<string, ReviewFindingCandidate>();
  for (const candidate of candidates) {
    validateCandidate(candidate);
    const fingerprint = fingerprintReviewFinding(candidate);
    const previous = collapsed.get(fingerprint);
    if (!previous) {
      collapsed.set(fingerprint, cloneCandidate(candidate));
      continue;
    }
    const evidence = [...previous.evidence, ...candidate.evidence];
    const uniqueEvidence = [...new Map(
      evidence.map((item) => [stableStringify(normalizeEvidenceForDeduplication(item)), item]),
    ).values()].sort((left, right) =>
      stableStringify(normalizeEvidenceForDeduplication(left)).localeCompare(
        stableStringify(normalizeEvidenceForDeduplication(right)),
      )
    );
    collapsed.set(fingerprint, { ...previous, evidence: uniqueEvidence });
  }
  return [...collapsed.values()];
}

function collapseStoredFindings(
  stored: readonly StoredReviewFinding[],
): Map<string, StoredReviewFinding> {
  const collapsed = new Map<string, StoredReviewFinding>();
  for (const finding of stored) {
    const fingerprint = fingerprintReviewFinding(finding.candidate);
    if (fingerprint !== finding.semanticFingerprint) {
      throw new Error("stored semanticFingerprint does not match candidate");
    }
    const previous = collapsed.get(fingerprint);
    if (!previous || moreRecentFinding(finding, previous)) {
      collapsed.set(fingerprint, cloneStoredFinding(finding));
    }
  }
  return collapsed;
}

function moreRecentFinding(left: StoredReviewFinding, right: StoredReviewFinding): boolean {
  if (left.state !== right.state) {
    // Never let an accidental duplicate open row override a maintainer's
    // refutation tombstone merely because commit SHA strings sort differently.
    return statePriority(left.state) > statePriority(right.state);
  }
  return true;
}

function statePriority(state: ReviewFindingState): number {
  return state === "refuted" ? 3 : state === "open" ? 2 : 1;
}

function hasRegressionEvidence(
  previous: StoredReviewFinding,
  candidate: ReviewFindingCandidate,
  identity: ReviewFindingSnapshotIdentity,
  regressionEvidence: readonly ReviewFindingRegressionEvidence[],
): boolean {
  if (!previous.refutation || previous.refutation.headSha === identity.headSha) {
    return false;
  }
  const targetFile = normalizeFile(candidate.file);
  const targetSymbol = normalizeSemanticText(candidate.symbol);
  if (!targetFile) {
    return false;
  }
  return regressionEvidence.some((evidence) => {
    if (!normalizeSemanticText(evidence.diffEvidence)) {
      return false;
    }
    if (normalizeFile(evidence.file) !== targetFile) {
      return false;
    }
    const evidenceSymbol = normalizeSemanticText(evidence.symbol);
    return targetSymbol ? evidenceSymbol === targetSymbol : evidenceSymbol === null;
  });
}

function evaluatedAt(
  finding: StoredReviewFinding,
  identity: ReviewFindingSnapshotIdentity,
): StoredReviewFinding {
  return {
    ...finding,
    lastEvaluatedHeadSha: identity.headSha,
    contextHash: identity.contextHash,
  };
}

function normalizeEvidenceForDeduplication(evidence: ReviewFindingEvidence): object {
  return {
    kind: evidence.kind,
    file: normalizeFile(evidence.file),
    symbol: normalizeSemanticText(evidence.symbol),
    quote: normalizeEvidenceQuote(evidence.quote),
  };
}

function normalizeEvidenceQuote(value: string): string {
  return value.normalize("NFKC").replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}

function normalizeSemanticText(value: string | null | undefined): string | null {
  const normalized = String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized || null;
}

function normalizeToken(value: string): string {
  const normalized = normalizeSemanticText(value)?.toLowerCase();
  if (!normalized) {
    throw new Error("finding identity token must not be empty");
  }
  return normalized;
}

function normalizeFile(value: string | null | undefined): string | null {
  const normalized = normalizeSemanticText(value)?.replace(/\\/gu, "/").replace(/^\.\//u, "");
  return normalized || null;
}

function validateCandidate(candidate: ReviewFindingCandidate): void {
  normalizeToken(candidate.category);
  const trigger = normalizeSemanticText(candidate.trigger);
  if (!trigger) {
    throw new Error("trigger must not be empty");
  }
  if (candidate.kind === "missing_tests") {
    hashAcceptanceCriterion(candidate.acceptanceCriterion);
  } else {
    normalizeToken(candidate.outcome);
  }
  hashReviewFindingEvidence(candidate.evidence);
}

function validateIdentity(identity: ReviewFindingSnapshotIdentity): void {
  if (!identity.headSha.trim()) {
    throw new Error("headSha must not be empty");
  }
  if (!identity.contextHash.trim()) {
    throw new Error("contextHash must not be empty");
  }
}

function normalizedIdentity(identity: ReviewFindingSnapshotIdentity): ReviewFindingSnapshotIdentity {
  return { headSha: identity.headSha.trim(), contextHash: identity.contextHash.trim() };
}

function cloneCandidate(candidate: ReviewFindingCandidate): ReviewFindingCandidate {
  return { ...candidate, evidence: candidate.evidence.map((item) => ({ ...item })) };
}

function cloneStoredFinding(finding: StoredReviewFinding): StoredReviewFinding {
  return {
    ...finding,
    candidate: cloneCandidate(finding.candidate),
    refutation: finding.refutation ? { ...finding.refutation } : null,
  };
}

function versionedHash(version: string, value: unknown): string {
  return sha256(`${version}\n${stableStringify(value)}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
