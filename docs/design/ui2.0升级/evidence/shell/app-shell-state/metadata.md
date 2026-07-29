# P4.6 AppShell Navigation, Theme And Presentation Evidence

## Capture Context

- Date: `2026-07-19`
- Branch: `codex/ui2-desktop-coverage-foundation`
- Base HEAD: `0a0b8050`
- Working tree: dirty; Desktop/Computer Use and UI 2.0 work remain intentionally preserved together
- Served artifact: Playwright-managed real Vite development server at `http://127.0.0.1:4174`, not `dist`
- Browser: Playwright Chromium
- Data source: deterministic `mockDaemon` fixture with channel, teammate, recent conversation, approvals and work-board state
- Locale: `en-US`

Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm exec playwright test \
  e2e/ui2-app-shell-state.spec.ts
```

## Screenshots

| File | Viewport | Theme Pack | State |
|---|---|---|---|
| `1440x960-ling-light-channel-return.png` | `1440x960` | `ling-light` | Settings return restored selected Engineering channel and channel surface |
| `1280x800-ling-dark-approvals-surface.png` | `1280x800` | `ling-dark` | Fixed theme preserved across conversation, teammate, media and approvals surfaces |

SHA-256:

```text
6095919c52aaa1a788ba31b22a6574e201e09e70ba9dc87b3de9d6cabb9dbde3  1280x800-ling-dark-approvals-surface.png
72eb0ce94901ef6446acc4aa6a627860364a12283479a6c2f8342400e2f1927f  1440x960-ling-light-channel-return.png
```

## Verified Navigation Behavior

- Settings captures and restores the exact prior view, Sidebar target, selected channel and selected object state.
- Work Board -> Settings -> Back returns to Work Board with one active navigation item.
- Channel -> Settings -> Back returns to the selected channel and usable composer.
- AppShell identity markers survive navigation and Settings transitions; the shell is not remounted.
- All 13 ViewIds and workspace home/conversation/channel identity combinations resolve to one registered presentation surface.
- Home, conversation, channel, management, settings, media-canvas, diagnostics and approvals mappings have deterministic fallback.
- Both target viewports remain free of document-level horizontal overflow and unexpected browser errors.

## Verified Theme Behavior

- Fixed `ling-dark` remains selected while route surfaces change.
- Existing ThemeRegistry evidence verifies fixed first/final paint, System OS switching, open Drawer/focus preservation,
  imported pack bootstrap parity, invalid manifest fallback and storage rollback Toast.
- Existing generated Presentation evidence verifies Profile route policy, viewport reduction, Settings artwork-off policy and
  AppShell identity preservation.
- Existing Desktop evidence verifies revisioned theme snapshots and stale-revision rejection for main/PiP renderers.

## Automated Evidence

- AppShell route/return/surface resolver: `3/3` passed.
- ThemeRegistry plus generated Presentation Profile: `6/6` passed.
- Existing App navigation and Dark Mode targets: `4/4` passed.
- Browser evidence covers Light/Dark, `1440x960`/`1280x800`, route return, selection, fixed theme,
  all ViewId surface mappings, shell identity, console and overflow.

## Status Decision And Remaining Scope

- `SHELL-NAV-001`: `verified`.
- `SHELL-THEME-001`: `verified` for AppShell runtime; Desktop platform evidence remains owned by Desktop Function IDs.
- `SHELL-THEME-PRESENTATION-001`: `implemented`, not verified. Profile and route policy work, but real artwork bytes,
  asset publish/checksum, decode/preload/crossfade and client visual layer remain U4/U7 work.
- `SHELL-OVERLAY-001` and `SHELL-SIZE-001` remain separate open Function IDs.
- First Run has no confirmed production trigger and remains `inventory`.
- The dark approvals screenshot exposes feature-owned legacy light chips; they belong to Approvals migration, not AppShell theme state.
