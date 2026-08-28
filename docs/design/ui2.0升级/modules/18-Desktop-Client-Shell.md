# Desktop Client Shell

## Goal

定义 Electron Desktop 主窗口、启动恢复、窗口 chrome、主题首帧和 OS-owned surface 的
UI 2.0 合同。Desktop 复用同一份 Web 应用，不建立第二套页面树、导航、设置或业务状态。

Related docs:

- [Desktop Shell](../../desktop-shell.md)
- [Web 与 Desktop 表面规范](../foundations/05-Web与Desktop表面规范.md)
- [Desktop 多窗口渲染器与主题同步](../architecture/07-主题注册表与运行时切换.md)
- [Desktop 与 Computer Use PiP 迁移矩阵](../migration/README.md)

## Function IDs

```text
DESKTOP-SHELL-STARTUP-001      Desktop startup and daemon readiness
DESKTOP-SHELL-STARTUP-FAILURE-001 Owned daemon startup failure recovery
DESKTOP-SHELL-MAIN-WINDOW-001 Main BrowserWindow and shared Web UI
DESKTOP-SHELL-RECOVERY-001     Incompatible daemon Retry/Quit dialog
DESKTOP-SHELL-THEME-001        First-paint Theme Pack and Profile sync
DESKTOP-SHELL-WINDOW-001       macOS/Windows chrome and resize behavior
DESKTOP-SHELL-MAIN-WINDOW-DRAG-001 Integrated macOS main-window drag contract
DESKTOP-SHELL-EXTERNAL-001     External links, file picker and OS surfaces
DESKTOP-CUA-NAVIGATION-001     PiP Open task handoff to owner conversation
DESKTOP-CUA-HOST-LAYOUT-001    Main-window obstacle reporting for PiP placement
```

## Current Implementation

Primary owners:

```text
apps/desktop/main/main.ts
apps/desktop/main/window-factory.ts
apps/desktop/main/daemon-lifecycle.ts
apps/desktop/main/daemon-startup-recovery.ts
apps/desktop/main/startup-failure-recovery.ts
apps/desktop/main/resource-startup-recovery.ts
apps/desktop/main/daemon-recovery-dialogs.ts
apps/desktop/main/resource-paths.ts
apps/desktop/preload/main-window.ts
apps/desktop/shared/desktop-capabilities.ts
apps/web/src/app/DesktopWindowChrome.tsx
apps/web/src/app/AppShell.tsx
apps/web/src/app/DesktopComputerUseBridge.tsx
apps/web/src/styles/app/macos-titlebar.css
```

Current main window:

- default `1440x920`；minimum `980x680`；
- macOS `hiddenInset` title bar，Windows default chrome；
- loads the built shared Web UI；
- starts or reuses one compatible loopback daemon；
- uses a native warning Dialog for incompatible daemon recovery；
- uses a separate native error recovery for child exit、timeout、missing resources and spawn failure；
- exposes a narrow preload capability bridge；
- blocks renderer navigation and opens approved HTTP(S) links externally。

The pre-implementation `hiddenInset` BrowserWindow was correct, but its renderer drag contract covered only
the expanded Sidebar top area and three Feature Header class selectors。`DESKTOP-SHELL-MAIN-WINDOW-DRAG-001`
closes that gap with shared Header markers、Home/Sidebar fallback regions、a traffic-light exclusion and portal
overlay subtraction，without changing BrowserWindow options or adding visible chrome。Detailed ownership、
geometry and tests are defined below。

## Ownership

Desktop main process owns：

- BrowserWindow lifecycle and window chrome；
- daemon startup/reuse/restart and native recovery prompt；
- OS file picker、permission settings、notifications、future tray/updater/keychain adapters；
- first-frame client bootstrap injection；
- Desktop-only utility windows。

Shared Web UI owns：

- ViewId、SettingsSectionId、navigation and all feature pages；
- conversation、Settings、model、plugin、media and approval surfaces；
- Ling UI primitives and product copy after the main window opens。

Desktop must not copy AppShell、Settings、conversation or feature JSX into `apps/desktop`。

## Startup Flow

