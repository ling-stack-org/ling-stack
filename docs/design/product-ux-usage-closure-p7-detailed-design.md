# Product UX Usage Closure P7 Detailed Design

## Related Docs

- [P7 Design](product-ux-usage-closure-p7.md)
- [P7 Implementation Plan](product-ux-usage-closure-p7-implementation-plan.md)
- [P5 Status Semantics Follow-up](product-status-semantics-p5-followup.md)
- [Provider Generation Runtime](provider-generation-runtime.md)
- [Settings Visual Density Follow-up](settings-visual-density-followup.md)
- [Product UX Priorities P6](product-ux-priorities-p6.md)

## Summary

This document turns the P7 usage-closure direction into implementation-ready design
details. It defines user journeys, derived UI states, primary copy, repair actions,
module boundaries, and validation for four follow-up areas:

1. Image Generation execution closure.
2. Automations definition, scheduler, and run-health clarity.
3. Model Workbench beginner setup.
4. Skill Library and Maintenance compact inspectors.

No backend, database, route, provider runtime, scheduler, or skill registry behavior
changes are part of this design.

## Cross-Surface Rules

### User-Facing State Layers

Every P7 surface should separate these layers:

| Layer | Purpose | Examples |
| --- | --- | --- |
| Setup | Can the user start? | Model configured, API key present, scheduler available. |
| Action | What did the user just do? | Starting generation, checking model, starting scheduler. |
| Runtime | What is happening now? | Generating, scheduler running, automation run running. |
| Result | What did the user get? | Generated artifact, successful run, saved provider. |
| Recovery | What should the user fix? | Add API key, pick runnable model, inspect failed run. |

Primary UI should show one dominant layer at a time. Details can show the full stack.

### Copy Rules

- Use verbs that describe user outcomes: Start generation, Retry generation, View
  result, Configure model, Inspect failure, Confirm draft.
- Avoid default-layer implementation terms: adapter, transport, raw job, slice,
  metadata, storage state, executor.
- A successful check means configuration is reachable. It does not mean real generation,
  automation execution, or skill invocation happened unless that action actually ran.
- Disabled controls need a reason that tells the user what to change.

### Component Boundary

- Shared P5 components can render state rows, empty states, action rows, and details.
- Feature view-models own state derivation and copy keys.
- Locale modules own English and Chinese strings.
- Large files should receive props from helpers/components instead of growing inline
  logic.

## Slice 1: Image Generation Execution Closure

### User Journey

1. User opens Image Generation.
2. If no runnable generation model exists, the page shows a setup state with Configure
   generation model.
3. User creates or selects a task.
4. User clicks Start generation.
5. The clicked task shows immediate Starting feedback, then Generating when the daemon
   reports a running job.
6. On success, the detail pane focuses on the generated artifact.
7. On failure, the detail pane shows a product reason and a repair action.

### Product State Detail

Reuse the P5 product buckets, but add action feedback:

| UI state | Source | Primary label | Primary action |
| --- | --- | --- | --- |
| `setup_blocked` | No runnable provider for selected operation. | Configure a generation model | Configure generation model |
| `ready_to_start` | `queued` or legacy `waiting_for_approval`. | Ready to start | Start generation |
| `starting` | User clicked run and request is in flight. | Starting generation | Starting |
| `generating` | Stored `running` or `runningJobId` matches. | Generating | Generating |
| `needs_attention` | Failed, cancelled, error, or missing artifact. | Needs attention | Retry generation |
| `completed` | Succeeded with usable artifact. | Completed | View result |
| `unknown` | Contradictory data. | Check task status | Refresh |

`starting` is local UI feedback only. It must not become a stored media job status.

### Failure Reason Mapping

The primary failure copy should be productized while preserving raw details in a
disclosure:

| Condition | Primary copy | Repair action |
| --- | --- | --- |
| Missing API key or secret not configured | This model needs an API key before it can generate. | Open Model Workbench |
| Provider disabled | This model route is disabled. Enable it before generating. | Open Model Workbench |
| Runtime recognized but no real adapter | This model is recognized, but real generation is not connected yet. | Choose another model |
| Relay/base URL rejected request | The relay rejected the generation request. Check the route or model name. | Open Model Workbench |
| Quota/rate limit | The provider limited this request. Try later or use another route. | Retry generation |
| Timeout/network | The provider did not respond in time. Check the route and retry. | Retry generation |
| Missing artifact after success | The task completed but no usable result was returned. | Retry generation |
| Unknown error | Generation failed. Review details or try another model route. | Retry generation |

Technical error text can appear under `details` labelled Generation details.

### Success Result Design

Completed tasks should treat the artifact as the main object:

- Show the first image/video preview prominently in the detail pane.
- Show a compact artifact list when multiple artifacts exist.
- Provide actions based on existing capabilities:
  - View result.
  - Copy prompt.
  - Copy result URL or open artifact URL when available.
  - Download artifact when the browser can access the artifact URL.
  - Reuse settings by creating a new task draft from the current prompt/model/settings
    if this can be done with existing client state.
