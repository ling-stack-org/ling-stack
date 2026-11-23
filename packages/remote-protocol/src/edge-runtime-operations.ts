import type { DeviceTaskGraphNodeReceiptV1, EdgeRuntimeHealthSampleV1, EdgeRuntimeJournalEntryV1 } from "@ling-stack/contracts";
import { canonicalJsonBytes } from "./canonical.js";

export interface EdgeRuntimeKeyBindingV1 {
  readonly grantId: string;
  readonly runtimeRevision: number;
}

export interface EdgeRuntimeEvidenceBindingV1 extends EdgeRuntimeKeyBindingV1 {
  readonly placementId: string;
}

export function edgeRuntimeHealthSampleBytes(
  runtimeId: string, binding: EdgeRuntimeKeyBindingV1, sample: EdgeRuntimeHealthSampleV1,
): Uint8Array {
  return canonicalJsonBytes({ purpose: "ling.edge-runtime-health.v1", runtimeId, binding, sample });
}

export function edgeRuntimeDiagnosisClaimBytes(binding: EdgeRuntimeEvidenceBindingV1, graphId: string): Uint8Array {
  return canonicalJsonBytes({ purpose: "ling.edge-runtime-diagnosis-claim.v1", binding, graphId });
}

/** Bytes signed by an enrolled Edge runtime for a durable journal append. */
export function edgeRuntimeJournalEntryBytes(binding: EdgeRuntimeEvidenceBindingV1, entry: EdgeRuntimeJournalEntryV1): Uint8Array {
  return canonicalJsonBytes({ purpose: "ling.edge-runtime-journal.v1", binding, entry });
}

/** Bytes signed by an enrolled Edge runtime for a cross-runtime task-graph receipt. */
export function edgeRuntimeTaskGraphReceiptBytes(binding: EdgeRuntimeEvidenceBindingV1, receipt: DeviceTaskGraphNodeReceiptV1): Uint8Array {
  return canonicalJsonBytes({ purpose: "ling.edge-runtime-task-graph-receipt.v1", binding, receipt });
}

export function isEdgeTaskGraphReceipt(value: unknown): value is DeviceTaskGraphNodeReceiptV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const refs = [receipt.graphId, receipt.nodeId, receipt.ownerId, receipt.targetDeviceId,
    receipt.capabilitySnapshotId, receipt.attemptId, receipt.resultRef];
  return Object.keys(receipt).length === 12 && refs.every(ref => typeof ref === "string" && ref.trim().length > 0 && ref.length <= 512)
    && receipt.ownerKind === "edge" && typeof receipt.status === "string"
    && ["succeeded", "failed", "unknown", "cancelled"].includes(receipt.status)
    && typeof receipt.graphRevision === "number" && Number.isSafeInteger(receipt.graphRevision) && receipt.graphRevision > 0
    && typeof receipt.routeGeneration === "number" && Number.isSafeInteger(receipt.routeGeneration) && receipt.routeGeneration > 0
    && typeof receipt.receivedAt === "string" && Number.isFinite(Date.parse(receipt.receivedAt));
}
