import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isAdapterManifestV1, type DeviceActionRequestV1 } from "@ling-stack/contracts";
import { createHomeAssistantOfflinePlaybook, createPcSoftwareDiagnosisPlaybook, DeviceCapabilityBroker, digestRequest, runDeviceReadOnlyPlaybook, SqliteDeviceSupportStore } from "@ling-stack/core";
import {
  AndroidAdbAdapter,
  ExternalDeviceAdapter,
  HomeAssistantAdapter,
  LinuxSshAdapter,
  ObdVehicleAdapter,
  PcAdapter,
  type PcLogEntry,
  type PcSoftwareInventory,
  type PcProcessInfo,
  type PcServiceStatus,
} from "../dist/features/device-support/adapters/index.js";
import { readAndroidAdbTargets } from "../dist/features/device-support/android-adb-targets.js";

const now = "2026-11-21T00:00:00.000Z";

test("external adapters are isolated behind a bounded JSON process and restart after a child crash", async t => {
  const fixture = fileURLToPath(new URL("./support/external-device-adapter-fixture.ts", import.meta.url));
  const adapter = new ExternalDeviceAdapter({
    command: process.execPath,
    args: [fixture],
    manifest: {
      adapterId: "external-fixture", adapterVersion: "1.0.0", contractMajor: 1,
      supportedDeviceKinds: ["linux"], supportedTransports: ["local_process"],
      transportDeployments: [{ transport: "local_process", mode: "target_executor", pairing: "user_confirmation", removal: "remove_target_executor" }],
      requiredRuntime: "edge", authenticationMethods: ["fixture"],
      capabilities: [{
        id: "external.inspect", schemaVersion: "1.0", semanticVerb: "device.inspect", inputSchema: {}, outputSchema: {},
        sideEffect: "read_only", approvalClass: "allow", requiredPermissions: [], prerequisites: [], timeoutMs: 5000,
        responseBytesLimit: 4096, idempotency: "request", supportedDeviceKinds: ["linux"], supportedTransports: ["local_process"],
      }],
      removalBehavior: "revoke_and_disconnect",
    },
    requestTimeoutMs: 1500,
    maxFrameBytes: 4096,
  });
  t.after(() => adapter.close());
  const profile = await adapter.discover({ connectionRef: "fixture:ok", ownerId: "workspace" });
  assert.equal(profile.device.id, "external-fixture-device");
  const snapshot = await adapter.getCapabilities({ profile, connectionRevision: "connection-1" });
  assert.equal(snapshot.capabilities[0]?.id, "external.inspect");
  const result = await adapter.execute({
    profile,
    capability: snapshot.capabilities[0]!,
    request: {
      actionId: "external-action", taskId: "external-task", targetDeviceId: profile.device.id,
      capabilityId: "external.inspect", capabilitySchemaVersion: "1.0", capabilitySnapshotId: snapshot.snapshotId,
      normalizedInput: {}, idempotencyKey: "external-task:external-action",
    },
  });
  assert.equal("action" in result ? result.action.status : result.status, "completed");
  for (const [failure, code] of [
    ["crash", "connection_failed"], ["malformed", "connection_failed"],
    ["over-limit", "connection_failed"], ["hang", "timeout"],
  ]) {
    await assert.rejects(() => adapter.discover({ connectionRef: `fixture:${failure}`, ownerId: "workspace" }), { code });
    assert.equal((await adapter.discover({ connectionRef: "fixture:restarted", ownerId: "workspace" })).device.id, "external-fixture-device");
  }
});

