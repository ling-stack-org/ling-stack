import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import {
  snapshotRestoreJournalStates,
  snapshotRestoreStates,
  workspaceSnapshotEntryKinds,
  workspaceSnapshotManifestStates,
  type CreateSnapshotRestoreJournalEntryInput,
  type CreateSnapshotRestoreRequestInput,
  type CreateWorkspaceSnapshotEntryInput,
  type CreateWorkspaceSnapshotManifestInput,
  type CreateWorkspaceSnapshotRestoreAnchorInput,
  type CreateSnapshotRestoreConfirmationInput,
  type SnapshotRestoreConfirmation,
  type ListSnapshotRestoreJournalOptions,
  type ListSnapshotRestoreRequestsOptions,
  type ListWorkspaceSnapshotManifestsOptions,
  type SnapshotRestoreJournalEntry,
  type SnapshotRestoreRequest,
  type UpdateSnapshotRestoreRequestInput,
  type UpdateSnapshotRestoreJournalEntryInput,
  type WorkspaceSnapshotBlob,
  type WorkspaceSnapshotEntry,
  type WorkspaceSnapshotManifest,
  type WorkspaceSnapshotRestoreAnchor,
} from "@ling-stack/contracts";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import type { ClaimSnapshotRestoreFenceInput } from "../../run-types.js";
import { parseJson, readNullableString, readNumber, readString, stringifyJson } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

export class SqliteWorkspaceSnapshotStore {
  constructor(private readonly context: SqliteStoreContext) {}

