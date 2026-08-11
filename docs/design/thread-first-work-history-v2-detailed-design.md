# Thread-First Work History V2 Detailed Design

Status: detailed design
Date: 2026-06-08
Scope: conversation work cells, durable turns, thread metadata, process disclosure,
evidence layering, Work History integration, and V2 implementation slices

IA update, 2026-06-09: customer-facing navigation and surface placement are superseded
by [Work History IA Cleanup](work-history-ia-cleanup.md). The durable V2 models and APIs
remain valid, but future UI work should not treat Work History as the customer-primary
global work surface.

Continuity update, 2026-08-06: [Channel Conversation Continuity v2](channel-conversation-continuity-v2.md)
supersedes the earlier boundary that created `LingTurn` only for executable work and kept
ordinary conversation exclusively in `channel_messages`. The durable model is now
`LingThread -> LingTurn -> ConversationItem`; runs and evidence are referenced domain
records inside a turn. Work History remains the denser audit and recovery projection.

## Purpose

V1 renamed and reframed the Runs surface into a thread-first Work History shell. V2
should make the same work history visible inside the conversation timeline while keeping
Work History as the global audit and recovery surface.

The target user experience is:

```text
Conversation timeline
  -> active turn
    -> live item stream
      -> tool / edit / test / approval / browser evidence summaries
  -> completed turn
    -> collapsed result summary
      -> expandable grouped items
        -> raw logs, events, artifacts, snapshots
```

While work is running, the conversation should show a sparse, auditable stream of action
items. When work completes, Ling should keep those actions in the transcript as committed
folded cells instead of deleting or replacing them with a one-line summary. Expanding a
completed cell should show how Ling got there. Raw diagnostics stay behind explicit
drill-down.

## Related Docs

- [Channel Conversation Continuity v2](channel-conversation-continuity-v2.md)
- [Thread-First Work History](thread-first-work-history.md)
- [Thread-First Work History Implementation Plan](thread-first-work-history-implementation-plan.md)
- [Conversation Surface Contract](./conversation-surface-contract.md)
- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)
- [Contracts and API Client](contracts-api-client.md)
- [Run Interruption And Continuation](run-interruption-continuation.md)
- [Work Board, Review Queue, and Inline Approval Boundaries](work-board-review-queue.md)

## Codex Reference Boundary

References checked on 2026-06-08:

- [OpenAI: Unlocking the Codex Harness](https://openai.com/index/unlocking-the-codex-harness/)
- [OpenAI Codex Threads API](https://www.mintlify.com/openai/codex/api/threads)
- [OpenAI Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

Codex's useful reference model is:

```text
Thread
  -> Turn
    -> Item
```

OpenAI's App Server write-up describes:

- item as the atomic input/output unit, including user messages, agent messages, tool
  execution, approval requests, and diffs;
- turn as one unit of agent work initiated by user input;
- thread as the durable ongoing session that can be created, resumed, forked, and
  archived.

The Codex App Server API docs also expose thread lifecycle and turn lifecycle concepts.
Codex threads are conversations with multiple turns, and turns emit updates such as
started, completed, diff updates, plan updates, reroutes, and errors.

Ling should borrow the information architecture and lifecycle boundaries, not wholesale
replace the Ling daemon with Codex app-server JSON-RPC.

Ling's mapped model is:

```text
LingThread
  -> LingTurn
    -> ConversationItem
      -> message / tool / approval / handoff / operation / artifact ref

LingTurn
  -> zero or more RunSession attempts
  -> existing workflow / approval / artifact / evidence authority
```

That durable model is not the same object as the user-visible conversation transcript.
The conversation UI should project the durable/runtime records into a separate semantic
read model:

```text
LingThread / channel messages / runs / approvals / artifacts
  -> ConversationTranscript
    -> ConversationTranscriptTurn
      -> TranscriptBlock[]
```

`LingTurn` is the durable work-intent boundary. `ConversationTranscriptTurn` is the
renderable user-turn container. `TranscriptBlock` is the display unit that can represent
coordinator prose, an operation cell, an agent activity span, approval state, artifact
strip, or raw-detail reference. This distinction matters because a user turn can contain
ordinary coordinator conversation without creating extra work records, while a work turn
can render many operation blocks without creating many chat messages.

### Phase 1 Implementation Boundary

The first implementation phase for the conversation UI is the transcript message
framework only:

```text
existing channel/runtime records
  -> ConversationTranscriptTurn
     -> TranscriptBlock[]
        coordinator_text
        operation_cell
        agent_activity_span
        coordinator_text
        artifact_strip
```

Phase 1 must prove that:

- one executable user task normally renders as one assistant transcript turn;
- start text, operation cells, agent spans, terminal text, and artifacts are blocks inside
  that turn;
- active operation blocks mutate in place;
- terminal operation blocks commit as folded history, not deleted process rows;
- multi-agent process rows remain folded under `AgentActivitySpan`;
- coordinator copy is never parsed by fixed phrases such as `确认需求` or `完成`.

Right floating popover, right drawer, and source-summary affordances are later surfaces.
They consume `ConversationTranscriptTurn`; they do not define or repair it.

## V2 Product Goals

- Show active work inside channel/private conversation as sparse live item rows.
- Commit completed operation rows as folded transcript history under the same user turn.
- Let users expand completed operation rows to audit grouped items without reading raw event
  streams.
- Anchor resume, fork, archive, search, and Review Queue links to a stable turn boundary.
- Keep Work History as the global index across channels, teammates, automations,
  workflows, and external work.
- Preserve direct run detail for operator and legacy links.
- Avoid storing hidden reasoning or raw secrets in durable turns.

## V2 Non-Goals

- Do not replace Ling's current run APIs.
- Do not wholesale copy Codex app-server JSON-RPC.
- Do not make thread metadata a safety authority.
- Do not rewrite existing run records.
- Do not make Review Queue a history page.
- Do not show raw logs, JSONL, stdout, or model/tool event spam as default conversation
  content.
- Do not display hidden model reasoning. V2 displays auditable actions and evidence, not
  private chain-of-thought.
- Do not force coordinator messages into fixed copy templates such as `确认需求`, `完成`,
  `执行`, or `结论`. Those phrases can appear naturally, but structure must come from
  metadata and block kinds.

## User-Facing Information Architecture

### Conversation Default

The conversation feed should default to ordinary messages plus transcript blocks that
belong to the same user turn:

```text
User message
ConversationTranscriptTurn
  -> coordinator text
  -> active or committed operation cells
  -> agent activity spans when collaboration is involved
  -> terminal coordinator text and artifact strip
User follow-up
```

Active turns answer what Ling is doing now without exposing hidden reasoning:

- which auditable action is currently running;
- whether Ling is waiting for approval or user input;
- which tool, file, command, test, browser check, or external work item is involved;
- whether the action succeeded, failed, was cancelled, or is still running.

Terminal coordinator text and artifact strips answer:

- What did the user ask for?
- What was completed or blocked?
- What changed?
- What was verified?
- What requires attention?
- How can the user continue, fork, or inspect evidence?

### Work History Default

Work History remains the global view:

```text
Work History
  -> Work thread rail
    -> Work detail
      -> Turn timeline
        -> Attempts
          -> Evidence
            -> Raw diagnostics
```

The conversation work cell and Work History detail must read from the same
thread/turn/run data. They should differ by density, not by source of truth.

## Conversation Work Cell

### Active Turn Stream

While a turn is active, V2C should render Codex-inspired item rows inline in the
conversation. These rows are semantic presentation of auditable actions, not durable
reasoning and not raw event rows:

```text
Ling is working...
  reading docs/design/thread-first-work-history-v2-detailed-design.md
  searching RunHistory / AppShell / i18n
  editing RunHistory.tsx
  running bun run typecheck
  waiting for approval: browser smoke
```

Rules:

- show action, target, status, and short evidence count only;
- group noisy repeated actions when possible;
- keep long stdout/stderr, JSONL, provider payloads, and screenshots behind explicit
  drill-down;
- never render hidden model reasoning or private chain-of-thought;
- render approval decisions in the composer-adjacent temporary approval overlay, not as
  a normal transcript row with inline buttons;
- when the turn completes, mutate the same active row to a terminal committed row and
  fold it by default; do not delete it and do not replace it with only a coordinator
  summary.

### Composer Approval Overlay

Conversation approvals should match the Codex interaction pattern: a temporary floating
approval surface appears above the conversation composer while the turn is blocked on a
human decision.

```text
Conversation transcript
  -> active turn item: waiting for approval

Composer area
  -> temporary approval overlay
    -> action summary
    -> scope/risk copy
    -> deny / approve / details controls
  -> normal input composer
```

Rules:

- do not place the approval decision controls inside the historical transcript;
- do not make the approval overlay a durable message;
- keep the overlay visible until the user decides, the request expires, or the run is
  cancelled;
- after a decision, record an evidence item that links the request, decision, approver,
  scope, and timestamps;
- if the request is denied or expires, the active turn stream may show a compact blocked
  item and the completed summary should carry an attention state.

The same underlying `ApprovalRequest` can still appear in Review Queue, but Review Queue
is an action queue. It may render an inline approval card because the page itself is
dedicated to human actions. The conversation feed should prefer the composer-adjacent
overlay.

#### P0 Composer Overlay Detail

The first composer overlay slice is a Web composition change over existing approval
state. It must not introduce a new approval table, a new approval policy model, or a new
runner-side authority path.

Inputs:

- loaded `ApprovalRequest` records;
- active channel id and visible run ids;
- active conversation thread id when available;
- existing approve/deny mutation callbacks;
- existing run status refresh after mutation.

Eligibility should mirror the inline runtime approval design:

- include pending local runtime approvals for the active run, visible run, or active
  channel;
- include `runtime_permission_request`, `bash`, `edit`, `write`, local run-owned MCP
  tool approvals, and active workflow-step gates;
- exclude external work actions, legacy media approvals, provider changes, credential
  changes, and approvals whose owning run is no longer visible;
- when in doubt, leave the approval in Review Queue and show only a compact attention
  link in the conversation.

Placement and density:

```text
conversation feed
  -> active work cell says "waiting for approval"
composer area
  -> composer approval overlay
  -> normal text composer
```

The overlay is temporary UI state. It is not a message and should not be serialized as a
transcript item. The transcript work cell may show the waiting state, but it must not
embed approve/deny buttons.

Single pending approval:

- show action title;
- show risk;
- show owner context: run, task, channel, or workflow step;
- show bounded scope summary;
- show `Approve`, `Deny`, and `Details`.

Multiple pending approvals:

- show count and highest risk;
- surface the first blocking approval;
- provide a detail disclosure sorted by risk, then creation time;
- do not implement `Approve all` in P0.

Mutation rules:

```text
approve/deny clicked
-> disable overlay controls for that approval id
-> call existing approval resolve endpoint
-> refresh approvals and relevant run/thread state
-> remove resolved/non-pending approvals from overlay
-> leave resolved decision as evidence in run/work detail, not as a persistent composer row
```

If the approval expires, is cancelled, or is resolved from Review Queue while the overlay
is visible, the overlay should disappear after refresh. If the owning run still reports
`waiting_for_approval`, the work cell should keep an attention state and route the user
to Work History or Review Queue for recovery instead of silently pretending the run is
healthy.

The overlay must tolerate stale SSE and selection changes:

- ignore mutation responses for a previous `cwd`, channel, thread, or run selection;
- dedupe pending approvals by approval id;
- keep resolving state per approval id;
- remove the overlay when the user switches to a conversation where the approval is not
  eligible;
- keep Review Queue as the fallback place to find unresolved approvals.

P0 implementation can reuse `apps/web/src/lib/inline-approvals.ts` for eligibility and
summary text. If the helper is not sufficient for thread context, extend the helper
conservatively rather than duplicating approval filtering in the conversation component.

### Completed Summary

Completed work cells should be compact and result-first. They should read like a natural
assistant completion with a lightweight work summary row, not like a dashboard card.

```text
Done. Work History now defaults to work threads and keeps legacy run detail reachable.

✓ Work History V1 shell · 7 files · 4 checks · 23m
[Details] [Continue] [Fork]
```

The completed summary should not show the full process by default. It should show:

- result sentence;
- status and duration;
- changed-file count;
- verification count;
- attention state when blocked/failed/waiting;
- `Details`, `Continue`, and `Fork` affordances when available.

### Expanded Details

Expanded work cells should hydrate grouped items from the completed turn. Prefer three or
four high-signal groups over a long timeline:

```text
Changed
  -> RunHistory.tsx, AppShell.tsx, view-types.ts
Checked
  -> typecheck, lint, E2E, Browser smoke
Evidence
  -> diff summary, command summaries, browser proof
```

Grouped item rows should show:

- status;
- short title;
- timestamp or relative order;
- source attempt id when useful;
- evidence count;
- expandable detail.

Avoid making the expanded state look like Work History or a log page. Work History owns
the richer audit layout; the conversation cell owns lightweight continuity.

### Evidence Layer

Evidence is one click deeper than process:

| Evidence type | Default summary | Detail |
| --- | --- | --- |
| command | command, exit code, short result | stdout/stderr excerpt, full artifact if captured |
| file edit | file count, paths, additions/deletions | diff, patch artifact |
| approval | action, risk, decision | payload, reason, approver, timestamps |
| browser smoke | URL, viewport, console status | screenshot, DOM assertion, console logs |
| e2e/test | command, pass/fail count | failure context, trace/screenshot link |
| artifact | title/type/count | artifact preview/download |
| run attempt | status, provider, runtime | run detail and raw event timeline |

### Lazy Evidence Hydration

Conversation work cells should not fetch full thread evidence just to render the default
conversation feed. Evidence is loaded only when the user asks for detail.

Default render:

- build the collapsed summary from already loaded runs, artifacts, approvals, and
  execution actions when present;
- show bounded counts and existing drill-down links;
- if the evidence bundle is not loaded, show no speculative detail rows;
- never fetch raw events, JSONL, provider payloads, or stdout for collapsed cells.

Expand flow:

```text
user expands completed work cell
-> if evidence bundle is already available, render grouped rows immediately
-> otherwise call existing thread evidence endpoint
-> render loading state inside the disclosure
-> map evidence into Changed / Checked / Evidence / Attention groups
-> keep raw diagnostics behind explicit deeper links
```

The first slice should use the existing endpoint:

```text
GET /threads/:threadId/evidence?cwd=...
```

When durable turns exist, the same endpoint may accept `turnId`, but P0 must not require
that contract.

Client cache rules:

- cache by `cwd + threadId` and optionally `turnId` when available;
- dedupe concurrent requests for the same key;
- treat the cache as disposable and rebuildable;
- invalidate or refresh after run completion, approval resolution, artifact creation, or
  explicit user refresh;
- never use the cache as run recovery source or approval authority.

UI states:

| State | Behavior |
| --- | --- |
| Not loaded | Disclosure shows grouped placeholders or a compact "Load details" action. |
| Loading | Keep the collapsed summary stable and show a small progress row inside details. |
| Empty | Show "No evidence captured yet" without hiding attempt links. |
| Error | Keep summary visible and show retry plus `Open run` fallback. |
| Loaded | Render grouped rows with evidence links and bounded summaries. |

Privacy and safety:

- show redacted summaries only;
- do not render hidden reasoning;
- do not show raw stdout/stderr by default;
- do not expose provider request snapshots in the conversation cell;
- use existing artifact preview/download controls for rich evidence.

### Raw Diagnostics

Raw diagnostics are hidden behind explicit actions:

- event JSON;
- JSONL path;
- full stdout/stderr;
- request/provider snapshots;
- shell snapshot raw payloads.

These are operator evidence. They should never be the default page body or default
conversation content.

## Durable Data Model

### V2A: `LingTurn`

`LingTurn` is the durable user-intent boundary inside a `LingThread`.

It is not a chat message table. It records ordinary and executable intent, lineage, and
terminal outcome. Ordered observable content belongs to `ConversationItem`.

```ts
type LingTurnKind =
  | "initial_request"
  | "manual_followup"
  | "queued_followup"
  | "interrupt_redirect"
  | "workflow_step"
  | "external_work_update"
  | "automation_tick"
  | "review_queue_action";

type LingTurnStatus =
  | "open"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "superseded";

interface LingTurn {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly kind: LingTurnKind;
  readonly status: LingTurnStatus;
  readonly title: string;
  readonly userInstruction: string;
  readonly normalizedObjective?: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly teammateId?: string;
  readonly workflowStepId?: string;
  readonly externalWorkId?: string;
  readonly automationId?: string;
  readonly sourceItemId?: string;
  readonly sourceTurnId?: string;
  readonly interventionId?: string;
  readonly activeRunId?: string;
  readonly lastRunId?: string;
  readonly summaryArtifactId?: string;
  readonly evidenceBundleArtifactId?: string;
  readonly createdByActor: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}
```

Do not put `runIds` directly on the turn row in SQL. Use a join table:

```ts
interface LingTurnRun {
  readonly turnId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly role: "primary" | "retry" | "resume" | "repair" | "validation";
  readonly createdAt: string;
}
```

### SQL Shape

```sql
CREATE TABLE ling_turns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  user_instruction TEXT NOT NULL,
  normalized_objective TEXT,
  channel_id TEXT,
  task_id TEXT,
  teammate_id TEXT,
  workflow_step_id TEXT,
  external_work_id TEXT,
  automation_id TEXT,
  source_item_id TEXT,
  source_turn_id TEXT,
  intervention_id TEXT,
  active_run_id TEXT,
  last_run_id TEXT,
  summary_artifact_id TEXT,
  evidence_bundle_artifact_id TEXT,
  created_by_actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX ling_turns_thread_updated_idx
  ON ling_turns(thread_id, updated_at DESC);

CREATE INDEX ling_turns_workspace_status_idx
  ON ling_turns(workspace_id, status, updated_at DESC);

CREATE TABLE ling_turn_runs (
  turn_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(turn_id, run_id)
);

CREATE INDEX ling_turn_runs_run_idx
  ON ling_turn_runs(run_id);
```

### Creation Rules

Create a turn for every accepted local-user input before selector or reply routing.
Also create turns for independent system-originated work lifecycles:

- ordinary channel or direct conversation input;
- workspace task run starts;
- channel input creates executable work;
- manual follow-up or queued follow-up is accepted;
- run redirect/interruption is recorded;
- workflow step starts;
- automation tick starts real work;
- external work update is routed into Ling work.

An ordinary reply turn can complete without a run. Executable work links the same turn to
one or more run attempts through `ling_turn_runs`. This keeps conversation continuity,
segmentation, summary coverage, resume, and multi-agent recovery on one durable turn
boundary.

Do not infer this boundary by matching assistant copy. A message that says `确认需求` is not
automatically executable work, and a message that omits `完成` can still be terminal. Turn
creation comes from accepted input or an explicit system lifecycle; execution and terminal
state come from intent, target resolution, runtime state, and explicit metadata.

### Status Reconciliation

Turn status is derived from linked runs and explicit interventions:

```text
active run queued/running -> running
any linked run waiting_for_approval -> waiting_for_approval
latest terminal run succeeded -> succeeded
latest terminal run failed and no queued continuation -> failed
ordinary reply committed with no run -> succeeded
active redirect accepted -> cancelled or superseded, then child turn running
manual follow-up queued -> open or running depending on continuation state
```

Status reconciliation must be explicit. Stale metadata should not change approval or
runtime authority.

## Thread Metadata Read Model

### V2B Metadata

Thread metadata is a rebuildable read model for lists and conversation summaries.

```ts
interface LingThreadMetadata {
  readonly threadId: string;
  readonly summary?: string;
  readonly pinnedAt?: string;
  readonly archivedAt?: string;
  readonly archivedReason?: string;
  readonly lastTurnId?: string;
  readonly lastActivityAt: string;
  readonly turnCount: number;
  readonly attemptCount: number;
  readonly pendingApprovalCount: number;
  readonly blockedCount: number;
  readonly failedAttemptCount: number;
  readonly artifactCount: number;
  readonly unreadAttentionCount?: number;
  readonly latestEvidenceArtifactId?: string;
  readonly latestFailureRunId?: string;
}
```

Storage options:

1. `ling_threads.metadata_json` for the first slice.
2. Explicit columns for query-critical fields after usage stabilizes.
3. A rebuild command and startup reconcile path.

Metadata is not safety authority. Approvals, run state, resource leases, and state
transitions remain authoritative.

## Turn Item Read Model

V2 does not need a durable `LingTurnStep` table first.

Build active stream rows and completed grouped item rows from existing evidence:

| Source | Derived row |
| --- | --- |
| run lifecycle | attempt started/completed |
| tool events | command/tool operation |
| execution actions | approved/applied action |
| artifacts | generated file, patch, screenshot, report |
| approvals | permission decision |
| run interventions | follow-up, redirect, continuation |
| browser/e2e artifacts | validation step |
| state transitions | status change |

If derived item rows become slow or inconsistent, introduce a rebuildable
`ling_turn_process_items` cache later. Do not make it authoritative in V2A.

## Conversation Transcript Read Model

The turn item read model feeds two different products:

- Conversation transcript: sparse, user-facing, Codex-like display/expanded/raw layers.
- Work History detail: denser audit and recovery view over the same turn/run/evidence
  records.

Do not make the Web component tree the permanent owner of this grouping. The stable shape
should be a shared `ConversationTranscript` contract owned by daemon/core projection and
defined in `packages/contracts`.

```text
raw runtime/channel records
  -> semantic projector
  -> ConversationTranscript
    -> ConversationTranscriptTurn
      -> TranscriptBlock
        -> display surface
        -> expanded surface
        -> raw/detail reference
```

Projection rules:

- one user turn should normally produce one `ConversationTranscriptTurn` in the main feed;
- coordinator start text, operation cells, agent spans, terminal text, and artifacts are
  blocks inside that same turn, not separate `Ling Agent` replies;
- `OperationCell` blocks use stable ids, mutate while active, and commit in place when
  terminal;
- command output chunks, file diffs, browser snapshots, and raw JSON events update
  evidence on an existing block or detail ref instead of creating default-feed spam;
- multi-agent work uses `AgentActivitySpan` blocks that show the latest action by default
  and keep prior semantic operations folded under the span;
- raw/detail fields are referenced from blocks and rendered only in expanded/raw surfaces,
  not duplicated in the main transcript or right drawer root.

`LingTurn` and `ConversationTranscriptTurn` are now one-to-one at the user-intent
boundary, while transcript blocks remain a derived presentation model:

| Concept | Owner | Purpose | Example |
| --- | --- | --- | --- |
| `LingTurn` | daemon durable conversation store | ordinary or executable intent, lineage, context assignment, terminal outcome | user question, task run, queued follow-up, interrupt redirect |
| `ConversationTranscriptTurn` | shared transcript projection | user-visible projection of the durable turn | user request plus coordinator prose, operation cells, agent spans, terminal summary |
| `TranscriptBlock` | shared transcript projection | renderable semantic unit with lifecycle | operation cell, agent activity span, approval state, artifact strip |

This boundary prevents three common failures:

1. leaving normal chat outside durable recovery and context assignment;
2. splitting one user task into multiple `Ling Agent` replies because start text and
   terminal text were stored as unrelated messages;
3. deleting completed process rows because the final coordinator summary is treated as a
   replacement for the active stream.

## API Design

### Additive V2 APIs

```text
GET /threads?cwd=...&includeMetadata=true
GET /threads/:threadId?cwd=...&includeMetadata=true
GET /threads/:threadId/turns?cwd=...
POST /threads/:threadId/turns?cwd=...
GET /threads/:threadId/evidence?cwd=...&turnId=...
GET /threads/:threadId/process?cwd=...&turnId=...
GET /channels/:channelId/transcript?cwd=...
GET /threads/:threadId/transcript?cwd=...
POST /threads/:threadId/resume-preview?cwd=...&turnId=...
POST /threads/:threadId/resume?cwd=...&turnId=...
POST /threads/:threadId/fork?cwd=...
POST /threads/:threadId/fork-run?cwd=...
POST /threads/:threadId/archive?cwd=...
POST /threads/:threadId/pin?cwd=...
GET /threads?cwd=...&q=...
```

The transcript endpoints are read-model endpoints. They should return
`ConversationTranscript` snapshots and, later, sequence-aware delta streams. They should
not expose raw run events as the default response shape.

### Preserve Existing APIs

Keep these unchanged:

```text
GET /runs
GET /runs/:id
GET /runs/:id/events
GET /runs/:id/artifacts
GET /threads/:threadId/evidence
```

Direct run detail is still needed for old links, Work Board, Review Queue, automation
records, and operator diagnostics.

### Request Boundaries

`resume-preview` remains side-effect free.

`resume` may create a new turn when `turnId` points to a completed turn:

```text
source turn -> child follow-up turn -> new run attempt
```

`fork` creates a new work thread branch with parent lineage. By default the child
`LingThread` stays under the same `channelId` as the source thread or turn. It should not
create a new channel, copy channel membership/settings, or copy raw logs unless it links
to source evidence artifacts.

```text
Channel
  -> source LingThread
    -> source turn
      -> fork
        -> child LingThread
           channelId = source.channelId
           parentThreadId = source.threadId
           parentTurnId = source.turnId
```

Fork does not archive the source branch. Archive remains an explicit action.

`archive` hides from default lists and preserves all evidence.

`pin` and `search` use metadata/read models only.

### V2D-A Turn-Linked Resume Details

V2D starts with turn-linked resume, not fork/archive/pin/search. The first slice extends
the existing thread resume route so a resume can be anchored to a durable `LingTurn`
without breaking current run-based clients.

#### Request Shape

Keep `sourceRunId` as the backward-compatible anchor and add optional `turnId`:

```ts
interface LingThreadResumeRequest {
  readonly instruction?: string;
  readonly idempotencyKey?: string;
  readonly sourceRunId?: string;
  readonly turnId?: string;
  readonly includeArtifacts?: boolean;
}
```

Resolution order:

1. If `turnId` is absent, keep the current behavior: `sourceRunId`, then
   `thread.lastRunId`.
2. If `turnId` is present and `sourceRunId` is absent, resolve the source run from
   `turn.lastRunId`, then from the latest linked `LingTurnRun`.
3. If both are present, validate that the source run is linked to the selected turn.
4. Reject any selected turn or source run that does not belong to the requested thread.

This keeps old UI, automation, and tests stable while allowing Work History to resume
from a selected turn.

#### Resume Anchor Resolver

Add a deterministic resolver before context generation:

```ts
interface ThreadResumeAnchor {
  readonly thread: LingThread;
  readonly sourceTurn?: LingTurn;
  readonly sourceRun: RunSession;
  readonly warnings: readonly string[];
}
```

Resolver rules:

- read `ling_turns`, `ling_turn_runs`, and `runs` as the authoritative source;
- do not read `LingThreadMetadata` to choose a source turn or run;
- validate `threadId`, `turnId`, and `sourceRunId` in one place;
- preserve the existing provider snapshot checks on the chosen source run;
- allow preview for active threads/turns with warnings;
- block execute for active non-terminal threads or active selected turns.

#### Preview Context

Extend preview context additively:

```ts
interface ResumeContextPreview {
  readonly sourceRunId: string;
  readonly sourceTurnId?: string;
  readonly priorRunIds: readonly string[];
  readonly priorTurnIds?: readonly string[];
  readonly includedTurnCount?: number;
}
```

Preview remains side-effect free. When `sourceTurnId` is present, the preview should
summarize context through that turn boundary rather than silently using every run in the
thread. Existing event, approval, artifact id, pending-action, redaction, and warning
fields stay unchanged.

#### Execute Semantics

Executing from a selected turn creates a continuation inside the same thread:

```text
source LingTurn
  -> selected source run
    -> manual_resume run
      -> child LingTurn
         sourceTurnId = source LingTurn
         LingTurnRun.role = "resume"
```

Rules:

- do not create a child `LingThread`;
- do not archive, pin, or hide the source thread;
- keep `channelId` from the source thread/turn;
- set `continuationReason = "manual_resume"` on the new run;
- link the resumed run as `role = "resume"`;
- refresh thread status and metadata after the run is created.

If the existing orchestration infers the child turn from `parentRunId`, this slice may
reuse that code path. Tests still need to prove the resulting child turn points back to
the selected source turn.

#### Work History UI

The first UI surface is Work History / thread detail. Conversation transcript work cells
stay result-first and do not gain permanent resume buttons in V2D-A.

Thread detail source selection:

```text
Resume source
  Latest completed turn
  Selected turn
  Source run fallback
```

Rules:

- prefer the latest completed turn when durable turns are loaded;
- preselect a turn when navigation arrives from a work cell or turn detail anchor;
- fall back to the existing source-run selector for legacy run-only threads;
- preview shows source turn, source run, prior turn count, prior run count, event count,
  approvals, artifact ids, pending actions, and warnings;
- execute is disabled when preview reports an active selected turn or active thread;
- after execute, refresh turns, run evidence, and metadata before rendering the result.

#### Validation Errors

Use stable machine-readable errors so Web and tests do not depend on prose:

- `turn_not_found`
- `turn_not_in_thread`
- `source_run_not_found`
- `source_run_not_in_thread`
- `source_run_not_in_turn`
- `thread_active`
- `turn_active`
- `resume_snapshot_unavailable`

User-facing copy should describe the action boundary: for example, `This turn is still
running. Use the active run controls or wait for it to finish before resuming from it.`

### V2D-B Fork Lineage Details

V2D-B adds fork as durable thread lineage. It does not clone a transcript and does not
replace message-level topic replies.

#### Contract Shape

Add lineage fields to `LingThread`:

```ts
interface LingThread {
  readonly parentThreadId?: string;
  readonly parentTurnId?: string;
  readonly forkedFromRunId?: string;
}
```

`parentThreadId` is the branch authority. `parentTurnId` and `forkedFromRunId` are
anchors for user explanation and evidence drill-down. `LingThreadMetadata` may cache
derived child counts later, but lineage must be read from `ling_threads`.

Add a fork route:

```text
POST /threads/:threadId/fork?cwd=...
```

Request:

```ts
interface LingThreadForkRequest {
  readonly turnId?: string;
  readonly sourceRunId?: string;
  readonly title?: string;
  readonly objective?: string;
  readonly idempotencyKey?: string;
}
```

Response:

```ts
interface LingThreadForkResponse {
  readonly cwd: string;
  readonly sourceThread: LingThread;
  readonly sourceTurn?: LingTurn;
  readonly sourceRun?: RunSession;
  readonly childThread: LingThread;
  readonly lineage: {
    readonly parentThreadId: string;
    readonly parentTurnId?: string;
    readonly forkedFromRunId?: string;
  };
}
```

#### Storage

Add nullable columns to `ling_threads`:

```text
parent_thread_id TEXT NULL
parent_turn_id TEXT NULL
forked_from_run_id TEXT NULL
```

Do not add a separate fork table in V2D-B. The channel tree can be built from the flat
thread list by grouping on `parentThreadId`. If deep lineage queries become expensive,
add a later read model or cache.

#### Source Resolution

Fork source resolution should mirror the V2D-A resume discipline: validate against
authoritative rows, not metadata.

Rules:

1. `threadId` is the source thread.
2. If `turnId` is present, read `ling_turns` and require `turn.threadId === threadId`.
3. If `sourceRunId` is present, read `runs` and require `run.threadId === threadId`.
4. If both `turnId` and `sourceRunId` are present, require the run to be linked to the
   turn through `ling_turn_runs` or `turn.lastRunId`.
5. If `turnId` is absent, choose the latest terminal turn in the source thread when one
   exists.
6. If no terminal turn exists, create a thread-level fork with only `parentThreadId`.
7. A selected active/open/waiting turn returns `turn_active`.
8. An archived source thread returns `source_thread_archived` in V2D-B.

Stable error codes:

- `thread_not_found`
- `source_thread_archived`
- `turn_not_found`
- `turn_not_in_thread`
- `turn_active`
- `source_run_not_found`
- `source_run_not_in_thread`
- `source_run_not_in_turn`
- `fork_idempotency_conflict`

#### Mutation Semantics

A fork creates one child `LingThread` and no immediate run.

Child values:

- `workspaceId`: copied from the source thread;
- `kind`: copied from the source thread;
- `channelId`: copied from the source thread when present;
- owner fields: copied only when they preserve the same surface, such as task,
  workflow-step, external-work, teammate, or channel context;
- `title`: request title or `Fork: <source title>`;
- `objective`: request objective or a generated objective referencing the source
  thread/turn;
- `status`: `open`;
- `activeRunId`: empty;
- `lastRunId`: empty;
- `parentThreadId`: source thread id;
- `parentTurnId`: resolved terminal source turn id when available;
- `forkedFromRunId`: resolved source run id when available.

Source values must not be changed:

- no automatic archive;
- no pin mutation;
- no status mutation;
- no source turn mutation;
- no source run mutation;
- no copying of raw logs, events, artifacts, process snapshots, or transcript rows.

The first instruction in the child branch should create a normal child turn/run through
the existing conversation flow. Fork lineage stays on the thread, not on every child turn.

#### Web Interaction

Fork is a branch action:

1. User forks from a thread header, Work History thread detail, or a selected completed
   turn action.
2. Web calls `POST /threads/:threadId/fork`.
3. Web refreshes the source channel's thread list and Work History detail cache.
4. Web selects the returned child thread.
5. Center conversation switches to the child branch and focuses the composer.

The source transcript should not embed the child transcript. A compact non-transcript
branch notice near the source turn is acceptable as confirmation, but the primary
navigation surface is the channel work-thread tree.

Child header:

```text
Forked from <source thread title> / <source turn title>
```

The link should navigate back to the source thread or source turn where the current
surface supports it.

#### Channel Tree

Build the channel work-thread tree from visible `LingThread[]`:

```text
Channel
  Source thread
    Child fork
      Grandchild fork
```

Rules:

- group by `parentThreadId`;
- root rows are threads without `parentThreadId` or whose parent is not visible;
- orphaned rows should render as top-level rows with `Parent hidden`;
- selecting any row switches the center conversation to that thread;
- use indentation and a branch marker, not a separate modal or detached Work History
  card;
- archive and pin actions remain out of V2D-B.

#### Work History Lineage

Source detail:

- show child branch count;
- show a compact child list with status, last activity, and channel context;
- link each child to its Work History detail and, when possible, the channel branch.

Child detail:

- show `Forked from`;
- show source thread, source turn, and source run when known;
- provide a back link to the source thread;
- show `Source unavailable` if the parent has been deleted or filtered from the current
  query.

Work History lineage is explanatory and navigational. It must not become execution
authority for resume, approve, cancel, rerun, or provider repair.

#### Test Cases

- daemon creates a child thread with `parentThreadId`, `parentTurnId`, and
  `forkedFromRunId` when forking a completed turn;
- daemon creates a thread-level child when no terminal turn exists;
- daemon rejects active selected turns with `turn_active`;
- daemon rejects archived source threads with `source_thread_archived`;
- idempotent fork request returns the same child thread for the same source/key;
- mock daemon mirrors fork lineage for Web e2e;
- Web channel tree renders source and child under the same channel;
- selecting source and child switches center conversation;
- Work History source detail shows child branches;
- Work History child detail shows `Forked from`;
- topic reply UI remains unchanged.

#### Implementation Record

Implemented on 2026-06-09:

- `LingThread` lineage fields are part of contracts, core run types, API client, Web API
  wrappers, and Web mock daemon state;
- SQLite persists lineage directly on `ling_threads`; no `thread_forks` table was added;
- daemon fork route creates a child thread only and returns source/child lineage in one
  response;
- source resolution rejects invalid turn/run combinations with stable machine-readable
  errors;
- child branch keeps source `channelId` and starts with no `activeRunId` or `lastRunId`;
- source thread is not archived, hidden, status-mutated, or copied;
- Work History thread detail exposes Fork, parent source information, child branch list,
  and child navigation;
- channel workspace adds a compact work-thread branch strip and branch-scoped empty state
  for forks with no runs yet;
- mock daemon and e2e cover the same no-copy child-thread behavior.

Known first-slice limits:

- Fork does not start a run or create a first child turn.
- Fork does not copy source transcript rows into the child branch.
- Fork does not add archive/pin/search surfaces.
- Fork lineage is navigational and explanatory; it is not execution authority for
  approval, rerun, cancel, provider repair, or resume recovery.
- Automatic source-turn selection can be polished later; the current surface supports
  explicit source-turn selection before Fork.

Validation commands:

- `git diff --check`
- `corepack pnpm --filter @ling-stack/contracts build`
- `corepack pnpm --filter @ling-stack/core build`
- `corepack pnpm --filter @ling-stack/daemon build`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `cd packages/daemon && node --test --test-name-pattern "daemon fork creates child thread lineage" test/ling-turns-api.test.mjs`
- `corepack pnpm --filter @ling-stack/web exec playwright test e2e/runtime.spec.ts -g "fork lineage creates child thread"`

### Fork Display Rules

Fork has to be visible in both the originating channel and Work History. Otherwise users
cannot tell where the new branch went.

After a successful fork:

```text
channel sidebar
  -> selected channel
    -> work thread tree
       source LingThread
         child LingThread

Work History detail
  -> lineage strip
     source thread -> source turn -> child thread
```

Rules:

- show the child thread in the selected channel's work-thread tree by default;
- the channel sidebar should support expanding/collapsing a channel's work threads under
  the channel row;
- selecting a tree row switches the center conversation to that `LingThread`;
- source and child branches should be visually connected by indentation and parent
  markers, not only by a detail-page lineage view;
- do not insert the child thread's whole transcript into the source transcript;
- a compact system/branch notice near the source turn is optional confirmation, not the
  primary navigation surface;
- the child thread header should show `Forked from ...` with a back link to the source
  turn;
- the source thread should show a child-branch count or lineage link in Work History;
- archived child branches are hidden from the default channel tree but remain visible from
  lineage and search when filters include archived work;
- Fork is not a replacement for topic replies. Topic replies remain message-level side
  threads; Fork creates work-thread branches.

### Archive UI Rules

Archive should borrow Codex's lightweight row-action pattern. The default channel tree
stays quiet, and destructive intent is confirmed in place.

```text
channel sidebar work-thread row
  default:
    thread title, status metadata
  hover/focus:
    pin icon, archive icon, more menu
  archive icon clicked:
    same row enters confirm state
    [Confirm] [Cancel]
  confirmed:
    row leaves default tree
    lineage/search can still reveal it when archived work is included
```

Rules:

- do not open a modal for ordinary archive from the channel tree;
- do not show `Archive` as a permanent button on every row;
- show row actions only on hover/focus or when a row is selected;
- use an icon-only archive affordance with tooltip text, then an inline `Confirm`
  control after the first click;
- confirm state should be local to one row and dismiss on cancel, Escape, or selecting
  another row;
- archived source and child branches are removed from the default channel tree after
  confirmation;
- if the currently selected branch is archived, keep the center view open and mark it
  `Archived`, then prompt navigation to the nearest visible sibling/source;
- unarchive belongs in Work History detail, lineage/search results, or an archived filter,
  not the default active channel tree;
- pin is independent from archive and can share the same hover action cluster.

### V2D-C/D/E Follow-Up Details

V2D-C, V2D-D, and V2D-E should share one visibility/search model but remain separate
implementation slices. Archive/pin establishes the visibility contract, search consumes
that contract, and fork-and-run composes V2D-B fork lineage with existing run start
orchestration.

Shared invariants:

- lineage is read from `ling_threads.parent_thread_id` and `parent_turn_id`;
- archive and pin state are explicit thread fields, not derived from thread metadata;
- metadata can cache counts and summaries, but never authorizes resume, fork, cancel,
  approve, rerun, or provider repair;
- default operational views exclude archived work;
- archived work can be reached through explicit filters, direct links, lineage detail,
  and search with archived inclusion;
- search never scans raw JSONL logs, shell snapshots, PTY captures, or artifact bodies in
  V2D-D;
- fork-and-run uses the normal run pipeline after the child thread/turn has been created.

### V2D-C Archive, Pin, And Archived Filters Details

#### Thread Fields

Promote archive/pin from reserved metadata hints to queryable thread fields:

```ts
interface LingThread {
  readonly pinnedAt?: string;
  readonly archivedAt?: string;
  readonly archivedReason?: string;
}
```

SQLite fields:

```text
pinned_at TEXT NULL
archived_at TEXT NULL
archived_reason TEXT NULL
```

Indexes:

```text
idx_ling_threads_visible_channel(channel_id, archived_at, pinned_at, updated_at)
idx_ling_threads_archived(channel_id, archived_at, updated_at)
idx_ling_threads_pinned(parent_thread_id, pinned_at, updated_at)
```

`archivedAt` is a visibility marker. It must not overwrite `status`. A succeeded thread
remains `succeeded`; a failed thread remains `failed`; the UI layers an `Archived` badge.

#### Routes

```text
POST /threads/:threadId/archive?cwd=...
POST /threads/:threadId/unarchive?cwd=...
POST /threads/:threadId/pin?cwd=...
POST /threads/:threadId/unpin?cwd=...
GET /threads?cwd=...&archived=exclude|include|only
```

Archive request:

```ts
interface LingThreadArchiveRequest {
  readonly reason?: string;
  readonly idempotencyKey?: string;
}
```

Pin request:

```ts
interface LingThreadPinRequest {
  readonly idempotencyKey?: string;
}
```

Responses:

```ts
interface LingThreadMutationResponse {
  readonly cwd: string;
  readonly thread: LingThread;
}
```

#### Archive Guards

Archive should be conservative:

1. Read the current `LingThread`.
2. Reject missing thread with `thread_not_found`.
3. Reject already archived source on archive with `thread_already_archived`.
4. Reject unarchive on non-archived rows with `thread_not_archived`.
5. If `activeRunId` points to a queued/running/waiting run, reject with
   `active_thread_archive_blocked`.
6. If any turn in the thread is open/running/waiting/blocked, reject with
   `active_thread_archive_blocked`.
7. Otherwise set `archivedAt` and optional redacted `archivedReason`.

Archive does not cascade. Parent and child rows can be archived independently. If a
visible child has an archived parent, show `Parent archived` / `Parent hidden` instead of
moving or mutating lineage.

Forking archived sources stays blocked until unarchive. Resuming archived threads is
blocked in V2D-C; the user should unarchive first.

#### Pin Sorting

Pin only affects ordering:

```text
pinnedAt DESC NULLS LAST
lastActivityAt / updatedAt DESC
thread id ASC
```

Apply sorting inside the current sibling group so pinned child threads do not jump above
their parent lineage group. In archived-only views, pinned archived rows sort first inside
that archived result set.

#### Filters

`archived` query values:

- `exclude`: default; `archivedAt IS NULL`;
- `include`: active plus archived;
- `only`: `archivedAt IS NOT NULL`.

Invalid values return `bad_archived_filter`. Existing callers that omit `archived` keep
the V2D-B active-only behavior.

#### UI State

Channel tree row action state:

```ts
type ThreadRowActionState =
  | { readonly mode: "idle" }
  | { readonly mode: "archive_confirm"; readonly threadId: string }
  | { readonly mode: "pin_pending"; readonly threadId: string }
  | { readonly mode: "archive_pending"; readonly threadId: string };
```

Rules:

- only one row may be in archive-confirm state;
- confirm state clears on Escape, Cancel, channel change, branch selection, or successful
  mutation;
- archive confirmation is inline;
- Work History detail can use normal text buttons because detail pages are explicit
  inspection surfaces;
- the composer should not show archive/pin actions.

#### Test Matrix

- archive hides a row from default channel tree and Work History active list;
- archive preserves direct run evidence and lineage detail;
- unarchive restores default visibility;
- archive does not cascade to child branches;
- active thread archive is blocked;
- pin sorts above sibling rows without breaking lineage nesting;
- archived filters show `exclude`, `include`, and `only` behavior.

#### Implementation Record

V2D-C shipped as an archive/pin visibility slice, not as search or fork-and-run:

- `LingThread` contracts now expose `pinnedAt`, `archivedAt`, and `archivedReason`;
- list requests accept `archived=exclude|include|only`; legacy
  `includeArchived=true` still maps to include behavior;
- SQLite stores visibility in explicit columns and upgrades older `ling_threads` tables
  that are missing any of `pinned_at`, `archived_at`, or `archived_reason`;
- default list behavior excludes rows with `archived_at` or legacy `status='archived'`;
- archived-only includes rows with explicit `archived_at` or legacy archived status;
- mutation routes return `{ cwd, thread }` and keep archive idempotent when an
  idempotency key is provided;
- unarchive clears `archivedAt` / `archivedReason`; legacy `status='archived'` is restored
  to `open`;
- pin/unpin only updates ordering metadata and does not mutate lineage, turns, runs, or
  evidence;
- archive rejects active runs, missing active-run records, and open/running/waiting/blocked
  turns with `active_thread_archive_blocked`;
- fork from archived sources still fails with `source_thread_archived`.

Web implementation:

- Work History owns the first restore surface through `Active / All / Archived`;
- Work History detail exposes Archive/Unarchive and Pin/Unpin text actions;
- channel branch tree rows expose Pin/Unpin plus inline Archive Confirm/Cancel;
- channel branch tree consumes daemon active-only results by default and avoids deriving
  hidden archived rows back from recent run records;
- channel tree does not add its own archived filter in this slice.

Deferred polish:

- keep-selected-archived-branch center-view behavior after channel row archive;
- channel-local archived filter / show-all control;
- structured search result badges and match reasons;
- fork-and-run composition.

Validation commands used:

```text
corepack pnpm --filter @ling-stack/contracts build
corepack pnpm --filter @ling-stack/core build
corepack pnpm --filter @ling-stack/daemon build
corepack pnpm --filter @ling-stack/web typecheck
node --test --test-name-pattern "daemon archive pin and archived filters" packages/daemon/test/ling-turns-api.test.mjs
corepack pnpm --filter @ling-stack/web exec playwright test e2e/runtime.spec.ts -g "run history archives restores pins and filters work threads"
corepack pnpm --filter @ling-stack/web exec playwright test e2e/runtime.spec.ts -g "fork lineage creates child thread"
```

### V2D-D Search Details

#### Search Scope

First implementation searches only structured fields:

| Entity | Fields |
| --- | --- |
| `LingThread` | `title`, `objective`, `taskId`, owner ids |
| `LingTurn` | `title`, `userInstruction`, `taskId`, `sourceTurnId` |
| `RunSession` | `taskId`, task snapshot `title`, task snapshot `prompt`, `summaryPath` basename |
| `LingThreadMetadata` | `summary` only after redaction |

Excluded in V2D-D:

- raw JSONL event logs;
- shell snapshot text;
- PTY buffers;
- artifact bodies;
- approval reasons beyond structured non-secret status labels;
- message transcript body search outside work-thread/turn fields.

#### Query Shape

Prefer extending the existing list endpoint:

```text
GET /threads?cwd=...&q=...&archived=exclude|include|only&limit=...
```

Response extension:

```ts
interface LingThreadSearchMatch {
  readonly threadId: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly field:
    | "thread_title"
    | "thread_objective"
    | "turn_title"
    | "turn_instruction"
    | "task_id"
    | "task_title"
    | "task_prompt"
    | "metadata_summary";
  readonly snippet: string;
}

interface LingThreadListResponse {
  readonly cwd: string;
  readonly threads: readonly LingThread[];
  readonly matches?: readonly LingThreadSearchMatch[];
}
```

If the response extension makes list callers awkward, split later into
`GET /threads/search`. Do not start with a separate durable search index.

#### Matching And Ranking

Normalize query:

- trim whitespace;
- collapse internal whitespace;
- lower-case with locale-insensitive comparison;
- reject fewer than two visible characters;
- cap at 128 characters.

Ranking:

1. active pinned exact thread-title match;
2. active thread title/objective prefix match;
3. active thread title/objective substring match;
4. active turn/run task match;
5. archived matches when archived filter includes them;
6. newest `updatedAt` tie-breaker.

Snippets:

- run through redaction before returning;
- cap snippet length;
- never return raw JSON;
- include enough field context for UI labels.

Stable errors:

- `search_query_too_short`;
- `search_query_too_long`;
- `bad_archived_filter`.

#### UI Behavior

Work History:

- search input lives above the work-thread list;
- filters combine as `query AND archived filter`;
- result rows show match reason, status, pinned badge, archived badge, and lineage hint;
- selecting a turn match opens thread detail and selects/highlights the turn when loaded;
- if turn details are not loaded, show `Matched turn will load with thread evidence`.

Channel branch tree:

- lightweight branch search filters visible branch rows for the selected channel only;
- empty search state should distinguish `No active branches match` from
  `Archived branches hidden`;
- changing channels clears branch search.

#### Test Matrix

- thread title search;
- turn instruction search;
- run task prompt search;
- archived exclude/include/only interaction;
- secret-looking snippet redaction;
- Web Work History search result navigation;
- channel branch search empty state.

#### Implementation Record

V2D-D shipped as structured read-through search over existing durable tables:

- list response now accepts `q` and may return `matches`;
- no separate `GET /threads/search` route was added;
- no durable search index/cache table was added;
- matching is case-insensitive substring matching over normalized text;
- candidate rows still use the V2D-C archived filter first, then search matches within
  those candidates;
- ranking prefers exact/prefix thread title, then thread title/objective, metadata
  summary, task fields, and turn fields, with pinned rows favored and archived rows
  penalized when included;
- snippets are redacted with the core secret redaction helper and capped;
- daemon validates query length before hitting the store.

Search scope implemented:

- `LingThread.title`;
- `LingThread.objective`;
- `LingThread.taskId`, `workflowStepId`, `externalWorkId`;
- `LingThread.metadata.summary`;
- `LingTurn.title`;
- `LingTurn.userInstruction`;
- `LingTurn.taskId`;
- `LingTurn.sourceTurnId`;
- `RunSession.taskId`;
- `RunSession.taskSnapshot.title`;
- `RunSession.taskSnapshot.prompt`;
- `RunSession.summaryPath` basename.

Excluded by design:

- run event JSONL;
- shell snapshots;
- PTY buffers;
- artifact bodies;
- channel transcript message bodies.

Web implementation:

- Work History search input combines with `Active / All / Archived`;
- Work History rows show the first match label/snippet;
- selecting a search result uses the existing thread row navigation;
- channel branch tree search filters only visible active branches for the selected
  channel and shows `No active branches match` when the local filter removes all rows.

Deferred polish:

- turn-specific scroll/highlight after opening a matched thread;
- richer match chips and multi-match expansion;
- archived branch local search/restore inside the channel tree;
- durable search index if structured scans become too slow.

Validation commands used:

```text
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/daemon build
node --test --test-name-pattern "daemon structured thread search" packages/daemon/test/ling-turns-api.test.mjs
corepack pnpm --filter @ling-stack/web exec playwright test e2e/runtime.spec.ts -g "run history archives restores pins and filters work threads"
```

### V2D-E Fork-And-Run Details

#### Product Contract

Plain Fork and Fork-and-run are different commands:

- `Fork`: create a child thread branch and stop.
- `Fork and run`: create or reuse the child branch, create or reuse the child first turn,
  and start a normal run from that turn.

Codex-like default behavior is plain Fork. The user lands in the child branch and can
decide the next instruction. Fork-and-run should be offered only when the source is
terminal and the user explicitly provides an immediate next instruction. It must not
replace manual branch review or silently start work after every fork.

#### Route

```text
POST /threads/:threadId/fork-run?cwd=...
```

Request:

```ts
interface LingThreadForkRunRequest {
  readonly turnId?: string;
  readonly sourceRunId?: string;
  readonly title?: string;
  readonly objective?: string;
  readonly instruction: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly idempotencyKey: string;
}
```

Response:

```ts
interface LingThreadForkRunResponse {
  readonly cwd: string;
  readonly sourceThread: LingThread;
  readonly sourceTurn?: LingTurn;
  readonly sourceRun?: RunSession;
  readonly childThread: LingThread;
  readonly childTurn?: LingTurn;
  readonly childRun?: RunSession;
  readonly runId?: string;
  readonly status: "fork_created" | "fork_reused" | "run_started" | "run_failed";
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}
```

#### Durable Operation

Do not wrap the whole operation in an all-or-nothing illusion. Use durable phases:

1. Validate instruction and idempotency key.
2. Resolve source thread/turn/run with V2D-B rules.
3. Create or reuse deterministic child thread.
4. Create or reuse deterministic first child turn.
5. Start normal run using existing provider/runner/concurrency/approval paths.
6. Return child thread even if run start fails after the child exists.

`ling_turns.source_turn_id` remains a same-thread pointer. Fork-and-run must not use it
to point from the child branch back to a parent branch turn. Cross-branch source lineage
is expressed by `LingThread.parentThreadId`, `LingThread.parentTurnId`, and
`LingThread.forkedFromRunId`.

Idempotency keys:

```text
fork-run:<sourceThreadId>:<sourceTurnId?>:<sourceRunId?>:<userKey>
```

Derived ids:

- child thread id uses the existing fork deterministic id;
- child turn id uses the fork-run idempotency key;
- child run id uses existing run idempotency behavior when supported by the run creation
  path.

Failure rules:

- source validation failure creates nothing;
- child thread success is never rolled back;
- child turn success is never rolled back;
- run-start failure returns `run_failed` with a retryable error;
- retry with the same key reuses child thread/turn and starts the missing run when
  possible;
- retry after a run already started returns the existing run.

The child branch's first run is a primary run in that child thread. Do not mark it as a
retry/resume by setting `parentRunId`; source run lineage is already carried by
`forkedFromRunId` on the child thread.

Stable errors:

- all V2D-B fork source errors;
- `fork_run_instruction_required`;
- `fork_run_idempotency_required`;
- `fork_run_child_turn_conflict`;
- `fork_run_start_failed`;
- normal provider/runner/concurrency errors from existing run creation.

#### UI Flow

Work History thread detail:

```text
[Fork] [Fork and run]

Fork and run opens an inline composer:
  instruction textarea
  optional provider/runner menu
  [Start child branch]
```

After success:

- select the child branch;
- show the running Conversation Work Cell in the conversation feed;
- show a compact lineage banner in child thread detail;
- do not insert source transcript rows into the child branch.

After run-start failure:

- keep child branch selected;
- show error banner with retry using the same idempotency key;
- keep plain run repair flows unchanged.

#### Test Matrix

- successful fork-and-run creates child thread, child turn, and child run;
- retry with same idempotency key creates no duplicates;
- source validation failure creates no child;
- run-start failure after child creation preserves child thread and returns error;
- Web selects child branch and shows active work cell;
- plain fork still creates no turn and no run.

## UI Design

### Conversation Feed

Add a work cell component family:

```ts
type ConversationWorkCellMode = "active" | "completed";

type TurnProcessItemKind =
  | "read"
  | "search"
  | "edit"
  | "command"
  | "test"
  | "approval"
  | "browser"
  | "artifact"
  | "attempt";

interface TurnProcessItem {
  readonly id: string;
  readonly kind: TurnProcessItemKind;
  readonly status: LingTurnStatus;
  readonly title: string;
  readonly target?: string;
  readonly evidenceCount?: number;
  readonly attemptId?: string;
  readonly evidenceIds?: readonly string[];
}

interface TurnProcessItemGroup {
  readonly id: string;
  readonly title: "Changed" | "Checked" | "Evidence" | "Attention" | string;
  readonly summary?: string;
  readonly items: readonly TurnProcessItem[];
}

interface ConversationWorkCellProps {
  readonly thread: LingThread;
  readonly turn: LingTurn;
  readonly attempts: readonly RunSession[];
  readonly metadata?: LingThreadMetadata;
  readonly mode: ConversationWorkCellMode;
  readonly liveItems?: readonly TurnProcessItem[];
  readonly itemGroups: readonly TurnProcessItemGroup[];
  readonly evidence: ConversationEvidenceBundle;
  readonly collapsed?: boolean;
}
```

Recommended components:

```text
ConversationWorkCell
  ActiveTurnItemStream
  CompletedTurnSummary
  TurnItemGroupDisclosure
  InlineEvidenceSummary
  ComposerApprovalOverlay
  RawDiagnosticsDrilldown
```

The active stream should behave like ordinary conversation content: short rows appended
as Ling works. The completed summary should replace the stream by default after the turn
finishes, with a `Details` disclosure that hydrates grouped items on demand.

The collapsed cell should fit inside the message feed, not become a nested dashboard or
a miniature Work History page.

### Work History Detail

The Work detail panel should evolve from:

```text
Thread summary
Attempts
Execution actions
Resume context
State transitions
```

to:

```text
Thread summary
Turn timeline
  -> Result summary
  -> Process disclosure
  -> Attempts
  -> Evidence
Resume/fork/archive/pin/search controls
Raw diagnostics drawer
```

### Work Board Links

Work Board remains a current-state operational page.

Rules:

- Work item rows link to Work History turn detail when `turnId` exists.
- Work item rows link to Attempt detail when only `runId` exists.
- Work item rows link to Work detail when only `threadId` exists.
- Work Board does not show full process history inline.

### Review Queue Links

Review Queue remains action-focused.

Rules:

- pending approval card shows decision controls inline;
- linked evidence opens the relevant turn or attempt;
- Review Queue does not become a historical transcript;
- approval enforcement continues to use `ApprovalRequest`, not metadata.

## Security And Privacy

### Reasoning Boundary

Do not store or display hidden reasoning.

Allowed:

- user instruction;
- assistant final response;
- user-visible plan/checklist if already emitted;
- tool call name, command, risk, status, and summarized output;
- file diff and artifacts;
- approval payload and decision;
- test/browser evidence;
- failure reason and repair hint.

Not allowed:

- hidden model chain-of-thought;
- private scratch reasoning;
- secrets in request snapshots;
- raw environment values unless already authorized and redacted;
- unlimited stdout/stderr dumps by default.

### Evidence Redaction

Evidence summaries should redact:

- API keys;
- tokens;
- passwords;
- local private identifiers not needed for the UI;
- large binary or log payloads.

Artifacts may store fuller detail when already allowed, but the conversation work cell
should show summaries and links, not raw sensitive payloads.

## Implementation Slices

### V2A: Durable Turn Contract And Store

Scope:

- add contracts;
- add SQLite migration for `ling_turns` and `ling_turn_runs`;
- add store methods;
- create turns for new work-triggering intents;
- link new runs to turns;
- preserve derived fallback for old runs.

Acceptance:

- a new task run creates a turn and a linked run attempt;
- a follow-up creates a child or source-linked turn;
- old runs without turns still render;
- turn status reconciles from linked runs;
- no raw reasoning or secrets are stored in turn rows.

### V2B: Metadata Read Model

Scope:

- add rebuildable metadata shape;
- expose `includeMetadata`;
- render thread rail from metadata when present;
- add rebuild/reconcile tests.

Acceptance:

- thread list renders without scanning every event;
- stale metadata does not affect approvals or runtime state;
- metadata can be rebuilt from source records;
- missing metadata falls back to V1-derived counts.

### V2C: Conversation Work Cell

Scope:

- add conversation work cell components;
- render active turn item streams in conversation while work is running;
- automatically replace active streams with completed turn summaries after completion;
- hydrate grouped details from the completed turn on explicit expansion;
- reuse `ConversationEvidenceBundlePanel`;
- keep raw diagnostics in drawer/details;
- keep Work History as the richer audit surface.

Acceptance:

- running work shows sparse action item rows, not hidden reasoning;
- completed work collapses to a compact result summary;
- expanding the summary shows grouped Changed / Checked / Evidence items;
- grouped rows link to attempts/evidence;
- raw event stream is not default body;
- direct run links still open Attempt detail.

### V2D: Turn-Linked Recovery

Scope:

- turn-linked resume preview/resume;
- fork with parent lineage;
- archive/pin/search;
- Work Board and Review Queue routing to turn anchors.

Acceptance:

- resume from selected turn includes intended prior context;
- fork creates child thread lineage;
- archive hides from default list and preserves evidence;
- search finds thread/turn summaries without raw log search;
- Review Queue links to full evidence but stays action-led.

## Migration Strategy

1. Add V2 tables and contracts without changing old rows.
2. Start writing turns for new work.
3. Derive turn-like rows for old runs when no durable turn exists.
4. Add metadata rebuild for new and old threads.
5. Switch UI to prefer durable turns, fallback to derived groups.
6. Keep direct run detail forever as operator evidence.

No migration should rewrite old run logs or event JSONL files.

## Test Plan

### Unit / Store

- create/list turns;
- link run attempts to turns;
- reconcile turn status;
- rebuild metadata;
- preserve fallback when turn records are missing.

### Web E2E

- active channel work displays sparse live item rows;
- completed channel work auto-collapses to a result summary;
- expanded work cell shows grouped Changed / Checked / Evidence rows;
- evidence disclosure opens tool/file/test/browser evidence;
- Work History opens the same turn with richer detail;
- Work Board `Open run` still opens Attempt detail when only `runId` exists;
- Work Board `Open turn` opens Work History turn detail when `turnId` exists;
- Review Queue approval links to turn evidence without losing action controls;
- direct legacy run records remain inspectable.

### Safety

- hidden reasoning is never rendered;
- redacted evidence summaries do not expose API keys;
- raw logs require explicit drill-down;
- stale metadata cannot approve, deny, cancel, or resume work.

## Open Decisions

- For teammate direct messages, the default should be no `LingTurn`. Direct-message
  records point to turns only when executable work is created, continued, queued, or
  redirected. The remaining open decision is the exact API field name for that optional
  link.
- Should `metadata_json` live on `ling_threads`, or should it be a separate
  `ling_thread_metadata` table?
- Should turn ids be daemon-only, or can Web allocate optimistic ids?
- Should `turn/steer`-like behavior exist for active Ling turns, or should Ling keep
  current explicit intervention records only?
- Should turn item rows become a durable rebuildable cache in V2C, or wait until
  performance pressure appears?

## Completion Criteria

V2 is complete when:

- every new executable user intent has a durable `LingTurn`;
- conversation feed consumes a shared `ConversationTranscript` read model;
- active operation blocks mutate in place while work is running;
- completed operation blocks commit as folded transcript history instead of being deleted
  or replaced by the final summary;
- one user task normally renders as one assistant transcript turn with start text,
  operation cells, agent spans, terminal text, and artifacts as blocks;
- users can expand operation cells and agent spans to inspect grouped items and evidence;
- Work History can show the same turn with richer audit detail;
- turn-linked resume/fork/search/archive works;
- Work Board and Review Queue route to turn or attempt anchors correctly;
- direct run detail still works;
- raw logs and hidden reasoning are not default conversation content;
- Web, Desktop, and CLI render the same transcript contract instead of each owning
  independent phrase-based grouping logic.