test("Home Assistant adapter keeps credentials out of the profile and distinguishes entity states", async t => {
  const calls: { url: string; method: string; authorization?: string }[] = [];
  const adapter = new HomeAssistantAdapter({
    baseUrl: "https://ha.example.test/",
    token: "secret-token",
    now: () => now,
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") ?? undefined });
      if (url.endsWith("/api/config")) return new Response(JSON.stringify({ version: "2026.11" }), { status: 200 });
      if (url.endsWith("/api/states/light.kitchen")) return new Response(JSON.stringify({
        entity_id: "light.kitchen", state: "on", attributes: { brightness: 50 },
      }), { status: 200 });
      if (url.endsWith("/api/states/sensor.unavailable")) return new Response(JSON.stringify({
        entity_id: "sensor.unavailable", state: "unavailable", attributes: { message: "Untrusted device text" },
      }), { status: 200 });
      return new Response("missing", { status: 404 });
    },
  });
  assert.equal(isAdapterManifestV1(adapter.manifest), true);
  const profile = await adapter.discover({ connectionRef: "https://ha.example.test", ownerId: "mobile-1" });
  assert.equal(profile.connectionRefs[0], "https:ha.example.test");
  assert.equal(profile.connectionRefs.some(ref => ref.includes("secret-token")), false);
  assert.deepEqual((await adapter.readEntity("light.kitchen")).availability, "available");
  assert.deepEqual((await adapter.readEntity("sensor.unavailable")).quality, "degraded");
  assert.deepEqual((await adapter.readEntity("sensor.missing")).availability, "absent");
  const store = new SqliteDeviceSupportStore();
  t.after(() => store.close());
  const broker = new DeviceCapabilityBroker({ store, now: () => now });
  broker.registerAdapter(adapter);
  const target = await broker.discover(adapter.manifest.adapterId, { connectionRef: "https://ha.example.test", ownerId: "mobile-1" });
  const snapshot = store.getCurrentCapabilitySnapshot(target.device.id)!;
  for (const [entityId, availability] of [["light.kitchen", "available"], ["sensor.unavailable", "unavailable"], ["sensor.missing", "absent"]]) {
    const task = broker.createTask({
      id: `diagnosis:${entityId}`, ownerKind: "daemon", ownerId: "pc-1", targetDeviceIds: [target.device.id],
      status: "planning", capabilitySnapshotIds: [snapshot.snapshotId], createdAt: now, updatedAt: now,
    });
    const run = await runDeviceReadOnlyPlaybook({
      broker, task, targetDeviceId: target.device.id, capabilitySnapshotId: snapshot.snapshotId,
      playbook: createHomeAssistantOfflinePlaybook(entityId),
    });
    assert.deepEqual(run.report.facts.map(fact => fact.value), [{ availability }]);
    assert.doesNotMatch(JSON.stringify(run.report), /Untrusted device text|secret-token/);
  }
  assert.equal(calls.every(call => call.authorization === "Bearer secret-token"), true);
});

test("Home Assistant diagnosis normalizes report timestamps and distinguishes stale, legacy, invalid, and future reports", async t => {
  const reports: Record<string, Record<string, unknown>> = {
    "sensor.fresh": { entity_id: "sensor.fresh", state: "on", attributes: { secret: "omit" }, last_reported: "2026-11-20T23:59:00Z", last_updated: "2026-11-20T23:58:00Z", last_changed: "2026-11-20T23:57:00Z" },
    "sensor.stale": { entity_id: "sensor.stale", state: "on", last_reported: "2026-11-20T00:00:00Z" },
    "sensor.invalid": { entity_id: "sensor.invalid", state: "on", last_reported: "1" },
    "sensor.future": { entity_id: "sensor.future", state: "on", last_reported: "2026-11-22T00:00:00Z" },
    "sensor.legacy": { entity_id: "sensor.legacy", state: "on" },
  };
  const adapter = new HomeAssistantAdapter({
    baseUrl: "https://ha.example.test/", token: "secret-token", now: () => now,
    fetchImpl: async input => {
      const entityId = new URL(String(input)).pathname.split("/").at(-1)!;
      return entityId === "config" ? new Response(JSON.stringify({ version: "2026.11" }))
        : new Response(JSON.stringify(reports[entityId] ?? {}), { status: reports[entityId] ? 200 : 404 });
    },
  });
  const fresh = await adapter.readEntity("sensor.fresh", undefined, 5 * 60 * 1000);
  assert.deepEqual(fresh, {
    entityId: "sensor.fresh", availability: "available", quality: "good", observedAt: now,
    lastReportedAt: "2026-11-20T23:59:00.000Z", lastUpdatedAt: "2026-11-20T23:58:00.000Z", lastChangedAt: "2026-11-20T23:57:00.000Z",
    reportTimestampStatus: "valid", reportFreshness: "fresh",
  });
  const stale = await adapter.readEntity("sensor.stale", undefined, 5 * 60 * 1000);
  assert.equal(stale.reportFreshness, "stale");
  const invalid = await adapter.readEntity("sensor.invalid", undefined, 5 * 60 * 1000);
  assert.deepEqual({ status: invalid.reportTimestampStatus, freshness: invalid.reportFreshness }, { status: "invalid", freshness: "unknown" });
  const future = await adapter.readEntity("sensor.future", undefined, 5 * 60 * 1000);
  assert.deepEqual({ status: future.reportTimestampStatus, freshness: future.reportFreshness }, { status: "future", freshness: "unknown" });
  const legacy = await adapter.readEntity("sensor.legacy", undefined, 5 * 60 * 1000);
  assert.deepEqual({ status: legacy.reportTimestampStatus, freshness: legacy.reportFreshness }, { status: "missing", freshness: "unknown" });
  assert.equal(Object.hasOwn(fresh, "attributes"), false);

  const store = new SqliteDeviceSupportStore();
  t.after(() => store.close());
  const broker = new DeviceCapabilityBroker({ store, now: () => now });
  broker.registerAdapter(adapter);
  const target = await broker.discover(adapter.manifest.adapterId, { connectionRef: "https://ha.example.test", ownerId: "workspace" });
  const snapshot = store.getCurrentCapabilitySnapshot(target.device.id)!;
  const task = broker.createTask({ id: "stale-report-diagnosis", ownerKind: "daemon", ownerId: "workspace", targetDeviceIds: [target.device.id], status: "planning", capabilitySnapshotIds: [snapshot.snapshotId], createdAt: now, updatedAt: now });
  const run = await runDeviceReadOnlyPlaybook({ broker, task, targetDeviceId: target.device.id, capabilitySnapshotId: snapshot.snapshotId,
    playbook: createHomeAssistantOfflinePlaybook("sensor.stale", { maxReportAgeMs: 5 * 60 * 1000 }) });
  assert.deepEqual(run.report.facts[0]?.value, { availability: "available", lastReportedAt: "2026-11-20T00:00:00.000Z", reportTimestampStatus: "valid", reportFreshness: "stale" });
  assert.deepEqual(run.report.hypotheses.map(item => item.code), ["stale_entity_report"]);
});

