# Shared Conversation Composer Ownership Evidence

## Scope And Status

- Recorded: `2026-07-24`, Asia/Shanghai.
- Branch / baseline HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Source: real Vite application through Playwright Chromium and daemon fixtures.
- Themes/viewports: `ling-light`, `ling-dark`, imported `Quiet Ocean`; `1440x960` and `1280x800`.
- Status: `T13-O.31 Shared Conversation Composer Slot Ownership` is Web verified. Function IDs and packaged Desktop status are unchanged.

## Ownership Boundary

- `@ling-stack/conversation-ui-react` owns the canonical `.conversation-composer*` shell, input zone, toolbar and native input focus contract.
- The package no longer emits `composer-panel`, `composer-drop-zone`, `composer-primary-actions` or `composer-tool-row` compatibility classes.
- `conversation-composer-slots.css` is the single Web owner for pending assets, preview cards, mention/slash pickers, drop hints, shared attachment controls and file-reference tokens.
- Channel, Normal Conversation and AI Teammate focused CSS now select the canonical root through `data-conversation-composer` and `data-surface`; they only own surface geometry and real adapters.
- Generic strict/Dark rules exclude the canonical Composer root and subtree. Native input border, outline and shadow are cleared; the focus ring is inset and does not change shell geometry.
- The zero-consumer Web `MessageComposer` and `ComposerMentionToken` components and barrel exports were deleted. `ComposerFileReferenceToken` and live Activity/inspect/attachment branches remain.
- Send, upload, draft, mention/slash parsing, permissions, models, thinking, controllers, API, contracts, routes, i18n, Logo and Desktop behavior were not changed.

## Verification

| Gate | Result |
|---|---|
| Conversation package tests | `20/20` passed |
| Focused spec, ordinary | `4/4` passed |
| Focused spec, formal capture | `4/4` passed |
| Existing Composer/Token/Form focused regression | `18/18` passed |
| Broad App/Channel/Teammates/Workspace/Dark/Theme | initial `162/165`; three stale legacy-class locators updated, exact rerun `3/3` passed |
| Web lint, i18n and typecheck | passed |
| Web production build | passed; existing large-chunk warning only |
| Selector ownership, source order and forbidden-pattern scans | passed |
| `git diff --check` and 201-document link audit | passed |

The focused spec verifies canonical source ownership, legacy selector absence, strict blanket exclusion, Channel mention
and pending attachment, Normal slash and permission controls, Teammate attachment state, long unbroken text,
Light/Dark/imported Theme tokens, reduced motion, console errors, page errors and region/document overflow. It measures
focus before and after: native input border/outline/shadow remain zero, input-zone and shell heights do not change, and
the native control remains within the Composer shell.

The broad run exposed three tests that still queried removed compatibility classes. Two Channel drag/drop locators now
target the canonical Channel input zone, and the Dark surface locator now targets the canonical Channel Composer root.
Production compatibility classes were not restored. All three exact scenarios then passed.

## CSS Accounting

| Owner | Before | After |
|---|---:|---:|
| Web CSS total | 160 files / 34,015 lines | 161 files / 33,864 lines |
| `components.css` | 2,856 | 2,202 |
| `layout.css` | 531 | 494 |
| `strict-console.css` | 421 | 386 |
| shared Composer slot owner | 0 | 301 |
| Channel focused Composer | 467 | 764 |
| Normal focused Composer | 379 | 356 |
| Teammate focused Composer | 235 | 234 |

The new shared file replaces aggregate duplicates; total Web CSS decreases by 151 lines. `components.css` remains
architecture debt, but O.31 removes 654 lines from it and adds no global `input:focus`, hard-coded Theme selector,
`transition: all`, `!important` or literal status color.

## Original-Size Screenshot Ledger

| Evidence | Viewport/theme | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-channel-mention-pending-focus.png` | 1440x960 / Ling Light | Channel mention/pending attachment and long focused input | `1667f85b050513b75109c4a8deabba1ba87327aef0f6a94cb5db4fa20627dbf1` |
| `1280x800-ling-dark-normal-slash-permission-focus.png` | 1280x800 / Ling Dark | Normal slash/permission controls, reduced motion and focus containment | `ce5e7a762620504a876098a875bbbdad5ef2e8b48f97d530801d6945bc7241f9` |
| `1440x960-quiet-ocean-teammate-attachment-status-focus.png` | 1440x960 / Quiet Ocean | Teammate attachment/status and imported Theme focus containment | `efb01b67a375e6f832522da5f4de1fdb763656545a2eb2c629ed4dc2590f3931` |

All three screenshots were inspected at original size. Focus rings remain inside the Composer border; text, preview
cards and toolbars stay within the shell without horizontal overflow or Theme repaint.

## Honest Remaining Gaps

- This closes the three conversation Composer surfaces, not every raw input in the product. The T12.1c audit still tracks 33 reachable text controls for page-by-page migration.
- Packaged Electron macOS Retina and Windows 125%/150% evidence was not produced.
- `components.css` remains above the 1,200-line architecture-debt threshold. `channel-feed-composer.css` is 764 lines and must not absorb unrelated behavior.
- Large-file debt remains in `ChannelMessageRenderers.tsx`, `channel.spec.ts`, `app.spec.ts` and `WorkspaceClientView.tsx`; O.31 only updated three stale test locators in the large specs and added no business behavior.
