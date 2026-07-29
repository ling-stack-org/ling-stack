# T13-O.33 Channel Route Explanation Dead CSS Evidence

## Scope

- Slice: `T13-O.33`.
- Surface: Channel Activity > Routing > Ling evidence detail.
- Branch: `codex/ui2-desktop-coverage-foundation`.
- HEAD while captured: `0a0b8050` with a dirty shared Desktop/UI 2.0 working tree.
- Date: 2026-07-24.

## Ownership Result

- Removed the zero-consumer roots `channel-route-pill`, `channel-route-explanation`,
  `channel-route-explanation-toggle` and `channel-route-explanation-popover`.
- The four tokens have no exact production/package emitter, ordinary E2E fixture or CSS writer. The focused spec
  contains them only as negative absence guards.
- Preserved the live `.channel-route-inspect-grid` and `.channel-route-inspect-section` owners and their real
  `ChannelInspectorPanels` consumers.
- Preserved adjacent live `.file-ref-chip`, `.channel-message-row-footer-stack` and
  `.activity-shell .message-feed` branches.
- No API, contract, database, route, i18n, Logo, Channel behavior or packaged Desktop behavior changed.

## CSS Accounting

- `components.css`: `2,202 -> 2,118` lines.
- `channel-message-transcript.css`: `438 -> 435` lines.
- O.33 attributable reduction: `87` lines.
- The shared worktree currently reports `159 CSS files / 33,673 lines`. This is a mechanical current-tree snapshot;
  it includes other in-flight shared-tree changes and is not attributed entirely to O.33.

## Automated Evidence

- `ui2-channel-route-explanation-dead-css.spec.ts`: ordinary `3/3`, capture `3/3`.
- Selected Channel task-strip + message transcript + Web release regression: `18/18`.
- Conversation Header/Search follow-up executed in the same closeout: `8/8`.
- `corepack pnpm --filter @ling-stack/web typecheck`: passed.
- `corepack pnpm --filter @ling-stack/web check:i18n`: passed (`en-US=4099`, `zh-CN=5751`).
- `corepack pnpm --filter @ling-stack/web lint`: passed; direct Feature package imports remain `0`, legacy z-index
  budget is `50/97`, high literal z-index budget is `2/25`.
- `corepack pnpm --filter @ling-stack/web build`: passed; only the existing large-chunk warning remains.
- `git diff --check`: passed.

The focused browser coverage verifies keyboard `Inspect / Hide details`, focus state, long unbroken route/provider/
model identities, `overflow-wrap:anywhere`, document and region containment, Light/Dark Theme Pack behavior,
reduced motion, console errors and page errors.

## Runtime And Screenshots

- Served artifact: source through the Playwright-managed real Vite dev server.
- Locale: `en-US`.
- Fixture: one accepted auto-route decision with long provider/model/source identities and alternative evidence.
- The screenshots use mocked daemon data rendered by the real Web app; they do not prove a real daemon or packaged
  Desktop host flow.

| File | Theme / viewport | SHA-256 | Original-size inspection |
|---|---|---|---|
| `1440x960-ling-light-route-inspect.png` | `ling-light`, 1440x960 | `83f1eccb55910438d307d516b5fda550f702c767fc876cc1c9dd13667612c3a4` | Routing detail remains keyboard-open, long metadata wraps inside the Dock, and removed prototype roots do not reappear. |
| `1280x800-ling-dark-route-inspect-reduced-motion.png` | `ling-dark`, 1280x800, reduced motion | `baa95050a0d78546554526412eb59431739c75e1e53843f79e28745e20a2ef52` | Compact Dock retains readable sections, inset focus and zero horizontal overflow without active movement animation. |

Both PNG files were inspected at original size. The narrow Dark Dock intentionally wraps stress metadata into many
lines; content remains contained and scrollable without overlap.

## Remaining Work

- O.33 closes dead CSS ownership only; it does not raise a Channel Function ID.
- Shared Input remains healthy. The separate Header Search caret follow-up is documented in the Input component
  contract; the remaining page-level raw text controls continue under `T12.1c/U13`.
- Packaged macOS and Windows evidence remains pending.
