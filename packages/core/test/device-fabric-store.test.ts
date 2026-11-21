import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHash } from "node:crypto";
import type { DeviceConformanceReportV1, DeviceEventEnvelopeV1, DeviceGraphNodeV1, DeviceResourceManifestV1, DeviceTaskGraphV1, DeviceTraceSpanV1, EdgeRuntimeEnrollmentV1 } from "@ling-stack/contracts";
import { DeviceFabricError, DeviceTaskGraphCoordinator } from "../dist/device-fabric.js";
import { DeviceSecretBroker } from "../dist/device-secrets.js";
import { DeviceEventProjector, DevicePeerEventSynchronizer } from "../dist/device-event-projection.js";
import { LingServerPeerSessionCoordinator } from "../dist/ling-server.js";
import { DeviceAccessManager } from "../dist/device-access.js";
import { SqliteDeviceFabricStore } from "../dist/storage/sqlite/device-fabric-store.js";

const now = "2026-11-21T00:00:00.000Z";

function event(sequence: number, overrides: Partial<DeviceEventEnvelopeV1> = {}): DeviceEventEnvelopeV1 {
  return {
    eventId: `event-${sequence}`,
    traceId: "trace-1",
    streamId: "task:task-1",
    generation: 1,
    sourceKind: "runtime",
    sourceId: "runtime-1",
    sequence,
    kind: "state.changed",
    payload: { sequence },
    occurredAt: now,
    ...overrides,
  };
}

function manifest(version: string, digest: string, signature = `signature-${version}`): DeviceResourceManifestV1 {
  return {
    resourceId: "adapter-linux",
    version,
    kind: "adapter",
    digest,
    license: "MIT",
    dependencies: [],
    signature,
    supportedDeviceKinds: ["linux"],
    entrypoint: "index.js",
  };
}

test("fabric store retains bounded event streams and resumes from a durable snapshot", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ling-device-fabric-")), "fabric.sqlite");
  try {
    const first = new SqliteDeviceFabricStore({ databasePath: path, maxEventsPerStream: 2 });
    assert.equal(first.appendEvent(event(1), now).replayed, false);
    assert.equal(first.appendEvent(event(2), now).replayed, false);
    assert.equal(first.appendEvent(event(3), now).replayed, false);
    assert.equal(first.appendEvent(event(3), now).replayed, true);
    assert.throws(() => first.appendEvent(event(3, { eventId: "conflicting-event" })), (error: unknown) => error instanceof DeviceFabricError && error.code === "revision_conflict");
    assert.throws(() => first.readEvents("task:task-1", 1, 0), (error: unknown) => error instanceof DeviceFabricError && error.code === "revision_conflict");
    first.saveSnapshot({ streamId: "task:task-1", generation: 1, sequence: 3, snapshot: { status: "executing" }, createdAt: now });
    first.close();

    const second = new SqliteDeviceFabricStore({ databasePath: path, maxEventsPerStream: 2 });
    const read = second.readEvents("task:task-1", 1, 1);
    assert.deepEqual(read.events.map(item => item.sequence), [2, 3]);
    assert.equal(read.hasGap, false);
    assert.deepEqual(second.getSnapshot("task:task-1"), {
      streamId: "task:task-1",
      generation: 1,
      sequence: 3,
      snapshot: { status: "executing" },
      createdAt: now,
    });
    second.close();

    const durable = new SqliteDeviceFabricStore({ databasePath: path, maxEventsPerStream: 1 });
    durable.appendEvent(event(4, { eventId: "event-durable", retentionClass: "durable" }), now);
    durable.appendEvent(event(5, { eventId: "event-bounded", retentionClass: "bounded" }), now);
    assert.deepEqual(durable.readEvents("task:task-1", 1, 3).events.map(item => item.eventId), ["event-durable", "event-bounded"]);
    durable.close();
  } finally {
    rmSync(path, { force: true });
    rmSync(path.replace(/\/fabric\.sqlite$/u, ""), { recursive: true, force: true });
  }
});

