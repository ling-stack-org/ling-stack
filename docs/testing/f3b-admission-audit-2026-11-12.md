# F3-B 合并基线准入复核

- 状态：**BLOCKED**
- 审计日期：2026-11-12
- 核实基线：`main@f3282429759c79b4c06dbf0f11fc8128dba53932`（PR #688 合并提交，包含 PR #684）
- 前置合并：PR #676 `5990095f`、PR #685 `df5c03df`
- 审计范围：合并后源码、托管门禁、只读准入投影及临时 SQLite/Git/HTTP 回归；不启动真实 Provider、模型、生产 daemon、付费任务或共享 Store。

## 结论

PR #684 已进入 `main`，Run/evaluation 的精确只读关联和 collector 到 F4 的适配已经成为核实基线。合并后的本地复验通过：framework-assurance `98/98`、Daemon assurance 相关回归 `182/182`、API client 关联回归 `7/7`，Contracts/API client/Daemon 构建和 Daemon 源码及测试类型检查通过。PR 的托管门禁最终为 30 项成功；其中 core 1 的一次失败定位为主线时间边界抖动，单 job 重跑成功，未修改该无关测试或放宽门禁。

这些证据证明准入观察链已经可以在不派发任务的条件下复核 Run、Host 和 evaluation 的身份关系。它们没有证明真实 Provider、真实生产 daemon、完整费用账本、跨平台 packaged 运行或独立试点资源已经验收，因此 F3-B 真实试点继续保持 `BLOCKED`。

## 当前证据

| 能力 | 合并后状态 | 证据边界 |
| --- | --- | --- |
| Run/evaluation 关联 | 已进入 main | 指定 evaluation、16 字段 identity/key、六份冻结输入、Host snapshot、Run/root lineage、artifact owner/字节和 grade pin 可只读核对；不写 Store、不触发 recovery 或 dispatch |
| Host 准入观察 | 已进入 main | 只投影已初始化 Store 的 Run/WorkUnit/Attempt、fence、停止、隔离流程、completion 和预算状态；缺证据仍 fail-closed |
| F4 诊断适配 | 已进入 main | collector 输出经过三字段 F4 envelope 校验，保留 `not_assessed`，不把观察升级为执行授权 |
| 多代理隔离与合并 | 已有受控实现 | SQLite/Git fixture 覆盖 binding、candidate、approval、apply 和冲突边界；普通 workspace 写入并发和真实跨平台联合验收仍关闭 |
| F3-02 试点前置预检 | 已实现离线前置 | 可信绑定的 T01 trial manifest、七组输入摘要、Provider/model、预算/停止规则、外置目录、loopback 端口和 CPU/内存/磁盘检查均 fail-closed；`ready-for-review` 仍不授予执行权限 |

## 八项准入核查

| # | 准入项 | 状态 | 当前判断 |
| --- | --- | --- | --- |
| 1 | 源代码进入核实的实施基线 | **通过** | #676、#685、#684 均已合并；当前核实基线为 `main@9af7ad54`，不再依赖未合并分支。 |
| 2 | Host 权限、能力分类、admission、执行代次约束 | **部分通过** | 只读投影会核对 safety plan、Tool Broker、binding、fence、Attempt 状态和停止证据；真实生产 Host 生命周期和跨平台 acceptance 仍未完成。 |
| 3 | 可信隔离执行 profile | **部分通过** | `pi_host_isolated_files_v1`、scope plan 和 binding 有受控回归；真实 Provider、packaged 和全部目标平台仍未验收。 |
| 4 | Run/evaluation 身份、artifact 封存和恢复 | **部分通过** | 精确 evaluation association 已合并并通过 182 项 Daemon 相关回归；普通 artifact 没有独立 Attempt/fence 归属，真实 producer、恢复和完整 live grade 链仍缺证据。 |
| 5 | 停止、取消、重启、授权失效 | **部分通过** | 受控回归覆盖取消、旧 Attempt、drain 和未知 effect；真实 daemon 重启、权限撤销和不重派仍未验收。 |
| 6 | 并发写隔离、结果汇合、冲突、审批应用 | **部分通过** | 多代理隔离、candidate、approval、apply 和冲突有受控覆盖；真实跨平台联合运行、重启/取消期间的合并应用仍未验收，普通 workspace 写并发保持关闭。 |
| 7 | Provider/总预算/子调用/工具循环/grader/在途预留/超限停止 | **部分通过** | 根 Run 和 delegation 的 reservation、charge、pending/unknown/over/missing/invalid 可投影并阻断；尚无一次真实试点的完整 Provider、子调用、工具循环和 grader 账本。 |
| 8 | 数据目录、端口、输出位置和资源余量隔离 | **部分通过，真实试点仍阻断** | 已有离线 preflight 严格冻结并检查独立 `LING_STACK_HOME`、workspace、trial output、loopback 端口和 CPU/内存/磁盘最低值；尚未在真实 Host 启动前后完成资源重查和完整 T01 验收。 |

## 下一步

F3-02 的受控前置能力已完成：T01 输入、Provider/model 标识、金额/币种、请求和 token 上限、工具循环、子代理、grader、在途预留和未知结果停止规则已固化为可信绑定的 trial manifest，并通过零派发资源 preflight。新边界测试 9/9，framework-assurance 全套 107/107，测试类型检查通过。该结果不启动模型或 Provider，也不把 preflight 结果当作真实验收。

下一步是补齐 A13/A14 所需的 Host 生命周期、隔离执行、恢复/取消、结果合并和完整预算账本证据；资源与端口在真正启动前必须再次检查。只有在这些真实证据完整且获得单独运行授权后，才重新评估一次只读 T01；在此之前不启动 F3-B 真实试点，也不打开并发写任务。

前一阶段的准入证据前置记录见[2026-11-10 审计](f3b-admission-audit-2026-11-10.md)。
