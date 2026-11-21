import assert from "node:assert/strict";
import test from "node:test";

import { RemoteSessionClient } from "../dist/index.js";
import type {
  RemoteBindingV1,
  RemoteSocketCloseEvent,
  RemoteSocketMessageEvent,
  RemoteWebSocketLike,
} from "../dist/index.js";
import { fixture } from "./canonical-signing-fixture.ts";

const now = "2026-07-31T10:00:00.000Z";

interface SentFrame {
  readonly type?: string;
  readonly candidateSessionId?: string;
  readonly payload?: {
    readonly scope?: { readonly workspaceId?: string };
    readonly ackServerSeq?: number;
  };
  readonly [key: string]: unknown;
}

class FakeSocket implements RemoteWebSocketLike {
  readyState = 0;
  sent: SentFrame[] = [];
  listeners: {
    open: Array<() => void>;
    message: Array<(event: RemoteSocketMessageEvent) => void>;
    close: Array<(event: RemoteSocketCloseEvent) => void>;
    error: Array<() => void>;
  } = { open: [], message: [], close: [], error: [] };

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (() => void) | ((event: RemoteSocketMessageEvent) => void) | ((event: RemoteSocketCloseEvent) => void),
  ): void {
    if (type === "open") this.listeners.open.push(listener as () => void);
    if (type === "message") this.listeners.message.push(listener as (event: RemoteSocketMessageEvent) => void);
    if (type === "close") this.listeners.close.push(listener as (event: RemoteSocketCloseEvent) => void);
    if (type === "error") this.listeners.error.push(listener as () => void);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentFrame);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    for (const listener of this.listeners.close) listener({ code, reason });
  }

  open() {
    this.readyState = 1;
    for (const listener of this.listeners.open) listener();
  }

  message(frame: unknown): void {
    for (const listener of this.listeners.message) listener({ data: JSON.stringify(frame) });
  }
}

test("session authentication restores the binding and starts a full workspace subscription", async () => {
  const socket = new FakeSocket();
  let binding: RemoteBindingV1 | undefined = {
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
      randomId: (() => { let sequence = 0; return (prefix: string) => `${prefix}_${++sequence}`; })(),
    },
    keys: {
      generateOrLoad: async () => { throw new Error("not_used"); },
      sign: async () => fixture.authProof.signatureBase64Url,
      verify: async () => true,
      delete: async (): Promise<void> => undefined,
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
      postJson: async <T>(_origin: string, path: string, body: unknown) => {
        assert.equal(path, "/v1/auth/challenge");
        assert.equal((body as { deviceId?: string }).deviceId, "device-fixture-1");
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
          } as T,
        };
      },
    },
    webSocketFactory: (url: string) => {
      assert.equal(url, "wss://ling-pc.example.ts.net/v1/session");
      return socket;
    },
  });

  const connecting = client.connect();
  await waitFor(() => socket.listeners.open.length > 0);
  socket.open();
  await Promise.resolve();
  assert.equal(socket.sent[0].candidateSessionId, "session-fixture-1");
  const readyFrame = {
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
  };
  socket.message(readyFrame);
  await connecting;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(client.state.connection, "connected");
  assert.equal(client.state.workspaceBindingId, "workspace-binding-1");
  assert.equal((binding as RemoteBindingV1).workspaceBindingId, "workspace-binding-1");
  assert.ok(socket.sent.some((frame) => frame.type === "stream.subscribe" && (frame.payload as { scope: { workspaceId: string } }).scope.workspaceId === "default"));
  assert.ok(socket.sent.some((frame) => frame.type === "stream.ack" && (frame.payload as { ackServerSeq: number }).ackServerSeq === 1));

  const sentBeforeGap = socket.sent.length;
  socket.message({
    ...readyFrame,
    messageId: "server-message-gap",
    eventId: "event-gap",
    serverSeq: 3,
  });
  await waitFor(() => socket.sent.slice(sentBeforeGap).some((frame) => frame.type === "snapshot.request"));
  assert.equal(
    socket.sent.slice(sentBeforeGap).some((frame) => frame.type === "stream.ack" && (frame.payload as { ackServerSeq: number }).ackServerSeq === 3),
    false,
  );
  client.disconnect();
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition_not_met");
}
