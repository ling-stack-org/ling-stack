import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createSqliteRunStore,
  DEFAULT_WORKSPACE_ID,
  HarnessDiagnosticsStoreError,
  resolveRuntimePaths,
  validateHarnessDiagnosticQuery,
} from "../dist/index.js";
import { SqliteHarnessDiagnosticsStore } from "../dist/storage/sqlite/harness-diagnostics-store.js";

const now = "2026-10-09T00:00:00.000Z";
const later = "2026-10-09T00:01:00.000Z";
const privateValue = "diagnostic-private-payload-must-not-be-read";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-harness-diagnostics-"));
  const f = { cwd, store: createSqliteRunStore(cwd) };
  f.database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => {
    try { f.database.close(); } catch {}
    try { f.store.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
  });
  const channel = f.store.createChannel({ name: "Diagnostics", boundPath: cwd }, now);
  const task = f.store.createTask({ channelId: channel.id, title: "Metadata", prompt: "Read-only diagnostics" }, now);
  f.unit = f.store.createWorkUnit({
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: "task_run", ownerType: "run", ownerId: "diagnostic-run", idempotencyKey: "diagnostic-unit",
    status: "running", createdByActor: "system", request: {}, now,
  });
  f.attempt = f.store.createWorkUnitAttempt({
    id: "diagnostic-attempt", workUnitId: f.unit.id, attemptNumber: 1,
    runtimeInstanceId: "diagnostic-runtime", runnerId: "runner_pi_embedded", status: "started", now,
  });
  f.run = f.store.createRun({
    id: "diagnostic-run", cwd, taskId: task.id, workUnitId: f.unit.id,
    providerName: "test", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now,
  });
  f.store.linkRunToWorkUnit(f.run.id, f.unit.id, now);
  f.artifact = f.store.createArtifact({
    id: "diagnostic-artifact", runId: f.run.id, type: "json", path: "harness/private.json",
    sealedPayload: { privateValue }, createdAt: now,
  });
  f.insertContinuation = f.database.prepare(`
    INSERT INTO runner_continuations (
      id, schema_version, run_id, work_unit_id, source_attempt_id, target_attempt_id, origin, strategy, state,
      runner_id, runner_capability_revision, context_view_id, context_snapshot_artifact_id, runner_handle_ref,
      idempotency_key, generation, revision, created_at, updated_at
    ) VALUES (?,1,?,?,?,?,'daemon_recovery','deterministic_replay','prepared','runner_pi_embedded','pi:1',?, ?, ?, ?,0,0,?,?)
  `);
  f.insertTool = f.database.prepare(`
    INSERT INTO harness_tool_executions (
      id,schema_version,run_id,work_unit_id,attempt_id,tool_call_id,tool_name,executor_kind,state,
      request_digest,side_effect_fingerprint,policy_snapshot_artifact_id,sandbox_profile_id,result_summary_json,
      revision,created_at,updated_at
    ) VALUES (?,1,?,?,?,?,'bash','bash','approved',?,?,?,'workspace-write',?,0,?,?)
  `);
  f.insertEvaluation = f.database.prepare(`
    INSERT INTO run_evaluations (
      id,schema_version,root_run_id,run_id,suite_id,suite_version,suite_artifact_id,suite_digest,
      case_id,case_version,case_artifact_id,case_digest,baseline_id,baseline_version,baseline_artifact_id,
      baseline_digest,candidate_artifact_id,candidate_digest,idempotency_key,state,revision,created_at,updated_at
    ) VALUES (?,1,?,?,'suite','v1',?,?,'case','v1',?,?,'baseline','v1',?,?,?,?,?,'queued',0,?,?)
  `);
  f.insertDelegation = f.database.prepare(`
    INSERT INTO delegation_steps (
      id,schema_version,root_run_id,parent_run_id,parent_attempt_id,spawn_call_id,objective_artifact_id,
      required,state,depth,permission_snapshot_artifact_id,tool_allowlist_artifact_id,
      workspace_scope_artifact_id,provider_policy_artifact_id,idempotency_key,revision,created_at,updated_at
    ) VALUES (?,1,?,?,?,?,?,1,'planned',1,?,?,?,?,?,0,?,?)
  `);
  return f;
}

function continuation(f, id, createdAt = now, workUnitId = f.unit.id) {
  f.insertContinuation.run(
    id, f.run.id, workUnitId, f.attempt.id, f.attempt.id,
    `context:${id}`, f.artifact.id, privateValue, `idempotency:${id}`, createdAt, createdAt,
  );
  return { kind: "continuation", id, createdAt };
}

