import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type {
  DeviceActionRequestV1, DeviceDeveloperSessionV1, DeviceDiagnosisReportV1, DeviceResourceManifestV1,
  DeviceTaskAttemptV1, DeviceTaskJournalPageV1, DeviceTaskStatusV1, DeviceTaskTraceV1,
} from "@ling-stack/contracts";
import {
  buildOwnedDevicePlanningInput, createSqliteRunStore, DEFAULT_WORKSPACE_ID, DeviceBrokerError, digestRequest,
  HardwareProtocolWorkbench, modbusRtuRegisterCodec, readOwnedDeviceTaskTrace, SqliteDeviceSupportStore,
} from "@ling-stack/core";
import { canonicalJsonBytes } from "@ling-stack/remote-protocol";
import { createDeviceSupportRuntime } from "../dist/features/device-support/runtime.js";
import { createDaemonServer } from "../dist/index.js";
import { startLoopbackPiProvider } from "./support/loopback-pi-provider-fixture.mjs";

test("daemon device-support runtime composes the durable store, broker and remote facade", () => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-runtime-"));
  const runtime = createDeviceSupportRuntime({ databasePath: join(root, "workspace.sqlite") });
  assert.ok(runtime.store.database);
  assert.ok(runtime.fabricStore.database);
  assert.ok(runtime.developerStore.database);
  assert.ok(runtime.protocolStore.database);
  assert.equal(runtime.broker.store, runtime.store);
  assert.ok(runtime.collaboration);
  assert.ok(runtime.edgeRuntimes);
  assert.equal(runtime.edgeJournal.read("edge-fixture", "task-fixture").length, 0);
  assert.ok(runtime.access);
  assert.equal(runtime.remoteFacade.listDevices("workspace-1").devices.length, 0);
  const now = new Date().toISOString();
  const session = runtime.developerSessions.createSession({
    sessionId: "local-developer-session", workspaceId: DEFAULT_WORKSPACE_ID, ownerKind: "daemon", ownerId: "local-runtime",
    targetDeviceId: "fixture-target", targetKind: "android", mode: "developer", authorizationRevision: "local-confirmation",
    status: "created", revision: 1, createdAt: now, updatedAt: now,
  });
  assert.deepEqual(runtime.developerStore.getSession(session.sessionId), session);
  runtime.close();
});

