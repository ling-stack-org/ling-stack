# T13-P.6-C Full Access Confirmation Parity Evidence

## Capture Context

| Field | Value |
|---|---|
| Captured | `2026-07-26` |
| Branch / base HEAD | `codex/ui2-desktop-coverage-foundation` / `0a0b80502715` |
| Served artifact | Playwright-managed Vite source at `http://127.0.0.1:4174`, not `dist` |
| Browser / host | Playwright Chromium, one worker / macOS `26.5.2` arm64 |
| Locale | `en-US` |
| Fixture | `createFullAccessState`: ready `gpt-5.5` chat provider, empty runs, one runnable Channel task; the teammate case adds `teammate_full_access` |

Capture and focused verification command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web exec playwright test \
  e2e/ui2-full-access-confirmation-parity.spec.ts \
  e2e/ui2-conversation-artifact-recovery.spec.ts \
  e2e/ui2-channel-protocol-reset-dialog.spec.ts \
  e2e/ui2-artifact-preview-feedback.spec.ts \
  e2e/ui2-channel-workspace-feedback.spec.ts \
  e2e/ui2-conversation-block-feedback.spec.ts \
  e2e/ui2-model-workbench-feedback.spec.ts --workers=1
```

Result: `18/18` passed in `57.8s`.

## Screenshots

| File | Viewport / theme / locale | Changed state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-channel-confirm-draft.png` | `1440x960`, `ling-light`, `en-US` | Channel Run opens one Full Access Dialog while the composer draft remains visible; footer Cancel owns initial focus | `4d4fe23dd811a753f82bf1aeb01ccbddf64d1209d00479cf818557a2d0c49739` |
| `1280x800-ling-dark-normal-cancel-preserves-draft.png` | `1280x800`, `ling-dark`, `en-US` | Normal conversation after Escape: Dialog closed, Send focus restored and draft retained | `abd096d13ba298faff1b560487887f3d4cf0f898c7d22ca77b7c5a1ef508fbe2` |
| `1440x960-ling-light-teammate-confirm-draft.png` | `1440x960`, `ling-light`, `en-US` | Teammate private chat reopens one Full Access Dialog with the private draft retained and footer Cancel focused | `9fa4bfe965b2cf1acdebb2bf396d1f1f630f8aef45ec91ff2681fdfefe9453f6` |

## Runtime And Geometry

- Console errors: `0` unexpected in all three scenarios. Page errors: `0`.
- Browser blocking dialogs: the fixture replaces `globalThis.confirm` with a throwing guard; no guard call occurred.
- Document horizontal overflow was numerically asserted at `<= 1px` after each complete flow.
- Channel and teammate Dialogs assert footer Cancel focus. Normal conversation asserts Send focus and the exact retained draft after cancellation.
- Dark normal conversation emulates reduced motion. This slice proves final state and focus under that preference; it does not claim a component-level computed-animation audit.
- All three PNGs were inspected at original dimensions. They are nonblank, correctly themed and show no clipping, incoherent overlap or horizontal displacement.
