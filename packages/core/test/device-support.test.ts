import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type {
  AdapterManifestV1,
  DeviceActionRequestV1,
  DeviceCapabilitySnapshotV1,
  DeviceObservationV1,
  DeviceProfileV1,
  DeviceTaskAttemptV1,
  DeviceTaskV1,
} from "@ling-stack/contracts";
import {
  DeviceBrokerError,
  DeviceCapabilityBroker,
  type DeviceAdapter,
  digestRequest,
} from "../dist/device-support.js";
import { DeviceAccessManager } from "../dist/device-access.js";
import { createHomeAssistantOfflinePlaybook, createPcSoftwareDiagnosisPlaybook, isDevicePlaybookV1, runDeviceReadOnlyPlaybook } from "../dist/device-playbooks.js";
import { readOwnedDeviceTaskJournal } from "../dist/device-task-event-projector.js";
import { readOwnedDeviceTaskTrace } from "../dist/device-task-trace.js";
import { readOwnedDeviceAttemptConformance } from "../dist/device-task-conformance.js";
import { SqliteDeviceFabricStore } from "../dist/storage/sqlite/device-fabric-store.js";
import { SqliteDeviceSupportStore } from "../dist/storage/sqlite/device-support-store.js";

const now = "2026-11-21T00:00:00.000Z";
const later = "2026-11-21T00:01:00.000Z";

const transportDeployment = {
  transport: "ssh",
  mode: "none",
  pairing: "credential_reference",
  removal: "revoke_credentials",
} as const;

const readCapability = {
  id: "linux.inspect.network",
  schemaVersion: "1.0",
  semanticVerb: "inspect.network",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  sideEffect: "read_only",
  approvalClass: "allow",
  requiredPermissions: ["ssh"],
  prerequisites: [],
  timeoutMs: 5_000,
  responseBytesLimit: 64 * 1024,
  idempotency: "request",
  supportedDeviceKinds: ["linux"],
  supportedTransports: ["ssh"],
} as const;

const writeCapability = {
  id: "linux.repair.network",
  schemaVersion: "1.0",
  semanticVerb: "repair.network",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  sideEffect: "reversible",
  approvalClass: "ask",
  requiredPermissions: ["ssh", "sudo"],
  prerequisites: [],
  timeoutMs: 5_000,
  responseBytesLimit: 64 * 1024,
  idempotency: "request",
  verificationCapabilityId: "linux.inspect.network",
  supportedDeviceKinds: ["linux"],
  supportedTransports: ["ssh"],
} as const;

const manifest: AdapterManifestV1 = {
  adapterId: "linux-ssh",
  adapterVersion: "1.0.0",
  contractMajor: 1,
  supportedDeviceKinds: ["linux"],
  supportedTransports: ["ssh"],
  transportDeployments: [transportDeployment],
  requiredRuntime: "pc",
  authenticationMethods: ["ssh_key"],
  capabilities: [readCapability, writeCapability],
  removalBehavior: "revoke_and_disconnect",
};

const profile: DeviceProfileV1 = {
  device: {
    id: "device-linux-1",
    ownerScope: "workspace-1",
    displayName: "Linaro board",
    kind: "linux",
    lifecycleStatus: "healthy",
    profileRevision: "profile-1",
    runtimeOwnerId: "daemon-1",
  },
  adapterId: manifest.adapterId,
  adapterVersion: manifest.adapterVersion,
  transports: ["ssh"],
  connectionRefs: ["connection-1"],
  transportDeployments: [transportDeployment],
  profileRevision: "profile-1",
  source: "adapter",
};

function snapshot(): DeviceCapabilitySnapshotV1 {
  return {
    snapshotId: "snapshot-1",
    deviceId: profile.device.id,
    adapterId: manifest.adapterId,
    adapterVersion: manifest.adapterVersion,
    contractMajor: 1,
    connectionRevision: "connection-1",
    capabilities: [readCapability, writeCapability],
    observedAt: now,
    freshnessUntil: "2026-11-21T00:05:00.000Z",
  };
}

function task(id = "task-1"): DeviceTaskV1 {
  return {
    id,
    ownerKind: "daemon",
    ownerId: "daemon-1",
    targetDeviceIds: [profile.device.id],
    status: "planning",
    capabilitySnapshotIds: ["snapshot-1"],
    createdAt: now,
    updatedAt: now,
  };
}

function request(capabilityId: string = readCapability.id, taskId = "task-1"): DeviceActionRequestV1 {
  return {
    actionId: `${taskId}-action-1`,
    taskId,
    targetDeviceId: profile.device.id,
    capabilityId,
    capabilitySchemaVersion: "1.0",
    capabilitySnapshotId: "snapshot-1",
    normalizedInput: { includeDns: true },
    idempotencyKey: `${taskId}:action-1`,
  };
}

function approveNetworkRepair(request: DeviceActionRequestV1): DeviceActionRequestV1 {
  const action = { ...request, expectedVerification: { connected: true } };
  return {
    ...action,
    approvalId: "approval-1",
    approval: {
      approvalId: "approval-1",
      taskId: action.taskId,
      actionId: action.actionId,
      targetDeviceId: action.targetDeviceId,
      capabilitySnapshotId: action.capabilitySnapshotId,
      connectionRevision: "connection-1",
      policyRevision: "device-policy-v1",
      normalizedInputDigest: digestRequest(action),
      expiresAt: "2026-11-21T00:05:00.000Z",
      recoveryScope: { baseline: "network" },
    },
  };
}

function createAdapter(): DeviceAdapter {
  return {
    manifest,
    async discover() { return profile; },
    async getCapabilities() { return snapshot(); },
    async execute({ request: action }) {
      return {
        actionId: action.actionId,
        status: "completed",
        startedAt: now,
        finishedAt: later,
        observationIds: [],
      };
    },
    async verify({ request: action, evidenceId }) {
      return {
        verification: {
          actionId: action.actionId, status: "verified", rule: { connected: true },
          observationIds: [evidenceId], checkedAt: now,
        },
        observations: [{
          id: evidenceId, subjectId: action.targetDeviceId, source: "fixture",
          value: { connected: true }, observedAt: now, receivedAt: now,
          freshnessUntil: later, quality: "good", provenance: [action.targetDeviceId], redactionClass: "public",
        }],
      };
    },
  };
}

