# Desktop 多窗口渲染器与主题同步

## Goal

定义 Desktop 主窗口和独立 utility renderer 如何共享 UI 2.0 primitives、Theme Pack、语言和
可访问性，同时保持 Electron/IPC、媒体和业务状态在应用适配层。

## Renderer Model

```text
Desktop main BrowserWindow
  -> built apps/web UI
  -> @ling-stack/ui-react
  -> shared feature pages

Computer Use PiP BrowserWindow
  -> isolated React renderer
  -> @ling-stack/ui-react compact-window primitives
  -> Desktop adapter view model/callbacks
```

- Main window never copies Web pages。
- PiP never imports Web AppShell、router、feature domains or daemon client。
- Both renderers use the same package CSS and Theme Pack token contract。
- Electron APIs remain behind context-isolated preload capabilities。

## Package Boundary

```text
@ling-stack/ui-react
  controls / overlays / feedback / compact-window / theme

apps/desktop/renderer/computer-use-preview
  controller / media / adapter / local catalog / React composition
```

`ui-react` cannot import Electron、Desktop capability types、Computer Use contracts or MediaStream
controllers。Desktop maps domain view models into presentation props。

## PiP React Migration

The current imperative renderer is split without changing media behavior：

1. extract acquisition/release/frame readiness into `preview-media-controller.ts`；
2. extract snapshot/transient state orchestration into `preview-controller.ts`；
3. keep `preview-view-model.ts` pure；
4. mount one React root with `ComputerUsePreviewApp`；
5. import shared UI 2.0 CSS and focused PiP layout CSS；
6. retain exact release ACK、identity and late-stream cleanup tests。

The migration must not replace tested media lifecycle with React effects spread across components。

## Theme Snapshot

Desktop settings adapter is the authority。Each renderer receives a validated client-safe snapshot：

```ts
export interface DesktopRendererThemeSnapshot {
  readonly revision: number;
  readonly themeId: string;
  readonly colorScheme: "light" | "dark";
  readonly presentationProfileId: string;
  readonly variables: Readonly<Partial<Record<LingAllowedThemeVariable, string>>>;
}
```

- preload exposes `getThemeSnapshot()` and `onThemeSnapshotChanged()`；
- snapshots contain no file paths、artwork bytes、CSS text or unknown variables；
- main and PiP apply a revision atomically and ignore stale revisions；
- PiP only consumes compact-window aliases and status tokens；
- Theme change does not recreate BrowserWindow、React root or MediaStream；
- missing snapshot falls back to built-in tokens selected by colorScheme。

## Native Theme Pack Repository TODO

P7C.1 verifies Web IndexedDB only. `DESKTOP-THEME-PACK-PERSISTENCE-001` remains `inventory` and will own:

- `appData/themes/<themeId>/` with canonical relative paths and current-user permissions；
- same-volume random staging、main-process revalidation and atomic rename/swap；
- typed main/preload list/read/install/reimport/delete capabilities without renderer-selected destinations；
- cleanup and rollback after write、rename、permission、corruption or interrupted publication；
- packaged restart restoration and first-frame alignment；
- real macOS and Windows install/reimport/delete/restart evidence。

Web IndexedDB、browser capability fixtures、Theme snapshot revision tests and PiP screenshots are not
native repository evidence and cannot change this item from `inventory`。

## Locale Snapshot

- Main Web renderer uses normal i18n provider。
- PiP receives normalized `en-US` / `zh-CN` locale through the sanitized renderer snapshot or a
  dedicated locale revision。
- Locale change updates title、status、actions and ARIA without media reacquisition。
- Desktop-only catalog keys must map to the same product terminology as Web。

## CSS Loading

PiP final order：

```ts
import "@ling-stack/ui-react/styles.css";
import "./styles/index.css";
```

Focused PiP CSS owns only window/media layout、drag regions and compact positioning。Button、Menu、
Spinner、status colors、focus and motion come from `ui-react`。

## Capability Adapter

The shared Web main window receives `LingDesktopCapabilities` through preload。Web code：

- checks capability presence；
- maps summary/commands into `CurrentSessionCapabilityControl`；
- reports normalized host/obstacle geometry；
- never imports IPC channel strings or Electron。

PiP preload exposes narrow commands and snapshot subscription。React components receive callbacks，not
the preload object itself。

## Window And Portal Rules

- PiP Menu/Tooltip portals stay inside the PiP renderer document；
- Toast is not used for PiP state，because the status overlay is the persistent object owner；
- Dialog is avoided in the `320x200` utility window；danger Stop remains a menu action and failed Stop
  exposes a single retry action；
- OS permission Settings opens externally after explicit user action。

## Failure Isolation

- PiP renderer crash can recreate the renderer without changing main Web state；
- main Web renderer reload does not stop Computer Use or orphan PiP；
- stale theme/locale/command results are revision/session checked；
- Theme apply failure restores prior PiP variables and does not release media；
- component render failure destroys/recreates the exact PiP renderer according to existing coordinator policy。

## Module Size Guardrails

- PiP `main.ts` target `<150` lines；
- media controller target `<500` lines；
- state controller target `<400` lines；
- each React component target `<250` lines；
- focused CSS file target `<300` lines；
- `apps/desktop/main/main.ts` and `computer-use/coordinator.ts` receive no new visual logic。

## Tests

- shared primitive fixtures for compact-window components；
- PiP React renderer DOM/keyboard/media tests；
- theme/locale revision change without BrowserWindow or MediaStream recreation；
- main renderer reload while PiP stays active；
- PiP renderer crash while main renderer stays active；
- package boundary guard rejects Electron import in `ui-react` and Web feature code。

## Acceptance

- all Desktop renderers share Theme Pack and primitive contracts without sharing business state stores；
- PiP presentation can be redesigned without touching capture/coordinator/daemon authority；
- theme and locale update atomically without visual flash or media reacquisition；
- no second AppShell、router、Settings tree or feature CSS exists under `apps/desktop`；
- oversized current files are split before adding UI 2.0 visual behavior。
