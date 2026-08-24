# Channel Execution Completion Implementation Plan

Status: the existing semantic source implementation and deterministic verification are
green. The supplemental Runtime fence, typed delegated-outcome, required-coverage, and
single-terminal-projection hardening is present, and the corrected full source matrix
passes. A fresh macOS arm64 artifact also passes configured Engineer + QA fan-in, real
Host evidence, naked-`ready` and missing-provider blockers, restart/reconnect, replay,
and canonical SQLite-lineage smoke. The no-checkpoint/effect-unknown restart windows
and old-schema upgrade/rollback fixture remain open, so delivery is not yet cleared.
The existing delegated-outcome, required-participant fan-in, Run/Attempt recovery, and
reconnect paths are implemented; the new contract amendments make their missing fencing,
negative coverage, and terminal-projection assertions explicit. Earlier focused/package
evidence remains useful reproduction evidence. It is not release evidence for the current
source: Node 22 Daemon aggregation exposed nested transactions and incomplete rollback in
the publication/workflow
composition path. The explicit-ownership fault matrix, full official Node 22 Core and
Daemon suites, repository gates, and Channel E2E were green before S3.5. The old artifacts
remain stale; current post-hardening source and packaged evidence is recorded below. The
no-checkpoint/effect-unknown restart windows and old-schema upgrade/rollback fixture are
the remaining acceptance gates.
Owner: channel intent, workflow orchestration, terminal report, and continuity maintainers
Last verified: 2026-08-25
Canonical contract: [Channel Conversation Continuity v2](channel-conversation-continuity-v2.md)
Code anchors: `packages/contracts/src/conversation-continuity.ts`,
`packages/core/src/storage/sqlite/ling-turn-store.ts`,
`packages/daemon/src/features/channels/channel-intent-selector.ts`,
`packages/daemon/src/features/channels/orchestrator.ts`,
`packages/daemon/src/features/channels/terminal-report-coordinator.ts`, and
`packages/daemon/src/features/control-plane/events.ts`

## Goal

Close the gap between “a runner returned success” and “the user's whole channel task is
durably complete.” The delivered behavior must preserve every requested operation,
require action evidence for every required operation, publish one final result, and close
the original user `LingTurn` exactly once. It must also close the earlier acceptance gap:
once an Item and Turn are committed, durable dispatch rather than the HTTP/SSE request
owns progress through context preparation, intent routing, and reply/workflow handoff.

The 2026-08-13 amendment also closes the delegated-execution gap: canonical mentions must
reach intent selection, every required participant must survive proposal/workflow
compilation, and an Agent's ordinary `ready` text must never masquerade as completed
work. Multi-Agent success is derived by one evidence-backed completion gate, not by the
set of steps that happens to exist.

The 2026-08-15 packaged amendment closes a narrower false-negative: an accepted request
that names an executable but leaves argument construction to the Agent must not be stored
as an exact command equal to the natural-language token. `Node 调用 ...` therefore
materializes executable identity `node`, while an explicit `node app.js` remains an exact
command. The Completion Gate remains strict; only the planned match policy changes.

The second 2026-08-15 packaged amendment closes the remaining restart failure. A real
Engineer + QA workflow preserved Engineer evidence and correctly refused fan-in success,
but restarting the Desktop-owned daemon while QA waited for approval aborted the active
runner through `activeRuns.cancelAll()`. The generic AbortError path then called
`ensureRunCancelled()`, attributed the transition to `local-user`, cancelled the durable
approval, and converted the QA step to a cancellation blocker. The correct long-term
model is a recoverable attempt suspension: keep the logical Run, approval checkpoint,
step, participant manifest, and evidence; replace only the process-owned attempt.

The post-implementation review found one narrower crash-consistency gap inside that
replacement path. The first resume can now create a same-Run attempt and produce valid
evidence, but startup scans only `pending` and `approved` checkpoints. A process that dies
after the checkpoint CAS reaches `resume_pending` can therefore be stranded. Worse, a
blind retry after a durable `tool_start` could repeat a side effect whose result was lost.
The long-term contract below treats `resume_pending` as a recoverable protocol state,
classifies the exact crash window from canonical attempt/tool evidence, and fails closed
when the side-effect outcome is unknowable.

The fresh T8d single-participant run also clarified one apparent completion symptom. A
sample taken near Run termination showed the ready acknowledgement while the source Turn
was still running, but canonical SQLite then converged the linked workflow step, workflow,
TerminalReport, final Item, and source Turn to `succeeded` in the same terminal timestamp.
The request already used a one-node manifest-backed workflow; there is no missing direct
delegated path to add. The remaining requirement is a liveness regression: terminal
callback and startup reconciliation must close that short observation window without a
refresh, reconnect, or new user message, and the UI must not present the acknowledgement
as the final result while convergence is pending.

The next T8d.2 setup exposed a participant-preservation defect before the naked-ready
finalizer assertion. The accepted source Item contained the custom Engineer's canonical
structured mention, but single-step selection chose the first role/tool-compatible
built-in Engineer before `createParticipantManifest()` ran. T8d.2a corrected that
boundary: explicit participant ids now win before role/capability fallback, multiple
explicit ids remain distinct even when roles match, named capability failures block
without substitution, and selection plus workflow compilation share one operation-owner
algorithm. Accepted proposal retries reuse their persisted decision and manifest instead
of reselecting from the roster.

Reviewing that idempotent path exposed one remaining partial-lineage case. If a proposal
exists but its compatible decision/manifest is missing, the selector currently throws
`existing_proposal_participant_lineage_invalid`. The long-term contract requires a
durable visible blocker and normal source-Turn settlement instead. This is T8d.2b and must
land before packaged restart/reconnect acceptance, because a crash between proposal and
decision persistence must not become an unstructured 500 or a permanently running Turn.

The subsequent packaged T8d.2 run reached the correct PromiseBot participant all the way
through the manifest, graph step, and Run, but exposed a distinct adapter defect. Proposal
validation included the teammate's tools and approval profile, while
`prepareWorkflowStepStart()` copied only identity, provider/runner, and workflow-required
tools into the actual Run request. The teammate's `systemPrompt`, `appendSystemPrompt`,
and `approvalProfile` were absent from the persisted Run snapshot. The generic workflow
prompt therefore called bash instead of exercising PromiseBot's intended no-tool
acknowledgement. T8d.2c binds the execution profile at first Run creation without moving
persona resolution into the generic Run orchestrator or weakening evidence completion.

The first T8d.2c source pass bound those fields and passed the focused profile cases 3/3,
atomic pre-Run blocker 1/1, and workflow operation/evidence suite 51/51. Its initial
205/213 Channel result exposed a separate provenance rule: proposal-backed participants
are selected through the effective Channel and must revalidate membership, while template,
handoff, custom graph, compaction, scheduling, and fan-in participants are authorized by
the durable workflow definition. That typed participant-authority correction is now
implemented and broad-green. Both authority classes still require active, visible,
exact-participant, required-tool, approval, and sandbox checks.

The next isolated packaged Engineer + QA attempt reached the correct accepted Item,
decision, participant manifest, operation ownership, and two-participant proposal, then
stopped during proposal confirmation with the low-level validation text
`Either providerPresetId or provider is required`. The QA harness had created a runnable
provider and selected it as the Channel's Ling Agent model, but had not configured the
workspace default. Under the active model-binding contract this correctly leaves built-in
Engineer and QA unresolved: the Channel model belongs to Ling Agent and is not a
specialist fallback. The defect is that proposal validation leaks an untyped constructor
error and hides the binding owner/repair action. T8d.2d now centralizes typed model
resolution and preflight, preserves fail-closed ownership, and adds both missing-config
and configured cases. The daemon fixture, late-race/restart regressions, broad source
matrix, and final packaged acceptance for that pre-transaction checkpoint completed.
Those package results became historical evidence when the transaction-composition source
changed.

This plan does not redesign Continuity v2, add a second action-result store, or create a
new multi-Agent protocol. It extends the existing intent, workflow, `ExecutionAction`,
TerminalReport, and turn state authorities.

## Execution Plan From The Current Checkpoint

The semantic completion design is implemented, but source closeout is reopened at its
SQLite composition boundary. Contracts, persistence, finalization, fan-in, approval
resume, replay, Web projection, participant authority/profile, and typed provider
preflight already exist in the active WIP. The current correction must preserve those
authorities and replace ambient transaction detection with explicit ownership. It must
not add a second completion/recovery path.

| Phase | Scope | Entry gate | Exit evidence | Code-change rule |
| --- | --- | --- | --- | --- |
| S0: contract freeze [complete] | Lock completion authorities plus explicit SQLite transaction ownership and record the current Node 22 checkpoint | current WIP and failing Daemon aggregate | this document, TerminalReport protocol, and control-plane design agree on one owner per transaction | design only; no status may claim packaged completion |
| S1: transaction composition [complete] | Keep the explicit standalone/within-transaction control-plane API, TerminalReport/approval/workflow joined wiring, removal of runtime `isTransaction` ownership decisions, and owner rollback helper; prove aggregate rollback plus same-connection reuse | S0 | focused transaction matrix passes 150/150 under official Node 22; a later transaction starts successfully after every injected fault | no savepoint workaround, ambient transaction probing, or compatibility alias |
| S2: deterministic matrix [complete] | Run focused Daemon publication/workflow cases, Node 22 full Core and Daemon suites, then API/Web/contracts and repository static gates | S1 | Core 429/429, Daemon 1052/1052 twice, Contracts 41/41, API 49/49, Web 47/47, Channel E2E 116/116, typecheck/build/static/CI package matrix green | no packaged QA on a red source matrix |
| S3: fresh package [complete] | Build, sign, hash, and preflight one new macOS artifact in isolated home/workspace/ports; retain old artifacts only as reproduction evidence | S2 | ZIP/DMG identity, bundle signature, resource root, isolated daemon health, workspace default provider, and provider readiness are frozen and green | no production daemon/app termination; no reuse of pre-fix hashes |
| S3.5: contract hardening [complete] | Close the implemented Attempt fencing, typed outcome binding/codes, required-participant coverage, and single terminal projection through the full source matrix and diff review | S3 | old callbacks cannot mutate current Attempt; empty/unknown outcomes fail closed; missing required coverage persists; no second terminal publication; full Daemon aggregate and repository gates are green | fix only failures owned by these contracts; no new authority or second recovery path |
| S4: packaged behavior [partial] | Run missing-default blocker, configured Engineer + QA, naked-ready, restart/approval resume, and SSE reconnect | S3.5 | typed blockers; same Run/new Attempt recovery; all required participants verified before fan-in; one final report/Turn settlement | never parse ready prose or resubmit Turns |
| S5: SQLite lineage [partial] | Audit Thread/Turn/Item, decision, manifest, authority, graph, Run/Attempt, approval, actions, outcomes, Completion Gate, TerminalReport, event, and transition rows | S4 | one source lineage; no half-publication, leaked transaction, duplicate event, or cancellation impersonation; integrity green | data mismatch reopens the earliest truth-layer owner |
| S6: delivery [pending] | Run final diff review, PR/CI, merge, verify actual remote `main` merge commit, then clean only exact QA resources | S5 | merged reviewed change and remote-main parity | no merge while packaged or lineage evidence is incomplete |

Current S3.5 checkpoint: Contracts `46/46`, Core `444/444`, and the official full Daemon
aggregate `1090/1090` are green on Node 22. The clean worktree also builds a fresh arm64
artifact and the packaged continuity smoke passes configured multi-agent fan-in, naked-
`ready` blocking, missing-provider blocking, SSE, restart/replay, Host evidence,
TerminalReport, and SQLite integrity checks. The remaining packaged gap is the
no-checkpoint/effect-unknown restart matrix; S5.1 still needs the old-schema
upgrade/rollback fixture.

### Active release checkpoint and phase authority

The table above is the only active release phase namespace. The current checkpoint is
`S3.5` complete, `S4` partially complete on the fresh artifact, `S5` partially complete
for the canonical happy-path lineage, and `S6` pending. The older `A*`, `R*`, `T8*`,
`T9*`, `H*`, and Delivery S0-S5 labels below are historical implementation/audit
references. They explain why the source reached this checkpoint, but they cannot close a
current release gate and their historical `complete/green/verified` wording must not be
read as current packaged evidence. Only one post-S3.5 artifact identity may close S4/S5.

The active release DAG is intentionally explicit:

```text
S3 pre-hardening artifact
  -> S3.5 implemented contract hardening + full source closeout [green]
  -> rebuild post-hardening artifact [green]
  -> S4.1 naked-ready + missing-provider packaged blockers [green on current artifact]
  -> S4.2 Engineer + QA required fan-in [green on current artifact]
  -> S4.3 daemon restart matrix (checkpoint and no-checkpoint boundaries) [partial: current artifact replay/restart green]
  -> S4.4 SSE/RPC reconnect recovery and single publication [green on current artifact]
  -> S5.1 packaged SQLite upgrade/reopen fixture [open]
  -> S5.2 canonical Thread/Turn/Item/Run/Attempt/evidence lineage audit [green for current happy-path artifact]
  -> S6 review -> PR/CI -> merge -> actual remote-main commit verification -> exact cleanup
```

S4.1-S4.4 may reuse the same isolated packaged root and artifact hashes, but each case
must record its own durable ids and pass/fail evidence. A reconnect or GUI refresh is an
observer action only and cannot be used to advance the DAG. A red S4 case reopens the
earliest owning runtime/completion slice; it does not weaken S5 or convert historical
evidence into a pass.

### Authority hardening implementation sequence

This is the implementation order for the newly locked participant-authority design. It
is deliberately separate from the packaged acceptance phases so a source-level failure
cannot be hidden by a later GUI test.

| Step | Change | Primary modules | Exit gate |
| --- | --- | --- | --- |
| A0 | Freeze the current WIP and capture the source/test/package checkpoint, migration versions, and process exclusions | `git`, design docs, package scripts | reproducible checkpoint; no production/old-QA process touched |
| A1-A4 | Typed authority, atomic compiler origins, immutable participant binding, shared run policy, and typed provider preflight | Contracts/Core/Daemon workflow and model-binding modules | implemented in source; focused contract/core/provider cases green; remaining fixture and regression gaps explicit |
| A5 | Run focused storage, authority, profile, provider, tool, approval, and fan-in regressions, then restore broad source gates | Core/Daemon/Contracts tests and Channel E2E | complete Channel/Daemon/Core/typecheck/build/diff check green |
| A6 | Build one fresh signed macOS artifact and run packaged naked-ready, Engineer+QA fan-in, restart/approval resume, SSE reconnect, and SQLite lineage | macOS packaging scripts, isolated runtime root, packaged GUI | one artifact identity across all cases; no duplicate work/report/Turn settlement; unresolved effects remain typed blockers |

The authority migration is not a compatibility layer. This repository is still in
development, so the v2 contracts and storage shape change directly; no v1 aliases,
dual-read path, or silent default may hide an authority-less row. The only migration
default is an explicit `legacy_migration` authority with a fingerprint and a visible
fail-closed eligibility check.

The dependency graph is:

```text
A1-A4 historical source contracts/authorities/preflight
  -> S0 contract freeze
      -> S1 explicit transaction composition
          -> S2 broad deterministic green
              -> S3 fresh packaged macOS artifact
                  -> S3.5 implemented hardening + aggregate source verification
                      -> S4 GUI recovery/continuity acceptance
                          -> S5 SQLite lineage audit
                              -> S6 review/PR/merge/cleanup
```

The phases are deliberately sequential. S1 proves the corrected transaction composition
before any broad or packaged claim. S2 proves the deterministic matrix is green. S3
freezes one artifact identity. S4 proves that ordinary `ready` text cannot impersonate
work, process loss cannot shrink the participant set or cancel logical work, and observer
loss cannot restart or complete work. S3.5 first promotes the fencing, typed outcome,
coverage, and single-publication amendments into source, so S4 is run only against the
post-hardening artifact. S5 validates that the visible behavior and SQLite authority tell
the same story. Test commands may run in parallel, but edits to the
completion/recovery spine remain coordinated in this one isolated worktree.

### Active implementation tasks

These are the only tasks that should be scheduled next. They are deliberately smaller
than the historical T8/T9 slices so every task has one observable exit condition.

| Task | Scope and required behavior | Primary modules | Exit evidence |
| --- | --- | --- | --- |
| S3.5 | Close the implemented `activeAttemptId + runtimeInstanceId + fencingToken` CAS fence, closed `DelegatedBlockCodeV1`/workflow-step binding, required-participant coverage projection, and single-terminal-publication rule. Re-run the full Daemon aggregate after the corrected event-type assertions, then typecheck/build/static gates and review the complete diff. | Contracts, Core Runtime/SQLite, daemon finalizer/gate, TerminalReport/Web | focused source suites remain green; full Daemon and repository gates pass with no stale-write, invalid-outcome, missing-coverage, or duplicate-publication regression |
| S4.1 | Rebuild the post-S3.5 packaged app and run naked `ready` plus missing-provider cases. A delegated Run with only assistant text remains non-terminal, then becomes one typed blocker; missing provider creates no workflow, Run, approval, or side effect. | packaging harness, daemon delegated finalizer, Web report projection | post-hardening artifact hash, SQLite blocker lineage, zero side-effect/workflow counts, one source-Turn settlement |
| S4.2 | Execute Engineer + QA with both required manifest members. Fan-in waits for every required outcome/operation/dependency; a missing/blocked/failed participant cannot pass by callback count. TerminalReport includes required coverage and actual contributions separately. | workflow Completion Gate, TerminalReport evidence/renderer, daemon integration | one verified gate only after both outcomes, report has two coverage rows, no second terminal summary |
| S4.3 | Exercise restart at no checkpoint, approval checkpoint, before `tool_start`, between `tool_start`/`tool_end`, and after `tool_end`. Preserve same Run/manifest/evidence where safe, fence a new Attempt, reject old callbacks, and fail closed for unknown effects or no-checkpoint work. | Runtime Control Plane, approval-resume coordinator, Core Attempt store | old Attempt `lost`, new `activeAttemptId`/fence tuple, no duplicate side effect, typed blocker for unsafe windows |
| S4.4 | Drop/reconnect SSE and local RPC across terminalization. Resume from `lastAppliedSeq`, refresh canonical state before cursor advance, and prove reconnect never reposts a Turn, starts a Run, or publishes another report. | control-plane replay/SSE/RPC, Web projection | one final Item/report/Turn settlement and unchanged Run/step counts after reconnect |
| S5.1 | Open a packaged upgrade fixture from the prior schema, apply migrations 119-121, reopen the same SQLite connection after injected faults, and run `foreign_key_check` plus `integrity_check`. | Core migrations, SQLite stores, packaged data root | migration/reopen/rollback matrix green; no leaked transaction or half-publication |
| S5.2 | Audit one canonical lineage from Thread -> Turn -> Item -> decision/manifest/graph -> Run/Attempt -> actions/outcomes -> Completion Gate -> TerminalReport -> event/transition rows. | Core SQLite inspection and daemon audit tooling | ids/fingerprints/statuses agree; no cancellation impersonation, duplicate event, or orphan publication |
| S6 | Review only the post-S5.2 diff, create PR, wait for CI, merge, verify the actual remote `main` merge commit, then remove only the exact new QA root/processes. | repository delivery workflow | remote-main SHA matches merge commit; cleanup list is exact and reversible |

Attempt fencing is a prerequisite for S4.3, not a GUI-only assertion: `activeAttemptId`,
`runtimeInstanceId`, and `fencingToken` must be part of the Runtime contract and every
mutating write must compare-and-set that tuple. `runtime_suspend/daemon_restart` is not a
generic stale retry. A no-checkpoint restart is explicitly bounded by work-kind policy;
the plan does not promise automatic recovery for arbitrary in-flight side effects.

S3.5 is not complete when the happy-path callback carries a fence. It closes only when
the store ports make the ownership boundary impossible to bypass:

| API class | Contract | Stale/missing fence behavior |
| --- | --- | --- |
| Canonical mutation | `RuntimeAttemptFenceV1` is required and all three fence fields participate in one CAS | typed `stale_attempt`; no evidence, approval, lease, terminal, or invalidation write |
| Diagnostic callback | separate `StaleAttemptDiagnosticInput`; no canonical mutation fields | append one bounded diagnostic event at most; never upgrades to evidence |
| Read/projection | may use Work Unit/Attempt ids | read-only; cannot renew or release resources |
| Lease/semaphore renew/release | compare the owning Attempt fence in the resource update | idempotent for the same tuple; cannot release a replacement Attempt's resource |
| Terminal audit | one-use owner capability returned by the preceding terminal transition, or one owner transaction | a caller-supplied boolean or attempt-id-only callback is rejected |

The source checklist must therefore include every adapter that currently passes only an
`attemptId`, every optional `fencingToken`/`runtimeInstanceId` in Core and Daemon ports,
and every generic `release*ForOwner` call reachable from Run, Work Unit, workflow-step,
approval-resume, media, channel, or startup-recovery paths. Generic owner release may
remain only for explicitly owner-level `workflow_step` and `system` jobs; the Core type
and SQLite runtime boundary reject it for `run` or `work_unit_attempt`. Migration 121 is
a pre-release clean break: it deletes unfenced transient runtime rows instead of
backfilling or compatibly releasing them, marks their active Work Unit stale, preserves
Thread/Turn/Item content, and rejects any remaining active unfenced runtime row.

The restart classifier is also part of S3.5 source closure. Startup must scan
`resume_pending` before Attempt creation and classify the durable checkpoint/tool window:

```text
safe checkpoint + no tool_start -> same Run, one replacement Attempt
no checkpoint                  -> same Run becomes typed blocked, no retry
tool_start without tool_end    -> effect-unknown blocked, no retry
tool_end present               -> reconstruct evidence, finalize once
terminal publication present   -> reconcile ids only
```

SSE/RPC reconnect is tested as an observer-only operation. It may replay from a sequence
cursor or return a fresh snapshot, but it cannot create a Turn/Run/Attempt, repost input,
or publish a result. The Web surface renders an acknowledgement as `accepted/pending`;
only the committed `finalResultItemId` and source-Turn terminal transition unlock the
final-result presentation.

S3.5 source coverage map:

```text
runtime callback
  ├── current (attemptId, runtimeInstanceId, fencingToken) -> CAS may mutate canonical rows
  └── stale/unknown tuple -> diagnostic-only; evidence/approval/lease/terminal writes rejected

delegated outcome validator
  ├── completed + unique refs + requirement coverage -> persist outcome
  ├── blocked + closed code + host binding -> persist negative outcome
  └── empty refs / unknown code / mismatched binding -> reject before persistence

required manifest -> Completion Gate -> TerminalReport
  ├── every required participant -> coverage row (satisfied or negative)
  ├── actual execution -> compact contribution summary
  └── committed final_result -> workflow card stays folded; duplicate terminal publication rejected
```

### Worktree parallelization strategy

The source hardening is split into independent lanes only where the module ownership is
disjoint. The packaged and delivery lanes remain strictly sequential because they consume
one exact artifact and one canonical SQLite lineage.

| Lane/step | Module boundary | Depends on |
| --- | --- | --- |
| A1: Outcome contract | `packages/contracts` and delegated-finalizer fixtures | S0 contract freeze |
| A2: Attempt fence | `packages/core` Runtime/SQLite and daemon runtime callbacks | S0 contract freeze |
| A3: Report projection | TerminalReport Core/Web projection and duplicate-publication tests | S0 contract freeze |
| B: Source integration | Completion Gate, workflow reconciliation, migration registration, cross-package typechecks | A1 + A2 + A3 |
| C: Deterministic source matrix | Contracts/Core/Daemon/API/Web tests and static gates | B |
| D: Packaged macOS acceptance | packaged app, isolated daemon, GUI/E2E harness, SQLite audit | C |
| E: Delivery | review, PR/CI, merge, remote-main verification, exact cleanup | D |

Execution order:

```text
           ┌── A1 Outcome contract ──┐
S0 ────────┼── A2 Attempt fence ──────┼──> B Source integration -> C Matrix
           └── A3 Report projection ──┘                         -> D macOS package
                                                               -> E delivery
```

A1, A2, and A3 may be developed in separate worktrees because they touch different
authorities. B must be merged into one worktree before the source matrix; it is the first
point where the finalizer, store ports, migrations, and Web projection can expose contract
drift. Do not run D from multiple artifacts, and do not parallelize E with D: a packaged
failure must reopen the owning source lane rather than be hidden by a later merge.

Conflict flags:

- A2 and B both touch Core SQLite store interfaces and migration registration; keep their
  integration sequential or merge A2 before B.
- A1 and B both touch daemon finalizer types; resolve the contract first, then wire it once.
- A3 and B both touch TerminalReport publication identity; the publication key must be
  decided once and reused by Core and Web, never independently rebased.

### What already exists and is reused

| Existing authority | Reused for this plan | Not rebuilt |
| --- | --- | --- |
| `LingThread -> LingTurn -> ConversationItem` | durable source timeline and source-Turn settlement | no second transcript/history table |
| `ExecutionAction` derived from Run events/approvals/artifacts | operation evidence and replay validation | no parallel `execution_actions` store |
| `RequiredParticipantManifestV1` + immutable graph | required fan-in set and branch authority | no callback-count quorum or role re-selection |
| `WorkflowCompletionGateV1` | one success predicate for online/restart/reconnect | no TerminalReport-owned completion judge |
| `WorkUnit` + `WorkUnitAttempt` + approval checkpoint | same-Run restart and fenced attempt replacement | no new retry queue or fake exactly-once shell executor |
| replay watermark + SSE/RPC snapshot handoff | observer recovery after reconnect | no client-owned cursor truth |

The implementation must extend these authorities in place. Introducing a second result
store, a second participant manifest, a prose parser for completion, or an SSE-owned
recovery queue is an architectural regression and is out of scope.

### S3.5 contract supplement (implementation-level)

This section turns the four locked design rules into source-level obligations. It does
not introduce a second workflow engine, action store, or history model. The existing
`LingThread -> LingTurn -> ConversationItem`, `ExecutionAction`, workflow graph,
Completion Gate, and TerminalReport remain the only authorities.

#### 1. Attempt fence and mutation rule

The Runtime Control Plane carries one immutable fence for every process-owned Attempt:

```ts
interface RuntimeAttemptFenceV1 {
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly runId?: string;
  readonly runtimeInstanceId: string;
  readonly fencingToken: string;
}
```

`fencingToken` is an opaque decimal string in TypeScript and a monotonically increasing
per-Work-Unit generation in SQLite. It is minted once at Attempt claim and is never
reused. The canonical `work_units.active_attempt_id` points to the only live Attempt; the
Attempt row stores `runtimeInstanceId` and `fencingToken`. The claim transaction must
atomically fence the previous live Attempt, insert the replacement, advance
`active_attempt_id`, and append the runtime audit event. A partial unique index over
non-terminal Attempt states is an additional storage guard, not a substitute for the
compare-and-set.

Every mutating Runtime API accepts the complete fence and checks all of the following in
one CAS predicate:

```text
work_unit.active_attempt_id == fence.attemptId
AND attempt.work_unit_id == fence.workUnitId
AND (fence.runId is absent OR work_unit.linked_run_id == fence.runId)
AND attempt.runtime_instance_id == fence.runtimeInstanceId
AND attempt.fencing_token == fence.fencingToken
AND attempt.status is non-terminal
```

This covers heartbeat, runtime event/evidence append, tool start/end, approval consume,
lease/semaphore release, Run/Work Unit/step terminal transition, and startup repair. A
stale or unknown fence returns a typed `stale_attempt` result and may append only a
bounded diagnostic event. It cannot mutate canonical evidence, consume approval,
release the current Attempt's resources, or publish an invalidation. The source change
must add migration 121 (clean-break v2) for the token/index/audit shape and update every
mapper, store port, and callback adapter in the same slice. The daemon Runtime snapshot
schema moves from 22 to 23; a v22 snapshot is refetched/rebuilt rather than accepted with
a fabricated token.

#### 2. Closed delegated outcome contract

`DelegatedOutcomeV1` is host-authored and persists only after validation against the
immutable step requirement. `DelegatedBlockCodeV1` and `DelegatedTerminalCodeV1` are
closed unions; provider-specific diagnostics live in reason/evidence fields:

```text
completed  = workflowId + workflowStepId + participantId
             + >=1 unique evidence refs
             + all required operations/dependencies covered
blocked    = same binding + closed DelegatedBlockCodeV1
             + non-empty reason + >=1 missing requirement
             + evidenceRefs property (array may be empty before any side effect)
failed/cancelled = same binding + closed DelegatedTerminalCodeV1 + evidenceRefs array
workflow_started = durable handoff only; never a completed step
```

The validator rejects unknown block/terminal codes, kind-incompatible terminal codes,
unknown fields, duplicate refs, empty
completed evidence, missing binding, binding mismatch, and evidence kinds outside the
step requirement before the SQLite mapper/store is called. Assistant text, delivery
state `ready`, Run status, and callback arrival are not valid inputs to this validator.
The finalizer is the only constructor for terminal delegated outcomes; model output can
request an action or propose a blocker but cannot supply participant completion or
workflow status. In particular, `approval_resume_effect_unknown` must be normalized to a
blocked outcome even when the underlying Run has failed, while `runtime_interrupted_no_checkpoint`
is mapped to blocked or failed only by the immutable work-kind recovery policy.

#### 3. Required coverage versus actual participation

Completion Gate evaluates the accepted immutable manifest, not the rows that happen to
exist. It must emit one result for every required participant:

```text
requiredCoverage[participantId] =
  satisfied | missing | blocked | failed | cancelled
```

The TerminalReport projection keeps this required-coverage set separate from the
optional `participants` contribution summary. `participants` answers “who actually
contributed evidence”; `requiredCoverage` answers “which accepted obligations were
covered and which were not.” A required participant with no step/Run is therefore a
visible `missing` blocker, while an optional never-started Agent is not fabricated as a
failure. The UI renders missing/blocked/failed required rows in evidence/risk sections
and does not count them as successful contributions.

