export type ReviewGatePublicVerdict = "PASS" | "FAIL" | "FOLLOW_UP" | "ABSTAIN";

export type ReviewGatePublicFindingKind = "fatal_defect" | "missing_acceptance_test";

export type ReviewGatePublicCodeEvidence = {
  file: string;
  line: number;
  code: string;
  language?: string;
};

export type ReviewGatePublicMissingTestEvidence = {
  acceptanceCriterion: string;
  /** Missing-test findings are blocking only after the host inspected the exhaustive inventory. */
  testInventoryComplete: true;
  testFilesInspected?: number;
};

type ReviewGatePublicFindingBase = {
  title: string;
  problem: string;
  trigger: string;
  impact: string;
  requiredAction: string;
  fingerprint?: string;
};

export type ReviewGatePublicFatalFinding = ReviewGatePublicFindingBase & {
  kind: "fatal_defect";
  evidence: ReviewGatePublicCodeEvidence;
  acceptanceCriterion?: string;
};

export type ReviewGatePublicMissingTestFinding = ReviewGatePublicFindingBase & {
  kind: "missing_acceptance_test";
  evidence: ReviewGatePublicMissingTestEvidence;
};

export type ReviewGatePublicFinding =
  | ReviewGatePublicFatalFinding
  | ReviewGatePublicMissingTestFinding;

export type ReviewGateCoveredCriterion = {
  criterionId: string;
  acceptanceCriterion: string;
  file: string;
  line: number;
  testName: string;
  evidenceKind?: "test" | "source";
};

export type ReviewGateAbstainItem = {
  label: string;
  reason: string;
  requiredAction: string;
  /** Host-owned signal; only later turns with exclusively peripheral items may abstain. */
  peripheral?: boolean;
};

export type ReviewGateFormatInput = {
  headSha: string;
  verdict: ReviewGatePublicVerdict;
  findings?: readonly ReviewGatePublicFinding[];
  /** HTML comment payloads used by stale-status and review-thread tracking. */
  htmlMarkers?: readonly string[];
  passSummaryKo?: string;
  abstainSummaryKo?: string;
  followUpSummaryKo?: string;
  coveredCriteria?: readonly ReviewGateCoveredCriterion[];
  fatalCheckPassed?: boolean;
  abstainItems?: readonly ReviewGateAbstainItem[];
};

export type ReviewGateCheckOutput = {
  conclusion: "success" | "action_required" | "neutral";
  title: string;
  summary: string;
  text: string;
};

const MAX_FINDINGS = 2;
const MAX_TITLE_LENGTH = 100;
const MAX_PROSE_LENGTH = 500;
const MAX_CODE_LENGTH = 280;
const MIN_HANGUL_SYLLABLES = 4;
const MIN_HANGUL_TO_LETTER_RATIO = 0.15;

/**
 * Formats the conservative gate result for a GitHub Check and PR review.
 *
 * The formatter intentionally never publishes raw model abstention reasons.
 * A blocking result is rejected unless every finding contains the five pieces
 * of evidence that a reviewer needs to evaluate it without guessing.
 */
