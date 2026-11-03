# Ling 多 Agent 安全并发详细设计

状态：P1-P5 均已有本地实现，受控 Provider 的真实 daemon/Web 联合链路已验证；
冻结输入的完整相关回归通过，独立 dependency-security lane、真实 Provider、packaged、
跨平台和 review/CI/merge 门禁仍开放，不是发布完成声明。
Owner：Ling maintainers。
最后核对：2026-11-03，基于 PR #614 合并后的 `main`。
文档类型：Reference / Explanation。
权威边界：[Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md)
继续拥有总体产品设计；本文细化安全并发、隔离执行与合并协议。
交付顺序与完成标准：[实施计划](ling-multi-agent-safe-concurrency-implementation-plan.md)。

## 1. 目标与范围

用户给 Ling 一个任务，Ling 可以让独立的分析、检查和代码实现分支并行执行，
同时保持一份可追溯的工作结果。用户能看清谁在执行、为什么等待、哪些修改尚未合入，
也能取消、处理冲突或拒绝合并，而不会损坏自己的未提交工作。

本轮路线固定为：

1. 副作用分类与安全并行策略。
2. isolated worktree merge。
3. 并行 workflow 的重启、取消、冲突和审批验收。
4. 自定义模板 registry 与 authoring UI。
5. workflow graph 可视化。

不新增 `Super-agent` 产品、第二套 orchestrator、Run 状态机或审批系统。
不把通用模型评分、模型路由优化、requirement shaping 扩展和自动发布并入本轮。
`external_mutation` 与 `release` 始终默认串行；本地 worktree 隔离不能证明外部副作用安全。

## 2. 当前基线与证据

下表描述 #614 合并时的基线差距。当前已接入显式安全 metadata、Host 执行约束、
原子准入、隔离执行/集成/审批、恢复、模板创作和 graph/list；交付边界见实施计划。
真实 daemon 的本地浏览器验证不替代真实 Provider、packaged 或完整平台验收，普通写并发仍关闭。

| 已有能力 | 代码锚点 | 本轮需要补的边界 |
| --- | --- | --- |
| 静态 workflow 编译、inline custom template、依赖与 branch/join 元数据 | [workflow-templates.ts](../../packages/daemon/src/features/channels/workflow-templates.ts)、[workflow-graph.ts](../../packages/daemon/src/features/channels/workflow-graph.ts) | 显式副作用和并行策略贯穿编译、存储与 Run 快照 |
| smart scheduling 与多候选启动 | [smart-scheduler.ts](../../packages/daemon/src/features/channels/smart-scheduler.ts)、[orchestrator.ts](../../packages/daemon/src/features/channels/orchestrator.ts) | 当前主要按 required tools 推断；不能替代实际执行约束 |
| 通用 read-only deny 与 Docker artifact mount | [session-permissions.ts](../../packages/core/src/session-permissions.ts)、[docker.ts](../../packages/daemon/src/runtime/sandbox/docker.ts) | 已有执行组件不等于 workflow 已绑定 readonly/artifact-only，需补实际准入与不可降级约束 |
| preparing/linked start owner、authority fingerprint、重复启动防护 | [workflow-step-start-owner.ts](../../packages/core/src/workflow-step-start-owner.ts)、[channel-workflow-start-store.ts](../../packages/core/src/storage/sqlite/channel-workflow-start-store.ts) | 把安全策略、执行绑定和资源预留纳入同一准入边界 |
| Attempt fencing、Tool Broker、动态 delegation 与预算基础 | [harness](../../packages/core/src/harness)、[Host delegations](../../packages/daemon/src/features/harness/delegations)、[Tool Broker](../../packages/daemon/src/features/harness/tool-execution/broker.ts) | 复用当前主线；功能开关和验收边界不能因代码存在而被跳过 |
| typed command cwd、operation effect gate 与 Host 执行证据 | [workflow-command-cwd.ts](../../packages/daemon/src/features/runs/workflow-command-cwd.ts)、[workflow-operation-effect-gate.ts](../../packages/daemon/src/features/runs/workflow-operation-effect-gate.ts) | 不能只改 Runner cwd；隔离绑定必须覆盖 operation、文件工具和证据 |
| channel/direct managed worktree 与 dirty cleanup 拒绝 | [managed-worktrees.ts](../../packages/daemon/src/features/workspaces/managed-worktrees.ts) | 不是 step 级分支所有权、merge coordinator 或审批协议 |
| workspace patch undo/reapply | [workflow-workspace-change-recovery.ts](../../packages/daemon/src/features/channels/workflow-workspace-change-recovery.ts) | 当前跨执行目录不可用，不能当作多 worktree 合并与撤销 |
| evidence finalizer、Completion Gate 与 TerminalReport | [workflow-step-finalizer.ts](../../packages/daemon/src/features/channels/workflow-step-finalizer.ts)、[workflow-completion-gate.ts](../../packages/daemon/src/features/channels/workflow-completion-gate.ts)、[报告协议](ling-agent-terminal-report-protocol.md) | 纳入隔离产物、合并结果和未确认副作用，不从 UI 数量推断成功 |

旧 Harness worktree 只作为候选参考，不是新分支基线；逐模块取舍见实施计划。
已有串行与并行基础不是待重建清单，也不能单独证明新协议完成；当前实现与验收范围
以实施计划为准。

## 3. 领域分层与所有权

```text
accepted ChannelWorkflowStep DAG (static, frozen)
  -> Ling orchestrator selects candidates
  -> Host admission + existing start owner + leases
  -> Run / WorkUnit / fenced Attempt
       -> Tool Broker / native enforcement
       -> optional DelegationStep tree (dynamic overlay)
       -> isolated step worktree when explicitly enabled
  -> branch output packets + verification artifacts
  -> Host integration barrier at a declared fan-in
  -> Completion Gate -> TerminalReport
  -> same ConversationTurn / OperationCell
```

