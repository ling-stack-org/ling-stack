# Thread-First Work History Implementation Plan

Status: implementation plan
Date: 2026-06-08
Scope: V1 thread-first Work History UI, derived turn groups, evidence hierarchy, link
routing, i18n, tests, and V2 contract preparation

## Purpose

This document turns [Thread-First Work History](thread-first-work-history.md) into
small implementation slices.

The main design defines the product model:

```text
Work thread
  -> User intent turn
    -> Run attempt
      -> Evidence item
```

This plan defines how to ship that model without destabilizing the current run system.
V1 changes the user-facing information architecture first. V2 adds durable turns and
thread metadata after the V1 query and UI patterns prove they are needed.

## Related Docs

- [Thread-First Work History](thread-first-work-history.md)
- [Thread-First Work History V2 Detailed Design](thread-first-work-history-v2-detailed-design.md)
- [Codex-Inspired Conversation Experience v1](codex-inspired-conversation-v1.md)
- [Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md)
- [Execution And Orchestration Hardening](execution-orchestration-hardening.md)
- [Execution And Orchestration Hardening Implementation Plan](execution-orchestration-hardening-implementation-plan.md)
- [Run Interruption And Continuation](run-interruption-continuation.md)
- [Work Board, Review Queue, and Inline Approval Boundaries](work-board-review-queue.md)
- [Work Board, Review Queue, and Inline Approval Implementation Plan](work-board-review-queue-implementation-plan.md)
- [Codex-Inspired Runtime Tools P2B: Shell Snapshots Follow-Ups](codex-inspired-runtime-tools-p2b-shell-snapshots-follow-ups.md)

## Implementation Order

```text
V1A Rename and navigation framing
-> V1B Thread-first rail and selection model
-> V1C Work detail shell
-> V1D Attempts section
-> V1E Evidence and diagnostics inspector
-> V1F Derived turn groups
-> V1G Review Queue and Work Board links
-> V1H i18n, empty states, and tests
-> V2A Durable LingTurn contract
-> V2B Thread metadata read model
-> V2C Conversation work cell
-> V2D Turn-linked resume, fork, search, and archive
```

V1A through V1H should be shippable without a new durable table. V2A through V2D should
be treated as the next implementation plan after V1 usage exposes concrete pressure.
The V2 detailed design refines the earlier V2C recovery slice by splitting conversation
work-cell rendering into its own V2C slice and moving turn-linked recovery to V2D.

## First Implementation Slice

The first implementation should deliberately stop before the more expensive derived
turn and cross-surface routing work.

Implementation note, 2026-06-08: the first Web slice is implemented in the existing
Runs view as the Work History shell. Navigation and page labels now read Work History,
the primary rail defaults to work threads, legacy records without `threadId` remain
available as run-only fallback rows, selected threads open Work detail, and run
drill-down is framed as Attempt detail. This did not add daemon routes, migrations,
runner changes, approval behavior changes, durable turns, Review Queue routing, or Work
Board routing.

### Scope

Ship these pieces together:

- V1A visible label and empty-state reframing from Runs to Work History / 工作记录;
- V1B thread-first rail as the default list, with run-only fallback for legacy records;
- V1C work detail header and summary shell for selected threads;
- V1D minimal Attempts section using existing run detail rendering for drill-down.

This slice should preserve the current direct run detail path. If a user opens a run
from an old link, CLI/operator workflow, or fallback row, it should still render.

### Deferred

Keep these out of the first implementation:

- V1E full evidence inspector redesign;
- V1F derived turn groups;
- V1G Review Queue / Work Board routing changes;
- V2A durable `LingTurn` contracts;
- V2B thread metadata storage/read model;
- V2C conversation work cell;
- V2D turn-linked resume/fork/search/archive.

### Delivery Boundary

The first slice is a Web presentation and information-architecture change. It may update
copy, selection state, and component hierarchy. It should not add daemon routes, SQLite
migrations, durable tables, approval behavior, runner behavior, or Review Queue
semantics.

### Acceptance

The slice is complete when:

- the nav and page title read as Work History / 工作记录;
- the primary rail prefers threads over raw runs;
- selecting a thread opens Work detail / 工作详情;
- the detail header explains objective, status, active run, and last run;
- attempts are visible as secondary rows;
- direct run detail remains reachable;
- existing resume preview and active-run guards still work;
- no raw event/log stream becomes the default page body.

## Shared Rules

- Borrow Codex's thread/turn/item information architecture, not its app-server
  protocol wholesale.
- Keep `/runs` and existing run detail APIs as operator and evidence surfaces.
- Keep `LingThread` as the V1 continuity object.
- Treat `RunSession` as an attempt inside a work thread.
- Treat events, shell snapshots, artifacts, approvals, and execution actions as
  evidence items.
- Do not add a durable turns table in V1.
- Do not rewrite old run records.
- Do not change approval enforcement or runner policy.
- Do not introduce mid-run prompt injection.
- Keep Review Queue action-led and sparse.
- Preserve direct run links for old records and CLI/operator workflows.
- Any metadata introduced later must be rebuildable and must not become safety
  authority.

## Existing Anchors

| Area | Current anchor |
| --- | --- |
| Thread contracts | `packages/contracts/src/threads.ts`, `packages/core/src/run-types.ts` |
| Run contracts | `packages/contracts/src/runtime.ts`, `packages/core/src/run-types.ts` |
| Thread routes | `packages/daemon/src/features/runs/thread-routes.ts` |
| Run routes | `packages/daemon/src/features/runs/routes.ts` |
| Run UI | `apps/web/src/features/runs/RunHistory.tsx` |
| Run timeline | `apps/web/src/features/runs/RunTimeline.tsx` |
| Shared evidence UI | `apps/web/src/shared/components/*`, `apps/web/src/shared/conversation/*` |
| App navigation | `apps/web/src/app/AppShell.tsx`, `apps/web/src/i18n.tsx` |
| Review Queue | `apps/web/src/lib/review-queue.ts`, Review Queue feature components |
| Work Board | `apps/web/src/lib/work-items.ts`, `apps/web/src/features/work-board/*` |
| Channel workspace links | `apps/web/src/features/workspace/WorkspaceClientView.tsx` |
| E2E coverage | `apps/web/e2e/runtime.spec.ts`, workspace/review queue specs |

## V1A: Rename And Navigation Framing

### Goal

