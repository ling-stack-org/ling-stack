# A25: Account for partial snapshot-restore effects

Date: 2026-10-15
Status: implementation candidate; Root owns fresh builds and execution evidence

## Evidence and scope

The original public HTTP regression uses the real confirmation, restore worker,
SQLite journal, blob store and filesystem in a temporary owned workspace. Root's
first actual execution produced 0/2 passes, exit 1. The frozen test is
`packages/daemon/test/workspace-snapshot-partial-effects.test.mjs`, SHA-256
`830510de8bd2bff708f4d50d17b79c4a938ccfe0aece6fb37072068f32882dfc`.

Both failures are partial effects, not failed setup:

1. Replacing a file with a symlink: native unlink succeeds; symlink creation
   throws. The victim is absent, but its journal entry remains pending.
2. Replacing a file: native rename succeeds; target chmod throws. Target bytes
   and temporary-file permissions are already installed; the entry is pending.

In both cases the worker returns `failed` and releases the fence even though the
victim is not restored. Close/reopen and reconciliation retain that unsafe result.
The original baseline added an entry to the in-memory applied list only
after the complete apply function returns. Its rollback verification also checks
digests without checking kind or recorded permissions.

This change stays in the existing restore coordinator. It adds no table, changes
no real history and does not reconstruct facts from model text. The original
299-line public regression and its before-state assertions remain unchanged.

## Outcome contract

`failed` means this attempt did not leave a workspace mutation behind: every
planned path has been read again and matches its complete recorded before state.
An original failure with no effect is allowed to reach `failed` after that proof.

`recovery_required` means rollback could not be proved, a path has an unrecognized
partial/external state, ownership was lost, or a journal/request CAS failed.
It is durable and visible. Keep journal rows, blob preimages, the original error
and the current-owned recovery fence. Do not claim `rolled_back` for an unresolved
entry. Reconciliation does not silently modify or reclassify a terminal result.
If ownership has already changed, the old worker cannot install even this
terminal report. It leaves the genuine in-flight request and newer fence intact
and propagates a typed ownership/CAS error, rather than bypassing epoch-CAS.

There is no force rollback. An ambiguous missing path after unlink cannot be
assumed to belong to this attempt, even when the attempt had started applying it.

## Entry accounting and verification

1. The full durable plan and all preimages precede the first workspace mutation.
2. Recheck current ownership and the complete before state before each entry.
3. Add the entry to the attempted set **before** calling its mutating apply code.
   Attempted does not mean applied or successful; the durable state stays pending
   until full target verification and journal CAS succeed.
4. Read kind, content/link/directory digest, and any recorded mode after apply.
   Digest-only equality is insufficient because `pathDigest` omits mode.
5. On error, visit attempted entries in reverse order. If an entry is already at
   its complete before state, do not rewrite it. Otherwise only rollback while
   its current state still matches this request's full target state, including
   the existing after-digest guard. Unknown partial states stop automatic writes.
6. After each rollback, re-read the complete before state before attempting the
   `pending|applied -> rolled_back` CAS. A failed CAS is not success.
7. Re-read **all** journal paths, including the current and not-yet-attempted
   entries. Ordinary failure is admissible only if this pass succeeds and no
   rollback, ownership or journal error remains.

Expected before kind is derived from durable metadata: no before digest means
absent; a rollback symlink target means symlink; a directory digest means
directory; otherwise it is a file. Generated plans record modes. An omitted
optional mode is not invented. No content digest or fingerprint format changes.

The full target check is intentionally conservative: rename followed by failed
chmod may leave known target bytes with non-target permissions. That state may
remain `recovery_required` rather than overwriting a possible external change.
The public regression accepts either a fully verified rollback or this explicit
recovery outcome, never a false `failed`.

## Lifecycle, ownership and reconciliation

Track only lifecycle states this worker successfully installed. Never read an
arbitrary latest state and use it as permission to terminalize another worker.
Before/after filesystem writes and before journal mutation, verify request ID,
request fencing epoch and current workspace fence ownership/epoch.

Only a known safe terminal state at the same current epoch releases the fence.
`recovery_required`, unresolved CAS and stale ownership do not release a newer
epoch. The queue's last-resort error handler must not turn an in-flight journal
into ordinary `failed`; it has no proof that no workspace effect occurred.

