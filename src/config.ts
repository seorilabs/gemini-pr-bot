export type Config = {
  port: number;
  githubAppId: string;
  githubPrivateKey: string;
  githubWebhookSecret: string;
  githubOrg: string;
  workflowStore: "memory" | "mysql";
  workflowPollIntervalMs: number;
  workflowLeaseMs: number;
  workflowMaxAttempts: number;
  geminiProvider: "api" | "cli";
  geminiApiKey?: string;
  geminiModel?: string;
  geminiCliCommand: string;
  geminiCliTimeoutMs: number;
  mysqlHost?: string;
  mysqlPort: number;
  mysqlUser?: string;
  mysqlPassword?: string;
  mysqlDatabase?: string;
  botMentions: string[];
  trustedAssociations: Set<string>;
  allowPublicRepos: boolean;
  autoReviewOnOpen: boolean;
  autoReviewOnSynchronize: boolean;
  deliveryTtlMs: number;
  shutdownGraceMs: number;
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
  const workflowStore = (process.env.WORKFLOW_STORE?.trim() || "memory").toLowerCase();
  if (!["memory", "mysql"].includes(workflowStore)) {
    throw new Error("WORKFLOW_STORE must be either 'memory' or 'mysql'");
  }

  const mysqlHost = process.env.MYSQL_HOST?.trim();
  const mysqlUser = process.env.MYSQL_USER?.trim();
  const mysqlPassword = process.env.MYSQL_PASSWORD;
  const mysqlDatabase = process.env.MYSQL_DATABASE?.trim();
  if (workflowStore === "mysql" && (!mysqlHost || !mysqlUser || !mysqlPassword || !mysqlDatabase)) {
    throw new Error("MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, and MYSQL_DATABASE are required when WORKFLOW_STORE=mysql");
  }

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
    workflowStore: workflowStore as "memory" | "mysql",
    workflowPollIntervalMs: optionalInt("WORKFLOW_POLL_INTERVAL_MS", 5_000),
    workflowLeaseMs: optionalInt("WORKFLOW_LEASE_MS", 10 * 60 * 1000),
    workflowMaxAttempts: optionalInt("WORKFLOW_MAX_ATTEMPTS", 3),
    geminiProvider: geminiProvider as "api" | "cli",
    geminiApiKey,
    geminiModel: process.env.GEMINI_MODEL?.trim(),
    geminiCliCommand: process.env.GEMINI_CLI_COMMAND?.trim() || "/app/node_modules/.bin/gemini",
    geminiCliTimeoutMs: optionalInt("GEMINI_CLI_TIMEOUT_MS", 180_000),
    mysqlHost,
    mysqlPort: optionalInt("MYSQL_PORT", 3306),
    mysqlUser,
    mysqlPassword,
    mysqlDatabase,
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
    shutdownGraceMs: optionalInt("SHUTDOWN_GRACE_MS", 25_000),
    maxWebhookBodyBytes: optionalInt("MAX_WEBHOOK_BODY_BYTES", 5 * 1024 * 1024),
    maxPatchChars: optionalInt("MAX_PATCH_CHARS", 120_000),
    maxContextChars: optionalInt("MAX_CONTEXT_CHARS", 160_000),
  };
}
