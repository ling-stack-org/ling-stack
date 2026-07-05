# Product Status Semantics P5 Follow-up

## Related Docs

- [Product UX System P5](product-ux-system-p5.md)
- [P5 Next Inventory](product-ux-system-p5-next-inventory.md)
- [P5 Status Semantics Implementation Plan](product-status-semantics-p5-followup-implementation-plan.md)
- [Media And Automations Workbench Refinement](media-automations-workbench-refinement.md)

## Summary

This follow-up fixes a remaining P5 product-language gap in two operational surfaces:
Image Generation and Automations. Both surfaces already adopted shared P5 components,
but their first-screen status summaries still mix stored runtime states with user-facing
decision states.

The goal is to make the UI answer what the user can do next:

- Image Generation: which tasks are generating now, which can be started or retried,
  which need attention, and which already produced usable results.
- Automations: which automation definitions are enabled or paused, which scheduled
  automations the scheduler is watching, and which recent runs need attention.

This is a product semantics correction, not a backend behavior change.

## Problem Statement

### Image Generation

The current page can summarize tasks as historical tasks plus active tasks while some of
those "active" items are only stored as `queued` or legacy `waiting_for_approval`.
Those tasks are runnable, but they are not necessarily generating now. Users can read
that as a stuck queue.

The same mismatch appears in row and detail actions: a task can be labelled ready or
active while the button says Run. The UI should separate "ready to start" from "running".

### Automations

The Automations page can show the scheduler as running and watching `0` enabled
schedules while the page also shows enabled automations and failed state. This is
technically correct when the enabled automation is manual-only, but it creates product
friction because "enabled automation" and "enabled schedule" look interchangeable.

The UI must distinguish three concepts:

- automation definitions: enabled, paused, archived, or error;
- scheduler watching: enabled definitions with a schedule trigger;
- run health: queued/running/succeeded/failed recent runs and drafts waiting for
  confirmation.

## Product State Model

### Image Generation Product Buckets

Stored media job status remains unchanged. Primary UI maps stored status and artifact
state into product buckets:

| Product bucket | User meaning | Stored state / condition |
| --- | --- | --- |
| `generating` / 正在生成 | Real generation is currently in progress. | `status === "running"` or the current `runningJobId` matches the task. |
| `ready_to_start` / 可开始 | The task exists and can be started. | `status === "queued"` or legacy `status === "waiting_for_approval"`. |
| `needs_attention` / 需处理 | The previous attempt failed, was cancelled, or returned no usable result. | `failed`, `cancelled`, non-empty `errorMessage`, or expected media artifacts are missing. |
| `completed` / 已完成 | The task produced usable media results. | `succeeded` and at least one image/video artifact is available. |
| `unknown` / 未确认 | The stored data is incomplete or contradictory. | Anything not covered above; should be rare and conservative. |

Rules:

- `queued` is not "in progress" in primary UI. It is "ready to start".
- Legacy `waiting_for_approval` remains runnable and should not route users to Inbox.
- A succeeded task with missing usable media should be `needs_attention`, not completed.
- Header counts should use product buckets, not raw stored status names.
- Product bucket precedence is fixed: current `runningJobId` or stored `running`, then
  failed/cancelled/error/missing artifact, then succeeded with media artifact, then
  queued/legacy waiting, then unknown.
- The product filter set is `all`, `ready_to_start`, `generating`, `needs_attention`,
  and `completed`. `unknown` appears only in All and should stay conservative.
- The feature helper owns the mapping. Shared P5 components receive labels, status
  classes, disabled reasons, and actions; they do not import media domain logic.

Implementation helper contract:

```ts
type MediaJobProductState =
  | "ready_to_start"
  | "generating"
  | "needs_attention"
  | "completed"
  | "unknown";

type MediaJobProductFilter =
  | "all"
  | "ready_to_start"
  | "generating"
  | "needs_attention"
  | "completed";
```

Helpers live in `media-job-view-models.ts`:

- `deriveMediaJobProductState({ job, artifacts, runningJobId })`
- `summarizeMediaJobs({ jobs, artifactsByJob, runningJobId })`
- `mediaJobMatchesProductFilter({ job, artifacts, runningJobId, filter })`
- `mediaJobPrimaryActionView({ job, artifacts, isLoading, isRunning })`

### Image Generation Labels And Actions

Primary labels:

