import type { ControlPlaneEvent } from "./run-types.js";

export type AppServerStateKind = "verify_plan" | "verify_operation" | "review_submission" | "review_finding_update"
  | "simplify_submission" | "external_federation" | "work_item_creation" | "work_item_acceptance" | "work_item_control"
  | "replay_identity";

export interface AppServerStateRecord {
  readonly workspaceId: string;
  readonly kind: AppServerStateKind;
  readonly recordId: string;
  readonly revision: number;
  readonly idempotencyKey?: string;
  readonly payload: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PutAppServerStateInput {
  readonly workspaceId?: string;
  readonly kind: AppServerStateKind;
  readonly recordId: string;
  readonly expectedRevision?: number;
  readonly idempotencyKey?: string;
  readonly payload: unknown;
}

export interface PutAppServerStateResult {
  readonly status: "created" | "updated" | "replayed";
  readonly record: AppServerStateRecord;
  readonly event?: ControlPlaneEvent;
}
