import type {
  DeviceActionAuthorityV1, DeviceApprovalBindingV1, DeviceTaskTraceCapabilitySnapshotV1,
  DeviceTaskTraceV1, DeviceTraceLineageV1, DeviceTraceSpanV1, DeviceVerificationResultV1, JsonValue,
} from "@ling-stack/contracts";

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
    const capabilitySnapshots = new Map<string, DeviceTaskTraceCapabilitySnapshotV1>();
    function referenceSnapshot(deviceId: string, snapshotId: string) {
      const key = JSON.stringify([deviceId, snapshotId]);
      if (!capabilitySnapshots.has(key)) {
        capabilitySnapshots.set(key, projectSnapshot(store, workspaceId, deviceId, snapshotId));
      }
      return { deviceId, snapshotId };
    }
    for (const deviceId of task.targetDeviceIds) {
      for (const snapshotId of task.capabilitySnapshotIds) {
        if (task.targetDeviceIds.length === 1 || store.getRecordedCapabilitySnapshot(deviceId, snapshotId)?.workspaceId === workspaceId) {
          referenceSnapshot(deviceId, snapshotId);
        }
      }
    }
    const traceId = `device-task:${taskId}`;
    const taskLineage = { taskId, runtimeId: task.ownerId };
    const rootSpanId = `${traceId}:task`;
    const rootStatus = task.status === "succeeded" ? "ok" : task.status === "unknown" ? "unknown"
      : ["failed", "partial", "cancelled"].includes(task.status) ? "failed" : "running";
    const spans: DeviceTraceSpanV1[] = [{
      spanId: rootSpanId, traceId, kind: "runtime", sourceId: task.ownerId,
      startedAt: task.createdAt, status: rootStatus, lineage: taskLineage,
      metadata: {
        taskStatus: task.status, capabilitySnapshotIds: task.capabilitySnapshotIds,
        ...(task.policyRevision ? { policyRevision: task.policyRevision } : {}),
      },
      ...(rootStatus !== "running" ? { finishedAt: task.updatedAt } : {}),
    }];
    const plans = new Map(store.listPlanningAcceptances(taskId).map(plan => [plan.proposalId, plan]));
    for (const plan of plans.values()) {
      spans.push({
        spanId: `${traceId}:plan:${plan.proposalId}`, traceId, parentSpanId: rootSpanId,
        kind: plan.source === "runner" ? "model" : "graph", sourceId: plan.proposalId,
        startedAt: plan.acceptedAt, finishedAt: plan.acceptedAt, status: "ok",
        lineage: { ...taskLineage, graphId: plan.graph.graphId, ...(plan.modelTurnId ? { modelTurnId: plan.modelTurnId } : {}) },
        metadata: {
          source: plan.source, contextId: plan.contextId,
          capabilitySnapshots: plan.graph.nodes.map(node => referenceSnapshot(node.targetDeviceId, node.capabilitySnapshotId)),
          ...(plan.providerId ? { providerId: plan.providerId } : {}),
          ...(plan.fallbackReason ? { fallbackReason: plan.fallbackReason } : {}),
          ...(plan.providerHandoff ? { providerHandoff: { ...plan.providerHandoff } } : {}),
          ...(plan.runnerId ? { runnerId: plan.runnerId } : {}),
          ...(plan.runnerCapabilityRevision ? { runnerCapabilityRevision: plan.runnerCapabilityRevision } : {}),
        },
      });
    }
    const attempts = new Map<string, { readonly spanId: string; readonly lineage: TaskTraceLineage }>();
    for (const { attempt, request } of store.listAttempts(taskId)) {
      if (attempt.ownerKind !== task.ownerKind || attempt.ownerId !== task.ownerId || !task.targetDeviceIds.includes(attempt.targetDeviceId)) continue;
      referenceSnapshot(attempt.targetDeviceId, request.capabilitySnapshotId);
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
          authority: projectAuthority(workspaceId, attempt.authority, attempt.approvalId === request.approval?.approvalId ? request.approval : undefined),
          ...(attempt.adapterBinding ? { adapterVersion: attempt.adapterBinding.adapterVersion, profileRevision: attempt.adapterBinding.profileRevision } : {}),
          ...(request.recoveryPlan && attempt.recoveryPathVerifiedAt ? { recovery: {
            kind: request.recoveryPlan.kind, routeRevision: request.recoveryPlan.routeRevision,
            verifyBy: request.recoveryPlan.verifyBy, verifiedAt: attempt.recoveryPathVerifiedAt,
            evidenceRefs: publicEvidence(store, taskId, [request.recoveryPlan.baselineObservationId]),
          } } : {}),
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
      if (attempt?.lineage.deviceId) {
        referenceSnapshot(attempt.lineage.deviceId, readback.capabilitySnapshotId);
        spans.push(verificationSpan(
          store, traceId, attempt.spanId, { ...attempt.lineage, connectionRevision: readback.connectionRevision },
          readback.reconciliationId, readback.verification, readback.status === "unresolved", {
            capabilitySnapshotId: readback.capabilitySnapshotId,
            ...(readback.readCapabilityId ? { capabilityId: readback.readCapabilityId } : {}),
            authority: projectAuthority(workspaceId, readback.authority),
          },
        ));
      }
    }
    return { traceId, taskId, taskStatus: task.status, spans, capabilitySnapshots: [...capabilitySnapshots.values()] };
  });
}

