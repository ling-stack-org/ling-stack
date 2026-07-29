# P4.3 Sidebar Section Disclosure Evidence

## Capture Context

- Date: `2026-07-19`
- Branch: `codex/ui2-desktop-coverage-foundation`
- Base HEAD: `0a0b8050`
- Working tree: dirty; Desktop/Computer Use and UI 2.0 work remain intentionally preserved together
- Served artifact: Playwright-managed real Vite development server at `http://127.0.0.1:4174`, not `dist`
- Browser: Playwright Chromium
- Data source: deterministic `mockDaemon` fixture with delayed channel/teammate reads and unhealthy daemon states
- Locale: `en-US`

Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm exec playwright test \
  e2e/ui2-sidebar-sections.spec.ts
```

## Screenshots

| File | Viewport | Theme Pack | State |
|---|---|---|---|
| `1440x960-ling-light-loading.png` | `1440x960` | `ling-light` | Delayed channel and teammate reads, stable Spinner and Skeleton geometry |
| `1280x800-ling-dark-stale-collapsed.png` | `1280x800` | `ling-dark` | Reduced motion, unhealthy daemon, stale indicators and collapsed Channels section |

SHA-256:

```text
45dd2852089c002fbbe3a968c3856f2fedc2068268289b0550d2ae4bbb8d95eb  1280x800-ling-dark-stale-collapsed.png
8739d44e8b8cd7866a009876a673f157fbc162f6e5e861bd8eecc75cc58edb55  1440x960-ling-light-loading.png
```

## Verified Behavior

- Section headers use shared Button and Radix Collapsible without owning channel, teammate or archive callbacks.
- Loading uses shared Spinner and Skeleton; stale and unread states use compact StatusIndicator; counts use Badge.
- Loading completion does not change Sidebar width or create horizontal overflow.
- Keyboard Enter collapses and expands a section; rapid reversal resolves to the last requested state.
- Radix intentionally sets `animationName=none` during initial height measurement. The test verifies this mount contract,
  then verifies user-triggered reversal restores `ling-ui-collapsible-open` with `0.18s` duration.
- Reduced motion computes `animation-duration: 0s` and preserves the final expanded/collapsed state.
- Legacy unread/mention hard-coded green and obsolete rail item keyframes are no longer the state owner.
- Browser console errors and page errors: `0` unexpected.
- Both screenshots were inspected at original resolution; no overlap, horizontal overflow, theme leakage or layout jump was found.

## Automated Evidence

- `@ling-stack/ui-react`: `38/38` tests passed.
- Focused section browser spec: `2/2` passed.
- Section plus object-row browser specs: `4/4` passed.
- App Sidebar selection/disclosure/archive: `3/3` passed.
- Channel compact rail/header/unread: `3/3` passed.
- Channel archive and teammate menu regressions: `3/3` passed.
- Dark Mode target: `1/1` passed.
- Final selected browser regression: `14/14` passed.
- Web i18n、UI 2.0 import/facade lint、typecheck、`git diff --check` and 99-document link audit passed.

## Remaining Scope

- This verifies `SIDEBAR-SECTION-001`; it does not close all behavior in the channel, teammate and recent lists.
- `SIDEBAR-CHANNEL-001`, `SIDEBAR-TEAMMATE-001` and `SIDEBAR-RECENT-001` still need a separate state-by-state
  audit for running/busy projection, empty and long lists, archive transitions and remaining legacy CSS ownership.
- First Run has no confirmed production trigger and remains `inventory`.
- Chromium Web evidence does not replace Windows DPI/high-contrast or signed Desktop package evidence.
