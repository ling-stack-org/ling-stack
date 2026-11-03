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

## Latest verification delta — 2026-10-23

### Current P1 resource rebuild overlay

Execution now follows `e6-remaining-work-plan-2026-10-23.md` P1→P2→P3/P4→P5.
The former external-volume/selection-only block below is historical, not a request
to supply a resource disk or reduce QA scope. The user selected explicit
`local-bounded` storage; fixed source/model/native resources are built. Restoring
the exact reviewed Bun1.4.2 resolved the compiler-only mismatch without changing
any reviewed source/import pins. Resource stage actually exited0, SHA256
`58dff1d02f2839af8acdb180cdd75ff0bed4576e0ae1a997351aeed76c8bde93`.
Browser retry session79852 actually exited0 (192819ms): all three official
archives and the fixed DMG were verified; version/transport/inventory match the
existing pins and the read-only mount was detached. Executable session76789
actually exited0 (65488ms),29635 files,1296949186 bytes. First selection
session37198 actually exited0 (9612ms),reused=false,manifest SHA256
`42e8edca5d7f7ba275d462756fc8ab85e1c9638b69f9811994bafb895b034d00`.
P1 is complete. The original macOS QA package command session55530 exited1 at
afterPack: Builder's directory walker dropped the single authenticated
`runtime/node_modules/tr46/lib/.gitkeep` file. No extra file was present.
Manifest-derived exact file mappings fix the copy, retaining full verification.
The real Builder copy regression went RED→GREEN; the three-file adjacency
passed72/72,zero skips. Review then exposed Builder macro expansion in exact
literal paths. All generated from/to fields now reject macro syntax before
copying; five regression scenarios failed before this guard and the repaired
three-file adjacency passed78/78,zero skips,using the real expandMacro. Only one approved packaging input changed, with all15
native and other1590 packaging inputs unchanged. Independent delta review and a
new concrete user approval are required before packaging again; approved data
has not been updated and the failed App was not launched.

Independent build-helper review exposed parser copy-snapshot ABA and an existing
assembly empty-reservation cleanup bug. Both forced probes now reject/clean
correctly and targeted regressions pass. Browser's first live acquisition
exited1 because isolated HOME hides gh login configuration; public fixed-upstream
metadata now has a bounded credential-free reader. Incremental independent
review is complete with zero unresolved findings; the final related9-file
regression passed34/34 with no skips. Before the P2 copy repair, the formal Office
source reader exited0 with all15/1591 approved inputs unchanged. The P2 one-file
delta now needs its own concrete approval; that earlier reader result does not
certify the new bytes. These helper changes do not silently grant new approval.

Local checkpoint69a7a32a preserves the resource rebuild and first copy repair.
No successful new package, GUI acceptance, model evaluation, push or merge has
occurred. The accepted Core/Daemon/Runner baselines below are not being rerun.

### Current authoritative overlay: validation passed; package input missing

This section supersedes the running-suite and pending-approval statements retained
below. The full D0–E6 objective is unchanged. This is not final E6 acceptance.

- The durable complete Daemon run has actually exited0:7419 tests,7407 passed,
  zero failed/cancelled,12 existing platform/launcher skips. Its508 files match
  the original complete glob; no split, exclusion, retry or timeout relaxation
  was used. The final log and child-close receipt are retained as
  `daemon-complete-durable-final-20261023.tap` and `.receipt.json` under the
  ignored output directory. `sourceUnchanged=true`; original failed and
  interrupted runs remain historical evidence, not passing runs.
- The current-input synthetic SQLite/scheduler benchmark ran once after the
  full suite, actually exited0, and passed all five original gates with250
  measured samples/50 warmups. It made no external Provider calls and does not
  prove GUI or real-model performance.
