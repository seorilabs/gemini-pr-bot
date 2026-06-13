import type { Config } from "./config.js";
import { githubCommentBody, truncate } from "./text.js";

type Octokit = any;

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
  headSha: string;
  title: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  baseRef: string;
  headRef: string;
  baseRepoFullName: string;
  headRepoFullName: string;
};

export type PullRequestContext = PullRequestStatus & {
  markdown: string;
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
  return {
    headSha: pr.head.sha,
    title: pr.title,
    draft: Boolean(pr.draft),
    mergeable: pr.mergeable ?? null,
    mergeableState: String(pr.mergeable_state || "unknown"),
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    baseRepoFullName: pr.base.repo?.full_name || repo.fullName,
    headRepoFullName: pr.head.repo?.full_name || repo.fullName,
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
): Promise<PullRequestContext> {
  const pr = await getPullRequestWithMergeability(octokit, repo, prNumber);

  const [files, commits, issueComments, reviewComments] = await Promise.all([
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

  const recentIssueComments = issueComments
    .slice(-20)
    .map((comment: any) => `- ${comment.user.login}: ${truncate(comment.body || "", 1000)}`)
    .join("\n");

  const recentReviewComments = reviewComments
    .slice(-20)
    .map((comment: any) => {
      const line = comment.line ?? comment.original_line ?? "?";
      return `- ${comment.user.login} on ${comment.path}:${line}: ${truncate(comment.body || "", 1000)}`;
    })
    .join("\n");

  const markdown = [
    "# Pull Request Context",
    "",
    `Repository: ${repo.fullName}`,
    `Pull request: #${prNumber}`,
    `Title: ${pr.title}`,
    `Author: ${pr.user?.login || "unknown"}`,
    `Draft: ${Boolean(pr.draft)}`,
    `Base: ${pr.base.repo?.full_name || repo.fullName}:${pr.base.ref}`,
    `Head: ${pr.head.repo?.full_name || repo.fullName}:${pr.head.ref}`,
    `Head SHA: ${pr.head.sha}`,
    `GitHub mergeable: ${pr.mergeable ?? "unknown"}`,
    `GitHub mergeable_state: ${pr.mergeable_state || "unknown"}`,
    "",
    "## PR Body",
    pr.body || "(empty)",
    "",
    "## Commits",
    commits.map((commit: any) => `- ${commit.sha.slice(0, 7)} ${commit.commit.message.split("\n")[0]}`).join("\n") ||
      "(none)",
    "",
    "## Recent PR Comments",
    recentIssueComments || "(none)",
    "",
    "## Recent Review Comments",
    recentReviewComments || "(none)",
    "",
    "## Changed Files",
    fileSections.join("\n\n") || "(none)",
  ].join("\n");

  return {
    headSha: pr.head.sha,
    title: pr.title,
    draft: Boolean(pr.draft),
    mergeable: pr.mergeable ?? null,
    mergeableState: String(pr.mergeable_state || "unknown"),
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    baseRepoFullName: pr.base.repo?.full_name || repo.fullName,
    headRepoFullName: pr.head.repo?.full_name || repo.fullName,
    markdown: truncate(markdown, config.maxContextChars),
  };
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
      name: "Gemini PR Bot",
      head_sha: headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
      output: {
        title: "Gemini review is running",
        summary: "Gemini PR Bot is reviewing the pull request context.",
      },
    });
    return data.id;
  } catch {
    return null;
  }
}

export async function completeCheck(
  octokit: Octokit,
  repo: RepoRef,
  checkRunId: number | null,
  conclusion: "success" | "failure" | "action_required",
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