export function formatReviewGateCheckOutput(input: ReviewGateFormatInput): ReviewGateCheckOutput {
  const headSha = requiredText(input.headSha, "headSha", 80, false);
  const markers = formatHtmlMarkers(input.htmlMarkers || []);
  const findings = [...(input.findings || [])];

  if (input.verdict === "FAIL") {
    if (findings.length === 0 || findings.length > MAX_FINDINGS) {
      throw new TypeError(`차단 판정에는 1~${MAX_FINDINGS}개의 완전한 지적 사항이 필요합니다.`);
    }
    const formattedFindings = findings.map((finding, index) =>
      formatReviewGateFinding(finding, index + 1),
    );
    const title = blockingTitle(findings);
    const summary = `현재 HEAD에서 병합을 막는 확정 근거 ${findings.length}건을 확인했습니다.`;
    return {
      conclusion: "action_required",
      title,
      summary,
      text: joinSections([
        markers,
        [
          "## Seori 보수적 병합 게이트",
          "",
          `HEAD: ${inlineCode(headSha)}`,
          "판정: **수정 필요**",
          "",
          summary,
        ].join("\n"),
        formattedFindings.join("\n\n---\n\n"),
        "_아래 근거가 현재 HEAD에서 해소되면 같은 지적을 반복하지 않고 다시 판정합니다._",
      ]),
    };
  }

  if (findings.length > 0) {
    throw new TypeError("비차단 판정에는 공개 지적 사항을 포함할 수 없습니다.");
  }

  if (input.verdict === "PASS") {
    const summary = input.passSummaryKo
      ? requiredKoreanProse(input.passSummaryKo, "passSummaryKo")
      : "명시적 인수조건의 테스트 증거를 확인했고, 증명된 치명 결함이 없습니다.";
    return {
      conclusion: "success",
      title: "보수적 게이트 통과",
      summary,
      text: joinSections([
        markers,
        [
          "## Seori 보수적 병합 게이트",
          "",
          `HEAD: ${inlineCode(headSha)}`,
          "판정: **통과**",
          "",
          summary,
          formatCoveredCriteria(input.coveredCriteria || []),
          "",
          "_이 결과는 최소 병합 게이트의 판정이며 일반적인 품질 리뷰를 대체하지 않습니다._",
        ].join("\n"),
      ]),
    };
  }

  if (input.verdict === "FOLLOW_UP") {
    const summary = input.followUpSummaryKo
      ? requiredKoreanProse(input.followUpSummaryKo, "followUpSummaryKo")
      : "현재 HEAD를 판정하려면 Contributor의 추가 근거 또는 수정이 필요합니다.";
    const followUpItems = input.abstainItems || [];
    if (followUpItems.length === 0) {
      throw new TypeError("후속 대응 요청에는 Contributor가 처리할 구체적인 항목이 필요합니다.");
    }
    return {
      conclusion: "action_required",
      title: "Contributor 후속 대응 필요",
      summary,
      text: joinSections([
        markers,
        [
          "## Seori 보수적 병합 게이트",
          "",
          `HEAD: ${inlineCode(headSha)}`,
          "판정: **후속 대응 필요**",
          "",
          summary,
          "",
          formatPassedChecks(input.coveredCriteria || [], input.fatalCheckPassed === true),
          "",
          formatFollowUpItems(followUpItems, "### Contributor 후속 대응"),
          "",
          "_코드 변경 없이 답하는 경우 같은 댓글에 `@seori /review`를 한 번 포함해 주세요. 보정 커밋을 push하면 자동 재검토되며, 직전 요청과 그 이후 변경만 좁혀서 판정합니다._",
        ].join("\n"),
      ]),
    };
  }

  const summary = input.abstainSummaryKo
    ? requiredKoreanProse(input.abstainSummaryKo, "abstainSummaryKo")
    : "현재 HEAD를 자동 승인할 근거가 충분하지 않아 GitHub approval을 제출하지 않습니다.";
  const abstainItems = input.abstainItems || [];
  if (abstainItems.length === 0 || abstainItems.some((item) => item.peripheral !== true)) {
    throw new TypeError("판정 보류에는 하나 이상의 지엽적 후속 항목만 포함할 수 있습니다.");
  }
  return {
    conclusion: "neutral",
    title: "자동 판정 보류 · 승인 없음",
    summary,
    text: joinSections([
      markers,
      [
        "## Seori 보수적 병합 게이트",
        "",
        `HEAD: ${inlineCode(headSha)}`,
        "판정: **자동 판정 보류 · 승인 없음**",
        "",
        summary,
        "",
        formatPassedChecks(input.coveredCriteria || [], input.fatalCheckPassed === true),
        "",
        formatFollowUpItems(abstainItems, "### 남은 지엽적 항목"),
        "",
        "_코드 수정을 자동 요구하지 않으며, 병합 여부는 current-HEAD 사람 검토·승인으로 결정합니다._",
      ].join("\n"),
    ]),
  };
}