```text
launch Desktop
  -> resolve app data and bundled resources
  -> read validated ThemeSelection/Profile bootstrap
  -> probe loopback daemon
  -> reuse compatible daemon or start Desktop-owned daemon
  -> incompatible external daemon: native Retry/Quit
  -> daemon ready
  -> create main BrowserWindow
  -> load shared Web build
  -> show on ready-to-show
```

- Main window does not appear as an empty black/white frame while daemon startup is unresolved。
- Startup status belongs to the OS launch phase；do not show a fake Web loading dashboard before
  the shared app can function。
- Desktop-owned daemon timeout/exit must fail closed and leave diagnostics in logs；UI 2.0 uses the
  typed startup-failure recovery below rather than an indefinite spinner or silent process exit。
- Retry reruns the compatibility probe；Quit exits without terminating a daemon Desktop does not own。

## Native Recovery Dialog

The incompatible-daemon prompt remains an Electron/OS Dialog, not a custom Web modal：

```text
Title: Ling local service needs an update
Message: another local daemon is incompatible
Detail: preserve active work, stop/update it, then retry
Primary: Retry
Secondary: Quit
```

Rules：

- native language follows the OS locale allowlist，currently `zh-CN` / fallback English；
- Retry is default，Quit is cancel；Esc maps to Quit；
- do not expose bridge token、raw process args or secret paths；
- base URL may appear only as a diagnostic location in detail；
- macOS and Windows use native control order and focus behavior；
- native Dialog is exempt from Ling radius/color tokens but must follow product copy semantics。

### Owned Daemon Startup Failure

`child_exited`、`start_timeout`、bundled resource missing 和 spawn failure 不得套用
`bridge_incompatible` 文案，也不得暗示另一个 daemon 正在占用端口。

```text
Title: Ling local service could not start
Message: Ling cannot open the workspace yet
Detail: product reason + diagnostic location, without token/process args
Primary: Retry
Secondary: Open diagnostics
Cancel: Quit
```

- Retry 创建新的 startup generation；旧 child、timer 或 probe 结果不能完成新请求。
- Open diagnostics 只打开本地日志目录或批准的诊断页面，不把 raw log 填进 Dialog。
- child 连续退出时仍允许 Retry，但相同失败不堆叠多个 native Dialog。
- Quit 先等待 Desktop-owned resources 清理；不能停止非 Desktop-owned compatible daemon。
- macOS/Windows 使用平台原生按钮顺序，文案和结果语义一致。
- 当前四类 failure 已接入同一 typed recovery loop；resource resolution 与 daemon lifecycle 各自
  保持独立 owner，`main.ts` 只接线。Node 自动化通过后状态为 `implemented`；仍需 macOS/Windows
  真实原生 Dialog、键盘、诊断目录和安装损坏场景证据，才能标记 `verified`。

## Open Task Navigation

- PiP `Open task` 发送带递增 request id 的 intent；主窗口只接受最新 intent。
- intent 在 renderer ACK 和目标会话 selection 都完成后才清除，两者允许任意顺序到达。
- Settings、AI 队友页、空白 Home 或隐藏主窗口都必须能回到 owner conversation。
- 主窗口被关闭时先重建并等待 ready，再投递 intent；重建失败时 PiP 保持可用并显示可重试结果。
- 陈旧 intent、空 conversation id、目标不存在、workspace authority 未就绪和 renderer reload 都
  fail safe，不得打开错误会话。
- 成功导航后主窗口 show/focus；PiP 是否隐藏继续由独立 preference 和 Hide action 决定。

## Host Obstacle Reporting

- Main Web 只上报 geometry 和 allowlisted kind：composer、approval、dock、terminal、modal、popover。
- Dialog 自动标记只在 `role=dialog` 且 `aria-modal=true` 生命周期内有效，卸载或身份变化时释放。
- Resize、scroll、visual viewport、Drawer/Terminal/Summary 动画和窗口移动触发合并后的下一帧上报。
- 未知 kind 归一为 `unknown` 并按 fail-safe 权重处理；上报不得携带消息、审批或路径内容。
- PiP 位置变化不能改变 Web 布局，也不能让 composer、approval 或 modal 失去焦点。

## Main Window Grammar

```text
Native Window Chrome
  Shared Web App
    LingUiProvider
    ThemeProvider
    AppShell
    Desktop capability adapters
```

