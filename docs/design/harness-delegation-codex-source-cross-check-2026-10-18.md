# H10：Codex 开源实现对照，2026-10-18

本记录回答“R1–R4 是否有 Codex 开源实现可借鉴”。它是源码核对结果，
不是 H10 预算决策批准，也不是 Ling 动态委派的实现或验收记录。
现有持久化基础和主计划见
[H10 checkpoint](harness-delegation-storage-checkpoint-2026-10-09.md) 与
[Harness plan](ling-harness-gap-closure-implementation-plan.md)。

## 固定来源

- `openai/codex` 的本次 GitHub API 读取版本：
  `8c076942cb70fba8e5c4732c23f1faabc4aed484`。
- 官方 [Subagents 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)
  已实际读取，确认父级沙盒/审批继承及并发配置。
- 以下判断来自对应版本的实际源码读取；没有执行 Codex Rust 测试。
  测试文件只作为上游的行为规格证据。

## R1：共享根预算有直接参照，持久化预留合同仍需 Ling 实现

[rollout_budget.rs](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/rollout_budget.rs)
使用 `OnceLock<Mutex<RolloutBudgetState>>` 管理一个 root-thread session tree 的共享预算。
`configure` 通过 `get_or_init` 初始化；`record_usage` 在同一锁内增加 usage。
它使用合法的 `codex_rollout_budget_units`，否则按 sampling/prefill 权重计算 token 单位。
负数或非有限的 provider units 被拒绝。这里的 weighted units 不等于货币金额。

[runtime.rs](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/agent/control/runtime.rs)
将 `Arc<RolloutBudget>` 放在共享 `LocalAgentRuntime`；
[budget.rs](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/agent/control/budget.rs)
在额度耗尽时返回 `SessionBudgetExceeded`。
上游 [rollout_budget 测试](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/tests/suite/rollout_budget.rs)
包含 `subagent_usage_draws_from_the_shared_budget` 和
`exhausted_budget_fails_current_and_later_turns`。

可借鉴：整棵树共享权威计数，并发更新串行化，预算耗尽成为真实错误。
本次所读实现的 usage 账本在内存中，按响应 usage 记账；它不证明 Ling 所要求的
SQLite root snapshot、spawn 前费用/token reservation、结算和 crash/reopen 合同已实现。

## R2：等待超时与任务截止时间必须区分

[multi_agents/wait.rs](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/tools/handlers/multi_agents/wait.rs)
验证并 clamp `timeout_ms`，用 Tokio `Instant` 和 `timeout_at` 限制这次等待。
这是观察操作的超时，不能据此声称整棵 Agent 树到期、已取消或已停止工具。

在上述预算和 Agent runtime 模块中，没有确认与 Ling 所提
“RootRun 冻结绝对 deadline，重启不延长”相同的持久化合同。
该结论限定于本次读取范围，不宣称整个 Codex 产品没有其它时间限制。
Ling 的持久化 deadline 是为它自身的 durable Run 恢复语义提出的设计。

## R3：没有核实到等价的金额价格表和费用预留实现

本次读取的共享预算基于 token/weighted units，未确认按 provider/base URL/model
冻结币种单价、spawn 前预留金额及按固定价格结算的实现。
不能把 provider 的 budget units 或 token usage 直接当成美元。

Ling 使用自定义 Provider/relay，若配置金额上限，仍需明确可信价格来源。
未知价格时拒绝 cost-budgeted spawn 是 Ling 的建议合同，不应标注为 Codex 原实现。
它不影响政策允许的仅 token/time 受控流程。

## R4：继承当前有效配置有直接参照，恢复时的精确规则不完全相同

[child_config.rs](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/agent/child_config.rs)
由父回合有效配置创建 child snapshot，按当前 step 设置模型，
`apply_spawn_agent_runtime_overrides` 明确复制当前审批、cwd 和 permission-profile snapshot，
避免陈旧 config 导致子 Agent 的 Provider/权限与父级不一致。

[control/spawn.rs](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/agent/control/spawn.rs)
在 cold reload 接缝还会校验 parent owner，并对 effective permission profiles 求交。
因此不能把 Codex 描述为“恢复时永远完全照抄旧权限、不再核当前权威”。

Ling 应保存 child 最初的 effective authority，并在恢复时叠加当前撤权/限制校验；
父级后来新增权限不能自动扩大旧 child 的权威。
SQLite 中与 child 创建同事务冻结 effective values，是 Ling 当前架构需要实现的持久化部分。

## 还应直接借鉴的异常生命周期

- [registry.rs](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/agent/registry.rs)：
  `reserve_spawn_slot` 在创建前用 CAS 预留并发名额；未 commit 的 `SpawnReservation`
  在 Drop 时归还名额与 path/nickname reservation。
- [spawn_guard.rs](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/agent/control/spawn_guard.rs)：
  provisional child 失败/取消后执行关闭、丢弃持久化、等待在途 Open edge 写入，再写 Closed，
  防止迟到 Open 把已清理 child 恢复成活动节点。清理失败被记录。
- `control/runtime.rs`：关闭时停止新 admission、触发整树 cancellation、等待 tracked members，
  收集有界 shutdown failures。只有 drain 完成后才取得稳定 shutdown report。

## 源码核对时判词（2026-10-18，决策状态由下节覆盖）

R1 的共享根预算和 R4 的当前权限继承有明确源码参照；R2 的根级 durable deadline、
R3 的金额预算，以及 Ling 的事务 reservation/settlement 不能冒充已核实的 Codex 实现。
R1–R4 的产品决策仍 pending；用户本轮回复是要求源码核对，没有选择批准选项。
动态 child producer 保持关闭，既有静态频道协作与其它 E6 工作继续推进。

## 用户决策更新：2026-10-19

在说明上述源码边界后，用户明确回复：**“采用四条规则，继续 H10（推荐）”**。
这覆盖上节和旧 checkpoint 中 R1–R4 的 pending 状态；历史未答记录保留，不回写成当时已批准。

1. **R1**：Host 在 RootRun 启动准入时持久化不可变总预算快照；全树共用权威账本，
   child 创建和容量预留同一事务。可编辑 Goal 不是后续可改写的执行预算权威。
2. **R2**：整树共享根级绝对 deadline，child 不能晚于根期限；等待超时不冒充取消，
   重启不能重置或延长 deadline。
3. **R3**：金额预算使用 Host 版本化、作用域绑定的可信价格表并冻结依据；
   价格未知只拒 cost-budgeted spawn，不因此禁用政策允许的 token/time 模式。
   weighted token units 仍不当成金额；外部结算未知不能虚报已退款或费用为零。
4. **R4**：child 创建时同事务固定继承后的有效权限和预算；恢复仍核当前撤权，
   父级新增权限不能自动扩权旧 child。

本次选择确定结构规则，不授权虚构任何数值额度、价格或模型使用量。
实现复用现有 Core/Daemon 边界，不新增第二套 orchestrator；并发超额、失败回滚、
迟到结算、重启、权限漂移与重复 spawn 均须取得隔离测试证据。
H10 产品链、H11/H12 和 packaged 验收尚未完成，dynamic child producer **仍保持关闭**，
直到真实权威生产者及相应 gates 完成。静态频道和其它 E6 工作继续。
