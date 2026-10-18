import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";

test("answer API persists one durable answer and replays the same idempotent submission", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-input-answer-api-"));
  let store;
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    channels: { terminalReports: false } }, {
    runner: { async runTask() { assert.fail("an answer accepted before the source yields must not dispatch"); } },
    storeFactory: storeCwd => { store = createSqliteRunStore(storeCwd); return store; },
  });
  await daemon.start();
  t.after(async () => {
    if (daemon.server.listening) await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${daemon.server.address().port}`;
  const runtime = await fetch(`${baseUrl}/runtime?cwd=${encodeURIComponent(cwd)}`);
  assert.equal(runtime.status, 200);

  const now = new Date().toISOString();
  const thread = store.createLingThread({ kind: "conversation", title: "Answer API", objective: "Persist an answer." }, now);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Answer API", userInstruction: "Choose a scope.",
    idempotencyKey: "answer-api-turn", payload: { body: "Choose a scope.", format: "markdown", mentions: [],
      attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now);
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run",
    ownerId: "answer-api-run", status: "running", idempotencyKey: "answer-api-unit",
    createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "answer-api-runtime", runnerId: "runner_pi_embedded", status: "started", now });
  const run = store.createRun({ id: "answer-api-run", cwd, taskId: "answer-api-task", threadId: thread.id,
    turnId: turn.turnId, workUnitId: unit.id, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  assert.equal(store.transitionRunStatus({ runId: run.id, expectedStatus: "queued", event: "runner_started",
    actor: "runner", now }).ok, true);
  const request = store.createUserInputRequest({ sourceRunId: run.id, sourceItemId: turn.item.id,
    sourceFence: toRuntimeAttemptFence(attempt), toolCallId: "answer-api-question", idempotencyKey: "answer-api-question",
    toolInput: { schemaVersion: 1, waitMode: "required", questions: [
      { questionId: "scope", prompt: "Choose a scope", required: true, allowFreeText: true, options: [] },
    ] } }, now).request;
  const submission = { schemaVersion: 1, requestId: request.requestId, expectedVersion: request.requestVersion,
    expectedStatusRevision: request.statusRevision, idempotencyKey: "answer-api-submission",
    answers: [{ questionId: "scope", kind: "text", text: "Keep the drawing workflow." }] };
  const path = `/threads/${encodeURIComponent(thread.id)}/user-input-requests/${encodeURIComponent(request.requestId)}/answers`
    + `?cwd=${encodeURIComponent(cwd)}`;

  const accepted = await post(baseUrl + path, submission);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.equal(accepted.body.requestId, request.requestId);
  assert.equal(accepted.body.replayed, false);
  assert.equal(store.getUserInputRequest(thread.id, request.requestId).status, "answered");
  assert.equal(store.getUserInputDelivery(thread.id, accepted.body.deliveryId).status, "pending");

  const replayed = await post(baseUrl + path, submission);
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  assert.equal(replayed.body.answerId, accepted.body.answerId);
  assert.equal(replayed.body.deliveryId, accepted.body.deliveryId);
  assert.equal(replayed.body.replayed, true);
});

async function post(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
