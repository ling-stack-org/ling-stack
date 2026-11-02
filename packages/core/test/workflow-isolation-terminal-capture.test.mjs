import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SqliteRunTerminalIntentStore } from "../dist/storage/sqlite/run-terminal-intent-store.js";
import { workflowIsolationFixture, assertIsolationNoWrites } from "./support/workflow-isolation-fixture.mjs";

const now = () => new Date().toISOString();
const input = f => ({ writer: f.writer, expectedRevision: f.binding().revision, now: now() });
const read = (f, overrides = {}) => assertIsolationNoWrites(f, () => f.isolation.assertTerminalCapture({ ...input(f), ...overrides }));
const stopped = (f, overrides = {}) => assertIsolationNoWrites(f, () => f.isolation.inspectStoppedExecution({ ...input(f), ...overrides }));

async function terminalFixture(t, { coverage = true, drained = true, audit = true, terminal = true,
  outcome = "succeeded", tools = [], isolated = false } = {}) {
  const f = await workflowIsolationFixture(t); f.makeReady();
  const payload = f.executionPayload();
  if (isolated) {
    payload.input.isolatedToolsProfile = "host_isolated_files_v1";
    payload.preparedInput.tools.find(tool => tool.name === "write").parameters = { type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] };
    const { fingerprint: _fingerprint, ...body } = payload.preparedInput;
    payload.preparedInput.fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  }
  assert.equal(f.isolation.sealPreparedExecution({ writer: f.writer, expectedRevision: f.binding().revision,
    runnerExecutionInput: payload, now: f.at(11) }).status, "updated");
  // A controlled clock keeps the real durable Host observation after the fixture's planned lifecycle.
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(f.at(20)) });
  const fence = f.prepared.fence, runId = f.prepared.run.id;
  assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "queued", event: "claim", actor: "system", now: now() }).ok, true);
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: "started", startedAt: now(), now: now() }));
  assert.equal(f.store.transitionRunStatus({ runId, expectedStatus: "queued", event: "runner_started", actor: "runner", startedAt: now(), now: now() }).ok, true);
  assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started", actor: "runner", startedAt: now(), now: now() }).ok, true);
  assert.equal(f.store.transitionTaskStatus({ taskId: f.generation.task.id, expectedStatus: "claimed", event: "start_run",
    actor: "system", currentRunId: runId, now: now() }).ok, true);
  f.source = { runId, ...fence };
  for (const tool of tools) {
    f.store.appendEvent(runId, "tool_start", { ...tool, attemptId: fence.attemptId }, now());
    f.store.appendEvent(runId, "tool_end", { ...tool, attemptId: fence.attemptId, result: "done" }, now());
  }
  let finish;
  const lifetime = new Promise(resolve => { finish = resolve; });
  const completion = f.store.trackHostAttemptCompletion(f.source, lifetime, () => coverage);
  f.finish = async () => { finish(); return completion; };
  if (drained) await f.finish();
  else t.after(f.finish);
  f.terminal = () => {
    const event = outcome === "succeeded" ? "runner_succeeded" : "runner_failed";
    assert.equal(f.store.transitionRunStatus({ runId, expectedStatus: "running", event, actor: "runner", endedAt: now(), now: now() }).ok, true);
    assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "running", event, actor: "runner", endedAt: now(), now: now() }).ok, true);
    assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: outcome, endedAt: now(), now: now() }));
  };
  f.audit = () => f.store.appendTerminalRuntimeAudit({ capability: { ...fence, attemptStatus: outcome, transitionedAt: now() },
    type: outcome === "succeeded" ? "work_unit_succeeded" : "work_unit_failed", actor: "runner", data: { runId } });
  if (terminal) { f.terminal(); if (audit) f.audit(); }
  f.release = () => {
    f.store.releaseHostAttemptResources(f.source, now());
    assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 0);
    assert.equal(f.store.releaseResourceLease(f.generation.owner.leaseId, "workflow_step", f.plan.workflowStepId, now()), 1);
  };
  return f;
}

