import type { Config } from "./config.js";
import { buildDeepRepoContext, classifyChange, type ChangeClass } from "./repo-context.js";
import { isNonProductFatalPath } from "./review-grounding.js";
import { githubCommentBody, truncate } from "./text.js";
import {
  bodyIncludesBotStatusMarker,
  isBotGithubAuthor,
} from "./identity.js";

type Octokit = any;

export const REVIEW_AGENT_NAME = "Seori";
export const REVIEW_CHECK_NAME = "Seori Review";

const LEGACY_REVIEW_CHECK_NAME = "Gemini PR Bot";
const FAILING_CHECK_CONCLUSIONS = new Set(["action_required", "cancelled", "failure", "timed_out"]);
const MAX_CHANGED_FILE_CONTENT_CHARS = 20_000;
const MAX_CHANGED_FILE_CONTENT_CONTEXT_CHARS = 50_000;
const MAX_REVIEW_GATE_PATCH_CHARS = 60_000;
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
  reviewGateMarkdown: string;
  acceptanceSourceText: string;
  testInventoryComplete: boolean;
  testInventoryFileCount: number;
  currentHeadFileContents: Readonly<Record<string, string>>;
  visibleChangedPatches: Readonly<Record<string, string>>;
  /** True when every changed product path has a visible patch and complete review evidence. */
  fatalContextComplete: boolean;
  changeClass: ChangeClass;
  minimumAcceptanceCriteria: number;
  explicitAcceptanceCriteria: readonly string[];
  reviewFollowUp: ReviewFollowUpContext;
};

export type ReviewFollowUpContext = {
  /** One-based review turn. A PR without a prior published Seori result is turn 1. */
  reviewRound: number;
  previousReviewHeadSha: string | null;
  previousReviewBody: string;
  previousReviewAt: string | null;
  contributorResponses: string;
  changesSincePreviousReview: string;
  changesSincePreviousReviewComplete: boolean;
};

export type PullRequestContextOptions = {
  installationToken?: string;
  deepContextRequested?: boolean;
  reviewGatePromptReserveChars?: number;
};

type ChangedFileContentEvidence = {
  filename: string;
  content: string | null;
  section: string;
  /** True when the model sees the full file or every changed-hunk window. */
  contextComplete: boolean;
};

type ChangedFileContentResult = {
  markdown: string;
  evidence: ChangedFileContentEvidence[];
};