Reconciliation remains read-only with respect to workspace bytes. Its all-before
and all-after decisions must include kind and recorded mode, not only content
fingerprints. Existing terminal records remain unchanged. Mixed states retain
the journal and become visible recovery; normal successful and idempotent replay
continue to use the same request and plan.

When the workspace fence has a current owner, reconciliation uses the same
expected epoch and rejects a conflicting nonempty owner/epoch. When no owner
exists, preserve the existing observation-only state-CAS recovery behavior.
This is not an active-lease atomic guarantee and does not authorize a filesystem
write; a resumed restore still revalidates and acquires its own fresh fence.
Do not introduce an untested reacquire/publication transaction in this slice.

### Atomic epoch-CAS and release

Root ran the independent real CoreStore suite before the product change: 8 tests,
4 passes and 4 failures, actual exit 1. Two SQLite connections proved that a
same-state newer epoch and a transferred owner could still be overwritten by an
old request/journal callback. The independent release pair then produced 1 pass
and 1 failure, actual exit 1: an old callback could clear a newer same-owner fence.

The candidate implementation adds optional `expectedFencingEpoch` to the existing
request/journal update inputs. When supplied, the original SQL state predicate
also atomically requires both the parent request epoch and the current workspace
fence owner/epoch. The worker supplies it for state and journal updates after
successfully publishing `fenced`. The initial `validating -> fenced` claim still
uses the existing state-CAS while publishing the freshly acquired epoch; this
slice does not introduce a new cross-process atomic claim. A stale post-fence
callback never falls back to an update without this predicate. Calls that omit
the optional field retain their existing state-CAS contract, including the
observation-only no-owner reconciliation above.

Fence release accepts an optional fourth expected-epoch argument. The Core SQL
requires both owner and that epoch in the same statement. Capture and restore
cleanup pass the exact epoch they acquired; same owner ID does not authorize an
older epoch to release a newer one. No new table or product module is needed.
The complete contract/Core/Daemon source chain is now implemented as a candidate;
the RED evidence above predates that change. No fresh build or execution has been
run by the implementing Agent. Acceptance waits for Root's fresh combined run.

## Verification gates

Root runs the existing frozen public pair unchanged, then the original restore
and routes regressions, close/reopen/reconcile, success and idempotency cases.
Add narrow fault tests for no-effect failure, before/target mode mismatch,
rollback/post-verification failure, external edit, stale fence and failed journal
CAS. Core epoch-CAS tests must fail before their product change. Fresh builds and
actual process exits are required; source inspection is not a passing test.

The focused source suite contains six controls: no-effect unlink failure,
second-connection journal conflict, newer same-owner epoch, synthetic staged
wrong-mode reconciliation, external content after real apply, and failure after
a real rollback rename. It does not replace the original public HTTP regression.
Root's first fresh Contracts/Core/Daemon builds all exited 0. The unchanged public
pair, independent Core ten and focused six then passed together: 18/18, exit 0,
3573.687 ms, no skips or cancellations. This does not include the follow-up queue
ownership fix below and is not GUI or packaged acceptance.

### Queued preflight ownership

Root ran the independent 187-line same-request direct/queued-worker regression
against that fresh build. It produced one pass and one failure, exit 1,
1033.522292 ms (`output/e6-20260928/a25-20261015/queue-owner-first.log`). The direct
control committed. In the overlap case a real direct worker held the restore
lock while its first scan was deferred; the real request was `requested` with
zero journal entries. The second queued worker was rejected by the lock, but
its lock-external fallback changed that same request to `conflict`. The prior
state and journal checks proved no ownership of the direct worker's request.

The minimal fix uses one private worker wrapper, not a new global scheduler or
storage entity. It preserves the public API and the worker's existing root lookup.
Only a queued job that actually enters this invocation's `withRestoreLock`
operation can invoke its locked-failure closure. That closure executes before
the lock is released and handles its own preflight `requested|validating` failure
only when the accepted request epoch is unchanged, no current fence owner exists,
and no journal has been staged. It keeps the existing typed conflict/expiry/error
classification. Later, fenced or effectful failures remain the existing owned
restore worker's responsibility.

