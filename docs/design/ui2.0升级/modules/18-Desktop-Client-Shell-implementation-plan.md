# Desktop Client Shell：Main Window Integrated Chrome 详细设计与实现计划

## Status And Scope

本切片只关闭 `DESKTOP-SHELL-MAIN-WINDOW-DRAG-001`：让 macOS 主窗口在 UI 2.0
布局下拥有稳定、可发现但不可见的拖拽表面，同时不遮挡任何交互控件。

它不是整个 Desktop Client Shell 的完成声明，也不改变 Windows native title bar、PiP、daemon、
主题、签名或发布流程。

Related docs:

- [Desktop Client Shell](18-Desktop-Client-Shell.md)
- [AppShell 与全局导航](01-AppShell与全局导航.md)
- [Web 与 Desktop 表面规范](../foundations/05-Web与Desktop表面规范.md)
- [CSS 目标目录与加载顺序](../architecture/06-CSS目标目录与加载顺序.md)
- [Desktop 跨平台发布验收清单](../release/01-Desktop跨平台发布验收清单.md)

## Pre-Implementation Baseline

实施前 Electron 正确使用 macOS `hiddenInset`，但 renderer 的 drag contract 只覆盖 Sidebar
顶部一小块和三个 Feature class selector。当时的结果是：

- UI 2.0 首页主区域顶部空白不能拖动；
- Sidebar 收起后原 drag region 被直接隐藏；
- Channel、Settings、Media、Workbench 等顶级 surface 没有稳定拖拽合同；
- Feature header class 白名单与“Desktop shell CSS 拥有 drag behavior”的架构要求冲突；
- 当前独立透明层使用 Dialog z-index，若直接扩成全宽会遮挡按钮、菜单和输入框。

根因不是 Electron 壳缺失，也不是安装包版本错误，而是 renderer hit-test 覆盖不完整。

## Goals

- 视觉保持当前 UI 2.0，不恢复旧 Toolbar，不增加可见 title bar。
- 主内容继续从 `y=0` 开始，不增加全局 top padding，不改变现有 Header 高度。
- macOS expanded/collapsed Sidebar、首页、三类会话和所有顶级 View 都至少有一个稳定 drag target。
- 按钮、链接、输入、菜单、Tab、resize handle、canvas 和编辑区始终可交互。
- Web 与 Windows 不挂载 Desktop chrome；Windows 继续使用系统 title bar。
- drag contract 通过共享组件和 `data-*` 属性表达，不再维护 Feature class 白名单。
- Web CSS contract、packaged resource contract 和真实 macOS WindowServer 行为分层验收。

## Non-Goals

- 不实现 Windows custom title bar、frameless window 或 DLL/native addon。
- 不修改 `BrowserWindow` 的 `hiddenInset` / `default` 选择。
- 不调整 traffic lights 位置、Sidebar 产品宽度或内容密度。
- 不修改 PiP 的 drag/resize/snap 行为。
- 不把本切片接入 Cua Driver source-build、签名供应链或 hosted full-matrix CI。
- 不以 Web Playwright 结果代替真实 packaged macOS 窗口移动证据。

## Design Decision

采用 UI 2.0 集成式 Desktop chrome：

```text
macOS BrowserWindow (hiddenInset)
  Shared AppShell
    DesktopWindowChrome
      expanded Sidebar confirmed-empty region
      headerless Home confirmed-empty content region
      final 76x28 traffic-light no-drag exclusion
    Sidebar / ActiveView
      actual stable header [data-desktop-window-drag-region="true"]
        interactive descendants -> no-drag
    global overlay portals -> explicit no-drag subtraction
```

不采用全宽、高 z-index 的透明 sibling overlay。底层按钮不是该 overlay 的后代，给按钮设置
`no-drag` 不能可靠恢复 hit-test；这会制造“能拖动但按钮失灵”的更严重回归。

## Information Hierarchy

拖拽能力不进入产品信息层级。用户仍按当前顺序感知：

1. 当前页面、会话或工作区内容；
2. 页面行动和状态；
3. 原生窗口移动能力，仅在用户按住空白 chrome/header 背景时生效。

`DesktopWindowChrome` 没有文字、图标、焦点、Tooltip、菜单或可访问名称，不参与 Tab 顺序和
screen-reader tree。

## Platform And Lifecycle Contract

