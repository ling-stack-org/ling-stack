# AI Teammate Danger Zone Evidence

Date: 2026-07-22

## Source

- Function ID: `TEAMMATE-DANGER-001`
- Slice: `T8.1l-I`
- Branch: `codex/ui2-desktop-coverage-foundation`
- HEAD at capture: `0a0b8050`
- Worktree: dirty shared UI2/Desktop worktree; screenshots represent the current uncommitted Danger slice plus existing
  shared UI2 changes.
- Runtime: real Vite dev server started by Playwright at `http://127.0.0.1:4191`.
- Daemon: deterministic Playwright mock using existing teammate API routes; failure/delay interception is test-only.
- Acceptance surface: desktop Web. Packaged Electron macOS/Windows evidence was not available and is not claimed.

## Verification

```text
LING_PLAYWRIGHT_PORT=4191 corepack pnpm --filter @ling-stack/web exec playwright test ui2-teammate-management-danger.spec.ts
Result: 5 passed

LING_PLAYWRIGHT_PORT=4191 LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web exec playwright test ui2-teammate-management-danger.spec.ts
Result: 5 passed

LING_PLAYWRIGHT_PORT=4191 corepack pnpm --filter @ling-stack/web exec playwright test teammates.spec.ts ui2-teammate-management-profile.spec.ts ui2-settings-workspace-tools.spec.ts dark-mode.spec.ts
Original worker result: 35 passed, 1 stale legacy assertion failed

The main integration owner migrated that assertion from the removed Tab-level Reason plus browser `window.confirm` to
the shared Dialog, labeled Reason Field and dialog confirm action. In the combined focused + selected rerun, all five
Danger scenarios and the migrated legacy hard-delete flow passed. One unrelated Council navigation scenario hit a
transient provider reload while parallel UI package builds were active; its isolated serial rerun passed `1/1`.
Effective final result for this closeout: focused `5/5`, selected `36/36`.
```

The focused suite asserts no browser dialog, Cancel initial focus, one-Esc close, trigger restore, busy dismiss
protection, exact retained Reason payload, failure/retry/success, disable-only busy/error, identity race, protected zero
mutation for Ling Agent, generic system and protected-profile identities, native Input border/shadow zero, focused
geometry, root overflow and console errors.

Static gates at closeout are recorded in the module implementation plan; all commands use the current shared dirty
worktree rather than a synthetic clean checkout.

## Screenshots

| File | State | Viewport / locale / theme | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-danger-default.png` | ordinary default; independent lifecycle actions | 1440x960 / en-US / ling-light | `2323b32a0ab300ef7bf3f2785e0e7ab1d47a3cca6a54cbc6cb253644ac797f03` |
| `1440x960-ling-light-delete-dialog-focus.png` | shared Dialog; long Reason focused inside stable shell | 1440x960 / en-US / ling-light | `16672e5b77b0d3886da77ddf59b360371163391dc10cece5591c1a1f4d0158c3` |
| `1280x800-ling-dark-delete-failure.png` | retained Reason and scoped hard-delete failure | 1280x800 / en-US / ling-dark / reduced motion | `6c71bc59135fbae228a12b38bc696b395bcb9d14c66dc857f1bc1904003335f4` |
| `1280x800-ling-dark-delete-success-fallback.png` | existing callback removed teammate; Settings Search focused | 1280x800 / en-US / ling-dark / reduced motion | `381d2b40162ae81e1c4b1b69b32d1a65d8688ac9b038592842888a460a751470` |
| `1280x800-ling-dark-disable-failure.png` | disable-scoped failure; hard-delete remains available | 1280x800 / en-US / ling-dark | `67b0dbee9f8ae29f7f2b536944871892109855529a168ba7a8196ab2972a51b1` |
| `1280x800-ling-dark-protected-read-only-zh-CN.png` | protected Ling Agent; managed read-only, zero mutation controls | 1280x800 / zh-CN / ling-dark / reduced motion | `1ecf0e1162e51152c3b86bcc239df2289b56876bdfacef6368b433d14478edab` |

All files are original viewport-size PNGs. SHA-256 values were computed with `shasum -a 256` after the final passing
capture run.

## Visual Review

- All six original images were inspected at original size.
- Default and failure surfaces remain compact and scannable; the destructive action is distinct without a color wall.
- Dialog copy wraps inside the 360px shared size; footer actions, warning and local failure do not overlap.
- Long Reason text scrolls inside the native input. Focus stays on the outer shared shell; no inner border or height
  protrudes beyond the shell.
- Dark surfaces use current theme tokens without hard-coded white panels; protected Chinese copy fits at 1280x800.
- No screenshot shows root horizontal scroll, action collision, duplicate overlay or protected mutation control.

## Residuals

- Current domain mutation callbacks swallow the caught server error after storing it globally. When they return without
  closing/removing the teammate, the focused controller can truthfully show only the existing `Unknown error` locale
  rather than the original server message. Changing that result contract is outside this slice.
- `TeammateWorkspace.tsx` is still 1739 lines and remains architecture debt, although this slice reduced it and placed
  all new Danger behavior in focused owners below 200 lines.
- Packaged Electron macOS/Windows screenshots remain a separate release gate and are not inferred from Web evidence.
