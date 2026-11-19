import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createSqliteRunStore, type PrepareNodeRerunTargetInput, type RunStore } from "@ling-stack/core";
import type { NodeRerunTargetResponseV1 } from "@ling-stack/contracts";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import type { ResolvedDaemonConfig } from "../dist/config.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { handleNodeRerunTarget, prepareNodeRerunTargetExecution } from "../dist/features/runs/node-rerun-targets.js";
import { observeNodeRerunAdmission } from "../dist/features/runs/node-rerun-observation.js";
import { rebuildExistingRunRequest, rebuildQueuedRunRequest, readStoredRunnerExecution } from "../dist/features/runs/existing-run-request.js";
import { executeExistingRunContinuation } from "../dist/features/runs/orchestrator.js";
import { createFixture, prepareInput, tableCounts, type Fixture } from "./support/node-rerun-fixture.ts";

const db = (store: RunStore) => (store as unknown as { readonly database: DatabaseSync }).database;
type TestTargetInput = { -readonly [K in keyof PrepareNodeRerunTargetInput]: PrepareNodeRerunTargetInput[K] };

async function fixture(t: TestContext, options: { readonly missingExecution?: boolean; readonly unapproved?: boolean } = {}) {
  let supervisor: RuntimeSupervisor | undefined;
  t.after(() => supervisor?.releaseAll());
  const f = await createFixture(t, { preparedExecution: !options.missingExecution });
  supervisor = new RuntimeSupervisor({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: f.cwd,
    runners: {}, runtimeTools: {}, channels: {}, sandbox: {}, harness: {},
    transports: { providerWebSocketFallback: true, localWebSocketRpc: true } } as ResolvedDaemonConfig);
  const runtime = supervisor.getRuntime(f.cwd, f.store);
  const prepared = f.store.prepareNodeRerunIntent(prepareInput(f));
  assert.ok(prepared.status === "created");
  const now = new Date().toISOString();
  const approval = f.store.requestNodeRerunApproval({ recordId: prepared.record.id, now,
    revalidate: intent => observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent, now }) });
  assert.ok(approval.status === "created");
  if (!options.unapproved) f.store.approveApprovalRequest(approval.approval.id, { resolvedBy: "local-user", decisionKind: "approve_once" }, now);
  const input = (store: RunStore = f.store): TestTargetInput => {
    const now = new Date().toISOString();
    return { recordId: prepared.record.id, runtimeInstanceId: runtime.runtimeInstanceId, now,
      revalidate: intent => observeNodeRerunAdmission({ store, activeRuns: f.activeRuns, intent, now }),
      prepareExecution: (source, taskId) => prepareNodeRerunTargetExecution(store, source, f.target.attempt.id, taskId) };
  };
  return { ...f, supervisor, runtime, record: prepared.record, approval: approval.approval, input };
}

function sourceEvidence(f: Fixture) {
  return { task: f.store.getTask(f.target.task.id), run: f.store.getRun(f.target.run.id), unit: f.store.getWorkUnit(f.target.unit.id),
    attempt: f.store.getWorkUnitAttempt(f.target.attempt.id), step: f.store.getChannelWorkflowStep(f.targetStep.id),
    workflow: f.store.getChannelWorkflow(f.workflow.id), artifact: f.store.getArtifact(f.targetInput.id),
    upstream: f.store.getRun(f.upstream.run.id) };
}

