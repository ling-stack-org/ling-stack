# Work Board, Review Queue, and Inline Approval Boundaries

## Status

Design plan with current Web IA implemented for the top-level Review Queue and Work
Board surfaces.

This document defines the product boundary between Codex-style local runtime
permission approvals, external-work review, the global Work Board, and channel-scoped
Work Board views.

The goal is to avoid three duplicate surfaces that all appear to be "approvals" while
still giving external work a durable routing and execution queue.

## Related Docs

- [Product Design](../product-design.md)
- [Approval Policy](approval-policy.md)
- [Codex-Inspired Runtime Tools P2A: Permission Requests Implementation](codex-inspired-runtime-tools-p2a-permission-requests-implementation.md)
- [Inline Runtime Approval Detailed Design](inline-runtime-approval-detailed-design.md)
- [Review Queue and Work Board Detailed Design](review-queue-work-board-detailed-design.md)
- [Work Board, Review Queue, and Inline Approval Implementation Plan](work-board-review-queue-implementation-plan.md)
- [Codex-Inspired Settings And Permission Presets](codex-inspired-settings-permission-presets.md)
- [External Work Orchestration](external-work-orchestration.md)
- [External Work Status Surface](external-work-status-surface.md)
- [Channel Workspace v1.25 Codex-Inspired Progress Popover](channel-workspace-v1.25.md)

## Problem

Ling Stack now has several concepts that can all produce "something needs attention":

- a local run needs permission to continue;
- a GitHub or Linear item enters external work;
- an external action proposes a comment, label, review, or future mutation;
- a channel task is blocked or waiting for review;
- a background run or workflow step is waiting for approval;
- an offline or background request accumulates while the user is elsewhere.

If all of these are surfaced as a generic Inbox approval, users cannot tell whether they
are granting immediate local authority, routing external work, reviewing an agent result,
or executing an external mutation.

## Core Decision

Use one durable approval system, but split the product surfaces by user intent.

```text
local runtime permission
-> inline approval near the active run or channel composer

external event or cross-context attention
-> Inbox / Review Queue for routing or review
-> top-level Work Board / Global Work Board as the full work ledger
-> Channel Work Board as the channel-filtered execution queue
```

Approval records remain the source of truth for human decisions. Inline approval,
Inbox, Global Work Board, and Channel Work Board are views over the same underlying
records and linked work entities. They must not create parallel approval systems.

## Product Vocabulary

### Inline Approval

Inline Approval is the primary surface for immediate local runtime permission requests.

It answers:

- "This run is blocked right now. Should it continue?"
- "Should this specific tool call, write scope, MCP tool, or runner capability be
  granted for this run or continuation?"

Inline Approval belongs near the active run, channel progress popover, or composer
context. It should feel close to Codex's permission prompt: fast, local, scoped, and
connected to the current execution.

### Inbox / Review Queue

Inbox is a review and routing queue, not the main permission UI.
In the Web sidebar, the short navigation label is `Inbox` / `收件箱`; the product
concept remains Review Queue.

It answers:

- "What needs human attention across the workspace?"
- "Which external event has not been routed yet?"
- "Which external action needs approval before it can mutate GitHub, Linear, or another
  external system?"
- "Which background or offline approval was missed in the active channel?"

Inbox can include pending approvals, but it should only include approvals that need
cross-context visibility, external action review, or offline catch-up.

### Global Work Board

Global Work Board is the full work ledger across channels and sources.
In the Web sidebar, this is a top-level `Work Board` / `工作看板` entry. It is not a
Model Workbench subview.

It answers:

- "What work exists anywhere in this workspace?"
- "Which items are unassigned?"
- "Which channel, teammate, run, approval, or external work record owns this item?"
- "What is blocked, running, ready, or waiting across all agents?"

The global board is a control surface for operators. It should not replace the daily
channel workspace.

### Channel Work Board

Channel Work Board is the channel-filtered execution queue.

It answers:

- "What work belongs to this channel?"
- "Which items are ready for an AI teammate or human to pick up?"
- "Which items are running, waiting, blocked, in review, or done?"
- "Which runs, approvals, artifacts, and external work records are linked to this
  channel's work?"

Users can think of every channel as having its own Work Board, but the implementation
should be a filtered view of the global work ledger rather than a separate data island.

## Surface Boundary

| Surface | Primary user intent | Typical contents | Not for |
| --- | --- | --- | --- |
| Inline Approval | Decide whether the current run can continue | `runtime_permission_request`, local tool approvals, active run gates | external-work triage, global queue browsing |
| Inbox / Review Queue | Review or route items that need attention | unassigned external work, external action approvals, offline pending approvals, high-risk persistent actions | normal running or completed work |
| Global Work Board | Coordinate all work across the workspace | all work items with filters by channel, source, assignee, status, priority | replacing channel work |
| Channel Work Board | Execute and hand off work inside one channel | channel-bound work items, tasks, runs, linked approvals, artifacts | cross-channel routing as the default mode |
| Run History | Audit what happened | run events, tool calls, approvals, outputs, artifacts | primary routing or queue management |
| Settings | Configure defaults | approval policy, provider setup, external-work setup, MCP tools | approving current tool calls |

