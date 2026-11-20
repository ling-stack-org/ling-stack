import {
  LING_APP_SERVER_COLLABORATION_ACTIONS,
  LING_APP_SERVER_COLLABORATION_KINDS,
} from "@ling-stack/contracts";
import type {
  LingAppServerCollaborationAction,
  LingAppServerCollaborationKind,
  LingAppServerWorkItemCollaborationAppendParams,
  LingAppServerWorkItemCollaborationRecord,
} from "@ling-stack/contracts";
import type { RunStore } from "./run-types.js";

export const WORK_ITEM_COLLABORATION_CONTENT_PREFIX = "ling.collaboration.v1:";

export interface WorkItemCollaborationSourceRef {
  readonly type: string;
  readonly id: string;
  readonly revision?: string;
  readonly digest?: string;
}

export interface WorkItemCollaborationRecord extends Omit<LingAppServerWorkItemCollaborationRecord, "sourceRefs"> {
  readonly sourceRefs: readonly WorkItemCollaborationSourceRef[];
}

export interface AppendWorkItemCollaborationInput {
  readonly workItemId: string;
  readonly expectedWorkItemRevision?: number;
  readonly expectedCollaborationRevision?: number;
  readonly kind: LingAppServerCollaborationKind;
  readonly action: LingAppServerCollaborationAction;
  readonly actorId: string;
  readonly payload: unknown;
  readonly parentRecordId?: string;
  readonly sourceRefs?: readonly WorkItemCollaborationSourceRef[];
  readonly idempotencyKey: string;
}

export interface AppendWorkItemCollaborationResult {
  readonly status: "appended" | "replayed";
  readonly record: WorkItemCollaborationRecord;
  readonly workItemRevision: number;
}

type CollaborationStore = Pick<RunStore, "getWorkItem" | "appendWorkItemEvidence" | "listWorkItemEvidence">;

export function appendWorkItemCollaboration(
  store: CollaborationStore,
  input: AppendWorkItemCollaborationInput,
  now: string,
): AppendWorkItemCollaborationResult | undefined {
  validateInput(input);
  const current = store.getWorkItem(input.workItemId);
  if (!current) return undefined;
  const content = encodeCollaborationContent(input);
  const expectedEvidenceRevision = input.expectedCollaborationRevision;
  const result = store.appendWorkItemEvidence({
    workItemId: input.workItemId,
    expectedWorkItemRevision: input.expectedWorkItemRevision,
    expectedEvidenceRevision,
    idempotencyKey: input.idempotencyKey,
    actorId: input.actorId,
    // The evidence store compares subjectRevision on idempotent replay. Keep
    // it stable across retries while the Work Item revision advances.
    subjectRevision: `work-item-collaboration:${input.idempotencyKey}`,
    kind: evidenceKind(input.kind, input.action),
    content,
    sourceRefs: input.sourceRefs ?? [],
  }, now);
  if (!result) return undefined;
  const record = decodeCollaborationRecord(result.entry.content, result.entry, result.workItemRevision);
  return { status: result.status, record, workItemRevision: result.workItemRevision };
}

export function listWorkItemCollaboration(
  store: CollaborationStore,
  input: { readonly workItemId: string; readonly kind?: LingAppServerCollaborationKind; readonly afterRevision?: number; readonly limit?: number },
): { readonly records: readonly WorkItemCollaborationRecord[]; readonly nextAfterRevision: number } {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const entries = store.listWorkItemEvidence({ workItemId: input.workItemId, afterSequence: input.afterRevision ?? 0, limit });
  const records = entries.flatMap((entry) => {
    if (!entry.content.startsWith(WORK_ITEM_COLLABORATION_CONTENT_PREFIX)) return [];
    try {
      const record = decodeCollaborationRecord(entry.content, entry);
      return input.kind === undefined || record.kind === input.kind ? [record] : [];
    } catch {
      return [];
    }
  });
  return {
    records,
    nextAfterRevision: entries.at(-1)?.sequence ?? input.afterRevision ?? 0,
  };
}

export function findWorkItemCollaborationById(
  store: CollaborationStore,
  workItemId: string,
  recordId: string,
): WorkItemCollaborationRecord | undefined {
  let afterRevision = 0;
  for (;;) {
    const page = listWorkItemCollaboration(store, { workItemId, afterRevision, limit: 500 });
    const found = page.records.find((record) => record.id === recordId);
    if (found) return found;
    if (page.nextAfterRevision <= afterRevision) return undefined;
    afterRevision = page.nextAfterRevision;
  }
}