for (const outcome of ["succeeded", "failed"]) {
  test(`original ${outcome} capture remains authorized after real Host resource release and reopen`, async t => {
    const f = await terminalFixture(t, { outcome });
    const before = read(f);
    assert.equal(before.status, "authorized", JSON.stringify(before));
    assert.equal(before.terminal.outcome, outcome);
    assert.equal(before.terminal.completion.effectCoverage, "pi_no_tools_v1");
    assert.match(before.proofDigest, /^witc1_[a-f0-9]{64}$/u);
    const retired = stopped(f);
    assert.deepEqual(retired, { status: "stopped", binding: before.binding, plan: before.plan, proofDigest: before.proofDigest });
    f.release(); f.reopenIsolation();
    assert.deepEqual(read(f), before);
    assert.deepEqual(stopped(f), retired);
    t.mock.timers.tick(60_000);
    assert.deepEqual(read(f), before, "wall time alone does not grant or revoke capture evidence");
    assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, now: now() }).status, "stale");
    assert.equal(assertIsolationNoWrites(f, () => f.advance("collecting", { now: now() })).status, "stale");
    assert.equal(assertIsolationNoWrites(f, () => f.isolation.recordIntent(f.intentInput({ intentId: "terminal-capture",
      commandId: "terminal-capture", kind: "branch_capture", before: f.gitIdentity(true), after: f.gitIdentity(true), now: now() }))).status, "stale");
  });
}

test("original tracked builtin read coverage must have paired source-bound canonical tool events", async t => {
  const f = await terminalFixture(t, { tools: [{ toolCallId: "read-1", toolName: "read" }], coverage: {
    schemaVersion: 1, toolCallIds: ["read-1"], settledBuiltinReads: [{ toolCallId: "read-1", toolName: "read" }],
  } });
  assert.equal(read(f).status, "authorized");
  f.release(); f.reopenIsolation();
  assert.equal(read(f).status, "authorized");
});

const undispatched = [ { toolCallId: "denied-write", toolName: "write" },
  { toolCallId: "unknown-tool", toolName: "nonexistent_tool" } ];
const undispatchedCoverage = { schemaVersion: 1, toolCallIds: undispatched.map(tool => tool.toolCallId),
  settledBuiltinReads: [], undispatchedIsolatedCalls: undispatched };

test("Host-only SDK refusals retain their full inventory across release and SQLite reopen", async t => {
  const f = await terminalFixture(t, { isolated: true, tools: undispatched, coverage: undispatchedCoverage });
  assert.equal(f.store.getHostAttemptCompletion(f.source).effectCoverage, "pi_tracked_tools_v1");
  const inventory = JSON.parse(f.store.database.prepare("SELECT tracked_tool_calls_json FROM host_attempt_completions WHERE attempt_id=?")
    .get(f.source.attemptId).tracked_tool_calls_json);
  assert.deepEqual(inventory, undispatchedCoverage);
  assert.equal(read(f).status, "authorized");
  f.release(); f.reopenIsolation();
  assert.equal(f.store.getHostAttemptCompletion(f.source).effectCoverage, "pi_tracked_tools_v1");
  assert.equal(read(f).status, "authorized");
});