- Do not show a primary Run button on completed tasks. Future regenerate/variant flows
  need a separate design.

### Empty And Blocked States

| State | Copy goal | Primary action |
| --- | --- | --- |
| No providers | Explain that generation needs a runnable model. | Configure generation model |
| Providers exist but none runnable | Explain that recognized models may still need API key or adapter support. | Open Model Workbench |
| Task list empty | Invite creating a generation task. | Create generation task |
| Selected model unsupported | Say it cannot run real generation yet. | Choose another model |

### Module Boundary

- `features/media/media-job-view-models.ts`
  - Add local action feedback view type if needed.
  - Keep product bucket derivation here.
  - Map runtime/provider errors into product reasons.
- `features/media/MediaJobsPage.tsx`
  - Consume helpers and manage local starting feedback.
  - Do not add provider/runtime recognition logic inline.
- `features/media/MediaJobDetailPanel.tsx`
  - Result-first completed state.
  - Failure recovery state.
- `features/media/MediaJobList.tsx`
  - Row badge/action alignment.
- `styles/media-jobs.css` or focused media CSS
  - Result preview, failure details, and no-overflow rules.

### Test Matrix

- No generation model shows Configure generation model.
- Unsupported generation model says real generation is not connected.
- Start generation immediately shows Starting then Generating.
- Provider/relay failure shows product failure copy and raw details disclosure.
- Missing artifact after success becomes Needs attention.
- Success shows preview and result actions.
- Completed task has no primary Run button.
- Dark mode keeps result and failure cards readable.

## Slice 2: Automations State Friction

### User Journey

1. User opens Automations.
2. Header shows definition count, enabled definitions, scheduled watches, and needs
   attention as separate facts.
3. Scheduler strip explains whether scheduled automations are being watched.
4. Manual enabled automations remain runnable even when scheduled watch count is zero.
5. Failed recent runs appear in Needs attention with a clear next action.

### Product Summary Contract

Extend or reuse automation view-model summary to produce:

```ts
interface AutomationUsageSummary {
  readonly totalDefinitions: number;
  readonly enabledDefinitions: number;
  readonly manualEnabledDefinitions: number;
  readonly scheduledEnabledDefinitions: number;
  readonly schedulerRunning: boolean;
  readonly scheduledWatchCount: number;
  readonly runningRunCount: number;
  readonly failedRecentRunCount: number;
  readonly readyDraftCount: number;
  readonly attentionCount: number;
}
```

The page should not calculate competing counts outside this helper.

### Scheduler Copy

| Scheduler state | Scheduled count | Manual enabled count | Copy |
| --- | --- | --- | --- |
| Running | 0 | 0 | Scheduler started. No enabled scheduled automations yet. |
| Running | 0 | N | Scheduler started. No scheduled automations are enabled; manual automations can still run now. |
| Running | N | Any | Scheduler started. Watching N scheduled automations. |
| Stopped | 0 | N | Scheduler stopped. Manual automations can still run; add a schedule to run automatically. |
| Stopped | N | Any | N scheduled automations are ready. Start scheduler to run them automatically. |

### Needs Attention Sources

| Source | Row label | Next action |
| --- | --- | --- |
| Failed recent run | Recent run failed | Inspect failure |
| Definition error | Setup needs attention | Edit automation |
| Ready draft | Draft ready to confirm | Review draft |
| Scheduler stopped with scheduled watches | Scheduler is stopped | Start scheduler |

Needs attention is a view, not a mutually exclusive status. An enabled automation can
also need attention because its latest run failed.

### Module Boundary

- `features/automations/automation-view-models.ts`
  - Own summary and tab derivation.
  - Own scheduler copy.
  - Own needs-attention reasons.
- `features/automations/AutomationSchedulerStrip.tsx`
  - Render scheduler copy and controls only.
  - Do not derive hidden definition counts.
- `features/automations/AutomationsPage.tsx`
  - Consume summary and helper-provided tabs.
- `features/automations/AutomationExecutionInspector.tsx`
  - Show failed run details and action.

### Test Matrix

- Enabled manual automation plus running scheduler and zero watches does not sound
  broken.
- Enabled scheduled automation increments scheduled watch count.
- Failed latest run appears in Needs attention while definition remains enabled.
- Ready draft appears in Needs attention and review flow still works.
- Stopped scheduler with scheduled watches shows Start scheduler as the repair action.
- Dark mode preserves scheduler and attention contrast.

## Slice 3: Model Workbench Beginner Setup Path

### User Journey

1. User opens Model Workbench with no providers.
2. Empty state offers Add chat model and Add image generation model.
3. User chooses a path and sees a prefiltered provider setup flow.
4. Missing API key state shows one dominant repair action.
5. Check result explains where the model can be used.

### Setup Paths

| Path | Default template focus | Destination |
| --- | --- | --- |
| Add chat model | Chat-capable provider templates. | Provider create sheet with chat defaults. |
| Add image generation model | Generation-capable provider templates. | Provider create sheet with media/generation defaults. |

