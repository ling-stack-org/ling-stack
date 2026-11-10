import { resolve } from "node:path";
import { isChannelIntentExecutionPlanV1 } from "@ling-stack/contracts";
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
import { listAllExecutionActionsForRun } from "../runs/execution-actions.js";
import { validateWorkflowOperationRunContext, workflowStepRequiresOperationSnapshot } from "../runs/workflow-operation-snapshot.js";
import { commandMatchesPolicy } from "./command-operation-match.js";

export function workflowStepExecutionOperationBindings(
  step: ChannelWorkflowStep,
): readonly ChannelIntentExecutionOperationV1[] {
  const plan = step.metadata?.executionPlan;
  if (!plan) return [];
  const ownedIds = new Set(step.metadata?.executionOperationIds
    ?? (workflowStepRequiresOperationSnapshot(step) ? [] : plan.operations.map((operation) => operation.id)));
  return plan.operations.filter((operation) => ownedIds.has(operation.id));
}

export function verifyWorkflowStepExecutionOperations(input: {
  readonly store: RunStore;
  readonly step: ChannelWorkflowStep;
  readonly now: string;
}): WorkflowStepExecutionVerificationV1 | undefined {
  return input.store.readSnapshot(() => verifyWorkflowStepExecutionOperationsInSnapshot(input));
}

function verifyWorkflowStepExecutionOperationsInSnapshot(input: {
  readonly store: RunStore;
  readonly step: ChannelWorkflowStep;
  readonly now: string;
}): WorkflowStepExecutionVerificationV1 | undefined {
  const storedStep = input.store.getChannelWorkflowStep(input.step.id);
  const boundRun = input.step.runId ? input.store.getRun(input.step.runId) : undefined;
  const context = boundRun ? validateWorkflowOperationRunContext({ store: input.store, run: boundRun }) : undefined;
  const requiresSnapshot = workflowStepRequiresOperationSnapshot(input.step)
    || workflowStepRequiresOperationSnapshot(storedStep)
    || (context !== undefined && context.status !== "legacy");
  const plan = input.step.metadata?.executionPlan;
  if (!plan) {
    const operationIds = input.step.metadata?.executionOperationIds ?? storedStep?.metadata?.executionOperationIds ?? [];
    if (operationIds.length === 0 && !requiresSnapshot) return undefined;
    return { status: "blocked", checkedAt: input.now, operationResults: operationIds.map((operationId) => ({
      operationId, status: "missing", evidenceActionIds: [], reasonCode: "operation_binding_plan_missing",
    })) };
  }
  const ownedOperations = workflowStepExecutionOperationBindings(input.step);
  if (requiresSnapshot) {
    const ownedIds = input.step.metadata?.executionOperationIds;
    const invalidPlan = !isChannelIntentExecutionPlanV1(plan) || plan.bindingVersion !== 1;
    const invalidOwnership = !ownedIds || new Set(ownedIds).size !== ownedIds.length
      || ownedOperations.length !== ownedIds.length
      || ownedOperations.some((operation) => operation.binding?.ownerParticipantId !== input.step.toParticipantId)
      || (boundRun !== undefined && (boundRun.teammateId !== input.step.toParticipantId || boundRun.workflowStepId !== input.step.id));
    if (invalidPlan || invalidOwnership) {
      return {
        status: "blocked", checkedAt: input.now,
        operationResults: (ownedOperations.length > 0 ? ownedOperations : plan.operations).map((operation) => ({
          operationId: operation.id, status: "missing", evidenceActionIds: [],
          reasonCode: invalidPlan ? "operation_binding_fingerprint_invalid" : "operation_binding_owner_mismatch",
        })),
      };
    }
    if (context?.status !== "ready") {
      return {
        status: "blocked", checkedAt: input.now,
        operationResults: ownedOperations.map((operation) => ({
          operationId: operation.id, status: "missing", evidenceActionIds: [],
          reasonCode: context?.status === "blocked" ? context.code : "operation_binding_snapshot_invalid",
        })),
      };
    }
    if (context.snapshot.plan.fingerprint !== plan.fingerprint
      || context.step.workflowId !== input.step.workflowId
      || JSON.stringify([...context.snapshot.ownedOperationIds].sort()) !== JSON.stringify([...ownedIds!].sort())) {
      return {
        status: "blocked", checkedAt: input.now,
        operationResults: ownedOperations.map((operation) => ({
          operationId: operation.id, status: "missing", evidenceActionIds: [], reasonCode: "operation_binding_fingerprint_mismatch",
        })),
      };
    }
  }
  if (ownedOperations.length === 0) return undefined;
  // Historical launches stay visible, but a retry cannot borrow its predecessor's receipt.
  const isCurrentHostOpen = (action: ExecutionAction): boolean => {
    if (!action.hostOpenReceipt) return true;
    const ownerRun = action.runId ? input.store.getRun(action.runId) : undefined;
    const unit = ownerRun?.workUnitId ? input.store.getWorkUnit(ownerRun.workUnitId) : undefined;
    return unit?.activeAttemptId === action.hostOpenReceipt.attemptId;
  };
  const runActions = input.step.runId
    ? listAllExecutionActionsForRun(input.store, input.step.runId).filter(isCurrentHostOpen)
    : [];
  const actions = plan.bindingVersion === 1
    ? runActions.filter((action) => action.runId === input.step.runId && action.workflowStepId === input.step.id)
    : runActions;
  const workflowSteps = input.store.listChannelWorkflowSteps({ workflowId: input.step.workflowId, complete: true });
  const workflowActions = workflowSteps
    .flatMap((step) => step.runId ? listAllExecutionActionsForRun(input.store, step.runId) : [])
    .filter(isCurrentHostOpen);
  const dependencyActions = (operation: ChannelIntentExecutionOperationV1): readonly ExecutionAction[] => {
    if (!operation.binding) return workflowActions;
    const boundSteps = workflowSteps.filter((step) => {
      if (step.toParticipantId !== operation.binding!.ownerParticipantId
        || step.metadata?.executionPlan?.fingerprint !== plan.fingerprint
        || !step.metadata?.executionOperationIds?.includes(operation.id)) return false;
      const run = step.runId ? input.store.getRun(step.runId) : undefined;
      const dependencyContext = run ? validateWorkflowOperationRunContext({ store: input.store, run }) : undefined;
      return dependencyContext?.status === "ready" && dependencyContext.snapshot.plan.fingerprint === plan.fingerprint
        && dependencyContext.snapshot.ownedOperationIds.includes(operation.id);
    });
    return workflowActions.filter((action) => boundSteps.some((step) => action.runId === step.runId && action.workflowStepId === step.id));
  };
  const cwd = input.step.runId ? input.store.getRun(input.step.runId)?.cwd : undefined;
  const actionCwd = (action: ExecutionAction): string | undefined =>
    action.runId ? input.store.getRun(action.runId)?.cwd : undefined;
  const operationResults = ownedOperations.map((operation) =>
    verifyOperation(operation, plan, actions, dependencyActions, cwd, actionCwd));
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
  resolveDependencyActions: (operation: ChannelIntentExecutionOperationV1) => readonly ExecutionAction[],
  cwd: string | undefined,
  resolveActionCwd: (action: ExecutionAction) => string | undefined,
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
      resolveDependencyActions(dependency).filter((action) =>
        actionMatchesOperation(action, dependency, dependency.binding ? resolveActionCwd(action) : cwd)
        && actionSucceededForOperation(action, dependency)));
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
  if (operation.binding && action.participantId !== operation.binding.ownerParticipantId) return false;
  const expectedActionType = operation.kind === "file_create"
    ? "write"
    : operation.kind === "file_edit"
      ? "edit"
      : operation.kind === "file_read" ? "read" : operation.kind === "open_local_target" ? "host_capability" : "bash";
  if (action.actionType !== expectedActionType) return false;
  if (operation.kind === "run_command") {
    const actualCommand = action.commandEvidence?.command;
    return operation.targetKind === "command"
      && operation.commandMatchPolicy !== undefined
      && typeof actualCommand === "string"
      && commandMatchesPolicy(actualCommand, operation.commandMatchPolicy)
      && (!operation.binding || (cwd !== undefined && action.commandEvidence?.cwd !== undefined
        && resolve(action.commandEvidence.cwd) === resolve(cwd, operation.binding.workingDirectory?.path ?? ".")));
  }
  const label = (operation.kind === "file_create" || operation.kind === "file_edit"
    ? operation.binding?.outputRefs[0]?.path : operation.binding?.inputRefs[0]?.path) ?? operation.targetRef.label?.trim();
  if (!label) return false;
  if (operation.kind === "open_local_target") {
    const expectedPath = normalizePath(label, cwd);
    return action.targetRefs.some((ref) => ref.type === "host_capability" && ref.id === "host.open_local_target")
      && action.targetRefs.some((ref) => ref.type === "file" && ref.path && normalizePath(ref.path, cwd) === expectedPath);
  }
  const expectedPath = normalizePath(label, cwd);
  return action.targetRefs.some((ref) => ref.type === "file" && ref.path && normalizePath(ref.path, cwd) === expectedPath);
}

