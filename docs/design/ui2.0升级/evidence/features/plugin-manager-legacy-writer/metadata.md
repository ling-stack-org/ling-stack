# Plugin Manager Legacy Writer Release Evidence

## Scope And Status

- Recorded: `2026-07-24`, Asia/Shanghai.
- Branch / baseline HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Source: real Vite application through Playwright Chromium and daemon fixtures.
- Themes/viewports: `ling-light`, `ling-dark`, imported `Quiet Ocean`; `1440x960` and `1280x800`.
- Status: `T13-O.32 Plugin Manager Dark Blanket Ownership Release` is Web verified. Existing Plugin Function IDs and packaged Desktop/CUA status are unchanged.

## Ownership Boundary

- `.workspace.workspace-plugins-surface` remains the only Plugin page root selector owner in `plugins/plugin-manager-shell.css`.
- The final `strict-console.css` layer now excludes `.workspace-plugins-surface` from its one generic Dark root repaint and all 21 generic descendant blankets.
- The empty `plugin-cua-health.css` facade and its global import were deleted. `plugins/plugin-cua-install.css` remains the real CUA presentation owner.
- The zero-consumer `.settings-plugin-token` strict selector was deleted.
- Shared `InlineFeedback` now exposes `data-ling-inline-feedback-slot="detail"`. Plugin focused CSS uses that public slot for retained-refresh and Detail failure layout instead of selecting the package-private `.ling-ui-inline-feedback-detail` class.
- Plugin discovery, install, check, enable/disable, presets, refresh, CUA setup, Runtime Preview, uninstall, API, contracts, routes, state, i18n, Logo and Desktop behavior were not changed.

## Verification

| Gate | Result |
|---|---|
| UI package tests | `51/51` passed |
| New focused spec, ordinary | `4/4` passed |
| New focused spec, formal capture | `4/4` passed |
| Existing Plugin focused + legacy | `17/17` passed |
| App/Dark/Theme selected regression | `26/26` passed |
| UI 2.0 representative Web release gate | `12/12` passed |
| Web lint, i18n, typecheck and production build | passed; existing large-chunk warning only |
| Strict/source/dead/private-selector/forbidden scans | passed |
| `git diff --check` and 202-document link audit | passed |

The new focused spec verifies the exact `1 + 21` strict exclusions, focused facade source order, empty-facade and
dead-selector absence, public InlineFeedback slot ownership, retained refresh with keyboard Retry, row-scoped failure,
CUA and Create overlays, imported Theme tokens, reduced motion, console errors, page errors and region/document overflow.

## CSS Accounting

| Owner | Before | After |
|---|---:|---:|
| Web CSS total | 161 files / 33,864 lines | 160 files / 33,861 lines |
| `strict-console.css` | 386 | 385 |
| `styles.css` | 102 | 101 |
| `plugin-cua-health.css` | 1 | deleted |
| Plugin focused CSS | 7 files / 549 lines | 7 files / 549 lines |

The public slot migration changes selector contracts only and adds no Feature CSS. O.32 adds no color literal,
Theme/Profile selector, `!important`, `transition: all`, global input/button/status patch or package-private Feature selector.

## Original-Size Screenshot Ledger

| Evidence | Viewport/theme | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-retained-refresh-list.png` | 1440x960 / Ling Light | 24-row retained list, persistent refresh failure and keyboard Retry | `f11e6bde85c3bb7739cc8b13f87da8e3eb306048ccfe44b443afc96ae38e48f5` |
| `1280x800-ling-dark-row-failure-focus.png` | 1280x800 / Ling Dark | row-scoped check failure, focused Retry and reduced motion | `ac2c50fad75508d40e6328c3a6d868e1af9a94fbda1381d4d9c7b6c2398f8e38` |
| `1440x960-quiet-ocean-create-validation.png` | 1440x960 / Quiet Ocean | imported Theme list and shared Create Dialog validation/focus | `980188bf780e3027b2b7c23d88aee6d5f476ec78b19a011eca1715620df90e2d` |

All screenshots were inspected at original size. Plugin headers, toolbars, rows, statuses, retained feedback and overlays
remain token-owned and contained without document-level horizontal or vertical overflow.

## Honest Remaining Gaps

- Packaged Windows CUA interactive, DPI/high-contrast and macOS packaged evidence remain separate release gates.
- The imported Theme screenshot verifies token ownership but does not add a new Theme design or Plugin behavior.
- `strict-console.css` still contains generic blankets for unclosed legacy surfaces; O.32 only releases the Plugin subtree.
- `PluginManagerPage.tsx` and current focused CSS remain below 800 lines. Existing large-file debt in `AppShell.tsx`, `app.spec.ts` and `dark-mode.spec.ts` was not expanded.
