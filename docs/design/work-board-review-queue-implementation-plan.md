# Work Board, Review Queue, and Inline Approval Implementation Plan

## Status

Implementation plan. Inline approval and Review Queue slices may remain active;
user-facing Channel and Global Work Board productization is **pending development**.
The existing Work Board prototype is retained behind contextual entry points, with its
left sidebar entry hidden as of 2026-07-28.

This document turns the boundary and detailed design docs into small implementation
slices. It should be used to create PRs or issues. It deliberately keeps Codex-style
local runtime approval separate from Review Queue and Work Board work.

## Related Docs

- [Work Board, Review Queue, and Inline Approval Boundaries](work-board-review-queue.md)
- [Inline Runtime Approval Detailed Design](inline-runtime-approval-detailed-design.md)
- [Review Queue and Work Board Detailed Design](review-queue-work-board-detailed-design.md)
- [Codex-Inspired Runtime Tools P2A: Permission Requests Implementation](codex-inspired-runtime-tools-p2a-permission-requests-implementation.md)
- [Approval Policy](approval-policy.md)
- [External Work Orchestration](external-work-orchestration.md)

## Implementation Order

```text
P1 Inline Runtime Approval
-> P2 Review Queue semantic split
-> P3 Channel Work Board derived view
-> P4 Global Work Board derived view
-> P5 Routing and assignment
-> P6 Durable work_items with claim and heartbeat
```

The order matters. P1 improves the active local permission experience without requiring
new board data. P2 prevents external-work review from being confused with local
permissions. P3 and P4 prove the board value with derived views. P6 is deferred until
derived views fail to support agent queue semantics.

## Shared Rules

- Reuse existing durable `ApprovalRequest` records.
- Do not add a second approval system.
- Do not mutate workspace approval policy when approving a run-scoped permission.
- Keep external action approval and external action execution separate.
- Prefer derived views before adding durable `work_items`.
- Keep `WORKFLOW.md` as the external-work source contract.
- Keep normal local runtime approvals close to the active channel/run.
- Keep Review Queue sparse and action-led.
- Keep Channel Work Board as a filtered view over global work.

## P1 Inline Runtime Approval

### Goal

Show active local runtime approvals near the current channel/run, matching the Codex
permission prompt model.

### Scope

Implement:

- inline approval eligibility helper;
- compact inline approval strip;
- runtime permission scope summary;
- composer or active channel placement;
- approve and deny using existing endpoints;
- fallback link to the full approval audit surface.

Do not implement:

- Review Queue rename;
- Work Board page;
- external action approval redesign;
- new daemon endpoints.

### Code Anchors

| Area | Files |
| --- | --- |
| Eligibility and summaries | `apps/web/src/lib/inline-approvals.ts` |
| Inline components | `apps/web/src/features/approvals/InlineApprovalStrip.tsx`, `RuntimePermissionScopeDelta.tsx` |
| Existing full card reuse | `apps/web/src/features/approvals/ApprovalCard.tsx` |
| Channel placement | `apps/web/src/features/workspace/ChannelTaskWorkspace.tsx` or the channel workspace shell that owns the composer |
| Domain data | `apps/web/src/domains/approvals/use-approvals-domain.ts`, run/channel domains |
| Core payload source | `packages/core/src/approval-types.ts`, `packages/core/src/runtime-permissions.ts` |

### Data Dependencies

Use existing loaded records:

- approvals;
- selected channel id;
- active run id;
- visible run ids;
- task current run id.

No schema change is required.

### User Flow

```text
run enters waiting_for_approval
-> Web sees pending approval with active run/channel ownership
-> inline strip appears above composer or in active run panel
-> user opens details or approves/denies
-> existing resolve endpoint updates approval
-> strip disappears after resolution
```

### Tests

- unit: local approvals are eligible, external action approvals are excluded;
- unit: runtime permission scope summaries render each request kind;
- e2e: active run pending approval appears inline;
- e2e: approve and deny call existing approval endpoint;
- e2e: external action approval does not appear as primary inline approval.

### Exit Criteria

