import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ACCEPTANCE_GUIDE_PUBLICATION_MARKER,
  ACCEPTANCE_GUIDE_INCOMPLETE_MARKER,
  formatAcceptanceGuideThread,
} from "./acceptance-guide.js";
import { PrBot } from "./bot.js";
import type { Config } from "./config.js";
import type { RepoRef } from "./github.js";
import { parseBotCommand } from "./text.js";
import {
  reconcileAcceptanceGuideStatus,
  withMysqlStatusReconciliationLock,
} from "./status-reconciliation.js";
import { MysqlWorkflowStore, WorkflowEngine } from "./workflow.js";
import { STATUS_RECONCILIATION_EVENT } from "./events.js";
import { Octokit } from "octokit";

// Replays the public identity and HEAD of Backoffice #155 without changing the merged PR.
const HEAD = "1ae4116a251ecd6971b1d470999f21b9553d2055";
const REPO: RepoRef = {
  owner: "seorilabs",
  repo: "seorilabs-backoffice",
  fullName: "seorilabs/seorilabs-backoffice",
  isPrivate: false,
};
const GUIDE = formatAcceptanceGuideThread({
  id: "AC-1",
  label: "fixture",
  reason: "검증",
  requiredAction: "근거 확인",
});
const CANARY = "SEORI_STATUS_UNTRUSTED_CANARY_MUST_NOT_ESCAPE";
const CONFIG = {
  githubAppId: "1234",
  githubOrg: "seorilabs",
  botMentions: ["@seori"],
  acceptanceGuideModeEnabled: true,
  allowPublicRepos: false,
  publicRepositoryAllowlist: new Set([REPO.fullName]),
  trustedAssociations: new Set(["OWNER"]),
} as Config;

