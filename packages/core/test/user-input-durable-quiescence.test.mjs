import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";
import { assertUserInputQuiescence } from "../dist/storage/sqlite/user-input-wait-evidence.js";

const createdAt = "2026-10-03T00:00:00.000Z";
const settledAt = "2026-10-03T00:00:01.000Z";
const stoppedAt = "2026-10-03T00:00:02.000Z";
const committedAt = "2026-10-03T00:00:03.000Z";
const code = expected => error => error.code === expected;

/** Uses the actual migrated store plus a separate SQLite writer; never modifies a real workspace. */
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-u-durable-quiescence-"));
  const store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=50");
  t.after(async () => { database.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const thread = store.createLingThread({ kind: "conversation", title: "Required question", objective: "Safe yield" }, createdAt);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Build", userInstruction: "Build",
    idempotencyKey: "source", payload: { body: "Build", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, createdAt);
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run",
    ownerId: "source-run", taskId: "snapshot-task", idempotencyKey: "source-unit", status: "running", createdByActor: "system", request: {}, now: createdAt });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "source-runtime",
    runnerId: "runner_pi_embedded", status: "started", now: createdAt });
  const fence = toRuntimeAttemptFence(attempt);
  const run = store.createRun({ id: "source-run", cwd, taskId: "snapshot-task", threadId: thread.id, turnId: turn.turnId,
    workUnitId: unit.id, providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt });
  store.markRunStarted(run.id, createdAt);
  store.linkRunToWorkUnit(run.id, unit.id, createdAt);
  const request = store.createUserInputRequest({ sourceRunId: run.id, sourceItemId: turn.item.id, sourceFence: fence,
    toolCallId: "ask", idempotencyKey: "ask", toolInput: { schemaVersion: 1, waitMode: "required",
      questions: [{ questionId: "choice", prompt: "Choose", required: true, allowFreeText: true, options: [] }] } }, createdAt).request;
  const slot = store.acquireRuntimeSemaphoreSlot({ ...fence, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "runner",
    resourceKey: "runner_pi_embedded", limit: 1, ownerType: "work_unit_attempt", ownerId: attempt.id,
    acquiredAt: createdAt, expiresAt: "2026-10-03T01:00:00.000Z" });
  assert.ok(slot);
  const f = { cwd, store, database, thread, turn, unit, attempt, fence, run, request };
  f.proof = () => ({ kind: "runner_quiesced", runnerId: attempt.runnerId, stoppedAt,
    lastRunEventSeq: Number(database.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM run_events WHERE run_id=?").get(run.id).n) });
  f.check = () => assertUserInputQuiescence(database, run.id, f.proof(), committedAt, fence);
  f.yield = () => store.commitUserInputYield({ threadId: thread.id, requestId: request.requestId, expectedRequestVersion: 1,
    sourceFence: fence, quiescence: f.proof() }, committedAt);
  f.submit = () => store.submitUserInputAnswer({ threadId: thread.id, submission: { schemaVersion: 1,
    requestId: request.requestId, expectedVersion: 1, expectedStatusRevision: 1, idempotencyKey: "answer",
    answers: [{ questionId: "choice", kind: "text", text: "blue" }] } }, settledAt);
  return f;
}

function event(f, type, data, ts = settledAt, runId = f.run.id) {
  const seq = Number(f.database.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM run_events WHERE run_id=?").get(runId).n);
  f.database.prepare("INSERT INTO run_events(id,run_id,seq,ts,type,data_json) VALUES(?,?,?,?,?,?)")
    .run(`${runId}-${seq}`, runId, seq, ts, type, JSON.stringify(data));
}
function tool(f, name, id = "effect") {
  event(f, "tool_start", { toolCallId: id, toolName: name, input: {} });
  event(f, "tool_end", { toolCallId: id, toolName: name, isError: false, output: "finished" });
}
function broker(f, state, overrides = {}) {
  const artifact = f.store.createArtifact({ runId: f.run.id, type: "json", path: "harness/policy.json",
    sealedPayload: {}, createdAt });
  const row = f.store.prepareHarnessToolExecution({ runId: f.run.id, workUnitId: f.unit.id, sourceFence: f.fence,
    toolCallId: "effect", toolName: "write", executorKind: "write", requestDigest: "a".repeat(64),
    sideEffectFingerprint: "b".repeat(64), policySnapshotArtifactId: artifact.id, approvalState: "allowed",
    sandboxProfileId: "workspace_write", now: createdAt }).execution;
  const started = ["executing", "committing_evidence", "succeeded", "unknown_outcome"].includes(state) ? createdAt : null;
  const finished = ["succeeded", "denied", "failed", "cancelled", "superseded", "unknown_outcome"].includes(state) ? settledAt : null;
  f.database.prepare("UPDATE harness_tool_executions SET state=?,execution_started_at=?,execution_finished_at=?,updated_at=? WHERE id=?")
    .run(state, started, finished, settledAt, row.id);
  for (const [column, value] of Object.entries(overrides)) {
    assert.ok(["execution_started_at", "execution_finished_at", "result_digest", "result_summary_json", "updated_at", "tool_name", "executor_kind", "work_unit_id"].includes(column));
    f.database.prepare(`UPDATE harness_tool_executions SET ${column}=? WHERE id=?`).run(value, row.id);
  }
  return row;
}
function prepared(f) {
  return { executionId: "command", toolCallId: "effect", source: f.fence, workspace: { path: f.cwd, realPath: f.cwd },
    cwd: f.cwd, commandDigest: "c".repeat(64) };
}
function snapshot(f) {
  return { run: f.store.getRun(f.run.id), unit: f.store.getWorkUnit(f.unit.id), attempt: f.store.getWorkUnitAttempt(f.attempt.id),
    request: f.store.getUserInputRequest(f.thread.id, f.request.requestId), slots: f.store.listRuntimeSemaphoreSlots({ workUnitId: f.unit.id, status: "active" }),
    events: f.store.listRuntimeEvents(f.unit.id), controls: f.database.prepare("SELECT * FROM control_plane_events").all() };
}

test("empty source can yield and claim with its original complete fence", async t => {
  const f = await fixture(t);
  f.check();
  const receipt = f.submit();
  f.yield();
  const delivery = f.store.claimUserInputDelivery({ threadId: f.thread.id, deliveryId: receipt.deliveryId,
    expectedRevision: 1, ownerId: "host", leaseMs: 1000 }, committedAt);
  assert.equal(delivery.status, "claimed");
});

for (const state of ["proposed", "prepared", "approval_pending", "approved", "claimed", "executing", "committing_evidence", "unknown_outcome"]) {
  test(`same-source durable Broker ${state} blocks atomic yield and preserves resources`, async t => {
    const f = await fixture(t);
    broker(f, state);
    const before = snapshot(f);
    assert.throws(f.yield, code("not_quiescent"));
    assert.deepEqual(snapshot(f), before);
    assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId), undefined);
  });
}
for (const state of ["denied", "failed", "cancelled", "superseded"]) {
  test(`durable pre-effect ${state} is no-start, not an unknown running effect`, async t => {
    const f = await fixture(t);
    broker(f, state);
    tool(f, "write");
    f.check();
    assert.equal(f.yield().wait.status, "waiting");
  });
}
for (const [state, outcome] of [["succeeded", "applied"], ["failed", "not_applied"], ["cancelled", "rolled_back"]]) {
  test(`started file ${state}/${outcome} summary without exact sealed Host evidence cannot certify stop`, async t => {
    const f = await fixture(t);
    broker(f, state, { execution_started_at: createdAt, result_digest: "d".repeat(64), result_summary_json: JSON.stringify({ outcome }) });
    tool(f, "write");
    // A terminal Broker row and an outcome string are not the exact sealed
    // operation receipt. Positive full-evidence coverage lives in the journal
    // suite and the production File Broker → required-input integration test.
    const before = snapshot(f);
    assert.throws(f.yield, code("not_quiescent"));
    assert.deepEqual(snapshot(f), before);
    assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId), undefined);
  });
}
for (const overrides of [
  {}, { result_digest: "d".repeat(64), result_summary_json: "{}" },
  { result_digest: "d".repeat(64), result_summary_json: JSON.stringify({ outcome: "diverged" }) },
  { result_digest: "d".repeat(64), result_summary_json: JSON.stringify({ outcome: "applied" }), execution_finished_at: committedAt },
]) {
  test(`started file incomplete/unknown/late durable evidence blocks: ${JSON.stringify(overrides)}`, async t => {
    const f = await fixture(t);
    broker(f, "succeeded", overrides);
    assert.throws(f.yield, code("not_quiescent"));
  });
}

