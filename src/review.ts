import { createHash } from "node:crypto";

export type Severity = "critical" | "high" | "medium" | "low";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

const SEVERITY_SET = new Set<Severity>(SEVERITY_ORDER);

// Categories that represent "allow the next change / refactoring" work rather than
// an immediate defect. Only these become offloaded GitHub follow-up issues.
const OFFLOADABLE_CATEGORIES = new Set([
  "refactor",
  "refactoring",
  "future-improvement",
  "future",
  "maintainability",
  "tech-debt",
  "cleanup",
]);

export type RawFinding = {
  slug?: string;
  file?: string | null;
  line?: number | null;
  severity?: string;
  category?: string;
  title?: string;
  impact?: string;
  fix?: string;
};

export type StructuredReview = {
  acceptanceCriteria: string[];
  findings: RawFinding[];
};

export type Finding = {
  fingerprint: string;
  slug: string;
  file: string | null;
  line: number | null;
  severity: Severity;
  category: string;
  title: string;
  impact: string;
  fix: string;
};

export type ConvergenceKind = "new" | "regression" | "carried";

export type ClassifiedFinding = Finding & {
  convergence: ConvergenceKind;
};

// Mirrors a row of gemini_pr_bot_review_findings.
export type StoredFinding = {
  fingerprint: string;
  severity: string;
  category: string;
  file: string | null;
  title: string;
  status: "open" | "resolved";
  reviewCommentId: number | null;
  threadNodeId: string | null;
  issueNumber: number | null;
  firstSeenHead: string;
  lastSeenHead: string;
};

export type ConvergenceResult = {
  classified: ClassifiedFinding[];
  resolved: StoredFinding[];
};

export function normalizeSeverity(value: string | undefined): Severity {
  const normalized = String(value || "").trim().toLowerCase();
  if (SEVERITY_SET.has(normalized as Severity)) {
    return normalized as Severity;
  }
  if (["blocker", "fatal", "severe"].includes(normalized)) {
    return "critical";
  }
  if (["major", "important"].includes(normalized)) {
    return "high";
  }
  if (["minor", "nit", "trivial", "info", "informational"].includes(normalized)) {
    return "low";
  }
  // Unknown severities default to medium ("neutral") rather than dropping the finding.
  return "medium";
}

function normalizeForFingerprint(value: string): string {
  return value
    .toLowerCase()
    .replace(/`[^`]*`/g, " ") // drop inline code quotes
    .replace(/:\d+\b/g, " ") // drop line-number suffixes like file.ts:42
    .replace(/\b\d+\b/g, " ") // drop bare numbers
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function fingerprintFinding(file: string | null | undefined, title: string): string {
  const key = `${normalizeForFingerprint(String(file || "nofile"))}::${normalizeForFingerprint(title)}`;
  return createHash("sha1").update(key).digest("hex");
}

// Defensive JSON extraction: providers may wrap the object in prose or code fences.
export function parseStructuredReview(text: string): StructuredReview | null {
  const candidate = extractJsonObject(text);
  if (!candidate) {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    try {
      parsed = JSON.parse(sanitizeJsonCandidate(candidate));
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const findingsRaw = Array.isArray(parsed.findings) ? parsed.findings : [];
  const acceptanceRaw = Array.isArray(parsed.acceptance_criteria)
    ? parsed.acceptance_criteria
    : Array.isArray(parsed.acceptanceCriteria)
      ? parsed.acceptanceCriteria
      : [];

  return {
    acceptanceCriteria: acceptanceRaw.map((item: unknown) => String(item || "").trim()).filter(Boolean),
    findings: findingsRaw.filter((item: unknown) => item && typeof item === "object") as RawFinding[],
  };
}

// Best-effort repair for almost-JSON that some providers emit: strip // and
// /* */ comments and trailing commas. String contents (e.g. "https://...") are
// left untouched by tracking string/escape state instead of using regexes.
function sanitizeJsonCandidate(candidate: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i];
    const next = candidate[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < candidate.length && candidate[i] !== "\n") {
        i += 1;
      }
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < candidate.length && !(candidate[i] === "*" && candidate[i + 1] === "/")) {
        i += 1;
      }
      i += 1; // skip the closing '/'
      continue;
    }
    out += ch;
  }

  // Remove trailing commas before } or ] (outside strings the simple regex is safe
  // here because comments are already gone).
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function extractJsonObject(text: string): string | null {
  const withoutFences = text.replace(/```(?:json|jsonc)?/gi, "```");
  const fenceMatch = withoutFences.match(/```\s*([\s\S]*?)```/);
  const body = fenceMatch ? fenceMatch[1] : withoutFences;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return body.slice(start, end + 1);
}

