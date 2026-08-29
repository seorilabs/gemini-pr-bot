import assert from "node:assert/strict";
import test from "node:test";
import type { Config } from "./config.js";
import {
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
      author_association: input.authorAssociation ?? "MEMBER",
      head: {
        repo: input.headRepository === null
          ? null
          : { full_name: input.headRepository ?? repository },
      },
      base: { repo: { full_name: input.baseRepository ?? repository } },
    },
  };
}

test("allowlisted public central repository의 trusted same-repo PR만 자동 리뷰한다", () => {
  const payload = pullRequestPayload();
  assert.equal(shouldHandleRepository(payload, config()), true);
  assert.equal(shouldAutomaticallyReviewPullRequest(payload, config()), true);
});

test("allowlisted public repository의 external fork와 untrusted author는 자동 리뷰하지 않는다", () => {
  const fork = pullRequestPayload({ headRepository: "external/platform" });
  const contributor = pullRequestPayload({ authorAssociation: "CONTRIBUTOR" });
  const missingHead = pullRequestPayload({ headRepository: null });

  assert.equal(shouldHandleRepository(fork, config()), true);
  assert.equal(shouldAutomaticallyReviewPullRequest(fork, config()), false);
  assert.equal(shouldAutomaticallyReviewPullRequest(contributor, config()), false);
  assert.equal(shouldAutomaticallyReviewPullRequest(missingHead, config()), false);
});

test("allowlist 밖 public repository는 명시적 명령을 포함한 모든 경로에서 거부한다", () => {
  const payload = pullRequestPayload({ repository: "seorilabs/public-product" });
  assert.equal(shouldHandleRepository(payload, config()), false);
  assert.equal(shouldAutomaticallyReviewPullRequest(payload, config()), false);
});

test("private organization repository의 기존 자동 리뷰 동작은 유지한다", () => {
  const payload = pullRequestPayload({
    repository: "seorilabs/private-product",
    isPrivate: true,
    headRepository: "external/fork",
    authorAssociation: "CONTRIBUTOR",
  });
  assert.equal(shouldAutomaticallyReviewPullRequest(payload, config()), true);
});