test("daemon startup recovers interrupted dispatch and readback from the owner journal", async t => {
  const root = mkdtempSync(join(tmpdir(), "ling-runtime-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "workspace.sqlite");
  const startedAt = "2026-11-21T00:00:00.000Z";
  const restartedAt = "2026-11-21T00:01:00.000Z";
  const first = createDeviceSupportRuntime({ databasePath, now: () => startedAt });
  function record(taskId: string, taskStatus: DeviceTaskStatusV1, attemptStatus: DeviceTaskAttemptV1["status"], ownerKind: DeviceTaskAttemptV1["ownerKind"] = "daemon") {
    const request: DeviceActionRequestV1 = {
      taskId, actionId: "inspect-network", targetDeviceId: "device-1", capabilityId: "pc.inspect.network",
      capabilitySchemaVersion: "1.0", capabilitySnapshotId: "snapshot-1", idempotencyKey: "original-request",
      normalizedInput: {},
    };
    first.store.createTask({
      id: taskId, ownerKind, ownerId: "runtime-1", targetDeviceIds: [request.targetDeviceId],
      capabilitySnapshotIds: [request.capabilitySnapshotId], status: taskStatus,
      currentActionId: request.actionId, createdAt: startedAt, updatedAt: startedAt,
    }, startedAt);
    first.store.createAttempt({
      request, requestDigest: digestRequest(request),
      attempt: {
        attemptId: `${taskId}:attempt-1`, taskId, ownerKind, actionId: request.actionId, ownerId: "runtime-1",
        targetDeviceId: request.targetDeviceId, status: attemptStatus, dispatchIntentAt: startedAt,
        ...(attemptStatus === "completed" ? {
          receipt: { actionId: request.actionId, status: "completed", startedAt, finishedAt: startedAt, observationIds: [] },
        } : {}),
      },
    }, startedAt);
    return request;
  }
  const dispatch = record("interrupted-dispatch", "executing", "dispatched");
  const readback = record("interrupted-verification", "verifying", "completed");
  const peer = record("peer-task", "executing", "dispatched", "mobile");
  first.close();

  const restarted = createDeviceSupportRuntime({ databasePath, now: () => restartedAt });
  try {
    assert.equal(restarted.store.getTask(dispatch.taskId)?.status, "unknown");
    assert.equal(restarted.store.getTask(readback.taskId)?.status, "unknown");
    assert.equal(restarted.store.getTask(peer.taskId)?.status, "executing");
    assert.equal((await restarted.broker.execute(dispatch)).attempt.status, "unknown");
    const priorReadback = (await restarted.broker.execute(readback)).attempt;
    assert.equal(priorReadback.receipt?.status, "completed");
    assert.equal(priorReadback.verification, undefined);
    await assert.rejects(() => restarted.broker.execute({ ...readback, idempotencyKey: "changed-request" }), (error: unknown) =>
      error instanceof DeviceBrokerError && error.code === "unknown_outcome");
    assert.deepEqual(restarted.store.recoverAfterRestart(restartedAt), []);
  } finally {
    restarted.close();
  }
});

test("daemon runtime registers the Modbus codec and restores offline captures with loss evidence", t => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-protocol-replay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "workspace.sqlite");
  const captureTime = "2026-11-21T00:00:00.000Z";
  const owner = createDeviceSupportRuntime({ databasePath });
  try {
    assert.deepEqual(owner.protocolProfiles.list().map(profile => profile.profileId), ["modbus-rtu-registers"]);
    assert.equal(owner.protocolStore.getProfile("modbus-rtu-registers")?.codecId, modbusRtuRegisterCodec.manifest.codecId);
    const capture = owner.protocolWorkbench.capture({
      captureId: "modbus-temperature-register", targetDeviceId: "fixture-rs485", transport: "rs485", source: "imported",
      createdAt: captureTime, loss: { reason: "connection_interrupted" },
      frames: [{ direction: "rx", bytes: Buffer.from("010302000a3843", "hex"), capturedAt: captureTime }],
    });
    owner.protocolStore.saveCapture(capture);
  } finally {
    owner.close();
  }
  const reopened = createDeviceSupportRuntime({ databasePath });
  try {
    const codec = reopened.protocolStore.getCodec(modbusRtuRegisterCodec.manifest.codecId);
    assert.equal(reopened.protocolStore.getProfile("modbus-rtu-registers")?.transport, "rs485");
    assert.deepEqual(codec, modbusRtuRegisterCodec.manifest);
    const capture = reopened.protocolStore.getCapture("modbus-temperature-register");
    assert.ok(capture && codec);
    assert.deepEqual(capture.loss, { reason: "connection_interrupted" });
    assert.equal(reopened.protocolWorkbench.decode(capture, codec.codecId)[0]?.fields.register0, 10);
  } finally {
    reopened.close();
  }
});