function brokerFixture() {
  const store = new SqliteDeviceSupportStore();
  const broker = new DeviceCapabilityBroker({ store, now: () => now });
  broker.registerAdapter(createAdapter());
  broker.registerDevice(manifest.adapterId, profile);
  store.saveCapabilitySnapshot(snapshot(), now);
  return { store, broker };
}

test("registry discovers a device and broker executes a fresh read-only capability", async () => {
  const { store, broker } = brokerFixture();
  store.createTask(task(), now);
  const result = await broker.execute(request());
  assert.equal(result.attempt.status, "completed");
  assert.equal(result.attempt.receipt?.status, "completed");
  assert.equal(store.getTask("task-1")?.status, "succeeded");
  assert.equal(store.listEvents("task-1").some(event => event.type === "attempt_updated"), true);
  store.close();
});

test("a task retains its original capability facts across refresh and restart without reopening stale dispatch authority", async t => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-capability-history-"));
  const databasePath = join(root, "device.sqlite");
  let store = new SqliteDeviceSupportStore({ databasePath });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const broker = new DeviceCapabilityBroker({ store, now: () => now });
  broker.registerAdapter(createAdapter());
  broker.registerDevice(manifest.adapterId, profile);
  const before = {
    ...snapshot(),
    capabilities: [{ ...readCapability, inputSchema: { type: "object", description: "fixture-adapter-private-schema" } }, writeCapability],
  };
  store.saveCapabilitySnapshot(before, now);
  store.saveCapabilitySnapshot(structuredClone(before), now);
  assert.throws(() => store.saveCapabilitySnapshot({ ...before, capabilities: [writeCapability] }, now), (error: unknown) =>
    error instanceof DeviceBrokerError && error.code === "stale_snapshot");
  assert.deepEqual(store.getCurrentCapabilitySnapshot(profile.device.id), before);
  broker.createTask(task());
  const original = await broker.execute(request());

  broker.registerDevice(manifest.adapterId, {
    ...profile, profileRevision: "profile-2", device: { ...profile.device, profileRevision: "profile-2" }, connectionRefs: ["connection-2"],
  });
  assert.equal(store.getCurrentCapabilitySnapshot(profile.device.id), undefined);
  assert.throws(() => store.saveCapabilitySnapshot(before, later), /snapshot id is already bound/u);
  assert.equal(store.getCurrentCapabilitySnapshot(profile.device.id), undefined);
  const after: DeviceCapabilitySnapshotV1 = {
    ...snapshot(), snapshotId: "snapshot-2", connectionRevision: "connection-2", capabilities: [readCapability], observedAt: later,
  };
  store.saveCapabilitySnapshot(after, later);
  broker.createTask(task("stale-plan"));
  await assert.rejects(() => broker.execute(request(readCapability.id, "stale-plan")), (error: unknown) =>
    error instanceof DeviceBrokerError && error.code === "stale_snapshot");
  assert.deepEqual(store.listAttempts("stale-plan"), []);

  store.close();
  store = new SqliteDeviceSupportStore({ databasePath });
  assert.deepEqual(store.getCurrentCapabilitySnapshot(profile.device.id), after);
  assert.deepEqual(store.getRecordedCapabilitySnapshot(profile.device.id, before.snapshotId), {
    workspaceId: "workspace-1", profileRevision: "profile-1", snapshot: before,
  });
  assert.deepEqual(store.getAttempt("task-1", original.attempt.attemptId)?.attempt, original.attempt);
  const trace = readOwnedDeviceTaskTrace({ store, workspaceId: "workspace-1", taskId: "task-1" });
  const [evidence] = trace.capabilitySnapshots ?? [];
  assert.ok(evidence?.state === "recorded");
  assert.equal(evidence.profileRevision, "profile-1");
  assert.deepEqual(evidence.capabilities.map(capability => capability.id), [readCapability.id, writeCapability.id]);
  assert.equal(evidence.connectionRevision, "connection-1");
  assert.doesNotMatch(JSON.stringify(trace), /fixture-adapter-private-schema/u);
});

test("upgrading a legacy device journal preserves the surviving snapshot and reports missing earlier evidence", t => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-snapshot-migration-"));
  const databasePath = join(root, "device.sqlite");
  let upgraded: SqliteDeviceSupportStore | undefined;
  t.after(() => { upgraded?.close(); rmSync(root, { recursive: true, force: true }); });
  const legacy = new SqliteDeviceSupportStore({ databasePath });
  legacy.registerDevice(profile, now);
  legacy.createTask({ ...task(), capabilitySnapshotIds: ["prior-snapshot", snapshot().snapshotId] }, now);
  legacy.database.exec("DROP TABLE device_capability_snapshots");
  legacy.database.prepare("UPDATE device_registry SET capability_snapshot_json=? WHERE device_id=?")
    .run(JSON.stringify(snapshot()), profile.device.id);
  legacy.close();

  upgraded = new SqliteDeviceSupportStore({ databasePath });
  const scope = { store: upgraded, workspaceId: "workspace-1", taskId: "task-1" };
  assert.deepEqual(upgraded.getCurrentCapabilitySnapshot(profile.device.id), snapshot());
  assert.deepEqual(upgraded.getRecordedCapabilitySnapshot(profile.device.id, snapshot().snapshotId)?.snapshot, snapshot());
  assert.deepEqual(readOwnedDeviceTaskTrace(scope).capabilitySnapshots?.map(evidence => [evidence.state, evidence.snapshotId]), [
    ["unavailable", "prior-snapshot"], ["recorded", "snapshot-1"],
  ]);
  upgraded.markDeviceOffline(profile.device.id, later);
  assert.equal(upgraded.getCurrentCapabilitySnapshot(profile.device.id), undefined);
  assert.equal(readOwnedDeviceTaskTrace(scope).capabilitySnapshots?.[1]?.state, "recorded");
});

test("task journal cursors use a task-local sequence when multiple tasks interleave", () => {
  const store = new SqliteDeviceSupportStore();
  store.registerDevice(profile, now);
  store.createTask(task("task-1"), now);
  store.createTask(task("task-2"), now);
  store.transitionTask("task-1", "executing", {}, later);
  store.transitionTask("task-2", "executing", {}, later);
  assert.deepEqual(store.listEvents("task-1").map(event => event.sequence), [1, 2]);
  assert.deepEqual(store.listEvents("task-2").map(event => event.sequence), [1, 2]);
  const page = readOwnedDeviceTaskJournal({ store, workspaceId: "workspace-1", taskId: "task-1", afterSequence: 1 });
  assert.equal(page.events[0]?.sequence, 2);
  assert.equal(page.latestSequence, 2);
  store.close();
});

