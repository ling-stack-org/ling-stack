import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createSqliteRunStore, type ReadNodeRerunTargetReadinessInput, type RunStore } from "@ling-stack/core";
import type { NodeRerunTargetReadinessResponseV1 } from "@ling-stack/contracts";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import type { ResolvedDaemonConfig } from "../dist/config.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { prepareNodeRerunTargetExecution } from "../dist/features/runs/node-rerun-targets.js";
import { handleGetNodeRerunTargetReadiness } from "../dist/features/runs/node-rerun-readiness.js";
import { observeNodeRerunAdmission } from "../dist/features/runs/node-rerun-observation.js";
import { readStoredRunnerExecution } from "../dist/features/runs/existing-run-request.js";
import { observePreparedNodeRerunExecution } from "../dist/features/runs/node-rerun-local-execution.js";
import { createFixture, prepareInput } from "./support/node-rerun-fixture.ts";

const database = (store: RunStore) => (store as unknown as { readonly database: DatabaseSync }).database;
const writes = (store: RunStore) => database(store).prepare("SELECT total_changes() n").get()!.n;
const snapshot = (store: RunStore) => Object.fromEntries(["tasks", "run_sessions", "work_units", "work_unit_attempts",
  "runtime_events", "node_rerun_targets", "approval_requests", "approval_checkpoints", "artifacts",
  "runtime_host_capacity_intents", "resource_leases", "runtime_semaphore_slots", "native_execution_bindings", "native_submissions",
].map(table => [table, database(store).prepare(`SELECT * FROM ${table}`).all()]));

async function fixture(t: TestContext) {
  let supervisor: RuntimeSupervisor | undefined;
  t.after(() => supervisor?.releaseAll());
  const f = await createFixture(t, { preparedExecution: true });
  supervisor = new RuntimeSupervisor({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: f.cwd, runners: {},
    runtimeTools: {}, channels: {}, sandbox: {}, harness: {}, transports: {
      providerWebSocketFallback: true, localWebSocketRpc: true } } as ResolvedDaemonConfig);
  const runtime = supervisor.getRuntime(f.cwd, f.store);
  const prepared = f.store.prepareNodeRerunIntent(prepareInput(f)); assert.ok(prepared.status === "created");
  const record = prepared.record, now = new Date().toISOString();
  const revalidate = (intent: typeof record.intent) => observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent, now });
  const approval = f.store.requestNodeRerunApproval({ recordId: record.id, now, revalidate }); assert.ok(approval.status === "created");
  f.store.approveApprovalRequest(approval.approval.id, { resolvedBy: "local-user", decisionKind: "approve_once" }, now);
  const target = f.store.prepareNodeRerunTarget({ recordId: record.id, runtimeInstanceId: runtime.runtimeInstanceId, now, revalidate,
    prepareExecution: (source, taskId) => prepareNodeRerunTargetExecution(f.store, source, f.target.attempt.id, taskId) });
  assert.ok(target.status === "created");
  const input = (store: RunStore = f.store, now = new Date().toISOString()): ReadNodeRerunTargetReadinessInput => ({ recordId: record.id, now,
    revalidate: intent => observeNodeRerunAdmission({ store, activeRuns: f.activeRuns, intent, now }),
    observeLocalExecution: candidate => observePreparedNodeRerunExecution(f.activeRuns, candidate),
    validateExecution: candidate => Boolean(readStoredRunnerExecution(candidate)) });
  return { ...f, record, approval: approval.approval, preparedTarget: target.target, runtime, supervisor, input };
}

test("F5-08b reads current target prerequisites without writes, context assembly, resource admission or execution authority", async t => {
  const f = await fixture(t), input = f.input(), before = snapshot(f.store), count = writes(f.store);
  const readiness = f.store.readNodeRerunTargetReadiness(input)!;
  assert.equal(readiness.decision, "eligible_for_resource_admission", JSON.stringify(readiness));
  assert.deepEqual(readiness.blockers, []);
  assert.deepEqual(readiness.target, f.preparedTarget);
  assert.equal(readiness.observedAt, input.now);
  assert.equal(readiness.executionAuthorized, false);
  assert.equal(readiness.revalidateBeforeDispatch, true);
  assert.deepEqual(f.store.readSnapshot(() => f.store.readNodeRerunTargetReadiness(input)), readiness);
  assert.equal(writes(f.store), count); assert.deepEqual(snapshot(f.store), before);
  assert.equal(f.store.isCurrentRunExecutionOwner(f.preparedTarget.runId, f.preparedTarget.fence), false);
  f.supervisor.releaseAll(); f.store.close();
  const reopened = createSqliteRunStore(f.cwd);
  try {
    const count = writes(reopened);
    assert.deepEqual(reopened.readNodeRerunTargetReadiness(f.input(reopened, input.now)), readiness);
    assert.equal(writes(reopened), count); assert.deepEqual(snapshot(reopened), before);
    const expired = reopened.readNodeRerunTargetReadiness(f.input(reopened, "2027-03-15T00:00:00.000Z"))!;
    assert.equal(expired.decision, "blocked"); assert.ok(expired.blockers.includes("approval_not_current"));
  } finally { reopened.close(); }
});

