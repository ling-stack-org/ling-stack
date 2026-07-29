# Teammates Legacy Writer Release UI 2.0 Evidence Metadata

## Scope And Status

- Recorded and reproduced: `2026-07-24`, Asia/Shanghai.
- Branch / baseline HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Working tree: shared and dirty before this closeout; unrelated Desktop, Computer Use and UI 2.0 changes were preserved.
- Source surface: the real Vite source application through Playwright Chromium and the existing daemon fixture,
  not isolated static markup.
- Themes and viewports: built-in `ling-light` and `ling-dark`, plus imported `Quiet Ocean`; `1440x960` and
  `1280x800`, `deviceScaleFactor=1`.
- Status: `T13-O.21 Teammates legacy writer release` is Web `verified`. This closes CSS ownership only; it does
  not change any Function ID and does not close packaged Electron macOS/Windows evidence.

## Reproduction And Test Results

- New `ui2-teammates-legacy-writer.spec.ts`: `8/8` passed.
- Focused selected Teammates coverage: `19/19` passed.
- All `ui2-teammate-management-*.spec.ts`: `74/74` passed.
- Cross-module App/Channel/Teammates/Archive/Dark/Councils/Profile/Settings/Theme/Sidebar regression:
  `171/171` passed.
- Web lint, i18n, typecheck, production build and `git diff --check`: passed.
- Production build retained only the existing large-chunk warning.

The new suite covers the management shell, long identity containment, empty state, private conversation Search and
right Dock, MCP Settings, imported Theme Pack ownership, shared Avatar rendering in Channel/Council/Profile, console
and page errors, document overflow and reduced motion. It also locks the Search focus geometry: the native input stays
inside its fixed shell before and after focus, with no second overflowing border or shadow.

## CSS Ownership Closeout

- `teammates.css` decreased from `946` lines to deletion; its import and legacy writer references are `0`.
- `strict-console.css` decreased from `584` to `462` lines; positive strict Teammates repaint is `0`.
- `components.css` decreased from `4,323` to `4,313` lines.
- Web CSS is now `156 files / 35,552 lines`.
- Focused owners are `teammate-management-shell.css` at `59` lines,
  `shared/teammate-avatar.css` at `19` lines, `teammate-private-feed-composer.css` at `235` lines
  (`208 -> 235`) and `conversation-message-frame.css` at `299` lines (`298 -> 299`).
- `shared/teammate-avatar.css` is the unique Avatar base writer. It preserves the existing 54px default and 34px
  compact contracts, circular clipping, `object-fit: cover`, border and fallback behavior across management,
  private conversation, Sidebar, Channel, Council and Profile consumers.
- New declarations contain no forbidden color literal, Theme/Profile selector, `!important`, `transition: all`,
  literal z-index or package-private selector. The ten previously accepted `conversation-message-frame.css`
  exceptions remain outside O.21 and were not reclassified.

## Original-Size Screenshot Ledger

All files are direct Playwright viewport PNGs and were not resized or recompressed after capture.

| Evidence | Viewport / theme | State | SHA-256 |
|---|---|---|---|
| `1280x800-ling-dark-management-empty.png` | `1280x800`, `ling-dark` | Management empty state and contained page geometry | `5eb692f40ba21fe71acd7e348c77aa052fa96cfc6d3c8e9701d0a6ade0707a2a` |
| `1280x800-ling-dark-private-search-dock-reduced-motion.png` | `1280x800`, `ling-dark` | Private Search focus containment, feed, Summary/Dock and reduced motion | `db1e651047e2b22ca7e448a9073a7e55b07b02bac7d743bef105a62a3418087e` |
| `1280x800-ling-dark-teammate-profile-avatar.png` | `1280x800`, `ling-dark` | Teammate Profile Avatar crop and base-writer contract | `1e423a45089bebce20d8932bb66e799b225f180fa56985a4ea4672448917dee5` |
| `1440x960-ling-light-channel-teammate-stack.png` | `1440x960`, `ling-light` | Channel teammate stack Avatar cross-domain rendering | `45b4ff386e37d3ad6c6e7bc423239ccc5af2749c2af8003f5bce513ed920ae8f` |
| `1440x960-ling-light-council-members-avatar.png` | `1440x960`, `ling-light` | Council Members Avatar cross-domain rendering | `9afaf4274c689e98d00b2b1f1cf12c5c20ad59b681f40e64cac64b1d099a86bf` |
| `1440x960-ling-light-management-avatar-contract.png` | `1440x960`, `ling-light` | Management list, Sidebar and long-name Avatar contract | `732b24cbf5053d51cd139df05f4af1bbf7475cfe08a70e44d92bc01f2bae74c5` |
| `1440x960-quiet-ocean-management-surface.png` | `1440x960`, `Quiet Ocean` | Imported Theme Pack management shell and Avatar tokens | `4a0918deb99867c0b69801ddd48f39cf789a366f0fb3069051519d60149bd694` |
| `1440x960-quiet-ocean-private-mcp-settings.png` | `1440x960`, `Quiet Ocean` | Imported Theme Pack private MCP Settings and shared controls | `252d460f18b05602cd304574b5e9d87003f97b0e12c8b6ebe7dad940ef06e424` |

## Original-Size Visual Audit

All eight PNGs were inspected at original size after the passing run:

- focused Search keeps its native input inside the outer shell; focus does not increase height or create an
  overflowing inner border;
- management, private conversation, MCP Settings and empty-state surfaces stay inside both viewports without
  document horizontal overflow;
- Sidebar, Channel teammate stack, Council Members, management list and Profile use one Avatar base contract without
  distorted images, square leaks or opposite-context sizing;
- Ling Light, Ling Dark and imported Quiet Ocean use semantic surfaces and readable controls without strict-layer
  repaint or hard-coded Light/Dark blocks;
- Summary/Dock and private conversation geometry remain stable under reduced motion;
- no unexpected console error or page error was observed.

## Honest Remaining Gaps

- O.21 does not complete U13 or the overall UI 2.0 program; the next slice is only a read-only O.22 aggregate
  candidate audit.
- No packaged Electron macOS Retina or Windows 125%/150% capture was produced.
- This Web archive does not prove native titlebar, OS font rasterization, forced colors, GPU composition or packaged
  renderer startup behavior.
- Large production files such as `TeammateWorkspace.tsx` remain architecture debt and were not touched by this CSS
  ownership release.
