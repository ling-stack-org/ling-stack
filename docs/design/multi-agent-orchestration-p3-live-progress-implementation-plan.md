# Multi-Agent Orchestration P3 Live Progress Implementation Plan

Status: implemented P3 Web presentation slice on 2026-06-09

Implemented scope:

- Added a workflow progress view model and adapter into the existing
  `ConversationWorkCellViewModel`.
- Shows one workflow-level live progress cell in the default channel feed.
- Suppresses represented workflow step/run noise in the default feed while preserving audit
  visibility under activity tooling.
- Adds workflow progress rows to the existing attention popover.

Deferred:

- A dedicated workflow detail drawer, explicit workflow evidence route, and richer packet
  summaries inside expanded evidence details.

Source design:

- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [Codex-Inspired Conversation Experience v1](codex-inspired-conversation-v1.md)
- [Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md)
- [Channel Workspace v1.25 Codex-Inspired Attention Popover](channel-workspace-v1.25.md)

## Purpose

This plan defines how to show active multi-agent workflow progress without rebuilding the
channel conversation surface.

The user should see work progressing while the workflow runs. After terminal state, the
work should fold into a compact summary with expandable evidence.

```text
running workflow
  -> one live progress object in the channel
  -> progress rows / attention popover
  -> right drawer detail
  -> terminal compact summary
  -> expandable evidence
```

## Guardrails

- Keep the existing Codex-inspired conversation components as the UI baseline.
- Do not rebuild `ConversationVirtualFeed`, `MessageRow`, or the channel feed layout.
- Do not add raw workflow/run/approval event spam to the main feed.
- Do not create a separate multi-agent transcript UI.
- Do not hide active work entirely until completion.
- Do not show raw ids or JSON in default copy.
- Do not change backend execution semantics in this UI slice.

## Existing Anchors

| Concern | Current code |
| --- | --- |
| Conversation work cell model | `apps/web/src/lib/conversation-work-cell.ts` |
| Work cell component | `apps/web/src/shared/conversation/ConversationWorkCell.tsx` |
| Summary row component | `apps/web/src/shared/conversation/ConversationSummaryRow.tsx` |
| Channel workspace assembly | `apps/web/src/features/workspace/WorkspaceClientView.tsx` |
| Channel activity derivation | `apps/web/src/lib/channel-activity.ts` |
| Activity drilldown | `apps/web/src/lib/channel-activity-drilldown.ts` |
| Attention progress popover | `apps/web/src/features/workspace/WorkspaceClientView.tsx` |
| Work item read model | `apps/web/src/lib/work-items.ts` |
| Workflow state | `ChannelWorkflow`, `ChannelWorkflowStep` from `apps/web/src/types.ts` |
| E2E channel checks | `apps/web/e2e/channel.spec.ts` |

Current Web already has:

- active/completed conversation work cells;
- active row streams inside `ConversationWorkCell`;
- attention popover progress rows;
- right drawer workflow/task/run detail surfaces;
- channel activity cards for workflow and workflow-step records.

P3 should aggregate these into a workflow-level live progress model and suppress duplicate
per-step noise in the default feed.

## Phase LP0: Baseline Verification

Type: read-only.

