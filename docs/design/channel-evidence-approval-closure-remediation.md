# Channel Evidence And Approval Closure Remediation

Status: implementation plan for P0-P2 remediation
Date: 2026-07-05

## Problem

Channel work currently exposes the same underlying work through several read models:

- approval requests;
- workflow and workflow-step status;
- browser evidence;
- proposed plan history;
- right-dock file/evidence projections;
- Team metrics in channel settings.

The failures are not copy issues. They are source-of-truth and projection-contract
failures. The repair must keep state transitions daemon-owned and keep UI counts derived
from one visible-evidence projection.

## Target Shape

```text
daemon-owned writes
  approval decision
  message/web evidence
  run artifacts
  proposed plans
    |
    v
canonical read projections
  approval owner closure
  visible evidence summary
  proposed plan source state
  dock evidence/file groups
    |
    v
Web UI
  no state guessing
  clickable source URLs
  explicit missing-source states
  grouped evidence by workflow/run/task
```

## P0 - Approval Owner Closure

Current behavior:

```text
POST /approvals/:id/approve
  -> approval.status = approved
  -> approval resolved event
  -> workflow/step stays waiting_for_approval until a later orchestrate tick
```

Required behavior:

```text
POST /approvals/:id/approve
  -> approval.status = approved
  -> syncApprovalOwnerForDecision()
       workflow_step pre gate:
         waiting_for_approval -> running
         clear activeGateStage
       workflow_step post gate:
         waiting_for_approval -> running -> succeeded
         attach output artifact when available
         complete workflow if all steps finished
       denied/expired:
         apply workflow step failure policy
  -> approval resolved event
  -> response already reflects closed owner state
```

Design rules:

- Approval remains the durable decision object.
- Workflow and workflow-step remain the durable execution state.
- Web must not infer owner status from approval status.
- The closure hook must be idempotent. Re-running it after restart or a later orchestrate
  tick must be harmless.
- Existing media job approval sync remains supported through the same route callback.

Tests:

- Approving a post-step workflow approval immediately clears the waiting state without a
  second orchestrate call.
- Denying a pre-step workflow approval immediately blocks/fails according to policy
  without a second orchestrate call.
- Existing restart reconciliation tests remain valid.

## P1 - Browser Evidence URLs

Current behavior:

- `DockEvidenceItem` has no URL fields.
- Browser evidence projection drops `source.url`, requested read URL, and `finalUrl`.
- Detail view cannot render a clickable source.
- Failed reads collapse into a generic failed row without the original URL.

Required contract:

```ts
DockEvidenceItem {
  href?: string;
  originalUrl?: string;
  finalUrl?: string;
  failureReason?: string;
  statusLabel?: string;
}
```

Projection rules:

- Web search source: `href = source.url`, `originalUrl = source.url`.
- Read URL: `originalUrl = readUrl.url`, `finalUrl = readUrl.finalUrl`,
  `href = finalUrl ?? originalUrl`.
- `available` maps to ready copy; `blocked` maps to failed copy; degraded parent evidence
  stays visible with status label rather than hiding sources.
- Failed rows still expose the raw requested URL.

UI rules:

- Detail view renders source links as anchors.
- If `finalUrl` differs from `originalUrl`, show both.
- Failure reason is explicit and visible.

## P1 - Proposed Plan Source State

Current behavior:

- Proposed plans keep `sourceMessageId`.
- List APIs do not say whether that message still exists.
- UI enables "Open source" whenever an id string exists.

Required behavior:

```ts
sourceMessageState?: "available" | "deleted" | "unknown";
```

Rules:

- Do not cascade delete proposed plans by default. Plans are audit and execution history.
- If a plan references a missing source message, preserve the plan and render
  "Source message deleted".
- Disable source navigation for deleted/unknown sources.
- Accept/save/archive actions stay available according to the existing plan status rules.

## P1 - Unified Evidence Count

Current behavior:

- Right Dock evidence count includes visible runs, approvals, browser evidence, and files.
- Settings Team Metrics count includes only `ChannelTeamEvidenceItem`.
- Both are labeled "evidence", so users see contradictory numbers.

Required behavior:

```text
visible evidence total =
  run evidence
  approval evidence
  browser evidence
  file/artifact evidence

team evidence submetric =
  team evidence
```

Rules:

- Settings "Evidence" uses the same visible count users see in the channel dock.
- The projection applies the same per-group Dock cap as the UI. Raw artifact/file totals
  may be higher, but Settings "Evidence" must match the visible Dock launcher count.
- Team-specific evidence remains visible as a submetric, labeled as team evidence or
  specialist evidence. It is carried in `countsByKind.team_evidence`, but it is not
  added to `totalCount`, otherwise Settings would show a higher number than the Dock.
- Shared projection logic should be pure and unit-tested.

## P2 - File And Evidence Dock Grouping

Current behavior:

- `DockFileItem` has name/path/kind/status only.
- Artifact projection flattens `artifactsByRun`.
- UI cannot group files by workflow, workflow step, task, or run.

Required model:

```ts
DockEvidenceOwnerScope {
  kind: "workflow" | "workflow_step" | "task" | "run" | "message" | "channel";
  id: string;
  label: string;
  statusLabel?: string;
  parentId?: string;
}

DockFileItem {
  ownerScope?: DockEvidenceOwnerScope;
}
```

Projection rules:

- Artifacts use `artifact.runId -> run.workflowStepId -> workflowStep.workflowId`.
- Message file refs use `message` scope when available.
- Attachments fall back to `channel` scope.
- Raw path is secondary metadata, never the grouping key shown first.

UI rules:

- Files page groups by owner scope first.
- Within each group, list files compactly with path as the secondary line.
- Existing flat file detail remains available when opening a row.

## Implementation Slices

1. Add this design doc.
2. P0 daemon owner closure and regression tests.
3. P1 browser evidence URL fields and detail rendering.
4. P1 proposed plan source state in contracts, API responses, and UI.
5. P1 visible evidence summary shared between Dock and Team Metrics.
6. P2 owner-scoped file grouping.

## Verification

Targeted commands:

```bash
corepack pnpm --filter @ling-stack/daemon build
corepack pnpm --filter @ling-stack/web typecheck
node --test packages/daemon/test/channel-workspace.test.mjs --test-name-pattern "workflow post-step gate|workflow approval denial"
```

Rendered validation:

- channel right dock browser evidence shows clickable ready and failed URLs;
- plan history shows "Source message deleted" for missing source;
- channel dock Evidence count matches Settings evidence count;
- files are grouped by workflow/run/task instead of raw path.