Make the top-level surface read as work continuity, not as a raw run log page.

### Scope

Change visible labels and empty-state copy only. Do not rename code modules in this
slice unless the old name appears in user-visible text.

Preferred labels:

| Current | New visible label |
| --- | --- |
| Runs | Work History |
| Run history | Work history |
| Recent runs | Recent work |
| Thread detail | Work detail |
| Run detail | Attempt detail |
| Run events | Evidence timeline |

Chinese labels:

| English | Chinese |
| --- | --- |
| Work History | 工作记录 |
| Work detail | 工作详情 |
| Attempt detail | 执行尝试 |
| Evidence | 证据 |
| Diagnostics | 诊断 |

### Files

- `apps/web/src/i18n.tsx`
- `apps/web/src/app/AppShell.tsx`
- `apps/web/src/features/runs/RunHistory.tsx`
- E2E expectations that assert old labels

### Tests

- Web e2e can navigate to the renamed Work History surface.
- Existing direct run detail tests still pass after label changes.
- Search for old user-visible strings to verify no accidental "log page" framing
  remains.

## V1B: Thread-First Rail And Selection Model

### Goal

Make the rail default to work threads. Runs remain visible only as fallback or inside a
selected thread.

### Scope

Implement:

- thread rail as the first section;
- fallback "Run-only records" section for old runs without `threadId`;
- status and attention badges on thread rows;
- selection state that opens a thread detail by default;
- direct run selection still opens attempt detail.

Do not implement:

- new durable metadata;
- search indexing;
- archive/pin mutation.

### Data

Use existing:

```text
GET /threads?cwd=...
GET /runs?cwd=...
```

Derived rail markers can be computed from the loaded run, approval, artifact, and state
transition arrays already available in the Runs domain.

### Files

- `apps/web/src/features/runs/RunHistory.tsx`
- `apps/web/src/domains/runs/use-runs-domain.ts`
- `apps/web/src/types.ts`
- `apps/web/e2e/runtime.spec.ts`

### Tests

- A thread row opens work detail.
- A run-only row opens attempt detail.
- A thread with active run shows active status.
- A failed thread shows failure attention without requiring raw event expansion.

## V1C: Work Detail Shell

### Goal

Make selected thread detail answer the user's first questions:

```text
What is this work?
What did I ask for?
What happened?
What needs attention?
How do I continue?
```

### Scope

Work detail should show:

- title, objective, kind, status;
- channel/task/workflow/external-work link when available;
- active run and last run;
- outcome summary or failure summary;
- primary actions: continue, preview resume, cancel active run, open related object;
- compact counts: attempts, approvals, artifacts, actions, transitions.

The header must render even if evidence loading fails.

### Files

- `apps/web/src/features/runs/RunHistory.tsx`
- `apps/web/src/shared/conversation/ConversationSummaryRow.tsx`
- `apps/web/src/lib/run-evidence.ts`
- `apps/web/src/lib/file-change-evidence.ts`

### Tests

- Thread detail renders with evidence loaded.
- Thread detail renders header when evidence endpoint fails.
- Active non-terminal thread disables resume execution but keeps preview guidance.
- Terminal thread allows resume preview.

## V1D: Attempts Section

### Goal

Demote runs from the page's primary object to a compact attempt list inside work detail.

### Scope

Render attempts as compact rows or chips:

- attempt ordinal;
- run status;
- provider and model;
- runner audit fields when available;
- permission preset/mode when available;
- started/ended timestamps;
- failure summary;
- artifact/action counts;
- open attempt detail action.

Attempt detail can reuse the current run detail body. The primary change is hierarchy,
not a rewrite of all run rendering.

### Files

- `apps/web/src/features/runs/RunHistory.tsx`
- `apps/web/src/features/runs/RunTimeline.tsx`
- `apps/web/src/lib/session-permissions.ts`
- `apps/web/src/lib/run-evidence.ts`

### Tests

- Multiple runs under one thread render as attempts.
- Selecting an attempt opens the existing run detail/evidence surface.
- Permission snapshot and failure repair hints still render for direct attempt detail.
- Old run-only records remain inspectable.

## V1E: Evidence And Diagnostics Inspector

### Goal

Separate user-facing work history from diagnostic evidence without hiding auditability.

### Scope

Evidence should include:

- approvals;
- execution actions;
- artifacts;
- file changes;
- shell snapshots;
- state transitions;
- event timeline;
- raw event JSON or JSONL path behind explicit disclosure.

Default behavior:

- approval/blocker state visible at work summary level;
- evidence collapsed by default;
- raw diagnostics hidden behind one more explicit action;
- right drawer or detail panel opens selected evidence items.

### Files

- `apps/web/src/features/runs/RunHistory.tsx`
- `apps/web/src/features/runs/RunTimeline.tsx`
- `apps/web/src/shared/components/ArtifactRow.tsx`
- `apps/web/src/shared/conversation/FileChangeEvidencePanel.tsx`
- Shell snapshot Web surfaces from P2B follow-ups

### Tests

- Evidence counts render without raw event spam.
- Opening an artifact uses existing artifact content URLs.
- Shell snapshot absence shows a compact empty state.
- Raw event JSON is not visible by default.

## V1F: Derived Turn Groups

### Goal

Show user intent groupings before durable turns exist.

### Scope

Add a pure client-side helper that groups runs and interventions into derived turns.

Suggested helper:

```text
apps/web/src/lib/thread-work-history.ts
```

Suggested output:

```ts
type DerivedThreadTurnKind =
  | "original_request"
  | "manual_resume"
  | "queued_followup"
  | "interrupt_redirect"
  | "workflow_step"
  | "external_work_attempt"
  | "legacy_attempt";

interface DerivedThreadTurn {
  readonly id: string;
  readonly kind: DerivedThreadTurnKind;
  readonly title: string;
  readonly instruction: string;
  readonly runIds: readonly string[];
  readonly interventionIds: readonly string[];
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly derived: true;
}
```

Rules:

- Use `RunSession.threadId` as the primary grouping boundary.
- Use `parentRunId`, `interventionId`, and `continuationReason` to connect follow-ups.
- Use `workflowStepId` and `externalWorkId` to label specialized turns.
- Preserve chronological ordering.
- Never let derived grouping change backend status.

### Files

