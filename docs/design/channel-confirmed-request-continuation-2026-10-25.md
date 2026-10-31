# 频道待澄清请求的明确承接

状态：原始明确承接实现的 145 项回归及独立差量审查通过；2026-10-27 的字段续接已实现、独审并保存，capture013 模型规划通过。f1357986 隔离包的特定字段续接、单次真实命令及正常 Quit 已通过；最新 main 组合包、产品 retry 和恢复矩阵仍未完成。不同增量的独审、规划和 GUI 结论不能互相替代。
本设计补充 c01-path-reference-cwd-boundary-2026-10-25.md 的 R5，不替代 Continuity v2。

### 2026-10-27 最新验证覆盖

真实 macOS 客户端已用内置 Computer Use 完成独立后继 module 案例：实际 @QA 请求、
目录问题、回答、精确工具审批各一次；Host 核对仅新增依赖 scope 和回答来源，完整
操作图及 required QA manifest 保留，只有一个 resolution/proposal/workflow/Run 和
一次工具执行。真实 exit0/stdout 为 `PENDING_SCOPE_MODULE_GUI_OK_20261027 sum=16`，
Run/workflow 均 succeeded；模块 JSON 的派生 hash 和本次回答 provenance 已核。
正常 super+q 后 launcher 实际 exit0，Main code0/signalnull，Host/后代、端口和 QA DB
句柄排空。这里只覆盖 f1357986/ASAR4325897f，不覆盖 f7f7bc75 最新组合包。

原 fs-read 夹具未声明 input.json，真实 exit1/ENOENT 和 blocked 历史保持失败，不重试
或改绿；项目范围仅捕获 literal import/require 模块闭包，任意 fs 数据读取须显式
声明，未通过扩大权限修正测试。报告及真实截图见
`output/e6-20260928/pending-scope-gui-failure-and-successor-20261027.md`。
旧段落中“尚未 GUI”描述各自当时状态，以上为特定后继验收的最新覆盖。

字段续接增量已在 `63ecdbb9`、`9afa5248`、`c965dda7` 实现并独审；
`99b9ee2d` 已绑定其隔离 QA 打包输入并推送。真实模型 capture013 已通过：
初始澄清冻结完整草稿，回答只补 `demo` 目录范围；去掉新增范围和回答来源后，
操作图与 required participant manifest 与冻结值完全一致。SQLite Store 关闭重开后
复用同一 proposal，不再次请求模型。实际两次 logical model task、一个 proposal，
零 Run/Task/tool event。这是规划协议证据，不是工具执行或 macOS GUI 验收。

必须使用精确 wire 名称：`clarification.missingFields=["projectInputRoot"]`，
`slots[].field="project_input_root"`。旧提示词未明确该既有契约，已补全，未新增
宽松 alias、权限或自动修复。capture009–012 及旧 GUI 失败保持原判定；012 helper
的 slot 匹配布尔受正则转义错误影响，不作为产品缺陷证据，也不重跑它寻找成功样本。

证据：`output/e6-20260928/pending-operation-real-model-wire-result-20261027.md`、
`pending-operation-wire-fields-{verification,independent-review}-20261027.md`。
下一门槛为最新组合包、产品 retry 与恢复，不重复已经通过的协议探针和后继 GUI 案例。
新包前另修复了 Desktop 停 owned Host 后向死端点释放租约的退出时序；该增量独立
验证，不能用规划协议结果替代客户端正常退出证明。

## 2026-10-27 补充：待决项续接与工具审批必须分层

本节最初是待实现契约。2026-10-27 已接入下面的 Host/Core/Daemon 增量及隔离回归；
运行中的 QA 客户端仍是旧包，尚不能称为真实 GUI 已通过。未提供完整可信草稿的
旧澄清仍只有原请求/问题/确认 anchor，不能把它描述为已经冻结操作图。

### 字段续接的已接入链路与剩余门槛

1. 初次 `clarify` 可携带模型候选 `pendingDraft {execution, slots}`。Host 使用原有 binder
   校验完整图和来源，再生成 `ChannelIntentPendingOperationV1`；仅支持独立缺失的
   `projectInputRoot`，不靠补造命令完成草稿。快照冻结原 item revision、context assignment
   ID/revision、权限指纹、完整 bound plan、required participant manifest 和明确槽位。
   没有完整草稿时仍可普通澄清，不能假装拥有待续接操作。
