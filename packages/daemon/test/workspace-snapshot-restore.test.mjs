import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import {
  captureWorkspaceSnapshot,
  createWorkspaceSnapshotRestoreAnchor,
  createWorkspaceSnapshotUserRestoreAnchor,
  fingerprintWorkspace,
  garbageCollectWorkspaceSnapshots,
  reconcileWorkspaceSnapshotRestore,
  restoreWorkspaceSnapshot,
} from "../dist/features/runs/workspace-snapshot-restore.js";

test("snapshot capture/restore is content addressed, fenced, CAS checked, and durable", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-snapshot-restore-"));
  const now = "2026-08-26T01:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  let outside;
  try {
    await writeFile(resolve(cwd, "a.txt"), "alpha\n", "utf8");
    await writeFile(resolve(cwd, ".env"), "SECRET=keep\n", "utf8");
    await writeFile(resolve(cwd, "ignored-secret.txt"), "PRIVATE\n", "utf8");
    await writeFile(resolve(cwd, "nested.txt"), "nested\n", "utf8");
    await mkdir(resolve(cwd, "empty-dir"));
    await symlink("a.txt", resolve(cwd, "internal-link.txt"));
    outside = await mkdtemp(resolve(tmpdir(), "ling-snapshot-outside-"));
    await writeFile(resolve(outside, "outside.txt"), "outside\n", "utf8");
    await symlink(resolve(outside, "outside.txt"), resolve(cwd, "external-link.txt"));
    const first = await captureWorkspaceSnapshot(store, cwd, { workspaceId: "workspace_default", now });
    const second = await captureWorkspaceSnapshot(store, cwd, { workspaceId: "workspace_default", now: "2026-08-26T01:00:01.000Z" });
    assert.equal(first.manifest.state, "committed");
    assert.equal(first.entries.some((entry) => entry.relativePath === ".env" && entry.managed), false);
    assert.equal(first.entries.some((entry) => entry.relativePath === "ignored-secret.txt" && entry.managed), false);
    assert.equal(first.entries.find((entry) => entry.relativePath === "internal-link.txt")?.kind, "symlink");
    assert.equal(first.entries.find((entry) => entry.relativePath === "internal-link.txt")?.managed, true);
    assert.equal(first.entries.find((entry) => entry.relativePath === "external-link.txt")?.exclusionReason, "external_symlink");
    const firstFile = first.entries.find((entry) => entry.relativePath === "a.txt");
    const secondFile = second.entries.find((entry) => entry.relativePath === "a.txt");
    assert.equal(firstFile?.blobSha256, secondFile?.blobSha256);
    assert.equal(store.getWorkspaceSnapshotBlob(firstFile.blobSha256).refCount, 2);
    await rm(resolve(cwd, ".env"));
    await rm(resolve(cwd, "ignored-secret.txt"));
    await rm(resolve(cwd, "external-link.txt"));
    const baseline = await captureWorkspaceSnapshot(store, cwd, { workspaceId: "workspace_default", now: "2026-08-26T01:00:02.000Z" });
    await writeFile(resolve(cwd, ".env"), "SECRET=keep\n", "utf8");
    await writeFile(resolve(cwd, "ignored-secret.txt"), "PRIVATE\n", "utf8");
    await symlink(resolve(outside, "outside.txt"), resolve(cwd, "external-link.txt"));
    await mkdir(resolve(cwd, "new-empty-dir"));

    const channel = store.createChannel({ name: "Snapshot", boundPath: cwd }, now);
    const thread = store.resolveOrCreateConversationThread({ surfaceKind: "channel_root", channelId: channel.id, title: "Snapshot", objective: "Restore" }, now).thread;
    const turn = store.appendConversationUserTurn({
      channelId: channel.id,
      threadId: thread.id,
      title: "Restore",
      userInstruction: "Restore",
      payload: { body: "Restore", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
      idempotencyKey: "snapshot-turn",
    }, now);
    const checkpoint = store.createCompactionCheckpoint({
      threadId: thread.id,
      sourceTurnId: turn.turnId,
      coveredItemSeqFrom: turn.item.sequence,
      coveredItemSeqTo: turn.item.sequence,
      coveredTurnIds: [turn.turnId],
      sourceRefs: [{ type: "turn", id: turn.turnId }],
      workspaceProvenanceWatermark: "workspace_default:0",
      compactionPolicyVersion: "continuity-v2-test",
      createdAt: now,
    });

    await writeFile(resolve(cwd, "a.txt"), "changed\n", "utf8");
    await rm(resolve(cwd, "nested.txt"));
    await writeFile(resolve(cwd, "new.txt"), "new\n", "utf8");
    const expectedFingerprint = await fingerprintWorkspace(cwd);
    const anchor = await createWorkspaceSnapshotRestoreAnchor(store, {
      threadId: thread.id,
      targetTurnId: turn.turnId,
      checkpointId: checkpoint.id,
      baselineSnapshotId: baseline.manifest.id,
      baselineFingerprint: baseline.manifest.fingerprint,
      baselineProvenanceWatermark: baseline.manifest.provenanceWatermark,
      expectedWorkspaceFingerprint: expectedFingerprint,
      expectedProvenanceWatermark: "workspace_default:0",
      createdAt: now,
    });
    const confirmation = store.createSnapshotRestoreConfirmation({ anchorId: anchor.id, snapshotId: baseline.manifest.id, workspaceId: "workspace_default", createdAt: now });
    store.resolveSnapshotRestoreConfirmation(confirmation.id, "confirmed", now);

    const restored = await restoreWorkspaceSnapshot(store, cwd, {
      idempotencyKey: "restore-1",
      anchorId: anchor.id,
      snapshotId: baseline.manifest.id,
      confirmationId: confirmation.id,
      now: "2026-08-26T01:00:02.000Z",
    });
    assert.equal(restored.state, "committed");
    assert.equal(await readFile(resolve(cwd, "a.txt"), "utf8"), "alpha\n");
    assert.equal(await readFile(resolve(cwd, "nested.txt"), "utf8"), "nested\n");
    assert.equal((await stat(resolve(cwd, "empty-dir"))).isDirectory(), true);
    await assert.rejects(() => stat(resolve(cwd, "new-empty-dir")), /ENOENT/);
    await assert.rejects(() => readFile(resolve(cwd, "new.txt")), /ENOENT/);
    assert.equal(await readFile(resolve(cwd, ".env"), "utf8"), "SECRET=keep\n");
    assert.equal(await readlink(resolve(cwd, "internal-link.txt")), "a.txt");
    assert.equal(await readlink(resolve(cwd, "external-link.txt")), resolve(outside, "outside.txt"));
    const replay = await restoreWorkspaceSnapshot(store, cwd, { idempotencyKey: "restore-1", anchorId: anchor.id, snapshotId: baseline.manifest.id, confirmationId: confirmation.id });
    assert.equal(replay.id, restored.id);
    const journal = store.listSnapshotRestoreJournalEntries({ restoreRequestId: restored.id });
    assert.equal(journal.length, restored.journalEntryCount);
    assert.equal(journal.every((entry) => entry.state === "applied"), true);

    store.close();
    const reopened = createSqliteRunStore(cwd);
    assert.equal(reopened.getWorkspaceSnapshotManifest(first.manifest.id)?.state, "committed");
    assert.equal(reopened.getSnapshotRestoreRequest(restored.id)?.state, "committed");
    reopened.close();
  } finally {
    try { store.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
    try { await rm(outside, { recursive: true, force: true }); } catch {}
  }
});

test("snapshot restore rejects exact fingerprint drift and corrupt blobs", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-snapshot-cas-"));
  const store = createSqliteRunStore(cwd);
  try {
    await writeFile(resolve(cwd, "file.txt"), "before\n", "utf8");
    const snapshot = await captureWorkspaceSnapshot(store, cwd, { workspaceId: "workspace_default", now: "2026-08-26T02:00:00.000Z" });
    const channel = store.createChannel({ name: "CAS", boundPath: cwd }, "2026-08-26T02:00:00.000Z");
    const thread = store.resolveOrCreateConversationThread({ surfaceKind: "channel_root", channelId: channel.id, title: "CAS", objective: "CAS" }, "2026-08-26T02:00:00.000Z").thread;
    const turn = store.appendConversationUserTurn({ channelId: channel.id, threadId: thread.id, title: "CAS", userInstruction: "CAS", payload: { body: "CAS", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] }, idempotencyKey: "cas-turn" }, "2026-08-26T02:00:00.000Z");
    const checkpoint = store.createCompactionCheckpoint({ threadId: thread.id, sourceTurnId: turn.turnId, coveredItemSeqFrom: turn.item.sequence, coveredItemSeqTo: turn.item.sequence, coveredTurnIds: [turn.turnId], sourceRefs: [{ type: "turn", id: turn.turnId }], workspaceProvenanceWatermark: "workspace_default:0", compactionPolicyVersion: "test", createdAt: "2026-08-26T02:00:00.000Z" });
    await writeFile(resolve(cwd, "file.txt"), "after\n", "utf8");
    const anchor = await createWorkspaceSnapshotRestoreAnchor(store, { threadId: thread.id, targetTurnId: turn.turnId, checkpointId: checkpoint.id, baselineSnapshotId: snapshot.manifest.id, baselineFingerprint: snapshot.manifest.fingerprint, baselineProvenanceWatermark: snapshot.manifest.provenanceWatermark, expectedWorkspaceFingerprint: await fingerprintWorkspace(cwd), expectedProvenanceWatermark: "workspace_default:0", createdAt: "2026-08-26T02:00:00.000Z" });
    const confirmation = store.createSnapshotRestoreConfirmation({ anchorId: anchor.id, snapshotId: snapshot.manifest.id, workspaceId: "workspace_default", createdAt: "2026-08-26T02:00:00.000Z" });
    store.resolveSnapshotRestoreConfirmation(confirmation.id, "confirmed", "2026-08-26T02:00:00.000Z");
    await writeFile(resolve(store.paths.snapshotBlobsDir, snapshot.entries.find((entry) => entry.relativePath === "file.txt").blobSha256), "tampered\n", "utf8");
    await assert.rejects(() => restoreWorkspaceSnapshot(store, cwd, { idempotencyKey: "cas-restore", anchorId: anchor.id, snapshotId: snapshot.manifest.id, confirmationId: confirmation.id }), /corrupt/u);
  } finally {
    try { store.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
  }
});

