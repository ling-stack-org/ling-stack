# Product UX Usage Closure P7 Implementation Plan

## Related Docs

- [P7 Design](product-ux-usage-closure-p7.md)
- [P7 Detailed Design](product-ux-usage-closure-p7-detailed-design.md)
- [P5 Status Semantics Follow-up](product-status-semantics-p5-followup.md)
- [Provider Generation Runtime](provider-generation-runtime.md)
- [Settings Visual Density Follow-up](settings-visual-density-followup.md)

## Summary

Implement P7 as four independent desktop Web slices. The first two slices are the next
recommended implementation order:

1. Image Generation real-use closure.
2. Automations enabled, scheduler, and recent-run clarity.

The remaining slices should follow only after the first two are stable:

3. Model Workbench beginner setup path.
4. Skill Library and Maintenance compact inspectors.

P7 is a UX and view-model pass. It does not change backend APIs, database schema,
provider runtime classification, generation execution, scheduler behavior, skill
registry behavior, Settings IA, or primary navigation.

## Current Code Boundaries

### Image Generation

Current owners:

- `apps/web/src/features/media/media-job-view-models.ts`
- `apps/web/src/features/media/MediaJobsPage.tsx`
- `apps/web/src/features/media/MediaJobList.tsx`
- `apps/web/src/features/media/MediaJobDetailPanel.tsx`
- `apps/web/src/features/media/MediaJobAdvancedFields.tsx`

Risk level: low to medium. Media feature files are already reasonably focused and have
product-state helpers. New logic should extend the feature view-model instead of adding
provider/runtime checks in page components.

### Automations

Current owners:

- `apps/web/src/features/automations/automation-view-models.ts`
- `apps/web/src/features/automations/AutomationsPage.tsx`
- `apps/web/src/features/automations/AutomationSchedulerStrip.tsx`
- `apps/web/src/features/automations/AutomationListPane.tsx`
- `apps/web/src/features/automations/AutomationExecutionInspector.tsx`
- `apps/web/src/features/automations/AutomationCreateDialogs.tsx`

Risk level: medium. `AutomationCreateDialogs.tsx` is large but mostly outside this
slice. State summary and scheduler copy should stay in `automation-view-models.ts`.

### Model Workbench

Current owners:

- `apps/web/src/features/providers/provider-workbench-view-models.ts`
- `apps/web/src/features/providers/ProviderSettings.tsx`
- `apps/web/src/features/providers/ProviderWorkbenchHeader.tsx`
- `apps/web/src/features/providers/ProviderRouteList.tsx`
- `apps/web/src/features/providers/ProviderEditorPanel.tsx`
- `apps/web/src/features/providers/ProviderModelImportPanel.tsx`

Risk level: medium. `ProviderSettings.tsx` is below the 800-line guardrail after earlier
extraction, but setup-intent behavior should still be modeled in helpers and props.

### Skill Library And Maintenance

Current owners:

- `apps/web/src/features/settings/SkillLibrarySettingsPanel.tsx`
- `apps/web/src/features/settings/SkillLibraryWidgets.tsx`
- `apps/web/src/features/settings/MaintenanceSettingsPanel.tsx`
- `apps/web/src/styles/settings.css`

Risk level: high. `SkillLibrarySettingsPanel.tsx` and `SkillLibraryWidgets.tsx` are over
the large-file guardrail. Any implementation here must extract compact inspector
components/helpers before changing layout behavior.

## Slice 1: Image Generation Real-Use Closure

### Goal

Make the Image Generation workflow clear after the user clicks Start generation:
starting feedback, generating feedback, failure repair, success artifact actions, and
blocked setup paths should all be visible without reading raw media job state.

### Implementation Steps

1. Extend media view-models.
   - Add a UI-only action state for `starting` feedback.
   - Add a helper for product failure reasons, for example
     `mediaJobFailureRecoveryView(...)`.
   - Add a helper for completed-result actions, for example
     `mediaJobResultActionView(...)`.
   - Keep stored media status values unchanged.