A failure before lock admission receives no such capability.
The outer catch only reads the durable request and settles the background
promise; it never terminalizes a row. Merely deleting all fallback updates would
be wrong because genuinely new preflight failures would remain `requested`.

The new `workspace-snapshot-queue-preflight.test.mjs` source adds three real queued
controls: fingerprint drift becomes durable `conflict`; scan I/O failure becomes
durable `failed` without file effects; normal queued restore commits one journal
and replays idempotently. All close/reopen SQLite and retain actual error/file
facts. The original public, Core, recovery and independent queue tests are not
weakened. Root rebuilt Daemon with actual exit 0 and ran the original queue pair
and new preflight three together: 5/5, exit 0, 1481.491833 ms, no skips or
cancellations. The subsequent reconciliation fix below still requires a fresh
build and final combined run.
The local restore lock is not a cross-process execution lease; this slice does
not claim new protection against arbitrary independent same-user processes.

### Accepted queued requests wait for the actual local owner

A further independent real direct/queued regression proved that lock-external
read-only settlement alone was insufficient. Root's first execution produced
0/1, exit 1, 5501.482792 ms, no skips or cancellations. A distinct key with its
own confirmed request B was accepted while real direct A held the lock. A later
committed with one real rename and one journal entry, but B stayed `requested`
with no error after its queued worker had received busy
(`output/e6-20260928/a25-20261015/queue-distinct-busy-first.log`, SHA-256
`2c65770194d9151af0b6a8607605cfd57a61fc3ad5d17f59be3a06d49ed5fa3b`).

The existing private lock helper now has an opt-in wait mode used only by the
queued worker wrapper. Its original second root lookup still happens before
lock admission. A queued worker awaits the actual current owner's lock promise,
then rechecks in a loop before synchronously installing its own lock. Multiple
waiters cannot assume that wake-up equals ownership; a different waiter may
already have reacquired. Cleanup deletes only this invocation's exact lock,
then resolves its promise. Direct restore calls retain their immediate typed
409 busy rejection. No scheduler, timer retry, new global map or table is added.

The queued failure closure remains lock-internal and cannot borrow authority
from a latest request row. A same-key waiter sees the committed original request
and returns it without effects. A genuinely different accepted request actually
enters the worker after its predecessor, revalidates its original expectations,
and records its own fingerprint conflict rather than being orphaned. This is
local serialization, not a new cross-process durable queue or a FIFO guarantee.

The new `workspace-snapshot-queue-serialization.test.mjs` adds two source controls:
a real direct contender still receives 409 without changing its held owner; three
same-key queued replays plus two independently confirmed different-key waiters
produce one real file rename/one journal, terminalize their own stale requests,
and preserve those records across SQLite close/reopen. All prior independent
tests remain unchanged. This follow-up waits for Root's fresh combined run;
earlier successful matrices do not certify this serialization change.

### Reconciliation releases only its successfully committed epoch

The independent 145-line reconciliation regression uses explicit synthetic
`staged`/`verifying` crash states over a real previously generated restore plan,
SQLite close/reopen and real filesystem facts; it is not evidence of killing a
real Daemon. Root's first execution produced one pass and one failure, exit 1,
940.248 ms. The all-before control released its fence and allowed a real next
capture. All-after reconciled to `committed` with `applied` journal entries but
left current epoch 3 owned; the next real capture failed with an already-owned
fence (`output/e6-20260928/a25-20261015/reconcile-fence-first.log`, SHA-256
`031d26abf6a76ab77f3dc28a82fe9502608169e4f5f39e83d7f4a732a05bc32c`).

Reconciliation now saves its actual successful all-after request CAS result and
only then calls the existing exact-owner/exact-epoch release. A failed CAS or a
latest-row fallback does not authorize release. Core's same-statement predicate
still preserves a newer epoch or different owner. No helper, table or test
assertion changes are needed. This source fix awaits Root's fresh execution.

Not covered by this slice: kernel-atomic transactions across SQLite and arbitrary
filesystem writers, ownership/ACL/xattrs, GUI or macOS packaged acceptance,
Office approval, or E6 completion. Controlled-writer fencing does not isolate
Full Access or unrelated same-user processes.

Unresolved product choices: none. Acceptance waits for fresh combined
verification; no additional permission choice is pending.
