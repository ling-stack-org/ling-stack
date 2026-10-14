import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { ControlPlaneEventHub } from "../dist/features/control-plane/events.js";
import { attachRpcWebSocketServer } from "../dist/server/rpc.js";
import {
  RpcOutboundWriter, RPC_OUTBOUND_MAX_BUFFERED_BYTES, RPC_OUTBOUND_MAX_FRAME_BYTES,
  RPC_OUTBOUND_SEND_TIMEOUT_MS, RPC_OUTBOUND_CLOSE_GRACE_MS,
} from "../dist/server/rpc-outbound.js";

/** Control only the transport; the public upgrade and RPC dispatch stay real. */
class ControlledWebSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  frames = [];
  closeCalls = [];
  callbackMode = "microtask";
  callbacks = [];
  sendThrow;
  callbackError;
  onSend;
  closeLingers = false;
  terminateLingers = false;
  terminateCount = 0;
  sendDepth = 0;
  maxSendDepth = 0;

  send(data, options, callback) {
    if (this.sendThrow) throw this.sendThrow;
    this.sendDepth += 1;
    this.maxSendDepth = Math.max(this.maxSendDepth, this.sendDepth);
    try {
      const frame = JSON.parse(String(data));
      this.frames.push(frame);
      this.onSend?.(frame);
      const completed = typeof options === "function" ? options : callback;
      if (typeof completed !== "function") return;
      if (this.callbackMode === "hold") this.callbacks.push(completed);
      else if (this.callbackMode === "sync") completed(this.callbackError);
      else queueMicrotask(() => completed(this.callbackError));
    } finally {
      this.sendDepth -= 1;
    }
  }

  close(code, reason) {
    this.closeCalls.push({ code, reason });
    if (this.closeLingers) { this.readyState = WebSocket.CLOSING; return; }
    this.finishClose(code, reason);
  }

  terminate() {
    this.terminateCount += 1;
    if (this.terminateLingers) return;
    this.finishClose(1006, "fixture cleanup");
  }

  finishClose(code, reason) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason ?? ""));
  }

  request(id, method, params = {}) {
    this.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
  }

  completeNext(error) {
    const completed = this.callbacks.shift();
    assert.equal(typeof completed, "function", "a real send callback must be pending");
    completed(error);
    return completed;
  }
}

test("public RPC control-plane flush stops before sending into an over-budget WebSocket buffer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cwd = "/qa-rpc-backpressure";
  const ws = new ControlledWebSocket();
  const hub = new ControlPlaneEventHub();
  const server = createServer();
  const window = {
    disposition: "complete", requestedAfterSeq: 0, replayFloorSeq: 0,
    upperBoundSeq: 0, nextAfterSeq: 0,
  };
  const context = {
    config: {
      host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
      transports: { localWebSocketRpc: true }, channels: { enabled: true },
    },
    controlPlaneEvents: hub,
    storeRegistry: { getStore: () => ({ readControlPlaneReplayWindow: () => ({ window, events: [] }) }) },
  };
  t.mock.method(WebSocketServer.prototype, "handleUpgrade", (_request, _socket, _head, accept) => accept(ws));
  const rpc = attachRpcWebSocketServer(server, context);
  t.after(() => {
    ws.terminate();
    rpc.close();
    hub.closeAll();
  });

  server.emit("upgrade", {
    url: `/rpc/stream?cwd=${encodeURIComponent(cwd)}`, headers: { host: "127.0.0.1" },
  }, {}, Buffer.alloc(0));
  ws.request(1, "initialize");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ws.frames.find(frame => frame.id === 1)?.result?.ok, true,
    "the normal public initialize response must reach the controlled transport");
  ws.request(2, "controlPlane.subscribe", { domains: ["providers"], afterSeq: 0 });
  await Promise.resolve();
  await Promise.resolve();
  const subscribed = ws.frames.find(frame => frame.id === 2)?.result;
  assert.equal(subscribed?.disposition, "complete");
  assert.match(subscribed.subscriptionId, /^cp_/);
  assert.equal(ws.closeCalls.length, 0, "the healthy baseline must remain open");

  const sentBeforePressure = ws.frames.length;
  ws.bufferedAmount = Number.MAX_SAFE_INTEGER;
  hub.publish({
    seq: 1, workspaceId: "workspace_default", cwd, ts: "2026-10-15T00:00:00.000Z",
    domain: "providers", entityType: "provider", entityId: "provider_slow_client",
    action: "provider.updated", data: { providerId: "provider_slow_client" },
  });
  t.mock.timers.tick(100);
  await Promise.resolve();
  assert.equal(ws.frames.length, sentBeforePressure,
    "an over-budget transport must not receive another control-plane frame");
  assert.ok(ws.closeCalls.some(call => call.code === 1013),
    "the over-budget connection must close with the retryable slow-client status");
});

