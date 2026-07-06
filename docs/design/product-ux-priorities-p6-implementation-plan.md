# Product UX Priorities P6 Implementation Plan

## Related Docs

- [P6 Design](product-ux-priorities-p6.md)
- [Product UX System P5](product-ux-system-p5.md)
- [Settings Visual Density Follow-up](settings-visual-density-followup.md)

## Summary

Implement P6 as four independent, UI-only slices. The order follows the product impact
and risk from the P6 design: Settings deep-page visual density first, then Work Board,
then Model Workbench beginner readiness, then narrow conversation polish.

This plan does not change backend APIs, contracts, persisted data, routes, primary
navigation, provider runtime behavior, scheduler behavior, or generation execution.

## Slice 1: Settings Deep-Page Visual Density

### Implementation Changes

- Audit Settings deep pages in the real desktop UI before editing: Interface,
  Permissions, Runtime, Connections, Skills, Skill Library, External Work, Archive, and
  Maintenance.
- Reduce default visible explanations in deep pages:
  - keep one page/task title;
  - keep the current status and primary action;
  - move repeated gray descriptions into details, local help, or lower diagnostic
    sections.
- Keep diagnostics available on Skill Library, Startup readiness, and External Work, but
  make their first screen summary-led.
- Keep `SettingsSubnav` description rendering opt-in; do not reintroduce persistent tab
  descriptions.
- Prefer focused Settings panel components or small helpers before adding logic to large
  Settings files.

### Tests

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts dark-mode.spec.ts`
- Browser checks at `1440x960` and `1280x800` for Settings home, Skill Library,
  External Work, Maintenance, and Permissions.

### Acceptance

- Settings deep pages are visibly calmer on first load.
- No Settings entry disappears.
- Diagnostic evidence remains accessible.
- No horizontal overflow or dark-mode token regression.

## Slice 2: Work Board Mental Model

### Implementation Changes

- Keep Work Board as Settings/contextual only.
- Review default scope, filter display, row copy, empty states, and detail actions.
- Make the first screen emphasize actionable work and blocked reasons.
- Keep advanced filters compact when inactive; expose filter summaries only when useful.
- Ensure detail pane always shows one clear next step or a clear "no action needed" state.
- Keep work item derivation, claim/release/heartbeat/complete/fail, routing, and open
  context behavior unchanged.

### Tests

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- work-board.spec.ts settings.spec.ts dark-mode.spec.ts`
- Browser checks at `1440x960` and `1280x800` for Work Board actionable, blocked,
  filtered-empty, and history views.

### Acceptance

- Work Board reads as an action review surface, not a raw operations table.
- Empty and filtered states explain what happened and where to go next.
- Existing work item actions continue to work.
- Work Board still does not appear in primary navigation.

## Slice 3: Model Workbench Beginner Readiness

### Implementation Changes

- Add an outcome-based readiness summary to Model Workbench using existing provider
  runtime/view-model data.
- Summarize chat readiness, generation readiness, missing keys/routes, and disabled
  routes without exposing transport or adapter language in the primary layer.
- Tighten check-result copy:
  - configuration check passed;
  - check does not generate real images;
  - real generation happens from Generation tasks;
  - unsupported generation model means recognized but not connected to a real adapter.
- Preserve current provider row density, multi-route distinction, import/search/select
  visible/clear/import selected, row check, batch check, save, delete, toggle, and repair
  behavior.
- Keep advanced provider terminology in editor/details where exact configuration matters.

