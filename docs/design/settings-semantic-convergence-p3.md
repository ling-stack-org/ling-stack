# Settings Semantic Convergence P3

## Related Docs

- [Product Semantic Convergence](product-semantic-convergence.md)
- [Settings Semantic Convergence P2](settings-semantic-convergence-p2.md)
- [Settings Semantic Convergence P3 Implementation Plan](settings-semantic-convergence-p3-implementation-plan.md)
- [Settings Visual Density Follow-up](settings-visual-density-followup.md)
- [Settings Personalization And Ling Conversation Tone](settings-personalization-and-ling-tone.md)

## Summary

P3 finishes the product-language pass for Settings. P2 split profile identity from
interface preferences and made Settings sections answer "what am I managing?". P3 keeps
that structure and refines the remaining Settings pages so their nested surfaces read as
user jobs before exposing implementation terms.

This is a Settings IA, copy, and local style-boundary pass. It does not change daemon
APIs, storage, routes, runtime behavior, model/provider logic, or workspace data.

Follow-up: [Settings Personalization And Ling Conversation Tone](settings-personalization-and-ling-tone.md)
supersedes this document's `Skills -> Skill policy / Skill library` grouping for future
implementation work. The follow-up moves `Skill policy` under `Personalization`, keeps
`Skill library` as a standalone Settings item, and adds the behavior-bearing
`Ling conversation tone` setting.

The product target is simple:

- Configuration overview opens low-frequency workspace setup and work-control surfaces.
- Runtime and permissions groups authorization, exact tool policy, and local execution
  runners.
- Connections groups work intake, tool servers, and plugin bundles.
- Skills groups skill policy and the skill library.
- Data and diagnostics groups archived data and system health.

## Goals

- Make every Settings sub-surface answer "what job is the user doing here?".
- Keep technical names such as MCP, GitHub, Linear, Plugin Manager, startup phases, and
  run diagnostics inside the detail panels where they are useful.
- Keep Settings fullscreen and preserve nested workspace-tool return paths.
- Keep Configuration overview compact and work-focused, using grouped rows rather than a
  broad card launcher.
- Give Settings subnavs, row lists, empty states, and action surfaces one consistent
  visual rhythm.
- Keep default Settings surfaces low-noise: navigation names destinations, panels own
  task titles, and explanations appear only where they unblock a concrete action.
- Prevent new Settings work from making already-large files larger without a clear
  boundary.

## Non-goals

- No backend API, contract, database, or migration change.
- No route deletion and no new `ViewId`.
- No global visual redesign.
- No mobile acceptance scope.
- No Work Board primary-nav promotion.
- No large refactor of `AppShell.tsx`.
- No behavior change inside the 1000+ line `SkillLibrarySettingsPanel.tsx`.
- No source-file rename churn for existing implementation components such as
  `IntegrationsSettingsPanel.tsx`; visible product labels may change without renaming
  every internal file.

## Current Findings

- P2 has already split Settings into:
  `Configuration overview`, `User profile`, `Interface and language`,
  `Runtime and permissions`, `Connections`, `Skills`, and `Data and diagnostics`.
- Current code already has a reusable `SettingsSubnav` used by Runtime, Connections,
  Skills, and Data.
- Current code already has grouped Configuration overview rows:
  `Workspace setup` and `Work controls`.
- Desktop review at a 1440px viewport showed no global horizontal overflow in Settings
  and no visible overflow in current Settings subnavs.
- The main remaining risk is not the high-level visual direction. The risk is continued
  growth of `settings.css`, `i18n.tsx`, `AppShell.tsx`, and the large Skill Library panel
  while doing small copy/layout improvements.

## Target IA

```text
Settings
  Configuration overview
    Workspace setup
      -> Model Workbench
      -> Teammate Management
      -> Council Workspace
    Work controls
      -> Work Board
      -> Default authorization

  Personal
    User profile

  Preferences
    Interface and language

  Workspace
    Runtime and permissions
      -> Default authorization, tool permission policy, and execution runners
    Connections
      -> Work intake
      -> Tool servers
      -> Plugin bundles
    Skills
      -> Skill policy
      -> Skill library

  Maintenance
    Data and diagnostics
      -> Archived data
      -> System health
```

## Section Semantics

