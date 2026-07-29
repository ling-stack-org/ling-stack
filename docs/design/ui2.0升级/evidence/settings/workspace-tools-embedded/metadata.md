# P7B.5 Settings Workspace Tools Embedded Evidence

## Scope

- Function IDs: `SETTINGS-EMBED-MODEL-001`, `SETTINGS-EMBED-TEAM-001`,
  `SETTINGS-EMBED-COUNCIL-001`, `SETTINGS-OPEN-APP-001`.
- Dependency regression: `SETTINGS-BOUNDARY-001` remains verified from P7A.1 and is not counted again.
- Surface: Model Workbench, AI Teammate Management and Council Workspace inside the shared Settings shell.
- Date: `2026-07-20`.

## Capture Context

- Branch: `codex/ui2-desktop-coverage-foundation`.
- Base HEAD: `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Remote at closeout: `origin/main=ddfd260b47163d8d98c30c4292c113f43e2d0345`.
- Working tree: dirty; Desktop/Computer Use and UI 2.0 work remain intentionally preserved together.
- Remote audit: 178 remote-changed files and 28 local/remote overlaps; none of the overlap files owns the P7B.5
  wrapper, Provider editor, focused Model CSS or focused E2E. No merge or rebase was performed.
- Served artifact: Playwright-managed real Vite development server at `http://127.0.0.1:4174`, not `dist`.
- Browser: Playwright Chromium.
- Data source: deterministic `mockDaemon` fixtures with provider, teammate and Council loading, empty, failure,
  loaded, long-list and overlay states.
