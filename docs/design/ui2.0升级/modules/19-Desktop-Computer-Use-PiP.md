# Desktop Computer Use PiP

## Goal

统一 Desktop 主窗口中的当前会话 Computer Use 控制组，以及独立悬浮 PiP 窗口的视觉、
状态、操作、主题、键盘和跨平台行为。PiP 只是现有运行的视图，不拥有运行、审批或审计状态。

Related docs:

- [Desktop Computer Use Picture-in-Picture](../../desktop-computer-use-picture-in-picture.md)
- [Desktop Computer Use Picture-in-Picture Detailed Design](../../desktop-computer-use-picture-in-picture-detailed-design.md)
- [Compact Desktop Window 与 Capability Control](../components/06-Desktop紧凑窗口.md)
- [Desktop 多窗口渲染器与主题同步](../architecture/07-主题注册表与运行时切换.md)

## Function IDs

```text
DESKTOP-CUA-CONTROL-001       Current-session header capability control
DESKTOP-CUA-PIP-SHELL-001     Floating PiP window shell and live chrome
DESKTOP-CUA-PIP-STATUS-001    Runtime/source/command status presentation
DESKTOP-CUA-PIP-ACTIONS-001   Open, Show/Hide, menu, retry, close and Stop
DESKTOP-CUA-PIP-WINDOW-001    Resize, drag, snap, display and obstacle placement
DESKTOP-CUA-PIP-THEME-001     Theme Pack and Desktop surface synchronization
DESKTOP-CUA-PIP-A11Y-001      Keyboard, live regions and assistive technology
DESKTOP-CUA-PIP-RECOVERY-001  Permission, capture, reconnect and Stop failure
DESKTOP-CUA-NAVIGATION-001    Open task handoff and owner-window recovery
DESKTOP-CUA-HOST-LAYOUT-001   Host obstacle avoidance and relocation
```

## Current Owners

```text
apps/web/src/app/DesktopComputerUseControlSlot.tsx
apps/web/src/app/DesktopComputerUseBridge.tsx
apps/web/src/app/DesktopThemeBridge.tsx
apps/web/src/shared/current-session/CurrentSessionHeaderCapability.tsx
apps/web/src/styles/app/current-session-capability.css
apps/desktop/renderer/computer-use-preview/main.tsx
apps/desktop/renderer/computer-use-preview/ComputerUsePreviewApp.tsx
apps/desktop/renderer/computer-use-preview/preview-controller.ts
apps/desktop/renderer/computer-use-preview/preview-media-controller.ts
apps/desktop/renderer/computer-use-preview/preview-theme-controller.ts
apps/desktop/renderer/computer-use-preview/preview-view-model.ts
apps/desktop/renderer/computer-use-preview/messages.ts
apps/desktop/renderer/computer-use-preview/styles/*
apps/desktop/main/renderer-theme-store.ts
apps/desktop/main/computer-use/*
```

Migration status and remaining debt：

- PiP renderer、media/state/theme controllers and focused CSS migration are implemented；
- current-session control and PiP consume shared Button、IconButton、Menu、Spinner and status primitives；
- revisioned Theme Pack snapshot replaces PiP `prefers-color-scheme` ownership；
- macOS renderer 已实现 11 个权威状态和三种 live 尺寸；Windows DPI/high-contrast、真实 AT、
  reduced-transparency 和签名包视觉证据仍开放。

## Product Boundary

```text
daemon Computer Use projection
  -> Desktop coordinator
  -> current-session summary in shared Web header
  -> independent PiP renderer snapshot
```

- Hide/Close affect presentation only；they never stop the runtime。
- Stop is a separate danger command and succeeds only after runtime acknowledgement。
- PiP cannot invent paused、completed、failed or approval states。
- target label and status detail are sanitized projection data，not raw window titles or provider logs。

## Current-Session Header Control

The control appears only in the selected conversation that owns the active session：channel、normal
conversation or teammate direct chat。

Target structure：

```text
CurrentSessionCapabilityControl
  StatusIndicator
  Target label
  Show/Hide IconButton
  Stop IconButton
  anchored failure feedback
```

Rules：

- The control is a fixed-height capability group separate from Search/Refresh/Summary/Terminal/Details。
- Target text truncates；it cannot push core conversation tools away。
- Show uses `Eye`，Hide uses `EyeOff`，Stop uses `Square`；all are icon-only `32x32` with Tooltip/ARIA。
- pending keeps the same button width and replaces the icon with shared Spinner。
- Stop uses danger tone but no filled red background in default state。
- visibility/Stop failure opens compact anchored InlineFeedback below the capability group；it does not
  increase the header row height or widen the conversation title。