function formatPassedChecks(
  criteria: readonly ReviewGateCoveredCriterion[],
  fatalCheckPassed: boolean,
): string {
  const lines = ["### 확인 완료 (PASS)"];
  if (fatalCheckPassed) {
    lines.push("- **치명 결함 검사** — 현재 변경 전체에서 확정된 치명 결함이 없습니다.");
  }
  lines.push(...formatCoveredCriterionLines(criteria));
  if (lines.length === 1) {
    lines.push("- 확정적으로 통과한 세부 항목이 없습니다.");
  }
  return lines.join("\n");
}

function formatFollowUpItems(
  items: readonly ReviewGateAbstainItem[],
  heading: string,
): string {
  if (items.length > 32) {
    throw new TypeError("공개할 후속 대응 항목은 최대 32개입니다.");
  }
  const lines = [heading];
  if (items.length === 0) {
    lines.push("- **자동 판정 근거** — 현재 HEAD 근거가 충분하지 않습니다. PR 댓글로 확인 가능한 근거를 남겨 주세요.");
    return lines.join("\n");
  }
  for (const item of items) {
    const label = requiredText(item.label, "abstainItem.label", 500, false);
    const reason = requiredKoreanProse(item.reason, "abstainItem.reason");
    const requiredAction = requiredKoreanProse(item.requiredAction, "abstainItem.requiredAction");
    lines.push(
      `- **${publicProse(label, MAX_PROSE_LENGTH)}**`,
      `  - 확인되지 않은 이유: ${publicProse(reason, MAX_PROSE_LENGTH)}`,
      `  - 필요한 대응: ${publicProse(requiredAction, MAX_PROSE_LENGTH)}`,
    );
  }
  return lines.join("\n");
}

function formatCoveredCriteria(criteria: readonly ReviewGateCoveredCriterion[]): string {
  if (criteria.length === 0) {
    return "";
  }
  return ["### 확인한 인수조건 근거", ...formatCoveredCriterionLines(criteria)].join("\n");
}

function formatCoveredCriterionLines(
  criteria: readonly ReviewGateCoveredCriterion[],
): string[] {
  if (criteria.length > 32) {
    throw new TypeError("공개할 인수조건 테스트 근거는 최대 32개입니다.");
  }
  const lines: string[] = [];
  for (const criterion of criteria) {
    const criterionId = requiredText(criterion.criterionId, "coveredCriterion.criterionId", 80, false);
    const source = requiredText(
      criterion.acceptanceCriterion,
      "coveredCriterion.acceptanceCriterion",
      MAX_PROSE_LENGTH * 4,
      false,
    );
    const file = requiredText(criterion.file, "coveredCriterion.file", 500, false);
    const testName = requiredText(criterion.testName, "coveredCriterion.testName", 500, false);
    if (!Number.isInteger(criterion.line) || criterion.line < 1) {
      throw new TypeError("coveredCriterion.line은 1 이상의 정수여야 합니다.");
    }
    lines.push(
      `- **${publicProse(criterionId, 80)}** ${publicProse(source, MAX_PROSE_LENGTH)} — ${criterion.evidenceKind === "source" ? "소스" : "테스트"} ${inlineCode(`${file}:${criterion.line}`)} · ${inlineCode(testName)}`,
    );
  }
  return lines;
}

