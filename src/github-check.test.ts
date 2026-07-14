import assert from "node:assert/strict";
import test from "node:test";
import { completeLatestOwnReviewCheckAsSuccess, type RepoRef } from "./github.js";

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
