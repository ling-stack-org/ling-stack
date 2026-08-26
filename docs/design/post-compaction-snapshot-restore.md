# Post-Compaction Snapshot Restore P2

**Status:** Implemented (P2), feature-flagged and validated
**Date:** 2026-08-26
**Scope:** P2 design and implementation contract. Runtime, contract, migration, API, and UI paths are implemented behind the workspace snapshot feature flags; automatic compaction-boundary capture remains explicitly armed rather than implicit.

## 1. Decision summary

Snapshot restore is an explicit, broader workspace mutation. It is not a hidden fallback for selective inverse patch recovery and it is not a conversation-history rollback.

The implementation must follow these rules:

1. The restore target is an immutable content-addressed snapshot plus a durable restore anchor. A condenser summary, harness transcript, Git diff, or model inference can never select or authorize a snapshot.
2. A snapshot restore is offered only when the snapshot was captured as the baseline for the target boundary and the current workspace still matches the recorded post-boundary fingerprint and provenance watermark.
3. The user chooses Restore snapshot explicitly after seeing the managed path set, additions, deletions, and exclusions. Selective inverse patch remains the default Turn undo action.
4. The daemon acquires a workspace recovery lease and a durable fencing epoch. New Runs, queued Runs, approval dispatch, and other workspace mutations must observe the fence and wait or fail with a typed conflict. An in-process lock alone is insufficient.
5. The restore engine uses a staged, journaled per-entry plan. It never runs git reset --hard, replaces the workspace directory, recursively deletes an unbounded path, or overwrites .ling-stack control state.
6. All snapshot bytes and restore intents are durable before any workspace byte changes. After a crash, all-before and all-after states are idempotently recoverable; mixed or externally changed state is a visible conflict and is never silently repaired.
7. Snapshots are additive and content-addressed. Manifests are immutable, blobs are deduplicated by SHA-256, and garbage collection never removes a blob referenced by a live snapshot, restore journal, audit record, or rollback preimage.

This gives Ling a safe opt-in path for cases that selective inverse patches cannot cover, without turning a compaction boundary into permission to erase unrelated user work.

## 2. Relationship to the P1 design

This document extends docs/design/post-compaction-undo.md from commit e0092f7e. The P1 design remains normative for:

- LingThread -> LingTurn -> LingTurnRun -> RunSession lineage;
- canonical timeline and context projection ownership;
- durable WorkspaceMutationRecord and forward/inverse PatchPlan provenance;
- selective inverse undo/reapply, CAS, policy checks, symlink checks, and idempotency;
- compaction checkpoint installation and checkpoint_failed semantics;
- the rule that harness transcript and summary text are evidence only.

P2 adds a snapshot store and a snapshot-specific restore coordinator. It does not add a second conversation timeline, Item authority, or harness rollback protocol.

### What already exists

| Existing flow | P2 reuse | P2 change |
| --- | --- | --- |
| RunSession, LingTurnRun, terminal Run lookup | Resolve target lineage and active writers | Add snapshot anchor references, not a second owner |
| WorkspaceMutationRecord and patch artifacts | Build mutation watermark and target fence | Record snapshot eligibility and post-boundary fingerprint |
| resource_leases workspace/bound-path leases | Serialize recovery with active workspace work | Add a system-owned restore lease and fencing check at Run admission |
| durable Run events and SQLite migrations | Audit and crash evidence | Add snapshot/restore tables and typed restore events |
| existing workspace path/symlink policy helpers | Validate every managed path | Extend validation to directories, binaries, links, and exclusions |
| existing approval/request surface | Explicit local-user confirmation | Add workspace_restore approval payload or equivalent durable confirmation |
| existing workspace change UI and API client | Present affected paths and conflict state | Add snapshot list, preview, confirmation, and restore status |

P2 must not rebuild patch provenance or infer changes from the current Git working tree.

## 3. Scope and non-goals

### In scope

- Full managed-workspace snapshots made of an immutable manifest and content-addressed blobs.
- Snapshot capture at an explicitly armed restore boundary.
- A durable restore anchor that binds a baseline snapshot to a target Turn/Run boundary, current post-boundary fingerprint, and provenance watermark.
- Explicit restore request, durable confirmation, workspace fencing, staged commit, post-restore verification, and restart reconciliation.
- Regular files, text files, binary files, directories, and safe internal symlinks.
- Snapshot quotas, retention, mark-and-sweep blob garbage collection, and observability.
- HTTP/API/UI contracts needed to inspect and explicitly invoke restore.
- Additive migration and feature-flagged rollout.

### Not in scope