test("PC adapter uses typed executor operations for diagnosis and repair", async () => {
  const operations: string[] = [];
  const adapter = new PcAdapter({
    now: () => now,
    executor: {
      async inventory() { operations.push("inventory"); return { hostname: "test-pc", os: "linux", version: "6.1" }; },
      async readNetwork() { operations.push("readNetwork"); return { connected: false, gatewayReachable: false }; },
      async readServices() { operations.push("readServices"); return [{ name: "network", state: "failed" }]; },
      async readProcesses() { operations.push("readProcesses"); return []; },
      async readLogs() { operations.push("readLogs"); return []; },
      async readSoftware() { operations.push("readSoftware"); return { entries: [], truncated: false }; },
      async repairNetwork() { operations.push("repairNetwork"); return { accepted: true, changed: true }; },
    },
  });
  const profile = await adapter.discover({ connectionRef: "local:test-pc", ownerId: "pc-1" });
  assert.equal(profile.device.kind, "pc");
  const action = await adapter.execute({
    profile,
    capability: adapter.manifest.capabilities.find(capability => capability.id === "pc.repair.network")!,
    request: {
      actionId: "action-1",
      taskId: "task-1",
      targetDeviceId: profile.device.id,
      capabilityId: "pc.repair.network",
      capabilitySchemaVersion: "1.0",
      capabilitySnapshotId: "snapshot-1",
      normalizedInput: { mode: "refresh_dhcp" },
      idempotencyKey: "task-1:action-1",
    },
  });
  assert.equal("action" in action ? action.action.status : action.status, "completed");
  assert.deepEqual(operations, ["inventory", "repairNetwork"]);
});