function tool(f, id, createdAt = now, workUnitId = f.unit.id) {
  f.insertTool.run(
    id, f.run.id, workUnitId, f.attempt.id, `call:${id}`, "a".repeat(64), "b".repeat(64), f.artifact.id,
    // Invalid JSON is intentional: diagnostics must not retrieve or parse result summaries.
    `{${privateValue}`, createdAt, createdAt,
  );
  return { kind: "tool_execution", id, createdAt };
}

function evaluation(f, id, createdAt = now, runId = f.run.id, rootRunId = runId) {
  const digest = "c".repeat(64);
  f.insertEvaluation.run(
    id, rootRunId, runId, f.artifact.id, digest, f.artifact.id, digest,
    f.artifact.id, digest, f.artifact.id, digest, `idempotency:${id}`, createdAt, createdAt,
  );
  return { kind: "evaluation", id, createdAt };
}

function delegation(f, id, createdAt = now, parentRunId = f.run.id, rootRunId = parentRunId, parentAttemptId = f.attempt.id) {
  f.insertDelegation.run(
    id, rootRunId, parentRunId, parentAttemptId, `spawn:${id}`, f.artifact.id,
    f.artifact.id, f.artifact.id, f.artifact.id, f.artifact.id, `idempotency:${id}`, createdAt, createdAt,
  );
  return { kind: "delegation", id, createdAt };
}

function descending(a, b) {
  for (const key of ["createdAt", "kind", "id"]) {
    const compared = Buffer.compare(Buffer.from(b[key]), Buffer.from(a[key]));
    if (compared) return compared;
  }
  return 0;
}

function isCode(code) {
  return (error) => error instanceof HarnessDiagnosticsStoreError && error.code === code;
}

test("1001 mixed rows page completely in BINARY descending time/kind/id order and survive reopen", async (t) => {
  const f = await fixture(t);
  const expected = [];
  f.database.exec("BEGIN IMMEDIATE");
  for (let i = 0; i < 1001; i += 1) {
    const createdAt = new Date(Date.parse(now) + Math.floor(i / 10)).toISOString();
    const id = i < 2 ? "shared-identity" : ["Z", "a", "é", "中"][i % 4] + i;
    expected.push(i % 2 ? tool(f, id, createdAt) : continuation(f, id, createdAt));
  }
  f.database.exec("COMMIT");
  expected.sort(descending);
  const first = f.store.queryHarnessDiagnostics(f.run.id, f.unit.id);
  assert.equal(first.items.length, 100);
  assert.deepEqual(first.items.map(({ kind, id, createdAt }) => ({ kind, id, createdAt })), expected.slice(0, 100));
  assert.deepEqual(first.nextCursor, {
    runId: f.run.id, workUnitId: f.unit.id, ...expected[99],
  });
  const received = [...first.items];
  let cursor = first.nextCursor;
  let pages = 1;
  f.store.close();
  f.store = createSqliteRunStore(f.cwd);
  while (cursor) {
    const page = f.store.queryHarnessDiagnostics(f.run.id, f.unit.id, { limit: 137, cursor });
    assert.ok(page.items.length > 0 && page.items.length <= 137);
    received.push(...page.items);
    cursor = page.nextCursor;
    pages += 1;
    assert.ok(pages < 12, "keyset must advance");
  }
  assert.equal(received.length, 1001);
  assert.equal(new Set(received.map((row) => `${row.kind}:${row.id}`)).size, 1001);
  assert.deepEqual(received.map(({ kind, id, createdAt }) => ({ kind, id, createdAt })), expected);
  assert.ok(received.every((row) => row.runId === f.run.id && row.workUnitId === f.unit.id));
  assert.ok(!JSON.stringify(received).includes(privateValue));
});

test("maximum page probes one extra row and empty pages have no invented cursor", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.store.queryHarnessDiagnostics(f.run.id, f.unit.id), { items: [] });
  f.database.exec("BEGIN IMMEDIATE");
  for (let i = 0; i < 501; i += 1) tool(f, `tool:${i}`);
  f.database.exec("COMMIT");
  const first = f.store.queryHarnessDiagnostics(f.run.id, f.unit.id, { limit: 500 });
  assert.equal(first.items.length, 500);
  assert.ok(first.nextCursor);
  const last = f.store.queryHarnessDiagnostics(f.run.id, f.unit.id, { limit: 500, cursor: first.nextCursor });
  assert.equal(last.items.length, 1);
  assert.equal(last.nextCursor, undefined);
  assert.deepEqual(f.store.queryHarnessDiagnostics(f.run.id, f.unit.id, {
    cursor: { runId: f.run.id, workUnitId: f.unit.id, createdAt: now, kind: "continuation", id: "0" },
  }), { items: [] });
});

