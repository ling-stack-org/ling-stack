# P7A.2 Settings Profile Evidence

## Scope

- Function IDs: `SETTINGS-PROFILE-001`, `PROFILE-IDENTITY-001`, `PROFILE-AVATAR-001`,
  `PROFILE-NAME-001`, `PROFILE-INSIGHT-001`, `PROFILE-EMPTY-001`.
- Regression baseline: already verified `PROFILE-TOAST-001`.
- Surface: Settings Profile identity, inline name edit, avatar crop, usage insight, loading/empty/error/long states.
- Branch: `codex/ui2-desktop-coverage-foundation`.
- HEAD while captured: `0a0b8050` with the integrated Desktop/Computer Use and UI 2.0 worktree still dirty.
- Date: 2026-07-20.

## Implemented Contract

- Settings Profile uses shared IconButton, Input, SegmentedControl, DataRow, EmptyState, Skeleton and
  InlineFeedback. The Profile adapter retains API, metrics and rollback ownership.
- Initial GET renders a stable identity/metric Skeleton instead of flashing fake `Ling User` and empty usage.
- Display name opens one shared inline Input. Escape cancels and restores focus; blur/Enter performs one save,
  successful saves use the existing global Toast, and failures restore the previous name with persistent feedback.
- Username remains read-only. The camera action is the only avatar entry and invalid files stay local to Profile.
- Avatar crop uses the shared Radix Dialog/application overlay root. Initial focus is Cancel, one Escape closes,
  native file-chooser focus is explicitly restored to the avatar trigger, and the existing circular transparent
  WebP/PNG output contract remains unchanged.
- Usage insight renders directly with four summary metrics, locale-correct compact number/duration/month labels,
  a shared SegmentedControl, heatmap, streak metrics and at most five shared DataRows.
- Empty usage uses one compact EmptyState. Long model/skill labels truncate with titles and do not create document
  overflow at 980x680.
- No API, contract, database, route, `ViewId`, Settings ID, profile shape, metrics formula, avatar byte budget,
  username semantics, Logo or standalone Profile IA changed.

## Automated Evidence

- `git diff --check`: passed.
- Web i18n: passed (`en-US=3183`, `zh-CN=4889`).
- Web typecheck and UI 2.0 import/overlay lint guards: passed.
- `@ling-stack/ui-react`: `40/40`.
- `ui2-settings-profile.spec.ts`: `4/4`.
- Profile business plus focused regression: `7/7`.
- App/Settings/Profile/Feedback/Dialog/Dark/Shell/overlay selected regression: `54/54`.
- Evidence capture rerun: `4/4`.

The focused spec verifies shared primitive ownership, hit areas, read-only handle, locale formatting, max-five long
skill rows, name cancel/save/failure, invalid file, real file chooser, crop Dialog/Esc/focus restore, loading versus
empty, load failure, Dark containment, 1440/1280/980 viewports, console cleanliness and document overflow.

## Runtime And Reproduction

- Served artifact: source through the Playwright-managed real Vite development server, not `dist` or isolated markup.
- URL: `http://127.0.0.1:4174/` during deterministic E2E runs.
- Locale: `en-US`; theme fixtures: fixed `ling-light` and `ling-dark` Theme Packs.
- Data fixtures: six runs and six long-named skills, an empty workspace, delayed Profile GET, failed Profile PATCH,
  failed Profile GET, one valid SVG avatar and one invalid text file.
- Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- ui2-settings-profile.spec.ts
```

Screenshots disable CSS animation before capture. They prove the real Web React/CSS path, not a packaged Electron
host, Windows font/DPI, forced-colors, native file dialog chrome or real daemon persistence.

## Screenshots

| File | Theme / viewport | SHA-256 | Original-size inspection |
|---|---|---|---|
| `1440x960-ling-light-settings-profile-loaded.png` | `ling-light`, 1440x960 | `6a92b8ff2bcfad4aeb198706358d7c23ac8b2adf81c506cd0264a377f2bfd614` | Identity remains the primary task; long model/skills truncate cleanly, five skill rows stay bounded, and English duration/month/singular labels are correct. |
| `1440x960-ling-light-settings-profile-crop.png` | `ling-light`, 1440x960 | `4850664511600d1c261fd07da3679097997f0db1f5f28bc30658ab41a0d9a450` | Shared Dialog, crop frame, zoom, Cancel/Use avatar and global Toast share one overlay stack without duplicate backdrop or clipped controls. |
| `1280x800-ling-dark-settings-profile-loading.png` | `ling-dark`, 1280x800 | `a9383eb1341d18ccc2dc1810e0b0df2348ed4ffc8ff067806990d5c0f69fb7d1` | Six stable Skeletons preserve identity/summary geometry; no fake empty copy or hard-coded light panel appears. |
| `980x680-ling-dark-settings-profile-save-error-long.png` | `ling-dark`, 980x680 | `5aa24bafff0af1971b1305825a5b79bce3c262034113f9943d4db91aa4f3d428` | Save failure remains visible under identity, two-column metrics and horizontally bounded heatmap fit the narrow Desktop content owner without document overflow. |

All four PNG dimensions match their filenames and were inspected at original resolution.

## CSS And Module Ownership Proof

- `ProfilePage.tsx`: `587 -> 603` lines; additions are locale formatting and trigger/control wiring, not presentation JSX.
- `ProfileSettingsSurface.tsx`: `296 -> 383`; `AvatarCropDialog.tsx`: `290 -> 331`. All remain below 800 lines.
- `profile.css`: `511 -> 383`; legacy crop selector/backdrop/z-index ownership was deleted.
- `profile-settings.css`: `324 -> 301`, focused identity/summary owner and below its 360-line budget.
- New `profile-settings-activity.css`: `127` lines; new `profile-crop-dialog.css`: `75` lines.
- `settings.css`: `2,914 -> 2,899`; three stale embedded Profile selectors were deleted.
- Total Web CSS: `67 files / 46,052 lines -> 69 files / 46,090 lines`.
- Legacy z-index budget improved `91 -> 90`; high literal z-index budget improved `24 -> 23`.
- All three P7A.2 focused CSS files have zero color literals, `!important`, Theme/Profile ID selectors,
  `transition: all`, private keyframes or package-private class selectors.

## Status Decision

- P7A.2 Settings Profile: `verified`.
- `SETTINGS-PROFILE-001`: `verified`.
- `PROFILE-IDENTITY-001`: `verified`.
- `PROFILE-AVATAR-001`: `verified`.
- `PROFILE-NAME-001`: `verified`.
- `PROFILE-INSIGHT-001`: `verified`.
- `PROFILE-EMPTY-001`: `verified`.
- `PROFILE-TOAST-001` remains `verified`; standalone Profile dashboard migration remains separate.

## P11.4 Regression Supplement

Date: 2026-07-23. Branch/HEAD during verification: `codex/ui2-desktop-coverage-foundation` / `0a0b8050` with the
shared UI 2.0 worktree still dirty. This supplement is a regression/evidence slice, not a redesign.

### Decision

- All six verified Profile Function IDs remain verified after later shared component and CSS work.
- No real Profile production defect was reproduced. No Profile Feature, CSS, API, route, database or storage file was
  changed by P11.4.
- The four valid P7A.2 screenshots were retained byte-for-byte. Only the missing current global Toast and Dark avatar
  save-error changed states were captured.

### Final Serial Tests

All commands used source through the Playwright-managed real Vite server at `http://127.0.0.1:4197/`, Chromium,
`workers=1`, and ran serially:

| Group | Spec | Result |
|---|---|---|
| Profile focused | `ui2-settings-profile.spec.ts` | `6/6` |
| Profile legacy/business | `profile.spec.ts` | `3/3` |
| Settings regression | `settings.spec.ts` | `17/17` |
| Dark regression | `dark-mode.spec.ts` | `2/2` |
| Final total | four groups above | `28/28` |
| Delta evidence capture | two new changed-state cases | `2/2` |

