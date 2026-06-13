import type { Config } from "./config.js";
import { GeminiClient } from "./gemini.js";
import {
  approvePullRequest,
  buildPullRequestContext,
  completeCheck,
  createInProgressCheck,
  getPullRequestStatus,
  isPullRequestIssue,
  isTrustedAssociation,
  postPrComment,
  postReviewCommentReply,
  requestChangesPullRequest,
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

type AgentReplyTarget =
  | { type: "pr_comment" }
  | { type: "review_comment"; commentId: number };

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
    this.gemini = new GeminiClient(config);
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

    const activeChecks = [...this.activeChecks.values()];
    this.logger.warn(
      {
        reason,
        activeTasks: this.activeTasks.size,
        activeChecks: activeChecks.length,
      },
      "Gemini PR Bot shutdown started",
    );

    const summary = [
      `Gemini PR Bot stopped while this job was running.`,
      "",
      `Reason: ${reason}`,
      "",
      "The job was marked as cancelled so GitHub does not keep a stale pending check.",
      "Request another review after the bot is back online.",
    ].join("\n");

    const results = await Promise.allSettled(
      activeChecks.map((check) =>
        this.completeTrackedCheck(
          check,
          "cancelled",
          "Gemini job cancelled during bot shutdown",
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
      "Gemini PR Bot shutdown completed",
    );
  }

  private async handleIssueComment(octokit: Octokit, payload: any): Promise<void> {
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
      });
      return;
    }

    if (command.mode === "agent") {
      await this.runAgent(octokit, repo, issueNumber, command.request, {
        source: "issue_comment",
        sender: payload.sender.login,
      }, { type: "pr_comment" });
      return;
    }

    await this.runAnswer(octokit, repo, issueNumber, command.request, {
      source: "issue_comment",
      sender: payload.sender.login,
    });
  }

  private async handleReviewComment(octokit: Octokit, payload: any): Promise<void> {
    if (!shouldHandleRepository(payload, this.config) || payload.sender.type === "Bot") {
      return;
    }

    const command = parseBotCommand(payload.comment.body || "", this.config);
    if (!command || !isTrustedAssociation(payload.comment.author_association, this.config)) {
      return;
    }

    const repo = repoFromPayload(payload);
    const prNumber = payload.pull_request.number;

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
      }, { type: "review_comment", commentId: payload.comment.id });
      return;
    }

    const answer =
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

    await postReviewCommentReply(octokit, repo, prNumber, payload.comment.id, answer);
  }

  private async handlePullRequestReview(octokit: Octokit, payload: any): Promise<void> {
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

    if (command.mode === "review") {
      await this.runReview(octokit, repo, prNumber, {
        source: "pull_request_review",
        sender: payload.sender.login,
        request: command.request,
      });
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
      }, { type: "pr_comment" });
      return;
    }

    await this.runAnswer(octokit, repo, prNumber, command.request, {
      source: "pull_request_review",
      sender: payload.sender.login,
    });
  }

  private async handlePullRequest(octokit: Octokit, payload: any): Promise<void> {
    if (!shouldHandleRepository(payload, this.config) || payload.sender.type === "Bot") {
      return;
    }

    const action = payload.action;
    if (["opened", "reopened"].includes(action) && this.config.autoReviewOnOpen) {
      await this.runReview(octokit, repoFromPayload(payload), payload.pull_request.number, {
        source: `pull_request.${action}`,
        sender: payload.sender.login,
      });
      return;
    }

    if (action === "synchronize" && this.config.autoReviewOnSynchronize) {
      await this.runReview(octokit, repoFromPayload(payload), payload.pull_request.number, {
        source: "pull_request.synchronize",
        sender: payload.sender.login,
      });
    }
  }

  private async runReview(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    trigger: ReviewTrigger,
  ): Promise<void> {
    const context = await buildPullRequestContext(octokit, repo, prNumber, this.config);
    if (this.shuttingDown) {
      return;
    }

    const check = await this.createTrackedCheck(octokit, repo, prNumber, context.headSha, "review");

    try {
      if (this.hasMergeConflict(context)) {
        const conflictText = this.mergeConflictText(repo, prNumber, context);
        if (this.shuttingDown) {
          return;
        }

        await requestChangesPullRequest(octokit, repo, prNumber, conflictText, context.headSha);
        await this.completeTrackedCheck(
          check,
          "action_required",
          "Merge conflict requires resolution",
          conflictText,
        );
        return;
      }

      const reviewText = await this.createReviewTextFromContext(context, trigger);
      if (this.shuttingDown) {
        return;
      }

      if (this.shouldApproveReviewText(reviewText, context)) {
        await approvePullRequest(
          octokit,
          repo,
          prNumber,
          this.approvalText(trigger.sender, "Review found no actionable findings.", context.headSha, reviewText),
          context.headSha,
        );
        await this.completeTrackedCheck(check, "success", "Gemini review approved PR", reviewText);
        return;
      }

      await postPrComment(octokit, repo, prNumber, reviewText);
      await this.completeTrackedCheck(check, "success", "Gemini review completed", reviewText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.completeTrackedCheck(check, "failure", "Gemini review failed", message);
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
  ): Promise<void> {
    const context = await buildPullRequestContext(octokit, repo, prNumber, this.config);
    if (this.shuttingDown) {
      return;
    }

    const check = await this.createTrackedCheck(octokit, repo, prNumber, context.headSha, "agent");

    try {
      if (this.hasMergeConflict(context)) {
        const conflictText = this.mergeConflictText(repo, prNumber, context);
        if (this.shuttingDown) {
          return;
        }

        await requestChangesPullRequest(octokit, repo, prNumber, conflictText, context.headSha);
        await this.completeTrackedCheck(
          check,
          "action_required",
          "Merge conflict requires resolution",
          conflictText,
        );
        return;
      }

      const agentText = await this.createAgentTextFromContext(context, request, trigger);
      const publicText = this.publicAgentText(agentText);
      if (this.shuttingDown) {
        return;
      }

      if (this.shouldApproveAgentText(agentText, context)) {
        await approvePullRequest(
          octokit,
          repo,
          prNumber,
          this.approvalText(trigger.sender, "Agent mention analysis found no actionable findings.", context.headSha, publicText),
          context.headSha,
        );
        await this.completeTrackedCheck(check, "success", "Gemini agent approved PR", publicText);
        return;
      }

      if (target.type === "review_comment") {
        await postReviewCommentReply(octokit, repo, prNumber, target.commentId, publicText);
      } else {
        await postPrComment(octokit, repo, prNumber, publicText);
      }

      await this.completeTrackedCheck(check, "success", "Gemini agent commented", publicText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.completeTrackedCheck(check, "failure", "Gemini agent failed", message);
      throw error;
    }
  }

  private async createTrackedCheck(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    headSha: string,
    kind: ActiveCheckRun["kind"],
  ): Promise<ActiveCheckRun | null> {
    const checkRunId = await createInProgressCheck(octokit, repo, headSha);
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
    const answer = await this.createAnswerText(octokit, repo, prNumber, request, trigger);
    await postPrComment(octokit, repo, prNumber, answer);
  }

  private async createReviewText(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    trigger: ReviewTrigger,
  ): Promise<string> {
    const context = await buildPullRequestContext(octokit, repo, prNumber, this.config);
    if (this.hasMergeConflict(context)) {
      return this.mergeConflictText(repo, prNumber, context);
    }

    return this.createReviewTextFromContext(context, trigger);
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
      "",
      "Finding rules:",
      "- Findings must be grounded in the supplied diff/context.",
      "- Each finding must include severity, file/function or line reference when available, impact, and concrete fix direction.",
      "- Do not include praise, broad summaries, style-only preferences, or nits.",
      "- Do not mention that you are an AI model.",
      "- Keep code quotes short: quote identifiers or a minimal expression only when useful.",
      "- If a Mermaid diagram helps explain a bug path, state machine, or architecture flow, include one compact diagram.",
      "- If the PR conversation contains the marker `seorilabs-gemini-pr-bot:status=no-action-required`, treat it as a prior human/agent approval signal. Prefer markers whose recorded HEAD SHA matches the current PR Head SHA. Still review if this request explicitly asks for `/review`, but avoid reopening already-settled issues unless the new diff contradicts the marker.",
      "- If GitHub mergeable is `false` or mergeable_state is `dirty`/`conflicting`, treat the merge conflict as a blocking finding. Do not write `No actionable findings.`; include concrete conflict-resolution steps.",
      "",
      "Severity guide:",
      "- Critical: data loss, security exposure, crash on common path, or broken release path.",
      "- High: likely runtime failure, serious regression, incorrect core behavior.",
      "- Medium: real bug with narrower trigger, missing required validation, important test gap.",
      "- Low: minor but actionable correctness or maintainability issue.",
      "",
      "Output format:",
      "## Gemini Review",
      "",
      "### Findings",
      "- `[Severity] file_or_symbol`: impact and evidence. Suggested fix.",
      "",
      "If there are no actionable findings, write exactly:",
      "### Findings",
      "No actionable findings.",
      "",
      "### Verification",
      "- Only include concrete checks that are useful for this PR.",
      "",
      "### Coordination",
      "- If no further agent action appears needed, include: `No further agent action required unless new commits arrive.`",
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
      "",
      "Decision rules:",
      "- If the user asks a direct question, answer it and choose comment unless the same message clearly asks for readiness or approval.",
      "- If the user says fixes were applied, thanks after addressing review feedback, asks for another look, or asks whether anything remains, perform a review-quality assessment.",
      "- Choose approve only when the supplied diff and conversation show no actionable findings remain.",
      "- Never approve if any correctness, runtime, security, data loss, regression, required validation, or required test concern remains.",
      "- Never approve if GitHub mergeable is `false` or mergeable_state is `dirty`/`conflicting`; choose comment and give conflict-resolution steps.",
      "- CI failures do not automatically block approval when the conversation clearly identifies them as infrastructure-only, but mention that status under Verification.",
      "- If evidence is insufficient, choose comment and state exactly what is missing.",
      "- If prior comments contain `seorilabs-gemini-pr-bot:status=no-action-required`, prefer markers whose recorded HEAD SHA matches the current PR Head SHA.",
      "",
      "Output contract:",
      "- Include exactly one hidden action marker as the first non-empty line:",
      `  ${AGENT_APPROVE_MARKER}`,
      `  ${AGENT_COMMENT_MARKER}`,
      "- If action is approve, the Findings section must contain exactly: `No actionable findings.`",
      "- If action is comment because findings remain, list findings first, ordered by severity.",
      "",
      "Output format:",
      "## Gemini Agent",
      "",
      "### Decision",
      "- `approve` or `comment`, with one short reason.",
      "",
      "### Findings",
      "- `[Severity] file_or_symbol`: impact and evidence. Suggested fix.",
      "",
      "If there are no actionable findings, write exactly:",
      "### Findings",
      "No actionable findings.",
      "",
      "### Verification",
      "- Only include concrete checks useful for this PR.",
      "",
      "### Coordination",
      "- State whether further agent action is needed.",
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
  ): Promise<string> {
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

    return this.gemini.answer(prompt);
  }

  private async runApprove(
    octokit: Octokit,
    repo: RepoRef,
    prNumber: number,
    sender: string,
    reason: string,
  ): Promise<void> {
    const status = await getPullRequestStatus(octokit, repo, prNumber);
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

    await approvePullRequest(
      octokit,
      repo,
      prNumber,
      this.approvalText(sender, reason, status.headSha),
      status.headSha,
    );
  }

  private helpText(): string {
    return [
      "사용 가능한 명령:",
      "",
      "- `@gemini-cli /review`: 현재 PR을 리뷰합니다.",
      "- `@gemini-cli /approve [사유]`: GitHub approval review와 agent coordination marker를 남깁니다.",
      "- `@gemini-cli 질문`: PR 맥락을 분석하고 comment 또는 approve를 결정합니다.",
      "- inline review comment에서 `@gemini-cli 질문`: 해당 review comment 맥락으로 답하거나 PR을 approve합니다.",
    ].join("\n");
  }

  private approvalText(sender: string, reason: string, headSha: string, analysis?: string): string {
    return [
      `<!-- ${NO_ACTION_REQUIRED_MARKER} head=${headSha} -->`,
      "## Agent Coordination",
      "",
      `Approved by: @${sender}`,
      `Applies to HEAD: \`${headSha}\``,
      `Reason: ${reason}`,
      "",
      "No further agent action required unless new commits arrive or a maintainer explicitly requests another review.",
      "",
      "Note: stale approval dismissal depends on the repository branch protection setting.",
      analysis ? "" : undefined,
      analysis ? "## Agent Analysis" : undefined,
      analysis || undefined,
    ].filter((line): line is string => line !== undefined).join("\n");
  }

  private mergeConflictText(repo: RepoRef, prNumber: number, status: PullRequestStatus): string {
    return [
      `<!-- ${MERGE_CONFLICT_MARKER} head=${status.headSha} -->`,
      "## Merge Conflict",
      "",
      "GitHub reports that this PR cannot currently be merged cleanly.",
      "",
      `- PR: \`${repo.fullName}#${prNumber}\``,
      `- Base: \`${status.baseRepoFullName}:${status.baseRef}\``,
      `- Head: \`${status.headRepoFullName}:${status.headRef}\``,
      `- Head SHA: \`${status.headSha}\``,
      `- GitHub mergeable: \`${status.mergeable ?? "unknown"}\``,
      `- GitHub mergeable_state: \`${status.mergeableState}\``,
      "",
      "### Suggested Action",
      "",
      "```bash",
      `gh pr checkout ${prNumber} -R ${repo.fullName}`,
      `git fetch origin ${status.baseRef}`,
      `git merge origin/${status.baseRef}`,
      "# resolve conflict markers in the files Git reports",
      "git status",
      "git add <resolved-files>",
      "git commit",
      "git push",
      "```",
      "",
      "```mermaid",
      "flowchart TD",
      "  A[\"Checkout PR branch\"] --> B[\"Merge latest base branch\"]",
      "  B --> C[\"Resolve conflict markers\"]",
      "  C --> D[\"Run repo checks\"]",
      "  D --> E[\"Commit and push\"]",
      "  E --> F[\"Ask Gemini to review again\"]",
      "```",
      "",
      "No approval was submitted. Resolve the merge conflict first, then request another review.",
    ].join("\n");
  }

  private hasMergeConflict(status: PullRequestStatus): boolean {
    return status.mergeable === false || ["dirty", "conflicting"].includes(status.mergeableState.toLowerCase());
  }

  private shouldApproveAgentText(text: string, status: PullRequestStatus): boolean {
    return !this.hasMergeConflict(status) && text.includes(AGENT_APPROVE_MARKER) && /\bNo actionable findings\./iu.test(text);
  }

  private shouldApproveReviewText(text: string, status: PullRequestStatus): boolean {
    return !this.hasMergeConflict(status) && /\bNo actionable findings\./iu.test(text);
  }

  private publicAgentText(text: string): string {
    return text
      .split("\n")
      .filter((line) => line.trim() !== AGENT_APPROVE_MARKER && line.trim() !== AGENT_COMMENT_MARKER)
      .join("\n")
      .trim();
  }
}