test("live keyset crosses same-time kind boundaries and does not require cursor row to remain present", async (t) => {
  const f = await fixture(t);
  tool(f, "same");
  continuation(f, "same");
  tool(f, "newer", later);
  const first = f.store.queryHarnessDiagnostics(f.run.id, f.unit.id, { limit: 2 });
  assert.deepEqual(first.items.map((row) => `${row.kind}:${row.id}`), ["tool_execution:newer", "tool_execution:same"]);
  f.database.prepare("DELETE FROM harness_tool_executions WHERE id = ?").run("same");
  continuation(f, "older-inserted", "2026-10-08T23:59:59.000Z");
  const second = f.store.queryHarnessDiagnostics(f.run.id, f.unit.id, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((row) => `${row.kind}:${row.id}`), ["continuation:same", "continuation:older-inserted"]);
  assert.equal(second.nextCursor, undefined);
});

test("all four authority domains share one stable bounded keyset without treating projections as records", async (t) => {
  const f = await fixture(t);
  const expected = [
    continuation(f, "same"),
    delegation(f, "same"),
    evaluation(f, "same"),
    tool(f, "same"),
  ].sort(descending);
  const first = f.store.queryHarnessDiagnostics(f.run.id, f.unit.id, { limit: 2 });
  assert.deepEqual(first.items.map(({ kind, id, createdAt }) => ({ kind, id, createdAt })), expected.slice(0, 2));
  assert.deepEqual(first.nextCursor, { runId: f.run.id, workUnitId: f.unit.id, ...expected[1] });
  const second = f.store.queryHarnessDiagnostics(f.run.id, f.unit.id, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(({ kind, id, createdAt }) => ({ kind, id, createdAt })), expected.slice(2));
  assert.equal(second.nextCursor, undefined);
  assert.ok(first.items.every((item) => !Object.hasOwn(item, "projectionState")));
});

test("safe output retains diagnosis lineage and leases but excludes tokens, resume handles and private results", async (t) => {
  const f = await fixture(t);
  continuation(f, "continuation");
  tool(f, "tool");
  f.database.prepare(`
    UPDATE runner_continuations SET state='failed', claim_owner='daemon', claim_token=?, claim_expires_at=?,
      next_attempt_at=?, revision=3, generation=2, failure_code='continuation.target_attempt_lost',
      failure_detail_artifact_id=?, completed_at=? WHERE id='continuation'
  `).run(privateValue, later, later, f.artifact.id, later);
  f.database.prepare(`
    UPDATE harness_tool_executions SET state='unknown_outcome', claim_owner='daemon', claim_token=?, claim_expires_at=?,
      next_attempt_at=?, revision=5, failure_code='tool.unknown_side_effect_outcome', execution_started_at=?, execution_finished_at=?
      WHERE id='tool'
  `).run(privateValue, later, later, now, later);
  const { items } = f.store.queryHarnessDiagnostics(f.run.id, f.unit.id);
  const [execution, resume] = items;
  assert.equal(execution.kind, "tool_execution");
  assert.equal(execution.state, "unknown_outcome");
  assert.equal(execution.failureCode, "tool.unknown_side_effect_outcome");
  assert.equal(execution.attemptId, f.attempt.id);
  assert.equal(execution.policySnapshotArtifactId, f.artifact.id);
  assert.equal(execution.executionStartedAt, now);
  assert.equal(execution.executionFinishedAt, later);
  assert.equal(resume.kind, "continuation");
  assert.equal(resume.failureCode, "continuation.target_attempt_lost");
  assert.equal(resume.failureDetailArtifactId, f.artifact.id);
  assert.equal(resume.sourceAttemptId, f.attempt.id);
  assert.equal(resume.targetAttemptId, f.attempt.id);
  assert.equal(resume.generation, 2);
  for (const row of items) {
    assert.equal(row.claimOwner, "daemon");
    assert.equal(row.claimExpiresAt, later);
    assert.equal(row.nextAttemptAt, later);
    for (const forbidden of ["claimToken", "runnerHandleRef", "resultSummary", "requestDigest", "sideEffectFingerprint", "evidenceArtifactIds", "contextSnapshotArtifactId"]) {
      assert.ok(!Object.hasOwn(row, forbidden), forbidden);
    }
  }
  assert.ok(!JSON.stringify(items).includes(privateValue));
});