test("peer event synchronization preserves owner stream identity and idempotent replay", () => {
  const sender = new LingServerPeerSessionCoordinator({ now: () => now });
  const receiver = new LingServerPeerSessionCoordinator({ now: () => now });
  const session = { sessionId: "session-1", bindingId: "binding-1", peerEpoch: 1, routeAttemptId: "route-1", route: "direct" as const, transportGeneration: 1, sendSequence: 0, receivedSequence: 0, status: "open" as const, openedAt: now, lastSeenAt: now };
  sender.openSession(session);
  receiver.openSession(session);
  const store = new SqliteDeviceFabricStore();
  const senderStore = new SqliteDeviceFabricStore();
  const sync = new DevicePeerEventSynchronizer({ sessions: receiver, store, now: () => now });
  const eventValue = event(1, { eventId: "peer-event-1", streamId: "task:peer", sourceId: "mobile-1" });
  const outbound = new DevicePeerEventSynchronizer({ sessions: sender, store: senderStore, now: () => now }).publish("session-1", eventValue);
  assert.equal(sync.receive(outbound.frame).replayed, false);
  assert.equal(sync.receive(outbound.frame).replayed, true);
  assert.deepEqual(store.readEvents("task:peer", 1, 0).events.map(item => item.eventId), ["peer-event-1"]);
  senderStore.close();
  store.close();
});

test("fabric store installs signed resources, preserves the previous revision, and rolls back", () => {
  const store = new SqliteDeviceFabricStore({ verifyResourceSignature: manifestValue => manifestValue.signature.startsWith("signature-"), allowedResourceLicenses: ["MIT"] });
  const payload = new TextEncoder().encode("adapter-v1");
  const digest = createHash("sha256").update(payload).digest("hex");
  const first = store.installResource(manifest("1.0.0", digest), payload, now);
  assert.equal(first.replayed, false);
  assert.equal(store.installResource(manifest("1.0.0", digest), payload, now).replayed, true);
  const secondPayload = new TextEncoder().encode("adapter-v2");
  const secondDigest = createHash("sha256").update(secondPayload).digest("hex");
  store.installResource(manifest("2.0.0", secondDigest), secondPayload, "2026-11-21T00:01:00.000Z");
  assert.equal(store.getResource("adapter-linux")?.manifest.version, "2.0.0");
  assert.equal(store.rollbackResource("adapter-linux").manifest.version, "1.0.0");
  assert.throws(() => store.installResource(manifest("3.0.0", digest, "untrusted"), payload), (error: unknown) => error instanceof DeviceFabricError && error.code === "resource_conflict");
  assert.throws(() => store.installResource({ ...manifest("3.0.0", digest), supportedPlatforms: ["android"] }, payload, now, { platform: "ios" }), (error: unknown) => error instanceof DeviceFabricError && error.code === "resource_conflict");
  assert.equal(store.healthCheckResource("adapter-linux", () => false).status, "disabled");
  assert.equal(store.healthCheckResource("adapter-linux", () => true).status, "active");
  store.close();
});

test("fabric store persists lifecycle revisions and rejects invalid transitions", () => {
  const store = new SqliteDeviceFabricStore();
  store.transitionLifecycle({ deviceId: "device-1", status: "discovered", revision: 1, reason: "found", authority: "adapter", changedAt: now });
  store.transitionLifecycle({ deviceId: "device-1", status: "identified", revision: 2, reason: "fingerprint", authority: "operator", changedAt: now });
  assert.equal(store.getLifecycle("device-1")?.status, "identified");
  assert.throws(() => store.transitionLifecycle({ deviceId: "device-1", status: "healthy", revision: 3, reason: "skip", authority: "adapter", changedAt: now }), (error: unknown) => error instanceof DeviceFabricError && error.code === "lifecycle_invalid");
  assert.throws(() => store.transitionLifecycle({ deviceId: "device-1", status: "enrolled", revision: 2, reason: "replay", authority: "adapter", changedAt: now }), (error: unknown) => error instanceof DeviceFabricError && error.code === "lifecycle_invalid");
  store.close();
});