test("snapshot restore requires a matching durable confirmation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-snapshot-confirmation-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-08-26T03:00:00.000Z";
  try {
    await writeFile(resolve(cwd, "file.txt"), "before\n", "utf8");
    const snapshot = await captureWorkspaceSnapshot(store, cwd, { workspaceId: "workspace_default", now });
    const channel = store.createChannel({ name: "Confirmation", boundPath: cwd }, now);
    const thread = store.resolveOrCreateConversationThread({ surfaceKind: "channel_root", channelId: channel.id, title: "Confirmation", objective: "Restore" }, now).thread;
    const turn = store.appendConversationUserTurn({ channelId: channel.id, threadId: thread.id, title: "Restore", userInstruction: "Restore", payload: { body: "Restore", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] }, idempotencyKey: "confirmation-turn" }, now);
    const checkpoint = store.createCompactionCheckpoint({ threadId: thread.id, sourceTurnId: turn.turnId, coveredItemSeqFrom: turn.item.sequence, coveredItemSeqTo: turn.item.sequence, coveredTurnIds: [turn.turnId], sourceRefs: [{ type: "turn", id: turn.turnId }], workspaceProvenanceWatermark: "workspace_default:0", compactionPolicyVersion: "test", createdAt: now });
    await writeFile(resolve(cwd, "file.txt"), "after\n", "utf8");
    const anchor = await createWorkspaceSnapshotRestoreAnchor(store, { threadId: thread.id, targetTurnId: turn.turnId, checkpointId: checkpoint.id, baselineSnapshotId: snapshot.manifest.id, baselineFingerprint: snapshot.manifest.fingerprint, baselineProvenanceWatermark: snapshot.manifest.provenanceWatermark, expectedWorkspaceFingerprint: await fingerprintWorkspace(cwd), expectedProvenanceWatermark: "workspace_default:0", createdAt: now });
    await assert.rejects(() => restoreWorkspaceSnapshot(store, cwd, { idempotencyKey: "confirmation-required", anchorId: anchor.id, snapshotId: snapshot.manifest.id }), (error) => error?.code === "confirmation_required");
    const pending = store.createSnapshotRestoreConfirmation({ anchorId: anchor.id, snapshotId: snapshot.manifest.id, workspaceId: "workspace_default", createdAt: now });
    await assert.rejects(() => restoreWorkspaceSnapshot(store, cwd, { idempotencyKey: "confirmation-pending", anchorId: anchor.id, snapshotId: snapshot.manifest.id, confirmationId: pending.id }), (error) => error?.code === "confirmation_required");
    store.resolveSnapshotRestoreConfirmation(pending.id, "denied", now);
    await assert.rejects(() => restoreWorkspaceSnapshot(store, cwd, { idempotencyKey: "confirmation-denied", anchorId: anchor.id, snapshotId: snapshot.manifest.id, confirmationId: pending.id }), (error) => error?.code === "confirmation_required");
    const confirmed = store.createSnapshotRestoreConfirmation({ anchorId: anchor.id, snapshotId: snapshot.manifest.id, workspaceId: "workspace_default", createdAt: now });
    store.resolveSnapshotRestoreConfirmation(confirmed.id, "confirmed", now);
    const restored = await restoreWorkspaceSnapshot(store, cwd, { idempotencyKey: "confirmation-ok", anchorId: anchor.id, snapshotId: snapshot.manifest.id, confirmationId: confirmed.id });
    assert.equal(restored.state, "committed");
  } finally {
    try { store.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
  }
});

