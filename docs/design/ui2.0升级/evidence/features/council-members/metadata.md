# Council Members A Evidence

## Status

- Function: `COUNCIL-MEMBERS-001`
- Result: `verified`
- Source server: real Vite source server at `http://127.0.0.1:4184`
- Branch: `codex/ui2-desktop-coverage-foundation`
- HEAD at capture: `0a0b80502715`
- Worktree: shared and dirty; screenshots were generated from the current source working tree, not `dist`, Storybook or static HTML.
- Capture command: `LING_CAPTURE_UI2_EVIDENCE=1 LING_PLAYWRIGHT_PORT=4184 corepack pnpm exec playwright test e2e/ui2-council-members.spec.ts`
- Capture result: `9 passed`
- Browser: Playwright Chromium, one worker
- Motion: every scenario used `prefers-reduced-motion: reduce`
- Console gate: focused spec records browser `console.error`, `console.warning` and `pageerror`; all nine scenarios returned `0 / 0 / 0`.

## Screenshots

| File | Fixture / reached state | Locale | Theme | Viewport / PNG | SHA-256 |
|---|---|---|---|---|---|
| `1440x960-ling-light-custom-ready-mixed.png` | custom Council, complete fresh Health, two enabled ready members and filtered Add candidates | `en-US` | `ling-light` | `1440x960` / `1440x960` | `f3b75ebf016291d94f7eabb4d281dec34c7a6581f8a2e0b8ce4a9cc21385cd98` |
| `1440x960-ling-dark-managed-read-only.png` | builtin Council, three ready members, no mutation controls, Clone to customize | `en-US` | `ling-dark` | `1440x960` / `1440x960` | `d637e01d6494b1b89944b51c259d978309b976736f8b9bb661993535235ade4d` |
| `1440x960-ling-dark-remove-confirm.png` | custom Council, remove last enabled member confirmation | `en-US` | `ling-dark` | `1440x960` / `1440x960` | `9ba81b842a292c7bfb6677badb911dfa75234593ba7d2ee57caa87ff049b0fad` |
| `1280x800-ling-light-empty-no-candidates-zh-cn.png` | empty custom Council, every teammate hidden/disabled/system, compact no-candidate repair | `zh-CN` | `ling-light` | `1280x800` / `1280x800` | `b31029535c2820fb76a67d36fe7a51487a073cc74300f624ccad814ee67b1d84` |
| `1280x800-ling-dark-readiness-partial.png` | truncated Health with one explicit hidden finding and uncovered pending members | `en-US` | `ling-dark` | `1280x800` / `1280x800` | `a46e5524c749824606f411189c0fcbb179f1c0db143b66eb4248c018755bdb0f` |
| `1280x800-ling-dark-save-conflict-stale.png` | external member drift adopted after preflight; zero PUT at capture and explicit repeat required | `en-US` | `ling-dark` | `1280x800` / `1280x800` | `d11fe151935eea153fc087e72202f0f178e402a58718b44cbe29ef3b80b8bb9d` |

All six originals were visually inspected after capture. Identity, visible readiness text, fixed actions, feedback and parent Council
header do not overlap. The first visual pass exposed compact dot-only statuses, duplicate repair actions and false stale conflict copy;
those issues were fixed before the hashes above were recorded. The remove confirmation was recaptured after the shared Dialog close
control stopped opening a competing Tooltip on auto-focus; one `Escape` now closes the Dialog and restores focus.

## Interaction And Request Evidence

- Add excludes existing, hidden, disabled and Ling Agent/system teammates; paused candidates remain visible with `Paused`.
- Add sends one normalized PUT under double click, appends `slotKey`, omits localized `label`, and restores Select focus after refresh.
- Toggle and reorder use one mutation flight; existing `label/slotKey` survive and positions are continuous `0..n-1`.
- Remove Cancel and Esc send zero PUT and restore trigger focus; confirming while busy locks close, Esc and duplicate submit.
- Direct channel membership fixture is byte-for-byte unchanged after Council member removal.
- Initial load failure, retained refresh failure and PUT failure preserve their documented authority boundaries and repair paths.
- Preflight fingerprint drift updates to latest GET data and sends zero PUT until the user repeats the action.
- Delayed old-Council GET completion cannot replace the selected Council rows.
- PUT success enters Health pending; only a later `generatedAt` clears the post-mutation readiness gate.

## Layout, Accessibility And Motion

- Document and Members panel horizontal/vertical overflow checks passed at `1440x960` and `1280x800`.
- `.council-members-list` is the bounded vertical scroll owner; summary, feedback and Add row remain outside it.
- IconButton hit areas come from shared `size=sm`; every icon action has Tooltip, title and ARIA label.
- Switch uses a stable accessible name and checked state; row status is visible text plus color, never color-only.
- Keyboard evidence covers Add focus restore, Move controls, Remove Esc, busy Esc lock and trigger focus return.
- Feature CSS defines no keyframe, raw duration/easing or private transition; reduced motion is owned by shared primitives.

## Static And Regression Evidence

| Gate | Result |
|---|---|
| `git diff --check -- <touched paths>` | passed |
| `corepack pnpm --filter @ling-stack/web typecheck` | passed |
| `corepack pnpm --filter @ling-stack/web lint` | passed |
| focused `ui2-council-members.spec.ts` | `9/9` passed |
| `ui2-council-list-health.spec.ts` | `6/6` passed |
| `ui2-council-create-clone.spec.ts` | `7/7` passed |
| legacy `councils.spec.ts` | `2/2` passed with custom mutation and builtin read-only + Clone semantics |
| `ui2-settings-workspace-tools.spec.ts` | `7/7` passed |
| focused CSS forbidden scan | passed, zero findings |
| runtime-provenance product-copy scan | passed; only negative E2E assertion matched |

## Integration Closeout

- All six shared locale keys were added and `check:i18n` passed.
- Historical Council mutation coverage now uses a custom Council. Builtin/template Councils assert read-only members and the existing
  Clone flow instead of expecting a mutation surface that the store may restore on restart.
- Settings workspace-tools reaches Teammate Management through the Settings owner; the managed Members panel does not expose a false
  `Manage teammates` action.
- The shared Dialog close IconButton retains `aria-label` and `title` but does not mount a separate Radix Tooltip on auto-focus. This
  removes the two-Escape interaction while preserving busy dismissal protection for Dialog and Drawer.
- Model and Plugin regressions remain owned by their independent in-progress UI2 slices and are not claimed by Council evidence.

## Truth Boundary

- `COUNCIL-RUNTIME-001` remains blocked.
- No screenshot, copy, view-model or test infers runtime provenance, task ownership, activity, success rate, last run or scheduler order.
- Managed read-only is a UI product boundary, not a server authorization claim.
- GET preflight reduces stale whole-array replacement but cannot remove the API's GET-to-PUT last-write race without revision/ETag support.
