# P6B.3 Normal Conversation Dock Deep States Evidence

## Scope

- Function ID: `CONV-NORMAL-DOCK-001`.
- Surface: normal conversation Context, Review, Plans, Files, Activity, Browser and Terminal Dock pages.
- Branch: `codex/ui2-desktop-coverage-foundation`.
- HEAD while captured: `0a0b8050` with a dirty mixed Desktop/UI2 working tree.
- Date: 2026-07-19.

## Implemented Contract

- `normal-conversation-dock-projections.ts` maps current thread, turn, run, attachment, reference, action and
  terminal-report data into Dock view data. It does not own stores, fetching or mutations.
- `NormalConversationDockPages` owns normal-conversation page composition. `NormalConversationWorkspacePanels`
  owns Right Dock, resize handle and Bottom Terminal composition. `NormalConversationPage` owns the page shell.
- Context uses current thread, messages, latest run and available workspace context. Activity uses real turns and
  execution actions. Browser and Terminal evidence comes from existing terminal reports and command evidence.
- Review keeps the existing workspace-change request and error path. Plans reuse the existing thread plan-history
  source and do not expose the Channel-only scope selector. Files merge attachments, references, report artifacts
  and workspace changes without inventing unavailable files.
- Launcher, Back, Close and deep-detail navigation remain package-owned. Normal conversation does not expose
  Channel members, governance, New task or other Channel-only capabilities.
- Summary, Right Dock and Bottom Terminal remain independent shared states. Dock resize keeps pointer capture,
  clamps width and produces no document-level horizontal overflow.
- `ConversationHome.tsx` is reduced from 998 to 800 lines. Domain callbacks, stores, terminal session and controller
  wiring remain in the feature adapter. `WorkspaceRightDock.tsx` remains below the 800-line production limit.
- No API, database, route, permission, run state-machine or information-architecture change was required.

## Automated Evidence

- `git diff --check`: passed.
- `corepack pnpm --filter @ling-stack/web check:i18n`: passed (`en-US=3165`, `zh-CN=4871`).
- `corepack pnpm --filter @ling-stack/web lint`: passed; direct Feature package imports remain `0`, legacy z-index
  budget is `91/97`, and high literal z-index budget is `24/25`.
- `corepack pnpm --filter @ling-stack/web typecheck`: passed.
- `@ling-stack/conversation-ui-react`: `10/10`.
- `ui2-normal-conversation-dock.spec.ts`: `3/3`.
- Final App, Workspace, Channel Dock, Normal Header/Feed/Dock, Toolbar, Panels, Composer token, Dark mode and
  Desktop bridge selected regression: `81/81`.

The focused spec reaches every launcher through real buttons, opens representative detail pages, verifies the
Channel-only controls are absent, and covers loaded, empty, error, loading, Back, Close and horizontal resize states.
It also asserts no runtime console errors and no document-level horizontal overflow.

## Runtime And Fixtures

- Served artifact: source through the Playwright-managed real Vite dev server.
- URL: `http://127.0.0.1:4174/`.
- Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- ui2-normal-conversation-dock.spec.ts
```

- Locale: `en-US`.
- Mock daemon fixtures: one fully populated normal conversation and one sparse conversation, deterministic workspace
  review success/failure, thread plan loaded/loading/failure, attachments, execution actions and terminal reports.
- The screenshots use mocked product data rendered by the real Web React/CSS path. They do not prove a real daemon,
  provider connection or packaged Desktop host flow.

## Screenshots

| File | Theme / viewport | SHA-256 | Original-size inspection |
|---|---|---|---|
| `1440x960-ling-light-normal-dock-launcher.png` | `ling-light`, 1440x960 | `afd0c2633c878c54119331a446098582ae2423c9f7344dfe3bd3ae2a373dfe67` | All seven normal-conversation launchers are visible at stable width; Channel-only members, governance and task controls are absent. |
| `1440x960-ling-light-normal-dock-review.png` | `ling-light`, 1440x960 | `e893c080f7e5b2997ecf6ff32dfa70b618062704ddc889a623c0c12076e93ffb` | Workspace review files and diff-oriented content remain inside the Dock scroll owner. |
| `1440x960-ling-light-normal-dock-deep-states.png` | `ling-light`, 1440x960 | `2d5945e8602f53cac3383ef448e20c9b0b68ee85df30e5374a1245e5b8218454` | Context, plan detail, file detail, browser source and activity data are reachable and legible without compressed text. |
| `1280x800-ling-dark-normal-dock-empty-error-resized.png` | `ling-dark`, 1280x800 | `11cab727645c970d93d78c8aff625008e6c13b177676fb00c47b353f3b6616f2` | Review failure, empty Plans/Files/Browser states and the widened Dock remain contained after pointer resize. |

All PNG dimensions match their filenames and were inspected at original size. No overlapping controls, clipped text,
theme leakage, unreadable compressed columns or document-level overflow were found.

## CSS Ownership Proof

- `normal-conversation.css`: `124 -> 87` lines; only Header/page geometry and compatibility remain.
- `normal-conversation-dock.css`: new focused owner, `218` lines.
- `styles.css`: one import line added for the focused owner.
- `conversation-home.css`: remains `83` lines; no Dock selectors were copied into it.
- `components.css`: remains `11,388` lines; P6B.3 adds no generic or Dock visual owner there.
- Total Web CSS: `62 files / 45,820 lines -> 63 files / 46,002 lines`.
- The focused file contains zero color literals, `!important`, Theme Pack ID selectors and `transition: all`.

## Completion And Next Slice

`CONV-NORMAL-DOCK-001` satisfies the UI 2.0 `verified` gate. P6B Normal Conversation is closed across Header,
Search, Summary, Terminal, Feed, Composer and Dock. The next product slice is `P6C AI Teammate Private Chat`;
Channel and Normal Conversation remain comparison baselines and must not be redesigned during that migration.
