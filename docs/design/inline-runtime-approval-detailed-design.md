# Runtime Approval Dialog Detailed Design

## Status

Active contract. The earlier composer-strip interaction is superseded by the blocking
dialog contract below. Inline transcript history remains valid, but the Composer does
not own pending approval decisions.

This document defines the shared runtime approval dialog for local permission requests
and active-run tool approvals. It is the detailed design for the local approval side of
[Work Board, Review Queue, and Inline Approval Boundaries](work-board-review-queue.md).

## Summary

Local runtime approvals are immediate blocking decisions. Channel, normal conversation,
and teammate private chat use one dialog queue outside the transcript and Composer.

```text
approval policy returns ask
-> daemon creates a durable approval request
-> active run enters waiting_for_approval
-> the owning conversation surface opens the blocking approval dialog
-> user approves or denies
-> daemon resumes, blocks, or queues a continuation
```

The approval record remains durable. The dialog is only the active decision surface;
compact resolved status and history remain attached to the owning transcript/run.

## Related Docs

- [Work Board, Review Queue, and Inline Approval Boundaries](work-board-review-queue.md)
- [Approval Policy](approval-policy.md)
- [Codex-Inspired Runtime Tools P2A: Permission Requests Implementation](./codex-inspired-runtime-tools.md)
- [Codex-Inspired Settings And Permission Presets](codex-inspired-settings-permission-presets.md)
- [Conversation Surface Contract](./conversation-surface-contract.md)
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
| Attention popover | `docs/design/conversation-surface-contract.md` | compact channel-scoped attention entry point |

## Goals

- Make active local approval requests visible in all three conversation surfaces.
- Preserve the existing durable approval system and audit trail.
- Keep local runtime approval separate from external action review.
- Let users approve or deny without navigating away from the active conversation.
- Show one human-readable action sentence before approval.
- Keep the decision surface to the action plus explicit allow and deny commands.
- Keep approved runtime permission grants scoped to the run or continuation.

## Non-Goals

- No new approval database.
- No mutation of workspace approval policy from a run approval.
- No hidden prompt injection into an active run.
- No full Work Board implementation in this slice.
- No external action execution from the inline prompt.
- No migration to Codex app-server JSON-RPC.
- No broad permission profile DSL.

## Eligible Dialog Approvals

The dialog queue should prioritize approvals that are both local and active.

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

## Decision Surface Hierarchy

### 1. Shared Blocking Dialog

`RuntimeApprovalDialogQueue` is the primary prompt for channel, normal conversation,
and teammate private chat.

Placement:

```text
active conversation surface
-> shared dialog queue
-> one pending approval decision
```

Rules:

- Show only when there is at least one pending eligible approval owned by the active
  surface.
- Sort with the existing risk-first, oldest-first selection logic and show one approval
  at a time.
- Prevent Escape and outside-click dismissal while an approval is pending. The user must
  approve or deny.
- Keep allow and deny as separate actions for every eligible risk level. The shared
  runtime dialog does not collect a decision reason or open a second confirmation.
- After a successful decision, remove that item and open the next eligible approval.
- A mutation failure keeps the same dialog open with retry feedback.
- If a task proposal dialog is also eligible, keep it suspended until the blocking
  runtime approval queue is empty so only one modal owns focus.
- The dialog is mounted outside virtual feeds and Composer geometry.

### 2. Compact Transcript And Progress Status

Transcript cells and progress surfaces show compact immutable approval status, but do
not duplicate decision controls while the dialog is active. Resolved approval history
remains in Activity/audit logs.

Rules:

- Treat every pending approval selected by `RuntimeApprovalDialogQueue` as
  `dialog_owned_pending`. The dialog is the only surface allowed to render its decision
  controls, payload-derived operation rows, and approval evidence while it is pending.
- Project one non-interactive transcript marker for the owning Run, using the same
  localized action sentence as the dialog, for example `Waiting for approval: Run
  command: pwd`.