#### 4. One terminal projection and recovery boundaries

`TerminalReport + final_result ConversationItem + source LingTurn settlement` is one
idempotent publication identity. Its unique key is the owning workspace/source/Turn plus
`publicationKind=final_result`, not a mutable Completion Gate or report revision. The
publication store revalidates the fresh Completion Gate read-set and returns the already
committed lineage when that source key exists. The Web projector reconciles by the
durable `finalResultItemId`; `terminalReportRevisionKey` may refresh that same Item but is
never a second identity. It folds the workflow card after `final_result` exists. Replays,
duplicate callbacks, SSE reconnects, and browser refreshes only re-project that committed
identity.

Restart is classified from SQLite, never from process-local memory:

```text
safe checkpoint, no tool_start       -> fence old Attempt, create one new Attempt, continue same Run
no checkpoint                        -> runtime_interrupted_no_checkpoint, no automatic side-effect retry
tool_start without tool_end          -> approval_resume_effect_unknown, no retry, typed blocker
tool_end present, terminal rows open -> reconstruct evidence and finalize once
Run/outcome already terminal          -> semantic reconciliation/publication only
```

SSE/RPC reconnect performs canonical snapshot/replay and advances the cursor only after
the refresh succeeds. It never creates a Turn, Run, Attempt, approval, outcome, or
publication. These rules are intentionally clean-break v2; no v1 dual-read, alias, or
silent default is added.

#### 5. Terminal audit sequencing and ownership

Terminalization has two different writes that must not be conflated:

```text
owner holds current fence
  -> transition Work Unit / Attempt to terminal
  -> append exactly one terminal runtime audit with the same fence
  -> release only that Attempt's resources
  -> let the Completion/Report owner reconcile canonical outcome
```

The terminal audit is an audit fact, not a new lease on a terminal Attempt. The
`allowTerminalAttemptAudit` capability is therefore valid only when all of these are
true:

1. the caller already proved the complete current `RuntimeAttemptFenceV1`;
2. the caller performed the immediately preceding terminal transition in the same
   owner-controlled transaction or in an idempotent handoff whose transition result is
   retained;
3. the audit event's `attemptId`, `runtimeInstanceId`, and `fencingToken` equal the
   transition owner tuple; and
4. the event type is one of the closed terminal-audit types for that transition.

An old callback, a callback that only knows `attemptId`, or a caller that observes a
terminal row without owning its transition cannot use this capability. Such a callback
is diagnostic-only. A terminal audit may not consume approval, append action/evidence,
change `activeAttemptId`, alter Completion Gate/TerminalReport state, or publish a client
invalidation. If the audit append fails, the owning transaction rolls back the terminal
transition; no path is allowed to leave a terminal row without its required audit and
then treat the work as successfully finalized. The implementation must make this
ownership explicit in the store API instead of relying on a default boolean at call
sites.

#### S3.5 focused exit matrix

| Contract | Required source regression | Must remain false |
| --- | --- | --- |
| Attempt fence | old Attempt callback after replacement is diagnostic-only | old callback changes evidence, approval, lease, Run, step, or report |
| Terminal audit | current owner can atomically record the final audit after terminal transition | normal terminal cancellation/failure/media/channel paths fail with a false stale-fence error, or an unowned callback bypasses the fence |
| Outcome validator | invalid binding/code/empty completed refs rejected before persistence | `ready` text or Run success creates `completed` |
| Required coverage | Engineer + QA with QA absent/blocked keeps a negative QA row | callback count or Engineer-only quorum verifies fan-in |
| Terminal projection | duplicate callback/reconnect returns same report/item/turn ids | second final-result Item, terminal summary, or Turn settlement |
| Restart classifier | all four checkpoint/tool windows converge from SQLite | duplicate side effect, new Run, participant reselection, or infrastructure-as-user-cancel |

### Phase failure ownership

```text
P1a red -> participant-authority persistence/origin compiler or Workflow participant-to-Run policy adapter
P1b red -> canonical teammate model resolver, proposal/step provider preflight, or blocker projection
P1 red -> Runner adapter / DelegatedOutcome finalizer
P2 red -> Runtime suspension / approval resume / Completion Gate
P3 red -> Control-plane replay / Web projection
P4 red -> earliest mismatched canonical owner from the truth ladder
P5 red -> review, CI, or delivery only; do not reinterpret runtime evidence
```

For the active tail, ownership is narrower:

```text
S4.1 red -> delegated finalizer / typed outcome validator / provider preflight
S4.2 red -> required manifest, Completion Gate, or TerminalReport coverage projection
S4.3 red -> Runtime Attempt fence, checkpoint classifier, or approval-resume transaction
S4.4 red -> replay floor/cursor, SSE/RPC handoff, or Web refresh generation fence
S5.1 red -> migration/transaction owner/reopen boundary
S5.2 red -> earliest mismatched canonical row in the truth ladder
S6 red -> repository delivery only; never reinterpret a packaged runtime failure
```

No phase is allowed to "fix" a lower layer by weakening the next layer. In particular,
the UI cannot turn an acknowledgement into success, TerminalReport cannot repair missing
participant evidence, reconnect cannot resubmit a Turn, and startup recovery cannot
invent a cancellation, completion, participant, or tool result.

## Codex And Claude Code Reference Boundary

The transferable pattern is the authority split, not either product's private runtime:

| Reference | Useful boundary | Ling adaptation |
| --- | --- | --- |
| Codex | A durable Thread contains Turns and typed Items; assistant messages, tool calls/results, approvals, plans, and errors are separate lifecycle items. A client reconnects to state instead of making prose authoritative. | Keep `LingThread -> LingTurn -> ConversationItem`; normalize tools into `ExecutionAction`; treat SSE/RPC as replayable projection transports. |
| Claude Code | Ordinary final text and tool use/results are different protocol events; permission mode gates side effects; a Session can continue/resume without treating the last text as proof that a tool ran. | Keep runner text as narration, require typed tool/output evidence, route approvals through Ling policy, and reconstruct from durable rows after restart. |
| Ling multi-Agent | Neither single-agent reference provides Ling's workflow-wide participant/fan-in truth. | Add immutable required-participant manifest, workflow graph, delegated outcomes, and one evidence-backed Completion Gate. |

## Document authority and release-stage precedence

The documents answer different questions; none may silently override another at runtime:

| Concern | Canonical document/authority | What it owns |
| --- | --- | --- |
| Thread/Turn/Item topology, context projection, delegated outcome, Completion Gate, and reconnect invariants | [Channel Conversation Continuity v2](channel-conversation-continuity-v2.md) | semantic truth and cross-domain invariants |
| Work Unit/Attempt lifecycle, runtime fence, leases, checkpoint suspension, and control-plane replay | [Runtime Control Plane](runtime-control-plane-detailed-design.md) plus Runtime Supervisor | process recovery and observer delivery |
| Evidence collection, required coverage projection, report schema, and final-result rendering | [TerminalReport Protocol](ling-agent-terminal-report-protocol.md) | report data and user-visible terminal projection |
| Workflow packet/side-effect policy and safe parallelism | [Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md) | workflow shaping and operation policy |
| Execution order, test commands, packaged evidence, and delivery gates | this implementation plan | current release state only |

When two documents disagree, the more specific authority above wins for its concern;
this plan records the conflict and updates the owning contract rather than adding a
caller-side exception. Phase labels outside the active S3.5/S4/S5/S6 DAG are historical audit
references only.

Therefore Ling should not parse “I will execute”, “done”, or localized equivalents. A
delegated runner either has host-validated evidence, returns a schema-valid blocker, or
is terminalized by the host as `delegated_outcome_missing`. Likewise, resuming a runner
session is an execution optimization; canonical Ling rows remain the recovery and audit
authority.

The same separation applies before execution. Codex/Claude-style agent/session
instructions are assembled into the concrete model request, while tool availability,
permission mode, sandboxing, and tool results remain host-owned facts. Ling's equivalent
is not “`teammateId` is enough.” The workflow adapter must bind the selected teammate's
persona/profile into the actual Run request, then independently apply the operation-
derived tool subset and strictest approval/session policy. Persona shapes behavior; it
never grants authority or proves completion.

Codex and Claude Code also avoid this exact failure for a structural reason: the concrete
tool invocation is emitted as a typed tool call and its result is correlated by call id.
They do not first convert `Node 调用...` into the literal planned command `Node` and later
compare that string with `node -e ...`. Ling currently compiles a durable operation before
the delegated Agent chooses concrete arguments, so this slice needs an explicit
`exact_command | executable` policy. A future host-bound `operationId` on the concrete
tool call is the closer analogue, but is not required to fix this packaged failure.

## Root Cause Map

The four originally reported problems are related but not identical. Three are authority
bugs and the fourth is an unclosed acceptance boundary. Packaged QA then exposed the
participant-profile adapter bug and the broad suite exposed its provenance follow-up:

| Problem | Root cause | Long-term correction |
| --- | --- | --- |
| Correct Agent id but wrong Agent behavior | workflow proposal validation saw the teammate profile, but the workflow-step-to-Run adapter dropped `systemPrompt`, `appendSystemPrompt`, and `approvalProfile` | resolve the exact canonical teammate in the shared step-start adapter and freeze its effective profile in the Run request snapshot |
| Workflow-defined participant falsely unavailable | the profile adapter treated Channel membership as universal participant authority and exempted only `teammateTemplateId` steps | persist `WorkflowParticipantAuthorityV1` with a trusted origin; `channel_selection` revalidates effective Channel membership, while `workflow_definition` requires only active/visible exact-participant checks |
| Delegated execution stops at “I will execute” | assistant delivery `ready` was allowed to stand in for delegated-step outcome | require a host-authored `DelegatedOutcomeV1` backed by canonical actions/output packet, or a validated structured blocker |
| Orchestrator accepts text/Run success | terminal callbacks and post-approval paths had separate completion shortcuts | make every callback a wake-up only; reload the immutable requirement and canonical evidence through one delegated finalizer |
| Multi-Agent fan-in succeeds too early | the materialized step set could be mistaken for the accepted required branch set | preserve one immutable required-participant manifest and graph; run one Completion Gate over all required participants, operations, dependencies, and fan-in policy |
| Restart/reconnect packaged behavior is unproven | daemon lifetime was collapsed into business cancellation, and transport tests alone cannot prove a packaged Desktop lifecycle | split Run from Attempt, resume only from durable checkpoints, make all observer events post-commit invalidations, then verify the real packaged daemon/PID/SSE/SQLite lineage |
| Atomic completion fails under Node 22 | aggregate stores called a standalone event writer that could open a nested transaction, while rollback branches trusted `DatabaseSync.isTransaction`, which can report false after `BEGIN IMMEDIATE` | make transaction ownership explicit in the API and composition root; joined writers never begin/commit/rollback, owners always best-effort rollback and preserve the original failure |

Codex and Claude Code supply the first two structural lessons: text, tool request, tool
result, and permission are different protocol facts. Ling must add the third and fourth
itself because its accepted Channel Turn can own a durable multi-Agent graph across a
Desktop-managed daemon restart. Neither competitor comparison is evidence that Ling's
fan-in or packaged recovery works; only Ling's canonical rows and acceptance matrix can
prove that.

## Locked Implementation Contract

The four observed failures are one completion/recovery problem, but they are not fixed by
one flag or one prompt. The design locks these responsibilities:

| Boundary | Input fact | Only legal output | Forbidden shortcut |
| --- | --- | --- | --- |
| Step provenance -> participant authority | trusted compiler origin, exact participant id, source reference | one fingerprinted `WorkflowParticipantAuthorityV1` committed with the graph/step | inferring authority from missing `sourceProposalId`, caller-supplied origin, or a late metadata write |
| Workflow participant -> Run | immutable step participant id, current canonical teammate profile, graph binding, exact required-tool subset | one profile-complete Run request whose effective values are frozen in the Run snapshot | carrying only `teammateId`, auto-hydrating generic internal Runs, substituting a peer, or widening to all teammate tools |
| Runner adapter -> delegated step | current linked Run, immutable requirement, approvals, actions or sealed packet | typed `DelegatedOutcomeV1` plus compatible step transition | treating assistant `ready` text or `Run.succeeded` as step completion |
| Daemon process -> logical Run | typed stop intent, active attempt, approval checkpoint, current Run/work-unit state | explicit cancellation, typed failure, or recoverable attempt suspension | mapping daemon shutdown/timeout AbortError to `local-user` cancellation |
| Delegated steps -> workflow | accepted participant manifest, immutable graph, all required step outcomes/evidence, termination policy | one `WorkflowCompletionEvaluationV1` committed with its workflow effect | succeeding from “all rows currently present are successful” |
| Workflow -> user result | committed report plus a fresh Completion Evaluation read-set | final Item, report marker, source Turn settlement/event, and invalidation in one transaction | sequential publication writes or trusting a cached verified gate |
| Aggregate transaction -> nested store write | explicit caller-owned transaction capability | joined write with no `BEGIN`, `COMMIT`, or `ROLLBACK`; owner commits or rolls back the aggregate | probing `DatabaseSync.isTransaction`, silently joining through a standalone API, or allowing a nested writer to close the caller's transaction |
| SQLite -> connected client | durable sequence replay or buffered snapshot handoff | canonical Channel/runtime projection and advanced last-applied cursor | using last-received cursor, fixed client pagination, or reconnecting by resubmitting work |

The host, not the model, is authoritative at every boundary. A model can request tools,
write ordinary narration, or propose a structured blocker. It cannot invent action ids,
participant completion, fan-in success, workflow status, or source-Turn settlement.

The observer boundary is deliberately not a fifth completion authority. SSE/RPC receipt,
Web refresh, and a rendered final-result card are acknowledgements of Layer 4 projection.
They may lag, reconnect, or rebuild, but they cannot upgrade or downgrade the committed
workflow/report/Turn lineage. This distinction prevents a transport `ready` event from
being confused with assistant delivery `ready`, delegated completion, or workflow
success.

The state mapping is also fixed:

| Evaluation | Workflow state | Publish final result? | Source Turn after publication |
| --- | --- | --- | --- |
| `pending` | retain compatible non-terminal state | no | retain open/running/waiting state |
| `verified` | `succeeded` | yes | `succeeded` |
| `blocked` | `blocked` | yes, with structured blocker/partial result | `blocked`, settled but resumable |
| `failed` | `failed` | yes | `failed` |
| `cancelled` | `cancelled` | yes | `cancelled` |

This mapping is derived inside the publication store. The daemon does not supply a
`targetTurnStatus`, and TerminalReport prose cannot choose it. A `verified` evaluation
requires report outcome `succeeded`; `blocked` accepts only `blocked` or
`partially_succeeded`; `failed` requires `failed`; and `cancelled` requires `cancelled`.
Any other report/evaluation pair is a typed publication conflict and writes nothing.

This is the complete long-term structure. No additional action table, completion table,
workflow engine, or message-text classifier is required.

### SQLite transaction ownership amendment

Completion correctness depends on atomic publication and recovery writes. Transaction
membership is therefore a compile-time composition decision, not a runtime guess. The
same store may expose two deliberately different entry points:

```ts
interface StandaloneControlPlaneEventWriter {
  appendControlPlaneEvent(input: AppendControlPlaneEventInput, now: string): ControlPlaneEvent;
}

interface TransactionalControlPlaneEventWriter {
  appendControlPlaneEventWithinTransaction(
    input: AppendControlPlaneEventInput,
    now: string,
  ): ControlPlaneEvent;
}
```

The standalone method always owns one `BEGIN IMMEDIATE -> COMMIT/ROLLBACK` lifecycle.
The transactional method assumes the caller already owns the transaction and performs
only the row writes. It never opens, commits, or rolls back a transaction. Aggregate
ports use the transactional name as part of their interface, so a future composition
cannot accidentally bind the standalone writer without a visible type/diff change.

```text
TerminalReport / approval-resume / workflow aggregate owner
  -> BEGIN IMMEDIATE
  -> canonical state writes
  -> appendControlPlaneEventWithinTransaction
       event row + replay watermark only
  -> COMMIT
  -> publish returned event to in-memory SSE/RPC hub

any write throws
  -> owner attempts ROLLBACK unconditionally
       rollback error is suppressed
       original domain/SQLite error is rethrown
  -> no in-memory publish
```

`DatabaseSync.isTransaction` is not an ownership authority. Runtime code in this
completion/recovery spine must not use it to decide whether to begin, join, or roll back.
An owner knows that it issued `BEGIN IMMEDIATE`; its catch path therefore attempts
`ROLLBACK` regardless of the property value. A joined writer knows from its port which
transaction it belongs to. The old precondition checks that inspect `isTransaction` are
removed rather than retained as unreliable safety checks; an accidental nested call
fails at `BEGIN` and its caller wiring is fixed.

This amendment applies to:

- standalone and aggregate control-plane event append;
- TerminalReport and legacy workflow publication;
- approval-resume claim, suspension, terminal, and quarantine commits;
- workflow-step finalization and workflow Completion Evaluation commits.

Migration helpers are audited separately in the same source-closeout slice because they
also own transactions, but they do not gain a dual standalone/joined API. This is a
direct pre-release correction: no alias, ambient auto-join, savepoint shim, or dual path
is added.

### T7 review hardening amendment

The complete-diff review found six places where the implementation can still violate the
locked structure even though the existing suites are green. These are implementation
gaps, not reasons to add another authority:

| Gap | Current unsafe behavior | Locked correction |
| --- | --- | --- |
| Plain-text unavailable mention | fallback enumerates only active, visible, current-Channel teammates, so `；@QA` can disappear before availability is recorded | resolve text tokens against the complete known teammate identity inventory, commit the canonical mention, then record availability separately |
| Delegated step without a Run | finalizer constructs `delegated_run_missing`, but the commit helper returns `waiting` whenever no Run object exists | extend the atomic finalization CAS with explicit `linked_run` and `no_linked_run` read-set variants; the latter requires `step.run_id IS NULL` and commits typed blocked outcome |
| Coalesced transport queue | preserved high-sequence terminal events are concatenated before lower-sequence coalesced invalidations | use one shared SSE/RPC coalesce helper and sort the final queue by durable `seq` before delivery |
| Turn observability | Core emits `entityType="turn"`, while Contracts and the HTTP allowlist reject it | add `turn` to the shared contract and route allowlist, then verify it through the real API |
| Operation evidence matching | command substring/summary matches and unconditional path lower-casing can prove the wrong operation | require exact normalized structured command evidence; keep POSIX paths case-sensitive and fold case only on Windows |
| Residual completion paths | an unused post-publication Turn closer and unreachable manifest-backed legacy finalization code remain near the new authorities | delete the unused source-Turn closer and reduce `orchestrator.ts` to an explicit legacy-only path with no delegated-outcome imports or writes |

The first five rows are P1 because each can produce lost intent, stuck work, false
completion, or lost projection. The cleanup row is P2 but lands in the same branch because
leaving dormant competing authorities makes the next recovery change unsafe. No row is
solved by parsing model prose, retrying transport work, or weakening a CAS.

### T8 packaged command-match amendment

The packaged GUI proved that T7e's exact matching security correction is valid but
incomplete. The accepted Turn asked the Agent to create a file and use Node to call a
function. The daemon materialized `targetRef.label="Node"` as though it were a complete
command. The approved action actually ran `node -e '...'`, exited 0, and retained the
expected stdout, but exact comparison correctly rejected it. The defect is plan
materialization, not missing evidence, approval resume, publication ordering, or fan-in.

The locked correction is a daemon-owned discriminated match policy:

```ts
type CommandMatchPolicyV1 =
  | { readonly kind: "exact_command"; readonly command: string }
  | { readonly kind: "executable"; readonly executable: string };
```

`ChannelIntentExecutionOperationV1.commandMatchPolicy` is required for durable
`run_command + targetKind="command"` operations and forbidden elsewhere. The model-facing
proposal schema cannot provide it. The daemon assigns `exact_command` only to a complete,
bounded command span and `executable` only to an explicit allowlisted runtime plus an
execution objective. `targetRef.label` remains display metadata.

Objective-scoped workspace work remains separate: requests such as “run the project
tests” or a Git publication workflow may carry an optional workspace marker with no
command policy. The delegated finalizer still requires a real successful action before
completion, but neither the operation verifier nor TerminalReport may present that as
exact-command evidence. This preserves the existing useful broad workflow without
turning it into a loophole in command matching.

Evidence matching is centralized in one quote-aware helper. `executable=node` accepts a
single simple `node -e ...` command but rejects `echo node ...`, wrappers, prefixes,
top-level chaining/redirection/substitution, unrelated executables, and action prose.
Exact commands remain exact. Both policies still require a succeeded `bash` action,
structured command evidence, exit code 0, no timeout/cancellation/signal, dependency
order, and all existing approval/sandbox checks.

This is a clean break. Ling is still pre-release, so old development JSON without the
required policy is not defaulted or dual-read. Tests and fresh packaged QA data are
regenerated against the new contract. A host-bound operation/tool-call id is deferred
until the runner adapter can stamp it; arbitrary same-Run bash success is explicitly
forbidden as a substitute.

### T8c crash-consistency amendment

`resume_pending` is not a transient implementation detail. It means one daemon instance
claimed an approved checkpoint and bound a replacement-attempt id, but canonical rows
must still determine whether that attempt may start, may be finalized, or has an unknown
side-effect outcome. Startup must scan it alongside `pending` and `approved`.

The checkpoint keeps one immutable `resumeBasis` and one revision-fenced mutable
`runnerResumeHandle`. The basis binds the approved side effect and original lineage. The
handle binds the current replacement attempt. Changing the handle never changes what was
approved. Every replacement attempt remains append-only audit history.

All pre-execution facts share one SQLite authority and therefore commit through one
`commitApprovalResumeClaim()` transaction: checkpoint revision/status, replacement
Attempt insert, Run/work-unit transition and `activeAttemptId`, runtime audit event, and
content-free control-plane invalidation. A new writer cannot durably expose
`resume_pending` without its bound Attempt. Startup may repair that shape only as
pre-release/partial-state recovery; it is not a normal steady-state window.

```text
pending --approve--> approved --claim CAS--> resume_pending
                                           |
                                           +-- no replacement attempt
                                           |     -> create bound attempt and continue
                                           |
                                           +-- attempt exists, no tool_start
                                           |     -> mark it lost, CAS a new bound attempt,
                                           |        continue the same approved side effect
                                           |
                                           +-- tool_end exists
                                           |     -> reconstruct ExecutionAction and finalize;
                                           |        never execute again
                                           |
                                           +-- tool_start exists, no tool_end
                                           |     -> resume_failed(effect_unknown) -> blocker;
                                           |        never execute again
                                           |
                                           +-- terminal Run/outcome exists
                                                 -> shared semantic reconciliation only
```

The ordering guarantee is:

```text
atomic claim
  -> acquire Run resource leases
  -> acquire replacement-Attempt semaphore slots
  -> durable tool_start
  -> local side effect
  -> durable tool_end
  -> atomic terminal/block settlement
  -> post-commit semantic reconciliation
```

The claim grants attempt ownership, but it does not bypass normal runtime capacity. A
replacement Attempt must pass the same workspace/channel/provider/runner lease and
semaphore gates as an ordinary Attempt. A crash after claim or capacity acquisition but
before `tool_start` is safe to retry only after startup/suspension recovery fences the old
Attempt and releases its active capacity. Absence of `tool_start` proves the side effect
was not dispatched by that Attempt. Presence of `tool_start` without `tool_end` does not
prove whether the operating system completed the command, so non-idempotent local
execution cannot be retried safely. Ling surfaces `approval_resume_effect_unknown` with
the command and Attempt references redacted to the normal evidence surface. A future
durable executor may narrow this window with an idempotency token, but the current daemon
must not guess.

Runtime stop intent applies equally to normal and resumed execution:

| Stop during replacement attempt | Durable effect |
| --- | --- |
| explicit user/workflow cancel | cancel the logical Run and approval lineage through the existing business authority |
| idle/hard timeout or runner crash | fail the Run with the typed runtime-failure code; never write `local-user` cancellation |
| daemon restart before `tool_start` | mark only that attempt lost; retain `resume_pending`; startup may create one further fenced attempt |
| daemon restart after `tool_start`, before `tool_end` | retain audit rows and publish `approval_resume_effect_unknown`; do not replay the side effect |
| daemon restart after `tool_end`, before Run finalization | finalize from canonical evidence; do not replay the side effect |

Runner support is explicit capability data, not an inference from a runner id. The
registry exposes `native_resume`, `host_approval_continuation` with supported action
types, or `none`. Pi declares no native session resume because it uses
`SessionManager.inMemory`; it may declare bounded host continuation for exact approved
`bash` only. Unsupported `write`/`edit` recovery remains a typed blocker until their
executors expose an equivalent idempotent contract.

A capability string alone is not executable authority. `native_resume` is usable only
when the adapter implements the typed resume operation, returns a handle bound to the
same Run/approval/requirement fingerprint, and passes runner conformance. Existing
external-runner metadata that merely advertises `native_resume` remains disabled for
approval recovery until those conditions are true.

Every user-visible resume transition commits a content-free control-plane invalidation in
the same SQLite transaction as its canonical state change, using a deterministic
idempotency key. The in-memory hub publishes only after commit. The event is only a
wake-up hint. Reconnect may replay it or request a snapshot, and the client always reloads
canonical state before advancing its applied cursor.

The implementation must expose three narrow storage transactions:

| API | Atomic responsibility | Must not do |
| --- | --- | --- |
| `commitApprovalResumeClaim()` | CAS checkpoint, fence the old Attempt, insert/bind the replacement Attempt, activate Run/work unit, append runtime audit and invalidations | execute the tool or finalize delegated/workflow state |
| `commitApprovalResumeSuspension()` | for an initial approval wait, retain `pending/approved + waiting_for_approval`; for a claimed resume before dispatch, retain `resume_pending + running`; in both cases lose the active Attempt, release Run leases/Attempt slots, and append recoverable audit plus invalidations | accept arbitrary checkpoint/Run/work-unit cross-products, fail/cancel the logical Run, consume the approval, or infer workflow state |
| `commitApprovalResumeTerminal()` | with verified lineage, settle checkpoint, Run, work unit, active Attempt, owning Task, resources, terminal audit, and invalidations as one compatible result/blocker; with a discriminated corrupt-lineage quarantine, settle only checkpoint/audit/approval invalidation | terminalize caller-guessed Run/work-unit rows, or accept model prose, participant success, workflow status, or source-Turn status from the caller |

Suspension input is a discriminated lifecycle contract, not three independent expected
status strings:

```ts
type ApprovalResumeSuspensionShapeV1 =
  | {
      readonly kind: "approval_wait";
      readonly expectedCheckpointStatus: "pending" | "approved";
      readonly expectedRunStatus: "waiting_for_approval";
      readonly expectedWorkUnitStatus: "waiting_for_approval";
    }
  | {
      readonly kind: "resume_pre_dispatch";
      readonly expectedCheckpointStatus: "resume_pending";
      readonly expectedRunStatus: "running";
      readonly expectedWorkUnitStatus: "running";
    };
```

The store rejects every other combination before writing. Ling is pre-release, so this
shape replaces the current loose draft directly; no compatibility alias or default is
added.

`tool_start` and `tool_end` remain durable Run events around the operating-system side
effect. They cannot be merged with the local process execution. A terminal transaction
after `tool_end` is safe to retry because it never executes the tool. A blocker
transaction for `tool_start` without `tool_end` records effect-unknown and likewise never
executes the tool.

After a successful suspension or terminal commit, the coordinator publishes only the
returned events. After a terminal commit it then wakes the existing delegated finalizer,
Completion Gate, and publication reconciler. Those semantic steps are deliberately
outside the Core transaction and are restart-recoverable from the terminal Run. This is
the boundary that keeps row atomicity without moving Channel graph semantics into Core.
When immutable lineage validation fails, the checkpoint-only quarantine variant marks
the checkpoint `resume_failed` atomically but leaves unverified Run/work-unit/Attempt rows
unchanged. It never uses a malformed resume basis as authority to fail unrelated work.

## Module Ownership

| Boundary | Owning module | Required change |
| --- | --- | --- |
| Shared protocol | `packages/contracts/src/conversation-continuity.ts`, `packages/contracts/src/workflows.ts` | participant manifest, delegated outcome, completion-gate types and validators |
| Command plan materialization | `channel-intent-selector.ts` plus one focused command-match helper | keep the model proposal non-authoritative; materialize exact/executable policy and canonical match value from the accepted Turn |
| Mention acceptance | new focused `packages/daemon/src/features/channels/channel-mention-materializer.ts` plus accepted-turn ingest | validate structured tokens, Unicode fallback, canonical committed mention set |
| Intent authority | `channel-turn-dispatch-executor.ts`, `channel-intent-selector.ts`, `messages.ts` | selector runs before explicit-mention reply routing; persist manifest with decision |
| Workflow compiler | `proposal-workflows.ts` | copy manifest fingerprint, map required participants and operation ids to graph steps, reject loss |
| Participant-to-Run profile adapter | focused `workflow-participant-run-profile.ts` called only by `prepareWorkflowStepStart()` in `workflows.ts` | enforce manifest assignee equality; resolve the exact teammate; validate current availability/tool ceiling; return base/append prompts and approval profile for the Run request |
| Step finalization | new focused `workflow-step-finalizer.ts` reusing `workflow-operation-evidence.ts` and step output packets | reload the linked Run and immutable delegated requirement, derive one typed outcome, and atomically commit outcome plus compatible step transition |
| Workflow reconciliation | new focused `workflow-reconciliation.ts` | make online callback, approval, startup, duplicate callback, and pre-publication use the same canonical-state kernel |
| Workflow completion | focused `workflow-completion-gate.ts`, called only through workflow reconciliation for manifest-backed settlement | pure participant/graph equality, operation/dependency/fan-in/termination evaluation plus typed canonical read-set |
| Publication | existing TerminalReport coordinator/publisher plus a focused Core publication store | consume a fresh completion basis; derive the report/Turn outcome mapping; atomically create/reuse the final Item, mark the report published, settle the source Turn, append its transition event, and append one durable invalidation |
| SQLite transaction composition | `sqlite-run-store.ts`, `control-plane-store.ts`, `terminal-report-publication-store.ts`, `approval-resume-store.ts`, and `channel-workflow-store.ts` | expose explicit standalone/joined event capabilities, bind aggregate ports to joined writes, and make each transaction owner roll back without ambient probing |
| Low-level recovery | Core runtime recovery coordinator | repair leases, lost Runs, and legal process-state rows; never decide manifest-backed semantic success |
| Live projection recovery | control-plane store/event hub, API transports, and Web invalidation hook | own a durable replay floor and scoped replay window; reconnect or snapshot canonical projections without restarting accepted work |