2. Update the page-level run flow.
   - In `MediaJobsPage`, track the currently starting job id while the run request is in
     flight.
   - Clear starting state when the request resolves, rejects, or the daemon-reported
     running job state takes over.
   - Do not treat `starting` as a persisted status or daemon state.

3. Update the list row.
   - `ready_to_start`: badge Ready to start, button Start generation.
   - `starting`: badge Starting generation, button Starting disabled.
   - `generating`: badge Generating, button Generating disabled.
   - `needs_attention`: badge Needs attention, button Retry generation.
   - `completed`: badge Completed, no primary Run button.

4. Update the detail panel.
   - Completed tasks show artifact preview and result actions first.
   - Failure states show product failure copy, repair action, and a collapsed Generation
     details disclosure for raw provider/relay details.
   - Missing artifact after success shows Needs attention and retry guidance.

5. Update empty and blocked states.
   - No runnable generation model routes to Model Workbench.
   - Unsupported or recognized-but-not-runnable model says real generation is not
     connected yet.
   - Keep provider transport and adapter language out of primary copy.

6. Update i18n and tests.
   - Add English and Chinese keys for starting, result actions, failure recovery, and
     setup blockers.
   - Update `media-jobs.spec.ts` and `dark-mode.spec.ts`.

### API / Types

- No HTTP API changes.
- No database or stored media status changes.
- Add frontend-only view-model types if needed:
  - `MediaJobRunActionState`
  - `MediaJobFailureRecoveryView`
  - `MediaJobResultActionView`
- Do not import provider runtime or resolver logic into shared P5 components.

### Tests

- `corepack pnpm --filter @ling-stack/web check:i18n`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- media-jobs.spec.ts dark-mode.spec.ts`

Scenario coverage:

- No generation model shows Configure generation model.
- Unsupported generation model shows recognized but not connected to real generation.
- Clicking Start generation shows Starting immediately.
- Running daemon state shows Generating.
- Provider/relay failure shows product copy plus raw details disclosure.
- Missing artifact after success maps to Needs attention.
- Success shows artifact preview and result actions.
- Completed task does not expose a misleading primary Run action.

### Browser Validation

Use the served Web artifact being changed, normally the Vite dev server.

Check at `1440x960` and `1280x800`:

- empty/no-model state;
- ready task;
- starting/generating task;
- failed task with details disclosure;
- succeeded task with artifact preview and result actions;
- dark mode for result and failure cards.

### Acceptance

- The user can tell whether generation is starting, currently generating, failed, or
  completed from the list and detail pane.
- Failure copy gives one repair direction before showing raw details.
- Success prioritizes generated artifacts over job metadata.
- No backend/runtime behavior changes are required.

## Slice 2: Automations State Friction

### Goal

Make Automations explain enabled definitions, scheduled watches, scheduler process state,
and recent run health without making users think manual enabled automations are broken
when scheduler watch count is zero.

### Implementation Steps

1. Extend automation summary helpers.
   - Add or refine `AutomationUsageSummary` in `automation-view-models.ts`.
   - Derive manual enabled count, scheduled enabled count, scheduler running state,
     scheduled watch count, failed recent runs, ready drafts, and total attention count
     in one helper.
   - Keep the `failed` tab id if needed for compatibility, but visible label remains
     Needs attention.

2. Refine scheduler copy.
   - Use "scheduled automations" whenever the copy describes scheduler watches.
   - Running scheduler plus zero scheduled watches should not sound like failure when
     manual automations exist.
   - Stopped scheduler plus scheduled watches should make Start scheduler the repair
     action.

3. Update header and tabs.
   - Header summary separates definitions, scheduled watches, and needs attention.
   - Needs attention tab includes failed recent runs, definition setup errors, ready
     drafts, and scheduler stopped with scheduled watches.
   - Enabled and Needs attention are allowed to overlap conceptually; copy should not
     imply mutually exclusive buckets.

4. Update list and inspector copy.
   - Failed latest run row says Recent run failed and offers Inspect failure.
   - Definition setup issue says Edit automation.
   - Ready draft says Review draft.
   - Scheduler stopped issue says Start scheduler.

5. Update i18n and tests.
   - Add English and Chinese scheduler and attention keys.
   - Update `automations.spec.ts` and `dark-mode.spec.ts`.

### API / Types

- No HTTP API changes.
- No automation definition, run, draft, or scheduler contract changes.
- Add frontend-only view-model types if needed:
  - `AutomationUsageSummary`
  - `AutomationAttentionReasonView`
  - `AutomationSchedulerUsageCopy`
- Do not change scheduler start/stop behavior.

### Tests

- `corepack pnpm --filter @ling-stack/web check:i18n`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- automations.spec.ts dark-mode.spec.ts`

