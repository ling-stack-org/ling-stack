# T13-P.6-E Conversation Artifact Recovery Evidence

## Capture Context

| Field | Value |
|---|---|
| Captured | `2026-07-26` |
| Branch / base HEAD | `codex/ui2-desktop-coverage-foundation` / `0a0b80502715` |
| Served artifact | Playwright-managed Vite source at `http://127.0.0.1:4174` |
| Browser / locale | Playwright Chromium, one worker / `en-US` |
| Fixture | `installChannelWorkCellFixture` with two diff artifacts: `src/RecoverySurface.tsx` and `src/recovery-surface.css`; success route is gated, failure route returns focused `503` twice before retry succeeds |

Capture command and aggregate result are the seven-spec command recorded in
`shell/full-access-confirmation-parity/metadata.md`: `18/18` passed in `57.8s`.

## Screenshots

| File | Viewport / theme / locale | Changed state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-undo-confirm.png` | `1440x960`, `ling-light`, `en-US` | Undo confirmation before any mutation; two-file recovery surface remains visible behind the Dialog | `9be6aa25b9bb832d4405254eaf20934fab5f2578bc169275f743894645d7da2d` |
| `1280x800-ling-dark-persistent-failure.png` | `1280x800`, `ling-dark`, `en-US` | Failed Undo remains actionable inside the Dialog with Close and Retry | `0cc6eb628219f4e173010897dcfad2824cbbba12758d6755c79c3121a73f3b06` |

## Runtime And Geometry

- Console errors: `0` unexpected; the collector excludes only Chromium's generic failed-resource line for the intentional `503`. Page errors: `0`.
- Browser blocking dialogs: `0`.
- Document and active Dialog/work-cell horizontal overflow were numerically asserted at `<= 1px`.
- Cancel/Escape restore focus to Undo; successful Undo/Reapply restore focus to the newly available counterpart action. Busy state blocks Escape and duplicate mutation.
- Dark failure uses `prefers-reduced-motion: reduce`; Dialog and overlay computed animation entries are empty.
- Both PNGs were inspected at original dimensions and are nonblank with no clipping, overlap or theme leakage.
