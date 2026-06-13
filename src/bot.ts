import type { Config } from "./config.js";
import { GeminiClient } from "./gemini.js";
import {
  approvePullRequest,
  buildPullRequestContext,
  completeCheck,
  createInProgressCheck,
  getPullRequestHeadSha,
  isPullRequestIssue,
  isTrustedAssociation,
  postPrComment,
  postReviewCommentReply,
  repoFromPayload,
  shouldHandleRepository,
  type PullRequestContext,
  type RepoRef,
  type ReviewTrigger,
} from "./github.js";
import { parseBotCommand } from "./text.js";

const NO_ACTION_REQUIRED_MARKER = "seorilabs-gemini-pr-bot:status=no-action-required";
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

export class PrBot {
  private readonly gemini: GeminiClient;

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
    setImmediate(() => {
      task().catch((error) => {
        this.logger.error(
          {
            error,
            event: name,
            repo,
            delivery,
          },
          "background webhook task failed",
        );
      });
    });
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
      const headSha = await getPullRequestHeadSha(octokit, repo, issueNumber);
      await approvePullRequest(
        octokit,
        repo,
        issueNumber,
        this.approvalText(payload.sender.login, command.request, headSha),
        headSha,
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
      const headSha = await getPullRequestHeadSha(octokit, repo, prNumber);
      await approvePullRequest(
        octokit,
        repo,
        prNumber,
        this.approvalText(payload.sender.login, command.request, headSha),
        headSha,
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
      const headSha = await getPullRequestHeadSha(octokit, repo, prNumber);
      await approvePullRequest(
        octokit,
        repo,
        prNumber,
        this.approvalText(payload.sender.login, command.request, headSha),
        headSha,
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
    const checkRunId = await createInProgressCheck(octokit, repo, context.headSha);

    try {
      const reviewText = await this.createReviewTextFromContext(context, trigger);
      if (this.shouldApproveReviewText(reviewText)) {
        await approvePullRequest(
          octokit,
          repo,
          prNumber,
          this.approvalText(trigger.sender, "Review found no actionable findings.", context.headSha, reviewText),
          context.headSha,
        );
        await completeCheck(octokit, repo, checkRunId, "success", "Gemini review approved PR", reviewText);
        return;
      }

      await postPrComment(octokit, repo, prNumber, reviewText);
      await completeCheck(octokit, repo, checkRunId, "success", "Gemini review completed", reviewText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await completeCheck(octokit, repo, checkRunId, "failure", "Gemini review failed", message);
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
    const checkRunId = await createInProgressCheck(octokit, repo, context.headSha);

    try {
      const agentText = await this.createAgentTextFromContext(context, request, trigger);
      const publicText = this.publicAgentText(agentText);

      if (this.shouldApproveAgentText(agentText)) {
        await approvePullRequest(
          octokit,
          repo,
          prNumber,
          this.approvalText(trigger.sender, "Agent mention analysis found no actionable findings.", context.headSha, publicText),
          context.headSha,
        );
        await completeCheck(octokit, repo, checkRunId, "success", "Gemini agent approved PR", publicText);
        return;
      }

      if (target.type === "review_comment") {
        await postReviewCommentReply(octokit, repo, prNumber, target.commentId, publicText);
      } else {
        await postPrComment(octokit, repo, prNumber, publicText);
      }

      await completeCheck(octokit, repo, checkRunId, "success", "Gemini agent commented", publicText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await completeCheck(octokit, repo, checkRunId, "failure", "Gemini agent failed", message);
      throw error;
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

  private shouldApproveAgentText(text: string): boolean {
    return text.includes(AGENT_APPROVE_MARKER) && /\bNo actionable findings\./iu.test(text);
  }

  private shouldApproveReviewText(text: string): boolean {
    return /\bNo actionable findings\./iu.test(text);
  }

  private publicAgentText(text: string): string {
    return text
      .split("\n")
      .filter((line) => line.trim() !== AGENT_APPROVE_MARKER && line.trim() !== AGENT_COMMENT_MARKER)
      .join("\n")
      .trim();
  }
}
