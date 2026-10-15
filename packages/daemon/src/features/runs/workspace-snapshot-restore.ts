import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readdir, readlink, realpath, rename, rm, rmdir, stat, symlink, unlink } from "node:fs/promises";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CreateWorkspaceSnapshotEntryInput,
  SnapshotRestoreJournalEntry,
  SnapshotRestoreRequest,
  WorkspaceSnapshotEntry,
  WorkspaceSnapshotManifest,
  WorkspaceSnapshotPreview,
} from "@ling-stack/contracts";
import { DEFAULT_WORKSPACE_ID, type RunStore } from "@ling-stack/core";

const activeRestoreLocks = new Map<string, Promise<void>>();
const queuedRestoreJobs = new Map<string, Promise<SnapshotRestoreRequest>>();
const excludedRoots = new Set([".git", ".ling-stack"]);
const secretPartPattern = /(^|[._-])(env|secret|secrets|token|tokens|credential|credentials|private[-_]?key)([._-]|$)/iu;
const digestPattern = /^[0-9a-f]{64}$/u;

export class WorkspaceSnapshotRestoreError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "WorkspaceSnapshotRestoreError";
  }
}

export interface WorkspaceSnapshotCaptureOptions {
  readonly workspaceId?: string;
  readonly ttlMs?: number;
  readonly now?: string;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxFileBytes?: number;
  readonly maxSnapshots?: number;
  readonly captureKind?: "user_restore_point" | "compaction_boundary";
  readonly sourceTurnId?: string;
  readonly sourceRunId?: string;
  readonly sourceCheckpointId?: string;
}

export interface WorkspaceSnapshotCaptureResult {
  readonly manifest: WorkspaceSnapshotManifest;
  readonly entries: readonly WorkspaceSnapshotEntry[];
  readonly excludedPaths: readonly string[];
}

export async function captureWorkspaceSnapshot(
  store: RunStore,
  cwd: string,
  options: WorkspaceSnapshotCaptureOptions = {},
): Promise<WorkspaceSnapshotCaptureResult> {
  const root = await realpath(resolve(cwd));
  const now = options.now ?? new Date().toISOString();
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  return withWorkspaceSnapshotFence(store, root, workspaceId, "capture", async () => {
    if (options.maxSnapshots !== undefined && store.listWorkspaceSnapshotManifests({ workspaceId, limit: 10_000 }).filter((manifest) => ["committed", "sealed"].includes(manifest.state)).length >= options.maxSnapshots) {
      throw new WorkspaceSnapshotRestoreError(413, "quota_exceeded", `Workspace already has ${options.maxSnapshots} committed snapshots.`);
    }
    let scan = await scanWorkspace(root, store, true, options);
    if (scan.unstablePaths.length > 0) scan = await scanWorkspace(root, store, true, options);
    if (scan.unstablePaths.length > 0) throw new WorkspaceSnapshotRestoreError(409, "snapshot_unverified", `Workspace changed while snapshotting: ${scan.unstablePaths.join(", ")}`);
    const managedEntries = scan.entries.filter((entry) => entry.managed);
    const excludedEntries = scan.entries.filter((entry) => !entry.managed);
    if (options.captureKind === "compaction_boundary" && excludedEntries.some((entry) => entry.exclusionReason !== "control_path" && entry.exclusionReason !== "vcs_metadata")) {
      throw new WorkspaceSnapshotRestoreError(422, "snapshot_excluded_paths", `Compaction-boundary snapshot contains ${excludedEntries.length} excluded path(s).`);
    }
    const manifestSha256 = hashManifest({ root, fingerprint: scan.fingerprint, provenanceWatermark: store.getLatestWorkspaceProvenanceWatermark(workspaceId), entries: scan.entries });
    const result = store.commitWorkspaceSnapshot({
      id: `workspace_snapshot_${randomUUID()}`,
      workspaceId,
      cwd: root,
      canonicalRoot: root,
      fingerprint: scan.fingerprint,
      provenanceWatermark: store.getLatestWorkspaceProvenanceWatermark(workspaceId),
      entryCount: managedEntries.length,
      totalBytes: scan.managedBytes,
      createdAt: now,
      sealedAt: now,
      expiresAt: options.ttlMs && options.ttlMs > 0 ? new Date(Date.parse(now) + options.ttlMs).toISOString() : undefined,
      state: "committed",
      schemaVersion: 1,
      captureCwd: root,
      captureKind: options.captureKind ?? "user_restore_point",
      ...(options.sourceTurnId ? { sourceTurnId: options.sourceTurnId } : {}),
      ...(options.sourceRunId ? { sourceRunId: options.sourceRunId } : {}),
      ...(options.sourceCheckpointId ? { sourceCheckpointId: options.sourceCheckpointId } : {}),
      exclusionPolicySha256: exclusionPolicySha256(),
      managedEntryCount: managedEntries.length,
      excludedEntryCount: excludedEntries.length,
      managedBytes: scan.managedBytes,
      workspaceFingerprintSha256: scan.fingerprint,
      manifestSha256,
    }, scan.entries.map((entry) => ({ ...entry, manifestId: "pending" })));
    return { manifest: result.manifest, entries: result.entries, excludedPaths: scan.excludedPaths };
  });
}

export async function fingerprintWorkspace(cwd: string): Promise<string> {
  return (await scanWorkspace(await realpath(resolve(cwd)), undefined, false, {})).fingerprint;
}

/** Build a read-only preview; it never creates an anchor and never mutates the workspace. */
export async function previewWorkspaceSnapshot(store: RunStore, cwd: string, snapshotId: string): Promise<WorkspaceSnapshotPreview> {
  const manifest = store.getWorkspaceSnapshotManifest(snapshotId);
  if (!manifest) throw new WorkspaceSnapshotRestoreError(404, "snapshot_not_found", "Snapshot was not found.");
  const root = await realpath(resolve(cwd));
  if (resolve(manifest.canonicalRoot) !== root) throw new WorkspaceSnapshotRestoreError(409, "snapshot_anchor_mismatch", "Snapshot belongs to another workspace root.");
  if (!["committed", "sealed"].includes(manifest.state)) throw new WorkspaceSnapshotRestoreError(410, "snapshot_unavailable", "Snapshot is no longer restorable.");
  const entries = store.listWorkspaceSnapshotEntries(manifest.id);
  const current = await scanWorkspace(root, store, false, {});
  const targetManaged = new Map(entries.filter((entry) => entry.managed).map((entry) => [entry.relativePath, entry]));
  const currentManaged = new Map(current.entries.filter((entry) => entry.managed).map((entry) => [entry.relativePath, entry]));
  const operations = [...new Set([...targetManaged.keys(), ...currentManaged.keys()])].sort().map((relativePath) => {
    const target = targetManaged.get(relativePath);
    const observed = currentManaged.get(relativePath);
    const operation = !observed ? "create" : !target ? "delete" : entryDigest(target) === entryDigest(observed) && target.kind === observed.kind && target.mode === observed.mode ? "unchanged" : "update";
    return { relativePath, operation, kind: target?.kind ?? observed?.kind ?? "file", managed: true, sizeBytes: target?.sizeBytes ?? observed?.sizeBytes ?? 0 } as const;
  });
  return { manifest, entries, operations, currentFingerprint: current.fingerprint, targetFingerprint: manifest.fingerprint, fingerprintStatus: current.fingerprint === manifest.fingerprint ? "matching" : "changed" };
}

/** Create an anchor for an explicit user restore point with no Turn/compaction lineage. */
export async function createWorkspaceSnapshotUserRestoreAnchor(store: RunStore, cwd: string, snapshotId: string, now = new Date().toISOString()) {
  const manifest = store.getWorkspaceSnapshotManifest(snapshotId);
  if (!manifest) throw new WorkspaceSnapshotRestoreError(404, "snapshot_not_found", "Snapshot was not found.");
  const root = await realpath(resolve(cwd));
  if (resolve(manifest.canonicalRoot) !== root) throw new WorkspaceSnapshotRestoreError(409, "snapshot_anchor_mismatch", "Snapshot belongs to another workspace root.");
  if (!manifest.exclusionPolicySha256 || manifest.exclusionPolicySha256 !== exclusionPolicySha256()) throw new WorkspaceSnapshotRestoreError(409, "snapshot_policy_drift", "Snapshot exclusion policy differs from the current daemon policy.");
  const current = await scanWorkspace(root, store, false, {});
  return store.createWorkspaceSnapshotRestoreAnchor({
    workspaceId: manifest.workspaceId,
    baselineSnapshotId: manifest.id,
    baselineFingerprint: manifest.fingerprint,
    baselineProvenanceWatermark: manifest.provenanceWatermark,
    expectedWorkspaceFingerprint: current.fingerprint,
    expectedProvenanceWatermark: store.getLatestWorkspaceProvenanceWatermark(manifest.workspaceId),
    createdAt: now,
    ...(manifest.expiresAt ? { expiresAt: manifest.expiresAt } : {}),
  });
}

