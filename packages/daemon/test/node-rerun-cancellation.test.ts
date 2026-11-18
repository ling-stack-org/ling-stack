import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createSqliteRunStore, type CancelPreparedNodeRerunTargetInput, type RunStore } from "@ling-stack/core";
import { createNodeRerunHostAdmissionPlanV1, type NodeRerunTargetCancellationResponseV1 } from "@ling-stack/contracts";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import type { ResolvedDaemonConfig } from "../dist/config.js";
import { HttpError } from "../dist/errors.js";
import { ensureRunCancelled } from "../dist/features/runs/cancellation.js";
import { handleCancelNodeRerunTarget } from "../dist/features/runs/node-rerun-cancellation.js";
import { prepareNodeRerunTargetExecution } from "../dist/features/runs/node-rerun-targets.js";
import { observeNodeRerunAdmission } from "../dist/features/runs/node-rerun-observation.js";
import { createFixture, prepareInput } from "./support/node-rerun-fixture.ts";

const database = (store: RunStore) => (store as unknown as { readonly database: DatabaseSync }).database;
const rows = (store: RunStore, table: string) => database(store).prepare(`SELECT * FROM ${table}`).all();
const snapshot = (store: RunStore) => Object.fromEntries([
  "tasks", "run_sessions", "work_units", "work_unit_attempts", "runtime_events", "state_transition_events",
  "node_rerun_targets", "approval_requests", "approval_checkpoints", "resource_leases", "runtime_semaphore_slots",
].map(table => [table, rows(store, table)]));
const original = (store: RunStore) => Object.fromEntries([
  "channel_workflows", "channel_workflow_steps", "artifacts", "run_evaluations", "run_evaluation_grades",
].map(table => [table, rows(store, table)]));

async function fixture(t: TestContext) {
  let supervisor: RuntimeSupervisor | undefined;
  t.after(() => supervisor?.releaseAll());
  const f = await createFixture(t, { preparedExecution: true });
  supervisor = new RuntimeSupervisor({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: f.cwd,
    runners: {}, runtimeTools: {}, channels: {}, sandbox: {}, harness: {},
    transports: { providerWebSocketFallback: true, localWebSocketRpc: true } } as ResolvedDaemonConfig);
  const runtime = supervisor.getRuntime(f.cwd, f.store);
  const prepared = f.store.prepareNodeRerunIntent(prepareInput(f)); assert.ok(prepared.status === "created");
  const now = new Date().toISOString(), record = prepared.record;
  const revalidate = (intent: typeof record.intent) => observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent, now });
  const approval = f.store.requestNodeRerunApproval({ recordId: record.id, now, revalidate }); assert.ok(approval.status === "created");
  f.store.approveApprovalRequest(approval.approval.id, { resolvedBy: "local-user", decisionKind: "approve_once" }, now);
  const target = f.store.prepareNodeRerunTarget({ recordId: record.id, runtimeInstanceId: runtime.runtimeInstanceId, now, revalidate,
    prepareExecution: (source, taskId) => prepareNodeRerunTargetExecution(f.store, source, f.target.attempt.id, taskId) });
  assert.ok(target.status === "created");
  const input = (): CancelPreparedNodeRerunTargetInput => ({ recordId: record.id, sourceFence: target.target.fence,
    now: new Date().toISOString(), observeLocalExecution: () => "absent" });
  return { ...f, record, approval: approval.approval, preparedTarget: target.target, runtime, supervisor, input, revalidate };
}

