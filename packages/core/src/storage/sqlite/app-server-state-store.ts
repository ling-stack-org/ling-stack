import type { SQLOutputValue } from "node:sqlite";
import type { AppendControlPlaneEventInput } from "../../run-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import type {
  AppServerStateKind,
  AppServerStateRecord,
  PutAppServerStateInput,
  PutAppServerStateResult,
} from "../../app-server-state-types.js";
import { parseJson, readNullableString, readNumber, readString, stringifyJson } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";
import { SqliteControlPlaneStore } from "./control-plane-store.js";

export class SqliteAppServerStateStore {
  constructor(private readonly context: SqliteStoreContext, private readonly events = new SqliteControlPlaneStore(context)) {}

  get(kind: AppServerStateKind, recordId: string, workspaceId = DEFAULT_WORKSPACE_ID): AppServerStateRecord | undefined {
    const row = this.context.database.prepare(`
      SELECT * FROM app_server_state WHERE workspace_id = ? AND kind = ? AND record_id = ?
    `).get(workspaceId, kind, recordId) as Record<string, SQLOutputValue> | undefined;
    return row ? mapRecord(row) : undefined;
  }

  findByIdempotencyKey(kind: AppServerStateKind, idempotencyKey: string, workspaceId = DEFAULT_WORKSPACE_ID): AppServerStateRecord | undefined {
    const row = this.context.database.prepare(`
      SELECT * FROM app_server_state WHERE workspace_id = ? AND kind = ? AND idempotency_key = ?
    `).get(workspaceId, kind, idempotencyKey);
    return row ? mapRecord(row) : undefined;
  }

  list(kind?: AppServerStateKind, workspaceId = DEFAULT_WORKSPACE_ID): AppServerStateRecord[] {
    const rows = kind === undefined
      ? this.context.database.prepare("SELECT * FROM app_server_state WHERE workspace_id = ? ORDER BY updated_at DESC, record_id ASC").all(workspaceId)
      : this.context.database.prepare("SELECT * FROM app_server_state WHERE workspace_id = ? AND kind = ? ORDER BY updated_at DESC, record_id ASC").all(workspaceId, kind);
    return rows.map((row) => mapRecord(row as Record<string, SQLOutputValue>));
  }

  latestVerification(threadId?: string, workspaceId = DEFAULT_WORKSPACE_ID): AppServerStateRecord | undefined {
    const row = threadId === undefined
      ? this.context.database.prepare(`SELECT * FROM app_server_state WHERE workspace_id = ? AND kind = 'verify_operation'
          ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(workspaceId)
      : this.context.database.prepare(`SELECT * FROM app_server_state WHERE workspace_id = ? AND kind = 'verify_operation'
          AND json_extract(payload_json, '$.operation.threadId') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(workspaceId, threadId);
    return row ? mapRecord(row) : undefined;
  }

  put(input: PutAppServerStateInput, now: string, publication?: AppendControlPlaneEventInput): PutAppServerStateResult | undefined {
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const retained = input.replayByIdempotencyKey && input.idempotencyKey
        ? this.findByIdempotencyKey(input.kind, input.idempotencyKey, input.workspaceId) : undefined;
      const result = retained ? { status: "replayed", record: retained } as const : this.putWithinTransaction(input, now);
      const event = result && result.status !== "replayed" && publication
        ? this.events.appendControlPlaneEventWithinTransaction(publication, now) : undefined;
      this.context.database.exec("COMMIT");
      return result && event ? { ...result, event } : result;
    } catch (error) {
      try { this.context.database.exec("ROLLBACK"); } catch { /* preserve original */ }
      throw error;
    }
  }

  putWithinTransaction(input: PutAppServerStateInput, now: string): PutAppServerStateResult | undefined {
    if (!this.context.database.isTransaction) throw new Error("app_server_state_requires_transaction");
    if (!input.recordId.trim()) throw new Error("app_server_state_record_id_required");
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const existing = this.get(input.kind, input.recordId, workspaceId);
    if (existing?.idempotencyKey && input.idempotencyKey === existing.idempotencyKey) {
      if (JSON.stringify(existing.payload) !== JSON.stringify(input.payload)) throw new Error("app_server_state_idempotency_conflict");
      return { status: "replayed", record: existing };
    }
    if (input.expectedRevision !== undefined && input.expectedRevision !== (existing?.revision ?? 0)) {
      return undefined;
    }
    const idempotencyKey = input.idempotencyKey ?? existing?.idempotencyKey;
    const record: AppServerStateRecord = {
      workspaceId,
      kind: input.kind,
      recordId: input.recordId,
      revision: (existing?.revision ?? 0) + 1,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      payload: input.payload,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.context.database.prepare(`
      INSERT INTO app_server_state (
        workspace_id, kind, record_id, revision, idempotency_key, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, kind, record_id) DO UPDATE SET
        revision = excluded.revision,
        idempotency_key = excluded.idempotency_key,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      record.workspaceId,
      record.kind,
      record.recordId,
      record.revision,
      record.idempotencyKey ?? null,
      stringifyJson(record.payload),
      record.createdAt,
      record.updatedAt,
    );
    return { status: existing ? "updated" : "created", record };
  }

  delete(kind: AppServerStateKind, recordId: string, workspaceId = DEFAULT_WORKSPACE_ID): boolean {
    const result = this.context.database.prepare(`
      DELETE FROM app_server_state WHERE workspace_id = ? AND kind = ? AND record_id = ?
    `).run(workspaceId, kind, recordId);
    return result.changes === 1;
  }
}

function mapRecord(row: Record<string, SQLOutputValue>): AppServerStateRecord {
  return {
    workspaceId: readString(row, "workspace_id"),
    kind: readString(row, "kind") as AppServerStateKind,
    recordId: readString(row, "record_id"),
    revision: readNumber(row, "revision"),
    ...(readNullableString(row, "idempotency_key") ? { idempotencyKey: readNullableString(row, "idempotency_key")! } : {}),
    payload: parseJson(readString(row, "payload_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}
