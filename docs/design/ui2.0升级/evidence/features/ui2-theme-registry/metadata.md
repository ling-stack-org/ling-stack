# P2A Theme Registry Evidence

## Capture Context

- Date: `2026-07-18`
- Branch: `codex/ui2-desktop-coverage-foundation`
- Commit: `0a0b8050`
- Working tree: dirty; Desktop/Computer Use and UI 2.0 slices remain uncommitted
- Served artifact: real Vite Web app managed by Playwright, not `dist`
- Browser: Playwright Chromium
- Data source: deterministic `mockDaemon` fixtures plus localStorage and IndexedDB theme fixtures
- Locale: `en-US`
- Viewports: `1440x960`, `1280x800`
- Focused command: `corepack pnpm --filter @ling-stack/web exec playwright test e2e/ui2-theme-registry.spec.ts`
- Focused result: `5/5` passed

## Screenshots

| File | Viewport | Resolved theme | State |
|---|---|---|---|
| `1440x960-ling-dark-fixed-selection.png` | `1440x960` | `ling-dark` | A new fixed `ThemeSelection` wins over conflicting legacy Light storage on first and final paint |
| `1280x800-ling-dark-system-drawer.png` | `1280x800` | `ling-dark` | Follow System changes from Light to Dark while the Cua Driver Drawer remains mounted and focused |
| `1440x960-quiet-ocean-imported-theme.png` | `1440x960` | `quiet-ocean` | A validated IndexedDB Theme Pack uses the same bootstrap and final semantic token map |
| `1280x800-invalid-import-fallback.png` | `1280x800` | `ling-light` fallback | An invalid imported manifest cannot keep an unverified bootstrap-only theme active |

SHA-256:

```text
b6b91623e02bd2aeb377bd73c947f7c632936c016f0823f74ab5c6f81e371702  1280x800-invalid-import-fallback.png
33fd98f376a7ea28b4caf1f0dee581e34f959847a9de62df4f4523ebefaeeb0a  1280x800-ling-dark-system-drawer.png
d5a9e0da6752c2f594bc9936f35e0932868d7cdf87fe098316d149900921bee2  1440x960-ling-dark-fixed-selection.png
01a8a3f81082c4c3b82af3ca94df395ce93bcb3bcd1327bdfe0b99955191d5f0  1440x960-quiet-ocean-imported-theme.png
```

## Runtime Evidence

- `ling-light` and `ling-dark` are complete independent built-in manifests.
- Fixed and System selection resolve without refreshing or remounting the React tree.
- Imported manifests are revalidated after IndexedDB load; bootstrap snapshots contain only the
  allowlisted semantic variables and registered Presentation Profile ID.
- Invalid manifests, reserved `ling-*` IDs, executable CSS values, weak contrast, unknown Profiles,
  and unsafe artwork paths are rejected before apply.
- Apply and persistence run as one transaction. A localStorage failure restores the previous DOM
  attributes and variables and emits one shared warning Toast.
- Legacy daemon `system/light/dark` values remain migration input only. They can refresh while no
  explicit Theme Pack selection exists, but cannot override an explicit new `ThemeSelection`.
- Desktop receives the full validated variable map through `DesktopThemeBridge`; the main process
  validates, revisions, deduplicates, and broadcasts it to PiP. PiP ignores stale revisions and does
  not reacquire display media when only the theme changes.

## Automated Evidence

- `@ling-stack/ui-react` package suite: `28/28`.
- Theme Registry focused Web E2E: `5/5`.
- Web P2A, Dark Mode, and Desktop bridge target set: `27/27`.
- Supplemental AppShell, Settings, Dialog, and Feedback regression: `39/39`.
- Desktop renderer theme store and IPC: `6/6`.
- Desktop Computer Use PiP renderer: `23/23`.
- Web typecheck, i18n audit, lint, Desktop typecheck, and Desktop production build passed.
- Focused browser runs reported no unexpected page or console errors.

## Remaining Scope

- P2A is `implemented`, not full-product `verified`. The current images prove Web runtime behavior
  and representative viewports, not Windows high contrast/DPI or signed Desktop package behavior.
- Large legacy Feature CSS areas still consume older variables, so the imported fixture's visual
  difference is intentionally subtle even though computed UI 2.0 sentinel tokens differ.
- ThemePicker, `.ling-theme` file packaging/import UI, Presentation Profile rendering, artwork
  preload/crossfade, Theme Compiler, and Quick/Generate/Advanced Theme Studio belong to later slices.
