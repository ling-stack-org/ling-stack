# Theme Studio 与生成预览

## Goal

提供一个可完成“上传、生成、预览、修复、安装”的主题工作区。Theme Studio 不是普通
小弹窗，也不把高级字段一次铺满；它在 Settings 内容区内使用完整子页面，保留明确返回
路径，不新增主导航或 `SettingsSectionId`。

Related docs:

- [AI 生成主题产品流程](../themes/07-AI生成主题产品流程.md)
- [沉浸式主题与 Presentation Profile](../themes/06-沉浸式主题与Presentation-Profile.md)
- [Theme Compiler 与 AI Provider 边界](../architecture/08-Theme-Compiler与AI-Provider边界.md)
- [Interface Preferences](../modules/settings/03-Interface-Preferences.md)

## Function IDs

```text
UI-THEME-STUDIO-001          Theme Studio shell and navigation
UI-THEME-STUDIO-MODE-001     Quick/Generate/Advanced mode selection
UI-THEME-STUDIO-PROGRESS-001 Step progress, cancel, retry and recovery
UI-THEME-STUDIO-PREVIEW-001  Multi-surface and multi-viewport preview
UI-THEME-STUDIO-INSTALL-001  Compile, verify, install and use actions
```

## Entry And Shell

Interface Preferences 的 Theme section 提供：

```text
[创建主题]  [导入主题]
```

- `创建主题` 进入 `ThemeStudioSurface`，替换 Settings 右侧内容区。
- 左上角显示 Back icon + `主题`，返回 ThemePicker，保持 Settings 左侧导航不变。
- 浏览器/窗口返回键等价于 Back；有未保存草稿时显示离开确认。
- Theme Studio 不使用嵌套大卡片，不跳回主应用壳，不打开新窗口。
- 导入 `.ling-theme` 继续使用 ImportThemeDialog，不混入生成流程。

## Page Structure

```text
ThemeStudioSurface
  ThemeStudioHeader
    Back
    Draft identity/status
    Secondary actions
  ThemeModeTabs
    Quick | Generate | Advanced
  ThemeStudioWorkspace
    ThemeInputPanel
    ThemePreviewPanel
  ThemeStudioFooter
    Progress summary
    Primary action
```

Desktop layout：

- Input panel：`320-360px` 固定约束，可内部滚动。
- Preview panel：`minmax(0, 1fr)`，拥有独立 preview viewport。
- Header 和 Footer 固定在 Settings 内容区内，不遮挡系统 title bar。
- `1280x800` 保持双列，Input panel 收敛到 `320px`。
- 内容区不足 `960px` 时上下布局，Preview 在上、Input 在下；不进入移动端设计。
- 两列均使用明确 `min-height: 0` 和滚动所有权，不产生整页横向滚动。

## Mode Control

使用 SegmentedControl 或 Tabs：

```text
快速模式 | 生成模式 | 高级模式
```

- 模式名称始终可见，不使用只有图标的神秘入口。
- 切换前如果会失效已生成结果，显示影响摘要并确认。
- 同一源图在模式间保留；模型结果按 invalidation contract 清理。
- 无可用模型时 Generate/Advanced 保持可见但 disabled，并显示修复原因。
- 模式说明只显示一句结果导向文案，不堆叠功能说明墙。

## Quick Mode UI

默认层：

```text
Source image
  [Drop zone / Choose image]

Theme name                         [Input]
Color scheme                      [Light | Dark]
Presentation                     [Profile select]
Artwork intensity                 [Segmented]

[Generate preview locally]
```

- Drop zone 支持点击和 drag/drop；选择后显示缩略图、尺寸和替换/删除 action。
- 明确显示 `本地生成，不调用模型`。
- Profile 默认使用 Compiler 建议，用户可修改。
- safe area、focus point 和 scrim 在第一次分析后进入“构图”Disclosure。
- 主行动是 `生成预览`；没有图片时 disabled 并在 Field 下说明。

## Generate Mode UI

默认层：

```text
Reference image                   [Optional upload]
Visual direction                  [Textarea]
Style                             [Select]
Image model                       [Select]
Color scheme                      [Light | Dark]

[Generate artwork]
```

- Visual direction 只要求用户描述气质、场景和主体，不要求理解 prompt 工程。
- Style 提供中性选项：自然、插画、抽象、科技、节日、自定义。
- Model Select 只显示具备 image generation capability 的已配置模型。
- 模型项显示名称、provider 和是否支持参考图；raw model ID 进 Details。
- 上传 UI screenshot 时显示“仅作为视觉参考，将重新生成纯背景”。
- 调用前显示预计生成数量和模型，主行动文案为 `生成 1 张背景` 等明确文本。
- Prompt、negative prompt、seed/provider 参数不在默认层展示。

