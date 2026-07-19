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
      });
      continue;
    }
    abstainItems.push({
      label: `${criterionId} · ${criterion}`,
      reason: coverageAbstainReason(coverageErrors.get(criterionId)),
    });
  }

  if (!input.pipeline.inputValid) {
    const codes = new Set(input.pipeline.rejected.map((rejection) => rejection.code));
    if (codes.size === 0) {
      abstainItems.push({
        label: "자동 검증 결과 구조",
        reason: "검토 후보와 독립 검증 결과의 구조가 호스트 검증 규칙을 충족하지 않아 판정을 확정하지 못했습니다.",
      });
    } else {
      for (const code of codes) {
        abstainItems.push({
          label: "자동 검증 결과 구조",
          reason: protocolAbstainReason(code),
        });
      }
    }
  }

  if (!input.fatalContextComplete) {
    abstainItems.push({
      label: "치명 결함 검사",
      reason: "변경 파일의 현재 HEAD 코드 또는 패치 문맥이 완전하지 않아 검사 범위를 확정하지 못했습니다.",
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
    });
  }

  for (const finding of input.unconfirmedOpenFindings) {
    abstainItems.push({
      label: unconfirmedFindingLabel(finding),
      reason: "이전에 확인된 지적이 현재 HEAD에서 유지되는지 또는 해소됐는지 재검증 근거가 충분하지 않습니다.",
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
    case "acceptance_coverage_identity_mismatch":
      return "자동 검증 결과가 이 인수조건의 ID와 원문에 정확히 대응하지 않았습니다.";
    default:
      return "현재 HEAD에서 이 인수조건의 자동화 테스트 근거를 확정하지 못했습니다.";
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