| Surface | User job | Keep technical terms where |
| --- | --- | --- |
| Configuration overview | Open low-frequency setup and control surfaces | Tool row details |
| Workspace setup | Prepare the models and AI collaborators Ling uses | Model/provider detail pages |
| Work controls | Review workspace work and default authorization | Work Board detail pages, policy details |
| Default authorization | Choose how new conversations get permission | Permission preset explanations |
| Tool permission policy | Tune exact tool decisions and write boundaries | Advanced policy details |
| Execution runners | Choose allowed local execution runners | Runner detail rows |
| Connections | Connect Ling to outside systems | Detail panel names when useful |
| Work intake | Connect external work entering a channel | GitHub/Linear setup fields |
| Tool servers | Manage AI-accessible MCP servers | MCP detail page and server rows |
| Plugin bundles | Manage trusted capability packages | Plugin detail cards |
| Skill policy | Control generation, recording, and publication rules | Policy details |
| Skill library | Inspect reusable skill definitions and source health | Registry/detail rows |
| Archived data | Restore archived product objects | Archive item rows |
| System health | Inspect startup readiness and support diagnostics | Startup phases and diagnostics |

## Copy Rules

- Prefer product labels in Settings navigation and subnavs.
- Keep acronyms and implementation names only when the user is inspecting that system:
  MCP in Tool servers, GitHub/Linear in Work intake, plugin package data in Plugin bundles,
  startup phases in System health.
- Use "Default authorization" for the high-level default users choose before a new
  conversation.
- Use "Tool permission policy" only for exact tool decisions and write path boundaries.
- Use "System health" for startup readiness and support diagnostics; do not label the
  main navigation as raw diagnostics.
- Use "Archived data" for restore surfaces; do not imply permanent deletion.

## Visual And Style Rules

- Keep Settings quiet, dense, and operational. Do not introduce hero layouts, marketing
  cards, or decorative visual treatment.
- Configuration overview should use grouped rows. Cards are acceptable only for concrete
  controls such as default authorization, permission presets, or status summaries.
- Settings subnavs should be reserved for genuinely mutually exclusive content, such as
  Connections, Skills, or Data views. Runtime permission setup is a continuous workflow:
  Default authorization, Tool permission policy, and Execution runners stay visible in
  one vertical page.
- Reusable Settings subnavs should be a single compact segmented row with stable height,
  consistent badge treatment, and no layout shift when badges appear.
- Long labels and descriptions must truncate or wrap intentionally without pushing action
  buttons off-screen.
- No horizontal overflow on desktop Settings pages.
- Scroll should belong to the Settings content pane, not the whole app shell.
- The dark theme must continue to use existing Settings tokens; do not introduce a new
  palette for this pass.
- Use lucide icons where an icon is needed, and keep icon sizes aligned with existing
  Settings rows.

## Module Boundaries

- `apps/web/src/features/settings/SettingsPage.tsx`
  owns the section list and panel routing. It should not own nested subnav business logic.
- `apps/web/src/features/settings/SettingsSubnav.tsx`
  owns the compact subnav presentation shared by Settings panels that still have
  mutually exclusive views.
- `apps/web/src/features/settings/SettingsWorkspaceToolsPanel.tsx`
  owns Configuration overview grouping and workspace tool rows.
- `apps/web/src/features/settings/ExecutionPermissionsSettingsPanel.tsx`
  owns the continuous Runtime permission flow and renders Default authorization, Tool
  permission policy, and Execution runners together.
- `apps/web/src/features/settings/IntegrationsSettingsPanel.tsx`
  owns Connections subnav labels and sub-surface composition.
- `apps/web/src/features/settings/SkillsSettingsPanel.tsx`
  owns Skills subnav labels and sub-surface composition.
- `apps/web/src/features/settings/MaintenanceSettingsPanel.tsx`
  owns Data and diagnostics subnav labels and sub-surface composition.
- `apps/web/src/styles/settings.css`
  currently owns all Settings styling. P3 may reorganize comments and extract a focused
  Settings style module only if the project style loader already supports it.
- `apps/web/src/i18n.tsx`
  receives copy keys only; do not use translations as control flow.

## API / Types

- No public HTTP API change.
- No contract change.
- No persistent state change.
- Existing Settings section ids remain frontend-only UI state.
- Subsection ids can stay local component state.

