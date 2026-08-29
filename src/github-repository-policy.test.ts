import assert from "node:assert/strict";
import test from "node:test";
import type { Config } from "./config.js";
import {
  isTrustedRepositoryActor,
  shouldAutomaticallyReviewPullRequest,
  shouldHandleRepository,
} from "./github.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    githubOrg: "seorilabs",
    allowPublicRepos: false,
    publicRepositoryAllowlist: new Set([
      "seorilabs/.github",
      "seorilabs/platform",
      "seorilabs/seorilabs-backoffice",
    ]),
    trustedAssociations: new Set(["OWNER", "MEMBER", "COLLABORATOR"]),
    ...overrides,
  } as Config;
}

function pullRequestPayload(input: {
  repository?: string;
  isPrivate?: boolean;
  headRepository?: string | null;
  baseRepository?: string;
  authorAssociation?: string;
} = {}) {
  const repository = input.repository ?? "seorilabs/platform";
  const [owner, name] = repository.split("/");
  return {
    repository: {
      owner: { login: owner },
      name,
      full_name: repository,
      private: input.isPrivate ?? false,
    },
    pull_request: {
      number: 110,
      author_association: input.authorAssociation ?? "MEMBER",
      user: { login: "magicsih" },
      head: {
        repo: input.headRepository === null
          ? null
          : { full_name: input.headRepository ?? repository },
      },
      base: { repo: { full_name: input.baseRepository ?? repository } },
    },
  };
}

test("allowlisted public central repository의 trusted same-repo PR만 자동 리뷰한다", async () => {
  const payload = pullRequestPayload();
  const octokit = publicPullRequestOctokit("admin");
  assert.equal(shouldHandleRepository(payload, config()), true);
  assert.equal(await shouldAutomaticallyReviewPullRequest(octokit, payload, config()), true);
});

function publicPullRequestOctokit(permission: string) {
  return {
    rest: {
      pulls: {
        get: async () => ({ data: {
          author_association: "CONTRIBUTOR",
          user: { login: "magicsih" },
          head: { repo: { full_name: "seorilabs/platform" } },
          base: { repo: { full_name: "seorilabs/platform" } },
        } }),
      },
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission } }),
      },
    },
  };
}

test("allowlisted public repository의 external fork와 untrusted author는 자동 리뷰하지 않는다", async () => {
  const fork = pullRequestPayload({ headRepository: "external/platform" });
  const contributor = pullRequestPayload({ authorAssociation: "CONTRIBUTOR" });
  const missingHead = pullRequestPayload({ headRepository: null });
  const octokit = publicPullRequestOctokit("read");

  assert.equal(shouldHandleRepository(fork, config()), true);
  assert.equal(await shouldAutomaticallyReviewPullRequest(octokit, fork, config()), false);
  assert.equal(await shouldAutomaticallyReviewPullRequest(octokit, contributor, config()), false);
  assert.equal(await shouldAutomaticallyReviewPullRequest(octokit, missingHead, config()), false);
});

test("installation association이 stale이면 현재 same-repo PR 작성자의 repository permission을 readback한다", async () => {
  const payload = pullRequestPayload({ authorAssociation: "CONTRIBUTOR" });
  const octokit = publicPullRequestOctokit("admin");

  assert.equal(await shouldAutomaticallyReviewPullRequest(octokit, payload, config()), true);
});

test("allowlisted public repository의 명시적 command도 현재 repository permission을 사용한다", async () => {
  const repo = {
    owner: "seorilabs",
    repo: "platform",
    fullName: "seorilabs/platform",
    isPrivate: false,
  };
  assert.equal(
    await isTrustedRepositoryActor(publicPullRequestOctokit("maintain"), repo, "magicsih", "CONTRIBUTOR", config()),
    true,
  );
  assert.equal(
    await isTrustedRepositoryActor(publicPullRequestOctokit("read"), repo, "outsider", "MEMBER", config()),
    false,
  );
});

test("allowlist 밖 public repository는 명시적 명령을 포함한 모든 경로에서 거부한다", async () => {
  const payload = pullRequestPayload({ repository: "seorilabs/public-product" });
  assert.equal(shouldHandleRepository(payload, config()), false);
  assert.equal(await shouldAutomaticallyReviewPullRequest({}, payload, config()), false);
});

test("private organization repository의 기존 자동 리뷰 동작은 유지한다", async () => {
  const payload = pullRequestPayload({
    repository: "seorilabs/private-product",
    isPrivate: true,
    headRepository: "external/fork",
    authorAssociation: "CONTRIBUTOR",
  });
  assert.equal(await shouldAutomaticallyReviewPullRequest({}, payload, config()), true);
});
