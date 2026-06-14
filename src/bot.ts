import type { Config } from "./config.js";
import { GeminiClient } from "./gemini.js";
import {
  approvePullRequest,
  buildPullRequestContext,
  closePullRequest,
  completeCheck,
  createInProgressCheck,
  getPullRequestStatus,
  isReviewThreadResolved,
  isPullRequestIssue,
  isTrustedAssociation,
  postPrComment,
  postReviewCommentReply,
  requestChangesPullRequest,
  REVIEW_AGENT_NAME,
  repoFromPayload,
  shouldHandleRepository,
  type CheckConclusion,
  type PullRequestContext,
  type PullRequestStatus,
  type RepoRef,
  type ReviewTrigger,
} from "./github.js";
import { parseBotCommand } from "./text.js";

const NO_ACTION_REQUIRED_MARKER = "seorilabs-gemini-pr-bot:status=no-action-required";
const MERGE_CONFLICT_MARKER = "seorilabs-gemini-pr-bot:status=merge-conflict";
const AGENT_APPROVE_MARKER = "<!-- seorilabs-gemini-pr-bot:action=approve -->";
const AGENT_COMMENT_MARKER = "<!-- seorilabs-gemini-pr-bot:action=comment -->";
const AGENT_CLOSE_MARKER = "<!-- seorilabs-gemini-pr-bot:action=close -->";
const NO_ACTIONABLE_FINDINGS_TEXT = "조치할 항목 없음.";

type AgentReplyTarget =
  | { type: "pr_comment" }
  | { type: "review_comment"; commentId: number };

type GeneratedText = {
  text: string;
  headSha: string;
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
  kind: "review" | "agent";
  durable: boolean;
};

export type WorkflowCheckRecord = {
  checkRunId: number;
  kind: "review" | "agent";
  repoFullName: string;
  prNumber: number;
  headSha: string;
};

export type WorkflowExecution = {
  checkRunId?: number | null;
  recordCheckRun: (record: WorkflowCheckRecord) => Promise<void>;
};

export class PrBot {
  private readonly gemini: GeminiClient;
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly activeChecks = new Map<number, ActiveCheckRun>();
  private nextActiveCheckKey = 1;
  private shuttingDown = false;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.gemini = new GeminiClient(config, logger);
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

    if (command.mode === "approve") {
      await this.runApprove(
        octokit,
        repo,
        issueNumber,
        payload.sender.login,
        command.request,
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
    });
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

    if (command.mode === "approve") {
      await this.runApprove(
        octokit,
        repo,
        prNumber,
        payload.sender.login,
        command.request,
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
          })
        : await this.createAnswerText(octokit, repo, prNumber, command.request, {
            source: "review_comment",
            sender: payload.sender.login,
          });

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

