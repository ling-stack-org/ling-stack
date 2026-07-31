import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { RemoteSessionClient } from "../dist/index.js";

const fixture = JSON.parse(await readFile(new URL("../../remote-protocol/fixtures/v1/canonical-signing.json", import.meta.url), "utf8"));
const now = "2026-07-31T10:00:00.000Z";

class FakeSocket {
  readyState = 0;
  sent = [];
  listeners = { open: [], message: [], close: [], error: [] };

  addEventListener(type, listener) {
    this.listeners[type].push(listener);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code, reason) {
    this.readyState = 3;
    for (const listener of this.listeners.close) listener({ code, reason });
  }

  open() {
    this.readyState = 1;
    for (const listener of this.listeners.open) listener();
  }

  message(frame) {
    for (const listener of this.listeners.message) listener({ data: JSON.stringify(frame) });
  }
}

test("session authentication restores the binding and starts a full workspace subscription", async () => {
  const socket = new FakeSocket();
  let binding = {
    version: 1,
    status: "active",
    gatewayId: "gateway-fixture-1",
    gatewayOrigin: "https://ling-pc.example.ts.net",
    gatewayIdentityPublicKeyJwk: fixture.gatewayIdentity.publicKeyJwk,
    gatewayIdentityFingerprint: fixture.gatewayIdentity.fingerprint,
    deviceId: "device-fixture-1",
    deviceKeyId: "ling.remote.device.gateway-fixture-1",
    deviceEpoch: 7,
    pairedAt: now,
  };
  const client = new RemoteSessionClient({
    binding,
    autoReconnect: false,
    clock: { now: () => now },
    entropy: {
      randomBytes: (length) => new Uint8Array(length).fill(2),
      randomId: (() => { let sequence = 0; return (prefix) => `${prefix}_${++sequence}`; })(),
    },
    keys: {
      generateOrLoad: async () => { throw new Error("not_used"); },
      sign: async () => fixture.authProof.signatureBase64Url,
      verify: async () => true,
      delete: async () => undefined,
    },
    bindingStore: {
      read: async () => binding,
      write: async (next) => { binding = next; },
      remove: async () => { binding = undefined; },
    },
    cacheStore: {
      read: async () => undefined,
      write: async () => undefined,
      remove: async () => undefined,
    },
    http: {
      getJson: async () => { throw new Error("not_used"); },
      postJson: async (_origin, path, body) => {
        assert.equal(path, "/v1/auth/challenge");
        assert.equal(body.deviceId, "device-fixture-1");
        return {
          status: 200,
          body: {
            version: 1,
            gatewayId: "gateway-fixture-1",
            challengeId: "challenge-fixture-1",
            serverNonce: fixture.authChallenge.input.serverNonce,
            candidateSessionId: "session-fixture-1",
            deviceEpoch: 7,
            issuedAt: now,
            expiresAt: "2026-07-31T10:00:30.000Z",
            supportedProtocolVersions: [1],
            gatewaySignature: fixture.authChallenge.signatureBase64Url,
          },
        };
      },
    },
    webSocketFactory: (url) => {
      assert.equal(url, "wss://ling-pc.example.ts.net/v1/session");
      return socket;
    },
  });

  const connecting = client.connect();
  await waitFor(() => socket.listeners.open.length > 0);
  socket.open();
  await Promise.resolve();
  assert.equal(socket.sent[0].candidateSessionId, "session-fixture-1");
  socket.message({
    version: 1,
    type: "session.ready",
    messageId: "server-message-1",
    gatewayId: "gateway-fixture-1",
    sessionId: "session-fixture-1",
    sentAt: now,
    payload: {
      deviceId: "device-fixture-1",
      protocolVersion: 1,
      policy: {
        version: 1,
        workspaceId: "default",
        workspaceBindingId: "workspace-binding-1",
        policyVersion: 1,
        conversationAccess: { mode: "all_in_workspace", kinds: ["channel", "conversation", "teammate_direct"] },
        capabilities: ["conversation.read", "conversation.send_text", "conversation.mark_read", "profile.read", "profile.update"],
      },
      connectedAt: now,
    },
    streamId: "control-stream-1",
    eventId: "event-1",
    serverSeq: 1,
    occurredAt: now,
  });
  await connecting;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(client.state.connection, "connected");
  assert.equal(client.state.workspaceBindingId, "workspace-binding-1");
  assert.equal(binding.workspaceBindingId, "workspace-binding-1");
  assert.ok(socket.sent.some((frame) => frame.type === "stream.subscribe" && frame.payload.scope.workspaceId === "default"));
  assert.ok(socket.sent.some((frame) => frame.type === "stream.ack" && frame.payload.ackServerSeq === 1));
  client.disconnect();
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition_not_met");
}
