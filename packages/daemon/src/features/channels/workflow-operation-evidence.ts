import { resolve } from "node:path";
import type {
  ChannelIntentExecutionOperationV1,
  ChannelIntentExecutionPlanV1,
} from "@ling-stack/contracts";
import type {
  ChannelWorkflowStep,
  ExecutionAction,
  RunStore,
  WorkflowStepExecutionVerificationV1,
} from "@ling-stack/core";
import { listExecutionActions } from "../runs/execution-actions.js";
import { commandMatchesPolicy } from "./command-operation-match.js";

export function workflowStepExecutionOperationBindings(
  step: ChannelWorkflowStep,
): readonly ChannelIntentExecutionOperationV1[] {
  const plan = step.metadata?.executionPlan;
  if (!plan) return [];
  const ownedIds = new Set(step.metadata?.executionOperationIds ?? plan.operations.map((operation) => operation.id));
  return plan.operations.filter((operation) => ownedIds.has(operation.id));
}

export function verifyWorkflowStepExecutionOperations(input: {
  readonly store: RunStore;
  readonly step: ChannelWorkflowStep;
  readonly now: string;
}): WorkflowStepExecutionVerificationV1 | undefined {
  const plan = input.step.metadata?.executionPlan;
  if (!plan) return undefined;
  const ownedOperations = workflowStepExecutionOperationBindings(input.step);
  if (ownedOperations.length === 0) return undefined;
  const actions = input.step.runId
    ? listExecutionActions(input.store, { runId: input.step.runId, limit: 500 })
    : [];
  const workflowActions = input.store.listChannelWorkflowSteps({ workflowId: input.step.workflowId, limit: 500 })
    .flatMap((step) => step.runId ? listExecutionActions(input.store, { runId: step.runId, limit: 500 }) : []);
  const cwd = input.step.runId ? input.store.getRun(input.step.runId)?.cwd : undefined;
  const operationResults = ownedOperations.map((operation) =>
    verifyOperation(operation, plan, actions, workflowActions, cwd));
  const requiredResultIds = new Set(ownedOperations.filter((operation) => operation.required).map((operation) => operation.id));
  const requiredResults = operationResults.filter((result) => requiredResultIds.has(result.operationId));
  return {
    status: requiredResults.some((result) => result.status === "failed")
      ? "failed"
      : requiredResults.some((result) => result.status === "missing" || result.status === "out_of_order")
        ? "blocked"
        : "verified",
    checkedAt: input.now,
    operationResults,
  };
}

function verifyOperation(
  operation: ChannelIntentExecutionOperationV1,
  plan: ChannelIntentExecutionPlanV1,
  actions: readonly ExecutionAction[],
  workflowActions: readonly ExecutionAction[],
  cwd: string | undefined,
): WorkflowStepExecutionVerificationV1["operationResults"][number] {
  const candidates = actions.filter((action) => actionMatchesOperation(action, operation, cwd));
  const successful = candidates.filter((action) => actionSucceededForOperation(action, operation));
  const evidenceActionIds = (successful.length > 0 ? successful : candidates).map((action) => action.id);
  if (successful.length === 0) {
    return candidates.length > 0
      ? { operationId: operation.id, status: "failed", evidenceActionIds, reasonCode: operationFailureCode(operation, candidates) }
      : { operationId: operation.id, status: "missing", evidenceActionIds: [], reasonCode: "required_operation_missing_evidence" };
  }
  const dependencyIds = new Set(operation.dependsOn);
  if (dependencyIds.size > 0) {
    const dependencies = plan.operations.filter((candidate) => dependencyIds.has(candidate.id));
    const dependencyActionGroups = dependencies.map((dependency) =>
      workflowActions.filter((action) => actionMatchesOperation(action, dependency, cwd) && actionSucceededForOperation(action, dependency)));
    if (dependencyActionGroups.some((group) => group.length === 0)) {
      return {
        operationId: operation.id,
        status: "out_of_order",
        evidenceActionIds,
        reasonCode: "required_operation_dependency_missing_evidence",
      };
    }
    const dependencyActions = dependencyActionGroups.flat();
    const earliestOperationCompletion = earliestCompletedAt(successful);
    const latestDependencyCompletion = latestCompletedAt(dependencyActions);
    if (earliestOperationCompletion && latestDependencyCompletion
      && earliestOperationCompletion < latestDependencyCompletion) {
      return { operationId: operation.id, status: "out_of_order", evidenceActionIds, reasonCode: "required_operation_out_of_order" };
    }
  }
  return { operationId: operation.id, status: "succeeded", evidenceActionIds };
}

function actionMatchesOperation(
  action: ExecutionAction,
  operation: ChannelIntentExecutionOperationV1,
  cwd: string | undefined,
): boolean {
  const expectedActionType = operation.kind === "file_create"
    ? "write"
    : operation.kind === "file_edit"
      ? "edit"
      : "bash";
  if (action.actionType !== expectedActionType) return false;
  if (operation.kind === "run_command") {
    const actualCommand = action.commandEvidence?.command;
    return operation.targetKind === "command"
      && operation.commandMatchPolicy !== undefined
      && typeof actualCommand === "string"
      && commandMatchesPolicy(actualCommand, operation.commandMatchPolicy);
  }
  const label = operation.targetRef.label?.trim();
  if (!label) return false;
  if (operation.kind === "open_local_target") {
    if (!action.commandEvidence) return false;
    const expectedPath = normalizePath(label, cwd);
    return action.targetRefs.some((ref) => ref.path && normalizePath(ref.path, cwd) === expectedPath);
  }
  const expectedPath = normalizePath(label, cwd);
  return action.targetRefs.some((ref) => ref.type === "file" && ref.path && normalizePath(ref.path, cwd) === expectedPath);
}

function actionSucceededForOperation(action: ExecutionAction, operation: ChannelIntentExecutionOperationV1): boolean {
  if (action.status !== "succeeded") return false;
  if (operation.kind !== "run_command" && operation.kind !== "open_local_target") return true;
  const evidence = action.commandEvidence;
  return Boolean(evidence
    && evidence.exitCode === 0
    && evidence.timedOut !== true
    && evidence.cancelled !== true
    && !evidence.signal);
}

function operationFailureCode(
  operation: ChannelIntentExecutionOperationV1,
  actions: readonly ExecutionAction[],
): string {
  if (operation.kind === "run_command" || operation.kind === "open_local_target") {
    const action = actions.find((candidate) => candidate.commandEvidence);
    const evidence = action?.commandEvidence;
    if (!evidence) return "required_command_missing_evidence";
    if (evidence.timedOut) return "required_command_timed_out";
    if (evidence.cancelled) return "required_command_cancelled";
    if (typeof evidence.exitCode === "number" && evidence.exitCode !== 0) {
      return "required_command_non_zero_exit";
    }
    if (evidence.outcome === "failed") {
      return "required_command_failed";
    }
    if (evidence.exitCode === undefined) return "required_command_missing_exit_code";
  }
  return "required_operation_failed";
}

function normalizePath(path: string, cwd: string | undefined): string {
  const normalized = resolve(cwd ?? ".", path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function actionCompletedAt(action: ExecutionAction): string {
  return action.completedAt ?? action.updatedAt ?? action.executedAt ?? action.createdAt;
}

function earliestCompletedAt(actions: readonly ExecutionAction[]): string | undefined {
  return actions.map(actionCompletedAt).sort()[0];
}

function latestCompletedAt(actions: readonly ExecutionAction[]): string | undefined {
  return actions.map(actionCompletedAt).sort().at(-1);
}