Scenario coverage:

- Enabled manual automation plus scheduler running and zero scheduled watches says
  manual automations can still run.
- Enabled scheduled automation increments watch count.
- Scheduler stopped with scheduled watches points to Start scheduler.
- Failed latest run appears in Needs attention while definition stays enabled.
- Ready draft appears in Needs attention and review flow still works.
- Dark mode preserves scheduler and attention contrast.

### Browser Validation

Check at `1440x960` and `1280x800`:

- scheduler running with zero scheduled watches and manual automations;
- scheduler running with scheduled watches;
- scheduler stopped with scheduled watches;
- needs-attention filter with failed recent run;
- ready draft review state.

### Acceptance

- Enabled no longer reads as running.
- Scheduler copy clearly describes schedule-triggered watches.
- Failed recent runs give a next action without disabling or mislabelling the
  automation definition.
- Existing creation, draft, run, and scheduler controls continue to work.

## Slice 3: Model Workbench Beginner Setup Path

### Goal

Give new users a clear route from no usable provider to chat-ready or generation-ready
setup without making them understand provider transport first.

### Implementation Steps

1. Add provider setup intent helpers.
   - In `provider-workbench-view-models.ts`, derive empty/setup state and repair state.
   - Define setup intents: `chat` and `generation`.
   - Map templates and existing provider capabilities into the correct setup intent.

2. Update empty and blocked states.
   - No providers: show Add chat model and Add image generation model.
   - Image Generation no-model CTA should open Model Workbench in generation intent.
   - Missing API key: show one dominant Add API key action.

3. Update check feedback.
   - Chat check success points to conversations.
   - Generation check success points to Image Generation and says no real image was
     generated by the check.
   - Raw provider response remains in details.

4. Update provider editor/import wiring.
   - Pass setup intent into existing create sheet/editor/import flows.
   - Keep route distinction and same-model multi-base-URL display intact.

5. Update i18n and tests.

### API / Types

- No HTTP API or provider preset schema changes.
- Add frontend-only setup intent types if needed:
  - `ProviderSetupIntent = "chat" | "generation"`
  - `ProviderSetupStateView`
  - `ProviderRepairActionView`
- Do not change core generation resolver or provider normalization.

### Tests

