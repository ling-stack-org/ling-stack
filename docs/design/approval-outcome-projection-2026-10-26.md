# 审批结果与执行生命周期分离

状态：2026-10-26 源码修复及自动回归已完成；当前 packaged GUI 后继复验待做。

## 真实问题

A-01 真实拒绝案例中，Host action、approval、checkpoint 均为 `denied`，
没有命令 prepared/settled、输出或文件，亦无重试。客户端却把命令行显示为 `Failed`。
根因是 canonical projector 为聚合将 `denied/expired` 映射为 `failed`，
共享事实行只拿到了折叠后的执行生命周期，无法保留审批结果。

## 契约

- `ConversationTimelineItemBase.approvalOutcome` 仅保存 Host 的 `denied | expired`。
  action 必须同时有 `approvalId`；独立 supplemental approval 使用本身的权威 ID/status。
- 此属性是派生视图，不新增 SQLite 字段或表，不写回历史，不创建权限或操作。
- lifecycle 仍为非成功 `failed`，terminal evidence、fan-in 和批次隔离规则不变。
  不能把“拒绝”当作命令执行失败，也不能把“未执行”当成完成整个任务。
- standalone approval 的 `decision` 从原始状态映射。`expired` 不折为 `denied`，
  普通 `failed/blocked` 不推断用户拒绝。
- 唯一 `TimelineFactRow` 优先显示明确的 `Denied/Expired`；命令、文件、工具、审批
  及普通/私聊/频道/子 Agent 均复用，不增加各表面的特例。
- 不生成虚假的模型收尾。没有模型文本时，现有 Host 通用失败正文仍是 Host 状态，
  不声称它是 agentMessage 的真实模型总结；本次仅恢复原子审批事实的明确表达。

## 验证与后继

- 永久回归：`apps/web/test/approval-outcome.regression-1.test.mjs`，使用真实 canonical
  projector 与 React SSR renderer，不调用模型、Runner 或真实数据库。
- 修前 9 fail/1 pass；相邻 raw-decision 检查另复现 expiry→denied 和 generic failed→denied。
  修后 11/11，Core UI 全套 197/197，Web 全套 858/858，Web typecheck 与 diff-check 通过。
- 四份源码/测试冻结输入完成独立只读差量审阅，0 项确定问题。
- 真实原案例、截图/AX、只读 Host 及不可覆盖的失败判定位于本地
  `output/e6-20260928/a01-deny-packaged-live-20261026/`；源码修复证据在相邻
  `a01-deny-outcome-repair-20261026/`。这些本机产物不纳入公开提交。
- 后继新包只读打开原 A-01 历史，核对“已拒绝”且 marker 仍不存在；不重发或批准原命令。
  expiry 的自动回归不代替真实时钟过期验收；R-02 真断线、其它 P3/P4/P5 仍开放。
