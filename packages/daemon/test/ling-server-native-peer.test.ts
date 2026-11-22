import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import type {
  LingServerPairingMigrationPublicationV1, LingServerPairingMigrationV1, RemoteDeviceCollaborationViewV1, RemoteP256PublicJwkV1,
} from "@ling-stack/contracts";
import { REMOTE_DEVICE_TASKS_SUBPROTOCOL_V6 } from "@ling-stack/contracts";
import { createEnvSecretResolver, createSqliteRunStore } from "@ling-stack/core";
import {
  RemoteSessionClient, createFetchRemoteHttpClient, type RemoteBindingV1, type RemoteDeviceKeyAdapter,
} from "@ling-stack/remote-client";
import { fingerprintPublicJwkSync, validateRemoteP256PublicJwkV1 } from "@ling-stack/remote-protocol";
import { connectMobileLingServerPeer } from "../../../apps/mobile/src/remote/mobile-ling-server-peer.ts";
import { createStandaloneDeviceRuntime } from "../../../apps/mobile/src/device/standalone-runtime.ts";
import type { HomeAssistantFetch } from "../../../apps/mobile/src/device/home-assistant.ts";
import type { PhoneTaskCollaborationPeer } from "../../../apps/mobile/src/device/phone-task-collaboration.ts";
import { LingServerControlPlane } from "../dist/features/ling-server/control-plane.js";
import { createDeviceSupportRuntime } from "../dist/features/device-support/runtime.js";
import { createPhoneTaskAnalysisDrafter } from "../dist/features/device-support/diagnosis-planner.js";
import { createDefaultRunnerRegistry } from "../dist/index.js";
import { RemoteAccessController } from "../dist/features/remote-access/controller.js";
import { PhoneTaskCollaboration } from "../dist/features/remote-access/phone-task-collaboration.js";
import { createRemoteGatewayIdentity } from "../dist/features/remote-access/pairing-auth-service.js";
import { createPionPeerConnectionFactory, resolvePionPeerWorker } from "../dist/features/remote-access/pion-peer-worker.js";
import { RemoteAccessStateStore } from "../dist/features/remote-access/state-store.js";
import { startLoopbackPiProvider } from "./support/loopback-pi-provider-fixture.mjs";

