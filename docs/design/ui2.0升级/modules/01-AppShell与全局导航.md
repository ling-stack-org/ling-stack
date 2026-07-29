# AppShell 与全局导航

## Goal And Ownership

AppShell 只拥有全局布局、View 切换、跨页面 Provider、全局错误和 overlay 挂载。不得继续
承载 feature UI 细节。当前主要入口为 `AppShell.tsx`、`view-types.ts` 和导航 controller。

## Function Points

- `SHELL-NAV-001`：13 个 ViewId 切换、返回和当前状态。
- `SHELL-THEME-001`：fixed/system ThemeSelection、Theme Pack 首帧和切换。
- `SHELL-THEME-PRESENTATION-001`：Presentation Profile、route artwork、surface fallback。
- `SHELL-DISCONNECT-001`：daemon 断线、重连和过期数据。
- `SHELL-PERMISSION-001`：full access 确认 Dialog。
- `SHELL-OVERLAY-001`：全局 Dialog、Toast、Tooltip viewport 的层级。
- `SHELL-SIZE-001`：1440、1280 与 Electron 窗口尺寸。

## UI 2.0 Structure

```text
LingUiProvider
  AppShell
    Sidebar
    ActiveView
    Optional Inspector
    Global overlay layer
```

Settings 激活时主 Sidebar 不出现。页面切换保留 daemon 权威运行状态，不使用本地 loading
伪装运行。全局错误使用 InlineFeedback；轻量完成反馈使用 Toast。

## Actions And States

View 切换是 navigation，不使用 primary button。断线时显示当前数据为 stale、一个重连主行动
和折叠技术详情。权限确认 mutation 中阻止关闭，其他状态支持 Esc。

## Components And CSS

使用 PageShell、Dialog、InlineFeedback、Toast、Tooltip、SegmentedControl。全局 grid 留在
focused shell CSS；按钮、overlay 和主题视觉迁入 `ui-react`。禁止继续给 AppShell 增加主要
页面 JSX。

AppShell 是唯一 Presentation Profile 接入点。它可以挂载共享 background/artwork layer、
设置 route policy 和 client surface tokens，但 Feature 页面不得根据 Profile ID 分支。

## P4.1 Current Status

`SHELL-PERMISSION-001` 已迁到独立 `FullAccessConfirmationDialog`：

- AppShell 只保留 open state、Promise resolver 和权限证据组装；
- 展示层使用共享 `Dialog/DialogContent/Header/Body/Footer` 和 `Button`；
- Cancel、Esc、outside dismiss 都回到同一个拒绝 callback；确认仍生成原有
  `PermissionConfirmation`，不改变 API、权限策略或运行状态；
- 旧 `provider-sheet-*` JSX 不再承担该弹窗，focused CSS 位于
  `styles/app/full-access-confirmation.css`。

`SHELL-DISCONNECT-001` 已迁到独立 `AppConnectionStatus`：

- `/health` 返回不可用时保留当前页面与已有数据，显示 persistent `InlineFeedback`；
- “重新连接”只调用现有 health refresh，按钮 loading 防止重复请求，恢复后自动清除；
- 反馈以 `grid-area: workspace` 叠放，不改变 AppShell grid、页面滚动或 Settings boundary；
- 使用产品文案，不在默认层暴露 endpoint、token、process 或 raw error。

上述两个 Function ID 已在 P4.8 进入 `verified`，不代表整个 AppShell 完成。证据覆盖
Light 离线/stale/Reconnect、Dark Full Access Dialog、单次 Esc 拒绝、焦点恢复、draft 保留、
取消后无 run、确认后单一 run 与权限证据，见
[`app-shell-feedback-permission`](../evidence/shell/app-shell-feedback-permission/metadata.md)。domain error ownership、
页面 skeleton、First Run 和壳层 CSS 仍待后续切片。

## P4.6 Current Status

已验证：

- `SHELL-NAV-001`：`useAppNavigationController` 保持 View 切换边界；Settings 记录并恢复原 View、
  Sidebar target、selected channel/branch/task/thread，Work Board 和频道返回路径均有真实点击证据；