Web UI 2.0 lint guards passed. Full Web typecheck was attempted on 2026-07-23 but is currently blocked by the
out-of-scope `WorkBoardInspector.tsx:78` `string | undefined` to `string` error. P11.4 did not modify the prohibited
Work Board owner; this does not change the four passing browser regression groups above.

The focused suite now verifies avatar choose/crop/Cancel/focus restore/save failure/rollback, invalid upload, name
inline edit/Escape/blur autosave/saving/success/error, a global success Toast that remains visible before its three-
second boundary and then disappears, persistent errors, read-only handle text, default-expanded usage insight,
loading/empty/data/long skills, 1440 Light, 1280 Dark, keyboard, input containment, reduced motion, theme-token
ownership, console cleanliness and document root overflow. Legacy coverage retains successful transparent circular
avatar export plus channel/private-message identity propagation.

### Current Screenshot Manifest

| File | Theme / viewport | SHA-256 | Original-size inspection |
|---|---|---|---|
| `1440x960-ling-light-settings-profile-loaded.png` | `ling-light`, 1440x960 | `6a92b8ff2bcfad4aeb198706358d7c23ac8b2adf81c506cd0264a377f2bfd614` | Identity, default-expanded insight, keyboard-selected range and five truncated long skill rows remain bounded. |
| `1440x960-ling-light-settings-profile-crop.png` | `ling-light`, 1440x960 | `4850664511600d1c261fd07da3679097997f0db1f5f28bc30658ab41a0d9a450` | Shared Dialog, overlay, crop frame, zoom and actions are fully visible without clipping. |
| `1440x960-ling-light-settings-profile-toast.png` | `ling-light`, 1440x960 | `2a2ec85734f749702e972e1e65da7ca52b20a26754785aa2af42279c67d3bf35` | New P11.4 evidence: saved name and the single global success Toast are visible top-center without shifting content. |
| `1280x800-ling-dark-settings-profile-loading.png` | `ling-dark`, 1280x800 | `a9383eb1341d18ccc2dc1810e0b0df2348ed4ffc8ff067806990d5c0f69fb7d1` | Stable Dark skeleton geometry shows no fake identity or empty state. |
| `1280x800-ling-dark-settings-profile-avatar-error.png` | `ling-dark`, 1280x800 | `3574a7eae22363a77dba74121dd4a1f107b6316a1a26f3ea749dbbf8d0bb55e0` | New P11.4 evidence: failed crop save restores initials, keeps danger feedback visible and does not leak Light surfaces or a success Toast. |
| `980x680-ling-dark-settings-profile-save-error-long.png` | `ling-dark`, 980x680 | `5aa24bafff0af1971b1305825a5b79bce3c262034113f9943d4db91aa4f3d428` | Long data, two-column compact metrics, persistent name error and bounded heatmap remain usable. |

All six filenames match their actual PNG dimensions and all six were inspected at original resolution. The original
four files retain their 2026-07-20 mtimes; the two P11.4 files were captured on 2026-07-23.

### U13 Selector Handoff

- `strict-console.css` no longer contains the `.profile-page` Dark compatibility entry; parent shell/theme tokens own
  the effective surface.
- Settings Profile exposes stable identity/usage/name/summary data contracts. `profile.spec.ts`, `app.spec.ts`,
  `dark-mode.spec.ts` and `ui2-feedback-data-display.spec.ts` use those contracts for the migrated critical paths.
- Active standalone selectors in `profile.css` remain intact; the U13 closeout did not confuse the standalone route
  with Settings-only Profile ownership.
- A stale cross-module Model Workbench empty-state locator was isolated and corrected; exact repeat `3/3` and final
  Profile/App/Dark/Feedback selected regression `32/32` passed.