test("snapshot quota rejects before exposing a partial manifest", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-snapshot-quota-"));
  const store = createSqliteRunStore(cwd);
  try {
    await writeFile(resolve(cwd, "large.txt"), "1234567890", "utf8");
    await assert.rejects(() => captureWorkspaceSnapshot(store, cwd, { workspaceId: "workspace_default", maxBytes: 5, now: "2026-08-26T04:00:00.000Z" }), (error) => error?.code === "quota_exceeded");
    assert.equal(store.listWorkspaceSnapshotManifests({ workspaceId: "workspace_default", limit: 10 }).length, 0);
  } finally {
    try { store.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
  }
});

test("snapshot GC expires old manifests and preserves shared blob references", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-snapshot-gc-"));
  const store = createSqliteRunStore(cwd);
  try {
    await writeFile(resolve(cwd, "shared.txt"), "shared\n", "utf8");
    const first = await captureWorkspaceSnapshot(store, cwd, { workspaceId: "workspace_default", now: "2026-08-20T00:00:00.000Z" });
    await writeFile(resolve(cwd, "only-first.txt"), "first\n", "utf8");
    const second = await captureWorkspaceSnapshot(store, cwd, { workspaceId: "workspace_default", now: "2026-08-21T00:00:00.000Z" });
    const shared = first.entries.find((entry) => entry.relativePath === "shared.txt");
    assert.equal(store.getWorkspaceSnapshotBlob(shared.blobSha256).refCount, 2);
    const result = await garbageCollectWorkspaceSnapshots(store, { maxSnapshots: 1, retentionDays: 3650, now: "2026-08-23T00:00:00.000Z" });
    assert.equal(result.expiredSnapshots, 1);
    assert.equal(store.getWorkspaceSnapshotManifest(first.manifest.id), undefined);
    assert.equal(store.getWorkspaceSnapshotManifest(second.manifest.id)?.state, "committed");
    assert.equal(store.getWorkspaceSnapshotBlob(shared.blobSha256).refCount, 1);
  } finally {
    try { store.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
  }
});

