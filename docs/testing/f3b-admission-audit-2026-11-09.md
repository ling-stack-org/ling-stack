# F3-B 真实试点准入审计

状态：**BLOCKED**  
审计日期：2026-11-09  
审计基线：`origin/main@0e56b76babc3ea10d7b023df3d5aaaab8a3c0011`（PR #659 合并提交）  
审计范围：只读代码、测试、分支和运行资源核查；不启动真实 Run、Provider、模型或付费任务，不修改并发实现工作区。

## 结论

F3-B 当前不能启动真实试点。主线已经具备 F1/F2 和 F3-A/F4-01 的证据格式与只读适配，但 F3-B 要求的执行授权、可信隔离、真实运行闭环和统一预算仍未在同一已合并基线上闭合。

并发写任务的启动条件更严格：安全并发分支已有本地实现和受控传输测试，但分支尚未推送、创建 PR 或合并；其自身计划也明确真实 Provider、packaged、跨平台及 review/CI/merge 门禁未完成，普通 workflow 写并发保持关闭。因此不能把在途分支的代码或测试当作当前主线的执行许可。

## 基线与证据

| 项目 | 实际证据 | 判定边界 |
| --- | --- | --- |
| 主线 | `origin/main` 为 `0e56b76b`，对应 [PR #659](https://github.com/ling-stack-org/ling-stack/pull/659) 的合并提交 | 该提交包含 F3-A/F4-01 适配，不包含安全并发实现 |
| F3-A 回归 | `node --test --test-concurrency=1 scripts/framework-assurance/execution-evidence.test.mjs scripts/framework-assurance/diagnostics.test.mjs`：31 passed、0 failed、0 skipped、0 cancelled | 证明 fixture 身份和只读诊断边界，不证明真实 Host 执行 |
| F3-A 语义 | `execution-evidence.mjs` 将结果标为 `fixture_replay`、`not_assessed`，并保留 `no_live_run_acceptance` 限制 | 不能作为 A13 真实 Run -> evaluation 证据链 |
| 在途并发实现 | 本地 `codex/ling-multi-agent-safe-concurrency` 为 `9af03db6`，相对主线 `33 behind / 36 ahead`；`codex/ling-multi-agent-delivery` 为 `3243b25d`，相对主线 `33 behind / 38 ahead` | 两分支均不是主线祖先；GitHub 分支搜索没有对应远端分支 |
| 在途测试 | 在途分支包含 `workflow-isolated-parallel-integration.test.mjs`、`workflow-multibranch-integration.test.mjs`、`workflow-repository-fence.test.mjs` 等文件 | 文件存在和本地记录不能替代合并后的 review、CI、Host 及平台验收 |
| 当前资源现场 | 当前审计 worktree 独立；`LING_STACK_HOME` 未设置。另一会话已有隔离 fixture 占用 `64817`，Web preview 占用 `4192`；磁盘可用约 `370 GiB` | 没有为 F3-B 建立专用运行数据根、端口、输出目录和完整资源余量证明；本轮不抢占现有进程 |

## 八项准入核查

| # | 准入项 | 状态 | 证据与影响 |
| --- | --- | --- | --- |
| 1 | 源代码进入核实的实施基线 | **阻断** | 主线搜索不到 `pi_host_isolated_files_v1`、`workflow-isolation-execution`、`workflow-merge-apply`、`workflow-repository-fence` 和并发集成测试。相关实现只在本地未合并分支。 |
| 2 | Host 权限、能力分类、admission、执行代次约束 | **阻断** | 主线有普通 Run/approval/fence/runner acceptance 合同，但没有 F3-B 隔离 profile 的完整 Host admission 链。不能把通用权限检查推导成并发执行授权。 |
| 3 | 可信隔离执行 profile | **阻断** | 主线没有可供 F3-B 试点使用的真实 isolated execution profile。当前规则禁止回退到主机任意 shell；在途分支的 Pi/Host 测试使用受控 transport，未形成主线上的真实 Provider 或 packaged 证据。 |
| 4 | Run/evaluation 身份、artifact 封存和恢复 fixture | **部分通过** | F3-A 31 项回归覆盖 Run/WorkUnit/Attempt、runtime/fence、快照、artifact、claim、unknown effect 和幂等重放。适配器返回 `fixture_replay/not_assessed`，真实 Run/Host 封存接口仍未接入，因此仅满足 fixture 前置，不满足 A13。 |
| 5 | 停止、取消、重启、授权失效 | **阻断** | 主线已有普通执行的取消和恢复合同；没有证据证明这些语义已绑定到 F3-B 的 isolated execution type。必须在同一合并基线证明取消后的真实 drain、旧 generation 拒绝、权限撤销和重启不重派。 |
| 6 | 并发写隔离、结果汇合、冲突、审批应用 | **并发阶段阻断** | 在途分支包含对应模块和受控测试，但未合并；其计划仍将普通 workflow 写并发保持关闭。串行 F3-B 也不能借用这组未合并证据。 |
| 7 | Provider/总预算/子调用/工具循环/grader/在途预留/超限停止 | **阻断** | 主线 `runner-pi` 已有单次 Provider invocation 的 reservation/settlement 端口和 token 约束；尚未证明一个 F3-B 试点跨所有子调用、工具循环、grader 的总金额/币种账本、在途预留和超限停止。未知用量必须停止继续派发。 |
| 8 | 数据目录、端口、输出位置和资源余量隔离 | **阻断** | 当前 worktree 与代码目录隔离，但本轮没有专用 `LING_STACK_HOME`、端口和输出目录；现场已有其他会话 fixture。磁盘余量已观察，CPU、内存、Provider 配额和本次完整运行资源预算尚未形成证据。 |

## 允许继续的范围

- 继续维护 F3-A/F4-01 的 fixture、只读诊断和报告格式。
- 对安全并发分支做代码审查、合同核对和测试设计；不把它当成主线能力，不在其工作区补改动。
- F5 继续做 A17 合同检查；不实现节点重跑、不新增 rerun API、按钮、状态或审批动作。

## 解阻顺序

1. 将安全并发实现拆成可审查 PR，完成 review、CI、合并，并记录实际 `main` merge SHA；重新以该 SHA 进行审计。
2. 在合并基线上补齐并验证 F3-B 的 Host admission、isolated profile、generation/fence、停止与恢复闭环；没有 profile 时保持 blocked。
3. 把真实 Host 的 Run/WorkUnit/Attempt、artifact 封存和 evaluation 关联接入 F3-A，留下 A13 的真实证据链及失败/缺证据/取消未确认停止样本。
4. 为一次试点冻结 Provider、模型、金额和币种、最大请求/Token、工具循环、子代理、grader、在途预留、超限和未知结果停止规则，形成 A14 账本。
5. 运行前为本次试点分配独立 `LING_STACK_HOME`、workspace cwd、临时输出目录和未占用端口，核实其他会话的端口/进程不被复用；先运行 T01 只读任务。
6. 只有 A13/A14 通过后，才按 A15 评估并发；写任务必须先完成 worktree、结果汇合、冲突、审批应用、取消和重启的联合验收。

在上述条件全部闭合前，结论保持 `F3-B BLOCKED`；不运行真实模型、Provider 或付费任务。