async function settleMicrotasks() {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

function writerFixture(t, options = {}) {
  const ws = new ControlledWebSocket();
  const writer = new RpcOutboundWriter(ws, options);
  t.after(() => { writer.close(); ws.terminate(); });
  return { ws, writer };
}

function controlEvent(cwd, sequence, domain = "providers", body = "") {
  return {
    seq: sequence, workspaceId: "workspace_default", cwd, ts: "2026-10-15T00:00:00.000Z",
    domain, entityType: domain === "providers" ? "provider" : "skill", entityId: `entity_${sequence}`,
    action: domain === "providers" ? "provider.updated" : "skill.updated", data: { body },
  };
}

/** No listener bypass: the fake transport enters through the production upgrade hook. */
function rpcFixture(t) {
  const cwd = "/qa-rpc-matrix";
  const ws = new ControlledWebSocket();
  const hub = new ControlPlaneEventHub();
  const server = createServer();
  const fixture = { cwd, ws, hub, server, nextId: 10, replay: () => ({ window: {
    disposition: "complete", requestedAfterSeq: 0, replayFloorSeq: 0, upperBoundSeq: 0, nextAfterSeq: 0,
  }, events: [] }) };
  const context = {
    config: { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
      transports: { localWebSocketRpc: true }, channels: { enabled: true } },
    controlPlaneEvents: hub,
    storeRegistry: { getStore: () => ({ readControlPlaneReplayWindow: input => fixture.replay(input) }) },
  };
  t.mock.method(WebSocketServer.prototype, "handleUpgrade", (_request, _socket, _head, accept) => accept(ws));
  const rpc = attachRpcWebSocketServer(server, context);
  t.after(() => { ws.terminate(); rpc.close(); hub.closeAll(); });
  server.emit("upgrade", { url: `/rpc/stream?cwd=${encodeURIComponent(cwd)}`, headers: { host: "127.0.0.1" } }, {}, Buffer.alloc(0));
  return fixture;
}

async function initialize(f) {
  f.ws.request(1, "initialize");
  await settleMicrotasks();
  assert.equal(f.ws.frames.find(frame => frame.id === 1)?.result?.ok, true);
}

async function subscribe(f, domains = ["providers"]) {
  const id = f.nextId++;
  f.ws.request(id, "controlPlane.subscribe", { domains, afterSeq: 0 });
  await settleMicrotasks();
  const result = f.ws.frames.find(frame => frame.id === id)?.result;
  assert.equal(result?.disposition, "complete");
  return result.subscriptionId;
}

test("RPC writer has one in-flight frame and ignores repeated callbacks", t => {
  const { ws, writer } = writerFixture(t);
  ws.callbackMode = "hold";
  for (const id of [1, 2, 3]) assert.equal(writer.send({ id }), true);
  assert.deepEqual(ws.frames.map(frame => frame.id), [1]);
  const first = ws.completeNext();
  assert.deepEqual(ws.frames.map(frame => frame.id), [1, 2]);
  first();
  assert.deepEqual(ws.frames.map(frame => frame.id), [1, 2]);
  ws.completeNext();
  ws.completeNext();
  assert.deepEqual(ws.frames.map(frame => frame.id), [1, 2, 3]);
  assert.equal(ws.closeCalls.length, 0);
});

test("RPC writer synchronous callbacks and reentrant input do not recursively pump", t => {
  const { ws, writer } = writerFixture(t);
  ws.callbackMode = "sync";
  ws.onSend = frame => {
    if (frame.id === 0) for (let id = 1; id <= 400; id += 1) writer.send({ id });
  };
  assert.equal(writer.send({ id: 0 }), true);
  assert.equal(ws.frames.length, 401);
  assert.equal(ws.maxSendDepth, 1);
  assert.deepEqual(ws.frames.map(frame => frame.id), Array.from({ length: 401 }, (_, id) => id));
  assert.equal(ws.closeCalls.length, 0);
});

test("RPC writer uses a fixed send deadline that new input cannot extend", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ws, writer } = writerFixture(t);
  ws.callbackMode = "hold";
  writer.send({ id: 1 });
  t.mock.timers.tick(RPC_OUTBOUND_SEND_TIMEOUT_MS - 1);
  writer.send({ id: 2 });
  assert.equal(ws.closeCalls.length, 0);
  t.mock.timers.tick(1);
  assert.equal(writer.isClosed(), true);
  assert.equal(ws.closeCalls[0].code, 1013);
  ws.completeNext();
  t.mock.timers.tick(RPC_OUTBOUND_SEND_TIMEOUT_MS * 2);
  assert.deepEqual(ws.frames.map(frame => frame.id), [1]);
  assert.equal(writer.send({ id: 3 }), false);
  assert.equal(ws.listenerCount("close"), 0);
  assert.equal(ws.listenerCount("error"), 0);
});

