# P6A.1 Channel Header And Search Evidence

## Scope

- Function IDs: `CHANNEL-HEADER-001`, `CHANNEL-SEARCH-001`.
- Surface: normal Channel workspace Header only; Channel Settings and Environment retain their specialized Header actions.
- Branch: `codex/ui2-desktop-coverage-foundation`.
- HEAD while captured: `0a0b8050` with a dirty mixed Desktop/UI2 working tree.
- Date: 2026-07-24 (focus-caret follow-up recapture).

## Implemented Contract

- Normal Channel action order is `Search / Refresh / channel-specific slots / Summary / Terminal / Details`.
- All five shared actions are icon-only and use the P5 package-owned Toolbar/Button/Tooltip contract.
- Header search reuses `useChannelActivityController`; no second search state or API was added.
- Shared Header Search now keeps a `32px` shell with `20px` native line-height, matching Normal and Teammate caret
  containment instead of using a near-full-height `30px` line box.
- Search covers message copy, file refs, attachment file names/paths/content types, tasks and run titles.
- Clear keeps the search open and focused. Escape, repeated Search click and Channel switch close and clear it.
- Explicit Activity tools remain available; when Header search is open their duplicate search field is hidden.
- Refresh awaits the existing AppShell Channel refresh chain and scopes loading to the Refresh button.
- Summary and teammate overlays close before Header search opens; Details and Terminal keep their independent P5 behavior.

## Automated Evidence

- `corepack pnpm --filter @ling-stack/web check:i18n`: passed.
- `corepack pnpm --filter @ling-stack/web lint`: passed; legacy z-index budget moved from `97` to `96`.
- `corepack pnpm --filter @ling-stack/web typecheck`: passed.
- `ui2-channel-header-search.spec.ts`: `4/4`.
- P5 toolbar/panel regression: `12/12`.
- App/Composer/Dark regression: `24/24`.
- Full `channel.spec.ts`: `104/105`; the only failure is the pre-existing
  `phase 1 parallel multi-agent active transcript shows latest action per agent without drawer surfaces`
  assertion (`.conversation-work-cell-active-stream` expected `0`, received `2`).

The focused spec verifies action order, 32px hit areas, automatic focus, stable 48px Header height,
input containment, message/attachment/run search, no-result + usable Composer, Clear, Escape, repeated toggle,
Channel switch, local Refresh loading, overlay separation, long titles, Dark mode, console and document overflow.

## Runtime And Fixtures

- Served artifact: source through the Playwright-managed real Vite dev server.
- URL: `http://127.0.0.1:4174/`.
- Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- ui2-channel-header-search.spec.ts
```

- Locale: `en-US`.
- Mock daemon fixture: long Channel name, three Channel teammates and one searchable Channel message.
- No backend, contract, database, route, permission or state-machine change was required.

## Screenshots

| File | Theme / viewport | SHA-256 | Inspection |
|---|---|---|---|
| `1440x960-ling-light-channel-header-search.png` | `ling-light`, 1440x960 | `a2b88e40af3e705f875011c2593b306d14f380b27f68e599101fd9da4e5e876d` | Header remains one row; Search caret keeps vertical space, long title truncates and Toolbar retains its boundary. |
| `1280x800-ling-dark-channel-header-search.png` | `ling-dark`, 1280x800 | `f2592c8e3a97d78f797e68a3864f4523d484f9ae6407f1af9b565a41d827d0f3` | Search input and caret remain inside the 48px Header; actions stay readable with no Light surface leak. |

Both PNG files were inspected at their original dimensions. The screenshots are mocked product data rendered by
the real Web app; they are not proof of a real daemon or Desktop host flow.

## Remaining Channel Work

- `CHANNEL-FEED-001` and `CHANNEL-COMPOSER-001` are the next slice.
- `CHANNEL-TASK-001`, `CHANNEL-ENV-001`, `CHANNEL-SETTINGS-001`, `CHANNEL-OVERLAY-001` and the deep
  `CHANNEL-DOCK-001` launcher/pages remain open.
- The existing active-transcript baseline remains assigned to the Feed slice and was not altered here.