- `corepack pnpm --filter @ling-stack/web check:i18n`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- model-workbench.spec.ts media-jobs.spec.ts app.spec.ts`

Scenario coverage:

- No providers shows Add chat model and Add image generation model.
- Image Generation no-model CTA opens generation setup path.
- Missing API key row has one dominant repair action.
- Chat check success points to conversations.
- Generation check success points to Image Generation and says no real image was
  generated.
- Same model through different routes remains distinguishable.

### Browser Validation

Check at `1440x960` and `1280x800`:

- empty Model Workbench;
- missing API key route;
- chat-ready route;
- generation-ready route;
- row check success and failure;
- Image Generation no-model handoff into Model Workbench.

### Acceptance

- A beginner can choose chat setup or generation setup from the first screen.
- API key repair is not buried among competing warnings.
- Check success is truthful about what was checked and where to use the model.

## Slice 4: Skill Library And Maintenance Compact Inspectors

### Goal

Make dense Settings support surfaces summary-first while keeping diagnostic evidence
available for support and development.

### Implementation Steps

1. Extract compact inspector pieces before layout changes.
   - Add a focused Skill Library compact inspector component or helper.
   - Add a focused Maintenance readiness summary component if needed.
   - Keep extraction local to Settings; do not create a broad design system.

2. Update Skill Library default inspector.
   - Show skill health/status, capability summary, and next action first.
   - Move metadata, raw source facts, health findings, references, and bundle details
     behind details disclosures.
   - No selected skill state stays compact and search-oriented.

3. Update Maintenance default inspector.
   - Show startup readiness summary and primary action first.
   - Show blockers when blocked.
   - Move daemon health, runner readiness, logs, and raw diagnostic facts into details.

4. Update focused CSS.
   - Use focused compact inspector classes in `settings.css` or a new Settings-focused
     stylesheet if the CSS growth becomes too broad.
   - Preserve dark-mode tokens.

5. Update i18n and tests.

### API / Types

- No HTTP API, skill registry, plugin manager, runner, or maintenance behavior changes.
- Add local view-model/helper types if needed:
  - `SkillCompactInspectorView`
  - `MaintenanceReadinessSummaryView`
- Do not change Settings routes or subnav structure.

### Tests

- `corepack pnpm --filter @ling-stack/web check:i18n`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts dark-mode.spec.ts`

Scenario coverage:

- Skill Library first screen shows summary before metadata.
- Skill metadata remains reachable through details.
- No skill selected state stays compact and searchable.
- Maintenance first screen shows readiness summary and primary action first.
- Startup diagnostic evidence remains reachable.
- Dark mode and no-overflow checks pass.

### Browser Validation

Check at `1440x960` and `1280x800`:

- Settings > Skill Library with selected skill;
- Skill Library no selected/search-empty state;
- Settings > Maintenance / Startup diagnostics;
- dark mode for both pages.

### Acceptance

- Dense support pages read as operational summaries first.
- Diagnostic evidence is preserved but not default-layer dominant.
- Large-file guardrail is respected by extracting before adding layout behavior.

## Cross-Slice Validation

Run after each slice:

- `git diff --check`
- `corepack pnpm --filter @ling-stack/web check:i18n`
- `corepack pnpm --filter @ling-stack/web typecheck`
- focused e2e for touched feature and `dark-mode.spec.ts` when visual structure changes.

Run after all P7 slices:

- `corepack pnpm --filter @ling-stack/web test:e2e -- media-jobs.spec.ts automations.spec.ts model-workbench.spec.ts settings.spec.ts dark-mode.spec.ts`
- Add `app.spec.ts` only if Model Workbench or Image Generation handoff touches global
  navigation or conversation entry points.

Desktop manual validation:

- Use the served artifact that contains the changed code.
- Check `1440x960` and `1280x800`.
- Confirm no document/body horizontal overflow.
- Confirm Chinese and English copy are both productized.

## Documentation Evidence

After each implementation slice, update this section with:

- touched surfaces;
- exact validation commands and results;
- browser source and viewport evidence;
- known residual risks;
- module-boundary notes.

### Slice 1 Evidence: Image Generation Real-Use Closure

- Implemented in Web feature view-model/UI only.
- Touched surfaces:
  - `apps/web/src/features/media/media-job-view-models.ts`
  - `apps/web/src/features/media/MediaJobsPage.tsx`
  - `apps/web/src/features/media/MediaJobList.tsx`
  - `apps/web/src/features/media/MediaJobDetailPanel.tsx`
  - `apps/web/src/styles/media.css`
  - `apps/web/src/i18n/locales/en-US.ts`
  - `apps/web/src/i18n/locales/zh-CN.ts`
  - `apps/web/e2e/media-jobs.spec.ts`
  - `apps/web/e2e/support/mock-daemon.ts`
- Behavior completed:
  - UI-only `starting` feedback is derived locally while the run request is in flight.
  - Stored media job statuses remain unchanged.
  - Ready jobs show Start generation; starting jobs show Starting generation/Starting;
    running jobs show Generating; completed jobs do not expose a primary Run action.
  - Failed jobs show product recovery copy first and keep raw provider/relay details in
    Generation details.
  - Completed jobs show View result, Copy prompt, and Copy result URL actions before
    lower-priority metadata.