### Tests

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- model-workbench.spec.ts media-jobs.spec.ts app.spec.ts`
- Browser checks at `1440x960` and `1280x800` for no providers, missing key, ready chat,
  ready generation, unsupported generation adapter, and multi-route rows.

### Acceptance

- A beginner can tell whether chat and image generation are usable from the first screen.
- Check success no longer sounds like real media generation.
- Same model through different routes remains clearly separated.
- Generation model filtering and chat model filtering do not regress.

## Slice 4: Conversation Interaction Polish

### Implementation Changes

- Do not refactor conversation shells.
- Audit normal conversation, channel conversation, and AI teammate private chat in the
  real desktop UI.
- Fix only concrete, visible issues:
  - empty or blocked copy;
  - disabled reasons;
  - composer button loading/disabled state;
  - attachment, stop, retry, and guidance controls;
  - menu icon/text alignment;
  - popover overflow or message-surface shifting;
  - dark-mode hardcoded surfaces.
- Extract a small presentational component only when at least two surfaces need the same
  visual treatment and it does not own conversation state.

### Tests

- `corepack pnpm --filter @ling-stack/web typecheck`
- Focused e2e by touched surface:
  - `app.spec.ts`
  - `channel.spec.ts`
  - `teammates.spec.ts`
  - `dark-mode.spec.ts`
- Browser checks at `1440x960` and `1280x800` for home conversation, channel, and
  private chat.

### Acceptance

- Conversation, channel, and private chat keep distinct product semantics.
- Composer and popover interactions feel stable.
- No broad `WorkspaceClientView`, `ConversationHome`, or private-chat refactor lands in
  this slice.

## Module Boundaries

- Shared P5 components remain presentational and do not import Settings, Work Board,
  provider, or conversation domain logic.
- Feature-owned view-models provide product labels, summaries, disabled reasons, and
  state mapping.
- `i18n.tsx` remains runtime/provider only; add copy to locale modules.
- Large-file guardrails stay active:
  - extract before adding major behavior to Settings deep panels;
  - avoid expanding `GlobalWorkBoardPage` unless a focused helper/component is smaller;
  - do not use P6 to grow conversation shell files.

## Validation And Evidence

For each slice, record implementation evidence here after landing:

- touched surfaces;
- screenshot or browser-check source and served artifact URL;
- validation commands and results;
- known residual risks;
- large-file/module-boundary notes.

Initial validation for documentation-only landing:

- `git diff --check`

### Slice 1 Evidence: Settings Deep-Page Visual Density

- Touched surfaces:
  - Settings deep panels: External Work, Startup and diagnostics, Skill policy, Skill
    library, Archived items.
  - Shared Settings styling: `.settings-compact-details` for progressive disclosure.
  - Dark-mode regression coverage updated to assert the new default-visible Skill policy
    layer instead of collapsed detail content.
- Served artifact:
  - Browser checks used the running Vite dev server at `http://127.0.0.1:5173/`.
- Validation commands:
  - `corepack pnpm --filter @ling-stack/web check:i18n` passed.
  - `corepack pnpm --filter @ling-stack/web typecheck` passed.
  - `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts dark-mode.spec.ts`
    passed with 16 tests.
- Desktop browser checks:
  - `1440x960` and `1280x800` checked Settings initial, Interface, Default
    authorization, External Work, MCP tools, Plugin Manager, Skills policy, Skill
    library, Archived items, and Startup diagnostics.
  - No horizontal overflow was observed on the checked pages.
  - High-evidence pages still show denser status text where it is task data rather than
    repeated explanation: Skill Library stats/inspector, Archived item timestamps, and
    Startup readiness requirements.
- Known residual risks:
  - Skill Library remains the densest Settings surface because the inspector presents
    real skill metadata; a future slice can add a compact inspector mode if needed.
  - Startup readiness still shows multiple required-status labels in the first screen;
    this is retained as operational state, not explanatory copy.
- Module-boundary notes:
  - No backend, route, schema, state-machine, or IA changes.
  - No major new logic was added to large Settings files; changes are copy/layout
    reduction and focused CSS.

### Slice 2 Evidence: Work Board Mental Model

- Touched surfaces:
  - Settings-embedded Work Board toolbar now shows a compact work summary:
    actionable, blocked, active, and history counts.
  - Existing Work Board tabs, filters, claim, heartbeat, route, refresh, and open-context
    actions are unchanged.
- Served artifact:
  - Browser checks used the running Vite dev server at `http://127.0.0.1:5173/`.
