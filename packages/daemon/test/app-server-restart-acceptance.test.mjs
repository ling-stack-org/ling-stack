import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createDaemonServer } from "../dist/index.js";

test("App Server restores Work Item, collaboration and cursor replay after daemon restart", { timeout: 20_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-app-server-restart-"));
  let daemon;
  let socket;
  try {
    daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
    await daemon.start();
    const first = await openClient(daemon, cwd);
    socket = first.socket;
    first.send(1, "initialize", { protocolVersions: ["ling-app-server/1"], requiredCapabilities: ["workItem.coordination"] });
    await waitFor(first.messages, message => message.id === 1);
    const workItemId = "pending";
    first.send(2, "workItem/subscribe", { cwd, workItemId });
    const initialSubscription = await waitFor(first.messages, message => message.id === 2);
    assert.equal(initialSubscription.result.disposition, "complete");
    const initialCursor = initialSubscription.result.cursor;

    first.send(3, "workItem/create", { cwd, workItemId, sourceType: "manual", sourceId: "restart-acceptance", title: "Restart acceptance" });
    const created = await waitFor(first.messages, message => message.id === 3);
    assert.equal(created.result.workItem.workItemId, workItemId);
    first.send(4, "workItem/subscribe", { cwd, workItemId, cursor: initialCursor });
    const itemSubscription = await waitFor(first.messages, message => message.id === 4);
    assert.equal(itemSubscription.result.disposition, "complete");
    const replayCursor = itemSubscription.result.cursor;
    first.send(5, "workItem/collaboration/append", {
      cwd,
      workItemId,
      kind: "message",
      action: "created",
      actorId: "agent:restart",
      payload: { text: "persisted before restart" },
      idempotencyKey: "restart-collaboration-1",
      expectedWorkItemRevision: Number(created.result.workItem.revision),
      expectedCollaborationRevision: 0,
    });
    const appended = await waitFor(first.messages, message => message.id === 5);
    assert.equal(appended.result.record.payload.text, "persisted before restart");
    await closeDaemon(daemon, socket);
    daemon = undefined;
    socket = undefined;

    daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
    await daemon.start();
    const second = await openClient(daemon, cwd);
    socket = second.socket;
    second.send(10, "initialize", { protocolVersions: ["ling-app-server/1"], requiredCapabilities: ["workItem.coordination"] });
    await waitFor(second.messages, message => message.id === 10);
    second.send(11, "workItem/read", { cwd, workItemId });
    const read = await waitFor(second.messages, message => message.id === 11);
    assert.equal(read.result.workItem.workItemId, workItemId);
    second.send(12, "workItem/collaboration/read", { cwd, workItemId, kind: "message" });
    const collaboration = await waitFor(second.messages, message => message.id === 12);
    assert.equal(collaboration.result.records.length, 1);
    assert.equal(collaboration.result.records[0].payload.text, "persisted before restart");

    second.send(13, "workItem/subscribe", { cwd, workItemId, cursor: replayCursor });
    const resumed = await waitFor(second.messages, message => message.id === 13);
    assert.equal(resumed.result.disposition, "complete");
    const replay = await waitFor(second.messages, message => message.method === "workItem/collaboration/updated" && message.params?.payload?.workItemId === workItemId);
    assert.equal(replay.params.payload.collaborationId, appended.result.record.id);
  } finally {
    if (socket) socket.terminate();
    if (daemon) await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("App Server rejects an unavailable required capability", { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-app-server-capability-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
  await daemon.start();
  const { socket, messages, send } = await openClient(daemon, cwd);
  try {
    send(1, "initialize", { protocolVersions: ["ling-app-server/1"], requiredCapabilities: ["unknown.capability"] });
    const response = await waitFor(messages, message => message.id === 1);
    assert.equal(response.error.data.code, "required_capability_unavailable");
    assert.equal(response.error.code, -32011);
  } finally {
    socket.terminate();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function openClient(daemon, cwd) {
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/app-server/rpc?cwd=${encodeURIComponent(cwd)}`);
  const messages = [];
  socket.on("message", data => messages.push(JSON.parse(String(data))));
  await once(socket, "open");
  return { socket, messages, send: (id, method, params) => socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })) };
}

async function closeDaemon(daemon, socket) {
  socket.terminate();
  await daemon.stop();
}

async function waitFor(messages, predicate, label = "response") {
  const existing = messages.find(predicate);
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Timed out waiting for App Server response")), 5_000);
    const timer = setInterval(() => {
      const message = messages.find(predicate);
      if (!message) return;
      clearTimeout(deadline);
      clearInterval(timer);
      resolve(message);
    }, 10);
  });
}