test("fabric store persists graph, twin, and task graph revisions", () => {
  const store = new SqliteDeviceFabricStore();
  const device: DeviceGraphNodeV1 = { nodeId: "device-1", kind: "device", deviceId: "device-1", label: "Linux board", identityRefs: ["ssh:board"], properties: {}, revision: 1 };
  const component: DeviceGraphNodeV1 = { nodeId: "component-1", kind: "component", parentNodeId: "device-1", label: "Wi-Fi", identityRefs: [], properties: {}, revision: 1 };
  store.upsertGraphNode(device);
  store.upsertGraphNode(component);
  store.addGraphRelationship({ relationshipId: "contains-1", fromNodeId: "device-1", toNodeId: "component-1", type: "contains", provenance: ["adapter"], revision: 1 });
  assert.throws(() => store.addGraphRelationship({ relationshipId: "contains-cycle", fromNodeId: "component-1", toNodeId: "device-1", type: "contains", provenance: [], revision: 1 }), (error: unknown) => error instanceof DeviceFabricError && error.code === "invalid_graph");
  store.saveTwin({ deviceId: "device-1", revision: 1, updatedAt: now, values: [] });
  assert.throws(() => store.saveTwin({ deviceId: "device-1", revision: 1, updatedAt: now, values: [] }), (error: unknown) => error instanceof DeviceFabricError && error.code === "revision_conflict");
  const graph: DeviceTaskGraphV1 = {
    graphId: "graph-1",
    revision: 1,
    status: "planned",
    createdAt: now,
    updatedAt: now,
    nodes: [{ nodeId: "node-1", targetDeviceId: "device-1", ownerKind: "edge", ownerId: "edge-1", capabilityId: "linux.inspect.network", capabilitySnapshotId: "snapshot-1", dependencies: [], status: "planning" }],
  };
  store.saveTaskGraph(graph);
  assert.equal(store.getGraphNode("component-1")?.parentNodeId, "device-1");
  assert.equal(store.getTwin("device-1")?.revision, 1);
  assert.equal(store.getTaskGraph("graph-1")?.nodes[0]?.ownerId, "edge-1");
  store.close();
});

test("fabric store persists edge enrollment and trace spans", () => {
  const store = new SqliteDeviceFabricStore();
  const runtime: EdgeRuntimeEnrollmentV1 = { runtimeId: "edge-1", displayName: "Linux edge", publicKeyFingerprint: "fp-1", contractMajor: 1, supportedTransports: ["ssh"], status: "enrolled", revision: 1, lastSeenAt: now };
  store.saveEdgeRuntime(runtime);
  store.saveEdgeRuntime({ ...runtime, status: "revoked", revision: 2 });
  assert.equal(store.getEdgeRuntime("edge-1")?.status, "revoked");
  const span: DeviceTraceSpanV1 = { spanId: "span-1", traceId: "trace-1", kind: "runtime", sourceId: "edge-1", startedAt: now, status: "running", metadata: { taskId: "task-1" } };
  store.saveTraceSpan(span);
  store.saveTraceSpan({ ...span, finishedAt: now, status: "ok" });
  assert.equal(store.listTraceSpans("trace-1")[0]?.status, "ok");
  assert.throws(() => store.saveTraceSpan(span), (error: unknown) => error instanceof DeviceFabricError && error.code === "revision_conflict");
  store.close();
});

test("target-scoped secret broker resolves only authorized references and records redacted use metadata", async () => {
  const store = new SqliteDeviceFabricStore();
  const broker = new DeviceSecretBroker({
    resolver: { resolve: async ({ secretRef }) => secretRef === "ssh-key" ? "private-key-material" : undefined },
    recorder: store,
    now: () => now,
  });
  broker.allowReference("device-1", "ssh-key");
  assert.equal(await broker.resolve({ useId: "use-1", taskId: "task-1", attemptId: "attempt-1", targetDeviceId: "device-1", secretRef: "ssh-key", purpose: "ssh diagnosis", policyRevision: "policy-1" }), "private-key-material");
  assert.deepEqual(store.listSecretUses(), [{ useId: "use-1", taskId: "task-1", attemptId: "attempt-1", targetDeviceId: "device-1", secretRef: "ssh-key", purpose: "ssh diagnosis", policyRevision: "policy-1", usedAt: now }]);
  await assert.rejects(() => broker.resolve({ useId: "use-2", taskId: "task-1", targetDeviceId: "device-2", secretRef: "ssh-key", purpose: "ssh diagnosis", policyRevision: "policy-1" }), (error: unknown) => error instanceof DeviceFabricError && error.code === "safety_denied");
  store.close();
});

