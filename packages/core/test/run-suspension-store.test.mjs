import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as core from "../dist/index.js";
import { SqliteRunSuspensionStore, hasPendingRunSuspension, assertNoRunSuspensionAdmission } from "../dist/storage/sqlite/run-suspension-store.js";
import { applyRunSuspensionMigration } from "../dist/storage/sqlite/run-suspension-migration.js";
import { SqliteRunTerminalIntentStore } from "../dist/storage/sqlite/run-terminal-intent-store.js";

const at = () => new Date().toISOString();
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Real isolated SQLite/domain authority. No SDK, model, process-stop or packaged GUI claim. */
async function fixture(t, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-suspension-authority-")), now = at();
  let store = core.createSqliteRunStore(cwd), fault;
  const migrate = (overrides = {}) => applyRunSuspensionMigration({ database: store.database,
    hasMigration: version => Boolean(store.database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => store.database.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(version, name, at()), ...overrides });
  if (options.migrate !== false) assert.equal(migrate(), false, "production constructor already installed authority 182");
  else {
    // Raw migration negative cases own only this brand-new, row-free temporary
    // overlay. Production startup is never taught a partial-schema fallback.
    assert.equal(store.database.prepare("SELECT COUNT(*) n FROM run_suspensions").get().n, 0);
    store.database.exec("DROP TABLE run_suspensions; DELETE FROM schema_migrations WHERE version=182");
  }
  const channel = store.createChannel({ name: "Only isolated suspension", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Safe boundary", prompt: "Inspect a local result once." }, now);
  const thread = store.createLingThread({ kind: "task", channelId: channel.id, taskId: task.id, title: task.title, objective: task.prompt }, now);
  const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Isolated source", providerId: "fixture",
    model: "fixture-model", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", capabilities: ["chat", "tool_call"], enabled: true }, now);
  const taskInput = { id: task.id, title: task.title, prompt: task.prompt, channelId: channel.id };
  const accepted = `Channel: ${channel.id}\n\nTask: ${task.title}\n\n${task.prompt}`;
  const preparedBody = { schemaVersion: 1, boundary: "pi-model-context", taskId: task.id, systemPrompt: "Fixture system",
    userPrompt: accepted, model: { id: "fixture-model", provider: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
      reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 8192 }, thinkingLevel: "off",
    tools: [{ name: "bash", description: "Fixture bash", parameters: { type: "object" } }] };
  const execution = { schemaVersion: 1, runnerId: "pi", input: { cwd, task: taskInput, provider: { provider: "fixture",
    model: "fixture-model", api: "openai-completions", baseUrl: "https://fixture.invalid/v1" }, tools: ["bash"], systemPrompt: "Fixture system" },
    toolHydrationEnabled: false, preparedInput: { ...preparedBody, fingerprint: hash(preparedBody) } };
  const policy = core.applyConversationModeToEffectiveRunPolicySnapshot(core.resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(),
    authorizationMode: "always", workspaceAccessMode: "full_access", channelBoundPath: cwd }).snapshot, "default");
  const unit = store.createWorkUnit({ workspaceId: core.DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "task", ownerId: task.id,
    taskId: task.id, channelId: channel.id, runnerId: "pi", status: "running", idempotencyKey: "suspension-source", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "original-source",
    runnerId: "pi", effectiveRunnerId: "pi", providerPresetId: preset.id, status: "started", now });
  const run = store.createRun({ id: "suspension-run", cwd, taskId: task.id, channelId: channel.id, threadId: thread.id, workUnitId: unit.id,
    providerPresetId: preset.id, providerName: "fixture", providerModel: "fixture-model", taskSnapshot: taskInput, providerSnapshot: {},
    requestSnapshot: { authorizationMode: "always", workspaceAccessMode: "full_access", effectivePolicySnapshot: policy, runnerExecutionInput: execution },
    contextViewId: "suspension-context", contextViewCreatedAt: now, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now); store.markRunStarted(run.id, now);
  const fence = core.toRuntimeAttemptFence(attempt), source = { runId: run.id, ...fence };
  if (options.events !== false) store.appendExecutionEvent(run.id, fence, "run_start", { taskId: task.id, cwd, provider: "fixture", model: "fixture-model" });
  const methods = ["getRun", "getWorkUnit", "getWorkUnitAttempt", "getApprovalPolicy", "getLingThread", "getChannel", "getProviderPreset",
    "getAiTeammate", "listTeammateSkillBindings", "getSkillRegistryEntry", "getLatestWorkspaceProvenanceWatermark", "getArtifact",
    "readRunProgressCheckpointForRecovery", "getChannelWorkflowStep", "getChannelWorkflow"];
  const ports = { ...Object.fromEntries(methods.map(name => [name, (...args) => store[name](...args)])),
    createArtifactWithinTransaction(input) {
      const result = store.artifacts.createArtifactWithinTransaction(input);
      if (fault === "artifact") throw new Error("injected-suspension-artifact");
      if (fault === "tail" && input.path === "sqlite:run-suspension-seal") store.appendExecutionEvent(run.id, fence, "assistant_text_delta", { text: "late" });
      return result;
    } };
  let authority = new SqliteRunSuspensionStore({ database: store.database }, ports);
  const currentLineage = () => core.captureRunProgressCheckpointLineage(store, store.getRun(run.id), policy).lineage;
  const request = (changes = {}) => authority.requestRunSuspension({ runId: run.id, sourceFence: fence, cause: "daemon_restart", expectedLineage: currentLineage(), now: at(), ...changes });
  const view = [{ role: "user", content: accepted, timestamp: 1 }];
  const checkpoint = (changes = {}) => {
    const result = store.commitRunProgressCheckpoint({ runId: run.id, sourceFence: fence,
      expectedHead: { checkpointId: null, revision: 0 }, sourceEventSeq: store.listEvents(run.id).at(-1)?.seq ?? 0,
      expectedLineage: currentLineage(), modelView: view, now: at(), ...changes });
    assert.equal(result.kind, "committed", JSON.stringify(result));
    const verified = store.readRunProgressCheckpointForRecovery({ runId: run.id, sourceFence: fence, expectedLineage: currentLineage() });
    assert.equal(verified.kind, "verified", JSON.stringify(verified));
    return { kind: "ordinary", checkpoint: verified.witness };
  };
  const seal = (record, expected, changes = {}) => authority.sealRunSuspension({ suspensionId: record.id, sourceFence: fence, witness: expected, now: at(), ...changes });
  const addRound = (id = "read-once") => {
    const args = { command: `echo ${id}` }, content = [{ type: "text", text: `result ${id}` }];
    view.push({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: args }], stopReason: "toolUse", timestamp: 2 });
    store.appendExecutionEvent(run.id, fence, "tool_start", { toolCallId: id, toolName: "bash", args });
    const ticket = store.prepareHostCommandExecution({ runId: run.id, sourceFence: fence, toolCallId: id,
      command: { kind: "shell", command: args.command, shell: "bash" }, cwd });
    store.settleHostCommandExecution(ticket, { kind: "observed", observation: { scope: "process_group", leaderExited: true,
      stdioClosed: true, descendants: "unverified", settledBy: "close", signalFailures: [] } });
    store.appendExecutionEvent(run.id, fence, "tool_end", { toolCallId: id, toolName: "bash", result: { content }, isError: false });
    view.push({ role: "toolResult", toolCallId: id, toolName: "bash", content, isError: false, timestamp: 3 });
  };
  const snapshot = () => ["run_suspensions", "artifacts", "harness_artifact_pins", "harness_artifact_pin_events", "run_sessions", "run_events",
    "work_units", "work_unit_attempts", "resource_leases", "runtime_semaphore_slots", "delegation_budget_reservations", "delegation_budget_charges", "runner_continuations"]
    .map(table => [table, store.database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]);
  const ownership = () => snapshot().filter(([name]) => !["run_suspensions", "artifacts", "harness_artifact_pins", "harness_artifact_pin_events"].includes(name));
  const reopen = () => { store.close(); store = core.createSqliteRunStore(cwd); authority = new SqliteRunSuspensionStore({ database: store.database }, ports); migrate(); };
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, get store() { return store; }, get authority() { return authority; }, ports, run, unit, attempt, fence, source, policy,
    thread, channel, task, preset, now, view, request, checkpoint, seal, addRound, snapshot, ownership, reopen, migrate, currentLineage,
    setFault: value => { fault = value; } };
}

