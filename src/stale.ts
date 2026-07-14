import type { App } from "octokit";
import type { Config } from "./config.js";
import { STALE_REVIEW_SELF_TRIGGER_EVENT, STALE_SELF_TRIGGER_ACTION_KIND } from "./events.js";
import {
  closePullRequest,
  getPullRequestStatus,
  requestChangesPullRequest,
  REVIEW_AGENT_NAME,
  type PullRequestStatus,
  type RepoRef,
} from "./github.js";
import { BOT_GITHUB_LOGIN, bodyIncludesBotStatusMarker, botStatusMarker } from "./identity.js";

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

export type ReviewSignal = {
  kind: "action-required" | "merge-conflict";
  at: string;
  author: string;
  headSha?: string;
  actionKind?: string;
  blockedKind?: string;
  summary: string;
};

type ReviewResponse = {
  kind: "issue-comment" | "review-comment" | "review" | "commit";
  at: string;
  atMs: number;
  author: string;
  summary: string;
};

export type StaleReviewCandidate = {
  repo: RepoRef;
  prNumber: number;
  title: string;
  url: string;
  headSha: string;
  signal: ReviewSignal;
  thresholdMs: number;
  staleMs: number;
};

export type StaleReviewSelfTriggerRequest = StaleReviewCandidate & {
  installationId: number;
  response: ReviewResponse;
};

type StaleReviewAction =
  | { type: "close"; candidate: StaleReviewCandidate }
  | { type: "self-trigger"; request: StaleReviewSelfTriggerRequest };

type StaleReviewSelfTriggerHandler = (
  octokit: Octokit,
  request: StaleReviewSelfTriggerRequest,
) => Promise<boolean | void>;

const STALE_CLOSED_MARKER_TEXT = botStatusMarker("stale-closed");

