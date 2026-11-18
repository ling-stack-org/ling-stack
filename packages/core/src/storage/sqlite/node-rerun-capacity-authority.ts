import type { NodeRerunPreparedTargetV1 } from "@ling-stack/contracts";
import type { HostOperationSource } from "../../host-operation-journal-types.js";
import type { HostRunCapacityWorkspaceIdentitySnapshot } from "../../host-run-capacity-workspace-identity.js";
import type { RunStore } from "../../run-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import { isCanonicalTimestamp } from "./node-rerun-approval-authority.js";
import { rerunDigest } from "./node-rerun-target-input.js";

export type NodeRerunCapacityPorts = Pick<RunStore, "getNodeRerunIntent" | "getNodeRerunTarget">;
export interface NodeRerunCapacityAuthority {
  readonly target: NodeRerunPreparedTargetV1;
  readonly source: HostOperationSource;
  readonly ownerKey: string;
  readonly authorityDigest: string;
}

export function hasCompleteNodeRerunCapacityReceipt(row: Readonly<Record<string, unknown>>): boolean {
  const receipt = [row.reservation_id, row.reservation_token, row.host_policy_revision, row.reserved_at, row.dispatch_token];
  return row.reservation_id === null ? receipt.every(value => value === null)
    : typeof row.reservation_id === "string" && row.reservation_id.trim().length > 0
      && typeof row.reservation_token === "string" && /^[a-f0-9]{64}$/u.test(row.reservation_token)
      && typeof row.dispatch_token === "string" && /^[a-f0-9]{64}$/u.test(row.dispatch_token)
      && typeof row.host_policy_revision === "number" && Number.isSafeInteger(row.host_policy_revision) && row.host_policy_revision >= 1
      && typeof row.reserved_at === "string";
}

/** Derive stable capacity identity from the independently validated, persisted target receipt. */
export function readNodeRerunCapacityAuthority(context: SqliteStoreContext, ports: NodeRerunCapacityPorts,
  recordId: string): NodeRerunCapacityAuthority | undefined {
  const target = ports.getNodeRerunTarget(recordId), record = ports.getNodeRerunIntent(recordId);
  if (!target || !record) return undefined;
  const receipt = context.database.prepare("SELECT basis_sha256 FROM node_rerun_targets WHERE intent_id=?").get(recordId);
  if (typeof receipt?.basis_sha256 !== "string") return undefined;
  const identity = { schemaVersion: 1, kind: "node_rerun_target", recordId: record.id, generationId: target.generationId };
  return { target, source: { runId: target.runId, ...target.fence }, ownerKey: rerunDigest(identity),
    authorityDigest: rerunDigest({ ...identity, target, approvalBasisFingerprint: receipt.basis_sha256,
      planFingerprint: record.planFingerprint, policyFingerprint: record.policyFingerprint }) };
}

/** Only this exact unconsumed journal row may coexist with a pristine target during capacity preparation. */
export function readNodeRerunCapacityExclusion(context: SqliteStoreContext, authority: NodeRerunCapacityAuthority,
  identity: HostRunCapacityWorkspaceIdentitySnapshot, now: string): string | false | undefined {
  const row = context.database.prepare("SELECT * FROM runtime_host_capacity_intents WHERE workspace_id=? AND owner_kind='node_rerun_target' AND owner_key=?")
    .get(identity.workspaceId, authority.ownerKey);
  if (!row) return undefined;
  const source = authority.source;
  if (!hasCompleteNodeRerunCapacityReceipt(row) || typeof row.intent_id !== "string" || row.workspace_id !== identity.workspaceId
    || row.workspace_id !== authority.target.workspaceId
    || row.workspace_key !== identity.workspaceKey || row.canonical_cwd !== identity.canonicalCwd
    || row.database_path !== identity.databasePath || row.database_file_identity !== identity.databaseFileIdentity
    || row.authority_digest !== authority.authorityDigest || row.run_id !== source.runId
    || row.work_unit_id !== source.workUnitId || row.attempt_id !== source.attemptId
    || row.runtime_instance_id !== source.runtimeInstanceId || row.fencing_token !== source.fencingToken
    || typeof row.created_at !== "string" || !isCanonicalTimestamp(row.created_at)
    || row.created_at < authority.target.preparedAt || row.created_at > now
    || row.dispatched_at !== null || row.revoked_at !== null
    || row.reserved_at !== null && (typeof row.reserved_at !== "string" || !isCanonicalTimestamp(row.reserved_at)
      || row.reserved_at < row.created_at || row.reserved_at > now)
    || context.database.prepare("SELECT 1 FROM runtime_host_capacity_releases WHERE intent_id=?").get(row.intent_id)) return false;
  return row.intent_id;
}
