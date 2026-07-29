# Conversation Package Boundary Completion Evidence

## Scope And Status

- Recorded: `2026-07-24`, Asia/Shanghai.
- Branch / baseline HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Source: real Vite application through Playwright Chromium and daemon fixtures.
- Themes/viewports: `ling-light`, `ling-dark`, imported `Quiet Ocean`; `1440x960` and `1280x800`.
- Status: `T13-O.30 Conversation Package Boundary Completion` is Web verified. It does not change Function IDs or packaged Desktop status.

## Ownership Boundary

- Eleven zero-consumer Web duplicates were deleted while their `@ling-stack/conversation-ui-react` exports remain public through the Web barrel.
- Web `MessageBubble` is now a thin adapter that injects the Web `MessageBodyRenderer`; package code owns root structure and stable message attributes.
- Channel plain-chat Reply uses the shared Radix Tooltip.
- Package `CopyActionButton` owns copied state and Radix Tooltip. The remaining Web component is a 15-line translation adapter and no longer emits `title` or `data-tooltip`.
- Message parsing, Channel projection, Composer, Dock, API, contracts, routes, i18n dictionaries, Logo and Desktop behavior were not changed.

## Verification

| Gate | Result |
|---|---|
| Conversation package tests | `18/18` passed |
| Focused spec, ordinary | `4/4` passed |
| Focused spec, formal capture | `4/4` passed |
| Selected Composer/Form/Workspace/Runtime | initial `51/52`; unrelated broad-name History locator exact rerun `1/1` passed |
| Broad App/Channel/Teammates/Workspace/Dark/Theme | `165/165` passed |
| Web lint, i18n and typecheck | passed |
| Web production build | passed; existing large-chunk warning only |
| `git diff --check`, duplicate absence and barrel export scans | passed |

The focused spec verifies deleted files and exports, package exports, stable MessageBubble root/avatar attributes,
Channel Reply hover/focus Tooltip, Code and Mermaid copied state plus Radix Tooltip, structured system/protocol/runtime
tones, imported Theme tokens, console errors, page errors and region/document overflow.

The first Dark run exposed the still-local Web Copy implementation. It was replaced with a package adapter rather
than weakening the Tooltip assertion. A second failure came from a test locator keyed to the old accessible name;
the copied button was already changing to `Copied`. The test now keeps a stable CSS locator and separately asserts
the accessible name. The final ordinary and capture suites pass `4/4`.

## Original-Size Screenshot Ledger

| Evidence | Viewport/theme | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-channel-message-boundary.png` | 1440x960 / Ling Light | Channel own/AI message roots and Reply Radix Tooltip | `0a4832aeb4a45cf5a87a0c5e58b22f0f23d220a41bbd9c23747fa3c197a3b6f3` |
| `1280x800-ling-dark-code-mermaid-copy.png` | 1280x800 / Ling Dark | Code and Mermaid rendering with copied state Tooltip | `e88e7b52e73529e7b3a97efdb475ad3773fa7746a1bfb236d7deaf3bc59b6dbd` |
| `1440x960-quiet-ocean-structured-message-boundary.png` | 1440x960 / Quiet Ocean | Structured, protocol and runtime MessageBubble semantics | `b10865f028bdee81bed3cd66eb7f0b321f1f9442738da513d2e67d2ecfd301e1` |

All screenshots were inspected at original size. Tooltips, message frames, code/diagram blocks and action rows remain
contained without document-level horizontal overflow.

## Honest Remaining Gaps

- Remaining Web conversation adapters are retained only where they inject Web renderers, i18n or domain callbacks; later deletion requires a separately audited boundary.
- No packaged Electron macOS Retina or Windows 125%/150% evidence was produced.
- Large-file debt remains in `ChannelMessageRenderers.tsx`, `channel.spec.ts`, `app.spec.ts` and `WorkspaceClientView.tsx`; O.30 did not add new business behavior to them.
