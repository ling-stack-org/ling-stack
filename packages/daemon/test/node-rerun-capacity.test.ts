import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { SqliteRunStore, type ReadNodeRerunTargetReadinessInput, type RunStore } from "@ling-stack/core";
import { createNodeRerunHostAdmissionPlanV1, type NodeRerunTargetStopResponseV1 } from "@ling-stack/contracts";
import { createRuntimeHostCapacityStoreBinding, HostRunCapacityStore, RuntimeHostCapacityBridge,
  type RuntimeHostCapacityJournal } from "@ling-stack/core/runtime-host-capacity-store-bridge";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import type { ResolvedDaemonConfig } from "../dist/config.js";
import { prepareNodeRerunTargetExecution } from "../dist/features/runs/node-rerun-targets.js";
import { observeNodeRerunAdmission } from "../dist/features/runs/node-rerun-observation.js";
import { readStoredRunnerExecution } from "../dist/features/runs/existing-run-request.js";
import { observePreparedNodeRerunExecution } from "../dist/features/runs/node-rerun-local-execution.js";
import { handleCancelNodeRerunTarget } from "../dist/features/runs/node-rerun-cancellation.js";
import { finalizeDispatchedNodeRerunTargetStop } from "../dist/features/runs/node-rerun-stop.js";
import { createRuntimeHostCapacityAdmission } from "../dist/runtime/run-queue.js";
import { recoverHostCapacityReservations } from "../dist/runtime/host-capacity-recovery.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { createFixture, prepareInput } from "./support/node-rerun-fixture.ts";

const now = () => new Date().toISOString();
const database = (store: RunStore) => (store as unknown as { readonly database: DatabaseSync }).database;
const rows = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const snapshot = (store: RunStore) => Object.fromEntries(["tasks", "run_sessions", "work_units", "work_unit_attempts", "runtime_events",
  "node_rerun_targets", "approval_requests", "approval_checkpoints", "artifacts", "runtime_host_capacity_intents", "runtime_host_capacity_releases",
  "resource_leases", "runtime_semaphore_slots", "run_events", "runtime_run_queue", "run_terminal_intents"].map(table => [table, rows(database(store), table)]));

async function fixture(t: TestContext, configured = true) {
  const capacity = createRuntimeHostCapacityStoreBinding();
  const f = await createFixture(t, { preparedExecution: true, runtimeHostCapacityBinding: capacity.binding });
  const supervisor = new RuntimeSupervisor({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: f.cwd, runners: {},
    runtimeTools: {}, channels: {}, sandbox: {}, harness: {}, transports: {
      providerWebSocketFallback: true, localWebSocketRpc: true } } as ResolvedDaemonConfig);
  t.after(() => supervisor.releaseAll());
  const runtime = supervisor.getRuntime(f.cwd, f.store);
  const prepared = f.store.prepareNodeRerunIntent(prepareInput(f)); assert.ok(prepared.status === "created");
  const record = prepared.record, preparedAt = now();
  const revalidate = (intent: typeof record.intent) => observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent, now: preparedAt });
  const approval = f.store.requestNodeRerunApproval({ recordId: record.id, now: preparedAt, revalidate }); assert.ok(approval.status === "created");
  f.store.approveApprovalRequest(approval.approval.id, { resolvedBy: "local-user", decisionKind: "approve_once" }, preparedAt);
  const preparedTarget = f.store.prepareNodeRerunTarget({ recordId: record.id, now: preparedAt, runtimeInstanceId: runtime.runtimeInstanceId,
    revalidate, prepareExecution: (source, taskId) => prepareNodeRerunTargetExecution(f.store, source, f.target.attempt.id, taskId) });
  assert.ok(preparedTarget.status === "created");
  const target = preparedTarget.target, journal = capacity.workspace(target.workspaceId);
  const host = new HostRunCapacityStore({ globalDatabasePath: join(f.cwd, "host-capacity.sqlite") });
  t.after(() => host.close());
  if (configured) assert.equal(host.installPolicy({ expectedRevision: 0, maxConcurrentRuns: 1, installedAt: preparedAt }).status, "installed");
  const input = (store: RunStore = f.store, observedAt = now()): ReadNodeRerunTargetReadinessInput => ({ recordId: record.id, now: observedAt,
    revalidate: intent => observeNodeRerunAdmission({ store, activeRuns: f.activeRuns, intent, now: observedAt }),
    observeLocalExecution: candidate => observePreparedNodeRerunExecution(f.activeRuns, candidate),
    validateExecution: candidate => Boolean(readStoredRunnerExecution(candidate)) });
  const openPeer = () => {
    const binding = createRuntimeHostCapacityStoreBinding();
    const store = new SqliteRunStore({ cwd: f.cwd, runtimeHostCapacityBinding: binding.binding });
    t.after(() => store.close());
    return { store, journal: binding.workspace(target.workspaceId) };
  };
  return { ...f, capacity, record, target, approval: approval.approval, supervisor, runtime, journal, host,
    bridge: new RuntimeHostCapacityBridge(journal, host), input, openPeer };
}