test("the local protocol workbench imports target-bound capture evidence and resumes the same job after restart", { timeout: 15_000 }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-device-workbench-route-"));
  const authToken = "fixture-daemon-authority";
  const headers = { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" };
  let server: ReturnType<typeof createDaemonServer> | undefined;
  let databasePath: string;
  async function start() {
    const workspace = createSqliteRunStore(cwd);
    databasePath = workspace.paths.databasePath;
    server = createDaemonServer({ host: "127.0.0.1", port: 0, authToken, defaultWorkspaceCwd: cwd }, {
      storeFactory: () => workspace, chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null,
    });
    await server.start();
    const address = server.server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}/v1/device-support/protocol`;
  }
  t.after(async () => {
    await server?.stop();
    rmSync(cwd, { recursive: true, force: true });
  });
  const origin = await start();
  const targetDeviceId = "offline-rs485";
  const post = (url: string, body: unknown, extraHeaders: Record<string, string> = {}) => fetch(url, {
    method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body),
  });
  const input = { profileId: "modbus-rtu-registers", targetDeviceId };
  assert.equal((await fetch(origin + "/profiles")).status, 401);
  assert.equal((await post(origin + "/sessions", input, { Origin: "https://example.invalid" })).status, 403);
  const created = await post(origin + "/sessions", input);
  assert.equal(created.status, 201);
  const { session } = await created.json() as { session: DeviceDeveloperSessionV1 };
  assert.equal(session.targetDeviceId, targetDeviceId);
  assert.equal(session.protocolReplay?.codecVersion, "1.0.0");
  const replayPath = `/sessions/${session.sessionId}/replay`;
  const url = origin + replayPath;
  const at = "2026-11-21T00:00:00.000Z";
  const capture = new HardwareProtocolWorkbench().capture({
    captureId: "temperature", targetDeviceId, transport: "rs485", source: "imported", createdAt: at,
    loss: { reason: "adapter_overrun", droppedFrames: 1 },
    frames: [{ direction: "rx", bytes: Buffer.from("010302000a3843", "hex"), capturedAt: at }],
  });
  const replayInput = { authorizationRevision: session.authorizationRevision, capture };
  assert.equal((await post(url, { ...replayInput, authorizationRevision: "expired-revision" })).status, 403);
  assert.equal((await post(url, { ...replayInput, capture: { ...capture, targetDeviceId: "other-target" } })).status, 409);
  assert.equal((await post(url, { ...replayInput, capture: { ...capture, frames: [{ ...capture.frames[0], digest: "0".repeat(64) }] } })).status, 409);
  const database = new DatabaseSync(databasePath!);
  try {
    database.exec("CREATE TRIGGER fixture_unavailable_capture BEFORE INSERT ON device_protocol_captures BEGIN SELECT RAISE(ABORT, 'capture storage unavailable'); END;");
    assert.equal((await post(url, replayInput)).status, 503);
    assert.equal((await fetch(url, { headers })).status, 404);
    database.exec("DROP TRIGGER fixture_unavailable_capture;");
  } finally {
    database.close();
  }
  await server?.stop();
  server = undefined;
  const reopenedUrl = await start() + replayPath;
  assert.equal((await post(reopenedUrl, { ...replayInput, capture: { ...capture, captureId: "changed" } })).status, 409);
  const completed = await post(reopenedUrl, replayInput);
  assert.equal(completed.status, 201);
  const result = await completed.json();
  assert.equal(result.job.taskStatus, "succeeded");
  assert.equal(result.replay.frames[0].fields.register0, 10);
  assert.deepEqual(result.replay.loss, capture.loss);
  assert.equal(result.replay.frames[0].digest, capture.frames[0]?.digest);
  assert.deepEqual(await (await fetch(reopenedUrl, { headers })).json(), result);
  const repeated = await post(reopenedUrl, replayInput);
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), result);
});

test("the local daemon activates and rolls back Ed25519-signed resource imports", async t => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-resource-policy-"));
  const workspace = createSqliteRunStore(root);
  const trustPath = join(root, "device-resource-trust.json");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = "fixture-release";
  writeFileSync(trustPath, JSON.stringify({
    version: 1, allowedLicenses: ["MIT"],
    signingKeys: [{ keyId, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) }],
  }));
  const authToken = "fixture-daemon-authority";
  const headers = { Authorization: "Bearer " + authToken, "Content-Type": "application/json" };
  const daemon = createDaemonServer({
    host: "127.0.0.1", port: 0, authToken, defaultWorkspaceCwd: root, deviceSupport: { resourceTrustFile: trustPath },
  }, { storeFactory: () => workspace });
  t.after(async () => {
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const url = "http://127.0.0.1:" + address.port + "/v1/device-support/resources";
  const resourceUrl = url + "/profile-fixture";
  const post = (value: unknown, extraHeaders: Record<string, string> = {}) => fetch(url, {
    method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(value),
  });
  const manifestBase = {
    resourceId: "profile-fixture", version: "1.0.0", kind: "schema", license: "MIT",
    dependencies: [], supportedDeviceKinds: ["linux"], entrypoint: "profile.json", contractMajor: 1,
  } as const;
  function signedFile(text: string, changes: Partial<Omit<DeviceResourceManifestV1, "signature" | "digest">> = {}) {
    const payload = Buffer.from(text);
    const unsigned = { ...manifestBase, ...changes, digest: createHash("sha256").update(payload).digest("hex") };
    const bytes = canonicalJsonBytes({ purpose: "ling.device-resource-manifest.v1", keyId, manifest: unsigned });
    return {
      manifest: { ...unsigned, signature: "ed25519:" + keyId + ":" + sign(null, bytes, privateKey).toString("base64url") },
      payloadBase64Url: payload.toString("base64url"),
    };
  }
  const original = signedFile('{"profile":"original"}');
  assert.equal((await post(original, { Origin: "https://elsewhere.example" })).status, 403);
  assert.equal((await fetch(resourceUrl)).status, 401);
  assert.equal((await fetch(resourceUrl, { headers })).status, 404);
  assert.equal((await post({ ...original, manifest: { ...original.manifest, version: "2.0.0" } })).status, 409);
  assert.equal((await post({ ...original, payloadBase64Url: Buffer.from("altered").toString("base64url") })).status, 409);
  const fakeKey = { ...original.manifest, signature: original.manifest.signature.replace(keyId, "unknown-key") };
  assert.equal((await post({ ...original, manifest: fakeKey })).status, 409);
  assert.equal((await post(signedFile("unsupported", { license: "Unapproved" }))).status, 409);
  assert.equal((await post(signedFile("unsupported", { supportedPlatforms: ["ios"] }))).status, 409);
  assert.equal((await post(signedFile("unsupported", { dependencies: ["missing-profile"] }))).status, 409);
  assert.equal((await post({ ...original, manifest: { ...original.manifest, extra: "unknown" } })).status, 400);
  const activated = await post(original);
  assert.equal(activated.status, 201);
  assert.match(activated.headers.get("cache-control") ?? "", /no-store/u);
  assert.equal((await post(original)).status, 200);
  assert.equal((await post(signedFile('{"profile":"conflicting content"}'))).status, 409);
  const update = signedFile('{"profile":"replacement"}', { version: "2.0.0" });
  assert.equal((await post(update)).status, 201);
  const rollback = await fetch(resourceUrl + "/rollback", { method: "POST", headers });
  assert.equal(rollback.status, 200);
  const { record } = await rollback.json() as { record: { manifest: DeviceResourceManifestV1; payloadDigest: string; status: string } };
  assert.deepEqual(record.manifest, original.manifest);
  assert.equal(record.payloadDigest, original.manifest.digest);
  const disabled = await fetch(resourceUrl + "/disable", { method: "POST", headers });
  assert.equal(disabled.status, 200);
  const status = await (await fetch(resourceUrl, { headers })).json() as { record: { status: string } };
  assert.equal(status.record.status, "disabled");
});

test("the local daemon exposes its PC report and sequenced task journal only on direct loopback", { timeout: 15_000 }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-device-pc-diagnosis-"));
  const workspace = createSqliteRunStore(cwd);
  const authToken = "fixture-daemon-authority";
  const headers = { Authorization: `Bearer ${authToken}` };
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, authToken, defaultWorkspaceCwd: cwd }, { storeFactory: () => workspace });
  t.after(async () => {
    await daemon.stop();
    rmSync(cwd, { recursive: true, force: true });
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/v1/device-support/pc/diagnose`;
  const fleetUrl = `http://127.0.0.1:${address.port}/v1/device-support/fleet/health`;
  assert.equal((await fetch(fleetUrl, { headers: { Origin: "https://example.invalid", ...headers } })).status, 403);
  assert.equal((await fetch(fleetUrl, { headers })).status, 200);
  const fleet = await (await fetch(fleetUrl, { headers })).json() as { projectionId: string; items: unknown[]; counts: Record<string, number> };
  assert.equal(fleet.projectionId, "fleet:workspace_default");
  assert.deepEqual(fleet.items, []);
  assert.equal(fleet.counts.unknown, 0);
  assert.equal((await fetch(fleetUrl, { method: "POST", headers })).status, 405);
  assert.equal((await fetch(url, { method: "POST", headers: { ...headers, Origin: "https://example.invalid" } })).status, 403);
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  assert.equal((await fetch(url, { headers })).status, 405);
  const response = await fetch(url, { method: "POST", headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/u);
  const { status, report } = await response.json() as { status: string; report: DeviceDiagnosisReportV1 };
  assert.equal(status, "succeeded");
  assert.equal(report.playbookId, "pc-software-diagnosis");
  assert.deepEqual(report.actions.map(action => action.capabilityId), ["pc.inspect.network", "pc.inspect.services"]);
  const network = report.facts.find(fact => fact.source === "pc.network");
  assert.ok(network);
  assert.equal(typeof (network.value as { connected?: unknown }).connected, "boolean");
  assert.doesNotMatch(JSON.stringify(network.value), /gatewayReachable|dnsReachable/u);

  const eventsUrl = `http://127.0.0.1:${address.port}/v1/device-support/tasks/${encodeURIComponent(report.taskId)}/events`;
  assert.equal((await fetch(eventsUrl, { headers: { ...headers, "X-Forwarded-For": "192.0.2.42" } })).status, 403);
  assert.equal((await fetch(`${eventsUrl}?limit=101`, { headers })).status, 400);
  const pageResponse = await fetch(`${eventsUrl}?limit=1`, { headers });
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("cache-control") ?? "", /no-store/u);
  const firstPage = await pageResponse.json() as DeviceTaskJournalPageV1;
  assert.equal(firstPage.events[0]?.kind, "task_created");
  assert.equal(firstPage.events[0]?.sequence, 1);
  assert.equal(firstPage.hasMore, true);
  const remainder = await (await fetch(`${eventsUrl}?afterSequence=1`, { headers })).json() as DeviceTaskJournalPageV1;
  assert.equal(remainder.events[0]?.sequence, 2);
  assert.equal(remainder.task.status, "succeeded");
  assert.ok(remainder.events.some(event => event.kind === "device_plan_accepted"));

  const traceUrl = new URL("trace", eventsUrl).href;
  assert.equal((await fetch(traceUrl)).status, 401);
  assert.equal((await fetch(traceUrl, { headers: { ...headers, Origin: "https://example.invalid" } })).status, 403);
  const traceResponse = await fetch(traceUrl, { headers });
  assert.equal(traceResponse.status, 200);
  assert.match(traceResponse.headers.get("cache-control") ?? "", /no-store/u);
  const trace = await traceResponse.json() as DeviceTaskTraceV1;
  assert.equal(trace.traceId, remainder.events[0]?.traceId);
  assert.equal(trace.taskStatus, "succeeded");
  const graph = trace.spans.find(span => span.kind === "graph");
  assert.ok(graph);
  const adapterSpans = trace.spans.filter(span => span.kind === "adapter");
  assert.deepEqual(adapterSpans.map(span => span.lineage?.attemptId).sort(), report.actions.map(action => action.attemptId).sort());
  assert.ok(adapterSpans.every(span => span.status === "ok" && span.parentSpanId === graph.spanId
    && span.lineage?.graphId === report.taskId && span.lineage.nodeId && span.lineage.connectionRevision));

  const journal = new SqliteDeviceSupportStore({ databasePath: workspace.paths.databasePath });
  try {
    const tasks = journal.listRecentDaemonTasks(DEFAULT_WORKSPACE_ID, 10);
    assert.deepEqual(tasks.map(task => task.id), [report.taskId]);
    assert.equal(tasks[0]?.status, "succeeded");
    assert.equal(tasks[0]?.ownerId, tasks[0]?.targetDeviceIds[0]);
    assert.equal(journal.listObservations(report.taskId).length, 2);
    const events = journal.listEvents(report.taskId);
    const planIndex = events.findIndex(event => event.type === "device_plan_accepted");
    const firstDispatch = events.findIndex(event => event.type === "attempt_prepared");
    assert.ok(planIndex >= 0 && firstDispatch > planIndex);
    assert.equal(events[planIndex]?.body.source, "local_playbook");
    assert.equal(events[planIndex]?.body.taskId, report.taskId);
    const traceScope = { store: journal, taskId: report.taskId, workspaceId: DEFAULT_WORKSPACE_ID };
    assert.deepEqual(readOwnedDeviceTaskTrace(traceScope), trace);
    assert.throws(() => readOwnedDeviceTaskTrace({ ...traceScope, workspaceId: "elsewhere" }), /unavailable in this workspace/);
    const input = {
      store: journal, taskId: report.taskId, ownerId: tasks[0]!.ownerId, workspaceId: DEFAULT_WORKSPACE_ID,
      contextId: "fixture-context", maxBytes: 4096, now: new Date().toISOString(),
    };
    const planned = buildOwnedDevicePlanningInput(input);
    assert.deepEqual(planned.context.facts, report.facts.map(fact => fact.value));
    assert.deepEqual(planned.targets.map(target => target.snapshot.deviceId), tasks[0]?.targetDeviceIds);
    assert.throws(() => buildOwnedDevicePlanningInput({ ...input, workspaceId: "elsewhere" }), /outside the workspace/);
  } finally {
    journal.close();
  }
});

