# Review Queue and Work Board Detailed Design

## Status

**Global Work Board: pending development.**

The existing derived Work Board page is retained for contextual validation and future
iteration, but it is not currently exposed in primary navigation. Review Queue remains
active. Historical implementation anchors below describe the retained prototype, not
a generally released Work Board product.

This document defines the detailed product and implementation plan for Review Queue,
Global Work Board, and Channel Work Board. It is the external-work and multi-agent work
queue side of
[Work Board, Review Queue, and Inline Approval Boundaries](work-board-review-queue.md).

## Summary

Review Queue handles cross-context attention and routing. Global Work Board is the full
work ledger. Channel Work Board is the channel-filtered execution view.

```text
external event or cross-context item
-> Review Queue for triage or approval
-> route to channel, assignee, priority, or workflow
-> Global Work Board as the all-work ledger
-> Channel Work Board where channelId matches
-> task, run, approval, external work, action, and artifacts link over time
```

The first implementation should derive work rows from existing records. A durable
`work_items` table is a later slice, justified only when derived views cannot support
claim, heartbeat, retries, dependencies, and cross-channel routing cleanly.

## Related Docs

- [Work Board, Review Queue, and Inline Approval Boundaries](work-board-review-queue.md)
- [Inline Runtime Approval Detailed Design](inline-runtime-approval-detailed-design.md)
- [Work Board, Review Queue, and Inline Approval Implementation Plan](work-board-review-queue-implementation-plan.md)
- [External Work Orchestration](external-work-orchestration.md)
- [External Work Status Surface](external-work-status-surface.md)
- [Approval Policy](approval-policy.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)
- [Channel Workspace](channel-workspace.md)

## Current Implementation Anchors

| Area | Current anchor | Use in this slice |
| --- | --- | --- |
| Channel/task model | `packages/core/src/workspace-types.ts` | channel-bound tasks, workflows, workflow steps |
| External work records | `packages/core/src/external-work-types.ts` | imported GitHub/Linear work and scheduler state |
| External actions | `packages/core/src/external-work-actions.ts` | proposed external mutations and approval/execute lifecycle |
| Approval records | `packages/core/src/approval-types.ts` | pending external action approvals and fallback local approvals |
| Storage | `packages/core/src/storage/sqlite-run-store.ts` | existing durable task/run/workflow/approval/external-work tables |
| Web approvals | `apps/web/src/features/approvals/ApprovalsPage.tsx` | can evolve into Review Queue for cross-context attention |
| Web external work domain | `apps/web/src/domains/external-work/use-external-work-domain.ts` | external-work status, actions, CI triage state |
| Web channel workspace | `apps/web/src/features/workspace/ChannelTaskWorkspace.tsx` | target location for Channel Work Board tab/panel |
| App routing | `apps/web/src/app/view-types.ts`, `apps/web/src/app/lazy-pages.tsx` | existing `approvals` Review Queue surface and `work_board` top-level Work Board view |

## Goals

- Give external work a clear intake and routing surface.
- Give operators a global view of all work across channels.
- Give each channel a local execution board without creating per-channel data islands.
- Keep external action approval and execution separate.
- Link work items to tasks, runs, approvals, external work, actions, artifacts, and
  teammates.
- Start with derived views over existing records.
- Leave room for OpenClaw-style claim, heartbeat, attempts, proof, dependencies, and
  diagnostics in a later durable Work Board slice.

## Non-Goals

- No new approval engine.
- No Jira/Trello clone in the first slice.
- No external mutation from approval alone.
- No hidden scheduler auto-start.
- No per-channel durable board collections.
- No replacement for `WORKFLOW.md`.
- No migration away from the existing Ling kernel and embedded Pi runner backend.

## Product Surfaces

### Review Queue

Review Queue is the action-led triage surface.
The current Web IA exposes it as the sidebar `Inbox` / `收件箱` item while keeping
Review Queue as the product concept.

It should contain:

- unassigned or ambiguous external events;
- external action approvals;
- high-risk persistent external actions;
- offline or background approvals not visible inline;
- cross-channel handoff proposals;
- stale running or blocked work that needs operator attention.

It should not contain:

- every completed task;
- every normal running task;
- active local runtime approvals when the user is already in the active channel;
- Settings configuration.

### Global Work Board

