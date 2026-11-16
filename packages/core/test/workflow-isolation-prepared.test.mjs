import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { workflowIsolationFixture, assertIsolationNoWrites } from "./support/workflow-isolation-fixture.mjs";

const input = f => ({ writer: f.writer, expectedRevision: f.binding().revision,
  runnerExecutionInput: f.executionPayload(), now: f.at(11) });
const requests = f => ({ run: f.store.getRun(f.prepared.run.id).requestSnapshot,
  unit: f.store.getWorkUnit(f.prepared.unit.id).request });
function persistFullTaskRequests(f) {
  const task = f.store.getTask(f.generation.task.id), before = requests(f);
  f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?")
    .run(JSON.stringify({ ...before.run, task }), f.prepared.run.id);
  f.store.database.prepare("UPDATE work_units SET request_json=? WHERE id=?")
    .run(JSON.stringify({ ...before.unit, task }), f.prepared.unit.id);
  return task;
}
function refingerprint(payload) {
  const { fingerprint: _fingerprint, ...body } = payload.preparedInput;
  payload.preparedInput.fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

test("seal supports physical ready before transfer and only appends runner evidence to both frozen requests", async t => {
  const f = await workflowIsolationFixture(t); f.makeReady({ linked: false });
  const before = requests(f), command = input(f), plan = f.isolation.getScopePlan(f.plan.planId);
  assert.equal(f.admission(f.scopeIsolation, f.generation).status, "preparing");
  const result = f.isolation.sealPreparedExecution(command);
  assert.equal(result.status, "updated", JSON.stringify(result));
  assert.equal(result.value.revision, command.expectedRevision + 1);
  const after = requests(f);
  assert.deepEqual(after.run, { ...before.run, runnerExecutionInput: command.runnerExecutionInput });
  assert.deepEqual(after.unit, { ...before.unit, runnerExecutionInput: command.runnerExecutionInput });
  assert.deepEqual(f.isolation.getScopePlan(f.plan.planId), plan);
  assert.equal(f.admission(f.scopeIsolation, f.generation).status, "preparing");
  f.link();
  assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, now: f.at(12) }).status, "current");
});

test("sealed evidence keeps the SDK fingerprint field order and identical retries survive reopen without writes", async t => {
  const f = await workflowIsolationFixture(t); f.makeReady(); const command = input(f);
  assert.equal(f.isolation.sealPreparedExecution(command).status, "updated");
  f.reopenIsolation();
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.sealPreparedExecution({ ...command, now: f.at(12) })).status, "duplicate");
  const after = requests(f);
  assert.equal(JSON.stringify(after.run.runnerExecutionInput), JSON.stringify(command.runnerExecutionInput));
  assert.equal(JSON.stringify(after.unit.runnerExecutionInput), JSON.stringify(command.runnerExecutionInput));
  const { fingerprint, ...body } = after.run.runnerExecutionInput.preparedInput;
  assert.equal(fingerprint, createHash("sha256").update(JSON.stringify(body)).digest("hex"));
});

test("sealing preserves explicit model task and all existing policy, scope, provenance and unrelated request fields", async t => {
  const f = await workflowIsolationFixture(t); f.makeReady();
  const task = { ...f.executionPayload().input.task, prompt: "Frozen model prompt" };
  const additions = { task, policy: { networkAccess: false, approvalMode: "strict" }, custom: { retained: [1, 2] } };
  const before = requests(f);
  f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?")
    .run(JSON.stringify({ ...before.run, ...additions }), f.prepared.run.id);
  f.store.database.prepare("UPDATE work_units SET request_json=? WHERE id=?")
    .run(JSON.stringify(additions), f.prepared.unit.id);
  const original = requests(f), command = input(f);
  assert.equal(f.isolation.sealPreparedExecution(command).status, "updated");
  assert.deepEqual(requests(f), { run: { ...original.run, runnerExecutionInput: command.runnerExecutionInput },
    unit: { ...original.unit, runnerExecutionInput: command.runnerExecutionInput } });
});

test("seal projects a real complete durable Task without discarding its lifecycle metadata", async t => {
  const f = await workflowIsolationFixture(t); f.makeReady();
  const task = persistFullTaskRequests(f), original = requests(f), command = input(f);
  assert.equal(task.status, "claimed");
  assert.equal(typeof task.createdAt, "string");
  assert.equal(typeof task.updatedAt, "string");
  assert.deepEqual(command.runnerExecutionInput.input.task,
    { id: task.id, title: task.title, prompt: task.prompt, channelId: task.channelId });
  assert.notDeepEqual(command.runnerExecutionInput.input.task, task);
  const result = f.isolation.sealPreparedExecution(command);
  assert.equal(result.status, "updated", JSON.stringify(result));
  assert.deepEqual(requests(f), { run: { ...original.run, runnerExecutionInput: command.runnerExecutionInput },
    unit: { ...original.unit, runnerExecutionInput: command.runnerExecutionInput } });
  f.reopenIsolation();
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.sealPreparedExecution({ ...command, now: f.at(12) })).status, "duplicate");
});

