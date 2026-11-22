import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LING_SERVER_NEGOTIATED_DATA_CHANNEL_FEATURE_V1, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V5,
  type LingServerRendezvousRequestV1, type LingServerSignalingInputV1, type LingServerSignedSignalingV1,
} from "@ling-stack/contracts";
import {
  fingerprintPublicJwkSync, lingServerPairingPinChallengeBytes, lingServerRendezvousReceiptBytes, lingServerRendezvousRequestBytes,
  lingServerSignalingSigningBytes, validateLingServerRendezvousReceiptV1, validateRemoteP256PublicJwkV1,
} from "@ling-stack/remote-protocol";
import { LingServerControlPlane } from "../dist/features/ling-server/control-plane.js";

test("self-hosted Ling Server control plane requires auth and preserves route fallback", async () => {
  const control = new LingServerControlPlane({ authToken: "server-token", now: () => "2026-11-21T00:00:00.000Z", transport: {
    features: ["ordered-channel", REMOTE_DEVICE_TASKS_SUBPROTOCOL_V5, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4, "ordered-channel"],
    stunUrls: ["stun:stun.ling.example:3478"], turnUrls: ["turns:turn.ling.example:443"], relaySharedSecret: "0123456789abcdef",
  } });
  const address = await control.start();
  try {
    const health = await fetch(`http://${address.host}:${address.port}/healthz`);
    assert.equal(health.status, 200);
    const unauthorized = await fetch(`http://${address.host}:${address.port}/v1/installations`, { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 401);
    const headers = { authorization: "Bearer server-token", "content-type": "application/json" };
    const malformed = await fetch(`http://${address.host}:${address.port}/v1/installations`, {
      method: "POST", headers, body: "private-fixture-value",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "bad_request" });
    const installation = await fetch(`http://${address.host}:${address.port}/v1/installations`, { method: "POST", headers, body: JSON.stringify({ installationId: "install-1", serverOrigin: "https://ling.example", applicationKeyFingerprint: "server-fp", revision: 1, status: "active" }) });
    assert.equal(installation.status, 200);
    const binding = await fetch(`http://${address.host}:${address.port}/v1/bindings`, { method: "POST", headers, body: JSON.stringify({ bindingId: "binding-1", installationId: "install-1", gatewayId: "gateway-1", mobileDeviceId: "mobile-1", gatewayKeyFingerprint: "gateway-fp", mobileKeyFingerprint: "mobile-fp", epoch: 1, revision: 1, status: "active" }) });
    assert.equal(binding.status, 200);
    const route = await fetch(`http://${address.host}:${address.port}/v1/routes`, { method: "POST", headers, body: JSON.stringify({ action: "begin", route: { routeAttemptId: "route-1", bindingId: "binding-1", preferred: "direct", status: "checking", expiresAt: "2026-11-21T00:05:00.000Z" } }) });
    assert.equal(route.status, 200);
    const selected = await fetch(`http://${address.host}:${address.port}/v1/routes`, { method: "POST", headers, body: JSON.stringify({ action: "select", routeAttemptId: "route-1", selected: "direct" }) });
    assert.equal(selected.status, 200);
    const configUrl = `http://${address.host}:${address.port}/v1/routes/transport-config`;
    const configInput = { bindingId: "binding-1", routeAttemptId: "route-1", role: "mobile", localKeyFingerprint: "mobile-fp", remoteKeyFingerprint: "gateway-fp", expiresAt: "2026-11-21T00:04:00.000Z" };
    const config = await fetch(configUrl, { method: "POST", headers, body: JSON.stringify(configInput) });
    assert.equal(config.status, 200);
    const configBody = await config.json() as { readonly route: string; readonly features: readonly string[] };
    assert.equal(configBody.route, "direct");
    assert.deepEqual(configBody.features, [
      REMOTE_DEVICE_TASKS_SUBPROTOCOL_V5, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4, LING_SERVER_NEGOTIATED_DATA_CHANNEL_FEATURE_V1, "ordered-channel",
    ]);
    const wrongKey = await fetch(configUrl, { method: "POST", headers, body: JSON.stringify({ ...configInput, localKeyFingerprint: "different-fingerprint" }) });
    assert.equal(wrongKey.status, 400);
    const diagnostics = await fetch(`http://${address.host}:${address.port}/v1/routes/diagnostics`, { method: "POST", headers, body: JSON.stringify({ bindingId: "binding-1", routeAttemptId: "route-1", diagnosticId: "diag-1", checks: [{ id: "control_reachability", status: "pass", code: "reachable" }] }) });
    assert.equal(diagnostics.status, 200);
    assert.equal((await diagnostics.json()).checks[0].code, "reachable");
    const failover = await fetch(`http://${address.host}:${address.port}/v1/routes`, { method: "POST", headers, body: JSON.stringify({ action: "failover", routeAttemptId: "route-1" }) });
    assert.equal((await failover.json()).preferred, "relay");
    const credentialUrl = `http://${address.host}:${address.port}/v1/routes/relay-credential`;
    const requestCredential = (role = "mobile") => fetch(credentialUrl, {
      method: "POST", headers, body: JSON.stringify({ bindingId: "binding-1", routeAttemptId: "route-1", role }),
    });
    assert.equal((await requestCredential("invalid")).status, 400);
    const relayResponse = await requestCredential();
    assert.equal(relayResponse.status, 200);
    assert.equal(relayResponse.headers.get("cache-control"), "no-store");
    const relay = await relayResponse.json() as { url: string; username: string; expiresAt: string };
    assert.equal(relay.url, "turns:turn.ling.example:443");
    assert.match(relay.username, /:[0-9a-f]{64}:mobile$/u);
    assert.equal(relay.expiresAt, "2026-11-21T00:05:00.000Z");
    const connectedRelay = await fetch(`http://${address.host}:${address.port}/v1/routes`, {
      method: "POST", headers, body: JSON.stringify({ action: "select", routeAttemptId: "route-1", selected: "relay" }),
    });
    assert.equal(connectedRelay.status, 200);
    const relayConfig = await fetch(configUrl, { method: "POST", headers, body: JSON.stringify(configInput) });
    assert.equal(relayConfig.status, 200);
    assert.deepEqual((await relayConfig.json()).relayCredential, relay);
    assert.equal((await fetch(configUrl, { method: "POST", headers, body: JSON.stringify({ ...configInput, relayCredential: {} }) })).status, 400);
    const revoke = await fetch(`http://${address.host}:${address.port}/v1/bindings/binding-1/revoke`, { method: "POST", headers, body: JSON.stringify({ revision: 2 }) });
    assert.equal(revoke.status, 200);
    assert.equal((await requestCredential()).status, 400);
    const oldRoute = await fetch(`http://${address.host}:${address.port}/v1/routes`, { method: "POST", headers, body: JSON.stringify({ action: "select", routeAttemptId: "route-1", selected: "relay" }) });
    assert.equal(oldRoute.status, 400);
  } finally {
    await control.stop();
  }
});

test("self-hosted Ling Server restores control metadata after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "ling-server-control-"));
  const databasePath = join(root, "server.sqlite");
  const first = new LingServerControlPlane({ authToken: "server-token", databasePath, now: () => "2026-11-21T00:00:00.000Z" });
  const firstAddress = await first.start();
  const headers = { authorization: "Bearer server-token", "content-type": "application/json" };
  try {
    const installation = await fetch(`http://${firstAddress.host}:${firstAddress.port}/v1/installations`, { method: "POST", headers, body: JSON.stringify({ installationId: "install-1", serverOrigin: "https://ling.example", applicationKeyFingerprint: "server-fp", revision: 1, status: "active" }) });
    assert.equal(installation.status, 200);
    const binding = await fetch(`http://${firstAddress.host}:${firstAddress.port}/v1/bindings`, { method: "POST", headers, body: JSON.stringify({ bindingId: "binding-1", installationId: "install-1", gatewayId: "gateway-1", mobileDeviceId: "mobile-1", gatewayKeyFingerprint: "gateway-fp", mobileKeyFingerprint: "mobile-fp", epoch: 1, revision: 1, status: "active" }) });
    assert.equal(binding.status, 200);
  } finally {
    await first.stop();
  }

  const second = new LingServerControlPlane({ authToken: "server-token", databasePath, now: () => "2026-11-21T00:00:00.000Z" });
  const secondAddress = await second.start();
  try {
    const route = await fetch(`http://${secondAddress.host}:${secondAddress.port}/v1/routes`, { method: "POST", headers, body: JSON.stringify({ action: "begin", route: { routeAttemptId: "route-1", bindingId: "binding-1", preferred: "direct", status: "checking", expiresAt: "2026-11-21T00:05:00.000Z" } }) });
    assert.equal(route.status, 200);
  } finally {
    await second.stop();
  }
});

