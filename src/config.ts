export type Config = {
  port: number;
  githubAppId: string;
  githubPrivateKey: string;
  githubWebhookSecret: string;
  githubOrg: string;
  geminiProvider: "api" | "cli";
  geminiApiKey?: string;
  geminiModel?: string;
  geminiCliCommand: string;
  geminiCliTimeoutMs: number;
  botMentions: string[];
  trustedAssociations: Set<string>;
  allowPublicRepos: boolean;
  autoReviewOnOpen: boolean;
  autoReviewOnSynchronize: boolean;
  deliveryTtlMs: number;
  maxWebhookBodyBytes: number;
  maxPatchChars: number;
  maxContextChars: number;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid positive integer environment variable: ${name}`);
  }
  return value;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function optionalList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  const privateKey = requiredEnv("GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n");
  const geminiProvider = (process.env.GEMINI_PROVIDER?.trim() || "api").toLowerCase();
  if (!["api", "cli"].includes(geminiProvider)) {
    throw new Error("GEMINI_PROVIDER must be either 'api' or 'cli'");
  }

  const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
  if (geminiProvider === "api" && !geminiApiKey) {
    throw new Error("Missing required environment variable: GEMINI_API_KEY");
  }

  return {
    port: optionalInt("PORT", 3000),
    githubAppId: requiredEnv("GITHUB_APP_ID"),
    githubPrivateKey: privateKey,
    githubWebhookSecret: requiredEnv("GITHUB_WEBHOOK_SECRET"),
    githubOrg: process.env.GITHUB_ORG?.trim() || "seorilabs",
    geminiProvider: geminiProvider as "api" | "cli",
    geminiApiKey,
    geminiModel: process.env.GEMINI_MODEL?.trim(),
    geminiCliCommand: process.env.GEMINI_CLI_COMMAND?.trim() || "/app/node_modules/.bin/gemini",
    geminiCliTimeoutMs: optionalInt("GEMINI_CLI_TIMEOUT_MS", 180_000),
    botMentions: optionalList("BOT_MENTIONS", ["@gemini-cli", "@gemini"]).sort(
      (left, right) => right.length - left.length,
    ),
    trustedAssociations: new Set(
      optionalList("TRUSTED_ASSOCIATIONS", ["OWNER", "MEMBER", "COLLABORATOR"]).map(
        (item) => item.toUpperCase(),
      ),
    ),
    allowPublicRepos: optionalBool("ALLOW_PUBLIC_REPOS", false),
    autoReviewOnOpen: optionalBool("AUTO_REVIEW_ON_OPEN", true),
    autoReviewOnSynchronize: optionalBool("AUTO_REVIEW_ON_SYNCHRONIZE", false),
    deliveryTtlMs: optionalInt("DELIVERY_TTL_MS", 60 * 60 * 1000),
    maxWebhookBodyBytes: optionalInt("MAX_WEBHOOK_BODY_BYTES", 5 * 1024 * 1024),
    maxPatchChars: optionalInt("MAX_PATCH_CHARS", 120_000),
    maxContextChars: optionalInt("MAX_CONTEXT_CHARS", 160_000),
  };
}
