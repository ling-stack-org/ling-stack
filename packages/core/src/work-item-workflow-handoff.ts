import { createHash } from "node:crypto";
import type { LingAppServerStageHandoffReturnReason } from "@ling-stack/contracts";
import type { RunStore } from "./run-types.js";
import { listWorkItemCollaboration, readWorkItemCollaborationRecord, type WorkItemCollaborationRecord } from "./work-item-collaboration.js";
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
  return stageHandoffReceipt(record, previousHandoffId);
}

function stageHandoffReceipt(record: WorkItemCollaborationRecord | undefined, previousHandoffId?: string) {
  if (record?.kind !== "handoff" || (record.action !== "accepted" && record.action !== "returned")
    || record.parentRecordId !== previousHandoffId || previousHandoffId && record.action !== "accepted"
    || !record.payload || typeof record.payload !== "object") return undefined;
  return { record, decision: record.payload as WorkflowStageHandoffDecision };
}

type WorkflowStageHandoffStore = Pick<RunStore, "getWorkItemEvidence" | "listWorkItemEvidence">;

export function readWorkflowStageHandoff(
  store: WorkflowStageHandoffStore, subject: WorkflowStageHandoffSubject,
) {
  const original = readWorkflowStageHandoffReceipt(store, subject);
  if (original) {
    return original.record.action === "returned"
      ? readWorkflowStageHandoffReceipt(store, subject, original.record.id) ?? original : original;
  }

  // A return holds the accepted Plan edge until a linked repair is accepted.
  // An acceptance only applies to the specific source revision it validated.
  let latest: ReturnType<typeof stageHandoffReceipt>;
  let latestSourceRevision: string | undefined;
  let afterRevision = 0;
  for (;;) {
    const page = listWorkItemCollaboration(store, {
      workItemId: subject.workItemId, kind: "handoff", recordIdPrefix: WORKFLOW_STAGE_HANDOFF_ID_PREFIX, afterRevision, limit: 500,
    });
    for (const record of page.records) {
      const sourceRevision = record.sourceRefs.find(ref => ref.type === "workflow_step" && ref.id === subject.sourceStepId)?.revision;
      if (!sourceRevision || record.id !== workflowStageHandoffId({ ...subject, sourceRevision }, record.parentRecordId)) continue;
      const receipt = stageHandoffReceipt(record, record.parentRecordId);
      if (receipt) {
        latest = receipt;
        latestSourceRevision = sourceRevision;
      }
    }
    if (page.nextAfterRevision === afterRevision) break;
    afterRevision = page.nextAfterRevision;
  }
  return latest?.record.action === "returned" || latestSourceRevision === subject.sourceRevision ? latest : undefined;
}

export function stageHandoffAdmitsTarget(
  store: WorkflowStageHandoffStore, subject: WorkflowStageHandoffSubject,
  source: ChannelWorkflowStep, target: ChannelWorkflowStep,
): boolean {
  const handoff = readWorkflowStageHandoff(store, subject);
  return handoff?.record.action === "accepted" && handoff.decision.recipientId === target.toParticipantId
    && source.status === "succeeded" && Boolean(source.metadata?.outputArtifactId)
    && handoff.decision.sourceArtifactId === source.metadata?.outputArtifactId && handoff.decision.sourceRunId === source.runId;
}
