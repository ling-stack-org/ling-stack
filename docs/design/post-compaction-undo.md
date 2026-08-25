# Post-Compaction Workspace Undo

Status: V1 selective-inverse implementation landed; snapshot restore remains explicitly
gated and unimplemented.
Date: 2026-08-25
Scope: define how Ling can undo workspace changes whose source `LingTurn` or raw
harness messages are no longer present in the active context after compaction.

## Executive decision

Post-compaction undo is a workspace-provenance operation, not a conversation-history
operation.

The normative V1 behavior is:

1. Keep `LingThread`, `LingTurn`, `ConversationItem`, `RunSession`, `RunEventEnvelope`,
   approval records, artifacts, and patch provenance durable across context compaction.
2. Selectively apply inverse patch plans in reverse mutation order. The existing
   `workspace-change-recovery.ts` path is the implementation base for this behavior.
3. Use workspace snapshots and fingerprints as validation anchors and recovery baselines,
   not as an excuse to overwrite a changed workspace.
4. Permit whole-snapshot restore only as a future, explicitly selected optimization when
   there are no later writes and the complete workspace fingerprint still matches. It is
   never the default undo path.
5. Treat a condenser summary, harness transcript, or model inference as context evidence.
   None of them is undo authority.

The user-visible rule is simple: if Ling cannot prove which durable mutation records belong
to the target Turn and that the current workspace still matches their post-state, undo is
blocked with a reviewable reason. It must not guess from a summary and must not silently
overwrite newer edits.

## Reference implementation: Codex upstream