- `apps/web/src/lib/thread-work-history.ts`
- `apps/web/src/features/runs/RunHistory.tsx`
- `apps/web/src/lib/thread-work-history.test.ts` if the Web test setup supports it
- `apps/web/e2e/runtime.spec.ts`

### Tests

- Initial request with one run produces one derived turn.
- Manual resume creates a follow-up derived turn.
- Queue follow-up intervention is shown before/with its continuation run.
- Interrupt redirect is labeled distinctly from normal follow-up.
- Legacy run without thread appears under legacy fallback.

## V1G: Review Queue And Work Board Links

### Goal

Make cross-surface navigation point to work threads when possible while keeping Review
Queue action-focused.

### Scope

Review Queue:

- keep the queue sparse;
- show the immediate decision/action;
- link "View work" to thread detail when `threadId` is known;
- link "View attempt" to run detail when action is attempt-specific;
- keep approval resolution in Review Queue only when it is the immediate action.

Work Board:

- link channel cards to work detail when the card has a thread;
- keep current-state board actions in Work Board;
- avoid embedding full thread evidence in board cards.

### Files

- `apps/web/src/lib/review-queue.ts`
- Review Queue feature components
- `apps/web/src/lib/work-items.ts`
- `apps/web/src/features/work-board/*`
- `apps/web/src/app/AppShell.tsx` or shared navigation helper

### Tests

- Approval queue item links to the owning work detail when thread exists.
- Attempt-specific failure links to attempt detail.
- Work Board card opens work detail, not raw run history, when thread exists.
- Queue cards do not duplicate the full evidence panel.

## V1H: i18n, Empty States, And Acceptance Tests

### Goal

Make V1 feel intentional across English and Chinese and lock the IA in tests.

### Scope

Update:

- i18n keys and Chinese strings;
- empty states for no threads, no attempts, no evidence, no diagnostics;
- e2e tests for default work-history flow;
- focused helper tests for derived turn grouping.

### Acceptance Flow

```text
open Work History
-> thread rail renders
-> select a thread
-> see Work detail
-> see objective and status
-> see attempts compactly
-> open evidence
-> raw diagnostics remain folded
-> preview resume still works
```

### Validation

Minimum commands for implementation PRs:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web test:e2e -- runtime.spec.ts
git diff --check
```

If the slice touches shared contracts or daemon routes, add:

```bash
corepack pnpm --filter @ling-stack/contracts build
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
```

## V2A: Durable LingTurn Contract

### Goal

Promote user intent from a derived UI grouping to a stable durable object.

### Trigger Conditions

Begin V2A only after at least one is true:

- multiple run attempts per user intent are common enough that derived grouping is
  fragile;
- Review Queue needs to link to a stable user-intent unit;
- resume/fork/search needs to anchor below thread level;
- thread history becomes hard to explain from runs alone.

### Proposed Contracts

Add shared contracts:

```text
packages/contracts/src/turns.ts
packages/core/src/run-types.ts
```

Proposed fields are defined in the main design. The first durable slice should keep
turn records small:

- id;
- workspaceId;
- threadId;
- kind;
- status;
- title;
- userInstruction;
- activeRunId;
- lastRunId;
- sourceTurnId;
- interventionId;
- timestamps.

Do not store raw model transcript, full logs, raw secrets, or large summaries in the
turn row.

### Store/API

Additive APIs:

```text
GET /threads/:threadId/turns?cwd=...
POST /threads/:threadId/turns?cwd=...
```

Run creation can accept optional `turnId` after the turn API exists.

### V2A-P0 Detailed Implementation Design

#### P0 Semantic Boundary

`LingTurn` is the durable work-intent unit inside a `LingThread`.

It is not:

- a chat message;
- a run attempt;
- a durable transcript table;
- a process-item/event log.

One normal chat message may create zero turns. One executable user instruction should
create one turn. A turn may have multiple linked run attempts. A run attempt should
belong to at most one turn in P0. Shared evidence should be referenced through
artifacts/actions later, not by linking one run to multiple turns.

P0 must preserve the current V2C-lite fallback: old runs without turns still group by
`RunSession.threadId` and render through the existing derived work cell.

#### P0 Non-Goals

- no fork/archive/pin APIs;
- no turn-linked resume semantics;
- no durable `LingTurnStep` or process item table;
- no thread metadata rebuild;
- no bulk historical backfill job;
- no raw model transcript, hidden reasoning, raw stdout/stderr, provider payload, or
  secret material in turn rows.

#### Contracts

Add contract types without changing existing run response shape by default:

```text
packages/contracts/src/turns.ts
packages/core/src/run-types.ts
packages/api-client/src/client.ts
```

P0 contract shape:

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
  readonly createdByActor: "local-user" | "system" | "teammate" | "automation";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

interface LingTurnRun {
  readonly turnId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly role: "primary" | "retry" | "resume" | "repair" | "validation";
  readonly createdAt: string;
}
```

Keep `summaryArtifactId`, `evidenceBundleArtifactId`, `parentThreadId`,
`parentTurnId`, and archived/pinned fields out of P0 unless the implementation needs
them for an already landed route. Those belong to V2B/V2D.

#### SQLite Migration

Add a new additive migration after `create_ling_threads`:

```text
create_ling_turns
```

SQL shape:

```sql
CREATE TABLE IF NOT EXISTS ling_turns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  user_instruction TEXT NOT NULL,
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
  created_by_actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE,
  FOREIGN KEY(source_turn_id) REFERENCES ling_turns(id) ON DELETE SET NULL,
  FOREIGN KEY(active_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL,
  FOREIGN KEY(last_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ling_turns_thread_updated
  ON ling_turns(thread_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ling_turns_workspace_status
  ON ling_turns(workspace_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ling_turns_source
  ON ling_turns(source_turn_id);

CREATE TABLE IF NOT EXISTS ling_turn_runs (
  turn_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(turn_id, run_id),
  UNIQUE(run_id),
  UNIQUE(turn_id, attempt_number),
  FOREIGN KEY(turn_id) REFERENCES ling_turns(id) ON DELETE CASCADE,
  FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ling_turn_runs_run
  ON ling_turn_runs(run_id);
```

Do not add `turn_id` to `run_sessions` in P0. The join table is the source for turn/run
ownership. A future explicit `run_sessions.turn_id` column is allowed only if query
pressure proves the join too expensive.

#### Store Methods

Add methods to `RunStore` and `SqliteRunStore`:

```ts
createLingTurn(input, now): LingTurn
getLingTurn(turnId): LingTurn | undefined
listLingTurns({ threadId, limit?, beforeUpdatedAt? }): LingTurn[]
linkRunToLingTurn({ turnId, runId, role, now }): LingTurnRun
getLingTurnForRun(runId): LingTurn | undefined
listLingTurnRuns(turnId): LingTurnRun[]
reconcileLingTurnStatus(turnId, now): LingTurn | undefined
```

Implementation rules:

- `createLingTurn` validates that the thread exists and is not archived.
- `linkRunToLingTurn` validates that the run exists and belongs to the same `threadId`.
- `linkRunToLingTurn` assigns the next `attemptNumber` in a transaction.
- `UNIQUE(run_id)` prevents ambiguous ownership.
- creating a turn and creating/linking its first run should happen in one store
  transaction when the same user action triggers both.
- failed run creation should not leave an orphan running turn.

#### Status Reconciliation

Reconciliation is explicit and read-derived from linked runs. It must not infer approval
authority or mutate run state.

P0 mapping:

```text
no linked runs -> open
latest active linked run queued/running -> running
any active linked run waiting_for_approval -> waiting_for_approval
latest terminal linked run succeeded -> succeeded
latest terminal linked run failed -> failed
latest terminal linked run cancelled -> cancelled
explicit redirect/intervention supersedes source -> superseded
```

Use linked attempt order first, then run `updatedAt`, to decide the latest attempt. Set:

- `activeRunId` to the latest queued/running/waiting run, otherwise null;
- `lastRunId` to the latest linked run;
- `completedAt` only for terminal statuses;
- `updatedAt` to reconciliation time.

`blocked` is reserved for explicit workflow or review-queue blockers. Do not derive
`blocked` from a failed run alone.

#### Write Paths

Create/link turns only at work-triggering boundaries:

- new task run: create an `initial_request` turn if the request has no `turnId`;
- channel executable message: create an `initial_request` or `manual_followup` turn under
  the active channel thread;
- queued follow-up: create a `queued_followup` turn with `sourceTurnId` when known;
- run retry for the same instruction: reuse the existing turn and link the new run as
  `retry`;
- continuation/resume-like run before V2D: link to the existing turn as `resume` only if
  the user intent is the same; otherwise create a new `manual_followup` turn;
- workflow step run: create a `workflow_step` turn owned by `workflowStepId`;
- automation work run: create an `automation_tick` turn owned by `automationId`;
- external work routed into Ling: create an `external_work_update` turn.

If the caller provides `turnId`, the daemon must verify:

- the turn exists;
- the turn belongs to the requested `threadId`;
- the turn belongs to the same workspace;
- the parent thread is not archived;
- cancelled or superseded turns are not reused unless the operation is an explicit
  retry/resume path.

#### API Scope

P0 adds only read/create/list turn APIs:

```text
GET /threads/:threadId/turns?cwd=...
POST /threads/:threadId/turns?cwd=...
```

`POST /threads/:threadId/turns` creates a turn record. It does not start a run by itself.
Run creation may accept optional `turnId` after store support exists.
The public create endpoint does not accept `status`, `activeRunId`, or `lastRunId`;
those fields are derived from run links by reconciliation.

Responses:

```ts
interface LingThreadTurnsResponse {
  readonly cwd: string;
  readonly threadId: string;
  readonly turns: readonly LingTurn[];
  readonly runLinks: readonly LingTurnRun[];
}
```

Do not change `GET /threads/:threadId/evidence` in P0. It may accept `turnId` only after
the turn/run link is used by Web or Work History.

#### Web Integration

P0 Web behavior should be conservative:

- Work cells may prefer `LingTurnRun` links when turn data is loaded.
- If no turn data is loaded or no run link exists, continue using
  `RunSession.threadId` grouping.
- The transcript still renders one compact result row by default.
- No fork/archive/pin UI depends on V2A-P0.
- Review Queue links may include `turnId` only when a source approval/action already has a
  known turn.

#### Implementation Files

Expected touch points:

- `packages/contracts/src/turns.ts`
- `packages/contracts/src/index.ts`
- `packages/core/src/run-types.ts`
- `packages/core/src/storage/sqlite-run-store.ts`
- `packages/core/test/*turn*.test.mjs` or nearby run-store tests
- `packages/daemon/src/features/runs/thread-routes.ts`
- `packages/daemon/src/features/runs/schemas.ts`
- `packages/api-client/src/client.ts`
- `apps/web/src/api/runs.ts`
- `apps/web/e2e/channel.spec.ts` only if Web consumes the new response in the same slice

#### V2A-P0 Acceptance

- migration creates `ling_turns` and `ling_turn_runs` on a fresh database;
- migration is idempotent on an existing database;
- creating/listing turns under a thread works;
- linking a run to a turn rejects cross-thread links;
- one run cannot be linked to two turns;
- attempt numbers are stable and monotonic per turn;
- status reconciliation follows linked run terminal/active state;
- new work-triggering runs can be created with a linked turn;
- legacy runs without turns still render through V2C-lite derived grouping;
- no raw transcript, hidden reasoning, stdout/stderr, provider payload, or secrets appear
  in turn rows, API JSON, logs, or Web state.

#### V2A-P0 Implementation Record

Implemented P0 as a daemon/core contract slice:

- added durable `LingTurn` / `LingTurnRun` contracts and api-client helpers;
- added SQLite migration `create_ling_turns` with `ling_turns` and `ling_turn_runs`;
- added `RunStore` methods for create/list/link/reconcile;
- linked new daemon `/runs` requests to a turn, with optional `turnId` reuse;
- added `GET/POST /threads/:threadId/turns?cwd=...`;
- kept Web rendering on the existing V2C-lite fallback for this slice.

Validation coverage:

- `packages/core/test/ling-turns-store.test.mjs` covers migration, linking, retry
  attempts, cross-thread rejection, one-run-one-turn ownership, legacy runs, status
  reconciliation, and secret redaction.
- `packages/daemon/test/ling-turns-api.test.mjs` covers daemon turn list/create APIs,
  automatic run-created turns, explicit `turnId` run reuse, public create ignoring
  derived status/run pointer fields, and API-level secret redaction.

### V2A-P1 Web Read-Only Detailed Design

#### P1 Goal

