# UI Form Foundation Evidence

Recaptured on 2026-07-27 after T12.1d aggregate input-owner release from the real Vite development server through Playwright Chromium on
`codex/ui2-desktop-coverage-foundation` (base `0a0b8050`). The fixture uses the normal Web app with
the existing E2E daemon adapter; it does not render isolated static markup.

## Evidence

- `1440x960-ling-light-personalization.png`：Skill policy Field/Select labels、descriptions、36px
  native control height、focused inset ring and two-column layout。SHA-256：
  `0b11f2eb688b7e8b705516fab7649e61b9c96c603bdc470ae7bc10fb3fd8e890`。
- `1280x800-ling-dark-external-work.png`：External Work Select/Input/password、disabled action、
  warning/error states、focused inset ring and compact dark layout。SHA-256：
  `498abf034251c16c4600affca51d30a9e111c58e1d5222e5e9e1bf97e7b57116`。
- `1280x800-ling-dark-channel-nested-search-focus.png`：Channel Activity nested search focus；34px shell、
  native top/bottom containment、zero internal border/outline/shadow。SHA-256：
  `2524d9e0213430559d0f4663e64b441b7d84d3d843a8965014d0c2b5cf8113a7`。

## Reproduction

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- ui2-form-controls.spec.ts
```

The `4/4` spec asserts stable label/description IDs、Input/Select focus geometry、zero native focus border/shadow、
native containment、shell inset focus shadow、disabled state、horizontal overflow and zero browser console/page
errors。A real Channel Create raw Input also proves stable height、zero outer outline and inset focus treatment during
migration。T12.1b additionally locks the Activity/Work Thread shared nested-search selector after the final strict
cascade; MCP `2/2` verifies its corresponding focused owner. The shared
Input、Textarea、Select and Checkbox package contracts also assert the common native-control compatibility
marker。Screenshots disable CSS animation before capture。

## Boundary

This proves Chromium Web rendering at the two required desktop viewports。It does not replace
Electron native-window、Windows font/DPI、forced-colors or assistive-technology evidence。
It also does not claim that all remaining raw inputs have migrated to `@ling-stack/ui-react`。