- DAG 是已接受的依赖图；模型不能在运行中新增、删改或重排节点。
- 动态 delegation tree 记录某个 Run 的子执行，不改写 DAG，不另建调度产品。
- integration barrier 是编译时声明、Host 执行的汇合约束，不是运行时偷偷插入的模型 step。
- workflow/Run/审批仍存于原 workspace store。执行目录变化不创建第二个业务数据库。
- Core 拥有类型、事务和不变量；Daemon 拥有策略准入、物理执行与恢复；Web 只投影真实状态。
- artifact digest 证明内容未变，不证明权限来源；授权仍来自 Host-owned producer 和当前 fence。

## 4. 副作用与执行约束

### 4.1 元数据契约

沿用总体设计中的 `WorkflowStepSideEffectClass`、`WorkflowStepParallelPolicy` 和
`WorkflowStepExecutionSafety`，贯穿 built-in template、custom template、graph node、
compiled step metadata、contracts DTO 和不可变 Run request snapshot。

| 类别 | 可用能力 | 默认并行 |
| --- | --- | --- |
| `analysis_readonly` | 受限读取；通过受控 artifact 服务提交分析结果 | 仅显式 opt-in 且 Host 可强制只读时 |
| `test_artifact_only` | 受限检查；仅写本 Attempt 的 artifact/scratch 目录 | 仅 Host 验证 artifact-only profile 后 |
| `workspace_write` | 写已授权的本地文件 | 默认否；第二阶段满足隔离协议后才可 opt-in |
| `external_mutation` | 修改远端服务、工单、PR、消息或其他外部状态 | 否 |
| `release` | 发布、部署、外部 merge、回滚等高风险操作 | 否 |

`parallelPolicy` 保留 `autoParallel`、`maxParallelSiblings`、`resourceKeys`、
`requiresArtifactOnly`、`cancelSiblingsOnFailure`。`maxParallelSiblings` 必须为正整数，
不得超过有效 channel/workspace 上限；两个旧/新并行上限同时存在但不一致时拒绝新编译。
`autoParallel` 缺失按 false；组内有效上限取所有参与约束的最小值，不取最大值放宽限制。

新请求中的未知枚举、非法策略组合、重复或越界资源声明返回结构化校验错误。
旧行缺字段保持可读且串行；只允许精确匹配已知内置模板版本的确定性默认映射。
不能因为 skill 名称包含 review/test，或模型承诺“不写文件”，就认定安全。
自定义模板的声明只是一项请求，不能自行签发只读能力或扩大工具权限。

### 4.2 Host 必须真正限制执行

准入同时检查声明和实际能力。Prompt、tool 名称清单、执行后 `git diff` 或成功退出码
都不是 artifact-only 的证明。

审批前，Host 冻结不可变的 scope/policy plan，记录：

- workflow/step、安全策略版本与计划 identity/digest；
- 真实工具清单、原生 executor/profile identity、可读与可写根目录；
- command/input scope、网络与 secret scope，以及独占资源；
- template/graph fingerprint、canonical workspace 和计划 execution root。

该计划进入 pre-gate 的 semantic authority basis；此时不要求尚未创建的 Task、
start owner、Run/WorkUnit/Attempt。审批消费后，Host 才将同一计划绑定到真实执行
lineage，并在 dispatch 前生成受保护的 effective safety snapshot，包含当前 owner/fence、
实际 executor/目录及资源 receipt。正常 preparing -> linked 只填入执行身份，不改变
已批准的计划或 semantic basis；实际 scope/profile 不匹配则停止，不能补签新权限。

`analysis_readonly` 禁止 workspace 写入、任意 shell、外部写操作及通过插件/CUA 绕过。
`test_artifact_only` 要求 Host 命令 executor 对 workspace 只读，仅开放本 Attempt 的
artifact/scratch 写路径；依赖安装、更新 snapshots、生成源码不能混入该 profile。
模型 Provider 的受控调用与 Runner 任意网络访问分别授权，不能因前者可用而放开后者。

现有 restricted command runtime 只在其真实支持的 capability 范围内复用。
平台、Runner 或插件没有可验证的限制能力时，该分支不得自动并行；可在用户明确授权后
按普通写入类串行执行，或明确阻塞。禁止 raw spawn fallback。
串行不是额外权限，也不豁免正常审批、沙盒和 operation binding。

每次 effect dispatch、审批后恢复、Attempt resume 和工具清单变化都重验当前权限。
发现声明与能力不符时停止新 effect，记录 `workflow_safety_mismatch`；旧 Run 不原地改类
继续执行。重新编译或显式 retry 后，以新的 safety fingerprint 和审批继续。

### 4.3 默认内置流程

第一组默认安全并发为 `product-review` 之后的 `design-review` 与
`engineering-review`。`implementation` 仍串行；`ship` 始终严格审批且串行。
`code-review` 与 `qa` 只有在 QA artifact-only profile 确实可用时才并发。
不支持该 profile 时保留串行或明确等待，不降低隔离要求来追求并行数量。

## 5. 调度与原子资源准入

### 5.1 候选选择

候选按 `position`、稳定 step id 排序。对每个候选检查依赖、门禁、有效安全能力、
现存活动分支、资源和预算，再选择可同时运行的集合。
一个等待审批的分支不必冻结其他独立安全分支；但 workflow 全局决定或上游 post-gate
必须阻止依赖它的节点。不存在“先并行启动，再补审批”。

预算取 channel/workspace policy、workflow/group 限制和 provider/runner 实际剩余容量
的交集，并计算已 running、preparing、queued-for-dispatch 的预留。不同 tick/workflow
不能各自看到同一空位而同时占用。

### 5.2 资源键

资源由 Host 推导，模板只能增加不能删除必需资源：

