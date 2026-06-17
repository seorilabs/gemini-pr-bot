export const AI_REVIEW_PROVIDER_NAMES = ["gemini", "copilot", "cursor"] as const;

export type AiReviewProviderName = (typeof AI_REVIEW_PROVIDER_NAMES)[number];
export type AiReviewProviderWeights = Record<AiReviewProviderName, number>;

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
  ciInitialWaitMs: number;
  ciRecheckIntervalMs: number;
  ciRecheckTimeoutMs: number;
  geminiProvider: "api" | "cli";
  geminiApiKey?: string;
  geminiModel?: string;
  geminiCliCommand: string;
  geminiCliTimeoutMs: number;
  aiReviewProviders: AiReviewProviderName[];
  aiReviewProviderWeights: AiReviewProviderWeights;
  aiReviewProviderFallbackOrder: AiReviewProviderName[];
  aiReviewProviderCooldownMs: number;
  copilotCliCommand: string;
  copilotCliTimeoutMs: number;
  copilotModel?: string;
  cursorCliCommand: string;
  cursorCliTimeoutMs: number;
  cursorModel?: string;
  mysqlHost?: string;
  mysqlPort: number;
  mysqlUser?: string;
  mysqlPassword?: string;
  mysqlDatabase?: string;
  botMentions: string[];
  trustedAssociations: Set<string>;
  allowPublicRepos: boolean;
  publicRepositoryAllowlist: Set<string>;
  autoReviewOnOpen: boolean;
  autoReviewOnSynchronize: boolean;
  autoReviewIgnoredRepositories: Set<string>;
  approvalTelegramNotifyEnabled: boolean;
  quotaTelegramNotifyEnabled: boolean;
  quotaTelegramSummaryIntervalMs: number;
  staleReviewCloseEnabled: boolean;
  staleReviewThresholdMs: number;
  staleReviewScanIntervalMs: number;
  staleReviewMaxPrsPerScan: number;
  staleReviewIgnoredRepositories: Set<string>;
  natsServerUrl: string;
  approvalTelegramBot: string;
  approvalTelegramChannel: string;
  deliveryTtlMs: number;
  shutdownGraceMs: number;
  metricsAllowForwarded: boolean;
  maxWebhookBodyBytes: number;
  maxPatchChars: number;
  maxContextChars: number;
  deepRepoContextMode: "off" | "auto" | "always";
  deepRepoContextTimeoutMs: number;
  deepRepoContextMaxFiles: number;
  deepRepoContextMaxBytes: number;
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

function optionalRepositorySet(name: string, fallback: string[]): Set<string> {
  return new Set(optionalList(name, fallback).map((item) => item.toLowerCase()));
}

function optionalChoice<T extends string>(name: string, fallback: T, choices: readonly T[]): T {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (!choices.includes(raw as T)) {
    throw new Error(`Invalid ${name} value: ${raw}`);
  }
  return raw as T;
}

function isAiReviewProviderName(value: string): value is AiReviewProviderName {
  return (AI_REVIEW_PROVIDER_NAMES as readonly string[]).includes(value);
}

function optionalProviderList(name: string, fallback: AiReviewProviderName[]): AiReviewProviderName[] {
  const values = optionalList(name, fallback);
  const providers: AiReviewProviderName[] = [];
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (!isAiReviewProviderName(normalized)) {
      throw new Error(`Invalid ${name} value: ${value}`);
    }
    if (!providers.includes(normalized)) {
      providers.push(normalized);
    }
  }

  if (providers.length === 0) {
    throw new Error(`${name} must include at least one provider`);
  }
  return providers;
}

