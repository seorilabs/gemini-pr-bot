import type { App } from "octokit";
import type { Config } from "./config.js";
import {
  closePullRequest,
  getPullRequestStatus,
  requestChangesPullRequest,
  REVIEW_AGENT_NAME,
  type PullRequestStatus,
  type RepoRef,
} from "./github.js";

type Logger = {
  info: (value: unknown, message?: string) => void;
  warn: (value: unknown, message?: string) => void;
  error: (value: unknown, message?: string) => void;
};

type Octokit = any;

type PullRequest = {
  number: number;
  title: string;
  html_url?: string;
  head: {
    sha: string;
  };
};

type ReviewSignal = {
  kind: "action-required" | "merge-conflict";
  at: string;
  author: string;
  headSha?: string;
  actionKind?: string;
  summary: string;
};

type StaleReviewCandidate = {
  repo: RepoRef;
  prNumber: number;
  title: string;
  url: string;
  headSha: string;
  signal: ReviewSignal;
  thresholdMs: number;
  staleMs: number;
};

const ACTION_REQUIRED_MARKER_TEXT = "seorilabs-gemini-pr-bot:status=action-required";
const MERGE_CONFLICT_MARKER_TEXT = "seorilabs-gemini-pr-bot:status=merge-conflict";
const STALE_CLOSED_MARKER_TEXT = "seorilabs-gemini-pr-bot:status=stale-closed";

export class StaleReviewMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;

  constructor(
    private readonly app: App,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (!this.config.staleReviewCloseEnabled) {
      return;
    }

    this.logger.info(
      {
        thresholdMs: this.config.staleReviewThresholdMs,
        scanIntervalMs: this.config.staleReviewScanIntervalMs,
        maxPrsPerScan: this.config.staleReviewMaxPrsPerScan,
        ignoredRepositories: [...this.config.staleReviewIgnoredRepositories],
      },
      "stale review monitor started",
    );
    this.schedule(Math.min(60_000, this.config.staleReviewScanIntervalMs));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    while (this.running) {
      await delay(250);
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopping) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.schedule(this.config.staleReviewScanIntervalMs);
      return;
    }

    this.running = true;
    try {
      await this.scan();
    } catch (error) {
      this.logger.error({ error }, "stale review scan failed");
    } finally {
      this.running = false;
      this.schedule(this.config.staleReviewScanIntervalMs);
    }
  }

  private async scan(): Promise<void> {
    const startedAt = Date.now();
    let repositoriesChecked = 0;
    let prsChecked = 0;
    let prsClosed = 0;

    for await (const { octokit, repository } of this.app.eachRepository.iterator()) {
      if (prsChecked >= this.config.staleReviewMaxPrsPerScan) {
        break;
      }

      const repo = repoFromRepository(repository);
      if (!this.shouldScanRepository(repo, repository)) {
        continue;
      }
      repositoriesChecked += 1;

      const openPrs = await listOpenPullRequests(octokit, repo);
      for (const pr of openPrs) {
        if (prsChecked >= this.config.staleReviewMaxPrsPerScan) {
          break;
        }
        prsChecked += 1;

        const candidate = await findStaleReviewCandidate(
          octokit,
          repo,
          pr,
          this.config.staleReviewThresholdMs,
          Date.now(),
        );
        if (!candidate) {
          continue;
        }

        const body = staleCloseText(candidate);
        await requestChangesPullRequest(octokit, repo, candidate.prNumber, body, candidate.headSha);
        await closePullRequest(octokit, repo, candidate.prNumber);
        prsClosed += 1;
        this.logger.warn(
          {
            repo: repo.fullName,
            prNumber: candidate.prNumber,
            headSha: candidate.headSha,
            signalAt: candidate.signal.at,
            staleMs: candidate.staleMs,
          },
          "stale review pull request closed",
        );
      }
    }

    this.logger.info(
      {
        repositoriesChecked,
        prsChecked,
        prsClosed,
        elapsedMs: Date.now() - startedAt,
      },
      "stale review scan completed",
    );
  }

  private shouldScanRepository(repo: RepoRef, repository: any): boolean {
    if (repo.owner !== this.config.githubOrg) {
      return false;
    }

    if (!this.config.allowPublicRepos && !repo.isPrivate) {
      return false;
    }

    if (repository.archived || repository.disabled) {
      return false;
    }

    const ignored = this.config.staleReviewIgnoredRepositories;
    return !ignored.has(repo.fullName.toLowerCase()) && !ignored.has(repo.repo.toLowerCase());
  }
}

async function listOpenPullRequests(octokit: Octokit, repo: RepoRef): Promise<PullRequest[]> {
  return octokit.paginate(octokit.rest.pulls.list, {
    owner: repo.owner,
    repo: repo.repo,
    state: "open",
    sort: "updated",
    direction: "asc",
    per_page: 100,
  });
}