test("F5-08c2 derives one capacity identity and shares Host capacity without admitting resources or authorizing execution", async t => {
  const f = await fixture(t), initial = snapshot(f.store), input = f.input();
  const prepared = f.journal.prepareNodeRerunCapacity(input); assert.ok(prepared.status === "prepared");
  const record = prepared.record;
  assert.equal(record.intent.ownerKind, "node_rerun_target"); assert.match(record.intent.ownerKey, /^[a-f0-9]{64}$/u);
  assert.match(record.intent.authorityDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(record.source, { runId: f.target.runId, ...f.target.fence });
  assert.equal(record.reservation, undefined); assert.equal(record.dispatchedAt, undefined);
  assert.deepEqual({ ...snapshot(f.store), runtime_host_capacity_intents: initial.runtime_host_capacity_intents }, initial);
  const before = snapshot(f.store), count = database(f.store).prepare("SELECT total_changes() n").get()!.n;
  const duplicate = f.journal.prepareNodeRerunCapacity(f.input()); assert.equal(duplicate.status, "duplicate");
  assert.deepEqual(duplicate, { status: "duplicate", record });
  assert.deepEqual(snapshot(f.store), before); assert.equal(database(f.store).prepare("SELECT total_changes() n").get()!.n, count);
  const reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
  assert.ok(reserved.record.reservation && reserved.record.dispatchToken);
  assert.deepEqual(f.bridge.reserveNodeRerunTarget(f.input()), { status: "duplicate", record: reserved.record });
  assert.deepEqual(f.host.counts(), { held: 1, released: 0, total: 1 });
  const readiness = f.store.readNodeRerunTargetReadiness({ ...f.input(), ...{ verifiedCapacityIntentId: record.intent.intentId } })!;
  assert.equal(readiness.decision, "blocked"); assert.ok(readiness.blockers.includes("target_not_pristine"));
  assert.equal(readiness.executionAuthorized, false);
  assert.equal(f.store.isCurrentRunExecutionOwner(f.target.runId, f.target.fence), false);
  for (const prepare of [f.journal.prepareAttempt, f.journal.prepareExecution])
    assert.deepEqual(prepare({ source: record.source!, now: now() }), { status: "changed" });
  assert.equal(f.journal.consumeDispatchGate({ intentId: record.intent.intentId, token: reserved.record.dispatchToken!, source: record.source!, now: now() }), false);
  assert.equal(f.journal.prepareNoDispatchRelease({ intentId: record.intent.intentId, now: now() }).status, "changed");
  assert.deepEqual(f.store.getNodeRerunTarget(f.record.id), f.target);
  assert.deepEqual(snapshot(f.store).resource_leases, []); assert.deepEqual(snapshot(f.store).runtime_semaphore_slots, []);
});

test("F5-08c2 full or unconfigured Host capacity keeps the exact prepared identity retryable", async t => {
  for (const configured of [true, false]) await t.test(configured ? "full" : "unconfigured", async t => {
    const f = await fixture(t, configured), prepared = f.journal.prepareNodeRerunCapacity(f.input()); assert.ok(prepared.status === "prepared");
    const blocker = configured ? f.host.reserve({ intent: { ...prepared.record.intent, intentId: "ordinary-work", ownerKind: "attempt", ownerKey: "ordinary-work" }, now: now() }) : undefined;
    assert.equal(f.bridge.reserveNodeRerunTarget(f.input()).status, configured ? "full" : "unconfigured");
    assert.deepEqual(f.journal.getIntent(prepared.record.intent.intentId), prepared.record);
    if (configured) {
      assert.ok(blocker && "reservation" in blocker);
      assert.equal(f.host.release({ intent: blocker.reservation.intent, reservationId: blocker.reservation.reservationId,
        token: blocker.reservation.token, kind: "no_dispatch", proofDigest: "f".repeat(64), now: now() }).status, "released");
    } else assert.equal(f.host.installPolicy({ expectedRevision: 0, maxConcurrentRuns: 1, installedAt: now() }).status, "installed");
    const admitted = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(admitted.status === "reserved");
    assert.deepEqual(admitted.record.intent, prepared.record.intent);
    assert.equal(admitted.record.createdAt, prepared.record.createdAt);
    assert.deepEqual(snapshot(f.store).resource_leases, []); assert.deepEqual(snapshot(f.store).runtime_semaphore_slots, []);
  });
});

test("F5-08c2 rechecks current source, approval, policy, SDK and local execution for both initial and duplicate preparation", async t => {
  for (const duplicate of [false, true]) for (const drift of ["artifact", "policy", "approval", "expired", "runtime", "local", "unknown", "sdk", "plan"] as const)
    await t.test(`${duplicate ? "duplicate" : "initial"}/${drift}`, async t => {
      const f = await fixture(t), db = database(f.store);
      if (duplicate) assert.equal(f.journal.prepareNodeRerunCapacity(f.input()).status, "prepared");
      let input = f.input();
      if (drift === "artifact") db.prepare("UPDATE artifacts SET content_sha256=? WHERE id=?").run("f".repeat(64), f.upstreamOutput.id);
      if (drift === "policy") f.store.updateApprovalPolicy({ allowedWritePaths: [] }, now());
      if (drift === "approval") db.prepare("UPDATE approval_requests SET resolved_by='agent' WHERE id=?").run(f.approval.id);
      if (drift === "expired") input = f.input(f.store, "2027-03-15T00:00:00.000Z");
      if (drift === "runtime") db.prepare("UPDATE runtime_concurrency_policies SET runtime_instance_id='successor' WHERE workspace_id=?").run(f.target.workspaceId);
      if (drift === "local") input = { ...input, observeLocalExecution: () => "present" };
      if (drift === "unknown") input = { ...input, observeLocalExecution: () => "unknown" };
      if (drift === "sdk") input = { ...input, validateExecution: () => false };
      if (drift === "plan") {
        const observation = input.revalidate(f.record.intent); assert.ok(observation.observed);
        input = { ...input, revalidate: () => ({ ...observation, observed: { ...observation.observed!,
          currentPolicyFingerprint: "e".repeat(64), sourcePolicyFingerprint: "e".repeat(64) } }) };
      }
      const before = snapshot(f.store), held = rows(f.host.database, "host_run_capacity_reservations");
      assert.deepEqual(f.bridge.reserveNodeRerunTarget(input), { status: "changed" });
      assert.deepEqual(snapshot(f.store), before); assert.deepEqual(rows(f.host.database, "host_run_capacity_reservations"), held);
    });
});

test("F5-08c2 the sole permitted history row must retain its exact owner, source, physical identity, authority and unconsumed lifetime", async t => {
  for (const drift of ["owner", "owner_key", "authority", "run", "work_unit", "attempt", "runtime", "fence", "workspace_key", "database_identity", "created", "reserved", "revoked", "dispatched"] as const)
    await t.test(drift, async t => {
      const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
      const db = database(f.store), id = reserved.record.intent.intentId;
      const values: Record<typeof drift, readonly [string, string]> = {
        owner: ["owner_kind", "attempt"], owner_key: ["owner_key", "foreign-owner"], authority: ["authority_digest", "a".repeat(64)],
        run: ["run_id", f.upstream.run.id], work_unit: ["work_unit_id", f.upstream.unit.id], attempt: ["attempt_id", f.upstream.attempt.id],
        runtime: ["runtime_instance_id", "foreign-runtime"], fence: ["fencing_token", "foreign-fence"], workspace_key: ["workspace_key", "foreign-workspace"],
        database_identity: ["database_file_identity", "foreign-database"], created: ["created_at", "2027-03-15T00:00:00.000Z"],
        reserved: ["reserved_at", "2027-03-15T00:00:00.000Z"], revoked: ["revoked_at", now()], dispatched: ["dispatched_at", now()],
      };
      const [column, value] = values[drift]; db.prepare(`UPDATE runtime_host_capacity_intents SET ${column}=? WHERE intent_id=?`).run(value, id);
      const before = snapshot(f.store), held = rows(f.host.database, "host_run_capacity_reservations");
      assert.deepEqual(f.bridge.reserveNodeRerunTarget(f.input()), { status: "changed" });
      assert.deepEqual(snapshot(f.store), before); assert.deepEqual(rows(f.host.database, "host_run_capacity_reservations"), held);
    });
});

test("F5-08c2 an exact own capacity row never hides other capacity, expired resource or execution history", async t => {
  for (const history of ["capacity", "run-capacity", "lease", "event"] as const) await t.test(history, async t => {
    const f = await fixture(t), prepared = f.journal.prepareNodeRerunCapacity(f.input()); assert.ok(prepared.status === "prepared");
    const db = database(f.store);
    if (history === "capacity" || history === "run-capacity") db.prepare(`INSERT INTO runtime_host_capacity_intents
      SELECT 'other-history',workspace_id,workspace_key,canonical_cwd,database_path,database_file_identity,
        'attempt','other-history',authority_digest,run_id,?,?,runtime_instance_id,fencing_token,created_at,
        NULL,NULL,NULL,NULL,NULL,NULL,NULL FROM runtime_host_capacity_intents WHERE intent_id=?`)
      .run(history === "run-capacity" ? f.upstream.unit.id : f.target.fence.workUnitId, f.upstream.attempt.id, prepared.record.intent.intentId);
    if (history === "lease") {
      assert.ok(f.store.acquireResourceLease({ ...f.target.fence, workspaceId: f.target.workspaceId, resourceType: "task", resourceKey: f.target.taskId,
        ownerType: "run", ownerId: f.target.runId, acquiredAt: now(), expiresAt: "2027-03-15T00:00:00.000Z" }));
      db.prepare("UPDATE resource_leases SET status='expired' WHERE attempt_id=?").run(f.target.fence.attemptId);
    }
    if (history === "event") f.store.appendRuntimeEvent({ ...f.target.fence, type: "work_unit_started", actor: "runner", ts: now(), data: {} });
    const before = snapshot(f.store);
    assert.deepEqual(f.bridge.reserveNodeRerunTarget(f.input()), { status: "changed" });
    assert.deepEqual(snapshot(f.store), before); assert.equal(f.host.counts().held, 0);
  });
});

test("F5-08c2 a crash between Host reserve and workspace attach retains credentials through reopen and observe", async t => {
  const f = await fixture(t), prepared = f.journal.prepareNodeRerunCapacity(f.input()); assert.ok(prepared.status === "prepared");
  const reserved = f.host.reserve({ intent: prepared.record.intent, now: now() }); assert.ok(reserved.status === "reserved");
  const before = snapshot(f.store), held = rows(f.host.database, "host_run_capacity_reservations"), oldPrepare = f.journal.prepareNodeRerunCapacity;
  f.supervisor.releaseAll(); f.store.close();
  const peer = f.openPeer(), bridge = new RuntimeHostCapacityBridge(peer.journal, f.host);
  assert.throws(() => oldPrepare(f.input(peer.store)), /binding_invalid/u);
  assert.deepEqual(snapshot(peer.store), before);
  const observed = bridge.observeReservation(prepared.record.intent.intentId, now()); assert.ok(observed?.reservation && observed.dispatchToken);
  assert.equal(observed.reservation.token, reserved.reservation.token);
  assert.deepEqual(bridge.reserveNodeRerunTarget(f.input(peer.store)), { status: "duplicate", record: observed });
  assert.deepEqual(rows(f.host.database, "host_run_capacity_reservations"), held);
  assert.equal(peer.journal.consumeDispatchGate({ intentId: observed.intent.intentId, token: observed.dispatchToken,
    source: observed.source!, now: now() }), false);
});

test("F5-08c2 failed or interrupted attachment never releases a reserved slot or repeats execution", async t => {
  for (const failure of ["changed", "throw"] as const) await t.test(failure, async t => {
    const f = await fixture(t), journal: RuntimeHostCapacityJournal = { ...f.journal, attachReservation() {
      if (failure === "throw") throw new Error("attach interrupted");
      return { status: "changed" };
    } }, bridge = new RuntimeHostCapacityBridge(journal, f.host);
    if (failure === "throw") assert.throws(() => bridge.reserveNodeRerunTarget(f.input()), /attach interrupted/u);
    else assert.deepEqual(bridge.reserveNodeRerunTarget(f.input()), { status: "retained" });
    assert.deepEqual(f.host.counts(), { held: 1, released: 0, total: 1 });
    const held = f.host.listHeld().reservations[0]!;
    assert.equal(f.journal.getIntent(held.intent.intentId)!.reservation, undefined);
    const observed = f.bridge.observeReservation(held.intent.intentId, now()); assert.equal(observed?.reservation?.token, held.token);
    assert.deepEqual(f.bridge.reserveNodeRerunTarget(f.input()), { status: "duplicate", record: observed });
    assert.deepEqual(snapshot(f.store).resource_leases, []); assert.deepEqual(snapshot(f.store).runtime_semaphore_slots, []);
  });
});

test("F5-08c2 peer journals reuse exactly one workspace and Host reservation", async t => {
  const f = await fixture(t), peer = f.openPeer();
  const left = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(left.status === "reserved");
  const right = new RuntimeHostCapacityBridge(peer.journal, f.host).reserveNodeRerunTarget(f.input(peer.store));
  assert.deepEqual(right, { status: "duplicate", record: left.record });
  assert.equal(rows(database(f.store), "runtime_host_capacity_intents").length, 1);
  assert.deepEqual(f.host.counts(), { held: 1, released: 0, total: 1 });
});

test("F5-08c2 observation may attach after source drift but cannot convert that receipt into dispatch authority", async t => {
  const f = await fixture(t), prepared = f.journal.prepareNodeRerunCapacity(f.input()); assert.ok(prepared.status === "prepared");
  const reserved = f.host.reserve({ intent: prepared.record.intent, now: now() }); assert.equal(reserved.status, "reserved");
  f.store.updateApprovalPolicy({ allowedWritePaths: [] }, now());
  const observed = f.bridge.observeReservation(prepared.record.intent.intentId, now()); assert.ok(observed?.reservation && observed.dispatchToken);
  const before = snapshot(f.store);
  assert.deepEqual(f.bridge.reserveNodeRerunTarget(f.input()), { status: "changed" });
  assert.equal(f.journal.consumeDispatchGate({ intentId: observed.intent.intentId, token: observed.dispatchToken, source: observed.source!, now: now() }), false);
  assert.deepEqual(snapshot(f.store), before); assert.deepEqual(f.host.counts(), { held: 1, released: 0, total: 1 });
});

test("F5-08c2 missing, released, corrupt or incorrectly scoped targets never create capacity", async t => {
  for (const state of ["missing", "released", "corrupt", "workspace"] as const) await t.test(state, async t => {
    const f = await fixture(t); let journal = f.journal, input = f.input();
    if (state === "missing") input = { ...input, recordId: "missing-target" };
    if (state === "released") assert.equal(f.store.cancelPreparedNodeRerunTarget({ recordId: f.record.id, sourceFence: f.target.fence,
      now: now(), observeLocalExecution: () => "absent" }).status, "cancelled");
    if (state === "corrupt") database(f.store).prepare("UPDATE node_rerun_targets SET execution_sha256=? WHERE intent_id=?").run("e".repeat(64), f.record.id);
    if (state === "workspace") {
      database(f.store).prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES('foreign-workspace','Foreign',?,?)").run(now(), now());
      journal = f.capacity.workspace("foreign-workspace");
    }
    const before = snapshot(f.store), bridge = new RuntimeHostCapacityBridge(journal, f.host);
    if (state === "corrupt") assert.throws(() => bridge.reserveNodeRerunTarget(input), /binding_corrupt/u);
    else assert.deepEqual(bridge.reserveNodeRerunTarget(input), { status: "changed" });
    assert.deepEqual(snapshot(f.store), before); assert.equal(f.host.counts().held, 0);
  });
});

test("F5-08c2 a peer writer cannot have its work adopted or rolled back by capacity preparation", async t => {
  const f = await fixture(t), peer = f.openPeer(), db = database(f.store), other = database(peer.store);
  db.exec("PRAGMA busy_timeout=1"); other.exec("BEGIN IMMEDIATE");
  other.prepare("UPDATE tasks SET title='peer work' WHERE id=?").run(f.upstream.task.id);
  const before = snapshot(f.store);
  assert.throws(() => f.bridge.reserveNodeRerunTarget(f.input()), /locked/u);
  assert.equal(db.isTransaction, false); assert.equal(other.isTransaction, true);
  assert.equal(peer.store.getTask(f.upstream.task.id)!.title, "peer work"); assert.deepEqual(snapshot(f.store), before);
  other.exec("ROLLBACK"); assert.equal(f.bridge.reserveNodeRerunTarget(f.input()).status, "reserved");
});

test("F5-08c2 synchronous read-only callbacks and outer transaction boundaries preserve caller work", async t => {
  const f = await fixture(t), db = database(f.store), before = snapshot(f.store);
  for (const callback of ["revalidate", "observeLocalExecution", "validateExecution"] as const) {
    const input = f.input();
    assert.throws(() => f.bridge.reserveNodeRerunTarget({ ...input, [callback]: () => {
      db.prepare("UPDATE tasks SET title='unexpected write'").run(); return undefined;
    } }), /readonly/u);
    assert.throws(() => f.bridge.reserveNodeRerunTarget({ ...input, [callback]: async () => "absent" }), /synchronous/u);
    assert.deepEqual(snapshot(f.store), before);
  }
  db.exec("BEGIN IMMEDIATE"); db.prepare("UPDATE tasks SET title='caller work' WHERE id=?").run(f.upstream.task.id);
  const outer = snapshot(f.store);
  assert.throws(() => f.bridge.reserveNodeRerunTarget(f.input()), /nested_handoff/u);
  assert.throws(() => f.journal.prepareNodeRerunCapacity(f.input()), /within a transaction/u);
  assert.equal(db.isTransaction, true); assert.deepEqual(snapshot(f.store), outer); db.exec("ROLLBACK");
  f.host.database.exec("BEGIN IMMEDIATE");
  assert.throws(() => f.bridge.reserveNodeRerunTarget(f.input()), /nested_handoff/u);
  assert.equal(f.host.database.isTransaction, true); f.host.database.exec("ROLLBACK");
  assert.deepEqual(snapshot(f.store), before); assert.equal(f.host.counts().held, 0);
});

test("F5-08c2 ignored, failed, post-insert drift and COMMIT writes roll back the entire workspace preparation", async t => {
  for (const fault of ["ignore", "abort", "drift", "commit"] as const) await t.test(fault, async t => {
    const f = await fixture(t), db = database(f.store);
    if (fault === "ignore" || fault === "abort") db.exec(`CREATE TRIGGER capacity_insert_fault BEFORE INSERT ON runtime_host_capacity_intents
      BEGIN SELECT RAISE(${fault === "ignore" ? "IGNORE" : "ABORT,'capacity fault'"}); END`);
    if (fault === "drift") db.exec(`CREATE TRIGGER capacity_insert_fault AFTER INSERT ON runtime_host_capacity_intents
      BEGIN UPDATE tasks SET title='changed input' WHERE id='${f.target.taskId}'; END`);
    const before = snapshot(f.store), exec = db.exec.bind(db);
    const mock = fault === "commit" ? t.mock.method(db, "exec", (sql: string) => {
      if (sql === "COMMIT") throw new Error("capacity commit fault"); return exec(sql);
    }) : undefined;
    try { assert.throws(() => f.bridge.reserveNodeRerunTarget(f.input()), /preparation_unverified|capacity fault|binding_corrupt|capacity commit fault/u); }
    finally { mock?.mock.restore(); }
    assert.deepEqual(snapshot(f.store), before); assert.equal(db.isTransaction, false); assert.equal(f.host.counts().held, 0);
    if (fault !== "commit") db.exec("DROP TRIGGER capacity_insert_fault");
    assert.equal(f.bridge.reserveNodeRerunTarget(f.input()).status, "reserved");
  });
});

test("F5-08c4 admits the frozen rerun resource group atomically without consuming the Host dispatch gate", async t => {
  const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
  const id = reserved.record.intent.intentId, before = snapshot(f.store);
  const admitted = f.bridge.admitNodeRerunResources(f.input()); assert.equal(admitted.status, "admitted", JSON.stringify(admitted));
  const leases = snapshot(f.store).resource_leases, slots = snapshot(f.store).runtime_semaphore_slots;
  assert.equal(leases.length, 1); assert.equal(slots.length, 3);
  assert.equal(slots.find(slot => slot.resource_type === "runner")?.resource_key,
    f.store.getWorkUnitAttempt(f.target.fence.attemptId)?.effectiveRunnerId);
  assert.equal(f.journal.getIntent(id)?.dispatchedAt, undefined);
  assert.equal(f.journal.consumeDispatchGate({ intentId: id, token: reserved.record.dispatchToken!, source: reserved.record.source!, now: now() }), false);
  const after = snapshot(f.store), duplicate = f.bridge.admitNodeRerunResources(f.input());
  assert.deepEqual(duplicate, { status: "duplicate", record: admitted.record });
  assert.deepEqual(snapshot(f.store), after);
  assert.notDeepEqual(after.resource_leases, before.resource_leases);
  assert.notDeepEqual(after.runtime_semaphore_slots, before.runtime_semaphore_slots);
  assert.deepEqual(f.bridge.consumeNodeRerunDispatchGate({ recordId: f.record.id, now: now() }), { status: "consumed" });
  assert.ok(f.journal.getIntent(id)?.dispatchedAt);
  assert.deepEqual(f.bridge.consumeNodeRerunDispatchGate({ recordId: f.record.id, now: now() }), { status: "changed" });
});

test("F5-08c5 revalidates rerun identity, source, prestart and local resources before consuming its gate", async t => {
  for (const drift of ["owner", "source", "digest", "prestart", "resources"] as const) await t.test(drift, async t => {
    const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
    assert.equal(f.bridge.admitNodeRerunResources(f.input()).status, "admitted");
    const db = database(f.store), id = reserved.record.intent.intentId;
    db.exec("PRAGMA ignore_check_constraints=ON");
    if (drift === "owner") db.prepare("UPDATE runtime_host_capacity_intents SET owner_kind='attempt' WHERE intent_id=?").run(id);
    if (drift === "source") db.prepare("UPDATE runtime_host_capacity_intents SET run_id=? WHERE intent_id=?").run(f.upstream.run.id, id);
    if (drift === "digest") db.prepare("UPDATE runtime_host_capacity_intents SET authority_digest=? WHERE intent_id=?").run("d".repeat(64), id);
    if (drift === "prestart") db.prepare("UPDATE work_unit_attempts SET started_at=? WHERE id=?").run(now(), f.target.fence.attemptId);
    if (drift === "resources") db.prepare("DELETE FROM resource_leases WHERE attempt_id=?").run(f.target.fence.attemptId);
    db.exec("PRAGMA ignore_check_constraints=OFF");
    assert.deepEqual(f.bridge.consumeNodeRerunDispatchGate({ recordId: f.record.id, now: now() }), { status: "changed" });
    if (drift === "owner") assert.throws(() => f.journal.getIntent(id), /intent_identity_changed/u);
    else assert.equal(f.journal.getIntent(id)?.dispatchedAt, undefined);
  });
});

test("F5-08c5 dedicated dispatch atomically claims the target and is one-shot", async t => {
  const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
  const admitted = f.bridge.admitNodeRerunResources(f.input()); assert.equal(admitted.status, "admitted");
  const reference = { intentId: reserved.record.intent.intentId, dispatchToken: reserved.record.dispatchToken! };
  const dispatched = f.store.dispatchNodeRerunTarget({ recordId: f.record.id, now: now(), hostCapacity: reference });
  assert.equal(dispatched.status, "admitted");
  if (dispatched.status === "admitted") assert.deepEqual(dispatched.target, f.target);
  assert.equal(f.store.getTask(f.target.taskId)?.status, "claimed");
  assert.equal(f.store.getTask(f.target.taskId)?.currentRunId, f.target.runId);
  assert.equal(f.store.getWorkUnit(f.target.fence.workUnitId)?.status, "claimed");
  assert.equal(f.store.getWorkUnitAttempt(f.target.fence.attemptId)?.status, "created");
  assert.ok(f.journal.getIntent(reference.intentId)?.dispatchedAt);
  assert.equal(f.store.listRuntimeEvents(f.target.fence.workUnitId).some(event => event.type === "work_unit_claimed"), true);

  const before = snapshot(f.store);
  assert.deepEqual(f.store.dispatchNodeRerunTarget({ recordId: f.record.id, now: now(), hostCapacity: reference }), { status: "changed" });
  assert.deepEqual(snapshot(f.store), before);
  assert.equal(f.journal.consumeDispatchGate({ intentId: reference.intentId, token: reference.dispatchToken,
    source: { runId: f.target.runId, ...f.target.fence }, now: now() }), false);
  assert.deepEqual(f.store.enqueueRuntimeRun({ runId: f.target.runId, sourceFence: f.target.fence,
    reason: "resource_conflict", now: now() }), { status: "changed" });
});

test("F5 restart recovery retains an unknown dispatched rerun and never replays it", async t => {
  const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
  assert.equal(f.bridge.admitNodeRerunResources(f.input()).status, "admitted");
  const reference = { intentId: reserved.record.intent.intentId, dispatchToken: reserved.record.dispatchToken! };
  assert.equal(f.store.dispatchNodeRerunTarget({ recordId: f.record.id, now: now(), hostCapacity: reference }).status, "admitted");

  // Reopen the workspace through a new Store and Host admission. The dispatch
  // receipt survived the process boundary, but no Runner completion/effect
  // coverage exists, so recovery must retain custody and record an unknown
  // outcome instead of invoking the receiver again.
  f.supervisor.releaseAll();
  f.store.close();
  const peer = f.openPeer();
  const admission = createRuntimeHostCapacityAdmission({ host: f.host, workspace: () => peer.journal });
  const recovered = recoverHostCapacityReservations({ store: peer.store, workspaceId: f.target.workspaceId,
    host: f.host, admission, now: now() });
  assert.deepEqual(recovered, { observed: 1, released: 0, unknown: 1 });
  assert.deepEqual(f.host.counts(), { held: 1, released: 0, total: 1 });
  assert.equal(peer.store.getRun(f.target.runId)?.status, "queued");
  assert.equal(peer.store.getWorkUnit(f.target.fence.workUnitId)?.status, "claimed");
  assert.equal(peer.store.getWorkUnitAttempt(f.target.fence.attemptId)?.status, "created");
  const unknownEvents = peer.store.listRuntimeEvents(f.target.fence.workUnitId, { complete: true })
    .filter(event => event.type === "diagnostic_stuck_detected");
  assert.equal(unknownEvents.length, 1);
  assert.equal((unknownEvents[0]?.data as { readonly code?: string }).code, "node_rerun_dispatch_outcome_unknown");

  const repeated = recoverHostCapacityReservations({ store: peer.store, workspaceId: f.target.workspaceId,
    host: f.host, admission, now: now() });
  assert.deepEqual(repeated, { observed: 1, released: 0, unknown: 1 });
  assert.equal(peer.store.listRuntimeEvents(f.target.fence.workUnitId, { complete: true })
    .filter(event => event.type === "diagnostic_stuck_detected").length, 1);
  assert.equal(peer.journal.getIntent(reference.intentId)?.dispatchedAt !== undefined, true);
});

test("F5-08d dispatched targets enter an exact-fence stop boundary without releasing Host custody", async t => {
  const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
  assert.equal(f.bridge.admitNodeRerunResources(f.input()).status, "admitted");
  const reference = { intentId: reserved.record.intent.intentId, dispatchToken: reserved.record.dispatchToken! };
  assert.equal(f.store.dispatchNodeRerunTarget({ recordId: f.record.id, now: now(), hostCapacity: reference }).status, "admitted");
  const before = snapshot(f.store);
  const first = f.store.requestDispatchedNodeRerunTargetStop({ recordId: f.record.id, sourceFence: f.target.fence, now: now() });
  assert.deepEqual(first, { status: "requested" });
  assert.equal(f.store.getRun(f.target.runId)?.status, "queued");
  assert.equal(f.store.getWorkUnit(f.target.fence.workUnitId)?.status, "cancelling");
  assert.equal(f.store.getWorkUnitAttempt(f.target.fence.attemptId)?.status, "cancelling");
  assert.ok(f.store.getWorkUnitAttempt(f.target.fence.attemptId)?.abortRequestedAt);
  const events = f.store.listRuntimeEvents(f.target.fence.workUnitId).filter(event => event.type === "work_unit_cancelling");
  assert.equal(events.length, 1);
  assert.deepEqual(f.store.requestDispatchedNodeRerunTargetStop({ recordId: f.record.id, sourceFence: f.target.fence, now: now() }),
    { status: "duplicate" });
  assert.equal(f.host.counts().held, 1);
  assert.equal(f.journal.getIntent(reference.intentId)?.dispatchedAt !== undefined, true);
  assert.notDeepEqual(snapshot(f.store), before);
  assert.deepEqual(f.store.requestDispatchedNodeRerunTargetStop({ recordId: f.record.id,
    sourceFence: { ...f.target.fence, fencingToken: "foreign" }, now: now() }),
    { status: "blocked", code: "node_rerun_target_changed" });
});

test("F5-08d HTTP stop returns requested, duplicate and recovery states without exposing ordinary cancellation", async t => {
  const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
  assert.equal(f.bridge.admitNodeRerunResources(f.input()).status, "admitted");
  const reference = { intentId: reserved.record.intent.intentId, dispatchToken: reserved.record.dispatchToken! };
  assert.equal(f.store.dispatchNodeRerunTarget({ recordId: f.record.id, now: now(), hostCapacity: reference }).status, "admitted");
  const admission = createRuntimeHostCapacityAdmission({ host: f.host, workspace: f.capacity.workspace });
  const supervisor = { getHostCapacityAdmission: () => admission };
  const registry = new RunStoreRegistry(() => f.store); registry.getStore(f.cwd);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture"), parts = url.pathname.split("/");
    void handleCancelNodeRerunTarget(request, response, url, 1_048_576, registry, f.activeRuns,
      parts[2]!, parts[5]!, supervisor);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = new URL(`http://127.0.0.1:${address.port}/runs/${encodeURIComponent(f.target.source.runId)}/node-rerun/intents/${encodeURIComponent(f.record.id)}/target/cancel`);
  url.searchParams.set("cwd", f.cwd);
  const active = new AbortController();
  f.activeRuns.add(f.target.runId, { abortController: active, streamEnvelope() {}, workUnitId: f.target.fence.workUnitId,
    attemptId: f.target.fence.attemptId, runtimeInstanceId: f.target.fence.runtimeInstanceId, fencingToken: f.target.fence.fencingToken });
  const post = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const first = await post(), firstBody = await first.json() as NodeRerunTargetStopResponseV1;
  assert.equal(first.status, 202, JSON.stringify(firstBody)); assert.equal(firstBody.stopStatus, "requested");
  assert.equal(active.signal.aborted, true); assert.equal(f.host.counts().held, 1);
  const duplicate = await post(), duplicateBody = await duplicate.json() as NodeRerunTargetStopResponseV1;
  assert.equal(duplicate.status, 202, JSON.stringify(duplicateBody)); assert.equal(duplicateBody.stopStatus, "already_requested");
  f.activeRuns.delete(f.target.runId);
  const recovery = await post(), recoveryBody = await recovery.json() as NodeRerunTargetStopResponseV1;
  assert.equal(recovery.status, 202, JSON.stringify(recoveryBody)); assert.equal(recoveryBody.stopStatus, "awaiting_recovery");
  assert.equal(f.host.counts().held, 1);
});

test("F5-08d HTTP recovery finalizes an already drained target after the daemon loses its live registry", async t => {
  const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
  assert.equal(f.bridge.admitNodeRerunResources(f.input()).status, "admitted");
  const reference = { intentId: reserved.record.intent.intentId, dispatchToken: reserved.record.dispatchToken! };
  assert.equal(f.store.dispatchNodeRerunTarget({ recordId: f.record.id, now: now(), hostCapacity: reference }).status, "admitted");
  const startedAt = now();
  f.store.markRunStarted(f.target.runId, startedAt);
  const db = database(f.store);
  db.prepare("UPDATE work_units SET status='running',started_at=?,last_heartbeat_at=? WHERE id=?")
    .run(startedAt, startedAt, f.target.fence.workUnitId);
  db.prepare("UPDATE work_unit_attempts SET status='started',started_at=?,last_heartbeat_at=? WHERE id=?")
    .run(startedAt, startedAt, f.target.fence.attemptId);
  const admission = createRuntimeHostCapacityAdmission({ host: f.host, workspace: f.capacity.workspace });
  const supervisor = { getHostCapacityAdmission: () => admission };
  const registry = new RunStoreRegistry(() => f.store); registry.getStore(f.cwd);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture"), parts = url.pathname.split("/");
    void handleCancelNodeRerunTarget(request, response, url, 1_048_576, registry, f.activeRuns,
      parts[2]!, parts[5]!, supervisor);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = new URL(`http://127.0.0.1:${address.port}/runs/${encodeURIComponent(f.target.source.runId)}/node-rerun/intents/${encodeURIComponent(f.record.id)}/target/cancel`);
  url.searchParams.set("cwd", f.cwd);
  const active = new AbortController();
  f.activeRuns.add(f.target.runId, { abortController: active, streamEnvelope() {}, workUnitId: f.target.fence.workUnitId,
    attemptId: f.target.fence.attemptId, runtimeInstanceId: f.target.fence.runtimeInstanceId, fencingToken: f.target.fence.fencingToken });
  const post = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const requested = await post(), requestedBody = await requested.json() as NodeRerunTargetStopResponseV1;
  assert.equal(requested.status, 202, JSON.stringify(requestedBody)); assert.equal(requestedBody.stopStatus, "requested");
  assert.equal(active.signal.aborted, true); assert.equal(f.host.counts().held, 1);

  // The next POST stands in for a new daemon process: the live registry is gone,
  // while the original Host has durably recorded its exact-fence completion.
  f.activeRuns.delete(f.target.runId);
  const registeredAt = now(), drainedAt = now();
  db.prepare(`INSERT INTO host_attempt_completions
    (attempt_id,schema_version,run_id,work_unit_id,runtime_instance_id,fencing_token,registered_at,drained_at,effect_coverage)
    VALUES (?,1,?,?,?,?,?,?,?)`).run(f.target.fence.attemptId, f.target.runId, f.target.fence.workUnitId,
      f.target.fence.runtimeInstanceId, f.target.fence.fencingToken, registeredAt, drainedAt, "pi_no_tools_v1");
  const recovered = await post(), recoveredBody = await recovered.json() as NodeRerunTargetStopResponseV1;
  assert.equal(recovered.status, 202, JSON.stringify(recoveredBody)); assert.equal(recoveredBody.stopStatus, "already_requested");
  assert.equal(f.store.getRun(f.target.runId)?.status, "cancelled");
  assert.equal(f.store.getWorkUnit(f.target.fence.workUnitId)?.status, "cancelled");
  assert.equal(f.store.getWorkUnitAttempt(f.target.fence.attemptId)?.status, "cancelled");
  assert.deepEqual(f.host.counts(), { held: 0, released: 1, total: 1 });
  assert.equal(f.journal.getRelease(reference.intentId)?.kind, "stopped");
});

test("F5-08d completes the stop only after durable Host drain and releases the dispatched capacity", async t => {
  const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
  assert.equal(f.bridge.admitNodeRerunResources(f.input()).status, "admitted");
  const reference = { intentId: reserved.record.intent.intentId, dispatchToken: reserved.record.dispatchToken! };
  assert.equal(f.store.dispatchNodeRerunTarget({ recordId: f.record.id, now: now(), hostCapacity: reference }).status, "admitted");
  const startedAt = now();
  f.store.markRunStarted(f.target.runId, startedAt);
  const db = database(f.store);
  db.prepare("UPDATE work_units SET status='running',started_at=?,last_heartbeat_at=? WHERE id=?")
    .run(startedAt, startedAt, f.target.fence.workUnitId);
  db.prepare("UPDATE work_unit_attempts SET status='started',started_at=?,last_heartbeat_at=? WHERE id=?")
    .run(startedAt, startedAt, f.target.fence.attemptId);
  assert.deepEqual(f.store.requestDispatchedNodeRerunTargetStop({ recordId: f.record.id,
    sourceFence: f.target.fence, now: now() }), { status: "requested" });
  const registeredAt = now(), drainedAt = now();
  db.prepare(`INSERT INTO host_attempt_completions
    (attempt_id,schema_version,run_id,work_unit_id,runtime_instance_id,fencing_token,registered_at,drained_at,effect_coverage)
    VALUES (?,1,?,?,?,?,?,?,?)`).run(f.target.fence.attemptId, f.target.runId, f.target.fence.workUnitId,
      f.target.fence.runtimeInstanceId, f.target.fence.fencingToken, registeredAt, drainedAt, "pi_no_tools_v1");
  const admission = createRuntimeHostCapacityAdmission({ host: f.host, workspace: f.capacity.workspace });
  const finalized = finalizeDispatchedNodeRerunTargetStop({ store: f.store, target: f.target, capacity: admission,
    capacityReference: reference, now: now() });
  assert.deepEqual(finalized, { status: "cancelled" });
  assert.equal(f.store.getRun(f.target.runId)?.status, "cancelled");
  assert.equal(f.store.getWorkUnit(f.target.fence.workUnitId)?.status, "cancelled");
  assert.equal(f.store.getWorkUnitAttempt(f.target.fence.attemptId)?.status, "cancelled");
  assert.deepEqual(f.host.counts(), { held: 0, released: 1, total: 1 });
  assert.equal(f.journal.getRelease(reference.intentId)?.kind, "stopped");
  assert.equal(finalizeDispatchedNodeRerunTargetStop({ store: f.store, target: f.target, capacity: admission,
    capacityReference: reference, now: now() }).status, "cancelled");
});

test("F5-08d keeps the exact owner and Host capacity when completion coverage is missing", async t => {
  const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
  assert.equal(f.bridge.admitNodeRerunResources(f.input()).status, "admitted");
  const reference = { intentId: reserved.record.intent.intentId, dispatchToken: reserved.record.dispatchToken! };
  assert.equal(f.store.dispatchNodeRerunTarget({ recordId: f.record.id, now: now(), hostCapacity: reference }).status, "admitted");
  assert.deepEqual(f.store.requestDispatchedNodeRerunTargetStop({ recordId: f.record.id,
    sourceFence: f.target.fence, now: now() }), { status: "requested" });
  const db = database(f.store), timestamp = now();
  db.prepare(`INSERT INTO host_attempt_completions
    (attempt_id,schema_version,run_id,work_unit_id,runtime_instance_id,fencing_token,registered_at)
    VALUES (?,1,?,?,?,?,?)`).run(f.target.fence.attemptId, f.target.runId, f.target.fence.workUnitId,
      f.target.fence.runtimeInstanceId, f.target.fence.fencingToken, timestamp);
  const admission = createRuntimeHostCapacityAdmission({ host: f.host, workspace: f.capacity.workspace });
  assert.deepEqual(finalizeDispatchedNodeRerunTargetStop({ store: f.store, target: f.target, capacity: admission,
    capacityReference: reference, now: now() }), { status: "awaiting_recovery", reason: "completion_unavailable" });
  assert.equal(f.store.getRun(f.target.runId)?.status, "queued");
  assert.equal(f.store.getWorkUnit(f.target.fence.workUnitId)?.status, "cancelling");
  assert.equal(f.host.counts().held, 1);
});

test("F5-08c5 resource drift leaves the target queued and the gate unconsumed", async t => {
  const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
  assert.equal(f.bridge.admitNodeRerunResources(f.input()).status, "admitted");
  database(f.store).prepare("DELETE FROM resource_leases WHERE attempt_id=?").run(f.target.fence.attemptId);
  const reference = { intentId: reserved.record.intent.intentId, dispatchToken: reserved.record.dispatchToken! };
  assert.deepEqual(f.store.dispatchNodeRerunTarget({ recordId: f.record.id, now: now(), hostCapacity: reference }), { status: "changed" });
  assert.equal(f.store.getTask(f.target.taskId)?.status, "todo");
  assert.equal(f.store.getWorkUnit(f.target.fence.workUnitId)?.status, "queued");
  assert.equal(f.journal.getIntent(reference.intentId)?.dispatchedAt, undefined);
  assert.equal(f.host.counts().held, 1);
});

test("F5-08c3 cancellation atomically revokes attached capacity and records its outbox before releasing the Host slot", async t => {
  const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
  const original = f.store.getRun(f.target.source.runId), id = reserved.record.intent.intentId;
  const cancel = () => f.store.cancelPreparedNodeRerunTarget({ recordId: f.record.id, sourceFence: f.target.fence,
    now: now(), observeLocalExecution: () => "absent" });
  const cancelled = cancel(); assert.equal(cancelled.status, "cancelled");
  const record = f.journal.getIntent(id)!; assert.ok(record.revokedAt); assert.equal(record.dispatchedAt, undefined);
  assert.equal(f.journal.getRelease(id)?.kind, "no_dispatch"); assert.equal(f.journal.getRelease(id)?.acknowledgedAt, undefined);
  assert.deepEqual(f.host.counts(), { held: 1, released: 0, total: 1 });
  assert.equal(f.store.getRun(f.target.runId)!.status, "cancelled"); assert.deepEqual(f.store.getRun(f.target.source.runId), original);
  assert.equal(f.bridge.flushRelease(id, now()), true);
  assert.deepEqual(f.host.counts(), { held: 0, released: 1, total: 1 }); assert.ok(f.journal.getRelease(id)?.acknowledgedAt);
  const before = snapshot(f.store);
  const duplicate = cancel(); assert.equal(duplicate.status, "duplicate");
  if (cancelled.status === "cancelled" && duplicate.status === "duplicate") assert.deepEqual(duplicate.cancellation, cancelled.cancellation);
  assert.equal(f.journal.prepareNoDispatchRelease({ intentId: id, now: now() }).status, "duplicate");
  assert.equal(f.bridge.flushRelease(id, now()), true); assert.deepEqual(snapshot(f.store), before);
  assert.deepEqual(f.bridge.reserveNodeRerunTarget(f.input()), { status: "changed" });
});

test("F5-08c3 requires fresh intent and consent before a released rerun capacity identity can be prepared", async t => {
  const f = await fixture(t), first = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(first.status === "reserved");
  const firstIntentId = first.record.intent.intentId, firstOwnerKey = first.record.intent.ownerKey;
  assert.equal(f.store.cancelPreparedNodeRerunTarget({ recordId: f.record.id, sourceFence: f.target.fence,
    now: now(), observeLocalExecution: () => "absent" }).status, "cancelled");
  assert.equal(f.bridge.flushRelease(firstIntentId, now()), true);
  assert.equal(f.bridge.reserveNodeRerunTarget(f.input()).status, "changed");

  const preparedIntent = { ...f.record.intent,
    intentId: "next-capacity-intent", idempotencyKey: "next-capacity-key" };
  const revalidate = (candidate: typeof preparedIntent) => observeNodeRerunAdmission({ store: f.store,
    activeRuns: f.activeRuns, intent: candidate, now: now() });
  const observation = revalidate(preparedIntent); assert.ok(observation.observed);
  const intent = preparedIntent;
  const plan = createNodeRerunHostAdmissionPlanV1({ intent, ...observation, observed: observation.observed });
  const next = f.store.prepareNodeRerunIntent({ request: { intent, planFingerprint: plan.planFingerprint }, now: now(), revalidate });
  assert.ok(next.status === "created");
  const approvedAt = now();
  const approval = f.store.requestNodeRerunApproval({ recordId: next.record.id, now: approvedAt,
    revalidate: candidate => observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent: candidate, now: approvedAt }) });
  assert.ok(approval.status === "created");
  f.store.approveApprovalRequest(approval.approval.id, { resolvedBy: "local-user", decisionKind: "approve_once" }, approvedAt);
  const nextTarget = f.store.prepareNodeRerunTarget({ recordId: next.record.id, runtimeInstanceId: f.runtime.runtimeInstanceId,
    now: approvedAt,
    revalidate: candidate => observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent: candidate, now: approvedAt }),
    prepareExecution: (source, taskId) => prepareNodeRerunTargetExecution(f.store, source,
      f.record.intent.source.attemptId, taskId) });
  assert.ok(nextTarget.status === "created");
  const second = f.bridge.reserveNodeRerunTarget({ ...f.input(), recordId: next.record.id, now: now() });
  assert.ok(second.status === "reserved");
  assert.notEqual(second.record.intent.intentId, firstIntentId);
  assert.notEqual(second.record.intent.ownerKey, firstOwnerKey);
});

