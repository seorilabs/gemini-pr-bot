import type { Config } from "./config.js";

export type BotCommand = {
  mention: string;
  mode: "review" | "reconcile_status" | "chat" | "help" | "approve" | "force_approve" | "agent";
  request: string;
};

export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 32))}\n\n...truncated...`;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRequest(mention: string, rawRequest: string): BotCommand {
  if (/^\/?reconcile-status(?:\s|$)/iu.test(rawRequest)) {
    return { mention, mode: "reconcile_status", request: "" };
  }
  const reviewMatch = rawRequest.match(/^\/?review(?:\s+([\s\S]*))?$/iu);
  if (reviewMatch) {
    return {
      mention,
      mode: "review",
      request: reviewMatch[1]?.trim() || "이 PR을 코드리뷰해줘.",
    };
  }

  if (/^\/?help\b/iu.test(rawRequest)) {
    return {
      mention,
      mode: "help",
      request: rawRequest,
    };
  }

  const forceApproveMatch = rawRequest.match(
    /^\/?(?:(?:force[-_ ]?approve)|(?:approve\s+(?:--force|--skip-validation|--skip-checks|--no-verify)))(?:\s+([\s\S]*))?$/iu,
  );
  if (forceApproveMatch) {
    return {
      mention,
      mode: "force_approve",
      request: forceApproveMatch[1]?.trim() || "검증을 건너뛰고 즉시 승인합니다.",
    };
  }

  const approveMatch = rawRequest.match(/^\/?(?:approve|approved|done|no-action|no_action|resolved)(?:\s+([\s\S]*))?$/iu);
  if (approveMatch) {
    return {
      mention,
      mode: "approve",
      request: approveMatch[1]?.trim() || "추가 대응이 필요 없음을 승인합니다.",
    };
  }

  return {
    mention,
    mode: "agent",
    request: rawRequest || "이 PR의 현재 맥락을 분석하고 다음 에이전트 행동을 결정해줘.",
  };
}

export function parseBotCommand(body: string, config: Config): BotCommand | null {
  const slashCommandMatch = body.trim().match(/^\/(?:gemini-cli|gemini)(?:\s+([\s\S]*))?$/iu);
  if (slashCommandMatch) {
    return parseRequest("/gemini", slashCommandMatch[1]?.trim() || "help");
  }

  for (const mention of config.botMentions) {
    const regex = new RegExp(`(?:^|\\s)${escapeRegExp(mention)}(?=$|\\s|[.,:;!?])`, "iu");
    const match = regex.exec(body);
    if (!match) {
      continue;
    }

    const requestStart = (match.index ?? 0) + match[0].length;
    const rawRequest = body.slice(requestStart).trim();
    return parseRequest(mention, rawRequest);
  }

  return null;
}

export function isStatusReconciliationEvent(eventName: string, payload: any, config: Config): boolean {
  if (eventName === "pull_request_review_thread") return ["resolved", "unresolved"].includes(payload.action);
  const body = eventName === "issue_comment" || eventName === "pull_request_review_comment"
    ? payload.comment?.body : eventName === "pull_request_review" ? payload.review?.body : undefined;
  return typeof body === "string" && parseBotCommand(body, config)?.mode === "reconcile_status";
}

export function githubCommentBody(body: string, maxChars = 60_000): string {
  return truncate(`${body.trim()}\n\n<!-- seorilabs-review-agent -->`, maxChars);
}
