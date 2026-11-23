import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import type {
  AndroidApkIdentityV1, DeviceDeveloperArtifactV1, DeviceDeveloperJobV1, DeviceDeveloperSessionV1,
  LingServerPairingMigrationPublicationV1, LingServerPairingMigrationV1, RemoteDeviceArtifactOfferV1,
  RemoteDeviceCollaborationViewV1, RemoteP256PublicJwkV1,
} from "@ling-stack/contracts";
import { REMOTE_DEVICE_ARTIFACT_CHUNK_BYTES, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V7, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V8 } from "@ling-stack/contracts";
import { createEnvSecretResolver, createSqliteRunStore, DEFAULT_WORKSPACE_ID } from "@ling-stack/core";
import {
  RemoteSessionClient, createFetchRemoteHttpClient, type RemoteBindingV1, type RemoteDeviceKeyAdapter,
} from "@ling-stack/remote-client";
import { deviceArtifactReceiptBytes, fingerprintPublicJwkSync, validateRemoteP256PublicJwkV1 } from "@ling-stack/remote-protocol";
import { connectMobileLingServerPeer } from "../../../apps/mobile/src/remote/mobile-ling-server-peer.ts";
import { createStandaloneDeviceRuntime } from "../../../apps/mobile/src/device/standalone-runtime.ts";
import type { HomeAssistantFetch } from "../../../apps/mobile/src/device/home-assistant.ts";
import type { PhoneTaskCollaborationPeer } from "../../../apps/mobile/src/device/phone-task-collaboration.ts";
import type { OpenPhoneTaskArtifactFile } from "../../../apps/mobile/src/device/phone-task-artifacts.ts";
import { LingServerControlPlane } from "../dist/features/ling-server/control-plane.js";
import { localProcessRunner, type LocalProcessRunner } from "../dist/features/device-support/adapters/local-pc-executor.js";
import { AndroidApkLibrary } from "../dist/features/device-support/android-apks.js";
import { AndroidProjectBuilds, readAndroidProjectBuilds } from "../dist/features/device-support/android-project-builds.js";
import { handleDeviceDeveloperRoute } from "../dist/features/device-support/developer-routes.js";
import { createDeviceSupportRuntime } from "../dist/features/device-support/runtime.js";
import { createPhoneTaskAnalysisDrafter } from "../dist/features/device-support/diagnosis-planner.js";
import { createDefaultRunnerRegistry } from "../dist/index.js";
import { RemoteAccessController } from "../dist/features/remote-access/controller.js";
import { PhoneTaskCollaboration } from "../dist/features/remote-access/phone-task-collaboration.js";
import { PhoneTaskArtifacts } from "../dist/features/remote-access/phone-task-artifacts.js";
import { createRemoteGatewayIdentity } from "../dist/features/remote-access/pairing-auth-service.js";
import { createPionPeerConnectionFactory, resolvePionPeerWorker } from "../dist/features/remote-access/pion-peer-worker.js";
import { RemoteAccessStateStore } from "../dist/features/remote-access/state-store.js";
import { startLoopbackPiProvider } from "./support/loopback-pi-provider-fixture.mjs";

