# Web 与 Desktop 表面规范

## Shared Contract

Web 和 Electron Desktop 共用组件结构、状态语义、排版、尺寸和交互。Desktop 不复制
feature 页面，不通过原生菜单绕过 daemon 权限和状态机。

Web 和 Desktop 使用同一 Theme Pack manifest、semantic tokens 和 ThemeRegistry。
Light/Dark 是 `ling-light` / `ling-dark` 两个独立主题，不在 Desktop 层重新定义。
Presentation Profile 和 Theme Compiler 也必须共享，平台不能建立私有 Profile fork。

## Web Surface

- 光学白、清晰边界、低阴影。
- 优先内容密度和浏览器兼容。
- 不使用大面积 blur 或透明背景。

## Desktop Surface

- 使用 `[data-client="desktop"]` 覆盖 window、sidebar 和 overlay surface tokens。
- 允许有限 blur、窗口圆角和原生 chrome，但正文、表格、Inspector 保持清晰。
- 浮层和窗口材质不能降低文字对比度。
- 系统通知、托盘、keychain 和窗口生命周期属于 Desktop shell，不进入共享组件。
- Theme Pack 的可选 Desktop tokens 只表达材质意图，macOS/Windows adapter
  决定是否能使用 blur、Mica 或不透明 fallback。
- Profile 的 `frosted` 在 macOS/Windows 可映射到不同原生材质，但 unsupported/reduced
  transparency 时必须回退同一 verified solid surface。
- Desktop 不使用平台专属 selector 复制 Button、Dialog、Menu、Toast 和 Composer 样式。

Desktop 包含三类表面，不能用一套未经区分的窗口 CSS 处理：

| Surface | UI owner | Visual rule |
|---|---|---|
| Main BrowserWindow | shared Web AppShell | 与 Web 共用 feature UI，仅增加窗口 chrome、drag region 和 client surface token |
| Utility BrowserWindow | `@ling-stack/ui-react` compact primitives | 小尺寸稳定 geometry、清晰状态、32px actions，不复制 AppShell |
| Native OS Dialog | Electron main process | 仅用于启动、权限和无法进入 renderer 的恢复路径，文案与行动来自 typed catalog |

Computer Use PiP 属于 utility BrowserWindow。主题只影响窗口 chrome、状态层和控件，不对捕获的
视频像素应用 filter、blend mode、opacity 或 color correction。PiP 在 `320x200`、`420x263`
和 `480x300` 保持同一信息优先级，不能因为窗口变小隐藏唯一恢复行动。

主窗口中的 current-session capability control 必须在频道、普通对话和 AI 队友私聊使用同一
共享组件。命令失败使用锚定反馈，不增加 Header 高度；Show、Hide、Close 和 Stop 的语义不得
因平台或表面不同而合并。

## Theme Bootstrap

首帧必须读取最终有效 ThemeSelection 和 Theme Pack，避免黑闪、白闪或默认主题闪现。

- Desktop 默认 System selection，系统浅色解析 `ling-light`，深色解析 `ling-dark`。
- 手动选择具体 Theme Pack 后进入 fixed mode，不随 OS 外观变化。
- Desktop preload 在 renderer 首帧前注入已验证的 selection 和 bootstrap snapshot。
- 共享 UI 响应 `data-ui-theme`、`data-color-scheme` 和 semantic variables，不拥有持久化。
- 共享 presentation layer 响应 `data-ui-presentation`；Feature 页面不能读取该属性。
- 主窗口和每个 utility renderer 使用带 revision 的同一主题快照；旧 revision 必须忽略。
- 主题或语言变化不能重建 BrowserWindow、React root、MediaStream 或当前任务状态。
- PiP 缺少主题快照时只允许回退到对应 color scheme 的内置安全 token，不读取
  `prefers-color-scheme` 建立第二套主题所有权。

## Cross-Platform Geometry

- macOS 和 Windows 使用同一控件高度、hit area、字体层级和内容 min/max，系统 chrome 差异由
  Desktop adapter 吸收。
- 验收覆盖 macOS arm64/x64、Windows x64，以及 100%、125%、150%、200% display scale。
- 窗口拖动、resize、snap、display change 和 obstacle avoidance 由 Desktop window adapter
  处理，组件 CSS 不推断屏幕坐标。
- shared main-window CSS 只定义 renderer hit zone：macOS Header/confirmed-empty region 声明 drag，
  交互后代声明 no-drag；真实窗口坐标、显示器和移动结果仍由 Electron/native adapter 负责。
- Windows high contrast、macOS reduced transparency 和 reduced motion 都必须有不丢失行动的
  fallback；不允许只在 macOS 截图正确。

## Acceptance

同一 Function ID 在 Web/Desktop 中应有相同名称、状态、行动和危险级别。允许表面材质
不同，不允许业务语义和组件行为不同。

同一 Theme Pack 在 Web/macOS/Windows 中必须保持语义颜色、对比、组件 geometry 和状态一致。
平台无法实现某种材质时使用不透明 fallback，不使用另一套 Feature CSS。

同一 generated Theme Pack 还必须保持 Profile ID、artwork slots、safe area 和 Compiler output
一致；平台只允许在窗口材质、系统 chrome 和受管文件路径上不同。

Desktop 完成还要求主窗口、native recovery 和 utility window 都有真实客户端证据。Web
Playwright 通过不能代替 Electron renderer、窗口行为、DPI 或辅助技术验收。
