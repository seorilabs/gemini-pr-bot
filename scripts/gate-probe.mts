/**
 * Local review-gate probe against the real MiniMax API.
 *
 * Replays the production candidate → verifier prompt contract on synthetic
 * PR fixtures so prompt/sensitivity changes can be iterated without a
 * deploy-and-webhook cycle.
 *
 * Usage:
 *   MINIMAX_API_KEY=... node --import tsx scripts/gate-probe.mts <defect|clean> [runs]
 */
import { callMiniMaxMessages } from "../src/minimax-client.js";
import {
  buildMiniMaxReviewRequest,
  buildMiniMaxVerificationRequest,
  parseMiniMaxReviewResponse,
  parseMiniMaxVerificationResponse,
} from "../src/minimax-review.js";
import {
  REVIEW_GATE_PROMPT_VERSION,
  buildReviewGateCandidateSystemPrompt,
  buildReviewGateVerifierSystemPrompt,
} from "../src/review-gate-prompt.js";

const DEFECT_FILE = `extends RefCounted

## 일일 보상 티어 테이블. 정상 진행에서 tier는 1..3을 전달받는다.
const REWARD_TIERS: Array[int] = [10, 20, 30]


## 전달된 tier의 보상량을 돌려준다.
static func reward_for_tier(tier: int) -> int:
\treturn REWARD_TIERS[tier]


## 최근 판 점수의 평균을 돌려준다.
static func average_score(scores: Array) -> float:
\tvar total := 0.0
\tfor score in scores:
\t\ttotal += score
\treturn total / scores.size()
`;

const CLEAN_FILE = `extends RefCounted

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

const ACCEPTANCE_CRITERIA = [
  "정상 진행 tier 1..3 입력에서 보상량이 반환된다.",
  "빈 점수 목록에서도 평균 계산이 안전하다.",
];

function asAddedPatch(content: string): string {
  return content
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
}

function buildCandidateUserPrompt(fileContent: string): string {
  const criteria = ACCEPTANCE_CRITERIA.map((criterion, index) => `AC-${index + 1}: ${criterion}`).join("\n");
  const markdown = [
    "# Pull Request Merge Gate Context",
    "",
    "Repository: seorilabs/animal-chess",
    "Pull request: #14",
    "Title: chore: 잔소리 봇 프로브",
    "Head SHA: 1c3aa42fa140fa411ee4f2260e8effb325c6f695",
    "Base: seorilabs/animal-chess:main",
    "Head: seorilabs/animal-chess:jansoree-bot-probe",
    "Change class: product_logic",
    "Minimum explicit acceptance criteria: 2",
    "",
    "## Status Checks",
    "- checks / Godot compile and smoke: success",
    "",
    "## Trusted Acceptance Sources",
    "Acceptance criteria and source_quote values may be derived ONLY from this section.",
    "### PR body",
    "## 인수조건 체크리스트",
    ...ACCEPTANCE_CRITERIA.map((criterion) => `- [ ] ${criterion}`),
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
    "### godot/scripts/reward_tiers.gd",
    "```diff",
    asAddedPatch(fileContent),
    "```",
    "",
    "## Current Changed File Contents",
    "Product files are prioritized. Large files contain every changed-hunk window plus a bounded symbol outline instead of the full body.",
    "### godot/scripts/reward_tiers.gd",
    "```gdscript",
    fileContent,
    "```",
    "",
    "## Deep Repository Context",
    "This is selected current-HEAD evidence, not necessarily the whole repository.",
    "(none)",
  ].join("\n");

  return [
    `Gate version: ${REVIEW_GATE_PROMPT_VERSION}`,
    "## Host 검증 사실",
    "head_sha: 1c3aa42fa140fa411ee4f2260e8effb325c6f695",
    "change_class: product_logic",
    "test_inventory_complete: false",
    "test_inventory_file_count: 0",
    "fatal_context_complete: true",
    "",
    "## Host가 추출한 명시적 인수조건",
    criteria,
    "",
    "## Host Evidence Candidates",
    "아래 JSON line만 test_evidence와 supporting_test_evidence의 근거로 선택할 수 있습니다.",
    "(current-HEAD evidence candidate 없음)",
    "",
    "## 신뢰된 명시 요청",
    "(없음)",
    "",
    "## 지적 원장",
    "(이전 지적 없음)",
    "",
    markdown,
    "",
    "## 수행할 작업",
    "각 인수조건의 현재 HEAD 근거 상태를 acceptance_coverage로 분류하고, 위 현재 HEAD 근거만으로 완전히 입증된 치명 후보를 최대 2개 candidates에 함께 제출하세요. 확실한 후보가 없으면 candidates는 빈 배열입니다.",
  ].join("\n");
}

function buildVerifierUserPrompt(candidateUser: string, candidates: unknown[]): string {
  return [
    candidateUser,
    "",
    "## 반증할 후보",
    JSON.stringify({ candidates }, null, 2),
    "",
    "## 수행할 작업",
    "각 후보를 현재 HEAD에서 먼저 반증하고, 후보 순서대로 confirmed/rejected/uncertain 중 하나를 submit_review 도구로 제출하세요.",
  ].join("\n");
}

async function main(): Promise<void> {
  const scenario = process.argv[2] === "clean" ? "clean" : "defect";
  const runs = Number.parseInt(process.argv[3] || "1", 10);
  const apiKey = process.env.MINIMAX_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("MINIMAX_API_KEY is required");
  }
  const http = { apiKey, timeoutMs: 300_000 };
  const fileContent = scenario === "defect" ? DEFECT_FILE : CLEAN_FILE;
  const candidateSystem = buildReviewGateCandidateSystemPrompt({ acceptanceGuideMode: true });
  const verifierSystem = buildReviewGateVerifierSystemPrompt();
  const candidateUser = buildCandidateUserPrompt(fileContent);

  for (let run = 1; run <= runs; run += 1) {
    const startedAt = Date.now();
    const candidateResponse = await callMiniMaxMessages(
      buildMiniMaxReviewRequest({ systemPrompt: candidateSystem, userPrompt: candidateUser }),
      http,
    );
    const parsed = parseMiniMaxReviewResponse(candidateResponse, {
      expectedAcceptanceCriteria: ACCEPTANCE_CRITERIA,
    });
    if (!parsed.ok) {
      console.log(JSON.stringify({ scenario, run, phase: "candidate", ok: false, errors: parsed.errors.slice(0, 6) }));
      continue;
    }

    const candidates = parsed.value.candidates;
    const summary: Record<string, unknown> = {
      scenario,
      run,
      elapsedMs: Date.now() - startedAt,
      coverage: parsed.value.acceptanceCoverage.map((row) => `${row.criterionId}:${row.status}`),
      candidates: candidates.map((candidate) => ({
        id: candidate.candidateId,
        kind: candidate.kind,
        file: candidate.file,
        line: candidate.line,
        outcome: candidate.fatalOutcome,
      })),
    };

    if (candidates.length > 0) {
      const verificationResponse = await callMiniMaxMessages(
        buildMiniMaxVerificationRequest({
          systemPrompt: verifierSystem,
          userPrompt: buildVerifierUserPrompt(candidateUser, [...candidates]),
        }),
        http,
      );
      const verification = parseMiniMaxVerificationResponse(verificationResponse, {
        expectedCandidates: candidates.map(({ candidateId, kind }) => ({ candidateId, kind })),
      });
      summary.verifications = verification.ok
        ? verification.value.verifications.map((entry) => `${entry.candidateId}:${entry.verdict}`)
        : { errors: verification.errors.slice(0, 6) };
    }

    console.log(JSON.stringify(summary));
  }
}

await main();