const worker = resolvePionPeerWorker();
test("the native Gateway resumes the phone journal and signed artifact transfer after restart",
  { timeout: 60_000, skip: !worker && !process.env.CI && "build the Pion peer worker to run the native transport test" }, async t => {
    assert.ok(worker);
    const root = await mkdtemp(join(tmpdir(), "ling-native-peer-"));
    const apkFixture = await createApkFixture(root);
    const project = await createProjectFixture(root);
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
      androidProjectBuilds: new AndroidProjectBuilds(root, join(root, "build-logs"), readAndroidProjectBuilds(project.configuration), apkFixture.library),
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
    const developerHeaders = { Authorization: "Bearer " + randomUUID(), "Content-Type": "application/json" };
    const managementOrigin = "http://127.0.0.1";
    const createGateway = () => {
      const phoneTaskCollaboration = new PhoneTaskCollaboration(devices.developerStore);
      return new RemoteAccessController({ store: workspace, stateDir, listenerPort, workspaceDisplayName: "Native fixture",
        managementCapability, managementAllowedOrigins: [managementOrigin], now, deviceFacade: devices.remoteFacade,
        phoneTaskCollaboration, draftPhoneTaskAnalysis,
        phoneTaskArtifacts: new PhoneTaskArtifacts(devices.developerStore, phoneTaskCollaboration, join(root, "pc-artifacts"), apkFixture.library),
      });
    };
    gateway = createGateway();
    await gateway.startIfEnabled();
    management = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", managementOrigin);
      if (url.pathname.startsWith("/v1/device-support/developer/")) {
        if (request.headers.authorization !== developerHeaders.Authorization) {
          response.writeHead(401).end();
          return;
        }
        if (await handleDeviceDeveloperRoute(url, request, response, devices)) return;
      }
      if (!await gateway?.handleManagementRequest(request, response)) response.writeHead(404).end();
    });
    const managementPort = await listen(management);
    const collaborationUrl = managementOrigin + ":" + managementPort + "/v1/mobile-access/device-collaboration";
    const collaborationHeaders = { Origin: managementOrigin, "X-Ling-Mobile-Management-Capability": managementCapability };
    const developerUrl = managementOrigin + ":" + managementPort + "/v1/device-support/developer";
    const developerPost = (path: string, body: object) => fetch(developerUrl + path, {
      method: "POST", headers: developerHeaders, body: JSON.stringify(body),
    });
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
        assert.ok(connection.route.features.includes(REMOTE_DEVICE_TASKS_SUBPROTOCOL_V8));
        routes.push({ id: connection.route.routeAttemptId, expiresAt: connection.route.expiresAt });
        return connection;
      },
    });
    await client.confirmLingServerPairingPin(record);
    await client.connect();
    assert.equal(client.state.workspaceBindingId, originalState.workspaceBindingId);
    assert.ok(client.state.policy?.capabilities.includes("device.collaboration"));
    assert.ok(client.state.policy?.capabilities.includes("device.artifact"));
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
    const pc = await devices.broker.discover("pc-target-executor", { ownerId: DEFAULT_WORKSPACE_ID, connectionRef: "local_process" });
    const projects = await fetch(developerUrl + "/project-builds", { headers: developerHeaders });
    assert.deepEqual(await projects.json(), { builds: [{ buildId: "test-debug", directory: "app-workspace", variant: "debug", toolchain: "Android SDK Build Tools" }] });
    const sessionResponse = await developerPost("/sessions", { targetDeviceId: pc.device.id, mode: "developer" });
    assert.equal(sessionResponse.status, 201);
    const { session: created } = await sessionResponse.json() as { session: DeviceDeveloperSessionV1 };
    const sessionPath = "/sessions/" + created.sessionId;
    const authorizedResponse = await developerPost(sessionPath + "/authorize", { expectedRevision: created.revision });
    assert.equal(authorizedResponse.status, 200);
    const { session: authorized } = await authorizedResponse.json() as { session: DeviceDeveloperSessionV1 };
    const projectJob = { jobId: "pc-android-project-build", kind: "build", buildId: "test-debug",
      expectedSessionRevision: authorized.revision, authorizationRevision: authorized.authorizationRevision };
    const buildResponse = await developerPost(sessionPath + "/jobs", projectJob);
    assert.equal(buildResponse.status, 201);
    const built = await buildResponse.json() as { job: DeviceDeveloperJobV1; artifact: DeviceDeveloperArtifactV1 };
    assert.equal(built.job.status, "completed");
    assert.equal(built.artifact.build?.sourceRevision, project.revision);
    assert.equal(built.artifact.build?.sourceModified, false);
    assert.equal(built.artifact.build?.jobId, built.job.jobId);
    assert.equal(built.artifact.digest, "sha256:" + built.job.outputDigest);
    assert.equal(built.artifact.digest, sha256Digest(await readFile(project.output)));
    const buildLogResponse = await fetch(developerUrl + sessionPath + "/jobs/" + projectJob.jobId + "/build-log", { headers: developerHeaders });
    assert.equal(buildLogResponse.status, 200);
    assert.match((await buildLogResponse.json() as { stdout: string }).stdout, /project APK built/u);
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
    const fileRoot = join(root, "phone-artifacts");
    await mkdir(fileRoot);
    let exported: Buffer | undefined;
    const artifactFile: OpenPhoneTaskArtifactFile = (fileId) => {
      const stagingPath = join(fileRoot, fileId + ".staging");
      const verifiedPath = join(fileRoot, fileId + ".verified");
      const current = async () => await stat(verifiedPath).then(() => verifiedPath, () => stagingPath);
      return {
        async size() { return await stat(await current()).then(value => value.size, () => 0); },
        async append(offset, bytes) {
          assert.equal(await this.size(), offset);
          await appendFile(stagingPath, bytes);
        },
        async digest() { return sha256Digest(await readFile(await current())); },
        async reset() { await Promise.all([rm(stagingPath, { force: true }), rm(verifiedPath, { force: true })]); },
        async seal() { if (await current() === stagingPath) await rename(stagingPath, verifiedPath); },
        async export() { exported = await readFile(verifiedPath); },
      };
    };
    const openPhone = async () => {
      const runtime = await createStandaloneDeviceRuntime({
        storage, now, randomId: prefix => prefix + "_" + randomUUID(), fetch: phoneFetch, openArtifactFile: artifactFile,
      });
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
    const artifactBytes = randomBytes(REMOTE_DEVICE_ARTIFACT_CHUNK_BYTES * 126 + 19);
    const artifactQuery = new URLSearchParams({ shareId: share.shareId, expectedRevision: String(share.revision) });
    const offerArtifact = (proposalId = "pc-build-artifact", name = "build-fixture.bin", bytes: Uint8Array = artifactBytes) => fetch(
      collaborationUrl + "/artifacts?" + new URLSearchParams({ ...Object.fromEntries(artifactQuery), proposalId, name }), {
        method: "POST", headers: { ...collaborationHeaders, "X-Ling-Csrf-Token": gateway!.csrfToken, "Content-Type": "application/octet-stream" },
        body: new Blob([new Uint8Array(bytes)]),
      },
    );
    const upload = await offerArtifact();
    assert.equal(upload.status, 201);
    const offer = await upload.json() as RemoteDeviceArtifactOfferV1;
    assert.equal(offer.manifest.digest, sha256Digest(artifactBytes));
    assert.deepEqual(await (await offerArtifact()).json(), offer);
    assert.deepEqual(await client.listDeviceArtifacts(share.shareId, share.revision), [offer]);
    await assert.rejects(client.readDeviceArtifactChunk(offer.manifest, 0), /must accept/u);
    assert.ok(phone.artifacts);
    const approvedArtifact = await phone.artifacts.decide(offer, "accepted", client);
    const interruption = new AbortController();
    await assert.rejects(phone.artifacts.receive({
      offer: approvedArtifact, peer: client, signal: interruption.signal,
      onProgress: bytes => { if (bytes >= REMOTE_DEVICE_ARTIFACT_CHUNK_BYTES * 4) interruption.abort(); },
    }), { name: "AbortError" });
    assert.deepEqual(await phone.artifacts.listSaved(phoneRecovery.taskId), []);
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
    assert.ok(phone.artifacts);
    const progress: number[] = [];
    const receivedArtifact = await phone.artifacts.receive({
      offer: approvedArtifact, peer: client, onProgress: bytes => progress.push(bytes),
    });
    assert.equal(progress[0], REMOTE_DEVICE_ARTIFACT_CHUNK_BYTES * 4);
    assert.equal(progress.at(-1), artifactBytes.length);
    assert.equal(receivedArtifact.receipt?.digest, sha256Digest(artifactBytes));
    const roundTrip = await fetch(collaborationUrl + "/artifacts?" + artifactQuery, { headers: collaborationHeaders });
    assert.equal(roundTrip.status, 200);
    assert.deepEqual(await roundTrip.json(), { offers: [receivedArtifact] });
    assert.equal(devices.developerStore.getPhoneArtifactReceipt("pc-build-artifact")?.digest, sha256Digest(artifactBytes));
    const replayBuild = await developerPost(sessionPath + "/jobs", projectJob);
    assert.equal(replayBuild.status, 200);
    assert.deepEqual(await replayBuild.json(), built);
    assert.equal(await readFile(project.callLog, "utf8"), "build\n");
    assert.equal((await developerPost(sessionPath + "/jobs", { ...projectJob, buildId: "different" })).status, 409);
    await writeFile(project.output, "changed project output");
    const buildList = await fetch(collaborationUrl + "/artifacts/from-build?" + artifactQuery, { headers: collaborationHeaders });
    assert.equal(buildList.status, 200);
    assert.deepEqual(await buildList.json(), { builds: [{
      buildJobId: projectJob.jobId, buildId: projectJob.buildId, name: "project-debug.apk",
      packageId: built.artifact.packageId, versionCode: built.artifact.androidApk?.versionCode,
      digest: built.artifact.digest, builtAt: built.artifact.createdAt,
    }] });
    const buildShare = (buildJobId: string) => fetch(collaborationUrl + "/artifacts/from-build", {
      method: "POST", headers: { ...collaborationHeaders, "X-Ling-Csrf-Token": gateway!.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ shareId: share.shareId, expectedRevision: share.revision, proposalId: "project-apk", buildJobId }),
    });
    assert.equal((await buildShare("missing-build")).status, 409);
    const fromBuild = await buildShare(projectJob.jobId);
    assert.equal(fromBuild.status, 201);
    const projectOffer = await fromBuild.json() as RemoteDeviceArtifactOfferV1;
    assert.equal(projectOffer.manifest.digest, built.artifact.digest);
    assert.equal(projectOffer.manifest.androidApk?.packageId, built.artifact.packageId);
    assert.deepEqual(await (await buildShare(projectJob.jobId)).json(), projectOffer);
    const receivedBuild = await phone.artifacts.receive({ offer: await phone.artifacts.decide(projectOffer, "accepted", client), peer: client });
    assert.equal(receivedBuild.receipt?.digest, built.artifact.digest);
    const unsigned = await offerArtifact("unsigned-apk", "unsigned.apk", apkFixture.unsigned);
    assert.equal(unsigned.status, 400);
    assert.match(await unsigned.text(), /APK signature could not be verified/u);
    const apkUpload = await offerArtifact("signed-apk", "signed.APK", apkFixture.signed);
    assert.equal(apkUpload.status, 201);
    const apkOffer = await apkUpload.json() as RemoteDeviceArtifactOfferV1;
    assert.equal(apkOffer.manifest.digest, sha256Digest(apkFixture.signed));
    assert.deepEqual(apkOffer.manifest.androidApk, apkFixture.identity);
    assert.deepEqual(await client.listDeviceArtifacts(share.shareId, share.revision), [receivedArtifact, receivedBuild, apkOffer]);
    await assert.rejects(client.decideDeviceArtifact({
      ...apkOffer, manifest: { ...apkOffer.manifest, androidApk: { ...apkFixture.identity, versionCode: "4294967339", legacyVersionCode: "43" } },
    }, "accepted"), /artifact_signature_invalid/u);
    const approvedApk = await phone.artifacts.decide(apkOffer, "accepted", client);
    const receivedApk = await phone.artifacts.receive({ offer: approvedApk, peer: client });
    const receipt = receivedApk.receipt;
    assert.ok(receipt);
    assert.equal(receipt.apkVerification, "paired_gateway");
    assert.deepEqual(devices.developerStore.getPhoneArtifactReceipt("signed-apk"), receipt);
    assert.ok(await keys.verify(mobile.jwk, deviceArtifactReceiptBytes(apkOffer.manifest, receipt), receipt.signature));
    assert.equal(await keys.verify(mobile.jwk, deviceArtifactReceiptBytes(apkOffer.manifest, {
      ...receipt, apkVerification: "android_package_manager",
    }), receipt.signature), false);
    client.disconnect();
    for (const protocol of [REMOTE_DEVICE_TASKS_SUBPROTOCOL_V7, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V8]) {
      let socket: WebSocket | undefined;
      const compat = new RemoteSessionClient({
        binding, keys, clock,
        http: createFetchRemoteHttpClient((input, init) => fetch("http://127.0.0.1:" + listenerPort + new URL(String(input)).pathname, init)),
        bindingStore: { async read() { return binding; }, async write() {}, async remove() {} },
        cacheStore: { async read() { return undefined; }, async write() {}, async remove() {} },
        entropy: { randomBytes, randomId: prefix => prefix + "_" + randomUUID() },
        autoReconnect: false,
        webSocketFactory: () => (socket = new WebSocket(`ws://127.0.0.1:${listenerPort}/v1/session`, protocol)),
      });
      try {
        await compat.connect();
        assert.equal(socket?.protocol, protocol);
        const offers = await compat.listDeviceArtifacts(share.shareId, share.revision);
        if (protocol === REMOTE_DEVICE_TASKS_SUBPROTOCOL_V7) {
          assert.deepEqual(offers, [receivedArtifact]);
          await assert.rejects(compat.readDeviceArtifactChunk(apkOffer.manifest, 0), /Update Ling Mobile/u);
        } else assert.deepEqual(offers, [receivedArtifact, receivedBuild, receivedApk]);
      } finally {
        compat.disconnect();
      }
    }
    await client.connect();
    const savedArtifact = (await phone.artifacts.listSaved(phoneRecovery.taskId))[0];
    assert.ok(savedArtifact);
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
    assert.equal((await fetch(collaborationUrl + "/artifacts/from-build?" + artifactQuery, { headers: collaborationHeaders })).status, 409);
    await assert.rejects(client.readDeviceArtifactChunk(approvedArtifact.manifest, 9), /ended/u);
    await phone.artifacts.export(phoneRecovery.taskId, savedArtifact.fileId);
    assert.deepEqual(exported, artifactBytes);
    control.registry.revokeBinding(publication.binding.bindingId, publication.binding.revision + 1);
    await waitFor(() => client?.state.connection !== "connected", 12_000);
    await assert.rejects(client.connect(), { status: 403 });
  });