- A local active pending approval can be handled without navigating to Approvals.
- Resolved approval remains visible in run/audit surfaces.
- No workspace approval policy mutation occurs.

## P2 Review Queue Semantic Split

### Goal

Turn the existing generic approval list into a Review Queue concept for cross-context
attention, while leaving active local runtime approval as an inline experience.

### Scope

Implement:

- navigation label and page title decision;
- Review Queue item derivation;
- explicit categories: route, approve external action, execute approved action, repair,
  offline local approval;
- local active inline approvals hidden or de-emphasized from the primary queue;
- external action approval rows keep approval and execute as separate actions.

Do not implement:

- Channel Work Board;
- Global Work Board;
- route-to-channel mutation unless already supported by backing records.

### Code Anchors

| Area | Files |
| --- | --- |
| View naming | `apps/web/src/app/view-types.ts`, sidebar/navigation files |
| Page component | `apps/web/src/features/approvals/ApprovalsPage.tsx` or future `features/review-queue/ReviewQueuePage.tsx` |
| Queue derivation | `apps/web/src/lib/review-queue.ts` |
| External action detail | `apps/web/src/features/approvals/ApprovalCard.tsx` |
| External work state | `apps/web/src/domains/external-work/use-external-work-domain.ts` |

### Data Dependencies

Use existing records:

- pending approvals;
- external work actions;
- external work records;
- CI triage records;
- runs and tasks for owner labels.

No schema change is required.

### Tests

- Review Queue includes external action approvals.
- Review Queue includes background/offline local approvals.
- Review Queue excludes active local approval when inline context is visible.
- Approving an external action does not execute it.
- Approved external action exposes a separate execute action.

### Exit Criteria

- Users can distinguish local runtime permission from external action review.
- The existing Approvals surface has a clear Review Queue role or a clear route to it.

## P3 Channel Work Board Derived View

### Goal

Add a channel-scoped board view that shows work belonging to the selected channel.

### Scope

Implement:

- derived `WorkItemView` model in Web;
- channel Work Board tab or panel;
- grouped rows for ready, running, waiting, review, blocked, done;
- links to task, run, approval, external work, action, and artifacts;
- compact waiting indicators for approvals.

Do not implement:

- global board page;
- drag-and-drop Kanban;
- durable `work_items`;
- claim and heartbeat.

### Code Anchors

| Area | Files |
| --- | --- |
| Derived model | `apps/web/src/lib/work-items.ts` |
| Channel board UI | `apps/web/src/features/work-board/ChannelWorkBoard.tsx` |
| Channel integration | `apps/web/src/features/workspace/ChannelTaskWorkspace.tsx` or channel shell |
| Styles | `apps/web/src/styles/workspace.css` or new scoped work-board CSS |
| Types | existing `apps/web/src/types.ts` until contracts are needed |

### Data Dependencies

Derive rows from:

- channel tasks;
- current runs;
- approvals;
- external work records;
- external work actions;
- artifacts;
- workflow steps when available in the client state.

### Tests

- selected channel shows only matching `channelId` rows;
- task statuses map to expected board statuses;
- run `waiting_for_approval` maps to `waiting` with `approval`;
- external action waiting maps to a linked Review Queue item;
- empty channel board renders a compact empty state.

### Exit Criteria

- Each channel has a visible Work Board surface.
- The board is useful without a new daemon endpoint or table.
- Local active approvals still prefer inline placement.

## P4 Global Work Board Derived View

### Goal

Add an operator-level global board for all work across channels.

### Scope

Implement:

- global Work Board route or Workspace subview;
- filters for channel, status, source, assignee, priority, waiting reason;
- grouped list view;
- row links to channel, run, approval, external work, and artifacts.

Do not implement:

- durable board ordering;
- bulk drag-and-drop;
- claim and heartbeat.

### Code Anchors

| Area | Files |
| --- | --- |
| App routing | `apps/web/src/app/view-types.ts`, `apps/web/src/app/lazy-pages.tsx`, sidebar navigation |
| Page UI | `apps/web/src/features/work-board/GlobalWorkBoardPage.tsx` |
| Shared rows | `apps/web/src/features/work-board/WorkItemRow.tsx` |
| Derived data | `apps/web/src/lib/work-items.ts` |

