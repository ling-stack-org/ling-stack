# Product Status Semantics P5 Follow-up Implementation Plan

## Related Docs

- [P5 Status Semantics Design](product-status-semantics-p5-followup.md)
- [Product UX System P5](product-ux-system-p5.md)
- [P5 Next Inventory](product-ux-system-p5-next-inventory.md)

## Summary

Implement the P5 status semantics follow-up in two small UI-only slices. Start with Image
Generation because it can make runnable tasks look stuck. Then update Automations so
enabled definitions, scheduler watches, and recent run health no longer share one
ambiguous status line.

This plan does not change daemon APIs, database schema, media job state machines,
automation state machines, scheduler behavior, provider runtime checks, or generation
execution.

## Slice 1: Image Generation Status Buckets

Add a media product-status helper in the existing media view-model layer. It should map
stored job status, current running id, artifacts, and error state into:

- `generating`
- `ready_to_start`
- `needs_attention`
- `completed`
- `unknown`

Use that helper for:

- header summary counts;
- status filter matching and labels;
- row badge labels and badge class;
- row and detail primary action labels;
- run disabled reasons.

Concrete helper API:

```ts
deriveMediaJobProductState({ job, artifacts, runningJobId })
summarizeMediaJobs({ jobs, artifactsByJob, runningJobId })
mediaJobMatchesProductFilter({ job, artifacts, runningJobId, filter })
mediaJobPrimaryActionView({ job, artifacts, isLoading, isRunning })
```

`mediaJobCanRun` remains the source of actual run eligibility. The new product helper
only decides how the task is grouped and labelled.

Required behavior:

- `queued` and legacy `waiting_for_approval` display as ready to start, not active or in
  progress.
- `running` and the optimistic current `runningJobId` display as generating.
- `failed`, `cancelled`, error messages, and missing usable artifacts display as needs
  attention.
- `succeeded` with media artifacts displays as completed.
- completed rows do not show an enabled Run button; they keep result, copy, and details
  actions.

Suggested user-facing labels:

- Filters: All, Ready to start, Generating, Needs attention, Completed.
- Buttons: Start generation, Retry generation, Generating.
- Header: `{modelCount} available generation models · {taskCount} tasks · {generatingCount} generating · {readyCount} ready · {attentionCount} need attention`.

## Slice 2: Automation Definition, Schedule, And Run Semantics

Add an automation page summary helper in the existing automation view-model layer. It
should derive:

- total non-archived automation definitions;
- enabled definition count;
- paused definition count;
- enabled scheduled definition count;
- running or queued recent run count;
- failed recent run count;
- ready draft count;
- attention count.

Concrete helper API:

```ts
summarizeAutomationsPage({ automations, automationRuns, automationDrafts, scheduler })
buildAutomationTabs({ enabled, paused, needsAttention, succeeded, recentRuns, t })
automationSchedulerCopy({ scheduler, t })
```

The `failed` tab id can remain internal, but the visible label becomes Needs attention.
This avoids a route/state churn while making the UI language correct.

Use that helper for:

- header summary;
- scheduler strip summary;
- tab labels and optional helper copy;
- attention banner copy.

Required behavior:

- Header does not imply enabled definitions are running.
- Scheduler strip says "scheduled automations" when it uses
  `AutomationSchedulerState.automationCount`.
- Running scheduler with zero scheduled automations says no enabled scheduled
  automations are being watched and manual automations can still run now.
- Failed or error filter reads as needs attention, and can overlap with enabled
  definitions.

Suggested user-facing labels:

- Header: `{count} automations · {enabled} enabled · {running} running runs · {attention} need attention`.
- Scheduler running, zero schedules: `Scheduler started` + `No enabled scheduled automations. Manual automations can still run now.`
- Scheduler running, N schedules: `Scheduler started` + `Watching {count} scheduled automations.`
- Scheduler stopped, zero schedules: `Scheduler stopped` + `No enabled scheduled automations yet. Create or edit one with a schedule.`
- Scheduler stopped, N schedules: `Scheduler stopped` + `{count} scheduled automations are ready. Start scheduler to run them automatically.`

## Implementation Boundaries

- Keep all derivation in feature view-model helpers, not shared P5 components.
- Do not add new `ViewId`, routes, API fields, storage fields, or daemon endpoints.
- Do not change actual task run eligibility, media provider readiness, scheduler start,
  scheduler stop, or run creation behavior.
- Do not reintroduce media cost approvals or Inbox routing for generation tasks.
- Do not make manual automations count as scheduled watches.

## Test Plan

Documentation-only landing:

- `git diff --check`

Implementation landing:

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- media-jobs.spec.ts automations.spec.ts dark-mode.spec.ts`

Media e2e scenarios:

- queued task is labelled ready to start and has Start generation.
- legacy waiting task is labelled ready to start and runs directly.
- running task is the only task counted as generating.
- failed/cancelled/missing-result tasks are needs attention and use Retry generation.
- completed task with artifact is completed and does not show an enabled Run action.

Automation e2e scenarios:

- enabled manual automation with running scheduler and zero scheduled watches explains
  the zero count without contradiction.
- enabled scheduled automation increments scheduler watch count.
- failed latest run appears in needs attention without removing the automation from
  enabled definitions.
- ready draft contributes to attention count and keeps confirmation flow intact.
- scheduler start/stop buttons still call existing handlers.

## Acceptance Checklist

- [x] Product status design doc is linked from P5 docs.
- [x] Image Generation summary, filters, badges, and buttons use product buckets.
- [x] Automations summary separates definitions, scheduled watches, and run health.
- [x] Existing runtime behavior remains unchanged.
- [x] Desktop Web e2e checks pass at the default Playwright `1440x960` viewport.
- [x] A focused `1280x800` dev-server smoke recorded no horizontal document/body
  overflow on Home, Image Generation, and Automations.

## Implementation Evidence

Implemented locally in the P5 status-semantics follow-up slice:

- Image Generation product-state helpers live in `apps/web/src/features/media/media-job-view-models.ts`.
- Image Generation page, list, and detail pane consume product buckets for summary,
  filters, badges, and primary actions.
- Automations page summary helpers live in
  `apps/web/src/features/automations/automation-view-models.ts`.
- Automations page and scheduler strip consume the summary helpers so enabled
  definitions, scheduled watches, recent run health, and drafts are not mixed in page
  components.
- Shared P5 components remain presentational; media and automation domain rules stay in
  feature view-models.

Validation commands run:

- `git diff --check`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- media-jobs.spec.ts automations.spec.ts dark-mode.spec.ts`
- Dev-server smoke at `http://127.0.0.1:4174/` with Playwright viewport
  `1280x800`: Home, Image Generation, and Automations reported `documentOverflow:
  0` and `bodyOverflow: 0`.

## Assumptions

- The implementation will follow after this documentation landing.
- Image Generation is the first implementation slice.
- Automations is the second implementation slice.
- Desktop Web remains the only acceptance target.