test("F5-08b uses current source and policy facts while preserving the frozen generation", async t => {
  for (const drift of ["artifact", "policy", "source_executor", "source_snapshot", "runtime"] as const) await t.test(drift, async t => {
    const f = await fixture(t), db = database(f.store), generation = f.store.getNodeRerunGeneration(f.record.id);
    if (drift === "artifact") db.prepare("UPDATE artifacts SET content_sha256=? WHERE id=?").run("f".repeat(64), f.upstreamOutput.id);
    if (drift === "policy") f.store.updateApprovalPolicy({ allowedWritePaths: [] }, new Date().toISOString());
    if (drift === "source_executor") f.activeRuns.add(f.target.run.id, { ...f.target.attempt,
      attemptId: f.target.attempt.id, abortController: new AbortController(), streamEnvelope() {} });
    if (drift === "source_snapshot") db.prepare("UPDATE run_sessions SET task_snapshot_json=? WHERE id=?")
      .run(JSON.stringify({ ...f.target.run.taskSnapshot as object, prompt: "changed" }), f.target.run.id);
    if (drift === "runtime") db.prepare("UPDATE runtime_concurrency_policies SET runtime_instance_id='successor-runtime' WHERE workspace_id=?")
      .run(f.preparedTarget.workspaceId);
    const before = snapshot(f.store), count = writes(f.store), result = f.store.readNodeRerunTargetReadiness(f.input())!;
    assert.equal(result.decision, "blocked");
    assert.ok(result.blockers.includes(drift === "runtime" ? "runtime_changed" : "source_not_current"), JSON.stringify(result));
    assert.deepEqual(f.store.getNodeRerunGeneration(f.record.id), generation);
    assert.equal(writes(f.store), count); assert.deepEqual(snapshot(f.store), before);
    f.activeRuns.delete(f.target.run.id);
  });
});

test("F5-08b refuses expired, withdrawn, future-dated or non-local decisions and corrupt checkpoints", async t => {
  for (const state of ["expired", "denied", "future", "non_local", "checkpoint"] as const) await t.test(state, async t => {
    const f = await fixture(t), db = database(f.store);
    const input = state === "expired" ? f.input(f.store, "2027-03-15T00:00:00.000Z") : f.input();
    if (state === "denied") {
      db.prepare("UPDATE approval_requests SET status='denied' WHERE id=?").run(f.approval.id);
      db.prepare("UPDATE approval_checkpoints SET status='denied' WHERE approval_id=?").run(f.approval.id);
    }
    if (state === "future") db.prepare("UPDATE approval_requests SET resolved_at='2027-03-15T00:00:00.000Z' WHERE id=?").run(f.approval.id);
    if (state === "non_local") db.prepare("UPDATE approval_requests SET resolved_by='agent' WHERE id=?").run(f.approval.id);
    if (state === "checkpoint") db.prepare("UPDATE approval_checkpoints SET side_effect_json='{}' WHERE approval_id=?").run(f.approval.id);
    const before = snapshot(f.store), count = writes(f.store);
    if (state === "checkpoint") assert.throws(() => f.store.readNodeRerunTargetReadiness(input), /checkpoint_corrupt/u);
    else {
      const result = f.store.readNodeRerunTargetReadiness(input)!;
      assert.equal(result.decision, "blocked"); assert.ok(result.blockers.includes("approval_not_current"));
    }
    assert.equal(writes(f.store), count); assert.deepEqual(snapshot(f.store), before);
  });
});