test("evaluation and delegation diagnostics expose only allowlisted authority metadata", async (t) => {
  const f = await fixture(t);
  evaluation(f, "evaluation");
  delegation(f, "delegation");
  f.database.prepare(`UPDATE run_evaluations SET state='claimed',claim_owner='evaluation-worker',claim_token=?,
    claim_expires_at=?,next_attempt_at=?,revision=4,updated_at=? WHERE id='evaluation'`)
    .run(privateValue, later, later, later);
  const { items } = f.store.queryHarnessDiagnostics(f.run.id, f.unit.id);
  const evaluationRecord = items.find((item) => item.kind === "evaluation");
  const delegationRecord = items.find((item) => item.kind === "delegation");
  assert.deepEqual({
    kind: evaluationRecord.kind, id: evaluationRecord.id, runId: evaluationRecord.runId,
    workUnitId: evaluationRecord.workUnitId, rootRunId: evaluationRecord.rootRunId,
    state: evaluationRecord.state, revision: evaluationRecord.revision,
    createdAt: evaluationRecord.createdAt, updatedAt: evaluationRecord.updatedAt,
    claimOwner: evaluationRecord.claimOwner, claimExpiresAt: evaluationRecord.claimExpiresAt,
    nextAttemptAt: evaluationRecord.nextAttemptAt,
  }, {
    kind: "evaluation", id: "evaluation", runId: f.run.id, workUnitId: f.unit.id,
    rootRunId: f.run.id, state: "claimed", revision: 4, createdAt: now, updatedAt: later,
    claimOwner: "evaluation-worker", claimExpiresAt: later, nextAttemptAt: later,
  });
  assert.deepEqual({
    kind: delegationRecord.kind, id: delegationRecord.id, runId: delegationRecord.runId,
    workUnitId: delegationRecord.workUnitId, rootRunId: delegationRecord.rootRunId,
    state: delegationRecord.state, revision: delegationRecord.revision,
    createdAt: delegationRecord.createdAt, updatedAt: delegationRecord.updatedAt,
    parentAttemptId: delegationRecord.parentAttemptId, required: delegationRecord.required, depth: delegationRecord.depth,
  }, {
    kind: "delegation", id: "delegation", runId: f.run.id, workUnitId: f.unit.id,
    rootRunId: f.run.id, state: "planned", revision: 0, createdAt: now, updatedAt: now,
    parentAttemptId: f.attempt.id, required: true, depth: 1,
  });
  const serialized = JSON.stringify(items);
  assert.ok(!serialized.includes(privateValue));
  for (const forbidden of [
    "claimToken", "suiteId", "suiteArtifactId", "caseArtifactId", "candidateArtifactId",
    "objectiveArtifactId", "permissionSnapshotArtifactId", "toolAllowlistArtifactId",
    "workspaceScopeArtifactId", "providerPolicyArtifactId", "idempotencyKey",
  ]) assert.ok(!serialized.includes(forbidden), forbidden);
});

test("strict query validation rejects malformed, foreign, accessor and prototype input without invoking getters", async (t) => {
  const f = await fixture(t);
  tool(f, "tool");
  const valid = { runId: f.run.id, workUnitId: f.unit.id, createdAt: now, kind: "tool_execution", id: "tool" };
  let getters = 0;
  const accessor = Object.defineProperty({}, "limit", { get() { getters += 1; throw new Error(privateValue); } });
  const cursorAccessor = Object.defineProperty({ ...valid }, "id", { get() { getters += 1; return "tool"; } });
  const invalid = [
    null, [], "query", { unknown: true }, { [Symbol("hidden")]: true }, accessor,
    Object.create({ limit: 1 }), { limit: 0 }, { limit: -1 }, { limit: 501 }, { limit: 1.2 }, { limit: NaN }, { limit: "1" },
    { cursor: null }, { cursor: [] }, { cursor: Object.create(valid) }, { cursor: cursorAccessor },
    { cursor: { ...valid, runId: "foreign" } }, { cursor: { ...valid, workUnitId: "foreign" } },
    { cursor: { ...valid, kind: "unknown" } }, { cursor: { ...valid, id: " tool" } },
    { cursor: { ...valid, id: "tool\0" } }, { cursor: { ...valid, id: "t".repeat(1025) } },
    { cursor: { ...valid, createdAt: "2026-10-09T00:00:00Z" } },
    { cursor: { ...valid, createdAt: "2026-02-30T00:00:00.000Z" } },
    { cursor: { ...valid, createdAt: "2026-10-09T00:00:00.000+00:00" } },
    { cursor: { ...valid, extra: true } },
    { cursor: (({ id, ...rest }) => rest)(valid) },
    new Proxy({}, { ownKeys() { throw new Error(privateValue); } }),
  ];
  for (const input of invalid) {
    assert.throws(() => f.store.queryHarnessDiagnostics(f.run.id, f.unit.id, input), isCode("diagnostics.invalid_query"));
  }
  assert.equal(getters, 0);
  for (const id of ["", " run", "run\0", "r".repeat(1025), null, 3]) {
    assert.throws(() => f.store.queryHarnessDiagnostics(id, f.unit.id), isCode("diagnostics.invalid_query"));
    assert.throws(() => f.store.queryHarnessDiagnostics(f.run.id, id), isCode("diagnostics.invalid_query"));
  }
  assert.deepEqual(validateHarnessDiagnosticQuery(f.run.id, f.unit.id, Object.assign(Object.create(null), { limit: 2 })), { limit: 2 });
  assert.deepEqual(validateHarnessDiagnosticQuery(f.run.id, f.unit.id, { cursor: valid }), { limit: 100, cursor: valid });
  for (const kind of ["continuation", "tool_execution", "evaluation", "delegation"]) {
    const cursor = { ...valid, kind };
    assert.deepEqual(validateHarnessDiagnosticQuery(f.run.id, f.unit.id, { cursor }), { limit: 100, cursor });
  }
});

