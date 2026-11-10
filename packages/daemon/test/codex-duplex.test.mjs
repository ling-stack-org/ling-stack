import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { CodexDuplex } from "../dist/runtime/adapters/codex/duplex.js";

const deferred = () => Promise.withResolvers();
const tick = () => new Promise(resolve => setImmediate(resolve));
function peer(t, options = {}) {
  const input = options.input ?? new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  const sent = [];
  let bytes = "";
  input.on("data", chunk => {
    bytes += chunk;
    for (let index; (index = bytes.indexOf("\n")) >= 0;) {
      sent.push(JSON.parse(bytes.slice(0, index)));
      bytes = bytes.slice(index + 1);
    }
  });
  const rpc = new CodexDuplex({ input, output, signal: controller.signal, ...options });
  t.after(() => { rpc.close(); input.destroy(); output.destroy(); });
  const send = value => output.write(JSON.stringify(value) + "\n");
  return { rpc, input, output, sent, send, controller };
}

test("pending native approval does not block responses or ordered live notifications", async t => {
  const approval = deferred();
  const requested = deferred();
  const events = [];
  const p = peer(t, { onRequest: async request => { requested.resolve(request); return approval.promise; },
    onNotification: event => { events.push(event.params.delta); } });
  const result = p.rpc.request("turn/start", { threadId: "thread" });
  await tick();
  p.send({ id: 90, method: "item/commandExecution/requestApproval", params: { command: "whois example.com" } });
  assert.equal((await requested.promise).id, 90);
  p.send({ method: "item/agentMessage/delta", params: { delta: "before approval" } });
  p.send({ id: p.sent[0].id, result: { turn: { id: "turn" } } });
  assert.deepEqual(await result, { turn: { id: "turn" } });
  await tick();
  assert.deepEqual(events, ["before approval"]);
  assert.equal(p.sent.length, 1);
  approval.resolve({ decision: "decline" });
  await tick();
  assert.deepEqual(p.sent[1], { id: 90, result: { decision: "decline" } });
});

test("async notification work preserves order without blocking response dispatch", async t => {
  const gate = deferred();
  const events = [];
  const p = peer(t, { onNotification: async event => { events.push(event.params.n); if (event.params.n === 1) await gate.promise; } });
  const answer = p.rpc.request("thread/read", {});
  await tick();
  p.send({ method: "a", params: { n: 1 } });
  p.send({ method: "a", params: { n: 2 } });
  p.send({ id: p.sent[0].id, result: null });
  assert.equal(await answer, null);
  assert.deepEqual(events, [1]);
  gate.resolve();
  await tick();
  assert.deepEqual(events, [1, 2]);
});

test("synchronous notification receipt precedes native requests even when an observer stalls", async t => {
  const gate = deferred();
  const received = [];
  const p = peer(t, { onNotificationReceived: event => { received.push(event.method); },
    onNotification: () => gate.promise,
    onRequest: () => { assert.deepEqual(received, ["busy", "item/started"]); return { decision: "decline" }; } });
  p.send({ method: "busy", params: {} });
  p.send({ method: "item/started", params: {} });
  p.send({ id: "approval", method: "item/fileChange/requestApproval", params: {} });
  await tick();
  assert.deepEqual(p.sent, [{ id: "approval", result: { decision: "decline" } }]);
  gate.resolve();
});

test("failed synchronous receipt closes transport without dispatching the following grant", async t => {
  let requests = 0;
  const p = peer(t, { onNotificationReceived: () => { throw new Error("private payload"); },
    onRequest: () => { requests++; return { decision: "accept" }; } });
  p.send({ method: "item/started", params: {} });
  p.send({ id: "approval", method: "item/fileChange/requestApproval", params: {} });
  await tick();
  assert.equal(requests, 0);
  assert.equal((await p.rpc.closed).code, "handler_failed");
  assert.deepEqual(p.sent, []);
});