- Locale: `en-US`; Theme Packs: fixed `ling-light` and `ling-dark`.

Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm exec playwright test e2e/ui2-settings-workspace-tools.spec.ts
```

Screenshots disable CSS animation before capture. They prove the real Web React/CSS route and shared overlay root;
they do not prove a live daemon, packaged Electron host, Windows DPI/high contrast or native-window behavior.

## Screenshots

| File | Viewport | Theme Pack | Changed state and original-size inspection |
|---|---|---|---|
| `1440x960-ling-light-model-loaded.png` | `1440x960` | `ling-light` | 18-row long list, search/filter/actions and sticky table header remain separated; list owns scrolling and no toolbar overlap or document overflow remains. |
| `1280x800-ling-dark-model-editor.png` | `1280x800` | `ling-dark` | Shared Dialog renders as the existing right-side editor, fits the viewport, keeps body scrolling and footer actions visible, with no hard-coded light panel. |
| `1440x960-ling-light-teammates-loaded.png` | `1440x960` | `ling-light` | 14 teammates and default roles stay inside one Settings boundary; list clipping is contained by its internal scroll owner and actions do not wrap vertically. |
| `1280x800-ling-dark-teammate-create.png` | `1280x800` | `ling-dark` | Shared create Dialog stays inside the viewport with one scrim, readable selected state, fixed footer and no duplicate Settings or app shell. |
| `1440x960-ling-light-council-loaded.png` | `1440x960` | `ling-light` | Council list/detail, tabs, health and member actions remain bounded; no horizontal spill, duplicate navigation or nested page header appears. |
| `1280x800-ling-dark-council-create.png` | `1280x800` | `ling-dark` | Shared create Dialog, form and footer remain centered and contained over the embedded Council surface without overlay collision or theme leakage. |

All six PNG dimensions match their filenames. They were opened at original resolution after the final capture.
No double vertical scrollbar, horizontal overflow, clipped primary action, vertical button text, hard-coded light block in
Dark or incoherent overlay stacking remained.

## SHA-256

```text
c72badddae7a833e3e149e54b3df6afd50a7cb579cfd750096581ae59f19576c  1280x800-ling-dark-council-create.png
91d4e5ba964ed64cf55ca19594ef6f70565bf29d1bf25233c465c8a529d2e9a7  1280x800-ling-dark-model-editor.png
a876a0d261c5fa67ece8ccdaeafa4f197f6e7f72ce3123fd9b3498ef0f522cd6  1280x800-ling-dark-teammate-create.png
b98b72ee6c91d1bdbfca0b7e2e1f447743c580f8ec8f82bf4abbe7ef73a60a05  1440x960-ling-light-council-loaded.png
84e4743c3566d5414836b5cc5bf83cef61c80d7ebf4871273c86b7f0905b44b5  1440x960-ling-light-model-loaded.png
59d37da581f66508259e90a15df979a12bceb5818615344b202aca8135c06171  1440x960-ling-light-teammates-loaded.png
```

## Implemented Contract

- `SettingsWorkspaceToolSurface` is a pure 24-line presentation boundary. It has no domain, API, route or i18n
  ownership and renders only when both the workspace tool view and detail exist.
- `SettingsPage` keeps exact return and active-section orchestration while Provider, Teammate and Council owners retain
  their existing data, loading, mutation and feedback state.
- `settings-workspace-tools.css` is a 27-line geometry owner for grid/min-size/overflow only.
- The unused `SettingsWorkspaceToolsPanel` and about 226 lines of its unique selectors were deleted;
  `settings.css` is now 436 lines.
- Provider Editor and Teammate Role detail use the shared Dialog/Portal contract with Esc, busy safety and focus restore.
- The Provider editor keeps its established right-side sheet presentation. Its legacy slide animation had replaced the
  shared Dialog centering transform, leaving an 800px sheet at `top:50%` and producing a 1200px bottom. Focused Model
  CSS now owns top/right/bottom geometry and open/closed/reduced-motion animation without changing shared Dialog.
- Original-size review found that a long Provider list could shrink the Settings-mode header and let controls overlap
  the sticky table header. The header is now non-shrinking and the focused E2E asserts toolbar bottom is no lower than
  the table-shell top before evidence capture.
- No API, contract, database, route, `ViewId`, Settings IA, permission, domain state machine or Logo changed.

## Automated Evidence

```text
@ling-stack/ui-react                                      41/41 passed
Provider editor minimal regression                         1/1 passed
model-workbench + productization                          18/18 passed
settings + focused workspace tools                        24/24 passed
teammates + councils                                      23/23 passed
Settings shell + app + dark mode                          23/23 passed
Selected browser regression total                         88/88 passed
Final evidence capture                                     7/7 passed
Web typecheck, check:i18n, lint, git diff --check          passed
```

The focused spec covers direct entry, exact Back, explicit Open chat/channel, internal tool switching, loading, empty,
failure, search/filter, 18/14-row long lists, role detail, create/editor Dialogs, Esc/focus restore, one overlay root,
Light/Dark, reduced motion, 1440/1280/980 containment, console errors and document overflow.

## CSS And Module Boundary Proof

- `SettingsWorkspaceToolSurface.tsx`: 24 lines.
- `settings-workspace-tools.css`: 27 lines; no colors, transition, keyframe, `!important` or domain selector.
- `settings.css`: 662 -> 436 lines in P7B.5.
- `model-workbench.css`: 589 -> 617 lines after the right-sheet and non-shrinking-header fixes; the new rules use
  semantic motion tokens, contain reduced motion and add no color literal or `!important`.
- `ui2-settings-workspace-tools.spec.ts`: 354 lines and 7 scenarios.
- `SettingsPage.tsx` remains below 400 lines. No behavior was appended to the 3,000+ line `AppShell.tsx`.
- Full Provider/Teammate/Council visual migration remains P9/P8; P7B.5 does not claim those business surfaces complete.

## Status Decision

- `SETTINGS-EMBED-MODEL-001`: `verified`.
- `SETTINGS-EMBED-TEAM-001`: `verified`.
- `SETTINGS-EMBED-COUNCIL-001`: `verified`.
- `SETTINGS-OPEN-APP-001`: `verified`.
- P7B.5 is closed. The next executable UI 2.0 slice is P7C.1 ThemePicker import/delete/preview.