test("PC diagnosis distinguishes empty native inventories from unavailable evidence", async t => {
  const store = new SqliteDeviceSupportStore();
  t.after(() => store.close());
  const broker = new DeviceCapabilityBroker({ store, now: () => now });
  let services: readonly PcServiceStatus[] | undefined;
  let processes: readonly PcProcessInfo[] | undefined;
  let logs: readonly PcLogEntry[] | undefined;
  let software: PcSoftwareInventory | undefined;
  const adapter = new PcAdapter({
    now: () => now,
    executor: {
      async inventory() { return { hostname: "test-pc", os: "linux" }; },
      async readNetwork() { return { connected: true }; },
      async readServices() { return services; },
      async readProcesses() { return processes; },
      async readLogs() { return logs; },
      async readSoftware() { return software; },
      async repairNetwork() { throw new Error("unexpected write"); },
    },
  });
  broker.registerAdapter(adapter);
  const target = await broker.discover(adapter.manifest.adapterId, { connectionRef: "local:test-pc", ownerId: "workspace" });
  const snapshot = store.getCurrentCapabilitySnapshot(target.device.id)!;
  const oversizedServices: PcServiceStatus[] = Array.from({ length: 1024 }, (_, index) => ({ name: `${index}-${"x".repeat(250)}`, state: "running" }));
  const oversizedProcesses: PcProcessInfo[] = oversizedServices.map(({ name }, pid) => ({ pid, name }));
  const oversizedLogs: PcLogEntry[] = oversizedServices.map(({ name }) => ({ source: name, level: "error", timestamp: now }));
  const oversizedSoftware: PcSoftwareInventory = {
    entries: oversizedServices.map(({ name }) => ({ name, source: "dpkg" })), truncated: true,
  };
  for (const [taskId, serviceResult, processResult, logResult, softwareResult, expectedQuality] of [
    ["empty", [], [], [], { entries: [], truncated: false }, "good"],
    ["failed", undefined, undefined, undefined, undefined, "unknown"],
    ["oversize", oversizedServices, oversizedProcesses, oversizedLogs, oversizedSoftware, "unknown"],
  ] as const) {
    services = serviceResult;
    processes = processResult;
    logs = logResult;
    software = softwareResult;
    const task = broker.createTask({
      id: taskId, ownerKind: "daemon", ownerId: "pc-1", targetDeviceIds: [target.device.id],
      status: "planning", capabilitySnapshotIds: [snapshot.snapshotId], createdAt: now, updatedAt: now,
    });
    const run = await runDeviceReadOnlyPlaybook({
      broker, task, targetDeviceId: target.device.id, capabilitySnapshotId: snapshot.snapshotId,
      playbook: createPcSoftwareDiagnosisPlaybook(),
    });
    const observations = store.listObservations(task.id);
    for (const [source, emptyReading, emptyFact] of [
      ["pc.services", { services: [] }, { running: 0, stopped: 0, failed: 0, unknown: 0 }],
      ["pc.processes", { processes: [] }, { count: 0 }],
      ["pc.logs", { entries: [] }, { count: 0, error: 0, warning: 0, unknown: 0 }],
      ["pc.software", { software: [], truncated: false }, { count: 0, sources: { dpkg: 0, rpm: 0, system_profiler: 0, registry: 0, unknown: 0 }, truncated: false }],
    ] as const) {
      const observation = observations.find(item => item.source === source);
      assert.ok(observation);
      assert.equal(observation.quality, expectedQuality);
      const fact = run.report.facts.find(item => item.source === source);
      if (expectedQuality === "good") {
        assert.deepEqual(observation.value, emptyReading);
        assert.deepEqual(fact?.value, emptyFact);
        assert.deepEqual(run.report.remainingUncertainty, []);
      } else {
        assert.deepEqual(observation.value, { status: "unavailable" });
        assert.equal(fact, undefined);
        assert.ok(run.report.remainingUncertainty.some(entry => entry.code === "unusable_observation" && entry.ref === observation.id));
      }
    }
  }
});

test("Linux SSH adapter exposes diagnosis and network repair through a fixed operation set", async () => {
  const operations: string[] = [];
  const adapter = new LinuxSshAdapter({
    now: () => now,
    executor: {
      async inventory() { operations.push("inventory"); return { hostname: "linaro-p", kernel: "6.6" }; },
      async readNetwork() { operations.push("readNetwork"); return { connected: true, gatewayReachable: true }; },
      async readWifi() { operations.push("readWifi"); return { connected: false, ssid: "home", gatewayReachable: false, linkError: "association_failed" }; },
      async restartNetwork() { operations.push("restartNetwork"); return { accepted: true }; },
    },
  });
  const profile = await adapter.discover({ connectionRef: "ssh:linaro-p", ownerId: "mobile-1" });
  await adapter.execute({ profile, capability: adapter.manifest.capabilities[1]!, request: {
    actionId: "wifi-action",
    taskId: "wifi-task",
    targetDeviceId: profile.device.id,
    capabilityId: "linux.inspect.wifi",
    capabilitySchemaVersion: "1.0",
    capabilitySnapshotId: "snapshot-1",
    normalizedInput: {},
    idempotencyKey: "wifi-task:wifi-action",
  } });
  assert.deepEqual(operations, ["inventory", "readWifi"]);
});

