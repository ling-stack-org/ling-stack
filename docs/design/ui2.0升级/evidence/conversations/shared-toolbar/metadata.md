# P5.1 Shared Conversation Toolbar Evidence

## Capture Context

- Date: `2026-07-19`
- Branch: `codex/ui2-desktop-coverage-foundation`
- Base HEAD: `0a0b8050`
- Working tree: dirty integrated Desktop/Computer Use and UI 2.0 workspace; no cleanup, reset, stash mutation,
  commit, push or branch switch
- Served artifact: Playwright-managed real Vite development server at `http://127.0.0.1:4174`, not `dist`
- Browser: Playwright Chromium on macOS 26.5.2 arm64
- Data source: deterministic `mockDaemon` with one channel, one AI teammate and one ready chat provider
- Locale: `en-US`

Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm exec playwright test \
  e2e/ui2-conversation-toolbar.spec.ts
```

## Scope

P5.1 establishes package and visual ownership for the shared conversation Toolbar foundation:

- `@ling-stack/conversation-ui-react` now depends on `@ling-stack/ui-react` in the allowed direction;
- the package exports `ConversationToolbar`, icon/action buttons, count badge and `styles.css`;
- toolbar controls reuse shared Button、IconButton and Tooltip contracts;
- Web `WorkspaceTopRightToolbar` remains a compatibility adapter for existing callbacks and stable classes;
- channel、normal conversation、AI teammate private chat and right-dock toolbars use the same primitive;
- `ConversationShell` base layout moved from `components.css` into the conversation package layer;
- replaced toolbar/button/badge selectors were deleted rather than copied.

This slice does not claim complete conversation Header migration. In particular, the channel still needs its final
Search/Refresh behavior, and Summary/Dock/Terminal motion and complete state coverage remain P5.2-P6 work.

## Verified Behavior

- every migrated toolbar exposes `role=toolbar` and `data-conversation-toolbar=true`;
- normal conversation and private chat action order is Search、Refresh、Summary、Terminal、Details;
- channel keeps its real teammate slot and shared Summary、Terminal、Details actions without inventing capabilities;
- icon actions are shared `ling-ui-button` controls with `data-size=sm` and at least `32x32` hit areas;
- actions expose stable `data-conversation-action` identifiers;
- count badges expose stable `data-conversation-count` and remain visually attached to their action;
- Tooltip appears on hover/focus, active Summary uses `aria-pressed=true`, and no visible action labels return;
- Light/Dark themes, both target viewports, console and document overflow pass.

## Automated Evidence

- `@ling-stack/ui-react`: `39/39`.
- `@ling-stack/conversation-ui-react`: `8/8`.
- `ui2-conversation-toolbar.spec.ts`: `2/2`.
- Three representative product surfaces plus Dark Mode: `8/8`.
- Web i18n、lint/import/overlay budgets、typecheck and `git diff --check`: passed.

## CSS Ownership Result

- `conversation-toolbar.css`: `375 -> 233` lines.
- `components.css`: `16,587 -> 16,463` lines across P4.7 and P5.1; P5.1 removed the ConversationShell,
  dock-toolbar and legacy task-toolbar/governance selector families it replaced.
- New package-owned focused CSS: `81` toolbar lines plus `5` shell layout lines.
- No Feature Radix import, `transition: all`, Web theme selector or hard-coded product color was introduced.

## Screenshots

| File | Surface | SHA-256 |
|---|---|---|
| `1440x960-ling-light-channel-toolbar.png` | Light channel header | `6299440a608afffa2b77e2a13a6e9315f5695d232e5b66c77d9de15c4a17505b` |
| `1440x960-ling-light-teammate-toolbar.png` | Light AI teammate private chat | `4af1dee34a5a970cd253ff4e082576df177d6ec880569f77ff195acd97644fda` |
| `1440x960-ling-light-normal-toolbar-summary.png` | Light normal conversation with Summary | `5adfbecc6805149f263cb156eac63b33bab919aee32fa645e7449cc385f123d0` |
| `1280x800-ling-dark-channel-toolbar.png` | Dark channel header | `d4a4d12cb6c7ac9399b37239c6fa33a56ebdcec9ef9a981b8e024ef3c76eb2fc` |
| `1280x800-ling-dark-teammate-toolbar.png` | Dark AI teammate private chat | `d4fd76de39cae4a969056f97cd9420dbdd8a62a8bf68d8409c55bc7879f2c150` |
| `1280x800-ling-dark-normal-toolbar-summary.png` | Dark normal conversation with Summary | `c5cb2831bf8fd93d2a7551f033122e623af0a698e667bf31c37381556788db12` |

All six PNG files were inspected at original resolution. No toolbar overlap、label leakage、theme mismatch,
hit-area collapse or document overflow was observed. The screenshots also preserve known product states such as
channel provider setup feedback; those states are not claimed as completed by this Toolbar slice.

## Status Decision

- P5.1 shared conversation Toolbar foundation: `verified`.
- `CHANNEL-HEADER-001`, `CONV-NORMAL-HEADER-001` and `CONV-TEAMMATE-HEADER-001` remain open because each
  includes more than the shared primitive and default geometry verified here.
- P5.2 proceeds with shared Summary、Right Dock、Bottom Terminal motion and resize ownership.
