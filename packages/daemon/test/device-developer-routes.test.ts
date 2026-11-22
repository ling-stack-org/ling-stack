import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DeviceDeveloperJobV1, DeviceDeveloperSessionV1, DeviceProfileV1 } from "@ling-stack/contracts";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, HardwareProtocolWorkbench, SqliteDeviceSupportStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";

test("local developer sessions authorize the current target and expose durable workbench jobs", { timeout: 15_000 }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-device-developer-route-"));
  const authToken = "fixture-developer-route-authority";
  const headers = { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" };
  const targetDeviceId = "developer-route-target";
  const at = "2026-11-21T00:00:00.000Z";
  const profile: DeviceProfileV1 = {
    device: { id: targetDeviceId, ownerScope: DEFAULT_WORKSPACE_ID, displayName: "Workbench target", kind: "hardware", lifecycleStatus: "healthy", profileRevision: "profile-1" },
    adapterId: "fixture-adapter", adapterVersion: "1.0.0", profileRevision: "profile-1", source: "operator",
    transports: ["rs485"], connectionRefs: ["local:developer-route-target"],
    transportDeployments: [{ transport: "rs485", mode: "none", pairing: "os_permission", removal: "disconnect_only" }],
  };
  let daemon: ReturnType<typeof createDaemonServer> | undefined;
  let databasePath: string;
  async function start(seed = false) {
    const workspace = createSqliteRunStore(cwd);
    databasePath = workspace.paths.databasePath;
    if (seed) {
      const store = new SqliteDeviceSupportStore({ databasePath });
      try {
        store.registerDevice(profile, at);
        store.registerDevice({ ...profile, device: { ...profile.device, id: "foreign-target", ownerScope: "foreign-workspace" } }, at);
      } finally { store.close(); }
    }
    daemon = createDaemonServer({ host: "127.0.0.1", port: 0, authToken, defaultWorkspaceCwd: cwd }, {
      storeFactory: () => workspace, chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null,
      developerExecutor: {
        async execute({ job }) {
          return { status: "completed", outputRef: "fixture-output:" + job.kind, outputDigest: "a".repeat(64), taskStatus: "succeeded" };
        },
      },
    });
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}/v1/device-support`;
  }
  t.after(async () => {
    await daemon?.stop();
    rmSync(cwd, { recursive: true, force: true });
  });
  const base = await start(true);
  const sessions = `${base}/developer/sessions`;
  const post = (url: string, body: object, requestHeaders = headers) =>
    fetch(url, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });
  const get = (url: string) => fetch(url, { headers });
  const readSession = async (response: Response) =>
    (await response.json() as { session: DeviceDeveloperSessionV1 }).session;
  const input = { targetDeviceId, mode: "developer" };
  assert.equal((await post(sessions, input, { Authorization: "invalid", "Content-Type": "application/json" })).status, 401);
  assert.equal((await post(sessions, { ...input, targetDeviceId: "foreign-target" })).status, 404);
  assert.equal((await post(sessions, { ...input, ownerKind: "mobile" })).status, 400);

  const createdResponse = await post(sessions, input);
  assert.equal(createdResponse.status, 201);
  const created = await readSession(createdResponse);
  assert.equal(created.status, "created");
  assert.deepEqual(created.targetBinding, { profileRevision: "profile-1", connectionRevision: "profile-1" });
  const sessionUrl = `${sessions}/${created.sessionId}`;
  assert.deepEqual(await readSession(await get(sessionUrl)), created);
  assert.equal((await post(sessionUrl + "/authorize", { expectedRevision: 2 })).status, 409);
  const authorizeResponse = await post(sessionUrl + "/authorize", { expectedRevision: 1 });
  assert.equal(authorizeResponse.status, 200);
  const authorized = await readSession(authorizeResponse);
  assert.equal(authorized.status, "authorized");
  assert.equal(authorized.revision, 2);
  assert.notEqual(authorized.authorizationRevision, created.authorizationRevision);
  assert.equal((await post(sessionUrl + "/authorize", { expectedRevision: 2 })).status, 409);
  const developerJobResponse = await post(sessionUrl + "/jobs", {
    jobId: "developer-test-1", kind: "test", authorizationRevision: authorized.authorizationRevision,
  });
  assert.equal(developerJobResponse.status, 201);
  const developerJob = (await developerJobResponse.json() as { job: DeviceDeveloperJobV1 }).job;
  assert.equal(developerJob.status, "completed");
  assert.equal(developerJob.outputRef, "fixture-output:test");
  assert.equal(developerJob.outputDigest, "a".repeat(64));

  const stale = await readSession(await post(sessions, { ...input, mode: "standard" }));
  assert.equal(stale.mode, "standard");
  assert.equal((await post(`${sessions}/${stale.sessionId}/jobs`, {
    jobId: "stale-test-1", kind: "test", authorizationRevision: stale.authorizationRevision,
  })).status, 403);
  const store = new SqliteDeviceSupportStore({ databasePath: databasePath! });
  try {
    store.registerDevice({ ...profile, profileRevision: "profile-2", device: { ...profile.device, profileRevision: "profile-2" } }, at);
  } finally { store.close(); }
  assert.equal((await post(`${sessions}/${stale.sessionId}/authorize`, { expectedRevision: 1 })).status, 409);

  const protocol = await readSession(await post(`${base}/protocol/sessions`, { profileId: "modbus-rtu-registers", targetDeviceId }));
  const capture = new HardwareProtocolWorkbench().capture({
    captureId: "fixture-temperature", targetDeviceId, transport: "rs485", source: "imported", createdAt: at,
    frames: [{ direction: "rx", bytes: Buffer.from("010302000a3843", "hex"), capturedAt: at }],
  });
  const replay = await post(`${base}/protocol/sessions/${protocol.sessionId}/replay`, {
    capture, authorizationRevision: protocol.authorizationRevision,
  });
  assert.equal(replay.status, 201);
  const { job } = await replay.json() as { job: DeviceDeveloperJobV1 };
  assert.equal(job.status, "completed");
  assert.equal(job.authorizationRevision, protocol.authorizationRevision);
  const jobSegment = encodeURIComponent(job.jobId);
  assert.equal((await get(`${sessionUrl}/jobs/${jobSegment}`)).status, 404);
  const jobPath = `/developer/sessions/${protocol.sessionId}/jobs/${jobSegment}`;
  assert.deepEqual(await (await get(base + jobPath)).json(), { job });
  await daemon?.stop();
  daemon = undefined;
  const reopened = await start();
  const resumed = await readSession(await get(`${reopened}/developer/sessions/${created.sessionId}`));
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.revision, authorized.revision + 2);
  assert.deepEqual(await (await get(reopened + jobPath)).json(), { job });
});