async function findStaleReviewCandidate(
  octokit: Octokit,
  repo: RepoRef,
  pr: PullRequest,
  thresholdMs: number,
  nowMs: number,
): Promise<StaleReviewCandidate | null> {
  const [issueComments, reviewComments, reviews, commits] = await Promise.all([
    octokit.paginate(octokit.rest.issues.listComments, {
      owner: repo.owner,
      repo: repo.repo,
      issue_number: pr.number,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: pr.number,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: pr.number,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listCommits, {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: pr.number,
      per_page: 100,
    }),
  ]);

  const signal = latestReviewSignal(issueComments, reviews, pr.head.sha);
  if (!signal) {
    return null;
  }

  const signalAtMs = Date.parse(signal.at);
  if (!Number.isFinite(signalAtMs) || nowMs - signalAtMs < thresholdMs) {
    return null;
  }

  const responseAtMs = latestResponseAfterSignalMs(signalAtMs, issueComments, reviewComments, reviews, commits);
  if (responseAtMs && responseAtMs > signalAtMs) {
    return null;
  }

  const status = await getPullRequestStatus(octokit, repo, pr.number);
  if (signal.actionKind === "status-check" && !hasBlockingStatusChecks(status)) {
    return null;
  }
  if (signal.kind === "merge-conflict" && !hasMergeConflict(status)) {
    return null;
  }

  return {
    repo,
    prNumber: pr.number,
    title: pr.title,
    url: pr.html_url || `https://github.com/${repo.fullName}/pull/${pr.number}`,
    headSha: pr.head.sha,
    signal,
    thresholdMs,
    staleMs: nowMs - signalAtMs,
  };
}

function latestReviewSignal(issueComments: any[], reviews: any[], headSha: string): ReviewSignal | null {
  const signals = [
    ...issueComments.flatMap((comment) => signalFromBody(comment.body, comment.created_at, comment.user, headSha)),
    ...reviews.flatMap((review) => signalFromBody(review.body, review.submitted_at, review.user, headSha)),
  ];

  signals.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  return signals[0] || null;
}

function signalFromBody(body: string | undefined, at: string | undefined, user: any, headSha: string): ReviewSignal[] {
  if (!body || !at || !isBotUser(user)) {
    return [];
  }

  const markerHeadSha = markerHeadShaFromBody(body);
  if (markerHeadSha && markerHeadSha !== headSha) {
    return [];
  }

  if (body.includes(ACTION_REQUIRED_MARKER_TEXT)) {
    return [{
      kind: "action-required",
      at,
      author: user.login || "unknown",
      headSha: markerHeadSha,
      actionKind: markerActionKindFromBody(body),
      summary: firstMeaningfulLine(body),
    }];
  }

  if (body.includes(MERGE_CONFLICT_MARKER_TEXT)) {
    return [{
      kind: "merge-conflict",
      at,
      author: user.login || "unknown",
      headSha: markerHeadSha,
      summary: firstMeaningfulLine(body),
    }];
  }

  return [];
}

function latestResponseAfterSignalMs(
  signalAtMs: number,
  issueComments: any[],
  reviewComments: any[],
  reviews: any[],
  commits: any[],
): number | null {
  const responseTimes = [
    ...issueComments.filter((comment) => !isBotUser(comment.user)).map((comment) => Date.parse(comment.created_at)),
    ...reviewComments.filter((comment) => !isBotUser(comment.user)).map((comment) => Date.parse(comment.created_at)),
    ...reviews.filter((review) => !isBotUser(review.user)).map((review) => Date.parse(review.submitted_at)),
    ...commits.map((commit) => Date.parse(commit.commit?.committer?.date || commit.commit?.author?.date)),
  ].filter((time) => Number.isFinite(time) && time > signalAtMs);

  if (responseTimes.length === 0) {
    return null;
  }
  return Math.max(...responseTimes);
}

function staleCloseText(candidate: StaleReviewCandidate): string {
  return [
    `<!-- ${STALE_CLOSED_MARKER_TEXT} head=${candidate.headSha} -->`,
    "## Stale 리뷰 종료",
    "",
    `${REVIEW_AGENT_NAME}가 남긴 조치 요청 이후 ${formatDuration(candidate.thresholdMs)} 이상 새 커밋이나 사람 응답이 없어 stale 상태로 판단했습니다.`,
    "",
    `- PR: \`${candidate.repo.fullName}#${candidate.prNumber}\``,
    `- 제목: ${candidate.title}`,
    `- URL: ${candidate.url}`,
    `- 기준 HEAD: \`${candidate.headSha}\``,
    `- 마지막 조치 요청: ${candidate.signal.at}`,
    `- 조치 요청 종류: ${candidate.signal.actionKind || candidate.signal.kind}`,
    `- 작성자: @${candidate.signal.author}`,
    "",
    "필요하면 변경 범위를 줄이고 현재 피드백을 반영한 새 PR로 다시 열어주세요.",
  ].join("\n");
}

function formatDuration(ms: number): string {
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours > 0) {
    return `${hours}시간`;
  }
  return `${Math.max(1, Math.round(ms / (60 * 1000)))}분`;
}

function repoFromRepository(repository: any): RepoRef {
  const owner = repository.owner?.login || repository.full_name.split("/")[0];
  return {
    owner,
    repo: repository.name,
    fullName: repository.full_name,
    isPrivate: Boolean(repository.private),
  };
}

function markerHeadShaFromBody(body: string): string | undefined {
  return body.match(/\bhead=([0-9a-f]{7,64})\b/i)?.[1];
}

function markerActionKindFromBody(body: string): string | undefined {
  return body.match(/\bkind=([a-z-]+)\b/i)?.[1];
}

function hasBlockingStatusChecks(status: PullRequestStatus): boolean {
  return status.statusChecks.failing.length > 0 || status.statusChecks.pending.length > 0;
}

function hasMergeConflict(status: PullRequestStatus): boolean {
  return status.mergeable === false || ["dirty", "conflicting"].includes(status.mergeableState.toLowerCase());
}

function isBotUser(user: any): boolean {
  return user?.type === "Bot" || String(user?.login || "").endsWith("[bot]");
}

function firstMeaningfulLine(body: string): string {
  const line = body
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("<!--"));
  return line || "(empty)";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
