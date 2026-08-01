# P6C.1 AI Teammate Private Chat Header And Search Evidence

## Scope

- Function IDs: `CONV-TEAMMATE-HEADER-001`, `CONV-TEAMMATE-SEARCH-001`.
- Surface: AI teammate identity, Search, Refresh, Summary, Terminal, Details and Desktop capability slot.
- Branch: `codex/ui2-desktop-coverage-foundation`.
- HEAD while captured: `0a0b8050` with a dirty mixed Desktop/UI2 working tree.
- Date: 2026-07-24 (focus-caret follow-up recapture).

## Implemented Contract

- Channel, Normal Conversation and AI teammate chat now share one generic `useConversationHeaderController` for
  Search open/focus/Clear/Escape/identity reset and action-scoped Refresh. The Normal hook remains a compatibility
  alias rather than a second implementation.
- `TeammateChatHeader` reuses `ConversationHeaderSearch`, shared Input/IconButton and the existing Toolbar/Summary
  primitives. It exposes a stable `data-ui2-teammate-chat-header` semantic boundary.
- The compact Search keeps a `32px` shell with `20px` native line-height, preventing the focused caret from
  visually touching the top and bottom borders.
- The Header remains 48px with teammate avatar/name on the left and
  `Search / Refresh / Summary / Terminal / Details` in a stable icon-only action group. Long teammate identity and
  the current-session Desktop capability do not overlap the toolbar.
- Search covers message body, AI reply, attachment filename, workspace file reference, link-preview metadata,
  associated run title/provider and existing web evidence. Clear preserves input focus; Escape closes, clears and
  restores focus to Search; changing teammate closes and clears Search.
- Refresh keeps the message surface mounted and only marks the Refresh action busy. Initial workspace loading keeps
  its existing full-surface behavior.
- Header/Search/Summary CSS moved from `teammates.css` into `teammate-private-header.css`. The focused owner uses
  semantic Theme Pack tokens and has no second Search grid or private control visual implementation.
- No API, database, route, permission, teammate state-machine or information-architecture change was required.

## Automated Evidence

- `git diff --check`: passed.
- `corepack pnpm --filter @ling-stack/web check:i18n`: passed (`en-US=3165`, `zh-CN=4871`).
- `corepack pnpm --filter @ling-stack/web lint`: passed; direct Feature package imports remain `0`, legacy z-index
  budget is `91/97`, and high literal z-index budget is `24/25`.
- `corepack pnpm --filter @ling-stack/web typecheck`: passed.
- `ui2-teammate-conversation-header.spec.ts`: `2/2`.
- Teammates, Normal Header, Toolbar, Panels, Dark mode and Desktop bridge selected regression: `55/55`.

The focused spec verifies five search source classes, no-result, Clear/Escape/focus, teammate identity change,
action-scoped Refresh, 32px toolbar actions, 48px Header, Feed/Composer column alignment, Theme Pack surface,
runtime console and document overflow.

## Runtime And Fixtures

- Served artifact: source through the Playwright-managed real Vite dev server.
- URL: `http://127.0.0.1:4174/`.
- Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- ui2-teammate-conversation-header.spec.ts
```

- Locale: `en-US`.
- Mock daemon fixture: two teammates, long identity, five direct messages, document attachment, workspace file ref,
  link preview and delayed direct-message refresh.
- The screenshots use mocked product data rendered by the real Web React/CSS path. They do not prove a real daemon,
  provider connection or packaged Desktop host flow.

## Screenshots

| File | Theme / viewport | SHA-256 | Original-size inspection |
|---|---|---|---|
| `1440x960-ling-light-teammate-header-search.png` | `ling-light`, 1440x960 | `d06334ac3c8c3249d3d33061e08165da012431cfdbe72ac2f4bb9de62c723cb7` | Long teammate identity truncates cleanly; the 20px caret, clear action, toolbar and filtered result remain aligned. |
| `1280x800-ling-dark-teammate-header-search.png` | `ling-dark`, 1280x800 | `104b014e9402e70e9eba54aacbaf1f4c625c34feadde5be19c8dec0540f874ad` | Header and shared Search use semantic dark surfaces; caret, message and Composer remain contained without theme leakage. |

Both PNG dimensions match their filenames and were inspected at original size. No overlapping controls, clipped
Search input, focus overflow, hard-coded light surface or document-level horizontal overflow was found.

## CSS Ownership Proof

- `teammates.css`: `5,305 -> 5,032` lines; old Header/Search/Status/Summary selector families were deleted.
- `teammate-private-header.css`: new focused owner, `203` lines.
- `strict-console.css`: `1,412 -> 1,413` lines; one semantic Header exclusion prevents the legacy Dark blanket from
  overriding the focused Theme Pack surface.
- `styles.css`: one focused import added.
- Total Web CSS: `63 files / 46,002 lines -> 64 files / 45,934 lines`.
- The focused file contains zero color literals, `!important`, Theme Pack ID selectors and `transition: all`.

## Remaining P6C Work

- P6C.2 must extract Feed/Composer/local edit-retry state from the 1,091-line private surface while preserving
  virtualization, Memory evidence, attachment/link preview, guidance queue/interrupt/stop and permission behavior.
- P6C.3 must close Context and every reachable Dock deep state using real private-chat data.
- `TeammateWorkspace.tsx` remains 2,502 lines and `TeammatePrivateChatSurface.tsx` remains 1,091 lines. Both are still
  architecture debt; P6C.1 does not claim the private conversation module complete.

## 2026-07-31 More Menu Follow-up

- The private-chat More menu now contains `Settings / Rename teammate / Context` in that order.
- Rename uses the existing teammate PATCH with a `displayName`-only payload. A focused controller owns draft, busy,
  productized failure and stale teammate identity; a focused Dialog mirrors the verified Channel rename interaction.
- Context calls the existing explicit `openChatDockPage("context")` path. Selecting it again while the dock is already
  open keeps the Context page open instead of toggling the dock closed.
- Success updates the private-chat Header and main navigation immediately. Failure keeps the edited name and does not
  expose the daemon's raw error message.

| File | Theme / viewport | SHA-256 | Original-size inspection |
|---|---|---|---|
| `1280x800-ling-dark-teammate-more-menu.png` | `ling-dark`, 1280x800 | `a7c5a36b2590ca415097b4292fe7dcc694793bff0704e2c501e1183ab29a6ee7` | Three compact icon-and-text actions align under the teammate identity without covering the toolbar. |
| `1280x800-ling-dark-teammate-rename-dialog.png` | `ling-dark`, 1280x800 | `19279cb598090f5cfe0457b89a890b23bb1c6ebaf0486cf49d5a29ce96130918` | Shared Dialog geometry, focused name field, disabled unchanged Confirm and semantic dark surfaces remain contained. |
