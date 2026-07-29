# T13-P.3-Q AppShell Geometry Formal Evidence

## Scope

- Slice: `T13-P.3-Q AppShell geometry formal evidence`.
- Primary Function ID: `SHELL-SIZE-001`.
- Supporting Function IDs: `SIDEBAR-PRIMARY-001`, `UI-MOTION-TOKENS-001`.
- Covered surfaces: AppShell, expanded and collapsed Sidebar, the `900/901px` responsive boundary, Settings fullscreen shell and reduced-motion geometry synchronization.
- This evidence pass did not modify production code, APIs, contracts, routes, state machines or business behavior.

## Build Identity

- Captured: 2026-07-26, Asia/Shanghai.
- Branch: `codex/ui2-desktop-coverage-foundation`.
- Base HEAD: `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Working tree: dirty integrated Desktop/UI2 workspace; no reset, clean, stash, commit or push was performed.
- Served artifact: real Vite dev server at `http://127.0.0.1:4292`, started by Playwright; this was not `dist` or a static preview.
- Fixture: Playwright mock daemon from `createBaseState({ approvalStatus: "expired" })`.

## Automated Verification

Command:

```bash
LING_PLAYWRIGHT_PORT=4292 LING_CAPTURE_UI2_EVIDENCE=1 \
  corepack pnpm --filter @ling-stack/web test:e2e -- \
  ui2-app-shell-geometry-reduced-motion.spec.ts
```

Result: `5/5 passed` in 10.1 seconds.

The four viewport cases each verify:

- reduced motion resolves Sidebar animation, Sidebar transition and AppShell grid transition to `0ms`;
- expanded geometry is `240px` and collapsed geometry is `48px` for both the Sidebar box and AppShell first grid column;
- the workspace begins exactly at the Sidebar edge and ends at the viewport edge after the 20ms observation point;
- Settings is one full-width AppShell column, its outer workspace owns `overflow: hidden`, and only Settings navigation/content own vertical scrolling;
- `documentElement` has no horizontal or vertical overflow beyond one-pixel rounding tolerance;
- `console.error` count is `0` and `pageerror` count is `0`; the spec does not filter failed-resource errors.

The fifth case verifies that ordinary motion retains the existing `520ms` Sidebar animation and AppShell grid transition rhythm.

## Geometry Matrix

| Viewport | Captured state | Sidebar / first column | Workspace geometry | Result |
|---|---|---:|---|---|
| `1440x960` | Light, expanded | `240px / 240px` | `left=240px`, `right=1440px` | pass |
| `1280x800` | Dark, collapsed | `48px / 48px` | `left=48px`, `right=1280px` | pass |
| `900x800` | Dark boundary, collapsed | `48px / 48px` | `left=48px`, `right=900px` | pass |
| `901x800` | Dark boundary, expanded | `240px / 240px` | `left=240px`, `right=901px` | pass |
| `1280x800` | Dark, Settings fullscreen | hidden App Sidebar / `1280px` shell column | outer workspace `overflow-x/y: hidden` | pass |
| `1280x800` | Dark, expanded after 20ms | `240px / 240px` | reduced-motion synchronization is already complete | pass |

## Screenshot Evidence

| File | Theme / viewport | State | Bytes | SHA-256 |
|---|---|---|---:|---|
| `1440x960-ling-light-expanded.png` | `ling-light`, `1440x960` | Expanded 240px Sidebar and aligned workspace | 62,282 | `e5c39676f9ca109a77fd7100f9b76b91332a20b9ba8e1d0080c697bb1b13f815` |
| `1280x800-ling-dark-collapsed.png` | `ling-dark`, `1280x800` | Collapsed 48px rail and aligned workspace | 40,590 | `269191d5ae74b5d45b13cb8fd901a067d3d3a93ff7287fdc37326db3f593f549` |
| `900x800-ling-dark-collapsed-boundary.png` | `ling-dark`, `900x800` | Responsive boundary keeps the 48px rail | 39,264 | `59d628127b553edb85a772b895937e5e6f9a9b41ff7729e8c1471470c5e18e5d` |
| `901x800-ling-dark-expanded-boundary.png` | `ling-dark`, `901x800` | Desktop boundary uses the 240px Sidebar | 59,202 | `094f276aaa7e36222602b403306e060e904bf0143fc46ca80d5ada26aa911e2d` |
| `1280x800-ling-dark-settings-fullscreen.png` | `ling-dark`, `1280x800` | Settings full-width shell with internal scroll owners | 88,228 | `30e3035251ae1e5734491fab290d6f12ecd3f96322435f857ff3dc305b88d062` |
| `1280x800-ling-dark-reduced-motion-20ms-synchronized.png` | `ling-dark`, `1280x800` | Sidebar and first grid column synchronized 20ms after expansion | 61,773 | `82dcf1b44ffd1367b546524c5723a1f9d2bddebd3527f66fc9c9323fd610ea95` |

All six PNG files are non-empty, retain their named viewport dimensions and were inspected at original resolution after the formal capture run. No Sidebar/workspace gap, overlap, clipping, theme leakage, incoherent text/action overlap or document overflow was observed.

## Inspector No-Go Boundary

The dormant global Inspector is not reachable from the current `ViewId` set and remains a product-decision no-go. This slice does not claim Inspector-open geometry, does not restore or delete Inspector rules, and does not use current no-Inspector screenshots as proof that the compatibility contract is safe to remove. A future decision must first choose between restoring a real global Inspector and deleting the dormant surface, then define separate expanded/collapsed Sidebar geometry and packaged Desktop evidence.

## Honest Boundaries

- These are Chromium/Vite Web screenshots, not packaged macOS or Windows evidence.
- Windows DPI, native title bar, forced-colors, multi-display and Electron safe-area behavior remain in the Desktop release matrix.
- The evidence proves current AppShell/Sidebar/Settings geometry and motion contracts only; it does not broaden `SHELL-SIZE-001` beyond the tested states.
