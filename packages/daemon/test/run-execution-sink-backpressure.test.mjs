import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as requestHttp } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { createSseRunExecutionSink, executeRunRequest } from "../dist/features/runs/orchestrator.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { resolveConfig } from "../dist/config.js";
import { handleConversationStream } from "../dist/features/conversations/routes.js";
import { SSE_STREAM_BLOCKED_TIMEOUT_MS, SSE_STREAM_CLOSE_GRACE_MS,
  SSE_STREAM_MAX_FRAME_BYTES, SSE_STREAM_MAX_PENDING_FRAMES } from "../dist/shared/sse-stream-writer.js";

/** Node accepts the false-returning write; producers must wait for drain after it. */
class Response extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  writableFinished = false;
  destroyed = false;
  writableLength = 0;
  statusCode = undefined;
  headers = {};
  writes = [];
  blocked = false;
  writesWhileBlocked = 0;
  constructor(blockFirstWrite = true) { super(); this.blockFirstWrite = blockFirstWrite; }
  setHeader(name, value) { this.headers[name] = value; }
  writeHead(statusCode, headers = {}) {
    assert.equal(this.headersSent, false);
    this.statusCode = statusCode; Object.assign(this.headers, headers); this.headersSent = true;
  }
  write(chunk) {
    assert.equal(this.writableEnded || this.destroyed, false);
    if (this.blocked) this.writesWhileBlocked++;
    this.writes.push(String(chunk));
    this.writableLength += Buffer.byteLength(String(chunk));
    if (this.blockFirstWrite && this.writes.length === 1) this.blocked = true;
    return !this.blocked;
  }
  end(chunk = "") { this.body = chunk; this.writableEnded = true; }
  destroy() { this.destroyed = true; this.emit("close"); }
  drain() { this.blocked = false; this.writableLength = 0; this.emit("drain"); }
}

function fixture(t, blockFirstWrite = true) {
  const response = new Response(blockFirstWrite);
  const sink = createSseRunExecutionSink(response);
  t.after(() => { response.destroy(); response.emit("finish"); });
  return { sink, response };
}

test("Run SSE header comment, ready and events share backpressure and finish in FIFO order", t => {
  const { sink, response } = fixture(t);
  let closed = 0;
  sink.onClose(() => closed++);
  sink.writeReady({ runId: "owned-run" });
  sink.writeEvent("message_delta", { text: "中文\nkeeps exact framing" });
  sink.writeEvent("result", { status: "succeeded" });
  sink.end();
  assert.deepEqual(response.writes, [": ling-stack run stream\n\n"]);
  assert.equal(response.writesWhileBlocked, 0);
  assert.equal(response.writableEnded, false, "finish must retain queued complete frames until drain");
  response.drain();
  assert.deepEqual(response.writes, [
    ": ling-stack run stream\n\n",
    'event: ready\ndata: {"runId":"owned-run"}\n\n',
    'event: message_delta\ndata: {"text":"中文\\nkeeps exact framing"}\n\n',
    'event: result\ndata: {"status":"succeeded"}\n\n',
  ]);
  assert.equal(response.headers["Content-Type"], "text/event-stream; charset=utf-8");
  assert.equal(response.writableEnded, true);
  assert.equal(sink.isClosed(), true);
  assert.equal(closed, 1);
  sink.end(); response.destroy();
  assert.equal(closed, 1);
});