function fixture() {
  const state = {
    sha: HEAD,
    closed: false,
    permission: "admin",
    published: true,
    incomplete: false,
    publicationAuthor: "seori-bot[bot]",
    publicationType: "Bot",
    unresolved: false,
    threadAuthor: "seori-bot",
    graphCalls: 0,
    headReads: 0,
    runs: [
      {
        id: 7,
        app: { id: 1234 },
        name: "Seori Review",
        head_sha: HEAD,
        status: "completed",
        conclusion: "action_required",
        output: { title: "old", summary: "old" },
      },
    ] as any[],
    writes: [] as any[],
    reads: [] as any[],
    logs: [] as any[],
    aiCalls: 0,
    locks: 0,
    beforeHeadRead: (_: number) => {},
    beforeChecksRead: () => {},
    failWriteOnce: false,
    graphResult: null as null | ((after: string | null) => any),
  };
  const octokit: any = {
    rest: {
      issues: { listComments: "comments" },
      pulls: {
        listReviews: "reviews",
        listReviewComments: "review-comments",
        get: async () => {
          state.beforeHeadRead(++state.headReads);
          return {
            data: {
              number: 155,
              state: state.closed ? "closed" : "open",
              merged: state.closed,
              base: { repo: { full_name: REPO.fullName } },
              head: { sha: state.sha },
            },
          };
        },
      },
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: { permission: state.permission },
        }),
      },
      checks: {
        listForRef: "checks",
        update: async (params: any) => {
          state.writes.push(params);
          Object.assign(
            state.runs.find((run) => run.id === params.check_run_id),
            params,
          );
          if (state.failWriteOnce) {
            state.failWriteOnce = false;
            throw new Error(CANARY);
          }
          return {
            data: structuredClone(
              state.runs.find((run) => run.id === params.check_run_id),
            ),
          };
        },
        create: async (params: any) => {
          state.writes.push(params);
          const created = { ...params, id: 100, app: { id: 1234 } };
          state.runs.push(created);
          if (state.failWriteOnce) {
            state.failWriteOnce = false;
            throw new Error(CANARY);
          }
          return { data: created };
        },
      },
    },
    paginate: async (method: string, params: any) => {
      state.reads.push({ method, params });
      if (method === "checks") {
        state.beforeChecksRead();
        return structuredClone(state.runs);
      }
      if (method === "comments" && state.published)
        return [
          {
            user: {
              login: state.publicationAuthor,
              type: state.publicationType,
            },
            body:
              ACCEPTANCE_GUIDE_PUBLICATION_MARKER +
              (state.incomplete ? ACCEPTANCE_GUIDE_INCOMPLETE_MARKER : ""),
          },
        ];
      return [];
    },
    graphql: async (_query: string, params: any) => {
      state.graphCalls++;
      if (state.graphResult) return state.graphResult(params.after);
      return graphPage(state.sha, state.unresolved, state.threadAuthor);
    },
  };
  const request = { octokit, repo: REPO, prNumber: 155, appId: "1234" };
  const bot: any = Object.create(PrBot.prototype);
  Object.assign(bot, {
    config: { ...CONFIG },
    logger: {
      info: (record: any) => state.logs.push(record),
      warn: (record: any) => state.logs.push(record),
    },
    shouldIgnoreClosedPullRequest: async () => false,
    shouldIgnoreResolvedReviewThread: async () => true,
    runReview: async () => {
      state.aiCalls++;
      throw new Error("AI must not run");
    },
    runAnswer: async () => {
      state.aiCalls++;
      throw new Error("AI must not run");
    },
    runAgent: async () => {
      state.aiCalls++;
      throw new Error("AI must not run");
    },
  });
  const payload = {
    repository: {
      owner: { login: REPO.owner },
      name: REPO.repo,
      full_name: REPO.fullName,
      private: false,
    },
    sender: { login: "maintainer", type: "User" },
    comment: {
      id: 999,
      body: "@seori /reconcile-status",
      author_association: "OWNER",
    },
    review: { body: "@seori /reconcile-status", author_association: "OWNER" },
    issue: { number: 155, pull_request: {} },
    pull_request: { number: 155 },
    action: "resolved",
  };
  const workflow: any = {
    workflowId: 44,
    deliveryId: "test-delivery-44",
    recordCheckRun: async () => {
      throw new Error(
        "Do not attach an already-completed check to lease-expiry cancellation",
      );
    },
    withStatusReconciliationLock: async (
      _key: string,
      task: () => Promise<unknown>,
    ) => {
      state.locks++;
      return task();
    },
  };
  return { state, octokit, request, bot: bot as PrBot, payload, workflow };
}

