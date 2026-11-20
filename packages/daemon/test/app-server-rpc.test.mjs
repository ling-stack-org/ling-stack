import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { WebSocket } from "ws";
import { createDaemonServer } from "../dist/index.js";

test("App Server WebSocket negotiates the Ling protocol and supports ping", { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-app-server-rpc-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/app-server/rpc?cwd=${encodeURIComponent(cwd)}`);
  const messages = [];
  socket.on("message", data => messages.push(JSON.parse(String(data))));
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersions: ["ling-app-server/1"],
        requiredCapabilities: ["workItem.control"],
      },
    }));
    const initialized = await waitFor(messages, message => message.id === 1);
    assert.equal(initialized.result.protocolVersion, "ling-app-server/1");
    assert.equal(initialized.result.serverInfo.name, "ling-stack-daemon");
    assert.equal(typeof initialized.result.connectionId, "string");
    assert.ok(initialized.result.capabilities.includes("workItem.control"));

    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "server/ping", params: {} }));
    const ping = await waitFor(messages, message => message.id === 2);
    assert.equal(ping.result.ok, true);
    assert.equal(ping.result.connectionId, initialized.result.connectionId);
    assert.equal(typeof ping.result.serverTime, "string");
  } finally {
    socket.terminate();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("App Server rejects unsupported protocol versions before serving methods", { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-app-server-rpc-version-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/app-server/rpc?cwd=${encodeURIComponent(cwd)}`);
  const messages = [];
  socket.on("message", data => messages.push(JSON.parse(String(data))));
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersions: ["ling-app-server/99"] } }));
    const response = await waitFor(messages, message => message.id === 1);
    assert.equal(response.error.data.code, "protocol_version_unsupported");
    assert.equal(response.error.code, -32010);
  } finally {
    socket.terminate();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("App Server lists, reads, and controls a Work Item with revision and idempotency guards", { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-app-server-work-item-"));
  const stores = new Map();
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    storeFactory(workspaceCwd) {
      const store = createSqliteRunStore(workspaceCwd);
      stores.set(workspaceCwd, store);
      return store;
    },
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/app-server/rpc?cwd=${encodeURIComponent(cwd)}`);
  const messages = [];
  socket.on("message", data => messages.push(JSON.parse(String(data))));
  const send = (id, method, params) => socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  try {
    await once(socket, "open");
    send(1, "initialize", { protocolVersions: ["ling-app-server/1"], clientInfo: { name: "test", version: "1" } });
    await waitFor(messages, message => message.id === 1);
    send(2, "workItem/list", { cwd });
    const empty = await waitFor(messages, message => message.id === 2);
    assert.deepEqual(empty.result.workItems, []);
    const store = stores.get(cwd);
    assert.ok(store);
    const item = store.upsertWorkItem({ sourceType: "manual", sourceId: "app-server-test", title: "App Server item" }, "2026-11-21T00:00:00.000Z");

    send(3, "workItem/list", { cwd });
    const listed = await waitFor(messages, message => message.id === 3);
    assert.equal(listed.result.workItems[0].workItemId, item.id);
    assert.equal(listed.result.workItems[0].revision, String(item.revision));

    send(4, "workItem/read", { cwd, workItemId: item.id });
    const read = await waitFor(messages, message => message.id === 4);
    assert.equal(read.result.workItem.control.state, "active");

    send(5, "workItem/pause", {
      cwd,
      workItemId: item.id,
      expectedWorkItemRevision: item.revision,
      expectedControlGeneration: 0,
      actorId: "user:test",
      idempotencyKey: "pause-1",
      reason: "test pause",
    });
    const paused = await waitFor(messages, message => message.id === 5);
    assert.equal(paused.result.workItem.control.state, "paused");
    assert.equal(paused.result.workItem.control.generation, "1");

    send(6, "workItem/pause", {
      cwd,
      workItemId: item.id,
      expectedWorkItemRevision: item.revision,
      expectedControlGeneration: 0,
      actorId: "user:test",
      idempotencyKey: "pause-1",
      reason: "test pause",
    });
    const replayed = await waitFor(messages, message => message.id === 6);
    assert.equal(replayed.result.workItem.control.receipt.idempotencyKey, undefined);
    assert.equal(replayed.result.workItem.control.state, "paused");

    send(7, "workItem/resume", {
      cwd,
      workItemId: item.id,
      expectedWorkItemRevision: Number(paused.result.workItem.revision),
      expectedControlGeneration: 1,
      actorId: "user:test",
      idempotencyKey: "resume-1",
    });
    const resumed = await waitFor(messages, message => message.id === 7);
    assert.equal(resumed.result.workItem.control.state, "active");

    send(8, "workItem/cancel", {
      cwd,
      workItemId: item.id,
      expectedWorkItemRevision: Number(resumed.result.workItem.revision),
      expectedControlGeneration: 2,
      actorId: "user:test",
      idempotencyKey: "cancel-1",
    });
    const cancelled = await waitFor(messages, message => message.id === 8);
    assert.equal(cancelled.result.workItem.control.state, "cancelled");
  } finally {
    socket.terminate();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function waitFor(messages, predicate) {
  for (const message of messages) {
    if (predicate(message)) return message;
  }
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Timed out waiting for App Server response")), 2_000);
    const timer = setInterval(() => {
      const message = messages.find(predicate);
      if (message) {
        clearTimeout(deadline);
        clearInterval(timer);
        resolve(message);
      }
    }, 10);
  });
}