test("cancel aborts callbacks and pending replies and never sends a late approval", async t => {
  const approval = deferred();
  let nativeSignal;
  const p = peer(t, { onRequest: (_, signal) => { nativeSignal = signal; return approval.promise; } });
  const pending = p.rpc.request("thread/read", {});
  const rejection = assert.rejects(pending, { code: "cancelled" });
  p.send({ id: "approval", method: "approve", params: {} });
  await tick();
  p.controller.abort();
  await rejection;
  assert.equal(nativeSignal.aborted, true);
  approval.resolve({ decision: "accept" });
  await tick();
  assert.equal(p.sent.some(message => message.id === "approval"), false);
});

for (const [name, value] of [
  ["null id", { id: null, method: "a" }],
  ["fractional id", { id: 1.2, method: "a" }],
  ["mixed response", { id: 1, result: {}, error: { code: 1, message: "secret" } }],
  ["response as request", { id: 1, method: "a", result: {} }],
  ["unknown response", { id: "unknown", result: {} }],
  ["array", []],
]) test(`rejects ${name}`, async t => {
  const p = peer(t);
  p.send(value);
  assert.equal((await p.rpc.closed).code, "protocol_error");
});

test("duplicate native request id cannot execute callback twice", async t => {
  let calls = 0;
  const p = peer(t, { onRequest: () => { calls++; return {}; } });
  p.send({ id: 1, method: "a" });
  await tick();
  p.send({ id: 1, method: "a" });
  assert.equal((await p.rpc.closed).code, "protocol_error");
  assert.equal(calls, 1);
});

test("duplicate completed response closes the connection", async t => {
  const p = peer(t);
  const result = p.rpc.request("thread/read", {});
  await tick();
  p.send({ id: p.sent[0].id, result: {} });
  await result;
  p.send({ id: p.sent[0].id, result: {} });
  assert.equal((await p.rpc.closed).code, "protocol_error");
});

test("strict UTF-8 spans chunks and invalid UTF-8 fails without exposing payload", async t => {
  const events = [];
  const p = peer(t, { onNotification: event => { events.push(event.params); } });
  const valid = Buffer.from(JSON.stringify({ method: "text", params: "\u4e2d" }) + "\n");
  for (const byte of valid) p.output.write(Buffer.from([byte]));
  await tick();
  assert.deepEqual(events, ["\u4e2d"]);
  p.output.write(Buffer.from([0xff, 10]));
  assert.equal((await p.rpc.closed).message, "protocol_error");
});

test("frame, native callback, notification and write queues have hard bounds", async t => {
  const frame = peer(t, { limits: { frameBytes: 32 } });
  frame.output.write("x".repeat(33));
  assert.equal((await frame.rpc.closed).code, "capacity_exceeded");
  const requests = peer(t, { limits: { nativeRequests: 1 }, onRequest: () => deferred().promise });
  requests.send({ id: 1, method: "a" });
  requests.send({ id: 2, method: "a" });
  assert.equal((await requests.rpc.closed).code, "capacity_exceeded");
  const notifications = peer(t, { limits: { notificationCount: 1 }, onNotification: () => deferred().promise });
  notifications.send({ method: "a" });
  notifications.send({ method: "b" });
  assert.equal((await notifications.rpc.closed).code, "capacity_exceeded");
  const writes = peer(t, { input: new Writable({ write() {} }), limits: { writeBytes: 16 } });
  await assert.rejects(writes.rpc.notify("long-method", {}), { code: "capacity_exceeded" });
});

test("write callback failure is handled even when a response arrived first", async t => {
  let complete;
  const input = new Writable({ write(_chunk, _encoding, callback) { complete = callback; } });
  const p = peer(t, { input });
  const pending = p.rpc.request("thread/read", {});
  const rejection = assert.rejects(pending, { code: "transport_failed" });
  p.send({ id: "ling:1", result: {} });
  complete(new Error("secret write failure"));
  await rejection;
  await tick();
  assert.equal((await p.rpc.closed).message, "transport_failed");
});

