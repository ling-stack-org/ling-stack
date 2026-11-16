# F5-03 Host admission plan 接线

- 状态：**Host admission plan 已接线，真实节点重跑仍 BLOCKED**
- 日期：2026-11-13
- 实施分支：`codex/f5-host-observation`
- F5-02 基线：`41c5576dc`
- 范围：在 F5-02 Host 只读观察之上生成确定性的 Host-owned admission plan；不创建 Run、WorkUnit、Attempt、lease、fence、approval 或 artifact，不启动 Provider、模型、生产 Daemon 或付费任务。

## 实现内容

### Contracts

`packages/contracts/src/node-rerun.ts` 新增：

- `NodeRerunHostAdmissionPlanV1`：绑定 intent、幂等键、源 snapshot digest、source/current policy fingerprint；明确 WorkUnit、Run、Attempt、fence 由 Host mint，approval 重新按当前 policy 生成，graph mutation 为 `none`，Provider dispatch 为 `disabled`；
- `nodeRerunHostAdmissionPlanFingerprintV1()`：对相同 intent、源 pins、策略指纹和固定动作集合生成稳定 plan fingerprint；
- `createNodeRerunHostAdmissionPlanV1()`：只接受已通过 F5-01 的 eligible admission，拒绝 blocked、源身份不一致和 policy 不完整的输入；
- `NodeRerunHostAdmissionResponseV1`：返回 admission、是否调用纯评估器和可选 plan，执行授权始终为 `false`。

### Daemon / API

- 新增 `POST /runs/:runId/node-rerun/admission?cwd=...`；
- 严格解析请求体，核对 URL Run 与 intent source Run；只读取已初始化 Store，不触发冷 Store 初始化或 recovery；
- 调用 `observeNodeRerunAdmission()`，只有 `eligible_for_host_admission` 才生成 plan；blocked 结果不生成 plan；
- `LingDaemonClient.admitNodeRerun()` 使用 encoded Run scope 和 JSON body；
- 相同 intent 重试返回相同 plan；幂等键变化产生不同 plan；源 snapshot 或当前 policy 漂移由 F5-02 观察器 fail-closed。

## 回归覆盖

| 场景 | 结果 |
| --- | --- |
| 合法观察生成 Host-owned plan | 通过 |
| 相同输入 planId / fingerprint 稳定 | 通过 |
| 幂等键变化不复用原 plan | 通过 |
| blocked / policy drift 不生成 plan | 通过 |
| source snapshot 漂移不生成 plan | 通过 |
| HTTP 重复提交返回相同 plan | 通过 |
| HTTP 计划生成前后 Store 表计数不变 | 通过 |
| route parser、API client encoded Run scope | 通过 |

## 验证

| 检查 | 结果 |
| --- | --- |
| Contracts `typecheck` | 通过 |
| Contracts `test` | `161/161` passed，0 failed、0 skipped、0 cancelled |
| Daemon `typecheck` | 通过，含生产与测试 TypeScript |
| Daemon `build` | 通过 |
| F5 Daemon 定向回归 | `9/9` passed，0 failed、0 skipped、0 cancelled |
| API client `typecheck` | 通过 |
| API client `test` | `142/142` passed，0 failed、0 skipped、0 cancelled |

## 未完成边界

本批 plan 是只读的 Host admission 结果，不是执行提交凭证。尚未创建新的 Run/WorkUnit/Attempt/fence/approval，尚未实现下游失效、取消/重启/重复点击的真实写入语义，也未启动真实 Provider、模型、生产 Daemon 或付费任务。后续真正提交必须在 Host 写事务内重新核对 source snapshot、当前 policy 和幂等键，并单独取得 A17/A18 真实验收证据。