- canonical repository/workspace identity；路径先 realpath，不能用字符串别名绕锁；
- step worktree 的 execution path；
- 共用构建目录、服务端口、缓存或设备的独占键；
- integration target 的仓库级独占键；
- 外部 subject/provider 已有资源与 runtime semaphore。

首版对无法证明互不重叠的路径使用较粗独占锁，不声称精确路径相等能处理父子目录冲突。
同一 Git common directory 的 ref/index 操作另受 Host Git coordinator 串行保护。
`resourceKeys` 为空不是“无资源”，也不能覆盖 Host 推导结果。

### 5.3 事务与 dispatch

扩展现有 `beginChannelWorkflowStepStart`/preparing/linked 协议，不新增并行启动入口。
先冻结并检查审批所需的 scope/policy plan。一次短 SQLite 准入事务消费有效 pre-approval、
复核 current basis/撤权、创建 step start claim 与 Task，并预留整组必需资源和容量。
任一资源冲突则全部回滚，step 保持 queued 并返回等待原因，不留下半组锁或已消费审批。

既有 provider/runner/channel_parallel runtime semaphores 已是 SQLite-backed、
Attempt-fenced slots，复用其表、当前 owner 检查和幂等恢复，不另建进程内 limiter。
拟新增 preparing capacity reservation 必须计入同一容量上限。真实 Attempt 创建后，
以短事务将预留原子转移到该 Attempt 的 slots；交接不重复计数，也不先释放再申请留下空窗。
需要在 store 层提供事务级原语，不能在准入事务内嵌套调用自行 `BEGIN` 的公共方法。
同一 start/Attempt 的重入只返回已交接结果，不重复分配 slot。

Runner 准备在事务外进行；沿既有 commit/start 路径关联 Run，并在真实 dispatch 前
验证计划、执行绑定和容量交接已提交。Runner 实际 acceptance 前不能把“Promise 已创建”
当成执行已开始。已证明未 dispatch 的准备失败只释放该 start 或精确 Attempt fence 的
预留/slots；Run 正常结束沿既有终态、子树停止和 effect 确认规则释放。
dispatch 结果未知则保留 owner 和资源进入恢复；reopen/recovery 核对原交接及 slots，
不能因重启重新占位、重复创建 Task/Run、再次派发工具或释放后继 owner 的资源。

lease 到期不等于进程停止。仍有工具、子执行或 effect journal 未确认时，不因 TTL 到期
就把写资源交给后继 Attempt。preparing 预留只是启动前的所有权阶段，不能取代运行中
既有持久 runtime semaphores 的 fence、续租与安全释放规则。

### 5.4 显式隔离写入组与共享父锁

首个写并发 profile 为 Host 冻结的 `isolated_siblings_v1`，只支持 `boundPath` 写锁，
`maxConcurrentSteps` 限制在 2 到 4，并受 workflow、channel 和各 step 的更小上限约束。
该选项属于 immutable integration round inputs，不是模板声明、模型参数或只读并行开关。
缺少该选项的旧 round 保持原来的串行资源计划，不在读取、重启或 metadata 更新时升级。

写并发组只使用可核验的 Pi Host isolated-files executor。Host Tool Broker 必须为
`enforce`，实际工具限定为文件读写能力；shell、MCP/CUA、外部操作和未知 executor
不取得该能力。当前平台边界与是否开启以执行端 gate 为准，不能由客户端显示解锁。

首次冻结 round 时，在同一短事务中取得 workspace/Git common-directory 的持久父锁。
父锁覆盖整个 round/generation，而每个 sibling 单独保留自己的 worktree 资源、step
lease 与 Attempt slots。只有精确匹配 frozen participants、scope plan、authority basis、
当前 Task/WorkUnit/Attempt 和资源计划的成员，才可共享该父锁并写入自己的执行目录。
其他 workflow、普通 Run、新 round 及共享目标写入均不得借用 sibling 身份准入。

Run 尚未落库的 preparing 路径只能用已冻结计划、原 start owner、当前 Attempt 及绑定
同一 proposed Run id 的有效 task lease 取得精确 `bound_path` lease。不得通过任意
Run id、缺失资源记录或较宽 workspace/channel lease 取得权限。创建 Run 后，沿既有
原子交接把预留转入当前 Attempt slots，不允许额外申请非计划 slot 或重复计算容量。

父锁不因单个 sibling 成功、失败、业务取消、lease TTL 或 daemon 重启而自动释放。
释放必须核验所有原始执行的 terminal lineage、原 Host 调用 drain、子树与 effect journal；
成功交付还必须满足该 round 的 candidate-only 或 approved-and-applied 完成协议。
failed/cancelled 只在全组安全停止且 journal 已收敛后释放，不据此生成成功 candidate。
merge apply 的目标 lease 只能由 Core 在已验证 single-use permit 的事务中临时取得，
普通 `system` owner 或客户端字段不能绕过父锁。已释放父锁保留审计行，不删除历史。

Core 父锁只协调同一个业务数据库。Daemon 还在 canonical Git common directory 中持有
独立 repository fence，绑定 common-directory dev/inode、canonical root、数据库路径、
round/generation 与输入 digest。普通、native、delegated 和 continuation Run 的准入均需
检查该持久 fence，不能换 checkout 或另开 Store 绕过。首版 parallel profile 只支持一个
canonical target 和一个 canonical Host 数据库。额外 registration 仅允许通过历史 owner、
terminal/drain/effect、资源释放及物理身份核验的 retained worktree，不恢复其执行权限；
未知或外来 checkout 仍拒绝，全部 registration 均计入 16 预算。已登记过其他数据库的
仓库保守拒绝，不按 TTL、PID 或一时没有 resource rows 回收其他 Store 身份，也不自动
删除协调文件。

