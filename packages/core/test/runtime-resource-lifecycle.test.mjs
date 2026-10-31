import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_WORKSPACE_ID, createSqliteRunStore, resolveStoragePaths, toRuntimeAttemptFence } from "../dist/index.js";

const START = "2026-10-16T01:00:00.000Z";
const HOUR = 60 * 60 * 1000;
const at = hours => new Date(Date.parse(START) + hours * HOUR).toISOString();
const renewal = (renewedAt, expiresAt = new Date(Date.parse(renewedAt) + 6 * HOUR).toISOString()) => ({ renewedAt, expiresAt });

/** Two real connections to one owned SQLite file; no app HOME, network, Provider or Runner. */
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "ling-b011-resources-")));
  const stores = [];
  t.after(async () => {
    for (const store of stores.reverse()) if (store.database.isOpen) store.close();
    assert.ok(directory.startsWith(`${await fs.realpath(os.tmpdir())}/ling-b011-resources-`));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const cwd = join(directory, "workspace");
  await fs.mkdir(cwd);
  const paths = resolveStoragePaths(cwd, {
    homeDir: join(directory, "home"), env: {}, workspaceStateLocation: "repo-local",
  }).workspace;
  assert.ok(paths.databasePath.startsWith(`${directory}/`));
  const open = () => { const store = createSqliteRunStore(cwd, paths); stores.push(store); return store; };
  // Open the peer before business rows exist: constructor recovery is not a test clock.
  const store = open(), peer = open();
  assert.notEqual(store.database, peer.database);
  assert.equal(store.paths.databasePath, peer.paths.databasePath);
  return { cwd, store, peer };
}

/** Materialize a real current Attempt without dispatching any actual execution. */
function owner(store, name, status = "started") {
  const unit = store.createWorkUnit({
    id: `b011_unit_${name}`, workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "task",
    ownerId: `b011_task_${name}`, idempotencyKey: `b011_owner_${name}`, createdByActor: "system",
    status: "running", request: { prompt: "B011 owned SQLite fixture; never dispatch." }, now: START,
  });
  const attempt = store.createWorkUnitAttempt({
    id: `b011_attempt_${name}`, workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: `b011_runtime_${name}`, runnerId: "runner_pi_embedded", status, now: START,
  });
  assert.equal(store.getWorkUnit(unit.id).activeAttemptId, attempt.id);
  return { unit, attempt, fence: toRuntimeAttemptFence(attempt) };
}

function leaseInput(current, key = "b011_shared", acquiredAt = START, expiresAt = at(6)) {
  return { ...current.fence, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "provider", resourceKey: key,
    ownerType: "work_unit_attempt", ownerId: current.attempt.id, acquiredAt, expiresAt };
}

function slotInput(current, key = "b011_shared", acquiredAt = START, expiresAt = at(6)) {
  return { ...leaseInput(current, key, acquiredAt, expiresAt), limit: 1 };
}

function hold(store, current, key = "b011_shared", expiresAt = at(6), acquiredAt = START) {
  const lease = store.acquireResourceLease(leaseInput(current, key, acquiredAt, expiresAt));
  const slot = store.acquireRuntimeSemaphoreSlot(slotInput(current, key, acquiredAt, expiresAt));
  assert.ok(lease, "the test must really acquire the exclusive lease");
  assert.ok(slot, "the test must really occupy the provider slot");
  return { lease, slot };
}

function heartbeat(store, current, ts, resourceExpiresAt = at((Date.parse(ts) - Date.parse(START)) / HOUR + 6)) {
  return store.recordRuntimeHeartbeat({ ...current.fence, ts, resourceExpiresAt, source: "supervisor" });
}

/** Read persisted rows, not mocked DTO counters or projected UI status. */
function rows(store) {
  return Object.fromEntries(["work_units", "work_unit_attempts", "runtime_heartbeats", "resource_leases", "runtime_semaphore_slots"]
    .map(table => [table, store.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

function heldRows(store, held) {
  return {
    lease: store.database.prepare("SELECT * FROM resource_leases WHERE id=?").get(held.lease.id),
    slot: store.database.prepare("SELECT * FROM runtime_semaphore_slots WHERE id=?").get(held.slot.id),
  };
}

function assertActive(store, held, expiresAt, lastRenewedAt) {
  const persisted = heldRows(store, held);
  for (const row of [persisted.lease, persisted.slot]) {
    assert.equal(row.status, "active");
    if (expiresAt !== undefined) assert.equal(row.expires_at, expiresAt);
    if (lastRenewedAt !== undefined) assert.equal(row.last_renewed_at, lastRenewedAt);
  }
}

function terminate(store, current, status, endedAt = at(5)) {
  const updated = store.updateWorkUnitAttemptStatus({ ...current.fence, status, now: at(5), endedAt });
  assert.ok(updated);
  assert.equal(updated.status, status);
  return updated;
}

test("B011 heartbeat slides real lease and slot deadlines through approval-wait lifecycles beyond six wall hours", async t => {
  const f = await fixture(t), current = owner(f.store, "sliding"), rival = owner(f.peer, "sliding_rival");
  const held = hold(f.store, current);
  for (const [hour, status] of [[1, "waiting_for_approval"], [3, "started"], [5, "waiting_for_approval"], [7, "started"], [9, "waiting_for_approval"]]) {
    assert.ok(f.store.updateWorkUnitAttemptStatus({ ...current.fence, status, now: at(hour) }));
    heartbeat(f.store, current, at(hour), at(hour + 6));
    assertActive(f.peer, held, at(hour + 6), at(hour));
    assert.equal(f.peer.getWorkUnitAttempt(current.attempt.id).lastHeartbeatAt, at(hour));
    assert.equal(f.peer.expireResourceLeases(at(hour + 0.1)), 0);
    assert.equal(f.peer.expireRuntimeSemaphoreSlots(at(hour + 0.1)), 0);
    assert.equal(f.peer.acquireResourceLease(leaseInput(rival, "b011_shared", at(hour + 0.1), at(hour + 6.1))), undefined);
    assert.equal(f.peer.acquireRuntimeSemaphoreSlot(slotInput(rival, "b011_shared", at(hour + 0.1), at(hour + 6.1))), undefined);
  }
  const persisted = heldRows(f.peer, held);
  assert.equal(persisted.lease.acquired_at, START, "renewal is not a new acquisition");
  assert.equal(persisted.slot.acquired_at, START);
  assert.equal(f.peer.database.prepare("SELECT COUNT(*) AS count FROM runtime_heartbeats WHERE attempt_id=?").get(current.attempt.id).count, 5);
  // Core-only controlled lifecycle; this test does not claim an actual UI approval interaction.
});

test("B011 direct renew uses the explicit bounded deadline and never derives a growing duration from row history", async t => {
  const f = await fixture(t), current = owner(f.store, "explicit_renew"), held = hold(f.store, current, "b011_short", at(0.25));
  for (const hour of [0.1, 0.2, 0.3]) {
    const value = renewal(at(hour), at(hour + 0.25));
    assert.equal(f.store.renewResourceLeasesForAttempt(current.fence, value), 1);
    assert.equal(f.store.renewRuntimeSemaphoreSlotsForAttempt(current.fence, value), 1);
    assertActive(f.peer, held, value.expiresAt, value.renewedAt);
  }
});

test("B011 older valid renewal and heartbeat cannot move resource timestamps or deadlines backwards", async t => {
  const f = await fixture(t), current = owner(f.store, "monotonic"), held = hold(f.store, current);
  heartbeat(f.store, current, at(2), at(8));
  const before = heldRows(f.peer, held), older = renewal(at(1), at(7));
  f.store.renewResourceLeasesForAttempt(current.fence, older);
  f.store.renewRuntimeSemaphoreSlotsForAttempt(current.fence, older);
  assert.deepEqual(heldRows(f.peer, held), before);
  heartbeat(f.store, current, at(1.5), at(7.5));
  assert.deepEqual(heldRows(f.peer, held), before);
});

for (const status of ["created", "started", "waiting_for_approval", "cancelling"]) {
  test(`B011 TTL alone cannot free a current ${status} Attempt with a stale heartbeat`, async t => {
    const f = await fixture(t), current = owner(f.store, `current_${status}`, status), rival = owner(f.peer, `rival_${status}`);
    const held = hold(f.store, current);
    heartbeat(f.store, current, at(0.01), at(6.01));
    assert.equal(f.peer.expireResourceLeases(at(20)), 0);
    assert.equal(f.peer.expireRuntimeSemaphoreSlots(at(20)), 0);
    assertActive(f.peer, held, at(6.01), at(0.01));
    assert.equal(f.peer.acquireResourceLease(leaseInput(rival, "b011_shared", at(20), at(26))), undefined);
    assert.equal(f.peer.acquireRuntimeSemaphoreSlot(slotInput(rival, "b011_shared", at(20), at(26))), undefined);
    assert.equal(f.peer.getWorkUnitAttempt(current.attempt.id).status, status, "expiry must not invent a lost transition");
  });
}

for (const status of ["succeeded", "failed", "cancelled", "lost", "yielded"]) {
  test(`B011 direct renew rejects current terminal ${status} and expiry reuses only its exact ended ownership`, async t => {
    const f = await fixture(t), current = owner(f.store, `ended_${status}`), rival = owner(f.peer, `ended_rival_${status}`);
    const held = hold(f.store, current);
    terminate(f.store, current, status);
    const before = rows(f.peer);
    assert.equal(f.store.renewResourceLeasesForAttempt(current.fence, renewal(at(5.5))), 0);
    assert.equal(f.store.renewRuntimeSemaphoreSlotsForAttempt(current.fence, renewal(at(5.5))), 0);
    assert.throws(() => heartbeat(f.store, current, at(5.5)), /[Ss]tale|[Tt]erminal/u);
    assert.deepEqual(rows(f.peer), before);
    assert.equal(f.peer.expireResourceLeases(at(7)), 1);
    assert.equal(f.peer.expireRuntimeSemaphoreSlots(at(7)), 1);
    const afterExpiry = heldRows(f.peer, held);
    assert.equal(afterExpiry.lease.status, "expired");
    assert.equal(afterExpiry.slot.status, "expired");
    assert.equal(afterExpiry.lease.released_at, at(7));
    assert.equal(afterExpiry.slot.released_at, at(7));
    assert.ok(f.peer.acquireResourceLease(leaseInput(rival, "b011_shared", at(7), at(13))));
    assert.ok(f.peer.acquireRuntimeSemaphoreSlot(slotInput(rival, "b011_shared", at(7), at(13))));
  });
}

const unknownOwnership = [
  ["missing Attempt", "UPDATE work_unit_attempts SET id='b011_missing_attempt' WHERE id=?"],
  ["missing WorkUnit", "UPDATE work_units SET id='b011_missing_unit' WHERE id=?"],
  ["mismatched token", "UPDATE work_unit_attempts SET fencing_token='999999' WHERE id=?"],
  ["mismatched runtime", "UPDATE work_unit_attempts SET runtime_instance_id='b011_foreign_runtime' WHERE id=?"],
  ["mismatched workspace", "UPDATE work_units SET workspace_id='b011_foreign_workspace' WHERE id=?"],
  ["terminal without endedAt", "UPDATE work_unit_attempts SET ended_at=NULL WHERE id=?"],
];

for (const [label, corrupt] of unknownOwnership) {
  test(`B011 expiry keeps an overdue reservation active when ownership is ${label}`, async t => {
    const f = await fixture(t), current = owner(f.store, "unknown"), held = hold(f.store, current);
    terminate(f.store, current, "lost");
    // Intentionally damaged owned fixture: absence/mismatch is not positive revocation evidence.
    // Disable FK enforcement only while constructing impossible/corrupt historical rows;
    // otherwise missing-parent cases would fail in setup instead of reaching expiry.
    const targetsUnit = corrupt.startsWith("UPDATE work_units ");
    f.store.database.exec("PRAGMA foreign_keys=OFF");
    try { f.store.database.prepare(corrupt).run(targetsUnit ? current.unit.id : current.attempt.id); }
    finally { f.store.database.exec("PRAGMA foreign_keys=ON"); }
    const before = heldRows(f.peer, held);
    assert.equal(f.peer.expireResourceLeases(at(7)), 0);
    assert.equal(f.peer.expireRuntimeSemaphoreSlots(at(7)), 0);
    assert.deepEqual(heldRows(f.peer, held), before);
    assertActive(f.peer, held, at(6), START);
  });
}

for (const status of ["released", "expired"]) {
  test(`B011 neither direct renew nor heartbeat resurrects a ${status} resource row`, async t => {
    const f = await fixture(t), current = owner(f.store, `closed_${status}`), held = hold(f.store, current);
    if (status === "released") {
      assert.equal(f.store.releaseResourceLeasesForAttempt(current.fence, at(1), "b011-explicit-close"), 1);
      assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(current.fence, at(1), "b011-explicit-close"), 1);
    } else {
      // Represents an already-expired historical row, not a claim that new expiry may revoke current ownership.
      for (const [table, id] of [["resource_leases", held.lease.id], ["runtime_semaphore_slots", held.slot.id]]) {
        f.store.database.prepare(`UPDATE ${table} SET status='expired',released_at=?,release_reason='b011-legacy-expired-fixture' WHERE id=?`)
          .run(at(1), id);
      }
    }
    const before = heldRows(f.peer, held);
    assert.equal(f.store.renewResourceLeasesForAttempt(current.fence, renewal(at(2))), 0);
    assert.equal(f.store.renewRuntimeSemaphoreSlotsForAttempt(current.fence, renewal(at(2))), 0);
    heartbeat(f.store, current, at(2));
    assert.deepEqual(heldRows(f.peer, held), before);
    assert.equal(f.peer.getWorkUnitAttempt(current.attempt.id).lastHeartbeatAt, at(2), "a valid heartbeat must not recreate released resources");
  });
}

test("B011 a replaced Attempt cannot renew, heartbeat, or release its successor's reservations", async t => {
  const f = await fixture(t), first = owner(f.store, "replacement");
  const priorHeld = hold(f.store, first);
  const attempt = f.peer.createWorkUnitAttempt({ workUnitId: first.unit.id, attemptNumber: 2,
    runtimeInstanceId: "b011_successor", runnerId: "runner_pi_embedded", status: "started", now: at(1) });
  const successor = { unit: first.unit, attempt, fence: toRuntimeAttemptFence(attempt) };
  assert.equal(f.store.getWorkUnitAttempt(first.attempt.id).status, "lost");
  assert.equal(heldRows(f.store, priorHeld).lease.status, "released");
  assert.equal(heldRows(f.store, priorHeld).slot.status, "released");
  const nextHeld = hold(f.peer, successor, "b011_shared", at(7), at(1));
  heartbeat(f.peer, successor, at(2), at(8));
  const before = rows(f.peer);
  assert.throws(() => heartbeat(f.store, first, at(3), at(9)), /[Ss]tale/u);
  assert.equal(f.store.renewResourceLeasesForAttempt(first.fence, renewal(at(3))), 0);
  assert.equal(f.store.renewRuntimeSemaphoreSlotsForAttempt(first.fence, renewal(at(3))), 0);
  assert.equal(f.store.releaseResourceLeasesForAttempt(first.fence, at(3), "b011-late-old-release"), 0);
  assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(first.fence, at(3), "b011-late-old-release"), 0);
  assert.deepEqual(rows(f.peer), before);
  assert.equal(f.store.expireResourceLeases(at(20)), 0);
  assert.equal(f.store.expireRuntimeSemaphoreSlots(at(20)), 0);
  assertActive(f.store, nextHeld, at(8), at(2));
});

for (const order of ["heartbeat-first", "acquire-first"]) {
  test(`B011 real two-connection ${order} ordering cannot reclaim a still-current owner's capacity`, async t => {
    const f = await fixture(t), current = owner(f.store, `ordered_${order}`), rival = owner(f.peer, `ordered_rival_${order}`);
    const held = hold(f.store, current);
    const attemptAcquire = () => {
      assert.equal(f.peer.acquireRuntimeSemaphoreSlot(slotInput(rival, "b011_shared", at(7), at(13))), undefined);
      assert.equal(f.peer.expireResourceLeases(at(7)), 0);
      assert.equal(f.peer.acquireResourceLease(leaseInput(rival, "b011_shared", at(7), at(13))), undefined);
    };
    if (order === "acquire-first") attemptAcquire();
    heartbeat(f.store, current, at(7), at(13));
    attemptAcquire();
    assertActive(f.peer, held, at(13), at(7));
    assert.equal(f.peer.listRuntimeSemaphoreSlots({ status: "active", resourceType: "provider", resourceKey: "b011_shared" }).length, 1);
    assert.equal(f.peer.getBlockingResourceLease("provider", "b011_shared").id, held.lease.id);
    // Actual committed SQLite order on distinct connections; not a simultaneous-writer stress claim.
  });
}

for (const table of ["resource_leases", "runtime_semaphore_slots"]) {
  test(`B011 ${table} trigger failure rolls back the whole heartbeat, both renewals and canonical heartbeat rows`, async t => {
    const f = await fixture(t), current = owner(f.store, `rollback_${table}`), held = hold(f.store, current);
    const before = rows(f.peer);
    f.store.database.exec(`CREATE TRIGGER b011_fail_renewal AFTER UPDATE ON ${table}
      WHEN NEW.last_renewed_at<>OLD.last_renewed_at
      BEGIN SELECT RAISE(ABORT, 'B011 owned renewal fault'); END`);
    assert.throws(() => heartbeat(f.store, current, at(1), at(7)), /B011 owned renewal fault/u);
    assert.equal(f.store.database.isTransaction, false);
    assert.deepEqual(rows(f.store), before);
    assert.deepEqual(rows(f.peer), before);
    assertActive(f.peer, held, at(6), START);
    f.store.database.exec("DROP TRIGGER b011_fail_renewal");
    heartbeat(f.store, current, at(1), at(7));
    assertActive(f.peer, held, at(7), at(1));
    assert.equal(f.peer.database.prepare("SELECT COUNT(*) AS count FROM runtime_heartbeats WHERE attempt_id=?").get(current.attempt.id).count, 1);
  });
}

const invalidHeartbeats = [
  ["missing deadline", { ts: at(1) }],
  ["malformed heartbeat time", { ts: "not-a-time", resourceExpiresAt: at(7) }],
  ["noncanonical heartbeat time", { ts: "2026-10-16T02:00:00Z", resourceExpiresAt: at(7) }],
  ["malformed deadline", { ts: at(1), resourceExpiresAt: "not-a-time" }],
  ["noncanonical deadline", { ts: at(1), resourceExpiresAt: "2026-10-16T08:00:00Z" }],
  ["equal deadline", { ts: at(1), resourceExpiresAt: at(1) }],
  ["past deadline", { ts: at(1), resourceExpiresAt: at(0) }],
  ["deadline above six-hour window", { ts: at(1), resourceExpiresAt: new Date(Date.parse(at(7)) + 1).toISOString() }],
];

for (const [label, value] of invalidHeartbeats) {
  test(`B011 ${label} is rejected without any heartbeat or resource half-write`, async t => {
    const f = await fixture(t), current = owner(f.store, "invalid_heartbeat");
    hold(f.store, current);
    const before = rows(f.peer);
    assert.throws(() => f.store.recordRuntimeHeartbeat({ ...current.fence, source: "supervisor", ...value }));
    assert.equal(f.store.database.isTransaction, false);
    assert.deepEqual(rows(f.store), before);
    assert.deepEqual(rows(f.peer), before);
  });
}

for (const method of ["renewResourceLeasesForAttempt", "renewRuntimeSemaphoreSlotsForAttempt"]) {
  test(`B011 ${method} rejects the old string interface and malformed or unbounded renewal objects`, async t => {
    const f = await fixture(t), current = owner(f.store, "invalid_direct");
    hold(f.store, current);
    const before = rows(f.peer);
    for (const value of [at(1), undefined, null,
      { renewedAt: at(1) }, { expiresAt: at(7) },
      { renewedAt: "not-a-time", expiresAt: at(7) },
      { renewedAt: "2026-10-16T02:00:00Z", expiresAt: at(7) },
      renewal(at(1), "not-a-time"), renewal(at(1), "2026-10-16T08:00:00Z"),
      renewal(at(1), at(1)), renewal(at(1), at(0)),
      renewal(at(1), new Date(Date.parse(at(7)) + 1).toISOString())]) {
      assert.throws(() => f.store[method](current.fence, value));
      assert.deepEqual(rows(f.peer), before);
    }
  });
}

for (const ownerType of ["workflow_step", "system"]) {
  test(`B011 ownerless ${ownerType} lease preserves its original TTL and can then be acquired by a new owner`, async t => {
    const f = await fixture(t), input = { workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "workflow_step",
      resourceKey: "b011_owner_level", ownerType, ownerId: "b011_old_owner", acquiredAt: START, expiresAt: at(1) };
    const lease = f.store.acquireResourceLease(input);
    assert.ok(lease);
    assert.equal(f.peer.expireResourceLeases(at(2)), 1);
    const row = f.peer.database.prepare("SELECT * FROM resource_leases WHERE id=?").get(lease.id);
    assert.equal(row.status, "expired");
    for (const key of ["work_unit_id", "attempt_id", "runtime_instance_id", "fencing_token"]) assert.equal(row[key], null);
    assert.ok(f.peer.acquireResourceLease({ ...input, ownerId: "b011_next_owner", acquiredAt: at(2), expiresAt: at(3) }));
  });
}

test("B011 a partially attributed owner-level lease is not an ownerless TTL exemption", async t => {
  const f = await fixture(t);
  const lease = f.store.acquireResourceLease({ workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "workflow_step",
    resourceKey: "b011_partial_owner_level", ownerType: "system", ownerId: "b011_partial_owner", acquiredAt: START, expiresAt: at(1) });
  assert.ok(lease);
  f.store.database.prepare("UPDATE resource_leases SET attempt_id='b011_unknown_attempt' WHERE id=?").run(lease.id);
  const before = f.peer.database.prepare("SELECT * FROM resource_leases WHERE id=?").get(lease.id);
  assert.equal(f.peer.expireResourceLeases(at(2)), 0);
  assert.deepEqual(f.peer.database.prepare("SELECT * FROM resource_leases WHERE id=?").get(lease.id), before);
});

test("B011 a system-labelled slot without an exact Attempt is never an ownerless TTL exemption", async t => {
  const f = await fixture(t), current = owner(f.store, "system_slot");
  const held = hold(f.store, current);
  // Corrupt historical attribution is deliberately built only inside this owned database.
  f.store.database.exec("PRAGMA foreign_keys=OFF");
  try {
    f.store.database.prepare("UPDATE runtime_semaphore_slots SET owner_type='system',owner_id='b011_system',attempt_id='b011_unknown_attempt' WHERE id=?")
      .run(held.slot.id);
  } finally { f.store.database.exec("PRAGMA foreign_keys=ON"); }
  const before = heldRows(f.peer, held);
  assert.equal(f.peer.expireRuntimeSemaphoreSlots(at(7)), 0);
  assert.deepEqual(heldRows(f.peer, held), before);
});
