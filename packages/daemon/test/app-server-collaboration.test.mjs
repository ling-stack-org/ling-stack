import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { WebSocket } from "ws";
import { createDaemonServer } from "../dist/index.js";

test("App Server persists and replays Work Item collaboration records", { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-app-server-collaboration-"));
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
    send(1, "initialize", {
      protocolVersions: ["ling-app-server/1"],
      clientInfo: { name: "collaboration-test", version: "1" },
      requiredCapabilities: ["workItem.deliberation", "workItem.coordination"],
    });
    const initialized = await waitFor(messages, message => message.id === 1);
    assert.equal(initialized.error, undefined);
    const store = stores.get(cwd);
    assert.ok(store);
    const item = store.upsertWorkItem({ sourceType: "manual", sourceId: "collaboration-rpc", title: "Collaboration RPC" }, "2026-11-21T00:00:00.000Z");

    send(2, "workItem/deliberation/start", {
      cwd,
      workItemId: item.id,
      expectedWorkItemRevision: item.revision,
      expectedCollaborationRevision: 0,
      actorId: "lead",
      idempotencyKey: "deliberation-1",
      payload: { decisionPoint: "choose adapter", options: ["a", "b"] },
    });
    const started = await waitFor(messages, message => message.id === 2);
    assert.equal(started.result.status, "appended");
    assert.equal(started.result.record.kind, "deliberation");
    await waitFor(messages, message => message.method === "workItem/deliberation/updated");

    send(3, "workItem/deliberation/start", {
      cwd,
      workItemId: item.id,
      expectedWorkItemRevision: 999,
      expectedCollaborationRevision: 999,
      actorId: "lead",
      idempotencyKey: "deliberation-1",
      payload: { decisionPoint: "choose adapter", options: ["a", "b"] },
    });
    const replayed = await waitFor(messages, message => message.id === 3);
    assert.equal(replayed.result.status, "replayed");
    assert.equal(replayed.result.record.id, started.result.record.id);

    send(4, "workItem/question/ask", {
      cwd,
      workItemId: item.id,
      actorId: "worker",
      idempotencyKey: "question-1",
      payload: { text: "Which adapter should I use?", blocking: true },
    });
    const question = await waitFor(messages, message => message.id === 4);
    assert.equal(question.result.record.kind, "question");

    send(5, "workItem/deliberation/read", { cwd, workItemId: item.id });
    const read = await waitFor(messages, message => message.id === 5);
    assert.equal(read.result.records.length, 1);
    assert.equal(read.result.records[0].recordId, undefined);
    assert.equal(read.result.records[0].action, "started");
  } finally {
    socket.terminate();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function waitFor(messages, predicate) {
  const existing = messages.find(predicate);
  if (existing) return existing;
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
