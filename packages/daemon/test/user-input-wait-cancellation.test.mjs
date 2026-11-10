import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { ensureRunCancelled } from "../dist/features/runs/cancellation.js";
import { syncLingThreadForTerminalRun } from "../dist/features/runs/threads.js";

for (const transport of ["http", "rpc"]) {
  for (const replaced of [false, true]) {
    test(`${transport} cancels only the waiting logical owner: replaced=${replaced}`, { timeout: 10_000 }, async (t) => {
      const f = await fixture(t);
      if (replaced) f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2,
        runtimeInstanceId: "successor", runnerId: "runner_pi_embedded", status: "created", now: f.now });
      const unitBefore = f.store.getWorkUnit(f.unit.id);
      const runBefore = f.store.getRun(f.run.id);
      let invoke;
      if (transport === "http") invoke = async () => {
        const response = await fetch(`${f.url}/runs/${f.run.id}/cancel?cwd=${encodeURIComponent(f.cwd)}`, { method: "POST" });
        return { status: response.status, body: await response.json() };
      };
      else {
        const rpc = await rpcClient(t, f.url.replace("http:", "ws:") + "/rpc/stream?cwd=" + encodeURIComponent(f.cwd));
        await rpc("initialize", {});
        invoke = async () => {
          const result = await rpc("runs.cancel", { cwd: f.cwd, runId: f.run.id });
          return result.error ? { status: 409, body: { error: result.error.message }, rpcError: result.error }
            : { status: 200, body: result.result };
        };
      }
      const result = await invoke();
      assert.equal(result.status, replaced ? 409 : 200, JSON.stringify(result.body));
      if (replaced) {
        if (transport === "rpc") assert.equal(result.rpcError.code, -32009);
        assert.deepEqual(f.store.getWorkUnit(f.unit.id), unitBefore);
        assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId).status, "waiting");
      } else {
        assert.equal(result.body.cancelled, true);
        assert.equal(result.body.active, false);
        assert.equal(result.body.run.status, "yielded");
        assert.equal(result.body.inputWait.requestId, f.request.requestId);
        assert.equal(result.body.inputWait.status, "cancelled");
        assert.equal(result.body.inputWait.waitRevision, 2);
        assert.equal(result.body.inputWait.workUnitId, f.unit.id);
        const replay = await invoke();
        assert.deepEqual(replay.body.inputWait, result.body.inputWait);
        assert.equal(f.store.getWorkUnit(f.unit.id).status, "cancelled");
      }
      assert.deepEqual(f.store.getRun(f.run.id), runBefore);
      assert.equal(f.store.countEvents(f.run.id), 0);
    });
  }
}

test("waiting cancellation never emits an old-run stream event", async (t) => {
  const f = await fixture(t);
  const result = ensureRunCancelled({ store: f.store, runId: f.run.id, taskId: f.run.taskId,
    reason: "user_requested", active: false, streamEnvelope: () => assert.fail("yielded Run cannot stream new execution") });
  assert.equal(result.inputWait.status, "cancelled");
  assert.equal(result.event, undefined);
});

