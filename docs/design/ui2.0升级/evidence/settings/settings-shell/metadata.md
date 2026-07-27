# P7A.1 Settings Shell Evidence

## Scope

- Function IDs: `SETTINGS-SHELL-001`, `SETTINGS-CONTENT-001`, `SETTINGS-BACK-001`,
  `SETTINGS-BOUNDARY-001`.
- Surface: Settings navigation, content boundary, embedded workspace tool, run diagnostics and exact app return.
- Branch: `codex/ui2-desktop-coverage-foundation`.
- HEAD while captured: `0a0b8050` with the integrated Desktop/Computer Use and UI 2.0 worktree still dirty.
- Date: 2026-07-20.

## Implemented Contract

- `SettingsShell` is the focused presentation boundary. It owns the 12 section actions, active state, independent
  navigation/content scrolling and Back action without importing Settings domain panels or API state.
- `settings-shell-model.ts` owns stable section IDs, grouping and Lucide icon mapping. `SettingsPage` retains section,
  embedded-tool and diagnostics orchestration only.
- Back and all section actions use the shared UI 2.0 `Button`; feature CSS uses public
  `data-ling-button-slot` hooks rather than package-private classes.
- Model Workbench, Teammate Management, Council Workspace and Run Diagnostics remain inside the same Settings shell.
  The main application navigation and legacy inner return row do not appear.
- Navigation and content are the only vertical scroll owners. The document remains fixed at 1440x960, 1280x800 and
  a live resize to 980x680.
- Startup failure remains persistent and object-scoped in the content area while Settings navigation stays usable.
- No API, contract, database, route, `ViewId`, Settings ID, Desktop capability, Logo or First Run behavior changed.

## Automated Evidence

- `git diff --check`: passed.
- Web i18n, typecheck and UI 2.0 import/overlay lint guards: passed.
- `@ling-stack/ui-react`: `40/40`.
- `ui2-settings-shell.spec.ts`: `2/2`.
- Settings plus shared conversation contract regression: `23/23`.
- Settings/AppShell/Dark/overlay/model-workbench selected regression: `65/65`.
- Evidence capture rerun: `2/2`.

The focused spec traverses all 12 Settings actions, verifies a single active item, shared Button hit areas, embedded
Model Workbench, exact channel return, Startup failure, Run Diagnostics, theme tokens, independent scroll ownership,
dynamic resize, console cleanliness and document overflow.

## Runtime And Reproduction

- Served artifact: source through the Playwright-managed real Vite development server, not `dist` or isolated markup.
- URL: `http://127.0.0.1:4174/` during the deterministic E2E run.
- Locale: `en-US`.
- Fixture: existing E2E daemon adapter with a selected Engineering channel, empty Model Workbench, failed startup
  status request and one failed diagnostic run.
- Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- ui2-settings-shell.spec.ts
```

Screenshots disable CSS animation before capture. They prove the real Web React/CSS route, not a packaged Electron
host, Windows font/DPI, forced-colors or real daemon persistence.

## Screenshots

| File | Theme / viewport | SHA-256 | Original-size inspection |
|---|---|---|---|
| `1440x960-ling-light-settings-profile-shell.png` | `ling-light`, 1440x960 | `b5dd337548cd7c50e304bcf9b7eb1b184557d524243eb4a3eb9a0f5bf4aad62c` | All 12 entries remain readable and the single active Profile item, centered content and Back boundary do not compete with a second app navigation. |
| `1440x960-ling-light-settings-embedded-model.png` | `ling-light`, 1440x960 | `9b2fd0a4a285bad92da9e27e2cdf64a03332d0d08f761be436a430cc85cea566` | Model Workbench stays inside the Settings content owner with no inner return row, duplicate shell or horizontal spill. |
| `1280x800-ling-dark-settings-startup-error.png` | `ling-dark`, 1280x800 | `e8ce09e5d205fcdeda84fbc95b283540be819252c0b8cd256bfee5b971871c23` | Startup failure remains in content, dark tokens stay contained and single-line navigation labels do not change row geometry. |
| `980x680-ling-dark-settings-run-diagnostics.png` | `ling-dark`, 980x680 | `66ca45e6d30c33e6ce256951146fd6eb7c36e2bfa4afa56cc5a51f2a0c649de8` | Live resize preserves navigation, run list/detail, Refresh/Close controls and independent scrolling without overlap or document overflow. |

All four PNG dimensions match their filenames and were inspected at original resolution.

## CSS And Module Ownership Proof

- `SettingsPage.tsx`: `470 -> 329` lines; navigation JSX moved to focused presentation ownership.
- `SettingsShell.tsx`: `103` lines; `settings-shell-model.ts`: `95` lines.
- `settings.css`: `3,137 -> 2,914`; `sidebar.css`: `1,849 -> 1,816`.
- `settings-shell.css`: new focused owner, `211` lines and within the `<=220` budget.
- `strict-console.css`: `1,411 -> 1,416` for semantic Settings exclusions; it remains U13 deletion debt.
- Total Web CSS: `66 files / 46,091 lines -> 67 files / 46,052 lines`.
- Focused CSS color literals, `!important`, Theme/Profile selectors, `transition: all`, private keyframes and
  package-private Button class selectors are all `0`.
- `settings.spec.ts` remains over 1,000 lines; new Settings shell scenarios stay in the 203-line focused spec.

## Status Decision

- P7A.1 Settings Shell foundation: `verified`.
- `SETTINGS-SHELL-001`: `verified`.
- `SETTINGS-CONTENT-001`: `verified`.
- `SETTINGS-BACK-001`: `verified`.
- `SETTINGS-BOUNDARY-001`: `verified`.
- `SETTINGS-SUBNAV-001` and `SETTINGS-OVERLAY-001` remain open. The historical coarse
  `SETTINGS-DIAG-001` was superseded by four non-overlapping Diagnostics IDs; those IDs and the three Startup IDs
  were later verified in P7B.4 with evidence under `evidence/settings/startup-diagnostics/`.
