import { isDeepStrictEqual } from "node:util";
import type { NodeRerunPreparedTargetV1, NodeRerunTargetCancellationV1 } from "@ling-stack/contracts";
import type { RunStore } from "../../run-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import { isCanonicalTimestamp } from "./node-rerun-approval-authority.js";
import { hasNeverStartedNodeRerunTarget } from "./node-rerun-prestart.js";
import { rerunDigest } from "./node-rerun-target-input.js";

type Ports = Pick<RunStore, "getRun" | "getTask" | "getWorkUnit" | "getWorkUnitAttempt" | "listRuntimeEvents">;

export function nodeRerunCancellationAuditData(receipt: NodeRerunTargetCancellationV1) {
  return { nodeRerunCancellation: { recordId: receipt.recordId, generationId: receipt.generationId, runId: receipt.runId,
    releasedAt: receipt.releasedAt, stopEvidence: receipt.stopEvidence, receiptSha256: rerunDigest(receipt) } };
}

/** The exact terminal audit plus complete never-started inventory proves cancellation without a Host lifetime. */
export function readNodeRerunCancellationEvidence(context: SqliteStoreContext, ports: Ports,
  target: NodeRerunPreparedTargetV1, verifiedCapacityIntentId?: string): NodeRerunTargetCancellationV1 | undefined {
  const row = context.database.prepare("SELECT released_at FROM node_rerun_targets WHERE intent_id=?").get(target.recordId);
  if (row?.released_at === null) return undefined;
  const releasedAt = row?.released_at;
  if (typeof releasedAt !== "string" || !isCanonicalTimestamp(releasedAt) || releasedAt < target.preparedAt
    || !hasNeverStartedNodeRerunTarget(context, ports, target, releasedAt, verifiedCapacityIntentId))
    throw new Error("node_rerun_cancellation.receipt_corrupt");
  const receipt: NodeRerunTargetCancellationV1 = { schemaVersion: 1, kind: "node_rerun_target_cancellation",
    recordId: target.recordId, generationId: target.generationId, runId: target.runId, fence: target.fence,
    releasedAt, stopEvidence: "never_dispatched", executionAuthorized: false };
  const terminal = ports.listRuntimeEvents(target.fence.workUnitId, { complete: true }).find(event => event.type === "work_unit_cancelled");
  if (!terminal || terminal.ts !== releasedAt || !isDeepStrictEqual(terminal.data, nodeRerunCancellationAuditData(receipt)))
    throw new Error("node_rerun_cancellation.receipt_corrupt");
  return receipt;
}