`messages.ts` and `orchestrator.ts` remain composition points. Mention parsing and
completion truth must not be added as more inline branches in those already-large files.
Likewise, the generic Run orchestrator must not become an implicit teammate-profile
loader. Internal selector, summary, and report Runs own explicit system roles; only the
workflow participant adapter hydrates a delegated workflow step.

The completion gate module owns pure evaluation only. SQLite stores its snapshot inside
existing workflow metadata for audit and replay, while the workflow store owns the atomic
`recompute -> compare basis -> save snapshot -> terminal transition` operation. This
keeps completion truth out of HTTP, SSE, TerminalReport, and Web code.

The dependency direction is one-way:

```text
orchestrator / approval sync / daemon startup / TerminalReport pre-publication
                                 |
                                 v
                    workflow-reconciliation.ts
                      |                       |
                      v                       v
          workflow-step-finalizer.ts   workflow-completion-gate.ts
                      \                       /
                       v                     v
                 canonical stores, actions, packets, approvals
```

`workflow-reconciliation.ts` must not import scheduling entry points from
`orchestrator.ts`, and the pure gate must not import either composition module. Existing
publication code may consume the reconciliation result, but the reconciler does not call
back into TerminalReport synthesis. This avoids an `orchestrator.ts <-> workflows.ts`
cycle and prevents reporting from becoming completion authority.

### Shared finalizer and reconciliation contract

Each compiled delegated step persists one immutable `DelegatedStepRequirementV1` in step
metadata and the Run request snapshot. It binds the workflow, step, participant,
participant-manifest fingerprint, expected outcome, required operations, dependencies,
and accepted evidence kinds. If the persisted requirement is absent or disagrees with
the source decision/graph, the finalizer blocks explicitly; it never rebuilds a looser
requirement from runner prose.

The public APIs are canonical-state APIs rather than callback-payload APIs:

```ts
type WorkflowReconcileCause =
  | "run_terminal"
  | "approval_decision"
  | "startup"
  | "explicit_reconcile"
  | "duplicate_callback"
  | "pre_publication";

function finalizeDelegatedWorkflowStepFromCanonicalState(input: {
  store: RunStore;
  workflowStepId: string;
  cause: WorkflowReconcileCause;
  now: string;
}): DelegatedStepFinalizationResult;

function reconcileWorkflowFromCanonicalState(input: {
  store: RunStore;
  workflowId: string;
  cause: WorkflowReconcileCause;
  now: string;
}): WorkflowReconciliationResult;
```

The callback's Run id, approval id, or remembered status is only a wake-up hint. The
finalizer reloads the step's currently linked Run and durable approval state. A late
callback for an earlier retry therefore cannot finalize the newer attempt with stale
payload. Given the same canonical rows, every cause produces the same semantic result;
`cause` changes audit attribution only.

For one step, the finalizer performs this sequence:

1. Reload workflow, step, immutable requirement, currently linked Run, approval, action,
   and output-packet rows.
2. Validate requirement ownership and manifest/graph fingerprint equality. A missing or
   mismatched requirement yields a structured blocker.
3. Treat a non-terminal Run or pending post-step approval as waiting, without creating a
   terminal outcome.
4. For a succeeded Run, validate agent-context freshness, every required operation, or
   the required synthesis output packet. Ordinary final text is audit narration only.
5. For a failed or cancelled Run, derive a typed negative delegated outcome before
   applying retry/failure policy.
6. Compute a deterministic step-outcome basis from the step revision, linked Run id and
   terminal event watermark, requirement fingerprint, approval revision, evidence action
   ids/statuses, and output-packet id/fingerprint.
7. In one SQLite transaction, compare that basis, persist the typed outcome, and apply
   the compatible step transition. A stale compare returns `retry_reconciliation`; it
   never commits a partially updated success.
8. Use deterministic state-event, blocker, and packet idempotency keys. Repeating the
   same finalization is a no-op and does not duplicate artifacts or visible blockers.

For synthesis/review, the finalizer derives the output-packet id and fingerprint from the
workflow, step, current Run, terminal Run event watermark, delegated-requirement
fingerprint, and canonical dependency/source refs. Packet creation is an idempotent
prepare phase; the atomic step transaction must validate and reference that exact packet.
A crash between prepare and step commit leaves one reusable packet, not permission to
accept runner prose or create a second artifact during startup recovery.

Post-step approval follows the same rule: first persist the approval transition, then
invoke the finalizer. Approval can remove the authorization wait, but only the same
evidence validation can complete the step. Core startup recovery stops after low-level
Run/lease repair; daemon startup then calls workflow reconciliation for semantic repair.

`reconcileWorkflowFromCanonicalState` scans non-terminal steps plus abnormal terminal
steps, invokes the shared finalizer for every terminal linked Run, reloads the workflow,
evaluates the immutable graph and Completion Gate, and uses the unified transactional
evaluation commit. It returns whether idempotent publication reconciliation is needed.
An already-terminal step whose delegated outcome is missing or invalid is historical
corruption, not evidence: reconciliation records a structured workflow blocker and
pre-publication rejects success rather than fabricating an outcome or reopening work.

### Completion read-set and publication transaction

`basisFingerprint` is only useful when the store proves that the rows used to compute it
did not change before commit. Replace the success-only
`commitVerifiedChannelWorkflowCompletion()` plus the separate negative-step shortcut with
one `commitChannelWorkflowCompletionEvaluation()` operation. It accepts a typed evaluation
result containing the gate and its expected read-set, not only workflow/step timestamps:

```ts
interface WorkflowCompletionEvaluationV1 {
  readonly gate: WorkflowCompletionGateV1;
  readonly expectedReadSet: WorkflowCompletionExpectedReadSetV1;
}

interface WorkflowCompletionExpectedReadSetV1 {
  readonly schemaVersion: 1;
  readonly workflow: {
    readonly id: string;
    readonly status: ChannelWorkflowStatus;
    readonly updatedAt: string;
    readonly participantManifestFingerprint: string;
    readonly graphFingerprint: string;
    readonly terminationFingerprint: string;
  };
  readonly sourceDecision: {
    readonly id: string;
    readonly action: ChannelIntentDecisionAction;
    readonly status: ChannelIntentDecisionStatus;
    readonly updatedAt: string;
    readonly participantManifestFingerprint: string;
    readonly executionPlanFingerprint: string;
  };
  readonly steps: readonly {
    readonly id: string;
    readonly status: ChannelWorkflowStepStatus;
    readonly updatedAt: string;
    readonly runId?: string;
    readonly delegatedRequirementFingerprint?: string;
    readonly delegatedOutcomeBasisFingerprint?: string;
    readonly outputArtifactId?: string;
  }[];
  readonly runs: readonly {
    readonly id: string;
    readonly status: RunStatus;
    readonly updatedAt: string;
    readonly eventCount: number;
    readonly latestEventSeq: number;
  }[];
  readonly approvals: readonly {
    readonly id: string;
    readonly status: ApprovalStatus;
    readonly resolvedAt?: string;
  }[];
  readonly artifacts: readonly {
    readonly id: string;
    readonly runId?: string;
    readonly path: string;
    readonly sizeBytes?: number;
    readonly createdAt: string;
    readonly contentSha256?: string;
    readonly sealedPayloadFingerprint?: string;
  }[];
  readonly derivedEvidence: {
    readonly executionActionProjectionFingerprint: string;
    readonly referencedActionIds: readonly string[];
  };
}
```

The transactional mapping is explicit:

| Gate status | Workflow effect |
| --- | --- |
| `pending` | persist/replace the audit snapshot; keep workflow non-terminal |
| `verified` | transition workflow to `succeeded` |
| `blocked` | transition workflow to `blocked` with the gate reason |
| `failed` | transition workflow to `failed` |
| `cancelled` | transition workflow to `cancelled` |

The reconciler evaluates this gate on every manifest-backed pass, not only after all rows
already say `succeeded`. This removes the current `reconcileNegativeWorkflowStatus()`
side rule and ensures an absent required participant, abnormal historical step, approval
denial, and successful fan-in all use the same authority and read-set CAS. A `pending`
result never publishes a final report.

`ExecutionAction` is currently a deterministic read model over Run events, approval rows,
artifact rows, and immutable Run snapshots; it is not a SQLite table. Core must not import
the daemon action projector merely to repeat the projection in a transaction. The daemon
therefore records the action-projection fingerprint for gate audit, while the Core CAS
validates the complete canonical backing-row closure: every contributing Run row and
event watermark, every contributing approval, and every referenced artifact. If any
backing row changes, the projection is necessarily recomputed. Adding an `actions` array
that the store cannot independently verify would be false safety and is forbidden.

Inside `BEGIN IMMEDIATE`, the store reloads the workflow, decision/manifest, steps, Runs,
Run watermarks, approvals, and artifact metadata; any mismatch returns
`stale_transition`. The daemon reloads and recomputes the whole evaluation. Workflow
`updatedAt` is necessary but not sufficient: the explicit manifest, graph, termination,
and source execution-plan fingerprints prevent an implementation from accidentally
dropping one authority class from the gate basis.

Workflow output packets become content-addressed evidence. A SQLite transaction cannot
atomically guard a mutable filesystem path, so migration 116 adds nullable
`artifacts.content_sha256` and `artifacts.sealed_payload_json`. Packet writers canonicalize
the small typed JSON packet, compute its digest, write the file with exclusive/create-only
semantics, and insert the artifact row with the same sealed payload and digest. The SQLite
payload is completion authority; the file is an inspectable/exportable projection.

The daemon packet reader parses and validates the sealed payload. The workflow CAS reloads
that row and recomputes the digest from `sealed_payload_json` inside `BEGIN IMMEDIATE`; it
never trusts a daemon-only digest or re-opens a mutable file as its transaction guard. A
download/inspection path may verify or repair the projected file from the sealed payload,
but changed file bytes cannot change completion truth.

Migration 116 seals only workflow output packets that can still participate in semantic
reconciliation: packets referenced by non-terminal manifest-backed workflows or by
terminal workflows whose report/publication/source-Turn chain is incomplete. It validates
their existing bytes and typed workflow/step/Run ownership before storing the payload and
digest. Missing or invalid required bytes roll back with exact artifact ids. Fully
published historical workflows and other legacy artifact kinds may keep null sealed
fields. Prepared files without a matching artifact row are harmless orphans; a packet row
without a valid sealed payload is a structured blocker, never completion evidence.

Publication uses a separate focused store method because report synthesis remains outside
the transaction:

```ts
interface CommitTerminalReportPublicationInput {
  readonly reportId: string;
  readonly expectedReportStatus: "committed" | "fallback";
  readonly expectedEvidenceFingerprint: string;
  readonly expectedWorkflowId: string;
  readonly expectedCompletion: WorkflowCompletionEvaluationV1;
  readonly expectedSourceTurn: {
    readonly id: string;
    readonly status: LingTurnStatus;
    readonly updatedAt: string;
  };
  readonly publicationItem: AppendConversationItem;
  readonly publicationEventIdempotencyKey: string;
  readonly now: string;
}

type CommitTerminalReportPublicationResult =
  | {
      readonly ok: true;
      readonly reportId: string;
      readonly item: ConversationItemV1;
      readonly sourceTurnId: string;
      readonly sourceTurnStatus: LingTurnStatus;
      readonly controlPlaneEvent: ControlPlaneEvent;
      readonly duplicate: boolean;
    }
  | {
      readonly ok: false;
      readonly code:
        | "stale_completion_basis"
        | "report_conflict"
        | "outcome_conflict"
        | "item_conflict"
        | "source_turn_conflict"
        | "publication_event_conflict";
    };
```

Implement this in a focused `SqliteTerminalReportPublicationStore`, composed by
`SqliteRunStore`, rather than growing `terminal-report-publisher.ts` or the workflow store
into a cross-domain coordinator. Within one SQLite transaction it verifies the committed
report, report source/fingerprint/outcome, expected read-set, and stored gate basis. The
store derives the target source-Turn status from the Completion Evaluation and rejects a
report whose outcome is not compatible with that evaluation. It then creates/reuses the
deterministic Item, sets `publishedMessageId`, performs the compatible source-Turn CAS and
transition event, and creates/reuses one publication invalidation. Migration 116 adds an
optional control-plane-event idempotency key with a workspace-scoped unique index;
publication always supplies it. Uniqueness now covers report id, Item key, Turn transition
key, and publication event key at the database boundary, not through a pre-insert list
query.

The publication Item input is also constrained rather than being arbitrary daemon data.
It must be the deterministic committed `assistant_message` for the report's source
Item/Turn/thread/Channel, use the Ling Agent actor and channel visibility, carry report,
workflow, source Item, source Turn, and optional linked-Run domain refs, and have
non-streaming delivery status compatible with the derived outcome. Core validates that
envelope before insert or duplicate reuse. A row found by id or idempotency key is a
duplicate only when its complete immutable lineage and payload match; otherwise the whole
transaction returns `item_conflict`.

`LingTurn.blocked` is a settled but resumable state, not one of the state machine's
immutable terminal statuses. A blocked report therefore performs a deterministic
`settle_blocked` audit self-event when the source Turn is already blocked; it is a
publication audit operation, not a normal `LingTurnTransitionEvent`, and does not rewrite
the Turn row or make blocked immutable. If the Turn is open/running/waiting, the normal
`block` transition and the same settlement idempotency key are recorded in the
transaction. Success, failure, and cancellation remain immutable terminal transitions.
Re-entry is a duplicate only when the Item, report marker, Turn settlement event, and
durable invalidation all point to the same lineage. Any partial or incompatible
pre-existing lineage is a typed conflict and rolls back; startup recovery retries the
barrier or surfaces the conflict, but never silently completes a half-lineage.

After commit, daemon code publishes the returned event to the in-memory hub. It never
appends a second durable event outside the transaction. Read-cache rebuilds such as Ling
Thread metadata run after the authoritative transaction and may be retried independently;
they are not allowed to widen the atomic write set.

The first atomic implementation is workflow-only. Existing standalone Run/Turn reports
keep their current behavior in this slice and do not receive a fake Completion
Evaluation. The legacy reporting-disabled final reply must use an equivalent focused
publication barrier before the old helper is removed; if that path cannot supply the same
source-Turn and invalidation lineage, it remains explicitly legacy and cannot settle a
manifest-backed workflow.

### Replay completeness protocol

Control-plane replay must distinguish “no events” from “the requested range cannot be
proved complete.” Extend the shared response/stream contract with:

```ts
type ControlPlaneReplayDisposition = "complete" | "snapshot_required";

interface ControlPlaneReplayWindow {
  readonly disposition: ControlPlaneReplayDisposition;
  readonly requestedAfterSeq: number;
  readonly replayFloorSeq: number;
  readonly upperBoundSeq: number;
  readonly nextAfterSeq: number;
  readonly reason?: "cursor_unavailable" | "retention_gap" | "window_exceeded";
}

interface ControlPlaneEventsResponse {
  readonly cwd: string;
  readonly workspaceId: string;
  readonly window: ControlPlaneReplayWindow;
  readonly events: readonly ControlPlaneEvent[];
}

type ControlPlaneSubscribeResult =
  | {
      readonly disposition: "complete";
      readonly subscriptionId: string;
      readonly window: ControlPlaneReplayWindow;
    }
  | {
      readonly disposition: "snapshot_required";
      readonly window: ControlPlaneReplayWindow;
    };
```

`replayFloorSeq` and the workspace `upperBoundSeq` come from one durable
`control_plane_replay_state(workspace_id, replay_floor_seq, latest_seq, updated_at)` row
added by migration 117.
The floor means “every workspace event with `seq <= replayFloorSeq` may already be gone;
replay is guaranteed only strictly after it.” Migration initializes
`replay_floor_seq=0` and `latest_seq=MAX(existing workspace seq)`. Every event append
advances `latest_seq` in the same transaction; any future compaction advances the floor
to at least the greatest removed sequence in the same transaction. An empty event table
therefore does not reset history to zero or turn an old cursor into a falsely complete
empty replay. The table is transport bookkeeping, not a workflow or conversation
authority.

The initial implementation does not delete control-plane events, so its floor remains
zero after migration. T5 still implements and tests the durable floor now because the
protocol cannot add correct retention later if clients already interpret “empty table” as
“complete history.” Direct event deletion without advancing this state is forbidden.

REST polling returns the window with its events. SSE sends
`control_plane_snapshot_required` with that window and closes. Local RPC returns the same
typed disposition as a normal subscribe result with no `subscriptionId`; snapshot
fallback is expected control flow, not a transport error. A complete SSE/RPC setup emits
or returns `control_plane_replay_ready` with the window so the client can distinguish a
proven empty replay from a connection that opened before replay finished.

Subscription setup registers a provisional live client that cannot flush yet, captures
`upperBoundSeq` from replay state, and queries matching rows in
`(requestedAfterSeq, upperBoundSeq]` with `limit + 1`. Global sequence gaps caused by
other workspaces or filtered domains are legal; completeness is based on the bounded
query and durable workspace floor, never numeric contiguity. An `afterSeq` above the
upper bound is `cursor_unavailable`; one below the retention floor is `retention_gap`;
an extra matching row is `window_exceeded`. On any of those dispositions, the server
unregisters the provisional client before returning the snapshot request.

For a complete setup, the server merges/de-duplicates replay rows with provisionally
buffered live rows by sequence. It delivers all matching rows through the captured bound,
then the explicit replay-ready boundary, then buffered rows above the bound before making
the client normally live. `nextAfterSeq` is the proven `upperBoundSeq`, even when a domain
filter returned zero rows. It is not merely the last matching row. Setup exceptions roll
back the provisional registration and leave no listener/response that later publication
can reach. REST uses the same bounded-query function without a live registration and
returns the same window semantics.

The provisional subscriber has an explicit three-phase lifecycle:

```text
PROVISIONAL
  live events may enqueue, but no heartbeat/event may flush
    -> SNAPSHOT_REQUIRED: emit/return typed disposition, close, unregister
    -> REPLAYING: deliver replay <= upperBound, then replay-ready boundary
         -> ACTIVE: drain buffered live > upperBound, enable timers/normal flush
         -> SETUP_FAILED: close, unregister, discard buffer
```

SSE owns the ordering directly on one response. RPC has an additional response-order
barrier: the listener registers and buffers first, the replay window is evaluated, and
the `controlPlane.subscribe` result is sent before replay/live notifications are allowed
to flush. A snapshot-required result contains no `subscriptionId` and retains no
listener. Any setup exception removes the listener before the JSON-RPC error is sent.
This prevents a client from receiving a notification for a subscription it has not yet
learned exists.

The Web state machine keeps separate `lastReceivedSeq` and `lastAppliedSeq` values. Receipt
only de-duplicates one connection; only successful canonical refresh advances
`lastAppliedSeq`. On refresh failure it closes the connection, discards the un-applied
buffer, resets receipt de-duplication to `lastAppliedSeq`, and reconnects from
`lastAppliedSeq`. A successful empty replay advances the applied cursor to the returned
`nextAfterSeq` only after the replay-ready boundary proves that no matching refresh was
required. It removes the current client-side 1000-row pagination loop because only the
server can prove replay completeness.

Snapshot handoff closes the old subscription, reads snapshot sequence `S`, establishes a
new provisional subscription after `S` while buffering its events, performs the
authoritative selected-Channel/runtime refresh covering `<= S`, and only then sets
`lastAppliedSeq = S` and drains buffered `> S` events. Subscribing after the refresh would
recreate the exact snapshot-to-live gap this protocol is intended to close.

Only `lastAppliedSeq` survives transport reconstruction within the mounted workspace.
Changing workspace/data root resets both cursors and performs a new snapshot handoff.
Neither cursor is a workflow checkpoint, and reconnect/snapshot code has no API that can
enqueue a Turn, Run, or workflow.

## Current Delta

This worktree already contains in-progress Continuity v2 foundations. The implementation
should preserve and finish them rather than restart the feature:

| Capability | Current worktree | Remaining work |
| --- | --- | --- |
| SQLite transaction composition | explicit standalone/joined append, TerminalReport, approval-resume, workflow/publication, and migration owner rollback are present; the official Node 22 transaction fault matrix passes 150/150 with same-connection recovery after every injected fault | retain the boundary through fresh packaged restart/reconnect acceptance |
| Thread -> Turn -> Item continuity and shared context projection | implemented in the active diff with targeted tests | retain and regression-test |
| Typed multi-operation execution plan and operation evidence | implemented and consumed by the shared delegated-outcome/gate path | retain and run the full regression matrix |
| Source-turn closure, TerminalReport publication, invalidation, and durable dispatch | semantic atomic barrier exists, its port binds only the explicit joined append, and TerminalReport plus legacy publication fault/reuse cases are green | regenerate the remaining deterministic and packaged recovery evidence |
| Explicit mention routing | canonical-id de-duplication, complete-inventory plain-text fallback, known-unavailable identity persistence, explicit-id-first executable selection, same-role preservation, and named-tool fail-closed behavior are implemented | retain the focused/full Daemon evidence and prove the corrected identity in a newly built package |
| Participant requirement | manifest, fingerprint, decision/workflow persistence, strict migration 114, identity equality, one shared operation-owner/required-tool derivation path, accepted-proposal reuse, and idempotent partial-lineage blocking are implemented | retain identity and blocker behavior through the final deterministic matrix and packaged acceptance |
| Participant execution profile | exact base/append prompts, approval profile, operation-derived tools, and typed participant authority now reach the Run; focused profile 3/3, atomic blocker 1/1, workflow operation/evidence 51/51 pass | retain the source correction in the broad matrix and rebuild before rerunning naked-ready |
| Delegated result | immutable requirements, the shared finalizer/reconciler, deterministic synthesis-packet preparation, typed context rejection, outcome-specific evidence refs, naked-`ready` rejection, no-linked-Run CAS, late-callback protection, and online/approval/startup tests are implemented | retain deterministic recovery and naked-`ready` coverage; exercise both in the packaged scenarios |
| Operation evidence | daemon-owned `exact_command | executable` policy is materialized separately from the model proposal and verified through structured `ExecutionAction`; labels are display-only and unsafe wrappers/chains fail closed | prove the exact packaged file + Node lineage |
| Migrations 113-118 | fresh/upgrade, recorded-version repair/sealing, conflict rollback, reopen/rerun, foreign-key, integrity, empty replay-floor, and approval-resume-basis fixtures are focused green | retain in the full Core regression matrix |
| Multi-Agent fan-in | unified five-state Completion Evaluation/read-set CAS, Engineer+QA, missing evidence, sealed synthesis packet, approval, duplicate callback, startup, late callback, and authority-class mutation tests are deterministic-suite green | exercise the real packaged Engineer+QA fan-in scenario |
| TerminalReport and source Turn | source status is Core-derived, partial lineage conflicts fail closed, blocked settlement stays resumable, both TerminalReport plus legacy publication use joined event append with owner rollback, and per-boundary fault/reuse assertions pass | run the remaining full source and fresh packaged matrices |
| Replay state and bounded window | migration 117, append watermark, durable floor/latest state, typed replay disposition, bounded `limit + 1` query, legal filtered gaps, and empty-table floor behavior are implemented; Core typecheck and 4/4 focused replay tests pass | retain in full Core/daemon recovery suites and packaged reconnect acceptance |
| SSE/RPC recovery | REST/SSE/RPC share the Core evaluator and coalesce/sort helper; provisional subscribers cannot flush early; RPC replies precede notifications; Web tracks received/applied cursors and uses subscribe-before-refresh snapshot handoff | retain recovery regressions and packaged reconnect acceptance |
| Turn transition observability | Core publication writes durable `turn` state transitions and Contracts/API accept the same entity type | retain real HTTP/SQLite lineage verification in the aggregate/package matrix |
| Typed shutdown and first approval resume | explicit cancellation/suspension/failure intent, immutable resume basis, same-Run replacement Attempt, exact bash evidence, unsupported-operation blocker, stale-attempt fencing, shared fan-in, and initial approval-wait suspension are deterministic Core/Daemon green | retain through packaged lifecycle verification |
| Atomic resume claim and startup classifier | claim transaction rollback tests passed 8/8; `resume_pending` recovery passed 7/7 for missing Attempt, pre-start replacement, effect-unknown, durable result, and second suspension; full Daemon regression passes | keep repair-only missing-Attempt support out of normal writers and verify the real packaged second-restart windows |
| Atomic resume suspension and terminal settlement | discriminated initial-wait/resume-pre-dispatch suspension, terminal/quarantine settlement, and direct-writer removal are implemented; 43/43 focused Core cases, Core 423/423, and Daemon 1026/1026 pass | retain the atomic boundary through packaged lifecycle acceptance |
| Runner capability and timeout semantics | typed capability resolution, Pi `nativeResume=false`, bounded bash continuation, and real hard-timeout failure reached focused-green checkpoints | retain and include in the aggregate deterministic rerun |
| Resume live projection | claim/suspend/finalize/block invalidations are transactionally returned; targeted Web reconnect replay and quarantine refresh pass; the test synchronization fix passes 5/5 focused and the aggregate Channel suite passes 116/116 | packaged reconnect proves the same projection; retain it in delivery evidence |
| Packaged macOS recovery | prior artifact proved identity/profile/authority/provider preflight, naked-ready, restart/fan-in, reconnect, and SQLite lineage | stale after source changes; build one new artifact and repeat all required scenarios |

The packaged recovery row has a concrete reproduced result. The isolated provider is
ready; ordinary conversation, long-context recall, and the file + Node one-step workflow
passed end to end. That execute Run carried `workflowStepId`, and the step, workflow,
TerminalReport, final Item, and source Turn converged through the shared completion path.
The multi-Agent manifest/fan-in gate preserved Engineer evidence
and failed closed. T8c.1-T8c.4 replaced shutdown-as-cancellation with typed stop intent,
durable approval suspension, and same-Run/new-attempt bash continuation. T8c.5a-c2 then
closed claim, both suspension shapes, terminal/quarantine settlement, startup
classification, direct-writer removal, ordinary replacement-Attempt capacity, and
reconnect projection. Those code paths and the earlier complete repository deterministic
matrix are green. T8d.2 then proved the accepted canonical mention could be replaced by
the first same-role teammate during single-step proposal construction. T8d.2a now
preserves explicit ids, shares operation ownership, keeps two same-role participants
distinct, fails closed for named tool gaps, and reuses accepted proposal lineage. The
partial-lineage structured blocker is now also implemented and full-Daemon green. The
earlier deterministic gates passed. The packaged T8d.2 attempt then exposed missing
execution-profile propagation. The focused source fix is now green, but the first broad
Channel run exposed the template-only membership heuristic. Both source corrections are
now present. That old artifact remains reproduction evidence only. A later artifact built
from the corrected, broad-green source completed provider preflight, naked-ready,
restart/fan-in, reconnect, and packaged GUI/SQLite acceptance; its hashes and final lineage
are recorded in the exact verification checkpoint and canonical Continuity v2 design.

The historical checkpoints below explain how the completed design was reached. They are
not current delivery gates. Existing unrelated WIP files still must not be reset,
reformatted wholesale, or replaced with a parallel framework.

Pre-amendment deterministic checkpoint: Contracts 40/40, Core 378/378, Daemon 990/990, API
Client 49/49, Web unit 47/47, Web lint/i18n, docs across 236 Markdown files,
licenses/public/dependency-security, recursive typecheck, Channel Playwright 116/116,
root build, and `git diff --check` are green. The earlier 14 Desktop Windows
`provider_lock_input_fence_contract_missing` failures reproduce on clean `origin/main`
and `apps/desktop` has no active diff, so they are recorded as an out-of-scope Windows
fixture baseline rather than hidden under an “all tests pass” claim. The packaged
ordinary-reply/recall scenario passed, but the file + Node scenario found the T8a
command-binding gap; no complete packaged-client result is claimed.

Current T8a checkpoint: the clean-break contract, daemon-owned selector materialization,
quote-aware matcher, and adversarial operation-evidence regressions are implemented.
The fresh deterministic matrix is green: Contracts 40/40, Core 378/378, Daemon
1011/1011, API Client 49/49, Web unit 47/47, Web lint/i18n, docs, licenses, public-safety,
dependency-security, serial root typecheck, root build, Channel E2E 116/116, and
`git diff --check`. The earlier `locked-task-continuation` timing failure did not recur in
the clean full Daemon rerun and is not classified as a product regression.

### Exact verification checkpoint

The current correction checkpoint is:

- official Node 22 control-plane storage passes 6/6, including standalone rollback,
  post-fault reuse, forbidden ambient auto-join, and caller-owned rollback;
- the original five-file Daemon reproduction passes 290/290 with zero failures and zero
  cancellations after explicit transaction ownership and owner rollback are applied;
- the focused transaction-owner/fault-recovery matrix passes 150/150, including
  TerminalReport, legacy publication, approval-resume, delegated-step, and workflow
  Completion Evaluation boundaries with a same-connection recovery write after faults;
