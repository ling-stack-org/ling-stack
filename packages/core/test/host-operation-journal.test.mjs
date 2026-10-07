import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence, digestHarnessToolValue } from "../dist/index.js";
import { assertUserInputQuiescence } from "../dist/storage/sqlite/user-input-wait-evidence.js";

const now = () => new Date().toISOString();
const code = expected => error => error.code === expected;
const invalidEvidence = code("host_operation_evidence_invalid");

/** Real migrated, isolated SQLite stores; never a user's data or GUI fixture. */
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-host-operation-journal-"));
  const store = createSqliteRunStore(cwd);
  const other = createSqliteRunStore(cwd);
  other.database.exec("PRAGMA busy_timeout=20");
  t.after(async () => { other.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const createdAt = now();
  const thread = store.createLingThread({ kind: "conversation", title: "Host journal", objective: "Physical drain" }, createdAt);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Build", userInstruction: "Build",
    idempotencyKey: "source", payload: { body: "Build", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, createdAt);
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now: createdAt });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "original-runtime",
    runnerId: "pi", status: "started", now: createdAt });
  const fence = toRuntimeAttemptFence(attempt);
  const run = store.createRun({ id: "run", cwd, workUnitId: unit.id, threadId: thread.id, turnId: turn.turnId,
    taskId: "task", providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt });
  store.linkRunToWorkUnit(run.id, unit.id, createdAt);
  store.markRunStarted(run.id, createdAt);
  const source = { runId: run.id, ...fence };
  const f = { cwd, store, other, thread, turn, unit, attempt, fence, run, source };
  f.admit = (kind = "file_mutation", toolCallId = "effect", extras = {}, writer = store) => writer.admitHostOperation({
    operationId: `operation-${toolCallId}-${kind}`, source, kind, toolCallId, ...extras });
  f.ask = (waitMode = "required") => {
    const request = store.createUserInputRequest({ sourceRunId: run.id, sourceItemId: turn.item.id, sourceFence: fence,
      toolCallId: "ask", idempotencyKey: "ask", toolInput: { schemaVersion: 1, waitMode,
        questions: [{ questionId: "choice", prompt: "Choose", required: true, allowFreeText: true, options: [] }] } }, now()).request;
    f.request = request;
    return request;
  };
  f.proof = () => ({ kind: "runner_quiesced", runnerId: "pi", stoppedAt: now(),
    lastRunEventSeq: Number(store.database.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM run_events WHERE run_id=?").get(run.id).n) });
  f.yield = () => store.commitUserInputYield({ threadId: thread.id, requestId: f.request.requestId,
    expectedRequestVersion: 1, sourceFence: fence, quiescence: f.proof() }, now());
  f.check = () => assertUserInputQuiescence(store.database, run.id, f.proof(), now(), fence);
  f.replace = () => store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 2,
    runtimeInstanceId: "replacement", runnerId: "pi", status: "started", now: now() });
  return f;
}

