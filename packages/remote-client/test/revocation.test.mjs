import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { RemoteSessionClient } from "../dist/index.js";

const fixture = JSON.parse(await readFile(new URL("../../remote-protocol/fixtures/v1/canonical-signing.json", import.meta.url), "utf8"));
const binding = {
  version: 1,
  status: "active",
  gatewayId: "gateway-fixture-1",
  gatewayOrigin: "https://ling-pc.example.ts.net",
  gatewayIdentityPublicKeyJwk: fixture.gatewayIdentity.publicKeyJwk,
  gatewayIdentityFingerprint: fixture.gatewayIdentity.fingerprint,
  deviceId: "device-fixture-1",
  deviceKeyId: "ling.remote.device.gateway-fixture-1",
  deviceEpoch: 7,
  pairedAt: "2026-07-31T10:00:00.000Z",
  workspaceBindingId: "workspace-binding-1",
};

const authChallenge = {
  version: 1,
  gatewayId: binding.gatewayId,
  challengeId: "challenge-fixture-1",
  serverNonce: fixture.authChallenge.input.serverNonce,
  candidateSessionId: "session-fixture-1",
  deviceEpoch: binding.deviceEpoch,
  issuedAt: "2026-07-31T10:00:00.000Z",
  expiresAt: "2026-07-31T10:00:30.000Z",
  supportedProtocolVersions: [1],
  gatewaySignature: fixture.authChallenge.signatureBase64Url,
};

test("local revocation attempts every cleanup step and can retry after a partial failure", async () => {
  const operations = [];
  let failFirstWrite = true;
  const client = new RemoteSessionClient({
    binding,
    autoReconnect: false,
    keys: {
      generateOrLoad: async () => { throw new Error("not_used"); },
      sign: async () => { throw new Error("not_used"); },
      verify: async () => false,
      delete: async (keyId) => { operations.push(["delete_key", keyId]); },
    },
    bindingStore: {
      read: async () => binding,
      write: async (next) => {
        operations.push(["write_revoked", next.status]);
        if (failFirstWrite) {
          failFirstWrite = false;
          throw new Error("secure_store_temporarily_unavailable");
        }
      },
      remove: async () => { operations.push(["remove_binding"]); },
    },
    cacheStore: {
      read: async () => undefined,
      write: async () => undefined,
      remove: async (workspaceBindingId) => { operations.push(["remove_cache", workspaceBindingId]); },
    },
    http: {
      getJson: async () => { throw new Error("not_used"); },
      postJson: async () => { throw new Error("not_used"); },
    },
    webSocketFactory: () => { throw new Error("not_used"); },
  });

  await assert.rejects(client.revokeLocal(), /remote_local_revoke_incomplete/u);
  assert.equal(client.state.connection, "revoked");
  assert.deepEqual(operations, [
    ["write_revoked", "revoked"],
    ["remove_cache", "workspace-binding-1"],
    ["delete_key", "ling.remote.device.gateway-fixture-1"],
    ["remove_binding"],
  ]);

  operations.length = 0;
  await client.revokeLocal();
  assert.deepEqual(operations, [
    ["write_revoked", "revoked"],
    ["remove_cache", "workspace-binding-1"],
    ["delete_key", "ling.remote.device.gateway-fixture-1"],
    ["remove_binding"],
  ]);
});

test("revocation invalidates an authentication attempt before it can create a socket", async () => {
  const signing = deferred();
  let signStarted = false;
  let socketCreations = 0;
  const client = new RemoteSessionClient({
    binding,
    autoReconnect: false,
    clock: { now: () => "2026-07-31T10:00:00.000Z" },
    entropy: {
      randomBytes: (length) => new Uint8Array(length).fill(2),
      randomId: (prefix) => `${prefix}_1`,
    },
    keys: {
      generateOrLoad: async () => { throw new Error("not_used"); },
      sign: async () => {
        signStarted = true;
        return await signing.promise;
      },
      verify: async () => true,
      delete: async () => undefined,
    },
    bindingStore: {
      read: async () => binding,
      write: async () => undefined,
      remove: async () => undefined,
    },
    cacheStore: {
      read: async () => undefined,
      write: async () => undefined,
      remove: async () => undefined,
    },
    http: {
      getJson: async () => { throw new Error("not_used"); },
      postJson: async () => ({ status: 200, body: authChallenge }),
    },
    webSocketFactory: () => {
      socketCreations += 1;
      throw new Error("socket_must_not_be_created");
    },
  });

  const connecting = client.connect();
  await waitFor(() => signStarted);
  await client.revokeLocal();
  signing.resolve(fixture.authProof.signatureBase64Url);

  await assert.rejects(connecting, /remote_connection_invalidated/u);
  assert.equal(socketCreations, 0);
  assert.equal(client.state.connection, "revoked");
});

test("a socket close before session ready rejects connect and permits a fresh retry", async () => {
  const sockets = [];
  const client = new RemoteSessionClient({
    binding,
    autoReconnect: false,
    clock: { now: () => "2026-07-31T10:00:00.000Z" },
    entropy: {
      randomBytes: (length) => new Uint8Array(length).fill(2),
      randomId: (prefix) => `${prefix}_1`,
    },
    keys: {
      generateOrLoad: async () => { throw new Error("not_used"); },
      sign: async () => fixture.authProof.signatureBase64Url,
      verify: async () => true,
      delete: async () => undefined,
    },
    bindingStore: {
      read: async () => binding,
      write: async () => undefined,
      remove: async () => undefined,
    },
    cacheStore: {
      read: async () => undefined,
      write: async () => undefined,
      remove: async () => undefined,
    },
    http: {
      getJson: async () => { throw new Error("not_used"); },
      postJson: async () => ({ status: 200, body: authChallenge }),
    },
    webSocketFactory: () => {
      const socket = createClosableSocket();
      sockets.push(socket);
      return socket;
    },
  });

  const firstConnect = client.connect();
  await waitFor(() => sockets.length === 1);
  sockets[0].close(1006, "network_lost_before_ready");
  await assert.rejects(firstConnect, /network_lost_before_ready/u);
  assert.equal(client.state.connection, "reconnecting");

  const retry = client.connect();
  await waitFor(() => sockets.length === 2);
  sockets[1].close(1006, "retry_closed_before_ready");
  await assert.rejects(retry, /retry_closed_before_ready/u);
  assert.equal(client.state.connection, "reconnecting");
  client.disconnect();
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  throw new Error("condition_not_met");
}

function createClosableSocket() {
  const listeners = { open: [], message: [], close: [], error: [] };
  return {
    readyState: 0,
    send() {},
    addEventListener(type, listener) {
      listeners[type].push(listener);
    },
    close(code, reason) {
      this.readyState = 3;
      for (const listener of listeners.close) {
        listener({ code, reason });
      }
    },
  };
}