- the full official Node 22 Core suite passes 429/429 and the Daemon suite passes
  1052/1052 twice with zero failures and zero cancellations;
- Contracts 41/41, API Client 49/49, Web 47/47, Channel E2E 116/116, repository
  typecheck/build/lint/i18n/docs/licenses/public/dependency-security checks, and the exact
  CI package/Web test aggregation are green;
- all packaged ZIP/DMG hashes produced before this source correction are stale.

The three Daemon cancellations had one root. The awaited segmentation deadline in
`context-segmentation-policy.ts` called `unref()` on its only timer. A stalled proposal
Promise and its abort listener do not keep Node alive, so the test process can resolve its
event loop before the timeout aborts the proposal. The stalled-proposal test is then
`cancelledByParent`; the next two tests in the file are only collateral cancellations.
The local fix keeps the timer referenced while `proposeWithDeadline()` awaits the race
and retains abort-on-timeout plus `clearTimeout()` in `finally`. The projector file now
passes 5/5 and both full Daemon runs pass 1052/1052. This was a Continuity liveness defect
discovered by the broad gate, not evidence that transaction contamination returned.

The reproduced pre-correction Node 22 checkpoint was:

- approval-policy focused tests passed 62/62;
- approval-policy plus control-plane focused tests passed 67/67;
- full Core passed 428/428 and `git diff --check` passed;
- full Daemon was red: 1041 total, 1014 passed, 24 failed, and 3 cancelled;
- the primary failure was `cannot start a transaction within a transaction` from
  TerminalReport/legacy publication event append, followed by connection contamination
  when an owner catch skipped rollback.

The prior semantic/source/package checkpoint was:

- Contracts 41/41, Core 427/427, and Daemon 1041/1041 are green after the final
  participant-binding, graph-coverage, operation-dependency, and accepted-Turn
  idempotency review fixes;
- terminal dispatch replay now reconstructs every source-linked assistant Item, failed
  delivery, reply dispatch, and auto-started workflow from durable state; migration 114
  unions operation ownership across every step owned by the same participant;
- API Client 49/49, Web 47/47, Channel E2E 116/116, typecheck, build, lint, i18n,
  docs, licenses, public-safety, dependency-security, and `git diff --check` are green;
- approval-resume recovery covers pre-`tool_start`, effect-unknown, durable `tool_end`,
  second suspension, and same-Run replacement without at-most-once violations;
- explicit participants, immutable provider bindings, workflow-definition authority,
  graph/step one-to-one coverage, dependency evidence, naked-ready blocking, JSON/SSE
  replay, and atomic TerminalReport/source-Turn publication are deterministic-suite green;
- the final isolated packaged macOS lineage proves three-fact recall, real file and Node
  actions, typed missing-provider blocking with zero Run/side effect, naked-ready blocking,
  Engineer + QA fan-in across daemon restart, reconnect without resubmission, one final
  report/Item/Turn settlement, and clean SQLite foreign-key/integrity checks;
- the packaged ZIP and DMG are locally signed but not notarized. `codesign --verify
  --deep --strict` passes; Gatekeeper distribution trust is explicitly outside this
  local acceptance artifact;
- the typed missing-workspace-default blocker still renders its body in English in the
  Chinese UI. Its code, owner, repair target, zero-workflow/Run/side-effect semantics,
  and restore path are correct; localization is a separate presentation follow-up;
- the repository-wide root test census retains one unchanged Windows-provider baseline
  failure outside the requested macOS scope. No `apps/desktop` source is changed by this
  slice, so the PR must report that exclusion instead of claiming every root test green.

These earlier results certify the semantic behavior of the artifact that produced them,
but they do not certify the current source. The Node 22 aggregate Daemon run now reaches
the same atomic publication paths and exposes `cannot start a transaction within a
transaction`. Until the active tail below is green, the old package hashes and GUI
evidence are reproduction evidence only.

The old fixed-1000 replay functions and one-cursor client loop are the reproduced T5
defects and have been removed rather than preserved as compatibility paths. T4's
sequential publisher has already been removed from manifest-backed workflow publication.

## What Already Exists And Is Reused

- Existing `RunSession`, runtime events, approvals, and `ExecutionAction` projection stay
  the attempt/evidence authorities. No delegated result table is added.
- Existing `ChannelWorkflow`, steps, workflow graph metadata, and termination policy stay
  the orchestration authority. The Completion Gate is a pure evaluator plus an audit
  snapshot, not another workflow engine.
- Existing WorkUnit CAS, leases, and startup recovery repair low-level process state.
  Manifest-backed semantic finalization moves to the daemon kernel that can read intent,
  graph, actions, packets, and reports.
- Existing WorkUnit/Attempt rows are extended as the Runtime fence authority: the
  `activeAttemptId` pointer, `runtimeInstanceId`, and `fencingToken` gate every mutable
  callback. Restart recovery replaces only the process Attempt under the same Run; it
  does not create a second workflow retry path.
- Existing TerminalReport records and final-result Items remain the publication authority.
  They consume completion truth and do not create it. Required-participant coverage is
  persisted separately from actual contribution summaries so missing required work stays
  visible without pretending an unstarted optional agent participated.
- Existing control-plane sequence log, replay, snapshot, and Web invalidation flow remain
  the reconnect mechanism. No polling service or SSE-owned state is introduced.
- Existing `SqliteControlPlaneStore` remains the only event/replay-watermark writer. The
  correction splits its transaction-owning and caller-joined capabilities; it does not
  add a new event store, queue, or publication table.
- Existing canonical Item mentions remain the participant identity authority. The fix
  changes selector precedence and proposal compilation; it does not add another roster,
  mention table, or participant store.
- Existing `RequiredParticipantManifestV1` remains the completion authority. It must be
  built from the resolved explicit ids before proposal/graph compilation rather than used
  to annotate whichever same-role teammate a later selector happened to choose.
- Existing Run request snapshots remain the execution-profile freeze point. T8d.2c fills
  their existing teammate prompt, approval, tool, provider, runner, workflow-step, and
  delegated-requirement fields; it adds no participant-profile table or migration.
- Migration 116 is a narrow authority hardening, not a compatibility layer: it adds sealed
  packet JSON/digests and publication-event idempotency needed for transactional verification.

## Target Data Flow

```text
accepted user Item
  -> canonical mentions
  -> durable channel_turn_dispatch
  -> one intent/delegation selector
       reply ---------------------> no-tools reply Run -> assistant Item
       execute/workflow_proposal -> resolve required participants once
                                      explicit ids first
                                      role/capability fallback only when none were named
                                   -> validate named availability/tools without substitution
                                   -> daemon materializes targets + command policy
                                   -> decision + RequiredParticipantManifest from resolved ids
                                      -> graph compiler equality check
                                      -> participant-to-Run profile adapter
                                           exact teammate id
                                           + base/append prompts
                                           + base approval profile
                                           + exact required-tool subset
                                      -> immutable Run request snapshot
                                      -> Agent Runs / ExecutionActions
                                      -> fenced Attempt callbacks
                                      -> DelegatedOutcome per required participant
                                      -> WorkflowCompletionGate
                                           participant coverage
                                           + operation evidence
                                           + dependency order
                                           + fanInPolicy
                                           + termination policy
                                      -> TerminalReport publication barrier
                                           required coverage rows + actual contributions
                                           one final_result publication only
                                      -> source LingTurn settled
                                      -> control-plane invalidation
```

## Remaining Implementation Order

The active tail uses the S3.5/S4/S5/S6 namespace defined above:

```text
S3.5 implemented hardening + full source closeout
  -> rebuild post-hardening artifact
      -> S4.1 naked-ready + missing-provider packaged blockers
          -> S4.2 Engineer + QA required fan-in and TerminalReport coverage
              -> S4.3 daemon restart checkpoint/no-checkpoint and Attempt-fence matrix
                  -> S4.4 SSE/RPC reconnect recovery and single publication
                      -> S5.1 packaged SQLite upgrade/reopen/rollback fixture
                          -> S5.2 canonical lineage audit
                              -> S6 review, PR, CI, merge, remote-main verification, exact cleanup
```

The earlier R9/R10 and T9.1-T9.5 labels remain below as implementation history. Their
prior package/lineage claims are superseded by this reopened tail; only S3.5 source
evidence plus S4/S5 evidence from the post-transaction-owner artifact can close delivery.

```text
R1 known-unavailable participant blocker [done]
  -> R2 immutable requirements + shared delegated finalizer/reconciler [focused green]
      -> R3 full CompletionEvaluation read-set CAS + migration 116 packet sealing [focused green]
          -> R4 atomic TerminalReport/source-Turn/publication-event barrier [focused green]
              -> R5 replay completeness + daemon/Web handoff [focused green]
              -> R6 full migration 113-118 verification [focused green]
                      -> R7 full deterministic suites [green]
                          -> R7H six review-hardening fixes + no-open-P1/P2 review [green]
                              -> R8a typed exact/executable command binding [focused green]
                                  -> R8V fresh aggregate deterministic matrix [green]
                                      -> R8b packaged multi-Agent restart reproduction [complete: P1 found]
                                          -> R8c.1-R8c.4 typed shutdown + first approval resume [focused green]
                                              -> R8c.5a atomic claim [focused checkpoint green]
                                                  -> R8c.5b resume_pending classifier + second-stop semantics [focused checkpoint green]
                                                      -> R8c.5c1 atomic resume suspend/finalize/block + quarantine [focused green]
                                                          -> R8c.5c2 initial approval-wait atomic suspension + direct-writer removal [deterministic green]
                                                              -> R8c.6a timeout/capability conformance [focused checkpoint green]
                                                                  -> R8c.6b replay/snapshot canonical resume projection [deterministic matrix green]
                                                                      -> R8d.2a explicit participant preservation [implemented; deterministic green]
                                                                          -> R8d.2b partial-lineage structured blocker [implemented; full-Daemon green]
                                                                              -> R8d.2c.1 participant execution-profile propagation [focused green]
                                                                                  -> R8d.2c.2 participant-authority provenance correction [implemented; broad source matrix green]
                                                                                      -> R8d.2d typed participant-provider preflight [implemented; full Daemon green]
                                                                                          -> R8d prior packaged macOS acceptance + SQLite audit [historical green]
                                                                                              -> R9 transaction-source/package revalidation [reopened]
                                                                                                  -> R10 final review, PR, CI, merge, remote-main verification, cleanup [pending]
```

R1-R6 are focused green, the earlier R7 deterministic matrix is green, and R7H has closed the six
review findings with narrow and affected broad reruns. The first R8 artifact passed
ordinary reply and recall, then exposed the command-plan false-negative. R8a fixed that
typed boundary, and R8V refreshed the complete deterministic evidence after the final
docs/code state. R8b proved file + Node and single-Agent completion, then reproduced the
pending-approval restart P1. T8c.1-T8c.4 fixed the first lifecycle collapse. T8c.5a-b
reached focused checkpoints for atomic claim and second-crash classification. T8c.5c1
moved resumed suspension, terminal settlement, and quarantine behind atomic store APIs.
T8c.5c2 closes the initial approval-wait suspension, removes the last coordinator direct
writer, preserves ordinary capacity gates, and is now focused plus full Core/Daemon
regression green. T8c.6a is focused green for typed capability and hard timeout; T8c.6b
is repository-matrix and packaged-reconnect green. T8d.2a fixed the reproduced
explicit-participant substitution and passed its affected deterministic gates. T8d.2b
closed the partial existing-proposal crash window and passed 2/2 focused plus 1033/1033
full Daemon tests. The final Web/root matrix was green, but the packaged T8d.2 reproduction
showed the Run request lacked the selected teammate's profile. T8d.2c.1 now passes focused
profile, blocker, and evidence gates. T8d.2c.2 is source-complete, and T8d.2d has added
the typed provider-binding preflight. The fixture, late-race cases, full 1041-test Daemon
suite, fresh artifact, naked-ready blocker, required Engineer + QA restart/fan-in,
reconnect, and canonical SQLite audit were green for the prior artifact. R9 now closes
the newly observed transaction-composition defect and regenerates that evidence before
R10 delivery.

Suggested review-sized commits after implementation and verification:

1. Continuity contracts/migrations, canonical mention, and unavailable-participant materialization;
2. shared delegated-step finalizer plus full graph completion evaluation/read-set CAS;
3. atomic TerminalReport/source-Turn/invalidation publication barrier;
4. control-plane replay completeness and Web snapshot-handoff regressions;
5. typed command-match policy and verification-only fixes;
6. typed daemon suspension and approval resume;
7. participant execution-profile/authority and typed provider-preflight correction;
8. fresh isolated packaged macOS acceptance and SQLite lineage evidence.

Commit/PR/merge work begins only after S5.2 revalidation passes. The user has already
authorized delivery for this branch, so no additional routine approval gate is required after verification;
destructive cleanup still follows normal exact-target checks.

## Implementation Tasks

This is the active delivery order from the current source. The earlier T9.* rows are
retained immediately below as historical source-closeout evidence, not as open release
phases:

| Task | Status | Priority | Effort (human / Codex) | Concrete change | Depends on | Exit evidence |
| --- | --- | --- | --- | --- | --- | --- |
| S3.5 | complete | P1 | verified | Retain migration 121, Runtime snapshot v23 and full Attempt fence CAS, closed delegated-outcome binding/codes, required coverage, and one terminal projection | S3 | Contracts 46/46, Core 444/444, and Daemon 1090/1090 pass; diff review finds no fence or publication bypass |
| S4.1 | complete on current artifact | P1 | verified | Fresh packaged naked-ready and missing-provider blockers; no ready-text completion, no partial workflow/Run | S3.5 | typed blocker lineage, zero side-effect/workflow counts, one source-Turn settlement |
| S4.2 | complete on current artifact | P1 | verified | Engineer + QA required fan-in and TerminalReport required-coverage projection; no callback-count quorum or duplicate terminal card | S4.1 | every required participant has a typed outcome/evidence or negative row; one final report/Item/Turn |
| S4.3 | partial | P1 | packaged runtime | Restart matrix with no checkpoint, safe approval checkpoint, pre/post `tool_start`, and stale old-callback fencing | S4.2 | ordinary daemon restart/replay is green; no-checkpoint/effect-unknown windows remain |
| S4.4 | complete on current artifact | P1 | verified | SSE/RPC reconnect and snapshot/replay recovery from `lastAppliedSeq` | S4.3 | refresh-before-cursor, no resubmit, unchanged Run/report/Turn counts, one terminal publication |
| S5.1 | open | P1 | ~2h / ~15m plus fixture | Packaged old-schema upgrade through migrations 119-121, injected rollback, same-connection reopen, foreign-key/integrity checks | S4.4 | no leaked transaction, half-publication, or migration lineage mismatch |
| S5.2 | complete for current happy path | P1 | verified | Audit canonical Thread/Turn/Item/decision/manifest/graph/Run/Attempt/action/outcome/gate/report/event lineage | S5.1 | all ids/fingerprints/statuses agree; no cancellation impersonation or duplicate event |
| S6 | pending | P1 | ~2h / ~15m plus CI | Review and precisely stage only this slice, create PR, wait for CI, merge, verify actual remote-main merge commit, and clean exact QA resources | S5.2 | PR merged, remote `main` contains the verified commit, protected WIP and production Ling remain untouched |

The table below is historical Continuity v2 work retained for traceability. Its completed
rows are not substitutes for S4/S5 revalidation.

The historical behavior rows were P1 because each closed a required boundary in the same
correctness chain. T7f was P2 cleanup that removed dormant competing paths in the same
branch. Inline pipeline diagrams should be kept
next to the non-obvious transaction/state logic in the Core workflow store,
TerminalReport publication store, daemon reconciliation kernel, control-plane event hub,
and Web cursor/snapshot hook; composition modules should link to those owners instead of
duplicating the diagrams.

| Task | Status | Priority | Effort (human / Codex) | Concrete change | Depends on | Exit evidence |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | complete | P1 | ~2h / ~15m | Persist known-unavailable requested participant ids in accepted dispatch and commit exactly one `participant_unavailable_in_channel` blocker through normal dispatch | none | Core replay, worker lineage, HTTP, and SSE `ready -> blocked` tests pass |
| T2 | complete (focused) | P1 | ~1d / ~1h | Migration 115, immutable step requirements, shared finalizer/reconciler, deterministic synthesis packet preparation, typed context-rejection outcome, and canonical trigger routing | T1 | migration 6/6, delegated completion 21/21, agent context 5/5, and direct Contracts/Core/Daemon typechecks pass |
| T3 | complete (focused) | P1 | ~1d / ~1h | Migration 116 packet sealing/event idempotency, five-state `WorkflowCompletionEvaluationV1`, complete backing-row read-set CAS, paginated Run watermark, and removal of the success-only/negative side paths | T2 | Core/Daemon typechecks, migration 8/8, completion/fan-in/CAS 29/29, context 5/5, old API search empty, and diff check pass |
| T4 | complete (focused) | P1 | ~1d / ~1h | Focused workflow TerminalReport publication store revalidates fresh evaluation, derives compatible report/Turn outcome, validates deterministic committed Item lineage, and writes report marker, source-Turn transition or blocked settlement audit, state event, and unique durable invalidation in one transaction | T3 | Core/Daemon typechecks plus 26/26 success/blocked/failed/cancelled, crash injection, restart, incompatible outcome/Turn, partial-lineage conflict, duplicate, and legacy-barrier tests pass |
| T5 | complete (focused) | P1 | ~1d / ~1h | Migration 117, shared REST/SSE/RPC replay evaluator, provisional no-flush/activation, RPC response-order barrier, received/applied Web cursors, buffered snapshot handoff, setup cleanup, and stale query fencing | T4 | Core replay 4/4, Daemon API/event-hub 24/24, API Client 49/49, Web parser 2/2, Web recovery E2E 3/3, and Daemon/Web typechecks pass |
| T6 | complete (focused) | P1 | ~3h / ~20m | Verify migrations 113/114/115/116/117 on fresh DB, upgrade, reopen/rerun, recorded-version repair/sealing, conflict rollback, `foreign_key_check`, and `integrity_check` | T3-T5 | aggregate migration/control-plane store suite passes 14/14; no runtime dual reader exists |
| T7 | complete | P1 | ~1d / ~1-2h | Classify the aggregate Windows-only Desktop red light against clean `origin/main`; run complete Contracts/Core/Daemon/API Client/Web tests, lint/i18n, docs/licenses/public/security checks, builds, and Channel E2E | T2-T6 | required macOS/shared deterministic gates are green; the excluded Windows failure has clean-main baseline and no-diff evidence |
| T7a | complete | P1 | ~2h / ~15m | Make plain-text mention fallback resolve against the complete known teammate inventory and preserve unavailable ids | T7 | metadata-free `；@QA` HTTP/SSE tests persist the canonical mention and return one unavailable blocker |
| T7b | complete | P1 | ~3h / ~25m | Extend step-finalization input/store CAS to model `linked_run` versus `no_linked_run` atomically | T7 | startup and explicit reconciliation change a running step with `run_id IS NULL` to typed blocked; concurrent Run linkage yields stale/retry |
| T7c | complete | P1 | ~2h / ~15m | Extract one SSE/RPC queue coalesce-and-sort helper and preserve global sequence order | T7 | a queue with 400 provisional events and a later preserved terminal event emits globally increasing unique sequences |
| T7d | complete | P1 | ~1h / ~10m | Propagate `StateEntityType="turn"` through Contracts and the daemon route allowlist | T7 | real HTTP query for the publication/source-Turn transition succeeds and matches SQLite |
| T7e | complete | P1 | ~2h / ~15m | Require exact structured command evidence and platform-correct canonical path matching | T7 | `echo node app.js` cannot satisfy `node app.js`; POSIX case mismatch fails while Windows case folding remains valid |
| T7f | complete | P2 | ~1h / ~10m | Remove the unused post-publication Turn closer and unreachable manifest-backed legacy finalization branch/imports | T7a-T7e | symbol search proves one publication closer and one manifest-backed finalizer; affected orchestrator tests remain green |
| T7g | complete | P1 | ~3h / ~30m plus suite runtime | Re-run affected broad gates and complete a second full-diff authority/security/privacy review | T7a-T7f | no open P1/P2 findings; Contracts/Core/Daemon/Web/Channel/root build and diff check are green |
| T8a.1 | complete | P1 | ~2h / ~15m | Add `CommandMatchPolicyV1`, split model proposal validation from durable-plan validation, require daemon-created target refs, and reject missing/extraneous policy fields with no compatibility default | T7g | Contracts 40/40 covers exact, executable, target-ref authority, forbidden placement, malformed value, cycle, and clean-break rejection |
| T8a.2 | complete | P1 | ~3h / ~25m | Replace string-only command extraction with daemon-owned exact/executable materialization; keep display labels non-authoritative and clarify when neither identity is bounded | T8a.1 | `Node 调用...` persists executable `node`; explicit `node app.js` persists exact command; discussion-only Node remains reply |
| T8a.3 | complete | P1 | ~3h / ~25m | Centralize quote-aware command matching and make operation evidence dispatch by the typed policy | T8a.1 | `node -e '...; ...'` matches executable; echo/wrapper/prefix/chaining/redirection/substitution/unrelated commands fail closed; exact remains exact |
| T8a.4 | complete | P1 | ~3h / ~30m plus suite runtime | Complete the aggregate verification of the new selector/evidence/end-to-end regressions | T8a.2-T8a.3 | Contracts 40/40, Core 378/378, Daemon 1011/1011, API Client 49/49, Web 47/47, lint/i18n, docs/security, serial typecheck, build, Channel E2E 116/116, and diff check pass |
| T8b | complete as discovery | P1 | packaged runtime | Exercise the fresh isolated macOS client through ordinary continuity, file + Node, single Agent, and required Engineer+QA restart | T8a.4 | file + Node and single Agent passed; restart at QA pending approval reproduced cancellation ownership bug while fan-in remained fail-closed |
| T8c.1 | complete (focused) | P1 | ~3h / ~25m | Replace untyped active-run `cancelAll()` with explicit cancel, runtime suspend, and runtime failure intents; map daemon stop to suspension and timeout to failure | T8b | shutdown regression preserves Run/approval and writes no cancellation; explicit cancel remains terminal; typed intent registry is green |
| T8c.2 | complete (focused) | P1 | ~4h / ~35m | Bind `ApprovalRequest` to the existing `LingApprovalCheckpoint` with immutable resume basis and exact side-effect fingerprint through migration 118 | T8c.1 | fresh/reopen/integrity and immutable basis/revision CAS tests are green |
| T8c.3 | complete (focused) | P1 | ~1d / ~1h | Add an approval-resume coordinator that marks the old attempt lost, preserves the same logical Run/step/manifest/evidence, and starts one fenced replacement attempt after approval using bounded Ling continuation | T8c.2 | same Run gains a new `WorkUnitAttempt`; stale old callbacks are ignored; unsupported write fails closed without a side effect |
| T8c.4 | complete (focused) | P1 | ~4h / ~40m | Route resumed bash evidence through the existing delegated finalizer and Completion Gate | T8c.3 | resumed `ExecutionAction` evidence plus Engineer+QA required fan-in tests are green |
| T8c.5a | focused checkpoint green | P1 | ~3h / ~25m | Commit approval-resume claim/re-claim atomically across checkpoint, old/new Attempts, Run, work unit, runtime audit, and invalidations | T8c.4 | 8/8 claim and fault-injection cases leave no partial lineage |
| T8c.5b | focused checkpoint green | P1 | ~3h / ~30m | Scan `resume_pending` on startup and classify missing Attempt, pre-`tool_start`, effect-unknown, durable `tool_end`, and second suspension without duplicate execution | T8c.5a | 6/6 recovery cases pass and the command executes at most once |
| T8c.5c1 | focused green | P1 | ~4h / ~35m | Compose atomic resumed suspension and verified terminal/block storage through `SqliteRunStore`; add checkpoint-only corrupt-lineage quarantine; publish only returned post-commit events | T8c.5b | focused claim/suspension/terminal/quarantine and fault-injection cases pass; corrupt lineage never terminalizes a guessed Run; semantic reconciliation converges after a post-commit crash |
| T8c.5c2 | complete; focused + full Core/Daemon green | P1 | ~3h / ~25m | Make suspension a discriminated `approval_wait | resume_pre_dispatch` lifecycle, route initial pending/approved graceful stop through it, remove `markPriorAttemptLost()` direct writes, and retain ordinary capacity acquisition before `tool_start` | T8c.5c1 | Core/Daemon builds pass; 43/43 focused Core, 423/423 full Core, and 1026/1026 full Daemon pass; initial-wait/fault rollback, illegal cross-products, writer ownership, and capacity lifecycle are covered |
| T8c.6a | focused checkpoint green | P1 | ~2h / ~20m | Conformance-gate runner resume capability and prove a real orchestrator hard timeout fails rather than cancels | T8c.5b | Pi cannot claim native resume; decorative metadata without adapter operation is ineffective; timeout Run/work-unit/Attempt all fail with `hard_timeout` |
| T8c.6b | complete; deterministic + packaged reconnect green | P1 | ~2h / ~20m | Retain transactional suspend/finalize/block/quarantine invalidations and prove replay/snapshot reload of canonical resume progress/result/blocker | T8c.5c2, T8c.6a | disconnected-client E2E and the packaged open GUI converge without resubmitting work |
| T8d | complete; packaged macOS + SQLite green | P1 | ~1d / ~1-2h plus package runtime | Close provider-preflight regressions, rebuild one fresh macOS artifact, and complete packaged acceptance in one isolated lineage | T8c.5c2, T8c.6b | T8d.1-T8d.4 evidence passes; codesign integrity and SQLite integrity are green |
| T8d.1 | complete | P1 | packaged runtime | Verify ordinary conversation, long-context recall, and a single-participant file + Node execute request | T8c.6b | provider is ready; earliest facts are recalled; Run has `workflowStepId`; file/action evidence, one-step workflow, one TerminalReport, final Item, and source Turn all succeed without a second user turn |
| T8d.1r | complete | P1 | ~2h / ~20m | Add a deterministic single-participant convergence regression around the real terminal callback and startup recovery | T8d.1 | online callback test proves acknowledgement stays non-terminal and one report settles the Turn; startup/duplicate publication reuses the same ids; focused pair 2/2 and workflow operation suite 50/50 pass |
| T8d.2a | complete; affected deterministic gates green | P1 | ~3h / ~30m | Preserve canonical explicit participant ids before role/capability fallback; share operation ownership, keep same-role multi-mentions distinct, block named tool failures without substitution, and reuse accepted proposal lineage | T8d.1r | 4/4 participant, 4/4 adjacent Channel, 50/50 workflow-operation, and 1031/1031 Daemon tests pass; named custom Agent remains identical from Item through Run |
| T8d.2b | complete; focused + full Daemon green | P1 | ~2h / ~20m | Convert existing-proposal-without-compatible-decision/manifest from a raw throw into one durable structured blocker and normal source-Turn settlement | T8d.2a | 2/2 selector/JSON/SSE regressions and 1033/1033 Daemon tests pass; no Run, side effect, reselection, duplicate blocker, or failed dispatch |
| T8d.2c.1 | complete; focused green | P1 | ~3h / ~30m | Bind custom teammate base/append prompts and approval profile in the shared step-start adapter, enforce manifest assignee equality and exact required tools, and verify FakeRunner plus persisted Run snapshot | T8d.2b | profile 3/3, atomic pre-Run blocker 1/1, and workflow operation/evidence 51/51 pass; internal selector/report Runs are unchanged |
| T8d.2c.2 | complete; broad source matrix green | P1 | ~3h / ~30m plus suite runtime | Replace the template-only membership exception with explicit `WorkflowParticipantAuthorityV1`; persist migration 119, assign trusted origins atomically at every compiler path, and validate authority/participant fingerprints | T8d.2c.1 | proposal out-of-Channel blocks; handoff/custom/compaction/scheduling/fan-in run when active/visible/tool-eligible; invalid/late/forged provenance produces a typed blocker |
| T8d.2c.3 | complete; focused + broad source green | P1 | ~2h / ~20m plus suite runtime | Freeze participant binding at the store/API boundary; remove participant reassignment from PATCH; centralize final tool resolution and strictest approval merge across manual, automatic, retry, resume, and direct start | T8d.2c.2 | reassignment/mismatch fails before Task/Run; missing `requiredTools` yields `[]`; teammate/Channel/Skill gates cannot widen; start paths share effective snapshots |
| T8d.2c.4 | complete; broad source green | P1 | ~2h / ~20m plus suite runtime | Restore broad source gates and run authority-class, tool-ceiling, approval-equivalence, fan-in, and migration regressions before packaging | T8d.2c.2-T8d.2c.3 | Contracts 41/41, Core 426/426, Daemon 1036/1036 plus typecheck/build/static gates pass |
| T8d.2d | complete; deterministic + packaged blocker green | P1 | ~4h / ~35m plus packaged setup | Close typed effective-model resolution and shared proposal/step provider preflight with deterministic late-race, frozen-override, restart-snapshot, repaired-retry, and JSON/SSE idempotency coverage | T8d.2c.4 | missing default produces one repair blocker with zero workflow/Run/side effect; configured pair freezes exact provider bindings |
| T8d.2 | complete; packaged blocker green | P1 | ~1h / ~10m plus provider runtime | Force a required Agent to return naked ready/promise text without a tool or sealed packet | T8d.2d plus refreshed deterministic matrix | zero tool actions/approvals; finalizer emits one typed missing-evidence blocker; source Turn is blocked |
| T8d.3 | complete; packaged restart/fan-in green | P1 | ~3h / ~30m plus restart/runtime | Run required Engineer + QA fan-in; restart while QA waits for bash approval, then approve after restart | T8d.2 | same Run/approval/step/manifest survive; Attempt 1 is lost, Attempt 2 succeeds; both evidence refs verify fan-in exactly once |
| T8d.4 | complete; packaged reconnect/SQLite green | P1 | ~2h / ~20m plus runtime | Reconnect across Desktop daemon restart and audit the final SQLite lineage | T8d.3 | client converges without resubmit; one final Item/report/source-Turn settlement; no cancellation impersonation or skipped participant |
| T9 (historical delivery lane) | superseded by active S6 | P1 | ~2h plus CI / ~20m plus CI | Re-run final pre-landing review, commit intentional files, push/create PR, wait for CI, merge, verify remote `main`, and clean exact QA resources | T8d.4 | Historical only; current delivery must pass S3.5/S4/S5, then close through S6 |

