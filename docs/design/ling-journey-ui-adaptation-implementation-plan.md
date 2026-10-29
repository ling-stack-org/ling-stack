# Ling 远行问剑 UI 视觉适配设计实施方案

状态：P0–P6 基础配色、背景与功能检查已完成；2026-10-28 已清理 Composer 页面外观覆盖，完成共享组件与 Journey 精修的本机实现及验证，待用户美术复核。以[共享组件合同](component-theme-presentation.md)、[分段实施方案](component-theme-presentation-implementation-plan.md)和[验证记录](component-theme-presentation-validation.md)为当前增量依据；下文旧验收记录只证明旧版本。真实 daemon 离线；Desktop 安装包验收仍待执行。

2026-10-27 后续加固：正文阅读保护、共享播放策略、每主题构图偏好与最新验收由[加固实施合同](theme-background-hardening-plan.md)接管。本文 P0–P6 的旧截图和测试数字保留为历史证据，不作为修改后源码的验收结果。

Owner：theme and presentation delivery track  
Last verified：2026-10-27
Document type：UI visual design contract and staged implementation plan  
关联：[远行问剑主题设计合同](ling-journey-theme-design.md)、[场景主题与背景实施方案](full-window-theme-background-implementation-plan.md)、[统一主题合同](theme-background-motion-contract.md)、[验收矩阵](full-window-theme-background-acceptance-matrix.md)

Code and test anchors：`packages/ui-react/src/styles/themes/built-in-themes.css`、`packages/ui-react/src/styles/theme/`、`apps/web/src/styles/theme-background.css`、`apps/web/src/styles/conversation-home.css`、`apps/web/src/styles/shared/conversation-composer-slots.css`、`apps/web/src/app/AppPresentationSurfaceBridge.tsx`、`apps/web/e2e/full-window-background.spec.ts`

## 1. 目标与当前差距

`ling-journey` 不能只表现为“普通 Ling Stack 界面加一张背景图”。用户在第一眼应该能同时感受到：背景母图、侧栏材质、顶栏层次、Composer 形状、按钮强调色、选中态、弹层和设置页属于同一套远行问剑视觉系统。

当前版本已经完成：

- 静态母图作为官方 `SceneArtwork` 全窗环境层；
- 墨蓝、灰蓝、暖金的语义 token；
- 侧栏、顶栏、主工作区的透明材质和可读性回退；
- 首页 Composer 的主题面板色和拖放焦点边界；
- 主题卡缩略图、选中态、保护路由实底、自动化工作区的环境层透出和用户自定义媒体覆盖。

本轮已完成的主题辨识度目标：

- 侧栏、顶栏、compact rail、right dock 已使用统一墨面、边界、分组间距和交互态；
- Composer 已使用 L3 实底、主题外框、统一工具分组和暖金主操作；
- Button、Input、Select、Tabs、Badge、Card、Table 与 Dialog、Popover、Menu、Toast、Tooltip 已消费共享远行材质变量；
- 设置页、主题卡和背景设置页已使用同一套层级、边框、选中和焦点状态语言；
- Chromium 对比截图可以在不查看 DOM/CSS 的情况下区分 Journey 与 Ling Dark。

本方案只解决 UI 视觉表达和展示层边界，不改变布局业务语义、权限、会话状态、执行状态、模型绑定、Logo、图标语义或数据模型。

## 2. 视觉原则

### 2.1 远行问剑的四个视觉词

| 词 | UI 表现 | 禁止 |
|---|---|---|
| 墨 | 深墨蓝实底、低对比分层、薄边界 | 大面积纯黑、厚重黑色卡片、发光描边 |
| 雾 | 低强度透明层、背景连续透出、柔和阴影 | 每个面板单独裁切背景、强模糊、玻璃反射 |
| 剑 | 暖金焦点、主操作、短线强调 | 大面积橙色渐变、持续闪烁、游戏化爆炸光 |
| 远 | 中央留白、右侧视觉重心、克制密度 | 把控件堆到人物和剑光上、横向装饰条纹 |

### 2.2 材质层级

所有 UI surface 按下面五层归属，不能由组件自行决定透明度：

