# Workflow retry：启动归属与迟到执行隔离

状态：产品修复和最终完整回归已通过，等待冻结增量独审与限定保存；不是 Office/GUI 批准。

## 已确认行为

真实 HTTP 工作流先由 Runner A 失败，步骤 blocked；retry 创建 Task B，但准备期仍保留 Run A。
并发 orchestrate 因此可以据 A 的失败再次阻塞 B。准备失败也会保留 A 的 runId。
两个入口在准备期取消后，迟到的 ready 仍能进入 Runner B 并产生成功 read；这不只是展示错误。
existing lane 的旧 A terminal callback 还可以污染已运行的 B。

两 lane 正常 retry 已各通过一次完整 Run/WorkUnit/Attempt/action/workflow 正例。
首次22项矩阵13pass/9fail，九条失败归属于上述失败面，不当作九个独立根因；原始日志保留。原子Task/Run/Step ready接线后该22项已实际22/22通过，但不能据此替代后继完整边界回归。
manifest 首次缺 frozen providerBinding 属测试前提失败；已用正规 provider preflight 和创建时冻结修正，原日志保留。

扩大回归后另实证：B 的 post-step 审批决定由 durable post-commit effect 晚到重放时，仅比较同 workflowStepId 的路由会误中 C。两隔离反例均抵达 C 的真实 pending gate：旧 approved 将 C 改 running，旧 denied 将 C 改 blocked，第二 SQLite 连接的全表不变断言均失败。其修复属于同一启动世代隔离合同，不按“审批已处理过”或 UI 状态推断安全。

## 最小职责边界

1. Core 用现有 Task ID 代表一次启动世代，用精确 resource lease ID 代表本次互斥所有权。
   step 仍使用 running；typed `startOwner` 明确 preparing/linked，不新增顶级状态、表或 session 系统。
2. 原子 begin 在同一事务内建立 Task、清旧 run、写 preparing owner，并保留不可变 participant/provider/plan/source 权威。
   清的是本轮旧结果指针，不删除旧 Run/Event/Artifact 历史。
3. ready 是 Core 必须成功的 task/lease/authority CAS。准备期取消、换源或后继接管后不得 ready，也不得进入 Runner。
   `onRunReady` 仅作通知/审计，不承担准入；其异常被捕获不能成为继续旧执行的理由。
4. 在线 reconcile 区分合法 preparing 与损坏归属：前者等待，后者明确 blocked。
   daemon restart 沿既有语义把未启动准备者变成需要 retry，不自动重放，不等待六小时 lease 过期。
5. 失败、terminal callback、完成证据与 lease 清理都使用捕获 owner。
   旧 B 不能 block C、发布 C 的结果或释放 C 的 lease；现有 Attempt/Host effect fencing 继续独立生效。
6. post-step 决定必须同时归属当前 `postStepApprovalId`、当前 Run 和当前 typed owner；同一个 Step ID 不代表同一代。
   Core 的窄 resolved 事务在锁内重读并验证 approved 的 canonical approval/type/post/workflow/step/run 及当前 owner，原子恢复 Workflow/Step、清 activeGateStage；同代重复恢复幂等。
   Daemon 的决定同步与 canonical finalizer 共用该事务。旧代 approved/denied 重放都必须无副作用，不能在拒绝后继续更新 source Turn、报告或审计。合法当前 denied 仍按既定失败策略处理，不被错误当作成功批准。
7. 资源冲突可能发生在普通 Task claim 之前。只对 fresh conflict-queue producer 开启 Host-only `claimQueuedTask`：
   Core 在同一 owner/lease/authority 事务内核 canonical queued Run、真实 queue marker/reason、task-owned queued WorkUnit、两份持久化请求的 Task/Step/participant 归属，以及未启动/终止/中止的 active Attempt，之后才把 todo Task 原子 claim 并建立双 link。
   普通 ready、续跑和缺 queued 证据者仍拒绝未领取 Task；不把 todo 加入普通可执行状态，也不在 CAS 之外提前领取。Task claim/audit 或任一 link 失败必须全部回滚。