规划先持久化 admission marker，再持有 sidecar SQLite writer transaction 完成 checkout
inventory 和 Core freeze。新协议 marker 带 `reservationProtocol: "sqlite_writer_v1"` 与唯一
token；重新取得 writer 后必须重验 token，COMMIT/re-BEGIN 间被其他 planner 替换的请求
不得 freeze 或补偿赢家。没有 Core round 的同一精确 owner 只有在旧 writer 已退出、协议
marker 可验证时才能重新规划，不按 PID/TTL 接管，也不凭游离 token 释放 marker。
Core COMMIT 后即使 sidecar 未 COMMIT 就崩溃，之前持久 marker 仍阻止普通 Run 准入。
已有 round 的释放仍由 Core 原始 drain/effect/parent 协议决定；旧 token-only、未知协议、
输入漂移或外来 owner 保持 fail closed。第一次 open 在初始化前遇忙后留下的空数据库
可在 writer transaction 内初始化；未知版本、损坏或外来 schema 仍拒绝。

同一 Host 进程内的 worktree create 与 branch capture 按 canonical Git common directory
排 FIFO 队列，避免正常 sibling 同时完成时互相触发 fail-fast 仓库锁。队列不替代物理锁；
跨进程、直接嵌套及遗留 owner 仍 fail closed，不偷取锁、不按 TTL 重试。等待后必须重新
核验 create authority 或 terminal fence，撤权请求不能因已经入队而获得执行或发布资格。

### 5.5 显式公共选择与回退

`POST /workflows/:id/orchestrate` 的可选 `executionProfile` 只支持
`pi_host_isolated_files_v1`。Host 开关默认关闭；首版仅支持 macOS、enforced Tool Broker
及真实注册、workspace-enabled 的 Pi adapter。完整步骤清单必须有 2-128 个
`workspace_write` 参与者，Host 固定 `isolated_siblings_v1`、并发上限 2、
`candidate_only` 和 `require_success`。请求不能指定 shell、command、路径、apply mode
或新的并发数；内部 approved apply 协议不是公共自动合并权限。

选择先持久化 `planning`，再以同一短事务冻结完整 workflow/channel/steps、safety plans、
scope plans、round 与父锁并转为 `ready`。任一快照漂移全部回滚，不留下半组 pin。
未完成选择不能降级到旧普通路径创建审批、Task 或 Run；实际 start/dispatch 还要重验当前
Host 能力。关闭开关后拒绝新准入，但保留已接受 round 的观察、journal reconciliation、
安全收尾与 evidence 读取，不能用关闭能力开关撤销原隔离边界。
全组满足原执行 drain 与完成协议后，普通 Run 应能重新取得自己的目标写锁和容量；
关闭开关或重启后的恢复准入不得重放旧 sibling，也不得顺便应用留存的 candidate。

同一 conversation 的 workflow 行提供显式“启动隔离分支（仅生成候选）”操作，只在新建、
未执行且完整写入步骤清单符合请求条件时出现。它只提交固定 profile，不授予 Host 能力；
普通“推进工作流”不会自动选择隔离或升级旧 round。Host 关闭或能力不足仍须返回拒绝。
candidate 完成后的每个 orchestrator completed 出口重新尝试调度 TerminalReport；沿用原始
drain 和原子 publication/turn settlement，不由客户端轮询或 SSE callback 伪造终结。

模板的显式创建在同一 Core writer transaction 中编译 workflow/steps、解析 channel root
thread、写入用户输入 turn/item 并绑定 `sourceTurnId/sourceMessageId`。失败全部回滚；
创建和预览都不 dispatch。后续 Run 和 TerminalReport 只能使用该 canonical source lineage。

## 6. Step 级隔离执行

### 6.1 Integration Round 与固定基线

每个声明的写入 fan-out/fan-in 创建一个 Integration Round：冻结基线 commit、
参与 step ids、确定性合并顺序、验证要求和目标 checkout。后续 round 可从上一轮
已验证 candidate commit 派生，但不得运行中改变既定依赖图。

detached HEAD、非 Git 目录或缺 HEAD 的仓库不隐式降级成共享目录并行写。
首版要求目标为可检查的本地 Git branch；不自动 fetch、push 或修改远端。
目标 dirty 时默认阻止集成启动。用户可明确选择仅基于已提交 HEAD 生成候选分支，
此模式不复制、stash、提交或忽略后假装已包含其 WIP；用户必须看到输入不含 WIP。

首版支持普通文本文件的增加、修改、删除和可验证 mode 变化。submodule、嵌套仓库、
symlink 修改、特殊文件、二进制集成、LFS/自定义 filter/merge driver、无法唯一解析的
大小写路径需要明确阻塞或单独方案，不自动执行仓库自定义脚本。
大小和数量限制由 Host bounded-policy 固定并投影，不能无限收集 diff。

### 6.2 生命周期与目录权威

每个 writing step 的执行 generation 使用独有分支与 worktree。名称由 Host 分配，
新建采用 no-clobber 语义；存在同名分支只可在核对持久 identity 后重用，绝不 `-B` 覆盖。
不能把现有 channel 级 worktree 当作所有 writing siblings 的共同 execution root。

拟议绑定分为两层，具体 DTO 与 schema 在 P2-A 落地。审批前冻结 scope plan；
审批消费并取得 start owner 后，再建立 fenced execution binding：

