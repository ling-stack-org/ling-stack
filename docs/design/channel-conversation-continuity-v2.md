# Channel Conversation Continuity v2

Status: semantic completion/recovery is implemented. The current post-hardening source
matrix is green, and one fresh macOS arm64 artifact has passed configured Engineer + QA
fan-in, real Host write/command evidence, naked-`ready` blocking, missing-provider
blocking, daemon restart, SSE disconnect/reconnect, replay idempotency, and canonical
SQLite-lineage checks. The same artifact also passes the no-checkpoint/effect-unknown
restart windows and the old-schema migration 119-121 rollback/reopen fixture. Only the
repository delivery gate remains; historical package hashes are not reused as current
release evidence.
Date: 2026-08-08
Last verified: 2026-08-25
Scope: channel conversation persistence, Thread/Turn/Item topology, context segmentation,
context projection, rolling summaries, multi-agent recovery, and Channel Intent Decision v2

## Harness Integration Boundary

The [channel sessions contract](channel-sessions-detailed-design.md) extends this continuity
model with `channel_session` (`relationKind=root`) for an empty named conversation. It uses
the same Thread/Turn/Item/segment and recovery authorities. It does not copy another
conversation's history or use fork snapshots; real forks retain `branch` lineage.
Canonical `LingThread.id` is the session ID, including the existing default channel root.

The Ling product model and the execution harness are deliberately adjacent, not
interchangeable. Adapters may translate between them, but neither side may silently
become the other's authority:

1. **Timeline authority.** The Ling timeline is the only conversation authority. A
   harness transcript is execution evidence and a message projection only; it must not
   be replayed as canonical conversation history.
2. **Immutable run input.** `ChannelContextView` is the immutable projection captured
   before a Run is created. It is not mutable Channel state, and later Channel changes
   must not rewrite the Run's input lineage.
3. **Product versus execution semantics.** `LingThread` and `LingTurn` describe product
   conversation semantics. Codex Thread and Turn describe harness execution semantics.
   The adapter preserves both identities and does not merge the two models.
4. **Approval protocol bridge.** Ling approval is an asynchronous, durable,
   event-driven product event. Harness approval is a synchronous, blocking RPC. The
   approval adapter bridges the wait and wake-up semantics while keeping Ling's event
   as the source of truth.
5. **Durable approval ownership.** Durable approvals are managed by Ling. The harness
   only implements the approval adapter and reports request/decision evidence; it does
   not own approval persistence or lifecycle authority.

### Typed RunEvent boundary

`RunEventEnvelope` is execution evidence, not a second conversation record. Its
`type` is now a discriminant for `data`: producers append a payload from the matching
`RunEventDataByType[K]`, and consumers narrow on `event.type` before reading fields.
Provider-specific details may remain in bounded opaque fields (`args`, `result`, or
metadata), but the envelope itself may not fall back to `unknown`.

The SQLite event log is a replay boundary. Rows are validated as JSON objects when
read, malformed payloads fail closed, and replay consumers must be idempotent. A
replayed event may update a deterministic projection, but it must not create a second
Ling turn, approval authority, artifact authority, or canonical history entry.

### Conversation Item projection boundary

The existing `ConversationItemV1` model is the Item layer; no second Item table or
mutable execution store is introduced:

```text
Ling timeline authority
  ├── LingThread
  ├── LingTurn
  └── ConversationItem

execution evidence
  └── RunEventEnvelope

typed, read-only projection
  └── rich timeline / activity UI
```

The core projection maps assistant deltas, tool start/end, approval request/decision,
artifact creation, and terminal/intervention state into typed Items. Item identity is
deterministic (`run + event domain key`), tool and approval pairs are matched by their
IDs, and incomplete pairs remain renderable rather than crashing replay. The projection
owns neither Run, Approval, Artifact, nor workspace state; it stores only domain refs.
Its sequence is projection-local and must not be written directly into the canonical
SQLite Item sequence allocator. UI code must render the typed kind/payload instead of
inferring tools or approvals from prose.

### `workspace_knowledge` provider boundary (reserved)

`ChannelContextSourceKind` reserves `workspace_knowledge` for a future provider that
can inject bounded, structured workspace facts such as `AGENTS.md`, design documents,
quality levels, and workspace policy. This slice intentionally provides no source
provider or automatic injection path. A future provider must return source refs,
freshness, quality metadata, and bounded text; pass through the same sensitivity,
permission, and `ChannelContextView` filtering as every other source; and define a
refresh/revalidation policy for long-running autonomous Runs.

### Post-compaction undo boundary (reserved)

Compaction may reduce prompt context, but it must never delete workspace-change
provenance. Undo semantics are deferred until the Continuity v2 compaction implementation
freezes these facts:

- the exact workspace snapshot or patch basis to which undo returns;
- a durable chain from compacted Turns to `RunArtifact`, patch plan, Run lineage, and
  source refs;
- a fail-closed rule when the target snapshot cannot be verified.

A condenser summary is context evidence only; it is never the authority for undo. A
future implementation must answer how changes from compacted Turns are traced before
exposing an undo action.

## Current release checkpoint (2026-08-25)

The clean delivery worktree is based on `origin/main` at `ea1f580f0e6cc57fe07dca4f8615be3b28ae35b8`.
Source gates pass: Contracts `46/46`, Core `445/445`, and Daemon `1090/1090`.
The fresh packaged smoke runner is `apps/desktop/tests/run-packaged-continuity-smoke.mjs`
(`pnpm --filter @ling-stack/desktop smoke:continuity:mac`). Its post-build evidence is:

- ZIP SHA-256: `4cfc3e7e432fa98531d858b603be88f364d60cdea275c66bdecd787d66def8cc`;
- DMG SHA-256: `f25ee6683db6aeeacde8f83d92037b884630511a8d5463abe2d6f7bcf2a14ffe`;
- bundle `codesign --verify --deep --strict`: passed;
- packaged smoke: passed, including launch/health, SSE disconnect/reconnect, real
  Engineer write, exact QA command, required-participant fan-in, one TerminalReport and
  final Item, naked-`ready` and missing-provider blockers, safe checkpoint/no-checkpoint/
  effect-unknown restart classification, daemon restart, replay idempotency, migration
  rollback/reopen, foreign-key check, and integrity check.

The package uses an Apple Development identity and is not notarized; `spctl` rejection
(`exit 3`) is expected for this local QA artifact and is not a distribution-readiness
claim. The packaged runtime and SQLite upgrade gates are complete; delivery still requires
final diff review, PR/CI, merge, remote-main parity, and exact QA cleanup.

Related docs:

- [Ling Agent Session Control Plane](ling-agent-session.md)
- [Channel Context Processing Layer](channel-context-processing-layer.md)
- [Channel Context Processing Layer Implementation Plan](channel-context-processing-layer-implementation-plan.md)
- [Channel Context Budget Manager](channel-context-budget-manager.md)
- [Thread-First Work History v2 Detailed Design](thread-first-work-history-v2-detailed-design.md)
- [Conversation Memory Citations And Sources](conversation-memory-citations-and-sources.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)
- [Channel Execution Completion Implementation Plan](channel-execution-completion-implementation-plan.md)

## Delivery Evidence

Continuity v2 was delivered through the ordered slices defined by this contract:

- G0 CI gate repair: PR #423, squash commit `3057b2af`;
- S0 contracts and fixtures: PR #425, squash commit `264ebd3a`;
- S1+S2 atomic storage and runtime cutover: PR #426, squash commit `dd2c9ed9`;
- S3 shared context projection: PR #427, squash commit `09d2031b`;
- S4 intent v2: PR #428, squash commit `2d9a5375`;
- S5 summaries and snapshots: PR #429, squash commit `e67fde1d`;
- S6 multi-agent consistency: PR #431, squash commit `9a54d9dc`;
- S7 API, Web, diagnostics, and authority cleanup: PR #432, squash commit `1aed5b13`.

PR #432 passed remote CI on its final head and the merged `main` commit passed run
`31392694904`. Final local acceptance passed 36 Contracts, 362 Core, 905 Daemon,
49 API Client, 40 Remote Protocol, 45 Web unit, 113 Channel E2E, and 15 adjacent
Channel E2E tests. Issue #421 closed from PR #432 after the merge.

The 2026-08-12 execution-completion amendment below closed three post-delivery gaps that
are not covered by those historical test counts: one `execute` decision must describe all
required operations, a workflow cannot succeed without evidence for every required
operation, and the source user `LingTurn` must reach the same durable terminal outcome
after its final result is published. The amendment is normative and its implementation
plus acceptance plan is complete. The completion, atomic publication,
bounded replay, daemon transport, and Web snapshot-handoff slices are focused green as of
2026-08-14; the six complete-diff hardening fixes and deterministic matrix are green.
The first isolated packaged macOS run passed ordinary reply and continuity recall, then
exposed the command-policy gap specified below. Typed exact/executable command binding is
now implemented. The fresh deterministic matrix is green. The final signed artifact
passed package integrity, isolated startup, health, provider readiness, packaged
restart/reconnect, and SQLite-lineage acceptance.

The next packaged run passed file creation, Node execution, evidence publication, and
single-Agent completion. This is historical behavior evidence, not current release
evidence. The accepted single-Agent `execute` request compiled to one
manifest-backed workflow step; its Run, step, workflow, TerminalReport, and source Turn
converged to `succeeded` through the shared completion protocol. A sample taken during
terminalization briefly saw the ready acknowledgement while the source Turn was still
running, but the canonical SQLite lineage did not remain split. This is a valid
observation window, not a second direct-execution completion path: clients must continue
to render progress until the final-result publication barrier settles the source Turn.

The same packaged run then reproduced a distinct lifecycle bug in the required
Engineer + QA workflow: restarting the Desktop-owned daemon while QA waited for a bash
approval aborted the in-memory runner, mapped that infrastructure abort to user
cancellation, cancelled the durable approval, and left the QA step blocked. Engineer
evidence and the manifest remained durable, so fan-in failed closed as designed. The
restart-resume amendment below is now normative; packaged acceptance cannot pass until a
daemon lifecycle stop suspends the process attempt without cancelling logical work.

The T8d.2 setup exposed one earlier participant-selection defect before the naked-ready
assertion could run. The accepted Item correctly preserved a structured mention of a
custom Engineer, but single-step executable selection ignored that identity, selected the
first role-compatible built-in Engineer, and then built the manifest, proposal, workflow,
step, and Run around the substitute. The completion layers remained internally
consistent, but they were consistently attached to the wrong participant. The explicit
participant precedence amendment below is therefore a P1 prerequisite to T8d.2 and all
later multi-Agent/recovery acceptance. T8d.2a now resolves explicit ids first, preserves
same-role participants as distinct requirements, validates named tool availability
without substitution, shares operation ownership between selection and workflow
compilation, and reuses accepted proposal lineage. Its four new participant regressions,
four adjacent Channel regressions, 50 workflow-operation/evidence tests, and the full
1031-test Daemon suite are green. The artifact used to discover this defect predates the
correction; the next artifact included it and became the reproduction target for the
execution-profile defect described below. It is not post-fix acceptance evidence.

T8d.2b converts a recovered proposal with missing or inconsistent decision/manifest
lineage into one idempotent `existing_proposal_participant_lineage_invalid` blocker. Its
focused JSON/SSE cases and the full 1033-test Daemon suite are green. The earlier 115/116
aggregate Channel result was a test synchronization defect: the case observed two early
requests and waited a fixed 300 ms even though `refreshChannelActivity()` still had a
sequential state-transition refresh before cursor application. The regression now waits
for that terminal projection fact. It passes 5/5 focused and the complete Channel suite
passes 116/116 without weakening the last-applied-cursor rule. That historical checkpoint
is superseded by the source-side T8d.2c authority correction and T8d.2d provider preflight;
delivery now waits on the new fixture/regression closeout, a fresh rebuild, and then
delegated blocking, restart/fan-in, reconnect, and canonical lineage against SQLite.

The next packaged T8d.2 run proved that participant identity and participant execution
profile are separate boundaries. The accepted Item, manifest, graph step, and Run all
named the requested PromiseBot, but the workflow-step adapter copied only
`teammateId`, provider/runner selection, and required tools into the Run request. It
dropped the teammate's `systemPrompt`, `appendSystemPrompt`, and `approvalProfile`.
PromiseBot therefore ran with the generic workflow prompt, called bash, and entered tool
approval instead of returning its configured no-tool acknowledgement. The completion
gate did not fail; the test never reached the intended naked-`ready` condition. The
participant execution-profile binding amendment below is now T8d.2c and a P1 prerequisite
to rebuilding the artifact and resuming packaged acceptance.

The source-side T8d.2c adapter now propagates the exact teammate base prompt, append
fragments, approval profile, and operation-derived tool subset. Its focused profile cases
pass 3/3, the atomic pre-Run blocker case passes 1/1, and workflow operation/evidence
passes 51/51. The first 205/213 result exposed the template-only membership heuristic;
the participant-authority correction now covers handoff, custom graph, compaction,
smart scheduling, and fan-in workflow definitions without treating missing membership
rows as unavailability. That source correction, the broad authority matrix, and the
provider-preflight fixture described below are now green.

The participant-authority correction and its broad deterministic matrix subsequently
returned to green. T8d.2d is implemented in source: typed provider binding and blocker
contracts, proposal-time required-participant preflight, immutable graph/step and Run
snapshots, first-Run revalidation, proposal blocker persistence, and workspace/Channel/
teammate repair actions are present. The fixture and late-unavailability, frozen-override,
and same-Run snapshot cases are now green. Final adversarial hardening also restores the
complete terminal dispatch result on idempotent replay and unions same-participant
operation ownership during migration. The final suite passes 1041/1041.

The final 2026-08-17 isolated packaged acceptance used the freshly built arm64 artifact
with ZIP SHA-256 `aa5153e2da8c836005f9d2b152aa0764692dfe268af8d74865c8d0d5d5578423`
and DMG SHA-256 `9e3ef5357f79c53382bb29470c915649f2d48629ab3d0a8a0496da293c2d4512`.
It proved three-fact recall through the actual model request, real write and Node actions,
an actionable missing-workspace-default blocker with zero workflow/Run/side effect,
naked-ready blocking, and required Engineer + QA fan-in across a Desktop-owned daemon
restart. In the final post-review lineage, workflow
`workflow_c86778e2-1630-40ff-87eb-89f6fed6c133` retained Engineer Run
`run_4c5eba35-6883-4bdc-b15e-f7d2c2efa22f` and QA Run
`run_ced1baba-1224-42ab-bf42-7efc98ff0208`. QA Attempt 1 became `lost` with
`runtime_suspend/daemon_restart`, Attempt 2 succeeded under the same Run, both participant
outcomes carried distinct approval-backed action evidence, the Completion Gate became
`verified`, and one TerminalReport, final Item, and source Turn settlement committed.
The same artifact also re-ran the naked-ready and typed missing-default blockers; the
latter left workflow/Run counts and the workspace-file hash unchanged. `foreign_key_check`
was empty and `integrity_check` returned `ok`. The still-open GUI recalled the earlier
facts after daemon/SSE reconnect without resubmitting accepted work. After the final
adversarial replay fix, the exact packaged daemon replayed the original completed
multi-Agent POST with the same Turn, assistant Items, proposal, workflow, and two steps;
workflow and Run counts did not increase.

The app bundle passes `codesign --verify --deep --strict`. It uses an Apple Development
identity and is not notarized, so `spctl` exits `3`; this is valid for local packaged QA
but not a distribution-readiness claim. The missing-workspace-default blocker body is
still English inside the Chinese UI and remains a presentation-localization follow-up,
not a completion or recovery correctness gap.

That artifact remains historical behavior evidence after the Node 22 transaction defect
was reproduced. Aggregate publication/recovery stores could bind a standalone control-
plane event writer, which attempted a nested `BEGIN IMMEDIATE`; their catch paths also
trusted `DatabaseSync.isTransaction` before rollback even though Node 22 can report false
inside the owned transaction. The semantic lineage above is unchanged, but fresh release
acceptance must follow the explicit transaction-owner amendment in principle 36.

## Decision Summary

Ling keeps SQLite. The current failure is not that durable history is missing. The failure
is that durable records do not form one logical conversation timeline and each consumer
builds a different short context window.

The long-term model is:

```text
Channel                         collaboration, membership, permissions, protocol
└── LingThread                  one durable conversation line
    └── LingTurn                one user-intent lifecycle
        └── ConversationItem    ordered observable input, output, action, and result
```

The approved decisions are:

1. `conversation_items` becomes the canonical conversation timeline and eventually
   replaces `channel_messages`. `channel_messages` is not expanded into a universal item
   table.
2. `LingTurn` is created for every accepted user turn, including ordinary conversation.
   Whether work executes is a turn outcome, not the condition for creating a turn.
3. Channel root, explicit topic, and branch are separate `LingThread` surfaces with
   explicit lineage. A topic or branch does not copy the parent transcript.
4. `contextSegmentId` is a reversible semantic working-set assignment inside a thread.
   It is not another thread and it is not privately chosen by each agent.
5. One `ConversationContextProjector` builds all selector, reply, target-resolution,
   workflow, and specialist views from the same committed sources.
6. Rolling summaries are proactive, versioned, coverage-aware, and source-linked. A
   provider context-length error remains a fallback signal, not the primary trigger.
7. Multi-agent recovery uses shared core facts plus role-relevant evidence and
   permission-allowed private memory. No agent receives the full raw transcript by
   default.
8. `ChannelIntentDecision.schemaVersion` moves directly to v2. In this pre-release phase
   there are no v1 aliases or dual-read compatibility paths. `single_reply` becomes
   `reply`; `direct_workflow` becomes `execute`.
9. An ordinary `reply` may use a supervised `RunSession` with `tools=[]` and read-only
   workspace policy for streaming, cancellation, FIFO guidance, recovery, and diagnostics.
   The owning `LingTurn` remains the business lifecycle authority; the Run is not a second
   conversation authority.
10. An active reply never captures a whole Channel. Follow-up routing requires a typed
    client disposition and server validation against the same conversation line. Without
    that structural relation, the message continues through normal intent selection.
11. An `execute` decision owns a typed operation graph, not one lossy action label.
    Daemon code derives tools and materializes targets for every operation before a
    proposal or workflow can start.
12. Run success is attempt evidence, not user-task completion. Required operation
    evidence, dependency order, workflow state, final-result publication, and source
    `LingTurn` settlement form one idempotent completion protocol.
13. Final-result publication has an explicit atomic barrier and live-projection handoff.
    One SQLite transaction commits the canonical assistant Item, publication marker,
    source-turn settlement, Turn transition evidence, and content-free control-plane
    invalidation against a fresh Completion Gate basis. The event wakes clients after
    commit; it is never the report or message authority.
