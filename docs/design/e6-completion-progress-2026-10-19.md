# E6 completion execution — 2026-10-19

This is the active execution ledger after checkpoint `15d944ae8fe041bd27de2d2c9968249ffb93655c`.
It does not replace historical receipts or grant QA/package approval.

## Boundaries

- Sole implementation tree: `ling-e6-continuation/ling-stack`, branch `codex/e6-safe-continuation`.
- Preserve the remote checkpoint and both sides of main integration; no reset, clean or forced push.
- Root alone builds/tests shared Core/Daemon outputs. Agents own disjoint source/test files.
- Main CI, Windows and gstack upgrades remain out of scope.
- No daily databases or private conversations in QA/evaluation. Use temporary stores and redacted dedicated QA cases.
- No fresh Office package before independent delta review and the user's approval of the specific review record.

## Execution order and actual status

| Workstream | Current status | Completion evidence required |
| --- | --- | --- |
| Main integration | `origin/main@912e3e8e835f68a0d62161e3d5694ce9f9f7c6cb` merge in progress; 14 conflicting files resolved as candidates | fresh affected build/tests, independent seam review; preserve Pi and native execution contracts |
| Required-question recovery | fresh Q1/Q2/U03 and publication-lineage combination GREEN (26/26); packaged GUI pending | fresh package and corresponding real GUI cases; later execution changes require targeted regression |
| H10–H12 | durable budget/claim/start, interrupt/resume and atomic evidence candidates implemented; original Host composition and Run/TerminalReport barriers being connected; dynamic producer off | fresh validation of production admission/Provider ledger, real child execution/control/recovery and atomic fan-in |
| H09 evaluation | worker/composition foundations present | current combination regression/review, bounded real-model QA pilot, packaged local-user authentication |
| T13B | lifecycle combination GREEN 100/100 after stopAll repair; fixed-corpus performance exposed foreground contention, production scheduler repair awaiting fresh rerun | independent review and unchanged-threshold fixed-corpus performance receipts |
| Office/macOS acceptance | historical full read complete; current delta approval absent | current closure inventory, independent delta review, user approval, fresh package and 20 real GUI cases |

## Integration decisions

- Keep main's strict startup-loss Attempt/audit validation and local pre-ACK question receiver recovery.
- Keep local idempotent approval projection/post-commit recovery, route native decisions through the native atomic publisher.
- Reuse main's shared Pi/native execution supervision, retaining explicit lease/semaphore renewal and pre-start heartbeat exclusion.
- Preserve local retry-generation canonical system input and the original parent-source isolation.
- Keep local current-owner test isolation; retain main's added negative startup recovery cases.
- Main uses schema versions 169–175. H10 owns 176; T13B owns 177. Recheck before activation.

## Current evidence