- failure remains until retry、authoritative state change or session replacement；success is silent。
- browser Web without Desktop capabilities renders an empty stable slot with no residual gap。

## PiP Window Geometry

| Size | Width | Height | Purpose |
|---|---:|---:|---|
| minimum | 320 | 200 | smallest readable preview and controls |
| default | 420 | 263 | standard working size |
| maximum | 480 | 300 | largest V1 PiP |

- aspect ratio follows the source while respecting min/max bounds。
- outer window may use a platform `12px` radius as a native utility-window exception；internal overlay、
  Menu and controls keep UI 2.0 radius `<=8px`。
- drag region is the non-interactive header background；buttons and menu are `no-drag`。
- placement avoids composer、approval、dock、terminal、modal and popover obstacle rectangles。
- Summary/Right Dock/Terminal 动画期间使用连续 geometry 更新；PiP 跟随到安全位置，不先隐藏、
  闪回默认角落或覆盖新打开 surface。
- user drag/resize persists normalized display coordinates；moving between displays clamps into work area。
- display removal、DPI change and work-area change preserve the closest safe corner。

## PiP Visual Structure

```text
CompactDesktopWindow
  CapturedContentLayer
  CompactWindowHeader
    target identity + status
    Open task / Hide / More
  CompactWindowStatusOverlay
    status + detail + recovery action
  CompactWindowActionMenu
```

- Live state is content-first：header controls fade out when neither hovered nor focused。
- Keyboard focus reveals controls without requiring pointer movement。
- Non-live and recovery states keep header/status visible persistently。
- Captured video pixels are never recolored、blurred or themed。
- fake source artwork exists only in test/smoke fixtures and is not a production empty state。

## Action Mapping

Top-level controls：

| Action | Icon | Visibility | Behavior |
|---|---|---|---|
| Open task | `ExternalLink` | always | select owner conversation, ACK after route success |
| Hide | `EyeOff` | always while window shown | hide and release media, session continues |
| More | `MoreHorizontal` | always | open keyboard-accessible action menu |

More menu：

| Action | Icon | Conditions |
|---|---|---|
| Reset position | `LocateFixed` | always |
| Screen settings | `MonitorCog` | permission/capture settings supported |
| Retry capture | `RotateCw` | settings/retry supported |
| Close window | `X` | always; destroys PiP, session continues |
| Stop Computer Use | `Square` | `canStop`; separated danger item |

- More menu uses shared Menu semantics，not a custom absolute button list。
- Stop remains in the menu to prevent accidental termination；Stop failed overlay may expose one
  explicit `Try Stop again` danger Button。
- Esc closes only the menu，never the PiP or Computer Use session。

### Open Task State Contract

- pending 时只禁用 Open task，其他 PiP controls 保持可用。
- owner window 缺失时由 main 重建并 show/focus；重建前不提前 ACK。
- newer intent supersedes older intent，旧异步 lookup 不能抢回页面。
- stale、missing conversation 或 recreation failure 保留 PiP 和当前 Computer Use session，并提供 Retry。
- 成功不显示 Toast，主窗口目标会话成为结果反馈。

## Status Matrix

| Visual state | Tone | Persistent chrome | Busy | Recovery action |
|---|---|---|---|---|
| live | success | hover/focus | no | none |
| connecting | neutral | yes | yes | none until timeout |
| reconnecting | warning | yes | yes | Retry when allowed |
| paused | neutral | yes | no | none |
| approval required | warning | yes | no | Open task |
| permission required | warning | yes | no | Screen settings |
| stopping | neutral | yes | yes | none |
| completed | success | yes | no | Open task/Close |
| stopped | neutral | yes | no | Close |
| failed | danger | yes | no | Retry/Open task as available |
| stop failed | danger | yes | no | Try Stop again |

- status label is primary；detail is one short repair sentence。
- raw provider/capture errors do not replace product copy；they remain diagnostics-only。
- success green is limited to a small indicator，not the whole overlay。
- terminal states follow the existing linger/destroy lifecycle without fake progress。

## Theme Contract

PiP receives a client-safe bootstrap snapshot：

```ts
interface ComputerUsePipThemeSnapshot {
  readonly themeId: string;
  readonly colorScheme: "light" | "dark";
  readonly presentationProfileId: string;
  readonly tokens: {
    readonly background: string;
    readonly elevated: string;
    readonly text: string;
    readonly muted: string;
    readonly border: string;
    readonly focus: string;
    readonly success: string;
    readonly warning: string;
    readonly danger: string;
    readonly shadow: string;
  };
}
```