test("request is private durable intent only; it preserves all owner, event, budget and resource facts", async t => {
  const f = await fixture(t), before = f.ownership(), record = f.request();
  assert.equal(typeof f.store.requestRunSuspension, "undefined");
  assert.equal(record.state, "requested"); assert.equal(record.seal, undefined);
  assert.equal(f.store.getHostAttemptCompletion(f.source), undefined, "request is not fabricated physical completion");
  assert.deepEqual(f.ownership(), before);
  assert.equal(hasPendingRunSuspension({ database: f.store.database }, f.source), true);
  assert.throws(() => assertNoRunSuspensionAdmission({ database: f.store.database }, f.run.id), /suspension.admission_closed/);
  const snapshot = f.snapshot(); assert.deepEqual(f.request(), record); assert.deepEqual(f.snapshot(), snapshot);
});

test("a verified pristine checkpoint seals the original request but still does not stop, settle, refund or resume", async t => {
  const f = await fixture(t), request = f.request(), expected = f.checkpoint(), before = f.ownership();
  const sealed = f.seal(request, expected); assert.equal(sealed.state, "sealed");
  assert.equal(sealed.seal.requestDigest, request.requestDigest); assert.deepEqual(sealed.seal.witness, expected);
  assert.deepEqual(f.ownership(), before); assert.equal(f.store.getHostAttemptCompletion(f.source), undefined);
  const snapshot = f.snapshot(); assert.deepEqual(f.seal(request, expected), sealed); assert.deepEqual(f.snapshot(), snapshot);
});