for (const settlement of [undefined, { executionId: "command", outcome: "stop_unconfirmed", ownerCurrent: true },
  { executionId: "command", outcome: "completed", ownerCurrent: true, observation: { scope: "process_group",
    leaderExited: true, stdioClosed: true, descendants: "unverified", settledBy: "close", signalFailures: [] } }]) {
  test(`command ${settlement?.outcome ?? "prepared"} cannot prove physical quiescence`, async t => {
    const f = await fixture(t);
    event(f, "host_command_prepared", prepared(f));
    if (settlement) event(f, "host_command_settled", settlement);
    const before = snapshot(f);
    assert.throws(f.yield, code("not_quiescent"));
    assert.deepEqual(snapshot(f), before);
  });
}
test("command journal exact not-started settlement permits its matched tool", async t => {
  const f = await fixture(t);
  event(f, "host_command_prepared", prepared(f));
  event(f, "host_command_settled", { executionId: "command", outcome: "not_started", ownerCurrent: true });
  tool(f, "bash");
  assert.equal(f.yield().wait.status, "waiting");
});
for (const corrupt of ["orphan", "duplicate", "foreign-fence", "settled-first", "malformed", "wrong-owner"]) {
  test(`corrupt Host journal ${corrupt} is not quiescence`, async t => {
    const f = await fixture(t);
    const prep = prepared(f), settled = { executionId: "command", outcome: "not_started", ownerCurrent: true };
    if (corrupt === "foreign-fence") prep.source = { ...f.fence, runtimeInstanceId: "other" };
    if (corrupt === "malformed") prep.commandDigest = "invalid";
    if (corrupt === "wrong-owner") settled.ownerCurrent = false;
    if (corrupt === "settled-first") event(f, "host_command_settled", settled);
    if (corrupt !== "orphan") event(f, "host_command_prepared", prep);
    if (corrupt !== "settled-first") event(f, "host_command_settled", settled);
    if (corrupt === "duplicate") {
      assert.throws(() => event(f, "host_command_settled", settled), /UNIQUE constraint/,
        "the migrated SQLite journal rejects a second settlement atomically");
      return f.check();
    }
    assert.throws(f.yield, code("not_quiescent"));
  });
}
for (const name of ["mcp_server_write", "hydrated_tool_call", "image_generate", "open_local_target", "write", "bash"]) {
  test(`paired tool_end ${name} alone cannot attest physical/effect settlement`, async t => {
    const f = await fixture(t);
    tool(f, name);
    assert.throws(f.yield, code("not_quiescent"));
  });
}
for (const status of ["queued", "running", "waiting_for_approval", "succeeded", "failed", "cancelled"]) {
  test(`source-bound background media ${status} lacks immutable fence/stop proof`, async t => {
    const f = await fixture(t);
    const media = f.store.createOrReuseConversationMediaJob({ runId: f.run.id, toolCallId: "media", idempotencyKey: "media",
      target: { id: "provider", ref: { kind: "provider", providerPresetId: "provider" }, generationKind: "image", displayName: "fixture" },
      mediaJob: { providerPresetId: "provider", operation: "image_generate", prompt: "fixture" } }, createdAt);
    f.store.updateMediaJobStatus(media.mediaJob.id, { status }, settledAt);
    const before = snapshot(f);
    assert.throws(f.yield, code("not_quiescent"));
    assert.deepEqual(snapshot(f), before);
  });
}
test("sibling Run background media does not block the source's independent wait", async t => {
  const f = await fixture(t);
  f.store.createRun({ id: "sibling-run", cwd: f.cwd, taskId: "sibling-task", providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt });
  f.store.createOrReuseConversationMediaJob({ runId: "sibling-run", toolCallId: "media", idempotencyKey: "media",
    target: { id: "provider", ref: { kind: "provider", providerPresetId: "provider" }, generationKind: "image", displayName: "fixture" },
    mediaJob: { providerPresetId: "provider", operation: "image_generate", prompt: "fixture" } }, createdAt);
  assert.equal(f.yield().wait.status, "waiting");
});
test("sibling Run unknown Broker and prepared Host command do not borrow the source fence", async t => {
  const f = await fixture(t);
  const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "sibling-run",
    taskId: "sibling-task", idempotencyKey: "sibling", status: "running", createdByActor: "system", request: {}, now: createdAt });
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "sibling-runtime",
    runnerId: "runner_pi_embedded", status: "started", now: createdAt });
  const run = f.store.createRun({ id: "sibling-run", cwd: f.cwd, taskId: "sibling-task", workUnitId: unit.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt });
  f.store.markRunStarted(run.id, createdAt);
  f.store.linkRunToWorkUnit(run.id, unit.id, createdAt);
  const sibling = { ...f, unit, run, attempt, fence: toRuntimeAttemptFence(attempt) };
  broker(sibling, "unknown_outcome");
  event(sibling, "host_command_prepared", { ...prepared(sibling), executionId: "sibling-command" });
  assert.equal(f.yield().wait.status, "waiting");
});
test("original full fence is required even when there are no tool rows", async t => {
  const f = await fixture(t);
  for (const key of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
    assert.throws(() => assertUserInputQuiescence(f.database, f.run.id, f.proof(), committedAt, { ...f.fence, [key]: "foreign" }), code("not_quiescent"));
  }
});
test("late durable Broker after a valid yield prevents claim and leaves outbox pending", async t => {
  const f = await fixture(t);
  const receipt = f.submit();
  const row = broker(f, "denied");
  f.yield();
  f.database.prepare("UPDATE harness_tool_executions SET state='unknown_outcome',execution_started_at=?,execution_finished_at=? WHERE id=?")
    .run(createdAt, settledAt, row.id);
  const before = f.store.getUserInputDelivery(f.thread.id, receipt.deliveryId);
  assert.throws(() => f.store.claimUserInputDelivery({ threadId: f.thread.id, deliveryId: receipt.deliveryId,
    expectedRevision: 1, ownerId: "host", leaseMs: 1000 }, committedAt), code("not_quiescent"));
  assert.deepEqual(f.store.getUserInputDelivery(f.thread.id, receipt.deliveryId), before);
});
for (const ts of ["invalid", "2026-10-03T00:00:04.000Z"]) {
  test(`malformed/future atomic tool timestamps are not a stop proof: ${ts}`, async t => {
    const f = await fixture(t);
    event(f, "tool_start", { toolCallId: "read", toolName: "read", input: {} }, ts);
    event(f, "tool_end", { toolCallId: "read", toolName: "read", isError: false, output: "ok" });
    assert.throws(f.yield, code("not_quiescent"));
  });
}
test("tool end cannot swap a safe read name onto an unverified effect", async t => {
  const f = await fixture(t);
  event(f, "tool_start", { toolCallId: "effect", toolName: "mcp_write", input: {} });
  event(f, "tool_end", { toolCallId: "effect", toolName: "read", isError: false, output: "ok" });
  assert.throws(f.yield, code("not_quiescent"));
});
