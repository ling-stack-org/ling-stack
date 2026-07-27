# Council Settings / Archive UI 2.0 Evidence

Date: 2026-07-23

## Source

- Function ID: `COUNCIL-SETTINGS-001`
- Slice: `P8.2e / CSA-01..09`
- Branch: `codex/ui2-desktop-coverage-foundation`
- HEAD at capture: `0a0b8050`
- Worktree: shared dirty UI2/Desktop worktree; screenshots were generated from the current source tree and preserve all
  pre-existing work.
- Runtime: real Vite source server started by Playwright at `http://127.0.0.1:4202`.
- Data: deterministic Playwright daemon routes. No real secret, provider credential or remote mutation was used.
- Acceptance surface: desktop Web. Packaged Electron macOS/Windows evidence is not claimed.

## Verification

```text
LING_CAPTURE_UI2_EVIDENCE=1 LING_PLAYWRIGHT_PORT=4202 \
  corepack pnpm --filter @ling-stack/web exec playwright test \
  e2e/ui2-council-settings-archive.spec.ts --workers=1
Result: 7/7 passed

Legacy Council/archive/Settings/Dark selected regression: 30/30 passed
Council List/Create/Members/Channels/Settings focused regression: 36/36 passed
Combined selected regression: 66/66 passed

@ling-stack/ui-react package tests: 51/51 passed
Web typecheck, check:i18n and lint: passed
git diff --check and focused CSS forbidden scan: passed
```

The focused suite verifies clean/dirty/reset, exact save payload and single-flight retry, retained save failure,
authoritative mutation projection across refresh failure, lifecycle failure/pause/resume, builtin/template read-only
boundaries, one Portal, Cancel/Close/Escape focus restore, busy dismissal lock, retained archive failure, archive success,
channel-policy cleanup, direct teammate membership preservation, no Delete DOM, folded technical details, 100-row internal
scrolling, long zh-CN content, reduced motion, zero root/panel overflow and zero unexpected console errors.

## Screenshots

| File | Reached state | Viewport / locale / theme | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-settings-dirty.png` | custom Council with retained dirty name, description and pinned draft | 1440x960 / en-US / ling-light | `dd148330485640349099ad207276432d9b7780d467a4c58bb3181f3db2421a53` |
| `1280x800-ling-dark-zh-save-failure.png` | long zh-CN draft with settings-scoped retained failure | 1280x800 / zh-CN / ling-dark / reduced motion | `333728441e315d0f66a3764ee6f36337d9983de749056b19774669abcb7ddfab` |
| `1440x960-ling-dark-archive-confirm.png` | archive confirmation in the shared Portal Dialog | 1440x960 / en-US / ling-dark | `bfd598aa143469c889de37a5a82d5fdfd5fb192758627f461dcd6227ce9c13c5` |
| `1280x800-ling-light-archive-failure.png` | archive failure retained in the initiating Dialog | 1280x800 / en-US / ling-light | `0351023455080c2ef5fd2a8e79d164d14948d2c6ff5be317d1f411a1504ca506` |
| `1440x960-ling-light-managed-boundary.png` | builtin Council read-only boundary with Clone and no mutation controls | 1440x960 / en-US / ling-light | `7583e2497b2024b1ba3ab307f9b9857b56f61c63ea5a2cb7d74fccd87cf16504` |
| `1280x800-ling-dark-100-row-reduced-motion.png` | 100 Council rows, long zh-CN identity and bounded Settings scroll | 1280x800 / zh-CN / ling-dark / reduced motion | `8fd5d44f6af2ae872420883318b98d97331939a69835cca36647b967c1e8882a` |

All six files are original-size, 8-bit RGB, non-interlaced PNGs. Hashes were recomputed after the final capture.

## Visual Review

- All screenshots were inspected at original resolution.
- Settings keeps one compact product hierarchy: editable identity, one lifecycle action, folded boundaries/actions and a
  bounded Danger owner. Raw IDs, request payloads and runtime guesses are absent from the default layer.
- Long labels and descriptions remain inside the detail column at both target viewports; actions do not overlap text.
- The 100-row list and Settings body keep independent internal scroll owners without document-level overflow.
- Dialog placement, backdrop, focus owner and failure feedback remain readable in Light and Dark themes.
- Shared Input focus stays inside its fixed-height shell; no second native focus border or shadow is visible.

## Ownership And Residuals

- `council-settings-archive.css` is the only Settings/Lifecycle/Archive/Danger selector owner and is 314 lines.
- `councils.css` is 45 lines and retains only the shared Council detail skeleton; the two files have no overlapping class
  tokens.
- The mutation response remains authoritative when projection refresh fails; the refresh owner reports stale data without
  turning a successful save/lifecycle/archive mutation into a false failure.
- Council has no Delete API or reachable archived catalog/Restore IA, so neither is rendered or claimed.
- `COUNCIL-RUNTIME-001` remains `inventory`: no stable Council run provenance exists.
- The Council update API has no revision/ETag. The client serializes mutations in this window but cannot prevent a later
  cross-client last-write-wins update.
- Packaged Electron macOS/Windows verification remains an independent release gate.