test("same-source in-flight events may finish after request; seal binds the current exact completed-tool tail", async t => {
  const f = await fixture(t), request = f.request(); f.addRound(); const expected = f.checkpoint();
  assert.ok(expected.checkpoint.sourceEventSeq > request.request.requestedEventSeq);
  assert.equal(f.seal(request, expected).state, "sealed");
});

test("real SQLite close/reopen preserves request and sealed view pins without generating an Attempt", async t => {
  const f = await fixture(t), request = f.request(); f.reopen();
  assert.deepEqual(f.authority.getRunSuspension(request.id), request);
  const sealed = f.seal(request, f.checkpoint()), snapshot = f.snapshot(); f.reopen();
  assert.deepEqual(f.authority.getRunSuspension(sealed.id), sealed); assert.deepEqual(f.snapshot(), snapshot);
  assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 1);
});

for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) test(`foreign ${field} cannot request or seal for the original source`, async t => {
  const f = await fixture(t), old = { ...f.fence, [field]: "foreign" }, before = f.snapshot();
  assert.throws(() => f.request({ sourceFence: old })); assert.deepEqual(f.snapshot(), before);
  const request = f.request(), expected = f.checkpoint(), snapshot = f.snapshot();
  assert.throws(() => f.seal(request, expected, { sourceFence: old })); assert.deepEqual(f.snapshot(), snapshot);
});

test("changed cause cannot overwrite the first source request after response loss", async t => {
  const f = await fixture(t), original = f.request(), before = f.snapshot();
  assert.throws(() => f.request({ cause: "desktop_quit" }), /suspension.request_conflict/);
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.authority.getRunSuspension(original.id), original);
});

test("missing/pristine-not-needed and caller booleans are not a sealed checkpoint authority", async t => {
  const f = await fixture(t), request = f.request(), before = f.snapshot();
  const fake = { kind: "ordinary", checkpoint: { checkpointId: "missing", headRevision: 1, modelViewSha256: "a".repeat(64),
    sourceEventSeq: request.request.requestedEventSeq, sourceFence: f.fence, lineage: f.currentLineage() } };
  assert.throws(() => f.seal(request, fake), /suspension.snapshot_unverified/);
  for (const value of [true, { verified: true }, { kind: "compacted", checkpoint: {} }]) assert.throws(() => f.seal(request, value));
  assert.deepEqual(f.snapshot(), before);
});