for (const target of ["payload", "run", "unit"]) {
  for (const field of ["id", "title", "prompt", "channelId"]) {
    test(`complete Task projection cannot hide a changed ${target} ${field}`, async t => {
      const f = await workflowIsolationFixture(t); f.makeReady(); persistFullTaskRequests(f);
      const command = input(f);
      if (target === "payload") command.runnerExecutionInput.input.task[field] = `foreign-${field}`;
      else {
        const before = requests(f), snapshot = before[target];
        const changed = { ...snapshot, task: { ...snapshot.task, [field]: `foreign-${field}` } };
        if (target === "run") f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?")
          .run(JSON.stringify(changed), f.prepared.run.id);
        else f.store.database.prepare("UPDATE work_units SET request_json=? WHERE id=?")
          .run(JSON.stringify(changed), f.prepared.unit.id);
      }
      assert.equal(assertIsolationNoWrites(f, () => f.isolation.sealPreparedExecution(command)).status, "invalid");
    });
  }
}

test("different or partially persisted runner evidence conflicts without replacing either request", async t => {
  const f = await workflowIsolationFixture(t); f.makeReady(); const command = input(f);
  assert.equal(f.isolation.sealPreparedExecution(command).status, "updated");
  const changed = structuredClone(command);
  changed.runnerExecutionInput.preparedInput.systemPrompt = "different"; refingerprint(changed.runnerExecutionInput);
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.sealPreparedExecution(changed)).code,
    "workflow_isolation.prepared_input_already_sealed");
  f.store.database.prepare("UPDATE work_units SET request_json='{}' WHERE id=?").run(f.prepared.unit.id);
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.sealPreparedExecution(command)).code,
    "workflow_isolation.prepared_input_already_sealed");
});

for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
  test(`seal validates exact ${field} even on an otherwise identical duplicate`, async t => {
    const f = await workflowIsolationFixture(t); f.makeReady(); const command = input(f);
    assert.equal(f.isolation.sealPreparedExecution(command).status, "updated");
    const writer = { ...f.writer, [field]: field === "fencingToken" ? "999" : "foreign" };
    assert.equal(assertIsolationNoWrites(f, () => f.isolation.sealPreparedExecution({ ...command, writer })).status, "stale");
  });
}

test("seal is revision CAS and cannot run before physical ready or across pending Git effects", async t => {
  const f = await workflowIsolationFixture(t); f.bind(); f.link();
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.sealPreparedExecution(input(f))).code, "workflow_isolation.execution_not_ready");
  const intent = f.intent(), receipt = f.receipt(intent);
  assert.equal(f.isolation.markExecutionReady({ commandId: "ready-to-seal", writer: f.writer,
    expectedRevision: f.binding().revision, creationReceiptId: receipt.receiptId, now: f.at(10) }).status, "updated");
  const command = input(f);
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.sealPreparedExecution({ ...command, expectedRevision: 2 })).code,
    "workflow_isolation.revision_changed");
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.sealPreparedExecution({ ...command, expectedRevision: -1 })).code,
    "workflow_isolation.revision_invalid");
  f.intent({ intentId: "capture-before-seal", commandId: "capture-before-seal", kind: "branch_capture",
    before: f.gitIdentity(true), after: f.gitIdentity(true) });
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.sealPreparedExecution(input(f))).code, "workflow_isolation.execution_not_ready");
});

const payloadFaults = {
  cwd: p => { p.input.cwd = "/foreign"; },
  task: p => { p.input.task.prompt = "different"; },
  taskId: p => { p.input.task.id = "foreign-task"; },
  runner: p => { p.runnerId = "native"; },
  provider: p => { p.input.provider.provider = "foreign-provider"; },
  model: p => { p.input.provider.model = "foreign-model"; },
  headers: p => { p.input.provider.headers = {}; },
  secret: p => { p.input.provider.apiKey = "credential-not-for-storage"; },
  tool: p => { p.input.tools.push("bash"); },
  duplicateTool: p => { p.input.tools.push("read"); },
  actualSdkTool: p => { p.preparedInput.tools.push({ name: "bash", description: "Shell", parameters: {} }); refingerprint(p); },
  boundary: p => { p.preparedInput.boundary = "model-asserted-authority"; refingerprint(p); },
  fingerprint: p => { p.preparedInput.fingerprint = "0".repeat(64); },
};
for (const [fault, mutate] of Object.entries(payloadFaults)) {
  test(`seal rejects incompatible prepared ${fault} without any persistence`, async t => {
    const f = await workflowIsolationFixture(t); f.makeReady(); const command = input(f);
    mutate(command.runnerExecutionInput);
    assert.equal(assertIsolationNoWrites(f, () => f.isolation.sealPreparedExecution(command)).status, "invalid");
  });
}

