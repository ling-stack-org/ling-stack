# P7A.4 Interface Preferences Implementation Plan

Status: `verified` for the currently reachable Web surface on 2026-07-20. Desktop renderer integration remains
`implemented` pending packaged macOS and Windows restart-persistence evidence. Slice owner: P7A.4.

## Scope

只迁移当前生产可达的 Interface Preferences：

- `SETTINGS-INTERFACE-THEME-001`：Follow System 与已注册 Theme Pack 选择。
- `SETTINGS-INTERFACE-LOCALE-001`：产品语言。
- `SETTINGS-INTERFACE-RESPONSE-001`：workspace AI response language。
- `SETTINGS-INTERFACE-CUA-PREVIEW-001`：Desktop-only Computer Use PiP auto-show preference 的页面归属与验证。

以下能力不进入 P7A.4：

- `SETTINGS-INTERFACE-DENSITY-001`：当前没有真实 density capability，保持 `inventory` 和 absent。
- `SETTINGS-INTERFACE-THEME-IMPORT-001`：归 P7C.1。
- `SETTINGS-INTERFACE-THEME-CREATE-001`：归 P7C.2。

不修改 ThemeRegistry、ThemeSelection、bootstrap storage、workspace settings API、locale/response values、
Desktop capability contract、数据库、Settings IA 或 Logo。

## Current Audit

- `PersonalInterfaceSettingsPanel.tsx` 当前约 80 行，仍使用 `.panel`、重复页面 H2、卡片式 preference rows、
  legacy `ThemeSwitcher`、legacy `LanguageSwitcher` 与 `SelectControl` compatibility facade。
- `ThemeSwitcher` 把 System/Light/Dark 当成同类三段选项，与独立 Theme Pack 模型冲突；ThemeProvider 已经提供
  `selection`、`resolved`、`themes`、`setFixedTheme` 和 `setFollowSystem`，无需重写 runtime。
- `LanguageSwitcher` 只有本页一个调用方；产品 locale 由 `useWorkspaceSettingsController` 观察并写回 workspace，
  不能在页面再建第二套 persistence。
- Response language 已有真实 workspace callback，但 callback 不暴露 row-level saving/error；不能伪造 spinner、
  success 或 rollback。
- `DesktopComputerUsePreference.tsx` 已使用 shared Switch/InlineFeedback，保留 initial load、optimistic change、
  rejected rollback、session-only warning 和 Web hidden 语义。
- `.interface-preference-*` 仍在 `settings.css`；`.theme-switcher/.language-switcher` 分散于
  `base.css`、`components.css` 和 `layout.css`。

## Target Structure

```text
Interface Preferences
  Appearance
    Follow system                                    Switch
      Ling Light for light appearance, Ling Dark for dark
    Current theme                                    resolved theme name
    ThemePicker
      ThemeOption ...                                registered themes

  Language
    Product language                                 Select
    AI response language                             Select

  Desktop                                            capability gated
    Computer Use picture-in-picture                  Switch
    persistent warning/error                         InlineFeedback
```

- SettingsShell owns overall page identity. The surface contains no `.panel`, duplicate `Interface preferences` H2 or source-label
  explanation wall.
- System is a strategy Switch, never a ThemeOption. ThemePicker selection always applies a fixed Theme Pack.
- ThemePicker lists all registered themes so a previously installed pack remains understandable/selectable; P7A.4 does not add import,
  delete, reimport, preview or create actions.
- Theme options show real semantic token swatches, name, color scheme and local source only when needed. Raw ID/schema/path/checksum stay
  absent.
- Product and response language are independent shared Field/Select controls and apply immediately without a Save button.
- Desktop section is absent on Web. Only the Desktop Switch enters loading; persistent warning/error stays adjacent to its row.

## Shared Component Boundary

Add a domain-neutral ThemePicker presentation primitive to `@ling-stack/ui-react`:

```ts
interface ThemePickerOption {
  id: string;
  name: string;
  accessibleLabel: string;
  colorSchemeLabel: string;
  sourceLabel?: string;
  disabled?: boolean;
  disabledReason?: ReactNode;
  swatch: ThemePickerSwatch;
}

interface ThemePickerProps {
  aria-label: string;
  options: readonly ThemePickerOption[];
  selectedThemeId?: string;
  applyingThemeId?: string;
  onThemeSelect(themeId: string): void;
}
```

- Package owns radio-group semantics, roving focus, selected/applying/disabled state, real token swatch geometry and reduced motion.
- Package does not import ThemeRegistry state, Web i18n, storage, API Client, Core, routes or Desktop capabilities.
- Web adapter maps `RegisteredTheme` to translated ThemePicker options and owns async `setFixedTheme`/`setFollowSystem` calls.
- No Feature CSS selects package-private child classes. Feature CSS may style its own wrapper/root classes only.

## Module Boundaries

- `packages/ui-react/src/theme-picker/ThemePicker.tsx`：controlled ThemePicker/ThemeOption presentation and semantics.
- `packages/ui-react/src/styles/theme/theme-picker.css`：stable two-column option geometry and token swatch.
- `packages/ui-react/test/primitives.test.mjs` / `styles.test.mjs`：package contract and CSS guard.
- `InterfaceThemeSettings.tsx`：Web adapter for ThemeProvider state, translated labels and local applying state.
- `PersonalInterfaceSettingsPanel.tsx`：section composition and language fields only; no API/storage logic.
- `DesktopComputerUsePreference.tsx`：existing Desktop state owner; migrate wrapper to DataRow without moving the Promise lifecycle.
- `settings-interface-preferences.css`：Appearance/Language/Desktop section layout and desktop viewport containment.
- `theme.tsx` / `i18n.tsx`：remove single-use legacy visual controls after migration; retain providers/runtime functions.
- `ui2-settings-interface-preferences.spec.ts`：reachable states, screenshot, console and overflow owner.

