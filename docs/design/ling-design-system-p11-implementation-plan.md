# Ling Design System P11 Implementation Plan

## Related Docs

- [Ling Design System](ling-design-system.md)
- [Settings Full-Surface Productization P10](settings-full-surface-productization-p10.md)
- [P10 Implementation Plan](settings-full-surface-productization-p10-implementation-plan.md)
- [Settings Diagnostic Density P8](settings-diagnostic-density-p8.md)
- [Settings Interaction Depth P9](settings-interaction-depth-p9.md)

## Summary

P11 applies the Ling design system to the remaining verified gaps only. It does
not repeat P10 items that are already fixed. The process rule is stricter than
page-only QA: every reachable state counts, including Settings tabs, dialogs,
details, inspectors, empty states, error states, menus, and dark refresh.

## Recheck Matrix

| Item | Status | Evidence / action |
| --- | --- | --- |
| Council channel access vertical text | Done | Keep existing compact horizontal state; do not rework. |
| Dialog Esc close for channel and skill import | Done | Keep current overlay close behavior. |
| Settings run diagnostics shell boundary | Done | Keep embedded Settings diagnostics; `Ling Stack navigation` must stay absent. |
| Automation failure product copy | Done | Keep productized failure copy; raw channel/run ids stay out of default layer. |
| Model Workbench default diagnostics wall | Done | Keep current summary-first route/provider layout. |
| Archived list scroll and rules | Done | Keep bounded lists and one muted rule hint. |
| Media raw task id exposure | Done | Keep product job states and folded raw details. |
| Plugin Manager default diagnostic wall | Done | Raw fields, workspace path, package internals, and secondary actions are folded into details; primary action buttons stay 32px high and horizontal. |
| Skill Library default density | Done | No default inspector item is selected; list descriptions/source explanations are removed from the default row and remain available from details. |
| Work Board handling guide | Done | Empty inspector defaults to `Select a work item`; the handling guide is weak and folded. |
| Sidebar small hit areas | Done | Section and row action hit areas are at least 32px while preserving dense visual rhythm. |
| Dark refresh black flash | Done | Bootstrap prefers `ling-stack.themeBootstrapPreference` over legacy `themePreference`. |
| Plugin/skill deep i18n | Done | Fallback values and deep settings copy are localized; raw/technical terms stay in details. |

## Implementation Slices

### Slice 1: Design-System Docs

- Add `docs/design/ling-design-system.md`.
- Add this P11 plan and link it from P10.
- Capture the rule: every reachable state is an acceptance surface.

### Slice 2: Plugin Manager

- Keep default row to plugin name, status, source, availability chip, and one
  primary action.
- Move package status, plugin id, trust, health, linked resource ids, runtime
  preview, latest event, and contributions into closed details.
- Remove visible workspace path footer from the default layer.
- Fix row CSS so details do not occupy a second grid column and primary action
  text cannot stack vertically.

### Slice 3: Skill Library

- Stop selecting the first skill automatically on page load.
- Show an empty compact inspector until the user clicks `Details`.
- Remove list-row descriptions from default layers; descriptions remain in the
  inspector.
- Do not show source-attention count as a default callout on the skills list.
- Keep Source sync and Review queue evidence folded.

### Slice 4: Work Board And Sidebar

- Convert the empty Work Board guide into a collapsed compact disclosure.
- Make sidebar section and row action hit areas at least 32px.
- Keep visible icons small and aligned so density does not become bulky.

### Slice 5: Theme And I18n

- Prefer `ling-stack.themeBootstrapPreference` over legacy
  `ling-stack.themePreference` during bootstrap and React initialization.
- Add localized fallback labels for plugin details: unknown, not installed,
  no hash, none, missing, no recent event.
- Keep raw ids in details, not default layer.

## Validation

- `git diff --check`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web check:i18n`
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts dark-mode.spec.ts`
- Focused regressions as touched:
  `work-board.spec.ts`, `app.spec.ts`, `model-workbench.spec.ts`,
  `automations.spec.ts`, `councils.spec.ts`

## Acceptance Checklist

- [x] Ling design system doc exists and is linked from P10.
- [x] Plugin Manager first screen does not show raw ids, hashes, workspace path,
  contribution tokens, or runtime internals.
- [x] Plugin Manager primary action text stays horizontal and centered.
- [x] Skill Library first screen does not default-open a populated inspector.
- [x] Skill descriptions and source evidence appear in details, not list rows.
- [x] Work Board guide is available but not a large default help block.
- [x] Sidebar menu/action hit areas are at least 32px.
- [x] Refreshing with legacy `themePreference=system` and bootstrap `light`
  paints light immediately.
- [x] Chinese and English plugin/skill fallback copy stays aligned.

## Evidence

- `git diff --check` passed.
- `corepack pnpm --filter @ling-stack/web check:i18n` passed.
- `corepack pnpm --filter @ling-stack/web typecheck` passed.
- `corepack pnpm --filter @ling-stack/web test:e2e -- teammates.spec.ts` passed: 16 tests.
- `corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts work-board.spec.ts settings.spec.ts dark-mode.spec.ts` passed: 33 tests.
- `corepack pnpm --filter @ling-stack/web test:e2e -- automations.spec.ts model-workbench.spec.ts councils.spec.ts` passed: 16 tests.
- Dev-server visual check used `http://127.0.0.1:5173/` with source/HMR, not a built `dist` artifact. Viewports checked: `1440x960` and `1280x800`.
- Visual evidence saved under `/tmp/ling-p11-final-visual/`.
- Browser checks confirmed Settings nested pages keep `Settings sections` visible and `Ling Stack navigation` absent; Plugin Manager, Skill Library, Work Board, and Startup Diagnostics had no default-layer raw/hash/metadata/transport noise and no horizontal overflow.
- Theme bootstrap check confirmed `themePreference=system` plus `themeBootstrapPreference=light` paints the first screen light.