| Context | Label |
| --- | --- |
| Header summary | Available generation models, total tasks, generating now, ready/needs attention. |
| Filter labels | All, Ready to start, Generating, Needs attention, Completed. |
| Ready task button | Start generation / 开始生成 |
| Failed/cancelled/missing-result task button | Retry generation / 重试生成 |
| Running task button | Generating / 生成中 |
| Completed task button | No primary Run button; keep view/copy/open result actions or show a disabled reason. |

Disabled reasons must say why the action is unavailable. Avoid generic "cannot run while
task is status" wording in primary UI.

Completed generation tasks are terminal result records. Re-running from a completed row
is intentionally not a primary action in this slice; if a future duplicate/regenerate
workflow is needed, it should be designed as a separate action with explicit copy.

### Automation Product Buckets

Automation UI must keep definitions, scheduler registrations, and runs separate:

| Layer | User meaning | Source |
| --- | --- | --- |
| Definition state | Whether an automation is enabled, paused, archived, or in configuration error. | `AutomationDefinition.status`. |
| Scheduled watch state | Whether the local scheduler is watching enabled scheduled definitions. | `AutomationSchedulerState.automationCount` and scheduler items. |
| Run health | Whether recent automation runs are queued, running, succeeded, failed, or waiting. | `AutomationRun.status` and latest run per automation. |
| Draft review | Whether generated drafts need confirmation before becoming automations. | `AutomationDraft.status`. |

Rules:

- An enabled manual automation is runnable but not watched by the scheduler.
- Scheduler text should say "scheduled automations" when it means schedule-triggered
  definitions.
- "Running" belongs to runs or the scheduler process, not enabled definitions.
- Failed recent runs can make an enabled automation appear in a "needs attention" view;
  that view is not mutually exclusive with enabled definitions.
- The Automations page summary is derived from definitions, runs, drafts, and scheduler
  state together. Page components should not independently recalculate competing counts.
- The `failed` tab id may stay in code for compatibility, but its visible product label
  should be Needs attention.

Implementation helper contract:

```ts
interface AutomationPageSummary {
  readonly totalDefinitions: number;
  readonly enabledDefinitions: number;
  readonly pausedDefinitions: number;
  readonly scheduledWatchCount: number;
  readonly runningRunCount: number;
  readonly failedRecentRunCount: number;
  readonly readyDraftCount: number;
  readonly attentionCount: number;
}
```

Helpers live in `automation-view-models.ts`:

- `summarizeAutomationsPage({ automations, automationRuns, automationDrafts, scheduler })`
- `buildAutomationTabs({ enabled, paused, needsAttention, succeeded, recentRuns, t })`
- `automationSchedulerCopy({ scheduler, t })`

### Automation Labels And Actions

Primary labels:

| Context | Label |
| --- | --- |
| Header summary | Total automations, enabled definitions, running/recent runs, needs attention. |
| Scheduler running with scheduled items | Scheduler started; watching N scheduled automations. |
| Scheduler running with zero scheduled items | Scheduler started; no enabled scheduled automations. Manual automations can still run now. |
| Scheduler stopped with scheduled items | N scheduled automations are ready; start scheduler to run them automatically. |
| Scheduler stopped with zero scheduled items | No enabled scheduled automations yet. Create or edit one with a schedule. |
| Failed tab/filter | Needs attention / 需处理, with copy that says failed recent runs or definition error. |

## Module Boundaries

- Frontend view-models own product bucket derivation.
- Shared P5 components remain presentational and receive labels, counts, disabled
  reasons, and actions from feature-owned helpers.
- Daemon APIs, storage, media job statuses, automation statuses, scheduler behavior, and
  generation runtime behavior do not change.
- `MediaJobsPage` and `AutomationsPage` should consume helpers rather than adding inline
  count and label logic.
- Large-file guardrail remains active: if implementation grows a protected page, extract
  a focused helper or small component first.

## Acceptance Criteria

- Image Generation does not describe queued or legacy waiting tasks as in progress.
- Image Generation shows separate counts for generating now and ready/attention work.
- Image Generation buttons use Start generation, Retry generation, or Generating
  according to the product bucket.
- Completed generation tasks do not present a misleading Run action.
- Automations scheduler copy does not imply enabled manual automations are being watched
  by the scheduler.
- Automations first screen distinguishes enabled definitions, scheduled watches, and
  failed recent runs.
- No backend API, database, scheduler, media runtime, or approval behavior changes.

## Assumptions

- Desktop Web remains the acceptance target.
- This follow-up is P5 product semantics work, not P2 IA or AppShell refactoring.
- The scheduler remains explicit and process-local.
- Manual automations remain valid enabled automations even when scheduler watch count is
  zero.
