export type AppServerStateKind = "verify_plan" | "verify_operation" | "external_federation" | "work_item_acceptance";

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
}