- A `dialog_owned_pending` marker cannot expand. It must not expose approval titles,
  permission enums, request ids, evidence groups, or internal English lifecycle labels.
- Do not force the owning WorkCell open merely because its Run status is
  `waiting_for_approval`.
- Route explicit review actions to the same dialog or durable approval detail.
- Keep external action approvals labeled as Review Queue items, not inline run prompts.
- After resolution, remove dialog ownership. Approved Runs resume their normal operation
  projection; denied, expired, and failed approvals render one compact immutable result.
- Preserve the complete approval payload and decision history in Run detail and audit
  projections. Compacting the transcript never deletes durable data.

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

Runtime permission request summary must be one localized sentence that names the acting
Agent and the exact user-relevant action or target, for example `Engineer wants to run
pwd` or `Ling Agent wants to edit src/App.tsx`. It must not expose Run ids, absolute
workspace paths, raw payloads, queue counts, policy deltas, technical metadata, or a
decision-reason field.

The durable approval record remains the audit interface for full payload, policy context,
risk, actor, timestamps, and any historical decision reason. Mutation failures are the
only additional body content allowed in the active dialog and remain visible for retry.

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

When multiple local approvals are pending for the same active surface:

- open one decision at a time;
- sort by risk, then created time;
- advance only after the current decision resolves;
- do not provide "approve all".

## Component Plan

Recommended components:

```text
apps/web/src/features/approvals/
  RuntimeApprovalDialogQueue.tsx
  RuntimePermissionScopeDelta.tsx

apps/web/src/lib/
  inline-approvals.ts
```

`RuntimeApprovalDialogQueue` depends on view data and callbacks, not fetch logic. The
domain controller keeps loading, mutation, refresh, and stale-state behavior centralized.

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

The dialog queue must tolerate:

- approval resolved from another surface;
- active run no longer present;
- run completed while approval was visible;
- approval expired;
- stale SSE state;
- duplicate click while resolve is in flight.

UI behavior:

- disable actions while resolving;
- refresh approval and run state after resolve;
- remove non-pending approvals from the dialog queue;
- show resolved state briefly only in detail surfaces, not as a persistent composer row;
- route stale or missing run cases to Review Queue or Run History.

## Test Plan

Unit tests:

- dialog approval eligibility excludes external action approvals;
- runtime permission request scope summary renders all four request kinds;
- low, medium, high, and critical eligible approvals use the same direct allow/deny
  interaction without a reason field;
- multiple pending approvals sort by risk and age.

Web integration tests:

- a pending active run approval opens outside the Composer on channel, normal
  conversation, and teammate private chat;
- approving it calls the existing approval endpoint;
- denying it removes the dialog item and updates run state;
- multiple approvals advance one at a time in risk/time order;
- Escape and outside click cannot dismiss a pending decision;
- opening or resolving a dialog does not change Composer geometry;
- external action approvals appear in Review Queue, not the inline strip;
- background approvals are still reachable from Review Queue.

Daemon tests:

- approved `runtime_permission_request` creates a run-scoped or continuation-scoped
  grant;
- approval resolution does not mutate workspace approval policy;
- denied permission request fails closed.

## Acceptance Criteria

- Active local approvals are visible without leaving the owning conversation.
- Channel, normal conversation, and teammate private chat use one dialog behavior.
- Pending decisions never resize or displace the Composer or virtual feed.
- Review Queue is not required for normal active run approval.
- Existing `ApprovalRequest` records remain the durable source of truth.
- External action approvals are not shown as normal local runtime prompts.
- Approving a runtime permission request does not change Settings approval policy.
- Resolved approvals remain visible in Run History.

## Locked Decisions

- The active surface owns only approvals already selected by the existing eligibility
  logic; no new cross-workspace fan-in is introduced.
- `workflow_step` and local `mcp_tool_call` keep their existing eligibility rules.
- Runtime decisions are blocking and non-dismissible; task proposal dialogs are a
  separate, dismissible product surface.