| 层 | 名称 | 用途 | 背景行为 |
|---|---|---|---|
| L0 | Scene | 静态母图环境层 | 只由 `WorkspaceBackgroundLayer` 加载一次 |
| L1 | Ambient | 主工作区、顶栏的环境层 | 允许母图透出，负责氛围，不承载小字正文 |
| L2 | Shell | 侧栏、导航、工作区边界 | 半透明墨面，交互态用局部实色保护 |
| L3 | Content | Composer、正文、代码、表格、设置 | 不透明语义 surface，保证阅读和操作 |
| L4 | Overlay | Dialog、Popover、Menu、Toast、Tooltip | 不透明或高不透明浮层，使用统一阴影和边框 |

### 2.3 首屏可感知标准

1440×960 首页截图必须同时满足：

1. 侧栏与主工作区明显属于同一墨蓝材质，但不是一整块黑板；
2. Composer 有独立的主题容器形状和暖金主操作；
3. 侧栏选中项、主题卡选中项和焦点态使用同一种冷蓝灰/暖金语言；
4. 顶栏、按钮、快捷入口和状态提示不再使用基础主题的中性灰外观；
5. 背景人物和红色死域仍在右侧，标题、Composer 和主要操作位于安全区；
6. 首次对比截图时，评审者不需要放大或读取 CSS 才能判断 UI 已经换主题。

## 3. Token 与语义合同

### 3.1 现有主题 token 继续作为唯一来源

`ling-journey` 的基础语义 token 继续由 `built-in-themes.css` 提供。组件不得读取 `ling-journey` 主题 ID，也不得直接写背景图颜色。

| 语义组 | 当前值 | 主要消费者 |
|---|---|---|
| `background.app` | `#0d141c` | L0 fallback、页面基础色 |
| `background.panel` | `#111c27` | L1、Composer、正文容器 |
| `background.elevated` | `#182531` | L4 浮层、菜单、Toast |
| `background.subtle` | `#1b2a38` | hover、弱分组、次级控件 |
| `background.pressed` | `#24384b` | pressed、selected 的深层状态 |
| `background.sidebar` | `#101923` | L2 侧栏、导航 rail |
| `text.strong/default/muted` | `#eef3f5` / `#d2dde2` / `#9babb4` | 标题、正文、辅助说明 |
| `border.default/strong/focus` | `#2b3c49` / `#48606f` / `#c49a63` | 容器、强调边界、键盘焦点 |
| `action.accent` | `#c49a63` | 主按钮、发送、主题选中边界 |
| `action.selection` | `#304556` | 侧栏选中、列表选中、主题卡 active |
| `status.*` | 灰蓝、青绿、琥珀、暗红 | 状态提示，不借用背景中的红色裂隙 |

### 3.2 新增的展示层变量

如果基础 token 无法表达组件材质，新增变量只能放在共享 presentation 层，并保持主题无关的语义命名：

```css
--ling-surface-ambient-alpha
--ling-surface-shell-alpha
--ling-surface-content-alpha
--ling-surface-border-subtle
--ling-surface-border-emphasis
--ling-surface-shadow-shell
--ling-surface-shadow-overlay
--ling-control-radius
--ling-control-height
--ling-focus-ring
```

`ling-journey` 可以为这些变量提供值，但业务组件只能消费变量，不能出现 `data-ui-theme="ling-journey"` 选择器或 Journey 专属 class。

### 3.3 对比度和透明度

- 正文和小字保持至少 4.5:1；有意义的图标、边界和焦点保持至少 3:1。
- L1/L2 透明度由 `background-material.ts` 的 resolver 计算，不由截图视觉手调覆盖。
- L3/L4 默认不透明；背景图不参与正文、代码、输入、表格、审批和设置的对比度判断。
- `prefers-reduced-transparency`、forced-colors、窄窗口或资源异常时，L0/L1/L2 回退到 token-only 实底。

## 4. 组件适配矩阵

### 4.1 应用外壳

| 区域 | 目标效果 | 实施动作 | 代码边界 |
|---|---|---|---|
| 左侧栏 | 墨色半透明、层级清楚、选中态像一块局部墨面 | 调整侧栏内边距、分组间距、行高、活动态边界和 hover 底色 | `apps/web/src/styles/theme-background.css`、sidebar styles |
| 顶栏 | 与背景连续，不出现横贯白线 | 统一 titlebar、window controls、workspace header 的 L1 材质和边界 | `DesktopWindowChrome`、presentation bridge |
| 工作区边界 | 背景自然进入主画布，内容仍有前后层次 | 用 ambient surface 取代默认 app background，保留 content frame | `AppPresentationSurfaceBridge`、workspace styles |
| 收起侧栏 rail | 仍能识别当前区域和焦点 | 使用 L2 背景、暖金 focus ring 和冷蓝灰 pressed | compact rail styles |

