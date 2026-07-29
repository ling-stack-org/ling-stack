# UI 2.0 Dialog Foundation Evidence

## Capture

- Date: `2026-07-18`
- Branch: `codex/ui2-desktop-coverage-foundation`
- Base HEAD: `0a0b8050`
- Worktree: dirty; Desktop/Computer Use and UI 2.0 work intentionally preserved together
- Server: Playwright-managed real Vite dev server at `http://127.0.0.1:4174`
- Data: `mockDaemon` with reachable Channel create states
- Locale: `en-US`

Command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- ui2-dialog-controls.spec.ts
```

## Files

- `1440x960-ling-light-new-channel.png`
- `overlay-1440x960-ling-light-new-channel.png`
- `1280x800-ling-dark-new-channel.png`
- `overlay-1280x800-ling-dark-new-channel.png`

## Verified States

- title、description、`aria-modal`、stable accessible name；
- 32px close action、Esc、outside click、focus trap and focus restoration；
- channel mutation busy blocks Esc、outside and close action；
- body is the only vertical scroll owner after Advanced content expands；
- Light/Dark surfaces and viewport bounds；
- reduced motion removes Dialog and overlay animation；
- no horizontal overflow or page errors introduced by the Dialog slice。

The existing mock daemon does not implement optional `/control-plane/*` fallback endpoints and may emit
resource `404` entries. They predate this slice and are not treated as Dialog component errors.

## Regression

- `@ling-stack/ui-react`: `16/16`
- `ui2-dialog-controls.spec.ts`: `2/2`
- `media-jobs.spec.ts`, `media-production.spec.ts`, `teammates.spec.ts`: `34/34`
- Council and dark-mode paths passed in the broader run.
- The broad Channel run passed `101/105`; four existing non-overlay assertions remain outside P1A:
  team metrics availability、sidebar destination copy、parallel work-cell active streams and feed anchor growth.