The comparison below was made against `openai/codex` at commit
[`6525b95d`](https://github.com/openai/codex/tree/6525b95dae2082ac9fee672b14c2cffdef172bb8)
(2026-08-25). These are design references, not dependencies.

| Codex source | Observed behavior | Ling takeaway |
| --- | --- | --- |
| [`codex-rs/core/src/compact.rs`](https://github.com/openai/codex/blob/6525b95dae2082ac9fee672b14c2cffdef172bb8/codex-rs/core/src/compact.rs) lines 64-89, 352-389 | Compaction creates replacement history and records checkpoint metadata separately. Initial context may be re-injected at a defined boundary. | A compacted prompt is a replacement view. Preserve an explicit checkpoint and lineage rather than treating the summary as the original history. |
| [`codex-rs/core/tests/suite/compact_resume_fork.rs`](https://github.com/openai/codex/blob/6525b95dae2082ac9fee672b14c2cffdef172bb8/codex-rs/core/tests/suite/compact_resume_fork.rs) lines 508-590 | Rolling back behind a compaction replays append-only history and keeps the earlier compaction summary while removing the later Turn. | Rollback must resolve a durable boundary, not delete an arbitrary suffix of the current prompt. A compaction boundary survives historical navigation. |
| [`codex-rs/app-server-protocol/schema/json/v2/ThreadRollbackParams.json`](https://github.com/openai/codex/blob/6525b95dae2082ac9fee672b14c2cffdef172bb8/codex-rs/app-server-protocol/schema/json/v2/ThreadRollbackParams.json) lines 3-7 | The protocol explicitly says rollback changes thread history and does not revert local file changes; clients are responsible for files. | Conversation rollback and workspace undo are separate authorities. Ling must make workspace recovery explicit instead of assuming harness rollback is enough. |
| [`codex-rs/thread-store/src/local/revert_thread.rs`](https://github.com/openai/codex/blob/6525b95dae2082ac9fee672b14c2cffdef172bb8/codex-rs/thread-store/src/local/revert_thread.rs) lines 15-18, 38-121 | Paginated revert writes a new immutable rollout, leaves old rollouts intact, and switches one SQLite pointer with compare-and-set semantics. | Prefer immutable provenance plus a narrow durable cutover. Never mutate or truncate the only copy of history while an undo is in flight. |
| [`codex-rs/rollout-trace/src/reducer/compaction.rs`](https://github.com/openai/codex/blob/6525b95dae2082ac9fee672b14c2cffdef172bb8/codex-rs/rollout-trace/src/reducer/compaction.rs) lines 78-82, 113-169 | A compaction request can complete as evidence before a separate install event changes the reduced conversation graph. | Do not infer a live checkpoint from a provider response. Install a durable Ling compaction checkpoint only after its source and replacement projection validate. |

Codex's `thread/rollback` is therefore useful as a history-boundary reference, but it is
not a workspace undo implementation. Ling owns the product-level workspace decision and
must retain that authority after the harness has compacted or discarded prompt items.

## Existing Ling foundation

This design extends existing paths and does not introduce a second Item or patch store:

- `LingThread` and `LingTurn` remain the canonical product timeline and source of user
  semantics.
- `RunSession.contextViewId` and `contextViewCreatedAt` identify the immutable context
  projection used to create a Run. They are useful for auditing context drift, but they do
  not describe workspace state by themselves.
- `RunEventEnvelope` is typed execution evidence. Tool, approval, artifact, and terminal
  events remain replayable after context text is condensed.
- `RunArtifact` and approval payloads already carry bounded patch plans and source refs.
- `packages/daemon/src/features/runs/workspace-change-recovery.ts` already provides:
  inverse patch construction, reverse-order application, hash-guarded preflight, write-scope
  checks, durable `workspace_change_recovery_started` / `workspace_changes_undone` /
  `workspace_changes_reapplied` events, and interrupted-recovery observation.
- `ConversationItemV1` is a typed read-only projection of execution evidence. It does not
  become a workspace mutation authority.

The compaction-to-provenance watermark and Turn-level recovery path are now durable. Patch
applications write immutable mutation records and sealed forward/inverse PatchPlan artifacts;
compaction install writes an immutable checkpoint; Turn recovery resolves all linked terminal
Runs without consulting discarded prompt text.

## Authority boundaries

```text
Ling timeline (authoritative)
  LingThread -> LingTurn -> ConversationItem
       |             |
       |             +--> LingTurnRun -> RunSession -> RunEventEnvelope
       |                                      |
       |                                      +--> Approval / RunArtifact / PatchPlan
       |                                      |
       |                                      +--> WorkspaceMutationRecord
       |
       +--> CompactionCheckpoint
                    |
                    +--> covered Turn/Item range
                    +--> context snapshot + summary refs
                    +--> workspace provenance watermark

Condenser summary ----------------------> context reconstruction evidence only
Harness transcript ---------------------> execution evidence/message projection only
WorkspaceMutationRecord + PatchPlan ---> undo authority
WorkspaceSnapshotRef + fingerprint ----> validation / optional restore anchor
```

The following are never valid substitutes for `WorkspaceMutationRecord`:

- a natural-language condenser summary;
- an assistant message saying that a file was changed;
- an unpaired `tool_start` or a provider transcript with no durable `tool_end`;
- a Git diff observed after the fact with no Run/Turn/approval provenance;
- a mutable `ChannelContextView` or a later channel state.

## Domain model

The names below are the proposed durable model for the implementation slice. They are
deliberately compatible with the existing Run/Artifact/PatchPlan records.

### CompactionCheckpoint

One immutable checkpoint is created only after a context compaction has installed its
replacement projection.

```ts
interface CompactionCheckpoint {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly channelId?: string;
  readonly sourceTurnId: string;
  readonly contextViewId?: string;
  readonly contextViewCreatedAt?: string;
  readonly coveredItemSeqFrom: number;
  readonly coveredItemSeqTo: number;
  readonly coveredTurnIds: readonly string[];
  readonly summaryIds: readonly string[];
  readonly summaryContentSha256?: string;
  readonly sourceRefs: readonly SourceRef[];
  readonly workspaceProvenanceWatermark: string;
  readonly compactionPolicyVersion: string;
  readonly createdAt: string;
}
```

Required invariants:

- `sourceTurnId` belongs to `threadId`; every `coveredTurnId` belongs to the same thread.
- The covered Item range is a canonical `ConversationItem` sequence range, not a harness
  event sequence and not a prompt token offset.
- `workspaceProvenanceWatermark` is the last committed mutation sequence visible when the
  replacement context was installed. It is a high-water mark, not a claim that no future
  mutation exists.
- Summary IDs and source refs are for context reconstruction and audit display. They do not
  authorize file recovery.
- Checkpoints are append-only. A later compaction supersedes a view but does not rewrite the
  earlier checkpoint.

### WorkspaceMutationRecord

One record represents one applied, reversible workspace operation. A patch plan may produce
multiple records, one per file operation, grouped by a stable `patchPlanId`.

```ts
interface WorkspaceMutationRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly runId: string;
  readonly toolCallId?: string;
  readonly approvalId?: string;
  readonly artifactId?: string;
  readonly patchPlanId: string;
  readonly operationIndex: number;
  readonly path: string;
  readonly operation: "add" | "update" | "delete" | "move";
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly inversePatchArtifactId: string;
  readonly provenanceSeq: number;
  readonly effectState: "applied" | "effect_unknown" | "failed";
  readonly createdAt: string;
}
```

The record is immutable. A later undo or reapply appends recovery events; it does not edit
`beforeSha256`, `afterSha256`, or the original patch artifact.

### WorkspaceSnapshotRef

Snapshots are content-addressed manifests, not an implicit `git reset`:

```ts
interface WorkspaceSnapshotRef {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly scope: "turn" | "run" | "compaction";
  readonly sourceTurnId?: string;
  readonly sourceRunId?: string;
  readonly provenanceWatermark: string;
  readonly manifestSha256: string;
  readonly entries: readonly WorkspaceSnapshotEntry[];
  readonly storageArtifactId?: string;
  readonly createdAt: string;
}
```

For the first implementation, a snapshot may contain only the touched-path manifest plus
content-addressed copies needed for recovery. A full repository snapshot is optional and
must never be silently substituted for a patch plan.

### Undo request and durable state

```ts
type PostCompactionUndoState =
  | "available"
  | "validating"
  | "applied"
  | "conflict"
  | "provenance_missing"
  | "snapshot_unverified"
  | "expired"
  | "failed";

interface PostCompactionUndoRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly targetTurnId: string;
  readonly targetRunIds: readonly string[];
  readonly checkpointId?: string;
  readonly expectedWorkspaceFingerprint: string;
  readonly action: "undo" | "reapply";
  readonly state: PostCompactionUndoState;
  readonly affectedPaths: readonly string[];
  readonly lastEventSeq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

`idempotencyKey` is required for every user or recovery-worker request. A duplicate request
returns the existing durable result; it never applies the inverse patch twice.

## Provenance capture lifecycle

The implementation should capture workspace evidence at four boundaries:

```text
Turn accepted
  -> capture pre-turn touched-path basis (or an empty lazy watermark)
  -> Run created with immutable contextView lineage
  -> tool/approval execution
       -> before hash + after hash + inverse patch artifact
       -> WorkspaceMutationRecord committed with Run/Turn/approval/artifact refs
  -> Run terminal publication
       -> capture post-run watermark/fingerprint
  -> compaction install
       -> create CompactionCheckpoint with covered Turn/Item range
          and workspace provenance watermark
```

The order matters. A provider response or `tool_start` may describe an intended effect, but
only a validated patch application followed by a durable mutation record makes that effect
eligible for undo. If a tool ends with an unknown effect, the record remains visible for
audit and the target is blocked from automatic recovery.

Compaction must not delete or rewrite any of these records. It may remove prompt sections,
raw context messages, or low-survival sections from the next `ChannelContextView`.

## Selecting the undo target

The public operation targets a Ling Turn, not a summary string and not an arbitrary harness
event sequence.

Default selection:

1. Resolve `targetTurnId` in the canonical `LingThread`.
2. Resolve all `LingTurnRun` rows for that Turn, including retries and resume attempts.
3. Select mutation records for those Runs whose `effectState` is `applied` and whose
   provenance belongs to the target Turn.
4. Exclude records already covered by a later committed undo, or mark the request as an
   idempotent replay of that undo.
5. Sort by durable mutation order descending. For a workflow, reverse the committed
   operation order and preserve dependency fencing before a fan-in target is undone.

No step reads a condenser summary to infer a path. If the Turn has no complete mutation
provenance, return `provenance_missing` even when the summary claims that a file changed.

## Validation and CAS protocol

Undo is a compare-and-set operation over both durable state and workspace bytes.

```text
request(idempotencyKey, targetTurnId)
  |
  v
load canonical Turn + Run lineage + CompactionCheckpoint + mutation records
  |
  +-- missing/incomplete/effect_unknown --> provenance_missing
  |
  v
acquire workspace recovery lock (workspaceId, canonical cwd)
  |
  v
re-read current path hashes and policy
  |
  +-- any current hash != expected afterSha256 --> conflict, no mutation
  +-- policy/path/symlink check fails       --> conflict, no mutation
  +-- active Run or competing recovery      --> conflict, no mutation
  |
  v
append recovery_started with complete before/after intent
  |
  v
stage and apply inverse patches in reverse order
  |
  +-- crash/exception --> replay recovery_started and classify before/after/partial
  |
  v
verify all post-undo hashes and workspace fingerprint
  |
  +-- mismatch --> failed/conflict; never claim success
  |
  v
append recovery_applied + durable state transition to applied/undone
```

The current workspace must match every mutation's `afterSha256` before undo. This is the
minimal safe CAS condition. A later edit to an unrelated file may be tolerated when the
workspace identity and touched-path fingerprints still match; a later edit to a touched
path is a conflict.

The lock is per canonical Ling workspace binding, not per Run. Two Runs touching the same
file therefore serialize even if their conversation Turns are unrelated. A lock does not
replace hash validation because external editors and processes can mutate files without
holding the Ling lock.

## Snapshot restore policy

Selective inverse patch is the default because it preserves unrelated user work. A snapshot
restore may be offered only when all conditions hold:

- the target Turn is the only mutation after the snapshot watermark;
- every snapshot entry is available and checksum-verified;
- the current workspace fingerprint exactly matches the target Turn post-state;
- no active Run, approval, or recovery operation references the workspace;
- the user explicitly selects “restore snapshot” and the UI shows the affected paths.

If any condition fails, downgrade to selective inverse patch or block. Never implement
snapshot restore as `git reset --hard`, directory replacement, or a broad delete. Missing
snapshot content produces `snapshot_unverified`; it does not fall back to summary text.

## Durable events and state machine

The existing run event names remain compatible. The compaction-aware implementation should
add a narrow typed domain envelope or a dedicated durable table for the following lifecycle;
the exact storage choice is an implementation task, not a reason to add another conversation
timeline.

```text
available
   |
   +--> validating --+--> applied       (undo committed)
   |                 +--> conflict      (CAS/policy/lock mismatch)
   |                 +--> provenance_missing
   |                 +--> snapshot_unverified
   |                 +--> expired
   |                 +--> failed        (apply or verification failure)
   |
   +--> validating --+--> undone        (reapply committed)
```

Each transition carries:

- `idempotencyKey` and recovery record ID;
- target `threadId`, `turnId`, `runIds`, and optional `checkpointId`;
- expected and observed workspace fingerprints;
- affected paths and old/new hashes;
- source refs to Run, Approval, PatchPlan, Artifact, and CompactionCheckpoint;
- a monotonic event sequence and actor (`local-user`, `system-recovery`, or `daemon`);
- a bounded, user-safe reason. Raw provider transcripts and secrets are excluded.

An interrupted `recovery_started` event is not success. On daemon restart, the recovery
reconciler compares the recorded before/after hashes for every path:

- all paths at before-state: safe to retry with the same idempotency key;
- all paths at after-state: append the missing terminal event idempotently;
- mixed or unknown state: `conflict`, preserve files, require review;
- unreadable or missing provenance: `provenance_missing`.

## Compaction linkage rules

Every compaction install must persist the following checkpoint facts before exposing an undo
affordance:

| Field | Purpose |
| --- | --- |
| `coveredItemSeqFrom` / `coveredItemSeqTo` | Identifies the canonical Item range represented by the replacement context. |
| `coveredTurnIds` | Keeps product Turn semantics independent of harness turn IDs. |
| `contextViewId` and creation time | Binds the prompt projection used by the Run and detects context drift. |
| `summaryIds` and content hash | Allows context inspection and audit without granting undo authority. |
| `workspaceProvenanceWatermark` | Finds mutation records visible at compaction install. |
| `sourceRefs` | Links the checkpoint to source Items, Turns, Runs, and artifacts. |
| `compactionPolicyVersion` | Makes future replay deterministic across policy changes. |

The compaction installer must validate that each covered Turn belongs to the same thread and
that the watermark is monotonic. A failed or provider-only compaction request creates evidence
of the attempt but no installed checkpoint.

## Concurrency and recovery cases

| Situation | Required result | User-visible behavior |
| --- | --- | --- |
| Compaction followed by a new Turn editing a touched file | Block target undo because post-state no longer matches. | “Workspace changed after this Turn; review or choose a separately supported rebase flow.” |
| Two Runs edit the same file | Serialize by workspace lock, then hash-check in mutation order. | One target may undo; the other shows a conflict until the user chooses a target. |
| Daemon crashes before `recovery_started` | No durable mutation was attempted by Ling. | Request can be retried. |
| Crash after `recovery_started`, before all writes | Reconcile before/after hashes. | Mixed state is blocked, never silently rolled back. |
| Crash after all writes, before terminal event | Reconcile all after hashes and append the terminal event idempotently. | UI eventually shows completed undo. |
| Missing snapshot but complete inverse patch | Use selective inverse patch. | Snapshot restore is unavailable; undo remains available if CAS passes. |
| Missing inverse patch or mutation record | Block. | “Undo unavailable: durable workspace provenance is incomplete.” |
| Stale artifact or approval payload | Revalidate content hash and source refs. | Block with an artifact/provenance reason. |
| Repeated undo request | Return the existing idempotent result. | No second file mutation. |
| Undo and reapply race | One recovery lock and one idempotency/CAS winner. | Losing request receives current state/conflict. |
| `tool_start` without a known effect | Never infer success or inverse patch. | Show effect-unknown and disable automatic undo. |
| Approval-gated mutation denied or expired | No mutation record eligible for undo. | No undo affordance for the denied effect. |
| Compaction runs while a target Run is active | Checkpoint may install only after the active Turn boundary is durable. | Undo remains unavailable until terminal provenance settles. |
| Binary, symlink, or unsupported external mutation | No text inverse patch is fabricated. | `provenance_missing` or `snapshot_unverified`; offer manual review. |

## User-visible contract

The workspace change panel should show:

- target Ling Turn title and timestamp;
- source Run IDs, retry/resume roles, and compaction checkpoint ID when applicable;
- affected paths with old/new hashes and operation type;
- whether the current workspace still matches the expected post-state;
- `Undo`, `Reapply`, or `Review conflict` actions with explicit disabled reasons;
- a link to the source Item/Run/Approval/Artifact evidence;
- a clear notice that undo changes workspace files, not the canonical conversation timeline.

The following states must never be represented as a successful undo:

- a summary-only claim;
- a partial file application;
- a provider transcript with no durable patch basis;
- a missing or unverifiable snapshot;
- a conflict hidden behind a generic HTTP 200.

## Security and policy constraints

Recovery reuses the Run's immutable write-scope snapshot and the current workspace policy.
Both must allow every touched path. The implementation must continue to enforce:

- canonical workspace and path traversal checks;
- no symlink escape outside the approved workspace;
- no mutation of `.ling-stack` internal state through recovery;
- no raw secrets in snapshot manifests, patch artifacts, or event payloads;
- local workspace request authentication and workspace binding checks;
- bounded artifact sizes and retention metadata.

Changing the current policy after a Run completes cannot expand the original Run's authority;
it can only keep recovery allowed when both the original and current policies permit it.

## Implementation status

The following slices are implemented in the current daemon/core code:

### S1: provenance and checkpoint persistence (P1) — implemented

- Durable `CompactionCheckpoint` and `WorkspaceMutationRecord` contracts, SQLite migration,
  mappers, and reopen coverage are present.
- Successful patch apply seals forward/inverse PatchPlan artifacts and records each operation
  with Turn/Run/Approval/Artifact refs plus a monotonic workspace watermark.
- A validated summary commit installs a checkpoint; stale summary candidates do not.

### S2: compaction-aware recovery engine (P1) — implemented

- Turn recovery resolves all retry/resume `LingTurnRun` attempts and the matching checkpoint,
  applies inverse plans in reverse provenance order, and reapplies in forward order.
- Selective inverse patch is the only automatic path. Workspace locks, policy/symlink checks,
  hash-guarded preflight, post-write verification, and interrupted-recovery reconciliation are
  enforced. Cross-workspace Run lineages fail closed.
- Existing run-level recovery remains compatible; legacy Runs without provenance retain the
  old run-level fallback but are not eligible for Turn-level undo.

### S3: projection and API surface (P2) — implemented (minimal)

- `TurnWorkspaceChangesResponse` exposes checkpoint ID, Run lineage, provenance completeness,
  state, capabilities, affected files, and blocked reasons.
- HTTP routes and API-client methods are available at `/turns/:turnId/workspace-changes` and
  `/undo` / `/reapply` variants. Recovery lifecycle remains typed RunEvent evidence; it does
  not create a second canonical timeline.
- Snapshot restore has no route or implicit fallback; any future action must be explicit.

### S4: optional snapshot restore (P2, gated)

- Add content-addressed snapshot storage only if selective inverse patch cannot cover a
  demonstrated product case.
- Require exact fingerprint match and an explicit user action.
- Retain old snapshots and use a CAS pointer cutover; never overwrite the only source.

## Verification matrix

The implementation is not complete until the following cases have focused tests and at least
one SQLite reopen/replay path where applicable:

| Case | Expected assertion |
| --- | --- |
| Undo the same Turn before and after compaction | Identical inverse patch result; summary presence does not change authority. |
| Raw messages compacted away | Undo still resolves through Turn -> Run -> mutation provenance. |
| No-op Turn | No undo affordance and no fabricated mutation record. |
| Tool starts, daemon crashes before effect is known | Effect remains unknown; no automatic undo. |
| Tool ends with an applied patch | Before/after hashes and inverse plan survive reopen. |
| Later Turn edits the same file | CAS conflict; zero writes from the blocked undo. |
| Later Turn edits an unrelated file | Selective undo succeeds if all target paths still match. |
| Missing snapshot, complete inverse patch | Selective undo succeeds; snapshot restore is unavailable. |
| Missing inverse patch/provenance | `provenance_missing`; no summary fallback. |
| Duplicate undo idempotency key | One mutation and one terminal result. |
| Daemon restart after `recovery_started` | Before/after/mixed classification is deterministic. |
| Undo then reapply | Reapply uses the original forward patch and hash guards. |
| Multiple Runs in one Turn | Reverse mutation order and one durable target result. |
| Multiple Turns in one workflow | Reverse committed operation/dependency order; fan-in remains fenced. |
| Approval-gated mutation | Only approved and successfully applied patch records are eligible. |
| Compaction request succeeds but install fails | Evidence exists; no installed checkpoint or undo target is claimed. |
| Invalid cross-thread checkpoint refs | Migration/replay fails closed without visible mutation. |
| SQLite foreign-key/integrity/replay checks | All provenance and recovery rows remain referentially valid and idempotent. |
| Path traversal, symlink escape, internal path, policy drift | Recovery is denied before any write. |

## What this implementation does not do

- It does not make the harness transcript the Ling conversation authority.
- It does not make compaction summaries reversible state.
- It does not add a second `ConversationItem` store.
- It does not change `RunSession.turnId`, `queue_followup`, or `interrupt_redirect` contracts.
- It does not implement a `workspace_knowledge` provider.
- It does not implement full-workspace snapshot restore; selective inverse patch is the only
  automatic recovery path.
- It does not use `git reset`, directory replacement, force overwrite, or an implicit “force
  undo” path.

## Final design verdict

The design has no unresolved authority decision: selective inverse patch backed by durable
Run/Turn mutation provenance is the default; snapshots are validation anchors and an optional,
explicitly gated optimization. The remaining work is broader verification, UI projection, and
the separately gated snapshot-restore slice. Codex's history rollback and immutable rollout
cutover are references for lineage and CAS, not a replacement for Ling's product-owned
workspace recovery authority.