export function toFindings(raw: RawFinding[]): Finding[] {
  const byFingerprint = new Map<string, Finding>();
  for (const item of raw) {
    const title = String(item.title || "").trim();
    if (!title) {
      continue;
    }
    const file = item.file ? String(item.file).trim() : null;
    const fingerprint = fingerprintFinding(file, title);
    if (byFingerprint.has(fingerprint)) {
      continue; // collapse duplicate findings within one turn
    }
    byFingerprint.set(fingerprint, {
      fingerprint,
      slug: String(item.slug || "").trim(),
      file,
      line: normalizeLine(item.line),
      severity: normalizeSeverity(item.severity),
      category: String(item.category || "").trim().toLowerCase() || "correctness",
      title,
      impact: String(item.impact || "").trim(),
      fix: String(item.fix || "").trim(),
    });
  }
  return [...byFingerprint.values()];
}

function normalizeLine(value: number | null | undefined): number | null {
  const line = Number(value);
  return Number.isInteger(line) && line > 0 ? line : null;
}

export function classifyConvergence(
  current: Finding[],
  prior: StoredFinding[],
  changedFiles: Set<string>,
): ConvergenceResult {
  const priorOpen = prior.filter((finding) => finding.status === "open");
  const priorByFingerprint = new Map(priorOpen.map((finding) => [finding.fingerprint, finding]));
  const currentByFingerprint = new Map(current.map((finding) => [finding.fingerprint, finding]));

  const classified: ClassifiedFinding[] = current.map((finding) => {
    if (priorByFingerprint.has(finding.fingerprint)) {
      return { ...finding, convergence: "carried" };
    }
    const isRegression = Boolean(finding.file && changedFiles.has(finding.file));
    return { ...finding, convergence: isRegression ? "regression" : "new" };
  });

  // A prior open finding is considered resolved only when it disappeared AND its
  // file actually changed this turn. Otherwise it is likely an LLM omission, so we
  // keep it open silently instead of falsely claiming it was fixed.
  const resolved = priorOpen.filter(
    (finding) =>
      !currentByFingerprint.has(finding.fingerprint) &&
      Boolean(finding.file && changedFiles.has(finding.file)),
  );

  return { classified, resolved };
}

export function isOffloadable(finding: Finding): boolean {
  return (
    (finding.severity === "medium" || finding.severity === "low") &&
    OFFLOADABLE_CATEGORIES.has(finding.category)
  );
}

export function isBlocking(finding: Finding, blockOnMedium: boolean): boolean {
  if (finding.severity === "critical" || finding.severity === "high") {
    return true;
  }
  return blockOnMedium && finding.severity === "medium";
}

// Right-side (new file) line numbers that exist in the unified diff and can anchor
// an inline review comment.
export function parseAnchorableLines(patch: string | null | undefined): Set<number> {
  const lines = new Set<number>();
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
      continue; // removed line: left side only
    }
    if (row.startsWith("+") || row.startsWith(" ")) {
      lines.add(newLine);
      newLine += 1;
      continue;
    }
    if (row.startsWith("\\")) {
      continue; // "\ No newline at end of file"
    }
    // Any other line ends the hunk body.
    inHunk = false;
  }

  return lines;
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};