type LargeFileDigest = {
  markdown: string;
  changedRegionsComplete: boolean;
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

  const publicRepoAllowed =
    config.publicRepositoryAllowlist.has(repo.fullName.toLowerCase()) ||
    config.publicRepositoryAllowlist.has(repo.repo.toLowerCase());

  if (!config.allowPublicRepos && !repo.isPrivate && !publicRepoAllowed) {
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
  const completeFilePatchSections: Array<{ filename: string; patch: string; section: string }> = [];
  let patchChars = 0;
  // Product patches are the fatal-gate source of truth, so keep them ahead of
  // docs/tests when the bounded patch budget cannot include every file.
  for (const file of prioritizeChangedFilesForContext(files)) {
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
    completeFilePatchSections.push({ filename: String(file.filename), patch, section });
    patchChars += section.length;
  }

  const changedFileContentResult = await buildChangedFileContents(octokit, repo, pr.head.sha, files);
  const changedFileContents = changedFileContentResult.markdown;
  const deepRepoContextResult = await buildDeepRepoContext({
    repo,
    prNumber,
    headSha: pr.head.sha,
    files,
    config,
    installationToken: options.installationToken,
    requested: options.deepContextRequested,
  });
  const deepRepoContext = deepRepoContextResult.markdown;
  const testInventoryFileCount = Number(
    deepRepoContext.match(/^Test inventory discovered:\s*(\d+)$/mu)?.[1] || 0,
  );

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
  const reviewFollowUpHistory = buildReviewFollowUpHistory(
    issueComments,
    reviewComments,
    reviews,
  );
  const followUpChanges = await buildChangesSincePreviousReview(
    octokit,
    repo,
    pr.head.sha,
    commits,
    reviewFollowUpHistory.previousReviewHeadSha,
  );
  const reviewFollowUp: ReviewFollowUpContext = {
    ...reviewFollowUpHistory,
    changesSincePreviousReview: followUpChanges.markdown,
    changesSincePreviousReviewComplete: followUpChanges.complete,
  };
  const trustedAcceptanceSources = buildTrustedAcceptanceSourceText(
    pr,
    issueComments,
    reviewComments,
    reviews,
    config,
  );
  const acceptanceSourceText = trustedAcceptanceSources.text;
  const isFollowUpReview = reviewFollowUp.reviewRound > 1;
  const incrementalReviewFiles = isFollowUpReview ? followUpChanges.files : files;
  const reviewPatchSections = isFollowUpReview
    ? followUpChanges.sections
    : completeFilePatchSections;
  const reviewFileNames = new Set(
    incrementalReviewFiles.map((file: any) => String(file.filename || "")),
  );
  if (isFollowUpReview) {
    for (const filename of reviewReferencedChangedPaths(reviewFollowUp, files)) {
      reviewFileNames.add(filename);
    }
  }
  const changeClass = classifyChange(
    incrementalReviewFiles.map((file: any) => String(file.filename || "")),
  );
  const gateChangedFilePatches = truncate(
    reviewPatchSections.map(({ section }) => section).join("\n\n") || "(none)",
    Math.min(config.maxPatchChars, MAX_REVIEW_GATE_PATCH_CHARS),
  );
  const gateChangedFileContents = changedFileContentResult.evidence
    .filter(({ filename }) => !isFollowUpReview || reviewFileNames.has(filename))
    .map(({ section }) => section)
    .join("\n\n") || "(none)";
  const followUpChangeSummary = isFollowUpReview && followUpChanges.files.length > 0
    ? `${followUpChanges.files.length} file(s) changed since the previous Seori result. Exact incremental patches are in the Changed Files section below.`
    : reviewFollowUp.changesSincePreviousReview;

  const markdown = [
    "# Pull Request Context",
    "",
    `Repository: ${repo.fullName}`,
    `Repository private: ${repo.isPrivate}`,
    `Public repository handling: ${config.allowPublicRepos ? "allowed" : "disabled except allowlist"}`,
    `Seorilabs ARC policy: private JS/TS lint, test, typecheck, and build jobs may use self-hosted ARC runners; public PR jobs must not.`,
    `Pull request: #${prNumber}`,
    `Title: ${pr.title}`,
    `Author: ${pr.user?.login || "unknown"}`,
    `State: ${pr.state || "unknown"}`,
    `Merged: ${Boolean(pr.merged)}`,
    `Draft: ${Boolean(pr.draft)}`,
    `Base: ${pr.base.repo?.full_name || repo.fullName}:${pr.base.ref}`,
    `Head: ${pr.head.repo?.full_name || repo.fullName}:${pr.head.ref}`,
    `Change class: ${changeClass}`,
    `Minimum explicit acceptance criteria: ${trustedAcceptanceSources.minimumCriteria}`,
    `Head SHA: ${pr.head.sha}`,
    `GitHub mergeable: ${pr.mergeable ?? "unknown"}`,
    `GitHub mergeable_state: ${pr.mergeable_state || "unknown"}`,
    "Merge gate note: `mergeable_state: blocked` can be caused by pending required checks/reviews, including the current Seori Review gate. Treat only explicit failing checks listed below as review findings; the bot's own Seori Review check is omitted from Status Checks.",
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

  // The conservative merge gate includes only the latest published Seori
  // result, the Contributor responses after it, and the incremental compare
  // diff. Older bot prose remains excluded so stale findings do not anchor the
  // next review or reopen already settled scope.
  const reviewGateMarkdown = [
    "# Pull Request Merge Gate Context",
    "",
    `Repository: ${repo.fullName}`,
    `Pull request: #${prNumber}`,
    `Title: ${pr.title}`,
    `Head SHA: ${pr.head.sha}`,
    `Base: ${pr.base.repo?.full_name || repo.fullName}:${pr.base.ref}`,
    `Head: ${pr.head.repo?.full_name || repo.fullName}:${pr.head.ref}`,
    `Change class: ${changeClass}`,
    `Minimum explicit acceptance criteria: ${trustedAcceptanceSources.minimumCriteria}`,
    "",
    "## Status Checks",
    statusChecks.markdown,
    "",
    "## Trusted Acceptance Sources",
    "Acceptance criteria and source_quote values may be derived ONLY from this section.",
    acceptanceSourceText,
    "",
    "## Review Turn Context",
    `review_round: ${reviewFollowUp.reviewRound}`,
    `previous_review_head: ${reviewFollowUp.previousReviewHeadSha || "(none - first review turn)"}`,
    "",
    "### Previous Seori Result",
    reviewFollowUp.previousReviewBody || "(none - first review turn)",
    "",
    "### Contributor Responses Since Previous Seori Result",
    reviewFollowUp.contributorResponses || "(none)",
    "",
    "### Changes Since Previous Seori Result",
    followUpChangeSummary,
    "",
    "## Changed Files",
    gateChangedFilePatches,
    "",
    "## Current Changed File Contents",
    "Product files are prioritized. Large files contain every changed-hunk window plus a bounded symbol outline instead of the full body.",
    gateChangedFileContents,
    "",
    "## Deep Repository Context",
    "This is selected current-HEAD evidence, not necessarily the whole repository.",
    deepRepoContext || "(none)",
  ].join("\n");
  const reviewGateContextBudget = Math.max(
    0,
    config.maxContextChars - Math.max(0, options.reviewGatePromptReserveChars || 16_000),
  );
  const truncatedReviewGateMarkdown = truncate(reviewGateMarkdown, reviewGateContextBudget);
  const deepContextFullyVisible =
    !deepRepoContext || truncatedReviewGateMarkdown.includes(deepRepoContext);
  const visibleDeepContextFileContents = Object.fromEntries(
    Object.entries(deepRepoContextResult.fileContents).filter(([file, content]) =>
      isDeepContextFileFullyVisible(truncatedReviewGateMarkdown, file, content),
    ),
  );
  const visibleChangedFileContents = Object.fromEntries(
    changedFileContentResult.evidence
      .filter(({ filename, content, section, contextComplete }) =>
        Boolean(content) &&
        contextComplete &&
        (!isFollowUpReview || reviewFileNames.has(filename)) &&
        truncatedReviewGateMarkdown.includes(section))
      .map(({ filename, content }) => [filename, content as string]),
  );
  const visibleCurrentHeadFileContents = {
    ...visibleDeepContextFileContents,
    ...visibleChangedFileContents,
  };
  const visibleChangedPatches = Object.fromEntries(
    reviewPatchSections
      .filter(({ section }) => truncatedReviewGateMarkdown.includes(section))
      .map(({ filename, patch }) => [filename, patch]),
  );
  const fatalContextComplete = reviewFollowUp.changesSincePreviousReviewComplete &&
    isFatalContextComplete(
      changeClass,
      incrementalReviewFiles,
      visibleCurrentHeadFileContents,
      visibleChangedPatches,
    );

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
    reviewGateMarkdown: truncatedReviewGateMarkdown,
    acceptanceSourceText: truncate(acceptanceSourceText, config.maxContextChars),
    testInventoryComplete: deepRepoContextResult.testInventoryComplete && deepContextFullyVisible,
    testInventoryFileCount,
    currentHeadFileContents: visibleCurrentHeadFileContents,
    visibleChangedPatches,
    fatalContextComplete,
    changeClass,
    minimumAcceptanceCriteria: trustedAcceptanceSources.minimumCriteria,
    explicitAcceptanceCriteria: trustedAcceptanceSources.criteria,
    reviewFollowUp,
  };
}

function reviewReferencedChangedPaths(
  reviewFollowUp: ReviewFollowUpContext,
  files: any[],
): Set<string> {
  const conversation = `${reviewFollowUp.previousReviewBody}\n${reviewFollowUp.contributorResponses}`;
  return new Set(
    files
      .map((file: any) => String(file.filename || ""))
      .filter((filename) =>
        filename.length > 0 &&
        new RegExp(
          `(?:^|[^A-Za-z0-9_.\\/-])${escapeReviewPathRegExp(filename)}(?=$|[^A-Za-z0-9_.\\/-])`,
          "u",
        ).test(conversation),
      ),
  );
}

function escapeReviewPathRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

type ReviewConversationEntry = {
  body: string;
  authorLogin: string;
  authorType: string;
  createdAt: string;
  location: string;
};

/**
 * Keeps only the latest published Seori result and the contributor response
 * after it. Older bot prose is intentionally excluded so follow-up reviews do
 * not reopen settled scope or anchor on stale findings.
 */
export function buildReviewFollowUpHistory(
  issueComments: any[],
  reviewComments: any[],
  reviews: any[],
): Omit<ReviewFollowUpContext, "changesSincePreviousReview" | "changesSincePreviousReviewComplete"> {
  const entries: ReviewConversationEntry[] = [
    ...issueComments.map((entry: any) => conversationEntry(entry, "PR comment")),
    ...reviewComments.map((entry: any) =>
      conversationEntry(entry, `review comment ${entry.path || "unknown"}:${entry.line ?? entry.original_line ?? "?"}`)),
    ...reviews.map((entry: any) => conversationEntry(entry, "pull request review")),
  ].sort((left, right) => timestamp(left.createdAt) - timestamp(right.createdAt));

  const priorResults = entries.filter((entry) =>
    isSeoriAuthor(entry.authorLogin) && isPublishedReviewResult(entry.body),
  );
  const previous = priorResults.at(-1);
  const previousReviewHeadSha = previous ? reviewResultHead(previous.body) : null;
  const previousAt = previous?.createdAt || null;
  const contributorEntries = previous
    ? entries.filter((entry) =>
        !isSeoriAuthor(entry.authorLogin) &&
        entry.authorType.toLowerCase() !== "bot" &&
        timestamp(entry.createdAt) > timestamp(previous.createdAt) &&
        entry.body.trim().length > 0)
    : [];
  const contributorResponses = contributorEntries
    .slice(-20)
    .map((entry) =>
      `- ${entry.authorLogin || "unknown"} (${entry.location}, ${entry.createdAt || "unknown-time"}): ${truncate(entry.body, 1_500)}`)
    .join("\n");

  return {
    reviewRound: priorResults.length + 1,
    previousReviewHeadSha:
      previousReviewHeadSha && /^[0-9a-f]{7,64}$/iu.test(previousReviewHeadSha)
        ? previousReviewHeadSha
        : null,
    previousReviewBody: previous ? truncate(previous.body, 6_000) : "",
    previousReviewAt: previousAt,
    contributorResponses,
  };
}

function conversationEntry(entry: any, location: string): ReviewConversationEntry {
  return {
    body: String(entry.body || ""),
    authorLogin: String(entry.user?.login || ""),
    authorType: String(entry.user?.type || ""),
    createdAt: String(entry.created_at || entry.submitted_at || entry.updated_at || ""),
    location,
  };
}

function isSeoriAuthor(login: string): boolean {
  return isBotGithubAuthor(login);
}

function isPublishedReviewResult(body: string): boolean {
  return (["action-required", "review-deferred", "no-action-required"] as const).some((status) =>
    bodyIncludesBotStatusMarker(body, status),
  );
}

function reviewResultHead(body: string): string | null {
  for (const line of body.split(/\r?\n/gu)) {
    if (!isPublishedReviewResult(line)) {
      continue;
    }
    return line.match(/\bhead=([0-9a-f]{7,64})\b/iu)?.[1] || null;
  }
  return null;
}

function timestamp(value: string): number {
  return Date.parse(value) || 0;
}

async function buildChangesSincePreviousReview(
  octokit: Octokit,
  repo: RepoRef,
  currentHeadSha: string,
  commits: any[],
  previousReviewHeadSha: string | null,
): Promise<{
  markdown: string;
  complete: boolean;
  files: any[];
  sections: Array<{ filename: string; patch: string; section: string }>;
}> {
  if (!previousReviewHeadSha) {
    return {
      markdown: "(first review turn - inspect the PR diff against the base branch)",
      complete: true,
      files: [],
      sections: [],
    };
  }
  if (previousReviewHeadSha === currentHeadSha) {
    return {
      markdown: "(no new commit - inspect only the contributor response against the previous Seori result)",
      complete: true,
      files: [],
      sections: [],
    };
  }
  const commitShas = new Set(commits.map((commit: any) => String(commit.sha || "")));
  if (!commitShas.has(previousReviewHeadSha)) {
    return {
      markdown: "(previous reviewed HEAD is no longer in the PR commit history; use the current diff and contributor response without reopening settled scope)",
      complete: false,
      files: [],
      sections: [],
    };
  }

  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner: repo.owner,
      repo: repo.repo,
      basehead: `${previousReviewHeadSha}...${currentHeadSha}`,
      per_page: 100,
    });
    const files = Array.isArray(data.files) ? prioritizeChangedFilesForContext(data.files) : [];
    if (files.length === 0) {
      return {
        markdown: "(no changed files since the previous Seori result)",
        complete: true,
        files: [],
        sections: [],
      };
    }
    const sections = files.map((file: any) => {
      const filename = String(file.filename || "unknown");
      const patch = String(file.patch || "(binary file or patch unavailable)");
      return {
        filename,
        patch,
        section: [
          `### ${filename}`,
          `status=${String(file.status || "unknown")} additions=${Number(file.additions || 0)} deletions=${Number(file.deletions || 0)}`,
          "```diff",
          patch,
          "```",
        ].join("\n"),
      };
    });
    return {
      markdown: truncate(sections.map(({ section }) => section).join("\n\n"), 50_000),
      complete: true,
      files,
      sections,
    };
  } catch {
    return {
      markdown: "(GitHub compare context unavailable; use the contributor response and current HEAD only, and do not reopen unrelated settled scope)",
      complete: false,
      files: [],
      sections: [],
    };
  }
}

