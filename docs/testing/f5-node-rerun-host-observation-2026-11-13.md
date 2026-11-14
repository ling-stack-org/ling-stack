# F5-02 Host-backed 节点重跑观察

- 状态：**Host 只读观察已实现，真实节点重跑仍 BLOCKED**
- 日期：2026-11-13
- 实施分支：`codex/f5-host-observation`
- 基线：`41c5576dc`
- 范围：在现有 Daemon Store 上实现 F5-01 合同的 Host 观察前置；不创建 Run/Attempt、lease、fence、approval 或 artifact，不启动 Provider、模型、生产 Daemon 或付费任务。

## 实现内容

`packages/daemon/src/features/runs/node-rerun-observation.ts` 提供
`observeNodeRerunAdmission()`。它在一个 SQLite `readSnapshot()` 内完成以下只读检查：

- 严格解析 intent，并核对 Run、WorkUnit、Attempt、WorkflowStep 和 Workflow 的 lineage；
- 重算完整 graph/node SHA-256 digest，核对已接受 graph、物化步骤、边和依赖列表；
- 核对源输入及上游输入/输出 artifact 的 Run owner 和 SHA-256；
- 计算完整上游/下游依赖闭包，拒绝缺失、重复、非终态或无摘要事实；
- 读取 stop evidence、lease、semaphore、terminal fence audit 和 Host effect blocker；
- 从当前 Store policy 重新解析权限指纹，并在源 snapshot 与 intent pins 完全一致后才调用
  `evaluateNodeRerunAdmission()`。

事实不完整时返回脱敏 blocker，`evaluationInvoked` 为 `false`。合法观察即使得到
`eligible_for_host_admission`，结果仍固定 `executionAuthorized: false`。

## 回归覆盖

| 场景 | 结果 |
| --- | --- |
| 完整 SQLite source observation、零写入和不授权执行 | 通过 |
| 源 Run 或 Attempt 缺失 | 在纯评估器前 fail-closed |
| graph digest 或物化依赖漂移 | 在纯评估器前 fail-closed |
| 源/依赖 artifact 缺失或无 SHA-256 | 在纯评估器前 fail-closed |
| 当前 policy 漂移 | 调用纯评估器并返回 `policy_drift` / `permission_not_current` |

## 验证

| 检查 | 结果 |
| --- | --- |
| Daemon 生产类型检查 | 通过 |
| Daemon build | 通过 |
| Daemon 测试类型检查 | 通过 |
| `node-rerun-observation.test.ts` | `5/5` passed，0 failed、0 skipped、0 cancelled |
| `git diff --check` | 通过 |

## 未完成边界

本批没有 API/UI caller、Host 新 Attempt/fence/approval minting、下游失效传播、取消/重启/重复点击处理或真实 Provider/Daemon 执行。A17/A18 的真实运行验收仍需后续单独完成；本批只证明 Host 当前事实可以被一致、可审计地观察并 fail-closed 地交给纯合同评估器。