test("F5-08b rejects startup evidence, unknown local execution and unavailable SDK input", async t => {
  for (const evidence of ["run", "unit", "attempt", "heartbeat", "lease_history", "slot_history", "runtime_event", "local", "unknown", "sdk"] as const)
    await t.test(evidence, async t => {
      const f = await fixture(t), target = f.preparedTarget, db = database(f.store), now = new Date().toISOString();
      if (evidence === "run") f.store.markRunStarted(target.runId, now);
      if (evidence === "unit") db.prepare("UPDATE work_units SET status='claimed' WHERE id=?").run(target.fence.workUnitId);
      if (evidence === "attempt") db.prepare("UPDATE work_unit_attempts SET status='started' WHERE id=?").run(target.fence.attemptId);
      if (evidence === "heartbeat") db.prepare("UPDATE work_unit_attempts SET last_heartbeat_at=? WHERE id=?").run(now, target.fence.attemptId);
      const resources = { ...target.fence, workspaceId: target.workspaceId, acquiredAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() };
      if (evidence === "lease_history") {
        assert.ok(f.store.acquireResourceLease({ ...resources, resourceType: "task", resourceKey: target.taskId, ownerType: "run", ownerId: target.runId }));
        db.prepare("UPDATE resource_leases SET status='expired' WHERE attempt_id=?").run(target.fence.attemptId);
      }
      if (evidence === "slot_history") {
        assert.ok(f.store.acquireRuntimeSemaphoreSlot({ ...resources, resourceType: "provider", resourceKey: "fixture", limit: 1,
          ownerType: "work_unit_attempt", ownerId: target.fence.attemptId }));
        db.prepare("UPDATE runtime_semaphore_slots SET status='expired' WHERE attempt_id=?").run(target.fence.attemptId);
      }
      if (evidence === "runtime_event") f.store.appendRuntimeEvent({ ...target.fence, type: "work_unit_started", actor: "runner", ts: now, data: {} });
      if (evidence === "local") f.activeRuns.add(target.runId, { abortController: new AbortController(), streamEnvelope() {} });
      const input = { ...f.input(), ...(evidence === "unknown" ? { observeLocalExecution: () => "unknown" as const } : {}),
        ...(evidence === "sdk" ? { validateExecution: () => false } : {}) };
      const before = snapshot(f.store), count = writes(f.store), result = f.store.readNodeRerunTargetReadiness(input)!;
      assert.equal(result.decision, "blocked");
      const blocker = evidence === "local" || evidence === "unknown" ? "local_execution_unconfirmed"
        : evidence === "sdk" ? "frozen_execution_unavailable" : "target_not_pristine";
      assert.ok(result.blockers.includes(blocker), JSON.stringify(result));
      assert.equal(writes(f.store), count); assert.deepEqual(snapshot(f.store), before);
      f.activeRuns.delete(target.runId);
    });
});

test("F5-08b never treats a cancelled target as resource-admissible and does not reopen expired consent", async t => {
  const f = await fixture(t), target = f.preparedTarget;
  assert.equal(f.store.cancelPreparedNodeRerunTarget({ recordId: f.record.id, sourceFence: target.fence,
    now: new Date().toISOString(), observeLocalExecution: () => "absent" }).status, "cancelled");
  const before = snapshot(f.store), count = writes(f.store);
  const result = f.store.readNodeRerunTargetReadiness({ ...f.input(), revalidate: () => assert.fail("released targets cannot reopen source admission"),
    validateExecution: () => assert.fail("released targets cannot rebuild execution") })!;
  assert.equal(result.decision, "blocked"); assert.deepEqual(result.blockers, ["target_released"]);
  assert.equal(writes(f.store), count); assert.deepEqual(snapshot(f.store), before);
});

test("F5-08b missing targets have no readiness and invalid observation times cannot certify them", async t => {
  const f = await fixture(t), before = snapshot(f.store), count = writes(f.store);
  assert.equal(f.store.readNodeRerunTargetReadiness({ ...f.input(), recordId: "missing",
    revalidate: () => assert.fail("missing targets cannot enter source observation") }), undefined);
  for (const now of ["invalid", "2026-11-13T00:00:00.000Z", "2027-03-15T08:00:00.000+08:00"])
    assert.throws(() => f.store.readNodeRerunTargetReadiness({ ...f.input(), now }), /invalid_timestamp/u);
  assert.equal(writes(f.store), count); assert.deepEqual(snapshot(f.store), before);
});