/**
 * Fatal review is scoped to defects introduced on changed product lines. It is
 * safe when every current product file has a complete visible patch; the model
 * does not need the full body of a large file merely to prove that no changed
 * line directly introduces a catastrophic outcome. Deleted product files have
 * no current-HEAD line to ground, so a deletion-only product change stays
 * conservative instead of being treated as complete by vacuous truth.
 */
export function isFatalContextComplete(
  changeClass: ChangeClass,
  files: readonly any[],
  _currentHeadFileContents: Readonly<Record<string, string>>,
  visibleChangedPatches: Readonly<Record<string, string>>,
): boolean {
  const productFiles = files
    .map((file) => ({
      filename: String(file?.filename || ""),
      status: String(file?.status || "").toLowerCase(),
    }))
    .filter(({ filename }) => filename.length > 0 && !isNonProductFatalPath(filename));

  if (productFiles.length === 0) {
    // A product/mixed classification without a reviewable product path means
    // host selection and fatal-path policy disagree. Fail closed.
    return changeClass !== "product_logic" && changeClass !== "mixed";
  }

  const currentProductFiles = productFiles.filter(
    ({ status }) => status !== "removed" && status !== "deleted",
  );
  if (currentProductFiles.length === 0) {
    return false;
  }

  return currentProductFiles.every(({ filename }) =>
    isUsableReviewPatch(visibleChangedPatches[filename]),
  );
}

