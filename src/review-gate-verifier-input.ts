/**
 * Verifier-pass input for the Seori review gate.
 *
 * The verifier used to receive the entire candidate-pass prompt (whole PR
 * diff and file bodies) again, so on large PRs the second MiniMax call grew
 * past the request timeout and the gate abstained. Each verifier request now
 * carries only what the host trust boundary later re-checks: the candidate
 * itself, a numbered current-HEAD excerpt of the files it points at, the
 * host facts, and (for missing-test candidates) the host evidence inventory.
 *
 * Candidates are verified in isolated requests so one failing call degrades
 * that candidate to a host-recorded `uncertain` instead of abstaining the
 * whole gate.
 */
import type { MiniMaxCandidateVerification, MiniMaxReviewCandidate } from "./minimax-review.js";
import { SYMBOL_MAX_DISTANCE, normalizeRepositoryPath } from "./review-gate-pipeline.js";
import {
  REVIEW_GATE_PROMPT_VERSION,
  formatReviewGateAcceptanceCriteria,
  formatReviewGateHostFacts,
  type ReviewGateHostFacts,
} from "./review-gate-prompt.js";
import { truncate } from "./text.js";

/** Lines shown on each side of a referenced line. Matches the pipeline's causal-chain span. */
export const VERIFIER_EXCERPT_RADIUS_LINES = SYMBOL_MAX_DISTANCE;
/** candidate.file plus up to six evidence files. */
export const VERIFIER_MAX_REFERENCED_PATHS = 7;
export const VERIFIER_PATCH_CHARS_PER_PATH = 8_000;
export const VERIFIER_EXCERPT_MAX_CHARS = 80_000;

export const VERIFICATION_CALL_FAILED_PREFIX = "verification_call_failed:";
export const VERIFICATION_CALL_FAILED_REASON_KO =
  "호스트 기록: 독립 검증 호출이 실패해 이 후보를 판정하지 못했습니다.";

export type ReviewGateVerifierPromptInput = ReviewGateHostFacts & {
  candidate: MiniMaxReviewCandidate;
  explicitAcceptanceCriteria: readonly string[];
  /** Output of formatReviewEvidenceCandidates; included only for missing-test candidates. */
  evidenceCandidatesText: string;
  currentHeadFileContents: Readonly<Record<string, string>>;
  visibleChangedPatches: Readonly<Record<string, string>>;
};

export function buildReviewGateVerifierUserPrompt(input: ReviewGateVerifierPromptInput): string {
  const { candidate } = input;
  const sections: string[] = [
    `Gate version: ${REVIEW_GATE_PROMPT_VERSION}`,
    ...formatReviewGateHostFacts(input),
    "",
    ...formatReviewGateAcceptanceCriteria(input.explicitAcceptanceCriteria),
    "",
  ];
  if (candidate.kind === "missing_acceptance_test") {
    sections.push(
      "## Host Evidence Candidates",
      "현재 HEAD의 전체 테스트·소스 근거 인벤토리입니다. AC 원문을 직접 검증하는 항목이 있으면 후보는 반증됩니다.",
      input.evidenceCandidatesText,
      "",
    );
  }
  sections.push(
    "## 후보가 지목한 현재 HEAD 코드",
    "각 줄은 `L줄번호: 원문` 형식이며 줄번호는 현재 HEAD 파일의 실제 줄번호입니다. 블록 사이의 `  ...`는 생략된 구간입니다.",
    truncate(
      renderReferencedFiles(candidate, input.currentHeadFileContents, input.visibleChangedPatches),
      VERIFIER_EXCERPT_MAX_CHARS,
    ),
    "",
    "## 반증할 후보",
    JSON.stringify({ candidates: [candidate] }, null, 2),
    "",
    "## 수행할 작업",
    `후보 ${candidate.candidateId}을(를) 위 현재 HEAD 발췌에서 먼저 반증하고, candidate_id "${candidate.candidateId}"로 confirmed/rejected/uncertain 중 하나를 submit_review 도구로 정확히 한 번 제출하세요. evidence의 file은 발췌 경로, line은 L줄번호, code_quote는 접두어를 제외한 원문 줄을 그대로 복사하세요.`,
  );
  return sections.join("\n");
}

type ReferencedPath = { path: string; lines: number[] };

/** Distinct normalized paths the candidate cites, candidate.file first, with the lines cited in each. */
export function referencedCandidatePaths(candidate: MiniMaxReviewCandidate): ReferencedPath[] {
  const byPath = new Map<string, Set<number>>();
  const add = (file: string | null, line: number | null): void => {
    const path = file ? normalizeRepositoryPath(file) : null;
    if (!path) {
      return;
    }
    const lines = byPath.get(path) ?? new Set<number>();
    if (line !== null && Number.isSafeInteger(line) && line >= 1) {
      lines.add(line);
    }
    byPath.set(path, lines);
  };
  add(candidate.file, candidate.line);
  for (const evidence of candidate.evidence) {
    add(evidence.file, evidence.line);
  }
  return [...byPath.entries()]
    .slice(0, VERIFIER_MAX_REFERENCED_PATHS)
    .map(([path, lines]) => ({ path, lines: [...lines].sort((left, right) => left - right) }));
}

