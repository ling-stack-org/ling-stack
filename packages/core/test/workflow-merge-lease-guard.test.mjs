import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteResourceLeaseStore } from "../dist/storage/sqlite/resource-lease-store.js";
import { hasActiveWorkflowMergeApplyLease, workflowMergeApplyWorkspaceBusy }
  from "../dist/storage/sqlite/workflow-merge-lease-guard.js";
import { b013PermitFixture } from "./support/b013-permit-lifecycle-fixture.mjs";
import { workflowAdmissionFixture, workflowResumeAdmissionFixture, workflowUserInputAdmissionFixture }
  from "./support/workflow-step-admission-fixture.mjs";

const workspace = "guard-workspace";
const at = tick => new Date(Date.parse("2026-11-02T00:00:00.000Z") + tick * 1_000).toISOString();
const leaseInput = (overrides = {}) => ({ workspaceId: workspace, resourceType: "bound_path", resourceKey: "/guard/target",
  ownerType: "system", ownerId: "guard-permit", acquiredAt: at(0), expiresAt: at(1), ...overrides });
const noWrites = (f, action) => { const before = f.snapshot(); const result = action(); assert.deepEqual(f.snapshot(), before); return result; };
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();

// Deliberately only the guard's relational projection, not an issued apply permit or a migration208 fixture.
function projectedPermits(db) {
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_merge_apply_permits'").get();
  if (existing) {
    assert.equal(rows(db, "workflow_merge_apply_permits").length, 0);
    db.exec("DROP TABLE workflow_merge_apply_permits");
  }
  db.exec(`CREATE TABLE workflow_merge_apply_permits (
    permit_id TEXT PRIMARY KEY,lease_id TEXT UNIQUE REFERENCES resource_leases(id),
    round_id TEXT,generation INTEGER,created_at TEXT,expires_at TEXT
  )`);
}

function referenceLease(db, lease, { roundId = "guard-round", permitId = lease.ownerId } = {}) {
  db.prepare(`INSERT INTO workflow_merge_apply_permits(permit_id,lease_id,round_id,generation,created_at,expires_at)
    VALUES(?,?,?,1,?,?)`).run(permitId, lease.id, roundId, lease.acquiredAt, lease.expiresAt);
}