14. Mention materialization happens before intent selection. An `@Agent` token identifies
    a requested participant; it never chooses `reply`, bypasses execution selection, or
    grants tools by itself.
15. Every accepted decision owns one immutable `RequiredParticipantManifestV1`.
    Explicitly requested participants cannot disappear when a proposal is compiled into
    a workflow or when one participant returns an incomplete reply.
16. Delegated work ends only through a typed `DelegatedOutcomeV1`. A normal assistant
    message with delivery state `ready`, including text such as “I will execute”, is not
    delegated completion and cannot close an execution Turn.
17. Multi-Agent success passes one deterministic `WorkflowCompletionGate`: required
    participant coverage, required operation evidence, dependency order, and fan-in
    policy must all be satisfied. TerminalReport publication happens after this gate and
    does not repair missing work.
18. A terminal runner callback is only a reconciliation trigger. The same delegated-step
    finalizer handles online callbacks, post-step approvals, startup recovery, duplicate
    callbacks, and pre-publication checks. No path may map `Run.status="succeeded"`
    directly to step or workflow success.
19. SSE and local RPC are observer transports. Disconnect, reconnect, or replay failure
    can change what a client currently sees, but never owns, cancels, or completes the
    accepted Turn, dispatch, Run, workflow, report, or source-Turn lifecycle.
20. Command evidence matching is a daemon-materialized operation policy, not a display
    label or model choice. Exact commands and explicit executable identities use separate
    typed policies; both consume the same structured `ExecutionAction` evidence.
21. Cancellation is a business action, not a synonym for process shutdown. Only an
    explicit user/workflow cancellation may write `run_cancelled`, cancel pending
    approvals, or settle a delegated outcome as `cancelled`. Daemon restart, Desktop
    quit, and process signals suspend or lose the current attempt without changing that
    logical meaning.
22. `RunSession` is the logical execution lineage and `WorkUnitAttempt` is one
    process-owned attempt. A recoverable approval boundary keeps the same Run, workflow
    step, participant manifest, approval, and accumulated evidence while startup creates
    a new fenced attempt. If safe resume is unavailable, Ling returns a structured
    `approval_resume_unsupported` blocker; it never fabricates cancellation or success.
23. `resume_pending` is a durable recovery state. Startup classifies the bound
    replacement Attempt and canonical `tool_start/tool_end` evidence: retry only before
    dispatch, finalize existing terminal evidence, and block as
    `approval_resume_effect_unknown` when a local side effect may have occurred.
24. Runner resume support is a typed capability, not a runner-name heuristic. Pi declares
    no native resume and supports only the host-bounded action types it can safely
    continue from the immutable checkpoint.
25. Resume progress is observable through idempotent control-plane invalidations, but
    replay/SSE/RPC remains projection-only. A client refreshes canonical state and never
    restarts or completes work from an event payload.
26. Every accepted Channel `execute` decision compiles to a manifest-backed workflow,
    including a single requested participant with one step. Its Run must carry
    `workflowStepId`; Ling does not maintain a direct delegated-execution completion
    branch beside the workflow finalizer and Completion Gate.
27. A ready acknowledgement such as “开始处理” is progress narration, not a final result.
    For an `execute` Turn it may remain as an ordinary assistant Item, but only a published
    TerminalReport Item plus compatible source-Turn settlement closes the user task.
28. Participant identity is fixed before capability fallback. After intent selects
    executable work, one or more canonical explicit teammate mentions are the exact
    required participant set. Role/capability selection is legal only when that set is
    empty. A named participant that is unavailable, lacks a required tool, or cannot be
    assigned the requested operations produces a typed blocker or clarification; Ling
    never silently substitutes another teammate with the same role.
29. Operation ownership is derived once from the accepted operation graph and resolved
    participant list. Participant manifests, required-tool checks, proposal collaboration
    steps, and workflow graph compilation consume the same deterministic owner map; no
    later compiler may independently redistribute operations.
30. Idempotent proposal recovery reuses the original accepted decision, participant
    manifest, and proposal ids. If a proposal exists without compatible decision/manifest
    lineage, recovery emits a durable structured
    `existing_proposal_participant_lineage_invalid` blocker through normal Turn settlement.
    It never reselects participants, starts work, or exposes the storage inconsistency as
    an unstructured request failure.
31. Participant identity and participant execution profile have different freeze points.
    The accepted decision freezes the participant id, operation ownership, and delegated
    requirement. Immediately before the first Run is created, the workflow-step adapter
    resolves that exact canonical teammate, copies its prompt fragments and approval
    profile into the Run request, and freezes the effective values in the existing Run
    request snapshot. Restart and approval resume reuse that same Run snapshot; they do
    not resolve a different teammate or rebuild the persona. Workflow-required tools stay
    an exact operation-derived subset and are never widened to the teammate's full tool
    allowance.
32. Participant eligibility depends on who selected the participant. A proposal-backed
    Channel workflow revalidates current effective Channel membership/council policy at
    first Run creation. A template, handoff, custom graph, compaction, scheduling, or
    fan-in workflow treats its durable workflow definition as the assignment authority
    and does not require an additional Channel membership row. Both paths still require
    the exact teammate to exist, remain active and visible, and retain every required
    tool. Neither path may substitute another teammate.

33. The semantic split in principle 32 is encoded by an explicit
    `WorkflowParticipantAuthorityV1`, not by field absence. The authority is written in
    the same transaction as the workflow graph and step, includes a trusted origin and
    source reference, and is fingerprinted against canonical JSON.
34. `toParticipantId`, `toParticipantLabel`, and participant authority are immutable after
    graph acceptance. Public PATCH schemas omit these fields; Core rejects attempts to
    change them. Any authority/participant mismatch is a typed lineage blocker with no
    Task, Run, approval, or side effect.
35. The workflow-step adapter is the single run-policy boundary for manual start,
    automatic orchestration, retry, approval resume, and direct step start. It resolves
    the exact participant, applies authority-specific membership rules, computes
    `requiredTools ?? []` as a fail-closed subset, and merges teammate/step/Skill/session
    approval policy by the strictest rule before freezing the Run snapshot.
36. SQLite transaction participation is explicit. A standalone control-plane event append
    always owns `BEGIN IMMEDIATE`, commit, and best-effort rollback. Aggregate stores bind
    only `appendControlPlaneEventWithinTransaction()`, which writes the event and replay
    watermark without opening or closing the caller's transaction. The owner that issued
    `BEGIN IMMEDIATE` attempts rollback on every exceptional exit and preserves the
    original error; runtime code never infers ownership from
    `DatabaseSync.isTransaction`. In-memory SSE/RPC publication remains post-commit only.
37. Attempt fencing is a Runtime Control Plane contract, not an orchestrator convention.
    Each logical Work Unit/Run has at most one active Attempt pointer. An Attempt carries
    the immutable `runtimeInstanceId` and monotonically unique `fencingToken` issued by
    its claim transaction. Every mutating callback, heartbeat, lease release, evidence
    append, approval consumption, and terminal transition must compare-and-set that
    tuple; a late callback from any older Attempt may be recorded as diagnostic evidence
    only and can never change canonical work state.
38. Daemon restart recovery is bounded by a durable checkpoint. At a safe approval
    checkpoint, restart keeps the same logical Run, step, manifest, approval, and prior
    evidence, marks the old Attempt `lost`, and creates one new fenced Attempt. Without a
    safe checkpoint, Ling does not promise automatic continuation: the work-kind policy
    publishes a typed `runtime_interrupted_no_checkpoint` block/failure. A durable
    `tool_start` without `tool_end` always becomes effect-unknown and is never retried.
    This is not a workflow retry and never creates a new Run or reselects participants.
39. Required-participant coverage and actual participation are separate report facts.
    Completion Gate input must contain every manifest-required participant, including
    `missing`, `blocked`, `failed`, or `cancelled` results. TerminalReport may omit
    optional or never-started agents from the visible contribution summary, but it must
    retain a source-linked required-coverage record so a missing required participant is
    shown as a blocker rather than as an empty or successful contribution.
40. Delegated outcome validation is closed and evidence-bearing. `completed` requires
    at least one unique evidence ref and the host verifies operation coverage for the
    immutable requirement. Block codes come from a closed `DelegatedBlockCodeV1` set;
    blocked/failed/cancelled outcomes carry host-owned participant/workflow/step refs
    and may not be fabricated by model text. A blocked outcome always has the
    `evidenceRefs` property, but the array may be empty when no action started; in that
    case its non-empty `missingRequirements` and closed code must be derived from
    canonical Host state. Missing evidence fields, empty completed evidence, and unknown
    block codes are rejected before persistence.
41. `TerminalReport` is the only user-visible terminal result. Workflow cards and
    activity rows may show folded progress/evidence while a Run is active, but after a
    committed report they cannot publish a second terminal summary/count. A report
    publication marker and final-result Item are one idempotent terminal projection,
    uniquely keyed by the owning source/Turn rather than a mutable gate/report revision;
    duplicate callbacks, replay, and reconnect may refresh the same durable Item but
    never create another terminal publication.

## Execution Truth Ladder

Ling deliberately keeps four completion layers separate. A higher layer may consume a
lower layer's facts, but it may not infer or rewrite them:

```text
Layer 1: attempt/process truth
  Run + Run events + approvals + artifacts
  "the runner stopped and these tool events exist"
                |
                v  host validates immutable delegated requirement
Layer 2: delegated-step truth
  DelegatedOutcomeV1 + compatible workflow-step transition
  "this participant satisfied, blocked, failed, or cancelled its assigned requirement"
                |
                v  manifest/graph/dependency/fan-in evaluation
Layer 3: workflow truth
  WorkflowCompletionEvaluationV1 + workflow transition
  "all required participants and operations satisfy the workflow termination policy"
                |
                v  fresh read-set revalidation + atomic publication
Layer 4: user-result truth
  TerminalReport + final Item + source Turn settlement + durable invalidation
  "the result is durably visible, traceable, and recoverable by every client"
```

The four reported failures are violations at these boundaries:

| Failure | Incorrect collapse | Required boundary |
| --- | --- | --- |
| Delegated Agent stops at “I will execute” | visible assistant `ready` was treated as Layer 2 completion | `ready` remains delivery state; only host-validated evidence or a structured blocker creates `DelegatedOutcomeV1` |
| Orchestrator accepts text-only completion | runner narration was treated as action/result authority | adapter callbacks are wake-up hints; the host reloads canonical Run/action/packet/approval rows and finalizes the immutable requirement |
| Multi-Agent succeeds before every required participant finishes | the set of materialized successful steps was treated as the required branch set | the accepted participant manifest and immutable graph define the set; one Completion Gate evaluates all required participants and fan-in policy |
| Restart/reconnect loses or hides the result | process/transport lifetime was treated as workflow or publication ownership | daemon startup recomputes Layers 2-4 from SQLite; SSE/RPC only replay or snapshot the committed projection |

This ladder also defines naming. `Run.status="succeeded"` and
`WorkUnit.status="succeeded"` mean that an attempt/process completed successfully; they
do not mean a delegated requirement, workflow, or source user Turn succeeded. A
manifest-backed step reaches `succeeded` only in the same transaction that records a
valid delegated outcome. A workflow reaches `succeeded` only in the Completion
Evaluation transaction. A source Turn reaches `succeeded` only in the final-result
publication transaction.

No model response can directly write any of these terminal states. The model may produce
narration, tool requests, or a schema-valid blocker candidate. The host resolves ids,
validates ownership and policy, derives evidence from canonical rows, and commits the
corresponding layer through compare-and-set storage APIs.

Client observation remains outside the truth ladder. SSE/RPC delivery, a successful Web
refresh, and rendered UI are projections of Layer 4, not another completion layer. They
may be delayed or rebuilt without changing canonical completion. The overloaded word
`ready` is therefore always qualified by owner: Channel-stream `ready` means acceptance
data is durable; assistant delivery `ready` means text is renderable; neither means a
delegated step or workflow succeeded.

### Single-participant execute normalization

Single-Agent and multi-Agent execution use the same completion topology. Participant
count changes the graph shape, not the authority model:

```text
accepted execute decision
  -> RequiredParticipantManifestV1
  -> immutable workflow graph
       one participant  -> one required step
       many participants -> fan-out / dependency / fan-in steps
  -> Run(s) with workflowStepId
  -> DelegatedOutcomeV1 per required step
  -> WorkflowCompletionEvaluationV1
  -> TerminalReport publication + source Turn settlement
```

The proposal compiler must reject or block an accepted `execute` decision that cannot
materialize the required participant into the graph. It must not fall back to a free
`channel_ai_reply` Run with tools. Ordinary `reply` Runs remain separate: they use
`tools=[]`, may publish a normal assistant reply without a workflow, and settle according
to reply semantics rather than delegated evidence.

There can be a short durable observation window after a Run becomes terminal and before
the shared finalizer, Completion Gate, and publication transaction finish. During that
window the source Turn remains `running`, and an earlier ready acknowledgement may still
be the newest visible Item. This is legal only because the terminal callback awaits the
shared reconciler and startup recovery independently redrives the same canonical state.
A reconnect, browser refresh, or new user message must not be required to trigger
completion. If canonical state does not converge, recovery publishes a structured blocker
instead of treating the acknowledgement as the result.

### Completion Gate success predicate

The success condition is a conjunction over the accepted authority set, not a count of
successful callbacks or currently materialized step rows:

```text
verified(workflow) =
  decision/manifest lineage is valid
  AND immutable graph fingerprint is valid
  AND every required participant is represented by its accepted graph step(s)
  AND every required participant has DelegatedOutcomeV1.completed
  AND every completed outcome resolves to the evidence class required by its assignment
  AND every required operation and dependency is satisfied in graph order
  AND fanInPolicy permits termination
```

A required participant that is absent, active, or otherwise non-terminal keeps the gate
`pending`. A required participant with a validated `blocked`, `failed`, or `cancelled`
outcome produces the compatible non-successful workflow result. Invalid lineage,
requirements, or evidence fail closed as `blocked`; they never become a smaller quorum.
Optional participants do not enlarge the required quorum unless the immutable graph or
`fanInPolicy` explicitly makes their output a dependency. Once accepted, recovery cannot
remove a required participant, replace it with another same-role participant, or rewrite
the policy to make the join pass.

The gate is recomputed from canonical rows by the shared semantic reconciler on online
terminal callbacks, post-approval continuation, daemon startup, duplicate callbacks, and
pre-publication validation. Those triggers may request reconciliation; none may supply a
success result. This keeps one predicate authoritative across single-Agent execution,
multi-Agent fan-in, restart recovery, and reconnect-driven refresh.

## Problem And Evidence