Global Work Board is the all-work ledger.
The current Web IA exposes it as the top-level sidebar `Work Board` / `工作看板` item.
It is not a Model Workbench subview.

It should contain:

- all derived or durable work items;
- filters by channel, source, status, assignee, priority, label, and waiting reason;
- unassigned intake;
- cross-channel routing controls;
- stale/blocked diagnostics.

It is an operator surface. The daily user path should still be the channel workspace.

### Channel Work Board

Channel Work Board is the daily execution view for one channel.

It should contain:

- only items with `channelId = selectedChannelId`;
- tasks and workflow steps for the channel;
- external work linked to the channel;
- linked runs and current run status;
- local approvals as compact waiting indicators;
- external action approvals as links back to Review Queue;
- artifacts and proof links.

It should feel like each channel has its own board, while the data remains global.

## Derived Work Item Contract

The first slice should use a derived view model.

```ts
type WorkItemStatus =
  | "intake"
  | "triage"
  | "backlog"
  | "ready"
  | "running"
  | "waiting"
  | "review"
  | "blocked"
  | "done"
  | "archived";

type WorkItemSourceType =
  | "channel_task"
  | "channel_workflow"
  | "channel_workflow_step"
  | "external_work"
  | "external_work_action"
  | "approval"
  | "run"
  | "manual";

type WorkItemWaitingReason =
  | "approval"
  | "external"
  | "handoff"
  | "resource"
  | "user"
  | "scheduler"
  | "provider";

interface WorkItemView {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly sourceType: WorkItemSourceType;
  readonly sourceId: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly status: WorkItemStatus;
  readonly waitingReason?: WorkItemWaitingReason;
  readonly priority: "low" | "normal" | "high" | "urgent";
  readonly labels: readonly string[];
  readonly assigneeTeammateId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly externalWorkId?: string;
  readonly externalWorkActionId?: string;
  readonly approvalId?: string;
  readonly artifactIds: readonly string[];
  readonly proofArtifactIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

This view model can live in Web initially:

```text
apps/web/src/lib/work-items.ts
apps/web/src/features/work-board/
```

If the daemon later owns derivation, move the shared shape into `packages/contracts`
and expose it through API-client wrappers.

## Source Mapping

### Task

| Task field | Work item field |
| --- | --- |
| `task.id` | `sourceId`, `taskId` |
| `task.channelId` | `channelId` |
| `task.title` | `title` |
| `task.currentRunId` | `runId` |
| `task.assigneeTeammateId` | `assigneeTeammateId` |
| `task.status` | mapped `status` |

Suggested task status mapping:

| Task status | Work item status |
| --- | --- |
| `todo` | `backlog` |
| `running` or current run running | `running` |
| `blocked` | `blocked` |
| `review` | `review` |
| `done` | `done` |
| `failed` | `blocked` |
| `cancelled` | `archived` |

### Run

Runs should usually decorate task or workflow-step work items rather than create
standalone board cards. A standalone run work item is useful when a run has no task.

| Run status | Work item status |
| --- | --- |
| `queued` | `ready` |
| `running` | `running` |
| `waiting_for_approval` | `waiting` with `waitingReason: "approval"` |
| `succeeded` | `done` |
| `failed` | `blocked` |
| `cancelled` | `archived` |

### Approval

Approvals should decorate existing work items when possible.

Standalone approval work items are appropriate only when:

- the approval has no task/run/workflow/external-work owner visible in the current view;
- the approval is an external action review;
- the approval is an offline/background fallback.

External action approvals should always link to `externalWorkActionId`.

### External Work

Current external work records are channel-bound. Future intake can allow an unassigned
Review Queue item before a final `channelId` exists.

Derived mapping:

| External work field | Work item field |
| --- | --- |
| `externalWork.id` | `externalWorkId`, `sourceId` |
| `externalWork.channelId` | `channelId` |
| `externalWork.item.title` | `title` |
| `externalWork.item.labels` | `labels` |
| scheduler state | `status`, `waitingReason` |
| `workflowId`, `workflowStepId` | same |
| artifact ids | `artifactIds` |

### External Work Action

External work actions become Review Queue rows when they need approval or execution.

| Action status | Work item status |
| --- | --- |
| `proposed` | `review` |
| `waiting_for_approval` | `waiting` with `waitingReason: "approval"` |
| `approved` | `ready` |
| `executing` | `running` |
| `succeeded` | `done` |
| `failed` | `blocked` |
| `denied`, `expired`, `cancelled` | `archived` |
| `stale_target` | `blocked` |

## Review Queue Item Contract

Review Queue should use a narrower view on top of work items.

```ts
type ReviewQueueReason =
  | "route_external_work"
  | "approve_external_action"
  | "execute_approved_external_action"
  | "repair_blocked_work"
  | "offline_local_approval"
  | "handoff";