2. 回答采用独立 `resolve_pending/pendingAnswer` 协议，绑定 decision ID、draft fingerprint、
   answer item/revision。闭合字段 schema 不接受 owner、command 或其他未声明字段；
   有快照时，完整图输出不进入 graph repair，而是拒绝，不能借确认换计划。
3. Host 只填 Node 依赖目录并添加本次回答的真实 provenance。完整回答保留在 binding
   来源中，目录引用独立指向回答中的路径；原命令、cwd、文件、目标 identity、owner、
   顺序、依赖、required 和 manifest 保持不变，仍走完整 contracts 校验与现有文件系统边界。
4. 新增 additive migration **191** 的 `channel_pending_operation_resolutions`，只记录回答
   消费与最终 decision 的关联；不覆盖历史、不存模型原始候选，不使用已占用的 190。
   `BEGIN IMMEDIATE` 内重新核验 pending/source/question/answer/segment/version，重新读取
   当前权限，原子写入 proposal、decision 和唯一 resolution。Core 再核对变更只能落在
   指定槽位及回答来源，不能仅靠 Daemon 自律。发布异常整体回滚；回读已提交结果不再调模型。
5. 答案与持久化消费**提交后**，重启/重复派发恢复同一 proposal；不承诺模型响应前或
   事务提交前的崩溃能实现模型调用 exactly-once。数据库唯一消费与工具执行去重是不同边界，
   工具仍必须经过现有 Run/Attempt/审批/沙盒准入。此处不会直接启动 workflow 或工具。
6. 权限事务使用新增 `readAiTeammates` 纯查询；原 `listAiTeammates` 仍保留既有初始化。
   不能让一次权限读取隐式开启记忆 bootstrap 事务，也不把去掉事务当成修复。

隔离回归覆盖并发八连接、rollback、错误 thenable、旧回答、问题替换、跨 thread/channel/
segment、原 assignment 移出再移回、完整图/命令/参与者替换、目录越界、权限 await 间隙与
事务内变化，以及多参与者 required 图的保留。当前专项结果记录于
`output/e6-20260928/pending-operation-final-20261027.log`。这些是临时 SQLite 与静态
runner 的证据，不是外部模型或 packaged GUI 证据。

后续门槛：当前组合邻接回归、差量审阅、原 QA-only 冻结/批准/新包链，以及 after009 的
新假设模型/真实客户端验收。旧 009 blocked 和真实原项目的 plan_invalid 均保留原判定，
不重发原任务、不用本次 fixture 冒充旧案例执行成功。普通/私聊和现有工具审批机制不改。

### 2026-10-27 存储生命周期与独审收尾

最终字段协议邻接组合 220/220、Contracts 98/98 通过，计数互有重叠，不相加。
新增消费 ledger 的三个外键使用 `ON DELETE CASCADE`，服从既有用户显式删除频道的
生命周期，不新增自动历史清理。已消费和未消费两种删除路径都在临时 SQLite 验证。

独立 Core 审阅发现 migration 191 先于旧 114 nullable manifest 重建，会被 SQLite
改写外键指向随后删除的临时父表。新增真实 Store 升级回归先 RED 0/1，调整 191 至
旧父表修复之后，再 GREEN 1/1；没有弱化 schema/marker guard，也没有改真实数据库。
随后三文件当前生命周期组合 64/64，零 fail/cancel/skip、实际 exit0，包含旧 schema
升级、外键检查、再次打开、首次消费与重启 replay；其他 220/98 结果仅在未变范围复用。

Core/contracts 独审及该 finding 的窄差量闭合、Daemon 独审均已完成，选定范围无剩余
已确认问题。报告位于 `output/e6-20260928/pending-operation-{core,daemon}-independent-review-20261027.md`
及 Core 的 `-closure-20261027.md`；RED/GREEN 和最终组合日志另存，不覆盖原失败事实。
这仍不是外部模型、工具执行、macOS 新包或 GUI 通过证明。当前下一门槛是冻结本次
运行时新增输入、按原 QA-only 契约构建新包，并用新案例验证完整待决项续接。

官方 Codex App Server 协议已核对：命令审批绑定 `itemId/threadId/turnId`，批准后
继续具体的待执行命令；`item/tool/requestUserInput` 的回答/清理通过
`serverRequest/resolved {threadId, requestId}` 关联。协议不证明 Codex 使用 Ling 的
操作图、`sourceQuote` 或完整草稿存储方式，也不保证任意自然语言澄清无需模型解释。

