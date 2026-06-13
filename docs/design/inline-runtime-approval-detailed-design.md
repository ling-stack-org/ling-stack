# Inline Runtime Approval Detailed Design

## Status

Design plan.

This document defines the Codex-style inline approval experience for local runtime
permission requests and active-run tool approvals. It is the detailed design for the
local approval side of
[Work Board, Review Queue, and Inline Approval Boundaries](work-board-review-queue.md).

## Summary

Local runtime approvals are immediate execution decisions. They should appear near the
active run or channel context, not primarily in Inbox.

```text
approval policy returns ask
-> daemon creates a durable approval request
-> active run enters waiting_for_approval
-> inline approval appears near the channel composer, progress popover, or run detail
-> user approves or denies
-> daemon resumes, blocks, or queues a continuation
```

The approval record remains durable. The inline surface is only the primary interaction
point for active local work.

## Related Docs

- [Work Board, Review Queue, and Inline Approval Boundaries](work-board-review-queue.md)
- [Work Board, Review Queue, and Inline Approval Implementation Plan](work-board-review-queue-implementation-plan.md)
- [Approval Policy](approval-policy.md)
- [Codex-Inspired Runtime Tools P2A: Permission Requests Implementation](codex-inspired-runtime-tools-p2a-permission-requests-implementation.md)
- [Codex-Inspired Settings And Permission Presets](codex-inspired-settings-permission-presets.md)
- [Channel Workspace v1.25 Codex-Inspired Progress Popover](channel-workspace-v1.25.md)
- [Codex-Like Execution Experience](codex-like-execution.md)

## Current Implementation Anchors

| Area | Current anchor | Use in this slice |
| --- | --- | --- |
| Approval type | `packages/core/src/approval-types.ts` | `runtime_permission_request`, local tool approvals, `runId`, `channelId`, `toolCallId` |
| Permission helpers | `packages/core/src/runtime-permissions.ts` | derive run-scoped grants from approved permission approvals |
| Approval storage | `packages/core/src/storage/sqlite-run-store.ts` | existing durable approval request lifecycle |
| Run state | `packages/core/src/run-types.ts` | `waiting_for_approval` and active run linkage |
| Web approval card | `apps/web/src/features/approvals/ApprovalCard.tsx` | reusable payload summaries and approve/deny behavior |
| Web approvals page | `apps/web/src/features/approvals/ApprovalsPage.tsx` | fallback and audit list, not primary active-run UX |
| Channel workspace | `apps/web/src/features/workspace/ChannelTaskWorkspace.tsx` | active task/run context where inline approval should appear |
| Attention popover | `docs/design/channel-workspace-v1.25.md` | compact channel-scoped attention entry point |

## Goals

- Make active local approval requests visible where the user is working.
- Preserve the existing durable approval system and audit trail.
- Keep local runtime approval separate from external action review.
- Let users approve or deny without navigating away from the active channel.
- Show scope deltas clearly before approval.
- Make high-risk approvals require an explicit reason and confirmation.
- Keep approved runtime permission grants scoped to the run or continuation.

## Non-Goals

- No new approval database.
- No mutation of workspace approval policy from a run approval.
- No hidden prompt injection into an active run.
- No full Work Board implementation in this slice.
- No external action execution from the inline prompt.
- No migration to Codex app-server JSON-RPC.
- No broad permission profile DSL.

## Eligible Inline Approvals

Inline approval should prioritize approvals that are both local and active.

Eligible by default:

- `runtime_permission_request`
- `bash`
- `edit`
- `write`
- local `mcp_tool_call` when it belongs to the active run and is not an external action
- workflow-step gates when the currently visible channel workflow is blocked on them

Not primary inline approvals:

- approvals with `externalWorkActionId`
- external sends or GitHub/Linear mutations
- paid media job approvals
- credential changes
- provider changes
- old approvals whose run is no longer active or visible

Those should remain visible in Review Queue or the existing approval audit page.

## Inline Surface Hierarchy

### 1. Channel Composer Strip

The composer strip is the primary active-channel prompt.

Placement:

```text
conversation / task context
-> progress or latest run summary
-> inline approval strip
-> composer input
```

Rules:

- Show only when there is at least one pending inline-eligible approval for the active
  channel or active run.
- Use one compact row for a single approval.
- Use a grouped row when multiple approvals are pending.
- Do not use a full card layout inside the composer area.
- Keep the row action-led: approve, deny, open details.

### 2. Channel Progress Popover

The progress popover should show current approval-needed progress rows, but not
duplicate the full approval card. Resolved approval history remains in Activity/audit
logs.

Rules:

- Show the top pending inline approval with action summary and risk.
- Link to the run drawer or approval detail for full payload.
- If approval action is high or critical risk, route to detail before final approval.
- Keep external action approvals labeled as Review Queue items, not inline run prompts.

### 3. Run Detail / Timeline

The run detail surface should show the durable approval event and payload.

Rules:

- Waiting runs should show a blocking approval panel near the latest event.
- Resolved approvals should remain in the run audit trail.
- The run detail can reuse `ApprovalCard` in compact mode for full payload display.

### 4. Review Queue Fallback

Review Queue can show inline-eligible pending approvals when the user is not in the
active channel or when the run was backgrounded.

Rules:

- The row should route back to the channel/run when possible.
- The page should label it as a local runtime approval, not an external action.
- It should not become the main interaction point for active local runs.

## Selection Logic

The Web domain should derive inline approvals from existing approval data before any
new daemon endpoint is added.