- git reset, git checkout, branch switching, index restoration, or commit rollback.
- Restoring .git, .ling-stack, daemon databases, runtime logs, sockets, devices, FIFOs, mounts, extended ACLs, resource forks, or ownership metadata.
- Reconstructing a missing snapshot from a condenser summary, harness transcript, current Git diff, or an inferred file list.
- Automatic snapshot restore after selective inverse CAS failure.
- A force-restore or ignore-conflict switch.
- Cross-machine or remote object storage in the first implementation.
- Workspace knowledge provider implementation or post-compaction undo policy changes.

If a requested workspace contains unsupported entries, the snapshot records its exact coverage and exclusions. Restore never mutates excluded paths; the UI must not label such a restore as an unqualified whole-workspace restore.

## 4. Product semantics

### 4.1 Snapshot baseline versus Turn undo

The most important semantic distinction is the direction of time:

    baseline snapshot S (before target boundary)
            |
            +--> target Turn / Runs apply mutations
            |
    post-boundary workspace fingerprint Fpost
            |
            +--> explicit Restore snapshot(S)
                  restores S's managed paths only

A snapshot captured after a Turn is not a baseline for undoing that Turn. It can be used as an audit or future resume anchor, but it must not be offered as a Turn restore target.

The first P2 implementation therefore exposes two separate actions:

- Selective undo Turn: inverse PatchPlans, narrow touched-path scope, default action.
- Restore snapshot: snapshot ID plus restore anchor, potentially broader scope, explicit user action and confirmation.

When no pre-boundary snapshot exists, snapshot restore is unavailable. It does not get silently captured at request time, because a snapshot taken after the user asks to undo is too late to represent the required baseline.

### 4.2 Capture trigger

Full capture is expensive and must be armed. A capture may be requested by:

1. an explicit user Create restore point action before a risky Turn;
2. a workspace policy that arms capture before compaction for selected workspaces; or
3. a recovery-aware scheduler that has already obtained the user's durable consent for the boundary.

A provider-only compaction response never arms capture. Capture is complete only after the manifest and every referenced blob have been committed and verified. If capture fails, the Turn may continue according to its normal policy, but no restore anchor is exposed.

### 4.3 Restore choice rules

    Turn undo requested
      |
      +-- selective inverse eligible? -- yes --> offer selective undo (default)
      |
      +-- matching pre-boundary snapshot anchor + exact CAS? -- yes --> offer explicit restore
      |
      +-- otherwise --> snapshot restore unavailable; explain why

If selective undo is blocked by a touched-path conflict, the UI may show that a snapshot restore exists, but the user must make a new explicit choice. The daemon must revalidate the snapshot anchor; it must not promote the broader operation automatically.

## 5. Authority and invariants

The authority graph remains:

    Ling timeline
      LingThread -> LingTurn -> LingTurnRun -> RunSession
                                          |
                                          +--> RunEvent / Approval / Artifact
                                          +--> WorkspaceMutationRecord
                                          +--> RestoreAnchor -> SnapshotManifest -> SnapshotBlob

    Condenser summary --------------------> reconstruction evidence only
    Harness transcript -------------------> execution evidence only
    Git status/diff ----------------------> current-state diagnostic only

Required invariants:

1. A snapshot belongs to one canonical workspaceId and one canonical root. cwd may be a descendant execution directory, but the manifest root is stable and realpath-checked.
2. A restore anchor references a snapshot captured before its target watermark and stores the exact expected post-boundary workspace fingerprint. The anchor is invalid if either ordering or fingerprint evidence is missing.
3. Manifest, entry, and blob hashes are immutable. A changed blob is a storage integrity failure, not a best-effort decode.
4. Restore touches only paths in the manifest managed set plus explicit deletions of post-boundary managed entries. Excluded and control paths are never touched.
5. Every restore request has an idempotency key, durable state, fencing epoch, and complete before/after intent before the first workspace write.
6. A successful restore is true only after every managed entry matches the manifest and the resulting managed-workspace fingerprint equals the snapshot fingerprint.
7. A conflict or mixed crash state produces no success response and no hidden retry.
8. Approval is Ling-owned and durable. The harness is not blocked on a synchronous restore RPC and cannot authorize a restore by itself.

## 6. Durable data model

The following types are the implementation contract. All readonly collections are stored in canonical order and validated on read.

