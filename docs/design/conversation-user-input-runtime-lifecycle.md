# 结构化提问：运行等待、让出与恢复的消费者设计

Status: 既有U0-S/U2/U3切片与三surface源输入捕获已验证；2026-10-03内部question/Host admission/drain/Core veto/pause coordinator增量见§9。完整生产U2/U3与真实客户端仍未完成，不以本行代替验收。
Date: 2026-09-07
Baseline: 284f8c3c05f468a256adb4cee64c4455da834a4b + 当前恢复分支 WIP。

本文细化[联合设计 §5](conversation-user-input-and-sandbox-integration.md#5-runner-暂停定向恢复与多-agent)，
不替代[总计划](conversation-codex-style-transcript-implementation-plan.md)的原 G/packaged/K/U/S 矩阵。
U2-P 当时未新增状态；后续 U2-C 已增加 `yielded` / `waiting_for_input` 和原子暂停存储，见 §7。
提问工具、公开创建路由和完整 Runner/Host 暂停恢复仍未接通，不能把局部测试当成完整能力交付。

## 1. 两种结束，两个独立入口

| 层次 | 必答问题安全让出后 | 结束时间/执行指针 | 后续处理 |
| --- | --- | --- | --- |
| Run / Attempt | `yielded`，旧执行不可再写业务状态 | 有 endedAt；旧 fence 失效 | 用量记账、物理资源清理、等待审计 |
| WorkUnit / Turn / 提问 step | `waiting_for_input`，逻辑工作未完成 | 无 completedAt/endedAt；无活动执行指针 | 按 request/answer/checkpoint 定向恢复 |
| Thread / Workflow | 从真实子工作聚合，不把某个 child 的等待覆盖全队 | 其他活动 run 的指针不能被清掉 | 独立分支继续；依赖分支等待 |
| 绑定 Task | 明确的输入等待，而非成功、失败或普通 retry | 不写完成时间 | 与原 WorkUnit 一起续接、一起取消 |
| Goal | 仍 active，stop reason 为等待输入 | 本次用量计入一次 | 不自动 retry/续跑；答案续接完成后重验条件 |

状态闭集要一起覆盖 core/contracts、Task/Thread/Workflow 聚合与 API/UI。
`isRunExecutionClosed` 包含 yielded；业务终态 predicate 仍仅 succeeded/failed/cancelled。
不要全局搜索替换现有 terminal predicate，也不要把 waiting_for_input 塞进 step terminal 集合。
Run 的 yielded 显示为执行已让出；逻辑层显示等待用户输入，不能改成绿色成功或红色失败。

既有 `transitionWorkUnitAttemptTerminal` 会同时写 WorkUnit endedAt 和终态 audit，
不能原样用于输入等待。新增领域暂停事务，只复用其 fence/CAS/事务能力。
Attempt 的物理关闭与 WorkUnit 的逻辑结束使用不同事件；不能用 `work_unit_succeeded` 记录让出。

## 2. 必答暂停的原子边界

    关闭该 attempt 的新请求/工具入口
      -> 持久化 required request + 等待意图
      -> 退出工具回调，不在工具内部 await 整个 session idle
      -> 停止当前 SDK 执行，等待所有已启动工具与 Host executor 清理
      -> Host 证明安全停止 + 校验当前 fence
      -> 同一事务提交 checkpoint / Run+Attempt yielded / 逻辑等待 / 资源释放 / invalidation
      -> 调度无依赖工作；不调用业务成功收尾

checkpoint 归属问题领域，包含 request/version、原 source fence、逻辑 WorkUnit/Turn/step、
已接受输入引用、最后可恢复的原子 evidence 引用、停止原因与 Host 停止证据。
存储时不改 `source_json` 的历史来源，不把内存 Promise、SDK session 对象或完整秘密正文落盘。
使用专门的领域存储模块和同步事务接线；不把数据库 SQL 塞入 Runner 或大型 orchestrator。

顺序要求：

1. 必答工具是顺序控制工具，不与副作用工具并行。每 attempt 只能有一个有效的必答等待槽；
   同 batch 后续工具必须经过关闭后的入口。已经进入执行的并行工具仍必须逐个清理。
2. 用户可能在 quiescing 期间已回答。可以保存 receipt/outbox，但旧执行未安全停止前不可 claim successor。
3. 取消/替换比暂停提交先获 CAS 时，暂停事务失败，不得把 cancelled 改回 waiting。
4. 只有同一 fence 可提交 yielded；提交后普通 event/heartbeat/action/terminal 回调不能继续写入。
   释放 lease/semaphore 使用完整旧 fence；不能从最新 activeAttemptId 借身份释放新执行的资源。
5. 清理未确认、子进程未退出或已有副作用结果不确定时，不能记录安全 checkpoint、释放执行权后重放。
   返回明确的恢复阻塞，并保留可核查状态；超时本身不是进程已停的证明。
6. 不在 SQL 事务中 await。等待用户不占 semaphore、不占模型调用、不重复轮询提问。

## 3. 已核对的消费者与具体改动责任

以下是按实际调用链审计的核心清单。实施时还须对新增类型运行全仓穷尽检查和回归；
表中“必须接线”不表示当前已迁移。

| 消费者 | 审计时基线 / 风险 | 必须接线 |
| --- | --- | --- |
| core `state-machines.ts`、`run-types.ts`、`runtime-supervisor-types.ts`；contracts `shared/runtime/turns/threads/workflows` | Run/Attempt 只有旧终态；运行结果和逻辑工作状态分散定义 | 添加独立关闭/等待转移、事件、continuationReason；不得只扩枚举 |
| core `storage/sqlite/runtime-work-unit-store.ts` | terminal transition 会结束整个 WorkUnit；fence/audit 闭集只认识四类 Attempt 终态 | 新暂停事务、关闭 fence、专用审计；阻止旧事件与二次关闭 |
| core `storage/sqlite/runtime-attempt-fence-migration.ts` | active partial index 只含 created/started/waiting_for_approval/cancelling | yielded 保持不活跃；若新增中间活跃状态，索引与替换 SQL 必须同步；不改旧 migration 重写历史 |
| core `storage/sqlite/run-session-store.ts` → `ling-turn-store.ts` → `run-mappers.ts` | Run 更新会重算 Turn；mapper 将非 running 的状态直接返回 | 读取 durable wait 依据，显式映射；保留等待，无活动 run/完成时间，不被旧 Run 覆盖 |
| daemon `features/runs/orchestrator.ts` / `runtime/active-runs.ts` | 正常 return 成功；catch 仅有 approval suspend 特例；finally 接 terminal callback | typed yield result/stop intent 单独处理；物理清理、业务收尾分流 |
| daemon `runtime/supervisor.ts`、`runtime/work-units.ts`；core `runtime-recovery-coordinator.ts` | startup/超时仅豁免合法 approval wait | input checkpoint 独立恢复；waiting 不按 heartbeat/hard timeout 判 stale，不假扮 approval |
| daemon `features/runs/interventions.ts`、`run-intervention-continuation-request.ts` | 队列要求源 Run 三终态；builder 不保留 workflowStepId，通常创建新 Turn | 答案使用独立 coordinator；保留原逻辑身份、CAS 切换 step.runId，不能直接套 queue_followup |
| daemon `channels/workflow-step-finalizer.ts`、`channels/orchestrator.ts`、`channel-reply-continuation.ts` | 放宽 terminal guard 后，delegated 可能 fallthrough 成功；legacy 可能落入 onRunFailed；回复可能写 ready | yielded 在成功/失败分支前明确退出；不生成完成 packet、ready 回复或失败策略结果 |
| daemon `channels/workflow-reconciliation.ts`、`workflows.ts` | 只恢复 running/approval 等旧状态；retry 仅接受 blocked | waiting 的答案恢复与重启补偿，不借 blocked/retry 启动 |
| daemon `channel-turn-dispatch-executor.ts`、`server/router.ts` 回调 | 仅 succeeded 后触发下一轮 workflow 调度 | 让出并释放资源后唤醒独立分支；仍按依赖图阻止 fan-in |
| daemon `workflow-fanin.ts`、`workflow-completion-gate.ts`、TerminalReport | 当前正确要求 required participant 的原子终态 evidence | 保留安全门槛；waiting/yielded/answer 不补齐 evidence；不读取 batch 数量 |
| daemon `features/runs/threads.ts`、`interventions.ts` goal 路径 | 用量记账在三终态 guard 之后；非 queue_followup 的 continuation 被排除且重置 chain | 物理关闭记账与成功自动续跑分开；answer continuation 保留 chain，pending input 阻止抢跑 |
| daemon `features/runs/cancellation.ts`、`thread-hard-delete-route.ts`、`thread-routes.ts`、runtime routes | 取消主要面向活跃 Run；删除用旧 Run/Turn 集合判活跃 | 取消逻辑等待及 pending delivery；已让出的旧 Run 不改 cancelled，不能误取消 successor；等待时禁止直接删掉可恢复工作 |
| API client/runtime schemas、UI-core projection、web run-status 和三 surface | 现有类型/状态展示没有问答等待；user-input item 暂未 hydration | scope 内 hydrate、显式 waiting/yielded 展示、同一共享 renderer；完成前不注册工具/创建路由 |

已有 Run/WorkUnit/Attempt 状态列为 TEXT；这不等于任意新状态都能安全写入。
SQL 的 partial index、active replacement、fence permission、terminal audit、恢复查询的闭集都要验证。
问题表自己的 CHECK 和领域版本仍保留；不做无目的的历史数据迁移或兼容回填。

## 4. 续接、取消与恢复

答案续接保留原 WorkUnit/Turn/participant/workflowStep，创建新的 Run/Attempt，
以 `parentRunId`、`continuationReason=user_input_answer`、answer/delivery/checkpoint refs 关联。
`onRunReady` 原子替换原 step 的当前 Run；最终回调仍走同一份 workflow finalizer。
二次提问产生新的 waiting 周期，不能因为第一份 delivery 已 applied 就把整个工作标完成。

delivery 的 claim lease、target run/attempt、accepted/prepared snapshot、幂等消费标记必须可以恢复。
crash 后先查已存在 successor，不能再生成一个新的；原问题的来源身份保持不变。
答案进入新冻结输入，不修改旧 prompt、旧 accepted snapshot 或旧模型请求。
N03 和问答内部链路已获连续实施授权；外部 Relay、强隔离和自动批准范围不由该授权代答。

### 4.0 U3 答案输入的原子冻结（2026-09-08）

首次领取 required 答案时，在同一 BEGIN IMMEDIATE 事务分配 successorRunId、冻结输入 seed、
更新 claim 并写 invalidation。后续 lease 过期重领使用同一 seed；记录缺失、损坏、未知版本或
与 canonical question/answer 不符时拒绝，不重采历史、不重新生成另一个 successor。

- seed use=`user_input_continuation_seed`，ID=`user_input_continuation_seed:<deliveryId>`。
  复用 conversation_context_snapshots，source_item_id 列为 NULL；真实来源在 typed envelope 和 sourceRefs，
  不与 normal user-message accepted getter 混用，不新增表或历史回填。
- seed 保存原 source 的 workspace/thread/turn/participant/workflowStep/taskBinding/fence、结构化
  question/accepted answer、原 checkpoint 和 fingerprint，以及 source/question/answer 原子 Item 的
  sequence/revision/fingerprint。保存原 Turn 的 context assignment ID/revision/segment/createdAt，
  读取时核验原持久化 assignment，不由 batch 或最新话题推断。
- 保存时的读取和序列化在 query_only 窗口完成。getter 先校验 thread scope，再解码并比对持久化事实；
  校验使用冻结 segment，而非新的 effective assignment。普通、私聊、频道遵循同一规则。
- seed 不保存 claim token、模型凭据、permissionConfirmation 或父执行的授权；不接收调用方答案正文。
  答案中的 Markdown/代码换行保持原样。getter 深度冻结副本，不将 mutable status/lease 混入输入。
- seed 只证明输入已冻结，不证明 Runner 收到，不创建 Run/Attempt，也不置 applied。
  后续仍须建立准备请求、唯一 successor 原子绑定、当前 fence 和 receiver ACK；不能借用 queue_followup
  或普通新消息入口创建另一个 Turn。公开提问入口在完整消费者和恢复验证前继续关闭。

验收：三 surface、workflow/Task 归属、两连接 CAS、重开/重领、事务提交失败回滚、来源/版本/指纹损坏、
取消后保留只读 seed、状态与租约不泄漏。真实模型和 packaged GUI 仍单独验收。

最终验证（2026-09-09）：新增 seed 专项 27/27，问答相关 174/174，Core 全量 824/824；
Daemon 全量 1675/1682，原 7 项失败集合无增减；Core/Daemon 构建与 Web 类型检查通过。
新存储模块专项覆盖率 line 97.06%、branch 94.19%、function 100%。
已验证损坏来源/时间戳返回 typed invalid_record，基础设施错误保留原错误；未将普通输入校验错误
或裸 applied 当恢复证据。详见 U3 seed 交接 (`user-input-continuation-seed-u3-handoff-20260909.md`)。

### 4.1 U3 准备：可组合的 Run 创建事务（2026-09-09）

已补内部 `SqliteRunSessionStore.createRunWithinTransaction`，普通 `createRun` 也复用它。
这个 primitive 只创建 Run、原 Turn link/投影和 selected skill 使用审计，不创建 Attempt、
不消费答案、不写 delivery applied，也不表示 Runner 已接收输入。公开 RunStore 接口未增加裸续接入口。

- 普通入口拥有 BEGIN/COMMIT；joined 入口要求调用方已有事务，成功时不提交，失败时由调用方回滚。
  调用方外层事务不能因误用普通入口而被回滚。唯一 successor coordinator 可在同一事务组合
  seed/prepared refs、当前 fence、Attempt、Task/step 指针和 Run，仍须独立实现这些领域校验。
- selected skill 使用记录移入创建事务。先前该记录在 Run COMMIT 后写入，失败时会留下半提交。
  Run/Turn/selection 现在一起提交；数据库已自行 ROLLBACK 时保留原异常，不被二次 rollback 覆盖。
- input 标量身份只捕获一次；三个 snapshot 的脱敏与序列化在 query_only 窗口完成，
  防止序列化回调重入写 SQL。此窗口是内部序列化防护，不是任意 JavaScript 的安全沙盒。
- Thread metadata 仍是可重建缓存，普通缓存语句 ABORT 不推翻已生成的权威事实。
  若缓存错误同时触发整笔事务 ROLLBACK，必须停止后续写入，不能创建自提交的孤儿 selection。
- 用 SQLite 原生 BEGIN 的事务判定，不依赖较新 Node 才提供的 `DatabaseSync.isTransaction`，
  不抬高当前声明的运行时范围。探测若意外开始新事务，只回滚自己开启的空事务并拒绝创建；
  已有事务中的 nested BEGIN 拒绝不会提交或改变调用方数据，其他错误不被当作有效事务。

仍未完成：实际 continuation preparation、唯一 successor Run/Attempt 领域绑定、
receiver ACK/recovery、U2 Host 停止与 U4 提交入口，以及真实 macOS 模型/GUI。
新基础能力不是普通入口放开 duplicate guard，也不代替原任务的完整问答恢复。
验证与范围见 原子 Run 创建交接 (`user-input-run-creation-transaction-u3-handoff-20260909.md`)。

### 4.2 U3 Runner 接收边界（2026-09-09，Runner 切片已验证）

`prepareTaskInput` 只准备，无 Run/Attempt 接收回调。实际 `runTask` 在 SDK session 初始化并核验冻结输入后、
`session.prompt` 前调用可选 Host `onPreparedInputAccepted`，提供只含 schemaVersion、boundary、
runId、attemptId、taskId、preparedInputFingerprint 的不可变 receipt。
boundary 固定为 `pi-session-ready`：不是 provider HTTP 接收、不是模型输出、不是工具事实或任务成功。

- 配置接收回调时必须同时提供有效冻结输入及确切 Run/Attempt ID，缺失即拒绝，不能静默跳过。
- 每次 `runTask` 只回报一次；回调成功返回前不调用 `session.prompt`，失败直接传播并执行 SDK 清理。
  重新启动同一物理执行仍需 Host 按 Run/Attempt/冻结引用幂等接收，不能仅靠 Runner 内存去重。
- 回调支持异步提交和取消信号；取消等待后，迟到 resolve/reject 不启动模型，也不得形成未处理 rejection。
  取消 Promise 不证明 Host 工作已停止：Host 必须在自身原子提交中复查完整 fence、当前状态和 snapshot refs。
- 入口捕获 receipt 的冻结基线；回调之后再次核验 session/task 与该基线。现有首次模型上下文/发送前校验保留。
  回调成功只证明先前已接收，后续上下文变化或模型失败仍须如实失败，不能回退或伪造完成。
- receipt 不带答案正文、提示词、凭据、claim token 或权限，不进入通用模型叙述/Run event。
  Host coordinator 将它与唯一 successor binding、完整 fence 和持久 prepared refs 关联后才可事务性 ACK/applied。
- 外部 adapter 不能因为接受相同 options 类型就被视为支持此回调。后续 coordinator 只可选择已验证
  receiver 协议的 Runner；忽略回调的 adapter 必须在 dispatch 前拒绝，不能等执行后才发现没有 ACK。

本步骤限 Runner 接口、小接收模块、adapter 接线和回归。尚无 Daemon 接收消费者或 durable receipt，
不会打开问答工具/路由、不会写真实数据库；不是完整 U3 或真实模型/GUI 验收。
Runner 全量 148/148，Electron 内嵌 Node 专项 37/37；新模块覆盖率 line 93.62%、branch 95.65%、function 100%。
完整证据及 Daemon 重验见 Runner 接收交接 (`user-input-runner-receiver-u3-handoff-20260909.md`)。

### 4.3 U3 Host 原子 admission 与 ACK（2026-09-09，存储/SDK 接收切片已验证，调度入口未接）

模块分层：Core typed DTO / 确定性只读记录校验 / preparation 与 admission 事务 / ACK 事务；
Daemon 接收 callback 只交付捕获的 binding/fence 和 Runner receipt，不拥有 SQL。
复用 `conversation_context_snapshots` 保存 request/execution/binding/receipt 四种专用 use，
按 deliveryId 确定唯一 ID，source_item_id 为 NULL；不新增表，不复用 normal-only accepted 输入。

- 准备 request 的父引用是冻结 seed，execution 的父引用是唯一 request。两阶段 first-writer-wins，
  校验当前 claim owner/token/revision/expiry、原等待与 quiescence，再在 query_only 内冻结非秘密 DTO。
  execution 固定 task/provider/runner 和 model-input fingerprint；Daemon receiver 校验具体 SDK DTO，当前权限仍由启动协调层重新核验。
- admission 同一 BEGIN IMMEDIATE 校验 claim、seed/prepared refs 和原逻辑所有者，创建唯一 Run/Attempt，
  原 WorkUnit/Task/step 从 waiting 转 claimed，替换当前 Run 指针，wait 变 resuming，并写 binding/invalidation。
  Run role 明确 resume，continuationReason 为 user_input_answer。原 Run/Attempt 保持 yielded，原 Turn 不变。
- admission 不获取实际执行资源、不启动 Runner、不写 applied；物理启动仍须当前 policy、semaphore/lease 和 executor 校验。
  有 binding 后不因 delivery lease 过期再创建 successor；恢复只读原 binding，不能通过重领替换执行权。
- ACK 要求 binding/frozen-input fingerprint 与 Runner receipt 匹配，且绑定的新完整 fence 当前有效，
  Run/Attempt/WorkUnit 和绑定 Task/step 已进入运行状态。只在同一事务写持久 receipt、applied、resumed 和投影。
  admission 后调度 lease 过期不替代执行 fence，也不能把一个已运行的接收结果随意重放。
- 精确 ACK replay 只返回旧 receipt，不改变状态；首次 ACK 遇旧 fence、取消、归档、替换、不同 receipt、半提交或损坏一律拒绝。
  审计 getter 可在后续执行结束后读取原 receipt，不能要求历史 receipt 永远属于最新 Attempt。
- transcript 只在完整 receipt lineage 存在时接受 applied，裸 applied 继续 unavailable；读取不得新开嵌套事务。

本段结束不等于 U2/U4/产品启动接线已完成。公开提问入口在 Host coordinator、全部 executor 停止及恢复验收前仍关闭。

接收实现为 `features/runs/user-input-continuation-receiver.ts`：只对已验证 Pi adapter、新建 queued Run /
created Attempt / claimed WorkUnit 接线；回调先提交 Host ACK，再允许 SDK 进入模型请求。
同一 receipt 的存储 replay 是审计回读，receiver 遇到 replay 必须拒绝第二次模型请求。
40 项 Core 专项和 8 项真实 SDK/临时 SQLite/模拟 transport 联合通过；并非真实模型或 App 验收。
覆盖 stored Task、workflow step、双连接 admission/ACK、COMMIT 回滚、父引用损坏、取消及 sibling approval。
完整结果和仍未接入的调度边界见 `output/user-input-host-admission-u3-handoff-20260909.md`。

取消等待是逻辑工作操作：pending request 取消、未消费 delivery obsolete，并关闭其逻辑所有者；
答案已保存时保留 receipt，不伪造为用户未回答。若 successor 已开始，按它自己的 fence 取消，
不能让旧源 Run 的回调找到“最新 attempt”后错误地终结新执行。
optional 的源工作已经完成时，答案只留审计，不自动复活工作。

### 4.4 U3 真实准备请求构建（2026-09-09，请求与 SDK 接收联合切片已验证）

请求 builder 与模型执行准备分层。builder 只读原 Run 的任务/请求快照、同 Run 停止 watermark 前的事件及冻结 seed；
不调用普通消息/queue_followup 入口，不创建 Turn/Task/Run，不向活跃 Pi session 注入回答。
任务身份、participant、workflowStep、源消息归属和原 delegated requirement 保持不变；新请求只使用 delivery 幂等身份。

- 原始任务上下文、原 Run 叙述/原子工具记录及已接受问题/答案分区渲染。叙述不充当操作完成证据。
- 不读取邻居 Agent、其他 Turn 或新历史。事件数/字符数超预算显式阻断准备，不静默丢弃答案或执行记录。
- 保存 seedRef、源输入 fingerprint、事件 watermark/refs。prepared request 已存在时只回读并校验原来源，不重新选取内容。
- 源 API key/headers、旧 permissionConfirmation、effectivePolicySnapshot 和资源租约不复制为新权限。
  保留非秘密 provider 路由及工具/技能请求上限；执行准备必须重新解析当前 provider/工具/权限。
  `sourcePolicyIntent` 单独冻结原只读/访问模式与 approvalProfile，不复制审批确认，也不把缺失确认解释为默认权限。
  普通 executeRunRequest 对 user_input_answer 或该内部上下文显式拒绝；只有专用协调层核验当前授权与原限制后才能启动。
- typed workflow 的原操作集合与当前 step 必须仍一致；不得把缺失的 typed requirement 当作普通执行。
- 这一步产物是新的三 surface RunRequest 和持久 preparation，不是实际 dispatch。SDK input、startup CAS、恢复协调仍需接通。

验证新增：原请求 builder 专项 29/29；builder → 真实 SDK 输入 → 唯一 Run admission → Host ACK → fixture transport
联合接收 14/14。三 surface 的已保存选项、Markdown 多行答案逐字发送，重开 SQLite 后不引入新话题；重复接收、
SDK system prompt/provider 漂移、replacement Attempt 和 ACK 写入失败不得开始模型 transport。
组合 readiness/副本原型专项 65/65；Electron 内嵌 Node 上 request/receiver 43/43，0 skip。
Daemon 最终 1718/1725，原 7 失败名称集合 added=[] / removed=[]；不是全绿。
这些数字不证明 execution builder、当前权限重验、真实模型或 packaged GUI 已完成。
execution plan 和启动状态转换仍由测试夹具组合，尚未替代真实 coordinator；原执行实际 SDK 中的 Memory/Skill
文本也未完整纳入新 execution preparation。不能据此宣称长任务恢复上下文完全不丢失。
详见 `output/user-input-prepared-request-u3-handoff-20260909.md`，以其中最后全量结果为当前基线。

### 4.5 三 surface Pi 源执行输入（2026-09-09，生产捕获接线已验证）

此节更新 §4.4 的源输入前置条件，不代表其 execution builder/coordinator 已完成。

- `prepared-runner-input.ts` 统一非秘密 SDK 输入的 capture/read/restore 和 Memory eligibility；
  普通会话模块只管理自己的 prepared request 父引用和首次持久化，继续复用原唯一 winner。
- Orchestrator 对实际 Pi adapter 的 normal/private/channel 执行，在 Run/WorkUnit 前捕获 SDK 输入；
  有 normal prepared execution 时复用其 payload，不进行第二次 SDK 准备。
- `Run.requestSnapshot.runnerExecutionInput` 持久保存有效 task、provider 描述、tools/MCP/media schema、
  runtime features/paths、system/append prompt、SDK 原始 model context、usedMemory 和 Skill source context。
  不保存凭据、审批确认、sandbox/资源租约或执行回调；公开 parser 不接受此内部字段。
- await SDK 准备后及 await sandbox 后，继续复核当前 provider、MCP、runner、Memory；当前 Host policy
  在这些 await 后解析。原 source input 不是当前权限，不因来源已经准备过而跳过复核。
- 非 Pi adapter 不能继承调用方伪造的 runnerExecutionInput，也不伪造 Pi 输入证据；其自身恢复合同仍未实现。

验证：共享捕获/N03 专项 27/27；Electron 内嵌 Node 联合 70/70；实际 Pi + 本机 SSE 服务 3/3，
逐字核对持久 SDK prompt 与实际请求，并核对工具名，覆盖创建文件、Engineer/QA 文件协作和 #421 续聊后保存。
Daemon 全量 1728/1735，原 7 fail 名称 added=[] / removed=[]；Daemon build/Web typecheck/diff check PASS。
本轮未改 Runner/Core 源码、未重跑二者全量，未打包/启动 GUI，没有真实模型或截图。

下一步必须消费这份源快照：U3 request 目前仍以原 request/task 快照为主，尚未统一用实际 SDK task 和
追加 Memory/Skill 输入；execution preparation 还须将新答案与源输入绑定、冻结 successor 有效 options、
校验当前资源/权限。不能只把旧 systemPrompt 拷贝进去就称恢复完成。
证据：`output/run-source-prepared-input-u3-handoff-20260909.md`。

### 4.6 U3 源 SDK 输入消费（2026-09-09，源输入切片已验证）

源 request/task snapshot 与实际 SDK task 可能不同，例如 stored Task 不含已接受会话上下文；
运行期 Memory/Skill 追加文本只存在 runnerExecutionInput。续接必须消费同一 source Run 的
真实输入，不从旧 request 重建或重新召回来填补，不给缺源 SDK 快照添加兼容 fallback。

- 独立只读 helper 校验源 Run/Task/channel/cwd、原 Attempt 的实际 runner、provider 和
  prepared input 指纹，得到 source execution input。先确认 owner，再读取文本。
- 续接 task 使用实际执行的任务正文，保留身份；system/append prompt 和 Memory 来源沿用
  原有效输入。工具/运行时请求上限从真实 source options 来，不采纳新工具或新 Agent。
- source execution 全体内容的指纹加入续接上下文 lineage；首份 request 保存后，source
  的 SDK 文本、工具、Memory/Skill 来源发生变化即拒绝重放，不能重采并覆盖首次输入。
- 原策略意图仍单独冻结；旧 effective policy、批准、凭据、callback、资源不复制。旧
  runnerExecutionInput 不放进 successor 请求冒充新 prepared execution。后续专用 execution
  builder 必须重验当前 Memory/Skill/provider/tool/权限，冻结新 SDK 输入并接 coordinator。
- 本切片不开放普通 Run 入口或问答工具，不把 request 构建通过当作实际恢复。第二次问答、
  current policy/资源 CAS、receiver 重启和 macOS 全矩阵仍需后续完整接线验证。

本切片 request 41/41，源输入缺失/损坏/foreign/task-prompt 不匹配均拒绝；三 surface
运行期 Memory/Skill 文本保留。source helper line/function 100%、branch 85.71%，不代表完整 U3。

### 4.7 U3 successor 执行输入持久化（2026-09-09，存储/接收切片已验证）

第一次答案续接的新 Run 也会成为下一次提问的 source。execution plan 必须保存自己的
`runnerExecutionInput`，不能只存 SDK fingerprint，更不能在第二次续接时借用原父 Run 输入。

- 该字段为内部新合同的必需字段，无缺省或旧记录 fallback。Core 只校验通用 envelope、
  runner/task/cwd/provider 和 preparedInput 之间的身份对应；SDK 正文及工具语义仍由 Daemon/Runner 校验。
- admission 在既有事务中把该字段写入新 Run.requestSnapshot。request preparation 仍保持
  原样，执行输入属于 execution plan，不反向覆盖原 request 或 seed，不新增 SQLite 表。
- binding 回读和 ACK 必须比对新 Run 的完整执行输入，缺失或更换后不能给出有效接收凭据。
- 这只是 execution builder 的必要持久化前置条件。当前 policy/资源、唯一启动 CAS、二次提问
  生产调度与真实 App 验收仍未完成，不因存储用例通过就声称自动恢复已经可用。

本切片先复现 Core 4 项行为红测，再扩展为 49/49。新增三 surface 的第二次问题/答案，
重开 SQLite 后再次走实际 builder、SDK preparation、admission 和 receiver，receiver 17/17。
物理 yield/start 和 execution plan 组装仍为测试夹具，不是生产 coordinator、真实模型或 GUI。
最终 Contracts 83/83、Core 901/901、Runner 169/169、Daemon 1803/1810（原 7 fail、0 skip）；
Electron 内嵌 Node 联合 107/107，Web 类型检查与三包 build:ci 通过。
证据及下一个 execution builder 实施单元见
源输入与 successor 交接 (`user-input-source-and-successor-u3-handoff-20260909.md`)。

#### U1-B 领取租约与单一续接意图（历史切片）

复用 user_input_deliveries，migration 133 只增领域列：revision、attemptCount、updatedAt、
claim owner/token/expiry、retryAt/errorCode、唯一 successorRunId。既有 pending row 的 updatedAt
以自身 createdAt 初始化，不改 conversation_items 或真实客户端数据库。错误只保存闭集 code，不保存异常正文或模型秘密。

- get/listDue/claim/retry 都按 workspace/thread scope 查询；读取验证 request/answer fingerprint 和 canonical
  question/answer item 的 scope、payload lineage。跨线程返回不存在，损坏记录不变成可重试工作。
- claim 在 BEGIN IMMEDIATE 内以 expectedRevision CAS。required 必须已有合法 wait checkpoint、
  原 Run/Attempt yielded、WorkUnit 无 active attempt、原 Task/step 仍 waiting；再次核对原子工具尾序号。
  optional 尚无安全续接点时只保持 pending；取消、已完成或不可见 consumer 标 obsolete，不创建 Run。
- 首次 claim 分配唯一 successorRunId，仅表示续接意图；过期重领、更换 worker 与失败重试都复用它。
  claim token 每次重领换新；lease 1–60,000ms，retryAt 不早于当前时刻且最长一小时。
  lease 过期或旧 revision/token/owner 的写回全部拒绝。已存在 successor Run 时不回收或重试，等待 U3
  receiver 根据该 Run、attempt、snapshot 和 applied evidence 恢复，不能重复启动。
- 取消在同一事务撤销仍无 successor 的合法 pending/claimed/failed delivery，清 lease 并加 revision；
  若已有 successor 或 applied，仍拒绝用旧 source 取消。缺 token/intent 的损坏 claimed row 不提供兼容释放。
- 状态和 control-plane invalidation 同事务提交；DB 两连接、reopen、lease expiry、COMMIT rollback
  必须有真实临时 SQLite 测试。事务中不 await，不碰模型或进程。
- 此切片不提供 applied ACK 写入口。ACK 必须由 U3 在唯一 successor、新冻结答案输入、接收侧幂等
  和当前执行权一并成立时提交；无真实接收证据不能标 applied。列表重试调度、Host coordinator、公开 API、
  三 surface hydration/UI、N03 和所有原验收仍需接线。claim lease 不等于执行授权或 OS 停止证明。

模块：delivery types / migration / records / store / cancellation helper 分层；waiting source 校验
从现有取消模块抽取共享，保留其条件。大型 sqlite-run-store 和 RunStore 只增加接线。

最终专项 51/51、相关问答/等待 140/140、Core 703/703、Electron 内嵌 Node 51/51；
Daemon 1520 pass / 原 7 fail，失败集合无变化。新模块 line 100%、branch 91.27%、function 96.43%。
到期列表只负责发现，claim 未启动 Run、没有 applied ACK，也不是 GUI/完整 U3 验收。
详见 U1-B 交接 (`user-input-delivery-u1b-handoff-20260907.md`)。

#### 已实现切片：安全让出后的用户取消（2026-09-07）

`cancelUserInputWait` 在单一写事务内验证 checkpoint、原 Run/Attempt/fence、WorkUnit、
Task binding 和当前 workflow step。仅允许尚无活动 successor 的有效等待；它关闭对应的
WorkUnit/Task/step，原 Run/Attempt 仍为 yielded，不追加旧执行事件或重写总结。
当前 step 的取消不等于取消整个 Workflow、所有依赖或独立分支；parent 聚合仍需完整 U2 接线。

- pending request 变 cancelled；answered request、receipt、canonical answer item 原样保留。
  U1-B 现按持久意图细分：本 owner 未消费且尚无 successor 的 pending/failed/合法 claimed 可变 obsolete；
  已有 successor、applied、损坏的无租约 claimed 或其他 consumer 明确拒绝，不误取消新执行。
- wait revision、逻辑取消事件、Turn/Thread 重算、control-plane invalidation 同事务提交；
  错误包括 COMMIT 失败均回滚。逻辑 audit 不借用已关闭的 attempt header，原 fence 仅为来源 data。
- 重复取消回读原结果；已有等待 checkpoint 后，request-only cancellation 拒绝，避免遗留孤儿等待。
- HTTP/RPC 取消入口返回原 Run.status=yielded、active=false 和 typed inputWait.status=cancelled。
  不 abort 后续注册的执行句柄；来源已替换或不再可取消时返回 HTTP 409 / RPC -32009。
- 同轮、不同轮的 running/waiting sibling 均保持原 Run/Attempt/WorkUnit 和 Thread 状态。

证据：取消切片交接 (`user-input-wait-cancellation-u2-handoff-20260907.md`)。
Core 全量 594/594，Electron 内嵌 Node 专项 54/54，Contracts 75/75、API client 51/51、Web 类型检查通过。
Daemon 全量 1487 项中 1480 pass / 7 fail，失败名称与此前完全一致，不是全绿。
这是可信测试夹具提交等待后的真实存储/HTTP/RPC 取消，不是真实 Runner 安全停止、GUI 或完整 U-09 验收。

#### 已实现切片：Thread 终态聚合与重启时的等待保全（2026-09-07）

已复现：Turn 保留 A 的 waiting_for_input，但 B 的成功/失败/取消回调或 stale-run recovery
仍直接把 Thread 改成对应终态。修复在 Core 共享等待投影和 Thread 写入边界，不为三 surface
分别修 UI。终态通知发生在 Run 状态写入前时，只排除通知所属 Run，不能清掉其他活动 Run。

- 存在有效 required wait 时，其他 queued/running 或 waiting_for_approval Run 优先保持其活动状态；
  没有其他活动执行才显示 waiting_for_input。损坏/blocked 等待显示 blocked，不捏造恢复能力。
- checkpoint 读取与 Thread 更新在 savepoint 的同一快照中；嵌套调用不提交上层事务，
  COMMIT 失败完整回滚，双连接竞争不能写入过时状态。基础设施异常继续抛出，不伪装成业务阻塞。
- 迟到终态通知不重新激活归档 Thread；用户显式 archivedAt=null 的取消归档仍允许。
  原有取消归档回归曾在全量测试中被捕获，已修复并复验，不能把中间失败省略为一次全绿。
- 已取消/已恢复的等待不覆盖后续终态。本切片不负责答案 claim/successor，也不修改原 yielded Run/Attempt。

最终证据：Core 611/611，Electron 内嵌 Node 专项 75/75，Web 219/219 与类型检查通过；
Daemon 1491 项中 1484 pass / 原 7 fail，新增失败为空。真实 loopback daemon 的 stop/start
验证了源等待、单 attempt、零占用及 HTTP Thread 状态；崩溃 sibling 为夹具构造，没有实际 kill 进程。
详见Thread 恢复交接 (`user-input-thread-recovery-u2-handoff-20260907.md`)。
这不是任意历史脏状态的修复迁移、完整 startup recovery、真实模型或 packaged GUI 验收。

restart 至少区分：request 写入前；request 已写但未停止；安全停止但事务未提交；
yielded 已提交待答案；receipt 已提交未 claim；claim 已提交未启动；successor 已启动未 ack。
每一处必须以持久证据恢复，不能因为“不在 activeRuns 内存中”就认为成功或可重放。
SDK idle 只证明 SDK 生命周期；OS 子进程和 Host tool job 的退出仍需各 executor 自己证明。

### 4.1 U2 实施中：SDK typed yield 与 Host 输入源（2026-09-07）

本节是完整 U2 的在建链路，不改变 §6 的退出门槛。不是已交付问答暂停，也不是 GUI 验收。

#### Runner 边界

- Host boundary callback 可返回闭集 `{kind:"user_input_required", requestId, requestVersion}`。
  undefined 表示没有暂停请求；任何其他形状报协议错误，不默认当作完成。
- `runTask` 正常 resolve 仍只表示 Runner 完成；`PiRunnerYielded` 是独立的 typed 控制出口，
  只在 SDK prompt/abort/idle 均已收束后抛出。没有通过修改正常结果的兼容默认值接受 yielded。
- deliberate yield 不发 run_end / run_error。真实 Host failure 与用户取消保留原语义；
  取消与 yield 竞争时不能生成暂停证明。Host 仍需重新验证原 fence、对应问题和原子事件。
- `sdkStoppedAt` 只证明 SDK 生命周期。它不是 UserInputQuiescence，也不是命令后代、
  MCP 远端 job 或生成任务已停止的证明。Host 不得直接把这个时间戳当完整 checkpoint receipt。
- SDK 0.84.4 并行批次会先 prepare 全部工具，再执行已准备项目。现已复现：
  第二次 preparation 拒绝后，第一项仍可能进入 Host callback。
  因此除 prepare 阶段外，实际 MCP、审批、权限、hydration、media 等 Host 调用入口共用
  per-run admission latch，关闭后不再启动新的 Host 动作。已在运行的回调仍须完成清理。
- 不在 tool/extension callback 内 await session idle；abort Promise 在回调外统一收取，
  SDK 清理失败不得发出 typed yield。

#### Core 源身份与等待槽

- 普通会话/私聊/频道均以实际 Run/WorkUnit/Turn 为准。并不是每个 Run 的 taskId
  都对应 tasks 表中的 Task；普通会话可以仅有 Run.taskSnapshot。
- 问题来源在创建时冻结 `taskBinding={kind:"stored_task"|"run_snapshot", taskId}`。
  stored_task 暂停时必须仍存在、running 且 currentRunId 正确；run_snapshot 不伪造 Task。
  存在性后续变化会使 source fingerprint 校验失败，不能把丢失的 Task 当无 Task 兼容路径。
- 这是尚未向模型开放的新问题领域格式，读取严格要求 taskBinding；不回填真实数据、
  不新增表、不重写历史，不给旧无字段记录静默补默认值。
- `findRequiredUserInputForAttempt` 是 Host 内部的原 fence 查询，不是公开查询路由。
  workspace/run/attempt + 完整 fence 隔离，查到记录后再核验其冻结来源。
- 同一 attempt 最多一个未结束的 required 等待槽，检查与创建在同一写事务。
  用户提前回答只是 receipt 已接受，未 checkpoint 前不会释放这个槽。optional 不占此槽。

下一步仍是 Host pause coordinator 与全部 executor quiescence 证明，再接 terminal / scheduler /
goal / cancellation / restart recovery。U4 共享 UI 和完整接线前仍不注册提问工具或公开创建入口。

#### U2 在建：Run/频道停机屏障

已复现并修复 registry/频道 worker 的两秒 deadline 被当成 idle、晚注册逃过停止、
以及 Run preflight 未纳入等待的窗口。停机原因锁定后新 Run 入口拒绝；已登记在途 HTTP、
整个 Run 请求、频道 drains 与后产生的 settlements 必须真正收束后才关闭 SQLite。
queued 观察者收到关闭错误但 durable 排队工作不被伪造完成；锁屏等待之前先完成 Host
开始记账，停止检查仍在 Runner 调用前，避免异常落到非法 queued -> runner_failed 转移。

默认停机等待不以时间推断安全；显式限时观察超时返回错误而不释放执行。
这不证明 OS 后代、远端 MCP 或 media/plugin jobs 已停止，也不直接产生 UserInputQuiescence。
未合作的 executor 仍需要后续可观察的阻塞/终止协议，不能靠恢复固定 sleep 解决。
证据与尚未覆盖的 producer 见 停机交接 (`user-input-shutdown-u2-handoff-20260907.md`)。
Runner typed yield 最终证据见 Runner 交接 (`user-input-runner-yield-u2-handoff-20260907.md`)。

## 5. U2-P：真实 SDK 前置修复证据

2026-09-07 历史核验使用的 Pi SDK 为 0.84.3。当前安装版本为 1.1.0；`AgentSession.prompt()` 的 `_runAgentPrompt()` 会等待
`agent.prompt()` 与 post-run continuation，然后 `_emitAgentSettled()`；
`abort()` await idle，而 `dispose()` 只是同步清理。实测正在执行工具的正常取消会等待清理，
两项并行工具也要全部结束，因此本轮没有把 fire-and-forget abort 宣称为已复现的提前收尾 bug。

本轮真实红测是：

- before_agent_start 的 Host await 期间取消，SDK 仍可能开始 agent.prompt，新建内部信号后发送一次请求。
- before_agent_start / before_provider_request 的 Host callback 抛错，SDK 捕获为 extension error 后继续，
  原 Adapter 最终仍能发出 `run_end`。

修复由 runner-pi 独立 `task-boundary.ts` 持有每 Run 的停止信号和首个边界错误；
Adapter 将它接入自己的 ModelRuntime，模型入口及 payload hook 返回后重验，原始错误返回 Host。
不用修改全局 fetch/SDK，不改权限，不引入持久 checkpoint，也不提前标 yielded。
这不是 N03 prepared-request 持久化实现；这里只防止请求在取消或 Host 拒绝之后继续发送。

验证：实际 Adapter + Pi session + Ling extensions + OpenAI SSE parser；仅替换该实例的 provider transport
为内存 Response，测试目录自行创建，不联网、不读凭据、不连接外部 MCP，不是 packaged GUI。
初始 7 项中 3 红；修复后扩展至 13/13，包括 tool boundary、并发 Run 隔离、双工具清理，
以及 Host 拒绝和用户取消的两种竞争顺序。Runner 全量 51/51、Runner build/typecheck 与 Daemon typecheck 通过。
新模块 coverage：line/function 100%、branch 85%；不代表整个 Runner 或完整 U2 覆盖率。
证据日志索引见 U2-P 交接 (`user-input-runner-boundary-u2p-handoff-20260907.md`)。

## 6. 下一完整实施单元及退出门槛

1. U2 pause coordinator + Core 原子 checkpoint/等待转移 + Runner typed yield result：一起实现，
   同时接 cancellation、late event、supervisor/recovery、Turn/Task 聚合、用量与 workflow callback。
   不交付“仅枚举已加”或“工具返回已等待”的半条链路。
2. U1 剩余 delivery 状态机 + U3 唯一 successor + scoped hydration/摘要 + N03 新输入：一起验证崩溃补投。
3. U4 API/client/共享 UI 完成后才注册提问工具与公开创建入口；再跑完整 U5/G/K/S/packaged。

| 必须补的测试 | 最小断言 | 当前状态 |
| --- | --- | --- |
| core 暂停事务 | 完整 fence、request/Run/Attempt/逻辑状态/lease 原子回滚，等待没有完成时间 | U2-C Core 专项 25/25；Host 安全停止仍未接 |
| core 新 Attempt 与 late callback | 新 owner 唯一；旧 event、heartbeat、action、terminal 不能改新结果 | Core 资源/事件隔离、captured hydration、两执行入口与 summary 准入见 §8；完整暂停/恢复仍未接 |
| daemon 生命周期 | 不调用成功/失败 callback；不占 semaphore；不自动 retry/goal 续跑 | not_run |
| workflow 二次提问 / fan-in | step.runId 保持关联；每次等待均不能生成 completed；最终 evidence 到齐才成功 | not_run |
| workflow 独立分支 | A 等答案后 B 能被及时调度；依赖 A 的汇总继续等待 | not_run |
| crash/restart 全窗口 | 持久恢复或明确阻塞；单 successor；副作用不确定时不盲重放 | not_run |
| goal accounting | yielded 费用计一次；不算成功证据；回答后的真正成功可继续原 goal chain | not_run |
| cancel/delete/optional | 旧答案不唤醒取消任务；receipt 不丢；等待可取消而不能直接误删 | 逻辑等待取消切片见 §4；delete/optional/真实恢复联动仍 not_run |
| UI/SSE/packaged | 同版本原位等待/回答/继续/终态，三 surface 与 child 同规则 | not_run |

## 7. U2-C：原子等待切片及迟到写入边界（2026-09-07）

- migration 132 只给问题表增加 wait status/revision/checkpoint/checksum 与索引，不新建 batch 表，
  不改 source 历史。checkpoint 和 answer receipt 的修订号分开，清理期间提前回答不会丢失。
- `commitUserInputYield` 在同一 `BEGIN IMMEDIATE` 中校验源 fence、必答问题、Host stop receipt、
  完整 tool log 和 pending approval，提交 Run/Attempt yielded、逻辑等待、资源释放、控制平面 invalidation。
  资源在 active pointer 清空前按完整旧 fence 释放；合法 workflow_step owner-level lease 单独释放，
  不是对“无 Attempt 的旧 Run”做兼容。事务/提交失败会完整回滚。
- Core 仅校验可信 Host receipt 与数据库事实，不自行证明 OS 子进程退出。工具入口仍关闭，
  不允许模型直接调用此存储方法声明自己安全停止。
- Semaphore acquire 在写事务中校验 current fence；resource lease 用 INSERT SELECT 原子校验，
  避免另一连接在预查后提交 yield。旧 heartbeat/renew/release 不影响新 Attempt 的资源。
- `appendEvent` 的 SQLite admission 拒绝 yielded Run 的执行文本/工具/结果，拒绝发生在 event 文件写入前。
  专用 `appendIgnoredRunnerCompletionEvent` 只发布固定 audit kind；不开放任意终态写入或业务成功。
  direct Run setter 不覆盖 yielded，不生成错误的 skill success/failure 记账。
- Turn 从所有相关 yielded Run 的有效 checkpoint 投影，不能只看最新 sibling；A 等输入、B 完成后
  仍是等待。checkpoint 损坏显示 blocked，不伪造可恢复状态。历史 progress 也不让 trace 永远 running。
- Daemon runner cancellation 的第一次逻辑转移即携带原 fence；replaced/yielded 旧回调不改变新工作。
  普通当前执行的取消仍保留。等待任务的 owner/system 取消协议尚待完整 U2 接线。
- 现有 UI status consumers 已显式区分“执行已让出”和“等待用户输入”，无绿色成功/红色失败。
  缺少 durable wait 数据的 thread fallback 保持 blocked，不能凭 Run yielded 发明恢复依据。

验证：Core 554/554（含 25 项暂停专项）、Contracts 75/75、UI-core 137/137、Web 219/219；
Daemon 取消隔离/审计 5/5、审批恢复/监督器 9/9；Contracts/Core/Daemon 构建及 Web 类型检查通过。
具体红→绿过程、日志和剩余入口见 U2-C 交接 (`user-input-atomic-wait-u2c-handoff-20260907.md`)。
无真实模型请求、无 packaged App 测试、无真实数据库修改；不能标完整 U2/U3/U4/U5 或 G/K/S 通过。

## 8. Captured execution admission 与总结发布顺序（2026-09-07）

本节延续 U2，不另起一套执行计划。源任务「查找 Codex 问题说明」的最新设计轮次
01a077d1-3330-71f2-89e8-f9b9875aadc5 已重新核验，未出现与联合设计冲突的新决定。
用户已确认按 Core、普通执行、审批恢复和测试的完整链路修复；不新增表、不改真实 SQLite、不提交代码。

### 8.1 完成权不是“Run 看起来还在 running”

身份从 Host dispatch 前捕获，包含 workUnitId、attemptId、runtimeInstanceId、fencingToken。
回调绝不能通过当前 activeAttemptId 找到新 attempt 后重建自己的身份。
Core 的 `appendExecutionEvent` 和 `transitionRunExecutionStatus` 是强制 fence 入口；Host 管理
使用现有独立入口，固定类型 audit 仍使用 `appendIgnoredRunnerCompletionEvent`。
不是给 Runner 增加可选 fence 并在缺省时放行。

SQLite INSERT/UPDATE 自身验证 Run → WorkUnit → 当前 Attempt、linkedRunId、完整 fence、
状态和 endedAt。预检查只用于尽早拒绝，不能取代写语句内校验；另一连接在预查后接手时
旧写入仍必须失败。拒绝发生在 event 文件、工具 invalidation、artifact 派生和对外 stream 之前。

| 边界 | 允许 | 拒绝 |
| --- | --- | --- |
| hydration / 新工具 / 成功结论 | 原身份仍当前且未停止 | 新 attempt、yielded、终态、取消中的新工作 |
| 取消/超时清理 | 当前身份的 tool update/end、run error/cancel 与失败收尾 | 成功结论、新 tool start、其他 attempt 的清理 |
| 终态业务回调 | 同一原身份的 Host 合法终态，可启动已批准的 interrupt redirect 续接 | 已被替换的旧身份，不能替新 attempt 发布或再次结算 |
| 迟到审计 | 固定 stale_runner_completion_ignored，保留旧来源 | 任意工具/结果伪装 audit |

普通执行与 approval-resume 两入口共用 Core 准入，不能仅修 orchestrator。
旧回调 finally 只释放原 fence 的 lease/semaphore；只移除同 attempt 的 ActiveRun 注册。
终态 reconciliation 需要的是原身份匹配，而不是重新开放执行；这两个 predicate 不得合并。

### 8.2 总结是已获准终态的派生文件

顺序固定为：获准的原子执行事件 → captured fence 的状态 CAS（审批恢复为其原子 terminal
commit）→ 派生 summary → 原身份的下游业务回调。成功、失败和审批恢复均不能在 CAS
之前写 summary；CAS 失败保留原文件字节不变，只追加固定迟到审计。

summary 不作为 SQLite authority，也不是新的 completion evidence。数据库提交后文件写入失败
不会反转已经提交的运行结果；summaryPath 是派生文件位置，不是文件已存在或内容可信的证明。
消费者及后续恢复不能仅凭这个路径推断任务完成。文件与 SQLite 不承诺跨介质原子提交。

### 8.3 证据与剩余边界

- 工具加载 13 项：current、cached replay、materialization 中换 attempt、完整身份伪造、
  cancelled/yielded/succeeded、迟到 rejection；不返回新 schema，也不污染新 attempt。
- 真实执行路径先复现 6 项中 5 个行为失败：新 owner 被旧 success/failure 结算、普通与
  审批恢复的 summary 在 completion CAS 失败时被覆盖。测试 Runner 在内存中，不称真实模型或 GUI。
- Core 14 项覆盖完整身份、终态/解绑、payload normalization 期间换 owner、两 SQLite
  连接在预查与 UPDATE 间竞争，以及 timeout cleanup 与新工具的区别。
- 全量验证发现并修复本次 interrupt redirect 回归：Host 已取消原 Run 后仍需原身份 callback；
  新增 host-cancel / replaced-terminal 成对用例，不能靠恢复任意终态 callback 让测试通过。
- 完整日志、全量失败清单与最终状态见
  执行写入隔离交接 (`user-input-execution-admission-u2-handoff-20260907.md`)。

这仍不是完整 U2：Runner typed yield、Host/SDK/OS 真正停止、逻辑等待取消、restart recovery、
唯一 successor、答案投递/新冻结输入、共享提问 UI 与原 G/K/U/S/packaged 全部矩阵保持未完成。
不将局部 late-write admission 等同于所有外部副作用都已经具备安全暂停协议。

**VERDICT:** 核心生命周期接线要求和 Runner 可复现前置风险已明确；没有新增需要用户选择的
产品方向。完整暂停/恢复仍待实现和上述测试，不标 CLEARED。
**UNRESOLVED DECISIONS（2026-09-08 更新）:** N03/batch 与普通/私聊归属、MCP/SDK 内部链路
已获连续实施授权，不再按文件数量逐次确认。外部 Relay、T2-B 和 AR 策略仍独立待决；
不改同事 WIP、不提交代码。前文各历史切片的范围待答记录由本条更新覆盖，不表示实现已完成。

## 9. U2 内部暂停屏障增量（2026-10-03，生产路由尚未开启）

按既定合同实现独立模块，不重写Pi session或把SQL/执行器逻辑塞进Orchestrator：

- Runner内部opt-in的sequential `request_user_input`真实接入SDK active tool list。Host收到的只有toolCallId与untrusted question payload；问题source/fence/idempotency仍由Host选择。严格receipt只保留kind/requestId/requestVersion，禁止accessor/额外字段，冻结副本。required回调返回前关闭共享Runner latch；SDK清理收束后才给typed yield。
- `AttemptExecutorGroup`同步保留captured Run/四元fence，私有ticket身份验证、同次准入关闭和effect launch复验。producer必须在派生启动前登记；关闭后禁止晚登记。Host独立校验whole-operation durable proof，unknown/timeout/callback返回/leader退出不能成为安全settlement或释放许可。
- `UserInputPauseCoordinator`同步Core创建后同回调关闭Host准入，required优先于其他boundary；typed SDKyield→本attempt drain→最终真实event watermark→Core原子checkpoint。无ActiveRuns取消或全局idle、无隐藏terminal finalizer/资源释放。早答先保存outbox，安全yield前claim拒绝；blocked保留原执行权且无safe wait。
- Core同事务共享durable veto覆盖Broker活动/unknown、Host command journal、source media与未知工具协议，并被yield/claim复用。全fence和immutable历史source不借successor身份；不改已有记录或将terminal等同已知停止。

当前已执行command journal `completed`仍明确descendants=unverified；media/MCP/plugin/remote缺完整ownership/confirmed-stop协议时，required yield保持blocked。不能改字符串、清blocker或以SDKidle掩盖能力缺口。

实际自动验证：Core1071/1071、Runner244/244、首次Daemon2225/2225。独立审查的cancelled create replay/pending expiry均已隔离SQLite RED确认，修复后group/coordinator/probe50/50：Core create幂等receipt不等于request仍活跃，create与boundary共享active guard，expiry仅否决pending，已接受answer仍有效；required再匹配当前identity才close。独立窄审查已收口，最终稳定Daemon全套2229/2229、exit0、0fail/cancel/skip；中止日志不计通过。三surfacecoordinator测试是真实PiSDK+临时SQLite+确定性provider transport，不是executeRunRequest/真实模型/GUI。完整日志和未完成项见`output/e6-20260928/U-PAUSE-SLICE-20261003.md`。

生产还需具体executor协议/wrappers、Orchestrator typed-yield与blocked保全、physical-close记账/Goal/频道调度、唯一answer continuation与当前权限/资源复验、delivery/recovery/API/共享UI及packaged矩阵。完成前不向生产模型/公开创建路由开启工具。
**UNRESOLVED DECISIONS：无新增用户产品决策。以上为工程门禁，不因内部切片通过宣布完整U完成。**

## 10. U2 Host operation 的持久成员与文件副作用边界（2026-10-03，实施中）

内存group与domain执行记录必须一对一连接；模型toolCallId、成功文本、成对tool_end都不是这个连接。
由group创建operationId，在任何异步准备或派生启动前持久化完整Run/四元fence、kind、toolCallId、parent/producer。
新Host operation journal只记录执行成员和安全事实，不新增UI batch，不重写旧历史，不赋予数据库行重放能力；live ticket仍由原Host store私有对象持有。

状态为`admitted → launched → safe | unknown_outcome`：

- domain evidence绑定不可替换且一对一，使用Broker实际返回的executionId或Host command实际返回的executionId，不按工具名猜记录。
- 第一次物理副作用与captured owner复验、journal launched写入共享同步SQLite writer边界；同operation后续effect仍同步复验，不能仅在异步callback入口检查。
- 文件snapshot/evidence准备留在事务之外；每个真正write/delete callback进入guard。rollback只处理原operation已发生的effect，允许关闭准入后的bounded cleanup，但必须保持原owner，不能借successor写入。
- 副作用发生后COMMIT失败、callback抛出、thenable误入同步launch，都不得回滚内存launch事实后宣称known-no-start。durable admitted/unknown仍阻断yield/claim/restart；一次观察超时也不改变它。
- 首片safe闭集仅含真实未launch且domain无effect的no-start，以及完整file Broker事实：原source、bind-before-start、terminal已知outcome、真实result digest、sealed policy/result artifact及时间/lineage全部独立核验。safe行在yield/claim同事务再次读取并重验，不信任先前缓存。
- approved file result也封存在SQLite；artifact-created公开metadata排除sealedPayload/contentSha256。不从当前磁盘读旧结果来替代封存证据。
- launched command的preparation helper/OS后代，以及MCP/media/plugin/远端job，本片无whole-operation停止合同时保持unknown。不能用主命令not_started掩盖已派生helper，也不能凭通用callback完成升级safe。

本片门禁要求：真实临时SQLite、精确domain绑定、双连接换owner、父子成员、reopen保全、无副作用拒绝、真实File Broker多文件写入/删除/回滚、off/shadow/enforce不绕过，以及新guard引出的删除回滚恢复缺口。日志与状态见`output/e6-20260928/U-HOST-OPERATIONS-20261003.md`。
本节是接续既有工程合同，不表示工具已对模型开启；Orchestrator非terminal保全、physical-close、答案续接和packaged Computer Use仍按§9门禁继续。
**UNRESOLVED DECISIONS：无新增产品决策；上述生产接线与验证未完成前不得宣布完整U可用。**

## 11. U2 本地 writer 与 retained authority 分层（2026-10-03，增量在建）

`enableUserInputPause`只允许可信Host内部验证opt-in，默认关闭，不读公开Run input。
问答能力同时要求该Run冻结的`harnessFeatureSnapshot.toolBroker === "enforce"`、canonical source item和非delegated执行。
off/shadow不暴露`request_user_input`，也不因内部opt-in创建依赖Broker回执的Host tracker；保留原文件执行语义，
不把模式偷偷升级为enforce。初始准备、重准备/恢复与执行coordinator共用同一能力判定。
已封存true但当前判定不满足时沿用`prepared_tool_capability_changed`拒绝，不修改封存输入/fingerprint；
已封存false也不因当前gate打开而增添工具。完整文件effect/停止证明仍只认实际durable Broker receipt。
准备、封存、恢复、extension和真实SDK以同一`initialToolSurface.userInput`选择工具；显式false优先于callback presence。
封存true不能在gate撤销后恢复，封存false也不能因gate后来打开而临时加工具。fingerprint校验不放宽。
required检查在lock await前后复验，不能靠await之前的一次检查允许之后provider继续。

暂停有三种不同事实，不能相互替代：

1. SDK已退出且取消订阅/dispose完成（typed yield）。
2. captured source最外层Host callback与派生**本地writer**实际完成；包括Broker后置写入和cleanup。
3. Core独立验证的whole-operation physical/effect证据已提交；只有它能允许safe checkpoint、lease释放及answer successor。

`AttemptLocalWriterGroup`负责第2项：同步登记、私有completion closure、关闭后禁止新callback，独立background producer预登记。
有限观察窗口只返回blocked，不释放成员或生成安全证据。SDK/Host operation观察和本地writer观察都不能无限阻塞执行函数。
`ActiveRunRegistry.retainBlockedAttempt`在函数返回前接管剩余callback；本地writer真正完成后只清理live timer/entry/completion，保留SQLite Run/Attempt/resources与unknown blocker。
原source cleanup只可移除同一live对象，不触碰successor。pending required尚无safe wait时generic cancel不得将retained source终态化并释放权限；已yielded的等待取消继续走既有原子入口。

文件/command admission在最外层审批排队前捕获；file使用真实Broker receipt，command/native preparation各自持久化成员并在真正spawn/send前复验。
native helper实际spawn后COMMIT失败不能立刻丢handle；统一close/deadline observer和原source bounded cleanup必须仍存在。kill返回true/pipe destroy/deadline都不是stop证明，当前command/remote未证实scope仍unknown。

Reviewer在实际`runTask`的第一同步步骤登记私有local producer，每个retry独立ticket，底层Runner及输出校验真正resolve/reject后才释放。
manual/deadline可以及时返回，但coordinator的physical slot等待underlying promise真正settle；已settled的路径不额外占用microtask，retry重置settled状态。外层approval callback负责Host后置Store/CAS写入。
这一local completion不生成Core safe/remote stop，不能解除unknown。Media background整链已使用共享`MediaLocalExecutionRegistry`替代丢失finish closure的占位producer：首写前reserve，捕获一次原source，绑定后覆盖dispatch/catch尾写、timer→tick、collector和completion；202或父callback返回不算drain。shutdown先禁新effect/清futuretimer，等待已进入本地writer后才关闭Store，不伪造远端停止。
Core在同一Media创建/复用事务中验证并保存现有child request的`executionAdmission`；只有同Store已验证、冻结、一次性内部snapshot可保留真实fencingToken，普通秘密及伪造request仍脱敏。serializer在脱敏遍历后复验实际SQLite事务及原owner。复用核验source/digest/toolCall/child-job链接，重启、审批或手动缺原opaque capability时不重新submit；旧父/child换代的迟到写入显式拒绝。
控制入口在任何intervention/step/approval/resource写入前校验；频道先校验全部linked nonterminal/non-yielded Runs，避免部分取消。普通terminal-linked reconciliation不被required wait误伤，安全yielded等待走Core原子取消事务。
Reviewer37/37、真实Orchestrator shutdown1/1、最新合并窄矩阵136/136及Daemon全套2383/2383均已通过（0fail/cancel/skip）；证据与后续状态见`output/e6-20260928/CONTINUE-HERE.md`。
Media本地切片Core37/37、Daemon74/74窄矩阵及最终Core1172/1172、Daemon2432/2432 full通过，两个独立窄复核0新增finding；冻结源码与全部原RED保留于`U-MEDIA-LOCAL-ACCEPTANCE-20261003.md`。Media独立typed remote receipt/physical proof、其余executor完整证据、retained restart、answer continuation/delivery/recovery与新packaged Computer Use仍待同总计划继续。本地full不冒充整体U或GUI验收。

UNRESOLVED DECISIONS：无新增产品决策；这是既定执行安全合同的实现分层，整体U尚未完成。