export async function createWorkspaceSnapshotRestoreAnchor(
  store: RunStore,
  input: Parameters<RunStore["createWorkspaceSnapshotRestoreAnchor"]>[0],
) {
  if (!input.threadId || !input.targetTurnId || !input.checkpointId) throw new WorkspaceSnapshotRestoreError(422, "snapshot_anchor_lineage_required", "Turn restore anchors require thread, target Turn, and compaction checkpoint lineage.");
  const manifest = store.getWorkspaceSnapshotManifest(input.baselineSnapshotId);
  if (!manifest || !["committed", "sealed"].includes(manifest.state)) throw new WorkspaceSnapshotRestoreError(409, "snapshot_unverified", "Baseline snapshot is not committed.");
  if (manifest.fingerprint !== input.baselineFingerprint || manifest.provenanceWatermark !== input.baselineProvenanceWatermark) {
    throw new WorkspaceSnapshotRestoreError(409, "snapshot_anchor_mismatch", "Baseline snapshot does not match the requested restore anchor.");
  }
  const excludedEntries = store.listWorkspaceSnapshotEntries(manifest.id).filter((entry) => !entry.managed);
  if (excludedEntries.some((entry) => entry.exclusionReason !== "control_path" && entry.exclusionReason !== "vcs_metadata")) throw new WorkspaceSnapshotRestoreError(422, "snapshot_excluded_paths", "A Turn restore anchor cannot use a partially covered snapshot.");
  const checkpoint = store.getCompactionCheckpoint(input.checkpointId);
  if (!checkpoint || checkpoint.threadId !== input.threadId || checkpoint.workspaceId !== (input.workspaceId ?? checkpoint.workspaceId)) {
    throw new WorkspaceSnapshotRestoreError(409, "snapshot_anchor_mismatch", "Compaction checkpoint does not match the restore anchor.");
  }
  return store.createWorkspaceSnapshotRestoreAnchor(input);
}

export async function restoreWorkspaceSnapshot(
  store: RunStore,
  cwd: string,
  input: {
    readonly idempotencyKey: string;
    readonly anchorId: string;
    readonly snapshotId: string;
    readonly expectedWorkspaceFingerprint?: string;
    readonly expectedProvenanceWatermark?: string;
    readonly confirmationId?: string;
    readonly now?: string;
  },
): Promise<SnapshotRestoreRequest> {
  return executeWorkspaceSnapshotRestore(store, cwd, input);
}

/** A queued failure handler is admitted only while this worker owns the restore lock. */
async function executeWorkspaceSnapshotRestore(
  store: RunStore,
  cwd: string,
  input: Parameters<typeof restoreWorkspaceSnapshot>[2],
  onLockedFailure?: (error: unknown) => SnapshotRestoreRequest,
): Promise<SnapshotRestoreRequest> {
  const root = await realpath(resolve(cwd));
  if (!input.idempotencyKey.trim()) throw new WorkspaceSnapshotRestoreError(400, "idempotency_key_required", "Snapshot restore requires an idempotency key.");
  return withRestoreLock(root, async () => {
    try { return await restoreWorkspaceSnapshotLocked(store, root, input); }
    catch (error) {
      if (onLockedFailure) return onLockedFailure(error);
      throw error;
    }
  }, onLockedFailure !== undefined);
}

/**
 * Queue a restore behind a durable request. The caller receives 202 for a new
 * or in-flight request; the existing synchronous function remains the worker
 * used by recovery/replay and by direct daemon integrations.
 */
export async function queueWorkspaceSnapshotRestore(
  store: RunStore,
  cwd: string,
  input: Parameters<typeof restoreWorkspaceSnapshot>[2],
): Promise<SnapshotRestoreRequest> {
  const root = await realpath(resolve(cwd));
  if (!input.idempotencyKey.trim()) throw new WorkspaceSnapshotRestoreError(400, "idempotency_key_required", "Snapshot restore requires an idempotency key.");
  const now = input.now ?? new Date().toISOString();
  const anchor = store.getWorkspaceSnapshotRestoreAnchor(input.anchorId);
  const manifest = store.getWorkspaceSnapshotManifest(input.snapshotId);
  if (!anchor || !manifest) throw new WorkspaceSnapshotRestoreError(404, "snapshot_not_found", "Snapshot restore anchor or manifest was not found.");
  if (anchor.expiresAt && Date.parse(anchor.expiresAt) <= Date.parse(now)) throw new WorkspaceSnapshotRestoreError(410, "anchor_expired", "Snapshot restore anchor has expired.");
  if (manifest.expiresAt && Date.parse(manifest.expiresAt) <= Date.parse(now)) throw new WorkspaceSnapshotRestoreError(410, "snapshot_expired", "Snapshot has expired.");
  if (anchor.baselineSnapshotId !== manifest.id || manifest.workspaceId !== anchor.workspaceId || resolve(manifest.canonicalRoot) !== root) throw new WorkspaceSnapshotRestoreError(409, "snapshot_anchor_mismatch", "Snapshot restore target does not match this workspace.");
  if (!["committed", "sealed"].includes(manifest.state)) throw new WorkspaceSnapshotRestoreError(422, "snapshot_unverified", "Only a committed snapshot can be restored.");
  if (!input.confirmationId) throw new WorkspaceSnapshotRestoreError(409, "confirmation_required", "A durable local-user restore confirmation is required.");
  const confirmation = store.getSnapshotRestoreConfirmation(input.confirmationId);
  if (!confirmation || confirmation.workspaceId !== anchor.workspaceId || confirmation.anchorId !== anchor.id || confirmation.snapshotId !== manifest.id) throw new WorkspaceSnapshotRestoreError(409, "confirmation_mismatch", "Restore confirmation does not match this snapshot anchor.");
  if (confirmation.state !== "confirmed") throw new WorkspaceSnapshotRestoreError(409, "confirmation_required", "A durable local-user restore confirmation is required.");
  const expectedFingerprint = input.expectedWorkspaceFingerprint ?? anchor.expectedWorkspaceFingerprint;
  const expectedWatermark = input.expectedProvenanceWatermark ?? anchor.expectedProvenanceWatermark;
  let request = store.getSnapshotRestoreRequestByIdempotency(anchor.workspaceId, input.idempotencyKey);
  if (request) {
    if (request.anchorId !== anchor.id || request.snapshotId !== manifest.id || request.expectedWorkspaceFingerprint !== expectedFingerprint || request.expectedProvenanceWatermark !== expectedWatermark) throw new WorkspaceSnapshotRestoreError(409, "idempotency_conflict", "Idempotency key is bound to another restore target.");
    if (request.state === "committed") return request;
    if (["failed", "conflict", "expired", "recovery_required"].includes(request.state)) throw new WorkspaceSnapshotRestoreError(409, "restore_terminal", request.lastError ?? `Restore request is ${request.state}; use a new idempotency key.`);
  } else {
    request = store.createSnapshotRestoreRequest({ idempotencyKey: input.idempotencyKey, workspaceId: anchor.workspaceId, anchorId: anchor.id, snapshotId: manifest.id, expectedWorkspaceFingerprint: expectedFingerprint, expectedProvenanceWatermark: expectedWatermark, confirmationId: input.confirmationId, createdAt: now, updatedAt: now });
  }
  if (!queuedRestoreJobs.has(request.id)) {
    const queuedRequest = request;
    const job = Promise.resolve().then(() => executeWorkspaceSnapshotRestore(store, root, { ...input, expectedWorkspaceFingerprint: expectedFingerprint, expectedProvenanceWatermark: expectedWatermark }, (error) => {
      const current = store.getSnapshotRestoreRequest(request!.id);
      if (current && ["requested", "validating"].includes(current.state)
        && current.fencingEpoch === queuedRequest.fencingEpoch
        && !store.getWorkspaceSnapshotFence(current.workspaceId).ownerRequestId
        && store.listSnapshotRestoreJournalEntries({ restoreRequestId: current.id, limit: 1 }).length === 0) {
        const state = error instanceof WorkspaceSnapshotRestoreError && error.statusCode === 410 ? "expired" : error instanceof WorkspaceSnapshotRestoreError && error.statusCode === 409 ? "conflict" : "failed";
        return store.updateSnapshotRestoreRequest({ id: current.id, expectedState: current.state, state, lastError: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() }) ?? current;
      }
      return current ?? queuedRequest;
    })).catch(() => {
      // The HTTP request has already returned the durable request ID. Keep
      // background failures observable through that record, not as an
      // unhandled rejection. Failing before lock admission (including busy)
      // grants no authority to terminalize another worker's durable request.
      return store.getSnapshotRestoreRequest(queuedRequest.id) ?? queuedRequest;
    }).finally(() => { queuedRestoreJobs.delete(request!.id); });
    queuedRestoreJobs.set(request.id, job);
  }
  return request;
}

