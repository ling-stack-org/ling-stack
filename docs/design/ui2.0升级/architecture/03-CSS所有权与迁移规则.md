# CSS 所有权与迁移规则

详细目标文件树、cascade 和 import 顺序见
[CSS 目标目录与加载顺序](06-CSS目标目录与加载顺序.md)。逐文件迁移和指标预算见
[CSS 逐文件拆分矩阵](../migration/06-CSS逐文件拆分矩阵.md) 与
[Selector 与硬编码颜色清理](../migration/07-Selector与硬编码颜色清理.md)。

## Layers

- UI package：tokens 和基础组件视觉。
- App shell：全局 grid、窗口、Sidebar 容器。
- Feature CSS：领域布局，如 Canvas、Timeline、Conversation Feed。
- 禁止 Feature CSS 重写 `.ling-ui-*` 内部结构。

## File Rules

- 新组件 CSS 按 controls、overlays、navigation、feedback、data-display 分文件。
- 新 feature 视觉进入 focused CSS，不追加到 `components.css`。
- `components.css`、`teammates.css`、`settings.css`、`sidebar.css` 从 UI 2.0 开始只减不增。
- U13 删除旧大文件，最终任何生产 CSS 文件不超过 800 行。
- 删除组件时同一切片删除无引用 selector 和 dark override。

## Tokens

颜色、圆角、间距、阴影、z-index、motion 全部引用共享 token。Feature 可以定义领域尺寸
token，但不能重新定义主题色或控件高度。

## Legacy Compatibility

兼容 wrapper 可暂时保留测试 class，但共享 CSS 必须后加载并拥有最终视觉。兼容 class
不得成为新代码 API。完成页面迁移后立即删除对应旧 selector。

## Verification

- `rg` 检查 direct colors、legacy classes 和 Radix imports。
- 每个 PR 记录 CSS 行数变化和删除的 selectors。
- 每个 PR 记录 color literal、`!important` 和 compatibility class 变化。
- `ling-light` / `ling-dark` Theme Pack E2E 是 CSS 迁移必跑项。