### T8a file and responsibility map

The slice crosses the existing contract/runtime/test boundaries plus one focused helper.
This is larger than a local patch because the bug spans declaration, materialization, and
verification. Collapsing those responsibilities into the selector or weakening the gate
would reduce file count but recreate duplicate authority.

| Responsibility | Files | Change |
| --- | --- | --- |
| Durable type | `packages/contracts/src/conversation-continuity.ts` | export the policy union; add it to durable operations |
| Durable validation | `packages/contracts/src/conversation-continuity-validation.ts` | require daemon target refs, require/forbid policy by kind and target, and keep graph validation and strict-key rejection |
| Contract regression | `packages/contracts/test/conversation-continuity-v2.test.mjs` | valid exact/executable plus malformed, missing, misplaced, and legacy-without-policy cases |
| Command policy helper | new `packages/daemon/src/features/channels/command-operation-match.ts` | own allowlist, exact/executable materialization, quote-aware simple-command parsing, and policy matching |
| Model/daemon boundary | `packages/daemon/src/features/channels/channel-intent-selector.ts` | parse a non-authoritative model shape, derive policy from accepted text, clarify when no bounded identity exists |
| Selector integration | `packages/daemon/test/channel-workspace.test.mjs` | cover Node natural language, explicit exact command, discussion-only Node, and persisted policy |
| Evidence gate | `packages/daemon/src/features/channels/workflow-operation-evidence.ts` | stop reading target labels as command truth; call the shared matcher and retain clean action/outcome checks |
| Evidence regression | `packages/daemon/test/workflow-operation-evidence.test.mjs` | cover positive exact/executable and every fail-closed adversarial form |
| Persisted fixture alignment | affected Core/Daemon fixtures found by `rg 'kind: "run_command"' packages` | add explicit policy to durable fixtures; do not add a production fallback |

No SQLite column or schema migration is required because the operation plan is stored as
typed JSON. Clean-break validation still changes the accepted JSON shape. Fresh packaged
QA uses a new data root, and repository fixtures are updated deliberately; existing local
development rows are not silently upgraded.

Implementation must be test-first at the two reproduced boundaries:

1. Add the failing selector regression proving `Node 调用...` persists
   `{ kind: "executable", executable: "node" }` instead of exact `Node`.
2. Add the failing evidence regression proving that policy accepts the packaged
   `node -e '...'` command and rejects `echo node ...` plus top-level chaining.
3. Implement the contract and helper, then make selector and evidence consume them.
4. Add the remaining negative matrix and update durable fixtures.
5. Run focused tests, then the affected broad matrix, then build/package from the exact
   verified source.

### T8c file and responsibility map

T8c reuses existing runtime and approval authorities. It adds one focused coordinator;
it does not add a new Run status, workflow engine, approval table, or evidence store.

| Responsibility | Files | Change |
| --- | --- | --- |
| Typed stop intent | `packages/daemon/src/runtime/active-runs.ts` | replace `cancelAll()` with explicit cancel/suspend/fail operations and carry the stop intent to the Run completion path |
| Run terminal mapping | `packages/daemon/src/features/runs/orchestrator.ts`, `packages/daemon/src/features/runs/cancellation.ts` | reload canonical state; only explicit cancellation calls `ensureRunCancelled`; runtime suspend preserves Run/approval and timeout becomes typed failure |
| Durable approval checkpoint | `packages/core/src/approval-checkpoints.ts`, approval-checkpoint SQLite facet/mappers | persist a typed resume basis in the existing checkpoint JSON, including exact side-effect and delegated-requirement fingerprints; add CAS/idempotent status transitions |
| Runtime recovery | `packages/daemon/src/runtime/supervisor.ts`, `packages/core/src/storage/sqlite/runtime-recovery-coordinator.ts` | mark old attempt lost/release leases, exempt valid pending checkpoints from stale-Run failure, and order resume registration before Channel semantic reconciliation |
| Resume owner | new `packages/daemon/src/features/runs/approval-resume-coordinator.ts` | validate checkpoint basis, consume the decision once, create a new fenced attempt for the same Run, or emit typed resume blocker |
| Atomic resume claim | `packages/core/src/storage/sqlite/approval-resume-store.ts` composed by `SqliteRunStore` | revision-CAS checkpoint, fence old Attempt, insert replacement Attempt, activate Run/work unit, append runtime audit and durable invalidation in one transaction |
| Atomic approval suspension/terminal | `packages/core/src/approval-checkpoints.ts`, `packages/core/src/run-types.ts`, `packages/core/src/storage/sqlite/approval-resume-store.ts`, and `packages/core/src/storage/sqlite-run-store.ts` | expose discriminated initial-wait/resume-pre-dispatch suspension plus verified-lineage/quarantine terminal inputs; atomically preserve or settle checkpoint, Run, work unit, active Attempt, Task, resources, audit, and invalidations without importing Channel semantics |
| Resume crash classifier | `packages/daemon/src/features/runs/approval-resume-coordinator.ts` plus existing Run/Attempt/event stores | scan `resume_pending`; decide retry/finalize/block from the bound attempt and canonical tool-event phase; never re-execute an unknown side effect |
| Resume capacity | `packages/daemon/src/features/runs/concurrency.ts`, `packages/daemon/src/features/runs/approval-resume-coordinator.ts`, and startup recovery | after claim, reacquire ordinary Run leases and replacement-Attempt semaphore slots before `tool_start`; every suspension/terminal/startup-repair path releases them through the owning transaction/recovery phase |
| Runner capability | runner registry metadata plus `packages/runner-pi/src/metadata.ts` | declare `native_resume`, bounded `host_approval_continuation` action types, or `none`; Pi explicitly declares no native resume |
| Workflow wake-up | `packages/daemon/src/features/channels/workflow-reconciliation.ts` | treat resume completion/blocking as another canonical-state wake-up; keep the existing delegated finalizer and Completion Gate unchanged |
| Live projection | approval-resume coordinator composition plus existing control-plane event hub | publish only events returned by successful claim/suspend/terminal transactions; append idempotent content-free invalidations for resume claim/start/suspend/finalize/block; clients reload snapshots rather than trusting event payloads |
| Desktop/daemon regression | daemon runtime tests plus focused Desktop daemon-lifecycle tests | Desktop restart suspends active attempts; explicit Run/workflow cancellation remains terminal and attributable to the user/policy |

#### T8c.5c1-c2 exact implementation sequence

1. Retain the completed Core composition in `packages/core/src/storage/sqlite-run-store.ts`:
   - `commitApprovalResumeSuspension()` and `commitApprovalResumeTerminal()` remain exposed
     through `RunStore`;
   - Task transition, Run-resource lease, Attempt semaphore, runtime audit, and
     control-plane ports stay inside the same database connection;
   - callers publish only the committed events returned by these methods.
2. Tighten both lifecycle inputs as discriminated unions:
   - suspension accepts only `approval_wait` with `pending/approved +
     waiting_for_approval`, or `resume_pre_dispatch` with `resume_pending + running`;
   - `verified_lineage` requires checkpoint revision/status, Run/work-unit expected
     states, and the active Attempt fence;
   - `checkpoint_quarantine` requires a typed lineage-integrity reason and cannot accept
     Run/work-unit/Attempt target states;
   - both return committed invalidations or a typed stale/lineage conflict.
3. Finish coordinator writer removal in
   `packages/daemon/src/features/runs/approval-resume-coordinator.ts`:
   - initial graceful shutdown calls `approval_wait` suspension;
   - `suspendAttemptBeforeToolStart()` calls the atomic suspension method;
   - `finishRun()` prepares the summary projection, calls the verified-lineage terminal
     method, publishes returned events, then wakes semantic reconciliation;
   - `failResume()` uses verified-lineage terminal blocking when ownership is valid and
     checkpoint quarantine when it is not;
   - replace `markPriorAttemptLost()` with ordered startup repair or the same atomic
     suspension CAS; remove duplicate direct Attempt/resource writes.
4. Preserve ordinary concurrency enforcement after claim:
   - call `prepareRunConcurrency()` and `acquireRunRuntimeSemaphores()` before
     `tool_start`;
   - a capacity failure is a typed pre-dispatch failure/suspension and cannot execute the
     approved tool;
   - startup and atomic suspension release any acquired Run leases/Attempt slots before a
     replacement Attempt retries.
5. Add Core fault-injection tests for every suspension and terminal write class:
   checkpoint, Run, work unit, Attempt, Task, runtime audit, resource release, and each
   control-plane domain. Assert the entire old snapshot survives every injected failure.
6. Extend daemon recovery tests for:
   - initial pending approval graceful stop preserving checkpoint/Run/work unit while
     losing the Attempt and releasing capacity;
   - post-terminal-commit crash before delegated finalization;
   - required QA evidence absent at resume claim/suspension and present only after valid
     terminal evidence;
   - effect-unknown and unsupported/corrupt-lineage blockers;
   - duplicate callback/startup reconcile returning the same lineage.
7. Retain control-plane/Web coverage that disconnects across claim, suspension, success,
   and blocker commits, then proves replay or snapshot reloads canonical state before the
   applied cursor advances.
8. Re-run Core and Daemon builds first, then the focused matrix, aggregate deterministic
   matrix, and only then the isolated packaged macOS acceptance. The deterministic matrix
   is now green; do not rerun it merely to compensate for missing packaged evidence.

The implementation order is test-first:

1. Reproduce `daemon stop -> abort -> ensureRunCancelled -> approval_cancelled` in a
   daemon test and assert the desired preserved rows.
2. Split stop intent and make explicit cancellation/timeout/shutdown tests pass before
   adding resume.
3. Persist and reopen the approval checkpoint resume basis; prove mismatch and duplicate
   decision paths fail closed.
4. Start a replacement attempt under the same Run, fence the old attempt, and feed the
   result through the existing delegated finalizer/gate. [focused green]
5. Keep the focused-green atomic claim/suspension/terminal/quarantine transactions, make
   suspension shapes discriminated, and replace the remaining initial-wait/direct-lost
   coordinator writes.
6. Retain transaction fault injection for suspension and terminal settlement; add the
   initial pending-approval rollback matrix. After commit,
   wake the existing semantic reconciler and prove a crash before that wake is recovered
   without another tool execution.
7. Keep typed runner capability, ordinary capacity acquisition, and real timeout behavior;
   retain suspend/finalize/blocker reconnect coverage through SSE replay and snapshot
   handoff.
8. Run the focused restart matrix, then the complete deterministic matrix, then T8d's
   fresh packaged acceptance.

### T8d.1r single-participant convergence regression

This is a test-first guard over existing ownership, not a new runtime service. Start with
`packages/daemon/test/channel-workspace.test.mjs` and reuse the real accepted-turn,
proposal compiler, workflow Run, terminal callback, TerminalReport, and source-Turn
paths. Touch `channel-turn-dispatch-executor.ts`, `orchestrator.ts`, or the report
coordinator only if the regression exposes a real missing wake-up.

1. Submit a one-participant Channel `execute` request and assert the accepted decision has
   one required participant, the workflow has one required step, and its Run persists the
   same `workflowStepId`.
2. While the runner is active, assert the acknowledgement Item is committed with
   renderable delivery status but the source Turn remains non-terminal and no
   TerminalReport is published.
3. Finish the Run with canonical file/command evidence and await the real terminal
   callback. Assert exactly one `DelegatedOutcomeV1`, verified Completion Evaluation,
   TerminalReport, final Item, source-Turn settlement, and publication invalidation.
4. Repeat with a crash checkpoint after Run/work-unit terminal persistence but before the
   semantic callback. Reopen the store/start the daemon and assert startup reconciliation
   produces the same final ids without another model/tool execution.
5. Assert reconnect and an unrelated later user Turn are not completion triggers: the
   first lineage must already be settled before either occurs.

Exit: the short `Run=succeeded` / `Turn=running` observation window can exist only while
the shared callback or startup reconciliation is actively converging; it can never become
a durable terminal state or make the acknowledgement look like the task result.

### T8d.2a explicit participant preservation correction

Status: implemented and affected deterministic gates are green. This is a
selector/compiler ownership fix. It reuses canonical Item mentions and the existing
required-participant manifest; it does not add a participant table, another manifest, or
model-authored teammate ids.

Module boundaries:

```text
channel-mention-materializer.ts
  owns accepted canonical ids and availability snapshot
          |
          v
channel-intent-selector.ts
  resolveExecutableParticipants()
    explicit ids -> exact ordered id set
    no explicit ids -> existing role/capability/Ling fallback
  validate named participant availability/tools without substitution
  choose one-step vs multi-participant compiler from cardinality
          |
          v
proposal-workflows.ts / workflow graph compiler
  consume decision manifest; never select participants again
          |
          v
workflow completion/fan-in
  unchanged; verify the preserved manifest and evidence
```

Implementation order is test-first:

1. Add a regression in `packages/daemon/test/channel-workspace.test.mjs` with a custom
   active Engineer that has the same role and required tool scope as the built-in
   Engineer. Submit a structured mention plus file + Node execute request. Assert the
   accepted Item mention, decision `selectedTeammateIds`, manifest, proposal assignee and
   collaboration step, workflow metadata/graph step, delegated requirement, and Run all
   use the custom id. Assert the built-in Engineer appears nowhere in that lineage. Run
   the test before editing and retain the failing result as reproduction evidence.
2. Extract one internal participant-resolution helper in
   `channel-intent-selector.ts`. It reads only canonical `sourceMessage.mentions`; if one
   or more teammate ids exist, it resolves that exact id-ordered, id-de-duplicated set.
   Existing role/capability and Ling Agent fallback runs only when the explicit set is
   empty. The model does not supply ids.
3. Validate every explicitly selected teammate after identity resolution. Channel
   unavailability produces `participant_unavailable_in_channel`; missing required tools
   produces `participant_required_tools_unavailable`. Persist the named participant and
   blocked proposal/decision; do not search for a replacement.
4. Keep the existing one-step proposal path only for one resolved participant. For two or
   more explicit ids, invoke the existing multi-participant proposal/graph compiler with
   the complete set. De-duplicate by id, never role. If the operation plan cannot be
   partitioned safely, return
   `participant_operation_assignment_incomplete` before any workflow Run or side effect.
5. Remove participant re-selection from the `existingProposal` idempotency path. Reuse
   the original source decision/manifest/proposal lineage. Missing or inconsistent
   lineage fails closed as `existing_proposal_participant_lineage_invalid`; roster order
   or capability changes cannot rewrite an accepted retry.
6. Add deterministic cases for no-explicit fallback, explicit custom-versus-built-in,
   explicit participant missing a tool, explicit unavailable participant, duplicate
   mention ids, two distinct same-role mentions, and existing-proposal retry after roster
   order changes. Each case asserts both positive identity equality and absence of silent
   substitution/side effects.
7. Run focused Channel tests, the complete Daemon suite, relevant Contracts/Core
   manifest/compiler suites, typecheck/build, and `git diff --check`. Then rebuild the
   isolated macOS artifact; the old artifact cannot verify the correction.
8. Recreate the naked-ready participant in the fresh QA database and rerun T8d.2. Only
   after the decision, manifest, graph, and Run all name that participant may the
   delegated-outcome blocker result count as valid T8d.2 evidence.

Exit: explicit participant identity is stable from accepted Item through Run; same-role
fallback never replaces it; named capability failures are visible blockers; multi-mention
requests preserve every id or block before execution; idempotent retry does not reselect.

Implementation evidence: the original regression was run red and selected
`teammate_builtin_engineer` instead of the explicitly mentioned custom id. The corrected
path passes 4/4 participant regressions, 4/4 adjacent Channel regressions, 50/50 workflow
operation/evidence tests, Daemon typecheck/build, and 1031/1031 full Daemon tests. The
selector and proposal compiler now share `workflow-operation-ownership.ts`, and auto-start
decisions preserve the manifest's `selectedTeammateIds` on success and blocker paths.

### T8d.2b partial existing-proposal lineage blocker

Status: implemented; 2/2 focused and 1033/1033 full Daemon tests are green. This was the
final deterministic recovery hardening before the package rebuild. Proposal
creation and decision persistence are separate writes in the current store composition,
so a crash can leave an accepted source Turn with a proposal whose compatible decision
or participant manifest is absent. The current raw
`existing_proposal_participant_lineage_invalid:<proposalId>` throw fails closed on side
effects but fails open on product lifecycle: the transport may return 500 while the Turn
remains unsettled.

Implementation order:

1. Add a fixture that persists an accepted Item/Turn and proposal, omits or corrupts the
   compatible decision/manifest, then re-enters both single-step and multi-participant
   selector paths after simulated restart.
2. Replace the throw with one typed selector result carrying
   `existing_proposal_participant_lineage_invalid`; do not infer participant ids from the
   proposal, current roster, roles, or capabilities.
3. Route the result through the existing durable blocker Item and source-Turn settlement
   path. Derive its idempotency identity from the source Turn/proposal so duplicate retry
   produces the same blocker.
4. Assert zero workflow, Run, approval, tool call, and external side effect; assert the
   original proposal remains audit-visible and no replacement decision/manifest is
   fabricated.
5. Assert JSON and SSE return compatible structured blocked projections rather than an
   unstructured 500, and startup retry returns the same Item/Turn ids.
6. Run the focused Channel cases, full Daemon suite, then the remaining Web unit/lint/i18n,
   root docs/security/typecheck/build checks, Channel E2E, and `git diff --check`.

Exit: partial proposal lineage is visible, fail-closed, idempotent, and recoverable; no
accepted Turn depends on a transport exception for terminalization.

### T8d.2c participant execution-profile propagation

Status: source implementation and the pre-T9 packaged acceptance were complete for this
slice. The earlier packaged T8d.2
proved the Item, decision, manifest, workflow, step, and Run all retained PromiseBot's
canonical id while its Run snapshot omitted `systemPrompt`, `appendSystemPrompt`, and
`approvalProfile`. The source adapter now propagates those fields. Profile coverage passes
3/3, the atomic pre-Run blocker passes 1/1, workflow operation/evidence passes 51/51, and
the participant-authority broad matrix returned to green.

The first broad Channel run was 205/213 because it exempted Channel membership only when
`teammateTemplateId` existed and `sourceProposalId` did not. The source correction now
classifies handoff, custom graph, context compaction, parallel/serial/smart scheduling,
dependency-mode, and fan-in assignments through typed workflow-definition authority.
Their missing membership rows are not participant unavailability.

The authority decision is resolved in favor of the long-term contract. The
`!sourceProposalId` rule is retained only as historical context and is not used as a
permission fact. The implementation persists explicit authority, makes provenance atomic,
freezes participant binding, makes final tools fail-closed, and merges approval policy in
the shared adapter. This closes all five seams identified by the independent review
without adding a second participant or completion authority.

Implemented source sequence and remaining package gate:

1. [done] Add migration 119 and strict mappers/store invariants for the explicit authority JSON;
   reject invalid, unknown, mismatched, or authority-less new rows.
2. [done] Pass a trusted origin from every compiler path and create graph, steps, authority,
   manifest, and source references atomically. Do not repair proposal provenance after
   insertion.
3. [done] Remove public participant reassignment fields and add a Core CAS regression for
   metadata PATCH, retry, stale callback, and concurrent update attempts.
4. [done] In `workflow-participant-run-profile.ts` plus the shared run-policy helper, apply
   authority-specific membership, exact teammate/tool checks, `requiredTools ?? []`,
   strictest approval merge, and one adapter for manual/automatic/retry/resume/direct
   start. Preserve inactive, hidden, missing-profile, assignee-override, and tool-shrink
   negative coverage.
5. [done] Add a table-driven authority-origin regression covering proposal, built-in/custom
   template, handoff, custom graph, compaction, scheduling, fan-in, external work, plan,
   manual, and legacy rows. Assert exact participant/profile continuity and no
   substitution. Rebuild Daemon, rerun the eight failing Channel cases, then the complete
   Channel suite with a 213/213 target, full Core/Daemon, and typecheck/build gates.
6. [done] Rebuilt a fresh signed macOS artifact after the T8d.2d regressions and broad
   deterministic matrix were green. Packaged naked-ready produced zero tool actions and
   approvals, then settled through one typed missing-evidence blocker and one blocked
   source Turn. The same artifact completed restart/fan-in/reconnect and SQLite audit.

During step 6, re-query the earlier denied setup lineage. If its Run is terminal but the
workflow/source Turn remain non-terminal after recovery, treat that as a separate P1
`approval_decision` reconciliation defect: add a focused denial regression and route the
durable decision through `reconcileWorkflowFromCanonicalState()`. Do not clear or reuse
the stale rows as acceptance evidence, and do not fold denial recovery into prompt
profile logic.

Exit: the requested participant's identity and actual execution profile both reach the
same immutable Run snapshot; tools remain least-privilege; internal control-plane Runs do
not inherit participant persona; proposal membership remains fail-closed; workflow-defined
participants are not falsely rejected; and the packaged no-tool Agent reaches the
existing naked-`ready` blocker path without a test-specific prompt workaround.

### T8d.2d participant model-binding preflight

Status: complete in source and packaged acceptance. Focused Contracts/Core cases, the
full 1041-test Daemon suite, package builds, late-race/restart cases, and typed blocker
projection are green. The
first post-rebuild Engineer + QA proposal correctly preserved both participants and
operations but did not create a workflow because neither workspace-default participant
resolved a provider. The raw `Either providerPresetId or provider is required` blocker
proved that validation happened too late and without product semantics. It never
authorized falling back to the Channel Ling Agent model.

Implementation order:

1. Keep the Core-owned typed `EffectiveConversationModelResolutionV1` and the ownership
   matrix: Channel Ling Agent -> Channel model, built-in specialist -> workspace default,
   fixed teammate -> fixed model, and private request override only on its private surface.
2. Keep the daemon preflight service as the sole readiness authority for existence,
   enabled state, chat/required capabilities, secrets, and last successful check; UI checks
   remain advisory.
3. Keep proposal-time preflight over the complete accepted participant manifest before
   graph, workflow, Task, Run, approval, or tool creation. Failures persist one structured
   `workflow_participant_provider_unavailable` blocker with owner and repair target.
4. Keep provider id plus binding source in immutable graph/step metadata and the Run
   request snapshot. Revalidate only at first Run creation; same-Run restart/resume reuses
   the snapshot, while repaired retry creates a new snapshot.
5. Finish the remaining deterministic cases: late provider unavailability before first
   Run, frozen override rejection, same-Run restart after settings change, explicit repaired
   retry, and idempotent JSON/SSE retry. First fix the test's undefined `projectionFor`
   fixture helper; it currently fails before product preflight executes.
6. Re-run the fresh packaged matrix only after the fixture and full source gates are green.
   The QA harness must explicitly set `defaultProviderPresetId` when it creates a provider
   through the daemon API because that bypasses the real first-provider product flow.

Required deterministic cases:

| Case | Expected result |
| --- | --- |
| Engineer/QA `workspace_default`, workspace default missing, Channel Ling Agent model present | typed workspace-owned blocker; no workflow, Run, approval, or action; no Channel-model fallback |
| Engineer/QA `workspace_default`, workspace default runnable | both graph steps freeze the workspace provider and binding source |
| fixed teammate plus workspace-default teammate | each keeps its own binding owner; no cross-participant fallback |
| provider disabled/deleted after proposal preview but before confirmation | proposal blocks before graph creation |
| provider becomes unavailable after confirmation but before first Run | exact step blocks before Run; required participant remains in fan-in |
| same-Run daemon restart/approval resume after provider setting changes | original Run snapshot remains authoritative |
| explicit repaired retry | new resolution is visible in a new graph/Run snapshot |
| JSON/SSE retry of the same blocked proposal | same proposal/blocker lineage; no duplicate Item or source-Turn settlement |

Exit: provider ownership is deterministic and source-linked; missing configuration is
actionable; no low-level constructor error reaches the Channel; no provider fallback can
change participant or model ownership; and configured Engineer + QA execution reaches the
existing evidence/fan-in/restart acceptance path.

### Verification order

```text
focused implementation
  T1 Channel acceptance tests [green]
    -> shared finalizer + recovery equivalence tests (T2) [green]
      -> full gate CAS + fan-in + packet integrity tests (T3) [green]
        -> TerminalReport publication tests (T4) [green 26/26]
          -> control-plane replay-state/window tests (T5 Core) [green 4/4]
            -> daemon transport + Web reconnect/snapshot-handoff tests (T5) [green]
        -> full migration and SQLite integrity checks (T6) [green 14/14]
          -> full Contracts/Core/Daemon/API Client/Web/build/Channel suites (T7) [green]
            -> review hardening + affected broad reruns (T7a-T7g) [green]
              -> typed command-plan materialization + matching (T8a.1-T8a.3) [green]
                -> aggregate deterministic recheck (T8a.4/R8V) [green]
                  -> packaged multi-Agent restart reproduction (T8b) [P1 found]
                    -> typed shutdown + first approval resume (T8c.1-T8c.4) [focused green]
                      -> atomic claim + resume_pending classifier (T8c.5a-b) [focused checkpoint green]
                        -> atomic resume suspend/finalize/block + rollback (T8c.5c1) [focused green]
                          -> initial approval-wait suspension + direct-writer removal (T8c.5c2) [deterministic green]
                            -> timeout/capability (T8c.6a) [focused checkpoint green]
                              -> replay/snapshot canonical resume projection (T8c.6b) [deterministic matrix green]
                                -> explicit participant preservation (T8d.2a) [implemented; affected deterministic green]
                                  -> partial existing-proposal lineage blocker (T8d.2b) [implemented; full-Daemon green]
                                    -> participant execution-profile propagation (T8d.2c.1) [focused green]
                                      -> participant-authority provenance correction (T8d.2c.2) [implemented; broad source matrix green]
                                        -> participant model-binding preflight (T8d.2d) [complete; full Daemon green]
                                          -> refreshed deterministic matrix [complete]
                                            -> fresh isolated packaged macOS GUI and SQLite audit (T8d) [complete]
                                              -> explicit transaction ownership + rollback (T9.1-T9.2) [complete]
                                                -> Node 22 deterministic matrix (T9.3-T9.4) [complete]
                                                  -> fresh macOS package + lineage acceptance (T9.5) [historical ledger]
                                                    -> review / PR / CI / merge / cleanup (T10) [historical ledger]
```

Do not start packaged QA while any deterministic gate/recovery test fails. A package that
appears correct once cannot prove restart or fan-in safety.

### T7 deterministic command matrix

Run from the isolated worktree and record each result independently:

```text
corepack pnpm --filter @ling-stack/contracts test
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/web test
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm check:docs
corepack pnpm check:licenses
corepack pnpm check:public
corepack pnpm check:dependency-security
corepack pnpm build
corepack pnpm --filter @ling-stack/web test:e2e -- e2e/channel.spec.ts
git diff --check
```

Then run the remaining relevant Desktop/macOS suites needed by the package scripts. The
aggregate `corepack pnpm -r test` is still useful as a repository census, but it is not a
binary gate when a platform-specific suite is red: classify every failure by platform,
clean-main reproducibility, active diff ownership, and whether the failing contract is
shared with macOS. A Windows-only baseline exclusion must appear in the PR verification
section with its exact failing command and reason; it must never be rewritten as “all
tests pass.”

### File-level execution checklist

1. T3 focused checkpoint [complete]:
   - define completion target/event mappings in the Core workflow store and connect its
     new decision/Run/event/approval/artifact ports through `SqliteRunStore`;
   - update `workflow-completion.ts` and `workflow-reconciliation.ts` to use the new
     evaluation API; delete the negative side path;
   - run Core and Daemon typechecks, then audit `orchestrator.ts`, `workflows.ts`, Core
     recovery, and TerminalReport pre-publication for residual direct success shortcuts.
2. T3 completion CAS and packet sealing [complete]:
   - finish and test the started migration 116 for nullable sealed packet JSON/SHA-256
     plus unique publication-event idempotency; seal legacy workflow packet rows only
     after typed ownership validation;
   - finish the started Core `WorkflowCompletionEvaluationV1` complete canonical read-set
     and gate projection/backing-row collection;
   - replace `commitVerifiedChannelWorkflowCompletion()` and
     `reconcileNegativeWorkflowStatus()` with one transactional evaluation commit;
   - add store race/tamper fixtures for every authority class and daemon fan-in recovery
     fixtures for pending, verified, blocked, failed, and cancelled results.
3. T4 publication [complete; focused green]:
   - add a focused Core `SqliteTerminalReportPublicationStore` and
     `commitTerminalReportPublication()` using within-transaction Item/Turn/state-event/
     control-plane helpers;
   - derive target Turn status from the Completion Evaluation and validate the report
     outcome plus deterministic committed Item envelope inside Core;
   - add the `settle_blocked` publication audit path without widening the normal
     `LingTurnTransitionEvent` state machine or making blocked immutable;
   - reduce `terminal-report-publisher.ts` to validation, one store call, and post-commit
     hub notification;
   - remove the separate durable event append/list-query dedupe path; make coordinator
     startup/duplicate publication reuse the returned lineage;
   - keep standalone Run/Turn reports explicitly outside the workflow Completion
     Evaluation barrier, and give reporting-disabled manifest workflows an equivalent
     source-Turn/invalidation barrier before deleting the legacy helper.
