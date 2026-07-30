# Quick Theme And First Run Evidence

Captured from `codex/quick-theme-first-run` on 2026-07-30 with the real Vite renderer and the standard
mock daemon boundary.

## Coverage

- `1440x960-ling-light-first-run.png`: missing chat model, soft guidance, visible skip and repair action.
- `1280x800-ling-dark-first-run.png`: compact dark First Run Dialog.
- `1440x960-ling-light-quick-theme.png`: local image selected, token-only multi-surface preview ready.
- `1280x800-ling-dark-quick-theme.png`: compact dark Quick Theme Studio.

## Product Assertions

- First Run is an overlay, adds no `ViewId`, can be skipped, and does not block the application after close.
- Quick image analysis makes no provider/media/run request.
- Quick preview contains no runtime artwork image.
- Installed Quick manifest uses `ling-standard`, has `generation.mode=quick`, omits `artwork`, and stores
  zero installed image assets.
- Desktop native generated-theme persistence remains outside this Web-first evidence.
