# P2B.1 Presentation Profile And Theme Compiler Evidence

## Capture Context

- Date: `2026-07-18`
- Branch: `codex/ui2-desktop-coverage-foundation`
- Commit: `0a0b8050`
- Working tree: dirty; Desktop/Computer Use and UI 2.0 slices remain uncommitted
- Served artifact: real Playwright-managed Vite Web app, not `dist`
- Browser: Playwright Chromium
- Data source: deterministic local RGBA sample, Theme Compiler output, IndexedDB generated Theme Pack,
  and `mockDaemon` business fixtures
- Locale: `en-US`
- Focused E2E: `ui2-presentation-compiler.spec.ts` `1/1`
- Target regression: presentation/compiler、ThemeRegistry、Dark Mode、AppShell、Settings and Desktop
  bridge `63/63`

## Screenshots

| File | Viewport | Theme/Profile | State |
|---|---|---|---|
| `1440x960-generated-immersive-home.png` | `1440x960` | `generated-quiet-forest` / `ling-immersive` | Generated manifest active on Home with translucent/strong route policy |
| `1280x800-generated-immersive-settings.png` | `1280x800` | `generated-quiet-forest` / `ling-immersive` | The same theme on Settings with forced solid/token-only policy and the AppShell instance preserved |

SHA-256:

```text
46e6321a1205696f3f451881c11bbe325af58e0e5fb85be1a29afd3c57dd0f89  1280x800-generated-immersive-settings.png
08c187663e21e6d5884cfb9e9ae19a458ea37465982570e1161a69b5dfcb07ad  1440x960-generated-immersive-home.png
```

## Implemented Behavior

- Four app-owned Profile definitions own supported artwork slots、decoration sets and route policies.
- Home、Sidebar、Conversation、Channel、Settings、management、media canvas、overlay、diagnostics and
  approvals resolve through the shared registry; Features never branch on Profile ID.
- `1280px` reduces strong artwork to ambient and removes decoration. Narrow、forced-colors and reduced
  transparency contexts use the approved solid fallback without changing Theme Pack identity.
- AppShell publishes generic `data-ui-surface/recipe/artwork-policy/decoration-policy` attributes and
  changes them without remounting the shell.
- Computer Use PiP is fixed to `overlay/solid/off/off`, so an immersive Home theme cannot enter captured
  media or compact window chrome.
- Local analysis accepts only complete RGBA samples up to `128px` per edge and derives deterministic
  luminance、palette、focus and safe-area metadata without network or identity inference.
- Compiler derives the complete semantic token map for Light or Dark, performs bounded contrast repair,
  emits versioned generation metadata and passes its output back through normal Theme Pack validation.
- Artwork compilation receives validated identity/metadata rather than source paths. It derives local
  asset names and blocks unsupported slots、duplicate identity、invalid checksum/size、non-transparent
  decorations、readable text、UI chrome、Logo and watermark risk.
- Unsafe palette functions、reserved IDs、unknown Profiles and unsupported decoration sets produce
  persistent blockers; they are never copied into runtime style or an installable manifest.

## Automated Evidence

- `@ling-stack/ui-react` package suite: `36/36`.
- Focused real-browser presentation/compiler E2E: `1/1`.
- Target Web regression: `63/63`.
- Desktop Computer Use PiP renderer after Vite rebuild: `23/23`.
- Web typecheck、i18n audit、lint and Desktop typecheck passed.
- New production files are all below `200` lines; no file exceeds the `500` line compiler target.

## Remaining Scope

- P2B.1 is a foundation slice, not complete generated-theme product delivery.
- Actual image bytes、decode/preload、crossfade、staging/checksum publish and rollback adapters are not
  implemented. The current screenshots therefore prove token/Profile policy and route behavior, not a
  wallpaper-filled immersive final design.
- `data-ui-surface-recipe` has no full visual layer until AppShell/Sidebar/Conversation migration replaces
  remaining legacy aliases and hardcoded colors.
- ThemePicker、draft storage、Quick upload flow、Generate/Advanced provider adapters、candidate preview and
  install UI remain assigned to U7A/U7B.
- Windows high contrast/DPI and signed Desktop package evidence remain open.
