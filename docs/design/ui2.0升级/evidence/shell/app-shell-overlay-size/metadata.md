# P4.7 AppShell Overlay And Viewport Evidence

## Build Identity

- Date: 2026-07-19
- Branch: `codex/ui2-desktop-coverage-foundation`
- Base HEAD: `0a0b8050`
- Working tree: dirty integrated Desktop/UI2 workspace; no cleanup, reset, commit, push or stash mutation
- Served artifact: real Vite dev server at `http://127.0.0.1:4174`, not `dist` or a static file preview
- Fixture: Playwright mock daemon at `/tmp/ling-stack-workspace`

## Function IDs

- `SHELL-OVERLAY-001`
- `SHELL-SIZE-001`

## Ownership Result

- `index.html` owns one sibling `#ling-ui-overlay-root` outside the React application root.
- `LingUiProvider` owns one `OverlayPortalProvider`, one Tooltip Provider and one Toast viewport.
- Shared Dialog、Drawer、Menu、Popover and Tooltip receive the same portal container.
- Toast viewport is portalled into the same root; Toast items expose `data-ling-overlay="toast"`.
- AppShell owns only the focused shell boundary and client/viewport attributes.
- Feature adapters continue to own business open state、busy state、data and callbacks.
- Electron main/preload continue to own BrowserWindow bounds、DPI、display and platform chrome.

The current Web CSS inventory remains 97 `z-index` declarations, including 25 numeric declarations at or above
60. `check-ui2-overlays.mjs` makes both values non-growth budgets. Existing declarations remain assigned to
U13/P12 cleanup; P4.7 does not claim that legacy business overlays have already migrated.

## Automated Evidence

- `@ling-stack/ui-react`: `39/39`.
- `ui2-shell-overlay-size.spec.ts`: `3/3`.
- Shell/overlay/App/Dark combined regression: `41/41`.
- Web i18n、typecheck、lint/import/overlay budgets and `git diff --check`: passed.

Covered interactions:

- one portal root and one Toast viewport;
- Dialog + warning Toast + Tooltip at z-index `61 / 80 / 90`;
- Popover at z-index `70` inside the active automation flow;
- Esc closes the top surface and restores trigger focus;
- reduced motion keeps overlay lifecycle without animation;
- AppShell identity, active Dialog and Popover survive `1440x960 -> 1280x800 -> 980x680` resize;
- viewport classes resolve to `standard / compact / minimum`, with `2560x1440` resolving to `large`;
- no document horizontal overflow or browser console errors.

## Screenshots

| File | State | SHA-1 |
|---|---|---|
| `1440x960-ling-light-dialog-toast-tooltip.png` | Light, New Channel Dialog, warning Toast and close Tooltip | `f86cd002b97a92a04b764309b305f60b4365442e` |
| `1280x800-ling-dark-dialog-popover.png` | Dark, Automation dialog with collision-safe runtime Popover | `e500d2eacec5953548dc183426118dd477dfeb2e` |

Both PNG files were inspected at original resolution. No overlap、clipping、theme leakage or incoherent
layering was observed.

## Cross-Platform Boundary

- The Web minimum fixture uses `980x680`, matching the current Electron BrowserWindow minimum in
  `apps/desktop/main/window-factory.ts`.
- This is not Windows DPI or native title-bar evidence.
- Windows 100%/125%/150% DPI、forced colors and signed Desktop package evidence remain in the Desktop
  release matrix and cannot be replaced by these Chromium screenshots.
