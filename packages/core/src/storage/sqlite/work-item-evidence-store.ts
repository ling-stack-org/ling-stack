import type { SQLOutputValue } from "node:sqlite";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import {
  createWorkItemEvidenceId,
  type AppendWorkItemEvidenceInput,
  type AppendWorkItemEvidenceResult,
  type ListWorkItemEvidenceOptions,
  type WorkItemEvidenceEntry,
  type WorkItemEvidenceEventOptions,
  type WorkItemEvidenceKind,
  type WorkItemEvidenceSourceRef,
  type WorkItemEvidenceVisibility,
} from "../../work-item-evidence-types.js";
import { parseJson, readNullableString, readNumber, readString, stringifyJson } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { SqliteControlPlaneStore } from "./control-plane-store.js";

export class SqliteWorkItemEvidenceStore {
  constructor(private readonly context: SqliteStoreContext) {}

  appendWorkItemEvidence(
    input: AppendWorkItemEvidenceInput, now: string,
    events?: WorkItemEvidenceEventOptions & { readonly store: SqliteControlPlaneStore },
  ): AppendWorkItemEvidenceResult | undefined {
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.appendWithinTransaction(input, now, events);
      this.context.database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.context.database.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  appendWithinTransaction(
    input: AppendWorkItemEvidenceInput, now: string,
    events?: WorkItemEvidenceEventOptions & { readonly store: SqliteControlPlaneStore },
  ): AppendWorkItemEvidenceResult | undefined {
    if (!this.context.database.isTransaction) throw new Error("work_item_evidence_requires_transaction");
    validateEvidenceInput(input);
    const workItem = this.context.database
      .prepare("SELECT revision FROM work_items WHERE workspace_id = ? AND id = ?")
      .get(DEFAULT_WORKSPACE_ID, input.workItemId) as Record<string, SQLOutputValue> | undefined;
    if (!workItem) {
      return undefined;
    }
    const existingRow = this.context.database
      .prepare("SELECT * FROM work_item_evidence WHERE workspace_id = ? AND work_item_id = ? AND idempotency_key = ?")
      .get(DEFAULT_WORKSPACE_ID, input.workItemId, input.idempotencyKey) as Record<string, SQLOutputValue> | undefined;
    if (existingRow) {
      const existing = mapWorkItemEvidence(existingRow);
      if (!sameEvidenceInput(existing, input)) {
        throw new Error("work_item_evidence_idempotency_conflict");
      }
      const currentRevision = readNumber(workItem, "revision");
      return { status: "replayed", entry: existing, workItemRevision: currentRevision };
    }

    const workItemRevision = readNumber(workItem, "revision");
    if (input.expectedWorkItemRevision !== undefined && input.expectedWorkItemRevision !== workItemRevision) {
      return undefined;
    }
    const currentEvidenceRevision = Number((this.context.database
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS revision FROM work_item_evidence WHERE workspace_id = ? AND work_item_id = ?")
      .get(DEFAULT_WORKSPACE_ID, input.workItemId) as Record<string, SQLOutputValue>).revision ?? 0);
    if (input.expectedEvidenceRevision !== undefined && input.expectedEvidenceRevision !== currentEvidenceRevision) {
      return undefined;
    }
    const sequence = currentEvidenceRevision + 1;
    const entry: WorkItemEvidenceEntry = {
      id: input.id ?? createWorkItemEvidenceId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      workItemId: input.workItemId,
      revision: sequence,
      sequence,
      subjectRevision: input.subjectRevision,
      kind: input.kind,
      actorId: input.actorId,
      content: input.content,
      optionId: input.optionId,
      sourceRefs: input.sourceRefs ?? [],
      visibility: input.visibility ?? "work_item",
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      updatedAt: now,
    };
    this.context.database.prepare(`
      INSERT INTO work_item_evidence (
        id, workspace_id, work_item_id, revision, sequence, subject_revision, kind, actor_id,
        content, option_id, source_refs_json, visibility, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.workspaceId,
      entry.workItemId,
      entry.revision,
      entry.sequence,
      entry.subjectRevision,
      entry.kind,
      entry.actorId,
      entry.content,
      entry.optionId ?? null,
      stringifyJson(entry.sourceRefs),
      entry.visibility,
      entry.idempotencyKey,
      entry.createdAt,
      entry.updatedAt,
    );
    const updated = this.context.database
      .prepare("UPDATE work_items SET revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND revision = ?")
      .run(now, DEFAULT_WORKSPACE_ID, input.workItemId, workItemRevision);
    if (updated.changes !== 1) {
      throw new Error("work_item_evidence_work_item_revision_conflict");
    }
    const committedRevision = workItemRevision + 1;
    const event = events?.store.appendControlPlaneEventWithinTransaction({
      workspaceId: entry.workspaceId, cwd: events.cwd, domain: "work_items",
      entityType: "work_item", entityId: entry.workItemId,
      idempotencyKey: `work-item-evidence:${entry.id}`,
      ...(events.project?.(entry, committedRevision) ?? {
        action: "work_item.evidence.updated",
        data: { workItemId: entry.workItemId, evidenceId: entry.id, sequence, workItemRevision: committedRevision },
      }),
    }, now);
    return { status: "appended", entry, workItemRevision: committedRevision, ...(event ? { event } : {}) };
  }

  getWorkItemEvidence(id: string): WorkItemEvidenceEntry | undefined {
    const row = this.context.database.prepare("SELECT * FROM work_item_evidence WHERE workspace_id = ? AND id = ?")
      .get(DEFAULT_WORKSPACE_ID, id) as Record<string, SQLOutputValue> | undefined;
    return row ? mapWorkItemEvidence(row) : undefined;
  }

  listWorkItemEvidence(options: ListWorkItemEvidenceOptions): WorkItemEvidenceEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const afterSequence = options.afterSequence ?? 0;
    const prefix = options.recordIdPrefix;
    return this.context.database.prepare(`
      SELECT * FROM work_item_evidence
      WHERE workspace_id = ? AND work_item_id = ? AND sequence > ?
      ${prefix ? "AND substr(id, 1, length(?)) = ?" : ""}
      ORDER BY sequence ASC
      LIMIT ?
    `).all(DEFAULT_WORKSPACE_ID, options.workItemId, afterSequence, ...(prefix ? [prefix, prefix] : []), limit)
      .map((row) => mapWorkItemEvidence(row as Record<string, SQLOutputValue>));
  }
}

function mapWorkItemEvidence(row: Record<string, SQLOutputValue>): WorkItemEvidenceEntry {
  const sourceRefs = parseJson(readString(row, "source_refs_json"));
  if (!Array.isArray(sourceRefs)) throw new Error("Expected Work Item evidence source refs array from SQLite");
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    workItemId: readString(row, "work_item_id"),
    revision: readNumber(row, "revision"),
    sequence: readNumber(row, "sequence"),
    subjectRevision: readString(row, "subject_revision"),
    kind: readString(row, "kind") as WorkItemEvidenceKind,
    actorId: readString(row, "actor_id"),
    content: readString(row, "content"),
    optionId: readNullableString(row, "option_id"),
    sourceRefs: sourceRefs as WorkItemEvidenceSourceRef[],
    visibility: readString(row, "visibility") as WorkItemEvidenceVisibility,
    idempotencyKey: readString(row, "idempotency_key"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function sameEvidenceInput(existing: WorkItemEvidenceEntry, input: AppendWorkItemEvidenceInput): boolean {
  return existing.workItemId === input.workItemId
    && existing.actorId === input.actorId
    && existing.subjectRevision === input.subjectRevision
    && existing.kind === input.kind
    && existing.content === input.content
    && existing.optionId === input.optionId
    && existing.visibility === (input.visibility ?? "work_item")
    && JSON.stringify(existing.sourceRefs) === JSON.stringify(input.sourceRefs ?? []);
}

function validateEvidenceInput(input: AppendWorkItemEvidenceInput): void {
  if (input.workItemId.trim().length === 0 || input.idempotencyKey.trim().length === 0 || input.actorId.trim().length === 0) {
    throw new Error("work_item_evidence identity fields are required");
  }
  if (input.subjectRevision.trim().length === 0 || input.content.trim().length === 0) {
    throw new Error("work_item_evidence subject and content are required");
  }
  const kinds: readonly WorkItemEvidenceKind[] = ["observation", "proposal", "challenge", "evidence_ref", "correction", "recommendation", "decision_ref"];
  if (!kinds.includes(input.kind)) throw new Error("work_item_evidence kind is not supported");
  const visibilities: readonly WorkItemEvidenceVisibility[] = ["work_item", "participants", "owner"];
  if (input.visibility !== undefined && !visibilities.includes(input.visibility)) throw new Error("work_item_evidence visibility is not supported");
  for (const ref of input.sourceRefs ?? []) {
    if (ref.type.trim().length === 0 || ref.id.trim().length === 0) throw new Error("work_item_evidence source ref is invalid");
  }
}
