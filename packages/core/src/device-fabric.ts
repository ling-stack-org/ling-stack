import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CAPABILITY_SIDE_EFFECTS_V1 } from "@ling-stack/contracts";
import type {
  DeviceCapabilitySnapshotV1,
  CapabilitySideEffectV1,
  DeviceConformanceReportV1,
  DeviceContextFactMetadataV1,
  DeviceContextPackV1,
  DeviceEventEnvelopeV1,
  DeviceBridgeFrameV1,
  EdgeRuntimeJournalEntryV1,
  DeviceFleetHealthItemV1,
  DeviceFleetHealthProjectionV1,
  DeviceFleetHealthStatusV1,
  DeviceGraphNodeV1,
  DeviceGraphRelationshipV1,
  DeviceIdentityChangeV1,
  DeviceLifecycleRecordV1,
  DeviceProfileV1,
  DeviceResourceManifestV1,
  DeviceSafetyActionPolicyV1,
  DeviceSafetyContextV1,
  DeviceSafetyControllerEvidenceV1,
  DeviceSafetyDecisionV1,
  DeviceTaskGraphNodeV1,
  DeviceTaskGraphNodeReceiptV1,
  DeviceTaskGraphV1,
  DeviceTraceSpanV1,
  DeviceTransportDeploymentV1,
  DeviceTwinV1,
  DeviceTwinValueV1,
  EdgeRuntimeEnrollmentV1,
  EdgeRuntimePlacementDecisionV1,
  EdgeRuntimePlacementModeV1,
  JsonValue,
} from "@ling-stack/contracts";

export class DeviceFabricError extends Error {
  constructor(readonly code: "invalid_graph" | "target_missing" | "target_changed" | "revision_conflict" | "lease_busy" | "resource_conflict" | "safety_denied" | "lifecycle_invalid", message: string) {
    super(message);
    this.name = "DeviceFabricError";
  }
}

export class DeviceSemanticGraph {
  readonly #nodes = new Map<string, DeviceGraphNodeV1>();
  readonly #relationships = new Map<string, DeviceGraphRelationshipV1>();
  readonly #twins = new Map<string, DeviceTwinV1>();

