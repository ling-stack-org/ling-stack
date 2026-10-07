import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence, digestHarnessToolValue } from "../dist/index.js";
import { SqliteHostOperationJournalStore } from "../dist/storage/sqlite/host-operation-journal-store.js";

const now = () => new Date().toISOString();
const errorCode = code => error => error.code === code;
async function fixture(t, protocol = "image_response_v1") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-media-facts-"));
  const store = createSqliteRunStore(cwd), other = createSqliteRunStore(cwd);
  t.after(async () => { other.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const at = now();
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now: at });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "parent-runtime", runnerId: "pi", status: "started", now: at });
  const fence = toRuntimeAttemptFence(attempt);
  const thread = store.createLingThread({ kind: "conversation", title: "Media facts", objective: "Whole-operation evidence" }, at);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Generate", userInstruction: "Generate",
    idempotencyKey: "turn", payload: { body: "Generate", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, at);
  const run = store.createRun({ id: "run", cwd, workUnitId: unit.id, threadId: thread.id, turnId: turn.turnId,
    taskId: "task", providerName: "test", providerModel: "test",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: at });
  store.linkRunToWorkUnit(run.id, unit.id, at); store.markRunStarted(run.id, at);
  const source = { runId: run.id, ...fence }, call = "media-call", intentDigest = "a".repeat(64), target = { kind: "normal", conversationId: "conversation" };
  const parent = store.admitHostOperation({ operationId: "parent", source, kind: "media", toolCallId: call });
  const transport = store.admitHostOperation({ operationId: "transport", source, kind: "media", toolCallId: call,
    parentOperationId: parent.operationId, producerId: "media-http-chain" });
  const created = store.createOrReuseConversationMediaJob({ runId: run.id, toolCallId: call, target,
    idempotencyKey: "media-job", mediaJob: { providerPresetId: "image", operation: "image_generate", prompt: "Test" },
    executionAdmission: { schemaVersion: 1, source, requestDigest: intentDigest } }, now());
  const payload = { schemaVersion: 1, executionId: "execution", mediaJobId: created.mediaJob.id,
    mediaChildWorkUnitId: created.workUnit.id, executionGenerationId: "generation", source, toolCallId: call,
    protocol, adapterId: "openai-images", toolName: "image_generate", operation: "image_generate",
    intentDigest, targetDigest: digestHarnessToolValue(target), namespaceDigest: "b".repeat(64) };
  const artifact = store.createArtifact({ runId: run.id, type: "json", path: "media/prepared.json", createdAt: now(), sealedPayload: payload });
  const input = { executionId: payload.executionId, mediaJobId: payload.mediaJobId, mediaChildWorkUnitId: payload.mediaChildWorkUnitId,
    executionGenerationId: payload.executionGenerationId, protocol: payload.protocol, adapterId: payload.adapterId,
    toolName: payload.toolName, operation: payload.operation, intentDigest, targetDigest: payload.targetDigest,
    namespaceDigest: payload.namespaceDigest, preparedRequestArtifactId: artifact.id, preparedRequestDigest: artifact.contentSha256, preparedAt: now() };
  const f = { cwd, store, other, unit, attempt, source, parent, transport, created, artifact, input, thread, turn, fence };
  f.prepare = (override = {}) => store.prepareHostMediaExecution(parent, transport, { ...input, ...override });
  f.child = () => {
    const childAttempt = store.createWorkUnitAttempt({ workUnitId: created.workUnit.id, attemptNumber: 1,
      runtimeInstanceId: "child-runtime", runnerId: "media", status: "started", now: now() });
    return toRuntimeAttemptFence(childAttempt);
  };
  f.effect = (override = {}) => ({ effectId: "effect", ordinal: 0, kind: "image_request", method: "POST",
    routeDigest: "c".repeat(64), wireDigest: "d".repeat(64), preparedAt: now(), ...override });
  f.replace = () => store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 2,
    runtimeInstanceId: "new-parent", runnerId: "pi", status: "started", now: now() });
  f.ask = (waitMode = "required") => store.createUserInputRequest({ sourceRunId: run.id, sourceItemId: turn.item.id,
    sourceFence: fence, toolCallId: "ask", idempotencyKey: "ask", toolInput: { schemaVersion: 1, waitMode,
      questions: [{ questionId: "choice", prompt: "Choose", required: true, allowFreeText: true, options: [] }] } }, now());
  return f;
}

