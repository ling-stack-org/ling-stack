# ThemePicker 与主题预览

## Goal

让用户在 Settings > Interface Preferences 中理解并切换独立 Theme Pack。
主题选择即时生效，不显示保存按钮，不将 `System` 伪装成主题卡。

Related docs:

- [独立主题包产品模型](../themes/01-独立主题包产品模型.md)
- [主题资源导入与安全](../themes/05-主题资源导入与安全.md)
- [Theme Studio 与生成预览](13-Theme-Studio与生成预览.md)
- [Interface Preferences](../modules/settings/03-Interface-Preferences.md)

## Component Set

```text
ThemeSettingsSection
  FollowSystemToggle
  ActiveThemeSummary
  ThemePicker
    ThemeOption
    ThemeSwatch
    ThemeSourceBadge
    ThemeOptionMenu
  ImportThemeButton
  CreateThemeButton
  ImportThemeDialog
  ThemePreviewDialog
```

## Layout

```text
主题

跟随系统                                    [Toggle]
系统浅色使用 Ling Light，深色使用 Ling Dark

当前主题                                    Ling Dark

[Ling Light] [Ling Dark] [Graphite] [Midnight]

[创建主题] [导入主题]
```

- Settings section 使用普通页面 section，不嵌套大卡片。
- Theme options 是可重复项，可使用最多两列的稳定网格，圆角不超过 `8px`。
- 每个选项保持固定高度，名称、来源和 swatch 不因 hover/loading 改变布局。
- `1280x800` 下不折叠成横向滚动卡片带。

## Follow System

- 使用 Toggle，不使用三段 `System / Light / Dark`。
- 打开时使用当前 System mapping，第一阶段为 `ling-light` / `ling-dark`。
- 打开后 ThemePicker 仍可见，但选项点击会先切换到 fixed mode，再应用该主题。
- 不提供第一阶段的自定义浅色/深色映射编辑器。
- OS 外观改变时，ActiveThemeSummary 更新实际主题，不弹成功 Toast。

## ThemeOption

Visible content:

- 主题名称。
- 小型 surface/text/accent/status swatch。
- 来源：内置或本地，只在需要区分时显示。
- 当前选中状态，使用 border + check，不只用颜色。

Hidden in details/menu:

- Theme ID、schema version、安装时间、资源路径、checksum。
- 作者、homepage、license 和兼容问题。
- 本地主题的重新导入和删除操作。

Built-in theme 不显示删除或重新导入。

## ThemeSwatch

- 使用 Theme Pack 的实际 semantic tokens 绘制，不用预先截图伪造。
- 最小包含 app surface、panel、text、accent 和 4 种语义点。
- swatch 只是主题识别，不展示假的频道、对话或数据卡片。
- 背景图主题可显示经验证的裁切 preview，但必须带 surface scrim 和资源类型标识；P7C.1 导入包
  的 Preview 只在隔离 fixture 使用，不能成为 runtime background。
- preview 失效时回退 token swatch，不显示破图。

## Selection Behavior

1. 用户点击 ThemeOption。
2. Picker 标记目标项 `applying`，其他项仍保持可扫描。
3. Runtime 准备并原子应用 theme tokens。
4. computed sentinel 验证成功后更新 selected 和 persistence。
5. 失败时恢复旧主题，当前项显示紧凑 InlineFeedback，全局 error Toast 只作轻量提示。

不显示保存按钮，不在主题切换成功后强制刷新页面。

## ImportThemeDialog

Default layer:

- 选择 `.ling-theme` 文件。
- 主题名、作者、color scheme、资源摘要和 token swatch。
- 安全/兼容检查结果。
- `导入主题` 主行动和 `导入后使用` checkbox。

Details:

- schema version、Theme ID、license、资源列表、文件大小和对比度结果。
- parser/decoder 技术错误和 checksum。

验证失败时主行动 disabled，错误靠近问题项持续显示，不只弹 Toast。

## Create Theme

- `创建主题` 进入 Settings 内容区内的 Theme Studio，不打开窄 Dialog。
- Theme Studio 提供快速、生成、高级三种模式。
- 快速模式不调用模型；生成/高级模式根据已配置能力显示可用性和 disabled reason。
- 返回 ThemePicker 后保留当前 ThemeSelection 和滚动位置。
- 创建成功的主题以 `local-generated` 来源显示，与本地导入主题共享选择、预览和删除语法。
- ThemeOption details 显示生成模式和模型来源摘要，但 prompt、raw response 和本地路径不在默认层。

## ThemePreviewDialog

- 使用隔离的共享 primitive fixture，不导入真实 workspace 数据。
- 展示 Button、Field、Menu、Status、Toast、DataRow 和简短文本层级。
- 布局尺寸来自 UI 2.0 foundation，不由主题包改变。
- preview 关闭后恢复原焦点，Esc/backdrop 行为符合 Dialog 合同。

## States

| State | UI |
|---|---|
| default | theme options and current summary |
| hover/focus | stable border/background, no layout shift |
| applying | local spinner on target option |
| selected | check + selected border |
| system resolved | active summary shows actual resolved theme |
| invalid | option disabled with repair details |
| missing asset | token swatch fallback + reimport action |
| import validating | Dialog progress steps |
| import failed | Dialog InlineFeedback |
| import succeeded | Toast, optional immediate use |
| studio draft | generated theme draft exists, resume/discard actions |
| locally generated | normal selectable option with generated source metadata |
| remove confirm | destructive Dialog |

## Keyboard And ARIA

- ThemePicker 使用 radio-group 语义，方向键移动，Space/Enter 应用。
- FollowSystemToggle 使用 switch 语义，标签包含当前 System mapping 摘要。
- swatch 是装饰，屏幕阅读器读取主题名、color scheme、来源和选中状态。
- More 菜单、导入 Dialog 和 preview Dialog 符合共享 overlay 规范。
- 主题切换不抢取焦点，成功 Toast 使用 polite live region。

## Acceptance

- Settings 不再显示 `System / Light / Dark` 三段主题控件。
- Ling Light 和 Ling Dark 作为两个独立主题选项。
- 开启跟随系统时能正确显示当前实际主题。
- 切换主题无页面刷新、焦点丢失、滚动重置、Dialog 关闭或布局抖动。
- 导入错误有持续修复路径，不只依赖会消失的 Toast。
- Quick/Generate/Advanced 入口和生成主题来源清楚，不把生成流程塞进 Import Dialog。
- 内置 Logo 、图标、字号、间距和控件尺寸不随主题变化。
