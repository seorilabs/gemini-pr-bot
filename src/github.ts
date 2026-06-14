import type { Config } from "./config.js";
import { buildDeepRepoContext } from "./repo-context.js";
import { githubCommentBody, truncate } from "./text.js";

type Octokit = any;

export const REVIEW_AGENT_NAME = "Seori";
export const REVIEW_CHECK_NAME = "Seori Review";

const LEGACY_REVIEW_CHECK_NAME = "Gemini PR Bot";
const NO_ACTION_REQUIRED_MARKER_TEXT = "seorilabs-gemini-pr-bot:status=no-action-required";
const MERGE_CONFLICT_MARKER_TEXT = "seorilabs-gemini-pr-bot:status=merge-conflict";
const FAILING_CHECK_CONCLUSIONS = new Set(["action_required", "cancelled", "failure", "timed_out"]);
const MAX_CHANGED_FILE_CONTENT_CHARS = 20_000;
const MAX_CHANGED_FILE_CONTENT_CONTEXT_CHARS = 50_000;
const BINARY_FILE_EXTENSIONS = new Set([
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

export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required";

export type RepoRef = {
  owner: string;
  repo: string;
  fullName: string;
  isPrivate: boolean;
};

export type ReviewTrigger = {
  source: string;
  sender: string;
  request?: string;
};

export type PullRequestStatus = {
  state: string;
  merged: boolean;
  headSha: string;
  title: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  baseRef: string;
  headRef: string;
  baseRepoFullName: string;
  headRepoFullName: string;
  statusChecks: StatusCheckSummary;
};

export type PullRequestContext = PullRequestStatus & {
  markdown: string;
};

export type PullRequestContextOptions = {
  installationToken?: string;
  deepContextRequested?: boolean;
};

export type StatusCheckSummary = {
  markdown: string;
  failing: string[];
  pending: string[];
  total: number;
};

export function repoFromPayload(payload: any): RepoRef {
  return {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    fullName: payload.repository.full_name,
    isPrivate: Boolean(payload.repository.private),
  };
}

export function shouldHandleRepository(payload: any, config: Config): boolean {
  const repo = repoFromPayload(payload);
  if (repo.owner !== config.githubOrg) {
    return false;
  }

  if (!config.allowPublicRepos && !repo.isPrivate) {
    return false;
  }

  return true;
}

export function isTrustedAssociation(value: string | undefined, config: Config): boolean {
  return Boolean(value && config.trustedAssociations.has(value.toUpperCase()));
}

export async function isPullRequestIssue(octokit: Octokit, repo: RepoRef, issueNumber: number): Promise<boolean> {
  const { data } = await octokit.rest.issues.get({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: issueNumber,
  });
  return Boolean(data.pull_request);
}

export async function getPullRequestHeadSha(
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
): Promise<string> {
  return (await getPullRequestStatus(octokit, repo, prNumber)).headSha;
}

export async function getPullRequestStatus(
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
): Promise<PullRequestStatus> {
  const pr = await getPullRequestWithMergeability(octokit, repo, prNumber);
  const statusChecks = await buildStatusCheckSummary(octokit, repo, pr.head.sha);
  return {
    state: String(pr.state || "unknown"),
    merged: Boolean(pr.merged),
    headSha: pr.head.sha,
    title: pr.title,
    draft: Boolean(pr.draft),
    mergeable: pr.mergeable ?? null,
    mergeableState: String(pr.mergeable_state || "unknown"),
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    baseRepoFullName: pr.base.repo?.full_name || repo.fullName,
    headRepoFullName: pr.head.repo?.full_name || repo.fullName,
    statusChecks,
  };
}

async function paginate(octokit: Octokit, method: any, params: Record<string, unknown>) {
  return octokit.paginate(method, params);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getPullRequestWithMergeability(
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
): Promise<any> {
  let latest: any;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data: pr } = await octokit.rest.pulls.get({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
    });
    latest = pr;

    if (pr.mergeable !== null && pr.mergeable !== undefined) {
      return pr;
    }

    if (attempt < 3) {
      await delay(1_000);
    }
  }

  return latest;
}

export async function buildPullRequestContext(
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  config: Config,
  options: PullRequestContextOptions = {},
): Promise<PullRequestContext> {
  const pr = await getPullRequestWithMergeability(octokit, repo, prNumber);

  const [statusChecks, files, commits, issueComments, reviewComments, reviews] = await Promise.all([
    buildStatusCheckSummary(octokit, repo, pr.head.sha),
    paginate(octokit, octokit.rest.pulls.listFiles, {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      per_page: 100,
    }),
    paginate(octokit, octokit.rest.pulls.listCommits, {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      per_page: 100,
    }),
    paginate(octokit, octokit.rest.issues.listComments, {
      owner: repo.owner,
      repo: repo.repo,
      issue_number: prNumber,
      per_page: 100,
    }),
    paginate(octokit, octokit.rest.pulls.listReviewComments, {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      per_page: 100,
    }),
    paginate(octokit, octokit.rest.pulls.listReviews, {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      per_page: 100,
    }),
  ]);

  const fileSections: string[] = [];
  let patchChars = 0;
  for (const file of files) {
    const patch = file.patch || "(binary file or patch unavailable)";
    const section = [
      `### ${file.filename}`,
      `status=${file.status} additions=${file.additions} deletions=${file.deletions}`,
      "```diff",
      patch,
      "```",
    ].join("\n");

    if (patchChars + section.length > config.maxPatchChars) {
      const remaining = Math.max(0, config.maxPatchChars - patchChars);
      if (remaining > 500) {
        fileSections.push(truncate(section, remaining));
      }
      fileSections.push("...additional file patches omitted...");
      break;
    }

    fileSections.push(section);
    patchChars += section.length;
  }

  const changedFileContents = await buildChangedFileContents(octokit, repo, pr.head.sha, files);
  const deepRepoContext = await buildDeepRepoContext({
    repo,
    prNumber,
    headSha: pr.head.sha,
    files,
    config,
    installationToken: options.installationToken,
    requested: options.deepContextRequested,
  });

  const recentIssueComments = issueComments
    .slice(-50)
    .map((comment: any) => `- ${comment.user.login}: ${truncate(comment.body || "", 1000)}`)
    .join("\n");

  const recentReviewComments = reviewComments
    .slice(-50)
    .map((comment: any) => {
      const line = comment.line ?? comment.original_line ?? "?";
      return `- ${comment.user.login} on ${comment.path}:${line}: ${truncate(comment.body || "", 1000)}`;
    })
    .join("\n");

  const recentReviews = reviews
    .slice(-30)
    .map((review: any) => {
      const submittedAt = review.submitted_at || review.submittedAt || "unknown-time";
      const body = truncate(review.body || "", 700);
      return `- ${review.user?.login || "unknown"} ${review.state || "UNKNOWN"} at ${submittedAt}: ${body || "(empty)"}`;
    })
    .join("\n");

  const conversationState = buildConversationState(pr.head.sha, issueComments, reviewComments, reviews);

  const markdown = [
    "# Pull Request Context",
    "",
    `Repository: ${repo.fullName}`,
    `Repository private: ${repo.isPrivate}`,
    `Public repository handling: ${config.allowPublicRepos ? "allowed" : "disabled"}`,
    `Seorilabs ARC policy: private JS/TS lint, test, typecheck, and build jobs may use self-hosted ARC runners; public PR jobs must not.`,
    `Pull request: #${prNumber}`,
    `Title: ${pr.title}`,
    `Author: ${pr.user?.login || "unknown"}`,
    `State: ${pr.state || "unknown"}`,
    `Merged: ${Boolean(pr.merged)}`,
    `Draft: ${Boolean(pr.draft)}`,
    `Base: ${pr.base.repo?.full_name || repo.fullName}:${pr.base.ref}`,
    `Head: ${pr.head.repo?.full_name || repo.fullName}:${pr.head.ref}`,
    `Head SHA: ${pr.head.sha}`,
    `GitHub mergeable: ${pr.mergeable ?? "unknown"}`,
    `GitHub mergeable_state: ${pr.mergeable_state || "unknown"}`,
    "",
    "## Status Checks",
    statusChecks.markdown,
    "",
    "## Conversation State",
    conversationState,
    "",
    "## PR Body",
    pr.body || "(empty)",
    "",
    "## Commits",
    commits.map((commit: any) => `- ${commit.sha.slice(0, 7)} ${commit.commit.message.split("\n")[0]}`).join("\n") ||
      "(none)",
    "",
    "## Recent Reviews",
    recentReviews || "(none)",
    "",
    "## Recent PR Comments",
    recentIssueComments || "(none)",
    "",
    "## Recent Review Comments",
    recentReviewComments || "(none)",
    "",
    "## Current Changed File Contents",
    "These sections show the post-change HEAD contents for small changed text files. Use them to verify final state when a diff hunk is abbreviated or ambiguous.",
    changedFileContents || "(none)",
    "",
    "## Deep Repository Context",
    "This section is built from a shallow clone when deep context is enabled. It contains selected related files only, not the whole repository.",
    deepRepoContext || "(none)",
    "",
    "## Changed Files",
    fileSections.join("\n\n") || "(none)",
  ].join("\n");

  return {
    state: String(pr.state || "unknown"),
    merged: Boolean(pr.merged),
    headSha: pr.head.sha,
    title: pr.title,
    draft: Boolean(pr.draft),
    mergeable: pr.mergeable ?? null,
    mergeableState: String(pr.mergeable_state || "unknown"),
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    baseRepoFullName: pr.base.repo?.full_name || repo.fullName,
    headRepoFullName: pr.head.repo?.full_name || repo.fullName,
    statusChecks,
    markdown: truncate(markdown, config.maxContextChars),
  };
}

async function buildChangedFileContents(
  octokit: Octokit,
  repo: RepoRef,
  headSha: string,
  files: any[],
): Promise<string> {
  const sections: string[] = [];
  let contextChars = 0;

  for (const file of files) {
    if (!shouldFetchChangedFileContent(file)) {
      continue;
    }

    const section = await buildChangedFileContentSection(octokit, repo, headSha, file);
    if (!section) {
      continue;
    }

    if (contextChars + section.length > MAX_CHANGED_FILE_CONTENT_CONTEXT_CHARS) {
      sections.push("...additional current file contents omitted...");
      break;
    }

    sections.push(section);
    contextChars += section.length;
  }

  return sections.join("\n\n");
}

function shouldFetchChangedFileContent(file: any): boolean {
  const filename = String(file.filename || "");
  const status = String(file.status || "");
  if (!filename || status === "removed" || status === "deleted") {
    return false;
  }
  if (isLikelyBinaryPath(filename)) {
    return false;
  }

  return typeof file.patch === "string" || isLikelyTextPath(filename);
}

async function buildChangedFileContentSection(
  octokit: Octokit,
  repo: RepoRef,
  headSha: string,
  file: any,
): Promise<string | null> {
  const filename = String(file.filename || "");
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: repo.owner,
      repo: repo.repo,
      path: filename,
      ref: headSha,
    });
    if (Array.isArray(data) || data.type !== "file") {
      return null;
    }

    const size = Number(data.size || 0);
    if (size > MAX_CHANGED_FILE_CONTENT_CHARS) {
      return [
        `### ${filename}`,
        `status=${file.status} current_head_size=${size}`,
        `current HEAD content omitted because it exceeds ${MAX_CHANGED_FILE_CONTENT_CHARS} characters`,
      ].join("\n");
    }

    const encoded = typeof data.content === "string" ? data.content : "";
    const content = Buffer.from(encoded.replace(/\n/g, ""), "base64").toString("utf8");
    if (!content || looksBinary(content)) {
      return null;
    }

    return [
      `### ${filename}`,
      `status=${file.status} additions=${file.additions} deletions=${file.deletions} current_head_size=${size}`,
      `\`\`\`\`${codeFenceLanguage(filename)}`,
      content.trimEnd(),
      "````",
    ].join("\n");
  } catch (error) {
    return [
      `### ${filename}`,
      `status=${file.status}`,
      `current HEAD content unavailable: ${truncate(errorMessage(error), 300)}`,
    ].join("\n");
  }
}