test("task graph coordinator persists owner leases and rejects stale graph revisions", () => {
  const store = new SqliteDeviceFabricStore();
  const graph: DeviceTaskGraphV1 = {
    graphId: "graph-persisted",
    revision: 1,
    status: "planned",
    createdAt: now,
    updatedAt: now,
    nodes: [{ nodeId: "node-1", targetDeviceId: "device-1", ownerKind: "edge", ownerId: "edge-1", capabilityId: "linux.inspect.network", capabilitySnapshotId: "snapshot-1", dependencies: [], status: "planning" }],
  };
  store.saveTaskGraph(graph);
  const first = new DeviceTaskGraphCoordinator({ persistence: store, now: () => now });
  first.acquireOwnerLease("device-1", "edge-1");
  const updated = first.recordNodeResult(graph, "node-1", "succeeded", "result-1");
  assert.equal(updated.revision, 2);
  const second = new DeviceTaskGraphCoordinator({ persistence: store, now: () => now });
  assert.throws(() => second.recordNodeResult(graph, "node-1", "failed"), (error: unknown) => error instanceof DeviceFabricError && error.code === "revision_conflict");
  assert.throws(() => second.acquireOwnerLease("device-1", "mobile-1"), (error: unknown) => error instanceof DeviceFabricError && error.code === "lease_busy");
  first.releaseOwnerLease("device-1", "edge-1");
  second.acquireOwnerLease("device-1", "mobile-1");
  store.close();
});

test("event projector resumes from a snapshot and requests resync for a stale cursor", () => {
  const store = new SqliteDeviceFabricStore({ maxEventsPerStream: 2 });
  store.appendEvent(event(1, { retentionClass: "durable" }), now);
  store.appendEvent(event(2, { retentionClass: "durable" }), now);
  const projector = new DeviceEventProjector({
    store,
    streamId: "task:task-1",
    now: () => now,
    apply: (snapshot, nextEvent) => {
      const current = snapshot as { count: number };
      return { ...current, count: current.count + Number((nextEvent.payload as { sequence: number }).sequence) };
    },
  });
  const first = projector.sync({ count: 0 });
  assert.equal(first.status, "applied");
  assert.equal(first.sequence, 2);
  assert.deepEqual(first.snapshot, { count: 3 });
  store.appendEvent(event(3, { retentionClass: "durable" }), now);
  const second = projector.sync({ count: 0 });
  assert.equal(second.eventsApplied, 1);
  assert.deepEqual(second.snapshot, { count: 6 });
  store.appendEvent(event(4, { streamId: "stale:1", eventId: "stale-4" }), now);
  store.appendEvent(event(5, { streamId: "stale:1", eventId: "stale-5" }), now);
  store.appendEvent(event(6, { streamId: "stale:1", eventId: "stale-6" }), now);
  const stale = new DeviceEventProjector({ store, streamId: "stale:1", now: () => now, apply: (snapshot) => snapshot });
  const staleResult = stale.sync({ count: 0 });
  assert.equal(staleResult.status, "resync_required");
  assert.equal(staleResult.reason, "snapshot_missing");
  store.close();
});