- Desktop capability controls enter only through typed slots；they do not alter normal browser UI。
- macOS 使用一个真实的 `48px` 全宽 renderer titlebar row；traffic-light inset、Sidebar toggle 和
  当前 surface Header 都属于该行，应用主体不得渲染在其后方。
- Windows system title bar must not duplicate an in-app fake title bar。
- draggable behavior belongs to Desktop titlebar boundary；Feature/shared Header 通过共享 titlebar
  surface slot 选择 `window` 或 `inline` placement，并继续用 `data-desktop-window-no-drag` 标记交互控件。
  Settings 不再拥有独立 traffic-light clearance；Feature 不写平台 selector。
- window resize must preserve AppShell responsive constraints and never create horizontal page scroll。

### Main Window Integrated Chrome

- macOS main BrowserWindow 使用一条 `48px` 的真实 `DesktopWindowChrome` grid row，而不是 transparent
  overlay 或 workspace top padding。`DesktopWindowChrome` 提供 Sidebar control zone、surface slot 和
  剩余 drag region；交互后代统一 carve out 为 `no-drag`。
- 当前 surface Header 在 macOS 只挂载到 titlebar slot；页面 body 必须移除对应 inline Header row，
  不能留下重复标题或 `48px` 空白。Web/Windows 保持 inline placement。
- 不允许绝对定位的透明 sibling layer 或 Feature selector 穿过 Header controls。
- Sidebar collapsed 时保留 `48px` compact rail，不能移除 Home 或 active Header drag target。
- Sidebar 展开和收缩时，唯一导航开关都由 `DesktopWindowChrome` 的 titlebar 工具槽持有；工具槽
  位于 `76px` traffic-light exclusion 右侧 `8px`，按钮保持 `32x32` 且声明 `no-drag`。
- titlebar drag sibling 必须在按钮前结束，并在按钮后再保留 `8px` pointer gap；不得依赖控件自身
  z-index 穿透透明 drag layer。展开/收缩不得创建、卸载或移动第二个按钮。
- Sidebar collapsed 时 compact rail 的第一个行动为 `New conversation`，保持 `36x36`；rail 不重复
  `Show navigation`。Web 和 Windows 继续由 Sidebar 自身持有导航开关。
- Settings fullscreen、Media、Channel、普通对话、AI 队友私聊/设置和所有顶级 View 必须有稳定 owner。
- Settings fullscreen 位于共享 titlebar row 下方；`Back to app` 直接撑满 navigation content box，
  不得再做顶部 safe-area、横向 offset 或减宽。
- Web、Windows main window 和 PiP 不挂载该 chrome；Windows 继续 native title bar。
- Dialog、Drawer、Menu、Popover、Toast、Tooltip 和 scrim 必须始终高于 chrome 并保持 pointer/focus ownership。
- chrome 没有独立 Show/Hide/Close 行动；随 macOS AppShell mount/unmount，route/theme/Sidebar state 不重建它。

## Theme Bootstrap

- Desktop preload injects validated Theme Pack ID、colorScheme、Presentation Profile ID and
  allowlisted variables before the first visible frame。
- main window `backgroundColor` must be derived from the bootstrap fallback instead of a permanent
  hard-coded dark color；until this migration lands，the current `#0f1115` is legacy debt。
- renderer final state must equal bootstrap sentinel values；mismatch triggers atomic fallback，not a
  full page flash。
- System selection follows OS appearance；fixed selection does not。
- imported Theme Packs currently remain token-only; their isolated Preview never becomes runtime artwork。
- later generated artwork must be verified and ready before display or use token-only fallback。
- native Theme Pack install/reimport/delete/restart persistence remains
  `DESKTOP-THEME-PACK-PERSISTENCE-001` and is not closed by Web IndexedDB or renderer token sync。

## Window Size And Platform Rules

| Client | Chrome | Minimum | Default | Required behavior |
|---|---|---:|---:|---|
| macOS | hidden inset | `980x680` | `1440x920` | traffic lights clear, vibrancy fallback, Retina scale |
| Windows | native title bar | `980x680` | `1440x920` | DPI scale, no fake chrome, high contrast |

