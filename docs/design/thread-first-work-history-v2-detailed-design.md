# Thread-First Work History V2 Detailed Design

Status: detailed design
Date: 2026-06-08
Scope: conversation work cells, durable turns, thread metadata, process disclosure,
evidence layering, Work History integration, and V2 implementation slices

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
items. When work completes, Ling should automatically collapse those items into a compact
turn result. Expanding the result should show how Ling got there. Raw diagnostics stay
behind explicit drill-down.

## Related Docs

- [Thread-First Work History](thread-first-work-history.md)
- [Thread-First Work History Implementation Plan](thread-first-work-history-implementation-plan.md)
- [Codex-Inspired Conversation Experience v1](codex-inspired-conversation-v1.md)
- [Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md)
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
    -> RunSession attempt
      -> Evidence item
```

## V2 Product Goals

- Show active work inside channel/private conversation as sparse live item rows.
- Collapse completed work into a compact turn result summary.
- Let users expand completed summaries to audit grouped items without reading raw event
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

## User-Facing Information Architecture

### Conversation Default

The conversation feed should default to ordinary messages plus turn-level work items:

```text
User message
Active turn item stream
User follow-up
Completed turn result summary
```

Active turns answer what Ling is doing now without exposing hidden reasoning:

- which auditable action is currently running;
- whether Ling is waiting for approval or user input;
- which tool, file, command, test, browser check, or external work item is involved;
- whether the action succeeded, failed, was cancelled, or is still running.

Completed turn summaries answer:

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
conversation. These rows are transient presentation of auditable actions, not durable
reasoning:

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
- when the turn completes, replace the live stream with the completed summary by
  default while preserving the ability to expand details.

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
- exclude external work actions, paid media approvals, provider changes, credential
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

It is not a chat message table. It records work-triggering intent and lineage.

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
  readonly sourceMessageId?: string;
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
  source_message_id TEXT,
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

Create a turn when a work-triggering intent is accepted:

- workspace task run starts;
- channel message creates executable work;
- manual follow-up or queued follow-up is accepted;
- run redirect/interruption is recorded;
- workflow step starts;
- automation tick starts real work;
- external work update is routed into Ling work.

Do not create a turn for every normal chat message unless that message creates or
continues executable work.

### Status Reconciliation

Turn status is derived from linked runs and explicit interventions:

```text
active run queued/running -> running
any linked run waiting_for_approval -> waiting_for_approval
latest terminal run succeeded -> succeeded
latest terminal run failed and no queued continuation -> failed
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

## API Design

### Additive V2 APIs

```text
GET /threads?cwd=...&includeMetadata=true
GET /threads/:threadId?cwd=...&includeMetadata=true
GET /threads/:threadId/turns?cwd=...
POST /threads/:threadId/turns?cwd=...
GET /threads/:threadId/evidence?cwd=...&turnId=...
GET /threads/:threadId/process?cwd=...&turnId=...
POST /threads/:threadId/resume-preview?cwd=...&turnId=...
POST /threads/:threadId/resume?cwd=...&turnId=...
POST /threads/:threadId/fork?cwd=...
POST /threads/:threadId/archive?cwd=...
POST /threads/:threadId/pin?cwd=...
GET /threads?cwd=...&q=...
```

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

- Should teammate direct chat work share `LingTurn`, or should direct-message records
  point to turns only when work is created?
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
- conversation feed can show active item streams while work is running;
- completed work auto-collapses into result-first summaries;
- users can expand summaries to inspect grouped items and evidence;
- Work History can show the same turn with richer audit detail;
- turn-linked resume/fork/search/archive works;
- Work Board and Review Queue route to turn or attempt anchors correctly;
- direct run detail still works;
- raw logs and hidden reasoning are not default conversation content.