| 层 | 字段 | 约束 |
| --- | --- | --- |
| scope plan | `planId`、`planDigest`、`workflowId`、`workflowStepId` | Host 分配；属于 accepted workflow，内容不可变 |
| scope plan | `canonicalWorkspaceId`、`repositoryIdentity` | 原 store 与 canonical Git common directory 的身份 |
| scope plan | 计划 `executionRoot`、worktree/branch identity | Host 预分配；不指向用户或其他 step 的 checkout；不要求此时已物理创建 |
| scope plan | `integrationRoundId`、`baseCommit` | 创建后不可变，不跟随移动中的分支名 |
| scope plan | `graphFingerprint`、`safetyFingerprint`、template pins 与资源方案 | 绑定编译结果、工具与权限，纳入 pre-gate/start semantic basis |
| execution binding | `bindingId`、`revision`、`planId`、`planDigest` | Host 分配、CAS 更新；只引用已批准计划，不借 linking 改 scope |
| execution binding | `startOwner`、`runId`、`workUnitId`、`attemptId`、`fencingToken` | 审批消费后绑定真实执行，不接受模型指定 owner |
| execution binding | 实际 `executionRoot`、`worktreeId`、`branchRef` 与创建 receipt | dispatch 前核验与计划一致；身份填充不改变已批准的 semantic basis |

retry/resume 必须核对旧 Attempt 已停止及物理资源无未确认 effect；有安全 checkpoint
才可显式接续旧 worktree，否则新 generation 从确定基线开始，旧现场保留。
不允许两个 Attempt 同时写同一 execution root。新 generation 不继承旧 binding 的授权；
即使计划内容未变，也必须通过当前 pre-gate/retry 协议、撤权检查和精确 fence 核验。

已接受 operation 的相对路径只能通过 Host 派生绑定映射到本 step 的 execution root；
绝不能在既有快照中替换绝对 cwd 然后继续使用旧 fingerprint。
command cwd、file read/write/edit、patch、检查、artifact 收集和 operation evidence
使用同一 scope plan 派生的 execution binding。审批前只有计划进入 authority basis；
审批后真实身份的 linking 不重算该 basis，dispatch 时另验当前绑定及其 fence。
不能安全映射的旧 absolute binding 返回 `workflow_execution_binding_incompatible`。

Runner 不得写 `.git`、Git common directory、其他 worktree、用户 checkout 或共享缓存。
worktree 共用对象和 refs，因此“换 cwd”不是 Git 元数据隔离。
分支提交、状态捕获与合并只由受保护的 Host Git actor 执行；其受控环境不得调用仓库
hooks、自定义 merge driver、未授权 credential helper 或网络工具。
原生沙盒不可用的执行路径不能开启写入并发。

### 6.3 Branch Result

仅在当前 Attempt 有真实 terminal、子执行 quiescence、工具完成证据后，Host 封存结果。
结果 artifact 至少包含：

- round/step/Run/Attempt lineage、binding identity、base commit 与 candidate tree/commit；
- changed paths、file modes、受限 patch 与内容 digest；包括被授权的新文件，不只 tracked diff；
- 验证命令、输入 scope、实际 execution root、退出状态和 artifact refs；
- 被排除文件、未跟踪或 ignored residue、权限问题与未知 effect；
- 原始 context/output packet 与 Host terminal evidence refs。

自动创建 commit 只覆盖本 generation 已授权且已核验的路径，不执行 `git add -A` 收走
其他来源文件。ignored 输出不自动入库，且不能因为 Git status 干净就宣称没有残留。
模型的 changed-files 文本不能替代 Host tree/patch 捕获。

capture 无法确认时，将 step 阻塞在可恢复的 `workflow_isolation.result_*` 命名空间；
外层 Git/IO 错误统一映射为 `workflow_isolation.result_capture_unverified`，原始错误 code
保留在 artifact。只有原 lineage 的完整 terminal/capture 证据才能解除 blocker，不因错误
分类变化放宽 Core 的恢复判断，也不把 capture 失败当作可重新执行 Runner 的许可。

### 6.4 资源留存与清理

step worktree 必须有 durable owner 和可查询的生命周期，不能成为新的匿名 WIP。
Host 在创建前检查本地活动 worktree 数量与磁盘预算；不足时排队/阻塞，不无限创建。
规划时即检查所有 Git registration（含 target 和外来 checkout）加全部 writing participants
及一个 integration worktree 不超过 16；不是只计算同时运行的 slots，串行隔离也适用。
单 target 因此最多容纳 14 个 writing steps，readonly steps 不占隔离目录名额。freeze 前再
检查一次，实际 create 仍逐次检查数量与可用磁盘，外部新增 checkout 不获得超额许可。

只有原 Attempt/子树已真实停止、effect journals 已确认、branch result 已封存且所有
需要的文件已进入独立 artifact storage 后，才能释放执行资源。未知 effect、待审批、
冲突、dirty/未归属文件、正在重试或仍被 fan-in 引用的现场均保留并显示原因。
不能因 TTL、workflow terminal 字段或一次 `git status` 干净就自动删除。

自动清理只处理可证明属于 Ling 的、已满足留存策略的 clean worktree，不处理用户或
同事的目录；先持久 cleanup intent，再 no-force remove，核对后写 receipt/tombstone。
candidate-only 的未应用分支保留可恢复 ref，未合并/仍被 artifact pin 引用的 commit
不能随目录一起删掉。不能对 active/unknown generation 运行宽泛 prune/clean。
清理失败只影响资源回收，不改写已验证的业务结果。

实现由独立的 `workflow_worktree_cleanup_intents/receipts` journal 持有，不复用业务 round
phase 或原 Attempt 的写能力。第一版只对真正 `succeeded` 且 candidate verified / target
applied 的 workflow 开放；仍逐项重验 coordinator authority、publication/completion blocker、
terminal/quiescence、所有 effect receipts 和独立留存的 branch/candidate artifacts。
failed/cancelled/conflicted、active、pending 或 unknown 一律保留，不以 terminal 字段代替证据。

