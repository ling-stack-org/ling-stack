import { resolve } from "node:path";
import {
  isChannelIntentExecutionPlanV1,
  isDelegatedStepRequirementV1,
  type ChannelIntentExecutionOperationV1,
  type ChannelIntentExecutionPlanV1,
} from "@ling-stack/contracts";
import type { ChannelWorkflowStep, RunSession, RunStore } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { isRecord } from "../../shared/validation.js";

/** Host-owned dispatch basis. Never parsed from an external Run request. */
export interface WorkflowOperationExecutionSnapshot {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly participantId: string;
  readonly plan: ChannelIntentExecutionPlanV1;
  readonly ownedOperationIds: readonly string[];
}

export interface WorkflowOperationBlock {
  readonly status: "blocked";
  readonly code: string;
  readonly reason: string;
}

export type WorkflowOperationRunContext =
  | { readonly status: "legacy" }
  | WorkflowOperationBlock
  | {
      readonly status: "ready";
      readonly snapshot: WorkflowOperationExecutionSnapshot;
      readonly step: ChannelWorkflowStep;
      readonly run: RunSession;
      readonly ownedOperations: readonly ChannelIntentExecutionOperationV1[];
    };

type ContextStore = Pick<RunStore, "getRun" | "getChannelWorkflowStep">;

/** Broken typed metadata must never silently become a legacy/all-operations plan. */
export function workflowStepRequiresOperationSnapshot(step: ChannelWorkflowStep | undefined): boolean {
  const plan = step?.metadata?.executionPlan;
  return Boolean(
    step?.metadata?.delegatedRequirement?.executionPlanFingerprint !== undefined
    || plan?.bindingVersion !== undefined
    || plan?.operations.some((operation) => operation.binding !== undefined || operation.kind === "file_read")
    || (!plan && step?.metadata?.executionOperationIds?.length),
  );
}

export function createWorkflowOperationExecutionSnapshot(
  step: ChannelWorkflowStep,
): WorkflowOperationExecutionSnapshot | undefined {
  if (!workflowStepRequiresOperationSnapshot(step)) return undefined;
  const plan = step.metadata?.executionPlan;
  const ids = step.metadata?.executionOperationIds;
  const requirement = step.metadata?.delegatedRequirement;
  if (!isChannelIntentExecutionPlanV1(plan) || plan.bindingVersion !== 1
    || !ids || new Set(ids).size !== ids.length
    || ids.some((id) => !plan.operations.some((operation) => operation.id === id
      && operation.binding?.ownerParticipantId === step.toParticipantId))
    || !isDelegatedStepRequirementV1(requirement)
    || requirement.executionPlanFingerprint !== plan.fingerprint
    || requirement.workflowId !== step.workflowId || requirement.workflowStepId !== step.id
    || requirement.participantId !== step.toParticipantId
    || !sameIds(requirement.requiredOperationIds, ids)) {
    throw new HttpError(409, "operation_binding_snapshot_invalid", "Typed workflow dispatch basis is missing, invalid, or owned by another participant.");
  }
  return structuredClone({
    schemaVersion: 1,
    workflowId: step.workflowId,
    workflowStepId: step.id,
    participantId: step.toParticipantId,
    plan,
    ownedOperationIds: [...ids].sort(),
  });
}