interface ReviewQueueItem {
  readonly id: string;
  readonly reason: ReviewQueueReason;
  readonly workItem: WorkItemView;
  readonly primaryAction:
    | "route"
    | "approve"
    | "deny"
    | "execute"
    | "open_channel"
    | "open_run"
    | "repair";
  readonly secondaryActions: readonly string[];
}
```

Review Queue should be sparse. It is a subset of the global board, not another copy of
all work.

## Navigation And Layout

### Suggested Navigation

First implementation:

```text
Sidebar
  Workspace
  Channels
  Review Queue
  Run History
  Settings
```

Global Work Board can initially live inside Workspace as a tab or secondary page if a
new top-level sidebar item makes navigation too heavy.

Channel Work Board should live inside the channel workspace:

```text
Channel page
  Conversation
  Work Board
  Runs / Artifacts drawer
```

### Review Queue Layout

Recommended sections:

```text
Header
  counts: route, approve, execute, blocked
Filters
  source, channel, reason, risk, age
Queue list
  compact rows with primary action
Detail drawer
  payload, evidence, target snapshot, links
```

Rows should be action-led, not card-heavy. External action rows should show:

- target repository/project;
- subject number or identifier;
- action kind;
- expected state snapshot;
- payload preview;
- linked approval status;
- execute availability after approval.

### Global Work Board Layout

Recommended first layout:

```text
Filter bar
Grouped list or compact columns
  intake
  ready
  running
  waiting
  review
  blocked
  done
Right drawer
  source links, run, approval, artifacts, diagnostics
```

Use grouped lists before drag-and-drop Kanban. Drag-and-drop adds complexity and is not
needed for the first operator value.

### Channel Work Board Layout

Recommended first layout:

```text
Channel header
  Work Board tab
Filter chips
  ready, running, waiting, review, blocked
Work item rows
  title, source, assignee, status, linked run, waiting reason, artifact count
Actions
  run, open run, open approval, open Review Queue, mark review/done where supported
```

Do not nest the board inside decorative cards. Use a full-width channel section with
compact rows or columns.

## Routing And Assignment

### Route External Work To Channel

First durable routing action can be narrow:

```text
POST /external-work/:id/route
{
  "channelId": "channel_...",
  "priority": "normal",
  "assigneeTeammateId": "teammate_..."
}
```

If current `ExternalWorkRecord` requires `channelId`, use a Review Queue wrapper for
unassigned intake until the external work record can be created safely.

Rules:

- Routing must be auditable.
- Routing should not automatically start a runner.
- Routing should preserve source idempotency keys.
- Routing should not mutate external systems.

### Move Work Between Channels

For task-backed work, moving channels should use existing task update behavior or a
future explicit move endpoint.

Rules:

- Preserve run history in the original audit trail.
- Do not move active running work without explicit confirmation.
- Cross-channel move should create a handoff event or decision record.

## Claim And Heartbeat Future Slice

OpenClaw's strongest Workboard idea is agent ownership with claim and heartbeat. Ling
should add that only after the derived board is useful.

Future fields:

```ts
interface WorkItemClaim {
  readonly ownerId: string;
  readonly token: string;
  readonly claimedAt: string;
  readonly lastHeartbeatAt: string;
  readonly expiresAt: string;
}