test("scope must match both directions and foreign WorkUnit metadata is never returned", async (t) => {
  const f = await fixture(t);
  const foreign = f.store.createWorkUnit({
    workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "foreign-run",
    idempotencyKey: "foreign-unit", status: "queued", createdByActor: "system", request: {}, now,
  });
  tool(f, "own");
  continuation(f, "foreign", now, foreign.id);
  const foreignRun = f.store.createRun({
    id: "foreign-run", cwd: f.cwd, taskId: f.run.taskId, workUnitId: foreign.id,
    providerName: "test", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now,
  });
  f.store.linkRunToWorkUnit(foreignRun.id, foreign.id, now);
  const foreignAttempt = f.store.createWorkUnitAttempt({
    id: "foreign-attempt", workUnitId: foreign.id, attemptNumber: 1,
    runtimeInstanceId: "foreign-runtime", runnerId: "runner_pi_embedded", status: "started", now,
  });
  evaluation(f, "foreign-evaluation", now, foreignRun.id);
  delegation(f, "foreign-delegation", now, foreignRun.id, foreignRun.id, foreignAttempt.id);
  assert.deepEqual(f.store.queryHarnessDiagnostics(f.run.id, f.unit.id).items.map((row) => row.id), ["own"]);
  assert.throws(() => f.store.queryHarnessDiagnostics(f.run.id, foreign.id), isCode("diagnostics.lineage_mismatch"));
  assert.throws(() => f.store.queryHarnessDiagnostics("missing", f.unit.id), isCode("diagnostics.lineage_mismatch"));
  assert.throws(() => f.store.queryHarnessDiagnostics(f.run.id, "missing"), isCode("diagnostics.lineage_mismatch"));
  f.database.prepare("UPDATE work_units SET linked_run_id = NULL WHERE id = ?").run(f.unit.id);
  assert.throws(() => f.store.queryHarnessDiagnostics(f.run.id, f.unit.id), isCode("diagnostics.lineage_mismatch"));
  f.database.prepare("UPDATE work_units SET linked_run_id = ? WHERE id = ?").run(f.run.id, f.unit.id);
  f.database.prepare("UPDATE run_sessions SET work_unit_id = ? WHERE id = ?").run(foreign.id, f.run.id);
  assert.throws(() => f.store.queryHarnessDiagnostics(f.run.id, f.unit.id), isCode("diagnostics.lineage_mismatch"));
});

test("narrow scope discovery distinguishes missing units, missing links, missing Runs and mismatched lineage", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.store.queryWorkUnitHarnessDiagnosticScope(f.unit.id), {
    workUnitId: f.unit.id, runId: f.run.id, status: "available",
  });
  assert.equal(f.store.queryWorkUnitHarnessDiagnosticScope("missing-unit"), undefined);
  f.database.prepare("UPDATE work_units SET linked_run_id=NULL WHERE id=?").run(f.unit.id);
  assert.deepEqual(f.store.queryWorkUnitHarnessDiagnosticScope(f.unit.id), {
    workUnitId: f.unit.id, status: "run_unlinked",
  });
  // Damage is injected on this isolated fixture connection only; production FK enforcement remains untouched.
  f.database.exec("PRAGMA foreign_keys=OFF");
  f.database.prepare("UPDATE work_units SET linked_run_id='missing-run' WHERE id=?").run(f.unit.id);
  f.database.exec("PRAGMA foreign_keys=ON");
  assert.deepEqual(f.store.queryWorkUnitHarnessDiagnosticScope(f.unit.id), {
    workUnitId: f.unit.id, runId: "missing-run", status: "run_missing",
  });
  f.database.prepare("UPDATE work_units SET linked_run_id=? WHERE id=?").run(f.run.id, f.unit.id);
  f.database.prepare("UPDATE run_sessions SET work_unit_id=NULL WHERE id=?").run(f.run.id);
  assert.deepEqual(f.store.queryWorkUnitHarnessDiagnosticScope(f.unit.id), {
    workUnitId: f.unit.id, runId: f.run.id, status: "lineage_mismatch",
  });
});

