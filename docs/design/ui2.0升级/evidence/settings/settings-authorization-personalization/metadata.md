# P7A.3 Default Authorization And Personalization Evidence

## Capture Context

- Date: `2026-07-20`
- Branch: `codex/ui2-desktop-coverage-foundation`
- Base HEAD: `0a0b8050`
- Working tree: dirty; Desktop/Computer Use and UI 2.0 work remain intentionally preserved together
- Served artifact: Playwright-managed real Vite development server at `http://127.0.0.1:4174`, not `dist`
- Browser: Playwright Chromium
- Data source: deterministic `mockDaemon` fixtures for workspace settings, effective config and Skill governance
- Locale: `en-US`

Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- \
  ui2-settings-authorization-personalization.spec.ts
```

## Screenshots

| File | Viewport | Theme Pack | State |
|---|---|---|---|
| `1440x960-ling-light-default-authorization.png` | `1440x960` | `ling-light` | Two reachable authorization decisions, shared DataRow and SegmentedControl |
| `1280x800-ling-dark-default-authorization.png` | `1280x800` | `ling-dark` | Keyboard selection, reduced motion and compact geometry |
| `1440x960-ling-light-personalization-advanced.png` | `1440x960` | `ling-light` | Tone saved, governance dirty/save lifecycle and Advanced governance open |
| `1280x800-ling-dark-personalization-loading.png` | `1280x800` | `ling-dark` | Effective config delayed; stable shared Skeleton geometry |
| `1280x800-ling-dark-personalization-save-error.png` | `1280x800` | `ling-dark` | Tone save failure, rollback and persistent InlineFeedback |
| `1280x800-ling-dark-personalization-unsupported.png` | `1280x800` | `ling-dark` | Unsupported governance capability, disabled controls and repair guidance |

SHA-256:

```text
dfc5c27a78964518a2a9ae3c061f8cf1cacf8368c23bf90f9d777f3690720524  1280x800-ling-dark-default-authorization.png
b92ef9de22cc4bc62e623c32ab8a1766ca6a40b5c28f1b4a53de4772f0ff294b  1280x800-ling-dark-personalization-loading.png
b730a6cc4da292610d78372a8b512ccb93e6b6e529a5fe46d587bc3f2cf342e2  1280x800-ling-dark-personalization-save-error.png
e557319ba7776b1b5e9580739d83d766f3bcd04007fbab8f64e54d7ba72745bf  1280x800-ling-dark-personalization-unsupported.png
249ec0cfdc7b0dab5a203991cdee4908262fcc663379989399ba23d81e0fb8e5  1440x960-ling-light-default-authorization.png
1acc144318430cdb3c8523b2a662d5d732c3b6a343ec72d2b95d16180b416487  1440x960-ling-light-personalization-advanced.png
```

## Verified Behavior

- Default Authorization exposes only the two production-backed decisions: Authorization mode and Workspace access.
- Pointer and arrow-key selection preserve the existing workspace-settings values and persistence callbacks.
- Tool policy, Runner, write-path and Advanced policy candidates remain unreachable inventory and are not presented as finished UI.
- Personalization separates Conversation tone and Skill governance; response language remains owned by Interface Preferences.
- Tone and governance have independent busy, success and failure scopes. Success uses the shared Toast viewport; failures and
  unsupported daemon capability remain persistent InlineFeedback.
- Governance fields use shared Field/Select, Save is enabled only for a dirty draft, and Advanced governance is collapsed by default.
- Opening Advanced governance reveals guides, fixed guards and source/path without moving them into the default layer.
- Reduced motion computes `0s`; focus, selected state and final content remain usable.
- All six screenshots were inspected at original resolution. No document-level overflow, overlay collision, theme leakage or clipped
  control was found.

## CSS And Compatibility Cleanup

- Added focused `settings-default-authorization.css` at 48 lines and `settings-personalization.css` at 258 lines.
- `settings.css`: `2,899 -> 2,656` lines; `select-controls.css`: `182 -> 10` lines.
- Deleted the single-use `RichChoiceSelect` component, barrel export and `.rich-choice-*` selector family.
- Focused CSS contains no color literal, `!important`, Theme/Profile selector, `transition: all` or private keyframe.
- Shared primitive transition/focus ownership is no longer overridden by the global `base.css` transition rule; reduced motion is `0ms`.
- Existing `.settings-inline-tip` and `.settings-inline-success` remain only for unrelated Settings owners and must be removed in their
  own slices.

## Automated Evidence

- `@ling-stack/ui-react`: `40/40` tests passed.
- Focused P7A.3 browser spec: `5/5` passed.
- Settings plus form-controls isolation: `19/19` passed.
- Final selected browser regression: `33/33` passed across Settings, SettingsShell, forms, feedback/data display,
  navigation overlays and Dark Mode.
- Web typecheck, i18n (`en-US=3184`, `zh-CN=4890`), lint and `git diff --check` passed.
- UI 2.0 lint budgets at closeout: feature direct package imports `0`, Select compatibility `38/43`, legacy z-index
  `89/97`, high literal z-index `23/25`.

The first selected run exposed two `404` responses for
`GET /channels/channel_engineering/terminal-reports` after the Settings regression. The trace showed that the central mock supported
only `/terminal-reports`. The mock now supports both production routes with the same fixture filter; the isolated `19/19` and final
`33/33` runs passed. No production API or terminal-report behavior changed.

## Status Decision And Remaining Scope

- `SETTINGS-AUTH-PRESET-001` and `SETTINGS-AUTH-EFFECTIVE-001`: `verified`.
- `SETTINGS-PERSONAL-TONE-001`, `SETTINGS-PERSONAL-SKILL-001`, `SETTINGS-PERSONAL-GOVERN-001` and
  `SETTINGS-PERSONAL-SAVE-001`: `verified`.
- `SETTINGS-AUTH-TOOLS-001`, `SETTINGS-AUTH-PATHS-001`, `SETTINGS-AUTH-RUNNER-001` and
  `SETTINGS-AUTH-ADVANCED-001` remain `inventory` until a real product entry and behavior contract exist.
- P7A.4 Interface Preferences is the next executable Settings slice. First Run remains a separate pending product decision.
- `AppShell.tsx` remains above 3,000 lines and is composition-only for subsequent Settings work; `settings.css` remains architecture
  debt and must continue to decrease.