export function formatReviewGateFinding(
  finding: ReviewGatePublicFinding,
  index = 1,
): string {
  validateFinding(finding);

  const kindLabel =
    finding.kind === "fatal_defect" ? "치명 결함" : "인수조건 테스트 누락";
  const title = publicProse(finding.title, MAX_TITLE_LENGTH);
  const problem = publicProse(finding.problem, MAX_PROSE_LENGTH);
  const trigger = publicProse(finding.trigger, MAX_PROSE_LENGTH);
  const impact = publicProse(finding.impact, MAX_PROSE_LENGTH);
  const requiredAction = publicProse(finding.requiredAction, MAX_PROSE_LENGTH);
  const criterionText = finding.kind === "missing_acceptance_test"
    ? finding.evidence.acceptanceCriterion
    : finding.acceptanceCriterion;
  const criterion = criterionText
    ? `> **관련 인수조건:** ${publicProse(criterionText, MAX_PROSE_LENGTH)}`
    : "";
  const evidence = formatFindingEvidence(finding);
  const fingerprint = finding.fingerprint
    ? formatHtmlMarker(`seori-finding:${finding.fingerprint}`)
    : "";

  return joinSections([
    `### ${index}. ${kindLabel} · ${title}`,
    criterion,
    ["**문제**", "", problem].join("\n"),
    ["**발생 조건**", "", trigger].join("\n"),
    ["**현재 HEAD 근거**", "", evidence].join("\n"),
    ["**실제 영향**", "", impact].join("\n"),
    ["**필요한 수정 또는 테스트**", "", requiredAction].join("\n"),
    fingerprint,
  ]);
}

function blockingTitle(findings: readonly ReviewGatePublicFinding[]): string {
  if (findings.every((finding) => finding.kind === "missing_acceptance_test")) {
    return "인수조건 테스트 누락";
  }
  if (findings.every((finding) => finding.kind === "fatal_defect")) {
    return "치명 결함 확인";
  }
  return "병합 차단 근거 확인";
}

function validateFinding(finding: ReviewGatePublicFinding): void {
  requiredKoreanProse(finding.title, "finding.title");
  requiredKoreanProse(finding.problem, "finding.problem");
  requiredKoreanProse(finding.trigger, "finding.trigger");
  requiredKoreanProse(finding.impact, "finding.impact");
  requiredKoreanProse(finding.requiredAction, "finding.requiredAction");

  if (!finding.evidence || typeof finding.evidence !== "object") {
    throw new TypeError("finding.evidence에는 현재 HEAD의 검증 근거가 필요합니다.");
  }
  if (finding.kind === "fatal_defect") {
    requiredText(finding.evidence.file, "finding.evidence.file", 500, false);
    requiredText(finding.evidence.code, "finding.evidence.code", 10_000, false);
    if (!Number.isInteger(finding.evidence.line) || finding.evidence.line < 1) {
      throw new TypeError("finding.evidence.line은 1 이상의 정수여야 합니다.");
    }
  } else {
    requiredText(
      finding.evidence.acceptanceCriterion,
      "finding.evidence.acceptanceCriterion",
      MAX_PROSE_LENGTH * 4,
      false,
    );
    if (finding.evidence.testInventoryComplete !== true) {
      throw new TypeError("테스트 누락 판정에는 전체 테스트 인벤토리 확인이 필요합니다.");
    }
    if (
      finding.evidence.testFilesInspected !== undefined &&
      (!Number.isInteger(finding.evidence.testFilesInspected) || finding.evidence.testFilesInspected < 0)
    ) {
      throw new TypeError("finding.evidence.testFilesInspected는 0 이상의 정수여야 합니다.");
    }
  }
  if (finding.fingerprint !== undefined) {
    requiredText(finding.fingerprint, "finding.fingerprint", 200, false);
  }
}

