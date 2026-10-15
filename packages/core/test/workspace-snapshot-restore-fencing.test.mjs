import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore, resolveStoragePaths } from "../dist/index.js";

// Real isolated Core SQLite APIs, not Daemon filesystem restore or Host execution.
// expectedFencingEpoch is intentionally passed from JS before its additive contract
// exists: the initial run must expose the current implementation ignoring it.
const WORKSPACE = "workspace_default";
const time = second => `2026-10-15T14:00:${String(second).padStart(2, "0")}.000Z`;

async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), "ling-restore-epoch-cas-"));
  const cwd = resolve(directory, "workspace");
  await mkdir(resolve(cwd, "restored-folder"), { recursive: true, mode: 0o755 });
  const paths = resolveStoragePaths(cwd, {
    homeDir: resolve(directory, "owned-home"), env: {}, workspaceStateLocation: "repo-local",
  }).workspace;
  assert.ok(paths.databasePath.startsWith(directory + "/"), "fixture SQLite must stay in the owned directory");
  const stores = [];
  const open = () => {
    const store = createSqliteRunStore(cwd, paths);
    stores.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of stores.reverse()) if (store.database.isOpen) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = open();
  const capturedEntry = { manifestId: "fencing-manifest", relativePath: "restored-folder",
    kind: "directory", mode: 0o755, sizeBytes: 0 };
  const fingerprint = createHash("sha256").update(JSON.stringify(capturedEntry)).digest("hex");
  const { manifest, entries } = store.commitWorkspaceSnapshot({
    id: "fencing-manifest", workspaceId: WORKSPACE, cwd, canonicalRoot: cwd,
    state: "committed", captureKind: "user_restore_point", fingerprint,
    provenanceWatermark: `${WORKSPACE}:0`, entryCount: 1, totalBytes: 0,
    createdAt: time(0), sealedAt: time(0),
  }, [capturedEntry]);
  assert.equal(manifest.state, "committed");
  assert.equal(entries.length, 1);
  const anchor = store.createWorkspaceSnapshotRestoreAnchor({
    workspaceId: WORKSPACE, baselineSnapshotId: manifest.id,
    baselineFingerprint: fingerprint, baselineProvenanceWatermark: manifest.provenanceWatermark,
    expectedWorkspaceFingerprint: fingerprint, expectedProvenanceWatermark: manifest.provenanceWatermark,
    createdAt: time(0),
  });
  const createRequest = key => store.createSnapshotRestoreRequest({
    idempotencyKey: key, workspaceId: WORKSPACE, anchorId: anchor.id, snapshotId: manifest.id,
    expectedWorkspaceFingerprint: anchor.expectedWorkspaceFingerprint,
    expectedProvenanceWatermark: anchor.expectedProvenanceWatermark, createdAt: time(0),
  });
  const request = createRequest("original-request");
  assert.equal(request.state, "requested");
  assert.equal(store.updateSnapshotRestoreRequest({ id: request.id, expectedState: "requested",
    state: "validating", updatedAt: time(1) })?.state, "validating");
  const firstEpoch = store.acquireWorkspaceSnapshotFence(WORKSPACE, request.id, time(2));
  assert.equal(firstEpoch, 1);
  assert.equal(store.updateSnapshotRestoreRequest({ id: request.id, expectedState: "validating",
    state: "fenced", fencingEpoch: firstEpoch, updatedAt: time(2) })?.fencingEpoch, firstEpoch);
  const [journal] = store.createSnapshotRestoreJournalEntries([{
    restoreRequestId: request.id, sequence: 0, relativePath: capturedEntry.relativePath,
    targetKind: "directory", targetExists: true, targetMode: 0o755, rollbackMode: 0o755,
    updatedAt: time(3),
  }]);
  assert.equal(store.updateSnapshotRestoreRequest({ id: request.id, expectedState: "fenced",
    state: "staged", journalEntryCount: 1, updatedAt: time(3) })?.state, "staged");
  assert.equal(store.updateSnapshotRestoreRequest({ id: request.id, expectedState: "staged",
    state: "committing", updatedAt: time(4) })?.state, "committing");
  assert.equal(store.updateSnapshotRestoreJournalEntry({ id: journal.id, expectedState: "pending",
    state: "applied", updatedAt: time(4) })?.state, "applied");

  const facts = reader => ({
    request: reader.getSnapshotRestoreRequest(request.id),
    journal: reader.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id }),
    fence: reader.getWorkspaceSnapshotFence(WORKSPACE),
  });
  const newerSameOwner = () => {
    const owner = open();
    const epoch = owner.acquireWorkspaceSnapshotFence(WORKSPACE, request.id, time(5));
    assert.equal(epoch, firstEpoch + 1);
    // Existing no-expected API publishes the new owner epoch; the counterexample
    // itself below always supplies an explicit stale expectedFencingEpoch.
    const current = owner.updateSnapshotRestoreRequest({ id: request.id, expectedState: "committing",
      state: "committing", fencingEpoch: epoch, lastError: "current epoch marker", updatedAt: time(5) });
    assert.equal(current?.fencingEpoch, epoch);
    assert.equal(current?.state, "committing");
    assert.equal(owner.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id })[0].state, "applied");
    assert.deepEqual(owner.getWorkspaceSnapshotFence(WORKSPACE), { epoch, ownerRequestId: request.id });
    return { owner, epoch };
  };
  const transferOwner = () => {
    const owner = open();
    const other = createRequest("different-owner-request");
    assert.equal(owner.releaseWorkspaceSnapshotFence(WORKSPACE, request.id, time(5)), true);
    const epoch = owner.acquireWorkspaceSnapshotFence(WORKSPACE, other.id, time(6));
    assert.equal(epoch, firstEpoch + 1);
    assert.equal(owner.updateSnapshotRestoreRequest({ id: other.id, expectedState: "requested",
      state: "validating", updatedAt: time(6) })?.state, "validating");
    assert.equal(owner.updateSnapshotRestoreRequest({ id: other.id, expectedState: "validating",
      state: "fenced", fencingEpoch: epoch, updatedAt: time(6) })?.fencingEpoch, epoch);
    assert.deepEqual(owner.getWorkspaceSnapshotFence(WORKSPACE), { epoch, ownerRequestId: other.id });
    return { owner, other, epoch };
  };
  const updateOldRequest = expectedFencingEpoch => store.updateSnapshotRestoreRequest({
    id: request.id, expectedState: "committing", state: "failed", fencingEpoch: firstEpoch,
    expectedFencingEpoch, lastError: "stale callback must not overwrite current epoch", updatedAt: time(7),
  });
  const updateOldJournal = expectedFencingEpoch => store.updateSnapshotRestoreJournalEntry({
    id: journal.id, expectedState: "applied", state: "rolled_back", expectedFencingEpoch, updatedAt: time(7),
  });
  assert.equal(facts(open()).request.fencingEpoch, firstEpoch, "fixture is durable before the race");
  return { store, open, request, journal, firstEpoch, facts, createRequest, newerSameOwner, transferOwner,
    updateOldRequest, updateOldJournal };
}