### 4.2 首页与 Composer

| 区域 | 目标效果 | 实施动作 |
|---|---|---|
| 首页标题 | 与远方构图呼应，清楚但不压住山门 | 保持中央安全区，增加主题文字层级和柔和暗色保护 |
| Composer 外框 | 一眼可见的主题容器，而不是默认白/黑卡片 | 统一圆角、边框、L3 实底、低强度阴影和上下留白 |
| Composer 输入区 | 安静、宽阔、支持长文本 | 取消无意义分割线，保留清晰 placeholder、focus 和错误边界 |
| Composer 底部工具 | 像一组收束的剑鞘工具，不像散落的默认按钮 | 统一 icon button 尺寸、间距、hover、disabled、下拉箭头和文字色 |
| 发送按钮 | 暖金是唯一明确主操作 | `action.accent` / hover / pressed / disabled 四态完整定义 |
| 附件与拖放 | 主题化但不产生粒子噪声 | 采用暖金短边线和主题焦点边界，reduced-motion 保留静态边界 |

### 4.3 通用控件与内容

| 组件 | 视觉处理 |
|---|---|
| Primary / Secondary Button | Primary 暖金实底；Secondary 墨蓝实底；两者共享高度、圆角和焦点环 |
| IconButton | 默认无底，hover 使用 `background.subtle`，pressed 使用 `background.pressed` |
| Badge / Status | 只使用语义状态色；背景死域红不进入成功、警告或错误 token |
| Tabs / Segmented Control | 选中使用冷蓝灰局部底，active indicator 使用 1px 暖金线 |
| List Row / Sidebar Row | 默认透明，hover 有轻微墨面，selected 有局部实底，不做整行高亮条 |
| Card / Table | L3 实底、薄边框、短阴影；表头使用 `background.subtle` |
| Code / Terminal | `background.code` 实底，保留等宽字体和滚动，不与背景混合 |
| Alert / Inline Feedback | 语义色来自 status tokens，边框和图标统一，不直接取图片红色 |

### 4.4 弹层与设置

- Dialog、Popover、Menu、Tooltip 和 Toast 统一使用 `background.elevated`、`shadow.overlay`、`border.default`。
- 设置页保持 token-only 实底，但主题卡、range slider、按钮和说明文字使用同一套暖金/冷蓝灰状态语言。
- 主题卡保留母图缩略图，并增加明确的 active border、selected mark、hover spotlight 和 keyboard focus。
- 背景设置页同时展示“当前主题默认画面”和“用户自定义覆盖”，避免用户误以为背景设置会改变主题 token。

## 5. 交互状态合同

每个可交互控件至少实现以下状态：

| 状态 | 表现 | 可读性边界 |
|---|---|---|
| Default | 墨蓝/透明基底，弱边界 | 不使用持续发光 |
| Hover | `background.subtle` + 边界稍增强 | 不改变文字尺寸或布局 |
| Focus-visible | 暖金 2px ring 或等效高对比边界 | 键盘可见，不能只靠颜色 |
| Pressed | `background.pressed` + accent 降亮 | 不产生位移抖动 |
| Selected | 冷蓝灰局部底 + 暖金细边 | 不能只显示一个小色点 |
| Disabled | 降低对比但保留结构 | 不使用完全透明导致控件消失 |
| Error / Warning | 语义暗红/琥珀 | 不借用背景裂隙色造成误读 |
| Loading | 只在发起动作的控件显示 | 不让整页变成 busy |

## 6. 实施阶段

### P0：视觉基线与合同冻结

交付：

- 1440×960 首页、普通会话、设置页和一个弹层的默认主题截图；
- 远行主题与 `ling-dark` 的对比截图；
- 本文档中的 token、材质层、组件矩阵和状态矩阵评审记录；
- 明确哪些区域允许透背景，哪些区域必须实底。