async function rawFixture(t, { overlay = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "ling-merge-lease-guard-")));
  const path = join(root, "guard.sqlite"), opened = new Set();
  function open() {
    const db = new DatabaseSync(path);
    opened.add(db);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1");
    return db;
  }
  t.after(async () => {
    for (const db of opened) if (db.isOpen) db.close();
    assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-merge-lease-guard-`));
    await fs.rm(root, { recursive: true, force: true });
  });
  const f = { db: open(), peer: open() };
  f.db.exec(`CREATE TABLE resource_leases (
    id TEXT PRIMARY KEY,workspace_id TEXT,resource_type TEXT,resource_key TEXT,owner_type TEXT,owner_id TEXT,status TEXT,
    acquired_at TEXT,expires_at TEXT,last_renewed_at TEXT,released_at TEXT,release_reason TEXT,
    work_unit_id TEXT,attempt_id TEXT,runtime_instance_id TEXT,fencing_token TEXT
  );
  CREATE UNIQUE INDEX active_resource ON resource_leases(workspace_id,resource_type,resource_key) WHERE status='active';
  CREATE TABLE work_units(id TEXT PRIMARY KEY,workspace_id TEXT,active_attempt_id TEXT);
  CREATE TABLE work_unit_attempts(id TEXT PRIMARY KEY,work_unit_id TEXT,runtime_instance_id TEXT,fencing_token TEXT,status TEXT,ended_at TEXT);
  CREATE TABLE workflow_integration_generations(round_id TEXT,generation INTEGER,inputs_json TEXT,PRIMARY KEY(round_id,generation));
  CREATE TABLE workflow_step_admissions(workspace_id TEXT,status TEXT);
  CREATE TABLE runtime_semaphore_slots(workspace_id TEXT,status TEXT);`);
  if (overlay) projectedPermits(f.db);
  f.store = new SqliteResourceLeaseStore({ database: f.db });
  f.peerStore = new SqliteResourceLeaseStore({ database: f.peer });
  f.seed = (input = leaseInput()) => {
    const lease = f.store.acquireResourceLease(input); assert.ok(lease);
    f.db.prepare("INSERT INTO workflow_integration_generations VALUES('guard-round',1,?)")
      .run(JSON.stringify({ canonicalWorkspaceId: lease.workspaceId, target: { executionRoot: lease.resourceKey } }));
    referenceLease(f.db, lease);
    return lease;
  };
  f.reopen = () => { f.db.close(); f.db = open(); f.store = new SqliteResourceLeaseStore({ database: f.db }); };
  return f;
}

function workflowPermit(f, workflowId, { workspaceId = f.channel.workspaceId } = {}) {
  const db = f.store.database;
  projectedPermits(db);
  const lease = f.store.acquireResourceLease(leaseInput({ workspaceId, acquiredAt: f.at(-10), expiresAt: f.at(-1) }));
  assert.ok(lease);
  db.prepare("INSERT INTO workflow_integration_rounds(round_id,workflow_id,current_generation,created_at) VALUES('guard-round',?,1,?)")
    .run(workflowId, f.at(-10));
  db.prepare(`INSERT INTO workflow_integration_generations(round_id,generation,revision,inputs_json,inputs_digest,
    phase,last_confirmed_phase,created_at,updated_at) VALUES('guard-round',1,0,?,'guard-inputs','applying','awaiting_approval',?,?)`)
    .run(JSON.stringify({ canonicalWorkspaceId: workspaceId, target: { executionRoot: lease.resourceKey } }), f.at(-10), f.at(-10));
  referenceLease(db, lease);
  return lease;
}

test("legacy without208 remains usable; the guard does not start or adopt a transaction", async t => {
  const f = await rawFixture(t, { overlay: false });
  assert.equal(hasActiveWorkflowMergeApplyLease(f.db, workspace), false);
  assert.equal(workflowMergeApplyWorkspaceBusy(f.db, workspace), false);
  const lease = f.store.acquireResourceLease(leaseInput()); assert.ok(lease);
  f.db.exec("BEGIN IMMEDIATE");
  assert.equal(workflowMergeApplyWorkspaceBusy(f.db, workspace), true);
  assert.equal(f.db.isTransaction, true);
  f.db.exec("ROLLBACK");
  assert.equal(f.store.releaseResourceLease(lease.id, "system", lease.ownerId, at(2)), 1);
});

test("active apply ownership ignores TTL, serializes different resource keys/types/owners, and survives SQLite reopen", async t => {
  const f = await rawFixture(t), lease = f.seed();
  for (const resourceType of ["workspace", "channel", "bound_path", "workflow_step", "runner"])
    assert.equal(f.peerStore.acquireResourceLease(leaseInput({ resourceType, resourceKey: `different:${resourceType}`,
      ownerType: resourceType === "workflow_step" ? "workflow_step" : "system", ownerId: "ordinary", acquiredAt: at(100), expiresAt: at(101) })), undefined);
  assert.equal(hasActiveWorkflowMergeApplyLease(f.peer, workspace), true);
  assert.equal(workflowMergeApplyWorkspaceBusy(f.peer, workspace), true);
  assert.ok(f.peerStore.acquireResourceLease(leaseInput({ workspaceId: "other", ownerId: "ordinary" })));
  f.reopen();
  assert.equal(hasActiveWorkflowMergeApplyLease(f.db, workspace), true);
  assert.equal(f.store.expireResourceLeases(at(1_000)), 1, "only the unreferenced other-workspace lease may expire");
  assert.equal(f.db.prepare("SELECT status FROM resource_leases WHERE id=?").get(lease.id).status, "active");
});

test("ordinary runtime-fenced acquisition cannot bypass the workspace predicate's owner-level branch", async t => {
  const f = await workflowAdmissionFixture(t), scope = f.scope("runtime-acquire"), outsider = f.outsider("guard");
  const input = leaseInput({ workspaceId: f.channel.workspaceId, ownerType: "run", ownerId: "ordinary-run", ...outsider.fence,
    resourceType: "runner", resourceKey: "runtime-guard", acquiredAt: f.at(2), expiresAt: f.at(3) });
  const normal = f.store.acquireResourceLease(input); assert.ok(normal, "valid runtime acquisition works before a permit");
  assert.equal(f.store.releaseResourceLeasesForAttempt(outsider.fence, f.at(4), "fixture"), 1);
  workflowPermit(f, scope.workflow.id);
  assert.equal(noWrites(f, () => f.store.acquireResourceLease(input)), undefined);
});

test("owner, exact and TTL cleanup cannot release a referenced lease but still release ordinary rows", async t => {
  const f = await rawFixture(t);
  const ordinary = f.store.acquireResourceLease(leaseInput({ resourceKey: "/ordinary" })); assert.ok(ordinary);
  const lease = f.seed();
  assert.equal(f.store.releaseResourceLease(lease.id, "system", lease.ownerId, at(2)), 0);
  assert.equal(f.store.releaseResourceLeasesForOwner("system", lease.ownerId, at(2)), 1);
  assert.equal(f.store.expireResourceLeases(at(100)), 0);
  assert.equal(f.db.prepare("SELECT status FROM resource_leases WHERE id=?").get(lease.id).status, "active");
  assert.equal(f.db.prepare("SELECT status FROM resource_leases WHERE id=?").get(ordinary.id).status, "released");
  // Only the dedicated adapter may make this change after physical observation; the guard grants no such authority.
  f.db.prepare("UPDATE resource_leases SET status='released',released_at=? WHERE id=?").run(at(3), lease.id);
  assert.equal(hasActiveWorkflowMergeApplyLease(f.db, workspace), false);
  assert.equal(f.store.releaseResourceLease(lease.id, "system", lease.ownerId, at(4)), 0);
  assert.ok(f.store.acquireResourceLease(leaseInput({ resourceKey: "/new", ownerId: "ordinary" })));
});

test("an invalid runtime-fenced permit reference is still excluded from exact Attempt release and expiry", async t => {
  const f = await workflowAdmissionFixture(t), scope = f.scope("invalid-fenced-permit"), outsider = f.outsider("fenced-reference");
  const input = leaseInput({ workspaceId: f.channel.workspaceId, resourceKey: "/invalid-reference", ownerType: "run",
    ownerId: "invalid-permit-owner", ...outsider.fence });
  const lease = f.store.acquireResourceLease(input), ordinary = f.store.acquireResourceLease({ ...input, resourceKey: "/ordinary" });
  assert.ok(lease); assert.ok(ordinary);
  const placeholder = workflowPermit(f, scope.workflow.id);
  f.store.database.prepare("DELETE FROM workflow_merge_apply_permits").run();
  assert.equal(f.store.releaseResourceLease(placeholder.id, "system", placeholder.ownerId, f.at(2)), 1);
  referenceLease(f.store.database, lease);
  assert.throws(() => hasActiveWorkflowMergeApplyLease(f.store.database, f.channel.workspaceId), /apply_lease_evidence_invalid/);
  assert.equal(f.store.releaseResourceLeasesForAttempt(outsider.fence, f.at(4), "exact cleanup"), 1);
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...outsider.fence, status: "lost", endedAt: f.at(5), now: f.at(5) }));
  assert.equal(f.store.expireResourceLeases(f.at(100)), 0);
  assert.equal(f.store.database.prepare("SELECT status FROM resource_leases WHERE id=?").get(lease.id).status, "active");
});

for (const corrupt of [
  "lease.owner", "lease.acquired", "lease.expiry", "lease.type", "lease.key", "lease.workspace", "lease.null-owner",
  "lease.expired", "lease.fence", "permit.id", "permit.lease", "permit.created", "permit.expiry", "permit.round",
  "scope.workspace", "scope.target", "scope.json",
]) {
  test(`corrupt or wrong-scope permit evidence fails closed, including released rows: ${corrupt}`, async t => {
    const f = await rawFixture(t), lease = f.seed();
    f.db.prepare("UPDATE resource_leases SET status='released' WHERE id=?").run(lease.id);
    const sql = {
      "lease.owner": "UPDATE resource_leases SET owner_id='ordinary'",
      "lease.acquired": "UPDATE resource_leases SET acquired_at='wrong'",
      "lease.expiry": "UPDATE resource_leases SET expires_at='wrong'",
      "lease.type": "UPDATE resource_leases SET resource_type='workspace'",
      "lease.key": "UPDATE resource_leases SET resource_key='/wrong'",
      "lease.workspace": "UPDATE resource_leases SET workspace_id='other'",
      "lease.null-owner": "UPDATE resource_leases SET owner_type=NULL",
      "lease.expired": "UPDATE resource_leases SET status='expired'",
      "lease.fence": "UPDATE resource_leases SET attempt_id='forged'",
      "permit.id": "UPDATE workflow_merge_apply_permits SET permit_id=''",
      "permit.lease": "UPDATE workflow_merge_apply_permits SET lease_id='missing'",
      "permit.created": "UPDATE workflow_merge_apply_permits SET created_at='wrong'",
      "permit.expiry": "UPDATE workflow_merge_apply_permits SET expires_at='wrong'",
      "permit.round": "UPDATE workflow_merge_apply_permits SET round_id='missing'",
      "scope.workspace": `UPDATE workflow_integration_generations SET inputs_json='{"canonicalWorkspaceId":"wrong","target":{"executionRoot":"/guard/target"}}'`,
      "scope.target": `UPDATE workflow_integration_generations SET inputs_json='{"canonicalWorkspaceId":"${workspace}","target":{"executionRoot":"/wrong"}}'`,
      "scope.json": "UPDATE workflow_integration_generations SET inputs_json='broken'",
    }[corrupt];
    if (corrupt === "permit.lease") f.db.exec("PRAGMA foreign_keys=OFF");
    f.db.exec(sql);
    const before = rows(f.db, "resource_leases");
    assert.throws(() => hasActiveWorkflowMergeApplyLease(f.db, workspace), /apply_lease_evidence_invalid/);
    assert.throws(() => workflowMergeApplyWorkspaceBusy(f.db, workspace), /apply_lease_evidence_invalid/);
    assert.equal(f.store.acquireResourceLease(leaseInput({ resourceKey: "/ordinary", ownerId: "ordinary" })), undefined);
    assert.deepEqual(rows(f.db, "resource_leases"), before);
  });
}

for (const corrupt of ["missing-column", "view", "generation-schema", "slot-schema"]) {
  test(`present but malformed overlay/inventory is not treated as a missing legacy table: ${corrupt}`, async t => {
    const f = await rawFixture(t);
    if (corrupt === "missing-column") {
      f.db.exec("DROP TABLE workflow_merge_apply_permits; CREATE TABLE workflow_merge_apply_permits(lease_id TEXT)");
    } else if (corrupt === "view") {
      f.db.exec("DROP TABLE workflow_merge_apply_permits; CREATE VIEW workflow_merge_apply_permits AS SELECT 'none' AS lease_id");
    } else if (corrupt === "generation-schema") {
      f.db.exec("DROP TABLE workflow_integration_generations; CREATE TABLE workflow_integration_generations(round_id TEXT,generation INTEGER)");
    } else {
      f.db.exec("DROP TABLE runtime_semaphore_slots; CREATE TABLE runtime_semaphore_slots(workspace_id TEXT)");
    }
    assert.throws(() => workflowMergeApplyWorkspaceBusy(f.db, workspace));
    if (corrupt !== "slot-schema") assert.throws(() => f.store.acquireResourceLease(leaseInput()));
    assert.equal(rows(f.db, "resource_leases").length, 0);
  });
}

for (const resourceType of ["workspace", "channel", "bound_path"]) {
  test(`reverse apply admission sees all active ${resourceType} writes, regardless of key or TTL`, async t => {
    const f = await rawFixture(t), lease = f.store.acquireResourceLease(leaseInput({ resourceType, resourceKey: "different-key" }));
    assert.ok(lease);
    assert.equal(workflowMergeApplyWorkspaceBusy(f.db, workspace), true);
    assert.equal(workflowMergeApplyWorkspaceBusy(f.db, "other"), false);
    assert.equal(f.store.releaseResourceLease(lease.id, "system", lease.ownerId, at(100)), 1);
    assert.equal(workflowMergeApplyWorkspaceBusy(f.db, workspace), false);
  });
}

test("reverse apply admission retains preparing reservations even without active leases or Attempt slots", async t => {
  const f = await workflowAdmissionFixture(t), scope = f.scope("reverse-preparing");
  f.begin(scope);
  assert.equal(f.store.expireResourceLeases(f.at(10_000)), 1);
  assert.equal(f.count("runtime_semaphore_slots"), 0);
  assert.equal(workflowMergeApplyWorkspaceBusy(f.store.database, f.channel.workspaceId), true);
  assert.equal(workflowMergeApplyWorkspaceBusy(f.store.database, "other"), false);
});

for (const resourceType of ["provider", "runner", "channel_parallel", "media_provider", "workflow_resource"]) {
  test(`reverse apply admission sees active ${resourceType} slots and ignores their released history`, async t => {
    const f = await workflowAdmissionFixture(t), outsider = f.outsider(resourceType);
    assert.ok(f.store.acquireRuntimeSemaphoreSlot(f.slotInput(outsider, { resourceType, resourceKey: "other-key", limit: 1 })));
    assert.equal(workflowMergeApplyWorkspaceBusy(f.store.database, f.channel.workspaceId), true);
    assert.equal(workflowMergeApplyWorkspaceBusy(f.store.database, "other"), false);
    assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(outsider.fence, f.at(10_000), "proven stop"), 1);
    assert.equal(workflowMergeApplyWorkspaceBusy(f.store.database, f.channel.workspaceId), false);
  });
}

for (const mode of ["planned", "no-plan", "createTaskOnly"]) {
  test(`workflow begin refuses apply ownership before any Task, audit or admission write: ${mode}`, async t => {
    const f = await workflowAdmissionFixture(t), scope = f.scope(mode);
    const input = f.input(scope, undefined, mode === "planned" ? {} : { admission: undefined, createTaskOnly: mode === "createTaskOnly" });
    workflowPermit(f, scope.workflow.id);
    const result = noWrites(f, () => f.store.beginChannelWorkflowStepStart(input));
    assert.equal(result.status, "conflict"); assert.equal(result.code, "workflow_merge_apply_workspace_busy");
    assert.equal(f.count("tasks"), 0); assert.equal(f.count("workflow_step_admissions"), 0);
  });
}

test("apply conflict does not consume a real approved pre-gate or its marker", async t => {
  const f = await b013PermitFixture(t), approval = f.approved(), input = f.beginInput(f.lease());
  workflowPermit(f, f.workflow.id);
  assert.equal(noWrites(f, () => f.store.beginChannelWorkflowStepStart(input)).code, "workflow_merge_apply_workspace_busy");
  assert.equal(f.current().metadata.preStepApprovalMarker.consumedByTaskId, undefined);
  assert.equal(f.store.getApprovalRequest(approval.id).status, "approved");
  assert.equal(f.count("tasks"), 0);
});

for (const replay of [false, true]) {
  test(`admission transfer refuses an active apply permit without changing slots or ownership (replay=${replay})`, async t => {
    const f = await workflowAdmissionFixture(t), scope = f.scope("transfer"), generation = f.begin(scope), prepared = f.prepare(scope, generation);
    if (replay) assert.equal(f.transfer(scope, generation, prepared).status, "transferred");
    workflowPermit(f, scope.workflow.id);
    assert.equal(noWrites(f, () => f.transfer(scope, generation, prepared)).code, "workflow_merge_apply_workspace_busy");
  });
}

for (const mode of ["planned", "no-plan", "linked-replay"]) {
  test(`commitReady cannot bypass apply ownership (mode=${mode})`, async t => {
    const f = await workflowAdmissionFixture(t), scope = f.scope(mode), input = f.input(scope, undefined,
      mode === "no-plan" ? { admission: undefined } : {});
    const generation = f.begin(scope, input), prepared = f.prepare(scope, generation);
    if (mode !== "no-plan") assert.equal(f.transfer(scope, generation, prepared).status, "transferred");
    if (mode === "linked-replay") assert.equal(f.ready(scope, generation, prepared).status, "linked");
    workflowPermit(f, scope.workflow.id);
    assert.equal(noWrites(f, () => f.ready(scope, generation, prepared)).code, "workflow_merge_apply_workspace_busy");
  });
}

for (const replay of [false, true]) {
  test(`same-Run continuation rejects apply ownership before any group reacquisition (replay=${replay})`, async t => {
    const f = await workflowResumeAdmissionFixture(t);
    if (replay) assert.equal(f.resume().status, "resumed");
    workflowPermit(f, f.scopeResume.workflow.id);
    assert.equal(noWrites(f, () => f.resume()).code, "workflow_merge_apply_workspace_busy");
  });
  test(`user-input successor recovery rejects apply ownership before lease/slot reuse or acquisition (replay=${replay})`, async t => {
    const f = await workflowUserInputAdmissionFixture(t);
    if (replay) assert.equal(f.recover().status, "ready");
    workflowPermit(f, f.scopeInput.workflow.id);
    const result = noWrites(f, () => f.recover());
    assert.deepEqual(result, { status: "busy", kind: "resource", resourceType: "workspace", resourceKey: f.channel.workspaceId });
  });
}

test("user-input recovery cannot redirect lease or slot writes to a caller-selected workspace", async t => {
  const f = await workflowUserInputAdmissionFixture(t), original = f.recoveryInput();
  const leases = original.leases.map(lease => ({ ...lease, workspaceId: "foreign" }));
  assert.equal(noWrites(f, () => f.recover({ leases })).status, "changed");
  const semaphores = original.semaphores.map(slot => ({ ...slot, workspaceId: "foreign" }));
  assert.equal(noWrites(f, () => f.recover({ semaphores })).status, "changed");
});

test("SQLite write contention prevents a stale ordinary reader from slipping past an uncommitted permit", async t => {
  const f = await rawFixture(t);
  assert.equal(hasActiveWorkflowMergeApplyLease(f.peer, workspace), false);
  f.db.exec("BEGIN IMMEDIATE");
  const lease = f.seed();
  assert.equal(hasActiveWorkflowMergeApplyLease(f.peer, workspace), false, "a reader cannot see the uncommitted permit");
  assert.equal(f.peerStore.acquireResourceLease(leaseInput({ resourceKey: "/ordinary", ownerId: "ordinary" })), undefined,
    "the competing writer must not consume the stale read");
  f.db.exec("COMMIT");
  assert.equal(hasActiveWorkflowMergeApplyLease(f.peer, workspace), true);
  assert.equal(f.peerStore.acquireResourceLease(leaseInput({ resourceKey: "/ordinary", ownerId: "ordinary" })), undefined);
  assert.deepEqual(rows(f.peer, "resource_leases").map(row => row.id), [lease.id]);
});

test("rolled-back permit creation leaves no lock or lease and ordinary admission can proceed", async t => {
  const f = await rawFixture(t);
  f.db.exec("BEGIN IMMEDIATE"); f.seed();
  assert.equal(hasActiveWorkflowMergeApplyLease(f.db, workspace), true);
  f.db.exec("ROLLBACK");
  assert.equal(hasActiveWorkflowMergeApplyLease(f.peer, workspace), false);
  assert.equal(workflowMergeApplyWorkspaceBusy(f.peer, workspace), false);
  assert.equal(rows(f.peer, "resource_leases").length, 0);
  assert.ok(f.peerStore.acquireResourceLease(leaseInput({ ownerId: "ordinary" })));
});