test("Run SSE pre-header failure stays JSON while started errors queue behind ready", t => {
  const early = fixture(t);
  early.sink.writeError(409, { error: "input_conflict" });
  early.sink.end();
  assert.equal(early.response.statusCode, 409);
  assert.equal(early.response.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(early.response.body, '{"error":"input_conflict"}\n');
  assert.deepEqual(early.response.writes, []);

  const started = fixture(t);
  started.sink.writeReady({ runId: "run" });
  started.sink.writeError(500, { error: "failed" });
  started.sink.end();
  assert.equal(started.response.statusCode, 200);
  assert.deepEqual(started.response.writes, [": ling-stack run stream\n\n"]);
  started.response.drain();
  assert.deepEqual(started.response.writes.slice(1), [
    'event: ready\ndata: {"runId":"run"}\n\n', 'event: error\ndata: {"error":"failed"}\n\n',
  ]);
});

test("Run SSE overflow closes only the observer and refuses later writes", t => {
  const { sink, response } = fixture(t);
  let closed = 0;
  sink.onClose(() => closed++);
  sink.writeReady({ runId: "owned-run" });
  for (let seq = 1; seq <= SSE_STREAM_MAX_PENDING_FRAMES; seq++) sink.writeEvent("message_delta", { seq });
  assert.equal(sink.isClosed(), true);
  assert.equal(response.writableEnded, true);
  assert.equal(closed, 1);
  const before = response.writes.length;
  for (let seq = 0; seq < 10; seq++) sink.writeEvent("late", { seq });
  sink.writeReady({ runId: "late" });
  assert.equal(response.writes.length, before);
  assert.equal(response.writesWhileBlocked, 0);
  let lateClosed = 0;
  sink.onClose(() => lateClosed++);
  assert.equal(lateClosed, 1, "late observers must see an already closed sink");
});

test("Run SSE rejects oversized frames and a permanently slow response has a bounded close", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const large = fixture(t, false);
  large.sink.writeEvent("message_delta", { text: "x".repeat(SSE_STREAM_MAX_FRAME_BYTES) });
  assert.equal(large.sink.isClosed(), true);
  assert.deepEqual(large.response.writes, [": ling-stack run stream\n\n"]);

  const slow = fixture(t);
  slow.sink.writeReady({ runId: "owned-run" });
  slow.sink.end();
  t.mock.timers.tick(SSE_STREAM_BLOCKED_TIMEOUT_MS - 1);
  assert.equal(slow.response.writableEnded, false);
  t.mock.timers.tick(1);
  assert.equal(slow.sink.isClosed(), true);
  assert.equal(slow.response.writableEnded, true);
  t.mock.timers.tick(SSE_STREAM_CLOSE_GRACE_MS);
  assert.equal(slow.response.destroyed, true);
  assert.equal(slow.response.writesWhileBlocked, 0);
});

test("closing a Run SSE observer preserves durable events for subsequent history reads", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-run-sse-history-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = "2026-10-29T00:00:00.000Z";
  const run = store.createRun({ id: "run-sse-history", cwd, taskId: "task-sse-history",
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  const { sink, response } = fixture(t);
  let observing = true;
  sink.onClose(() => { observing = false; });
  sink.writeReady({ runId: run.id });
  for (let seq = 0; seq < SSE_STREAM_MAX_PENDING_FRAMES + 3; seq++) {
    const event = store.appendEvent(run.id, "assistant_text_delta", { text: `part-${seq}` });
    if (observing) sink.writeEvent(event.type, event);
  }
  assert.equal(observing, false);
  assert.equal(response.writesWhileBlocked, 0);
  const persisted = store.listEvents(run.id, { limit: SSE_STREAM_MAX_PENDING_FRAMES + 3 });
  assert.equal(persisted.length, SSE_STREAM_MAX_PENDING_FRAMES + 3);
  assert.equal(new Set(persisted.map(event => event.seq)).size, persisted.length);
  assert.equal(persisted.at(-1).data.text, `part-${SSE_STREAM_MAX_PENDING_FRAMES + 2}`);
  assert.equal(store.getRun(run.id).status, run.status, "transport closure must not change execution state");
});

test("normal conversation failures keep pre-header JSON and post-header SSE without rewriting headers", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-conversation-sse-error-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = "2026-10-29T00:00:00.000Z";
  const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "SSE errors", objective: "Errors" }, now);
  const runners = createRunnerRegistry([{ id: "pi", displayName: "No-network fixture", status: "enabled", adapter: {} }]);
  const dispatch = async (body, response, startRun) => {
    const request = Readable.from([JSON.stringify(body)]);
    Object.assign(request, { method: "POST", url: `/conversations/stream?cwd=${encodeURIComponent(cwd)}`, headers: { host: "fixture" } });
    await handleConversationStream(request, response, { host: "fixture", port: 1, maxBodyBytes: 100_000 },
      { getStore: () => store }, runners, startRun);
  };
  const early = new Response();
  await dispatch({ message: null }, early, () => assert.fail("invalid input cannot dispatch"));
  assert.equal(early.statusCode, 400);
  assert.equal(early.headers["Content-Type"], "application/json; charset=utf-8");
  assert.match(early.body, /bad_request/u);
  assert.deepEqual(early.writes, []);

  const late = new Response();
  t.after(() => { late.destroy(); late.emit("finish"); });
  await dispatch({ threadId: thread.id, message: "Accepted once", providerPresetId: "fixture", idempotencyKey: "late-error" },
    late, async () => { throw new Error("controlled post-header failure"); });
  assert.equal(late.statusCode, 200);
  assert.equal(late.headers["Content-Type"], "text/event-stream; charset=utf-8");
  assert.deepEqual(late.writes, [": ling-stack run stream\n\n"]);
  assert.equal(late.writableEnded, false);
  late.drain();
  assert.equal(late.writes.length, 3);
  assert.match(late.writes[1], /^event: ready\n/u);
  assert.match(late.writes[2], /^event: error\n/u);
  assert.match(late.writes[2], /controlled post-header failure/u);
  assert.equal(late.writesWhileBlocked, 0);
  assert.equal(late.writableEnded, true);
  assert.equal(store.listLingTurns({ threadId: thread.id }).length, 1, "transport error cannot accept the input twice");
});

