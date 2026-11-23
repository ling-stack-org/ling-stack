import { createHash } from "node:crypto";
import { EDGE_LOCAL_NETWORK_CAPABILITY_ID, type DeviceTaskGraphV1, type EdgeRuntimeDiagnosisWorkV1 } from "@ling-stack/contracts";
import { DeviceFabricError, DeviceTaskGraphCoordinator } from "@ling-stack/core";
import type { EdgeRuntimeEvidenceBindingV1 } from "@ling-stack/remote-protocol";
import type { DeviceSupportRuntime } from "./runtime.js";

const graphIdPattern = /^edge_diagnosis_[0-9a-f]{64}$/u;
const nodeId = "inspect-network";

export function isEdgeDiagnosisId(value: unknown): value is string {
  return typeof value === "string" && graphIdPattern.test(value);
}

export function queueEdgeDiagnosis(runtime: DeviceSupportRuntime, runtimeId: string, expectedRevision: number, requestId: string) {
  const enrolled = runtime.edgeRuntimes.get(runtimeId);
  if (!enrolled) throw new DeviceFabricError("target_missing", "edge runtime is missing");
  if (enrolled.revision !== expectedRevision || enrolled.status !== "enrolled" || !enrolled.supportedTransports.includes("local_process")) {
    throw new DeviceFabricError("safety_denied", "edge runtime has no authorized local process placement");
  }
  const graphId = `edge_diagnosis_${digest([runtimeId, expectedRevision, requestId])}`;
  const targetDeviceId = `edge_host_${digest([runtimeId, enrolled.publicKeyFingerprint])}`;
  const capabilityId = EDGE_LOCAL_NETWORK_CAPABILITY_ID;
  const capabilitySnapshotId = `edge_snapshot_${digest([targetDeviceId, expectedRevision, capabilityId, "1.0"])}`;
  const now = runtime.broker.now();
  const store = runtime.fabricStore;
  const planned = store.recordEdgeRuntimePlacement({
    runtimeId, ownerTaskId: graphId, targetDeviceId, capabilityId, sideEffect: "read_only",
    hasLocalExecutor: true, offlineRecoverySupported: false, evaluatedAt: now,
  }).decision;
  if (planned.runtimeRevision !== expectedRevision || planned.mode !== "local") {
    throw new DeviceFabricError("revision_conflict", "edge placement changed");
  }
  const prior = store.getTaskGraph(graphId);
  const graph = prior ?? store.saveTaskGraph({
    graphId, createdAt: now, updatedAt: now, revision: 1, status: "planned",
    nodes: [{ nodeId, targetDeviceId, ownerKind: "edge", ownerId: runtimeId, capabilityId, capabilitySnapshotId,
      dependencies: [], status: "planning", ownerRouteGeneration: expectedRevision }],
  });
  return { graph, placement: planned, replayed: prior !== undefined };
}

export function claimEdgeDiagnosis(
  runtime: DeviceSupportRuntime, graphId: string, runtimeId: string, binding: EdgeRuntimeEvidenceBindingV1, authorize: () => void,
): EdgeRuntimeDiagnosisWorkV1 {
  const store = runtime.fabricStore;
  return store.updateTaskGraph(graphId, current => {
    authorize();
    const node = requireDiagnosisNode(current, runtimeId);
    const placement = store.getEdgeRuntimePlacementDecision(binding.placementId);
    if (!placement || placement.mode !== "local" || placement.runtimeId !== runtimeId || placement.ownerTaskId !== graphId
      || placement.targetDeviceId !== node.targetDeviceId || placement.capabilityId !== node.capabilityId
      || placement.runtimeRevision !== binding.runtimeRevision || node.ownerRouteGeneration !== binding.runtimeRevision) {
      throw new DeviceFabricError("safety_denied", "edge claim is outside its placement");
    }
    if (current.cancellationRequestedAt || current.status === "cancelled") {
      throw new DeviceFabricError("safety_denied", "edge diagnosis is cancelled");
    }
    const coordinator = new DeviceTaskGraphCoordinator({ persistence: store, now: runtime.broker.now });
    const attemptId = node.attemptId ?? `edge_attempt_${digest([graphId, node.nodeId])}`;
    const graph = coordinator.bindNodeAttempt(current, node.nodeId, attemptId, binding.runtimeRevision);
    const dispatched = requireDiagnosisNode(graph, runtimeId);
    return { graphId, graphRevision: dispatched.attemptGraphRevision!, nodeId: dispatched.nodeId,
      targetDeviceId: dispatched.targetDeviceId, capabilityId: EDGE_LOCAL_NETWORK_CAPABILITY_ID,
      capabilitySnapshotId: dispatched.capabilitySnapshotId, attemptId };
  });
}

export function readEdgeDiagnosis(runtime: DeviceSupportRuntime, runtimeId: string, graphId: string) {
  const graph = runtime.fabricStore.getTaskGraph(graphId);
  if (!graph) throw new DeviceFabricError("target_missing", "edge diagnosis is missing");
  const node = requireDiagnosisNode(graph, runtimeId);
  const result = node.resultRef && runtime.fabricStore.getEdgeRuntimeJournalEntry(runtimeId, graphId, node.resultRef);
  return { graph, ...(result ? { observation: result.networkObservation } : {}) };
}

function requireDiagnosisNode(graph: DeviceTaskGraphV1, runtimeId: string) {
  const node = graph.nodes[0];
  if (graph.nodes.length !== 1 || node?.nodeId !== nodeId || node.ownerKind !== "edge" || node.ownerId !== runtimeId
    || node.capabilityId !== EDGE_LOCAL_NETWORK_CAPABILITY_ID) {
    throw new DeviceFabricError("target_missing", "edge diagnosis is outside this runtime");
  }
  return node;
}

function digest(identity: readonly (string | number)[]): string {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
