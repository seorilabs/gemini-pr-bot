import type { Config } from "./config.js";
import { CI_RECHECK_EVENT, STALE_REVIEW_SELF_TRIGGER_EVENT, STALE_SELF_TRIGGER_ACTION_KIND } from "./events.js";
import { GeminiClient, isAiProviderCooldownError } from "./gemini.js";
import { metrics, type GaugeSample } from "./metrics.js";
import {
  approvePullRequest,
  buildPullRequestContext,
  changedFilesBetween,
  closePullRequest,
  commentAndCloseIssue,
  completeCheck,
  createFollowupIssue,
  createInProgressCheck,
  ensureLabelExists,
  getPullRequestStatus,
  isReviewThreadResolved,
  isPullRequestIssue,
  isTrustedAssociation,
  listReviewThreads,
  postPrComment,
  postReviewCommentReply,
  requestChangesPullRequest,
  resolveReviewThread,
  REVIEW_AGENT_NAME,
  repoFromPayload,
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
import type { ReviewFindingStore } from "./workflow.js";
import {
  classifyConvergence,
  isBlocking,
  isOffloadable,
  parseAnchorableLines,
  parseStructuredReview,
  SEVERITY_LABEL,
  toFindings,
  type ClassifiedFinding,
  type StoredFinding,
} from "./review.js";
import { ApprovalTelegramNotifier, type ApprovalNotificationMode } from "./telegram.js";
import { parseBotCommand, truncate } from "./text.js";
import {
  BOT_GITHUB_LOGIN,
  bodyIncludesBotActionMarker,
  botActionMarker,
  botAutoSquashMergeFailedMarker,
  botStatusMarker,
  isBotActionMarkerLine,
} from "./identity.js";

const NO_ACTION_REQUIRED_MARKER = botStatusMarker("no-action-required");
const ACTION_REQUIRED_MARKER = botStatusMarker("action-required");
const MERGE_CONFLICT_MARKER = botStatusMarker("merge-conflict");
const AGENT_APPROVE_MARKER = botActionMarker("approve");
const AGENT_COMMENT_MARKER = botActionMarker("comment");
const AGENT_CLOSE_MARKER = botActionMarker("close");
const NO_ACTIONABLE_FINDINGS_TEXT = "조치할 항목 없음.";
const AUTO_SQUASH_MERGE_FAILED_MARKER = botAutoSquashMergeFailedMarker();

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
};

type CiRecheckRequest = {
  checkRunId: number;
  prNumber: number;
  headSha: string;
  mode: "review" | "agent";
  sender: string;
  source: string;
  approvalReason: string;
  approvalBody: string;
  startedAt: string;
  attempt: number;
};

