# Media And Automations Workbench Refinement

## Summary

Refine the Media Jobs and Automations pages as existing product workbenches. This
slice uses frontend view-models and presentational components to improve hierarchy,
copy, and state presentation while preserving all existing daemon contracts,
callbacks, state machines, and durable data.

This is option B from the boundary review:

```text
frontend component extraction
  -> pure view-model derivation
  -> targeted page and style updates
  -> no backend/API/schema change
```

## Goals

- Make Media Jobs easier to scan: task rows should prioritize generated result,
  prompt/operation, status, and the next valid action.
- Make the selected media detail prioritize the generated artifact, with prompt and
  runtime details as secondary information.
- Make Automations terminology match real data. Active enabled definitions must not
  be presented as actual running runs.
- Preserve template creation, manual creation, chat-assisted draft creation, draft
  confirmation, run now, pause/resume, archive/delete, open thread, and open run.
- Move page-specific derivation logic out of already-large page files.
- Keep user-facing copy concise, Chinese-friendly, and product-oriented.

## Non-goals

- No backend API change.
- No persistent schema change.
- No new automation scheduler or runner behavior.
- No media job state machine change.
- No AppShell domain refactor in this slice.
- No mobile acceptance work in this slice.
- No backend schema for media advanced parameters. The Web form maps structured fields
  back into the existing `input` object.

## Key Changes

- Add small media view-model helpers for status buckets, selected task data, artifact
  summaries, and runnable/recovery state.
- Extract media list and detail presentation from `MediaJobsPage`.
- Add small automation view-model helpers for status tabs, latest runs by definition,
  source labels, and inspector fields.
- Extract automation list pane and execution inspector presentation from
  `AutomationsPage`.
- Rename the default automation tab presentation from "Running" to "Enabled" unless
  the tab is backed by actual active `AutomationRun` records.
- Keep creation actions visible in the page header, and reduce duplicate empty-state
  action clutter.
- Productize technical labels such as daemon recovery text and raw thread ids.
- Replace the media create dialog's user-facing JSON editor with structured fields for
  currently supported adapter inputs.
- Expose scheduler start/stop controls using existing Automations page props.

## Module Boundaries

### UI

- `apps/web/src/features/media/MediaJobList.tsx`
- `apps/web/src/features/media/MediaJobDetailPanel.tsx`
- `apps/web/src/features/automations/AutomationListPane.tsx`
- `apps/web/src/features/automations/AutomationExecutionInspector.tsx`

These files render props and emit callbacks only.

### View Models

- `apps/web/src/features/media/media-job-view-models.ts`
- `apps/web/src/features/automations/automation-view-models.ts`

These files derive display-only state from existing contracts. They must not call
APIs or mutate data.

### Page Shells

- `MediaJobsPage.tsx` keeps local UI state such as selected status filter and create
  dialog open state.
- `AutomationsPage.tsx` keeps local UI state such as active tab and create dialog open
  state.

### App Shell

`AppShell.tsx` remains wiring only. This refinement should not add new AppShell
business logic.

## API / Types

- Reuse existing `MediaJob`, `RunArtifact`, `ProviderPreset`, `AutomationDefinition`,
  `AutomationRun`, `AutomationDraft`, and `LingThread` contracts.
- Do not add fields to `CreateMediaJobRequest`, `AutomationDefinition`, or
  `AutomationRun`.
- Web-only `MediaJobFormState` may grow structured form fields, but the request body
  remains `CreateMediaJobRequest.input`.
- Any label that cannot be derived from existing data should degrade to a neutral
  placeholder instead of inventing fake data.

## State / Data Flow

```text
MediaJobsPage props
  -> media-job-view-models
  -> MediaJobList / MediaJobDetailPanel
  -> existing callbacks: select, run, refresh, open providers
```

```text
AutomationsPage props + fetched LingThread titles
  -> automation-view-models
  -> AutomationListPane / AutomationExecutionInspector
  -> existing callbacks: create, select, run, pause/resume, archive, open run/thread
```

## Test Plan

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- media-jobs.spec.ts automations.spec.ts`
- Verify media jobs:
  - no generation model state still opens model settings;
  - successful artifacts display in list/detail;
  - failed/cancelled/missing-result tasks keep retry ability;
  - create dialog still submits through existing payload mapping.
- Verify automations:
  - template/manual/chat creation actions remain reachable;
  - enabled tab no longer implies actual running runs;
  - drafts remain confirmable/discardable;
  - run, pause/resume, archive, open thread, and open run still call existing flows.

## Risks

- `AutomationsPage.tsx` and `automations.css` are already over 1200 lines; adding more
  logic there would deepen architecture debt.
- Renaming "Running" to "Enabled" may require e2e/i18n updates and may change user
  expectation, but it is safer than showing misleading state.
- Media advanced parameters are structured only in Web and still map into the
  existing `input` object; provider-specific capabilities still need future
  refinement if more adapters consume more fields.
- CSS split may create import-order risk if existing global selectors are broad.

## Assumptions

- "Running" automations currently means active enabled definitions, so the first slice
  will label that tab as "Enabled".
- "Create through chat" is renamed to "Create from conversation" in UI copy while
  preserving the existing chat draft flow.
- `image_edit` remains visible and exposes URL fields only. It does not add local file
  upload in this slice.
- The no-model media state makes "Configure generation model" the primary action.
- Scheduler start/stop controls are visible in the Automations header and call existing
  props only.
- Desktop Web is the acceptance target.

## Open Questions

- Should a later media editing slice add first-class local image upload and attachment
  binding for `image_edit`?
- Should a later scheduler slice show per-automation scheduler registration diagnostics?

## Implementation Plan

1. Land this document to freeze scope.
2. Extract media view-model helpers and presentational components.
3. Wire `MediaJobsPage` to the extracted components without changing props.
4. Extract automation view-model helpers, list pane, and inspector.
5. Wire `AutomationsPage` to extracted components and rename the active-definition tab
   to "Enabled".
6. Replace the media advanced JSON editor with structured Web fields mapped into
   existing media input.
7. Add scheduler start/stop controls to the Automations header.
8. Update CSS only for affected selectors, preferring existing theme variables.
9. Update e2e assertions for preserved flows and corrected labels.
10. Run typecheck and targeted e2e.
