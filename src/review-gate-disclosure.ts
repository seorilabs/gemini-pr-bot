import type {
  MiniMaxAcceptanceCoverage,
  MiniMaxCandidateVerification,
  MiniMaxReviewCandidate,
} from "./minimax-review.js";
import {
  isExplicitlyManualAcceptanceCriterion,
  normalizeReviewAcceptanceEvidence,
} from "./review-acceptance-coverage.js";
import type { StoredReviewFinding } from "./review-finding-ledger.js";
import type {
  ReviewGateCandidateRejectionCode,
  ReviewGatePipelineResult,
} from "./review-gate-pipeline.js";
import type {
  ReviewGateAbstainItem,
  ReviewGateCoveredCriterion,
} from "./review-gate-format.js";
import type { GroundedAcceptanceTestEvidence } from "./review-acceptance-coverage.js";
import { isPeripheralAcceptanceCriterion } from "./review-turn.js";

export type ReviewGateDisclosure = {
  coveredCriteria: ReviewGateCoveredCriterion[];
  fatalCheckPassed: boolean;
  abstainItems: ReviewGateAbstainItem[];
};

export type ReviewGateDisclosureInput = {
  explicitAcceptanceCriteria: readonly string[];
  acceptanceCoverage: readonly MiniMaxAcceptanceCoverage[];
  groundedAcceptanceCriteria: ReadonlySet<string>;
  groundedTestEvidence?: ReadonlyMap<string, GroundedAcceptanceTestEvidence>;
  coverageValidationErrors: readonly string[];
  fatalContextComplete: boolean;
  pipeline: ReviewGatePipelineResult;
  candidates: readonly MiniMaxReviewCandidate[];
  verifications: readonly MiniMaxCandidateVerification[];
  unconfirmedOpenFindings: readonly StoredReviewFinding[];
};

/**
 * Builds the public PASS/ABSTAIN breakdown exclusively from host-validated
 * state. Free-form model reasons remain internal diagnostics.
 */