## State / Data Flow

```text
Settings section click
  -> SettingsPage activeSection
  -> focused Settings panel
```

```text
Settings subsection click
  -> panel-local activeSubsection
  -> focused sub-surface
```

Runtime and permissions is intentionally not a subsection tab flow. It reads
top-to-bottom as: choose the default authorization, inspect or adjust the exact tool
policy, then choose allowed execution runners.

```text
Configuration overview tool click
  -> AppShell existing workspaceToolDetail
  -> nested tool page
  -> Settings left navigation stays available
```

## Hard Stops

- Do not add Settings business logic to `AppShell.tsx`.
- Do not add a Work Board primary sidebar entry as part of P3.
- Do not hide or remove Model Workbench, Teammate Management, Council Workspace, Work
  Board, Default authorization, MCP tools, plugins, archived data, or system health.
- Do not rename API/storage concepts just to match UI copy.
- Do not expand `SkillLibrarySettingsPanel.tsx` with new behavior in this pass.
- Do not add a new visual system or palette.
- Do not make Settings depend on mobile-specific acceptance.

## Test Plan

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts`
- `corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts dark-mode.spec.ts profile.spec.ts mcp.spec.ts runtime.spec.ts`
- Optional browser check on the served desktop Web app:
  - Configuration overview has `Workspace setup` and `Work controls`.
  - Runtime page shows `Default authorization`, `Tool permission policy`, and
    `Execution runners` as visible vertical sections.
  - Connections subnav has `Work intake`, `Tool servers`, and `Plugin bundles`.
  - Skills subnav has `Skill policy` and `Skill library`.
  - Data subnav has `Archived data` and `System health`.
  - No Settings page creates horizontal overflow at desktop width.

## Acceptance Checklist

- [x] Configuration overview shows `Workspace setup` and `Work controls` groups.
- [x] Runtime sections read `Default authorization`, `Tool permission policy`, and
      `Execution runners`, and are visible together without a nested tab.
- [x] Connections subsections read `Work intake`, `Tool servers`, and `Plugin bundles`.
- [x] Skills subsections read `Skill policy` and `Skill library`.
- [x] Data subsections read `Archived data` and `System health`.
- [x] Settings nested workspace tools still hide the global sidebar and return to
      Configuration overview.
- [x] Settings subnavs use one reusable presentation pattern.
- [x] Dark mode still follows existing Settings tokens.
- [x] No daemon API, contracts, storage, or routes change.

## Implementation Evidence

- Audit found the P3 implementation mostly present: `SettingsSubnav`, grouped
  Configuration overview, Connections/Skills/Data subnavs, Runtime continuous sections,
  and related i18n keys already existed.
- Added focused e2e assertions for P3 Settings labels, Runtime continuous sections, and
  remaining subnav behavior in `apps/web/e2e/settings.spec.ts`.
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts`
- `corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts dark-mode.spec.ts profile.spec.ts mcp.spec.ts runtime.spec.ts`
- Desktop served-app check at `1440x960`: Settings overview, Runtime, Connections,
  Skills, Data, and Interface pages had no horizontal overflow.

## Risks

- E2E tests select by visible labels; update assertions with the product labels rather
  than broad regexes that preserve old names.
- `SkillLibrarySettingsPanel.tsx` is already over 1000 lines. Keep P3 to copy and layout
  semantics unless a separate extraction is approved.
- `settings.css` is large. Style changes should be scoped and preferably grouped by
  Settings shell, workspace tools, subnavs, panels, and dense rows.
- `i18n.tsx` is large. Add only short copy keys needed for the new labels.
- Some internal component filenames still say `Integrations` or `Maintenance`; that is
  acceptable in P3 if visible product language is correct.

## Assumptions

- Desktop Web is the acceptance target.
- P3 is still a Settings-focused product semantics pass, not a full app redesign.
- Settings can keep a compact row/list visual system.
- Existing implementation already covers part of P3; implementation should audit before
  adding new code.

## Open Questions

- Should `settings.css` be split in P3, or should style extraction be a P4 cleanup after
  label and layout semantics are stable?
- Should Work Board promotion require usage evidence before P2/P3 roadmap changes?
