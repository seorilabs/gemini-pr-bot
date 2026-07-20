import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import type { RepoRef } from "./github.js";
import { truncate } from "./text.js";

const execFileAsync = promisify(execFile);

const DEFAULT_SUPPORT_FILES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "tsconfig.base.json",
  "eslint.config.js",
  "eslint.config.mjs",
  "vitest.config.ts",
  "vite.config.ts",
  "jest.config.js",
  "metro.config.js",
  "turbo.json",
];

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".bin",
  ".bmp",
  ".dmg",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".ttf",
  ".wav",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

const TEST_DIRECTORY_NAMES = new Set(["__tests__", "spec", "specs", "test", "tests"]);
const TEST_DISCOVERY_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".cache",
  ".dart_tool",
  ".expo",
  ".godot",
  ".gradle",
  ".next",
  ".pnpm-store",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "deriveddata",
  "dist",
  "generated",
  "node_modules",
  "pods",
  "target",
  "tmp",
  "vendor",
]);
const MAX_TEST_CONTENT_SCAN_FILES = 400;
const TEST_RELEVANCE_MIN_SCORE = 700;

export type ChangeClass =
  | "product_logic"
  | "config_or_workflow"
  | "tests_only"
  | "docs_assets"
  | "mixed"
  | "other";

type TestInventorySelection = {
  discoveryComplete: boolean;
  contentScanComplete: boolean;
  discovered: string[];
  relevant: string[];
  /**
   * Host-only current-HEAD test bodies used to build and verify the evidence
   * index. These contents are deliberately independent from the bounded
   * markdown rendered for the model prompt.
   */
  fileContents: Readonly<Record<string, string>>;
};

type ContextFileSelection = {
  files: string[];
  changeClass: ChangeClass;
  testInventory: TestInventorySelection;
};

type ScoredTestCandidate = {
  path: string;
  score: number;
};

export type DeepRepoContextInput = {
  repo: RepoRef;
  prNumber: number;
  headSha: string;
  files: any[];
  config: Config;
  installationToken?: string;
  requested?: boolean;
};

export type DeepRepoContextResult = {
  markdown: string;
  testInventoryComplete: boolean;
  testInventoryFileCount: number;
  /** Host-only exhaustive test evidence source. Never rendered wholesale. */
  evidenceFileContents: Readonly<Record<string, string>>;
  /** Prompt-visible selected repository files. */
  fileContents: Readonly<Record<string, string>>;
};