test("F5-08c3 cancellation in every capacity handoff window allows only the original late receipt to be observed and released", async t => {
  for (const window of ["prepared", "host_reserved", "attached"] as const) await t.test(window, async t => {
    const f = await fixture(t), prepared = f.journal.prepareNodeRerunCapacity(f.input()); assert.ok(prepared.status === "prepared");
    const id = prepared.record.intent.intentId;
    if (window !== "prepared") assert.equal(f.host.reserve({ intent: prepared.record.intent, now: now() }).status, "reserved");
    if (window === "attached") assert.ok(f.bridge.observeReservation(id, now())?.reservation);
    const cancellation = f.store.cancelPreparedNodeRerunTarget({ recordId: f.record.id, sourceFence: f.target.fence,
      now: now(), observeLocalExecution: () => "absent" }); assert.equal(cancellation.status, "cancelled");
    if (window !== "attached") assert.equal(f.journal.getRelease(id), undefined);
    if (window === "prepared") assert.equal(f.host.reserve({ intent: prepared.record.intent, now: now() }).status, "reserved");
    f.supervisor.releaseAll(); f.store.close();
    const peer = f.openPeer(), admission = createRuntimeHostCapacityAdmission({ host: f.host,
      workspace: workspaceId => { assert.equal(workspaceId, f.target.workspaceId); return peer.journal; } });
    assert.deepEqual(recoverHostCapacityReservations({ store: peer.store, workspaceId: f.target.workspaceId, host: f.host,
      admission, now: now() }), { observed: 1, released: 1, unknown: 0 });
    assert.deepEqual(f.host.counts(), { held: 0, released: 1, total: 1 }); assert.ok(peer.journal.getRelease(id)?.acknowledgedAt);
    assert.deepEqual(recoverHostCapacityReservations({ store: peer.store, workspaceId: f.target.workspaceId, host: f.host,
      admission, now: now() }), { observed: 0, released: 0, unknown: 0 });
    assert.equal(peer.store.cancelPreparedNodeRerunTarget({ recordId: f.record.id, sourceFence: f.target.fence,
      now: now(), observeLocalExecution: () => assert.fail("duplicate cancellation uses its durable audit") }).status, "duplicate");
    assert.deepEqual(new RuntimeHostCapacityBridge(peer.journal, f.host).reserveNodeRerunTarget(f.input(peer.store)), { status: "changed" });
  });
});

