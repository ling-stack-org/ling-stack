# Product UX System P5 Implementation Plan

## Summary

Implement [Product UX System P5](product-ux-system-p5.md) as a docs-first UX
systemization track. The first implementation slice is now landed for the highest-risk
surfaces: image generation, automations, Settings workspace tools, sidebar action menus,
and channel / AI teammate creation dialogs.

P5 should make future visual and interaction work more consistent without turning Ling
into a new design-system project. The implementation should happen through small slices:
inventory, shared UI boundary extraction, and targeted adoption on the roughest surfaces.

## Implementation Status

Status: first implementation slice completed on 2026-07-03.

Completed scope:

- Added presentational shared components in `apps/web/src/shared/components`:
  `PageActionHeader`, `OperationEmptyState`, `StatusActionRow`, `ActionMenuItem`, and
  `DialogSection`.
- Added focused CSS modules: `page-shells.css`, `operation-states.css`, and
  `action-menus.css`; continued using `creation-dialogs.css` for creation flows.
- Migrated image generation to shared page header, empty/configuration state, row action,
  and creation dialog section patterns.
- Extracted automation creation dialogs out of `AutomationsPage.tsx` and adopted shared
  header, empty state, status rows, and scheduler/action layout.
- Migrated Settings workspace tools to `StatusActionRow` while preserving legacy row
  selectors used by dark-mode and navigation tests.
- Migrated sidebar section menus to `ActionMenuItem` while preserving fixed icon cell and
  rich-menu alignment anchors.
- Migrated channel and AI teammate creation dialogs to `CreateDialogShell` plus
  `DialogSection` without changing their domain payloads.
- Kept Work Board as a Settings workspace tool and did not add a new `ViewId`.

Out of scope for this slice:

- Model Workbench visual migration beyond existing P4/P1 behavior.
- Council Workspace list/detail migration.
- Full conversation shell unification across normal conversation, channel, and private
  chat.
- P2 AppShell/domain modularization.

## Key Changes

1. Documentation:
   - Add the P5 design contract.
   - Add this implementation plan.
   - Link both from Product Semantic Convergence.
   - Mark P4 as implemented and P5 implementation status explicitly.

2. UX Inventory:
   - Review the first screen and primary workflow of home, channels, private chat, image
     generation, automations, Settings, Model Workbench, Council Workspace, and Work
     Board.
   - Record the served artifact for evidence: dev server, built `dist`, static preview,
     or other runtime.
   - Record inconsistencies in page headers, primary actions, empty/blocked states,
     menus, status labels, scroll regions, and dark mode.
   - Classify findings as product-language, interaction, layout, style-boundary, or test
     coverage issues.
   - Identify which file would own the fix and whether that file is protected by the
     large-file guardrails.

3. Shared UI Boundary:
   - Identify small presentational components worth extracting, such as page header,
     toolbar/action group, empty/blocking state, status/action row, dialog section, and
     aligned action menu.
   - Prefer focused CSS modules over adding more rules to giant global CSS files.
   - Keep domain logic in feature pages or view-model helpers.
   - Extract a shared component only when the inventory shows two or more surfaces need
     the same behavior.
   - Keep shared components unaware of provider, media, automation, council, channel, or
     teammate domain rules.

4. Targeted Adoption:
   - Start with surfaces already touched by P4: image generation, automations, Settings
     workspace tools, channel create, AI teammate create, and sidebar menus.
   - Migrate one pattern at a time and keep each slice independently testable.
   - Stop if a change requires P2 shell/domain modularization.

## Module Boundaries

- Shared UI components are presentational and live in `shared/components`.
- Feature view-model helpers own labels, status mapping, and disabled reasons.
- New styles use focused CSS modules when possible.
- `AppShell.tsx` should only pass routes, modal open state, or existing callbacks.
- Existing large files remain protected: extract before adding new behavior to them.

## API / Types