- Validation:
  - `git diff --check` passed.
  - `corepack pnpm --filter @ling-stack/web check:i18n` passed.
  - `corepack pnpm --filter @ling-stack/web typecheck` passed.
  - `corepack pnpm --filter @ling-stack/web test:e2e -- media-jobs.spec.ts automations.spec.ts` passed, including media starting, failure recovery, completed-result actions, no-model routing, live run without media approval, and legacy waiting job direct run.
  - `corepack pnpm --filter @ling-stack/web test:e2e -- dark-mode.spec.ts` passed.
- Browser source:
  - Playwright served the changed Web artifact through the repo e2e web server.
- Residual risk:
  - No real provider call was made in this slice; real relay/provider wording should be
    checked again when validating against a live image generation route.

### Slice 2 Evidence: Automations State Friction

- Implemented in Web feature view-model/UI only.
- Touched surfaces:
  - `apps/web/src/features/automations/automation-view-models.ts`
  - `apps/web/src/features/automations/AutomationsPage.tsx`
  - `apps/web/src/features/automations/AutomationSchedulerStrip.tsx`
  - `apps/web/src/features/automations/AutomationListPane.tsx`
  - `apps/web/src/features/automations/AutomationExecutionInspector.tsx`
  - `apps/web/src/i18n/locales/en-US.ts`
  - `apps/web/src/i18n/locales/zh-CN.ts`
  - `apps/web/e2e/automations.spec.ts`
- Behavior completed:
  - Automation summary now separates enabled definitions, manual enabled definitions,
    scheduled enabled definitions, scheduler running state, scheduled watch count, failed
    recent runs, ready drafts, and scheduler-stopped attention.
  - Scheduler copy uses scheduled automations when it describes watch counts.
  - Running scheduler plus zero scheduled watches no longer sounds broken; with manual
    enabled definitions it explicitly says manual automations can still run now.
  - Needs attention count can include failed recent runs, definition errors, ready drafts,
    and scheduler stopped with scheduled watches.
  - Failed latest-run rows stay in enabled definitions and show Recent run failed plus
    Inspect failure.
- Validation:
  - `git diff --check` passed.
  - `corepack pnpm --filter @ling-stack/web check:i18n` passed.
  - `corepack pnpm --filter @ling-stack/web typecheck` passed.
  - `corepack pnpm --filter @ling-stack/web test:e2e -- media-jobs.spec.ts automations.spec.ts` passed, including manual-enabled plus zero scheduled watches and failed recent-run attention.
  - `corepack pnpm --filter @ling-stack/web test:e2e -- dark-mode.spec.ts` passed.
- Browser source:
  - Playwright served the changed Web artifact through the repo e2e web server.
- Residual risk:
  - Scheduler-stopped attention is represented in the banner and tab count; there is not
    yet a synthetic list row for the scheduler itself.

### Slice 3 Evidence: Model Workbench Beginner Setup Path

- Implemented in Web feature view-model/UI only.
- Touched surfaces:
  - `apps/web/src/features/providers/provider-workbench-view-models.ts`
  - `apps/web/src/features/providers/ProviderSettings.tsx`
  - `apps/web/src/features/providers/ProviderEditorPanel.tsx`
  - `apps/web/src/features/providers/ProviderRouteList.tsx`
  - `apps/web/src/lib/providers.ts`
  - `apps/web/src/app/AppShell.tsx`
  - `apps/web/src/styles/providers.css`
  - `apps/web/src/i18n/locales/en-US.ts`
  - `apps/web/src/i18n/locales/zh-CN.ts`
  - `apps/web/e2e/model-workbench.spec.ts`
  - `apps/web/e2e/media-jobs.spec.ts`
