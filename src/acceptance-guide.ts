import { createHash } from "node:crypto";
import { BOT_GITHUB_LOGIN } from "./identity.js";
import type {
  ReviewGateAbstainItem,
  ReviewGateCoveredCriterion,
  ReviewGateManualCriterion,
  ReviewGatePublicFinding,
} from "./review-gate-format.js";

export const ACCEPTANCE_GUIDE_PUBLICATION_MARKER =
  `<!-- ${BOT_GITHUB_LOGIN}:acceptance-guide=published -->`;
export const ACCEPTANCE_GUIDE_INCOMPLETE_MARKER =
  `<!-- ${BOT_GITHUB_LOGIN}:acceptance-guide=incomplete -->`;
export const ACCEPTANCE_GUIDE_ITEM_MARKER_PREFIX =
  `${BOT_GITHUB_LOGIN}:acceptance-guide-item=`;

export type AcceptanceGuideItem = {
  id: string;
  label: string;
  reason: string;
  requiredAction: string;
};

export type AcceptanceGuideOutput = {
  items: AcceptanceGuideItem[];
  summary: string;
};

export type AcceptanceGuideThreadState = {
  isResolved: boolean;
  bodies: readonly string[];
};

export type AcceptanceGuideCheckState = {
  total: number;
  unresolved: number;
  conclusion: "success" | "action_required";
  title: string;
  summary: string;
};

export function buildAcceptanceGuide(input: {
  headSha: string;
  explicitAcceptanceCriteria: readonly string[];
  coveredCriteria: readonly ReviewGateCoveredCriterion[];
  manualCriteria: readonly ReviewGateManualCriterion[];
  abstainItems: readonly ReviewGateAbstainItem[];
  findings: readonly ReviewGatePublicFinding[];
}): AcceptanceGuideOutput {
  const items = uniqueItems([
    ...missingCriterionDefinition(input.explicitAcceptanceCriteria),
    ...input.abstainItems
      .filter((item) => /^AC-\d+\s*·/u.test(item.label))
      .map((item) => ({
        id: item.label.match(/^(AC-\d+)/u)?.[1] || "AC",
        label: item.label,
        reason: item.reason,
        requiredAction: item.requiredAction,
      })),
    ...input.findings
      .filter((finding) => finding.kind === "missing_acceptance_test")
      .map((finding) => ({
        id: criterionIdFor(
          finding.evidence.acceptanceCriterion,
          input.explicitAcceptanceCriteria,
        ),
        label: finding.evidence.acceptanceCriterion,
        reason: finding.problem,
        requiredAction: finding.requiredAction,
      })),
  ]).slice(0, 8);

  const covered = input.coveredCriteria.length === 0
    ? "- 확인된 자동 검증 근거 없음"
    : input.coveredCriteria.map((criterion) =>
        `- ${criterion.criterionId}: ${criterion.acceptanceCriterion} — \`${criterion.file}:${criterion.line}\``
      ).join("\n");
  const manual = input.manualCriteria.length === 0
    ? "- 별도 수동 확인 항목 없음"
    : input.manualCriteria.map((criterion) =>
        `- ${criterion.criterionId}: ${criterion.acceptanceCriterion}`
      ).join("\n");
  const status = items.length === 0
    ? "추가 소명이 필요한 인수조건을 찾지 못했습니다."
    : `누락 또는 소명이 필요한 인수조건 ${items.length}건을 review thread로 남겼습니다. 각 스레드에 답한 뒤 Resolve해 주세요.`;

  return {
    items,
    summary: [
      ACCEPTANCE_GUIDE_PUBLICATION_MARKER,
      "## Seori 인수조건 가이드",
      "",
      `초기 HEAD: \`${input.headSha}\``,
      "",
      status,
      "",
      "### 확인된 자동 검증 근거",
      covered,
      "",
      "### 수동 확인 항목",
      manual,
      "",
      "_이 가이드는 승인이나 코드 품질 판정이 아닙니다. 새 커밋이나 답글로 AI 리뷰를 반복하지 않으며, required check는 Seori가 남긴 미해결 스레드만 확인합니다._",
    ].join("\n"),
  };
}

