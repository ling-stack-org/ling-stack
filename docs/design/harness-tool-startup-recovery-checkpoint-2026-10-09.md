# ToolExecution startup tail recovery checkpoint — 2026-10-09

## Scope and real failures

Continue the existing D0/E1–E6 and Harness goal in the sole E6 worktree,
`codex/e6-safe-continuation`, from `d095da29`. Pi 1.1 and the stable Expo 57
pairing are already implemented and locally verified; do not redo their
migrations. Their native/device and fresh packaged GUI gates remain open.
The independent H10 writer budget review remains unanswered and is not
implicitly approved by progressing this recovery slice.

The production Store initialization callback called one reconciliation query
with limit 500. A real disposable SQLite database with 501 expired executing
or committing-evidence rows and one future claim was closed, then reopened
through `createDaemonServer`. The original implementation settled only 500:
`t13b-tool-startup-red-20261009.tap`, **0/1**, `500 !== 501`. This is an actual
production initialization reproduction, not a source-only inference or GUI test.

Independent real SQLite Registry tests also failed **0/2**: synchronous callback
failure neither closed its Store nor evicted the cached instance. A retry reused
the partially initialized Store. A further integrated page-two-failure test was
**0/1**: the first two effects had been settled, but the failed Store remained
open. Raw RED logs are preserved separately, not renamed as passing receipts.

Final independent review found another registration-order leak: the production
callback added the Store to `approvalRecoveryStores` **before** tool recovery.
Registry eviction closed the instance, but that Set retained it for the actual
10-second approval recovery timer. A production HTTP workspace-open failure and
real timer observation reproduced the closed-Store query, **0/1**, `1 !== 0`
in `t13b-approval-set-production-red-20261009.tap`. Move this registration after
successful synchronous tool reconciliation. The corrected test also opens a fresh
Store on HTTP retry and verifies its remaining SQLite effects have been settled.
An initial test request incorrectly used `/api/runs`, received 404, and was
corrected to the real `/runs` router before this semantic RED; its separate log
is retained and is not evidence of the product defect.

## Module and recovery contracts

- Core owns a bounded reconciliation page and its discovery cursor. The
  existing single-page mutation remains a useful bounded operation; it delegates
  to the same implementation, not an old-version execution compatibility layer.
- Each page reads at most `limit + 1` identities, processes at most `limit`
  rows, and returns `scanned`, bounded `updated`, and optional `nextCursor`.
  The existing 1–500 limit and default 100 remain unchanged.
- The exclusive keyset is SQL's ascending `(claim_expires_at, id COLLATE BINARY)`.
  Cursor values come from the original SELECT, including deleted rows and
  losing CAS rows. Successful update count is never a tail-discovery condition.
  No OFFSET, new table, altered lease duration or new execution policy is added.
- Every sweep uses a single frozen `now`; selection still includes only expired
  `executing`/`committing_evidence` claims. Claimed pre-effect records, future
  claims and terminal rows are not reconciled. An old Attempt is not excluded
  after it may have crossed the side-effect boundary.
- Re-read eligibility and the existing per-row transaction, revision CAS,
  state/expiry guard and atomic evidence association remain intact. Classifier
  throw falls back to the existing unknown-outcome classification; invalid
  evidence or database failures remain visible errors with rollback.
- Daemon synchronously consumes all discovered pages before the existing
  initialization callback can register recovery coordinators or dispatch work.
  It retains counts only across pages, not an unbounded array of recovered rows.
  Existing file mutation pre/post-hash classification is reused; startup never
  invokes an executor or blindly retries a possible prior side effect.
- A synchronous initialization failure removes that Store's workspace cache
  entry and remembered Run aliases, closes the instance, then rethrows the
  original error. A close error cannot replace that error. Other Stores and
  successful caching are unchanged. This does not change the separate existing
  asynchronous callback contract.
- The production approval-recovery Set is populated only after successful tool
  startup recovery. A failed Store cannot leak into that periodic consumer.

The optional AbortSignal is checked between synchronous pages. The regression
injects an abort synchronously from a completed page and proves the remainder
can be handled by a fresh sweep. There is **no event-loop yield** here: this is
not evidence that ordinary asynchronous daemon stop can interrupt a currently
running synchronous sweep. Errors/abort do not return a partial success report.