test("broker binds dispatch to a current grant and blocks writes under a read-only grant", async t => {
  const store = new SqliteDeviceSupportStore();
  const fabric = new SqliteDeviceFabricStore();
  t.after(() => { fabric.close(); store.close(); });
  const broker = new DeviceCapabilityBroker({ store, accessManager: new DeviceAccessManager(fabric), now: () => now });
  broker.registerAdapter(createAdapter());
  broker.registerDevice(manifest.adapterId, profile);
  store.saveCapabilitySnapshot(snapshot(), now);
  const grant = fabric.saveAccessGrant({ grantId: "grant-1", targetDeviceId: profile.device.id, principalId: "daemon-1", scope: "read_only", capabilityIds: [readCapability.id, writeCapability.id], revision: 1, status: "active", expiresAt: "2026-11-21T00:05:00.000Z", authority: "operator", changedAt: now });
  store.createTask({ ...task("grant-task"), accessGrantId: "grant-1" }, now);
  const result = await broker.execute(request(readCapability.id, "grant-task"));
  assert.equal(result.attempt.status, "completed");
  assert.equal(result.attempt.accessGrantRevision, 1);
  store.createTask({ ...task("grant-write"), accessGrantId: "grant-1" }, now);
  const write = approveNetworkRepair(request(writeCapability.id, "grant-write"));
  await assert.rejects(() => broker.execute(write), /read-only access grant/u);
  assert.deepEqual(store.listAttempts(write.taskId), []);
  fabric.revokeAccessGrant("grant-1", 2, now);
  assert.deepEqual(store.getAttempt("grant-task", result.attempt.attemptId)?.attempt.authority?.accessGrant, grant);
  const trace = readOwnedDeviceTaskTrace({ store, workspaceId: "workspace-1", taskId: "grant-task" });
  const admitted = trace.spans.find(span => span.lineage?.attemptId === result.attempt.attemptId);
  assert.deepEqual((admitted?.metadata as { authority?: unknown })?.authority, {
    state: "recorded", policyRevision: broker.policyRevision, dispatchStop: { active: false, revision: 0 },
    accessGrant: { grantId: grant.grantId, scope: grant.scope, revision: grant.revision, expiresAt: grant.expiresAt },
  });
  store.createTask({ ...task("revoked-task"), accessGrantId: "grant-1" }, now);
  await assert.rejects(() => broker.execute(request(readCapability.id, "revoked-task")), /device access grant denied/u);
  const noAccessResolver = new DeviceCapabilityBroker({ store, now: () => now });
  noAccessResolver.registerAdapter(createAdapter());
  await assert.rejects(() => noAccessResolver.execute(request(readCapability.id, "revoked-task")), /resolver is unavailable/u);
  assert.deepEqual(store.listAttempts("revoked-task"), []);
});

test("revoking a developer grant during verification retains evidence and leaves the outcome unknown", { timeout: 5000 }, async t => {
  const store = new SqliteDeviceSupportStore();
  const fabric = new SqliteDeviceFabricStore();
  t.after(() => { fabric.close(); store.close(); });
  const broker = new DeviceCapabilityBroker({ store, accessManager: new DeviceAccessManager(fabric), now: () => now });
  const adapter = createAdapter();
  let enterVerification!: () => void;
  const verifying = new Promise<void>(resolve => { enterVerification = resolve; });
  let finishVerification!: () => void;
  const mayFinish = new Promise<void>(resolve => { finishVerification = resolve; });
  let dispatches = 0;
  broker.registerAdapter({
    ...adapter,
    async execute(input) { dispatches += 1; return adapter.execute(input); },
    async verify(input) { enterVerification(); await mayFinish; return adapter.verify!(input); },
  });
  broker.registerDevice(manifest.adapterId, profile);
  store.saveCapabilitySnapshot(snapshot(), now);
  fabric.saveAccessGrant({
    grantId: "developer-grant", targetDeviceId: profile.device.id, principalId: "daemon-1",
    scope: "developer", capabilityIds: [readCapability.id, writeCapability.id], revision: 1,
    status: "active", expiresAt: "2026-11-21T00:05:00.000Z", authority: "operator", changedAt: now,
  });
  const taskId = "revoked-developer-write";
  broker.createTask({ ...task(taskId), accessGrantId: "developer-grant" });
  const action = approveNetworkRepair(request(writeCapability.id, taskId));
  const execution = broker.execute(action);
  try {
    await verifying;
    fabric.revokeAccessGrant("developer-grant", 2, later);
  } finally {
    finishVerification();
  }
  const result = await execution;
  assert.equal(result.attempt.accessGrantRevision, 1);
  assert.equal(result.attempt.receipt?.status, "completed");
  assert.equal(result.attempt.verification?.status, "verified");
  assert.equal(result.attempt.status, "unknown");
  assert.equal(store.getTask(taskId)?.status, "unknown");
  assert.equal(broker.getReconciliationPreview(taskId), undefined);
  await assert.rejects(() => broker.reconcileTask({
    taskId, attemptId: result.attempt.attemptId, capabilitySnapshotId: action.capabilitySnapshotId,
  }), /device access grant denied/u);
  assert.deepEqual(await broker.execute(action), result);
  assert.equal(dispatches, 1);
});

test("broker distinguishes stale snapshots, target leases, and revoked devices", async () => {
  const { store, broker } = brokerFixture();
  store.createTask(task(), now);
  store.acquireTargetLease(profile.device.id, "other-task", "other-owner", now, 60_000);
  await assert.rejects(() => broker.execute(request()), (error: unknown) => error instanceof DeviceBrokerError && error.code === "target_busy");
  store.releaseTargetLease(profile.device.id, "other-task");
  store.revokeDevice(profile.device.id, now);
  await assert.rejects(() => broker.execute({ ...request(), idempotencyKey: "revoked" }), (error: unknown) => error instanceof DeviceBrokerError && error.code === "device_offline");
  store.close();
});

