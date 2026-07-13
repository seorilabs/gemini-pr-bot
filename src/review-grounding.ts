import type {
  ReviewGateCriterion,
  ReviewGateFatalBlocker,
  ReviewGateTestEvidence,
} from "./review-gate.js";

export type ReviewGroundingContext = {
  currentHeadFileContents: Readonly<Record<string, string>>;
  visibleChangedPatches: Readonly<Record<string, string>>;
};

export type ChangedLineEvidence = Map<string, Map<number, string>>;

const PRODUCT_SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cjs",
  ".cpp",
  ".cs",
  ".dart",
  ".gd",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".lua",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".rules",
  ".scala",
  ".swift",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
]);

const TEST_BASENAME_PATTERN =
  /(?:^|[._-])(?:test|spec|probe|smoke|check|validate|verify|acceptance|regression|assert|gate)(?:[._-]|$)|(?:tests?|specs?)\.[^.]+$/iu;
const ASSERTION_PATTERN =
  /(?:\b(?:assert\w*|xctassert\w*)\s*(?:[.(]|!\s*\()|\bassert\s+\S|\bexpect\s*\([^)]*\)\s*(?:\.|\bto\b)|\b(?:should|verify\w*|check\w*|equal|match|fail|pass|throws?|raises?|snapshot)\s*(?:[.(]|!\s*\()|\.to(?:be|equal|match|throw|contain|have)\w*\s*\()/iu;
const GENERIC_TEST_NAMES = new Set([
  "check",
  "describe",
  "func",
  "function",
  "it",
  "spec",
  "test",
  "tests",
  "verify",
]);
const UNCERTAINTY_PATTERN =
  /\b(?:may|might|could|possibly|possible|unclear|unverified|probably|perhaps|apparently|seems?|assum(?:e|ing)|if)\b|가능성|가능(?:하|할)|수\s+있|우려|추정|불명확|검증\s*필요|보이지\s*않|아마|듯(?:하|합니다|함)|것으로\s*보|일\s*수|라면/iu;

export function buildChangedLineEvidence(
  patches: Readonly<Record<string, string>>,
): ChangedLineEvidence {
  return new Map(
    Object.entries(patches).map(([file, patch]) => [file, parseAddedLineEvidence(patch)]),
  );
}

export function isGroundedTestEvidence(
  context: ReviewGroundingContext,
  criterion: ReviewGateCriterion,
  evidence: ReviewGateTestEvidence,
): boolean {
  if (!isTestEvidencePath(evidence.file)) {
    return false;
  }

  const testName = normalizedEvidence(evidence.testName);
  const assertion = normalizedEvidence(evidence.assertionQuote);
  if (
    testName.length < 4 ||
    GENERIC_TEST_NAMES.has(testName.toLowerCase()) ||
    assertion.length < 8 ||
    !/[\p{L}\p{N}_]/u.test(testName) ||
    !ASSERTION_PATTERN.test(assertion) ||
    isVacuousAssertion(assertion)
  ) {
    return false;
  }

  const rawContent = context.currentHeadFileContents[evidence.file] || "";
  if (!rawContent) {
    return false;
  }

  const lines = stripCommentsFromLines(rawContent.split(/\r?\n/u));
  for (let index = 0; index < lines.length; index += 1) {
    if (
      !isNamedTestDeclaration(evidence.file, lines, index, testName) ||
      isSkippedTestDeclaration(evidence.file, lines, index)
    ) {
      continue;
    }
    let end = Math.min(lines.length, index + 400);
    for (let candidate = index + 1; candidate < end; candidate += 1) {
      if (isTestBoundary(evidence.file, lines, candidate)) {
        end = candidate;
        break;
      }
    }
    const blockLines = lines.slice(index, end);
    const block = normalizedEvidence(blockLines.join("\n"));
    if (
      hasExecutableAssertionLine(blockLines, assertion) &&
      criterionAnchorsMatch(criterion.sourceQuote, evidence, block)
    ) {
      return true;
    }
  }
  return false;
}

export function isGroundedFatalBlocker(
  context: ReviewGroundingContext,
  changedLines: ChangedLineEvidence,
  blocker: ReviewGateFatalBlocker,
): boolean {
  if (
    isNonProductFatalPath(blocker.file) ||
    UNCERTAINTY_PATTERN.test(blocker.trigger) ||
    UNCERTAINTY_PATTERN.test(blocker.causalChain)
  ) {
    return false;
  }

  const changedLine = changedLines.get(blocker.file)?.get(blocker.line);
  if (!sameCodeLine(changedLine, blocker.codeQuote)) {
    return false;
  }

  const rootKey = codeEvidenceKey(blocker.file, blocker.line, blocker.codeQuote);
  const evidenceKeys = blocker.causalEvidence.map((evidence) =>
    codeEvidenceKey(evidence.file, evidence.line, evidence.codeQuote),
  );
  const evidenceLines = blocker.causalEvidence.map((evidence) => evidence.line);
  if (
    evidenceKeys.at(-1) !== rootKey ||
    new Set(evidenceKeys).size !== evidenceKeys.length ||
    blocker.causalEvidence.some(
      (evidence) => evidence.file !== blocker.file || isNonProductFatalPath(evidence.file),
    ) ||
    evidenceLines.some((line, index) => index > 0 && line <= evidenceLines[index - 1]!) ||
    evidenceLines.at(-1)! - evidenceLines[0]! > 200
  ) {
    return false;
  }

  const allEvidenceGrounded = blocker.causalEvidence.every((evidence) => {
    const addedLine = changedLines.get(evidence.file)?.get(evidence.line);
    const currentLine = context.currentHeadFileContents[evidence.file]?.split(/\r?\n/u)[evidence.line - 1];
    return sameCodeLine(addedLine ?? currentLine, evidence.codeQuote);
  });
  if (!allEvidenceGrounded) {
    return false;
  }

  const terminalLine = blocker.causalEvidence.at(-1)?.codeQuote || "";
  return hasDirectOutcomeSignature(blocker.outcome, terminalLine);
}

export function fatalBlockerSignature(blocker: ReviewGateFatalBlocker): string {
  return [
    blocker.file,
    blocker.line,
    normalizedCodeLine(blocker.codeQuote),
    blocker.outcome,
    normalizedEvidence(blocker.trigger),
    normalizedEvidence(blocker.causalChain),
    blocker.causalEvidence.map((evidence) =>
      codeEvidenceKey(evidence.file, evidence.line, evidence.codeQuote),
    ).join("->"),
  ].join(":");
}

export function sameFatalBlockerSet(
  primary: ReviewGateFatalBlocker[],
  confirmation: ReviewGateFatalBlocker[],
): boolean {
  const signatures = (blockers: ReviewGateFatalBlocker[]): string[] =>
    blockers.map(fatalBlockerSignature).sort();
  const primarySignatures = signatures(primary);
  const confirmationSignatures = signatures(confirmation);
  return (
    primarySignatures.length > 0 &&
    primarySignatures.length === confirmationSignatures.length &&
    primarySignatures.every((signature, index) => signature === confirmationSignatures[index])
  );
}

function parseAddedLineEvidence(patch: string | null | undefined): Map<number, string> {
  const lines = new Map<number, string>();
  if (!patch) {
    return lines;
  }

  let newLine = 0;
  let inHunk = false;
  for (const row of patch.split("\n")) {
    const header = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      newLine = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (row.startsWith("-")) {
      continue;
    }
    if (row.startsWith("+")) {
      lines.set(newLine, row.slice(1));
      newLine += 1;
      continue;
    }
    if (row.startsWith(" ")) {
      newLine += 1;
      continue;
    }
    if (!row.startsWith("\\")) {
      inHunk = false;
    }
  }
  return lines;
}

function isTestEvidencePath(file: string): boolean {
  const lower = file.toLowerCase();
  const segments = lower.split("/");
  const basename = segments.at(-1) || "";
  return (
    segments.slice(0, -1).some((segment) => /(?:tests?|specs?)$/u.test(segment)) ||
    TEST_BASENAME_PATTERN.test(basename)
  );
}

function isNamedTestDeclaration(
  file: string,
  lines: string[],
  index: number,
  testName: string,
): boolean {
  const line = lines[index] || "";
  const normalizedLine = normalizedEvidence(line);
  if (!normalizedLine.includes(testName)) {
    return false;
  }
  return isRegisteredTestDeclaration(file, lines, index);
}

function isTestBoundary(file: string, lines: string[], index: number): boolean {
  const line = lines[index] || "";
  return (
    /^\s*(?:@Test\b|\[(?:Test|TestCase|Fact|Theory)\b|#\[test\])/u.test(line) ||
    isRegisteredTestDeclaration(file, lines, index)
  );
}

function isRegisteredTestDeclaration(file: string, lines: string[], index: number): boolean {
  const line = lines[index] || "";
  const extension = file.toLowerCase().match(/\.[^.\/]+$/u)?.[0] || "";
  const annotations = lines.slice(Math.max(0, index - 4), index).join("\n");
  if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".dart"].includes(extension)) {
    return /^\s*(?:(?:Deno\.)?test|it)(?:\.(?:each|only|skip|todo))?\s*\(/u.test(line);
  }
  if (extension === ".py") {
    return /^\s*(?:async\s+)?def\s+test_\w*\s*\(/u.test(line);
  }
  if (extension === ".rs") {
    return /#\[test\]/u.test(annotations) && /^\s*(?:pub\s+)?fn\s+\w+\s*\(/u.test(line);
  }
  if (extension === ".swift") {
    return /^\s*(?:override\s+)?func\s+test\w*\s*\(/iu.test(line);
  }
  if (extension === ".cs") {
    return /\[(?:Test|TestCase|Fact|Theory)\b/iu.test(annotations) && /\b\w+\s*\([^;]*\)\s*\{/u.test(line);
  }
  if ([".java", ".kt", ".kts", ".scala"].includes(extension)) {
    return /@Test\b/u.test(annotations) && /\b(?:fun|void|\w+)\s+\w+\s*\(/u.test(line);
  }
  if (extension === ".go") {
    return /^\s*func\s+Test\w*\s*\(/u.test(line);
  }
  if ([".rb", ".gd", ".php"].includes(extension)) {
    return /^\s*(?:(?:async\s+)?(?:def|func|function)\s+test[_A-Z]\w*|(?:test|it)\s*[('"`])/iu.test(line);
  }
  return false;
}

function isSkippedTestDeclaration(file: string, lines: string[], index: number): boolean {
  const declarationWindow = lines
    .slice(Math.max(0, index - 3), Math.min(lines.length, index + 4))
    .join("\n");
  return (
    /(?:\b(?:test|it|describe)\.(?:skip|todo)\s*\(|\b(?:xit|xtest)\s*\(|@(?:disabled|ignore|skip)\b|\[(?:disabled|ignore|skip)\]|#\[ignore\]|pytest\.mark\.skip|unittest\.skip|\b(?:skip|disabled)\s*:\s*true\b|\benabled\s*=\s*false\b)/iu.test(
      declarationWindow,
    ) || isInsideSkippedSuite(file, lines, index)
  );
}

function hasExecutableAssertionLine(lines: string[], assertion: string): boolean {
  const lead = assertion.match(/\b(?:assert\w*|xctassert\w*|expect|should|verify\w*|check\w*|equal|match|fail|pass|throws?|raises?|snapshot)\b/iu)?.[0];
  if (!lead) {
    return false;
  }
  for (const code of lines) {
    if (
      normalizedEvidence(code).includes(assertion) &&
      hasTokenOutsideString(code, lead)
    ) {
      return true;
    }
  }
  return false;
}

function stripCommentsFromLines(lines: string[]): string[] {
  let inBlockComment = false;
  return lines.map((line) => {
    let result = "";
    let quote = "";
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index] || "";
      const next = line[index + 1] || "";
      if (inBlockComment) {
        if (char === "*" && next === "/") {
          inBlockComment = false;
          index += 1;
        }
        result += " ";
        continue;
      }
      if (quote) {
        result += char;
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = "";
        }
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        result += char;
        continue;
      }
      if (char === "/" && next === "*") {
        inBlockComment = true;
        result += " ";
        index += 1;
        continue;
      }
      if (char === "/" && next === "/") {
        break;
      }
      if (char === "#" && result.trim().length === 0 && next !== "[") {
        break;
      }
      result += char;
    }
    return result;
  });
}

function hasTokenOutsideString(line: string, token: string): boolean {
  const lowerLine = line.toLowerCase();
  const lowerToken = token.toLowerCase();
  let quote = "";
  let escaped = false;
  for (let index = 0; index <= line.length - token.length; index += 1) {
    const char = line[index] || "";
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (lowerLine.startsWith(lowerToken, index)) {
      return true;
    }
  }
  return false;
}

function isInsideSkippedSuite(file: string, lines: string[], targetIndex: number): boolean {
  if (!/\.(?:[cm]?[jt]sx?|dart)$/iu.test(file)) {
    return false;
  }
  let depth = 0;
  let skippedDepths: number[] = [];
  for (let index = 0; index <= targetIndex; index += 1) {
    const line = lines[index] || "";
    if (/\bdescribe\.skip\s*\(|\bdescribe\s*\([^\n]*\bskip\s*:\s*true/iu.test(line)) {
      const delta = braceDeltaOutsideStrings(line);
      if (delta <= 0) {
        return true;
      }
      skippedDepths.push(depth + 1);
    }
    if (index === targetIndex && skippedDepths.some((startDepth) => depth >= startDepth)) {
      return true;
    }
    depth += braceDeltaOutsideStrings(line);
    skippedDepths = skippedDepths.filter((startDepth) => depth >= startDepth);
  }
  return false;
}

function braceDeltaOutsideStrings(line: string): number {
  let delta = 0;
  let quote = "";
  let escaped = false;
  for (const char of line) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "{") {
      delta += 1;
    } else if (char === "}") {
      delta -= 1;
    }
  }
  return delta;
}

function isVacuousAssertion(assertion: string): boolean {
  const compact = assertion.replace(/\s+/gu, " ").replace(/;$/u, "").trim();
  if (/\b(?:assert(?:\.ok)?|asserttrue|xctasserttrue)\s*\(\s*true\s*\)$/iu.test(compact)) {
    return true;
  }
  const equality = compact.match(
    /\b(?:assert(?:\.\w+)?|xctassert\w*|assert\.equal)\s*\(\s*([^,()]+)\s*,\s*([^,()]+)\s*\)$/iu,
  );
  if (equality && canonicalOperand(equality[1] || "") === canonicalOperand(equality[2] || "")) {
    return true;
  }
  const expectation = compact.match(
    /\bexpect\s*\(\s*([^()]+)\s*\)\s*\.to(?:be|equal)\w*\s*\(\s*([^()]+)\s*\)$/iu,
  );
  return Boolean(
    expectation && canonicalOperand(expectation[1] || "") === canonicalOperand(expectation[2] || ""),
  );
}

function canonicalOperand(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").replace(/;+$/u, "").toLowerCase();
}

function criterionAnchorsMatch(
  sourceQuote: string,
  evidence: ReviewGateTestEvidence,
  testBlock: string,
): boolean {
  const evidenceText = normalizedEvidence(
    `${evidence.file} ${evidence.testName} ${evidence.assertionQuote} ${testBlock}`,
  ).toLowerCase();
  const explicitIdentifiers = [...sourceQuote.matchAll(/`([^`]{2,80})`/gu)]
    .map((match) => normalizedEvidence(match[1] || "").toLowerCase())
    .filter(Boolean);
  if (explicitIdentifiers.length > 0) {
    return explicitIdentifiers.every((token) => evidenceText.includes(token));
  }

  const sourceKorean = koreanTokens(sourceQuote);
  const evidenceKorean = koreanTokens(`${evidence.testName} ${evidence.assertionQuote}`);
  const sourceAscii = asciiAnchorTokens(sourceQuote);
  const evidenceAscii = asciiAnchorTokens(evidenceText);
  const sourceAnchors = [
    ...[...sourceKorean].map((token) => ({ language: "ko" as const, token })),
    ...[...sourceAscii].map((token) => ({ language: "en" as const, token })),
  ];
  const matchedAnchors = sourceAnchors.filter(({ language, token }) => {
    const candidates = language === "ko" ? evidenceKorean : evidenceAscii;
    return [...candidates].some((candidate) =>
      token === candidate ||
      (token.length >= 4 && candidate.length >= 4 &&
        (token.startsWith(candidate) || candidate.startsWith(token))),
    );
  });
  if (sourceAnchors.length === 1) {
    return matchedAnchors.length === 1 && sourceAnchors[0]!.token.length >= 4;
  }
  return matchedAnchors.length >= Math.max(2, Math.floor(sourceAnchors.length / 2) + 1);
}

function koreanTokens(value: string): Set<string> {
  const ignored = new Set(["경우", "기능", "사용", "사용자", "정상", "확인", "한다", "된다", "해야"]);
  return new Set(
    (value.match(/[가-힣]{2,}/gu) || []).filter((token) => token.length >= 2 && !ignored.has(token)),
  );
}

function asciiAnchorTokens(value: string): Set<string> {
  const ignored = new Set([
    "actual",
    "assert",
    "check",
    "equal",
    "expect",
    "expected",
    "false",
    "should",
    "test",
    "tests",
    "true",
    "value",
    "values",
    "verify",
    "when",
  ]);
  return new Set(
    (value.match(/[A-Za-z_][A-Za-z0-9_.-]{3,}/gu) || [])
      .map((token) => token.toLowerCase())
      .filter((token) => !ignored.has(token)),
  );
}

function isNonProductFatalPath(file: string): boolean {
  const lower = file.toLowerCase();
  const segments = lower.split("/");
  const basename = segments.at(-1) || lower;
  const extensionIndex = basename.lastIndexOf(".");
  const extension = extensionIndex >= 0 ? basename.slice(extensionIndex) : "";
  return (
    !PRODUCT_SOURCE_EXTENSIONS.has(extension) ||
    segments.some((segment) =>
      [".github", "assets", "build", "dist", "docs", "generated", "k8s", "pods", "tools", "vendor"].includes(
        segment,
      ),
    ) ||
    /(?:^|[._-])generated(?:[._-]|$)/u.test(basename) ||
    (lower.startsWith("scripts/") &&
      /(?:^|[._-])(?:build|deploy|publish|release)(?:[._-]|$)/u.test(basename)) ||
    segments.slice(0, -1).some((segment) => /(?:tests?|specs?)$/u.test(segment)) ||
    TEST_BASENAME_PATTERN.test(basename)
  );
}

function hasDirectOutcomeSignature(
  outcome: ReviewGateFatalBlocker["outcome"],
  sourceLine: string,
): boolean {
  const line = normalizedCodeLine(sourceLine);
  const crash = /\b(?:throw|panic!?|fatalerror|abort|raise)\b|assert\s*\(\s*false/iu;
  if (outcome === "deterministic_crash") {
    return crash.test(line);
  }
  if (outcome === "permanent_data_loss_or_corruption") {
    const destructive =
      /\b(?:clear|delete|destroy|drop|erase|purge|remove|truncate|unlink|wipe)\s*(?:\(|\b)/iu;
    const persistentTarget =
      /\b(?:account|collection|database|db|document|file|firestore|persistent|record|save|storage|store|table|user)\w*\b/iu;
    return destructive.test(line) && persistentTarget.test(line);
  }
  if (outcome === "exploitable_security_or_privacy_exposure") {
    return (
      /\ballow\s+(?:read|write|create|update|delete)(?:\s*,\s*(?:read|write|create|update|delete))*\s*:\s*if\s+true\b/iu.test(line) ||
      /\b(?:rejectunauthorized|verify[_-]?(?:ssl|tls|certificate))\b\s*[:=]\s*false\b/iu.test(line) ||
      /\b(?:log|print|send|return)\w*\s*\([^)]*\b(?:password|secret|token|credential|private[_-]?key)\b/iu.test(
        line,
      )
    );
  }
  // A return value or UI flag alone cannot prove that the primary flow is
  // unreachable. Only a direct process-terminating operation is unambiguous.
  return crash.test(line);
}

function codeEvidenceKey(file: string, line: number, quote: string): string {
  return `${file}:${line}:${normalizedCodeLine(quote)}`;
}

function sameCodeLine(actual: string | undefined, expected: string): boolean {
  return Boolean(actual) && normalizedCodeLine(actual || "") === normalizedCodeLine(expected);
}

function normalizedEvidence(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normalizedCodeLine(value: string): string {
  return value.normalize("NFKC").trim();
}
