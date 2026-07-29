# Channel Saved View Dialog Evidence

Captured from the Playwright mock-daemon surface with animations disabled.

| File | Viewport | Theme | Reachable state | SHA-256 |
|---|---:|---|---|---|
| `1440x960-ling-light-create-draft.png` | `1440x960` | `ling-light` | Create Dialog, focused shared Input with a draft value | `3ac4f321a3991def6941ad3c08a42bd6aad4378da9d0f5a1ebd25e61fcf3b9a4` |
| `1440x960-ling-light-rename-failure.png` | `1440x960` | `ling-light` | Rename failure retained inside the Dialog with no duplicate AppShell error | `bae1398aa78a6b2e136e123837fa00b33dca6c9a197ab248f0ddc0ca3cd43701` |
| `1440x960-ling-light-delete-confirm.png` | `1440x960` | `ling-light` | Permanent saved-view deletion confirmation | `d8e4b03814bdec00e3df5754a3f810f63969e71a000a6da52b76055f0e0dea42` |
| `1280x800-ling-dark-limit-warning-toast.png` | `1280x800` | `ling-dark` | Eight-view limit warning Toast with reduced motion | `b7d1d14aba3e7c45f9bf23b44c2bf52cee435920ab4f58541dfc5ace4dcaa5d3` |

## Verification

- `@ling-stack/ui-react` package tests: `51/51`.
- `ui2-form-controls.spec.ts`: `4/4`.
- `ui2-channel-saved-view-dialog.spec.ts`: `2/2`.
- Focused Input keeps the native control inside the fixed-height shell before and after focus.
- The shell clips native painting and owns one continuous inset focus stroke; the native input has no border, outline, or shadow.
- Caller-owned workspace-settings failures remain only in the Dialog; `.inline-error` is absent. The combined Saved
  View and Protocol Reset recapture passed `5/5`.
- Screenshots were inspected at original resolution; no document or Dialog horizontal overflow was observed.