export async function isWorkspaceSnapshotRestoreActive(cwd: string): Promise<boolean> {
  return activeRestoreLocks.has(await realpath(resolve(cwd)));
}

export async function reconcileWorkspaceSnapshotRestore(store: RunStore, cwd: string, restoreRequestId: string): Promise<SnapshotRestoreRequest> {
  const request = store.getSnapshotRestoreRequest(restoreRequestId);
  if (!request) throw new WorkspaceSnapshotRestoreError(404, "restore_not_found", "Snapshot restore request was not found.");
  if (["committed", "failed", "conflict", "expired", "recovery_required"].includes(request.state)) return request;
  const manifest = store.getWorkspaceSnapshotManifest(request.snapshotId);
  if (!manifest) throw new WorkspaceSnapshotRestoreError(409, "snapshot_missing", "Snapshot manifest is missing.");
  const journal = store.listSnapshotRestoreJournalEntries({ restoreRequestId, limit: 100_000 });
  const root = await realpath(resolve(cwd));
  const currentFingerprint = await fingerprintWorkspace(root);
  const currentWatermark = store.getLatestWorkspaceProvenanceWatermark(request.workspaceId);
  const expectedFencingEpoch = reconciliationExpectedEpoch(store, request);
  if (!journal.length) {
    if (currentFingerprint === request.expectedWorkspaceFingerprint && currentWatermark === request.expectedProvenanceWatermark) {
      const reset = request.state === "requested" ? request : store.updateSnapshotRestoreRequest({ id: request.id, expectedState: request.state, state: "requested", expectedFencingEpoch, updatedAt: new Date().toISOString() });
      if (reset) store.releaseWorkspaceSnapshotFence(request.workspaceId, request.id, new Date().toISOString(), request.fencingEpoch);
      return reset ?? store.getSnapshotRestoreRequest(request.id)!;
    }
    return store.updateSnapshotRestoreRequest({ id: request.id, expectedState: request.state, state: "recovery_required", expectedFencingEpoch, lastError: "Workspace changed before the restore plan was durably staged; manual review is required.", updatedAt: new Date().toISOString() }) ?? store.getSnapshotRestoreRequest(request.id)!;
  }
  let allAfter = true;
  let allBefore = true;
  for (const entry of journal) {
    if (!await journalEntryMatches(root, entry, "after")) allAfter = false;
    if (!await journalEntryMatches(root, entry, "before")) allBefore = false;
  }
  reconciliationExpectedEpoch(store, request);
  const now = new Date().toISOString();
  if (allAfter && currentFingerprint === manifest.fingerprint) {
    for (const entry of journal) {
      if (entry.state === "pending") {
        if (!store.updateSnapshotRestoreJournalEntry({ id: entry.id, expectedState: "pending", state: "applied", expectedFencingEpoch, updatedAt: now })) throw new WorkspaceSnapshotRestoreError(409, "restore_journal_conflict", `Restore journal entry was superseded: ${entry.relativePath}`);
      }
    }
    const committed = store.updateSnapshotRestoreRequest({ id: request.id, expectedState: request.state, state: "committed", expectedFencingEpoch, updatedAt: now });
    if (committed) store.releaseWorkspaceSnapshotFence(request.workspaceId, request.id, now, request.fencingEpoch);
    return committed ?? store.getSnapshotRestoreRequest(request.id)!;
  }
  if (allBefore && currentFingerprint === request.expectedWorkspaceFingerprint && currentWatermark === request.expectedProvenanceWatermark) {
    const reset = store.updateSnapshotRestoreRequest({ id: request.id, expectedState: request.state, state: "requested", expectedFencingEpoch, updatedAt: now });
    if (reset) store.releaseWorkspaceSnapshotFence(request.workspaceId, request.id, now, request.fencingEpoch);
    return reset ?? store.getSnapshotRestoreRequest(request.id)!;
  }
  return store.updateSnapshotRestoreRequest({ id: request.id, expectedState: request.state, state: "recovery_required", expectedFencingEpoch, lastError: "Workspace is in a mixed restore state; manual review is required.", updatedAt: now }) ?? store.getSnapshotRestoreRequest(request.id)!;
}

export async function garbageCollectWorkspaceSnapshots(
  store: RunStore,
  options: { readonly maxSnapshots?: number; readonly retentionDays?: number; readonly now?: string } = {},
): Promise<{ readonly expiredSnapshots: number; readonly deletedBlobs: number; readonly reclaimedBytes: number }> {
  const now = options.now ?? new Date().toISOString();
  const cutoff = Date.parse(now) - (options.retentionDays ?? 30) * 86_400_000;
  const workspaceId = DEFAULT_WORKSPACE_ID;
  const manifests = store.listWorkspaceSnapshotManifests({ workspaceId, limit: 10_000 });
  let expiredSnapshots = 0;
  let reclaimedBytes = 0;
  const maxSnapshots = options.maxSnapshots ?? 8;
  const committed = manifests.filter((manifest) => ["committed", "sealed"].includes(manifest.state));
  const expire = committed.filter((manifest, index) => (manifest.expiresAt && Date.parse(manifest.expiresAt) <= Date.parse(now)) || Date.parse(manifest.createdAt) < cutoff || index >= maxSnapshots);
  for (const manifest of expire) {
    if (store.expireWorkspaceSnapshotManifest(manifest.id, now)) {
      expiredSnapshots += 1;
      reclaimedBytes += manifest.totalBytes;
      store.deleteWorkspaceSnapshotManifest(manifest.id);
    }
  }
  // Rows with refCount=0 are safe only after their object age exceeds the grace period.
  const expired = store.listWorkspaceSnapshotManifests({ workspaceId, state: "expired", limit: 10_000 });
  const activeRequestSnapshotIds = new Set(store.listSnapshotRestoreRequests({ workspaceId, limit: 100_000 }).filter((request) => !["committed", "failed", "conflict", "expired"].includes(request.state)).map((request) => request.snapshotId));
  for (const manifest of expired) if (!activeRequestSnapshotIds.has(manifest.id)) store.deleteWorkspaceSnapshotManifest(manifest.id);
  let deletedBlobs = 0;
  const protectedBlobs = new Set<string>();
  for (const request of store.listSnapshotRestoreRequests({ workspaceId, limit: 100_000 })) {
    for (const journal of store.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id, limit: 100_000 })) {
      if (journal.rollbackBlobSha256) protectedBlobs.add(journal.rollbackBlobSha256);
      if (journal.targetBlobSha256) protectedBlobs.add(journal.targetBlobSha256);
    }
  }
  for (const blob of store.listWorkspaceSnapshotBlobs()) {
    if (blob.refCount > 0 || protectedBlobs.has(blob.sha256) || Date.parse(blob.createdAt) > Date.parse(now) - 86_400_000) continue;
    const objectPath = join(store.paths.snapshotBlobsDir, blob.sha256);
    if (await exists(objectPath)) {
      const size = (await stat(objectPath)).size;
      await rm(objectPath, { force: true });
      if (store.deleteWorkspaceSnapshotBlob(blob.sha256)) { deletedBlobs += 1; reclaimedBytes += size; }
    } else if (store.deleteWorkspaceSnapshotBlob(blob.sha256)) {
      deletedBlobs += 1;
    }
  }
  try {
    for (const name of await readdir(store.paths.snapshotStagingDir)) {
      const stagingPath = join(store.paths.snapshotStagingDir, name);
      const info = await stat(stagingPath);
      if (info.mtimeMs <= Date.parse(now) - 86_400_000) await rm(stagingPath, { force: true });
    }
  } catch {
    // Staging cleanup is best effort; object/SQLite GC remains authoritative.
  }
  return { expiredSnapshots, deletedBlobs, reclaimedBytes };
}