- Remote checkpoint branch verified equal to `15d944ae8fe041bd27de2d2c9968249ffb93655c`.
- Main integration neighboring combinations: Core 183/183 and Daemon recovery 87/87. These bounded combinations do not certify the entire merged candidate.
- `question-recovery-red-20261019.tap`: stronger Q2/U03 probes first reproduced two real gaps (1/3 pass): orchestrated participant lacked request_user_input; restart publication lost the first linked-Run anchor and conflicted.
- Repairs: explicit workflow execution enables the existing user-input pause surface; TerminalReport republication reuses the first published immutable Run reference, without weakening Core publication comparison.
- `question-recovery-final-20261019.tap`: 26/26, actual exit 0. Covers Q1, real HTTP SSE loss + fresh Daemon/Runner/SQLite recovery Q2, independent parallel required participants U03, and stable report lineage through reopen/no-hint/retry replay. This is not packaged GUI evidence.
- `h10-h11-t13b-core-20261019.tap`: 80/80, actual exit 0 at that source revision. New lifecycle/read-scope fixes after this receipt are not covered by it.
- `h10-runner-budget-20261019.tap`: 89/89, actual exit 0. Runner hard budget gate and existing observer tests pass. Host durable ledger wiring is still outstanding.
- `t13b-daemon-combination-20261019.tap`: 83/89, actual exit 1. Six existing ExternalWork tests exposed stopAll becoming permanent. Source repair restores reusable stopAll and adds permanent stopAdmission for shutdown; fresh combination pending.
- Independent H10/H11 review identified real bridge nested-BEGIN, late acceptance cleanup and intermediate-ancestor budget enforcement gaps. Repairs and dedicated regressions are in progress, not waived.
- `t13b-daemon-combination-current-20261019.tap`: 100/100, actual exit 0. Includes shutdown, media recovery, evaluation scheduling, ExternalWork, approval post-commit, Provider publication and delegation coordinator. Two newer scheduler-yield regressions are not covered by this receipt.
- `h10-h12-core-combination-20261019.tap`: 312/313, actual exit 1. The only failing negative fixture illegally reactivates a historical Attempt while another is active; fix the fixture, retain the production unique active-Attempt constraint.
- `t13b-performance-initial-20261019.json`: actual exit 1, fixed 250 samples/50 warmup. Dispatch p95 0.576625 ms and claim p95 0.147292 ms pass; foreground queue increase 1.979997 exceeds the 0.05 limit. Keep this RED receipt and the original threshold. Production evaluation now yields to the foreground before SQLite claim; fresh measurement pending.
- Actual root admission and per-invocation Provider budget hooks now use original constructor Store/Provider custody. They are candidate source, not yet fresh combination acceptance. Unknown usage retains debt; a Provider exceeding its declared window can overrun a conservative reservation, which is recorded and blocks further calls.
- Latest independent read found resumed delegated Attempts still reached whole-Run question/compaction/Office readers. Repair derives exact scope from committed ownership and still verifies historical individual receipts; never accepts a caller's attempt filter.
- Run success now has a candidate SQLite savepoint barrier for required descendants, and normal TerminalReport CAS includes original dynamic evidence. Both require fresh tests; model text or UI batching cannot certify completion.
- Historical test totals do not certify the merged candidate or newly added implementation.

## Next action

Integrate the exact-attempt lifecycle and private Host writer seams; rerun fresh Core/Daemon combinations,
wire real Host root admission and Provider reserve/settle, then finish H12 atomic fan-in and fixed-corpus
performance checks. H09 real-model/credential authentication and Office delta approval/package GUI remain open.

## 2026-10-20 continuation — new evidence, not final acceptance

- `h11-h12-resumed-core-combination-20261020.tap`: actual exit 0, **251/251**.
  Includes exact-attempt question/compaction/Office readers, preparation custody,
  immutable completion receipts and Run success barriers.
- `h11-receiver-current-20261020.tap`: actual exit 0, **37/37** after a fresh
  Daemon build. Prepared Pi input now preserves its original JSON key order;
  budget/control/result JSON remains canonical. Receiver ACK, original Host
  composition, Provider scope, deadline and scheduler regressions are covered.
- `h12-root-closure-core-20261020.tap`: actual exit 0, **20/20**, including
  14 root-terminal spawn cases and eight competing writers. A completed root
  cannot acquire new required descendants through an existing optional child.
- Fixed-corpus performance is now GREEN with unchanged thresholds and samples:
  `t13b-performance-quiet-recheck-20261020.json`, actual exit 0,
  250 samples/50 warmup. Foreground p95 baseline 0.8555 ms versus evaluation
  0.8035 ms; dispatch p95 0.562583 ms, claim p95 0.132792 ms. This is synthetic
  on-disk SQLite/same-process scheduling, **not** packaged-client/Provider latency.
  Keep the original RED and the concurrent-load auxiliary receipt unchanged.
- New initial-child SDK chain is **not GREEN**:
  `h11-h12-initial-sdk-chain-20261020.tap`, actual exit 1, 4/14 pass.
  Seven orchestrator cases expose a pre-dispatch `source_attempt_stale` path;
  three completion-observer cases misread a boolean API and are being corrected.
  No network, production database, or packaged GUI is involved.