## Flows

### Local Runtime Permission

```text
runner requests a capability expansion
-> daemon validates against current run snapshot and workspace policy
-> daemon creates an approval request
-> active run enters waiting_for_approval
-> inline approval appears near the run/channel context
-> user approves or denies
-> approved request materializes a run-scoped or continuation-scoped grant
-> run continues or queues a follow-up according to runner capability
```

Rules:

- Approval does not mutate workspace approval policy.
- A run-scoped grant is not a reusable workspace setting.
- The Inbox may show this request only as a fallback when it is offline, backgrounded,
  or no longer visible in the active channel.
- The Global Work Board may link to the request for audit and filtering, but it should
  not become the primary interaction for the active prompt.

### External Work Intake

```text
external event, poll, or import
-> normalized external work record
-> Inbox / Review Queue entry when routing or review is needed
-> user or rule assigns channelId, priority, assignee, or workflow
-> item appears in Global Work Board
-> item appears in Channel Work Board where channelId matches
-> channel task, workflow step, run, approval, and artifacts attach over time
```

Rules:

- External work may begin without a final channel assignment.
- Routing should be explicit and auditable when there is ambiguity.
- A channel-bound external work item should stop feeling like Inbox triage and start
  feeling like channel execution.
- `WORKFLOW.md` remains the repository-owned external-work contract.

### External Action Approval

```text
agent proposes external action
-> daemon writes action preview and evidence artifacts
-> approval request is created with externalWorkActionId
-> Inbox / Review Queue shows the external action review
-> user approves or denies
-> approved action still requires an explicit execute step
-> external action executor performs the external mutation
-> result is linked back to external work, channel work item, and run history
```

Rules:

- Approval and execution stay separate.
- External actions are more appropriate for Inbox / Review Queue than local inline
  approval because the decision mutates an external system and may outlive one run.
- Channel Work Board should show the waiting state and link to the review, not duplicate
  the entire approval UI.

## Work Item Model

The first implementation should be Ling-native. It should compose existing concepts
instead of copying OpenClaw's plugin store or creating a second orchestration database.

Recommended logical shape:

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
  | "manual"
  | "channel_task"
  | "channel_workflow_step"
  | "external_work"
  | "external_work_action"
  | "approval"
  | "run";

interface WorkItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly sourceType: WorkItemSourceType;
  readonly sourceId: string;
  readonly title: string;
  readonly summary?: string;
  readonly status: WorkItemStatus;
  readonly waitingReason?: "approval" | "external" | "handoff" | "resource" | "user";
  readonly priority: "low" | "normal" | "high" | "urgent";
  readonly assigneeTeammateId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly externalWorkId?: string;
  readonly externalWorkActionId?: string;
  readonly approvalId?: string;
  readonly artifactIds: readonly string[];
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

This shape is a product contract, not a required first migration. Early slices can derive
work items from existing task, run, workflow, approval, and external-work records before
introducing a durable `work_items` table.

## Status Semantics

Use `channelId` for assignment and status for lifecycle.

| Status | Meaning |
| --- | --- |
| `intake` | New item exists but needs classification or routing. |
| `triage` | A human or rule is deciding priority, channel, owner, or next action. |
| `backlog` | Accepted but not ready to execute. |
| `ready` | Ready for an agent or human to claim. |
| `running` | Claimed and actively being worked. |
| `waiting` | Blocked on approval, external state, handoff, resource, or user input. |
| `review` | Output exists and needs human or peer review. |
| `blocked` | Cannot continue without repair or a new decision. |
| `done` | Completed successfully or intentionally closed. |
| `archived` | Hidden from active boards but retained for audit. |

Do not overload `status` to mean "which channel owns this." Unassigned work should be
represented by `channelId` being absent, usually with `intake` or `triage` status.

## OpenClaw Patterns To Borrow

Ling should borrow OpenClaw's Workboard concepts selectively:

- card-like work items;
- statuses grouped by operational lifecycle;
- claim and heartbeat for agent-owned work;
- attempts and retry budget;
- proof and artifact links;
- dependency links;
- stale and diagnostic records;
- session or run handoff affordances.

Ling should not copy:

- a `sessionKey`-centric data model;
- plugin gateway storage as the main persistence boundary;
- a separate Workboard-specific approval system;
- a board per channel as separate durable collections.

