# Dark Mode Surface Convergence Implementation Plan

Status: Web implementation and verification complete; packaged native evidence remains platform-scoped
Date: 2026-07-31
Scope: documentation, homepage pilot, product-wide alias convergence, Settings, overlays,
Desktop, tests, and visual evidence

Related docs:

- [Dark Mode Surface Convergence](dark-mode-surface-convergence.md)
- [Ling Dark Built-in Theme](ui2.0升级/themes/04-Ling-Dark内置主题.md)

## Goal

Replace the mixed pure-black/deep-gray rendering with one Theme Pack-owned surface
hierarchy. The empty conversation homepage established the approved baseline; the same
hierarchy now applies globally without changing product behavior or page geometry.

## Current Progress

- Slice 0 contract correction: complete.
- Slice 1 homepage pilot: implemented and visually approved.
- Focused homepage E2E: `1/1` passed at `1440x960` and `1280x800`.
- Product-wide migration approval: received on 2026-07-31.
- Slice 2 global alias convergence: implemented. Legacy aliases resolve through the active
  Theme Pack and no longer own a dark palette.
- Slices 3 through 5 Web surfaces: implemented. Settings, conversations, media, plugins,
  automations, work board, overlays, empty states, and management pages use the shared
  semantic hierarchy.
- The temporary homepage-only bridge was removed after global convergence.
- Slice 6 renderer/Desktop handoff: existing Theme Package ownership retained; packaged
  Computer Control rendering and Desktop contracts verified. Native packaged macOS/Windows
  screenshots remain separate platform evidence.

## Current Evidence

| Concern | Current owner | Finding |
| --- | --- | --- |
| Theme truth | `packages/ui-react/src/theme/built-ins/ling-dark.ts` | owns the coordinated neutral-gray hierarchy |
| Generated built-in CSS | `packages/ui-react/src/styles/themes/built-in-themes.css` | matches the Theme Pack manifest |
| Legacy aliases | `apps/web/src/styles/base.css` | resolve directly through active `--ling-*` tokens |
| Homepage routing | `apps/web/src/app/AppPresentationSurfaceBridge.tsx` | already exposes `data-ui-surface="home"` |
| Homepage UI | `ConversationHome.tsx`, `NormalConversationEmptyState.tsx` | behavior and geometry remain unchanged |
| Legacy blanket | `apps/web/src/styles/strict-console.css` | broad class-name dark override removed; only focused legacy primitives remain |
| Feature surfaces | focused files under `apps/web/src/styles/` | geometry remains local; color roles resolve through semantic tokens |
| Dark E2E | `apps/web/e2e/dark-mode.spec.ts` | checks alias ownership, live token binding, large-surface bounds, text, overflow, and screenshots |
| Historical contract | `ui2.0升级/themes/04-Ling-Dark内置主题.md` | pure-black direction is explicitly superseded |

## Verification Evidence

Verified on 2026-08-01 from
`codex/dark-mode-homepage-pilot-20260731@401d8f80` plus the uncommitted focused change set:

- `dark-mode.spec.ts` and `dark-mode-homepage-pilot.spec.ts`: `4/4` passed.
- Local imported dark Theme Pack live-binding test: `1/1` passed with app, panel, and text
  values intentionally different from Ling Dark.
- Cross-page visual evidence: 26 screenshots covering the two homepage sizes, channel,
  media production, generation tasks, plugins, automation, Settings shell, Interface,
  Quick Theme Studio, External Work, authorization, councils, profile, model workbench,
  teammates, private chat, MCP, personalization, skill library, work board, diagnostics,
  archived items, and packaged Computer Control.
- Evidence roots:
  `apps/web/test-results/dark-mode-homepage-pilot-*`,
  `apps/web/test-results/dark-mode-main-pages-*`, and
  `apps/web/test-results/dark-mode-packaged-Computer-*`.
- Real local runtime: daemon `127.0.0.1:17891` reported `ready`; Web
  `127.0.0.1:5173` loaded the current worktree. The live homepage and Settings resolved
  App to `#111315`, Panel to `#171a1d`, had zero document overflow, and produced zero
  browser errors.