Host 从已封存的创建 receipt 派生 scope、canonical repository 和目录 dev/inode，调用方不能
传入任意待删路径。物理 actor 在同仓库锁内验证 registered non-main worktree、精确 branch/base、
反向 `.git` registration、未被锁定/prunable、无 symlink、无 index 隐藏标记，且 tracked、
untracked、ignored residue 均为空。保留的结果 refs 必须仍精确指向封存 commit；删除只调用
no-force `git worktree remove`，不删 branch/ref，不 reset、不 prune，不吞现场文件。
最后一次完整物理检查位于 authority/intent 回调之后，检查后不再调用 Host 回调，直接
dispatch no-force remove。仓库锁只协调 Ling Host actors；Git 自身不保证 ignored 文件的
原子 clean-check/delete，不能据此宣称阻止不遵守该锁的外部进程并发写入。

短事务先 pin plan/evidence 并记录唯一 `(round, generation, worktreeId)` intent；只有返回
`created` 的原 Host 调用能执行一次 remove。成功后重新确认目录和 registration 均消失、
结果 refs 完整，追加 observation receipt/tombstone。物理预检拒绝也尽可能记录留存原因。
duplicate/reopen/startup 仅观察已有 intent，即使目录后来变干净也不重放删除；intent 前崩溃
不自动开始新回收，intent 后、remove 前崩溃保留 present，remove 后、receipt 前崩溃补写
absence observation。后续要再次删除 retained 现场，必须另行明确授权和设计新操作，不能
把旧 intent 当作延迟删除许可。目录删除失败不会撤销成功交付，removed tombstone 也不能
授权删除后来在同路径出现的外来目录。

## 7. 合并、冲突与用户审批

### 7.1 合并状态

新增 Integration Round/merge generation 使用独立持久记录，不塞进 step 的自由文本。
最小状态为：

```text
preparing -> collecting -> integrating -> verifying -> awaiting_approval
                             |              |               |
                         conflicted       failed          applying -> applied
                             |                              |
                          blocked                         blocked
```

取消是持久 control intent；仅实际停止和 effect quiescence 后才能投影 cancelled。
`blocked` 保留原因与最后已确认 phase；恢复不擦掉原冲突/失败记录。公共 selected parallel
冲突修复创建新 workflow 的 generation 1 successor，不在旧 round 上增加 generation。
candidate-only 模式最终报告“候选分支已验证，尚未应用”，不能报用户 workspace 已更新。
若此模式在编译/接受时已选定，Completion Gate 可按 candidate-ready 目标判完成；
要求 apply 的 workflow 未达到 applied 前不得成功。模式不能因 apply 失败而偷偷改变。

### 7.2 确定性集成

1. 关闭本 round 的结果集合，检查 required branch 全部成功、optional 按冻结策略处理。
2. 从固定 base 创建独占 integration worktree/ref，不修改目标 checkout。
3. 按已冻结的 step position/id 顺序三方应用 Host 封存的 branch commits/patches。
4. 每个合并动作先持久 intent，再执行 Git，再核对并持久 receipt。
5. 同文件无文本冲突也可能有语义冲突，全部集成后必须重新运行冻结的验证集合。
6. 保存 candidate commit/tree、合并顺序、所有输入与验证 artifact digest，生成 merge packet。

出现冲突即停止集成，不使用自动 ours/theirs 或模型静默解决。
冲突 artifact 记录 base/ours/theirs、路径、发生顺序和可审查 diff。
用户可取消该 round；公共 selected parallel 路径的显式修复按下述 successor 协议创建全新
执行，再重新验证。不得重用旧 Attempt/审批或覆盖已批准 candidate。
optional 失败不能隐式遗漏；只可按已冻结策略排除，并在输出和 TerminalReport 明示。

### 7.2.1 显式冲突修复与继承边界

本机 `POST /workflows/:id/conflict-recovery` 只接受精确 `roundId/generation/expectedRevision`、
`idempotencyKey` 和有界 `repairInstruction`。仅 `candidate_only`、固定并发 2 的已选择
text-conflict round 可进入；必须确认原 Host 实际 drain、全部 effect/receipt、无待处理 intent、
无 merge approval/permit、无活动 workspace 资源和其他父锁。未确认时不转移所有权。

Core 在同一事务中重编译 accepted graph、创建新的 canonical 用户修复 turn/item、记录
不可变 predecessor/successor lineage、永久退役旧 workflow 并释放其精确父锁。旧 round、
journal、冲突 artifact、ref 和目录保持不变；旧 workflow 的 start/coordinator authority
之后始终拒绝。migration 213 保存 lineage 并禁止覆盖或删除；sequence 计修复次数
（上限 128），每个 successor 都是独立 workflow/round 的 generation 1。

退役事务提交后立即通过现有 coordinator 调度旧 workflow 的 TerminalReport，不能等到
successor 规划成功或 daemon 重启才收尾。报告仍绑定旧 source turn/item，按现有
single-flight、evidence fingerprint 和原子发布协议去重；相同恢复请求不得重复发布、
重复终结旧 turn，或触碰新 source 的状态。后继规划失败不撤销已经提交的退役与报告。
旧 steps 已成功而整体冲突退役时，报告保留 `partially_succeeded` 的原子证据，旧 source
turn 仍按已重验的 workflow 状态终结为 `failed`。取消后的部分结果同理；报告 outcome
不授予成功、继续执行或应用权限，required-participant、isolation effect 与 source lineage
仍在原子发布事务中核验。canonical 绑定以结果 item/turn refs 为准，不要求可选的报告
正文 `turnId` 字段存在。

新 workflow 不继承 runtime pins、safety plans、Run、Attempt、审批或旧 source turn。
事务提交后才规划新的 candidate-only round；失败保留 `planning`，普通推进和 manual start
不得降级执行。相同请求可幂等续完规划，修改请求不能复用原 key；GET 仅观察 lineage，
重启不自动规划、重跑模型或重放 Git。返回 `ready` 也只表示计划已冻结，仍需用户单独
orchestrate；后续 apply 继续要求独立审批，修复请求本身不签发执行或 target 写权限。