- 命令审批的对象是参数已确定的具体工具调用；沿用现有批准续跑链，不重新生成任务图。
- 任务澄清的对象是未确定的信息。补充 Node 项目依赖范围属于此层；回答不是工具批准，
  也不改变频道权限、沙盒、required 参与者或原命令次数。
- 对已有可信结构的任务，Host 应保存非执行态的待决快照：原来源/版本、问题与请求 ID、
  已确定操作及稳定身份、允许补充的字段、依赖关系、上下文 segment 和失效条件。
  草稿不是 accepted plan；无完整草稿时不得伪称已经冻结全部操作。
- 用户回答只解析成对应待决项的字段补丁，模型不能借回答替换其他 owner、命令、输出、
  顺序或 required 关系。Host 合并补丁后仍完整校验图及来源；“不重新生成整图”不等于
  跳过全图校验。超出槽位的纠正应产生显式的新修订/澄清，不静默扩权。
- 新字段可以引用本次回答，但必须保留它自己的 canonical local-user 来源；不能把
  当前新增的依赖范围伪造成原请求中的引文，也不能让 assistant 问题成为授权来源。
- 回答只消费一次；重复提交、SSE 重连和 Daemon 重启读取同一 resolution，不能再次
  调模型或执行工具。取消、问题被替换、来源/权限版本变化必须退休或阻塞旧待决项。
- 优先复用既有结构化问答与 intent 持久化链，先检查其生命周期，不并排引入第二套
  普通聊天确认系统。存储方案应由事务性消费/恢复需要决定，而不是预设必须新增表。

实施顺序：先完成当前 schema/prompt 契约矛盾及字段级诊断；再固定 pending snapshot
与可补字段协议，接入回答的原子消费和恢复；最后用隔离模型规划与真实 macOS 客户端
验证同一个项目的确认、执行各一次、失败、产品 retry 和后续修改。必须覆盖拒绝/取消、
陈旧回答、重复回答、跨线程/跨 segment、权限变化和无完整草稿。当前真实失败案例保留
失败，不用 fixture 或新草稿冒充它已经执行。

参考（2026-10-27 实际读取）：

- https://learn.chatgpt.com/docs/app-server#command-execution-approvals
- https://learn.chatgpt.com/docs/app-server#toolrequestuserinput

## 根因与目标

真实 R5 用户已回复确认并限定四项只读，但 operation/owner/command/cwd 引文只能
来自当前消息。“确认”里没有重新写出旧命令，binder 因此拒绝。历史并未从 SQLite
消失；也不能通过让任意历史 Agent 文本取得执行授权来解决。

支持同一频道、Thread 和 segment 内当前用户明确承接尚待回答的澄清。模型仍解释
自然语言，但只能提出对一个 Host 确认的原始用户请求的承接，不能自行选择旧任务。
普通内容、拒绝、取消、询问和无关后续不应因有历史任务就转为执行。

## Host 选择与模型候选的职责

`channelOperationContinuationContext` 只提供承接机会，不判断“是/否”、不调工具：

1. 当前来源必须是仍有效、committed 的 canonical local_user 消息，且投影的
   thread/turn/watermark/segment/assignment 版本匹配实际记录。
2. 从 SQLite 的实际 segment tail 找立即前一条用户消息，不从可能裁剪过的模型
   文本里猜“上一条”。前一来源同属当前 channel/thread/segment，必须仍在可见投影中。
   不跨越插入的新用户请求，不接受 fork/topic 的继承来源冒充本线程待澄清请求。
3. 前一来源最新 decision 必须是 accepted/suppressed clarify，无 execution、proposal
   或 workflow，且恰有一个结果问题。问题必须仍是同 ID 的有效 committed assistant
   item，归属原 Turn，domainRef 指回原用户、正文等于 decision 中的问题，发生于
   原请求之后和当前消息之前。显式 replyTo 存在时只能指向该问题或原请求。
4. 原用户、问题、当前用户三项均需具有可见的精确 body/revision/actor 身份。
   Host 固定 sourceItemId/sourceRevision、clarificationDecisionId/itemId/revision、
   contextSegmentId 及三项来源和 assignment 的 SHA256 fingerprint。
   fingerprint 只覆盖必要的三源，不能因压缩无关尾部导致同一 anchor 与 binder 分歧。
   真实 context-length 重试先从正常投影独立验证 pending 链，再把这三个来源的 ID
   传给 minimal 投影的 retainItemIds。保留只绕过字符裁剪，不越过原材料选择、
   可见性、segment 或 sequence 筛选，不读取任意模型指定 ID，也不放宽最终 token 预算。