8. preflight 的 fan-in context review 与 begin 或失败 settlement 一起落库。即使 context 在 begin 前已过期并阻断，也保留本次审查事实；不能依赖 begin 后另一笔无 owner CAS 的 metadata 更新。
9. 前置审批和执行归属分层：canonical approved 的当前 pre gate 可以使 Step 进入 running，但此时尚未 begin，不能误判为丢失执行 owner。
   在线 reconcile 与候选调度共用精确判断：无 Task/Run/startOwner，当前 `preStepApprovalId` 对应 approved 且 channel/workflow/step/type/pre 全匹配；随后仍须正常 begin、租约和 ready。伪造引用、非 approved、后置审批或已有执行字段均不能走此分支。restart 的 retry-required 策略不因这项在线判定而放宽。

## 接线范围

共享 Core 启动/ready/failure 事务；Daemon prepare、两个 detached 工厂和手动 SSE 入口；
executeRunRequest 的 normal/queued/duplicate ready 路径与执行前强制复查；
existing/manifest finalizer、reconcile、startup、审批恢复和精确资源清理。
新增事务与判断放聚焦模块，不在现有大型 router/orchestrator 中复制多套逻辑。

create_task 的无 Run 能力保持独立；审批/恢复只恢复当前 linked owner，不重新 begin，也不靠缺字段兼容猜测。
权限、取消承诺、required participant/evidence/fan-in 不放宽；日常历史与数据库不修改。

## 完成门

- 保留原22项真实 RED 与正例；修复后 focused 全绿及受影响 workflow/approval/startup/fan-in 回归。
- Core begin/ready/failure 的 rollback、并发 CAS、失效 owner 和精确 lease 清理有隔离测试。
- 覆盖合法 preparing/restart、缺失/损坏 marker、三个实际 link writer、queued/duplicate 和执行前取消。
- 用真实路径构成 B terminal→reconcile→retry C→迟到 B callback，以及真实源消息编辑 supersession；不直接改 SQL 假造 C 接管。
- 真实 B post 决定→canonical blocked→C linked 且 pending post gate→旧 B approved/denied 重放时全表不变；合法 C 批准与 Core resolved 事务故障回滚另作正负对照。
- 新 authored helper 补 Desktop 输入清单、source-only 与缺输入拒绝回归；最终冻结独审后才局部保存。
- packaged macOS、Office 用户批准与总 E6 仍单独验收。主 CI 按用户要求不启用、不作为等待项。

## 2026-10-15 实际验证

- Core/Daemon 直接编译通过；最终六完整文件 254/254、原十三邻近完整文件 374/374，均实际 exit0，零 fail/cancel/skip/todo。两组为不同文件，不与旧 169 或首轮诊断累加。
- 保留最初 RED、旧 approved/denied B→C 的真实越界 RED，以及扩大回归暴露的排队/审查记录/前置审批问题；没有删减原业务断言。
- 最终六文件中的 22 个隔离 child 回执逐一核读：passed、模型/外网/Keychain 观察均为 0，observations 中无 cleanupErrors 记录（字段缺省，不冒充显式空数组）。邻近测试默认初始化触发的 Keychain 尝试由隔离 preloader 拒绝，不声称所有 guard 计数为 0。
- 隔离 preloader 的 `execFile` 包装曾丢失 custom promisify 返回约定，造成 Git/worktree 假失败；修正后保留异步 Keychain 拒绝能力，最终完整重测通过。该测试设施修复不改产品 Git 行为。
- 原始日志和最终冻结清单见本地 `output/e6-20260928/a12-final-product-verification-20261015.md`。独审、Desktop 最后一次源输入核验由 Root 接续，不冒充已经发布或真实 GUI 通过。

当前没有新增未解决产品决定。详细静态切点见本地回执
`output/e6-20260928/a12-minimal-ownership-design-20261014.md`；它是设计，不是已实现证据。
