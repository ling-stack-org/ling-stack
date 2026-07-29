# Popover、Tooltip 与 Menu

## Implementation Status

`implemented`（Popover foundation，2026-07-18）：

- `@ling-stack/ui-react` 已实现 Portal-backed `Popover/Trigger/Anchor/Content/Close`；
- Content 支持 `sm/md/lg/content`、collision padding、available width/height、内部滚动、
  Light/Dark、enter/exit 和 reduced motion；
- overlay token 顺序保证 nested Popover/Menu 位于 Dialog 之上、Toast/Tooltip 之下；
- Automation 创建器的五个轻量选择器已迁共享 Popover，旧 absolute positioning、局部 z-index
  和 strict-console 视觉 owner 已删除；
- Esc 只关闭浮层并恢复 trigger 焦点，打开另一浮层时保持单一 Popover；
- package suite `20/20`，P1B 专项 E2E `3/3`，目标回归 `34/34`。

证据：[P1B Navigation And Lightweight Overlay Evidence](../evidence/features/ui2-navigation-overlays/metadata.md)。

本组尚未标记 `verified`：Sidebar/ActionMenu、全部业务 Popover、自定义 Theme Pack fixture 和
Desktop surface 仍待后续页面切片；三类会话 Summary 明确保留到 P5/P6。

## Selection

- Tooltip：解释 icon 或短标签，不放操作和阻塞信息。
- Dialog/Drawer Header 的标准关闭 `X` 是例外：使用 `aria-label` + `title`，不挂 Radix Tooltip，避免
  auto-focus 后 Tooltip 抢占当前模态层的第一次 Esc。
- Menu：低频命令集合，不放复杂字段。
- Popover：短摘要、轻量筛选或少量交互。
- 需要长内容、表单或历史记录时使用 Drawer/Dialog。

## Menu

行高 `36px`，固定 `20px` icon cell，label 可带快捷键；routine action 默认无描述。
danger item 与普通操作分组，不用整菜单红色。支持 disabled 和 reason。

## Tooltip

hover/focus 延迟一致，最大宽 `240px`，不遮挡 trigger。IconButton 默认 tooltip 文案等于
accessible label。触屏和 disabled 控件不能依赖 tooltip 才能完成任务。

Tooltip 使用 `120ms` opacity + `2px` translate；Menu/Popover 使用 `120ms` opacity + `4px`
translate。关闭支持反向 transition，reduced motion 取消位移。

## Popover

使用 Portal 和 collision detection。宽度由内容类型规定，必须设置 max-height 和内部滚动。
打开 Dialog、Drawer 或互斥 Popover 时关闭当前 Popover。

Popover 在 Dialog 内使用时仍通过 Portal 渲染，但层级必须高于 Dialog content；Feature 不得
通过 `position: absolute`、raw `top/left/bottom` 或局部 z-index 再次接管定位。

## Acceptance

验证方向键、Enter/Space、Esc、outside click、focus return、viewport collision、长文案、
`ling-light` / `ling-dark`、自定义 Theme Pack fixture 和 z-index。