function formatFindingEvidence(finding: ReviewGatePublicFinding): string {
  if (finding.kind === "fatal_defect") {
    const location = `${finding.evidence.file}:${finding.evidence.line}`;
    const code = formatCodeBlock(
      finding.evidence.code,
      finding.evidence.language || languageForFile(finding.evidence.file),
    );
    return [inlineCode(location), "", code].join("\n");
  }

  const inventory = finding.evidence.testFilesInspected === undefined
    ? "전체 테스트 인벤토리 확인 완료"
    : `전체 테스트 인벤토리 확인 완료 (${finding.evidence.testFilesInspected}개 테스트 파일)`;
  return [
    `- **인수조건 원문:** ${publicProse(finding.evidence.acceptanceCriterion, MAX_PROSE_LENGTH)}`,
    `- **테스트 인벤토리:** ${inventory}`,
    "- **검색 결과:** 관련 자동화 테스트를 찾지 못했습니다.",
  ].join("\n");
}

function requiredKoreanProse(value: string, field: string): string {
  const normalized = requiredText(value, field, MAX_PROSE_LENGTH * 4, false);
  const languageSample = normalized
    .replace(/`[^`]*`/gu, " ")
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+/gu, " ");
  const hangulCount = languageSample.match(/[가-힣]/gu)?.length || 0;
  const latinCount = languageSample.match(/[A-Za-z]/gu)?.length || 0;
  const letterCount = hangulCount + latinCount;
  const hangulRatio = letterCount === 0 ? 0 : hangulCount / letterCount;

  if (
    hangulCount < MIN_HANGUL_SYLLABLES ||
    (latinCount > 0 && hangulRatio < MIN_HANGUL_TO_LETTER_RATIO)
  ) {
    throw new TypeError(`${field}에는 충분한 공개 리뷰용 한글 설명이 필요합니다.`);
  }
  return normalized;
}

function requiredText(
  value: string,
  field: string,
  maxLength: number,
  requireKorean: boolean,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field}에는 비어 있지 않은 문자열이 필요합니다.`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length > maxLength) {
    throw new TypeError(`${field}가 허용 길이를 초과했습니다.`);
  }
  if (requireKorean && !/[가-힣]/u.test(normalized)) {
    throw new TypeError(`${field}에는 한글 설명이 필요합니다.`);
  }
  return normalized;
}

function publicProse(value: string, maxLength: number): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/<!--?[\s\S]*?-->/gu, " ")
    .replace(/\bABSTAIN\b/giu, "자동 판정 보류")
    .replace(/\bPASS\b/gu, "통과")
    .replace(/\bFAIL\b/gu, "차단")
    .replace(/\s+/gu, " ")
    .trim();
  const truncated = normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  return escapeMarkdownText(truncated);
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/([`*_{}\[\]<>#+|])/gu, "\\$1");
}

function formatCodeBlock(rawCode: string, rawLanguage: string): string {
  const normalized = rawCode.normalize("NFKC").trim();
  const code = normalized.length <= MAX_CODE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_CODE_LENGTH - 1).trimEnd()}…`;
  const longestFence = Math.max(2, ...[...code.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);
  const language = rawLanguage.replace(/[^a-zA-Z0-9_+#-]/gu, "").slice(0, 20);
  return `${fence}${language}\n${code}\n${fence}`;
}

function inlineCode(value: string): string {
  const longestFence = Math.max(0, ...[...value.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}

function languageForFile(file: string): string {
  const extension = file.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1] || "";
  const languages: Record<string, string> = {
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    gd: "gdscript",
    go: "go",
    h: "c",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    kt: "kotlin",
    md: "markdown",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "bash",
    sql: "sql",
    swift: "swift",
    toml: "toml",
    ts: "typescript",
    tsx: "tsx",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  };
  return languages[extension] || "text";
}

function formatHtmlMarkers(markers: readonly string[]): string {
  return markers.map(formatHtmlMarker).filter(Boolean).join("\n");
}

function formatHtmlMarker(payload: string): string {
  const normalized = payload
    .normalize("NFKC")
    .replace(/<!--|-->|--/gu, "-")
    .replace(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, 500);
  return normalized ? `<!-- ${normalized} -->` : "";
}

function joinSections(sections: readonly string[]): string {
  return sections.map((section) => section.trim()).filter(Boolean).join("\n\n");
}