- No HTTP API changes.
- No contract changes.
- No database or persisted state changes.
- No new `ViewId`.
- No changes to media runtime resolver, provider checks, scheduler runtime, or archive
  persistence.

## Slice Plan

### Slice 1 - UX Inventory

- Produce an inventory table under the P5 docs or a follow-up companion doc.
- For each target surface, capture:
  - primary user job,
  - current first-screen state,
  - primary action,
  - empty/blocked state behavior,
  - status wording,
  - scroll owner,
  - dark-mode risk,
  - large-file risk.
- Include a proposed owner for each issue:
  - shared component,
  - focused CSS module,
  - feature view-model/helper,
  - feature page wiring,
  - e2e/test-only update,
  - out of scope for P5.
- Use the issue categories from the P5 design contract:
  - product-language,
  - interaction,
  - layout,
  - style-boundary,
  - test coverage.
- Required surface checks:
  - Home/conversation: duplicate actions, model state, composer/thread scroll.
  - Channels: create-channel entry, progress popover stability, branch/menu consistency.
  - AI teammate private chat: teammate identity, model readiness, shared thread visuals.
  - Image Generation: runnable/blocked model states, active task wording, detail disabled
    reasons.
  - Automations: enabled/run distinction, scheduler strip, create choices.
  - Settings: workspace tool rows, subnav consistency, horizontal overflow.
  - Model Workbench: route labels, multi-model import, capability labels.
  - Council Workspace: council list/detail, member actions, no AI Teammates leakage.
  - Work Board: contextual status, filters, no primary-nav assumptions.
- No code changes in this slice.
- Exit criteria:
  - Every target surface has an inventory row.
  - Every P5 finding has a proposed owner and acceptance note.
  - No finding is assigned to `AppShell.tsx` or a protected large CSS file without an
    extraction note.

### Slice 2 - Shared UI Boundaries

- Propose minimal shared boundaries based on inventory evidence.
- Candidate boundaries:
  - `PageActionHeader` for title, summary, refresh, and primary action.
  - `OperationEmptyState` for empty and blocked work surfaces.
  - `StatusActionRow` for compact row status plus action controls.
  - `DialogSection` for creation-dialog sections.
  - `ActionMenuItem` or CSS rules for aligned icon/text menus.
- Implement only the boundaries that remove duplication in at least two surfaces.
- Suggested style boundaries:
  - `page-shells.css` for page header/action layout.
  - `operation-states.css` for empty/blocked/disabled state blocks.
  - `action-menus.css` for aligned menus and icon cells.
  - `creation-dialogs.css` for dialog section grammar.
- Component acceptance gates:
  - No domain-specific imports from media, automation, provider, teammate, channel, or
    council feature folders.
  - Props carry display labels, state labels, disabled reasons, and callbacks only.
  - Component tests/e2e target the adopting feature, not an artificial demo page.
  - CSS does not introduce a new palette, typography scale, or global reset.
- Exit criteria:
  - At least one shared boundary is documented with two adoption targets before code.
  - Any extracted component has a focused CSS/module boundary.
  - Protected large files lose or keep steady-state responsibility; they do not gain new
    product logic.

### Slice 3 - Targeted Adoption

- Adopt shared boundaries in focused passes:
  1. Image generation list/detail/create and automation scheduler/create, because these
     have the highest product-language and status clarity risk.
  2. Settings workspace tools and sidebar section menus, because they define navigation
     trust and low-frequency tool discoverability.
  3. Channel and AI teammate creation, because they should share the same creation-dialog
     grammar while preserving their different domain fields.
  4. Conversation, channel, and private-chat shared states, but only after the inventory
     proves the shared visual shell will not blur surface ownership.
- Each pass keeps visible behavior stable except for documented UX cleanup.
- Each pass updates or adds e2e assertions for the adopted pattern.
- Each pass must include before/after notes in the implementation PR or final report:
  - which P5 rule it adopted,
  - which files changed,
  - which protected files were avoided or extracted,
  - which screenshot/dev-server checks were performed.