for (const mode of ["slow-reader", "disconnect"]) {
  test(`real HTTP ${mode} closes observation while the Host persists and settles its original Run once`, async t => {
    const cwd = await mkdtemp(join(tmpdir(), "ling-run-sse-http-"));
    const stores = new RunStoreRegistry(createSqliteRunStore);
    const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }));
    const activeRuns = new ActiveRunRegistry();
    const observed = { calls: 0, writesAfterClose: 0, falseWrites: 0, closed: false };
    let releaseRunner, observeClose, completeDispatch;
    const release = new Promise(resolve => { releaseRunner = resolve; });
    const transportClosed = new Promise(resolve => { observeClose = resolve; });
    const dispatchDone = new Promise(resolve => { completeDispatch = resolve; });
    const deltaCount = mode === "slow-reader" ? SSE_STREAM_MAX_PENDING_FRAMES + 100 : 1;
    const text = "x".repeat(2048);
    const runners = createRunnerRegistry([{ id: "sse_fixture", aliases: ["pi"], displayName: "No-network fixture", status: "enabled",
      adapter: { async runTask(options) {
        observed.calls++;
        observed.runId = options.runId;
        observed.signal = options.signal;
        for (let index = 0; index < deltaCount; index++) options.onEvent({ type: "assistant_text_delta", text });
        await release;
        options.signal.throwIfAborted();
        options.onEvent({ type: "assistant_text_delta", text: "after transport closed" });
        return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "finished once" }] };
      } } }]);
    const server = createServer((request, response) => {
      const write = response.write;
      response.write = function (...args) {
        if (observed.closed) observed.writesAfterClose++;
        const accepted = Reflect.apply(write, this, args);
        if (!accepted) observed.falseWrites++;
        return accepted;
      };
      const sink = createSseRunExecutionSink(response);
      sink.onClose(() => { observed.closed = true; observeClose(); });
      void executeRunRequest({ cwd, task: { id: `sse-${mode}`, title: "SSE fixture", prompt: "No provider or tools" },
        provider: { provider: "fixture", model: "fixture" }, tools: [], thinkingLevel: "off" }, sink,
      runners, stores, activeRuns, supervisor, { resolve: () => undefined }, {})
        .then(runId => completeDispatch({ runId }), error => completeDispatch({ error }));
      request.resume();
    });
    let clientRequest, clientResponse;
    t.after(async () => {
      releaseRunner();
      clientResponse?.destroy(); clientRequest?.destroy();
      server.closeAllConnections();
      await dispatchDone;
      await new Promise(resolve => server.close(resolve));
      supervisor.releaseAll(); stores.closeAll();
      await rm(cwd, { recursive: true, force: true });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve, reject) => {
      clientRequest = requestHttp({ host: "127.0.0.1", port: server.address().port, path: "/runs", method: "POST" }, response => {
        clientResponse = response;
        response.pause();
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
        resolve();
      });
      clientRequest.once("error", reject);
      clientRequest.end("{}");
    });
    if (mode === "disconnect") clientResponse.destroy();
    await transportClosed;
    assert.equal(observed.signal.aborted, false, "socket loss must not cancel an owned execution");
    if (mode === "slow-reader") assert.ok(observed.falseWrites > 0, "the actual ServerResponse must reach write(false)");
    const store = stores.getStore(cwd);
    assert.equal(store.getRun(observed.runId).status, "running");
    releaseRunner();
    const completed = await dispatchDone;
    assert.equal(completed.error, undefined);
    assert.equal(completed.runId, observed.runId);
    assert.equal(observed.calls, 1);
    assert.equal(observed.writesAfterClose, 0);
    assert.equal(store.getRun(observed.runId).status, "succeeded");
    const events = store.listEvents(observed.runId, { limit: 1000 });
    assert.equal(events.filter(event => event.type === "assistant_text_delta").length, deltaCount + 1);
    assert.equal(events.filter(event => event.type === "result").length, 1);
    assert.equal(new Set(events.map(event => event.seq)).size, events.length);
    clientResponse.destroy();
    const historical = createSqliteRunStore(cwd);
    try {
      assert.equal(historical.getRun(observed.runId).status, "succeeded");
      assert.deepEqual(historical.listEvents(observed.runId, { limit: 1000 }), events);
    } finally { historical.close(); }
    t.diagnostic(`real HTTP observation: ${JSON.stringify({ mode, runId: observed.runId,
      falseWrites: observed.falseWrites, writesAfterClose: observed.writesAfterClose, persistedEvents: events.length })}`);
  });
}
