# Codex-Like Execution Experience

## Purpose

This document defines the complete Ling Stack execution experience needed for users to
do real project work with AI teammates in a Codex-like way.

The target is not to clone Codex internals. The target is to make Ling Stack feel like a
durable local workbench:

```text
open a task or thread
-> ask an AI teammate to work
-> inspect proposed side effects before they happen
-> approve, deny, redirect, or queue follow-up instructions
-> keep every event, artifact, decision, and state transition auditable
-> resume the work later with clear lineage and bounded context
```

This design combines two product surfaces that must work together:

- approval and audit hardening,
- long-lived thread, continuation, and resume behavior.

Pi remains the default single-run execution kernel. Ling owns durable thread state,
approvals, audit, recovery, and continuation.

## Current State

Implemented foundations:

- `PiRunnerAdapter` runs one Pi coding-agent session for one Ling run.
- Ling persists run sessions, run events, artifacts, work units, attempts, approvals,
  resource leases, and state transition events.
- Workspace approval policy can classify `read`, `grep`, `find`, `ls`, `bash`, `edit`,
  and `write`.
- Pi pre-tool interception is wired for `bash`, `edit`, and `write`.
- Approval requests can be stored, listed, approved, and denied.
- Runs can enter `waiting_for_approval`.
- Task/run state transitions use compare-and-set protections.
- Run interruption and continuation has a separate design baseline.
- RunnerRegistry and Multi-Agent Orchestrator designs define future runner and
  multi-step boundaries.
- `LingThread` now groups task runs, stores `activeRunId`/`lastRunId`, and is linked
  from `RunSession.threadId`.
- Continuation runs inherit their parent run's thread instead of creating isolated run
  history.
- `/threads`, `/threads/:id`, and `/runs?threadId=...` expose the first long-lived
  session read path.
- `/execution-actions` exposes an approval-backed `ExecutionAction` read model with run,
  thread, work-unit, policy snapshot, and target refs.
- `/threads/:id/evidence` exposes a regenerable thread evidence bundle built from
  linked runs, run events, approvals, artifacts, runtime events, execution actions, and
  state transitions.
- `/threads/:id/resume` starts a detached `manual_resume` continuation run from durable
  Ling thread/run context. It does not depend on Pi native session resume.
- The Web run history surface now includes a first-class thread list. Selecting a thread
  opens its active or last run, whose evidence panel auto-loads thread evidence, shows
  thread runs, execution actions, state transitions, and includes a manual resume composer
  for terminal runs.
- Approval cards render structured payload previews for common action types including
  `bash`, `edit`, `write`, `workflow_step`, MCP/tool calls, deploy, provider change,
  media cost, and external send.

Important gaps:

- Approval coverage is not complete for every side-effect category.
- Approval records now have an action-oriented read model, Web payload previews, durable
  preview/result artifact linkage, scope analysis, non-approval tool lifecycle actions,
  and git commit/push preview extraction for approval-backed bash actions.
- The UI exposes threads as a top-level list inside Run history and opens a thread-first
  detail panel for evidence, queued follow-ups, actions, and resume.
- `LingThread` exists as a backend grouping, lineage, evidence, and manual resume
  primitive; a dedicated route-level thread page remains optional polish.
- Pi session state is currently not the durable resume source. The current runner path
  creates a fresh session for a run.
- Mid-run user input should not be injected into the active Pi prompt. It must become a
  queued follow-up or an interrupt-and-redirect continuation.

Follow-up hardening:

- [Execution And Orchestration Hardening](execution-orchestration-hardening.md) defines
  the next Codex-like execution hardening slice: action preview/result artifacts, a
  thread-first page, resume context preview, and a stale completion audit event.
- [OpenAI Agents SDK Runtime Patterns](openai-agents-sdk-runtime-patterns.md) defines the
  borrowed trace/span, approval checkpoint, handoff, tool namespace, and sandbox contracts
  that should shape future execution hardening without changing Ling's source of truth.

## Implementation Status: Future Hardening Slice

Implemented:

- non-approval `tool_start`/`tool_end` events now appear in `/execution-actions` as
  `executing`, `succeeded`, or `failed` action records;
- approval-backed actions expose `scopes` and `scopeSummary`;
- `git commit` and `git push` bash approvals classify as `git_commit`/`git_push`;
- preview artifacts include a structured `gitPreview` block where direct git command
  inspection is possible, and fail closed when preview extraction is unsafe;
- stale runner completions after cancellation are recorded as
  `stale_runner_completion_ignored` without overwriting terminal run/work-unit state.
- the Web app now has a dedicated top-level `threads` view, loaded as its own route-level
  lazy page, which lists Ling threads and renders the same thread evidence, action
  artifacts, lineage, interventions, resume preview, and resume controls outside Run
  History.

Still future:

- richer action result rendering for every tool family;
- native runner-session resume when a non-Pi adapter can prove conformance.

## Goals

- Let a user inspect and approve risky actions before side effects happen.
- Make every side effect representable as an auditable action record.
- Make every run replayable from durable Ling events and artifacts.
- Keep long-lived work visible as a thread with run lineage, not as isolated attempts.
- Support queue follow-up and interrupt-and-redirect without prompt injection.
- Build continuation context from durable Ling state, not from hidden runner memory.
- Prevent stale runner completions from overwriting cancelled or redirected work.
- Keep runner native resume optional. Ling should still work if the runner starts a new
  session every run.
- Keep approvals, audit, memory, and tool access scoped by workspace, channel, teammate,
  task, and workflow.

## Non-Goals

- No token-stream prompt patching into an active Pi session.
- No silent auto-approval of side effects.
- No hidden cross-channel context transfer.
- No direct mutation of memory, persona, tools, or approvals from continuation text.
- No dependency on Pi CLI as the default execution surface.
- No requirement that Codex app-server exists before this design can be useful.
- No attempt to recover arbitrary shell side effects after a process crash.
- No external send, deploy, credential, or provider mutation without explicit approval.

## Core Position

Ling Stack should model project work as durable product state:

```text
LingThread
  -> RunSession
    -> WorkUnitAttempt
      -> Runner events
      -> Approval actions
      -> Tool results
      -> Artifacts
      -> State transitions
  -> Continuation runs
  -> Evidence bundle
```

Runner sessions are execution details. They can improve fidelity if a runner exposes
native resume, but they are not the source of truth.

## Product Model

### LingThread

A `LingThread` is the long-lived work container. It can represent a task discussion, an
active coding task, a workflow step, or a direct teammate thread.

```ts
type LingThreadKind =
  | "task"
  | "channel_discussion"
  | "teammate_direct"
  | "workflow_step"
  | "external_work";

type LingThreadStatus =
  | "open"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "archived";

interface LingThread {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: LingThreadKind;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly teammateId?: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly externalWorkId?: string;
  readonly title: string;
  readonly objective: string;
  readonly status: LingThreadStatus;
  readonly activeRunId?: string;
  readonly lastRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
}
```

Rules:

- A thread may have many runs.
- Only one active run should own the thread at a time unless a later concurrency slice
  explicitly enables parallel branches.
- Thread status is derived from active run, approvals, blockers, and terminal state.
- Thread state must never depend on an open browser tab or SSE connection.

### Run Lineage

Runs should record explicit lineage:

```ts
interface RunLineage {
  readonly threadId?: string;
  readonly parentRunId?: string;
  readonly sourceRunId?: string;
  readonly interventionId?: string;
  readonly continuationReason?: "queued_followup" | "interrupt_redirect" | "retry" | "manual_resume";
}
```

This lets the UI explain:

```text
Run 3 continues from Run 2 because the user redirected the work.
Run 4 follows Run 3 because a follow-up instruction was queued.
```

### Approval Action

Approval requests should become a full action ledger. The existing approval table can
remain the durable storage shape, but the product contract should be action-oriented.