HTTP 与 API-client 已实现上述恢复契约；当前 Web 可观察冲突和既有证据，但没有专用
冲突修复表单。不能把 API 可用或新计划已冻结描述成 UI 已启动修复或冲突已解决。

### 7.3 审批绑定

初版 apply 每次要求显式本地用户审批，复用现有 approval store、执行动作与撤权检查。
“允许 agent 在隔离 worktree 修改”不等于“允许合入用户 checkout”，更不等于远端发布。
未来持久 merge policy 是另一个审批产品决策，本轮不自动放开。

审批 fingerprint 绑定：round/generation、graph/safety/template pins、所有 branch result
digests、candidate commit/tree、验证证据、目标 repository/worktree/branch、
expected target HEAD 和目标 clean-state snapshot。
模型、普通 route JSON 或只有 digest 的 artifact 不能签发 merge permit。

Host 实现通过独立 merge approval store 冻结完整 proposal/checkpoint；单次
`approve_once` 且 `resolvedBy: local-user` 才可走 live apply。generic isolation journal
和 integration journal 均禁止签发或确认 `target_apply`，不能把通用 receipt 当作许可。
repo-local `.ling-stack` 仅在 Host 实际 state root、canonical 非 symlink、整体 ignored
且 dev/inode 一致时豁免；该身份进入 target snapshot/fingerprint，不豁免其他 ignored 文件。

审批拒绝/超时不改变目标；candidate 改动、目标 HEAD 改变、checkout 切换、权限撤销或
验证证据失效都使旧 permit 无效。必须重新检查、生成 candidate 并重新审批。
审批接受后仍需在实际 Git effect 前检查当前 owner/fence，不以 UI 已点通过作权威。

### 7.4 应用到目标 checkout

apply 取得 canonical target 的独占 lease 和跨进程协调锁，重验：

- branch/HEAD 与审批一致；index、tracked 和 untracked 状态满足 clean policy；
- 无 merge/rebase/cherry-pick 等进行中 Git 操作；candidate 是 expected HEAD 的后继；
- required 验证成功，所有 writing branch 已停止，旧 generation 没有未知 effect。

只允许 no-force fast-forward；不 stash、不 reset、不覆盖 dirty 文件、不 push。
应用前记录 intent 和原 HEAD，应用后核对 HEAD/tree/index/工作区并记录 receipt。
不得用 `update-ref` 移动已检出的 branch 然后假装工作区也已同步。

仓库协调锁内、物理 effect 前的短事务原子写入 exclusive lease、apply intent、effect
link、不可变单次 permit 与 `applying` phase。只有 `beginApply` 返回 `created` 的原
Host 调用可执行 Git；duplicate、startup 和 reopen 均只能观察。所有普通资源/容量准入
及 existing slot 复用在各自写事务内尊重 apply lease；TTL 和通用 cleanup 不释放它。
exact clean candidate 记为 `applied`，exact clean before 记为 `not_applied`；两者均是
物理结果已确认，释放精确 lease。dirty/drift/unavailable 记为 unknown，保留 intent/lease。
cancel、撤权或授权过期后观察到实际 candidate，仍记录物理事实，但业务 blocked。
已完成 apply 的历史同意按 receipt 时间验证，正常后续超时不撤销已确认历史成功；
当前 authority、candidate 和 retained evidence 仍必须有效。

协调锁不能阻止编辑器、用户或其他不合作进程写文件。检测到并发漂移或结果不确定时，
保持 blocked、保存现场和恢复建议，不能自动回滚用户文件。
首版不承诺多文件 workspace 更新与 SQLite 的原子提交，也不提供自动跨 worktree undo。
需要撤销已应用结果时，另走有审批的反向变更，不能复用旧单目录 patch undo 冒充。

## 8. Git/SQLite 非原子恢复协议

Git 物理操作不放在长 SQLite 事务内。拟议 integration store 保存：
round、generation/revision、immutable inputs、current phase、intent/receipt refs、
exact owner/fence、expected before/after identity 和 outstanding approval。
branch execution binding 单独索引其 step/start generation；packet bodies 仍放 artifacts。
只有 CAS 当前 generation 的 Host writer 可推进 phase。

| crash window | 恢复动作 |
| --- | --- |
| worktree create intent 已落库，目录尚不存在 | 验证原 identity 后幂等创建；不重置同名 ref |
| worktree 已创建，receipt 未落库 | 核对 common dir、base、ref、路径和 owner；匹配才补 receipt，否则 blocked |
| branch 有文件改动，Runner/Attempt 结果未知 | 保留目录/锁/证据；不重新执行模型、不自动合并 |
| integration Git 动作已完成但 receipt 丢失 | 读取 expected tree/commit 与 Host intent；唯一匹配才能确认，不能重放一次 cherry-pick |
| approval 已接受，但没有 apply intent/permit | 重启只展示已同意但尚未应用，不自动开始新的 Git effect |
| apply intent/permit 已落库，Git 尚未运行 | 只观察 exact clean before，记录 not_applied 并释放原 lease，不重放 Git |
| target 已 fast-forward，SQLite 尚未记录 applied | 以 intent、expected after commit 和完整目标状态核对；相符才补 applied |
| apply 部分失败、出现非预期 HEAD/文件 | blocked，保留 before/after 观测，不强制恢复或伪造 applied |
| 旧 Attempt/旧 generation 晚到完成 | 可记录审计；不得改当前 phase、消费审批或释放新 owner 的 lease |

Daemon startup 先 reconcile，后恢复允许的观察/收尾。不能因剩余 queued 节点、
lease 过期或“昨天已批准”自动启动新的副作用、重跑模型或重放合并。

## 9. 取消、Fan-In 与完成证据