selector 可选择普通 reply/clarify，也可在真正明确承接时提交可选
`execution.continuation`：原样复制 Host anchor，并令 `confirmationQuote` 等于完整
当前用户正文，不能只截取“确认”而丢掉后面的限制。没有有效 anchor 时，原规则不变。

该字段不是模型自签授权。Host 独立重建待澄清链，逐项验证 anchor、当前全文、
原用户身份及可见来源；候选不能自报 verified、选择别的历史消息或省略版本。
自然语言的语义解释仍由 selector 负责，引文与 fingerprint 只证明来源和冻结输入，
不能证明模型必然正确理解许可。实际执行仍受现有工具准入、审批与沙盒约束。

## 绑定、归属与持久化

- 未指定 continuation：所有新 operation/owner/command/cwd 指令仍来自当前用户；
  旧材料只可供已有 target/content 等显式引用，不获得执行意图。
- 指定且通过 continuation：唯一的原 local_user item 成为指令来源，operation 及
  子字段的逐字/span/路径/命令/目录校验保持不变。不得从 assistant 问题取指令，
  不猜命令、cwd、输入锚点或 owner。模型仅可选择当前确认范围内原有操作。
- owner 路由参考原用户明确指定的参与者，但使用当前有效 channel/teammate 能力；
  required participant 不得静默丢失。当前明确排除原参与者时，候选需额外提供
  continuation.excludedParticipants: [{participantId, sourceQuote}]。Host 验证身份仍在
  已选候选内、引用逐字来自当前确认且包含该身份、排除项不重复，并拒绝被排除者
  继续拥有操作；selector 只按绑定后的排除 ID 收窄 manifest 和 proposal。
  未提供排除依据的原 required 参与者继续保留，不能仅因模型省略其操作而消失。
  否定表达的语义仍由 selector 解释，来源校验不冒充形式化的自然语言授权证明。
  新增/更换指令无法在原请求中绑定时，需当前
  直接指令或澄清，不能用历史引用扩权。
- 新 operation target identity、intent decision、proposal 仍归属当前 source Turn。
  每个 binding.sourceRefs 冻结原指令、owner、完整当前确认、原澄清问题及版本。
  operation fingerprint、现有 decision 的 contextProjectionVersion 和随后冻结的
  Run snapshot 贯通这些来源；不拼出虚假的“当前用户原文”。
- 不新增表，不改历史记录，不继承旧批准。proposal 恢复仍先读取当前 source 的
  已持久 decision；SQLite reopen 不重新调用 selector 或产生新任务/工具。

## 验证及交付边界

新 channel-operation-continuation.regression-1.test.mjs 覆盖：唯一 pending anchor；
插入用户请求；缺失可见来源/错 segment；两用户与问题 lineage；历史精确命令、
cwd/输入坐标；问题替换和新 decision 退休；伪造版本/decision/fingerprint/截断确认；
原 owner、当前 proposal source 及 SQLite reopen 无重规划。均为隔离临时 SQLite、
静态 runner，无外部模型、真实项目修改、工具执行或批准。

独审曾发现两项真实 P2：原 @QA 被补回 required manifest、真实 minimal 重试丢失原文。
新增用例先证明原 8 项通过/新增 2 项失败，再补齐两条链路。最终新文件 13 项包含在
7 文件 79/79 中；另 4 文件 66/66，共 11 文件 145 个不同用例，无 fail/cancel/skip，
两个测试进程 actual exit0。Daemon build:ci exit0。真实 Pi HTTP/SSE 使用 loopback
合成 Provider，不是外部模型或 GUI 验收。独立 Agent 的六源码与一测试差量审查
无未闭环发现；Root 复算七个最终 SHA 一致。
最初未带隔离参数的邻接运行触发默认存储 migration marker 冲突，已停止且不计通过；
随后漏传隔离环境的预载 setup 失败也保留。最终运行显式传入受控临时
LING_STACK_HOME/LING_STACK_DEFAULT_WORKSPACE_CWD 和拒绝系统 Keychain 的原预载。
没有修改真实迁移标记或放宽测试门槛。RED、fixture schema、编译和 setup 失败日志均保留。
最终证据为 output/e6-20260928/continuation-review-isolated-final-{regression,adjacent}-20261025.log，
独审记录 channel-confirmed-request-continuation-review-20261025.md。
运行中的 f5168a2f QA 包不含此改动；后继需原 QA-only 冻结/审核/构建链后，
在新 nonce 案例实际测试短确认、明确只读范围、执行各一次与恢复，不重跑原 R5/R11。