test("Linux network repair reconciles with fresh observations without repeating the restart", async t => {
  const store = new SqliteDeviceSupportStore();
  t.after(() => store.close());
  const broker = new DeviceCapabilityBroker({ store, now: () => now });
  let restartCount = 0;
  let recoveryChecks = 0;
  let recoveryAvailable = false;
  let dnsReachable: boolean | undefined;
  broker.registerAdapter(new LinuxSshAdapter({
    now: () => now,
    executor: {
      async inventory() { return { hostname: "fixture-target", kernel: "6.6" }; },
      async readNetwork() { return { connected: true, routeAvailable: true, dnsReachable }; },
      async readWifi() { return { connected: true }; },
      async verifyNetworkRecovery({ plan, baseline }) {
        recoveryChecks += 1;
        return recoveryAvailable && plan.routeRevision === "fixture:usb" && baseline.subjectId === targetDeviceId;
      },
      async restartNetwork() { restartCount += 1; throw new Error("SSH interrupted"); },
    },
  }));
  const target = await broker.discover("linux-ssh", { connectionRef: "ssh:fixture-target", ownerId: "workspace" });
  const targetDeviceId = target.device.id;
  const snapshot = store.getCurrentCapabilitySnapshot(targetDeviceId);
  assert.ok(snapshot);
  const task = broker.createTask({
    id: "linux-recover", ownerKind: "daemon", ownerId: "pc", targetDeviceIds: [targetDeviceId],
    status: "planning", capabilitySnapshotIds: [snapshot.snapshotId], createdAt: now, updatedAt: now,
  });
  const baseline = await broker.execute({
    taskId: task.id, targetDeviceId, actionId: "network-baseline", capabilityId: "linux.inspect.network",
    capabilitySchemaVersion: "1.0", capabilitySnapshotId: snapshot.snapshotId, idempotencyKey: "network-baseline",
    normalizedInput: {},
  }, undefined, { finalizeTask: false });
  const baselineObservationId = baseline.attempt.receipt?.observationIds[0];
  assert.ok(baselineObservationId);
  const request: DeviceActionRequestV1 = {
    taskId: task.id, targetDeviceId, actionId: "restart", capabilityId: "linux.repair.network",
    capabilitySchemaVersion: "1.0", capabilitySnapshotId: snapshot.snapshotId, idempotencyKey: "restart",
    normalizedInput: {}, expectedVerification: { connected: true, routeAvailable: true, dnsReachable: true },
    recoveryPlan: { kind: "alternate_route", routeRevision: "fixture:usb", baselineObservationId, verifyBy: "2026-11-21T00:02:00.000Z" },
  };
  const approved: DeviceActionRequestV1 = {
    ...request, approvalId: "restart-approval",
    approval: {
      approvalId: "restart-approval", taskId: task.id, targetDeviceId, actionId: request.actionId,
      capabilitySnapshotId: snapshot.snapshotId, connectionRevision: snapshot.connectionRevision,
      policyRevision: broker.policyRevision, normalizedInputDigest: digestRequest(request),
      expiresAt: "2026-11-21T00:01:00.000Z",
      recoveryScope: request.recoveryPlan,
    },
  };
  await assert.rejects(() => broker.execute({ ...approved, approval: { ...approved.approval!, recoveryScope: { baseline: "changed" } } }), /exact approval/u);
  assert.equal(recoveryChecks, 0);
  await assert.rejects(() => broker.execute(approved), /recovery route could not be verified/u);
  assert.equal(recoveryChecks, 1);
  assert.equal(restartCount, 0);
  assert.deepEqual(store.listAttempts(task.id).map(item => item.request.actionId), ["network-baseline"]);
  recoveryAvailable = true;
  const { attempt } = await broker.execute(approved);
  assert.equal(recoveryChecks, 2);
  assert.equal(attempt.recoveryPathVerifiedAt, now);
  assert.equal(attempt.status, "unknown");
  assert.equal(attempt.receipt?.status, "uncertain");
  const readback = { taskId: task.id, attemptId: attempt.attemptId, capabilitySnapshotId: snapshot.snapshotId };
  const missing = await broker.reconcileTask(readback);
  assert.equal(missing.status, "unresolved");
  assert.equal(missing.verification.status, "not_evaluable");
  assert.equal(store.getTask(task.id)?.status, "unknown");

  dnsReachable = false;
  const mismatch = await broker.reconcileTask(readback);
  assert.equal(mismatch.status, "unresolved");
  assert.equal(mismatch.verification.status, "failed");

  dnsReachable = true;
  const recovered = await broker.reconcileTask(readback);
  assert.equal(recovered.status, "verified");
  assert.deepEqual(recovered.verification.observationIds, [recovered.reconciliationId]);
  assert.equal(store.getTask(task.id)?.status, "succeeded");
  const observations = new Map(store.listObservations(task.id).map(observation => [observation.id, observation.value]));
  assert.deepEqual(observations, new Map([
    [baselineObservationId, { connected: true, routeAvailable: true }],
    [missing.reconciliationId, { connected: true, routeAvailable: true }],
    [mismatch.reconciliationId, { connected: true, routeAvailable: true, dnsReachable: false }],
    [recovered.reconciliationId, { connected: true, routeAvailable: true, dnsReachable: true }],
  ]));
  assert.deepEqual((await broker.execute(approved)).attempt, attempt);
  assert.equal(restartCount, 1);
  assert.equal(recoveryChecks, 2);
});

