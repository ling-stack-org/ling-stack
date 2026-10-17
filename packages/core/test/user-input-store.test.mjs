import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { resolveActiveUserInputSource } from "../dist/storage/sqlite/user-input-source.js";
import { createSqliteRunStore, resolveRuntimePaths, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";

const now = "2026-09-07T00:00:00.000Z";
const later = "2026-09-07T00:01:00.000Z";
const question = { schemaVersion: 1, waitMode: "required", questions: [{
  questionId: "theme", prompt: "选择主题", required: true, allowFreeText: true,
  options: [{ optionId: "dark", label: "深色" }, { optionId: "light", label: "浅色" }],
}] };

async function fixture(t, { surface = "normal" } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-user-input-store-"));
  const f = { cwd, store: createSqliteRunStore(cwd) };
  f.db = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  f.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10");
  t.after(async () => { f.db.close(); f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  const channel = f.store.createChannel({ name: "Question fixture", boundPath: cwd }, now);
  const channelId = surface === "channel" ? channel.id : undefined;
  f.thread = f.store.createLingThread({ kind: surface === "private" ? "teammate_direct" : surface === "channel" ? "channel_discussion" : "conversation",
    channelId, teammateId: "ling_agent", title: "问答", objective: "测试原子问答" }, now);
  f.turn = f.store.appendConversationUserTurn({
    threadId: f.thread.id, channelId, title: "Build", userInstruction: "Build a small project", idempotencyKey: "source-input",
    payload: { body: "Build a small project", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  }, now);
  f.task = f.store.createTask({ channelId: channel.id, title: "Question source", prompt: "Ask a question" }, now);
  f.unit = f.store.createWorkUnit({
    workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run-question",
    idempotencyKey: "question-work", status: "running", createdByActor: "system", request: {}, now,
  });
  f.attempt = f.store.createWorkUnitAttempt({
    workUnitId: f.unit.id, attemptNumber: 1, runtimeInstanceId: "runtime-question",
    runnerId: "runner_pi_embedded", status: "started", now,
  });
  f.run = f.store.createRun({
    id: "run-question", cwd, taskId: f.task.id, channelId, threadId: f.thread.id, turnId: f.turn.turnId,
    workUnitId: f.unit.id, teammateId: "ling_agent", providerName: "test", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now,
  });
  f.store.transitionRunStatus({ runId: f.run.id, expectedStatus: "queued", event: "runner_started", actor: "runner", now });
  f.store.linkRunToWorkUnit(f.run.id, f.unit.id, now);
  f.create = { sourceRunId: f.run.id, sourceItemId: f.turn.item.id, sourceFence: toRuntimeAttemptFence(f.attempt),
    toolCallId: "tool-question-1", idempotencyKey: "create-question-1", toolInput: question };
  f.ask = (override = {}) => f.store.createUserInputRequest({ ...f.create, ...override }, now).request;
  f.answer = (request, override = {}) => ({
    schemaVersion: 1, requestId: request.requestId, expectedVersion: request.requestVersion,
    expectedStatusRevision: request.statusRevision, idempotencyKey: "answer-1",
    answers: [{ questionId: "theme", kind: "option", optionId: "dark" }], ...override,
  });
  f.submit = (request, override = {}, at = now) =>
    f.store.submitUserInputAnswer({ threadId: f.thread.id, submission: f.answer(request, override) }, at);
  return f;
}
const code = (expected) => (error) => error.code === expected;

test("required input has one unresolved wait slot per source attempt", async (t) => {
  const f = await fixture(t);
  const request = f.ask();
  const next = { toolCallId: "second-question", idempotencyKey: "second-question" };
  assert.throws(() => f.ask(next), code("wait_conflict"));
  f.submit(request);
  assert.throws(() => f.ask(next), code("wait_conflict"), "an early answer does not release execution before yielding");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM user_input_requests").get().n, 1);
});

test("Host required-input lookup uses the original complete execution fence", async (t) => {
  const f = await fixture(t);
  const request = f.ask();
  const scope = { sourceRunId: f.run.id, sourceFence: f.create.sourceFence };
  assert.equal(f.store.findRequiredUserInputForAttempt(scope).requestId, request.requestId);
  for (const key of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
    assert.throws(() => f.store.findRequiredUserInputForAttempt({ ...scope,
      sourceFence: { ...scope.sourceFence, [key]: "foreign" } }), code("source_conflict"));
  }
  f.store.cancelUserInputRequest({ threadId: f.thread.id, requestId: request.requestId, expectedStatusRevision: 1 }, now);
  assert.equal(f.store.findRequiredUserInputForAttempt(scope), undefined);
});
const count = (f, table) => f.db.prepare("SELECT COUNT(*) AS n FROM " + table).get().n;

for (const surface of ["private", "channel"]) {
  test(surface + " stores request and answer under the same source visibility and thread", async (t) => {
    const f = await fixture(t, { surface });
    const request = f.ask();
    const receipt = f.submit(request);
    const expectedVisibility = surface === "private" ? "agent_private" : "channel";
    for (const itemId of [request.itemId, receipt.answerItemId]) {
      const item = f.store.getConversationItem(itemId);
      assert.equal(item.threadId, f.thread.id);
      assert.equal(item.visibility, expectedVisibility);
      assert.equal(item.visibilityOwnerId, surface === "private" ? "ling_agent" : undefined);
    }
    assert.equal(request.source.visibility, expectedVisibility);
    assert.equal(f.store.listPendingUserInputDeliveries({ threadId: f.thread.id }).length, 1);
  });
}

test("question creation derives source identity and atomically appends one canonical item and event", async (t) => {
  const f = await fixture(t);
  const request = f.ask();
  assert.equal(request.source.threadId, f.thread.id);
  assert.equal(request.source.turnId, f.turn.turnId);
  assert.equal(request.source.participantId, "ling_agent");
  assert.deepEqual(request.source.fence, toRuntimeAttemptFence(f.attempt));
  const item = f.store.getConversationItem(request.itemId);
  assert.equal(item.kind, "user_input_request");
  assert.deepEqual(item.payload, { requestId: request.requestId, requestVersion: 1,
    runEventPosition: { runId: f.run.id, attemptId: f.attempt.id, afterEventSequence: 0 } });
  assert.equal(item.actorType, "ling_agent");
  const replay = f.store.createUserInputRequest(f.create, later);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.request, request);
  assert.equal(count(f, "user_input_requests"), 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM control_plane_events WHERE entity_type='user_input_request'").get().n, 1);
});

test("creation rejects altered idempotency payload, forged owner and stale attempt fence", async (t) => {
  const f = await fixture(t);
  f.ask();
  assert.throws(() => f.ask({ toolInput: { ...question, waitMode: "optional" } }), code("idempotency_conflict"));
  assert.throws(() => f.ask({ toolCallId: "other-tool" }), code("idempotency_conflict"));
  assert.throws(() => f.ask({ toolInput: { ...question, participantId: "other" } }), code("invalid_input"));
  assert.throws(() => f.ask({ sourceFence: { ...f.create.sourceFence, fencingToken: "999" },
    toolCallId: "new-tool", idempotencyKey: "new-key" }), code("source_conflict"));
  assert.equal(count(f, "user_input_requests"), 1);
});

test("request reads, writes and pending delivery queries are scoped to the owning thread", async (t) => {
  const f = await fixture(t);
  const request = f.ask();
  const other = f.store.createLingThread({ kind: "conversation", title: "other", objective: "other" }, now);
  assert.equal(f.store.getUserInputRequest(other.id, request.requestId), undefined);
  assert.throws(() => f.store.submitUserInputAnswer({ threadId: other.id, submission: f.answer(request) }, now), code("not_found"));
  assert.deepEqual(f.store.listPendingUserInputDeliveries({ threadId: other.id }), []);
  assert.throws(() => f.ask({ sourceItemId: "missing-item", toolCallId: "other", idempotencyKey: "other" }), code("source_conflict"));
});

test("answer receipt is atomic, explicit, idempotent and does not claim delivery", async (t) => {
  const f = await fixture(t);
  const request = f.ask();
  const receipt = f.submit(request);
  const replay = f.submit(request, {}, later);
  assert.equal(receipt.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.answerId, receipt.answerId);
  assert.equal(replay.acceptedAt, now);
  assert.equal(count(f, "user_input_answers"), 1);
  assert.equal(count(f, "user_input_deliveries"), 1);
  const item = f.store.getConversationItem(receipt.answerItemId);
  assert.equal(item.kind, "user_input_answer");
  assert.equal(item.actorType, "local_user");
  assert.deepEqual(item.payload, { requestId: request.requestId, requestVersion: 1, answerId: receipt.answerId,
    runEventPosition: { runId: f.run.id, attemptId: f.attempt.id, afterEventSequence: 0 } });
  assert.equal(f.store.getUserInputRequest(f.thread.id, request.requestId).status, "answered");
  const [delivery] = f.store.listPendingUserInputDeliveries({ threadId: f.thread.id });
  assert.equal(delivery.deliveryId, receipt.deliveryId);
  assert.equal(delivery.status, "pending");
  assert.equal(delivery.consumerWorkUnitId, f.unit.id);
  assert.equal("targetRunId" in delivery, false);
  assert.throws(() => f.submit(request, { answers: [{ questionId: "theme", kind: "option", optionId: "light" }] }), code("idempotency_conflict"));
});

test("public answer authority is Host-recomputed for first acceptance and exact replay", async (t) => {
  const f = await fixture(t);
  const request = f.ask();
  const authority = f.store.readUserInputTranscript({ threadId: f.thread.id, itemIds: [request.itemId] })[0].answerAuthority;
  assert.match(authority.token, /^[a-f0-9]{64}$/u);
  const submit = (answerAuthority = authority, overrides = {}) => f.store.submitUserInputAnswer({
    threadId: answerAuthority.threadId,
    authority: answerAuthority,
    submission: f.answer(request, {
      expectedVersion: answerAuthority.requestVersion,
      expectedStatusRevision: answerAuthority.statusRevision,
      ...overrides,
    }),
  }, now);
  for (const [field, value, expected] of [
    ["runId", "foreign-run", "source_conflict"], ["attemptId", "foreign-attempt", "source_conflict"],
    ["participantId", "foreign-agent", "source_conflict"], ["requestVersion", 2, "source_conflict"],
    ["statusRevision", 2, "source_conflict"], ["token", "b".repeat(64), "source_conflict"],
  ]) {
    assert.throws(() => submit({ ...authority, [field]: value }), code(expected));
  }
  const receipt = submit();
  const replay = submit();
  assert.equal(replay.replayed, true);
  assert.equal(replay.answerId, receipt.answerId);
  assert.throws(() => submit(authority, { answers: [{ questionId: "theme", kind: "option", optionId: "light" }] }), code("idempotency_conflict"));
  assert.equal(count(f, "user_input_answers"), 1);
});

test("captured public authority cannot answer after owner loss, archive or cancellation", async (t) => {
  for (const invalidation of ["owner", "archive", "cancel"]) {
    const f = await fixture(t);
    const request = f.ask();
    const authority = f.store.readUserInputTranscript({ threadId: f.thread.id, itemIds: [request.itemId] })[0].answerAuthority;
    if (invalidation === "owner") f.db.prepare("UPDATE work_unit_attempts SET status='lost',ended_at=? WHERE id=?").run(now, f.attempt.id);
    if (invalidation === "archive") f.store.updateLingThread(f.thread.id, { status: "archived" }, now);
    if (invalidation === "cancel") f.store.cancelUserInputRequest({ threadId: f.thread.id, requestId: request.requestId, expectedStatusRevision: 1 }, now);
    assert.throws(() => f.store.submitUserInputAnswer({ threadId: f.thread.id, authority,
      submission: f.answer(request) }, now), code("stale_request"));
    assert.equal(count(f, "user_input_answers"), 0);
  }
});

test("answer validation rejects stale, expired, unknown or empty submissions before writes", async (t) => {
  const f = await fixture(t);
  const request = f.ask({ expiresAt: later });
  assert.throws(() => f.submit(request, { expectedStatusRevision: 9 }), code("stale_request"));
  assert.throws(() => f.submit(request, { answers: [] }), code("invalid_input"));
  assert.throws(() => f.submit(request, { answers: [{ questionId: "theme", kind: "option", optionId: "missing" }] }), code("unknown_option"));
  assert.throws(() => f.submit(request, {}, later), code("request_expired"));
  assert.equal(count(f, "user_input_answers"), 0);
  assert.equal(f.store.getUserInputRequest(f.thread.id, request.requestId).status, "pending");
});

test("cancel uses CAS and blocks subsequent answer publication", async (t) => {
  const f = await fixture(t);
  const request = f.ask();
  assert.throws(() => f.store.cancelUserInputRequest({ threadId: f.thread.id, requestId: request.requestId, expectedStatusRevision: 8 }, now), code("stale_request"));
  const cancelled = f.store.cancelUserInputRequest({ threadId: f.thread.id, requestId: request.requestId, expectedStatusRevision: 1 }, now);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.statusRevision, 2);
  assert.throws(() => f.submit(request, { expectedStatusRevision: 2 }), code("request_not_pending"));
  assert.equal(count(f, "user_input_deliveries"), 0);
});

test("request publication failure rolls back question, item sequence and invalidation", async (t) => {
  const f = await fixture(t);
  const before = f.store.getLingThread(f.thread.id).nextItemSequence;
  f.db.exec("CREATE TRIGGER reject_question BEFORE INSERT ON user_input_requests BEGIN SELECT RAISE(ABORT, 'reject question'); END");
  assert.throws(() => f.ask(), /reject question/);
  assert.equal(count(f, "user_input_requests"), 0);
  assert.equal(f.store.getLingThread(f.thread.id).nextItemSequence, before);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM conversation_items WHERE kind='user_input_request'").get().n, 0);
  f.db.exec("DROP TRIGGER reject_question");
  assert.ok(f.ask());
});

test("outbox insert and deferred commit failures roll back the entire answer receipt", async (t) => {
  const f = await fixture(t);
  const request = f.ask();
  const before = f.store.getLingThread(f.thread.id).nextItemSequence;
  f.db.exec("CREATE TRIGGER reject_delivery BEFORE INSERT ON user_input_deliveries BEGIN SELECT RAISE(ABORT, 'reject delivery'); END");
  assert.throws(() => f.submit(request), /reject delivery/);
  assert.equal(count(f, "user_input_answers"), 0);
  assert.equal(f.store.getUserInputRequest(f.thread.id, request.requestId).status, "pending");
  assert.equal(f.store.getLingThread(f.thread.id).nextItemSequence, before);
  f.db.exec("DROP TRIGGER reject_delivery");
  f.db.exec("CREATE TABLE user_input_commit_failure (id TEXT REFERENCES ling_threads(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER reject_commit AFTER INSERT ON user_input_deliveries BEGIN INSERT INTO user_input_commit_failure VALUES ('missing-thread'); END");
  assert.throws(() => f.submit(request), /FOREIGN KEY/);
  assert.equal(count(f, "user_input_answers"), 0);
  assert.equal(count(f, "user_input_deliveries"), 0);
  assert.equal(f.store.getLingThread(f.thread.id).nextItemSequence, before);
  f.db.exec("DROP TRIGGER reject_commit");
  assert.ok(f.submit(request));
});

test("control-plane publication failure cannot leave an accepted answer without invalidation", async (t) => {
  const f = await fixture(t);
  const request = f.ask();
  f.db.exec("CREATE TRIGGER reject_input_event BEFORE INSERT ON control_plane_events WHEN NEW.entity_type='user_input_request' BEGIN SELECT RAISE(ABORT, 'reject event'); END");
  assert.throws(() => f.submit(request), /reject event/);
  assert.equal(count(f, "user_input_answers"), 0);
  assert.equal(count(f, "user_input_deliveries"), 0);
  assert.equal(f.store.getUserInputRequest(f.thread.id, request.requestId).status, "pending");
});

test("database reopen preserves receipt and pending delivery without reaccepting answers", async (t) => {
  const f = await fixture(t);
  const request = f.ask();
  const receipt = f.submit(request);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  assert.equal(f.submit(request, {}, later).answerId, receipt.answerId);
  assert.equal(f.store.listPendingUserInputDeliveries({ threadId: f.thread.id }).length, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=131").get().n, 1);
});

test("two independently opened SQLite connections accept only one conflicting answer", async (t) => {
  const f = await fixture(t);
  const request = f.ask();
  const authority = f.store.readUserInputTranscript({ threadId: f.thread.id, itemIds: [request.itemId] })[0].answerAuthority;
  const gate = new SharedArrayBuffer(4);
  const jobs = ["dark", "light"].map((optionId) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        const { createSqliteRunStore } = await import(workerData.module);
        const store = createSqliteRunStore(workerData.cwd);
        parentPort.postMessage({ ready: true });
        if (Atomics.wait(new Int32Array(workerData.gate), 0, 0, 10000) === "timed-out") throw new Error("barrier timed out");
        try { const result = store.submitUserInputAnswer(workerData.input, workerData.now); parentPort.postMessage({ ok: true, answerId: result.answerId }); }
        catch (error) { parentPort.postMessage({ ok: false, code: error.code }); }
        finally { store.close(); }
      })().catch(error => { throw error; });
    `, { eval: true, workerData: {
      module: new URL("../dist/index.js", import.meta.url).href, cwd: f.cwd, gate, now,
      input: { threadId: f.thread.id, authority, submission: f.answer(request, { idempotencyKey: "answer-" + optionId, answers: [{ questionId: "theme", kind: "option", optionId }] }) },
    } });
    t.after(() => worker.terminate());
    let ready, readyReject;
    const readyPromise = new Promise((resolve, reject) => { ready = resolve; readyReject = reject; });
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error("worker timed out")), 15000);
      const fail = (error) => { clearTimeout(timer); readyReject(error); reject(error); };
      worker.on("message", message => {
        if (message.ready) ready();
        else { clearTimeout(timer); resolve(message); }
      });
      worker.on("error", fail);
      worker.on("exit", exit => fail(new Error("worker exited " + exit)));
    });
    // A startup failure may precede the result await; keep both promises observed.
    void result.catch(() => {});
    return { readyPromise, result };
  });
  await Promise.all(jobs.map(job => job.readyPromise));
  Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
  const results = await Promise.all(jobs.map(job => job.result));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok).code, "idempotency_conflict");
  assert.equal(count(f, "user_input_answers"), 1);
  assert.equal(count(f, "user_input_deliveries"), 1);
});

test("sensitive answers are rejected without rewriting user text or accepting a receipt", async (t) => {
  const f = await fixture(t);
  const request = f.ask();
  assert.throws(() => f.submit(request, { answers: [{ questionId: "theme", kind: "text", text: "sk-test-not-a-real-secret-123456" }] }), code("sensitive_input"));
  assert.equal(count(f, "user_input_answers"), 0);
});

test("source snapshots cannot silently change participant ownership on read or replay", async (t) => {
  const f = await fixture(t);
  const request = f.ask();
  const original = f.db.prepare("SELECT source_json FROM user_input_requests WHERE request_id=?").get(request.requestId).source_json;
  const changed = JSON.parse(original); changed.participantId = "different-agent";
  f.db.prepare("UPDATE user_input_requests SET source_json=? WHERE request_id=?").run(JSON.stringify(changed), request.requestId);
  assert.throws(() => f.store.getUserInputRequest(f.thread.id, request.requestId), code("invalid_record"));
  assert.throws(() => f.submit(request), code("invalid_record"));
  assert.equal(count(f, "user_input_answers"), 0);
});

test("creation rejects completed runs, foreign source turns and private source ownership", async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE run_sessions SET status='succeeded' WHERE id=?").run(f.run.id);
  assert.throws(() => f.ask(), code("source_conflict"));
  f.db.prepare("UPDATE run_sessions SET status='running' WHERE id=?").run(f.run.id);
  const other = f.store.appendConversationUserTurn({ threadId: f.thread.id, title: "Other", userInstruction: "Other",
    idempotencyKey: "other-source", payload: { body: "Other", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now);
  assert.throws(() => f.ask({ sourceItemId: other.item.id }), code("source_conflict"));
  const privateItem = f.store.appendConversationItem({ threadId: f.thread.id, turnId: f.turn.turnId,
    kind: "system_event", actorType: "system", visibility: "agent_private", visibilityOwnerId: "different-agent",
    payload: { eventType: "test", summary: "private source" } }, now);
  assert.throws(() => f.ask({ sourceItemId: privateItem.id }), code("source_conflict"));
  assert.equal(count(f, "user_input_requests"), 0);
  assert.ok(f.ask());
});

test("creation replay survives source termination but cannot create another question", async (t) => {
  const f = await fixture(t);
  const request = f.ask();
  f.db.prepare("UPDATE work_unit_attempts SET status='lost' WHERE id=?").run(f.attempt.id);
  assert.deepEqual(f.ask(), request);
  assert.throws(() => f.ask({ toolCallId: "later-tool", idempotencyKey: "later-key" }), code("source_conflict"));
  assert.equal(count(f, "user_input_requests"), 1);
});

test("question and cancellation invalidation failures roll back status, items and sequence", async (t) => {
  const f = await fixture(t);
  const before = f.store.getLingThread(f.thread.id).nextItemSequence;
  f.db.exec("CREATE TRIGGER reject_input_event BEFORE INSERT ON control_plane_events WHEN NEW.entity_type='user_input_request' BEGIN SELECT RAISE(ABORT, 'reject event'); END");
  assert.throws(() => f.ask(), /reject event/);
  assert.equal(f.store.getLingThread(f.thread.id).nextItemSequence, before);
  assert.equal(count(f, "user_input_requests"), 0);
  f.db.exec("DROP TRIGGER reject_input_event");
  const request = f.ask();
  f.db.exec("CREATE TRIGGER reject_input_event BEFORE INSERT ON control_plane_events WHEN NEW.entity_type='user_input_request' BEGIN SELECT RAISE(ABORT, 'reject event'); END");
  assert.throws(() => f.store.cancelUserInputRequest({ threadId: f.thread.id, requestId: request.requestId, expectedStatusRevision: 1 }, now), /reject event/);
  assert.deepEqual(f.store.getUserInputRequest(f.thread.id, request.requestId), request);
});

test("semantic answer order replays without republishing or mutating caller input", async (t) => {
  const f = await fixture(t);
  const request = f.ask({ toolInput: { ...question, questions: [...question.questions,
    { questionId: "size", prompt: "Size?", required: true, allowFreeText: true, options: [] }] } });
  const answers = [{ questionId: "theme", kind: "option", optionId: "dark" }, { questionId: "size", kind: "text", text: "Small" }];
  const before = structuredClone(answers);
  const first = f.submit(request, { answers });
  const replay = f.submit(request, { answers: [...answers].reverse() });
  assert.deepEqual(answers, before);
  assert.equal(first.answerId, replay.answerId);
  assert.equal(replay.replayed, true);
});

test("invalid expiry, sensitive questions and invalid delivery bounds cannot write", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.ask({ expiresAt: now }), code("request_expired"));
  assert.throws(() => f.ask({ expiresAt: "not-a-date" }), code("invalid_input"));
  assert.throws(() => f.ask({ toolInput: { ...question, questions: [{ ...question.questions[0], prompt: "sk-test-not-a-real-secret-123456" }] } }), code("sensitive_input"));
  for (const limit of [0, 501, NaN, 1.5]) assert.throws(() => f.store.listPendingUserInputDeliveries({ threadId: f.thread.id, limit }), code("invalid_input"));
  assert.equal(count(f, "user_input_requests"), 0);
});

test("workflow source guard rejects stale step status and participant or workspace mismatch", async (t) => {
  const f = await fixture(t, { surface: "channel" });
  let step = { id: "step-1", workspaceId: DEFAULT_WORKSPACE_ID, channelId: f.thread.channelId,
    status: "running", runId: f.run.id, toParticipantId: "ling_agent" };
  // Source guard unit test; Run/Turn/Item/Attempt still come from this fixture's real connection.
  const ports = {
    getRun: id => ({ ...f.store.getRun(id), workflowStepId: "step-1" }),
    getTask: id => f.store.getTask(id),
    getConversationItem: id => f.store.getConversationItem(id),
    getLingThread: id => f.store.getLingThread(id),
    getLingTurnForRun: id => f.store.getLingTurnForRun(id),
    getWorkUnit: id => f.store.getWorkUnit(id),
    getWorkUnitAttempt: id => f.store.getWorkUnitAttempt(id),
    getChannelWorkflowStep: () => step,
  };
  const valid = { ...step };
  assert.equal(resolveActiveUserInputSource(ports, f.create).workflowStepId, "step-1");
  for (const override of [{ status: "cancelled" }, { status: "succeeded" }, { status: "queued" },
    { toParticipantId: "another-agent" }, { workspaceId: "another-workspace" }, { runId: "another-run" }]) {
    step = { ...valid, ...override };
    assert.throws(() => resolveActiveUserInputSource(ports, f.create), code("source_conflict"));
  }
});