test("F5-06 atomically consumes consent once for independent frozen identities without changing the source", async t => {
  const f = await fixture(t), before = sourceEvidence(f), counts = tableCounts(f.store);
  const original = readStoredRunnerExecution(f.store.getRun(f.target.run.id)!);
  assert.ok(original);
  const prepared = f.store.prepareNodeRerunTarget(f.input());
  assert.ok(prepared.status === "created", JSON.stringify(prepared));
  const target = prepared.target, run = f.store.getRun(target.runId)!;
  const unit = f.store.getWorkUnit(target.fence.workUnitId)!, attempt = f.store.getWorkUnitAttempt(target.fence.attemptId)!;
  assert.notEqual(run.taskId, f.target.task.id);
  assert.notEqual(run.id, f.target.run.id);
  assert.notEqual(unit.id, f.target.unit.id);
  assert.notEqual(attempt.id, f.target.attempt.id);
  assert.equal(target.generationId, f.store.getNodeRerunApprovalBasis(f.approval.id)?.generationId);
  assert.equal(target.executionAuthorized, false);
  assert.equal(run.status, "queued"); assert.equal(unit.status, "queued"); assert.equal(attempt.status, "created");
  assert.equal(run.parentRunId, f.target.run.id); assert.equal(run.workflowStepId, undefined);
  assert.equal(f.store.getLingTurnForRun(run.id), undefined);
  assert.equal(f.store.getTask(target.taskId)?.currentRunId, undefined);
  assert.equal(unit.ownerType, "node_rerun_intent"); assert.equal(unit.ownerId, f.record.id);
  const execution = readStoredRunnerExecution(run)!;
  assert.ok(execution);
  assert.deepEqual({ ...execution, input: { ...execution.input, task: original.input.task }, preparedInput: original.preparedInput }, original);
  assert.equal(execution.preparedInput.userPrompt, original.preparedInput.userPrompt);
  assert.notEqual(execution.preparedInput.fingerprint, original.preparedInput.fingerprint);
  assert.deepEqual(sourceEvidence(f), before);
  assert.equal(f.store.getApprovalRequest(f.approval.id)?.status, "approved");
  assert.equal(f.store.getApprovalCheckpointForApproval(f.approval.id)?.status, "approved");
  assert.deepEqual(tableCounts(f.store), { ...counts, run_sessions: counts.run_sessions! + 1,
    work_units: counts.work_units! + 1, work_unit_attempts: counts.work_unit_attempts! + 1,
    runtime_events: counts.runtime_events! + 1, node_rerun_targets: counts.node_rerun_targets! + 1 });
  assert.deepEqual(f.store.listResourceLeases({ workUnitId: unit.id, complete: true }), []);
  assert.deepEqual(f.store.listRuntimeSemaphoreSlots({ workUnitId: unit.id, complete: true }), []);
  const after = tableCounts(f.store);
  const duplicate = f.store.prepareNodeRerunTarget({ ...f.input(), now: "2027-03-15T00:00:00.000Z",
    revalidate: () => assert.fail("duplicate must not reopen admission"), prepareExecution: () => assert.fail("duplicate must not rebuild input") });
  assert.deepEqual(duplicate, { status: "duplicate", target });
  assert.deepEqual(tableCounts(f.store), after);
  f.supervisor.releaseAll();
  f.store.close();
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.deepEqual(reopened.getNodeRerunTarget(f.record.id), target);
    assert.deepEqual(reopened.prepareNodeRerunTarget(f.input(reopened)), duplicate);
    assert.equal(reopened.recoverStaleRuns(new Date().toISOString()), 0);
    assert.equal(reopened.getRun(run.id)?.status, "queued");
  } finally { reopened.close(); }
});

test("F5-06 blocks missing, unapproved, denied and expired consent without allocating targets", async t => {
  for (const state of ["missing", "pending", "denied", "expired", "checkpoint"] as const) await t.test(state, async t => {
    const f = await fixture(t, { unapproved: state !== "expired" && state !== "checkpoint" });
    if (state === "missing") db(f.store).prepare("DELETE FROM node_rerun_approval_requests WHERE intent_id=?").run(f.record.id);
    if (state === "denied") f.store.denyApprovalRequest(f.approval.id, { resolvedBy: "local-user" }, new Date().toISOString());
    if (state === "checkpoint") db(f.store).prepare("UPDATE approval_checkpoints SET side_effect_json='{}' WHERE approval_id=?").run(f.approval.id);
    const input = f.input(), counts = tableCounts(f.store);
    if (state === "expired") input.now = new Date(Date.parse(f.approval.expiresAt!) + 1).toISOString();
    if (state === "checkpoint") assert.throws(() => f.store.prepareNodeRerunTarget(input), /checkpoint_corrupt/u);
    else assert.deepEqual(f.store.prepareNodeRerunTarget(input), { status: "blocked", code: "node_rerun_approval_unavailable" });
    assert.deepEqual(tableCounts(f.store), counts);
  });
});

test("F5-06 requires complete, owned SDK input and rejects a Host rebind that changes prompt or tools", async t => {
  for (const state of ["missing", "invalid", "provider", "changed_rebind"] as const) await t.test(state, async t => {
    const f = await fixture(t, { missingExecution: state === "missing" });
    const input = f.input(), counts = tableCounts(f.store);
    if (state === "changed_rebind") {
      const prepare = input.prepareExecution;
      input.prepareExecution = (source, taskId) => {
        const value = prepare(source, taskId) as { input: { appendSystemPrompt: string[] } };
        value.input.appendSystemPrompt = ["mutable context"];
        return value;
      };
    }
    if (state === "invalid" || state === "provider") {
      const observation = input.revalidate(f.record.intent);
      const run = f.store.getRun(f.target.run.id)!, request = structuredClone(run.requestSnapshot) as {
        runnerExecutionInput: { preparedInput: { fingerprint: string }; input: { provider: { model: string } } } };
      if (state === "invalid") request.runnerExecutionInput.preparedInput.fingerprint = "invalid";
      else request.runnerExecutionInput.input.provider.model = "other-model";
      db(f.store).prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?").run(JSON.stringify(request), run.id);
      // Even a permissive Host callback cannot bypass Core's identity and fingerprint checks.
      input.revalidate = () => observation;
    }
    const result = f.store.prepareNodeRerunTarget(input);
    assert.ok(result.status === "blocked");
    assert.equal(result.code, "node_rerun_input_unavailable");
    assert.deepEqual(tableCounts(f.store), counts);
  });
});

