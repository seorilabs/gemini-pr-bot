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
  /(?:(?:\b|_)(?:assert\w*|xctassert\w*)\s*(?:[.(]|!\s*\()|\bassert\s+\S|(?:\b|_)expect\s*\([^)]*\)\s*(?:\.|\bto\b)|(?:\b|_)(?:expect|should|verify\w*|check\w*|equal|match|fail|pass|throws?|raises?|snapshot)\s*(?:[.(]|!\s*\()|\.to(?:be|equal|match|throw|contain|have)\w*\s*\()/iu;
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
    isVacuousAssertion(assertion)
  ) {
    return false;
  }

  const rawContent = context.currentHeadFileContents[evidence.file] || "";
  if (!rawContent) {
    return false;
  }

  const lines = stripCommentsFromLines(rawContent.split(/\r?\n/u));
  const godotExecutableHarness = isGodotExecutableHarness(evidence.file, lines);
  const executableApiContractCall =
    godotExecutableHarness &&
    isApiContractCriterion(criterion.sourceQuote) &&
    isDirectGodotCallSyntax(assertion);
  if (
    !ASSERTION_PATTERN.test(assertion) &&
    !isGuardAssertionSyntax(evidence.file, assertion) &&
    !executableApiContractCall
  ) {
    return false;
  }
  const supportingContext = supportingTestContext(evidence.file, lines);
  for (let index = 0; index < lines.length; index += 1) {
    if (
      !isNamedTestDeclaration(evidence.file, lines, index, testName, godotExecutableHarness) ||
      isSkippedTestDeclaration(evidence.file, lines, index)
    ) {
      continue;
    }
    let end = lines.length;
    for (let candidate = index + 1; candidate < end; candidate += 1) {
      if (isTestBoundary(evidence.file, lines, candidate, godotExecutableHarness)) {
        end = candidate;
        break;
      }
    }
    const functionLines = lines.slice(index, end);
    const assertionIndex = functionLines.findIndex((line) =>
      normalizedEvidence(line).includes(assertion),
    );
    if (assertionIndex < 0) {
      continue;
    }
    // Large Godot smoke runners often contain thousands of lines in one _run
    // function. Keep the semantic anchor local to the exact assertion while
    // still proving that it belongs to the named executable function.
    const blockLines = functionLines.slice(
      Math.max(0, assertionIndex - 80),
      Math.min(functionLines.length, assertionIndex + 81),
    );
    const block = normalizedEvidence(blockLines.join("\n"));
    const directCallContext = godotDirectCallContext(
      evidence.file,
      evidence.assertionQuote,
      blockLines,
      supportingContext,
      context.currentHeadFileContents,
    );
    if (
      (hasExecutableAssertionLine(blockLines, assertion) ||
        (executableApiContractCall && hasExecutableGodotCallLine(blockLines, assertion))) &&
      criterionAnchorsMatch(
        criterion.sourceQuote,
        evidence,
        block,
        supportingContext,
        directCallContext,
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Some acceptance criteria require adding or wiring a test suite rather than
 * asserting product behavior directly. In that narrow case, an exact runner
 * configuration line may ground the criterion when it names a current-HEAD
 * executable test file.
 */
export function isGroundedTestExecutionEvidence(
  context: ReviewGroundingContext,
  criterion: ReviewGateCriterion,
  evidence: ReviewGateTestEvidence,
): boolean {
  if (
    !isTestExecutionCriterion(criterion.sourceQuote) ||
    !isTestRunnerConfigPath(evidence.file) ||
    !testExecutionSubjectMatches(criterion.sourceQuote, evidence)
  ) {
    return false;
  }

  const runnerContent = context.currentHeadFileContents[evidence.file] || "";
  if (!runnerContent || !runnerContent.includes(evidence.assertionQuote)) {
    return false;
  }
  const referencedBasenames = new Set(
    [...evidence.assertionQuote.matchAll(
      /(?:^|[\\/])([^\\/"'\s]*(?:test|spec|smoke|probe|check|verify)[^\\/"'\s]*\.[A-Za-z0-9]+)(?=$|["'\s])/giu,
    )].map((match) => (match[1] || "").toLowerCase()),
  );
  if (referencedBasenames.size === 0) {
    return false;
  }

  return Object.entries(context.currentHeadFileContents).some(([file, content]) => {
    const basename = file.split("/").at(-1)?.toLowerCase() || "";
    return referencedBasenames.has(basename) && isExecutableTestFile(file, content);
  });
}

function testExecutionSubjectMatches(
  sourceQuote: string,
  evidence: ReviewGateTestEvidence,
): boolean {
  const evidenceText = normalizedEvidence(
    `${evidence.file} ${evidence.testName} ${evidence.assertionQuote} ${evidence.explanationKo || ""}`,
  ).toLowerCase();
  const explicitIdentifiers = [...sourceQuote.matchAll(/`([^`]{2,80})`/gu)]
    .map((match) => canonicalExplicitIdentifier(match[1] || ""))
    .filter(Boolean);
  if (explicitIdentifiers.length > 0) {
    const canonicalEvidence = canonicalExplicitIdentifier(evidenceText);
    return explicitIdentifiers.every((token) => canonicalEvidence.includes(token));
  }

  const genericKorean = /^(?:테스트|추가|실행|연결|포함|통합|검증)/u;
  const sourceKorean = [...koreanTokens(sourceQuote)].filter((token) => !genericKorean.test(token));
  const evidenceKorean = [...koreanTokens(evidenceText)];
  if (sourceKorean.some((token) =>
    evidenceKorean.some((candidate) =>
      token === candidate || commonPrefixLength(token, candidate) >= 3))) {
    return true;
  }

  const sourceAscii = asciiAnchorTokens(sourceQuote);
  const evidenceAscii = asciiAnchorTokens(evidenceText);
  return [...sourceAscii].some((token) => evidenceAscii.has(token));
}

function isTestExecutionCriterion(sourceQuote: string): boolean {
  return (
    /테스트.{0,30}(?:추가|실행|연결|포함|통합)|(?:추가|실행|연결|포함|통합).{0,30}테스트/iu.test(sourceQuote) ||
    /\btests?\b.{0,40}\b(?:add|execute|include|run|wire)\w*\b|\b(?:add|execute|include|run|wire)\w*\b.{0,40}\btests?\b/iu.test(sourceQuote)
  );
}

function isTestRunnerConfigPath(file: string): boolean {
  const lower = file.toLowerCase();
  const basename = lower.split("/").at(-1) || "";
  return (
    ["package.json", "makefile"].includes(basename) ||
    /(?:^|\/)(?:scripts?|tools?)\/[^/]+\.(?:sh|bash|zsh|mjs|cjs|js|ts)$/u.test(lower)
  );
}

function isExecutableTestFile(file: string, content: string): boolean {
  if (!isTestEvidencePath(file) || !content) {
    return false;
  }
  const lines = stripCommentsFromLines(content.split(/\r?\n/u));
  if (file.toLowerCase().endsWith(".gd")) {
    return (
      isGodotExecutableHarness(file, lines) ||
      lines.some((line) => /^\s*func\s+_?test[_A-Z]\w*\s*\(/iu.test(line))
    );
  }
  return lines.some((line, index) => isRegisteredTestDeclaration(file, lines, index));
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
  godotExecutableHarness: boolean,
): boolean {
  const line = lines[index] || "";
  const normalizedLine = normalizedEvidence(line);
  if (!normalizedLine.includes(testName)) {
    return false;
  }
  return isRegisteredTestDeclaration(file, lines, index, godotExecutableHarness);
}

function isTestBoundary(
  file: string,
  lines: string[],
  index: number,
  godotExecutableHarness: boolean,
): boolean {
  const line = lines[index] || "";
  return (
    /^\s*(?:@Test\b|\[(?:Test|TestCase|Fact|Theory)\b|#\[test\])/u.test(line) ||
    isRegisteredTestDeclaration(file, lines, index, godotExecutableHarness)
  );
}

function isRegisteredTestDeclaration(
  file: string,
  lines: string[],
  index: number,
  godotExecutableHarness = false,
): boolean {
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
  if (extension === ".gd") {
    return (
      /^\s*func\s+_?test[_A-Z]\w*\s*\(/iu.test(line) ||
      (godotExecutableHarness && /^\s*func\s+_(?:run|test)\w*\s*\(/iu.test(line))
    );
  }
  if ([".rb", ".php"].includes(extension)) {
    return /^\s*(?:(?:async\s+)?(?:def|func|function)\s+test[_A-Z]\w*|(?:test|it)\s*[('"`])/iu.test(line);
  }
  return false;
}

function isGodotExecutableHarness(file: string, lines: string[]): boolean {
  const lower = file.toLowerCase();
  const basename = lower.split("/").at(-1) || "";
  if (!lower.endsWith(".gd") || !TEST_BASENAME_PATTERN.test(basename)) {
    return false;
  }
  if (!lines.some((line) => /^\s*extends\s+SceneTree\b/u.test(line))) {
    return false;
  }
  if (!godotLifecycleCallsRunner(lines)) {
    return false;
  }
  return lines.some((line) => hasGodotFailureExit(line));
}

function godotLifecycleCallsRunner(lines: string[]): boolean {
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*func\s+_(?:init|initialize|ready)\s*\(/u.test(lines[index] || "")) {
      continue;
    }
    for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
      const line = lines[candidate] || "";
      if (/^\s*func\s+\w+\s*\(/u.test(line)) {
        break;
      }
      if (
        /\b_(?:run|test)\w*\s*(?:\.|\()/iu.test(line) ||
        /\bcall_deferred\s*\(\s*&?["']_(?:run|test)\w*["']/iu.test(line)
      ) {
        return true;
      }
    }
  }
  return false;
}

function supportingTestContext(file: string, lines: string[]): string {
  if (!file.toLowerCase().endsWith(".gd")) {
    return "";
  }
  return lines
    .filter((line) =>
      /^\s*(?:const|var)\s+\w+\s*(?::=|=)\s*(?:preload|load)\s*\(/u.test(line),
    )
    .join("\n");
}

function godotDirectCallContext(
  file: string,
  assertion: string,
  testBlockLines: string[],
  supportingContext: string,
  currentHeadFileContents: Readonly<Record<string, string>>,
): string {
  if (!file.toLowerCase().endsWith(".gd")) {
    return "";
  }
  const aliases = new Map<string, string>();
  for (const match of supportingContext.matchAll(
    /(?:^|\n)\s*(?:const|var)\s+([A-Za-z_]\w*)\s*(?::=|=)\s*(?:preload|load)\s*\(\s*["']res:\/\/([^"']+)["']\s*\)/gu,
  )) {
    aliases.set(match[1]!, match[2]!);
  }

  const blocks: string[] = [];
  const seen = new Set<string>();
  const normalizedAssertion = normalizedEvidence(assertion);
  const assertionIndex = testBlockLines.findIndex((line) =>
    normalizedEvidence(line).includes(normalizedAssertion),
  );
  const callWindow = assertionIndex < 0
    ? assertion
    : testBlockLines.slice(Math.max(0, assertionIndex - 8), assertionIndex + 1).join("\n");
  for (const match of callWindow.matchAll(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/gu)) {
    const sourcePath = aliases.get(match[1]!);
    const functionName = match[2]!;
    const key = `${sourcePath || ""}:${functionName}`;
    if (!sourcePath || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const source = currentHeadFileContents[sourcePath];
    if (!source) {
      continue;
    }
    const lines = stripCommentsFromLines(source.split(/\r?\n/u));
    const start = lines.findIndex((line) =>
      line.match(/^\s*(?:static\s+)?func\s+([A-Za-z_]\w*)\s*\(/u)?.[1] === functionName,
    );
    if (start < 0) {
      continue;
    }
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^\s*(?:static\s+)?func\s+[A-Za-z_]\w*\s*\(/u.test(lines[index] || "")) {
        end = index;
        break;
      }
    }
    blocks.push(lines.slice(start, end).join("\n"));
  }
  return blocks.join("\n");
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
  const lead = assertion.match(
    /(?:\b|_)(assert\w*|xctassert\w*|expect|should|verify\w*|check\w*|equal|match|fail|pass|throws?|raises?|snapshot)\b/iu,
  )?.[1];
  for (let index = 0; index < lines.length; index += 1) {
    const code = lines[index] || "";
    if (
      normalizedEvidence(code).includes(assertion) &&
      ((lead && hasTokenOutsideString(code, lead)) ||
        isExecutableFailureGuard(lines, index, assertion))
    ) {
      return true;
    }
  }
  return false;
}

function isGuardAssertionSyntax(file: string, assertion: string): boolean {
  return file.toLowerCase().endsWith(".gd") && /^if\b/iu.test(assertion.trim());
}

function isApiContractCriterion(sourceQuote: string): boolean {
  return /포트|시그니처|인자|호출|어댑터|예외\s*없이|크래시|폴백|no[- ]?op|interface|signature|adapter|without\s+(?:an?\s+)?(?:error|exception)|crash/iu.test(
    sourceQuote,
  );
}

function isDirectGodotCallSyntax(assertion: string): boolean {
  return /^(?:await\s+)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\s*\(.+\)\s*;?$/u.test(
    assertion.trim(),
  );
}

function hasExecutableGodotCallLine(lines: string[], assertion: string): boolean {
  return lines.some((line) =>
    normalizedEvidence(line) === assertion && isDirectGodotCallSyntax(line),
  );
}

function isExecutableFailureGuard(lines: string[], index: number, assertion: string): boolean {
  const line = lines[index] || "";
  if (!/^\s*if\b/iu.test(line) || !normalizedEvidence(line).includes(assertion)) {
    return false;
  }
  const baseIndent = leadingWhitespace(line);
  for (let candidate = index + 1; candidate < Math.min(lines.length, index + 6); candidate += 1) {
    const nested = lines[candidate] || "";
    if (!nested.trim()) {
      continue;
    }
    if (leadingWhitespace(nested) <= baseIndent) {
      break;
    }
    if (/(?:\b|_)(?:fail|push_error)\w*\s*\(/iu.test(nested) || hasGodotFailureExit(nested)) {
      return true;
    }
  }
  return false;
}

function hasGodotFailureExit(line: string): boolean {
  return (
    /\b(?:quit|get_tree\(\)\.quit)\s*\(\s*[1-9]\d*(?:\s+if\b[^)]*)?\s*\)/iu.test(line) ||
    /\bOS\.exit_code\s*=\s*[1-9]\d*/u.test(line)
  );
}

function leadingWhitespace(line: string): number {
  return line.match(/^\s*/u)?.[0].replace(/\t/gu, "    ").length || 0;
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
  if (/(?:^|\b|_)check\w*\s*\(\s*true\s*(?:,|\))/iu.test(compact)) {
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
  supportingContext: string,
  directCallContext: string,
): boolean {
  const evidenceText = normalizedEvidence(
    `${evidence.file} ${evidence.testName} ${evidence.assertionQuote} ${evidence.explanationKo || ""} ${testBlock} ${supportingContext} ${directCallContext}`,
  ).toLowerCase();
  const explicitIdentifiers = [...sourceQuote.matchAll(/`([^`]{2,80})`/gu)]
    .map((match) => canonicalExplicitIdentifier(match[1] || ""))
    .filter(Boolean);
  if (explicitIdentifiers.length > 0) {
    const canonicalEvidence = canonicalExplicitIdentifier(evidenceText);
    return explicitIdentifiers.every((token) =>
      canonicalEvidence.includes(token) || signatureIdentifierMatches(token, canonicalEvidence),
    );
  }

  const sourceKorean = koreanTokens(sourceQuote);
  const evidenceKorean = koreanTokens(
    `${evidence.testName} ${evidence.assertionQuote} ${evidence.explanationKo || ""}`,
  );
  const sourceAscii = asciiAnchorTokens(sourceQuote);
  const evidenceAscii = asciiAnchorTokens(evidenceText);
  const sourceAnchors = [
    ...[...sourceKorean].map((token) => ({ language: "ko" as const, token })),
    ...[...sourceAscii].map((token) => ({ language: "en" as const, token })),
  ];
  const matchedAnchors = sourceAnchors.filter(({ language, token }) => {
    const candidates = language === "ko" ? evidenceKorean : evidenceAscii;
    const koreanPrefixThreshold = evidence.explanationKo ? 2 : 3;
    return [...candidates].some((candidate) =>
      token === candidate ||
      (token.length >= 4 && candidate.length >= 4 &&
        (token.startsWith(candidate) || candidate.startsWith(token))) ||
      (language === "ko" && commonPrefixLength(token, candidate) >= koreanPrefixThreshold),
    );
  });
  if (sourceAnchors.length === 1) {
    return matchedAnchors.length === 1 && sourceAnchors[0]!.token.length >= 4;
  }
  const requiredMatches = evidence.explanationKo
    ? Math.min(2, sourceAnchors.length)
    : Math.max(2, Math.floor(sourceAnchors.length / 2) + 1);
  return matchedAnchors.length >= requiredMatches;
}

function commonPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function canonicalExplicitIdentifier(value: string): string {
  return normalizedEvidence(value).toLowerCase().replace(/[\s'"`]+/gu, "");
}

function signatureIdentifierMatches(token: string, canonicalEvidence: string): boolean {
  const placeholderSignature = token.match(
    /^([A-Za-z_]\w*)\((?:[A-Za-z_]\w*(?::[A-Za-z_]\w*)?)(?:,[A-Za-z_]\w*(?::[A-Za-z_]\w*)?)*\)$/u,
  );
  return Boolean(
    placeholderSignature && canonicalEvidence.includes(`${placeholderSignature[1]}(`),
  );
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

/**
 * Host-owned path policy for fatal findings.
 *
 * Exported so context collection and finding validation use the same product
 * boundary instead of drifting into separate extension/path allowlists.
 */
export function isNonProductFatalPath(file: string): boolean {
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