完成条件：评审者可以指出每个 UI 区域对应的 L0–L4 层，不再用“看起来差不多”作为验收标准。

### P1：Presentation token 与材质层

改动范围：

- `packages/ui-react/src/styles/themes/built-in-themes.css`；
- `packages/ui-react/src/styles/foundation-tokens.css`；
- `packages/ui-react/src/theme/presentation/`；
- `apps/web/src/styles/theme-background.css`；
- `AppPresentationSurfaceBridge` 和 background material resolver。

交付：新增共享材质变量、统一边框/阴影/圆角/控件高度，所有已有主题仍能回退到原视觉。

### P2：Shell 适配

改动范围：侧栏、顶栏、紧凑 rail、workspace header、right dock。

交付：侧栏分组、导航行、活动态、顶栏和工作区边界形成同一层级；1440×960 截图中能明显看到侧栏与背景的连续关系。

### P3：Home 与 Composer 适配

改动范围：`ConversationHome`、`NormalConversationComposer`、composer slots、快捷入口、附件和拖放反馈。

交付：Composer 具有主题化容器、明确的工具分组、暖金主操作和完整状态；输入区不被背景人物、红色死域或剑光干扰。

### P4：通用控件与 Overlay 适配

改动范围：ui-react Button、IconButton、Input、Select、Tabs、Badge、Status、Card、Table、Dialog、Popover、Menu、Toast、Tooltip。

交付：主题切换后，控件颜色、层级、选中态、焦点态和浮层阴影一致；业务组件不增加主题 ID 分支。

### P5：设置与主题选择器适配

改动范围：`InterfaceThemeSettings`、`InterfaceBackgroundSettings`、theme picker、range slider、setting sections。

交付：设置页拥有完整的主题层级；主题卡和首页使用同一张静态母图；用户能区分“主题默认背景”和“个人覆盖背景”。

### P6：视觉验收与回归

交付截图：

1. 1440×960 远行主题首页；
2. 1440×960 远行主题普通会话；
3. 1440×960 Composer focus / selected / error；
4. 侧栏展开、收起 rail、right dock；
5. 主题设置页和背景设置页；
6. Dialog、Popover、Toast、Menu；
7. `prefers-reduced-motion`、forced-colors、窄窗口和保护路由。

每张截图绑定主题、视口、系统外观、背景源、透明度和 commit SHA；同时记录 console/page errors 和关键元素 computed style。

## 7. 文件级实施清单

### 7.1 ui-react

- `packages/ui-react/src/styles/themes/built-in-themes.css`：补齐 Journey 的材质变量和控件语义值。
- `packages/ui-react/src/styles/foundation-tokens.css`：声明共享 radius、height、focus ring 和 shadow 变量。
- `packages/ui-react/src/styles/controls/*.css`：检查 Button、IconButton、Input、Select、Tabs 的状态覆盖。
- `packages/ui-react/src/styles/overlays/*.css`：统一 L4 浮层和阴影。
- `packages/ui-react/src/styles/theme/theme-picker.css`：主题卡状态与静态母图缩略图。
- `packages/ui-react/src/theme/presentation/`：扩展 surface/material profile，不传入任意主题 CSS。

### 7.2 Web

- `apps/web/src/styles/theme-background.css`：只负责 L0–L2 背景和保护回退，不承载组件业务样式。
- `apps/web/src/styles/conversation-home.css`：首页标题、快捷入口、Composer 外框布局。
- `apps/web/src/styles/shared/conversation-composer-slots.css`：输入区、工具区、拖放、附件状态。
- `apps/web/src/app/AppPresentationSurfaceBridge.tsx`：为 route/surface 选择 presentation policy。
- `apps/web/src/features/settings/InterfaceThemeSettings.tsx`：主题卡和主题说明。
- `apps/web/src/features/settings/InterfaceBackgroundSettings.tsx`：背景默认/覆盖关系和 slider。

### 7.3 验证

- `apps/web/e2e/full-window-background.spec.ts`：场景背景与资源边界断言。
- `apps/web/e2e/ling-journey-ui-visual-acceptance.spec.ts`：Journey UI-01–UI-12 视觉和状态断言及截图证据。
- `apps/web/e2e/dark-photo-visual-acceptance.spec.ts`：补充 Journey 首页、Composer 和侧栏截图。
- `packages/ui-react/test/styles.test.mjs`：token 完整性、对比度、状态和无主题 ID 分支检查。
- `packages/ui-react/test/theme-registry.test.mjs`：manifest、presentation profile 和 fallback 检查。

