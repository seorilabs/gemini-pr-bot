import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLargeFileDigest,
  buildPullRequestContext,
  buildReviewFollowUpHistory,
  countExplicitAcceptanceCriteria,
  isDeepContextFileFullyVisible,
  isFatalContextComplete,
  listExplicitAcceptanceCriteria,
  prioritizeChangedFilesForContext,
} from "./github.js";
import type { Config } from "./config.js";

test("only acceptance-section checkboxes and explicit AC labels form a deterministic floor", () => {
  const body = [
    "## 변경사항",
    "- 구현 세부사항은 인수조건으로 세지 않는다.",
    "## 인수조건",
    "- 저장 후 값이 유지된다.",
    "2. 다시 열면 복원된다.",
    "## 작업",
    "- [ ] 일반 경로에서 크래시가 없다.",
    "AC-4: 개인정보가 로그에 남지 않는다.",
    "- [x] 저장 후 값이 유지된다.",
  ].join("\n");
  assert.equal(countExplicitAcceptanceCriteria(body), 3);
  assert.equal(countExplicitAcceptanceCriteria("## 변경사항\n- 내부 함수 이름 변경"), 0);
});

test("첫 Seori 결과 전에는 review round 1로 시작한다", () => {
  const state = buildReviewFollowUpHistory([], [], []);

  assert.equal(state.reviewRound, 1);
  assert.equal(state.previousReviewHeadSha, null);
  assert.equal(state.previousReviewBody, "");
  assert.equal(state.contributorResponses, "");
});

test("후속 review는 마지막 Seori 댓글과 그 이후 Contributor 응답만 보존한다", () => {
  const firstHead = "a".repeat(40);
  const secondHead = "b".repeat(40);
  const marker = (head: string, body: string) => [
    `<!-- seorilabs-seori-pr-bot:status=action-required kind=review-follow-up head=${head} -->`,
    body,
  ].join("\n");
  const state = buildReviewFollowUpHistory(
    [
      {
        user: { login: "seori-bot[bot]", type: "Bot" },
        body: marker(firstHead, "첫 번째 요청"),
        created_at: "2026-07-20T00:00:00Z",
      },
      {
        user: { login: "contributor", type: "User" },
        body: "첫 요청을 반영했습니다.",
        created_at: "2026-07-20T00:10:00Z",
      },
      {
        user: { login: "seorilabs-seori-pr-bot[bot]", type: "Bot" },
        body: marker(secondHead, "두 번째 요청"),
        created_at: "2026-07-20T00:20:00Z",
      },
      {
        user: { login: "contributor", type: "User" },
        body: "두 번째 요청은 커밋 cafe123으로 보완했습니다.",
        created_at: "2026-07-20T00:30:00Z",
      },
      {
        user: { login: "other", type: "User" },
        body: marker("c".repeat(40), "사람이 위조한 marker"),
        created_at: "2026-07-20T00:40:00Z",
      },
    ],
    [],
    [],
  );

  assert.equal(state.reviewRound, 3);
  assert.equal(state.previousReviewHeadSha, secondHead);
  assert.match(state.previousReviewBody, /두 번째 요청/);
  assert.doesNotMatch(state.previousReviewBody, /첫 번째 요청/);
  assert.match(state.contributorResponses, /두 번째 요청은 커밋 cafe123/);
  assert.doesNotMatch(state.contributorResponses, /첫 요청을 반영/);
  assert.match(state.contributorResponses, /사람이 위조한 marker/);
});

test("release and command checklists outside acceptance sections are not requirements", () => {
  const body = [
    "## 확인한 명령",
    "- [x] npm run check",
    "- [x] npm run build",
    "## 릴리스 영향",
    "- [x] export preset 이름을 확인했다.",
    "- [x] 문서를 갱신했다.",
  ].join("\n");

  assert.deepEqual(listExplicitAcceptanceCriteria(body), []);
});

test("requirements headings and wrapped constraints remain explicit acceptance criteria", () => {
  const body = [
    "## 요구사항",
    "- 저장한 이름이 다시 열어도 유지된다.",
    "  단, 사용자별로 데이터가 분리되어야 한다.",
    "  - 로그아웃하면 세션이 폐기된다.",
  ].join("\n");
  assert.deepEqual(listExplicitAcceptanceCriteria(body), [
    "저장한 이름이 다시 열어도 유지된다. 단, 사용자별로 데이터가 분리되어야 한다.",
    "로그아웃하면 세션이 폐기된다.",
  ]);
  assert.equal(countExplicitAcceptanceCriteria("## Requirements\n- Data persists.\n- Sessions expire."), 2);
});