test("RPC writer callback errors close once and cannot release later pending frames", t => {
  const { ws, writer } = writerFixture(t);
  ws.callbackMode = "hold";
  writer.send({ id: 1 });
  writer.send({ id: 2 });
  const late = ws.completeNext(new Error("fixture send failure"));
  late();
  writer.close();
  assert.equal(ws.closeCalls.length, 1);
  assert.equal(ws.closeCalls[0].code, 1011);
  assert.deepEqual(ws.frames.map(frame => frame.id), [1]);
});

test("RPC writer contains synchronous send throws and encoding failures", async t => {
  await t.test("send throw", t => {
    const { ws, writer } = writerFixture(t);
    ws.sendThrow = new Error("fixture transport failure");
    assert.doesNotThrow(() => assert.equal(writer.send({ id: 1 }), false));
    assert.equal(ws.closeCalls[0].code, 1011);
    assert.equal(ws.frames.length, 0);
  });
  await t.test("non-serializable input", t => {
    const { ws, writer } = writerFixture(t);
    assert.doesNotThrow(() => assert.equal(writer.send({ value: 1n }), false));
    assert.equal(ws.closeCalls[0].code, 1011);
    assert.equal(ws.frames.length, 0);
  });
  await t.test("circular input remains a redacted valid frame", async t => {
    const { ws, writer } = writerFixture(t);
    const cycle = {}; cycle.self = cycle;
    assert.equal(writer.send(cycle), true);
    await settleMicrotasks();
    assert.deepEqual(ws.frames, [{ self: "[Circular]" }]);
    assert.equal(ws.closeCalls.length, 0);
  });
});

test("RPC writer frame budget is UTF-8 bytes and never truncates a large fact", async t => {
  await t.test("ASCII fits", async t => {
    const { ws, writer } = writerFixture(t);
    assert.equal(writer.send({ body: "a".repeat(50_000) }), true);
    await settleMicrotasks();
    assert.equal(ws.frames[0].body.length, 50_000);
    assert.equal(ws.closeCalls.length, 0);
  });
  await t.test("same character count in CJK exceeds byte limit", t => {
    const { ws, writer } = writerFixture(t);
    assert.ok(Buffer.byteLength("汉".repeat(50_000), "utf8") > RPC_OUTBOUND_MAX_FRAME_BYTES);
    assert.equal(writer.send({ body: "汉".repeat(50_000) }), false);
    assert.equal(ws.frames.length, 0);
    assert.equal(ws.closeCalls[0].code, 1013);
  });
});

test("RPC writer aggregates upstream reservations instead of allowing a budget per subscription", t => {
  const { ws, writer } = writerFixture(t);
  assert.equal(writer.reserve("cp_1:hub", Math.ceil(RPC_OUTBOUND_MAX_BUFFERED_BYTES * 0.6), 1), true);
  assert.equal(writer.reserve("cp_2:queue", Math.ceil(RPC_OUTBOUND_MAX_BUFFERED_BYTES * 0.6), 1), false);
  assert.equal(ws.frames.length, 0);
  assert.equal(ws.closeCalls[0].code, 1013);
});

