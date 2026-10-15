import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";

const createdAt = "2026-10-16T10:00:00.000Z";
const requestedAt = "2026-10-16T10:00:01.000Z";
const stoppedAt = "2026-10-16T10:00:02.000Z";
const committedAt = "2026-10-16T10:00:03.000Z";
const later = "2026-10-16T10:00:04.000Z";
const teammateId = "teammate_builtin_engineer";

/**
 * Internal production-Store fixture only: this does not enable required input on
 * the default private HTTP route, run a Runner, or certify physical tool shutdown.
 * The empty Run has no tools/effects, so its real atomic yield is independently
 * admissible without manufacturing a waiting status, checkpoint, audit or anchor.
 */
async function fixture(t, { yieldNow = true } = {}) {
  const parent = await realpath(tmpdir());
  const cwd = await realpath(await mkdtemp(join(parent, "ling-a28-private-yield-")));
  const store = createSqliteRunStore(cwd);
  const db = new DatabaseSync(store.paths.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=1");
  t.after(async () => {
    db.close();
    store.close();
    assert.equal(dirname(cwd), parent);
    assert.ok(basename(cwd).startsWith("ling-a28-private-yield-"));
    await rm(cwd, { recursive: true, force: true });
  });
  const direct = store.getOrCreateTeammateDirectThread(teammateId, createdAt);
  const source = store.createTeammateDirectMessage({ threadId: direct.id, teammateId,
    authorType: "local-user", authorId: "local-user", body: "Ask for a theme before building", status: "ready" }, createdAt);
  const reply = store.createTeammateDirectMessage({ threadId: direct.id, teammateId,
    authorType: "ai-teammate", authorId: teammateId, body: "", status: "pending" }, createdAt);
  const thread = store.createLingThread({ kind: "teammate_direct", teammateId,
    title: "Private required-input proof", objective: "Preserve the same pending reply while yielded" }, createdAt);
  const accepted = store.appendTeammateDirectUserTurnWithInputSnapshot({ threadId: thread.id, teammateId,
    itemId: source.id, turnId: "private-yield-turn", title: "Choose theme", userInstruction: source.body,
    idempotencyKey: "private-yield-input", domainRefs: [{ type: "message", id: source.id }],
    payload: { body: source.body, format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    executionInput: { prompt: source.body, systemPrompt: "Ask before executing" },
  }, createdAt);
  const requestSnapshot = { cwd, teammateId, threadId: thread.id, turnId: accepted.turnId,
    teammateDirectInputRef: { id: accepted.inputSnapshot.id, fingerprint: accepted.inputSnapshot.fingerprint },
    sourceMessageId: source.id, linkedMessageId: reply.id,
    task: { id: source.id, title: "Choose theme", prompt: accepted.inputSnapshot.payload.prompt } };
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "teammate_direct_reply",
    ownerType: "teammate_direct_message", ownerId: source.id, teammateId, taskId: source.id,
    linkedMessageId: reply.id, runnerId: "pi", idempotencyKey: "private-yield-unit", status: "running",
    createdByActor: "system", request: requestSnapshot, now: createdAt });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "private-yield-runtime", runnerId: "pi", status: "started", now: createdAt });
  const fence = toRuntimeAttemptFence(attempt);
  const run = store.createRun({ id: "private-yield-run", cwd, taskId: source.id,
    teammateId, threadId: thread.id, turnId: accepted.turnId, workUnitId: unit.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: requestSnapshot.task,
    providerSnapshot: {}, requestSnapshot, createdAt });
  store.linkRunToWorkUnit(run.id, unit.id, createdAt);
  store.markRunStarted(run.id, createdAt);
  const scope = { workspaceId: DEFAULT_WORKSPACE_ID, teammateId, threadId: direct.id, messageId: reply.id };
  const observe = () => store.getTeammateDirectMessageRuntimeObservation(scope);
  const active = observe();
  assert.equal(active.state.kind, "active");
  const linked = store.commitTeammateDirectMessageRuntime({ expected: active,
    operation: { kind: "execution", fence, patch: { body: "等待选择主题", status: "pending", linkedRunId: run.id } } }, requestedAt);
  assert.equal(linked.kind, "applied");
  const beforeYield = observe();
  const request = store.createUserInputRequest({ sourceRunId: run.id, sourceItemId: accepted.item.id, sourceFence: fence,
    toolCallId: "private-required-question", idempotencyKey: "private-required-question",
    toolInput: { schemaVersion: 1, waitMode: "required", questions: [
      { questionId: "theme", prompt: "Choose the theme", required: true, allowFreeText: true,
        options: [{ optionId: "dark", label: "Dark" }, { optionId: "light", label: "Light" }] },
    ] },
  }, requestedAt).request;
  const yieldInput = { threadId: thread.id, requestId: request.requestId, expectedRequestVersion: 1,
    sourceFence: fence, quiescence: { kind: "runner_quiesced", runnerId: attempt.runnerId,
      stoppedAt, lastRunEventSeq: 0 } };
  const commitYield = () => store.commitUserInputYield(yieldInput, committedAt);
  if (yieldNow) assert.equal(commitYield().replayed, false);
  const row = () => db.prepare("SELECT * FROM teammate_direct_messages WHERE id=?").get(reply.id);
  const reconcile = (expected, status = "pending", body = "等待选择主题") => store.commitTeammateDirectMessageRuntime({
    expected, operation: { kind: "reconcile", patch: { body, status, linkedRunId: run.id, errorMessage: null } },
  }, later);
  return { cwd, store, db, direct, source, reply, thread, accepted, unit, attempt, fence, run,
    request, observe, row, reconcile, beforeYield, commitYield };
}