test("Media prepared facts preserve source/job/generation and never constitute a safe receipt", async t => {
  const f = await fixture(t), ticket = f.prepare(), row = f.other.getHostMediaExecution(ticket.executionId);
  assert.deepEqual(row.source, f.source); assert.equal(row.mediaJobId, f.created.mediaJob.id);
  assert.equal(row.workspaceId, DEFAULT_WORKSPACE_ID); assert.equal(row.parentOperationId, "parent");
  assert.equal(row.transportOperationId, "transport"); assert.equal(row.childFence, undefined);
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
  assert.throws(() => f.prepare(), errorCode("host_media_execution_already_prepared"));
});
for (const field of ["mediaJobId", "mediaChildWorkUnitId", "executionGenerationId", "intentDigest", "targetDigest",
  "namespaceDigest", "preparedRequestArtifactId", "preparedRequestDigest", "protocol", "adapterId", "toolName", "operation"]) {
  test(`Media prepared ${field} substitution rejects before send`, async t => {
    const f = await fixture(t);
    assert.throws(() => f.prepare({ [field]: "foreign" }));
    assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM host_media_executions").get().n, 0);
  });
}
test("Media private tickets cannot be cloned, transferred, or restored from a persisted execution ID", async t => {
  const f = await fixture(t), ticket = f.prepare(), child = f.child();
  for (const writer of [f.store, f.other]) {
    assert.throws(() => writer.bindHostMediaChildExecution({ ...ticket }, child), errorCode("host_media_invalid_ticket"));
  }
  assert.throws(() => f.other.bindHostMediaChildExecution(ticket, child), errorCode("host_media_invalid_ticket"));
  assert.throws(() => f.store.prepareHostMediaExecution({ ...f.parent }, f.transport, f.input), errorCode("host_operation_invalid_ticket"));
});
test("Media child fence is one-time exact, distinct from parent, and persists on reopen", async t => {
  const f = await fixture(t), ticket = f.prepare(), child = f.child();
  const row = f.store.bindHostMediaChildExecution(ticket, child);
  assert.deepEqual(row.childFence, child); assert.deepEqual(row.source, f.source);
  assert.deepEqual(f.store.bindHostMediaChildExecution(ticket, child), row);
  assert.throws(() => f.store.bindHostMediaChildExecution(ticket, f.source));
  assert.throws(() => f.store.database.prepare("UPDATE host_media_executions SET child_fencing_token='other' WHERE execution_id=?").run(ticket.executionId), /host_media_child_immutable/);
  const reopened = createSqliteRunStore(f.cwd);
  try { assert.deepEqual(reopened.getHostMediaExecution(ticket.executionId), row); }
  finally { reopened.close(); }
});
test("Every forward Media POST owns an immutable pre-launch effect and a single physical send", async t => {
  const f = await fixture(t), ticket = f.prepare(); f.store.bindHostMediaChildExecution(ticket, f.child());
  const effect = f.effect(); f.store.prepareHostMediaEffect(ticket, effect);
  assert.equal(f.other.listHostMediaEffects(ticket.executionId)[0].launchedAt, undefined);
  let sends = 0; f.store.launchHostMediaEffect(ticket, effect.effectId, () => { sends++; });
  assert.equal(sends, 1); assert.ok(f.other.listHostMediaEffects(ticket.executionId)[0].launchedAt);
  assert.equal(f.other.getHostOperation("transport").phase, "launched");
  assert.throws(() => f.store.launchHostMediaEffect(ticket, effect.effectId, () => { sends++; }), errorCode("host_media_effect_already_launched"));
  assert.equal(sends, 1); assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
});
test("Media source replacement refuses preparation and all new effects with zero send", async t => {
  const f = await fixture(t), ticket = f.prepare(); f.store.bindHostMediaChildExecution(ticket, f.child());
  const effect = f.effect(); f.store.prepareHostMediaEffect(ticket, effect); f.replace();
  let sends = 0; assert.throws(() => f.store.launchHostMediaEffect(ticket, effect.effectId, () => { sends++; }), errorCode("host_operation_stale_owner"));
  assert.equal(sends, 0); assert.equal(f.other.listHostMediaEffects(ticket.executionId)[0].launchedAt, undefined);
});
test("Media synchronous send failure leaves a non-replayable latch and durable blocker", async t => {
  const f = await fixture(t), ticket = f.prepare(); f.store.bindHostMediaChildExecution(ticket, f.child());
  const effect = f.effect(); f.store.prepareHostMediaEffect(ticket, effect);
  let sends = 0; assert.throws(() => f.store.launchHostMediaEffect(ticket, effect.effectId, () => { sends++; throw new Error("send failed"); }), /send failed/);
  assert.throws(() => f.store.launchHostMediaEffect(ticket, effect.effectId, () => { sends++; }), errorCode("host_media_launch_unknown"));
  assert.throws(() => f.store.settleHostOperation(f.transport, { kind: "known_no_start" }), errorCode("host_operation_launched_no_start"));
  assert.equal(sends, 1); assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
});

