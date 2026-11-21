import assert from "node:assert/strict";
import test from "node:test";

import { RemoteSessionClient } from "../dist/index.js";
import type {
  RemoteBindingV1,
  RemoteHttpClient,
  RemoteSocketCloseEvent,
  RemoteSocketMessageEvent,
  RemoteWebSocketLike,
} from "../dist/index.js";
import { fixture } from "./canonical-signing-fixture.ts";

const binding: RemoteBindingV1 = {
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
  const operations: Array<[string, string?]> = [];
  let failFirstWrite = true;
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
      sign: async (): Promise<string> => { throw new Error("not_used"); },
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
    } satisfies RemoteHttpClient,
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
  const signing = deferred<string>();
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
      sign: async (): Promise<string> => {
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
      postJson: async <T>() => ({ status: 200, body: authChallenge as T }),
    } satisfies RemoteHttpClient,
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
  const sockets: RemoteWebSocketLike[] = [];
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
      postJson: async <T>() => ({ status: 200, body: authChallenge as T }),
    } satisfies RemoteHttpClient,
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  throw new Error("condition_not_met");
}

function createClosableSocket(): RemoteWebSocketLike {
  const closeListeners: Array<(event: RemoteSocketCloseEvent) => void> = [];
  return {
    readyState: 0,
    send: (_data: string): void => undefined,
    addEventListener: (
      type: "open" | "message" | "close" | "error",
      listener: (() => void) | ((event: RemoteSocketMessageEvent) => void) | ((event: RemoteSocketCloseEvent) => void),
    ): void => {
      if (type === "close") closeListeners.push(listener as (event: RemoteSocketCloseEvent) => void);
    },
    close(code?: number, reason?: string): void {
      for (const listener of closeListeners) listener({ code, reason });
    },
  };
}
