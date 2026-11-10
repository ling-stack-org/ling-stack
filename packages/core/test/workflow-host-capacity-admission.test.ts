import assert from "node:assert/strict";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createRuntimeHostCapacityStoreBinding, HostRunCapacityStore, RuntimeHostCapacityBridge } from "../dist/runtime-host-capacity-store-bridge.js";
import type { HostOperationSource, RuntimeHostCapacityIntentRecord } from "../dist/runtime-host-capacity-store-bridge.js";
import type { RuntimeAttemptFenceV1, WorkflowStepStartCommitInput } from "../dist/index.js";
import { workflowAdmissionFixture } from "./support/workflow-step-admission-fixture.mjs";
import { testDatabase } from "./support/sqlite-test-database.ts";

type Prepared = { run: { id: string }; fence: RuntimeAttemptFenceV1 };
type WorkflowFixture = Awaited<ReturnType<typeof workflowFixture>>;

function source(prepared: Prepared): HostOperationSource {
  return { runId: prepared.run.id, workUnitId: prepared.fence.workUnitId, attemptId: prepared.fence.attemptId,
    runtimeInstanceId: prepared.fence.runtimeInstanceId, fencingToken: prepared.fence.fencingToken };
}

async function workflowFixture(t: TestContext) {
  const binding = createRuntimeHostCapacityStoreBinding();
  const f = await workflowAdmissionFixture(t, { runtimeHostCapacityBinding: binding.binding });
  const host = new HostRunCapacityStore({ globalDatabasePath: join(f.root, "home", "global.sqlite") });
  assert.equal(host.installPolicy({ expectedRevision: 0, maxConcurrentRuns: 2,
    installedAt: f.at(0) }).status, "installed");
  t.after(() => host.close());
  const journal = binding.workspace(f.channel.workspaceId);
  const bridge = new RuntimeHostCapacityBridge(journal, host);
  return { f, bridge, journal, host };
}

function reserve(fixture: WorkflowFixture, prepared: Prepared): RuntimeHostCapacityIntentRecord {
  const result = fixture.bridge.reserveWorkflowStart({ source: source(prepared), now: fixture.f.at(4) });
  assert.ok(result.status === "reserved" || result.status === "duplicate", JSON.stringify(result));
  return result.record;
}

function heldCount(host: HostRunCapacityStore): number {
  const row = host.database.prepare("SELECT COUNT(*) AS count FROM host_run_capacity_reservations WHERE state='held'").get() as { count: number };
  return row.count;
}

function readyInput(f: WorkflowFixture["f"], scope: ReturnType<WorkflowFixture["f"]["scope"]>, prepared: Prepared,
  overrides: Partial<WorkflowStepStartCommitInput> = {}): Partial<WorkflowStepStartCommitInput> {
  return {
    admission: { ...prepared.fence, admission: scope.plan, expiresAt: f.at(3_604) },
    ...overrides,
  };
}

test("workflow start Host reservation requires the preparing workflow owner", async t => {
  const { f, bridge, host } = await workflowFixture(t);
  const scope = f.scope("workflow-owner");
  const generation = f.begin(scope);
  const prepared = f.prepare(scope, generation);
  const result = bridge.reserveWorkflowStart({ source: source(prepared), now: f.at(4) });
  assert.ok(result.status === "reserved" || result.status === "duplicate", JSON.stringify(result));
  assert.equal(result.record.intent.ownerKind, "workflow_start");
  assert.equal(heldCount(host), 1);
});

test("a native workflow step enters the workflow-start gate without also preparing an ordinary attempt", async t => {
  const { f, journal } = await workflowFixture(t);
  const scope = f.scope("native-workflow-owner");
  const generation = f.begin(scope);
  const prepared = f.prepare(scope, generation, "native", { runnerId: "kimi-acp" });
  const nativeRequest = { cwd: f.cwd, workflowStartOwner: generation.owner, runnerId: "kimi-acp", tools: ["read"],
    executionBinding: { kind: "native_profile", engineId: "kimi-acp", profileId: "fixture", profileRevision: 2 } };
  const db = testDatabase(f.store);
  db.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?").run(JSON.stringify(nativeRequest), prepared.run.id);
  db.prepare("UPDATE work_units SET runner_id=?,effective_runner_id=? WHERE id=?").run("kimi-acp", "kimi-acp", prepared.unit.id);
  db.prepare("UPDATE work_unit_attempts SET runner_id=?,effective_runner_id=? WHERE id=?")
    .run("kimi-acp", "kimi-acp", prepared.attempt.id);
  const preparedSource = source(prepared);
  assert.deepEqual(journal.prepareAttempt({ source: preparedSource, now: f.at(4) }), { status: "changed" });
  const result = journal.prepareWorkflowStart({ source: preparedSource, now: f.at(4) });
  assert.ok(result.status === "prepared" || result.status === "duplicate", JSON.stringify(result));
  assert.equal(result.record.intent.ownerKind, "workflow_start");
});

test("workflow ready rolls back admission and Task links when the Host dispatch token is invalid", async t => {
  const { f, bridge, journal, host } = await workflowFixture(t);
  const scope = f.scope("invalid-host-token");
  const generation = f.begin(scope);
  const prepared = f.prepare(scope, generation);
  const record = reserve({ f, bridge, journal, host }, prepared);
  const before = f.admission(scope, generation);
  const result = f.ready(scope, generation, prepared, readyInput(f, scope, prepared, {
    hostCapacity: { intentId: record.intent.intentId, dispatchToken: "f".repeat(64) },
  }));
  assert.deepEqual(result, { status: "invalid", code: "runtime_host_capacity_dispatch_changed" });
  assert.deepEqual(f.admission(scope, generation), before);
  assert.equal(f.current(scope).runId, undefined);
  assert.equal(f.store.getTask(generation.task.id)?.currentRunId, undefined);
  assert.equal(f.count("runtime_semaphore_slots"), 0);
  assert.equal(journal.getIntent(record.intent.intentId)?.dispatchedAt, undefined);
  assert.equal(heldCount(host), 1);
});

test("workflow ready consumes the transferred admission and Host gate exactly once", async t => {
  const { f, bridge, journal, host } = await workflowFixture(t);
  const scope = f.scope("valid-host-token");
  const generation = f.begin(scope);
  const prepared = f.prepare(scope, generation);
  const record = reserve({ f, bridge, journal, host }, prepared);
  assert.ok(record.dispatchToken);
  const result = f.ready(scope, generation, prepared, readyInput(f, scope, prepared, {
    hostCapacity: { intentId: record.intent.intentId, dispatchToken: record.dispatchToken },
  }));
  assert.deepEqual(result, { status: "linked" });
  assert.equal(f.admission(scope, generation)?.status, "transferred");
  assert.equal(journal.getIntent(record.intent.intentId)?.dispatchedAt, f.at(6));
  assert.equal(heldCount(host), 1);
  assert.ok(record.dispatchToken);
  assert.deepEqual(f.ready(scope, generation, prepared, readyInput(f, scope, prepared, {
    hostCapacity: { intentId: record.intent.intentId, dispatchToken: record.dispatchToken },
  })), { status: "duplicate" });
});