export function buildReviewGateDisclosure(
  input: ReviewGateDisclosureInput,
): ReviewGateDisclosure {
  const coveredCriteria: ReviewGateCoveredCriterion[] = [];
  const abstainItems: ReviewGateAbstainItem[] = [];
  const coverageErrors = new Map(
    input.coverageValidationErrors.map((error) => {
      const [criterionId, code = "acceptance_coverage_unknown"] = error.split(/:\s*/u, 2);
      return [criterionId || "인수조건", code] as const;
    }),
  );

  for (let index = 0; index < input.explicitAcceptanceCriteria.length; index += 1) {
    const criterion = input.explicitAcceptanceCriteria[index]!;
    if (isExplicitlyManualAcceptanceCriterion(criterion)) {
      continue;
    }
    const criterionId = `AC-${index + 1}`;
    const coverage = input.acceptanceCoverage[index];
    const normalizedCriterion = normalizeReviewAcceptanceEvidence(criterion);
    const groundedEvidence = input.groundedTestEvidence?.get(normalizedCriterion);
    if (input.groundedAcceptanceCriteria.has(normalizedCriterion) && coverage?.testEvidence) {
      coveredCriteria.push({
        criterionId,
        acceptanceCriterion: criterion,
        file: groundedEvidence?.file ?? coverage.testEvidence.file,
        line: groundedEvidence?.line ?? coverage.testEvidence.line,
        testName: groundedEvidence?.testName ?? coverage.testEvidence.testName,
        evidenceKind: groundedEvidence?.kind ?? "test",
      });
      continue;
    }
    abstainItems.push({
      label: `${criterionId} · ${criterion}`,
      reason: coverageAbstainReason(coverageErrors.get(criterionId)),
      requiredAction: coverageRequiredAction(coverageErrors.get(criterionId), criterionId),
      peripheral: isPeripheralAcceptanceCriterion(criterion),
    });
  }

  if (!input.pipeline.inputValid) {
    const codes = new Set(input.pipeline.rejected.map((rejection) => rejection.code));
    if (codes.size === 0) {
      abstainItems.push({
        label: "자동 검증 결과 구조",
        reason: "검토 후보와 독립 검증 결과의 구조가 호스트 검증 규칙을 충족하지 않아 판정을 확정하지 못했습니다.",
        requiredAction: "코드 수정은 필요하지 않습니다. 이 댓글에 현재 HEAD 재검토를 요청하면 Seori가 검증 결과를 다시 생성합니다.",
        peripheral: false,
      });
    } else {
      for (const code of codes) {
        abstainItems.push({
          label: "자동 검증 결과 구조",
          reason: protocolAbstainReason(code),
          requiredAction: "코드 수정은 필요하지 않습니다. 이 댓글에 현재 HEAD 재검토를 요청하면 Seori가 검증 결과를 다시 생성합니다.",
          peripheral: false,
        });
      }
    }
  }

  if (!input.fatalContextComplete) {
    abstainItems.push({
      label: "치명 결함 검사",
      reason: "변경 파일의 현재 HEAD 코드 또는 패치 문맥이 완전하지 않아 검사 범위를 확정하지 못했습니다.",
      requiredAction: "누락된 변경 파일의 현재 HEAD 코드가 리뷰에서 보이도록 보정 커밋을 올리거나, 해당 경로의 동작과 검증 근거를 PR 댓글에 명시해 주세요.",
      peripheral: false,
    });
  }

  const uncertainCandidateIds = new Set(
    input.verifications
      .filter((verification) => verification.verdict === "uncertain")
      .map((verification) => verification.candidateId),
  );
  const uncertainCandidates = input.candidates.filter((candidate) =>
    uncertainCandidateIds.has(candidate.candidateId)
  );
  for (const candidate of uncertainCandidates) {
    abstainItems.push({
      label: uncertainCandidateLabel(candidate, input.explicitAcceptanceCriteria),
      reason: candidate.kind === "missing_acceptance_test"
        ? "독립 검증에서 자동화 테스트의 실제 누락 여부를 확정하지 못했습니다."
        : "독립 검증에서 치명 결함 여부를 확정도 기각도 하지 못했습니다.",
      requiredAction: candidate.kind === "missing_acceptance_test"
        ? "해당 인수조건을 직접 검증하는 테스트의 파일·테스트명·assertion을 댓글로 알려 주거나, 없다면 자동화 테스트를 추가해 주세요."
        : "후보 경로가 안전함을 보여 주는 가드·호출 조건·회귀 테스트를 댓글로 제시하거나, 실제 결함이면 해당 경로를 수정해 주세요.",
      peripheral: false,
    });
  }

  for (const finding of input.unconfirmedOpenFindings) {
    abstainItems.push({
      label: unconfirmedFindingLabel(finding),
      reason: "이전에 확인된 지적이 현재 HEAD에서 유지되는지 또는 해소됐는지 재검증 근거가 충분하지 않습니다.",
      requiredAction: "직전 Seori 댓글에 해결 커밋과 검증 근거를 답글로 남기거나, 지적이 사실과 다르면 해당 스레드에 `/seori refute`와 반증 근거를 남겨 주세요.",
      peripheral: false,
    });
  }

  const fatalCheckPassed =
    input.fatalContextComplete &&
    input.pipeline.inputValid &&
    !uncertainCandidates.some((candidate) => candidate.kind === "fatal_defect") &&
    !input.unconfirmedOpenFindings.some((finding) => finding.candidate.kind === "fatal");

  return {
    coveredCriteria,
    fatalCheckPassed,
    abstainItems: uniqueAbstainItems(abstainItems),
  };
}

function coverageAbstainReason(code: string | undefined): string {
  switch (code) {
    case "acceptance_coverage_missing":
      return "현재 HEAD에서 이 인수조건을 검증하는 자동화 테스트 근거를 찾지 못했지만, 테스트 누락으로 차단할 근거까지는 확정되지 않았습니다.";
    case "acceptance_coverage_unknown":
      return "현재 HEAD에서 이 인수조건의 자동화 테스트 커버리지를 확정하지 못했습니다.";
    case "test_evidence_required":
      return "테스트로 검증됐다는 분류에 구체적인 현재 HEAD 테스트 근거가 없어 판정을 확정하지 못했습니다.";
    case "test_evidence_line_not_grounded":
      return "제시된 테스트 위치와 코드가 현재 HEAD의 실제 테스트 파일과 일치하지 않았습니다.";
    case "test_evidence_not_grounded":
      return "제시된 테스트가 이 인수조건을 실제로 검증한다고 확인하지 못했습니다.";
    case "test_evidence_missing_sim_assertion":
      return "제시된 테스트 묶음에 정산 계획의 sim 결과가 28800인지 확인하는 assertion이 없습니다.";
    case "test_evidence_missing_rollover_assertion":
      return "제시된 테스트 묶음은 sim=28800만 확인하고, 같은 계획의 rollover=0은 assertion하지 않습니다.";
    case "test_evidence_missing_ko_kr_catalog_assertion":
      return "제시된 테스트 묶음에 ko-KR 카탈로그의 신규 라벨을 확인하는 assertion이 없습니다.";
    case "test_evidence_missing_en_us_catalog_assertion":
      return "제시된 테스트 묶음에 en-US 카탈로그의 신규 라벨을 확인하는 assertion이 없습니다.";
    case "test_evidence_missing_remaining_locale_catalog_assertion":
      return "제시된 테스트 묶음에 나머지 로케일 카탈로그의 신규 라벨을 확인하는 assertion이 없습니다.";
    case "acceptance_coverage_identity_mismatch":
      return "자동 검증 결과가 이 인수조건의 ID와 원문에 정확히 대응하지 않았습니다.";
    default:
      return "현재 HEAD에서 이 인수조건의 자동화 테스트 근거를 확정하지 못했습니다.";
  }
}

