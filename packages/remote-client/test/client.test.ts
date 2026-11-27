import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CONVERSATION_VISUALIZATION_MAX_BYTES, REMOTE_VISUALIZATION_CHUNKS_FEATURE, REMOTE_VISUALIZATION_CHUNK_BYTES, REMOTE_VISUALIZATION_FEATURE } from "@ling-stack/contracts";
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

for (const variant of ["legacy", "new-phone-old-pc", "negotiated", "chunks"] as const) {
  test(`remote session ${variant} preserves history and gates visualization reads by negotiation`, async () => {
    const socket = new FakeSocket();
    let cacheWrites = 0;
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
      requestConversationVisualizations: variant !== "legacy",
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
        write: async () => { cacheWrites += 1; },
        remove: async () => undefined,
      },
      http: {
        getJson: async () => { throw new Error("not_used"); },
        postJson: async <T>(_origin: string, path: string, body: unknown) => {
          assert.equal(path, variant === "legacy" ? "/v1/auth/challenge" :
            "/v1/auth/challenge?feature=" + REMOTE_VISUALIZATION_FEATURE + "&feature=" + REMOTE_VISUALIZATION_CHUNKS_FEATURE);
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
              ...(variant === "chunks" ? { negotiatedFeatures: [REMOTE_VISUALIZATION_FEATURE, REMOTE_VISUALIZATION_CHUNKS_FEATURE] }
                : variant === "negotiated" ? { negotiatedFeatures: [REMOTE_VISUALIZATION_FEATURE] } : {}),
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

    const artifactId = "viz_" + "a".repeat(32);
    let serverSeq = 1;
    const chunked = variant === "chunks";
    const capable = chunked || variant === "negotiated";
    assert.equal(client.supportsConversationVisualizations, capable);
    if (capable) {
      const prefix = "<main>" + "a".repeat(REMOTE_VISUALIZATION_CHUNK_BYTES - 7) + "界面";
      const content = chunked ? prefix + "a".repeat(CONVERSATION_VISUALIZATION_MAX_BYTES - Buffer.byteLength(prefix + "</main>")) + "</main>"
        : "<details><summary>界面示意</summary>示例</details>";
      const bytes = Buffer.from(content);
      const commandType = chunked ? "conversation.visualization.read_chunk" : "conversation.visualization.read";
      async function replyToRead(sha256: string, cancel = false) {
        let previous = socket.sent.length;
        const controller = new AbortController();
        const result = client.readConversationVisualization("conversation-1", "message-1", 2, artifactId, controller.signal);
        void result.catch(() => undefined);
        for (let offset = 0; offset < bytes.length; offset += REMOTE_VISUALIZATION_CHUNK_BYTES) {
          await waitFor(() => socket.sent.slice(previous).some(frame => frame.type === commandType));
          const sent = socket.sent.slice(previous).find(frame => frame.type === commandType)!;
          previous = socket.sent.length;
          const command = sent.payload as unknown as { commandId: string; conversationId: string; messageId: string;
            messageRevision: number; artifactId: string; offset?: number };
          assert.equal(command.conversationId, "conversation-1");
          assert.equal(command.messageId, "message-1");
          assert.equal(command.messageRevision, 2);
          assert.equal(command.artifactId, artifactId);
          assert.equal(command.offset, chunked ? offset : undefined);
          if (cancel) controller.abort();
          const accepted = ++serverSeq;
          socket.message({
            ...readyFrame,
            type: "command.accepted", serverSeq: accepted, messageId: `server-message-${accepted}`, eventId: `event-${accepted}`,
            requestId: sent.messageId,
            payload: { commandId: command.commandId, commandType, acceptedAt: now },
          });
          const sequence = ++serverSeq;
          socket.message({
            ...readyFrame,
            type: "command.completed", serverSeq: sequence, messageId: `server-message-${sequence}`, eventId: `event-${sequence}`,
            requestId: sent.messageId,
            payload: {
              commandId: command.commandId, commandType, completedAt: now,
              result: { kind: chunked ? "conversation_visualization_chunk" : "conversation_visualization", document: {
                title: "Mockup", summary: "Example", layout: "standard", interaction: "native", preferredHeight: 360,
                artifactId, sha256, sizeBytes: bytes.length, ...(chunked ? { offset } : {}),
                htmlBase64Url: bytes.toString("base64url", offset, offset + REMOTE_VISUALIZATION_CHUNK_BYTES),
              } },
            },
          });
          const acknowledged = (serverSeq: number) => socket.sent.some(frame =>
            frame.type === "stream.ack" && frame.payload?.ackServerSeq === serverSeq);
          await waitFor(() => acknowledged(sequence));
          assert.equal(acknowledged(accepted), !chunked, "the terminal chunk ACK covers the accepted event");
          if (cancel) {
            await assert.rejects(result, /visualization_cancelled/u);
            assert.ok(!socket.sent.slice(previous).some(frame => frame.type === commandType));
            break;
          }
        }
        if (cancel) return;
        return await result;
      }
      const writesBeforeRead = cacheWrites;
      const preview = await replyToRead(createHash("sha256").update(bytes).digest("hex"));
      assert.equal(preview?.html, content);
      if (chunked) assert.equal(cacheWrites, writesBeforeRead);
      assert.ok(!JSON.stringify(client.state).includes(content), "preview content stays out of the persisted state");
      await assert.rejects(replyToRead("0".repeat(64)), /integrity_mismatch/u);
      if (chunked) await replyToRead("0".repeat(64), true);
    } else {
      const before = socket.sent.length;
      await assert.rejects(client.readConversationVisualization("conversation-1", "message-1", 2, artifactId), /visualization_unavailable/u);
      assert.equal(socket.sent.length, before, "an older gateway never sees an unknown command");
    }
    const sentBeforeGap = socket.sent.length;
    const gap = serverSeq + 2;
    socket.message({
      ...readyFrame,
      messageId: "server-message-gap",
      eventId: "event-gap",
      serverSeq: gap,
    });
    await waitFor(() => socket.sent.slice(sentBeforeGap).some((frame) => frame.type === "snapshot.request"));
    assert.equal(
      socket.sent.slice(sentBeforeGap).some((frame) => frame.type === "stream.ack" && (frame.payload as { ackServerSeq: number }).ackServerSeq === gap),
      false,
    );
    client.disconnect();
});
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition_not_met");
}
