import type { DeviceTaskGraphNodeReceiptV1, DeviceTaskGraphNodeV1, DeviceTaskGraphV1 } from "@ling-stack/contracts";
import { DeviceTaskGraphCoordinator } from "./device-fabric.js";
import type { DeviceSupportStoreAttemptRecord } from "./device-support.js";
import type { SqliteDeviceFabricStore } from "./storage/sqlite/device-fabric-store.js";
import type { SqliteDeviceSupportStore } from "./storage/sqlite/device-support-store.js";
import { readSqliteSnapshot } from "./storage/sqlite/read-snapshot.js";

type NodeOutcome = Pick<DeviceTaskGraphNodeReceiptV1, "status" | "resultRef" | "receivedAt">;

/** Projects local Daemon diagnosis nodes from the execution owner's durable journal. */
export class DeviceDiagnosisGraphs {
  readonly coordinator: DeviceTaskGraphCoordinator;

  constructor(
    private readonly journal: SqliteDeviceSupportStore,
    private readonly fabric: SqliteDeviceFabricStore,
    now: () => string,
  ) {
    this.coordinator = new DeviceTaskGraphCoordinator({ persistence: fabric, now });
  }

  read(taskId: string): DeviceTaskGraphV1 | undefined {
    const evidence = readSqliteSnapshot(this.journal.database, () => {
      const task = this.journal.getTask(taskId);
      const plan = this.journal.listPlanningAcceptances(taskId).at(-1);
      if (task?.ownerKind !== "daemon" || !plan) return undefined;
      const attempts = this.journal.listPlannedAttempts(taskId, plan.proposalId);
      const reconciliations = new Map(this.journal.listReconciliations(taskId).filter(item => item.status === "verified")
        .map(item => [item.attemptId, item]));
      const active = this.journal.getLeasedAttempt(taskId)?.attempt.attemptId;
      const records = attempts.map(record => {
        const reconciliation = reconciliations.get(record.attempt.attemptId);
        const outcome: NodeOutcome | undefined = reconciliation ? {
          status: "succeeded", resultRef: reconciliation.reconciliationId, receivedAt: reconciliation.recordedAt,
        } : this.attemptOutcome(record, record.attempt.attemptId === active, task.updatedAt);
        return { record, outcome };
      });
      return { plan, records, stopped: task.status === "cancelled" || this.journal.hasTaskStopRequest(taskId) };
    });
    if (!evidence) return undefined;
    let graph = this.fabric.getTaskGraph(taskId) ?? this.fabric.saveTaskGraph(evidence.plan.graph);
    for (const { record, outcome } of evidence.records) {
      const { attemptId } = record.attempt;
      const matched = graph.nodes.find(node => matchesPlannedDeviceAttempt(node, record));
      if (!matched || (matched.attemptId && matched.attemptId !== attemptId)) continue;
      if (!matched.attemptId && !this.coordinator.readyNodes(graph).some(node => node.nodeId === matched.nodeId)) continue;
      graph = this.coordinator.bindNodeAttempt(graph, matched.nodeId, attemptId);
      if (evidence.stopped && outcome && outcome.resultRef !== attemptId) graph = this.coordinator.cancelGraph(graph);
      const node = graph.nodes.find(node => node.nodeId === matched.nodeId)!;
      if (!outcome || (graph.cancellationRequestedAt && outcome.status === "unknown")
        || (node.status !== "executing" && node.status !== "verifying" && !(node.status === "unknown" && outcome.status !== "unknown"))) continue;
      const { ownerKind, ownerId, targetDeviceId, capabilitySnapshotId, nodeId } = node;
      const authority = { ownerKind, ownerId, routeGeneration: 1 } as const;
      graph = this.coordinator.recordNodeReceipt(graph, {
        ...authority, ...outcome, graphId: graph.graphId, graphRevision: graph.revision, nodeId, targetDeviceId, capabilitySnapshotId, attemptId,
      }, authority);
    }
    return evidence.stopped ? this.coordinator.cancelGraph(graph) : graph;
  }

  private attemptOutcome({ attempt, request }: DeviceSupportStoreAttemptRecord, active: boolean, updatedAt: string): NodeOutcome | undefined {
    const resultRef = attempt.attemptId;
    const receivedAt = attempt.verification?.checkedAt ?? attempt.receipt?.finishedAt ?? updatedAt;
    const status = readDiagnosisAttemptStatus(this.journal, { attempt, request });
    return status === "unknown" && active && attempt.status !== "unknown" ? undefined : { status, resultRef, receivedAt };
  }
}

export function matchesPlannedDeviceAttempt(node: DeviceTaskGraphNodeV1, { attempt, request }: DeviceSupportStoreAttemptRecord): boolean {
  return node.nodeId === attempt.planningNode?.nodeId && node.ownerKind === attempt.ownerKind && node.ownerId === attempt.ownerId
    && node.targetDeviceId === attempt.targetDeviceId && attempt.targetDeviceId === request.targetDeviceId
    && node.capabilityId === request.capabilityId && node.capabilitySnapshotId === request.capabilitySnapshotId;
}

export function readDiagnosisAttemptStatus(
  journal: SqliteDeviceSupportStore, { attempt, request }: Pick<DeviceSupportStoreAttemptRecord, "attempt" | "request">,
): NodeOutcome["status"] {
  if (attempt.status === "cancelled" || attempt.status === "failed") return attempt.status;
  if (attempt.status !== "completed" || attempt.receipt?.status !== "completed") return "unknown";
  if (attempt.verification) return attempt.verification.status === "verified" ? "succeeded" : "failed";
  const capability = journal.getRecordedCapabilitySnapshot(attempt.targetDeviceId, request.capabilitySnapshotId)
    ?.snapshot.capabilities.find(item => item.id === request.capabilityId);
  return capability?.sideEffect === "read_only" && !capability.verificationCapabilityId && request.expectedVerification === undefined
    ? "succeeded" : "unknown";
}
