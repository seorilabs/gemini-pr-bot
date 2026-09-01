import assert from "node:assert/strict";
import test from "node:test";

import type { Config } from "./config.js";
import type { RepoRef } from "./github.js";
import { isBotGithubAuthor } from "./identity.js";
import { JansoreeClient, type JansoreeApp } from "./jansoree.js";

const repo: RepoRef = { owner: "seorilabs", repo: "keeum", fullName: "seorilabs/keeum", isPrivate: true };

function configWith(overrides: Partial<Config>): Config {
  return { reviewGithubAppId: "4792283", reviewGithubPrivateKey: "PEM", ...overrides } as Config;
}

function appWith(behavior: {
  getRepoInstallation: (params: { owner: string; repo: string }) => Promise<{ data: { id: number } }>;
}): { app: JansoreeApp; installationCalls: number[]; octokitCalls: number[] } {
  const installationCalls: number[] = [];
  const octokitCalls: number[] = [];
  const app: JansoreeApp = {
    octokit: {
      rest: {
        apps: {
          getRepoInstallation: async (params) => {
            installationCalls.push(Date.now());
            return behavior.getRepoInstallation(params);
          },
        },
      },
    },
    getInstallationOctokit: async (installationId) => {
      octokitCalls.push(installationId);
      return { installationId };
    },
  };
  return { app, installationCalls, octokitCalls };
}

test("자격증명이 없으면 available이 false이고 octokit을 만들지 않는다", async () => {
  const client = new JansoreeClient(configWith({ reviewGithubAppId: undefined, reviewGithubPrivateKey: undefined }));
  assert.equal(client.available(), false);
  assert.equal(await client.octokitFor(repo), null);
});

test("설치를 해석해 octokit을 만들고 저장소별로 캐시한다", async () => {
  const { app, installationCalls, octokitCalls } = appWith({
    getRepoInstallation: async (params) => {
      assert.equal(params.owner, "seorilabs");
      assert.equal(params.repo, "keeum");
      return { data: { id: 158170086 } };
    },
  });
  const client = new JansoreeClient(configWith({}), undefined, () => app);

  const first = await client.octokitFor(repo);
  const second = await client.octokitFor(repo);
  assert.deepEqual(first, { installationId: 158170086 });
  assert.equal(second, first);
  assert.equal(installationCalls.length, 1);
  assert.deepEqual(octokitCalls, [158170086]);
});

test("미설치 404는 null을 반환하고 negative cache로 반복 조회를 막는다", async () => {
  const { app, installationCalls } = appWith({
    getRepoInstallation: async () => {
      const error = new Error("Not Found") as Error & { status: number };
      error.status = 404;
      throw error;
    },
  });
  const warned: unknown[] = [];
  const client = new JansoreeClient(
    configWith({}),
    { info: () => undefined, warn: (value) => warned.push(value) },
    () => app,
  );

  assert.equal(await client.octokitFor(repo), null);
  assert.equal(await client.octokitFor(repo), null);
  assert.equal(installationCalls.length, 1);
  assert.equal(warned.length, 1);
});

test("jansoree[bot]은 봇 작성자로 인식되어 자기 코멘트 루프를 만들지 않는다", () => {
  assert.equal(isBotGithubAuthor("jansoree[bot]"), true);
  assert.equal(isBotGithubAuthor("Jansoree[bot]"), true);
  assert.equal(isBotGithubAuthor("jansoree"), true);
});