## Advanced Mode UI

默认层：

```text
Reference assets                  [Upload list]
Theme intent                      [Textarea]
Planner model                     [Select]
Artwork model                     [Select]
Presentation Profile              [Select]
Artwork slots                     [Checkboxes allowed by Profile]
Variants                          [Stepper 1-4]

[Create theme plan]
```

Advanced Details 默认折叠：

- Theme Plan JSON 只读预览。
- Generated prompt 和 negative prompt，可编辑但修改后标记 `user-edited`。
- focusX/focusY、safe area、slot、aspect ratio 和 intensity。
- provider capability evidence、template version 和 generation metadata。
- 原始 provider response 只在失败 Diagnostics Details 中显示。

Planner 完成后主行动变为 `生成主题背景`。用户必须先查看 plan 摘要，rights blocker 未解决时
不能继续。

## Source And Rights Controls

- 上传后选择 source type：干净背景、效果图/截图、个人照片、身份参考、第三方素材。
- identity reference 必须勾选“人物明确成年且我有必要的使用权”。
- 选择 UI screenshot 时禁用快速模式直接安装，只能进入生成/高级模式。
- 检测到 Logo、水印或可读文字风险时显示 blocker，不用自动裁切掩盖。
- 权利确认是本地记录，不代表 Ling 认证素材可商用。

## Progress UI

统一步骤条：

```text
Validate -> Analyze -> Plan -> Generate -> Compile -> Verify
```

- Quick 隐藏 Plan/Generate，但步骤 ID 保持稳定。
- Generate 隐藏 Plan。
- 当前步骤显示 spinner 和具体动词，例如“正在分析构图”。
- 已完成步骤显示 check 和摘要，不使用大面积绿色。
- 失败步骤显示 danger indicator、原因和 `重试此步骤`。
- `取消`只停止当前请求；已完成结果和输入保留。
- 顶部关闭/返回在运行中要求确认，不悄悄中断模型任务。
- 进度不是模拟 timer，必须绑定真实 controller stage。

## Preview Panel

Preview 由真实共享 primitive fixture 渲染，不使用一张带 UI 的静态效果图。

### Surface Tabs

```text
Home | Conversation | Settings | Dialog
```

- Home 验证 Hero、Sidebar、Composer 和 decoration。
- Conversation 验证 ambient artwork、Feed、Summary、Right Dock 和 Terminal。
- Settings 验证 token-only surface、表单、DataRow 和 Inspector。
- Dialog 验证 overlay、focus、status、Toast 和 destructive action。

### Viewport Controls

```text
1280x800 | 1440x960 | 1920x1080 | 2560x1440 | 3440x1440
```

- Preview 使用缩放容器模拟真实 CSS viewport，不通过截图拉伸。
- 显示当前 scale 百分比，但验收读取模拟 viewport 的真实 bounding box。
- 支持拖动 artwork focus marker，更新 `focusX/focusY` 后只重新 Compile/Verify。
- 显示 safe area overlay 的开关只用于编辑，不进入最终主题。
- Preview 内控件默认不触发业务动作，但必须可聚焦以检查可读性和 focus ring。

### Shared Fixture Implementation Checkpoint

- `packages/ui-react/src/theme-studio/ThemeStudioPreviewFixture.tsx` 是唯一共享画布 owner；Web Feature
  后续只负责翻译 copy、surface/viewport 控制和 scale 计算，不复制四套 fixture DOM。
- 已实现 Home、Conversation、Settings、Dialog；Settings/Dialog 在 package 内强制
  `solid / artwork off / decorations false`，不信任调用方自行关闭背景。
- 五档 viewport 是固定尺寸映射，内部布局保持真实 `1280x800` 等尺寸，再以 transform 等比缩放；
  禁止把 1280 截图拉伸成 3440 预览。
- fixture 只接收 synthetic copy、semantic variable map、Presentation policy 和可选 caller-owned `blob:` object URL；
  运行时仅复制 `LING_THEME_CSS_VARIABLES` allowlist，拒绝额外 style key、data/remote artwork URL，且不访问
  workspace、API、路由、i18n、Blob lifecycle 或 IndexedDB。