test("Media send followed by real COMMIT failure cannot be replayed or reclassified no-start", async t => {
  const f = await fixture(t), ticket = f.prepare(); f.store.bindHostMediaChildExecution(ticket, f.child());
  const effect = f.effect(); f.store.prepareHostMediaEffect(ticket, effect);
  const originalExec = f.store.database.exec.bind(f.store.database); let failCommit = true, sends = 0;
  f.store.database.exec = sql => { if (sql === "COMMIT" && failCommit) { failCommit = false; throw new Error("injected commit failure"); } return originalExec(sql); };
  assert.throws(() => f.store.launchHostMediaEffect(ticket, effect.effectId, () => { sends++; }), /injected commit failure/);
  assert.equal(f.other.listHostMediaEffects(ticket.executionId)[0].launchedAt, undefined);
  assert.equal(f.other.getHostOperation("transport").phase, "admitted", "rollback keeps a durable blocker, not a no-start");
  assert.throws(() => f.store.launchHostMediaEffect(ticket, effect.effectId, () => { sends++; }), errorCode("host_media_launch_unknown"));
  for (const operation of [f.parent, f.transport]) {
    assert.throws(() => f.store.settleHostOperation(operation, { kind: "known_no_start" }), errorCode("host_operation_launched_no_start"));
  }
  assert.equal(sends, 1);
});
test("Media async launcher is refused before effect; accidental thenable latches entered launch", async t => {
  const f = await fixture(t), ticket = f.prepare(); f.store.bindHostMediaChildExecution(ticket, f.child());
  const effect = f.effect(); f.store.prepareHostMediaEffect(ticket, effect); let sends = 0;
  assert.throws(() => f.store.launchHostMediaEffect(ticket, effect.effectId, async () => { sends++; }), errorCode("host_operation_effect_must_be_synchronous"));
  assert.equal(sends, 0); assert.equal(f.other.listHostMediaEffects(ticket.executionId)[0].launchedAt, undefined);
  assert.throws(() => f.store.launchHostMediaEffect(ticket, effect.effectId, () => { sends++; return Promise.reject(new Error("late reject")); }), /must be synchronous/);
  assert.throws(() => f.store.launchHostMediaEffect(ticket, effect.effectId, () => { sends++; }), errorCode("host_media_launch_unknown"));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(sends, 1);
});
for (const waitMode of ["required", "optional"]) {
  test(`Media ${waitMode} question preserves admission semantics at each actual send`, async t => {
    const f = await fixture(t), ticket = f.prepare(); f.store.bindHostMediaChildExecution(ticket, f.child());
    const effect = f.effect(); f.store.prepareHostMediaEffect(ticket, effect); f.ask(waitMode); let sends = 0;
    if (waitMode === "required") {
      assert.throws(() => f.store.launchHostMediaEffect(ticket, effect.effectId, () => { sends++; }), errorCode("host_operation_admission_closed"));
      assert.throws(() => f.store.prepareHostMediaEffect(ticket, f.effect({ effectId: "next", ordinal: 1 })), errorCode("host_operation_admission_closed"));
      assert.equal(sends, 0);
    } else { f.store.launchHostMediaEffect(ticket, effect.effectId, () => { sends++; }); assert.equal(sends, 1); }
  });
}
test("Media child replacement prevents prepared effects from reaching transport", async t => {
  const f = await fixture(t), ticket = f.prepare(); f.store.bindHostMediaChildExecution(ticket, f.child());
  const effect = f.effect(); f.store.prepareHostMediaEffect(ticket, effect);
  f.store.createWorkUnitAttempt({ workUnitId: f.created.workUnit.id, attemptNumber: 2,
    runtimeInstanceId: "other-child", runnerId: "media", status: "started", now: now() });
  let sends = 0; assert.throws(() => f.store.launchHostMediaEffect(ticket, effect.effectId, () => { sends++; }), errorCode("host_media_child_stale"));
  assert.equal(sends, 0); assert.equal(f.other.listHostMediaEffects(ticket.executionId)[0].launchedAt, undefined);
});
test("Comfy upload and generation sends remain distinct; missing earlier member blocks submit", async t => {
  const f = await fixture(t, "comfy_jobs_v1"), ticket = f.prepare(); f.store.bindHostMediaChildExecution(ticket, f.child());
  const upload = f.effect({ kind: "comfy_image_upload" }), submit = f.effect({ effectId: "submit", ordinal: 1, kind: "remote_generation_submit" });
  f.store.prepareHostMediaEffect(ticket, upload); f.store.prepareHostMediaEffect(ticket, submit);
  let sends = 0; assert.throws(() => f.store.launchHostMediaEffect(ticket, submit.effectId, () => { sends++; }), errorCode("host_media_invalid_effect"));
  assert.equal(sends, 0); f.store.launchHostMediaEffect(ticket, upload.effectId, () => { sends++; });
  f.store.launchHostMediaEffect(ticket, submit.effectId, () => { sends++; }); assert.equal(sends, 2);
  assert.equal(f.other.listHostMediaEffects(ticket.executionId).length, 2);
  assert.throws(() => f.store.prepareHostMediaEffect(ticket, f.effect({ effectId: "duplicate-submit", ordinal: 2, kind: "remote_generation_submit" })), errorCode("host_media_invalid_effect"));
  assert.throws(() => f.store.database.prepare("DELETE FROM host_media_effects WHERE effect_id=?").run(upload.effectId), /append_only/);
});
test("Media prepared sealed artifact corruption is detected on each read and before any new send", async t => {
  const f = await fixture(t), ticket = f.prepare(); f.store.bindHostMediaChildExecution(ticket, f.child());
  const effect = f.effect(); f.store.prepareHostMediaEffect(ticket, effect);
  f.store.database.prepare("UPDATE artifacts SET sealed_payload_json='{}' WHERE id=?").run(f.artifact.id);
  assert.throws(() => f.other.getHostMediaExecution(ticket.executionId), errorCode("host_media_evidence_invalid"));
  let sends = 0; assert.throws(() => f.store.launchHostMediaEffect(ticket, effect.effectId, () => { sends++; }), errorCode("host_media_evidence_invalid"));
  assert.equal(sends, 0);
});
for (const method of ["prepareMediaExecutionFacts", "mutateMediaExecutionFacts"]) {
  test(`Media internal ${method} callbacks reject thenables before committing facts`, async t => {
    const f = await fixture(t), journal = new SqliteHostOperationJournalStore({ database: f.store.database });
    const parent = journal.admitHostOperation({ operationId: "callback-parent", source: f.source, kind: "media", toolCallId: "callback" });
    const transport = journal.admitHostOperation({ operationId: "callback-transport", source: f.source, kind: "media",
      toolCallId: "callback", parentOperationId: parent.operationId, producerId: "media-http-chain" });
    assert.throws(() => journal[method](parent, transport, () => {
      f.store.database.prepare("UPDATE host_operations SET revision=revision+1 WHERE operation_id=?").run(parent.operationId);
      return Promise.resolve("not a synchronous fact");
    }), errorCode("host_operation_effect_must_be_synchronous"));
    assert.equal(f.other.getHostOperation(parent.operationId).revision, 0);
  });
}
test("Media internal before-send callback cannot return a Promise and still dispatch transport", async t => {
  const f = await fixture(t), journal = new SqliteHostOperationJournalStore({ database: f.store.database });
  const parent = journal.admitHostOperation({ operationId: "async-parent", source: f.source, kind: "media", toolCallId: "async" });
  const transport = journal.admitHostOperation({ operationId: "async-transport", source: f.source, kind: "media",
    toolCallId: "async", parentOperationId: parent.operationId, producerId: "media-http-chain" });
  let sends = 0;
  assert.throws(() => journal.launchMediaExecutionMember(parent, transport, () => Promise.resolve("not prepared"), () => { sends++; }),
    errorCode("host_operation_effect_must_be_synchronous"));
  assert.equal(sends, 0); assert.equal(f.other.getHostOperation(transport.operationId).phase, "admitted");
});
