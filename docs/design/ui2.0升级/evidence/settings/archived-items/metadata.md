# P7B.3 Archived Items Evidence

## Capture Context

| Field | Value |
|---|---|
| Captured | 2026-07-20 |
| Branch | `codex/ui2-desktop-coverage-foundation` |
| HEAD | `0a0b8050` |
| Working tree | dirty, 395 porcelain entries at capture time; Desktop/Computer Use and UI 2.0 work are intentionally preserved together |
| Server | real Vite dev server at `http://127.0.0.1:4174` |
| Server command | `corepack pnpm exec vite --host 127.0.0.1 --port 4174` through Playwright `webServer` |
| Capture command | `LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- ui2-settings-archived-items.spec.ts` |
| Browser | Playwright Chromium, one worker |
| Data | deterministic mock daemon fixture; this proves the Web product surface and real browser interactions, not a live daemon or packaged Desktop host |

## Evidence Matrix

| File | Viewport | Theme / locale | Trigger and state | Result |
|---|---|---|---|---|
| `1440x960-ling-light-conversations-loaded.png` | 1440x960 | `ling-light`, `en-US` | Settings > Archived items; 55 valid archived conversations loaded | compact Tabs/search toolbar, valid dates, one bounded scrolling list, aligned Restore/Delete actions, no document or panel horizontal overflow |
| `1440x960-ling-light-conversation-delete.png` | 1440x960 | `ling-light`, `en-US` | Delete an archived conversation | bounded shared Dialog, Cancel initial focus, complete retention consequence, fully visible destructive action, no overlay collision |
| `1280x800-ling-dark-dense-scroll.png` | 1280x800 | `ling-dark`, `en-US`, reduced motion | 55 conversations in the compact Settings shell | stable row height, internal vertical scroll, theme-safe borders and actions, no label/action wrapping or horizontal overflow |
| `1280x800-ling-dark-no-result.png` | 1280x800 | `ling-dark`, `en-US`, reduced motion | Search for a missing archived object | compact no-result EmptyState, 32px clear action, search focus does not change toolbar height |
| `1280x800-ling-dark-teammate-delete-failure-zh-CN.png` | 1280x800 | `ling-dark`, `zh-CN`, reduced motion | AI teammate hard delete returns 503 | persistent product error remains in the confirmation Dialog, raw details stay folded, actions and Chinese text remain legible |
| `1280x800-ling-dark-branch-restore-both.png` | 1280x800 | `ling-dark`, `en-US` | Select Branches where the parent channel is also archived | one `Restore both` primary recovery action, parent/branch identity remains scan-friendly, delete action stays aligned |

## Interaction And Runtime Checks

- Focus: Search stays inside its 32px shell; Cancel owns initial Dialog focus; Cancel and failure Escape return to the real delete trigger; successful delete falls back to Search after the row unmounts.
- Keyboard: category Tabs accept ArrowRight; Search Escape clears without closing Settings; busy Delete blocks Escape until the mutation settles.
- Overlay: all four permanent-delete kinds use the shared Radix-backed Dialog in the single application overlay root; no browser confirm remains.
- Busy state: only the initiating row and Dialog submit action show loading; unrelated rows do not spin.
- Feedback: initial/refresh failure preserves authoritative rows; Restore failure stays with the list; Delete failure stays in the Dialog; successful mutations use the refreshed row/count state without a duplicate Toast.
- Motion: dense, no-result and Chinese failure scenarios ran with `prefers-reduced-motion: reduce`; capture disables screenshot-time animations only.
- Console: all focused scenarios completed with no collected `console.error` or `pageerror`.
- Overflow: E2E verified document and panel horizontal containment; the 55-row scenarios verified bounded internal vertical scrolling at both target viewports.
- Visual review: all six PNGs were opened at original resolution. No invalid dates, text/control overlap, clipped action labels, off-center icon buttons, hard-coded light surface in Dark, or incoherent overlay stacking remained.

## Test Results At Capture

```text
@ling-stack/ui-react                         41/41 passed
ui2-settings-archived-items.spec.ts           5/5 passed
settings.spec.ts + channel-archive.spec.ts   19/19 passed
selected App/Dark/Settings controls          29/29 passed
Web typecheck, check:i18n, lint, diff check   passed
```

## SHA-256

```text
cfd42f4fb7192ec6c865c0f2a7ca2b968ea097f3e2bd53403a81c3f0e3771e84  1280x800-ling-dark-branch-restore-both.png
035e277dc53a9b770aba75bb1c8997554d03a715b08c1148a58325bfa082d7b8  1280x800-ling-dark-dense-scroll.png
2e63b27869099be8e1c5b7df93177afa6d6099509ce8ec6c526c126c38d1102b  1280x800-ling-dark-no-result.png
f97f89555682c7d4482cad1ecda475ff8994276d09a4af85b22f6d11a95788f3  1280x800-ling-dark-teammate-delete-failure-zh-CN.png
42fc5541fdd274ea9d16d12394fa69afbaa28cc83bb917d30d98bcca8c0626d3  1440x960-ling-light-conversation-delete.png
48701275b4d3ad4ceb20f1640dc0086d3f22c9ff174b8cc45b6dd46cfa7ee49c  1440x960-ling-light-conversations-loaded.png
```

## Scope Boundary

- This evidence preserves P14 conversation run retention, teammate private cleanup, channel/branch delete, Restore both and API guards.
- It does not add bulk actions, an All category, manual Refresh, hard delete in Sidebar, or a new Settings route.
- It does not prove a packaged macOS/Windows client or a live daemon integration; those remain release and platform gates.
