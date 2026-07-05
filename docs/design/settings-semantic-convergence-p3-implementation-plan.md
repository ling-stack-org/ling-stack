# Settings Semantic Convergence P3 Implementation Plan

## Summary

Implement [Settings Semantic Convergence P3](settings-semantic-convergence-p3.md) as a
focused Settings IA, copy, and local style-boundary pass. The goal is to finish the
visible Settings language started in P2 without changing daemon APIs, storage, routes, or
runtime behavior.

Current code already appears to contain part of the desired P3 structure:
`SettingsSubnav`, `Workspace setup`, `Work controls`, Runtime subnavs, Connections
subnavs, Skills subnavs, and Data subnavs. Implementation should start with an audit and
only patch missing or inconsistent pieces.

## Goals

- Confirm and complete the P3 Settings labels and grouped surfaces.
- Keep Configuration overview as a grouped row list, not a card launcher.
- Keep all nested workspace tools reachable and returning to Settings.
- Keep Settings style compact, dense, and consistent with existing tokens.
- Avoid adding behavior to large shell files.
- Update tests so P3 product labels become regression coverage.

## Non-goals

- No daemon API, contracts, database, or migration change.
- No new route or `ViewId`.
- No Work Board primary sidebar promotion.
- No global visual redesign.
- No mobile acceptance.
- No behavior changes in `SkillLibrarySettingsPanel.tsx`.
- No broad source-file rename churn for internal filenames.

## Key Changes

1. Audit current implementation:
   - Verify `SettingsPage.tsx` has the P2/P3 section list.
   - Verify `SettingsWorkspaceToolsPanel.tsx` has `Workspace setup` and `Work controls`.
   - Verify Runtime, Connections, Skills, and Data panels use `SettingsSubnav`.
   - Verify Settings nested workspace tools still hide the global sidebar while keeping
     the Settings left navigation available.

2. Complete missing P3 copy:
   - Runtime: `Default authorization`, `Tool permission policy`, `Execution runners`.
   - Connections: `Work intake`, `Tool servers`, `Plugin bundles`.
   - Skills: `Skill policy`, `Skill library`.
   - Data: `Archived data`, `System health`.
   - Keep technical terms inside detail panels only.

3. Tighten Settings local style if needed:
   - Keep `SettingsSubnav` compact and stable across all Settings panels.
   - Ensure badges do not shift layout.
   - Ensure Settings overview rows keep action buttons aligned.
   - Avoid desktop horizontal overflow.
   - Keep dark mode on existing theme tokens.

4. Update tests:
   - Replace old visible-label assertions with P3 labels.
   - Add assertions for all subnav labels.
   - Add Settings overview grouping assertions.
   - Add dark-mode coverage for Settings subnav and grouped rows if missing.

5. Update documentation evidence:
   - Mark acceptance checklist items only after verification.
   - Record commands and manual desktop checks.

## Module Boundaries

- `SettingsPage.tsx`
  - Allowed: section labels, section descriptions, prop routing already required for
    Settings panels.
  - Not allowed: nested panel business logic or AppShell routing changes.

- `SettingsSubnav.tsx`
  - Allowed: reusable subnav presentation tweaks.
  - Not allowed: section-specific business logic.

- `SettingsWorkspaceToolsPanel.tsx`
  - Allowed: Configuration overview grouping, row copy, default authorization row/card
    presentation.
  - Not allowed: provider, teammate, council, Work Board, or permission behavior changes.

- `ExecutionPermissionsSettingsPanel.tsx`
  - Allowed: Runtime subsection labels and descriptions.
  - Not allowed: policy calculation changes.

- `IntegrationsSettingsPanel.tsx`
  - Allowed: Connections subsection labels and descriptions.
  - Not allowed: external work, MCP, or plugin runtime behavior changes.

- `SkillsSettingsPanel.tsx`
  - Allowed: top-level Skills subnav labels and descriptions.
  - Not allowed: adding behavior to `SkillLibrarySettingsPanel.tsx`.

- `MaintenanceSettingsPanel.tsx`
  - Allowed: Data subsection labels and descriptions.
  - Not allowed: archive restore or diagnostics behavior changes.

- `settings.css`
  - Allowed: scoped Settings layout fixes and subnav/row styling.
  - Preferred: keep changes near existing Settings sections or split only if the project
    style import pattern supports it cleanly.

