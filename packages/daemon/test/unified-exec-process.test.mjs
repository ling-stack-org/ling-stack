import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { observeCommandProcess } from "../dist/features/runs/unified-exec-process.js";

function childFixture() {
  const child = new EventEmitter();
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null, signalCode: null, unref() {}, kill() { assert.fail("fixture never owns an OS PID"); } });
  return child;
}
function close(child, code = 0) {
  child.exitCode = code;
  child.emit("exit", code, null);
  child.stdout.end(); child.stderr.end(); child.stdin.end();
  child.emit("close", code, null);
}

test("normal close preserves exit evidence and disposes all owned listeners", async () => {
  const child = childFixture(), signal = new AbortController(), chunks = [];
  const p = observeCommandProcess({ child, signal: signal.signal, timeoutMs: 5000,
    onOutput: (stream, chunk) => chunks.push([stream, chunk.toString()]) });
  child.stdout.write("first"); child.stderr.write("second"); close(child, 7);
  const result = await p;
  assert.equal(result.exitCode, 7);
  assert.equal(result.observation.leaderExited, true);
  assert.equal(result.observation.stdioClosed, true);
  assert.equal(result.observation.descendants, "unverified");
  assert.equal(result.observation.stopReason, undefined);
  assert.equal(result.observation.settledBy, "close");
  assert.deepEqual(chunks, [["stdout", "first"], ["stderr", "second"]]);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(getEventListeners(signal.signal, "abort").length, 0);
  signal.abort(); child.stdout.emit("data", Buffer.from("late"));
  assert.equal(chunks.length, 2);
});

test("already-aborted signal is consumed after spawn without missing cancellation", async () => {
  const child = childFixture(), controller = new AbortController(); controller.abort();
  const p = observeCommandProcess({ child, signal: controller.signal, timeoutMs: 5000, onOutput() {} });
  close(child);
  const result = await p;
  assert.equal(result.observation.stopReason, "cancelled");
  assert.equal(result.observation.descendants, "unverified");
});

test("spawn error settles without pretending a leader exited", async () => {
  const child = childFixture();
  const p = observeCommandProcess({ child, timeoutMs: 5000, onOutput() {} });
  const error = Object.assign(new Error("fixture ENOENT"), { code: "ENOENT" }); child.emit("error", error);
  const result = await p;
  assert.equal(result.error, error);
  assert.equal(result.observation.settledBy, "spawn_error");
  assert.equal(result.observation.leaderExited, false);
  assert.equal(result.observation.stdioClosed, false);
  assert.equal(child.stdout.destroyed, true);
});

test("output observer failure stops collection without an uncaught stream callback", async () => {
  const child = childFixture(); let calls = 0;
  const error = new Error("stale execution fixture");
  const p = observeCommandProcess({ child, timeoutMs: 5000, onOutput() { calls++; throw error; } });
  assert.doesNotThrow(() => child.stdout.write("before stop"));
  close(child);
  const result = await p;
  assert.equal(result.error, error);
  assert.equal(result.observation.stopReason, "observer_error");
  child.stdout.emit("data", Buffer.from("late"));
  assert.equal(calls, 1);
});

test("timeout and idle timer race cannot postpone cleanup; cancellation takes precedence", { timeout: 5000 }, async () => {
  const child = childFixture(), controller = new AbortController();
  const started = Date.now();
  const p = observeCommandProcess({ child, signal: controller.signal, timeoutMs: 10, idleTimeoutMs: 10, onOutput() {} });
  const timer = setTimeout(() => controller.abort(), 40);
  try {
    const result = await p;
    assert.equal(result.observation.stopReason, "cancelled");
    assert.equal(result.observation.settledBy, "cleanup_deadline");
    assert.equal(result.observation.leaderExited, false);
    assert.equal(result.observation.stdioClosed, false);
    assert.ok(Date.now() - started < 2500);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally { clearTimeout(timer); }
});

test("leader exit without pipe close becomes incomplete output, not a success proof", { timeout: 5000 }, async () => {
  const child = childFixture();
  const p = observeCommandProcess({ child, timeoutMs: 10000, onOutput() {} });
  child.exitCode = 0; child.emit("exit", 0, null);
  const result = await p;
  assert.equal(result.exitCode, 0);
  assert.equal(result.observation.stopReason, "output_drain");
  assert.equal(result.observation.settledBy, "cleanup_deadline");
  assert.equal(result.observation.stdioClosed, false);
});

test("large timeout does not overflow into an immediate timeout", async () => {
  const child = childFixture();
  const p = observeCommandProcess({ child, timeoutMs: Number.MAX_SAFE_INTEGER, onOutput() {} });
  const timer = setTimeout(() => close(child), 30);
  try { assert.equal((await p).observation.stopReason, undefined); }
  finally { clearTimeout(timer); }
});