- Exit criteria:
  - No horizontal overflow at `1440x960` or `1280x800` for the adopted surface.
  - Primary action is singular and stable.
  - Menu icon/text alignment is stable where menus were touched.
  - Dark mode uses existing tokens and does not introduce hardcoded light panels.

## Stop Conditions

Stop the P5 slice and write a follow-up design note instead of continuing if a change
requires any of the following:

- Moving Work Board into primary navigation.
- Adding a new `ViewId` or route model.
- Reworking `AppShell.tsx` domain ownership.
- Changing daemon APIs, provider/media/automation contracts, database schema, or runtime
  state machines.
- Introducing a new global color, typography, spacing, or animation system.
- Adding major behavior to a protected large file without an extraction step.
- Making mobile behavior part of acceptance.

## Documentation Evidence

Each implemented P5 slice should leave lightweight evidence in the final report or
follow-up doc:

- The P5 rule or pattern adopted.
- The surfaces touched.
- The before/after user-facing outcome.
- The served artifact used for visual verification.
- The commands and e2e files run.
- Any remaining large-file or module-boundary risk.

### 2026-07-03 Evidence

Adopted patterns:

- `PageActionHeader`: image generation and automations.
- `OperationEmptyState`: image generation blocked/no-model state and automation empty
  list states.
- `StatusActionRow`: generation task rows/detail actions, automation rows, and Settings
  workspace tool rows.
- `ActionMenuItem`: sidebar section menus for channel, teammate, and recent conversation
  actions.
- `DialogSection`: image generation, channel creation, and AI teammate creation dialogs.

User-facing outcome:

- First-screen actions are less duplicated.
- Settings workspace tools remain compact and scan-friendly while using the shared row
  pattern.
- Sidebar menus keep icon/text alignment and hover/focus clickability.
- Creation dialogs share the same section grammar and keep advanced settings folded.
- Channel message feed now surfaces background failure feedback when the user is reading
  older messages and a failed reply arrives.

Verification:

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- media-jobs.spec.ts automations.spec.ts`
- `corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts channel.spec.ts teammates.spec.ts settings.spec.ts dark-mode.spec.ts`
- `git diff --check`

Remaining boundary risk:

- `AppShell.tsx`, `i18n.tsx`, `components.css`, `settings.css`, `sidebar.css`, and
  `teammates.css` are still protected large files. This slice avoided adding new
  product logic to them, but future P5 adoption should continue extracting focused
  components/CSS before adding behavior.
- `AutomationsPage.tsx` was reduced by extracting creation dialogs, but additional
  automation UX changes should continue moving scheduler/detail/create sub-surfaces into
  focused components.

## Test Plan

Documentation phase:

- Verify the P5 docs are linked from `product-semantic-convergence.md`.
- Verify P4 is marked implemented and P5 implementation status is current.
- Run `git diff --check`.

Future implementation phase:

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts channel.spec.ts teammates.spec.ts`
- `corepack pnpm --filter @ling-stack/web test:e2e -- media-jobs.spec.ts automations.spec.ts settings.spec.ts dark-mode.spec.ts`
- Desktop dev-server checks at `1440x960` and `1280x800` for no horizontal overflow,
  stable primary actions, aligned menus, and dark-mode parity.

## Risks

- P5 can become vague if inventory does not name concrete inconsistencies.
- Shared components can become over-abstracted if they are introduced before two real
  surfaces need the same pattern.
- Large CSS and page files can absorb new UX work unless extraction is enforced.
- Some old e2e assertions may encode raw implementation labels and need deliberate
  product-language updates.

## Assumptions

- P5 is UX systemization after P4, not P2 architecture work.
- Work Board remains a Settings workspace tool in P5.
- Desktop Web is the only acceptance scope.
- Existing dirty worktree changes are preserved and not reverted.
