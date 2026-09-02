/**
 * Local review-gate probe against the real MiniMax API.
 *
 * Replays the production candidate → isolated verifier → host pipeline gate on
 * synthetic PR fixtures with the same prompt builders, request/repair contract,
 * and trust boundary the bot uses, so prompt and budget changes can be measured
 * without a deploy-and-webhook cycle.
 *
 * Usage:
 *   MINIMAX_API_KEY=... node --import tsx scripts/gate-probe.mts <defect|clean|large-defect> [runs] [--thinking-budget N|--thinking-off]
 *
 * The optional thinking flag applies to the coverage and defect passes only and
 * exists to measure MiniMax-M3 latency against production's adaptive default.
 *
 * Exit code 1 when no planted root is accepted by the host pipeline, a clean
 * fixture yields an accepted finding, a phase or isolated verifier call fails,
 * or any verifier request takes VERIFIER_TIMEOUT_BUDGET_MS or longer. Per-root
 * candidate recall and verifier verdicts (including a model rejection of a
 * planted root) are reported for diagnosis but do not fail the run: the probe
 * measures the gate mechanism, not the model's per-candidate judgement.
 */
import { buildLargeFileDigest } from "../src/github.js";
import { executeMiniMaxGateRequest, type MiniMaxGateRequestUsage } from "../src/minimax-gate.js";
import {
  buildMiniMaxCoverageRequest,
  buildMiniMaxDefectRequest,
  buildMiniMaxVerificationRequest,
  parseMiniMaxCoverageResponse,
  parseMiniMaxDefectResponse,
  parseMiniMaxVerificationResponse,
  type MiniMaxThinking,
} from "../src/minimax-review.js";
import { extractReviewGateCandidatesIsolated } from "../src/review-gate-extraction.js";
import { evaluateMiniMaxReviewGateCandidates } from "../src/review-gate-pipeline.js";
import {
  buildReviewGateCoverageSystemPrompt,
  buildReviewGateCoverageUserPrompt,
  buildReviewGateDefectSystemPrompt,
  buildReviewGateDefectUserPrompt,
  buildReviewGateVerifierSystemPrompt,
  type ReviewGateHostFacts,
} from "../src/review-gate-prompt.js";
import {
  buildReviewGateVerifierUserPrompt,
  verifyReviewGateCandidatesIsolated,
} from "../src/review-gate-verifier-input.js";
import {
  buildReviewEvidenceCandidates,
  formatReviewEvidenceCandidates,
} from "../src/review-grounding.js";
import { truncate } from "../src/text.js";

// Production budgets mirrored from src/github.ts and src/config.ts defaults.
const MAX_CHANGED_FILE_CONTENT_CHARS = 20_000;
const MAX_REVIEW_GATE_PATCH_CHARS = 60_000;
const MAX_CONTEXT_CHARS = 160_000;
const REVIEW_GATE_PROMPT_RESERVE_CHARS = 16_000;
const REQUEST_TIMEOUT_MS = 300_000;
const VERIFIER_TIMEOUT_BUDGET_MS = 300_000;

type FixtureFile = {
  status: "added" | "modified";
  /** Current-HEAD body. */
  content: string;
  /** Unified diff hunks for this file (no file header). */
  patch: string;
  additions: number;
  deletions: number;
};

type Fixture = {
  title: string;
  acceptanceCriteria: readonly string[];
  files: Record<string, FixtureFile>;
  /** Roots the gate must confirm and the host must accept. Empty for clean fixtures. */
  plantedRoots: Array<{ file: string; line: number }>;
};

const ACCEPTANCE_CRITERIA = [
  "정상 진행 tier 1..3 입력에서 보상량이 반환된다.",
  "빈 점수 목록에서도 평균 계산이 안전하다.",
] as const;

const INDEX_DEFECT_BLOCK = [
  "## 일일 보상 티어 테이블. 정상 진행에서 tier는 1..3을 전달받는다.",
  "const REWARD_TIERS: Array[int] = [10, 20, 30]",
  "",
  "",
  "## 전달된 tier의 보상량을 돌려준다.",
  "static func reward_for_tier(tier: int) -> int:",
  "\treturn REWARD_TIERS[tier]",
];