function assertInvalidProofCannotWrite(f) {
  const expected = f.observe(), before = f.row();
  assert.equal(expected.state.kind, "indeterminate", "damaged or superseded required-yield evidence is not a safe wait");
  for (const status of ["pending", "ready", "failed", "cancelled"]) {
    assert.equal(f.reconcile(expected, status, "must not overwrite the real reply").kind, "invalid_proof");
    assert.deepEqual(f.row(), before);
  }
}

/** One disposable adversarial mutation after the fixture first proves its genuine committed yield. */
function corruptAnchor(f, mutate) {
  const anchor = f.store.getConversationItem(f.request.itemId);
  const patch = mutate(anchor);
  for (const [column, value] of Object.entries(patch)) {
    assert.ok(["payload_json", "actor_id", "visibility_owner_id", "domain_refs_json", "status"].includes(column));
    f.db.prepare(`UPDATE conversation_items SET ${column}=? WHERE id=?`).run(value, anchor.id);
  }
}

test("A28 actual private required yield proves its canonical question anchor and preserves the pending native reply", async t => {
  const f = await fixture(t);
  const anchor = f.store.getConversationItem(f.request.itemId), wait = f.store.getUserInputWait(f.thread.id, f.request.requestId);
  assert.equal(anchor.kind, "user_input_request");
  assert.equal(anchor.threadId, f.thread.id);
  assert.equal(anchor.turnId, f.accepted.turnId);
  assert.equal(anchor.actorType, "teammate");
  assert.equal(anchor.actorId, teammateId);
  assert.equal(anchor.visibility, "agent_private");
  assert.equal(anchor.visibilityOwnerId, teammateId);
  assert.deepEqual(anchor.payload.runEventPosition, { runId: f.run.id, attemptId: f.attempt.id, afterEventSequence: 0 });
  assert.equal(wait.status, "waiting");
  assert.equal(f.store.getRun(f.run.id).status, "yielded");
  assert.equal(f.store.getWorkUnit(f.unit.id).status, "waiting_for_input");
  assert.equal(f.store.getWorkUnit(f.unit.id).activeAttemptId, undefined);
  assert.equal(f.store.getWorkUnitAttempt(f.attempt.id).status, "yielded");
  const expected = f.observe();
  assert.deepEqual(expected.state, { kind: "logical_wait", proof: { kind: "user_input_yield", id: f.request.requestId, revision: 1 } });
  assert.deepEqual(toRuntimeAttemptFence(expected.attempt), f.fence);
  assert.equal(f.reconcile(expected).kind, "unchanged");
  assert.equal(f.row().id, f.reply.id);
  assert.equal(f.row().status, "pending");
  assert.equal(f.row().linked_run_id, f.run.id);
  const before = f.row();
  assert.equal(f.commitYield().replayed, true);
  assert.deepEqual(f.row(), before);
  assert.deepEqual(f.observe(), expected, "read-only observation and idempotent yield cannot change its proof or message");
});

test("A28 required-yield CAS rejects old execution capability and cannot manufacture a terminal reply", async t => {
  const f = await fixture(t), before = f.row();
  const execute = expected => f.store.commitTeammateDirectMessageRuntime({ expected,
    operation: { kind: "execution", fence: f.fence, patch: { body: "late callback", status: "pending", linkedRunId: f.run.id } } }, later);
  assert.equal(execute(f.beforeYield).kind, "stale");
  assert.equal(execute(f.observe()).kind, "invalid_proof");
  for (const status of ["ready", "failed", "cancelled"]) assert.equal(f.reconcile(f.observe(), status).kind, "invalid_proof");
  assert.deepEqual(f.row(), before);
});