| Host | Chrome DOM | Drag behavior | Lifecycle |
|---|---|---|---|
| Web | absent | browser-owned | never mounts |
| macOS main BrowserWindow | present | shared renderer hit zones + `hiddenInset` | mounts with AppShell, survives route/Sidebar state changes |
| Windows main BrowserWindow | absent | native title bar | never mounts |
| Desktop PiP/utility window | absent | utility-window contract | independent |

Show / hide / close rules:

- `window.lingDesktop.platform === "macos"` 时挂载；其他 host 返回 `null`。
- expanded Sidebar 的 confirmed-empty strip 可见于 hit-test；Sidebar collapsed 时该 strip 隐藏，
  但主内容 Header/Home drag target 必须继续存在。
- Home 没有真实 Header，因此 `DesktopWindowChrome` 提供主内容顶部 confirmed-empty fallback。
- 两个 chrome rectangle 常驻于 macOS DOM；当 `.workspace` 出现真实 drag marker 时，CSS `:has()`
  立即隐藏 content fallback，避免异步会话首条消息期间由父层状态推断产生竞态。
- 有真实 Header 的页面不使用覆盖它的 sibling layer，而在 Header 本身声明 drag contract。
- AppShell 最后绘制的 `76x28` pseudo region 只做 `no-drag` subtraction，且使用
  `pointer-events: none`；它不遮挡原生 traffic lights，也不成为可命中的透明 Web 层。
- Settings 返回按钮只在 macOS 横向避让到 `x>=76`，这是允许的 native safe-area
  geometry exception；按钮暴露 `data-desktop-window-traffic-light-clearance="true"`，focused CSS
  不识别 Settings Feature class。它不增加页面 top padding、可见 Toolbar 或改变 Settings 其他内容密度。
- Dialog、Drawer、Menu、Popover、Toast、Tooltip 及 body-level preview 在 macOS 明确声明
  `no-drag`；body-level preview root 自身暴露 `data-desktop-window-no-drag="true"`，focused CSS
  不识别其 Feature class；overlay 的 z-index 不能替代 Electron hit-test subtraction。
- chrome 没有用户可见的 Show/Hide/Close 控件；AppShell unmount 或 BrowserWindow 销毁时随 renderer 消失。
- route、theme、locale、Sidebar collapse、renderer reconnect 不重建 BrowserWindow，也不丢失 chrome contract。

## Module Boundary

### New owner

`apps/web/src/app/DesktopWindowChrome.tsx`

- 只决定 host 是否为 macOS Desktop；
- 只渲染 confirmed-empty Sidebar/Home drag rectangles；真实 Header marker 出现时由 CSS 隐藏 Home fallback；
- 不读取 daemon、View business state、conversation content 或 Electron IPC；
- 不拥有窗口坐标、移动或 resize 逻辑。

### AppShell integration

`AppShell.tsx` 只完成：

- 接入一个 focused `DesktopWindowChrome`；
- 给通用 `.workspace-head` 暴露共享 drag marker；
- 保留 `.desktop-macos` client class。

不得把 Feature selector、drag/no-drag 清单或页面布局分支继续写入 `AppShell.tsx`。

### Feature surface contract

真实稳定 Header 或 navigation surface 只声明语义：

```tsx
<header data-desktop-window-drag-region="true">...</header>
```

特殊交互区域可显式退出：

```tsx
<div data-desktop-window-no-drag="true">...</div>
```

Feature 不写 `.desktop-macos` selector，不直接设置 `-webkit-app-region`，也不推断平台。

### CSS owner

`apps/web/src/styles/app/macos-titlebar.css` 是主窗口 drag/no-drag 唯一平台行为 owner：

- 消费共享 `data-*` contract；
- 拥有 28px titlebar hit height 和 76px traffic-light exclusion；
- 拥有 expanded/collapsed Sidebar geometry；
- 拥有 portal overlay 和 Settings 返回按钮的 macOS hit-test/clearance；
- 只通过 `data-desktop-window-traffic-light-clearance` 消费 Settings 返回按钮的 native safe-area
  exception，不引入 Settings Feature selector；
- 不复制 Button、Header、Settings、Media 或 Theme Pack 的视觉样式。

## DOM And Hit-Test Contract

### Drag marker

`[data-desktop-window-drag-region="true"]` 在 `.app-shell.desktop-macos` 内才生效：

```css
-webkit-app-region: drag;
user-select: none;
```

同一 marker 在 Web/Windows 中是无行为的测试与语义属性。

### Automatic no-drag descendants

以下后代统一使用 `-webkit-app-region: no-drag`：