export function formatAcceptanceGuideThread(item: AcceptanceGuideItem): string {
  const fingerprint = createHash("sha256")
    .update(`${item.id}\n${item.label}\n${item.reason}`)
    .digest("hex")
    .slice(0, 16);
  return [
    `### 확인 필요 · ${item.id}`,
    "",
    `**대상:** ${item.label}`,
    "",
    `**확인이 필요한 이유:** ${item.reason}`,
    "",
    `**권장 대응:** ${item.requiredAction}`,
    "",
    "누락된 내용이면 PR 본문·테스트를 보완하고, 이미 충족했다면 이 스레드에 근거를 소명해 주세요. 확인을 마치면 이 스레드를 **Resolve**하면 required check에 반영됩니다.",
    "",
    `<!-- ${ACCEPTANCE_GUIDE_ITEM_MARKER_PREFIX}${fingerprint} -->`,
    ACCEPTANCE_GUIDE_PUBLICATION_MARKER,
  ].join("\n");
}

export function isAcceptanceGuideThreadBody(body: string): boolean {
  return body.includes(ACCEPTANCE_GUIDE_ITEM_MARKER_PREFIX);
}

export function acceptanceGuideCheckState(
  threads: readonly AcceptanceGuideThreadState[],
): AcceptanceGuideCheckState {
  const guideThreads = threads.filter((thread) =>
    thread.bodies.some(isAcceptanceGuideThreadBody)
  );
  const unresolved = guideThreads.filter((thread) => !thread.isResolved).length;
  if (unresolved > 0) {
    return {
      total: guideThreads.length,
      unresolved,
      conclusion: "action_required",
      title: "인수조건 확인 필요",
      summary: [
        `Seori가 최초 안내에서 남긴 review thread ${guideThreads.length}건 중 ${unresolved}건이 아직 미해결입니다.`,
        "",
        "각 스레드에 필요한 근거를 답하거나 내용을 보완한 뒤 Resolve해 주세요.",
        "AI 리뷰는 다시 실행하지 않습니다.",
      ].join("\n"),
    };
  }
  return {
    total: guideThreads.length,
    unresolved: 0,
    conclusion: "success",
    title: "인수조건 안내 확인 완료",
    summary: [
      `Seori가 최초 안내에서 남긴 review thread ${guideThreads.length}건이 모두 Resolve됐습니다.`,
      "",
      "이 체크는 인수조건 안내 항목의 확인 완료만 의미하며 GitHub approval이나 코드 품질 승인이 아닙니다.",
    ].join("\n"),
  };
}

function missingCriterionDefinition(
  explicitAcceptanceCriteria: readonly string[],
): AcceptanceGuideItem[] {
  if (explicitAcceptanceCriteria.length > 0) {
    return [];
  }
  return [{
    id: "AC-정의",
    label: "명시적 인수조건",
    reason: "신뢰 가능한 Issue, 명세 또는 PR 본문에서 검증 가능한 인수조건을 찾지 못했습니다.",
    requiredAction: "정상 동작, 실패 처리, 데이터 보존 등 이번 변경이 만족해야 할 조건을 검증 가능한 문장으로 명시해 주세요.",
  }];
}

function criterionIdFor(
  criterion: string,
  explicitAcceptanceCriteria: readonly string[],
): string {
  const index = explicitAcceptanceCriteria.findIndex((item) => item === criterion);
  return index >= 0 ? `AC-${index + 1}` : "AC";
}

function uniqueItems(items: readonly AcceptanceGuideItem[]): AcceptanceGuideItem[] {
  const unique = new Map<string, AcceptanceGuideItem>();
  for (const item of items) {
    const key = (item.id === "AC" ? `${item.id}\n${item.label}` : item.id)
      .normalize("NFKC")
      .toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, item);
    }
  }
  return [...unique.values()];
}