```ts
type ExecutionActionType =
  | "write"
  | "edit"
  | "bash"
  | "git_commit"
  | "git_push"
  | "external_send"
  | "deploy"
  | "media_cost"
  | "credential_change"
  | "provider_change";

type ExecutionActionStatus =
  | "proposed"
  | "waiting_for_approval"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled"
  | "executing"
  | "succeeded"
  | "failed";

interface ExecutionAction {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly runId?: string;
  readonly workUnitId?: string;
  readonly attemptId?: string;
  readonly approvalId?: string;
  readonly toolCallId?: string;
  readonly actionType: ExecutionActionType;
  readonly risk: ApprovalRisk;
  readonly status: ExecutionActionStatus;
  readonly title: string;
  readonly summary: string;
  readonly targetRefs: readonly ActionTargetRef[];
  readonly previewArtifactIds: readonly string[];
  readonly resultArtifactIds: readonly string[];
  readonly policySnapshot: EffectiveRunPolicySnapshot;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly executedAt?: string;
  readonly completedAt?: string;
}
```

For early implementation, `ExecutionAction` can be a read model assembled from approval,
run events, artifacts, and state transitions. It does not need to be a new table on day
one if the current schema can produce the same UI and API response.

## Complete Approval Flow

The complete flow is:

```text
runner requests tool or mutation
-> adapter builds action proposal
-> policy classifies action and scope
-> preview is generated
-> approval/action record is persisted
-> run/work unit enters waiting_for_approval when needed
-> UI/CLI shows preview and risk
-> user approves or denies
-> approved action resumes
-> result is captured
-> action and run timeline become replayable
```

Approval before side effect is mandatory. Evidence after side effect is audit, not
approval.

## Action Classification

### Read-Only Actions

Read-only tools remain allowed by default:

- `read`
- `grep`
- `find`
- `ls`

They still emit events and can create evidence artifacts when useful, but they do not
need approval unless channel policy narrows read access.

### Filesystem Mutations

`write` and `edit` require:

- target path,
- resolved real path,
- bound path comparison,
- diff preview when possible,
- file create/modify/delete classification,
- policy decision.

Required preview:

```text
File: packages/foo/src/bar.ts
Action: modify
Scope: inside channel bound path
Diff: artifact_art_...
Risk: medium
```

### Shell Commands

`bash` requires command classification before execution.

Risk signals:

- destructive filesystem patterns: `rm`, `mv`, `truncate`, `chmod -R`, `chown -R`,
- history mutation: `git reset`, `git rebase`, `git commit`, `git push`,
- remote code execution: `curl | sh`, `wget | sh`, downloaded script execution,
- privilege escalation: `sudo`, `su`, `launchctl`, credential helpers,
- broad package changes: lockfile rewrites, global installs, system package managers,
- secret exposure: `cat .env`, `security find-generic-password`, keychain reads,
- production or deploy tools.

The classifier should produce:

```ts
interface CommandRiskClassification {
  readonly risk: ApprovalRisk;
  readonly categories: readonly ExecutionActionType[];
  readonly reasons: readonly string[];
  readonly requiresApproval: boolean;
  readonly autoDeny?: boolean;
}
```

The first implementation can use conservative pattern matching. It should prefer asking
over allowing when uncertain.

### Git Actions

Git actions should be promoted from generic `bash` into explicit action types when the
command is recognized:

- `git_commit`
- `git_push`

Required approval preview:

- branch,
- staged files,
- commit message,
- remote and refspec for push,
- whether force push is requested,
- diffstat,
- untracked file count.

### External Sends And Deploys

External sends and deploys are not just tool calls. They are trust-boundary actions.

Required preview:

- target service,
- destination identity,
- payload summary,
- stale target revalidation rule,
- linked evidence artifacts,
- rollback or cancellation notes where applicable.

Approval and execute should be separated for high-risk external mutations:

```text
approve action
-> action remains approved
-> user clicks Execute
-> daemon revalidates stale target
-> daemon performs mutation
```

This avoids approval being mistaken for immediate irreversible execution.

### Credential And Provider Changes

Credential and provider changes need critical approval or explicit settings-originated
user action.

Rules:

- raw secret values must not enter run events, artifacts, or renderer state,
- approval preview should show secret ref and purpose, not value,
- provider changes should show model, base URL, API mode, auth ref, and capability
  changes,
- imported config must not silently switch active teammate or channel providers.

## Audit Trail

Every project run should answer:

```text
Who asked for this?
Which teammate ran it?
Which provider/model ran it?
Which runner backend executed it?
Which memory/context was used?
Which tools were requested?
Which actions were approved or denied?
Which files or external systems changed?
Which artifacts prove the result?
What happened after interruption, retry, or resume?
```

Required audit streams:

| Stream | Contents |
| --- | --- |
| Run events | normalized runner events, assistant deltas, tool events, terminal result |
| State transitions | task, run, approval, workflow, work unit, action state changes |
| Approval ledger | action proposal, policy snapshot, decision, resolver, expiry |
| Artifact ledger | diffs, files, logs, summaries, screenshots, metadata |
| Memory audit | used memory refs, scopes, recall query, redaction status |
| Lineage | parent run, continuation run, intervention, retry, resume reason |

The UI should render an evidence panel from these streams, not from a separate opaque log.

## Evidence Bundle

Each terminal run should produce or update an evidence bundle:

```ts
interface RunEvidenceBundle {
  readonly runId: string;
  readonly threadId?: string;
  readonly summaryArtifactId?: string;
  readonly eventLogPath: string;
  readonly stateTransitionCount: number;
  readonly approvalIds: readonly string[];
  readonly actionIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly changedFileRefs: readonly string[];
  readonly usedMemoryEventIds: readonly string[];
  readonly continuationRefs: readonly string[];
}
```

The evidence bundle is a read model. It can be regenerated from durable state.

## Redaction Rules

Redaction must run before data becomes durable or user-visible unless the data is an
explicit local artifact the user asked to preserve.

Rules:

- redact raw API keys and bearer tokens from request snapshots, events, artifacts, and
  error messages,
- store secret refs rather than secret values,
- do not attach raw keychain or environment values to approval payloads,
- redact provider auth headers before storing HTTP metadata,
- redact external action payloads according to target type,
- mark artifacts that may contain user-provided raw files as local-sensitive.

Redaction failure should fail closed for externally visible artifacts.

## Long-Lived Resume Model

Ling should provide continuity through `LingThread` and run lineage before relying on
runner-native resume.

The user experience:

```text
open thread
-> see prior runs and final summaries
-> type follow-up
-> Ling starts a continuation run with bounded context
-> new run links back to prior run
```

The continuation run may use a fresh Pi session. That is acceptable because Ling builds
the context explicitly.

## Resume Context Builder

A continuation prompt should be built from durable sources:

- original task and acceptance criteria,
- selected teammate and skill,
- previous run final summary,
- partial output summary if interrupted,
- linked artifacts and diffs by reference,
- active decisions and blockers,
- used memory refs,
- user follow-up or redirect instruction,
- current filesystem or external-state checks when needed.

The builder should enforce budgets:

```ts
interface ResumeContextBudget {
  readonly maxSummaryChars: number;
  readonly maxArtifactRefs: number;
  readonly maxEventSummaryChars: number;
  readonly includeRawDiffs: boolean;
}
```

Default behavior:

- include summaries and references first,
- include raw diffs only when small,
- never include unrelated private chats,
- never include cross-channel memory unless scope allows it,
- re-run memory recall for continuation and attach used-memory audit to the new run.

## User Interventions

### Queue Follow-Up

Use when the active run can continue:

```text
user submits follow-up
-> intervention status queued
-> active run continues
-> active run terminal
-> continuation run starts with follow-up context
```

Properties:

- no cancellation,
- FIFO order per thread,
- no permission grant,
- visible pending follow-up in UI.

### Interrupt And Redirect

Use when the active run should stop:

```text
user submits redirect
-> intervention records redirect
-> daemon cancels run/work unit
-> partial evidence remains durable
-> continuation context is built
-> new run starts with source lineage
```

Properties:

- source run remains visible,
- stale source completion cannot mark it succeeded,
- continuation re-resolves provider, skill, tools, approvals, memory, and leases,
- redirect instruction is not injected into the active Pi prompt.

## Stale Completion Guard

The daemon must reject stale runner completions after cancellation, interruption, or
terminal transition.

Required checks:

- active attempt id matches,
- work unit status is non-terminal,
- run status is non-terminal,
- cancellation/interruption marker is not terminal,
- state-machine compare-and-set transition succeeds.

If the runner finishes late, persist a diagnostic event:

```text
stale_runner_completion_ignored
```

Do not update run/task/workflow status from stale output.

## Native Runner Resume

Runner-native resume can be added later as an optimization.

Adapter capability:

```ts
interface RunnerResumeCapability {
  readonly supportsNativeResume: boolean;
  readonly resumeHandleKind?: "pi-session" | "codex-thread" | "external";
}
```

Rules:

- Ling still owns `LingThread`, lineage, approvals, and evidence.
- Native resume handles are opaque adapter metadata.
- If native resume fails, Ling can fall back to explicit resume context.
- Native resume must pass the same approval, cancellation, and stale completion tests.

## API Surface

Thread APIs:

```http
GET /threads?cwd=&channelId=&status=
POST /threads?cwd=
GET /threads/:id?cwd=
PATCH /threads/:id?cwd=
GET /threads/:id/runs?cwd=
GET /threads/:id/evidence?cwd=
```

Run continuation APIs:

```http
POST /runs/:id/interventions?cwd=
GET /runs/:id/interventions?cwd=
GET /run-interventions/:id?cwd=
POST /run-interventions/:id/cancel?cwd=
POST /threads/:id/resume?cwd=
```

Action ledger APIs:

```http
GET /actions?cwd=&runId=&threadId=&status=
GET /actions/:id?cwd=
POST /actions/:id/approve?cwd=
POST /actions/:id/deny?cwd=
POST /actions/:id/execute?cwd=
POST /actions/:id/cancel?cwd=
```

Existing approval APIs can remain. The action APIs can be introduced as a read/command
layer over approval records first.

## UI Surface

### Thread View

Status: implemented inside the existing Runs surface and as a dedicated top-level
`threads` view. Selecting a thread renders thread header, objective, lineage, actions,
queued follow-ups, state transitions, resume context preview, and the resume composer in
the right detail panel.

Required sections:

- objective and current status,
- active run card,
- prior run timeline,
- queued follow-ups,
- evidence bundle,
- artifacts and changed files,
- approvals and actions,
- resume composer.

### Action Approval Card

Required fields:

- action type,
- risk,
- target path/service,
- command or diff preview,
- policy reason,
- approval choices,
- linked run and tool call,
- expires at,
- result after execution.

### Evidence Panel

Required tabs:

- Summary,
- Events,
- Tools,
- Approvals,
- Artifacts,
- Memory,
- State transitions,
- Lineage.

The default view should be concise. Raw payloads should be expandable for debugging.

## Implementation Plan

### Slice 1: Execution Action Read Model

Status: implemented for approval-backed actions via `GET /execution-actions`; Web approval
cards render structured payload previews for common approval payloads, and action
read models expose durable preview/result artifact ids when the daemon can derive them.

Current coverage:

- approval id, run id, thread id, work-unit id, tool call id,
- action type, risk, waiting/decision status,
- deterministic target refs for run/task/channel/work unit/file/command/MCP/media/external
  action owners,
- effective policy snapshot from the linked run request,
- preview artifacts from approval payload paths,
- result artifacts derived from matching `artifact_created` events by `toolCallId`.

Still pending:

- non-approval action stages such as `proposed`, `executing`, `succeeded`, and `failed`,
- richer scope analysis.

- Build an action/evidence read model from existing approval requests, tool events,
  artifacts, and state transitions.
- Add action ids to approval payloads where needed.
- Keep existing approval APIs working.
- Show richer approval cards for `bash`, `edit`, and `write`.

### Slice 2: Action Preview Builders