function graphPage(sha = HEAD, unresolved = false, author = "seori-bot") {
  return {
    repository: {
      pullRequest: {
        headRefOid: sha,
        reviewThreads: {
          nodes: [
            {
              id: "thread-1",
              isResolved: !unresolved,
              comments: {
                nodes: [
                  {
                    databaseId: 101,
                    body: GUIDE,
                    author: { login: author },
                    authorAssociation: "MEMBER",
                  },
                ],
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };
}

test("Backoffice #155의 stale action_required는 현재 HEAD 스레드 readback으로 복구하고 중복 갱신하지 않는다", async () => {
  const { state, request } = fixture();
  const first = await reconcileAcceptanceGuideStatus(request);
  const second = await reconcileAcceptanceGuideStatus(request);
  assert.equal(first.action, "updated");
  assert.equal(first.previousConclusion, "action_required");
  assert.equal(first.nextConclusion, "success");
  assert.equal(first.headSha, HEAD);
  assert.equal(second.action, "unchanged");
  assert.equal(state.writes.length, 1);
  assert.equal(
    state.reads.find((read) => read.method === "checks").params.app_id,
    1234,
  );
});

test("동시 복구 명령은 같은 PR에서 한 번만 쓰며 재오픈은 다시 차단한다", async () => {
  const { state, request } = fixture();
  const results = await Promise.all([
    reconcileAcceptanceGuideStatus(request),
    reconcileAcceptanceGuideStatus(request),
  ]);
  assert.deepEqual(
    results.map((result) => result.action),
    ["updated", "unchanged"],
  );
  assert.equal(state.writes.length, 1);
  state.unresolved = true;
  const reopened = await reconcileAcceptanceGuideStatus(request);
  assert.equal(reopened.nextConclusion, "action_required");
  assert.equal(state.writes.length, 2);
});

test("가이드 생성 실패의 neutral은 유지하되 미해결 스레드보다 우선하지 않는다", async () => {
  const { state, request } = fixture();
  state.incomplete = true;
  assert.equal(
    (await reconcileAcceptanceGuideStatus(request)).nextConclusion,
    "neutral",
  );
  state.unresolved = true;
  assert.equal(
    (await reconcileAcceptanceGuideStatus(request)).nextConclusion,
    "action_required",
  );
});

test("최초 가이드가 없거나 사람이 복사한 marker만 있으면 성공을 만들지 않는다", async () => {
  for (const change of ["absent", "human", "other-bot"] as const) {
    const { state, request } = fixture();
    if (change === "absent") state.published = false;
    if (change === "human") state.publicationType = "User";
    if (change === "other-bot") state.publicationAuthor = "jansoree[bot]";
    const result = await reconcileAcceptanceGuideStatus(request);
    assert.equal(result.reason, "GUIDE_NOT_PUBLISHED", change);
    assert.equal(result.nextConclusion, "action_required", change);
  }
});

test("Copilot·사람 스레드는 별도 리뷰이며 Seori 가이드로 오인하지 않는다", async () => {
  for (const author of [
    "copilot-pull-request-reviewer",
    "maintainer",
    "jansoree",
  ]) {
    const { state, request } = fixture();
    state.unresolved = true;
    state.threadAuthor = author;
    assert.equal(
      (await reconcileAcceptanceGuideStatus(request)).nextConclusion,
      "success",
      author,
    );
  }
});

test("같은 이름의 타 App check를 갱신하지 않고 현재 App check만 생성한다", async () => {
  const { state, request } = fixture();
  state.runs[0].app.id = 5555;
  const result = await reconcileAcceptanceGuideStatus(request);
  assert.equal(result.action, "created");
  assert.equal(state.runs[0].conclusion, "action_required");
  assert.equal(result.checkRunId, 100);
  assert.equal(state.writes[0].head_sha, HEAD);
});

test("쓰기 직전 새 HEAD나 닫힌 PR을 확인하면 과거 결과를 게시하지 않는다", async () => {
  for (const change of ["head", "closed"] as const) {
    const { state, request } = fixture();
    state.beforeHeadRead = (count) => {
      if (count === 2) {
        if (change === "head") state.sha = "b".repeat(40);
        else state.closed = true;
      }
    };
    if (change === "head")
      await assert.rejects(
        reconcileAcceptanceGuideStatus(request),
        /SEORI_STATUS_HEAD_CHANGED/u,
      );
    else
      assert.equal(
        (await reconcileAcceptanceGuideStatus(request)).action,
        "skipped",
      );
    assert.equal(state.writes.length, 0);
  }
});

test("스레드 전체 페이지를 읽고 뒷 페이지 미해결도 차단한다", async () => {
  const { state, request } = fixture();
  state.graphResult = (after) => {
    const page = graphPage(HEAD, after !== null);
    page.repository.pullRequest.reviewThreads.nodes[0].id = after
      ? "thread-2"
      : "thread-1";
    page.repository.pullRequest.reviewThreads.pageInfo = {
      hasNextPage: after === null,
      endCursor: after === null ? "next" : null,
    } as any;
    return page;
  };
  assert.equal(
    (await reconcileAcceptanceGuideStatus(request)).nextConclusion,
    "action_required",
  );
  assert.equal(state.graphCalls, 2);
});

test("페이지 누락·순환·잘못된 HEAD·permission 실패를 빈 스레드나 neutral로 바꾸지 않는다", async () => {
  const cases: Array<() => any> = [
    () => ({ repository: { pullRequest: null } }),
    () => ({
      repository: { pullRequest: { headRefOid: HEAD, reviewThreads: {} } },
    }),
    () => graphPage("b".repeat(40)),
    () => {
      const page = graphPage();
      page.repository.pullRequest.reviewThreads.pageInfo = {
        hasNextPage: true,
        endCursor: "loop",
      } as any;
      return page;
    },
    () => {
      const page = graphPage();
      page.repository.pullRequest.reviewThreads.nodes[0].comments.nodes = [];
      return page;
    },
    () => {
      throw new Error(CANARY);
    },
  ];
  for (const graphResult of cases) {
    const { state, request } = fixture();
    state.graphResult = graphResult;
    await assert.rejects(
      reconcileAcceptanceGuideStatus(request),
      (error: any) => {
        assert.match(
          error.message,
          /^SEORI_STATUS_(HEAD_CHANGED|THREAD_READBACK_INVALID|READBACK_FAILED)$/u,
        );
        assert.ok(!error.message.includes(CANARY));
        return true;
      },
    );
    assert.equal(state.writes.length, 0);
  }
});

test("업데이트·생성 응답이 유실되면 재시도 전에 readback하여 중복 쓰기를 피한다", async () => {
  for (const create of [false, true]) {
    const { state, request } = fixture();
    if (create) state.runs = [];
    state.failWriteOnce = true;
    await assert.rejects(
      reconcileAcceptanceGuideStatus(request),
      /SEORI_STATUS_WRITE_OUTCOME_UNKNOWN/u,
    );
    assert.equal(
      (await reconcileAcceptanceGuideStatus(request)).action,
      "unchanged",
    );
    assert.equal(state.writes.length, 1);
  }
});

test("Octokit 자체도 결과 불명인 POST/PATCH를 재시도하지 않는다", async () => {
  for (const create of [false, true]) {
    const { state, octokit, request } = fixture();
    if (create) state.runs = [];
    let requests = 0;
    const client = new Octokit({
      request: {
        fetch: async () => {
          requests++;
          return new Response(
            JSON.stringify({ message: "synthetic server error" }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
        },
      },
    });
    octokit.rest.checks[create ? "create" : "update"] =
      client.rest.checks[create ? "create" : "update"];
    await assert.rejects(
      reconcileAcceptanceGuideStatus(request),
      /SEORI_STATUS_WRITE_OUTCOME_UNKNOWN/u,
    );
    assert.equal(requests, 1);
  }
});

test("현재 App이라도 check HEAD나 PR identity가 다르면 쓰지 않는다", async () => {
  const { state, request } = fixture();
  state.runs[0].head_sha = "b".repeat(40);
  await assert.rejects(
    reconcileAcceptanceGuideStatus(request),
    /SEORI_STATUS_CHECK_READBACK_INVALID/u,
  );
  await assert.rejects(
    reconcileAcceptanceGuideStatus({ ...request, appId: "not-an-app" }),
    /SEORI_STATUS_IDENTITY_INVALID/u,
  );
  assert.equal(state.writes.length, 0);
});

test("쓰기 응답의 App·HEAD·결과가 예상과 다르면 완료를 주장하지 않는다", async () => {
  const { octokit, request } = fixture();
  octokit.rest.checks.update = async () => ({
    data: {
      id: 7,
      app: { id: 9999 },
      head_sha: HEAD,
      status: "completed",
      conclusion: "success",
    },
  });
  await assert.rejects(
    reconcileAcceptanceGuideStatus(request),
    /SEORI_STATUS_WRITE_OUTCOME_UNKNOWN/u,
  );
});

test("명령 파서는 reconcile-status를 일반 AI 질문으로 보내지 않는다", () => {
  for (const body of [
    "@seori /reconcile-status",
    "@seori reconcile-status",
    "@seori /reconcile-status any text",
    "/gemini reconcile-status",
  ]) {
    assert.equal(parseBotCommand(body, CONFIG)?.mode, "reconcile_status", body);
  }
  assert.equal(parseBotCommand("@seori /review", CONFIG)?.mode, "review");
  assert.equal(parseBotCommand("@seori explain this", CONFIG)?.mode, "agent");
});

test("세 댓글 진입점 모두 첫 가이드가 없어도 AI·답글·approval 없이 상태만 처리한다", async () => {
  for (const eventName of [
    "issue_comment",
    "pull_request_review_comment",
    "pull_request_review",
  ]) {
    const own = fixture();
    own.state.published = false;
    await own.bot.processEvent(
      own.octokit,
      eventName,
      own.payload,
      own.workflow,
    );
    assert.equal(own.state.aiCalls, 0, eventName);
    assert.equal(own.state.writes.length, 1, eventName);
    assert.equal(own.state.writes[0].conclusion, "action_required");
    assert.equal(own.state.locks, 1);
    assert.equal(own.state.logs[0].deliveryId, "test-delivery-44");
    assert.equal(own.state.logs[0].workflowId, 44);
    assert.equal(own.state.logs[0].modelCalls, 0);
    assert.equal(own.state.logs[0].costMicros, 0);
  }
});

test("resolved/unresolved 이벤트는 동일한 무과금 집계 경로를 사용한다", async () => {
  const { state, bot, octokit, payload, workflow } = fixture();
  await bot.processEvent(
    octokit,
    "pull_request_review_thread",
    payload,
    workflow,
  );
  state.unresolved = true;
  payload.action = "unresolved";
  await bot.processEvent(
    octokit,
    "pull_request_review_thread",
    payload,
    workflow,
  );
  assert.deepEqual(
    state.writes.map((write) => write.conclusion),
    ["success", "action_required"],
  );
  assert.equal(state.aiCalls, 0);
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(
    index,
    /app\.webhooks\.on\(\["pull_request_review_thread\.resolved", "pull_request_review_thread\.unresolved"\]/u,
  );
});

test("권한 없는 요청·비활성 가이드 모드·병합된 PR은 상태나 AI를 변경하지 않는다", async () => {
  for (const mode of ["untrusted", "disabled", "closed"] as const) {
    const { state, bot, octokit, payload, workflow } = fixture();
    if (mode === "untrusted") state.permission = "read";
    if (mode === "disabled")
      (bot as any).config.acceptanceGuideModeEnabled = false;
    if (mode === "closed") state.closed = true;
    await bot.processEvent(octokit, "issue_comment", payload, workflow);
    assert.equal(state.aiCalls, 0, mode);
    assert.equal(state.writes.length, 0, mode);
  }
});

test("감사와 예외에 provider 오류 본문이나 비밀 canary가 남지 않는다", async () => {
  const { state, bot, octokit, payload, workflow } = fixture();
  state.graphResult = () => {
    throw new Error(CANARY);
  };
  await assert.rejects(
    bot.processEvent(octokit, "issue_comment", payload, workflow),
    /SEORI_STATUS_READBACK_FAILED/u,
  );
  assert.ok(!JSON.stringify(state.logs).includes(CANARY));
  assert.equal(state.logs[0].action, "blocked");
  assert.equal(state.aiCalls, 0);
});

test("동일 delivery는 durable INSERT IGNORE와 같은 dedupe key로 한 번만 등록한다", async () => {
  const keys = new Set<string>();
  const results: boolean[] = [];
  const store: any = Object.create(MysqlWorkflowStore.prototype);
  store.config = { workflowMaxAttempts: 3 };
  store.pool = {
    execute: async (sql: string, params: any[]) => {
      assert.match(sql, /INSERT IGNORE INTO gemini_pr_bot_workflows/u);
      const added = !keys.has(params[0]);
      keys.add(params[0]);
      results.push(added);
      return [{ affectedRows: added ? 1 : 0 }];
    },
  };
  const engine: any = Object.create(WorkflowEngine.prototype);
  engine.store = store;
  engine.config = CONFIG;
  engine.logger = { info: () => {} };
  const event = { id: "exact-delivery-44", payload: fixture().payload };
  await engine.enqueue("pull_request_review_thread", event);
  await engine.enqueue("pull_request_review_thread", event);
  assert.deepEqual(results, [true, false]);
});

test("상태 전용 대기열에서 일반 AI 명령을 위장 실행하지 못한다", async () => {
  const { state, bot, octokit, payload, workflow } = fixture();
  const queued = { ...payload, status_reconciliation_source: "issue_comment" };
  await bot.processEvent(
    octokit,
    STATUS_RECONCILIATION_EVENT,
    queued,
    workflow,
  );
  queued.comment = { ...queued.comment, body: "@seori /review" };
  await assert.rejects(
    bot.processEvent(octokit, STATUS_RECONCILIATION_EVENT, queued, workflow),
    /SEORI_STATUS_EVENT_INVALID/u,
  );
  assert.equal(state.aiCalls, 0);
});

test(
  "상태 전용 worker는 오래 실행되는 AI worker를 기다리지 않는다",
  { timeout: 2_000 },
  async () => {
    let releaseAi!: () => void;
    let doneStatus!: () => void;
    const aiGate = new Promise<void>((resolve) => {
      releaseAi = resolve;
    });
    const statusDone = new Promise<void>((resolve) => {
      doneStatus = resolve;
    });
    const calls: string[] = [];
    const seen = new Set<string>();
    const engine: any = Object.create(WorkflowEngine.prototype);
    engine.config = { workflowPollIntervalMs: 1 };
    engine.logger = { info: () => {}, error: () => {} };
    engine.store = { init: async () => {}, end: async () => {} };
    engine.processExpiredFinalAttempt = async () => false;
    engine.processOne = async (lane: string) => {
      if (seen.has(lane)) return false;
      seen.add(lane);
      calls.push(lane);
      if (lane === "standard") await aiGate;
      else doneStatus();
      return true;
    };
    try {
      await engine.start();
      await statusDone;
      assert.ok(seen.has("status"));
      assert.equal(calls.filter((lane) => lane === "standard").length, 1);
    } finally {
      releaseAi();
      await engine.stop();
    }
  },
);

test("MySQL lock은 작업 전 획득하고 실패에도 반환하며 불명 응답의 connection은 폐기한다", async () => {
  for (const scenario of [
    "ok",
    "task-failed",
    "busy",
    "acquire-lost",
    "release-lost",
  ] as const) {
    const calls: string[] = [];
    const connection: any = {
      execute: async (sql: string, params: string[]) => {
        assert.ok(params[0].length <= 64);
        if (sql.includes("GET_LOCK")) {
          calls.push("acquire");
          if (scenario === "acquire-lost") throw new Error("connection lost");
          return [[{ acquired: scenario === "busy" ? 0 : 1 }]];
        }
        calls.push("unlock");
        if (scenario === "release-lost") throw new Error("connection lost");
        return [[{ released: 1 }]];
      },
      release: () => calls.push("pool-release"),
      destroy: () => calls.push("destroy"),
    };
    const task = () =>
      withMysqlStatusReconciliationLock(
        { getConnection: async () => connection } as any,
        "public-pr-key",
        async () => {
          calls.push("task");
          if (scenario === "task-failed") throw new Error("task failed");
          return 42;
        },
      );
    if (scenario === "ok") assert.equal(await task(), 42);
    else await assert.rejects(task());
    if (scenario === "ok" || scenario === "task-failed")
      assert.deepEqual(calls, ["acquire", "task", "unlock", "pool-release"]);
    if (scenario === "busy")
      assert.deepEqual(calls, ["acquire", "pool-release"]);
    if (scenario === "acquire-lost")
      assert.deepEqual(calls, ["acquire", "destroy"]);
    if (scenario === "release-lost")
      assert.deepEqual(calls, ["acquire", "task", "unlock", "destroy"]);
  }
});