- `SHELL-THEME-001`：fixed/System、首帧、imported Theme Pack、invalid fallback、storage rollback、
  open Drawer/focus preservation 与 route surface 切换已有浏览器证据；
- AppShell 在 Home、Conversation、Channel、Management、Settings、Media Canvas、Diagnostics、Approvals
  surface 之间不 remount；13 个 ViewId 和 workspace identity 组合均有确定 resolver 结果；
- `1440x960` Light 与 `1280x800` Dark 无 document overflow 或新增 console error。

已实现但未验证完成：

- `SHELL-THEME-PRESENTATION-001`：Presentation Profile、route policy、surface recipe、artwork policy 和
  Desktop theme snapshot 已接入；真实 artwork bytes、publish/checksum、decode/preload/crossfade 和 client
  visual layer 仍属于 U4/U7，因此只标 `implemented`。

证据：focused AppShell `3/3`、Theme/Presentation `6/6`、App/Dark target `4/4`，见
[AppShell state evidence](../evidence/shell/app-shell-state/metadata.md)。

仍待：`SHELL-OVERLAY-001`、`SHELL-SIZE-001`、全局 error ownership、聚合 shell CSS 和 First Run
生产可达性。`AppShell.tsx` 已超过 3000 行，后续不得追加主要 UI/状态，必须复用或抽取 focused adapter。

## P4.7 Implementation Contract

下一切片只关闭 `SHELL-OVERLAY-001` 和 `SHELL-SIZE-001`，不迁移具体业务 Dialog、Drawer 或
Inspector 内容。

所有权固定如下：

- `LingUiProvider`：唯一 Tooltip Provider 和 Toast viewport；
- `@ling-stack/ui-react`：Portal、focus trap、outside dismiss、Esc、presence 和 z-index token；
- AppShell focused boundary：页面 grid、overlay host test boundary、viewport class/data attribute 和
  Desktop safe-area 输入；
- Feature adapter：是否打开、业务 busy、确认回调和对象数据；
- Electron main/preload：窗口 bounds、DPI、platform chrome 和 display 事件，不进入共享组件。

禁止新增全局 `activeOverlay` 业务状态。多个 overlay 的关闭顺序由 Radix/shared primitive nesting 和
受控 open state 决定；Feature 不得通过 `document.body` listener 或私有 `z-index: 9999` 抢所有权。

目标代码边界：

- 新增 focused `AppShellOverlayBoundary` 或同职责小组件，承载 shell test hook 和非业务 layout；
- 如 resize 派生逻辑超过简单 CSS，抽 `useAppViewportState`，只返回稳定 size class、client surface 和
  safe-area，不持有 View、channel、run 或 Settings 状态；
- 新样式进入 `styles/app/app-shell-overlay-size.css`，不追加 `components.css`；
- `AppShell.tsx` 只接入边界组件/派生值，不新增 overlay JSX 或 resize 业务分支；
- 不修改 `LingUiProvider` 的单实例语义，不复制 Provider 到 Settings、会话或 Desktop PiP。

Overlay 状态面：

- 无 overlay；Dialog；Drawer；Popover/Menu；Tooltip；Toast；
- Drawer 内 Popover/Menu；Dialog 内 Tooltip；Toast 与 Dialog 同时存在；
- Esc、outside click、关闭按钮、busy 阻止关闭、route change、rapid open/close；
- trigger 被卸载时的安全 focus fallback；
- normal motion 与 `prefers-reduced-motion: reduce`；
- imported Theme Pack 和 fallback Theme Pack，不允许主题改变 z-index。

固定层级合同沿用 foundation token：

```text
page / dock < dialog-drawer 60 < menu-popover 70 < toast 80 < tooltip 90
```

只有共享 primitive 可以消费这些 token。嵌套内容可使用 primitive 内部 `+1` content 层，但 Feature
CSS 不得计算或覆盖全局层级。

尺寸状态面：

