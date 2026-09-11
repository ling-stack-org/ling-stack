import type { UserInputContinuationSeed } from "../../user-input-continuation-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";
import { userInputHash, userInputTimestamp } from "./user-input-records.js";
import { captureUserInputSeed, USER_INPUT_SEED_USE, userInputSeedId, type UserInputSeedPorts, type UserInputSeedSource } from "./user-input-continuation-records.js";

/** Caller owns a single read/write transaction and has already resolved the delivery scope. */
export function readUserInputContinuationSeed(context: SqliteStoreContext, ports: UserInputSeedPorts, bound: UserInputSeedSource): UserInputContinuationSeed | undefined {
  const { delivery } = bound;
  // Read by deterministic primary key, not mutable use/thread columns; corruption is not absence.
  const row = context.database.prepare("SELECT * FROM conversation_context_snapshots WHERE id=?").get(userInputSeedId(delivery.deliveryId));
  if (!row && !delivery.successorRunId) return undefined;
  if (!row || !delivery.successorRunId) throw new UserInputStoreError("invalid_record");
  let value: UserInputContinuationSeed;
  try {
    value = JSON.parse(String(row.payload_json)) as UserInputContinuationSeed;
    if (!value || typeof value !== "object" || !value.projection || typeof value.projection.segmentId !== "string"
      || !value.contextAssignment || typeof value.contextAssignment.id !== "string"
      || typeof value.createdAt !== "string" || row.payload_version !== 1 || row.snapshot_use !== USER_INPUT_SEED_USE
      || userInputTimestamp(value.createdAt) > userInputTimestamp(delivery.updatedAt)) {
      throw new Error("invalid");
    }
  } catch { throw new UserInputStoreError("invalid_record"); }
  const assignment = context.database.prepare(`SELECT id,segment_id,revision,created_at FROM turn_context_assignments
    WHERE id=? AND workspace_id=? AND turn_id=?`).get(value.contextAssignment.id, bound.request.source.workspaceId, bound.request.source.turnId);
  if (!assignment || typeof assignment.id !== "string" || typeof assignment.segment_id !== "string"
    || typeof assignment.revision !== "number" || typeof assignment.created_at !== "string") throw new UserInputStoreError("invalid_record");
  // Infrastructure failures from ports propagate unchanged. Only invalid evidence is a domain error.
  const expected = captureUserInputSeed(ports, bound, delivery.successorRunId, value.createdAt,
    { id: assignment.id, segmentId: assignment.segment_id, revision: assignment.revision, createdAt: assignment.created_at });
  const p = expected.projection;
  if (userInputHash(value) !== userInputHash(expected) || row.id !== expected.id
    || row.workspace_id !== expected.source.workspaceId || row.thread_id !== expected.source.threadId
    || row.segment_id !== p.segmentId || row.projection_version !== p.projectionVersion
    || row.through_item_sequence !== p.throughItemSequence || row.policy_version !== p.policyVersion
    || row.summary_ids_json !== JSON.stringify(p.summaryIds) || row.source_refs_json !== JSON.stringify(p.sourceRefs)
    || row.created_at !== expected.createdAt || row.source_item_id !== null || row.payload_fingerprint !== expected.fingerprint) {
    throw new UserInputStoreError("invalid_record");
  }
  return expected;
}

/** The first lease and its exact accepted answer are committed together; later leases never recapture. */
export function freezeUserInputContinuationSeed(context: SqliteStoreContext, ports: UserInputSeedPorts,
  bound: UserInputSeedSource, successorRunId: string, now: string): UserInputContinuationSeed {
  const existing = readSqliteWithinTransaction(context.database, () => readUserInputContinuationSeed(context, ports, bound));
  if (existing) return existing;
  const seed = readSqliteWithinTransaction(context.database, () => captureUserInputSeed(ports, bound, successorRunId, now));
  const p = seed.projection;
  // NULL source_item_id avoids masquerading as a normal accepted user-message snapshot.
  context.database.prepare(`INSERT INTO conversation_context_snapshots (
    id,workspace_id,thread_id,segment_id,projection_version,through_item_sequence,summary_ids_json,source_refs_json,
    policy_version,created_at,snapshot_use,payload_version,source_item_id,payload_json,payload_fingerprint
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,NULL,?,?)`).run(
    seed.id, seed.source.workspaceId, seed.source.threadId, p.segmentId, p.projectionVersion, p.throughItemSequence,
    JSON.stringify(p.summaryIds), JSON.stringify(p.sourceRefs), p.policyVersion, seed.createdAt, USER_INPUT_SEED_USE, JSON.stringify(seed), seed.fingerprint);
  return seed;
}