- PiP does not read Theme Pack files、artwork or localStorage directly。
- main and PiP windows switch theme atomically from the same Desktop settings adapter。
- Presentation Profile cannot add background artwork behind captured content；only chrome tokens apply。
- invalid/missing snapshot falls back to Ling Light/Dark compact-window tokens by colorScheme。
- forced colors ignores custom color tokens；reduced transparency replaces blur with opaque elevated surface。

## Motion

- live chrome reveal/hide：`120ms` opacity；no scale or slide。
- Menu：shared `120ms` opacity/translateY；reversible and focus-safe。
- status replacement：direct or `120ms` fade，no layout shift。
- window drag/resize follows pointer without CSS transition。
- spinner uses shared loading motion；reduced motion uses static loading indicator/text。
- captured video and cursor do not receive decorative motion from the Theme Pack。

## Keyboard And Accessibility

- Tab reveals header controls；Shift+Tab order is Open task、Hide、More、menu items。
- Menu supports ArrowUp/ArrowDown、Home/End、Enter/Space and Esc focus return。
- window shell has an accessible name containing target and current status。
- state uses `role=status` / `role=alert` according to consequence，with `aria-atomic=true`。
- live frame has a concise accessible label；screen readers are not flooded by frame activity。
- hover-only appearance never removes controls from the tab order。
- VoiceOver、Narrator/NVDA and Windows high contrast require real-host evidence。

## i18n

- Desktop-only catalog remains small and typed；`en-US` and `zh-CN` keys are exact peers。
- local catalog may live in Desktop adapter，but action/status meaning must match Web i18n。
- dynamic target names truncate visually and remain available through accessible name/Tooltip。
- avoid mixed copy such as Chinese sentence plus untranslated technical capture error。

## Target Module Boundary

```text
apps/desktop/renderer/computer-use-preview/
  main.tsx                        # bootstrap only, target <150 lines
  preview-media-controller.ts
  preview-controller.ts
  preview-theme-controller.ts
  ComputerUsePreviewApp.tsx
  styles/tokens.css
  styles/shell.css
  styles/status.css
  styles/controls.css
```

- Media acquisition/release does not render DOM。
- view-model stays pure and domain-focused。
- React UI consumes `@ling-stack/ui-react` Compact Window primitives。
- no production source file in this renderer exceeds `500` lines；the old `815`-line imperative
  `main.ts` has been removed and must not be reintroduced。

## Tests And Accessibility

- coordinator、media lifecycle、provenance 和 renderer tests 覆盖 11 个权威状态、全部行动、菜单键盘、
  焦点恢复、locale 和 theme switch。
- visual acceptance 覆盖 min/default/max、live hover、approval、permission、connecting/reconnecting、
  failed/stop-failed、reduced motion 和 forced colors。
- macOS arm64/x64 与 Windows x64 在目标 DPI 分开记账；一个平台的自动测试不等于另一个平台的实机证据。
- 所有按钮命中区域 `>=32px`；主题切换保持视频流和窗口 bounds，不重新获取 media。

Accessibility contract：

- window shell accessible name 必须同时包含 target 与当前产品化 status label；中英文使用同一 typed key；
- `.preview-controls` 必须是命名 `role=toolbar`，DOM/Tab 顺序固定为 Open task、Hide、More；
- Shift+Tab 反向，Menu 打开聚焦首项，Esc 返回 More；状态 live region 与视频 label 不重复公告；
- 自动测试必须断言 toolbar role/name、target+status shell name、Tab/Shift+Tab、Menu Esc focus return 和
  locale switch 后语义更新。
- 真实 VoiceOver、Narrator/NVDA、Windows High Contrast、reduced transparency 和签名包证据继续由发布
  清单管理；测试次数和截图台账不写入本合同。

## Acceptance

- current-session control is visually consistent across channel、normal and teammate chat。
- header height does not change when command failure appears。
- PiP uses shared Theme Pack tokens instead of raw Light/Dark media-query colors。
- live content remains primary，but all actions are keyboard discoverable。
- Hide、Close and Stop semantics remain distinct and truthful。
- all status/error/permission paths have one clear next action and no raw diagnostic wall。
- PiP remains readable at `320x200` and does not exceed `480x300` in V1。
- UI migration does not weaken capture provenance、release ACK、runtime authority or Stop audit behavior。