test("retiring a device fences new dispatch and preserves an in-flight write and its late receipt", async t => {
  const { store, broker } = brokerFixture();
  t.after(() => store.close());
  const deviceId = profile.device.id;
  const workspaceId = profile.device.ownerScope;
  const binding = {
    deviceId, workspaceId,
    expectedProfileRevision: profile.profileRevision, expectedConnectionRevision: snapshot().connectionRevision,
  };
  const taskId = "retirement-task";
  const action = approveNetworkRepair(request(writeCapability.id, taskId));
  const adapter = createAdapter();
  let dispatches = 0;
  broker.registerAdapter({
    ...adapter,
    async execute(input) {
      dispatches += 1;
      assert.throws(() => broker.retireDevice({ ...binding, workspaceId: "foreign" }), /unavailable in this workspace/u);
      assert.throws(() => broker.retireDevice({ ...binding, expectedConnectionRevision: "stale" }), /profile or connection changed/u);
      const retirement = broker.retireDevice(binding);
      assert.equal(retirement.stoppedTaskId, taskId);
      assert.equal(retirement.previousStatus, "healthy");
      assert.equal(input.signal?.aborted, true);
      assert.equal(store.getTask(taskId)?.status, "unknown");
      return adapter.execute(input);
    },
  });
  broker.createTask(task(taskId));
  broker.createTask(task("later-read"));
  const attempt = await broker.execute(action);
  assert.equal(attempt.attempt.status, "unknown");
  assert.equal(attempt.attempt.receipt?.status, "completed");
  assert.equal(store.getDevice(deviceId)?.device.lifecycleStatus, "retired");
  assert.equal(store.getCurrentCapabilitySnapshot(deviceId), undefined);
  assert.deepEqual(store.getRecordedCapabilitySnapshot(deviceId, snapshot().snapshotId)?.snapshot, snapshot());
  assert.deepEqual(broker.retireDevice(binding), store.getDeviceRetirementState(deviceId, workspaceId).retirement);
  assert.equal(broker.getReconciliationPreview(taskId), undefined);
  assert.deepEqual(await broker.execute(action), attempt);
  await assert.rejects(() => broker.execute(request(readCapability.id, "later-read")), /is unavailable/u);
  assert.equal(dispatches, 1);
});

test("an in-flight refresh or repeat discovery cannot restore a revoked registration", async t => {
  const { store, broker } = brokerFixture();
  t.after(() => store.close());
  let finishRefresh!: (snapshot: DeviceCapabilitySnapshotV1) => void;
  const refreshGate = new Promise<DeviceCapabilitySnapshotV1>(resolve => { finishRefresh = resolve; });
  broker.registerAdapter({ ...createAdapter(), getCapabilities: () => refreshGate });
  const refresh = broker.refreshCapabilities(profile.device.id, snapshot().connectionRevision);
  store.revokeDevice(profile.device.id, later);
  finishRefresh(snapshot());
  await assert.rejects(() => refresh, (error: unknown) =>
    error instanceof DeviceBrokerError && error.code === "permission_denied");
  await assert.rejects(() => broker.discover(manifest.adapterId, { connectionRef: "connection-1", ownerId: profile.device.ownerScope }),
    (error: unknown) => error instanceof DeviceBrokerError && error.code === "permission_denied");
  assert.equal(store.getDevice(profile.device.id)?.device.lifecycleStatus, "revoked");
});

test("rediscovery invalidates the previous capability snapshot before an approved write", async t => {
  const { store, broker } = brokerFixture();
  t.after(() => store.close());
  broker.createTask(task());
  const action = approveNetworkRepair(request(writeCapability.id));
  broker.registerDevice(manifest.adapterId, {
    ...profile,
    device: { ...profile.device, profileRevision: "profile-2" },
    profileRevision: "profile-2",
    connectionRefs: ["connection-2"],
  });
  await assert.rejects(() => broker.execute(action), (error: unknown) =>
    error instanceof DeviceBrokerError && error.code === "stale_snapshot");
  assert.deepEqual(store.listAttempts(action.taskId), []);
});

test("mutating capability requires an exact, unexpired approval and records verification", async () => {
  const { store, broker } = brokerFixture();
  const mutatingTask = task("task-write");
  store.createTask(mutatingTask, now);
  const base = request(writeCapability.id, mutatingTask.id);
  await assert.rejects(() => broker.execute(base), (error: unknown) => error instanceof DeviceBrokerError && error.code === "permission_denied");
  assert.equal(store.listEvents(mutatingTask.id).some(event => event.type === "approval_recorded"), false);
  const approved = approveNetworkRepair(base);
  const approvalPrincipal = { kind: "paired_mobile", deviceId: "mobile-1", deviceEpoch: 3, sessionId: "paired-session-1" } as const;
  const result = await broker.execute(approved, undefined, { approvalPrincipal });
  assert.equal(result.attempt.verification?.status, "verified");
  assert.equal(store.getTask(mutatingTask.id)?.status, "succeeded");
  assert.deepEqual(await broker.execute(approved, undefined, { approvalPrincipal }), result);
  const events = store.listEvents(mutatingTask.id);
  const approvals = events.filter(event => event.type === "approval_recorded");
  assert.equal(approvals.length, 1);
  const approvalEvent = approvals[0]!;
  assert.deepEqual(approvalEvent.body.principal, approvalPrincipal);
  assert.equal(approvalEvent.body.normalizedInputDigest, result.requestDigest);
  assert.equal(approvalEvent.createdAt, result.attempt.dispatchIntentAt);
  assert.ok(approvalEvent.sequence < events.find(event => event.type === "attempt_prepared")!.sequence);
  store.close();
});