- The user approved the exact frozen packet with SHA256
  `bd2f18a45a38bc5d65d70caca4d2a380503f81ec4ed7e34247a856e5568c1ce9`,
  for isolated macOS QA only. All15 native/1591 packaging inputs and actual
  compiler/SDK/headers/runtime/signing were rechecked against it. The old
  manifest was preserved; the new manifest SHA256 is
  `fcdad830ab3fea9b34264704c545babab1fd7e10d12e9775e4c24ea1e65ee941`.
  The formal source reader passed before and after the attempted build. The
  original pending packet is unchanged; no release approval is inferred.
- The actual original QA package command exited1 because
  `.ling-stack/build/gstack-desktop-selection.json` is absent. The Office
  source-build lane requires an authenticated immutable external GStack bundle;
  a global installation or fixture identity cannot substitute. Searches of
  local worktrees/common resource locations found no selection, and current
  disk/volume inventory contains no recoverable GStack resource volume. No
  GStack upgrade or bypass was performed. The failed build log is retained as
  `human-qa-package-missing-gstack-selection-20261023.log` under output.
- No new QA App was generated or launched. All20 current-package cases and
  their required K/U/S increments remain unverified; historical R03 acceptance
  is retained without pretending it was rerun on a nonexistent new package.
  Dynamic-child, fan-in, question recovery, Office native behavior and UI
  assertions still require their actual packaged evidence.
- H09 separately still requires an authorized Provider/model with proved hard
  output-cap support, current genuine Host source and user-performed human
  authentication. The existing local CPA management URL does not resolve that
  capability gap. No new generation was sent.

Next: restore and verify an existing external bundle's exact root/identity, then
resume the unchanged QA package command. An alternative QA-only non-GStack lane
would change approved source inputs and therefore needs an explicit scope
decision, new delta review and specific packet approval; it must not silently
inherit this approval. Prefer Codex built-in Computer Use for actual GUI work;
`cua-driver` is fallback only. Windows, global GStack upgrade and main CI remain
deferred. Do not rerun accepted suites or reconstruct completed implementations
merely because historical paragraphs below describe their earlier gaps.

### Retained preceding verification history

The following statements retain their original evidence and limitations; use
the current overlay above for completion and blocking status.

### Later suspension delta — 2026-10-23

The latest S9/S10 delta supersedes the historical implementation gaps below.
Original and restored final-assistant settlement authority is implemented via
the independent187 ledger. Optional terminal/shutdown handoff is implemented
without treating an aborted source as resumable: exact intents precede abort,
and original terminal evidence is verified after physical/durable finalization.
S10 final groups passed163/163 and58/58; the original-observer fault scenario
passed1/1. All exited0 with zero skips. Scoped static review found no confirmed
actionable issue; it is not an independent execution or Office approval.

Runner full passed567/567. Office source-closure full passed1343/1343 after
correctly classifying the39 new inputs as38 runtime and1 type-only; five
`*types.ts` files export runtime Error classes. Hash/mutation/missing-source,
real esbuild metafile and no-dist-consumption gates remain intact.

The first Core full run ended4395/4401, exit1. Its six legacy migration/optional
lifecycle fixtures were corrected without changing production Core guards;
focused groups passed85/85 and5/5, exit0. The final Core full run then passed
4401/4401, actual exit0, zero failed/cancelled/skipped.

An actual approval-cancel/shutdown defect was fixed in ActiveRuns: an explicitly
non-resumable executor can finish its original cancelled lifetime, while supplied
terminal handoffs still require exact verification. Missing checkpoint/handoff
authority remains blocked. Fresh Daemon emission exited0. Scoped static review
reported no confirmed actionable finding; it is not Office approval.

The following six-file Daemon group ended213 tests,205 passed,8 cancelled by
their unchanged15-second timeout, actual exit1. The complete approval-policy
file and the real tree/shutdown neighbors passed. The eight production optional
tests used an obsolete post-adapter-return hold/failure hook, after the new Host
settlement callback had already observed an unstarted child and safely blocked.
Moving that test-only control into the actual SDK final window preserved all
drain/usage/result/late-spawn assertions. The complete production-tool-surface
file then passed13/13, exit0, zero skips. No production guard or timeout changed.