- `i18n.tsx`
  - Allowed: short translation keys for visible copy.
  - Not allowed: using translation keys as product logic.

## API / Types

- No HTTP API changes.
- No contract changes.
- No database or storage changes.
- Existing frontend-only section and subsection ids can remain.
- No persistent user preference migration.

## State / Data Flow

```text
Settings section nav
  -> SettingsPage activeSection
  -> focused Settings panel
```

```text
Settings subnav
  -> local activeSubsection
  -> one visible sub-surface
```

```text
Configuration overview row
  -> existing AppShell open handler
  -> nested workspace tool detail
  -> Settings left navigation remains the return/switch path
```

## Implementation Slices

### Slice 1: Audit And Copy Parity

- Compare current code against the P3 target IA.
- Patch missing labels, descriptions, and translations only.
- Do not touch layout unless copy changes reveal a visible fit issue.

### Slice 2: Settings Subnav Consistency

- Ensure Runtime, Connections, Skills, and Data all use `SettingsSubnav`.
- Make badges and descriptions consistent.
- Check long labels and Chinese labels for stable desktop layout.

### Slice 3: Configuration Overview Polish

- Confirm `Workspace setup` and `Work controls` are grouped rows.
- Confirm rows use aligned icons, counts, descriptions, and action buttons.
- Keep Work Board in Settings/contextual links; do not promote to primary sidebar.

### Slice 4: Local Style Guardrails

- Fix only concrete Settings layout issues found in desktop review:
  - horizontal overflow,
  - action button wrapping,
  - clipped labels,
  - inconsistent selected subnav state,
  - dark-mode token mismatch.
- Do not introduce new global colors or page-level visual systems.

### Slice 5: Tests And Evidence

- Update e2e label assertions.
- Run the targeted commands.
- Update the design doc acceptance checklist with evidence.

## Test Plan

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts`
- `corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts dark-mode.spec.ts profile.spec.ts mcp.spec.ts runtime.spec.ts`
- Optional targeted Playwright/browser inspection on served desktop Web:
  - Settings overview grouping visible.
  - Each Settings subnav has the P3 labels.
  - Nested Model Workbench, Teammate Management, Council Workspace, and Work Board still
    hide global sidebar and return to Settings.
  - No desktop horizontal overflow.

## Acceptance Checklist

- [x] P3 design doc exists and states product boundaries.
- [x] Configuration overview shows `Workspace setup` and `Work controls`.
- [x] Runtime subnav labels match P3.
- [x] Connections subnav labels match P3.
- [x] Skills subnav labels match P3.
- [x] Data subnav labels match P3.
- [x] Nested workspace tools use persistent Settings left navigation instead of a
  separate return row.
- [x] Work Board remains out of primary sidebar.
- [x] Settings dark mode remains visually consistent.
- [x] Typecheck and targeted e2e pass.

## Implementation Evidence

- Audit result: existing code already had the main P3 structure, so implementation only
  added focused regression assertions for missing P3 subnav coverage.
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts`
- `corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts dark-mode.spec.ts profile.spec.ts mcp.spec.ts runtime.spec.ts`
- Served desktop Web check at `http://127.0.0.1:5173/`: Settings pages did not produce
  horizontal overflow at `1440x960`.

## Risks

- Existing tests may preserve old labels through broad regexes.
- Large files can grow accidentally:
  - `AppShell.tsx`
  - `i18n.tsx`
  - `settings.css`
  - `SkillLibrarySettingsPanel.tsx`
- Some internal filenames may not match visible product language. Avoid rename churn unless
  the mismatch causes real maintenance risk.
- Settings empty states can become visually oversized if P3 tries to make every page feel
  like a landing page.

## Assumptions

- Current P2 implementation is the baseline and should not be rolled back.
- Desktop Web is the only acceptance target.
- P3 is primarily copy, IA, and local Settings presentation.
- API behavior and persisted data are already correct.

## Hard Stops

- Stop if a required change would alter daemon contracts or storage.
- Stop if the implementation requires moving Work Board to primary sidebar.
- Stop if the implementation requires adding new business logic to `AppShell.tsx`.
- Stop if a Skill Library behavior change is discovered; document it separately.

## Open Questions

- Should `settings.css` extraction be included in P3 if the functional label work is
  already complete, or should it be a P4 architecture cleanup?
- Should P3 mark itself complete after label/style verification, or wait for a broader
  Settings visual pass?