test("timeouts, EOF and native handler errors fail closed with redacted reasons", async t => {
  const timeout = peer(t, { requestTimeoutMs: 10 });
  await assert.rejects(timeout.rpc.request("thread/read", {}), { code: "timeout" });
  const eof = peer(t);
  const pending = eof.rpc.request("turn/start", {});
  const rejection = assert.rejects(pending, { code: "transport_failed" });
  eof.output.end();
  await rejection;
  const handler = peer(t, { onRequest: () => { throw new Error("private path"); } });
  handler.send({ id: 1, method: "tool" });
  assert.equal((await handler.rpc.closed).message, "handler_failed");
});

test("unknown requests return a protocol error, never an implicit approval", async t => {
  const p = peer(t);
  p.send({ id: 1, method: "unknown" });
  await tick();
  assert.deepEqual(p.sent, [{ id: 1, error: { code: -32601, message: "Unsupported request" } }]);
});

test("remote errors retain numeric codes but redact native message and data", async t => {
  const p = peer(t);
  const pending = p.rpc.request("turn/start", {});
  const rejection = assert.rejects(pending, error => error.code === "remote_error" && error.remoteCode === -32602 && error.message === "remote_error");
  await tick();
  p.send({ id: p.sent[0].id, error: { code: -32602, message: "secret", data: "private" } });
  await rejection;
});

test("a stalled notification write has its own deadline", async t => {
  const p = peer(t, { input: new Writable({ write() {} }), writeTimeoutMs: 10 });
  await assert.rejects(p.rpc.notify("initialized"), { code: "timeout" });
});

test("resolved native requests discard late decisions without closing unrelated work", async t => {
  const decision = deferred();
  let signal;
  const p = peer(t, { onRequest: (_request, nativeSignal) => { signal = nativeSignal; return decision.promise; } });
  p.send({ id: 99, method: "approval" });
  await tick();
  assert.equal(p.rpc.cancelNativeRequest(99), true);
  assert.equal(signal.aborted, true);
  decision.resolve({ decision: "accept" });
  await tick();
  assert.equal(p.sent.length, 0);
  const pending = p.rpc.request("thread/read", {});
  await tick();
  p.send({ id: p.sent[0].id, result: {} });
  assert.deepEqual(await pending, {});
});

test("native resolution removes an approval queued behind a stalled write", async t => {
  const written = [];
  const callbacks = [];
  const p = peer(t, { input: new Writable({ write(chunk, _encoding, callback) {
    written.push(JSON.parse(String(chunk))); callbacks.push(callback);
  } }), onRequest: async () => ({ decision: "accept" }) });
  const first = p.rpc.notify("initialized");
  p.send({ id: 21, method: "approval" });
  await tick();
  p.rpc.cancelNativeRequest(21);
  callbacks.shift()();
  await first;
  await tick();
  assert.deepEqual(written, [{ method: "initialized" }]);
});

test("native resolution is processed even while an earlier notification callback waits", async t => {
  const event = deferred();
  const decision = deferred();
  let signal;
  const p = peer(t, { onNotification: () => event.promise,
    onRequest: (_message, nativeSignal) => { signal = nativeSignal; return decision.promise; } });
  p.send({ id: 55, method: "approval" });
  p.send({ method: "item/agentMessage/delta", params: {} });
  await tick();
  p.send({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: 55 } });
  assert.equal(signal.aborted, true);
  decision.resolve({ decision: "accept" });
  event.resolve();
  await tick();
  assert.equal(p.sent.length, 0);
});

test("turn completion cancels native work before the application drains earlier events", async t => {
  const event = deferred();
  const decision = deferred();
  let signal;
  const p = peer(t, { onNotification: () => event.promise,
    onRequest: (_message, nativeSignal) => { signal = nativeSignal; return decision.promise; } });
  p.send({ id: 2, method: "approval", params: { threadId: "thread", turnId: "turn" } });
  p.send({ method: "item/agentMessage/delta", params: {} });
  await tick();
  p.send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "interrupted" } } });
  assert.equal(signal.aborted, true);
  decision.resolve({ decision: "accept" });
  event.resolve();
  await tick();
  assert.equal(p.sent.length, 0);
});