    if (command.mode === "approve") {
      await this.runApprove(
        octokit,
        repo,
        prNumber,
        payload.sender.login,
        command.request,
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
    });
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
    const context = await buildPullRequestContext(octokit, repo, prNumber, this.config);
    if (this.shuttingDown || (this.isClosedPullRequest(context) && !workflow?.checkRunId)) {
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
        if (this.shuttingDown) {
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

      const reviewText = await this.createReviewTextFromContext(context, trigger);
      if (this.shuttingDown) {
        return;
      }
      const latest = await this.currentStatusForPublish(octokit, repo, prNumber, context.headSha, check);
      if (!latest) {
        return;
      }

      if (this.wantsApproval(reviewText) && this.hasBlockingStatusChecks(latest)) {
        const blockerText = this.statusCheckBlockerText(latest);
        await postPrComment(octokit, repo, prNumber, blockerText);
        await this.completeTrackedCheck(check, "action_required", "상태 체크 확인 필요", blockerText);
        return;
      }

      if (this.shouldApproveReviewText(reviewText, latest)) {
        await approvePullRequest(
          octokit,
          repo,
          prNumber,
          this.approvalText(trigger.sender, "리뷰 결과 조치할 항목이 없습니다.", latest.headSha, reviewText),
          latest.headSha,
        );
        await this.completeTrackedCheck(check, "success", "PR 승인 완료", reviewText);
        return;
      }

      await postPrComment(octokit, repo, prNumber, reviewText);
      await this.completeTrackedCheck(check, "success", "리뷰 완료", reviewText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.completeTrackedCheck(check, "failure", "리뷰 실패", message);
      throw error;
    }
  }

  private async runAgent(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    request: string,
    trigger: ReviewTrigger,
    target: AgentReplyTarget,
    workflow?: WorkflowExecution,
  ): Promise<void> {
    const context = await buildPullRequestContext(octokit, repo, prNumber, this.config);
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

        const conflictText = this.mergeConflictText(repo, prNumber, latest);
        if (this.shuttingDown) {
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
      if (this.shuttingDown) {
        return;
      }
      const latest = await this.currentStatusForPublish(octokit, repo, prNumber, context.headSha, check);
      if (!latest) {
        return;
      }

      if (this.wantsApproval(agentText) && this.hasBlockingStatusChecks(latest)) {
        const blockerText = this.statusCheckBlockerText(latest);
        await postPrComment(octokit, repo, prNumber, blockerText);
        await this.completeTrackedCheck(check, "action_required", "상태 체크 확인 필요", blockerText);
        return;
      }

      if (this.shouldApproveAgentText(agentText, latest)) {
        await approvePullRequest(
          octokit,
          repo,
          prNumber,
          this.approvalText(trigger.sender, "에이전트 판단 결과 조치할 항목이 없습니다.", latest.headSha, publicText),
          latest.headSha,
        );
        await this.completeTrackedCheck(check, "success", "PR 승인 완료", publicText);
        return;
      }

      if (this.shouldCloseAgentText(agentText, latest)) {
        await requestChangesPullRequest(octokit, repo, prNumber, publicText, latest.headSha);
        await closePullRequest(octokit, repo, prNumber);
        await this.completeTrackedCheck(check, "action_required", "반복 미충족으로 PR 종료", publicText);
        return;
      }

      if (target.type === "review_comment") {
        await postReviewCommentReply(octokit, repo, prNumber, target.commentId, publicText);
      } else {
        await postPrComment(octokit, repo, prNumber, publicText);
      }

      await this.completeTrackedCheck(check, "success", "댓글 작성 완료", publicText);
    } catch (error) {
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
    if (!checkRunId) {
      checkRunId = await createInProgressCheck(octokit, repo, headSha);
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
    } finally {
      this.activeChecks.delete(check.key);
    }
  }

  private async runAnswer(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    request: string,
    trigger: ReviewTrigger,
  ): Promise<void> {
    const generated = await this.createAnswerText(octokit, repo, prNumber, request, trigger);
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
  ): Promise<GeneratedText> {
    const context = await buildPullRequestContext(octokit, repo, prNumber, this.config);
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
      "- Each finding must include severity, file/function or line reference when available, impact, and concrete fix direction.",
      "- Failing tests, builds, lint, typecheck, or required status checks are actionable findings unless the context clearly proves an external infrastructure-only failure.",
      "- Treat pending or queued checks as approval blockers, but do not infer a workflow defect from a transient queued check unless the context proves the job is stuck, unroutable, or using an ineligible runner.",
      "- Do not flag Seorilabs ARC/self-hosted runner usage solely because it is self-hosted when the PR context shows a private repository and an eligible JS/TS lint, test, typecheck, or build job.",
      `- Do not say \`${NO_ACTIONABLE_FINDINGS_TEXT}\` while any status check is failing or pending.`,
      "- Do not include praise, broad summaries, style-only preferences, or nits.",
      "- Do not mention that you are an AI model.",
      "- Keep code quotes short: quote identifiers or a minimal expression only when useful.",
      "- Do not include Mermaid diagrams or other diagrams in review comments.",
      "- If the PR conversation contains the marker `seorilabs-gemini-pr-bot:status=no-action-required`, treat it as a prior human/agent approval signal. Prefer markers whose recorded HEAD SHA matches the current PR Head SHA. Still review if this request explicitly asks for `/review`, but avoid reopening already-settled issues unless the new diff contradicts the marker.",
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
      "- Choose close when the same acceptance criterion has already failed across repeated rounds and the latest diff still does not address it. Tell the PR author to stop iterating on this PR and reopen a smaller, clearer PR if they still want to continue.",
      "- Never approve if any correctness, runtime, security, data loss, regression, required validation, or required test concern remains.",
      "- Never approve if GitHub mergeable is `false` or mergeable_state is `dirty`/`conflicting`; choose comment and give conflict-resolution steps.",
      "- Never approve while tests, build, lint, typecheck, or status checks are failing or pending unless the conversation clearly identifies them as infrastructure-only and a maintainer explicitly accepts that risk.",
      "- Treat pending or queued checks as approval blockers, but do not infer a workflow defect from a transient queued check unless the context proves the job is stuck, unroutable, or using an ineligible runner.",
      "- Do not flag Seorilabs ARC/self-hosted runner usage solely because it is self-hosted when the PR context shows a private repository and an eligible JS/TS lint, test, typecheck, or build job.",
      "- If evidence is insufficient, choose comment and state exactly what is missing.",
      "- If prior comments contain `seorilabs-gemini-pr-bot:status=no-action-required`, prefer markers whose recorded HEAD SHA matches the current PR Head SHA.",
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
  ): Promise<GeneratedText> {
    const context = await buildPullRequestContext(octokit, repo, prNumber, this.config);
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

  private async runApprove(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    sender: string,
    reason: string,
  ): Promise<void> {
    const status = await getPullRequestStatus(octokit, repo, prNumber);
    if (this.isClosedPullRequest(status)) {
      return;
    }
    if (this.hasMergeConflict(status)) {
      await requestChangesPullRequest(
        octokit,
        repo,
        prNumber,
        this.mergeConflictText(repo, prNumber, status),
        status.headSha,
      );
      return;
    }
    if (this.hasBlockingStatusChecks(status)) {
      await postPrComment(octokit, repo, prNumber, this.statusCheckBlockerText(status));
      return;
    }

    await approvePullRequest(
      octokit,
      repo,
      prNumber,
      this.approvalText(sender, reason, status.headSha),
      status.headSha,
    );
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
      "- `@seorilabs-seori /approve [사유]`: GitHub approval review와 agent coordination marker를 남깁니다.",
      "- `@seorilabs-seori 질문`: PR 맥락을 분석하고 comment 또는 approve를 결정합니다.",
      "- inline review comment에서 `@seorilabs-seori 질문`: 해당 review comment 맥락으로 답하거나 PR을 approve합니다.",
    ].join("\n");
  }

  private approvalText(sender: string, reason: string, headSha: string, analysis?: string): string {
    return [
      `<!-- ${NO_ACTION_REQUIRED_MARKER} head=${headSha} -->`,
      "## 승인 상태",
      "",
      `승인 요청자: @${sender}`,
      `적용 HEAD: \`${headSha}\``,
      `사유: ${reason}`,
      "",
      "새 커밋이 올라오거나 maintainer가 명시적으로 다시 리뷰를 요청하지 않는 한 추가 에이전트 작업은 필요 없습니다.",
      "",
      "참고: stale approval 해제 여부는 repository branch protection 설정을 따릅니다.",
      analysis ? "" : undefined,
      analysis ? "## 판단 근거" : undefined,
      analysis || undefined,
    ].filter((line): line is string => line !== undefined).join("\n");
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

  private hasBlockingStatusChecks(status: PullRequestStatus): boolean {
    return status.statusChecks.failing.length > 0 || status.statusChecks.pending.length > 0;
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
      text.includes(AGENT_APPROVE_MARKER) &&
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
      text.includes(AGENT_CLOSE_MARKER)
    );
  }

  private wantsApproval(text: string): boolean {
    return /\bNo actionable findings\./iu.test(text) || text.includes(NO_ACTIONABLE_FINDINGS_TEXT);
  }

  private publicAgentText(text: string): string {
    return text
      .split("\n")
      .filter((line) =>
        line.trim() !== AGENT_APPROVE_MARKER &&
        line.trim() !== AGENT_COMMENT_MARKER &&
        line.trim() !== AGENT_CLOSE_MARKER
      )
      .join("\n")
      .trim();
  }
}