- `button`、`a`、`input`、`textarea`、`select`、`summary`；
- `[contenteditable="true"]` 和 `[contenteditable="plaintext-only"]`；
- `[role="button"]`、`link`、`menuitem`、`tab`、`slider`、`checkbox`、`radio`、`switch`；
- `[data-desktop-window-no-drag="true"]`；
- `[data-ling-overlay]`、`[data-ling-overlay-scrim]` 和 body-level preview owner；
- resize handle、drag/drop owner、canvas/flow surface 通过显式 marker 退出。

输入、Textarea 和 contenteditable 同时恢复 `user-select: text`。页面不能依靠 `onClick` 的无语义
`div` 绕过该合同；若确有 custom interaction，必须补 role 或显式 no-drag marker。

### Geometry

| Region | Expanded | Collapsed / Settings fullscreen |
|---|---|---|
| traffic lights | `x=0..76`，final no-drag exclusion；native buttons remain OS-owned | same |
| Sidebar empty strip | `x=76..sidebar-right`, `y=0..28` | absent |
| headerless Home fallback | `x=sidebar-right..window-right`, `y=0..28` | `x=max(76, rail-right)..window-right`, `y=0..28` |
| real page Header | Header current bounds | Header current bounds |

所有 rectangle 为透明 hit zone，不改变 grid row、margin、padding、scroll height 或 bounding box。现有
Sidebar traffic-light clearance 可保留，但本切片不得向整个 workspace 增加 28px padding。

### Z-order

- confirmed-empty rectangle 使用 shell-local 低层级，不再复用 `--ling-z-dialog`。
- Header marker 不创建新的 stacking context。
- current-session control、Drawer、Dialog、Menu、Popover、Toast、Tooltip 和 scrim 保持原层级，并以
  `no-drag` 从底层 Header/nav drag geometry 中扣除。
- 打开 modal 时不能透过 scrim 拖动主窗口。

## Surface Coverage

| Surface | Drag owner |
|---|---|
| Home / empty conversation | `DesktopWindowChrome` content fallback |
| Sidebar expanded | `DesktopWindowChrome` Sidebar strip |
| Sidebar collapsed | active Header 或 Home fallback |
| Normal conversation | `NormalConversationHeader` |
| Channel workspace/settings/environment | channel Header |
| Teammate direct chat | `TeammateChatHeader` |
| Teammate settings | `TeammateSettingsHeader` |
| Teammate management | management Header |
| Runs / Threads / Work Board / Approvals and generic views | shared `.workspace-head` |
| Providers / Plugins / Automations / Profile / Councils | each stable page Header or shared `PageActionHeader` |
| Settings fullscreen | Settings navigation background; controls are no-drag |
| Media production | actual canvas toolbar background; buttons/segmented controls are no-drag |

## Interaction State Matrix

| State | User sees | Drag target | Protected interaction |
|---|---|---|---|
| Home, Sidebar expanded | unchanged UI 2.0 | Sidebar strip + main top fallback | New conversation / collapse control |
| Home, Sidebar collapsed | unchanged compact rail | main top fallback | rail actions |
| Conversation / Channel / Teammate | unchanged 48px Header | Header background | search, refresh, summary, terminal, details, menus |
| Settings fullscreen | Settings layout unchanged except the macOS Back safe-area clearance | navigation blank background | Back, section buttons, fields, tabs |
| Media canvas | unchanged floating toolbar | toolbar gaps/background | project, view switch, run/configure, canvas drag |
| Dialog/Drawer/Menu open | existing overlay | background target is occluded | overlay click, Esc and focus restore |
| Web / Windows | current layout | none from this contract | all current behavior |
| renderer reload | current first frame | target restored after mount | no stale overlay node |

Loading、empty、error、success 和 partial data states do not change chrome ownership. Header disappearance in a
Feature state must leave either a sibling stable Header marker or a shell fallback; data loading cannot decide whether
the native window is movable。

## User Journey

| Step | User does | Expected feeling | Contract |
|---|---|---|---|
| 1 | Opens Ling | UI looks like the Web product, not a second Desktop layout | no visible Toolbar or layout shift |
| 2 | Holds a real top blank area | window moves immediately | stable drag marker |
| 3 | Collapses Sidebar | window remains movable from main content | Home fallback / page Header persists |
| 4 | Uses search, menu or input in Header | control responds, window does not move | descendant no-drag |
| 5 | Opens Dialog/Drawer | overlay keeps full focus and pointer ownership | chrome below overlay |

Five-second quality is “nothing looks added”。Five-minute quality is “every route still moves predictably”。Long-term
quality is one data contract that new UI 2.0 pages can adopt without editing a Desktop Feature whitelist。

