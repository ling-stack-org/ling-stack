import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";

for (const entry of ["work_unit_cancel", "work_unit_reconcile", "interrupt_redirect", "promote"]) {
  test(`required input rejects ${entry} before control-plane mutations`, async t => {
    const f = await fixture(t);
    let path;
    let body = {};
    if (entry === "promote") {
      const intervention = f.store.createRunIntervention({ sourceRunId: f.run.id, sourceWorkUnitId: f.unit.id,
        sourceAttemptId: f.attempt.id, mode: "queue_followup", instruction: "Follow up later.",
        requestedBy: "local-user", idempotencyKey: "followup" }, f.now);
      path = `/run-interventions/${intervention.id}/promote`;
    } else if (entry === "interrupt_redirect") {
      path = `/runs/${f.run.id}/interventions`;
      body = { mode: "interrupt_redirect", instruction: "Redirect now.", idempotencyKey: "redirect" };
    } else {
      path = `/work-units/${f.unit.id}/${entry === "work_unit_cancel" ? "cancel" : "reconcile"}`;
    }
    const before = snapshot(f);
    const result = await post(f, path, body);
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error, "run_execution_recovery_blocked");
    assert.deepEqual(snapshot(f), before, "rejected control requests must not write, release, or terminalize the source");
  });
}

test("work-unit cancellation maps a cancelling source conflict to a domain 409", async t => {
  const f = await fixture(t, false);
  f.store.updateWorkUnitAttemptStatus({ ...toRuntimeAttemptFence(f.attempt), status: "cancelling",
    now: f.now, abortRequestedAt: f.now });
  const before = snapshot(f);
  const result = await post(f, `/work-units/${f.unit.id}/cancel`);
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error, "run_execution_recovery_blocked");
  assert.deepEqual(snapshot(f), before);
});

test("queue-followup remains available while a required source is retained", async t => {
  const f = await fixture(t);
  const result = await post(f, `/runs/${f.run.id}/interventions`, {
    mode: "queue_followup", instruction: "Follow up after this work.", idempotencyKey: "allowed-followup",
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.intervention.status, "queued");
  assert.equal(f.store.getRun(f.run.id).status, "running");
  assert.equal(f.store.getWorkUnitAttempt(f.attempt.id).status, "started");
  assert.equal(f.store.listResourceLeases({ attemptId: f.attempt.id })[0].status, "active");
});

test("manual reconciliation of an ordinary terminal linked Run keeps its existing resource cleanup", async t => {
  const f = await fixture(t, false);
  assert.equal(f.store.transitionRunStatus({ runId: f.run.id, expectedStatus: "running", event: "runner_succeeded",
    actor: "runner", now: f.now, endedAt: f.now }).ok, true);
  const result = await post(f, `/work-units/${f.unit.id}/reconcile`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.workUnit.status, "stale");
  assert.equal(f.store.getRun(f.run.id).status, "succeeded");
  assert.equal(f.store.listResourceLeases({ attemptId: f.attempt.id, status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ attemptId: f.attempt.id, status: "active" }).length, 0);
});

async function fixture(t, required = true) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-input-control-admission-"));
  let store;
  const daemon = createDaemonServer({ defaultWorkspaceCwd: cwd, port: 0, channels: { terminalReports: false } }, {
    runner: { async runTask() { assert.fail("rejected control requests cannot dispatch a Runner"); } },
    storeFactory: storeCwd => { store = createSqliteRunStore(storeCwd); return store; },
  });
  await daemon.start();
  t.after(async () => {
    if (daemon.server.listening) await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${daemon.server.address().port}`;
  // Establish the live runtime before creating the retained source; startup
  // recovery is a separate contract, not part of manual-control admission.
  const runtime = await fetch(`${url}/runtime?cwd=${encodeURIComponent(cwd)}`);
  assert.equal(runtime.status, 200);
  const now = new Date().toISOString();
  const thread = store.createLingThread({ kind: "conversation", title: "Retained source", objective: "Wait safely." }, now);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Wait safely", userInstruction: "Wait safely.",
    idempotencyKey: "control-turn", payload: { body: "Wait safely.", format: "markdown", mentions: [],
      attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now);
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run",
    ownerId: "retained-control-run", status: "running", idempotencyKey: "retained-control-unit",
    createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "control-runtime", runnerId: "runner_pi_embedded", status: "started", now });
  const run = store.createRun({ id: "retained-control-run", cwd, taskId: "retained-control-task", threadId: thread.id,
    turnId: turn.turnId, workUnitId: unit.id, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  assert.equal(store.transitionRunStatus({ runId: run.id, expectedStatus: "queued", event: "runner_started",
    actor: "runner", now }).ok, true);
  const authority = { ...toRuntimeAttemptFence(attempt), workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "provider",
    resourceKey: "retained-control-provider", ownerType: "work_unit_attempt", ownerId: attempt.id,
    acquiredAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  assert.ok(store.acquireResourceLease(authority));
  assert.ok(store.acquireRuntimeSemaphoreSlot({ ...authority, limit: 1 }));
  if (required) store.createUserInputRequest({ sourceRunId: run.id, sourceItemId: turn.item.id,
    sourceFence: toRuntimeAttemptFence(attempt), toolCallId: "required-control", idempotencyKey: "required-control",
    toolInput: { schemaVersion: 1, waitMode: "required", questions: [
      { questionId: "choice", prompt: "Choose", required: true, allowFreeText: true, options: [] },
    ] } }, now);
  return { cwd, store, daemon, url, run, unit, attempt, now };
}

function snapshot(f) {
  return {
    run: f.store.getRun(f.run.id),
    work: f.store.getWorkUnit(f.unit.id),
    attempt: f.store.getWorkUnitAttempt(f.attempt.id),
    runEvents: f.store.listEvents(f.run.id),
    runtimeEvents: f.store.listRuntimeEvents(f.unit.id),
    interventions: f.store.listRunInterventions({ sourceRunId: f.run.id }),
    leases: f.store.listResourceLeases({ attemptId: f.attempt.id }),
    slots: f.store.listRuntimeSemaphoreSlots({ attemptId: f.attempt.id }),
  };
}

async function post(f, path, body = {}) {
  const response = await fetch(`${f.url}${path}?cwd=${encodeURIComponent(f.cwd)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