test("behavior sections are acceptance criteria while validation results are not", () => {
  const body = [
    "## 동작",
    "```mermaid",
    "flowchart TD",
    "  A --> B",
    "```",
    "- 일시정지 메뉴에서 홈으로 돌아갈 수 있다.",
    "- 종료 전에 사용자에게 확인한다.",
    "## 검증",
    "- Godot compile/smoke PASSED",
    "  실기기 확인은 별도로 필요하다.",
    "## 참고",
    "- 로컬에서 재현할 수 없는 제약이 있다.",
  ].join("\n");

  assert.deepEqual(listExplicitAcceptanceCriteria(body), [
    "일시정지 메뉴에서 홈으로 돌아갈 수 있다.",
    "종료 전에 사용자에게 확인한다.",
  ]);
});

test("English behavior headings accept bullets and numbered items but Testing does not", () => {
  const body = [
    "## Behavior",
    "- Back closes the open modal.",
    "## Expected behavior",
    "1. Back pauses an active level.",
    "2) Back asks before closing the app.",
    "## Testing",
    "- Unit tests passed.",
    "- Device testing is pending.",
  ].join("\n");

  assert.deepEqual(listExplicitAcceptanceCriteria(body), [
    "Back closes the open modal.",
    "Back pauses an active level.",
    "Back asks before closing the app.",
  ]);
});

test("product fatal context is complete when every current product file has a visible usable patch", () => {
  const files = [
    { filename: "src/save.ts", status: "modified" },
    { filename: "src/session.ts", status: "added" },
    { filename: "tests/save.test.ts", status: "modified" },
  ];
  const contents = {
    "src/save.ts": "export function save() {}\n",
    "src/session.ts": "export function restore() {}\n",
  };
  const patches = {
    "src/save.ts": "@@ -1 +1 @@\n-export function save() { return false; }\n+export function save() {}",
    "src/session.ts": "@@ -0,0 +1 @@\n+export function restore() {}",
  };

  assert.equal(isFatalContextComplete("product_logic", files, contents, patches), true);
  assert.equal(
    isFatalContextComplete(
      "mixed",
      [...files, { filename: "README.md", status: "modified" }],
      contents,
      patches,
    ),
    true,
  );
  assert.equal(
    isFatalContextComplete("product_logic", files, { "src/save.ts": contents["src/save.ts"] }, patches),
    true,
  );
  assert.equal(
    isFatalContextComplete("product_logic", files, contents, {
      ...patches,
      "src/session.ts": "(binary file or patch unavailable)",
    }),
    false,
  );
});

test("tests/docs-only context is complete while deletion-only or mismatched product context fails closed", () => {
  assert.equal(
    isFatalContextComplete(
      "tests_only",
      [{ filename: "tests/save.test.ts", status: "modified" }],
      {},
      {},
    ),
    true,
  );
  assert.equal(
    isFatalContextComplete(
      "docs_assets",
      [{ filename: "README.md", status: "modified" }],
      {},
      {},
    ),
    true,
  );
  assert.equal(
    isFatalContextComplete(
      "product_logic",
      [{ filename: "src/save.ts", status: "removed" }],
      {},
      { "src/save.ts": "@@ -1 +0,0 @@\n-export function save() {}" },
    ),
    false,
  );
  assert.equal(
    isFatalContextComplete(
      "mixed",
      [{ filename: "README.md", status: "modified" }],
      {},
      {},
    ),
    false,
  );
});

test("deep context visibility ignores duplicate changed-file headings in earlier sections", () => {
  const content = "export function save() { return true; }\n";
  const markdown = [
    "## Changed Files",
    "### src/save.ts",
    "```diff",
    "@@ -1 +1 @@",
    "-export function save() { return false; }",
    "+export function save() { return true; }",
    "```",
    "",
    "## Current Changed File Contents",
    "### src/save.ts",
    "status=modified",
    "````typescript",
    content.trimEnd(),
    "````",
    "",
    "## Deep Repository Context",
    "### src/save.ts",
    "````typescript",
    content.trimEnd(),
    "````",
  ].join("\n");

  assert.equal(isDeepContextFileFullyVisible(markdown, "src/save.ts", content), true);
  assert.equal(
    isDeepContextFileFullyVisible(markdown.replace(/\n````$/u, ""), "src/save.ts", content),
    false,
  );
});

test("changed product files are prioritized ahead of tests and assets", () => {
  const files = [
    { filename: "tests/save.test.ts", status: "modified" },
    { filename: "assets/save.png", status: "modified" },
    { filename: "src/save.ts", status: "modified" },
    { filename: "src/session.ts", status: "added" },
  ];

  assert.deepEqual(
    prioritizeChangedFilesForContext(files).map((file) => file.filename),
    ["src/save.ts", "src/session.ts", "tests/save.test.ts", "assets/save.png"],
  );
});