async function createApkFixture(root: string) {
  const native = process.env.LING_TEST_ANDROID_FIXTURE_DIR;
  const tools = {
    javaPath: process.env.LING_TEST_ANDROID_JAVA ?? process.execPath,
    apkSignerJar: native ? join(native, "apksigner.jar") : process.execPath,
    aapt2Path: native ? join(native, "aapt2") : process.execPath,
  };
  const signed = native ? await readFile(join(native, "fixture-major.apk")) : Buffer.from("signed apk fixture");
  const unsigned = native ? await readFile(join(native, "fixture-major-unsigned.apk")) : Buffer.from("unsigned apk fixture");
  let signer = "b".repeat(64);
  if (native) {
    const output = execFileSync(tools.javaPath, ["-jar", tools.apkSignerJar, "verify", "--print-certs-pem", join(native, "fixture-major.apk")],
      { encoding: "utf8" });
    const certificate = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/u.exec(output)?.[0];
    assert.ok(certificate);
    signer = createHash("sha256").update(new X509Certificate(certificate).raw).digest("hex");
  }
  const identity: AndroidApkIdentityV1 = {
    packageId: "org.lingstack.majorfixture", versionCode: "4294967338", legacyVersionCode: "42", signerCertificateSha256: [signer],
  };
  const fixtureRunner: LocalProcessRunner = {
    async run(_file, args) {
      if (args[0] === "-jar") {
        const bytes = await readFile(args.at(-1)!);
        if (bytes.equals(unsigned)) return { stdout: "", stderr: "", exitCode: 1 };
        assert.deepEqual(bytes, signed);
        const stdout = [
          "Verifies",
          `V3.0 Signer: certificate SHA-256 digest: ${signer}`,
          "Source Stamp Signer: certificate SHA-256 digest: " + "f".repeat(64),
        ].join("\n");
        return { stdout, stderr: "", exitCode: 0 };
      }
      assert.deepEqual(await readFile(args[2]!), signed);
      return { stdout: [
        "E: manifest (line=2)",
        "  A: http://schemas.android.com/apk/res/android:versionCode(0x0101021b)=42",
        "  A: http://schemas.android.com/apk/res/android:versionCodeMajor(0x01010576)=1",
        `  A: package="${identity.packageId}"`,
        "  E: application",
      ].join("\n"), stderr: "", exitCode: 0 };
    },
  };
  return { identity, signed, unsigned, library: new AndroidApkLibrary(join(root, "apk-library"), tools, native ? localProcessRunner : fixtureRunner) };
}

