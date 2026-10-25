# 频道待澄清请求的明确承接

状态：实现、145 项相关回归及独立差量审查通过；macOS 后继 QA 包验收未完成。
本设计补充 c01-path-reference-cwd-boundary-2026-10-25.md 的 R5，不替代 Continuity v2。

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