### 6.1 Snapshot manifest

    type WorkspaceSnapshotCaptureKind = "user_restore_point" | "compaction_boundary";
    type WorkspaceSnapshotEntryKind = "file" | "directory" | "symlink";

    interface WorkspaceSnapshotManifest {
      readonly id: string;
      readonly schemaVersion: 1;
      readonly workspaceId: string;
      readonly canonicalRoot: string;
      readonly captureCwd: string;
      readonly captureKind: WorkspaceSnapshotCaptureKind;
      readonly sourceTurnId?: string;
      readonly sourceRunId?: string;
      readonly sourceCheckpointId?: string;
      readonly provenanceWatermark: number;
      readonly exclusionPolicySha256: string;
      readonly managedEntryCount: number;
      readonly excludedEntryCount: number;
      readonly managedBytes: number;
      readonly workspaceFingerprintSha256: string;
      readonly manifestSha256: string;
      readonly createdAt: string;
      readonly expiresAt?: string;
      readonly state: "committed" | "expired" | "corrupt";
    }

manifestSha256 hashes canonical JSON metadata plus the sorted entry digest list. It is not a hash of pretty-printed or insertion-order-dependent JSON.

### 6.2 Snapshot entries

    interface WorkspaceSnapshotEntry {
      readonly snapshotId: string;
      readonly relativePath: string;
      readonly kind: WorkspaceSnapshotEntryKind;
      readonly modeBits: number;
      readonly sizeBytes: number;
      readonly contentSha256?: string;
      readonly blobId?: string;
      readonly symlinkTarget?: string;
      readonly managed: boolean;
      readonly exclusionReason?:
        | "control_path"
        | "vcs_metadata"
        | "secret_like_path"
        | "too_large"
        | "unsupported_type"
        | "external_symlink"
        | "case_collision";
    }

Rules:

- file entries reference one raw byte blob, including binary and invalid UTF-8 files.
- directory entries have no blob and preserve empty directories and mode bits.
- symlink entries store link text, never dereferenced target bytes. Only relative links whose resolved target stays within the canonical root are managed.
- managed false entries are recorded for coverage/audit but cannot be mutated by restore.
- modeBits preserves executable/read-only bits only. Ownership, ACLs, xattrs, and mtimes are excluded from the fingerprint and restore contract.

### 6.3 Content-addressed blob

    interface WorkspaceSnapshotBlob {
      readonly id: string;
      readonly sha256: string;
      readonly sizeBytes: number;
      readonly contentType: "raw_bytes";
      readonly storageKey: string;
      readonly createdAt: string;
      readonly lastReferencedAt: string;
    }

The blob path is derived from a validated digest and never from a user path. A blob is written to a temporary file, fsynced, atomically renamed into the daemon runtime object store, then referenced by a committed manifest. The SQLite row is not visible as committed until the object exists and hashes correctly. The manifest payload and entry rows are immutable; expiry/corruption is lifecycle metadata on the snapshot reference and does not rewrite the content-addressed payload.

### 6.4 Restore anchor

    interface WorkspaceSnapshotRestoreAnchor {
      readonly id: string;
      readonly workspaceId: string;
      readonly canonicalRoot: string;
      readonly snapshotId: string;
      readonly targetThreadId?: string;
      readonly targetTurnId?: string;
      readonly targetRunIds: readonly string[];
      readonly baselineWatermark: number;
      readonly postBoundaryWatermark: number;
      readonly baselineFingerprintSha256: string;
      readonly expectedPostBoundaryFingerprintSha256: string;
      readonly managedPathCount: number;
      readonly createdAt: string;
      readonly state: "eligible" | "consumed" | "expired" | "invalid";
    }

An anchor tied to a Turn is created only after the target boundary is terminal and its current managed workspace fingerprint has been captured. `threadId`, `targetTurnId`, and `checkpointId` are required together for that path. A user-selected restore point uses the same durable anchor table with those lineage fields omitted; it is valid for explicit workspace restore but is never shown as Turn undo. `postBoundaryWatermark` must be greater than or equal to `baselineWatermark` whenever a Turn lineage exists.

### 6.5 Restore request and journal

    type SnapshotRestoreState =
      | "requested"
      | "validating"
      | "fenced"
      | "staged"
      | "committing"
      | "verifying"
      | "committed"
      | "conflict"
      | "recovery_required"
      | "failed"
      | "expired";

    interface SnapshotRestoreRequest {
      readonly id: string;
      readonly idempotencyKey: string;
      readonly workspaceId: string;
      readonly canonicalRoot: string;
      readonly snapshotId: string;
      readonly anchorId: string;
      readonly targetTurnId?: string;
      readonly confirmationId: string;
      readonly expectedCurrentFingerprintSha256: string;
      readonly expectedPostBoundaryWatermark: number;
      readonly fencingEpoch: number;
      readonly state: SnapshotRestoreState;
      readonly rollbackManifestId: string;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly failureCode?: string;
      readonly failureMessage?: string;
    }

    interface SnapshotRestoreJournalEntry {
      readonly requestId: string;
      readonly relativePath: string;
      readonly operation: "create" | "update" | "delete" | "mkdir" | "rmdir" | "symlink";
      readonly expectedBeforeSha256: string;
      readonly targetAfterSha256: string;
      readonly stagedBlobId?: string;
      readonly status: "planned" | "staged" | "applied" | "verified";
      readonly appliedAt?: string;
    }