function optionalProviderWeights(
  name: string,
  fallback: Partial<AiReviewProviderWeights>,
): AiReviewProviderWeights {
  const weights: AiReviewProviderWeights = {
    gemini: 0,
    copilot: 0,
    cursor: 0,
    ...fallback,
  };
  const raw = process.env[name];
  if (!raw) {
    return weights;
  }

  for (const entry of raw.split(",")) {
    const [providerRaw, weightRaw] = entry.split(":");
    const provider = providerRaw?.trim().toLowerCase();
    const weight = Number.parseInt(weightRaw?.trim() || "", 10);
    if (!provider || !isAiReviewProviderName(provider)) {
      throw new Error(`Invalid ${name} provider: ${providerRaw}`);
    }
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`Invalid ${name} weight for ${provider}: ${weightRaw}`);
    }
    weights[provider] = weight;
  }

  return weights;
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

  const aiReviewProviders = optionalProviderList("AI_REVIEW_PROVIDERS", ["gemini"]);
  const aiReviewProviderWeights = optionalProviderWeights("AI_REVIEW_PROVIDER_WEIGHTS", {
    gemini: 100,
  });
  if (aiReviewProviders.every((provider) => aiReviewProviderWeights[provider] <= 0)) {
    throw new Error("AI_REVIEW_PROVIDER_WEIGHTS must give at least one enabled provider a positive weight");
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
    ciInitialWaitMs: optionalInt("CI_INITIAL_WAIT_MS", 60_000),
    ciRecheckIntervalMs: optionalInt("CI_RECHECK_INTERVAL_MS", 60_000),
    ciRecheckTimeoutMs: optionalInt("CI_RECHECK_TIMEOUT_MS", 20 * 60 * 1000),
    geminiProvider: geminiProvider as "api" | "cli",
    geminiApiKey,
    geminiModel: process.env.GEMINI_MODEL?.trim(),
    geminiCliCommand: process.env.GEMINI_CLI_COMMAND?.trim() || "/app/node_modules/.bin/gemini",
    geminiCliTimeoutMs: optionalInt("GEMINI_CLI_TIMEOUT_MS", 180_000),
    aiReviewProviders,
    aiReviewProviderWeights,
    aiReviewProviderFallbackOrder: optionalProviderList("AI_REVIEW_PROVIDER_FALLBACK_ORDER", ["gemini"]),
    aiReviewProviderCooldownMs: optionalInt("AI_REVIEW_PROVIDER_COOLDOWN_MS", 5 * 60 * 1000),
    copilotCliCommand: process.env.COPILOT_CLI_COMMAND?.trim() || "/app/node_modules/.bin/copilot",
    copilotCliTimeoutMs: optionalInt("COPILOT_CLI_TIMEOUT_MS", 180_000),
    copilotModel: process.env.COPILOT_MODEL?.trim(),
    cursorCliCommand: process.env.CURSOR_CLI_COMMAND?.trim() || "/usr/local/bin/agent",
    cursorCliTimeoutMs: optionalInt("CURSOR_CLI_TIMEOUT_MS", 180_000),
    cursorModel: process.env.CURSOR_MODEL?.trim(),
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
    publicRepositoryAllowlist: optionalRepositorySet("PUBLIC_REPOSITORY_ALLOWLIST", []),
    autoReviewOnOpen: optionalBool("AUTO_REVIEW_ON_OPEN", true),
    autoReviewOnSynchronize: optionalBool("AUTO_REVIEW_ON_SYNCHRONIZE", false),
    autoReviewIgnoredRepositories: optionalRepositorySet("AUTO_REVIEW_IGNORED_REPOSITORIES", []),
    approvalTelegramNotifyEnabled: optionalBool("APPROVAL_TELEGRAM_NOTIFY_ENABLED", false),
    quotaTelegramNotifyEnabled: optionalBool("QUOTA_TELEGRAM_NOTIFY_ENABLED", false),
    quotaTelegramSummaryIntervalMs: optionalInt("QUOTA_TELEGRAM_SUMMARY_INTERVAL_MS", 60 * 60 * 1000),
    staleReviewCloseEnabled: optionalBool("STALE_REVIEW_CLOSE_ENABLED", false),
    staleReviewThresholdMs: optionalInt("STALE_REVIEW_THRESHOLD_MS", 24 * 60 * 60 * 1000),
    staleReviewScanIntervalMs: optionalInt("STALE_REVIEW_SCAN_INTERVAL_MS", 30 * 60 * 1000),
    staleReviewMaxPrsPerScan: optionalInt("STALE_REVIEW_MAX_PRS_PER_SCAN", 100),
    staleReviewIgnoredRepositories: optionalRepositorySet("STALE_REVIEW_IGNORED_REPOSITORIES", []),
    natsServerUrl: process.env.NATS_SERVER_URL?.trim() || "nats://localhost:4222",
    approvalTelegramBot: process.env.APPROVAL_TELEGRAM_BOT?.trim() || "seolee_bot",
    approvalTelegramChannel: process.env.APPROVAL_TELEGRAM_CHANNEL?.trim() || "syous",
    deliveryTtlMs: optionalInt("DELIVERY_TTL_MS", 60 * 60 * 1000),
    shutdownGraceMs: optionalInt("SHUTDOWN_GRACE_MS", 25_000),
    metricsAllowForwarded: optionalBool("METRICS_ALLOW_FORWARDED", false),
    maxWebhookBodyBytes: optionalInt("MAX_WEBHOOK_BODY_BYTES", 5 * 1024 * 1024),
    maxPatchChars: optionalInt("MAX_PATCH_CHARS", 120_000),
    maxContextChars: optionalInt("MAX_CONTEXT_CHARS", 160_000),
    deepRepoContextMode: optionalChoice("DEEP_REPO_CONTEXT_MODE", "auto", ["off", "auto", "always"]),
    deepRepoContextTimeoutMs: optionalInt("DEEP_REPO_CONTEXT_TIMEOUT_MS", 60_000),
    deepRepoContextMaxFiles: optionalInt("DEEP_REPO_CONTEXT_MAX_FILES", 40),
    deepRepoContextMaxBytes: optionalInt("DEEP_REPO_CONTEXT_MAX_BYTES", 80_000),
  };
}