test("RPC writer enforces aggregate frame count and visible transport bytes", async t => {
  await t.test("count is connection-wide", t => {
    const { ws, writer } = writerFixture(t, { maxPendingFrames: 3 });
    ws.callbackMode = "hold";
    writer.send({ id: 1 });
    assert.equal(writer.reserve("upstream", 20, 2), true);
    assert.equal(writer.send({ id: 2 }), false);
    assert.equal(ws.closeCalls[0].code, 1013);
    assert.deepEqual(ws.frames.map(frame => frame.id), [1]);
  });
  await t.test("socket buffer plus retained bytes", t => {
    const { ws, writer } = writerFixture(t, { maxBufferedBytes: 128 });
    ws.callbackMode = "hold";
    ws.bufferedAmount = 70;
    assert.equal(writer.send({ body: "a".repeat(40) }), true);
    assert.equal(writer.send({ body: "b".repeat(40) }), false);
    assert.equal(ws.closeCalls[0].code, 1013);
    assert.equal(ws.frames.length, 1);
  });
});

test("RPC writer cancels only unsent frames in an unsubscribed group", t => {
  const { ws, writer } = writerFixture(t);
  ws.callbackMode = "hold";
  writer.send({ id: 1 }, "cp_1");
  writer.send({ id: 2 }, "cp_1");
  writer.send({ id: 3 }, "cp_2");
  writer.send({ id: 4 });
  writer.cancelGroup("cp_1");
  ws.completeNext();
  ws.completeNext();
  ws.completeNext();
  assert.deepEqual(ws.frames.map(frame => frame.id), [1, 3, 4]);
});

test("RPC writer close grace terminates a stalled handshake and removes internal listeners", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ws, writer } = writerFixture(t);
  ws.closeLingers = true;
  ws.terminateLingers = true;
  ws.callbackMode = "hold";
  writer.send({ id: 1 });
  writer.close(1013, "fixture overload");
  assert.equal(ws.terminateCount, 0);
  t.mock.timers.tick(RPC_OUTBOUND_CLOSE_GRACE_MS - 1);
  assert.equal(ws.terminateCount, 0);
  t.mock.timers.tick(1);
  assert.equal(ws.terminateCount, 1);
  assert.equal(ws.listenerCount("close"), 0);
  assert.equal(ws.listenerCount("error"), 0);
  ws.completeNext();
  t.mock.timers.tick(RPC_OUTBOUND_SEND_TIMEOUT_MS * 2);
  assert.equal(ws.frames.length, 1);
  assert.equal(ws.closeCalls.length, 1);
});

test("RPC writer peer close and transport error synchronously discard pending sends", async t => {
  for (const cause of ["close", "error"]) await t.test(cause, t => {
    let closed = 0;
    const { ws, writer } = writerFixture(t, { onClose: () => { closed += 1; } });
    ws.callbackMode = "hold";
    writer.send({ id: 1 }); writer.send({ id: 2 });
    if (cause === "close") ws.finishClose(1000, "peer");
    else ws.emit("error", new Error("fixture connection failure"));
    ws.completeNext();
    assert.equal(closed, 1);
    assert.equal(writer.isClosed(), true);
    assert.deepEqual(ws.frames.map(frame => frame.id), [1]);
    assert.equal(ws.listenerCount("close"), 0);
    assert.equal(ws.listenerCount("error"), 0);
  });
});

test("public RPC replay and concurrent live events follow the subscription response in order", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = rpcFixture(t);
  await initialize(f);
  f.replay = () => {
    f.hub.publish(controlEvent(f.cwd, 3));
    return { window: { disposition: "complete", requestedAfterSeq: 0, replayFloorSeq: 0, upperBoundSeq: 2, nextAfterSeq: 2 },
      events: [controlEvent(f.cwd, 1), controlEvent(f.cwd, 2)] };
  };
  const subscriptionId = await subscribe(f);
  t.mock.timers.tick(100);
  await settleMicrotasks();
  const notifications = f.ws.frames.filter(frame => frame.method === "$/control_plane_event");
  assert.deepEqual(notifications.map(frame => frame.params.event.seq), [1, 2, 3]);
  assert.ok(notifications.every(frame => frame.params.subscriptionId === subscriptionId));
  assert.ok(f.ws.frames.findIndex(frame => frame.result?.subscriptionId === subscriptionId) < f.ws.frames.indexOf(notifications[0]));
  assert.equal(f.ws.closeCalls.length, 0);
});