/** Read-only and shared by the pre-effect gate and post-effect evidence checks. */
export function validateWorkflowOperationRunContext(input: {
  readonly store: ContextStore;
  readonly run: RunSession;
}): WorkflowOperationRunContext {
  const currentRun = input.store.getRun(input.run.id);
  const request = isRecord(input.run.requestSnapshot) ? input.run.requestSnapshot : {};
  const storedRequest = isRecord(currentRun?.requestSnapshot) ? currentRun.requestSnapshot : {};
  const step = input.run.workflowStepId ? input.store.getChannelWorkflowStep(input.run.workflowStepId) : undefined;
  const storedStep = currentRun?.workflowStepId ? input.store.getChannelWorkflowStep(currentRun.workflowStepId) : undefined;
  const raw = request.workflowOperationExecution;
  const requirement = request.delegatedRequirement;
  const required = hasTypedRunBasis(request) || hasTypedRunBasis(storedRequest)
    || workflowStepRequiresOperationSnapshot(step) || workflowStepRequiresOperationSnapshot(storedStep);
  if (!required) return { status: "legacy" };
  if (!step || !isSnapshot(raw)) return block("operation_binding_snapshot_invalid", "The immutable typed execution snapshot or workflow step is missing.");
  if (!currentRun || currentRun.workflowStepId !== input.run.workflowStepId
    || currentRun.teammateId !== input.run.teammateId || resolve(currentRun.cwd) !== resolve(input.run.cwd)
    || !isRecord(currentRun.requestSnapshot)
    || JSON.stringify(currentRun.requestSnapshot.workflowOperationExecution) !== JSON.stringify(raw)
    || JSON.stringify(currentRun.requestSnapshot.delegatedRequirement) !== JSON.stringify(requirement)) {
    return block("operation_binding_run_changed", "The persisted Run no longer matches its immutable execution basis.");
  }
  if (raw.workflowId !== step.workflowId || raw.workflowStepId !== step.id
    || step.runId !== currentRun.id || currentRun.workflowStepId !== step.id
    || raw.participantId !== step.toParticipantId || currentRun.teammateId !== raw.participantId) {
    return block("operation_binding_owner_mismatch", "Run, workflow step and participant ownership do not agree.");
  }
  let expected: WorkflowOperationExecutionSnapshot | undefined;
  try {
    expected = createWorkflowOperationExecutionSnapshot(step);
  } catch {
    return block("operation_binding_snapshot_invalid", "The current workflow execution basis is invalid.");
  }
  if (!expected || expected.plan.fingerprint !== raw.plan.fingerprint
    || !sameIds(expected.ownedOperationIds, raw.ownedOperationIds)
    || !isDelegatedStepRequirementV1(requirement)
    || requirement.fingerprint !== step.metadata?.delegatedRequirement?.fingerprint
    || requirement.executionPlanFingerprint !== raw.plan.fingerprint) {
    return block("operation_binding_fingerprint_mismatch", "The accepted plan, owned operations or delegated requirement changed after Run creation.");
  }
  return {
    status: "ready", snapshot: raw, step, run: currentRun,
    ownedOperations: raw.plan.operations.filter((operation) => raw.ownedOperationIds.includes(operation.id)),
  };
}

function hasTypedRunBasis(request: Record<string, unknown>): boolean {
  return request.workflowOperationExecution !== undefined
    || (isRecord(request.delegatedRequirement) && request.delegatedRequirement.executionPlanFingerprint !== undefined)
    || (Array.isArray(request.executionOperationBindings)
      && request.executionOperationBindings.some((operation) => isRecord(operation) && operation.binding !== undefined));
}

function isSnapshot(value: unknown): value is WorkflowOperationExecutionSnapshot {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "schemaVersion", "workflowId", "workflowStepId", "participantId", "plan", "ownedOperationIds",
  ].includes(key)) || value.schemaVersion !== 1
    || ![value.workflowId, value.workflowStepId, value.participantId].every((entry) => typeof entry === "string" && entry.length > 0)
    || !isChannelIntentExecutionPlanV1(value.plan) || value.plan.bindingVersion !== 1
    || !Array.isArray(value.ownedOperationIds)
    || !value.ownedOperationIds.every((id) => typeof id === "string")
    || new Set(value.ownedOperationIds).size !== value.ownedOperationIds.length) return false;
  const plan = value.plan;
  return value.ownedOperationIds.every((id) => plan.operations.some((operation) =>
    operation.id === id && operation.binding?.ownerParticipantId === value.participantId));
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function block(code: string, reason: string): WorkflowOperationBlock {
  return { status: "blocked", code, reason };
}