test("F5-08c3 a logical terminal status, consumed gate, local lifetime or unrelated history never frees Host capacity", async t => {
  for (const state of ["terminal", "dispatched", "local", "unknown", "history", "foreign"] as const) await t.test(state, async t => {
    const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
    const db = database(f.store), id = reserved.record.intent.intentId;
    if (state === "terminal") db.prepare("UPDATE run_sessions SET status='cancelled',ended_at=? WHERE id=?").run(now(), f.target.runId);
    if (state === "dispatched") db.prepare("UPDATE runtime_host_capacity_intents SET dispatched_at=? WHERE intent_id=?").run(now(), id);
    if (state === "history") f.store.appendRuntimeEvent({ ...f.target.fence, type: "work_unit_started", actor: "runner", ts: now(), data: {} });
    if (state === "foreign") db.prepare("UPDATE runtime_host_capacity_intents SET authority_digest=? WHERE intent_id=?").run("c".repeat(64), id);
    const before = snapshot(f.store);
    const result = f.store.cancelPreparedNodeRerunTarget({ recordId: f.record.id, sourceFence: f.target.fence,
      now: now(), observeLocalExecution: () => state === "local" ? "present" : state === "unknown" ? "unknown" : "absent" });
    assert.equal(result.status, "blocked");
    assert.equal(f.journal.prepareNoDispatchRelease({ intentId: id, now: now() }).status, "changed");
    assert.deepEqual(snapshot(f.store), before); assert.deepEqual(f.host.counts(), { held: 1, released: 0, total: 1 });
  });
});