async function restoreWorkspaceSnapshotLocked(
  store: RunStore,
  root: string,
  input: Parameters<typeof restoreWorkspaceSnapshot>[2],
): Promise<SnapshotRestoreRequest> {
  const now = input.now ?? new Date().toISOString();
  const anchor = store.getWorkspaceSnapshotRestoreAnchor(input.anchorId);
  const manifest = store.getWorkspaceSnapshotManifest(input.snapshotId);
  if (!anchor || !manifest) throw new WorkspaceSnapshotRestoreError(404, "snapshot_not_found", "Snapshot restore anchor or manifest was not found.");
  if (anchor.expiresAt && Date.parse(anchor.expiresAt) <= Date.parse(now)) throw new WorkspaceSnapshotRestoreError(410, "anchor_expired", "Snapshot restore anchor has expired.");
  const workspaceId = anchor.workspaceId ?? DEFAULT_WORKSPACE_ID;
  if (anchor.baselineSnapshotId !== manifest.id || anchor.workspaceId !== workspaceId || manifest.workspaceId !== workspaceId || resolve(manifest.canonicalRoot) !== root) {
    throw new WorkspaceSnapshotRestoreError(409, "snapshot_anchor_mismatch", "Snapshot restore target does not match this workspace.");
  }
  if (!["committed", "sealed"].includes(manifest.state)) throw new WorkspaceSnapshotRestoreError(409, "snapshot_unverified", "Only a committed snapshot can be restored.");
  if (manifest.exclusionPolicySha256 && manifest.exclusionPolicySha256 !== exclusionPolicySha256()) throw new WorkspaceSnapshotRestoreError(409, "snapshot_policy_drift", "Snapshot exclusion policy differs from the current daemon policy.");
  if (manifest.expiresAt && Date.parse(manifest.expiresAt) <= Date.parse(now)) throw new WorkspaceSnapshotRestoreError(410, "snapshot_expired", "Snapshot has expired.");
  const expectedFingerprint = input.expectedWorkspaceFingerprint ?? anchor.expectedWorkspaceFingerprint;
  const expectedWatermark = input.expectedProvenanceWatermark ?? anchor.expectedProvenanceWatermark;
  let existing = store.getSnapshotRestoreRequestByIdempotency(workspaceId, input.idempotencyKey);
  if (existing) {
    if (existing.anchorId !== anchor.id || existing.snapshotId !== manifest.id) throw new WorkspaceSnapshotRestoreError(409, "idempotency_conflict", "Idempotency key is bound to another restore target.");
    if (existing.expectedWorkspaceFingerprint !== expectedFingerprint || existing.expectedProvenanceWatermark !== expectedWatermark) throw new WorkspaceSnapshotRestoreError(409, "idempotency_conflict", "Idempotency key is bound to a different workspace compare-and-swap target.");
    if (existing.state === "committed") return existing;
    if (existing.state === "recovery_required") throw new WorkspaceSnapshotRestoreError(409, "recovery_required", existing.lastError ?? "Restore requires manual recovery.");
    if (["conflict", "failed", "expired"].includes(existing.state)) throw new WorkspaceSnapshotRestoreError(409, "restore_terminal", existing.lastError ?? `Restore request is ${existing.state}; use a new idempotency key.`);
    if (["validating", "fenced", "staged", "committing", "verifying"].includes(existing.state)) {
      const reconciled = await reconcileWorkspaceSnapshotRestore(store, root, existing.id);
      if (reconciled.state === "committed") return reconciled;
      if (reconciled.state === "recovery_required") throw new WorkspaceSnapshotRestoreError(409, "recovery_required", reconciled.lastError ?? "Restore requires manual recovery.");
      if (reconciled.state !== "requested") throw new WorkspaceSnapshotRestoreError(409, "restore_claim_conflict", `Restore request is already in ${reconciled.state}.`);
      existing = reconciled;
    }
  }
  if (!input.confirmationId) throw new WorkspaceSnapshotRestoreError(409, "confirmation_required", "A durable local-user restore confirmation is required.");
  const confirmation = store.getSnapshotRestoreConfirmation(input.confirmationId);
  if (!confirmation || confirmation.workspaceId !== workspaceId || confirmation.anchorId !== anchor.id || confirmation.snapshotId !== manifest.id) throw new WorkspaceSnapshotRestoreError(409, "confirmation_mismatch", "Restore confirmation does not match this snapshot anchor.");
  if (confirmation.state !== "confirmed") throw new WorkspaceSnapshotRestoreError(409, "confirmation_required", "A durable local-user restore confirmation is required.");
  const confirmationUse = store.listSnapshotRestoreRequests({ workspaceId, limit: 100_000 }).find((request) => request.confirmationId === input.confirmationId && request.id !== existing?.id);
  if (confirmationUse) throw new WorkspaceSnapshotRestoreError(409, "confirmation_consumed", "Restore confirmation has already been bound to another request.");
  if (await hasActiveWorkspaceRun(store, root)) throw new WorkspaceSnapshotRestoreError(409, "workspace_busy", "Workspace has an active Run or approval; restore is fenced until it is terminal.");
  const current = await scanWorkspace(root, store, false, {});
  if (current.fingerprint !== expectedFingerprint) throw new WorkspaceSnapshotRestoreError(409, "workspace_fingerprint_conflict", "Workspace fingerprint changed since the restore anchor was created.");
  if (store.getLatestWorkspaceProvenanceWatermark(workspaceId) !== expectedWatermark) throw new WorkspaceSnapshotRestoreError(409, "provenance_watermark_conflict", "Workspace provenance changed since the restore anchor was created.");
  const entries = store.listWorkspaceSnapshotEntries(manifest.id);
  assertNoExcludedCollision(current.entries, entries.filter((entry) => entry.managed));
  await assertSnapshotIntegrity(store, root, entries);
  if (manifest.manifestSha256 && hashManifest({ root: manifest.canonicalRoot, fingerprint: manifest.fingerprint, provenanceWatermark: manifest.provenanceWatermark, entries: entries.map((entry) => ({ relativePath: entry.relativePath, kind: entry.kind, managed: entry.managed, exclusionReason: entry.exclusionReason, symlinkTarget: entry.symlinkTarget, sizeBytes: entry.sizeBytes, sha256: entry.sha256, blobSha256: entry.blobSha256, mode: entry.mode })) }) !== manifest.manifestSha256) {
    throw new WorkspaceSnapshotRestoreError(409, "snapshot_corrupt", "Snapshot manifest integrity verification failed.");
  }
  const request = existing ?? store.createSnapshotRestoreRequest({
    idempotencyKey: input.idempotencyKey,
    workspaceId,
    anchorId: anchor.id,
    snapshotId: manifest.id,
    expectedWorkspaceFingerprint: expectedFingerprint,
    expectedProvenanceWatermark: expectedWatermark,
    confirmationId: input.confirmationId,
    createdAt: now,
    updatedAt: now,
  });
  let lifecycleState = request.state;
  if (lifecycleState === "requested") {
    const validating = store.updateSnapshotRestoreRequest({ id: request.id, expectedState: "requested", state: "validating", updatedAt: now });
    if (!validating) throw new WorkspaceSnapshotRestoreError(409, "restore_claim_conflict", "Another restore request owns this idempotency key.");
    lifecycleState = "validating";
  }
  if (lifecycleState !== "validating") throw new WorkspaceSnapshotRestoreError(409, "restore_claim_conflict", `Restore request is already in ${lifecycleState}.`);
  const epoch = store.acquireWorkspaceSnapshotFence(workspaceId, request.id, now);
  if (await hasActiveWorkspaceRun(store, root)) {
    store.releaseWorkspaceSnapshotFence(workspaceId, request.id, new Date().toISOString(), epoch);
    throw new WorkspaceSnapshotRestoreError(409, "workspace_busy", "A Run became active while restore fencing was acquired.");
  }
  const fenced = store.updateSnapshotRestoreRequest({ id: request.id, expectedState: "validating", state: "fenced", fencingEpoch: epoch, updatedAt: now });
  if (!fenced) {
    store.releaseWorkspaceSnapshotFence(workspaceId, request.id, new Date().toISOString(), epoch);
    throw new WorkspaceSnapshotRestoreError(409, "restore_claim_conflict", "Another restore request owns this idempotency key.");
  }
  lifecycleState = "fenced";
  let workspaceEffectsAttempted = false;
  try {
    let journal = store.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id, limit: 100_000 });
    if (journal.length === 0) {
      const plan = await buildRestorePlan(root, entries.filter((entry) => entry.managed), store, current.entries.filter((entry) => entry.managed));
      journal = store.createSnapshotRestoreJournalEntries(plan.map((entry, sequence) => ({ ...entry, restoreRequestId: request.id, sequence, updatedAt: now })));
    } else {
      // A restart may reconcile a staged request back to `requested` after
      // confirming that every entry is still at its pre-restore digest. Keep
      // the durable plan and reset only recoverable journal states; inserting
      // a second plan would violate the request's unique path constraint.
      for (const entry of journal) {
        if (entry.state === "pending") continue;
        if (entry.state !== "applied" && entry.state !== "rolled_back") {
          throw new WorkspaceSnapshotRestoreError(409, "recovery_required", `Restore journal entry ${entry.relativePath} is not retryable.`);
        }
        if (!store.updateSnapshotRestoreJournalEntry({ id: entry.id, expectedState: entry.state, state: "pending", expectedFencingEpoch: epoch, updatedAt: now })) {
          throw new WorkspaceSnapshotRestoreError(409, "restore_journal_conflict", `Restore journal entry was superseded: ${entry.relativePath}`);
        }
      }
      journal = store.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id, limit: 100_000 });
    }
    const staged = store.updateSnapshotRestoreRequest({ id: request.id, expectedState: "fenced", state: "staged", fencingEpoch: epoch, expectedFencingEpoch: epoch, journalEntryCount: journal.length, updatedAt: now });
    if (!staged) throw new WorkspaceSnapshotRestoreError(409, "restore_claim_conflict", "Restore request was superseded.");
    lifecycleState = "staged";
    const committing = store.updateSnapshotRestoreRequest({ id: request.id, expectedState: "staged", state: "committing", fencingEpoch: epoch, expectedFencingEpoch: epoch, updatedAt: new Date().toISOString() });
    if (!committing) throw new WorkspaceSnapshotRestoreError(409, "restore_claim_conflict", "Restore request was superseded.");
    lifecycleState = "committing";
    const attempted: typeof journal = [];
    try {
      for (const entry of journal) {
        assertRestoreOwnership(store, request, epoch, lifecycleState);
        if (!await journalEntryMatches(root, entry, "before")) throw new WorkspaceSnapshotRestoreError(409, "workspace_changed_during_restore", `Workspace changed before ${entry.relativePath} was applied.`);
        assertRestoreOwnership(store, request, epoch, lifecycleState);
        // A failing syscall can follow a successful unlink/rename/chmod.
        // Attempted is not applied, but it must participate in recovery.
        attempted.push(entry);
        workspaceEffectsAttempted = true;
        await applyJournalEntry(root, entry, store);
        if (!await journalEntryMatches(root, entry, "after")) throw new WorkspaceSnapshotRestoreError(500, "restore_verify_failed", `Restore verification failed for ${entry.relativePath}.`);
        assertRestoreOwnership(store, request, epoch, lifecycleState);
        if (!store.updateSnapshotRestoreJournalEntry({ id: entry.id, expectedState: "pending", state: "applied", expectedFencingEpoch: epoch, updatedAt: new Date().toISOString() })) throw new WorkspaceSnapshotRestoreError(409, "restore_journal_conflict", `Restore journal entry was superseded: ${entry.relativePath}`);
        assertRestoreOwnership(store, request, epoch, lifecycleState);
      }
      const verifying = store.updateSnapshotRestoreRequest({ id: request.id, expectedState: "committing", state: "verifying", fencingEpoch: epoch, expectedFencingEpoch: epoch, updatedAt: new Date().toISOString() });
      if (!verifying) throw new WorkspaceSnapshotRestoreError(409, "restore_claim_conflict", "Restore request was superseded.");
      lifecycleState = "verifying";
      const finalFingerprint = await fingerprintWorkspace(root);
      if (finalFingerprint !== manifest.fingerprint) throw new WorkspaceSnapshotRestoreError(500, "restore_fingerprint_failed", "Workspace fingerprint does not match the snapshot after restore.");
      assertRestoreOwnership(store, request, epoch, lifecycleState);
    } catch (error) {
      const rollbackError = await rollbackAttemptedEntries(root, attempted, store, request, epoch, lifecycleState);
      const beforeError = await verifyJournalBeforeState(root, journal);
      let recoveryError = rollbackError ?? beforeError;
      try { assertRestoreOwnership(store, request, epoch, lifecycleState); }
      catch (ownershipError) { recoveryError ??= ownershipError instanceof Error ? ownershipError.message : String(ownershipError); }
      const message = recoveryError ? `${error instanceof Error ? error.message : String(error)}; rollback unverified: ${recoveryError}` : (error instanceof Error ? error.message : String(error));
      const currentRequest = store.getSnapshotRestoreRequest(request.id);
      if (currentRequest?.state === lifecycleState && currentRequest.fencingEpoch === epoch) {
        if (!store.updateSnapshotRestoreRequest({ id: request.id, expectedState: lifecycleState, state: recoveryError ? "recovery_required" : "failed", fencingEpoch: epoch, expectedFencingEpoch: epoch, lastError: message, updatedAt: new Date().toISOString() })) {
          throw new WorkspaceSnapshotRestoreError(409, "restore_claim_conflict", `${message}; restore outcome was superseded.`);
        }
      }
      throw error instanceof WorkspaceSnapshotRestoreError ? error : new WorkspaceSnapshotRestoreError(500, "restore_failed", message);
    }
    const committed = store.updateSnapshotRestoreRequest({ id: request.id, expectedState: "verifying", state: "committed", fencingEpoch: epoch, expectedFencingEpoch: epoch, updatedAt: new Date().toISOString() });
    if (!committed) throw new WorkspaceSnapshotRestoreError(409, "restore_claim_conflict", "Restore commit outcome was superseded.");
    return committed;
  } catch (error) {
    const currentRequest = store.getSnapshotRestoreRequest(request.id);
    if (currentRequest?.state === lifecycleState && currentRequest.fencingEpoch === epoch
      && !["committed", "failed", "conflict", "expired", "recovery_required"].includes(currentRequest.state)) {
      store.updateSnapshotRestoreRequest({
        id: request.id,
        expectedState: lifecycleState,
        state: workspaceEffectsAttempted ? "recovery_required" : "failed",
        fencingEpoch: epoch,
        expectedFencingEpoch: epoch,
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      });
    }
    throw error;
  } finally {
    const completed = store.getSnapshotRestoreRequest(request.id);
    const fence = store.getWorkspaceSnapshotFence(workspaceId);
    if (completed?.fencingEpoch === epoch && ["committed", "failed", "conflict", "expired"].includes(completed.state)
      && fence.ownerRequestId === request.id && fence.epoch === epoch) {
      store.releaseWorkspaceSnapshotFence(workspaceId, request.id, new Date().toISOString(), epoch);
    }
  }
}

