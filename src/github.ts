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

async function paginate(octokit: Octokit, method: any, params: Record<string, unknown>) {
  return octokit.paginate(method, params);
}

export async function buildPullRequestContext(
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  config: Config,
): Promise<{ headSha: string; title: string; markdown: string }> {
  const { data: pr } = await octokit.rest.pulls.get({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
  });

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
    `Base: ${pr.base.ref}`,
    `Head: ${pr.head.ref}`,
    `Head SHA: ${pr.head.sha}`,
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
  conclusion: "success" | "failure",
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

