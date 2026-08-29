import { createHash } from "node:crypto";
import type { AiReviewProviderName, Config } from "./config.js";
import { CI_RECHECK_EVENT, STALE_REVIEW_SELF_TRIGGER_EVENT, STALE_SELF_TRIGGER_ACTION_KIND } from "./events.js";
import { GeminiClient, isAiProviderCooldownError } from "./gemini.js";
import { metrics, type GaugeSample } from "./metrics.js";
import {
  approvePullRequest,
  buildPullRequestContext,
  listExplicitAcceptanceCriteria,
  closePullRequest,
  completeCheck,
  completeLatestOwnReviewCheck,
  completeLatestOwnReviewCheckAsSuccess,
  createInProgressCheck,
  getPullRequestStatus,
  isReviewThreadResolved,
  isPullRequestIssue,
  isTrustedAssociation,
  listReviewThreads,
  postFileReviewComment,
  postPrComment,
  postReviewCommentReply,
  requestChangesPullRequest,
  resolveReviewThread,
  pullRequestConversationHasMarker,
  REVIEW_AGENT_NAME,
  repoFromPayload,
  shouldAutomaticallyReviewPullRequest,
  shouldHandleRepository,
  squashMergePullRequest,
  submitReviewWithInlineComments,
  type CheckConclusion,
  type InlineReviewComment,
  type PullRequestContext,
  type PullRequestContextOptions,
  type PullRequestStatus,
  type RepoRef,
  type ReviewSubmitEvent,
  type ReviewTrigger,
  updateInProgressCheck,
} from "./github.js";
import type {
  CachedReviewRun,
  ReviewFindingStore,
  ReviewGateFindingStore,
} from "./workflow.js";
import {
  isBlocking,
  isBlockingAfterConvergence,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  type ClassifiedFinding,
  type StoredFinding,
} from "./review.js";
import { OperationsNotifier, type ApprovalNotificationMode } from "./notifications.js";
import { parseBotCommand, truncate } from "./text.js";
import type { ReviewRunRecord } from "./review-run.js";
import { type MiniMaxReviewCandidate } from "./minimax-review.js";
import {
  REVIEW_GATE_PROMPT_VERSION,
  buildReviewGateCandidateSystemPrompt,
  buildReviewGateVerifierSystemPrompt,
} from "./review-gate-prompt.js";
import {
  evaluateMiniMaxReviewGateCandidates,
} from "./review-gate-pipeline.js";
import {
  fingerprintReviewFinding,
  hashReviewFindingEvidence,
  reconcileReviewFindingLedger,
  refuteReviewFinding,
  type ReviewFindingCandidate,
  type ReviewFindingRegressionEvidence,
  type StoredReviewFinding,
} from "./review-finding-ledger.js";
import {
  formatReviewGateCheckOutput,
  formatReviewGateFinding,
  type ReviewGatePublicFinding,
  type ReviewGatePublicVerdict,
} from "./review-gate-format.js";
import { buildReviewGateDisclosure } from "./review-gate-disclosure.js";
import { resolveReviewTurnVerdict } from "./review-turn.js";
import {
  evaluateReviewAcceptanceCoverage,
  groundedAcceptanceCriteriaFromReviewRun,
  mergeStickyAcceptanceCoverage,
  mergeStickyAcceptanceCoverageHistory,
  normalizeReviewAcceptanceEvidence,
  type StickyAcceptanceCoverageHistory,
} from "./review-acceptance-coverage.js";
import {
  buildReviewEvidenceCandidates,
  formatReviewEvidenceCandidates,
  type ReviewEvidenceCandidate,
} from "./review-grounding.js";
import {
  REVIEW_GATE_CACHE_SCHEMA_VERSION,
  decodeReviewGateCache,
  encodeReviewGateCache,
  filterReviewGateCacheCandidates,
  type MiniMaxReviewGateCacheEnvelope,
} from "./review-gate-cache.js";
import {
  BOT_GITHUB_LOGIN,
  isBotGithubAuthor,
  bodyIncludesBotActionMarker,
  botActionMarker,
  botAutoSquashMergeFailedMarker,
  botStatusMarker,
  isBotActionMarkerLine,
} from "./identity.js";
import {
  ACCEPTANCE_GUIDE_INCOMPLETE_MARKER,
  ACCEPTANCE_GUIDE_PUBLICATION_MARKER,
  acceptanceGuideCheckState,
  buildAcceptanceGuide,
  formatAcceptanceGuideThread,
  type AcceptanceGuideOutput,
} from "./acceptance-guide.js";

const NO_ACTION_REQUIRED_MARKER = botStatusMarker("no-action-required");
const ACTION_REQUIRED_MARKER = botStatusMarker("action-required");
const MERGE_CONFLICT_MARKER = botStatusMarker("merge-conflict");
const REVIEW_DEFERRED_MARKER = botStatusMarker("review-deferred");
const AGENT_APPROVE_MARKER = botActionMarker("approve");
const AGENT_COMMENT_MARKER = botActionMarker("comment");
const AGENT_CLOSE_MARKER = botActionMarker("close");
const NO_ACTIONABLE_FINDINGS_TEXT = "조치할 항목 없음.";
const AUTO_SQUASH_MERGE_FAILED_MARKER = botAutoSquashMergeFailedMarker();
const REVIEW_GATE_METADATA_RESERVE_CHARS = 4_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type AgentReplyTarget =
  | { type: "pr_comment" }
  | { type: "review_comment"; commentId: number };

type AgentRunOptions = {
  staleSelfTrigger?: {
    signalAt?: string;
    responseAt?: string;
    responseKind?: string;
  };
};

type GeneratedText = {
  text: string;
  headSha: string;
};

type OffloadedFinding = {
  finding: ClassifiedFinding;
  issueNumber: number;
  url: string;
};

type ReviewGateLedgerSnapshot = {
  records: Array<{
    finding: StoredReviewFinding;
    reviewCommentId: number | null;
    threadNodeId: string | null;
  }>;
  expectedHeadByFingerprint: Map<string, string | null>;
  expectedContextByFingerprint: Map<string, string | null>;
  publishedFingerprints: Set<string>;
  threadByFingerprint: Map<string, { threadId: string; commentId: number | null }>;
};

type Logger = {
  info: (value: unknown, message?: string) => void;
  warn: (value: unknown, message?: string) => void;
  error: (value: unknown, message?: string) => void;
};

type Octokit = any;

type ActiveCheckRun = {
  key: number;
  octokit: Octokit;
  repo: RepoRef;
  checkRunId: number;
  prNumber: number;
  headSha: string;
  kind: WorkflowCheckKind;
  durable: boolean;
};

type WorkflowCheckKind = "review" | "agent" | "ci_recheck";

export type WorkflowCheckRecord = {
  checkRunId: number;
  kind: WorkflowCheckKind;
  repoFullName: string;
  prNumber: number;
  headSha: string;
};

export type WorkflowTargetRecord = Omit<WorkflowCheckRecord, "checkRunId">;

export type ActiveReviewWorkflow = {
  workflowId: number;
  status: string;
  eventName: string;
  payload: any;
  checkRunId: number | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
};

export type WorkflowExecution = {
  workflowId?: number;
  createdAt?: Date | string;
  checkRunId?: number | null;
  installationId?: number;
  installationToken?: string;
  recordWorkflowTarget?: (record: WorkflowTargetRecord) => Promise<void>;
  recordCheckRun: (record: WorkflowCheckRecord) => Promise<void>;
  findActiveReview?: (record: WorkflowTargetRecord) => Promise<ActiveReviewWorkflow | null>;
  enqueueSynthetic?: (eventName: string, dedupeKey: string, payload: any, delayMs?: number) => Promise<boolean>;
  reviewFindingStore?: ReviewFindingStore;
  reviewGateFindingStore?: ReviewGateFindingStore;
  findCachedReviewGateRun?: (
    repoFullName: string,
    prNumber: number,
    headSha: string,
    promptVersion: string,
    contextSha256: string,
  ) => Promise<CachedReviewRun | null>;
  listLatestReviewGateRuns?: (
    repoFullName: string,
    prNumber: number,
  ) => Promise<CachedReviewRun[]>;
  recordReviewRun?: (record: ReviewRunRecord) => Promise<void>;
};

type CiRecheckRequest = {
  checkRunId: number;
  prNumber: number;
  headSha: string;
  mode: "review" | "review_gate" | "agent";
  sender: string;
  source: string;
  approvalReason: string;
  approvalBody: string;
  startedAt: string;
  attempt: number;
};