  createManifest(input: CreateWorkspaceSnapshotManifestInput): WorkspaceSnapshotManifest {
    validateManifestInput(input);
    const manifest: WorkspaceSnapshotManifest = {
      id: input.id ?? `workspace_snapshot_${randomUUID()}`,
      workspaceId: normalize(input.workspaceId ?? DEFAULT_WORKSPACE_ID, "snapshot workspace id"),
      cwd: normalize(input.cwd, "snapshot cwd"),
      canonicalRoot: normalize(input.canonicalRoot, "snapshot canonical root"),
      formatVersion: 1,
      schemaVersion: input.schemaVersion ?? 1,
      state: input.state ?? "sealed",
      fingerprint: input.fingerprint,
      provenanceWatermark: input.provenanceWatermark,
      entryCount: input.entryCount,
      totalBytes: input.totalBytes,
      createdAt: input.createdAt,
      ...(input.sealedAt ? { sealedAt: input.sealedAt } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
      captureCwd: input.captureCwd ?? input.cwd,
      captureKind: input.captureKind ?? "user_restore_point",
      ...(input.sourceTurnId ? { sourceTurnId: input.sourceTurnId } : {}),
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
      ...(input.sourceCheckpointId ? { sourceCheckpointId: input.sourceCheckpointId } : {}),
      ...(input.exclusionPolicySha256 ? { exclusionPolicySha256: input.exclusionPolicySha256 } : {}),
      managedEntryCount: input.managedEntryCount ?? input.entryCount,
      excludedEntryCount: input.excludedEntryCount ?? 0,
      managedBytes: input.managedBytes ?? input.totalBytes,
      workspaceFingerprintSha256: input.workspaceFingerprintSha256 ?? input.fingerprint,
      ...(input.manifestSha256 ? { manifestSha256: input.manifestSha256 } : {}),
    };
    this.context.database.prepare(`
      INSERT INTO workspace_snapshot_manifests (
        id, workspace_id, cwd, canonical_root, format_version, state,
        fingerprint, provenance_watermark, entry_count, total_bytes,
        created_at, sealed_at, expires_at, failure_reason, schema_version,
        capture_cwd, capture_kind, source_turn_id, source_run_id, source_checkpoint_id,
        exclusion_policy_sha256, managed_entry_count, excluded_entry_count, managed_bytes,
        workspace_fingerprint_sha256, manifest_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      manifest.id, manifest.workspaceId, manifest.cwd, manifest.canonicalRoot, manifest.formatVersion,
      manifest.state, manifest.fingerprint, manifest.provenanceWatermark, manifest.entryCount, manifest.totalBytes,
      manifest.createdAt, manifest.sealedAt ?? null, manifest.expiresAt ?? null, manifest.failureReason ?? null,
      manifest.schemaVersion ?? 1, manifest.captureCwd ?? manifest.cwd, manifest.captureKind ?? "user_restore_point",
      manifest.sourceTurnId ?? null, manifest.sourceRunId ?? null, manifest.sourceCheckpointId ?? null,
      manifest.exclusionPolicySha256 ?? null, manifest.managedEntryCount ?? manifest.entryCount,
      manifest.excludedEntryCount ?? 0, manifest.managedBytes ?? manifest.totalBytes,
      manifest.workspaceFingerprintSha256 ?? manifest.fingerprint, manifest.manifestSha256 ?? null,
    );
    return manifest;
  }

  createManifestWithEntries(
    input: CreateWorkspaceSnapshotManifestInput,
    inputs: readonly CreateWorkspaceSnapshotEntryInput[],
  ): { readonly manifest: WorkspaceSnapshotManifest; readonly entries: readonly WorkspaceSnapshotEntry[] } {
    validateManifestInput(input);
    inputs.forEach(validateEntryInput);
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const manifest = this.insertManifest(input);
      const entries = inputs.map((entry) => ({ ...entry, manifestId: manifest.id }));
      const created = this.insertEntries(entries, manifest);
      this.context.database.exec("COMMIT");
      return { manifest, entries: created };
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  getManifest(id: string): WorkspaceSnapshotManifest | undefined {
    const row = this.context.database.prepare(`${manifestSelectSql} WHERE id = ?`).get(id);
    return row ? mapManifest(row as Record<string, SQLOutputValue>) : undefined;
  }

  listManifests(options: ListWorkspaceSnapshotManifestsOptions = {}): WorkspaceSnapshotManifest[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.workspaceId) { clauses.push("workspace_id = ?"); params.push(options.workspaceId); }
    if (options.state) { clauses.push("state = ?"); params.push(options.state); }
    params.push(Math.min(Math.max(options.limit ?? 100, 1), 1_000));
    return this.context.database.prepare(`
      ${manifestSelectSql}
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...params).map((row) => mapManifest(row as Record<string, SQLOutputValue>));
  }

  createEntries(inputs: readonly CreateWorkspaceSnapshotEntryInput[]): WorkspaceSnapshotEntry[] {
    if (!inputs.length) return [];
    inputs.forEach(validateEntryInput);
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const entries = inputs.map((input) => ({
        id: input.id ?? `workspace_snapshot_entry_${randomUUID()}`,
        manifestId: input.manifestId,
        relativePath: normalizeRelativePath(input.relativePath),
        kind: input.kind,
        managed: input.managed ?? true,
        ...(input.exclusionReason ? { exclusionReason: input.exclusionReason } : {}),
        ...(input.symlinkTarget !== undefined ? { symlinkTarget: input.symlinkTarget } : {}),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        sizeBytes: input.sizeBytes,
        ...(input.sha256 ? { sha256: input.sha256 } : {}),
        ...(input.blobSha256 ? { blobSha256: input.blobSha256 } : {}),
      } satisfies WorkspaceSnapshotEntry));
      const manifest = this.getManifest(entries[0]!.manifestId);
      if (!manifest || manifest.state === "deleted" || manifest.state === "corrupt") throw new Error(`Snapshot manifest not found: ${entries[0]!.manifestId}`);
      if (entries.some((entry) => entry.manifestId !== manifest.id)) throw new Error("Snapshot entries must use one manifest.");
      const insert = this.context.database.prepare(`
        INSERT INTO workspace_snapshot_entries (
          id, manifest_id, relative_path, kind, managed, exclusion_reason, symlink_target,
          mode, size_bytes, sha256, blob_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const incrementBlob = this.context.database.prepare("UPDATE workspace_snapshot_blobs SET ref_count = ref_count + 1 WHERE sha256 = ?");
      for (const entry of entries) {
        if (entry.blobSha256 && !this.getBlob(entry.blobSha256)) throw new Error(`Snapshot blob not found: ${entry.blobSha256}`);
        insert.run(entry.id, entry.manifestId, entry.relativePath, entry.kind, entry.managed ? 1 : 0,
          entry.exclusionReason ?? null, entry.symlinkTarget ?? null, entry.mode ?? null,
          entry.sizeBytes, entry.sha256 ?? null, entry.blobSha256 ?? null);
        if (entry.blobSha256) incrementBlob.run(entry.blobSha256);
      }
      this.context.database.exec("COMMIT");
      return entries;
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  private insertManifest(input: CreateWorkspaceSnapshotManifestInput): WorkspaceSnapshotManifest {
    const manifest: WorkspaceSnapshotManifest = {
      id: input.id ?? `workspace_snapshot_${randomUUID()}`,
      workspaceId: normalize(input.workspaceId ?? DEFAULT_WORKSPACE_ID, "snapshot workspace id"),
      cwd: normalize(input.cwd, "snapshot cwd"), canonicalRoot: normalize(input.canonicalRoot, "snapshot canonical root"),
      formatVersion: 1, schemaVersion: input.schemaVersion ?? 1, state: input.state ?? "sealed",
      fingerprint: input.fingerprint, provenanceWatermark: input.provenanceWatermark, entryCount: input.entryCount,
      totalBytes: input.totalBytes, createdAt: input.createdAt,
      ...(input.sealedAt ? { sealedAt: input.sealedAt } : {}), ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.failureReason ? { failureReason: input.failureReason } : {}), captureCwd: input.captureCwd ?? input.cwd,
      captureKind: input.captureKind ?? "user_restore_point", ...(input.sourceTurnId ? { sourceTurnId: input.sourceTurnId } : {}),
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}), ...(input.sourceCheckpointId ? { sourceCheckpointId: input.sourceCheckpointId } : {}),
      ...(input.exclusionPolicySha256 ? { exclusionPolicySha256: input.exclusionPolicySha256 } : {}), managedEntryCount: input.managedEntryCount ?? input.entryCount,
      excludedEntryCount: input.excludedEntryCount ?? 0, managedBytes: input.managedBytes ?? input.totalBytes,
      workspaceFingerprintSha256: input.workspaceFingerprintSha256 ?? input.fingerprint, ...(input.manifestSha256 ? { manifestSha256: input.manifestSha256 } : {}),
    };
    this.context.database.prepare(`
      INSERT INTO workspace_snapshot_manifests (
        id, workspace_id, cwd, canonical_root, format_version, state, fingerprint, provenance_watermark,
        entry_count, total_bytes, created_at, sealed_at, expires_at, failure_reason, schema_version,
        capture_cwd, capture_kind, source_turn_id, source_run_id, source_checkpoint_id, exclusion_policy_sha256,
        managed_entry_count, excluded_entry_count, managed_bytes, workspace_fingerprint_sha256, manifest_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(manifest.id, manifest.workspaceId, manifest.cwd, manifest.canonicalRoot, 1, manifest.state, manifest.fingerprint,
      manifest.provenanceWatermark, manifest.entryCount, manifest.totalBytes, manifest.createdAt, manifest.sealedAt ?? null,
      manifest.expiresAt ?? null, manifest.failureReason ?? null, 1, manifest.captureCwd ?? manifest.cwd, manifest.captureKind ?? "user_restore_point",
      manifest.sourceTurnId ?? null, manifest.sourceRunId ?? null, manifest.sourceCheckpointId ?? null, manifest.exclusionPolicySha256 ?? null,
      manifest.managedEntryCount ?? manifest.entryCount, manifest.excludedEntryCount ?? 0, manifest.managedBytes ?? manifest.totalBytes,
      manifest.workspaceFingerprintSha256 ?? manifest.fingerprint, manifest.manifestSha256 ?? null);
    return manifest;
  }

  private insertEntries(inputs: readonly CreateWorkspaceSnapshotEntryInput[], manifest: WorkspaceSnapshotManifest): WorkspaceSnapshotEntry[] {
    const entries = inputs.map((input) => ({ id: input.id ?? `workspace_snapshot_entry_${randomUUID()}`, manifestId: manifest.id,
      relativePath: normalizeRelativePath(input.relativePath), kind: input.kind, managed: input.managed ?? true,
      ...(input.exclusionReason ? { exclusionReason: input.exclusionReason } : {}), ...(input.symlinkTarget !== undefined ? { symlinkTarget: input.symlinkTarget } : {}),
      ...(input.mode === undefined ? {} : { mode: input.mode }), sizeBytes: input.sizeBytes,
      ...(input.sha256 ? { sha256: input.sha256 } : {}), ...(input.blobSha256 ? { blobSha256: input.blobSha256 } : {}) } satisfies WorkspaceSnapshotEntry));
    const insert = this.context.database.prepare(`INSERT INTO workspace_snapshot_entries (id, manifest_id, relative_path, kind, managed, exclusion_reason, symlink_target, mode, size_bytes, sha256, blob_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const incrementBlob = this.context.database.prepare("UPDATE workspace_snapshot_blobs SET ref_count = ref_count + 1 WHERE sha256 = ?");
    for (const entry of entries) {
      if (entry.blobSha256 && !this.getBlob(entry.blobSha256)) throw new Error(`Snapshot blob not found: ${entry.blobSha256}`);
      insert.run(entry.id, entry.manifestId, entry.relativePath, entry.kind, entry.managed ? 1 : 0, entry.exclusionReason ?? null,
        entry.symlinkTarget ?? null, entry.mode ?? null, entry.sizeBytes, entry.sha256 ?? null, entry.blobSha256 ?? null);
      if (entry.blobSha256) incrementBlob.run(entry.blobSha256);
    }
    return entries;
  }

  listEntries(manifestId: string): WorkspaceSnapshotEntry[] {
    return this.context.database.prepare(`${entrySelectSql} WHERE manifest_id = ? ORDER BY relative_path ASC`).all(manifestId)
      .map((row) => mapEntry(row as Record<string, SQLOutputValue>));
  }

  getBlob(sha256: string): WorkspaceSnapshotBlob | undefined {
    const row = this.context.database.prepare(`${blobSelectSql} WHERE sha256 = ?`).get(sha256);
    return row ? mapBlob(row as Record<string, SQLOutputValue>) : undefined;
  }

  listBlobs(): WorkspaceSnapshotBlob[] {
    return this.context.database.prepare(`${blobSelectSql} ORDER BY created_at ASC, sha256 ASC`).all().map((row) => mapBlob(row as Record<string, SQLOutputValue>));
  }

  upsertBlob(input: WorkspaceSnapshotBlob): WorkspaceSnapshotBlob {
    if (!digestPattern.test(input.sha256) || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || !Number.isSafeInteger(input.refCount) || input.refCount < 0) {
      throw new Error("Invalid workspace snapshot blob metadata.");
    }
    assertTimestamp(input.createdAt);
    this.context.database.prepare(`
      INSERT INTO workspace_snapshot_blobs (sha256, size_bytes, content_type, created_at, ref_count)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET size_bytes = excluded.size_bytes, ref_count = excluded.ref_count
    `).run(input.sha256, input.sizeBytes, input.contentType, input.createdAt, input.refCount);
    return this.getBlob(input.sha256)!;
  }

  createAnchor(input: CreateWorkspaceSnapshotRestoreAnchorInput): WorkspaceSnapshotRestoreAnchor {
    validateAnchorInput(input);
    const workspaceId = normalize(input.workspaceId ?? DEFAULT_WORKSPACE_ID, "snapshot anchor workspace id");
    const anchor: WorkspaceSnapshotRestoreAnchor = {
      id: input.id ?? `workspace_snapshot_anchor_${randomUUID()}`,
      workspaceId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.targetTurnId ? { targetTurnId: input.targetTurnId } : {}),
      ...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
      baselineSnapshotId: input.baselineSnapshotId,
      baselineFingerprint: input.baselineFingerprint,
      baselineProvenanceWatermark: input.baselineProvenanceWatermark,
      expectedWorkspaceFingerprint: input.expectedWorkspaceFingerprint,
      expectedProvenanceWatermark: input.expectedProvenanceWatermark,
      createdAt: input.createdAt,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    this.assertAnchorReferences(anchor);
    this.context.database.prepare(`
      INSERT INTO workspace_snapshot_restore_anchors (
        id, workspace_id, thread_id, target_turn_id, checkpoint_id,
        baseline_snapshot_id, baseline_fingerprint, baseline_provenance_watermark,
        expected_workspace_fingerprint, expected_provenance_watermark, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(anchor.id, anchor.workspaceId, anchor.threadId ?? null, anchor.targetTurnId ?? null, anchor.checkpointId ?? null, anchor.baselineSnapshotId,
      anchor.baselineFingerprint, anchor.baselineProvenanceWatermark, anchor.expectedWorkspaceFingerprint,
      anchor.expectedProvenanceWatermark, anchor.createdAt, anchor.expiresAt ?? null);
    return anchor;
  }

  getAnchor(id: string): WorkspaceSnapshotRestoreAnchor | undefined {
    const row = this.context.database.prepare(`${anchorSelectSql} WHERE id = ?`).get(id);
    return row ? mapAnchor(row as Record<string, SQLOutputValue>) : undefined;
  }

  createRestoreRequest(input: CreateSnapshotRestoreRequestInput): SnapshotRestoreRequest {
    validateRestoreRequestInput(input);
    const workspaceId = normalize(input.workspaceId ?? DEFAULT_WORKSPACE_ID, "snapshot restore workspace id");
    const existing = this.getRestoreRequestByIdempotency(workspaceId, input.idempotencyKey);
    if (existing) {
      if (existing.anchorId !== input.anchorId || existing.snapshotId !== input.snapshotId) throw new Error("Snapshot restore idempotency key is bound to another target.");
      return existing;
    }
    const request: SnapshotRestoreRequest = {
      id: input.id ?? `workspace_snapshot_restore_${randomUUID()}`,
      idempotencyKey: input.idempotencyKey,
      workspaceId,
      anchorId: input.anchorId,
      snapshotId: input.snapshotId,
      expectedWorkspaceFingerprint: input.expectedWorkspaceFingerprint,
      expectedProvenanceWatermark: input.expectedProvenanceWatermark,
      state: input.state ?? "requested",
      fencingEpoch: input.fencingEpoch ?? 0,
      journalEntryCount: input.journalEntryCount ?? 0,
      ...(input.lastError ? { lastError: input.lastError } : {}),
      createdAt: input.createdAt,
      updatedAt: input.updatedAt ?? input.createdAt,
      ...(input.confirmationId ? { confirmationId: input.confirmationId } : {}),
    };
    this.assertRestoreRequestReferences(request);
    this.context.database.prepare(`
      INSERT INTO workspace_snapshot_restore_requests (
        id, idempotency_key, workspace_id, anchor_id, snapshot_id,
        expected_workspace_fingerprint, expected_provenance_watermark, state,
        fencing_epoch, journal_entry_count, last_error, confirmation_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(request.id, request.idempotencyKey, request.workspaceId, request.anchorId, request.snapshotId,
      request.expectedWorkspaceFingerprint, request.expectedProvenanceWatermark, request.state, request.fencingEpoch,
      request.journalEntryCount, request.lastError ?? null, request.confirmationId ?? null, request.createdAt, request.updatedAt);
    return request;
  }

  getRestoreRequest(id: string): SnapshotRestoreRequest | undefined {
    const row = this.context.database.prepare(`${restoreRequestSelectSql} WHERE id = ?`).get(id);
    return row ? mapRestoreRequest(row as Record<string, SQLOutputValue>) : undefined;
  }

  listRestoreRequests(options: ListSnapshotRestoreRequestsOptions = {}): SnapshotRestoreRequest[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.workspaceId) { clauses.push("workspace_id = ?"); params.push(options.workspaceId); }
    params.push(Math.min(Math.max(options.limit ?? 10_000, 1), 100_000));
    return this.context.database.prepare(`${restoreRequestSelectSql} ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...params)
      .map((row) => mapRestoreRequest(row as Record<string, SQLOutputValue>));
  }

  createConfirmation(input: CreateSnapshotRestoreConfirmationInput): SnapshotRestoreConfirmation {
    assertTimestamp(input.createdAt);
    const workspaceId = normalize(input.workspaceId ?? DEFAULT_WORKSPACE_ID, "snapshot confirmation workspace id");
    const anchor = this.getAnchor(input.anchorId);
    const manifest = this.getManifest(input.snapshotId);
    if (!anchor || anchor.workspaceId !== workspaceId || !manifest || manifest.workspaceId !== workspaceId || anchor.baselineSnapshotId !== manifest.id) throw new Error("Snapshot confirmation target mismatch.");
    const confirmation: SnapshotRestoreConfirmation = { id: input.id ?? `workspace_snapshot_confirmation_${randomUUID()}`, workspaceId, anchorId: input.anchorId, snapshotId: input.snapshotId, state: "pending", createdAt: input.createdAt };
    this.context.database.prepare("INSERT INTO workspace_snapshot_restore_confirmations (id, workspace_id, anchor_id, snapshot_id, state, created_at, resolved_at) VALUES (?, ?, ?, ?, 'pending', ?, NULL)").run(confirmation.id, confirmation.workspaceId, confirmation.anchorId, confirmation.snapshotId, confirmation.createdAt);
    return confirmation;
  }

  getConfirmation(id: string): SnapshotRestoreConfirmation | undefined {
    const row = this.context.database.prepare("SELECT id, workspace_id, anchor_id, snapshot_id, state, created_at, resolved_at FROM workspace_snapshot_restore_confirmations WHERE id = ?").get(id) as Record<string, SQLOutputValue> | undefined;
    if (!row) return undefined;
    return { id: readString(row, "id"), workspaceId: readString(row, "workspace_id"), anchorId: readString(row, "anchor_id"), snapshotId: readString(row, "snapshot_id"), state: readString(row, "state") as SnapshotRestoreConfirmation["state"], createdAt: readString(row, "created_at"), ...(readNullableString(row, "resolved_at") ? { resolvedAt: readNullableString(row, "resolved_at") } : {}) };
  }

  resolveConfirmation(id: string, state: "confirmed" | "denied" | "expired", now: string): SnapshotRestoreConfirmation | undefined {
    assertTimestamp(now);
    const result = this.context.database.prepare("UPDATE workspace_snapshot_restore_confirmations SET state = ?, resolved_at = ? WHERE id = ? AND state = 'pending'").run(state, now, id);
    return Number(result.changes) === 1 ? this.getConfirmation(id) : this.getConfirmation(id);
  }

  getRestoreRequestByIdempotency(workspaceId: string, idempotencyKey: string): SnapshotRestoreRequest | undefined {
    const row = this.context.database.prepare(`${restoreRequestSelectSql} WHERE workspace_id = ? AND idempotency_key = ?`).get(workspaceId, idempotencyKey);
    return row ? mapRestoreRequest(row as Record<string, SQLOutputValue>) : undefined;
  }

  updateRestoreRequest(input: UpdateSnapshotRestoreRequestInput): SnapshotRestoreRequest | undefined {
    if (!snapshotRestoreStates.includes(input.expectedState) || !snapshotRestoreStates.includes(input.state)) throw new Error("Invalid snapshot restore state.");
    if (!Number.isSafeInteger(input.fencingEpoch ?? 0) || (input.fencingEpoch ?? 0) < 0) throw new Error("Invalid snapshot restore fence epoch.");
    if (input.expectedFencingEpoch !== undefined && (!Number.isSafeInteger(input.expectedFencingEpoch) || input.expectedFencingEpoch < 0)) throw new Error("Invalid expected snapshot restore fence epoch.");
    assertTimestamp(input.updatedAt);
    const result = this.context.database.prepare(`
      UPDATE workspace_snapshot_restore_requests
      SET state = ?, fencing_epoch = COALESCE(?, fencing_epoch), journal_entry_count = COALESCE(?, journal_entry_count), last_error = ?, updated_at = ?
      WHERE id = ? AND state = ?
        AND (? IS NULL OR (fencing_epoch = ? AND EXISTS (
          SELECT 1 FROM workspace_snapshot_fences AS fence
          WHERE fence.workspace_id = workspace_snapshot_restore_requests.workspace_id
            AND fence.owner_request_id = workspace_snapshot_restore_requests.id AND fence.epoch = ?
        )))
    `).run(input.state, input.fencingEpoch ?? null, input.journalEntryCount ?? null, input.lastError ?? null,
      input.updatedAt, input.id, input.expectedState, input.expectedFencingEpoch ?? null,
      input.expectedFencingEpoch ?? null, input.expectedFencingEpoch ?? null);
    if (Number(result.changes) !== 1) return undefined;
    return this.getRestoreRequest(input.id);
  }

  createJournalEntries(inputs: readonly CreateSnapshotRestoreJournalEntryInput[]): SnapshotRestoreJournalEntry[] {
    if (!inputs.length) return [];
    inputs.forEach(validateJournalInput);
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const entries = inputs.map((input) => ({
        id: input.id ?? `workspace_snapshot_journal_${randomUUID()}`,
        restoreRequestId: input.restoreRequestId,
        sequence: input.sequence,
        relativePath: normalizeRelativePath(input.relativePath),
        ...(input.expectedBeforeSha256 ? { expectedBeforeSha256: input.expectedBeforeSha256 } : {}),
        ...(input.expectedAfterSha256 ? { expectedAfterSha256: input.expectedAfterSha256 } : {}),
        ...(input.rollbackBlobSha256 ? { rollbackBlobSha256: input.rollbackBlobSha256 } : {}),
        ...(input.rollbackSymlinkTarget !== undefined ? { rollbackSymlinkTarget: input.rollbackSymlinkTarget } : {}),
        ...(input.targetBlobSha256 ? { targetBlobSha256: input.targetBlobSha256 } : {}),
        ...(input.targetSymlinkTarget !== undefined ? { targetSymlinkTarget: input.targetSymlinkTarget } : {}),
        ...(input.rollbackMode !== undefined ? { rollbackMode: input.rollbackMode } : {}),
        ...(input.targetMode !== undefined ? { targetMode: input.targetMode } : {}),
        targetKind: input.targetKind,
        targetExists: input.targetExists,
        state: input.state ?? "pending",
        updatedAt: input.updatedAt,
      } satisfies SnapshotRestoreJournalEntry));
      const insert = this.context.database.prepare(`
        INSERT INTO workspace_snapshot_restore_journal (
          id, restore_request_id, sequence, relative_path, expected_before_sha256,
          expected_after_sha256, rollback_blob_sha256, rollback_symlink_target,
          target_blob_sha256, target_symlink_target, rollback_mode, target_mode,
          target_kind, target_exists, state, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const entry of entries) insert.run(entry.id, entry.restoreRequestId, entry.sequence, entry.relativePath, entry.expectedBeforeSha256 ?? null,
        entry.expectedAfterSha256 ?? null, entry.rollbackBlobSha256 ?? null, entry.rollbackSymlinkTarget ?? null,
        entry.targetBlobSha256 ?? null, entry.targetSymlinkTarget ?? null, entry.rollbackMode ?? null,
        entry.targetMode ?? null, entry.targetKind, entry.targetExists ? 1 : 0, entry.state, entry.updatedAt);
      this.context.database.exec("COMMIT");
      return entries;
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  listJournalEntries(options: ListSnapshotRestoreJournalOptions): SnapshotRestoreJournalEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 10_000, 1), 100_000);
    return this.context.database.prepare(`${journalSelectSql} WHERE restore_request_id = ? ORDER BY sequence ASC LIMIT ?`).all(options.restoreRequestId, limit)
      .map((row) => mapJournalEntry(row as Record<string, SQLOutputValue>));
  }

  updateJournalEntry(input: UpdateSnapshotRestoreJournalEntryInput): SnapshotRestoreJournalEntry | undefined {
    if (!snapshotRestoreJournalStates.includes(input.expectedState) || !snapshotRestoreJournalStates.includes(input.state)) throw new Error("Invalid restore journal state.");
    if (input.expectedFencingEpoch !== undefined && (!Number.isSafeInteger(input.expectedFencingEpoch) || input.expectedFencingEpoch < 0)) throw new Error("Invalid expected snapshot restore fence epoch.");
    assertTimestamp(input.updatedAt);
    const result = this.context.database.prepare(`
      UPDATE workspace_snapshot_restore_journal SET state = ?, updated_at = ? WHERE id = ? AND state = ?
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM workspace_snapshot_restore_requests AS request
          JOIN workspace_snapshot_fences AS fence ON fence.workspace_id = request.workspace_id
          WHERE request.id = workspace_snapshot_restore_journal.restore_request_id
            AND request.fencing_epoch = ? AND fence.epoch = ? AND fence.owner_request_id = request.id
        ))
    `).run(input.state, input.updatedAt, input.id, input.expectedState, input.expectedFencingEpoch ?? null,
      input.expectedFencingEpoch ?? null, input.expectedFencingEpoch ?? null);
    if (Number(result.changes) !== 1) return undefined;
    const row = this.context.database.prepare(`${journalSelectSql} WHERE id = ?`).get(input.id);
    return row ? mapJournalEntry(row as Record<string, SQLOutputValue>) : undefined;
  }

  /** The durable restore state and its lease are a single SQLite fact. */
  claimRestoreFence(input: ClaimSnapshotRestoreFenceInput): number | undefined {
    const requestId = normalize(input.requestId, "snapshot restore request id");
    if (!["requested", "validating"].includes(input.expectedState)) throw new Error("Invalid snapshot restore claim state.");
    if (!Number.isSafeInteger(input.expectedRequestFencingEpoch) || input.expectedRequestFencingEpoch < 0) throw new Error("Invalid expected snapshot restore request epoch.");
    assertTimestamp(input.now);
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const request = this.context.database.prepare("SELECT workspace_id, state, fencing_epoch FROM workspace_snapshot_restore_requests WHERE id = ?").get(requestId) as Record<string, SQLOutputValue> | undefined;
      if (!request || readString(request, "state") !== input.expectedState || readNumber(request, "fencing_epoch") !== input.expectedRequestFencingEpoch) {
        this.context.database.exec("COMMIT");
        return undefined;
      }
      // The workspace is authoritative request data, never caller-selected scope.
      const workspaceId = readString(request, "workspace_id");
      const fence = this.context.database.prepare("SELECT epoch, owner_request_id FROM workspace_snapshot_fences WHERE workspace_id = ?").get(workspaceId) as Record<string, SQLOutputValue> | undefined;
      const priorOwner = fence && readNullableString(fence, "owner_request_id");
      if (priorOwner && priorOwner !== requestId) throw new Error("Workspace snapshot restore fence is already owned.");
      const epoch = (fence ? readNumber(fence, "epoch") : 0) + 1;
      if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("Snapshot restore fence epoch exhausted.");
      this.context.database.prepare(`
        INSERT INTO workspace_snapshot_fences (workspace_id, epoch, owner_request_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET epoch = excluded.epoch, owner_request_id = excluded.owner_request_id, updated_at = excluded.updated_at
      `).run(workspaceId, epoch, requestId, input.now);
      const bound = this.context.database.prepare(`
        UPDATE workspace_snapshot_restore_requests SET state = 'fenced', fencing_epoch = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND state = ? AND fencing_epoch = ?
      `).run(epoch, input.now, requestId, input.expectedState, input.expectedRequestFencingEpoch);
      if (Number(bound.changes) !== 1) throw new Error("Snapshot restore fence claim was superseded.");
      this.context.database.exec("COMMIT");
      return epoch;
    } catch (error) {
      try { this.context.database.exec("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "Snapshot restore fence claim rollback failed.", { cause: error }); }
      throw error;
    }
  }

  acquireFence(workspaceId: string, ownerRequestId: string, now: string): number {
    assertTimestamp(now);
    const normalizedWorkspace = normalize(workspaceId, "snapshot fence workspace id");
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.context.database.prepare("SELECT epoch, owner_request_id FROM workspace_snapshot_fences WHERE workspace_id = ?").get(normalizedWorkspace) as Record<string, SQLOutputValue> | undefined;
      const priorOwner = current?.owner_request_id;
      if (typeof priorOwner === "string" && priorOwner && priorOwner !== ownerRequestId) throw new Error("Workspace snapshot restore fence is already owned.");
      const epoch = (current ? readNumber(current, "epoch") : 0) + 1;
      this.context.database.prepare(`
        INSERT INTO workspace_snapshot_fences (workspace_id, epoch, owner_request_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET epoch = excluded.epoch, owner_request_id = excluded.owner_request_id, updated_at = excluded.updated_at
      `).run(normalizedWorkspace, epoch, ownerRequestId, now);
      this.context.database.exec("COMMIT");
      return epoch;
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  getFence(workspaceId: string): { readonly epoch: number; readonly ownerRequestId?: string } {
    const row = this.context.database.prepare("SELECT epoch, owner_request_id FROM workspace_snapshot_fences WHERE workspace_id = ?").get(workspaceId) as Record<string, SQLOutputValue> | undefined;
    return row ? { epoch: readNumber(row, "epoch"), ...(readNullableString(row, "owner_request_id") ? { ownerRequestId: readNullableString(row, "owner_request_id") } : {}) } : { epoch: 0 };
  }

  releaseFence(workspaceId: string, ownerRequestId: string, now: string, expectedEpoch?: number): boolean {
    assertTimestamp(now);
    if (expectedEpoch !== undefined && (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0)) throw new Error("Invalid expected snapshot restore fence epoch.");
    const result = this.context.database.prepare("UPDATE workspace_snapshot_fences SET owner_request_id = NULL, updated_at = ? WHERE workspace_id = ? AND owner_request_id = ? AND (? IS NULL OR epoch = ?)").run(now, workspaceId, ownerRequestId, expectedEpoch ?? null, expectedEpoch ?? null);
    return Number(result.changes) === 1;
  }

  expireManifest(id: string, now: string): WorkspaceSnapshotManifest | undefined {
    assertTimestamp(now);
    const protectedByAnchor = this.context.database.prepare("SELECT 1 FROM workspace_snapshot_restore_anchors WHERE baseline_snapshot_id = ? LIMIT 1").get(id);
    const protectedByRequest = this.context.database.prepare("SELECT 1 FROM workspace_snapshot_restore_requests WHERE snapshot_id = ? AND state NOT IN ('committed', 'failed', 'conflict', 'expired') LIMIT 1").get(id);
    if (protectedByAnchor || protectedByRequest) return undefined;
    const result = this.context.database.prepare("UPDATE workspace_snapshot_manifests SET state = 'expired' WHERE id = ? AND state IN ('committed', 'sealed')").run(id);
    return Number(result.changes) === 1 ? this.getManifest(id) : undefined;
  }

  deleteManifest(id: string): boolean {
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const protectedByAnchor = this.context.database.prepare("SELECT 1 FROM workspace_snapshot_restore_anchors WHERE baseline_snapshot_id = ? LIMIT 1").get(id);
      const protectedByRequest = this.context.database.prepare("SELECT 1 FROM workspace_snapshot_restore_requests WHERE snapshot_id = ? LIMIT 1").get(id);
      if (protectedByAnchor || protectedByRequest) { this.context.database.exec("ROLLBACK"); return false; }
      const blobs = this.context.database.prepare("SELECT blob_sha256, COUNT(*) AS refs FROM workspace_snapshot_entries WHERE manifest_id = ? AND blob_sha256 IS NOT NULL GROUP BY blob_sha256").all(id) as Array<Record<string, SQLOutputValue>>;
      const result = this.context.database.prepare("DELETE FROM workspace_snapshot_manifests WHERE id = ? AND state = 'expired'").run(id);
      if (Number(result.changes) === 1) {
        const decrement = this.context.database.prepare("UPDATE workspace_snapshot_blobs SET ref_count = MAX(0, ref_count - ?) WHERE sha256 = ?");
        for (const blob of blobs) decrement.run(readNumber(blob, "refs"), readString(blob, "blob_sha256"));
      }
      this.context.database.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  deleteBlob(sha256: string): boolean {
    const result = this.context.database.prepare("DELETE FROM workspace_snapshot_blobs WHERE sha256 = ? AND ref_count <= 0").run(sha256);
    return Number(result.changes) === 1;
  }

  private assertAnchorReferences(anchor: WorkspaceSnapshotRestoreAnchor): void {
    const manifest = this.context.database.prepare("SELECT workspace_id, state FROM workspace_snapshot_manifests WHERE id = ?").get(anchor.baselineSnapshotId) as Record<string, SQLOutputValue> | undefined;
    if ((anchor.threadId === undefined) !== (anchor.targetTurnId === undefined) || (anchor.threadId === undefined) !== (anchor.checkpointId === undefined)) {
      throw new Error("Snapshot anchor Turn lineage must be complete or omitted.");
    }
    if (anchor.threadId && anchor.targetTurnId && anchor.checkpointId) {
      const checkpoint = this.context.database.prepare("SELECT workspace_id, thread_id FROM compaction_checkpoints WHERE id = ?").get(anchor.checkpointId) as Record<string, SQLOutputValue> | undefined;
      const turn = this.context.database.prepare("SELECT workspace_id, thread_id FROM ling_turns WHERE id = ?").get(anchor.targetTurnId) as Record<string, SQLOutputValue> | undefined;
      if (!checkpoint || readString(checkpoint, "workspace_id") !== anchor.workspaceId || readString(checkpoint, "thread_id") !== anchor.threadId) throw new Error(`Snapshot anchor checkpoint does not match: ${anchor.checkpointId}`);
      if (!turn || readString(turn, "workspace_id") !== anchor.workspaceId || readString(turn, "thread_id") !== anchor.threadId) throw new Error(`Snapshot anchor target Turn does not match: ${anchor.targetTurnId}`);
    }
    if (!manifest || readString(manifest, "workspace_id") !== anchor.workspaceId || !["committed", "sealed"].includes(readString(manifest, "state"))) throw new Error(`Snapshot anchor baseline manifest is not committed: ${anchor.baselineSnapshotId}`);
  }

  private assertRestoreRequestReferences(request: SnapshotRestoreRequest): void {
    const anchor = this.context.database.prepare("SELECT workspace_id, baseline_snapshot_id FROM workspace_snapshot_restore_anchors WHERE id = ?").get(request.anchorId) as Record<string, SQLOutputValue> | undefined;
    const manifest = this.context.database.prepare("SELECT workspace_id FROM workspace_snapshot_manifests WHERE id = ?").get(request.snapshotId) as Record<string, SQLOutputValue> | undefined;
    if (!anchor || readString(anchor, "workspace_id") !== request.workspaceId || readString(anchor, "baseline_snapshot_id") !== request.snapshotId) throw new Error(`Snapshot restore anchor does not match: ${request.anchorId}`);
    if (!manifest || readString(manifest, "workspace_id") !== request.workspaceId) throw new Error(`Snapshot restore manifest does not match: ${request.snapshotId}`);
  }
}

const manifestSelectSql = "SELECT id, workspace_id, cwd, canonical_root, format_version, state, fingerprint, provenance_watermark, entry_count, total_bytes, created_at, sealed_at, expires_at, failure_reason, schema_version, capture_cwd, capture_kind, source_turn_id, source_run_id, source_checkpoint_id, exclusion_policy_sha256, managed_entry_count, excluded_entry_count, managed_bytes, workspace_fingerprint_sha256, manifest_sha256 FROM workspace_snapshot_manifests";
const entrySelectSql = "SELECT id, manifest_id, relative_path, kind, managed, exclusion_reason, symlink_target, mode, size_bytes, sha256, blob_sha256 FROM workspace_snapshot_entries";
const blobSelectSql = "SELECT sha256, size_bytes, content_type, created_at, ref_count FROM workspace_snapshot_blobs";
const anchorSelectSql = "SELECT id, workspace_id, thread_id, target_turn_id, checkpoint_id, baseline_snapshot_id, baseline_fingerprint, baseline_provenance_watermark, expected_workspace_fingerprint, expected_provenance_watermark, created_at, expires_at FROM workspace_snapshot_restore_anchors";
const restoreRequestSelectSql = "SELECT id, idempotency_key, workspace_id, anchor_id, snapshot_id, expected_workspace_fingerprint, expected_provenance_watermark, state, fencing_epoch, journal_entry_count, last_error, confirmation_id, created_at, updated_at FROM workspace_snapshot_restore_requests";
const journalSelectSql = "SELECT id, restore_request_id, sequence, relative_path, expected_before_sha256, expected_after_sha256, rollback_blob_sha256, rollback_symlink_target, target_blob_sha256, target_symlink_target, rollback_mode, target_mode, target_kind, target_exists, state, updated_at FROM workspace_snapshot_restore_journal";

function mapManifest(row: Record<string, SQLOutputValue>): WorkspaceSnapshotManifest {
  return {
    id: readString(row, "id"), workspaceId: readString(row, "workspace_id"), cwd: readString(row, "cwd"), canonicalRoot: readString(row, "canonical_root"),
    formatVersion: 1, state: readString(row, "state") as WorkspaceSnapshotManifest["state"], fingerprint: readString(row, "fingerprint"),
    provenanceWatermark: readString(row, "provenance_watermark"), entryCount: readNumber(row, "entry_count"), totalBytes: readNumber(row, "total_bytes"),
    createdAt: readString(row, "created_at"), ...(readNullableString(row, "sealed_at") ? { sealedAt: readNullableString(row, "sealed_at") } : {}),
    ...(readNullableString(row, "expires_at") ? { expiresAt: readNullableString(row, "expires_at") } : {}), ...(readNullableString(row, "failure_reason") ? { failureReason: readNullableString(row, "failure_reason") } : {}),
    schemaVersion: 1, captureCwd: readNullableString(row, "capture_cwd") ?? readString(row, "cwd"),
    captureKind: (readNullableString(row, "capture_kind") ?? "user_restore_point") as WorkspaceSnapshotManifest["captureKind"],
    ...(readNullableString(row, "source_turn_id") ? { sourceTurnId: readNullableString(row, "source_turn_id") } : {}),
    ...(readNullableString(row, "source_run_id") ? { sourceRunId: readNullableString(row, "source_run_id") } : {}),
    ...(readNullableString(row, "source_checkpoint_id") ? { sourceCheckpointId: readNullableString(row, "source_checkpoint_id") } : {}),
    ...(readNullableString(row, "exclusion_policy_sha256") ? { exclusionPolicySha256: readNullableString(row, "exclusion_policy_sha256") } : {}),
    managedEntryCount: row.managed_entry_count === null ? readNumber(row, "entry_count") : readNumber(row, "managed_entry_count"),
    excludedEntryCount: row.excluded_entry_count === null ? 0 : readNumber(row, "excluded_entry_count"),
    managedBytes: row.managed_bytes === null ? readNumber(row, "total_bytes") : readNumber(row, "managed_bytes"),
    workspaceFingerprintSha256: readNullableString(row, "workspace_fingerprint_sha256") ?? readString(row, "fingerprint"),
    ...(readNullableString(row, "manifest_sha256") ? { manifestSha256: readNullableString(row, "manifest_sha256") } : {}),
  };
}
function mapEntry(row: Record<string, SQLOutputValue>): WorkspaceSnapshotEntry {
  return { id: readString(row, "id"), manifestId: readString(row, "manifest_id"), relativePath: readString(row, "relative_path"), kind: readString(row, "kind") as WorkspaceSnapshotEntry["kind"], managed: readNumber(row, "managed") === 1, ...(readNullableString(row, "exclusion_reason") ? { exclusionReason: readNullableString(row, "exclusion_reason") as WorkspaceSnapshotEntry["exclusionReason"] } : {}), ...(readNullableString(row, "symlink_target") !== undefined ? { symlinkTarget: readNullableString(row, "symlink_target") } : {}), ...(row.mode === null ? {} : { mode: readNumber(row, "mode") }), sizeBytes: readNumber(row, "size_bytes"), ...(readNullableString(row, "sha256") ? { sha256: readNullableString(row, "sha256") } : {}), ...(readNullableString(row, "blob_sha256") ? { blobSha256: readNullableString(row, "blob_sha256") } : {}) };
}
function mapBlob(row: Record<string, SQLOutputValue>): WorkspaceSnapshotBlob { return { sha256: readString(row, "sha256"), sizeBytes: readNumber(row, "size_bytes"), contentType: "application/octet-stream", createdAt: readString(row, "created_at"), refCount: readNumber(row, "ref_count") }; }
function mapAnchor(row: Record<string, SQLOutputValue>): WorkspaceSnapshotRestoreAnchor { return { id: readString(row, "id"), workspaceId: readString(row, "workspace_id"), ...(readNullableString(row, "thread_id") ? { threadId: readNullableString(row, "thread_id") } : {}), ...(readNullableString(row, "target_turn_id") ? { targetTurnId: readNullableString(row, "target_turn_id") } : {}), ...(readNullableString(row, "checkpoint_id") ? { checkpointId: readNullableString(row, "checkpoint_id") } : {}), baselineSnapshotId: readString(row, "baseline_snapshot_id"), baselineFingerprint: readString(row, "baseline_fingerprint"), baselineProvenanceWatermark: readString(row, "baseline_provenance_watermark"), expectedWorkspaceFingerprint: readString(row, "expected_workspace_fingerprint"), expectedProvenanceWatermark: readString(row, "expected_provenance_watermark"), createdAt: readString(row, "created_at"), ...(readNullableString(row, "expires_at") ? { expiresAt: readNullableString(row, "expires_at") } : {}) }; }
function mapRestoreRequest(row: Record<string, SQLOutputValue>): SnapshotRestoreRequest { return { id: readString(row, "id"), idempotencyKey: readString(row, "idempotency_key"), workspaceId: readString(row, "workspace_id"), anchorId: readString(row, "anchor_id"), snapshotId: readString(row, "snapshot_id"), expectedWorkspaceFingerprint: readString(row, "expected_workspace_fingerprint"), expectedProvenanceWatermark: readString(row, "expected_provenance_watermark"), state: readString(row, "state") as SnapshotRestoreRequest["state"], fencingEpoch: readNumber(row, "fencing_epoch"), journalEntryCount: readNumber(row, "journal_entry_count"), ...(readNullableString(row, "last_error") ? { lastError: readNullableString(row, "last_error") } : {}), ...(readNullableString(row, "confirmation_id") ? { confirmationId: readNullableString(row, "confirmation_id") } : {}), createdAt: readString(row, "created_at"), updatedAt: readString(row, "updated_at") }; }
function mapJournalEntry(row: Record<string, SQLOutputValue>): SnapshotRestoreJournalEntry { return { id: readString(row, "id"), restoreRequestId: readString(row, "restore_request_id"), sequence: readNumber(row, "sequence"), relativePath: readString(row, "relative_path"), ...(readNullableString(row, "expected_before_sha256") ? { expectedBeforeSha256: readNullableString(row, "expected_before_sha256") } : {}), ...(readNullableString(row, "expected_after_sha256") ? { expectedAfterSha256: readNullableString(row, "expected_after_sha256") } : {}), ...(readNullableString(row, "rollback_blob_sha256") ? { rollbackBlobSha256: readNullableString(row, "rollback_blob_sha256") } : {}), ...(readNullableString(row, "rollback_symlink_target") !== undefined ? { rollbackSymlinkTarget: readNullableString(row, "rollback_symlink_target") } : {}), ...(readNullableString(row, "target_blob_sha256") ? { targetBlobSha256: readNullableString(row, "target_blob_sha256") } : {}), ...(readNullableString(row, "target_symlink_target") !== undefined ? { targetSymlinkTarget: readNullableString(row, "target_symlink_target") } : {}), ...(row.rollback_mode === null ? {} : { rollbackMode: readNumber(row, "rollback_mode") }), ...(row.target_mode === null ? {} : { targetMode: readNumber(row, "target_mode") }), targetKind: readString(row, "target_kind") as SnapshotRestoreJournalEntry["targetKind"], targetExists: readNumber(row, "target_exists") === 1, state: readString(row, "state") as SnapshotRestoreJournalEntry["state"], updatedAt: readString(row, "updated_at") }; }

function validateManifestInput(input: CreateWorkspaceSnapshotManifestInput): void { normalize(input.cwd, "snapshot cwd"); normalize(input.canonicalRoot, "snapshot canonical root"); if (!digestPattern.test(input.fingerprint)) throw new Error("Snapshot fingerprint must be SHA-256."); normalize(input.provenanceWatermark, "snapshot provenance watermark"); if (!Number.isSafeInteger(input.entryCount) || input.entryCount < 0 || !Number.isSafeInteger(input.totalBytes) || input.totalBytes < 0) throw new Error("Invalid snapshot manifest counters."); for (const value of [input.managedEntryCount, input.excludedEntryCount, input.managedBytes]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid snapshot manifest coverage counters."); if (input.exclusionPolicySha256 && !digestPattern.test(input.exclusionPolicySha256)) throw new Error("Invalid snapshot exclusion policy digest."); if (input.manifestSha256 && !digestPattern.test(input.manifestSha256)) throw new Error("Invalid snapshot manifest digest."); if (input.state && !workspaceSnapshotManifestStates.includes(input.state)) throw new Error("Invalid snapshot manifest state."); assertTimestamp(input.createdAt); if (input.sealedAt) assertTimestamp(input.sealedAt); if (input.expiresAt) assertTimestamp(input.expiresAt); }
function validateEntryInput(input: CreateWorkspaceSnapshotEntryInput): void { normalizeRelativePath(input.relativePath); if (!workspaceSnapshotEntryKinds.includes(input.kind)) throw new Error("Invalid snapshot entry kind."); if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new Error("Invalid snapshot entry size."); if (input.sha256 && !digestPattern.test(input.sha256)) throw new Error("Invalid snapshot entry digest."); if (input.blobSha256 && !digestPattern.test(input.blobSha256)) throw new Error("Invalid snapshot blob digest."); if (input.kind === "symlink" && input.managed !== false && input.symlinkTarget === undefined) throw new Error("Managed snapshot symlink requires a target."); if (input.managed === false && !input.exclusionReason) throw new Error("Excluded snapshot entry requires a reason."); }
function validateAnchorInput(input: CreateWorkspaceSnapshotRestoreAnchorInput): void { for (const [value, label] of [[input.threadId, "thread"], [input.targetTurnId, "target turn"], [input.checkpointId, "checkpoint"]] as const) if (value !== undefined) normalize(value, `snapshot anchor ${label}`); if ((input.threadId === undefined) !== (input.targetTurnId === undefined) || (input.threadId === undefined) !== (input.checkpointId === undefined)) throw new Error("Snapshot anchor Turn lineage must be complete or omitted."); normalize(input.baselineSnapshotId, "snapshot anchor snapshot"); for (const value of [input.baselineFingerprint, input.expectedWorkspaceFingerprint]) if (!digestPattern.test(value)) throw new Error("Snapshot anchor fingerprint must be SHA-256."); normalize(input.baselineProvenanceWatermark, "baseline watermark"); normalize(input.expectedProvenanceWatermark, "expected watermark"); assertTimestamp(input.createdAt); if (input.expiresAt) assertTimestamp(input.expiresAt); }
function validateRestoreRequestInput(input: CreateSnapshotRestoreRequestInput): void { normalize(input.idempotencyKey, "snapshot restore idempotency key"); normalize(input.anchorId, "snapshot restore anchor"); normalize(input.snapshotId, "snapshot restore snapshot"); if (!digestPattern.test(input.expectedWorkspaceFingerprint)) throw new Error("Snapshot restore fingerprint must be SHA-256."); normalize(input.expectedProvenanceWatermark, "snapshot restore watermark"); if (input.state && !snapshotRestoreStates.includes(input.state)) throw new Error("Invalid snapshot restore state."); if (input.fencingEpoch !== undefined && (!Number.isSafeInteger(input.fencingEpoch) || input.fencingEpoch < 0)) throw new Error("Invalid snapshot restore epoch."); assertTimestamp(input.createdAt); if (input.updatedAt) assertTimestamp(input.updatedAt); }
function validateJournalInput(input: CreateSnapshotRestoreJournalEntryInput): void { normalize(input.restoreRequestId, "restore request"); normalizeRelativePath(input.relativePath); if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw new Error("Invalid restore journal sequence."); if (typeof input.targetExists !== "boolean") throw new Error("Invalid restore journal target existence flag."); if (!workspaceSnapshotEntryKinds.includes(input.targetKind) || (input.state && !snapshotRestoreJournalStates.includes(input.state))) throw new Error("Invalid restore journal state."); for (const digest of [input.expectedBeforeSha256, input.expectedAfterSha256, input.rollbackBlobSha256, input.targetBlobSha256]) if (digest && !digestPattern.test(digest)) throw new Error("Invalid restore journal digest."); for (const mode of [input.rollbackMode, input.targetMode]) if (mode !== undefined && (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777)) throw new Error("Invalid restore journal mode."); assertTimestamp(input.updatedAt); }
function mapNormalize(value: string): string { return value.trim(); }
function normalize(value: string, label: string): string { const result = mapNormalize(value); if (!result) throw new Error(`${label} must not be empty.`); return result; }
function normalizeRelativePath(value: string): string { const result = normalize(value, "snapshot relative path").replaceAll("\\", "/"); if (result.startsWith("/") || result === "." || result.split("/").includes("..")) throw new Error(`Snapshot path escapes workspace: ${value}`); return result; }
function assertTimestamp(value: string): void { if (!timestampPattern.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`Timestamp must be canonical UTC: ${value}`); }