test("F5-06 rechecks source snapshot, current policy, runtime and stop facts in its writer", async t => {
  for (const state of ["input", "policy", "runtime", "lease"] as const) await t.test(state, async t => {
    const f = await fixture(t), input = f.input();
    if (state === "input") db(f.store).prepare("UPDATE run_sessions SET task_snapshot_json=? WHERE id=?")
      .run(JSON.stringify({ ...(f.target.run.taskSnapshot as object), prompt: "changed" }), f.target.run.id);
    if (state === "policy") f.store.updateApprovalPolicy({ allowedWritePaths: [] }, input.now);
    if (state === "runtime") input.runtimeInstanceId = "foreign-runtime";
    if (state === "lease") db(f.store).prepare("UPDATE work_unit_attempts SET status='started' WHERE id=?").run(f.target.attempt.id);
    const before = tableCounts(f.store);
    assert.deepEqual(f.store.prepareNodeRerunTarget(input), { status: "blocked",
      code: state === "runtime" ? "node_rerun_runtime_changed" : "node_rerun_admission_blocked" });
    assert.deepEqual(tableCounts(f.store), before);
  });
});

test("F5-06 holds source-node custody across distinct intents and competing connections", async t => {
  const f = await fixture(t), input = f.input();
  const peer = new DatabaseSync(f.store.paths.databasePath);
  t.after(() => peer.close());
  peer.exec("PRAGMA busy_timeout=1");
  const prepared = f.store.prepareNodeRerunTarget({ ...input, revalidate: intent => {
    assert.throws(() => peer.prepare("UPDATE approval_requests SET status='denied' WHERE id=?").run(f.approval.id), /locked/u);
    return input.revalidate(intent);
  } });
  assert.ok(prepared.status === "created");
  const next = prepareInput(f);
  const intent = { ...next.request.intent, intentId: "another-rerun-intent", idempotencyKey: "another-rerun-key" };
  const observation = next.revalidate(intent); assert.ok(observation.observed);
  const { createNodeRerunHostAdmissionPlanV1 } = await import("@ling-stack/contracts");
  const plan = createNodeRerunHostAdmissionPlanV1({ intent, ...observation, observed: observation.observed });
  const record = f.store.prepareNodeRerunIntent({ ...next, request: { intent, planFingerprint: plan.planFingerprint } });
  assert.ok(record.status === "created");
  const now = new Date().toISOString();
  const consent = f.store.requestNodeRerunApproval({ recordId: record.record.id, now, revalidate: input.revalidate });
  assert.ok(consent.status === "created");
  f.store.approveApprovalRequest(consent.approval.id, { decisionKind: "approve_once" }, now);
  const before = tableCounts(f.store);
  assert.deepEqual(f.store.prepareNodeRerunTarget({ ...f.input(), recordId: record.record.id }),
    { status: "blocked", code: "node_rerun_generation_active" });
  assert.deepEqual(tableCounts(f.store), before);
});

test("F5-06 rolls back every target row and keeps consent retryable after ignored or failed binding writes", async t => {
  for (const action of ["IGNORE", "ABORT, 'target binding failed'"] as const) await t.test(action, async t => {
    const f = await fixture(t), before = tableCounts(f.store), source = sourceEvidence(f);
    db(f.store).exec(`CREATE TRIGGER reject_target BEFORE INSERT ON node_rerun_targets BEGIN SELECT RAISE(${action}); END`);
    assert.throws(() => f.store.prepareNodeRerunTarget(f.input()), /commit_receipt_missing|target binding failed/u);
    assert.equal(db(f.store).isTransaction, false);
    assert.deepEqual(tableCounts(f.store), before);
    assert.deepEqual(sourceEvidence(f), source);
    assert.equal(f.store.getApprovalRequest(f.approval.id)?.status, "approved");
    db(f.store).exec("DROP TRIGGER reject_target");
    assert.equal(f.store.prepareNodeRerunTarget(f.input()).status, "created");
  });
});

