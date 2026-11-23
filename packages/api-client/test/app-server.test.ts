import assert from "node:assert/strict";
import test from "node:test";
import { LingAppServerClient, type LingAppServerSocket } from "../dist/app-server.js";

class FakeSocket implements LingAppServerSocket {
  readonly readyState = 1;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly sent: Array<{ readonly id: number; readonly method: string; readonly params?: Record<string, unknown> }> = [];
  enableSubscriptionResponses = false;
  subscriptionWatermark?: string;
  subscriptionWindow?: { readonly requestedAfterSeq: number; readonly nextAfterSeq: number };
  subscriptionId = "sub_fixture";
  serverInstanceId?: string;
  replayEvents: readonly { readonly cursor: string; readonly seq?: number }[] = [];

  send(data: string): void {
    const request = JSON.parse(data) as { readonly id: number; readonly method: string; readonly params?: Record<string, unknown> };
    this.sent.push(request);
    queueMicrotask(() => {
      if (request.method === "initialize") {
        this.emit("message", JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: "ling-app-server/1",
            serverInfo: { name: "fixture", version: "1" },
            connectionId: "conn_fixture",
            serverInstanceId: this.serverInstanceId,
            effectiveScopes: ["workItem.read", "workItem.control"],
            capabilities: ["workItem.read", "workItem.control"],
            limits: { maxInboundFrameBytes: 1024, maxOutboundFrameBytes: 1024 },
          },
        }));
      } else if (request.method === "server/ping") {
        this.emit("message", JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { ok: true, connectionId: "conn_fixture", serverTime: "2026-11-21T00:00:00.000Z" },
        }));
      } else if (request.method === "workItem/read") {
        this.emit("message", JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            cwd: "/fixture",
            workItem: {
              workspaceId: "workspace",
              workItemId: "item",
              revision: "2",
              status: "running",
              control: { state: "active", generation: "0", unresolvedEffectIds: [] },
              holds: [],
              currentExecutionRefs: [],
            },
          },
        }));
      } else if (request.method === "workItem/subscribe" && this.enableSubscriptionResponses) {
        this.emit("message", JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { disposition: "complete", subscriptionId: this.subscriptionId,
            cursor: this.subscriptionWatermark ?? request.params?.cursor ?? "0", window: this.subscriptionWindow },
        }));
        for (const { cursor, seq } of this.replayEvents) {
          this.emit("message", JSON.stringify({
            jsonrpc: "2.0",
            method: "workItem/status/changed",
            params: { subscriptionId: this.subscriptionId, cursor, event: seq === undefined ? undefined : { seq } },
          }));
        }
      } else {
        this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));
      }
    });
  }

  close(): void {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

test("Ling App Server client negotiates, pings, reads and receives notifications", async () => {
  const socket = new FakeSocket();
  const client = new LingAppServerClient({
    url: "ws://fixture/app-server/rpc",
    createSocket: () => socket,
    clientInfo: { name: "fixture-client", version: "1" },
    requiredCapabilities: ["workItem.read"],
  });

  const initialized = await client.connect();
  assert.equal(initialized.connectionId, "conn_fixture");
  assert.deepEqual(await client.ping(), { ok: true, connectionId: "conn_fixture", serverTime: "2026-11-21T00:00:00.000Z" });
  const snapshot = await client.readWorkItem("workspace", "item");
  assert.equal(snapshot.revision, "2");

  const notifications: string[] = [];
  client.onNotification((notification) => notifications.push(notification.method));
  socket.emit("message", JSON.stringify({ jsonrpc: "2.0", method: "workItem/control/updated", params: { workItemId: "item" } }));
  assert.deepEqual(notifications, ["workItem/control/updated"]);
  client.close();
});

test("Ling App Server client reconnects and resumes subscriptions from the latest cursor", async () => {
  const sockets: FakeSocket[] = [];
  const restartNotices: unknown[] = [];
  const client = new LingAppServerClient({
    url: "ws://fixture/app-server/rpc",
    createSocket: () => {
      const socket = new FakeSocket();
      socket.serverInstanceId = sockets.length < 2 ? "daemon-1" : "daemon-2";
      if (sockets.length > 0) {
        socket.enableSubscriptionResponses = true;
        socket.subscriptionId = "sub_reconnected";
        socket.replayEvents = [{ cursor: "scoped-cursor-at-6", seq: 6 }];
      }
      sockets.push(socket);
      return socket;
    },
    clientInfo: { name: "fixture-client", version: "1" },
    requiredCapabilities: ["workItem.read"],
    reconnectDelayMs: 1,
    maxReconnectDelayMs: 5,
  });
  client.onNotification(notice => { if (notice.method === "server/restarted") restartNotices.push(notice.params); });

  await client.connect();
  const first = sockets[0]!;
  first.enableSubscriptionResponses = true;
  first.subscriptionWatermark = "5";
  first.subscriptionWindow = { requestedAfterSeq: 1, nextAfterSeq: 5 };
  first.replayEvents = [{ cursor: "3" }];
  const initial = await client.subscribe({ workItemId: "item", cursor: "1" });
  assert.equal(initial.subscriptionId, "sub_fixture");
  assert.equal(initial.cursor, "5");
  first.emit("message", JSON.stringify({ jsonrpc: "2.0", method: "$/control_plane_event", params: { subscriptionId: "sub_fixture", event: { seq: 2 } } }));
  first.emit("message", JSON.stringify({ jsonrpc: "2.0", method: "workItem/status/changed", params: { subscriptionId: "sub_fixture", cursor: "1" } }));
  first.emit("close", {});

  await waitForCondition(() => sockets.length === 2 && sockets[1]!.sent.some((request) => request.method === "workItem/subscribe"));
  const replay = sockets[1]!.sent.find((request) => request.method === "workItem/subscribe");
  assert.equal(replay?.params?.cursor, "3");
  assert.deepEqual(restartNotices, []);
  await client.connect();
  sockets[1]!.emit("message", JSON.stringify({
    jsonrpc: "2.0", method: "workItem/replay/ready",
    params: { subscriptionId: "sub_reconnected", cursor: "scoped-cursor-at-5", window: { nextAfterSeq: 5 } },
  }));
  sockets[1]!.emit("close", {});
  await waitForCondition(() => sockets.length === 3 && sockets[2]!.sent.some((request) => request.method === "workItem/subscribe"));
  assert.deepEqual(restartNotices, [{ previousServerInstanceId: "daemon-1", serverInstanceId: "daemon-2" }]);
  assert.equal(sockets[2]!.sent.find((request) => request.method === "workItem/subscribe")?.params?.cursor, "scoped-cursor-at-6");
  client.close();
});

test("Ling App Server stops reconnecting with a revoked grant and exposes the authorization state", async () => {
  const sockets: FakeSocket[] = [];
  const client = new LingAppServerClient({
    url: "wss://fixture/app-server/rpc",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    clientInfo: { name: "fixture-client", version: "1" },
    reconnectDelayMs: 10,
  });
  const states: string[] = [];
  client.onConnectionState(({ state }) => states.push(state));
  await client.connect();
  sockets[0]?.emit("close", { code: 1008, reason: "authorization_changed" });
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.deepEqual(states, ["connecting", "connected", "authorization_required"]);
  assert.equal(sockets.length, 1);
  await client.connect();
  assert.equal(sockets.length, 2);
  client.close();
});

test("Ling App Server client routes the development, delivery, grant, worktree and coordination methods", async () => {
  const socket = new FakeSocket();
  const client = new LingAppServerClient({
    url: "ws://fixture/app-server/rpc",
    createSocket: () => socket,
    clientInfo: { name: "fixture-client", version: "1" },
  });
  await client.connect();
  await client.createGrant({ label: "fixture", subject: { kind: "workspace" }, scopes: ["observe"],
    expiresAt: "2099-01-01T00:00:00.000Z", credentialSha256: "0".repeat(64), idempotencyKey: "grant-1" });
  await client.listGrants();
  await client.revokeGrant("grant-1", 1);
  await client.createHandoff({ threadId: "thread", turnId: "turn", idempotencyKey: "handoff-1", nextInstruction: "continue" });
  await client.readHandoff({ handoffId: "handoff" });
  await client.resumeHandoff({ handoffId: "handoff", providerPresetId: "provider" });
  await client.readGitHubSubject({ repository: "ling-stack-org/ling-stack", kind: "issue", number: 1 });
  await client.reconcileGitHubDelivery({ workItemId: "item", threadId: "thread", expectedWorkItemRevision: 1,
    candidateDigest: "candidate", repository: "ling-stack-org/ling-stack", pullRequestNumber: 1 });
  await client.readGitHubDelivery({ workItemId: "item" });
  await client.readGitHubDelivery({ workItemId: "item", deliveryId: "delivery" });
  await client.readCoordinationSchedule({ automationId: "automation", workItemId: "item" });
  await client.setCoordinationSchedule({ automationId: "automation", workItemId: "item", expectedRevision: 0,
    enabled: true, kind: "checkpoint", durationMs: 1000 });
  await client.createWorkItem({ sourceId: "source", title: "Fixture" });
  await client.acceptWorkItem({ workItemId: "item", expectedWorkItemRevision: 1, idempotencyKey: "accept" });
  await client.captureChanges();
  await client.listWorktrees();
  await client.createWorktree({ ownerKind: "teammate", ownerId: "thread" });
  await client.refreshWorktree({ ownerKind: "teammate", ownerId: "thread" });
  await client.previewWorktreeCleanup({ ownerKind: "teammate", ownerId: "thread" });
  await client.cleanupWorktree({ ownerKind: "teammate", ownerId: "thread", expectedRevision: "revision", confirmed: true });
  assert.deepEqual(socket.sent.filter(request => request.id !== undefined).slice(1).map(request => request.method), [
    "server/grants/create", "server/grants/list", "server/grants/revoke", "handoff/create", "handoff/read", "handoff/resume",
    "github/subject/read", "github/delivery/reconcile", "workItem/delivery/read", "delivery/read",
    "workItem/coordination/schedule/read", "workItem/coordination/schedule/set", "workItem/create", "workItem/accept",
    "changes/capture", "worktree/list", "worktree/create", "worktree/refresh", "worktree/cleanup/preview", "worktree/cleanup",
  ]);
  client.close();
});

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for reconnect");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
