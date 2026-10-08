import type {
  AppendRunEvaluationGradeInput,
  AppendRunEvaluationGradeResult,
  ClaimRunEvaluationInput,
  CompleteRunEvaluationInput,
  CompleteRunEvaluationResult,
  EnqueuedRunEvaluation,
  EnqueueRunEvaluationInput,
  FailRunEvaluationInput,
  ListClaimableRunEvaluationsInput,
  ListRunEvaluationsInput,
  RequeueRunEvaluationInput,
  RunEvaluationMutationResult,
  StartRunEvaluationInput,
} from "./evaluations.js";
import type {
  DelegationMessageV1,
  DelegationStepV1,
  HarnessToolExecutionV1,
  RunEvaluationGradeV1,
  RunEvaluationV1,
  RunnerContinuationV1,
} from "@ling-stack/contracts";
import type {
  ClaimHarnessToolExecutionInput,
  FailApprovedHarnessToolExecutionInput,
  FinishHarnessToolExecutionInput,
  HarnessToolExecutionMutationResult,
  PrepareHarnessToolExecutionInput,
  PreparedHarnessToolExecution,
  ReconcileAbandonedHarnessToolExecutionsInput,
  ResolveHarnessToolApprovalInput,
  StartHarnessToolExecutionInput,
} from "./tool-executions.js";
import type {
  ClaimRunnerContinuationInput,
  CommitExistingRunContinuationPreparationFailureInput,
  CommitExistingRunContinuationPreparationFailureResult,
  DeferRunnerContinuationInput,
  FinishRunnerContinuationInput,
  ListClaimableRunnerContinuationsInput,
  PrepareContinuationInput,
  PreparedContinuation,
  ReprepareContinuationInput,
  RunnerContinuationMutationResult,
  StartRunnerContinuationInput,
} from "./continuations.js";

export interface RunnerContinuationStore {
  getRunnerContinuation(id: string): RunnerContinuationV1 | undefined;
  findRunnerContinuationByIdempotencyKey(idempotencyKey: string): RunnerContinuationV1 | undefined;
  listClaimableRunnerContinuations(input: ListClaimableRunnerContinuationsInput): readonly RunnerContinuationV1[];
  prepareContinuationAndAttempt(input: PrepareContinuationInput): PreparedContinuation;
  commitExistingRunContinuationPreparationFailure(
    input: CommitExistingRunContinuationPreparationFailureInput,
  ): CommitExistingRunContinuationPreparationFailureResult;
  reprepareContinuationAndAttempt(input: ReprepareContinuationInput): PreparedContinuation;
  deferRunnerContinuation(input: DeferRunnerContinuationInput): RunnerContinuationMutationResult;
  claimRunnerContinuation(input: ClaimRunnerContinuationInput): RunnerContinuationMutationResult;
  startRunnerContinuation(input: StartRunnerContinuationInput): RunnerContinuationMutationResult;
  finishRunnerContinuation(input: FinishRunnerContinuationInput): RunnerContinuationMutationResult;
}

export interface HarnessToolExecutionStore {
  getHarnessToolExecution(id: string): HarnessToolExecutionV1 | undefined;
  findHarnessToolExecution(attemptId: string, toolCallId: string): HarnessToolExecutionV1 | undefined;
  listHarnessToolExecutions(runId: string): readonly HarnessToolExecutionV1[];
  prepareHarnessToolExecution(input: PrepareHarnessToolExecutionInput): PreparedHarnessToolExecution;
  resolveHarnessToolApproval(input: ResolveHarnessToolApprovalInput): HarnessToolExecutionMutationResult;
  claimHarnessToolExecution(input: ClaimHarnessToolExecutionInput): HarnessToolExecutionMutationResult;
  startHarnessToolExecution(input: StartHarnessToolExecutionInput): HarnessToolExecutionMutationResult;
  finishHarnessToolExecution(input: FinishHarnessToolExecutionInput): HarnessToolExecutionMutationResult;
  failApprovedHarnessToolExecution(input: FailApprovedHarnessToolExecutionInput): HarnessToolExecutionMutationResult;
  reconcileAbandonedHarnessToolExecutions(
    input: ReconcileAbandonedHarnessToolExecutionsInput,
  ): readonly HarnessToolExecutionV1[];
}

export interface RunEvaluationStore {
  getRunEvaluation(id: string): RunEvaluationV1 | undefined;
  getRunEvaluationGrade(id: string): RunEvaluationGradeV1 | undefined;
  findRunEvaluationByIdempotencyKey(idempotencyKey: string): RunEvaluationV1 | undefined;
  listRunEvaluations(input?: ListRunEvaluationsInput): readonly RunEvaluationV1[];
  listClaimableRunEvaluations(input: ListClaimableRunEvaluationsInput): readonly RunEvaluationV1[];
  listRunEvaluationGrades(evaluationId: string): readonly RunEvaluationGradeV1[];
  enqueueRunEvaluation(input: EnqueueRunEvaluationInput): EnqueuedRunEvaluation;
  claimRunEvaluation(input: ClaimRunEvaluationInput): RunEvaluationMutationResult;
  startRunEvaluation(input: StartRunEvaluationInput): RunEvaluationMutationResult;
  requeueRunEvaluation(input: RequeueRunEvaluationInput): RunEvaluationMutationResult;
  failRunEvaluation(input: FailRunEvaluationInput): RunEvaluationMutationResult;
  completeRunEvaluation(input: CompleteRunEvaluationInput): CompleteRunEvaluationResult;
  appendRunEvaluationGrade(input: AppendRunEvaluationGradeInput): AppendRunEvaluationGradeResult;
}

export interface DelegationStore {
  getDelegationStep(id: string): DelegationStepV1 | undefined;
  listDelegationChildren(parentDelegationStepId: string): readonly DelegationStepV1[];
  listDelegationMessages(delegationStepId: string): readonly DelegationMessageV1[];
}