test("F5-06 refuses write or asynchronous input preparation and observation callbacks", async t => {
  const f = await fixture(t), input = f.input(), before = tableCounts(f.store);
  assert.throws(() => f.store.prepareNodeRerunTarget({ ...input, prepareExecution: () => {
    db(f.store).exec("UPDATE run_sessions SET task_id='changed'");
  } }), /readonly/u);
  assert.throws(() => f.store.prepareNodeRerunTarget({ ...input, prepareExecution: async () => undefined }), /synchronous/u);
  assert.throws(() => f.store.prepareNodeRerunTarget({ ...input,
    revalidate: (async (intent: typeof f.record.intent) => input.revalidate(intent)) as unknown as typeof input.revalidate }), /synchronous/u);
  assert.deepEqual(tableCounts(f.store), before);
});

test("F5-06 ordinary queue, continuation, startup and Host effect gates cannot execute a prepared target", async t => {
  const f = await fixture(t), prepared = f.store.prepareNodeRerunTarget(f.input()); assert.ok(prepared.status === "created");
  const target = prepared.target, run = f.store.getRun(target.runId)!;
  assert.throws(() => rebuildExistingRunRequest(run, "daemon_recovery"), /dedicated Host/u);
  assert.throws(() => rebuildQueuedRunRequest(run), /ordinary execution/u);
  assert.deepEqual(f.store.enqueueRuntimeRun({ runId: run.id, sourceFence: target.fence, reason: "resource_conflict", now: new Date().toISOString() }), { status: "changed" });
  assert.equal(f.store.getRuntimeRunQueueEntry(run.id), undefined);
  assert.equal(f.store.transitionRunExecutionStatus({ runId: run.id, sourceFence: target.fence,
    event: "runner_started", actor: "system", now: new Date().toISOString() }).ok, false);
  assert.throws(() => f.store.admitHostOperation({ operationId: "rerun-should-not-launch", kind: "file_mutation", toolCallId: "rerun-write",
    source: { runId: run.id, ...target.fence }, admittedAt: new Date().toISOString() }), /owner/u);
  let errors = 0;
  const registry = new RunStoreRegistry(() => f.store, { recoverOnOpen: false }); registry.getStore(f.cwd);
  assert.equal(await executeExistingRunContinuation({ cwd: f.cwd, runId: run.id, origin: "daemon_recovery", idempotencyDiscriminator: "test" },
    { writeError(status: number, body: unknown) { assert.equal(status, 409); assert.equal((body as { error: string }).error, "node_rerun_execution_unavailable"); errors++; },
      end() {}, writeEvent() {}, isClosed: () => false } as never,
    undefined as never, registry, f.activeRuns, f.supervisor, undefined as never, undefined as never), undefined);
  assert.equal(errors, 1);
  assert.equal(f.store.recoverStaleRuns(new Date().toISOString()), 0);
  assert.equal(f.store.getRun(run.id)?.status, "queued");
  f.supervisor.releaseAll();
  const restarted = new RuntimeSupervisor({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: f.cwd,
    runners: {}, runtimeTools: {}, channels: {}, sandbox: {}, harness: {},
    transports: { providerWebSocketFallback: true, localWebSocketRpc: true } } as ResolvedDaemonConfig);
  try {
    restarted.getRuntime(f.cwd, f.store);
    assert.deepEqual(f.store.getNodeRerunTarget(f.record.id), target);
    assert.equal(f.store.getWorkUnit(target.fence.workUnitId)?.status, "queued");
  } finally { restarted.releaseAll(); }
});

test("F5-06 HTTP accepts only explicit empty target preparation under initialized source scope", async t => {
  const f = await fixture(t), registry = new RunStoreRegistry(() => f.store, { recoverOnOpen: false });
  registry.getStore(f.cwd);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture"), parts = url.pathname.split("/");
    void handleNodeRerunTarget(request, response, url, 1_048_576, registry, f.activeRuns, f.supervisor, parts[2]!, parts[5]!);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = new URL(`http://127.0.0.1:${address.port}/runs/${f.target.run.id}/node-rerun/intents/${f.record.id}/target`);
  url.searchParams.set("cwd", f.cwd);
  const post = (body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const body of [{ runId: "client-run" }, { approvalId: f.approval.id }, [], null]) assert.equal((await post(body)).status, 400);
  assert.equal((await fetch(url)).status, 405);
  const first = await post({}), body = await first.json() as NodeRerunTargetResponseV1;
  assert.equal(first.status, 201, JSON.stringify(body)); assert.equal(body.executionAuthorized, false);
  assert.equal(body.target.executionAuthorized, false);
  assert.deepEqual(await (await post({})).json(), body);
  url.pathname = url.pathname.replace(f.target.run.id, f.upstream.run.id); assert.equal((await post({})).status, 404);
  url.pathname = url.pathname.replace(f.upstream.run.id, f.target.run.id);
  url.searchParams.set("cwd", f.cwd + "/cold"); assert.equal((await post({})).status, 503);
  url.search = ""; assert.equal((await post({})).status, 400);
});