export class StaleReviewMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;

  constructor(
    private readonly app: App,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly selfTrigger?: StaleReviewSelfTriggerHandler,
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
    let installationsChecked = 0;
    let repositoriesChecked = 0;
    let prsChecked = 0;
    let prsSelfTriggered = 0;
    let prsClosed = 0;

    for await (const { octokit, installation } of this.app.eachInstallation.iterator()) {
      if (prsChecked >= this.config.staleReviewMaxPrsPerScan) {
        break;
      }

      installationsChecked += 1;
      const repositories = await listInstallationRepositories(octokit);
      for (const repository of repositories) {
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

          const action = await findStaleReviewAction(
            octokit,
            repo,
            pr,
            installation.id,
            this.config.staleReviewThresholdMs,
            Date.now(),
          );
          if (!action) {
            continue;
          }

          if (action.type === "self-trigger") {
            if (!this.selfTrigger) {
              this.logger.warn(
                {
                  repo: repo.fullName,
                  prNumber: action.request.prNumber,
                  headSha: action.request.headSha,
                },
                "stale review self-trigger skipped because no handler is configured",
              );
              continue;
            }
            const queued = await this.selfTrigger?.(octokit, action.request);
            if (queued !== false) {
              prsSelfTriggered += 1;
            }
            this.logger.info(
              {
                repo: repo.fullName,
                prNumber: action.request.prNumber,
                headSha: action.request.headSha,
                signalAt: action.request.signal.at,
                responseAt: action.request.response.at,
                responseKind: action.request.response.kind,
                queued: queued !== false,
              },
              "stale review self-trigger queued",
            );
            continue;
          }

          const { candidate } = action;
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
    }

    this.logger.info(
      {
        installationsChecked,
        repositoriesChecked,
        prsChecked,
        prsSelfTriggered,
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

async function listInstallationRepositories(octokit: Octokit): Promise<any[]> {
  return octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, {
    per_page: 100,
  });
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

async function findStaleReviewAction(
  octokit: Octokit,
  repo: RepoRef,
  pr: PullRequest,
  installationId: number,
  thresholdMs: number,
  nowMs: number,
): Promise<StaleReviewAction | null> {
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

  const status = await getPullRequestStatus(octokit, repo, pr.number);
  const blockingKind = signal.blockedKind || signal.actionKind;
  if (blockingKind === "status-check" && !hasBlockingStatusChecks(status)) {
    return null;
  }
  if ((signal.kind === "merge-conflict" || blockingKind === "merge-conflict") && !hasMergeConflict(status)) {
    return null;
  }

  const candidate: StaleReviewCandidate = {
    repo,
    prNumber: pr.number,
    title: pr.title,
    url: pr.html_url || `https://github.com/${repo.fullName}/pull/${pr.number}`,
    headSha: pr.head.sha,
    signal,
    thresholdMs,
    staleMs: nowMs - signalAtMs,
  };

  if (signal.actionKind === STALE_SELF_TRIGGER_ACTION_KIND) {
    return { type: "close", candidate };
  }

  const response = latestResponseAfterSignal(signalAtMs, issueComments, reviewComments, reviews, commits);
  if (response && response.atMs > signalAtMs) {
    return {
      type: "self-trigger",
      request: {
        ...candidate,
        installationId,
        response,
      },
    };
  }

  return { type: "close", candidate };
}

export function latestReviewSignal(issueComments: any[], reviews: any[], headSha: string): ReviewSignal | null {
  const states = [
    ...issueComments.flatMap((comment) => reviewStateFromBody(
      comment.body,
      comment.created_at,
      comment.user,
      headSha,
    )),
    ...reviews.flatMap((review) => reviewStateFromBody(
      review.body,
      review.submitted_at,
      review.user,
      headSha,
    )),
  ];

  states.sort((left, right) => {
    const timeDifference = Date.parse(right.at) - Date.parse(left.at);
    if (timeDifference !== 0) {
      return timeDifference;
    }

    // GitHub timestamps may have only second precision. In a tie, prefer the
    // nonblocking state so the scanner cannot close a PR after it was settled.
    return Number(right.resolved) - Number(left.resolved);
  });
  return states[0]?.signal || null;
}

type ReviewState = {
  at: string;
  resolved: boolean;
  signal: ReviewSignal | null;
};

function reviewStateFromBody(
  body: string | undefined,
  at: string | undefined,
  user: any,
  headSha: string,
): ReviewState[] {
  if (!body || !at || !isBotUser(user)) {
    return [];
  }

  const markerHeadSha = markerHeadShaFromBody(body);
  if (markerHeadSha && markerHeadSha !== headSha) {
    return [];
  }

  if (bodyIncludesBotStatusMarker(body, "no-action-required")) {
    // A no-action marker without a recorded HEAD is too ambiguous to resolve a
    // current-HEAD blocker. Current bot writers always include the HEAD.
    return markerHeadSha === headSha ? [{ at, resolved: true, signal: null }] : [];
  }

  const signals = signalFromBody(body, at, user, headSha);
  return signals.map((signal) => {
    // Older conservative-gate ABSTAIN comments used generic `kind=review`.
    // They represented uncertainty, not an author-owned defect. New actionable
    // markers use explicit kinds such as review-test and review-fatal.
    const resolved = signal.kind === "action-required" && signal.actionKind === "review";
    return {
      at,
      resolved,
      signal: resolved ? null : signal,
    };
  });
}

function signalFromBody(body: string | undefined, at: string | undefined, user: any, headSha: string): ReviewSignal[] {
  if (!body || !at || !isBotUser(user)) {
    return [];
  }

  const markerHeadSha = markerHeadShaFromBody(body);
  if (markerHeadSha && markerHeadSha !== headSha) {
    return [];
  }

  if (bodyIncludesBotStatusMarker(body, "action-required")) {
    return [{
      kind: "action-required",
      at,
      author: user.login || "unknown",
      headSha: markerHeadSha,
      actionKind: markerActionKindFromBody(body),
      blockedKind: markerAttributeFromBody(body, "blocked_kind"),
      summary: firstMeaningfulLine(body),
    }];
  }

  if (bodyIncludesBotStatusMarker(body, "merge-conflict")) {
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

function latestResponseAfterSignal(
  signalAtMs: number,
  issueComments: any[],
  reviewComments: any[],
  reviews: any[],
  commits: any[],
): ReviewResponse | null {
  const responses: ReviewResponse[] = [
    ...issueComments.filter((comment) => !isBotUser(comment.user)).map((comment) => ({
      kind: "issue-comment" as const,
      at: comment.created_at,
      atMs: Date.parse(comment.created_at),
      author: comment.user?.login || "unknown",
      summary: firstMeaningfulLine(comment.body || ""),
    })),
    ...reviewComments.filter((comment) => !isBotUser(comment.user)).map((comment) => ({
      kind: "review-comment" as const,
      at: comment.created_at,
      atMs: Date.parse(comment.created_at),
      author: comment.user?.login || "unknown",
      summary: firstMeaningfulLine(comment.body || ""),
    })),
    ...reviews.filter((review) => !isBotUser(review.user)).map((review) => ({
      kind: "review" as const,
      at: review.submitted_at,
      atMs: Date.parse(review.submitted_at),
      author: review.user?.login || "unknown",
      summary: firstMeaningfulLine(review.body || ""),
    })),
    ...commits.map((commit) => {
      const at = commit.commit?.committer?.date || commit.commit?.author?.date;
      return {
        kind: "commit" as const,
        at,
        atMs: Date.parse(at),
        author: commit.author?.login || commit.commit?.author?.name || "unknown",
        summary: commit.commit?.message?.split("\n")[0] || commit.sha || "(commit)",
      };
    }),
  ].filter((response) => Number.isFinite(response.atMs) && response.atMs > signalAtMs);

  if (responses.length === 0) {
    return null;
  }

  responses.sort((left, right) => right.atMs - left.atMs);
  return responses[0]!;
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

export function staleSelfTriggerDedupeKey(request: StaleReviewSelfTriggerRequest): string {
  return [
    STALE_REVIEW_SELF_TRIGGER_EVENT,
    request.repo.fullName,
    request.prNumber,
    request.headSha,
    request.response.at,
  ].join(":");
}

export function staleSelfTriggerPayload(request: StaleReviewSelfTriggerRequest): any {
  return {
    action: "stale_self_trigger",
    installation: {
      id: request.installationId,
    },
    repository: {
      owner: {
        login: request.repo.owner,
      },
      name: request.repo.repo,
      full_name: request.repo.fullName,
      private: request.repo.isPrivate,
    },
    pull_request: {
      number: request.prNumber,
      title: request.title,
      html_url: request.url,
      head: {
        sha: request.headSha,
      },
    },
    stale_review: {
      head_sha: request.headSha,
      signal_at: request.signal.at,
      signal_kind: request.signal.kind,
      signal_action_kind: request.signal.actionKind,
      signal_author: request.signal.author,
      response_at: request.response.at,
      response_kind: request.response.kind,
      response_author: request.response.author,
      response_summary: request.response.summary,
      threshold_ms: request.thresholdMs,
      stale_ms: request.staleMs,
    },
    sender: {
      login: BOT_GITHUB_LOGIN,
      type: "Bot",
    },
  };
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
  return markerAttributeFromBody(body, "kind");
}

function markerAttributeFromBody(body: string, name: string): string | undefined {
  return body.match(new RegExp(`\\b${name}=([^\\s>]+)`, "i"))?.[1];
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
