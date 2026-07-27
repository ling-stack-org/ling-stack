# P6C.2 AI Teammate Feed And Composer Evidence

## Scope

- Function IDs: `CONV-TEAMMATE-FEED-001`, `CONV-TEAMMATE-COMPOSER-001`.
- Surface: AI teammate private history, message states, edit/retry, Memory evidence, attachments, guidance and Composer.
- Branch: `codex/ui2-desktop-coverage-foundation`.
- HEAD while captured: `0a0b8050` with a dirty mixed Desktop/UI2 working tree.
- Date: 2026-07-19.

## Implemented Contract

- `TeammatePrivateChatFeed` is the focused owner for virtual history, message rows, attachments/references,
  structured work cells, Memory/Web evidence, edit/retry, message actions and Jump to latest. The labeled Feed is
  the only vertical scroll owner.
- `TeammatePrivateChatComposer` owns attachment/link/file previews, slash picker, permission control, sending,
  stopping and the direct-guidance queue. Running replies keep permission locked and preserve queue/promote/edit/
  cancel semantics.
- `useTeammatePrivateMessageController` owns edit/replacement/feedback local state while keeping the existing
  `editConversationMessage` API mutation in the teammate feature boundary.
- `useTeammatePrivateComposerController` owns permission confirmation, slash navigation, focus restoration and
  authorization callback projection. It does not import daemon, router or workspace stores.
- Message body, work-cell and workspace-file projection moved to `teammate-private-chat-view-models.ts`; JSX no
  longer derives provider recovery, terminal-report suppression or file targets inline.
- Feed and Composer share the Channel `800px` conversation-width baseline. Their owner wrappers preserve one
  stable grid while the right Dock or bottom Terminal is visible.
- A failed message whose body exactly repeats `errorMessage` renders one message-scoped danger
  `InlineFeedback`; persistent failure remains attached to the message and is not converted to Toast.
- `TeammatePrivateChatSurface.tsx` is reduced from 1,091 to 181 lines and now owns only conversation panel
  composition, controllers and Dock/Terminal wiring.
- No API, contract, database, route, permission, run state-machine, teammate state or IA changed.

## Automated Evidence

- `git diff --check`: passed.
- `corepack pnpm --filter @ling-stack/web check:i18n`: passed (`en-US=3165`, `zh-CN=4871`).
- `corepack pnpm --filter @ling-stack/web lint`: passed; direct Feature package imports remain `0`, legacy
  z-index budget is `91/97`, and high literal z-index budget is `24/25`.
- `corepack pnpm --filter @ling-stack/web typecheck`: passed.
- `@ling-stack/conversation-ui-react`: `10/10`.
- `ui2-teammate-conversation-feed-composer.spec.ts`: `4/4`, including the final evidence capture run.
- Teammates, P6C.1 Header, Composer token, Toolbar, Panels, P6B.2 Feed/Composer, Dark mode and Desktop bridge
  selected regression: `64/64`.

The focused spec covers virtual history, pending/failed/cancelled states, one failure owner, attachment and
Memory evidence, replacement retry idempotency, Jump to latest, unique scroll ownership, Channel-width alignment,
permission Menu, slash selection, upload, send, active guidance, stop, console and document overflow.

## Runtime And Fixtures

- Served artifact: source through the Playwright-managed real Vite dev server.
- URL: `http://127.0.0.1:4174/`.
- Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- ui2-teammate-conversation-feed-composer.spec.ts
```

- Locale: `en-US`.
- Mock daemon fixtures: 32-message virtual history, pending/failed/cancelled replies, pending replacement,
  document attachment, Memory recall, ready image-capable provider, slash skill and active direct-reply work unit.
- Screenshots use mocked product data rendered by the real Web React/CSS path. They do not prove a real provider,
  daemon persistence or packaged Desktop host flow.

## Screenshots

| File | Theme / viewport | SHA-256 | Original-size inspection |
|---|---|---|---|
| `1440x960-ling-light-teammate-feed-states.png` | `ling-light`, 1440x960 | `892fe80bb4bd1612d09f5d01754bf1a3eee5cab9f96817e86466e41e835b90b1` | Failed, cancelled, replacement retry and expanded Memory evidence remain in one scannable 800px column; failure copy has one owner and Composer stays aligned. |
| `1280x800-ling-dark-teammate-feed-states.png` | `ling-dark`, 1280x800 | `af8a2bb58eac4bc15b44d4c3e5352b26a02d2058faffe88e16bdafd6c102fa8d` | The same changed states stay inside the narrow viewport with semantic dark surfaces, readable attachment/Memory rows and no document overflow. |
| `1440x960-ling-light-teammate-composer-permission-menu.png` | `ling-light`, 1440x960 | `e98fa7dd215df4f4a31e235d46d64a484d7511b377277519e79065be45847594` | Shared Radix permission Menu anchors above the trigger; the draft surface and Header remain stable. |
| `1440x960-ling-light-teammate-composer-attachment.png` | `ling-light`, 1440x960 | `7d2b7c6d1f7a586ad2b78472bee902c87341243045698f0d1b0cea57adca1c55` | Image preview, selected slash token, Read-only permission and send action remain contained without changing the conversation column. |
| `1280x800-ling-dark-teammate-guidance-active.png` | `ling-dark`, 1280x800 | `89f29f064278e28bb947c9f17c68ed9337b86d9346b02efd87b675679c0622ec` | Queued guidance with attachment, locked permission and Stop action fit between Feed and Composer without overlap or theme leakage. |

All PNG dimensions match their filenames and were inspected at original size. The tests also assert no runtime
errors and no document-level horizontal overflow.

## CSS Ownership Proof

- `teammates.css`: `5,032 -> 4,800` lines; private root/Feed/Composer/message attachment selector families were
  deleted rather than copied.
- `teammate-private-feed-composer.css`: new focused owner, `208` lines.
- `strict-console.css`: `1,413 -> 1,411` lines; private root and Composer repaint ownership was removed.
- Total Web CSS: `64 files / 45,934 lines -> 65 files / 45,909 lines`.
- Focused CSS contains zero color literals, `!important`, Theme Pack/Profile selectors, `transition: all` or
  private panel keyframes.

## Remaining P6C Work

- P6C.3 closes `CONV-TEAMMATE-CONTEXT-001` and deep `CONV-TEAMMATE-DOCK-001` states: real Context, Review,
  Evidence, Files, Activity, Browser and Terminal pages, including loading/empty/error/detail/Back/Close/resize.
- `TeammateWorkspace.tsx` remains 2,502 lines and is architecture debt. P6C.3 must extract private Dock/page-shell
  projection or adapter boundaries before adding deep behavior.
- P6C.1 Header/Search and P6C.2 Feed/Composer are regression baselines. P6C.3 may only apply regression fixes to
  them and must not move Channel-only members, governance or task controls into private chat.