export class PrBot {
  private readonly gemini: GeminiClient;
  private readonly operationsNotifier: OperationsNotifier;
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly activeChecks = new Map<number, ActiveCheckRun>();
  private nextActiveCheckKey = 1;
  private shuttingDown = false;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.operationsNotifier = new OperationsNotifier(config, logger);
    this.gemini = new GeminiClient(config, logger, (event) => this.operationsNotifier.notifyQuotaEvent(event));
  }

  scheduleIssueComment(event: any): void {
    this.background("issue_comment", event.payload, async () => {
      await this.handleIssueComment(event.octokit, event.payload);
    });
  }

  scheduleReviewComment(event: any): void {
    this.background("pull_request_review_comment", event.payload, async () => {
      await this.handleReviewComment(event.octokit, event.payload);
    });
  }

  schedulePullRequestReview(event: any): void {
    this.background("pull_request_review", event.payload, async () => {
      await this.handlePullRequestReview(event.octokit, event.payload);
    });
  }

  schedulePullRequestReviewThread(event: any): void {
    this.background("pull_request_review_thread", event.payload, async () => {
      await this.handlePullRequestReviewThread(event.octokit, event.payload);
    });
  }

  schedulePullRequest(event: any): void {
    this.background("pull_request", event.payload, async () => {
      await this.handlePullRequest(event.octokit, event.payload);
    });
  }

  metricSamples(): GaugeSample[] {
    return [
      {
        name: "seori_pr_bot_active_tasks",
        value: this.activeTasks.size,
      },
      {
        name: "seori_pr_bot_active_check_runs",
        value: this.activeChecks.size,
      },
      ...this.gemini.metricSamples(),
    ];
  }

  async processEvent(
    octokit: Octokit,
    eventName: string,
    payload: any,
    workflow?: WorkflowExecution,
  ): Promise<void> {
    if (eventName === "issue_comment") {
      await this.handleIssueComment(octokit, payload, workflow);
      return;
    }

    if (eventName === "pull_request_review_comment") {
      await this.handleReviewComment(octokit, payload, workflow);
      return;
    }

    if (eventName === "pull_request_review") {
      await this.handlePullRequestReview(octokit, payload, workflow);
      return;
    }

    if (eventName === "pull_request_review_thread") {
      await this.handlePullRequestReviewThread(octokit, payload);
      return;
    }

    if (eventName === "pull_request") {
      await this.handlePullRequest(octokit, payload, workflow);
      return;
    }

    if (eventName === CI_RECHECK_EVENT) {
      await this.handleCiRecheck(octokit, payload, workflow);
      return;
    }

    if (eventName === STALE_REVIEW_SELF_TRIGGER_EVENT) {
      await this.handleStaleReviewSelfTrigger(octokit, payload, workflow);
      return;
    }

    this.logger.warn({ event: eventName }, "unsupported webhook event ignored");
  }

  private background(name: string, payload: any, task: () => Promise<void>): void {
    const repo = payload.repository?.full_name;
    const delivery = payload.delivery;
    if (this.shuttingDown) {
      this.logger.warn({ event: name, repo, delivery }, "webhook task ignored during shutdown");
      return;
    }

    setImmediate(() => {
      if (this.shuttingDown) {
        this.logger.warn({ event: name, repo, delivery }, "webhook task skipped during shutdown");
        return;
      }

      let promise: Promise<void>;
      promise = task()
        .catch((error) => {
          this.logger.error(
            {
              error,
              event: name,
              repo,
              delivery,
            },
            "background webhook task failed",
          );
        })
        .finally(() => {
          this.activeTasks.delete(promise);
        });

      this.activeTasks.add(promise);
    });
  }

  async shutdown(reason: string): Promise<void> {
    this.shuttingDown = true;

    const activeChecks = [...this.activeChecks.values()].filter((check) => !check.durable);
    this.logger.warn(
      {
        reason,
        activeTasks: this.activeTasks.size,
        activeChecks: activeChecks.length,
      },
      `${REVIEW_AGENT_NAME} shutdown started`,
    );

    const summary = [
      `${REVIEW_AGENT_NAME} 작업 실행 중 봇이 중지되었습니다.`,
      "",
      `사유: ${reason}`,
      "",
      "GitHub에 오래된 pending check가 남지 않도록 이 작업은 cancelled로 표시했습니다.",
      "봇이 다시 올라온 뒤 필요하면 리뷰를 다시 요청하세요.",
    ].join("\n");

    const results = await Promise.allSettled(
      activeChecks.map((check) =>
        this.completeTrackedCheck(
          check,
          "cancelled",
          `${REVIEW_AGENT_NAME} job cancelled during bot shutdown`,
          summary,
        ),
      ),
    );
    await this.operationsNotifier.close();

    const failed = results.filter((result) => result.status === "rejected").length;
    this.logger.warn(
      {
        reason,
        cancelledChecks: activeChecks.length - failed,
        failed,
      },
      `${REVIEW_AGENT_NAME} shutdown completed`,
    );
  }

  private async handleIssueComment(octokit: Octokit, payload: any, workflow?: WorkflowExecution): Promise<void> {
    if (!shouldHandleRepository(payload, this.config) || payload.sender.type === "Bot") {
      return;
    }

    const command = parseBotCommand(payload.comment.body || "", this.config);
    if (!command || !isTrustedAssociation(payload.comment.author_association, this.config)) {
      return;
    }

    const repo = repoFromPayload(payload);
    const issueNumber = payload.issue.number;
    if (!payload.issue.pull_request && !(await isPullRequestIssue(octokit, repo, issueNumber))) {
      return;
    }
    if (await this.shouldIgnoreClosedPullRequest(octokit, repo, issueNumber)) {
      return;
    }

    if (command.mode === "help") {
      await postPrComment(octokit, repo, issueNumber, this.helpText());
      return;
    }

    if (command.mode === "approve" || command.mode === "force_approve") {
      if (this.config.acceptanceGuideModeEnabled) {
        await postPrComment(octokit, repo, issueNumber, this.acceptanceGuideApprovalDisabledText());
        return;
      }
      await this.runApprove(
        octokit,
        repo,
        issueNumber,
        payload.sender.login,
        command.request,
        { skipValidation: command.mode === "force_approve" },
      );
      return;
    }

    if (command.mode === "review") {
      await this.runAcceptanceGuideOnce(octokit, repo, issueNumber, {
        source: "issue_comment",
        sender: payload.sender.login,
        request: command.request,
      }, workflow);
      return;
    }

    if (command.mode === "agent") {
      if (this.config.acceptanceGuideModeEnabled) {
        await this.runAnswer(octokit, repo, issueNumber, command.request, {
          source: "issue_comment",
          sender: payload.sender.login,
        }, workflow);
        return;
      }
      await this.runAgent(octokit, repo, issueNumber, command.request, {
        source: "issue_comment",
        sender: payload.sender.login,
      }, { type: "pr_comment" }, workflow);
      return;
    }

    await this.runAnswer(octokit, repo, issueNumber, command.request, {
      source: "issue_comment",
      sender: payload.sender.login,
    }, workflow);
  }

  private async handleReviewComment(octokit: Octokit, payload: any, workflow?: WorkflowExecution): Promise<void> {
    if (!shouldHandleRepository(payload, this.config) || payload.sender.type === "Bot") {
      return;
    }

    const command = parseBotCommand(payload.comment.body || "", this.config);
    if (!command || !isTrustedAssociation(payload.comment.author_association, this.config)) {
      return;
    }

    const repo = repoFromPayload(payload);
    const prNumber = payload.pull_request.number;
    if (
      (await this.shouldIgnoreClosedPullRequest(octokit, repo, prNumber)) ||
      (await this.shouldIgnoreResolvedReviewThread(octokit, repo, prNumber, payload.comment.id))
    ) {
      return;
    }

    if (command.mode === "help") {
      await postReviewCommentReply(octokit, repo, prNumber, payload.comment.id, this.helpText());
      return;
    }

    if (command.mode === "approve" || command.mode === "force_approve") {
      if (this.config.acceptanceGuideModeEnabled) {
        await postReviewCommentReply(
          octokit,
          repo,
          prNumber,
          payload.comment.id,
          this.acceptanceGuideApprovalDisabledText(),
        );
        return;
      }
      await this.runApprove(
        octokit,
        repo,
        prNumber,
        payload.sender.login,
        command.request,
        { skipValidation: command.mode === "force_approve" },
      );
      return;
    }

    if (command.mode === "agent") {
      if (this.config.acceptanceGuideModeEnabled) {
        const generated = await this.createAnswerText(
          octokit,
          repo,
          prNumber,
          command.request,
          {
            source: "review_comment",
            sender: payload.sender.login,
          },
          workflow,
        );
        if (await this.currentStatusForPublish(
          octokit,
          repo,
          prNumber,
          generated.headSha,
          null,
        )) {
          await postReviewCommentReply(
            octokit,
            repo,
            prNumber,
            payload.comment.id,
            generated.text,
          );
        }
        return;
      }
      await this.runAgent(octokit, repo, prNumber, command.request, {
        source: "review_comment",
        sender: payload.sender.login,
      }, { type: "review_comment", commentId: payload.comment.id }, workflow);
      return;
    }

    const generated =
      command.mode === "review"
        ? this.config.acceptanceGuideModeEnabled
          ? null
          : await this.createReviewText(octokit, repo, prNumber, {
              source: "review_comment",
              sender: payload.sender.login,
              request: command.request,
            }, workflow)
        : await this.createAnswerText(octokit, repo, prNumber, command.request, {
            source: "review_comment",
            sender: payload.sender.login,
          }, workflow);

    if (command.mode === "review" && this.config.acceptanceGuideModeEnabled) {
      await this.runAcceptanceGuideOnce(octokit, repo, prNumber, {
        source: "review_comment",
        sender: payload.sender.login,
        request: command.request,
      }, workflow);
      return;
    }

    if (!generated || !(await this.currentStatusForPublish(octokit, repo, prNumber, generated.headSha, null))) {
      return;
    }

    await postReviewCommentReply(octokit, repo, prNumber, payload.comment.id, generated.text);
  }

  private async handlePullRequestReview(octokit: Octokit, payload: any, workflow?: WorkflowExecution): Promise<void> {
    if (!shouldHandleRepository(payload, this.config) || payload.sender.type === "Bot") {
      return;
    }

    const body = payload.review.body || "";
    const command = parseBotCommand(body, this.config);
    if (!command || !isTrustedAssociation(payload.review.author_association, this.config)) {
      return;
    }

    const repo = repoFromPayload(payload);
    const prNumber = payload.pull_request.number;
    if (await this.shouldIgnoreClosedPullRequest(octokit, repo, prNumber)) {
      return;
    }

    if (command.mode === "review") {
      await this.runAcceptanceGuideOnce(octokit, repo, prNumber, {
        source: "pull_request_review",
        sender: payload.sender.login,
        request: command.request,
      }, workflow);
      return;
    }

    if (command.mode === "approve" || command.mode === "force_approve") {
      if (this.config.acceptanceGuideModeEnabled) {
        await postPrComment(octokit, repo, prNumber, this.acceptanceGuideApprovalDisabledText());
        return;
      }
      await this.runApprove(
        octokit,
        repo,
        prNumber,
        payload.sender.login,
        command.request,
        { skipValidation: command.mode === "force_approve" },
      );
      return;
    }

    if (command.mode === "agent") {
      if (this.config.acceptanceGuideModeEnabled) {
        await this.runAnswer(octokit, repo, prNumber, command.request, {
          source: "pull_request_review",
          sender: payload.sender.login,
        }, workflow);
        return;
      }
      await this.runAgent(octokit, repo, prNumber, command.request, {
        source: "pull_request_review",
        sender: payload.sender.login,
      }, { type: "pr_comment" }, workflow);
      return;
    }

    await this.runAnswer(octokit, repo, prNumber, command.request, {
      source: "pull_request_review",
      sender: payload.sender.login,
    }, workflow);
  }

  private async handlePullRequest(octokit: Octokit, payload: any, workflow?: WorkflowExecution): Promise<void> {
    if (!shouldHandleRepository(payload, this.config)) {
      return;
    }

    const repo = repoFromPayload(payload);
    const action = payload.action;

    if (!(await shouldAutomaticallyReviewPullRequest(octokit, payload, this.config))) {
      this.logger.info(
        { repo: repo.fullName, action },
        "automatic pull request review rejected by public repository trust boundary",
      );
      return;
    }

    if (
      this.config.acceptanceGuideModeEnabled &&
      ["opened", "reopened", "synchronize"].includes(action)
    ) {
      if (
        (action === "synchronize" && !this.config.autoReviewOnSynchronize) ||
        (["opened", "reopened"].includes(action) && !this.config.autoReviewOnOpen)
      ) {
        return;
      }
      if (isBotGithubAuthor(String(payload.sender?.login || ""))) {
        return;
      }
      if (this.isAutoReviewIgnored(repo)) {
        this.logger.info({ repo: repo.fullName, action }, "automatic acceptance guide ignored for repository");
        return;
      }
      await this.runAcceptanceGuideOnce(
        octokit,
        repo,
        payload.pull_request.number,
        { source: `pull_request.${action}`, sender: payload.sender.login },
        workflow,
      );
      return;
    }

    if (payload.sender.type === "Bot") {
      if (
        this.config.dependencyFastPathEnabled &&
        ["opened", "reopened", "synchronize"].includes(action) &&
        !this.isAutoReviewIgnored(repo) &&
        this.isDependencyBumpPullRequest(payload.pull_request)
      ) {
        this.logger.info(
          { repo: repo.fullName, prNumber: payload.pull_request?.number, action, author: payload.pull_request?.user?.login },
          "dependency bump fast-path: skipping AI review, approving on CI pass",
        );
        await this.runReview(
          octokit,
          repo,
          payload.pull_request.number,
          { source: `pull_request.${action}`, sender: payload.sender.login },
          workflow,
          {
            fastPathApproval: {
              reason: "의존성 업데이트 PR이라 Gemini 리뷰 없이 CI(컴파일/테스트) 통과를 기준으로 자동 승인합니다.",
            },
          },
        );
      }
      return;
    }

    if (this.isAutoReviewIgnored(repo) && ["opened", "reopened", "synchronize"].includes(action)) {
      this.logger.info({ repo: repo.fullName, action }, "automatic pull request review ignored for repository");
      return;
    }

    if (["opened", "reopened"].includes(action) && this.config.autoReviewOnOpen) {
      await this.runReview(octokit, repo, payload.pull_request.number, {
        source: `pull_request.${action}`,
        sender: payload.sender.login,
      }, workflow);
      return;
    }

    if (action === "synchronize" && this.config.autoReviewOnSynchronize) {
      await this.runReview(octokit, repo, payload.pull_request.number, {
        source: "pull_request.synchronize",
        sender: payload.sender.login,
      }, workflow);
    }
  }

  private async handlePullRequestReviewThread(octokit: Octokit, payload: any): Promise<void> {
    if (!this.config.acceptanceGuideModeEnabled || !shouldHandleRepository(payload, this.config)) {
      return;
    }
    const repo = repoFromPayload(payload);
    const prNumber = Number(payload.pull_request?.number);
    if (!Number.isFinite(prNumber) || await this.shouldIgnoreClosedPullRequest(octokit, repo, prNumber)) {
      return;
    }
    await this.refreshAcceptanceGuideCheck(octokit, repo, prNumber);
  }

  private async handleStaleReviewSelfTrigger(
    octokit: Octokit,
    payload: any,
    workflow?: WorkflowExecution,
  ): Promise<void> {
    if (!shouldHandleRepository(payload, this.config)) {
      return;
    }

    const repo = repoFromPayload(payload);
    const prNumber = Number(payload.pull_request?.number);
    if (!Number.isFinite(prNumber)) {
      this.logger.warn({ repo: repo.fullName, payload }, "stale self-trigger payload missing PR number");
      return;
    }
    if (await this.shouldIgnoreClosedPullRequest(octokit, repo, prNumber)) {
      return;
    }
    if (this.config.acceptanceGuideModeEnabled) {
      await this.refreshAcceptanceGuideCheck(octokit, repo, prNumber);
      return;
    }

    const stale = payload.stale_review || {};
    const request = [
      "이 PR은 이전 Seori 조치 요청 이후 사람이 멘션 없이 응답했지만 후속 리뷰가 호출되지 않아 stale scanner가 자동 재확인을 시작했습니다.",
      `원래 조치 요청: ${stale.signal_at || "unknown"} (${stale.signal_action_kind || stale.signal_kind || "unknown"})`,
      `최근 응답: ${stale.response_at || "unknown"} (${stale.response_kind || "unknown"}) by @${stale.response_author || "unknown"}`,
      stale.response_summary ? `최근 응답 요약: ${stale.response_summary}` : "",
      "",
      "현재 HEAD 기준으로 남은 조치가 있는지 판단하세요.",
      "해결됐으면 approve, 문제가 남았으면 comment, 같은 인수조건이 반복 미충족이면 close를 선택하세요.",
    ].filter(Boolean).join("\n");

    await this.runAgent(
      octokit,
      repo,
      prNumber,
      request,
      {
        source: STALE_REVIEW_SELF_TRIGGER_EVENT,
        sender: BOT_GITHUB_LOGIN,
      },
      { type: "pr_comment" },
      workflow,
      {
        staleSelfTrigger: {
          signalAt: stale.signal_at,
          responseAt: stale.response_at,
          responseKind: stale.response_kind,
        },
      },
    );
  }

  private async handleCiRecheck(
    octokit: Octokit,
    payload: any,
    workflow?: WorkflowExecution,
  ): Promise<void> {
    if (!shouldHandleRepository(payload, this.config)) {
      return;
    }

    const repo = repoFromPayload(payload);
    const request = this.ciRecheckRequest(payload);
    if (!request) {
      this.logger.warn({ repo: repo.fullName, payload }, "CI recheck payload missing required fields");
      return;
    }

    if (this.config.acceptanceGuideModeEnabled) {
      await completeCheck(
        octokit,
        repo,
        request.checkRunId,
        "neutral",
        "승인 재확인 비활성화",
        "Seori는 인수조건 안내 모드로 전환되어 CI 완료 후 approval을 제출하지 않습니다.",
      );
      return;
    }

    await workflow?.recordCheckRun({
      checkRunId: request.checkRunId,
      kind: "ci_recheck",
      repoFullName: repo.fullName,
      prNumber: request.prNumber,
      headSha: request.headSha,
    });

    const status = await getPullRequestStatus(octokit, repo, request.prNumber);
    if (this.isClosedPullRequest(status)) {
      await completeCheck(
        octokit,
        repo,
        request.checkRunId,
        "cancelled",
        "닫힌 PR 승인 취소",
        [
          "CI 재확인 중 PR이 닫히거나 병합되어 approval을 제출하지 않았습니다.",
          "",
          `상태: \`${status.state}\``,
          `병합 여부: \`${status.merged}\``,
          `HEAD: \`${status.headSha}\``,
        ].join("\n"),
      );
      return;
    }

    if (status.headSha !== request.headSha) {
      await completeCheck(
        octokit,
        repo,
        request.checkRunId,
        "cancelled",
        "오래된 CI 재확인 취소",
        [
          "CI 재확인 중 PR HEAD가 바뀌어 이전 HEAD의 approval을 제출하지 않았습니다.",
          "",
          `기존 HEAD: \`${request.headSha}\``,
          `현재 HEAD: \`${status.headSha}\``,
        ].join("\n"),
      );
      return;
    }

    if (this.hasMergeConflict(status)) {
      await completeCheck(
        octokit,
        repo,
        request.checkRunId,
        "action_required",
        "병합 충돌 해결 필요",
        this.mergeConflictText(repo, request.prNumber, status),
      );
      return;
    }

    if (this.hasFailingStatusChecks(status)) {
      const blockerText = this.actionRequiredText("status-check", status.headSha, this.statusCheckBlockerText(status));
      await postPrComment(octokit, repo, request.prNumber, blockerText);
      await completeCheck(octokit, repo, request.checkRunId, "action_required", "상태 체크 확인 필요", blockerText);
      return;
    }

    if (this.hasPendingStatusChecks(status)) {
      if (this.isCiRecheckTimedOut(request)) {
        const timeoutText = this.actionRequiredText("status-check-timeout", status.headSha, this.ciTimeoutBlockerText(status));
        await postPrComment(octokit, repo, request.prNumber, timeoutText);
        await completeCheck(octokit, repo, request.checkRunId, "action_required", "CI 대기 시간 초과", timeoutText);
        return;
      }

      await this.deferCiRecheck(octokit, repo, status, request, workflow, this.config.ciRecheckIntervalMs);
      return;
    }

    await this.approveAndNotify(
      octokit,
      repo,
      request.prNumber,
      status,
      this.approvalText(request.sender, request.approvalReason, status.headSha, request.approvalBody),
      {
        mode: request.mode,
        sender: request.sender,
        source: `ci_recheck:${request.source}`,
        reason: request.approvalReason,
      },
    );
    await completeCheck(
      octokit,
      repo,
      request.checkRunId,
      "success",
      request.mode === "review_gate" ? "보수적 Gate 통과" : "PR 승인 완료",
      request.approvalBody,
    );
    await this.maybeSquashMergeApprovedPullRequest(
      octokit,
      repo,
      request.prNumber,
      status.headSha,
      request.mode,
    );
  }

  private isAutoReviewIgnored(repo: RepoRef): boolean {
    const ignored = this.config.autoReviewIgnoredRepositories;
    return ignored.has(repo.fullName.toLowerCase()) || ignored.has(repo.repo.toLowerCase());
  }

  private isDependencyBumpPullRequest(pullRequest: any): boolean {
    if (!pullRequest) {
      return false;
    }

    const author = String(pullRequest.user?.login || "").toLowerCase();
    if (author && this.config.dependencyFastPathAuthors.has(author)) {
      return true;
    }

    const labels: string[] = Array.isArray(pullRequest.labels)
      ? pullRequest.labels.map((label: any) => String(label?.name || "").toLowerCase())
      : [];
    return labels.some((label) => this.config.dependencyFastPathLabels.has(label));
  }

  private dependencyFastPathReviewText(reason: string): string {
    return [
      reason,
      "",
      "이 PR은 의존성 업데이트(dependabot/renovate)로 분류되어 Seori의 AI 코드 리뷰를 생략했습니다.",
      "GitHub 상태 체크(컴파일/테스트 등)가 모두 통과하면 자동 승인하고, 실패하거나 대기 중이면 승인을 보류합니다.",
      "",
      NO_ACTIONABLE_FINDINGS_TEXT,
    ].join("\n");
  }

  private acceptanceGuideApprovalDisabledText(): string {
    return [
      "Seori는 현재 인수조건 안내 모드로 운영되어 GitHub approval을 제출하지 않습니다.",
      "누락 또는 소명이 필요한 Seori review thread에 답한 뒤 Resolve하면 required check가 갱신됩니다.",
    ].join("\n");
  }

  private async runAcceptanceGuideOnce(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    trigger: ReviewTrigger,
    workflow?: WorkflowExecution,
  ): Promise<void> {
    if (!this.config.acceptanceGuideModeEnabled) {
      await this.runReview(octokit, repo, prNumber, trigger, workflow);
      return;
    }

    const published = await pullRequestConversationHasMarker(
      octokit,
      repo,
      prNumber,
      ACCEPTANCE_GUIDE_PUBLICATION_MARKER,
    );
    if (published) {
      this.logger.info(
        { repo: repo.fullName, prNumber, source: trigger.source },
        "acceptance guide already published; refreshing thread check without AI",
      );
      await this.refreshAcceptanceGuideCheck(octokit, repo, prNumber);
      return;
    }

    await this.runReview(octokit, repo, prNumber, trigger, workflow);
  }

  private async refreshAcceptanceGuideCheck(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
  ): Promise<void> {
    const status = await getPullRequestStatus(octokit, repo, prNumber);
    if (this.isClosedPullRequest(status)) {
      return;
    }

    try {
      const incomplete = await pullRequestConversationHasMarker(
        octokit,
        repo,
        prNumber,
        ACCEPTANCE_GUIDE_INCOMPLETE_MARKER,
      );
      if (incomplete) {
        await completeLatestOwnReviewCheck(
          octokit,
          repo,
          status.headSha,
          "neutral",
          "인수조건 스레드 게시 불완전",
          "최초 안내 일부를 resolvable review thread로 게시하지 못했습니다. 안내 기능의 오류만으로 병합을 막지 않습니다.",
        );
        return;
      }
      const threads = await listReviewThreads(octokit, repo, prNumber);
      const state = acceptanceGuideCheckState(threads);
      await completeLatestOwnReviewCheck(
        octokit,
        repo,
        status.headSha,
        state.conclusion,
        state.title,
        state.summary,
      );
    } catch (error) {
      this.logger.warn(
        { error, repo: repo.fullName, prNumber, headSha: status.headSha },
        "acceptance guide thread refresh failed",
      );
      await completeLatestOwnReviewCheck(
        octokit,
        repo,
        status.headSha,
        "neutral",
        "인수조건 스레드 상태 확인 불가",
        "GitHub review thread 상태를 읽지 못했습니다. 안내 기능의 오류만으로 병합을 막지 않습니다.",
      );
    }
  }

  private async publishAcceptanceGuide(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    context: PullRequestContext,
    check: ActiveCheckRun | null,
    guide: AcceptanceGuideOutput,
    inconclusive = false,
  ): Promise<void> {
    if (!(await this.currentStatusForPublish(
      octokit,
      repo,
      prNumber,
      context.headSha,
      check,
    ))) {
      return;
    }
    const paths = [...context.changedFilePaths];
    let threadPublicationFailed = false;

    if (guide.items.length > 0 && paths.length === 0) {
      threadPublicationFailed = true;
    } else {
      for (let index = 0; index < guide.items.length; index += 1) {
        const item = guide.items[index]!;
        try {
          await postFileReviewComment(
            octokit,
            repo,
            prNumber,
            context.headSha,
            paths[index % paths.length]!,
            formatAcceptanceGuideThread(item),
          );
        } catch (error) {
          threadPublicationFailed = true;
          this.logger.warn(
            {
              error,
              repo: repo.fullName,
              prNumber,
              headSha: context.headSha,
              itemId: item.id,
            },
            "acceptance guide file review comment failed",
          );
        }
      }
    }

    const publicationNote = threadPublicationFailed
      ? [
          "",
          ACCEPTANCE_GUIDE_INCOMPLETE_MARKER,
          "일부 안내 항목을 resolvable review thread로 게시하지 못했습니다.",
          "GitHub 스레드 생성 실패만으로 병합을 막지 않습니다.",
        ].join("\n")
      : "";
    await postPrComment(octokit, repo, prNumber, `${guide.summary}${publicationNote}`);

    if (inconclusive || threadPublicationFailed) {
      await this.completeTrackedCheck(
        check,
        "neutral",
        inconclusive ? "인수조건 가이드 생성 불가" : "인수조건 스레드 게시 불완전",
        `${guide.summary}${publicationNote}`,
      );
      return;
    }

    const hasOpenItems = guide.items.length > 0;
    await this.completeTrackedCheck(
      check,
      hasOpenItems ? "action_required" : "success",
      hasOpenItems ? "인수조건 확인 필요" : "인수조건 가이드 완료",
      guide.summary,
    );
  }

  private async runReview(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    trigger: ReviewTrigger,
    workflow?: WorkflowExecution,
    options: { fastPathApproval?: { reason: string } } = {},
  ): Promise<void> {
    const context = await buildPullRequestContext(octokit, repo, prNumber, this.config, this.contextOptions(workflow, trigger.request));
    if (this.shuttingDown || (this.isClosedPullRequest(context) && !workflow?.checkRunId)) {
      return;
    }

    const target: WorkflowTargetRecord = {
      kind: "review",
      repoFullName: repo.fullName,
      prNumber,
      headSha: context.headSha,
    };
    await workflow?.recordWorkflowTarget?.(target);

    const activeReview = await workflow?.findActiveReview?.(target);
    if (activeReview && this.shouldCoalesceReviewRequest(activeReview, trigger)) {
      await this.coalesceReviewRequest(octokit, repo, prNumber, context.headSha, trigger, activeReview);
      return;
    }

    const check = await this.createTrackedCheck(octokit, repo, prNumber, context.headSha, "review", workflow);

    try {
      if (this.isClosedPullRequest(context)) {
        await this.currentStatusForPublish(octokit, repo, prNumber, context.headSha, check);
        return;
      }

      if (this.hasMergeConflict(context)) {
        const latest = await this.currentStatusForPublish(octokit, repo, prNumber, context.headSha, check);
        if (!latest) {
          return;
        }
        if (!this.hasMergeConflict(latest)) {
          await this.completeTrackedCheck(
            check,
            "cancelled",
            "오래된 병합 충돌 결과 취소",
            "병합 충돌 리뷰를 게시하기 전에 PR 상태가 바뀌었습니다. 필요하면 현재 HEAD 기준으로 다시 리뷰를 요청하세요.",
          );
          return;
        }

        const conflictText = this.mergeConflictText(repo, prNumber, latest);
        if (await this.cancelTrackedCheckIfShuttingDown(check, "리뷰 취소", "병합 충돌 리뷰를 게시하기 전에 봇이 중지되었습니다.")) {
          return;
        }

        await requestChangesPullRequest(octokit, repo, prNumber, conflictText, latest.headSha);
        await this.completeTrackedCheck(
          check,
          "action_required",
          "병합 충돌 해결 필요",
          conflictText,
        );
        return;
      }

      let reviewText: string;
      if (options.fastPathApproval) {
        reviewText = this.dependencyFastPathReviewText(options.fastPathApproval.reason);
      } else {
        if (this.config.structuredReviewEnabled) {
          await this.runStructuredReview(
            octokit,
            repo,
            prNumber,
            context,
            trigger,
            check,
            workflow,
          );
          return;
        }

        reviewText = await this.createReviewTextFromContext(context, trigger);
      }
      if (await this.cancelTrackedCheckIfShuttingDown(check, "리뷰 취소", "리뷰 결과를 게시하기 전에 봇이 중지되었습니다.")) {
        return;
      }
      const latest = await this.currentStatusForPublish(octokit, repo, prNumber, context.headSha, check);
      if (!latest) {
        return;
      }

      const approvalReason = options.fastPathApproval?.reason ?? "리뷰 결과 조치할 항목이 없습니다.";

      if (this.wantsApproval(reviewText) && this.hasFailingStatusChecks(latest)) {
        const blockerText = this.actionRequiredText("status-check", latest.headSha, this.statusCheckBlockerText(latest));
        await postPrComment(octokit, repo, prNumber, blockerText);
        await this.completeTrackedCheck(check, "action_required", "상태 체크 확인 필요", blockerText);
        return;
      }

      if (this.wantsApproval(reviewText) && this.shouldDeferApprovalForCi(trigger, latest)) {
        await this.deferApprovalUntilCiSettles(
          octokit,
          repo,
          prNumber,
          latest,
          check,
          workflow,
          {
            mode: "review",
            sender: trigger.sender,
            source: trigger.source,
            reason: approvalReason,
            body: reviewText,
          },
          this.hasPendingStatusChecks(latest) ? this.config.ciRecheckIntervalMs : this.config.ciInitialWaitMs,
        );
        return;
      }

      if (this.shouldApproveReviewText(reviewText, latest)) {
        await this.approveAndNotify(
          octokit,
          repo,
          prNumber,
          latest,
          this.approvalText(trigger.sender, approvalReason, latest.headSha, reviewText),
          {
            mode: "review",
            sender: trigger.sender,
            source: trigger.source,
            reason: approvalReason,
          },
        );
        await this.completeTrackedCheck(check, "success", "PR 승인 완료", reviewText);
        await this.maybeSquashMergeApprovedPullRequest(
          octokit,
          repo,
          prNumber,
          latest.headSha,
          "review",
        );
        return;
      }

      const actionRequiredText = this.actionRequiredText("review", latest.headSha, reviewText);
      await postPrComment(octokit, repo, prNumber, actionRequiredText);
      await this.completeTrackedCheck(check, "action_required", "조치 필요", actionRequiredText);
    } catch (error) {
      if (workflow && isAiProviderCooldownError(error)) {
        this.releaseTrackedCheck(check);
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      await this.completeTrackedCheck(check, "failure", "리뷰 실패", message);
      throw error;
    }
  }

  private shouldCoalesceReviewRequest(activeReview: ActiveReviewWorkflow, trigger: ReviewTrigger): boolean {
    if (activeReview.status !== "queued") {
      return true;
    }

    const activeTriggerKey = this.reviewTriggerKeyFromWorkflowPayload(activeReview.eventName, activeReview.payload);
    if (!activeTriggerKey) {
      return true;
    }

    return activeTriggerKey === this.reviewTriggerKey(trigger.source, trigger.request);
  }

  private async coalesceReviewRequest(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    headSha: string,
    trigger: ReviewTrigger,
    activeReview: ActiveReviewWorkflow,
  ): Promise<void> {
    this.logger.info(
      {
        repo: repo.fullName,
        prNumber,
        headSha,
        source: trigger.source,
        sender: trigger.sender,
        activeWorkflowId: activeReview.workflowId,
        activeStatus: activeReview.status,
        activeCheckRunId: activeReview.checkRunId,
      },
      "review request coalesced into active review workflow",
    );

    if (activeReview.status === "completed" || !activeReview.checkRunId) {
      return;
    }

    await updateInProgressCheck(
      octokit,
      repo,
      activeReview.checkRunId,
      "추가 리뷰 요청 접수",
      [
        "같은 PR HEAD에 대한 추가 리뷰 요청을 기존 진행 중인 리뷰에 합쳤습니다.",
        "",
        `PR: #${prNumber}`,
        `HEAD: \`${headSha}\``,
        `요청자: @${trigger.sender}`,
        `요청 출처: \`${trigger.source}\``,
        trigger.request ? `요청: ${truncate(trigger.request, 500)}` : undefined,
        `기존 workflow: \`${activeReview.workflowId}\``,
      ].filter(Boolean).join("\n"),
    );
  }

  private reviewTriggerKeyFromWorkflowPayload(eventName: string, payload: any): string | null {
    if (eventName === "pull_request") {
      const action = String(payload.action || "");
      if (["opened", "reopened", "synchronize"].includes(action)) {
        return this.reviewTriggerKey(`pull_request.${action}`, undefined);
      }
      return null;
    }

    if (eventName === "issue_comment") {
      const command = parseBotCommand(payload.comment?.body || "", this.config);
      return command?.mode === "review" ? this.reviewTriggerKey("issue_comment", command.request) : null;
    }

    if (eventName === "pull_request_review") {
      const command = parseBotCommand(payload.review?.body || "", this.config);
      return command?.mode === "review" ? this.reviewTriggerKey("pull_request_review", command.request) : null;
    }

    return null;
  }

  private reviewTriggerKey(source: string, request: string | undefined): string {
    return `${source}:${this.normalizeReviewRequest(request)}`;
  }

  private normalizeReviewRequest(request: string | undefined): string {
    return (request || "").replace(/\s+/g, " ").trim();
  }

  private async runAgent(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    request: string,
    trigger: ReviewTrigger,
    target: AgentReplyTarget,
    workflow?: WorkflowExecution,
    options: AgentRunOptions = {},
  ): Promise<void> {
    const context = await buildPullRequestContext(octokit, repo, prNumber, this.config, this.contextOptions(workflow, request));
    if (this.shuttingDown || (this.isClosedPullRequest(context) && !workflow?.checkRunId)) {
      return;
    }

    const check = await this.createTrackedCheck(octokit, repo, prNumber, context.headSha, "agent", workflow);

    try {
      if (this.isClosedPullRequest(context)) {
        await this.currentStatusForPublish(octokit, repo, prNumber, context.headSha, check);
        return;
      }

      if (this.hasMergeConflict(context)) {
        const latest = await this.currentStatusForPublish(octokit, repo, prNumber, context.headSha, check);
        if (!latest) {
          return;
        }
        if (!this.hasMergeConflict(latest)) {
          await this.completeTrackedCheck(
            check,
            "cancelled",
            "오래된 병합 충돌 응답 취소",
            "병합 충돌 응답을 게시하기 전에 PR 상태가 바뀌었습니다. 필요하면 현재 HEAD 기준으로 다시 리뷰를 요청하세요.",
          );
          return;
        }

        const conflictText = options.staleSelfTrigger
          ? this.agentActionRequiredText(
              "merge-conflict",
              latest.headSha,
              this.mergeConflictText(repo, prNumber, latest),
              options,
            )
          : this.mergeConflictText(repo, prNumber, latest);
        if (await this.cancelTrackedCheckIfShuttingDown(check, "에이전트 응답 취소", "병합 충돌 응답을 게시하기 전에 봇이 중지되었습니다.")) {
          return;
        }

        await requestChangesPullRequest(octokit, repo, prNumber, conflictText, latest.headSha);
        await this.completeTrackedCheck(
          check,
          "action_required",
          "병합 충돌 해결 필요",
          conflictText,
        );
        return;
      }

      const agentText = await this.createAgentTextFromContext(context, request, trigger);
      const publicText = this.publicAgentText(agentText);
      if (await this.cancelTrackedCheckIfShuttingDown(check, "에이전트 응답 취소", "에이전트 응답을 게시하기 전에 봇이 중지되었습니다.")) {
        return;
      }
      const latest = await this.currentStatusForPublish(octokit, repo, prNumber, context.headSha, check);
      if (!latest) {
        return;
      }

      if (this.wantsApproval(agentText) && this.hasFailingStatusChecks(latest)) {
        const blockerText = this.agentActionRequiredText(
          "status-check",
          latest.headSha,
          this.statusCheckBlockerText(latest),
          options,
        );
        await postPrComment(octokit, repo, prNumber, blockerText);
        await this.completeTrackedCheck(check, "action_required", "상태 체크 확인 필요", blockerText);
        return;
      }

      if (this.wantsApproval(agentText) && this.shouldDeferApprovalForCi(trigger, latest)) {
        await this.deferApprovalUntilCiSettles(
          octokit,
          repo,
          prNumber,
          latest,
          check,
          workflow,
          {
            mode: "agent",
            sender: trigger.sender,
            source: trigger.source,
            reason: "에이전트 판단 결과 조치할 항목이 없습니다.",
            body: publicText,
          },
          this.hasPendingStatusChecks(latest) ? this.config.ciRecheckIntervalMs : this.config.ciInitialWaitMs,
        );
        return;
      }

      if (this.shouldApproveAgentText(agentText, latest)) {
        await this.approveAndNotify(
          octokit,
          repo,
          prNumber,
          latest,
          this.approvalText(trigger.sender, "에이전트 판단 결과 조치할 항목이 없습니다.", latest.headSha, publicText),
          {
            mode: "agent",
            sender: trigger.sender,
            source: trigger.source,
            reason: "에이전트 판단 결과 조치할 항목이 없습니다.",
          },
        );
        await this.completeTrackedCheck(check, "success", "PR 승인 완료", publicText);
        await this.maybeSquashMergeApprovedPullRequest(
          octokit,
          repo,
          prNumber,
          latest.headSha,
          "agent",
        );
        return;
      }

      if (this.shouldCloseAgentText(agentText, latest)) {
        await requestChangesPullRequest(octokit, repo, prNumber, publicText, latest.headSha);
        await closePullRequest(octokit, repo, prNumber);
        await this.completeTrackedCheck(check, "action_required", "반복 미충족으로 PR 종료", publicText);
        return;
      }

      const commentText = this.agentCommentText(latest.headSha, publicText, options);
      if (target.type === "review_comment") {
        await postReviewCommentReply(octokit, repo, prNumber, target.commentId, commentText);
      } else {
        await postPrComment(octokit, repo, prNumber, commentText);
      }

      await this.completeTrackedCheck(check, "action_required", "조치 필요", commentText);
    } catch (error) {
      if (workflow && isAiProviderCooldownError(error)) {
        this.releaseTrackedCheck(check);
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      await this.completeTrackedCheck(check, "failure", "에이전트 처리 실패", message);
      throw error;
    }
  }

  private async createTrackedCheck(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    headSha: string,
    kind: ActiveCheckRun["kind"],
    workflow?: WorkflowExecution,
  ): Promise<ActiveCheckRun | null> {
    let checkRunId = workflow?.checkRunId ?? null;
    let createdCheckRun = false;
    if (!checkRunId) {
      checkRunId = await createInProgressCheck(octokit, repo, headSha);
      createdCheckRun = Boolean(checkRunId);
      if (checkRunId && workflow) {
        await workflow.recordCheckRun({
          checkRunId,
          kind,
          repoFullName: repo.fullName,
          prNumber,
          headSha,
        });
      }
    }

    if (!checkRunId) {
      return null;
    }

    const check: ActiveCheckRun = {
      key: this.nextActiveCheckKey,
      octokit,
      repo,
      checkRunId,
      prNumber,
      headSha,
      kind,
      durable: Boolean(workflow),
    };
    this.nextActiveCheckKey += 1;
    this.activeChecks.set(check.key, check);
    if (createdCheckRun) {
      metrics.recordCheckRunStarted(kind);
    }
    return check;
  }

  private async completeTrackedCheck(
    check: ActiveCheckRun | null,
    conclusion: CheckConclusion,
    title: string,
    summary: string,
  ): Promise<void> {
    if (!check) {
      return;
    }

    try {
      await completeCheck(check.octokit, check.repo, check.checkRunId, conclusion, title, summary);
      metrics.recordCheckRunCompleted(check.kind, conclusion);
    } finally {
      this.activeChecks.delete(check.key);
    }
  }

  private async discardStaleTrackedCheck(
    check: ActiveCheckRun | null,
    headSha: string,
  ): Promise<void> {
    if (!check) {
      return;
    }
    try {
      const { data } = await check.octokit.rest.checks.get({
        owner: check.repo.owner,
        repo: check.repo.repo,
        check_run_id: check.checkRunId,
      });
      if (data.status === "completed") {
        this.releaseTrackedCheck(check);
        return;
      }
      await this.completeTrackedCheck(
        check,
        "cancelled",
        "오래된 리뷰 결과 폐기",
        [
          `HEAD: \`${headSha}\``,
          "",
          "더 최신인 같은 HEAD 검증 결과가 저장되어 이 작업의 게시를 취소했습니다.",
        ].join("\n"),
      );
    } catch (error) {
      this.releaseTrackedCheck(check);
      this.logger.warn(
        { error, repo: check.repo.fullName, checkRunId: check.checkRunId },
        "failed to close stale review gate check",
      );
    }
  }

  private releaseTrackedCheck(check: ActiveCheckRun | null): void {
    if (check) {
      this.activeChecks.delete(check.key);
    }
  }

  private async cancelTrackedCheckIfShuttingDown(
    check: ActiveCheckRun | null,
    title: string,
    summary: string,
  ): Promise<boolean> {
    if (!this.shuttingDown) {
      return false;
    }

    await this.completeTrackedCheck(check, "cancelled", title, summary);
    return true;
  }

  private async deferApprovalUntilCiSettles(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    status: PullRequestStatus,
    check: ActiveCheckRun | null,
    workflow: WorkflowExecution | undefined,
    approval: {
      mode: "review" | "review_gate" | "agent";
      sender: string;
      source: string;
      reason: string;
      body: string;
    },
    delayMs: number,
  ): Promise<void> {
    if (!check) {
      this.logger.warn({ repo: repo.fullName, prNumber, headSha: status.headSha }, "CI recheck skipped without check-run");
      return;
    }

    const request: CiRecheckRequest = {
      checkRunId: check.checkRunId,
      prNumber,
      headSha: status.headSha,
      mode: approval.mode,
      sender: approval.sender,
      source: approval.source,
      approvalReason: approval.reason,
      approvalBody: approval.body,
      startedAt: new Date().toISOString(),
      attempt: 1,
    };

    await updateInProgressCheck(
      octokit,
      repo,
      check.checkRunId,
      "CI 확인 대기",
      this.ciWaitingSummary(status, request, delayMs),
    );
    this.activeChecks.delete(check.key);

    await this.scheduleCiRecheck(octokit, repo, status, request, workflow, delayMs);
  }

  private async deferCiRecheck(
    octokit: Octokit,
    repo: RepoRef,
    status: PullRequestStatus,
    request: CiRecheckRequest,
    workflow: WorkflowExecution | undefined,
    delayMs: number,
  ): Promise<void> {
    const nextRequest = {
      ...request,
      attempt: request.attempt + 1,
    };

    await updateInProgressCheck(
      octokit,
      repo,
      request.checkRunId,
      "CI 확인 대기",
      this.ciWaitingSummary(status, request, delayMs),
    );
    await this.scheduleCiRecheck(octokit, repo, status, nextRequest, workflow, delayMs);
  }

  private async scheduleCiRecheck(
    octokit: Octokit,
    repo: RepoRef,
    status: PullRequestStatus,
    request: CiRecheckRequest,
    workflow: WorkflowExecution | undefined,
    delayMs: number,
  ): Promise<void> {
    if (!workflow?.enqueueSynthetic || !workflow.installationId) {
      await completeCheck(
        octokit,
        repo,
        request.checkRunId,
        "action_required",
        "CI 재확인 예약 실패",
        [
          "CI가 아직 완료되지 않았지만 재확인 workflow를 예약할 수 없어 approval을 보류했습니다.",
          "",
          this.ciWaitingSummary(status, request, delayMs),
        ].join("\n"),
      );
      return;
    }

    await workflow.enqueueSynthetic(
      CI_RECHECK_EVENT,
      this.ciRecheckDedupeKey(repo, request),
      {
        action: "ci_recheck",
        installation: {
          id: workflow.installationId,
        },
        repository: this.repositoryPayload(repo),
        ci_recheck: {
          check_run_id: request.checkRunId,
          pr_number: request.prNumber,
          head_sha: request.headSha,
          mode: request.mode,
          sender: request.sender,
          source: request.source,
          approval_reason: request.approvalReason,
          approval_body: request.approvalBody,
          started_at: request.startedAt,
          attempt: request.attempt,
        },
      },
      delayMs,
    );
  }

  private ciRecheckRequest(payload: any): CiRecheckRequest | null {
    const raw = payload.ci_recheck || payload.ciRecheck || {};
    const checkRunId = Number(raw.check_run_id ?? raw.checkRunId);
    const prNumber = Number(raw.pr_number ?? raw.prNumber);
    const headSha = String(raw.head_sha ?? raw.headSha ?? "");
    const startedAt = String(raw.started_at ?? raw.startedAt ?? new Date().toISOString());
    const attempt = Number(raw.attempt ?? 1);
    const mode = raw.mode === "agent" ? "agent" : raw.mode === "review_gate" ? "review_gate" : "review";

    if (!Number.isFinite(checkRunId) || !Number.isFinite(prNumber) || !headSha) {
      return null;
    }

    return {
      checkRunId,
      prNumber,
      headSha,
      mode,
      sender: String(raw.sender || "seori"),
      source: String(raw.source || "unknown"),
      approvalReason: String(raw.approval_reason ?? raw.approvalReason ?? "CI 통과 후 조치할 항목이 없습니다."),
      approvalBody: String(raw.approval_body ?? raw.approvalBody ?? ""),
      startedAt,
      attempt: Number.isFinite(attempt) && attempt > 0 ? attempt : 1,
    };
  }

  private ciRecheckDedupeKey(repo: RepoRef, request: CiRecheckRequest): string {
    return [
      CI_RECHECK_EVENT,
      repo.fullName,
      request.prNumber,
      request.headSha,
      request.checkRunId,
      request.attempt,
    ].join(":");
  }

  private repositoryPayload(repo: RepoRef): any {
    return {
      owner: {
        login: repo.owner,
      },
      name: repo.repo,
      full_name: repo.fullName,
      private: repo.isPrivate,
    };
  }

  private ciWaitingSummary(status: PullRequestStatus, request: CiRecheckRequest, delayMs: number): string {
    const pending = status.statusChecks.pending.length > 0
      ? status.statusChecks.pending.map((check) => `- ${check}`).join("\n")
      : "- 아직 외부 CI check-run/status가 보이지 않습니다.";

    return [
      "코드 리뷰상 조치할 항목은 없지만, 현재 HEAD의 CI 상태가 아직 확정되지 않아 approval을 보류했습니다.",
      "",
      `HEAD: \`${status.headSha}\``,
      `재확인 시도: \`${request.attempt}\``,
      `다음 재확인: 약 \`${Math.round(delayMs / 1000)}초\` 후`,
      "",
      "### 대기 중",
      pending,
      "",
      "CI가 통과하면 이 check-run을 success로 완료하고 approval review를 제출합니다.",
      "CI가 실패하거나 제한 시간을 넘기면 그때 PR 코멘트를 남깁니다.",
    ].join("\n");
  }

  private ciTimeoutBlockerText(status: PullRequestStatus): string {
    return [
      "## CI 대기 시간 초과",
      "",
      "코드 리뷰상 조치할 항목은 없었지만, CI가 제한 시간 안에 완료되지 않아 approval review를 제출하지 않았습니다.",
      "",
      `HEAD: \`${status.headSha}\``,
      `제한 시간: \`${Math.round(this.config.ciRecheckTimeoutMs / 60000)}분\``,
      "",
      "### 아직 대기 중",
      ...status.statusChecks.pending.map((check) => `- ${check}`),
      "",
      "CI가 정상적으로 끝난 뒤 다시 리뷰를 요청하세요.",
    ].join("\n");
  }

  private isCiRecheckTimedOut(request: CiRecheckRequest): boolean {
    const startedAt = Date.parse(request.startedAt);
    if (!Number.isFinite(startedAt)) {
      return false;
    }
    return Date.now() - startedAt >= this.config.ciRecheckTimeoutMs;
  }

  private async runAnswer(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    request: string,
    trigger: ReviewTrigger,
    workflow?: WorkflowExecution,
  ): Promise<void> {
    const generated = await this.createAnswerText(octokit, repo, prNumber, request, trigger, workflow);
    if (!(await this.currentStatusForPublish(octokit, repo, prNumber, generated.headSha, null))) {
      return;
    }

    await postPrComment(octokit, repo, prNumber, generated.text);
  }

  private async createReviewText(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    trigger: ReviewTrigger,
    workflow?: WorkflowExecution,
  ): Promise<GeneratedText> {
    const context = await buildPullRequestContext(octokit, repo, prNumber, this.config, this.contextOptions(workflow, trigger.request));
    if (this.hasMergeConflict(context)) {
      return { text: this.mergeConflictText(repo, prNumber, context), headSha: context.headSha };
    }

    return { text: await this.createReviewTextFromContext(context, trigger), headSha: context.headSha };
  }

  private async createReviewTextFromContext(
    context: PullRequestContext,
    trigger: ReviewTrigger,
  ): Promise<string> {
    const prompt = [
      "Write a strict pull request code review.",
      "",
      "Primary goal:",
      "- Find actionable defects that a maintainer should fix before merge.",
      "- Prefer fewer high-confidence findings over many low-confidence comments.",
      "- If a possible concern is not directly supported by the diff, put it under verification suggestions instead of findings.",
      "- Make the acceptance criteria explicit before judging the PR. Derive them only from the PR title/body, user request, recent maintainer comments, and unresolved review context.",
      "- Avoid long review loops. If the PR now satisfies the acceptance criteria, narrow the review to defects introduced by the new changes made to satisfy those criteria, plus any clear stability regression those changes cause.",
      "- Do not reopen settled or unrelated issues just because older context is present. Reopen only when the latest diff contradicts a prior resolution or creates a new stability risk.",
      "- If the same acceptance criterion has already failed across repeated rounds and the latest diff still does not address it, say that the PR should be abandoned or resubmitted with a smaller scope instead of requesting another vague retry.",
      "",
      "Finding rules:",
      "- Findings must be grounded in the supplied diff/context.",
      "- Treat `Current Changed File Contents` as the source of truth for the post-change file state when present. Do not claim code or configuration is missing if it is present there; GitHub file patches may be abbreviated.",
      "- Each finding must include severity, file/function or line reference when available, impact, and concrete fix direction.",
      "- Failing tests, builds, lint, typecheck, or required status checks are actionable findings unless the context clearly proves an external infrastructure-only failure.",
      "- Pending or queued checks are merge gates, not code review findings. Do not ask the PR author to wait for transient pending CI unless the context proves the job is stuck, unroutable, or using an ineligible runner.",
      "- Do not treat `mergeable_state: blocked` alone as a finding. Use the Status Checks section as the source of truth for concrete check failures; `blocked` can be caused by the current Seori Review gate.",
      "- Do not flag Seorilabs ARC/self-hosted runner usage solely because it is self-hosted when the PR context shows a private repository and an eligible JS/TS lint, test, typecheck, or build job.",
      `- Do not say \`${NO_ACTIONABLE_FINDINGS_TEXT}\` while any status check is failing.`,
      `- It is allowed to say \`${NO_ACTIONABLE_FINDINGS_TEXT}\` while checks are only pending; the system will hold approval until CI settles.`,
      "- Do not include praise, broad summaries, style-only preferences, or nits.",
      "- Do not mention that you are an AI model.",
      "- Keep code quotes short: quote identifiers or a minimal expression only when useful.",
      "- Do not include Mermaid diagrams or other diagrams in review comments.",
      `- If the PR conversation contains the marker \`${NO_ACTION_REQUIRED_MARKER}\`, treat it as a prior human/agent approval signal. Prefer markers whose recorded HEAD SHA matches the current PR Head SHA. Still review if this request explicitly asks for \`/review\`, but avoid reopening already-settled issues unless the new diff contradicts the marker.`,
      `- If GitHub mergeable is \`false\` or mergeable_state is \`dirty\`/\`conflicting\`, treat the merge conflict as a blocking finding. Do not write \`${NO_ACTIONABLE_FINDINGS_TEXT}\`; include concrete conflict-resolution steps.`,
      "",
      "Severity guide:",
      "- Critical: data loss, security exposure, crash on common path, or broken release path.",
      "- High: likely runtime failure, serious regression, incorrect core behavior.",
      "- Medium: real bug with narrower trigger, missing required validation, important test gap.",
      "- Low: minor but actionable correctness or maintainability issue.",
      "",
      "Output format:",
      "## 리뷰",
      "",
      "### 인수조건",
      "- 이 PR이 merge되기 위해 반드시 만족해야 하는 조건만 1-4개로 명확히 쓰세요.",
      "",
      "### 발견사항",
      "- `[심각도] file_or_symbol`: 영향과 근거. 수정 방향.",
      "",
      "If there are no actionable findings, write exactly:",
      "### 발견사항",
      NO_ACTIONABLE_FINDINGS_TEXT,
      "",
      "### 검증",
      "- 이 PR에 유용한 구체적인 확인 항목만 포함하세요.",
      "",
      "### 후속 조치",
      "- 추가 에이전트 작업이 필요 없어 보이면 `새 커밋이 올라오지 않는 한 추가 에이전트 작업은 필요 없습니다.`를 포함하세요.",
      "",
      `Trigger: ${trigger.source}`,
      `Requested by: ${trigger.sender}`,
      trigger.request ? `User request: ${trigger.request}` : "",
      "",
      context.markdown,
    ].join("\n");

    return this.gemini.review(prompt);
  }

  // Conservative merge gate. The model extracts evidence; strict parsing,
  // grounding and the final PASS/FAIL/FOLLOW_UP/ABSTAIN decision remain host-controlled.
  private async runStructuredReview(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    context: PullRequestContext,
    trigger: ReviewTrigger,
    check: ActiveCheckRun | null,
    workflow?: WorkflowExecution,
  ): Promise<void> {
    const trustedRequest = this.trustedReviewRequest(trigger);
    const explicitAcceptanceCriteria = this.uniqueAcceptanceCriteria([
      ...context.explicitAcceptanceCriteria,
      ...listExplicitAcceptanceCriteria(trustedRequest),
    ]);
    if (
      this.config.acceptanceGuideModeEnabled &&
      explicitAcceptanceCriteria.length === 0
    ) {
      await this.publishAcceptanceGuide(
        octokit,
        repo,
        prNumber,
        context,
        check,
        buildAcceptanceGuide({
          headSha: context.headSha,
          explicitAcceptanceCriteria,
          coveredCriteria: [],
          manualCriteria: [],
          abstainItems: [],
          findings: [],
        }),
      );
      return;
    }
    const ledgerSnapshot = await this.loadReviewGateLedgerSnapshot(
      octokit,
      repo,
      prNumber,
      context,
      workflow?.reviewGateFindingStore,
    );
    let priorAcceptanceHistory: StickyAcceptanceCoverageHistory[] = [];
    try {
      const priorRuns = await workflow?.listLatestReviewGateRuns?.(
        repo.fullName,
        prNumber,
      ) || [];
      priorAcceptanceHistory = priorRuns.flatMap((run) => {
        const priorEnvelope = decodeReviewGateCache(
          run.rawOutput,
          explicitAcceptanceCriteria,
        );
        if (!priorEnvelope || !run.validationErrors) {
          return [];
        }
        return [{
          coverage: priorEnvelope.acceptanceCoverage,
          groundedAcceptanceCriteria: groundedAcceptanceCriteriaFromReviewRun(
            explicitAcceptanceCriteria,
            priorEnvelope.acceptanceCoverage,
            run.validationErrors,
          ),
        }];
      });
    } catch (error) {
      this.logger.warn(
        { error, repo: repo.fullName, prNumber, headSha: context.headSha },
        "failed to load grounded acceptance history",
      );
    }
    const stickyHistoryCoverage = mergeStickyAcceptanceCoverageHistory(
      explicitAcceptanceCriteria,
      [],
      new Set<string>(),
      priorAcceptanceHistory,
    );
    const previouslyGroundedCriteria = groundedAcceptanceCriteriaFromReviewRun(
      explicitAcceptanceCriteria,
      stickyHistoryCoverage,
      [],
    );
    const pinnedEvidence = stickyHistoryCoverage.flatMap((item) => {
      if (
        !previouslyGroundedCriteria.has(
          normalizeReviewAcceptanceEvidence(item.acceptanceCriterion),
        ) ||
        !item.testEvidence
      ) {
        return [];
      }
      return [item.testEvidence, ...(item.supportingTestEvidence || [])];
    });
    const evidenceCandidates = buildReviewEvidenceCandidates(
      context.currentHeadFileContents,
      {
        acceptanceCriteria: explicitAcceptanceCriteria,
        referenceText: [
          context.acceptanceSourceText,
          context.reviewFollowUp.contributorResponses,
        ].filter(Boolean).join("\n"),
        pinnedEvidence,
      },
    );
    const prompts = this.reviewGatePrompts(
      context,
      trigger,
      explicitAcceptanceCriteria,
      ledgerSnapshot.records.map((record) => record.finding),
      evidenceCandidates,
    );
    const contextHash = this.reviewGateContextHash({
      context,
      trustedRequest,
      explicitAcceptanceCriteria,
      findings: ledgerSnapshot.records.map((record) => record.finding),
    });

    let cacheEnvelope: MiniMaxReviewGateCacheEnvelope | null = null;
    try {
      const cached = await workflow?.findCachedReviewGateRun?.(
        repo.fullName,
        prNumber,
        context.headSha,
        REVIEW_GATE_PROMPT_VERSION,
        contextHash,
      );
      cacheEnvelope = cached
        ? this.decodeReviewGateCache(cached, explicitAcceptanceCriteria)
        : null;
    } catch (error) {
      this.logger.warn({ error, repo: repo.fullName, prNumber }, "review gate cache lookup failed");
    }

    let envelope: MiniMaxReviewGateCacheEnvelope;
    try {
      if (cacheEnvelope) {
        envelope = cacheEnvelope;
        this.logger.info(
          { repo: repo.fullName, prNumber, headSha: context.headSha },
          "reused completed Gemini review gate extraction",
        );
      } else {
        const candidateResult = await this.gemini.reviewGateCandidates(
          prompts.candidateSystem,
          prompts.candidateUser,
          explicitAcceptanceCriteria,
          {
            repairInvalidOutput: !this.config.acceptanceGuideModeEnabled,
          },
        );
        const guideMode = this.config.acceptanceGuideModeEnabled;
        const candidates = guideMode ? [] : candidateResult.value.candidates;
        const verificationResult = candidates.length === 0
          ? { verifications: [] }
          : (await this.gemini.verifyReviewGateCandidates(
              prompts.verifierSystem,
              this.reviewGateVerifierPrompt(
                prompts.candidateUser,
                candidates,
              ),
              candidates,
            )).value;
        envelope = {
          schemaVersion: REVIEW_GATE_CACHE_SCHEMA_VERSION,
          acceptanceCoverage: candidateResult.value.acceptanceCoverage,
          candidates,
          verifications: verificationResult.verifications,
        };
      }
    } catch (error) {
      this.logger.warn(
        { error, repo: repo.fullName, prNumber, headSha: context.headSha },
        "Gemini conservative review gate could not produce validated evidence",
      );
      if (this.config.acceptanceGuideModeEnabled) {
        const guide: AcceptanceGuideOutput = {
          items: [],
          summary: [
            ACCEPTANCE_GUIDE_PUBLICATION_MARKER,
            "## Seori 인수조건 가이드",
            "",
            `초기 HEAD: \`${context.headSha}\``,
            "",
            "모델 또는 검증 처리 오류로 최초 인수조건 가이드를 생성하지 못했습니다.",
            "",
            "_안내 기능의 오류만으로 병합을 막지 않으며, 새 커밋이나 답글로 AI 리뷰를 다시 실행하지 않습니다._",
          ].join("\n"),
        };
        await this.recordReviewGateRun(
          workflow,
          check,
          repo,
          prNumber,
          context,
          contextHash,
          prompts,
          null,
          "ABSTAIN",
          [error instanceof Error ? error.message : String(error)],
        );
        const latest = await this.currentStatusForPublish(
          octokit,
          repo,
          prNumber,
          context.headSha,
          check,
        );
        if (latest) {
          await this.publishAcceptanceGuide(
            octokit,
            repo,
            prNumber,
            context,
            check,
            guide,
            true,
          );
        }
        return;
      }
      const output = formatReviewGateCheckOutput({
        headSha: context.headSha,
        verdict: "FOLLOW_UP",
        htmlMarkers: [
          `${ACTION_REQUIRED_MARKER} kind=review-follow-up head=${context.headSha} round=${context.reviewFollowUp.reviewRound}`,
        ],
        followUpSummaryKo: "자동 검증을 완료하지 못했습니다. 코드 변경이 필요하지 않더라도 댓글의 재검토 방법으로 후속 대응해 주세요.",
        abstainItems: [{
          label: "자동 검증 실행",
          reason: "모델 응답 또는 검증 처리에 실패해 현재 HEAD의 세부 판정을 완료하지 못했습니다.",
          requiredAction: "코드 수정은 필요하지 않습니다. 이 댓글에 `@seori /review`로 현재 HEAD 재검토를 한 번 요청해 주세요.",
          peripheral: false,
        }],
      });
      await this.recordReviewGateRun(
        workflow,
        check,
        repo,
        prNumber,
        context,
        contextHash,
        prompts,
        null,
        "FOLLOW_UP",
        [error instanceof Error ? error.message : String(error)],
      );
      const latest = await this.currentStatusForPublish(octokit, repo, prNumber, context.headSha, check);
      if (latest) {
        await postPrComment(octokit, repo, prNumber, output.text);
        await this.completeTrackedCheck(check, output.conclusion, output.title, output.text);
      }
      return;
    }

    const groundingContext = { ...context, evidenceCandidates };
    const currentCoverage = evaluateReviewAcceptanceCoverage(
      groundingContext,
      explicitAcceptanceCriteria,
      envelope.acceptanceCoverage,
    );
    const priorCoverage = evaluateReviewAcceptanceCoverage(
      groundingContext,
      explicitAcceptanceCriteria,
      stickyHistoryCoverage,
    );
    const revalidatedPriorGroundedCriteria = new Set(
      [...priorCoverage.groundedAcceptanceCriteria].filter((criterion) =>
        previouslyGroundedCriteria.has(criterion)),
    );
    const effectiveAcceptanceCoverage = mergeStickyAcceptanceCoverage(
      explicitAcceptanceCriteria,
      envelope.acceptanceCoverage,
      currentCoverage.groundedAcceptanceCriteria,
      stickyHistoryCoverage,
      revalidatedPriorGroundedCriteria,
    );
    const coverage = evaluateReviewAcceptanceCoverage(
      groundingContext,
      explicitAcceptanceCriteria,
      effectiveAcceptanceCoverage,
    );
    const stickyGroundedCriteria = revalidatedPriorGroundedCriteria;
    const filteredEnvelope = filterReviewGateCacheCandidates(envelope, (candidate) =>
      candidate.kind !== "missing_acceptance_test" ||
      !candidate.acceptanceCriterion ||
      !stickyGroundedCriteria.has(this.normalizedEvidence(candidate.acceptanceCriterion).toLowerCase()),
    );
    const evaluatedEnvelope: MiniMaxReviewGateCacheEnvelope = {
      ...filteredEnvelope,
      acceptanceCoverage: effectiveAcceptanceCoverage,
    };
    const pipeline = evaluateMiniMaxReviewGateCandidates({
      candidates: evaluatedEnvelope.candidates,
      verifications: evaluatedEnvelope.verifications,
      explicitAcceptanceCriteria,
      testInventoryComplete: context.testInventoryComplete,
      testInventoryFileCount: context.testInventoryFileCount,
      currentHeadFileContents: context.currentHeadFileContents,
      visibleChangedPatches: context.visibleChangedPatches,
    });
    const identity = { headSha: context.headSha, contextHash };
    const regressionEvidence = await this.reviewGateRegressionEvidence(
      octokit,
      repo,
      context.headSha,
      ledgerSnapshot.records.map((record) => record.finding),
      pipeline.ledgerCandidates,
    );
    const priorLedgerFindings = ledgerSnapshot.records.map((record) => record.finding);
    const disprovenFingerprints = this.reviewGateDisprovenFingerprints(
      coverage.groundedAcceptanceCriteria,
      priorLedgerFindings,
    );
    const evidenceInventory = this.reviewGateEvidenceInventory(
      priorLedgerFindings,
      pipeline.ledgerCandidates,
      context,
      disprovenFingerprints,
    );
    const ledger = reconcileReviewFindingLedger(
      priorLedgerFindings,
      {
        identity,
        candidates: pipeline.ledgerCandidates,
        evidenceInventory,
        regressionEvidence,
      },
    );

    const publicByFingerprint = new Map(
      pipeline.accepted.map((accepted) => [
        fingerprintReviewFinding(accepted.ledgerCandidate),
        accepted.publicFinding,
      ]),
    );
    const openFindings = ledger.findings.filter((finding) => finding.state === "open");
    const currentConfirmedFingerprints = new Set(
      pipeline.ledgerCandidates.map((candidate) => fingerprintReviewFinding(candidate)),
    );
    const blockingOpenFindings = openFindings.filter((finding) =>
      currentConfirmedFingerprints.has(finding.semanticFingerprint),
    );
    const unconfirmedOpenFindings = openFindings.filter((finding) =>
      !currentConfirmedFingerprints.has(finding.semanticFingerprint),
    );
    const hasUnresolvedValidation =
      !pipeline.inputValid ||
      !context.fatalContextComplete ||
      !coverage.complete ||
      blockingOpenFindings.length !== openFindings.length ||
      pipeline.rejected.some((rejected) => {
        const verification = envelope.verifications.find((item) => item.candidateId === rejected.candidateId);
        return verification?.verdict === "uncertain";
      });
    const baseVerdict: Exclude<ReviewGatePublicVerdict, "FOLLOW_UP"> = blockingOpenFindings.length > 0
      ? "FAIL"
      : hasUnresolvedValidation
        ? "ABSTAIN"
        : "PASS";
    const publicFindings = baseVerdict === "FAIL"
      ? this.reviewGatePublicFindings(blockingOpenFindings, publicByFingerprint, context)
      : [];
    const disclosure = buildReviewGateDisclosure({
      explicitAcceptanceCriteria,
      acceptanceCoverage: evaluatedEnvelope.acceptanceCoverage,
      groundedAcceptanceCriteria: coverage.groundedAcceptanceCriteria,
      groundedTestEvidence: coverage.groundedTestEvidence,
      coverageValidationErrors: coverage.validationErrors,
      fatalContextComplete: context.fatalContextComplete,
      pipeline,
      candidates: evaluatedEnvelope.candidates,
      verifications: evaluatedEnvelope.verifications,
      unconfirmedOpenFindings,
    });
    if (this.config.acceptanceGuideModeEnabled) {
      const guide = buildAcceptanceGuide({
        headSha: context.headSha,
        explicitAcceptanceCriteria,
        coveredCriteria: disclosure.coveredCriteria,
        manualCriteria: disclosure.manualCriteria,
        abstainItems: disclosure.abstainItems,
        findings: publicFindings,
      });
      await this.recordReviewGateRun(
        workflow,
        check,
        repo,
        prNumber,
        context,
        contextHash,
        prompts,
        evaluatedEnvelope,
        guide.items.length > 0 ? "FOLLOW_UP" : "PASS",
        [
          ...pipeline.rejected.map((rejected) => `${rejected.code}: ${rejected.reason}`),
          ...coverage.validationErrors,
        ],
      );
      if (await this.cancelTrackedCheckIfShuttingDown(
        check,
        "인수조건 가이드 취소",
        "가이드 결과를 게시하기 전에 봇이 중지되었습니다.",
      )) {
        return;
      }
      const latest = await this.currentStatusForPublish(
        octokit,
        repo,
        prNumber,
        context.headSha,
        check,
      );
      if (latest) {
        await this.publishAcceptanceGuide(
          octokit,
          repo,
          prNumber,
          context,
          check,
          guide,
        );
      }
      return;
    }
    const verdict = resolveReviewTurnVerdict(
      baseVerdict,
      context.reviewFollowUp.reviewRound,
      disclosure.abstainItems,
    );
    const output = formatReviewGateCheckOutput({
      headSha: context.headSha,
      verdict,
      findings: publicFindings,
      htmlMarkers: [
        verdict === "FAIL"
          ? `${ACTION_REQUIRED_MARKER} kind=review-gate head=${context.headSha}`
          : verdict === "PASS"
            ? `${NO_ACTION_REQUIRED_MARKER} head=${context.headSha}`
            : verdict === "FOLLOW_UP"
              ? `${ACTION_REQUIRED_MARKER} kind=review-follow-up head=${context.headSha} round=${context.reviewFollowUp.reviewRound}`
              : `${REVIEW_DEFERRED_MARKER} head=${context.headSha} round=${context.reviewFollowUp.reviewRound}`,
      ],
      passSummaryKo: explicitAcceptanceCriteria.length === 0
        ? "명시적 인수조건이 없어 현재 변경 전체에서 치명 결함만 검사했으며, 증명된 치명 결함이 없습니다."
        : "모든 자동 검증 대상 인수조건의 현재 HEAD 테스트 또는 소스 근거와 변경 전체의 치명 결함 검사를 확인했습니다.",
      abstainSummaryKo: "현재 근거만으로 자동 승인할 수 없어 GitHub approval을 제출하지 않습니다. 판정 보류 범위는 사람에게 handoff합니다.",
      followUpSummaryKo: context.reviewFollowUp.reviewRound <= 1
        ? "첫 검토에서 판정을 미루지 않습니다. 아래 항목에 답하거나 보정 커밋을 올리면 직전 요청 이후 변경만 좁혀서 다시 검토합니다."
        : "직전 Seori 요청 이후의 응답과 변경만 좁혀서 확인했습니다. 아래 남은 항목에 답하거나 보정 커밋을 올리면 그 이후 변경만 이어서 검토합니다.",
      coveredCriteria: disclosure.coveredCriteria,
      manualCriteria: disclosure.manualCriteria,
      fatalCheckPassed: disclosure.fatalCheckPassed,
      abstainItems: disclosure.abstainItems,
    });

    await this.recordReviewGateRun(
      workflow,
      check,
      repo,
      prNumber,
      context,
      contextHash,
      prompts,
      evaluatedEnvelope,
      verdict,
      [
        ...pipeline.rejected.map((rejected) => `${rejected.code}: ${rejected.reason}`),
        ...coverage.validationErrors,
        ...(!context.fatalContextComplete ? ["fatal_context_incomplete"] : []),
      ],
    );

    if (await this.cancelTrackedCheckIfShuttingDown(check, "리뷰 취소", "리뷰 결과를 게시하기 전에 봇이 중지되었습니다.")) {
      return;
    }
    let latest = await this.currentStatusForPublish(octokit, repo, prNumber, context.headSha, check);
    if (!latest) {
      return;
    }
    if (this.hasMergeConflict(latest)) {
      const conflictText = this.mergeConflictText(repo, prNumber, latest);
      await requestChangesPullRequest(octokit, repo, prNumber, conflictText, latest.headSha);
      await this.completeTrackedCheck(check, "action_required", "병합 충돌 해결 필요", conflictText);
      return;
    }

    const ledgerPersisted = await this.persistReviewGateLedger(
      octokit,
      repo,
      prNumber,
      ledgerSnapshot,
      ledger.findings,
      ledger.transitions.filter((transition) => transition.kind === "resolved").map((transition) => transition.finding),
      workflow?.reviewGateFindingStore,
    );
    if (!ledgerPersisted) {
      this.logger.info(
        { repo: repo.fullName, prNumber, headSha: context.headSha },
        "stale review gate result discarded before GitHub publication",
      );
      await this.discardStaleTrackedCheck(check, context.headSha);
      return;
    }
    latest = await this.currentStatusForPublish(octokit, repo, prNumber, context.headSha, check);
    if (!latest) {
      return;
    }
    if (this.hasMergeConflict(latest)) {
      const conflictText = this.mergeConflictText(repo, prNumber, latest);
      await requestChangesPullRequest(octokit, repo, prNumber, conflictText, latest.headSha);
      await this.completeTrackedCheck(check, "action_required", "병합 충돌 해결 필요", conflictText);
      return;
    }

    if (verdict === "FAIL") {
      const transitionByFingerprint = new Map(
        ledger.transitions.map((transition) => [transition.semanticFingerprint, transition.kind]),
      );
      const publishableFingerprints = new Set(
        blockingOpenFindings
          .map((finding) => finding.semanticFingerprint)
          .filter((fingerprint) => {
            if (!ledgerSnapshot.publishedFingerprints.has(fingerprint)) {
              return true;
            }
            const transition = transitionByFingerprint.get(fingerprint);
            return transition === "updated" || transition === "reopened";
          }),
      );
      if (publishableFingerprints.size > 0) {
        const inlineComments: InlineReviewComment[] = publicFindings
          .filter((finding) =>
            finding.kind === "fatal_defect" &&
            Boolean(finding.fingerprint && publishableFingerprints.has(finding.fingerprint)))
          .map((finding, index) => ({
            path: finding.kind === "fatal_defect" ? finding.evidence.file : "",
            line: finding.kind === "fatal_defect" ? finding.evidence.line : 1,
            body: formatReviewGateFinding(finding, index + 1),
          }));
        await this.safeSubmitReview(
          octokit,
          repo,
          prNumber,
          context.headSha,
          "REQUEST_CHANGES",
          output.text,
          inlineComments,
        );
        await this.refreshPublishedReviewGateThreads(
          octokit,
          repo,
          prNumber,
          ledger.findings,
          workflow?.reviewGateFindingStore,
        );
      } else {
        // A review turn must still be visible and actionable even when the same
        // fingerprint remains open. Avoid silently updating only the check-run.
        await postPrComment(octokit, repo, prNumber, output.text);
      }
      await this.completeTrackedCheck(check, output.conclusion, output.title, output.text);
      return;
    }

    if (verdict === "FOLLOW_UP" || verdict === "ABSTAIN") {
      await postPrComment(octokit, repo, prNumber, output.text);
      await this.completeTrackedCheck(check, output.conclusion, output.title, output.text);
      return;
    }

    const passReason = explicitAcceptanceCriteria.length === 0
      ? "명시적 인수조건이 없어 치명 결함만 검사했고 증명된 결함이 없습니다."
      : "명시적 인수조건의 테스트 또는 소스 근거가 확인됐고 증명된 치명 결함이 없습니다.";

    if (this.hasFailingStatusChecks(latest)) {
      const blockerText = this.actionRequiredText("status-check", latest.headSha, this.statusCheckBlockerText(latest));
      await postPrComment(octokit, repo, prNumber, blockerText);
      await this.completeTrackedCheck(check, "action_required", "상태 체크 확인 필요", blockerText);
      return;
    }

    if (this.shouldDeferApprovalForCi(trigger, latest)) {
      await this.deferApprovalUntilCiSettles(
        octokit,
        repo,
        prNumber,
        latest,
        check,
        workflow,
        {
          mode: "review_gate",
          sender: trigger.sender,
          source: trigger.source,
          reason: passReason,
          body: output.text,
        },
        this.hasPendingStatusChecks(latest) ? this.config.ciRecheckIntervalMs : this.config.ciInitialWaitMs,
      );
      return;
    }

    await this.approveAndNotify(
      octokit,
      repo,
      prNumber,
      latest,
      this.approvalText(
        trigger.sender,
        passReason,
        latest.headSha,
        output.text,
      ),
      {
        mode: "review_gate",
        sender: trigger.sender,
        source: trigger.source,
        reason: passReason,
      },
    );
    await this.completeTrackedCheck(check, output.conclusion, output.title, output.text);
    await this.maybeSquashMergeApprovedPullRequest(octokit, repo, prNumber, latest.headSha, "review_gate");
  }

  private normalizedEvidence(value: string): string {
    return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  }

  private uniqueAcceptanceCriteria(criteria: readonly string[]): string[] {
    const unique = new Map<string, string>();
    for (const criterion of criteria) {
      const normalized = this.normalizedEvidence(criterion).toLowerCase();
      if (normalized) {
        unique.set(normalized, criterion);
      }
    }
    return [...unique.values()];
  }

  private reviewGatePrompts(
    context: PullRequestContext,
    trigger: ReviewTrigger,
    explicitAcceptanceCriteria: readonly string[],
    priorFindings: readonly StoredReviewFinding[],
    evidenceCandidates: readonly ReviewEvidenceCandidate[],
  ): {
    candidateSystem: string;
    candidateUser: string;
    verifierSystem: string;
  } {
    const candidateSystem = buildReviewGateCandidateSystemPrompt({
      acceptanceGuideMode: this.config.acceptanceGuideModeEnabled,
    });
    const verifierSystem = buildReviewGateVerifierSystemPrompt();
    const criteria = explicitAcceptanceCriteria.length === 0
      ? "(명시적 인수조건 없음)"
      : explicitAcceptanceCriteria.map((criterion, index) => `AC-${index + 1}: ${criterion}`).join("\n");
    const ledger = priorFindings.length === 0
      ? "(이전 지적 없음)"
      : [...priorFindings]
          .sort((left, right) => left.semanticFingerprint.localeCompare(right.semanticFingerprint))
          .map((finding) => {
            const target = finding.candidate.file
              ? `${finding.candidate.file}#${finding.candidate.symbol || "(symbol 없음)"}`
              : finding.candidate.kind === "missing_tests"
                ? finding.candidate.acceptanceCriterion
                : "(target 없음)";
            return `- ${finding.semanticFingerprint} state=${finding.state} kind=${finding.candidate.kind} target=${target}`;
          })
          .join("\n");
    const trustedRequest = this.trustedReviewRequest(trigger);
    const candidateUser = [
      `Gate version: ${REVIEW_GATE_PROMPT_VERSION}`,
      "## Host 검증 사실",
      `head_sha: ${context.headSha}`,
      `change_class: ${context.changeClass}`,
      `test_inventory_complete: ${context.testInventoryComplete}`,
      `test_inventory_file_count: ${context.testInventoryFileCount}`,
      `fatal_context_complete: ${context.fatalContextComplete}`,
      "",
      "## Host가 추출한 명시적 인수조건",
      criteria,
      "",
      "## Host Evidence Candidates",
      "아래 JSON line만 test_evidence와 supporting_test_evidence의 근거로 선택할 수 있습니다.",
      formatReviewEvidenceCandidates(evidenceCandidates),
      "",
      "## 신뢰된 명시 요청",
      trustedRequest || "(없음)",
      "",
      "## 지적 원장",
      ledger,
      "",
      context.reviewGateMarkdown,
      "",
      "## 수행할 작업",
      this.config.acceptanceGuideModeEnabled
        ? "각 인수조건의 현재 HEAD 근거 상태만 분류하고 candidates는 빈 배열로 submit_review 도구에 제출하세요."
        : "위 현재 HEAD 근거만으로 허용된 후보를 최대 2개 찾고 submit_review 도구로 제출하세요. 확실한 후보가 없으면 빈 배열을 제출하세요.",
    ].join("\n");
    return { candidateSystem, candidateUser, verifierSystem };
  }

  private reviewGateVerifierPrompt(
    candidateUser: string,
    candidates: readonly MiniMaxReviewCandidate[],
  ): string {
    return [
      candidateUser,
      "",
      "## 반증할 후보",
      JSON.stringify({ candidates }, null, 2),
      "",
      "## 수행할 작업",
      "각 후보를 현재 HEAD에서 먼저 반증하고, 후보 순서대로 confirmed/rejected/uncertain 중 하나를 submit_review 도구로 제출하세요.",
    ].join("\n");
  }

  private reviewGateContextHash(input: {
    context: PullRequestContext;
    trustedRequest: string;
    explicitAcceptanceCriteria: readonly string[];
    findings: readonly StoredReviewFinding[];
  }): string {
    const canonical = {
      version: REVIEW_GATE_PROMPT_VERSION,
      reviewGateMarkdown: input.context.reviewGateMarkdown,
      trustedRequest: input.trustedRequest,
      explicitAcceptanceCriteria: input.explicitAcceptanceCriteria,
      testInventoryComplete: input.context.testInventoryComplete,
      testInventoryFileCount: input.context.testInventoryFileCount,
      fatalContextComplete: input.context.fatalContextComplete,
      findings: [...input.findings]
        .sort((left, right) => left.semanticFingerprint.localeCompare(right.semanticFingerprint))
        .map((finding) => ({
          semanticFingerprint: finding.semanticFingerprint,
          evidenceHash: finding.evidenceHash,
          state: finding.state,
          candidate: finding.candidate,
          refutation: finding.refutation,
        })),
    };
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  }

  private decodeReviewGateCache(
    cached: CachedReviewRun,
    explicitAcceptanceCriteria: readonly string[],
  ): MiniMaxReviewGateCacheEnvelope | null {
    if (cached.verdict !== "PASS" && cached.verdict !== "FAIL") {
      return null;
    }
    return decodeReviewGateCache(cached.rawOutput, explicitAcceptanceCriteria);
  }

  private async recordReviewGateRun(
    workflow: WorkflowExecution | undefined,
    check: ActiveCheckRun | null,
    repo: RepoRef,
    prNumber: number,
    context: PullRequestContext,
    contextHash: string,
    prompts: { candidateSystem: string; candidateUser: string; verifierSystem: string },
    envelope: MiniMaxReviewGateCacheEnvelope | null,
    verdict: ReviewGatePublicVerdict,
    validationErrors: string[],
  ): Promise<void> {
    const promptDigestInput = [
      prompts.candidateSystem,
      prompts.candidateUser,
      prompts.verifierSystem,
    ].join("\n---\n");
    const record: ReviewRunRecord = {
      repoFullName: repo.fullName,
      prNumber,
      headSha: context.headSha,
      checkRunId: check?.checkRunId ?? workflow?.checkRunId ?? null,
      provider: "gemini",
      model: `${this.config.geminiModel}-candidate-verifier`,
      promptVersion: REVIEW_GATE_PROMPT_VERSION,
      promptSha256: createHash("sha256").update(promptDigestInput).digest("hex"),
      contextSha256: contextHash,
      rawOutput: envelope
        ? JSON.stringify(encodeReviewGateCache(envelope))
        : JSON.stringify({ schemaVersion: REVIEW_GATE_CACHE_SCHEMA_VERSION, error: "validation_failed" }),
      parseValid: envelope !== null,
      verdict,
      validationErrors,
    };

    try {
      await workflow?.recordReviewRun?.(record);
    } catch (error) {
      this.logger.warn(
        { error, repo: repo.fullName, prNumber, headSha: context.headSha },
        "failed to persist review gate provenance",
      );
    }

    this.logger.info(
      {
        repo: repo.fullName,
        prNumber,
        headSha: context.headSha,
        provider: record.provider,
        model: record.model,
        promptVersion: REVIEW_GATE_PROMPT_VERSION,
        verdict,
        validationErrors: validationErrors.length,
      },
      "conservative review gate evaluated",
    );
  }

  private async loadReviewGateLedgerSnapshot(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    context: PullRequestContext,
    store: ReviewGateFindingStore | undefined,
  ): Promise<ReviewGateLedgerSnapshot> {
    const storedRecords = store
      ? await store.listReviewGateFindings(repo.fullName, prNumber)
      : [];
    const expectedHeadByFingerprint = new Map(
      storedRecords.map((record) => [
        record.finding.semanticFingerprint,
        record.finding.lastEvaluatedHeadSha || null,
      ]),
    );
    const expectedContextByFingerprint = new Map(
      storedRecords.map((record) => [
        record.finding.semanticFingerprint,
        record.finding.contextHash || null,
      ]),
    );
    const publishedFingerprints = new Set<string>();
    const threadByFingerprint = new Map<string, { threadId: string; commentId: number | null }>();
    let threads: Awaited<ReturnType<typeof listReviewThreads>> = [];

    const collectMarkers = (body: string): void => {
      for (const match of body.matchAll(/seori-finding:([0-9a-f]{64})/gu)) {
        publishedFingerprints.add(match[1]);
      }
    };

    try {
      threads = await listReviewThreads(octokit, repo, prNumber);
      for (const thread of threads) {
        for (const body of thread.bodies) {
          collectMarkers(body);
          for (const match of body.matchAll(/seori-finding:([0-9a-f]{64})/gu)) {
            if (!threadByFingerprint.has(match[1])) {
              threadByFingerprint.set(match[1], {
                threadId: thread.threadId,
                commentId: thread.commentDatabaseIds[0] ?? null,
              });
            }
          }
        }
      }
    } catch (error) {
      this.logger.warn({ error, repo: repo.fullName, prNumber }, "failed to inspect review gate threads");
    }

    try {
      const [reviews, comments] = await Promise.all([
        octokit.paginate(octokit.rest.pulls.listReviews, {
          owner: repo.owner,
          repo: repo.repo,
          pull_number: prNumber,
          per_page: 100,
        }),
        octokit.paginate(octokit.rest.issues.listComments, {
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          per_page: 100,
        }),
      ]);
      for (const entry of [...reviews, ...comments]) {
        collectMarkers(String(entry.body || ""));
      }
    } catch (error) {
      this.logger.warn({ error, repo: repo.fullName, prNumber }, "failed to recover published review gate markers");
    }

    const provisionalIdentity = {
      headSha: context.headSha,
      contextHash: createHash("sha256").update(context.reviewGateMarkdown).digest("hex"),
    };
    const records = storedRecords.map((record) => {
      const mappedThread = threadByFingerprint.get(record.finding.semanticFingerprint);
      const thread = threads.find((item) =>
        item.threadId === record.threadNodeId || item.threadId === mappedThread?.threadId,
      );
      let finding = record.finding;
      if (finding.state === "open" && thread) {
        const maintainerReply = thread.comments.find((comment) =>
          !isBotGithubAuthor(comment.authorLogin) &&
          !comment.authorLogin.toLowerCase().endsWith("[bot]") &&
          isTrustedAssociation(comment.authorAssociation, this.config) &&
          /^\s*\/seori\s+refute(?:\s+.+)?\s*$/imu.test(comment.body),
        );
        const humanResolved = Boolean(
          thread.isResolved &&
          thread.resolvedByLogin &&
          !isBotGithubAuthor(thread.resolvedByLogin) &&
          context.headSha !== finding.lastSeenHeadSha,
        );
        if (maintainerReply || humanResolved) {
          const evidence = maintainerReply?.body ||
            `관리자 ${thread.resolvedByLogin || "unknown"}가 리뷰 스레드를 해결 처리했습니다.`;
          finding = refuteReviewFinding(finding, provisionalIdentity, truncate(evidence, 1_000));
        }
      }
      return {
        finding,
        reviewCommentId: mappedThread?.commentId ?? record.reviewCommentId,
        threadNodeId: mappedThread?.threadId ?? record.threadNodeId,
      };
    });

    return {
      records,
      expectedHeadByFingerprint,
      expectedContextByFingerprint,
      publishedFingerprints,
      threadByFingerprint,
    };
  }

  private reviewGateEvidenceInventory(
    priorFindings: readonly StoredReviewFinding[],
    currentCandidates: readonly ReviewFindingCandidate[],
    context: PullRequestContext,
    disprovenFingerprints: ReadonlySet<string>,
  ): {
    complete: boolean;
    evidenceHashes: string[];
    provenAbsentFingerprints: string[];
  } {
    const currentByFingerprint = new Map(
      currentCandidates.map((candidate) => [fingerprintReviewFinding(candidate), candidate]),
    );
    const evidenceHashes = new Set(
      currentCandidates.map((candidate) => hashReviewFindingEvidence(candidate.evidence)),
    );
    const provenAbsentFingerprints = new Set<string>();
    let complete = true;

    for (const prior of priorFindings) {
      if (prior.state !== "open" || currentByFingerprint.has(prior.semanticFingerprint)) {
        continue;
      }
      if (prior.candidate.kind === "missing_tests") {
        if (disprovenFingerprints.has(prior.semanticFingerprint)) {
          // A grounded current-HEAD test is direct positive counterevidence for
          // this exact AC. It does not require an exhaustive inventory to prove
          // that the previously missing test now exists.
          provenAbsentFingerprints.add(prior.semanticFingerprint);
          continue;
        }
        if (!context.testInventoryComplete) {
          complete = false;
        } else {
          // Candidate omission is not proof that a test was added. Keep the
          // finding open until host-grounded current-HEAD evidence disproves it.
          evidenceHashes.add(prior.evidenceHash);
        }
        continue;
      }
      const file = prior.candidate.file;
      const content = file ? context.currentHeadFileContents[file] : undefined;
      if (content === undefined) {
        complete = false;
        continue;
      }
      if (disprovenFingerprints.has(prior.semanticFingerprint)) {
        provenAbsentFingerprints.add(prior.semanticFingerprint);
        continue;
      }
      const normalizedLines = new Set(
        content.split(/\r?\n/gu).map((line) => this.normalizedEvidence(line)),
      );
      const exactEvidenceStillPresent = prior.candidate.evidence
        .filter((evidence) => evidence.kind === "code")
        .every((evidence) => normalizedLines.has(this.normalizedEvidence(evidence.quote)));
      if (exactEvidenceStillPresent) {
        evidenceHashes.add(prior.evidenceHash);
      } else {
        provenAbsentFingerprints.add(prior.semanticFingerprint);
      }
    }

    return {
      complete,
      evidenceHashes: [...evidenceHashes].sort(),
      provenAbsentFingerprints: [...provenAbsentFingerprints].sort(),
    };
  }

  private reviewGateDisprovenFingerprints(
    groundedAcceptanceCriteria: ReadonlySet<string>,
    priorFindings: readonly StoredReviewFinding[],
  ): Set<string> {
    const result = new Set<string>();
    for (const prior of priorFindings) {
      if (
        prior.state === "open" &&
        prior.candidate.kind === "missing_tests" &&
        groundedAcceptanceCriteria.has(
          this.normalizedEvidence(prior.candidate.acceptanceCriterion).toLowerCase(),
        )
      ) {
        result.add(prior.semanticFingerprint);
      }
    }
    return result;
  }

  private async reviewGateRegressionEvidence(
    octokit: Octokit,
    repo: RepoRef,
    headSha: string,
    priorFindings: readonly StoredReviewFinding[],
    currentCandidates: readonly ReviewFindingCandidate[],
  ): Promise<ReviewFindingRegressionEvidence[]> {
    const currentByFingerprint = new Map(
      currentCandidates.map((candidate) => [fingerprintReviewFinding(candidate), candidate]),
    );
    const result: ReviewFindingRegressionEvidence[] = [];
    for (const prior of priorFindings) {
      const candidate = currentByFingerprint.get(prior.semanticFingerprint);
      if (
        prior.state !== "refuted" ||
        !prior.refutation ||
        !candidate?.file ||
        !candidate.symbol ||
        prior.refutation.headSha === headSha
      ) {
        continue;
      }
      try {
        const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
          owner: repo.owner,
          repo: repo.repo,
          basehead: `${prior.refutation.headSha}...${headSha}`,
        });
        const changed = (data.files || []).find((file: any) => String(file.filename) === candidate.file);
        const patch = String(changed?.patch || "");
        const addedQuotes = candidate.evidence
          .filter((evidence) => evidence.kind === "code")
          .map((evidence) => this.normalizedEvidence(evidence.quote));
        const hasAddedRoot = patch
          .split(/\r?\n/gu)
          .some((line) => line.startsWith("+") && addedQuotes.includes(this.normalizedEvidence(line.slice(1))));
        if (patch.includes(candidate.symbol) && hasAddedRoot) {
          result.push({
            file: candidate.file,
            symbol: candidate.symbol,
            diffEvidence: truncate(patch, 2_000),
          });
        }
      } catch (error) {
        this.logger.warn(
          { error, repo: repo.fullName, fingerprint: prior.semanticFingerprint },
          "failed to verify review gate regression evidence",
        );
      }
    }
    return result;
  }

  private reviewGatePublicFindings(
    findings: readonly StoredReviewFinding[],
    currentPublic: ReadonlyMap<string, ReviewGatePublicFinding>,
    context: PullRequestContext,
  ): ReviewGatePublicFinding[] {
    return [...findings]
      .sort((left, right) => {
        const currentOrder = Number(currentPublic.has(right.semanticFingerprint)) -
          Number(currentPublic.has(left.semanticFingerprint));
        return currentOrder || left.semanticFingerprint.localeCompare(right.semanticFingerprint);
      })
      .slice(0, 2)
      .map((finding) => currentPublic.get(finding.semanticFingerprint) ||
        this.reviewGateStoredPublicFinding(finding, context));
  }

  private reviewGateStoredPublicFinding(
    finding: StoredReviewFinding,
    context: PullRequestContext,
  ): ReviewGatePublicFinding {
    if (finding.candidate.kind === "missing_tests") {
      return {
        kind: "missing_acceptance_test",
        title: "인수조건 자동화 테스트가 아직 확인되지 않았습니다",
        problem: "이전에 전체 테스트 인벤토리에서 확인한 테스트 누락의 동일 근거가 현재 HEAD에도 남아 있습니다.",
        trigger: `다음 명시적 인수조건을 검증할 때입니다: ${finding.candidate.acceptanceCriterion}`,
        impact: "요구 동작이 깨져도 병합 전에 자동으로 발견할 수 없습니다.",
        requiredAction: "인수조건을 직접 실행하고 결과를 단언하는 자동화 테스트를 추가해야 합니다.",
        evidence: {
          acceptanceCriterion: finding.candidate.acceptanceCriterion,
          testInventoryComplete: true,
          testFilesInspected: context.testInventoryFileCount,
        },
        fingerprint: finding.semanticFingerprint,
      };
    }
    const root = [...finding.candidate.evidence]
      .reverse()
      .find((evidence) => evidence.kind === "code" && evidence.file && evidence.line);
    if (!root?.file || !root.line) {
      throw new Error(`fatal finding ${finding.semanticFingerprint} has no grounded root evidence`);
    }
    const outcome = this.reviewGateFatalOutcomeKo(finding.candidate.outcome);
    return {
      kind: "fatal_defect",
      title: `${outcome} 근거가 아직 남아 있습니다`,
      problem: "이전에 확인한 치명 결함의 동일한 종단 코드가 현재 HEAD에도 존재합니다.",
      trigger: `현재 HEAD에서 ${finding.candidate.file}의 ${finding.candidate.symbol || "지정 경로"}가 실행될 때입니다.`,
      impact: `${outcome}이 확정적으로 발생해 병합을 차단합니다.`,
      requiredAction: "아래 종단 결과를 제거하고 같은 실행 경로의 회귀 테스트를 추가해야 합니다.",
      evidence: { file: root.file, line: root.line, code: root.quote },
      fingerprint: finding.semanticFingerprint,
    };
  }

  private reviewGateFatalOutcomeKo(outcome: string): string {
    const labels: Record<string, string> = {
      deterministic_crash: "정상 경로의 확정적 크래시",
      permanent_data_loss_or_corruption: "영구 데이터 손실 또는 손상",
      exploitable_security_or_privacy_exposure: "악용 가능한 보안 또는 개인정보 노출",
      primary_flow_unusable: "핵심 사용자 흐름 완전 불능",
    };
    return labels[outcome] || "치명적인 실행 결과";
  }

  private async persistReviewGateLedger(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    snapshot: ReviewGateLedgerSnapshot,
    findings: readonly StoredReviewFinding[],
    resolved: readonly StoredReviewFinding[],
    store: ReviewGateFindingStore | undefined,
  ): Promise<boolean> {
    const previousByFingerprint = new Map(
      snapshot.records.map((record) => [record.finding.semanticFingerprint, record]),
    );
    if (store) {
      for (const finding of findings) {
        const previous = previousByFingerprint.get(finding.semanticFingerprint);
        const mappedThread = snapshot.threadByFingerprint.get(finding.semanticFingerprint);
        const applied = await store.upsertReviewGateFinding(repo.fullName, prNumber, {
          finding,
          reviewCommentId: mappedThread?.commentId ?? previous?.reviewCommentId ?? null,
          threadNodeId: mappedThread?.threadId ?? previous?.threadNodeId ?? null,
          expectedLastEvaluatedHeadSha:
            snapshot.expectedHeadByFingerprint.get(finding.semanticFingerprint) ?? null,
          expectedContextHash:
            snapshot.expectedContextByFingerprint.get(finding.semanticFingerprint) ?? null,
        });
        if (!applied) {
          return false;
        }
      }
      const persisted = await store.listReviewGateFindings(repo.fullName, prNumber);
      const persistedByFingerprint = new Map(
        persisted.map((record) => [record.finding.semanticFingerprint, record.finding]),
      );
      const stillCurrent = findings.every((finding) => {
        const stored = persistedByFingerprint.get(finding.semanticFingerprint);
        return Boolean(
          stored &&
          stored.state === finding.state &&
          stored.lastEvaluatedHeadSha === finding.lastEvaluatedHeadSha &&
          stored.contextHash === finding.contextHash &&
          stored.evidenceHash === finding.evidenceHash,
        );
      });
      if (!stillCurrent) {
        return false;
      }
    }
    for (const finding of resolved) {
      const threadNodeId = previousByFingerprint.get(finding.semanticFingerprint)?.threadNodeId ||
        snapshot.threadByFingerprint.get(finding.semanticFingerprint)?.threadId;
      if (threadNodeId) {
        await this.tryResolveThread(octokit, threadNodeId);
      }
    }
    return true;
  }

  private async refreshPublishedReviewGateThreads(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    findings: readonly StoredReviewFinding[],
    store: ReviewGateFindingStore | undefined,
  ): Promise<void> {
    if (!store) {
      return;
    }
    try {
      const threads = await listReviewThreads(octokit, repo, prNumber);
      const byFingerprint = new Map<string, { threadId: string; commentId: number | null }>();
      for (const thread of threads) {
        for (const body of thread.bodies) {
          for (const match of body.matchAll(/seori-finding:([0-9a-f]{64})/gu)) {
            byFingerprint.set(match[1], {
              threadId: thread.threadId,
              commentId: thread.commentDatabaseIds[0] ?? null,
            });
          }
        }
      }
      for (const finding of findings) {
        const thread = byFingerprint.get(finding.semanticFingerprint);
        if (!thread) {
          continue;
        }
        await store.upsertReviewGateFinding(repo.fullName, prNumber, {
          finding,
          reviewCommentId: thread.commentId,
          threadNodeId: thread.threadId,
          expectedLastEvaluatedHeadSha: finding.lastEvaluatedHeadSha,
          expectedContextHash: finding.contextHash,
        });
      }
    } catch (error) {
      this.logger.warn({ error, repo: repo.fullName, prNumber }, "failed to persist review gate thread ids");
    }
  }

  private trustedReviewRequest(trigger: ReviewTrigger): string {
    return trigger.request ? truncate(trigger.request, 2_000) : "";
  }

  private async safeSubmitReview(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    headSha: string,
    event: ReviewSubmitEvent,
    body: string,
    comments: InlineReviewComment[],
  ): Promise<void> {
    try {
      await submitReviewWithInlineComments(octokit, repo, prNumber, headSha, event, body, comments);
      return;
    } catch (error) {
      this.logger.warn(
        { error, repo: repo.fullName, prNumber, inlineComments: comments.length },
        "inline review submit failed; retrying without inline comments",
      );
    }
    try {
      await submitReviewWithInlineComments(octokit, repo, prNumber, headSha, event, body, []);
      return;
    } catch (error) {
      this.logger.warn(
        { error, repo: repo.fullName, prNumber },
        "review submit failed; falling back to a plain PR comment",
      );
      await postPrComment(octokit, repo, prNumber, body);
    }
  }

  private async tryResolveThread(octokit: Octokit, threadNodeId: string): Promise<void> {
    try {
      await resolveReviewThread(octokit, threadNodeId);
    } catch (error) {
      this.logger.warn({ error, threadNodeId }, "failed to resolve review thread");
    }
  }

  private findingMarker(fingerprint: string): string {
    return `<!-- seori-finding:${fingerprint} -->`;
  }

  private inlineCommentBody(finding: ClassifiedFinding): string {
    const convergenceTag =
      finding.convergence === "regression"
        ? " ♻️ 리뷰 대응으로 생긴 새 결함"
        : finding.convergence === "carried"
          ? " ⏳ 지속"
          : "";
    return [
      `**[${SEVERITY_LABEL[finding.severity]} · ${finding.category}]${convergenceTag} ${finding.title}**`,
      "",
      finding.impact || "(영향 설명 없음)",
      finding.fix ? `\n수정 방향: ${finding.fix}` : "",
      "",
      this.findingMarker(finding.fingerprint),
    ].filter((line) => line !== "").join("\n");
  }

  private followupIssueTitle(finding: ClassifiedFinding): string {
    return truncate(`[Seori][${SEVERITY_LABEL[finding.severity]}] ${finding.title}`, 200);
  }

  private followupIssueBody(repo: RepoRef, prNumber: number, finding: ClassifiedFinding): string {
    return [
      `원본 PR: ${repo.fullName}#${prNumber}`,
      `심각도: ${SEVERITY_LABEL[finding.severity]} (${finding.category})`,
      finding.file ? `위치: \`${finding.file}${finding.line ? `:${finding.line}` : ""}\`` : undefined,
      "",
      "### 내용",
      finding.impact || "(설명 없음)",
      "",
      "### 제안",
      finding.fix || "(제안 없음)",
      "",
      "Seori PR Bot이 리뷰 턴을 줄이기 위해 향후개선/리팩토링 성격 항목으로 분리해 등록했습니다. 머지를 차단하지 않습니다.",
      this.findingMarker(finding.fingerprint),
    ].filter((line): line is string => line !== undefined).join("\n");
  }

  private buildStructuredSummary(data: {
    headSha: string;
    classified: ClassifiedFinding[];
    resolved: StoredFinding[];
    offloaded: OffloadedFinding[];
    blockingCount: number;
    acceptanceCriteria: string[];
    anchors: Map<string, Set<number>>;
    tiebreakerProvider?: AiReviewProviderName;
  }): string {
    const offloadedFingerprints = new Set(data.offloaded.map((entry) => entry.finding.fingerprint));
    const newCount = data.classified.filter((f) => f.convergence === "new" && !offloadedFingerprints.has(f.fingerprint)).length;
    const regressionCount = data.classified.filter((f) => f.convergence === "regression").length;
    const carriedCount = data.classified.filter((f) => f.convergence === "carried").length;

    const blocking = data.classified.filter((f) => isBlockingAfterConvergence(f, this.config.blockOnMedium));
    const stalled = data.classified.filter((f) => f.stalled && isBlocking(f, this.config.blockOnMedium));
    const stalledFingerprints = new Set(stalled.map((f) => f.fingerprint));
    const nonBlockingInline = data.classified.filter(
      (f) =>
        !isBlockingAfterConvergence(f, this.config.blockOnMedium) &&
        !offloadedFingerprints.has(f.fingerprint) &&
        !stalledFingerprints.has(f.fingerprint),
    );

    const anchorNote = (f: ClassifiedFinding): string =>
      f.file && f.line && data.anchors.get(f.file)?.has(f.line) ? "인라인 코멘트 참고" : "요약 참고";

    const lines: string[] = [
      "## Seori 리뷰",
      "",
      `HEAD: \`${data.headSha}\``,
      "",
      "### 수렴 현황",
      "| 구분 | 건수 |",
      "|---|---|",
      `| 🆕 새 발견 | ${newCount} |`,
      `| ♻️ 리뷰 대응으로 생긴 새 결함 | ${regressionCount} |`,
      `| ✅ 이전 결함 해결 | ${data.resolved.length} |`,
      `| ⏳ 지속 | ${carriedCount} |`,
      `| 📤 이슈 이관(Medium/Low) | ${data.offloaded.length} |`,
      "",
      `남은 차단 항목(${this.config.blockOnMedium ? "Critical/High/Medium" : "Critical/High"}): **${data.blockingCount}**`,
      data.blockingCount === 0 ? "→ 반드시 수정할 항목이 없어 수렴했습니다." : "→ 위 항목을 해결하면 수렴합니다.",
    ];

    if (data.tiebreakerProvider) {
      lines.push(
        "",
        `> ♻️ 리뷰가 여러 라운드 수렴하지 못해 이번 판단은 2차 의견 모델(**${data.tiebreakerProvider}**)로 재검토했습니다.`,
      );
    }

    if (data.acceptanceCriteria.length > 0) {
      lines.push("", "### 인수조건");
      for (const criterion of data.acceptanceCriteria) {
        lines.push(`- ${criterion}`);
      }
    }

    if (blocking.length > 0) {
      lines.push("", `### 반드시 수정 (${this.config.blockOnMedium ? "Critical/High/Medium" : "Critical/High"})`);
      for (const finding of blocking) {
        lines.push(`- [${SEVERITY_LABEL[finding.severity]}] ${this.findingLocation(finding)} ${finding.title} — ${anchorNote(finding)}`);
      }
    }

    if (nonBlockingInline.length > 0) {
      lines.push("", "### 비차단 지적 (Medium/Low)");
      for (const finding of nonBlockingInline) {
        lines.push(`- [${SEVERITY_LABEL[finding.severity]}] ${this.findingLocation(finding)} ${finding.title} — ${anchorNote(finding)}`);
      }
    }

    if (stalled.length > 0) {
      lines.push(
        "",
        "### 수렴 조정 (반복 지적 → 비차단 전환)",
        "여러 라운드 반복됐지만 해당 파일이 이후 변경되지 않아 병합을 무한 차단하지 않도록 비차단 처리했습니다. 오탐일 수 있으니 근거를 재확인하고, 실제 결함이면 코드를 수정하세요.",
      );
      for (const finding of stalled) {
        lines.push(`- [${SEVERITY_LABEL[finding.severity]}] ${this.findingLocation(finding)} ${finding.title}`);
      }
    }

    if (data.offloaded.length > 0) {
      lines.push("", "### 이슈로 이관 (향후개선/리팩토링)");
      for (const entry of data.offloaded) {
        lines.push(`- [${SEVERITY_LABEL[entry.finding.severity]} · ${entry.finding.category}] ${entry.finding.title} → #${entry.issueNumber}`);
      }
    }

    if (data.resolved.length > 0) {
      lines.push("", "### 이전 결함 해결");
      for (const finding of data.resolved) {
        lines.push(`- ✅ ${finding.file ? `\`${finding.file}\` ` : ""}${finding.title}`);
      }
    }

    lines.push("", "### 후속 조치");
    lines.push(
      data.blockingCount === 0
        ? "- 새 커밋이 올라오지 않는 한 추가 에이전트 작업은 필요 없습니다."
        : "- 반드시 수정 항목을 반영한 뒤 다시 리뷰를 요청하거나 새 커밋을 푸시하세요.",
    );

    return lines.join("\n");
  }

  // Approval-framed body: unlike buildStructuredSummary (a fault-finding review),
  // this answers "is it safe to merge, and what residual risk remains" — so it
  // states why approval is justified and lists the non-blocking issues that stay.
  private buildApprovalSummary(data: {
    headSha: string;
    classified: ClassifiedFinding[];
    resolved: StoredFinding[];
    offloaded: OffloadedFinding[];
    acceptanceCriteria: string[];
  }): string {
    const offloadedFingerprints = new Set(data.offloaded.map((entry) => entry.finding.fingerprint));
    const remaining = data.classified
      .filter(
        (finding) =>
          !isBlocking(finding, this.config.blockOnMedium) && !offloadedFingerprints.has(finding.fingerprint),
      )
      .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
    const blockLabel = this.config.blockOnMedium ? "Critical/High/Medium" : "Critical/High";

    const lines: string[] = [
      "## 승인 판단",
      "",
      `HEAD: \`${data.headSha}\``,
      "",
      `리뷰 범위에서 머지를 막을 결함(${blockLabel})이 없어 **머지 가능**으로 판단합니다.`,
      '승인은 "차단할 결함이 없음"을 의미하며, 모든 동작을 실행·검증했다는 뜻은 아닙니다.',
      "",
      "### 판단 요약",
      `- 이번 라운드 해결: ${data.resolved.length}건`,
      `- 남은 비차단 이슈: ${remaining.length}건 (머지를 막지 않음)`,
      `- 후속 이슈로 이관: ${data.offloaded.length}건`,
    ];

    if (data.acceptanceCriteria.length > 0) {
      lines.push("", "### 머지 전 확인 권장 (인수조건)");
      for (const criterion of data.acceptanceCriteria) {
        lines.push(`- [ ] ${criterion}`);
      }
      lines.push("", "_위 인수조건에는 봇이 직접 실행·검증하지 못한 항목이 포함될 수 있습니다. 머지 전 확인하세요._");
    }

    if (remaining.length > 0) {
      lines.push("", "### 남은 이슈 (비차단)");
      for (const finding of remaining) {
        lines.push(`- [${SEVERITY_LABEL[finding.severity]}] ${this.findingLocation(finding)} ${finding.title}`);
      }
    }

    if (data.offloaded.length > 0) {
      lines.push("", "### 후속 이슈로 이관 (향후개선/리팩토링)");
      for (const entry of data.offloaded) {
        lines.push(`- [${SEVERITY_LABEL[entry.finding.severity]} · ${entry.finding.category}] ${entry.finding.title} → #${entry.issueNumber}`);
      }
    }

    if (data.resolved.length > 0) {
      lines.push("", "### 이번 라운드 해결됨");
      for (const finding of data.resolved) {
        lines.push(`- ✅ ${finding.file ? `\`${finding.file}\` ` : ""}${finding.title}`);
      }
    }

    lines.push("", "### 권장 후속");
    lines.push(
      remaining.length > 0 || data.offloaded.length > 0
        ? "- 남은 비차단 이슈는 별도 커밋/PR에서 처리하세요. 머지를 막지 않습니다."
        : "- 추가 조치 없이 머지 가능합니다.",
    );

    return lines.join("\n");
  }

  private findingLocation(finding: ClassifiedFinding): string {
    if (!finding.file) {
      return "";
    }
    return `\`${finding.file}${finding.line ? `:${finding.line}` : ""}\``;
  }

  private async createAgentTextFromContext(
    context: PullRequestContext,
    request: string,
    trigger: ReviewTrigger,
  ): Promise<string> {
    const prompt = [
      "Analyze the pull request mention and choose the next agent action.",
      "",
      "Possible actions:",
      "- comment: answer, explain, ask for clarification, or report actionable findings.",
      "- approve: submit an approval review because the PR has no actionable findings remaining.",
      "- close: submit a request-changes review and close the PR because the same acceptance criteria remain unmet after repeated rounds.",
      "",
      "Decision rules:",
      "- If the user asks a direct question, answer it and choose comment unless the same message clearly asks for readiness or approval.",
      "- If the user says fixes were applied, thanks after addressing review feedback, asks for another look, or asks whether anything remains, perform a review-quality assessment.",
      "- Start by making the acceptance criteria explicit. Derive them only from the PR title/body, user request, recent maintainer comments, and unresolved review context.",
      "- If the PR now satisfies the acceptance criteria, narrow the review to defects introduced by the new changes made to satisfy those criteria, plus any clear stability regression those changes cause.",
      "- Do not reopen settled or unrelated issues just because older context is present. Reopen only when the latest diff contradicts a prior resolution or creates a new stability risk.",
      "- Choose approve only when the supplied diff and conversation show no actionable findings remain.",
      "- Treat `Current Changed File Contents` as the source of truth for the post-change file state when present. Do not claim code or configuration is missing if it is present there; GitHub file patches may be abbreviated.",
      "- Choose close when the same acceptance criterion has already failed across repeated rounds and the latest diff still does not address it. Tell the PR author to stop iterating on this PR and reopen a smaller, clearer PR if they still want to continue.",
      "- Never approve if any correctness, runtime, security, data loss, regression, required validation, or required test concern remains.",
      "- Never approve if GitHub mergeable is `false` or mergeable_state is `dirty`/`conflicting`; choose comment and give conflict-resolution steps.",
      "- Never approve while tests, build, lint, typecheck, or status checks are failing unless the conversation clearly identifies them as infrastructure-only and a maintainer explicitly accepts that risk.",
      "- Pending or queued checks are merge gates, not code review findings. Do not ask the PR author to wait for transient pending CI unless the context proves the job is stuck, unroutable, or using an ineligible runner.",
      "- Do not withhold approval solely because `mergeable_state` is `blocked`; use explicit failing Status Checks as the blocker signal. The current Seori Review gate may itself make GitHub report `blocked` until this review completes.",
      "- It is allowed to choose approve while checks are only pending; the system will hold approval until CI settles.",
      "- Do not flag Seorilabs ARC/self-hosted runner usage solely because it is self-hosted when the PR context shows a private repository and an eligible JS/TS lint, test, typecheck, or build job.",
      "- If evidence is insufficient, choose comment and state exactly what is missing.",
      `- If prior comments contain \`${NO_ACTION_REQUIRED_MARKER}\`, prefer markers whose recorded HEAD SHA matches the current PR Head SHA.`,
      "",
      "Output contract:",
      "- Include exactly one hidden action marker as the first non-empty line:",
      `  ${AGENT_APPROVE_MARKER}`,
      `  ${AGENT_COMMENT_MARKER}`,
      `  ${AGENT_CLOSE_MARKER}`,
      `- If action is approve, the Findings section must contain exactly: \`${NO_ACTIONABLE_FINDINGS_TEXT}\``,
      "- If action is comment because findings remain, list findings first, ordered by severity.",
      "- If action is close, the `### 판단` section must say the PR is being closed, identify the repeated unmet acceptance criterion, and tell the author not to keep iterating in this PR.",
      "",
      "Output format:",
      "## 에이전트 판단",
      "",
      "### 판단",
      "- `approve`, `comment`, 또는 `close`와 짧은 이유.",
      "",
      "### 인수조건",
      "- 이 PR이 merge되기 위해 반드시 만족해야 하는 조건만 1-4개로 명확히 쓰세요.",
      "",
      "### 발견사항",
      "- `[심각도] file_or_symbol`: 영향과 근거. 수정 방향.",
      "",
      "If there are no actionable findings, write exactly:",
      "### 발견사항",
      NO_ACTIONABLE_FINDINGS_TEXT,
      "",
      "### 검증",
      "- 이 PR에 유용한 구체적인 확인 항목만 포함하세요.",
      "",
      "### 후속 조치",
      "- 추가 에이전트 작업이 필요한지 명시하세요.",
      "",
      `Trigger: ${trigger.source}`,
      `Requested by: ${trigger.sender}`,
      `User request: ${request}`,
      "",
      context.markdown,
    ].join("\n");

    return this.gemini.agent(prompt);
  }

  private async createAnswerText(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    request: string,
    trigger: ReviewTrigger,
    workflow?: WorkflowExecution,
  ): Promise<GeneratedText> {
    const context = await buildPullRequestContext(octokit, repo, prNumber, this.config, this.contextOptions(workflow, request));
    const prompt = [
      "Answer the user's pull request question.",
      "",
      `Trigger: ${trigger.source}`,
      `Requested by: ${trigger.sender}`,
      "",
      "User request:",
      request,
      "",
      context.markdown,
    ].join("\n");

    return { text: await this.gemini.answer(prompt), headSha: context.headSha };
  }

  private contextOptions(workflow: WorkflowExecution | undefined, request: string | undefined): PullRequestContextOptions {
    return {
      installationToken: workflow?.installationToken,
      deepContextRequested: Boolean(request && /\bdeep\b|전체\s*맥락|전체\s*코드|full\s*context/iu.test(request)),
      reviewGatePromptReserveChars:
        this.gemini.structuredReviewInstructionChars() + REVIEW_GATE_METADATA_RESERVE_CHARS,
    };
  }

  private async runApprove(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    sender: string,
    reason: string,
    options: { skipValidation?: boolean } = {},
  ): Promise<void> {
    const status = await getPullRequestStatus(octokit, repo, prNumber);
    if (this.isClosedPullRequest(status)) {
      return;
    }
    if (!options.skipValidation && this.hasMergeConflict(status)) {
      await requestChangesPullRequest(
        octokit,
        repo,
        prNumber,
        this.mergeConflictText(repo, prNumber, status),
        status.headSha,
      );
      return;
    }
    if (!options.skipValidation && this.hasBlockingStatusChecks(status)) {
      await postPrComment(octokit, repo, prNumber, this.statusCheckBlockerText(status));
      return;
    }

    await this.approveAndNotify(
      octokit,
      repo,
      prNumber,
      status,
      this.approvalText(sender, reason, status.headSha, undefined, {
        validationSkipped: Boolean(options.skipValidation),
      }),
      {
        mode: options.skipValidation ? "force_manual" : "manual",
        sender,
        source: options.skipValidation ? "force_approve_command" : "approve_command",
        reason,
      },
    );
    await completeLatestOwnReviewCheckAsSuccess(
      octokit,
      repo,
      status.headSha,
      "수동 승인 완료",
      `@${sender}의 명시적 승인으로 현재 HEAD의 Seori Review 체크를 통과 처리했습니다.`,
    );
    await this.maybeSquashMergeApprovedPullRequest(
      octokit,
      repo,
      prNumber,
      status.headSha,
      options.skipValidation ? "force_manual" : "manual",
    );
  }

  private async approveAndNotify(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    status: PullRequestStatus,
    body: string,
    notification: {
      mode: ApprovalNotificationMode;
      sender: string;
      source: string;
      reason: string;
    },
  ): Promise<void> {
    await approvePullRequest(octokit, repo, prNumber, body, status.headSha);
    await this.operationsNotifier.notifyApproval({
      repoFullName: repo.fullName,
      prNumber,
      prTitle: status.title,
      prUrl: `https://github.com/${repo.fullName}/pull/${prNumber}`,
      headSha: status.headSha,
      sender: notification.sender,
      source: notification.source,
      reason: notification.reason,
      mode: notification.mode,
    });
  }

  private async maybeSquashMergeApprovedPullRequest(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    approvedHeadSha: string,
    mode: ApprovalNotificationMode,
  ): Promise<void> {
    if (!this.config.autoSquashMergeEnabled || mode === "force_manual" || mode === "review_gate") {
      return;
    }

    const status = await this.statusForSquashMerge(octokit, repo, prNumber);
    const skipReason = this.autoSquashMergeSkipReason(status, approvedHeadSha);
    if (skipReason) {
      this.logger.info(
        {
          repo: repo.fullName,
          prNumber,
          headSha: approvedHeadSha,
          skipReason,
          baseRef: status.baseRef,
          mergeable: status.mergeable,
          mergeableState: status.mergeableState,
        },
        "auto squash merge skipped",
      );
      return;
    }

    try {
      await this.squashMergeWithRetry(octokit, repo, prNumber, approvedHeadSha);
      this.logger.info(
        {
          repo: repo.fullName,
          prNumber,
          headSha: approvedHeadSha,
          mode,
        },
        "auto squash merge completed",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        {
          error,
          repo: repo.fullName,
          prNumber,
          headSha: approvedHeadSha,
          mode,
        },
        "auto squash merge failed",
      );
      await postPrComment(
        octokit,
        repo,
        prNumber,
        this.autoSquashMergeFailureText(status, approvedHeadSha, message),
      );
    }
  }

  private async squashMergeWithRetry(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    approvedHeadSha: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await squashMergePullRequest(octokit, repo, prNumber, approvedHeadSha);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await delay(1_000);
        }
      }
    }

    throw lastError;
  }

  private async shouldIgnoreClosedPullRequest(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
  ): Promise<boolean> {
    const status = await getPullRequestStatus(octokit, repo, prNumber);
    const ignored = this.isClosedPullRequest(status);
    if (ignored) {
      this.logger.info(
        {
          repo: repo.fullName,
          prNumber,
          state: status.state,
          merged: status.merged,
          headSha: status.headSha,
        },
        "closed pull request event ignored",
      );
    }
    return ignored;
  }

  private async shouldIgnoreResolvedReviewThread(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    commentId: number,
  ): Promise<boolean> {
    try {
      const resolved = await isReviewThreadResolved(octokit, repo, prNumber, commentId);
      if (resolved) {
        this.logger.info(
          {
            repo: repo.fullName,
            prNumber,
            commentId,
          },
          "resolved review thread mention ignored",
        );
      }
      return resolved;
    } catch (error) {
      this.logger.warn(
        {
          error,
          repo: repo.fullName,
          prNumber,
          commentId,
        },
        "review thread state lookup failed",
      );
      return false;
    }
  }

  private async currentStatusForPublish(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    expectedHeadSha: string,
    check: ActiveCheckRun | null,
  ): Promise<PullRequestStatus | null> {
    const status = await getPullRequestStatus(octokit, repo, prNumber);
    if (this.isClosedPullRequest(status)) {
      await this.completeTrackedCheck(
        check,
        "cancelled",
        "닫힌 PR 응답 취소",
        [
          "이 응답을 게시하기 전에 PR이 닫히거나 병합됐습니다.",
          "",
          `상태: \`${status.state}\``,
          `병합 여부: \`${status.merged}\``,
          `HEAD: \`${status.headSha}\``,
        ].join("\n"),
      );
      return null;
    }

    if (status.headSha !== expectedHeadSha) {
      await this.completeTrackedCheck(
        check,
        "cancelled",
        "오래된 PR 맥락 응답 취소",
        [
          "이 응답을 게시하기 전에 PR HEAD가 바뀌었습니다.",
          "",
          `기존 HEAD: \`${expectedHeadSha}\``,
          `현재 HEAD: \`${status.headSha}\``,
          "",
          "필요하면 현재 HEAD 기준으로 다시 리뷰를 요청하세요.",
        ].join("\n"),
      );
      return null;
    }

    return status;
  }

  private helpText(): string {
    if (this.config.acceptanceGuideModeEnabled) {
      return [
        "Seori는 현재 인수조건 안내 모드입니다.",
        "",
        "- PR 최초 생성 시 인수조건 가이드를 한 번만 게시합니다.",
        "- `/review`는 AI를 다시 호출하지 않고 기존 가이드 스레드의 Resolve 상태만 갱신합니다.",
        "- 누락 또는 소명이 필요한 review thread에 답한 뒤 Resolve해 주세요.",
        "- Seori는 GitHub approval, REQUEST_CHANGES 또는 자동 병합을 수행하지 않습니다.",
        "- 일반 질문에는 PR 맥락을 바탕으로 답변만 남깁니다.",
      ].join("\n");
    }
    return [
      "사용 가능한 명령:",
      "",
      "- `@seorilabs-seori /review`: 현재 PR을 리뷰합니다.",
      "- `@seori-bot /review`: 현재 PR을 리뷰합니다.",
      "- `@seorilabs-seori /approve [사유]`: GitHub approval review와 agent coordination marker를 남깁니다.",
      "- `@seorilabs-seori /approve --skip-validation [사유]`: 봇의 병합 충돌/상태 체크 차단을 건너뛰고 즉시 approval review를 남깁니다.",
      "- `@seorilabs-seori /force-approve [사유]`: `/approve --skip-validation`과 같습니다.",
      "- `@seorilabs-seori 질문`: PR 맥락을 분석하고 comment 또는 approve를 결정합니다. `/review deep`처럼 요청하면 deep repository context를 강제로 사용합니다.",
      "- inline review comment에서 `@seorilabs-seori 질문`: 해당 review comment 맥락으로 답하거나 PR을 approve합니다.",
    ].join("\n");
  }

  private approvalText(
    sender: string,
    reason: string,
    headSha: string,
    analysis?: string,
    options: { validationSkipped?: boolean } = {},
  ): string {
    return [
      `<!-- ${NO_ACTION_REQUIRED_MARKER} head=${headSha} -->`,
      "## 승인 상태",
      "",
      `승인 요청자: @${sender}`,
      `적용 HEAD: \`${headSha}\``,
      `사유: ${reason}`,
      options.validationSkipped
        ? "검증 스킵: 명시 명령으로 봇의 병합 충돌/상태 체크 차단을 건너뜀"
        : undefined,
      "",
      "새 커밋이 올라오거나 maintainer가 명시적으로 다시 리뷰를 요청하지 않는 한 추가 에이전트 작업은 필요 없습니다.",
      "",
      "참고: stale approval 해제 여부는 repository branch protection 설정을 따릅니다.",
      analysis ? "" : undefined,
      analysis ? "## 판단 근거" : undefined,
      analysis || undefined,
    ].filter((line): line is string => line !== undefined).join("\n");
  }

  private agentActionRequiredText(
    kind: string,
    headSha: string,
    body: string,
    options: AgentRunOptions,
  ): string {
    if (!options.staleSelfTrigger) {
      return this.actionRequiredText(kind, headSha, body);
    }

    return this.actionRequiredText(STALE_SELF_TRIGGER_ACTION_KIND, headSha, body, {
      blocked_kind: kind,
      signal_at: options.staleSelfTrigger.signalAt,
      response_at: options.staleSelfTrigger.responseAt,
      response_kind: options.staleSelfTrigger.responseKind,
    });
  }

  private agentCommentText(headSha: string, body: string, options: AgentRunOptions): string {
    if (!options.staleSelfTrigger) {
      return body;
    }

    return this.actionRequiredText(STALE_SELF_TRIGGER_ACTION_KIND, headSha, body, {
      blocked_kind: "review",
      signal_at: options.staleSelfTrigger.signalAt,
      response_at: options.staleSelfTrigger.responseAt,
      response_kind: options.staleSelfTrigger.responseKind,
    });
  }

  private actionRequiredText(
    kind: string,
    headSha: string,
    body: string,
    attrs: Record<string, string | undefined> = {},
  ): string {
    const markerAttrs = {
      kind,
      head: headSha,
      ...attrs,
    };
    const marker = Object.entries(markerAttrs)
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([key, value]) => `${key}=${this.markerAttributeValue(value)}`)
      .join(" ");
    return [`<!-- ${ACTION_REQUIRED_MARKER} ${marker} -->`, body].join("\n");
  }

  private markerAttributeValue(value: string): string {
    return value.trim().replace(/\s+/g, "_");
  }

  private mergeConflictText(repo: RepoRef, prNumber: number, status: PullRequestStatus): string {
    return [
      `<!-- ${MERGE_CONFLICT_MARKER} head=${status.headSha} -->`,
      "## 병합 충돌",
      "",
      "GitHub 기준으로 현재 이 PR은 깨끗하게 병합할 수 없습니다.",
      "",
      `- PR: \`${repo.fullName}#${prNumber}\``,
      `- Base: \`${status.baseRepoFullName}:${status.baseRef}\``,
      `- Head: \`${status.headRepoFullName}:${status.headRef}\``,
      `- Head SHA: \`${status.headSha}\``,
      `- GitHub mergeable: \`${status.mergeable ?? "unknown"}\``,
      `- GitHub mergeable_state: \`${status.mergeableState}\``,
      "",
      "### 권장 조치",
      "",
      "```bash",
      `gh pr checkout ${prNumber} -R ${repo.fullName}`,
      `git fetch origin ${status.baseRef}`,
      `git merge origin/${status.baseRef}`,
      "# Git이 알려준 파일의 conflict marker를 해결",
      "git status",
      "git add <resolved-files>",
      "git commit",
      "git push",
      "```",
      "",
      "approval은 제출하지 않았습니다. 병합 충돌을 먼저 해결한 뒤 다시 리뷰를 요청하세요.",
    ].join("\n");
  }

  private hasMergeConflict(status: PullRequestStatus): boolean {
    return status.mergeable === false || ["dirty", "conflicting"].includes(status.mergeableState.toLowerCase());
  }

  private isClosedPullRequest(status: PullRequestStatus): boolean {
    return status.merged || status.state.toLowerCase() !== "open";
  }

  private async statusForSquashMerge(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
  ): Promise<PullRequestStatus> {
    let status = await getPullRequestStatus(octokit, repo, prNumber);
    for (let attempt = 0; attempt < 3 && this.hasPendingStatusChecks(status); attempt += 1) {
      await delay(1_000);
      status = await getPullRequestStatus(octokit, repo, prNumber);
    }
    return status;
  }

  private autoSquashMergeSkipReason(status: PullRequestStatus, approvedHeadSha: string): string | null {
    if (this.isClosedPullRequest(status)) {
      return "pull request is already closed or merged";
    }
    if (status.headSha !== approvedHeadSha) {
      return "pull request head changed after approval";
    }
    if (status.draft) {
      return "pull request is draft";
    }
    if (status.baseRef !== "main") {
      return "base branch is not main";
    }
    if (this.hasMergeConflict(status)) {
      return "pull request has merge conflicts";
    }
    if (this.hasBlockingStatusChecks(status)) {
      return "status checks are not green";
    }
    return null;
  }

  private autoSquashMergeFailureText(status: PullRequestStatus, approvedHeadSha: string, message: string): string {
    return [
      `<!-- ${AUTO_SQUASH_MERGE_FAILED_MARKER} head=${approvedHeadSha} -->`,
      "## 자동 Squash Merge 실패",
      "",
      "Seori approval은 제출됐지만, GitHub Squash Merge API 호출이 실패했습니다.",
      "",
      `- HEAD: \`${approvedHeadSha}\``,
      `- Base: \`${status.baseRepoFullName}:${status.baseRef}\``,
      `- GitHub mergeable: \`${status.mergeable ?? "unknown"}\``,
      `- GitHub mergeable_state: \`${status.mergeableState}\``,
      `- 오류: \`${message}\``,
    ].join("\n");
  }

  private hasBlockingStatusChecks(status: PullRequestStatus): boolean {
    return this.hasFailingStatusChecks(status) || this.hasPendingStatusChecks(status);
  }

  private hasFailingStatusChecks(status: PullRequestStatus): boolean {
    return status.statusChecks.failing.length > 0;
  }

  private hasPendingStatusChecks(status: PullRequestStatus): boolean {
    return status.statusChecks.pending.length > 0;
  }

  private shouldDeferApprovalForCi(trigger: ReviewTrigger, status: PullRequestStatus): boolean {
    return this.hasPendingStatusChecks(status) || (
      status.statusChecks.total === 0 && this.isAutomaticReviewTrigger(trigger.source)
    );
  }

  private isAutomaticReviewTrigger(source: string): boolean {
    return ["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"].includes(source);
  }

  private statusCheckBlockerText(status: PullRequestStatus): string {
    return [
      "## 상태 체크",
      "",
      "현재 HEAD의 검증이 아직 통과하지 않아 approval review를 제출하지 않았습니다.",
      "",
      status.statusChecks.failing.length > 0 ? "### 실패" : undefined,
      ...status.statusChecks.failing.map((check) => `- ${check}`),
      status.statusChecks.pending.length > 0 ? "### 대기 중" : undefined,
      ...status.statusChecks.pending.map((check) => `- ${check}`),
      "",
      "실패한 체크를 고치거나 대기 중인 체크가 끝난 뒤 다시 리뷰를 요청하세요.",
    ].filter((line): line is string => line !== undefined).join("\n");
  }

  private shouldApproveAgentText(text: string, status: PullRequestStatus): boolean {
    return (
      !this.isClosedPullRequest(status) &&
      !this.hasMergeConflict(status) &&
      !this.hasBlockingStatusChecks(status) &&
      bodyIncludesBotActionMarker(text, "approve") &&
      this.wantsApproval(text)
    );
  }

  private shouldApproveReviewText(text: string, status: PullRequestStatus): boolean {
    return (
      !this.isClosedPullRequest(status) &&
      !this.hasMergeConflict(status) &&
      !this.hasBlockingStatusChecks(status) &&
      this.wantsApproval(text)
    );
  }

  private shouldCloseAgentText(text: string, status: PullRequestStatus): boolean {
    return (
      !this.isClosedPullRequest(status) &&
      !this.hasMergeConflict(status) &&
      bodyIncludesBotActionMarker(text, "close")
    );
  }

  private wantsApproval(text: string): boolean {
    return /\bNo actionable findings\./iu.test(text) || text.includes(NO_ACTIONABLE_FINDINGS_TEXT);
  }

  private publicAgentText(text: string): string {
    return text
      .split("\n")
      .filter((line) => !isBotActionMarkerLine(line))
      .join("\n")
      .trim();
  }
}