function isLikelyBinaryPath(path: string): boolean {
  const extension = pathExtension(path);
  return BINARY_FILE_EXTENSIONS.has(extension);
}

function isLikelyTextPath(path: string): boolean {
  const basename = path.split("/").pop()?.toLowerCase() || "";
  if (["dockerfile", "makefile", "license", "notice"].includes(basename)) {
    return true;
  }

  return Boolean(codeFenceLanguage(path));
}

function pathExtension(path: string): string {
  const basename = path.split("/").pop()?.toLowerCase() || "";
  const index = basename.lastIndexOf(".");
  return index >= 0 ? basename.slice(index) : "";
}

function codeFenceLanguage(path: string): string {
  const basename = path.split("/").pop()?.toLowerCase() || "";
  if (basename === "dockerfile") {
    return "dockerfile";
  }
  if (basename === "makefile") {
    return "makefile";
  }

  switch (pathExtension(path)) {
    case ".cjs":
    case ".js":
    case ".mjs":
      return "javascript";
    case ".css":
      return "css";
    case ".html":
      return "html";
    case ".json":
      return "json";
    case ".jsonl":
      return "jsonl";
    case ".jsx":
      return "jsx";
    case ".md":
      return "markdown";
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
    default:
      return "";
  }
}

function looksBinary(value: string): boolean {
  return value.includes("\0") || (value.match(/\uFFFD/g) || []).length > 0;
}

