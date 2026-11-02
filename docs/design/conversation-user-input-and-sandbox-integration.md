# 结构化提问、原生沙盒与 Typed Transcript 联合实施设计

Status: 已纳入总计划；U0、U1-A、U2-P 与 U2-C Core 原子等待切片已验证；完整投递/暂停恢复/UI/沙盒及联合验收未完成。本文不作为整体通过证明。
Date: 2026-09-07
Implementation baseline: 284f8c3c05f468a256adb4cee64c4455da834a4b
Remote main at import: 44f48cf85e6218b1e07213de588222ef9a7719a8（导入时核验）
Remote main rechecked: 7679003189711eaceb1f57ef39f2c8937f22a215（用户授权 4 提交整合；no-commit merge 与 WIP 保留，2026-09-07 再次 ls-remote 一致）
Scope: 用户要求将「确认 Ling 沙盒与 Codex 处理方式」「查找 Codex 问题说明」与当前计划一起处理。

总入口仍为 [Typed Transcript 实现计划](conversation-codex-style-transcript-implementation-plan.md)。
平台细节由 [原生沙盒 V1](platform-native-sandbox-v1-implementation-plan.md) 管理；
[本机查询能力](channel-execution-capability-integration-plan.md) 与
[上下文快照细设计（§22）](conversation-typed-transcript-detailed-design.md) 的实现责任保持独立。
本文只拥有结构化提问细节及跨计划接缝，不再复制平台实现算法或重编号原 G/K 验收门槛。

## 1. 来源、现有能力与明确差异

- 沙盒任务已有设计文档，来源基线 8b259da0 是当前实现 HEAD 的祖先。纳入文档即可，
  不需要合并旧任务分支，更不需要覆盖 canonical 工作区的审批/UI WIP。
- 提问任务最新一轮只有会话内方案，未落盘、未实现。本文将其变为可执行设计。
  会话来源任务 ID 为 01a073fe-b7cf-7832-8d2e-4d4a1ad1adcf；方案轮次
  01a077d1-3330-71f2-89e8-f9b9875aadc5。截图标题只是定位线索，不是额外权限授权。
- contracts/conversation-continuity 已有 canonical item、actor、visibility 与 domain refs；
  新能力扩展闭集和共享 projection，不能把问答仅存在组件或 runner 内存里。
- daemon/features/runs/interventions 的 maybeStartNextRunInterventionContinuation 当前先检查
  isTerminalRunStatus(sourceRun.status)，非终态直接返回。必须回答的问题不能直接套用此队列。
- core/run-types 的 RunStatus 当前没有等待输入语义；runtime-supervisor-types 的 attempt
  也没有安全让出语义。这是控制面工程，不是新增一个弹窗即可完成。
- 现有 approval checkpoint、attempt fence、lease、continuation、context snapshot 都复用。
  不建立第二套授权存储、不向模型授予填写其他 Agent 身份的能力。
- 另一任务引用的 RuntimeApprovalDialogQueue 属于 canonical 工作区未提交 WIP；
  当前恢复分支仍有 RuntimeApprovalComposerGate/ApprovalDecisionDialog。以实际合入接口
  接线，不导入不存在的组件，不在本轮重写同事的审批迁移。

## 2. 统一原则与作用域

三类事实严格分开：

| 事实 | 唯一权威 | 不代表什么 |
| --- | --- | --- |
| 用户选择、补充或澄清 | 持久化问题、答案和回答人 | 不等于文件/网络/执行授权 |
| 操作许可与有效权限 | Host 审批、grant、当前有效策略 | 不等于操作已经执行成功 |
| 实际执行及完成 | 原子 ExecutionAction、RunEvent、Completion Gate | 不从提问已回答或 batch 数量推断 |

普通会话、私聊、频道 root/topic/branch、depth-1 child 使用同一问题 renderer、回答窗口、
待答列表和状态规则。私聊只允许当前真实 participant，不出现无关 Agent 的问题。
频道只额外提供来源 participant、依赖关系与团队级待答数量。

问题默认属于一个逻辑工作与一个提问者。来源 run/attempt 是审计身份，续接 run/attempt
是单独的投递目标，不通过修改原问题来源“迁移”归属。默认不广播答案；显式共享决定
必须由 Host 校验依赖图、同一 scope 与可见性，不能仅按相似文字自动合并。
已有头像时不重复堆叠 Agent 名字；来源、任务和等待原因必须可访问，必要时在详情/tooltip 中呈现。

## 3. UserInputRequest 与答案契约

Host 生成或验证的字段：

| 字段组 | 必需信息 |
| --- | --- |
| 身份 | requestId、requestVersion、statusRevision、toolCallId、idempotencyKey |
| 所属范围 | workspaceId、threadId、turnId、sourceItemId、visibility |
| 提问来源 | participantId、workUnitId、workflowStepId、sourceRunId、sourceAttemptId、attempt fence |
| 问题内容 | questionId、prompt、optionId/label、允许自由输入、是否必答、schemaVersion |
| 等待语义 | optional 或 required；经 Host 验证的 dependent work refs |
| 授权关联 | 可空 approvalRequestId、operation fingerprint、scope/policy 引用；模型不得自行构造生效授权 |
| 历史关联 | sourceRefs、acceptedSnapshotId、preparedRequestRef、supersedesRequestId |
| 状态 | pending/answered/skipped/cancelled/expired/superseded；createdAt/expiresAt/resolvedAt |
| 回答 | answerId、requestId/version、逐 question 的 optionId 或 text、answeredBy、answeredAt、payloadHash |

首版支持单选与自由输入，不做多选、复杂表单或文件上传。问题数量和文本长度在 contracts
统一设上限，工具、API 与 UI 共用验证器；未知字段、重复 ID、未知选项、必答缺项均拒绝。
U0 协议切片固定上限：每请求 1–3 个问题，每题 0–4 个选项（无选项时必须允许自由输入）；
ID 为 1–128 位 ASCII 字母/数字/点/冒号/下划线/连字符且首位为字母或数字，prompt 最多
4,000、option label 最多 500、自由答案最多 8,000 个 JS UTF-16 code units。不做隐式截断、
类型转换或空白归一化；拒绝空白答案及非法控制字符。required 等待至少包含一个必答问题。
模型工具只接受 schemaVersion、waitMode、questions；归属、grant、依赖和审批关联由 Host
另行填充，不能塞进工具参数。答案接口只接受 requestId、expectedVersion/expectedStatusRevision、
idempotencyKey 和明确的 option/text 回答；不接受回答人、状态、投递或审批决定等自报字段。
纯验证器不是授权/幂等/投递器；Host 仍必须验证访问权，在事务内 CAS，并在完整请求状态下
检查原始过期时间。相同已提交重试由 store 在 pending-only 验证前回读首个持久化 receipt，
不得因为请求已 answered 就重复执行或把不同 payload 当作幂等。
问题内容发布后不可就地改写；修订创建新版本/新记录并显式 supersede，旧窗口提交返回冲突。
默认预选不是提交；超时不能取默认选项充当用户回答。必答问题不提供隐式 skip。

提交需要 expectedVersion/statusRevision 与 idempotencyKey。同 key 同 payload 回读首次结果；
同 key 不同 payload 或已被他人回答的不同答案返回 409，不覆盖原答案。
用户身份由认证上下文确定，不接受 body 自报 answeredBy。

## 4. 持久化、API 与可靠投递