function prepareFile(f, ticket, call = "effect", toolName = "write", executorKind = "write") {
  const requestDigest = "a".repeat(64), sideEffectFingerprint = "b".repeat(64);
  const policy = f.store.createArtifact({ runId: f.run.id, type: "json", path: `harness/${call}/policy.json`, createdAt: now(),
    sealedPayload: { schemaVersion: 1, runId: f.run.id, attemptId: f.attempt.id, toolCallId: call,
      executorKind, requestDigest, sideEffectFingerprint, effectivePolicySnapshot: {} } });
  const row = f.store.prepareHarnessToolExecution({ runId: f.run.id, workUnitId: f.unit.id, sourceFence: f.fence,
    toolCallId: call, toolName, executorKind, requestDigest, sideEffectFingerprint,
    policySnapshotArtifactId: policy.id, approvalState: "allowed", sandboxProfileId: "workspace_write", now: now() }).execution;
  if (ticket) f.store.bindHostOperationEvidence(ticket, { kind: "harness_tool_execution", id: row.id });
  return { row, policy };
}
function startFile(f, prepared) {
  const claim = f.store.claimHarnessToolExecution({ executionId: prepared.row.id, expectedRevision: prepared.row.revision,
    sourceFence: f.fence, claimOwner: "host", claimToken: "claim", claimExpiresAt: new Date(Date.now() + 60_000).toISOString(), now: now() });
  assert.equal(claim.ok, true);
  const start = f.store.startHarnessToolExecution({ executionId: prepared.row.id, expectedRevision: claim.value.revision,
    sourceFence: f.fence, claimOwner: "host", claimToken: "claim", now: now() });
  assert.equal(start.ok, true);
  return start.value;
}
function finishFile(f, row, outcome = "applied", overrides = {}) {
  const status = outcome === "applied" ? "applied" : "failed";
  const result = f.store.createArtifact({ runId: f.run.id, type: "json", path: `harness/${row.id}/result.json`, createdAt: now(),
    sealedPayload: { status, ...(outcome === "applied" ? {} : { outcome }), format: "ling-apply-patch-v1",
      touchedPaths: ["result.txt"], rawPatchSha256: "c".repeat(64) } });
  const resultSummary = { status, outcome, touchedPaths: ["result.txt"], artifactCount: 1, cancelled: false };
  const finish = f.store.finishHarnessToolExecution({ executionId: row.id, expectedRevision: row.revision,
    sourceFence: f.fence, claimOwner: "host", claimToken: "claim", nextState: outcome === "applied" ? "succeeded" : "failed",
    resultDigest: digestHarnessToolValue(resultSummary), resultSummary, evidenceArtifactIds: [result.id],
    ...(outcome === "applied" ? {} : { failureCode: "tool.executor_failed" }), now: now(), ...overrides });
  assert.equal(finish.ok, true);
  return { result, resultSummary, row: finish.value };
}
function completeFile(f, call = "effect", outcome = "applied") {
  const ticket = f.admit("file_mutation", call), prepared = prepareFile(f, ticket, call);
  const row = startFile(f, prepared);
  f.store.launchHostOperation(ticket, () => 1);
  const finished = finishFile(f, row, outcome);
  return { ticket, prepared, ...finished };
}
function event(f, type, data) {
  f.store.appendExecutionEvent(f.run.id, f.fence, type, data);
}
function tool(f, name = "write", id = "effect") {
  event(f, "tool_start", { toolCallId: id, toolName: name, input: {} });
  event(f, "tool_end", { toolCallId: id, toolName: name, isError: false, output: "finished" });
}
function durableRows(f) {
  return f.other.database.prepare("SELECT * FROM host_operations ORDER BY operation_id").all();
}

