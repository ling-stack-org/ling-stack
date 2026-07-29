# Toast 与 InlineFeedback

## Related Docs

- [全局反馈消息迁移矩阵](../migration/10-全局反馈消息迁移矩阵.md)
- [Motion 与状态转场](../foundations/08-Motion与状态转场.md)

## Component Boundary

- `@ling-stack/ui-react` 提供 `ToastProvider`、`ToastViewport`、`Toast`、
  `InlineFeedback` 和 Field error 展示原语。
- `apps/web/src/shared/ui` 只提供 i18n 和默认 scope adapter。
- Feature 不直接导入 Radix Toast，不创建 viewport，不管理自动消失 timer。
- Toast 是 overlay，不占据页面布局；InlineFeedback 属于具体对象或字段。

## Toast

用于不影响下一步的短暂反馈：保存、复制、创建、排队。全局 top-center，最多三条。

- success/info 默认 `3000ms`；warning `5000ms`；error 默认 `6000ms`。
- scope 相同的 toast 替换而非堆叠。
- 中性 surface、小 tone bead/线条，不使用整条绿色或红色背景。
- 动效为 slide/fade；reduced motion 只淡入淡出。
- enter `180ms`、exit `160ms`；3/5/6 秒是生命周期，不写进 CSS keyframe。
- scope 替换时更新内容，不重新堆叠完整入场动画。
- hover/focus 暂停自动关闭；Esc 只关闭当前 focus Toast。
- 最多同时显示 3 条，不遮住 Dialog 主行动和 Desktop 窗口 chrome。
- loading 结果必须就地 update 为 success/error，不额外创建第二条。

## Taxonomy

| Feedback | Primitive | Default lifetime |
|---|---|---:|
| save/copy/create/import/queued success | Toast success | 3000ms |
| non-blocking information | Toast info | 3000ms |
| non-blocking warning | Toast warning | 5000ms |
| lightweight recoverable error | Toast error + optional inline repair | 6000ms |
| field validation | Field error | until input/validation changes |
| object action failure | InlineFeedback | until retry, object change or dismiss |
| readiness/daemon/API key/diagnostic blocker | InlineFeedback | until resolved |
| progress and busy | initiating control/status row | until action settles |
| destructive decision | Dialog | until cancel/confirm |

## InlineFeedback

用于字段错误、阻塞、审批、修复路径、删除警告和需要持续阅读的失败。它靠近对应对象，
支持 title、message、action、details。

## Decision Rule

用户若必须阅读信息才能继续，就不能只用 Toast。成功可短暂；破坏、阻塞和失败持续到
解决或关闭。

## Provider

全局只挂载一个 ToastProvider。Feature 不创建 viewport，不调用 browser alert。

## Verification

- 一个真实操作只产生一个反馈所有者，不同时显示 page success 和 Toast。
- 所有 Toast 有稳定 scope，不使用文案本身或随机值作为唯一去重语义。
- 阻塞失败在 Toast 消失后仍然保留可执行的修复路径。
- `ling-light`、`ling-dark`、自定义 Theme Pack fixture、Desktop 和 reduced motion 都通过。

## P1C Implementation Status

- `@ling-stack/ui-react` 已实现 `ToastProvider`、`ToastViewport`、`Toast`、`useToast` 和
  `InlineFeedback`；scope dedupe、loading 原位更新、最多三条、hover/focus pause、Esc 和
  `3/5/6s` 生命周期由共享层负责。
- Web 的 `LingToastProvider` 现在只是 i18n/default adapter，不再拥有 timer、viewport DOM 或视觉。
- Profile 的局部 Toast/timer/CSS 已删除；保存成功使用全局 Toast，加载、保存和图片错误持续 inline。
- Plugin 和 Media Production 已接入同一 adapter；Media Production 不再覆盖 `2000ms` 生命周期。
- T13-O.32 为 InlineFeedback detail 增加稳定 `data-ling-inline-feedback-slot="detail"`；Feature 只可通过该
  public slot 做领域布局，不得选择 `.ling-ui-inline-feedback-detail` 等 package 私有 class。Plugin 两个旧
  selector 已迁移，UI package `51/51` 与 Plugin focused/legacy/theme 回归通过。
- 当前状态为 `implemented`，不是全产品 `verified`；剩余页面按
  [全局反馈消息迁移矩阵](../migration/10-全局反馈消息迁移矩阵.md) 后续切片迁移。

## T13-P.8 Feedback Ownership Closeout

- AI 队友 MCP 保存、Settings MCP Check/Sync、Model Workbench 行检查、Channel Protocol/Composer 和
  Plugin CUA Copy 的轻量成功统一进入共享 Toast viewport；页面、行和 Drawer 不再保留成功副本。
- 对象操作失败继续由对应 Tab、行、Inspector 或 Drawer 的 InlineFeedback 持有，直到同对象重试、配置身份
  改变或 owning surface 关闭。运行时 `status/checkedAt/updatedAt` 更新不等于配置身份变化。
- busy 只落在发起按钮；Feature 不创建 Toast provider/viewport，不为成功调用 `setTimeout`。
- Web lint 当前锁定 `inline-success`、`teammate-mcp-save-status`、`cua-install-copy-status` 为 `0`；Channel
  Composer、Settings MCP 和 Provider Settings 的 feedback timer 预算为 `0`。Conversation Copy 的
  `1400ms` button microstate 是唯一登记例外，不承担 Toast 生命周期。
- focused/legacy 集成按最终合同 `55/55`，Channel/Teammates/Plugin/Model/Dark 模块回归按修复后的精确重跑
  `156/156`，正式反馈截图 `14/14`；typecheck、lint、i18n 和 diff check 通过。
- 该切片关闭上述 reachable owner，不代表全产品反馈迁移完成。`AppShell.tsx` 通用 `errorMessage` 与独立
  Profile `.profile-message` 继续进入后续语义审查。
