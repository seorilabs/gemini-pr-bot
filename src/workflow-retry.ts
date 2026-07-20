const INITIAL_GITHUB_RETRY_DELAY_MS = 30_000;
const RETRY_DELAY_STEP_MS = 5 * 60 * 1000;

type HttpErrorLike = {
  status?: unknown;
  request?: { url?: unknown };
  response?: { status?: unknown; url?: unknown };
};

export function transientGitHubRetryDelayMs(
  error: unknown,
  createdAt: Date | string,
  retryWindowMs: number,
  maxDelayMs: number,
  nowMs = Date.now(),
): number | null {
  if (!isGitHubServerError(error)) {
    return null;
  }

  const createdAtMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdAtMs)) {
    return null;
  }
  const ageMs = Math.max(0, nowMs - createdAtMs);
  if (ageMs >= retryWindowMs) {
    return null;
  }

  const exponent = Math.floor(ageMs / RETRY_DELAY_STEP_MS);
  const exponentialDelayMs = INITIAL_GITHUB_RETRY_DELAY_MS * 2 ** exponent;
  const remainingWindowMs = retryWindowMs - ageMs;
  return Math.max(1_000, Math.min(maxDelayMs, exponentialDelayMs, remainingWindowMs));
}

export function isGitHubServerError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as HttpErrorLike;
  const status = numericStatus(candidate.status) ?? numericStatus(candidate.response?.status);
  const url = stringUrl(candidate.request?.url) || stringUrl(candidate.response?.url);
  return Boolean(
    status !== null &&
    status >= 500 &&
    status <= 599 &&
    /^https:\/\/api\.github\.com(?:\/|$)/iu.test(url),
  );
}

function numericStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function stringUrl(value: unknown): string {
  return typeof value === "string" ? value : "";
}
