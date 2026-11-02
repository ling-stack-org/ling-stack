import { createWorkflowPreGateExecutionPermit, type ApprovalRequest, type Channel, type ChannelWorkflowStep,
  type ChannelWorkflowStepStartMode, type RunStore, type WorkflowPreGateExecutionPermitV1,
  type WorkflowPreGateInspection, type WorkflowStepPreApprovalResult } from "@ling-stack/core";

export type WorkflowPreApprovalPreparation =
  | { readonly kind: "continue" }
  | { readonly kind: "waiting_for_approval"; readonly workflowId: string; readonly approval: ApprovalRequest }
  | { readonly kind: "blocked"; readonly workflowId: string; readonly blocker: string }
  | { readonly kind: "error"; readonly statusCode: 409; readonly code: string; readonly message: string };

/** A gate approves the stored definition, not a different per-start execution request. */
export function workflowPreApprovalStartOverrideError(step: ChannelWorkflowStep, channel: Channel,
  input: { readonly taskTitle?: string; readonly taskPrompt?: string; readonly providerPresetId?: string; readonly runnerId?: string;
    readonly assigneeTeammateId?: string },
  inspection: WorkflowPreGateInspection): Extract<WorkflowPreApprovalPreparation, { readonly kind: "error" }> | undefined {
  if (inspection.status === "not_required" || inspection.status === "stale") return undefined;
  const providerPresetId = step.metadata?.providerBinding?.providerPresetId
    ?? step.metadata?.providerPresetId ?? channel.defaultProviderPresetId;
  // No stored requestedRunnerId means implicit routing. An explicit request has
  // different fallback semantics even if today's default resolves to that id.
  const expected = { taskTitle: step.title, taskPrompt: step.prompt, providerPresetId,
    runnerId: step.metadata?.requestedRunnerId, assigneeTeammateId: step.toParticipantId };
  const changed = (Object.keys(expected) as (keyof typeof expected)[])
    .filter(key => input[key] !== undefined && input[key] !== expected[key]);
  if (changed.length === 0) return undefined;
  return { kind: "error", statusCode: 409, code: "workflow_pre_approval_override_forbidden",
    message: `A gated start cannot override its stored definition (${changed.join(", ")}). Update the workflow definition and request a new approval.` };
}

export function createWorkflowPreApprovalExecutionPermit(step: ChannelWorkflowStep, channel: Channel,
  input: { readonly mode: ChannelWorkflowStepStartMode; readonly taskTitle?: string; readonly taskPrompt?: string;
    readonly providerPresetId?: string; readonly runnerId?: string; readonly assigneeTeammateId?: string;
    readonly skipProviderPreflight?: boolean }): WorkflowPreGateExecutionPermitV1 {
  return createWorkflowPreGateExecutionPermit({
    mode: input.mode,
    taskTitle: input.taskTitle ?? step.title,
    taskPrompt: input.taskPrompt ?? step.prompt,
    providerPresetId: step.metadata?.providerBinding?.providerPresetId
      ?? input.providerPresetId ?? step.metadata?.providerPresetId ?? channel.defaultProviderPresetId,
    runnerId: input.runnerId ?? step.metadata?.requestedRunnerId,
    assigneeTeammateId: input.assigneeTeammateId ?? step.toParticipantId,
    skipProviderPreflight: input.skipProviderPreflight ?? false,
  });
}

/** Shared prepare boundary: no lease, context building, Task preparation or Runner work before this result. */
export function prepareWorkflowPreApproval(store: RunStore, step: ChannelWorkflowStep,
  executionPermit: WorkflowPreGateExecutionPermitV1, now: string): WorkflowPreApprovalPreparation {
  const result = store.requestChannelWorkflowStepPreApproval({ workflowStepId: step.id,
    expected: { status: step.status, taskId: step.taskId, runId: step.runId, updatedAt: step.updatedAt }, executionPermit, now });
  return workflowPreApprovalPreparation(step, result);
}

function workflowPreApprovalPreparation(step: ChannelWorkflowStep,
  result: WorkflowStepPreApprovalResult): WorkflowPreApprovalPreparation {
  if (result.status === "not_required" || result.status === "approved") return { kind: "continue" };
  if (result.status === "requested" || result.status === "duplicate") {
    return { kind: "waiting_for_approval", workflowId: step.workflowId, approval: result.approval };
  }
  if (result.status === "blocked") return { kind: "blocked", workflowId: step.workflowId, blocker: result.blocker };
  return { kind: "error", statusCode: 409, code: result.code,
    message: "Workflow pre-approval is stale or cannot admit this start. Refresh the workflow and explicitly retry the current definition." };
}