Use durable `LingTurn` / `LingTurnRun` data as the preferred read model for the existing
conversation work cell and Work History surfaces, while preserving the V2C-lite
run/thread fallback.

P1 should make Web able to answer:

- which durable turn a visible work cell represents;
- which run attempts belong to that turn;
- whether the turn is active, waiting, terminal, or open without guessing only from the
  latest run;
- whether a run is legacy/unlinked and should still render through existing
  `RunSession.threadId` grouping.

#### P1 Non-Goals

- no fork/archive/pin UI;
- no turn edit/delete APIs;
- no turn-linked resume behavior;
- no backfill job for historical runs;
- no new evidence browser;
- no new durable table or Web cache table;
- no approval decision controls inside `ConversationWorkCell`;
- no raw event stream, stdout/stderr dump, provider payload, transcript replay, hidden
  reasoning, or secret material in conversation state.

#### Existing Web Baseline

The current Web implementation already has the V2C-lite shape:

- `apps/web/src/lib/conversation-work-cell.ts` derives
  `ConversationWorkCellViewModel` from `RunSession.threadId`, approvals, artifacts, and
  optional execution actions.
- `apps/web/src/features/workspace/WorkspaceClientView.tsx` groups visible channel runs
  with `groupRunsByThreadId(channelRuns)` and renders one `ConversationWorkCell` for the
  anchor run.
- detail expansion calls `GET /threads/:threadId/evidence`.

P1 must extend this flow. It should not replace the component hierarchy or introduce a
second work-cell component.

#### Data Loading

Load turns lazily and only for thread ids already visible in the selected conversation.

Recommended first slice:

1. derive visible `threadId`s from `channelRuns`;
2. call `listLingThreadTurns(cwd, threadId, { limit })` for those ids;
3. store results in a local keyed state/cache:

```ts
type ThreadTurnsLoadState =
  | { readonly status: "not_loaded" }
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly turns: readonly LingTurn[]; readonly runLinks: readonly LingTurnRun[] }
  | { readonly status: "error"; readonly errorMessage: string };
```

Cache key:

```text
${cwd.trim()}::${threadId}
```

Invalidation:

- clear on `cwd` change;
- clear on selected channel change if visible thread set changes;
- refresh a thread after a run in that thread changes status, starts, completes,
  cancels, or enters `waiting_for_approval`;
- refresh after explicit `turnId` run creation response if the caller can identify the
  thread;
- do not block transcript rendering while turn data is loading.

Batching is not required in P1. If N visible thread ids creates too many requests, add a
daemon batch endpoint later; do not add it speculatively.

#### View-Model Merge

Add turn-aware input to the builder rather than building a separate renderer:

```ts
interface BuildConversationWorkCellInput {
  readonly threadId: string;
  readonly runs: readonly RunSession[];
  readonly turns?: readonly LingTurn[];
  readonly turnRunLinks?: readonly LingTurnRun[];
  // existing approvals/artifacts/actions fields remain unchanged
}
```

Builder rules:

- prefer `LingTurnRun` links when `turns` and `turnRunLinks` are loaded;
- group run attempts by `turnId` first, then by `RunSession.threadId` for legacy runs;
- choose the visible work cell anchor from the latest linked run attempt for the selected
  turn;
- if a linked run is not present in loaded `channelRuns`, keep the turn loaded but do not
  render a conversation work cell until its run is visible or evidence details are loaded;
- if no turn links exist for a thread, preserve existing V2C-lite grouping exactly;
- if turn loading fails, preserve existing V2C-lite grouping and surface the error only
  in details/debug affordances, not in the main transcript row.

Model field mapping:

- `id`: `work-cell:turn:${turn.id}` when linked turn data is used, otherwise current
  `work-cell:${threadId}`;
- `threadId`: always the parent thread id;
- `runIds`: linked run ids sorted by `attemptNumber`, then run activity;
- `anchorRunId`: latest visible linked run id;
- `status`: from `LingTurn.status` when available, otherwise latest run status;
- `mode`: active when turn status is `open`, `running`, `waiting_for_approval`, or
  `blocked`; completed when `succeeded`, `failed`, `cancelled`, or `superseded`;
- `title`: prefer `turn.title`, fallback to current run title logic;
- `summary`: derive from turn status and bounded evidence counts, never from raw logs;
- stats: show `Attempts` from linked attempts when available, otherwise run count.

`open` turns with no visible linked run should not render as a completed work result. P1
can either omit them from the conversation timeline or show them only in Work History
once that surface has a turn rail.

#### Details Loading

Keep `GET /threads/:threadId/evidence` as the only detail source in P1.

When expanding a turn-backed cell:

- fetch thread evidence using the existing detail loader;
- filter evidence rows to linked `runIds` client-side when the cell has loaded
  `LingTurnRun` links;
- if filtering produces no details, fall back to the existing thread-level evidence view;
- do not add `turnId` to evidence API in P1.

This keeps P1 read-only and avoids making evidence retrieval depend on the new turn table.

#### Work History Surface

Run History / Work History may consume turn data only as a display hint in P1:

- show attempts grouped under a turn when `listLingThreadTurns` is already loaded;
- otherwise keep the existing derived thread list;
- do not add fork/archive/pin controls;
- do not hide legacy runs;
- do not make resume depend on a turn id.

The first implementation can focus on the selected channel conversation and leave
dedicated Work History grouping for a follow-up P1b.

#### API/Error Semantics

Use the existing api-client helper:

```ts
daemonClient.listLingThreadTurns(cwd, threadId, { limit, beforeUpdatedAt })
```

Error handling:

- `404 thread_not_found`: drop cached turn state for that thread and fallback to derived
  run grouping;
- `400 bad_request`: keep fallback and expose error only in developer/debug surfaces;
- network failure: keep fallback and retry on next explicit refresh;
- empty `turns`: valid legacy state, not an error.

Security/privacy:

- the Web state may store only redacted `LingTurn` fields from API JSON;
- do not concatenate `userInstruction` into telemetry, browser logs, or raw debug text;
- do not pass `userInstruction` into artifact URLs or query params.

#### Implementation Files

Expected first-slice touch points:

- `apps/web/src/api/runs.ts`: export `listLingThreadTurns`;
- `apps/web/src/types.ts`: ensure `LingTurn`, `LingTurnRun`, and
  `LingThreadTurnsResponse` are exported through existing contract type plumbing;