export async function buildDeepRepoContext(input: DeepRepoContextInput): Promise<DeepRepoContextResult> {
  if (!shouldBuildDeepRepoContext(input)) {
    return {
      markdown: "",
      testInventoryComplete: false,
      testInventoryFileCount: 0,
      evidenceFileContents: {},
      fileContents: {},
    };
  }
  if (!input.installationToken) {
    return {
      markdown: "Deep repository context skipped: installation token unavailable.",
      testInventoryComplete: false,
      testInventoryFileCount: 0,
      evidenceFileContents: {},
      fileContents: {},
    };
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seori-pr-context-"));
  const askpassPath = path.join(root, "git-askpass.sh");
  const checkoutDir = path.join(root, "repo");
  try {
    await writeAskpass(askpassPath);
    await clonePullRequestHead(input, checkoutDir, askpassPath);
    return await collectRepositoryContext(input, checkoutDir);
  } catch (error) {
    return {
      markdown: `Deep repository context unavailable: ${sanitizeError(error)}`,
      testInventoryComplete: false,
      testInventoryFileCount: 0,
      evidenceFileContents: {},
      fileContents: {},
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function shouldBuildDeepRepoContext(input: DeepRepoContextInput): boolean {
  if (input.config.deepRepoContextMode === "off") {
    return false;
  }
  if (input.config.deepRepoContextMode === "always" || input.requested) {
    return true;
  }

  return input.files.some((file) => isDeepContextCandidate(String(file.filename || ""), file));
}

function isDeepContextCandidate(filename: string, file: any): boolean {
  if (!filename || isBinaryPath(filename)) {
    return false;
  }
  if (!file.patch && !isLikelyTextPath(filename)) {
    return false;
  }

  return (
    filename.startsWith(".github/workflows/") ||
    filename.startsWith(".github/actions/") ||
    isConfigPath(filename) ||
    isSourcePath(filename)
  );
}

async function writeAskpass(askpassPath: string): Promise<void> {
  await fs.writeFile(
    askpassPath,
    [
      "#!/bin/sh",
      "case \"$1\" in",
      "  *Username*) echo x-access-token ;;",
      "  *Password*) echo \"$GITHUB_TOKEN\" ;;",
      "  *) echo ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
}

async function clonePullRequestHead(
  input: DeepRepoContextInput,
  checkoutDir: string,
  askpassPath: string,
): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: "0",
    GITHUB_TOKEN: input.installationToken,
  };
  const timeout = input.config.deepRepoContextTimeoutMs;
  const repoUrl = `https://github.com/${input.repo.fullName}.git`;

  await git(["init", checkoutDir], env, timeout);
  await git(["-C", checkoutDir, "remote", "add", "origin", repoUrl], env, timeout);
  await git(["-C", checkoutDir, "fetch", "--depth=1", "origin", `refs/pull/${input.prNumber}/head`], env, timeout);
  await git(["-C", checkoutDir, "checkout", "--detach", "FETCH_HEAD"], env, timeout);
}

async function collectRepositoryContext(
  input: DeepRepoContextInput,
  checkoutDir: string,
): Promise<DeepRepoContextResult> {
  const selection = await selectContextFiles(input, checkoutDir);
  const maxBytes = input.config.deepRepoContextMaxBytes;
  const headerReserve = Math.min(1_500, maxBytes);
  const rendered: Array<{ path: string; section: string; content: string }> = [];
  let renderedBytes = 0;

  for (const relativePath of selection.files) {
    const filePath = path.join(checkoutDir, relativePath);
    const remainingBytes = maxBytes - headerReserve - renderedBytes;
    const content = await readTextFile(filePath, remainingBytes);
    if (!content) {
      continue;
    }

    const section = [
      `### ${relativePath}`,
      `\`\`\`\`${codeFenceLanguage(relativePath)}`,
      content.trimEnd(),
      "````",
    ].join("\n");
    if (renderedBytes + section.length > maxBytes - headerReserve) {
      continue;
    }

    rendered.push({ path: relativePath, section, content });
    renderedBytes += section.length;
  }

  while (true) {
    const includedPaths = new Set(rendered.map((item) => item.path));
    const header = buildRepositoryContextHeader(input, selection, includedPaths);
    const sections = [header, ...rendered.map((item) => item.section)];
    if (includedPaths.size < selection.files.length) {
      sections.push("...additional deep repository context omitted...");
    }
    const result = sections.join("\n\n");
    if (result.length <= maxBytes) {
      return {
        markdown: result,
        testInventoryComplete: isTestInventoryComplete(selection),
        testInventoryFileCount: selection.testInventory.discovered.length,
        evidenceFileContents: selection.testInventory.fileContents,
        fileContents: Object.fromEntries(rendered.map((item) => [item.path, item.content])),
      };
    }
    if (rendered.length === 0) {
      return {
        markdown: truncate(header, maxBytes),
        testInventoryComplete: isTestInventoryComplete(selection),
        testInventoryFileCount: selection.testInventory.discovered.length,
        evidenceFileContents: selection.testInventory.fileContents,
        fileContents: {},
      };
    }
    rendered.pop();
  }
}

function buildRepositoryContextHeader(
  input: DeepRepoContextInput,
  selection: ContextFileSelection,
  includedPaths: Set<string>,
): string {
  const inventory = selection.testInventory;
  const includedTests = inventory.discovered.filter((file) => includedPaths.has(file));
  const includedRelevantTests = inventory.relevant.filter((file) => includedPaths.has(file));
  const inventoryComplete = isTestInventoryComplete(selection);

  return [
    `Deep repository context source: shallow clone of current PR HEAD ${input.headSha}.`,
    `Change class: ${selection.changeClass}`,
    `Selected context files: ${selection.files.length}`,
    `Included context files: ${includedPaths.size}`,
    `Context body complete: ${includedPaths.size === selection.files.length}`,
    `Test discovery complete: ${inventory.discoveryComplete}`,
    `Test evidence scan complete: ${inventory.contentScanComplete}`,
    `Test inventory complete: ${inventoryComplete}`,
    `Test inventory discovered: ${inventory.discovered.length}`,
    `Test inventory relevant: ${inventory.relevant.length}`,
    `Test inventory included: ${includedTests.length}`,
    `Test inventory relevant included: ${includedRelevantTests.length}`,
  ].join("\n");
}

function isTestInventoryComplete(selection: ContextFileSelection): boolean {
  const inventory = selection.testInventory;
  return (
    inventory.discoveryComplete &&
    inventory.contentScanComplete &&
    inventory.discovered.every((file) => Boolean(inventory.fileContents[file]))
  );
}

async function selectContextFiles(
  input: DeepRepoContextInput,
  checkoutDir: string,
): Promise<ContextFileSelection> {
  const changed = new Set<string>();
  const allChangedPaths: string[] = [];
  const supporting = new Set<string>();

  for (const file of input.files) {
    const rawFilename = String(file.filename || "");
    const filename = rawFilename ? normalizeRepoPath(rawFilename) : "";
    if (filename && !filename.startsWith("../") && !path.isAbsolute(filename)) {
      allChangedPaths.push(filename);
    }
    if (filename && shouldIncludePath(filename)) {
      changed.add(filename);
      addSiblingContextFiles(supporting, filename);
    }
  }

  for (const file of DEFAULT_SUPPORT_FILES) {
    supporting.add(file);
  }

  const godotAutoloads = await readGodotAutoloads(checkoutDir);
  const referenceSeeds = [...changed, ...supporting];
  for (const file of referenceSeeds) {
    if (file.startsWith(".github/workflows/")) {
      await addWorkflowContextFiles(supporting, checkoutDir, file);
    }
    if (isGodotScriptPath(file)) {
      await addGodotReferenceFiles(supporting, checkoutDir, file, godotAutoloads);
    } else if (isSourcePath(file)) {
      await addRelativeImportFiles(supporting, checkoutDir, file);
    }
  }

  const inventory = await buildTestInventory(checkoutDir, [...changed]);
  const existing: string[] = [];
  const included = new Set<string>();

  async function addExistingFiles(candidates: Iterable<string>, maxSelected: number): Promise<void> {
    for (const file of candidates) {
      if (existing.length >= maxSelected) {
        return;
      }
      if (included.has(file)) {
        continue;
      }
      if (await isReadableContextFile(checkoutDir, file)) {
        existing.push(file);
        included.add(file);
      }
    }
  }

  const maxFiles = input.config.deepRepoContextMaxFiles;
  const primaryChanged = [...changed].filter(
    (file) => !isTestCandidatePath(file) && !isDocsOrAssetPath(file),
  );
  const secondaryChanged = [...changed].filter((file) => !primaryChanged.includes(file));
  const prioritizedTests = interleaveChangedAndExistingTests(inventory.relevant, changed);
  const prioritizedTestSet = new Set(prioritizedTests);
  const orderedTests = [
    ...prioritizedTests,
    ...inventory.discovered.filter((file) => !prioritizedTestSet.has(file)),
  ];
  const reservedTestSlots =
    orderedTests.length === 0 || maxFiles <= 1
      ? 0
      : Math.min(orderedTests.length, Math.max(1, Math.floor(maxFiles / 3)), maxFiles - 1);

  // Keep changed product/config files as primary evidence, but reserve part of
  // the max-files budget for both changed and pre-existing related tests.
  const initialPrimarySlots =
    reservedTestSlots === 0
      ? maxFiles
      : Math.min(primaryChanged.length, Math.max(1, Math.floor((maxFiles - reservedTestSlots) / 3)));
  await addExistingFiles(primaryChanged.slice(0, initialPrimarySlots), initialPrimarySlots);
  await addExistingFiles(orderedTests, Math.min(maxFiles, existing.length + reservedTestSlots));
  await addExistingFiles(primaryChanged.slice(initialPrimarySlots), maxFiles);
  await addExistingFiles(secondaryChanged, maxFiles);
  await addExistingFiles(supporting, maxFiles);
  // Relevant tests stay ahead of unrelated tests, while every discovered test
  // remains eligible when the file/byte budgets are large enough to carry an
  // exhaustive inventory.
  await addExistingFiles(orderedTests, maxFiles);

  return {
    files: existing,
    changeClass: classifyChange(allChangedPaths),
    testInventory: inventory,
  };
}

function interleaveChangedAndExistingTests(relevant: string[], changed: Set<string>): string[] {
  const changedTests = relevant.filter((file) => changed.has(file));
  const existingTests = relevant.filter((file) => !changed.has(file));
  const ordered: string[] = [];
  const length = Math.max(changedTests.length, existingTests.length);
  for (let index = 0; index < length; index += 1) {
    const changedTest = changedTests[index];
    const existingTest = existingTests[index];
    if (changedTest) {
      ordered.push(changedTest);
    }
    if (existingTest) {
      ordered.push(existingTest);
    }
  }
  return ordered;
}

async function buildTestInventory(
  checkoutDir: string,
  changedPaths: string[],
): Promise<TestInventorySelection> {
  const discovery = await discoverTestCandidates(checkoutDir);
  const cheapScores = new Map(
    discovery.paths.map((candidate) => [candidate, scoreTestPath(candidate, changedPaths)]),
  );
  const scanOrder = [...discovery.paths].sort((left, right) => {
    const scoreDifference = (cheapScores.get(right) || 0) - (cheapScores.get(left) || 0);
    return scoreDifference || left.localeCompare(right);
  });
  const scanPaths = new Set(scanOrder.slice(0, MAX_TEST_CONTENT_SCAN_FILES));
  let contentScanComplete = discovery.paths.length <= MAX_TEST_CONTENT_SCAN_FILES;
  const scored: ScoredTestCandidate[] = [];
  const fileContents: Record<string, string> = {};

  for (const candidate of discovery.paths) {
    let score = cheapScores.get(candidate) || 0;
    if (scanPaths.has(candidate)) {
      const content = await readTextFile(path.join(checkoutDir, candidate), 200_000);
      if (content === null) {
        contentScanComplete = false;
      } else {
        fileContents[candidate] = content;
        score += await scoreTestContent(checkoutDir, candidate, content, changedPaths);
      }
    }
    scored.push({ path: candidate, score });
  }

  const relevant = scored
    .filter((candidate) => candidate.score >= TEST_RELEVANCE_MIN_SCORE)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .map((candidate) => candidate.path);

  return {
    discoveryComplete: discovery.complete,
    contentScanComplete,
    discovered: discovery.paths,
    relevant,
    fileContents,
  };
}

async function discoverTestCandidates(
  checkoutDir: string,
): Promise<{ paths: string[]; complete: boolean }> {
  const paths: string[] = [];
  let complete = true;

  async function walk(relativeDirectory: string): Promise<void> {
    const absoluteDirectory = path.join(checkoutDir, relativeDirectory);
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = normalizeRepoPath(path.posix.join(relativeDirectory, entry.name));
      if (entry.isSymbolicLink()) {
        // Never follow repository-controlled symlinks. They are deliberately
        // outside the regular-file inventory. A test-shaped symlink could still
        // be executable, so only that case makes the inventory partial.
        if (isTestCandidatePath(relativePath)) {
          complete = false;
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (!TEST_DISCOVERY_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
          await walk(relativePath);
        }
        continue;
      }
      if (!entry.isFile() || !isTestCandidatePath(relativePath)) {
        continue;
      }
      if (shouldIncludePath(relativePath)) {
        paths.push(relativePath);
      } else if (!isBinaryPath(relativePath)) {
        // A test-like file was found but cannot be represented in the text
        // context. Do not claim that the inventory is complete.
        complete = false;
      }
    }
  }

  await walk("");
  return { paths, complete };
}

function scoreTestPath(candidate: string, changedPaths: string[]): number {
  let bestScore = 0;
  const candidateStem = testSubjectStem(candidate);
  const candidateDirectory = logicalSourceDirectory(candidate);
  const candidateTokens = meaningfulPathTokens(candidate);

  for (const changedPath of changedPaths) {
    if (candidate === changedPath) {
      return 10_000;
    }

    let relationScore = 0;
    const changedStem = testSubjectStem(changedPath);
    if (candidateStem && changedStem && candidateStem === changedStem) {
      relationScore += 4_000;
    }
    if (candidateDirectory === logicalSourceDirectory(changedPath)) {
      relationScore += 300;
    }

    const changedTokens = meaningfulPathTokens(changedPath);
    const sharedTokens = [...candidateTokens].filter((token) => changedTokens.has(token));
    relationScore += Math.min(sharedTokens.length, 4) * 250;
    bestScore = Math.max(bestScore, relationScore);
  }

  return bestScore;
}

async function scoreTestContent(
  checkoutDir: string,
  candidate: string,
  content: string,
  changedPaths: string[],
): Promise<number> {
  let bestScore = 0;
  const references = await resolveRepositoryReferences(checkoutDir, candidate, content);

  for (const changedPath of changedPaths) {
    if (references.has(changedPath)) {
      bestScore = Math.max(bestScore, 5_000);
      continue;
    }

    const extension = pathExtension(changedPath);
    const withoutExtension = extension ? changedPath.slice(0, -extension.length) : changedPath;
    if (content.includes(changedPath) || content.includes(withoutExtension)) {
      bestScore = Math.max(bestScore, 2_500);
      continue;
    }

    const stem = testSubjectStem(changedPath);
    if (stem && !GENERIC_TEST_SUBJECT_STEMS.has(stem) && new RegExp(`\\b${escapeRegExp(stem)}\\b`, "i").test(content)) {
      bestScore = Math.max(bestScore, 800);
    }
  }

  return bestScore;
}

const GENERIC_TEST_SUBJECT_STEMS = new Set([
  "app",
  "core",
  "index",
  "lib",
  "main",
  "service",
  "types",
  "utils",
]);

async function resolveRepositoryReferences(
  checkoutDir: string,
  sourcePath: string,
  content: string,
): Promise<Set<string>> {
  const references = new Set<string>();
  const directory = path.posix.dirname(sourcePath);
  const relativeMatches = content.matchAll(
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g,
  );
  for (const match of relativeMatches) {
    const specifier = match[1];
    if (!specifier) {
      continue;
    }
    const resolved = await resolveImportPath(checkoutDir, path.posix.join(directory, specifier));
    if (resolved) {
      references.add(resolved);
    }
  }

  for (const match of content.matchAll(/\b(?:preload|load)\s*\(\s*["']res:\/\/([^"']+)["']/g)) {
    const resolved = normalizeRepoPath(match[1] || "");
    if (resolved) {
      references.add(resolved);
    }
  }

  return references;
}

function testSubjectStem(filename: string): string {
  let basename = path.posix.basename(filename).toLowerCase();
  const extension = pathExtension(basename);
  if (extension) {
    basename = basename.slice(0, -extension.length);
  }
  return basename
    .replace(/\.(?:integration\.)?(?:test|spec)$/i, "")
    .replace(/^(?:test|spec)[_-]/i, "")
    .replace(/[_-](?:test|spec)$/i, "");
}

function logicalSourceDirectory(filename: string): string {
  const parts = path.posix.dirname(filename).split("/").filter(Boolean);
  return parts.filter((part) => !isTestDirectoryName(part.toLowerCase())).join("/");
}

function meaningfulPathTokens(filename: string): Set<string> {
  const ignored = new Set([
    "apps",
    "game",
    "gdscript",
    "godot",
    "gradle",
    "javascript",
    "java",
    "jsx",
    "kotlin",
    "mobile",
    "packages",
    "python",
    "ruby",
    "rust",
    "scala",
    "scripts",
    "src",
    "source",
    "swift",
    "test",
    "tests",
    "spec",
    "specs",
    "typescript",
    "tsx",
    "index",
    "main",
    "app",
    "web",
  ]);
  return new Set(
    filename
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !ignored.has(token)),
  );
}

function isTestCandidatePath(filename: string): boolean {
  const segments = filename.toLowerCase().split("/");
  const basename = segments.at(-1) || "";
  if (segments.slice(0, -1).some(isTestDirectoryName)) {
    return true;
  }
  return (
    /(?:^|[._-])(?:test|spec|smoke|probe|check|validate|verify|acceptance|regression|assert|gate)(?:[._-]|$)/i.test(basename) ||
    /(?:tests?|specs?)\.[^.]+$/i.test(basename) ||
    /(?:^|[_-])test_runner\.[^.]+$/i.test(basename)
  );
}

function isTestDirectoryName(segment: string): boolean {
  return TEST_DIRECTORY_NAMES.has(segment) || /(?:tests?|specs?)$/u.test(segment);
}

export function classifyChange(changedPaths: string[]): ChangeClass {
  if (changedPaths.length === 0) {
    return "other";
  }

  const substantive = new Set<Exclude<ChangeClass, "tests_only" | "mixed">>();
  let hasTests = false;
  for (const filename of changedPaths) {
    if (isTestCandidatePath(filename)) {
      hasTests = true;
    } else if (isConfigOrWorkflowPath(filename)) {
      substantive.add("config_or_workflow");
    } else if (isDocsOrAssetPath(filename)) {
      substantive.add("docs_assets");
    } else if (isSourcePath(filename)) {
      substantive.add("product_logic");
    } else {
      substantive.add("other");
    }
  }

  if (substantive.size === 0 && hasTests) {
    return "tests_only";
  }
  if (substantive.size === 1) {
    return [...substantive][0] || "other";
  }
  if (substantive.has("product_logic")) {
    return "mixed";
  }
  if (substantive.has("config_or_workflow")) {
    return "config_or_workflow";
  }
  if (substantive.has("other")) {
    return "other";
  }
  return "docs_assets";
}

function isConfigOrWorkflowPath(filename: string): boolean {
  const lower = filename.toLowerCase();
  const basename = path.posix.basename(filename).toLowerCase();
  return (
    lower.startsWith(".github/workflows/") ||
    lower.startsWith(".github/actions/") ||
    lower.startsWith("tools/") ||
    (lower.startsWith("scripts/") && /(?:^|[._-])(?:build|deploy|publish|release)(?:[._-]|$)/u.test(basename)) ||
    isConfigPath(filename) ||
    basename === "project.godot" ||
    basename === "export_presets.cfg" ||
    basename === "package.json" ||
    basename.endsWith("lock.yaml") ||
    basename.endsWith("lock.json")
  );
}

function isDocsOrAssetPath(filename: string): boolean {
  const lower = filename.toLowerCase();
  const basename = path.posix.basename(lower);
  return (
    lower.startsWith("docs/") ||
    lower.includes("/docs/") ||
    lower.startsWith("assets/") ||
    lower.includes("/assets/") ||
    lower.startsWith("generated/") ||
    lower.includes("/generated/") ||
    /(?:^|[._-])generated(?:[._-]|$)/u.test(basename) ||
    basename.startsWith("readme") ||
    [".md", ".mdx", ".tres", ".tscn"].includes(pathExtension(lower)) ||
    isBinaryPath(lower)
  );
}

function addSiblingContextFiles(selected: Set<string>, filename: string): void {
  const directory = path.posix.dirname(filename);
  if (!directory || directory === ".") {
    return;
  }

  for (const basename of ["index.ts", "index.tsx", "index.js", "index.jsx", "package.json"]) {
    selected.add(path.posix.join(directory, basename));
  }
}

async function addWorkflowContextFiles(
  selected: Set<string>,
  checkoutDir: string,
  workflowPath: string,
): Promise<void> {
  const content = await readTextFile(path.join(checkoutDir, workflowPath), 50_000);
  if (!content) {
    return;
  }

  const localActionMatches = content.matchAll(/uses:\s*["']?(\.\/\.github\/actions\/[^@\s"']+)/g);
  for (const match of localActionMatches) {
    const actionDir = normalizeRepoPath(match[1]?.replace(/^\.\//, "") || "");
    if (!actionDir) {
      continue;
    }
    selected.add(path.posix.join(actionDir, "action.yml"));
    selected.add(path.posix.join(actionDir, "action.yaml"));
    selected.add(path.posix.join(actionDir, "package.json"));
  }
}

async function addRelativeImportFiles(
  selected: Set<string>,
  checkoutDir: string,
  sourcePath: string,
): Promise<void> {
  const content = await readTextFile(path.join(checkoutDir, sourcePath), 50_000);
  if (!content) {
    return;
  }

  const directory = path.posix.dirname(sourcePath);
  const matches = content.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g);
  for (const match of matches) {
    const specifier = match[1];
    if (!specifier) {
      continue;
    }
    const resolved = await resolveImportPath(checkoutDir, path.posix.join(directory, specifier));
    if (resolved) {
      selected.add(resolved);
    }
  }
}

// GDScript pulls related files differently from JS/TS: `preload`/`load` with a
// res:// path, and autoload singletons referenced by their global class name (a
// heavy source of review false positives when the callee body is a different,
// unchanged file — e.g. DailyMissionSystem.progress()).
async function addGodotReferenceFiles(
  selected: Set<string>,
  checkoutDir: string,
  sourcePath: string,
  autoloads: Map<string, string>,
): Promise<void> {
  const content = await readTextFile(path.join(checkoutDir, sourcePath), 200_000);
  if (!content) {
    return;
  }

  for (const match of content.matchAll(/\b(?:preload|load)\s*\(\s*["']res:\/\/([^"']+)["']/g)) {
    const resolved = normalizeRepoPath(match[1] || "");
    if (resolved && (await isReadableContextFile(checkoutDir, resolved))) {
      selected.add(resolved);
    }
  }

  for (const [name, autoloadPath] of autoloads) {
    if (autoloadPath === sourcePath) {
      continue;
    }
    if (referencesGodotIdentifier(content, name) && (await isReadableContextFile(checkoutDir, autoloadPath))) {
      selected.add(autoloadPath);
    }
  }
}

// Parse the [autoload] section of project.godot into a name -> res-relative path
// map. Entries look like: DailyMissionSystem="*res://scripts/systems/daily_mission_system.gd".
async function readGodotAutoloads(checkoutDir: string): Promise<Map<string, string>> {
  const autoloads = new Map<string, string>();
  const content = await readTextFile(path.join(checkoutDir, "project.godot"), 200_000);
  if (!content) {
    return autoloads;
  }

  let inAutoloadSection = false;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inAutoloadSection = line === "[autoload]";
      continue;
    }
    if (!inAutoloadSection) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"\*?res:\/\/([^"]+)"/);
    if (match?.[1] && match[2]) {
      const resolved = normalizeRepoPath(match[2]);
      if (resolved.endsWith(".gd")) {
        autoloads.set(match[1], resolved);
      }
    }
  }

  return autoloads;
}

function referencesGodotIdentifier(content: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`).test(content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function resolveImportPath(checkoutDir: string, specifierPath: string): Promise<string | null> {
  const normalized = normalizeRepoPath(specifierPath);
  if (!normalized) {
    return null;
  }

  const candidates = pathExtension(normalized)
    ? [normalized]
    : [
        normalized,
        `${normalized}.ts`,
        `${normalized}.tsx`,
        `${normalized}.js`,
        `${normalized}.jsx`,
        `${normalized}.json`,
        path.posix.join(normalized, "index.ts"),
        path.posix.join(normalized, "index.tsx"),
        path.posix.join(normalized, "index.js"),
        path.posix.join(normalized, "index.jsx"),
      ];

  for (const candidate of candidates) {
    if (await isReadableContextFile(checkoutDir, candidate)) {
      return candidate;
    }
  }

  return null;
}

async function isReadableContextFile(checkoutDir: string, relativePath: string): Promise<boolean> {
  if (!shouldIncludePath(relativePath)) {
    return false;
  }

  try {
    const stat = await fs.stat(path.join(checkoutDir, relativePath));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function readTextFile(filePath: string, maxBytes: number): Promise<string | null> {
  if (maxBytes <= 0) {
    return null;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) {
      return null;
    }

    const buffer = await fs.readFile(filePath);
    const content = buffer.toString("utf8");
    if (looksBinary(content)) {
      return null;
    }
    return content;
  } catch {
    return null;
  }
}

function shouldIncludePath(relativePath: string): boolean {
  return (
    Boolean(relativePath) &&
    !relativePath.startsWith("../") &&
    !path.isAbsolute(relativePath) &&
    !relativePath.includes("/.git/") &&
    !relativePath.includes("/node_modules/") &&
    !relativePath.includes("/dist/") &&
    !relativePath.includes("/build/") &&
    !relativePath.includes("/coverage/") &&
    !isBinaryPath(relativePath) &&
    isLikelyTextPath(relativePath)
  );
}

function normalizeRepoPath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function isConfigPath(filename: string): boolean {
  const basename = path.posix.basename(filename).toLowerCase();
  return (
    DEFAULT_SUPPORT_FILES.includes(filename) ||
    basename.endsWith("config.js") ||
    basename.endsWith("config.mjs") ||
    basename.endsWith("config.ts") ||
    basename === "dockerfile"
  );
}

function isSourcePath(filename: string): boolean {
  return [
    ".cjs",
    ".c",
    ".cc",
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
  ].includes(pathExtension(filename));
}

function isGodotScriptPath(filename: string): boolean {
  return pathExtension(filename) === ".gd";
}

function isLikelyTextPath(filename: string): boolean {
  const basename = path.posix.basename(filename).toLowerCase();
  if (["dockerfile", "makefile", "license", "notice"].includes(basename)) {
    return true;
  }
  return Boolean(codeFenceLanguage(filename));
}

function isBinaryPath(filename: string): boolean {
  return BINARY_EXTENSIONS.has(pathExtension(filename));
}

function pathExtension(filename: string): string {
  const basename = path.posix.basename(filename).toLowerCase();
  const index = basename.lastIndexOf(".");
  return index >= 0 ? basename.slice(index) : "";
}

function codeFenceLanguage(filename: string): string {
  const basename = path.posix.basename(filename).toLowerCase();
  if (basename === "dockerfile") {
    return "dockerfile";
  }
  if (basename === "makefile") {
    return "makefile";
  }

  switch (pathExtension(filename)) {
    case ".cjs":
    case ".js":
    case ".mjs":
      return "javascript";
    case ".bats":
      return "bash";
    case ".css":
      return "css";
    case ".c":
    case ".cc":
    case ".cpp":
    case ".h":
    case ".hpp":
      return "cpp";
    case ".cs":
      return "csharp";
    case ".dart":
      return "dart";
    case ".gd":
      return "gdscript";
    case ".gdshader":
    case ".shader":
      return "glsl";
    case ".html":
      return "html";
    case ".json":
      return "json";
    case ".jsx":
      return "jsx";
    case ".go":
      return "go";
    case ".gradle":
      return "groovy";
    case ".java":
      return "java";
    case ".kt":
    case ".kts":
      return "kotlin";
    case ".md":
    case ".mdx":
      return "markdown";
    case ".lua":
      return "lua";
    case ".php":
      return "php";
    case ".py":
      return "python";
    case ".rb":
      return "ruby";
    case ".rules":
      return "javascript";
    case ".rs":
      return "rust";
    case ".scala":
      return "scala";
    case ".sh":
      return "bash";
    case ".ts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".txt":
      return "text";
    case ".swift":
      return "swift";
    case ".svelte":
      return "svelte";
    case ".toml":
      return "toml";
    case ".xml":
      return "xml";
    case ".vue":
      return "vue";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".cfg":
    case ".godot":
    case ".tres":
    case ".tscn":
      return "ini";
    default:
      return "";
  }
}

function looksBinary(value: string): boolean {
  return value.includes("\0") || (value.match(/\uFFFD/g) || []).length > 0;
}

async function git(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  try {
    await execFileAsync("git", args, {
      env,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(sanitizeError(error));
  }
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncate(message.replaceAll(/gh[opsu]_[A-Za-z0-9_]+/g, "[redacted-token]"), 500);
}