test("large-file digest covers deletion-only hunks before spending budget on the outline", () => {
  const content = Array.from({ length: 120 }, (_, index) =>
    index === 47
      ? "export function renderPlot() { return true; }"
      : `const line${index + 1} = ${index + 1};`
  ).join("\n");
  const digest = buildLargeFileDigest(
    content,
    "@@ -48,2 +48 @@\n-export function oldSoil() {}\n export function renderPlot() { return true; }",
  );

  assert.ok(digest);
  assert.equal(digest.changedRegionsComplete, true);
  assert.match(digest.markdown, /^# changed-region windows/mu);
  assert.match(digest.markdown, /L48: export function renderPlot/);
});

test("large-file digest remains incomplete when all changed-hunk windows do not fit", () => {
  const content = Array.from({ length: 2_000 }, (_, index) =>
    `const line${index + 1} = "${"x".repeat(160)}";`
  ).join("\n");
  const patch = Array.from(
    { length: 20 },
    (_, index) => `@@ -${index * 100 + 1},1 +${index * 100 + 1},1 @@\n-old\n+new`,
  ).join("\n");
  const digest = buildLargeFileDigest(content, patch);

  assert.ok(digest);
  assert.equal(digest.changedRegionsComplete, false);
  assert.match(digest.markdown, /changed-region windows truncated/);
});

test("review context prioritizes a large changed product file and can complete fatal review without deep clone", async () => {
  const headSha = "a".repeat(40);
  const testContent = Array.from({ length: 2_000 }, (_, index) =>
    `test("case ${index + 1}", () => expect(${index + 1}).toBe(${index + 1}));`
  ).join("\n");
  const productContent = Array.from({ length: 2_000 }, (_, index) =>
    index === 99
      ? "export function save() { return true; }"
      : `const value${index + 1} = ${index + 1};`
  ).join("\n");
  const files = [
    {
      filename: "tests/large.test.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -100 +100 @@\n-test(\"old\", () => expect(false).toBe(true));\n+test(\"new\", () => expect(true).toBe(true));",
    },
    {
      filename: "src/large.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -100 +100 @@\n-export function save() { return false; }\n+export function save() { return true; }",
    },
  ];
  const contentByPath = new Map([
    ["tests/large.test.ts", testContent],
    ["src/large.ts", productContent],
  ]);
  const paged = (data: any[]) => async () => ({ data });
  const octokit = {
    paginate: async (method: (params: any) => Promise<{ data: any[] }>, params: any) =>
      (await method(params)).data,
    rest: {
      checks: {
        listForRef: async () => ({ data: { check_runs: [] } }),
      },
      issues: {
        listComments: paged([]),
      },
      pulls: {
        get: async () => ({
          data: {
            state: "open",
            merged: false,
            title: "large product change",
            body: "",
            draft: false,
            mergeable: true,
            mergeable_state: "clean",
            user: { login: "author" },
            head: { sha: headSha, ref: "feature", repo: { full_name: "seorilabs/example" } },
            base: { ref: "main", repo: { full_name: "seorilabs/example" } },
          },
        }),
        listFiles: paged(files),
        listCommits: paged([]),
        listReviewComments: paged([]),
        listReviews: paged([]),
      },
      repos: {
        getContent: async ({ path: file }: { path: string }) => {
          const content = contentByPath.get(file);
          assert.ok(content);
          return {
            data: {
              type: "file",
              size: Buffer.byteLength(content),
              content: Buffer.from(content).toString("base64"),
            },
          };
        },
        listCommitStatusesForRef: async () => ({ data: [] }),
      },
    },
  };
  const config = {
    allowPublicRepos: false,
    deepRepoContextMode: "off",
    deepRepoContextTimeoutMs: 10_000,
    deepRepoContextMaxFiles: 40,
    deepRepoContextMaxBytes: 80_000,
    maxPatchChars: 120_000,
    maxContextChars: 160_000,
    trustedAssociations: new Set(["OWNER", "MEMBER", "COLLABORATOR"]),
  } as Config;

  const context = await buildPullRequestContext(
    octokit,
    { owner: "seorilabs", repo: "example", fullName: "seorilabs/example", isPrivate: true },
    1,
    config,
  );
  const changedContents = context.reviewGateMarkdown.slice(
    context.reviewGateMarkdown.indexOf("## Current Changed File Contents"),
    context.reviewGateMarkdown.indexOf("## Deep Repository Context"),
  );
  const changedPatches = context.reviewGateMarkdown.slice(
    context.reviewGateMarkdown.indexOf("## Changed Files"),
    context.reviewGateMarkdown.indexOf("## Current Changed File Contents"),
  );

  assert.equal(context.fatalContextComplete, true);
  assert.ok(context.currentHeadFileContents["src/large.ts"]);
  assert.ok(context.visibleChangedPatches["src/large.ts"]);
  assert.ok(
    changedContents.indexOf("### src/large.ts") <
      changedContents.indexOf("### tests/large.test.ts"),
  );
  assert.ok(
    changedPatches.indexOf("### src/large.ts") <
      changedPatches.indexOf("### tests/large.test.ts"),
  );
});

test("후속 review context는 incremental diff와 직전 요청에 명시된 현재 파일만 노출한다", async () => {
  const previousHead = "a".repeat(40);
  const currentHead = "b".repeat(40);
  const fullFiles = [
    {
      filename: "src/old-scope.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-export const oldScope = false;\n+export const oldScope = true;",
    },
    {
      filename: "src/follow-up.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-export const followUp = false;\n+export const followUp = true;",
    },
  ];
  const followUpFiles = [fullFiles[1]];
  const paged = (data: any[]) => async () => ({ data });
  let comparedBasehead = "";
  const octokit = {
    paginate: async (method: (params: any) => Promise<{ data: any[] }>, params: any) =>
      (await method(params)).data,
    rest: {
      checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
      issues: {
        listComments: paged([
          {
            user: { login: "seori-bot", type: "Bot" },
            body: `<!-- seorilabs-seori-pr-bot:status=action-required kind=review-follow-up head=${previousHead} -->\nsrc/old-scope.ts:1 테스트 위치를 알려 주세요.`,
            created_at: "2026-07-20T00:00:00Z",
          },
          {
            user: { login: "contributor", type: "User" },
            body: "요청한 테스트를 추가했습니다.",
            created_at: "2026-07-20T00:10:00Z",
          },
        ]),
      },
      pulls: {
        get: async () => ({
          data: {
            state: "open",
            merged: false,
            title: "follow-up change",
            body: "",
            draft: false,
            mergeable: true,
            mergeable_state: "clean",
            user: { login: "author" },
            head: { sha: currentHead, ref: "feature", repo: { full_name: "seorilabs/example" } },
            base: { ref: "main", repo: { full_name: "seorilabs/example" } },
          },
        }),
        listFiles: paged(fullFiles),
        listCommits: paged([
          { sha: previousHead, commit: { message: "이전 변경" } },
          { sha: currentHead, commit: { message: "후속 변경" } },
        ]),
        listReviewComments: paged([]),
        listReviews: paged([]),
      },
      repos: {
        compareCommitsWithBasehead: async ({ basehead }: { basehead: string }) => {
          comparedBasehead = basehead;
          return { data: { files: followUpFiles } };
        },
        getContent: async ({ path: file }: { path: string }) => ({
          data: {
            type: "file",
            size: 32,
            content: Buffer.from(`export const value = ${file.includes("follow-up")};`).toString("base64"),
          },
        }),
        listCommitStatusesForRef: async () => ({ data: [] }),
      },
    },
  };
  const config = {
    allowPublicRepos: false,
    deepRepoContextMode: "off",
    deepRepoContextTimeoutMs: 10_000,
    deepRepoContextMaxFiles: 40,
    deepRepoContextMaxBytes: 80_000,
    maxPatchChars: 120_000,
    maxContextChars: 160_000,
    trustedAssociations: new Set(["OWNER", "MEMBER", "COLLABORATOR"]),
  } as Config;

  const context = await buildPullRequestContext(
    octokit,
    { owner: "seorilabs", repo: "example", fullName: "seorilabs/example", isPrivate: true },
    1,
    config,
  );
  const changedFiles = context.reviewGateMarkdown.slice(
    context.reviewGateMarkdown.indexOf("## Changed Files"),
    context.reviewGateMarkdown.indexOf("## Current Changed File Contents"),
  );
  const changedContents = context.reviewGateMarkdown.slice(
    context.reviewGateMarkdown.indexOf("## Current Changed File Contents"),
    context.reviewGateMarkdown.indexOf("## Deep Repository Context"),
  );

  assert.equal(comparedBasehead, `${previousHead}...${currentHead}`);
  assert.equal(context.reviewFollowUp.reviewRound, 2);
  assert.match(context.reviewGateMarkdown, /테스트 위치를 알려 주세요/);
  assert.match(context.reviewGateMarkdown, /요청한 테스트를 추가했습니다/);
  assert.match(changedFiles, /src\/follow-up\.ts/);
  assert.doesNotMatch(changedFiles, /src\/old-scope\.ts/);
  assert.match(changedContents, /src\/follow-up\.ts/);
  assert.match(changedContents, /src\/old-scope\.ts/);
  assert.deepEqual(Object.keys(context.visibleChangedPatches), ["src/follow-up.ts"]);
  assert.equal(context.fatalContextComplete, true);
});