export async function isReviewThreadResolved(
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  commentDatabaseId: number,
): Promise<boolean> {
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!, $after: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100, after: $after) {
            nodes {
              isResolved
              comments(first: 100) {
                nodes {
                  databaseId
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  `;

  let after: string | null = null;
  do {
    const result: any = await octokit.graphql(query, {
      owner: repo.owner,
      repo: repo.repo,
      prNumber,
      after,
    });
    const threads = result.repository?.pullRequest?.reviewThreads;
    for (const thread of threads?.nodes || []) {
      const containsComment = (thread.comments?.nodes || []).some(
        (comment: any) => Number(comment.databaseId) === Number(commentDatabaseId),
      );
      if (containsComment) {
        return Boolean(thread.isResolved);
      }
    }

    after = threads?.pageInfo?.hasNextPage ? threads.pageInfo.endCursor : null;
  } while (after);

  return false;
}

export async function createInProgressCheck(
  octokit: Octokit,
  repo: RepoRef,
  headSha: string,
): Promise<number | null> {
  try {
    const { data } = await octokit.rest.checks.create({
      owner: repo.owner,
      repo: repo.repo,
      name: REVIEW_CHECK_NAME,
      head_sha: headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
      output: {
        title: `${REVIEW_AGENT_NAME}가 리뷰 중입니다`,
        summary: `${REVIEW_AGENT_NAME}가 PR 맥락을 검토하고 있습니다.`,
      },
    });
    return data.id;
  } catch {
    return null;
  }
}

export async function updateInProgressCheck(
  octokit: Octokit,
  repo: RepoRef,
  checkRunId: number | null,
  title: string,
  summary: string,
): Promise<void> {
  if (!checkRunId) {
    return;
  }

  await octokit.rest.checks.update({
    owner: repo.owner,
    repo: repo.repo,
    check_run_id: checkRunId,
    status: "in_progress",
    output: {
      title,
      summary: truncate(summary, 65000),
    },
  });
}

async function buildStatusCheckSummary(
  octokit: Octokit,
  repo: RepoRef,
  headSha: string,
): Promise<StatusCheckSummary> {
  const failing: string[] = [];
  const pending: string[] = [];
  const lines: string[] = [];
  let total = 0;

  const [checkRunsResult, statusesResult] = await Promise.allSettled([
    octokit.rest.checks.listForRef({
      owner: repo.owner,
      repo: repo.repo,
      ref: headSha,
      per_page: 100,
    }),
    octokit.rest.repos.listCommitStatusesForRef({
      owner: repo.owner,
      repo: repo.repo,
      ref: headSha,
      per_page: 100,
    }),
  ]);

  if (checkRunsResult.status === "fulfilled") {
    const checkRuns = checkRunsResult.value.data.check_runs || [];
    for (const run of checkRuns) {
      if (isOwnReviewCheck(run.name)) {
        continue;
      }

      total += 1;
      const state = run.status === "completed" ? run.conclusion || "unknown" : run.status || "unknown";
      const name = `check:${run.name}`;
      lines.push(`- ${name}: ${state}`);
      if (run.status !== "completed") {
        pending.push(`${name} (${state})`);
      } else if (FAILING_CHECK_CONCLUSIONS.has(String(run.conclusion || "").toLowerCase())) {
        failing.push(`${name} (${state})`);
      }
    }
  } else {
    lines.push(`- check-runs: unable to read (${errorMessage(checkRunsResult.reason)})`);
  }

  if (statusesResult.status === "fulfilled") {
    const latestStatuses = latestCommitStatuses(statusesResult.value.data || []);
    for (const status of latestStatuses) {
      const name = `status:${status.context || "unknown"}`;
      const state = String(status.state || "unknown").toLowerCase();
      total += 1;
      lines.push(`- ${name}: ${state}${status.description ? ` - ${truncate(status.description, 200)}` : ""}`);
      if (["error", "failure"].includes(state)) {
        failing.push(`${name} (${state})`);
      } else if (state === "pending") {
        pending.push(`${name} (${state})`);
      }
    }
  } else {
    lines.push(
      [
        "- commit-statuses: unavailable to this installation",
        `(${errorMessage(statusesResult.reason)}).`,
        "Grant Commit statuses read permission if legacy commit status contexts must be considered.",
      ].join(" "),
    );
  }

  if (lines.length === 0) {
    lines.push("(none)");
  }

  return {
    markdown: lines.join("\n"),
    failing,
    pending,
    total,
  };
}

function latestCommitStatuses(statuses: any[]): any[] {
  const byContext = new Map<string, any>();
  for (const status of statuses) {
    const context = status.context || "unknown";
    if (!byContext.has(context)) {
      byContext.set(context, status);
    }
  }
  return [...byContext.values()];
}

function buildConversationState(headSha: string, issueComments: any[], reviewComments: any[], reviews: any[]): string {
  const bodies = [
    ...issueComments.map((comment: any) => comment.body || ""),
    ...reviewComments.map((comment: any) => comment.body || ""),
    ...reviews.map((review: any) => review.body || ""),
  ];
  const currentNoActionMarkers = bodies.filter((body) =>
    body.includes(NO_ACTION_REQUIRED_MARKER_TEXT) && body.includes(`head=${headSha}`),
  ).length;
  const staleNoActionMarkers = bodies.filter((body) =>
    body.includes(NO_ACTION_REQUIRED_MARKER_TEXT) && !body.includes(`head=${headSha}`),
  ).length;
  const currentMergeConflictMarkers = bodies.filter((body) =>
    body.includes(MERGE_CONFLICT_MARKER_TEXT) && body.includes(`head=${headSha}`),
  ).length;

  return [
    `Current no-action marker count: ${currentNoActionMarkers}`,
    `Stale no-action marker count: ${staleNoActionMarkers}`,
    `Current merge-conflict marker count: ${currentMergeConflictMarkers}`,
    `Total PR comments considered: ${issueComments.length}`,
    `Total review comments considered: ${reviewComments.length}`,
    `Total reviews considered: ${reviews.length}`,
  ].join("\n");
}

function isOwnReviewCheck(name: string | undefined): boolean {
  return name === REVIEW_CHECK_NAME || name === LEGACY_REVIEW_CHECK_NAME;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function completeCheck(
  octokit: Octokit,
  repo: RepoRef,
  checkRunId: number | null,
  conclusion: CheckConclusion,
  title: string,
  summary: string,
): Promise<void> {
  if (!checkRunId) {
    return;
  }

  await octokit.rest.checks.update({
    owner: repo.owner,
    repo: repo.repo,
    check_run_id: checkRunId,
    status: "completed",
    conclusion,
    completed_at: new Date().toISOString(),
    output: {
      title,
      summary: truncate(summary, 65000),
    },
  });
}

export async function approvePullRequest(
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  body: string,
  headSha: string,
): Promise<void> {
  await octokit.rest.pulls.createReview({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
    commit_id: headSha,
    event: "APPROVE",
    body: githubCommentBody(body),
  });
}

export async function requestChangesPullRequest(
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  body: string,
  headSha: string,
): Promise<void> {
  await octokit.rest.pulls.createReview({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
    commit_id: headSha,
    event: "REQUEST_CHANGES",
    body: githubCommentBody(body),
  });
}

export async function closePullRequest(
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
): Promise<void> {
  await octokit.rest.pulls.update({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
    state: "closed",
  });
}

export async function postPrComment(
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  body: string,
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: prNumber,
    body: githubCommentBody(body),
  });
}

export async function postReviewCommentReply(
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  commentId: number,
  body: string,
): Promise<void> {
  await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies", {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
    comment_id: commentId,
    body: githubCommentBody(body),
  });
}