  upsertNode(node: DeviceGraphNodeV1): DeviceGraphNodeV1 {
    if (!node.nodeId || node.revision < 0) throw new DeviceFabricError("revision_conflict", "graph node identity is invalid");
    const previous = this.#nodes.get(node.nodeId);
    if (previous && node.revision < previous.revision) throw new DeviceFabricError("revision_conflict", "graph node revision regressed");
    if (previous && node.revision === previous.revision) {
      if (!isDeepStrictEqual(node, previous)) throw new DeviceFabricError("revision_conflict", "graph node revision is bound to different state");
      return previous;
    }
    if (node.parentNodeId && !this.#nodes.has(node.parentNodeId)) throw new DeviceFabricError("target_missing", "graph parent node is missing");
    this.#nodes.set(node.nodeId, node);
    return node;
  }

  addRelationship(relationship: DeviceGraphRelationshipV1): DeviceGraphRelationshipV1 {
    if (!this.#nodes.has(relationship.fromNodeId) || !this.#nodes.has(relationship.toNodeId)) throw new DeviceFabricError("target_missing", "relationship endpoint is missing");
    if (relationship.fromNodeId === relationship.toNodeId) throw new DeviceFabricError("invalid_graph", "relationship cannot point to itself");
    if (["contains", "part_of"].includes(relationship.type) && this.wouldCycle(relationship.fromNodeId, relationship.toNodeId)) throw new DeviceFabricError("invalid_graph", "relationship would create a containment cycle");
    this.#relationships.set(relationship.relationshipId, relationship);
    return relationship;
  }

  mergeIdentity(nodeId: string, identityRef: string, revision: number): DeviceGraphNodeV1 {
    const node = this.#nodes.get(nodeId);
    if (!node) throw new DeviceFabricError("target_missing", "graph node is missing");
    if (revision < node.revision) throw new DeviceFabricError("revision_conflict", "identity merge revision regressed");
    const next = { ...node, revision, identityRefs: [...new Set([...node.identityRefs, identityRef])] };
    return this.upsertNode(next);
  }

  mergeIdentityWithEvidence(change: DeviceIdentityChangeV1): DeviceGraphNodeV1 {
    assertIdentityChange(change, "merge");
    const node = this.#nodes.get(change.nodeId);
    if (!node) throw new DeviceFabricError("target_missing", "graph node is missing");
    if (change.revision !== node.revision + 1) throw new DeviceFabricError("revision_conflict", "identity merge revision is stale");
    return this.mergeIdentity(change.nodeId, change.identityRef, change.revision);
  }

  splitIdentity(nodeId: string, identityRef: string, newNode: DeviceGraphNodeV1): DeviceGraphNodeV1 {
    const node = this.#nodes.get(nodeId);
    if (!node || !node.identityRefs.includes(identityRef)) throw new DeviceFabricError("target_missing", "identity reference is not attached");
    assertIdentitySplitDestination(nodeId, identityRef, newNode, this.#nodes.has(newNode.nodeId));
    if (newNode.revision <= node.revision) throw new DeviceFabricError("revision_conflict", "identity split revision must advance");
    const added = this.upsertNode(newNode);
    this.#nodes.set(nodeId, { ...node, identityRefs: node.identityRefs.filter(ref => ref !== identityRef), revision: newNode.revision });
    return added;
  }

  splitIdentityWithEvidence(change: DeviceIdentityChangeV1, newNode: DeviceGraphNodeV1): DeviceGraphNodeV1 {
    assertIdentityChange(change, "split");
    const node = this.#nodes.get(change.nodeId);
    if (!node || !node.identityRefs.includes(change.identityRef)) throw new DeviceFabricError("target_missing", "identity reference is not attached");
    if (change.newNodeId !== newNode.nodeId || change.revision !== node.revision + 1 || newNode.revision !== change.revision) {
      throw new DeviceFabricError("revision_conflict", "identity split revision is inconsistent");
    }
    return this.splitIdentity(change.nodeId, change.identityRef, newNode);
  }

  setTwin(twin: DeviceTwinV1): DeviceTwinV1 {
    const previous = this.#twins.get(twin.deviceId);
    if (previous && twin.revision <= previous.revision) throw new DeviceFabricError("revision_conflict", "device twin revision must advance");
    this.#twins.set(twin.deviceId, twin);
    return twin;
  }

  getTwin(deviceId: string, now = new Date().toISOString()): DeviceTwinV1 | undefined {
    const twin = this.#twins.get(deviceId);
    if (!twin) return undefined;
    return {
      ...twin,
      values: twin.values.map(value => Date.parse(value.freshnessUntil) <= Date.parse(now) ? { ...value, quality: "stale" } : value),
    };
  }

  listNodes(): readonly DeviceGraphNodeV1[] { return [...this.#nodes.values()]; }

  private wouldCycle(fromNodeId: string, toNodeId: string): boolean {
    const children = new Map<string, string[]>();
    for (const relationship of this.#relationships.values()) {
      if (!["contains", "part_of"].includes(relationship.type)) continue;
      const values = children.get(relationship.fromNodeId) ?? [];
      values.push(relationship.toNodeId);
      children.set(relationship.fromNodeId, values);
    }
    const stack = [toNodeId];
    const visited = new Set<string>();
    while (stack.length) {
      const current = stack.pop()!;
      if (current === fromNodeId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      stack.push(...(children.get(current) ?? []));
    }
    return false;
  }
}

export class DeviceTaskGraphCoordinator {
  readonly #leases = new Map<string, { readonly ownerId: string; readonly expiresAt: string }>();
  readonly #persistence?: DeviceTaskGraphPersistence;
  readonly #now: () => string;
  readonly #leaseMs: number;

  constructor(options: { readonly persistence?: DeviceTaskGraphPersistence; readonly now?: () => string; readonly leaseMs?: number } = {}) {
    this.#persistence = options.persistence;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#leaseMs = options.leaseMs ?? 30_000;
  }

  validateGraph(graph: DeviceTaskGraphV1): void {
    const ids = new Set<string>();
    for (const node of graph.nodes) {
      if (ids.has(node.nodeId)) throw new DeviceFabricError("invalid_graph", "task graph node ids must be unique");
      ids.add(node.nodeId);
    }
    for (const node of graph.nodes) {
      if (node.dependencies.some(dependency => !ids.has(dependency) || dependency === node.nodeId)) throw new DeviceFabricError("invalid_graph", "task graph dependency is invalid");
    }
    if (hasCycle(graph.nodes)) throw new DeviceFabricError("invalid_graph", "task graph contains a cycle");
  }

  readyNodes(graph: DeviceTaskGraphV1): readonly DeviceTaskGraphNodeV1[] {
    this.validateGraph(graph);
    if (graph.cancellationRequestedAt || graph.status === "cancelled") return [];
    const nodes = new Map(graph.nodes.map(node => [node.nodeId, node]));
    const occupied = new Set(graph.nodes.filter(node => ["executing", "verifying", "unknown"].includes(node.status))
      .map(node => node.targetDeviceId));
    return graph.nodes.filter(node => node.status === "planning" || node.status === "created")
      .filter(node => !occupied.has(node.targetDeviceId)
        && node.dependencies.every(dependency => nodes.get(dependency)?.status === "succeeded"));
  }

  bindNodeAttempt(graph: DeviceTaskGraphV1, nodeId: string, attemptId: string, ownerRouteGeneration?: number): DeviceTaskGraphV1 {
    if (!attemptId.trim() || attemptId.length > 512
      || (ownerRouteGeneration !== undefined && (!Number.isSafeInteger(ownerRouteGeneration) || ownerRouteGeneration < 1))) {
      throw new DeviceFabricError("invalid_graph", "task graph attempt binding is invalid");
    }
    const currentGraph = this.#persistence?.getTaskGraph(graph.graphId) ?? graph;
    if (currentGraph.revision !== graph.revision) throw new DeviceFabricError("revision_conflict", "task graph revision is stale");
    const node = currentGraph.nodes.find(item => item.nodeId === nodeId);
    if (!node) throw new DeviceFabricError("target_missing", "task graph node is missing");
    if (node.attemptId === attemptId && node.ownerRouteGeneration === ownerRouteGeneration) return currentGraph;
    if (node.attemptId || (node.ownerRouteGeneration !== undefined && node.ownerRouteGeneration !== ownerRouteGeneration)
      || !this.readyNodes(currentGraph).some(item => item.nodeId === nodeId)) {
      throw new DeviceFabricError("target_changed", "task graph node cannot bind this attempt");
    }
    const nodes = currentGraph.nodes.map(item => item.nodeId === nodeId
      ? { ...item, status: "executing" as const, attemptId, attemptGraphRevision: currentGraph.revision + 1,
        ...(ownerRouteGeneration === undefined ? {} : { ownerRouteGeneration }) }
      : item);
    const next = this.updateNodes(currentGraph, nodes);
    this.#persistence?.saveTaskGraph(next);
    return next;
  }

  acquireOwnerLease(targetDeviceId: string, ownerId: string): void {
    const now = this.#now();
    if (this.#persistence) {
      if (!this.#persistence.acquireTaskGraphLease(targetDeviceId, ownerId, now, this.#leaseMs)) {
        throw new DeviceFabricError("lease_busy", "task graph target is leased by another owner");
      }
      return;
    }
    const current = this.#leases.get(targetDeviceId);
    if (current && current.ownerId !== ownerId && Date.parse(current.expiresAt) > Date.parse(now)) {
      throw new DeviceFabricError("lease_busy", "task graph target is leased by another owner");
    }
    this.#leases.set(targetDeviceId, { ownerId, expiresAt: new Date(Date.parse(now) + this.#leaseMs).toISOString() });
  }

  releaseOwnerLease(targetDeviceId: string, ownerId: string): void {
    if (this.#leases.get(targetDeviceId)?.ownerId === ownerId) this.#leases.delete(targetDeviceId);
    this.#persistence?.releaseTaskGraphLease(targetDeviceId, ownerId);
  }

  recordNodeResult(graph: DeviceTaskGraphV1, nodeId: string, status: DeviceTaskGraphNodeV1["status"], resultRef?: string): DeviceTaskGraphV1 {
    const currentGraph = this.#persistence?.getTaskGraph(graph.graphId) ?? graph;
    if (currentGraph.revision !== graph.revision) throw new DeviceFabricError("revision_conflict", "task graph revision is stale");
    const next = this.advanceNodeResult(currentGraph, nodeId, status, resultRef);
    this.#persistence?.saveTaskGraph(next);
    return next;
  }

  private advanceNodeResult(currentGraph: DeviceTaskGraphV1, nodeId: string, status: DeviceTaskGraphNodeV1["status"], resultRef?: string): DeviceTaskGraphV1 {
    this.validateGraph(currentGraph);
    const node = currentGraph.nodes.find(item => item.nodeId === nodeId);
    if (!node) throw new DeviceFabricError("target_missing", "task graph node is missing");
    if (currentGraph.cancellationRequestedAt && (node.status !== "unknown"
      || !resultRef || !["succeeded", "failed", "cancelled", "unknown"].includes(status))) {
      throw new DeviceFabricError("safety_denied", "a stopped graph only accepts terminal evidence for unresolved nodes");
    }
    const nodes = currentGraph.nodes.map(item => item.nodeId === nodeId ? { ...item, status, ...(resultRef ? { resultRef } : {}) } : item);
    return this.updateNodes(currentGraph, nodes);
  }

  private updateNodes(currentGraph: DeviceTaskGraphV1, nodes: readonly DeviceTaskGraphNodeV1[]): DeviceTaskGraphV1 {
    const graphStatus: DeviceTaskGraphV1["status"] = nodes.some(item => item.status === "unknown") ? "unknown"
      : currentGraph.cancellationRequestedAt ? "cancelled"
      : nodes.every(item => item.status === "succeeded") ? "succeeded"
      : nodes.some(item => ["executing", "verifying"].includes(item.status)) ? "executing"
      : nodes.every(item => item.status === "cancelled") ? "cancelled"
      : nodes.some(item => item.status === "succeeded") ? "partial"
      : nodes.some(item => item.status === "failed") ? "failed" : "planned";
    return { ...currentGraph, revision: currentGraph.revision + 1, status: graphStatus, nodes, updatedAt: this.#now() };
  }

  recordNodeReceipt(
    graph: DeviceTaskGraphV1,
    receipt: DeviceTaskGraphNodeReceiptV1,
    authenticatedOwner: Pick<DeviceTaskGraphNodeReceiptV1, "ownerKind" | "ownerId" | "routeGeneration">,
    authorize?: () => void,
  ): DeviceTaskGraphV1 {
    if (receipt.graphId !== graph.graphId || !Number.isSafeInteger(receipt.graphRevision) || receipt.graphRevision < 1
      || receipt.routeGeneration !== authenticatedOwner.routeGeneration || receipt.routeGeneration < 1
      || !Number.isSafeInteger(receipt.routeGeneration) || !Number.isFinite(Date.parse(receipt.receivedAt))) {
      throw new DeviceFabricError("revision_conflict", "task graph node receipt is stale or malformed");
    }
    if (receipt.ownerKind !== authenticatedOwner.ownerKind || receipt.ownerId !== authenticatedOwner.ownerId
      || !["succeeded", "failed", "cancelled", "unknown"].includes(receipt.status)
      || typeof receipt.resultRef !== "string" || !receipt.resultRef.trim() || receipt.resultRef.length > 512) {
      throw new DeviceFabricError("safety_denied", "task graph node receipt does not match its owner and attempt");
    }
    const advance = (current: DeviceTaskGraphV1) => {
      const node = current.nodes.find(item => item.nodeId === receipt.nodeId);
      const stoppedAttempt = current.cancellationRequestedAt && node?.status === "unknown" && node.attemptGraphRevision === receipt.graphRevision;
      const concurrentAttempt = node?.attemptGraphRevision === receipt.graphRevision
        && ["executing", "verifying", "unknown"].includes(node.status);
      if (current.revision !== receipt.graphRevision && !stoppedAttempt && !concurrentAttempt) {
        throw new DeviceFabricError("revision_conflict", "task graph node receipt is stale");
      }
      if (!node || !["executing", "verifying", "unknown"].includes(node.status)
        || node.ownerKind !== receipt.ownerKind || node.ownerId !== receipt.ownerId
        || node.targetDeviceId !== receipt.targetDeviceId || node.capabilitySnapshotId !== receipt.capabilitySnapshotId
        || !node.attemptId || receipt.attemptId !== node.attemptId
        || (node.ownerRouteGeneration !== undefined && node.ownerRouteGeneration !== authenticatedOwner.routeGeneration)) {
        throw new DeviceFabricError("safety_denied", "task graph node receipt does not match its owner and attempt");
      }
      return this.advanceNodeResult(current, receipt.nodeId, receipt.status, receipt.resultRef);
    };
    if (this.#persistence?.recordTaskGraphReceipt) return this.#persistence.recordTaskGraphReceipt(receipt, advance, authorize);
    authorize?.();
    const current = this.#persistence ? this.#persistence.getTaskGraph(graph.graphId) : graph;
    if (!current) throw new DeviceFabricError("target_missing", "task graph is missing");
    const next = advance(current);
    this.#persistence?.saveTaskGraph(next);
    return next;
  }

  cancelGraph(graph: DeviceTaskGraphV1): DeviceTaskGraphV1 {
    const currentGraph = this.#persistence?.getTaskGraph(graph.graphId) ?? graph;
    this.validateGraph(currentGraph);
    if (currentGraph.revision !== graph.revision) throw new DeviceFabricError("revision_conflict", "task graph revision is stale");
    if (currentGraph.cancellationRequestedAt || currentGraph.status === "succeeded" || currentGraph.status === "cancelled") return currentGraph;
    const nodes = currentGraph.nodes.map(node => {
      if (["unknown", "succeeded", "failed", "cancelled"].includes(node.status)) return node;
      const mayHaveDispatched = node.attemptId !== undefined || ["executing", "verifying", "partial"].includes(node.status);
      return { ...node, status: mayHaveDispatched ? "unknown" as const : "cancelled" as const };
    });
    const now = this.#now();
    const next: DeviceTaskGraphV1 = {
      ...currentGraph,
      revision: currentGraph.revision + 1,
      status: nodes.some(node => node.status === "unknown") ? "unknown" : "cancelled",
      nodes,
      cancellationRequestedAt: now,
      updatedAt: now,
    };
    this.#persistence?.saveTaskGraph(next);
    return next;
  }

  retryNode(graph: DeviceTaskGraphV1, nodeId: string): DeviceTaskGraphV1 {
    const currentGraph = this.#persistence?.getTaskGraph(graph.graphId) ?? graph;
    this.validateGraph(currentGraph);
    if (currentGraph.revision !== graph.revision) throw new DeviceFabricError("revision_conflict", "task graph revision is stale");
    const target = currentGraph.nodes.find(node => node.nodeId === nodeId);
    if (!target) throw new DeviceFabricError("target_missing", "task graph node is missing");
    if (currentGraph.cancellationRequestedAt || currentGraph.status === "cancelled"
      || currentGraph.nodes.some(node => node.targetDeviceId === target.targetDeviceId
        && ["unknown", "executing", "verifying", "partial"].includes(node.status))) {
      throw new DeviceFabricError("safety_denied", "the graph is stopped or the target has an unresolved attempt");
    }
    if (target.status !== "failed") throw new DeviceFabricError("invalid_graph", "only a failed task graph node can be retried");
    if (target.attemptId || target.resultRef) throw new DeviceFabricError("safety_denied", "retry requires a failure before dispatch");
    const nodes = currentGraph.nodes.map(node => node.nodeId === nodeId ? { ...node, status: "planning" as const } : node);
    const status = nodes.some(node => node.status === "failed") ? "failed" : "planned";
    const next: DeviceTaskGraphV1 = { ...currentGraph, revision: currentGraph.revision + 1, status, nodes, updatedAt: this.#now() };
    this.#persistence?.saveTaskGraph(next);
    return next;
  }
}

export interface DeviceTaskGraphPersistence {
  getTaskGraph(graphId: string): DeviceTaskGraphV1 | undefined;
  saveTaskGraph(graph: DeviceTaskGraphV1): DeviceTaskGraphV1;
  recordTaskGraphReceipt?(
    receipt: DeviceTaskGraphNodeReceiptV1,
    advance: (current: DeviceTaskGraphV1) => DeviceTaskGraphV1,
    authorize?: () => void,
  ): DeviceTaskGraphV1;
  acquireTaskGraphLease(targetDeviceId: string, ownerId: string, now: string, leaseMs: number): boolean;
  releaseTaskGraphLease(targetDeviceId: string, ownerId: string): void;
}

export class EdgeRuntimeRegistry {
  readonly #runtimes = new Map<string, EdgeRuntimeEnrollmentV1>();
  readonly #persistence?: EdgeRuntimePersistence;

  constructor(options: { readonly persistence?: EdgeRuntimePersistence } = {}) {
    this.#persistence = options.persistence;
  }

  enroll(runtime: EdgeRuntimeEnrollmentV1): EdgeRuntimeEnrollmentV1 {
    const current = this.get(runtime.runtimeId);
    if (current && runtime.revision <= current.revision) throw new DeviceFabricError("revision_conflict", "edge runtime revision must advance");
    const enrolled = { ...runtime, status: "enrolled" as const };
    this.#persistence?.saveEdgeRuntime(enrolled);
    this.#runtimes.set(runtime.runtimeId, enrolled);
    return enrolled;
  }

  revoke(runtimeId: string, revision: number): EdgeRuntimeEnrollmentV1 {
    const current = this.get(runtimeId);
    if (!current) throw new DeviceFabricError("target_missing", "edge runtime is missing");
    const revoked = { ...current, status: "revoked" as const, revision };
    this.#persistence?.saveEdgeRuntime(revoked);
    this.#runtimes.set(runtimeId, revoked);
    return revoked;
  }

  get(runtimeId: string): EdgeRuntimeEnrollmentV1 | undefined {
    return this.#persistence?.getEdgeRuntime(runtimeId) ?? this.#runtimes.get(runtimeId);
  }

  list(): readonly EdgeRuntimeEnrollmentV1[] {
    return this.#persistence?.listEdgeRuntimes?.() ?? [...this.#runtimes.values()];
  }
}

export class EdgeRuntimePlacementPolicy {
  decide(input: {
    readonly runtime: EdgeRuntimeEnrollmentV1;
    readonly ownerTaskId: string;
    readonly targetDeviceId: string;
    readonly capabilityId: string;
    readonly sideEffect: CapabilitySideEffectV1;
    readonly hasLocalExecutor: boolean;
    readonly offlineRecoverySupported: boolean;
    readonly evaluatedAt: string;
  }): EdgeRuntimePlacementDecisionV1 {
    let mode: EdgeRuntimePlacementModeV1;
    let reason: EdgeRuntimePlacementDecisionV1["reason"];
    if (input.runtime.status === "revoked") {
      mode = "blocked";
      reason = "runtime_revoked";
    } else if (input.runtime.status === "pending") {
      mode = "blocked";
      reason = "runtime_pending";
    } else if (input.runtime.status === "enrolled") {
      mode = "local";
      reason = "runtime_available";
    } else if (input.sideEffect === "read_only" && input.hasLocalExecutor) {
      mode = "local";
      reason = "offline_read_fallback";
    } else if (input.offlineRecoverySupported && ["reversible", "mutating"].includes(input.sideEffect)) {
      mode = "queued";
      reason = "offline_recovery_queued";
    } else {
      mode = "blocked";
      reason = "offline_write_unsupported";
    }
    const binding = {
      runtimeId: input.runtime.runtimeId,
      runtimeRevision: input.runtime.revision,
      ownerTaskId: input.ownerTaskId,
      targetDeviceId: input.targetDeviceId,
      capabilityId: input.capabilityId,
    };
    const decision = {
      decisionId: edgeRuntimePlacementDecisionId(binding),
      ...binding,
      sideEffect: input.sideEffect,
      mode,
      reason,
      evaluatedAt: input.evaluatedAt,
    };
    assertEdgeRuntimePlacementDecision(decision);
    return decision;
  }
}

export interface EdgeRuntimePersistence {
  getEdgeRuntime(runtimeId: string): EdgeRuntimeEnrollmentV1 | undefined;
  saveEdgeRuntime(runtime: EdgeRuntimeEnrollmentV1): EdgeRuntimeEnrollmentV1;
  listEdgeRuntimes?(): readonly EdgeRuntimeEnrollmentV1[];
}

/** Projects device registrations, capability observations and edge runtime enrollment. */
export class DeviceFleetProjection {
  build(input: {
    readonly projectionId: string;
    readonly ownerScope: string;
    readonly generatedAt: string;
    readonly profiles: readonly DeviceProfileV1[];
    readonly snapshots?: ReadonlyMap<string, DeviceCapabilitySnapshotV1>;
    readonly runtimes?: readonly EdgeRuntimeEnrollmentV1[];
    readonly staleAfterMs?: number;
  }): DeviceFleetHealthProjectionV1 {
    if (!input.projectionId.trim() || !input.ownerScope.trim() || !Number.isFinite(Date.parse(input.generatedAt))) {
      throw new DeviceFabricError("revision_conflict", "fleet projection identity or timestamp is invalid");
    }
    const staleAfterMs = input.staleAfterMs ?? 5 * 60_000;
    if (!Number.isInteger(staleAfterMs) || staleAfterMs < 0) throw new DeviceFabricError("revision_conflict", "fleet stale window is invalid");
    const runtimeById = new Map((input.runtimes ?? []).map(runtime => [runtime.runtimeId, runtime]));
    const seen = new Set<string>();
    const items = input.profiles
      .filter(profile => profile.device.ownerScope === input.ownerScope)
      .map(profile => {
        if (seen.has(profile.device.id)) throw new DeviceFabricError("revision_conflict", "fleet projection contains a duplicate device");
        seen.add(profile.device.id);
        const runtime = profile.device.runtimeOwnerId ? runtimeById.get(profile.device.runtimeOwnerId) : undefined;
        const snapshot = input.snapshots?.get(profile.device.id);
        return this.projectItem(profile, snapshot, runtime, input.generatedAt, staleAfterMs);
      })
      .sort((left, right) => left.deviceId < right.deviceId ? -1 : 1);
    const counts = {
      healthy: 0, degraded: 0, offline: 0, maintenance: 0, revoked: 0, retired: 0, unknown: 0,
    } satisfies Record<DeviceFleetHealthStatusV1, number>;
    for (const item of items) counts[item.health] += 1;
    return { projectionId: input.projectionId, ownerScope: input.ownerScope, generatedAt: input.generatedAt, items, counts };
  }

  private projectItem(
    profile: DeviceProfileV1,
    candidate: DeviceCapabilitySnapshotV1 | undefined,
    runtime: EdgeRuntimeEnrollmentV1 | undefined,
    evaluatedAt: string,
    staleAfterMs: number,
  ): DeviceFleetHealthItemV1 {
    const reasons: string[] = [];
    let health: DeviceFleetHealthStatusV1;
    switch (profile.device.lifecycleStatus) {
      case "retired": health = "retired"; reasons.push("device_retired"); break;
      case "revoked": health = "revoked"; reasons.push("device_revoked"); break;
      case "maintenance": health = "maintenance"; reasons.push("maintenance_scheduled"); break;
      case "offline": health = "offline"; reasons.push("device_offline"); break;
      case "degraded": health = "degraded"; reasons.push("device_degraded"); break;
      case "healthy": health = "healthy"; break;
      default: health = "unknown"; reasons.push("lifecycle_not_operational"); break;
    }
    const asOf = Date.parse(evaluatedAt);
    const snapshot = candidate?.deviceId === profile.device.id && candidate.adapterId === profile.adapterId
      && candidate.adapterVersion === profile.adapterVersion && Date.parse(candidate.observedAt) <= asOf ? candidate : undefined;
    const discoverySeen = profile.device.lastSeenAt;
    const lastSeenAt = snapshot && (!discoverySeen || Date.parse(snapshot.observedAt) > Date.parse(discoverySeen))
      ? snapshot.observedAt : discoverySeen;
    if (health === "healthy" && lastSeenAt !== undefined && asOf - Date.parse(lastSeenAt) > staleAfterMs) {
      health = "degraded";
      reasons.push("last_seen_stale");
    }
    if (runtime) {
      if (runtime.status === "revoked") { health = health === "retired" ? health : "revoked"; reasons.push("runtime_revoked"); }
      else if (runtime.status === "offline") { health = health === "retired" || health === "revoked" ? health : "offline"; reasons.push("runtime_offline"); }
      else if (runtime.status === "pending" && health === "healthy") { health = "degraded"; reasons.push("runtime_pending"); }
      if (runtime.lastSeenAt !== undefined && asOf - Date.parse(runtime.lastSeenAt) > staleAfterMs
        && health === "healthy") { health = "degraded"; reasons.push("runtime_last_seen_stale"); }
    }
    return {
      deviceId: profile.device.id,
      ownerScope: profile.device.ownerScope,
      displayName: profile.device.displayName,
      kind: profile.device.kind,
      lifecycleStatus: profile.device.lifecycleStatus,
      health,
      adapterId: profile.adapterId,
      adapterVersion: profile.adapterVersion,
      profileRevision: profile.profileRevision,
      ...(profile.device.firmwareVersion ? { firmwareVersion: profile.device.firmwareVersion } : {}),
      ...(snapshot ? { capabilitySnapshotId: snapshot.snapshotId } : {}),
      ...(profile.device.runtimeOwnerId ? { runtimeOwnerId: profile.device.runtimeOwnerId } : {}),
      ...(lastSeenAt ? { lastSeenAt } : {}),
      ...(runtime ? {
        runtimeStatus: runtime.status, runtimeRevision: runtime.revision,
        ...(runtime.lastSeenAt ? { runtimeLastSeenAt: runtime.lastSeenAt } : {}),
      } : {}),
      reasons: [...new Set(reasons)],
      evaluatedAt,
    };
  }
}

export class EdgeBridgeSession {
  readonly #runtimeId: string;
  readonly #ownerTaskId: string;
  #lastReceivedSequence = 0;
  #lastSentSequence = 0;

  constructor(runtimeId: string, ownerTaskId: string) {
    this.#runtimeId = runtimeId;
    this.#ownerTaskId = ownerTaskId;
  }

  accept(frame: DeviceBridgeFrameV1): DeviceBridgeFrameV1 {
    if (frame.runtimeId !== this.#runtimeId || frame.ownerTaskId !== this.#ownerTaskId) throw new DeviceFabricError("safety_denied", "edge bridge frame authority does not match the session");
    if (frame.sequence !== this.#lastReceivedSequence + 1) throw new DeviceFabricError("revision_conflict", "edge bridge sequence is not contiguous");
    this.#lastReceivedSequence = frame.sequence;
    return frame;
  }

  next(direction: DeviceBridgeFrameV1["direction"], payload: DeviceBridgeFrameV1["payload"], sentAt: string): DeviceBridgeFrameV1 {
    const frame: DeviceBridgeFrameV1 = {
      frameId: `${this.#runtimeId}:${this.#ownerTaskId}:${this.#lastSentSequence + 1}`,
      runtimeId: this.#runtimeId,
      ownerTaskId: this.#ownerTaskId,
      direction,
      sequence: this.#lastSentSequence + 1,
      payload,
      sentAt,
    };
    this.#lastSentSequence += 1;
    return frame;
  }
}

export interface EdgeRuntimeJournalPersistence {
  appendEdgeRuntimeJournalEntry(entry: EdgeRuntimeJournalEntryV1): { readonly entry: EdgeRuntimeJournalEntryV1; readonly replayed: boolean };
  listEdgeRuntimeJournalEntries(runtimeId: string, ownerTaskId: string, afterSequence?: number, limit?: number): readonly EdgeRuntimeJournalEntryV1[];
}

/** Durable per-task edge evidence. Unknown outcomes remain visible after reconnect. */
export class EdgeRuntimeJournal {
  readonly #persistence?: EdgeRuntimeJournalPersistence;
  readonly #entries = new Map<string, EdgeRuntimeJournalEntryV1[]>();
  readonly #entryIds = new Map<string, EdgeRuntimeJournalEntryV1>();

  constructor(options: { readonly persistence?: EdgeRuntimeJournalPersistence } = {}) {
    this.#persistence = options.persistence;
  }

  append(entry: EdgeRuntimeJournalEntryV1): { readonly entry: EdgeRuntimeJournalEntryV1; readonly replayed: boolean } {
    if (this.#persistence) return this.#persistence.appendEdgeRuntimeJournalEntry(entry);
    assertEdgeRuntimeJournalEntry(entry);
    const key = JSON.stringify([entry.runtimeId, entry.ownerTaskId]);
    const existing = this.#entries.get(key) ?? [];
    const saved = JSON.parse(JSON.stringify(entry)) as EdgeRuntimeJournalEntryV1;
    const byId = this.#entryIds.get(entry.entryId);
    if (byId) {
      if (!isDeepStrictEqual(byId, saved)) throw new DeviceFabricError("revision_conflict", "edge journal entry id is bound to another entry");
      return { entry: structuredClone(byId), replayed: true };
    }
    if (entry.sequence !== existing.length + 1) throw new DeviceFabricError("revision_conflict", "edge journal sequence is not contiguous");
    existing.push(saved);
    this.#entries.set(key, existing);
    this.#entryIds.set(entry.entryId, saved);
    return { entry, replayed: false };
  }

  read(runtimeId: string, ownerTaskId: string, afterSequence = 0, limit = 100): readonly EdgeRuntimeJournalEntryV1[] {
    if (!runtimeId.trim() || !ownerTaskId.trim() || !Number.isSafeInteger(afterSequence) || afterSequence < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new DeviceFabricError("revision_conflict", "edge journal cursor is invalid");
    }
    if (this.#persistence) return this.#persistence.listEdgeRuntimeJournalEntries(runtimeId, ownerTaskId, afterSequence, limit);
    return structuredClone((this.#entries.get(JSON.stringify([runtimeId, ownerTaskId])) ?? []).slice(afterSequence, afterSequence + limit));
  }
}

export class DeviceEventBus {
  readonly #events: DeviceEventEnvelopeV1[] = [];
  constructor(readonly maxEvents = 2_000) {}

  append(event: DeviceEventEnvelopeV1): DeviceEventEnvelopeV1 {
    const last = this.#events.at(-1);
    if (last && event.sequence <= last.sequence) throw new DeviceFabricError("revision_conflict", "device event sequence is not monotonic");
    this.#events.push(event);
    while (this.#events.length > this.maxEvents) this.#events.shift();
    return event;
  }

  read(afterSequence = 0, limit = 100): readonly DeviceEventEnvelopeV1[] {
    if (this.#events.length && afterSequence < this.#events[0]!.sequence - 1) throw new DeviceFabricError("revision_conflict", "event cursor is too old");
    return this.#events.filter(event => event.sequence > afterSequence).slice(0, limit);
  }
}

export class DeviceResourceRegistry {
  readonly #installed = new Map<string, { manifest: DeviceResourceManifestV1; payloadDigest: string }>();
  readonly #history = new Map<string, { manifest: DeviceResourceManifestV1; payloadDigest: string }[]>();

  install(manifest: DeviceResourceManifestV1, payload: Uint8Array): void {
    if (!manifest.resourceId || !manifest.version || !manifest.license || !manifest.signature || !manifest.entrypoint
      || manifest.dependencies.includes(manifest.resourceId) || new Set(manifest.dependencies).size !== manifest.dependencies.length) {
      throw new DeviceFabricError("resource_conflict", "resource manifest is incomplete or has invalid dependencies");
    }
    const digest = createHash("sha256").update(payload).digest("hex");
    if (digest !== manifest.digest) throw new DeviceFabricError("resource_conflict", "resource digest does not match manifest");
    const current = this.#installed.get(manifest.resourceId);
    if (current?.manifest.version === manifest.version && current.payloadDigest === digest) return;
    const history = this.#history.get(manifest.resourceId) ?? [];
    if (current) history.push(current);
    this.#history.set(manifest.resourceId, history);
    this.#installed.set(manifest.resourceId, { manifest, payloadDigest: digest });
  }

  rollback(resourceId: string): DeviceResourceManifestV1 {
    const history = this.#history.get(resourceId) ?? [];
    const previous = history.pop();
    if (!previous) throw new DeviceFabricError("resource_conflict", "resource has no rollback revision");
    this.#installed.set(resourceId, previous);
    return previous.manifest;
  }

  get(resourceId: string): DeviceResourceManifestV1 | undefined { return this.#installed.get(resourceId)?.manifest; }
}

export class DeviceSafetyBroker {
  authorize(context: DeviceSafetyContextV1, requiredPhysicalState: DeviceSafetyContextV1["physicalState"], secretRefs: readonly string[]): void {
    if (context.emergencyStop) throw new DeviceFabricError("safety_denied", "emergency stop is active");
    if (requiredPhysicalState !== "unknown" && context.physicalState !== requiredPhysicalState) {
      throw new DeviceFabricError("safety_denied", "physical precondition is not satisfied");
    }
    if (secretRefs.some(secretRef => !context.requiredSecretRefs.includes(secretRef))) {
      throw new DeviceFabricError("safety_denied", "required secret reference is not authorized");
    }
  }

  evaluate(input: {
    readonly decisionId: string;
    readonly targetDeviceId: string;
    readonly context: DeviceSafetyContextV1;
    readonly policy: DeviceSafetyActionPolicyV1;
    readonly controllerReady: boolean;
    readonly operatorHandoffConfirmed: boolean;
    readonly cancellationRequested: boolean;
    readonly controllerEvidence?: DeviceSafetyControllerEvidenceV1;
    readonly evaluatedAt?: string;
  }): DeviceSafetyDecisionV1 {
    const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
    const age = Date.parse(evaluatedAt) - Date.parse(input.context.observedAt);
    const maxAge = input.policy.maxObservationAgeMs ?? 30_000;
    const vendorHandoff = input.policy.controller === "vendor_workflow";
    let reason: string | undefined;
    if (!input.decisionId.trim() || !input.policy.policyRevision.trim() || !input.policy.capabilityId.trim()) reason = "invalid_safety_identity";
    else if (!input.targetDeviceId.trim() || input.targetDeviceId !== input.context.targetDeviceId) reason = "physical_target_mismatch";
    else if (input.context.policyRevision !== input.policy.policyRevision) reason = "policy_revision_changed";
    else if (!Number.isSafeInteger(maxAge) || maxAge < 1 || !(age >= 0 && age <= maxAge)) reason = "safety_observation_stale";
    else if (input.context.emergencyStop) reason = "emergency_stop_active";
    else if (input.policy.requiredPhysicalState !== "unknown" && input.context.physicalState !== input.policy.requiredPhysicalState) reason = "physical_precondition_unsatisfied";
    else if (input.policy.requiredSecretRefs.some(secretRef => !input.context.requiredSecretRefs.includes(secretRef))) reason = "secret_reference_unauthorized";
    else if (!input.controllerReady) reason = "safety_controller_unavailable";
    else if (input.controllerEvidence && !validControllerEvidence(input.controllerEvidence, input.targetDeviceId, input.policy, evaluatedAt)) reason = "safety_controller_evidence_invalid";
    else if (input.policy.sideEffect === "critical" && input.policy.controller === "adapter") reason = "critical_action_requires_controller_or_handoff";
    else if ((vendorHandoff || input.policy.operatorHandoffRequired) && !input.operatorHandoffConfirmed) reason = "operator_handoff_required";
    else if (input.cancellationRequested && !input.policy.cancellationSupported) reason = "cancellation_unsupported";
    return {
      decisionId: input.decisionId,
      targetDeviceId: input.targetDeviceId,
      capabilityId: input.policy.capabilityId,
      policyRevision: input.policy.policyRevision,
      status: reason ? "denied" : vendorHandoff ? "handoff_ready" : "authorized",
      ...(reason ? { reason } : {}),
      evaluatedAt,
    };
  }
}

function validControllerEvidence(
  evidence: DeviceSafetyControllerEvidenceV1,
  targetDeviceId: string,
  policy: DeviceSafetyActionPolicyV1,
  evaluatedAt: string,
): boolean {
  return evidence.targetDeviceId === targetDeviceId && evidence.capabilityId === policy.capabilityId
    && evidence.policyRevision === policy.policyRevision && evidence.controller === policy.controller
    && evidence.controllerId.trim().length > 0 && /^[0-9a-f]{64}$/u.test(evidence.readinessDigest)
    && (evidence.handoffDigest === undefined || /^[0-9a-f]{64}$/u.test(evidence.handoffDigest))
    && Number.isFinite(Date.parse(evidence.observedAt)) && Number.isFinite(Date.parse(evidence.expiresAt))
    && Date.parse(evidence.observedAt) <= Date.parse(evaluatedAt) && Date.parse(evidence.expiresAt) > Date.parse(evaluatedAt)
    && (policy.operatorHandoffRequired ? Boolean(evidence.operatorId && evidence.handoffDigest) : true);
}

export class DeviceLifecycleManager {
  readonly #records = new Map<string, DeviceLifecycleRecordV1>();

  transition(input: DeviceLifecycleRecordV1): DeviceLifecycleRecordV1 {
    const current = this.#records.get(input.deviceId);
    if (!current && input.status !== "discovered") throw new DeviceFabricError("lifecycle_invalid", "device lifecycle must start at discovered");
    if (current && (input.revision <= current.revision || !isAllowedDeviceLifecycleTransition(current.status, input.status))) throw new DeviceFabricError("lifecycle_invalid", "device lifecycle transition is invalid");
    this.#records.set(input.deviceId, input);
    return input;
  }

  get(deviceId: string): DeviceLifecycleRecordV1 | undefined { return this.#records.get(deviceId); }
}

export class DeviceContextBuilder {
  build(input: DeviceContextPackV1): DeviceContextPackV1 {
    const pack: DeviceContextPackV1 = {
      contextId: input.contextId,
      taskId: input.taskId,
      maxBytes: input.maxBytes,
      facts: input.facts,
      hypotheses: input.hypotheses,
      observations: input.observations,
      untrustedTextRefs: input.untrustedTextRefs,
      ...(input.factMetadata && input.factMetadata.length > 0 ? { factMetadata: input.factMetadata } : {}),
      ...(input.targets ? { targets: input.targets } : {}),
      ...(input.policyRevision ? { policyRevision: input.policyRevision } : {}),
      generatedAt: input.generatedAt,
    };
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
      throw new DeviceFabricError("revision_conflict", "device context pack budget is invalid");
    }
    if (Buffer.byteLength(JSON.stringify(pack), "utf8") > input.maxBytes) throw new DeviceFabricError("revision_conflict", "device context pack exceeds its bound");
    return pack;
  }

  buildFromObservations(input: {
    readonly contextId: string;
    readonly taskId: string;
    readonly maxBytes: number;
    readonly observations: readonly {
      readonly id: string;
      readonly value: unknown;
      readonly quality: "good" | "degraded" | "stale" | "unknown";
      readonly redactionClass: "public" | "sensitive" | "secret_adjacent";
      readonly source: string;
      readonly observedAt?: string;
      readonly freshnessUntil?: string;
    }[];
    readonly projectFact: (value: unknown, source: string) => JsonValue | undefined;
    readonly generatedAt: string;
  }): DeviceContextPackV1 {
    const facts: JsonValue[] = [];
    const untrustedTextRefs: string[] = [];
    const factMetadata: DeviceContextFactMetadataV1[] = [];
    const observationRefs = input.observations.map(observation => observation.id);
    for (const observation of input.observations) {
      const fresh = observation.freshnessUntil === undefined
        ? true
        : Number.isFinite(Date.parse(observation.freshnessUntil)) && Date.parse(observation.freshnessUntil) > Date.parse(input.generatedAt);
      const visible = observation.quality === "good" && observation.redactionClass === "public" && fresh;
      const fact = visible ? input.projectFact(observation.value, observation.source) : undefined;
      if (fact !== undefined) {
        facts.push(fact);
        factMetadata.push({ observationId: observation.id, source: observation.source, ...(observation.observedAt ? { observedAt: observation.observedAt } : {}), ...(observation.freshnessUntil ? { freshnessUntil: observation.freshnessUntil } : {}), quality: observation.quality, redactionClass: observation.redactionClass });
      }
      else untrustedTextRefs.push(observation.id);
    }
    return this.build({
      contextId: input.contextId,
      taskId: input.taskId,
      maxBytes: input.maxBytes,
      facts,
      hypotheses: [],
      observations: observationRefs,
      untrustedTextRefs,
      factMetadata,
      generatedAt: input.generatedAt,
    });
  }
}

export class DeviceTraceRecorder {
  readonly #spans = new Map<string, DeviceTraceSpanV1>();

  start(span: DeviceTraceSpanV1): DeviceTraceSpanV1 {
    if (!span.spanId.trim() || !span.traceId.trim() || !span.sourceId.trim() || !Number.isFinite(Date.parse(span.startedAt))) {
      throw new DeviceFabricError("revision_conflict", "trace span identity or start time is invalid");
    }
    const existing = this.#spans.get(span.spanId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(span)) throw new DeviceFabricError("revision_conflict", "trace span id is bound to another span");
    if (span.parentSpanId) {
      const parent = this.#spans.get(span.parentSpanId);
      if (!parent || parent.traceId !== span.traceId) throw new DeviceFabricError("target_missing", "trace span parent is unavailable");
    }
    this.#spans.set(span.spanId, span);
    return span;
  }
  finish(spanId: string, finishedAt: string, status: DeviceTraceSpanV1["status"]): DeviceTraceSpanV1 {
    const current = this.#spans.get(spanId);
    if (!current) throw new DeviceFabricError("target_missing", "trace span is missing");
    if (!Number.isFinite(Date.parse(finishedAt)) || Date.parse(finishedAt) < Date.parse(current.startedAt)) throw new DeviceFabricError("revision_conflict", "trace span finish time is invalid");
    if (current.finishedAt) {
      if (current.finishedAt !== finishedAt || current.status !== status) throw new DeviceFabricError("revision_conflict", "finished trace span cannot be changed");
      return current;
    }
    const finished = { ...current, finishedAt, status };
    this.#spans.set(spanId, finished);
    return finished;
  }
  report(input: Omit<DeviceConformanceReportV1, "generatedAt"> & { readonly generatedAt?: string }): DeviceConformanceReportV1 {
    return { ...input, generatedAt: input.generatedAt ?? new Date().toISOString() };
  }
}

function hasCycle(nodes: readonly DeviceTaskGraphNodeV1[]): boolean {
  const graph = new Map(nodes.map(node => [node.nodeId, node.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const dependency of graph.get(nodeId) ?? []) if (visit(dependency)) return true;
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return nodes.some(node => visit(node.nodeId));
}

const edgeJournalOutcomes = {
  task_started: "pending", frame_sent: "sent", frame_received: "received",
  task_completed: "completed", task_failed: "failed", task_unknown: "unknown", task_cancelled: "cancelled",
} as const;

function assertEdgeRuntimePlacementDecision(decision: EdgeRuntimePlacementDecisionV1): void {
  const bounded = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 512;
  if (![decision.runtimeId, decision.ownerTaskId, decision.targetDeviceId, decision.capabilityId].every(bounded)
    || !Number.isSafeInteger(decision.runtimeRevision) || decision.runtimeRevision < 1
    || !CAPABILITY_SIDE_EFFECTS_V1.includes(decision.sideEffect)
    || !Number.isFinite(Date.parse(decision.evaluatedAt))) {
    throw new DeviceFabricError("revision_conflict", "edge placement decision is invalid");
  }
}

export function edgeRuntimePlacementDecisionId(binding: Pick<EdgeRuntimePlacementDecisionV1,
  "runtimeId" | "runtimeRevision" | "ownerTaskId" | "targetDeviceId" | "capabilityId">): string {
  const identity = [binding.runtimeId, binding.runtimeRevision, binding.ownerTaskId, binding.targetDeviceId, binding.capabilityId];
  return `edge_placement_${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

export function assertEdgeRuntimeJournalEntry(value: unknown): asserts value is EdgeRuntimeJournalEntryV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DeviceFabricError("revision_conflict", "edge journal entry is invalid");
  const entry = value as Record<string, unknown>;
  const fields = ["entryId", "runtimeId", "ownerTaskId", "operationId", "sequence", "recordedAt", "kind", "outcome", "payloadDigest", "networkObservation"];
  if (Object.keys(entry).some(key => !fields.includes(key))
    || [entry.entryId, entry.runtimeId, entry.ownerTaskId, entry.operationId].some(id => typeof id !== "string" || !id.trim() || id.length > 512)
    || typeof entry.sequence !== "number" || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1
    || typeof entry.recordedAt !== "string" || !Number.isFinite(Date.parse(entry.recordedAt))
    || typeof entry.kind !== "string" || !Object.hasOwn(edgeJournalOutcomes, entry.kind)
    || edgeJournalOutcomes[entry.kind as keyof typeof edgeJournalOutcomes] !== entry.outcome
    || entry.payloadDigest !== undefined && (typeof entry.payloadDigest !== "string" || !/^[0-9a-f]{64}$/u.test(entry.payloadDigest))) {
    throw new DeviceFabricError("revision_conflict", "edge journal entry is invalid");
  }
  if (entry.networkObservation !== undefined) {
    const observation = entry.networkObservation as { connected?: unknown } | null;
    if (entry.kind !== "task_completed" || !observation || typeof observation !== "object" || Object.keys(observation).length !== 1
      || typeof observation.connected !== "boolean"
      || createHash("sha256").update(JSON.stringify({ connected: observation.connected })).digest("hex") !== entry.payloadDigest) {
      throw new DeviceFabricError("revision_conflict", "edge network observation is invalid");
    }
  }
}

export function assertIdentityChange(change: DeviceIdentityChangeV1, operation: DeviceIdentityChangeV1["operation"]): void {
  const evidence = change.evidence;
  const isBoundedId = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 512;
  if (Object.keys(change).some(key => !["changeId", "operation", "nodeId", "identityRef", "newNodeId", "evidence", "authority", "revision", "changedAt"].includes(key))
    || change.operation !== operation
    || ![change.changeId, change.nodeId, change.identityRef, change.authority].every(isBoundedId)
    || (operation === "split" ? !isBoundedId(change.newNodeId) || change.newNodeId === change.nodeId : change.newNodeId !== undefined)
    || !Number.isSafeInteger(change.revision) || change.revision < 1
    || !Number.isFinite(Date.parse(change.changedAt))
    || !evidence || Object.keys(evidence).some(key => !["kind", "source", "evidenceRef", "observedAt", "confirmationDigest"].includes(key))
    || !["adapter", "operator"].includes(evidence.kind)
    || ![evidence.source, evidence.evidenceRef].every(isBoundedId)
    || !Number.isFinite(Date.parse(evidence.observedAt)) || Date.parse(evidence.observedAt) > Date.parse(change.changedAt)
    || evidence.kind === "operator" && (!evidence.confirmationDigest || !/^[0-9a-f]{64}$/u.test(evidence.confirmationDigest))
    || evidence.kind === "adapter" && evidence.confirmationDigest !== undefined) {
    throw new DeviceFabricError("safety_denied", "identity change evidence is invalid");
  }
}

export function assertIdentitySplitDestination(sourceNodeId: string, identityRef: string, destination: DeviceGraphNodeV1, exists: boolean): void {
  if (sourceNodeId === destination.nodeId || exists || destination.identityRefs.length !== 1 || destination.identityRefs[0] !== identityRef) {
    throw new DeviceFabricError("revision_conflict", "identity split requires a new node carrying the selected identity");
  }
}

export function isAllowedDeviceLifecycleTransition(from: DeviceLifecycleRecordV1["status"], to: DeviceLifecycleRecordV1["status"]): boolean {
  const transitions: Record<DeviceLifecycleRecordV1["status"], readonly DeviceLifecycleRecordV1["status"][]> = {
    discovered: ["identified", "revoked", "retired"],
    identified: ["enrolled", "revoked", "retired"],
    enrolled: ["healthy", "degraded", "offline", "maintenance", "revoked", "retired"],
    healthy: ["degraded", "offline", "maintenance", "upgraded", "revoked", "retired"],
    degraded: ["healthy", "offline", "maintenance", "upgraded", "revoked", "retired"],
    offline: ["healthy", "maintenance", "revoked", "retired", "recovered"],
    maintenance: ["healthy", "degraded", "offline", "upgraded", "revoked", "retired"],
    upgraded: ["healthy", "degraded", "maintenance", "revoked", "retired"],
    recovered: ["healthy", "degraded", "maintenance", "revoked", "retired"],
    revoked: ["retired"],
    retired: [],
  };
  return transitions[from].includes(to);
}