function isUsableReviewPatch(value: string | undefined): boolean {
  return Boolean(
    value &&
    value !== "(binary file or patch unavailable)" &&
    /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/mu.test(value),
  );
}

function buildTrustedAcceptanceSourceText(
  pr: any,
  issueComments: any[],
  reviewComments: any[],
  reviews: any[],
  config: Config,
): { text: string; minimumCriteria: number; criteria: string[] } {
  const trustedAssociations = config.trustedAssociations;
  const isTrustedHuman = (entry: any): boolean => {
    const login = String(entry.user?.login || "");
    const type = String(entry.user?.type || "").toLowerCase();
    const association = String(entry.author_association || "").toUpperCase();
    return (
      Boolean(login) &&
      type !== "bot" &&
      !login.toLowerCase().endsWith("[bot]") &&
      trustedAssociations.has(association)
    );
  };

  const trustedHumanEntries = [...issueComments, ...reviewComments, ...reviews]
    .filter(isTrustedHuman)
    .sort((left, right) => {
      const leftAt = Date.parse(left.created_at || left.submitted_at || left.updated_at || "") || 0;
      const rightAt = Date.parse(right.created_at || right.submitted_at || right.updated_at || "") || 0;
      return leftAt - rightAt;
    })
    .slice(-30);
  const trustedEntries = trustedHumanEntries
    .map((entry) => {
      const location = entry.path
        ? ` on ${entry.path}:${entry.line ?? entry.original_line ?? "?"}`
        : "";
      return `- ${entry.user.login}${location}: ${truncate(String(entry.body || ""), 1500)}`;
    });

  const text = [
    "### PR title",
    String(pr.title || "(empty)"),
    "",
    "### PR body",
    String(pr.body || "(empty)"),
    "",
    "### Trusted maintainer comments and reviews",
    trustedEntries.join("\n") || "(none)",
  ].join("\n");
  const criteria = new Map<string, string>();
  for (const source of [String(pr.body || ""), ...trustedHumanEntries.map((entry) => String(entry.body || ""))]) {
    for (const criterion of listExplicitAcceptanceCriteria(source)) {
      criteria.set(normalizedAcceptanceCriterion(criterion), criterion);
    }
  }
  return { text, minimumCriteria: criteria.size, criteria: [...criteria.values()] };
}