test("invalid private WorkUnit input and Run snapshots cannot prevent metadata-only diagnosis", async (t) => {
  const f = await fixture(t);
  tool(f, "tool");
  f.database.prepare("UPDATE work_units SET request_json=?, timeout_policy_json=?, error_message=? WHERE id=?")
    .run(`{${privateValue}`, `{${privateValue}`, privateValue, f.unit.id);
  f.database.prepare(`
    UPDATE run_sessions SET task_snapshot_json=?, provider_snapshot_json=?, request_snapshot_json=?, error_message=? WHERE id=?
  `).run(`{${privateValue}`, `{${privateValue}`, `{${privateValue}`, privateValue, f.run.id);
  f.database.prepare("UPDATE work_unit_attempts SET runner_fallback_reason_json=?, error_code=?, error_message=? WHERE id=?")
    .run(`{${privateValue}`, privateValue, privateValue, f.attempt.id);
  assert.throws(() => f.store.getWorkUnit(f.unit.id), /Failed to parse JSON from SQLite/u);
  assert.throws(() => f.store.getRun(f.run.id), /Failed to parse JSON from SQLite/u);
  const scope = f.store.queryWorkUnitHarnessDiagnosticScope(f.unit.id);
  const attempt = f.store.getHarnessDiagnosticAttempt(f.unit.id, f.attempt.id);
  const page = f.store.queryHarnessDiagnostics(f.run.id, f.unit.id);
  assert.equal(scope.status, "available");
  assert.equal(attempt.status, "observed");
  assert.equal(attempt.fencingToken, f.attempt.fencingToken);
  assert.deepEqual(page.items.map((row) => row.id), ["tool"]);
  assert.ok(!JSON.stringify({ scope, attempt, page }).includes(privateValue));
});

test("narrow Attempt diagnosis returns only the safe owner projection and conceals foreign metadata", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.store.getHarnessDiagnosticAttempt(f.unit.id, f.attempt.id), {
    id: f.attempt.id, status: "observed", workUnitId: f.unit.id,
    runtimeInstanceId: f.attempt.runtimeInstanceId, fencingToken: f.attempt.fencingToken, attemptStatus: "started",
  });
  assert.deepEqual(f.store.getHarnessDiagnosticAttempt(f.unit.id, "missing-attempt"), { id: "missing-attempt", status: "missing" });
  // Corrupt foreign metadata is not read into the response or validated as though it belonged to this scope.
  f.database.prepare("UPDATE work_unit_attempts SET runtime_instance_id='', fencing_token='', status='' WHERE id=?").run(f.attempt.id);
  assert.deepEqual(f.store.getHarnessDiagnosticAttempt("other-work-unit", f.attempt.id), {
    id: f.attempt.id, status: "ownership_mismatch",
  });
  assert.throws(() => f.store.getHarnessDiagnosticAttempt(f.unit.id, f.attempt.id), isCode("diagnostics.record_invalid"));
});