test("admission is durable before any callback and full immutable source is read back", async t => {
  const f = await fixture(t), ticket = f.admit();
  assert.deepEqual(f.other.getHostOperation(ticket.operationId).source, f.source);
  assert.equal(f.other.getHostOperation(ticket.operationId).phase, "admitted");
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 1);
  assert.throws(() => f.other.admitHostOperation({ operationId: ticket.operationId, source: f.source,
    kind: "file_mutation", toolCallId: "effect" }), code("host_operation_already_admitted"));
});
for (const kind of ["command","file_mutation","mcp","plugin","media","host_capability","approval","permission","approval_review","hydration","sdk_tool","cleanup"]) {
  test(`actual unlaunched ${kind} can settle no-start but its ID is not replay authority`, async t => {
    const f = await fixture(t), ticket = f.admit(kind);
    const input = { kind: "known_no_start", settledAt: now() };
    const settled = f.store.settleHostOperation(ticket, input);
    assert.equal(settled.phase, "safe");
    assert.deepEqual(f.store.settleHostOperation(ticket, input), settled);
    assert.equal(f.other.getHostOperation(ticket.operationId).settlementKind, "known_no_start");
    assert.deepEqual(f.other.listHostOperationBlockers(f.source), []);
    assert.throws(() => f.other.settleHostOperation(ticket, input), code("host_operation_invalid_ticket"));
    assert.throws(() => f.store.launchHostOperation({ ...ticket }, () => 1), code("host_operation_invalid_ticket"));
    assert.throws(() => f.store.launchHostOperation(ticket, () => 1), code("host_operation_already_launched"));
  });
}
for (const field of ["runId","workUnitId","attemptId","runtimeInstanceId","fencingToken"]) {
  test(`forged source ${field} is rejected before any durable fact`, async t => {
    const f = await fixture(t);
    assert.throws(() => f.admit("command", "call", { source: { ...f.source, [field]: "different" } }), code("host_operation_invalid_source"));
    assert.deepEqual(durableRows(f), []);
  });
}
test("replacement between admission and launch blocks callback and cannot give safe settlement", async t => {
  const f = await fixture(t), ticket = f.admit("mcp");
  f.replace();
  let invoked = 0;
  assert.throws(() => f.store.launchHostOperation(ticket, () => ++invoked), code("host_operation_stale_owner"));
  assert.equal(invoked, 0);
  assert.throws(() => f.store.settleHostOperation(ticket, { kind: "known_no_start" }), code("host_operation_stale_owner"));
  const unknown = f.store.settleHostOperation(ticket, { kind: "unknown_outcome", code: "stale_owner" });
  assert.equal(unknown.phase, "unknown_outcome");
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 1);
});
for (const phase of ["admitted", "launched", "unknown_outcome"]) {
  test(`restart ${phase} remains a blocker in the exact yield transaction`, async t => {
    const f = await fixture(t), ticket = f.admit("mcp");
    if (phase !== "admitted") f.store.launchHostOperation(ticket, () => undefined);
    if (phase === "unknown_outcome") f.store.settleHostOperation(ticket, { kind: "unknown_outcome", code: "transport_closed" });
    f.ask();
    const before = durableRows(f);
    assert.throws(f.yield, code("not_quiescent"));
    assert.deepEqual(durableRows(f), before);
    assert.equal(f.other.listHostOperationBlockers(f.source).length, 1);
    assert.throws(() => f.other.settleHostOperation({ operationId: ticket.operationId }, { kind: "known_no_start" }), code("host_operation_invalid_ticket"));
  });
}
for (const answered of [false,true]) {
  test(`durable required ${answered ? "early answered" : "pending"} closes new admission and launch without waiting for lease release`, async t => {
    const f = await fixture(t), ticket = f.admit("file_mutation");
    const request = f.ask();
    if (answered) f.store.submitUserInputAnswer({ threadId: f.thread.id, submission: { schemaVersion: 1,
      requestId: request.requestId, expectedVersion: 1, expectedStatusRevision: 1, idempotencyKey: "answer",
      answers: [{ questionId: "choice", kind: "text", text: "blue" }] } }, now());
    let invoked = 0;
    assert.throws(() => f.store.launchHostOperation(ticket, () => ++invoked), code("host_operation_admission_closed"));
    assert.throws(() => f.admit("mcp", "next"), code("host_operation_admission_closed"));
    assert.equal(invoked, 0);
    assert.equal(f.store.settleHostOperation(ticket, { kind: "known_no_start" }).phase, "safe");
  });
}
test("optional question does not close admission", async t => {
  const f = await fixture(t); f.ask("optional");
  const ticket = f.admit("mcp");
  assert.equal(f.store.launchHostOperation(ticket, () => 3), 3);
});
test("multi-write forward callbacks stop at required intent; original-source bounded cleanup still executes", async t => {
  const f = await fixture(t), ticket = f.admit();
  let writes = 0;
  f.store.launchHostOperation(ticket, () => ++writes);
  assert.equal(f.store.continueHostOperationEffect(ticket, () => ++writes), 2);
  f.ask();
  assert.throws(() => f.store.continueHostOperationEffect(ticket, () => ++writes), code("host_operation_admission_closed"));
  f.store.continueHostOperationEffect(ticket, () => --writes, "cleanup");
  assert.equal(writes, 1);
  f.replace();
  assert.throws(() => f.store.continueHostOperationEffect(ticket, () => --writes, "cleanup"), code("host_operation_stale_owner"));
  assert.equal(writes, 1);
});
for (const failure of ["throw", "thenable", "commit"]) {
  test(`entered physical effect ${failure} cannot be relabeled no-start, including after SQLite marker rollback`, async t => {
    const f = await fixture(t), ticket = f.admit();
    const target = join(f.cwd, "actual.txt");
    const original = f.store.database.exec.bind(f.store.database);
    if (failure === "commit") f.store.database.exec = sql => {
      if (sql === "COMMIT") { f.store.database.exec = original; throw new Error("injected_commit_failure"); }
      return original(sql);
    };
    assert.throws(() => f.store.launchHostOperation(ticket, () => {
      writeFileSync(target, "physical effect", "utf8");
      if (failure === "throw") throw new Error("after_effect");
      return failure === "thenable" ? Promise.resolve("not proof") : "effect";
    }));
    assert.equal(await readFile(target, "utf8"), "physical effect");
    assert.equal(f.other.getHostOperation(ticket.operationId).phase, "admitted");
    assert.throws(() => f.store.settleHostOperation(ticket, { kind: "known_no_start" }), code("host_operation_launched_no_start"));
    assert.throws(() => f.store.settleHostOperation(ticket, { kind: "file_completed" }), code("host_operation_launch_unknown"));
    f.ask();
    f.store.continueHostOperationEffect(ticket, () => writeFileSync(target, "bounded rollback", "utf8"), "cleanup");
    assert.equal(await readFile(target, "utf8"), "bounded rollback");
    assert.throws(f.yield, code("not_quiescent"));
    f.store.settleHostOperation(ticket, { kind: "unknown_outcome", code: failure });
    assert.throws(f.yield, code("not_quiescent"));
  });
}
test("async launcher rejected before callback; thenable continue becomes uncertain without clearing the blocker", async t => {
  const f = await fixture(t), ticket = f.admit();
  let invoked = 0;
  assert.throws(() => f.store.launchHostOperation(ticket, async () => ++invoked), code("host_operation_effect_must_be_synchronous"));
  assert.equal(invoked, 0);
  f.store.launchHostOperation(ticket, () => ++invoked);
  assert.throws(() => f.store.continueHostOperationEffect(ticket, () => Promise.resolve(++invoked)));
  assert.throws(() => f.store.continueHostOperationEffect(ticket, () => ++invoked), code("host_operation_launch_unknown"));
  assert.equal(invoked, 2);
});
test("same write lock excludes the second connection while the OS effect runs", async t => {
  const f = await fixture(t), ticket = f.admit("mcp");
  f.store.launchHostOperation(ticket, () => {
    assert.throws(() => f.other.admitHostOperation({ operationId: "concurrent", source: f.source,
      kind: "mcp", toolCallId: "concurrent" }), /locked/);
  });
  assert.equal(f.other.getHostOperation(ticket.operationId).phase, "launched");
});
test("nested effect cannot write SQLite or settle itself", async t => {
  const f = await fixture(t), ticket = f.admit("mcp");
  assert.throws(() => f.store.launchHostOperation(ticket, () => {
    f.store.database.prepare("UPDATE host_operations SET revision=revision+1 WHERE operation_id=?").run(ticket.operationId);
  }), /readonly/);
  assert.throws(() => f.store.settleHostOperation(ticket, { kind: "known_no_start" }), code("host_operation_launched_no_start"));
});
test("unknown settlement is first-write immutable and retry cannot turn it safe", async t => {
  const f = await fixture(t), ticket = f.admit("command");
  const input = { kind: "unknown_outcome", code: "descendants_unverified", settledAt: now() };
  const settled = f.store.settleHostOperation(ticket, input);
  assert.deepEqual(f.store.settleHostOperation(ticket, input), settled);
  assert.throws(() => f.store.settleHostOperation(ticket, { kind: "known_no_start" }), code("host_operation_settlement_conflict"));
  assert.throws(() => f.other.database.prepare("UPDATE host_operations SET phase='admitted' WHERE operation_id=?")
    .run(ticket.operationId), /host_operation_settlement_immutable/);
});
test("parent cannot settle before every reserved producer and cannot acquire late children", async t => {
  const f = await fixture(t), parent = f.admit("mcp"), child = f.admit("hydration", "effect", {
    operationId: "producer", parentOperationId: parent.operationId, producerId: "resolver" });
  assert.throws(() => f.store.settleHostOperation(parent, { kind: "known_no_start" }), invalidEvidence);
  f.store.settleHostOperation(child, { kind: "known_no_start" });
  f.store.settleHostOperation(parent, { kind: "known_no_start" });
  assert.deepEqual(f.other.listHostOperationBlockers(f.source), []);
  assert.throws(() => f.admit("cleanup", "effect", { operationId: "late", parentOperationId: parent.operationId,
    producerId: "late" }), code("host_operation_invalid_parent"));
});
test("foreign/missing parent and mismatched tool identity never admit a producer", async t => {
  const f = await fixture(t), parent = f.admit("mcp");
  for (const extras of [{ parentOperationId: "missing", producerId: "p" }, { parentOperationId: parent.operationId },
    { parentOperationId: parent.operationId, producerId: "p" }]) {
    assert.throws(() => f.admit("hydration", "wrong-call", { operationId: "child", ...extras }));
  }
  assert.equal(durableRows(f).length, 1);
});
for (const outcome of ["applied","not_applied","rolled_back"]) {
  test(`exact bound terminal file ${outcome} verifies real sorted summary and sealed artifacts before yield`, async t => {
    const f = await fixture(t), completed = completeFile(f, "effect", outcome);
    assert.equal(f.store.settleHostOperation(completed.ticket, { kind: "file_completed" }).phase, "safe");
    assert.equal(f.other.getHostOperation(completed.ticket.operationId).settlementKind, "file_completed");
    tool(f); f.ask();
    assert.equal(f.yield().wait.status, "waiting");
  });
}
for (const executor of ["write", "apply_patch"]) {
  test(`actual edit tool keeps its edit identity while the exact Broker executor is ${executor}`, async t => {
    const f = await fixture(t), ticket = f.admit(), prepared = prepareFile(f, ticket, "effect", "edit", executor);
    const row = startFile(f, prepared);
    f.store.launchHostOperation(ticket, () => undefined);
    finishFile(f, row);
    f.store.settleHostOperation(ticket, { kind: "file_completed" });
    tool(f, "edit"); f.ask();
    assert.equal(f.yield().wait.status, "waiting");
  });
}
for (const corrupt of ["summary_digest","policy_hash","policy_source","result_hash","result_payload","result_late","domain_identity","missing_link","unknown_outcome"]) {
  test(`invalid ${corrupt} cannot produce a safe file receipt`, async t => {
    const f = await fixture(t), completed = completeFile(f);
    const database = f.other.database;
    if (corrupt === "summary_digest") database.prepare("UPDATE harness_tool_executions SET result_digest=? WHERE id=?")
      .run("d".repeat(64), completed.row.id);
    if (corrupt === "policy_hash" || corrupt === "result_hash") database.prepare("UPDATE artifacts SET content_sha256=? WHERE id=?")
      .run("e".repeat(64), corrupt === "policy_hash" ? completed.prepared.policy.id : completed.result.id);
    if (corrupt === "policy_source" || corrupt === "result_payload") database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?")
      .run(JSON.stringify({ fake: true }), corrupt === "policy_source" ? completed.prepared.policy.id : completed.result.id);
    if (corrupt === "result_late") database.prepare("UPDATE artifacts SET created_at=? WHERE id=?")
      .run(new Date(Date.now() + 60_000).toISOString(), completed.result.id);
    if (corrupt === "domain_identity") database.prepare("UPDATE harness_tool_executions SET request_digest=? WHERE id=?")
      .run("f".repeat(64), completed.row.id);
    if (corrupt === "missing_link") database.prepare("DELETE FROM harness_tool_execution_artifacts WHERE execution_id=?").run(completed.row.id);
    if (corrupt === "unknown_outcome") database.prepare("UPDATE harness_tool_executions SET state='unknown_outcome' WHERE id=?").run(completed.row.id);
    assert.throws(() => f.store.settleHostOperation(completed.ticket, { kind: "file_completed" }), invalidEvidence);
    assert.equal(f.other.getHostOperation(completed.ticket.operationId).phase, "launched");
    f.ask(); assert.throws(f.yield, code("not_quiescent"));
  });
}
test("persisted safe file is reverified after restart; domain corruption cannot clear delivery claim", async t => {
  const f = await fixture(t), completed = completeFile(f);
  f.store.settleHostOperation(completed.ticket, { kind: "file_completed" });
  tool(f); const request = f.ask();
  const receipt = f.store.submitUserInputAnswer({ threadId: f.thread.id, submission: { schemaVersion: 1,
    requestId: request.requestId, expectedVersion: 1, expectedStatusRevision: 1, idempotencyKey: "answer",
    answers: [{ questionId: "choice", kind: "text", text: "blue" }] } }, now());
  f.yield();
  f.other.database.prepare("UPDATE harness_tool_executions SET result_digest=? WHERE id=?").run("d".repeat(64), completed.row.id);
  assert.throws(() => f.other.getHostOperation(completed.ticket.operationId), invalidEvidence);
  assert.throws(() => f.store.claimUserInputDelivery({ threadId: f.thread.id, deliveryId: receipt.deliveryId,
    expectedRevision: 1, ownerId: "host", leaseMs: 1000 }, now()), code("not_quiescent"));
});
test("exact domain binding is one-to-one and immutable even across independent connections", async t => {
  const f = await fixture(t), first = f.admit(), prepared = prepareFile(f, first);
  const second = f.admit("file_mutation", "effect", { operationId: "another", parentOperationId: first.operationId, producerId: "same-evidence" });
  assert.throws(() => f.store.bindHostOperationEvidence(second, { kind: "harness_tool_execution", id: prepared.row.id }),
    code("host_operation_evidence_already_bound"));
  assert.throws(() => f.store.bindHostOperationEvidence(first, { kind: "harness_tool_execution", id: "different" }),
    code("host_operation_binding_conflict"));
  assert.throws(() => f.other.database.prepare("UPDATE host_operations SET evidence_id='different' WHERE operation_id=?")
    .run(first.operationId), /host_operation_binding_immutable/);
});
test("already-started Broker terminal replay cannot acquire a new no-start operation", async t => {
  const f = await fixture(t), prepared = prepareFile(f, undefined), row = startFile(f, prepared);
  finishFile(f, row);
  const ticket = f.admit();
  assert.throws(() => f.store.bindHostOperationEvidence(ticket, { kind: "harness_tool_execution", id: row.id }));
  f.store.settleHostOperation(ticket, { kind: "known_no_start" });
  tool(f); f.ask();
  assert.throws(f.yield, code("not_quiescent"));
});
test("command completed leader/stdio observation is not whole-operation evidence", async t => {
  const f = await fixture(t), ticket = f.admit("command", "bash-call");
  const command = f.store.prepareHostCommandExecution({ runId: f.run.id, sourceFence: f.fence, toolCallId: "bash-call", cwd: f.cwd,
    command: { kind: "shell", command: "true", shell: "bash" } });
  f.store.bindHostOperationEvidence(ticket, { kind: "host_command", id: command.executionId });
  f.store.launchHostOperation(ticket, () => undefined);
  f.store.settleHostCommandExecution(command, { kind: "observed", observation: { scope: "process_group",
    leaderExited: true, stdioClosed: true, descendants: "unverified", settledBy: "close", signalFailures: [] } });
  assert.throws(() => f.store.settleHostOperation(ticket, { kind: "file_completed" }), invalidEvidence);
  assert.throws(() => f.store.settleHostOperation(ticket, { kind: "known_no_start" }), code("host_operation_launched_no_start"));
  f.ask(); assert.throws(f.yield, code("not_quiescent"));
});
test("not-started main command cannot hide an entered native prepare helper", async t => {
  const f = await fixture(t), ticket = f.admit("command", "bash-call");
  const command = f.store.prepareHostCommandExecution({ runId: f.run.id, sourceFence: f.fence, toolCallId: "bash-call", cwd: f.cwd,
    command: { kind: "shell", command: "true", shell: "bash" } });
  f.store.bindHostOperationEvidence(ticket, { kind: "host_command", id: command.executionId });
  f.store.launchHostOperation(ticket, () => undefined); // native capture helper launch, not the main command
  f.store.settleHostCommandExecution(command, { kind: "not_started" });
  assert.throws(() => f.store.settleHostOperation(ticket, { kind: "known_no_start" }), code("host_operation_launched_no_start"));
  f.ask(); assert.throws(f.yield, code("not_quiescent"));
});
test("truly unlaunched command with exact not-started journal can safely yield", async t => {
  const f = await fixture(t), ticket = f.admit("command", "bash-call");
  const command = f.store.prepareHostCommandExecution({ runId: f.run.id, sourceFence: f.fence, toolCallId: "bash-call", cwd: f.cwd,
    command: { kind: "shell", command: "true", shell: "bash" } });
  f.store.bindHostOperationEvidence(ticket, { kind: "host_command", id: command.executionId });
  f.store.settleHostCommandExecution(command, { kind: "not_started" });
  f.store.settleHostOperation(ticket, { kind: "known_no_start" });
  tool(f, "bash", "bash-call"); f.ask();
  assert.equal(f.yield().wait.status, "waiting");
});
test("SQLite identity fields are immutable, malformed settlement timestamps cannot unlock", async t => {
  const f = await fixture(t), ticket = f.admit();
  assert.throws(() => f.other.database.prepare("UPDATE host_operations SET runtime_instance_id='replacement' WHERE operation_id=?")
    .run(ticket.operationId), /host_operation_identity_immutable/);
  assert.throws(() => f.store.settleHostOperation(ticket, { kind: "known_no_start", settledAt: "not-a-date" }), code("host_operation_invalid_timestamp"));
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 1);
});
test("migration records no synthesized historical operation and repeated open preserves facts", async t => {
  const f = await fixture(t);
  assert.deepEqual(durableRows(f), []);
  const ticket = f.admit("mcp");
  const reopened = createSqliteRunStore(f.cwd);
  try { assert.deepEqual(reopened.getHostOperation(ticket.operationId), f.other.getHostOperation(ticket.operationId)); }
  finally { reopened.close(); }
});
