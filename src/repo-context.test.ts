import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import { buildDeepRepoContext, classifyChange } from "./repo-context.js";

const execFileAsync = promisify(execFile);

test("standard XCTest and .NET test paths are classified as tests-only", () => {
  assert.equal(classifyChange(["MyAppTests/FooTests.swift"]), "tests_only");
  assert.equal(classifyChange(["Project.Tests/FooTests.cs"]), "tests_only");
});

test("product, config, and mixed changes receive stable host classifications", () => {
  assert.equal(classifyChange(["src/save.ts"]), "product_logic");
  assert.equal(classifyChange([".github/workflows/ci.yml"]), "config_or_workflow");
  assert.equal(classifyChange(["src/save.ts", "README.md"]), "mixed");
  assert.equal(classifyChange(["package.json", "README.md"]), "config_or_workflow");
  assert.equal(classifyChange(["scripts/release.ts"]), "config_or_workflow");
  assert.equal(classifyChange(["src/api.generated.ts"]), "docs_assets");
});

test("tracked symlinks do not make test discovery partial and all regular tests can be included", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seori-repo-context-test-"));
  const sourceRepo = path.join(root, "source");
  const bareRepo = path.join(root, "remote.git");
  const gitConfigPath = path.join(root, "gitconfig");
  const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousGitConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM;

  try {
    await fs.mkdir(path.join(sourceRepo, "src"), { recursive: true });
    await fs.mkdir(path.join(sourceRepo, "tests"), { recursive: true });
    await fs.mkdir(path.join(sourceRepo, "links"), { recursive: true });
    await fs.mkdir(path.join(sourceRepo, "vendor", "tests"), { recursive: true });
    await fs.mkdir(path.join(sourceRepo, "generated", "tests"), { recursive: true });
    await fs.writeFile(path.join(sourceRepo, "src", "player.gd"), "func move():\n\tpass\n");
    await fs.writeFile(
      path.join(sourceRepo, "tests", "player_test.gd"),
      "extends Node\nfunc test_move():\n\tassert_true(true)\n",
    );
    await fs.writeFile(
      path.join(sourceRepo, "tests", "network_test.gd"),
      "extends Node\nfunc test_network():\n\tassert_true(true)\n",
    );
    await fs.writeFile(path.join(sourceRepo, "vendor", "tests", "vendor_test.gd"), "generated\n");
    await fs.writeFile(path.join(sourceRepo, "generated", "tests", "generated_test.gd"), "generated\n");

    // foam-party has many tracked symlinks. The count is intentional: the
    // regression must not turn an otherwise exhaustive inventory into partial.
    for (let index = 0; index < 91; index += 1) {
      await fs.symlink("../src/player.gd", path.join(sourceRepo, "links", `player-${index}.gd`));
    }

    await runGit(["init", "-b", "main"], sourceRepo);
    await runGit(["config", "user.name", "Test"], sourceRepo);
    await runGit(["config", "user.email", "test@example.com"], sourceRepo);
    await runGit(["add", "-A"], sourceRepo);
    await runGit(["commit", "-m", "fixture"], sourceRepo);
    const { stdout: headShaOutput } = await runGit(["rev-parse", "HEAD"], sourceRepo);
    const headSha = headShaOutput.trim();
    await execFileAsync("git", ["clone", "--bare", sourceRepo, bareRepo]);
    await runGit(["update-ref", "refs/pull/149/head", headSha], bareRepo);

    await fs.writeFile(
      gitConfigPath,
      `[url "file://${bareRepo}"]\n\tinsteadOf = https://github.com/local/repo.git\n`,
    );
    process.env.GIT_CONFIG_GLOBAL = gitConfigPath;
    process.env.GIT_CONFIG_NOSYSTEM = "1";

    const result = await buildDeepRepoContext({
      repo: { owner: "local", repo: "repo", fullName: "local/repo", isPrivate: true },
      prNumber: 149,
      headSha,
      files: [{ filename: "src/player.gd", patch: "+func move():" }],
      installationToken: "fixture-token",
      config: {
        deepRepoContextMode: "always",
        deepRepoContextTimeoutMs: 10_000,
        deepRepoContextMaxFiles: 20,
        deepRepoContextMaxBytes: 200_000,
      } as Config,
    });

    assert.equal(result.testInventoryComplete, true);
    assert.match(result.markdown, /Test discovery complete: true/);
    assert.match(result.markdown, /Test inventory discovered: 2/);
    assert.match(result.markdown, /Test inventory included: 2/);
    assert.match(result.markdown, /Test inventory complete: true/);
    assert.ok(result.fileContents["tests/player_test.gd"]);
    assert.ok(result.fileContents["tests/network_test.gd"]);
    assert.equal(result.fileContents["vendor/tests/vendor_test.gd"], undefined);
    assert.equal(result.fileContents["generated/tests/generated_test.gd"], undefined);
    assert.ok(
      result.markdown.indexOf("### tests/player_test.gd") <
        result.markdown.indexOf("### tests/network_test.gd"),
      "related test should remain ahead of unrelated discovered tests",
    );
  } finally {
    if (previousGitConfigGlobal === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
    }
    if (previousGitConfigNoSystem === undefined) {
      delete process.env.GIT_CONFIG_NOSYSTEM;
    } else {
      process.env.GIT_CONFIG_NOSYSTEM = previousGitConfigNoSystem;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}
