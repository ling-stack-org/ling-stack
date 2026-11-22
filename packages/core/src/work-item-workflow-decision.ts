import { createHash } from "node:crypto";
import type { RunStore } from "./run-types.js";
import { readWorkItemCollaborationRecord } from "./work-item-collaboration.js";

export interface WorkItemWorkflowDecisionSubject {
  readonly workItemId: string;
  readonly planRevision: string;
  readonly workflowStepId: string;
}

export function workItemWorkflowDecisionId(subject: WorkItemWorkflowDecisionSubject, kind: "round" | "resolution"): string {
  const digest = createHash("sha256").update(JSON.stringify([subject.workItemId, subject.planRevision, subject.workflowStepId])).digest("hex");
  return `work_item_workflow_decision_${kind}_${digest}`;
}

export function readSelectedWorkflowDecision(
  store: Pick<RunStore, "getWorkItemEvidence">,
  subject: WorkItemWorkflowDecisionSubject,
): { readonly id: string; readonly option: string } | undefined {
  const id = workItemWorkflowDecisionId(subject, "resolution");
  const receipt = readWorkItemCollaborationRecord(store, subject.workItemId, id);
  if (receipt?.kind !== "deliberation" || receipt.action !== "decided"
    || receipt.parentRecordId !== workItemWorkflowDecisionId(subject, "round")) return undefined;
  const decision = receipt.payload as { readonly disposition?: string; readonly option?: unknown } | null;
  if (decision?.disposition === "selected" && typeof decision.option === "string") return { id, option: decision.option };
  return undefined;
}