test("snapshot restore reuses a durable journal after all-before reconciliation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-snapshot-retry-journal-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-08-26T05:00:00.000Z";
  try {
    await writeFile(resolve(cwd, "file.txt"), "before\n", "utf8");
    const snapshot = await captureWorkspaceSnapshot(store, cwd, { workspaceId: "workspace_default", now });
    await writeFile(resolve(cwd, "file.txt"), "after\n", "utf8");
    const anchor = await createWorkspaceSnapshotUserRestoreAnchor(store, cwd, snapshot.manifest.id, now);
    const confirmation = store.createSnapshotRestoreConfirmation({ anchorId: anchor.id, snapshotId: snapshot.manifest.id, workspaceId: "workspace_default", createdAt: now });
    store.resolveSnapshotRestoreConfirmation(confirmation.id, "confirmed", now);
    const beforeDigest = createHash("sha256").update("after\n").digest("hex");
    const targetDigest = snapshot.entries.find((entry) => entry.relativePath === "file.txt").sha256;
    const request = store.createSnapshotRestoreRequest({
      idempotencyKey: "retry-journal",
      workspaceId: "workspace_default",
      anchorId: anchor.id,
      snapshotId: snapshot.manifest.id,
      expectedWorkspaceFingerprint: anchor.expectedWorkspaceFingerprint,
      expectedProvenanceWatermark: anchor.expectedProvenanceWatermark,
      confirmationId: confirmation.id,
      state: "staged",
      fencingEpoch: 1,
      journalEntryCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    store.createSnapshotRestoreJournalEntries([{
      restoreRequestId: request.id,
      sequence: 0,
      relativePath: "file.txt",
      expectedBeforeSha256: beforeDigest,
      expectedAfterSha256: targetDigest,
      targetBlobSha256: snapshot.entries.find((entry) => entry.relativePath === "file.txt").blobSha256,
      targetKind: "file",
      targetExists: true,
      updatedAt: now,
    }]);
    const reconciled = await reconcileWorkspaceSnapshotRestore(store, cwd, request.id);
    assert.equal(reconciled.state, "requested");
    const restored = await restoreWorkspaceSnapshot(store, cwd, { idempotencyKey: "retry-journal", anchorId: anchor.id, snapshotId: snapshot.manifest.id, confirmationId: confirmation.id });
    assert.equal(restored.state, "committed");
    assert.equal(await readFile(resolve(cwd, "file.txt"), "utf8"), "before\n");
    assert.equal(store.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id }).length, 1);
  } finally {
    try { store.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
  }
});