for (const [label, mutate] of [
  ["foreign request", anchor => ({ payload_json: JSON.stringify({ ...anchor.payload, requestId: "foreign-request" }) })],
  ["wrong request version", anchor => ({ payload_json: JSON.stringify({ ...anchor.payload, requestVersion: 2 }) })],
  ["foreign actor", () => ({ actor_id: "teammate_builtin_designer" })],
  ["foreign visibility owner", () => ({ visibility_owner_id: "teammate_builtin_designer" })],
  ["missing source reference", anchor => ({ domain_refs_json: JSON.stringify(anchor.domainRefs.filter(ref => ref.type !== "conversation_item")) })],
  ["wrong boundary Attempt", anchor => ({ payload_json: JSON.stringify({ ...anchor.payload,
    runEventPosition: { ...anchor.payload.runEventPosition, attemptId: "foreign-attempt" } }) })],
  ["future boundary sequence", anchor => ({ payload_json: JSON.stringify({ ...anchor.payload,
    runEventPosition: { ...anchor.payload.runEventPosition, afterEventSequence: 1, afterEventId: "nonexistent-event" } }) })],
]) {
  test(`A28 committed private yield rejects a canonical question anchor with ${label}`, async t => {
    const f = await fixture(t);
    assert.equal(f.observe().state.kind, "logical_wait", "the pre-corruption case must be a real proved yield");
    corruptAnchor(f, mutate);
    assertInvalidProofCannotWrite(f);
  });
}

test("A28 committed private yield rejects malformed wait checkpoint data", async t => {
  const f = await fixture(t);
  assert.equal(f.observe().state.kind, "logical_wait");
  f.db.prepare("UPDATE user_input_requests SET wait_checkpoint_json=? WHERE request_id=?")
    .run('{"schemaVersion":1,"requestId":"corrupt"}', f.request.requestId);
  assertInvalidProofCannotWrite(f);
});

test("A28 waiting status and valid checkpoint cannot replace the missing full-fence suspension audit", async t => {
  const f = await fixture(t);
  assert.equal(f.observe().state.kind, "logical_wait");
  assert.equal(Number(f.db.prepare(`DELETE FROM runtime_events WHERE work_unit_id=? AND attempt_id=?
    AND type='work_unit_waiting_for_input'`).run(f.unit.id, f.attempt.id).changes), 1);
  assertInvalidProofCannotWrite(f);
});

test("A28 waiting status and runtime audit cannot replace the missing atomic wait commit", async t => {
  const f = await fixture(t);
  assert.equal(f.observe().state.kind, "logical_wait");
  assert.equal(Number(f.db.prepare("DELETE FROM control_plane_events WHERE entity_id=? AND idempotency_key=?")
    .run(f.request.requestId, `user-input-wait:${f.request.requestId}:1`).changes), 1);
  assertInvalidProofCannotWrite(f);
});

test("A28 a real successor Attempt claim withdraws the old required-yield observation and write authority", async t => {
  const f = await fixture(t), old = f.observe();
  assert.equal(old.state.kind, "logical_wait");
  const successor = f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2,
    runtimeInstanceId: "private-yield-successor-runtime", runnerId: "pi", status: "started", now: later });
  assert.equal(f.store.getWorkUnit(f.unit.id).activeAttemptId, successor.id);
  assert.equal(f.store.getWorkUnitAttempt(f.attempt.id).status, "yielded", "claiming a new fence does not rewrite the old closed Attempt");
  const before = f.row();
  assert.equal(f.reconcile(old, "pending", "stale wait text").kind, "stale");
  assert.deepEqual(f.row(), before);
  assertInvalidProofCannotWrite(f);
});

test("A28 a question without the actual yield commit is active, not a fabricated logical wait", async t => {
  const f = await fixture(t, { yieldNow: false });
  assert.equal(f.store.getConversationItem(f.request.itemId).kind, "user_input_request");
  assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId), undefined);
  assert.equal(f.observe().state.kind, "active");
  const before = f.row();
  assert.equal(f.reconcile(f.observe(), "ready", "the question alone cannot finish the reply").kind, "invalid_proof");
  assert.deepEqual(f.row(), before);
});