test("public RPC unflushed queues share the one connection byte limit", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = rpcFixture(t);
  await initialize(f);
  for (let index = 0; index < 3; index += 1) await subscribe(f);
  const baseline = f.ws.frames.length;
  for (let sequence = 1; sequence <= 6; sequence += 1) f.hub.publish(controlEvent(f.cwd, sequence, "providers", "x".repeat(60_000)));
  assert.equal(f.ws.closeCalls[0]?.code, 1013, "six events per queue must not receive three independent MiB allowances");
  assert.equal(f.ws.frames.length, baseline, "overflow is checked before the 100ms flush");
  f.hub.publish(controlEvent(f.cwd, 20));
  t.mock.timers.tick(10_000);
  await settleMicrotasks();
  assert.equal(f.ws.frames.length, baseline);
  assert.equal(f.ws.listenerCount("message"), 0);
  assert.equal(f.ws.listenerCount("close"), 0);
  assert.equal(f.ws.listenerCount("error"), 0);
});

test("public RPC provisional events are reserved before replay lookup returns", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = rpcFixture(t);
  await initialize(f);
  const baseline = f.ws.frames.length;
  f.replay = () => {
    for (let sequence = 1; sequence <= 19; sequence += 1) f.hub.publish(controlEvent(f.cwd, sequence, "providers", "x".repeat(60_000)));
    return { window: { disposition: "complete", requestedAfterSeq: 0, replayFloorSeq: 0, upperBoundSeq: 0, nextAfterSeq: 0 }, events: [] };
  };
  f.ws.request(10, "controlPlane.subscribe", { domains: ["providers"] });
  await settleMicrotasks();
  assert.equal(f.ws.closeCalls[0]?.code, 1013);
  assert.equal(f.ws.frames.length, baseline, "a closed provisional listener cannot manufacture a subscription success");
  t.mock.timers.tick(10_000);
  assert.equal(f.ws.frames.length, baseline);
});

test("public RPC provisional retention shares the active subscriptions budget before replay lookup returns", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = rpcFixture(t);
  await initialize(f);
  await subscribe(f);
  await subscribe(f);
  const baseline = f.ws.frames.length;
  let closedDuringLookup = false;
  f.replay = () => {
    // Each of the three queues holds only six events; none reaches its own MiB limit.
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      f.hub.publish(controlEvent(f.cwd, sequence, "providers", "x".repeat(60_000)));
    }
    closedDuringLookup = f.ws.closeCalls.some(call => call.code === 1013);
    return { window: { disposition: "complete", requestedAfterSeq: 0, replayFloorSeq: 0, upperBoundSeq: 0, nextAfterSeq: 0 }, events: [] };
  };
  f.ws.request(30, "controlPlane.subscribe", { domains: ["providers"] });
  await settleMicrotasks();
  assert.equal(closedDuringLookup, true,
    "the third provisional queue must count while the two active queues are still unflushed");
  assert.equal(f.ws.frames.length, baseline,
    "the connection must close before a subscription response or 100ms flush can be sent");
  t.mock.timers.tick(10_000);
  await settleMicrotasks();
  assert.equal(f.ws.frames.length, baseline);
});

test("public RPC replay merge obeys upstream bytes before transferring into the active queue", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = rpcFixture(t);
  await initialize(f);
  f.replay = () => ({
    window: { disposition: "complete", requestedAfterSeq: 0, replayFloorSeq: 0, upperBoundSeq: 19, nextAfterSeq: 19 },
    events: Array.from({ length: 19 }, (_, index) => controlEvent(f.cwd, index + 1, "providers", "x".repeat(60_000))),
  });
  f.ws.request(10, "controlPlane.subscribe", { domains: ["providers"] });
  await settleMicrotasks();
  assert.equal(f.ws.closeCalls[0]?.code, 1013);
  t.mock.timers.tick(100);
  assert.equal(f.ws.frames.some(frame => frame.method === "$/control_plane_event"), false);
});