This is a live keyset scan, not a transactional eligibility snapshot. A concurrent
writer can move an ordering key behind the cursor or insert an expired record
behind it. A subsequent Store startup scans from the head; no new scheduler is
claimed in this slice. Bounded pages bound temporary row memory, not total startup
time. Broader recovery performance and operator diagnostics remain separate T13B
work, not certified by this correctness regression.

## Verification and source identity

Frozen final 12-path source/test manifest:
`output/e6-20260928/t13b-tool-recovery-final-v2-20261009.sha256`.
All tests use owned disposable databases, never the actual user database.

| Gate | Actual result | Raw receipt under output/e6-20260928 |
| --- | --- | --- |
| Original production 501-row startup | RED 0/1 | t13b-tool-startup-red-20261009.tap |
| Original Registry initialization | RED 0/2 | t13b-store-init-red-20261009.tap |
| Original integrated page-two failure | RED 0/1 | t13b-store-page-two-red-20261009.tap |
| Original production approval Set/timer | RED 0/1 | t13b-approval-set-production-red-20261009.tap |
| Final focused Core + Daemon, Node 22 | 72/72, zero fail/cancel/skip/todo; exit 0 | t13b-tool-recovery-focused-final-v2-20261009.tap |
| Final focused Core + Daemon, Node 24 | 72/72, zero fail/cancel/skip/todo; exit 0 | t13b-tool-recovery-node24-final-v2-20261009.tap |
| Final workspace typecheck | exit 0 | t13b-tool-recovery-workspace-typecheck-final-v2-20261009.log |
| Core full, Node 22 | 2,503/2,503, zero fail/cancel/skip/todo; exit 0 | t13b-tool-recovery-core-full-final-20261009.tap |
| Daemon full, Node 22 | 3,682/3,682, zero fail/cancel/skip/todo; exit 0 | t13b-tool-recovery-daemon-full-final-v2-20261009.tap |
| Desktop source-input/projection | 145/145, zero fail/cancel/skip/todo; exit 0 | t13b-tool-recovery-desktop-source-final-v2-20261009.tap |

Focused coverage includes real 1001-row close/reopen and 500/500/1 discovery,
equal-expiry ordering, future/pre-effect exclusion, two public Store connections
competing on CAS, classifier renewal of the page tail, classifier throw, deletion
after SELECT, SQL-bound quote cursor and typed invalid-input refusal without
mutation. Existing evidence rollback tests are preserved. Daemon covers actual
501-row initialization, a second actual startup with unchanged revisions, a
completely lost first CAS page, synchronous between-page abort, page error,
and real page-two failure → eviction → fresh SQLite reopen → remaining-tail
reconciliation before the test dispatch observer is called. It also checks
real Run aliases and close-error preservation.

The earlier 71/71 focused receipts predate the approval-Set repair. The earlier
145/145 Desktop source receipt is also kept separately. The initial Daemon full
process, handle 48385, was deliberately stopped (exit 1) after the independent
review found that missing production registration boundary, before source edits.
Its partial log is retained; it is neither a full pass nor a new test failure.
The final v2 full process is a distinct run after fresh Daemon compilation, with
per-worker isolated workspace/home roots and unchanged production locks. Core
bytes did not change after its 2503/2503 full run; do not rerun it to certify a
Daemon-only registration-order change.

Counts overlap and must not be summed with prior migration or full receipts.
Both full suites have finished, and all 12 source/test hashes were checked
again after the final Daemon termination. Core full duration was 204,048.823875
ms and Daemon full duration was 640,174.348542 ms. Documentation links (305
Markdown files), public safety (4,377 repository files), and diff whitespace
checks pass. Final readonly review found no remaining blocker for this bounded
tool-startup failure boundary. The local slice verdict is **DONE**; that is not
the whole T13B, Harness, E6 or native acceptance verdict. No native/package/GUI or actual
device acceptance, remote push, PR, main merge, cloud CI enablement, security
alert dismissal, real Keychain operation or new delegation writer is claimed.

## Remaining decisions and goal boundary

There is no unresolved product decision for this bounded tail-recovery fix.
H10 budget source/time/pricing/child caps are still independent pending decisions.
T13A same-config request ordering and external credential-version authority
remain unselected. MCP/Provider stale publication, broader T13B diagnostics,
H09/H10 runtime authority, native Office and fresh macOS/Mobile acceptance are
not closed by this slice. The total goal remains active.