The first Daemon full run was stopped after the known cancellation defect and did
not finish. The later diagnostic full run has now exited1:7401 tests,7319 passed,
70 failed,zero cancelled,12 skipped. It consumed the prior production dist and
does not verify the subsequent repairs. The original media fetch
failure has passed in isolated and complete-file runs, but its root cause is
not yet confirmed; those passes do not erase the failed full-run record.
The Daemon full suite must finish and its new failures must be resolved before
a new frozen Office review packet. Its two ACP/Kimi failures occurred waiting
for sandbox write replies, not reads. A forced live-worker pause proved that the
old fixture polling could expire before the unchanged worker deadline. Host
reply-commit observation, with cancellation and missing-reply rejection, passed
the complete68-test file, exit0. This does not identify the exact historical OS
scheduling of the original failures or turn that full run green. A01 launchers
now validate their actual isolated child environment and passed11/11, exit0.
The two A11 API/deadline files passed20/20 after the same isolation correction;
the IPv6 launcher file separately passed4/4,exit0 after its matching isolation
repair, with real HTTP/TLS launch/completion and private-address refusal. No assertion or deadline was
relaxed, and product guards still run before the child imports production code.

Channel file-create failures were traced to required-input tracking enabled
under a frozen off Broker. Initial/reprepared/runtime selection now share one
Host opt-in, canonical source, nondelegated, frozen-enforce gate. Off/shadow are
not promoted, receipt validation remains intact, and frozen capability removal
still rejects recovery. Fresh execution passed all four original channel write
cases and the original1800/4096-token budget pair:6/6,exit0,zero skips,without
raising budgets. The complete U/prepared/native group passed112/112,exit0 after
two legitimate-pause fixtures explicitly enabled their required enforce Broker.
The new native fixture's incomplete owner lookup was then found to give a false
negative. Its final complete63-test file now passed, actual exit0, zero skips,
using the actual failed preparation Thread and zero Turn/WorkUnit/Run assertions,
not accepted from that112-test result alone.

Media shutdown tests incorrectly expected abort in the stop call's own stack,
despite all-domain admission closure preceding the real abort phase. Observing
the actual event exposed a production liveness failure: waiting for physical
drain during abort hid the later finite media observer. Public stop now observes
that five-second deadline alongside the original lifecycle, whose internal
barrier still holds Stores/leases until physical drain. Retry joins original
work; observer timeout does not poison its eventual completion. ActiveRuns also
has a pure synchronous admission latch, without early callbacks or abort, to
reject queued ordinary/native execution. Tests freeze both admissions at the
actual abort event. Fresh emission exited0; the original four media cases passed
within a115/116 group whose sole failure was the corrected native fixture above.
That group is not reported as a complete passing suite.

Missing native workflow authority now rejects before target availability and
canonical Thread creation; the captured owner is then revalidated after awaited
preflight, before Turn/WorkUnit/Attempt/Run creation. The preflight's existing
preparation Thread may remain failed, without deleting its history.
The existing commit admission remains in place. Evaluation admission now turns
only typed permanent retained-body failures into a transactionally failed job,
so a corrupt queue head cannot starve later valid jobs. Storage/COMMIT/lease/pin
conflicts remain errors. Independent review exposed a combined corrupt-body and
same-owner audit-pin conflict. After its12 forced RED subcases, the repair now
validates every canonical owner recovery-pin reason before releasing any pin.
Final focused Core passed55/55; the latest full Core passed4431/4431, actual
exit0, zero failed/cancelled/skipped. Final source hashes match the independent
review. The older4401 result is retained only as historical evidence.

