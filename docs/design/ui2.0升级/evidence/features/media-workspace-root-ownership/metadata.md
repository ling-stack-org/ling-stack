# Media Workspace Root Ownership UI 2.0 Evidence Metadata

## Scope And Status

- Recorded and reproduced: `2026-07-24`, Asia/Shanghai.
- Branch / baseline HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Working tree: shared and dirty before this closeout; unrelated Desktop, Computer Use and UI 2.0 changes were preserved.
- Source surface: the real Vite source application through Playwright Chromium and the existing daemon fixtures,
  not isolated static markup.
- Themes and viewports: built-in `ling-light` and `ling-dark`, plus imported `Quiet Ocean`; `1440x960` and
  `1280x800`, `deviceScaleFactor=1`.
- Status: `T13-O.24 Media Workspace root / Dark repaint ownership release` is Web `verified`. It closes CSS
  ownership only; Media Function IDs remain unchanged and packaged Electron macOS/Windows evidence remains pending.

## Reproduction And Test Results

- New `ui2-media-workspace-root-ownership.spec.ts`: final ordinary run `3/3` passed; formal evidence capture run
  `3/3` passed.
- Selected Media/Dark/Theme/AppShell combination: `31/31` passed.
- Broad Media combination: final rerun `64/64` passed, including Media Jobs, all focused Media Production slices,
  legacy Media Jobs/Production, Dark, Theme Registry and AppShell state.
- Web lint, i18n, typecheck, production build and `git diff --check`: passed. The production build retained only the
  existing large-chunk warning.
- Supplemental shared form-control regression: `4/4` passed, including shared Input/Select and legacy nested input
  focus geometry. This directly confirms that the reported focus overflow is not a global shared-component defect.

The first focused run correctly failed `0/3`: the later `app-shell-overlay-size.css` workspace rule overrode the
focused Media root with `overflow:auto`. The rule now excludes `.workspace-generation-surface`. The first broad run
was `60/64` because one pre-existing Media preview assertion targeted three valid error previews at once and skipped
three later serial cases. The assertion was narrowed to the visible hero preview, passed an isolated `3/3`, and the
complete broad suite then passed `64/64`. These failures are retained here as diagnosis history rather than being
reported as an uninterrupted green run.

A supplemental legacy `ui2-shell-overlay-size.spec.ts` run was `1/3`: its viewport resolver passed, while the Dialog
close Tooltip assertion and the old Automations `Manual create` entry assertion failed. Exact repeats were `0/3` for
each. Neither assertion loads Media or matches `.workspace-generation-surface`; the planned AppShell state suite
passed `3/3`. These stale overlay/Automations test contracts remain a separate follow-up and are not hidden inside
the O.24 result.

## CSS Ownership Closeout

- `.workspace.workspace-generation-surface` has one focused positive owner in
  `styles/features/media-production/shell.css` and zero positive writer in `strict-console.css`.
- `workspace.css`, `layout.css`, `components.css`, `strict-console.css` and the later AppShell sizing owner contain
  `31` negative exclusions in total. This is one more than the frozen estimate because the first browser run exposed
  the previously missed AppShell rule.
- All `24` Dark descendant blankets and the separate Dark root writer exclude Media. Media controls now retain Theme
  Pack and shared primitive ownership.
- `strict-console.css` decreased from `457` to `439` lines; `media-production/shell.css` increased from `95` to
  `104` lines. The AppShell exclusion changes only an existing selector and adds no line.
- Web CSS is now `157 files / 35,300 lines`, a net reduction of `9` lines from O.23.
- No new color literal, Theme/Profile ID selector, `!important`, `transition: all`, literal z-index, duplicated shared
  control chrome or package-private selector was introduced.

## Original-Size Screenshot Ledger

All files are direct Playwright viewport PNGs and were not resized or recompressed after capture.

| Evidence | Viewport / theme | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-production-studio-full-bleed.png` | `1440x960`, `ling-light` | Loaded Production Studio, nonblank Canvas, project dock and scene Inspector | `a6aa561505436b345b3caee19d2d43c0049641d77382b62b79510b575ad585ee` |
| `1280x800-ling-dark-generation-tasks.png` | `1280x800`, `ling-dark`, reduced motion | Generation Tasks list/detail, focused shared Textarea and create Dialog | `5b8d799cbf6a2b0b6bfe835da95245937e08a6aa5efedbe6d768ec221ea09ab8` |
| `1440x960-quiet-ocean-media-dialog.png` | `1440x960`, imported `Quiet Ocean` | Generation Tasks detail and Theme-owned create Dialog | `98b16e239f38aa7eff9ecdd6e6949a955f1f5a59eac40ff7a5c64f804c2febc8` |

## Original-Size Visual Audit

All three PNGs were inspected at original size after the passing capture run:

- Production Studio reaches the complete workspace surface with no inherited page padding, border or blur;
- Canvas pixels are nonblank, scene nodes are framed, and both project and scene docks remain usable;
- Generation Tasks keeps its list/detail structure without document or region horizontal overflow;
- the focused Dark Textarea keeps the same bounding box before and after focus, and its inset ring remains inside the
  control border;
- Light, Dark and imported Quiet Ocean keep readable Dialog, Field, Select, Button and status semantics;
- no unexpected console error or page error was observed beyond the fixture-owned unavailable-preview request that
  is explicitly filtered by URL.

## Honest Remaining Gaps

- O.24 does not complete U13 or the overall UI 2.0 program. The next aggregate owner must receive a new read-only
  audit before production CSS is edited.
- Shared `Input`, `Select` and `Textarea` focus containment is verified, but not every legacy raw input in the product
  has migrated; those controls remain in the U13 page-by-page migration budget and must not receive a global patch.
- The legacy Shell overlay spec still expects a removed Dialog-close Tooltip and an old Automations `Manual create`
  entry. Both assertions need a separate current-IA test refresh; O.24 does not change overlay or Automations code.
- No packaged Electron macOS Retina or Windows 125%/150% capture was produced. Native titlebar, font rasterization,
  forced colors, GPU composition and packaged renderer startup remain separate release gates.
- Large production files such as `WorkspaceClientView.tsx` and `TeammateWorkspace.tsx` remain architecture debt;
  O.24 added no behavior to them.