export class PrBot {
  private readonly gemini: GeminiClient;
  private readonly approvalNotifier: ApprovalTelegramNotifier;
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly activeChecks = new Map<number, ActiveCheckRun>();
  private nextActiveCheckKey = 1;
  private shuttingDown = false;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.approvalNotifier = new ApprovalTelegramNotifier(config, logger);
    this.gemini = new GeminiClient(config, logger, (event) => this.approvalNotifier.notifyQuotaEvent(event));
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
    await this.approvalNotifier.close();

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
      await this.runReview(octokit, repo, issueNumber, {
        source: "issue_comment",
        sender: payload.sender.login,
        request: command.request,
      }, workflow);
      return;
    }

    if (command.mode === "agent") {
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
      await this.runAgent(octokit, repo, prNumber, command.request, {
        source: "review_comment",
        sender: payload.sender.login,
      }, { type: "review_comment", commentId: payload.comment.id }, workflow);
      return;
    }

    const generated =
      command.mode === "review"
        ? await this.createReviewText(octokit, repo, prNumber, {
            source: "review_comment",
            sender: payload.sender.login,
            request: command.request,
          }, workflow)
        : await this.createAnswerText(octokit, repo, prNumber, command.request, {
            source: "review_comment",
            sender: payload.sender.login,
          }, workflow);

    if (!(await this.currentStatusForPublish(octokit, repo, prNumber, generated.headSha, null))) {
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
      await this.runReview(octokit, repo, prNumber, {
        source: "pull_request_review",
        sender: payload.sender.login,
        request: command.request,
      }, workflow);
      return;
    }

    if (command.mode === "approve" || command.mode === "force_approve") {
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
    if (!shouldHandleRepository(payload, this.config) || payload.sender.type === "Bot") {
      return;
    }

    const repo = repoFromPayload(payload);
    const action = payload.action;
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
    await completeCheck(octokit, repo, request.checkRunId, "success", "PR 승인 완료", request.approvalBody);
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

  private async runReview(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    trigger: ReviewTrigger,
    workflow?: WorkflowExecution,
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

      if (this.config.structuredReviewEnabled && workflow?.reviewFindingStore) {
        const handled = await this.runStructuredReview(
          octokit,
          repo,
          prNumber,
          context,
          trigger,
          check,
          workflow,
        );
        if (handled) {
          return;
        }
        this.logger.warn(
          { repo: repo.fullName, prNumber, headSha: context.headSha },
          "structured review unavailable; falling back to free-form review",
        );
      }

      const reviewText = await this.createReviewTextFromContext(context, trigger);
      if (await this.cancelTrackedCheckIfShuttingDown(check, "리뷰 취소", "리뷰 결과를 게시하기 전에 봇이 중지되었습니다.")) {
        return;
      }
      const latest = await this.currentStatusForPublish(octokit, repo, prNumber, context.headSha, check);
      if (!latest) {
        return;
      }

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
            reason: "리뷰 결과 조치할 항목이 없습니다.",
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
          this.approvalText(trigger.sender, "리뷰 결과 조치할 항목이 없습니다.", latest.headSha, reviewText),
          {
            mode: "review",
            sender: trigger.sender,
            source: trigger.source,
            reason: "리뷰 결과 조치할 항목이 없습니다.",
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
      mode: "review" | "agent";
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
    const mode = raw.mode === "agent" ? "agent" : "review";

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

  // Human-like review: one batched review with inline draft comments anchored to the
  // problem lines, a Start-Review summary that tracks convergence across turns, and
  // refactor/future-improvement Medium/Low offloaded to linked GitHub issues.
  // Returns true when it fully handled the turn, false to fall back to free-form review.
  private async runStructuredReview(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    context: PullRequestContext,
    trigger: ReviewTrigger,
    check: ActiveCheckRun | null,
    workflow: WorkflowExecution,
  ): Promise<boolean> {
    const store = workflow.reviewFindingStore!;
    const prior = await store.listOpenReviewFindings(repo.fullName, prNumber);
    const priorByFingerprint = new Map(prior.map((finding) => [finding.fingerprint, finding]));
    const baseSha = prior.find((finding) => finding.lastSeenHead && finding.lastSeenHead !== context.headSha)?.lastSeenHead ?? "";
    const changedFiles = await changedFilesBetween(octokit, repo, baseSha, context.headSha);

    const structuredPrompt = this.structuredReviewPrompt(context, trigger, prior);
    let parsed = parseStructuredReview(await this.gemini.reviewStructured(structuredPrompt));
    if (!parsed) {
      // Providers occasionally wrap the JSON in prose despite the schema/JSON-mode
      // request. Retry once before degrading to the free-form review (which loses
      // convergence tracking and inline anchoring).
      this.logger.warn(
        { repo: repo.fullName, prNumber, headSha: context.headSha },
        "structured review JSON parse failed; retrying once",
      );
      parsed = parseStructuredReview(await this.gemini.reviewStructured(structuredPrompt));
    }
    if (!parsed) {
      return false;
    }

    const findings = toFindings(parsed.findings);
    const { classified, resolved } = classifyConvergence(findings, prior, changedFiles);

    const anchors = await this.buildAnchorMap(octokit, repo, prNumber);

    // Verify the head is still current before any side effects (issue creation,
    // review submission). On a stale/closed head the helper completes the check.
    if (await this.cancelTrackedCheckIfShuttingDown(check, "리뷰 취소", "리뷰 결과를 게시하기 전에 봇이 중지되었습니다.")) {
      return true;
    }
    const latest = await this.currentStatusForPublish(octokit, repo, prNumber, context.headSha, check);
    if (!latest) {
      return true;
    }

    const offloaded: OffloadedFinding[] = [];
    const inlineComments: InlineReviewComment[] = [];
    let labelEnsured = false;

    for (const finding of classified) {
      if (this.config.followupIssueEnabled && isOffloadable(finding)) {
        const existingIssue = priorByFingerprint.get(finding.fingerprint)?.issueNumber ?? null;
        if (existingIssue) {
          offloaded.push({
            finding,
            issueNumber: existingIssue,
            url: `https://github.com/${repo.fullName}/issues/${existingIssue}`,
          });
        } else {
          if (!labelEnsured) {
            await ensureLabelExists(octokit, repo, this.config.followupIssueLabel);
            labelEnsured = true;
          }
          const created = await createFollowupIssue(octokit, repo, {
            title: this.followupIssueTitle(finding),
            body: this.followupIssueBody(repo, prNumber, finding),
            labels: [this.config.followupIssueLabel],
          });
          offloaded.push({ finding, issueNumber: created.number, url: created.url });
        }
        continue;
      }

      if (finding.file && finding.line && anchors.get(finding.file)?.has(finding.line)) {
        inlineComments.push({ path: finding.file, line: finding.line, body: this.inlineCommentBody(finding) });
      }
    }

    const blockingCount = classified.filter((finding) => isBlocking(finding, this.config.blockOnMedium)).length;
    const summary = this.buildStructuredSummary({
      headSha: context.headSha,
      classified,
      resolved,
      offloaded,
      blockingCount,
      acceptanceCriteria: parsed.acceptanceCriteria,
      anchors,
    });

    const event: ReviewSubmitEvent = blockingCount > 0 ? "REQUEST_CHANGES" : "COMMENT";
    const reviewBody = blockingCount > 0 ? this.actionRequiredText("review", context.headSha, summary) : summary;
    const shouldPostReview = blockingCount > 0 || inlineComments.length > 0 || classified.length > 0 || resolved.length > 0;
    if (shouldPostReview) {
      await this.safeSubmitReview(octokit, repo, prNumber, context.headSha, event, reviewBody, inlineComments);
    }

    await this.persistStructuredFindings(octokit, repo, prNumber, context.headSha, store, {
      classified,
      resolved,
      offloaded,
      priorByFingerprint,
      hasInline: inlineComments.length > 0,
    });

    if (blockingCount > 0) {
      await this.completeTrackedCheck(check, "action_required", "반드시 수정 필요", reviewBody);
      return true;
    }

    const noBlockingReason = "리뷰 결과 반드시 수정할 항목(Critical/High)이 없습니다.";

    if (this.hasFailingStatusChecks(latest)) {
      const blockerText = this.actionRequiredText("status-check", latest.headSha, this.statusCheckBlockerText(latest));
      await postPrComment(octokit, repo, prNumber, blockerText);
      await this.completeTrackedCheck(check, "action_required", "상태 체크 확인 필요", blockerText);
      return true;
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
          mode: "review",
          sender: trigger.sender,
          source: trigger.source,
          reason: noBlockingReason,
          body: summary,
        },
        this.hasPendingStatusChecks(latest) ? this.config.ciRecheckIntervalMs : this.config.ciInitialWaitMs,
      );
      return true;
    }

    await this.approveAndNotify(
      octokit,
      repo,
      prNumber,
      latest,
      this.approvalText(trigger.sender, noBlockingReason, latest.headSha, summary),
      {
        mode: "review",
        sender: trigger.sender,
        source: trigger.source,
        reason: noBlockingReason,
      },
    );
    await this.completeTrackedCheck(check, "success", "PR 승인 완료", summary);
    await this.maybeSquashMergeApprovedPullRequest(octokit, repo, prNumber, latest.headSha, "review");
    return true;
  }

  private structuredReviewPrompt(
    context: PullRequestContext,
    trigger: ReviewTrigger,
    prior: StoredFinding[],
  ): string {
    const priorList = prior.length
      ? prior
          .map((finding) => `- [${finding.severity}] ${finding.file ? `${finding.file}: ` : ""}${finding.title}`)
          .join("\n")
      : "(없음)";
    return [
      "Review this pull request and return findings as a single JSON object per the schema.",
      "",
      "Previously open Seori findings — for each, judge against the CURRENT diff. If it is now fixed, simply omit it. If it still applies, include it again with the same title wording.",
      priorList,
      "",
      `Trigger: ${trigger.source}`,
      `Requested by: ${trigger.sender}`,
      trigger.request ? `User request: ${trigger.request}` : "",
      "",
      context.markdown,
    ].join("\n");
  }

  private async buildAnchorMap(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
  ): Promise<Map<string, Set<number>>> {
    const anchors = new Map<string, Set<number>>();
    try {
      const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner: repo.owner,
        repo: repo.repo,
        pull_number: prNumber,
        per_page: 100,
      });
      for (const file of files) {
        anchors.set(String(file.filename), parseAnchorableLines(file.patch));
      }
    } catch (error) {
      this.logger.warn({ error, repo: repo.fullName, prNumber }, "failed to build inline anchor map");
    }
    return anchors;
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

  private async persistStructuredFindings(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    headSha: string,
    store: ReviewFindingStore,
    data: {
      classified: ClassifiedFinding[];
      resolved: StoredFinding[];
      offloaded: OffloadedFinding[];
      priorByFingerprint: Map<string, StoredFinding>;
      hasInline: boolean;
    },
  ): Promise<void> {
    const offloadByFingerprint = new Map(data.offloaded.map((entry) => [entry.finding.fingerprint, entry]));

    const threadByFingerprint = new Map<string, { threadId: string; commentId: number | null }>();
    if (data.hasInline) {
      try {
        const threads = await listReviewThreads(octokit, repo, prNumber);
        for (const thread of threads) {
          for (const body of thread.bodies) {
            const match = body.match(/seori-finding:([0-9a-f]{40})/);
            if (match && !threadByFingerprint.has(match[1])) {
              threadByFingerprint.set(match[1], {
                threadId: thread.threadId,
                commentId: thread.commentDatabaseIds[0] ?? null,
              });
            }
          }
        }
      } catch (error) {
        this.logger.warn({ error, repo: repo.fullName, prNumber }, "failed to map review threads to findings");
      }
    }

    for (const finding of data.classified) {
      const thread = threadByFingerprint.get(finding.fingerprint);
      const offload = offloadByFingerprint.get(finding.fingerprint);
      await store.upsertReviewFinding(repo.fullName, prNumber, {
        fingerprint: finding.fingerprint,
        severity: finding.severity,
        category: finding.category,
        file: finding.file,
        title: finding.title,
        headSha,
        reviewCommentId: thread?.commentId ?? null,
        threadNodeId: thread?.threadId ?? null,
        issueNumber: offload?.issueNumber ?? null,
      });

      // A finding that moved to a follow-up issue no longer needs an open inline thread.
      if (offload) {
        const priorThread = data.priorByFingerprint.get(finding.fingerprint)?.threadNodeId;
        if (priorThread) {
          await this.tryResolveThread(octokit, priorThread);
        }
      }
    }

    for (const finding of data.resolved) {
      if (finding.threadNodeId) {
        await this.tryResolveThread(octokit, finding.threadNodeId);
      }
      if (finding.issueNumber) {
        await commentAndCloseIssue(
          octokit,
          repo,
          finding.issueNumber,
          "Seori: PR에서 해당 지적이 반영되어 follow-up 이슈를 닫습니다.",
        );
      }
      await store.markReviewFindingResolved(repo.fullName, prNumber, finding.fingerprint);
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
  }): string {
    const offloadedFingerprints = new Set(data.offloaded.map((entry) => entry.finding.fingerprint));
    const newCount = data.classified.filter((f) => f.convergence === "new" && !offloadedFingerprints.has(f.fingerprint)).length;
    const regressionCount = data.classified.filter((f) => f.convergence === "regression").length;
    const carriedCount = data.classified.filter((f) => f.convergence === "carried").length;

    const blocking = data.classified.filter((f) => isBlocking(f, this.config.blockOnMedium));
    const nonBlockingInline = data.classified.filter(
      (f) => !isBlocking(f, this.config.blockOnMedium) && !offloadedFingerprints.has(f.fingerprint),
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
    await this.approvalNotifier.notifyApproval({
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
    if (!this.config.autoSquashMergeEnabled || mode === "force_manual") {
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
