import { createHash } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";
import {
  ACCEPTANCE_GUIDE_INCOMPLETE_MARKER,
  ACCEPTANCE_GUIDE_PUBLICATION_MARKER,
  acceptanceGuideCheckState,
} from "./acceptance-guide.js";
import { isSeoriGithubAuthor } from "./identity.js";
import {
  isOwnReviewCheck,
  listReviewThreads,
  REVIEW_CHECK_NAME,
  type CheckConclusion,
  type RepoRef,
} from "./github.js";

export type StatusReconciliationLock = <T>(
  key: string,
  task: () => Promise<T>,
) => Promise<T>;

export type StatusReconciliationResult = {
  action: "created" | "updated" | "unchanged" | "skipped";
  reason: string;
  headSha: string | null;
  checkRunId: number | null;
  previousConclusion: string | null;
  nextConclusion: CheckConclusion | null;
};

const pending = new Map<string, Promise<void>>();
const publicErrors = new Set([
  "SEORI_STATUS_LOCK_UNAVAILABLE",
  "SEORI_STATUS_LOCK_RELEASE_FAILED",
  "SEORI_STATUS_PR_READBACK_INVALID",
  "SEORI_STATUS_PUBLICATION_READBACK_INVALID",
  "SEORI_STATUS_IDENTITY_INVALID",
  "SEORI_STATUS_CHECK_READBACK_INVALID",
  "SEORI_STATUS_HEAD_CHANGED",
  "SEORI_STATUS_THREAD_READBACK_INVALID",
  "SEORI_STATUS_WRITE_OUTCOME_UNKNOWN",
]);

// The memory fallback and multiple bot instances in one process use the same queue.
// MySQL deployments additionally hold the database lock across the fresh read and write.
async function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  pending.set(key, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (pending.get(key) === current) pending.delete(key);
  }
}

export async function withMysqlStatusReconciliationLock<T>(
  pool: Pool,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();
  const name = `seori-status:${createHash("sha256").update(key).digest("hex").slice(0, 48)}`;
  let acquired = false;
  let acquisitionRead = false;
  let destroyed = false;
  try {
    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT GET_LOCK(?, 10) AS acquired",
      [name],
    );
    acquisitionRead = true;
    acquired = rows[0]?.acquired === 1;
    if (!acquired) throw new Error("SEORI_STATUS_LOCK_UNAVAILABLE");
    return await task();
  } finally {
    try {
      if (!acquisitionRead) {
        connection.destroy();
        destroyed = true;
      }
      if (acquired) {
        const [rows] = await connection.execute<RowDataPacket[]>(
          "SELECT RELEASE_LOCK(?) AS released",
          [name],
        );
        if (rows[0]?.released !== 1)
          throw new Error("SEORI_STATUS_LOCK_RELEASE_FAILED");
      }
    } catch {
      // A pooled connection must never retain a session-level advisory lock.
      connection.destroy();
      destroyed = true;
      throw new Error("SEORI_STATUS_LOCK_RELEASE_FAILED");
    } finally {
      if (!destroyed) connection.release();
    }
  }
}

type Request = {
  octokit: any;
  repo: RepoRef;
  prNumber: number;
  appId: string;
  withLock?: StatusReconciliationLock;
  beforeWrite?: (record: StatusReconciliationResult) => void;
};

async function readPullRequest({ octokit, repo, prNumber }: Request) {
  const { data } = await octokit.rest.pulls.get({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
  });
  if (
    !data ||
    data.number !== prNumber ||
    data.base?.repo?.full_name !== repo.fullName ||
    !/^[a-f0-9]{40}$/u.test(data.head?.sha ?? "") ||
    !["open", "closed"].includes(data.state)
  ) {
    throw new Error("SEORI_STATUS_PR_READBACK_INVALID");
  }
  return {
    headSha: data.head.sha as string,
    closed: data.state !== "open" || data.merged === true,
  };
}

async function readPublication({ octokit, repo, prNumber }: Request) {
  const groups = await Promise.all([
    octokit.paginate(octokit.rest.issues.listComments, {
      owner: repo.owner,
      repo: repo.repo,
      issue_number: prNumber,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      per_page: 100,
    }),
  ]);
  if (groups.some((group) => !Array.isArray(group)))
    throw new Error("SEORI_STATUS_PUBLICATION_READBACK_INVALID");
  const bodies = groups
    .flat()
    .filter(
      (entry) =>
        entry.user?.type === "Bot" &&
        isSeoriGithubAuthor(String(entry.user?.login ?? "")),
    )
    .map((entry) => String(entry.body ?? ""));
  return {
    published: bodies.some((body) =>
      body.includes(ACCEPTANCE_GUIDE_PUBLICATION_MARKER),
    ),
    incomplete: bodies.some((body) =>
      body.includes(ACCEPTANCE_GUIDE_INCOMPLETE_MARKER),
    ),
  };
}

