import assert from "node:assert/strict";
import test from "node:test";
import { LingAppServerClient, type LingAppServerSocket } from "../dist/app-server.js";

class FakeSocket implements LingAppServerSocket {
  readonly readyState = 1;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly sent: Array<{ readonly id: number; readonly method: string; readonly params?: Record<string, unknown> }> = [];
  enableSubscriptionResponses = false;
  subscriptionWatermark?: string;

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
          result: { disposition: "complete", subscriptionId: "sub_fixture", cursor: this.subscriptionWatermark ?? request.params?.cursor ?? "0" },
        }));
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
  const client = new LingAppServerClient({
    url: "ws://fixture/app-server/rpc",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    clientInfo: { name: "fixture-client", version: "1" },
    requiredCapabilities: ["workItem.read"],
    reconnectDelayMs: 1,
    maxReconnectDelayMs: 5,
  });

  await client.connect();
  const first = sockets[0]!;
  first.enableSubscriptionResponses = true;
  first.subscriptionWatermark = "5";
  const initial = await client.subscribe({ workItemId: "item", cursor: "1" });
  assert.equal(initial.subscriptionId, "sub_fixture");
  assert.equal(initial.cursor, "5");
  first.emit("message", JSON.stringify({ jsonrpc: "2.0", method: "$/control_plane_event", params: { subscriptionId: "sub_fixture", event: { seq: 2 } } }));
  first.emit("message", JSON.stringify({ jsonrpc: "2.0", method: "workItem/status/changed", params: { subscriptionId: "sub_fixture", cursor: "1" } }));
  first.emit("close", {});

  await waitForCondition(() => sockets.length === 2 && sockets[1]!.sent.some((request) => request.method === "workItem/subscribe"));
  const replay = sockets[1]!.sent.find((request) => request.method === "workItem/subscribe");
  assert.equal(replay?.params?.cursor, "2");
  client.close();
});

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for reconnect");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