- `apps/web/src/lib/conversation-work-cell.ts`: add optional turn-aware grouping and
  mapping while preserving fallback behavior;
- `apps/web/src/features/workspace/WorkspaceClientView.tsx`: load/cache turns for
  visible thread ids and pass them into the builder;
- `apps/web/e2e/support/mock-daemon.ts`: add
  `GET /threads/:threadId/turns?cwd=...` mock support;
- `apps/web/e2e/channel.spec.ts`: add one turn-backed work-cell case and one legacy
  fallback case.

Avoid touching global navigation, Review Queue mutation flows, provider settings, or
daemon/core storage in P1 unless a type mismatch requires a narrow fix.

#### Acceptance

- conversation work cells render from durable turn/run links when turn data is loaded;
- old runs with `threadId` but no turn links still render exactly through V2C-lite
  fallback;
- turn API loading/error states do not blank the transcript;
- a turn with multiple linked attempts renders one work cell with attempt count matching
  `LingTurnRun` links;
- active/waiting/terminal status follows `LingTurn.status` when present;
- detail expansion still uses thread evidence and filters to linked attempts when safe;
- no new mutation behavior is exposed in Web;
- no raw logs, provider payloads, transcripts, hidden reasoning, or unredacted secrets are
  stored or rendered by the P1 code path.

#### Test Plan

Unit-level:

- builder prefers `turn.title`, `turn.status`, and linked attempt count;
- builder falls back to run/thread grouping when `turns` is undefined, loading failed, or
  no links match visible runs;
- builder ignores links to runs not present in the loaded run set for transcript anchor
  selection;
- details filtering keeps only linked run ids and falls back when the filtered set is
  empty.

E2E/mock:

- mock daemon serves one thread with one `LingTurn` and two `LingTurnRun` attempts;
- channel feed shows one work cell, not two run rows;
- evidence expansion still opens existing grouped details;
- a legacy thread with no turns still shows the current work cell;
- simulated turn endpoint failure leaves the legacy work cell visible.

Manual smoke:

- start daemon/web;
- run a new task and verify `/threads/:threadId/turns` returns a linked turn;
- open the channel conversation and verify the work cell title/status comes from the turn;
- run an older legacy fixture and verify it still renders.

### Tests

- Create/list turns under one thread.
- New run attempt links to a turn.
- Existing runs without turns still render through derived fallback.
- Turn status follows run terminal state through explicit reconciliation only.

## V2B: Thread Metadata Read Model

### Goal

Make thread lists fast and stable without scanning every run/event/artifact on every
render.

### Scope

Add rebuildable metadata, not safety authority.

Candidate fields:

- summary;
- pinnedAt;
- lastTurnId;
- lastActivityAt;
- pendingApprovalCount;
- blockedCount;
- failedAttemptCount;
- artifactCount;
- latestFailureRunId;
- latestEvidenceArtifactId.

### Storage Options

Prefer this order:

1. `metadata_json` while field shape is changing.
2. Explicit columns for query-critical fields after usage stabilizes.
3. Rebuild command or startup reconcile if drift is detected.

### Tests

- Metadata can be rebuilt from source records.
- Stale metadata does not affect approval enforcement.
- Thread rail can render from metadata when present.
- Missing metadata falls back to derived counts.

## V2C: Conversation Work Cell

### Goal

Render work history inside the conversation timeline using the Codex-inspired turn
display model: active turns show sparse live item rows, and completed turns collapse into
a compact result summary with expandable grouped details.

### Scope

Use the V2 detailed design as the source of truth for the component model:

- active `ConversationWorkCell` mode with live item rows;
- completed `ConversationWorkCell` mode with result summary;
- grouped detail disclosure for Changed / Checked / Evidence / Attention;
- composer-adjacent temporary approval overlay for active permission requests;
- inline evidence summary and explicit raw diagnostics drill-down.

The first implementation may derive the view model from existing run/thread data. It
does not need a new durable turns table, real fork/resume behavior, shell snapshots, or a
new evidence browser.

Do not render raw event streams, stdout dumps, JSONL, provider payloads, or hidden
reasoning as the conversation body.

Do not render permission decision controls as normal transcript content. The active turn
stream may show a `waiting for approval` row, but the approve/deny/skip controls belong
in a temporary overlay above the conversation composer. Review Queue can still render
approval controls inline because it is an action queue.

### V2C-lite First Implementation Slice

V2C should start with a read-derived conversation work cell. This is an implementation
slice, not the full V2 durable-turn architecture.

Implement in this order:

1. Add a `ConversationWorkCellViewModel` builder.
2. Add presentation components for active and completed work cells.
3. Render completed thread/run work in the selected conversation surface.
4. Render sparse active rows from existing run status and auditable actions.
5. Add explicit links to Work History / evidence details for deeper inspection.
6. Add the composer approval overlay only when an existing approval source is available.

Do not include fork, archive, pin, durable turns, or turn-linked resume in this slice.

Implementation note for the first code slice:

- render a `ConversationWorkCell` only for channel runs with `RunSession.threadId`;
- keep legacy runs without `threadId` on the existing `Run event` surface;
- derive the workspace conversation cell from already-loaded channel runs, run artifacts,
  approvals, and optional execution actions when available to the builder;
- do not add a workspace-level evidence/action fetch just to render the first cell;
- use `Open run` as the first drill-down route, with Work History navigation reserved for
  a later navigation slice.

### V2C-lite Data Sources

Use only existing records:

- `LingThread` for thread identity, status, title, objective, channel ownership, and
  current/last run pointers;
- `RunSession.threadId` for grouping runs under a work thread;
- `GET /threads/:threadId/evidence` for runs, events, approvals, artifacts, execution
  actions, and workflow transitions;
- existing execution actions for sparse action rows;
- existing approval request state for `waiting for approval` and, later, the composer
  overlay;
- existing artifact metadata for evidence links.

No new durable table is required. No new run recovery authority is introduced. If the
derived view model cannot be built, the UI should fall back to the existing thread/run
detail link instead of inventing summary text.

### V2C-lite View Model

The view model should be small and presentation-oriented:

```ts
type ConversationWorkCellMode = "active" | "completed";

interface ConversationWorkCellViewModel {
  readonly id: string;
  readonly threadId: string;
  readonly runIds: readonly string[];
  readonly mode: ConversationWorkCellMode;
  readonly status: "running" | "waiting_for_approval" | "blocked" | "failed" | "succeeded" | "cancelled";
  readonly title: string;
  readonly summary: string;
  readonly stats: readonly ConversationWorkCellStat[];
  readonly groups: readonly ConversationWorkCellGroup[];
  readonly evidenceLinks: readonly ConversationWorkCellEvidenceLink[];
  readonly actions: readonly ConversationAction[];
}
```

The builder may derive:

- title from `thread.title`, then fallback to the latest run title/objective;
- summary from terminal state and bounded evidence counts, not from raw stdout;
- stats from run count, artifact count, approval count, failed action count, and latest
  activity time;
- groups from existing records using fixed labels: Changed, Checked, Evidence,
  Attention;
- actions from available navigation only: `Open details`, `Open Work History`, or
  `Resume` when the existing resume route already supports it.

Do not expose raw stdout, JSONL, provider payloads, hidden reasoning, or full runtime
event streams in the view model.

### V2C-lite Component Split

Suggested files can live under `apps/web/src/shared/conversation/` or a nearby feature
folder if the existing workspace surface needs tighter local wiring.

- `ConversationWorkCell` owns the outer transcript row and shared header/footer.
- `ActiveTurnItemStream` renders sparse running rows.
- `CompletedTurnSummary` renders the collapsed result row.
- `TurnItemGroupDisclosure` renders Changed / Checked / Evidence / Attention groups.
- `ConversationWorkCellEvidenceLink` renders attempts, artifacts, approvals, diffs,
  tests, and browser proof links.
- `ComposerApprovalOverlay` is a follow-up sub-slice unless current approval state can be
  wired without changing approval behavior.

The component should not look like a Work History card pasted into chat. It should be a
compact transcript-native work item: one visible summary row by default, with expansion
for grouped process evidence.

### V2C-lite Rendering Rules

Active work:

- show one work-cell row for the active thread/run;
- show only auditable action rows, status changes, approval wait state, and evidence
  milestones;
- do not stream raw logs into the transcript;
- when the run reaches a terminal state, collapse the active rows into the completed
  result summary.

Completed work:

- default to collapsed result summary;
- expanded state shows grouped details;
- evidence links open existing detail surfaces instead of creating a new evidence
  browser;
- raw diagnostics require an explicit drill-down or Work History detail view.

Approval requests:

- transcript row may say `Waiting for approval`;
- decision controls belong in a composer-adjacent temporary overlay;
- approval controls remain allowed inline in Review Queue because Review Queue is an
  action surface, not transcript history.

### V2C-P0a: Composer Approval Overlay

#### Goal

Let the user resolve active local runtime approvals without leaving the conversation,
while keeping approval controls out of durable transcript content.

#### Scope

Implement a temporary overlay above the active conversation composer.

Inputs:

- loaded `ApprovalRequest` records;
- active `cwd`;
- active channel id;
- active or visible run ids;
- optional active `threadId`;
- existing approve/deny callbacks and refresh flow.

Eligibility:

- include pending local runtime approvals owned by the active run, visible run, active
  channel, or active workflow step;
- include `runtime_permission_request`, `bash`, `edit`, `write`, local run-owned
  `mcp_tool_call`, and active `workflow_step`;
- exclude external work action approvals, media job approvals, credential/provider
  changes, and approvals whose owning run is no longer visible;
- use Review Queue as fallback for anything not safely classifiable as active local
  runtime approval.

UI:

- show one compact overlay row for one pending approval;
- show grouped count and highest risk for multiple pending approvals;
- expose `Approve`, `Deny`, and `Details`;
- do not implement `Approve all`;
- do not show decision controls inside `ConversationWorkCell`;
- remove overlay when the approval is resolved, expired, cancelled, or no longer belongs
  to the selected conversation.

State handling:

- keep resolving state per approval id;
- disable duplicate clicks while resolving;
- refresh approvals and run/thread state after resolve;
- ignore stale mutation results after `cwd`, channel, thread, or run selection changes;
- if the run still waits after approval disappearance, keep the work cell in attention
  state and route to Work History or Review Queue.

Suggested files:

- `apps/web/src/lib/inline-approvals.ts`
- `apps/web/src/shared/conversation/ComposerApprovalOverlay.tsx`
- `apps/web/src/features/workspace/WorkspaceClientView.tsx`
- `apps/web/src/i18n.tsx`
- `apps/web/e2e/channel.spec.ts`

No daemon route or migration is required for P0a.

#### Acceptance

- An active run approval appears above the channel composer.
- The transcript work cell only shows the waiting state, not decision controls.
- Approve/deny calls the existing approval resolution endpoint.
- Resolving one approval removes it from the overlay after refresh.
- Multiple pending approvals are grouped without `Approve all`.
- External work and media approvals stay in Review Queue.
- Switching channels or threads hides unrelated overlays.

Implementation note, 2026-06-08: P0a is implemented as a Web-only enhancement to the
existing `InlineApprovalStrip`. The component now renders with composer-overlay
semantics, sorts multiple local runtime approvals by risk then creation time, shows the
highest-risk approval as the primary blocker, keeps remaining local approvals behind a
details disclosure, and continues to resolve through the existing approval endpoint.
External work and media approvals remain excluded by `inline-approvals.ts`.

### V2C-P0b: Lazy Evidence Hydration

#### Goal

Keep conversation work cells cheap by default and fetch detailed evidence only when the
user expands a work summary.

#### Scope

Collapsed work cells use already loaded data only. Expanded work cells may load thread
evidence through the existing endpoint:

```text
GET /threads/:threadId/evidence?cwd=...
```

When durable turns exist later, this can narrow to `turnId`, but P0b must not require
new turn APIs.

Implementation rules:

- do not add a workspace-level evidence fetch during initial conversation render;
- do not add a durable evidence index/cache table;
- do not treat client cache as run recovery source;
- dedupe concurrent loads by `cwd + threadId`;
- cache loaded evidence only as disposable Web state;
- refresh or invalidate after run completion, approval resolution, artifact creation, or
  user retry/refresh;
- keep `Open run` as fallback when evidence loading fails.

UI states:

- not loaded: show collapsed summary and detail disclosure trigger;
- loading: keep summary stable and show loading row inside details;
- empty: show compact empty state without hiding attempt links;
- error: show retry and `Open run`;
- loaded: render Changed / Checked / Evidence / Attention groups.