Status: implemented for approval-backed runtime actions. Backend preview artifact
builders create durable metadata artifacts from approval paths, and result artifacts are
linked after execution when matching tool-call artifact events exist.

- Add preview builders for:
  - filesystem edit/write diff,
  - shell command risk,
  - git commit/push,
  - media cost,
  - provider/credential changes.
- Store preview artifacts before approval.
- Fail closed when preview cannot be generated for a high-risk action.

Current coverage:

- Existing approval payloads carry command, risk flags, file preview/diff preview, media
  cost prompts, workflow-step gate data, external action previews, and provider-change
  field names.
- Web approval cards render those payload fields before approval.
- `ExecutionAction.previewArtifactIds` and `ExecutionAction.resultArtifactIds` are shown
  in approval/run/thread evidence surfaces.

Still pending:

- Git commit/push-specific preview extraction from generic shell commands.
- Scope analysis beyond existing allowed-write-path policy decisions.

### Slice 3: LingThread

Status: implemented for task runs and continuation lineage.

Current coverage:

- `ling_threads` table and `run_sessions.thread_id`,
- `run_sessions.workflow_step_id` and `RunRequest.workflowStepId` for workflow-step
  run ownership,
- task thread create/reuse,
- workflow-step thread create/reuse keyed by `workflowStepId`,
- continuation thread inheritance from `parentRunId`,
- thread status sync for running, waiting for approval, succeeded, failed, and cancelled,
- stale run recovery marks linked active threads failed,
- `GET /threads`, `GET /threads/:id`, `GET /runs?threadId=...`, and
  `GET /runs?workflowStepId=...`.
- Web Run history lists durable threads and opens a thread-first detail mode with
  lineage, actions, queued follow-ups, state transitions, and resume preview.

Still pending:

- channel discussion and teammate-direct thread unification,
- optional dedicated route-level thread view outside the Runs surface.

- Add thread records and thread/run links.
- Auto-create or resolve a thread for task runs, channel proposal runs, workflow-step
  runs, and direct teammate work.
- Backfill read behavior for existing runs without rewriting old rows.

### Slice 4: Evidence Bundle

Status: implemented as a backend read model via `GET /threads/:id/evidence`; the Web Run
detail evidence panel consumes this bundle for thread runs, actions, artifacts, approvals,
runtime events, and state transitions.

- Add `GET /threads/:id/evidence`.
- Generate run/thread evidence from durable state.
- Add redaction checks and artifact sensitivity flags.
- Update Web Run Evidence panel to use the bundle.

### Slice 5: Queue Follow-Up

Status: implemented for run-level guidance and FIFO continuation.

- `POST /runs/:id/interventions` persists `queue_followup` interventions.
- Web Run detail displays queued guidance and lets the user cancel queued guidance.
- Terminal source runs trigger the next continuation through durable intervention rows.
- Continuation requests use bounded Ling-owned context and preserve lineage.

- Persist queued follow-up interventions.
- Display pending follow-ups on active thread/run.
- Start continuation run after source run reaches terminal state.
- Build bounded continuation context.

### Slice 6: Interrupt And Redirect

Status: implemented for run-level redirect continuations.

- `interrupt_redirect` interventions cancel the active run/work unit instead of injecting
  text into the active runner prompt.
- Partial evidence remains attached to the source run/thread.
- The continuation run records `parentRunId`, `interventionId`, and
  `continuationReason: "interrupt_redirect"`.
- Late runner success cannot overwrite a cancelled run through the run/work-unit state
  transition guards. A dedicated `stale_runner_completion_ignored` diagnostic event is
  persisted when stale runner completion is ignored.

- Persist redirect interventions.
- Cancel active run/work unit.
- Preserve partial evidence.
- Start continuation run with lineage.
- Add stale completion ignored event.

### Slice 7: Resume UX

Status: implemented in Run history/detail. Backend manual resume is implemented via
`POST /threads/:id/resume`, the Web Run history surface lists durable Ling threads, and
selecting a thread opens a thread-first detail panel with source-run selection, context
preview, and a linked `manual_resume` continuation action.