function actionSucceededForOperation(action: ExecutionAction, operation: ChannelIntentExecutionOperationV1): boolean {
  if (action.status !== "succeeded") return false;
  if (operation.kind === "open_local_target") {
    const receipt = action.hostOpenReceipt;
    return receipt !== undefined && receipt.status === "launched" && receipt.visibility === "unverified"
      && receipt.runId === action.runId && receipt.attemptId === action.attemptId
      && receipt.toolCallId === action.toolCallId && receipt.approvalId === action.approvalId
      && receipt.path === (operation.binding?.inputRefs[0]?.path ?? operation.targetRef.label);
  }
  if (operation.kind !== "run_command") return true;
  const evidence = action.commandEvidence;
  return Boolean(evidence
    && evidence.exitCode === 0
    // Legacy UI projection may infer exit0 from isError=false. Typed operation
    // completion needs the explicit control flags supplied only by a fully
    // parsed structured command result, never that display-only inference.
    && (!operation.binding || (evidence.timedOut === false && evidence.cancelled === false))
    && evidence.timedOut !== true
    && evidence.cancelled !== true
    && !evidence.signal);
}

function operationFailureCode(
  operation: ChannelIntentExecutionOperationV1,
  actions: readonly ExecutionAction[],
): string {
  if (operation.kind === "open_local_target") return "required_host_open_missing_launch_receipt";
  if (operation.kind === "run_command") {
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