- Web `1440x960`、`1280x800`；
- 最小 Desktop 主窗口，具体最小值以 Electron BrowserWindow 当前配置为准，不在 Web CSS 写死平台值；
- `1920x1080` 以上宽屏，内容保持可扫描，不按 viewport 放大字号；
- Sidebar expanded/collapsed、Inspector open/closed、Settings boundary、会话 bottom panel；
- 从大到小、从小到大连续 resize；macOS/Windows safe area 和 100%/125%/150% DPI 归 Desktop 证据；
- 中文/英文长标题、200% browser zoom、系统字体 fallback。

布局规则：

- grid/flex 子项默认 `min-width: 0`，内部滚动 owner 必须唯一；
- 页面不能产生 document 横向滚动，宽表或 canvas 使用自身已登记的滚动/缩放边界；
- 字体使用 token，不按 viewport 宽度缩放；大屏通过内容最大宽度和留白改善阅读，小屏通过列收敛、
  Drawer 和内部滚动适配；
- resize 不 remount AppShell/ActiveView，不重置 selection、scroll、composer draft 或 ThemeSelection；
- 打开的 overlay 在空间不足时使用 Radix collision/side fallback，不能被 header、sidebar 或 Desktop
  chrome 裁切。

专项测试 `ui2-shell-overlay-size.spec.ts` 至少包含：

1. Drawer 内打开 Menu/Popover，断言可见层级、Esc 逐层关闭和焦点逐层恢复。
2. Dialog 与 Toast/Tooltip 同时出现，断言单 Toast viewport、单 Tooltip、无点击穿透。
3. rapid open/close 和 reduced motion，断言无重复 surface、无残留 scrim。
4. `1440x960` 与 `1280x800` 打开同一 changed state，断言无 document overflow、控件不重叠。
5. 动态 resize 保留 View、selected object、open Drawer 和可恢复焦点。
6. imported Theme Pack 与 `ling-dark` 下层级不变，overlay surface 不串色。
7. console 无 error/warning；截图 metadata 记录 dev server、主题、locale、client 和 dirty state。

证据保存到 `evidence/shell/app-shell-overlay-size/`。Web 自动化和双 viewport 证据完成后，两个
Function ID 可到 `verified`；Electron 最小窗口和 Windows DPI 仍在 Desktop 发布矩阵单独记账，不能
用 Web viewport 截图代替。

## P4.7 Current Status

`SHELL-OVERLAY-001`、`SHELL-SIZE-001` 已 `verified`：

- Web root 只有一个 application overlay root、Tooltip Provider 和 Toast viewport；
- shared Dialog、Drawer、Menu、Popover、Tooltip、Toast 统一进入该 root，并暴露稳定 overlay slot；
- z-order `61 / 70 / 80 / 90`、Esc top-surface close、focus restore 和 reduced motion 已验证；
- `AppShellOverlayBoundary` 与 `use-app-viewport-state` 已抽出，AppShell 不再持有逐像素 resize 订阅；
- 壳层 containment、scroll owner 和 1280 grid 已从 `components.css` 迁入 focused CSS；
- AppShell 从 3,073 行降至 3,059 行，`components.css` 从 16,647 行降至 16,587 行；
- package `39/39`、专项 `3/3`、联合回归 `41/41` 通过；
- 双 viewport/双主题截图和 metadata 位于
  [AppShell overlay and viewport evidence](../evidence/shell/app-shell-overlay-size/metadata.md)。

遗留 97 条 Web `z-index` 和 25 条高位数字声明已经进入只减不增 lint budget；它们归 U13/P12
逐模块清理，不随 P4.7 假装完成。Windows DPI、forced colors 和 native chrome 继续由 Desktop 发布
矩阵验收。

## Tests

`app.spec.ts`、`app-shell-selectors.spec.ts`、`workspace.spec.ts`、`dark-mode.spec.ts`、
`ui2-app-shell-state.spec.ts`、`ui2-theme-registry.spec.ts`、`ui2-presentation-compiler.spec.ts`。
断言 Settings shell boundary、首帧主题/Profile、焦点恢复、断线状态、artwork 不遮挡和
无横向滚动。
