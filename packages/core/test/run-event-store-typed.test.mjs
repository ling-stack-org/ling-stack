import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";

test("sqlite run events keep typed payloads across reopen and reject malformed payloads", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-typed-events-"));
  const now = "2026-08-25T00:00:00.000Z";
  try {
    const store = createSqliteRunStore(cwd);
    store.createRun({
      id: "run_typed_events",
      cwd,
      taskId: "task_typed_events",
      providerName: "test",
      providerModel: "test-model",
      taskSnapshot: {},
      providerSnapshot: {},
      requestSnapshot: {},
      createdAt: now,
    });
    store.appendEvent("run_typed_events", "assistant_text_delta", { text: "hello" });
    store.appendEvent("run_typed_events", "tool_end", {
      toolCallId: "call-1",
      toolName: "bash",
      result: { stdout: "ok" },
      isError: false,
    });
    assert.throws(
      () => store.appendEvent("run_typed_events", "assistant_text_delta", { text: 42 }),
      /Invalid run event payload/,
    );
    assert.deepEqual(store.listEvents("run_typed_events", { limit: 10 }).map((event) => [event.type, event.data]), [
      ["assistant_text_delta", { text: "hello" }],
      ["tool_end", { toolCallId: "call-1", toolName: "bash", result: { stdout: "ok" }, isError: false }],
    ]);
    store.close();

    const reopened = createSqliteRunStore(cwd);
    try {
      const events = reopened.listEvents("run_typed_events", { limit: 10 });
      assert.equal(events[0].type, "assistant_text_delta");
      assert.equal(events[0].data.text, "hello");
      assert.equal(events[1].type, "tool_end");
      assert.equal(events[1].data.isError, false);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const type of ["tool_start", "tool_update", "tool_end"]) {
  test(`execution tool lineage stamps a missing Attempt on ${type} without rewriting old facts`, async t => {
    const f = await executionLineageFixture(t);
    const old = f.store.appendExecutionEvent(f.run.id, f.fence, type, toolPayload(type, "old-read", f.attempt.id));
    const next = f.replace();
    const current = f.store.appendExecutionEvent(f.run.id, toRuntimeAttemptFence(next), type, toolPayload(type, "new-read"));
    assert.equal(current.data.attemptId, next.id, "Host admission is the only authoritative new-call Attempt source");
    assert.equal(f.store.listEvents(f.run.id).find(event => event.id === old.id).data.attemptId, f.attempt.id);
    const log = await readFile(f.run.eventLogPath, "utf8");
    assert.equal(JSON.parse(log.trim().split("\n").at(-1)).data.attemptId, next.id);
    f.store.close();
    f.store = createSqliteRunStore(f.cwd);
    assert.deepEqual(f.store.listEvents(f.run.id).map(event => [event.id, event.data.attemptId]),
      [[old.id, f.attempt.id], [current.id, next.id]]);
  });

  test(`execution tool lineage rejects a mismatched explicit Attempt on ${type} before durable writes`, async t => {
    const f = await executionLineageFixture(t);
    f.store.appendExecutionEvent(f.run.id, f.fence, "tool_start", toolPayload("tool_start", "prior-read", f.attempt.id));
    const next = f.replace();
    const before = f.store.listEvents(f.run.id);
    const log = await readFile(f.run.eventLogPath, "utf8");
    assert.throws(() => f.store.appendExecutionEvent(f.run.id, toRuntimeAttemptFence(next), type,
      toolPayload(type, "hostile-new-read", f.attempt.id)), error => error.code === "run_event_attempt_mismatch");
    assert.deepEqual(f.store.listEvents(f.run.id), before);
    assert.equal(await readFile(f.run.eventLogPath, "utf8"), log);
  });
}

test("execution tool lineage retains the original fence rejection for a stale producer", async t => {
  const f = await executionLineageFixture(t);
  const historical = f.store.appendExecutionEvent(f.run.id, f.fence, "tool_start", toolPayload("tool_start", "historical-read", f.attempt.id));
  f.replace();
  const before = f.store.listEvents(f.run.id);
  const log = await readFile(f.run.eventLogPath, "utf8");
  for (const type of ["tool_start", "tool_update", "tool_end"]) {
    assert.throws(() => f.store.appendExecutionEvent(f.run.id, f.fence, type, toolPayload(type, "stale-new-read")),
      error => error.code === "stale_run_execution");
  }
  assert.deepEqual(f.store.listEvents(f.run.id), before);
  assert.equal(await readFile(f.run.eventLogPath, "utf8"), log);
  assert.equal(historical.data.attemptId, f.attempt.id);
});

function toolPayload(type, toolCallId, attemptId) {
  return { type, toolCallId, toolName: "read", ...(attemptId === undefined ? {} : { attemptId }),
    ...(type === "tool_start" ? { args: { path: "fixture.txt" } }
      : type === "tool_update" ? { partialResult: { content: [{ type: "text", text: "partial" }] } }
        : { result: { content: [{ type: "text", text: "complete" }] }, isError: false }) };
}

async function executionLineageFixture(t) {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-execution-lineage-"));
  const now = "2026-10-13T01:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run-lineage",
    idempotencyKey: "lineage-unit", status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "lineage-A", runnerId: "pi", status: "started", now });
  const run = store.createRun({ id: "run-lineage", cwd, workUnitId: unit.id, taskId: "task-lineage", providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  store.markRunStarted(run.id, now);
  const f = { cwd, store, unit, run, attempt, fence: toRuntimeAttemptFence(attempt),
    replace: () => f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 2,
      runtimeInstanceId: "lineage-B", runnerId: "pi", status: "started", now }) };
  t.after(async () => { f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  return f;
}