for (const field of ["checkpointId", "headRevision", "modelViewSha256", "sourceEventSeq"]) test(`changed checkpoint ${field} cannot borrow another head's proof`, async t => {
  const f = await fixture(t), request = f.request(), expected = f.checkpoint(), before = f.snapshot();
  const original = expected.checkpoint[field];
  const changed = { kind: "ordinary", checkpoint: { ...expected.checkpoint, [field]: typeof original === "number" ? original + 1 : field === "modelViewSha256" ? "f".repeat(64) : "foreign" } };
  assert.throws(() => f.seal(request, changed), /suspension.witness_mismatch/); assert.deepEqual(f.snapshot(), before);
});

for (const mutation of ["context", "policy", "provider", "provenance", "selection"]) test(`${mutation} drift after request rejects sealing without orphan artifacts or partial state`, async t => {
  const f = await fixture(t), workflow = f.store.createChannelWorkflow({ channelId: f.channel.id, title: "Frozen selected design", objective: f.task.prompt,
    createdBy: "local-user", status: "running" }, at());
  const step = f.store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Original step", prompt: f.task.prompt,
    toParticipantId: "ling_agent", toParticipantLabel: "Ling", status: "running" }, at());
  f.store.database.prepare("UPDATE run_sessions SET workflow_step_id=? WHERE id=?").run(step.id, f.run.id);
  const request = f.request(), expected = f.checkpoint();
  if (mutation === "context") f.store.database.prepare("UPDATE run_sessions SET context_view_id='changed' WHERE id=?").run(f.run.id);
  if (mutation === "policy") f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, at());
  if (mutation === "provider") f.store.database.prepare("UPDATE provider_presets SET enabled=0 WHERE id=?").run(f.preset.id);
  if (mutation === "provenance") {
    const inverse = f.store.createArtifact({ runId: f.run.id, type: "json", path: "fixture-inverse.json", sealedPayload: {}, createdAt: at() });
    f.store.createWorkspaceMutationRecord({ cwd: f.cwd, threadId: f.thread.id, runId: f.run.id, patchPlanId: "fixture-plan", operationIndex: 0,
      path: "result.txt", operation: "add", beforeSha256: "before", afterSha256: "after", inversePatchArtifactId: inverse.id,
      sourceRefs: [{ type: "run", id: f.run.id }], createdAt: at() });
  }
  if (mutation === "selection") f.store.updateChannelWorkflowStep(step.id, { prompt: "Changed selected objective" }, at());
  const before = f.snapshot(); assert.throws(() => f.seal(request, expected)); assert.deepEqual(f.snapshot(), before);
});

test("a newer Attempt cannot consume the old request even when Run and Work Unit identities are reused", async t => {
  const f = await fixture(t), request = f.request(), expected = f.checkpoint();
  f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2, runtimeInstanceId: "successor", runnerId: "pi", status: "started", now: at() });
  const before = f.snapshot(); assert.throws(() => f.seal(request, expected), /suspension.source_stale/); assert.deepEqual(f.snapshot(), before);
});

test("late canonical events invalidate a checkpoint even when its ID and view hash are unchanged", async t => {
  const f = await fixture(t), request = f.request(), expected = f.checkpoint();
  f.store.appendExecutionEvent(f.run.id, f.fence, "assistant_text_delta", { text: "late production" });
  const before = f.snapshot(); assert.throws(() => f.seal(request, expected), /suspension.snapshot_unverified/); assert.deepEqual(f.snapshot(), before);
});

test("current unknown Host effects veto an otherwise intact existing view", async t => {
  const f = await fixture(t), request = f.request(), expected = f.checkpoint();
  f.store.admitHostOperation({ operationId: "unknown-plugin", source: f.source, kind: "plugin", toolCallId: "unknown", admittedAt: at() });
  const before = f.snapshot(); assert.throws(() => f.seal(request, expected), /suspension.snapshot_unverified/); assert.deepEqual(f.snapshot(), before);
});

