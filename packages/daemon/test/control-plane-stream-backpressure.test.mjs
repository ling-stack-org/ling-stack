import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { ControlPlaneEventHub } from "../dist/features/control-plane/events.js";
import { writeSse } from "../dist/shared/response.js";
import { SseStreamWriter } from "../dist/shared/sse-stream-writer.js";
import { handleControlPlaneRoute } from "../dist/features/control-plane/routes.js";

/** Model Node's accepted-but-backpressured write, without any socket or external I/O. */
class BackpressuredResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  writableLength = 0;
  writes = [];
  writesWhileBlocked = 0;
  blocked = false;

  constructor({ blockFirstWrite = true } = {}) {
    super();
    this.blockFirstWrite = blockFirstWrite;
  }

  write(chunk) {
    assert.equal(this.writableEnded || this.destroyed, false, "a closed response cannot accept more data");
    const text = String(chunk);
    if (this.blocked) this.writesWhileBlocked += 1;
    this.writes.push(text);
    this.writableLength += Buffer.byteLength(text, "utf8");
    if (this.blockFirstWrite && this.writes.length === 1) this.blocked = true;
    return !this.blocked;
  }

  end() { this.writableEnded = true; }
  destroy() { this.destroyed = true; this.emit("close"); }

  drain() {
    this.blocked = false;
    this.writableLength = 0;
    this.emit("drain");
  }
}

function event(seq, entityId) {
  return {
    seq, workspaceId: "workspace_default", cwd: "/a15-isolated-workspace",
    ts: `2026-10-15T00:00:0${seq}.000Z`, domain: "providers", entityType: "provider", entityId,
    action: "provider.updated", data: { providerId: entityId },
  };
}

function frames(response) {
  return response.writes.join("").split("\n\n").filter(Boolean).map(frame => {
    const lines = frame.split("\n");
    return { event: lines.find(line => line.startsWith("event: "))?.slice(7),
      data: JSON.parse(lines.find(line => line.startsWith("data: ")).slice(6)) };
  });
}

test("A15 SSE writes each event as one complete frame rather than splitting its header and data", () => {
  const response = new BackpressuredResponse({ blockFirstWrite: false });
  const data = { seq: 1, text: "Chinese 中文 and a newline\nare JSON data" };
  writeSse(response, "fixture_event", data);
  assert.deepEqual(response.writes, [`event: fixture_event\ndata: ${JSON.stringify(data)}\n\n`]);
});

test("A15 control-plane replay stops at a false write before later replay, ready or concurrent live frames", t => {
  const hub = new ControlPlaneEventHub();
  const response = new BackpressuredResponse();
  let subscription;
  t.after(() => { subscription?.close(); hub.closeAll(); });
  subscription = hub.subscribe({
    workspaceId: "workspace_default", cwd: "/a15-isolated-workspace", domains: ["providers"], response,
    latestEventSeq: () => 3,
    replayWindow: () => {
      hub.publish(event(3, "concurrent-live"));
      return { window: { disposition: "complete", requestedAfterSeq: 0, replayFloorSeq: 0,
        upperBoundSeq: 2, nextAfterSeq: 2 }, events: [event(1, "replay-one"), event(2, "replay-two")] };
    },
  });
  t.diagnostic(`A15 initial backpressure: ${JSON.stringify({ writes: response.writes.length,
    writesWhileBlocked: response.writesWhileBlocked, bufferedBytes: response.writableLength })}`);
  assert.equal(response.writesWhileBlocked, 0, "write(false) already accepted its frame; no further write is legal before drain");
  assert.deepEqual(frames(response).map(frame => [frame.event, frame.data.seq]), [["control_plane_event", 1]]);
});

function completeWindow(upperBoundSeq = 0) {
  return { disposition: "complete", requestedAfterSeq: 0, replayFloorSeq: 0, upperBoundSeq, nextAfterSeq: upperBoundSeq };
}

function subscribe(hub, response, options = {}) {
  return hub.subscribe({ workspaceId: "workspace_default", cwd: "/a15-isolated-workspace", response,
    latestEventSeq: () => 0, replayWindow: () => ({ window: completeWindow(), events: [] }), ...options });
}

function writerFixture(t, options = {}, response = new BackpressuredResponse()) {
  const writer = new SseStreamWriter(response, options);
  t.after(() => { writer.close(); response.emit("finish"); });
  return { response, writer };
}