const DIVISION_DEFECT_BLOCK = [
  "## 최근 판 점수의 평균을 돌려준다.",
  "static func average_score(scores: Array) -> float:",
  "\tvar total := 0.0",
  "\tfor score in scores:",
  "\t\ttotal += score",
  "\treturn total / scores.size()",
];

const SMALL_DEFECT_FILE = ["extends RefCounted", "", ...INDEX_DEFECT_BLOCK, "", "", ...DIVISION_DEFECT_BLOCK].join("\n") + "\n";

const SMALL_CLEAN_FILE = `extends RefCounted

## 일일 보상 티어 테이블. 정상 진행에서 tier는 1..3을 전달받는다.
const REWARD_TIERS: Array[int] = [10, 20, 30]


## 전달된 tier의 보상량을 돌려준다. 범위 밖 tier는 최솟값으로 보정한다.
static func reward_for_tier(tier: int) -> int:
\tvar index := clampi(tier - 1, 0, REWARD_TIERS.size() - 1)
\treturn REWARD_TIERS[index]


## 최근 판 점수의 평균을 돌려준다. 기록이 없으면 0을 돌려준다.
static func average_score(scores: Array) -> float:
\tif scores.is_empty():
\t\treturn 0.0
\tvar total := 0.0
\tfor score in scores:
\t\ttotal += score
\treturn total / scores.size()
`;

function addedFile(content: string): FixtureFile {
  const lines = content.replace(/\n$/u, "").split("\n");
  return {
    status: "added",
    content,
    patch: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n"),
    additions: lines.length,
    deletions: 0,
  };
}

