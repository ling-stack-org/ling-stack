import type {
  LingAppServerCollaborationKind,
  LingAppServerWorkItemCollaborationAppendParams,
  LingAppServerWorkItemCollaborationAppendResult,
  LingAppServerWorkItemCollaborationReadParams,
  LingAppServerWorkItemCollaborationReadResult,
} from "@ling-stack/contracts";
import {
  appendWorkItemCollaboration,
  fromAppServerCollaborationParams,
  listWorkItemCollaboration,
  toAppServerCollaborationRecord,
  type WorkItemCollaborationRecord,
} from "@ling-stack/core";
import type { RunStore } from "@ling-stack/core";

export class AppServerCollaborationError extends Error {
  constructor(
    readonly code: "work_item_not_found" | "stale_revision" | "idempotency_conflict" | "invalid_params",
    message: string,
  ) {
    super(message);
    this.name = "AppServerCollaborationError";
  }
}

export function readAppServerWorkItemCollaboration(
  store: RunStore,
  params: LingAppServerWorkItemCollaborationReadParams,
): LingAppServerWorkItemCollaborationReadResult {
  const workItem = store.getWorkItem(params.workItemId);
  if (!workItem) throw new AppServerCollaborationError("work_item_not_found", `Work Item was not found: ${params.workItemId}`);
  const page = listWorkItemCollaboration(store, {
    workItemId: params.workItemId,
    kind: params.kind,
    afterRevision: params.afterRevision,
    limit: params.limit,
  });
  return {
    workItemId: params.workItemId,
    records: page.records.map(toAppServerCollaborationRecord),
    nextAfterRevision: page.nextAfterRevision,
  };
}

export function appendAppServerWorkItemCollaboration(
  store: RunStore,
  params: LingAppServerWorkItemCollaborationAppendParams,
  now: string,
): LingAppServerWorkItemCollaborationAppendResult {
  const workItem = store.getWorkItem(params.workItemId);
  if (!workItem) throw new AppServerCollaborationError("work_item_not_found", `Work Item was not found: ${params.workItemId}`);
  const result = appendWorkItemCollaboration(store, fromAppServerCollaborationParams(params), now);
  if (!result) throw new AppServerCollaborationError("stale_revision", "The Work Item revision or collaboration revision is stale.");
  return {
    status: result.status,
    record: toAppServerCollaborationRecord(result.record),
    workItemRevision: result.workItemRevision,
  };
}

export function readAppServerWorkItemCollaborationKind(
  store: RunStore,
  workItemId: string,
  kind: LingAppServerCollaborationKind,
  afterRevision?: number,
  limit?: number,
): readonly WorkItemCollaborationRecord[] {
  const result = readAppServerWorkItemCollaboration(store, { workItemId, kind, afterRevision, limit });
  return result.records;
}

