# Legacy Workspace Prototype Hard-Dead CSS Evidence

## Scope And Status

- Recorded: `2026-07-24`, Asia/Shanghai.
- Branch / baseline HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Source: real Vite application through Playwright Chromium and daemon fixtures.
- Themes/viewports: `ling-light`, `ling-dark`, imported `Quiet Ocean`; `1440x960` and `1280x800`.
- Status: `T13-O.29 Legacy Workspace Prototype Hard-Dead CSS` is Web verified. It does not change Function IDs or packaged Desktop status.

## Deletion Boundary

- Removed all CSS writers for the 28 frozen legacy prototype tokens from `layout.css`, `components.css` and `strict-console.css`.
- Exact production, package, E2E and CSS scans return zero occurrences for every deleted token.
- Live mixed branches remain: `pending-assets`, `mention-picker-popover`, `mention-suggestion` and `channel-option-actions`.
- No TSX, API, contracts, routes, i18n, Logo, Desktop, Input, Composer, Message or Dock behavior changed.
- No compatibility alias or global `input:focus` patch was added.

## Verification

| Gate | Result |
|---|---|
| Focused spec, ordinary | `4/4` passed |
| Focused spec, formal capture | `4/4` passed |
| Selected Composer/Form/Workspace/Runtime | initial `51/52`; the only broad-name History locator was narrowed and its exact rerun passed `1/1` |
| Broad App/Channel/Teammates/Workspace/Dark/Theme | `165/165` passed |
| Web lint, i18n and typecheck | passed |
| Web production build | passed; existing large-chunk warning only |
| `git diff --check`, exact dead-token scan and live-branch scan | passed |

The focused spec verifies the static zero-consumer gate, Channel pending attachments and mention picker, Normal and
Teammate command/permission controls, Channel Create, focus containment, overlay/document overflow, reduced motion,
console errors and page errors.

## CSS Measurement

- `layout.css`: `907 -> 531`, net `-376` lines.
- `components.css`: `2,890 -> 2,856`, net `-34` lines.
- `strict-console.css`: `434 -> 421`, net `-13` lines.
- Web CSS: `160 files / 34,438 lines -> 160 files / 34,015 lines`, net `-423` lines.

## Original-Size Screenshot Ledger

| Evidence | Viewport/theme | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-channel-composer.png` | 1440x960 / Ling Light | Channel pending attachment, mention result and focused composer | `52322af3feb7a87a95b6ea8898d818b17d9c7240f5133d8b02154387410aece1` |
| `1280x800-ling-dark-normal-teammate-composers.png` | 1280x800 / Ling Dark / reduced motion | Normal and Teammate command flows; final Teammate permission menu and contained focus | `f0a57b208025cdb746b3a2559d538fe6b901a401abdf6ea23266e75eac59073e` |
| `1440x960-quiet-ocean-channel-create.png` | 1440x960 / Quiet Ocean | Channel Create Dialog, focused Name input and teammate selection | `f89d0c2d256ec818a5006d496df84c125d0ef286442392ee7691f61901bda849` |

All screenshots were inspected at original size. No control or document-level horizontal overflow was visible.

## Honest Remaining Gaps

- Shared Input remains green; remaining legacy raw controls still migrate page by page under `T12.1b/U13`.
- No packaged Electron macOS Retina or Windows 125%/150% evidence was produced.
- `components.css` remains 2,856 lines and is still architecture debt; this slice only removed mechanically dead families.