test("F5-08c3 corrupt cancellation audits and even rehashed foreign release evidence cannot release the original slot", async t => {
  for (const corruption of ["audit", "proof"] as const) await t.test(corruption, async t => {
    const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
    const db = database(f.store), id = reserved.record.intent.intentId;
    assert.equal(f.store.cancelPreparedNodeRerunTarget({ recordId: f.record.id, sourceFence: f.target.fence,
      now: now(), observeLocalExecution: () => "absent" }).status, "cancelled");
    if (corruption === "audit") db.prepare("UPDATE runtime_events SET data_json='{}' WHERE work_unit_id=? AND type='work_unit_cancelled'")
      .run(f.target.fence.workUnitId);
    else {
      const row = db.prepare("SELECT proof_json FROM runtime_host_capacity_releases WHERE intent_id=?").get(id)!;
      const proof = JSON.parse(String(row.proof_json)) as { evidence: { nodeRerunCancellation: { generationId: string } } };
      proof.evidence.nodeRerunCancellation.generationId = "foreign-generation";
      const serialized = JSON.stringify(proof), digest = createHash("sha256").update(serialized).digest("hex");
      db.prepare("UPDATE runtime_host_capacity_releases SET proof_json=?,proof_digest=? WHERE intent_id=?").run(serialized, digest, id);
    }
    const before = snapshot(f.store);
    assert.throws(() => f.bridge.flushRelease(id, now()), /receipt_corrupt|release_invalid/u);
    assert.throws(() => f.store.cancelPreparedNodeRerunTarget({ recordId: f.record.id, sourceFence: f.target.fence,
      now: now(), observeLocalExecution: () => "absent" }), /receipt_corrupt|release_invalid/u);
    assert.deepEqual(snapshot(f.store), before); assert.deepEqual(f.host.counts(), { held: 1, released: 0, total: 1 });
  });
});

