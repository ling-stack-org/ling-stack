# Work Board 产品合同

Status: pending and hidden from released navigation
Implementation: [Work Board plan](14-Work-Board-implementation-plan.md)

## Purpose

Work Board 是 workspace 级执行台账，回答当前有哪些工作、由什么 Task/Run/Approval/Channel/External Work
承载、下一步是什么，以及数据是否完整新鲜。

它不是第二套 Task/Run/Approval/Thread 数据库，不是自动调度器，也不是拖拽项目管理看板。重新开放前保持
从 Sidebar、键盘顺序和辅助技术树隐藏。

## Authority

- Task、Run、Approval、Workflow Step、External Work 和 durable WorkItem 继续由各自领域持久化。
- Board 只建立可丢弃 read projection，按稳定 ID 合并、去重、筛选、排序和导航。
- durable WorkItem 对相同 source 的 derived row 具有优先级；不按标题猜测重复。
- 任一 source 达到服务端上限或刷新失败时标记 capped/stale，不把局部数据描述为全量。
- Board 不在列表内批准、取消运行、编辑任务或执行外部 mutation；行动导航到真实 owner。

## Surface

- 默认按需处理、进行中和已结束分组，提供搜索、状态筛选、紧凑行和按需 Inspector。
- 一行只显示一个主状态和一个明确下一步；raw diagnostics、route 和完整 event 进入详情。
- initial loading、真实空态、筛选无结果、selected missing、retained stale 和长列表分别处理。
- 列表和 Inspector 各自内部滚动，页面不滚；不使用营销卡片墙或拖拽列。
- Channel 中只能显示同一 projection 的有界过滤结果，不创建 per-channel ledger。

## Mutations

- claim、heartbeat、release、complete 和 fail 仅针对 durable WorkItem，并遵从 token/dependency 语义。
- busy/error 绑定具体 item 和 action；失败保留权威行，迟到响应不覆盖新选择。
- 私聊创建 Task 后可以导航到 Board，但不得自动创建或启动 Run。
- Approval 只导航到审批 owner；External Work 只使用已有 route capability。

## Reopening Gate

重新显示入口前必须完成 implementation plan 中的 workspace 全量 projection、竞态、内部滚动、模型化错误、
Light/Dark、双 viewport、键盘和浏览器验收。历史 Web closeout 证据不能替代本次重新开放验证。
