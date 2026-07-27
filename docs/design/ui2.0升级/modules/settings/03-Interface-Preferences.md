# Interface Preferences

Implementation plan: [P7A.4 Interface Preferences](03-Interface-Preferences-implementation-plan.md).

Theme Pack management implementation plan:
[P7C.1 Theme Pack Management](10-Theme-Pack-Management-implementation-plan.md).

Quick Theme Studio implementation plan:
[P7C.2 Quick Theme Studio](11-Quick-Theme-Studio-implementation-plan.md).

P7A.4 closeout: Theme selection、Product locale and Response language are verified on the reachable Web surface.
P7C.1 Web Theme Pack import/preview/reimport/delete is also verified under D1=A token plus isolated preview and
D2=A Web IndexedDB first. The existing Desktop CUA preference is implemented and browser-verified. Native Desktop
Theme Pack persistence and packaged macOS/Windows restart remain explicit follow-ups; Theme Create remains P7C.2.
Density remains absent until a real capability exists.

## Goal

界面偏好提供主题、跟随系统、界面密度、产品语言、响应语言和 Desktop-only 展示偏好等
直接可理解选项。
不使用说明卡或重复“当前设置”摘要。

Related docs:

- [主题系统入口](../../themes/README.md)
- [ThemePicker 与主题预览](../../components/12-ThemePicker与主题预览.md)
- [主题资源导入与安全](../../themes/05-主题资源导入与安全.md)
- [Theme Studio 与生成预览](../../components/13-Theme-Studio与生成预览.md)

## Function Points

- `SETTINGS-INTERFACE-THEME-001`：Follow System 和独立 Theme Pack 选择。
- `SETTINGS-INTERFACE-THEME-IMPORT-001`：本地 Theme Pack 导入、预览、重新导入和删除。
- `SETTINGS-INTERFACE-THEME-CREATE-001`：快速、生成和高级 Theme Studio。
- `SETTINGS-INTERFACE-LOCALE-001`：产品语言。
- `SETTINGS-INTERFACE-DENSITY-001`：若能力存在则显示密度；不存在则不展示假控件。
- `SETTINGS-INTERFACE-RESPONSE-001`：workspace 响应语言。
- `SETTINGS-INTERFACE-CUA-PREVIEW-001`：Desktop Computer Use 画中画自动显示偏好。

## Theme Model

- `Ling Light` 和 `Ling Dark` 是两个独立内置 Theme Pack。
- `System` 不是 Theme Pack，而是选择策略。
- 第一阶段 System mapping 固定为系统浅色 -> `ling-light`，系统深色 -> `ling-dark`。
- 点击任意 Theme Pack 时切换到 fixed mode，不继续跟随 OS 外观。
- 主题选择是客户端外观偏好，不写入 workspace 业务状态。

## Layout

```text
界面偏好

主题
  跟随系统                                      [Toggle]
  系统浅色使用 Ling Light，深色使用 Ling Dark

  当前主题                                      Ling Dark
  [Ling Light] [Ling Dark] [Local Theme ...]
  [创建主题] [导入主题]

语言与密度
  产品语言                                      [Select]
  响应语言                                      [Select]
  界面密度                                      [Control if supported]

Desktop                                          [Desktop only]
  自动显示已授权的 Computer Use 画中画           [Switch]
```

- 主题使用 ThemePicker，不使用 `System / Light / Dark` SegmentedControl。
- 语言使用 Select/Field。
- 即时生效的控件不显示保存按钮。
- 页面不使用“当前外观”大卡片或静态产品截图。
- `创建主题` 进入 Settings 内容区内的完整子页面，不使用嵌套大 Dialog。
- Desktop 区只在 `window.lingDesktop.computerUse` capability 存在时出现；普通 Web 不留空标题、
  disabled 行或“仅客户端可用”占位。

## Desktop Computer Use Preference

- 这是展示偏好，只决定已获授权的 Computer Use 会话是否自动显示 PiP，不代表授权、启动或停止。
- 初次读取期间只禁用当前 Switch；不能让整个 Interface Preferences 进入 loading。
- 切换采用本地即时反馈，但以 Desktop 返回结果为准。请求拒绝或抛错时回滚到原值。
- `accepted=true` 且 `reason=desktop_preferences_not_persisted` 时，本次会话值继续生效，并在当前行
  显示持续 warning；不能使用 3 秒后消失的 Toast 隐藏重启后可能回退的事实。
- 持久化成功后静默，不显示页面 success banner。
- 切换不创建、显示、隐藏或停止当前 PiP；正在运行的会话只在下一次权威投影更新后按现有
  Desktop coordinator 规则响应。
- 中文 label 为“自动显示 Computer Use 画中画”；英文 label 为
  `Automatically show Computer Use picture-in-picture`。ARIA 与可见 label 语义一致。