for (const entity of ["request", "journal"]) {
  test(`A25 newer epoch of the same request fences an old ${entity} callback despite equal state`, async t => {
    const f = await fixture(t);
    const { owner } = f.newerSameOwner();
    const before = f.facts(owner);
    const result = entity === "request" ? f.updateOldRequest(f.firstEpoch) : f.updateOldJournal(f.firstEpoch);
    const durable = f.facts(f.open());
    assert.deepEqual({ result, durable }, { result: undefined, durable: before },
      "epoch-CAS must reject the old worker and preserve request, journal and fence across connections");
  });
}

test("A25 current explicit epoch can advance the request and persists without changing the journal or fence", async t => {
  const f = await fixture(t);
  const { owner, epoch } = f.newerSameOwner();
  const before = f.facts(owner);
  const updated = owner.updateSnapshotRestoreRequest({ id: f.request.id, expectedState: "committing",
    state: "verifying", expectedFencingEpoch: epoch, fencingEpoch: epoch, updatedAt: time(7) });
  assert.equal(updated?.state, "verifying");
  assert.equal(updated?.fencingEpoch, epoch);
  const durable = f.facts(f.open());
  assert.deepEqual(durable.request, updated);
  assert.deepEqual(durable.journal, before.journal);
  assert.deepEqual(durable.fence, before.fence);
  assert.equal(owner.updateSnapshotRestoreRequest({ id: f.request.id, expectedState: "committing",
    state: "failed", expectedFencingEpoch: epoch, updatedAt: time(8) }), undefined,
  "the epoch predicate cannot replace the existing state predicate");
  assert.deepEqual(f.facts(f.open()), durable);
});

