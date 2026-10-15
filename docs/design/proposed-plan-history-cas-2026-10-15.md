# Proposed plan history and atomic actions — A26

## Scope and evidence

The original A26 repair contract is `output/e6-20260928/office-full-content-review-20261010/post-review-repair-plan.md:49`.
The first clean public HTTP/SQLite regression has 0/3 passing, actual exit 1; see `output/e6-20260928/a26-20261015/root-first-clean-history-red-20261015.md`.
An existing action must not upsert a stale UI snapshot before performing its action. Shared Core enforcement also covers direct Store writers.

## Module boundaries

- Contracts/Core types: durable `revision` versus plan-lineage `version`, mutation expectation, domain action input/result and conflict codes.
- SQLite: add a revision column to the existing plan table; immutable/CAS enforcement at the shared Store; one domain action transaction for plan, Task and workflow/step writes.
- Daemon: validate input and scope, invoke the Core action, map domain conflicts to 409, hydrate read-only source availability.
- Web: carry the displayed revision for edits and snapshot actions; use the canonical returned plan, not stale pre-action text. No second renderer or new UI state machine.
- Tests: public route/SQLite/reopen history regression, independent Core/CAS/fault matrix, relevant existing API/transcript/source hydration tests, current Desktop source-input checks.

## Revision and immutability

`version` identifies the lineage version. New refinement has `version = parent.version + 1`; ordinary editing does not use version as a lock.
`revision` is a durable positive SQLite integer, initially 1 and advanced on each actual mutation. SQL must compare the expected revision, workspace/id and current lifecycle before updating. A timestamp is not a concurrency token.
Core durable rows always contain it. The presentation contract permits it to be absent only for an unpersisted message-derived proposal; that projection must not fabricate a token. Persisted HTTP responses contain the real row revision.
Existing-row content/scope/lineage editing requires `expectedRevision`; no next-version or old-client fallback. Identical complete writes may return the canonical row without changing it. The regression's legal draft PATCH setup will carry the new revision; original RED and all history/Task assertions remain preserved.
Core metadata writes must not replay a stale complete row: use narrow assignments and revision CAS. All actual generic PUT/PATCH changes, including metadata, need an expectation. Domain actions capture their own current revision inside the transaction. Explicit stale expectations conflict rather than silently falling back to the latest row.

PATCH must finish reading its body before checking the current owning thread. Carry the route's Host-owned `expectedThreadId` into the shared Store (never take it from the body), reject a mismatching canonical row before an identical/no-op return, and include the owning thread in the update SQL predicate. Upsert carries its required input thread as the same expectation when delegating to update. This prevents a same-id/same-revision plan recreated under another thread from consuming an old route mutation; a missing row is not returned as a fabricated success from the pre-read snapshot.

A plan is sealed if its status is accepted or it has any accepted timestamp, Task/workflow/step/Run reference. Archiving does not remove that seal.
The seal protects title/body, lineage version/group/parent, source/scope/owner and established accepted facts. These cannot be overwritten, cleared or reverted to draft, including through upsert or direct Store update.
Save may update saved metadata. Archive may set archived lifecycle metadata without erasing accepted facts. Conversion may add previously absent workflow lineage atomically, but cannot replace established IDs or acceptance timestamps. Explicit Core refinement owns the successor pointer; arbitrary client changes cannot forge it.

## Existing action snapshots

For an existing id, `action.plan` is a snapshot/reference, not an editing command. Validate its supplied content/scope/lineage against the canonical row. A mismatch yields a 409 before any write; matching old metadata revision may be treated as a safe idempotent reference only when it causes no content replacement.
An action with no `plan` body operates on the authoritative row read inside its transaction. For a new id, a complete draft payload may be persisted and acted on inside the same transaction; errors roll it back. Thread mismatch is not-found and cannot move a row.
PUT/PATCH are the explicit editing boundary and require the current revision for changes. Public mutation cannot manufacture acceptance or successor facts; those are action-owned.

## Refine and retry

Refine always creates a separate draft, including `{}`. Copy content and source scope into a fresh id, set `parentPlanId`, retain the group, increment lineage version, and do not inherit accepted Task/workflow/Run/timestamps or saved/archive metadata.
Link the parent's `supersededByPlanId` in the same transaction. Accepted parent status stays accepted; archived parent stays archived; an unaccepted draft parent becomes superseded.
Once a child has a parent, its lineage/group/version and scope/source/owner identity are fixed. Its unaccepted title/body remain editable with revision CAS, so a parent retry can still validate and return the same legitimate child after content editing.
The existing single successor pointer defines a linear contract: repeated refine of that parent returns that same direct child when no stale top-level expectation is supplied. An explicit old top-level expectation still yields 409 and creates no extra child; reload before retrying. To refine again, operate on the returned child. This deliberately does not invent branching or guess whether an identical retry was a new request. Validate stored child/group/parent identity before reusing it; corrupt lineage conflicts rather than manufacturing another child.

## Atomic actions and writers

The domain Core action re-reads the plan and thread under SQLite write serialization. Creation of a Task plus acceptance refs, or workflow plus every step and conversion refs, is one transaction. CAS failure or any inserted-row fault rolls back everything. Duplicate accept/convert returns the existing canonical IDs and cannot create or execute a Run. A superseded or archived row cannot create a new Task/workflow; existing IDs may still be returned idempotently. Use its current successor to start new work.
Use a savepoint-compatible synchronous implementation for nested Store use, with rollback preserving the original error. No asynchronous callbacks or external effects belong inside the transaction. No new general scheduler or unrestricted transaction API.
AI reply recording is source insertion, not a second editor: an existing source-derived id is not overwritten by replay. Read-only source availability hydration does not change revision or sealed history.

## Verification and limits

Verify: stale save/accept/refine full snapshots; refine `{}` and retry; same-version stale draft edits; missing/invalid expectations; direct Core upsert/update; archive-then-edit; source replay/hydration; concurrent independent connections; injected Task/workflow/step/CAS failures with no orphan rows; normal save/archive/accept/convert; reopen durability; zero unconfirmed Runs/model calls.
Update existing test fixtures only for the explicit revision and successor contracts, retaining their previous functional assertions. Record any changed baseline separately from first RED.
This work does not claim OS crash simulation, real-model/packaged GUI acceptance, Office approval, or E6 completion. Main CI remains disabled and outside the gate. No unresolved product decision remains for this slice; implementation and verification are still pending.