test("Android ADB adapter exposes fixed head-unit operations and verifies artifact installation", async () => {
  const operations: string[] = [];
  let serial = "head-unit-1";
  const adapter = new AndroidAdbAdapter({
    now: () => now,
    executor: {
      async inventory() { operations.push("inventory"); return { serial, model: "Linaro P", androidVersion: "7.1.2" }; },
      async readPackages() { operations.push("packages"); return [{ packageId: "com.example.carplay", versionName: "1.0" }]; },
      async readLogs() { operations.push("logs"); return "carplay ready"; },
      async installArtifact() { operations.push("install"); return { accepted: true, packageId: "com.example.carplay", versionName: "1.0" }; },
      async reboot() { operations.push("reboot"); return { accepted: true }; },
    },
  });
  const profile = await adapter.discover({ connectionRef: "adb:head-unit-1", ownerId: "pc-1" });
  assert.equal(profile.device.kind, "head_unit");
  const capability = adapter.manifest.capabilities.find(item => item.id === "android.install.artifact")!;
  const request = { actionId: "install-1", taskId: "task-1", targetDeviceId: profile.device.id, capabilityId: capability.id,
    capabilitySchemaVersion: "1.0", capabilitySnapshotId: "snapshot-1",
    normalizedInput: { artifactDigest: "sha256:app", packageId: "com.example.carplay" }, idempotencyKey: "task-1:install-1" };
  const action = await adapter.execute({ profile, capability, request });
  assert.equal("action" in action ? action.action.status : action.status, "completed");
  const actionResult = "action" in action ? action.action : action;
  const result = await adapter.verify({ profile, capability, request, action: actionResult, evidenceId: "inspection-1" });
  assert.equal(result.verification.status, "verified");
  assert.deepEqual(result.verification.observationIds, ["inspection-1"]);
  assert.deepEqual(result.observations?.map(item => [item.subjectId, item.value]), [
    [profile.device.id, { packageId: "com.example.carplay", present: true }],
  ]);
  const foreignPackage = await adapter.verify({ profile, capability, action: actionResult, evidenceId: "inspection-2",
    request: { ...request, expectedVerification: { packageId: "com.example.other" } } });
  assert.equal(foreignPackage.verification.status, "not_evaluable");
  const mismatch = await adapter.execute({ profile, capability: { id: "android.install.artifact" }, request: { actionId: "install-mismatch", taskId: "task-1", targetDeviceId: profile.device.id, capabilityId: "android.install.artifact", capabilitySchemaVersion: "1.0", capabilitySnapshotId: "snapshot-1", normalizedInput: { artifactDigest: "sha256:app", packageId: "com.example.other" }, idempotencyKey: "task-1:install-mismatch" } });
  assert.equal(("action" in mismatch ? mismatch.action : mismatch).errorCode, "target_changed");
  await assert.rejects(() => adapter.execute({ profile, capability: { id: "android.install.artifact" }, request: { actionId: "install-invalid", taskId: "task-1", targetDeviceId: profile.device.id, capabilityId: "android.install.artifact", capabilitySchemaVersion: "1.0", capabilitySnapshotId: "snapshot-1", normalizedInput: { artifactDigest: "sha256:app" }, idempotencyKey: "task-1:install-invalid" } }), /packageId/u);
  serial = "another-head-unit";
  await assert.rejects(() => adapter.execute({ profile, capability, request }), { code: "target_changed" });
  assert.deepEqual(operations, ["inventory", "inventory", "install", "inventory", "packages", "inventory", "install", "inventory"]);
});