function coverageRequiredAction(code: string | undefined, criterionId: string): string {
  switch (code) {
    case "acceptance_coverage_identity_mismatch":
      return `${criterionId} 원문과 정확히 대응하는 테스트 또는 소스 근거를 PR 댓글에 파일·위치와 함께 알려 주세요.`;
    case "test_evidence_line_not_grounded":
      return `${criterionId}을 검증하는 현재 HEAD의 실제 assertion 위치를 댓글로 알려 주거나 해당 테스트를 보정해 주세요.`;
    case "test_evidence_not_grounded":
      return `${criterionId} 전체를 직접 검증하는 assertion과 실행 경로를 댓글로 알려 주거나, 직접 검증하는 테스트를 추가해 주세요.`;
    case "test_evidence_missing_sim_assertion":
      return `${criterionId}의 같은 plan 결과에서 sim_seconds == 28800을 확인하는 assertion을 추가하거나 정확한 현재 위치를 알려 주세요.`;
    case "test_evidence_missing_rollover_assertion":
      return `${criterionId}의 같은 plan 결과에서 rollover_seconds == 0을 확인하는 assertion을 추가하고 supporting evidence로 함께 제시해 주세요.`;
    case "test_evidence_missing_ko_kr_catalog_assertion":
      return `${criterionId}의 ko-KR 카탈로그 라벨 assertion을 supporting evidence로 함께 제시해 주세요.`;
    case "test_evidence_missing_en_us_catalog_assertion":
      return `${criterionId}의 en-US 카탈로그 라벨 assertion을 supporting evidence로 함께 제시해 주세요.`;
    case "test_evidence_missing_remaining_locale_catalog_assertion":
      return `${criterionId}의 나머지 로케일 카탈로그 라벨 assertion 또는 전체 로케일 반복 검증을 supporting evidence로 함께 제시해 주세요.`;
    case "acceptance_coverage_missing":
    case "acceptance_coverage_unknown":
    case "test_evidence_required":
    default:
      return `${criterionId}을 직접 검증하는 테스트의 파일·테스트명·assertion을 댓글로 알려 주거나, 없다면 자동화 테스트를 추가해 주세요.`;
  }
}

function protocolAbstainReason(code: ReviewGateCandidateRejectionCode): string {
  switch (code) {
    case "candidate_limit_exceeded":
      return "검토 후보가 공개 가능한 최대 2건을 초과해 자동 판정을 확정하지 못했습니다.";
    case "candidate_ids_invalid":
      return "검토 후보의 식별자와 순서가 유효하지 않아 자동 판정을 확정하지 못했습니다.";
    case "verification_set_mismatch":
      return "검토 후보와 독립 검증 결과가 일대일로 대응하지 않아 자동 판정을 확정하지 못했습니다.";
    default:
      return "자동 검증 결과 구조가 호스트 검증 규칙을 충족하지 않아 판정을 확정하지 못했습니다.";
  }
}

function uncertainCandidateLabel(
  candidate: MiniMaxReviewCandidate,
  explicitAcceptanceCriteria: readonly string[],
): string {
  if (candidate.kind === "missing_acceptance_test") {
    const match = candidate.criterionId?.match(/^AC-([1-9]\d*)$/u);
    const criterion = match ? explicitAcceptanceCriteria[Number(match[1]) - 1] : undefined;
    if (criterion && criterion === candidate.acceptanceCriterion) {
      return `${candidate.criterionId} 테스트 누락 후보 · ${criterion}`;
    }
    return `인수조건 테스트 누락 후보 ${candidate.candidateId}`;
  }
  return `치명 결함 후보 ${candidate.candidateId} · ${candidate.titleKo}`;
}

function unconfirmedFindingLabel(finding: StoredReviewFinding): string {
  if (finding.candidate.kind === "missing_tests") {
    return `기존 테스트 누락 지적 · ${finding.candidate.acceptanceCriterion}`;
  }
  const location = [finding.candidate.file, finding.candidate.symbol].filter(Boolean).join("#");
  return location
    ? `기존 치명 결함 지적 · ${location}`
    : "기존 치명 결함 지적";
}

function uniqueAbstainItems(items: readonly ReviewGateAbstainItem[]): ReviewGateAbstainItem[] {
  const unique = new Map<string, ReviewGateAbstainItem>();
  for (const item of items) {
    unique.set(`${item.label}\u0000${item.reason}`, item);
  }
  return [...unique.values()];
}