function encodeCollaborationContent(input: AppendWorkItemCollaborationInput): string {
  return `${WORK_ITEM_COLLABORATION_CONTENT_PREFIX}${JSON.stringify({
    schemaVersion: 1,
    kind: input.kind,
    action: input.action,
    payload: input.payload,
    ...(input.parentRecordId ? { parentRecordId: input.parentRecordId } : {}),
  })}`;
}

function decodeCollaborationRecord(
  content: string,
  entry: { readonly id: string; readonly workspaceId: string; readonly workItemId: string; readonly sequence: number; readonly actorId: string; readonly sourceRefs: readonly WorkItemCollaborationSourceRef[]; readonly idempotencyKey: string; readonly createdAt: string; readonly updatedAt: string },
  workItemRevision?: number,
): WorkItemCollaborationRecord {
  if (!content.startsWith(WORK_ITEM_COLLABORATION_CONTENT_PREFIX)) throw new Error("not_work_item_collaboration_record");
  const parsed = JSON.parse(content.slice(WORK_ITEM_COLLABORATION_CONTENT_PREFIX.length)) as Record<string, unknown>;
  if (parsed.schemaVersion !== 1 || typeof parsed.kind !== "string" || typeof parsed.action !== "string"
    || !(LING_APP_SERVER_COLLABORATION_KINDS as readonly string[]).includes(parsed.kind)
    || !(LING_APP_SERVER_COLLABORATION_ACTIONS as readonly string[]).includes(parsed.action)) {
    throw new Error("invalid_work_item_collaboration_record");
  }
  if (!Array.isArray(entry.sourceRefs)) throw new Error("invalid_work_item_collaboration_source_refs");
  return {
    id: entry.id,
    workspaceId: entry.workspaceId,
    workItemId: entry.workItemId,
    collaborationRevision: entry.sequence,
    workItemRevision: workItemRevision ?? entry.sequence,
    kind: parsed.kind as LingAppServerCollaborationKind,
    action: parsed.action as LingAppServerCollaborationAction,
    actorId: entry.actorId,
    payload: parsed.payload,
    ...(typeof parsed.parentRecordId === "string" ? { parentRecordId: parsed.parentRecordId } : {}),
    sourceRefs: entry.sourceRefs,
    idempotencyKey: entry.idempotencyKey,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function evidenceKind(kind: LingAppServerCollaborationKind, action: LingAppServerCollaborationAction) {
  if (action === "decided" || kind === "deliberation") return "decision_ref" as const;
  if (action === "returned" || kind === "question") return "challenge" as const;
  if (kind === "brief" || kind === "stage" || kind === "coordination") return "observation" as const;
  return "proposal" as const;
}

function validateInput(input: AppendWorkItemCollaborationInput): void {
  if (!input.workItemId.trim() || !input.actorId.trim() || !input.idempotencyKey.trim()) {
    throw new Error("work_item_collaboration_identity_required");
  }
  if (!input.kind || !input.action || input.payload === undefined) {
    throw new Error("work_item_collaboration_payload_required");
  }
  if (input.expectedWorkItemRevision !== undefined && (!Number.isInteger(input.expectedWorkItemRevision) || input.expectedWorkItemRevision < 1)) {
    throw new Error("work_item_collaboration_expected_work_item_revision_invalid");
  }
  if (input.expectedCollaborationRevision !== undefined && (!Number.isInteger(input.expectedCollaborationRevision) || input.expectedCollaborationRevision < 0)) {
    throw new Error("work_item_collaboration_expected_collaboration_revision_invalid");
  }
}

export function toAppServerCollaborationRecord(record: WorkItemCollaborationRecord): LingAppServerWorkItemCollaborationRecord {
  return record;
}

export function fromAppServerCollaborationParams(input: LingAppServerWorkItemCollaborationAppendParams): AppendWorkItemCollaborationInput {
  return {
    workItemId: input.workItemId,
    expectedWorkItemRevision: input.expectedWorkItemRevision,
    expectedCollaborationRevision: input.expectedCollaborationRevision,
    kind: input.kind,
    action: input.action,
    actorId: input.actorId,
    payload: input.payload,
    parentRecordId: input.parentRecordId,
    sourceRefs: input.sourceRefs,
    idempotencyKey: input.idempotencyKey,
  };
}