test("a recovery check releases its target lease when an operator stops it", { timeout: 5_000 }, async t => {
  for (const stop of ["task cancellation", "target dispatch stop"]) {
    await t.test(stop, async t => {
      const { store, broker } = brokerFixture();
      t.after(() => store.close());
      let startRecovery!: (signal: AbortSignal) => void;
      const started = new Promise<AbortSignal>(resolve => { startRecovery = resolve; });
      let finishRecovery!: (verified: boolean) => void;
      const recoveryProof = new Promise<boolean>(resolve => { finishRecovery = resolve; });
      const adapter = createAdapter();
      const baseline: DeviceObservationV1 = {
        id: "baseline", subjectId: profile.device.id, source: "fixture-network", value: { connected: true },
        observedAt: now, receivedAt: now, freshnessUntil: later, quality: "good", redactionClass: "public",
        provenance: [profile.device.id],
      };
      let writes = 0;
      broker.registerAdapter({
        ...adapter,
        async execute(input) {
          if (input.request.capabilityId === writeCapability.id) {
            writes += 1;
            return adapter.execute(input);
          }
          return {
            action: { actionId: input.request.actionId, status: "completed", startedAt: now, observationIds: [baseline.id] },
            observations: [baseline],
          };
        },
        async verifyRecoveryPath(input) {
          assert.equal(input.baseline.id, baseline.id);
          startRecovery(input.signal);
          return recoveryProof;
        },
      });
      broker.createTask(task("recovery"));
      await broker.execute(request(readCapability.id, "recovery"), undefined, { finalizeTask: false });
      const plan = {
        kind: "alternate_route", routeRevision: "local-usb", baselineObservationId: baseline.id, verifyBy: later,
      } as const;
      const proposal = {
        ...request(writeCapability.id, "recovery"), actionId: "repair", idempotencyKey: "repair",
        expectedVerification: { connected: true }, recoveryPlan: plan,
      };
      broker.proposeAction(proposal);
      assert.equal(store.getTask(proposal.taskId)?.status, "awaiting_approval");
      const approved = approveNetworkRepair(proposal);
      const pending = broker.execute({ ...approved, approval: { ...approved.approval!, recoveryScope: plan } }, undefined, { requireCurrentProposal: true });
      const signal = await started;
      broker.createTask(task("other-task"));
      await assert.rejects(() => broker.execute(request(readCapability.id, "other-task")), /target is leased/u);
      if (stop === "task cancellation") broker.cancelTask(proposal.taskId);
      else broker.setDispatchStop({ deviceId: profile.device.id, workspaceId: profile.device.ownerScope, active: true, expectedRevision: 0 });
      assert.equal(signal.aborted, true);
      await assert.rejects(pending, { code: "permission_denied" });
      assert.equal(store.getTask(proposal.taskId)?.status, "cancelled");
      assert.equal(store.acquireTargetLease(profile.device.id, "other-task", "daemon-1", now, 1_000), true);
      finishRecovery(true);
      await recoveryProof;
      assert.equal(writes, 0);
      assert.equal(store.listAttempts(proposal.taskId).length, 1);
      assert.equal(store.listEvents(proposal.taskId).some(event => event.type === "approval_recorded"), false);
    });
  }
});

test("dispatch leaves the journal and target lease untouched for an out-of-scope or closed task", async (t) => {
  const { store, broker } = brokerFixture();
  t.after(() => store.close());
  store.createTask({ ...task("wrong-owner"), ownerKind: "mobile" }, now);
  store.createTask({ ...task("wrong-target"), targetDeviceIds: ["device-other"] }, now);
  store.createTask({ ...task("cancelled"), status: "cancelled" }, now);
  for (const [taskId, code] of [["wrong-owner", "permission_denied"], ["wrong-target", "permission_denied"], ["cancelled", "invalid_request"]]) {
    await assert.rejects(() => broker.execute(request(readCapability.id, taskId)), (error: unknown) =>
      error instanceof DeviceBrokerError && error.code === code);
    assert.deepEqual(store.listAttempts(taskId), []);
  }
  assert.equal(store.acquireTargetLease(profile.device.id, "next-task", "daemon-1", now, 1000), true);
});

test("lost, unrelated or stale verification keeps the write receipt and requires reconciliation", async (t) => {
  const { store, broker } = brokerFixture();
  t.after(() => store.close());
  const adapter = createAdapter();
  let dispatches = 0;
  broker.registerAdapter({
    ...adapter,
    async execute(input) { dispatches += 1; return adapter.execute(input); },
    async verify(input) {
      if (input.request.taskId === "lost-readback") throw new Error("verification link closed");
      const report = await adapter.verify!(input);
      assert.ok("verification" in report);
      const observation = report.observations![0]!;
      if (input.request.taskId === "wrong-subject") {
        return { ...report, observations: [{ ...observation, subjectId: "other-device" }] };
      }
      if (input.request.taskId === "stale-observation") {
        return { ...report, observations: [{ ...observation, observedAt: "2026-11-20T23:59:59.000Z" }] };
      }
      return { ...report.verification, observationIds: [] };
    },
  });
  for (const taskId of ["lost-readback", "wrong-subject", "stale-observation", "missing-observation"]) {
    broker.createTask(task(taskId));
    const approved = approveNetworkRepair(request(writeCapability.id, taskId));
    const result = await broker.execute(approved);
    assert.equal(store.getTask(taskId)?.status, "unknown");
    assert.equal(result.attempt.receipt?.status, "completed");
    assert.equal(result.attempt.verification?.status, "not_evaluable");
    assert.equal(result.attempt.verification?.actionId, approved.actionId);
    assert.deepEqual(await broker.execute(approved), result);
    await assert.rejects(() => broker.execute({ ...approved, idempotencyKey: "new-attempt" }), (error: unknown) =>
      error instanceof DeviceBrokerError && error.code === "unknown_outcome");
  }
  assert.equal(dispatches, 4);
});

test("stopping during verification preserves late evidence and excludes another task until the adapter settles", { timeout: 5000 }, async (t) => {
  const { store, broker } = brokerFixture();
  t.after(() => store.close());
  const adapter = createAdapter();
  let enteredVerification!: (signal: AbortSignal | undefined) => void;
  const verificationStarted = new Promise<AbortSignal | undefined>(resolve => { enteredVerification = resolve; });
  let finishVerification!: () => void;
  const verificationGate = new Promise<void>(resolve => { finishVerification = resolve; });
  broker.registerAdapter({
    ...adapter,
    async verify(input) {
      enteredVerification(input.signal);
      await verificationGate;
      return adapter.verify!(input);
    },
  });
  broker.createTask(task("active-write"));
  broker.createTask(task("next-read"));
  const action = approveNetworkRepair(request(writeCapability.id, "active-write"));
  const execution = broker.execute(action);
  try {
    const signal = await verificationStarted;
    assert.equal(store.getTask(action.taskId)?.status, "verifying");
    assert.equal(broker.cancelTask(action.taskId).status, "unknown");
    assert.equal(signal?.aborted, true);
    const replay = await broker.execute(action);
    assert.equal(replay.attempt.receipt?.status, "completed");
    assert.equal(replay.attempt.verification, undefined);
    const next = request(readCapability.id, "next-read");
    await assert.rejects(() => broker.execute(next), (error: unknown) =>
      error instanceof DeviceBrokerError && error.code === "target_busy");
    assert.deepEqual(store.listAttempts(next.taskId), []);
  } finally {
    finishVerification();
    await execution;
  }
  assert.equal((await execution).attempt.verification?.status, "verified");
  assert.equal(store.getTask(action.taskId)?.status, "unknown");
  assert.equal(store.listEvents(action.taskId).filter(event => event.type === "task_stop_requested").length, 1);
  assert.equal((await broker.execute(request(readCapability.id, "next-read"))).attempt.status, "completed");
});

