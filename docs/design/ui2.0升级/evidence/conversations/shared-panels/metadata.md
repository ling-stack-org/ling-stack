# P5.2 Shared Conversation Panels Evidence

## Capture Context

- Date: `2026-07-19`
- Branch: `codex/ui2-desktop-coverage-foundation`
- Base HEAD: `0a0b8050`
- Working tree: dirty integrated Desktop/Computer Use and UI 2.0 workspace; no cleanup, reset, stash mutation,
  commit, push or branch switch
- Served artifact: Playwright-managed real Vite development server at `http://127.0.0.1:4174`, not `dist`
- Browser: Playwright Chromium on macOS 26.5.2 arm64
- Data source: deterministic `mockDaemon` with one channel, one AI teammate and one ready chat provider
- Locale: `en-US`

Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web exec playwright test \
  e2e/ui2-conversation-panels.spec.ts
```

## Scope

P5.2 establishes shared interaction and motion ownership for the three conversation surfaces:

- shared `useConversationPanelPresence` owns `240ms` enter, `180ms` exit, delayed unmount and rapid reversal;
- shared `useConversationRightDockController` owns layout animation, resize, pointer capture and width clamp;
- shared `useConversationBottomPanelResizeController` owns Terminal height resize and clamp;
- Channel compatibility hooks delegate to the shared controllers instead of retaining a second animation model;
- normal conversation and AI teammate Summary keep one Radix Popover node while the Dock opens/closes;
- Channel Summary remains mounted and moves with the same layout variables;
- Terminal exit keeps the node mounted through the visual transition;
- drag suspends transition, and reduced motion removes spatial transition without changing lifecycle semantics.

This slice does not claim complete Header, Feed, Composer or Right Dock page-content migration. Dock function IDs
remain `implemented` until their Review/Evidence/Files/Context reachable states are verified in P6.

## Verified Behavior

- Summary and Details are independent; opening or closing Details produces no hidden Summary animation frame;
- Summary moves to the left of the Dock and remains separated by at least `4px`;
- screenshot capture waits for real Dock content width of at least `300px`, not only `motionState=open`;
- open uses `240ms`, close uses `180ms`, and rapid reversal resumes from the current layout width;
- Dock resize continues after the pointer leaves the handle and clamps to the shared min/max boundary;
- Terminal resize suspends transition and clamps to half the conversation height;
- Esc closes Summary without closing the open Dock;
- `prefers-reduced-motion: reduce` resolves spatial transitions to `0s`;
- all three surfaces render Summary+Dock and Bottom Terminal in `1440x960` Light and `1280x800` Dark;
- no document overflow or new browser console/page error was observed.

## Automated Evidence

- Web typecheck: passed.
- `ui2-conversation-panels.spec.ts`: `6/6`.
- App/Channel/Teammate/Dark/Toolbar regression: `148/148`, with the pre-existing
  `phase 1 parallel multi-agent active transcript shows latest action per agent without drawer surfaces`
  baseline explicitly excluded and left unchanged for P6A.
- `ui2-shell-overlay-size.spec.ts`: `3/3` after restoring the verified 240px Sidebar width at 1280px.
- Web i18n, UI 2.0 lint/import/overlay budgets and `git diff --check`: passed.

## CSS And Module Ownership

- New focused owner: `apps/web/src/styles/conversation-panels.css` (`86` lines).
- Shared controllers: `useConversationPanelPresence.ts` (`84` lines),
  `useConversationRightDockController.ts` (`313` lines) and
  `useConversationBottomPanelResizeController.ts` (`130` lines).
- Channel/Workspace resize hooks are compatibility wrappers only.
- Deleted legacy Summary layout decision, duplicate FLIP/global Esc path and obsolete panel selectors.
- No API, contract, database, route, `ViewId`, permission or conversation state-machine change.

## Screenshots

| File | Surface and state | SHA-256 |
|---|---|---|
| `1440x960-ling-light-channel-summary-dock.png` | Light Channel Summary + Dock | `ebc3f510928b2f1e6ce7cc5960eaf016d40d9e90d05647df49d27e19a1454b1a` |
| `1440x960-ling-light-channel-terminal.png` | Light Channel Bottom Terminal | `84cca1ddf1d57298158b1a87f9bcdb2a2b0f1f5984862ac02b60961bd97879a6` |
| `1440x960-ling-light-normal-summary-dock.png` | Light Normal Summary + Dock | `8532b839608af6a7eb1b4d9da6efb3d21187de15e66243e0e9351dd532bb2289` |
| `1440x960-ling-light-normal-terminal.png` | Light Normal Bottom Terminal | `8878a09f35a89bc067369f16db81d1d88be2132a1cbfb6c8bc2fbd7b3bca1f62` |
| `1440x960-ling-light-teammate-summary-dock.png` | Light Teammate Summary + Dock | `e4ca2320cd6c9e87c0d014171e5a04dc74daf1f5b53419733ab9b6d17283603a` |
| `1440x960-ling-light-teammate-terminal.png` | Light Teammate Bottom Terminal | `19b4d5549264e8c388b135baf53e8485671524f203c5e4257a490f1d000f2ac1` |
| `1280x800-ling-dark-channel-summary-dock.png` | Dark Channel Summary + Dock | `d9f4bd224f926cf33593d0df7f775bdfbb13a97f1f32e05e93f98e51fcaeff5f` |
| `1280x800-ling-dark-channel-terminal.png` | Dark Channel Bottom Terminal | `b3067d497486222bb970f1643f79afcf2a8473eb430a4c4ee566330cc64e29d8` |
| `1280x800-ling-dark-normal-summary-dock.png` | Dark Normal Summary + Dock | `830660cef581799c7fb8d04c7aa7556f06d3ddd11d2daa66010fa6784373a50f` |
| `1280x800-ling-dark-normal-terminal.png` | Dark Normal Bottom Terminal | `441e14ef2a5ce3e4960e5c2f2c77dd010534fcf14c786638871ae7d91e891419` |
| `1280x800-ling-dark-teammate-summary-dock.png` | Dark Teammate Summary + Dock | `470ee71e43e648bebda2326cf5f0b1ba0ea2fc6e9a9f1f2d1d2d29c896805d59` |
| `1280x800-ling-dark-teammate-terminal.png` | Dark Teammate Bottom Terminal | `fcae67423559b6e1a26d31040ab46d44f929a3af4fa687bd314af6813a252c8a` |

All 12 PNG files were inspected at original resolution. The first evidence run exposed two insufficient assertions:
Terminal text inside the Dock could satisfy a broad locator, and `motionState=open` could occur before the JS layout
animation reached usable width. The final evidence uses `.workspace-terminal-panel`, `data-bottom-panel-motion=open`
and a real Dock width threshold, then recaptures every image.

## Status Decision

- P5.2 shared Summary/Dock/Terminal motion: `verified`.
- `CHANNEL-SUMMARY-001`, `CHANNEL-TERMINAL-001`, `CONV-NORMAL-SUMMARY-001`,
  `CONV-NORMAL-TERMINAL-001`, `CONV-TEAMMATE-SUMMARY-001` and `CONV-TEAMMATE-TERMINAL-001`:
  `verified`.
- Three complete Dock function IDs: `implemented`; deep launcher/page states remain P6 work.
- Complete Channel/Normal/Teammate Header, Feed and Composer function IDs remain open.

## T13-O.13 Owner Recapture

- Recaptured on `2026-07-23` after the live Summary baseline moved from `components.css` into 279-line
  `styles/shared/conversation-summary.css` and the dead attention queue item family was removed.
- `ui2-conversation-panels.spec.ts` remained `6/6`; combined Summary + Runs evidence was `9/9`.
- Original-size review confirmed that all three Summary panels remain beside the open Dock, use one coherent
  Light/Dark surface, preserve the 4px separation contract and do not overlap Header, Feed or Composer.
- The twelve hashes above are the O.13 recapture. Function IDs and packaged Desktop status did not change.