function assertNoExcludedCollision(currentEntries: readonly ScannedEntry[], targetEntries: readonly WorkspaceSnapshotEntry[]): void {
  const excluded = currentEntries.filter((entry) => !entry.managed);
  for (const target of targetEntries) {
    for (const entry of excluded) {
      const targetCoversExcluded = target.kind !== "directory" && entry.relativePath.startsWith(`${target.relativePath}/`);
      const targetIsInsideExcluded = target.relativePath.startsWith(`${entry.relativePath}/`);
      if (entry.relativePath === target.relativePath || targetCoversExcluded || targetIsInsideExcluded) {
        throw new WorkspaceSnapshotRestoreError(409, "excluded_path_conflict", `Restore target intersects excluded path ${entry.relativePath} (${entry.exclusionReason ?? "unsupported_type"}).`);
      }
    }
  }
}

interface ScanResult {
  readonly entries: readonly ScannedEntry[];
  readonly fingerprint: string;
  readonly managedBytes: number;
  readonly excludedPaths: readonly string[];
  readonly unstablePaths: readonly string[];
}
interface ScannedEntry {
  readonly relativePath: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly managed: boolean;
  readonly exclusionReason?: "control_path" | "vcs_metadata" | "secret_like_path" | "too_large" | "unsupported_type" | "external_symlink" | "case_collision";
  readonly symlinkTarget?: string;
  readonly sizeBytes: number;
  readonly sha256?: string;
  readonly blobSha256?: string;
  readonly mode?: number;
}

