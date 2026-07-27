# Sidebar Rail Sections Evidence

Recaptured on 2026-07-24 from the real Vite development server through Playwright Chromium on
`codex/ui2-desktop-coverage-foundation` (base `0a0b8050`). The fixture uses the production AppShell and Sidebar
components with the existing E2E daemon adapter; it is not isolated static markup.

## Evidence

| File | Viewport | State | SHA-256 |
|---|---:|---|---|
| `1440x960-ling-light-compact-dense-identities.png` | 1440x960 | Light compact rail with dense channel and teammate identities, fixed top actions and Settings footer | `ec67461cc6b48fcf57fe26f32b797e3af1bb380e8f5935c12210ec78829d40d2` |
| `1440x960-ling-light-compact-dense-previews.png` | 1440x960 | Light compact rail with all three section preview stacks and bounded overflow counters | `e68eee6e806fa8a190d9d0fdab6143ed3861f56bc84467743bdcac61da18e31c` |
| `1280x800-ling-dark-compact-1-tooltip.png` | 1280x800 | Dark compact channel identity with one portal Tooltip | `001d3ee2a3ad8712efbed6c2298cddb47675b391e0b49b507762f7aa78c3f55d` |
| `1280x800-ling-dark-compact-2-tooltip.png` | 1280x800 | Dark compact teammate identity with one portal Tooltip | `90747ef00434dce692edb4e568a2b9d9ce40d1fa19f4cff3391dafe0781a96a8` |
| `1280x800-ling-dark-compact-3-tooltip.png` | 1280x800 | Dark compact recent-conversation identity with one portal Tooltip | `1fdf9217a5c372ea48e6fda6b631405eb60ce62d7628963d1e80dc810b1d9731` |
| `1280x800-ling-light-compact-section-previews.png` | 1280x800 | Light compact rail after local section disclosure changes | `a90993e8dfc262a9358a7b25e226752c18211c7f3a85c691e6b70965c202431a` |
| `1280x800-ling-light-expanded-restored-sections.png` | 1280x800 | Expanded 240px Sidebar with the same three section states restored | `a0bd96a8fc9cd62542a7a2cd1ceb41843a3ffd6791a0b1e75c347e87816ba2a8` |
| `900x800-ling-dark-compact-boundary.png` | 900x800 | Authoritative compact state at the narrow boundary | `a3a67b5533e8542a8581ab99a0922c34c2c872a480da9113a9159d7ce14f2e1f` |
| `901x800-ling-dark-expanded-boundary.png` | 901x800 | Expanded state immediately above the boundary after rapid round trip | `92118fa1d41673b81df5418f48b3590a93534e3d60489e4306d1529204119cd6` |

Original-size review confirmed a 48px compact rail, a 240px restored Sidebar, fixed top and footer controls, three
independent section previews, one visible Tooltip portal, no action-label leakage, no incoherent overlap and no
document or Sidebar horizontal overflow.

## Verification

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- \
  ui2-sidebar-rail-sections.spec.ts \
  ui2-sidebar-foundation-layout.spec.ts \
  ui2-sidebar-controls.spec.ts \
  ui2-sidebar-list-states.spec.ts \
  ui2-sidebar-object-rows.spec.ts \
  ui2-sidebar-sections.spec.ts
```

- Focused plus existing Sidebar: `16/16`.
- App/Channel/Teammates/Channel Archive/Dark regression: `149/149`.
- `git diff --check`, Web lint, i18n, typecheck and production build passed.
- New `app/sidebar-rail-sections.css` is 396 lines and contains no color literal, `!important`, `transition: all`,
  literal z-index, Theme/Profile selector, private keyframe or package-private `.ling-ui-*` selector.
- Web CSS after the slice is `155 files / 36,988 lines`; `sidebar.css` is 192 lines.
- The production build retains the existing large-chunk warning; this slice did not increase or resolve that debt.

## Boundary

This evidence closes the Web Sidebar compact rail/section CSS ownership slice only. It does not create or close a
Function ID, does not validate packaged Electron, macOS or Windows DPI/native chrome, and does not alter AppShell
state, Sidebar business actions, Tooltip primitives, API, contracts, routing, persistence or the 900px product
breakpoint. Shared Input containment remains covered independently by T12.1/T12.1a/T12.1b; remaining raw form
controls still migrate page by page under U3/U13.