test("paired keys request and find the same route without exposing the admin listener", async t => {
  let clock = "2026-11-21T00:00:00.000Z";
  const newKey = () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const publicKeyJwk = validateRemoteP256PublicJwkV1(publicKey.export({ format: "jwk" }));
    return { privateKey, publicKey, publicKeyJwk, fingerprint: fingerprintPublicJwkSync(publicKeyJwk) };
  };
  const gateway = newKey();
  const mobile = newKey();
  const application = newKey();
  const control = new LingServerControlPlane({ authToken: "fixture-admin", adminPort: 0, now: () => clock,
    applicationIdentityPrivateKeyPem: application.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    transport: { turnUrls: ["turns:relay.fixture.example:443?transport=tcp"], relaySharedSecret: Buffer.from("fixture-relay-secret", "utf8") },
  });
  t.after(() => control.stop());
  const address = await control.start();
  const origin = "http://127.0.0.1:" + address.port;
  const installation = control.registry.registerInstallation({ installationId: "fixture-install", status: "active",
    serverOrigin: "https://ling.example", applicationKeyFingerprint: application.fingerprint, revision: 1 });
  const binding = control.registry.bindPeers({ bindingId: "fixture-binding", installationId: installation.installationId, status: "active",
    gatewayId: "fixture-pc", mobileDeviceId: "fixture-phone", gatewayKeyFingerprint: gateway.fingerprint,
    mobileKeyFingerprint: mobile.fingerprint, epoch: 2, revision: 1 });
  const { instanceId } = await (await fetch(origin + "/v1/signaling/instance")).json() as { instanceId: string };
  const scope = {
    version: 1, instanceId, installationId: installation.installationId, installationRevision: installation.revision,
    applicationKeyFingerprint: application.fingerprint, bindingId: binding.bindingId, peerEpoch: binding.epoch,
    gatewayId: binding.gatewayId, mobileDeviceId: binding.mobileDeviceId,
  } as const;
  const expiresAt = "2026-11-21T00:01:00.000Z";
  function proof(operation: LingServerRendezvousRequestV1["operation"], key: ReturnType<typeof newKey>,
    overrides: Partial<LingServerRendezvousRequestV1> = {}) {
    const input = { ...scope, expiresAt, nonce: randomBytes(32).toString("base64url"), operation, ...overrides };
    return { input, publicKeyJwk: key.publicKeyJwk,
      signature: sign("sha256", lingServerRendezvousRequestBytes(input), {
        key: key.privateKey, dsaEncoding: "ieee-p1363",
      }).toString("base64url") };
  }
  const send = (body: unknown, path = "/v1/rendezvous") => fetch(origin + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const getReceipt = async (response: Response) => {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const { applicationSignature, ...receipt } = validateLingServerRendezvousReceiptV1(await response.json());
    assert.deepEqual(receipt.applicationPublicKeyJwk, application.publicKeyJwk);
    assert.ok(verify("sha256", lingServerRendezvousReceiptBytes(receipt), {
      key: application.publicKey, dsaEncoding: "ieee-p1363",
    }, Buffer.from(applicationSignature, "base64url")));
    return receipt;
  };
  const routeAttemptId = "route-fixture";
  const request = { kind: "request_route", routeAttemptId, preferred: "direct" } as const;
  const initialPoll = proof({ kind: "poll_route" }, gateway);
  assert.deepEqual(await getReceipt(await send(initialPoll)), {
    request: initialPoll.input, applicationPublicKeyJwk: application.publicKeyJwk,
  });
  assert.equal((await send(initialPoll)).status, 409);
  assert.equal((await send(proof(request, gateway))).status, 403);
  assert.equal((await send(proof({ kind: "poll_route" }, mobile))).status, 403);
  assert.equal((await send(proof(request, mobile, { installationRevision: 2 }))).status, 403);
  assert.equal((await send(proof(request, mobile, { instanceId: "other-instance" }))).status, 403);
  assert.equal((await send({ action: "begin", route: {} }, "/v1/routes")).status, 404);
  assert.equal(control.registry.getRoute(routeAttemptId), undefined);
  const phoneRequest = proof(request, mobile);
  const tampered = { ...phoneRequest, input: { ...phoneRequest.input, operation: { ...request, preferred: "lan" } } };
  assert.equal((await send(tampered)).status, 403);
  const created = await getReceipt(await send(phoneRequest));
  assert.deepEqual(created.offer, phoneRequest);
  assert.deepEqual(control.registry.requireRoute(routeAttemptId), {
    routeAttemptId, bindingId: binding.bindingId, peerEpoch: binding.epoch, preferred: "direct", status: "gathering", expiresAt,
  });
  const nextPoll = proof({ kind: "poll_route" }, gateway);
  const discovered = await getReceipt(await send(nextPoll));
  assert.deepEqual(discovered.request, nextPoll.input);
  assert.deepEqual(discovered.offer, phoneRequest);
  const otherDirect = proof({ ...request, routeAttemptId: "other-direct" }, mobile);
  assert.equal((await send(otherDirect)).status, 503);
  const relay = proof({ ...request, routeAttemptId: "route-relay", preferred: "relay" }, mobile);
  assert.deepEqual((await getReceipt(await send(relay))).offer, relay);
  assert.equal(control.registry.requireRoute(routeAttemptId).status, "failed");
  assert.equal(control.registry.requireRoute("route-relay").preferred, "relay");
  assert.deepEqual((await getReceipt(await send(proof({ kind: "poll_route" }, gateway)))).offer, relay);
  const expired = expiresAt;
  clock = expired;
  const currentExpiry = "2026-11-21T00:01:30.000Z";
  assert.equal((await send(phoneRequest)).status, 403);
  assert.equal((await getReceipt(await send(proof({ kind: "poll_route" }, gateway, { expiresAt: currentExpiry })))).offer, undefined);
  assert.equal((await send(proof(request, mobile, { expiresAt: currentExpiry }))).status, 409);
  control.registry.revokeBinding(binding.bindingId, 2);
  assert.equal((await send(proof({ kind: "poll_route" }, gateway, { expiresAt: currentExpiry }))).status, 403);
});