async function reconcile(
  request: Request,
): Promise<StatusReconciliationResult> {
  const { octokit, repo, prNumber } = request;
  const appId = Number(request.appId);
  if (
    !Number.isSafeInteger(appId) ||
    appId <= 0 ||
    !Number.isSafeInteger(prNumber) ||
    prNumber <= 0
  ) {
    throw new Error("SEORI_STATUS_IDENTITY_INVALID");
  }
  const initial = await readPullRequest(request);
  const skipped = (reason: string): StatusReconciliationResult => ({
    action: "skipped",
    reason,
    headSha: initial.headSha,
    checkRunId: null,
    previousConclusion: null,
    nextConclusion: null,
  });
  if (initial.closed) return skipped("PULL_REQUEST_CLOSED");

  const publication = await readPublication(request);
  const threads = await listReviewThreads(
    octokit,
    repo,
    prNumber,
    initial.headSha,
  );
  const state = acceptanceGuideCheckState(
    threads.map((thread) => ({
      isResolved: thread.isResolved,
      bodies: thread.comments
        .filter((comment) => isSeoriGithubAuthor(comment.authorLogin))
        .map((comment) => comment.body),
    })),
  );
  let conclusion: CheckConclusion = state.conclusion;
  let title = state.title;
  let summary = state.summary;
  let reason =
    state.unresolved > 0
      ? "UNRESOLVED_GUIDE_THREADS"
      : "GUIDE_THREADS_RESOLVED";
  if (!publication.published) {
    conclusion = "action_required";
    title = "최초 인수조건 가이드 확인 필요";
    summary =
      "신뢰된 Seori의 최초 가이드를 확인하지 못했습니다. 상태 복구는 AI 리뷰를 실행하거나 최초 가이드를 대신하지 않습니다.";
    reason = "GUIDE_NOT_PUBLISHED";
  } else if (publication.incomplete && state.unresolved === 0) {
    // Preserve the existing nonblocking policy for guide-generation failures, not read failures.
    conclusion = "neutral";
    title = "인수조건 스레드 게시 불완전";
    summary =
      "최초 안내 일부를 resolvable review thread로 게시하지 못했습니다. 안내 기능의 오류만으로 병합을 막지 않습니다.";
    reason = "GUIDE_PUBLICATION_INCOMPLETE";
  }

  const runs = await octokit.paginate(octokit.rest.checks.listForRef, {
    owner: repo.owner,
    repo: repo.repo,
    ref: initial.headSha,
    app_id: appId,
    filter: "all",
    per_page: 100,
  });
  if (!Array.isArray(runs))
    throw new Error("SEORI_STATUS_CHECK_READBACK_INVALID");
  let latest: any = null;
  for (const run of runs) {
    if (run.app?.id !== appId || !isOwnReviewCheck(run.name)) continue;
    if (
      !Number.isSafeInteger(run.id) ||
      run.id <= 0 ||
      run.head_sha !== initial.headSha
    ) {
      throw new Error("SEORI_STATUS_CHECK_READBACK_INVALID");
    }
    if (latest === null || run.id > latest.id) latest = run;
  }
  // The event's old HEAD is not authoritative. Re-read the actual PR immediately before writing.
  const current = await readPullRequest(request);
  if (current.closed) return skipped("PULL_REQUEST_CLOSED");
  if (current.headSha !== initial.headSha)
    throw new Error("SEORI_STATUS_HEAD_CHANGED");

  const result: StatusReconciliationResult = {
    action: latest ? "updated" : "created",
    reason,
    headSha: initial.headSha,
    checkRunId: latest?.id ?? null,
    previousConclusion: latest?.conclusion ?? null,
    nextConclusion: conclusion,
  };
  if (
    latest?.status === "completed" &&
    latest.conclusion === conclusion &&
    latest.output?.title === title &&
    latest.output?.summary === summary
  ) {
    return { ...result, action: "unchanged" };
  }
  const completion = {
    status: "completed",
    conclusion,
    completed_at: new Date().toISOString(),
    output: { title, summary },
  };
  request.beforeWrite?.(result);
  try {
    let receipt: any;
    if (latest) {
      ({ data: receipt } = await octokit.rest.checks.update({
        owner: repo.owner,
        repo: repo.repo,
        check_run_id: latest.id,
        request: { retries: 0 },
        ...completion,
      }));
    } else {
      ({ data: receipt } = await octokit.rest.checks.create({
        owner: repo.owner,
        repo: repo.repo,
        name: REVIEW_CHECK_NAME,
        head_sha: initial.headSha,
        request: { retries: 0 },
        ...completion,
      }));
    }
    if (
      !Number.isSafeInteger(receipt?.id) ||
      receipt.id <= 0 ||
      (latest && receipt.id !== latest.id) ||
      receipt.app?.id !== appId ||
      receipt.head_sha !== initial.headSha ||
      receipt.status !== "completed" ||
      receipt.conclusion !== conclusion ||
      receipt.output?.title !== title ||
      receipt.output?.summary !== summary
    ) {
      throw new Error("invalid check receipt");
    }
    result.checkRunId = receipt.id;
  } catch {
    // Do not retry a possibly applied mutation here. The durable retry must read GitHub first.
    throw new Error("SEORI_STATUS_WRITE_OUTCOME_UNKNOWN");
  }
  return result;
}

export async function reconcileAcceptanceGuideStatus(
  request: Request,
): Promise<StatusReconciliationResult> {
  const key = `${request.appId}:${request.repo.fullName}:${request.prNumber}`;
  return serialize(key, async () => {
    try {
      return request.withLock
        ? await request.withLock(key, () => reconcile(request))
        : await reconcile(request);
    } catch (error) {
      // Provider errors can include request headers or comment text; expose only a fixed code.
      const message =
        error instanceof Error && publicErrors.has(error.message)
          ? error.message
          : "SEORI_STATUS_READBACK_FAILED";
      throw new Error(message);
    }
  });
}
