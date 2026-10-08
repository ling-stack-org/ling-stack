# Harness recovery discovery checkpoint — 2026-10-07

## Scope and confirmed failure

Implementation continues from merged checkpoint `main@097fecf4` in the dedicated
`codex/e6-safe-continuation` worktree. The root checkout and unrelated WIP remain
untouched. This slice is part of the active D0/E1–E6, U/T and Harness goal, not a
replacement for Office product completion or packaged macOS acceptance.

Recovery previously selected the same first 500 prepared scheduled continuations
and first 500 stale WorkUnits of each daemon-owned kind. Cancelled or otherwise
ineligible Runs remain in this discovery prefix; skipping them did not advance
the next scan. More than 500 such rows can indefinitely starve a valid Run.

Original semantic failures are retained in the local evidence directory:

- `recovery-discovery-sqlite-original-red-20261007.tap`: the second SQLite page
  returned the same 500 WorkUnits instead of the remaining row.
- `recovery-daemon-original-red-20261007.tap`: four actual coordinator failures,
  one for each owned stale kind and scheduled continuation discovery. Each has
  501 SQLite rows; the second scan fails to dispatch the valid Run behind the
  cancelled prefix. This is a dispatch test, not a real provider/GUI run.

## Read and coordinator contracts

Core adds optional, bounded keyset discovery to existing read contracts:

- WorkUnits: exclusive `(createdAt, id)` cursor, matching descending SQL order.
- Continuations: exclusive `(dueAt, createdAt, id)` cursor, matching ascending
  `COALESCE(next_attempt_at, created_at), created_at, id` order.
- `createdAtOrBefore` freezes each sweep's creation cutoff. Scheduled SQL also
  uses that sweep's fixed `now` for due-time and claim-expiry discovery.
- Parameters are bound, timestamps and cursor IDs are validated, and the
  existing 500-row bounds and no-cursor behavior remain. No OFFSET or new table.

Daemon keeps independent discovery state for each store and each of its four
lanes. Every fetched row advances discovery, including skipped rows. A short
or empty tail ends the sweep; the next scan starts a fresh sweep. Reads that
throw do not commit a cursor or new cutoff. Actual execution checks use the
current time, not the frozen discovery time.

Mutable due times or eligibility can move a row behind the cursor. A sweep is
not a durable eligibility snapshot: wrap rechecks such rows. After restart,
discovery may start from the head, while durable CAS, Attempt/lease fences and
in-flight deduplication remain responsible for preventing duplicate execution.
Discovery never grants execution authority.

All existing Run/WorkUnit/Attempt, thread/teammate, approval, ActiveRun, frozen
input and effective-policy admission checks must remain. Channel children still
belong to channel recovery. A same-store reentrant scan must remain bounded,
and shutdown must reject every subsequent dispatch, not only entry to a scan.

## Current verification boundary

Core build and typecheck pass. The focused real SQLite matrix passes **9/9**,
including the original RED, all three WorkUnit kinds, continuation row 501,
equal timestamps, reopen, creation cutoff/new insertion, due-time movement,
eligibility, bounded no-cursor calls and invalid/SQL-bound cursor inputs.
Adjacent Core continuation/migration/Harness regressions pass **36/36**;
the complete Core suite passes **2406/2406**, with no skips or cancellations.
The first Daemon implementation passes its **18/18** matrix, Root's independent
Core/Daemon focused run passes **27/27**, and Root's existing Daemon recovery,
approval, user-input and channel neighborhood passes **96/96**. These counts
overlap and are not added together. All 18 available workspace `typecheck:ci`
scripts pass. Raw receipts remain under `output/e6-20260928/recovery-*`.

Review then found an additional required admission boundary: the pre-existing
scheduled path lacks the stale path's daemon-owned kind/thread/teammate checks.
`rebuildExistingRunRequest` validates stored Run snapshot lineage, not ownership
of the current thread or kind. The previous stale channel-child negative test
therefore cannot certify scheduled recovery. A dedicated real SQLite RED and
shared daemon-owned admission predicate are being implemented. Do not use the
18/27/96 GREEN receipts to certify that later candidate.

