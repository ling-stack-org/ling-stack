import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeResourceRenewal } from "../../core/dist/index.js";
import { createRunExecutionSupervision } from "../dist/runtime/run-execution-supervision.js";

function fixture(t) {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const heartbeats = [];
  const now = "2026-10-19T12:00:00.000Z";
  const workUnit = { id: "unit", status: "running", timeoutPolicy: {
    heartbeatIntervalMs: 10, hardTimeoutMs: 10_000, idleTimeoutMs: 10_000,
  } };
  const attempt = { id: "attempt", workUnitId: workUnit.id, runtimeInstanceId: "runtime", fencingToken: 3 };
  const supervision = createRunExecutionSupervision({
    store: { recordRuntimeHeartbeat: input => heartbeats.push(input), getWorkUnit: () => workUnit },
    runId: "run", workUnit, attempt, activeRuns: { requestStop() { assert.fail("unexpected abort"); } },
    signal: new AbortController().signal, now: () => now,
  });
  t.after(() => supervision.dispose());
  return { supervision, heartbeats, now, attempt };
}

test("shared execution supervision does not publish pre-start heartbeat ownership", t => {
  const f = fixture(t);
  t.mock.timers.tick(30);
  assert.deepEqual(f.heartbeats, []);
  f.supervision.start();
  t.mock.timers.tick(10);
  assert.equal(f.heartbeats.length, 1);
});

test("shared Pi/native heartbeat renews the exact Attempt resources with an explicit deadline", t => {
  const f = fixture(t);
  f.supervision.start();
  f.supervision.heartbeat("runner", { event: "runner_started" });
  assert.deepEqual(f.heartbeats[0], {
    workUnitId: "unit", attemptId: f.attempt.id, runtimeInstanceId: f.attempt.runtimeInstanceId,
    fencingToken: f.attempt.fencingToken, ts: f.now,
    resourceExpiresAt: createRuntimeResourceRenewal(f.now).expiresAt,
    source: "runner", detail: { event: "runner_started" },
  });
  t.mock.timers.tick(10);
  assert.equal(f.heartbeats[1].resourceExpiresAt, createRuntimeResourceRenewal(f.now).expiresAt);
});

test("frozen delegation deadline aborts an in-flight request even during approval pause", t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const start = Date.parse("2026-10-19T12:00:00.000Z"); let clock = start;
  const stops = [], attempts = [];
  const unit = { id: "unit", status: "running", timeoutPolicy: {
    heartbeatIntervalMs: 1000, hardTimeoutMs: 10_000, idleTimeoutMs: 10_000,
  } };
  const supervision = createRunExecutionSupervision({
    store: { getWorkUnit: () => unit, recordRuntimeHeartbeat() {},
      transitionWorkUnitStatus(input) { assert.equal(input.event, "hard_timeout"); unit.status = "cancelling"; return { ok: true }; },
      updateWorkUnitAttemptStatus(input) { attempts.push(input); }, appendRuntimeEvent() {} },
    runId: "run", workUnit: unit, attempt: { id: "attempt", workUnitId: unit.id, runtimeInstanceId: "runtime", fencingToken: 3 },
    activeRuns: { requestStop(...args) { stops.push(args); } }, signal: new AbortController().signal,
    now: () => new Date(clock).toISOString(), absoluteDeadlineAt: new Date(start + 25).toISOString(),
  });
  t.after(() => supervision.dispose());
  supervision.start(); supervision.approvalWaitChanged(true);
  clock += 26; t.mock.timers.tick(26);
  assert.equal(stops.length, 1); assert.equal(stops[0][1].reason, "delegation.deadline_exceeded");
  assert.equal(attempts[0].attemptId, "attempt");
  supervision.dispose(); clock += 1000; t.mock.timers.tick(1000);
  assert.equal(stops.length, 1);
});