async function scanWorkspace(root: string, store: RunStore | undefined, persistBlobs: boolean, options: WorkspaceSnapshotCaptureOptions): Promise<ScanResult> {
  const entries: ScannedEntry[] = [];
  const excludedPaths: string[] = [];
  const unstablePaths: string[] = [];
  let managedBytes = 0;
  const seenCaseInsensitive = new Map<string, string>();
  const addExcluded = async (absolute: string, rel: string, reason: ScannedEntry["exclusionReason"]): Promise<void> => {
    const info = await lstat(absolute);
    const kind = info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : "file";
    entries.push({ relativePath: rel, kind, managed: false, exclusionReason: reason, sizeBytes: info.isFile() ? info.size : 0, mode: info.mode & 0o777,
      ...(info.isSymbolicLink() ? { symlinkTarget: await readlink(absolute) } : {}) });
    excludedPaths.push(rel);
  };
  const isWithinRoot = (candidate: string): boolean => {
    const relation = relative(root, resolve(candidate));
    return relation === "" || (!relation.startsWith("..") && !relation.startsWith(sep) && !relation.includes(`${sep}..${sep}`));
  };
  const walk = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolute = join(directory, child.name);
      const rel = relative(root, absolute).split(sep).join("/");
      if (excludedRoots.has(child.name)) { await addExcluded(absolute, rel, child.name === ".git" ? "vcs_metadata" : "control_path"); continue; }
      if (secretPartPattern.test(child.name)) { await addExcluded(absolute, rel, "secret_like_path"); continue; }
      const caseKey = rel.normalize("NFC").toLocaleLowerCase();
      const priorCasePath = seenCaseInsensitive.get(caseKey);
      if (priorCasePath && priorCasePath !== rel) { await addExcluded(absolute, rel, "case_collision"); continue; }
      seenCaseInsensitive.set(caseKey, rel);
      if (child.isSymbolicLink()) {
        const target = await readlink(absolute);
        const targetPath = resolve(dirname(absolute), target);
        const targetRelation = relative(root, targetPath);
        const internal = !isAbsolute(target) && isWithinRoot(targetPath) && !targetRelation.split(sep).some((part) => excludedRoots.has(part) || secretPartPattern.test(part));
        const info = await lstat(absolute);
        if (!internal) { entries.push({ relativePath: rel, kind: "symlink", managed: false, exclusionReason: "external_symlink", symlinkTarget: target, sizeBytes: 0, mode: info.mode & 0o777 }); excludedPaths.push(rel); continue; }
        entries.push({ relativePath: rel, kind: "symlink", managed: true, symlinkTarget: target, sizeBytes: 0, mode: info.mode & 0o777 });
        continue;
      }
      if (child.isDirectory()) {
        entries.push({ relativePath: rel, kind: "directory", managed: true, sizeBytes: 0, mode: (await lstat(absolute)).mode & 0o777 });
        await walk(absolute);
        continue;
      }
      if (!child.isFile()) { await addExcluded(absolute, rel, "unsupported_type"); continue; }
      const before = await lstat(absolute);
      if (options.maxFileBytes !== undefined && before.size > options.maxFileBytes) {
        entries.push({ relativePath: rel, kind: "file", managed: false, exclusionReason: "too_large", sizeBytes: before.size, mode: before.mode & 0o777 });
        excludedPaths.push(rel);
        continue;
      }
      const digest = await hashFile(absolute, persistBlobs ? store!.paths.snapshotStagingDir : undefined);
      const after = await lstat(absolute);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) unstablePaths.push(rel);
      managedBytes += after.size;
      if (options.maxBytes !== undefined && managedBytes > options.maxBytes) {
        if (digest.tempPath) await rm(digest.tempPath, { force: true });
        throw new WorkspaceSnapshotRestoreError(413, "quota_exceeded", `Snapshot exceeds the workspace byte quota (${options.maxBytes}).`);
      }
      if (persistBlobs && store) {
        const blobPath = join(store.paths.snapshotBlobsDir, digest.sha256);
        await mkdir(dirname(blobPath), { recursive: true });
        if (!(await exists(blobPath))) await rename(digest.tempPath!, blobPath);
        else await rm(digest.tempPath!, { force: true });
        if ((await hashFile(blobPath)).sha256 !== digest.sha256) throw new WorkspaceSnapshotRestoreError(500, "snapshot_blob_integrity", `Stored snapshot blob failed integrity verification: ${rel}.`);
        store.upsertWorkspaceSnapshotBlob({ sha256: digest.sha256, sizeBytes: after.size, contentType: "application/octet-stream", createdAt: new Date().toISOString(), refCount: store.getWorkspaceSnapshotBlob(digest.sha256)?.refCount ?? 0 });
      }
      entries.push({ relativePath: rel, kind: "file", managed: true, sizeBytes: after.size, sha256: digest.sha256, blobSha256: digest.sha256, mode: after.mode & 0o777 });
    }
  };
  await walk(root);
  if (options.maxEntries !== undefined && entries.length > options.maxEntries) throw new WorkspaceSnapshotRestoreError(413, "quota_exceeded", `Snapshot exceeds the workspace entry quota (${options.maxEntries}).`);
  return { entries, fingerprint: fingerprintEntries(entries.filter((entry) => entry.managed)), managedBytes, excludedPaths, unstablePaths };
}

async function buildRestorePlan(root: string, targetEntries: readonly WorkspaceSnapshotEntry[], store: RunStore, currentEntries: readonly ScannedEntry[]) {
  const target = new Map(targetEntries.map((entry) => [entry.relativePath, entry]));
  const current = new Map(currentEntries.map((entry) => [entry.relativePath, entry]));
  const depth = (value: string) => value.split("/").length;
  const targetFilePaths = new Set(targetEntries.filter((entry) => entry.kind === "file" || entry.kind === "symlink").map((entry) => entry.relativePath));
  const mustDeleteFirst = [...current.keys()].filter((path) => !target.has(path) || [...targetFilePaths].some((filePath) => path.startsWith(`${filePath}/`)))
    .sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
  const targetPaths = [...target.keys()].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  const ordered = [...new Set([...mustDeleteFirst, ...targetPaths])];
  const plan = [] as Array<{
    relativePath: string; expectedBeforeSha256?: string; expectedAfterSha256?: string;
    rollbackBlobSha256?: string; rollbackSymlinkTarget?: string; targetBlobSha256?: string; targetSymlinkTarget?: string;
    rollbackMode?: number; targetMode?: number; targetKind: "file" | "directory" | "symlink"; targetExists: boolean;
  }>;
  for (const relativePath of ordered) {
    const before = current.get(relativePath);
    const after = target.get(relativePath);
    let rollbackBlobSha256: string | undefined;
    if (before?.kind === "file" && before.sha256) rollbackBlobSha256 = before.sha256;
    if (before?.kind === "file" && before.sha256 && !store.getWorkspaceSnapshotBlob(before.sha256)) {
      const source = join(root, relativePath); const digest = await hashAndStoreBlob(source, store); rollbackBlobSha256 = digest;
    }
    plan.push({ relativePath,
      ...(before ? { expectedBeforeSha256: before.sha256 ?? entryDigest(before) } : {}),
      ...(after ? { expectedAfterSha256: after.sha256 ?? entryDigest(after) } : {}),
      ...(rollbackBlobSha256 ? { rollbackBlobSha256 } : {}), ...(before?.symlinkTarget !== undefined ? { rollbackSymlinkTarget: before.symlinkTarget } : {}),
      ...(before?.mode === undefined ? {} : { rollbackMode: before.mode }), ...(after?.blobSha256 ? { targetBlobSha256: after.blobSha256 } : {}),
      ...(after?.symlinkTarget !== undefined ? { targetSymlinkTarget: after.symlinkTarget } : {}), ...(after?.mode === undefined ? {} : { targetMode: after.mode }),
      targetKind: after?.kind ?? before?.kind ?? "file", targetExists: Boolean(after) });
  }
  return plan;
}