const worker = resolvePionPeerWorker();
test("the native Gateway renews authenticated WebRTC authority, resumes after restart and respects server revocation",
  { timeout: 45_000, skip: !worker && !process.env.CI && "build the Pion peer worker to run the native transport test" }, async t => {
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
    let clockOffset = 0;
    const now = () => new Date(Date.now() + clockOffset).toISOString();
    const workspace = createSqliteRunStore(root);
    const modelNote = "Use the existing readback to verify the automation.";
    let modelCalls = 0;
    let releaseDraft!: () => void;
    const blockedDraft = new Promise<void>(resolve => { releaseDraft = resolve; });
    const provider = await startLoopbackPiProvider(async (request: { readonly stream?: boolean }) => {
      if (request.stream && ++modelCalls === 2) await blockedDraft;
      return { text: modelNote };
    });
    const preset = workspace.createProviderPreset({
      kind: "openai-compatible", displayName: "Loopback analysis", providerId: "loopback-analysis",
      baseUrl: provider.baseUrl, model: "static-tools", api: "openai-completions", capabilities: ["chat"],
      authHeader: false, reasoning: false,
    }, now());
    workspace.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Loopback ready", checkedAt: now() });
    workspace.updateWorkspaceSettings({ defaultProviderPresetId: preset.id }, now());
    const draftPhoneTaskAnalysis = createPhoneTaskAnalysisDrafter({
      store: workspace, runnerRegistry: createDefaultRunnerRegistry(), secretResolver: createEnvSecretResolver({}),
    });
    const channel = workspace.createChannel({ name: "Peer continuity", boundPath: root }, now());
    const createDeviceRuntime = () => createDeviceSupportRuntime({
      databasePath: join(root, "device-owner.sqlite"), now,
      homeAssistant: {
        baseUrl: "https://ha.fixture.example", token: "fixture-token",
        fetchImpl: async input => {
          const url = new URL(String(input));
          if (url.pathname === "/api/config") return Response.json({ version: "2026.11.2" });
          assert.equal(url.pathname, "/api/states/sensor.test");
          return Response.json({ entity_id: "sensor.test", state: "unavailable" });
        },
      },
    });
    let devices = createDeviceRuntime();
    const mobile = pairedKey();
    const application = pairedKey();
    let rendezvousReceipts = 0;
    class ObservedControl extends LingServerControlPlane {
      override async handleRequest(request: IncomingMessage, response: ServerResponse, admin?: boolean) {
        await super.handleRequest(request, response, admin);
        if (request.url === "/v1/rendezvous" && response.statusCode === 200) rendezvousReceipts += 1;
      }
    }
    const control = new ObservedControl({
      authToken: randomUUID(), adminPort: 0, applicationIdentityPrivateKeyPem: application.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      tls: { cert, key: await readFile(privateKeyPath) }, now,
    });
    let gateway: RemoteAccessController | undefined;
    let management: Server | undefined;
    let client: RemoteSessionClient | undefined;
    t.after(async () => {
      releaseDraft();
      client?.disconnect();
      await gateway?.stop();
      if (management) await close(management);
      await control.stop();
      await provider.close();
      devices.close();
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
    const createGateway = () => new RemoteAccessController({ store: workspace, stateDir, listenerPort, workspaceDisplayName: "Native fixture",
      managementCapability, managementAllowedOrigins: [managementOrigin], now, deviceFacade: devices.remoteFacade,
      phoneTaskCollaboration: new PhoneTaskCollaboration(devices.developerStore), draftPhoneTaskAnalysis });
    gateway = createGateway();
    await gateway.startIfEnabled();
    management = createServer(async (request, response) => {
      if (!await gateway?.handleManagementRequest(request, response)) response.writeHead(404).end();
    });
    const managementPort = await listen(management);
    const collaborationUrl = managementOrigin + ":" + managementPort + "/v1/mobile-access/device-collaboration";
    const collaborationHeaders = { Origin: managementOrigin, "X-Ling-Mobile-Management-Capability": managementCapability };
    const draftAnalysis = (share: RemoteDeviceCollaborationViewV1, csrfToken = gateway!.csrfToken) => fetch(collaborationUrl + "/draft", {
      method: "POST", headers: { ...collaborationHeaders, "X-Ling-Csrf-Token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ shareId: share.shareId, expectedRevision: share.revision, locale: "en-US" }),
    });
    const listShares = async () => {
      const response = await fetch(collaborationUrl, { headers: collaborationHeaders });
      assert.equal(response.status, 200);
      return (await response.json() as { shares: RemoteDeviceCollaborationViewV1[] }).shares;
    };
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
    const clock = { now };
    const peerOptions = { keys, clock, entropy: { randomBytes }, http,
      createPeerConnection: async () => createPionPeerConnectionFactory(worker) };
    const routes: { readonly id: string; readonly expiresAt: string }[] = [];
    client = new RemoteSessionClient({
      binding, keys, http, clock,
      bindingStore: { async read() { return binding; }, async write(value) { binding = value; }, async remove() {} },
      cacheStore: { async read() { return undefined; }, async write() {}, async remove() {} },
      entropy: { randomBytes, randomId: prefix => prefix + "_" + randomUUID() },
      autoReconnect: false, peerFallback: true, webSocketFactory: () => assert.fail("native route fell back to WebSocket"),
      async connectPeer(signal, activeBinding) {
        assert.equal(activeBinding.lingServerRoutingProfile?.bindingId, publication.binding.bindingId);
        const connection = await connectMobileLingServerPeer(activeBinding, signal, peerOptions);
        assert.ok(connection);
        assert.ok(connection.route.features.includes(REMOTE_DEVICE_TASKS_SUBPROTOCOL_V6));
        routes.push({ id: connection.route.routeAttemptId, expiresAt: connection.route.expiresAt });
        return connection;
      },
    });
    await client.confirmLingServerPairingPin(record);
    await client.connect();
    assert.equal(client.state.workspaceBindingId, originalState.workspaceBindingId);
    assert.ok(client.state.policy?.capabilities.includes("device.collaboration"));
    await waitFor(() => Boolean(client?.state.conversations[channel.id]));
    const first = await client.openConversation(channel.id);
    assert.deepEqual(await first.completion, { kind: "conversation_opened", conversationId: channel.id });
    await waitFor(() => Boolean(client?.state.details[channel.id]));
    const diagnosis = await devices.diagnoseHomeAssistant("sensor.test");
    const taskId = diagnosis.report.taskId;
    const attemptIds = diagnosis.attempts.map(record => record.attempt.attemptId);
    const initialJournal = await client.readDeviceTaskJournal(taskId, { generation: 1, afterSequence: 0, limit: 1 });
    assert.equal(initialJournal.task.taskId, taskId);
    assert.equal(initialJournal.events.length, 1);
    assert.equal(initialJournal.hasMore, true);
    const phoneStorage = new Map<string, string>();
    const storage = {
      async getItem(key: string) { return phoneStorage.get(key) ?? null; },
      async setItem(key: string, value: string) { phoneStorage.set(key, value); },
    };
    const phoneTarget = { origin: "https://phone.fixture.example", token: "phone-fixture-credential", entityId: "automation.test" };
    let phoneWrites = 0;
    const phoneFetch: HomeAssistantFetch = async (_url, request) => {
      if (request.method === "POST") {
        phoneWrites += 1;
        throw new Error("the phone lost the successful write response");
      }
      return Response.json({
        entity_id: phoneTarget.entityId, state: phoneWrites ? "on" : "off",
        attributes: { id: "test-automation", description: "private-fixture-data" },
      });
    };
    const openPhone = async () => {
      const runtime = await createStandaloneDeviceRuntime({ storage, now, randomId: prefix => prefix + "_" + randomUUID(), fetch: phoneFetch });
      await runtime.setForeground(true);
      return runtime;
    };
    const phonePeer: PhoneTaskCollaborationPeer = {
      scope: JSON.stringify([binding.gatewayId, binding.deviceId, binding.deviceEpoch, client.state.policy?.workspaceBindingId]),
      update: (shareId, action) => client!.updateDeviceCollaboration(shareId, action),
    };
    let phone = await openPhone();
    const phoneDiagnosis = await phone.diagnoseHomeAssistant(phoneTarget);
    const phoneRecovery = await phone.enableHomeAssistantAutomation({ ...phoneTarget, diagnosisTaskId: phoneDiagnosis.taskId });
    assert.equal(phoneRecovery.taskStatus, "unknown");
    assert.deepEqual(await listShares(), []);
    const share = await phone.collaborate(phoneRecovery.taskId, phonePeer, { kind: "share" });
    assert.ok(share?.state === "active");
    assert.equal(share.projection.taskId, phoneRecovery.taskId);
    assert.equal(share.projection.status, "unknown");
    assert.doesNotMatch(JSON.stringify(share), /phone\.fixture|phone-fixture-credential|private-fixture-data|automation\.test/u);
    assert.deepEqual(await listShares(), [share]);
    assert.equal((await draftAnalysis(share, "invalid-csrf")).status, 403);
    const draft = await draftAnalysis(share);
    assert.equal(draft.status, 200);
    assert.deepEqual(await draft.json(), { shareId: share.shareId, expectedRevision: share.revision, text: modelNote, modelLabel: "Loopback analysis" });
    assert.deepEqual(await listShares(), [share]);
    const streamed = provider.requests.filter(request => request.stream);
    assert.equal(streamed.length, 1);
    assert.equal(streamed[0].tools?.length ?? 0, 0);
    const prompt = JSON.stringify(streamed[0].messages);
    assert.match(prompt, /unknown/u);
    assert.doesNotMatch(prompt, /phone\.fixture|phone-fixture-credential|private-fixture-data|automation\.test|phone_owner_|device_task_/u);
    const notes = [
      { proposalId: "suggest-readback", text: modelNote },
      { proposalId: "stale-note", text: "Check the recorded automation status." },
    ];
    for (const note of notes) {
      const response: Response = await fetch(collaborationUrl, {
        method: "POST", headers: { ...collaborationHeaders, "X-Ling-Csrf-Token": gateway.csrfToken, "Content-Type": "application/json" },
        body: JSON.stringify({ shareId: share.shareId, expectedRevision: share.revision, ...note }),
      });
      assert.equal(response.status, 200);
    }
    let shared = await phone.collaborate(phoneRecovery.taskId, phonePeer, { kind: "sync" });
    assert.ok(shared?.state === "active");
    assert.deepEqual(shared.proposals.map(proposal => proposal.status), ["proposed", "proposed"]);
    const accepted = await phone.collaborate(phoneRecovery.taskId, phonePeer, {
      kind: "decide", view: shared, proposalId: "suggest-readback", decision: "accepted",
    });
    assert.ok(accepted?.state === "active");
    assert.deepEqual(accepted.proposals.map(proposal => proposal.status), ["accepted", "proposed"]);
    assert.ok([...phoneStorage.values()].some(value => value.includes('"decision":"accepted"')));
    const expiry = Date.parse(routes[0]!.expiresAt);
    const expectedReceipts = rendezvousReceipts + 2;
    clockOffset = expiry - Date.now() - 8_000;
    await waitFor(() => rendezvousReceipts >= expectedReceipts, 6_000);
    clockOffset = expiry + 1 - Date.now();
    const extended = await client.openConversation(channel.id);
    assert.deepEqual(await extended.completion, { kind: "conversation_opened", conversationId: channel.id });
    assert.equal(routes.length, 1);

    await gateway.stop();
    await waitFor(() => client?.state.connection !== "connected", 12_000);
    devices.close();
    devices = createDeviceRuntime();
    gateway = createGateway();
    await gateway.startIfEnabled();
    await client.connect();
    await waitFor(() => Boolean(client?.state.conversations[channel.id]));
    const reopened = await client.openConversation(channel.id);
    assert.deepEqual(await reopened.completion, { kind: "conversation_opened", conversationId: channel.id });
    assert.equal(routes.length, 2);
    assert.equal(new Set(routes.map(route => route.id)).size, 2);
    assert.equal(client.state.workspaceBindingId, originalState.workspaceBindingId);
    assert.equal(client.activeBinding?.deviceEpoch, device.deviceEpoch);
    const continued = await client.readDeviceTaskJournal(taskId, { generation: initialJournal.generation, afterSequence: 1 });
    assert.equal(continued.requiresSnapshot, false);
    assert.equal(continued.events[0]?.sequence, 2);
    assert.equal(continued.task.ownerId, initialJournal.task.ownerId);
    assert.deepEqual(devices.store.listAttempts(taskId).map(record => record.attempt.attemptId), attemptIds);
    phone = await openPhone();
    shared = await phone.collaborate(phoneRecovery.taskId, phonePeer, { kind: "sync" });
    assert.ok(shared?.state === "active");
    assert.equal(shared.shareId, share.shareId);
    assert.equal(shared.proposals[0]?.status, "accepted");
    const verified = await phone.verifyHomeAssistantRecovery({ ...phoneTarget, recoveryTaskId: phoneRecovery.taskId });
    assert.equal(verified.taskStatus, "succeeded");
    const stale = shared;
    await assert.rejects(phone.collaborate(phoneRecovery.taskId, phonePeer, {
      kind: "decide", view: stale, proposalId: "stale-note", decision: "accepted",
    }), /phone_task_evidence_changed/u);
    const verifiedShare = await phone.collaborate(phoneRecovery.taskId, phonePeer, { kind: "sync" });
    assert.ok(verifiedShare?.state === "active");
    assert.equal(verifiedShare.revision, shared.revision + 1);
    assert.equal(verifiedShare.projection.attempt.verification?.status, "verified");
    assert.equal(verifiedShare.projection.attempt.attemptId, shared.projection.attempt.attemptId);
    assert.deepEqual(verifiedShare.proposals, []);
    assert.deepEqual(await listShares(), [verifiedShare]);
    assert.equal(phoneWrites, 1);
    const staleDraft = draftAnalysis(verifiedShare);
    await waitFor(() => modelCalls >= 2);
    const revoked = await phone.collaborate(phoneRecovery.taskId, phonePeer, { kind: "revoke" });
    releaseDraft();
    assert.equal((await staleDraft).status, 409);
    assert.equal(revoked?.state, "revoked");
    assert.deepEqual(await listShares(), []);
    control.registry.revokeBinding(publication.binding.bindingId, publication.binding.revision + 1);
    await waitFor(() => client?.state.connection !== "connected", 12_000);
    await assert.rejects(client.connect(), { status: 403 });
  });

function pairedKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = validateRemoteP256PublicJwkV1(publicKey.export({ format: "jwk" }));
  return { privateKey, jwk, fingerprint: fingerprintPublicJwkSync(jwk) };
}

function signWith(key: ReturnType<typeof pairedKey>, bytes: Uint8Array): string {
  return sign("sha256", bytes, { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
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

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !check()) await delay(20);
  assert.ok(check());
}
