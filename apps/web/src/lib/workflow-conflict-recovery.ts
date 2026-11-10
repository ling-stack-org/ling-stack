import { parseWorkflowConflictRecoveryRequest, type WorkflowConflictRecoveryRequest, type WorkflowConflictRecoveryResponse } from "@ling-stack/contracts";
import type { ChannelWorkflow } from "../types.js";

export function workflowConflictRecoveryRequest(response: WorkflowConflictRecoveryResponse, workflow: ChannelWorkflow,
  expected: Pick<WorkflowConflictRecoveryRequest, "roundId" | "generation" | "expectedRevision">,
  original?: WorkflowConflictRecoveryRequest): WorkflowConflictRecoveryRequest {
  const recovery = response?.recovery;
  if (recovery?.schemaVersion !== 1 || recovery.predecessor?.workflowId !== workflow.id
    || recovery.predecessor.roundId !== expected.roundId || recovery.predecessor.generation !== expected.generation
    || recovery.predecessor.revision !== expected.expectedRevision
    || !["planning", "ready"].includes(response.phase) || response.executionProfile !== "pi_host_isolated_files_v1"
    || response.mode !== "candidate_only" || response.requiresExplicitOrchestration !== true
    || !Number.isSafeInteger(recovery.sequence) || recovery.sequence < 1 || recovery.sequence > 128
    || !recovery.successor?.workflowId || recovery.successor.workflowId === workflow.id || !recovery.successor.roundId
    || recovery.successor.generation !== 1 || response.workflow?.id !== recovery.successor.workflowId
    || response.workflow.channelId !== workflow.channelId || response.workflow.workspaceId !== workflow.workspaceId
    || !response.workflow.metadata?.sourceTurnId || !response.workflow.metadata.sourceMessageId
    || !Array.isArray(response.workflowSteps) || response.workflowSteps.length < 2 || response.workflowSteps.length > 128
    || response.workflowSteps.some(step => step.workflowId !== response.workflow.id || step.workspaceId !== workflow.workspaceId || step.channelId !== workflow.channelId)) {
    throw new Error("workflow_recovery.response_unverified");
  }
  const request = parseWorkflowConflictRecoveryRequest({ roundId: recovery.predecessor.roundId, generation: recovery.predecessor.generation,
    expectedRevision: recovery.predecessor.revision, idempotencyKey: recovery.idempotencyKey, repairInstruction: recovery.repairInstruction });
  if (original && Object.keys(request).some(key => request[key as keyof typeof request] !== original[key as keyof typeof original])) {
    throw new Error("workflow_recovery.request_mismatch");
  }
  return request;
}

export function validWorkflowRepairInstruction(value: string): boolean {
  return Boolean(value.trim()) && value.length <= 4000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

export function canRetryWorkflowConflictRecoveryPlanning(phase: string | undefined, response?: WorkflowConflictRecoveryResponse): boolean {
  if (phase !== "retry" && phase !== "planning") return false;
  if (!response) return phase === "retry";
  return response.phase === "planning" && response.workflow.status === "ready"
    && response.workflowSteps.every(step => step.status === "queued" && !step.runId && !step.taskId);
}