### Tests

- global board includes work across multiple channels;
- channel filter narrows rows correctly;
- status filter narrows rows correctly;
- row links navigate to the correct detail target.

### Exit Criteria

- Operators can see all active work without visiting every channel.
- The global page remains a view over existing durable records.

## P5 Routing And Assignment

### Goal

Let Review Queue and Global Work Board assign external or unassigned work to channels
and owners.

### Scope

Implement:

- route-to-channel action for supported records;
- optional priority, label, and assignee updates where backing entities support them;
- audit event or channel decision for routing;
- UI controls in Review Queue and Global Work Board.

Do not implement:

- external mutation;
- automatic runner start;
- durable `work_items` unless required by unassigned intake.

### API Options

Preferred narrow endpoint when backing entity is external work:

```text
POST /external-work/:id/route?cwd=...
{
  "channelId": "channel_...",
  "priority": "normal",
  "assigneeTeammateId": "teammate_..."
}
```

Generic future endpoint:

```text
POST /work-items/:id/route?cwd=...
```

Use the generic endpoint only after durable work items or a daemon work-item facade
exists.

### Tests

- route validates destination channel;
- route does not mutate external systems;
- route preserves source idempotency;
- routed item appears in Channel Work Board;
- route event is auditable.

### Exit Criteria

- External work can move from Review Queue into a channel board.
- Routing is explicit and recoverable.

## P6 Durable Work Items With Claim And Heartbeat

### Goal

Add a durable agent work queue only when derived views are not enough.

### Triggers For This Slice

Start P6 only if at least one of these becomes necessary:

- unassigned work needs to exist before an external-work record can be created;
- agents need durable claim and heartbeat independent of run state;
- retries and attempts need first-class board ownership;
- dependencies need to block claim;
- manual ordering must survive reloads;
- stale diagnostics cannot be derived reliably.

### Scope

Implement:

- `work_items` table;
- source links to existing records;
- claim owner, token, heartbeat, expiry;
- attempts and retry budget;
- dependency links;
- proof/artifact links;
- stale diagnostics and recovery.

### Non-Goals

- No approval bypass.
- No hidden external mutation.
- No second task system replacing channel tasks.

### Tests

- claim blocks second owner until lease expires;
- heartbeat extends lease;
- expired running item creates stale diagnostic;
- retry budget blocks infinite retries;
- dependency blocks claim until parent is done;
- approval policy still gates side effects.

### Exit Criteria

- Work Board can safely drive multi-agent queue execution.
- Durable work items remain linked to channel/task/run/external-work records instead of
  replacing them wholesale.

## Suggested PR Boundaries

| PR | Title | Main risk | Suggested validation |
| --- | --- | --- | --- |
| 1 | `feat: add inline runtime approval strip` | active approval eligibility | unit + channel e2e |
| 2 | `feat: clarify review queue approval surface` | confusing existing approvals UX | approvals e2e |
| 3 | `feat: add channel work board derived view` | status mapping drift | unit + channel e2e |
| 4 | `feat: add global work board derived view` | navigation and filtering | work-board e2e |
| 5 | `feat: route external work to channel board` | unsafe mutation boundary | core/daemon tests |
| 6 | `feat: add durable work item leases` | schema and recovery complexity | core/daemon/e2e |

Do not merge P3 and P4 into one PR unless the shared derived model is already tested.
Do not start P6 before P3 and P4 prove that derived views are insufficient.

## Verification Checklist

For every slice:

- run focused unit tests for changed helpers;
- run affected Web e2e specs;
- run `git diff --check`;
- verify no unrelated `logs/` or runtime artifacts are staged;
- update the relevant design doc if behavior changes.

For approval slices:

- confirm approval resolution uses existing endpoints;
- confirm workspace approval policy is unchanged;
- confirm external action approval does not execute external mutation.

For board slices:

- confirm channel filtering is based on `channelId`;
- confirm source links open the right detail surface;
- confirm completed normal work does not pollute Review Queue.