test("paired peers exchange signed signaling over a bounded route and reject replay, tampering and revocation", async t => {
  let clock = "2026-11-21T00:00:00.000Z";
  const control = new LingServerControlPlane({ authToken: "server-token", now: () => clock, transport: {
    features: ["ordered-channel"], stunUrls: ["stun:stun.ling.example:3478"],
    turnUrls: ["turns:turn.ling.example:443"], relaySharedSecret: "0123456789abcdef",
  } });
  t.after(() => control.stop());
  const address = await control.start();
  const origin = `http://${address.host}:${address.port}`;
  const send = (base: string, body: unknown) => fetch(base + "/v1/signaling", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const instance = async (base: string) => {
    const response = await fetch(base + "/v1/signaling/instance");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const { instanceId } = await response.json() as { instanceId: string };
    return instanceId;
  };
  function peerKey() {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = validateRemoteP256PublicJwkV1(publicKey.export({ format: "jwk" }));
    return { jwk, privateKey, fingerprint: fingerprintPublicJwkSync(jwk) };
  }
  const gateway = peerKey();
  const mobile = peerKey();
  const serverKey = peerKey();
  control.registry.registerInstallation({
    installationId: "self-hosted", serverOrigin: "https://ling.example", applicationKeyFingerprint: serverKey.fingerprint,
    revision: 1, status: "active",
  });
  control.registry.bindPeers({
    bindingId: "binding-1", installationId: "self-hosted", gatewayId: "pc-1", mobileDeviceId: "phone-1",
    gatewayKeyFingerprint: gateway.fingerprint, mobileKeyFingerprint: mobile.fingerprint, epoch: 1, revision: 1, status: "active",
  });
  const expiresAt = "2026-11-21T00:03:00.000Z";
  control.registry.beginRoute({ bindingId: "binding-1", routeAttemptId: "route-1", preferred: "direct", status: "checking", expiresAt });
  const input = {
    version: 1, instanceId: await instance(origin), installationId: "self-hosted",
    applicationKeyFingerprint: serverKey.fingerprint, bindingId: "binding-1", routeAttemptId: "route-1", preferredRoute: "direct", peerEpoch: 1,
    gatewayId: "pc-1", mobileDeviceId: "phone-1", protocolMajor: 1, features: ["ordered-channel", REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4], expiresAt,
  } as const;
  const proof = (body: LingServerSignalingInputV1, key: ReturnType<typeof peerKey>): LingServerSignedSignalingV1 => ({
    input: body, publicKeyJwk: key.jwk,
    signature: sign("sha256", lingServerSignalingSigningBytes(body), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"),
  });
  const offer = { kind: "publish", messageType: "offer", sequence: 1, payload: "v=0\r\ns=ling-pc-fixture\r\n" } as const;
  const signedOffer = proof({ ...input, role: "gateway", operation: offer }, gateway);
  const configRequest = { kind: "transport_config", nonce: randomBytes(32).toString("base64url") } as const;
  const direct = await send(origin, proof({ ...input, role: "mobile", operation: configRequest }, mobile));
  assert.equal(direct.status, 200);
  assert.deepEqual(await direct.json(), {
    kind: "transport_config", route: "direct", stunUrls: ["stun:stun.ling.example:3478"], turnUrls: ["turns:turn.ling.example:443"],
  });
  assert.equal((await send(origin, { ...signedOffer, input: { ...signedOffer.input, operation: { ...offer, payload: "changed" } } })).status, 403);
  assert.equal((await send(origin, proof({ ...input, role: "gateway", operation: offer }, mobile))).status, 403);
  assert.equal((await send(origin, proof({ ...input, role: "gateway", operation: { ...offer, sequence: 2 } }, gateway))).status, 409);
  assert.deepEqual(await (await send(origin, signedOffer)).json(), { kind: "published", sequence: 1, replayed: false });
  assert.deepEqual(await (await send(origin, signedOffer)).json(), { kind: "published", sequence: 1, replayed: true });
  assert.equal((await send(origin, proof({ ...input, role: "gateway", operation: { ...offer, payload: "different valid message" } }, gateway))).status, 409);
  const poll = { kind: "poll", afterSequence: 0, nonce: randomBytes(32).toString("base64url") } as const;
  const phoneRead = proof({ ...input, role: "mobile", operation: poll }, mobile);
  assert.deepEqual(await (await send(origin, phoneRead)).json(), { kind: "signals", messages: [signedOffer], latestSequence: 1, hasMore: false });
  assert.equal((await send(origin, phoneRead)).status, 409);
  const answer = proof({ ...input, role: "mobile",
    operation: { kind: "publish", messageType: "answer", sequence: 1, payload: "v=0\r\ns=ling-mobile-fixture\r\n" },
  }, mobile);
  assert.equal((await send(origin, answer)).status, 200);
  const pcRead = proof({ ...input, role: "gateway", operation: { ...poll, nonce: randomBytes(32).toString("base64url") } }, gateway);
  assert.deepEqual((await (await send(origin, pcRead)).json()).messages, [answer]);
  const cursor = proof({ ...input, role: "mobile", operation: { ...poll, afterSequence: 1, nonce: randomBytes(32).toString("base64url") } }, mobile);
  assert.deepEqual((await (await send(origin, cursor)).json()).messages, []);
  assert.equal((await send(origin, proof({ ...input, role: "mobile", operation: { ...offer, payload: "x".repeat(33_000) } }, mobile))).status, 400);
  await control.stop();
  const restarted = await control.start();
  const reopenedOrigin = `http://${restarted.host}:${restarted.port}`;
  const nextInstance = await instance(reopenedOrigin);
  assert.notEqual(nextInstance, input.instanceId);
  assert.equal((await send(reopenedOrigin, signedOffer)).status, 403);
  const nextOffer = proof({ ...signedOffer.input, instanceId: nextInstance }, gateway);
  assert.equal((await send(reopenedOrigin, nextOffer)).status, 200);
  control.registry.failoverRoute("route-1", clock);
  assert.equal((await send(reopenedOrigin, nextOffer)).status, 403);
  const relayOffer = proof({ ...nextOffer.input, preferredRoute: "relay" }, gateway);
  assert.equal((await send(reopenedOrigin, relayOffer)).status, 200);
  const relayConfigRequest = proof({
    ...input, instanceId: nextInstance, preferredRoute: "relay", role: "mobile", operation: configRequest,
  }, mobile);
  const relayConfig = await send(reopenedOrigin, relayConfigRequest);
  assert.equal(relayConfig.status, 200);
  assert.equal((await relayConfig.json()).relayCredential.expiresAt, expiresAt);
  assert.equal((await send(reopenedOrigin, relayConfigRequest)).status, 409);
  clock = expiresAt;
  assert.equal((await send(reopenedOrigin, relayOffer)).status, 403);
  clock = "2026-11-21T00:02:00.000Z";
  control.registry.revokeBinding("binding-1", 2);
  assert.equal((await send(reopenedOrigin, relayOffer)).status, 403);
});

test("the standalone Ling Server starts a TLS peer listener and private administration", { timeout: 10_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "ling-server-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const certPath = join(root, "tls.crt");
  const keyPath = join(root, "tls.key");
  const cert = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "1",
    "-keyout", keyPath, "-out", certPath,
  ], { stdio: "ignore" });
  if ((cert.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    t.skip("OpenSSL is unavailable for the local TLS certificate fixture");
    return;
  }
  assert.equal(cert.status, 0);
  const confPath = join(root, "server.json");
  const token = "fixture-operator-token";
  writeFileSync(join(root, "operator.txt"), token + "\n", { mode: 0o600 });
  const applicationKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
  writeFileSync(join(root, "application.pem"), applicationKey.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  writeFileSync(confPath, JSON.stringify({
    host: "127.0.0.1", port: 0, adminPort: 0, authTokenFile: "operator.txt", databasePath: "server.sqlite",
    applicationIdentityKeyFile: "application.pem",
    tls: { certFile: "tls.crt", keyFile: "tls.key" },
  }));
  const cli = fileURLToPath(new URL("../dist/ling-server-cli.js", import.meta.url));
  const child = spawn(process.execPath, [cli, confPath], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
  });
  let stdout = "";
  const ready = new Promise<{ peerPort: number; adminPort: number }>(resolve => {
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
      const peerPort = /listening on https:\/\/127\.0\.0\.1:(\d+)\n/u.exec(stdout)?.[1];
      const adminPort = /administration on http:\/\/127\.0\.0\.1:(\d+)\n/u.exec(stdout)?.[1];
      if (peerPort && adminPort) resolve({ peerPort: Number(peerPort), adminPort: Number(adminPort) });
    });
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const { peerPort, adminPort } = await Promise.race([ready, exited.then(() => { throw new Error(stderr || "Ling Server exited before listening"); })]);
  const options = { hostname: "127.0.0.1", port: peerPort, servername: "localhost", ca: readFileSync(certPath), signal: AbortSignal.timeout(3000) };
  const status = (path: string, method = "GET", body?: unknown, authenticated = true) => new Promise<number | undefined>((resolve, reject) => {
    const request = httpsRequest({ ...options, path, method, headers: {
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.equal(await status("/healthz"), 200);
  assert.equal(await status("/v1/signaling/instance"), 200);
  const challenge = { version: 1 as const, migrationId: "unpublished", confirmationDigest: "0".repeat(64), nonce: randomBytes(32).toString("base64url") };
  assert.equal(await status("/v1/pairing-migrations/verify", "POST", {
    challenge, mobilePublicKeyJwk: applicationKey.publicKey.export({ format: "jwk" }),
    mobileSignature: sign("sha256", lingServerPairingPinChallengeBytes(challenge), {
      key: applicationKey.privateKey, dsaEncoding: "ieee-p1363",
    }).toString("base64url"),
  }, false), 403);
  assert.equal(await status("/v1/installations", "POST"), 404);
  const adminUrl = `http://127.0.0.1:${adminPort}/v1/installations`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const publish = (extraHeaders: Record<string, string> = {}) => fetch(adminUrl, {
    method: "POST", headers: { ...headers, ...extraHeaders },
    body: JSON.stringify({ installationId: "install-1", serverOrigin: "https://ling.example", applicationKeyFingerprint: "server-fp", revision: 1, status: "active" }),
  });
  assert.equal((await publish({ "X-Forwarded-For": "192.0.2.42" })).status, 403);
  assert.equal((await publish()).status, 200);
  child.kill("SIGTERM");
  assert.deepEqual(await exited, process.platform === "win32" ? [null, "SIGTERM"] : [0, null]);
  assert.equal(stdout.includes(token), false);
});