export function countExplicitAcceptanceCriteria(value: string): number {
  return new Set(listExplicitAcceptanceCriteria(value).map(normalizedAcceptanceCriterion)).size;
}

export function listExplicitAcceptanceCriteria(value: string): string[] {
  const criteria: string[] = [];
  let inAcceptanceSection = false;
  let canContinueCriterion = false;
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const heading = line.match(/^#{1,6}\s+(.+)$/u);
    if (heading) {
      const headingText = (heading[1] || "")
        .normalize("NFKC")
        .replace(/\s+#+\s*$/u, "")
        .trim();
      inAcceptanceSection =
        /(?:acceptance\s+criteria|requirements?|definition\s+of\s+done|인수\s*조건|완료\s*조건|검증\s*조건|요구\s*사항|요건)/iu.test(
          headingText,
        ) || /^(?:expected\s+behavior|behavior|기대\s*동작|동작)$/iu.test(headingText);
      canContinueCriterion = false;
      continue;
    }

    // A checkbox is only an acceptance criterion inside an explicitly named
    // acceptance/requirements/behavior section. Release checklists and command
    // verification lists often use the same syntax but are not product
    // requirements, and counting them created an impossible host/model floor.
    const checkbox = inAcceptanceSection
      ? line.match(/^[-*+]\s+\[[ xX]\]\s+(.+)$/u)
      : null;
    const numberedCriterion = line.match(/^(?:AC[-\s]?\d+|인수\s*조건\s*\d+)\s*[:.)-]\s*(.+)$/iu);
    const sectionItem = inAcceptanceSection
      ? line.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/u)
      : null;
    const text = checkbox?.[1] || numberedCriterion?.[1] || sectionItem?.[1];
    if (text) {
      criteria.push(text.normalize("NFKC").replace(/\s+/gu, " ").trim());
      canContinueCriterion = true;
      continue;
    }

    // Preserve a wrapped constraint under the preceding checklist/section item.
    // Dropping lines such as "단, 사용자별로 분리한다" lets the model pass on
    // only the first half of an explicitly stated acceptance criterion.
    if (
      canContinueCriterion &&
      criteria.length > 0 &&
      line.length > 0 &&
      /^(?: {2,}|\t)\S/u.test(rawLine) &&
      !/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u.test(rawLine)
    ) {
      criteria[criteria.length - 1] = `${criteria[criteria.length - 1]} ${line}`;
      continue;
    }
    canContinueCriterion = false;
  }
  return criteria;
}