The rollback manifest is a content-addressed capture of every managed pre-restore entry. It is retained until the request reaches committed and the retention grace period has elapsed. This makes a controlled rollback possible after a write failure; the original snapshot alone is not a preimage of the current workspace.

## 7. Managed workspace and fingerprint

### 7.1 Root and exclusions

The canonical root is the realpath of the workspace binding known to the daemon. The manifest walks that root without following directory symlinks.

Always excluded:

- .ling-stack and all descendants;
- .git directories, .git files, and Git administrative metadata;
- sockets, devices, FIFOs, mount points, and entries that disappear during capture;
- paths rejected by the current workspace write policy;
- secret-like paths such as .env, credential/key stores, and configured secret patterns;
- files above the configured single-file limit;
- symlinks resolving outside the canonical root and Windows junctions/reparse points.

The exclusion policy itself is hashed into the manifest. A later restore must use the same policy hash and must never infer a newly included path from a different policy version.

### 7.2 Canonical fingerprint

The managed workspace fingerprint is:

    SHA256(
      for entries sorted by UTF-8 byte order of normalized relativePath:
        relativePath + NUL
        kind + NUL
        modeBits(decimal) + NUL
        sizeBytes(decimal) + NUL
        contentSha256-or-symlinkTarget + NUL
    )

Path normalization uses /, rejects .., preserves case, and applies the platform's canonical Unicode form before hashing. Case-insensitive collisions are captured as case_collision exclusions and make a full restore anchor ineligible until the collision is resolved. Mtime, owner, inode, directory enumeration order, and Git index state do not participate in the fingerprint. Journal hashes use the same canonical representation for a missing path, directory, file, and symlink, so a file-to-directory or directory-to-link replacement cannot accidentally pass a byte-only check.

Two fingerprints are required:

- baseline fingerprint: manifest state before the target boundary;
- expected current fingerprint: state observed after the target boundary and stored in the restore anchor.

Restore requires an exact match to the expected current fingerprint. It does not compare only touched files because snapshot restore may delete or replace any managed path after the baseline.

## 8. Capture lifecycle

    capture request
      -> validate root, policy, quota, exclusion policy
      -> acquire capture lease / boundary fence
      -> walk and stream-hash entries
      -> stage and verify blobs
      -> write manifest + entries in one SQLite transaction
      -> commit manifest and release capture lease
      -> after target boundary: seal RestoreAnchor with Fpost

Capture details:

1. The scheduler pauses new workspace-writing Runs for the capture window. An already active Run makes capture return workspace_busy; capture must not race an untracked write.
2. The walker uses bounded concurrency and streams each file in chunks. It never loads the full workspace or all blobs into memory.
3. A file that changes during hashing is retried once. If it changes again, the capture is snapshot_unverified and no manifest is exposed.
4. Every staged blob is re-hashed from the stored bytes before the manifest transaction.
5. The SQLite transaction inserts the manifest and entries only when every managed blob is present. A crash before commit leaves unreferenced staging objects for GC.
6. The capture result returns a snapshot ID only after the transaction and object fsync succeed. A returned ID is immutable.
7. The post-boundary anchor captures Fpost and the mutation watermark after all target Runs are terminal. If a target Run is still active or effect state is unknown, no anchor is sealed.

The capture lease is not the restore fence. The restore request obtains a fresh system-owned workspace lease and epoch after confirmation.

## 9. Restore lifecycle and atomicity boundary

### 9.1 Validation and fencing

    requested
      -> validating
         - load manifest, entries, blobs, anchor, confirmation
         - verify hashes, root, quota, watermark, expected Fpost
      -> fenced
         - acquire workspace resource lease
         - increment durable fencing epoch
         - reject new writing Runs and approval dispatch
      -> staged
         - capture rollback preimage
         - build complete entry plan
         - stage all file bytes
      -> committing -> verifying -> committed

Validation must fail before any workspace write when:

- the snapshot, anchor, blob, or rollback preimage is missing or hash-invalid;
- the current full managed fingerprint differs from the anchor's expected post-boundary fingerprint;
- the current provenance watermark is after the anchor's post-boundary watermark;
- an active Run, pending approval, or another restore/recovery owns the workspace;
- the original Run write scope or current policy rejects a managed path;
- a path is internal, traversal-derived, symlink-escaping, a type collision, or unsupported;
- the confirmation is absent, expired, for another snapshot, or already consumed.

The fencing epoch is checked by Run admission, queued-run promotion, approval dispatch, and workspace mutation entry points. A stale owner cannot start a new write after the fence is active. Existing active Runs are not killed implicitly; the restore request waits or returns workspace_busy until they are terminal and their approvals are resolved.

### 9.2 Plan construction

The plan is computed from the managed current entry set and snapshot entry set:

- snapshot file absent now: create;
- both present with different digest or mode: update;
- snapshot directory absent now: mkdir;
- snapshot symlink absent/different: remove the current managed entry, then symlink;
- current managed entry absent from snapshot: delete or rmdir;
- unchanged entry: no operation.

Deletes are ordered deepest-first. Directory creation is shallowest-first. File and link writes occur only after all type collisions have been validated. Excluded/control paths are not candidates for deletion.

### 9.3 Staging and commit

Staging is outside the workspace under daemon-owned runtime storage. Each planned file is written to a request-specific temporary object, fsynced, and verified against its target digest. The rollback preimage is captured before the first commit operation.

There is no cross-platform filesystem transaction. The durable journal is the atomicity boundary:

1. persist requested/validating and the complete entry plan;
2. persist rollback preimage and mark staged;
3. commit one entry at a time, recording applied after the expected-before check and atomic file replacement/validated delete;
4. re-scan and verify the complete target fingerprint;
5. append snapshot_restore_committed, mark the anchor consumed, and release the fence.

Before each entry write, the daemon re-checks the current entry digest against expectedBeforeSha256. A mismatch aborts with conflict; it does not overwrite the external change. File replacement uses an atomic temporary-file rename in the same parent directory. Deletion requires the path still to match its expected digest/type and removes only that exact managed path.

### 9.4 Crash reconciliation

    on daemon restart
      -> find restore requests in fenced/staged/committing/verifying
      -> reacquire no workspace lease yet; inspect journal and current fingerprint
      -> all entries before + expected watermark unchanged  => retryable
      -> all entries after + target fingerprint verified      => append committed
      -> mixed entries, external digest change, or missing blob => recovery_required

recovery_required is a durable visible state. The reconciler may perform an explicit rollback to the captured rollback manifest only if every currently changed entry still matches this request's target digest and the rollback manifest verifies. If any external change is detected, it stops and asks the user to review. It never guesses which subset to restore.

The same idempotency key can resume a request classified as retryable. A request already classified as committed returns its stored result without a second mutation. A mixed request cannot be retried under the same key until a separate, explicit recovery decision is made.

## 10. Files, binaries, links, secrets, and large workspaces

| Entry | Capture | Restore | User-visible result |
| --- | --- | --- | --- |
| UTF-8 text | raw bytes plus SHA-256 | atomic byte replacement | managed |
| binary | raw bytes plus SHA-256 | atomic byte replacement | managed, no text diff required |
| directory | mode and path | mkdir/rmdir with ordering | managed |
| internal relative symlink | link text, target containment check | recreate link without dereference | managed |
| external symlink/junction | record exclusion only | never follow or replace | excluded with reason |
| secret-like path | record exclusion only; no bytes persisted | never mutate | excluded and highlighted |
| file over size limit | record exclusion only | never mutate | excluded; Turn anchor ineligible |
| socket/device/FIFO/mount | unsupported | never mutate | snapshot unavailable for full restore |
| .git / .ling-stack | excluded | never mutate | outside snapshot scope |

The first implementation must fail closed for a snapshot intended to be shown as a Turn restore if any path in the target boundary is excluded or unsupported. A user-created restore point may still be listed with partial coverage, but the confirmation surface must show the exclusion count and exact reasons.

Recommended initial limits, overridable per workspace but never above daemon hard limits:

- 200,000 manifest entries;
- 2 GiB managed bytes per snapshot;
- 256 MiB per file;
- 8 committed snapshots per workspace;
- 30-day default retention;
- 24-hour grace period for unreferenced blobs and rollback preimages.

Limit failures are quota_exceeded; partial manifests are never exposed.

## 11. Storage, retention, and garbage collection

The additive migration introduces:

- workspace_snapshot_manifests;
- workspace_snapshot_entries;
- workspace_snapshot_blobs;
- workspace_snapshot_anchors;
- snapshot_restore_requests;
- snapshot_restore_journal_entries;
- workspace_fencing_epochs (or an equivalent durable epoch in the workspace settings row).

Blob bytes live in a daemon-owned content-addressed object directory, not in SQLite and not under the workspace root. Every row is scoped by workspace_id; foreign keys and unique indexes enforce one manifest ID, one (workspace_id, sha256) blob, and one idempotency key per restore request.

GC is mark-and-sweep:

1. mark blobs referenced by committed/non-expired manifests, active anchors, restore journals, rollback manifests, and the audit retention window;
2. sweep only unmarked objects older than the grace period;
3. delete the SQLite blob row only after the object is gone and the deletion is durable.

Quota enforcement may run GC for expired unreferenced data before rejecting a new capture, but it cannot delete a live anchor or a rollback preimage needed by an in-flight request. Restore requests hold a reference until their terminal retention expires.

## 12. API and UI contract

### 12.1 API

    POST /workspace/snapshots
    GET  /workspace/snapshots?cwd=...
    GET  /workspace/snapshots/:snapshotId?cwd=...
    POST /workspace/snapshots/:snapshotId/anchors?cwd=...
    POST /workspace/snapshots/:snapshotId/confirmations?cwd=...
    POST /workspace/snapshot-confirmations/:confirmationId/confirm?cwd=...
    POST /workspace/snapshots/:snapshotId/restore?cwd=...
    GET  /workspace/snapshot-restores/:requestId?cwd=...

    GET  /turns/:turnId/workspace-changes?cwd=...

The restore endpoint accepts:

    interface CreateSnapshotRestoreRequest {
      readonly idempotencyKey: string;
      readonly anchorId: string;
      readonly confirmationId: string;
      readonly expectedCurrentFingerprintSha256: string;
      readonly expectedPostBoundaryWatermark: number;
    }

The daemon ignores client-supplied paths, blob IDs, hashes, or operation lists. It reloads the immutable manifest and computes the plan itself.

Responses:

- 202 while a durable request is queued, staging, or committing;
- 200 for an already committed idempotent request;
- 403 policy/path/symlink denial;
- 404 unknown workspace, snapshot, anchor, or request;
- 409 active work, stale fence, fingerprint mismatch, watermark drift, or mixed state;
- 410 expired/consumed anchor;
- 413 quota/size limit;
- 422 malformed or unsupported snapshot.

The Turn workspace-changes response may include snapshotRestoreOptions, but only for anchors that pass read-only validation. It must include scope: managed_workspace, managed/excluded counts, target snapshot ID, expected fingerprint status, and a human-safe blocked reason. It must not return an enabled restore action based on summary text.

### 12.2 Confirmation and UI

Restore is a two-step durable local-user action:

1. UI loads the manifest preview and asks Ling to create an approval/confirmation record with action type workspace_restore.
2. The user confirms the exact snapshot, root, managed path count, additions, deletions, exclusions, and expected current fingerprint. Only then can the restore request execute.

The UI must show:

- This changes workspace files, not conversation history.
- snapshot capture time, source Turn/Run/checkpoint, and retention expiry;
- managed paths grouped as create/update/delete and excluded paths with reasons;
- current fingerprint: matching, changed, unavailable, or not yet checked;
- Restore snapshot, Review conflict, or disabled state with a concrete reason;
- progress from staged to verifying and a link to the durable restore audit record.

No synchronous harness approval wait is involved. If a harness Run is active, the restore is blocked by the Ling daemon fence until the Run reaches a terminal state.

## 13. Security and policy

- Resolve and validate the canonical root and every relative path before capture, staging, delete, symlink creation, or download.
- Reject absolute paths, traversal, control paths, type collisions, and symlink escapes.
- Re-check both the Run immutable write-scope snapshot and the current workspace policy. Policy changes can narrow authority, never expand it.
- Store no raw provider transcript, command environment, secret value, or secret-like file bytes in events or SQLite JSON. Blob access is daemon-local and workspace-scoped.
- Do not expose storage keys as filesystem URLs. Snapshot previews use bounded metadata and optional redacted content, never an unrestricted local-file URL.
- Enforce local Origin/workspace binding rules already used by workspace file endpoints.
- Treat a corrupt manifest/blob, missing rollback preimage, or stale epoch as a hard failure. Never repair by trusting the current directory listing.

## 14. Observability and audit

Every lifecycle transition records:

- request ID, idempotency key hash, workspace ID, root, snapshot/anchor IDs;
- actor (local-user, daemon, system-recovery), fencing epoch, and state transition;
- baseline/current/target fingerprints and provenance watermarks;
- managed/excluded counts, bytes, duration, and bounded failure code;
- source Turn/Run/checkpoint refs where present.