4. T5 replay [complete; focused green]:
   - migration 117 and Contracts/Core types now define replay
     disposition, durable workspace replay-state floor/latest watermark, upper bound,
     and next cursor;
   - replay state now initializes from existing rows, advances latest on every append,
     preserves floor/latest across an empty event table, and requires future deletion or
     compaction to advance the floor in the same transaction;
   - make REST/SSE/RPC consume the Core bounded `limit + 1` evaluator; implement
     explicit ready/snapshot results, provisional no-flush/activation, RPC subscribe
     response ordering, and setup cleanup;
   - update `use-control-plane-invalidation.ts` to separate received/applied cursors,
     remove the unprovable 1000-row pagination loop, and buffer `> S` while snapshot
     refresh applies;
   - add daemon event-hub/RPC tests and Web E2E for refresh failure, ahead cursor,
     overflow, retention floor, domain-filter gaps, and snapshot-to-live events.
5. T6 migrations [complete; focused green]:
   - verify migration 113 recorded-version repair plus migrations 114-117 on fresh,
     upgraded, reopened, conflicting, foreign-key, and integrity fixtures.
6. T7 verification [complete]:
   - classify the Windows Desktop fixture failure against clean `origin/main`, then run
     required package typechecks/unit/integration/E2E/build and the full diff review.
7. T8a typed command binding [complete; aggregate recheck green]:
   - the durable command-match union now keeps the model-facing proposal shape separate
     from the host-materialized execution plan;
   - discriminated exact/executable intent plus quote-aware canonicalization/matching
     replaces string-only command extraction;
   - operation evidence ignores display labels and dispatches only by the stored policy;
     exact/executable/adversarial regressions and the aggregate matrix are green.
8. T8b packaged verification [complete as discovery]:
   - file + Node and single-Agent execution passed with canonical evidence;
   - required Engineer + QA fan-in preserved Engineer evidence and refused false success;
   - restart at QA's pending approval reproduced the untyped shutdown/cancellation bug.
9. T8c.1-T8c.4 runtime suspension and first approval resume [focused green]:
   - explicit cancellation, runtime suspension, and timeout/crash failure are typed;
   - migration 118 persists/reopens the immutable approval resume basis;
   - same-Run replacement Attempt, exact bash evidence, unsupported-operation blocker,
     stale callback fencing, and shared Completion Gate fan-in are green.
10. T8c.5a-b and T8c.6a crash/capability checkpoints [focused green]:
   - atomic claim rollback passed 8/8;
   - `resume_pending` recovery/second-stop classification passed 6/6 with at-most-once execution;
   - typed runner capability, resumed Engineer + QA fan-in, and real hard timeout passed focused checks.
11. T8c.5c1 and T8c.6b atomic settlement/projection [focused/targeted green]:
   - atomic suspension, terminal/block, and checkpoint quarantine are composed through
     `SqliteRunStore` and publish only committed returned events;
   - fault injection covers claim/suspension/terminal/quarantine write boundaries;
   - startup reconciliation proves post-terminal-commit fan-in recovery;
   - targeted SSE replay reloads canonical resume result/blocker and quarantine state.
12. T8c.5c2 initial approval-wait suspension [deterministic green]:
   - loose expected-status fields are replaced by the discriminated suspension lifecycle;
   - graceful shutdown of a pending/approved wait uses one atomic transaction;
   - `markPriorAttemptLost()` direct Attempt/slot writes are removed;
   - capacity reacquisition before `tool_start` and release on suspension, terminal, and
     startup-repair paths are covered;
   - focused Core 43/43, full Core 423/423, and full Daemon 1026/1026 pass.
13. T8d fresh packaged verification [complete]:
   - exact artifact launch, isolated roots, signing, executable path, and resource-root
     checks are complete;
   - the Keychain-backed provider, ordinary conversation, long-context recall, and
     one-step file + Node execution are complete;
   - callback/startup convergence is covered by the focused 2/2 regression and the 50/50
     workflow-operation suite;
   - the first naked-ready setup reproduced explicit custom-Engineer substitution by the
     same-role built-in Engineer before execution;
   - T8d.2a is now affected-deterministic green with stable Item-to-Run identity, shared
     operation ownership, same-role preservation, named-tool blockers, and proposal reuse;
   - the next packaged T8d.2 attempt kept the correct participant id but proved the actual
     Run request dropped the teammate base/append prompts and approval profile;
   - T8d.2c/T8d.2d corrected profile and provider binding, the final 1041-test Daemon suite
     passed, and the rebuilt artifact completed naked-ready, missing-default zero-side-effect,
     restart/fan-in, reconnect, and final SQLite audit without touching the production Ling
     process.

### Workstream ordering

The correctness spine stays sequential in one worktree because finalization, gate,
report, and recovery share contracts and SQLite composition. Test execution can fan out,
but code edits remain coordinated in the current isolated worktree; a second worktree
would create more conflicts than useful concurrency across the current large WIP.

| Lane | Work | Modules | Starts after |
| --- | --- | --- | --- |
| A | T4 publication/source Turn barrier [complete] | Contracts, Core SQLite stores, daemon Channel orchestration | T3 focused green |
| B | T6 migration fresh/upgrade/reopen/integrity verification [complete] | Core migrations/tests | T3 migration 116 and T5 migration 117 are fixed |
| C | T5 daemon transport and Web cursor/snapshot handoff [complete] | daemon transport, Web invalidation/E2E | T4 publication event shape and T5 Core replay evaluator are fixed |
| D | T8a contracts -> selector materialization -> evidence matcher -> deterministic reruns | Contracts and daemon Channel intent/evidence/tests | A+B+C merged and T7 matrix green |
| E | T8c.1-T8c.4 typed shutdown + first checkpoint resume [focused green] | daemon runtime, Core approval checkpoints, workflow wake-up | D green and T8b reproduction captured |
| F | T8c.5a-b/T8c.6a claim, classifier, capability, timeout [focused checkpoint green] | Core SQLite, daemon runtime, runner metadata, focused tests | E focused green |
| G | T8c.5c1/T8c.6b atomic resume settlement and live projection [focused/targeted green] | Core SQLite, daemon resume coordinator, control plane, focused tests | F checkpoint |
| G2 | T8c.5c2 initial approval-wait suspension, direct-writer removal, and capacity proof [deterministic green] | Core SQLite, daemon run orchestrator/resume coordinator/runtime recovery, focused and full Core/Daemon tests | G checkpoint |
| H0 | T8d.2a explicit participant preservation + affected deterministic rerun [complete] | daemon Channel selector/compiler/tests | G2 green and packaged reproduction captured |
| H1 | T8d.2b partial-lineage blocker + final deterministic refresh [complete] | daemon Channel selector/dispatch/tests plus Web/root gates | H0 green |
| H2 | T8d.2c participant execution-profile + authority correction [complete] | daemon Channel workflow adapter, authority store, tests | broad source matrix green |
| H3 | T8d.2d provider-preflight fixture and late-race regressions [complete] | Contracts/Core/Daemon model binding, proposal/step adapters, tests | full Daemon and provider cases green |
| H4 | T8d fresh packaged macOS scenarios [complete] | isolated artifact/runtime, GUI, SSE, SQLite | artifact, restart/fan-in/reconnect, and lineage green |
| I | T9.1-T9.2 explicit transaction ownership, wiring, rollback, and fault injection [complete] | Core SQLite control-plane/publication/workflow/recovery stores | H4 historical evidence plus Node 22 reproduction |
| J | T9.3-T9.4 focused and broad deterministic verification [complete] | Core, Daemon, API, Web, repository gates | I green |
| K0 | S3.5 Runtime fence/outcome/coverage/terminal-projection aggregate verification [complete] | Contracts, Core Runtime/SQLite, daemon finalizer/gate, TerminalReport/Web | J green and hardening implemented |
| K1 | S4.1 naked-ready and missing-provider packaged blockers [complete on current artifact] | isolated artifact/runtime, GUI, daemon finalizer | K0 green |
| K2 | S4.2 Engineer + QA fan-in and required coverage [complete on current artifact] | workflow gate, TerminalReport, GUI, SQLite | K1 green |
| K3 | S4.3 daemon restart checkpoint/no-checkpoint and Attempt fencing [partial] | Runtime Control Plane, approval resume, GUI, SQLite | K2 green |
| K4 | S4.4 SSE/RPC reconnect and one terminal publication [complete on current artifact] | replay transport, Web, SQLite | K3 green |
| K5 | S5.1-S5.2 packaged SQLite upgrade/reopen and canonical lineage [partial] | Core migrations/stores, packaged data root, audit | K4 green |
| K6 | S6 review/PR/CI/merge/remote-main/cleanup [pending] | repository delivery and exact QA resources | K5 green |

Lanes A-C are complete, D is green, T8b captured the packaged failure, E/F/G/G2 are
green, and H0-H4 are historical completed work. K0 -> K1 -> K2 -> K3 -> K4
-> K5 -> K6 is the active sequential tail. No second implementation worktree is recommended because the current edits share
the same SQLite composition root and failure-contaminated connection.

## Test Coverage Map

```text
NODE 22 TRANSACTION COMPOSITION                         PACKAGED USER FLOWS
standalone control-plane append                         delegated execution
  ├── [TEST EXISTS] success + monotonic replay state      ├── [HISTORICAL] naked ready blocks
  ├── [VERIFIED T9.1] replay-state fault rolls back all rows ├── [REVERIFY] real action evidence completes
  └── [VERIFIED T9.1] never ambient-auto-joins            └── [REVERIFY] final Item/Turn publishes once

caller-owned aggregate transaction                     multi-Agent/recovery
  ├── [DONE IN WIP] TerminalReport uses joined append     ├── [REVERIFY] all required participants gate fan-in
  ├── [DONE IN WIP] approval-resume uses joined append    ├── [REVERIFY] restart keeps same Run/new Attempt
  ├── [DONE IN WIP] publication/workflow owners roll back └── [REVERIFY] SSE reconnect does not resubmit work
  ├── [VERIFIED T9.2] every fault proves next transaction starts
  ├── [VERIFIED T9.3] official Node 22 full Core 429/429
  └── [VERIFIED T9.3] referenced segmentation deadline + official Node 22 full Daemon zero-cancelled rerun

CRITICAL REGRESSION: a nested `BEGIN IMMEDIATE` or skipped rollback can leave the shared
connection inside a transaction. One failure then contaminates later requests/tests and
can prevent TerminalReport, fan-in, and recovery convergence. T9.1-T9.3 are release gates,
not optional hardening.

ACTIVE S4/S5 ACCEPTANCE MATRIX
fresh post-S3.5 packaged artifact
  ├── S4.1 [PASS] naked `ready` -> typed blocker; missing provider -> zero workflow/Run/side effect
  ├── S4.2 [PASS] Engineer + QA -> both required coverage rows before verified fan-in
  ├── S4.3 [PARTIAL] no checkpoint -> typed interruption; safe checkpoint -> same Run/new fenced Attempt
  │             ├── before `tool_start` -> one retry
  │             ├── `tool_start` without `tool_end` -> effect-unknown, never retry
  │             └── after `tool_end` -> finalize existing evidence once
  ├── S4.4 [PASS] SSE/RPC reconnect -> lastAppliedSeq refresh/replay, no resubmit/publication duplicate
  ├── S5.1 [OPEN] old SQLite fixture -> migrations 119-121 -> rollback/reopen/integrity checks
  └── S5.2 [PASS*] canonical Thread/Turn/Item/Run/Attempt/evidence lineage matches final report

*S5.2 is green for the current happy-path artifact; it does not close S5.1's upgrade and
rollback requirement.*

ACCEPTANCE / AVAILABILITY
accepted Item + canonical mentions
  ├── [TARGETED EXISTS] alias/text de-duplication
  ├── [VERIFIED T1] known inactive/hidden/out-of-Channel -> one typed blocker
  └── [VERIFIED T1] HTTP/SSE retry -> same blocker identity

PARTICIPANT PROFILE -> RUN
manifest-backed workflow step
  ├── [VERIFIED T8d.2c.1] exact teammate base prompt reaches FakeRunner and Run snapshot
  ├── [VERIFIED T8d.2c.1] teammate append prompt precedes Skill/source/memory fragments
  ├── [VERIFIED T8d.2c.1] teammate + workflow gate + Skill/session approval merge is fail-closed
  ├── [VERIFIED T8d.2c.1] Run tools equal the required operation subset, not teammate allowance
  ├── [VERIFIED T8d.2c.1] assignee override and post-compile tool shrink block without a Run
  ├── [VERIFIED T8d.2c.1] manual start, auto orchestration, and retry share one adapter
  ├── [VERIFIED T8d.2c.2] proposal-backed out-of-Channel participant blocks without a Run
  └── [VERIFIED T8d.2c.2] workflow-defined handoff/custom/compaction/scheduling/fan-in participant runs without membership

PARTICIPANT MODEL BINDING -> GRAPH / RUN
accepted required participant set
  ├── [EXISTING CONTRACT] Channel Ling Agent -> Channel Ling Agent model
  ├── [EXISTING CONTRACT] built-in Engineer/QA -> workspace default; fixed teammate -> fixed model
  ├── [VERIFIED T8d.2d] missing workspace default -> typed participant/owner/repair blocker, no graph or Run
  ├── [VERIFIED T8d.2d] configured mixed bindings -> graph/step provider id + binding source snapshot
  ├── [VERIFIED T8d.2d] provider readiness/capability race -> pre-Run blocker, no fallback
  ├── [VERIFIED T8d.2d] same-Run restart/resume -> original immutable binding snapshot
  └── [VERIFIED T8d.2d] repaired retry -> explicit new binding snapshot and idempotent projection

DELEGATED STEP FINALIZATION
terminal Run candidate
  ├── [VERIFIED T2] execution actions satisfy required operations
  ├── [VERIFIED T2] naked final text -> delegated_outcome_missing
  ├── [VERIFIED T2] post-step approval/startup/duplicate callback use same finalizer
  ├── [VERIFIED T2] late callback reloads the currently linked retry Run
  ├── [VERIFIED T2] synthesis restart reuses one deterministic output packet
  └── [VERIFIED T2] stale/private context -> typed delegated blocker

WORKFLOW COMPLETION / FAN-IN
source decision + manifest + immutable graph + steps + evidence
  ├── [TARGETED EXISTS] missing graph branch cannot verify
  ├── [VERIFIED T3] Engineer + QA both required
  ├── [VERIFIED T3] pending/verified/negative results use one transactional gate
  ├── [VERIFIED T3] active required participant remains pending; absent/blocked cannot succeed
  ├── [VERIFIED T3] every authority-class mutation fails the CAS
  ├── [VERIFIED T3] required packet row needs valid sealed JSON/SHA-256
  └── [VERIFIED T3] cached verified gate conflicts with canonical rows

PUBLICATION / SOURCE TURN
fresh compatible gate basis
  ├── [TARGETED EXISTS] successful report path
  ├── [VERIFIED T4] stale basis refuses success publication
  ├── [VERIFIED T4] report/evaluation outcome mismatch rolls back
  ├── [VERIFIED T4] arbitrary or mismatched final Item envelope rolls back
  ├── [VERIFIED T4] crash at every publication write boundary leaves all-or-nothing lineage
  ├── [VERIFIED T4] duplicate callback publishes one Item/event lineage
  ├── [VERIFIED T4] partial pre-existing lineage becomes typed conflict
  └── [VERIFIED T4] source LingTurn settles once, including already-blocked audit

LIVE PROJECTION
terminal_report.published durable event
  ├── [TARGETED EXISTS] live-before-replay ordering and failure cleanup
  ├── [TARGETED EXISTS] received event waits for canonical refresh before applied cursor
  ├── [VERIFIED T5 CORE] empty event table preserves a non-zero durable replay floor/latest watermark
  ├── [VERIFIED T5 CORE] ahead/retained/overflow windows return typed disposition
  ├── [VERIFIED T5 CORE] legal domain/workspace numeric gaps remain complete
  ├── [VERIFIED T5] cursor advances only after canonical refresh applies
  ├── [VERIFIED T5] RPC response precedes replay/live notifications
  ├── [VERIFIED T5] snapshot handoff buffers events committed after S
  └── [VERIFIED T5] reconnect never resubmits the accepted Turn

T7 REVIEW HARDENING
canonical boundaries missed by the first green matrix
  ├── [VERIFIED T7a] plain-text unavailable mention without submitted metadata
  ├── [VERIFIED T7b] running delegated step whose run_id is NULL
  ├── [VERIFIED T7c] preserved high-seq event mixed with coalesced lower-seq events
  ├── [VERIFIED T7d] HTTP state-transition query for entityType=turn
  ├── [VERIFIED T7e] command substring and POSIX case-mismatch false evidence
  └── [VERIFIED T7f] dead source-Turn/manifest-backed completion helpers removed

COMMAND PLAN MATERIALIZATION / EVIDENCE
accepted executable request -> durable operation -> ExecutionAction
  ├── [VERIFIED T8a.1] durable command operation requires a typed policy
  ├── [VERIFIED T8a.2] `Node 调用...` -> executable `node`
  ├── [VERIFIED T8a.2] explicit `node app.js` -> exact command
  ├── [VERIFIED T8a.2] discussion-only runtime mention -> reply, no operation
  ├── [VERIFIED T8a.3] quote-aware `node -e '...; ...'` -> executable match
  ├── [VERIFIED T8a.3] echo/wrapper/prefix/chaining/redirection/substitution -> no match
  ├── [VERIFIED T8a.3] exact policy remains full-command equality
  └── [VERIFIED T8b PACKAGED] file create -> approved Node action -> verified workflow/report

RUNTIME SUSPENSION / APPROVAL RESUME
pending side-effect approval under a required participant
  ├── [REPRODUCED T8b, FIXED T8c.1] daemon stop formerly called cancelAll and cancelled Run/approval
  ├── [VERIFIED T8c.1] typed explicit cancel vs runtime suspend; timeout intent registry
  ├── [VERIFIED T8c.2] durable approval checkpoint resume basis and fingerprint CAS
  ├── [VERIFIED T8c.3] same Run + new fenced WorkUnitAttempt after approval
  ├── [VERIFIED T8c.3] unsupported write blocks without executing a side effect
  ├── [VERIFIED T8c.4] stale old-attempt callback ignored
  ├── [VERIFIED T8c.4] resumed evidence -> delegated outcome -> required fan-in gate
  ├── [FOCUSED CHECKPOINT T8c.5a] atomic claim plus 8/8 rollback injection
  ├── [FOCUSED CHECKPOINT T8c.5b] resume_pending recovery and second-stop 6/6; command at most once
  ├── [VERIFIED T8c.5c1] resumed suspension rollback across checkpoint/Attempt/resources/audit/events
  ├── [VERIFIED T8c.5c1] terminal/block/quarantine rollback across checkpoint/Run/work-unit/Attempt/Task/audit/events
  ├── [VERIFIED T8c.5c1] crash after terminal commit but before semantic wake -> startup fan-in reconciliation
  ├── [VERIFIED T8c.5c2] initial pending/approved wait -> atomic suspension, no cancellation, all capacity released
  ├── [VERIFIED T8c.5c2] illegal checkpoint/Run/work-unit suspension cross-product fails before writes
  ├── [VERIFIED T8c.5c2] startup registration contains no coordinator direct Attempt/slot writer
  ├── [VERIFIED T8c.5c2] replacement Attempt reacquires ordinary Run leases and semaphore before tool_start
  ├── [FOCUSED CHECKPOINT T8c.6a] Pi no native resume and decorative metadata rejected
  ├── [FOCUSED CHECKPOINT T8c.6a] real orchestrator timeout -> failed, never cancelled
  └── [VERIFIED T8c.6b PACKAGED] reconnect observes the resumed result from canonical state

PACKAGED macOS USER FLOWS
isolated signed .app + non-Git workspace
  ├── [VERIFIED FIRST T8] ordinary continuity and three-fact recall
  ├── [VERIFIED T8d.1] file create + Node execution + one-step workflow/report/Turn completion
  ├── [VERIFIED T8d.1r] ready acknowledgement remains progress until callback/recovery convergence
  ├── [VERIFIED T8b PARTIAL] Engineer evidence, QA manifest/step, fail-closed fan-in
  ├── [VERIFIED T8d.2a] custom explicit Engineer remains stable from Item through Run
  ├── [VERIFIED T8d.2a] same-role multi-mention/tool-gap/incomplete-assignment fail closed
  ├── [VERIFIED T8d.2b] existing proposal without compatible decision/manifest -> one durable blocker
  ├── [REPRODUCED -> T8d.2c] correctly named Agent Run omitted teammate prompt/profile
  ├── [REPRODUCED -> T8d.2d] Engineer/QA workspace default absent -> raw provider constructor blocker before workflow
  ├── [VERIFIED T8d.2d PACKAGED] missing workspace default -> actionable typed blocker with zero workflow/Run/action
  ├── [VERIFIED T8d.2d PACKAGED] configured workspace default -> exact Engineer/QA model bindings reach execution
  ├── [VERIFIED T8d.2 PACKAGED] correctly configured Agent naked ready -> one structured blocker
  ├── [VERIFIED T8d.3 PACKAGED] QA pending approval -> restart -> same Run/new Attempt -> fan-in success
  └── [VERIFIED T8d.4 PACKAGED] reconnect + one final Item/source-Turn/SQLite lineage
```

The prior artifact closed the semantic packaged P1 scenarios, but T9 transaction-source
changes reopen their release evidence. T9.1-T9.5 are historical evidence; the active
S3.5/S4/S5 tasks remain in this plan rather than being deferred to `TODOS.md`.

## Delivery Slices

### D0: Freeze the contract

- Replace singular intent execution with `ChannelIntentExecutionPlanV1.operations`.
- Define operation ids, dependency validation, daemon target materialization, and
  centralized required-tool derivation.
- Define `CommandMatchPolicyV1` as daemon-owned exact/executable authority, keep
  `targetRef.label` display-only, and keep the model proposal schema separate from the
  persisted plan schema.
- Define workflow-step execution plan and verification metadata.
- Define approval as a phase of one execution action lifecycle: correlate by
  `(runId, toolCallId)`, preserve approval artifact ownership, and require tool terminal
  evidence before success.
- Define source-turn lifecycle, publication barrier, CAS transitions, and recovery.
- Align selector, TerminalReport, and multi-Agent documents with the owning contract.
- Define mention as participant input rather than intent authority, including structured
  token precedence, Unicode-delimited fallback, and incomplete-materialization blocker.
- Define immutable required-participant manifest, typed delegated outcomes, and the
  workflow completion gate. Keep assistant delivery status outside execution truth.
- Define outcome-specific evidence classes, immutable graph branch authority, completion
  basis fingerprinting, and atomic gate/terminal-transition storage semantics.

Exit: the architecture has no unresolved ownership decision.

### S0: Contracts and one-time migration

- Add operation-plan and operation types plus reusable validation helpers.
- Reject empty plans, duplicate ids, missing dependencies, cycles, invalid kind/target
  pairs, unsupported fields, and old singular runtime objects.
- Require a valid command-match policy on durable command-target operations, reject it on
  other operation kinds, and reject model output that attempts to declare policy or
  target refs. Do not add a policy default or runtime dual reader for pre-release rows.
- Add workflow/step metadata for `sourceTurnId`, operation subsets, and verification.
- Extend state transition entity typing with `turn`, propagate it through the public
  Contracts and daemon query allowlist, and add a CAS turn transition API.
- Add migration 113 to convert existing schema-v2 singular `execution_json` rows into
  one required `operation_1`; do not add a runtime dual reader. A recorded migration 113
  is considered incomplete while any non-null `execution_json` fails the V1 operation-plan
  validator, so startup re-enters repair instead of trusting the version stamp alone.
- Add shared validators for `RequiredParticipantManifestV1`, `DelegatedOutcomeV1`,
  `WorkflowCompletionGateV1`, and `DelegatedStepRequirementV1` plus its deterministic
  fingerprint. `DelegatedOutcomeV1.completed` uses typed evidence refs:
  execution/verification require `ExecutionAction` refs, synthesis/review require a
  validated workflow output-packet artifact, and discussion requires an attributed
  assistant Item. Validate concrete participant ids, unique membership, required
  operation ownership, stable fingerprints, and legal outcome/evidence pairs.
- Add the next one-time migration for `participant_manifest_json` on decisions and the
  copied manifest/completion snapshot in workflow metadata. Fresh schema declares
  `participant_manifest_json TEXT NOT NULL` with the canonical empty-manifest default.
  Migration 114 backfills each row in priority order: selected teammate ids, proposal
  collaboration steps/assignee, existing workflow participant steps, `ai_teammates.role_key`,
  and operation ownership. It validates that every recovered required operation has an
  owner and that all sources agree. Empty manifest is valid only for actions that truly
  requested no participant. If an execute/proposal row cannot be reconstructed without
  guessing, the whole migration rolls back and reports the exact row and conflicting
  sources; it never silently weakens that row to empty. Because this is unreleased
  development data, the operator fixes/resets the local row and reruns migration instead
  of carrying a permanent compatibility path. A previously recorded draft migration 114
  is re-entered until all postconditions pass. Runtime code has no missing-manifest
  fallback and no dual reader.
- Materialize the immutable delegated requirement for every non-terminal
  manifest-backed workflow step through migration 115 from migration-114 canonical
  sources. Copy the identical object into the current linked Run request snapshot and
  verify source decision, manifest, graph fingerprint, graph node, operation ownership,
  and dependency agreement. Re-enter repair when a recorded version row exists but the
  postconditions are missing or corrupt. Terminal
  historical steps lacking a reconstructable requirement remain immutable and are
  rejected by pre-publication reconciliation rather than guessed. Runtime code has no
  requirement fallback derived from summaries or callback payloads.
- Add migration 116 for nullable `artifacts.content_sha256`, nullable
  `artifacts.sealed_payload_json`, and nullable `control_plane_events.idempotency_key`
  with a workspace-scoped event idempotency partial unique index. Seal only workflow output packet rows
  that can still participate in reconciliation, after their file bytes parse and match
  artifact owner/path plus workflow/step/Run ids. A missing or invalid required file rolls
  the migration back with exact artifact ids; it is never repaired from prose. Fully
  published historical packets and non-workflow legacy artifacts may keep null sealed
  fields.

Tests: contracts validation including `StateEntityType="turn"`, real HTTP turn-transition
querying, migration idempotency, old-shape rejection after migration, CAS
duplicate/stale/terminal behavior, transition-event persistence, manifest
fingerprinting, delegated-requirement fingerprint and ownership, invalid
participant/operation ownership, outcome/evidence compatibility,
fresh-schema `NOT NULL` behavior, proposal/workflow-derived manifest backfill, source
conflict rollback, recorded-version repair, non-terminal migration fail-closed behavior,
packet digest sealing/tamper rejection, and publication-event idempotency uniqueness.
- Add migration 117 with durable per-workspace `control_plane_replay_state`. Initialize
  it from existing event rows; every later event append advances `latest_seq` in the same
  transaction, and any future deletion must advance `replay_floor_seq` with the delete.

Migration 117 tests cover fresh/upgrade initialization, append watermark advancement,
recorded-version repair, and empty-table retention of a non-zero floor/latest watermark.

### S1: Intent materialization and bounded commands

- Add one mention materializer at accepted-turn ingest. Prefer structured composer
  tokens; support deterministic Unicode punctuation fallback for paste/API text; validate
  identity and de-duplicate before the user Item commits. Treat Channel availability as a
  dispatch policy: a known inactive/out-of-Channel participant remains visible in the
  accepted Item and yields `participant_unavailable_in_channel`, not HTTP 400 or silent
  deletion. Plain-text fallback enumerates the complete known identity inventory before
  checking active/hidden/Channel availability; a filtered first page cannot define
  semantics. Reject only malformed/unknown structured identities before acceptance.
- Remove the explicit-teammate ordinary-reply early return. Canonical mentioned and
  unmentioned turns both enter the same intent/delegation selector before reply routing.
- Persist `RequiredParticipantManifestV1` with the accepted decision. Resolve explicit
  mentions/roles to concrete ids; unknown/ambiguous identities return
  `mention_materialization_incomplete`, while known but unavailable participants return
  `participant_unavailable_in_channel` instead of silently disappearing.
- Change the model prompt/schema to return an operation plan candidate.
- Validate and materialize every operation independently through daemon-owned target and
  command boundaries.
- Replace “first backtick is a command” with a bounded command candidate validator.
- Support explicit `node` execution while keeping quoted code/content non-executable.
- Derive proposal/step tools from materialized operations only.
- Attach all operations to one step for a single Agent, or partition them across graph
  nodes for explicit multi-role work while preserving dependencies.
- At proposal/workflow compilation, copy the manifest and fingerprint, map every required
  participant to one or more steps and owned operations, and reject required-set loss.

Tests: create-only gives `write`; create-and-run Node gives ordered `write + bash`;
backticked prose does not become a command; invalid or ambiguous commands clarify or
block without a proposal; `；@QA` and other Unicode-delimited mentions materialize;
metadata-free `；@QA` still persists canonical QA and one unavailable blocker when QA is
inactive, hidden, or out of Channel; invalid structured mentions fail closed; explicit
discussion mention stays a no-tools reply; explicit execution mention reaches `execute`;
Engineer + QA cannot compile as an Engineer-only workflow.

### S2: Evidence-gated workflow completion

- Before Task/Run creation, resolve the exact graph participant through the shared
  workflow participant-profile adapter. Populate `systemPrompt`, `appendSystemPrompt`,
  and teammate `approvalProfile`; keep tools equal to the operation-derived subset and
  merge later gates fail-closed. Persist the effective values in the existing Run request
  snapshot. Same-Run restart/resume reuses that snapshot, while internal selector/report
  Runs bypass this adapter.
- Persist one immutable `DelegatedStepRequirementV1` per delegated graph step and copy it
  into the Run request snapshot. Validate its participant, manifest, graph, operation,
  dependency, and accepted-evidence bindings before every terminalization.
