# T13-P.6-D Sidebar Archive All Evidence

## Capture Context

| Field | Value |
|---|---|
| Verified | `2026-07-26` |
| Branch / base HEAD | `codex/ui2-desktop-coverage-foundation` / `0a0b80502715` |
| Served artifact | Playwright-managed Vite source at `http://127.0.0.1:4174` |
| Browser / locale | Playwright Chromium, one worker / `en-US` |
| Fixture | Light: two open conversation threads. Dark: one archivable thread plus one thread returning `409 active_thread_archive_blocked` |

Current no-capture verification command:

```bash
corepack pnpm --filter @ling-stack/web exec playwright test \
  e2e/ui2-channel-saved-view-dialog.spec.ts \
  e2e/ui2-sidebar-archive-all-dialog.spec.ts --workers=1
```

Result: `4/4` passed in `14.3s`; Sidebar Archive All itself is `2/2`.

The screenshot-producing path is gated by `LING_CAPTURE_UI2_EVIDENCE=1` in
`ui2-sidebar-archive-all-dialog.spec.ts`. Existing PNGs were hash-verified and were not overwritten during this
metadata-only closure.

## Screenshots

| File | Viewport / theme / locale | Changed state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-archive-all-dialog.png` | `1440x960`, `ling-light`, `en-US` | Archive All confirmation with two eligible conversations and Cancel focused | `925b9b98d36bd0d60a4f5698b979f4e90b5e7fe585682f70043765522a4f1cf8` |
| `1440x960-ling-light-archive-all-complete.png` | `1440x960`, `ling-light`, `en-US` | Both conversations archived; Recent list is empty and focus is restored to section actions | `6356ac8e23637a9bf4863ab78beb386dd878b2f33449f6867e17f9bf82d8a383` |
| `1280x800-ling-dark-archive-all-partial-failure.png` | `1280x800`, `ling-dark`, `en-US` | One conversation archived and one blocked thread retained with persistent Sidebar failure feedback | `7c5f8f5c0d1fac4af511b5649045796ea1b0bf3f5e16dab7786e8e4233475f36` |

## Runtime And Geometry

- Light scenarios assert console errors `0` and page errors `0`.
- Dark partial failure asserts one expected `409 (Conflict)` resource message and no other console errors; page errors are `0`.
- Browser blocking dialogs: `0`.
- Dialog initial focus and focus restoration are asserted. Busy Archive All disables both footer actions and blocks Escape.
- Dark scenario emulates reduced motion. The existing spec does not contain a computed-animation assertion.
- Original-size inspection found no visible horizontal overflow, clipping or overlap. This existing spec does not contain a numerical overflow assertion, so metadata does not claim one.