GitHub issue [#421](https://github.com/tianxiaochannel-oss88/ling-stack/issues/421)
shows the immediate product failure:

- a conversational continuation such as `需要，开始吧` is interpreted as
  `direct_workflow/file_create`;
- file target validation then asks for a path that the user never intended to provide;
- the generic clarification becomes recent context and influences later unrelated turns;
- the same request can behave differently in a fresh channel because it has a different
  short recent-message window.

The historical implementation persisted the underlying messages and decisions but
constructed different views. The Continuity v2 WIP replaces these independent windows
through the shared projector; the list below remains the root-cause baseline, not the
target state:

```text
ordinary reply            -> recent 6 messages
intent selector           -> recent 8 messages, bodies truncated
workflow proposal         -> recent 6 messages
TargetResolver            -> up to 30 messages
context-error compaction  -> selects from 30, keeps 20, renders a recent subset
```

This creates four coupled problems:

1. **Continuity:** long conversations feel forgotten even though SQLite still contains
   the history.
2. **Consistency:** selector, reply, resolver, summary, and specialist agents see
   different evidence.
3. **Contamination:** an incorrect clarification or unrelated root-channel topic can
   enter every later fixed window.
4. **Recovery:** a new agent or resumed session has no single authoritative projection to
   rebuild.

The root cause is therefore broader than one prompt or enum value. Ling needs a canonical
conversation model and a shared context projection boundary.

## Goals

- Keep every observable conversation event durable, ordered, and recoverable.
- Let users continue, resume, fork, inspect, and correct a conversation without losing
  its source evidence.
- Keep key goals, decisions, constraints, open questions, active work, and source refs
  consistent across agents.
- Prevent unrelated root-channel topics and incorrect clarifications from contaminating
  later turns.
- Preserve typed workflow, run, approval, artifact, and memory authority in their
  existing domain stores.
- Make context selection auditable without exposing prompts, secrets, or hidden model
  reasoning.
- Make incorrect segmentation and summary decisions reversible.

## Non-Goals

- Do not send the full raw transcript to every model or agent.
- Do not store or expose hidden chain-of-thought.
- Do not merge Channel membership, permission, workflow, run, approval, artifact, or
  memory authority into `conversation_items`.
- Do not make keyword matching the primary topic-switch or execution classifier.
- Do not make the Web client a conversation store or context owner.
- Do not retain runtime aliases for v1 intent names during pre-release development.

## Canonical Ownership

| Concept | Authority | Responsibility |
| --- | --- | --- |
| `Channel` | channel store | members, roles, policy, protocol, workspace binding |
| `LingThread` | thread store | durable conversation line, lifecycle, lineage, archive/fork/resume |
| `LingTurn` | turn store | one user or system intent lifecycle and its terminal outcome |
| `ConversationItem` | conversation item store | ordered observable timeline and stable references |
| `ContextSegment` | context continuity store | semantic working-set boundary within one thread |
| `TurnContextAssignment` | context continuity store | auditable, reversible turn-to-segment assignment |
| `ConversationContextSummary` | context continuity store | compact typed facts with coverage watermark and source refs |
| Canonical mention set | accepted user `ConversationItem` payload | validated participant references used by every downstream router |
| Required participant manifest | channel intent decision store | immutable required/optional participant outcomes for one accepted decision |
| Delegated outcome | workflow step output packet / orchestrator state | typed completed, started, blocked, failed, or cancelled execution handoff |
| Workflow completion gate | daemon orchestrator | derives whether participant, operation, dependency, and fan-in requirements are satisfied |
| Workflow/run/approval/artifact tables | existing domain stores | authoritative business and execution state |
| `ConversationContextProjector` | daemon/core projection service | permission-filtered per-consumer context views |
| `ConversationTranscript` | daemon/core read model | user-visible semantic blocks and evidence references |

`ConversationItem` provides ordering and public metadata. It references domain records;
it never copies their mutable authority. For example, an approval item points to an
`approval_request` record, and the approval table remains authoritative for whether work
may proceed.

## Thread Topology

### Surface mapping

| Channel surface | Ling mapping | Lineage |
| --- | --- | --- |
| Channel root | exactly one `LingThread(surfaceKind="channel_root")` | no parent |
| Explicit topic | child `LingThread(surfaceKind="topic")` | parent thread, parent turn, anchor item |
| Branch/fork | child `LingThread(surfaceKind="branch")` | parent thread, parent turn, fork context snapshot |

```text
Channel
└── Root LingThread
    ├── Topic LingThread
    │   └── topic-only turns and items
    └── Branch LingThread
        └── post-fork turns and items
```

Recommended thread fields:

```ts
type LingThreadSurfaceKind =
  | "channel_root"
  | "topic"
  | "branch"
  | "direct"
  | "work";

type LingThreadRelationKind = "root" | "topic" | "branch";

interface LingThreadContinuity {
  readonly surfaceKind: LingThreadSurfaceKind;
  readonly relationKind: LingThreadRelationKind;
  readonly parentThreadId?: string;
  readonly parentTurnId?: string;
  readonly anchorItemId?: string;
  readonly forkContextSnapshotId?: string;
}
```

Rules:

- The root feed reads the root thread. Root items no longer use `thread_id = NULL` as
  implicit ownership.
- A topic anchors to one parent item. The anchor remains in the parent timeline; it is not
  duplicated into the topic.
- A branch records a compact context snapshot at the fork boundary. It inherits the
  effective context before that boundary, then evolves independently.
- Topic and branch creation are explicit user or product actions. Semantic topic changes
  inside the root do not silently create visible child threads.
- A channel may contain many work threads, but only one active non-archived
  `channel_root` thread.

API callers select a surface without overloading identifiers:

```ts
type ChannelConversationSurface =
  | { kind: "channel_root" }
  | { kind: "thread"; threadId: string }
  | { kind: "topic"; anchorItemId: string };
```

`threadId` always means a canonical `LingThread.id`. Topic materialization alone accepts
an `anchorItemId`; after the daemon returns the Topic Thread, paging and sending use that
Thread id. A Turn request has no top-level `threadId` compatibility alias, and an Items
query cannot send `threadId` and `anchorItemId` together.

### Root-level topic isolation

Users will still discuss unrelated work in the root without creating a formal topic.
`ContextSegment` isolates those working sets while preserving one root transcript.

```text
Root LingThread
  Segment A: Issue #421 diagnosis
  Segment B: long-term context architecture
  Segment C: unrelated UI task
```

### S-1 reply-supervision bridge

PR #422 supplies a useful pre-v2 supervision layer for ordinary replies. The bridge is
accepted only with the following boundaries:

```ts
interface ChannelReplyDisposition {
  readonly mode: "queue_followup";
  readonly activeRunId?: string;
}
```

The temporary conversation-line key is derived structurally from the persisted Channel
surface:

```text
root                         -> root
branch root LingThread       -> branch:<rootThreadId>
message-keyed topic          -> topic:<sourceMessageId>
other explicit thread        -> thread:<threadId>
```

Rules:

- the pending-reply lane key is `(workspaceId, channelId, conversationLineKey)`, never
  the entire Channel and never the selected teammate;
- `activeRunId` means “queue behind this exact active reply Run” and is accepted only when
  the Run's persisted `requestSnapshot.sourceMessageId` resolves to the same line;
- omitting `activeRunId` is allowed only for a rapid-submit predecessor whose Run has not
  linked yet; the line-scoped coordinator waits for that link. If no live predecessor lane
  exists, the daemon returns to normal intent routing and never searches for another active Run;
- omitting `replyDisposition` means the message is a new turn and must continue through
  normal intent selection even when another reply is active;
- a stale, terminal, missing, cross-Channel, or cross-line Run id cannot cause queueing;
- `ConversationActiveReplyTarget.sourceMessageId` is projected from the Run snapshot and Web
  filters guidance by the persisted source ChannelMessage line. `RunSession.threadId` remains
  the canonical LingThread id, so a Root reply is not presented as a Branch or Topic target;
- continuation context is rebuilt from the guidance message. Branch continuations retain the
  Branch LingThread; message-keyed Topics temporarily retain the canonical Channel Root
  LingThread plus explicit `sourceMessageId` until Topic LingThread materialization lands in S2;
- the store atomically claims the oldest pending intervention without a fixed history-page
  window; concurrent terminal callbacks cannot claim the same item, and a failed start
  continues draining the next FIFO item;
- public Run-intervention requests cannot provide channel lineage fields. Only validated
  Channel dispatch writes `sourceMessageId` and `targetTeammateId`;
- no text keyword or model guess may manufacture `queue_followup`.

This bridge does not add a second timeline or delay the S1/S2 authority cutover. Until
`ConversationItem` becomes canonical, existing Channel message ids are source references
only. At S2 the same structural line relation is resolved from explicit `LingThread`
ownership, and at S4 the typed disposition remains separate from `reply | execute` intent.

## Turn Boundary

`LingTurn` becomes the durable intent boundary for ordinary conversation and executable
work.

Creation rules:

- create a turn before selector or reply routing for every accepted local-user input;
- create system-originated turns for automation, external work updates, workflow steps,
  or review actions when they form an independent lifecycle;
- link queue follow-up, redirect, retry, resume, or validation turns through
  `sourceTurnId` and existing run-link records;
- mark an ordinary successful reply turn as terminal even when it has no run;
- when an ordinary reply uses a supervised read-only Run, link that Run as execution and
  recovery evidence without transferring turn ownership to the Run;
- keep tool calls, approvals, artifacts, and terminal results inside the owning turn;
- never infer turn boundaries from assistant wording.

This supersedes the earlier rule in Thread-First Work History v2 that created `LingTurn`
only for executable work. That rule prevents ordinary conversation from sharing the same
recovery, segmentation, and summary model.

The turn lifecycle remains independent from execution:

```text
accepted user item
  -> LingTurn(open)
  -> context assignment and projection
  -> reply | clarify | propose | execute | no_reply
     -> no run: terminal turn
     -> run: existing run/approval lifecycle
  -> terminal item(s)
  -> LingTurn(succeeded | failed | blocked | cancelled | superseded)
```

### Accepted-turn dispatch ownership

Persisting the user item and `LingTurn` is the acceptance boundary, not proof that the
turn has been routed or answered. The daemon must create one durable
`channel_turn_dispatch` work unit, owned by the source turn, in the same SQLite
transaction as the accepted item and turn. HTTP/SSE observes that work; it does not own
its lifetime.

```text
atomic acceptance transaction
  -> committed user ConversationItem
  -> LingTurn(open)
  -> WorkUnit(channel_turn_dispatch, queued, owner=turn, sourceItemId)
  -> SSE ready

durable dispatcher
  -> claim work unit
  -> CAS LingTurn open -> running
  -> assign context segment
  -> prepare bounded context / summary fallback
  -> acquire or bypass the reply-supervision lane
  -> intent selection and reply/workflow dispatch
  -> persist route/reply/workflow refs
  -> terminalize dispatch work unit
  -> terminalize the turn now, or transfer completion ownership to the linked reply/run/workflow
```

The dispatch work unit stores only typed request metadata and source ids already accepted
by the daemon: source item and turn, Channel and thread, requested provider/teammate,
explicit segment selection, conversation surface, and typed reply disposition. It does
not duplicate the message body, timeline, intent decision, or workflow state. Its
idempotency key is derived from the source turn. A request retry returns the existing
Item/Turn/dispatch tuple; concurrent workers cannot claim it twice.

Each pre-dispatch wait is bounded and observable:

- structural segment assignment is synchronous and authoritative;
- a semantic segmentation model is advisory, receives an abort signal, and has a short
  policy timeout. Timeout, provider failure, cancellation, or invalid JSON commits the
  conservative current/bootstrap assignment and records the fallback reason;
- a hard rolling-summary attempt has a separate bounded timeout. Failure never commits a
  partial summary. The projector uses the last committed summary plus a deterministic,
  permission-filtered recent tail that fits the resolved provider budget;
- if the required recent tail alone cannot fit, the dispatcher commits a visible blocked
  assistant item with `context_projection_over_budget` and moves the source turn to
  `blocked`; it never waits indefinitely or silently drops required inputs;
- the rapid-submit reply-lane wait is allowed only for an explicit typed
  `queue_followup` without a linked Run id. It has a short link deadline and then falls
  back to normal intent routing. Ordinary new turns never wait behind an unrelated lane;
- provider-backed intent selection and reply execution remain their own supervised work
  with existing runtime idle/hard timeouts. A dispatch work unit does not create a second
  provider timeout authority.

SSE close, browser refresh, renderer crash, or client navigation stops only delivery to
that observer. The claimed work unit continues. Startup recovery requeues an unclaimed
dispatch, marks a lost attempt stale, and resumes from durable checkpoints. Before
retrying a stage it first looks for its committed context assignment, intent/route
decision, reply WorkUnit/Run, workflow, and assistant item so a crash cannot duplicate a
model call or visible reply. An unrecoverable dispatch commits a typed blocker and leaves
the turn inspectable; no accepted turn may remain silently `open` solely because the
request process disappeared.

#### Dispatcher composition and scheduling

The daemon owns exactly one `ChannelTurnDispatchWorkerRegistry`. It is composed with the
same runner, reply, workflow, approval, and runtime-supervisor dependencies as the HTTP
router, but it is not created by an HTTP request and never writes to a response object.

- `RunStoreRegistry.onStoreInitialized` wakes the registry after migrations and runtime
  startup reconciliation for every opened workspace;
- successful acceptance wakes the same registry after the SQLite transaction commits;
- one drain loop exists per workspace. It considers queued dispatches oldest-first and
  uses the WorkUnit `queued -> claimed` compare-and-set as the ownership fence;
- the initial implementation claims one dispatch at a time per workspace. A dispatch
  releases that slot as soon as it has terminalized or handed completion to a durable
  child reply Run/workflow, so long-running child work does not serialize unrelated
  conversation lines;
- repeated startup, store-initialization, acceptance, and reconnect wakes coalesce into
  the same drain promise. They do not create another worker or another attempt;
- daemon shutdown stops new claims, waits for active dispatch callbacks to reach a
  durable handoff/terminal boundary, then marks any lost attempt stale before storage is
  closed. Startup performs the normal stale-to-queued recovery.

HTTP `POST /turns` and `POST /turns/stream` therefore do only three lifecycle-bearing
things: validate input, commit the Item/Turn/WorkUnit tuple, and wake/observe the worker.
The non-stream route may await the shared dispatch promise to return a convenient result.
The SSE route may project pending/delta/terminal events while connected. Closing either
response never aborts, fails, or owns the worker promise.

#### Immutable request and checkpoint discovery

`WorkUnit.request` is an immutable, validated `ChannelTurnDispatchRequestV1`:

```ts
interface ChannelTurnDispatchRequestV1 {
  readonly schemaVersion: 1;
  readonly sourceTurnId: string;
  readonly sourceItemId: string;
  readonly channelId: string;
  readonly threadId: string;
  readonly requestAiReply: boolean;
  readonly requestedProviderPresetId?: string;
  readonly requestedTeammateId?: string;
  readonly unavailableRequestedParticipantIds?: readonly string[];
  readonly explicitContextSegmentId?: string;
  readonly surface?: ChannelConversationSurface;
  readonly replyDisposition?: ChannelReplyDisposition;
}
```

`unavailableRequestedParticipantIds` is an acceptance-time availability snapshot for
canonical participant ids already present in the source Item. It does not duplicate the
mention set or permanently mark a teammate unavailable. Dispatch validates that every id
belongs to the committed source mentions, then resolves the turn through one deterministic
`participant_unavailable_in_channel` blocker before intent/model execution. Recovery
replays the same blocker even if membership later changes; a user retry creates a new Turn
and captures current availability.

It contains no mutable `stage` field. Recovery derives progress from committed authorities
and appends runtime events only as diagnostics:

| Durable checkpoint | Resume behavior |
| --- | --- |
| effective context assignment only | run bounded advisory preprocessing, then select intent |
| unavailable requested participant snapshot | commit/reuse the typed visible blocker; do not call the selector or provider |
| committed intent decision | reuse the decision and its proposal/result refs; do not reclassify |
| committed route decision without reply | reuse the selected target and create the deterministic reply item |
| pending reply item with a current child WorkUnit/Run | hand completion ownership to that child and terminalize dispatch |
| pending reply item with no resumable child | retry reply execution into the same deterministic item id |
| terminal reply item | replay it and terminalize/reconcile without another model call |
| linked workflow | hand completion ownership to the workflow and terminalize dispatch |
| deliberate `no_reply` | terminalize the source turn and dispatch without fabricating a reply |

Selector, segmentation, and route model calls are read-only inference. A process loss in
the narrow interval after a provider answered but before its result committed may repeat
that inference. Ling guarantees idempotent committed decisions and exactly-once visible
mutation, not impossible exactly-once delivery to an external model provider. Reply item
ids, proposal/workflow lookup keys, and WorkUnit compare-and-set fences prevent duplicate
assistant Items, Runs, or workflows after such a retry.

#### Dispatch and Turn terminal ownership

Dispatch success means that routing is durably complete, not that every child execution
has completed:

- `reply` and `visible_multi_reply`: a pending/linked assistant item or reply WorkUnit
  becomes the completion owner; Run reconciliation closes the source turn;
- `clarify`: the visible clarification commits and the source turn becomes `blocked`
  until a later linked user turn supplies the missing fields;
- `no_reply`: the explicit durable decision closes the source turn as `succeeded`;
- `execute`: the linked workflow owns final-result publication and source-turn settlement;
- permanent pre-handoff failure: one idempotent visible blocker is committed, the source
  turn becomes `blocked`, and the dispatch WorkUnit becomes `failed`;
- process loss: the attempt becomes `lost`, the WorkUnit becomes `stale`, then startup
  requeues it. It is not converted into a user-visible failure solely because the daemon
  restarted.

The blocker and every deterministic reply item use ids/idempotency keys derived from the
source turn plus result role. A retry can update or reuse that item but cannot append a
second visible outcome for the same role.

## Conversation Item Model

### Envelope plus typed payload

The selected item design is one stable envelope with typed payloads and domain refs.

```ts
type ConversationItemKind =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "approval_request"
  | "approval_decision"
  | "handoff"
  | "operation_state"
  | "artifact_ref"
  | "system_event";

type ConversationItemStatus =
  | "pending"
  | "committed"
  | "failed";

type ConversationItemVisibility =
  | "channel"
  | "thread_participants"
  | "agent_private"
  | "operator";

interface ConversationItem {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly sequence: number;
  readonly kind: ConversationItemKind;
  readonly status: ConversationItemStatus;
  readonly actorType: "local_user" | "ling_agent" | "teammate" | "system";
  readonly actorId?: string;
  readonly visibility: ConversationItemVisibility;
  readonly visibilityOwnerId?: string;
  readonly payload: ConversationItemPayload;
  readonly domainRefs: readonly DomainRef[];
  readonly idempotencyKey?: string;
  readonly revision: number;
  readonly supersedesItemId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly committedAt?: string;
}
```

Typed payloads live in shared contracts. Runtime code switches on `kind`; it does not
inspect arbitrary JSON fields or generated prose to infer structure.

The user-message payload preserves mentions, attachment ids, link-preview ids, and typed
workspace file refs so migration never discards materialized-input or routing evidence. An
empty body is valid only when one of those input refs is present. The assistant-message
payload keeps `pending | ready | blocked | failed` delivery state separate from the item
commit state so streaming and visible blocker rows can be projected without overloading
timeline persistence semantics.

### Ordering and mutation

- `sequence` is monotonic within a thread and unique with `thread_id`.
- SQLite allocates the next sequence atomically by incrementing a thread-owned cursor in
  the same transaction as item insertion.
- `idempotencyKey` prevents duplicate writes after retries or reconnects.
- A pending streamed assistant message may update its payload and revision until commit.
- A committed item's payload and ordering are immutable. Corrections append a replacement
  with `supersedesItemId`; the projector derives which item is effective from the
  supersession chain.
- Tool call and tool result are separate items linked through a domain/source ref.
- Domain state transitions append observable items, while the domain table remains the
  authority.

### Storage direction

`conversation_items` replaces `channel_messages` as the timeline source of truth.
Message ids can be preserved during one-time migration, but runtime dual-write and
dual-read are prohibited.

Message-adjacent tables move from `message_id` to `item_id` references. Heterogeneous
domain refs use typed `(type, id)` values instead of polymorphic foreign keys.

## Context Segment Model

### Meaning

`contextSegmentId` answers one question:

> Which prior goals, decisions, constraints, open questions, and evidence should be
> automatically considered for this turn?

It is assigned to the turn. Items inherit the turn assignment; they are not classified
independently.

```ts
interface ContextSegment {
  readonly id: string;
  readonly threadId: string;
  readonly state: "provisional" | "active" | "merged" | "archived";
  readonly label?: string;
  readonly createdFromTurnId: string;
  readonly lastActiveTurnId: string;
  readonly mergedIntoSegmentId?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

### Ownership

The decision is hybrid but not a three-way vote:

1. User explicit selection is authoritative.
2. Structural relationships apply deterministic inheritance.
3. A model may propose semantic continuation, switch, or a new segment.
4. `ContextSegmentationPolicy` validates and commits the assignment.

No individual specialist agent may create its own authoritative assignment.

### Deterministic inheritance

The policy does not call a model when:

- the item replies to or quotes a known item;
- the turn is an approval, steer, queued follow-up, redirect, retry, or tool result tied
  to an existing turn;
- the user explicitly switches to a known segment;
- the user explicitly creates a topic or branch, which creates a new thread instead;
- a domain correlation id unambiguously binds the turn to active work.

These are structural rules, not keyword rules.

### Model proposal

When structural evidence is insufficient, the model receives permission-filtered segment
cards, not the full transcript. It must return one of:

```ts
type ContextSegmentProposal =
  | { action: "continue"; segmentId: string; antecedentTurnId?: string; confidence: number; evidenceItemIds: readonly string[] }
  | { action: "switch_existing"; segmentId: string; antecedentTurnId?: string; confidence: number; evidenceItemIds: readonly string[] }
  | { action: "propose_new"; confidence: number; relatedSegmentIds: readonly string[]; reason: string }
  | { action: "uncertain"; candidateSegmentIds: readonly string[] };
```

The model may choose only server-provided candidate ids. It cannot read inaccessible
segments or invent an authoritative id.

Segment selection has a bootstrap view to avoid circular dependency:

```text
current user turn
  + permission-filtered thread shared core
  + bounded candidate segment cards
  + explicit reply/quote/work refs
  -> ContextSegmentationPolicy
  -> effective assignment
  -> normal per-segment ConversationContextProjection
```

The bootstrap view is not a general reply or execution context. It exists only to select
the working set and records the candidate source refs it used.

### Provisional state and correction

New semantic segments begin as `provisional` when confidence is insufficient for a hard
boundary. They become active after a second related turn, a concrete work object, or an
explicit user confirmation.

Assignments are append-only and supersedable:

```ts
interface TurnContextAssignment {
  readonly id: string;
  readonly turnId: string;
  readonly segmentId: string;
  readonly status: "provisional" | "committed";
  readonly revision: number;
  readonly decisionSource: "user" | "structural" | "model_policy";
  readonly confidence?: number;
  readonly antecedentTurnId?: string;
  readonly evidenceRefs: readonly DomainRef[];
  readonly policyVersion: string;
  readonly supersedesAssignmentId?: string;
  readonly createdAt: string;
}
```

Correcting an assignment does not edit raw items. It invalidates affected summaries and
creates a new assignment revision and projection version. The effective assignment is the
highest valid revision in the supersession chain; older rows remain unchanged.

### Granularity rule

A new fact is not automatically a new segment. Create or switch segments when bringing
the current segment's goal and decisions into the next turn would mislead rather than
help.

Examples:

| Turn | Result |
| --- | --- |
| `先别修，继续分析 #421` | continue the issue segment |
| `还有一个问题，最近 8 条是不是会失忆` | new context-architecture segment, linked back to #421 by source ref |
| `方案 B 就这样定` | continue the context-architecture segment |
| `回到 #421，现在直接修` | switch to the existing issue segment |
| `为上下文架构正式建一个 Topic` | create a child thread, not another hidden segment |

## Shared Context Projection

### One owner

All context consumers call `ConversationContextProjector`. Consumers may request a view
kind and budget, but they cannot independently scan raw recent messages.

```text
committed ConversationItems + domain records + assignments + summaries + memory
        |
        v
permission and visibility filter
        |
        v
ConversationContextProjector
  shared core
  active segment
  recent unsummarized tail
  current turn and materialized inputs
  role-relevant evidence
  allowed memory
  explicit cross-segment refs
        |
        v
selector | reply | resolver | proposal | workflow step | specialist | inspect
```

Every projection carries:

```ts
interface ConversationContextProjectionMetadata {
  readonly projectionVersion: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly segmentId: string;
  readonly throughItemSequence: number;
  readonly summaryIds: readonly string[];
  readonly sourceRefs: readonly DomainRef[];
  readonly policyVersion: string;
  readonly visibilityFingerprint: string;
}
```

`projectionVersion` is derived from thread revision, effective assignment revision,
summary versions, visibility scope, and the item sequence watermark. Runs and agent
requests store this version with their input evidence.

### Shared core and role views

Every eligible agent receives the same shared core:

- current goal or topic;
- confirmed decisions and constraints;
- open questions and risks;
- active work and pending approvals;
- current rolling summary;
- source refs.

Then the projector adds only role-relevant evidence and permission-allowed private
memory. A specialist does not receive all peer transcripts, private memories, raw logs,
or unrelated segments.

### TargetResolver boundary

TargetResolver consumes the same projection and structured candidates. It does not scan a
different 30-message window.

Local file target validation runs only when the validated intent outcome requests a local
file or workspace side effect. A conversation subject such as an article is not promoted
to a filesystem target merely because the user said `写` or `开始`.

## Rolling Summaries

### Summary shape

A durable summary is typed, scoped, versioned, and source-linked:

```ts
interface ConversationContextSummary {
  readonly id: string;
  readonly threadId: string;
  readonly segmentId?: string;
  readonly scope: "segment" | "thread_core" | "work";
  readonly status: "active" | "superseded" | "invalidated";
  readonly version: number;
  readonly coveredFromSequence: number;
  readonly coveredThroughSequence: number;
  readonly objective?: string;
  readonly decisions: readonly string[];
  readonly constraints: readonly string[];
  readonly openQuestions: readonly string[];
  readonly activeWorkRefs: readonly DomainRef[];
  readonly sourceRefs: readonly DomainRef[];
  readonly supersedesSummaryId?: string;
  readonly policyVersion: string;
  readonly createdAt: string;
}
```

The summary does not contain secrets, hidden reasoning, raw provider prompts, full logs,
or private teammate content outside its visibility scope.

### Trigger policy

Initial defaults are policy values, not schema constants:

- soft asynchronous trigger when one segment has at least 32 unsummarized completed
  turns or its eligible raw context exceeds 30% of the resolved input budget;
- compact the oldest stable range and leave at least the most recent 8 completed turns
  raw;
- synchronous hard compaction when the candidate projection exceeds 70% of input budget;
- target a post-compaction projection below 55% so current input, tools, and output retain
  headroom;
- a provider context-length error may perform one stricter retry and records a health
  incident. It must not be the normal time summaries are first created.

The provider-aware Context Budget Manager supplies the input budget. Unknown providers
use its conservative budget class.

### Coverage and concurrency

- A summary covers a contiguous sequence range and records the exact watermark.
- New items after the watermark do not invalidate the summary.
- A late summary result may commit only if its source range and assignment versions still
  match. Otherwise it is discarded and regenerated.
- A corrected segment assignment inside the covered range invalidates the affected
  summary and schedules a rebuild.
- Summary replacement uses `supersedesSummaryId`; historical source refs remain
  inspectable.

## Branch Context Snapshots

A branch must not clone parent items. It records a source-linked snapshot:

```ts
interface ConversationContextSnapshot {
  readonly id: string;
  readonly threadId: string;
  readonly segmentId: string;
  readonly projectionVersion: string;
  readonly throughItemSequence: number;
  readonly summaryIds: readonly string[];
  readonly sourceRefs: readonly DomainRef[];
  readonly policyVersion: string;
  readonly createdAt: string;
}
```

The child thread can reconstruct its inherited starting context from the snapshot and
parent source refs. Later parent changes do not silently rewrite the child branch.

## Multi-Agent Recovery And Consistency

Rules:

- Ling Agent is the single assignment and narration owner.
- Specialists may propose relevant segment or source refs but cannot commit assignment.
- Every agent request includes `contextProjectionVersion` and source refs.
- A result based on an older version is accepted only when changed context is unrelated;
  otherwise the coordinator rebases, reruns, or rejects it.
- A new or resumed agent reconstructs from the thread core, active segment summary,
  recent tail, active work, and its allowed memory.
- Handoffs contain typed facts and source refs, not hidden free-form reasoning.
- Private teammate chat and memory remain private unless explicitly promoted through a
  permission-checked visible item.

This gives all agents recoverable and consistent selective memory without pretending
that every agent permanently remembers every raw message.

### Canonical mention materialization

Mentions are accepted input, not a dispatch shortcut. The composer should emit
structured mention tokens and the daemon must materialize one canonical mention set
before intent selection:

```text
composer token / API mention payload / plain-text fallback
  -> validate participant identity and capture availability separately
  -> canonicalize and de-duplicate mentions
  -> commit user Item payload with canonical mentions
  -> build TurnEnvelope from that committed payload
  -> run the same intent/delegation selector for mentioned and unmentioned turns
```

The structured composer token is primary. Plain-text detection is an import/paste/API
fallback and recognizes start/end, whitespace, and Unicode punctuation boundaries such
as `，。！？；：、（）【】[]`. Candidate discovery must search the complete known teammate
identity inventory, including inactive, hidden, disabled, and currently out-of-Channel
participants. Availability is evaluated only after a token resolves to a canonical
identity. Filtering to active/visible/Channel-member teammates before token matching is
forbidden because it turns a valid request into a silently smaller participant set. The
inventory lookup may be indexed or paginated, but a fixed first-page limit cannot define
mention semantics. Plain-text fallback is not a general natural-language intent
classifier. Downstream routers never independently reparse the body after the Item
commits.

If a body contains one unambiguous known participant token that the submitted mention
array omitted, the acceptance boundary may materialize that mention and record
`materialized_from_text`. Identity and availability are deliberately separate. A known
inactive, hidden, or out-of-Channel participant keeps its canonical identity in the
accepted Item, then dispatch commits a visible `participant_unavailable_in_channel`
blocker. It is not dropped and does not turn the whole accepted message into HTTP 400.
An unknown id, ambiguous text token, or malformed structured mention produces a typed
`mention_materialization_incomplete` result; malformed API input may be rejected before
acceptance, while a valid user message whose teammate became unavailable is accepted and
resolved visibly. A submitted structured mention that does not match the visible token is
rejected or corrected before commit; the daemon never trusts the Web payload without
validating it.

An explicit mention has exactly two effects:

- it enters the canonical requested-participant set;
- it may influence responder/role selection after intent has been selected.

It does not select `reply`, grant tools, auto-start a workflow, or bypass the selector.
In particular, the ordinary explicit-mention route cannot return before the selector has
distinguished discussion from delegated execution.

### Explicit participant precedence

Intent selection answers whether the Turn is discussion or executable work. Participant
resolution then answers who owns that outcome. Those decisions are ordered and must not
be collapsed into one role lookup:

```text
canonical Item mentions + selected intent + required operations
  -> explicit teammate ids present?
       yes -> preserve the exact ordered, id-de-duplicated set
       no  -> resolve explicit role requests to concrete ids
               -> otherwise choose by role/capability policy
               -> otherwise use the configured Ling Agent fallback
  -> validate each selected identity against Channel availability and required tools
  -> assign every required operation to the preserved participant set
  -> choose graph shape by participant cardinality
       one  -> one required workflow step
       many -> multi-step graph with explicit dependencies/fan-in
  -> persist one decision manifest and compile it without re-selection
```

Identity de-duplication is by canonical participant id, never by role. Two explicitly
mentioned Engineers are two requested participants. A role preference may determine
operation ownership or step shape, but it cannot replace either identity. The selector
model may recommend a role only for an unassigned request; it cannot emit or override
participant ids.

The single-step executable helper is legal only after participant resolution proves
there is exactly one required participant. Multiple explicit mentions must enter the
normal multi-participant proposal/graph compiler. If deterministic operation partitioning
would be unsafe or ambiguous, dispatch commits
`blocked(participant_operation_assignment_incomplete)` or asks one clarification. It
must not keep the first participant, discard the rest, or run the same mutation
concurrently by guesswork.

Operation assignment has one daemon owner. The selector derives the operation-to-
participant map once from the accepted operation graph, participant order, roles, and
dependencies. Manifest construction and proposal/workflow compilation consume that same
map, and required tools are derived only from the operations owned by each participant.
This prevents a selector from approving one assignment while the workflow compiler
silently constructs another.

For an explicitly named participant, availability and tool checks are validation, not
search criteria. A named unavailable participant produces
`participant_unavailable_in_channel`; a named participant missing required tools produces
`participant_required_tools_unavailable`. Both keep the canonical identity and requested
participant manifest visible. Automatic substitution is allowed only after a new user
Turn explicitly changes the assignee or supersedes the prior decision.

An idempotent retry whose proposal already exists must return the original proposal and
its compatible accepted decision/manifest. Roster order, role availability, and provider
capability changes after acceptance cannot trigger participant resolution again. If the
proposal is present but the decision or manifest is absent or incompatible, the dispatcher
records `blocked(existing_proposal_participant_lineage_invalid)` and settles the source
Turn through the ordinary blocker/publication path. It does not fabricate a replacement
manifest from the current roster or leave the accepted Turn hanging behind an HTTP 500.

### Required participant manifest

Every accepted intent decision persists the participant requirement that existed at
selection time. `selectedTeammateIds` remains a convenient projection; the manifest is
the completion authority:

```ts
interface RequiredParticipantManifestV1 {
  readonly schemaVersion: 1;
  readonly participants: readonly RequiredParticipantV1[];
  readonly fingerprint: string;
}

interface RequiredParticipantV1 {
  readonly participantId: string;
  readonly role: string;
  readonly requirement: "required" | "optional";
  readonly expectedOutcome:
    | "discussion_reply"
    | "execution"
    | "verification"
    | "synthesis";
  readonly requiredOperationIds: readonly string[];
  readonly requestedBy: "structured_mention" | "explicit_role" | "selector_policy";
}
```

The daemon resolves role descriptions and `all teammates` requests to concrete active
participant ids before persisting the decision. If that cannot be done without guessing,
the decision is `clarify` or typed `blocked`; the manifest never contains unresolved
display names. Membership changes after acceptance do not rewrite the manifest. A user
correction creates a superseding decision/manifest with a new fingerprint.

For `no_reply` and ordinary `reply` turns with no requested participant, the manifest is
present but has an empty participant list. An empty manifest is not a wildcard and cannot
be expanded later by a proposal or Agent prose.

For ordinary discussion, `discussion_reply` is satisfied by the requested participant's
committed assistant Item. For delegated work, `execution`, `verification`, and
`synthesis` require a mapped workflow step and the evidence appropriate to that role.
One participant may own several required operations, but one participant's successful
reply cannot remove another required participant.

Proposal and workflow compilation must prove:

```text
decision manifest required participant ids
  == workflow metadata required participant ids
  == required participant ids represented by graph steps
```

Optional participants may be omitted only through an explicit compiler result that
records why. Required participants cannot be inferred again from model prose, a hidden
proposal block, or the set of steps that happens to exist.

### Participant execution-profile binding

The required-participant manifest answers **who must finish what**. It does not contain
the mutable instructions and policy used to run that participant. Those values are bound
at the task/run adapter, after the workflow has selected an eligible step and before any
Task, Run, approval, or side effect is created:

```text
accepted decision / manifest / operation owner map
  -> immutable workflow step participant id
  -> resolve that exact canonical teammate at step start
  -> derive participant-binding authority from durable step provenance
  -> revalidate active/visible status, authority-specific membership, and required tools
  -> build WorkflowStepRunRequest
       teammateId          = step participant id
       systemPrompt        = teammate.systemPrompt
       appendSystemPrompt  = teammate.appendSystemPrompt
       approvalProfile     = teammate.approvalProfile
       tools               = workflow-required tools only
       provider / runner   = graph-compiled binding, with existing legal fallback
  -> merge step gate, selected Skill, and workspace/Channel policy fail-closed
  -> create Run and persist the effective request snapshot
```

The adapter owns this binding because the generic Run orchestrator also starts internal
selector, summarizer, and TerminalReport roles with explicit system prompts. Automatically
hydrating every `teammateId` inside the generic Run orchestrator would overwrite or mix
those internal roles and create a second persona authority. Only a concrete workflow
participant Run receives this binding through `prepareWorkflowStepStart()`; internal
control-plane Runs do not.

Participant binding has two semantic authorities. `sourceProposalId` remains useful
provenance, but field presence or absence is not authorization. The explicit authority
kind below is the only permission fact:

| Step provenance | Participant authority | First-Run eligibility check |
| --- | --- | --- |
| `sourceProposalId` present | accepted Channel selection/proposal | teammate exists, active, visible, and is still in the effective Channel membership/council set |
| `sourceProposalId` absent | durable workflow definition | teammate exists, active, and visible; do not require a separate Channel membership/council row |

The second row includes template, legacy handoff, custom graph, context compaction,
serial/parallel smart scheduling, and fan-in steps. `teammateTemplateId` may describe how
a participant was materialized, but it is not the authority discriminator. Testing only
that field is too narrow and produces false `workflow_participant_unavailable` blockers.
The explicit authority contract below supersedes the development-only
`!step.metadata?.sourceProposalId` heuristic.

This distinction does not bypass security policy. Both authorities validate the exact
teammate's tool allowance. The existing workflow-step Channel/tool gate remains a
separate check according to workflow provenance. Participant membership must not be used
as a proxy for tool permission, and tool permission must not silently authorize a
different participant.

Prompt and policy precedence is explicit:

| Field | Resolution rule |
| --- | --- |
| `systemPrompt` | the exact assigned teammate's base prompt; runner defaults apply only when it is absent |
| `appendSystemPrompt` | teammate fragments first, then selected Skill/source fragments and scoped memory from the existing Run orchestrator |
| `approvalProfile` | strictest merge of teammate profile, workflow-step gate, selected Skill profile, and workspace/Channel session policy |
| `tools` | exact workflow-required subset; validate against current teammate allowance and the existing provenance-aware workflow/Channel tool gate, never union with all teammate tools |
| provider | resolve through the canonical model-binding authority before graph compilation; freeze provider id and binding source, revalidate readiness at first Run creation, and never borrow another ownership scope |
| runner | use the graph-compiled binding; an existing legal runner fallback may fill an absent implicit binding but cannot change participant identity |

Provider resolution follows
[Conversation Model Binding And Creation Validation](conversation-model-binding-and-creation-validation.md#workflow-participant-model-preflight).
The participant manifest owns **who**, the model-binding resolver owns **which configured
provider**, the graph/step owns the accepted effective binding snapshot, and the Run
snapshot owns **what was actually executed**. These authorities must not be collapsed:

```text
Channel Ling Agent        -> Channel Ling Agent model
built-in Engineer / QA    -> workspace default
fixed custom teammate     -> teammate fixed model
```

A Channel model is not a fallback for a workspace-default specialist. Likewise, a request
provider is not a Channel per-message override and the first runnable provider is not a
recovery rule. Missing, stale, disabled, secret-incomplete, unhealthy, or capability-
incompatible bindings produce `workflow_participant_provider_unavailable` with binding
source, participant id, and repair target.

Proposal confirmation checks the complete required-participant set before graph, Task,
Run, approval, or side-effect creation. A later readiness race is checked again at first
Run creation. The former preserves the accepted proposal/manifest as a recoverable
blocked lineage; the latter commits the existing typed pre-Run delegated blocker for the
exact step. In both cases the required participant stays in the manifest and the
Completion Gate cannot verify fan-in. Same-Run restart and approval resume reuse the
stored binding snapshot; an explicit repaired retry may resolve a new one and records that
change instead of mutating the in-flight Run.

For a manifest-backed step, a caller-supplied `assigneeTeammateId` must equal
`step.toParticipantId`. A mismatch is `workflow_participant_override_forbidden`; it is
not a request to reselect. Missing, disabled, hidden, malformed-profile, or newly
tool-ineligible participants produce one typed pre-Run `DelegatedOutcomeV1.blocked` and
no Run. An out-of-Channel participant produces the same fail-closed result only for the
Channel-selection authority; a workflow-definition participant is not rejected merely
because no membership row exists. The blocker must use the existing atomic delegated-step
finalization store boundary so the step cannot become terminal without a typed outcome.

No new profile table or migration is required. The canonical teammate row is the source
at first Run creation, while the existing immutable Run request snapshot records the
actual `systemPrompt`, append fragments, approval profile, tools, participant, provider,
runner, workflow step, and delegated requirement used for that Run. A daemon restart or
replacement Attempt under the same Run reuses the snapshot exactly. An explicit workflow
retry that creates a new Run resolves the then-current canonical teammate profile and
records a new snapshot, making the policy change visible rather than silently mutating an
in-flight Run.

Persona remains behavior shaping, not authority. A prompt may encourage or forbid tool
use, but only the operation plan, tool scope, approvals, sandbox, and evidence validator
authorize and prove side effects. This distinction is what makes the PromiseBot test
valid: its profile can make the runner return ordinary text, and the host must then block
with `delegated_outcome_missing` because no required action evidence exists.

### Participant authority hardening (normative)

The semantic distinction between Channel selection and workflow definition is retained,
but it is represented as a first-class durable fact. Every accepted workflow step stores
one immutable authority record beside `to_participant_id`:

```ts
type WorkflowParticipantAuthorityKindV1 =
  | "channel_selection"
  | "workflow_definition";

interface WorkflowParticipantAuthorityV1 {
  readonly schemaVersion: 1;
  readonly kind: WorkflowParticipantAuthorityKindV1;
  readonly origin:
    | "channel_intent_proposal"
    | "builtin_template"
    | "custom_template"
    | "workflow_graph"
    | "channel_handoff"
    | "external_work"
    | "proposed_plan"
    | "manual_channel_step"
    | "legacy_migration";
  readonly sourceId: string;
  readonly participantId: string;
  readonly fingerprint: string;
}
```

The storage invariant is:

```text
participantAuthority.participantId == channel_workflow_steps.to_participant_id
participantAuthority.fingerprint == sha256(canonical authority JSON)
participantAuthority is written on INSERT and never replaced by ordinary PATCH
```

Trusted origins are assigned by the compiler that owns the source, not by a caller
supplied boolean:

| Origin | Kind | Source reference | Membership rule |
| --- | --- | --- | --- |
| accepted Channel proposal | `channel_selection` | proposal id | exact teammate must be active, visible, and in effective Channel membership/council |
| built-in/custom template | `workflow_definition` | template id | exact teammate must be active and visible |
| explicit graph, handoff, compaction, scheduling, fan-in | `workflow_definition` | graph/handoff/workflow id | exact teammate must be active and visible |
| external work or proposed plan | `workflow_definition` | external-work/plan id | exact teammate must be active and visible |
| direct/manual step without another source | `channel_selection` | step id | normal Channel selection checks apply |
| pre-v2 row backfill | `channel_selection` | migrated step id | legacy rows remain visible and fail closed if the exact participant is no longer eligible |

Proposal provenance is atomic. The proposal compiler passes the authority into the
initial graph/step insert; creating a step and adding `sourceProposalId` later is invalid.
Workflow creation either commits graph, steps, authority records, manifest fingerprints,
and source references together, or commits none of them. A crash cannot leave a proposal
workflow that looks like a workflow-definition assignment merely because a late source
write did not run.

Participant binding is immutable at the store boundary. Public update schemas omit
`toParticipantId`, `toParticipantLabel`, and `participantAuthority`; Core rejects any
attempt to change them. Metadata updates may change display/prompt fields, but never the
authority JSON or its participant. A mismatch between authority and step participant is
a typed lineage blocker and prevents Task, Run, approval, or side effect creation.

All start paths call the same policy adapter:

```text
immutable authority + step participant
  -> exact teammate lookup
  -> authority-specific membership/visibility/tool checks
  -> requiredTools absent ? [] : exact required subset
  -> teammate allowance ∩ workflow/Channel gate
  -> strictest(teammate, step, Skill, workspace/session approval policy)
  -> immutable Run request snapshot
```

The adapter is fail-closed. It never substitutes a same-role teammate, passes the full
Channel tool list when the step has no declared tools, or lets a selected Skill widen the
teammate/workflow ceiling. Direct start, automatic tick, approval resume, and retry are
conformance-equivalent because they use this one adapter. Same-Run restart/resume reuses
the stored snapshot exactly; a new Run is the only point at which a changed teammate
profile can be observed.

Migration 119 adds `participant_authority_json` and backfills existing rows with an
explicit `channel_selection`/`legacy_migration` record and a recomputed fingerprint. The
migration is a clean-break storage upgrade, not a dual-read compatibility path. Invalid
JSON, fingerprint mismatch, participant mismatch, or unknown origin produces a typed
lineage blocker and no Run.

### Typed delegated outcomes

Delegated execution never terminates through naked assistant text. The execution owner
returns one typed outcome whose refs point to existing durable authorities:

```ts
type DelegatedEvidenceRefV1 =
  | { readonly kind: "execution_action"; readonly id: string }
  | { readonly kind: "workflow_output_packet"; readonly id: string }
  | { readonly kind: "artifact"; readonly id: string }
  | { readonly kind: "conversation_item"; readonly id: string };

type DelegatedBlockCodeV1 =
  | "delegated_outcome_missing"
  | "delegated_requirement_invalid"
  | "delegated_run_missing"
  | "delegated_run_owner_mismatch"
  | "required_participant_missing"
  | "required_participant_evidence_missing"
  | "required_operation_missing_evidence"
  | "required_operation_evidence_missing"
  | "required_operation_failed"
  | "required_participant_output_packet_missing"
  | "participant_operation_assignment_incomplete"
  | "required_participant_operation_mismatch"
  | "participant_required_tools_unavailable"
  | "participant_unavailable_in_channel"
  | "workflow_participant_unavailable"
  | "workflow_participant_required_tools_unavailable"
  | "workflow_participant_provider_unavailable"
  | "existing_proposal_participant_lineage_invalid"
  | "runtime_interrupted_no_checkpoint"
  | "approval_resume_unsupported"
  | "approval_resume_effect_unknown"
  | "approval_resume_lineage_invalid"
  | "approval_resume_mismatch"
  | "approval_resume_checkpoint_missing"
  | "approval_resume_owner_mismatch"
  | "approval_resume_tool_mismatch"
  | "approval_resume_requirement_mismatch"
  | "approval_resume_lineage_missing"
  | "approval_resume_state_mismatch"
  | "approval_resume_checkpoint_stale"
  | "approval_resume_state_stale"
  | "agent_context_missing"
  | "agent_context_stale"
  | "agent_context_private_leak";

type DelegatedTerminalCodeV1 =
  | "delegated_run_failed"
  | "delegated_run_cancelled"
  | "required_operation_failed"
  | "post_step_approval_denied"
  | "runner_failed"
  | "runner_cancelled"
  | "runtime_interrupted_no_checkpoint";

type DelegatedOutcomeV1 =
  | {
      readonly kind: "completed";
      readonly workflowId: string;
      readonly workflowStepId: string;
      readonly participantId: string;
      readonly evidenceRefs: readonly [DelegatedEvidenceRefV1, ...DelegatedEvidenceRefV1[]];
    }
  | {
      readonly kind: "workflow_started";
      readonly workflowId: string;
      readonly participantManifestFingerprint: string;
    }
  | {
      readonly kind: "blocked";
      readonly workflowId: string;
      readonly workflowStepId: string;
      readonly participantId: string;
      readonly code: DelegatedBlockCodeV1;
      readonly reason: string;
      readonly missingRequirements: readonly [string, ...string[]];
      readonly evidenceRefs: readonly DelegatedEvidenceRefV1[];
    }
  | {
      readonly kind: "failed" | "cancelled";
      readonly workflowId: string;
      readonly workflowStepId: string;
      readonly participantId: string;
      readonly code: DelegatedTerminalCodeV1;
      readonly reason: string;
      readonly evidenceRefs: readonly DelegatedEvidenceRefV1[];
    };
```

`workflow_started` is a durable ownership handoff, not user-task completion.
`completed` requires at least one unique evidence ref. The host resolves every ref to a
committed authority, verifies the workflow/step/participant binding, and checks that the
evidence class covers the immutable requirement's operation/dependency set. A blocked
outcome carries the same host-owned workflow/step/participant binding, a closed
`DelegatedBlockCodeV1`, a non-empty reason and missing-requirement tuple, and an explicit
`evidenceRefs` array. The array may be empty only when no canonical action or output
exists; the host must retain every available ref and cannot invent one to satisfy the
schema. `blocked`, `failed`, and `cancelled` are explicit terminal facts; they are not
generated by recognizing phrases in assistant prose. Unknown block codes, a missing
evidence field, empty completed evidence, duplicate refs, or a binding mismatch are
rejected before the outcome is persisted.

`failed` and `cancelled` use the closed `DelegatedTerminalCodeV1` set as well. Provider-
specific detail stays in host-owned diagnostic fields/reason text; it cannot introduce a
new terminal state by smuggling an arbitrary code. `approval_resume_effect_unknown` is
always a `blocked` outcome, never a generic failure, because the side effect's existence
is unresolved.

Evidence requirements are outcome-specific:

| Expected outcome | Required durable evidence |
| --- | --- |
| `execution` | successful `ExecutionAction` refs covering every assigned required operation |
| `verification` | successful verification `ExecutionAction` refs plus the checked target/output refs |
| `synthesis` | a committed `ChannelWorkflowStepOutputPacket` artifact bound to the same workflow, step, and participant; every declared required dependency must be represented and referenced source/output artifacts must resolve |
| `discussion_reply` | a committed assistant `ConversationItem` attributed to the requested participant |

A synthesis or review step may legitimately call no tool. Its result is still not naked
runner prose: the orchestrator first writes and validates the step output packet, then
records that packet as delegated evidence. Conversely, an execution or verification step
cannot substitute an output packet or assistant Item for missing operation evidence.

For synthesis/review, output-packet materialization is part of host finalization and must
be restart-safe. The host derives one deterministic packet identity from the workflow,
step, current Run, terminal Run event watermark, requirement fingerprint, and canonical
dependency/source refs. It writes or reuses that packet before committing the delegated
outcome. A crash after packet creation but before outcome commit therefore leaves one
reusable packet; startup reconciliation cannot create a second artifact. The packet body
may project the terminal runner text, but packet ownership, refs, identity, and validity
come from canonical rows. Execution/verification steps never enter this no-tool path.

Every delegated Run receives one immutable result requirement compiled from the accepted
decision and workflow graph:

```ts
interface DelegatedStepRequirementV1 {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly participantId: string;
  readonly participantManifestFingerprint: string;
  readonly expectedOutcome: "execution" | "verification" | "synthesis";
  readonly requiredOperationIds: readonly string[];
  readonly requiredDependencyStepIds: readonly string[];
  readonly acceptedEvidenceKinds: readonly DelegatedEvidenceRefV1["kind"][];
}
```

The requirement is a validation input, not a permission grant. Tools still come from the
daemon-materialized operation plan and approval policy. A runner adapter must finish a
delegated attempt through one of these paths:

```text
tool/action events or output packet become durable
  -> host validates ownership, target, dependency order, and outcome class
  -> DelegatedOutcomeV1.completed(evidenceRefs)

agent cannot continue safely
  -> adapter validates structured missing requirements and reason code
  -> DelegatedOutcomeV1.blocked

runner/provider fails or is cancelled
  -> DelegatedOutcomeV1.failed | cancelled with available evidence refs

runner emits only ordinary final text
  -> no completion fact
  -> host commits blocked(delegated_outcome_missing) and one visible blocker
```

For embedded Pi, the host may construct `completed` from canonical `ExecutionAction`
rows after the agent actually used tools; the model does not get to invent ids or declare
an action successful. A provider-native structured blocker is accepted only after schema,
participant, workflow-step, and missing-requirement validation. The host-generated
`delegated_outcome_missing` blocker depends only on the absence of a valid terminal
outcome, never on recognizing phrases such as “I will execute”.

The assistant-message delivery state `ready` means only that visible text is committed
and renderable. The matrix is normative:

| Decision | Minimum completion fact | Source Turn consequence |
| --- | --- | --- |
| `reply` / discussion participant | committed requested assistant Item | may complete as ordinary conversation |
| delegated execution | verified `DelegatedOutcomeV1.completed` | remains owned by workflow publication barrier |
| workflow start | `workflow_started` with matching manifest fingerprint | dispatch may finish; source Turn remains running |
| blocked delegation | structured `blocked` plus visible blocker Item | source Turn becomes `blocked` |
| naked `ready` text while delegated Run is active | no completion fact | source Turn remains non-terminal |
| delegated Run terminates with only naked `ready` text | host-authored `blocked(delegated_outcome_missing)` plus visible blocker Item | source Turn becomes `blocked` through the publication barrier |

### Runtime suspension and approval resume

Daemon lifetime is below Run lifetime. The active-run registry must carry a typed stop
intent instead of treating every `AbortError` as cancellation:

```ts
type ActiveRunStopIntentV1 =
  | { readonly kind: "user_cancel"; readonly actor: "local-user"; readonly reason: string }
  | { readonly kind: "workflow_cancel"; readonly workflowId: string; readonly reason: string }
  | {
      readonly kind: "runtime_suspend";
      readonly cause: "daemon_restart" | "desktop_quit" | "process_signal";
      readonly runtimeInstanceId: string;
    }
  | {
      readonly kind: "runtime_failure";
      readonly code: "idle_timeout" | "hard_timeout" | "runner_crash";
      readonly reason: string;
    };
```

The state effects are intentionally different:

| Stop intent | Run/approval effect | Attempt effect | Delegated effect |
| --- | --- | --- | --- |
| `user_cancel` / `workflow_cancel` | cancel Run and pending approvals through the existing explicit cancellation transaction | cancelled | typed `cancelled` |
| `runtime_suspend` at a durable approval checkpoint | keep Run `waiting_for_approval`; keep approval pending/resolved exactly as stored | old attempt becomes `lost`; leases and slots release | remain pending; no participant result is invented |
| `runtime_suspend` without a safe checkpoint | do not write cancellation; record interruption and fail or block by work-kind policy | old attempt becomes `lost` | structured `runtime_interrupted_no_checkpoint` |
| `runtime_failure` | fail with the typed timeout/crash code; do not claim local-user action | failed/lost | typed `failed` or retryable blocker |

`LingApprovalCheckpoint` is the durable resume boundary. It reuses the existing approval
checkpoint authority and stores or derives one immutable resume basis containing the
approval id, Run/work-unit/step ids, prior attempt id, tool-call id, normalized
side-effect fingerprint, delegated-requirement fingerprint, and optional verified runner
resume handle. No second pending-approval table is added.

```text
runner requests side effect
  -> ApprovalRequest + LingApprovalCheckpoint commit
  -> Run/step wait for approval
  -> daemon stops
       close new claims
       mark process attempt lost/suspended
       preserve Run + approval + checkpoint + step + manifest
  -> daemon starts
       recover leases and old attempt
       register checkpoint with ApprovalResumeCoordinator
  -> approval resolves
       verified native resume handle, when supported
       OR Ling continuation under the same Run with a new WorkUnitAttempt
  -> exact approved side effect is consumed once
  -> new evidence appends to the same Run lineage
  -> shared delegated finalizer and Completion Gate recompute
```

Pi currently uses an in-memory `SessionManager`, so packaged acceptance must use the
Ling-continuation path rather than pretend Pi has native resume. The continuation gets
the durable requirement, completed operation evidence, pending checkpoint, and bounded
conversation context. The approval decision acts as a one-time grant only for the exact
normalized side-effect fingerprint captured before shutdown. A different command,
target, scope, or tool call requires a new approval. Already verified operations are not
re-executed merely to rebuild model context.

The resumed process attempt is fenced by `activeAttemptId`. Late callbacks from the old
runtime are diagnostic only and cannot consume the approval, append successful evidence,
or settle the step. All operation evidence remains under the same logical Run, so the
existing delegated finalizer, workflow read-set CAS, TerminalReport, and source-Turn
publication barrier need no parallel recovery authority.

If neither a verified native handle nor a safe Ling continuation can be created, the
checkpoint becomes `resume_failed`, the step becomes visibly
`blocked(approval_resume_unsupported)`, and fan-in remains non-successful. The pending
approval is never silently deleted, and infrastructure interruption is never attributed
to `local-user`.

`resume_pending` itself participates in startup recovery. The immutable `resumeBasis`
continues to bind the approval and side effect; the mutable, revision-fenced resume
handle binds the current replacement Attempt. Startup applies this matrix:

The normal claim path is one SQLite transaction over checkpoint revision/status,
replacement-Attempt insert, Run/work-unit fencing, runtime audit, and durable
control-plane invalidation. This removes every avoidable pre-execution crash window. A
`resume_pending` row without its bound Attempt is repair-only state from an older/partial
development write, not a legal result of the new writer.

| Canonical replacement state | Recovery |
| --- | --- |
| handle is valid, Attempt absent | create that bound Attempt and continue once |
| Attempt exists, no durable `tool_start` | mark the incomplete Attempt lost, CAS one newer handle/Attempt, and continue once |
| durable `tool_end` exists | reconstruct `ExecutionAction` and enter the shared finalizer; never execute again |
| durable `tool_start` exists without `tool_end` | block as `approval_resume_effect_unknown`; never execute again |
| Run or delegated outcome already terminal | run semantic reconciliation/publication only |

The ordering contract is checkpoint/Attempt claim, then durable `tool_start`, then local
side effect, then durable `tool_end`. This proves that the no-`tool_start` window is safe
to retry. It cannot prove the outcome after `tool_start` and before `tool_end`; arbitrary
local shell work has no transactional exactly-once primitive. Safety wins over
availability in that window.

A second daemon stop while the replacement Attempt is running uses the same typed stop
intent as an ordinary Run. Before `tool_start`, it leaves the checkpoint
`resume_pending` for another fenced Attempt. After `tool_end`, startup finalizes existing
evidence. Between them, it produces the effect-unknown blocker. Timeout or runner crash
remains a typed runtime failure, while explicit user/workflow cancellation remains the
only business cancellation path.

Runner metadata declares one of `native_resume`, `host_approval_continuation`, or `none`,
including the permitted action types for host continuation. Since Pi constructs
`SessionManager.inMemory`, it cannot advertise native resume. Its current host
continuation is bounded to exact approved bash payloads; unsupported write/edit payloads
fail closed until their executor owns an equivalent idempotent recovery contract.

Resume claim, replacement-attempt start, runtime suspension, terminal evidence, and
resume blocker each commit an idempotent content-free control-plane invalidation in the
same SQLite transaction as the visible state change. The client may receive those events
live, replay them after reconnect, or receive `snapshot_required`; all three paths reload
the same canonical Run/work-unit/approval projection before advancing the applied cursor.

#### Approval-resume transaction boundaries

Approval resume has three atomic SQLite mutations and one intentionally non-transactional
side-effect window. Keeping these boundaries explicit is more important than minimizing
the number of storage methods:

| Transaction | Canonical rows committed together | Post-commit work |
| --- | --- | --- |
| claim or re-claim | checkpoint revision/status and bound handle, old-Attempt fencing, replacement Attempt, Run/work-unit activation and `activeAttemptId`, runtime audit, `runs/work_units/approvals` invalidations | publish committed invalidations; register the active process attempt |
| suspend before `tool_start` | checkpoint remains `resume_pending`, replacement Attempt becomes `lost`, leases/slots release, recoverable runtime audit, invalidations | publish invalidations; a later startup may claim a newer fenced Attempt |
| finalize or block with verified lineage | checkpoint becomes `resumed` or `resume_failed`, Run/work unit/Attempt and owning Task become compatible terminal states, terminal runtime audit, leases/slots release, invalidations | publish invalidations; invoke the shared delegated finalizer, Completion Gate, TerminalReport, and source-Turn reconciliation |

The local side effect remains between a durable `tool_start` and durable `tool_end` and
cannot join any SQLite transaction. `tool_start` is the dispatch fence; `tool_end` is the
result fence. A crash before `tool_start` is retryable, after `tool_end` is finalizable,
and between them is `approval_resume_effect_unknown`. No transaction API may accept a
caller-supplied participant result, workflow result, or source-Turn status.

The terminal transaction is not enlarged to run Channel semantic reconciliation inside
Core. Core owns row-level consistency; the daemon owns cross-domain evidence semantics.
If the daemon stops after the terminal transaction but before delegated finalization,
startup sees the terminal Run and enters the same idempotent reconciliation kernel. A
filesystem terminal-summary file is likewise an inspectable projection: it may be
prepared before the transaction and orphaned on rollback, but it is never completion
authority.

Every transaction returns the exact committed control-plane events. The in-memory hub
publishes only that returned set after commit. A stale compare-and-set writes nothing and
publishes nothing; its caller reloads canonical state and either converges on the existing
transition or recomputes the next legal transition.

If the resume basis cannot prove a Run/work-unit/Attempt lineage, the daemon must not
terminalize whichever Run id the caller supplied. The terminal API uses a checkpoint-only
quarantine variant: CAS the checkpoint to `resume_failed`, append the diagnostic/runtime
audit and approval invalidation atomically, and leave unverified Run/work-unit rows
unchanged. Semantic recovery may publish `approval_resume_lineage_invalid` only from
whatever source/workflow ownership can still be proven. This rare corruption path is
fail-closed and auditable; it is not a fourth completion authority.

### Workflow completion gate

The orchestrator owns one deterministic completion gate. It runs before a workflow can
transition to `succeeded` and before TerminalReport synthesis treats success as possible:

```ts
interface WorkflowCompletionGateV1 {
  readonly status: "pending" | "verified" | "blocked" | "failed" | "cancelled";
  readonly sourceIntentDecisionId: string;
  readonly participantManifestFingerprint: string;
  readonly graphFingerprint: string;
  readonly basisFingerprint: string;
  readonly participantResults: readonly {
    readonly participantId: string;
    readonly workflowStepIds: readonly string[];
    readonly status: "satisfied" | "missing" | "blocked" | "failed" | "cancelled";
    readonly evidenceRefs: readonly DelegatedEvidenceRefV1[];
    readonly reasonCode?: string;
  }[];
  readonly checkedAt: string;
}
```

The gate is `verified` only when all of these are true:

1. the workflow manifest fingerprint matches the accepted decision manifest;
2. every required participant has one or more mapped graph steps;
3. every required participant has the expected typed outcome;
4. every required operation has verified action evidence in dependency order;
5. every required workflow dependency is satisfied;
6. every join executes its `fanInPolicy`, including
   `requireAllBranchesTerminal`, over the declared branch set;
7. the workflow termination policy accepts the resulting required-step states.

`includeFailedBranches` controls whether failed branch evidence is available to a join;
it never converts a required failed participant into success. Optional branches follow
their explicit failure policy. Missing manifest coverage is
`required_participant_missing`; a terminal branch without required evidence is
`required_participant_evidence_missing`; an unexecuted all-terminal join is
`fan_in_incomplete`.

The persisted gate result is also the source for TerminalReport required-participant
coverage. It must contain one row for every accepted required participant, including a
`missing` row when no graph step or Run exists and negative rows for blocked/failed/
cancelled outcomes. The report may project only actual contributions into its compact
participant summary, but it may not erase those required rows from evidence or risk
sections. This prevents a required participant from being misrepresented as merely an
unstarted optional teammate.

TerminalReport consumes the committed gate snapshot. It summarizes the result and forms
the publication barrier, but it cannot mutate the manifest, fabricate delegated
outcomes, or upgrade a non-verified completion gate to success.

#### Completion authority, atomic commit, and restart recomputation

The persisted `completionGate` is an audit snapshot and recovery accelerator, not a
second completion authority. The authoritative inputs remain the accepted intent
decision, immutable workflow graph, workflow/step rows, the Run/event/approval/artifact
rows behind `ExecutionAction`, validated output-packet artifacts, and termination policy.

`ExecutionAction` is a canonical read model, not an independent SQLite authority. It is
derived deterministically from Run snapshots, Run events, approvals, and artifacts. Gate
audit stores its projection fingerprint and referenced action ids, while the transactional
CAS validates the complete set of backing Run/event/approval/artifact rows. This preserves
one action semantics implementation without pretending Core can compare a daemon-only
projection inside SQLite.

The compiler stores `sourceIntentDecisionId` and the copied manifest fingerprint on the
workflow. Gate evaluation always reloads the source decision and proves that the decision
manifest, copied workflow manifest, graph participant mapping, and materialized steps
agree. Every join derives its declared branch set from incoming edges in the immutable
workflow graph. `dependsOnStepIds` is a materialized index only; it cannot hide a graph
branch whose step row is absent.

`basisFingerprint` is a deterministic digest of the exact canonical rows and graph fields
read by the evaluator. `checkedAt` is diagnostic only and never participates in authority.
The store commits every manifest-backed gate result and its compatible workflow effect in
one SQLite transaction guarded by expected workflow status and a typed read-set containing
the source decision manifest fingerprint, step status/outcome bases, Run terminal-event
watermarks, approval status/revisions, and artifact rows. The read-set also carries
explicit fingerprints for the decision execution plan, copied manifest, graph,
termination policy, derived action projection, and every output packet body. Workflow
output packets are content-addressed: their artifact row stores canonical sealed JSON plus
its SHA-256 digest. The store recomputes that digest from SQLite inside the transaction;
the filesystem file is an inspectable projection and cannot become a second mutable
completion authority. If a relevant row or sealed packet changes before commit, the
compare-and-set fails and the gate is recomputed; a stale verified snapshot can never
close a workflow.
`pending` keeps the workflow non-terminal, `verified` succeeds it, and the negative gate
statuses map to the matching workflow state. There is no separate rule that infers a
negative workflow result from whichever materialized step happens to be inspected first.

Startup and explicit reconciliation always recompute the gate from canonical state for
every non-terminal workflow and for any terminal workflow whose report/source-Turn
publication chain is incomplete. Recovery may replace an older cached snapshot with the
same deterministic result, but it never reconstructs participants from prose, trusts the
cached status alone, or downgrades a previously terminal negative action into success.

#### One semantic reconciliation kernel

There is one semantic reconciliation function for manifest-backed workflow completion.
Different triggers may wake it, but none owns a private success rule:

```text
online Run terminal callback
post-step approval resolution
daemon startup / explicit reconcile
duplicate or late callback
TerminalReport pre-publication validation
                 |
                 v
reconcileWorkflowFromCanonicalState(workflowId)
  -> reload source decision + immutable graph + manifest
  -> reload steps + Runs + actions + output packets + approvals
  -> finalize each terminal Run through DelegatedStepRequirementV1
  -> persist typed delegated outcome or structured blocker
  -> evaluate graph-declared fan-in and WorkflowCompletionGateV1
  -> CAS gate snapshot + compatible pending/success/negative workflow state in one transaction
  -> reconcile report publication + source LingTurn settlement idempotently
```

Core startup recovery may repair leases, lost Runs, and low-level state-machine rows. It
must not apply the old aggregate shortcut “all materialized steps succeeded, therefore
workflow succeeded” to a manifest-backed workflow. That semantic decision belongs to the
daemon kernel because it requires intent, graph, evidence, and report authorities. The
same rule applies to post-step approval: approval changes authorization state, then the
kernel revalidates evidence; approval never upgrades a Run or step by itself.

The kernel distinguishes a terminal candidate from committed completion. A succeeded Run
with incomplete required evidence becomes a typed blocker or failure according to the
existing step policy. A required branch that is still active remains pending. A stale
cached verified gate is replaced or rejected after recomputation. Only an atomic verified
basis can transition the workflow to `succeeded`.

The implementation has two focused layers, not another workflow engine:

```text
workflow-step-finalizer.ts
  input: workflowStepId + reconciliation cause
  reads: current linked Run + immutable DelegatedStepRequirementV1 + canonical evidence
  writes atomically: DelegatedOutcomeV1 + compatible step transition

workflow-reconciliation.ts
  scans terminal candidates through the finalizer
  reloads workflow canonical state
  evaluates WorkflowCompletionGateV1
  commits gate + compatible pending/success/negative workflow state atomically
  returns whether idempotent report/source-Turn publication reconciliation is needed
```

`orchestrator.ts` schedules work and invokes reconciliation; it does not own a second
finalization rule. Core startup recovery repairs leases, lost Runs, and legal low-level
rows, then daemon startup invokes reconciliation. TerminalReport pre-publication invokes
the same semantic reconciler and consumes its result without being called recursively by
it. This dependency direction avoids an `orchestrator.ts <-> workflows.ts` cycle.

Every delegated graph step persists its immutable requirement in step metadata and the
Run request snapshot. Finalization reloads the step's currently linked Run; callback Run
ids and remembered statuses are wake-up hints only. A late callback from a superseded
attempt cannot close the current retry. Post-step approval is committed first, then the
same finalizer decides whether evidence satisfies the unchanged requirement.

A delegated step that is already `running` or `waiting_for_approval` but has no linked
Run is not an indefinite wait state. It is a terminalizable integrity failure. The step
finalization CAS therefore accepts an explicit union:

```text
linked_run
  -> require step.run_id = expected Run id
  -> compare Run status/update/event watermark and referenced artifacts

no_linked_run
  -> require step.run_id IS NULL
  -> require an empty Run/artifact read-set
  -> commit DelegatedOutcomeV1.blocked(delegated_run_missing)
```

The no-Run branch still compares step status, revision, immutable requirement, manifest,
and graph basis in the same transaction. If a Run becomes linked concurrently, the CAS
returns stale and reconciliation reloads it; it cannot commit the missing-Run blocker
over a new attempt. A non-null dangling Run reference is reported as explicit storage
corruption and also fails closed. Startup and explicit reconciliation use this same
branch so a delegated step cannot remain `waiting` forever merely because there is no
Run object from which to derive a watermark.

Agent-context rejection is also a delegated result, not an exception to the protocol. A
stale, private, or otherwise rejected fan-in context produces a typed
`DelegatedOutcomeV1.blocked` through the same finalizer and atomic outcome/step
transition. Legacy workflows may retain their direct block helper, but a manifest-backed
step cannot skip its immutable requirement and basis merely because context validation
failed before a tool ran.

The step outcome and compatible step transition commit in one SQLite transaction guarded
by a deterministic basis over the step revision, current Run terminal event watermark,
requirement fingerprint, approval revision, evidence action ids/statuses, and output
packet id/fingerprint. A concurrent change yields `retry_reconciliation`; it cannot leave
a completed outcome on a running step or a succeeded step without its outcome. Duplicate
calls reuse deterministic event, blocker, and output-packet identities.

If synthesis packet materialization and the step transition cannot share one transaction,
the packet write is an idempotent prepare phase and the step transaction validates its
exact id/fingerprint. Prepared packets that never become referenced are diagnostic
orphans and may be compacted later; they never satisfy another attempt or participant.

An already-terminal step with a missing or invalid delegated outcome is treated as
historical corruption. Recovery and pre-publication block workflow success and expose a
structured reconciliation blocker; they do not fabricate evidence, re-open side effects,
or infer an outcome from the old summary.

## Channel Intent Decision v2

### Action contract

```ts
type ChannelIntentDecisionAction =
  | "no_reply"
  | "reply"
  | "visible_multi_reply"
  | "clarify"
  | "workflow_proposal"
  | "execute";

interface ChannelIntentDecisionV2 {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceTurnId: string;
  readonly sourceItemId: string;
  readonly contextSegmentId: string;
  readonly contextProjectionVersion: string;
  readonly action: ChannelIntentDecisionAction;
  readonly selectedTeammateIds: readonly string[];
  readonly participantManifest: RequiredParticipantManifestV1;
  readonly proposalId?: string;
  readonly resultItemIds: readonly string[];
  readonly workflowId?: string;
  readonly reason: string;
  readonly clarification?: {
    readonly missingFields: readonly string[];
    readonly question: string;
  };
  readonly execution?: ChannelIntentExecutionPlanV1;
  readonly status: "accepted" | "suppressed" | "failed";
  readonly createdBy: "deterministic" | "model_policy";
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ChannelIntentExecutionPlanV1 {
  readonly operations: readonly ChannelIntentExecutionOperationV1[];
}

type CommandMatchPolicyV1 =
  | {
      readonly kind: "exact_command";
      readonly command: string;
    }
  | {
      readonly kind: "executable";
      readonly executable: string;
    };

interface ChannelIntentExecutionOperationV1 {
  readonly id: string;
  readonly kind:
    | "file_create"
    | "file_edit"
    | "open_local_target"
    | "run_command";
  readonly targetKind: "file" | "directory" | "command" | "workspace";
  readonly targetRef: DomainRef;
  readonly commandMatchPolicy?: CommandMatchPolicyV1;
  readonly required: boolean;
  readonly dependsOn: readonly string[];
}
```

Rules:

- `reply` owns ordinary answers and in-conversation content generation.
- `execute` means the user requested bounded executable work. It does not itself bypass
  proposal, tool, sandbox, permission, or approval policy.
- Content generation remains `reply` unless the user explicitly requests a file,
  workspace mutation, command, or other external side effect.
- TargetResolver runs only after `execute`, or after a proposal path that explicitly
  requires a typed target.
- `clarify` requires structured `missingFields` and a question that names the missing
  product decision. A generic target question with no missing field is invalid.
- A concrete, independently answerable request cannot inherit a prior clarification as a
  hidden lock.
- `no_reply` truly means no user-visible reply is needed. It is not a disguised fallback
  to ordinary reply routing.
- Active-run approval, queue, steer, and redirect handling remains a higher-priority
  session path only when a typed structural relation names the target Run or pending
  predecessor. Mere presence of an active Run in the Channel is insufficient.
- A missing or rejected active-run relation falls back to normal intent selection; it does
  not become an implicit `reply`, `execute`, or clarification decision.

### Execution plan validation

The selector model proposes operation shape only. The daemon remains authoritative for
targets, dependency validity, tools, approvals, and whether the plan is executable.

- `operations` is non-empty for `action="execute"` and absent for every other action.
- Operation ids are stable inside the decision, unique, and referenced only by
  `dependsOn` values from the same plan.
- The dependency graph must be acyclic. Order in the JSON array is presentation order,
  not execution authority.
- Every operation is materialized independently from the current turn envelope and the
  shared context projection. The model cannot invent or directly authorize a path,
  command, command-match policy, tool, workspace scope, or domain ref.
- `targetRef` is a daemon-created ref to the durable target-resolution
  evidence. It is never accepted from an unvalidated model value, and its human-facing
  `label` is never evidence-matching authority.
- The model-facing operation-shape proposal and the durable execution plan are separate
  schemas. Model output may propose only `id`, `kind`, `targetKind`, `required`, and
  `dependsOn`. The daemon validates that proposal, resolves the target, and materializes
  `targetRef` plus `commandMatchPolicy` into the persisted plan. A model-supplied match
  policy or match value is rejected rather than copied.
- A durable `run_command` operation with `targetKind="command"` requires exactly one
  `commandMatchPolicy`. File operations and workspace-scoped operations must not carry
  one. This is a clean-break contract: malformed or pre-policy development rows fail
  validation; no dual reader or default-to-exact compatibility path is added.
- The daemon derives `requiredTools` from the validated operations: `file_create` maps to
  `write`, `file_edit` maps to `edit`, and `run_command` or `open_local_target` maps to
  `bash`. Model output cannot declare tools.
- `file_create` alone produces one `write` operation. A request to create a file and then
  run or verify it produces at least `file_create -> run_command`, with the command
  operation depending on the file operation.
- A command is added only when the user requested execution or verification and the daemon
  can materialize either a bounded exact command or a bounded executable identity.
  Mentioning source code, a runtime name, or a command in an explanatory example does not
  authorize execution.
- `exact_command` is used when the user supplied a complete command-shaped span such as
  `node app.js`. Its value is the daemon-validated command, and matching preserves quoted
  content and escapes; normalization is limited to line-ending and outer-whitespace
  normalization. It does not collapse whitespace inside quoted program text.
- `executable` is used when the executable is explicit but the runner must choose the
  arguments, for example `Node 调用 formatProof("7319")`. The daemon canonicalizes the
  allowlisted identity to `node`. A bare runtime name without an execution verb or bounded
  objective is discussion, not executable authority, so `介绍 Node` and `Node 是什么`
  remain `reply`.
- Backticks are content delimiters, not command authority. Every candidate still passes a
  daemon-owned parser, allowlist, workspace policy, tool policy, and runtime approval.
- A required command request that contains neither an exact command nor an executable
  identity must clarify. It cannot be materialized as “project command” and later be
  satisfied by an arbitrary successful bash action from the same Run.
- A broad workspace objective such as “run the project tests” or “prepare the Git
  publication workflow” is not a command-target operation. It may retain the existing
  optional `targetKind="workspace"` marker with no command policy; delegated finalization
  still requires at least one successful `ExecutionAction`, but TerminalReport must not
  claim that any exact command was requested or verified. A future host-bound operation
  contract can make these objectives more specific without weakening this distinction.

For one Agent, all operations may be attached to one workflow step. For multiple Agents,
the compiler partitions operations across graph nodes and persists each subset on its
own step. Cross-step dependencies keep the same operation ids so fan-in can prove the
whole user request, not merely that every runner returned a success status.

### Operation evidence and completion

`ExecutionAction` remains the action-result authority. No parallel result table is
introduced. Each workflow step stores the operation subset it owns and a deterministic
verification snapshot in step metadata:

An approval is a phase of the same action lifecycle, not a second action and not
execution-success evidence. For an approval-backed tool call, the read model correlates
the durable approval record and tool events by `(runId, toolCallId)` and emits exactly one
`ExecutionAction`:

```text
waiting_for_approval
  -> approved
  -> executing
  -> succeeded | failed | cancelled
```

`approved` proves only that policy allowed execution to continue. The action becomes
`succeeded` only after a matching `tool_end(isError=false)` (and, for commands, clean
command evidence) is durable. While approval is pending or denied, a preceding
`tool_start` cannot override the approval state. The merged action retains the approval
identity, preview/result artifact ownership, and policy snapshot, then adds tool-derived
targets, execution timestamps, and command evidence. Tool-event artifacts do not silently
change the approval checkpoint's `resultArtifactIds` contract; command output remains
available through `commandEvidence`. Correlation never uses `toolCallId` alone because
tool-call ids need only be unique inside their owning Run.

```ts
interface WorkflowStepExecutionVerificationV1 {
  readonly status: "pending" | "verified" | "blocked" | "failed";
  readonly checkedAt: string;
  readonly operationResults: readonly {
    readonly operationId: string;
    readonly status: "succeeded" | "missing" | "failed" | "out_of_order";
    readonly evidenceActionIds: readonly string[];
    readonly reasonCode?: string;
  }[];
}
```

Evidence rules are deterministic:

Command evidence is normalized at the runner boundary before operation verification.
It records a normalized `outcome` (`succeeded`, `failed`, `timed_out`, `cancelled`, or
`unknown`) independently from the optional numeric exit code. The normalizer uses this
evidence order:

1. A structured `unifiedExec` result is authoritative when its envelope is present. A
   successful structured result must contain a numeric `exitCode=0`; a missing or invalid
   exit code is incomplete evidence and must not be repaired from the outer
   `tool_end.isError` flag.
2. An embedded Pi `bash` call without any `unifiedExec` envelope uses the legacy Pi tool
   contract. A matching terminal `tool_end(isError=false)` means the Pi bash executor
   returned successfully and is normalized to `exitCode=0`. This inference is allowed
   only for that legacy contract and only after the terminal event is durable.
3. A legacy `tool_end(isError=true)` with no numeric exit code proves command failure but
   not a particular exit code. The normalizer keeps `exitCode` absent; it never invents
   `1` or another non-zero value.
4. Missing `isError`, a missing terminal event, or an unparseable terminal envelope is
   not success evidence. Approval state, Run success, assistant prose, and stdout text
   cannot fill that gap.

Legacy Pi `tool_update.partialResult.content` is a cumulative snapshot, not an append-only
stdout delta. The normalizer therefore retains at most the latest cumulative snapshot
while the call is active, replaces it with terminal `tool_end.result.content` when
available, and maps text blocks to a bounded stdout tail. It must not concatenate every
cumulative update. Structured unified-exec stream chunks and previews keep their existing
stream-aware behavior. Both paths apply the same byte, line, chunk, ANSI-removal, and
redaction bounds so restart recovery reconstructs the same command evidence.

| Operation | Required successful evidence |
| --- | --- |
| `file_create` | succeeded `write` action whose canonical file target matches |
| `file_edit` | succeeded `edit` action whose canonical file target matches |
| `run_command` | succeeded `bash` action with command evidence, `exitCode=0`, and neither timeout nor cancellation |
| `open_local_target` | succeeded `bash` action with matching bounded target/command evidence and a clean exit |

For command-shaped operations, matching uses only structured `commandEvidence.command`
and the daemon-materialized `commandMatchPolicy`:

| Policy | Planned authority | Matching rule |
| --- | --- | --- |
| `exact_command` | complete bounded command from the accepted user Turn | the canonical actual command equals the canonical planned command; no substring, summary, or target-label fallback |
| `executable` | one allowlisted executable identity from an explicit execution request | the actual evidence parses as one bounded simple command and its first executable token equals the planned identity |

The shared command parser is quote-aware. Quoted arguments may contain spaces or
semicolons, so `node -e 'const x = 1; console.log(x)'` remains one valid Node command.
For `executable`, an unquoted top-level shell control operator, redirection, command
substitution, newline, wrapper, environment-assignment prefix, or executable path fails
closed in the first slice. Consequently:

- `node -e '...'` satisfies planned executable `node` when its action succeeds cleanly;
- `echo node -e '...'`, `env node ...`, `sudo node ...`, and `sh -c 'node ...'` do not;
- `node task.js && echo ok` does not, because the final shell exit can hide a failed Node
  process;
- `echo node app.js` cannot satisfy exact `node app.js`;
- `ExecutionAction.summary`, `targetRef.label`, Run success, stdout text, and assistant
  prose never participate in matching.

The actual command still passes the existing sandbox and approval policy in full; an
`executable` match narrows completion evidence and does not grant permission to arbitrary
arguments or side effects. File targets are resolved to canonical absolute paths; case
folding is applied only on Windows. macOS and Linux comparisons remain case-sensitive so
`/tmp/Foo` cannot prove an operation against `/tmp/foo`.

The longer-term Codex/Claude-shaped endpoint is a host-bound operation: after policy
approval, the host stamps the concrete tool call with the durable `operationId`, and
completion joins by `(runId, toolCallId, operationId)` instead of text. That requires a
new tool-call binding contract and is deliberately not simulated by accepting any
successful bash action from the same Run. Until that contract exists, `exact_command`
and `executable` are the only command match policies.

Dependency evidence must complete after the evidence for every referenced dependency.
An action with no matching target, a runner summary, or assistant prose cannot substitute
for action evidence.

- Missing evidence for a required operation blocks the step with
  `required_operation_missing_evidence`; the workflow cannot become `succeeded`.
- Matching attempted evidence that failed, timed out, was cancelled, or exited non-zero
  fails the step unless an existing retry policy keeps it non-terminal.
- `required_command_non_zero_exit` is emitted only for a numeric non-zero exit code.
  A failed legacy command with no numeric code uses `required_command_failed`; a command
  that otherwise claims success but lacks the structured terminal exit field uses
  `required_command_missing_exit_code`.
- Missing optional evidence does not block completion, but remains an `unverified` risk
  in TerminalReport evidence.
- A step may transition to `succeeded` only after its execution verification is
  `verified`. Fan-in accepts only verified required predecessor steps.
- Verification is repeatable after restart. Re-running it over the same action ids yields
  the same result and does not duplicate workflow transitions.

### Source turn lifecycle

The accepted user message owns the source `LingTurn`. Workflow-step turns and Runs are
execution evidence; they do not replace that user-intent lifecycle.

- `ChannelWorkflowMetadata.sourceTurnId` is required for workflows created from a
  channel intent/proposal. It is resolved from the source ConversationItem at workflow
  creation, not inferred from the step Run later.
- When the workflow starts, the source turn moves from `open` to `running`.
- When the workflow is waiting for a pre/post-step approval, the source turn moves to
  `waiting_for_approval`; approval resume returns it to `running`.
- Terminal workflow state alone does not settle the source turn. After a committed
  TerminalReport is published as the final result, `succeeded` maps to turn `succeeded`,
  `blocked` or `partially_succeeded` maps to turn `blocked`, `failed` maps to `failed`,
  and `cancelled` maps to `cancelled`.
- If TerminalReport synthesis or publication fails, the source turn remains recoverable
  and unsettled. Recovery retries publication before applying the outcome mapping.
- When TerminalReport is disabled, the legacy final coordinator reply is the publication
  barrier and applies the same mapping.
- Source-turn transitions use compare-and-set semantics, append a `turn` state transition
  event, and carry an idempotency key derived from workflow id, published result id, and
  target status. Duplicate terminal callbacks therefore do not publish a second result
  or settle the turn twice.
- `turn` is part of the shared `StateEntityType` contract and every state-transition API
  allowlist. `/state-transitions?entityType=turn` must return the durable publication and
  recovery transitions; a Core-only enum value is not a complete observable contract.
- `blocked` is a settled but resumable `LingTurn` state. Publishing a blocked or partial
  report records one idempotent blocked-settlement event even when the Turn was already
  blocked; it does not convert that state into an immutable terminal status or prevent a
  later user-driven resume.
- The deterministic assistant Item, TerminalReport publication marker, compatible source
  Turn transition plus its state-transition event, and durable control-plane invalidation
  are committed by one SQLite publication-barrier transaction. The in-memory SSE/RPC hub
  is notified only after commit. A crash before commit leaves nothing published; a crash
  after commit but before live notification is recovered by durable event replay.
- The Core publication store derives the source-Turn target from the fresh Completion
  Evaluation and validates the report outcome plus deterministic committed Item lineage.
  Daemon prose/publisher code cannot independently choose a target status or arbitrary
  final Item. An outcome mismatch or partial lineage is a typed all-or-nothing conflict.
- Startup recovery repairs workflows whose final result is already published while the
  source turn is still `open`, `running`, or `waiting_for_approval`, or while a blocked
  Turn lacks its matching settlement event. An immutable terminal source turn is never
  reopened by recovery.

### Final-result delivery and live projection

Terminal workflow state and final-result publication are separate commits because report
synthesis may outlive the Run and workflow transition. A client that queries reports when
the workflow first becomes terminal can therefore receive an authoritative empty result.
That empty result must not become a permanent cache entry.

`TerminalReport` plus its committed `final_result` Item is the only user-visible terminal
result. Workflow cards and activity rows remain folded progress/evidence surfaces after
publication; they may link to the report, but cannot emit a second summary, count, or
assistant final message. Replayed publication events, duplicate callbacks, and reconnect
refreshes are idempotent projections of the same report marker.

The delivery contract is:

1. Report synthesis commits or reuses the TerminalReport record, but does not make it
   visible or settle the source Turn.
2. One store transaction revalidates the report and fresh Completion Gate basis, creates
   or reuses the deterministic assistant Item, records `publishedMessageId`, closes the
   source `LingTurn` with a compatible CAS state-transition event, and appends a durable,
   content-free control-plane event in the existing `work_units` domain with
   `entityType="terminal_report"` and `action="terminal_report.published"`. The event
   contains only ids and status metadata; report text remains in canonical storage.
   If the source Turn is already terminal with an incompatible status, the whole
   transaction fails with a typed reconciliation conflict and publishes nothing.
3. After commit, the daemon offers the returned durable event to the live SSE/RPC hub.
   Losing this best-effort notification is harmless because reconnect replay reads the
   same event row. Re-entering the transaction returns the already published lineage and
   does not append another Item, report marker, Turn event, or invalidation.
4. The selected Channel refreshes its canonical Items on that invalidation. The Web
   TerminalReport query is keyed by both workflow/runtime revision and committed Channel
   Item identity/revision, so the newly published Item causes a second query even when the
   workflow timestamp no longer changes.
5. The structured report is projected into the existing operation cell/final-result
   block. The publication Item is hidden only after its matching TerminalReport is loaded,
   preventing a permanent duplicate while keeping durable markdown as a reload fallback.
6. One mounted stream keeps the last applied control-plane sequence. A transient
   reconnect subscribes from that same sequence and replays later durable events; it must
   not replace the cursor with a newer snapshot sequence before applying the intervening
   invalidations.
   Both SSE and local RPC register live delivery before querying replay, then merge by
   sequence, de-duplicate, and order the handoff batch so an event committed during the
   replay query is neither lost nor delivered out of order.
   RPC additionally keeps the listener provisional until the `controlPlane.subscribe`
   response has been sent. Replay/live notifications cannot precede the response that
   gives the client its `subscriptionId`; a snapshot-required result has no id and leaves
   no listener behind.
   The server captures a replay upper bound and queries matching rows through that bound
   with one extra row. Global sequence gaps caused by another workspace or a domain filter
   are legal; completeness uses a per-workspace durable replay-state floor/latest
   watermark and bounded query, not numeric contiguity. That replay state survives an
   empty event table; event append advances latest, and future deletion advances the floor
   atomically. If the cursor is ahead of the bound, below retention, or the requested range
   exceeds the safe window, it closes the provisional subscription and returns
   `control_plane_snapshot_required`; it never truncates the range and advances the client
   over an unknown gap. A complete empty range returns an explicit replay-ready window.
   If replay lookup or initial handoff fails after live registration, subscription setup
   atomically rolls back that live client and closes its response/listener before
   propagating the error. A failed subscribe attempt can never remain eligible for later
   publication events.
7. A first mount, workspace switch, or lost client cursor uses a snapshot handoff: close
   the old subscription, read sequence `S`, establish a provisional live subscription
   after `S` while buffering its events, and perform one authoritative refresh of the
   selected Channel Items/activity/runtime projection. Events committed after `S` are
   buffered/replayed by the subscription, while the refresh covers everything at or
   before `S`. Only after that refresh succeeds may the client set its applied cursor to
   `S` and drain the buffered events. Subscribing after the refresh would create a new
   snapshot-to-live gap and is forbidden.
8. One coalescing window unions changed domains. With a selected Channel, a
   `runs + work_units` batch performs one Channel projection refresh and one runtime
   refresh; it does not also refresh the unrelated normal-Conversation surface. Without
   a selected Channel, the same batch refreshes the selected normal Conversation instead.
   Superseded TerminalReport requests cannot overwrite a newer result with an earlier
   empty response.
   Queue coalescing may replace repeated invalidations with their newest event, but the
   complete emitted queue must be sorted by durable `seq` afterward, including preserved
   approval and terminal-Run events. SSE and local RPC consume one shared pure
   coalesce/sort helper. Concatenating preserved events before coalesced events is
   forbidden because a later high sequence can advance the client's receive cursor and
   cause a following lower-sequence invalidation to be discarded as stale.
9. An authoritative refresh reconciles Items by durable identity and revision. An Item
   whose identity and rendered revision are unchanged keeps its mounted interaction
   owner, so transient hover, focus, disclosure, selection, and preview state are not
   destroyed merely because a control-plane snapshot returned equivalent canonical data.
   A changed revision may replace the rendered Item, but any state that must survive that
   replacement is keyed outside the ephemeral Item component by stable Item/reference
   identity. Timed interaction may not depend on a component instance surviving an
   unrelated authority refresh.
10. Full reload reads Items and TerminalReports from SQLite. Control-plane delivery may be
   replayed or coalesced without affecting correctness, and no unbounded UI polling is
   required.

Repeated publication or startup recovery may reuse the same Item and report without
emitting another publication invalidation. A lost live connection is recovered from the
durable event replay or the next authoritative page load.

Because Ling is pre-release, v1 decision rows are removed during the v2 migration.
Runtime code accepts only schema v2 and exposes no old enum aliases.

The execution-plan amendment uses migration 113 to rewrite existing schema-v2 singular
`execution_json={kind,targetKind,targetRef?}` rows into a one-operation plan. Runtime
code performs no dual read. A recorded version row does not suppress repair while any
non-null `execution_json` still fails the operation-plan validator. Historical terminal workflows remain immutable; non-terminal
workflows may be revalidated from the migrated decision before they advance.

Migration 114 adds the required participant manifest. It may complete only when every
existing decision can be deterministically reconstructed from selected teammate ids,
proposal collaboration/assignee data, linked workflow step ownership, teammate role
metadata, and execution-operation subsets. A true no-participant discussion/control
decision receives the canonical empty manifest. An execute/proposal decision does not.

If any row cannot be reconstructed or the sources disagree, migration 114 rolls back and
reports the exact row ids and conflicting sources. The daemon does not start against a
database whose execution requirements were silently weakened. Because this amendment is
unreleased development data, the supported remedies are to fix the migration source row
or reset that local development database, not to add a permanent runtime compatibility
reader. A locally recorded draft migration 114 is considered incomplete unless its
postconditions pass; the migration re-enters repair/rebuild even if the version row
already exists.

Migration 115 materializes `DelegatedStepRequirementV1` for every non-terminal,
manifest-backed workflow step and copies the same immutable requirement into the step's
currently linked Run request snapshot. It may derive the requirement only when the source
decision, participant manifest, immutable graph fingerprint, graph node ownership,
required operation ownership, and dependency edges agree. Any mismatch rolls back the
whole migration with the conflicting workflow/step ids. Terminal historical steps are
not rewritten or guessed; if their publication chain is incomplete, reconciliation
blocks publication as historical corruption. A recorded migration-115 version row with
missing or corrupt postconditions re-enters repair, and runtime code has no requirement
fallback or dual reader.

## Persistence Shape

The exact migration is owned by the implementation plan. The target relational shape is:

```text
ling_threads
  + surface_kind
  + relation_kind
  + anchor_item_id
  + fork_context_snapshot_id
  + next_item_sequence

ling_turns
  + effective context assignment through turn_context_assignments

conversation_items
  UNIQUE(thread_id, sequence)
  UNIQUE(thread_id, idempotency_key) WHERE idempotency_key IS NOT NULL

context_segments
  thread_id, state, label, created_from_turn_id, last_active_turn_id

turn_context_assignments
  turn_id, segment_id, status, source, evidence, policy_version, supersedes

conversation_context_summaries
  scope, coverage watermark, typed facts, source refs, version, supersession

conversation_context_snapshots
  projection version, item watermark, summary ids, source refs

channel_intent_decisions
  schema v2 source turn/item/segment/projection fields
  execution_json = typed operation plan + daemon-owned commandMatchPolicy
  participant_manifest_json = immutable RequiredParticipantManifestV1 + fingerprint

channel_workflows.metadata
  sourceTurnId for intent/proposal-owned workflows
  requiredParticipantManifest + fingerprint copied from the accepted decision
  completionGate = derived participant/operation/dependency/fan-in verification snapshot

channel_workflow_steps.metadata
  delegatedRequirement = immutable DelegatedStepRequirementV1 + fingerprint
  executionPlan subset + executionVerification evidence action ids
  required participant mapping + typed DelegatedOutcomeV1 refs

run_sessions.request_snapshot
  exact workflow participant id + workflowStepId + delegatedRequirement
  effective systemPrompt + appendSystemPrompt + approvalProfile
  exact operation-derived tools + provider/runner binding

work_units
  kind = channel_turn_dispatch
  owner_type = ling_turn, owner_id = source turn id
  linked_message_id = source ConversationItem id
  request_json = typed dispatch metadata and durable stage checkpoints
```

## Invariants

1. Every committed user item belongs to exactly one thread and one user-intent turn.
2. Every item has a stable per-thread sequence.
3. Every accepted user turn has exactly one effective context assignment.
4. A model never commits arbitrary segment ids or bypasses visibility filtering.
5. Selector, reply, resolver, workflow, and agent views share one projection version.
6. Summaries never become safety, permission, approval, or business-state authority.
7. Source refs can recover the evidence behind every summary and agent result.
8. Topic and branch inheritance never copies the parent transcript.
9. Committed items are corrected by supersession, not destructive overwrite.
10. Domain state remains authoritative in its domain table.
11. An active reply can accept guidance only from the same structurally identified
    conversation line and only through an explicit typed disposition.
12. Every required execution operation has matching successful evidence before its step
    or workflow can succeed.
13. Every intent/proposal-owned workflow has one source `LingTurn`, and publishing its
    final result settles that turn exactly once while preserving blocked-state resume.
14. Every accepted user turn has exactly one durable dispatch work unit created in the
    acceptance transaction; HTTP/SSE lifetime never owns accepted work.
15. Semantic segmentation, summary generation, and reply-lane linking are bounded. A
    timeout produces a deterministic fallback or a visible blocker, never a silent open
    turn.
16. A newly published final-result Item invalidates the selected Channel projection after
    publication. A workflow-terminal query that returned zero reports cannot suppress a
    later committed report.
17. A live control-plane reconnect preserves its last applied durable sequence. If that cursor
    is unavailable, snapshot handoff establishes buffered live delivery after snapshot
    sequence `S`, refreshes canonical Channel state through `S`, then advances the cursor.
18. Reapplying an equivalent canonical Item projection preserves identity-scoped Web
    interaction state; a control-plane refresh cannot silently cancel an in-progress
    preview or disclosure for an unchanged Item/reference.
19. A replay/handoff failure after live-first registration removes the provisional client
    before the subscribe call fails; no orphan stream or listener remains in the hub.
20. Mentioned and unmentioned turns pass through the same intent/delegation selector.
    Mention presence cannot cause an ordinary-reply early return.
21. The canonical participant manifest is fixed at accepted-decision time. Every required
    participant is represented by the workflow graph and cannot be removed by later
    assistant prose or proposal regeneration.
22. A visible assistant message with delivery state `ready` never proves delegated work
    completed. Delegated completion requires a typed outcome backed by durable evidence.
23. A workflow reaches `succeeded` only after its completion gate verifies participant
    coverage, required operation evidence, dependency order, fan-in policy, and
    termination policy.
24. A successful completion commit validates the complete canonical read-set inside its
    SQLite transaction; workflow/step timestamps alone cannot protect the Run-event and
    approval rows behind derived actions, sealed packet payloads, or decision evidence.
25. TerminalReport publication is all-or-nothing across final Item, report marker, source
    Turn transition/event, and durable invalidation. Live SSE/RPC notification happens
    only after commit.
26. A bounded replay that cannot prove a gap-free range returns
    `control_plane_snapshot_required`; the server never truncates replay and advances the
    client over unseen events.
27. Workflow output packets are content-addressed and sealed in SQLite before use; a
    projected file cannot override the sealed JSON/digest or satisfy synthesis by itself.
28. Snapshot handoff establishes buffered live delivery after sequence `S` before the
    authoritative refresh, then advances the applied cursor only after that refresh.
29. A command-target operation carries one daemon-owned match policy. Display labels,
    stdout, action summaries, assistant prose, and unrelated same-Run tool calls cannot
    satisfy it.
30. `run_cancelled`, approval cancellation, and a delegated `cancelled` outcome require
    an explicit user/workflow cancellation authority. Daemon shutdown, Desktop quit,
    process signals, and timeout watchdogs cannot impersonate `local-user`.
31. A pending approval with a valid resume checkpoint survives daemon restart under the
    same logical Run, workflow step, participant manifest, and evidence lineage. Only the
    process-owned attempt changes, and the old attempt is fenced from later completion.
32. Approval-resume claim/re-claim, pre-dispatch suspension, and terminal/block settlement
    are separate atomic SQLite transactions. None may expose a checkpoint, Attempt, Run,
    work-unit, Task, runtime-audit, or invalidation state that contradicts another row in
    the same transition.
33. Durable `tool_start` and `tool_end` bracket the only non-transactional local
    side-effect window. A `tool_start` without `tool_end` is never retried automatically.
34. Control-plane delivery follows commit. A failed/stale resume transaction publishes
    no event, and reconnect reloads canonical state rather than replaying the side effect
    or resubmitting the accepted Turn.
35. Every manifest-backed workflow Run binds the exact step participant's base/append
    prompts and approval profile before Run creation, persists the effective request
    snapshot, and receives only its operation-derived required tools. Same-Run restart or
    Attempt replacement reuses that snapshot; generic internal Runs are never hydrated by
    this rule.

## Failure Modes

| Failure | Required behavior |
| --- | --- |
| Model proposes an inaccessible segment | reject proposal; use structural/current fallback; record safe diagnostic |
| Two turns create sequence numbers concurrently | serialize cursor allocation in one SQLite transaction |
| Summary completes after assignment correction | reject late result by assignment/projection version |
| Agent returns against stale projection | accept only if changed refs are unrelated; otherwise rebase or rerun |
| Explicit local write has no target | structured clarify with `missingFields=["target"]` |
| Conversational article continuation says `开始` | remain `reply`; do not call file TargetResolver |
| Root reply is active while a Branch message arrives | reject cross-line queueing; run Branch intent/reply independently |
| `activeRunId` is stale, terminal, or belongs to another line | ignore the queue relation and continue normal intent selection |
| New unrelated root request follows bad clarification | assign/switch segment before intent; do not inherit clarification as task state |
| Private memory is selected for public channel view | fail closed before rendering; record redacted policy rejection |
| Summary generation fails | keep raw source refs and recent tail; retry asynchronously; do not lose history |
| Item append retries after disconnect | idempotency key returns existing item and sequence |
| Runner succeeds after writing but never runs the requested check | block the step; missing required command evidence cannot be reported as success |
| Command exits non-zero or times out | fail the owning operation/step; retain command evidence for report and retry |
| Duplicate terminal workflow callback | CAS transition and publication idempotency return the committed result without another reply |
| Daemon restarts during final-result publication | the atomic publication barrier leaves either no visible lineage or a fully replayable Item/marker/Turn/event lineage |
| Workflow becomes terminal before report synthesis commits | publication emits a post-commit invalidation; the new Item revision re-queries and renders the report |
| Publication invalidation is replayed or coalesced | clients re-read canonical Items/reports idempotently; no duplicate result is appended |
| Control-plane stream disconnects after publication | reconnect resumes from the last applied durable sequence; if the cursor was lost, snapshot handoff refreshes canonical state before older events are considered covered |
| Requested replay exceeds the safe window or retained history | server closes the provisional subscription with `control_plane_snapshot_required`; client performs authoritative snapshot handoff without skipping the gap |
| Cursor is ahead of the captured replay bound | return `control_plane_snapshot_required`; do not treat the impossible cursor as an empty complete range |
| Domain/workspace filtering skips numeric sequence values | prove completeness by the bounded filtered query and retention floor; do not trigger a false gap |
| Publication commits while stream replay is being queried | live-first subscription plus sequence merge delivers it once in order; no replay/live handoff gap |
| Publication commits after snapshot `S` while refresh is in flight | provisional subscription buffers it; apply once after the `<= S` refresh succeeds |
| Replay lookup throws after live registration | close and remove the provisional client before propagating the subscribe error; later publications cannot write to it |
| `runs` and `work_units` arrive in one coalescing window | refresh runtime and the selected Channel projection once; do not also refresh the unrelated normal-Conversation surface |
| An older empty TerminalReport request resolves late | request generation/cancellation rejects it; it cannot replace the report loaded for the newer Item revision |
| Equivalent Item data is returned during hover/focus delay | reconcile by Item/reference identity; preserve the pending/open interaction instead of remounting and cancelling it |
| SSE disconnects after the user item is accepted | durable dispatch continues; reconnect projects committed state without resubmitting work |
| Segmentation provider stalls or returns invalid JSON | abort at the policy deadline; commit conservative assignment and continue routing |
| Hard summary generation stalls or fails | use last committed summary plus deterministic bounded tail; block visibly only when required tail cannot fit |
| Daemon exits after acceptance but before intent selection | startup recovery claims the persisted dispatch and resumes idempotently from committed checkpoints |
| Desktop restarts the daemon while a required participant waits for approval | suspend/lose only the old attempt; preserve Run, approval, checkpoint, step, manifest, and prior evidence |
| Old runner callback arrives after approval resume created a new attempt | reject it by `activeAttemptId`/runtime-instance fence and retain a diagnostic event only |
| Resumed tool request differs from the approved checkpoint | require a new approval or block with `approval_resume_mismatch`; never reuse the old decision |
| No safe native or Ling-continuation resume exists | publish `blocked(approval_resume_unsupported)` through the shared finalizer/gate; never cancel by infrastructure inference |
| Idle or hard timeout aborts a runner | record typed failure/timeout evidence; do not attribute cancellation to the user |
| Rapid-submit predecessor never links a Run | expire the short lane-link wait and continue normal intent selection |
| `；@QA` or another Unicode-delimited mention is submitted without mention metadata | materialize the unambiguous canonical participant before selection or block visibly; never silently omit QA |
| An explicit Agent mention also asks for file/command work | run normal intent selection; create delegated execution rather than the no-tools ordinary-reply path |
| A custom Engineer is explicitly mentioned but a built-in Engineer appears first in role order | preserve the custom participant id through decision, manifest, proposal, graph step, and Run; role order cannot substitute it |
| The correct custom participant id reaches the Run but its teammate prompts/profile are absent | block delivery, bind the canonical profile in the shared workflow adapter, persist it in the Run snapshot, and rebuild; do not patch the test prompt or generic Run orchestrator |
| A manifest-backed caller supplies another assignee or the teammate loses a required tool before start | commit one typed pre-Run participant blocker and create no Task/Run/approval; never substitute or widen tools |
| Two distinct explicitly mentioned teammates have the same role | preserve both ids; compile both into the graph or block/clarify operation assignment; never de-duplicate by role |
| An explicitly mentioned participant lacks a required tool | keep the named identity and publish `participant_required_tools_unavailable`; do not silently choose a tool-capable peer |
| A delegated Agent returns “I will execute” with no tool action | keep the participant/Turn non-terminal and record a typed missing-outcome blocker; do not treat `ready` as success |
| Natural-language `Node 调用...` is stored as exact command `Node` | reject that materialization; store executable identity `node` and validate the concrete single-command evidence |
| An executable match sees a wrapper, chain, redirect, substitution, or unrelated command | fail closed with missing required-operation evidence; do not credit stdout or aggregate shell success |
| Engineer finishes but required QA has no graph step | fail the manifest/graph consistency check with `required_participant_missing`; workflow cannot start or succeed |
| Required branch reaches terminal state without verified operation evidence | keep fan-in blocked with `required_participant_evidence_missing` |
| `requireAllBranchesTerminal=true` while one declared branch is active or absent | do not create successful fan-in evidence and do not transition the workflow to success |
| Resume suspension writes `Attempt=lost` but the daemon stops before checkpoint/audit/invalidation writes | roll back the whole suspension transaction; startup reloads the prior canonical shape and reclassifies it |
| Resume terminalization updates Run before checkpoint, work unit, Task, or invalidation | roll back the whole terminal transaction; no partial terminal state or observer wake-up is legal |
| Terminal resume transaction commits but daemon stops before workflow reconciliation | startup consumes the terminal Run/evidence through the shared delegated finalizer and Completion Gate; do not execute the tool again |
| Resume CAS loses to a concurrent callback or startup worker | write and publish nothing; reload the winning Attempt/checkpoint lineage and reconcile it idempotently |

## Acceptance Criteria

- Issue #421 article continuation remains conversational and produces no local-file target
  clarification.
- A new unrelated root request after a clarification receives a fresh or correctly
  matched segment and does not inherit the old missing-field state.
- Explicit local-file requests without a target still clarify safely.
- Root, topic, and branch each resolve to an explicit `LingThread`.
- Every user turn creates a `LingTurn`, including ordinary questions and replies.
- Selectors, replies, TargetResolver, workflows, and specialists record the same context
  projection version for one turn.
- Long conversations proactively summarize before a provider rejects context length.
- A user can inspect summary source refs and recover original committed items.
- Segment corrections invalidate derived summaries without mutating raw items.
- A resumed or newly joined agent receives shared core facts plus role-scoped evidence,
  without private cross-agent leakage.
- No runtime `single_reply` or `direct_workflow` value remains after v2 migration.
- A create-only request grants only `write`; a create-and-run request materializes
  ordered `write + bash` operations and requires evidence for both.
- A complete command-shaped span persists `exact_command`; an explicit runtime plus
  execution objective persists `executable`; a discussion-only runtime mention creates no
  executable operation.
- Executable matching accepts a quote-aware single simple command with the planned first
  executable token and rejects wrappers, prefixes, top-level shell composition,
  redirection, substitution, executable paths, and unrelated commands.
- A custom manifest-backed participant's unique base prompt, append fragments, and base
  approval profile reach both the actual Runner request and the durable Run request
  snapshot. The Run tool list remains exactly the workflow-required subset.
- Manual step start, automatic orchestration, and explicit retry share the same profile
  adapter. A manifest assignee mismatch or current teammate tool gap creates a typed
  blocker without a Run; same-Run restart/resume reuses the stored profile unchanged.
- A missing, failed, non-zero, timed-out, cancelled, or out-of-order required operation
  prevents workflow success and is visible in folded evidence.
- A successful legacy Pi bash `tool_end` with no explicit exit code normalizes to exit 0
  and preserves its final bounded stdout, while a failed legacy call keeps an unknown
  exit code and a structured unified-exec result never receives that compatibility
  inference.
- Online Run callbacks, post-step approvals, startup recovery, duplicate callbacks, and
  TerminalReport pre-publication checks use the same delegated-step finalizer and
  canonical Completion Gate. No manifest-backed path maps Run or aggregate step status
  directly to success.
- Restarting the daemon at a pending approval keeps the same approval id, Run id,
  workflow-step id, required-participant manifest, and prior evidence; startup fences the
  lost attempt and either creates one replacement attempt after the decision or commits
  one structured resume blocker.
- Explicit user/workflow cancellation still cancels the Run and pending approval, while
  daemon shutdown and timeout paths produce suspension/failure semantics with no false
  `local-user` transition.
- A synthesis/review restart after packet preparation reuses one attempt-bound output
  packet; execution/verification cannot enter this no-tool completion path.
- A stale/private fan-in context produces a typed delegated blocker through the shared
  finalizer rather than bypassing outcome persistence.
- A canonical explicit teammate mention is preserved by id through decision,
  `selectedTeammateIds`, manifest, proposal collaboration step, workflow graph step, and
  linked Run. A same-role built-in or default teammate cannot replace it.
- Multiple explicit teammate mentions are de-duplicated only by id and either all appear
  in the graph with valid operation ownership or the Turn becomes visibly
  blocked/clarified before execution starts.
- A named unavailable or under-capable participant remains the named participant in the
  accepted lineage and yields a typed blocker; capability fallback runs only when no
  participant was explicitly requested.
- Single-Agent and multi-Agent workflows use the same operation evidence validator; a
  fan-in step cannot hide a missing predecessor operation.
- Success, blocked/partial, failure, and cancellation publish one final result and settle
  the original user `LingTurn` to the matching status exactly once. `blocked` remains
  resumable; success/failure/cancellation remain immutable terminal states.
- Restart recovery reuses the all-or-nothing publication lineage without duplicating the
  TerminalReport, Item, Turn transition, or invalidation.
- After the daemon acknowledges a user item, closing SSE or restarting the daemon cannot
  lose its dispatch; the same source turn reaches a reply/workflow or a visible blocker.
- A stalled segmentation or summary provider cannot leave the source turn silently open.
  Segmentation falls back conservatively, and hard-summary failure uses a bounded
  projection or produces `context_projection_over_budget`.
- Retrying the same accepted request reuses one Item, Turn, dispatch work unit, and final
  reply/workflow lineage.
- If a report is committed after the workflow-terminal refresh already returned an empty
  list, the open Channel renders the structured final result without a page reload.
- Replaying publication invalidation or re-running startup recovery does not duplicate the
  TerminalReport, publication Item, final-result block, or source-turn settlement.
- Crash injection after each internal publication write leaves either no visible result
  lineage or one complete Item/marker/Turn-event/invalidation lineage.
- Disconnecting and reconnecting the control-plane stream between workflow terminal state
  and report publication still renders the result without reload; snapshot handoff and
  event replay cover both sides of the reconnect boundary.
- The reconnect cursor records the last event whose canonical refresh applied, not merely
  the last event received. A failed refresh leaves the cursor replayable and never
  resubmits the accepted Turn or restarts work.
- Replay-window overflow and retained-history gaps produce
  `control_plane_snapshot_required`; the subsequent snapshot refresh applies before its
  sequence becomes the durable cursor.
- A coalesced `runs + work_units` event batch issues only one runtime refresh and one
  selected-Channel projection refresh; it refreshes a selected normal Conversation only
  when no Channel is selected.
- Reapplying an equivalent selected-Channel snapshot during a delayed reference hover
  keeps the same identity-scoped preview lifecycle; the preview opens without requiring
  focus, retry, or a page reload.
- Structured mention tokens and Unicode-delimited plain-text fallback produce the same
  canonical participant ids. The committed Item, TurnEnvelope, decision manifest,
  proposal, and workflow preserve that set without downstream body reparsing.
- An explicit teammate mention does not bypass intent selection. Discussion gets a
  no-tools reply, while explicit delegated file/command work enters the workflow and
  evidence path.
- Delegated execution cannot succeed from `channel_ai_reply` text or assistant delivery
  state `ready`; it yields `completed` with evidence, `workflow_started`, or an explicit
  `blocked | failed | cancelled` outcome.
- A required Engineer + QA request cannot compile or complete as a one-participant
  workflow. Manifest/graph equality and completion-gate evidence cover both participants.
- `requireAllBranchesTerminal`, required participant coverage, dependency order, and
  operation or output-packet verification are executed by one fan-in/completion gate before workflow
  success and TerminalReport publication.
- Fault injection at every write inside approval-resume claim, suspension, and terminal
  transactions leaves either the complete old state or the complete new state, including
  runtime audit and durable control-plane invalidations.
- Restart before `tool_start`, between `tool_start` and `tool_end`, and after `tool_end`
  converges respectively to one retry, one visible effect-unknown blocker, and one
  evidence-backed finalization without duplicate local execution.
- A required Engineer + QA workflow remains non-successful while resumed QA evidence is
  absent; claim, suspension, Run success, or SSE delivery cannot shrink the accepted
  participant manifest or satisfy fan-in.

## Open Implementation Parameters

These values are intentionally policy settings, not unresolved architecture:

- exact soft/hard summary thresholds after measuring real provider budgets;
- provisional-segment promotion confidence and second-turn window;
- how much segment correction UI is exposed by default versus advanced context details;
- whether all context projection metadata is persisted or only projections used by a
  model, run, fork, or inspect request.
- exact segmentation, hard-summary, and rapid-submit lane-link deadlines after macOS
  latency measurement.

The architecture has no unresolved ownership decision. These parameters can be tuned
behind versioned policy without changing the data model.