test("scope and Attempt readers reject invalid caller identities and damaged safe metadata explicitly", async (t) => {
  const f = await fixture(t);
  for (const value of ["", " id", "id\0", "x".repeat(1025), null, 3]) {
    assert.throws(() => f.store.queryWorkUnitHarnessDiagnosticScope(value), isCode("diagnostics.invalid_query"));
    assert.throws(() => f.store.getHarnessDiagnosticAttempt(value, f.attempt.id), isCode("diagnostics.invalid_query"));
    assert.throws(() => f.store.getHarnessDiagnosticAttempt(f.unit.id, value), isCode("diagnostics.invalid_query"));
  }
  f.database.exec("PRAGMA foreign_keys=OFF");
  f.database.prepare("UPDATE work_units SET linked_run_id=' bad-id' WHERE id=?").run(f.unit.id);
  f.database.exec("PRAGMA foreign_keys=ON");
  assert.throws(() => f.store.queryWorkUnitHarnessDiagnosticScope(f.unit.id), isCode("diagnostics.record_invalid"));
  f.database.prepare("UPDATE work_units SET linked_run_id=? WHERE id=?").run(f.run.id, f.unit.id);
  for (const [field, original] of [["runtime_instance_id", f.attempt.runtimeInstanceId], ["fencing_token", f.attempt.fencingToken], ["status", "started"]]) {
    f.database.prepare(`UPDATE work_unit_attempts SET ${field}='' WHERE id=?`).run(f.attempt.id);
    assert.throws(() => f.store.getHarnessDiagnosticAttempt(f.unit.id, f.attempt.id), isCode("diagnostics.record_invalid"));
    f.database.prepare(`UPDATE work_unit_attempts SET ${field}=? WHERE id=?`).run(original, f.attempt.id);
  }
  f.database.prepare("UPDATE work_unit_attempts SET status='unlisted' WHERE id=?").run(f.attempt.id);
  assert.throws(() => f.store.getHarnessDiagnosticAttempt(f.unit.id, f.attempt.id), isCode("diagnostics.record_invalid"));
});

test("diagnostic reads and failures make zero SQLite writes and restore the prior query_only mode", async (t) => {
  const f = await fixture(t);
  tool(f, "tool");
  const reader = new SqliteHarnessDiagnosticsStore({ database: f.database });
  const before = f.database.prepare("SELECT total_changes() AS changes").get().changes;
  const version = f.database.prepare("PRAGMA data_version").get().data_version;
  for (let i = 0; i < 3; i += 1) reader.queryHarnessDiagnostics(f.run.id, f.unit.id, { limit: 1 });
  reader.queryWorkUnitHarnessDiagnosticScope(f.unit.id);
  reader.queryWorkUnitHarnessDiagnosticScope("missing-unit");
  reader.getHarnessDiagnosticAttempt(f.unit.id, f.attempt.id);
  reader.getHarnessDiagnosticAttempt(f.unit.id, "missing-attempt");
  reader.getHarnessDiagnosticAttempt("other-unit", f.attempt.id);
  assert.throws(() => reader.queryHarnessDiagnostics("missing", f.unit.id), isCode("diagnostics.lineage_mismatch"));
  assert.throws(() => reader.queryHarnessDiagnostics(f.run.id, f.unit.id, { limit: 0 }), isCode("diagnostics.invalid_query"));
  assert.equal(f.database.prepare("SELECT total_changes() AS changes").get().changes, before);
  assert.equal(f.database.prepare("PRAGMA query_only").get().query_only, 0);
  f.store.queryHarnessDiagnostics(f.run.id, f.unit.id);
  assert.equal(f.database.prepare("PRAGMA data_version").get().data_version, version);
  f.database.exec("PRAGMA query_only=ON");
  reader.queryHarnessDiagnostics(f.run.id, f.unit.id);
  assert.throws(() => reader.queryHarnessDiagnostics("missing", f.unit.id), isCode("diagnostics.lineage_mismatch"));
  assert.equal(f.database.prepare("PRAGMA query_only").get().query_only, 1);
  f.database.exec("PRAGMA query_only=OFF");
  f.database.prepare("UPDATE harness_tool_executions SET revision=revision+1 WHERE id='tool'").run();
  assert.equal(reader.queryHarnessDiagnostics(f.run.id, f.unit.id).items[0].revision, 1);
});