for (const status of ["succeeded", "failed", "cancelled"]) {
  test(`terminal callback keeps an independent input wait visible: ${status}`, async (t) => {
    const f = await fixture(t);
    const turn = f.store.getLingTurnForRun(f.run.id);
    const sibling = f.store.createRun({ id: "terminal-sibling", cwd: f.cwd, taskId: "other-task", threadId: f.thread.id,
      turnId: turn.id, providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {},
      requestSnapshot: {}, createdAt: f.now });
    f.store.markRunStarted(sibling.id, f.now);
    const transitioned = f.store.transitionRunStatus({ runId: sibling.id, expectedStatus: "running",
      event: status === "succeeded" ? "runner_succeeded" : status === "failed" ? "runner_failed" : "cancel",
      actor: "system", now: f.now, endedAt: f.now });
    assert.equal(transitioned.ok, true);
    syncLingThreadForTerminalRun(f.store, sibling.id, f.now);
    assert.equal(f.store.getLingTurn(turn.id).status, "waiting_for_input");
    assert.equal(f.store.getLingThread(f.thread.id).status, "waiting_for_input");
    assert.equal(f.store.getLingThread(f.thread.id).activeRunId, undefined);
    assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId).status, "waiting");
  });
}

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-wait-cancel-host-"));
  let store;
  const daemon = createDaemonServer({ defaultWorkspaceCwd: cwd, port: 0, channels: { terminalReports: false } }, {
    runner: { async runTask() { assert.fail("cancelling a wait must not start a Runner"); } },
    storeFactory: storeCwd => { store = createSqliteRunStore(storeCwd); return store; },
  });
  await daemon.start();
  t.after(async () => { if (daemon.server.listening) await daemon.stop(); await rm(cwd, { recursive: true, force: true }); });
  const now = "2026-09-07T00:00:00.000Z";
  const thread = store.createLingThread({ kind: "conversation", title: "wait", objective: "wait" }, now);
  const accepted = store.appendConversationUserTurn({ threadId: thread.id, title: "work", userInstruction: "work",
    idempotencyKey: "work", payload: { body: "work", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now);
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "waiting-run",
    status: "running", idempotencyKey: "wait", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "wait-runtime",
    runnerId: "runner_pi_embedded", status: "started", now });
  const run = store.createRun({ id: "waiting-run", cwd, taskId: "snapshot-task", threadId: thread.id, turnId: accepted.turnId,
    workUnitId: unit.id, providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  store.transitionRunStatus({ runId: run.id, expectedStatus: "queued", event: "runner_started", actor: "runner", now });
  const request = store.createUserInputRequest({ sourceRunId: run.id, sourceItemId: accepted.item.id, sourceFence: toRuntimeAttemptFence(attempt),
    toolCallId: "question", idempotencyKey: "question", toolInput: { schemaVersion: 1, waitMode: "required", questions: [
      { questionId: "choice", prompt: "请选择", required: true, allowFreeText: true, options: [] },
    ] } }, now).request;
  store.commitUserInputYield({ threadId: thread.id, requestId: request.requestId, expectedRequestVersion: 1,
    sourceFence: toRuntimeAttemptFence(attempt), quiescence: { kind: "runner_quiesced", runnerId: attempt.runnerId,
      stoppedAt: now, lastRunEventSeq: 0 } }, now);
  return { cwd, store, daemon, thread, unit, run, request, now, url: `http://127.0.0.1:${daemon.server.address().port}` };
}

async function rpcClient(t, url) {
  const ws = new WebSocket(url, { handshakeTimeout: 2_000 });
  t.after(() => ws.terminate());
  const pending = new Map();
  let seq = 0;
  ws.on("message", raw => {
    const response = JSON.parse(String(raw));
    const resolve = pending.get(response.id);
    if (resolve) { pending.delete(response.id); resolve(response); }
  });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return (method, params) => new Promise(resolve => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

test("a real daemon restart keeps input waiting while recovering a crashed sibling", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const turn = f.store.getLingTurnForRun(f.run.id);
  const sibling = f.store.createRun({ id: "crashed-sibling", cwd: f.cwd, taskId: "other-task", threadId: f.thread.id,
    turnId: turn.id, providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {},
    requestSnapshot: {}, createdAt: f.now });
  f.store.markRunStarted(sibling.id, f.now);
  f.store.updateLingThread(f.thread.id, { status: "running", activeRunId: sibling.id, lastRunId: sibling.id }, f.now);
  const oldRun = f.store.getRun(f.run.id);
  const oldWait = f.store.getUserInputWait(f.thread.id, f.request.requestId);
  await f.daemon.stop();
  let store;
  const restarted = createDaemonServer({ defaultWorkspaceCwd: f.cwd, port: 0, channels: { terminalReports: false } }, {
    runner: { async runTask() { assert.fail("startup must not run a waiting task without an accepted answer"); } },
    storeFactory: cwd => { store = createSqliteRunStore(cwd); return store; },
  });
  try {
    await restarted.start();
    const url = `http://127.0.0.1:${restarted.server.address().port}`;
    const response = await fetch(`${url}/threads/${f.thread.id}?cwd=${encodeURIComponent(f.cwd)}`);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.thread.status, "waiting_for_input");
    assert.equal(detail.thread.activeRunId, undefined);
    assert.equal(store.getRun(sibling.id).status, "failed");
    assert.deepEqual(store.getRun(f.run.id), oldRun);
    assert.deepEqual(store.getUserInputWait(f.thread.id, f.request.requestId), oldWait);
    assert.equal(store.getWorkUnit(f.unit.id).status, "waiting_for_input");
    assert.equal(store.getLingTurn(turn.id).status, "waiting_for_input");
    assert.equal(store.getLingTurn(turn.id).completedAt, undefined);
    assert.equal(store.listWorkUnitAttempts(f.unit.id).length, 1);
    assert.equal(store.listRuntimeSemaphoreSlots({ workUnitId: f.unit.id, status: "active" }).length, 0);
  } finally { if (restarted.server.listening) await restarted.stop(); }
});