test("a target dispatch stop survives restart and preserves the in-flight attempt through clear", { timeout: 5000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-dispatch-stop-"));
  const databasePath = join(root, "workspace.sqlite");
  const store = new SqliteDeviceSupportStore({ databasePath });
  const broker = new DeviceCapabilityBroker({ store, now: () => now });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const adapter = createAdapter();
  let entered!: (signal: AbortSignal | undefined) => void;
  const dispatched = new Promise<AbortSignal | undefined>(resolve => { entered = resolve; });
  let release!: () => void;
  const drain = new Promise<void>(resolve => { release = resolve; });
  broker.registerAdapter({
    ...adapter,
    async execute(input) {
      if (input.request.capabilityId === writeCapability.id) {
        entered(input.signal);
        await drain;
      }
      return adapter.execute(input);
    },
  });
  broker.registerDevice(manifest.adapterId, profile);
  store.saveCapabilitySnapshot(snapshot(), now);
  broker.createTask(task("stopped-write"));
  broker.createTask(task("later-write"));
  broker.createTask(task("stop-diagnosis"));
  const activeRequest = approveNetworkRepair(request(writeCapability.id, "stopped-write"));
  const execution = broker.execute(activeRequest);
  const scope = { workspaceId: profile.device.ownerScope, deviceId: profile.device.id };
  try {
    const signal = await dispatched;
    assert.throws(() => broker.setDispatchStop({ ...scope, workspaceId: "other", active: true, expectedRevision: 0 }), /workspace/);
    assert.equal(broker.setDispatchStop({ ...scope, active: true, expectedRevision: 0 }).revision, 1);
    assert.equal(signal?.aborted, true);
    assert.equal(store.getTask(activeRequest.taskId)?.status, "unknown");
    assert.ok(store.getLeasedAttempt(activeRequest.taskId));
    const reopened = new SqliteDeviceSupportStore({ databasePath });
    try {
      assert.deepEqual(reopened.getDispatchStop(scope.deviceId), { deviceId: scope.deviceId, active: true, revision: 1, changedAt: now });
      assert.throws(() => broker.setDispatchStop({ ...scope, active: false, expectedRevision: 0 }), /revision changed/);
      assert.equal(broker.setDispatchStop({ ...scope, active: false, expectedRevision: 1 }).revision, 2);
    } finally {
      reopened.close();
    }
  } finally {
    release();
    await execution;
  }
  assert.equal((await execution).attempt.status, "unknown");
  assert.equal((await execution).attempt.receipt?.status, "completed");
  broker.setDispatchStop({ ...scope, active: true, expectedRevision: 2 });
  const nextWrite = approveNetworkRepair(request(writeCapability.id, "later-write"));
  await assert.rejects(() => broker.execute(nextWrite), /device dispatch is stopped/);
  assert.deepEqual(store.listAttempts(nextWrite.taskId), []);
  assert.equal((await broker.execute(request(readCapability.id, "stop-diagnosis"))).attempt.status, "completed");
});

test("invalid adapter receipts and thrown transport errors retain a redacted unknown outcome", async (t) => {
  const { store, broker } = brokerFixture();
  t.after(() => store.close());
  const adapter = createAdapter();
  broker.registerAdapter({
    ...adapter,
    async execute(input) {
      if (input.request.taskId === "transport-error") {
        throw new DOMException("sensitive-transport-detail", "TimeoutError");
      }
      return { actionId: "unrelated-action", status: "completed", startedAt: now, observationIds: [] };
    },
  });
  for (const [taskId, code] of [["transport-error", "timeout"], ["wrong-receipt", "unknown_outcome"]]) {
    broker.createTask(task(taskId));
    const action = approveNetworkRepair(request(writeCapability.id, taskId));
    const result = await broker.execute(action);
    assert.equal(store.getTask(taskId)?.status, "unknown");
    assert.equal(result.attempt.receipt?.actionId, action.actionId);
    assert.equal(result.attempt.receipt?.errorCode, code);
    assert.doesNotMatch(JSON.stringify(store.listAttempts(taskId)), /sensitive-transport-detail/);
  }
});

test("revoking a registration while a write is dispatched retains its receipt without reporting success", async t => {
  const { store, broker } = brokerFixture();
  t.after(() => store.close());
  const adapter = createAdapter();
  let verificationCalls = 0;
  broker.registerAdapter({
    ...adapter,
    async execute(input) {
      store.revokeDevice(input.profile.device.id, now);
      return adapter.execute(input);
    },
    async verify(input) {
      verificationCalls += 1;
      return adapter.verify!(input);
    },
  });
  broker.createTask(task("revoked-in-flight"));
  const result = await broker.execute(approveNetworkRepair(request(writeCapability.id, "revoked-in-flight")));
  assert.equal(result.attempt.receipt?.status, "completed");
  assert.equal(result.attempt.status, "unknown");
  assert.equal(store.getTask(result.attempt.taskId)?.status, "unknown");
  assert.equal(verificationCalls, 0);
});

test("reconciliation requires a current capability and fresh readback evidence", async t => {
  const { store, broker } = brokerFixture();
  t.after(() => store.close());
  const adapter = createAdapter();
  let dispatches = 0;
  broker.registerAdapter({
    ...adapter,
    async execute() {
      dispatches += 1;
      throw new Error("connection interrupted");
    },
    async verify(input) {
      return { actionId: input.request.actionId, status: "verified", rule: input.request.expectedVerification ?? null,
        observationIds: [], checkedAt: now };
    },
  });
  broker.createTask(task("reconciliation"));
  const action = approveNetworkRepair(request(writeCapability.id, "reconciliation"));
  const original = await broker.execute(action);
  const binding = { taskId: action.taskId, attemptId: original.attempt.attemptId, capabilitySnapshotId: snapshot().snapshotId };
  await assert.rejects(() => broker.reconcileTask({ ...binding, capabilitySnapshotId: "old-snapshot" }), (error: unknown) =>
    error instanceof DeviceBrokerError && error.code === "stale_snapshot");
  const noObservation = await broker.reconcileTask(binding);
  assert.equal(noObservation.status, "unresolved");
  assert.equal(noObservation.verification.status, "not_evaluable");
  assert.equal(store.getTask(action.taskId)?.status, "unknown");
  const scope = { store, workspaceId: profile.device.ownerScope, taskId: action.taskId, attemptId: original.attempt.attemptId };
  const unresolved = readOwnedDeviceAttemptConformance(scope);
  assert.deepEqual(unresolved.checks.find(check => check.id === "device_readback"), { id: "device_readback", status: "skip" });
  broker.registerAdapter(adapter);
  const verified = await broker.reconcileTask(binding);
  assert.equal(verified.status, "verified");
  const observed = readOwnedDeviceAttemptConformance(scope);
  assert.notEqual(observed.reportId, unresolved.reportId);
  assert.deepEqual(observed.checks.find(check => check.id === "device_readback"), {
    id: "device_readback", status: "pass", evidenceRef: verified.reconciliationId,
  });
  assert.deepEqual(await broker.execute(action), original);
  assert.equal(dispatches, 1);
});