- Add thread resume composer.
- Add manual `Resume` action for terminal or blocked threads.
- Show source run, continuation reason, and context preview before starting.

Current coverage:

- The left Run history rail lists durable Ling threads with status, kind, objective, and
  active/last run linkage.
- Selecting a thread opens thread detail rather than forcing the user to hunt through
  isolated run attempts.
- Active non-terminal threads keep preview available but disable resume start; terminal
  threads can preview and start a continuation from an explicit source run.

Optional later polish:

- A dedicated route that renders a thread outside the Runs surface.

### Slice 8: Optional Native Resume

- Extend RunnerRegistry capabilities with native resume metadata.
- Add adapter tests for resume handle lifecycle.
- Keep explicit Ling resume context as fallback.

## Future Slices

These slices are deliberately after the current hardening work. They improve fidelity,
but they are not required for the implemented Codex-like thread/action/resume baseline.

### Slice 9: Non-Approval Action Lifecycle

Current state:

- `ExecutionAction` is an approval-backed read model.
- Approval-backed actions can expose waiting/approved/denied/expired/cancelled state.
- Preview and result artifacts are available when approval/tool metadata can derive
  them.

Future goal:

- represent non-approval actions with the same action model;
- show `proposed`, `executing`, `succeeded`, and `failed` states even when no human
  approval was required;
- keep action identity stable across run events, runtime events, and artifacts.

Implementation shape:

```ts
interface ExecutionActionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly runId?: string;
  readonly workUnitId?: string;
  readonly toolCallId?: string;
  readonly actionType: ExecutionActionType;
  readonly status: ExecutionActionStatus;
  readonly targetRefs: readonly ExecutionActionTargetRef[];
  readonly previewArtifactIds: readonly string[];
  readonly resultArtifactIds: readonly string[];
}
```

Start as a hybrid:

1. continue deriving approval-backed actions from approval rows;
2. derive non-approval actions from tool events and runtime events;
3. add a durable table only when derived identity is not stable enough.

Tests:

- read-only bash action appears as `executing` then `succeeded`;
- failed tool call appears as `failed` with result artifact/error metadata;
- non-approval action does not create an approval request;
- action ids remain stable after daemon restart.

### Slice 10: Git Commit/Push Preview Extraction

Current state:

- generic shell command approvals can show command text and existing risk metadata;
- result artifacts can be linked after execution when tool artifacts are emitted.

Future goal:

- detect `git commit`, `git push`, branch update, tag, and release-like commands before
  approval;
- create deterministic preview artifacts with exact refs and diff summary;
- fail closed for high-risk git actions when preview cannot be generated.

Preview builders:

```text
git commit
  -> current branch
  -> staged file list
  -> staged diff stat
  -> commit message

git push
  -> local branch
  -> remote branch
  -> ahead/behind count
  -> commits to be pushed
  -> protected branch warning
```

Rules:

- use `git` plumbing where possible;
- do not parse shell strings as the only source of truth when command arguments are
  ambiguous;
- if the command is compound, classify the git sub-action and include the raw command;
- never approve a push by comparing strings alone. Resolve refs.

Tests:

- staged commit preview includes staged paths and diff stat;
- push preview includes remote, branch, and commit list;
- force push is critical risk;
- ambiguous shell command produces a fail-closed preview error.

### Slice 11: Scope Analysis

Current state:

- write safety mostly relies on allowed write paths, approval policy, and action payload
  facts.

Future goal:

- classify the blast radius of an action before execution;
- surface scope in approval cards, Run evidence, and thread evidence.

Scope dimensions:

```ts
type ExecutionScope =
  | "read_only"
  | "workspace_write"
  | "git_history"
  | "network"
  | "credential"
  | "provider_config"
  | "deployment"
  | "external_system";
```

Implementation:

- deterministic local classifier first;
- model-assisted classifier only as an advisory note behind deterministic facts;
- scope score is additive to approval risk, not a replacement for policy;
- scope facts become preview artifacts for high-risk actions.

Tests:

- file write outside allowed paths is critical and denied;
- credential/provider mutations classify correctly;
- deploy-like command classifies as deployment/external system;
- classifier never lowers explicit policy risk.

