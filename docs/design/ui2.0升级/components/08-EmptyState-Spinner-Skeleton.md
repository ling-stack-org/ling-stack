# EmptyState、Spinner 与 Skeleton

## EmptyState

默认 compact：可选 icon、title、一句 description、一个 primary action。不得用大卡片或
长说明占满第一屏。搜索无结果与真实空数据使用不同文案和行动。

## Spinner

用于短时、局部、不可预知长度操作。大小 `14/16/20px`。只在发起动作的控件或区域显示，
不能因单行检查让整个页面旋转。

Spinner 是批准的连续 linear 动画。Reduced motion 下优先使用静态 loading icon + 文案；
Skeleton shimmer 同样停止或改为静态 surface。

## Skeleton

用于首屏结构加载，尺寸必须与真实内容一致，避免 layout shift。表格、列表、Inspector
使用各自骨架，不用通用大灰块。

## State Precedence

error > empty/no-result > loading overlay > content。已有内容刷新时保留内容并显示局部
refreshing，不退回全页 Skeleton。

## P1C Implementation Status

- 共享 `EmptyState`、`Skeleton` 和既有 `Spinner` 已进入 `@ling-stack/ui-react` focused CSS。
- `OperationEmptyState` compatibility adapter 已在 T13-P.2-D 删除；Council 最后一个调用方直接消费共享
  `EmptyState`，Feature 只通过公开 `className`/slot API 持有布局，不重绘 package 私有 selector。
- 1280 Dark 截图曾暴露 action 文本裁切，最终合同要求 action visible label 的 `scrollWidth <= clientWidth + 1`，
  证据见 `evidence/features/council-empty-selection/metadata.md`。
- Model Workbench 空态已完成 `1280x800` Dark 代表性证据；旧空态 CSS 的逐页删除仍属于模块迁移。