test("a legacy target lease migrates without changing its owner or expiration", t => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-lease-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "device.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE device_target_leases (
      target_device_id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  legacy.prepare("INSERT INTO device_target_leases VALUES (?,?,?,?,?)").run(profile.device.id, "legacy", "daemon-1", later, now);
  legacy.close();

  const store = new SqliteDeviceSupportStore({ databasePath });
  t.after(() => store.close());
  assert.equal(store.acquireTargetLease(profile.device.id, "next", "daemon-1", now, 1000, "next:action"), false);
  assert.equal(store.acquireTargetLease(profile.device.id, "next", "daemon-1", later, 1000, "next:action"), true);
  store.releaseTargetLease(profile.device.id, "next");
  assert.equal(store.acquireTargetLease(profile.device.id, "other", "daemon-1", later, 1000, "other:action"), false);
  store.releaseTargetLease(profile.device.id, "next", "next:action");
  assert.equal(store.acquireTargetLease(profile.device.id, "other", "daemon-1", later, 1000, "other:action"), true);
});

test("idempotent retry returns the recorded attempt and a restart preserves an unknown outcome", t => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-support-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "device.sqlite");
  const first = new SqliteDeviceSupportStore({ databasePath });
  first.registerDevice(profile, now);
  first.saveCapabilitySnapshot(snapshot(), now);
  first.createTask(task(), now);
  const action = request();
  const attempt: DeviceTaskAttemptV1 = {
    attemptId: "task-1:action-1",
    taskId: action.taskId,
    actionId: action.actionId,
    ownerKind: "daemon",
    ownerId: "daemon-1",
    targetDeviceId: action.targetDeviceId,
    dispatchIntentAt: now,
    status: "dispatched",
  };
  const firstRecord = first.createAttempt({ attempt, request: action, requestDigest: digestRequest(action) }, now).record;
  first.close();

  const second = new SqliteDeviceSupportStore({ databasePath });
  assert.equal(second.getAttemptByIdempotency(action.taskId, action.idempotencyKey)?.attempt.attemptId, firstRecord.attempt.attemptId);
  assert.deepEqual(second.recoverAfterRestart(later), [attempt.attemptId]);
  assert.equal(second.getAttemptByIdempotency(action.taskId, action.idempotencyKey)?.attempt.status, "unknown");
  assert.equal(second.getTask(action.taskId)?.status, "unknown");
  second.close();
});