test("SSE drain resumes with the next frame and keeps replay, ready, captured live and heartbeat FIFO", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const hub = new ControlPlaneEventHub();
  const response = new BackpressuredResponse();
  t.after(() => { hub.closeAll(); response.emit("finish"); });
  subscribe(hub, response, { replayWindow: () => {
    hub.publish(event(3, "captured-live"));
    return { window: completeWindow(2), events: [event(1, "first"), event(2, "second")] };
  } });
  t.mock.timers.tick(0);
  assert.equal(response.writes.length, 1);
  response.drain();
  assert.deepEqual(frames(response).map(frame => [frame.event, frame.data.seq]), [
    ["control_plane_event", 1], ["control_plane_event", 2], ["control_plane_replay_ready", undefined],
    ["control_plane_event", 3], ["heartbeat", undefined],
  ]);
  assert.equal(response.writesWhileBlocked, 0);
});

test("the final replay false write also blocks the replay-ready barrier", t => {
  const hub = new ControlPlaneEventHub();
  const response = new BackpressuredResponse({ blockFirstWrite: false });
  const write = response.write.bind(response);
  response.write = chunk => {
    const accepted = write(chunk);
    if (response.writes.length === 2) { response.blocked = true; return false; }
    return accepted;
  };
  t.after(() => { hub.closeAll(); response.emit("finish"); });
  subscribe(hub, response, { replayWindow: () => ({ window: completeWindow(2), events: [event(1, "a"), event(2, "b")] }) });
  assert.deepEqual(frames(response).map(frame => frame.data.seq), [1, 2]);
  response.drain();
  assert.deepEqual(frames(response).map(frame => frame.event), ["control_plane_event", "control_plane_event", "control_plane_replay_ready"]);
});

test("the initial header comment shares backpressure instead of leaving a first-write bypass", t => {
  const hub = new ControlPlaneEventHub();
  const response = new BackpressuredResponse();
  t.after(() => { hub.closeAll(); response.emit("finish"); });
  subscribe(hub, response, { initialComment: "control-plane", replayWindow: () => ({ window: completeWindow(1), events: [event(1, "first")] }) });
  assert.deepEqual(response.writes, [": control-plane\n\n"]);
  response.drain();
  assert.deepEqual(frames({ writes: response.writes.slice(1) }).map(frame => frame.event), ["control_plane_event", "control_plane_replay_ready"]);
  assert.equal(response.writesWhileBlocked, 0);
});

test("SSE inherits a response already waiting for drain", t => {
  const response = new BackpressuredResponse({ blockFirstWrite: false });
  response.writableNeedDrain = true;
  response.writableLength = 32;
  const { writer } = writerFixture(t, {}, response);
  assert.equal(writer.write("queued", { value: 1 }), true);
  assert.equal(response.writes.length, 0);
  response.drain();
  assert.equal(frames(response)[0].event, "queued");
});

test("pending heartbeat is replaced in place and does not refresh the blocked deadline", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let closed = 0;
  const { response, writer } = writerFixture(t, { maxPendingFrames: 1, blockedTimeoutMs: 50, closeGraceMs: 10,
    onClose: () => { closed += 1; } });
  assert.equal(writer.write("first", {}), true);
  assert.equal(writer.write("heartbeat", { generation: 1 }, "heartbeat"), true);
  t.mock.timers.tick(25);
  assert.equal(writer.write("heartbeat", { generation: 2 }, "heartbeat"), true);
  t.mock.timers.tick(24);
  assert.equal(response.writableEnded, false);
  t.mock.timers.tick(1);
  assert.equal(response.writableEnded, true);
  assert.equal(closed, 1);
  assert.equal(response.writes.length, 1);
  t.mock.timers.tick(10);
  assert.equal(response.destroyed, true);
  assert.equal(response.eventNames().length, 0);
  response.drain();
  assert.equal(writer.write("late", {}), false);
  assert.equal(response.writes.length, 1);
});

test("a drained heartbeat sends only its latest retained value before normal finish", t => {
  const { response, writer } = writerFixture(t, { maxPendingFrames: 1 });
  writer.write("first", {});
  for (let generation = 1; generation <= 10; generation += 1) assert.equal(writer.write("heartbeat", { generation }, "heartbeat"), true);
  writer.finish();
  assert.equal(response.writableEnded, false);
  assert.equal(writer.write("after-finish", {}), false);
  response.drain();
  assert.deepEqual(frames(response).map(frame => [frame.event, frame.data.generation]), [["first", undefined], ["heartbeat", 10]]);
  assert.equal(response.writableEnded, true);
});

