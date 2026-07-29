import assert from "node:assert/strict";
import test from "node:test";
import {
  completeLatestOwnReviewCheck,
  completeLatestOwnReviewCheckAsSuccess,
  postFileReviewComment,
  pullRequestConversationHasMarker,
  type RepoRef,
} from "./github.js";

const REPO: RepoRef = {
  owner: "seorilabs",
  repo: "example",
  fullName: "seorilabs/example",
  isPrivate: true,
};

test("latest own review check is selected by maximum id even while in progress", async () => {
  const listCalls: any[] = [];
  const updateCalls: any[] = [];
  const octokit = {
    rest: {
      checks: {
        listForRef: async (params: any) => {
          listCalls.push(params);
          return {
            data: {
              check_runs: [
                { id: 900, name: "Other Check", status: "completed" },
                { id: 42, name: "Seori Review", status: "completed" },
                { id: 43, name: "Gemini PR Bot", status: "completed" },
                { id: 99, name: "Seori Review", status: "in_progress" },
              ],
            },
          };
        },
        update: async (params: any) => {
          updateCalls.push(params);
        },
      },
    },
  };

  const updatedId = await completeLatestOwnReviewCheckAsSuccess(
    octokit,
    REPO,
    "head-sha",
    "사람 검증 완료",
    "현재 HEAD를 검증했습니다.",
  );

  assert.equal(updatedId, 99);
  assert.deepEqual(listCalls, [
    {
      owner: "seorilabs",
      repo: "example",
      ref: "head-sha",
      per_page: 100,
    },
  ]);
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(
    {
      ...updateCalls[0],
      completed_at: "<timestamp>",
    },
    {
      owner: "seorilabs",
      repo: "example",
      check_run_id: 99,
      status: "completed",
      conclusion: "success",
      completed_at: "<timestamp>",
      output: {
        title: "사람 검증 완료",
        summary: "현재 HEAD를 검증했습니다.",
      },
    },
  );
  assert.match(updateCalls[0].completed_at, /^\d{4}-\d{2}-\d{2}T/u);
});

test("a successful own review check is created when none exists", async () => {
  let updateCalled = false;
  const createCalls: any[] = [];
  const octokit = {
    rest: {
      checks: {
        listForRef: async () => ({
          data: {
            check_runs: [
              { id: 8, name: "Other Check", status: "completed" },
            ],
          },
        }),
        create: async (params: any) => {
          createCalls.push(params);
          return { data: { id: 77 } };
        },
        update: async () => {
          updateCalled = true;
        },
      },
    },
  };

  const updatedId = await completeLatestOwnReviewCheckAsSuccess(
    octokit,
    REPO,
    "head-sha",
    "사람 검증 완료",
    "현재 HEAD를 검증했습니다.",
  );

  assert.equal(updatedId, 77);
  assert.equal(updateCalled, false);
  assert.equal(createCalls.length, 1);
  assert.deepEqual(
    {
      ...createCalls[0],
      completed_at: "<timestamp>",
    },
    {
      owner: "seorilabs",
      repo: "example",
      name: "Seori Review",
      head_sha: "head-sha",
      status: "completed",
      conclusion: "success",
      completed_at: "<timestamp>",
      output: {
        title: "사람 검증 완료",
        summary: "현재 HEAD를 검증했습니다.",
      },
    },
  );
});

test("latest own review check can remain action_required while guide threads are open", async () => {
  const updateCalls: any[] = [];
  const octokit = {
    rest: {
      checks: {
        listForRef: async () => ({
          data: {
            check_runs: [
              { id: 91, name: "Seori Review", status: "completed" },
            ],
          },
        }),
        update: async (params: any) => {
          updateCalls.push(params);
        },
      },
    },
  };

  const updatedId = await completeLatestOwnReviewCheck(
    octokit,
    REPO,
    "head-sha",
    "action_required",
    "인수조건 확인 필요",
    "미해결 스레드가 2건 있습니다.",
  );

  assert.equal(updatedId, 91);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].conclusion, "action_required");
  assert.equal(updateCalls[0].output.title, "인수조건 확인 필요");
});

test("acceptance guide item is posted as a resolvable file-level review comment", async () => {
  const calls: any[] = [];
  const octokit = {
    request: async (route: string, params: any) => {
      calls.push({ route, params });
      return { data: { id: 123 } };
    },
  };

  const commentId = await postFileReviewComment(
    octokit,
    REPO,
    7,
    "head-sha",
    "src/example.ts",
    "인수조건을 확인해 주세요.",
  );

  assert.equal(commentId, 123);
  assert.equal(calls[0].route, "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments");
  assert.equal(calls[0].params.subject_type, "file");
  assert.equal(calls[0].params.path, "src/example.ts");
  assert.equal(calls[0].params.commit_id, "head-sha");
});

test("published marker is recovered from review comments as well as PR comments", async () => {
  const marker = "<!-- seorilabs-seori-pr-bot:acceptance-guide=published -->";
  const octokit = {
    paginate: async (method: unknown) => {
      if (method === "review-comments") {
        return [{ body: marker }];
      }
      return [];
    },
    rest: {
      issues: {
        listComments: "issue-comments",
      },
      pulls: {
        listReviews: "reviews",
        listReviewComments: "review-comments",
      },
    },
  };

  assert.equal(
    await pullRequestConversationHasMarker(octokit, REPO, 7, marker),
    true,
  );
});