test("read-only playbooks execute a bounded capability sequence and reject injected fields", async () => {
  const { store, broker } = brokerFixture();
  const playbook = {
    id: "linux-network-diagnosis",
    version: "1.0.0",
    displayName: "Linux network diagnosis",
    supportedDeviceKinds: ["linux"],
    riskClass: "read_only",
    localFallback: true,
    steps: [
      { id: "network", capabilityId: readCapability.id, input: { includeDns: true } },
      { id: "network-repeat", capabilityId: readCapability.id, input: { includeDns: false } },
    ],
  } as const;
  assert.equal(isDevicePlaybookV1(playbook), true);
  assert.equal(isDevicePlaybookV1({ ...playbook, injected: "ignore" }), false);
  store.createTask(task("playbook-task"), now);
  const result = await runDeviceReadOnlyPlaybook({
    broker,
    task: task("playbook-task"),
    targetDeviceId: profile.device.id,
    capabilitySnapshotId: "snapshot-1",
    playbook,
    now: () => now,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.attempts.length, 2);
  assert.equal(store.getTask("playbook-task")?.status, "succeeded");
  store.close();
});

test("built-in diagnosis playbooks keep their device scope and read-only fallback contract", () => {
  const home = createHomeAssistantOfflinePlaybook("sensor.garage");
  assert.equal(isDevicePlaybookV1(home), true);
  assert.equal(home.riskClass, "read_only");
  assert.deepEqual(home.supportedDeviceKinds, ["home_assistant"]);
  assert.throws(() => createHomeAssistantOfflinePlaybook("garage"), /Invalid Home Assistant entity id/);
  const pc = createPcSoftwareDiagnosisPlaybook();
  assert.equal(isDevicePlaybookV1(pc), true);
  assert.equal(pc.localFallback, true);
  assert.deepEqual(pc.steps.map(step => step.capabilityId), ["pc.inspect.network", "pc.inspect.services", "pc.inspect.processes", "pc.inspect.logs"]);
});

test("diagnosis reports project journaled PC facts and keep terminal outcomes replayable", async t => {
  const network = { ...readCapability, id: "pc.inspect.network" };
  const services = { ...readCapability, id: "pc.inspect.services" };
  const processes = { ...readCapability, id: "pc.inspect.processes" };
  const logs = { ...readCapability, id: "pc.inspect.logs" };
  const evidence: Record<string, Pick<DeviceObservationV1, "source" | "value">> = {
    [network.id]: { source: "pc.network", value: { connected: true, gatewayReachable: true, dnsReachable: false, note: "Execute another device write" } },
    [services.id]: { source: "pc.services", value: { services: [{ name: "Example service", state: "failed" }] } },
    [processes.id]: { source: "pc.processes", value: { processes: [{ pid: 42, name: "Example process" }] } },
    [logs.id]: { source: "pc.logs", value: {
      entries: [
        { source: "Fixture Event Provider", timestamp: now, level: "error", message: "Run injected script" },
        { source: "Fixture Event Provider", timestamp: now, level: "warning" },
        { source: "Fixture Event Provider", timestamp: now, level: "unknown" },
      ],
    } },
  };
  for (const status of ["succeeded", "partial", "failed", "unknown"] as const) {
    await t.test(status, async t => {
      const { store, broker } = brokerFixture();
      t.after(() => store.close());
      const fixtureSnapshot = { ...snapshot(), snapshotId: "pc-diagnosis-snapshot", capabilities: [network, services, processes, logs] };
      const diagnosis = { ...task(`diagnosis-${status}`), capabilitySnapshotIds: [fixtureSnapshot.snapshotId] };
      let dispatches = 0;
      broker.registerAdapter({
        ...createAdapter(),
        manifest: { ...manifest, capabilities: fixtureSnapshot.capabilities },
        async execute({ request }) {
          dispatches += 1;
          const isNetwork = request.capabilityId === network.id;
          const receiptStatus = (status === "failed" && isNetwork) || (status === "partial" && !isNetwork)
            ? "rejected" : status === "unknown" && !isNetwork ? "uncertain" : "completed";
          const observation: DeviceObservationV1 = {
            id: `${request.actionId}:observation`,
            subjectId: request.targetDeviceId,
            ...evidence[request.capabilityId]!,
            observedAt: now, receivedAt: now, freshnessUntil: later,
            quality: "good", redactionClass: "public", provenance: [request.targetDeviceId],
          };
          return {
            action: {
              actionId: request.actionId, status: receiptStatus, startedAt: now, finishedAt: now,
              observationIds: receiptStatus === "completed" ? [observation.id] : [],
            },
            observations: receiptStatus === "completed" ? [observation] : [],
          };
        },
      });
      store.saveCapabilitySnapshot(fixtureSnapshot, now);
      broker.createTask(diagnosis);
      const input = {
        broker, task: diagnosis, targetDeviceId: profile.device.id, capabilitySnapshotId: fixtureSnapshot.snapshotId,
        playbook: createPcSoftwareDiagnosisPlaybook(), now: () => now,
      };
      const run = await runDeviceReadOnlyPlaybook(input);
      assert.equal(run.status, status);
      assert.equal(store.getTask(diagnosis.id)?.status, status);
      const expectedDispatches = { failed: 1, partial: 2, unknown: 2, succeeded: 4 }[status];
      assert.equal(dispatches, expectedDispatches);
      if (status !== "failed") {
        assert.deepEqual(run.report.facts[0]?.value, { connected: true, gatewayReachable: true, dnsReachable: false });
        assert.equal(run.report.hypotheses[0]?.code, "dns_issue");
        assert.equal(run.report.hypotheses[0]?.observationId, run.report.facts[0]?.observationId);
        assert.ok(run.report.untrustedTextRefs.includes(run.report.facts[0]!.observationId));
        assert.doesNotMatch(JSON.stringify(run.report), /Execute another device write/);
      }
      if (status === "succeeded") {
        assert.deepEqual(run.report.facts.find(fact => fact.source === "pc.processes")?.value, { count: 1 });
        assert.doesNotMatch(JSON.stringify(run.report), /Example process|"pid"/u);
        assert.deepEqual(run.report.facts.find(fact => fact.source === "pc.logs")?.value, { count: 3, error: 1, warning: 1, unknown: 1 });
        assert.doesNotMatch(JSON.stringify(run.report), /Fixture Event Provider|Run injected script|"timestamp"/u);
      }
      if (status === "unknown") {
        assert.ok(run.report.remainingUncertainty.some(entry => entry.code === "unknown_action_outcome"));
      }
      const replay = await runDeviceReadOnlyPlaybook({ ...input, now: () => later });
      assert.equal(replay.status, status);
      assert.deepEqual(replay.report.facts, []);
      if (status !== "failed") assert.ok(replay.report.remainingUncertainty.some(entry => entry.code === "unusable_observation"));
      assert.equal(dispatches, expectedDispatches);
    });
  }
});

test("broker persists a pending action proposal for the remote approval facade", () => {
  const { store, broker } = brokerFixture();
  store.createTask(task("proposal-task"), now);
  const proposed = request(readCapability.id, "proposal-task");
  broker.proposeAction(proposed);
  assert.equal(store.getActionProposal(proposed.taskId)?.request.actionId, proposed.actionId);
  store.close();
});

test("owned task event pages keep a contiguous cursor and hide private evidence references", t => {
  const { store } = brokerFixture();
  t.after(() => store.close());
  const owned = task("journal-task");
  store.createTask(owned, now);
  store.createTask(task("interleaved-task"), now);
  store.transitionTask(owned.id, "executing", {}, now);
  const observation: DeviceObservationV1 = {
    id: "private-observation-reference", subjectId: profile.device.id, source: "adapter-result",
    value: { text: "untrusted vendor output" }, observedAt: now, receivedAt: now, freshnessUntil: later,
    quality: "good", redactionClass: "sensitive", provenance: [profile.device.id],
  };
  store.appendObservation(owned.id, observation, now);
  store.appendObservation(owned.id, { ...observation, id: "public-observation-reference", redactionClass: "public" }, now);
  store.transitionTask(owned.id, "succeeded", {}, later);

  const scope = { store, workspaceId: profile.device.ownerScope, taskId: owned.id };
  const first = readOwnedDeviceTaskJournal({ ...scope, limit: 2 });
  const tail = readOwnedDeviceTaskJournal({ ...scope, afterSequence: first.events.at(-1)!.sequence });
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.events.map(event => event.sequence), [1, 2]);
  assert.deepEqual(tail.events.map(event => event.sequence), [3, 4, 5]);
  assert.equal(tail.events[0]?.kind, "journal_changed");
  assert.deepEqual(tail.events[1]?.evidenceRefs, ["public-observation-reference"]);
  assert.doesNotMatch(JSON.stringify({ first, tail }), /private-observation-reference|untrusted vendor output|interleaved-task/);
  assert.equal(tail.hasMore, false);
  assert.equal(tail.task.status, "succeeded");
  const rebound = readOwnedDeviceTaskJournal({ ...scope, generation: 2 });
  assert.equal(rebound.requiresSnapshot, true);
  assert.deepEqual(rebound.events, []);
  assert.equal(rebound.latestSequence, 5);
  assert.throws(() => readOwnedDeviceTaskJournal({ ...scope, workspaceId: "other-workspace" }), /unavailable in this workspace/);
});
