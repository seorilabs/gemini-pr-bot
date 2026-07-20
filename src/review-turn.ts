import type {
  ReviewGateAbstainItem,
  ReviewGatePublicVerdict,
} from "./review-gate-format.js";

export const MIN_REVIEW_ROUND_FOR_ABSTAIN = 3;

/**
 * An inconclusive first response is an active follow-up request, not a handoff.
 * ABSTAIN is reserved for a later review turn after core scope is settled and
 * every remaining item is explicitly classified as peripheral by the host.
 */
export function resolveReviewTurnVerdict(
  baseVerdict: Exclude<ReviewGatePublicVerdict, "FOLLOW_UP">,
  reviewRound: number,
  unresolvedItems: readonly ReviewGateAbstainItem[],
): ReviewGatePublicVerdict {
  if (baseVerdict !== "ABSTAIN") {
    return baseVerdict;
  }
  if (
    reviewRound >= MIN_REVIEW_ROUND_FOR_ABSTAIN &&
    unresolvedItems.length > 0 &&
    unresolvedItems.every((item) => item.peripheral === true)
  ) {
    return "ABSTAIN";
  }
  return "FOLLOW_UP";
}

export function isPeripheralAcceptanceCriterion(value: string): boolean {
  const normalized = value.normalize("NFKC").toLowerCase();
  const highRisk =
    /보안|인증|인가|권한|결제|개인정보|데이터|저장|삭제|복구|마이그레이션|배포|릴리스|서명|크래시|security|auth|permission|payment|privacy|data|persist|delete|migration|deploy|release|signing|crash/iu;
  const peripheral =
    /문구|텍스트|라벨|색상|간격|정렬|아이콘|주석|문서|로그\s*메시지|copy|wording|text|label|color|spacing|alignment|icon|comment|documentation|log\s*message/iu;
  return peripheral.test(normalized) && !highRisk.test(normalized);
}
