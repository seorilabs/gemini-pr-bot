import assert from "node:assert/strict";
import test from "node:test";
import { PrBot } from "./bot.js";

const HEAD = "a37cad512cc9068f650122edb479ef64bc15dde8";
const REPO = { owner: "seorilabs", repo: "saju-reader", fullName: "seorilabs/saju-reader" };

function fixture(current = true, failAfterGuidePublication = false) {
  const comments: string[] = [];
  const verdicts: string[] = [];
  const guides: boolean[] = [];
  const bot: any = Object.create(PrBot.prototype);
  Object.assign(bot, {
    config: { acceptanceGuideModeEnabled: true, defectReviewEnabled: true },
    logger: { warn: () => undefined },
    operationsNotifier: {
      startReviewAudit: async () => null,
    },
    ai: { reviewGateDefectCandidates: async () => { throw new Error("request timed out"); } },
    jansoree: {
      available: () => true,
      octokitFor: async () => ({ rest: { issues: {
        createComment: async ({ body }: { body: string }) => { comments.push(body); },
      } } }),
    },
    trustedReviewRequest: () => "",
    loadReviewGateLedgerSnapshot: async () => ({ records: [], publishedFingerprints: new Set() }),
    reviewGatePrompts: () => ({}),
    reportGateProgress: async () => undefined,
    reviewGateContextHash: () => "fixture",
    recordReviewGateRun: async (...args: any[]) => { verdicts.push(args[8]); },
    currentStatusForPublish: async () => current ? { headSha: HEAD } : null,
    publishAcceptanceGuide: async (...args: any[]) => {
      guides.push(args[6]);
      if (failAfterGuidePublication) throw new Error("check completion failed after guide publication");
    },
  });
  const run = () => bot.runStructuredReview({}, REPO, 124, {
    headSha: HEAD,
    explicitAcceptanceCriteria: [],
    currentHeadFileContents: {},
    reviewFollowUp: { contributorResponses: "" },
  }, {}, null);
  return { run, comments, verdicts, guides };
}

test("최초 결함 추출이 실패해도 ABSTAIN과 잔소리 판정 불가 요약을 함께 게시한다", async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.verdicts, ["ABSTAIN"]);
  assert.deepEqual(f.guides, [true]);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0]!, /## 잔소리/u);
  assert.match(f.comments[0]!, new RegExp(HEAD));
  assert.match(f.comments[0]!, /판정하지 못했습니다/u);
  assert.doesNotMatch(f.comments[0]!, /지적할 결함을 찾지 못했습니다/u);
});

test("오류 처리 중 HEAD가 바뀌면 이전 HEAD의 가이드와 요약을 게시하지 않는다", async () => {
  const f = fixture(false);
  await f.run();
  assert.deepEqual(f.verdicts, ["ABSTAIN"]);
  assert.deepEqual(f.guides, []);
  assert.deepEqual(f.comments, []);
});

test("가이드 게시 후 check 완료가 실패해도 잔소리 요약은 이미 게시되어 있다", async () => {
  const f = fixture(true, true);
  await assert.rejects(f.run(), /check completion failed/u);
  assert.deepEqual(f.guides, [true]);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0]!, /판정하지 못했습니다/u);
});

test("서리 리뷰와 잔소리 리뷰의 요약 및 지적을 Discord 리뷰 쓰레드에 남긴다", async () => {
  const entries: Array<{ title: string; text: string }> = [];
  const bot: any = Object.create(PrBot.prototype);
  bot.operationsNotifier = {
    notifyReviewAuditEntry: async (_session: unknown, entry: { title: string; text: string }) => {
      entries.push(entry);
    },
  };
  const session = {
    repoFullName: REPO.fullName,
    prNumber: 124,
    prTitle: "리뷰 감사 로그",
    prUrl: `https://github.com/${REPO.fullName}/pull/124`,
    headSha: HEAD,
    parentId: "review-audit-parent",
    threadName: "saju-reader #124 리뷰 로그",
  };

  await bot.notifyAcceptanceGuideAudit(session, {
    summary: "서리 리뷰 결과",
    items: [{
      id: "AC-1",
      label: "저장 실패 시 데이터를 보존한다",
      reason: "현재 테스트 근거가 없습니다.",
      requiredAction: "회귀 테스트를 추가해 주세요.",
    }],
  }, "");
  await bot.notifyJansoreeAudit(session, "잔소리 리뷰 결과", [{
    kind: "fatal_defect",
    title: "저장 시 프로세스가 종료됩니다",
    problem: "정상 저장 경로에서 예외가 발생합니다.",
    trigger: "저장 버튼을 누릅니다.",
    evidence: { file: "src/save.ts", line: 42, code: "throw new Error('fatal')" },
    impact: "저장할 수 없습니다.",
    requiredAction: "예외를 제거하고 회귀 테스트를 추가해 주세요.",
    fingerprint: "fatal-save-42",
  }]);

  assert.deepEqual(entries.map((entry) => entry.title), [
    "서리 리뷰 · 요약",
    "서리 리뷰 · 쓰레드 1",
    "잔소리 리뷰 · 요약",
    "잔소리 리뷰 · 지적 1",
  ]);
  assert.match(entries[1]!.text, /회귀 테스트를 추가/u);
  assert.match(entries[3]!.text, /src\/save\.ts/u);
});
