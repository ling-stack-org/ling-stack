# Dialog 与 Drawer

## Implementation Status

`implemented`（foundation，2026-07-18）：

- `@ling-stack/ui-react` 已实现受控 `Dialog`、`DialogContent/Header/Body/Footer` 和右侧 `Drawer`；
- Radix 负责 Portal、focus trap、outside dismiss 和基础 Escape 语义；
- Ling wrapper 负责 busy/dismissible、六档尺寸、主题、ARIA、内部滚动和 presence motion；
- P3 foundation 的历史实现曾由 `CreateDialogShell` 兼容 adapter 承接频道、AI 队友、Council、
  Media Jobs 和 Media Production 调用，使这些入口先共享新交互；
- Channel 创建提交具备真实 mutation busy，提交中阻止 Esc、遮罩和关闭按钮；
- 共享 package `16/16`，Dialog 专项浏览器 E2E `2/2`，Media/Teammate 兼容回归 `34/34`。

T13-P.3-R canonical closeout：`CreateDialogShell` component、barrel export 和生产引用均已删除，最终
guard 为 `0/0`。Channel Create 现在直接组合 shared `Dialog`、`DialogContent`、`DialogHeader`、
`DialogBody`、`DialogFooter` 与 `Select`；原有 busy、Esc、遮罩关闭和焦点归还合同不变。上述 P3
测试数字是历史阶段证据，不改写为本次 closeout 结果。

尚不能标记整组 `verified`：Drawer 还没有完成代表性业务 surface 迁移，Windows/真实 Desktop
overlay 证据也不属于本切片现有证据。

## API

Dialog 和 Drawer 受控：`open`、`onOpenChange`、`title`、可选 `description`、`body`、
`footer`、`closeLabel`、`dismissible`、`busy`、`size`。Drawer 另有 `side`，首版仅 `right`。

## Layout

- Header：标题、必要状态、关闭按钮。
- Body：唯一滚动区域。
- Footer：次级行动在左/前，单一 primary 在右/后。
- Dialog 宽 `360/520/720px`；Drawer `320/400/480px`。
- viewport 边距最少 `16px`，最大高度 `calc(100vh - 32px)`。

## Behavior

- 默认 Esc、overlay click 关闭并恢复 trigger 焦点。
- destructive confirmation 仍可关闭；只有 mutation 正在提交时临时阻止关闭。
- Header 标准关闭图标保留 `aria-label` 与原生 `title`，但不再挂独立 Radix Tooltip。关闭图标常被
  auto-focus；若 Tooltip 同时成为最上层 DismissableLayer，第一次 Esc 只会关闭 Tooltip，破坏单 Esc 合同。
- 打开新 overlay 前关闭不兼容 overlay，禁止叠多个同级 Dialog。
- raw preview、diff、checksum 和 diagnostics 在 body 内折叠。
- Dialog 内容 `180ms` enter、`120ms` exit；Drawer `240ms` enter、`180ms` exit。
- 使用 Radix Presence 保留 exit；快速反向操作从当前 computed position 继续。
- reduced motion 下取消 translate/scale，只保留最多 `80ms` opacity 或立即切换。

## Variants

- Create/Edit：必要字段 + 摘要 + 单 primary CTA。
- Confirm：后果、保留内容、不可逆性；danger CTA。
- Inspector Drawer：summary-first，details 折叠。
- Progress：步骤、当前状态、失败修复；成功后按产品规则关闭或保留结果。

## Acceptance

验证 focus trap、Esc、outside、busy、长内容、键盘、`ling-light` / `ling-dark`、两种 viewport、内部滚动和
关闭后的焦点恢复。
