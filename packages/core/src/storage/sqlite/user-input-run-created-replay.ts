import type { SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { ResourceLease } from "../../channel-runtime-types.js";
import type { UserInputContinuationBinding } from "../../user-input-host-continuation-types.js";
import { mapResourceLease } from "./runtime-work-mappers.js";
import { resourceLeaseSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

/** Physical resource renewal must not rewrite the first durable Run-created fact. */
export function isUserInputRunCreatedReplay(context: SqliteStoreContext, binding: UserInputContinuationBinding,
  canonical: unknown, candidate: unknown): boolean {
  const original = record(canonical), incoming = record(candidate);
  if (!original || !incoming) return false;
  const { leases: oldLeases, ...oldData } = original;
  const { leases: newLeases, ...newData } = incoming;
  if (oldLeases === undefined && newLeases === undefined) return isDeepStrictEqual(original, incoming);
  if (!isDeepStrictEqual(oldData, newData) || !Array.isArray(oldLeases) || !Array.isArray(newLeases)) return false;
  const workspace = context.database.prepare("SELECT workspace_id FROM work_units WHERE id=?")
    .get(binding.fence.workUnitId)?.workspace_id;
  if (typeof workspace !== "string") return false;
  const oldKeys = validatedLeaseKeys(context, binding, workspace, oldLeases, false);
  const exactReplay = isDeepStrictEqual(original, incoming);
  const newKeys = validatedLeaseKeys(context, binding, workspace, newLeases, !exactReplay);
  if (!oldKeys || !newKeys || !isDeepStrictEqual(oldKeys, newKeys)) return false;
  if (exactReplay) return true;
  const active = context.database.prepare(resourceLeaseSelectSql("WHERE attempt_id=? AND status='active'"))
    .all(binding.fence.attemptId).map(row => mapResourceLease(row as Record<string, SQLOutputValue>));
  return active.length === newLeases.length && active.every(lease => newLeases.some(value => record(value)?.id === lease.id));
}

function validatedLeaseKeys(context: SqliteStoreContext, binding: UserInputContinuationBinding, workspaceId: string,
  values: readonly unknown[], requireActive: boolean): string[] | undefined {
  const keys = new Set<string>(), ids = new Set<string>();
  for (const value of values) {
    const data = record(value);
    if (!data || typeof data.id !== "string" || ids.has(data.id)) return undefined;
    ids.add(data.id);
    const row = context.database.prepare(resourceLeaseSelectSql("WHERE id=?")).get(data.id);
    if (!row) return undefined;
    const lease = mapResourceLease(row as Record<string, SQLOutputValue>);
    if (!sameOwner(lease, binding, workspaceId) || data.resourceType !== lease.resourceType
      || data.resourceKey !== lease.resourceKey || data.workUnitId !== lease.workUnitId || data.attemptId !== lease.attemptId
      || (requireActive ? lease.status !== "active"
        : lease.status !== "active" && (!(lease.status === "released" || lease.status === "expired") || !lease.releasedAt))
      || !isDeepStrictEqual(data, { id: lease.id, resourceType: lease.resourceType, resourceKey: lease.resourceKey,
        workUnitId: lease.workUnitId, attemptId: lease.attemptId })) return undefined;
    const key = JSON.stringify([lease.resourceType, lease.resourceKey, lease.workUnitId, lease.attemptId]);
    if (keys.has(key)) return undefined;
    keys.add(key);
  }
  return [...keys].sort();
}

function sameOwner(lease: ResourceLease, binding: UserInputContinuationBinding, workspaceId: string): boolean {
  return lease.workspaceId === workspaceId && lease.ownerType === "run" && lease.ownerId === binding.runId
    && lease.workUnitId === binding.fence.workUnitId && lease.attemptId === binding.fence.attemptId
    && lease.runtimeInstanceId === binding.fence.runtimeInstanceId && lease.fencingToken === binding.fence.fencingToken;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