test("snapshot-required drains its control frame before finish and unregisters live delivery", t => {
  const hub = new ControlPlaneEventHub();
  const response = new BackpressuredResponse();
  t.after(() => { hub.closeAll(); response.emit("finish"); });
  subscribe(hub, response, { initialComment: "control-plane", replayWindow: () => ({
    window: { ...completeWindow(), disposition: "snapshot_required", reason: "cursor_unavailable" }, events: [] }) });
  hub.publish(event(1, "must-not-arrive"));
  assert.equal(response.writes.length, 1);
  assert.equal(response.writableEnded, false);
  response.drain();
  assert.equal(response.writableEnded, true);
  assert.deepEqual(frames({ writes: response.writes.slice(1) }).map(frame => frame.event), ["control_plane_snapshot_required"]);
});

test("closeAll also aborts a retiring snapshot that is still blocked", t => {
  const hub = new ControlPlaneEventHub();
  const response = new BackpressuredResponse();
  t.after(() => response.emit("finish"));
  subscribe(hub, response, { initialComment: "control-plane", replayWindow: () => ({
    window: { ...completeWindow(), disposition: "snapshot_required" }, events: [] }) });
  hub.closeAll();
  assert.equal(response.writableEnded, true);
  response.drain();
  assert.deepEqual(response.writes, [": control-plane\n\n"]);
});

test("SSE checks count immediately in provisional, replay and active upstream queues", async t => {
  for (const phase of ["provisional", "replay", "active"]) await t.test(phase, t => {
    const hub = new ControlPlaneEventHub();
    const response = new BackpressuredResponse({ blockFirstWrite: false });
    t.after(() => { hub.closeAll(); response.emit("finish"); });
    subscribe(hub, response, { writerOptions: { maxPendingFrames: 3 }, replayWindow: () => {
      if (phase === "provisional") for (let seq = 1; seq <= 4; seq += 1) hub.publish(event(seq, `unique-${seq}`));
      return { window: completeWindow(phase === "replay" ? 4 : 0), events: phase === "replay" ? [1, 2, 3, 4].map(seq => event(seq, `unique-${seq}`)) : [] };
    } });
    if (phase === "active") for (let seq = 1; seq <= 4; seq += 1) hub.publish(event(seq, `unique-${seq}`));
    assert.equal(response.writableEnded, true, "overflow must close before any flush timer is needed");
    assert.equal(frames(response).some(frame => frame.event === "control_plane_event"), false);
  });
});

test("SSE accounts UTF-8 upstream bytes and existing response buffer before retention", async t => {
  for (const phase of ["provisional", "replay", "active"]) await t.test(phase, t => {
    const hub = new ControlPlaneEventHub();
    const response = new BackpressuredResponse({ blockFirstWrite: false });
    const large = { ...event(1, "cjk"), data: { text: "汉".repeat(500) } };
    assert.ok(JSON.stringify(large).length < 1_200);
    assert.ok(Buffer.byteLength(JSON.stringify(large), "utf8") > 1_200);
    t.after(() => { hub.closeAll(); response.emit("finish"); });
    subscribe(hub, response, { writerOptions: { maxBufferedBytes: 1_200 }, replayWindow: () => {
      if (phase === "provisional") hub.publish(large);
      return { window: completeWindow(phase === "replay" ? 1 : 0), events: phase === "replay" ? [large] : [] };
    } });
    if (phase === "active") hub.publish(large);
    assert.equal(response.writableEnded, true);
  });
  await t.test("observable response bytes share the same budget", t => {
    const { response, writer } = writerFixture(t, { maxBufferedBytes: 100 });
    response.writableLength = 90;
    assert.equal(writer.write("event", { text: "remaining-budget" }), false);
    assert.equal(response.writes.length, 0);
    assert.equal(response.writableEnded, true);
  });
});

test("SSE rejects an oversized encoded frame without partial writes or truncation", t => {
  const { response, writer } = writerFixture(t, { maxFrameBytes: 128 });
  assert.equal(writer.write("fact", { text: "汉".repeat(50) }), false);
  assert.equal(response.writes.length, 0);
  assert.equal(response.writableEnded, true);
});

