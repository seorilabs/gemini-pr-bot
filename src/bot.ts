import type { Config } from "./config.js";
import { GeminiClient } from "./gemini.js";
import {
  buildPullRequestContext,
  completeCheck,
  createInProgressCheck,
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

    if (command.mode === "review") {
      await this.runReview(octokit, repo, issueNumber, {
        source: "issue_comment",
        sender: payload.sender.login,
        request: command.request,
      });
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
      await postPrComment(octokit, repo, prNumber, reviewText);
      await completeCheck(octokit, repo, checkRunId, "success", "Gemini review completed", reviewText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await completeCheck(octokit, repo, checkRunId, "failure", "Gemini review failed", message);
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
      "Write a concise pull request code review.",
      "",
      "Output format:",
      "## Gemini Review",
      "",
      "- Findings first, ordered by severity.",
      "- Include file and line/function references when the supplied context supports it.",
      "- If there are no actionable findings, say that clearly.",
      "- End with a short verification/test suggestion only when useful.",
      "",
      `Trigger: ${trigger.source}`,
      `Requested by: ${trigger.sender}`,
      trigger.request ? `User request: ${trigger.request}` : "",
      "",
      context.markdown,
    ].join("\n");

    return this.gemini.review(prompt);
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
      "- `@gemini-cli 질문`: PR 맥락을 보고 질문에 답합니다.",
      "- inline review comment에서 `@gemini-cli 질문`: 해당 review comment에 답글로 응답합니다.",
    ].join("\n");
  }
}
