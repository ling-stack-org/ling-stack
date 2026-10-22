# T13B reliability implementation checkpoint — 2026-10-19

## Scope and verdict

Implementation order is C1 → C2 → C4 → C3, on `codex/e6-safe-continuation` only.
This checkpoint records authored code and its limits, not final E6, packaged GUI,
Office approval, dynamic-delegation activation, or release approval.

Root owns serial Core/Daemon builds and tests. Do not concurrently rebuild shared
`dist` from another Agent. Migration 176 belongs to dynamic-delegation budgets;
T13B uses 177. Changes here do not authorize edits to real user databases.

## C1 — durable and reconstructable projections

Migration 177 adds checkpoints and metadata-only rows for continuation,
tool-execution, evaluation, and delegation. Source-table triggers increment an
epoch and mark previously ready projections stale. Rebuild pages run under
`BEGIN IMMEDIATE`, persist a generation/cursor, and restart from a fresh generation
if their source epoch changes. Only complete, count-checked generations become
readable. Row hashes and identities are validated when read. Partial, stale,
missing, or tampered projections never authorize execution.

The Daemon owns a bounded, single-flight `HarnessProjectionReconciler` per Store,
runs it during Store initialization and each 10-second wake, and yields between
pages. Each domain is limited to 16 pages per wake. A missing source trigger is
repaired with invalidation; a same-name trigger with different SQL is rejected.
No private request or tool-result body is copied into these projections.

## C2 — explicit retention, pins, and body-only GC

Only Host-enrolled artifacts are eligible. There is no default enrollment of
ordinary history and no automatic age-based deletion of all artifacts. A body is
eligible only after its explicit retention deadline, without a durable recovery
or audit pin, and without any external SQLite foreign-key reference to its
artifact row. Foreign-key discovery includes future authority tables, rather
than maintaining an incomplete active-state allowlist.

GC retains the artifact row, original SHA, retention record, append-only pin
events, and immutable GC receipt. It only clears `sealed_payload_json`, checks the
body SHA in the same write transaction, and returns `sealedPayloadState: "pruned"`
through artifact readers. A pruned body cannot be silently rewritten. Deadlines
can only be extended. Body reads have a 16 MiB pre-read budget.

The real Daemon consumes enrolled candidates through
`HarnessArtifactRetentionService` during startup and periodic wakes. Sweeps are
bounded to 16 pages of 100 candidates and resume their cursor next wake; a page
budget is not a whole-population success receipt. Store shutdown closes
admission, aborts owned loops, and awaits actual settlement.

## C4 — production lifecycle barrier

The lifecycle coordinator requires all four named domains, including an explicit
disabled port when a producer is not yet implemented. It performs:

1. External and all domain admission closure.
2. Abort of already owned operations.
3. Actual drain of every domain, even when another domain has failed.
4. Native-engine disposal, then runtime lease release and Store closure.

A timeout reports `draining_timeout` but does not cancel the real drain or permit
early Store closure. A failed phase preserves original Host error causes and
keeps Stores/leases open. Disabled dynamic delegation is not reported as a
verified implementation; existing static-channel Runs remain owned by ActiveRuns.

Actual Daemon consumers include continuation discovery/dispatch, user-input and
approval recovery, channel dispatch, automation and external-work schedulers,
Provider startup refresh/import, narration and TerminalReport publication tails,
projection/retention workers, rule/task evaluation workers, media executions,
ActiveRuns/direct replies, native browser shutdown, CUA, network, and remote
access lifetimes. A grader or Provider probe that ignores abort must finish before
its Store is closed; the code does not pretend that an abort signal is completion.

`ExternalWorkBackgroundSchedulerRegistry.stopAll()` remains a reusable stop,
because its existing caller contract allows a same-key successor. Permanent
Daemon shutdown instead uses the new `stopAdmission()` and then actual
`waitForIdle()`. Its original late-poll/startup successor isolation assertions are
preserved. The new regression also drives a real timer poll through an await gate
and proves admission closure does not count as an idle receipt.

## C3 — reproducible performance tool and hard gates

`scripts/harness-reliability-corpus.mjs` creates a temporary on-disk SQLite corpus
with seed `ling-harness-t13b-20261019-v1` and fixed semantic time
`2026-10-19T00:00:00.000Z`. Generated Channel/Task identity is explicitly excluded
from the canonical corpus identity; the seed, source content, deterministic
Run/Evaluation identity, and population are recorded. No external Provider calls,
real user database, or credentials are used.

`scripts/harness-reliability-benchmark.mjs` measures real continuation/Attempt
preparation, evaluation claims, and normal-task queue latency with and without
real rule-evaluation scheduler contention. A fixed-seed, exactly balanced shuffle
independently assigns arm order and adjacent input blocks inside the warmup and
measured populations. This avoids aliasing either arm to periodic SQLite
checkpoint/cache work while keeping every run reproducible. Defaults are 50
warmups and 250 samples per arm. Hard gates remain:

- Continuation/dispatch bookkeeping p95 ≤ 25 ms.
- Evaluation claim transaction p95 ≤ 20 ms.
- Maximum recorded event JSON < 16 KiB and nonzero.
- Evaluation-enabled queue p95 increase ≤ 5%.
- No passing verdict below the minimum warmup/sample population.

Receipts preserve all raw samples, environment, Node/SQLite/CPU/OS, corpus hash,
git revision/dirty state, and consumed compiled-source digests. Actual evaluation
contention is not subtracted and thresholds must not be loosened to obtain GREEN.
The tool is local synthetic evidence, not packaged GUI or dynamic-delegation
execution evidence. Fresh Core and Daemon builds are required before running it.

## Validation ledger

Known evidence at this checkpoint:

- Root previously ran the Core primitive suite: 8/8 passed, with a successful
  fresh Core TypeScript build. This predates the final Daemon consumer changes.
- Root's first fresh Daemon combination ran 89 cases: 83 passed and 6 failed.
  All six failures were the `stopAll()` compatibility regression described above,
  recorded in `output/e6-20260928/t13b-daemon-combination-20261019.tap`.
- The product fix and one additional regression are authored; their fresh rerun
  is still pending at this checkpoint. Original failing assertions were not
  weakened or removed.
- The C3 benchmark has not yet produced an accepted performance receipt. Do not
  infer that its 5% queue gate passes merely because the script exists.
- Whitespace validation of the final external-work fix passed (`git diff --check`).

Required follow-through: fresh builds and all affected lifecycle/recovery/media/
evaluation/provider/background regressions; Core public-port integration and
benchmark hard-gate tests; an actual benchmark receipt; independent review of
projection/GC/lifecycle boundaries; update the Office frozen-input inventory and
obtain the user's approval of the concrete review record; fresh packaged macOS
scenarios under the overall E6 plan. This file grants none of those approvals.
