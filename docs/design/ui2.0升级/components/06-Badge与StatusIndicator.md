# Badge 与 StatusIndicator

## Components

- Badge：短分类或计数，如 Chat、Image、3 pending。
- StatusIndicator：状态点 + 状态文字，如 Ready、Failed、Waiting approval。

## Tones

只允许 `neutral/success/warning/danger/info`。状态优先级由 feature view-model 派生，组件
不判断业务枚举。同一对象默认只显示一个主状态。

## Visual

Badge 高 `20/24px`，不使用大面积实色。Status dot `6px`，状态文字 `12px`。成功态不铺
绿色胶囊；错误和警告必须有文字，不只显示颜色。

## Content

raw storage state 不直接显示。Feature 将其映射为产品状态，并在 Details 保留原值。
长状态不能挤压主行动，应截断或换为 compact copy。