test("actual SQLite diagnostic statements use metadata-only columns and both existing Run indexes", async (t) => {
  const f = await fixture(t);
  continuation(f, "continuation");
  tool(f, "tool");
  const captured = [];
  const database = new Proxy(f.database, {
    get(target, key) {
      if (key === "prepare") return (sql) => {
        captured.push(sql);
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const reader = new SqliteHarnessDiagnosticsStore({ database });
  reader.queryWorkUnitHarnessDiagnosticScope(f.unit.id);
  reader.getHarnessDiagnosticAttempt(f.unit.id, f.attempt.id);
  const page = reader.queryHarnessDiagnostics(f.run.id, f.unit.id, { limit: 1 });
  reader.queryHarnessDiagnostics(f.run.id, f.unit.id, { limit: 1, cursor: page.nextCursor });
  evaluation(f, "evaluation");
  delegation(f, "delegation");
  const selects = captured.filter((sql) => sql.includes("UNION ALL"));
  assert.equal(selects.length, 2);
  for (const sql of captured) {
    assert.doesNotMatch(sql, /\b(claim_token|runner_handle_ref|result_summary_json|request_digest|side_effect_fingerprint|sealed_payload|evidence_artifact_ids|request_json|timeout_policy_json|task_snapshot_json|provider_snapshot_json|request_snapshot_json|runner_fallback_reason_json|error_code|error_message|suite_artifact_id|case_artifact_id|baseline_artifact_id|candidate_artifact_id|objective_artifact_id|permission_snapshot_artifact_id|tool_allowlist_artifact_id|workspace_scope_artifact_id|provider_policy_artifact_id)\b/u);
    assert.doesNotMatch(sql, /SELECT\s+\*/iu);
  }
  for (let index = 0; index < selects.length; index += 1) {
    const params = index === 0
      ? [f.run.id, f.unit.id, f.run.id, f.unit.id, f.run.id, f.unit.id, f.run.id, f.unit.id, 2]
      : [
          f.run.id, f.unit.id, now, "tool_execution", "tool",
          f.run.id, f.unit.id, now, "tool_execution", "tool",
          f.run.id, f.unit.id, now, "tool_execution", "tool",
          f.run.id, f.unit.id, now, "tool_execution", "tool", 2,
        ];
    const plan = f.database.prepare(`EXPLAIN QUERY PLAN ${selects[index]}`).all(...params).map((row) => row.detail).join("\n");
    assert.match(plan, /idx_runner_continuations_run_created/u);
    assert.match(plan, /idx_harness_tool_executions_run_created/u);
    assert.match(plan, /idx_run_evaluations_lineage/u);
    assert.match(plan, /idx_delegation_steps_parent_created/u);
  }
});

test("corrupt approved metadata fails visibly, including corruption in the extra probe row", async (t) => {
  const cases = [
    ["schema_version", "2"], ["state", "'bad-state'"], ["revision", "9007199254740992"],
    ["created_at", "'2026-10-09T00:00:00Z'"], ["updated_at", "'bad-time'"],
    ["tool_call_id", "''"], ["executor_kind", "'unknown'"], ["failure_code", "'unlisted'"],
  ];
  for (const [field, value] of cases) {
    await t.test(field, async (subtest) => {
      const f = await fixture(subtest);
      tool(f, "probe");
      tool(f, "first", later);
      f.database.exec("PRAGMA ignore_check_constraints=ON");
      f.database.exec(`UPDATE harness_tool_executions SET ${field}=${value} WHERE id='probe'`);
      assert.throws(() => f.store.queryHarnessDiagnostics(f.run.id, f.unit.id, { limit: 1 }), isCode("diagnostics.record_invalid"));
    });
  }
  await t.test("continuation unsafe generation", async (subtest) => {
    const f = await fixture(subtest);
    continuation(f, "bad");
    f.database.prepare("UPDATE runner_continuations SET generation=9007199254740992 WHERE id='bad'").run();
    assert.throws(() => f.store.queryHarnessDiagnostics(f.run.id, f.unit.id), isCode("diagnostics.record_invalid"));
  });
  await t.test("evaluation invalid state", async (subtest) => {
    const f = await fixture(subtest);
    evaluation(f, "bad");
    f.database.exec("PRAGMA ignore_check_constraints=ON");
    f.database.prepare("UPDATE run_evaluations SET state='bad-state' WHERE id='bad'").run();
    assert.throws(() => f.store.queryHarnessDiagnostics(f.run.id, f.unit.id), isCode("diagnostics.record_invalid"));
  });
  await t.test("delegation invalid required flag", async (subtest) => {
    const f = await fixture(subtest);
    delegation(f, "bad");
    f.database.exec("PRAGMA ignore_check_constraints=ON");
    f.database.exec(`INSERT INTO delegation_steps (
      id,schema_version,root_run_id,parent_run_id,parent_attempt_id,spawn_call_id,objective_artifact_id,
      required,state,depth,permission_snapshot_artifact_id,tool_allowlist_artifact_id,
      workspace_scope_artifact_id,provider_policy_artifact_id,idempotency_key,revision,created_at,updated_at
    ) SELECT 'bad-probe',schema_version,root_run_id,parent_run_id,parent_attempt_id,'spawn:bad-probe',objective_artifact_id,
      2,state,depth,permission_snapshot_artifact_id,tool_allowlist_artifact_id,
      workspace_scope_artifact_id,provider_policy_artifact_id,'idempotency:bad-probe',revision,created_at,updated_at
      FROM delegation_steps WHERE id='bad'`);
    assert.throws(() => f.store.queryHarnessDiagnostics(f.run.id, f.unit.id), isCode("diagnostics.record_invalid"));
  });
});
