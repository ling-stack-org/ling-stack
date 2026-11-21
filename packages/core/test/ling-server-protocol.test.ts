import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HardwareProtocolWorkbench, LingServerPeerRegistry, SqliteDeviceProtocolStore, SqliteLingServerStore } from "../dist/index.js";

const now = "2026-11-21T00:00:00.000Z";

test("Ling Server route registry preserves peer identity and falls back to relay", () => {
  const registry = new LingServerPeerRegistry();
  registry.registerInstallation({ installationId: "install-1", serverOrigin: "https://ling.example", applicationKeyFingerprint: "server-fp", revision: 1, status: "active" });
  registry.bindPeers({ bindingId: "binding-1", installationId: "install-1", gatewayId: "gateway-1", mobileDeviceId: "mobile-1", gatewayKeyFingerprint: "gateway-fp", mobileKeyFingerprint: "mobile-fp", epoch: 1, revision: 1, status: "active" });
  registry.beginRoute({ routeAttemptId: "route-1", bindingId: "binding-1", preferred: "direct", status: "checking", expiresAt: "2026-11-21T00:05:00.000Z" });
  assert.equal(registry.selectRoute("route-1", "direct", now).selected, "direct");
  assert.equal(registry.failoverRoute("route-1", now).preferred, "relay");
  assert.equal(registry.revokeBinding("binding-1", 2).status, "revoked");
});

test("hardware workbench captures, validates, decodes and replays protocol frames", () => {
  const workbench = new HardwareProtocolWorkbench();
  workbench.registerCodec({
    manifest: { codecId: "toy-can", version: "1.0", transport: "can", messageTypes: ["status"], license: "MIT" },
    decode: frame => ({ sequence: frame.sequence, messageType: "status", fields: { bytes: Buffer.from(frame.bytesBase64, "base64").length }, checksumValid: true }),
  });
  const capture = workbench.capture({ captureId: "capture-1", targetDeviceId: "vehicle-1", transport: "can", createdAt: now, frames: [{ direction: "rx", bytes: Uint8Array.from([1, 2, 3]), capturedAt: now }] });
  assert.equal(workbench.decode(capture, "toy-can")[0].messageType, "status");
  const replayed: string[] = [];
  workbench.replay(capture, frame => replayed.push(frame.digest));
  assert.deepEqual(replayed, [capture.frames[0].digest]);
});

test("Ling Server peer registry restores installation, binding and route state from SQLite", () => {
  const root = mkdtempSync(join(tmpdir(), "ling-server-store-"));
  const path = join(root, "server.sqlite");
  const firstStore = new SqliteLingServerStore({ databasePath: path });
  const first = new LingServerPeerRegistry({ store: firstStore });
  first.registerInstallation({ installationId: "install-1", serverOrigin: "https://ling.example", applicationKeyFingerprint: "server-fp", revision: 1, status: "active" });
  first.bindPeers({ bindingId: "binding-1", installationId: "install-1", gatewayId: "gateway-1", mobileDeviceId: "mobile-1", gatewayKeyFingerprint: "gateway-fp", mobileKeyFingerprint: "mobile-fp", epoch: 1, revision: 1, status: "active" });
  first.beginRoute({ routeAttemptId: "route-1", bindingId: "binding-1", preferred: "direct", status: "checking", expiresAt: "2026-11-21T00:05:00.000Z" });
  firstStore.close();

  const secondStore = new SqliteLingServerStore({ databasePath: path });
  const second = new LingServerPeerRegistry({ store: secondStore });
  assert.equal(second.selectRoute("route-1", "direct", now).selected, "direct");
  assert.equal(second.revokeBinding("binding-1", 2).epoch, 2);
  secondStore.close();
});

test("hardware protocol codec manifests and captures survive SQLite reopen", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ling-protocol-store-")), "protocol.sqlite");
  const first = new SqliteDeviceProtocolStore({ databasePath: path });
  first.registerCodec({ codecId: "toy-can", version: "1.0", transport: "can", messageTypes: ["status"], license: "MIT" });
  const capture = new HardwareProtocolWorkbench().capture({ captureId: "capture-persisted", targetDeviceId: "vehicle-1", transport: "can", createdAt: now, frames: [{ direction: "rx", bytes: Uint8Array.from([1, 2, 3]), capturedAt: now }] });
  first.saveCapture(capture);
  first.close();
  const second = new SqliteDeviceProtocolStore({ databasePath: path });
  assert.equal(second.getCodec("toy-can")?.version, "1.0");
  assert.equal(second.getCapture("capture-persisted")?.frames[0]?.digest, capture.frames[0]?.digest);
  second.close();
});
