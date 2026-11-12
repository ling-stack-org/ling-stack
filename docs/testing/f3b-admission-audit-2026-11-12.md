# F3-B 合并基线准入复核（Host readiness 收口）

- 状态：**BLOCKED**
- 审计日期：2026-11-12
- 核实基线：`main@878e422ae90b18ce0a7f9607ddf86f4fb2e6e94e`（PR #691 合并提交）
- 功能基线：PR #690 `edb820f00c0b10542e546620cd2b5782219f8231` 已合并，Host readiness review gate 已进入主线
- 前置合并：PR #676 `5990095f`、PR #685 `df5c03df`、PR #684 `9af7ad54`、PR #688 `f3282429`、PR #689 `91a4469f`、PR #690 `edb820f0`、PR #691 `878e422a`
- 审计范围：合并后源码、托管门禁、只读准入投影及临时 SQLite/Git/HTTP 回归；不启动真实 Provider、模型、生产 daemon、付费任务或共享 Store。

## 结论

PR #684 已进入 `main`，Run/evaluation 的精确只读关联和 collector 到 F4 的适配已经成为核实基线。PR #690 又将 Host readiness review gate 合入主线：它强制 lifecycle、completion、budget、isolation、admission 五域及跨域 lineage 一致，并始终保持 `executionAuthorized=false`。PR #691 随后同步了主线状态文档，当前核实提交为 `878e422a`。本轮重新运行的 Host readiness 相关受控 Daemon 套件为 `204/204`，framework-assurance 全套为 `127/127`，`corepack pnpm typecheck:ci-tests` 和 Daemon 构建通过。

这些证据证明准入观察链已经可以在不派发任务的条件下复核 Run、Host 和 evaluation 的身份关系。它们没有证明真实 Provider、真实生产 daemon、完整费用账本、跨平台 packaged 运行或独立试点资源已经验收，因此 F3-B 真实试点继续保持 `BLOCKED`。

## 当前证据

| 能力 | 合并后状态 | 证据边界 |
| --- | --- | --- |
| Run/evaluation 关联 | 已进入 main | 指定 evaluation、16 字段 identity/key、六份冻结输入、Host snapshot、Run/root lineage、artifact owner/字节和 grade pin 可只读核对；不写 Store、不触发 recovery 或 dispatch |
| Host 准入观察 | 已进入 main | 只投影已初始化 Store 的 Run/WorkUnit/Attempt、fence、停止、隔离流程、completion 和预算状态；缺证据仍 fail-closed |
| F4 诊断适配 | 已进入 main | collector 输出经过三字段 F4 envelope 校验，保留 `not_assessed`，不把观察升级为执行授权 |
| 多代理隔离与合并 | 已有受控实现 | SQLite/Git fixture 覆盖 binding、candidate、approval、apply 和冲突边界；普通 workspace 写入并发和真实跨平台联合验收仍关闭 |
| F3-02 试点前置预检 | 已实现离线前置 | 可信绑定的 T01 trial manifest、七组输入摘要、Provider/model、预算/停止规则、外置目录、loopback 端口和 CPU/内存/磁盘检查均 fail-closed；`ready-for-review` 仍不授予执行权限 |
| Host readiness review gate | 已进入 `main@878e422a`（功能合并于 `edb820f0`） | 强制 lifecycle、completion、budget、isolation、admission 五域及跨域 lineage；输出 `ready-for-trial-review` / `blocked`，始终 `executionAuthorized=false`；不代表真实 Host 验收 |

## 八项准入核查

| # | 准入项 | 状态 | 当前判断 |
| --- | --- | --- | --- |
| 1 | 源代码进入核实的实施基线 | **通过** | #676、#685、#684、#688、#689、#690、#691 均已合并；当前核实基线为 `main@878e422a`，Host readiness 已进入主线。 |
| 2 | Host 权限、能力分类、admission、执行代次约束 | **部分通过** | 主线 review gate 强制五域投影、当前 Attempt/runtime/fence/generation 一致、Tool Broker `enforce` 和 fail-closed blocker；真实生产 Host 生命周期和跨平台 acceptance 仍未完成。 |
| 3 | 可信隔离执行 profile | **部分通过** | `pi_host_isolated_files_v1`、scope plan 和 binding 有受控回归；真实 Provider、packaged 和全部目标平台仍未验收。 |
| 4 | Run/evaluation 身份、artifact 封存和恢复 | **部分通过** | 精确 evaluation association 已合并；本轮包含 association、Host evidence、预算、隔离与交付边界的定向 Daemon 套件 `204/204` 通过。普通 artifact 没有独立 Attempt/fence 归属，真实 producer、恢复和完整 live grade 链仍缺证据。 |
| 5 | 停止、取消、重启、授权失效 | **部分通过** | 受控回归和候选 gate 覆盖取消未确认、旧 Attempt、drain、settle 和未知 effect 的阻断；真实 daemon 重启、权限撤销和不重派仍未验收。 |
| 6 | 并发写隔离、结果汇合、冲突、审批应用 | **部分通过** | 多代理隔离、candidate、approval、apply 和冲突有受控覆盖；候选 gate 会消费这些只读投影，但真实跨平台联合运行、重启/取消期间的合并应用仍未验收，普通 workspace 写并发保持关闭。 |
| 7 | Provider/总预算/子调用/工具循环/grader/在途预留/超限停止 | **部分通过** | 根 Run 和 delegation 的 reservation、charge、pending/unknown/over/missing/invalid 可投影并阻断；尚无一次真实试点的完整 Provider、子调用、工具循环和 grader 账本。 |
| 8 | 数据目录、端口、输出位置和资源余量隔离 | **部分通过，真实试点仍阻断** | 已有离线 preflight 严格冻结并检查独立 `LING_STACK_HOME`、workspace、trial output、loopback 端口和 CPU/内存/磁盘最低值；尚未在真实 Host 启动前后完成资源重查和完整 T01 验收。 |

## 下一步

F3-02 的受控前置能力已完成：T01 输入、Provider/model 标识、金额/币种、请求和 token 上限、工具循环、子代理、grader、在途预留和未知结果停止规则已固化为可信绑定的 trial manifest，并通过零派发资源 preflight。Host readiness 已合入主线，强制 lifecycle、completion、budget、isolation、admission 五域和跨域 lineage 一致；当前受控回归包括 Host readiness 相关 Daemon `204/204` 与 framework-assurance `127/127`，类型检查和 Daemon 构建通过。该结果不启动模型或 Provider，也不把 preflight 或 Host readiness report 当作真实验收。

下一步仍需补齐 A13/A14 所需的真实 Host 生命周期、隔离执行、恢复/取消、结果合并和完整预算账本证据。资源与端口在真正启动前必须再次检查。只有在这些真实证据完整且获得单独运行授权后，才重新评估一次只读 T01；在此之前不启动 F3-B 真实试点，也不打开并发写任务。

前一阶段的准入证据前置记录见[2026-11-10 审计](f3b-admission-audit-2026-11-10.md)。