function projectSnapshot(
  store: SqliteDeviceSupportStore, workspaceId: string, deviceId: string, snapshotId: string,
): DeviceTaskTraceCapabilitySnapshotV1 {
  const record = store.getRecordedCapabilitySnapshot(deviceId, snapshotId);
  if (!record || record.workspaceId !== workspaceId) return { state: "unavailable", deviceId, snapshotId };
  const { adapterId, adapterVersion, contractMajor, connectionRevision, observedAt, freshnessUntil, capabilities } = record.snapshot;
  return {
    state: "recorded", deviceId, snapshotId, profileRevision: record.profileRevision,
    adapterId, adapterVersion, contractMajor, connectionRevision, observedAt, freshnessUntil,
    capabilities: capabilities.map(capability => ({
      id: capability.id, schemaVersion: capability.schemaVersion, sideEffect: capability.sideEffect, approvalClass: capability.approvalClass,
      ...(capability.verificationCapabilityId ? { verificationCapabilityId: capability.verificationCapabilityId } : {}),
    })),
  };
}

function projectAuthority(workspaceId: string, authority: DeviceActionAuthorityV1 | undefined, approval?: DeviceApprovalBindingV1): JsonValue {
  if (!authority || authority.workspaceId !== workspaceId) return { state: "unavailable" };
  const { policyRevision, dispatchStop, accessGrant, approvalPrincipal } = authority;
  return {
    state: "recorded", policyRevision,
    dispatchStop: { active: dispatchStop.active, revision: dispatchStop.revision },
    ...(accessGrant ? { accessGrant: {
      grantId: accessGrant.grantId, scope: accessGrant.scope, revision: accessGrant.revision, expiresAt: accessGrant.expiresAt,
    } } : {}),
    ...(approval ? { approval: {
      approvalId: approval.approvalId, normalizedInputDigest: approval.normalizedInputDigest, expiresAt: approval.expiresAt,
      ...(approvalPrincipal ? { principal: { ...approvalPrincipal } } : {}),
    } } : {}),
  };
}

function publicEvidence(store: SqliteDeviceSupportStore, taskId: string, ids: readonly string[]): readonly string[] {
  return ids.filter(id => store.hasPublicObservation(taskId, id));
}

function verificationSpan(
  store: SqliteDeviceSupportStore, traceId: string, parentSpanId: string, lineage: TaskTraceLineage,
  evidenceId: string, result: DeviceVerificationResultV1, uncertain: boolean,
  readbackMetadata?: { readonly capabilitySnapshotId: string; readonly capabilityId?: string; readonly authority: JsonValue },
): DeviceTraceSpanV1 {
  return {
    spanId: `${traceId}:verification:${evidenceId}`, traceId, parentSpanId,
    kind: "verification", sourceId: evidenceId,
    startedAt: result.checkedAt, finishedAt: result.checkedAt, lineage,
    status: uncertain || result.status === "not_evaluable" ? "unknown" : result.status === "verified" ? "ok" : "failed",
    metadata: {
      verificationStatus: result.status,
      evidenceRefs: publicEvidence(store, lineage.taskId, result.observationIds),
      ...readbackMetadata,
    },
  };
}