test("native reply observations preserve id types and follow actual write completion exactly once", async t => {
  const observations = [];
  const sending = [];
  const p = peer(t, {
    onRequest: async () => ({ decision: "decline" }),
    onReplySending: (request, reply) => sending.push({ id: request.id, reply }),
    onReplyOutcome: observation => { observations.push(observation); },
  });
  for (const id of [7, "7"]) p.send({ id, method: "approval" });
  await tick();
  p.rpc.close();
  assert.deepEqual(sending, [7, "7"].map(id => ({ id, reply: { decision: "decline" } })));
  assert.deepEqual(observations, [7, "7"].map(requestId => ({ requestId, method: "approval", outcome: "written" })));
});

test("queued cancellation reports not-written immediately without claiming a reply", async t => {
  const callbacks = [];
  const written = [];
  const observations = [];
  const sending = [];
  const p = peer(t, { input: new Writable({ write(chunk, _encoding, callback) {
    written.push(JSON.parse(String(chunk))); callbacks.push(callback);
  } }), onRequest: async () => ({ decision: "accept" }),
  onReplySending: request => { sending.push(request.id); },
  onReplyOutcome: observation => { observations.push(observation); } });
  const first = p.rpc.notify("initialized");
  p.send({ id: 21, method: "approval" });
  await tick();
  p.rpc.cancelNativeRequest(21);
  assert.deepEqual(observations, [{ requestId: 21, method: "approval", outcome: "not_written" }]);
  assert.deepEqual(sending, []);
  callbacks.shift()();
  await first;
  await tick();
  assert.deepEqual(written, [{ method: "initialized" }]);
  assert.equal(observations.length, 1);
});

test("in-flight cancellation records unknown even when its write callback later succeeds", async t => {
  let complete;
  const observations = [];
  const p = peer(t, { input: new Writable({ write(_chunk, _encoding, callback) { complete = callback; } }),
    onRequest: async () => ({ decision: "accept" }),
    onReplyOutcome: observation => { observations.push(observation); } });
  p.send({ id: 4, method: "approval" });
  await tick();
  assert.equal(typeof complete, "function");
  assert.deepEqual(observations, []);
  p.rpc.cancelNativeRequest(4);
  assert.deepEqual(observations, [{ requestId: 4, method: "approval", outcome: "unknown" }]);
  complete();
  await tick();
  p.rpc.close();
  assert.equal(observations.length, 1);
});

test("an unanswered handler is observed on cancellation without waiting for the handler", async t => {
  const answer = deferred();
  const observations = [];
  const p = peer(t, { onRequest: () => answer.promise,
    onReplyOutcome: observation => { observations.push(observation); } });
  p.send({ id: "waiting", method: "approval" });
  await tick();
  p.controller.abort();
  assert.deepEqual(observations, [{ requestId: "waiting", method: "approval", outcome: "not_written" }]);
  answer.resolve({ decision: "accept" });
  await tick();
  assert.equal(observations.length, 1);
  assert.deepEqual(p.sent, []);
});

test("a reply-claim failure prevents write and is observed as not-written", async t => {
  const observations = [];
  const p = peer(t, { onRequest: async () => ({ decision: "accept" }),
    onReplySending: () => { throw new Error("private database failure"); },
    onReplyOutcome: observation => { observations.push(observation); } });
  p.send({ id: 8, method: "approval" });
  const result = await Promise.race([p.rpc.closed, tick().then(() => null)]);
  assert.equal(result?.code, "handler_failed");
  assert.deepEqual(p.sent, []);
  assert.deepEqual(observations, [{ requestId: 8, method: "approval", outcome: "not_written" }]);
});