for (const fault of ["ordinary-profile", "unit-input", "profile-widened", "fingerprint", "run-pin", "foreign-source",
  "name-mismatch", "missing-end", "overlap-read", "host-producer"]) {
  test(`undispatched SDK inventory fails closed for ${fault}`, async t => {
    const coverage = structuredClone(undispatchedCoverage);
    if (fault === "name-mismatch") coverage.undispatchedIsolatedCalls[0].toolName = "read";
    if (fault === "overlap-read") coverage.settledBuiltinReads = [{ toolCallId: "denied-write", toolName: "read" }];
    const f = await terminalFixture(t, { isolated: fault !== "ordinary-profile", tools: undispatched,
      coverage, drained: false, terminal: false });
    if (["unit-input", "profile-widened", "fingerprint"].includes(fault)) {
      const run = f.store.getRun(f.source.runId), snapshot = structuredClone(run.requestSnapshot);
      if (fault === "unit-input") snapshot.runnerExecutionInput.input.tools.push("bash");
      if (fault === "profile-widened") snapshot.runnerExecutionInput.toolHydrationEnabled = true;
      if (fault === "fingerprint") snapshot.runnerExecutionInput.preparedInput.fingerprint = "0".repeat(64);
      f.store.database.prepare("UPDATE work_units SET request_json=? WHERE id=?")
        .run(JSON.stringify({ ...f.store.getWorkUnit(f.source.workUnitId).request, runnerExecutionInput: snapshot.runnerExecutionInput }), f.source.workUnitId);
      if (fault !== "unit-input") f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?")
        .run(JSON.stringify(snapshot), f.source.runId);
    }
    if (fault === "run-pin") {
      const snapshot = { ...f.store.getRun(f.source.runId).requestSnapshot, workflowIsolationPlan: { planId: "foreign", planDigest: "forged" } };
      f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?").run(JSON.stringify(snapshot), f.source.runId);
    }
    if (fault === "foreign-source" || fault === "missing-end") {
      const event = f.store.database.prepare("SELECT seq,data_json FROM run_events WHERE run_id=? AND type='tool_end' LIMIT 1").get(f.source.runId);
      if (fault === "foreign-source") f.store.database.prepare("UPDATE run_events SET data_json=? WHERE run_id=? AND seq=?")
        .run(JSON.stringify({ ...JSON.parse(event.data_json), attemptId: "foreign" }), f.source.runId, event.seq);
      else f.store.database.prepare("DELETE FROM run_events WHERE run_id=? AND seq=?").run(f.source.runId, event.seq);
    }
    if (fault === "host-producer") f.store.admitHostOperation({ operationId: "unexpected-producer", source: f.source,
      kind: "plugin", toolCallId: "denied-write", admittedAt: now() });
    await f.finish(); f.terminal(); f.audit();
    assert.equal(f.store.getHostAttemptCompletion(f.source).effectCoverage, undefined);
    assert.notEqual(read(f).status, "authorized");
  });
}

test("revoked policy can prove original stop but cannot authorize capture or any renewed writer", async t => {
  const f = await terminalFixture(t); f.release();
  f.store.updateChannel(f.channel.id, { allowedTools: ["read"] }, now());
  assert.equal(read(f).code, "workflow_isolation.terminal_lineage_changed");
  assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, now: now() }).status, "stale");
  assert.equal(stopped(f).status, "stopped");
  assert.equal("terminal" in stopped(f), false, "a stop proof is not a result publication grant");
  f.store.appendEvent(f.source.runId, "tool_start", { toolCallId: "untracked", toolName: "write", attemptId: f.writer.attemptId }, now());
  assert.notEqual(stopped(f).status, "stopped", "revocation never excuses untracked or unfinished tools");
});

test("unresolved original Host promise blocks terminal capture despite terminal rows and expired resources", async t => {
  const f = await terminalFixture(t, { drained: false });
  f.store.database.prepare("UPDATE runtime_semaphore_slots SET expires_at=?").run(f.at(-1));
  f.store.database.prepare("UPDATE resource_leases SET expires_at=?").run(f.at(-1));
  assert.equal(read(f).code, "workflow_isolation.terminal_host_not_drained");
  assert.equal(stopped(f).code, "workflow_isolation.terminal_host_not_drained");
  await f.finish();
  assert.equal(read(f).status, "authorized");
});

for (const [name, options, code] of [
  ["effect coverage", { coverage: false }, "effect_coverage_unverified"],
  ["original terminal audit", { audit: false }, "audit_unverified"],
  ["terminal lifecycle", { terminal: false }, "not_terminal"],
]) {
  test(`missing ${name} is not manufactured by a ready binding or confirmed creation receipt`, async t => {
    const f = await terminalFixture(t, options);
    assert.equal(read(f).code, `workflow_isolation.terminal_${code}`);
    assert.equal(stopped(f).code, `workflow_isolation.terminal_${code}`);
  });
}

