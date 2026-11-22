import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { LingServerPairingMigrationRequestV1, LingServerPairingMigrationV1 } from "@ling-stack/contracts";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID } from "@ling-stack/core";
import {
  domainSeparatedCanonicalBytes, encodeBase64Url, fingerprintPublicJwkSync, sha256, validateRemoteP256PublicJwkV1,
} from "@ling-stack/remote-protocol";
import { RemoteAccessController } from "../dist/features/remote-access/controller.js";
import { createRemoteGatewayIdentity } from "../dist/features/remote-access/pairing-auth-service.js";
import { RemoteAccessStateStore } from "../dist/features/remote-access/state-store.js";

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

  assert.equal((await post("revoke", {})).status, 200);
  assert.equal((await post(confirmPath, confirmation)).status, 409);
});
