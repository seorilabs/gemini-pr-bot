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

export type DeepRepoContextInput = {
  repo: RepoRef;
  prNumber: number;
  headSha: string;
  files: any[];
  config: Config;
  installationToken?: string;
  requested?: boolean;
};

export async function buildDeepRepoContext(input: DeepRepoContextInput): Promise<string> {
  if (!shouldBuildDeepRepoContext(input)) {
    return "";
  }
  if (!input.installationToken) {
    return "Deep repository context skipped: installation token unavailable.";
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seori-pr-context-"));
  const askpassPath = path.join(root, "git-askpass.sh");
  const checkoutDir = path.join(root, "repo");
  try {
    await writeAskpass(askpassPath);
    await clonePullRequestHead(input, checkoutDir, askpassPath);
    return await collectRepositoryContext(input, checkoutDir);
  } catch (error) {
    return `Deep repository context unavailable: ${sanitizeError(error)}`;
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

async function collectRepositoryContext(input: DeepRepoContextInput, checkoutDir: string): Promise<string> {
  const selected = await selectContextFiles(input, checkoutDir);
  const sections: string[] = [
    "Deep repository context source: shallow clone of PR HEAD.",
    `Selected context files: ${selected.length}`,
  ];
  let totalBytes = sections.join("\n").length;

  for (const relativePath of selected) {
    const filePath = path.join(checkoutDir, relativePath);
    const content = await readTextFile(filePath, input.config.deepRepoContextMaxBytes - totalBytes);
    if (!content) {
      continue;
    }

    const section = [
      `### ${relativePath}`,
      `\`\`\`\`${codeFenceLanguage(relativePath)}`,
      content.trimEnd(),
      "````",
    ].join("\n");
    if (totalBytes + section.length > input.config.deepRepoContextMaxBytes) {
      sections.push("...additional deep repository context omitted...");
      break;
    }

    sections.push(section);
    totalBytes += section.length;
  }

  return sections.join("\n\n");
}

async function selectContextFiles(input: DeepRepoContextInput, checkoutDir: string): Promise<string[]> {
  const selected = new Set<string>();

  for (const file of input.files) {
    const filename = normalizeRepoPath(String(file.filename || ""));
    if (filename && shouldIncludePath(filename)) {
      selected.add(filename);
      addSiblingContextFiles(selected, filename);
    }
  }

  for (const file of DEFAULT_SUPPORT_FILES) {
    selected.add(file);
  }

  const godotAutoloads = await readGodotAutoloads(checkoutDir);
  for (const file of [...selected]) {
    if (file.startsWith(".github/workflows/")) {
      await addWorkflowContextFiles(selected, checkoutDir, file);
    }
    if (isGodotScriptPath(file)) {
      await addGodotReferenceFiles(selected, checkoutDir, file, godotAutoloads);
    } else if (isSourcePath(file)) {
      await addRelativeImportFiles(selected, checkoutDir, file);
    }
  }

  const existing = [];
  for (const file of selected) {
    if (existing.length >= input.config.deepRepoContextMaxFiles) {
      break;
    }
    if (await isReadableContextFile(checkoutDir, file)) {
      existing.push(file);
    }
  }

  return existing;
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
  return [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".gd"].includes(pathExtension(filename));
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
    case ".css":
      return "css";
    case ".cs":
      return "csharp";
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
    case ".md":
      return "markdown";
    case ".py":
      return "python";
    case ".sh":
      return "bash";
    case ".ts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".txt":
      return "text";
    case ".xml":
      return "xml";
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