test("fleet ownership transfer advances revisions and keeps the previous owner history", () => {
  const store = new SqliteDeviceFabricStore();
  store.transferOwnership({ deviceId: "device-1", ownerScope: "workspace-a", runtimeOwnerId: "pc-a", revision: 1, authority: "pairing", changedAt: now });
  store.transferOwnership({ deviceId: "device-1", ownerScope: "workspace-b", runtimeOwnerId: "mobile-b", revision: 2, authority: "operator", changedAt: "2026-11-21T00:01:00.000Z" });
  assert.equal(store.getOwnership("device-1")?.ownerScope, "workspace-b");
  assert.deepEqual(store.listOwnershipHistory("device-1").map(item => item.ownerScope), ["workspace-a"]);
  assert.throws(() => store.transferOwnership({ deviceId: "device-1", ownerScope: "workspace-c", revision: 2, authority: "operator", changedAt: now }), (error: unknown) => error instanceof DeviceFabricError && error.code === "revision_conflict");
  store.close();
});

test("conformance reports are validated, persisted, and replayable by report identity", () => {
  const store = new SqliteDeviceFabricStore();
  const report: DeviceConformanceReportV1 = {
    reportId: "report-1",
    runtimeId: "edge-1",
    adapterId: "linux-ssh",
    adapterVersion: "1.0.0",
    targetProfile: "linux-board",
    transport: "ssh",
    checks: [{ id: "network-read", status: "pass", evidenceRef: "trace-1" }, { id: "restart", status: "skip" }],
    generatedAt: now,
  };
  store.saveConformanceReport(report);
  assert.deepEqual(store.getConformanceReport("report-1"), report);
  assert.throws(() => store.saveConformanceReport({ ...report, checks: [{ id: "duplicate", status: "pass" }, { id: "duplicate", status: "skip" }] }), (error: unknown) => error instanceof DeviceFabricError && error.code === "revision_conflict");
  store.close();
});

test("device access grants enforce target, principal, capability scope, expiry and revocation", () => {
  const store = new SqliteDeviceFabricStore();
  const access = new DeviceAccessManager(store);
  access.grant({ grantId: "grant-1", targetDeviceId: "linux-1", principalId: "mobile-1", scope: "read_only", capabilityIds: ["linux.inspect.network"], revision: 1, status: "active", expiresAt: "2026-11-21T00:05:00.000Z", authority: "owner", changedAt: now });
  assert.equal(access.authorize({ grantId: "grant-1", principalId: "mobile-1", targetDeviceId: "linux-1", capabilityId: "linux.inspect.network", now }).scope, "read_only");
  assert.throws(() => access.authorize({ grantId: "grant-1", principalId: "mobile-1", targetDeviceId: "linux-1", capabilityId: "linux.repair.network", now }), /outside/);
  assert.throws(() => access.authorize({ grantId: "grant-1", principalId: "other", targetDeviceId: "linux-1", capabilityId: "linux.inspect.network", now }), /principal/);
  access.revoke("grant-1", 2, now);
  assert.throws(() => access.authorize({ grantId: "grant-1", principalId: "mobile-1", targetDeviceId: "linux-1", capabilityId: "linux.inspect.network", now }), /inactive/);
  store.close();
});

test("credential revisions rotate and revoke without persisting secret contents", () => {
  const store = new SqliteDeviceFabricStore();
  store.saveCredentialRevision({ credentialId: "credential-1", targetDeviceId: "linux-1", secretRef: "keychain:linux-1", kind: "ssh_key", fingerprint: "fp-1", revision: 1, status: "active", authority: "pairing", changedAt: now });
  store.saveCredentialRevision({ credentialId: "credential-1", targetDeviceId: "linux-1", secretRef: "keychain:linux-1-v2", kind: "ssh_key", fingerprint: "fp-2", revision: 2, status: "active", authority: "operator", changedAt: "2026-11-21T00:01:00.000Z" });
  assert.equal(store.getCredentialRevision("credential-1")?.fingerprint, "fp-2");
  assert.equal(store.revokeCredentialRevision("credential-1", 3, "operator", "2026-11-21T00:02:00.000Z").status, "revoked");
  assert.throws(() => store.saveCredentialRevision({ credentialId: "credential-1", targetDeviceId: "linux-1", secretRef: "raw-secret-must-not-be-stored", kind: "ssh_key", fingerprint: "fp-3", revision: 3, status: "active", authority: "operator", changedAt: now }), /advance/);
  store.close();
});