- Web typecheck, lint, i18n audit, production build, and `git diff --check`: passed.
- Desktop typecheck: passed. Focused main-window, renderer-theme-store, Theme Package
  capability, first-paint authority, and preload tests: `15/15` passed.

Not claimed:

- Windows native, signed package, and restored-window screenshots were not run on a real
  Windows host.
- A packaged macOS titlebar/PiP screenshot was not regenerated because this change does
  not modify Desktop native code; the Desktop contract and renderer handoff were tested.

## Module Boundaries

| Layer | Responsibility | Must not own |
| --- | --- | --- |
| Theme Pack | canonical semantic values | page selectors or feature behavior |
| Compatibility aliases | legacy names mapped globally to active Theme Pack tokens | independent palette values or page gates |
| Feature CSS | layout and semantic role selection | hard-coded dark palette |
| React | surface identity and interaction | runtime color mutation |
| E2E | computed token ownership, hierarchy, overflow, focus, console | screenshot-only pass/fail |
| Design docs | product intent, stages, hard stops | claims that unimplemented slices shipped |

No TypeScript state, API client, daemon, database, or domain type changes are required.

## Slice 0: Contract Correction

1. Add the product contract and this implementation plan.
2. Update the existing Ling Dark document to the current Theme Pack values.
3. Mark the former pure-black surface direction as superseded.
4. Keep historical UI2 evidence intact; it proves earlier implementation, not current
   visual acceptance.

Acceptance:

- Docs name one canonical token authority.
- Docs explicitly forbid opaque pure black as an application surface.
- Homepage pilot and later Settings work are visibly separate stages.

## Slice 1: Homepage Pilot

### Historical Pilot CSS

The approved pilot used a temporary `dark-mode-surface-bridge.css` rule scoped to the
homepage:

```css
:root[data-theme="dark"][data-ui-surface="home"] {
  --app-bg: var(--ling-bg-app);
  --surface-sidebar: var(--ling-bg-sidebar);
  --surface-panel: var(--ling-bg-panel);
  --surface-panel-strong: var(--ling-bg-elevated);
  --surface-subtle: var(--ling-bg-subtle);
  --surface-pressed: var(--ling-bg-pressed);
  /* text, border, action, status and conversation aliases follow the same mapping */
}
```

That bridge was intentionally deleted after product-wide approval. Its mappings now live
as global compatibility aliases in `base.css`, and the sidebar consumes
`--surface-sidebar` directly.

### Homepage Styling

- Keep the existing homepage geometry and content.
- Use App for the empty workspace ground.
- Use Sidebar for the persistent navigation.
- Use Composer for the message composer.
- Use Panel for shortcut controls and Subtle for hover/focus fill.
- Reduce dark composer shadow strength without removing focus distinction.
- Keep border use restrained and token-driven.

### Focused E2E

Add `apps/web/e2e/dark-mode-homepage-pilot.spec.ts` with mocked daemon state.

Assert:

- locale and fixed Ling Dark bootstrap,
- `data-ui-surface="home"`,
- App, sidebar, shortcut, composer, and hover computed backgrounds match their expected
  `--ling-*` tokens,
- target surfaces are not opaque pure black,
- the intended roles are not collapsed into one color,
- shortcut and composer keyboard focus are visible,
- no document overflow at `1440x960` and `1280x800`,
- no console error or `pageerror`.

Capture:

- `1440x960-ling-dark-homepage-pilot.png`
- `1280x800-ling-dark-homepage-pilot.png`

### Approval Gate

Completed on 2026-07-31. The two homepage screenshots are the baseline for all later
slices.

## Slice 2: Global Alias Convergence

Implemented.

1. Map legacy aliases in `base.css` to Theme Pack tokens for every resolved theme.
2. Remove independent dark hex values from the compatibility layer.
3. Preserve alias names until all consumers migrate; this slice changes ownership, not
   every selector name.
4. Add a deterministic check preventing opaque pure-black product surfaces in the alias
   layer.
5. Verify imported themes so aliases follow the active package rather than Ling Dark
   specifically.

Risk control:

- Test custom/imported light and dark Theme Packs.
- Avoid changing native overlay and media letterbox semantics.
- Compare computed values before deleting any alias.

## Slice 3: Settings Shell And Shared Primitives

Implemented. Final verification is tracked in the Browser Matrix and evidence table.

1. Converge Settings document ground, navigation, content root, headers, and dividers.
2. Verify shared Button, IconButton, Input, Textarea, Select, SegmentedControl, Switch,
   Tabs, Menu, Tooltip, Dialog, Drawer, Toast, and InlineFeedback.
3. Remove feature CSS that paints ordinary Settings sections with hard-coded black or a
   second palette.
4. Keep compact operational layout; do not add cards to manufacture depth.

Visual states:

- empty, sparse, populated,
- hover, keyboard focus, selected, pressed, disabled, loading,
- warning, danger, success,
- menu, popover, dialog, drawer, toast,
- short and long Chinese content.

## Slice 4: Settings Modules

Implemented. The final browser tour includes every reachable Settings entry; Computer
Control is exercised through a Desktop-capability harness because it is intentionally
hidden in a browser-only host.

Migrate in focused groups so regressions remain attributable:

1. Profile and Interface.
2. Model Workbench and Plugins.
3. Teammate Management and Council.
4. Skill Library and Personalization.
5. Permissions, Archived Items, and pending diagnostic entry points.

For each group:

- remove local palette ownership,
- retain feature geometry and behavior,
- verify natural-height and internal-scroll contracts,
- check drawers and destructive flows,
- capture `1440x960` and `1280x800` dark evidence.

## Slice 5: Remaining Product Surfaces

Implemented for the current Web product surfaces.

After Settings acceptance, migrate:

- channel and normal conversation transcript states,
- teammate private chat,
- media production and media jobs,
- automations, plugins, runs, approvals, work board when re-enabled,
- first-run and error recovery,
- overlays shared across routes.

This slice is a theme convergence pass, not an information-architecture redesign.

## Slice 6: Desktop And First Paint

- Verify bootstrap snapshot, renderer theme, native titlebar, window background, PiP Deck,
  scrollbar, context menu, and restored-window theme agree before the first visible frame.
- Keep platform material limited to the shell. Content panels remain solid.
- Validate macOS locally. Record Windows native and signed-package verification as
  unavailable unless run on a real Windows environment.

The renderer already reports the resolved Theme Pack variables to Desktop. The focused
Web harness verifies the packaged Computer Control page with Desktop capability present;
native titlebar, restored-window, and PiP evidence must still come from a packaged macOS
run rather than a browser screenshot.

## Test Strategy

### Static

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web lint`
- `corepack pnpm --filter @ling-stack/web run check:i18n`
- `corepack pnpm --filter @ling-stack/web build`
- `git diff --check`

### Computed Style

Do not retain the current "maximum RGB channel <= 70" test as the sole dark criterion.
New assertions must verify:

- exact semantic token ownership,
- no opaque pure-black product surface,
- different roles remain distinguishable,
- text contrast and focus visibility,
- custom theme aliases follow custom theme tokens.

### Browser Matrix

| Stage | Viewport | Theme | Required evidence |
| --- | --- | --- | --- |
| Homepage pilot | 1440x960 | Ling Dark | empty home, sidebar, composer, shortcuts |
| Homepage pilot | 1280x800 | Ling Dark | compact desktop geometry and overflow |
| Settings slices | 1440x960 | Ling Dark | default and populated state |
| Settings slices | 1280x800 | Ling Dark | internal scroll and overlays |
| Regression | 1440x960 | Ling Light | unchanged light hierarchy |
| Imported theme | 1280x800 | custom dark | alias follows package tokens |

## Rollback

The approved direction is now global and the temporary bridge no longer exists. Rollback
must revert this focused theme-convergence change set rather than restoring the old broad
dark blanket or its pure-black aliases. No data or behavior migration is involved.

## Hard Stops

- No daemon/API/SQLite changes.
- No global search-and-replace of dark colors.
- No test weakening, screenshot-only acceptance, or `#000000` allowlist for ordinary
  product surfaces.
- No new production source file above 800 lines; feature CSS remains in its current
  focused module.