test("F5-08c3 partial or malformed capacity receipts cannot be repaired by cancellation", async t => {
  for (const corruption of ["missing-token", "hidden-token", "revoked-type", "future-created"] as const) await t.test(corruption, async t => {
    const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
    const db = database(f.store), id = reserved.record.intent.intentId;
    db.exec("PRAGMA ignore_check_constraints=ON");
    if (corruption === "missing-token") db.prepare("UPDATE runtime_host_capacity_intents SET reservation_token=NULL WHERE intent_id=?").run(id);
    if (corruption === "hidden-token") db.prepare("UPDATE runtime_host_capacity_intents SET reservation_id=NULL WHERE intent_id=?").run(id);
    if (corruption === "revoked-type") db.prepare("UPDATE runtime_host_capacity_intents SET revoked_at=7 WHERE intent_id=?").run(id);
    if (corruption === "future-created") db.prepare("UPDATE runtime_host_capacity_intents SET created_at='2027-03-15T00:00:00.000Z' WHERE intent_id=?").run(id);
    db.exec("PRAGMA ignore_check_constraints=OFF");
    const before = snapshot(f.store);
    if (corruption === "future-created") assert.throws(() => f.store.cancelPreparedNodeRerunTarget({ recordId: f.record.id, sourceFence: f.target.fence,
      now: now(), observeLocalExecution: () => "absent" }), /intent_invalid/u);
    else assert.equal(f.store.cancelPreparedNodeRerunTarget({ recordId: f.record.id, sourceFence: f.target.fence,
      now: now(), observeLocalExecution: () => "absent" }).status, "blocked");
    assert.deepEqual(snapshot(f.store), before); assert.deepEqual(f.host.counts(), { held: 1, released: 0, total: 1 });
  });
});