Before implementation, capture current behavior:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web test:e2e
```

Manual/browser checks:

- active run work cell is visible while a run is in progress;
- completed run work cell folds evidence by default;
- attention popover shows context, progress, and attention rows;
- opening the right drawer does not move the user out of channel context.

## Phase LP1: Workflow Progress View Model

Type: Web presentation model.

Add:

```text
apps/web/src/lib/workflow-progress.ts
apps/web/src/lib/workflow-progress.test.ts
```

Model:

```ts
export interface WorkflowProgressModel {
  readonly id: string;
  readonly workflowId: string;
  readonly mode: "active" | "completed";
  readonly status: ChannelWorkflow["status"];
  readonly title: string;
  readonly summary: string;
  readonly currentRows: readonly WorkflowProgressRow[];
  readonly stats: readonly WorkflowProgressStat[];
  readonly evidenceGroups: readonly WorkflowProgressEvidenceGroup[];
  readonly attention: "none" | "waiting" | "blocked" | "failed";
  readonly updatedAt: string;
}
```

Input:

```ts
interface BuildWorkflowProgressInput {
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly t: Translate;
}
```

Summary examples:

```text
Running: Engineer is implementing. 3 of 8 steps complete.
Waiting: QA is waiting for approval to write files.
Blocked: implementation blocked by missing provider capability.
Done: 8 steps complete, 4 artifacts captured.
Failed: implementation failed, 1 retry available.
```

Current rows should prefer user-visible work states:

1. blocked step,
2. waiting approval,
3. running step,
4. queued eligible next step,
5. completed count,
6. artifact count.

## Phase LP2: Reuse ConversationWorkCell

Type: Web component integration.

Do not create a new card component first. Instead, adapt `WorkflowProgressModel` into the
existing `ConversationWorkCellViewModel` shape.

Add:

```ts
export function workflowProgressToConversationWorkCell(
  model: WorkflowProgressModel,
): ConversationWorkCellViewModel;
```

or build directly:

```ts
export function buildWorkflowConversationWorkCellViewModel(...): ConversationWorkCellViewModel | undefined;
```

Rules:

- `mode === "active"` while workflow is `ready`, `running`, or `waiting_for_approval`;
- `mode === "completed"` for `succeeded`, `failed`, `blocked`, or `cancelled`;
- active rows show current teammate/step/progress;
- groups map to existing `changed`, `checked`, `evidence`, `attention`;
- evidence links point to packet/artifact ids where available.

This keeps the Codex-style active mutable cell behavior intact.

## Phase LP3: Default Feed Deduplication

Type: channel assembly logic.

Update:

```text
apps/web/src/features/workspace/WorkspaceClientView.tsx
```

Current channel feed may already include:

- chat messages,
- execution proposal cards,
- work cells by thread/run,
- activity-derived workflow cards.

P3 should avoid showing both a workflow-level cell and every linked step run cell as
separate default feed items.

Deduplication rule:

```text
if a workflow progress cell represents runIds [a, b, c],
then thread/run work cells for [a, b, c] should stay out of the default channel feed
but remain available through workflow evidence and right drawer drilldown.
```

Do not delete data or hide diagnostics globally. This is only default feed presentation.

## Phase LP4: Attention Popover Progress Rows

Type: presentation model extension.

Update the existing progress row builder in:

```text
apps/web/src/features/workspace/WorkspaceClientView.tsx
```

or extract to:

```text
apps/web/src/lib/channel-progress.ts
```

Add workflow progress rows:

```text
Architect is defining implementation boundary
Engineer is running implementation
QA is validating 2 checks
Blocked: waiting for approval to write files
Done: 3 steps completed, 1 artifact generated
```

Rules:

- progress rows are compact and icon-led;
- show at most one row per active workflow by default;
- if multiple workflows are active, show the highest-priority one and a count;
- click opens the workflow detail drawer, not raw runtime logs;
- approval/blocker states take priority over normal running states.

## Phase LP5: Right Drawer Evidence Entry

Type: detail routing.

Update existing workflow detail surface instead of adding a new overlay:

```text
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/lib/channel-activity-drilldown.ts
```

Right drawer should expose:

- workflow status and objective,
- steps with current teammate and status,
- context/output packet chips,
- linked runs,
- approval blockers,
- artifacts,
- raw evidence through existing run/thread/artifact routes.

P3 does not need the full selector/handoff evidence UI. It should reserve sections that P4
and P5 can populate later.

## Phase LP6: Copy And i18n

Type: copy-only.

Update:

```text
apps/web/src/i18n.tsx
```

Add user-facing strings for:

- `Work in progress`;
- `Workflow progress`;
- `{completed} of {total} steps complete`;
- `{teammate} is running {step}`;
- `Waiting for approval`;
- `Blocked by {reason}`;
- `{count} artifacts captured`;
- `Show evidence`.

Avoid raw status names in visible copy when a natural label exists.

## Phase LP7: Tests

Unit tests:

```text
apps/web/src/lib/workflow-progress.test.ts
```

Cases:

- active workflow with running step;
- waiting-for-approval workflow;
- blocked workflow;
- succeeded workflow with artifacts;
- failed workflow with failed step;
- multiple linked runs dedupe set;
- no raw ids in generated visible labels.

E2E tests:

```text
apps/web/e2e/channel.spec.ts
```

Cases:

- active workflow shows one live progress cell in Chat;
- active progress row updates when step status changes;
- terminal workflow folds into compact summary;
- expanding evidence shows step list and packet/artifact links;
- linked step run diagnostics remain reachable;
- attention popover shows workflow progress and opens drawer;
- no duplicate per-step run cells appear in default feed when workflow cell represents them.

## Non-Goals

- No backend graph implementation.
- No selector coordinator.
- No structured handoff intent.
- No new conversation feed architecture.
- No raw workflow event timeline in the default feed.
- No replacement of the right drawer.
- No visual redesign of v1.21/v1.25 layout.

## Validation

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web test:e2e
git diff --check
```
