# F5 节点重跑合同前置验证

- 状态：**合同前置完成，真实节点重跑 BLOCKED**
- 日期：2026-11-13
- 实施分支：`codex/f5-rerun-contract`
- 范围：A17 的纯 intent/Host observation 合同和 fail-closed 评估；不启动 Provider、模型、Daemon、Store 或付费任务。

## 已实现

`packages/contracts/src/node-rerun.ts` 提供严格的 `NodeRerunIntentV1`、Host observation 解析和 `evaluateNodeRerunAdmission()`。它要求源 Run/Attempt/node、图版本、输入 artifact、上游依赖输出和源快照摘要保持不可变绑定，并检查：

- 源 Run 已结束，源 Attempt 已停止；
- lease 已不存在或已过期，旧 fence 已释放；
- 本地和外部效果已结算，未知或非幂等外部效果阻断；
- 下游依赖闭包完整，复用的上游输出存在内容摘要；
- 当前策略可读取、指纹未漂移、权限仍有效；
- 目标 execution identity、fence 和 approval 必须由 Host 重新生成。

通过时结果仍是 `eligible_for_host_admission`，并固定 `executionAuthorized: false`。任何输入或观察解析失败均返回 `blocked`。

## 验证

| 检查 | 结果 |
| --- | --- |
| Contracts build | 通过 |
| Contracts typecheck（含新增 TS 测试） | 通过 |
| Contracts test:ci | `158/158` passed，0 failed、0 skipped、0 cancelled |
| `git diff --check` | 通过 |

新增回归覆盖合法前置、活动执行、未知/非幂等效果、策略漂移、权限撤销、依赖缺失、源身份漂移、未知字段、无效摘要和 accessor 不执行。

## 明确未完成

本批没有新增 API、UI、数据库列、Run/Attempt 状态、审批动作或 Host 执行接线。真实节点重跑必须另行完成 Host 当前复核、新 Attempt/fence、重新审批、下游失效传播、取消/重启/重复点击和真实 Provider 证据；因此 F5 真实执行仍保持 `BLOCKED`。