Suggested metrics:

- workspace_snapshot_capture_total{result};
- workspace_snapshot_capture_bytes;
- workspace_snapshot_restore_total{result};
- workspace_snapshot_restore_conflict_total{reason};
- workspace_snapshot_restore_duration_ms;
- workspace_snapshot_gc_bytes_total;
- workspace_fence_blocked_run_total.

Never log file contents, link targets that leave the root, command lines with secrets, or full path lists at info level. Debug audit can expose relative paths subject to existing local-daemon access controls.

## 15. Failure-mode review

| Failure mode | Required test | Error handling | User result |
| --- | --- | --- | --- |
| File changes while capture hashes | retry-then-abort test | snapshot_unverified, no manifest | capture unavailable |
| Blob write succeeds, SQLite commit crashes | reopen/GC test | unreferenced object swept | no restore option |
| Active Run starts during restore request | fence race test | admission sees epoch/lease | request waits or 409 |
| Pending approval dispatch races fence | approval race test | dispatch denied by fence | approval remains durable, restore blocked |
| Current fingerprint differs | zero-write CAS test | 409 workspace_restore_conflict | review conflict |
| Path type changes file/dir/symlink | plan/type-collision test | fail before write | no partial mutation |
| Crash before first commit | journal replay test | request retryable | no user file changed |
| Crash after partial commit | mixed-state test | recovery_required | explicit recovery required |
| External edit after partial commit | digest-fence test | no automatic rollback | review conflict |
| Final fingerprint mismatch | post-verify test | failed; fence held for review | never claim success |
| Duplicate request | idempotency/reopen test | return stored result | one mutation only |
| Expired anchor/blob | retention test | 410 or 422 | restore unavailable |
| Secret-like or unsupported path | exclusion test | fail closed for Turn anchor | exact exclusion shown |
| Quota exceeded | limit/GC test | 413; no partial manifest | capture/restore unavailable |

There must be no path where a restore fails silently after changing files. Any failure after the first commit entry is either a verified committed result or a durable recovery_required state.

## 16. Test and verification matrix

### Unit tests

- canonical path normalization and UTF-8 ordering;
- manifest canonical serialization and SHA-256 calculation;
- file, directory, binary, safe symlink, external symlink, and type-collision classification;
- managed-workspace fingerprint stability across enumeration order and mtime changes;
- exclusion-policy hash and secret-like path classification;
- restore plan ordering and no-op elimination;
- quota accounting and retention eligibility;
- state-machine transition and stale fencing epoch rejection.

### Core/storage integration tests

- capture, close/reopen SQLite, and reload manifest/entries/blobs;
- content-addressed deduplication across two snapshots;
- foreign-key/integrity checks for deleted/expired anchors;
- blob GC with live anchor, journal, rollback preimage, and grace-period cases;
- restore request idempotency across daemon restart;
- fencing epoch prevents queued Run creation and approval dispatch;
- manifest corruption and missing blob fail closed.

### Daemon/API tests

- capture busy workspace and active approval cases;
- restore create/update/delete/mkdir/rmdir/symlink operations;
- exact fingerprint and watermark CAS, policy drift, path escape, internal path, and symlink escape rejection before the first write;
- staged/committing/verifying crash injection at every journal boundary;
- all-before, all-after, mixed, and externally changed reconciliation;
- 202, 200, 403, 404, 409, 410, 413, and 422 response contracts;
- local Origin and trusted workspace binding.

### UI/E2E tests

- create restore point before a Turn and show it after compaction;
- preview managed/excluded paths and require explicit confirmation;
- restore success updates workspace review while leaving conversation history unchanged;
- active Run/approval displays a blocked reason and resumes after fence release;
- changed fingerprint displays Review conflict with no success toast;
- browser refresh during 202 polling returns the durable request state;
- no snapshot or excluded snapshot never exposes an enabled restore button.

Coverage target is every branch in the capture, fence, journal, reconciliation, and API state machines, including all error paths. A single happy-path restore test is not enough.

## 17. Performance and operational limits

- Stream file hashing and blob writes with bounded concurrency; never buffer a full file or full workspace in memory.
- Reuse blobs by digest. The manifest stores metadata and references, not duplicate bytes.
- Build restore plans from sorted metadata and stream staged blobs. Memory usage is O(entry_count + bounded_chunk_size), not O(total_workspace_bytes).
- Hashing and capture may run in the background, but restore commit is serialized per workspace fence and reports progress through durable state.
- Capture and restore expose byte/entry counts and elapsed time for support diagnosis.
- A workspace over hard limits returns a typed unavailable result; it never degrades to a partial destructive restore.

