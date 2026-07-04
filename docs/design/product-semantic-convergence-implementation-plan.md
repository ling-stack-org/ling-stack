# Product Semantic Convergence Implementation Plan

## Summary

Implement the first convergence slice from
[Product Semantic Convergence](product-semantic-convergence.md). The work is limited to
documentation, product copy, and wiring existing scheduler controls into the Automations
page.

## Goals

- Add a durable design contract and implementation plan under `docs/design`.
- Replace stale generation copy that still says the page only validates metadata or
  queues a non-real task.
- Show Automations scheduler status and start/stop controls using existing domain state
  and actions.
- Keep current routes, data contracts, and durable records unchanged.

## Non-goals

- No daemon API or database changes.
- No new provider/generation adapter.
- No full IA move of Work Board or Model Workbench.
- No mobile acceptance.
- No AppShell modularization beyond prop passthrough.

## Key Changes

1. Page descriptions:
   - Change Image Generation description to "create and run image/video generation
     tasks".
   - Keep Model Workbench as the place to configure generation-capable models.
2. Media create dialog:
   - Replace "queued task" copy with "generation task" copy.
3. Automations:
   - Add an `AutomationSchedulerStrip` presentational component.
   - Pass `schedulers`, `schedulerAction`, `startScheduler`, and `stopScheduler` from
     `useAutomationsDomain` through `AppShell` into `AutomationsPage`.
   - Show "Scheduler running" with a stop button when running.
   - Show "Scheduler stopped" with a start button when stopped or absent.
   - Show error text when scheduler state reports an error.
4. Tests:
   - Update Automations e2e so it expects the scheduler controls to be visible.
   - Run Web typecheck and targeted e2e where feasible.

## Module Boundaries

- `AutomationsPage.tsx`
  receives scheduler props and places the scheduler strip in the page header area.
- `AutomationSchedulerStrip.tsx`
  renders scheduler state only and calls passed callbacks. It does not fetch or mutate
  directly.
- `use-automations-domain.ts`
  remains the owner of API calls and scheduler mutation state.
- `AppShell.tsx`
  only passes props through.

## API / Types

- Reuse `AutomationSchedulerState` from contracts.
- Reuse existing scheduler endpoints through the domain hook.
- Do not add or change HTTP requests.
- Do not change generation/media contracts.

## State / Data Flow

```text
useAutomationsDomain
  -> state.schedulers / state.schedulerAction
  -> AppShell prop passthrough
  -> AutomationsPage
  -> AutomationSchedulerStrip
  -> onStartScheduler / onStopScheduler callbacks
```

## Test Plan

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- automations.spec.ts`
- `corepack pnpm --filter @ling-stack/web test:e2e -- media-jobs.spec.ts`

## Acceptance Checklist

- [x] Image Generation page description no longer says "metadata only" or "not real".
- [x] Media create dialog no longer says "queued task" as the primary explanation.
- [x] Automations page shows scheduler running/stopped state.
- [x] Start/stop scheduler buttons call existing callbacks.
- [x] Automation creation actions remain visible: template, manual, from conversation.
- [x] AI teammate and Council Workspace boundaries remain unchanged.
- [x] No major business logic was added to `AppShell.tsx`.

## Implementation Evidence

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- automations.spec.ts media-jobs.spec.ts`
- `corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts teammates.spec.ts councils.spec.ts`

## Risks

- `i18n.tsx` is a large dictionary; small copy changes should stay localized.
- `AutomationsPage.tsx` is already large, so scheduler rendering should stay in a
  separate presentational component.
- Existing tests that expected hidden scheduler controls must be updated deliberately.

## Assumptions

- Scheduler controls are product UI over existing local scheduler state, not a new
  scheduler implementation.
- Work Board remains in settings workspace tools for this slice.
- The acceptance scope is desktop Web.