- UI font size does not scale continuously with window size；OS accessibility scaling is respected。
- `1280x800` product viewport remains a required content acceptance even when native chrome reduces
  available pixels。
- large displays add workspace room，not oversized cards or artificially tiny fixed content columns。
- changing display scale or moving between monitors must not reset active View、scroll or open overlays。

## External And OS-Owned Surfaces

- HTTP(S) links open through `shell.openExternal` after allowlist validation；renderer navigation stays denied。
- screen permission settings open the platform Settings application；Ling shows the reason and next action
  before leaving the app。
- future file picker uses the native OS picker but validation/results return to Ling Dialog/InlineFeedback。
- installer、DMG、NSIS、Gatekeeper and SmartScreen are release surfaces，not Ling primitives；their
  screenshots and accessibility still belong to release acceptance evidence。

## States

- daemon checking、starting、connected、incompatible、start timeout、child exited、resource missing、spawn failed；
- first launch、cold mounted-DMG launch、renderer reload、main window reopen；
- fixed theme、System theme、invalid bootstrap、artwork missing；
- minimum/default/large window、Retina/DPI scale、multi-display move；
- Sidebar expanded/collapsed、headerless Home、Channel/Normal/Teammate headers、Settings fullscreen、Media canvas；
- drag background、no-drag control、Dialog/Drawer/Popover occlusion、renderer reload；
- external link denied/allowed、permission settings unavailable；
- macOS reduced transparency、Windows high contrast/forced colors；
- main renderer crash and bounded recovery。

## i18n And Accessibility

- Native prompt and Desktop-only window catalogs support `en-US` and `zh-CN` with English fallback。
- Shared Web UI continues using the Web i18n provider；Desktop does not maintain duplicate feature copy。
- native Dialog uses OS screen-reader support；custom utility windows provide explicit names、live regions
  and keyboard access。
- VoiceOver、Narrator and NVDA real-host acceptance remains required before release。

## Module Boundaries

- `apps/desktop/main/main.ts` is over `1500` lines and cannot receive new UI behavior；extract lifecycle
  composition before adding more Desktop surfaces。
- native prompt copy stays in a focused helper/catalog，not inside startup orchestration。
- Theme bootstrap and PiP contracts live outside `main.ts`。
- Web feature code must not import Electron；it only consumes `window.lingDesktop` through a typed adapter。

## Tests And Evidence

- `daemon-startup-recovery.test.mjs`：Retry/Quit、foreign/incompatible daemon、四类 startup failure、
  no unauthorized kill；`resource-startup-recovery.test.mjs` 覆盖资源重试、诊断和 headless fail-closed。
- `window-factory.test` or equivalent：size、title bar、navigation denial、bootstrap background。
- `macos-titlebar.spec.ts`：Home、Conversation、Channel、Settings、Media 和代表性 shared Header
  drag marker、Sidebar expanded/collapsed、no-drag controls、收起按钮与 traffic lights 几何避让、
  compact rail 顺序、真实 Dialog/Menu overlay ownership and zero layout shift。
- packaged macOS coordinate smoke：drag 前后 `BrowserWindow` bounds 改变，no-drag action 不误移动，finally 复位。
- `app.spec.ts` / `desktop-computer-use-bridge.spec.ts`：shared Web placement and browser/Desktop parity。
- macOS screenshot：minimum/default/large，Ling Light/Dark，traffic-light clearance。
- Windows screenshot：100/125/150/200% DPI，native title bar，high contrast。
- cold start evidence records first visible frame theme and no black/white flash。

## Acceptance

- Desktop main window contains the same Web product，not a copied page tree。
- `main` BrowserWindow does not flash the wrong theme before React hydration。
- incompatible daemon prompt is understandable，safe and keyboard accessible。
- macOS/Windows platform chrome does not cover navigation or actions。
- macOS Home、collapsed Sidebar 和所有顶级 Header 都保留真实可拖区域；交互控件保持可点击/输入。
- Web/Windows 不出现 shell-owned drag DOM；Windows native title bar behavior unchanged。
- fixed/System/generated themes use the same registry contract as Web。
- no feature imports Electron or reads raw IPC channels。
- no new major behavior is appended to the existing oversized `main.ts`。