test("raw terminal statuses alone do not constitute original Host terminal evidence", async t => {
  const f = await workflowIsolationFixture(t); f.makeReady();
  for (const [table, id] of [["run_sessions", f.prepared.run.id], ["work_units", f.prepared.unit.id], ["work_unit_attempts", f.prepared.attempt.id]])
    f.store.database.prepare(`UPDATE ${table} SET status='succeeded',ended_at=? WHERE id=?`).run(f.at(11), id);
  assert.equal(read(f, { now: f.at(12) }).code, "workflow_isolation.terminal_host_not_drained");
});

for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
  test(`terminal reader checks exact ${field} even after release and reopen`, async t => {
    const f = await terminalFixture(t); f.release(); f.reopenIsolation();
    assert.equal(read(f, { writer: { ...f.writer, [field]: field === "fencingToken" ? "999" : "foreign" } }).status, "stale");
    assert.equal(stopped(f, { writer: { ...f.writer, [field]: field === "fencingToken" ? "999" : "foreign" } }).status, "stale");
    assert.equal(read(f).status, "authorized");
  });
}

test("terminal reader validates binding revision and input rather than adopting caller authority", async t => {
  const f = await terminalFixture(t);
  assert.equal(read(f, { expectedRevision: f.binding().revision - 1 }).code, "workflow_isolation.revision_changed");
  assert.equal(read(f, { expectedRevision: -1 }).code, "workflow_isolation.revision_invalid");
  assert.equal(read(f, { now: "not-a-time" }).status, "invalid");
  assert.equal(read(f, { writer: { ...f.writer, fencingToken: "0" } }).status, "invalid");
  assert.equal(stopped(f, { expectedRevision: -1 }).code, "workflow_isolation.revision_invalid");
  assert.equal(stopped(f, { now: "not-a-time" }).status, "invalid");
  assert.equal(stopped(f, { writer: { ...f.writer, fencingToken: "0" } }).status, "invalid");
});

const lineageFaults = {
  scopePin: f => f.store.updateChannelWorkflowStep(f.plan.workflowStepId, { metadata: { ...f.current(f.scopeIsolation).metadata,
    isolationScopePlan: { planId: f.plan.planId, planDigest: `wip1_${"0".repeat(64)}` } } }, now()),
  safetyPin: f => f.store.updateChannelWorkflowStep(f.plan.workflowStepId, { metadata: { ...f.current(f.scopeIsolation).metadata, requiredTools: ["bash"] } }, now()),
  graphPin: f => f.store.updateChannelWorkflow(f.plan.workflowId, { metadata: { ...f.store.getChannelWorkflow(f.plan.workflowId).metadata,
    workflowGraphFingerprint: "changed" } }, now()),
  startOwner: f => f.store.updateChannelWorkflowStep(f.plan.workflowStepId, { metadata: { ...f.current(f.scopeIsolation).metadata,
    startOwner: { ...f.current(f.scopeIsolation).metadata.startOwner, taskId: "foreign" } } }, now()),
  runPin: f => f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json='{}' WHERE id=?").run(f.prepared.run.id),
  currentRun: f => f.store.database.prepare("UPDATE tasks SET current_run_id=NULL WHERE id=?").run(f.generation.task.id),
  cwd: f => f.store.database.prepare("UPDATE run_sessions SET cwd=? WHERE id=?").run(f.cwd, f.prepared.run.id),
  runner: f => f.store.database.prepare("UPDATE work_unit_attempts SET effective_runner_id='native' WHERE id=?").run(f.prepared.attempt.id),
  slotFence: f => f.store.database.prepare("UPDATE runtime_semaphore_slots SET fencing_token='999' WHERE id=(SELECT slot_id FROM workflow_step_admission_entries LIMIT 1)").run(),
  slotOwner: f => f.store.database.prepare("UPDATE runtime_semaphore_slots SET owner_id='foreign' WHERE id=(SELECT slot_id FROM workflow_step_admission_entries LIMIT 1)").run(),
};
for (const [name, mutate] of Object.entries(lineageFaults)) {
  test(`released original binding cannot capture across changed ${name}`, async t => {
    const f = await terminalFixture(t); f.release(); mutate(f);
    assert.equal(read(f).status, "stale");
  });
}