```ts
function isInlineApprovalCandidate(
  approval: ApprovalRequest,
  context: {
    readonly activeChannelId?: string;
    readonly activeRunId?: string;
    readonly visibleRunIds: readonly string[];
  },
): boolean {
  if (effectiveApprovalStatus(approval) !== "pending") {
    return false;
  }
  if (approval.externalWorkActionId || approval.mediaJobId) {
    return false;
  }
  if (!isInlineActionType(approval.actionType)) {
    return false;
  }
  if (approval.runId && approval.runId === context.activeRunId) {
    return true;
  }
  if (approval.runId && context.visibleRunIds.includes(approval.runId)) {
    return true;
  }
  return Boolean(approval.channelId && approval.channelId === context.activeChannelId);
}

function isInlineActionType(actionType: ApprovalActionType): boolean {
  return [
    "runtime_permission_request",
    "bash",
    "edit",
    "write",
    "mcp_tool_call",
    "workflow_step",
  ].includes(actionType);
}
```

This is intentionally conservative. External action approvals are excluded even if they
also have `channelId`.

## Information Design

### Compact Row

Required fields:

- action title;
- risk pill;
- owner label: run, task, channel, or workflow step;
- short scope summary;
- approve and deny actions;
- detail link.

Runtime permission request summary should show:

- request kind: core tool, write scope, MCP tool, or runner capability;
- requested scope;
- current scope summary;
- proposed continuation mode;
- reason supplied by the runner.

### Detail View

The detail view should show:

- full payload summary;
- current scope and requested scope diff;
- file paths, MCP server/tool names, or runner capability names;
- risk and approval policy reason;
- run, task, channel, and tool-call identifiers;
- audit JSON behind a disclosure.

High-risk and critical approvals must require:

- explicit decision reason before approval;
- second confirmation;
- clear copy that the decision is scoped to this run or continuation.

## Interaction Rules

### Approve

```text
user clicks approve
-> Web calls existing approval resolve endpoint
-> daemon resolves approval as approved
-> runtime permission grants are materialized from the approved record when applicable
-> active run resumes if the runner supports same-run continuation
-> otherwise a follow-up continuation is queued or shown as required
```

The UI must not update workspace Settings or approval policy after approval.

### Deny

```text
user clicks deny
-> Web calls existing approval resolve endpoint
-> daemon resolves approval as denied
-> active run receives denial or remains blocked according to runner bridge behavior
-> UI updates the run and approval strip
```

### Expire Or Cancel

Expired or cancelled approvals should leave the inline strip and remain in the run audit
trail. If the run still waits after expiry, the run should show a repair hint rather than
silently hiding the problem.

### Multiple Pending Approvals

When multiple local approvals are pending for the same active run:

- show a grouped strip with count and highest risk;
- display the first blocking approval inline;
- provide a detail list sorted by risk, then created time;
- do not allow "approve all" in the first slice.

## Component Plan

Recommended components:

```text
apps/web/src/features/approvals/
  InlineApprovalStrip.tsx
  InlineApprovalSummary.tsx
  RuntimePermissionScopeDelta.tsx

apps/web/src/lib/
  inline-approvals.ts
```

`InlineApprovalStrip` should depend on approval data and callbacks, not fetch data
itself. The domain controller keeps loading and resolving behavior centralized.

`ApprovalCard` remains the full audit component. It can be reused in drawer/detail
contexts, but it is too large for the composer strip.

## API Plan

### First Slice

No new daemon endpoint is required.

Use existing approval list and resolve endpoints:

```text
GET /approvals?cwd=...
POST /approvals/:id/approve?cwd=...
POST /approvals/:id/deny?cwd=...
```

The Web app derives inline candidates client-side from loaded approvals, active run, and
channel state.

### Later Slice

If polling or fan-in becomes noisy, add a daemon attention endpoint:

```text
GET /approvals/attention?cwd=...&channelId=...&runId=...
```

It should return view-ready approval references, not a new approval model.

## State And Recovery

Inline approval must tolerate:

- approval resolved from another surface;
- active run no longer present;
- run completed while approval was visible;
- approval expired;
- stale SSE state;
- duplicate click while resolve is in flight.

UI behavior:

- disable actions while resolving;
- refresh approval and run state after resolve;
- remove non-pending approvals from inline strip;
- show resolved state briefly only in detail surfaces, not as a persistent composer row;
- route stale or missing run cases to Review Queue or Run History.

## Test Plan

Unit tests:

- inline approval eligibility excludes external action approvals;
- runtime permission request scope summary renders all four request kinds;
- high-risk approvals require a reason and second confirmation;
- multiple pending approvals sort by risk and age.

Web integration tests:

- a pending active run approval appears above the channel composer;
- approving it calls the existing approval endpoint;
- denying it removes the inline strip and updates run state;
- external action approvals appear in Review Queue, not the inline strip;
- background approvals are still reachable from Review Queue.

Daemon tests:

- approved `runtime_permission_request` creates a run-scoped or continuation-scoped
  grant;
- approval resolution does not mutate workspace approval policy;
- denied permission request fails closed.

## Acceptance Criteria

- Active local approvals are visible without leaving the channel.
- Review Queue is not required for normal active run approval.
- Existing `ApprovalRequest` records remain the durable source of truth.
- External action approvals are not shown as normal local runtime prompts.
- Approving a runtime permission request does not change Settings approval policy.
- Resolved approvals remain visible in Run History.

## Open Questions

- Should the composer strip appear only for the selected task/run, or for any active run
  in the current channel?
- Should `workflow_step` approvals appear inline when they are pre-run gates, or only in
  workflow detail?
- Should `mcp_tool_call` approvals always be inline when run-owned, or should high
  side-effect MCP tools route to Review Queue by default?
