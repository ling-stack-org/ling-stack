# Button 与 IconButton

图标来源、尺寸、stroke 和固定 action map 见 [Icon 系统与功能映射](11-Icon系统与功能映射.md)。

## API

```ts
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ControlSize = "sm" | "md" | "lg";
```

Button 支持 `variant`、`size`、`loading`、`disabled`、`leadingIcon`、`trailingIcon`、
`asChild` 和原生 button props。IconButton 支持 `label`、`tooltip`、`pressed`，label 必填。

公开展示合同：`leading`、`label`、`trailing` 使用稳定 `data-ling-button-slot`；页面布局只能通过
`--ling-button-leading-size`、`--ling-button-trailing-size`、`--ling-button-icon-slot-display`、
`--ling-button-label-display` 和 `--ling-button-label-text-align` 调整 slot 几何。Feature 不得命中
`.ling-ui-button-leading/label/trailing` 内部 class，也不得依赖 span 顺序。

## Dimensions

- 高度 `32/36/40px`；IconButton 宽高一致。
- 图标 `14/16/18px`，icon + text gap `6px`。
- padding `10/12/14px`，不因 loading 改变宽度。
- 圆角 `6px`，工具条紧凑按钮可用 `4px`。

## Semantics

- 每个任务区域最多一个 primary。
- danger 只用于删除、撤销不可恢复操作或明确破坏行为。
- ghost 用于工具条和低频操作；不能用低对比度隐藏主行动。
- loading 自动 disabled，spinner 替代图标但保留文字和宽度。
- disabled 原因必须通过邻近说明、Tooltip 或可聚焦 wrapper 可获知。
- hover/press 使用 `120ms` fast token，只动画颜色、背景、边框和阴影；按钮不缩放或位移。
- mutation loading 防止重复提交，失败后立即恢复，不重播页面动画。

## States And Tests

验证 hover、focus-visible、active、pressed、disabled、loading、icon-only、长中英文、
`ling-light` / `ling-dark`、自定义 Theme Pack fixture、reduced motion。Icon 与文字中心线误差不得肉眼可见。