const lifecycleFaults = {
  runStarted: f => f.store.database.prepare("UPDATE run_sessions SET started_at=? WHERE id=?").run(f.at(10), f.prepared.run.id),
  unitStarted: f => f.store.database.prepare("UPDATE work_units SET started_at=? WHERE id=?").run(f.at(10), f.prepared.unit.id),
  attemptStarted: f => f.store.database.prepare("UPDATE work_unit_attempts SET status='started',started_at=? WHERE id=?").run(f.at(10), f.prepared.attempt.id),
  attemptAbort: f => f.store.database.prepare("UPDATE work_unit_attempts SET abort_requested_at=? WHERE id=?").run(f.at(10), f.prepared.attempt.id),
  heartbeat: f => f.store.database.prepare("UPDATE work_unit_attempts SET last_heartbeat_at=? WHERE id=?").run(f.at(10), f.prepared.attempt.id),
  runnerIdentity: f => f.store.database.prepare("UPDATE work_unit_attempts SET effective_runner_id='native' WHERE id=?").run(f.prepared.attempt.id),
  lease: f => f.store.database.prepare("UPDATE resource_leases SET status='released',released_at=? WHERE id=?").run(f.at(10), f.generation.owner.leaseId),
  activeAttempt: f => f.store.database.prepare("UPDATE work_units SET active_attempt_id=NULL WHERE id=?").run(f.prepared.unit.id),
  toolEvent: f => f.store.appendEvent(f.prepared.run.id, "tool_start", { toolName: "write", toolCallId: "started" }, f.at(10)),
};
for (const [fault, mutate] of Object.entries(lifecycleFaults)) {
  test(`seal refuses ${fault} and cannot repair or take over execution authority`, async t => {
    const f = await workflowIsolationFixture(t); f.makeReady(); const command = input(f); mutate(f);
    assert.equal(assertIsolationNoWrites(f, () => f.isolation.sealPreparedExecution(command)).status, "stale");
  });
}

test("registered Host lifetime blocks sealing even before a started timestamp is persisted", async t => {
  const f = await workflowIsolationFixture(t); f.makeReady();
  let finish; const lifetime = new Promise(resolve => { finish = resolve; });
  const completion = f.store.trackHostAttemptCompletion({ runId: f.prepared.run.id, ...f.prepared.fence }, lifetime, () => true);
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.sealPreparedExecution(input(f))).code,
    "workflow_isolation.preparation_already_started");
  finish(); await completion;
});

for (const table of ["work_units", "workflow_isolation_bindings"]) {
  test(`seal rolls both request snapshots back on a late ${table} SQLite failure`, async t => {
    const f = await workflowIsolationFixture(t); f.makeReady(); const command = input(f);
    f.store.database.exec(`CREATE TEMP TRIGGER isolation_seal_fault BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'isolation-seal-fault'); END`);
    const before = f.snapshotIsolation();
    assert.throws(() => f.isolation.sealPreparedExecution(command), /isolation-seal-fault/);
    assert.deepEqual(f.snapshotIsolation(), before);
    assert.equal(f.store.database.isTransaction, false);
    f.store.database.exec("DROP TRIGGER isolation_seal_fault");
    assert.equal(f.isolation.sealPreparedExecution(command).status, "updated");
  });
}

test("seal never adopts or rolls back a caller-owned transaction", async t => {
  const f = await workflowIsolationFixture(t); f.makeReady(); const command = input(f);
  f.store.database.exec("BEGIN IMMEDIATE");
  try {
    f.store.database.prepare("UPDATE channel_workflows SET title='caller-kept' WHERE id=?").run(f.plan.workflowId);
    assert.throws(() => f.isolation.sealPreparedExecution(command), /transaction/i);
    assert.equal(f.store.database.isTransaction, true);
    assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, "caller-kept");
  } finally { f.store.database.exec("ROLLBACK"); }
});

test("terminal capture and round writes remain fail-closed after normal slot or start-lease release", async t => {
  const f = await workflowIsolationFixture(t); f.makeReady();
  f.store.database.prepare("UPDATE run_sessions SET status='succeeded',ended_at=? WHERE id=?").run(f.at(11), f.prepared.run.id);
  f.store.database.prepare("UPDATE work_units SET status='succeeded',ended_at=? WHERE id=?").run(f.at(11), f.prepared.unit.id);
  f.store.database.prepare("UPDATE work_unit_attempts SET status='succeeded',ended_at=? WHERE id=?").run(f.at(11), f.prepared.attempt.id);
  assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(f.prepared.fence, f.at(12), "finished"), 6);
  assert.equal(assertIsolationNoWrites(f, () => f.advance("collecting")).code, "workflow_isolation.admission_slots_changed");
  f.store.database.prepare("UPDATE resource_leases SET status='released',released_at=? WHERE id=?").run(f.at(12), f.generation.owner.leaseId);
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.recordIntent(f.intentInput({ intentId: "terminal-capture",
    commandId: "terminal-capture", kind: "branch_capture", before: f.gitIdentity(true), after: f.gitIdentity(true), now: f.at(13) }))).code,
  "workflow_isolation.start_lease_changed");
});
