# T13-P.3-L Proposed Plan Formal Evidence

## Scope

- Function ID remains `CHANNEL-FEED-001`; this evidence slice does not add or rename a product function.
- Slice: `T13-P.3-L`, formal evidence for the T13-P.3-F Proposed Plan focused owner.
- Branch: `codex/ui2-desktop-coverage-foundation`.
- HEAD while captured: `0a0b8050`, with the existing dirty shared UI 2.0 working tree preserved.
- Capture date: 2026-07-24.
- Production, API, contracts, domain, state machine and locale files were not changed by this evidence slice.

## Reproduction

The screenshots were captured from the real Web app served by the Playwright-managed Vite server on port `4283`.
The focused fixture uses the existing E2E daemon adapter and the existing Proposed Plan action handlers.

```bash
LING_PLAYWRIGHT_PORT=4283 LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- ui2-channel-proposed-plan.spec.ts
```

Result: `3/3` Chromium tests passed in 6.1 seconds on the final capture run.

## Automated Assertions

- Every capture is preceded by containment checks for all five Proposed Plan cards, their bodies and action groups.
- Action groups have no horizontal scroll overflow; every body and action group remains inside its card bounds.
- The Channel feed and document have no horizontal scroll overflow beyond the one-pixel geometry tolerance.
- The runtime collector reported zero unexpected browser console errors and zero page errors at every capture point.
  The deliberate mocked HTTP 500 in the action-failure scenario is treated as fixture network output, not a product
  console regression.
- Light verifies long-title ellipsis, long path/code containment, four shared actions, minimum action height and a
  visible keyboard focus outline.
- Dark verifies the real display states `Draft`, `Saved`, `Accepted`, `Superseded` and `Archived`. During Save, all
  four actions are disabled, expose `aria-busy="true"` and use the shared Spinner.
- Reduced motion verifies zero-duration action transition, the shared reduced-motion Spinner contract, persistent
  action failure feedback, a re-enabled Save action, and no fabricated `Rejected` or `Failed` Plan status.

## Screenshots

| File | Theme / viewport | Bytes | SHA-256 | Visual inspection |
|---|---|---:|---|---|
| `1440x960-ling-light-proposed-plan-long-four-actions-focus.png` | `ling-light`, 1440x960 | 111987 | `838152aa40f48770f94d9ad7a69fd526ce18ba271a5b0798ec471f57ce3e81c6` | Long title truncates without widening the card; long path/code remains clipped inside the body; four actions wrap safely and Save has a clear focus ring. |
| `1280x800-ling-dark-proposed-plan-five-states-busy.png` | `ling-dark`, 1280x800 | 95561 | `e7acfa472bfe9521462d6314828982197ded6e047126cbc8fba852d9b6ebe593` | Draft and Saved are visible at the busy capture position; all four Draft actions show disabled shared loading treatment without shifting or crossing the card edge. |
| `1280x800-ling-dark-proposed-plan-accepted-superseded.png` | `ling-dark`, 1280x800 | 102723 | `97ba4b33ce50d2d870de75a1c2349b9b56598f1294ba723362359c3187b4d494` | Accepted and Superseded labels are visible and use the same compact card grammar; actions remain aligned and contained. |
| `1280x800-ling-dark-proposed-plan-superseded-archived.png` | `ling-dark`, 1280x800 | 106558 | `4bcc149ff51b22b1ec4cff9a05ba27b0da9a1dafdcdeba43d7e1d8d4d31a9fec` | Superseded and Archived labels are visible after bounded feed scrolling; neither card nor its actions produce horizontal overflow. |
| `1280x800-ling-dark-reduced-motion-proposed-plan-action-failure.png` | `ling-dark`, 1280x800, reduced motion | 96746 | `11ada4a4bf60ffdedd9c576640390e2c85140b1f49db22fb9b139b76843ad96d` | The failed Save returns the card to enabled actions and shows persistent failure feedback in the Composer; the card remains stable with no rejected/failed state fabrication. |

All PNG files are non-empty and were inspected at their original dimensions. Screenshot capture disables CSS
animations only while rasterizing; the reduced-motion behavior is asserted before capture. These images prove the
mocked Web product surface in Chromium, not a real daemon, provider, Electron host, Windows DPI or native Desktop
surface.