workflow cancel 一次持久意图覆盖所有 active/preparing 分支、integration owner、
待审批及动态子树。先禁止新 admission，再请求停止并等待真实 drain。
stop 请求成功、Promise 返回、进程不见了和 TTL 到期都不单独证明 effect 已停止。
尚有 unknown effect 时投影“结果待确认/已阻塞”，不能显示干净的 cancelled。

`cancelSiblingsOnFailure` 默认 false；true 时只影响同一冻结 branch group 的活动 siblings，
按相同停止协议执行。失败与 optional/required 的关系来自 accepted graph，不能临时猜测。
动态 child 继续服从已有 required-descendant completion barrier 与 optional
`stop_with_parent`，不允许因 workflow 的新并行特性开启遗留 dynamic producer 开关。

fan-in 消费每个依赖的 canonical output packet 与 Host evidence，不拼接原始 transcript。
`all_terminal`/`any_succeeded` 只决定依赖可运行，不自动豁免 required participant、
post-gate、未知 effect 或 merge verification。
缺 packet、错误 owner、旧 Attempt、未确认子树或未完成集成均产生结构化 blocker。

Completion Gate 区分 branch execution success、candidate verified 与 target applied。
TerminalReport 明示实际完成模式、应用目标、排除分支、审批/冲突/检查结果和证据 refs。
runtime events/SSE 只负责唤醒和增量展示，SQLite 与 sealed artifacts 才是重启后的事实源。

同一 source turn 可经历多轮审批等待/恢复，以及 blocked 后重新 start。每轮有效转换
分别记录，同状态重复 sync 不新增事件。去重依赖当前状态 guard 与 `expectedStatus` CAS，
不复用 workflow-wide 固定 key，也不以时间戳区分轮次。

## 10. 模板 Registry 与 Authoring

已实现显式 `kind = workflow_template` 契约和专用 registry/version store，复用 skill library
的来源、可见性与 review 约定。专用表仍属于同一 canonical workspace Store；模板不是
executable skill entry，不绕过编译、来源审查或执行授权。

模板版本不可变；同 id/version 不同 digest 是冲突。compile 冻结 template version/digest、
resolved skill/participant/provider/runner refs、graph fingerprint 和 safety policy，
重试不读取后来更新的“最新版”。权限恢复时仍叠加当前撤权。
模板禁用/归档阻止新的 compile，不删除历史；执行中发现权限已撤销时阻止新 effect。

现有 inline `customTemplate` 保持兼容，存同样 frozen pins；registry lookup 只新增
`customTemplateId` 与明确版本选择，不改变已接受 workflow。
JSON 是唯一执行格式；authoring UI 提供结构化步骤/依赖/副作用/资源/审批编辑、
静态校验和编译预览，不运行任意脚本。保存或导入模板不启动 workflow。
custom auto-start 默认 false；只能请求已被 Host 准入的能力，不能让模型或模板自批权限。

## 11. Conversation 投影与 Graph

扩展现有 conversation work-cell 与 workflow evidence，不新增顶层 workflow 页面。
第一至三阶段先用列表显示分支、等待原因、隔离目录、candidate/applied、检查与冲突；
审批沿用现有 in-turn/action surface，原始 refs 和日志放展开详情。

最终 graph 是同一 read model 的可选视图：

- 稳定 node id 来自 workflowStepId，edge 来自 accepted dependsOnStepIds；
- branch/join grouping 不凭位置猜依赖；dynamic tree 为明确标注的 overlay；
- 节点状态来自 store projection，缺数据与断连不能绘成 success；
- list/graph 共用选择状态、权限和动作，不从连线触发 hidden execution；
- 支持键盘、窄屏、长标题、缩放与无动画偏好；列表始终可用。

## 12. 迁移、开启与回退

- 所有新字段 additive；已有 metadata 和 packet refs 继续可读。published migration 不改写。
- durable execution binding 与 integration journal 需要新表/约束；migration 编号在编码时
  根据真实 schema head 分配，不在本计划预占历史编号。
- pre-gate/start authority fingerprint 纳入 immutable scope/policy plan 的 safety、
  计划执行目录、template pins 与资源方案，不纳入审批消费后才产生的 runtime ids。
  execution binding 单独校验当前 lineage/fence；正常 linking 不使审批失效，也不能
  无条件重算 basis 让旧 preparing owner 取得新权限。旧 active owner 先 reconcile，
  缺失新权威证据时保持串行旧 scope 或显式阻塞，不能自动迁移为写并发。
- 新版本先做 decision-only shadow；shadow 不启动额外 Run、工具、Git mutation 或费用。
- safe-read 与 isolated-write 的开启门禁独立；后者在 P3 联合验收之前只供隔离测试。
- 关闭开关只停止新并发准入，不删除历史、不强杀后遗忘未确认 effect，不卸掉恢复 reader。
- schema 回滚不是降级二进制直接读写新数据。迁移/reopen/旧 reader 不兼容必须显式拒绝；
  应用级回退保持新 schema 的只读证据与收尾能力，禁止自动 DROP 表。

## 13. 设计取舍与验收入口

- 选择现有 orchestrator + Host 强制，而不是新的多 Agent runtime，代价是需要贯穿现有
  template/start/Runner/evidence 路径，收益是权限、取消和报告只有一份权威。
- 首版固定 base、确定性顺序和文本集成，不做任意 rebase/智能消冲突，代价是漂移时需要
  新 candidate 和重新审批，收益是不会静默覆盖用户修改。
- 先交付列表与真实恢复，再做 graph；展示不领先于 durable state。
- 本轮不以模型 grading 成功、单元测试通过或旧 Harness WIP 存在替代真实执行验收。

验收矩阵、小 PR 责任与开启条件见[实施计划](ling-multi-agent-safe-concurrency-implementation-plan.md)。
本文没有阻塞 P1 开工的产品待决项；每一 executor/platform 是否满足限制能力，
以及 P2 的物理 Git/恢复门禁，必须用实现证据判断，不能预先宣称已通过。