test("F5-08c3 failed or ignored revocation, outbox, target-release and COMMIT writes roll back cancellation with capacity", async t => {
  for (const fault of ["revoke", "outbox-ignore", "outbox-abort", "target-release", "commit"] as const) await t.test(fault, async t => {
    const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
    const db = database(f.store), id = reserved.record.intent.intentId;
    if (fault === "revoke") db.exec("CREATE TRIGGER cancel_capacity_fault BEFORE UPDATE OF revoked_at ON runtime_host_capacity_intents BEGIN SELECT RAISE(IGNORE); END");
    if (fault.startsWith("outbox")) db.exec(`CREATE TRIGGER cancel_capacity_fault BEFORE INSERT ON runtime_host_capacity_releases
      BEGIN SELECT RAISE(${fault === "outbox-ignore" ? "IGNORE" : "ABORT,'outbox fault'"}); END`);
    if (fault === "target-release") db.exec("CREATE TRIGGER cancel_capacity_fault BEFORE UPDATE OF released_at ON node_rerun_targets BEGIN SELECT RAISE(IGNORE); END");
    const before = snapshot(f.store), exec = db.exec.bind(db);
    const mock = fault === "commit" ? t.mock.method(db, "exec", (sql: string) => {
      if (sql === "COMMIT") throw new Error("cancel capacity commit fault"); return exec(sql);
    }) : undefined;
    try { assert.throws(() => f.store.cancelPreparedNodeRerunTarget({ recordId: f.record.id, sourceFence: f.target.fence,
      now: now(), observeLocalExecution: () => "absent" }), /unverified|release_receipt_missing|outbox fault|commit fault/u); }
    finally { mock?.mock.restore(); }
    assert.deepEqual(snapshot(f.store), before); assert.equal(db.isTransaction, false);
    assert.equal(f.journal.getIntent(id)!.revokedAt, undefined); assert.equal(f.journal.getRelease(id), undefined);
    assert.deepEqual(f.host.counts(), { held: 1, released: 0, total: 1 });
    if (fault !== "commit") db.exec("DROP TRIGGER cancel_capacity_fault");
    assert.equal(f.store.cancelPreparedNodeRerunTarget({ recordId: f.record.id, sourceFence: f.target.fence,
      now: now(), observeLocalExecution: () => "absent" }).status, "cancelled");
  });
});

