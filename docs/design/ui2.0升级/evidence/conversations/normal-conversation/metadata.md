# P6B.1 Normal Conversation Header And Search Evidence

## Scope

- Function IDs: `CONV-NORMAL-HEADER-001`, `CONV-NORMAL-SEARCH-001`.
- Surface: normal conversation Header and expanded Search state.
- Branch: `codex/ui2-desktop-coverage-foundation`.
- HEAD while captured: `0a0b8050` with a dirty mixed Desktop/UI2 working tree.
- Date: 2026-07-24 (focus-caret follow-up recapture).

## Implemented Contract

- The 48px Header shows the real conversation title and the fixed
  `Search / Refresh / Summary / Terminal / Details` action order.
- Header actions use the package-owned icon-only Toolbar/Button/Tooltip contract. A public
  `data-conversation-toolbar-frame` marker keeps the temporary strict-console compatibility layer from
  repainting package frames.
- Search reuses `ConversationHeaderSearch` and covers message text, attachment names and associated run titles.
- The compact Search keeps a `32px` shell with `20px` native line-height, so focused caret height retains visible
  top/bottom space instead of visually touching the shell border.
- Clear keeps Search open and focused. Escape closes and clears Search, then restores the Search trigger focus.
- Refresh uses the existing conversation refresh callback and scopes loading to its own action.
- Summary, Right Dock and Bottom Terminal remain independent. Opening Terminal no longer closes Summary.
- Desktop host geometry observes the workspace and the controlled UI 2.0 Portal root, so a portalled Summary is
  reported as canonical `popover` while composer, dock and terminal remain present.
- No API, database, route, permission, conversation state-machine or Desktop command behavior changed.

## Automated Evidence

- `corepack pnpm --filter @ling-stack/web typecheck`: passed.
- `corepack pnpm --filter @ling-stack/web check:i18n`: passed (`en-US=3143`, `zh-CN=4850`).
- `corepack pnpm --filter @ling-stack/web lint`: passed; direct Feature package imports remain `0`, legacy
  z-index budget is `92/97`, high literal z-index budget is `24/25`.
- `git diff --check`: passed.
- `@ling-stack/conversation-ui-react`: `10/10`.
- `ui2-normal-conversation.spec.ts`: `2/2`, including the evidence capture run.
- `desktop-computer-use-bridge.spec.ts` + `ui2-conversation-panels.spec.ts`: `26/26`.
- Normal/Toolbar/App/Workspace/Composer/Dark selected regression: `41/41`.

The previous Desktop bridge failure at `desktop-computer-use-bridge.spec.ts:520` reproduced at `19/20` before
the fix. It now passes at `20/20`. The regression asserts that the portalled Summary is reported before Terminal
opens and remains visible and pressed after Terminal opens.

## Runtime And Fixtures

- Served artifact: source through the Playwright-managed real Vite dev server.
- URL: `http://127.0.0.1:4174/`.
- Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- ui2-normal-conversation.spec.ts
```

- Locale: `en-US`.
- Mock daemon fixture: long persisted conversation title, searchable message body, `architecture-notes.pdf`
  attachment and associated run title.
- The screenshots use mocked product data rendered by the real Web app; they do not prove a real daemon or
  packaged Desktop host flow.

## Screenshots

| File | Theme / viewport | SHA-256 | Original-size inspection |
|---|---|---|---|
| `1440x960-ling-light-normal-header-search.png` | `ling-light`, 1440x960 | `45f91458fd4b4a080e8b51909bb82a247eb237428569a53da5e9290b253f9f32` | Search focus remains inside the 48px Header; the 20px caret keeps vertical breathing room; title truncates and actions do not move. |
| `1280x800-ling-dark-normal-header-search.png` | `ling-dark`, 1280x800 | `d943276bb0311280bda1cb08cab54749ba3a54636e34abfeff5ac14c94735313` | Search uses one active circular action; caret and text remain contained with no horizontal overflow or Light token leak. |

Both PNG files were inspected at their original dimensions. The legacy Dark Feed/Composer panels remain visibly
heavier than the Channel baseline; that is explicitly assigned to P6B.2 and was not hidden by this Header slice.

## Follow-up Status

- P6B.2 has since verified `CONV-NORMAL-FEED-001` and `CONV-NORMAL-COMPOSER-001`; see
  [P6B.2 Normal Feed And Composer](../normal-conversation-feed-composer/metadata.md).
- P6B.3 remains responsible for deep `CONV-NORMAL-DOCK-001` launcher/page states.
- `ConversationHome.tsx` is now 998 lines after the P6B.2 extraction. P6B.3 must extract Dock projections and
  page-shell wiring before adding deep-state behavior so the aggregate reaches the 800-line production target.
