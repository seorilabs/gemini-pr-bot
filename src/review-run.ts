export type ReviewGateVerdict = "PASS" | "FAIL" | "FOLLOW_UP" | "ABSTAIN";

export type ReviewRunRecord = {
  repoFullName: string;
  prNumber: number;
  headSha: string;
  checkRunId: number | null;
  provider: string;
  model: string;
  promptVersion: string;
  promptSha256: string;
  contextSha256: string;
  rawOutput: string;
  parseValid: boolean;
  verdict: ReviewGateVerdict;
  validationErrors: string[];
};
