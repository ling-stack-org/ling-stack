import { createHash } from "node:crypto";
import type {
  DeviceConformanceReportV1,
  DeviceContextFactMetadataV1,
  DeviceContextPackV1,
  DeviceEventEnvelopeV1,
  DeviceBridgeFrameV1,
  DeviceGraphNodeV1,
  DeviceGraphRelationshipV1,
  DeviceLifecycleRecordV1,
  DeviceResourceManifestV1,
  DeviceSafetyContextV1,
  DeviceTaskGraphNodeV1,
  DeviceTaskGraphV1,
  DeviceTraceSpanV1,
  DeviceTransportDeploymentV1,
  DeviceTwinV1,
  DeviceTwinValueV1,
  EdgeRuntimeEnrollmentV1,
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
    this.#nodes.set(nodeId, next);
    return next;
  }

  splitIdentity(nodeId: string, identityRef: string, newNode: DeviceGraphNodeV1): DeviceGraphNodeV1 {
    const node = this.#nodes.get(nodeId);
    if (!node || !node.identityRefs.includes(identityRef)) throw new DeviceFabricError("target_missing", "identity reference is not attached");
    this.#nodes.set(nodeId, { ...node, identityRefs: node.identityRefs.filter(ref => ref !== identityRef), revision: Math.max(node.revision, newNode.revision) });
    return this.upsertNode(newNode);
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
  readonly #leases = new Map<string, string>();
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
    const nodes = new Map(graph.nodes.map(node => [node.nodeId, node]));
    return graph.nodes.filter(node => node.status === "planning" || node.status === "created")
      .filter(node => node.dependencies.every(dependency => nodes.get(dependency)?.status === "succeeded"));
  }

  acquireOwnerLease(targetDeviceId: string, ownerId: string): void {
    const current = this.#leases.get(targetDeviceId);
    if (current && current !== ownerId) throw new DeviceFabricError("lease_busy", "task graph target is leased by another owner");
    if (this.#persistence && !this.#persistence.acquireTaskGraphLease(targetDeviceId, ownerId, this.#now(), this.#leaseMs)) {
      throw new DeviceFabricError("lease_busy", "task graph target is leased by another owner");
    }
    this.#leases.set(targetDeviceId, ownerId);
  }

  releaseOwnerLease(targetDeviceId: string, ownerId: string): void {
    if (this.#leases.get(targetDeviceId) === ownerId) this.#leases.delete(targetDeviceId);
    this.#persistence?.releaseTaskGraphLease(targetDeviceId, ownerId);
  }

  recordNodeResult(graph: DeviceTaskGraphV1, nodeId: string, status: DeviceTaskGraphNodeV1["status"], resultRef?: string): DeviceTaskGraphV1 {
    const currentGraph = this.#persistence?.getTaskGraph(graph.graphId) ?? graph;
    this.validateGraph(currentGraph);
    if (currentGraph.revision !== graph.revision) throw new DeviceFabricError("revision_conflict", "task graph revision is stale");
    const node = currentGraph.nodes.find(item => item.nodeId === nodeId);
    if (!node) throw new DeviceFabricError("target_missing", "task graph node is missing");
    const nodes = currentGraph.nodes.map(item => item.nodeId === nodeId ? { ...item, status, ...(resultRef ? { resultRef } : {}) } : item);
    const graphStatus: DeviceTaskGraphV1["status"] = nodes.some(item => item.status === "unknown") ? "unknown"
      : nodes.some(item => item.status === "failed") ? "failed"
      : nodes.every(item => item.status === "succeeded") ? "succeeded"
      : nodes.some(item => ["executing", "verifying"].includes(item.status)) ? "executing" : "partial";
    const next = { ...currentGraph, revision: currentGraph.revision + 1, status: graphStatus, nodes, updatedAt: this.#now() };
    this.#persistence?.saveTaskGraph(next);
    return next;
  }
}

export interface DeviceTaskGraphPersistence {
  getTaskGraph(graphId: string): DeviceTaskGraphV1 | undefined;
  saveTaskGraph(graph: DeviceTaskGraphV1): DeviceTaskGraphV1;
  acquireTaskGraphLease(targetDeviceId: string, ownerId: string, now: string, leaseMs: number): boolean;
  releaseTaskGraphLease(targetDeviceId: string, ownerId: string): void;
}

export class EdgeRuntimeRegistry {
  readonly #runtimes = new Map<string, EdgeRuntimeEnrollmentV1>();

  enroll(runtime: EdgeRuntimeEnrollmentV1): EdgeRuntimeEnrollmentV1 {
    const current = this.#runtimes.get(runtime.runtimeId);
    if (current && runtime.revision <= current.revision) throw new DeviceFabricError("revision_conflict", "edge runtime revision must advance");
    const enrolled = { ...runtime, status: "enrolled" as const };
    this.#runtimes.set(runtime.runtimeId, enrolled);
    return enrolled;
  }

  revoke(runtimeId: string, revision: number): EdgeRuntimeEnrollmentV1 {
    const current = this.#runtimes.get(runtimeId);
    if (!current) throw new DeviceFabricError("target_missing", "edge runtime is missing");
    const revoked = { ...current, status: "revoked" as const, revision };
    this.#runtimes.set(runtimeId, revoked);
    return revoked;
  }

  get(runtimeId: string): EdgeRuntimeEnrollmentV1 | undefined { return this.#runtimes.get(runtimeId); }
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
    if (requiredPhysicalState !== "unknown" && context.physicalState !== requiredPhysicalState) throw new DeviceFabricError("safety_denied", "physical precondition is not satisfied");
    if (secretRefs.some(secretRef => !context.requiredSecretRefs.includes(secretRef))) throw new DeviceFabricError("safety_denied", "required secret reference is not authorized");
  }
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
      generatedAt: input.generatedAt,
    };
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

  start(span: DeviceTraceSpanV1): DeviceTraceSpanV1 { this.#spans.set(span.spanId, span); return span; }
  finish(spanId: string, finishedAt: string, status: DeviceTraceSpanV1["status"]): DeviceTraceSpanV1 {
    const current = this.#spans.get(spanId);
    if (!current) throw new DeviceFabricError("target_missing", "trace span is missing");
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
