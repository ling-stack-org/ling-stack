import type {
  DelegationMessageV1,
  DelegationStepV1,
  HarnessToolExecutionV1,
  RunEvaluationGradeV1,
  RunEvaluationV1,
  RunnerContinuationV1,
} from "@ling-stack/contracts";
import type {
  ClaimRunnerContinuationInput,
  FinishRunnerContinuationInput,
  ListClaimableRunnerContinuationsInput,
  PrepareContinuationInput,
  PreparedContinuation,
  RunnerContinuationMutationResult,
  StartRunnerContinuationInput,
} from "./continuations.js";

export interface RunnerContinuationStore {
  getRunnerContinuation(id: string): RunnerContinuationV1 | undefined;
  findRunnerContinuationByIdempotencyKey(idempotencyKey: string): RunnerContinuationV1 | undefined;
  listClaimableRunnerContinuations(input: ListClaimableRunnerContinuationsInput): readonly RunnerContinuationV1[];
  prepareContinuationAndAttempt(input: PrepareContinuationInput): PreparedContinuation;
  claimRunnerContinuation(input: ClaimRunnerContinuationInput): RunnerContinuationMutationResult;
  startRunnerContinuation(input: StartRunnerContinuationInput): RunnerContinuationMutationResult;
  finishRunnerContinuation(input: FinishRunnerContinuationInput): RunnerContinuationMutationResult;
}

export interface HarnessToolExecutionStore {
  getHarnessToolExecution(id: string): HarnessToolExecutionV1 | undefined;
  findHarnessToolExecution(attemptId: string, toolCallId: string): HarnessToolExecutionV1 | undefined;
}

export interface RunEvaluationStore {
  getRunEvaluation(id: string): RunEvaluationV1 | undefined;
  listRunEvaluationGrades(evaluationId: string): readonly RunEvaluationGradeV1[];
}

export interface DelegationStore {
  getDelegationStep(id: string): DelegationStepV1 | undefined;
  listDelegationChildren(parentDelegationStepId: string): readonly DelegationStepV1[];
  listDelegationMessages(delegationStepId: string): readonly DelegationMessageV1[];
}
