import { createHash } from "node:crypto";
import {
  EDGE_LOCAL_NETWORK_CAPABILITY_ID, type DeviceTaskGraphV1, type EdgeDeviceAttemptConformanceReportV1, type EdgeDeviceJournalPageV1,
  type EdgeRuntimeDiagnosisWorkV1, type EdgeRuntimeJournalEntryV1,
} from "@ling-stack/contracts";
import { DEFAULT_WORKSPACE_ID, DeviceFabricError, DeviceTaskGraphCoordinator, edgeRuntimePlacementDecisionId } from "@ling-stack/core";
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
  const store = runtime.fabricStore;
  return store.withReadSnapshot(() => {
    const { graph, node } = diagnosisGraph(runtime, runtimeId, graphId);
    const result = node.resultRef && store.getEdgeRuntimeJournalEntry(runtimeId, graphId, node.resultRef);
    return { graph, ...(result ? { observation: result.networkObservation } : {}) };
  });
}

export function readEdgeDiagnosisEvents(runtime: DeviceSupportRuntime, runtimeId: string, graphId: string, cursor: {
  readonly generation?: number;
  readonly afterSequence: number;
  readonly limit: number;
}): EdgeDeviceJournalPageV1 {
  const store = runtime.fabricStore;
  return store.withReadSnapshot(() => {
    const { graph } = diagnosisGraph(runtime, runtimeId, graphId);
    const entries = store.listEdgeRuntimeJournalEntries(runtimeId, graphId);
    const streamId = edgeJournalStreamId(graphId);
    const generation = 1;
    const latestSequence = entries.at(-1)?.sequence ?? 0;
    const requiresSnapshot = (cursor.generation ?? generation) !== generation || cursor.afterSequence > latestSequence;
    const page = requiresSnapshot ? [] : entries.slice(cursor.afterSequence, cursor.afterSequence + cursor.limit);
    return {
      graph, streamId, generation, latestSequence, requiresSnapshot,
      hasMore: !requiresSnapshot && cursor.afterSequence + page.length < latestSequence,
      events: page.map(entry => ({
        eventId: entry.entryId, traceId: streamId, streamId, generation,
        sourceKind: entry.networkObservation ? "adapter" : "runtime", sourceId: runtimeId,
        sequence: entry.sequence, kind: entry.kind, occurredAt: entry.recordedAt,
        payload: { attemptId: entry.operationId, outcome: entry.outcome, ...(entry.networkObservation ? { ...entry.networkObservation } : {}) },
        redactionClass: "public", retentionClass: "durable",
        ...(entry.networkObservation ? { evidenceRefs: [entry.entryId] } : {}),
      })),
    };
  });
}

export function readEdgeDiagnosisConformance(
  runtime: DeviceSupportRuntime, runtimeId: string, graphId: string,
): EdgeDeviceAttemptConformanceReportV1 {
  const store = runtime.fabricStore;
  const report = store.withReadSnapshot((): EdgeDeviceAttemptConformanceReportV1 => {
    const { graph, node } = diagnosisGraph(runtime, runtimeId, graphId);
    const { attemptId, attemptGraphRevision, ownerRouteGeneration: runtimeRevision } = node;
    if (!attemptId || attemptGraphRevision === undefined || runtimeRevision === undefined) {
      throw new DeviceFabricError("target_missing", "edge diagnosis has no dispatched attempt");
    }
    const placementId = edgeRuntimePlacementDecisionId({
      runtimeId, runtimeRevision, ownerTaskId: graphId, targetDeviceId: node.targetDeviceId, capabilityId: node.capabilityId,
    });
    const placement = store.getEdgeRuntimePlacementDecision(placementId);
    const entries = store.listEdgeRuntimeJournalEntries(runtimeId, graphId);
    const [started, terminal] = entries;
    const receipt = node.resultRef ? store.getTaskGraphReceipt(graphId, attemptGraphRevision) : undefined;
    const receiptMatches = terminal !== undefined && receipt?.ownerKind === "edge" && receipt.ownerId === runtimeId && receipt.routeGeneration === runtimeRevision
      && receipt.nodeId === node.nodeId && receipt.attemptId === attemptId && receipt.targetDeviceId === node.targetDeviceId
      && receipt.capabilitySnapshotId === node.capabilitySnapshotId && receipt.resultRef === node.resultRef
      && receipt.resultRef === terminal.entryId && receipt.status === node.status;
    const checks: EdgeDeviceAttemptConformanceReportV1["checks"] = [
      placement?.mode === "local" && placement.sideEffect === "read_only"
        ? { id: "placement_binding", status: "pass", evidenceRef: placementId }
        : { id: "placement_binding", status: "fail" },
      { id: "journal_sequence", status: journalStatus(entries, attemptId), ...(started ? { evidenceRef: started.entryId } : {}) },
      { id: "owner_receipt", status: receiptMatches ? "pass" : node.resultRef ? "fail" : "skip",
        ...(receiptMatches ? { evidenceRef: terminal.entryId } : {}) },
      { id: "network_observation", status: receiptMatches && node.status === "succeeded" && terminal.networkObservation ? "pass"
        : node.status === "succeeded" || node.status === "failed" ? "fail" : "skip",
        ...(receiptMatches && terminal.networkObservation ? { evidenceRef: terminal.entryId } : {}) },
    ];
    const body = {
      runtimeId, adapterId: "edge-local-network", adapterVersion: "1.0.0", targetProfile: node.targetDeviceId,
      transport: "local_process", checks, generatedAt: graph.updatedAt,
      source: {
        ownerKind: "edge", workspaceId: DEFAULT_WORKSPACE_ID, taskId: graphId, attemptId, deviceId: node.targetDeviceId,
        nodeId: node.nodeId, capabilityId: node.capabilityId, capabilitySnapshotId: node.capabilitySnapshotId,
        graphRevision: graph.revision, runtimeRevision, placementId, outcome: node.status,
        streamId: edgeJournalStreamId(graphId), journalSequence: entries.at(-1)?.sequence ?? 0,
      },
    } satisfies Omit<EdgeDeviceAttemptConformanceReportV1, "reportId">;
    return { reportId: `edge_conformance_${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`, ...body };
  });
  store.saveConformanceReport(report);
  return report;
}

function diagnosisGraph(runtime: DeviceSupportRuntime, runtimeId: string, graphId: string) {
  const graph = runtime.fabricStore.getTaskGraph(graphId);
  if (!graph) throw new DeviceFabricError("target_missing", "edge diagnosis is missing");
  return { graph, node: requireDiagnosisNode(graph, runtimeId) };
}

function edgeJournalStreamId(graphId: string): string {
  return `edge-task:${graphId}`;
}

function journalStatus(entries: readonly EdgeRuntimeJournalEntryV1[], attemptId: string): "pass" | "fail" | "skip" {
  if (!entries.length) return "skip";
  return entries[0]?.kind === "task_started" && entries.every((entry, index) => entry.sequence === index + 1 && entry.operationId === attemptId)
    ? "pass" : "fail";
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