- Behavior completed:
  - Added the frontend-only `ProviderSetupIntent = "chat" | "generation"` path.
  - Empty Model Workbench now offers Add chat model and Add image generation model.
  - Chat setup opens a chat model sheet with chat-capable templates; generation setup opens
    an image generation model sheet with generation-capable templates.
  - Image Generation no-model CTA opens Model Workbench directly in generation setup intent.
  - Missing API key repair is promoted to Add API key.
  - Generation provider check success says configuration passed and clearly notes that the
    check does not create a real image; raw provider response stays in details.
- Validation:
  - `git diff --check` passed.
  - `corepack pnpm --filter @ling-stack/web check:i18n` passed.
  - `corepack pnpm --filter @ling-stack/web typecheck` passed.
  - `corepack pnpm --filter @ling-stack/web test:e2e -- model-workbench.spec.ts media-jobs.spec.ts settings.spec.ts dark-mode.spec.ts app.spec.ts` passed with 47 tests.
- Browser source:
  - Playwright served the changed Web artifact through the repo e2e web server.
- Residual risk:
  - `AppShell.tsx` carries only transient setup-intent routing state; if setup intents grow
    beyond Model Workbench handoff, move that state into a focused navigation helper.

### Slice 4 Evidence: Skill Library And Maintenance Compact Inspectors

- Implemented in Web Settings UI only.
- Touched surfaces:
  - `apps/web/src/features/settings/SkillCompactInspector.tsx`
  - `apps/web/src/features/settings/SkillLibrarySettingsPanel.tsx`
  - `apps/web/src/features/settings/SkillLibraryWidgets.tsx`
  - `apps/web/src/features/settings/MaintenanceSettingsPanel.tsx`
  - `apps/web/src/styles/settings.css`
  - `apps/web/src/i18n/locales/en-US.ts`
  - `apps/web/src/i18n/locales/zh-CN.ts`
  - `apps/web/e2e/settings.spec.ts`
  - `apps/web/e2e/dark-mode.spec.ts`
- Behavior completed:
  - Extracted `SkillCompactInspector` so the selected-skill pane is summary-first without
    adding more layout behavior to the already-large Skill Library panel.
  - Skill Library now shows status, source, stage, required tools, bound teammates, and the
    optimization preview action before raw source metadata.
  - Requirements, prompt fragments, source/raw details, and optimization result details are
    available through disclosures instead of dominating the default layer.
  - The source details disclosure no longer repeats the Preview optimization action already
    shown in the summary card.
  - Search/filter no-match state stays compact and does not silently fall back to the first
    skill.
  - Maintenance startup readiness now shows a summary card and blockers first, with startup
    phases, warmups, and raw diagnostics behind details.
- Validation:
  - `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts` passed after the
    duplicate Preview optimization action was removed.
  - `git diff --check` passed.
  - `corepack pnpm --filter @ling-stack/web check:i18n` passed.
  - `corepack pnpm --filter @ling-stack/web typecheck` passed.
  - `corepack pnpm --filter @ling-stack/web test:e2e -- model-workbench.spec.ts media-jobs.spec.ts settings.spec.ts dark-mode.spec.ts app.spec.ts` passed with 47 tests.
- Browser source:
  - Playwright served the changed Web artifact through the repo e2e web server.
- Residual risk:
  - `SkillLibrarySettingsPanel.tsx` and `SkillLibraryWidgets.tsx` remain large files. This
    slice extracted the compact inspector and kept widget edits narrow, but future Skill
    Library behavior should continue extracting before adding major logic.

## Hard Stops

- Stop if implementation requires daemon API changes.
- Stop if implementation requires changing persisted media, automation, provider, or
  skill statuses.
- Stop if implementation requires changing generation runtime resolver behavior.
- Stop if implementation requires scheduler behavior changes.
- Stop if implementation requires Settings IA or route changes.
- Stop if a protected large file needs major new behavior before a focused extraction.

## Assumptions

- Desktop Web remains the only acceptance target.
- Current P5/P6 shared presentation components remain available.
- P7 starts with Image Generation and Automations because they are user action surfaces.
- Model Workbench and compact inspectors can be implemented independently after the first
  two slices land.
