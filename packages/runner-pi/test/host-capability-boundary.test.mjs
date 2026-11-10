import assert from "node:assert/strict";
import test from "node:test";
import { createPiTaskBoundary } from "../dist/task-boundary.js";

const yielded = { kind: "user_input_required", requestId: "host-question", requestVersion: 1 };
const request = Object.freeze({ toolCallId: "host-call", capabilityId: "host.local_network_info" });

function fixture(onTaskContinuationBoundary) {
  const controller = new AbortController();
  const calls = [];
  const result = { content: [{ type: "text", text: "fixture result" }] };
  const boundary = createPiTaskBoundary({ signal: controller.signal, onTaskContinuationBoundary,
    onHostCapabilityCall: input => { calls.push(input); return result; } });
  return { boundary, controller, calls, result, dispatch: () => boundary.options.onHostCapabilityCall(request) };
}

test("an open task boundary preserves the Host callback input and result", () => {
  const f = fixture();
  assert.equal(f.dispatch(), f.result);
  assert.deepEqual(f.calls, [request]);
  assert.equal(f.calls[0], request);
});

for (const state of ["cancelled", "yielded", "failed"]) {
  test(`a previously captured Host callback cannot dispatch after the task is ${state}`, async () => {
    const error = new Error("Host preparation failed");
    const f = fixture(async () => { if (state === "failed") throw error; return yielded; });
    const callback = f.boundary.options.onHostCapabilityCall;
    if (state === "cancelled") f.controller.abort();
    else await assert.rejects(f.boundary.options.onTaskContinuationBoundary("tool_call"),
      state === "failed" ? value => value === error : /Required user input/);
    const expected = state === "cancelled" ? { name: "AbortError" }
      : state === "failed" ? value => value === error : /Required user input/;
    assert.throws(() => callback(request), expected);
    assert.equal(f.calls.length, 0, "closed admission cannot reach a Host effect");
  });
}

test("closing one task does not revoke an independent task's Host callback", () => {
  const closed = fixture(), active = fixture();
  closed.controller.abort();
  assert.throws(closed.dispatch, { name: "AbortError" });
  assert.equal(active.dispatch(), active.result);
  assert.equal(closed.calls.length, 0);
  assert.deepEqual(active.calls, [request]);
});