test("SSE contains serialization and write exceptions and does not revive after close/error", async t => {
  for (const cause of ["encode", "write", "close", "error"]) await t.test(cause, t => {
    let closed = 0;
    const { response, writer } = writerFixture(t, { onClose: () => { closed += 1; } });
    if (cause === "encode") assert.equal(writer.write("bad", { value: 1n }), false);
    else if (cause === "write") {
      response.write = () => { throw new Error("fixture write failure"); };
      assert.doesNotThrow(() => assert.equal(writer.write("bad", {}), false));
    } else {
      writer.write("first", {});
      writer.write("pending", {});
      response.emit(cause, cause === "error" ? new Error("fixture response error") : undefined);
    }
    const count = response.writes.length;
    writer.close();
    response.drain();
    assert.equal(closed, 1);
    assert.equal(writer.write("late", {}), false);
    assert.equal(response.writes.length, count);
    assert.equal(response.listenerCount("drain"), 0);
    response.emit("finish");
    assert.equal(response.eventNames().length, 0);
  });
});

test("SSE reentrant input and synchronous drain do not recurse or replay the accepted frame", t => {
  const response = new BackpressuredResponse({ blockFirstWrite: false });
  const { writer } = writerFixture(t, {}, response);
  const write = response.write.bind(response);
  let depth = 0;
  let maxDepth = 0;
  response.write = chunk => {
    depth += 1;
    maxDepth = Math.max(maxDepth, depth);
    write(chunk);
    if (response.writes.length === 1) {
      for (let seq = 1; seq <= 50; seq += 1) writer.write("next", { seq });
      response.drain();
      depth -= 1;
      return false;
    }
    depth -= 1;
    return true;
  };
  assert.equal(writer.write("first", { seq: 0 }), true);
  assert.equal(maxDepth, 1);
  assert.deepEqual(frames(response).map(frame => frame.data.seq), Array.from({ length: 51 }, (_, seq) => seq));
  assert.equal(response.writableEnded, false);
});

test("listener activation preserves replay order even when delivery synchronously publishes live events", t => {
  const hub = new ControlPlaneEventHub();
  const delivered = [];
  const pending = [];
  t.after(() => hub.closeAll());
  const listener = hub.subscribeListener({ workspaceId: "workspace_default", cwd: "/a15-isolated-workspace",
    onPendingChange: (bytes, count) => { pending.push([bytes, count]); return true; },
    onEvent: value => { delivered.push(value.seq); if (value.seq === 1) hub.publish(event(3, "reentrant-live")); } });
  listener.activate([event(1, "one"), event(2, "two")]);
  assert.deepEqual(delivered, [1, 2, 3]);
  assert.deepEqual(pending.at(-1), [0, 0]);
  listener.close();
  assert.deepEqual(pending.at(-1), [0, 0]);
});

test("listener reservation rejection closes before delivery and clears ownership once", t => {
  const hub = new ControlPlaneEventHub();
  const delivered = [];
  const pending = [];
  let overflow = 0;
  t.after(() => hub.closeAll());
  const listener = hub.subscribeListener({ workspaceId: "workspace_default", cwd: "/a15-isolated-workspace",
    onPendingChange: (bytes, count) => { pending.push([bytes, count]); return count < 2; },
    onOverflow: () => { overflow += 1; }, onEvent: value => delivered.push(value.seq) });
  hub.publish(event(1, "one"));
  hub.publish(event(2, "two"));
  listener.activate([event(3, "late")]);
  hub.publish(event(4, "late-live"));
  assert.equal(overflow, 1);
  assert.deepEqual(delivered, []);
  assert.deepEqual(pending.at(-1), [0, 0]);
});

test("listener release callback closure prevents the shifted event from being forwarded", t => {
  const hub = new ControlPlaneEventHub();
  const delivered = [];
  let listener;
  let releasing = false;
  t.after(() => hub.closeAll());
  listener = hub.subscribeListener({ workspaceId: "workspace_default", cwd: "/a15-isolated-workspace",
    onPendingChange: (_bytes, count) => { if (releasing && count === 0) listener.close(); return true; },
    onEvent: value => delivered.push(value.seq) });
  hub.publish(event(1, "queued"));
  releasing = true;
  listener.activate([]);
  assert.deepEqual(delivered, []);
});

class RouteResponse extends BackpressuredResponse {
  headersSent = false;
  setHeader() {}
  writeHead() { this.headersSent = true; }
}

