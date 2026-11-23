import { createHash } from "node:crypto";
import type { LingAppServerStageHandoffReturnReason } from "@ling-stack/contracts";
import type { RunStore } from "./run-types.js";
import { readWorkItemCollaborationRecord } from "./work-item-collaboration.js";
import type { ChannelWorkflowStep } from "./workspace-types.js";

export const WORKFLOW_STAGE_HANDOFF_ID_PREFIX = "work_item_stage_handoff_";

export interface WorkflowStageHandoffSubject {
  readonly workItemId: string;
  readonly planRevision: string;
  readonly sourceStepId: string;
  readonly sourceRevision: string;
  readonly targetStepId: string;
}

export interface WorkflowStageHandoffDecision {
  readonly recipientId: string;
  readonly targetRevision: string;
  readonly sourceArtifactId?: string;
  readonly sourceRunId?: string;
  readonly candidateDigest?: string;
  readonly verification?: { readonly operationId: string; readonly checkId: string };
  readonly reason?: LingAppServerStageHandoffReturnReason;
  readonly detail?: string;
}

export function workflowStageHandoffId(subject: WorkflowStageHandoffSubject, previousHandoffId?: string): string {
  const identity = [subject.workItemId, subject.planRevision, subject.sourceStepId, subject.sourceRevision, subject.targetStepId];
  if (previousHandoffId) identity.push(previousHandoffId);
  return WORKFLOW_STAGE_HANDOFF_ID_PREFIX + createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function readWorkflowStageHandoffReceipt(
  store: Pick<RunStore, "getWorkItemEvidence">, subject: WorkflowStageHandoffSubject, previousHandoffId?: string,
) {
  const record = readWorkItemCollaborationRecord(store, subject.workItemId, workflowStageHandoffId(subject, previousHandoffId));
  if (record?.kind !== "handoff" || (record.action !== "accepted" && record.action !== "returned")
    || previousHandoffId && (record.parentRecordId !== previousHandoffId || record.action !== "accepted")
    || !record.payload || typeof record.payload !== "object") return undefined;
  return { record, decision: record.payload as WorkflowStageHandoffDecision };
}

export function readWorkflowStageHandoff(
  store: Pick<RunStore, "getWorkItemEvidence">, subject: WorkflowStageHandoffSubject,
) {
  const original = readWorkflowStageHandoffReceipt(store, subject);
  return original?.record.action === "returned"
    ? readWorkflowStageHandoffReceipt(store, subject, original.record.id) ?? original : original;
}

export function stageHandoffAdmitsTarget(
  store: Pick<RunStore, "getWorkItemEvidence">, subject: WorkflowStageHandoffSubject,
  source: ChannelWorkflowStep, target: ChannelWorkflowStep,
): boolean {
  const handoff = readWorkflowStageHandoff(store, subject);
  return handoff?.record.action === "accepted" && handoff.decision.recipientId === target.toParticipantId
    && source.status === "succeeded" && Boolean(source.metadata?.outputArtifactId)
    && handoff.decision.sourceArtifactId === source.metadata?.outputArtifactId && handoff.decision.sourceRunId === source.runId;
}
