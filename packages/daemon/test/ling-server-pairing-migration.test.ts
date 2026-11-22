import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  LingServerPairingMigrationPublicationRequestV1, LingServerPairingMigrationPublicationV1,
  LingServerPairingMigrationRequestV1, LingServerPairingMigrationV1,
} from "@ling-stack/contracts";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, SqliteLingServerStore } from "@ling-stack/core";
import {
  domainSeparatedCanonicalBytes, encodeBase64Url, fingerprintPublicJwkSync, sha256, validateRemoteP256PublicJwkV1,
} from "@ling-stack/remote-protocol";
import { RemoteAccessController } from "../dist/features/remote-access/controller.js";
import { createRemoteGatewayIdentity } from "../dist/features/remote-access/pairing-auth-service.js";
import { RemoteAccessStateStore } from "../dist/features/remote-access/state-store.js";
import { LingServerControlPlane } from "../dist/features/ling-server/control-plane.js";

const now = "2026-11-22T00:00:00.000Z";

test("local Gateway management confirms a server profile against the current pair and retains the original command receipt", { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-pairing-migration-"));
  let store = createSqliteRunStore(root);
  const origin = "http://127.0.0.1";
  const capability = "fixture-management-capability";
  const stateDir = join(root, "state");
  const listenerPort = 17895;
  const makeController = () => new RemoteAccessController({
    store, stateDir, listenerPort, workspaceDisplayName: "Test workspace",
    managementCapability: capability, managementAllowedOrigins: [origin], now: () => now,
  });
  let controller = makeController();
  const server = createServer((req, res) => { void controller.handleManagementRequest(req, res); });
  server.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await controller.stop();
    store.close();
    await rm(root, { force: true, recursive: true });
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${address.port}/v1/mobile-access/${path}`, {
      method: "POST", body: JSON.stringify(body), headers: {
        Origin: origin, "Content-Type": "application/json", "X-Ling-Mobile-Management-Capability": capability,
        "X-Ling-Csrf-Token": controller.csrfToken, ...headers,
      },
    });

  const state = new RemoteAccessStateStore({ stateDir, listenerPort, createIdentity: createRemoteGatewayIdentity, now: () => now });
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKeyJwk = validateRemoteP256PublicJwkV1(publicKey.export({ format: "jwk" }));
  const pairedDevice = {
    deviceId: "phone-1", deviceEpoch: 4, displayName: "Fixture phone", platform: "ios" as const, pairedAt: now,
    publicKeyJwk, publicKeyFingerprint: fingerprintPublicJwkSync(publicKeyJwk),
  };
  const oldState = { ...state.readState(), enabled: true, gatewayOrigin: "https://pc.example", deviceEpoch: 4, pairedDevice };
  state.writeState(oldState);
  const identity = state.readOrCreateIdentity();
  const channel = store.createChannel({ name: "Fixture channel", boundPath: root }, now);
  const body = "Existing message in the owner journal";
  const message = {
    workspaceId: DEFAULT_WORKSPACE_ID, deviceId: pairedDevice.deviceId, commandId: "fixture-command",
    bodyHash: encodeBase64Url(sha256(new TextEncoder().encode(body))), conversationKind: "channel" as const,
    conversationId: channel.id, body, issuedAt: now, retryUntil: "2026-11-22T00:10:00.000Z",
  };
  const original = store.commitRemoteConversationSend(message, now);
  const request: LingServerPairingMigrationRequestV1 = {
    routingProfile: {
      schemaVersion: 1, bindingId: "first-party-binding", installationId: "installation-1", installationRevision: 2,
      serverOrigin: "https://ling.example", applicationKeyFingerprint: encodeBase64Url(sha256(Uint8Array.of(1))),
      signalingProtocolMajor: 1, gatewayProtocolMajor: 1,
    },
    retainedCommandIds: [message.commandId],
  };
  const preparePath = "pairing-migration/prepare";
  const confirmPath = "pairing-migration/confirm";
  assert.equal((await post(preparePath, request, { Origin: "https://other.example" })).status, 403);
  assert.equal((await post(preparePath, request, { "X-Ling-Csrf-Token": "" })).status, 403);
  const proposed = await post(preparePath, request);
  assert.equal(proposed.status, 200);
  const preview = await proposed.json() as LingServerPairingMigrationV1;
  assert.equal(preview.status, "pending");
  assert.deepEqual(preview.oldPairing, {
    gatewayId: identity.gatewayId, gatewayOrigin: oldState.gatewayOrigin, gatewayKeyFingerprint: identity.publicKeyFingerprint,
    mobileDeviceId: pairedDevice.deviceId, mobileKeyFingerprint: pairedDevice.publicKeyFingerprint,
    deviceEpoch: pairedDevice.deviceEpoch, workspaceBindingId: oldState.workspaceBindingId,
  });
  assert.deepEqual(preview.retainedReceipts, [{ commandId: message.commandId, payloadDigest: message.bodyHash }]);
  assert.doesNotMatch(JSON.stringify(preview), /Existing message|PRIVATE KEY/u);

  const confirmation = { migrationId: preview.migrationId, confirmationDigest: preview.confirmationDigest };
  assert.equal((await post(confirmPath, { ...confirmation, confirmationDigest: "0".repeat(64) })).status, 400);
  const accepted = await post(confirmPath, confirmation);
  assert.equal(accepted.status, 200);
  const record = await accepted.json() as LingServerPairingMigrationV1;
  assert.equal(record.status, "confirmed");
  const { status: _status, gatewaySignature, ...unsigned } = record;
  const key = { key: createPublicKey({ format: "jwk", key: identity.publicKeyJwk }), dsaEncoding: "ieee-p1363" as const };
  const signature = Buffer.from(gatewaySignature, "base64url");
  const signingBytes = (value: unknown) => domainSeparatedCanonicalBytes("ling.server.pairing_migration.v1", value);
  assert.ok(verify("sha256", signingBytes(unsigned), key, signature));
  assert.equal(verify("sha256", signingBytes({
    ...unsigned, routingProfile: { ...unsigned.routingProfile, installationRevision: 3 },
  }), key, signature), false);

  await controller.stop();
  store.close();
  store = createSqliteRunStore(root);
  controller = makeController();
  assert.deepEqual(await (await post(confirmPath, confirmation)).json(), record);
  assert.deepEqual(state.readState(), oldState);
  assert.deepEqual(store.getRemoteCommandReceipt(message.commandId), original.receipt);
  const replay = store.commitRemoteConversationSend(message, now);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.messageId, original.messageId);

  await t.test("the control plane publishes the exact signed binding and receipt atomically", async t => {
    const databasePath = join(root, "control.sqlite");
    const token = "fixture-server-operator";
    let clock = now;
    const makeServer = () => new LingServerControlPlane({ authToken: token, databasePath, now: () => clock });
    let control = makeServer();
    t.after(async () => await control.stop());
    let address = await control.start();
    const send = (path: string, body: unknown, authenticated = true) => fetch(`http://${address.host}:${address.port}/v1/${path}`, {
      method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
    });
    const { routingProfile } = record;
    const installation = {
      installationId: routingProfile.installationId, serverOrigin: routingProfile.serverOrigin,
      applicationKeyFingerprint: routingProfile.applicationKeyFingerprint, revision: routingProfile.installationRevision,
      status: "active" as const,
    };
    const publication: LingServerPairingMigrationPublicationRequestV1 = { confirmation: record, gatewayPublicKeyJwk: identity.publicKeyJwk };
    const publish = (input: unknown = publication) => send("pairing-migrations", input);

    assert.equal((await send("pairing-migrations", publication, false)).status, 401);
    assert.equal((await send("installations", { ...installation, revision: 1 })).status, 200);
    assert.equal((await publish()).status, 403);
    assert.equal((await send("installations", installation)).status, 200);
    assert.equal((await publish({ ...publication, confirmation: preview })).status, 400);
    assert.equal((await publish({ ...publication, gatewayPublicKeyJwk: pairedDevice.publicKeyJwk })).status, 403);
    assert.equal((await publish({ ...publication, confirmation: { ...record, retainedReceipts: [] } })).status, 403);
    assert.equal((await publish({ ...publication, confirmation: { ...record, oldPairing: { ...record.oldPairing, deviceEpoch: 5 } } })).status, 403);
    clock = record.expiresAt;
    assert.equal((await publish()).status, 403);
    clock = now;
    assert.equal(control.registry.getBinding(routingProfile.bindingId), undefined);

    const sqlite = new SqliteLingServerStore({ databasePath });
    try {
      sqlite.database.exec(`CREATE TRIGGER fail_publication BEFORE INSERT ON ling_server_pairing_publications
        BEGIN SELECT RAISE(ABORT, 'fixture publication failed'); END`);
      assert.equal((await publish()).status, 500);
      assert.equal(control.registry.getBinding(routingProfile.bindingId), undefined);
      assert.equal(sqlite.getPairingPublication(record.migrationId), undefined);
      sqlite.database.exec("DROP TRIGGER fail_publication");
    } finally {
      sqlite.close();
    }
    const response = await publish();
    assert.equal(response.status, 200);
    const receipt = await response.json() as LingServerPairingMigrationPublicationV1;
    assert.deepEqual(receipt, { confirmation: record, publishedAt: now, binding: {
      bindingId: routingProfile.bindingId, installationId: installation.installationId, revision: 1, status: "active",
      epoch: record.oldPairing.deviceEpoch, gatewayId: identity.gatewayId, mobileDeviceId: pairedDevice.deviceId,
      gatewayKeyFingerprint: identity.publicKeyFingerprint, mobileKeyFingerprint: pairedDevice.publicKeyFingerprint,
    } });
    assert.deepEqual(control.registry.requireActiveBinding(routingProfile.bindingId, pairedDevice.deviceEpoch), receipt.binding);
    await control.stop();
    clock = record.expiresAt;
    control = makeServer();
    address = await control.start();
    assert.deepEqual(await (await publish()).json(), receipt);
    assert.equal((await send(`bindings/${routingProfile.bindingId}/revoke`, { revision: 2 })).status, 200);
    assert.equal((await publish()).status, 409);
    assert.equal(control.registry.getBinding(routingProfile.bindingId)?.status, "revoked");
  });

  assert.equal((await post("revoke", {})).status, 200);
  assert.equal((await post(confirmPath, confirmation)).status, 409);
});