/** Deterministic, guard-complete GDScript module used to fill the context budget. */
function generatedModule(index: number, targetChars: number): string {
  const lines = ["extends RefCounted", "", `## 생성된 밸런스 모듈 ${index}. 테이블 조회는 모두 범위를 보정한다.`];
  let table = 0;
  while (lines.join("\n").length < targetChars) {
    table += 1;
    const size = 4 + ((index * 7 + table) % 5);
    const values = Array.from({ length: size }, (_, position) => (index + 1) * 100 + table * 10 + position);
    lines.push(
      "",
      `const TABLE_${index}_${table}: Array[int] = [${values.join(", ")}]`,
      "",
      `## 모듈 ${index} 테이블 ${table}의 index번째 값을 돌려준다. index는 0..${size - 1} 범위를 보정한다.`,
      `static func table_${index}_${table}_value(index: int) -> int:`,
      `\tvar safe_index := clampi(index, 0, TABLE_${index}_${table}.size() - 1)`,
      `\treturn TABLE_${index}_${table}[safe_index]`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Inserts blocks after the given 1-based base lines and returns the new body
 * plus a unified diff with three context lines around each insertion.
 */
function modifiedFile(
  baseContent: string,
  insertions: Array<{ afterLine: number; lines: string[] }>,
): { file: FixtureFile; newLineOf: (insertionIndex: number, offsetInBlock: number) => number } {
  const base = baseContent.replace(/\n$/u, "").split("\n");
  const sorted = [...insertions].sort((left, right) => left.afterLine - right.afterLine);
  const out: string[] = [];
  const hunks: string[] = [];
  const blockStarts: number[] = [];
  let cursor = 0;
  let added = 0;
  for (const insertion of sorted) {
    out.push(...base.slice(cursor, insertion.afterLine));
    cursor = insertion.afterLine;
    const contextBefore = base.slice(insertion.afterLine - 3, insertion.afterLine);
    const contextAfter = base.slice(insertion.afterLine, insertion.afterLine + 3);
    const oldStart = insertion.afterLine - 2;
    const newStart = oldStart + added;
    hunks.push(
      `@@ -${oldStart},${contextBefore.length + contextAfter.length} +${newStart},${contextBefore.length + contextAfter.length + insertion.lines.length} @@`,
      ...contextBefore.map((line) => ` ${line}`),
      ...insertion.lines.map((line) => `+${line}`),
      ...contextAfter.map((line) => ` ${line}`),
    );
    blockStarts.push(out.length + 1);
    out.push(...insertion.lines);
    added += insertion.lines.length;
  }
  out.push(...base.slice(cursor));
  return {
    file: {
      status: "modified",
      content: `${out.join("\n")}\n`,
      patch: hunks.join("\n"),
      additions: added,
      deletions: 0,
    },
    newLineOf: (insertionIndex, offsetInBlock) => blockStarts[insertionIndex]! + offsetInBlock,
  };
}

function buildFixture(name: string): Fixture {
  const smallPath = "godot/scripts/reward_tiers.gd";
  if (name === "clean") {
    return {
      title: "chore: 잔소리 봇 프로브 (clean)",
      acceptanceCriteria: ACCEPTANCE_CRITERIA,
      files: { [smallPath]: addedFile(SMALL_CLEAN_FILE) },
      plantedRoots: [],
    };
  }
  if (name === "large-defect") {
    const largePath = "godot/scripts/economy_tables.gd";
    const base = generatedModule(0, 24_000);
    const baseLineCount = base.replace(/\n$/u, "").split("\n").length;
    const firstAfter = Math.floor(baseLineCount / 3);
    const secondAfter = Math.floor((baseLineCount * 2) / 3);
    const { file, newLineOf } = modifiedFile(base, [
      { afterLine: firstAfter, lines: INDEX_DEFECT_BLOCK },
      { afterLine: secondAfter, lines: DIVISION_DEFECT_BLOCK },
    ]);
    const files: Record<string, FixtureFile> = { [largePath]: file };
    for (let index = 1; index <= 5; index += 1) {
      files[`godot/scripts/gen_module_${String(index).padStart(2, "0")}.gd`] = addedFile(generatedModule(index, 11_000));
    }
    return {
      title: "chore: 대형 diff 잔소리 봇 프로브",
      acceptanceCriteria: ACCEPTANCE_CRITERIA,
      files,
      plantedRoots: [
        { file: largePath, line: newLineOf(0, INDEX_DEFECT_BLOCK.length - 1) },
        { file: largePath, line: newLineOf(1, DIVISION_DEFECT_BLOCK.length - 1) },
      ],
    };
  }
  const file = addedFile(SMALL_DEFECT_FILE);
  const lines = SMALL_DEFECT_FILE.split("\n");
  return {
    title: "chore: 잔소리 봇 프로브",
    acceptanceCriteria: ACCEPTANCE_CRITERIA,
    files: { [smallPath]: file },
    plantedRoots: [
      { file: smallPath, line: lines.indexOf("\treturn REWARD_TIERS[tier]") + 1 },
      { file: smallPath, line: lines.indexOf("\treturn total / scores.size()") + 1 },
    ],
  };
}

type RenderedContext = {
  hostFacts: ReviewGateHostFacts;
  reviewGateMarkdown: string;
  currentHeadFileContents: Record<string, string>;
  visibleChangedPatches: Record<string, string>;
};

/** Mirrors the merge-gate markdown, truncation, and host visibility rules of buildPullRequestContext. */
function renderContext(fixture: Fixture): RenderedContext {
  const headSha = "1c3aa42fa140fa411ee4f2260e8effb325c6f695";
  const paths = Object.keys(fixture.files).sort((left, right) => left.localeCompare(right));

  const patchSections: Array<{ filename: string; patch: string; section: string }> = [];
  let patchChars = 0;
  for (const filename of paths) {
    const file = fixture.files[filename]!;
    const section = [
      `### ${filename}`,
      `status=${file.status} additions=${file.additions} deletions=${file.deletions}`,
      "```diff",
      file.patch,
      "```",
    ].join("\n");
    if (patchChars + section.length > MAX_REVIEW_GATE_PATCH_CHARS) {
      break;
    }
    patchSections.push({ filename, patch: file.patch, section });
    patchChars += section.length;
  }

  const contentSections: Array<{ filename: string; content: string; section: string; contextComplete: boolean }> = [];
  for (const filename of paths) {
    const file = fixture.files[filename]!;
    const header = `status=${file.status} additions=${file.additions} deletions=${file.deletions} current_head_size=${file.content.length}`;
    if (file.content.length > MAX_CHANGED_FILE_CONTENT_CHARS) {
      const digest = buildLargeFileDigest(file.content, file.patch);
      contentSections.push({
        filename,
        content: file.content,
        contextComplete: Boolean(digest?.changedRegionsComplete),
        section: digest
          ? [
              `### ${filename}`,
              `${header} (full body omitted >${MAX_CHANGED_FILE_CONTENT_CHARS} chars; showing changed-region windows + symbol outline)`,
              "````gdscript",
              digest.markdown,
              "````",
            ].join("\n")
          : [`### ${filename}`, header, `current HEAD content omitted because it exceeds ${MAX_CHANGED_FILE_CONTENT_CHARS} characters`].join("\n"),
      });
      continue;
    }
    contentSections.push({
      filename,
      content: file.content,
      contextComplete: true,
      section: [`### ${filename}`, header, "````gdscript", file.content.trimEnd(), "````"].join("\n"),
    });
  }

  const reviewGateMarkdown = [
    "# Pull Request Merge Gate Context",
    "",
    "Repository: seorilabs/animal-chess",
    "Pull request: #14",
    `Title: ${fixture.title}`,
    `Head SHA: ${headSha}`,
    "Base: seorilabs/animal-chess:main",
    "Head: seorilabs/animal-chess:jansoree-bot-probe",
    "Change class: product_logic",
    `Minimum explicit acceptance criteria: ${fixture.acceptanceCriteria.length}`,
    "",
    "## Status Checks",
    "- checks / Godot compile and smoke: success",
    "",
    "## Trusted Acceptance Sources",
    "Acceptance criteria and source_quote values may be derived ONLY from this section.",
    "### PR body",
    "## 인수조건 체크리스트",
    ...fixture.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`),
    "",
    "## Review Turn Context",
    "review_round: 1",
    "previous_review_head: (none - first review turn)",
    "",
    "### Previous Seori Result",
    "(none - first review turn)",
    "",
    "### Contributor Responses Since Previous Seori Result",
    "(none)",
    "",
    "### Changes Since Previous Seori Result",
    "(none - first review turn)",
    "",
    "## Changed Files",
    truncate(patchSections.map(({ section }) => section).join("\n\n") || "(none)", MAX_REVIEW_GATE_PATCH_CHARS),
    "",
    "## Current Changed File Contents",
    "Product files are prioritized. Large files contain every changed-hunk window plus a bounded symbol outline instead of the full body.",
    contentSections.map(({ section }) => section).join("\n\n") || "(none)",
    "",
    "## Deep Repository Context",
    "This is selected current-HEAD evidence, not necessarily the whole repository.",
    "(none)",
  ].join("\n");
  const truncated = truncate(reviewGateMarkdown, MAX_CONTEXT_CHARS - REVIEW_GATE_PROMPT_RESERVE_CHARS);

  const currentHeadFileContents = Object.fromEntries(
    contentSections
      .filter(({ contextComplete, section }) => contextComplete && truncated.includes(section))
      .map(({ filename, content }) => [filename, content]),
  );
  const visibleChangedPatches = Object.fromEntries(
    patchSections
      .filter(({ section }) => truncated.includes(section))
      .map(({ filename, patch }) => [filename, patch]),
  );
  const fatalContextComplete = paths.every((filename) => Boolean(visibleChangedPatches[filename]));

  return {
    hostFacts: {
      headSha,
      changeClass: "product_logic",
      testInventoryComplete: false,
      testInventoryFileCount: 0,
      fatalContextComplete,
    },
    reviewGateMarkdown: truncated,
    currentHeadFileContents,
    visibleChangedPatches,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const scenario = args.find((arg) => !arg.startsWith("--")) || "defect";
  const runs = Number.parseInt(args.filter((arg) => !arg.startsWith("--"))[1] || "1", 10);
  const budgetArg = args.find((arg) => arg.startsWith("--thinking-budget="))?.split("=")[1];
  const thinking: MiniMaxThinking | undefined = args.includes("--thinking-off")
    ? { type: "disabled" }
    : budgetArg
      ? { type: "enabled", budget_tokens: Number.parseInt(budgetArg, 10) }
      : undefined;
  const apiKey = process.env.MINIMAX_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("MINIMAX_API_KEY is required");
  }
  if (!["defect", "clean", "large-defect"].includes(scenario)) {
    throw new Error(`unknown fixture: ${scenario}`);
  }

  const http = { apiKey, timeoutMs: REQUEST_TIMEOUT_MS };
  const fixture = buildFixture(scenario);
  const context = renderContext(fixture);
  const explicitAcceptanceCriteria = [...fixture.acceptanceCriteria];
  const evidenceCandidatesText = formatReviewEvidenceCandidates(
    buildReviewEvidenceCandidates(context.currentHeadFileContents, { acceptanceCriteria: explicitAcceptanceCriteria }),
  );
  const coverageSystem = buildReviewGateCoverageSystemPrompt({ acceptanceGuideMode: true });
  const defectSystem = buildReviewGateDefectSystemPrompt({ acceptanceGuideMode: true });
  const verifierSystem = buildReviewGateVerifierSystemPrompt();
  const coverageUser = buildReviewGateCoverageUserPrompt({
    ...context.hostFacts,
    explicitAcceptanceCriteria,
    evidenceCandidatesText,
    trustedRequest: "",
    acceptanceSourceText: fixture.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`).join("\n"),
    reviewRound: 1,
    previousReviewHeadSha: null,
    previousReviewBody: "",
    contributorResponses: "",
    acceptanceGuideMode: true,
  });
  const defectUser = buildReviewGateDefectUserPrompt({
    ...context.hostFacts,
    explicitAcceptanceCriteria,
    trustedRequest: "",
    ledgerText: "",
    reviewGateMarkdown: context.reviewGateMarkdown,
    acceptanceGuideMode: true,
  });
  console.log(JSON.stringify({
    scenario,
    thinking: thinking ?? { type: "adaptive" },
    files: Object.keys(fixture.files).length,
    visibleContents: Object.keys(context.currentHeadFileContents),
    visiblePatches: Object.keys(context.visibleChangedPatches).length,
    fatalContextComplete: context.hostFacts.fatalContextComplete,
    coveragePromptChars: coverageUser.length,
    defectPromptChars: defectUser.length,
    plantedRoots: fixture.plantedRoots,
  }));

  let failed = false;
  for (let run = 1; run <= runs; run += 1) {
    const startedAt = Date.now();
    const phases: MiniMaxGateRequestUsage[] = [];
    const record = (usage: MiniMaxGateRequestUsage): void => {
      phases.push(usage);
    };

    let extraction;
    try {
      extraction = await extractReviewGateCandidatesIsolated(explicitAcceptanceCriteria, {
        coverage: async () =>
          (await executeMiniMaxGateRequest({
            http,
            buildRequest: () => buildMiniMaxCoverageRequest({ systemPrompt: coverageSystem, userPrompt: coverageUser, thinking }),
            parseResponse: (response) => parseMiniMaxCoverageResponse(response, { expectedAcceptanceCriteria: explicitAcceptanceCriteria }),
            originalUserPrompt: coverageUser,
            phaseLabel: "커버리지 분류",
            onRequestCompleted: record,
          })).value,
        defect: async () =>
          (await executeMiniMaxGateRequest({
            http,
            buildRequest: () => buildMiniMaxDefectRequest({ systemPrompt: defectSystem, userPrompt: defectUser, thinking }),
            parseResponse: (response) => parseMiniMaxDefectResponse(response),
            originalUserPrompt: defectUser,
            phaseLabel: "결함 후보 탐색",
            onRequestCompleted: record,
          })).value,
      });
    } catch (error) {
      failed = true;
      console.log(JSON.stringify({ scenario, run, phase: "extraction", ok: false, phases, error: error instanceof Error ? error.message : String(error) }));
      continue;
    }
    const candidates = extraction.candidates;
    const coverage = extraction.acceptanceCoverage.map((row) => `${row.criterionId}:${row.status}`);

    const verifierPromptChars: Record<string, number> = {};
    const isolated = await verifyReviewGateCandidatesIsolated(candidates, async (candidate) => {
      const userPrompt = buildReviewGateVerifierUserPrompt({
        ...context.hostFacts,
        candidate,
        explicitAcceptanceCriteria,
        evidenceCandidatesText,
        currentHeadFileContents: context.currentHeadFileContents,
        visibleChangedPatches: context.visibleChangedPatches,
      });
      verifierPromptChars[candidate.candidateId] = userPrompt.length;
      const result = await executeMiniMaxGateRequest({
        http,
        buildRequest: () => buildMiniMaxVerificationRequest({ systemPrompt: verifierSystem, userPrompt }),
        parseResponse: (response) =>
          parseMiniMaxVerificationResponse(response, {
            expectedCandidates: [{ candidateId: candidate.candidateId, kind: candidate.kind }],
          }),
        originalUserPrompt: userPrompt,
        phaseLabel: `후보 반증 ${candidate.candidateId}`,
        onRequestCompleted: record,
      });
      return result.value.verifications[0]!;
    });

    const pipeline = evaluateMiniMaxReviewGateCandidates({
      candidates,
      verifications: isolated.verifications,
      explicitAcceptanceCriteria,
      testInventoryComplete: context.hostFacts.testInventoryComplete,
      testInventoryFileCount: context.hostFacts.testInventoryFileCount,
      currentHeadFileContents: context.currentHeadFileContents,
      visibleChangedPatches: context.visibleChangedPatches,
    });

    const acceptedRoots = pipeline.accepted.map((item) => {
      const candidate = candidates.find((entry) => entry.candidateId === item.candidateId);
      return { candidateId: item.candidateId, file: candidate?.file ?? null, line: candidate?.line ?? null };
    });
    const plantedDetected = fixture.plantedRoots.map((root) => ({
      ...root,
      proposed: candidates.some((candidate) => candidate.file === root.file && candidate.line === root.line),
      accepted: acceptedRoots.some((item) => item.file === root.file && item.line === root.line),
    }));
    const slowVerifier = phases.filter((phase) => phase.phase.startsWith("후보 반증") && phase.elapsedMs >= VERIFIER_TIMEOUT_BUDGET_MS);
    const callFailures = extraction.failures.length + isolated.failures.length;
    const pass = fixture.plantedRoots.length === 0
      ? pipeline.accepted.length === 0 && callFailures === 0
      : plantedDetected.some((root) => root.accepted) && callFailures === 0;
    if (!pass || slowVerifier.length > 0) {
      failed = true;
    }

    console.log(JSON.stringify({
      scenario,
      run,
      pass,
      totalElapsedMs: Date.now() - startedAt,
      phases,
      verifierPromptChars,
      coverage,
      candidates: candidates.map((candidate) => ({
        id: candidate.candidateId,
        kind: candidate.kind,
        file: candidate.file,
        line: candidate.line,
        outcome: candidate.fatalOutcome,
      })),
      verifications: isolated.verifications.map((entry) => ({
        id: entry.candidateId,
        verdict: entry.verdict,
        reasonKo: entry.reasonKo,
      })),
      extractionFailures: extraction.failures,
      failures: isolated.failures,
      accepted: acceptedRoots,
      rejected: pipeline.rejected.map((item) => `${item.candidateId}:${item.code}`),
      plantedDetected,
      slowVerifier: slowVerifier.map((phase) => phase.phase),
    }));
  }

  process.exitCode = failed ? 1 : 0;
}

await main();
