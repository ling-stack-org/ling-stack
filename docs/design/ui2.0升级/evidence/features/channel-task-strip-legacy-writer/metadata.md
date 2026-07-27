# Channel Task Strip Legacy Writer Release UI 2.0 Evidence Metadata

## Scope And Status

- Recorded and reproduced: `2026-07-24`, Asia/Shanghai.
- Branch / baseline HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Working tree: shared and dirty before this closeout; unrelated Desktop, Computer Use and UI 2.0 changes were preserved.
- Source surface: the real Vite source application through Playwright Chromium and the existing daemon fixture,
  not isolated static markup.
- Themes and viewports: built-in `ling-light` and `ling-dark`, plus imported `Quiet Ocean`; `1440x960` and
  `1280x800`, `deviceScaleFactor=1`.
- Status: `T13-O.22 Legacy Channel Tabs / Task Strip writer release` is Web `verified`. This closes CSS ownership
  only; it does not change any Function ID and does not close packaged Electron macOS/Windows evidence.

## Reproduction And Test Results

- New `ui2-channel-task-strip-legacy-writer.spec.ts`: `3/3` passed.
- Selected Runtime/Workspace/Dark/Theme/Input integration coverage: `43/43` passed.
- Web lint, i18n, typecheck, production build and `git diff --check`: passed.
- Production build retained only the existing large-chunk warning.
- Full `channel.spec.ts`: `104/105` passed. The only failure was the existing tokenized Composer scenario
  `channel activity supports mentions, messages, files, links, and topic replies`; repeated alone it passed `2/3`.
  Consecutive `.fill()` calls can retain fragments of the previous text. The same scenario passed in the O.21 broad
  run, and O.22 changes only dead CSS plus the `task-strip-head` owner, so this is recorded as a separate Composer
  stability candidate rather than repaired or hidden in this release.
- The shared/legacy/nested input containment suite was rerun after closeout: `ui2-form-controls.spec.ts` `4/4`
  passed. Focus does not change shell height or move the native control outside its shell.

The focused suite reaches all ten current production `task-strip-head` consumers: seven Runtime heads, two Protocol
heads and one Routing head. It also covers semantic token ownership, long English containment, reduced motion,
imported Theme Pack rendering, console/page errors and document overflow.

## CSS Ownership Closeout

- Ten production/E2E-zero families are removed from all CSS owners: `channel-tabs`, `channel-tab`,
  `channel-utility-tabs`, `channel-utility-tab`, `channel-tabs-row`, `channel-tabs-refresh`, `task-strip`,
  `client-task-main`, `composer-head` and `dock-card-head`.
- `task-strip-head` keeps all `10` production consumers and has one CSS owner in
  `channel-activity-work-thread.css`.
- `layout.css` decreased from `1,063` to `919` lines; `components.css` from `4,313` to `4,269` lines;
  `strict-console.css` from `462` to `457` lines.
- `channel-activity-work-thread.css` increased from `556` to `575` lines to own the live header geometry and
  long-text containment.
- Web CSS is now `156 files / 35,378 lines`, a net reduction of `174` lines.
- The new owner uses semantic tokens and adds no Theme/Profile selector, color literal, `!important`,
  `transition: all`, literal z-index or compatibility alias.

## Original-Size Screenshot Ledger

All files are direct Playwright viewport PNGs and were not resized or recompressed after capture.

| Evidence | Viewport / theme | State | SHA-256 |
|---|---|---|---|
| `1280x800-ling-dark-routing-protocol.png` | `1280x800`, `ling-dark` | Protocol and Routing heads, Select focus containment and reduced motion | `47006971cca2a0cc1edd7f4ef1a5aa7f4b1312beaff16d31c4d52d2d6f89da13` |
| `1440x960-ling-light-runtime-diagnostics.png` | `1440x960`, `ling-light` | All seven Runtime heads and long content containment | `4dce959c81428fb95c14f7b2a24cec7e0d79f83c7cf7da6936285d344debab84` |
| `1440x960-quiet-ocean-protocol.png` | `1440x960`, `Quiet Ocean` | Imported Theme Pack Protocol boundary and token ownership | `0f50d3d8bf340de8b4e835b99a2d236d8381140bc2ef2b210a195301f1f144f1` |

## Original-Size Visual Audit

All three PNGs were inspected at original size after the passing run:

- all ten live headers keep the intended flex alignment, spacing and text containment;
- the focused Select remains inside its fixed-height shell and does not gain a second overflowing border;
- Ling Light, Ling Dark and imported Quiet Ocean retain semantic surface ownership without document overflow;
- Runtime, Protocol and Routing actions remain reachable and reduced motion removes transition duration;
- no unexpected console error or page error was observed.

Two pre-existing content-layout issues are visible outside the O.22 selector scope: narrow Runtime metadata can
overlap in the right Dock, and some Quiet Ocean Protocol label/value pairs are too tight. They are retained as a
future Right Dock content-layout candidate and are not classified as O.22 regressions.

## Honest Remaining Gaps

- O.22 does not complete U13 or the overall UI 2.0 program. The next candidate needs a new read-only audit before
  any aggregate CSS is edited.
- The intermittent tokenized Composer fill behavior remains open and needs an isolated behavior/test-stability slice.
- No packaged Electron macOS Retina or Windows 125%/150% capture was produced.
- This Web archive does not prove native titlebar, OS font rasterization, forced colors, GPU composition or packaged
  renderer startup behavior.
- Large production files such as `WorkspaceClientView.tsx` and `TeammateWorkspace.tsx` remain architecture debt;
  O.22 did not add behavior to them.
