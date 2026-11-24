import { randomUUID } from "node:crypto";
import type { AppendControlPlaneEventInput, ControlPlaneEvent } from "./run-types.js";

export type WorkItemEvidenceKind =
  | "observation"
  | "proposal"
  | "challenge"
  | "evidence_ref"
  | "correction"
  | "recommendation"
  | "decision_ref"
  | "stage_recovery_ref";

export type WorkItemEvidenceVisibility = "work_item" | "participants" | "owner";

export interface WorkItemEvidenceSourceRef {
  readonly type: string;
  readonly id: string;
  readonly revision?: string;
  readonly digest?: string;
}

export interface WorkItemEvidenceEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly workItemId: string;
  readonly revision: number;
  readonly sequence: number;
  readonly subjectRevision: string;
  readonly kind: WorkItemEvidenceKind;
  readonly actorId: string;
  readonly content: string;
  readonly optionId?: string;
  readonly sourceRefs: readonly WorkItemEvidenceSourceRef[];
  readonly visibility: WorkItemEvidenceVisibility;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AppendWorkItemEvidenceInput {
  readonly id?: string;
  readonly workItemId: string;
  readonly expectedWorkItemRevision?: number;
  readonly expectedEvidenceRevision?: number;
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly subjectRevision: string;
  readonly kind: WorkItemEvidenceKind;
  readonly content: string;
  readonly optionId?: string;
  readonly sourceRefs?: readonly WorkItemEvidenceSourceRef[];
  readonly visibility?: WorkItemEvidenceVisibility;
  /** Host-owned authorization check while the evidence write transaction is held. */
  readonly assertCurrent?: () => void;
}

export interface AppendWorkItemEvidenceResult {
  readonly status: "appended" | "replayed";
  readonly entry: WorkItemEvidenceEntry;
  readonly workItemRevision: number;
  readonly event?: ControlPlaneEvent;
}

export interface WorkItemEvidenceEventOptions {
  readonly cwd: string;
  readonly project?: (entry: WorkItemEvidenceEntry, workItemRevision: number) => Pick<AppendControlPlaneEventInput, "action" | "data">;
}

export interface ListWorkItemEvidenceOptions {
  readonly workItemId: string;
  readonly recordIdPrefix?: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}

export function createWorkItemEvidenceId(): string {
  return `work_item_evidence_${randomUUID().replaceAll("-", "")}`;
}