function normalizedAcceptanceCriterion(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

export function isDeepContextFileFullyVisible(markdown: string, file: string, content: string): boolean {
  const body = content.trimEnd();
  if (!body) {
    return false;
  }
  const deepContextStart = markdown.indexOf("## Deep Repository Context");
  if (deepContextStart < 0) {
    return false;
  }
  const nextTopLevelSection = markdown.indexOf("\n## ", deepContextStart + 1);
  const deepContext = markdown.slice(
    deepContextStart,
    nextTopLevelSection >= 0 ? nextTopLevelSection : markdown.length,
  );
  const header = `### ${file}\n`;
  const sectionStart = deepContext.indexOf(header);
  if (sectionStart < 0) {
    return false;
  }
  const bodyStart = deepContext.indexOf(body, sectionStart + header.length);
  if (bodyStart < 0) {
    return false;
  }
  const sectionEnd = deepContext.indexOf("\n````", bodyStart + body.length);
  const nextSection = deepContext.indexOf("\n\n### ", sectionStart + header.length);
  return sectionEnd >= 0 && (nextSection < 0 || sectionEnd < nextSection);
}

async function buildChangedFileContents(
  octokit: Octokit,
  repo: RepoRef,
  headSha: string,
  files: any[],
): Promise<ChangedFileContentResult> {
  const sections: string[] = [];
  const evidence: ChangedFileContentEvidence[] = [];
  let contextChars = 0;
  let omittedCount = 0;

  for (const file of prioritizeChangedFilesForContext(files)) {
    if (!shouldFetchChangedFileContent(file)) {
      continue;
    }

    const item = await buildChangedFileContentSection(octokit, repo, headSha, file);
    if (!item) {
      continue;
    }

    const separatorChars = sections.length > 0 ? 2 : 0;
    if (contextChars + separatorChars + item.section.length > MAX_CHANGED_FILE_CONTENT_CONTEXT_CHARS) {
      omittedCount += 1;
      continue;
    }

    sections.push(item.section);
    evidence.push(item);
    contextChars += separatorChars + item.section.length;
  }

  if (omittedCount > 0) {
    sections.push(`...${omittedCount} additional current file content sections omitted...`);
  }

  return {
    markdown: sections.join("\n\n"),
    evidence,
  };
}

export function prioritizeChangedFilesForContext(files: any[]): any[] {
  return files
    .map((file, index) => ({ file, index }))
    .sort((left, right) => {
      const leftProduct = isChangedProductFile(left.file);
      const rightProduct = isChangedProductFile(right.file);
      if (leftProduct !== rightProduct) {
        return leftProduct ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map(({ file }) => file);
}

function isChangedProductFile(file: any): boolean {
  const filename = String(file?.filename || "");
  const status = String(file?.status || "").toLowerCase();
  return Boolean(
    filename &&
    status !== "removed" &&
    status !== "deleted" &&
    !isNonProductFatalPath(filename),
  );
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
): Promise<ChangedFileContentEvidence | null> {
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
    const encoded = typeof data.content === "string" ? data.content : "";
    const content = encoded ? Buffer.from(encoded.replace(/\n/g, ""), "base64").toString("utf8") : "";
    const header = `status=${file.status} additions=${file.additions} deletions=${file.deletions} current_head_size=${size}`;

    if (size > MAX_CHANGED_FILE_CONTENT_CHARS) {
      // Too large to inline in full. For source files, emit a symbol outline plus
      // windows around the changed hunks so the reviewer can see that guards/filters
      // living in sibling functions exist, instead of falsely reporting their absence.
      const digest =
        content && !looksBinary(content) ? buildLargeFileDigest(content, file.patch) : null;
      if (digest) {
        return {
          filename,
          content,
          contextComplete: digest.changedRegionsComplete,
          section: [
            `### ${filename}`,
            `${header} (full body omitted >${MAX_CHANGED_FILE_CONTENT_CHARS} chars; showing changed-region windows + symbol outline)`,
            `\`\`\`\`${codeFenceLanguage(filename)}`,
            digest.markdown,
            "````",
          ].join("\n"),
        };
      }
      return {
        filename,
        content: content || null,
        contextComplete: false,
        section: [
          `### ${filename}`,
          header,
          `current HEAD content omitted because it exceeds ${MAX_CHANGED_FILE_CONTENT_CHARS} characters`,
        ].join("\n"),
      };
    }

    if (!content || looksBinary(content)) {
      return null;
    }

    return {
      filename,
      content,
      contextComplete: true,
      section: [
        `### ${filename}`,
        header,
        `\`\`\`\`${codeFenceLanguage(filename)}`,
        content.trimEnd(),
        "````",
      ].join("\n"),
    };
  } catch (error) {
    return {
      filename,
      content: null,
      contextComplete: false,
      section: [
        `### ${filename}`,
        `status=${file.status}`,
        `current HEAD content unavailable: ${truncate(errorMessage(error), 300)}`,
      ].join("\n"),
    };
  }
}

// High-signal declaration lines (functions, classes, signals, enums) across the
// languages we review. Used to give the reviewer a map of a large file's symbols
// so it does not claim a guard/filter is "missing" when it merely lives in a
// sibling function outside the diff hunk.
const DECLARATION_PATTERN =
  /^\s*(?:@\w+\s+)?(?:static\s+)?func\s+\w+|^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\w+|^\s*(?:export\s+)?(?:public\s+|private\s+|protected\s+|abstract\s+|static\s+)*class\s+\w+|^\s*class_name\s+\w+|^\s*signal\s+\w+|^\s*enum\s+\w+|^\s*def\s+\w+|^\s*(?:export\s+)?(?:interface|type)\s+\w+/;

const LARGE_FILE_DIGEST_BUDGET = 12_000;
const LARGE_FILE_WINDOW_RADIUS = 18;

// For an oversized changed file, produce a compact digest: a symbol outline plus
// the changed-region windows (with line numbers) so cross-symbol reasoning stays
// grounded without inlining the whole body.
export function buildLargeFileDigest(
  content: string,
  patch: string | null | undefined,
): LargeFileDigest | null {
  const lines = content.split("\n");
  if (lines.length === 0) {
    return null;
  }

  const outline: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (DECLARATION_PATTERN.test(lines[i]!)) {
      outline.push(`L${i + 1}: ${lines[i]!.trim()}`);
    }
  }

  const windows = renderChangedWindows(lines, changedContextLines(patch));

  const sections: string[] = [];
  let budget = LARGE_FILE_DIGEST_BUDGET;
  let changedRegionsComplete = false;
  if (windows && budget > 200) {
    const windowBudget = budget - 100;
    const changedRegionsTruncated = windows.length > windowBudget;
    const windowText = changedRegionsTruncated
      ? `${windows.slice(0, windowBudget)}\n...changed-region windows truncated...`
      : windows;
    sections.push(`# changed-region windows (line: source)\n${windowText}`);
    budget -= windowText.length;
    changedRegionsComplete = !changedRegionsTruncated;
  }
  if (outline.length > 0 && budget > 200) {
    const outlineText = clampLines(outline, budget - 100);
    sections.push(`# symbol outline (line: declaration)\n${outlineText}`);
  }

  return sections.length > 0
    ? { markdown: sections.join("\n\n"), changedRegionsComplete }
    : null;
}

function clampLines(items: string[], budget: number): string {
  const out: string[] = [];
  let used = 0;
  for (const item of items) {
    if (used + item.length + 1 > budget) {
      out.push(`...${items.length - out.length} more declarations omitted...`);
      break;
    }
    out.push(item);
    used += item.length + 1;
  }
  return out.join("\n");
}

// New-file line numbers that anchor every hunk plus added lines. Hunk anchors
// keep deletion-only edits reviewable in the post-change source.
function changedContextLines(patch: string | null | undefined): number[] {
  const changed: number[] = [];
  if (!patch) {
    return changed;
  }

  let newLine = 0;
  let inHunk = false;
  for (const row of patch.split("\n")) {
    const header = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      newLine = Number(header[1]);
      if (newLine > 0) {
        changed.push(newLine);
      }
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (row.startsWith("+")) {
      changed.push(newLine);
      newLine += 1;
    } else if (row.startsWith(" ")) {
      newLine += 1;
    } else if (row.startsWith("-") || row.startsWith("\\")) {
      // removed / "no newline" lines do not advance the new-file counter
    } else {
      inHunk = false;
    }
  }

  return changed;
}

function renderChangedWindows(lines: string[], changed: number[]): string | null {
  if (changed.length === 0) {
    return null;
  }

  const ranges: Array<[number, number]> = [];
  for (const lineNumber of changed) {
    const start = Math.max(1, lineNumber - LARGE_FILE_WINDOW_RADIUS);
    const end = Math.min(lines.length, lineNumber + LARGE_FILE_WINDOW_RADIUS);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  const blocks: string[] = [];
  for (const [start, end] of ranges) {
    const rows: string[] = [];
    for (let line = start; line <= end; line += 1) {
      rows.push(`L${line}: ${lines[line - 1] ?? ""}`);
    }
    blocks.push(rows.join("\n"));
  }

  return blocks.join("\n  ...\n");
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
    case ".jsonl":
      return "jsonl";
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
    bodyIncludesBotStatusMarker(body, "no-action-required") && body.includes(`head=${headSha}`),
  ).length;
  const staleNoActionMarkers = bodies.filter((body) =>
    bodyIncludesBotStatusMarker(body, "no-action-required") && !body.includes(`head=${headSha}`),
  ).length;
  const currentMergeConflictMarkers = bodies.filter((body) =>
    bodyIncludesBotStatusMarker(body, "merge-conflict") && body.includes(`head=${headSha}`),
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

export async function completeLatestOwnReviewCheckAsSuccess(
  octokit: Octokit,
  repo: RepoRef,
  headSha: string,
  title: string,
  summary: string,
): Promise<number | null> {
  const { data } = await octokit.rest.checks.listForRef({
    owner: repo.owner,
    repo: repo.repo,
    ref: headSha,
    per_page: 100,
  });
  let latestOwnCheck: any | null = null;
  for (const run of data.check_runs || []) {
    if (!isOwnReviewCheck(run.name) || !Number.isFinite(Number(run.id))) {
      continue;
    }
    if (latestOwnCheck === null || Number(run.id) > Number(latestOwnCheck.id)) {
      latestOwnCheck = run;
    }
  }

  if (!latestOwnCheck) {
    const { data: created } = await octokit.rest.checks.create({
      owner: repo.owner,
      repo: repo.repo,
      name: REVIEW_CHECK_NAME,
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
      completed_at: new Date().toISOString(),
      output: {
        title,
        summary: truncate(summary, 65000),
      },
    });
    return Number.isFinite(Number(created.id)) ? Number(created.id) : null;
  }

  const checkRunId = Number(latestOwnCheck.id);
  await octokit.rest.checks.update({
    owner: repo.owner,
    repo: repo.repo,
    check_run_id: checkRunId,
    status: "completed",
    conclusion: "success",
    completed_at: new Date().toISOString(),
    output: {
      title,
      summary: truncate(summary, 65000),
    },
  });
  return checkRunId;
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

export async function squashMergePullRequest(
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  headSha: string,
): Promise<void> {
  await octokit.rest.pulls.merge({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
    sha: headSha,
    merge_method: "squash",
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

export type InlineReviewComment = {
  path: string;
  line: number;
  body: string;
};

export type ReviewSubmitEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

// Submits one batched ("Start review" + submit) pull request review with inline draft
// comments anchored to changed lines, mirroring a human reviewer.
export async function submitReviewWithInlineComments(
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  headSha: string,
  event: ReviewSubmitEvent,
  body: string,
  comments: InlineReviewComment[],
): Promise<void> {
  await octokit.rest.pulls.createReview({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
    commit_id: headSha,
    event,
    body: githubCommentBody(body),
    comments: comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: "RIGHT",
      body: comment.body,
    })),
  });
}

export type ReviewThreadInfo = {
  threadId: string;
  isResolved: boolean;
  resolvedByLogin: string | null;
  commentDatabaseIds: number[];
  bodies: string[];
  comments: Array<{
    databaseId: number | null;
    body: string;
    authorLogin: string;
    authorAssociation: string;
  }>;
};

export async function listReviewThreads(
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
): Promise<ReviewThreadInfo[]> {
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!, $after: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100, after: $after) {
            nodes {
              id
              isResolved
              resolvedBy { login }
              comments(first: 20) {
                nodes {
                  databaseId
                  body
                  author { login }
                  authorAssociation
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

  const threads: ReviewThreadInfo[] = [];
  let after: string | null = null;
  do {
    const result: any = await octokit.graphql(query, {
      owner: repo.owner,
      repo: repo.repo,
      prNumber,
      after,
    });
    const reviewThreads = result.repository?.pullRequest?.reviewThreads;
    for (const thread of reviewThreads?.nodes || []) {
      const comments = thread.comments?.nodes || [];
      threads.push({
        threadId: String(thread.id),
        isResolved: Boolean(thread.isResolved),
        resolvedByLogin: thread.resolvedBy?.login ? String(thread.resolvedBy.login) : null,
        commentDatabaseIds: comments
          .map((comment: any) => Number(comment.databaseId))
          .filter((id: number) => Number.isFinite(id)),
        bodies: comments.map((comment: any) => String(comment.body || "")),
        comments: comments.map((comment: any) => ({
          databaseId: Number.isFinite(Number(comment.databaseId)) ? Number(comment.databaseId) : null,
          body: String(comment.body || ""),
          authorLogin: String(comment.author?.login || ""),
          authorAssociation: String(comment.authorAssociation || ""),
        })),
      });
    }
    after = reviewThreads?.pageInfo?.hasNextPage ? reviewThreads.pageInfo.endCursor : null;
  } while (after);

  return threads;
}

export async function resolveReviewThread(octokit: Octokit, threadNodeId: string): Promise<void> {
  const mutation = `
    mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread { id isResolved }
      }
    }
  `;
  await octokit.graphql(mutation, { threadId: threadNodeId });
}

// Set of changed file paths between two commits, used to tell review-response
// regressions apart from genuinely new findings and to confirm resolutions.
export async function changedFilesBetween(
  octokit: Octokit,
  repo: RepoRef,
  baseSha: string,
  headSha: string,
): Promise<Set<string>> {
  if (!baseSha || baseSha === headSha) {
    return new Set();
  }
  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner: repo.owner,
      repo: repo.repo,
      basehead: `${baseSha}...${headSha}`,
    });
    return new Set((data.files || []).map((file: any) => String(file.filename)));
  } catch {
    return new Set();
  }
}

export async function ensureLabelExists(octokit: Octokit, repo: RepoRef, label: string): Promise<void> {
  try {
    await octokit.rest.issues.getLabel({ owner: repo.owner, repo: repo.repo, name: label });
  } catch {
    try {
      await octokit.rest.issues.createLabel({
        owner: repo.owner,
        repo: repo.repo,
        name: label,
        color: "ededed",
        description: "Seori PR Bot follow-up (refactor / future improvement)",
      });
    } catch {
      // Label creation can race or be unauthorized; issue creation still works without it.
    }
  }
}

export async function createFollowupIssue(
  octokit: Octokit,
  repo: RepoRef,
  params: { title: string; body: string; labels: string[] },
): Promise<{ number: number; url: string }> {
  const { data } = await octokit.rest.issues.create({
    owner: repo.owner,
    repo: repo.repo,
    title: params.title,
    body: githubCommentBody(params.body),
    labels: params.labels,
  });
  return { number: data.number, url: data.html_url };
}

export async function commentAndCloseIssue(
  octokit: Octokit,
  repo: RepoRef,
  issueNumber: number,
  comment: string,
): Promise<void> {
  try {
    await octokit.rest.issues.createComment({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: issueNumber,
      body: githubCommentBody(comment),
    });
    await octokit.rest.issues.update({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: issueNumber,
      state: "closed",
      state_reason: "completed",
    });
  } catch {
    // Best-effort: a manually-closed or deleted issue should not fail the review.
  }
}