- Validation commands:
  - `corepack pnpm --filter @ling-stack/web check:i18n` passed.
  - `corepack pnpm --filter @ling-stack/web typecheck` passed.
  - `corepack pnpm --filter @ling-stack/web test:e2e -- work-board.spec.ts model-workbench.spec.ts settings.spec.ts dark-mode.spec.ts channel.spec.ts`
    passed with 123 tests.
- Desktop browser checks:
  - `1440x960` and `1280x800` checked Settings > Work Board.
  - No document/body/page horizontal overflow was observed.
  - The Settings toolbar retained tabs, filters, refresh, and the new summary without
    reintroducing the full Work Board page header.
- Known residual risks:
  - The summary is intentionally compact and does not replace detailed filters or row
    explanations; future work can tune the exact count labels if real work-item volume
    suggests a different hierarchy.
- Module-boundary notes:
  - No backend, route, schema, state-machine, or IA changes.
  - The change stays inside the Work Board feature surface and existing i18n locale
    modules.

### Slice 3 Evidence: Model Workbench Beginner Readiness

- Touched surfaces:
  - Provider Workbench view-model summary now derives chat-ready, generation-ready,
    missing-key, and disabled counts from existing provider runtime data.
  - Model Workbench header shows a compact readiness strip in both standalone and
    Settings-embedded modes.
  - Provider row, discovery/import, save, check, delete, toggle, and multi-route behavior
    are unchanged.
- Served artifact:
  - Browser checks used the running Vite dev server at `http://127.0.0.1:5173/`.
- Validation commands:
  - `corepack pnpm --filter @ling-stack/web check:i18n` passed.
  - `corepack pnpm --filter @ling-stack/web typecheck` passed.
  - `corepack pnpm --filter @ling-stack/web test:e2e -- work-board.spec.ts model-workbench.spec.ts settings.spec.ts dark-mode.spec.ts channel.spec.ts`
    passed with 123 tests.
- Desktop browser checks:
  - `1440x960` and `1280x800` checked Settings > Model Workbench.
  - No document/body/page horizontal overflow was observed.
  - The readiness strip showed outcome labels without restoring the removed Settings
    return row or page-level duplicate header.
- Known residual risks:
  - The summary is count-based. If users need a setup wizard later, that should be a
    separate design slice instead of expanding the header.
- Module-boundary notes:
  - No provider runtime, generation resolver, API, route, schema, or IA changes.
  - The readiness derivation lives in the provider feature view-model, not shared P5
    presentation components.

### Slice 4 Evidence: Conversation Interaction Polish

- Touched surfaces:
  - Channel composer `Add` popover now uses single-line actions: attach files, Plan Mode,
    and Goal.
  - The previous explanatory small text remains available as `title` copy but is no
    longer shown as gray secondary menu text.
  - Normal conversation and private chat were audited but not changed because no equally
    concrete issue was found that would improve the first screen without adding more
    explanatory text.
- Served artifact:
  - Browser checks used the running Vite dev server at `http://127.0.0.1:5173/`.
- Validation commands:
  - `corepack pnpm --filter @ling-stack/web check:i18n` passed.
  - `corepack pnpm --filter @ling-stack/web typecheck` passed.
  - `corepack pnpm --filter @ling-stack/web test:e2e -- work-board.spec.ts model-workbench.spec.ts settings.spec.ts dark-mode.spec.ts channel.spec.ts`
    passed with 123 tests.
- Desktop browser checks:
  - `1440x960` and `1280x800` checked a real channel composer popover.
  - The popover contained no `.composer-add-menu-row small` elements and no
    document/body horizontal overflow.
- Known residual risks:
  - Conversation surfaces remain large and intentionally separate. Future polishing
    should continue to be evidence-driven and avoid generic shell refactors.
- Module-boundary notes:
  - No conversation state ownership or composer behavior changed.
  - No major behavior was added to `ConversationHome`, `WorkspaceClientView`, or private
    chat surfaces.

## Assumptions

- Desktop Web remains the only acceptance target.
- Current P0-P5 product semantics stay in force.
- P6 is UI/product interaction polish, not IA redesign.
- Existing dirty worktree changes are preserved and not reverted.
- If any slice requires backend, route, schema, or state-machine changes, stop and add a
  separate design document before implementation.
