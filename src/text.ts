import type { Config } from "./config.js";

export type BotCommand = {
  mention: string;
  mode: "review" | "chat" | "help" | "approve" | "agent";
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

export function githubCommentBody(body: string, maxChars = 60_000): string {
  return truncate(`${body.trim()}\n\n<!-- seorilabs-review-agent -->`, maxChars);
}