- Independent review found pending fan-in incorrectly falling into generic
  Runner failure, partial-success publication bypass, and a no-manifest workflow
  publication gap. Repairs and original-fact regressions are in progress.
  TerminalReport dynamic-child lineage must also be connected before activation.
- Dynamic producer remains **off**. H09 paid pilot, Office delta review/user
  approval, fresh package and the 20-case macOS GUI matrix remain unaccepted.
  Git remains in the preserved `--no-commit` main integration; no new commit,
  push, PR or main merge was performed for these receipts.

## 2026-10-20 checkpoint/resume and producer continuation

The previous initial-SDK RED receipt is retained, but is no longer the latest
result for that source chain. This section records newer bounded evidence, not
overall E6 completion or package approval.

- `h11-h12-sdk-publication-current-20261020.tap`: **103/103**, actual exit 0.
  Real Pi SDK + temporary SQLite + controlled SSE transport covers initial child
  preparation, read/checkpoint, interrupt/Host drain, same-Run successor Attempt,
  original model-view recovery without replaying the read, usage/result sealing,
  fan-in and normal/workflow report publication. It is not an external-model or
  packaged-GUI receipt.
- Initial child preparation now atomically saves the frozen execution and context
  identity. Delegated checkpoint handoff verifies the exact reservation, adjacent
  successor fence, stopped original Attempt, Host drain and released resources.
  Pre-receiver and first-Provider boundaries revalidate the original witness.
- `h11-core-checkpoint-fixture-current-20261020.tap` retains a **7/8 RED** receipt.
  The first fixture error was an undefined conversation-mode property disappearing
  on JSON persistence; the second was missing target Attempt identity on synthetic
  run/turn markers. Fixes only make the fixture match the real Host path; no policy,
  fencing or checkpoint guard was weakened. The owning agent subsequently ran
  the same eight tests with **8/8, exit 0**; Root combination receipt is pending.
- The new five-case real-SDK delegated compaction test has passed **5/5, exit 0**
  in the owning agent's targeted run. It covers automatic compaction, 14 actual
  read/write operations, interrupt/drain/resume, permission revocation and late
  source events at pre-ACK/first-Provider admission. Original failed logs remain.
  Root combination and packaged acceptance are still pending.
- H09 current combinations: Core **51/51**, Daemon **107/107**, Desktop **134/134**,
  all actual exit 0. Receipts: `h09-*-current-combination-20261020.tap`.
  The fixed QA Store has only its historical synthetic source and no Provider
  preset. A genuine current source, exact sanitized pins/reviewRef and reviewed
  remote output-cap semantics remain prerequisites for the bounded real pilot.
- Independent H11 review: `h11-recovery-independent-review-20261020.md`, 14 source
  hashes, no confirmed findings, static-only. It predates the producer extension
  and does not approve the later source or Office/package closure.
- New implementation in progress: original Host runtime registry, exact-Store
  dispatch, bounded recovery discovery, real shutdown ownership, five frozen
  Runner tools and explicit Host-selected workflows. Default ordinary exposure
  remains closed until the approved gates pass; selection is not model metadata.
- Instruction delivery is **not implemented yet**: writing a queued message does
  not prove it entered a child's recoverable model view. The next slice atomically
  binds the instruction receipt to the actual checkpoint and safe SDK boundary.
- H12 real-child collector tests exposed internal `sqlite:delegation-*` artifacts
  being classified as public deliverables. Candidate privacy repair keeps them
  developer-only; fresh validation is pending. A second real bug in denied command
  result handling is being repaired without turning denials into success.
- Native command completion currently proves leader/stdio close, not that detached
  descendants stopped. Existing strict dynamic-child sealing correctly refuses
  that evidence. No new safe-containment receipt is claimed; this capability gap
  must be resolved or explicitly decided before command-child success acceptance.

Next execution order: finish and verify production producer/instruction wiring;
rerun the affected recovery/publication combinations; resolve command containment;
then H09 real source/pilot, current independent closure review and the specific
user-approved Office review record, fresh package and the 20 real GUI cases.
The preserved main merge is still uncommitted; no new push or main merge here.
