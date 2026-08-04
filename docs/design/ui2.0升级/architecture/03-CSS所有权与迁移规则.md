# CSS 所有权与迁移规则

本文件是 CSS 目录、级联、兼容和删除规则的唯一长期合同。历史逐文件迁移数字由 Git
保留，不再维护独立矩阵。

## Layers

- UI package：tokens 和基础组件视觉。
- App shell：全局 grid、窗口、Sidebar 容器。
- Feature CSS：领域布局，如 Canvas、Timeline、Conversation Feed。
- 禁止 Feature CSS 重写 `.ling-ui-*` 内部结构。

级联顺序固定为：reset/preflight -> foundation tokens -> theme tokens -> shared components ->
conversation surfaces -> app shell -> feature -> temporary legacy。第一方 CSS 必须进入明确 layer，
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

## Legacy Compatibility

兼容 wrapper 可暂时保留测试 class，但共享 CSS 必须后加载并拥有最终视觉。兼容 class
不得成为新代码 API。完成页面迁移后立即删除对应旧 selector。

兼容组件只能转发属性、事件和测试选择器，不能复制 JSX、状态或 CSS。已无生产引用的 facade、
selector、hard-coded color 和旧动效直接删除；未决兼容项统一登记在
[迁移与遗留兼容](../migration/README.md)。

## Verification

- `rg` 检查 direct colors、legacy classes 和 Radix imports。
- 结构调整记录 CSS 行数、删除 selector、color literal、`!important` 和 compatibility class 变化。
- `ling-light` / `ling-dark` Theme Pack E2E 是 CSS 迁移必跑项。
