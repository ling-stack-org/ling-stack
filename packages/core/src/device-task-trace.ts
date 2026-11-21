import type { DeviceTaskTraceV1, DeviceTraceLineageV1, DeviceTraceSpanV1, DeviceVerificationResultV1 } from "@ling-stack/contracts";

import { requireWorkspaceDeviceTask } from "./device-task-event-projector.js";
import type { SqliteDeviceSupportStore } from "./storage/sqlite/device-support-store.js";
import { readSqliteSnapshot } from "./storage/sqlite/read-snapshot.js";

type TaskTraceLineage = DeviceTraceLineageV1 & { readonly taskId: string };

export function readOwnedDeviceTaskTrace(input: {
  readonly store: SqliteDeviceSupportStore;
  readonly workspaceId: string;
  readonly taskId: string;
}): DeviceTaskTraceV1 {
  const { store, workspaceId, taskId } = input;
  return readSqliteSnapshot(store.database, () => {
    const task = requireWorkspaceDeviceTask(store, taskId, workspaceId);
    const traceId = `device-task:${taskId}`;
    const taskLineage = { taskId, runtimeId: task.ownerId };
    const rootSpanId = `${traceId}:task`;
    const rootStatus = task.status === "succeeded" ? "ok" : task.status === "unknown" ? "unknown"
      : ["failed", "partial", "cancelled"].includes(task.status) ? "failed" : "running";
    const spans: DeviceTraceSpanV1[] = [{
      spanId: rootSpanId, traceId, kind: "runtime", sourceId: task.ownerId,
      startedAt: task.createdAt, status: rootStatus, lineage: taskLineage, metadata: { taskStatus: task.status },
      ...(rootStatus !== "running" ? { finishedAt: task.updatedAt } : {}),
    }];
    const plans = new Map(store.listPlanningAcceptances(taskId).map(plan => [plan.proposalId, plan]));
    for (const plan of plans.values()) {
      spans.push({
        spanId: `${traceId}:plan:${plan.proposalId}`, traceId, parentSpanId: rootSpanId,
        kind: plan.source === "runner" ? "model" : "graph", sourceId: plan.proposalId,
        startedAt: plan.acceptedAt, finishedAt: plan.acceptedAt, status: "ok",
        lineage: { ...taskLineage, graphId: plan.graph.graphId, ...(plan.modelTurnId ? { modelTurnId: plan.modelTurnId } : {}) },
        metadata: { source: plan.source, contextId: plan.contextId, ...(plan.providerId ? { providerId: plan.providerId } : {}) },
      });
    }
    const attempts = new Map<string, { readonly spanId: string; readonly lineage: TaskTraceLineage }>();
    for (const { attempt, request } of store.listAttempts(taskId)) {
      if (attempt.ownerKind !== task.ownerKind || attempt.ownerId !== task.ownerId || !task.targetDeviceIds.includes(attempt.targetDeviceId)) continue;
      const spanId = `${traceId}:attempt:${attempt.attemptId}`;
      const plan = attempt.planningNode && plans.get(attempt.planningNode.proposalId);
      const lineage: TaskTraceLineage = {
        ...taskLineage, deviceId: attempt.targetDeviceId, attemptId: attempt.attemptId,
        ...(attempt.connectionRevision ? { connectionRevision: attempt.connectionRevision } : {}),
        ...(attempt.adapterBinding ? { adapterId: attempt.adapterBinding.adapterId } : {}),
        ...(plan && attempt.planningNode ? { graphId: plan.graph.graphId, nodeId: attempt.planningNode.nodeId } : {}),
        ...(plan?.modelTurnId ? { modelTurnId: plan.modelTurnId } : {}),
      };
      attempts.set(attempt.attemptId, { spanId, lineage });
      const status = attempt.status === "completed" ? "ok" : attempt.status === "unknown" ? "unknown"
        : attempt.status === "failed" || attempt.status === "cancelled" ? "failed" : "running";
      spans.push({
        spanId, traceId, parentSpanId: plan ? `${traceId}:plan:${plan.proposalId}` : rootSpanId,
        kind: "adapter", sourceId: attempt.adapterBinding?.adapterId ?? attempt.attemptId,
        startedAt: attempt.dispatchIntentAt, status, lineage,
        ...(attempt.receipt?.finishedAt ? { finishedAt: attempt.receipt.finishedAt } : {}),
        metadata: {
          capabilityId: request.capabilityId, capabilitySnapshotId: request.capabilitySnapshotId, attemptStatus: attempt.status,
          ...(attempt.adapterBinding ? { adapterVersion: attempt.adapterBinding.adapterVersion, profileRevision: attempt.adapterBinding.profileRevision } : {}),
          ...(attempt.receipt ? {
            receiptStatus: attempt.receipt.status, evidenceRefs: publicEvidence(store, taskId, attempt.receipt.observationIds),
          } : {}),
        },
      });
      if (attempt.verification) {
        spans.push(verificationSpan(
          store, traceId, spanId, lineage, `${attempt.attemptId}:verification`, attempt.verification, attempt.status === "unknown",
        ));
      }
    }
    for (const readback of store.listReconciliations(taskId)) {
      const attempt = attempts.get(readback.attemptId);
      if (attempt) spans.push(verificationSpan(
        store, traceId, attempt.spanId, { ...attempt.lineage, connectionRevision: readback.connectionRevision },
        readback.reconciliationId, readback.verification, readback.status === "unresolved",
      ));
    }
    return { traceId, taskId, taskStatus: task.status, spans };
  });
}

function publicEvidence(store: SqliteDeviceSupportStore, taskId: string, ids: readonly string[]): readonly string[] {
  return ids.filter(id => store.hasPublicObservation(taskId, id));
}

function verificationSpan(
  store: SqliteDeviceSupportStore, traceId: string, parentSpanId: string, lineage: TaskTraceLineage,
  evidenceId: string, result: DeviceVerificationResultV1, uncertain: boolean,
): DeviceTraceSpanV1 {
  return {
    spanId: `${traceId}:verification:${evidenceId}`, traceId, parentSpanId,
    kind: "verification", sourceId: evidenceId,
    startedAt: result.checkedAt, finishedAt: result.checkedAt, lineage,
    status: uncertain || result.status === "not_evaluable" ? "unknown" : result.status === "verified" ? "ok" : "failed",
    metadata: {
      verificationStatus: result.status,
      evidenceRefs: publicEvidence(store, lineage.taskId, result.observationIds),
    },
  };
}