test("a newer current Attempt cannot borrow the original terminal binding or its released slots", async t => {
  const f = await terminalFixture(t); f.release();
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: f.prepared.unit.id, attemptNumber: 2, runtimeInstanceId: "next-runtime",
    runnerId: "pi", now: now() });
  assert.equal(read(f).status, "stale");
  assert.equal(read(f, { writer: { ...f.writer, attemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId,
    fencingToken: attempt.fencingToken } }).status, "stale");
});

test("a different active start lease vetoes capture rather than treating the old lease as a current owner", async t => {
  const f = await terminalFixture(t); f.release();
  assert.ok(f.store.acquireResourceLease({ workspaceId: f.channel.workspaceId, resourceType: "workflow_step", resourceKey: f.plan.workflowStepId,
    ownerType: "workflow_step", ownerId: f.plan.workflowStepId, acquiredAt: now(), expiresAt: f.at(200) }));
  assert.equal(read(f).code, "workflow_isolation.terminal_lease_owner_changed");
});

for (const [name, mutate] of Object.entries({
  workflow: f => f.store.database.prepare("UPDATE channel_workflows SET status='cancelled' WHERE id=?").run(f.plan.workflowId),
  step: f => f.store.database.prepare("UPDATE channel_workflow_steps SET status='cancelled' WHERE id=?").run(f.plan.workflowStepId),
  task: f => f.store.database.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(f.generation.task.id),
  abort: f => f.store.database.prepare("UPDATE work_unit_attempts SET abort_requested_at=? WHERE id=?").run(now(), f.prepared.attempt.id),
})) {
  test(`late ${name} cancellation blocks the original otherwise complete terminal proof`, async t => {
    const f = await terminalFixture(t); f.release(); mutate(f);
    assert.equal(read(f).code, "workflow_isolation.terminal_cancellation_unverified");
    assert.equal(stopped(f).status, "stopped", "physical stop does not restore the cancelled publication authority");
  });
}

for (const [name, events, coverage] of [
  ["untracked", [{ type: "tool_start", toolCallId: "unknown", toolName: "write" }, { type: "tool_end", toolCallId: "unknown", toolName: "write" }], true],
  ["unpaired", [{ type: "tool_start", toolCallId: "read-1", toolName: "read" }], { schemaVersion: 1, toolCallIds: ["read-1"], settledBuiltinReads: [{ toolCallId: "read-1", toolName: "read" }] }],
  ["foreign", [{ type: "tool_start", toolCallId: "read-1", toolName: "read", attemptId: "foreign" }, { type: "tool_end", toolCallId: "read-1", toolName: "read" }], { schemaVersion: 1, toolCallIds: ["read-1"], settledBuiltinReads: [{ toolCallId: "read-1", toolName: "read" }] }],
]) {
  test(`${name} tool events cannot be covered by terminal status or a different inventory`, async t => {
    const f = await terminalFixture(t, { coverage });
    for (const { type, ...event } of events) f.store.appendEvent(f.prepared.run.id, type, { attemptId: f.writer.attemptId, ...event }, now());
    assert.equal(read(f).code, "workflow_isolation.terminal_tool_inventory_unverified");
  });
}

test("a tool update arriving after original drain invalidates a previously authorized capture", async t => {
  const f = await terminalFixture(t, { tools: [{ toolCallId: "read-1", toolName: "read" }], coverage: {
    schemaVersion: 1, toolCallIds: ["read-1"], settledBuiltinReads: [{ toolCallId: "read-1", toolName: "read" }],
  } });
  const before = read(f); assert.equal(before.status, "authorized");
  t.mock.timers.tick(1);
  f.store.appendEvent(f.prepared.run.id, "tool_update", { attemptId: f.writer.attemptId, toolCallId: "read-1", toolName: "read", partialResult: "late" }, now());
  assert.equal(read(f).status, "blocked");
});

for (const outcome of ["queued", "running", "succeeded", "failed", "cancelled"]) {
  test(`an unowned ${outcome} descendant is never silently excluded from terminal capture`, async t => {
    const f = await terminalFixture(t);
    const child = f.store.createRun({ id: `unowned-child-${outcome}`, cwd: f.executionRoot, taskId: "unowned-task", parentRunId: f.prepared.run.id,
      channelId: f.channel.id, workflowStepId: f.plan.workflowStepId, providerName: "fixture", providerModel: "fixture", taskSnapshot: {},
      providerSnapshot: {}, requestSnapshot: {}, createdAt: now() });
    if (outcome !== "queued") f.store.database.prepare("UPDATE run_sessions SET status=? WHERE id=?").run(outcome, child.id);
    assert.equal(read(f).code, "workflow_isolation.terminal_descendants_unverified");
  });
}

