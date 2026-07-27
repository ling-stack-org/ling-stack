# Run Guidance Legacy Writer Release UI 2.0 Evidence Metadata

## Scope And Status

- Recorded and reproduced: `2026-07-24`, Asia/Shanghai.
- Branch / baseline HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Working tree: shared and dirty before this closeout; unrelated Desktop, Computer Use and UI 2.0 changes were preserved.
- Source surface: the real Vite source application through Playwright Chromium and the existing daemon fixture,
  not isolated static markup.
- Themes and viewports: built-in `ling-light` and `ling-dark`, plus imported `Quiet Ocean`; `1440x960` and
  `1280x800`, `deviceScaleFactor=1`.
- Status: `T13-O.23 Run Guidance legacy writer release` is Web `verified`. This closes CSS ownership only; it does
  not change any Function ID and does not close packaged Electron macOS/Windows evidence.

## Reproduction And Test Results

- New `ui2-run-guidance-legacy-writer.spec.ts`: ordinary run `3/3` passed; evidence capture run `3/3` passed.
- Existing Runs/Runtime combination: `26/26` passed, including scoped failure, retry, promote, queue/cancel,
  recording validation and reduced motion.
- Selected Runs/Runtime/Conversation Feedback/Input/Dark/Theme combination: `41/42` passed. The only failure was
  the pre-existing Channel runtime guidance Menu outside-click assertion at `page.mouse.click(4, 4)`; exact isolated
  repeat passed `1/3`. It does not use `.run-guidance-panel` or any O.23 selector and remains a separate interaction
  stability candidate.
- Broad App/Channel/Teammates/Workspace combination: `157/158` passed. The only failure was a Teammate channel
  membership assertion waiting for `Set default` to disappear; exact isolated repeat passed `3/3`. The full Channel
  scenario that was intermittent during O.22 passed in this run.
- Web lint, i18n, typecheck, production build and `git diff --check`: passed.
- Production build retained only the existing large-chunk warning.

The focused suite covers empty, queue, cancel, scoped failure, retained draft, retry, long guidance, promote and
started states. It also locks shared Textarea focus containment, 32px button hit areas, reduced motion, imported Theme
Pack rendering, console/page errors, panel overflow and document overflow.

## CSS Ownership Closeout

- Eight production-zero families are removed from `components.css`: `run-guidance-actions`,
  `run-guidance-submit-row`, `run-guidance-row-meta`, `run-guidance-input`, `run-guidance-list`, `run-guidance-row`,
  `run-lineage-banner` and `run-guidance-row-main`.
- Their production references and CSS writers are `0`; the new focused spec intentionally retains one negative
  absence-guard string for each family.
- `.run-guidance-panel` keeps `1` production consumer, `2` existing E2E consumers and one CSS owner in
  `styles/runs/guidance.css`.
- `components.css` decreased from `4,269` to `4,195` lines.
- `runs.css` increased from `8` to `9` import lines and the new focused owner is `4` lines.
- Web CSS is now `157 files / 35,309 lines`, a net reduction of `69` lines.
- The new owner adds no color literal, Theme/Profile selector, `!important`, `transition: all`, literal z-index,
  package-private selector or compatibility alias.

## Original-Size Screenshot Ledger

All files are direct Playwright viewport PNGs and were not resized or recompressed after capture.

| Evidence | Viewport / theme | State | SHA-256 |
|---|---|---|---|
| `1280x800-ling-dark-failure-focus-reduced-motion.png` | `1280x800`, `ling-dark` | Shared Textarea focus, scoped 503 failure, retained draft and reduced motion | `48d59ec1fb006445b12bf2c13ef9fef72ae314748dc1d7049fae2a39dce6a43a` |
| `1440x960-ling-light-queued-actions.png` | `1440x960`, `ling-light` | Queued guidance with Cancel and Start handling actions | `b023b211adeb895f04b1b64cf1179299f923ff3553f5a5b42a95e0ec654b1eac` |
| `1440x960-quiet-ocean-started-long-guidance.png` | `1440x960`, `Quiet Ocean` | Imported Theme Pack, long guidance containment and started state | `fa23e4d9b68faa2160c56359e907b259ad00cae359fa82a3bcea41520dfddc15` |

## Original-Size Visual Audit

All three PNGs were inspected at original size after the passing capture run:

- the focused Dark Textarea stays inside the Inspector body; focus does not increase width or height or create an
  overflowing inner border;
- panel, detail workspace and document remain free of horizontal overflow in both viewports;
- queue, cancel, retry and promote actions remain reachable with at least 32px hit areas;
- Ling Light, Ling Dark and imported Quiet Ocean retain readable semantic surfaces;
- long guidance wraps inside the Run Detail panel without clipping or document growth;
- no unexpected console error or page error was observed beyond the deliberately injected 503 in the failure case.

The evidence also exposed a pre-existing Runs content-layout issue: the intervention DataRow placed identity, status
and long guidance too tightly. T13-O.26 subsequently closed that presentation debt with the focused actionable/read-only
`RunInterventionRow`; see `../run-intervention-row/metadata.md`. O.23 itself remains a CSS-ownership-only historical slice.

## Honest Remaining Gaps

- O.23 does not complete U13 or the overall UI 2.0 program. Its intervention-row follow-up is closed by O.26; any next
  aggregate candidate still requires a new read-only audit before editing.
- Channel runtime guidance Menu outside-click remains intermittent (`1/3` isolated) and needs an independent
  interaction-stability diagnosis; O.23 did not modify `.conversation-guidance-*` or Menu code.
- The broad Teammate membership assertion failed once but passed `3/3` in isolation; the long-suite timing risk remains.
- No packaged Electron macOS Retina or Windows 125%/150% capture was produced.
- This Web archive does not prove native titlebar, OS font rasterization, forced colors, GPU composition or packaged
  renderer startup behavior.
- Large production files such as `WorkspaceClientView.tsx` and `TeammateWorkspace.tsx` remain architecture debt;
  O.23 did not add behavior to them.
