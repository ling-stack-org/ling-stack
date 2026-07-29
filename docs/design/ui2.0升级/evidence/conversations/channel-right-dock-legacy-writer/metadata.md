# Channel Right Dock Legacy Writer UI 2.0 Evidence Metadata

## Scope And Status

- Slice: `T13-O.25 Channel Right Dock aggregate ownership release`.
- Status: Web CSS ownership `verified`; Channel Function IDs and packaged Desktop status are unchanged.
- Served artifact: Vite source through the Playwright-managed Web server.
- Viewports and themes: `1440x960` Ling Light, `1280x800` Ling Dark with reduced motion, and
  `1440x960` imported Quiet Ocean.

## Ownership Closeout

- `channel-right-dock/shell.css` is the focused owner for Channel workspace grid, Dock frame, panel motion,
  resize handle, desktop width and protocol/inspector adapters.
- Package `RightDockShell` remains the owner for the two-row layout, border, semantic background, Header, Body,
  launcher rows and controls. The focused file does not repaint package chrome.
- Old `channel-side-panel-*` chrome, `channel-review-*`, `channel-management-panel` adapters and `channel-files`
  have zero production consumer and zero CSS writer. The final static scan found the last 12-line `.channel-files`
  writer in `layout.css`; it was deleted and added to the focused absence guard.
- `components.css` decreased from `4,195` to `3,743` lines. The 4-line facade imports the new 161-line shell, while
  `layout.css` decreased from `919` to `907` lines. The four-file O.25 write set therefore removes a net `302` lines.
- Current Web CSS is `158 files / 34,998 lines`, including the root `apps/web/src/styles.css` entrypoint.
- The focused owner adds no color literal, Theme/Profile selector, `transition: all`, literal z-index or duplicated
  shared-control chrome. The existing resize cursor `!important` remains narrowly scoped.

## Test Results

- New focused spec ordinary run: `3/3` passed.
- Formal evidence capture: `3/3` passed.
- Selected Channel/Normal/Teammate Dock combination: `26/26` passed. The frozen estimate of `29` was stale;
  the six current specs mechanically enumerate 26 tests.
- Broad Channel/Workspace/Dark/Theme Registry regression: `125/125` passed.
- Supplemental form-control regression: `4/4` passed, including shared controls and legacy nested searches.
- Web lint, i18n, typecheck, production build and `git diff --check`: passed. The build keeps only the existing
  large-chunk warning.

The first selected attempt passed `4` tests, then the Playwright-managed Vite process exited. The remaining `19`
tests reported `ERR_CONNECTION_REFUSED`; the first affected scenario passed in isolation, and a fresh-server rerun
passed the complete `26/26`. This is retained as test-infrastructure history and is not reported as a product failure.

## Original-Size Screenshot Ledger

All PNGs are direct Playwright viewport captures and were not resized or recompressed.

| Evidence | State | SHA-256 |
|---|---|---|
| `1440x960-ling-light-channel-dock-plans-resized.png` | Light Plans page after horizontal resize, 28-row internal scroll | `36bc962164cfb7e668fd5cbabf73ff75ab36c81c7810f97843f82fdfc14582eb` |
| `1280x800-ling-dark-summary-with-channel-dock.png` | Dark reduced-motion Summary and Dock visible side by side | `78da3fc3092206598eddb6b2d659de70a3e4f0f0355ef18f3487ecb3b85c7971` |
| `1440x960-quiet-ocean-channel-dock-plan-detail.png` | Imported theme, long plan detail and package-owned Header/Body | `e45e4fa762c47c887d85f6c8a5acb9244fd555df5638ae6ba4453569b9bbc705` |

## Original-Size Visual Audit

- Dock Header and Body use the package token background, border and text ownership in all three captures.
- The resize separator stays aligned between the conversation and Dock; the resized Plans list scrolls internally.
- Summary remains mounted and moves beside the Dark Dock without disappearing or overlapping it.
- Long plan text wraps inside the Dock and does not create document or region horizontal overflow.
- Light, Dark and imported theme remain readable; no unexpected console error or page error was observed.

## Input Focus Boundary

The reported focus overflow is not a global `@ling-stack/ui-react` Input defect. Shared Input/Select/Textarea and
the tracked legacy nested searches pass `ui2-form-controls.spec.ts` `4/4`: focus does not change the outer bounding
box and the inset ring remains inside the shell. Remaining raw inputs stay in the U13 page-by-page migration budget.
Do not add a global `input:focus` override.

## Remaining Gaps

- O.25 closes one Web CSS ownership lane; it does not complete U13 or the overall UI 2.0 program.
- Packaged macOS Retina, Windows scaling/forced-colors and Desktop restart evidence remain separate release gates.
- `WorkspaceClientView.tsx` remains above 4,700 lines of architecture debt. O.25 deliberately added no behavior to it.