test("F5-08b current source and policy results must still produce the saved plan fingerprint", async t => {
  const f = await fixture(t), input = f.input(), observation = input.revalidate(f.record.intent); assert.ok(observation.observed);
  const before = snapshot(f.store), count = writes(f.store);
  const changed = f.store.readNodeRerunTargetReadiness({ ...input, revalidate: () => ({ ...observation, observed: {
    ...observation.observed!, sourcePolicyFingerprint: "e".repeat(64), currentPolicyFingerprint: "e".repeat(64),
  } }) })!;
  assert.equal(changed.decision, "blocked"); assert.ok(changed.blockers.includes("source_plan_changed"));
  assert.throws(() => f.store.readNodeRerunTargetReadiness({ ...input, revalidate: () => ({ ...observation,
    admission: { ...observation.admission, intentId: "foreign" } }) }), /same source/u);
  assert.equal(writes(f.store), count); assert.deepEqual(snapshot(f.store), before);
});

test("F5-08b retains custody when native submission or Host capacity history contradicts a never-started target", async t => {
  for (const evidence of ["native", "capacity"] as const) await t.test(evidence, async t => {
    const f = await fixture(t), target = f.preparedTarget, db = database(f.store), now = new Date().toISOString();
    if (evidence === "native") {
      db.prepare(`INSERT INTO native_execution_bindings
        (id,thread_id,participant_id,cwd,generation,profile_id,selection_json,created_at) VALUES('binding','thread','participant',?,1,'profile','{}',?)`)
        .run(f.cwd, now);
      db.prepare(`INSERT INTO native_submissions
        (id,binding_id,thread_id,participant_id,run_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,status,created_at,updated_at)
        VALUES ('submission','binding','thread','participant',?,?,?,?,?,'unknown',?,?)`)
        .run(target.runId, target.fence.workUnitId, target.fence.attemptId, target.fence.runtimeInstanceId, target.fence.fencingToken, now, now);
    } else db.prepare(`INSERT INTO runtime_host_capacity_intents
      (intent_id,workspace_id,workspace_key,canonical_cwd,database_path,database_file_identity,owner_kind,owner_key,authority_digest,
        run_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,created_at)
      VALUES('capacity',?,'workspace',?,?,'database','attempt','owner',?,?,?,?,?,?,?)`)
      .run(target.workspaceId, f.cwd, f.store.paths.databasePath, "a".repeat(64), target.runId, target.fence.workUnitId,
        target.fence.attemptId, target.fence.runtimeInstanceId, target.fence.fencingToken, now);
    const before = snapshot(f.store), count = writes(f.store), result = f.store.readNodeRerunTargetReadiness(f.input())!;
    assert.equal(result.decision, "blocked"); assert.ok(result.blockers.includes("target_not_pristine"));
    assert.deepEqual(f.store.cancelPreparedNodeRerunTarget({ recordId: f.record.id, sourceFence: target.fence, now,
      observeLocalExecution: () => "absent" }), { status: "blocked", code: "node_rerun_target_stop_unconfirmed" });
    assert.equal(writes(f.store), count); assert.deepEqual(snapshot(f.store), before);
  });
});

test("F5-08b removed live entries do not hide captured local callback lifetimes from readiness or cancellation", async t => {
  const f = await fixture(t), target = f.preparedTarget;
  let finish!: () => void;
  const completion = new Promise<void>(resolve => { finish = resolve; });
  t.after(finish);
  f.activeRuns.add(target.runId, { ...target.fence, completion, abortController: new AbortController(), streamEnvelope() {} });
  f.activeRuns.delete(target.runId);
  const before = snapshot(f.store), count = writes(f.store);
  const check = () => {
    const result = f.store.readNodeRerunTargetReadiness(f.input())!;
    assert.equal(result.decision, "blocked"); assert.ok(result.blockers.includes("local_execution_unconfirmed"));
    assert.deepEqual(f.store.cancelPreparedNodeRerunTarget({ recordId: f.record.id, sourceFence: target.fence,
      now: new Date().toISOString(), observeLocalExecution: candidate => observePreparedNodeRerunExecution(f.activeRuns, candidate) }),
    { status: "blocked", code: "node_rerun_target_stop_unconfirmed" });
  };
  check(); finish(); await completion; await f.activeRuns.waitForIdle(); check();
  assert.equal(writes(f.store), count); assert.deepEqual(snapshot(f.store), before);
});