test("configured ADB log captures bind the tag, connection and readback to one target", async t => {
  const root = mkdtempSync(join(tmpdir(), "ling-adb-operations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "targets.json");
  writeFileSync(path, JSON.stringify({ version: 1, targets: [{
    connectionId: "bench", adbSerial: "fixture-head-unit", hardwareSerial: "fixture-hardware-id", kind: "head_unit", logTag: "DiPlay",
  }] }));
  let transportId = "17";
  let logReads = 0;
  let captureFingerprint = "fixture/fingerprint";
  let output = "I/DiPlay: ready\n";
  const runner = {
    async run(_file: string, args: readonly string[]) {
      const operation = args.slice(4);
      if (operation[0] === "devices") {
        return { stdout: `List of devices attached\nfixture-head-unit device transport_id:${transportId}\n`, stderr: "", exitCode: 0 };
      }
      assert.deepEqual(operation.slice(0, 4), ["-t", transportId, "shell", "-T"]);
      const command = operation[4] ?? "";
      if (command.includes("logcat")) {
        logReads += 1;
        assert.match(command, /'DiPlay:V' '\*:S'/u);
        return { stdout: `fixture-hardware-id\n${captureFingerprint}\n${output}`, stderr: "", exitCode: 0 };
      }
      return { stdout: "fixture-hardware-id\nLinaro P\n7.1.2\nfixture/fingerprint\n", stderr: "", exitCode: 0 };
    },
  };
  const [target] = readAndroidAdbTargets(path, runner);
  assert.ok(target?.executor.readLogs);
  const readLogs = target.executor.readLogs;
  const { connectionRevision } = await target.executor.inventory();
  assert.ok(connectionRevision);
  assert.equal(await readLogs({ connectionRevision }), "I/DiPlay: ready\n");
  await assert.rejects(() => readLogs({ tag: "anotherTag", connectionRevision }), { code: "permission_denied" });
  transportId = "18";
  await assert.rejects(() => readLogs({ connectionRevision }), { code: "target_changed" });
  assert.equal(logReads, 1);
  transportId = "17";
  captureFingerprint = "unexpected/build";
  await assert.rejects(() => readLogs({ connectionRevision }), { code: "target_changed" });
  captureFingerprint = "fixture/fingerprint";
  output = "x".repeat(256 * 1024);
  await assert.rejects(() => readLogs({ connectionRevision }), { code: "connection_failed" });
});

test("OBD adapter exposes typed vehicle info, PID and DTC reads", async () => {
  const operations: string[] = [];
  const adapter = new ObdVehicleAdapter({
    now: () => now,
    executor: {
      async readVehicleInfo() { operations.push("info"); return { vin: "VIN-1", make: "Test", model: "Car", protocol: "iso15765" }; },
      async readPid(pid) { operations.push(`pid:${pid}`); return { pid, value: 90, unit: "%" }; },
      async readDtc() { operations.push("dtc"); return ["P0300"]; },
    },
  });
  const profile = await adapter.discover({ connectionRef: "obd:bridge-1", ownerId: "edge-1" });
  assert.equal(profile.device.kind, "vehicle");
  const pid = await adapter.execute({ profile, capability: { id: "vehicle.read.pid" }, request: { actionId: "pid-1", taskId: "task-1", targetDeviceId: profile.device.id, capabilityId: "vehicle.read.pid", capabilitySchemaVersion: "1.0", capabilitySnapshotId: "snapshot-1", normalizedInput: { pid: "0C" }, idempotencyKey: "task-1:pid-1" } });
  assert.equal("action" in pid ? pid.action.status : pid.status, "completed");
  const dtc = await adapter.execute({ profile, capability: { id: "vehicle.read.dtc" }, request: { actionId: "dtc-1", taskId: "task-1", targetDeviceId: profile.device.id, capabilityId: "vehicle.read.dtc", capabilitySchemaVersion: "1.0", capabilitySnapshotId: "snapshot-1", normalizedInput: {}, idempotencyKey: "task-1:dtc-1" } });
  assert.equal("action" in dtc ? dtc.action.status : dtc.status, "completed");
  assert.deepEqual(operations, ["info", "pid:0C", "dtc"]);
});