test("F5-08a cancels all target identities and releases its source reservation atomically, idempotently and across reopen", async t => {
  const f = await fixture(t), target = f.preparedTarget, before = original(f.store), view = f.store.getNodeRerunGeneration(f.record.id);
  const source = f.store.getRun(f.target.run.id), approval = f.store.getApprovalRequest(f.approval.id);
  const result = f.store.cancelPreparedNodeRerunTarget(f.input()); assert.ok(result.status === "cancelled", JSON.stringify(result));
  assert.equal(result.cancellation.stopEvidence, "never_dispatched");
  assert.equal(result.cancellation.executionAuthorized, false);
  assert.equal(f.store.getRun(target.runId)?.status, "cancelled");
  assert.equal(f.store.getTask(target.taskId)?.status, "cancelled");
  assert.equal(f.store.getWorkUnit(target.fence.workUnitId)?.status, "cancelled");
  assert.equal(f.store.getWorkUnitAttempt(target.fence.attemptId)?.status, "cancelled");
  assert.equal(rows(f.store, "node_rerun_targets")[0]!.released_at, result.cancellation.releasedAt);
  const terminal = f.store.listRuntimeEvents(target.fence.workUnitId, { complete: true }).filter(event => event.type === "work_unit_cancelled");
  assert.equal(terminal.length, 1);
  assert.deepEqual(terminal[0]!.data, { nodeRerunCancellation: { recordId: result.cancellation.recordId,
    generationId: result.cancellation.generationId, runId: result.cancellation.runId, releasedAt: result.cancellation.releasedAt,
    stopEvidence: "never_dispatched", receiptSha256: createHash("sha256").update(JSON.stringify(result.cancellation)).digest("hex") } });
  assert.equal(terminal[0]!.fencingToken, target.fence.fencingToken);
  assert.deepEqual(f.store.getRun(f.target.run.id), source);
  assert.deepEqual(f.store.getApprovalRequest(f.approval.id), approval);
  assert.deepEqual(original(f.store), before);
  assert.deepEqual(f.store.getNodeRerunGeneration(f.record.id), view);
  const after = snapshot(f.store), retry = { ...f.input(), now: "2027-03-15T00:00:00.000Z",
    observeLocalExecution: () => assert.fail("retry must return the original no-start receipt") };
  assert.deepEqual(f.store.cancelPreparedNodeRerunTarget(retry), { status: "duplicate", cancellation: result.cancellation });
  assert.deepEqual(snapshot(f.store), after);
  f.supervisor.releaseAll(); f.store.close();
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.deepEqual(reopened.cancelPreparedNodeRerunTarget(retry), { status: "duplicate", cancellation: result.cancellation });
    assert.equal(reopened.recoverStaleRuns(new Date().toISOString()), 0);
    assert.deepEqual(snapshot(reopened), after);
  } finally { reopened.close(); }
});