建议增加问题领域的 request、answer、delivery 三类 SQLite 记录，显式共享问题时另有
dependency 关系记录。问题 schema 是有界、版本化 aggregate，不为每个按钮建立新业务系统。
这不是 UI batch 表，也不取代 conversation_items 或已有 approval 表。

必要唯一约束/索引：

- request: scope + sourceAttemptId + toolCallId + idempotencyKey 唯一；
  threadId/status/createdAt 及 sourceRunId/sourceAttemptId 可索引查询。
- answer: requestId/requestVersion 唯一；回答幂等 key 与 payloadHash 一起检查。
- delivery: answerId + validated consumer identity 唯一；pending/nextAttemptAt 可 claim。
- dependency: requestId + logical dependent ref 唯一；禁止跨 workspace 或形成等待环。
- 所有外键、事务 rollback、数据库关闭重开和两个连接并发测试纳入 U1。

创建问题时，同一同步事务写 request、canonical request item 与 revision/invalidation 事实。
回答时，同一同步事务执行 CAS、写 answer、canonical answer item、delivery/outbox 和通知 revision。
事务外发送 SSE/唤醒调度器。不得跨模型、文件、网络或 runner await 持有 SQL 事务。

API/client 语义：scope 内 list/get；Host-only create/supersede；authenticated submit/cancel；
稳定分页 cursor；404 不泄漏其他 scope 的存在；400 为格式问题；409 为版本/状态冲突；
410 为已过期的可见请求。具体路由接入现有 daemon 路由约定，不新增公开 helper 端口。

答案已保存与已投递是两个状态。delivery 至少区分 pending、claimed、applied、failed、
obsolete，保存 claim lease、retryAt、targetRun/attempt 与最后错误。UI 提交成功后可显示
“答案已保存，等待任务继续”，不能提前宣称 Agent 已接收。

投递采用可重试发送 + 接收侧幂等，不承诺跨进程副作用天然 exactly-once。
answer/delivery identity 绑定唯一 continuation，写 checkpoint 与消费标记原子关联；
进程崩溃后先查已有 successor，不得创建第二个 run 或重放已完成的写入/外发。
副作用结果不确定时返回明确恢复阻塞，不能自动重跑整个任务。

## 5. Runner 暂停、定向恢复与多 Agent

    Pi/Agent 提问
        -> Host 校验并持久化 request + canonical item
        -> optional：继续独立工作
        -> required：达到工具安全边界，保存 checkpoint
             -> fence 旧执行，释放 lease/进程
             -> 逻辑工作 waiting_for_input
    用户提交
        -> CAS 保存 answer + delivery
        -> 校验问题、依赖、取消状态与当前权限
        -> claim 唯一续接
        -> 新 attempt/关联 run + 新冻结输入
        -> 原子执行 evidence
        -> required evidence 到齐才允许 fan-in/TerminalReport

物理执行与逻辑工作必须分层。建议 Run/Attempt 增加 yielded（安全让出）结果，
逻辑 WorkUnit/Turn/必要的 workflow step 显示 waiting_for_input。yielded 只表示旧执行资源
已经结束，不是成功、失败或用户取消；其结束不得发布成功报告或触发普通 terminal goal 自动续跑。
新执行通过 continuationReason=user_input_answer 和 parent run、answer refs 明确关联。
这组状态名称及 exhaustive consumers 必须在 D0/U0 锁定、U2 红测后实现；不能仅前端映射。
需分离“资源已结束”和“业务有完成结论”两个 predicate，审计每个 terminal handler。

暂停协议必须确保旧执行具备可续接条件且 fencing 生效后才标 yielded/释放执行权。
2026-09-09 用户已确认取消采用尽力终止；取消不等于安全让出。停止未确认时仍禁止重叠写入
和自动 successor；不能用 leader exit/管道关闭冒充任意后代停止。详见[已确认边界](channel-seven-execution-closure-plan.md)。
不支持安全让出的 runner 返回 runner_unsupported；不能伪装已保存 checkpoint。
等待期间不持有 SQL 事务，不占用执行 semaphore，不通过定时重启模型重复提问。
已有未确认副作用不能被包装成安全 checkpoint。

optional 回答可立即保存，但仅在 Host 明确的安全续接点进入上下文。源工作已完成/被取消、
request 被 supersede 或 consumer 不再有效时，标 delivery obsolete，不自动启动新任务。
用户若仍要继续，应显式建立新的 follow-up，而非复活旧 attempt。

多 Agent 的等待传播按实际 dependency refs；A 必答只停 A 及依赖 A 的步骤，独立 B 继续。
fan-in 保留“等待用户输入，缺 A 的证据”，不把 answer 或 yielded 算作 completion evidence。
必答问题无法绕过，skip/expiry 必须回到明确 blocked/可恢复状态，不静默继续。
目标模式对此采用等待输入 stop reason，不当成失败进行自动 retry，也不反复催问。

## 6. 与 N03、沙盒和 Host capability 的接缝

- N03 accepted snapshot 表示该次接受的 canonical 输入；prepared request 表示 materialization/config
  后冻结的实际请求。后来答案不修改旧快照，续接创建新快照并引用 answer/request 与原 checkpoint。
  并发只能有一个准备结果；重启不能重新采样历史冒充首次输入。
- snapshot 记录原策略用于审计，不是永久有效 grant。每次执行/恢复重新验证撤销、过期、scope、
  attempt fence 与 backend readiness；历史 grant 已撤销时不得由旧 snapshot 恢复权限。
- 普通回答只更新指定工作上下文。涉及权限的问题必须绑定 Host 创建的 approvalRequestId 和
  不变的 operation/scope fingerprint，提交进入已有审批 decision handler；避免重复询问，
  但不得从自由文本“可以”推断 approve/full_access。
- approval 是权威；若回答持久化和审批决定无法复用同一事务，增加幂等协调状态，在审批结果
  未提交前不标权限已生效、不投递执行续接。失效审批返回可理解的 stale 状态。
- operation 的目录、参数、补丁或网络 scope 改变后旧许可不适用。只在已验证 scope 内编译
  ExecutionSandboxPolicy，policyHash 由 Host 计算，不由模型填写。
- 多 Agent 共用受限 executor 接口，不共用目录、网络或 Windows 账户的可变 grant 集合。
- host.local_network_info 仍是具名 Host 能力与独立授权，不通过 shell 绕过，不重复接管
  workspace-file viewer 的短期 capability。其返回仍进入现有原子事实与隐私过滤链路。
- Windows 一次 UAC 是平台初始化流程；回答结构化问题不代替系统 UAC，也不授权本轮改账户/ACL。
- 用户填写的秘密不得进入通用问答正文。需要凭据时引导既有 secrets 通道；
  visibility 在问题列表、模型上下文、显示、复制、fork 与结果报告中一致过滤。

## 7. 共享 UI 与信息密度

新增共享 UserInputRequestRow、UserInputAnswerRow、UserInputDialog、待答列表 controller；
surface 只传 scope/participant chrome 与 Host callbacks。组件名为实现建议，不代表已经存在。

- canonical 增加 user_input_request/user_input_answer 与 domain refs，共享 projector/registry
  穷尽处理；不能伪装为 commandExecution、assistant summary 或审批成功 evidence。
