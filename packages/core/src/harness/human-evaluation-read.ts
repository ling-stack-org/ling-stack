import type { RunEvaluationHumanQaPageV1, RunEvaluationHumanReportRefV1, RunEvaluationHumanReportSourceResultV1 } from "@ling-stack/contracts";
export interface ListRunEvaluationHumanEnrollmentsInput {
  readonly afterEnrollmentId?: string;
  readonly limit?: number;
}
/** Dedicated trusted QA read surface. No namespace/workspace override, mutation, grade or promotion port. */
export interface RunEvaluationHumanReadStore {
  listRunEvaluationHumanEnrollments(input?: ListRunEvaluationHumanEnrollmentsInput): RunEvaluationHumanQaPageV1;
  readRunEvaluationHumanReportSource(ref: RunEvaluationHumanReportRefV1): RunEvaluationHumanReportSourceResultV1;
}
