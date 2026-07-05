# Product UX Visual Polish P4 Implementation Plan

## Summary

Implement [Product UX Visual Polish P4](product-ux-visual-polish-p4.md) as a focused
frontend slice. The work is docs, small shared UI boundaries, product copy, local CSS, and
targeted regression coverage. It must not alter daemon APIs, storage, routes, or runtime
state machines.

## Key Changes

1. Documentation:
   - Add the P4 design contract and implementation plan.
   - Link both from Product Semantic Convergence.

2. Creation dialogs:
   - Add a shared `CreateDialogShell` component for overlay, header, body, and footer.
   - Replace duplicated channel/teammate dialog frames with the shared shell.
   - Rename the local style import from `channel-create.css` to `creation-dialogs.css`.
   - Keep domain fields inside `ChannelCreateDialog` and `TeammateCreateDrawer`.

3. Generation tasks:
   - Rename the user-facing grouped filter from `Queued` to `Active`.
   - Rename the page summary count from `{queuedCount} queued` to `{activeCount} active`.
   - Add a small helper for run-disabled reasons so list/detail buttons explain why they
     cannot run.
   - Keep stored `MediaJobStatus` values unchanged.

4. Automations:
   - Keep scheduler start/stop wiring, but reduce the strip's visual weight.
   - Move `Custom RRULE` behind an advanced details block in manual creation.
   - Remove the disabled Event tab from the primary trigger segmented control.
   - If further automation modal work is needed, extract modal components before adding
     behavior to `AutomationsPage.tsx`.

5. Sidebar and Settings:
   - Normalize sidebar row action menu/icon alignment for channels, teammates, and recent
     conversations.
   - Preserve archive/hide semantics and do not delete data.
   - Keep Settings P3 IA unchanged; patch only concrete desktop layout issues.

## Module Boundaries

- `CreateDialogShell.tsx` is presentational only and receives React nodes/callbacks.
- `creation-dialogs.css` owns shared creation-dialog structure and may include
  channel/teammate-specific modifiers.
- `media-job-view-models.ts` owns generation task display labels and disabled reasons.
- `AutomationSchedulerStrip.tsx` owns scheduler presentation only.
- `AutomationsPage.tsx` may keep form state but should not receive new unrelated
  responsibilities.

## API / Types

- No HTTP API change.
- No contract change.
- No database or persisted setting change.
- No new `ViewId`.
- No generation runtime resolver or scheduler runtime change.

## Test Plan

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts channel.spec.ts teammates.spec.ts`
- `corepack pnpm --filter @ling-stack/web test:e2e -- media-jobs.spec.ts automations.spec.ts settings.spec.ts dark-mode.spec.ts`
- Desktop browser checks at `1440x960` and `1280x800`:
  - home/sidebar,
  - channel create,
  - AI teammate create,
  - image generation,
  - automations,
  - Settings overview and nested tools.

## Acceptance Checklist

- [x] P4 docs are linked.
- [x] Shared creation dialog shell is used by channel and teammate create flows.
- [x] No creation dialog produces desktop horizontal overflow.
- [x] Generation task active status copy is productized.
- [x] Generation task run-disabled reasons are visible via title/aria text.
- [x] Automation manual creation keeps RRULE advanced.
- [x] Sidebar menu/action alignment is consistent.
- [x] Targeted typecheck/e2e pass or failures are documented.

## Evidence

- `corepack pnpm --filter @ling-stack/web typecheck` passed.
- `corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts channel.spec.ts teammates.spec.ts`
  passed with 121 tests.
- `corepack pnpm --filter @ling-stack/web test:e2e -- media-jobs.spec.ts` passed with 5 tests.
- The combined `media-jobs.spec.ts automations.spec.ts settings.spec.ts dark-mode.spec.ts`
  run initially failed on old lowercase media status assertions; after updating those assertions,
  the media file passed and the combined run's automation, settings, and dark-mode tests were
  already green.
- Playwright desktop checks against the running Vite dev server at `http://127.0.0.1:5173`
  passed for `1440x960` and `1280x800` with no horizontal overflow on the P4 target surfaces.

## Assumptions

- Desktop Web only.
- Existing dirty worktree changes are preserved.
- P4 is local polish, not a broad visual redesign.