- 键盘使用 Space 切换；loading/disabled 时不接受重复输入，焦点不跳到页面顶部。

Current migration status：`SETTINGS-INTERFACE-CUA-PREVIEW-001` 已实现。当前设置已抽为
`DesktopComputerUsePreference.tsx`，使用共享 Switch/InlineFeedback；Web E2E 覆盖 Web 隐藏、
Desktop 初值、session-only warning 和保存结果。真实 macOS/Windows 重启持久化仍属于客户端验收。

## Theme Interaction

- Follow System Toggle 即时生效。
- ThemeOption 点击后局部显示 applying，其他 Settings 控件不进入 loading。
- 应用成功不需每次弹 Toast；用户主动导入、删除或修复主题时使用反馈系统。
- 应用失败恢复上一主题，在 ThemeOption/section 内保留修复路径。
- 切换主题不刷新 Settings，不重置当前 section 滚动位置。

## Import

- `导入主题` 打开 Dialog，只接受 `.ling-theme`。
- 当前 D1=A：只接受 semantic tokens、可选 `LICENSE.txt` 和一个隔离 Preview；任何 runtime artwork
  或 shell/background slot 都被拒绝。
- Dialog 显示 manifest 摘要、token swatch、Preview、license 和安全/对比度检查。
- 验证失败时不允许导入，技术细节进 Details。
- 导入成功后默认不切换；用户可勾选“导入后使用”。
- 本地主题可重新导入或删除；内置主题不显示这些操作。
- Web 使用 IndexedDB v2 原子保存 manifest、package metadata 和 Preview Blob。
- Desktop `appData/themes/<id>`、staging/atomic rename、typed IPC 和打包重启恢复仍是明确待做。

## Theme Studio

- Quick mode 上传干净背景并在本地分析、编译，不调用模型。
- Generate mode 使用一个已配置生图模型生成纯背景。
- Advanced mode 使用结构化 Planner 和 Artwork 能力，两个角色可由同一或不同模型承担。
- UI screenshot/effect mockup 只能作为 Generate/Advanced 参考，不能直接安装。
- Theme Studio 预览 Home、Conversation、Settings、Dialog 和五种 desktop viewport。
- 生成主题完成后可以 `安装并使用` 或 `仅安装`，不自动改变 System mapping。
- 无模型、缺 Key、停用或检查失败时显示真实 disabled reason 和 Model Workbench 修复入口。

## States

- fixed theme selected。
- system resolved to `ling-light` / `ling-dark`。
- OS appearance changed while following system。
- theme applying、apply failed、rollback complete。
- import validating、invalid manifest、invalid token、unsafe archive、low contrast、success。
- imported theme missing asset、incompatible schema、reimport、remove confirm。
- studio draft restore、quick local analyze、generation queued/cancelled、Planner invalid、
  artwork verification failed、compile blocker、publish/apply rollback。
- storage unavailable and Desktop adapter unavailable。
- locale switching、saving、save failed、density unavailable。
- Desktop bridge absent、preference loading、on、off、saving、save rejected、session-only accepted、
  persisted and restart restored。

## Feedback

- 主题选择成功默认静默，selected state 已是充分反馈。
- 导入/删除成功使用全局 Toast。
- apply failure、storage failure 和 compatibility issue 保持 InlineFeedback。
- 未知 Theme Pack ID 自动回退后显示 warning Toast + ThemePicker repair state。
- Desktop 自动显示保存失败或仅会话生效使用当前设置行的 InlineFeedback；成功静默。

## Tests

- `settings.spec.ts`：Follow System、fixed selection、import、preview、remove、fallback。
- `theme-studio.spec.ts`：Quick/Generate/Advanced、progress、preview、install、recovery。
- `dark-mode.spec.ts`：legacy preference migration、first paint、OS changes、`ling-dark` regression。
- `ui-primitives.spec.ts`：ThemePicker keyboard/ARIA、token swatch、Dialog states。
- Desktop smoke：macOS/Windows persistence、cold start、native controls、window surface fallback。
- `desktop-computer-use-bridge.spec.ts`：Desktop-only 可见性、初始读取、On/Off、请求拒绝回滚、
  session-only warning、重复输入抑制和 Web 隐藏。

## Acceptance

- Settings 中不再将 System、Light、Dark 当成同类主题选项。
- `Ling Light` 和 `Ling Dark` 显示为两个平级 Theme Pack。
- 主题切换无刷新、无布局抖动、无焦点/滚动丢失。
- 导入主题无法执行 CSS/JS、访问网络或替换 Logo。
- Theme Studio 三种模式通过同一 Theme Compiler，不直接安装模型输出。
- Computer Use 自动显示控件只在 Desktop 出现；状态保存失败不误报成功，session-only 状态有
  持续可见的重启风险说明。
- 中英文、`1440x960`、`1280x800`、Web、macOS 和 Windows 语义一致。
