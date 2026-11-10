# CSS 所有权与迁移规则

本文件是 CSS 目录、级联、兼容和删除规则的唯一长期合同。历史逐文件迁移数字由 Git
保留，不再维护独立矩阵。

## Layers

- UI package：tokens 和基础组件视觉。
- App shell：全局 grid、窗口、Sidebar 容器。
- Feature CSS：领域布局，如 Canvas、Timeline、Conversation Feed。
- 禁止 Feature CSS 重写 `.ling-ui-*` 内部结构。

共享样式入口 `packages/ui-react/src/styles/index.css` 声明的 layer 顺序为：

```text
ling.reset -> ling.tokens.base -> ling.tokens.theme -> ling.tokens.client
-> ling.primitives -> ling.conversation -> ling.shell
-> ling.features -> ling.utilities
```

Foundation 与组件默认参数在 `ling.tokens.base`，官方主题覆写在 `ling.tokens.theme`。
历史 Web 样式已完成语义 token 迁移，不再增加兼容别名或逃逸覆盖；新规则必须明确所有权与 layer。
Portal 使用共享 z-index token，禁止通过 `9999` 等局部数值逃逸。

## File Rules

- 新组件 CSS 按 controls、overlays、navigation、feedback、data-display 分文件。
- 新 feature 视觉进入 focused CSS，不追加到 `components.css`。
- `components.css`、`teammates.css`、`settings.css`、`sidebar.css` 从 UI 2.0 开始只减不增。
- 生产 CSS 文件建议不超过 500 行，硬上限 800 行；超过上限按组件或领域责任拆分。
- 删除组件时同一切片删除无引用 selector 和 dark override。
- Package、conversation、shell 和 feature CSS 只由各自入口加载一次；页面组件不得动态导入
  第二套全局样式。

## Tokens

颜色、圆角、间距、阴影、z-index、motion 全部引用共享 token。Feature 可以定义领域尺寸
token，但不能重新定义主题色或控件高度。

组件外观遵守[共享组件主题合同](../../component-theme-presentation.md)：通用默认值 →
官方主题参数 → 唯一共享组件消费 → 页面布局。新增组件参数必须有共享默认值；
Feature 不按具体主题或 dark/light 写分支，不重定义共享组件背景、圆角、边框、阴影和焦点，
也不通过局部变量遮蔽、后加载、额外 specificity 或 `!important` 绕过这一所有权。
主题可调整批准的组件圆角和局部材质，不能改变控件高度、命中区域或 foundation 尺度。

## Legacy Compatibility

兼容 wrapper 可暂时保留测试 class；最终外观必须归共享组件与参数所有，不能只依赖“后加载”压过旧规则。
兼容 class 不得成为新代码 API。完成页面迁移后立即删除对应旧外观 selector。

兼容组件只能转发属性、事件和测试选择器，不能复制 JSX、状态或 CSS。已无生产引用的 facade、
selector、hard-coded color 和旧动效直接删除；未决兼容项统一登记在
[迁移与遗留兼容](../migration/README.md)。

## Verification

- `rg` 检查 direct colors、legacy classes 和 Radix imports。
- 结构调整记录 CSS 行数、删除 selector、color literal、`!important` 和 compatibility class 变化。
- 主题适配是新组件/模块的交付项；覆盖所有内置主题、背景开关与相关状态，按[组件验收门槛](../../component-theme-presentation.md#新增模块与主题的验收门槛)提供证据。