Evidence mapping:

- file-change artifacts -> Changed;
- command/test/browser artifacts or action summaries -> Checked;
- artifacts, approvals, attempts, and state transitions -> Evidence;
- pending approvals, failed attempts, denied approvals, and failed actions ->
  Attention.

Privacy and raw diagnostics:

- show redacted summaries only;
- do not render hidden reasoning;
- do not render full stdout/stderr, raw event JSON, JSONL, or provider payloads in the
  conversation cell;
- use existing artifact preview/download or Attempt detail for deeper inspection.

Suggested files:

- `apps/web/src/lib/conversation-work-cell.ts`
- `apps/web/src/api/runs.ts`
- `apps/web/src/shared/conversation/ConversationWorkCell.tsx`
- `apps/web/src/features/workspace/WorkspaceClientView.tsx`
- `apps/web/src/i18n.tsx`
- `apps/web/e2e/channel.spec.ts`

No daemon route, durable table, PTY snapshot, or manual capture work is required for
P0b.

#### Acceptance

- Collapsed conversation work cells render without fetching thread evidence.
- Expanding a work cell fetches evidence at most once per active cache key.
- Loading, empty, error, and loaded states are visible and bounded.
- Evidence groups render after load.
- Raw diagnostics remain behind explicit deeper links.
- Failed evidence load does not break the conversation feed.

Implementation note, 2026-06-08: P0b is implemented as a Web-only lazy detail cache.
Collapsed conversation work cells continue to render from already loaded run, approval,
and artifact summaries. Expanding a cell calls the existing
`GET /threads/:threadId/evidence` endpoint, maps the response back into Changed /
Checked / Evidence / Attention groups, and caches the result in disposable front-end
state keyed by `cwd + threadId`. The cache is cleared when cwd, runs, approvals, or
artifact maps change. It is not durable state and is not used for run recovery or
approval authority.

### V2C-lite Deferred Items

Keep these out of the first implementation:

- durable `LingTurn` table;
- durable turn item table or rebuildable cache;
- `parentThreadId`, `parentTurnId`, `pinnedAt`, or lineage schema;
- `POST /threads/:threadId/fork`;
- `POST /threads/:threadId/archive`;
- `POST /threads/:threadId/pin`;
- channel work-thread tree;
- archive row action pattern;
- Work History lineage display;
- search across turn summaries;
- PTY snapshots and manual capture.

### Tests

- Completed work renders a collapsed conversation result summary.
- Running work renders sparse action rows for auditable actions.
- Active approval requests show a temporary composer-adjacent overlay.
- The transcript shows approval waiting state without embedding decision controls.
- Completion automatically collapses the active rows into a result summary.
- Expanding the summary shows grouped detail rows and evidence counts.
- Evidence rows link to attempts, artifacts, approvals, diffs, and browser/test proof.
- Raw diagnostics require explicit drill-down.

## V2D: Turn-Linked Resume, Fork, Search, And Archive

### Goal

Use durable thread/turn boundaries for higher-level work recovery.

### Scope

Add APIs only after V2A exists:

```text
POST /threads/:threadId/resume-preview?cwd=...&turnId=...
POST /threads/:threadId/resume?cwd=...&turnId=...
POST /threads/:threadId/fork?cwd=...
POST /threads/:threadId/archive?cwd=...
POST /threads/:threadId/pin?cwd=...
GET /threads?cwd=...&q=...
```

Rules:

- resume preview remains side-effect free;
- fork creates a child `LingThread` with clear parent lineage;
- fork keeps the child thread attached to the source channel by default;
- fork does not create/copy a channel and does not automatically archive the source
  branch;
- forked child threads appear in the current channel's sidebar work-thread tree and in
  Work History lineage;
- selecting a source or child thread from the channel tree switches the center
  conversation to that `LingThread`;
- a compact branch notice near the source turn may confirm creation, but it is not the
  primary navigation surface;
- archive hides by default but does not delete runs/evidence;
- archive uses Codex-style row actions: hover/focus reveals an archive icon, first click
  enters inline confirm state, confirmation hides the row from the default tree;
- archive confirmation is row-local and should not open a modal for ordinary channel-tree
  archive actions;
- pin and search use metadata/read models only;
- direct run APIs remain available.

### Tests

- Resume from a selected turn includes the intended prior context.
- Fork creates a child thread with `parentThreadId` / `parentTurnId` lineage.
- Forked child thread keeps the source `channelId`.
- Fork does not archive or hide the source thread.
- Source and child threads appear under the current channel's sidebar work-thread tree.
- Clicking a source or child tree row switches the center conversation.
- Optional source transcript branch notice does not duplicate the child transcript.
- Work History shows parent/child lineage for source and child threads.
- Archive hides thread from default list and preserves evidence.
- Channel tree rows reveal pin/archive actions on hover/focus.
- Clicking archive enters inline confirm state on the same row.
- Confirming archive hides the row from the default channel tree without deleting lineage.
- Search finds thread/turn titles and summaries without raw log search.

## PR Breakdown

Suggested PRs:

1. V1A labels and nav framing.
2. V1B/V1C thread-first rail and work detail shell.
3. V1D/V1E attempt hierarchy and evidence inspector.
4. V1F derived turn grouping helper and UI.
5. V1G Review Queue / Work Board links.
6. V1H e2e hardening and copy polish.
7. V2A durable turn contracts and store methods.
8. V2B metadata read model.
9. V2C conversation work cell.
10. V2D turn-linked resume/fork/search/archive.

Do not combine V2 durable schema work with V1 presentation refactors.

## Open Decisions Before V1 Implementation

- Should the nav label switch from `Runs` to `Work History` immediately or behind a
  temporary alias?
- Should the rail show thread rows only by default, or thread rows followed by a
  collapsed run-only fallback section?
- Should evidence open in the existing right drawer or inside the current run detail
  panel for the first slice?
- Should Review Queue links open Work History in-place or preserve the current page and
  show a drawer?

## Open Decisions Before V2 Implementation

- Should turns be created only for work-triggering intents or for all channel messages?
- Should teammate direct chat turns share `LingTurn` or remain private-message records?
- Should metadata begin as JSON or explicit columns?
- Should fork copy turns or parent-link them with evidence references?
- Should turn ids be assigned by Web for optimistic UI or only by daemon?