## 18. Implementation slices and entry criteria

The implementation should land sequentially because all slices share the snapshot schema, fence, and journal. Keep the first code change to these modules; do not introduce a parallel blob service.

| Slice | Modules | Entry criteria | Exit criteria |
| --- | --- | --- | --- |
| R1 contracts/storage | packages/core/src/run-types.ts, packages/contracts, SQLite migrations/store | P1 provenance and runtime paths available | reopen-safe manifests, entries, blobs, anchors, requests |
| R2 capture/fingerprint | packages/core snapshot service | quota/exclusion policy frozen | verified immutable snapshot and anchor creation |
| R3 fence/restore journal | daemon recovery feature + concurrency admission | resource lease and Run admission hooks available | staged restore, CAS, crash reconciliation |
| R4 API/UI | daemon routes, API client, web workspace review | R3 state machine stable | explicit preview/confirmation/progress/conflict UI |
| R5 rollout/ops | metrics, GC, feature flag, docs/tests | focused and reopen tests green | canary enablement with rollback switch |

Implementation rule: do not expose the UI action until R1-R3 have zero-write conflict, all-before/all-after restart, and mixed-state tests. Do not enable capture by default until quota and GC tests pass.

### Parallelization

This is a sequential implementation, not a useful parallel worktree split. R2 depends on R1 storage; R3 depends on R1 and R2; R4 depends on durable R3 states; R5 depends on all preceding behavior. Splitting the shared schema or fence across worktrees would create merge conflicts and duplicate authority.

## 19. Rollout and compatibility

Feature flags:

- workspace_snapshot_capture_enabled (default off);
- workspace_snapshot_restore_enabled (default off);
- workspace_snapshot_restore_ui_enabled (default off);
- workspace_snapshot_gc_enabled (default on only after storage validation).

Rollout order:

1. Ship additive migrations and read-only integrity/GC tooling with all restore flags off.
2. Enable capture for an internal workspace cohort; compare bytes, duration, quota rejects, and corruption count.
3. Enable restore preview without mutation; verify anchors and fingerprint conflict rates.
4. Enable explicit restore for a small cohort; monitor fence blocks, mixed states, and post-verify failures.
5. Expand gradually. Turning restore off blocks new requests but leaves committed snapshots and in-flight journals readable for reconciliation.

Old Runs and P1 recovery rows remain valid with no snapshot reference. A missing snapshot reference means snapshot_unverified or snapshot unavailable; it does not change selective inverse behavior. Downgrades preserve unknown additive tables and blobs; no destructive migration is permitted.

## 20. Engineering review verdict

### Architecture

- Resolved: Snapshot identity is explicit. A post-target snapshot cannot be used as a pre-target undo baseline.
- Resolved: A resource lock is paired with a durable fencing epoch checked by Run admission and approval dispatch, preventing new writers from entering during restore.
- Resolved: Filesystem non-atomicity is handled with staged blobs, rollback preimages, a per-entry journal, post-verify, and a visible mixed-state recovery outcome.

### Code quality and boundaries

- Resolved: Snapshot storage, capture/fingerprint, restore/fence, and API/UI are separate modules. Patch provenance remains the existing authority and is not duplicated.
- Resolved: All client-supplied path/operation lists are hints only; the daemon recomputes the plan from immutable manifest bytes.
- Resolved: Exclusions and unsupported types are first-class data, not silent omissions.

### Test review

The matrix covers capture, storage reopen, CAS, fencing, idempotency, every journal boundary, all-before/all-after/mixed reconciliation, unsupported entries, quota, API status codes, and user-visible conflict/refresh flows. No implementation slice is admitted on happy-path tests alone.

### Performance review

Streaming, digest deduplication, bounded concurrency, explicit hard limits, and background GC keep the feature from loading or copying an entire workspace into process memory. Restore commit remains serialized per workspace by design; this is the safety tradeoff for a broad filesystem mutation.

### Unresolved-decision verdict

There are no unresolved design decisions for implementation. The load-bearing choices are:

- snapshot restore is explicit and broader than selective inverse undo;
- only a pre-boundary snapshot plus exact post-boundary CAS can produce an enabled restore;
- workspace fencing blocks new writers, and mixed crash state requires visible recovery;
- snapshots exclude control/VCS/secret-like/unsupported paths and disclose coverage;
- additive, content-addressed storage with quota/retention/GC is mandatory.

**Frozen for implementation.**
