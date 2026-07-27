# P7-F Shared Icon Cross-Module Evidence

## Scope And Result

- Scope: shared Icon/IconButton contract and Web standard-action migration across AI Teammate/Profile,
  Council, Plugin Manager, Work Board, Channel Header and Media Production.
- Branch / HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b8050`.
- Capture date: `2026-07-27`.
- Served artifact: Playwright-owned real Vite Web app on port `4206`, not static `dist` or a code-only fixture.
- Browser / locale: Playwright Chromium / `en-US`.
- Viewports: `1440x960` Ling Light and `1280x800` Ling Dark with reduced motion.
- Focused capture result: `ui2-icon-cross-module-evidence.spec.ts` `6/6` passed.
- Cross-module P7-F regression: 17 touched specs `122/122` passed on one worker.

The evidence locks typed Lucide component input, icon-only semantics, title/ARIA/Tooltip, raw hit area,
pressed state, disabled state and keyboard `:focus-visible`. Settings Profile Avatar remains the only explicit
`legacy-react-node` identity budget; standard Web IconButton legacy usage is zero.

## Screenshots

| Surface | Light | Dark |
|---|---|---|
| AI Teammate Profile | `1440x960-ling-light-ai-teammate-profile.png` | `1280x800-ling-dark-ai-teammate-profile.png` |
| Settings Profile Avatar identity | `1440x960-ling-light-settings-profile-avatar-budget.png` | `1280x800-ling-dark-settings-profile-avatar-budget.png` |
| Council Workspace | `1440x960-ling-light-council.png` | `1280x800-ling-dark-council.png` |
| Plugin Manager | `1440x960-ling-light-plugin-manager.png` | `1280x800-ling-dark-plugin-manager.png` |
| Work Board active filter | `1440x960-ling-light-work-board-active-filter.png` | `1280x800-ling-dark-work-board-active-filter.png` |
| Channel Header utility actions | `1440x960-ling-light-channel-header-utility.png` | `1280x800-ling-dark-channel-header-utility.png` |
| Media Production | `1440x960-ling-light-media-production.png` | `1280x800-ling-dark-media-production.png` |

All 14 files were inspected at their original dimensions. No Tooltip remains in a captured frame; icons,
labels, panels and canvas content do not overlap; active/pressed states remain visible in both themes. The
Settings Dark sidebar continues to truncate long section labels at the existing compact width. That is an
existing Settings layout behavior and is not claimed or changed by the icon slice.

Exact dimensions and SHA-256 values are recorded in `manifest.json`. The manifest contains exactly 14 PNG
entries and the evidence directory contains exactly those 14 PNG files.

## Automated Evidence

- `@ling-stack/ui-react`: `69/69` passed.
- Web icon AST guard: 78 IconButton owners + 1 Profile Avatar identity budget; standard action legacy `0`.
- P7-F touched-spec integration: `122/122` passed.
- P7-F focused browser/capture: `6/6` passed.
- Input focus containment: shared package `69/69`; Header/Form focused `10/10` passed in the current turn.
- Motion follow-up: Conversation Panel/WorkCell `11/11` and Channel locate changed-state `1/1` passed.
- Browser capture assertions: console errors `0`, page errors `0`, document/surface overflow `0`.
- Web typecheck, lint/motion/icon/text-control guards, i18n and `git diff --check` are final closeout gates.

## Status Boundary

P7-F Web formal evidence is complete. `UI-ICON-FOUNDATION-001` and `UI-ICON-MAP-001` may advance to
`implemented` with verified Web evidence, but are not marked globally `verified` while their declared P7-E
Motion dependency and packaged macOS/Windows evidence remain open. Logo, favicon, Desktop packaged icons and
brand geometry were not modified.