All new/expanded production files remain below 400 lines. `AppShell.tsx` stays composition-only and receives no new state.

## Implementation Order

1. Split coarse Interface Preferences coverage into reachable and future Function IDs.
2. Add package ThemePicker contract, CSS and package tests.
3. Add `InterfaceThemeSettings` adapter using the existing ThemeProvider runtime.
4. Migrate product locale and response language to shared Field/Select; delete the single-use visual switchers.
5. Migrate Desktop preference wrapper to DataRow while preserving its current async state machine.
6. Move all current Interface layout selectors into `settings-interface-preferences.css`; delete migrated legacy selectors from
   `settings.css`, `base.css`, `components.css` and `layout.css` only when references reach zero.
7. Add focused E2E before expanding old specs; update old selectors/assertions only to the new public contract.
8. Run package/static/focused/selected regression and real Vite evidence, then write metadata and migration matrices.

## State Matrix

| State | Trigger | Required result |
|---|---|---|
| system light/dark | Follow System on + OS appearance changes | resolved option and current name update; focus and page node stay mounted |
| fixed selection | click/keyboard a ThemeOption | local applying only; target applies atomically; selection becomes fixed |
| fixed under OS change | select fixed Theme Pack then change OS | selected theme stays fixed |
| storage failure | selection persistence throws | previous theme restored; one global Toast plus persistent section feedback |
| imported registered pack | fixture already in registry | normal selectable option with local source; no import/delete controls |
| invalid/unready option | package fixture | disabled, named reason, never selected |
| product locale | choose zh-CN/en-US | document language and product copy update without remount |
| response language | choose follow-user/zh-CN/en-US | existing callback receives exact value; no fake busy/success state |
| Web | no Desktop capability | no Desktop section, heading or disabled placeholder |
| Desktop loading | capability initial read pending | only auto-show Switch busy; other fields usable |
| Desktop rejected | setAutoShow rejects/throws | Switch rolls back; persistent danger feedback |
| Desktop session-only | accepted but not persisted | new value stays; persistent warning explains restart risk |
| long/localized | Chinese/English + long theme name | no option/field/document overflow at both desktop viewports |
| reduced motion | OS preference enabled | ThemeOption/Switch/Field transition duration is zero; state still changes |

## Feedback Contract

- Successful Theme/locale/response selection is represented by selected state and stays silent.
- Theme storage failure continues to use the global `theme:storage` Toast and adds section InlineFeedback until a successful apply.
- Response language exposes no truthful local failure state; existing AppShell error owner remains authoritative.
- Desktop rejected/session-only states remain row-scoped InlineFeedback; successful persistence is silent.
- No Feature timer, local Toast viewport or page-level success banner.

## Tests

- package: ThemePicker semantic selection, applying, disabled reason, token swatch and reduced-motion CSS.
- focused: `ui2-settings-interface-preferences.spec.ts`.
- regression: `settings.spec.ts`, `ui2-settings-shell.spec.ts`, `ui2-form-controls.spec.ts`,
  `ui2-theme-registry.spec.ts`, `dark-mode.spec.ts`, `desktop-computer-use-bridge.spec.ts`.
- screenshots:
  - `1440x960 ling-light` System + product/response fields;
  - `1280x800 ling-dark` fixed theme + long/localized geometry;
  - `1280x800 ling-dark` Desktop initial loading/session-only warning;
  - `1280x800 ling-light` Web capability absent or storage rollback.

## Exit Gate

- Interface surface contains no `.panel`, duplicate page H2, legacy ThemeSwitcher/LanguageSwitcher or card-style preference row.
- System is a Switch and Ling Light/Dark are independent ThemeOptions.
- ThemePicker uses real manifest tokens and preserves imported registered themes without exposing P7C actions.
- All current controls use shared primitives and retain existing API/runtime semantics.
- `settings.css`, `base.css`, `components.css` and `layout.css` only decrease for migrated owners.
- Focused CSS has zero color literals, `!important`, Theme/Profile selectors, `transition: all`, private keyframes and package-private
  selector overrides.
- Package/static/focused/selected E2E, original-resolution screenshots, console, overflow and metadata pass before reachable IDs become
  `verified`.

## Hard Stops

- Do not add Theme import, deletion, reimport, preview or Theme Studio actions.
- Do not add a density control without a real capability.
- Do not change ThemeRegistry, Theme Compiler, System mapping, daemon contracts or workspace setting values.
- Do not duplicate Desktop preference state or move it into AppShell.
- Do not claim native macOS/Windows restart persistence from browser-injected Desktop evidence.

## Closeout

- Added domain-neutral ThemePicker with semantic token swatches, radio-group behavior, selected/active/applying/
  disabled states, accessible applying state and reduced-motion coverage.
- Migrated Follow System to shared Switch; Ling Light/Dark and all ready registered packs now use ThemePicker.
- Migrated Product language and AI response language to shared Field/Select without changing existing callbacks.
- Preserved Desktop CUA initial load, rejected rollback and session-only warning state machine inside its focused owner.
- Removed the single-use ThemeSwitcher/LanguageSwitcher UI and their legacy selector families.
- Focused E2E passed `5/5`; selected Settings/Theme/Dark/Desktop regression passed `51/51`; shared package passed
  `41/41`. Typecheck, i18n, lint and diff check passed.
- Five original-resolution screenshots and state metadata are recorded in
  `evidence/settings/interface-preferences/metadata.md`.
- Theme, Product locale and Response language Function IDs are `verified`. CUA stays `implemented`; Density stays
  `inventory`; Import/Create remain P7C `designed` work.
