import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HardwareProtocolWorkbench, LingServerPeerRegistry, LingServerPeerSessionCoordinator, LingServerTransportPlanner, SqliteDeviceProtocolStore, SqliteLingServerStore } from "../dist/index.js";

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

test("Ling Server transport planner emits ephemeral direct and relay configuration with redacted diagnostics", () => {
  const planner = new LingServerTransportPlanner({
    installation: { installationId: "install-1", serverOrigin: "https://ling.example", applicationKeyFingerprint: "server-fp", revision: 1, status: "active" },
    stunUrls: ["stun:stun.ling.example:3478"],
    turnUrls: ["turns:turn.ling.example:443"],
    features: ["ordered-data-channel", "resume-cursor"],
    now: () => now,
  });
  const binding = { bindingId: "binding-1", installationId: "install-1", gatewayId: "gateway-1", mobileDeviceId: "mobile-1", gatewayKeyFingerprint: "gateway-fp", mobileKeyFingerprint: "mobile-fp", epoch: 2, revision: 2, status: "active" as const };
  const route = { routeAttemptId: "route-1", bindingId: "binding-1", preferred: "direct" as const, selected: "direct" as const, status: "connected" as const, expiresAt: "2026-11-21T00:05:00.000Z" };
  const config = planner.createConfig({ binding, route, role: "mobile", localKeyFingerprint: "mobile-fp", remoteKeyFingerprint: "gateway-fp", expiresAt: "2026-11-21T00:04:00.000Z" });
  assert.equal(config.route, "direct");
  assert.deepEqual(config.features, ["ordered-data-channel", "resume-cursor"]);
  assert.equal(config.relayCredential, undefined);
  const diagnostics = planner.createDiagnostics({ binding, route, diagnosticId: "diag-1", transportGeneration: 3, localCandidateCount: 2, remoteCandidateCount: 2, requestedResumeSequence: 4, replayedFrameCount: 2, checks: [{ id: "control_reachability", status: "pass", code: "reachable", latencyMs: 12 }, { id: "peer_handshake", status: "pass", code: "authenticated" }] });
  assert.equal(diagnostics.peerEpoch, 2);
  assert.equal(diagnostics.replayedFrameCount, 2);
  assert.throws(() => planner.createConfig({ binding, route: { ...route, selected: "relay" }, role: "mobile", localKeyFingerprint: "mobile-fp", remoteKeyFingerprint: "gateway-fp", expiresAt: "2026-11-21T00:04:00.000Z" }), /TURN configuration and credentials/);
  assert.throws(() => planner.createConfig({ binding, route, role: "mobile", localKeyFingerprint: "mobile-fp", remoteKeyFingerprint: "gateway-fp", expiresAt: "2026-11-21T00:00:00.000Z" }), /expired/);
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

test("Ling Server peer session preserves route migration, frame sequencing, receipts and resume state", () => {
  const root = mkdtempSync(join(tmpdir(), "ling-session-store-"));
  const path = join(root, "session.sqlite");
  const firstStore = new SqliteLingServerStore({ databasePath: path });
  const registry = new LingServerPeerRegistry({ store: firstStore });
  registry.registerInstallation({ installationId: "install-1", serverOrigin: "https://ling.example", applicationKeyFingerprint: "server-fp", revision: 1, status: "active" });
  registry.bindPeers({ bindingId: "binding-1", installationId: "install-1", gatewayId: "gateway-1", mobileDeviceId: "mobile-1", gatewayKeyFingerprint: "gateway-fp", mobileKeyFingerprint: "mobile-fp", epoch: 1, revision: 1, status: "active" });
  const first = new LingServerPeerSessionCoordinator({ store: firstStore, now: () => now });
  first.openSession({ sessionId: "session-1", bindingId: "binding-1", peerEpoch: 1, routeAttemptId: "route-1", route: "direct", transportGeneration: 1, sendSequence: 0, receivedSequence: 0, status: "open", openedAt: now, lastSeenAt: now });
  const frame = { frameId: "frame-1", sessionId: "session-1", bindingId: "binding-1", peerEpoch: 1, transportGeneration: 1, sequence: 1, direction: "to_gateway" as const, kind: "device_task" as const, commandId: "command-1", payload: { taskId: "task-1" }, sentAt: now };
  assert.equal(first.acceptFrame(frame).replayed, false);
  assert.equal(first.acceptFrame(frame).replayed, true);
  assert.equal(first.resume("session-1", 0).frames.length, 1);
  const outgoing = first.sendFrame("session-1", { frameId: "frame-outgoing", direction: "to_mobile", kind: "receipt", commandId: "command-1", payload: { ok: true }, sentAt: now });
  assert.equal(outgoing.frame.sequence, 1);
  assert.equal(first.sendFrame("session-1", { frameId: "frame-outgoing", direction: "to_mobile", kind: "receipt", commandId: "command-1", payload: { ok: true }, sentAt: now }).replayed, true);
  assert.throws(() => first.acceptFrame({ ...frame, frameId: "frame-2", sequence: 3 }), /contiguous/);
  assert.equal(first.recordReceipt({ commandId: "command-1", payloadDigest: "digest-1", status: "completed", result: { ok: true }, recordedAt: now }).status, "completed");
  first.switchRoute("session-1", "route-2", "relay");
  firstStore.close();

  const secondStore = new SqliteLingServerStore({ databasePath: path });
  const second = new LingServerPeerSessionCoordinator({ store: secondStore, now: () => now });
  assert.equal(second.resume("session-1", 0).replayFromSequence, 1);
  assert.equal(second.resume("session-1", 9).requiresSnapshot, true);
  const migrated = second.openSession({ ...second.resume("session-1", 0).session, status: "open" });
  assert.equal(migrated.route, "relay");
  secondStore.close();
});

test("Ling Server peer session keeps frame replay state without SQLite", () => {
  const registry = new LingServerPeerRegistry();
  registry.registerInstallation({ installationId: "install-1", serverOrigin: "https://ling.example", applicationKeyFingerprint: "server-fp", revision: 1, status: "active" });
  registry.bindPeers({ bindingId: "binding-1", installationId: "install-1", gatewayId: "gateway-1", mobileDeviceId: "mobile-1", gatewayKeyFingerprint: "gateway-fp", mobileKeyFingerprint: "mobile-fp", epoch: 1, revision: 1, status: "active" });
  const coordinator = new LingServerPeerSessionCoordinator({ now: () => now });
  coordinator.openSession({ sessionId: "session-1", bindingId: "binding-1", peerEpoch: 1, routeAttemptId: "route-1", route: "lan", transportGeneration: 1, sendSequence: 0, receivedSequence: 0, status: "open", openedAt: now, lastSeenAt: now });
  const input = { frameId: "frame-1", direction: "to_mobile" as const, kind: "conversation" as const, payload: { text: "hello" }, sentAt: now };
  assert.equal(coordinator.sendFrame("session-1", input).replayed, false);
  assert.equal(coordinator.sendFrame("session-1", input).replayed, true);
  assert.equal(coordinator.resume("session-1", 0).frames.length, 1);
});