Six private approval-recovery cases exposed a separate shutdown deadlock:
ordinary SDK suspension admits running sources, but durable approval waits are
waiting_for_approval. The source request fails while its approval polling remains
live. The scoped repair preserves the exact approval checkpoint, drain/owner
checks and rejection of dynamic descendant shortcuts, including shutdown requested
immediately before approval commit. Its first11-case run ended6 passed/5 failed;
the original six passed, while a bare-Store fixture bypassed default custody and
duplicate server-close cleanup obscured other cases. A128-case adjacent run also
exposed two real late-reviewer drains: after a finite local observation timed out,
the original writer's eventual drain did not retry the captured approval CAS.
The repair now revalidates that same source/checkpoint/revision after real drain;
it does not loosen the Core resource veto or any original resource assertion.

The intermediate13-case and224-case runs passed. A further real Hub active-listener
fault then proved that post-CAS notification failure could incorrectly block Host
shutdown. Final source isolates only each notification after a successful Core CAS;
it does not swallow SQLite failures or claim live notification delivery. The final
orchestrator SHA is `cf8e7fbe180ed15d1308bb42a8b487ce865726cb8d049947e3a8630cf970be5f`.
After fresh emission exited0, the final14-case A28 run and93-case shutdown/U/tree
adjacency both passed, actual exit0, zero failed/cancelled/skipped. R1/R2/R3 are
closed by scoped independent review, not a full SDK/remote-effect attestation.
The final complete Daemon suite is now running against this frozen dist, in a
new temporary home/workspace with test:ci's concurrency1; its actual exit is pending.

The current165-item WIP packaging delta has completed independent review with
inherited coverage limits:90 newly read full files,20 exact prior full-file
reuses,55 generated catalogs with exact baseline reuse and all current changed
content reviewed. The1591 packaging/15 native hashes match, with no new confirmed
finding. The later production source changes above are not covered by
that old frozen delta. Their final six-input supplement and166-item hash inventory
have now been independently checked, including a complete intermediate orchestrator
read and the exact final two-block R3 delta. No new confirmed source finding remains
in that scope; inherited generated-catalog coverage limits still apply. The final
WIP inventory SHA is `a637c116afa70a07dbcd82b0ea95ede4eb5fe644f244d819d4fccc72a7926de6`.
This is not a clean frozen packet or approval. Budgeted H09 real-model,
explicit packet approval and20 packaged macOS cases remain open.

The following paragraphs are retained historical checkpoints, not current gaps.

This supersedes the older statement that graceful suspension is unimplemented.
Ordinary root/child/queued suspension, actual SDK acknowledgement, cross-PID
recovery after the original Host exits, and default Daemon startup discovery
are implemented and have isolated SQLite/SDK evidence. Compacted suspension now
also has independent witness authority through seal/stop/activation/ACK, complete
predecessor custody, and repeated suspension with or without new tools.

Final fresh groups exited 0: Core 334/334, Daemon suspension 125/125, Daemon
compaction neighbors 63/63, Runner full 558/558; all had zero skipped tests.
Independent read-only review reported no remaining confirmed finding in the
frozen S8 delta and checked the 16-file source manifest. This is not an
independent test rerun, Office approval, full Daemon run or packaged acceptance.
Logs and hashes are indexed in the ignored S8 evidence/continuation records.

At that historical S8 checkpoint, final-assistant settlement was still pending. Office's
current incremental review and explicit packet approval, budgeted H09 live
evaluation, and the macOS packaged acceptance matrix remain open.

- Fresh contracts/Core/Daemon/Desktop TypeScript builds exited 0; Web noEmit
  exited 0. Current fresh Core neighbors passed 158/158; Desktop entry/profile
  plus Daemon bootstrap passed 94/94. These separate sets are not one full suite.
- The fresh Daemon 14-file group finished 161/162 (exit 1). The only failure was
  the process-restart fixture creating a new Run without frozen workflow
  selection. Supplying the exact real fixture workflow at initial Host admission
  fixed the fixture without weakening the production guard. Its complete file
  plus snapshot/config neighbors passed 12/12 (exit 0); retain the original red.