function renderReferencedFiles(
  candidate: MiniMaxReviewCandidate,
  currentHeadFileContents: Readonly<Record<string, string>>,
  visibleChangedPatches: Readonly<Record<string, string>>,
): string {
  const paths = referencedCandidatePaths(candidate);
  if (paths.length === 0) {
    return "(후보가 파일을 지목하지 않음)";
  }
  const contents = normalizedPathMap(currentHeadFileContents);
  const patches = normalizedPathMap(visibleChangedPatches);
  return paths
    .map(({ path, lines }) => {
      const rows = [`### ${path}`];
      const content = contents.get(path);
      rows.push(
        content === undefined
          ? "(현재 HEAD 본문을 host가 확보하지 못함)"
          : renderNumberedExcerpt(content, lines),
      );
      const patch = patches.get(path);
      if (patch) {
        rows.push("#### 변경 패치", "```diff", truncate(patch, VERIFIER_PATCH_CHARS_PER_PATH), "```");
      }
      return rows.join("\n");
    })
    .join("\n\n");
}

function normalizedPathMap(values: Readonly<Record<string, string>>): Map<string, string> {
  const result = new Map<string, string>();
  for (const [file, value] of Object.entries(values)) {
    const path = normalizeRepositoryPath(file);
    if (path && !result.has(path)) {
      result.set(path, value);
    }
  }
  return result;
}

/**
 * Numbered `L{n}: source` excerpt around the focus lines. Line numbers are the
 * same 1-based `/\r?\n/` split the host uses for exact-line grounding, so a
 * quote copied from the excerpt (minus the prefix) grounds on current HEAD.
 */
export function renderNumberedExcerpt(
  content: string,
  focusLines: readonly number[],
  radius: number = VERIFIER_EXCERPT_RADIUS_LINES,
): string {
  const lines = content.split(/\r?\n/u);
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const ranges = mergedLineWindows(focusLines.length > 0 ? focusLines : [1], radius, lines.length);
  if (ranges.length === 0) {
    return "(지목한 줄이 현재 HEAD 파일 범위를 벗어남)";
  }
  return ranges
    .map(([start, end]) => {
      const rows: string[] = [];
      for (let line = start; line <= end; line += 1) {
        rows.push(`L${line}: ${lines[line - 1] ?? ""}`);
      }
      return rows.join("\n");
    })
    .join("\n  ...\n");
}

/** Sorted, merged inclusive [start, end] windows of ±radius around each valid focus line. */
export function mergedLineWindows(
  focusLines: readonly number[],
  radius: number,
  lineCount: number,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const sorted = [...new Set(focusLines)]
    .filter((line) => Number.isSafeInteger(line) && line >= 1 && line <= lineCount)
    .sort((left, right) => left - right);
  for (const line of sorted) {
    const start = Math.max(1, line - radius);
    const end = Math.min(lineCount, line + radius);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([start, end]);
    }
  }
  return ranges;
}

export type IsolatedVerificationFailure = { candidateId: string; message: string };

export type IsolatedVerificationResult = {
  /** One entry per candidate, in candidate order. Failed calls hold a host-synthesized uncertain verdict. */
  verifications: MiniMaxCandidateVerification[];
  failures: IsolatedVerificationFailure[];
};

/**
 * Verifies every candidate in its own request. A rejected or mismatched call
 * becomes an `uncertain` verdict for that candidate only, so the remaining
 * candidates still reach the host pipeline with their real verdicts.
 */
export async function verifyReviewGateCandidatesIsolated(
  candidates: readonly MiniMaxReviewCandidate[],
  verifyOne: (candidate: MiniMaxReviewCandidate) => Promise<MiniMaxCandidateVerification>,
): Promise<IsolatedVerificationResult> {
  const settled = await Promise.allSettled(candidates.map((candidate) => verifyOne(candidate)));
  const verifications: MiniMaxCandidateVerification[] = [];
  const failures: IsolatedVerificationFailure[] = [];
  settled.forEach((outcome, index) => {
    const candidate = candidates[index]!;
    if (outcome.status === "fulfilled" && outcome.value.candidateId === candidate.candidateId) {
      verifications.push(outcome.value);
      return;
    }
    failures.push({
      candidateId: candidate.candidateId,
      message: outcome.status === "rejected"
        ? errorMessage(outcome.reason)
        : `verifier returned candidate_id ${JSON.stringify(outcome.value.candidateId)}`,
    });
    verifications.push({
      candidateId: candidate.candidateId,
      verdict: "uncertain",
      reasonKo: VERIFICATION_CALL_FAILED_REASON_KO,
      evidence: [],
    });
  });
  return { verifications, failures };
}

/** validation_errors_json entry for a failed verifier call. */
export function formatVerificationCallFailure(failure: IsolatedVerificationFailure): string {
  return `${VERIFICATION_CALL_FAILED_PREFIX}${failure.candidateId}: ${failure.message}`;
}

/** True when a recorded run contains a host-synthesized uncertain verdict and must not be reused as a cache hit. */
export function hasVerificationCallFailure(validationErrors: readonly string[] | null | undefined): boolean {
  return Boolean(validationErrors?.some((entry) => entry.startsWith(VERIFICATION_CALL_FAILED_PREFIX)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
