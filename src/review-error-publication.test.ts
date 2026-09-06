import assert from "node:assert/strict";
import test from "node:test";
import { PrBot } from "./bot.js";

const HEAD = "a37cad512cc9068f650122edb479ef64bc15dde8";
const REPO = { owner: "seorilabs", repo: "saju-reader", fullName: "seorilabs/saju-reader" };

function fixture(current = true) {
  const comments: string[] = [];
  const verdicts: string[] = [];
  const guides: boolean[] = [];
  const bot: any = Object.create(PrBot.prototype);
  Object.assign(bot, {
    config: { acceptanceGuideModeEnabled: true, defectReviewEnabled: true },
    logger: { warn: () => undefined },
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
    publishAcceptanceGuide: async (...args: any[]) => { guides.push(args[6]); },
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
