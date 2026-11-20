import assert from "node:assert/strict";
import test from "node:test";
import { LingAppServerClient, type LingAppServerSocket } from "../src/app-server.ts";

class FakeSocket implements LingAppServerSocket {
  readonly readyState = 1;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly sent: unknown[] = [];

  send(data: string): void {
    const request = JSON.parse(data) as { readonly id: number; readonly method: string };
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
            workspaceId: "workspace",
            workItemId: "item",
            revision: 2,
            status: "running",
            control: { state: "active", generation: 0, unresolvedEffectIds: [] },
            holds: [],
            currentExecutionRefs: [],
          },
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
  assert.equal(snapshot.revision, 2);

  const notifications: string[] = [];
  client.onNotification((notification) => notifications.push(notification.method));
  socket.emit("message", JSON.stringify({ jsonrpc: "2.0", method: "workItem/control/updated", params: { workItemId: "item" } }));
  assert.deepEqual(notifications, ["workItem/control/updated"]);
  client.close();
});