test("the Daemon reuses Pi for typed diagnosis and preserves provider, fallback and invalid-plan evidence", { timeout: 30_000 }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-device-pi-diagnosis-"));
  let secondPlan = '{"stepIds":["inspect-network"]}';
  const firstProvider = await startLoopbackPiProvider(() => ({ text: '{"stepIds":["inspect-services"]}' }));
  const secondProvider = await startLoopbackPiProvider(() => ({ text: secondPlan }));
  let secondOnline = true;
  const workspace = createSqliteRunStore(cwd);
  const authToken = "fixture-daemon-authority";
  const headers = { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" };
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, authToken, defaultWorkspaceCwd: cwd }, {
    storeFactory: () => workspace, chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null,
  });
  t.after(async () => {
    await daemon.stop();
    await firstProvider.close();
    if (secondOnline) await secondProvider.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  const preset = (providerId: string, baseUrl: string) => {
    const at = new Date().toISOString();
    const row = workspace.createProviderPreset({
      kind: "openai-compatible", displayName: providerId, providerId, baseUrl, model: "static-tools",
      api: "openai-completions", capabilities: ["chat"], authHeader: false, reasoning: false,
    }, at);
    workspace.recordProviderCheckResult(row.id, { ok: true, code: "ready", message: "Loopback ready", checkedAt: at });
    return row.id;
  };
  const firstPreset = preset("first-loopback", firstProvider.baseUrl);
  const secondPreset = preset("second-loopback", secondProvider.baseUrl);
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}/v1/device-support`;
  const diagnose = (providerPresetId: string) => fetch(origin + "/pc/diagnose", {
    method: "POST", headers, body: JSON.stringify({ providerPresetId, symptom: "Check a local PC service" }),
  });
  async function checkDiagnosis(providerPresetId: string, expectedCapabilities: readonly string[], source: "model" | "graph") {
    const response = await diagnose(providerPresetId);
    const body = await response.json() as { status: string; report: DeviceDiagnosisReportV1 };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.status, "succeeded");
    assert.deepEqual(body.report.actions.map(action => action.capabilityId), expectedCapabilities);
    const traceResponse = await fetch(`${origin}/tasks/${body.report.taskId}/trace`, { headers });
    assert.equal(traceResponse.status, 200);
    const trace = await traceResponse.json() as DeviceTaskTraceV1;
    const planning = trace.spans.find(span => span.kind === source);
    assert.ok(planning);
    return { planning, adapters: trace.spans.filter(span => span.kind === "adapter") };
  }
  const first = await checkDiagnosis(firstPreset, ["pc.inspect.services"], "model");
  assert.match(first.planning.lineage?.modelTurnId ?? "", /^device_plan_turn_/u);
  assert.equal(first.adapters[0]?.lineage?.modelTurnId, first.planning.lineage?.modelTurnId);
  assert.match(JSON.stringify(first.planning.metadata), new RegExp(firstPreset, "u"));
  const second = await checkDiagnosis(secondPreset, ["pc.inspect.network"], "model");
  assert.notEqual(second.planning.lineage?.modelTurnId, first.planning.lineage?.modelTurnId);
  assert.match(JSON.stringify(second.planning.metadata), new RegExp(secondPreset, "u"));
  for (const provider of [firstProvider, secondProvider]) {
    const streamed = provider.requests.filter((request: { readonly stream?: boolean }) => request.stream);
    assert.equal(streamed.length, 1);
    assert.equal(streamed[0]?.tools?.length ?? 0, 0);
    assert.match(JSON.stringify(streamed[0]?.messages), /Check a local PC service/u);
    assert.doesNotMatch(JSON.stringify(streamed[0]?.messages), /android\.install|ssh\.write|expectedVerification/u);
  }

  secondPlan = '{"stepIds":["unknown-step"]}';
  const invalid = await diagnose(secondPreset);
  assert.equal(invalid.status, 422);
  assert.deepEqual(await invalid.json(), { error: "invalid_device_plan" });
  const journal = new SqliteDeviceSupportStore({ databasePath: workspace.paths.databasePath });
  try {
    const rejected = journal.listRecentDaemonTasks(DEFAULT_WORKSPACE_ID, 10).find(task => task.status === "failed");
    assert.ok(rejected);
    assert.deepEqual(journal.listAttempts(rejected.id), []);
    assert.deepEqual(journal.listPlanningAcceptances(rejected.id), []);
  } finally {
    journal.close();
  }
  await secondProvider.close();
  secondOnline = false;
  const fallback = await checkDiagnosis(secondPreset, ["pc.inspect.network", "pc.inspect.services"], "graph");
  assert.match(JSON.stringify(fallback.planning.metadata), /runner_unavailable/u);
  assert.equal((await diagnose("missing-provider")).status, 404);
});
