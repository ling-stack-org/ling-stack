import type { RunStore } from "../../run-types.js";
import type { UserInputContinuationSeed } from "../../user-input-continuation-types.js";
import { classifyWorkflowStepStartOwner, workflowStepStartOwnerMatches, type WorkflowStepStartOwnerV1,
  type WorkflowStepStartReadStore } from "../../workflow-step-start-owner.js";
import { UserInputStoreError } from "../../user-input-store-types.js";

export type UserInputWorkflowAdmissionPorts = WorkflowStepStartReadStore & Pick<RunStore,
  "acquireResourceLease" | "transitionChannelWorkflowStepStatus" | "transitionChannelWorkflowStatus" | "updateChannelWorkflowStep">;

export function prepareUserInputWorkflowAdmission(store: UserInputWorkflowAdmissionPorts, seed: UserInputContinuationSeed,
  owner: WorkflowStepStartOwnerV1, now: string): WorkflowStepStartOwnerV1 {
  const step = seed.source.workflowStepId && store.getChannelWorkflowStep(seed.source.workflowStepId);
  const classified = step && classifyWorkflowStepStartOwner(store, step, now,
    { requireActiveLease: false, allowWaitingForInput: true });
  if (!step || step.status !== "waiting_for_input" || step.runId !== seed.source.runId
    || !classified || classified.status !== "linked" || !workflowStepStartOwnerMatches(classified.owner, owner)) {
    throw new UserInputStoreError("source_conflict");
  }
  const previous = store.listResourceLeases({ resourceType: "workflow_step", resourceKey: step.id, limit: 100 })
    .find(lease => lease.id === owner.leaseId);
  if (!previous || previous.status !== "released" || previous.releaseReason !== "user_input_yielded") {
    throw new UserInputStoreError("source_conflict");
  }
  const lease = store.acquireResourceLease({ workspaceId: seed.source.workspaceId, resourceType: "workflow_step", resourceKey: step.id,
    ownerType: "workflow_step", ownerId: step.id, acquiredAt: now, expiresAt: new Date(Date.parse(now) + 6 * 60 * 60_000).toISOString() });
  if (!lease) throw new UserInputStoreError("source_conflict");
  return { ...owner, phase: "linked", leaseId: lease.id };
}

export function activateUserInputWorkflowAdmission(store: UserInputWorkflowAdmissionPorts, seed: UserInputContinuationSeed,
  owner: WorkflowStepStartOwnerV1, now: string): void {
  const step = seed.source.workflowStepId && store.getChannelWorkflowStep(seed.source.workflowStepId);
  const workflow = step && store.getChannelWorkflow(step.workflowId);
  if (!step || !workflow || step.status !== "claimed" || step.runId !== seed.successorRunId) {
    throw new UserInputStoreError("source_conflict");
  }
  if (workflow.status === "waiting_for_input" && !store.transitionChannelWorkflowStatus({ workflowId: workflow.id,
    expectedStatus: "waiting_for_input", event: "user_input_answered", actor: "system", now }).ok) {
    throw new UserInputStoreError("source_conflict");
  }
  if (!store.transitionChannelWorkflowStepStatus({ workflowStepId: step.id, expectedStatus: "claimed",
    event: "start", actor: "system", now }).ok) throw new UserInputStoreError("source_conflict");
  store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata, startOwner: owner } }, now);
}
