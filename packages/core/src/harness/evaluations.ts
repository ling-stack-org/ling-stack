import { randomUUID } from "node:crypto";
import type {
  RunEvaluationFailureCode,
  RunEvaluationGradeV1,
  RunEvaluationState,
  RunEvaluationV1,
} from "@ling-stack/contracts";
import { transitionHarnessEntity, type HarnessTransitionResult } from "./common.js";
import { digestRunEvaluationValue } from "./evaluation-json.js";

const transitions: Readonly<Record<RunEvaluationState, ReadonlySet<RunEvaluationState>>> = {
  queued: new Set(["claimed", "cancelled", "failed"]),
  claimed: new Set(["grading", "queued", "cancelled", "failed"]),
  grading: new Set(["completed", "queued", "cancelled", "failed"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function transitionRunEvaluation(input: {
  readonly current: RunEvaluationV1;
  readonly expectedRevision: number;
  readonly nextState: RunEvaluationState;
  readonly now: string;
}): HarnessTransitionResult<RunEvaluationV1> {
  return transitionHarnessEntity({
    current: input.current,
    expectedRevision: input.expectedRevision,
    nextState: input.nextState,
    allowedNextStates: transitions[input.current.state],
    update: (revision, state) => ({
      ...input.current,
      state,
      revision,
      updatedAt: input.now,
      ...(["completed", "failed", "cancelled"].includes(state)
        ? {
            claimOwner: undefined,
            claimToken: undefined,
            claimExpiresAt: undefined,
            nextAttemptAt: undefined,
            completedAt: input.now,
          }
        : state === "queued"
          ? {
              claimOwner: undefined,
              claimToken: undefined,
              claimExpiresAt: undefined,
              completedAt: undefined,
            }
          : {}),
    }),
  });
}

export interface RunEvaluationIdentityInput {
  readonly rootRunId: string;
  readonly runId: string;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly suiteArtifactId: string;
  readonly suiteDigest: string;
  readonly caseId: string;
  readonly caseVersion: string;
  readonly caseArtifactId: string;
  readonly caseDigest: string;
  readonly baselineId: string;
  readonly baselineVersion: string;
  readonly baselineArtifactId: string;
  readonly baselineDigest: string;
  readonly candidateArtifactId: string;
  readonly candidateDigest: string;
}

export function runEvaluationIdempotencyKey(input: RunEvaluationIdentityInput): string {
  return `run-evaluation:${digestRunEvaluationValue(input)}`;
}

export function createRunEvaluationId(): string {
  return `run_evaluation_${randomUUID()}`;
}

export function createRunEvaluationGradeId(): string {
  return `run_evaluation_grade_${randomUUID()}`;
}

export interface EnqueueRunEvaluationInput {
  readonly id?: string;
  readonly runId: string;
  readonly rootRunId?: string;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly suiteArtifactId: string;
  readonly caseId: string;
  readonly caseVersion: string;
  readonly caseArtifactId: string;
  readonly baselineId: string;
  readonly baselineVersion: string;
  readonly baselineArtifactId: string;
  readonly candidateArtifactId: string;
  readonly now: string;
}

export interface EnqueuedRunEvaluation {
  readonly evaluation: RunEvaluationV1;
  readonly replayed: boolean;
}

export interface ListRunEvaluationsInput {
  readonly runId?: string;
  readonly rootRunId?: string;
  readonly state?: RunEvaluationState;
  readonly limit?: number;
}

export interface ListClaimableRunEvaluationsInput {
  readonly now: string;
  readonly limit?: number;
}

export interface ClaimRunEvaluationInput {
  readonly evaluationId: string;
  readonly expectedRevision: number;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly claimExpiresAt: string;
  readonly now: string;
}

export interface StartRunEvaluationInput {
  readonly evaluationId: string;
  readonly expectedRevision: number;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly now: string;
}

export interface RequeueRunEvaluationInput extends StartRunEvaluationInput {
  readonly nextAttemptAt: string;
  readonly failureCode: Extract<
    RunEvaluationFailureCode,
    "evaluation.grader_unavailable" | "evaluation.lease_expired"
  >;
}

export interface FailRunEvaluationInput extends StartRunEvaluationInput {
  readonly failureCode: RunEvaluationFailureCode;
}

export type CreateRunEvaluationGradeInput = Omit<
  RunEvaluationGradeV1,
  "schemaVersion" | "id" | "evaluationId" | "gradeDigest" | "createdAt"
> & { readonly id?: string };

export interface CompleteRunEvaluationInput extends StartRunEvaluationInput {
  readonly grade: CreateRunEvaluationGradeInput;
}

export interface AppendRunEvaluationGradeInput {
  readonly evaluationId: string;
  readonly grade: CreateRunEvaluationGradeInput;
  readonly now: string;
}

export type RunEvaluationMutationCode =
  | "not_found"
  | "stale_revision"
  | "invalid_transition"
  | "lease_not_claimable"
  | "lease_mismatch"
  | "grade_conflict"
  | "evaluation.lineage_invalid"
  | "evaluation.artifact_invalid";

export type RunEvaluationMutationResult =
  | { readonly ok: true; readonly value: RunEvaluationV1; readonly replayed: boolean }
  | { readonly ok: false; readonly code: RunEvaluationMutationCode };

export type CompleteRunEvaluationResult =
  | {
      readonly ok: true;
      readonly evaluation: RunEvaluationV1;
      readonly grade: RunEvaluationGradeV1;
      readonly replayed: boolean;
    }
  | { readonly ok: false; readonly code: RunEvaluationMutationCode };

export type AppendRunEvaluationGradeResult =
  | { readonly ok: true; readonly grade: RunEvaluationGradeV1; readonly replayed: boolean }
  | { readonly ok: false; readonly code: RunEvaluationMutationCode };

export function digestRunEvaluationGrade(
  evaluationId: string,
  grade: CreateRunEvaluationGradeInput,
): string {
  return digestRunEvaluationValue({
    evaluationId,
    graderType: grade.graderType,
    graderId: grade.graderId,
    graderVersion: grade.graderVersion,
    verdict: grade.verdict,
    score: grade.score ?? null,
    severity: grade.severity ?? null,
    rationaleArtifactId: grade.rationaleArtifactId ?? null,
    rawOutputArtifactId: grade.rawOutputArtifactId ?? null,
    costInputTokens: grade.costInputTokens ?? null,
    costOutputTokens: grade.costOutputTokens ?? null,
    costAmountMicros: grade.costAmountMicros ?? null,
    latencyMs: grade.latencyMs ?? null,
    adjudicationStatus: grade.adjudicationStatus ?? null,
  });
}