The design does not require new provider types. It uses existing templates, capabilities,
and provider runtime data.

### Empty And Repair Copy

| State | Primary copy | Primary action |
| --- | --- | --- |
| No providers | Add a model route to start using Ling. | Add chat model |
| No generation model | Add a generation model before creating image tasks. | Add image generation model |
| Missing API key | Add the API key for this model route. | Add API key |
| Disabled provider | This route is disabled and will not be used. | Enable route |
| Check passed chat | Configuration check passed. You can use this model in conversations. | Open conversation |
| Check passed generation | Configuration check passed. Run Image Generation to create real results. | Open Image Generation |
| Check failed | The route could not be checked. Fix the key, model name, or base URL. | Edit route |

### Check Feedback Rules

- Check feedback is scoped to the checked row.
- Batch check summary can aggregate counts but should not replace row feedback.
- Generation model check must say it does not create a real image.
- Raw provider response belongs in details.

### Module Boundary

- `features/providers/provider-workbench-view-models.ts`
  - Add beginner setup view helpers.
  - Map provider readiness into setup and repair states.
- `features/providers/ProviderWorkbenchHeader.tsx`
  - Keep readiness summary compact.
  - Add setup CTAs only when the empty or blocked state needs them.
- Provider editor/import components
  - Accept optional setup intent: chat or generation.
  - Do not duplicate provider capability logic.
- `features/media` and conversation surfaces
  - May link into Model Workbench with an intent, but should not know provider templates.

### Test Matrix

- No providers shows Add chat model and Add image generation model.
- Image Generation no-model CTA opens Model Workbench with generation setup intent.
- Missing API key row has one dominant repair action.
- Chat check success points to conversations.
- Generation check success points to Image Generation and says no real image was created.
- Same model through different base URLs remains distinguishable.

## Slice 4: Skill Library And Maintenance Compact Inspectors

### User Journey

1. User opens Skill Library or Maintenance from Settings.
2. First screen shows status summary and next action.
3. User can expand details for metadata, diagnostics, and evidence.
4. Dense facts remain available but do not dominate the default layer.

### Skill Library Inspector Structure

Default selected-skill inspector:

1. Skill status summary:
   - available, warning, blocked, or unknown;
   - source path or bundle label only if it helps identify the skill;
   - primary next action if available.
2. User-relevant capability summary:
   - what the skill can help with;
   - whether it is enabled or blocked by policy.
3. Details disclosures:
   - metadata;
   - health findings;
   - raw source and protocol facts;
   - references and bundled assets.

No skill selected state should show a compact empty state with search/filter guidance,
not a documentation block.

### Maintenance Inspector Structure

Default Maintenance first screen:

1. Startup readiness summary.
2. Primary action:
   - Refresh readiness;
   - Restart service;
   - Open diagnostics, depending on existing capability.
3. Blocker list if blocked.
4. Details disclosures:
   - daemon health;
   - runner readiness;
   - logs and raw diagnostic evidence;
   - local service manager facts.

### Module Boundary

- `features/settings/SkillLibrarySettingsPanel.tsx`
  - Prefer extracting a compact inspector component before adding layout logic.
- `features/settings/SkillLibraryWidgets.tsx`
  - Reuse existing widgets but place raw metadata behind details.
- `features/settings/MaintenanceSettingsPanel.tsx`
  - Summary-first layout only.
- `styles/settings.css`
  - Focused compact inspector classes.
  - No broad Settings restyle.

### Test Matrix

- Skill Library first screen shows summary before metadata.
- Skill metadata remains reachable through details.
- No skill selected state is compact and searchable.
- Maintenance first screen shows readiness summary and primary action first.
- Startup diagnostic evidence remains reachable.
- Settings dark mode and no-overflow checks pass at desktop widths.

## Implementation Plan Shape

When implementation starts, use four independent commits or slices:

1. `p7-media-generation-closure`
2. `p7-automation-state-clarity`
3. `p7-model-workbench-setup-path`
4. `p7-settings-compact-inspectors`

Each slice should:

- update or add focused view-model helpers first;
- update UI components second;
- add English and Chinese copy together;
- update focused e2e;
- run `check:i18n`, `typecheck`, and touched e2e;
- record evidence in this document or a dedicated implementation plan.

## Hard Stops

- Stop if a slice requires daemon API changes.
- Stop if a slice requires changing stored status values.
- Stop if a slice requires changing provider runtime classification.
- Stop if a slice requires scheduler behavior changes.
- Stop if a slice adds major behavior to a protected large file without extraction.

## Open Questions For Implementation

- Should Image Generation support a first-class Duplicate or Regenerate action for
  completed tasks, or should reuse stay as prefilled create-task state?
- Should Model Workbench setup intent be represented in URL/router state, local component
  state, or existing Settings workspace tool state?
- Should Skill Library compact inspector become a shared Settings inspector pattern, or
  remain local until Maintenance proves the same shape?

These questions do not block the design. They should be resolved at slice planning time
with code context in hand.