## Accessibility And Input

- drag rectangles are `aria-hidden` and have no focusable descendants。
- Header controls retain their current accessible names、roles、Tab order and focus rings。
- keyboard navigation never moves the window。
- reduced motion does not change drag/no-drag hit zones。
- text-editing descendants preserve selection and caret behavior。
- VoiceOver acceptance must confirm Header buttons remain actionable；Windows AT behavior is unchanged because the
  contract is inert there。
- double-click maximize/restore remains native behavior only where Electron honors the drag marker；it must not fire
  from no-drag controls。

## Failure Modes And Defenses

| Failure | Defense |
|---|---|
| full-width transparent layer eats clicks | only confirmed-empty rectangles may be sibling overlays |
| Feature class renamed and drag silently disappears | stable data contract, focused E2E marker inventory |
| Sidebar collapse removes the only target | main Header/Home target is an independent gate |
| Dialog competes with drag layer | shell-local low layer + real click/Esc regression |
| custom canvas/resize interaction moves window | explicit no-drag contract and actual pointer regression |
| overlay z-index above Header but click still moves window | portal overlay/scrim no-drag subtraction |
| Settings Back sits below native traffic lights | macOS-only horizontal clearance + final traffic-light exclusion |
| Web test passes but native window does not move | opt-in packaged macOS coordinate smoke |
| Windows gets duplicate chrome | component returns null and native title bar contract stays frozen |

## Implementation Tasks

- [x] **T1 (P1)** — Add `DesktopWindowChrome.tsx` and replace the raw AppShell drag div。
- [x] **T2 (P1)** — Replace Feature class selectors with the shared drag/no-drag data contract。
- [x] **T3 (P1)** — Mark all stable top-level Header/navigation owners and preserve interactive descendants。
- [x] **T4 (P1)** — Extend `macos-titlebar.spec.ts` for Home、collapsed Sidebar、Conversation、Channel、Settings、Media、overlays and controls。
- [x] **T5 (P2)** — Update packaged resource assertions for the new component/data contract。
- [x] **T6 (P2)** — Run the CuaDriver macOS packaged coordinate smoke and record its evidence；不新增默认 harness。

## Verification Plan

### Renderer contract

```bash
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web exec playwright test \
  e2e/macos-titlebar.spec.ts e2e/workspace.spec.ts \
  --workers=1 --reporter=line
```

Required assertions:

- macOS marker computed `-webkit-app-region` is `drag`；
- interactive descendants computed value is `no-drag` and an actual click/type succeeds；
- Sidebar collapse leaves a visible main-content target；
- Home workspace `top=0` and `height=viewport`；Header heights do not change；
- Web and Windows do not render shell-owned chrome；
- opening an overlay does not create click-through or focus loss。

### Desktop contract

```bash
corepack pnpm --filter @ling-stack/desktop typecheck
corepack pnpm --filter @ling-stack/desktop build
node --test \
  apps/desktop/tests/main-window-contract.test.mjs \
  apps/desktop/tests/resource-paths.test.mjs
```

`main-window-contract.test.mjs` must continue proving macOS `hiddenInset` and Windows `default`；本切片不修改
`window-factory.ts`。

### Packaged macOS smoke

1. Build/install the current candidate and bind evidence to commit/app.asar hash。
2. Record initial `BrowserWindow` bounds。
3. Drag one confirmed-empty Home target and assert `x/y` changes。
4. Collapse Sidebar and repeat from the main target。
5. Click a Header no-drag control and confirm the window bounds do not move。
6. Restore original bounds in `finally` and close the smoke session。

This native smoke is opt-in and belongs on an interactive macOS/self-hosted runner；它不得进入默认 hosted
artifact matrix。

本切片按“正常产品构建”收口：T6 的候选包 hash、原生坐标和 pass/fail 直接记录在本文档的
Verification Evidence，不新建保留型 harness、审计 manifest 或默认 CI artifact。截图和原始 CuaDriver
输出只是本地临时 QA 材料，收口时清理。

## Verification Evidence

2026-07-29 在真实 packaged macOS arm64 candidate 上完成 T6。

Candidate binding：

- source base `e1954051d72734d03c994fb1434fd293e2e0c470`，branch
  `codex/ui2-desktop-window-chrome`；验收时本切片尚未 commit；
- app `0.0.0`，app ID `com.lingstack.desktop`，Electron `43.1.1`，arm64；
- packaged Web resource tree SHA-256
  `af01f11028d49de286ad6666c9898dddcf1b8ae163098b56fc08164162ba94c4`；
