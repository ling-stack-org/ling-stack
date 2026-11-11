# F3-B 真实试点准入审计（准入证据前置增量）

- 状态：**BLOCKED**
- 审计日期：2026-11-10
- 实施起点：`origin/main@841dab4d`；2026-11-11 复验基线：`origin/main@0490f71f`
- 实施分支：`codex/ling-f3b-assurance-evidence`
- 审计范围：准入证据投影、合同、客户端适配器和受控 SQLite/Git 回归；不启动真实 Provider、模型、daemon 生产进程或付费任务。

## 结论

F3-B 真实试点仍不能启动。本轮已经实现“准入证据前置”能力：Daemon 可以从已初始化的
workspace Store 只读投影 Run/WorkUnit/Attempt、fence、停止证据、artifact digest、delegation
完成状态、预算和 isolated workflow 的 binding/merge/approval/apply 状态；framework-assurance
客户端可以把该投影与冻结任务输入关联，并在未知或不完整时保持 `not_assessed` 或 fail-closed。

这项能力解决了“真实试点开始前如何核查证据”的接口缺口，但不等于真实试点已经获得执行许可。
实现尚在独立分支，且真实 Provider、生产 daemon、packaged、跨平台、完整 evaluation 关联和
独立资源预算尚未完成同一合并基线上的验收。因此本轮没有运行真实模型、Provider 或付费任务。

## 已实现的证据边界

| 能力 | 实现与证据 | 当前边界 |
| --- | --- | --- |
| 只读 Host 投影 | `GET /runs/:id/assurance-evidence`；只解析已初始化 Store，不创建 Store、不触发 recovery、不派发 Run | 仍需合并后在正式 daemon 路径复验 |
| 执行身份 | Run、WorkUnit、Attempt、runtime instance、fencing token、Run/WorkUnit/Attempt snapshot digest | 投影不包含 claim token、任务输入、resume handle |
| 生命周期与停止 | 当前/历史 Attempt、generation、取消、drain、effect settlement 和 reusable 状态；isolated admission 要求生命周期 drained、Attempt terminal 且 effect confirmed | 受控 fixture 已验收，真实进程重启和外部 effect 仍待验收 |
| 结果与预算 | delegation completion、artifact pin、reservation/charge、pending/over/unknown/missing/invalid 状态；未满足的 completion 或预算状态阻断 isolated admission，原始 issue/blocker 保留 | 尚未形成一次真实试点的完整 Provider/子调用/grader 账本 |
| 隔离与合并 | safety plan、isolated binding、integration round、effects/receipts、branch result、candidate、approval、apply | 仅受控 SQLite/Git fixture；不打开普通 workflow 写并发 |
| 客户端适配 | `collectLiveExecutionEvidence()` 读取投影并关联冻结任务输入；输出 `live_execution`、`not_assessed` | 不把读取结果自动升级为 pass，也不触发执行 |

## 验证结果

| 检查 | 结果 |
| --- | --- |
| framework-assurance 全套 | `node --test scripts/framework-assurance/*.test.mjs`：98 passed、0 failed、0 skipped、0 cancelled |
| Daemon 证据/API/隔离/预算/准入/解析回归 | 51 passed；包括 completion 与预算阻断、7 个 nullable 字段、collector 拒绝非法输入、损坏 artifact 错误脱敏和摘要字段类型边界 |
| API client 全套 | 139 passed |
| Contracts/API client/Daemon 构建 | `build:ci` 全部通过 |
| Contracts/API client/Daemon 类型检查 | `typecheck` / `typecheck:ci` 全部通过，含新增 TypeScript 测试 |
| 工作树格式检查 | `git diff --check` 通过 |

## 八项准入核查

| # | 准入项 | 状态 | 证据与影响 |
| --- | --- | --- | --- |
| 1 | 源代码进入核实的实施基线 | **阻断** | 证据合同、Daemon endpoint 和客户端适配已在本分支实现，但尚未进入 `main`；PR review/CI/merge 仍是前置条件。 |
| 2 | Host 权限、能力分类、admission、执行代次约束 | **部分通过** | projection 会暴露 safety plan、Tool Broker、binding/fence 并在不满足时 fail-closed；尚未完成合并基线上的完整 Host 生产验收。 |
| 3 | 可信隔离执行 profile | **部分通过** | 受控回归验证 `pi_host_isolated_files_v1`、scope plan 和 binding；真实 Provider、packaged 和平台边界未验收。 |
| 4 | Run/evaluation 身份、artifact 封存和恢复 | **部分通过** | 真实 SQLite fixture 已投影 Run/WorkUnit/Attempt、artifact digest 和历史 Attempt；evaluation grade 仍明确不在本接口中。 |
| 5 | 停止、取消、重启、授权失效 | **部分通过** | 取消、旧 Attempt、drain 和未知 effect 有受控回归；真实 daemon 重启、权限撤销和不重派仍待同一合并基线验证。 |
| 6 | 并发写隔离、结果汇合、冲突、审批应用 | **部分通过** | 受控 Git/SQLite 回归覆盖 candidate、branch result、approval 和 apply；普通 workflow 写并发仍关闭，真实跨平台联合验收未完成。 |
| 7 | Provider/总预算/子调用/工具循环/grader/在途预留/超限停止 | **部分通过** | reservation、charge、unknown/pending/over/missing/invalid 投影和 fail-closed 回归已具备；尚无真实试点的全链路账本。 |
| 8 | 数据目录、端口、输出位置和资源余量隔离 | **阻断** | 本轮只使用临时 SQLite/Git fixture 和测试 HTTP server；尚未为真实试点冻结独立 `LING_STACK_HOME`、端口、输出目录和 Provider 预算。 |

## 解阻顺序

1. 完成当前分支的审查、CI、推送和合并，记录实际 main merge SHA。
2. 以合并后的 SHA 重新核对 endpoint、合同、隔离 profile、生命周期和预算证据。
3. 接入真实 Host Run 与既有 evaluation 的完整关联，补齐失败、缺证据、取消未确认停止样本。
4. 为试点冻结 Provider、模型、金额/币种、请求/Token、工具循环、子代理、grader、在途预留和未知结果停止规则。
5. 为一次只读 T01 试点分配独立数据根、workspace、输出目录和端口；A13/A14 通过后才评估并发。

在上述条件全部闭合前，结论保持 `F3-B BLOCKED`；本接口只能提供证据和阻断理由，不能替代真实执行许可。