test("public RPC replay merge shares existing active queue bytes before forwarding any replay event", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = rpcFixture(t);
  await initialize(f);
  await subscribe(f);
  for (let sequence = 1; sequence <= 9; sequence += 1) {
    f.hub.publish(controlEvent(f.cwd, sequence, "providers", "x".repeat(60_000)));
  }
  let replayDeliveries = 0;
  const subscribeListener = f.hub.subscribeListener.bind(f.hub);
  // Observe the genuine Hub-to-RPC delivery port without bypassing either implementation.
  t.mock.method(f.hub, "subscribeListener", input => subscribeListener({
    ...input,
    onEvent: event => { replayDeliveries += 1; input.onEvent(event); },
  }));
  f.replay = () => ({
    window: { disposition: "complete", requestedAfterSeq: 0, replayFloorSeq: 0, upperBoundSeq: 18, nextAfterSeq: 18 },
    events: Array.from({ length: 9 }, (_, index) => controlEvent(f.cwd, index + 10, "providers", "x".repeat(60_000))),
  });
  f.ws.request(30, "controlPlane.subscribe", { domains: ["providers"] });
  await settleMicrotasks();
  assert.equal(f.ws.closeCalls[0]?.code, 1013);
  assert.equal(replayDeliveries, 0,
    "two sub-MiB queues must overflow the shared upstream budget before any replay onEvent delivery");
  assert.equal(f.ws.frames.some(frame => frame.method === "$/control_plane_event"), false);
  t.mock.timers.tick(10_000);
  await settleMicrotasks();
  assert.equal(replayDeliveries, 0);
  assert.equal(f.ws.frames.some(frame => frame.method === "$/control_plane_event"), false);
});

test("public RPC unsubscribe removes unsent notifications without cancelling another group or in-flight frame", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = rpcFixture(t);
  await initialize(f);
  const first = await subscribe(f, ["providers"]);
  const second = await subscribe(f, ["skills"]);
  f.ws.callbackMode = "hold";
  f.hub.publish(controlEvent(f.cwd, 1));
  f.hub.publish(controlEvent(f.cwd, 2));
  f.hub.publish(controlEvent(f.cwd, 3, "skills"));
  t.mock.timers.tick(100);
  assert.deepEqual(f.ws.frames.filter(frame => frame.method === "$/control_plane_event").map(frame => frame.params.event.seq), [1]);
  f.ws.request(30, "controlPlane.unsubscribe", { subscriptionId: first });
  await settleMicrotasks();
  f.ws.completeNext();
  f.ws.completeNext();
  f.ws.completeNext();
  const delivered = f.ws.frames.filter(frame => frame.method === "$/control_plane_event");
  assert.deepEqual(delivered.map(frame => [frame.params.subscriptionId, frame.params.event.seq]), [[first, 1], [second, 3]]);
  assert.equal(f.ws.frames.find(frame => frame.id === 30)?.result?.ok, true);
  f.hub.publish(controlEvent(f.cwd, 4));
  t.mock.timers.tick(100);
  assert.equal(f.ws.frames.filter(frame => frame.method === "$/control_plane_event").length, 2);
  assert.equal(f.ws.closeCalls.length, 0);
});

test("public RPC responses and parse errors cannot bypass the shared transport byte boundary", async t => {
  for (const kind of ["response", "parse error"]) await t.test(kind, async t => {
    const f = rpcFixture(t);
    await initialize(f);
    const baseline = f.ws.frames.length;
    f.ws.bufferedAmount = Number.MAX_SAFE_INTEGER;
    if (kind === "response") f.ws.request(10, "daemon.health");
    else f.ws.emit("message", Buffer.from("{not json"));
    await settleMicrotasks();
    assert.equal(f.ws.closeCalls[0]?.code, 1013);
    assert.equal(f.ws.frames.length, baseline);
  });
});

test("public RPC oversized result closes the consumer rather than truncating the result", async t => {
  const f = rpcFixture(t);
  await initialize(f);
  f.replay = () => ({
    window: { disposition: "complete", requestedAfterSeq: 0, replayFloorSeq: 0, upperBoundSeq: 3, nextAfterSeq: 3 },
    events: Array.from({ length: 3 }, (_, index) => controlEvent(f.cwd, index + 1, "providers", "x".repeat(60_000))),
  });
  f.ws.request(10, "controlPlane.events", { domains: ["providers"] });
  await settleMicrotasks();
  assert.equal(f.ws.closeCalls[0]?.code, 1013);
  assert.equal(f.ws.frames.some(frame => frame.id === 10), false);
});