- Move the terminal evidence/context/output-packet/approval decision cluster out of
  `orchestrator.ts` into `workflow-step-finalizer.ts`. The finalizer accepts a step id and
  reconciliation cause, then reloads the currently linked Run; no callback payload may
  supply completion truth.
- Add `workflow-reconciliation.ts` as the only manifest-backed semantic completion entry.
  Online Run terminal callbacks, post-step approval sync, daemon startup, explicit/late
  callbacks, and TerminalReport pre-publication all call it. `orchestrator.ts` remains
  scheduling/composition, while Core startup recovery stops at leases, lost Runs, and
  low-level state-machine repair.
- Add a workflow-store transaction that compares the step revision, linked Run terminal
  watermark, requirement fingerprint, approval revision, and evidence/output-packet
  basis before persisting `DelegatedOutcomeV1` and the compatible step transition. A
  stale basis causes full reconciliation retry, not an outcome-only or status-only write.
- Model the finalization read-set as `linked_run | no_linked_run`. The no-Run branch
  requires `step.run_id IS NULL`, carries no Run watermark or Run-owned artifacts, and
  atomically commits `blocked(delegated_run_missing)`. A concurrently linked Run makes
  the CAS stale and forces reconciliation; absence never means indefinite waiting.
- Add a deterministic operation-evidence validator over existing `ExecutionAction`
  records.
- Normalize command evidence before operation verification. Structured unified-exec
  remains authoritative and requires an explicit numeric exit code for success. Only a
  terminal legacy Pi bash `tool_end(isError=false)` with no unified-exec envelope may be
  normalized to `exitCode=0`; `isError=true` without a numeric code remains a failed
  command with unknown exit code. Carry the normalized outcome separately from the
  optional numeric code in the derived `ExecutionAction` so failure reasons remain
  deterministic after replay.
- Project legacy Pi terminal text into the same bounded command output tail used for
  recovery and stdout checks. Treat intermediate Pi content updates as cumulative
  snapshots and retain only the latest snapshot instead of duplicating every update.
- Fold an approval record and its tool events into one action by `(runId, toolCallId)`.
  `approved` remains an authorization phase; only terminal tool/command evidence can
  produce `succeeded` or `failed`. Preserve approval preview/result artifact semantics
  while merging tool targets, timestamps, and command evidence.
- Match file create/edit actions by canonical target; preserve POSIX path case and fold
  case only on Windows. Run/open operations require exact normalized
  `commandEvidence.command` equality; summaries, target labels, and substring matches are
  not evidence. Enforce dependency completion order.
- Persist verification results and evidence action ids in step metadata.
- Run validation before a run-success transition can mark the step succeeded.
- Emit one typed delegated outcome per participant-owned execution boundary. Accept
  `completed` only after its referenced operations verify; accept `workflow_started` only
  as ownership handoff; persist `blocked | failed | cancelled` with reason/evidence. For
  synthesis/review work with no required operation, create and validate the existing
  `ChannelWorkflowStepOutputPacket` artifact first, give it an identity/fingerprint
  derived from the current attempt watermark plus immutable requirement and canonical
  dependency/source refs, bind it to workflow/step/participant, require resolvable
  source/output refs, and use that artifact as completion evidence. The step CAS validates
  the prepared packet exactly, so a crash/restart reuses it instead of duplicating it.
  Plain `resultSummary` or runner final text alone remains insufficient.
- Convert agent-context rejection and stale/private fan-in context into a typed
  `DelegatedOutcomeV1.blocked` through the same finalizer. The existing direct step-block
  helper may remain for legacy workflows only; manifest-backed work cannot bypass the
  outcome/basis transaction merely because the blocker is discovered before evidence
  validation.
- Delete any completion path that treats ordinary assistant text or
  `channel_ai_reply.status="ready"` as delegated success. Missing typed outcome keeps the
  step/Turn non-terminal or produces a deterministic visible blocker.
- Block missing required evidence, fail attempted negative evidence, and retain optional
  gaps as TerminalReport risks.
- Implement `WorkflowCompletionGateV1` as the sole workflow-success predicate. Compare
  the accepted manifest to workflow/graph participant mappings, validate required
  outcomes and operations, enforce dependencies, execute every join's `fanInPolicy`
  including `requireAllBranchesTerminal`, then apply termination policy.
- Require verified predecessor steps at fan-in and final workflow success. The gate reads
  incoming edges from the immutable graph as the declared branch authority, never only
  `dependsOnStepIds` or the steps currently stored. A missing materialized branch is
  `fan_in_branch_missing`, not an empty successful join.
- Add `sourceIntentDecisionId`, graph fingerprint, and deterministic basis fingerprint to
  the gate snapshot. Gate evaluation returns `WorkflowCompletionEvaluationV1`, including
  explicit decision execution-plan, manifest, graph, termination, step/outcome, derived
  action projection, approval, Run/event, and packet fingerprints. The workflow store
  commits the recomputed gate and its compatible pending/succeeded/blocked/failed/
  cancelled effect in one SQLite transaction. It re-reads the canonical Run/event/
  approval/artifact backing rows and recomputes packet SHA-256 from sealed SQLite JSON;
  stale snapshots cannot settle a workflow. Delete the separate negative-step shortcut.

Tests: approved-then-succeeded/failed action folding, pending/denied approval precedence,
same tool-call id in different Runs, approval artifact stability, missing bash evidence,
legacy Pi success without an explicit exit code, legacy final stdout projection,
cumulative-update de-duplication, legacy failure with unknown exit code, structured
unified-exec success missing its exit code, explicit non-zero exit, timeout, cancellation,
wrong target, out-of-order evidence, duplicate verification, retry replacement, and
Engineer-write to QA-run fan-in; naked “I will execute” text, missing typed outcome,
missing required participant step, manifest fingerprint mismatch, active/absent required
fan-in branch, `requireAllBranchesTerminal=false/true`, and optional branch policy.
Also cover read-only synthesis with a valid output packet, missing/stale/cross-workflow
packet, duplicate/restart packet preparation, assistant-text-only synthesis, a graph edge whose step row is absent, a stale
verified gate snapshot, evidence arriving between step evaluation and step commit, and
evidence arriving between workflow-gate evaluation and workflow commit; command
substring false positives, POSIX case-mismatched file targets, Windows case-folded file
targets, a running delegated step with `run_id IS NULL`, and a Run linked concurrently
with no-Run finalization. Also cover custom teammate base/append prompt propagation,
strictest approval-profile merging, exact required-tool scoping, manifest assignee
override rejection, post-compile teammate tool shrink, all three workflow-start callers,
and immutable same-Run resume snapshots. Run the same
fixtures through online callback, post-step approval, startup, explicit reconcile,
duplicate/late callback, and pre-publication causes; assert identical canonical outcome,
one state event/artifact/blocker, typed context-rejection outcome, and no stale retry Run
adoption.

### S3: Source `LingTurn` closure and recovery

- Resolve and persist `ChannelWorkflowMetadata.sourceTurnId` at proposal-to-workflow
  conversion.
- Require a committed `WorkflowCompletionGateV1` snapshot before a workflow may publish
  a succeeded report. TerminalReport consumes the snapshot but cannot change participant
  or evidence results.
- Move the source turn through running and approval states with CAS transitions.
- Add one store-level publication-barrier transaction. It revalidates the report and
  Completion Gate basis, derives and validates the report/evaluation/Turn mapping,
  validates and creates/reuses the deterministic committed final Item, sets
  `publishedMessageId`, applies the compatible source-Turn CAS,
  appends the Turn transition event, and appends one durable
  `terminal_report.published` invalidation. Any stale basis or incompatible terminal Turn
  aborts the entire transaction. Use the equivalent legacy final-reply barrier when
  reporting is disabled.
- Bind the publication store's control-plane port only to
  `appendControlPlaneEventWithinTransaction()`. Its port name must retain the
  `WithinTransaction` suffix. The standalone control-plane append is forbidden inside
  both TerminalReport and legacy publication barriers.
- The publication barrier owns rollback. Its catch path attempts `ROLLBACK` without
  consulting `DatabaseSync.isTransaction`, suppresses only a rollback failure, and
  rethrows the original error. A failed barrier must leave the connection able to begin
  a new transaction immediately.
- Implement the barrier in a focused Core publication store. The durable invalidation
  uses its migration-116 idempotency key inside the transaction; remove list-before-append
  deduplication. If a blocked/partial report finds the Turn already blocked, append one
  deterministic `settle_blocked` publication audit event without widening the normal
  Turn state machine, while keeping the Turn resumable.
- Keep the turn non-terminal when report generation/publication fails.
- On startup, repair published-result/source-turn drift and make repeated callbacks
  idempotent.
- Notify the in-memory SSE/RPC hub only after the publication transaction commits. If the
  daemon crashes before live notification, reconnect replays the already committed
  invalidation; retrying publication returns the same Item/Turn/event lineage.
- Refresh selected-Channel Items from that invalidation and include committed Item
  identity/revision in the Web TerminalReport refresh signature. Do not rely on the
  earlier workflow-terminal refresh or add an unbounded polling loop.
- Preserve the last applied control-plane sequence across transient reconnects. Keep
  received and applied cursors separate. On first mount, workspace switch, or lost cursor,
  read snapshot sequence `S`, establish a provisional live subscription after `S` while
  buffering, perform one authoritative selected-Channel refresh through `S`, then advance
  and drain; never advance to `S` without that refresh.
- For both SSE and local RPC, register live delivery before reading durable replay, then
  merge by sequence, de-duplicate, and order the handoff batch. No publication may fall
  into a replay/subscription gap.
- Make SSE and local RPC consume one pure queue coalesce helper. It may keep the newest
  event per coalescing key, but after preserved and coalesced events are combined it must
  de-duplicate and sort the whole queue by durable sequence before delivery.
- Treat live-first registration plus initial replay as one setup transaction. If replay
  lookup, merge, or initial flush throws, close and unregister the provisional SSE/RPC
  client before propagating the error so later publications cannot reach an orphan.
- Bound the server-side initial replay window. After provisional live registration,
  capture a replay upper bound and retention floor from durable per-workspace replay
  state, then query matching rows through the
  bound with `limit + 1`. Treat numeric gaps from filtered domains or other workspaces as
  legal. Ahead cursors, retained-history gaps, and overflow close the provisional
  subscription and return typed `control_plane_snapshot_required` (SSE event then close;
  RPC normal snapshot disposition). Complete replay returns an explicit ready window.
  Remove the client-side fixed-1000 pagination loop; only the server can prove a bounded
  range complete.
- Coalesce a `runs + work_units` batch so runtime and the selected Channel projection
  each refresh once. Do not refresh the unrelated normal-Conversation surface while a
  Channel is selected. Cancel or generation-guard TerminalReport requests so an older
  empty response cannot overwrite a newer Item-revision query.
- Reconcile equivalent Channel Items by durable Item identity and revision. Keep delayed
  hover/focus/disclosure state outside a refresh-replaceable Item instance when that state
  must survive projection refresh, keyed by stable Item/reference identity. Do not make a
  reference preview depend on the original component instance remaining mounted while an
  unrelated control-plane refresh is applied.

Tests: success, partial/blocked, failure, cancellation, approval wait/resume, report
failure, reporting-disabled fallback, crash injection at every publication-barrier write,
standalone-versus-joined event append wiring, Node 22 nested-transaction regression,
post-fault next-transaction success,
daemon restart, duplicate callback, report committed
after the workflow-terminal query returned empty, publication-event replay, reconnect
from the last cursor, replay-window overflow/retention-gap snapshot handoff,
ahead-cursor and legal filtered-sequence-gap handling, lost-cursor buffered snapshot
handoff including an event committed after `S`, coalesced-domain refresh de-duplication,
global sequence ordering after a preserved terminal event and repeated coalescible
invalidations,
replay-lookup setup failure cleanup, late empty-query rejection, equivalent-Item refresh
during delayed reference hover, reload from canonical SQLite state, and report synthesis
refusing to upgrade a blocked/non-verified completion gate.

### S4: Durable accepted-turn dispatch and bounded context preparation

- Add `channel_turn_dispatch` to the existing WorkUnit authority. Atomically create one
  queued dispatch unit with each accepted user Item/Turn and derive its idempotency key
  from the turn id.
- Add one daemon-composed `ChannelTurnDispatchWorkerRegistry`, with one coalesced
  oldest-first drain loop per opened workspace. Wake it from store initialization and
  after acceptance commits; claim with WorkUnit CAS and never construct it inside an HTTP
  handler.
- Move context assignment, summary preparation, reply-lane acquisition, and intent
  dispatch behind the durable worker. Keep `WorkUnit.request` immutable; derive stage
  progress from committed context/intent/route/reply/workflow refs and use runtime events
  only for diagnostics. Do not copy timeline or decision payloads into a second store.
- Make both Channel POST handlers observers of the same worker promise. A response close
  suppresses further writes only; it cannot cancel or fail accepted work.
- Transition the source turn from `open` to `running` when dispatch is claimed. Terminalize
  it directly for ordinary no-run outcomes, or hand completion ownership to the linked
  reply Run/workflow.
- Bound the advisory segmentation proposer with abort + timeout and commit the
  conservative bootstrap assignment on failure.
- Bound hard-summary generation. On failure, build a deterministic provider-budgeted
  projection from the last committed summary and permission-filtered recent tail; emit a
  visible `context_projection_over_budget` blocker if required tail alone cannot fit.
- Bound the rapid-submit lane-link wait and fall back to normal intent selection when no
  exact predecessor Run links in time. New turns never wait on unrelated lanes.
- Make SSE disconnect observer-only. Startup recovery requeues unclaimed work, marks lost
  attempts stale, and resumes from context/intent/route/reply/workflow checkpoints without
  duplicate visible replies, Runs, or workflows. Read-only provider inference may repeat
  only after the ambiguous crash window before its result committed.
- Use deterministic source-turn-derived reply/blocker identities. Reuse terminal reply
  items, resume a pending item without a current child into that same item id, and hand
  off a pending item with a current child without starting another Run.
- Recovery reuses the accepted decision manifest and recomputes the completion gate from
  canonical workflow/action state. It never reconstructs required participants from
  assistant text, proposal wording, or only the currently present graph steps.
- Startup ignores cached gate status as authority. It recomputes from the source decision,
  graph, steps, actions, output packets, approvals, and termination policy for every
  non-terminal workflow and every terminal workflow whose report/source-Turn chain is
  incomplete; an equal snapshot is an idempotent no-op.
- On shutdown, stop new claims, wait for active dispatches to reach a durable boundary,
  suspend remaining process attempts with typed runtime intent, preserve approval
  checkpoints and logical Runs, and leave any non-resumable lost attempt for visible
  stale/failure recovery before closing SQLite. Never call the user-cancellation path as
  generic daemon cleanup.

Tests: atomic Item/Turn/dispatch creation, request-idempotency reuse, disconnect after
`ready`, segmentation timeout/failure/invalid JSON fallback, hard-summary timeout and
budgeted fallback, over-budget visible blocker, lane-link deadline, crash/restart before
intent and after reply linkage, immutable request validation, coalesced drain wakes,
oldest-first claim, duplicate-worker claim, shutdown/startup recovery, and no silently
open accepted turn; restart after one of several required participants completes, restart
with a missing delegated outcome, restart with a stale cached verified gate, restart with
a committed synthesis output packet, and idempotent completion-gate recomputation.

### S5: Verification and macOS acceptance

- Run Contracts, Core, Daemon, TerminalReport, orchestrator, and Channel E2E suites.
- Run Core and Daemon under the official Node 22 binary used by the packaged daemon.
  Zero cancelled tests is part of the gate; a later failure caused by a leaked earlier
  transaction is not an independent flaky test.
- Before packaging, run the exact/executable policy matrix and confirm the persisted
  operation in the API/SQLite no longer derives authority from `targetRef.label`.
- Build the latest macOS Desktop package after the final source verification. Any ZIP,
  DMG, signature, or GUI result produced before the transaction-ownership correction is
  stale and cannot satisfy this gate. Do not replace or stop an unrelated
  running client.
- Launch the built package by its resolved absolute executable path for programmatic
  package/smoke gates. A GUI driver that exposes only bundle-id launch may first register
  the exact unmodified artifact and request a new instance, but its result is accepted
  only after the returned PID resolves to that artifact's executable path. Give every
  packaged acceptance run a fresh user-data directory, fresh daemon, remote-access
  gateway, and remote-debugging ports, and a fresh workspace so Electron single-instance
  state, SQLite, and control-plane cursors cannot attach to an already-running Ling
  client. It also receives a fresh `LING_STACK_HOME`: installation-global identity and
  remote-access state live there rather than under Electron user-data or workspace
  SQLite, and a persisted enabled gateway may retain its own listener port. Every
  daemon-owned secondary listener and global state root must be part of this isolation
  tuple; moving only the primary HTTP port is insufficient.
- Preserve the package identity and signature during acceptance. Do not copy the app into
  `/Applications`, rewrite `CFBundleIdentifier`, rename signed bundle contents, or use a
  LaunchServices result as evidence that the newly built artifact started. The observed
  main-process executable path and startup-log `resourcesRoot` must both resolve inside
  the exact package under test.
- Use a fresh isolated non-Git workspace and fresh app data for end-to-end acceptance.
- Verify ordinary conversation, several dependent follow-ups, long-context fact recall,
  real file creation/edit, real Node execution/output, single Agent, multi-Agent fan-in,
  TerminalReport, source-turn terminal state, and restart recovery.
- Repeat the packaged reproduction with the natural-language `Node 调用...` request.
  Verify the durable policy is `executable=node`, the approved `node -e ...` action id is
  credited, the file and command operations both verify, and the workflow/report/source
  Turn all finish `succeeded`.
- Re-run the exact delegated reproduction with Unicode-delimited Engineer + QA mentions.
  Verify both participants survive into the decision manifest and graph; Engineer cannot
  close the workflow before QA produces verified evidence or a structured blocker.
- During a required participant Run, force an ordinary no-tool “I will execute” response
  and verify the GUI remains running/blocked rather than displaying a successful result.
- Exercise daemon restart after Engineer evidence but before QA terminal state, and SSE
  reconnect between completion-gate commit and TerminalReport publication.
- At the exact restart checkpoint, require QA to be waiting on a durable bash approval.
  After restart, assert the same approval id is still pending, the same QA Run and
  workflow step remain linked, the old process attempt is lost, and no `run_cancelled`,
  `approval_cancelled`, or `local-user` cancellation transition exists. Approve through
  the packaged UI, assert one replacement attempt under the same Run, then require QA
  evidence, successful fan-in, one TerminalReport, and one settled source Turn.
- Repeat the resume with one second daemon restart in each recoverable phase: after the
  `resume_pending` CAS but before replacement-attempt creation, after attempt creation but
  before durable `tool_start`, and after durable `tool_end` but before Run finalization.
  Each phase must converge without duplicate execution. A forced stop after `tool_start`
  but before `tool_end` must surface `approval_resume_effect_unknown` and must not rerun
  the command.
- Repeat the stop path with an explicit user Run/workflow cancel and prove it still
  cancels the Run and pending approval. Repeat idle/hard timeout and prove it fails with
  the timeout code rather than impersonating user cancellation.
- Inspect SQLite records for Thread -> Turn -> Item ownership, operation evidence refs,
  canonical mentions, participant manifest/fingerprint, delegated outcomes,
  completion-gate snapshot, one final result, and terminal source-turn consistency.

#### macOS packaged-QA isolation contract

Package validation and product-flow acceptance are separate gates over the same artifact:

```text
signed .app from release/mac-arm64
  -> codesign / ZIP / DMG integrity gate
  -> absolute Contents/MacOS/Ling Stack launch
       --user-data-dir=<fresh directory>
       --remote-debugging-port=<fresh port>
       LING_STACK_HOME=<fresh installation-state root>
       LING_STACK_DAEMON_URL=<fresh loopback port>
       LING_MOBILE_GATEWAY_PORT=<fresh loopback port>
       LING_STACK_DEFAULT_WORKSPACE_CWD=<fresh non-Git workspace>
  -> startup log proves resourcesRoot belongs to that .app
  -> packaged smoke proves embedded resources and daemon lifecycle
  -> visible Channel acceptance exercises the same isolated runtime
```

The package under test may share the production bundle id because isolation is provided
by explicit executable and data roots, not by mutating signed metadata. Registration for
a GUI-driver launch does not make the selected app authoritative: the returned PID,
executable path, and startup-log resource root still must match the expected artifact.
Otherwise the run is rejected as an invalid test, not a product failure, and any prior
LaunchServices registration changed for the test is restored. Existing Ling processes
are read-only test-environment evidence and are never stopped merely to make acceptance
easier.

Exit: the original reproduction passes in a packaged macOS client and no required suite
regresses.

## Change Boundaries

- Keep `ChannelIntentDecision.schemaVersion` at 2; the nested execution plan has its own
  explicit V1 type.
- Keep SQLite and the existing `ExecutionAction`, workflow, report, and conversation
  authorities. `ExecutionAction` remains a derived read model; do not add an action table.
- Do not infer command permission from prose, backticks, runner summaries, or assistant
  claims.
- Do not infer canonical participants from reply/proposal prose or treat mention presence
  as an intent decision.
- Do not treat `teammateId` alone as a complete delegated Run request. Bind the exact
  teammate prompt/profile in the workflow adapter, not through a generic Run-level
  auto-hydration rule.
- Do not pass a teammate's entire allowed-tool set to a workflow Run. It is only a ceiling;
  operation-derived step tools remain the least-privilege Run scope.
- Do not use assistant-message delivery state as delegated execution state.
- Do not let the model declare `requiredTools`, action success, source-turn status, or
  fan-in completion.
- Do not make TerminalReport generation mutate workflow evidence or re-run work.
- Do not add a completion table, recovery queue, or SSE-owned state. Workflow metadata is
  a cached audit snapshot; canonical domain rows remain the recomputation authority.
- Do not add a `suspended` Run terminal state or another approval table for T8c. The
  existing logical Run, process `WorkUnitAttempt`, and `LingApprovalCheckpoint` already
  express the required boundary. A new attempt resumes the same Run.
- Do not treat daemon restart, Desktop quit, process signal, idle timeout, or hard timeout
  as `local-user` cancellation. Cancellation remains reachable only through explicit
  Run/workflow/intervention actions and their existing policy paths.
- The tiny `control_plane_replay_state` row is allowed transport bookkeeping, not a
  completion/event duplicate. Do not infer its floor from the current minimum event row,
  and do not delete control-plane events without advancing it atomically.
- Do not accept a daemon-computed packet digest without Core recomputing it from the
  sealed SQLite payload during the completion/publication CAS.
- Do not add Windows packaging or Windows QA to this change.
- Do not create a PR or merge before T8d passes. T9 is already authorized after that gate.
  Publishing a release remains outside this plan.
- Do not write a success Completion Gate against the current workflow and then reuse that
  same terminal workflow as the only guard for report publication. Publication must
  revalidate the fresh canonical basis and commit Item/marker/Turn/event atomically.

## Failure Modes And User Visibility

| Path | Realistic production failure | Required handling | Test level | User-visible result |
| --- | --- | --- | --- | --- |
| Mention availability | teammate is removed after the composer captured its id | accept the canonical Item, use the request snapshot, publish/replay one typed blocker | daemon integration + Channel E2E | explicit unavailable-participant blocker |
| Mention fallback | pasted/API text names a known hidden or inactive teammate without structured mention metadata | resolve identity from the complete roster before availability filtering and persist one canonical unavailable mention | daemon HTTP/SSE integration | explicit unavailable-participant blocker; no silent participant loss |
| Proposal recovery | a crash leaves an existing proposal without a compatible accepted decision/participant manifest | preserve the proposal for audit, publish one idempotent `existing_proposal_participant_lineage_invalid` blocker, settle the source Turn, and start no Run | daemon crash/retry integration + JSON/SSE projection | visible recoverable blocker instead of HTTP 500, silent reselection, or a hanging Turn |
| Participant profile binding | the correct step participant id is retained but base/append prompts or approval profile are omitted from the Run request | resolve the exact canonical teammate in the shared workflow adapter and freeze effective values in the Run snapshot | daemon FakeRunner + persisted snapshot + packaged GUI | the requested Agent behaves according to its configured profile; omission blocks delivery rather than silently running a generic Agent |
| Participant profile binding | a caller overrides a manifest-backed assignee or teammate tools are reduced after graph compilation | reject the override or tool gap with one typed pre-Run blocker; create no Task/Run/approval | daemon integration + retry/manual-start coverage | visible participant-policy blocker; no substitution or broadened authority |
| Participant model binding | a Channel has a runnable Ling Agent model but Engineer/QA follow an unconfigured workspace default | preserve ownership, return `workflow_participant_provider_unavailable` with participant/source/repair target before graph creation, and never borrow the Channel model | Core resolver + daemon proposal + JSON/SSE + packaged GUI | one actionable workspace-model blocker; no raw constructor error and no partial workflow |
| Participant model binding | provider readiness changes after proposal confirmation or workspace settings change during restart | revalidate the frozen step provider before first Run; same-Run restart/resume reuses its snapshot; repaired retry records a new binding | daemon race/retry/restart integration + SQLite audit | visible exact-model blocker or explicit new retry binding; no silent provider switch |
| Participant authority | a workflow-defined handoff/custom/compaction/scheduling/fan-in step has no direct Channel membership row, or proposal provenance is incomplete/tampered | use explicit trusted-origin authority: only `channel_selection` requires effective Channel membership; `workflow_definition` requires active/visible exact-participant checks; malformed/late provenance blocks | migration/store fault-injection + table-driven daemon tests + full Channel suite | valid workflow runs; a real proposal participant remains fail-closed when removed from the Channel; no authority-less Run |
| Delegated finalization | runner exits successfully after only promising future work | host detects missing typed outcome without parsing prose and blocks once | orchestrator integration + packaged GUI | work is blocked, never shown as completed |
| Delegated finalization | startup finds a running required step with `run_id IS NULL` | no-Run CAS verifies the null linkage and commits `blocked(delegated_run_missing)`; a concurrent link forces retry | Core store + startup/explicit reconcile | one visible blocker instead of permanent waiting |
| Delegated finalization | late callback arrives after the step was retried with a new Run | ignore callback payload, reload current linkage, and finalize only canonical state | finalizer integration | no stale attempt can complete the retry |
| Post-step approval | approval is granted after the Run succeeded but required evidence is missing | persist approval, then the shared finalizer blocks on evidence | approval/finalizer integration | approval is visible but work is not called complete |
| Tool evidence | a Run event, approval, or artifact behind the derived action changes between evaluation and workflow commit | backing-row CAS fails, reload and recompute | store concurrency test | no false success; progress remains pending/blocked |
| Tool evidence | actual command only contains the planned command as a substring, or a POSIX path differs only by case | reject the evidence unless structured command/path identity matches exactly under platform rules | evidence unit + workflow integration | required operation remains blocked/failed; no false success |
| Command materialization | natural-language executable intent is mistaken for a complete exact command | persist daemon-owned `executable` identity; never match against a display label | contract + selector integration | concrete approved command may complete normally instead of producing a false blocker |
| Command evidence | executable evidence is wrapped, chained, redirected, substituted, prefixed, or unrelated | quote-aware simple-command parser fails closed; no summary/stdout/same-Run fallback | evidence unit + workflow integration | required operation remains blocked with auditable evidence rather than false success |
| Output packet | projected file is overwritten or missing after the packet was sealed | keep SQLite sealed JSON/digest authoritative; repair projection for inspection without changing completion | Core artifact + gate integration | completed synthesis stays auditable; export shows a repair diagnostic |
| Output packet | required artifact row lacks valid sealed JSON/digest | block and reconcile; neither row id nor projected file alone is accepted | Core artifact + gate integration | synthesis is visibly blocked, never called complete |
| Fan-in | Engineer is complete while QA is active, absent, or failed | graph/manifest gate prevents verified completion | gate integration + packaged GUI | QA state/blocker remains visible |
| Required-participant projection | a required QA step has no graph/Run while an optional teammate never starts | Completion Gate and TerminalReport emit a required `missing` coverage row; only actual contributions enter the compact participant list | gate/TerminalReport contract + Web + packaged GUI | missing required work is a visible blocker, optional unstarted agents stay hidden |
| Attempt fencing | an old daemon callback arrives after a replacement Attempt is active | compare `activeAttemptId + runtimeInstanceId + fencingToken`; stale callbacks are diagnostic-only and cannot append evidence, consume approval, release current resources, or settle work | Core CAS/concurrency + daemon lifecycle + packaged GUI | no stale evidence or duplicate side effect |
| Shutdown intent | Desktop restarts the daemon while QA waits for approval | suspend the old attempt, preserve Run/approval/checkpoint/step/manifest/evidence, and never call user cancellation | active-run + daemon lifecycle integration | approval remains actionable; no false cancellation |
| No safe checkpoint | daemon stops during a work-kind with no durable safe resume boundary | apply explicit work-kind policy and publish `runtime_interrupted_no_checkpoint`; do not promise automatic continuation or create a new Run | daemon startup matrix + packaged GUI | typed block/failure with recoverable next action |
| Approval resume | the same approval resolves after restart | validate checkpoint fingerprint, start one fenced replacement attempt under the same Run, and consume the grant only for the exact side effect | Core checkpoint + daemon resume integration + packaged GUI | QA continues once; prior Engineer evidence remains |
| Approval resume | the side effect, target, scope, requirement, or active attempt changed | reject the resume basis and require a new approval or publish typed `approval_resume_mismatch` blocker | CAS/concurrency integration | visible blocker; no unapproved or duplicate side effect |
| Approval resume | Pi has no native session handle after restart | use bounded Ling continuation with a new attempt; do not claim the in-memory Pi session survived | runner conformance + daemon integration | task resumes from durable facts or blocks explicitly |
| Approval resume recovery | startup finds `resume_pending` without its bound Attempt or without `tool_start` | validate the immutable basis, fence/lose any incomplete attempt, CAS one replacement handle, and continue once | daemon startup crash-injection | one active replacement attempt; no duplicate side effect |
| Approval resume recovery | startup finds `tool_start` without `tool_end` for the bound replacement Attempt | classify the side effect as unknown and publish `approval_resume_effect_unknown`; never rerun | daemon startup crash-injection + packaged GUI | visible blocker with auditable attempt; no duplicate mutation |
| Approval resume recovery | startup finds a durable `tool_end` while Run finalization is incomplete | rebuild the action and enter the shared finalizer/Completion Gate without executing again | daemon startup crash-injection | original result is credited once and fan-in may continue |
| Resume suspension transaction | a write fails after losing the replacement Attempt but before resource release, audit, or invalidation | roll back every suspension write; reload the prior `resume_pending` lineage and reclassify it | Core trigger fault injection + daemon recovery | no silent partial suspension and no false UI progress |
| Resume terminal/block transaction | a write fails after one of checkpoint, Run, work unit, Attempt, Task, resource, audit, or invalidation changes | roll back every terminal write; publish no event; retry/reconcile from the old canonical state | Core trigger fault injection + daemon integration | no half-terminal Run or participant; user sees the eventual canonical result/blocker once |
| Resume post-commit wake | terminal transaction commits and the daemon stops before delegated finalization/fan-in | startup sees terminal evidence and invokes the shared semantic kernel without running the tool | daemon startup integration | required QA remains pending until evidence validates, then fan-in/report converges once |
| Resume projection | resume claim/start/suspend/finalize commits while SSE/RPC is disconnected | append idempotent invalidation, then replay or snapshot and reload canonical Run/work-unit/approval state | control-plane integration + Web E2E | UI converges without resubmitting the accepted Turn |
| Startup | daemon restarts after one participant or approval completes | low-level recovery repairs attempts/leases, approval resume runs, then shared semantic kernel recomputes outcomes/gate | startup integration + packaged GUI | resumes or blocks once without duplicate work |
| TerminalReport | cached gate is verified but current evidence no longer matches | pre-publication recomputation rejects stale basis | report integration | no succeeded final result; canonical blocker is recoverable |
| Publication barrier | process dies after Item insert, marker update, Turn close, or event append | one SQLite transaction rolls back all writes, or commits all for replay | store crash-injection + recovery | never a half-published result or silently closed Turn |
| Source Turn | blocked report arrives after the Turn is already blocked | commit one idempotent blocked-settlement event without making blocked immutable | Core/daemon publication integration | one settled blocker; user may still resume |
| SSE/RPC | connection drops after report commit but before refresh applies | retain last-applied cursor, replay event or perform snapshot handoff | event-hub unit + Web E2E + packaged GUI | report appears without reload/resubmit |
| SSE/RPC | more matching events exist than the safe window, cursor is ahead, or retained history is missing | compare against durable replay state, return `control_plane_snapshot_required`, close provisional subscription, run buffered snapshot handoff | Core replay-state + event-hub/RPC unit + Web E2E | no cursor skip; canonical state refreshes once |
| Replay retention | all retained event rows are deleted after the floor advances | preserve non-zero floor/latest in replay state and require snapshot for older cursors | migration/Core store | empty table cannot falsely claim complete history |
| SSE/RPC | domain filtering or another workspace creates numeric sequence gaps | treat range as complete when bounded query/floor prove it; do not force a false snapshot | event-hub/RPC unit | no reconnect loop or redundant full refresh |
| SSE/RPC | queue pressure preserves a high-sequence terminal event while coalescing lower-sequence invalidations | coalesce, de-duplicate, then sort the complete queue by sequence through the shared helper | event-hub + RPC queue regression | no lower-sequence domain refresh is discarded after cursor advance |
| Snapshot handoff | event commits after snapshot sequence `S` but before canonical refresh finishes | provisional subscription buffers `> S`; apply after refresh and cursor advance | Web E2E + packaged GUI | new report appears once without a gap |
| Client refresh | older empty query resolves after the report query | generation fence drops stale response | Web E2E | final result remains rendered |
| Source Turn | duplicate callback/recovery publishes again | deterministic ids + publication uniqueness + CAS settlement | daemon integration + SQLite audit | one final result and one settled Turn |
| Terminal projection | workflow card emits a summary after `final_result` is committed | TerminalReport publication marker is the single terminal authority; cards remain folded progress/evidence | Web + replay/reconnect + packaged GUI | exactly one user-visible terminal result |

