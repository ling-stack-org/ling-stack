import { isDeepStrictEqual } from "node:util";
import type { UserInputContinuationSeed } from "../../user-input-continuation-types.js";
import type { UserInputContinuationRecord, UserInputSnapshotRef } from "../../user-input-host-continuation-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import { userInputHash, userInputTimestamp } from "./user-input-records.js";
import { freezeUserInputSeed } from "./user-input-continuation-records.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";

export type UserInputContinuationRecordKind = "request" | "execution" | "binding" | "receipt";
export const userInputContinuationRef = (value: UserInputSnapshotRef): UserInputSnapshotRef => ({ id: value.id, fingerprint: value.fingerprint });
export const sameUserInputValue = isDeepStrictEqual;
export const isUserInputRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function requireUserInputRecordKeys(value: object, keys: readonly string[]): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new UserInputStoreError("invalid_record");
}
export const userInputEnvelopeKeys = ["id", "schemaVersion", "use", "deliveryId", "seedRef", "createdAt", "fingerprint"] as const;
const use = (kind: UserInputContinuationRecordKind): string => "user_input_continuation_" + kind;
const id = (kind: UserInputContinuationRecordKind, deliveryId: string): string => use(kind) + ":" + deliveryId;

/** Serialize under the caller's transaction without allowing getters/toJSON to write SQLite. */
export function makeUserInputContinuationRecord<T extends UserInputContinuationRecord>(context: SqliteStoreContext,
  seed: UserInputContinuationSeed, kind: UserInputContinuationRecordKind, fields: object, now: string): T {
  return readSqliteWithinTransaction(context.database, () => {
    const body = JSON.parse(JSON.stringify({ ...fields, id: id(kind, seed.deliveryId), schemaVersion: 1,
      use: use(kind), deliveryId: seed.deliveryId, seedRef: userInputContinuationRef(seed), createdAt: now }));
    return freezeUserInputSeed({ ...body, fingerprint: userInputHash(body) }) as T;
  });
}

/** A caller-owned transaction already resolved thread scope. Read by PK so corruption is not absence. */
export function readUserInputContinuationRecord<T extends UserInputContinuationRecord>(context: SqliteStoreContext,
  seed: UserInputContinuationSeed, kind: UserInputContinuationRecordKind): T | undefined {
  const row = context.database.prepare("SELECT * FROM conversation_context_snapshots WHERE id=?").get(id(kind, seed.deliveryId));
  if (!row) return undefined;
  try {
    const value = JSON.parse(String(row.payload_json));
    if (!isUserInputRecord(value)) throw new Error("envelope");
    const { fingerprint, ...body } = value, p = seed.projection;
    if (value.id !== id(kind, seed.deliveryId) || value.schemaVersion !== 1 || value.use !== use(kind)
      || value.deliveryId !== seed.deliveryId || !sameUserInputValue(value.seedRef, userInputContinuationRef(seed))
      || typeof value.createdAt !== "string" || userInputTimestamp(value.createdAt) < userInputTimestamp(seed.createdAt)
      || fingerprint !== userInputHash(body) || row.payload_version !== 1 || row.snapshot_use !== value.use
      || row.workspace_id !== seed.source.workspaceId || row.thread_id !== seed.source.threadId
      || row.source_item_id !== null || row.payload_fingerprint !== fingerprint || row.created_at !== value.createdAt
      || row.segment_id !== p.segmentId || row.projection_version !== p.projectionVersion
      || row.through_item_sequence !== p.throughItemSequence || row.policy_version !== p.policyVersion
      || row.summary_ids_json !== JSON.stringify(p.summaryIds) || row.source_refs_json !== JSON.stringify(p.sourceRefs)) throw new Error("lineage");
    return freezeUserInputSeed(value) as unknown as T;
  } catch { throw new UserInputStoreError("invalid_record"); }
}

/** Inserts only already detached, validated records. No upsert: immutable facts cannot be overwritten. */
export function insertUserInputContinuationRecord(context: SqliteStoreContext, seed: UserInputContinuationSeed, value: UserInputContinuationRecord): void {
  const p = seed.projection;
  context.database.prepare(`INSERT INTO conversation_context_snapshots (
    id,workspace_id,thread_id,segment_id,projection_version,through_item_sequence,summary_ids_json,source_refs_json,
    policy_version,created_at,snapshot_use,payload_version,source_item_id,payload_json,payload_fingerprint
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,NULL,?,?)`).run(value.id, seed.source.workspaceId, seed.source.threadId,
    p.segmentId, p.projectionVersion, p.throughItemSequence, JSON.stringify(p.summaryIds), JSON.stringify(p.sourceRefs),
    p.policyVersion, value.createdAt, value.use, JSON.stringify(value), value.fingerprint);
}