- The historical runtime self-heal fixture now distinguishes pre180 migration
  from a damaged schema with a committed180 marker. Legacy repair succeeds;
  committed corruption is still rejected and preserves the marker/legacy Run.
  The complete channel-runtime-store file passed 52/52 (exit 0).
- After fresh bootstrap emission, the fixed Office daemon-source input matrix
  passed 1171/1171 (exit 0). This is source-closure testing, not content-review
  approval, package execution or GUI acceptance.
- The unchanged local synthetic benchmark ran once with 250 measured samples
  and 50 warmups; all five gates passed (exit 0). Dispatch/claim p95 were
  0.540417/0.191916 ms, baseline/enabled queue p95 13.222708/12.485834 ms,
  and maximum event payload 56 bytes. Raw samples and source hashes are retained
  in `harness-reliability-benchmark-fresh-20261023.json`; no latency threshold
  was relaxed, and this does not measure dynamic execution or packaged GUI.
- Optional stop-with-parent and frozen selection are implemented. Startup
  preservation is implemented but is not running-child recovery. Graceful
  suspend/resume and durable parent settlement after bounded stop timeout still
  require implementation; missing original stop/drain proof remains blocked.

Logs are under `output/e6-20260928/`: `delegation-selection-process-fixture-green-20261023.tap`,
`recovery180-runtime-fixture-final-20261023.tap`,
`office-pins180-qa-source-closure-fresh-20261023.tap` and the benchmark JSON above.

## Current implementation delta: recovery ownership and explicit selection

This section supersedes the historical list of missing foundations below. It is
not a final acceptance verdict or package approval.

- Recovery/audit artifact pins now participate in the original continuation,
  tool, rule evaluation, model-task, QA and delegation writer transactions.
  Unknown effects, undrained QA, independent audit holds and unconsumed required
  child results remain pinned. Default GC enrollment is off; only explicit Host
  deadlines permit cleanup. No ordinary history is automatically deleted.
- The user selected `stop_with_parent` for optional children, including parent
  success, failure and cancellation. Runtime integration and deep-child stop
  timing verification are still in progress; an abort request is not proof.
- Four-domain, metadata-only diagnostics are connected through Core/API/shared
  Web rendering. The current Web validator/renderer group passed 29/29; this is
  component evidence, not packaged GUI acceptance.
- Additive migration180 installs five recovery/discovery indexes. Fresh Core
  production SQL/bindings/EXPLAIN evidence passed all six structural gates at
  scales 16/128/1024. Completion predicate work is 50/386/3074 invocations for
  those populations, not a wall-clock performance claim. The unchanged five
  latency/sample gates still require a separate run after fresh Daemon build.
- Fresh Core nearby tests ran 211 cases: 210 passed, one strict historical
  schema153 fixture comparison failed because three additive migration180
  indexes were missing from its exact overlay exclusion. The corrected fixture
  plus complete migration/boundary group passed 49/49. Preserve both outputs;
  neither this nor the prior full failure is a passing fresh full-suite result.
- A private, exact-workflow, token/wall-budgeted packaged QA startup selection
  now explicitly declares `modelExecution: host-authorized-budgeted`. Its source
  composition tests passed 93/93. No real model call or package was started.
- Independent review found a real restart authorization-drift gap. Run feature
  snapshots now freeze an independent `delegationSelectedWorkflowIds` list;
  current selection must not retroactively enroll an old Run. Factory/config
  source tests passed 11/11; the runtime consumption seam is being verified.
- Running-child recovery is still implementation work. General startup stale
  recovery must not mutate private `delegation_step` authority. Preservation
  alone does not implement graceful suspend, resume, or crash containment.

The newer pending-packet preparer describes the combined dedicated-QA plus
Host-selected budgeted-model scope, not the older synthetic-only scope. It has
not run against a new clean/frozen revision and has no user approval. Do not
reuse an old packet to authorize these bytes or create a fresh package.

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