- request 是独立的交互协议行，answer 是用户来源，沿用用户右侧轨道；不额外造 Ling 回话。
- 问题不属于 command/exploration batch；它是 batching 边界，不能隐藏在已读次数里。
- Timeline 原位显示紧凑待答状态，点击打开可关闭的窗口。关闭仅收起，不取消问题。
  多问题显示一个 scoped 待答入口，由用户选择，不连环弹窗抢焦点。
- 只有一个 active mutation owner。Timeline/列表可提供定位入口；表单只在统一窗口存在，
  不同时在 Composer、Inspector、环境浮窗再放一套问答正文。
- 保存前按钮有 disabled/aria-busy，失败保留草稿。服务端 receipt 后转为已答；
  delivery 未完成显示等待投递，可查看原因，而非伪装运行中。
- 聚焦、Escape、窄屏、light/dark、reduced motion、鼠标与键盘都使用现有 UI primitives。
  敏感草稿不写 localStorage；跨刷新可重新输入，不以持久化草稿扩大隐私范围。
- 问答按真实 sequence 保留子 Agent narration/工具交错顺序。根 display rows windowing、
  disclosure 与 locator 复用现有方案，不 mount 嵌套 Timeline。
- 复制沿用整 turn 的公开文本口径与 hover/focus 显示；待答交互控件/内部投递错误不当作
  Agent 回答正文。最终报告如引用用户决定，只引用可见 answer source，不能算执行验证。

## 8. 实施顺序与模块边界

沿用 D0 → E1 → E2 → E3/E4 → E5 → E6。T0–T6 为沙盒内部任务，
U0–U5 为问答内部任务，不替代 G-00–G-12、§6.3、K-01–K-07。

| 顺序 | 工作包 | 主要模块 | 退出证据 |
| --- | --- | --- | --- |
| 1 | D0 / U0 + T0/T1 契约锁定 | contracts、core 策略/状态、native helper 协议 | 状态 consumer 清单、红测 fixture、上游依赖与许可证；恢复不扩权 |
| 2 | E1 / U1 问答领域存储 | core/sqlite、contracts | CAS/唯一约束/rollback/reopen/两连接、canonical publication 与 outbox 红→绿 |
| 3 | E1/E5 / U2 安全让出与 U3 投递 | daemon/runs、runner-pi、runtime supervisor、N03 | 等待不死锁、lease/fence、唯一 successor、新冻结输入、late callback 拒绝 |
| 4 | E1/E5 / T2/T3/T4 平台与工具接管 | daemon/sandbox、native、runner extensions | macOS/Windows 构建，命令和文件无宿主旁路；权限/取消/网络实证 |
| 5 | E2/E3/E4 / U4 + T5 共享 UI | API client、projection、共享会话、settings | 三种 surface/child 同组件，唯一决策入口、真实 readiness，刷新/复制/隐私一致 |
| 6 | E5/E6 / U5 + T6 联合验收 | 全层回归、Desktop/CLI、平台测试入口 | 原 G/packaged/K + 新 U/S 矩阵逐项关联同版本证据 |

### 8.1 U0 问答内容协议切片（2026-09-07）

- [x] contracts 新增 user-input.ts 与 user-input-validation.ts；只追加公共导出，保留已有 WIP。
  实现有界单选/自由输入、闭集字段、版本与显式提交、必答/选项/过期校验，返回脱离原输入的值。
  模型不能提供 Host owner、grant、approval 或依赖字段；验证器不授予权限、不启动执行。
- [x] 初始 20 项失败→通过；另以非枚举未知字段红测复现并修复白名单绕过。
  最终 24/24 专项、74/74 contracts 全量、build:ci/typecheck:ci 通过，无 skip。
  两个新编译模块 line/function coverage 100%，validation branch 97.40%；不是端到端覆盖率。
- [ ] U1 在本节 U0 验证时尚未实施；后续原子存储切片进度见 §8.2。U2 安全让出、U3 定向恢复、
  U4 共享 UI、U5 与原 U/S/G/K/packaged 验收仍未完成。当前仍未新增 Run/Attempt 状态，
  防止只加枚举却让现有 terminal handlers 误判业务成功。
- [ ] U0-S 运行状态 consumer 审计尚未完成。已确认必须联动：
  runtime-supervisor-types 的 TerminalAttemptStatus、daemon/runtime/supervisor 的终态恢复、
  runs/orchestrator 的 finally/afterRunTerminal、runs/interventions 的 terminal-only 队列、
  core/run-types 的 commitChannelWorkflowStepFinalization 及 goal/fan-in/取消/删除路径。
  核心消费者已形成[运行生命周期细设计](conversation-user-input-runtime-lifecycle.md)，并完成独立只读反向审查；
  全量状态迁移和 API/UI 消费者验证仍待完整 U2。yielded 不能触发成功/自动续跑逻辑。

本轮证据交接：output/user-input-contract-u0-handoff-20260907.md。该切片未打包/启动 App，
不复用旧 QA 包宣称新问答已可用，也不把纯内容验证等同于跨 Agent 权限或恢复已经验证。

### 8.2 U1 原子存储切片的实施边界（2026-09-07）

先实现问题创建、scope 内读取、回答 receipt、待投递记录和取消。新增 question/answer
两个 canonical kind，其 payload 仅保存领域 ID/版本，正文由对应领域快照投影，不再双写
assistant/user message；UI 接线前不注册 Runner 提问工具或外部创建路由。
此切片只处理已验证的单个提问者；显式共享 dependency、supersede/skip/expiry 调度、
delivery claim/ack 与 Runner 续接仍须后续完整接入，不用一个 pending row 证明可靠消费。

创建身份由真实 Run、源 Item/Turn、WorkUnit/当前 Attempt fence 和 workflow participant
反查确定，不接受模型填 ownership。首次创建只接受活跃 source，重复创建回读原记录，
同一 attempt/toolCall 或同一 attempt/idempotencyKey 的不同内容拒绝。读取与回答带 thread scope。
request/answer/待投递记录、canonical item 和 control-plane invalidation 必须在一个
BEGIN IMMEDIATE 事务中提交；任一 INSERT 或 COMMIT 失败均 rollback，包括分配的 sequence。
回答 Hash 取规范化提交内容，包含显式版本、幂等 key 与答案；不同 payload 不覆盖首个 receipt。
使用现有秘密检测拒绝需要改写的敏感正文，不悄悄把用户原答案脱敏成另一条已接受答案。

此阶段自动迁移只增加领域表，不改已有 history row。实现与迁移测试只打开临时 workspace；
不运行真实 QA daemon，不触碰已安装客户端数据库。运行状态仍不加 yielded，避免半接入终态。

#### U1-A 当前源码结果与剩余边界

- [x] 新增独立 user-input-store-types、user-input-source、user-input-records、user-input-store、
  user-input-migration；sqlite-run-store 和 RunStore 只接线，不把领域事务塞入 orchestrator。
- [x] migration 131 增加 user_input_requests/user_input_answers/user_input_deliveries 三表。
  request 归属 thread/canonical item，answer 归属 request/canonical item，delivery 归属 answer；
  这些归属使用级联外键，避免删除所属历史后留下待投递记录。source Run/Attempt/consumer WorkUnit
  是历史 lineage ID，不因清理执行记录而静默抹去已接受回执；未来消费必须重验目标存活并标 obsolete。
- [x] 已实现 scoped create/get/submit/cancel/listPending、完整 source fence、同事务 canonical
  publication/control-plane invalidation、CAS、等价幂等回读。答案按 questionId 规范排序；
  任一写入或 deferred COMMIT 失败回滚全部状态与 sequence。receipt 不标 delivered。