There are no intentionally silent failures in this slice. Diagnostic-only replay setup
errors may be logged, but they retain the prior cursor and reconnect; accepted work and
canonical completion state never depend on that observer being alive.

## NOT in scope

- Windows packaging and Windows QA: the user explicitly limited this acceptance cycle to
  macOS; no cross-platform behavior contract changes.
- A repository-wide SQLite transaction framework or savepoint abstraction: T9 audits the
  completion/recovery spine and its migration owners, but does not rewrite unrelated
  stores that do not compose these aggregate writes.
- Ambient auto-join compatibility based on `DatabaseSync.isTransaction`: the repository
  is pre-release, so callers bind the correct explicit API and incorrect composition
  fails visibly.
- A new workflow engine, event bus, completion table, or transcript store: existing
  SQLite domain authorities already contain the required facts.
- Permanent legacy readers or enum aliases: Ling is pre-release, so local development
  rows are migrated or deliberately reset instead of carrying dual semantics.
- Model phrase classification for completion: provider wording cannot become durable
  execution truth.
- Automatic reassignment of an explicitly named participant: role/capability fallback is
  for unassigned requests only. A named unavailable or under-capable teammate blocks
  visibly until the user changes the assignment.
- Treating the Channel Ling Agent model as a fallback for workspace-default specialists,
  or synchronizing Channel creation into workspace settings: both violate the active
  model-binding ownership contract. Packaged QA that provisions a provider through raw API
  calls must configure the workspace default explicitly.
- Model-authored participant ids or a second participant-selection service: canonical
  Item mentions, deterministic role resolution, and the existing manifest already own
  identity and completion.
- A participant-profile snapshot table or migration: actual execution fields already live
  in the immutable Run request snapshot. The fix populates that authority rather than
  duplicating it in the manifest, graph, or another table.
- Replacing the user's currently running Ling client: packaged QA uses an isolated app
  path, data root, ports, and non-Git workspace.
- Native Codex app-server or Claude Code runner integration: both remain future adapter
  work. This slice borrows their typed-message/tool/result and resumable-session
  boundaries while keeping Ling's existing Pi runner and authorities.
- Host-bound tool-call operation ids: this is the later Codex/Claude-shaped endpoint, but
  it requires runner/tool protocol work. T8a does not fake it with same-Run command
  success, command substrings, stdout, or prose.
- Shell wrappers, environment-assignment prefixes, chained commands, redirects, and
  executable paths for `executable` matching: the first policy parser fails these closed.
  Supporting one later requires a separately reviewed structured command AST and exit
  semantics, not a broader regular expression.
- Exactly-once arbitrary local shell execution across process death: the operating
  system offers no transactional outcome query for a command that may have completed
  between `tool_start` and `tool_end`. This slice fails that window closed. A future
  durable executor may add idempotency-token lookup, but it cannot weaken today's safety.

## Final Verification Matrix

| Scenario | Required result |
| --- | --- |
| Create a file | one required create operation, `write` only, matching succeeded action |
| Create and run with Node | ordered create and command operations, `write + bash`, exit 0 evidence |
| `Node 调用 formatProof("7319")` | daemon materializes `executable=node`; clean single-command `node -e ...` evidence satisfies it |
| Explicit `node app.js` | daemon materializes `exact_command=node app.js`; only the same canonical command satisfies it |
| `Node 是什么` or `介绍 Node` | ordinary reply; no executable operation is authorized |
| Engineer + QA with no workspace default but a Channel Ling Agent model | one typed workspace-owned provider blocker, zero workflow/Run/approval/action, and a Model Workbench repair action |
| Engineer + QA after configuring the workspace default | both graph steps and Run snapshots use the workspace provider with source `workspace_default`; the Channel Ling Agent model remains unchanged |
| Custom Agent with unique base/append prompts and strict approval profile | exact Agent profile reaches FakeRunner and persisted Run snapshot; workflow tools remain only the required subset |
| Manifest-backed start supplies a different assignee or teammate loses a required tool before Run creation | one typed pre-Run blocker; no Task, Run, approval, substitution, or widened tool set |
| Executable Node evidence is `echo node ...`, `env node ...`, `sudo node ...`, or unrelated `ls` | no command evidence is credited |
| Executable Node evidence uses top-level `&&`, `;`, pipe, redirect, substitution, or newline | fail closed; aggregate shell exit cannot mask the required process |
| Executable Node argument contains a quoted semicolon | quote-aware parser keeps one simple command and may match |
| Legacy Pi runs Node successfully | terminal `isError=false` normalizes to exit 0 and final stdout is retained once |
| Legacy Pi command fails without an exit code | failed evidence with unknown exit code; never mislabeled as a numeric non-zero exit |
| Structured command omits exit code | fail closed with `required_command_missing_exit_code`; no legacy inference |
| Actual command is `echo node app.js` for planned `node app.js` | exact structured command match fails; no operation evidence is credited |
| POSIX file evidence differs only by case | target match fails on macOS/Linux; Windows retains case-insensitive matching |
| Runner omits requested command | step/workflow blocked, no succeeded final result |
| Delegated Agent emits only `ready`/"I will execute" | source Turn stays non-terminal until host writes a typed blocker; no action/workflow success is inferred |
| Required QA has no graph step or Run | Completion Gate and TerminalReport contain QA=`missing`; fan-in cannot verify and the visible result is blocked/partial |
| Old Attempt callback arrives after daemon restart | fence mismatch makes it diagnostic-only; no evidence, approval, resource, step, or report mutation occurs |
| Restart without safe checkpoint | work-kind policy emits `runtime_interrupted_no_checkpoint`; no new Run or silent retry is created |
| Restart after `tool_start` before `tool_end` | `approval_resume_effect_unknown` is persisted and no local side effect is replayed |
| SSE/RPC reconnect after final publication | replay from `lastAppliedSeq` refreshes once; Run/step/report/Turn counts remain unchanged |
| Package opens a pre-correction SQLite fixture | migrations 119-121 apply, same connection can begin a new transaction after injected faults, `foreign_key_check` is empty, and `integrity_check` is `ok` |
| Node exits non-zero or times out | step/workflow failed or retryable per policy, negative evidence retained |
| Single Agent performs both operations | both operations verified before the one step succeeds |
| Engineer writes, QA runs | each step verifies its subset; fan-in requires both |
| `；@QA` follows another mention | canonical materialization preserves QA in the Item, decision manifest, proposal, and workflow |
| `；@QA` is plain text and QA is hidden/inactive/out of Channel | the accepted Item still contains canonical QA; dispatch returns one `participant_unavailable_in_channel` blocker |
| Explicit Agent is asked to execute | intent selection precedes reply routing; work does not enter the no-tools `channel_ai_reply` path |
| A custom explicitly mentioned Engineer and the built-in Engineer both support the required tools | decision, manifest, proposal, graph step, requirement, and Run use the custom id; the built-in id is absent |
| An explicitly mentioned participant lacks a required tool | the named id remains in the blocked lineage with `participant_required_tools_unavailable`; no capable peer is substituted and no Run starts |
| Two explicitly mentioned participants share one role | both canonical ids survive; the multi-participant compiler maps both or returns `participant_operation_assignment_incomplete` before execution |
| An accepted proposal is retried after roster order/capability changes | reuse the original decision/manifest identity; do not re-run participant selection or rewrite the lineage |
| Delegated Agent says “I will execute” without a tool | no typed completed outcome; participant and source Turn cannot succeed |
| Required delegated step has no linked Run during recovery | atomic no-Run finalization commits `delegated_run_missing`; the step/workflow does not wait forever |
| Synthesis Agent writes a sourced result without tools | validated output-packet artifact satisfies synthesis; naked runner text does not |
| Synthesis projected file changes after sealing | sealed SQLite JSON/digest preserves completion truth; inspection path detects/repairs the projection |
| Synthesis packet row has no valid sealed payload | completion/publication blocks; row identity or file path alone is insufficient |
| Required QA step is absent | manifest/graph equality blocks compilation or completion with `required_participant_missing` |
| Graph declares a fan-in branch whose step row is absent | completion remains pending/blocked with `fan_in_branch_missing`; present rows cannot shrink the declared set |
| Required QA step is still running | `requireAllBranchesTerminal` keeps fan-in and workflow non-terminal |
| Required QA is blocked | completion gate and TerminalReport surface blocked/partial outcome; never success |
| Desktop-owned daemon restarts while QA waits for bash approval | old attempt becomes lost; same Run/approval/checkpoint/step/manifest/evidence remain; no cancellation rows are written |
| Graceful stop observes an initial pending or approved-but-unclaimed approval wait | one `approval_wait` suspension transaction preserves checkpoint/Run/work unit, loses the active Attempt, releases Run leases and Attempt slots, and commits three invalidations; any write fault rolls back all of it |
| User approves the preserved QA request after restart | one replacement WorkUnitAttempt resumes the same Run; exact checkpoint grant is consumed once; QA evidence can satisfy fan-in |
| Replacement Attempt is claimed while ordinary runtime capacity is unavailable | no `tool_start` or side effect occurs; the Run stays visibly pending/blocked according to the existing capacity policy and retained approval lineage |
| Replacement Attempt obtains runtime capacity | Run resource leases and replacement-Attempt semaphore slots exist before `tool_start` and are released by suspension, terminal settlement, or startup repair |
| Resumed QA asks for a changed command or target | prior approval is not reused; new approval or typed `approval_resume_mismatch` blocker is required |
| Old QA runner reports late after replacement attempt starts | callback is ignored by attempt/runtime fence and cannot create evidence or participant success |
| No safe Pi continuation can be constructed | step becomes `blocked(approval_resume_unsupported)` and workflow remains non-successful; it is not cancelled |
| Daemon restarts after checkpoint claim but before replacement Attempt exists | startup creates the bound Attempt once and continues the same Run |
| Daemon restarts after replacement Attempt starts but before `tool_start` | old replacement Attempt becomes lost; one newer fenced Attempt may continue safely |
| Daemon restarts after `tool_start` but before `tool_end` | no retry occurs; `approval_resume_effect_unknown` blocks the step/workflow visibly |
| Daemon restarts after `tool_end` but before Run finalization | canonical tool result is finalized once; the side effect is not executed again |
| Suspension transaction fails at any internal write | entire transaction rolls back; checkpoint/Run/work unit/Attempt/resources/audit/invalidation retain the old compatible state |
| Terminal or blocker transaction fails at any internal write | entire transaction rolls back; no half-terminal Task/Run/Attempt/checkpoint and no control-plane event is observable |
| Daemon stops after terminal transaction commit but before semantic reconciliation | startup finalizes the existing evidence and fan-in once; the approved side effect is not executed again |
| Resume transition occurs while control-plane SSE is disconnected | reconnect replay or snapshot reloads canonical progress; no work is resubmitted |
| Explicit user/workflow cancel at the same checkpoint | Run and approval become cancelled through the existing cancellation authority and fan-in reports cancellation |
| Idle/hard timeout at the same checkpoint | Run/attempt fail with typed timeout code; no `local-user` cancellation is recorded |
| TerminalReport succeeds | one final result; source user turn reaches matching terminal status |
| Query source-Turn transition through HTTP | `entityType=turn` is accepted and returns the same durable event recorded by publication |
| TerminalReport commits after workflow terminal state | post-commit invalidation refreshes Items and the open Channel renders the structured result without reload |
| TerminalReport publication event is replayed | one report Item/block and one source-turn settlement; projection refresh is idempotent |
| Control-plane reconnect keeps its cursor | events committed while disconnected replay and the report appears without reload |
| Publication lands during replay query | live-first subscription merges it once in sequence order without a handoff gap |
| Replay lookup fails after live registration | provisional subscriber is removed and response closed before the error escapes; later publish writes nothing |
| Client cursor is unavailable | snapshot handoff refreshes canonical Channel state before sequence `S` covers prior events |
| Event commits after snapshot `S` during refresh | provisional subscription buffers it and applies it once after the `<= S` refresh |
| Domain-filtered replay skips unrelated sequence numbers | replay remains complete; no false snapshot/reconnect loop |
| Queue coalescing mixes preserved and replaceable events | the complete SSE/RPC queue remains globally increasing by durable sequence; no invalidation is dropped by cursor de-duplication |
| Event retention leaves the workspace event table empty | durable replay state retains floor/latest; an older cursor gets snapshot-required rather than false complete |
| `runs + work_units` are coalesced | one runtime and selected-Channel refresh per batch; no unrelated normal-Conversation refresh |
| An old empty report query resolves after a new one | the stale result is ignored; the committed report remains rendered |
| Equivalent Item snapshot arrives during reference hover | stable Item/reference identity preserves the pending preview lifecycle; preview opens without focus or retry |
| Another Ling client with the same bundle id is running | absolute artifact launch plus isolated user-data/ports starts the intended package; PID, executable path, and startup `resourcesRoot` all match it |
| The production daemon owns the default remote-access port | isolated `LING_MOBILE_GATEWAY_PORT` lets the QA daemon start; no secondary listener collides with production |
| Production has persisted remote access as enabled | isolated `LING_STACK_HOME` prevents its installation-global identity, enabled state, and persisted listener port from entering QA |
| LaunchServices resolves the production app instead of the QA artifact | reject the run as invalid evidence; do not stop production or rewrite the signed QA bundle id |
| TerminalReport generation fails | source turn stays recoverable and publication retries |
| Daemon restarts after publication | source turn is repaired without another report/reply |
| Daemon restarts with a cached verified gate but newer/missing evidence | gate is recomputed from canonical rows; stale cached success cannot publish |
| SSE closes immediately after `ready` | one durable dispatch continues and produces one reply/workflow lineage |
| Segmentation provider stalls | bounded abort, conservative assignment, routing continues |
| Hard summary provider stalls | bounded projection fallback or visible over-budget blocker; no silent open turn |
| Daemon restarts before intent selection | accepted dispatch resumes once without duplicate Item, Turn, or reply |
| Non-Git macOS workspace | conversation, file tools, commands, and recovery work without Git requirement |

## Engineering Review Notes

### Architecture verdict

The amendment uses the existing SQLite, intent decision, workflow, `ExecutionAction`,
TerminalReport, approval-checkpoint, WorkUnit-attempt, and control-plane authorities. It
adds protocol facts where authority was missing and avoids a second scheduler, result
store, transcript parser, or approval table.
The load-bearing refinement is that `ExecutionAction` remains a derived projection whose
canonical backing rows enter the CAS, while output packets become content-addressed.
Success and negative workflow settlement now share one gate transaction.

The T7 review does not change that verdict. It tightens six implementation seams:
identity lookup precedes availability, missing-Run is an atomic negative outcome,
transport coalescing preserves durable order, `turn` observability reaches the public
contract, command/path evidence matches exactly, and dormant completion paths are
removed. All reuse existing authorities.

The T8 amendment also retains the verdict. It removes an accidental authority from
`targetRef.label` and places command matching in the durable operation contract. Exact
and executable policies are explicit, host-materialized, and verified against the same
`ExecutionAction`; no new scheduler, action store, or completion path is introduced.

The T8c amendment retains the same architecture. The reproduced failure came from
collapsing process shutdown into business cancellation. The correction uses the existing
logical Run plus process `WorkUnitAttempt` split, the existing `LingApprovalCheckpoint`,
and the existing delegated finalizer/gate. One new resume coordinator sequences those
authorities; it does not own a new completion rule. The post-implementation hardening
keeps that boundary: `resume_pending` is recovered from the checkpoint, Attempt, and
append-only tool events. It does not add a second resume table or pretend that arbitrary
local side effects are exactly-once.

The T8d.2a amendment also retains the architecture. Canonical Item mentions already own
requested identity and `RequiredParticipantManifestV1` already owns required completion.
The defect is ordering: role/capability selection runs before the manifest is built. The
correction resolves explicit ids once, validates them without substitution, and passes
that set into the existing one-step or multi-participant compiler. No new participant
authority or workflow engine is added.

T8d.2c also retains the architecture. The teammate row already owns configurable persona
and base approval policy, and the Run request snapshot already owns the effective inputs
used by one Run. The missing edges are the adapter and the durable provenance boundary.
Binding there preserves the clean split: manifest for identity/required outcome, explicit
participant authority for assignment provenance, Run snapshot for execution
configuration, operation policy for tools, and canonical evidence for completion. The
authority JSON requires migration 119, but no new profile table or generic prompt
auto-hydration is justified. `sourceProposalId` remains a source reference for proposal
origins; it is not the authority discriminator. `teammateTemplateId` remains descriptive
metadata.

### Rejected shortcuts

- Do not detect promise phrases such as “I will execute” or completion phrases in text.
  Wording is provider- and language-dependent and cannot support recovery.
- Do not fix only the `；@QA` regular expression. That restores one participant at input
  but leaves explicit mentions able to bypass execution selection.
- Do not special-case PromiseBot, prefer the last Engineer, or reorder built-in teammates.
  All three leave participant identity dependent on roster order. Explicit ids must beat
  role/capability fallback for every teammate.
- Do not silently choose a tool-capable peer when a named participant lacks a tool. That
  changes the user's assignee and makes the manifest truthful only about the substitute.
- Do not fix T8d.2 by appending PromiseBot's instruction to the test message or by special-
  casing its id. The actual teammate profile must reach every workflow Run through the
  shared adapter.
- Do not auto-load teammate persona inside the generic Run orchestrator. That path also
  owns selector, summarizer, and report Runs with explicit control-plane prompts.
- Do not require direct Channel membership for every workflow step. That makes a roster
  projection override durable handoff/custom/compaction/scheduling/fan-in assignments.
- Do not exempt only `teammateTemplateId` steps. Template identity is not a complete list
  of workflow-defined participant sources; the explicit trusted-origin authority is the
  durable provenance boundary. `sourceProposalId` is only a source reference.
- Do not pass `teammate.allowedTools` as the workflow Run tool list. It is an upper bound,
  while the operation-derived step subset is the actual least-privilege request.
- Do not change `workflows.ts` from “all existing steps succeeded” to another local
  boolean. The required participant/branch set must come from the accepted manifest.
- Do not make TerminalReport the completion judge. Reporting summarizes committed
  completion truth and closes publication; it does not prove tools ran.
- Do not add an `execution_actions` table just to make CAS convenient. Validate the Run
  events, approvals, artifacts, and Run snapshots from which actions are derived.
- Do not use a fixed 1000-row client replay loop as proof that no events were skipped.
  Replay completeness belongs to the server that owns the retention floor and upper bound.

### Test pyramid

```text
packaged macOS GUI
  Engineer + QA approval restart, second-crash windows, fan-in, SSE reconnect
          ^
Web/daemon E2E
  mention -> decision -> graph -> evidence -> report -> source Turn
          ^
orchestrator integration
  manifest equality, delegated outcomes, operation/dependency/fan-in gate
          ^
contracts/core unit
  canonical mention boundaries, validators, fingerprint, migration, idempotency
```

### Failure and rollback posture

Before packaged acceptance, keep the change on the isolated development branch. A
failure is recoverable from canonical Items, decisions, workflows, actions, and reports;
recomputation is idempotent. Because this is pre-release, incompatible development rows
are migrated once or explicitly blocked rather than supported through permanent dual
reads. Rollback is branch/worktree rollback, not a runtime compatibility alias.

### Performance

Mention materialization is linear in body length plus Channel participants at acceptance.
Explicit executable participant resolution is linear in the small canonical mention set
plus indexed teammate lookups; it skips roster-wide role search whenever ids were named.
The unassigned fallback retains one bounded effective-Channel scan. Existing-proposal
retries reuse persisted identity and therefore avoid another scan entirely.
Manifest and completion validation are linear in workflow participants, steps,
operations, actions, and edges. They add no provider call and no polling loop. Persist a
gate snapshot for audit/recovery, but recompute it only on relevant step/action/approval
transitions and startup reconciliation. Packet SHA-256 is recomputed over small sealed
SQLite JSON at finalization/gate/publication boundaries, so it adds bounded CPU/memory and
no filesystem I/O to the transaction. Replay queries use the existing workspace/domain
sequence indexes plus a captured upper bound and read at most `limit + 1` rows. The
single-row replay watermark update shares the event append transaction and adds no poller
or unbounded in-memory queue. Approval resume scans only pending/resume-pending
checkpoints for the opened workspace and starts at most one replacement attempt per
checkpoint CAS; it adds no global polling loop or participant-wide provider call.
Participant-profile resolution adds one indexed teammate lookup per new workflow Run and
adds a bounded effective-Channel membership check only for proposal-backed steps. Durable
workflow-definition steps avoid a roster/membership scan. Same-Run restart/resume reads
the existing Run snapshot and adds no teammate lookup or prompt reconstruction.
Explicit transaction ownership adds no query, provider call, or polling. Joined event
append keeps the existing event-row plus replay-watermark writes inside the aggregate's
single `BEGIN IMMEDIATE`; it removes a nested begin and does not add a savepoint. A
best-effort rollback is constant work on an error path and preserves the original error
for diagnosis.

### Security and privacy

The model cannot invent participant ids, grant tools, declare evidence, or close a Turn.
Canonical mentions validate identity, while proposal-backed Channel availability policy
produces a visible blocker without erasing the accepted request. Durable workflow
definitions remain the authority for their assigned participants, subject to active,
visible, tool, approval, and sandbox checks. Existing permission-filtered
context and tool approval boundaries remain unchanged. Outcomes and reports contain
evidence refs, not hidden reasoning. A recovered approval is a one-time grant for the
same normalized side-effect fingerprint; any changed command, target, scope, tool, or
delegated requirement requires a new approval. A durable `tool_start` without a matching
`tool_end` is treated as an unknown side-effect outcome and cannot consume another retry.
Teammate prompts remain behavior-shaping only: they cannot widen the exact workflow tool
subset or weaken the strictest approval/session policy merge.

### Resolved-decision verdict

The participant-authority decision is resolved in favor of the long-term contract:
explicit trusted origin, atomic graph/step persistence, fingerprint validation, immutable
participant binding, fail-closed final tools, and one strictest-policy adapter for every
start path. The smaller `!sourceProposalId` heuristic is rejected because it leaves
proposal crash windows, caller-authored authority, reassignment, tool widening, and
approval divergence.

The participant model-binding decision is also resolved in favor of the existing active
ownership contract. Channel Ling Agent model, workspace-default specialist, and fixed
teammate bindings stay separate. T8d.2d adds a typed shared resolver, proposal/step
preflight, binding-source snapshots, and repair projection; it does not add implicit
fallback or synchronize Channel creation into workspace settings.

No architecture decision remains open for this slice. The explicit transaction-owner
amendment is resolved in favor of separately named standalone and joined APIs, with no
ambient `isTransaction` inference or compatibility alias. The source implementation
already includes migration 119/120, trusted compiler origins, immutable participant/provider
bindings, shared run policy, typed provider preflight, and repair projection. S3.5 still
needs to promote the explicit Runtime fence, closed outcome codes/bindings, required
coverage projection, and single terminal publication into source. The previous
daemon/package acceptance is historical evidence; S3.5/S4/S5 must build on the completed
Node 22 transaction-owner correction, close the remaining contract gaps, and regenerate
broad and packaged evidence before PR/CI, merge, remote-main verification, and exact
cleanup. Exact deadlines, retry limits, UI
wording, and whether optional participants are shown expanded by default remain versioned
policy/UI settings. Host-bound operation ids and a structured wrapper/chaining AST are
explicitly deferred and cannot be approximated by this slice.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | --- | --- | --- |
| CEO Review | `plan-ceo-review` | Scope and strategy | 0 | NOT RUN | Existing product boundary retained; no scope expansion needed |
| Codex Review | `codex review` | Independent second opinion | 1 | RESOLVED IN SOURCE | Historical authority/tool/approval gaps are encoded by typed authority, immutable binding, and shared policy |
| Eng Review | `plan-eng-review` + pre-landing review | Architecture and tests | 25 | CLEAN (PLAN) | Explicit transaction ownership, fault recovery, and deterministic source matrix are green; S3.5/S4/S5 packaged and delivery evidence remain |
| Design Review | diff-scoped lite review | UI/UX gaps | 1 | CLEAN | No new UI design language or code-level accessibility/style regression |
| DX Review | `plan-devex-review` | Developer experience gaps | 0 | NOT RUN | Not required for this runtime correctness slice |

**CODEX:** The historical review identified non-atomic provenance and divergent final-tool/approval paths; the current source encodes the accepted typed-authority and shared-policy correction.

**CROSS-MODEL:** Both reviews agree on the semantic split. They differ on encoding: the first pass accepted existing provenance, while the outside review requires a typed trusted-origin authority boundary.

**RESOLUTION:** The outside-review encoding is accepted. `WorkflowParticipantAuthorityV1`
is now the normative contract, and the implementation plan adds migration 119, trusted
origin assignment, immutable binding, fail-closed tool resolution, and shared approval
merge before packaged acceptance. Provider binding separately retains the active
workspace/Channel/fixed ownership matrix and gains typed preflight rather than fallback.
The historical review rows remain as audit history; they do not represent an unresolved
product choice.

**VERDICT:** DESIGN AND EXISTING SOURCE GATES CLEARED; SUPPLEMENTAL S3.5 SOURCE
HARDENING AND PACKAGED DELIVERY NOT CLEARED. S3.5/S4/S5 must pass before PR/CI merge,
remote-main verification, or exact cleanup.

NO UNRESOLVED DECISIONS
