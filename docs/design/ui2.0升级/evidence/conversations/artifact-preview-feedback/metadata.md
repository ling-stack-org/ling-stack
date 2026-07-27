# T13-P.6-G Artifact Preview Feedback Evidence

## Capture Context

| Field | Value |
|---|---|
| Captured | `2026-07-26` |
| Branch / base HEAD | `codex/ui2-desktop-coverage-foundation` / `0a0b80502715` |
| Served artifact | Playwright-managed Vite source at `http://127.0.0.1:4174` |
| Browser / locale | Playwright Chromium, one worker / `en-US` |
| Fixture | One Channel message with a text attachment, an unsupported attachment and a malformed preview response; Clipboard and object-URL failure switches are controlled in-page |

Capture command and aggregate result are the seven-spec command recorded in
`shell/full-access-confirmation-parity/metadata.md`: `18/18` passed in `57.8s`.

## Screenshots

| File | Viewport / theme / locale | Changed state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-copy-success-toast.png` | `1440x960`, `ling-light`, `en-US` | Text preview remains open while the deduped Copy success Toast is visible | `aad5e004953452a8ef6463fa2bb8aeece33de99a188b3e5ad176377a97aa5627` |
| `1280x800-ling-dark-copy-failure-inline.png` | `1280x800`, `ling-dark`, `en-US` | Copy failure remains inline inside the preview; no success Toast is present | `47778a01af424b4488f0a31b6b86758581fd702d42f6da1fc150290bde20db74` |

## Runtime And Geometry

- Console errors: `0`. Page errors: `0`.
- Preview owner, panel and body containment were numerically asserted; document horizontal overflow is `0px`.
- Initial focus lands on Close preview and closing returns focus to the originating attachment trigger.
- Dark failure emulates reduced motion and the preview panel computes `animation-name: none`.
- The same focused spec also verifies persistent Download, unsupported-preview and load failures, although only the representative Copy failure is captured.
- Both PNGs were inspected at original dimensions and show no blank canvas, clipping, overlap or theme leakage.