- [x] 来源快照增加一致性 checksum；红测证明改 participantId 原本会静默通过，现 fail closed。
  checksum 不替代认证或授权。问题/答案包含现有秘密检测命中内容时拒绝，不改写后冒充接受。
- [x] 新 canonical kind 仅含 ID/version。协议 message 投影拒绝这两种 kind；旧操作展示和
  terminal evidence 投影不接管它们。上下文/摘要暂只表明引用存在，不猜测用户答案或授予权限。
- [x] 20/20 SQLite 专项 + 1/1 workflow source guard 单测；Contracts 75/75；Core 529/529；UI-core 137/137；Web 216/216；
  Daemon 相关上下文/摘要回归 40/40。五包 typecheck:ci 通过，相关构建通过，无 skip。
  新存储模块 coverage：line 98.31%、branch 86.41%、function 100%；不是端到端覆盖。
  source guard 拒绝 workspace/participant/Run 不匹配及非 running 的 workflow step，防止取消后的迟到提问。
- [ ] 完整 U1 还缺 dependency、supersede/skip/expiry 调度与 receiver ACK；claim/租约/重试/部分 obsolete
  已在 §8.11 实施。尚无真实 workflow child 问答/恢复证据，U2/U3/U4/U5 均不因此通过。
- [ ] 注册提问工具或外部创建路由前，必须同时接好 scope 内问题/答案 hydration、上下文与摘要
  消费、共享问答 renderer。不能让仅有引用的占位进入真实问答、被普通摘要推进覆盖水位后丢失答案。

证据与命令见 U1-A 交接 (`user-input-store-u1-handoff-20260907.md`)。
未重新打包、安装或启动 App；旧 QA 包不含本切片。新 U/S 联动仍全部 not_run。

### 8.3 U0-S 消费者审计与 U2-P Runner 前置修复（2026-09-07）

[运行生命周期细设计](conversation-user-input-runtime-lifecycle.md)补齐核心消费者清单、
取消/restart/fan-in/goal 接缝和下一完整实施单元；独立只读审查确认不能将 answer 直接放入普通
queue_followup。状态闭集迁移、Core 暂停事务、typed yield 和全部逻辑消费者测试尚未实施。

实际 Pi SDK + 内存 SSE 测试复现并修复三个问题：启动前取消后仍发请求，两个 Host 边界抛错被
SDK 吞掉后仍继续成功。新增 task-boundary 模块与 Adapter 最小接线，保留首个边界错误，
请求入口及 payload hook 后重新校验停止信号。未新增 Run/Attempt 状态、问答工具或公开创建路由。

验证为 13/13 生命周期专项、Runner 全量 51/51；Runner build/typecheck、Daemon typecheck 通过。
新模块 line/function coverage 100%、branch 85%。单工具与双并行工具取消均等待清理；
不将 fire-and-forget abort 误报成已复现的提前收尾问题，也不将内存 transport 说成真实模型/完整 HTTP 验收。
详见 U2-P 证据交接 (`user-input-runner-boundary-u2p-handoff-20260907.md`)。
完整 U2/U3/U4/U5、沙盒和原 packaged 矩阵仍未完成。

N03 prepared request、旧 Daemon 7 项失败与 G-08 batch root windowing 仍在总计划，
不被问答/沙盒取代。问答恢复依赖 N03；真实命令正向验收依赖可用 executor；
batch 原子 children 应先接根窗口后再测问答/child 的密集场景。

可独立推进的模块：UI batch、平台 native 后端、问答纯存储。但 core/contracts、runner
接线、context/continuation 共同入口必须串行，不能三条线各自写一套 scope/attempt 解释。
此处只描述拆分机会，不自动创建任务、派 Agent 或合并任何分支。

### 8.4 U2-C Core 原子等待与消费者边界（2026-09-07）

已实现 migration 132 的问题 checkpoint、原子物理让出/逻辑等待、fenced 资源释放、
写入时的旧执行事件拒绝、专用迟到审计，以及验证 checkpoint 的 Turn/状态展示投影。
同一 Turn 中 B 完成不能遮掉 A 的等待；workflows 的独立 sibling 状态和 lease 不受影响。
旧 runner cancellation 的第一次逻辑状态变更已使用原 fence。