test("an open Git intent blocks capture even when all runtime effects have drained", async t => {
  const f = await workflowIsolationFixture(t); f.makeReady();
  f.intent({ intentId: "capture-open", commandId: "capture-open", kind: "branch_capture", before: f.gitIdentity(true), after: f.gitIdentity(true) });
  assert.equal(read(f, { now: f.at(20) }).code, "workflow_isolation.terminal_git_effect_unconfirmed");
});

test("advancing the real round generation makes the old terminal binding stale without changing its fence", async t => {
  const f = await terminalFixture(t);
  assert.equal(read(f).status, "authorized");
  assert.equal(f.advance("blocked", { now: now(), reason: "retry explicitly requested" }).status, "updated");
  const round = f.round();
  const result = f.isolation.beginIntegrationRoundGeneration({ commandId: "new-generation", roundId: f.roundId,
    expectedGeneration: round.generation, expectedRevision: round.revision, inputs: { ...f.inputs,
      integration: { executionRoot: `${f.root}/integration-2`, worktreeId: "integration-2", branchRef: "refs/heads/ling/integration-2" } },
    writer: f.writer, now: now() });
  assert.equal(result.status, "created", JSON.stringify(result));
  assert.equal(read(f).code, "workflow_isolation.terminal_lineage_changed");
});

test("pending durable cancellation intent vetoes an otherwise finished original source", async t => {
  const f = await terminalFixture(t, { terminal: false });
  const intents = new SqliteRunTerminalIntentStore({ database: f.store.database }, {
    getRun: id => f.store.getRun(id), getHostAttemptCompletion: source => f.store.getHostAttemptCompletion(source),
    getArtifact: id => f.store.getArtifact(id), createArtifactWithinTransaction: value => f.store.artifacts.createArtifactWithinTransaction(value),
  });
  const intent = intents.prepareRunTerminalIntent({ runId: f.prepared.run.id, sourceFence: f.prepared.fence,
    desiredOutcome: "cancelled", errorCode: "late-cancel", errorMessage: "Original execution cancellation requested", now: now() });
  assert.equal(intent.state, "pending");
  f.terminal(); f.audit();
  assert.equal(read(f).code, "workflow_isolation.terminal_intent_pending");
});

test("a Host completion earlier than the original execution start cannot certify physical drain", async t => {
  const f = await terminalFixture(t);
  f.store.database.prepare("UPDATE work_unit_attempts SET started_at=? WHERE id=?").run(f.at(21), f.prepared.attempt.id);
  assert.equal(read(f).code, "workflow_isolation.terminal_effect_coverage_unverified");
});

test("terminal reader owns no caller transaction and leaves query_only and outer changes intact", async t => {
  const f = await terminalFixture(t);
  f.store.database.exec("BEGIN IMMEDIATE");
  try {
    f.store.database.prepare("UPDATE channel_workflows SET title='caller-kept' WHERE id=?").run(f.plan.workflowId);
    assert.throws(() => f.isolation.assertTerminalCapture(input(f)), /transaction/i);
    assert.throws(() => f.isolation.inspectStoppedExecution(input(f)), /transaction/i);
    assert.equal(f.store.database.isTransaction, true);
    assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, "caller-kept");
    assert.equal(f.store.database.prepare("PRAGMA query_only").get().query_only, 0);
  } finally { f.store.database.exec("ROLLBACK"); }
  f.store.database.exec("PRAGMA query_only=ON");
  try {
    assert.equal(read(f).status, "authorized");
    assert.equal(f.store.database.prepare("PRAGMA query_only").get().query_only, 1);
    assert.equal(f.store.database.isTransaction, false);
  } finally { f.store.database.exec("PRAGMA query_only=OFF"); }
});
