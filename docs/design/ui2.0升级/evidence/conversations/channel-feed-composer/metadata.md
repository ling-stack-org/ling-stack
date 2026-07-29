# P6A.2 Channel Feed And Composer Evidence

## Scope

- Function IDs: `CHANNEL-FEED-001`, `CHANNEL-COMPOSER-001`.
- Surface: normal Channel message feed and Composer; Task, Environment, Settings, Overlay and deep Dock pages remain open.
- Branch: `codex/ui2-desktop-coverage-foundation`.
- HEAD while captured: `0a0b8050` with a dirty mixed Desktop/UI2 working tree.
- Date: 2026-07-19.

## Implemented Contract

- Feed and Composer share the same bounded conversation column at `1440x960` and `1280x800`.
- `.message-feed` remains the only vertical scroll owner. Reading history or showing Jump to latest does not move Composer.
- Top-level activity and teammate detail streams expose distinct `primary` and `agent` semantics; the multi-agent baseline no longer mistakes detail streams for multiple primary streams.
- Composer exposes stable `data-conversation-composer`, `data-surface` and `data-density` attributes without using visual classes as the surface contract.
- The permission preset uses the shared Radix Menu radio contract with Portal, keyboard operation, Escape and trigger focus restoration.
- Composer focus does not change its external width or height. Tokenized input, permission controls and shell visuals are package-owned.
- Persistent send failure stays inside Composer, preserves the draft and offers Retry/Dismiss. Ephemeral success clears automatically and is not added to Feed or duplicated as a page-level error.
- Loading/error chrome and Jump to latest use shared Spinner, InlineFeedback and IconButton primitives.

## Automated Evidence

- `@ling-stack/ui-react`: `40/40` package tests.
- `@ling-stack/conversation-ui-react`: `10/10` package tests.
- `ui2-channel-feed-composer.spec.ts`: `3/3`.
- Targeted active-transcript baseline: `1/1`.
- App/Composer/Dark/Toolbar/Panel regression: `32/32`.
- Full `channel.spec.ts`: `105/105`.
- Full `teammates.spec.ts`: `21/21`.
- Web typecheck, i18n, UI2 lint guards and `git diff --check`: passed.

The focused spec verifies column geometry, document overflow, focus stability, independent Feed scrolling,
Jump to latest, shared permission Menu radio items, Escape/focus restoration, failed-draft retention, Retry,
ephemeral success cleanup and runtime console errors.

## Runtime And Fixtures

- Served artifact: source through the Playwright-managed real Vite dev server.
- URL: `http://127.0.0.1:4174/`.
- Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- ui2-channel-feed-composer.spec.ts
```

- Locale: `en-US`.
- Mock daemon fixture: checked/default chat provider, 32 Channel messages, no unrelated task/run/approval blocker.
- Failure fixture: the first send fails, retains the draft and succeeds through Retry.
- No backend API, contract, database, route, permission policy or state-machine change was required.

## Screenshots

| File | Theme / viewport | SHA-256 | Inspection |
|---|---|---|---|
| `1440x960-ling-light-channel-feed-composer.png` | `ling-light`, 1440x960 | `479524d964fe7bebc28d41d6b4d5f98f2e1bfd717a1d1df786194619846769c9` | Feed and Composer boundaries align; Composer remains fixed while history is visible; permission Menu is not clipped. |
| `1280x800-ling-dark-channel-feed-composer.png` | `ling-dark`, 1280x800 | `a9d7aab21be53992748ff5a2d3157d96b71b8c74012985f91aa112f983cdefc8` | Dense viewport remains one column with no document overflow or hard-coded light surface; Menu and controls remain readable. |
| `1440x960-ling-light-channel-composer-failure.png` | `ling-light`, 1440x960 | `946d0ac625c08d4817a04092468248170b52aaae53fe5af1417c37ba1db25298` | Failed draft remains in the input; persistent feedback and Retry/Dismiss stay inside Composer without a duplicate page error. |

All PNG files were inspected at their original dimensions. The screenshots use mocked product data rendered by
the real Web app; they are not proof of a real daemon, Desktop host or production provider connection.

## Remaining Channel Work

- `CHANNEL-TASK-001` and `CHANNEL-ENV-001` are the next slice.
- `CHANNEL-SETTINGS-001`, `CHANNEL-OVERLAY-001` and deep `CHANNEL-DOCK-001` launcher/pages remain open.
- Normal conversation and AI teammate Feed/Composer migration remain separate P6B/P6C work; this Channel evidence must not close them.