## 8. 本地实施检查点（2026-10-27）

P1–P6 已在 `gansx/theme-background` 工作树完成本地落地与 Web Chromium 验收：

- presentation token 已进入 `foundation-tokens.css`，`ling-journey` 提供材质透明度、边框、阴影、控件圆角/高度和焦点环值；Button、Form Control、Tabs、Menu、Popover、Dialog、Toast、Data Display 和 Theme Picker 均消费共享语义变量。
- Shell 已接入侧栏、工作区、右侧面板的统一边界/阴影，侧栏活动项和聚焦项使用局部墨面与暖金焦点；背景就绪时仍由 material resolver 决定实际透出比例。
- 首页与普通会话 Composer 已统一外框、L3 实底、工具区分组、暖金发送按钮、拖放边界和快捷入口；设置页的主题卡、背景编辑器、滑杆和分组面板沿用相同状态语言。
- 未增加任何业务组件对 `ling-journey` ID 的分支，也未改变会话、权限、模型、草稿或上传状态机。

本地验证结果（2026-10-27）：

```text
@ling-stack/ui-react test       82/82 passed
@ling-stack/web typecheck:ci    passed
@ling-stack/web lint            passed
@ling-stack/web build           passed
Playwright full-window + pilots 25 passed, 1 skipped
check:docs                      399 Markdown files passed
```

真实 Chromium 检查已完成 Journey UI-01–UI-12：覆盖首页、普通会话、Composer 默认/聚焦/选中/错误、侧栏展开与 compact rail、right dock、Menu、Dialog、Popover、Toast、设置实底、forced-colors、reduced-transparency、窄窗口和横向溢出；两条规格均通过，console/page errors 为 0。Journey 与 Ling Dark 对比截图、各状态截图和 computed-style/overflow 证据已固定到 `.ling-stack/acceptance/ui-browser/2026-10-27/journey-ui/`。Toast 验收使用实际 Personalization tone save 流程，并确认 mock daemon 工作区状态已保存为 `friendly`。

P6 当前关闭范围是 Web Chromium 视觉验收。Desktop 安装包、macOS/Windows 签名包、真实 Finder/Explorer 跨窗拖放、长时间媒体性能和真实模型执行仍属于 S4 平台门槛，不能由本次浏览器 fixture 代替。

## 9. 验收门槛

### S1：视觉合同可审查

- token、材质层和组件矩阵已冻结；
- 首页和设置页至少有一版静态对比截图；
- 业务组件不读取主题 ID；
- protected surfaces 和 reduced-transparency 回退明确。

### S2：核心 UI 具备主题辨识度

- 侧栏、顶栏、Composer、快捷入口、按钮和主题卡全部完成；
- Default/Hover/Focus/Pressed/Selected/Disabled/Error 状态齐全；
- 1440×960 首页不再被评审为“普通 UI + 背景图”。

### S3：完整 UI 回归

- 普通会话、频道、right dock、设置、Dialog、Popover、Menu、Toast 均使用一致材质；
- console/page errors 为 0；
- 中文/英文文案不溢出，窄窗口无横向滚动；
- protected surfaces 保持实底和可读性。

### S4：平台验收

- Web、macOS arm64/x64、Windows 签名包分别验证；
- 背景层、窗口 chrome、原生拖放和系统外观不改变 UI 状态合同；
- 性能和 native/GPU 内存证据绑定到同一版本。

## 10. 回退与未做事项

- 主题 token 或材质解析失败时回退到 `ling-dark`/`ling-light` 的 token-only surface，不阻塞会话。
- 静态母图加载失败时回到 `background.app`，不生成临时人物或运行时 SVG rider。
- 自定义视频仍是独立用户能力，不改变官方静态主题的 UI 合同。
- 本阶段不做动态场景、不做新的角色动画、不做远程主题、不做自动取色、不做移动端专属 UI。
- 本文档的 Web 主题 UI 验收已完成；仍不能把本地 Chromium 证据表述为 Desktop 安装包或跨平台发布验收。

