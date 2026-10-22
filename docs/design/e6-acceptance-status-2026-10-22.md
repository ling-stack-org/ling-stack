# E6 acceptance checkpoint — 2026-10-22

This is an implementation/verification checkpoint, not a release, package
approval, successful real-model evaluation, or final E6 verdict. It supersedes
the continuation order in the historical 2026-10-19 backup note.

## Identity and scope

- Sole implementation worktree: `ling-e6-continuation/ling-stack` (the local
  absolute path remains in the ignored continuation record).
- Branch: `codex/e6-safe-continuation`.
- Core repair commit: `5ccb95a4fbf2bad84f9a5425197e30004ed4a1b1`.
- Integrated main: `9014741d69ab0e86bedc6377afb7032aadebde50` (#578).
- No root-checkout edits, history rewrite, real-data cleanup, Windows work,
  gstack upgrade, CI activation or release is included.
- The existing untracked Daemon crash report is retained and excluded from Git.

## Current repair

The historical 20 Core failures comprised four legacy migration-fixture
failures, fifteen Office read-fixture dependency failures and one missing
completion-evidence port. The repair also deliberately changes production
completion transaction ownership; it is not only a test adjustment.

1. Legacy Continuity test construction defers the artifact-retention migration
   until sealed artifact columns exist. Normal startup still installs the
   production migration and retention trigger.
2. The isolated Office history fixture supplies empty query dependencies while
   remaining whole-run; it does not manufacture delegated authority or relax
   rejection assertions.
3. Standalone Run/Workflow completion obtains `BEGIN IMMEDIATE` before its
   completion reads and writes. Nested approval/lifecycle calls own only their
   savepoint, never the caller's COMMIT or ROLLBACK.
4. Regression coverage verifies a competing writer is blocked, a same-connection
   replacement still fails the final owner predicate, and caller rollback undoes
   successful completion and its transition receipt. Separate Workflow tests
   verify caller rollback and preservation of unrelated caller writes on error.

## Actual verification

| Check | Result | Durable output under `output/e6-20260928/` |
| --- | --- | --- |
| Fresh Core build | exit 0 | `core-fixture-build-20261022.log` |
| Earlier failing-file group | 112/112, exit 0; predates final admission additions | `core-former-failures-20261022.log` |
| Final completion neighbors | 73/73, exit 0 | `core-completion-neighbors-20261022.log` |
| Core full, isolated home, concurrency 2 | 3987/3987, exit 0; zero fail/cancel/skip/todo | `core-full-current-20261022.log` |
| Workflow new file, separate execution | 2/2, exit 0 | `workflow-completion-transaction-20261022.log` |

The full command's glob expanded before the Workflow file was added. Report
**3987 full plus 2 separate**, not a fabricated 3989-test full run. The six
pre-existing frozen source/test inputs matched their manifest after full exit;
the Workflow file separately matches the independent seven-input review. No
shared rebuild or edits to full-consumed sources/tests were made during full.

Full log SHA-256: `53cd35f80cc3ee653dafb657f062d21def1066e90ae40be1750033eb5750509e`.

Independent scoped reviews found no confirmed unresolved defect:

- `core-completion-delta-independent-review-20261022.md`, seven source/test
  inputs; SHA-256 `8759e4357220b6c4801b33f2d3516984cf484cfe78f984b12f99549e61b0726b`.
- `office-three-input-delta-independent-review-20261022.md`, three changed
  packaging inputs; SHA-256 `8873ed316ddb7ce09ea4128f76a125d5eb6aa72d5686d6f3890839f1dbdeac0e`.

Both remain `PASS_SCOPED_WITH_LIMITS / approved=false`. Static review and local
tests are not native Office execution, packaged GUI, or user approval.

## Connection and real-acceptance boundary

The user switched back to local CPA. Authenticated `GET /models` at
`http://127.0.0.1:8317/v1` returned HTTP 200 using `OPENAI_API_KEY`; no secret was
printed or persisted. This check sent no generation request and changed no QA
database. Do not keep probing the retired remote endpoint or substitute `_2`.

H09's current-combination independent review is scoped-pass, not real acceptance.
It records independent Core 174/174, Daemon 182/182 and Desktop 71/71 terminal
results without persistent TAP files. Its report is retained under output as
`h09-current-combination-independent-review-20261022.md`, SHA-256
`0a4de871133c98dcded78032e7e688a0c99af20f9080b60541f877cf84d815fa`.

Real pilot still needs genuine current Host source/pins, reviewed sanitized
inputs and exact output-cap capability evidence. Keep its existing canonical QA
database, at most 3 calls/batch and 12/24h, concurrency 1, no retry, and stop on
unknown usage/outcome. Unknown price is not zero cost. Existing synthetic history
cannot become real-source evidence. Trusted human reports are not yet a
calibrated promotion corpus; enforcement remains off.

## Next gate and execution order

1. The seven reviewed code/test inputs are committed at `5ccb95a4`; commit this
   status note, then freeze a new Office packet against that clean tracked HEAD.
   Preserve the earlier packet.
   Its 1541 unchanged packaging inputs can reuse the prior review; the three
   changed inputs have the independent delta review above.
2. Obtain the user's approval of the **new concrete packet and its hashes**.
   General permission to operate the QA App is not approval of these source
   bytes. Do not generate an approved record or fresh package before this gate.
3. Build and identify the fresh isolated macOS arm64, unsigned/ad-hoc QA App.
   Keep port 17928 and the existing QA profile/workspace; read back PID/argv and
   resources before operating it. Prefer Computer Use for real GUI evidence.
4. Complete the bounded H09 model pilot, user-performed system authentication
   (adjudicate/correct/revoke/inspect/readback), and the existing 20-case packaged
   matrix, including question recovery, real SSE/restart, independent required
   participants, dynamic-child lifecycle/fan-in and Office native behavior.
5. Preserve screenshots, semantic state, lineage, sanitized logs, package hash
   and truthful `simulation=false` receipts. Repair observed failures, review
   only new affected bytes, then update the PR and final acceptance verdict.

H10–H12 and T13B implementation already exists in this branch; do not restart
those implementations from the historical backup note. Their combined real
packaged acceptance remains open. No model narration, child exit code, UI batch
count, static review or local test may substitute for Host terminal evidence.