test("A25 current explicit epoch can update a journal entry without changing request or fence", async t => {
  const f = await fixture(t);
  const { owner, epoch } = f.newerSameOwner();
  const before = f.facts(owner);
  const updated = owner.updateSnapshotRestoreJournalEntry({ id: f.journal.id, expectedState: "applied",
    state: "rolled_back", expectedFencingEpoch: epoch, updatedAt: time(7) });
  assert.equal(updated?.state, "rolled_back");
  const durable = f.facts(f.open());
  assert.deepEqual(durable.journal, [updated]);
  assert.deepEqual(durable.request, before.request);
  assert.deepEqual(durable.fence, before.fence);
  assert.equal(owner.updateSnapshotRestoreJournalEntry({ id: f.journal.id, expectedState: "applied",
    state: "failed", expectedFencingEpoch: epoch, updatedAt: time(8) }), undefined);
  assert.deepEqual(f.facts(f.open()), durable);
});

test("A25 legal legacy calls without expected epoch retain existing state-CAS behavior", async t => {
  const f = await fixture(t);
  const updated = f.store.updateSnapshotRestoreRequest({ id: f.request.id, expectedState: "committing",
    state: "recovery_required", fencingEpoch: f.firstEpoch, updatedAt: time(7) });
  assert.equal(updated?.state, "recovery_required");
  const journal = f.store.updateSnapshotRestoreJournalEntry({ id: f.journal.id, expectedState: "applied",
    state: "rolled_back", updatedAt: time(7) });
  assert.equal(journal?.state, "rolled_back");
  const before = f.facts(f.open());
  assert.deepEqual(before.request, updated);
  assert.deepEqual(before.journal, [journal]);
  assert.equal(f.store.updateSnapshotRestoreRequest({ id: f.request.id, expectedState: "committing",
    state: "failed", updatedAt: time(8) }), undefined);
  assert.equal(f.store.updateSnapshotRestoreJournalEntry({ id: f.journal.id, expectedState: "applied",
    state: "failed", updatedAt: time(8) }), undefined);
  assert.deepEqual(f.facts(f.open()), before);
});

for (const entity of ["request", "journal"]) {
  test(`A25 a transferred workspace fence rejects the previous owner's ${entity} callback`, async t => {
    const f = await fixture(t);
    const { owner, other, epoch } = f.transferOwner();
    const before = f.facts(owner);
    const otherBefore = owner.getSnapshotRestoreRequest(other.id);
    const result = entity === "request" ? f.updateOldRequest(f.firstEpoch) : f.updateOldJournal(f.firstEpoch);
    const reopened = f.open();
    assert.deepEqual({ result, durable: f.facts(reopened) }, { result: undefined, durable: before });
    assert.deepEqual(reopened.getSnapshotRestoreRequest(other.id), otherBefore);
    const current = owner.updateSnapshotRestoreRequest({ id: other.id, expectedState: "fenced",
      state: "staged", expectedFencingEpoch: epoch, updatedAt: time(8) });
    assert.equal(current?.state, "staged", "the actual new owner remains able to progress");
  });
}

test("A25 a different request cannot acquire an actively owned workspace fence", async t => {
  const f = await fixture(t);
  const other = f.createRequest("blocked-other-request");
  const before = f.facts(f.open());
  assert.throws(() => f.store.acquireWorkspaceSnapshotFence(WORKSPACE, other.id, time(5)), /already owned/);
  assert.deepEqual(f.facts(f.open()), before);
});

test("A25 release epoch rejects an older same-owner callback without clearing the newer fence", async t => {
  const f = await fixture(t);
  const { owner } = f.newerSameOwner();
  const before = f.facts(owner);
  const result = f.store.releaseWorkspaceSnapshotFence(WORKSPACE, f.request.id, time(7), f.firstEpoch);
  assert.deepEqual({ result, durable: f.facts(f.open()) }, { result: false, durable: before },
    "the previous epoch cannot release the same request's newly acquired fence");
});

test("A25 release epoch permits only the current owner epoch and preserves request and journal", async t => {
  const f = await fixture(t);
  const { owner, epoch } = f.newerSameOwner();
  const other = f.createRequest("release-non-owner");
  const before = f.facts(owner);
  assert.equal(owner.releaseWorkspaceSnapshotFence(WORKSPACE, other.id, time(7), epoch), false,
    "the correct numeric epoch cannot authorize another request to release this fence");
  assert.deepEqual(f.facts(f.open()), before);
  assert.equal(owner.releaseWorkspaceSnapshotFence(WORKSPACE, f.request.id, time(8), epoch), true);
  const durable = f.facts(f.open());
  assert.deepEqual(durable.request, before.request);
  assert.deepEqual(durable.journal, before.journal);
  assert.deepEqual(durable.fence, { epoch }, "release clears only the owner, not the monotonic epoch");
  assert.equal(owner.releaseWorkspaceSnapshotFence(WORKSPACE, f.request.id, time(9), epoch), false);
  assert.deepEqual(f.facts(f.open()), durable);
});