async function createProjectFixture(root: string) {
  const project = join(root, "app-workspace");
  const output = join(project, "out", "project-debug.apk");
  const callLog = join(project, "out", "build-count");
  const configuration = join(root, "android-builds.json");
  await mkdir(project);
  const native = process.env.LING_TEST_ANDROID_FIXTURE_DIR;
  const steps: string[] = [];
  if (native) {
    const java = process.env.LING_TEST_ANDROID_JAVA ?? "java";
    const keytool = join(java, "..", "keytool");
    const key = join(root, "test-signing.jks");
    execFileSync(keytool, ["-genkeypair", "-keyalg", "RSA", "-keysize", "2048", "-keystore", key, "-storepass", "build-fixture-only",
      "-keypass", "build-fixture-only", "-alias", "fixture", "-dname", "CN=Ling Build Fixture", "-validity", "30"], { stdio: "ignore" });
    steps.push(
      `execFileSync(${JSON.stringify(join(native, "aapt2"))}, ${JSON.stringify([
        "link", "-I", join(native, "android.jar"), "--manifest", "AndroidManifest.xml", "-o", "out/unsigned.apk",
      ])});`,
      `execFileSync(${JSON.stringify(java)}, ${JSON.stringify([
        "-jar", join(native, "apksigner.jar"), "sign", "--ks", key, "--ks-pass", "pass:build-fixture-only",
        "--out", "out/project-debug.apk", "out/unsigned.apk",
      ])});`,
    );
  } else steps.push('writeFileSync("out/project-debug.apk", "signed apk fixture");');
  await writeFile(join(project, "AndroidManifest.xml"), [
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="org.lingstack.projectfixture" android:versionCode="71">',
    '  <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="30" />',
    '  <application android:hasCode="false" android:label="Ling project APK fixture" />',
    "</manifest>",
  ].join("\n"));
  await writeFile(join(project, ".gitignore"), "out/\n");
  await writeFile(join(project, "build.mjs"), [
    'import { execFileSync } from "node:child_process";',
    'import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";',
    'mkdirSync("out", { recursive: true });',
    ...steps,
    'appendFileSync("out/build-count", "build\\n");',
    'console.log("project APK built");',
  ].join("\n"));
  const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8" });
  git("init", "--quiet");
  git("add", ".");
  git("-c", "user.name=Ling Test", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Android fixture sources");
  const revision = git("rev-parse", "HEAD").trim();
  await writeFile(configuration, JSON.stringify({ version: 1, builds: [{
    buildId: "test-debug", directory: "app-workspace", executable: process.execPath, args: ["build.mjs"],
    apkPath: "out/project-debug.apk", variant: "debug", toolchain: "Android SDK Build Tools",
  }] }));
  return { output, callLog, configuration, revision };
}

function pairedKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = validateRemoteP256PublicJwkV1(publicKey.export({ format: "jwk" }));
  return { privateKey, jwk, fingerprint: fingerprintPublicJwkSync(jwk) };
}

function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