Core 554/554（含暂停 25 项）、Contracts 75/75、UI-core 137/137、Web 219/219；
Daemon 取消隔离/审计 5/5、审批恢复/监督器 9/9，本轮相关构建/类型检查通过。
详见[运行生命周期 §7](conversation-user-input-runtime-lifecycle.md#7-u2-c原子等待切片及迟到写入边界2026-09-07)
和证据交接 (`user-input-atomic-wait-u2c-handoff-20260907.md`)。

仍未开放问题工具或创建路由。Core 不能代替 Host 证明工具/进程停止；
typed Runner yield、逻辑等待取消、restart、唯一 successor、冻结答案输入和 U4 真实 renderer 仍需完成。
captured hydration、执行事件准入和 summary/terminal callback 的增量修复见下一节；
它们没有开放提问工具，也没有完成 Host/Runner 安全暂停。
本节不改变下方 U/S 联动矩阵的 not_run，不替代原 G/K/packaged 验收。

### 8.5 U2 captured fence / 两执行入口隔离（2026-09-07）

已按用户确认的完整链路接入：Host 捕获 hydration 身份；Core 强制 fence 的事件 INSERT
和状态 UPDATE；普通与审批恢复入口；完成权获准后才写派生总结；原身份的终态回调与
新执行写入准入分开；旧 finally 不删除新 attempt 的 ActiveRun。
完整边界与验证见[运行生命周期 §8](conversation-user-input-runtime-lifecycle.md)和
交接证据 (`user-input-execution-admission-u2-handoff-20260907.md`)。

正常取消、超时失败、interrupt redirect 仍须能收尾/续接；旧 success/failure/cancel、旧
hydration schema 和迟到 rejection 不得进入新执行。只在原子事实获准后派生 artifact/summary，
不从文本声称、batch 数量或 summary 文件位置推断完成。模型与外部工具的真实暂停仍由 U2
后续 Host/Runner 协议承担，不因这批测试通过提前启用提问工具。

### 8.6 U2 逻辑等待取消切片（2026-09-07）

用户取消已安全让出的工作时，Core 原子关闭对应 WorkUnit/Task/step 及 wait，保留 yielded
Run/Attempt。HTTP/RPC 通过 typed inputWait 返回逻辑取消结果，不通过旧执行写入或 abort
触碰 successor。已接受答案仍保留，未消费 outbox 变 obsolete；claimed/applied/错误 consumer 拒绝。
同轮和不同轮 sibling 隔离、事务回滚、重复请求与 SQLite reopen 均已有回归证据。
详见[运行生命周期 §4](conversation-user-input-runtime-lifecycle.md#4-续接取消与恢复)和
取消切片交接 (`user-input-wait-cancellation-u2-handoff-20260907.md`)。

Core 594/594、Electron 内嵌 Node 专项 54/54、Contracts 75/75、API client 51/51、Web 类型检查通过；
Daemon 1480 pass / 7 fail，与前轮为同一失败集合。未重新打包 App，也未运行真实模型或 GUI。
U2 pause coordinator、完整 executor 停止证明、parent/fan-in/goal/recovery、U1/U3 投递/唯一 successor、
U4 UI 与原 G/K/U/S/packaged 矩阵仍需完成，不把本切片登记为 U-09 联动通过。

### 8.7 U2 Thread 等待保全（2026-09-07）

修复 sibling 的终态/重启失败覆盖整条 Thread 等待的问题，沿用 Core 共享等待投影，不改三 surface renderer。
同/不同 Turn、其他活动执行、等待审批、损坏 checkpoint、嵌套事务/提交失败、双连接竞争与显式取消归档已有回归。
Core 611/611、Electron 内嵌 Node 75/75、Web 219/219，Daemon 1484 pass / 原 7 fail；
详细证据和中间发现的归档回归见Thread 恢复交接 (`user-input-thread-recovery-u2-handoff-20260907.md`)。
没有运行真实模型或 packaged GUI，没有把此局部 stop/start 记为整个 U-04/SSE/recovery 矩阵通过。

### 8.8 T0 独立 native 协议与构建入口（2026-09-07）

已建立 `native/sandbox/` 的严格非执行握手及固定工具链构建脚本，未复制 OpenAI 实现。
macOS ARM64 Rust 5/5、构建脚本 19/19、release 真实进程握手 19/19；macOS ARM64/Intel
均完成 release 链接，Windows x64 只做 cargo check。14 项依赖和 28 份许可证文本进入制品清单。
helper 不执行任何模型任务，明确报告 executionSupported/enforcementReady=false。
本次未接管工具、未修改 readiness/权限、未进行平台初始化，也未更新 App。
详见[平台计划 §9.1](platform-native-sandbox-v1-implementation-plan.md#91-t0-协议与本机构建切片2026-09-07)
与切片交接 (`native-sandbox-t0-handoff-20260907.md`)。完整 T0/T1–T6 与 U2/U3/U4/U5 仍未完成。

### 8.9 T1-A 不可变沙盒策略编译（2026-09-07）

Core 新增独立纯策略/路径/校验/类型模块，绑定当前执行和准确调用，拒绝旧 grant、越界目录、
Plan Mode 写入和只读命令；单次目录/网络授权互不替代。保留旧审批限制，不开启 verified 开关。
初始 36 项红→绿；补 4 项真实词法缺陷红测后，专项 41/41、Core 652/652、Electron Node 41/41。
Daemon 全量 1484 pass / 原 7 fail，没有新增失败；不是 sandbox/GUI 联动通过。
详见[平台计划 §9.2](platform-native-sandbox-v1-implementation-plan.md#92-t1-a-不可变策略编译2026-09-07)
与本次交接 (`native-sandbox-t1-policy-handoff-20260907.md`)。
Host 现行授权/路径投影、一次性批准消费、T2/T3 真执行、T4 全工具接管和完整 U/S/G/K/packaged 矩阵仍未完成。

### 8.10 T2-A 真实 macOS 验证与执行边界失败（2026-09-07）

新增系统 Seatbelt 命令原型，正向/选定负向 smoke 17/17、CI 单测 36/36；
Daemon 1520 pass / 原 7 fail，无新增普通回归。没有接入真实审批、恢复执行入口或 App。
独立必验探针已复现：预存工作区硬链接可修改外部哨兵；detached 后代在进程组取消后继续运行。
因此本切片既不是完整 filesystem boundary，也不是 U2 所需的完整 OS 停止证明。
SDK idle、leader exit 或 process-group signal 不能据此解除必答等待并启动 successor。

详见[平台计划 §9.3](platform-native-sandbox-v1-implementation-plan.md#93-t2-a-macos-实机后端与未通过的边界2026-09-07)
和实机证据交接 (`native-sandbox-t2-macos-handoff-20260907.md`)。
T2-B 的隔离执行区/受控回写及后代生命周期方案需要先确认并验证；不在本切片擅自弱化验收、
开放 capability、安装额外虚拟化组件或请求系统权限。原 U2/U3、T1-B/T3–T6 与全部矩阵仍未完成。

### 8.11 U1-B 投递租约与恢复发现（2026-09-07）

- 已在现有 user_input_deliveries 增加版本、租约、retry、稳定 successorRunId，未新增表。
  支持 scoped get/listDue/claim/retry、过期重领、取消前 successor 核验和 obsolete；不创建 Run、不写 applied。
- 领取在事务内验证 durable wait、原 source/fence、Task/step/parent workflow 与 canonical answer actor/lineage。
  必答尚未安全让出或 optional 尚无续接点时不领取；归档、取消、终态、已替代 consumer 不被复活。
  旧 token、时钟回退、过期租约、错误 scope、损坏记录和已存在 successor 均明确处理。
- 状态和 control-plane invalidation 原子提交；取消有效但未启动的 claim 时清租约并保留 answer receipt。
  claimed/applied 已有 successor 不能借旧 source 取消；缺少租约/意图的损坏 claimed row 不走兼容释放。
- 初始 25 项全红；新增反向测试复现 8 项边界缺口；parent 取消场景另有红测。
  最终专项 51/51、相关存储/等待 140/140、Core 全量 703/703、Electron 内嵌 Node 51/51。
  Daemon 1527 项中 1520 pass / 原 7 fail / 0 skip，失败集合相对 T2-A added=[]、removed=[]。
  新模块覆盖率 line 100%、branch 91.27%、function 96.43%，不代表模型/GUI/OS 验收。
- 本切片只拥有领取与未接收状态；完整 U3 还需与 successor Run/Attempt、冻结答案输入、
  现行执行权限重验及 applied acknowledgment 同步提交。现有 successor 的恢复不能再生成新 Run。
  Host coordinator、真实安全让出、API/UI/hydration、N03 及全部原验收仍未完成。

详细契约见[运行生命周期 §4](conversation-user-input-runtime-lifecycle.md#4-续接取消与恢复)，
证据见U1-B 交接 (`user-input-delivery-u1b-handoff-20260907.md`)。
这不是 packaged GUI 测试；没有真实模型请求、重启 App、修改真实 SQLite 或提交/推送。


### 8.12 U4-A 问答白名单读取与共享 Host 投影（2026-09-07）

- 新增 UserInputTranscriptItemV1 的 request/answer/unavailable DTO；只保留显示所需内容、
  source lineage 和 request/delivery revisions。claim/authority/idempotency 等内部字段不进入公共返回。
- Core 每批最多 500 个 Host 选定 canonical anchors，在同一只读 SQLite snapshot 内校验
  workspace/thread/visibility、source Turn、question/answer actor/domain refs/fingerprint 与 acceptance。
  损坏/缺失内容为 unavailable，基础设施错误不吞掉；不写库、不增加迁移/表、不启动执行。
- 普通详情、私聊详情、频道历史页复用共享 Host projection 返回 userInputs。
  频道只 hydrate 当前页；非 audit 视图过滤已编辑替代 source 的旧问答，
  普通历史不受最近 200 Turn 截断。答案不是新的普通用户消息或 Agent 回复。
- saved 与 delivery 分离；取消续接保留 answered + obsolete。U3 尚无 receiver ACK 时，
  不能由裸 applied 状态证明接收成功。完整 U4 renderer、窗口、mutation/controller 与
  snapshot revision/invalidation/隐私撤回仍未实现，不能宣称三种 UI 已完成。
- 验证：Core 733/733，问答相关 170/170，Contracts 75/75，API client 52/52，
  新 surface/client 专项 15/15，Web typecheck 通过，Electron 内嵌 Node 30/30（非 GUI）。
  Daemon 1541 项中 1534 pass / 原 7 fail；相对 U1-B added=[]、removed=[]。
  首次沙箱全量存在 loopback listen EPERM，日志独立保留，不算代码通过证据。
- 完整接线、U1/U2/U3/U4/U5、T2-B 和全部原矩阵仍未完成，不提前开放提问工具或提交入口。
  证据与剩余边界见 U4-A 交接 (`user-input-u4a-handoff-20260907.md`)。

### 8.13 U4-B1 客户端问答数据合并与读取隔离（2026-09-08）

这是 U4-B 的数据链路，不是完整 renderer/窗口/提交与新包验收。

- UI-core 只依赖公共 DTO 的结构镜像，提供纯 `reconcileCanonicalUserInputs`；不新增
  contracts 运行时依赖，不增加表。普通详情、私聊详情、频道根/分支/话题接入同一合并规则。
- 以真实 canonical item ID、workspace/thread/turn、request/version、answer ID 和 actor
  校验 hydration；私聊额外限定 teammate participant。没有 anchor 的正文不进入缓存；
  不按名称、时间戳、单个 Run 或模型文字猜对应关系。
- 同 identity 的 request.statusRevision、answer.delivery.revision 独立取新；immutable
  questions/accepted answer/source 不可随 revision 改写。同版本冲突或损坏 DTO 为无正文
  unavailable，不任挑一份。saved、claimed、applied、obsolete 不互相替代。
- full detail 已读取全部有效 canonical items，其显式空 hydration 可撤回已知记录；字段
  缺失是部分响应，不能推断撤回。频道以 Host 原始分页 cursor 的 `[from, before)` 判断
  覆盖，不能从过滤后的可见 items 猜范围，也不能把另一页的缺席当作删除。
- 已撤回 anchor 只保留无正文/无 source 的本地 unavailable replay tombstone，不渲染
  占位、不写回 Host。更高 status revision、后到响应、其他 action 的最大 revision 都
  不能恢复它。当前恢复方式是重新选择该 surface，建立新读取周期并重新验证 Host 返回；
  不在普通 merge 中自动解除。未加载页面的内容没有被重新读取，不声称全历史实时撤权。
- `conversation-read-epoch` 仅作客户端并发隔离，不是权限版本：full refresh 作废旧
  full/page 响应；切 scope/reset 的 token 不复用，覆盖 A→B→A。失败不会让旧响应重新有效。
  私聊沿用串行读取/owner/cancel 边界；topic 旧发送回调不能重载到新 owner。
- channel cache 保留页外问答以便之后比较状态，visible canonical IDs 决定当前显示范围；
  缓存数组不能直接作为 message、复制文本或 operation evidence。每条问答 revision/status
  进入 detail sourceRevision，不再仅依赖其他 action 的最大值。
- Codex 参考固定 SHA `6750f5bd1356fe1553c0fcc9f2632704f3055946`：
  `app-server/src/thread_state.rs` 中 ResolveServerRequest 在 thread listener 中排序；
  `tui/src/app/app_server_requests.rs` 按 request ID 清理待答。借鉴身份/顺序边界，
  不把 serverRequest/resolved 等同于 Ling receiver ACK，也不声称 Codex 有 Ling 的私聊 ACL。
- 白名单只保留展示/source 字段，Markdown、换行与原 option label 不重写；问答不增加
  messages、ExecutionAction、TerminalReport/fan-in evidence。不注册提问 tool/mutation。
- 新请求/答案 typed timeline rows、depth-1 child hydration、共享问答窗口、复制/键盘/主题、
  question mutation/receiver ACK/Host pause 和真实 macOS 全矩阵仍未完成。topic/root 的新
  hydration controller 字段已可供后续 renderer 消费，不能以此声称用户已看到问答 UI。

此数据切片没有新增待决产品选项；N03/T2-B/Relay/SK/AR 等既有待决不代答。
实现、最新回归与未验收边界见 U4-B1 交接 (`user-input-u4b1-handoff-20260908.md`)。

### 8.14 U4-B2-A Typed 问答历史与共享 renderer（2026-09-08）

这是已实现的只读 history 切片，不是完整 U4-B2 / 提交窗口 / 实际投递或 packaged 验收。

- 新增独立 userInputRequest/userInputAnswer typed rows、input.request/input.answer renderer key，
  由 canonical sequence/anchor 与 B1 public hydration 投影，不伪装普通消息或 ExecutionAction。
- request 与 delivery revision 分开；answered/applied 不表示 Run/任务完成。问答是 batch barrier，
  不提供 TerminalReport/fan-in 完成事实。无 anchor 的 replay tombstone 永不渲染。
- detail adapter 接三种 topology 的问答；child 按已校验 run/attempt/participant 来源接入，
  不要求先发生工具动作。只有真正进入可见 child 的同 anchor 行才从 root 隐去。
- normal/private 接同一历史 renderer、Markdown、MessageRow、hover/focus copy。
  私聊使用真实队友头像，用户头像仍在右；正文主色、选项/状态次色，投递失败单列。
  内容不可用时不提供正文复制；答案不重复问题全文，也不把内部 lineage 拼进复制内容。
- 新增 15 个文案键；zh-CN 翻译，其他新增键明确英文回退，保留全部已有翻译与 catalog 校验。
- 生产 channel root/topic/branch 的 feed-local position 与 canonical position 接线仍未完成；
  detail topology 单测不是频道 UI 通过。不能直接将问答追加到末尾或混用两种序号。
- 窗口/mutation/refresh、实际 successor/receiver ACK、Host pause/依赖消费者、macOS
  新包和所有原矩阵仍在本次总计划内，不降级为后续可选增强。

验证：UI-core 153/153、Web 257/257；normal/private × light/dark 浏览器 4/4，
1440/900 宽度各留一图，共 8 图已检查。浏览器使用明确合成 DTO，不是真实模型或 SQLite
问答案例；没有更新 QA App。详见 U4-B2-A 交接 (`user-input-u4b2a-handoff-20260908.md`)。
本切片没有新增未决产品选项；既有 N03/T2-B/Relay/SK/AR 决策不代答。

### 8.15 U4-B2-B 问答排序补充（2026-09-08，实施中）

用户已确认补齐 Host 顺序链路。三套坐标不得混用：Thread 的 canonical sequence、
Run 的事件序号、频道的 display position。工具引用的 source item 只是归属锚点，
不是工具发生时间；不能把整个子 Agent 放在 source item 后，就声称问答已正确穿插。

- 问题创建、答案接收分别在其原有同步写事务中捕获 `runEventPosition`：
  `{ runId, attemptId, afterEventSequence, afterEventId? }`，保存于各自 canonical payload。
  序号 0 表示该 Run 尚无事件，必须无 event ID；非零必须匹配同 Run 的真实事件 ID。
  这是 Host 的固定事件边界，不是新的工具结果，也不添加 RunEvent 或 SQLite 表。
- 公开 hydration 返回经源 Run/Attempt 和事件记录核验的边界。不从 updatedAt、
  action revision、当前最大事件序号或模型文字补造历史位置。重复提交读取原边界。
- 缺少边界的既有 anchor 可保留 canonical-only 历史；禁止猜测其在工具/叙述内部的位置。
  这不是旧执行路径兼容。内容可读性与精确交错能力分开，不改真实历史凑新证据。
- 共享 projection 只在 exact Run/Attempt/participant 下使用该边界；同一边界上的
  问答由所属 Thread 的 canonical sequence 排序，不能跨 Run 比较事件序号。
  边界与 canonical/source 冲突时不可用；后续输出更新不得移动问答。
- 话题面板将父消息视为固定引用，话题消息和问答沿自身 canonical spine 排列。
  根/分支使用独立纯 adapter 转成 display position；workflow child 还须有 Host 验证的
  step、Run 与父 delegation anchor，不能只按队友名称挂载或复用根频道 hydration。
- 回归包含零事件、跨 Run 同序号、后续输出、答案重放、重启读取、损坏边界、
  话题切换/缺 anchor，以及 narration → question → answer → tool 的真实顺序。
  此节是实施约束，不代表频道生产接线、真实投递或 macOS packaged 已通过。
- 窄 macOS 窗口（≤900px）打开话题时显示单栏话题，不能隐藏已打开的面板。
  父频道仅暂时隐藏但不卸载，关闭话题后恢复原滚动和草稿；不新增模态窗口。
- workflow step 的只读 `runUserInputHistory` 在与叙述相同的 SQLite read snapshot 中读取。
  Host 重新核对当前 step/Run/parent source，再读取子 Run 自己的 Thread/Turn；
  UI 同时校验 workflow.metadata.sourceMessageId、parentThreadId 和完整 child scope。
  不读取根频道 hydration 代替子历史，不从同名 participant 推断归属。
- 子 Agent 的 display availability 与执行 evidence 分离。仅问答也可展开共享时间线，
  问答不能产生 actionId、完成计数、TerminalReport 或 fan-in evidence。
  无法精确交错时只显示无正文的 `user_input_order_unavailable` 诊断，不将答案追加到猜测位置。
- 问答独立于 narration revision 刷新。当前模型是物理 Run `yielded`、逻辑 Step
  `waiting_for_input`；这类步骤继续只读轮询，UI 保持 active/waiting，不显示已完成。
  初始空历史可以接收首次问题；撤回已有历史则保留无正文 tombstone，晚到快照不能恢复正文。
  每条 request/answer 沿用共享的 revision/immutable-binding 合并，不新增整段 history revision。
  同 Run 的轮询、完整步骤刷新与步骤 mutation 回包均使用共享 read-model 合并；
  完整列表仍控制成员增删，步骤生命周期仍由 Host 回包控制，不用问答 revision 推断运行状态。
- 频道问答复用用户/队友头像回调：提问使用已验证 participant 的队友头像，
  回答使用用户头像且靠右；共享子时间线不根据显示名称重新选择 Agent。
- 截至本切片：Host 固定边界、topic canonical history、workflow child 顺序与独立刷新已接线；
  root/branch adapter 随 §8.16 接线；普通/私聊 Run 内最终交错、问答 mutation/receiver ACK、packaged 验收仍未完成。

### 8.16 U4-B2-C 根频道/分支的问答位置适配（2026-09-08）

- `channelUserInputs` 贯通 AppShell → WorkspaceClientView → ChannelMessageRenderers。
  独立 `channel-user-input-timeline` 在共享 snapshot/batching 之前投影，不新增 renderer 或事实表。
- 严格按 workspace/channel/thread、committed、公开频道可见性筛 canonical anchors；
  不读取 topic、其他分支、私聊或 owner-private 内容，不从同名 Agent 推断归属。
- 连续且无 Run 事件位置的 canonical 消息按所属 Thread 的 sequence 排列；时间戳/ID
  顺序不能覆盖它。未知消息、工具、protocol 和 child 都是边界，不跨这些行重排消息。
  canonical-only 问答通过真实消息邻居定位，不混用 canonical sequence 与 feed display rank。
- 同 Run 有原子操作/事件时使用共享事件边界交错；同 Run 任一行缺 attempt/participant 时
  不能跳过该行猜位置。边界、来源或顺序无法验证时显示无正文诊断，不追加问答正文。
  已在子 Agent 中显示的相同问答不会重复出现在根层；未挂载的 workflow child 问答只显示诊断。
- 排序诊断是可重算的显示结果，重复投影不重复添加；新锚点到齐后可移除旧诊断。
  dense display rank 仅作用于本次投影，不修改 item/sourceRefs/contextSegmentId 的事实。
- snapshot revision 从包含问答的最终 items 计算。空状态也依据最终共享时间线，
  不能因旧消息列表为空而隐藏唯一的问题；同一入口只计算/挂载一次时间线。
- 验证区分纯投影测试、真实 Chromium + synthetic Host DTO、真实模型/SQLite/packaged GUI。
  前两者不代表 receiver ACK、SSE 问答恢复或 macOS 安装包已经验收。
- 普通/私聊叙述当前公开 DTO 仍缺已验证的 attempt lineage；不得借问题 source 给叙述补猜测归属。
  下一切片需从 Host 真实 Run/Attempt 归属贯通历史和实时读取，再接两种会话的 Run 内交错。

### 8.17 U4-B2-D delegated Run 的 canonical child input（2026-10-19，实施中）

- 根频道用户 Item 是 workflow delegation 的授权来源，不是 workflow-step Thread 内 Run 的直接输入。
  禁止把根 Item 跨 Thread 写成 child Turn 的 `sourceItemId`，也不放宽 user-input source guard。
- 每个 delegated Run 在自己的 workflow-step Thread 内拥有真实、committed、`actorType=system` 的
  canonical input Item；该 Item 与 child Turn、Run、Attempt、participant、task 和 workflow step 同 scope。
- child canonical Item 通过 `domainRefs` 回链根 Item/Turn/Thread、workflow、step 和 task。跨 Thread
  lineage 只存在于这些引用中；`sourceTurnId` 仅允许连接同一 child Thread 内的 retry/resume 前序 Turn。
- `user_input_request` 和 `user_input_answer` 的直接 source 必须是 child canonical Item。根 Item 继续作为
  workflow/TerminalReport authority，不能因 UI 将 child span 嵌入根频道而改变底层所有权。
- Host 在创建 child input 前后都核验 channel、workflow、step、task、participant 和根 source lineage；
  任一冲突都 fail closed。幂等重放必须返回相同 child Item/Turn，不能生成重复问题或放宽可见范围。
- Q1 验收同时证明：必要问题只暂停所属 participant；answer successor 沿 child lineage 恢复；其他 required
  participant 未终态时 fan-in、Completion Gate、TerminalReport 和根 Turn 均不得提前成功。

## 9. 增量测试矩阵与失败处理

以下均为完整联动用例，当前仍为 not_run。U0 的纯协议测试只覆盖部分输入边界，不将其记为联动通过。原矩阵一项不减。

| ID | 必验路径 | 失败处理/可见结果 |
| --- | --- | --- |
| U-01 | normal/private/channel/child 创建、定位、回答，私聊隔离 | scope 不符拒绝；不泄漏其他问题 |
| U-02 | 预选、自由输入、关窗、提交失败、双击、双窗口、过期/新版 | 无默认提交；保留草稿；唯一答案，stale 409 |
| U-03 | A 等必答、B 独立继续；共同决定显式依赖；等待环 | 不整队停工；环拒绝；fan-in 不提前成功 |
| U-04 | request 发布失败；answer 保存后崩溃；claim 后、ack 前崩溃 | 原子 rollback 或持久补投；无重复 successor/副作用 |
| U-05 | cancelled/superseded/expired/旧 attempt/迟到回答 | 不复活任务、不改新 attempt 终态；明确 obsolete |
| U-06 | required 安全让出、lease 释放、goal 等待；runner 不支持 | 不伪装成功/失败、不自动 retry；可理解阻塞 |
| U-07 | optional 安全点纳入、N03 冻结、并发、restart/fork | 不改旧 prompt；新 answer lineage；fork 不复制待答/授权 |
| U-08 | 普通回答不提权，授权操作 fingerprint 改变，grant 撤销 | 已答不等于获准；重新校验，既有审批唯一 owner |
| U-09 | 隐私、复制、SSE、长列表、batch 边界、keyboard/focus | 禁止泄漏与重复问答；单 root window |
| U-10 | packaged macOS 完整小项目中真实两个 Agent 提问与恢复 | 执行前/等待/回答/恢复/终态截图 + API/SQLite/文件证据 |
| S-01 | 两端工作区允许、越界/protected metadata/路径竞争拒绝 | OS 拒绝，外部 sentinel 不变 |
| S-02 | TCP/UDP/DNS/IPv4/IPv6/子进程网络、单次 grant | 未授权失败、下次恢复断网 |
| S-03 | 多 Agent grant 隔离、取消/超时/helper/daemon 崩溃 | 无跨任务权限合并、无遗留子进程 |
| S-04 | helper 身份/version、readiness 缓存、Windows UAC/repair/uninstall | fail closed、按 owned manifest 清理；无裸执行回退 |
| S-05 | 全部命令及 read/search/edit/write/patch/预览入口 | 逐入口有实际受限证据，不只测 Bash |
| S-06 | settings/会话覆盖、CLI、Desktop 构建与平台移交 | configured 与 effective 分开；macOS/Windows 各自验收 |

S 表是平台细计划 §10 每一行的分组索引，不能以六个概括用例删减其逐项断言。
已建立 packages/contracts/test/user-input.test.mjs、packages/core/test/user-input-store.test.mjs。
其他建议测试落点（尚未建立）：
daemon/test/user-input-continuation.test.mjs、runner-pi/test/user-input.test.mjs、
web/test/user-input-presentation.test.mjs、web/e2e/user-input.spec.ts。
平台测试沿原生沙盒计划；将中英文路径、非默认 workspace 与并发数据库连接纳入夹具。

覆盖关系：

    question schema/owner -> [UNIT + DB] U-01/U-02
    pause/checkpoint     -> [INTEGRATION + REAL RUNNER] U-03/U-06
    receipt/delivery     -> [DB CRASH + INTEGRATION] U-04/U-05/U-07
    approval/policy      -> [INTEGRATION + OS] U-08/S-01..S-05
    shared UI           -> [BROWSER SIMULATION] U-01/U-02/U-09
    complete project    -> [PACKAGED + REAL MODEL + OS] U-10/S-06/原 J-01

模型工具定义新增提问后，补正常直接执行不滥问、缺关键信息会问、普通回答不申请额外权限、
多 Agent 不串答四类行为评测。mock UI 通过不能替代真实 Runner/OS/模型案例。

## 10. 性能、分发与不在范围

- 待答队列按 scope/status 索引分页，按 requestId/revision 增量 invalidation，不每个 SSE
  全扫所有历史。outbox 按到期索引唤醒、有界重试，无 0ms 轮询。
- 500/1,000 pending request 的 logical count、mounted rows、定位和交互 p95 要实测；
  性能阈值沿共享 root-window 规范，不直接从旧 500-child 结果推定问答已通过。
- Windows helper 固定工具链/Cargo.lock/上游 SHA/许可，签名与制品随 Desktop/CLI 发布；
  T0 未证明可构建前不承诺可直接搬用上游模块。
- 不重写 Pi、不新建通用 session 系统、不新增 SQLite batch 表、不修改真实历史凑测试。
- 不纳入 Linux/PTY/域名白名单/Browser-CUA-MCP 整体 OS 隔离；系统自动审核已由 §12 纳入，
  但不意味着新增以上 OS 能力或绕过 T2 的退出条件。
- 不纳入自动语义合并问题、多选表单、秘密输入、跨 workspace 广播、任意 active Pi prompt 注入。
- 不覆盖同事审批 WIP，不 commit/push/PR/merge，不运行 UAC/系统账户修改或重试被拒绝的 Relay 启动。

## 11. Harness 上下文可靠性增量（2026-09-07）

用户最后在结构化问题中确认“四项并入，增强项后置”。本批增加会话摘要失败处理、
单次长 Run 压缩与恢复、Memory 召回/新鲜度、统一工具结果预算，见
[四项细设计与实施任务](harness-context-reliability-integration.md)。后台自动经验提炼和语义
检索按该次最新选择后置；此前六项全做的说法不作为当前范围。H1–H4 必须完整闭环，
不能只加开关；H1-A 执行协调层已通过本地验证，完整四项仍未完成。
不改 U/S/G/K/packaged 的状态，也不替代 U2/U3/N03，详见细设计 §7.1 的证据与边界。

## 12. Skills 与自动审核增量（2026-09-08）

用户要求将「评估 Ling 的 Skills 与 Codex 使用情况」中的完整设计一起处理。增加技能目录、
正文完整加载、受控引用读取和系统自动审核通过后自动批准的完整链路，见
[Skills/自动审核联合设计](skills-autoreview-harness-integration.md)。复用 U/H/N03/T 状态和证据，
不新增普通审核队友，不把问答回答当批准；未实现和未验收的项继续保留。
Memory 共享范围已由用户确认，已修授权 workspace/channel 的误拦截，私聊/跨范围/外发边界保留；
专项通过不等于真实模型或新包验收。模型/provider、自动批准范围和硬规则仍待确认，不改真实凭据。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | --- | --- | --- |
| Integration scope | plan-eng-review；用户要求一起处理 | 整合已有设计，核对当前代码与验收依赖 | 1 | DESIGN_INTEGRATED | 已分析架构、模块、失败路径与性能；未执行完整逐项交互评审 |
| Independent review | plan-eng-review 只读反向审查 | 核心等待恢复消费者与 U2-P Runner 修复 | 2 | SCOPED_REVIEWED | 无 U2-P 阻塞项；全生命周期尚未实现，非全量 CLEARED |

**VERDICT:** 设计已纳入同一计划；U0、U1-A、U2-P 与 U2-C Core 等待切片通过本地验证，
完整问答和新 U/S 联动未完成，不标 CLEARED 或整体完成。
核心状态消费者与暂停协议见运行生命周期细设计；U2 必须同步迁移全量状态消费者并补实际暂停测试，
在 T0 证明 Windows helper 的固定依赖可构建。现有大文件仅接线，新增领域逻辑放独立模块。

**UNRESOLVED DECISIONS:**
- T2-B 原型验证已于 2026-09-09 获用户批准；执行副本隔开了夹具硬链接写入，但 detached 后代停止仍未通过。最终后代所有权/原子回写方案未定，不把 process_group 或副本隔离当完整停止证明，详见平台计划 §9.4。
- 2026-09-08 用户已允许按现有设计连续完成内部链路，明确包含普通/私聊归属、N03/batch、MCP/SDK 结果适配；不再逐次确认文件数量。先前内部范围待答记录由此覆盖，实现/测试门槛保持不变。
- 真实模型测试的外部 Relay 目的地确认仍待用户回答，不能通过变更凭据注入方式绕过已拒绝操作。