Ling's equivalent linking fields should be `channelId`, `taskId`, `runId`,
`workflowStepId`, `externalWorkId`, `externalWorkActionId`, `approvalId`, and
`assigneeTeammateId`.

## UI Model

### Inbox / Review Queue

Inbox should be sparse and action-led:

- unassigned external events;
- pending external action approvals;
- offline or background approvals not visible in an active channel;
- high-risk persistent actions;
- cross-channel handoff proposals.

It should not list every normal `running`, `done`, or already channel-owned item.

### Global Work Board

Global Work Board should support:

- filters: channel, status, source, assignee, priority, label, waiting reason;
- bulk routing from unassigned to channel;
- links into channel, task, run, approval, external work, and artifacts;
- operator-level diagnostics for stale running items or unclaimed ready work.

This surface can be discoverable from navigation, but it should not become the homepage
or the only place to understand active work.

The first Web version uses a grouped ledger with a contextual detail drawer. The drawer
is opened from Work Board rows and Review Queue-style links; it is not a separate
navigation item.

### Channel Work Board

Channel Work Board should be the main daily execution view for agent work:

- only `channelId = currentChannelId`;
- quick status columns or grouped lists;
- claim/start/stop/review affordances when the linked entity supports them;
- compact approval chips that route to inline approval or Inbox detail;
- artifact and proof previews that route to the right drawer or run history.

The channel board can feel like "this channel's board" while still being backed by the
global ledger.

### Progress Popover

The channel progress popover should stay lightweight:

- show top active waiting items;
- link into the Channel Work Board, approval detail, or run drawer;
- avoid becoming a mini board or second Inbox.

## Implementation Slices

### Slice 1: Product Boundary And Derived Views

- Add the design doc.
- Use [Inline Runtime Approval Detailed Design](inline-runtime-approval-detailed-design.md)
  for the local active-run approval slice.
- Use [Review Queue and Work Board Detailed Design](review-queue-work-board-detailed-design.md)
  for the external-work and board slice.
- Use [Work Board, Review Queue, and Inline Approval Implementation Plan](work-board-review-queue-implementation-plan.md)
  to split this design into PR-sized implementation work.
- Keep existing approval, run, external-work, and task stores unchanged.
- Derive Inbox and board rows from existing records in the Web domain layer or daemon
  facade.
- Make UI labels reflect the boundary: Inline Approval, `Inbox` / `Review Queue`,
  top-level `Work Board` / `Global Work Board`, and Channel Work Board.

### Slice 2: Review Queue Routing

- Add a routing action for external work and cross-context items.
- Support assigning `channelId`, priority, labels, and assignee where the backing entity
  supports it.
- Keep approval resolution on the existing approval endpoints.

### Slice 3: Channel Work Board

- Add the channel-filtered board view.
- Link each card to task, run, approval, external work, action, and artifacts.
- Show `waiting` reason without duplicating approval execution flows.

### Slice 4: Global Work Board

- Add the global board view with filters and operator diagnostics.
- Support unassigned intake and cross-channel routing.
- Keep daily channel execution as the primary user workflow.

### Slice 5: Durable Work Items And Agent Lease

Introduce a durable `work_items` table only if derived views become insufficient.

Add:

- claim owner and lease token;
- heartbeat and expiry;
- attempt records;
- retry budget;
- dependency links;
- stale diagnostics.

This slice is where the strongest OpenClaw Workboard execution protocol becomes useful.

## Acceptance Criteria

- A local runtime permission request appears inline near the active run/channel, not only
  in Inbox.
- Approving a runtime permission request creates a scoped grant and does not mutate
  workspace approval policy.
- An external work item can appear in Review Queue before it is assigned to a channel.
- Assigning external work to a channel makes it visible in that channel's Work Board.
- The same item can be found in Global Work Board without duplicating durable records.
- External action approval and execution remain separate.
- Run History remains the audit surface, not the queue surface.
- Settings remains the default configuration surface, not the active approval surface.

## Non-Goals

- No Jira/Trello clone in the first slice.
- No separate approval engine for Work Board.
- No automatic external mutation from approval alone.
- No per-channel durable board islands.
- No hidden prompt injection to steer an active run.
- No migration from the embedded Pi runner backend to Codex app-server JSON-RPC.

## Resolved IA Decisions

- The Web sidebar uses `Inbox` / `收件箱` as the short label for Review Queue.
- The Web sidebar uses a top-level `Work Board` / `工作看板` entry for Global Work Board.
- Work detail is a contextual drawer inside Work Board or Review Queue flows, not a
  navigation item.
- Global Work Board does not live under Model Workbench.

## Open Questions

- Should unassigned external work be allowed to auto-route by `WORKFLOW.md`, or should
  v1 require explicit user routing when multiple channels match?
- Should runtime permission requests older than the active run remain visible inline,
  or only in Review Queue?