### Slice 12: Thread Unification And Route Page

Current state:

- task runs, workflow-step runs, and continuations use durable `LingThread`;
- Run History provides the thread-first detail surface;
- channel discussion and teammate-direct thread unification remains incomplete.

Future goal:

- make channel discussion and teammate-direct work first-class `LingThread` owners;
- use the same evidence bundle and resume preview everywhere.

Implementation:

- create/reuse `LingThread(kind="channel_discussion")` for channel AI replies;
- create/reuse `LingThread(kind="teammate_direct")` for private teammate messages;
- link generated reply runs/work units to the thread id;
- add a top-level `threads` Web view that uses `/threads` and `/threads/:id/evidence`
  and renders the same evidence detail component as Run History. Status: implemented.

Tests:

- channel AI reply creates or reuses a channel discussion thread;
- teammate direct reply creates or reuses a teammate direct thread;
- evidence bundle includes messages, runs, actions, artifacts, and state transitions;
- resume preview works for terminal discussion/direct threads;
- route-level page renders the same evidence as Run History detail.

## Test Plan

Core/store:

- Thread CRUD and run linking.
- Action read model from approval/tool/artifact data.
- Evidence bundle regeneration from durable state.
- Run lineage and intervention records.
- Stale completion state-machine rejection.
- Secret redaction in action previews and evidence bundles.

Daemon:

- Approval request creates action preview before side effect.
- Denied action blocks tool execution.
- Approved action resumes and records result.
- `GET /threads/:id/evidence` regenerates run events, approvals, artifacts, runtime
  events, actions, and state transitions from durable state.
- `POST /threads/:id/resume` starts a linked `manual_resume` continuation with the same
  `LingThread` and a parent run id.
- Queue follow-up creates continuation after terminal source run.
- Interrupt redirect cancels active run and starts linked continuation.
- Continuation re-resolves provider, tools, approval policy, memory, and leases.
- Browser/SSE disconnect does not cancel thread or run.
- Daemon restart reconciles active threads and pending interventions.

Runner:

- Pi `bash`, `edit`, and `write` approvals still intercept before execution.
- MCP tools obey default approval policy.
- Abort does not allow stale success to overwrite terminal state.
- Native resume support, if added, passes the same conformance tests.

Web:

- Approval card shows command/diff preview and action payload facts.
- Evidence panel can replay run and thread facts.
- Follow-up can be queued while a run is active.
- Stop-and-redirect creates a continuation run.
- Thread resume composer starts a linked continuation.
- Secret values are not visible in UI, logs, or artifacts.

Regression:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm typecheck
git diff --check
```

## Relationship To Existing Designs

- [Approval Policy](approval-policy.md) defines the approval policy and request
  foundation. This document extends it into an action ledger and evidence UI.
- [Session Persistence](session-persistence.md) defines durable runs and events. This
  document extends it into long-lived threads and evidence bundles.
- [Run Interruption And Continuation](run-interruption-continuation.md) defines the
  follow-up and redirect model. This document places it inside the complete execution
  experience.
- [Runtime Supervisor](runtime-supervisor.md) remains the owner of active work, leases,
  stale detection, cancellation, and recovery.
- [Runner Registry](runner-registry.md) owns runner selection. This design does not
  require a second runner backend.
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md) can create workflow-step runs
  that attach to threads and use the same approval/evidence/continuation machinery.

## Open Questions

- Should approval decisions support "approve all similar actions for this run" in v1, or
  stay approve-once only?
- Should command risk classification be purely local pattern matching, or should it also
  support model-assisted review behind a separate approval boundary?
- Should native runner resume wait for Codex app-server support, or should Pi adapter
  expose any available session handle first?

Resolved defaults:

- Start with `ExecutionAction` as a read model.
- Add `LingThread` as grouping and lineage first, not a UI replacement.

Recommended defaults for remaining questions:

- Keep approve-once only until the audit UI is mature.
- Use local deterministic command classification first.
- Do not block LingThread/resume on native runner resume.
