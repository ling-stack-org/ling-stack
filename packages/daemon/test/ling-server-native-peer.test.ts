import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import type {
  LingServerPairingMigrationPublicationV1, LingServerPairingMigrationV1, RemoteP256PublicJwkV1,
} from "@ling-stack/contracts";
import { createSqliteRunStore } from "@ling-stack/core";
import {
  RemoteSessionClient, connectLingServerDataChannel, createFetchRemoteHttpClient, lingServerNativeGatewayFeatures,
  requestLingServerRoute, type RemoteBindingV1, type RemoteDeviceKeyAdapter,
} from "@ling-stack/remote-client";
import { fingerprintPublicJwkSync, validateRemoteP256PublicJwkV1 } from "@ling-stack/remote-protocol";
import { LingServerControlPlane } from "../dist/features/ling-server/control-plane.js";
import { RemoteAccessController } from "../dist/features/remote-access/controller.js";
import { createRemoteGatewayIdentity } from "../dist/features/remote-access/pairing-auth-service.js";
import { createPionPeerConnectionFactory, resolvePionPeerWorker } from "../dist/features/remote-access/pion-peer-worker.js";
import { RemoteAccessStateStore } from "../dist/features/remote-access/state-store.js";

const worker = resolvePionPeerWorker();
test("the native Gateway activates a confirmed profile, authenticates over WebRTC and resumes the same workspace",
  { timeout: 35_000, skip: worker ? false : "build the Pion peer worker to run the native transport test" }, async t => {
    assert.ok(worker);
    const root = await mkdtemp(join(tmpdir(), "ling-native-peer-"));
    const certificatePath = join(root, "tls.pem");
    const privateKeyPath = join(root, "tls.key");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
      "-out", certificatePath, "-keyout", privateKeyPath], { stdio: "ignore" });
    const cert = await readFile(certificatePath, "utf8");
    const trust = getCACertificates("default");
    setDefaultCACertificates([...trust, cert]);
    const workspace = createSqliteRunStore(root);
    const channel = workspace.createChannel({ name: "Peer continuity", boundPath: root }, now());
    const mobile = pairedKey();
    const application = pairedKey();
    const control = new LingServerControlPlane({
      authToken: randomUUID(), adminPort: 0, applicationIdentityPrivateKeyPem: application.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      tls: { cert, key: await readFile(privateKeyPath) },
    });
    let gateway: RemoteAccessController | undefined;
    let management: Server | undefined;
    let client: RemoteSessionClient | undefined;
    t.after(async () => {
      client?.disconnect();
      await gateway?.stop();
      if (management) await close(management);
      await control.stop();
      workspace.close();
      setDefaultCACertificates(trust);
      await rm(root, { recursive: true, force: true });
    });
    const { port } = await control.start();
    const serverOrigin = "https://127.0.0.1:" + port;
    const installation = control.registry.registerInstallation({
      installationId: "native-installation", serverOrigin, revision: 1, applicationKeyFingerprint: application.fingerprint, status: "active",
    });
    const reservation = createServer();
    const listenerPort = await listen(reservation);
    await close(reservation);
    const stateDir = join(root, "gateway-state");
    const state = new RemoteAccessStateStore({ stateDir, listenerPort, createIdentity: createRemoteGatewayIdentity });
    const device = { deviceId: "native-phone", deviceEpoch: 1, pairedAt: now(), displayName: "Native fixture",
      platform: "ios" as const, publicKeyJwk: mobile.jwk, publicKeyFingerprint: mobile.fingerprint };
    const gatewayOrigin = "https://pc.example";
    const originalState = state.readState();
    state.writeState({ ...originalState, enabled: true, gatewayOrigin, deviceEpoch: device.deviceEpoch, pairedDevice: device });
    const gatewayKey = state.readOrCreateIdentity();
    const managementCapability = randomUUID();
    const managementOrigin = "http://127.0.0.1";
    gateway = new RemoteAccessController({ store: workspace, stateDir, listenerPort, workspaceDisplayName: "Native fixture",
      managementCapability, managementAllowedOrigins: [managementOrigin] });
    await gateway.startIfEnabled();
    management = createServer(async (request, response) => {
      if (!await gateway?.handleManagementRequest(request, response)) response.writeHead(404).end();
    });
    const managementPort = await listen(management);
    const post = async (action: string, body: unknown) => {
      const response = await fetch(managementOrigin + ":" + managementPort + "/v1/mobile-access/pairing-migration/" + action, {
        method: "POST", headers: { Origin: managementOrigin, "Content-Type": "application/json",
          "X-Ling-Mobile-Management-Capability": managementCapability, "X-Ling-Csrf-Token": gateway!.csrfToken },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return await response.json() as LingServerPairingMigrationV1;
    };
    const profile = { schemaVersion: 1, bindingId: "signed-native-binding", installationId: installation.installationId,
      installationRevision: installation.revision, serverOrigin, applicationKeyFingerprint: installation.applicationKeyFingerprint,
      signalingProtocolMajor: 1, gatewayProtocolMajor: 1 };
    const preview = await post("prepare", { routingProfile: profile, retainedCommandIds: [] });
    const record = await post("confirm", { migrationId: preview.migrationId, confirmationDigest: preview.confirmationDigest });
    assert.equal(record.status, "confirmed");
    assert.equal(state.readState().lingServerMigrationId, record.migrationId);
    const publication: LingServerPairingMigrationPublicationV1 = control.registry.publishPairingMigration(record, now());

    const keys: RemoteDeviceKeyAdapter = {
      async generateOrLoad(keyId) { return { keyId, publicJwk: mobile.jwk, hardwareBacked: false, privateKeyExportable: false }; },
      async sign(_, bytes) { return signWith(mobile, bytes); },
      async verify(jwk: RemoteP256PublicJwkV1, bytes, signature) {
        return verify("sha256", bytes, { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
          Buffer.from(signature, "base64url"));
      },
      async delete() {},
    };
    let binding: RemoteBindingV1 = {
      version: 1, gatewayId: gatewayKey.gatewayId, gatewayOrigin,
      gatewayIdentityPublicKeyJwk: gatewayKey.publicKeyJwk, gatewayIdentityFingerprint: gatewayKey.publicKeyFingerprint,
      deviceId: device.deviceId, deviceKeyId: "fixture-mobile-key", deviceEpoch: device.deviceEpoch,
      workspaceBindingId: originalState.workspaceBindingId, status: "active", pairedAt: device.pairedAt,
    };
    const http = createFetchRemoteHttpClient();
    const options = { installation, binding: publication.binding, keys, clock: { now }, entropy: { randomBytes },
      key: { keyId: binding.deviceKeyId, publicJwk: mobile.jwk }, http };
    const routes: string[] = [];
    client = new RemoteSessionClient({
      binding, keys, http, clock: options.clock,
      bindingStore: { async read() { return binding; }, async write(value) { binding = value; }, async remove() {} },
      cacheStore: { async read() { return undefined; }, async write() {}, async remove() {} },
      entropy: { randomBytes, randomId: prefix => prefix + "_" + randomUUID() },
      peerFallback: true, webSocketFactory: () => assert.fail("native route fell back to WebSocket"),
      async connectPeer(signal, activeBinding) {
        assert.equal(activeBinding.lingServerRoutingProfile?.bindingId, publication.binding.bindingId);
        const requested = await requestLingServerRoute({ ...options, signal }, "direct");
        const connection = await connectLingServerDataChannel({
          ...options, signal, role: "mobile", features: lingServerNativeGatewayFeatures, route: requested.route,
          expectedInstanceId: requested.instanceId, createPeerConnection: createPionPeerConnectionFactory(worker),
        });
        routes.push(connection.route.routeAttemptId);
        return connection;
      },
    });
    await client.confirmLingServerPairingPin(record);
    await client.connect();
    assert.equal(client.state.workspaceBindingId, originalState.workspaceBindingId);
    await waitFor(() => Boolean(client?.state.conversations[channel.id]));
    const first = await client.openConversation(channel.id);
    assert.deepEqual(await first.completion, { kind: "conversation_opened", conversationId: channel.id });
    await waitFor(() => Boolean(client?.state.details[channel.id]));
    client.disconnect();
    await delay(1100);
    await client.connect();
    await waitFor(() => Boolean(client?.state.conversations[channel.id]));
    const reopened = await client.openConversation(channel.id);
    assert.deepEqual(await reopened.completion, { kind: "conversation_opened", conversationId: channel.id });
    assert.equal(routes.length, 2);
    assert.equal(new Set(routes).size, 2);
    assert.equal(client.state.workspaceBindingId, originalState.workspaceBindingId);
    assert.equal(client.activeBinding?.deviceEpoch, device.deviceEpoch);
  });

function pairedKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = validateRemoteP256PublicJwkV1(publicKey.export({ format: "jwk" }));
  return { privateKey, jwk, fingerprint: fingerprintPublicJwkSync(jwk) };
}

function signWith(key: ReturnType<typeof pairedKey>, bytes: Uint8Array): string {
  return sign("sha256", bytes, { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
}

function now() {
  return new Date().toISOString();
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !check()) await delay(20);
  assert.ok(check());
}