interface WorkItemAttempt {
  readonly id: string;
  readonly status: "running" | "succeeded" | "failed" | "blocked" | "stopped";
  readonly runId?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly error?: string;
}
```

Claim rules:

- ready work can be claimed by one teammate or scheduler at a time;
- heartbeat extends the lease;
- expired claims become stale diagnostics;
- retry budget prevents infinite loops;
- claim and heartbeat do not bypass approval policy.

## API Plan

### Slice 1: Derived Client Views

No new API required.

Use existing endpoints:

- channels and tasks;
- runs;
- approvals;
- external work;
- external work actions;
- CI triage records;
- artifacts.

Build `WorkItemView[]` in Web.

### Slice 2: Daemon View Facade

Add read-only endpoints when Web derivation becomes too duplicated:

```text
GET /review-queue?cwd=...&limit=...
GET /work-items?cwd=...&channelId=...&status=...&sourceType=...
GET /work-items/:id?cwd=...
```

These endpoints should derive from existing durable records. They should not require a
new table.

### Slice 3: Routing Mutations

Add narrow routing and assignment endpoints:

```text
POST /work-items/:id/route
PATCH /work-items/:id
```

Only expose operations that can be mapped safely to the backing entity.

### Slice 4: Durable Work Items

Introduce `work_items` only when the system needs durable features that cannot be
reliably derived:

- unassigned work independent of source tables;
- claim and heartbeat;
- dependencies;
- attempts and retry budget;
- durable board ordering;
- cross-channel work movement;
- stale diagnostics.

## Implementation Slices

### P0: Documentation And Naming

- Add the boundary and detailed design docs.
- Resolve UI naming: `Inbox` / `收件箱` is the short navigation label for Review Queue.
- Resolve IA placement: `Work Board` / `工作看板` is top-level navigation for Global
  Work Board.
- Treat Work detail as a contextual drawer opened from Work Board or Review Queue flows,
  not as a navigation item.
- Keep `ApprovalsPage` available as implementation anchor.

### P1: Review Queue From Existing Records

- Derive review queue rows from pending approvals, external work actions, stale CI
  triage, and blocked background work.
- Reuse `ApprovalCard` detail logic for external action payloads.
- Keep local active runtime approvals out of the queue unless backgrounded or offline.

### P2: Channel Work Board Derived View

- Add a Work Board tab or panel inside channel workspace.
- Derive rows from tasks, current runs, approvals, external work, external actions, and
  artifacts.
- Add filters for ready, running, waiting, review, and blocked.
- Link rows to run detail, approval detail, external work detail, and artifacts.

### P3: Global Work Board Derived View

- Add a top-level global board view with channel/source/assignee/status filters.
- Include unassigned intake if Review Queue wrappers exist.
- Add operator diagnostics for stale running and long-blocked work.
- Use a grouped ledger and contextual detail drawer before considering drag-and-drop or
  durable ordering.

### P4: Routing And Assignment

- Add route-to-channel and assignment actions where backing records support mutation.
- Record routing events or channel decisions.
- Keep external mutations separate from routing.

### P5: Durable Work Items And Agent Leases

- Add `work_items` persistence.
- Add claim, heartbeat, attempts, dependency links, proof, artifacts, and diagnostics.
- Add daemon-side stale recovery and retry budget.

## Test Plan

Core tests:

- status mapping from task/run/external action to work item;
- Review Queue excludes normal running/done work;
- external action approved state maps to executable Review Queue item;
- local inline-eligible approval appears in Review Queue only when backgrounded.

Daemon tests:

- read-only work-item facade returns stable derived ids;
- route-to-channel validates channel and source ownership;
- external action approval and execution remain separate.

Web tests:

- Review Queue renders external action approval with payload preview;
- approving an external action does not execute it;
- approved external action shows explicit execute action;
- Channel Work Board shows only selected channel items;
- Global Work Board can filter by channel and status;
- active local runtime approval is shown inline, not duplicated as the primary queue row.

## Acceptance Criteria

- Review Queue is sparse and action-led.
- Global Work Board shows all relevant work without duplicating durable records.
- Channel Work Board is a filtered view over the same work model.
- External work can be routed to a channel and then appears in that channel board.
- External action approval and execution remain separate.
- Local runtime permissions remain primarily inline.
- The first slice can ship without a `work_items` table.

## Resolved IA Decisions

- The navigation label is `Inbox` / `收件箱`, while the product concept remains Review
  Queue.
- Global Work Board is top-level navigation as `Work Board` / `工作看板`.
- Work detail is contextual UI, not a sidebar navigation item.
- Global Work Board does not belong under Model Workbench.

## Open Questions

- Should channel Work Board replace the existing task list, or live as a tab next to it?
- How much manual ordering is needed before durable `work_items.position` is justified?
- Should unassigned external work exist as a durable `work_item` before
  `ExternalWorkRecord` is created, or should the external-work schema allow nullable
  `channelId` in a future migration?
