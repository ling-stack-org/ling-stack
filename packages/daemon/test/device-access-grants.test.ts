import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DeviceAccessGrantV1, DeviceProfileV1 } from "@ling-stack/contracts";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, DeviceAccessManager, SqliteDeviceFabricStore, SqliteDeviceSupportStore } from "@ling-stack/core";
import { PcAdapter } from "../dist/features/device-support/adapters/pc.js";
import { LocalPcTargetExecutor } from "../dist/features/device-support/adapters/local-pc-executor.js";
import { createDaemonServer } from "../dist/index.js";

test("local access grant updates and revocation keep target binding and exact revisions", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-device-access-grant-"));
  const workspace = createSqliteRunStore(cwd);
  const authToken = "fixture-daemon-access-authority";
  const headers = { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" };
  const timestamp = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const adapter = new PcAdapter({ executor: new LocalPcTargetExecutor() });
  const profile: DeviceProfileV1 = {
    device: {
      id: "grant-fixture-target", kind: "pc", displayName: "Fixture PC", ownerScope: DEFAULT_WORKSPACE_ID,
      lifecycleStatus: "healthy", profileRevision: "profile-1",
    },
    adapterId: adapter.manifest.adapterId, adapterVersion: adapter.manifest.adapterVersion,
    profileRevision: "profile-1", source: "operator", transports: ["local_process"], connectionRefs: ["local:grant-fixture"],
    transportDeployments: [{ transport: "local_process", mode: "target_executor", pairing: "os_permission", removal: "remove_target_executor" }],
  };
  const targets = new SqliteDeviceSupportStore({ databasePath: workspace.paths.databasePath });
  try {
    for (const [id, ownerScope] of [[profile.device.id, DEFAULT_WORKSPACE_ID], ["second-target", DEFAULT_WORKSPACE_ID], ["foreign-target", "separate-workspace"]]) {
      const target = { ...profile, device: { ...profile.device, id: id!, ownerScope: ownerScope! } };
      targets.registerDevice(target, timestamp);
      targets.saveCapabilitySnapshot(await adapter.getCapabilities({ profile: target, connectionRevision: "connection-1" }), timestamp);
    }
  } finally {
    targets.close();
  }

  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, authToken, defaultWorkspaceCwd: cwd }, {
    storeFactory: () => workspace, chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null,
  });
  t.after(async () => {
    await daemon.stop();
    rmSync(cwd, { recursive: true, force: true });
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const grantId = "grant-fixture";
  const route = (deviceId: string) => `http://127.0.0.1:${address.port}/v1/device-support/devices/${deviceId}/access-grants/${grantId}`;
  const url = route(profile.device.id);
  const update = (body: object, endpoint = url, requestHeaders = headers) =>
    fetch(endpoint, { method: "PUT", headers: requestHeaders, body: JSON.stringify(body) });
  const initial = {
    action: "grant", expectedRevision: 0, principalId: "fixture-developer", scope: "read_only",
    capabilityIds: ["pc.inspect.network"], expiresAt,
  };
  const replacement = { ...initial, expectedRevision: 1, scope: "developer", capabilityIds: ["pc.repair.network"] };
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers })).status, 404);
  assert.equal((await update(initial, url, { ...headers, Origin: "https://foreign.example" } as typeof headers)).status, 403);
  assert.equal((await update({ ...initial, authority: "forged" })).status, 400);
  assert.equal((await update({ ...initial, expiresAt: timestamp })).status, 400);
  assert.equal((await update({ ...initial, capabilityIds: replacement.capabilityIds })).status, 400);
  assert.equal((await update(initial, route("foreign-target"))).status, 404);

  const firstResponse = await update(initial);
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json() as DeviceAccessGrantV1;
  assert.equal(first.revision, 1);
  assert.equal(first.authority, "local_operator");
  assert.deepEqual(await (await update(initial)).json(), first);
  assert.equal((await update(replacement, route("second-target"))).status, 404);
  assert.equal((await update({ ...replacement, principalId: "different-principal" })).status, 409);
  const nextResponse = await update(replacement);
  assert.equal(nextResponse.status, 200);
  const next = await nextResponse.json() as DeviceAccessGrantV1;
  assert.equal(next.revision, 2);
  assert.deepEqual(next.capabilityIds, replacement.capabilityIds);

  const fabric = new SqliteDeviceFabricStore({ databasePath: workspace.paths.databasePath });
  const access = new DeviceAccessManager(fabric);
  const authorize = () => access.authorize({ grantId, principalId: first.principalId, targetDeviceId: profile.device.id,
    capabilityId: replacement.capabilityIds[0]!, now: timestamp });
  try {
    assert.deepEqual(authorize(), next);
    assert.equal((await update(initial)).status, 409);
    const revoke = { action: "revoke", expectedRevision: 2 };
    const response = await update(revoke);
    assert.equal(response.status, 200);
    const revoked = await response.json() as DeviceAccessGrantV1;
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revision, 3);
    assert.deepEqual(await (await update(revoke)).json(), revoked);
    assert.deepEqual(await (await fetch(url, { headers })).json(), revoked);
    assert.throws(authorize, /inactive/u);
    assert.deepEqual(fabric.database.prepare("SELECT revision FROM device_access_history WHERE grant_id=? ORDER BY revision")
      .all(grantId).map(row => row.revision), [1, 2, 3]);
  } finally {
    fabric.close();
  }
});
