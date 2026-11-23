import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { LingServerPairingIdentityV1, LingServerPairingMigrationRequestV1 } from "@ling-stack/contracts";
import {
  encodeModbusRtuRegisterRead, HardwareProtocolWorkbench, LingServerPairingMigrationJournal, LingServerPeerRegistry, LingServerPeerSessionCoordinator,
  LingServerRelayCredentialIssuer, LingServerTransportPlanner, modbusRtuRegisterCodec, SqliteDeviceProtocolStore, SqliteLingServerStore,
} from "../dist/index.js";

const now = "2026-11-21T00:00:00.000Z";
const expiresAt = "2026-11-21T00:05:00.000Z";

function connectRoute(registry: LingServerPeerRegistry, routeAttemptId: string, preferred: "lan" | "direct" | "relay") {
  registry.beginRoute({ routeAttemptId, bindingId: "binding-1", preferred, status: "checking", expiresAt });
  return registry.selectRoute(routeAttemptId, preferred, now);
}

test("Ling Server route registry preserves peer identity and falls back to relay", () => {
  const registry = new LingServerPeerRegistry();
  registry.registerInstallation({ installationId: "install-1", serverOrigin: "https://ling.example", applicationKeyFingerprint: "server-fp", revision: 1, status: "active" });
  registry.bindPeers({ bindingId: "binding-1", installationId: "install-1", gatewayId: "gateway-1", mobileDeviceId: "mobile-1", gatewayKeyFingerprint: "gateway-fp", mobileKeyFingerprint: "mobile-fp", epoch: 1, revision: 1, status: "active" });
  registry.beginRoute({ routeAttemptId: "route-1", bindingId: "binding-1", preferred: "direct", status: "checking", expiresAt: "2026-11-21T00:05:00.000Z" });
  assert.equal(registry.selectRoute("route-1", "direct", now).selected, "direct");
  const fallback = registry.failoverRoute("route-1", now);
  assert.equal(fallback.preferred, "relay");
  assert.equal(fallback.selected, undefined);
  assert.equal(registry.revokeBinding("binding-1", 2).status, "revoked");
  assert.throws(() => registry.selectRoute("route-1", "relay", now), /not active/);
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

test("RS-485 workbench distinguishes Modbus CRC failures from changed capture evidence before replay", () => {
  const workbench = new HardwareProtocolWorkbench();
  workbench.registerCodec(modbusRtuRegisterCodec);
  const request = encodeModbusRtuRegisterRead({ unitAddress: 1, table: "holding", startAddress: 0, quantity: 1 });
  assert.equal(Buffer.from(request).toString("hex"), "010300000001840a");
  assert.throws(() => encodeModbusRtuRegisterRead({ unitAddress: 1, table: "input", startAddress: 65_535, quantity: 2 }), /address or quantity/);
  const capture = workbench.capture({
    captureId: "modbus-rtu-reads", targetDeviceId: "fixture-rs485", transport: "rs485", source: "imported", createdAt: now,
    loss: { reason: "adapter_overrun", droppedFrames: 2 },
    frames: [
      { direction: "tx", bytes: request, capturedAt: now },
      { direction: "rx", bytes: Buffer.from("010302000a3843", "hex"), capturedAt: now },
      { direction: "rx", bytes: Buffer.from("010302000b3843", "hex"), capturedAt: now },
    ],
  });
  const codecId = modbusRtuRegisterCodec.manifest.codecId;
  const [decodedRequest, decodedResponse, damagedOnWire] = workbench.decode(capture, codecId);
  assert.deepEqual(decodedRequest?.fields, { unitAddress: 1, functionCode: 3, table: "holding", startAddress: 0, quantity: 1 });
  assert.deepEqual(decodedResponse?.fields, { unitAddress: 1, functionCode: 3, table: "holding", quantity: 1, register0: 10 });
  assert.equal(damagedOnWire?.messageType, "invalid_checksum");
  assert.equal(damagedOnWire?.checksumValid, false);
  assert.deepEqual(capture.loss, { reason: "adapter_overrun", droppedFrames: 2 });
  const changed = { ...capture, frames: [...capture.frames.slice(0, -1), { ...capture.frames[2]!, digest: "0".repeat(64) }] };
  let replayedFrames = 0;
  assert.throws(() => workbench.replay(changed, () => { replayedFrames += 1; }), /digest or encoding/);
  assert.equal(replayedFrames, 0);
  assert.throws(() => workbench.decode(changed, codecId), /digest or encoding/);
  workbench.replay(capture, () => { replayedFrames += 1; });
  assert.equal(replayedFrames, 3);
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

test("a pairing migration confirms only the recorded keys, routing profile and owned receipts across restart", t => {
  const root = mkdtempSync(join(tmpdir(), "ling-server-migration-"));
  const databasePath = join(root, "migrations.sqlite");
  let store = new SqliteLingServerStore({ databasePath });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const workspaceId = "workspace-1";
  const pairing: LingServerPairingIdentityV1 = {
    gatewayId: "gateway-1", gatewayOrigin: "https://pc.example", mobileDeviceId: "mobile-1", deviceEpoch: 2,
    gatewayKeyFingerprint: "gateway-fixture-fingerprint", mobileKeyFingerprint: "mobile-fixture-fingerprint",
    workspaceBindingId: "workspace-binding-1",
  };
  const input: LingServerPairingMigrationRequestV1 = {
    routingProfile: {
      schemaVersion: 1, bindingId: "binding-1", installationId: "install-1", installationRevision: 1,
      serverOrigin: "https://ling.example", applicationKeyFingerprint: Buffer.alloc(32, 5).toString("base64url"),
      signalingProtocolMajor: 1, gatewayProtocolMajor: 1,
    },
    retainedCommandIds: ["command-1"],
  };
  let clock = now;
  let bodyHash = "fixture-digest";
  const journal = () => new LingServerPairingMigrationJournal({
    store, now: () => clock,
    readReceipt: commandId => ({
      commandId, workspaceId, bodyHash, deviceId: commandId === "command-1" ? pairing.mobileDeviceId : "foreign-device",
    }),
  });
  let signedCount = 0;
  const sign = () => { signedCount += 1; return "fixture-signature"; };
  const prepare = (request: unknown) => journal().prepare(request, pairing, workspaceId);
  assert.throws(() => prepare({ ...input, retainedCommandIds: ["foreign-command"] }), /unavailable for the active pairing/u);
  assert.throws(() => prepare({ ...input, routingProfile: { ...input.routingProfile, signalingProtocolMajor: 2 } }), /incompatible/u);
  assert.throws(() => prepare({ ...input, routingProfile: { ...input.routingProfile, serverOrigin: "https://ling.example/path" } }), /invalid/u);
  const expired = prepare({ ...input, routingProfile: { ...input.routingProfile, serverOrigin: "https://ling.example/" } });
  assert.equal(expired.routingProfile.serverOrigin, input.routingProfile.serverOrigin);
  clock = expired.expiresAt;
  assert.throws(() => journal().confirm({
    migrationId: expired.migrationId, confirmationDigest: expired.confirmationDigest,
  }, pairing, workspaceId, sign), /expired/u);

  const pending = prepare(input);
  assert.deepEqual(pending.oldPairing, pairing);
  assert.deepEqual(pending.routingProfile, input.routingProfile);
  assert.deepEqual(pending.retainedReceipts, [{ commandId: "command-1", payloadDigest: bodyHash }]);
  const { migrationId, confirmationDigest } = pending;
  const confirmation = { migrationId, confirmationDigest };
  assert.throws(() => journal().confirm(confirmation, { ...pairing, mobileKeyFingerprint: "other-key" }, workspaceId, sign), /active pairing/u);
  assert.throws(() => journal().confirm({ ...confirmation, confirmationDigest: expired.confirmationDigest }, pairing, workspaceId, sign), /active pairing/u);
  bodyHash = "changed-digest";
  assert.throws(() => journal().confirm(confirmation, pairing, workspaceId, sign), /receipts have changed/u);
  bodyHash = "fixture-digest";
  assert.equal(signedCount, 0);
  assert.deepEqual(store.getPairingMigration(migrationId), pending);

  store.close();
  store = new SqliteLingServerStore({ databasePath });
  const confirmed = journal().confirm(confirmation, pairing, workspaceId, sign);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.confirmedAt, clock);
  assert.equal(confirmed.gatewaySignature, "fixture-signature");
  store.close();
  store = new SqliteLingServerStore({ databasePath });
  assert.deepEqual(journal().confirm(confirmation, pairing, workspaceId, sign), confirmed);
  assert.throws(() => journal().confirm(confirmation, { ...pairing, deviceEpoch: 3 }, workspaceId, sign), /active pairing/u);
  assert.equal(signedCount, 1);
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
  const route = { routeAttemptId: "route-1", bindingId: "binding-1", peerEpoch: 2, preferred: "direct" as const, selected: "direct" as const, status: "connected" as const, expiresAt };
  const config = planner.createConfig({ binding, route, role: "mobile", localKeyFingerprint: "mobile-fp", remoteKeyFingerprint: "gateway-fp", expiresAt: "2026-11-21T00:04:00.000Z" });
  assert.equal(config.route, "direct");
  assert.deepEqual(config.features, ["ordered-data-channel", "resume-cursor"]);
  assert.equal(config.relayCredential, undefined);
  const diagnostics = planner.createDiagnostics({ binding, route, diagnosticId: "diag-1", transportGeneration: 3, localCandidateCount: 2, remoteCandidateCount: 2, requestedResumeSequence: 4, replayedFrameCount: 2, checks: [{ id: "control_reachability", status: "pass", code: "reachable", latencyMs: 12 }, { id: "peer_handshake", status: "pass", code: "authenticated" }] });
  assert.equal(diagnostics.peerEpoch, 2);
  assert.equal(diagnostics.replayedFrameCount, 2);
  assert.throws(() => planner.createConfig({ binding, route: { ...route, selected: "relay" }, role: "mobile", localKeyFingerprint: "mobile-fp", remoteKeyFingerprint: "gateway-fp", expiresAt: "2026-11-21T00:04:00.000Z" }), /TURN configuration and credentials/);
  assert.throws(() => planner.createConfig({ binding, route, role: "mobile", localKeyFingerprint: "mobile-fp", remoteKeyFingerprint: "gateway-fp", expiresAt: "2026-11-21T00:00:00.000Z" }), /expired/);
  assert.throws(() => planner.createConfig({ binding, route, role: "gateway", localKeyFingerprint: "mobile-fp", remoteKeyFingerprint: "gateway-fp", expiresAt }), /do not match/);
  assert.throws(() => planner.createConfig({ binding, route: { ...route, peerEpoch: 1 }, role: "mobile", localKeyFingerprint: "mobile-fp", remoteKeyFingerprint: "gateway-fp", expiresAt }), /bound epoch/);
  assert.throws(() => planner.createConfig({ binding, route, role: "mobile", localKeyFingerprint: "mobile-fp", remoteKeyFingerprint: "gateway-fp", expiresAt: "2026-11-21T00:05:01.000Z" }), /outlive/);
});

test("Ling Server relay credentials use a route-bound coturn username and replay within the issuing quota", () => {
  let currentTime = "2026-11-21T00:00:00.250Z";
  const sharedSecret = "0123456789abcdef";
  const issuer = new LingServerRelayCredentialIssuer({
    turnUrls: ["turns:turn.ling.example:443"], sharedSecret, now: () => currentTime,
    maxTtlMs: 120_000, maxActiveCredentialsPerBinding: 1,
  });
  const binding = { bindingId: "binding-1", installationId: "install-1", gatewayId: "gateway-1", mobileDeviceId: "mobile-1", gatewayKeyFingerprint: "gateway-fp", mobileKeyFingerprint: "mobile-fp", epoch: 2, revision: 2, status: "active" as const };
  const route = { routeAttemptId: "relay-attempt", bindingId: binding.bindingId, peerEpoch: 2, preferred: "relay", status: "checking", expiresAt: "2026-11-21T00:01:00.125Z" } as const;
  const request = { binding, route, role: "mobile" } as const;
  const credential = issuer.issue(request);
  assert.equal(credential.url, "turns:turn.ling.example:443");
  assert.equal(credential.expiresAt, "2026-11-21T00:01:00.000Z");
  assert.equal(credential.username, "1795219260:b74b800c1965655fcb97925e0218753e29b6fe00fe86d83f1ccd6cafb410c2d0:mobile");
  const expectedMac = "Us50+KivLA9jXrGaEbrFgeLqCHA=";
  assert.equal(credential.credential, expectedMac);
  assert.deepEqual(issuer.issue(request), credential);
  assert.throws(() => issuer.issue({ ...request, role: "gateway" }), /quota/);
  assert.throws(() => issuer.issue({ ...request, binding: { ...binding, status: "revoked" } }), /active peer binding/);
  assert.throws(() => issuer.issue({ ...request, route: { ...route, peerEpoch: 1 } }), /current peer epoch/);
  assert.throws(() => issuer.issue({ ...request, route: { ...route, preferred: "direct" } }), /requires a relay route/);
  currentTime = "2026-11-21T00:01:00.000Z";
  assert.throws(() => issuer.issue(request), /will expire/);
  assert.notEqual(issuer.issue({ ...request, route: { ...route, routeAttemptId: "relay-next", expiresAt } }).username, credential.username);
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
  connectRoute(registry, "route-1", "direct");
  connectRoute(registry, "route-2", "relay");
  const first = new LingServerPeerSessionCoordinator({ store: firstStore, now: () => now });
  const opened = first.openSession({ sessionId: "session-1", bindingId: "binding-1", peerEpoch: 1, routeAttemptId: "route-1", route: "direct", transportGeneration: 1, sendSequence: 0, receivedSequence: 0, status: "open", openedAt: now, lastSeenAt: now });
  const frame = { frameId: "frame-1", sessionId: "session-1", bindingId: "binding-1", peerEpoch: 1, transportGeneration: 1, sequence: 1, direction: "to_gateway" as const, kind: "device_task" as const, commandId: "command-1", payload: { taskId: "task-1" }, sentAt: now };
  const inbound = { transportGeneration: 1, direction: "to_gateway" as const, sequence: 0 };
  const outbound = { ...inbound, direction: "to_mobile" as const };
  firstStore.database.exec(`
    CREATE TEMP TRIGGER reject_peer_cursor_update BEFORE UPDATE ON ling_server_peer_sessions
    BEGIN SELECT RAISE(ABORT, 'fixture cursor failure'); END;
  `);
  assert.throws(() => first.acceptFrame(frame), /fixture cursor failure/);
  assert.equal(firstStore.getFrame(frame.frameId), undefined);
  assert.equal(firstStore.getSession(opened.sessionId)?.receivedSequence, 0);
  firstStore.database.exec("DROP TRIGGER reject_peer_cursor_update");
  assert.equal(first.acceptFrame(frame).replayed, false);
  assert.equal(first.acceptFrame(frame).replayed, true);
  const outgoing = first.sendFrame("session-1", { frameId: "frame-outgoing", direction: "to_mobile", kind: "receipt", commandId: "command-1", payload: { ok: true }, sentAt: now });
  assert.equal(outgoing.frame.sequence, 1);
  assert.deepEqual(first.resume("session-1", inbound).frames, [frame]);
  assert.deepEqual(first.resume("session-1", outbound).frames, [outgoing.frame]);
  assert.equal(first.resume("session-1", { ...outbound, sequence: 1 }).requiresSnapshot, false);
  assert.throws(() => first.acceptFrame(outgoing.frame), /active session and lane/);
  assert.throws(() => first.openSession(opened), /rewind/);
  assert.equal(first.sendFrame("session-1", { frameId: "frame-outgoing", direction: "to_mobile", kind: "receipt", commandId: "command-1", payload: { ok: true }, sentAt: now }).replayed, true);
  assert.throws(() => first.acceptFrame({ ...frame, frameId: "frame-2", sequence: 3 }), /contiguous/);
  assert.equal(first.recordReceipt({ commandId: "command-1", payloadDigest: "digest-1", status: "completed", result: { ok: true }, recordedAt: now }).status, "completed");
  firstStore.close();

  const secondStore = new SqliteLingServerStore({ databasePath: path });
  const second = new LingServerPeerSessionCoordinator({ store: secondStore, now: () => now });
  assert.deepEqual(second.resume("session-1", inbound).frames, [frame]);
  assert.deepEqual(second.resume("session-1", outbound).frames, [outgoing.frame]);
  assert.equal(second.resume("session-1", { ...inbound, sequence: 9 }).requiresSnapshot, true);
  const migrated = second.switchRoute("session-1", "route-2", "relay");
  assert.equal(migrated.route, "relay");
  assert.equal(migrated.transportGeneration, 2);
  assert.equal(second.openSession(migrated).sendSequence, 0);
  assert.equal(second.resume("session-1", inbound).requiresSnapshot, true);
  assert.throws(() => second.acceptFrame(frame), /active session and lane/);
  assert.equal(secondStore.getReceipt("command-1")?.status, "completed");

  const revocationStore = new SqliteLingServerStore({ databasePath: path });
  const authority = new LingServerPeerRegistry({ store: revocationStore });
  assert.throws(() => authority.revokeBinding("binding-1", 1), /revision must advance/);
  assert.equal(authority.revokeBinding("binding-1", 2).epoch, 2);
  assert.throws(() => second.acceptFrame({ ...frame, frameId: "new-epoch-one-frame", transportGeneration: 2 }), /not active/);
  assert.throws(() => second.resume("session-1", { ...inbound, transportGeneration: 2 }), /not active/);
  revocationStore.close();
  secondStore.close();
});

test("Ling Server peer session keeps frame replay state without SQLite", () => {
  const registry = new LingServerPeerRegistry();
  registry.registerInstallation({ installationId: "install-1", serverOrigin: "https://ling.example", applicationKeyFingerprint: "server-fp", revision: 1, status: "active" });
  registry.bindPeers({ bindingId: "binding-1", installationId: "install-1", gatewayId: "gateway-1", mobileDeviceId: "mobile-1", gatewayKeyFingerprint: "gateway-fp", mobileKeyFingerprint: "mobile-fp", epoch: 1, revision: 1, status: "active" });
  connectRoute(registry, "route-1", "lan");
  const coordinator = new LingServerPeerSessionCoordinator({ registry, now: () => now });
  coordinator.openSession({ sessionId: "session-1", bindingId: "binding-1", peerEpoch: 1, routeAttemptId: "route-1", route: "lan", transportGeneration: 1, sendSequence: 0, receivedSequence: 0, status: "open", openedAt: now, lastSeenAt: now });
  const input = { frameId: "frame-1", direction: "to_mobile" as const, kind: "conversation" as const, payload: { text: "hello" }, sentAt: now };
  assert.equal(coordinator.sendFrame("session-1", input).replayed, false);
  assert.equal(coordinator.sendFrame("session-1", input).replayed, true);
  assert.equal(coordinator.resume("session-1", { transportGeneration: 1, direction: "to_mobile", sequence: 0 }).frames.length, 1);
  registry.revokeBinding("binding-1", 2);
  assert.throws(() => coordinator.sendFrame("session-1", input), /not active/);
});
