# P7A.4 Interface Preferences Evidence

Captured and verified on 2026-07-20 from the real Playwright-managed Vite server at
`http://127.0.0.1:4174/`.

## Source And Scope

- Branch: `codex/ui2-desktop-coverage-foundation`
- Base HEAD: `0a0b80502715d0333342422e6dc8cedd2cd77b14`
- Focused owner: `apps/web/e2e/ui2-settings-interface-preferences.spec.ts`
- Web implementation owners: `InterfaceThemeSettings.tsx`, `PersonalInterfaceSettingsPanel.tsx`,
  `DesktopComputerUsePreference.tsx`, `settings-interface-preferences.css`
- Shared owner: `@ling-stack/ui-react` `ThemePicker`, `Switch`, `Field`, `Select`, `DataRow` and
  `InlineFeedback`
- Browser: Playwright Chromium, one isolated context per test
- Mobile is not an acceptance target.

The Desktop screenshots use the typed `window.lingDesktop.computerUse` renderer capability injected before
application bootstrap. They verify the Web/Desktop renderer boundary only. They do not claim packaged macOS or
Windows restart persistence.

## Screenshot Matrix

| File | Viewport | Theme / locale | Client fixture | Reachable state | SHA-256 |
|---|---|---|---|---|---|
| `1440x960-ling-light-system.png` | 1440x960 | System -> `ling-light`, en-US | Web | Follow System, two built-in packs, product/response fields, Desktop absent | `9c9856ee8ac54a68bde6bd9210e073b8f2b0cbadbbe0551bda960aed6f327657` |
| `1280x800-ling-dark-system-zh-CN.png` | 1280x800 | System -> `ling-dark`, zh-CN | Web | OS change, localized labels/values, compact geometry | `cec421d3479645ac90839902b2c15357bdd210a283e46ac4349574162bfd658c` |
| `1280x800-local-theme-long-name.png` | 1280x800 | fixed local dark pack, en-US | Web + IndexedDB manifest | registered local pack, long valid name, source label, P7C actions absent | `e5a84248bb75ac34abdbec2b7ecaa47208a2f1afd6cdd4f8f9cf38fdec1bd29d` |
| `1280x800-ling-light-storage-rollback.png` | 1280x800 | fixed `ling-light`, en-US | Web + failing Storage | atomic rollback, one global warning Toast, one section InlineFeedback | `915bf3549f782b5867f0a164424eea5d76d4c84f8d20deec3d46be4ff6a8caa8` |
| `1280x800-ling-dark-desktop-rejected.png` | 1280x800 | fixed `ling-dark`, en-US | browser-injected macOS capability | scoped loading, session-only warning, rejected write rollback and row alert | `a7953618f66b514c9e46aaa2ac375ed4b56b762885d547d36b4f2adb341d5a49` |

All PNG files were checked at original resolution. The Settings content, theme options, long names, selects,
Toast, InlineFeedback and Desktop row remain within their owners without document-level horizontal overflow.
The five captured changed states produced no browser console errors or page errors.

## Interaction Evidence

- System is a Switch strategy, not a theme option.
- Turning System off fixes the currently resolved Theme Pack; later OS appearance changes do not replace it.
- Theme radio focus moves with Arrow keys and Space applies the focused option without remounting Settings.
- Turning System back on resumes OS Light/Dark mapping.
- Product locale changes `document.lang`, visible product copy and the existing workspace setting.
- AI response language sends the existing exact workspace value without fake saving or success UI.
- A valid registered local Theme Pack remains selectable, while import/delete/create controls stay absent until P7C.
- Storage failure restores the old root attributes, tokens and selected radio before reporting feedback.
- Web does not render a Desktop heading, disabled placeholder or explanation.
- Desktop initial loading disables only its Switch. Read failure, rejected write and session-only persistence remain
  row-scoped; successful persistence stays silent.
- `prefers-reduced-motion: reduce` computes zero-duration ThemeOption and Switch transitions.

## Verification

```text
@ling-stack/ui-react test                                      41/41
ui2-settings-interface-preferences.spec.ts                     5/5
selected Settings/Theme/Dark/Desktop regression               51/51
focused plus selected browser checks                          56/56
Web typecheck                                                  passed
Web check:i18n                                                 passed (en-US=3197, zh-CN=4903)
Web lint                                                       passed
git diff --check                                               passed
```

Lint checkpoint:

```text
Feature direct package imports                                  0
SelectControl compatibility                                  37/43
legacy z-index budget                                        89/97
high literal z-index budget                                  23/25
```

## Status Decision

- `SETTINGS-INTERFACE-THEME-001`: `verified`
- `SETTINGS-INTERFACE-LOCALE-001`: `verified`
- `SETTINGS-INTERFACE-RESPONSE-001`: `verified`
- `SETTINGS-INTERFACE-CUA-PREVIEW-001`: remains `implemented` until packaged macOS and Windows restart
  persistence evidence exists.
- `SETTINGS-INTERFACE-DENSITY-001`: remains `inventory` and absent.
- At this P7A.4 capture, Theme import and Theme Studio IDs remained `designed`. P7C.1 Web import is now
  verified by `evidence/settings/theme-packages/metadata.md`; Theme Studio remains P7C.2.

P7A.4 is closed for the currently reachable Web surface. The next executable slice is P7A.5 External Work.