That first ownership candidate passes **29/29** focused Daemon cases and Root's
new **38/38** focused Core/Daemon combination. The scheduled executor case now
does cover the complete 501-row chain and actual database close/reopen. These
are still not a final acceptance verdict: Root's fresh broader neighborhood is
**95/96**, with a real regression in the existing queueable-continuation case.
Both the new GREEN and this failure are retained, not overwritten.

The regression demonstrates why ownership and execution phase must remain
separate. Production prepares the child Run and created Attempt before
concurrency admission; a queueable conflict can defer them before Task claim.
A legitimate scheduled Task can therefore still be `todo`. Production manual
resume can also use a virtual Task snapshot with no Task row, inherit a task or
channel thread and map to `task_run`. Copying stale's required Task-row and
claimed/running gate into all scheduled recovery incorrectly rejects these.

Follow-up on 2026-10-08 separates shared kind/thread/teammate ownership from
stale's existing Task gate. New-Run scheduled origins admit unclaimed/virtual
Tasks only after matching their sealed parent/source replay provenance. A
same-Run retry may admit a retryable real Task with its same-Run provenance;
neither retry nor daemon recovery gains a blanket missing-Task exemption.
Inactive Task, channel-child and wrong-private-owner refusal remain covered.
The older integration test was not changed or skipped.

The additional todo-Task fixture initially failed for a different reason:
it passed the complete SQLite Task (nine fields) as frozen model input. The
public request parser, Task route and workflow builders all pass only
`id/title/prompt/channelId`. The diagnostic proves the nine-field frozen
payload is rejected by the existing strict reader, while the canonical
four-field virtual Task is readable. The fixture now matches production;
no frozen payload validator was relaxed. The misleadingly named original
`recovery-daemon-queued-admission-focused-green-20261008.tap` is retained as
**12/13, one failure**, not a GREEN receipt.

Fresh Root evidence for the corrected candidate:

- Core pagination plus all three new Daemon files: **52/52**, no fail, skip,
  cancel or todo (`recovery-core-daemon-combined-final-20261008.tap`).
- The original eight-file recovery/approval/input/channel neighborhood:
  **96/96**, no fail, skip, cancel or todo
  (`recovery-daemon-adjacent-final-20261008.tap`).
- All **18** workspace `typecheck:ci` scripts and fresh Daemon build pass.
- Production prepare/admission-conflict/defer is exercised for real `todo`
  and virtual Tasks, with the actual existing-run executor completing the
  original prepared Attempt. A newer active source Attempt does not invalidate
  the saved source fence. SQLite-persisted missing/foreign/same-root-sibling
  parents, altered context and read-valid-but-different frozen execution are
  rejected before dispatch. Discovery does not replace reconstruction's root,
  workspace, policy and full target-fence checks.

The full Daemon suite has now finished: **3600/3600**, no fail, skip, cancel or
todo (`recovery-daemon-full-final-20261008.tap`, Node 22.22.1, concurrency 1).
Documentation links, public repository safety and diff whitespace checks pass.
Counts above overlap and must not be summed. Core production source is
unchanged since its complete 2406/2406 receipt. This verdict is tied to the
checkpoint-base dependency graph; after integrating new main dependencies,
build/typecheck and affected regressions must be rerun with new receipts.

Neither component execution with a fixture runner nor database reopen is
packaged macOS/real-provider/GUI restart acceptance. The overall goal remains
active; discovery regression completion is separate from those product gates.

## External landing boundary

Live readback on 2026-10-08 supersedes the earlier open snapshot. #518 was
merged by `tianxiaochannel-oss88` at 05:42:51 UTC, merge commit
`6d8ae30c2d2b19d16abfc6e01d66d57f0d7fa8e6`. Remote main
`8335905aa90d86f613facbcd59adb262dbc726c6` contains that merge and the verified
shell-quote 1.12.0 / locked MCP SDK 1.32.0 / runner-pi Undici 7.29.1 upgrades.
Its aggregate still records the unstarted payment failure; do not claim that
CI was entirely GREEN or that this workflow performed the merge/bypass.

Dependabot itself closed #512–514 and #517 and deleted their head refs. This
workflow did not close them or delete branches. #516 was rewritten by the bot
to Undici **7.29.1 -> 7.30.0**, which main does not cover: the prior conditional
close authorization is not applied to that new content. Keep it open pending
evaluation. #520 is the new production-group migration PR; neither it nor all
security alerts are claimed handled. No release or production review approval
is implied by the merge.
