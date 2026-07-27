# P6B.2 Normal Conversation Feed And Composer Evidence

## Scope

- Function IDs: `CONV-NORMAL-FEED-001`, `CONV-NORMAL-COMPOSER-001`.
- Surface: normal conversation history, active run states and Composer controls.
- Branch: `codex/ui2-desktop-coverage-foundation`.
- HEAD while captured: `0a0b8050` with a dirty mixed Desktop/UI2 working tree.
- Date: 2026-07-19.

## Implemented Contract

- `NormalConversationFeed` owns the history, message rows, attachments, queued/running/failed states,
  replacement retry and Jump to latest behavior. The feed element is the only vertical scroll owner.
- `NormalConversationComposer` owns draft, attachment upload, permission, model, thinking, sending and stopping
  presentation. It reuses the existing send, replacement and run-cancel domain callbacks.
- Feed and Composer use the Channel conversation-width baseline and remain aligned while the input is focused,
  menus are open or the feed is scrolled.
- Model and thinking selection now use the shared Radix `Menu` radio contract. The previous hand-written listbox,
  document-level outside click and Escape ownership were removed.
- Persistent generation failure uses one danger `InlineFeedback`; short success/info feedback is not written into
  history. A failed replacement preserves its original idempotency key.
- `ConversationHome.tsx` is reduced from 1,598 to 998 lines. Feed, Composer, view-model, option and shared type
  responsibilities are split into focused files; Dock projections and page-shell wiring remain for P6B.3.
- No API, database, route, permission, run state-machine or terminal behavior changed.

## Automated Evidence

- `git diff --check`: passed.
- `corepack pnpm --filter @ling-stack/web check:i18n`: passed (`en-US=3143`, `zh-CN=4850`).
- `corepack pnpm --filter @ling-stack/web lint`: passed; direct Feature package imports remain `0`, legacy
  z-index budget is `91/97`, high literal z-index budget is `24/25`.
- `corepack pnpm --filter @ling-stack/web typecheck`: passed.
- `@ling-stack/conversation-ui-react`: `10/10`.
- `ui2-normal-conversation-feed-composer.spec.ts`: `4/4`, including the final evidence capture run.
- App, Workspace, Composer token, Normal Header/Search, Feed/Composer, Toolbar, Panels, Dark mode and Desktop
  bridge selected regression: `71/71`.

## Runtime And Fixtures

- Served artifact: source through the Playwright-managed real Vite dev server.
- URL: `http://127.0.0.1:4174/`.
- Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- ui2-normal-conversation-feed-composer.spec.ts
```

- Locale: `en-US`.
- Mock daemon fixture: 20 user/assistant turns, one interrupted replacement, queued and running turns, one
  provider timeout, attachment metadata, two providers, thinking modes, delayed send and a cancellable active run.
- The screenshots use mocked product data rendered by the real Web app; they do not prove a real daemon or
  packaged Desktop host flow.

## Screenshots

| File | Theme / viewport | SHA-256 | Original-size inspection |
|---|---|---|---|
| `1440x960-ling-light-normal-feed-active-states.png` | `ling-light`, 1440x960 | `1b52337d456794c0678f0e33d8857e0499581df70539ac9ec6d7aaebff4c92f4` | Feed and Composer share one stable column; queued, running, failure and retry are readable without duplicate status surfaces or document overflow. |
| `1280x800-ling-dark-normal-feed-active-states.png` | `ling-dark`, 1280x800 | `079bb25b0427fe7c2d315689100087904fc5bb53f83b8e941e45234eef4e3c32` | Composer uses the semantic dark surface rather than the legacy pure-black contenteditable override; the single failure owner remains contained at the narrow viewport. |
| `1440x960-ling-light-normal-composer-model-menu.png` | `ling-light`, 1440x960 | `2732fcdcd671892ba207e260da50dba132e1bb69c49daa689db4c26d651d549f` | The Radix model Menu is anchored above the trigger; its focused search Input stays inside the Menu and the draft remains visible and unchanged. |

All PNG files were inspected at their original dimensions. The tests also assert no runtime errors and no
document-level horizontal overflow.

## Remaining Normal Conversation Work

- P6B.3 closes deep `CONV-NORMAL-DOCK-001` launcher/page states: Context, Review, Plans, Files, Activity,
  Browser and Terminal, including detail, loading, empty, error, Back, Close, long content and resize.
- `ConversationHome.tsx` remains 998 lines and therefore still exceeds the 800-line production target. P6B.3
  must extract Dock projections and page-shell/side-panel wiring before adding deep-state behavior.
- P6B.1 Header/Search and P6B.2 Feed/Composer are regression baselines. P6B.3 must not redesign either surface.