test("the real SSE route removes request ownership after client abort, replay failure and immediate finish", async t => {
  for (const cause of ["abort", "replay failure", "snapshot finish"]) await t.test(cause, async t => {
    const request = new EventEmitter();
    request.url = "/control-plane/stream?cwd=%2Fa15-isolated-workspace";
    request.headers = { host: "127.0.0.1" };
    request.method = "GET";
    const response = new RouteResponse({ blockFirstWrite: false });
    const hub = new ControlPlaneEventHub();
    const context = { config: { host: "127.0.0.1", port: 0 }, controlPlaneEvents: hub,
      storeRegistry: { getStore: () => ({ getLatestControlPlaneEventSeq: () => 0,
        readControlPlaneReplayWindow: () => {
          if (cause === "replay failure") throw new Error("fixture replay unavailable");
          return { window: cause === "snapshot finish" ? { ...completeWindow(), disposition: "snapshot_required" } : completeWindow(), events: [] };
        } }) } };
    t.after(() => { hub.closeAll(); response.emit("finish"); });
    assert.equal(await handleControlPlaneRoute(request, response, context), true);
    if (cause === "abort") request.emit("aborted");
    assert.equal(response.writableEnded, true);
    assert.equal(request.listenerCount("aborted"), 0);
    assert.equal(request.listenerCount("close"), 0);
    assert.equal(response.listenerCount("drain"), 0);
    response.emit("finish");
    assert.equal(response.eventNames().length, 0);
  });
});

/** Actual Node HTTP response framing/lifecycle over a controllable in-memory transport. */
class ControlledHttpSocket extends Duplex {
  pendingWrites = [];
  failWrites = false;

  constructor({ highWaterMark = 1 } = {}) { super({ highWaterMark, autoDestroy: false }); }
  _read() {}
  _write(_chunk, _encoding, callback) {
    if (this.failWrites) this.pendingWrites.push(callback);
    else callback();
  }
}

function nodeResponseFixture(t, socketOptions) {
  const socket = new ControlledHttpSocket(socketOptions);
  const socketErrors = [];
  socket.on("error", error => socketErrors.push(error));
  const request = new IncomingMessage(socket);
  request.method = "GET";
  const response = new ServerResponse(request);
  response.assignSocket(socket);
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const writer = new SseStreamWriter(response, { blockedTimeoutMs: 50, closeGraceMs: 20 });
  t.after(() => { writer.close(); response.destroy(); socket.destroy(); });
  return { socket, response, writer, socketErrors };
}

test("real Node SSE response reaches a bounded terminal transport state after write callback failure", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { socket, response, writer, socketErrors } = nodeResponseFixture(t);
  socket.failWrites = true;
  writer.write("held", { value: 1 });
  writer.close();
  assert.ok(socket.pendingWrites.length > 0, "real HTTP framing must have reached the held transport _write");
  socket.pendingWrites.shift()(new Error("fixture underlying write callback failure"));
  await nextTurn();
  t.diagnostic(`real Node callback failure before grace: ${JSON.stringify({ errors: socketErrors.length,
    socketDestroyed: socket.destroyed, responseDestroyed: response.destroyed, responseFinished: response.writableFinished })}`);
  t.mock.timers.tick(20);
  await nextTurn();
  assert.ok(socket.destroyed || response.destroyed || response.writableFinished,
    "a real transport error cannot cancel the only close deadline while leaving an unfinished response alive");
  assert.equal(response.listenerCount("drain"), 0);
});

test("real Node SSE response handles socket destruction during blocked end without revival", async t => {
  const { socket, response, writer, socketErrors } = nodeResponseFixture(t);
  socket.failWrites = true;
  writer.write("held", { value: 1 });
  writer.close();
  socket.destroy(new Error("fixture socket failure during end"));
  await nextTurn();
  assert.equal(socketErrors.length, 1);
  assert.equal(socket.destroyed, true);
  assert.equal(writer.write("late", {}), false);
  assert.equal(response.listenerCount("drain"), 0);
});

test("real Node normal finish followed by socket fault is not mistaken for response error production", { timeout: 1_000 }, async t => {
  const { socket, response, writer, socketErrors } = nodeResponseFixture(t, { highWaterMark: 16 * 1024 });
  const finished = once(response, "finish");
  assert.equal(writer.write("completed", { value: 1 }), true);
  assert.equal(response.writableNeedDrain, false, "the normal-finish fixture must not be waiting for transport drain");
  writer.finish();
  await finished;
  assert.equal(response.writableFinished, true);
  socket.destroy(new Error("fixture socket fault after normal finish"));
  await nextTurn();
  assert.equal(socketErrors.length, 1);
  assert.equal(writer.write("late", {}), false);
  assert.equal(response.listenerCount("drain"), 0);
});
