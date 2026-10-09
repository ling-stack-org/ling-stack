import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, resolveRuntimePaths, toRuntimeAttemptFence } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { handleWorkUnitRoute } from "../dist/runtime/routes.js";
import { projectWorkUnitHarnessDiagnostics } from "../dist/runtime/harness-diagnostics.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";

const now = "2026-10-09T00:00:00.000Z";
const future = "2099-01-01T00:00:00.000Z";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-harness-diagnostics-api-"));
  const store = createSqliteRunStore(cwd);
  let factoryCalls = 0;
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    runner: { run: async () => { throw new Error("Diagnostics must not dispatch a runner."); } },
    storeFactory: requested => { factoryCalls++; assert.equal(requested, cwd); return store; },
  });
  await daemon.start();
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => {
    database.close();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  });
  const channel = store.createChannel({ name: "Diagnostics fixture", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Observation", prompt: "Never execute" }, now);
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run-diag", idempotencyKey: "diag-unit", status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ id: "attempt-diag", workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "runtime-diag", runnerId: "pi", effectiveRunnerId: "pi", status: "started", now });
  const run = store.createRun({ id: "run-diag", cwd, taskId: task.id, workUnitId: unit.id, providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  const policy = store.createArtifact({ id: "diag-policy", runId: run.id, type: "json", path: "diag/private.json", sealedPayload: { secret: "DIAGNOSTIC_PRIVATE_BODY" }, createdAt: now });
  const prepared = store.prepareHarnessToolExecution({ id: "tool-diag-0000", runId: run.id, workUnitId: unit.id, sourceFence: toRuntimeAttemptFence(attempt), toolCallId: "call-diag-0000", toolName: "bash", executorKind: "bash", requestDigest: "a".repeat(64), sideEffectFingerprint: "b".repeat(64), policySnapshotArtifactId: policy.id, approvalState: "allowed", sandboxProfileId: "workspace-write", now });
  assert.equal(prepared.execution.state, "approved");
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const url = new URL(`http://127.0.0.1:${address.port}/work-units/${encodeURIComponent(unit.id)}/harness`);
  url.searchParams.set("cwd", cwd);
  return { cwd, store, database, daemon, unit, run, attempt, url, factoryCalls: () => factoryCalls };
}

test("production HTTP diagnostics page through 1001 persisted tools without mutation or private bodies", async t => {
  const f = await fixture(t);
  const insert = f.database.prepare(`INSERT INTO harness_tool_executions
    (id,schema_version,run_id,work_unit_id,attempt_id,tool_call_id,tool_name,executor_kind,state,
      request_digest,side_effect_fingerprint,policy_snapshot_artifact_id,sandbox_profile_id,revision,created_at,updated_at,result_summary_json)
    SELECT ?,schema_version,run_id,work_unit_id,attempt_id,?,tool_name,executor_kind,state,
      request_digest,side_effect_fingerprint,policy_snapshot_artifact_id,sandbox_profile_id,revision,created_at,updated_at,?
    FROM harness_tool_executions WHERE id='tool-diag-0000'`);
  f.database.exec("BEGIN");
  for (let i = 1; i < 1001; i++) insert.run(`tool-diag-${String(i).padStart(4, "0")}`, `call-diag-${i}`, JSON.stringify({ secret: "DIAGNOSTIC_PRIVATE_RESULT" }));
  f.database.exec("COMMIT");
  f.database.prepare(`UPDATE harness_tool_executions SET state='executing',claim_owner='owner-diag',claim_token='DIAGNOSTIC_PRIVATE_CLAIM',claim_expires_at=?,execution_started_at=? WHERE id='tool-diag-1000'`).run(now, now);
  f.database.prepare(`UPDATE harness_tool_executions SET state='claimed',claim_owner='owner-diag',claim_token='DIAGNOSTIC_PRIVATE_CLAIM',claim_expires_at=? WHERE id='tool-diag-0999'`).run(future);
  f.database.prepare(`UPDATE harness_tool_executions SET state='unknown_outcome',claim_owner='owner-diag',claim_token='DIAGNOSTIC_PRIVATE_CLAIM',claim_expires_at=?,execution_started_at=?,execution_finished_at=?,failure_code='tool.unknown_side_effect_outcome' WHERE id='tool-diag-0998'`).run(now, now, now);
  const before = {
    version: f.database.prepare("PRAGMA data_version").get().data_version,
    run: f.store.getRun(f.run.id), unit: f.store.getWorkUnit(f.unit.id),
    rows: f.database.prepare("SELECT * FROM harness_tool_executions ORDER BY id").all(),
  };
  const items = [];
  let cursor;
  let pages = 0;
  do {
    const url = new URL(f.url);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", JSON.stringify(cursor));
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.status, "available");
    assert.equal(page.runId, f.run.id);
    assert.equal(page.workUnitId, f.unit.id);
    assert.ok(page.items.length <= 100);
    assert.doesNotMatch(JSON.stringify(page), /DIAGNOSTIC_PRIVATE|claimToken|runnerHandleRef|sealedPayload|resultSummary/);
    items.push(...page.items);
    cursor = page.nextCursor;
    pages++;
  } while (cursor);
  assert.equal(pages, 11);
  assert.equal(items.length, 1001);
  assert.equal(new Set(items.map(item => item.record.id)).size, 1001);
  assert.equal(items[0].record.id, "tool-diag-1000");
  assert.equal(items[0].leaseStatus, "expired");
  assert.equal(items[1].leaseStatus, "held");
  assert.equal(items[2].leaseStatus, "terminal_retained");
  assert.equal(items[3].leaseStatus, "unclaimed");
  assert.equal(items[0].attempts[0].fencingToken, f.attempt.fencingToken);
  assert.equal(typeof items[0].attempts[0].fencingToken, "string");
  assert.equal(f.database.prepare("PRAGMA data_version").get().data_version, before.version);
  assert.deepEqual(f.store.getRun(f.run.id), before.run);
  assert.deepEqual(f.store.getWorkUnit(f.unit.id), before.unit);
  assert.deepEqual(f.database.prepare("SELECT * FROM harness_tool_executions ORDER BY id").all(), before.rows);
});

test("production endpoint rejects invalid/cross-scope pagination, cold Store and mutation methods", async t => {
  const f = await fixture(t);
  const validCursor = { runId: f.run.id, workUnitId: f.unit.id, createdAt: now, kind: "tool_execution", id: "tool-diag-0000" };
  const invalid = [
    ["limit", "0"], ["limit", "501"], ["limit", "1.5"], ["limit", " 2"], ["limit", "1e2"],
    ["cursor", "{"], ["cursor", "null"], ["cursor", "[]"], ["cursor", JSON.stringify({ ...validCursor, runId: "other-run" })],
    ["cursor", JSON.stringify({ ...validCursor, workUnitId: "other-unit" })], ["cursor", JSON.stringify({ ...validCursor, secret: "private" })],
  ];
  for (const [field, value] of invalid) {
    const url = new URL(f.url); url.searchParams.set(field, value);
    assert.equal((await fetch(url)).status, 400, `${field}=${value}`);
  }
  const duplicate = new URL(f.url); duplicate.searchParams.append("cwd", f.cwd);
  assert.equal((await fetch(duplicate)).status, 400);
  assert.equal((await fetch(f.url, { method: "POST" })).status, 405);
  const cold = new URL(f.url); cold.searchParams.set("cwd", join(f.cwd, "cold-workspace"));
  const calls = f.factoryCalls();
  const response = await fetch(cold);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "harness_workspace_uninitialized");
  assert.equal(f.factoryCalls(), calls);
  const missing = new URL(f.url); missing.pathname = "/work-units/missing/harness";
  assert.equal((await fetch(missing)).status, 404);
});

test("actual work-unit route never asks for ordinary Store, runtime recovery or dispatch and masks DB failure", async t => {
  const registry = {
    getStore: () => { throw new Error("ORDINARY_STORE_MUST_NOT_BE_CALLED"); },
    getInitializedStore: () => ({ queryWorkUnitHarnessDiagnosticScope: () => { throw new Error("PRIVATE_SQL_SECRET"); } }),
  };
  const supervisor = { getRuntime: () => { throw new Error("RUNTIME_MUST_NOT_BE_CALLED"); } };
  const server = createServer((req, res) => {
    void handleWorkUnitRoute(req, res, new URL(req.url, "http://local"), registry, {}, supervisor,
      { kind: "harness", workUnitId: "unit" }, () => { throw new Error("cancel"); }, {}, () => { throw new Error("retry"); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/work-units/unit/harness?cwd=%2Frepo`);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, "harness_diagnostics_unavailable");
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_SQL_SECRET|MUST_NOT_BE_CALLED/);
});

test("observation-only registry never constructs cold Stores and refuses access after close", () => {
  let constructed = 0;
  const registry = new RunStoreRegistry(() => { constructed++; throw new Error("Must not initialize"); });
  assert.equal(registry.getInitializedStore("/cold"), undefined);
  assert.equal(constructed, 0);
  registry.closeAll();
  assert.throws(() => registry.getInitializedStore("/cold"), /closed/);
  assert.equal(constructed, 0);
});

test("projection reports absent/wrong lineage and never returns another work-unit attempt metadata", () => {
  const scope = { workUnitId: "unit", runId: "run", status: "available" };
  const record = { kind: "continuation", id: "continuation", runId: "run", workUnitId: "unit", state: "running", sourceAttemptId: "missing", targetAttemptId: "wrong", claimOwner: "owner", claimExpiresAt: future };
  const store = {
    queryHarnessDiagnostics: () => ({ items: [record] }),
    getHarnessDiagnosticAttempt: (workUnitId, id) => { assert.equal(workUnitId, "unit"); return { id, status: id === "missing" ? "missing" : "ownership_mismatch" }; },
  };
  const response = projectWorkUnitHarnessDiagnostics("/repo", store, scope, {}, now);
  assert.deepEqual(response.items[0].attempts, [{ id: "missing", status: "missing" }, { id: "wrong", status: "ownership_mismatch" }]);
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE_/);
  const unavailable = status => {
    assert.equal(status.items.length, 0);
    return status.status;
  };
  for (const status of ["run_unlinked", "run_missing", "lineage_mismatch"]) {
    assert.equal(unavailable(projectWorkUnitHarnessDiagnostics("/repo", store, { ...scope, status, runId: status === "run_unlinked" ? undefined : "run" }, {}, now)), status);
  }
});

test("production diagnostics remain readable with damaged private Run, WorkUnit and Attempt JSON", async t => {
  const f = await fixture(t);
  f.database.prepare("UPDATE run_sessions SET task_snapshot_json='BROKEN_PRIVATE_JSON',provider_snapshot_json='BROKEN_PRIVATE_JSON',request_snapshot_json='BROKEN_PRIVATE_JSON' WHERE id=?").run(f.run.id);
  f.database.prepare("UPDATE work_units SET request_json='BROKEN_PRIVATE_JSON' WHERE id=?").run(f.unit.id);
  f.database.prepare("UPDATE work_unit_attempts SET runner_fallback_reason_json='BROKEN_PRIVATE_JSON',error_message='PRIVATE_ATTEMPT_ERROR' WHERE id=?").run(f.attempt.id);
  try {
    const response = await fetch(f.url);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "available");
    assert.equal(body.items[0].attempts[0].status, "observed");
    assert.doesNotMatch(JSON.stringify(body), /BROKEN_PRIVATE|PRIVATE_ATTEMPT_ERROR/);
  } finally {
    // Restore only disposable fixture corruption before daemon.stop reads ordinary runtime objects.
    f.database.prepare("UPDATE run_sessions SET task_snapshot_json='{}',provider_snapshot_json='{}',request_snapshot_json='{}' WHERE id=?").run(f.run.id);
    f.database.prepare("UPDATE work_units SET request_json='{}' WHERE id=?").run(f.unit.id);
    f.database.prepare("UPDATE work_unit_attempts SET runner_fallback_reason_json=NULL,error_message=NULL WHERE id=?").run(f.attempt.id);
  }
});
