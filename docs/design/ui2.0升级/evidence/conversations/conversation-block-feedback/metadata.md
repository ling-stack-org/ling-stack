# T13-P.6-G Conversation Block Feedback Evidence

## Capture Context

| Field | Value |
|---|---|
| Captured | `2026-07-26` |
| Branch / base HEAD | `codex/ui2-desktop-coverage-foundation` / `0a0b80502715` |
| Served artifact | Playwright-managed Vite source at `http://127.0.0.1:4174` |
| Browser / locale | Playwright Chromium, one worker / `en-US` |
| Fixture | Two local-user Channel messages (`feedback_alpha`, `feedback_beta`); success adds one expandable work cell, while failure removes Clipboard support |

Capture command and aggregate result are the seven-spec command recorded in
`shell/full-access-confirmation-parity/metadata.md`: `18/18` passed in `57.8s`.

## Screenshots

| File | Viewport / theme / locale | Changed state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-copy-success-toast.png` | `1440x960`, `ling-light`, `en-US` | Keyboard Copy produces one deduped message-scoped success Toast and no local success row | `21cc8a5af58befe6844d29cfdc03ffb9fabda1aaac45572f8e13d3cd3d0c0567` |
| `1280x800-ling-dark-object-local-failure.png` | `1280x800`, `ling-dark`, `en-US` | Clipboard-unavailable feedback stays next to the owning focused message block after `3.2s` | `bdead45e6b50267c22af1e0e96916633b391233cc4583624c7a2ba50277d5a0e` |

## Runtime And Geometry

- Console errors: `0`. Page errors: `0`. Browser blocking dialogs: `0`.
- Document, feed, menu and local feedback horizontal overflow are numerically asserted at `<= 1px`.
- Keyboard focus moves between message blocks, menu Escape restores the owning block, and dismiss returns focus to that block.
- Dark failure uses reduced motion; all active feedback/Toast animation entries are computed as none or zero duration.
- Both PNGs were inspected at original dimensions and show no clipping, overlap or theme leakage.