test("F5-08a retains custody on lifecycle, resource history, execution evidence or unconfirmed local execution", async t => {
  for (const evidence of ["run", "unit", "attempt", "task", "heartbeat", "lease", "slot", "completion", "runtime_event", "local_present", "local_unknown"] as const)
    await t.test(evidence, async t => {
      const f = await fixture(t), target = f.preparedTarget, db = database(f.store), now = new Date().toISOString();
      const input = f.input();
      if (evidence === "run") f.store.markRunStarted(target.runId, now);
      if (evidence === "unit") db.prepare("UPDATE work_units SET status='running' WHERE id=?").run(target.fence.workUnitId);
      if (evidence === "attempt") db.prepare("UPDATE work_unit_attempts SET status='started' WHERE id=?").run(target.fence.attemptId);
      if (evidence === "task") f.store.transitionTaskStatus({ taskId: target.taskId, expectedStatus: "todo", event: "claim", actor: "system", now });
      if (evidence === "heartbeat") db.prepare("UPDATE work_unit_attempts SET last_heartbeat_at=? WHERE id=?").run(now, target.fence.attemptId);
      if (evidence === "lease") {
        assert.ok(f.store.acquireResourceLease({ ...target.fence, workspaceId: target.workspaceId, resourceType: "task", resourceKey: target.taskId,
          ownerType: "run", ownerId: target.runId, acquiredAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
        db.prepare("UPDATE resource_leases SET status='expired' WHERE attempt_id=?").run(target.fence.attemptId);
      }
      if (evidence === "slot") {
        assert.ok(f.store.acquireRuntimeSemaphoreSlot({ ...target.fence, workspaceId: target.workspaceId, resourceType: "provider", resourceKey: "fixture",
          limit: 1, ownerType: "work_unit_attempt", ownerId: target.fence.attemptId, acquiredAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
        db.prepare("UPDATE runtime_semaphore_slots SET status='expired' WHERE attempt_id=?").run(target.fence.attemptId);
      }
      if (evidence === "completion") db.prepare(`INSERT INTO host_attempt_completions
        (attempt_id,schema_version,run_id,work_unit_id,runtime_instance_id,fencing_token,registered_at) VALUES (?,1,?,?,?,?,?)`)
        .run(target.fence.attemptId, target.runId, target.fence.workUnitId, target.fence.runtimeInstanceId, target.fence.fencingToken, now);
      if (evidence === "runtime_event") f.store.appendRuntimeEvent({ ...target.fence, type: "work_unit_started", actor: "runner", data: {}, ts: now });
      const request = evidence === "local_present" || evidence === "local_unknown"
        ? { ...input, observeLocalExecution: () => evidence === "local_present" ? "present" as const : "unknown" as const } : input;
      const before = snapshot(f.store);
      assert.deepEqual(f.store.cancelPreparedNodeRerunTarget(request), { status: "blocked", code: "node_rerun_target_stop_unconfirmed" });
      assert.deepEqual(snapshot(f.store), before);
      assert.equal(rows(f.store, "node_rerun_targets")[0]!.released_at, null);
    });
});

test("F5-08a validates every captured fence field and rejects write/async Host observation without losing caller custody", async t => {
  const f = await fixture(t), before = snapshot(f.store);
  for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"] as const) {
    const input = f.input();
    assert.deepEqual(f.store.cancelPreparedNodeRerunTarget({ ...input, sourceFence: { ...input.sourceFence, [field]: "foreign" } }),
      { status: "blocked", code: "node_rerun_target_changed" });
  }
  assert.throws(() => f.store.cancelPreparedNodeRerunTarget({ ...f.input(), observeLocalExecution: () => {
    database(f.store).exec("UPDATE tasks SET title='mutable'"); return "absent";
  } }), /readonly/u);
  assert.throws(() => f.store.cancelPreparedNodeRerunTarget({ ...f.input(),
    observeLocalExecution: (async () => "absent") as unknown as CancelPreparedNodeRerunTargetInput["observeLocalExecution"] }), /synchronous/u);
  assert.deepEqual(snapshot(f.store), before);
  database(f.store).exec("BEGIN IMMEDIATE");
  database(f.store).prepare("UPDATE tasks SET title='outer-wip' WHERE id=?").run(f.upstream.task.id);
  assert.throws(() => f.store.cancelPreparedNodeRerunTarget(f.input()), /transaction/u);
  assert.equal(database(f.store).isTransaction, true);
  assert.equal(f.store.getTask(f.upstream.task.id)?.title, "outer-wip");
  database(f.store).exec("ROLLBACK");
  assert.deepEqual(snapshot(f.store), before);
});

test("F5-08a rolls back every state and retains the reservation on ignored or failed terminal/release writes", async t => {
  for (const boundary of ["run", "task", "unit", "attempt", "audit", "release"] as const) for (const failure of ["IGNORE", "ABORT, 'cancellation write failed'"] as const)
    await t.test(`${boundary}/${failure}`, async t => {
      const f = await fixture(t), db = database(f.store), before = snapshot(f.store);
      const trigger = boundary === "release" ? "BEFORE UPDATE OF released_at ON node_rerun_targets"
        : boundary === "audit" ? "BEFORE INSERT ON runtime_events WHEN NEW.type='work_unit_cancelled'"
        : boundary === "run" ? "BEFORE UPDATE OF status ON run_sessions"
        : boundary === "unit" ? "BEFORE UPDATE OF status ON work_units"
        : boundary === "task" ? "BEFORE UPDATE OF status ON tasks" : "BEFORE UPDATE OF status ON work_unit_attempts";
      db.exec(`CREATE TRIGGER fail_cancel ${trigger} BEGIN SELECT RAISE(${failure}); END`);
      assert.throws(() => f.store.cancelPreparedNodeRerunTarget(f.input()), /transition_failed|Stale runtime attempt fence|receipt|cancellation write failed/u);
      assert.equal(db.isTransaction, false);
      assert.deepEqual(snapshot(f.store), before);
      db.exec("DROP TRIGGER fail_cancel");
      assert.equal(f.store.cancelPreparedNodeRerunTarget(f.input()).status, "cancelled");
    });
});

test("F5-08a excludes competing writers and requires a new intent and consent after release", async t => {
  const f = await fixture(t), peer = new DatabaseSync(f.store.paths.databasePath);
  t.after(() => peer.close()); peer.exec("PRAGMA busy_timeout=1");
  const cancelled = f.store.cancelPreparedNodeRerunTarget({ ...f.input(), observeLocalExecution: () => {
    assert.throws(() => peer.prepare("UPDATE work_unit_attempts SET status='started' WHERE id=?").run(f.preparedTarget.fence.attemptId), /locked/u);
    return "absent";
  } });
  assert.ok(cancelled.status === "cancelled");
  const old = f.store.prepareNodeRerunTarget({ recordId: f.record.id, runtimeInstanceId: f.runtime.runtimeInstanceId,
    now: new Date().toISOString(), revalidate: () => assert.fail("old consent cannot be reused"), prepareExecution: () => assert.fail("old target cannot be recreated") });
  assert.deepEqual(old, { status: "duplicate", target: f.preparedTarget });
  const prepared = prepareInput(f), intent = { ...prepared.request.intent, intentId: "next-explicit-intent", idempotencyKey: "next-key" };
  const observation = prepared.revalidate(intent); assert.ok(observation.observed);
  const plan = createNodeRerunHostAdmissionPlanV1({ intent, ...observation, observed: observation.observed });
  const next = f.store.prepareNodeRerunIntent({ ...prepared, request: { intent, planFingerprint: plan.planFingerprint } }); assert.ok(next.status === "created");
  const now = new Date().toISOString();
  const approval = f.store.requestNodeRerunApproval({ recordId: next.record.id, now, revalidate: f.revalidate }); assert.ok(approval.status === "created");
  assert.notEqual(approval.approval.id, f.approval.id);
  const targetInput = { recordId: next.record.id, runtimeInstanceId: f.runtime.runtimeInstanceId, now, revalidate: f.revalidate,
    prepareExecution: (source: Parameters<typeof prepareNodeRerunTargetExecution>[1], taskId: string) =>
      prepareNodeRerunTargetExecution(f.store, source, f.target.attempt.id, taskId) };
  assert.equal(f.store.prepareNodeRerunTarget(targetInput).status, "blocked");
  f.store.approveApprovalRequest(approval.approval.id, { resolvedBy: "local-user", decisionKind: "approve_once" }, now);
  const nextTarget = f.store.prepareNodeRerunTarget(targetInput); assert.ok(nextTarget.status === "created");
  assert.notEqual(nextTarget.target.generationId, f.preparedTarget.generationId);
  assert.notEqual(nextTarget.target.runId, f.preparedTarget.runId);
});

test("F5-08a does not accept a released timestamp, corrupt audit or changed terminal state as stop proof", async t => {
  for (const corruption of ["release_only", "audit", "terminal"] as const) await t.test(corruption, async t => {
    const f = await fixture(t), db = database(f.store);
    if (corruption === "release_only") db.prepare("UPDATE node_rerun_targets SET released_at=? WHERE intent_id=?").run(f.input().now, f.record.id);
    else {
      assert.equal(f.store.cancelPreparedNodeRerunTarget(f.input()).status, "cancelled");
      if (corruption === "audit") db.prepare("UPDATE runtime_events SET data_json='{}' WHERE attempt_id=? AND type='work_unit_cancelled'")
        .run(f.preparedTarget.fence.attemptId);
      else db.prepare("UPDATE work_unit_attempts SET ended_at=? WHERE id=?").run("2027-03-15T00:00:00.000Z", f.preparedTarget.fence.attemptId);
    }
    const before = snapshot(f.store);
    assert.throws(() => f.store.cancelPreparedNodeRerunTarget(f.input()), /receipt_corrupt/u);
    assert.deepEqual(snapshot(f.store), before);
  });
});

test("F5-08a can stop a never-dispatched target after consent expiry and policy changes", async t => {
  const f = await fixture(t);
  f.store.updateApprovalPolicy({ allowedWritePaths: [] }, new Date().toISOString());
  const result = f.store.cancelPreparedNodeRerunTarget({ ...f.input(), now: "2027-03-15T00:00:00.000Z" });
  assert.ok(result.status === "cancelled");
  assert.equal(result.cancellation.releasedAt, "2027-03-15T00:00:00.000Z");
  assert.equal(f.store.getApprovalRequest(f.approval.id)?.status, "approved");
});

test("F5-08a ordinary cancellation cannot bypass the dedicated no-start boundary", async t => {
  const f = await fixture(t), before = snapshot(f.store);
  assert.throws(() => ensureRunCancelled({ store: f.store, runId: f.preparedTarget.runId, taskId: f.preparedTarget.taskId,
    reason: "user_requested", active: false }), error => error instanceof HttpError && error.code === "node_rerun_cancellation_required");
  assert.deepEqual(snapshot(f.store), before);
});

test("F5-08a HTTP uses empty bodies, original source scope, initialized storage and no active executor", async t => {
  const f = await fixture(t), registry = new RunStoreRegistry(() => f.store, { recoverOnOpen: false }); registry.getStore(f.cwd);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture"), parts = url.pathname.split("/");
    void handleCancelNodeRerunTarget(request, response, url, 1_048_576, registry, f.activeRuns, parts[2]!, parts[5]!);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = new URL(`http://127.0.0.1:${address.port}/runs/${f.target.run.id}/node-rerun/intents/${f.record.id}/target/cancel`);
  url.searchParams.set("cwd", f.cwd);
  const post = (body: unknown) => fetch(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  for (const body of [[], null, { fence: f.preparedTarget.fence }, { runId: f.preparedTarget.runId }]) assert.equal((await post(body)).status, 400);
  assert.equal((await fetch(url)).status, 405);
  f.activeRuns.add(f.preparedTarget.runId, { abortController: new AbortController(), streamEnvelope() {} });
  assert.equal((await post({})).status, 409); f.activeRuns.delete(f.preparedTarget.runId);
  const first = await post({}), body = await first.json() as NodeRerunTargetCancellationResponseV1;
  assert.equal(first.status, 200, JSON.stringify(body)); assert.equal(body.executionAuthorized, false);
  assert.deepEqual(await (await post({})).json(), body);
  url.pathname = url.pathname.replace(f.target.run.id, f.upstream.run.id); assert.equal((await post({})).status, 404);
  url.pathname = url.pathname.replace(f.upstream.run.id, f.target.run.id);
  url.searchParams.set("cwd", f.cwd + "/cold"); assert.equal((await post({})).status, 503);
  url.search = ""; assert.equal((await post({})).status, 400);
});
