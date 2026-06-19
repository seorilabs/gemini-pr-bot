export const BOT_GITHUB_LOGIN = "seorilabs-seori-pr-bot";
export const LEGACY_BOT_GITHUB_LOGIN = "seorilabs-gemini-pr-bot";

export type BotActionMarker = "approve" | "comment" | "close";
export type BotStatusMarker =
  | "action-required"
  | "merge-conflict"
  | "no-action-required"
  | "stale-closed";

export function botStatusMarker(status: BotStatusMarker): string {
  return `${BOT_GITHUB_LOGIN}:status=${status}`;
}

export function botStatusMarkerCandidates(status: BotStatusMarker): string[] {
  return [
    botStatusMarker(status),
    `${LEGACY_BOT_GITHUB_LOGIN}:status=${status}`,
  ];
}

export function bodyIncludesBotStatusMarker(body: string, status: BotStatusMarker): boolean {
  return botStatusMarkerCandidates(status).some((marker) => body.includes(marker));
}

export function botActionMarker(action: BotActionMarker): string {
  return `<!-- ${BOT_GITHUB_LOGIN}:action=${action} -->`;
}

export function botActionMarkerCandidates(action: BotActionMarker): string[] {
  return [
    botActionMarker(action),
    `<!-- ${LEGACY_BOT_GITHUB_LOGIN}:action=${action} -->`,
  ];
}

export function bodyIncludesBotActionMarker(body: string, action: BotActionMarker): boolean {
  return botActionMarkerCandidates(action).some((marker) => body.includes(marker));
}

export function isBotActionMarkerLine(line: string): boolean {
  const trimmed = line.trim();
  return (["approve", "comment", "close"] as const).some((action) =>
    botActionMarkerCandidates(action).includes(trimmed),
  );
}

export function botAutoSquashMergeFailedMarker(): string {
  return `${BOT_GITHUB_LOGIN}:auto-squash-merge=failed`;
}
