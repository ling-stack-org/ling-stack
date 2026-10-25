import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { handleTeammateDirectMessagesCollection, handleTeammateDirectMessageStream } from "../dist/features/teammates/direct-messages.js";

const teammateId = "teammate_builtin_engineer";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-direct-submit-http-"));
  const f = { cwd, store: createSqliteRunStore(cwd), calls: 0 };
  const config = { host: "127.0.0.1", port: 0, maxBodyBytes: 1024 * 1024 };
  const registry = { getStore: path => { assert.equal(path, cwd); return f.store; } };
  const reply = async input => {
    f.calls++;
    const message = input.store.createTeammateDirectMessage({ id: input.replyMessageId,
      threadId: input.thread.id, teammateId, authorType: "ai-teammate", authorId: teammateId,
      body: "Controlled reply", status: "ready" }, new Date().toISOString());
    input.stream?.onReady(message); input.stream?.onDone(message);
    return message;
  };
  const server = createServer((req, res) => {
    void (req.url.startsWith("/stream") ? handleTeammateDirectMessageStream : handleTeammateDirectMessagesCollection)(req, res, config, registry, teammateId, reply);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  f.url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  f.submit = (body, stream = false) => fetch(`${f.url}/${stream ? "stream" : "messages"}?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  f.receipt = key => fetch(`${f.url}/messages?cwd=${encodeURIComponent(cwd)}&idempotencyKey=${encodeURIComponent(key)}`).then(r => r.json());
  return f;
}

test("private HTTP receipt is read-only before submit; keyed stream and POST replay never repeat dispatch", async t => {
  const f = await fixture(t);
  assert.equal((await f.receipt("http-one")).status, "unknown");
  assert.equal(f.store.listTeammateDirectThreads().length, 0);
  const body = { body: "Private test", requestAiReply: true, idempotencyKey: "http-one", permissionPreset: "workspace_collaboration" };
  const response = await f.submit(body, true);
  const events = await response.text();
  assert.match(events, /event: accepted/);
  assert.match(events, /event: done/);
  const receipt = await f.receipt("http-one");
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.message.body, body.body);
  assert.equal(receipt.aiReply.body, "Controlled reply");
  const replay = await f.submit(body);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).message.id, receipt.message.id);
  assert.equal(f.calls, 1);
  assert.equal(f.store.listTeammateDirectMessages({ teammateId }).length, 2);
});

test("private HTTP rejects content/permission drift, validates keys and supports legacy clients", async t => {
  const f = await fixture(t);
  const body = { body: "Do not change permissions", requestAiReply: true, idempotencyKey: "scoped", permissionPreset: "read_only" };
  assert.equal((await f.submit(body)).status, 201);
  for (const drift of [{ body: "Different" }, { permissionPreset: "full_access" }, { providerPresetId: "another" }, { requestAiReply: false }]) {
    const response = await f.submit({ ...body, ...drift });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "private_submission_conflict");
  }
  for (const key of ["", "x".repeat(201), "line\nbreak"]) assert.equal((await f.submit({ ...body, idempotencyKey: key })).status, 400);
  assert.equal(f.calls, 1);
  for (let i = 0; i < 2; i++) assert.equal((await f.submit({ body: "Legacy", requestAiReply: true })).status, 201);
  assert.equal(f.calls, 3);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  const receipt = await f.receipt("scoped");
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.aiReply.body, "Controlled reply");
  await Promise.all([f.submit(body, true), f.submit(body, true)].map(async r => (await r).text()));
  assert.equal(f.calls, 3);
});

for (const stream of [false, true]) {
  test(`private ${stream ? "SSE" : "POST"} admits inferred paths and preserves their origin across reload`, async t => {
    const f = await fixture(t);
    const fileRefs = [{ path: "../records.csv", source: "inferred_text" },
      { path: "/outside/private.txt", source: "inferred_text" }];
    const body = { body: "只解释这些路径，不读取文件", fileRefs, requestAiReply: true,
      idempotencyKey: `lexical-${stream}`, permissionPreset: "read_only" };
    const response = await f.submit(body, stream);
    assert.equal(response.status, stream ? 200 : 201, await response.clone().text());
    if (stream) assert.match(await response.text(), /event: done/);
    f.store.close(); f.store = createSqliteRunStore(f.cwd);
    const receipt = await f.receipt(body.idempotencyKey);
    assert.equal(receipt.status, "accepted");
    assert.deepEqual(receipt.message.fileRefs, fileRefs);
    assert.equal(f.calls, 1);
    const denied = await f.submit({ ...body, idempotencyKey: `explicit-${stream}`,
      fileRefs: [{ path: "/outside/private.txt", source: "explicit_text" }] }, stream);
    assert.equal(denied.status, 400);
    assert.equal(f.calls, 1);
  });
}
