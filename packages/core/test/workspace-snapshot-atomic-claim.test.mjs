import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, resolveStoragePaths } from "../dist/index.js";

const workspaceId = "workspace_default";
const time = second => `2026-10-16T01:00:${String(second).padStart(2, "0")}.000Z`;

/** All storage paths are explicit owned temporary paths; no model, real app or everyday DB. */
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "ling-snapshot-atomic-claim-")));
  const cwd = join(directory, "workspace");
  await fs.mkdir(cwd);
  const paths = resolveStoragePaths(cwd, { homeDir: join(directory, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  assert.ok(paths.databasePath.startsWith(`${directory}/`));
  const stores = [], open = () => { const store = createSqliteRunStore(cwd, paths); stores.push(store); return store; };
  t.after(async () => {
    for (const store of stores.reverse()) if (store.database.isOpen) store.close();
    assert.ok(directory.startsWith(`${await fs.realpath(os.tmpdir())}/ling-snapshot-atomic-claim-`));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = open(), observer = open();
  const fingerprint = createHash("sha256").update("atomic restore claim fixture").digest("hex");
  const { manifest } = store.commitWorkspaceSnapshot({ id: "atomic-claim-manifest", workspaceId, cwd, canonicalRoot: cwd,
    state: "committed", fingerprint, provenanceWatermark: `${workspaceId}:0`, entryCount: 0, totalBytes: 0,
    createdAt: time(0), sealedAt: time(0) }, []);
  const anchor = store.createWorkspaceSnapshotRestoreAnchor({ workspaceId, baselineSnapshotId: manifest.id,
    baselineFingerprint: fingerprint, baselineProvenanceWatermark: manifest.provenanceWatermark,
    expectedWorkspaceFingerprint: fingerprint, expectedProvenanceWatermark: manifest.provenanceWatermark, createdAt: time(0) });
  const createRequest = key => store.createSnapshotRestoreRequest({ idempotencyKey: key, workspaceId,
    anchorId: anchor.id, snapshotId: manifest.id, expectedWorkspaceFingerprint: fingerprint,
    expectedProvenanceWatermark: manifest.provenanceWatermark, createdAt: time(0) });
  const request = createRequest("atomic-claim-original");
  const facts = reader => ({ request: reader.getSnapshotRestoreRequest(request.id), fence: reader.getWorkspaceSnapshotFence(workspaceId) });
  const claim = (extra = {}) => store.claimSnapshotRestoreFence({ requestId: request.id, expectedState: "requested",
    expectedRequestFencingEpoch: 0, now: time(3), ...extra });
  return { store, observer, open, createRequest, request, facts, claim };
}

for (const initialState of ["requested", "validating"]) {
  test(`snapshot atomic claim binds ${initialState} and exact lease in one durable commit`, async t => {
    const f = await fixture(t);
    // Exercise nonzero request and workspace epochs, not just the all-zero case.
    assert.equal(f.store.acquireWorkspaceSnapshotFence(workspaceId, f.request.id, time(1)), 1);
    assert.equal(f.store.releaseWorkspaceSnapshotFence(workspaceId, f.request.id, time(1), 1), true);
    const prior = f.store.updateSnapshotRestoreRequest({ id: f.request.id, expectedState: "requested",
      state: initialState, fencingEpoch: 1, lastError: "old diagnosis", updatedAt: time(2) });
    const epoch = f.claim({ expectedState: initialState, expectedRequestFencingEpoch: prior.fencingEpoch });
    assert.equal(epoch, 2);
    const expected = { request: { ...prior, state: "fenced", fencingEpoch: epoch, updatedAt: time(3) },
      fence: { epoch, ownerRequestId: f.request.id } };
    delete expected.request.lastError;
    assert.deepEqual(f.facts(f.observer), expected);
    assert.deepEqual(f.facts(f.open()), expected);
    assert.equal(f.claim({ expectedState: initialState, expectedRequestFencingEpoch: prior.fencingEpoch }), undefined,
      "a stale repeated claim does not increment the workspace epoch");
    assert.deepEqual(f.facts(f.observer), expected);
  });
}

test("snapshot atomic claim wrong state has no durable side effects", async t => {
  const f = await fixture(t);
  f.store.updateSnapshotRestoreRequest({ id: f.request.id, expectedState: "requested", state: "failed", updatedAt: time(1) });
  const before = f.facts(f.observer);
  assert.equal(f.claim(), undefined);
  assert.deepEqual(f.facts(f.observer), before);
  assert.deepEqual(f.facts(f.open()), before);
});

test("snapshot atomic claim rejects an old request epoch even if state matches", async t => {
  const f = await fixture(t);
  f.store.updateSnapshotRestoreRequest({ id: f.request.id, expectedState: "requested", state: "requested",
    fencingEpoch: 7, updatedAt: time(1) });
  const before = f.facts(f.observer);
  assert.equal(f.claim(), undefined);
  assert.deepEqual(f.facts(f.observer), before);
  assert.deepEqual(f.facts(f.open()), before);
});

test("snapshot atomic claim does not touch a foreign fence owner", async t => {
  const f = await fixture(t), foreign = f.createRequest("atomic-claim-foreign");
  const epoch = f.observer.acquireWorkspaceSnapshotFence(workspaceId, foreign.id, time(1));
  const before = f.facts(f.observer), foreignBefore = f.observer.getSnapshotRestoreRequest(foreign.id);
  assert.throws(() => f.claim(), /already owned/u);
  assert.deepEqual(f.facts(f.observer), before);
  assert.deepEqual(f.observer.getSnapshotRestoreRequest(foreign.id), foreignBefore);
  assert.deepEqual(f.facts(f.open()), before);
  assert.deepEqual(before.fence, { epoch, ownerRequestId: foreign.id });
});

test("snapshot atomic claim COMMIT failure rolls back both writes and preserves original error", async t => {
  const f = await fixture(t), before = f.facts(f.observer);
  const primary = Object.assign(new Error("A30 owned COMMIT failure"), { code: "EIO" });
  const originalExec = f.store.database.exec;
  let commits = 0, rollbacks = 0, uncommitted;
  const patch = t.mock.method(f.store.database, "exec", function (sql) {
    if (sql.trim() === "COMMIT") {
      commits++;
      uncommitted = f.facts(f.store);
      assert.equal(uncommitted.request.state, "fenced");
      assert.equal(uncommitted.request.fencingEpoch, uncommitted.fence.epoch);
      assert.equal(uncommitted.fence.ownerRequestId, f.request.id);
      assert.deepEqual(f.facts(f.observer), before, "neither write is visible before COMMIT");
      throw primary;
    }
    if (sql.trim() === "ROLLBACK") rollbacks++;
    return originalExec.call(this, sql);
  });
  try { assert.throws(() => f.claim(), error => error === primary); }
  finally { patch.mock.restore(); }
  assert.equal(commits, 1);
  assert.equal(rollbacks, 1);
  assert.ok(uncommitted);
  assert.deepEqual(f.facts(f.observer), before, "the committed request and fence must be byte-for-field unchanged");
  assert.deepEqual(f.facts(f.open()), before);
  assert.equal(f.claim(), before.fence.epoch + 1, "rollback must leave the connection usable and no epoch gap");
});
