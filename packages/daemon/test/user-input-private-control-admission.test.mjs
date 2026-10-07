import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { resolveTeammateDirectExecutionContext } from "../dist/features/teammates/direct-execution-context.js";

for (const entry of ["interrupt_redirect", "promote"]) {
  test(`private required input rejects ${entry} before intervention or source mutations`, async t => {
    const f = await fixture(t);
    let path = `/teammates/${f.teammate.id}/direct-interventions`;
    let body = { mode: "interrupt_redirect", instruction: "Redirect now.", idempotencyKey: "private-redirect" };
    if (entry === "promote") {
      const intervention = f.store.createTeammateDirectReplyIntervention({ teammateId: f.teammate.id,
        threadId: f.directThread.id, sourceMessageId: f.sourceMessage.id, sourceWorkUnitId: f.unit.id,
        mode: "queue_followup", instruction: "Follow up later.", requestedBy: "local-user",
        idempotencyKey: "private-followup" }, f.now);
      path = `/teammate-direct-interventions/${intervention.id}/promote`;
      body = {};
    }
    const before = snapshot(f);
    const result = await post(f, path, body);
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error, "run_execution_recovery_blocked");
    assert.deepEqual(snapshot(f), before, "rejected guidance must not create or promote an intervention before admission");
  });
}

test("private queue-followup remains queued without disturbing a retained required source", async t => {
  const f = await fixture(t);
  const sourceBefore = sourceSnapshot(f);
  const result = await post(f, `/teammates/${f.teammate.id}/direct-interventions`, {
    mode: "queue_followup", instruction: "Continue later.", idempotencyKey: "private-allowed-followup",
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.intervention.status, "queued");
  assert.deepEqual(sourceSnapshot(f), sourceBefore);
});

test("private ordinary cancellation still succeeds without a required pause", async t => {
  const f = await fixture(t, false);
  const result = await post(f, `/teammate-direct-replies/${f.unit.id}/cancel`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(f.store.getRun(f.run.id).status, "cancelled");
  assert.equal(f.store.getWorkUnit(f.unit.id).status, "cancelled");
});

test("private safe yielded cancellation keeps the historical Run unchanged", async t => {
  const f = await fixture(t);
  f.store.commitUserInputYield({ threadId: f.execution.thread.id, requestId: f.request.requestId,
    expectedRequestVersion: 1, sourceFence: toRuntimeAttemptFence(f.attempt),
    quiescence: { kind: "runner_quiesced", runnerId: f.attempt.runnerId, stoppedAt: f.now, lastRunEventSeq: 0 } }, f.now);
  const runBefore = f.store.getRun(f.run.id);
  const result = await post(f, `/teammate-direct-replies/${f.unit.id}/cancel`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(f.store.getRun(f.run.id), runBefore);
  assert.equal(f.store.countEvents(f.run.id), 0);
  assert.equal(f.store.getWorkUnit(f.unit.id).status, "cancelled");
  assert.equal(f.store.getUserInputWait(f.execution.thread.id, f.request.requestId).status, "cancelled");
});

async function fixture(t, required = true) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-input-private-control-"));
  let store;
  const daemon = createDaemonServer({ defaultWorkspaceCwd: cwd, port: 0, channels: { terminalReports: false } }, {
    runner: { async runTask() { assert.fail("rejected guidance cannot dispatch a Runner"); } },
    storeFactory: storeCwd => { store = createSqliteRunStore(storeCwd); return store; },
  });
  await daemon.start();
  t.after(async () => { if (daemon.server.listening) await daemon.stop(); await rm(cwd, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${daemon.server.address().port}`;
  assert.equal((await fetch(`${url}/runtime?cwd=${encodeURIComponent(cwd)}`)).status, 200);
  const now = new Date().toISOString();
  const teammate = store.getAiTeammate("teammate_builtin_engineer");
  const directThread = store.getOrCreateTeammateDirectThread(teammate.id, now);
  const sourceMessage = store.createTeammateDirectMessage({ threadId: directThread.id, teammateId: teammate.id,
    authorType: "local-user", body: "Wait safely.", status: "ready" }, now);
  const replyMessage = store.createTeammateDirectMessage({ threadId: directThread.id, teammateId: teammate.id,
    authorType: "ai-teammate", authorId: teammate.id, body: "", status: "pending" }, now);
  const execution = resolveTeammateDirectExecutionContext({ store, teammate, directThread, sourceMessage, replyMessage,
    providerPresetId: "fixture", prompt: "Wait safely.", systemPrompt: "Private context only.",
    workspace: { executionCwd: cwd, thread: directThread,
      binding: { mode: "local", status: "ready", executionPath: cwd, updatedAt: now },
      snapshot: { mode: "local", status: "ready", workspaceCwd: cwd, executionCwd: cwd } } });
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "teammate_direct_reply",
    ownerType: "teammate_direct_message", ownerId: sourceMessage.id, teammateId: teammate.id,
    linkedMessageId: replyMessage.id, status: "running", idempotencyKey: "private-control-unit",
    createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "private-control-runtime", runnerId: "runner_pi_embedded", status: "started", now });
  const run = store.createRun({ id: "private-control-run", cwd, taskId: sourceMessage.id,
    threadId: execution.thread.id, turnId: execution.runRequest.turnId, teammateId: teammate.id,
    workUnitId: unit.id, providerName: "fixture", providerModel: "fixture", taskSnapshot: execution.runRequest.task,
    providerSnapshot: {}, requestSnapshot: execution.runRequest, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  assert.equal(store.transitionRunStatus({ runId: run.id, expectedStatus: "queued", event: "runner_started", actor: "runner", now }).ok, true);
  const authority = { ...toRuntimeAttemptFence(attempt), workspaceId: DEFAULT_WORKSPACE_ID,
    resourceType: "provider", resourceKey: "private-control-provider", ownerType: "work_unit_attempt",
    ownerId: attempt.id, acquiredAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  assert.ok(store.acquireResourceLease(authority));
  assert.ok(store.acquireRuntimeSemaphoreSlot({ ...authority, limit: 1 }));
  const request = required ? store.createUserInputRequest({ sourceRunId: run.id, sourceItemId: sourceMessage.id,
    sourceFence: toRuntimeAttemptFence(attempt), toolCallId: "private-required", idempotencyKey: "private-required",
    toolInput: { schemaVersion: 1, waitMode: "required", questions: [
      { questionId: "choice", prompt: "Choose", required: true, allowFreeText: true, options: [] },
    ] } }, now).request : undefined;
  return { cwd, store, daemon, url, now, teammate, directThread, sourceMessage, replyMessage, execution, unit, attempt, run, request };
}

function sourceSnapshot(f) {
  return { run: f.store.getRun(f.run.id), work: f.store.getWorkUnit(f.unit.id),
    attempt: f.store.getWorkUnitAttempt(f.attempt.id), events: f.store.listEvents(f.run.id),
    runtimeEvents: f.store.listRuntimeEvents(f.unit.id),
    leases: f.store.listResourceLeases({ attemptId: f.attempt.id }), slots: f.store.listRuntimeSemaphoreSlots({ attemptId: f.attempt.id }),
    messages: f.store.listTeammateDirectMessages({ teammateId: f.teammate.id, threadId: f.directThread.id, limit: 100 }) };
}

function snapshot(f) {
  return { ...sourceSnapshot(f), interventions: f.store.listTeammateDirectReplyInterventions({
    teammateId: f.teammate.id, threadId: f.directThread.id, limit: 100 }) };
}

async function post(f, path, body = {}) {
  const response = await fetch(`${f.url}${path}?cwd=${encodeURIComponent(f.cwd)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