- `app.asar` SHA-256 `f2f5f747b1bd901eaf4b4e8216e9d9d37236dc7951459077a15599a1e7cb05b2`；
- DMG SHA-256 `ac7a1ae4ee5db5972d9ed0fcdd75e7682e67b98b1521184f3c6aaac84af18361`；
- ZIP SHA-256 `938364fe3bb7563786451f980fa0c97e5049e37e046d7fa13f18bf7e04fbd169`；
- 隔离 QA copy `com.lingstack.desktop.windowchromeqa5` 与 candidate 的 Web tree / `app.asar` hash
  逐项相同，使用同一 Apple Development Team `ZH5RAD8573` 重签，deep/strict codesign 通过。

Host：macOS `26.5.2 (25F84)`，Apple M4 Max，built-in `3456x2234` Retina，CuaDriver `0.8.3`；
Ling PID `2215`，native window ID `98320`，logical bounds 初始为
`{x:144,y:35,width:1440,height:920}`，CuaDriver capture 为 `1920x1227`。

| Native case | Action / live contract | Before -> after | Verdict |
|---|---|---|---|
| Home expanded drag | content fallback `rect={x:240,y:0,w:1200,h:28}` / `drag`；screenshot `(800,18)->(960,18)` | `x:144 -> 264`，`y/w/h` unchanged | passed，`+120pt`；background rung reported `background_unavailable`，then foreground rung moved and restored focus |
| Sidebar collapse control | physical click；shell gained `channel-sidebar-collapsed` | bounds unchanged at `{144,35,1440,920}` | passed，control action succeeded without window movement |
| Home collapsed drag | fallback `rect={x:76,y:0,w:1364,h:28}` / `drag`；same safe drag path | `x:144 -> 264`，`y/w/h` unchanged | passed，`+120pt` |
| Settings traffic clearance | traffic exclusion `76x28` / `no-drag` / `pointer-events:none`；Back `rect={x:76,y:20,w:192,h:32}` / `no-drag` | bounds unchanged | passed，Back closed Settings；background input was observed dropped, foreground retry succeeded |
| Real Dialog overlay | New channel Dialog and full scrim both computed `no-drag`；scrim physical click at screenshot `(133,16)` | bounds unchanged | passed，scrim received the click and dismissed the Dialog |
| finally restore | Sidebar expanded，Settings/Dialog closed | `{144,35,1440,920} -> {144,35,1440,920}` | passed，position and size exactly restored |

Focused automation：Web lint/typecheck/build passed；`macos-titlebar.spec.ts --repeat-each=2` passed
`14/14`；workspace geometry passed `1/1`；Desktop typecheck/build and main-window/resource contracts passed
`7/7`；`git diff --check` passed。以上 automation 与 T6 均在同步 #401 后的 `e1954051` base 上重跑。

Honest boundary：该 evidence 只验证 packaged macOS arm64 主窗口 drag/no-drag contract。它不外推
macOS x64 或 Windows，不代替公证、release signing、重启/升级和整体 Desktop release gate；本次候选包是
Apple Development signed，notarization skipped。

## Exit Gate

- Design docs and coverage matrices reference `DESKTOP-SHELL-MAIN-WINDOW-DRAG-001`。
- No Feature class selector remains in `macos-titlebar.css` drag ownership。
- No full-width high-z sibling overlay covers real controls。
- Web lint/typecheck and focused E2E pass。
- Desktop build and focused node contracts pass。
- Packaged macOS Home + collapsed Sidebar coordinate smoke passes before marking `verified`。
- Windows remains native-titlebar-only and is not claimed as newly verified。

## What Already Exists

- Electron `hiddenInset` / Windows `default` BrowserWindow contract。
- shared Web AppShell renderer and Desktop platform capability injection。
- 28px Sidebar traffic-light clearance and three existing draggable Header behaviors。
- global overlay root and z-order tokens。
- Playwright macOS renderer fixture and Desktop packaged resource test。

## NOT In Scope

- Windows custom title bar or real Windows acceptance；native title bar remains the product decision。
- traffic-light redesign、window geometry persistence、snap/fullscreen changes。
- PiP drag/resize、Cua Driver binary packaging or signing evidence。
- visual restyle、new icon、new Toolbar、new title copy。

## Unresolved Decisions

No unresolved product or implementation decisions。New pages must either expose a stable Header marker or extend the
focused shell fallback contract；they must not append another Feature class selector。