### Later same-day delta: original packet is stale

Do not execute the historical freeze/approval step below unchanged. Pending
`core-repair` captured 58 changed packaging inputs versus `post578-final`: three
Core sources plus 55 generated locale catalogs. The catalogs match current
authored JSON; subsequent projection/retention WIP invalidated that packet.
No current packet has user approval.

The local pending-packet preparer now checks authored JSON against all 57
generated localization files, verifies the fixed inventory, rejects symlinks and
read-time mutations, and rechecks the snapshot before writing. Its isolated
compiler-parity/tamper suite passed 15/15. It never regenerates the shared tree.
This ignored output helper is not a production release approval mechanism.

A separately reproduced recovery admission defect is repaired in source:
general stale/scheduled discovery and direct ordinary continuations now refuse
`delegation_step` ownership. Before the repair, discovery dispatched both
fixtures (0/2), and the direct-entry fixture entered its offline Runner (0/1).
The coordinator-only neighbors passed 45/45; the final two-source-leaf group
passed 50/50; these groups overlap and must not be summed. Daemon noEmit passed.
Verification used an in-memory source loader with unchanged compiled dependencies,
not a fresh Daemon/package. Private delegated execution is unchanged. This does
not prove running-child crash recovery, real model usage, or packaged GUI.

Independent review identified an additional pre-dispatch write in general
approval recovery. Its approved/resume-pending/denied admission fixtures failed
0/3 before the repair. Both resume and denial now check the actual Run's owning
WorkUnit before decision/claim/finalization writes. The full approval-recovery
file plus ownership file passed 48/48, including unchanged snapshots of 12
relevant tables after refusal and repeated startup scans. This group loaded
three current source leaves in memory, not shared rebuilt dist. Final noEmit
passed; all nine frozen repair/verification inputs matched after testing.

The user confirmed that all other writers have stopped. Root now owns the six
preserved retention/projection WIP inputs; their original bytes are backed up.
The migration fixture's `177 || 179` short circuit and missing Office fixed
inventory entry are repaired. Retention tokens now support the full valid
artifact-ID bound without relaxing decoded identity validation. Later pages use
the actual composite `(retain_until, artifact_id)` lower bound, not an OR filter
that rescans pinned prefixes. Projection domains preserve failure isolation.

Fresh Core/Daemon builds exited 0. Complete nearby groups passed 29/29 Core,
63/63 Daemon, 1159/1159 Office source inputs, and 41/41 question/private delegation
recovery. The newer Core full exited 1: 4001 passed of 4002, with one schema153
fixture leaving the new 179 marker installed. All 1777 frozen inputs matched
after exit. The fixture alone was corrected after full ended, keeping strict
historical SQL/row/marker assertions; its complete migration/legacy/retention
group then passed 50/50. Preserve and report the failed full; do not call these
results a fresh passing full. Logs are named `retention179-*`,
`office-retention179-source-matrix-fresh-20261022.tap`, and
`recovery179-question-private-delegation-20261022.tap` under the output directory.

The independent retention/index/projection scoped review found no confirmed
remaining defect. It is not package approval or real-model/GUI evidence.
Current exact continuation and local evidence paths are in the ignored
`output/e6-20260928/CONTINUE-HERE.md`.

### Historical order, subject to the delta above

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

H10–H12 and T13B foundations already exist in this branch; do not restart those
implementations from the historical backup note. Production diagnostics still
need evaluation/delegation and reconciliation metadata. Retention needs real
producer pin/policy wiring, not just conservative foreign-key protection. The
performance matrix still needs active-subtree and indexed paged-startup evidence.
Running-child recovery, optional-child quiescence policy, and bounded QA workflow
selection remain implementation work. H09 still needs genuine current source and
capability evidence. Their combined real packaged acceptance remains open.
No model narration, child exit code, UI batch
count, static review or local test may substitute for Host terminal evidence.