test("F5-08c3 Host release and ACK interruptions retain the committed cancellation and recover the same outbox", async t => {
  for (const interruption of ["host", "ack"] as const) await t.test(interruption, async t => {
    const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
    const id = reserved.record.intent.intentId;
    assert.equal(f.store.cancelPreparedNodeRerunTarget({ recordId: f.record.id, sourceFence: f.target.fence,
      now: now(), observeLocalExecution: () => "absent" }).status, "cancelled");
    if (interruption === "host") {
      const mock = t.mock.method(f.host, "release", () => { throw new Error("Host release interrupted"); });
      try { assert.throws(() => f.bridge.flushRelease(id, now()), /Host release interrupted/u); }
      finally { mock.mock.restore(); }
      assert.equal(f.host.counts().held, 1);
    } else {
      const bridge = new RuntimeHostCapacityBridge({ ...f.journal, acknowledgeRelease: () => false }, f.host);
      assert.equal(bridge.flushRelease(id, now()), false); assert.equal(f.host.counts().held, 0);
    }
    assert.equal(f.journal.getRelease(id)?.acknowledgedAt, undefined);
    assert.equal(f.store.getRun(f.target.runId)!.status, "cancelled");
    assert.equal(f.bridge.flushRelease(id, now()), true); assert.ok(f.journal.getRelease(id)?.acknowledgedAt);
    assert.deepEqual(f.host.counts(), { held: 0, released: 1, total: 1 });
  });
});

test("F5-08c3 HTTP cancellation flushes only its own outbox and stays successful when Host release is interrupted", async t => {
  for (const interrupted of [false, true]) await t.test(interrupted ? "interrupted" : "released", async t => {
    const f = await fixture(t), reserved = f.bridge.reserveNodeRerunTarget(f.input()); assert.ok(reserved.status === "reserved");
    const admission = createRuntimeHostCapacityAdmission({ host: f.host, workspace: f.capacity.workspace });
    const supervisor = { getHostCapacityAdmission: () => admission };
    const registry = new RunStoreRegistry(() => f.store); registry.getStore(f.cwd);
    const server = createServer((request, response) => {
      void handleCancelNodeRerunTarget(request, response, new URL(request.url!, "http://127.0.0.1"), 1_048_576,
        registry, f.activeRuns, f.target.source.runId, f.record.id, supervisor);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const mock = interrupted ? t.mock.method(f.host, "release", () => { throw new Error("Host unavailable"); }) : undefined;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/cancel?cwd=${encodeURIComponent(f.cwd)}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(response.status, 200, await response.text());
    } finally { mock?.mock.restore(); }
    assert.equal(f.store.getRun(f.target.runId)!.status, "cancelled");
    assert.equal(f.host.counts().held, interrupted ? 1 : 0);
    assert.equal(admission.releaseNodeRerunNoDispatch?.({ workspaceId: f.target.workspaceId, recordId: f.record.id, now: now() }), true);
    assert.equal(f.host.counts().held, 0);
  });
});