async function applyJournalEntry(root: string, entry: { readonly relativePath: string; readonly targetBlobSha256?: string; readonly targetSymlinkTarget?: string; readonly targetMode?: number; readonly targetKind: "file" | "directory" | "symlink"; readonly targetExists: boolean }, store: RunStore): Promise<void> {
  const absolute = safePath(root, entry.relativePath);
  if (!entry.targetExists) {
    await removeEntry(absolute);
    return;
  }
  if (entry.targetKind === "symlink" && entry.targetSymlinkTarget !== undefined) {
    await removeEntry(absolute);
    await mkdir(dirname(absolute), { recursive: true });
    await symlink(entry.targetSymlinkTarget, absolute);
    return;
  }
  if (!entry.targetBlobSha256 && entry.targetKind === "directory") {
    try {
      const info = await lstat(absolute);
      if (!info.isDirectory()) await removeEntry(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(absolute, { recursive: true });
    if (entry.targetMode !== undefined) await chmod(absolute, entry.targetMode);
    return;
  }
  if (!entry.targetBlobSha256) {
    await removeEntry(absolute);
    return;
  }
  const blobPath = join(store.paths.snapshotBlobsDir, entry.targetBlobSha256);
  if (!(await exists(blobPath))) throw new WorkspaceSnapshotRestoreError(409, "snapshot_blob_missing", `Snapshot blob is missing: ${entry.targetBlobSha256}`);
  await mkdir(dirname(absolute), { recursive: true });
  try {
    const info = await lstat(absolute);
    if (info.isDirectory() || info.isSymbolicLink()) await removeEntry(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = `${absolute}.ling-restore-${randomUUID()}`;
  try {
    await copyFileStreaming(blobPath, temp);
    await rename(temp, absolute);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  if (entry.targetMode !== undefined) await chmod(absolute, entry.targetMode);
}

async function rollbackAttemptedEntries(
  root: string,
  entries: readonly SnapshotRestoreJournalEntry[],
  store: RunStore,
  request: SnapshotRestoreRequest,
  epoch: number,
  expectedState: SnapshotRestoreRequest["state"],
): Promise<string | undefined> {
  try {
    const durable = new Map(store.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id, limit: 100_000 }).map(entry => [entry.id, entry]));
    for (const entry of [...entries].reverse()) {
      assertRestoreOwnership(store, request, epoch, expectedState);
      const currentJournal = durable.get(entry.id);
      if (!currentJournal || !["pending", "applied"].includes(currentJournal.state)) throw new Error(`Cannot rollback ${entry.relativePath}: restore journal was superseded.`);
      const absolute = safePath(root, entry.relativePath);
      if (!await journalEntryMatches(root, entry, "before")) {
        // Keep the existing target-digest external-edit guard. A partial state
        // (including target bytes with unknown permissions) is not permission
        // to overwrite a path whose complete target state cannot be proved.
        if (!await journalEntryMatches(root, entry, "after")) throw new Error(`Cannot rollback ${entry.relativePath}: workspace is partial or changed after the restore entry was applied.`);
        assertRestoreOwnership(store, request, epoch, expectedState);
        if (entry.rollbackSymlinkTarget !== undefined) {
          await removeEntry(absolute); await mkdir(dirname(absolute), { recursive: true }); await symlink(entry.rollbackSymlinkTarget, absolute);
        } else if (entry.rollbackBlobSha256) {
          const blobPath = join(store.paths.snapshotBlobsDir, entry.rollbackBlobSha256);
          if ((await hashFile(blobPath)).sha256 !== entry.rollbackBlobSha256) throw new Error(`Cannot rollback ${entry.relativePath}: preimage blob is corrupt.`);
          const temporary = `${absolute}.ling-rollback-${randomUUID()}`;
          await mkdir(dirname(absolute), { recursive: true });
          try {
            const info = await lstat(absolute);
            if (info.isDirectory() || info.isSymbolicLink()) await removeEntry(absolute);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          try {
            await copyFileStreaming(blobPath, temporary);
            await rename(temporary, absolute);
          } catch (error) {
            await rm(temporary, { force: true });
            throw error;
          }
          if (entry.rollbackMode !== undefined) await chmod(absolute, entry.rollbackMode);
        } else if (entry.expectedBeforeSha256 === directoryDigest(entry.relativePath)) {
          await removeEntry(absolute);
          await mkdir(absolute, { recursive: true });
          if (entry.rollbackMode !== undefined) await chmod(absolute, entry.rollbackMode);
        } else if (entry.expectedBeforeSha256 === undefined) {
          await removeEntry(absolute);
        } else {
          throw new Error(`Cannot rollback ${entry.relativePath}: preimage metadata is missing.`);
        }
      }
      if (!await journalEntryMatches(root, entry, "before")) throw new Error(`Cannot verify rollback of ${entry.relativePath}: before state was not restored.`);
      assertRestoreOwnership(store, request, epoch, expectedState);
      if (!store.updateSnapshotRestoreJournalEntry({ id: entry.id, expectedState: currentJournal.state, state: "rolled_back", expectedFencingEpoch: epoch, updatedAt: new Date().toISOString() })) throw new Error(`Cannot verify rollback of ${entry.relativePath}: restore journal was superseded.`);
    }
    return undefined;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}

/** A content fingerprint deliberately omits permissions; recovery cannot. */
async function journalEntryMatches(root: string, entry: SnapshotRestoreJournalEntry, side: "before" | "after"): Promise<boolean> {
  const expectedDigest = side === "before" ? entry.expectedBeforeSha256 : entry.expectedAfterSha256;
  const absolute = safePath(root, entry.relativePath);
  try {
    const info = await lstat(absolute);
    if (expectedDigest === undefined) return false;
    const kind = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : undefined;
    const expectedKind = side === "after" ? entry.targetKind : entry.rollbackSymlinkTarget !== undefined ? "symlink"
      : expectedDigest === directoryDigest(entry.relativePath) ? "directory" : "file";
    if (kind !== expectedKind || side === "after" && !entry.targetExists) return false;
    const expectedMode = side === "before" ? entry.rollbackMode : entry.targetMode;
    if (expectedMode !== undefined && (info.mode & 0o777) !== expectedMode) return false;
    const digest = kind === "symlink" ? symlinkDigest(await readlink(absolute))
      : kind === "directory" ? directoryDigest(entry.relativePath) : (await hashFile(absolute)).sha256;
    const after = await lstat(absolute);
    return digest === expectedDigest && after.dev === info.dev && after.ino === info.ino && after.mode === info.mode
      && after.size === info.size && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return expectedDigest === undefined;
    throw error;
  }
}

async function verifyJournalBeforeState(root: string, entries: readonly SnapshotRestoreJournalEntry[]): Promise<string | undefined> {
  try {
    for (const entry of entries) {
      if (!await journalEntryMatches(root, entry, "before")) return `Before state is unverified for ${entry.relativePath}.`;
    }
    return undefined;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}

/** Filesystem admission uses observations; durable publication additionally uses atomic Core epoch-CAS. */
function assertRestoreOwnership(store: RunStore, request: SnapshotRestoreRequest, epoch: number, expectedState: SnapshotRestoreRequest["state"]): void {
  const current = store.getSnapshotRestoreRequest(request.id);
  const fence = store.getWorkspaceSnapshotFence(request.workspaceId);
  if (current?.state !== expectedState || current.fencingEpoch !== epoch
    || fence.ownerRequestId !== request.id || fence.epoch !== epoch) {
    throw new WorkspaceSnapshotRestoreError(409, "stale_restore_fence", "Workspace restore ownership or lifecycle was superseded.");
  }
}

/** No-owner reconciliation only reports observations; it does not authorize filesystem writes. */
function reconciliationExpectedEpoch(store: RunStore, request: SnapshotRestoreRequest): number | undefined {
  const current = store.getSnapshotRestoreRequest(request.id);
  const fence = store.getWorkspaceSnapshotFence(request.workspaceId);
  if (current?.state !== request.state || current.fencingEpoch !== request.fencingEpoch
    || fence.ownerRequestId && (fence.ownerRequestId !== request.id || fence.epoch !== request.fencingEpoch)) {
    throw new WorkspaceSnapshotRestoreError(409, "stale_restore_fence", "Workspace restore reconciliation ownership or lifecycle was superseded.");
  }
  return fence.ownerRequestId ? request.fencingEpoch : undefined;
}

async function assertSnapshotIntegrity(store: RunStore, root: string, entries: readonly WorkspaceSnapshotEntry[]): Promise<void> {
  for (const entry of entries) {
    if (!entry.managed) continue;
    if (entry.kind === "file") {
      if (!entry.blobSha256 || !digestPattern.test(entry.blobSha256) || !store.getWorkspaceSnapshotBlob(entry.blobSha256)) throw new WorkspaceSnapshotRestoreError(409, "snapshot_blob_missing", `Snapshot blob is missing for ${entry.relativePath}.`);
      if (entry.sha256 !== entry.blobSha256) throw new WorkspaceSnapshotRestoreError(409, "snapshot_corrupt", `Snapshot entry digest mismatch for ${entry.relativePath}.`);
      const blobPath = join(store.paths.snapshotBlobsDir, entry.blobSha256);
      if (!(await exists(blobPath)) || (await hashFile(blobPath)).sha256 !== entry.blobSha256) throw new WorkspaceSnapshotRestoreError(409, "snapshot_corrupt", `Snapshot blob is corrupt for ${entry.relativePath}.`);
    }
    if (entry.kind === "symlink") {
      if (entry.symlinkTarget === undefined) throw new WorkspaceSnapshotRestoreError(409, "snapshot_corrupt", `Snapshot symlink target is missing for ${entry.relativePath}.`);
      const target = resolve(dirname(safePath(root, entry.relativePath)), entry.symlinkTarget);
      const relation = relative(root, target);
      if (relation.startsWith("..") || relation.startsWith(sep) || relation.split(sep).some((part) => excludedRoots.has(part) || secretPartPattern.test(part))) {
        throw new WorkspaceSnapshotRestoreError(409, "snapshot_symlink_escape", `Snapshot symlink escapes the managed workspace: ${entry.relativePath}.`);
      }
    }
  }
}

async function hashAndStoreBlob(path: string, store: RunStore): Promise<string> {
  const digest = await hashFile(path, store.paths.snapshotStagingDir);
  const finalPath = join(store.paths.snapshotBlobsDir, digest.sha256); await mkdir(dirname(finalPath), { recursive: true });
  if (!(await exists(finalPath))) await rename(digest.tempPath!, finalPath); else await rm(digest.tempPath!, { force: true });
  store.upsertWorkspaceSnapshotBlob({ sha256: digest.sha256, sizeBytes: digest.sizeBytes, contentType: "application/octet-stream", createdAt: new Date().toISOString(), refCount: store.getWorkspaceSnapshotBlob(digest.sha256)?.refCount ?? 0 });
  return digest.sha256;
}

async function hashFile(path: string, stagingDir?: string): Promise<{ readonly sha256: string; readonly sizeBytes: number; readonly tempPath?: string }> {
  const hash = createHash("sha256");
  const temporary = stagingDir ? join(stagingDir, `blob-${randomUUID()}`) : undefined;
  if (temporary) { await mkdir(dirname(temporary), { recursive: true }); }
  const input = createReadStream(path); const output = temporary ? createWriteStream(temporary, { flags: "wx" }) : undefined;
  let sizeBytes = 0;
  try {
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer); sizeBytes += buffer.byteLength;
      if (output && !output.write(buffer)) await once(output, "drain");
    }
    if (output) { output.end(); await once(output, "close"); }
  } catch (error) {
    output?.destroy();
    throw error;
  }
  return { sha256: hash.digest("hex"), sizeBytes, ...(temporary ? { tempPath: temporary } : {}) };
}

async function copyFileStreaming(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await pipeline(createReadStream(source), createWriteStream(destination, { flags: "wx" }));
}

async function hasActiveWorkspaceRun(store: RunStore, root: string): Promise<boolean> {
  for (const run of store.listRuns({ limit: 200 })) {
    if (!["queued", "running", "waiting_for_approval"].includes(run.status)) continue;
    try {
      if (await realpath(resolve(run.cwd)) === root) return true;
    } catch {
      if (resolve(run.cwd) === root) return true;
    }
  }
  return false;
}

async function withWorkspaceSnapshotFence<T>(
  store: RunStore,
  root: string,
  workspaceId: string,
  operationKind: "capture",
  operation: () => Promise<T>,
): Promise<T> {
  if (await hasActiveWorkspaceRun(store, root)) {
    throw new WorkspaceSnapshotRestoreError(409, "workspace_busy", `${operationKind} cannot run while the workspace has an active Run or approval.`);
  }
  const ownerRequestId = `workspace_snapshot_${operationKind}_${randomUUID()}`;
  let acquiredEpoch: number | undefined;
  try {
    acquiredEpoch = store.acquireWorkspaceSnapshotFence(workspaceId, ownerRequestId, new Date().toISOString());
    if (await hasActiveWorkspaceRun(store, root)) {
      throw new WorkspaceSnapshotRestoreError(409, "workspace_busy", `${operationKind} was fenced after a Run became active.`);
    }
    return await operation();
  } finally {
    if (acquiredEpoch !== undefined) store.releaseWorkspaceSnapshotFence(workspaceId, ownerRequestId, new Date().toISOString(), acquiredEpoch);
  }
}

function directoryDigest(relativePath: string): string { return createHash("sha256").update(`directory:${relativePath}`).digest("hex"); }
function symlinkDigest(target: string): string { return createHash("sha256").update(`symlink:${target}`).digest("hex"); }
function entryDigest(entry: { readonly relativePath: string; readonly kind: "file" | "directory" | "symlink"; readonly sha256?: string; readonly symlinkTarget?: string }): string { return entry.kind === "file" ? entry.sha256 ?? "" : entry.kind === "symlink" ? symlinkDigest(entry.symlinkTarget ?? "") : directoryDigest(entry.relativePath); }
function fingerprintEntries(entries: readonly { readonly relativePath: string; readonly kind: "file" | "directory" | "symlink"; readonly sha256?: string; readonly symlinkTarget?: string }[]): string { const hash = createHash("sha256"); for (const entry of [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) hash.update(`${entry.relativePath}\0${entry.kind}\0${entryDigest(entry)}\n`); return hash.digest("hex"); }
function exclusionPolicySha256(): string { return createHash("sha256").update(JSON.stringify({ version: 1, excludedRoots: [...excludedRoots].sort(), secretPartPattern: secretPartPattern.source })).digest("hex"); }
function hashManifest(input: { readonly root: string; readonly fingerprint: string; readonly provenanceWatermark: string; readonly entries: readonly ScannedEntry[] }): string {
  const canonical = JSON.stringify({ schemaVersion: 1, canonicalRoot: input.root, workspaceFingerprintSha256: input.fingerprint,
    provenanceWatermark: input.provenanceWatermark, exclusionPolicySha256: exclusionPolicySha256(), entries: [...input.entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath)).map((entry) => ({
      path: entry.relativePath, kind: entry.kind, managed: entry.managed, reason: entry.exclusionReason ?? null,
      mode: entry.mode ?? null, size: entry.sizeBytes, digest: entryDigest(entry), symlinkTarget: entry.symlinkTarget ?? null,
    })) });
  return createHash("sha256").update(canonical).digest("hex");
}
function safePath(root: string, relativePath: string): string { const candidate = resolve(root, relativePath); const relation = relative(root, candidate); if (relation.startsWith("..") || relation.includes(`..${sep}`) || relation.startsWith(sep) || relation === ".") throw new WorkspaceSnapshotRestoreError(400, "invalid_snapshot_path", `Snapshot path escapes workspace: ${relativePath}`); return candidate; }
async function removeEntry(path: string): Promise<void> { try { const info = await lstat(path); if (info.isDirectory()) await rmdir(path); else await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
async function withRestoreLock<T>(root: string, operation: () => Promise<T>, waitForPrior = false): Promise<T> {
  for (let prior = activeRestoreLocks.get(root); prior; prior = activeRestoreLocks.get(root)) {
    if (!waitForPrior) throw new WorkspaceSnapshotRestoreError(409, "workspace_restore_busy", "Another workspace restore is already running.");
    // Only accepted queued jobs wait. Recheck after every actual owner settles:
    // another waiter may have acquired the lock before this one resumes.
    await prior;
  }
  let release!: () => void;
  const lock = new Promise<void>((resolveLock) => { release = resolveLock; });
  activeRestoreLocks.set(root, lock);
  try { return await operation(); }
  finally {
    if (activeRestoreLocks.get(root) === lock) activeRestoreLocks.delete(root);
    release();
  }
}