test("partial tools and final assistant stop views do not gain a suspension allowlist", async t => {
  const f = await fixture(t), request = f.request();
  for (const tail of [{ role: "assistant", content: [{ type: "toolCall", id: "partial", name: "bash", arguments: { command: "echo x" } }], stopReason: "toolUse" },
    { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" }]) {
    const result = f.store.commitRunProgressCheckpoint({ runId: f.run.id, sourceFence: f.fence, expectedHead: { checkpointId: null, revision: 0 },
      sourceEventSeq: request.request.requestedEventSeq, expectedLineage: f.currentLineage(), modelView: [...f.view, tail], now: at() });
    assert.equal(result.kind, "blocked");
  }
  assert.equal(f.authority.getRunSuspension(request.id).state, "requested");
});

test("artifact failures and a write-port tail race roll back the entire seal and all pins", async t => {
  const f = await fixture(t), empty = f.snapshot(); f.setFault("artifact");
  assert.throws(() => f.request(), /injected-suspension-artifact/); assert.deepEqual(f.snapshot(), empty);
  f.setFault(undefined); const request = f.request(), expected = f.checkpoint(), before = f.snapshot();
  for (const failure of ["artifact", "tail"]) {
    f.setFault(failure); assert.throws(() => f.seal(request, expected)); assert.deepEqual(f.snapshot(), before);
  }
  f.setFault(undefined); assert.equal(f.seal(request, expected).state, "sealed");
});

for (const kind of ["request", "checkpoint", "seal"]) test(`actual ${kind} body byte corruption is rejected, not hidden by parsed JSON`, async t => {
  const f = await fixture(t), request = f.request(), expected = f.checkpoint();
  const sealed = kind === "seal" ? f.seal(request, expected) : undefined;
  const artifactId = kind === "request" ? request.requestArtifactId : kind === "seal" ? sealed.sealArtifactId
    : f.store.database.prepare("SELECT model_view_artifact_id id FROM run_progress_checkpoints WHERE id=?").get(expected.checkpoint.checkpointId).id;
  f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=sealed_payload_json||' ' WHERE id=?").run(artifactId);
  const before = f.snapshot(); assert.throws(() => kind === "seal" ? f.authority.getRunSuspension(request.id) : f.seal(request, expected));
  assert.deepEqual(f.snapshot(), before);
});

test("request, seal and original checkpoint remain recovery/audit pinned through explicit Host GC", async t => {
  const f = await fixture(t), sealed = f.seal(f.request(), f.checkpoint());
  const ids = [sealed.requestArtifactId, sealed.sealArtifactId, sealed.seal.modelViewArtifactId];
  for (const artifactId of ids) f.store.enrollHarnessArtifactRetention({ artifactId, retainUntil: at(), now: at() });
  assert.deepEqual(f.store.collectHarnessArtifactBodies({ now: at() }).prunedArtifactIds, []);
  const pins = f.store.database.prepare("SELECT artifact_id,reason FROM harness_artifact_pins WHERE released_at IS NULL ORDER BY artifact_id,reason").all();
  for (const id of ids) assert.deepEqual(pins.filter(pin => pin.artifact_id === id).map(pin => pin.reason), ["audit_hold", "recovery"]);
});

test("an original failed/cancelled terminal intent prevents suspension from competing for its source", async t => {
  const f = await fixture(t), release = Promise.resolve();
  await f.store.trackHostAttemptCompletion(f.source, release, () => true);
  const terminal = new SqliteRunTerminalIntentStore({ database: f.store.database }, { ...f.ports,
    getHostAttemptCompletion: source => f.store.getHostAttemptCompletion(source) });
  terminal.prepareRunTerminalIntent({ runId: f.run.id, sourceFence: f.fence, desiredOutcome: "failed",
    errorCode: "controlled", errorMessage: "Original failed disposition", now: at() });
  const before = f.snapshot(); assert.throws(() => f.request(), /suspension.terminal_intent/); assert.deepEqual(f.snapshot(), before);
});

test("migration is replay-stable; missing recorded authority fails closed and never self-repairs", async t => {
  const f = await fixture(t), before = f.snapshot(); assert.equal(f.migrate(), false); assert.deepEqual(f.snapshot(), before);
  f.store.database.exec("DROP INDEX idx_run_suspensions_requested");
  assert.throws(() => f.migrate(), /run_suspension_migration_schema_missing/);
  assert.equal(f.store.database.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_run_suspensions_requested'").get(), undefined);
});

test("request can audit the empty canonical watermark without fabricating a Run event", async t => {
  const f = await fixture(t, { events: false }), before = f.ownership(), request = f.request();
  assert.equal(request.request.requestedEventSeq, 0); assert.deepEqual(f.ownership(), before);
  f.store.appendExecutionEvent(f.run.id, f.fence, "run_start", { taskId: f.task.id, cwd: f.cwd, provider: "fixture", model: "fixture-model" });
  assert.equal(f.seal(request, f.checkpoint()).state, "sealed");
});

test("a pending ancestor closes admission for descendants but not unrelated source identities", async t => {
  const f = await fixture(t), child = f.store.createRun({ id: "only-child", taskId: f.task.id, channelId: f.channel.id,
    cwd: f.cwd, parentRunId: f.run.id, providerName: "fixture", providerModel: "fixture-model",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: at() });
  f.request();
  assert.throws(() => assertNoRunSuspensionAdmission({ database: f.store.database }, child.id), /suspension.admission_closed/);
  assert.equal(hasPendingRunSuspension({ database: f.store.database }, { ...f.source, fencingToken: "other" }), false);
});

test("missing request/seal pins fail closed instead of reseeding an audit trail", async t => {
  const f = await fixture(t), sealed = f.seal(f.request(), f.checkpoint());
  f.store.database.prepare("UPDATE harness_artifact_pins SET released_at=? WHERE artifact_id=? AND reason='recovery'").run(at(), sealed.sealArtifactId);
  const before = f.snapshot(); assert.throws(() => f.authority.getRunSuspension(sealed.id), /suspension.pin_missing/);
  assert.throws(() => f.seal(sealed, sealed.seal.witness), /suspension.pin_missing/); assert.deepEqual(f.snapshot(), before);
});

test("source and original request fields are immutable and a seal cannot be rewritten", async t => {
  const f = await fixture(t), request = f.request(), before = f.snapshot();
  for (const change of ["run_id='foreign'", "request_digest='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'", "requested_event_seq=requested_event_seq+1"])
    assert.throws(() => f.store.database.exec(`UPDATE run_suspensions SET ${change}`), /run_suspension_immutable/);
  assert.deepEqual(f.snapshot(), before);
  const sealed = f.seal(request, f.checkpoint()), snapshot = f.snapshot();
  assert.throws(() => f.store.database.prepare("UPDATE run_suspensions SET sealed_at=? WHERE id=?").run(at(), sealed.id), /run_suspension_immutable/);
  assert.deepEqual(f.snapshot(), snapshot);
});

test("request/write/read never adopt or roll back an unrelated caller-owned transaction", async t => {
  const f = await fixture(t), request = f.request(), db = f.store.database;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE tasks SET title='caller-owned-change' WHERE id=?").run(f.task.id);
    assert.throws(() => f.request(), /within a transaction/);
    assert.throws(() => f.authority.getRunSuspension(request.id), /within a transaction/);
    assert.equal(db.isTransaction, true); assert.equal(f.store.getTask(f.task.id).title, "caller-owned-change");
  } finally { db.exec("ROLLBACK"); }
  assert.equal(f.store.getTask(f.task.id).title, f.task.title);
});

for (const kind of ["marker failure", "schema drift", "marker conflict"]) test(`migration ${kind} fails closed without partial authority objects`, async t => {
  const f = await fixture(t, { migrate: false }), db = f.store.database;
  if (kind === "schema drift") db.exec("CREATE TABLE run_suspensions(id TEXT)");
  if (kind === "marker conflict") db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(182, "unrelated-authority", at());
  const before = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
  assert.throws(() => f.migrate(kind === "marker failure" ? { recordMigration() { throw new Error("injected-suspension-marker"); } } : {}),
    kind === "marker failure" ? /injected-suspension-marker/ : /run_suspension_migration_(?:schema|marker)_conflict/);
  assert.deepEqual(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(), before);
  if (kind === "marker failure") {
    assert.equal(db.prepare("SELECT 1 FROM schema_migrations WHERE version=182").get(), undefined); assert.equal(f.migrate(), true);
  }
});

test("recorded missing suspension table is an admission veto, not a legacy-open fallback", async t => {
  const f = await fixture(t); f.store.database.exec("DROP TABLE run_suspensions");
  assert.throws(() => hasPendingRunSuspension({ database: f.store.database }, f.source), /suspension.schema_missing/);
  assert.throws(() => assertNoRunSuspensionAdmission({ database: f.store.database }, f.run.id), /suspension.schema_missing/);
});