test("failed in-flight write and uninvoked queued write have different delivery outcomes", async t => {
  let complete;
  const observations = [];
  const p = peer(t, { input: new Writable({ write(_chunk, _encoding, callback) { complete = callback; } }),
    onRequest: async () => ({ decision: "accept" }),
    onReplyOutcome: observation => { observations.push(observation); } });
  p.send({ id: 1, method: "approval" });
  p.send({ id: 2, method: "approval" });
  await tick();
  complete(new Error("private write error"));
  await p.rpc.closed;
  await tick();
  assert.deepEqual(observations, [
    { requestId: 1, method: "approval", outcome: "unknown" },
    { requestId: 2, method: "approval", outcome: "not_written" },
  ]);
});

test("completed write is observed synchronously and never downgraded by immediate cancellation", async t => {
  let complete;
  const observations = [];
  const p = peer(t, { input: new Writable({ write(_chunk, _encoding, callback) { complete = callback; } }),
    onRequest: async () => ({ decision: "accept" }),
    onReplyOutcome: observation => { observations.push(observation); } });
  p.send({ id: 1, method: "approval" });
  await tick();
  complete();
  p.controller.abort();
  await tick();
  assert.deepEqual(observations, [{ requestId: 1, method: "approval", outcome: "written" }]);
});

test("delivery observer failure closes transport and cannot write another queued grant", async t => {
  const written = [];
  let complete;
  const p = peer(t, { input: new Writable({ write(chunk, _encoding, callback) {
    written.push(JSON.parse(String(chunk))); complete = callback;
  } }), onRequest: async () => ({ decision: "accept" }),
  onReplyOutcome: () => { throw new Error("private storage error"); } });
  p.send({ id: 1, method: "approval" });
  p.send({ id: 2, method: "approval" });
  await tick();
  complete();
  const result = await Promise.race([p.rpc.closed, tick().then(() => null)]);
  assert.equal(result?.code, "handler_failed");
  assert.equal(written.length, 1);
});

test("reentrant delivery observers cannot pump queued replies before their own commit finishes", async t => {
  const written = [];
  let complete;
  let p;
  p = peer(t, { input: new Writable({ write(chunk, _encoding, callback) {
    written.push(JSON.parse(String(chunk))); complete = callback;
  } }), onRequest: async () => ({ decision: "accept" }),
  onReplyOutcome: observation => {
    if (observation.requestId === 1) {
      void p.rpc.notify("observer-notification").catch(() => {});
      throw new Error("private observer failure");
    }
  } });
  p.send({ id: 1, method: "approval" });
  p.send({ id: 2, method: "approval" });
  await tick();
  complete();
  await p.rpc.closed;
  assert.deepEqual(written, [{ id: 1, result: { decision: "accept" } }]);
});

test("pre-write verification receives the serialized reply even when a retained result changes", async t => {
  const result = { decision: "accept" };
  const checked = [];
  const written = [];
  const callbacks = [];
  const p = peer(t, { input: new Writable({ write(chunk, _encoding, callback) {
    written.push(JSON.parse(String(chunk))); callbacks.push(callback);
  } }), onRequest: async () => result,
  onReplySending: (_request, reply) => { checked.push(reply); } });
  const pending = p.rpc.notify("hold");
  void pending.catch(() => {});
  p.send({ id: 1, method: "approval" });
  await tick();
  result.decision = "decline";
  callbacks.shift()();
  await pending;
  assert.deepEqual(checked, [{ decision: "accept" }]);
  assert.deepEqual(written[1], { id: 1, result: { decision: "accept" } });
  callbacks.shift()();
});

test("native deadline observes an unanswered request as not-written", async t => {
  const observations = [];
  const p = peer(t, { nativeRequestTimeoutMs: 10, onRequest: () => deferred().promise,
    onReplyOutcome: observation => { observations.push(observation); } });
  p.send({ id: 1, method: "approval" });
  assert.equal((await p.rpc.closed).code, "timeout");
  assert.deepEqual(observations, [{ requestId: 1, method: "approval", outcome: "not_written" }]);
});