- 当前共享 fixture 与 Vite browser geometry 已验证；生产 Theme Studio tabs、viewport selector、controller
  和发布流程仍未接线，因此 `UI-THEME-STUDIO-PREVIEW-001` 不能标记 verified。

## Candidate Gallery

生成多个图片时：

- 候选使用稳定缩略图网格，最多 4 个。
- 选中状态使用 border + check，不只用颜色。
- 每个候选提供选择、放大、重新生成和删除；低频动作进 Menu。
- 删除当前候选前要求确认是否切换到其他候选。
- 候选切换只重新 Compile/Verify，不重新调用 Planner。

## Theme Controls

生成预览后允许调整：

- Theme name。
- Light 或 Dark 独立 `colorScheme`。
- Presentation Profile。
- Surface/artwork intensity。
- focus point、safe area、Home/Conversation artwork behavior。
- Compiler 派生的 accent 候选，使用有限 swatch，不提供任意 CSS color editor。

所有调整必须即时更新 preview，但只有 verification 通过后才允许安装。

## Footer Actions

状态矩阵：

| State | Primary action | Secondary actions |
|---|---|---|
| empty | Generate preview/artwork | Back |
| running | Cancel current step | Back disabled or confirm |
| failed | Retry failed step | Edit inputs, diagnostics |
| preview ready | Install and use | Install only, save draft |
| installed | Done | Open ThemePicker, duplicate |

- `Install and use` 是唯一强调主行动。
- `Install only` 不改变当前主题。
- 安装和应用分开反馈；应用失败时安装结果仍保留。
- 成功使用全局 Toast，verification blocker 持续显示在 Preview/Footer。

## States

- no source、invalid type、oversize、decode failed。
- local analyzing、analysis failed、safe fallback。
- no eligible model、model loading、provider unavailable、missing API Key。
- planning、invalid structured output、rights warning、plan ready。
- generating、queued、cancelled、timeout、provider failed、unsafe result。
- compiling、contrast blocker、unsupported Profile/slot、preview ready。
- storage full、draft restore、stale draft、publish failed、apply rollback。
- model option disappears while Studio open。
- language switch、theme switch attempt while editing、Desktop file permission failure。

## Feedback

- 当前步骤进度和错误保持 inline，不用 Toast 代替工作流状态。
- 上传成功、分析成功和 Compile 成功不逐步弹 Toast。
- 安装成功、删除草稿和导出完成使用全局 Toast。
- 模型/Compiler blocker 不自动消失，修复后由 controller 清除。
- Provider 技术错误、request ID 和 raw response 进入 Details。

## Keyboard And ARIA

- Back、mode tabs、upload、model select、preview tabs 和 footer actions 可完整键盘访问。
- Drop zone 同时是有名称的 Button，不只依赖 drag/drop。
- Progress 使用 ordered list + `aria-current="step"`，不连续播报百分比。
- Preview fixture 使用 `aria-label` 标明仅用于主题预览。
- focus marker 支持方向键微调，Shift + 方向键大步调整。
- 运行完成和 blocker 使用 polite/assertive live region，避免重复播报全部步骤。

## Motion

- 模式切换使用 `120ms` opacity，不横向滑动整页。
- Input/Preview 列宽稳定，步骤状态变化不推动 Footer。
- Candidate 生成完成只淡入，不逐项 stagger。
- artwork 切换使用 `180ms` crossfade；快速切换以最后选择为准。
- reduced motion 下直接切换，Progress spinner 使用静态 loading 表达。

## i18n

- 模式中文：快速模式、生成模式、高级模式。
- 英文：Quick、Generate、Advanced。
- 模型能力、失败原因和 rights 文案必须中英文语义对齐。
- Prompt Template 可以是英文模型指令，但不直接作为默认用户界面文案。
- Theme name、用户描述和生成资产名称允许 Unicode；Theme ID 由系统生成 ASCII slug。

## Acceptance

- 用户不读技术说明也能区分三个模式和是否会调用模型。
- Quick mode 在断网和无模型环境可完成安装。
- Generate mode 只配置生图模型即可完成。
- Advanced mode 能选择同一模型或不同 Planner/Artwork 模型。
- UI screenshot 不会被直接安装为背景。
- Preview 覆盖 Home、Conversation、Settings、Dialog 和五种 desktop viewport。
- 任何 blocker 都有明确对象、原因和修复动作，不只出现短暂 Toast。
- Theme Studio 不访问 secret、不直接调用 provider、不产生任意 CSS/JS。
- `1280x800` 无横向溢出，Input/Preview 都有明确滚动边界。