test("F5-08b callbacks are synchronous and read-only, and arbitrary outer transactions retain their owner's work", async t => {
  const f = await fixture(t), count = writes(f.store), before = snapshot(f.store);
  for (const callback of ["revalidate", "observeLocalExecution", "validateExecution"] as const) {
    const input = f.input();
    const invalid = () => { database(f.store).exec("UPDATE tasks SET title='mutated'"); return input[callback] as never; };
    assert.throws(() => f.store.readNodeRerunTargetReadiness({ ...input, [callback]: invalid }), /readonly/u);
    const asyncCallback = async () => "absent";
    assert.throws(() => f.store.readNodeRerunTargetReadiness({ ...input, [callback]: asyncCallback }), /synchronous/u);
  }
  assert.equal(writes(f.store), count); assert.deepEqual(snapshot(f.store), before);
  const db = database(f.store);
  db.exec("BEGIN IMMEDIATE"); db.prepare("UPDATE tasks SET title='outer-wip' WHERE id=?").run(f.upstream.task.id);
  assert.throws(() => f.store.readNodeRerunTargetReadiness(f.input()), /transaction/u);
  assert.equal(db.isTransaction, true); assert.equal(f.store.getTask(f.upstream.task.id)?.title, "outer-wip");
  db.exec("ROLLBACK");
  assert.equal(db.prepare("PRAGMA query_only").get()!.query_only, 0);
  assert.deepEqual(snapshot(f.store), before);
});

test("F5-08b maintains one read snapshot during a competing WAL writer and reevaluates on the next read", async t => {
  const f = await fixture(t), peer = new DatabaseSync(f.store.paths.databasePath); t.after(() => peer.close());
  const input = f.input();
  const first = f.store.readNodeRerunTargetReadiness({ ...input, observeLocalExecution: () => {
    peer.prepare("UPDATE artifacts SET content_sha256=? WHERE id=?").run("e".repeat(64), f.upstreamOutput.id);
    return "absent";
  } })!;
  assert.equal(first.decision, "eligible_for_resource_admission"); assert.equal(first.executionAuthorized, false);
  const next = f.store.readNodeRerunTargetReadiness(f.input())!;
  assert.equal(next.decision, "blocked"); assert.ok(next.blockers.includes("source_not_current"));
});

test("F5-08b HTTP readiness is read-only, source-scoped and unavailable for cold workspaces", async t => {
  const f = await fixture(t), registry = new RunStoreRegistry(() => f.store, { recoverOnOpen: false }); registry.getStore(f.cwd);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture"), parts = url.pathname.split("/");
    handleGetNodeRerunTargetReadiness(request, response, url, registry, f.activeRuns, parts[2]!, parts[5]!);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = new URL(`http://127.0.0.1:${address.port}/runs/${f.target.run.id}/node-rerun/intents/${f.record.id}/target/readiness`);
  url.searchParams.set("cwd", f.cwd);
  const before = snapshot(f.store), count = writes(f.store), response = await fetch(url);
  const body = await response.json() as NodeRerunTargetReadinessResponseV1;
  assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.executionAuthorized, false);
  assert.equal(body.readiness.decision, "eligible_for_resource_admission");
  assert.equal(writes(f.store), count); assert.deepEqual(snapshot(f.store), before);
  f.activeRuns.add(f.preparedTarget.runId, { abortController: new AbortController(), streamEnvelope() {} });
  const blocked = await (await fetch(url)).json() as NodeRerunTargetReadinessResponseV1;
  assert.equal(blocked.readiness.decision, "blocked"); assert.ok(blocked.readiness.blockers.includes("local_execution_unconfirmed"));
  f.activeRuns.delete(f.preparedTarget.runId);
  assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 405);
  url.pathname = url.pathname.replace(f.target.run.id, f.upstream.run.id); assert.equal((await fetch(url)).status, 404);
  url.pathname = url.pathname.replace(f.upstream.run.id, f.target.run.id);
  database(f.store).prepare("UPDATE node_rerun_targets SET execution_sha256=? WHERE intent_id=?").run("a".repeat(64), f.record.id);
  const corrupt = await fetch(url); assert.equal(corrupt.status, 503);
  assert.ok(!JSON.stringify(await corrupt.json()).includes(f.cwd));
  url.searchParams.set("cwd", f.cwd + "/cold"); assert.equal((await fetch(url)).status, 503);
  url.search = ""; assert.equal((await fetch(url)).status, 400);
});
