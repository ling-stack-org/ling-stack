# Harness 上下文可靠性：四项联合实施设计

Date: 2026-09-07
Status: DESIGN_INTEGRATED / PARTIAL_IMPLEMENTATION。H1-A 已验证，H3 检索/引用 WIP 已进入全量回归，私有策略待重新审定；完整四项、模型与 GUI 验收未完成。
Baseline: 恢复分支 HEAD 284f8c3c，已授权的 main 76790031 为 no-commit merge；保留全部 WIP。

## 1. 范围与现有能力

用户先要求六项一起完成，随后在结构化问题中选择“四项并入，增强项后置”。本文件按最后
确认执行：H1 会话摘要失败处理、H2 单次长 Run 压缩、H3 Memory 正确性与新鲜度、
H4 工具结果预算均在本批完整实施及验收。后台自动经验提炼、语义检索实现和评测后置。
不将中文词法召回声称为语义检索，不将已有 candidate 接口声称为后台自动学习。

本设计从[问答与沙盒联合计划](conversation-user-input-and-sandbox-integration.md)进入
[Typed Transcript 总计划](conversation-codex-style-transcript-implementation-plan.md)，不重编号
D0/E1–E6、U/T/G/K 案例，不减少原 packaged 20 案及 U-01–U-10、S-01–S-06。
问答完整恢复、N03、batch、原生沙盒仍是独立完成门槛。

已核对的复用点：

- conversation-summary-coordinator 已有结构化结果、source fence、摘要 checkpoint、预算策略。
  原 channels/messages 的 single-flight 包装返回 void，并吞结果和异常；H1-A 已提取为保留
  结果的独立模块，hard 调用方尚未消费结果形成预算门禁或公共观察状态。
- 当前 runner-pi/adapter 使用 Pi 1.1.0、内存 Session，compaction.enabled=false。本文后文的 0.84.4
  均是对应日期的历史 SDK 生命周期核验记录，不代表当前安装版本。
  SDK 手动 compact 首先 abort，不能直接对活跃执行调用它再假定自动续跑。
- memory-retrieval-store 在 scope/相关性过滤前先取最近 500 条；中文整句按空格标点切词。
  已有 MemoryReview、verifyBeforeUse、self-improving validUntil/supersededBy 和作用域投影。
- unified-exec 已有预览/产物字节上限，tool hydration 已有工具 schema 预算。
  schema 预算不等于实际工具结果预算；需要统一 read/search/exec/MCP/dynamic 的输出入口。
- MemoryRetrievalProvider 与 consolidation candidate 审核已存在，本批保留，不另建服务。

## 2. 共同合同与模块边界

    canonical items / Memory -> Host 作用域与资格过滤 -> 会话摘要及请求预算
        -> immutable prepared request -> Pi 单次执行与有界工具结果
        -> 原子 RunEvent / ExecutionAction -> shared projection -> 三类会话与 child

Ling 持有历史、授权、冻结输入、恢复决策和完成事实；Pi Session 只持有本次模型执行上下文。
压缩改变输入投影，不修改历史，不推进不存在的完成证据，不改 contextSegmentId 或 UI batch。
同一 run/attempt 的压缩、取消、必答暂停和审批使用同一个 Host owner/fence，不各建一套状态机。

- Core：scoped Memory 查询、健康资格、只读快照与 durable checkpoint；无模型调用。
- Daemon context-processing：摘要协调、预算复核和失败策略；messages 只接线。
- Runner Pi：SDK 适配、usage/lifecycle、工具边界暂停；不决定授权、历史或业务终态。
- Daemon tool-results：权限内产物、输出预算、按需读取；复用已有 artifacts/capability。
- Contracts：版本化预算/压缩观察结果、source refs 和白名单公共 DTO。
- UI：同一 contextCompaction renderer 与状态投影，不在三个 surface 各写摘要逻辑。
- Tests：纯策略、临时 SQLite、真实 SDK 模拟传输、Host 集成、真实模型和 packaged 分层记录。

新增事件字段至少可追溯 workspace/thread/turn/run/attempt、source refs、policyVersion、
触发原因、estimated/measured usage、结果状态和安全 reason code；不把原始异常/prompt/秘密
放进公共 SSE 或复制。没有 Run 的摘要事件不能伪造 runId；沿现有 context checkpoint 归属。

## 3. H1：摘要结果、失败与预算门禁

single-flight 返回原始结构化结果；按数据库/thread/segment 合并并发，不吞异常。
超时和取消必须结束真实 generator，超时后迟到结果不得提交；清理只删除自己的 flight。
正常 completed 也不直接表示可执行：重建当前有权限的投影，并在最终 prepared request
包含 system/tools/reserved output 后复核预算。source fence 变化时重规划，不覆盖旧快照。

soft 阈值只触发后台维护；本次输入可容纳时允许继续，并记录维护失败。
hard 阈值要求先尝试压缩并复核，不直接等同于模型绝对容量；失败但输入仍可容纳时显式
degraded，不能报已压缩。最终超预算或预算无法确定时显式 blocked，不继续盲发请求。
generator unavailable、generation failed、checkpoint failed、source conflict、cancelled、
no eligible prefix 都有可区分结果；没有可压前缀不能被当作不需要预算检查。
不无限重试压缩，不删除 active work、待答/审批及未解决约束来强行达到 target ratio。

## 4. H2：单次长 Run 的 Pi 压缩与恢复

逐字冻结任务的 projection、provider 准入和 Host seal 规则，见
[Run 压缩后的冻结任务约束](run-compaction-task-constraints.md)。摘要可以保留字段名但仍损失原始结构；
不能仅凭摘要出现关键词就认为原始任务已完整保留，也不能把产物错误一概归因为失忆。

先用安装的 Pi SDK 做带真实生命周期的测试，确认自动压缩的触发、安全边界、错误传播及
tool call/result 配对；通过后才开启适配。活跃工具、审批或必答暂停时不并发手动 compact。
前后 usage 和 SDK lifecycle 进入 Host typed evidence；SDK 标 completed 不作为任务成功。

本轮 prepared request 不因压缩改写。Host 保存压缩来源事件水位、模型/策略版本、摘要引用、
usage 及必要的 continuation lineage；不得把完整 Pi Session 复制为 canonical history。
压缩不能丢当前目标、约束、未完成工具对、待答/审批关联和可检索 evidence refs。

daemon restart 从 Host 已提交 checkpoint 恢复；无安全 checkpoint 或外部副作用不确定则
明确 blocked，不从任意 assistant 文本重造成功，不重跑已完成命令。续接重验权限和 fence，
与 U2/U3/N03 共用唯一 successor 及冻结输入，不新建第二套恢复器。

### 4.1 压缩后继续执行的进度水位（2026-09-28 补充）

SDK 在一次 `compaction_end` 后仍可继续模型请求和工具调用。单凭“最新压缩 checkpoint”
恢复不安全：若后续工具已完成而 daemon 崩溃，旧 SDK 视图会重新生成并执行该工具。
当前恢复链路先按 RunEvent sequence 分页检查 checkpoint 之后的事实；除同一次安装事件、
内部快照引用和无新模型内容的 `turn_end` 外，任何后续进度均返回
`checkpoint.effect_unknown`，不重放。这是**安全门禁**，不是 H2 完整恢复。

2026-09-28 接续实现：下一次 provider 请求前，Runner 把已安装的 SDK 模型视图交给 Host；
Host 核对新 `tool_start/tool_end` 配对、未决审批/问题/命令写入、Run/Attempt fence、
前驱视图前缀、权限指纹与来源水位后，把新视图作为 sealed progress artifact 提交到
现有 `run_compaction_checkpoints`，`sourceEventSeq` 为本轮最后的 RunEvent 水位。
恢复只读取最新 committed checkpoint，逐个校验 predecessor、摘要 digest 与工具事件；
已有后续操作而缺少匹配视图、取消/失败或证据不确定时仍 fail closed。经 Host 核验的
daemon recovery 可由新 Attempt 接续旧 Attempt 的检查点，任意 Attempt 不可自行接管。
真实 Pi SDK 的恢复后读取、第二次模型请求前提交 SQLite 进度，以及随后重启不重放已完成
工具已有定向测试；**这仍不是整个 H2/H-02/H-05 的验收完成**，自动压缩触发后的完整
长任务、多工具失败/取消和 packaged GUI 仍需联合验证。
内置只读 `read` 的失败可作为已收束的错误结果进入 progress checkpoint，让模型纠正；
失败的 consequential tool 在不能证明无部分副作用时仍返回 `checkpoint.effect_unknown`。

H2 的长期目标是在每次压缩之后的工具轮次末保存新的 Host-owned progress
checkpoint：使用 SDK 已安装的精确模型视图、最近已完成 tool call/result 配对、Run/Attempt
fence、source event sequence、策略/模型/上下文身份、workspace provenance 水位，以及前一
checkpoint 引用。只在所有工具结果、审批和问题状态可证明已收束时 CAS 提交；晚到/重复
事件不得前移水位。恢复只安装**最新安全 progress 视图**，绝不从较旧的 compaction
summary 重放后续动作。现有表以每轮最后的 RunEvent seq 表达后续进度，保留
`(runId, attemptId, sourceEventSeq)` 唯一性、predecessor 与 sealed source refs，无需新增表。
真实 SDK 长工具循环、取消、失败、断电重启和无重复副作用的同场景联合测试通过前，
不将 H2 标记完成。

### 4.2 2026-09-27 SDK 边界复核后的实施约束

历史核验的 Pi 0.84.4 在工具轮次之间调用 `_compactBeforeNextAssistantResponse`，
并在 `agent_end` 后另做 threshold 检查。是否能中途压缩还取决于 SDK 能否在
`keepRecentTokens` 内找到安全 cut point：最近工具结果过大时会推迟到结束，
有切点时则会在下一次任务模型请求前压缩。真实 SDK 回归已覆盖两种情况；
不能依据单一“结束后压缩”样例推断整个生命周期。该次复核时 Ling 仍关闭自动压缩；
2026-09-28 起仅在 Host 明确具备 enforce continuation、Run/Attempt 身份和 provider
admission fence 时 opt-in，其余执行继续关闭。
活跃工具上调用 `session.compact()` 会先中断执行，完成后也不会自动续接；
`context` hook 虽能替换下一次模型请求的 messages，却不会自动形成可恢复的
Host 历史或 checkpoint。不得将这三种机制等同。

已接入的 `context_compaction_start/end` 和 assistant usage 只是带 Attempt 归属的
RunEvent 观察事实。`sdk_installed` 仅表示 SDK 内存 Session 已安装摘要，不表示
Daemon 重启后可恢复；事件不包含摘要正文或 provider 错误。现有
`CompactionCheckpoint` 对应 Thread/Item 摘要与 workspace provenance，不能直接
冒充单次 Run 的工具循环 checkpoint。

当时确定的实现约束是在**下一次模型请求之前**确定安全边界：前一工具调用和结果均已
落为 Host 原子事件，未决审批/必答/取消均已让出，当前 Attempt fence 与权限仍有效。
Host checkpoint 要绑定 run/attempt、上一个已提交 RunEvent 序号、模型/策略版本、
摘要的受限 artifact 引用与摘要内容摘要、仍需保留的当前目标/约束/未完成关联；
先提交 checkpoint 再允许模型使用压缩视图。不能在 SDK 内存摘要已安装后才把
无可恢复的 `compaction_end` 当 checkpoint 补写。

恢复时只接受可核验的 Host checkpoint，通过现有 RunnerContinuation 的唯一 successor
和 prepared-input/fence 校验重建模型视图；不能从 `agentMessage` 或 SDK Session
文本猜测已执行副作用。checkpoint 不完整、工具 effect-unknown、来源水位变化或
权限漂移必须结构化 blocked。H4 的完整原子 tool evidence 与有界模型视图也须
分离，否则压缩来源可能只剩裁剪后的结果，无法安全重建。

## 5. H3：Memory 候选资格、中文召回和新鲜度

先按真实 workspace/scope/owner、审核状态和隐私规则筛选，再做相关性选择及 maxResults。
不能将“先取最近 500 条”或“每 scope 再截 500 条”作为全量相关记忆不存在的证明。
复用 SQLite 参数化查询与 scope 索引，排序有稳定 ID tie-breaker；候选生成不依赖全局新鲜度。
若实现采用分页扫描，必须有确定性 cursor、snapshot 和明确预算耗尽结果，不能静默漏报。

默认模型召回排除 expired、superseded、inactive；损坏的有效期 fail closed。
verifyBeforeUse 只可作为需核实的线索，不直接进入事实陈述或完成报告；保留其 metadata。
人工 review/search 可显式查看旧记录及原因，但不通过 includeDisabled 自动扩大模型可用资格。
读取与资格筛选在一致快照完成，撤回后不从缓存复活正文；不跟随替代引用穿越 scope。

中文使用可测的有界词法分解（中文词/相邻字片段）与现有英文词匹配，保留 tags/source 权重；
排除单字泛匹配，限定 query 长度与 token 数。用同义词案例明确词法能力边界，不宣称任意改写
都能召回。若需纯语义命中，登记后置的语义检索，不偷偷外发 Memory 到新 embedding 服务。
private influence_only 与 public displayable 规则继续由 context-processing/memory 消费，
不能通过候选数、摘要、matchedTerms、产物路径或其他 Agent 的上下文泄露 private 正文。

## 6. H4：统一工具结果预算与按需读取

Host 统一计算每结果及每请求累计预算，区分字节/估算 token/实际 usage；上限来自当前模型
和 prepared request 的余量，不只按字符截断。Runner 不信任工具自报 token 数或完成状态。
输出先做权限和秘密过滤，模型视图再裁剪；原子 action 的真实状态、exit 非零、取消、
toolCallId/actionId/source refs、truncated 原因不能被裁掉或重写成成功。

大结果复用已有 artifact 存储；返回有界预览、可用产物引用、总量和读取范围。产物创建失败
明确 unavailable，不返回不存在的路径。产物读取按 workspace/run/participant/visibility
重新鉴权并支持分页/范围上限；猜 ID、绝对路径、symlink 或过期 capability 不能绕过权限。
产物本身也有总大小/保留上限；超限时明确不完整，不承诺无限保存，不由模型指挥覆盖任意文件。

read/search/exec/MCP/dynamic 共用该策略；UI 摘要和模型预算投影互不代替。tool_update 更新
live revision；TerminalReport/fan-in 仍只读原子 evidence，不读裁剪后预览或 batch 数量。

## 7. 实施任务与联合退出条件

| 顺序 | 任务 | 依赖 | 必需退出证据 | 当前 |
| --- | --- | --- | --- | --- |
| 1 | H0 公共预算/压缩/资格合同与失败红测 | 现有 contracts、source fence | 不改变历史/权限/终态；失败先复现 | 未实施 |
| 2 | H1 摘要 single-flight、复核与 typed gate | H0、N03 接口 | 失败不丢、超限不发、迟到不提交 | H1-A、H1-B1 内部结果语义已验证；门禁/观察未完成 |
| 3 | H3 scoped Memory/健康/中文词法召回 | H0、已确认的授权范围内共享 | 老记忆、撤回、中文、隔离及性能回归 | WIP；共享边界已修，联合验收未完 |
| 4 | H2 Pi 长 Run 压缩与恢复 | H0、U2/U3、N03、真实停止证明 | 长工具循环、暂停/取消/重启无重复副作用 | SDK 前置核验与停止通道已验证；中途压缩/持久化恢复未实施 |
| 5 | H4 工具结果/产物统一预算 | H0、当前权限/产物链路 | 各工具入口有界且事实/权限完整 | H4-A 命令字符边界已验证；统一预算/产物按需读取未实施 |
| 6 | H5 共享观察 UI 与组合项目验收 | H1–H4、U4/T 和原矩阵 | 同版本 packaged 三 surface + 多 Agent | not_run |

H-01 摘要超时、generator 缺失、异常、checkpoint/source conflict、无可压前缀及必留尾部超限。
H-02 一次长 Run 超阈值，工具/审批/必答/取消同时发生，真实 SDK 不重复执行、不吞错误。
H-03 超过 500 条且目标最旧、同/跨 scope、中文换措辞、英文、过期/替代/待核实、隐私撤回。
H-04 多工具累计长输出、非零退出/取消、UTF-8 边界、产物失败、越权/过期/分页读取。
H-05 摘要/压缩前后及 ACK/副作用边界 daemon restart、SSE reconnect、两 Agent fan-in。
H-06 macOS 新包普通/私聊/频道完整小项目，连续追问和长工具输出后真实改代码并验证产物。

以上完整案例初始全部 not_run。每条关联版本 hash、case/thread/run/attempt、Host/SQLite
lineage 和截图；单测或 Electron 内嵌 Node 通过不冒充真实 GUI、模型或 OS 安全边界通过。
性能记录候选数、扫描数、耗时和内存；数据规模至少 501/5,000/50,000，无无限加载或重试。

### 7.1 H1-A 执行协调切片（2026-09-07）

原生产构建的 wrapper 红测实际返回 undefined，丢失 generator_unavailable 结果。
现新增独立 ConversationSummaryExecutionRegistry，messages 仅接线：保留 completed、
generator_unavailable、generation_failed、checkpoint_failed 和 stale commit；未知抛错为
execution_failed，不向公共返回写入原始 error/plan。key 使用数据库/thread/segment 元组，
避免冒号碰撞；执行注册早于 generator 调用，防重入；settle 时只清理自己的 timer/flight。

超时会发送 abort，但仍等实际 generator settle 才释放 flight；迟到结果不能提交。
这不是强制停止不合作 runner 的保证：忽略取消且永不 settle 时仍会等待，不能伪造停止回执。
本切片没有最终请求预算复核、公开 DTO/观察 UI 或完整 H1 门禁；调用方仍需后续接线消费结果。

专项 11/11、相关回归 47/47；新模块 line/branch/function coverage 100%。Daemon 全量
1552 项：1545 pass / 原 7 fail / 0 skip，失败名相对 U4-A added=[]、removed=[]。
Daemon build/typecheck 通过。未运行真实模型、OS 沙盒或 packaged GUI，不改 H-01–H-06 的 not_run。
完整命令、限制和后续接缝见 H1-A 交接 (`harness-summary-h1a-handoff-20260907.md`)。

### 7.2 H3 当前边界及后续接线（2026-09-08）

已移除资格过滤前最近 500 条截断；同一 SQLite statement 过滤 scope/健康后扫描并保留 top-k，
补中文双字词法、有效期/替代排除、verifyBeforeUse 引用限制。查询结果数组有界，但仍为
同步 O(N) 扫描；50,001 条合成约 1KB 记录时 p95 约 0.42 秒，不能称大规模性能已解决。
新 Core 全量 749/749；Daemon 三处旧策略版本断言已同步，最终全量 1560 项：1553 pass /
原 7 fail，失败名与 H1-A 基线相同。Core/Daemon typecheck:ci、git diff --check 通过。
日志位于 /private/tmp/ling-memory-h3-20260908.u6UY8M/，最终 Daemon 为 daemon-verified.log；
此旧回归包含后来确认过严的私有策略 WIP，不能用它证明新版共享语义正确。
没有新模型/OS/GUI 验收，不改 H-01–H-06 not_run。

用户已确认“授权 workspace/channel 共享、独立队友私聊默认隔离、跨范围与外发另验”。
已修 Core 召回与 Daemon 双层过滤，并保留真实来源 workspace；没有新增表或改真实数据。
73 项专项通过，证据 /private/tmp/ling-h3-shared-scope-20260908.jOiEPE/targeted.log。
最新 Core 749/749；Daemon 1566 项中 1559 pass/原 7 fail，逐条失败名对比无新增/消除。
Core/Daemon build:ci、typecheck:ci 与 diff check 通过。详情见
本次交接 (`memory-shared-scope-handoff-20260908.md`)；真实模型/GUI 仍未验，
共享模型上下文不能证明自由文本不会泄露。
具体范围及新纳入的技能/自动审核设计见
[联合实施增量 §5](skills-autoreview-harness-integration.md#5-memory-边界更正与已确认范围)。

### 7.3 H1-B1 内部结果语义（2026-09-08）

已修正摘要协调层三处误报：达到维护阈值但没有可压前缀不再由 coordinator 返回
`not_needed`；已取消的执行返回 `cancelled`；source fence 导致的 `discarded_stale`
返回 `source_conflict`。`completed` 的类型现在要求 committed summary 与已安装 checkpoint。
取消依据实际 AbortSignal，不根据异常名称或错误文案推断；中途取消不提交部分摘要。
single-flight 仍等 generator 真实 settle，不能把 timeout 发出当作停止证明。

新增 `assessConversationContextSummary` 保留 ready/not_needed/no_eligible_prefix 区别；
无前缀结果带原 sourceItem/thread/segment 和估算量，不携带原文，也不减少原文保留尾部。
既有 plan-only query 用于维护调度；其 undefined 仍然不能作为请求容量足够的证明。
`coordinateConversationContextSummary` 已使用完整 assessment，未把内部 plan/error 序列化到 UI。

红测 20 项中 6 fail；修复及新增边界后 25/25 通过。Daemon build:ci、typecheck:ci
通过；全量 1590 项中 1583 pass / 原 7 fail / 0 skip，与 U4-B2-B 失败名对比
added=[]、removed=[]。本次仅运行临时 SQLite/模拟生成器和 Daemon 测试，没有模型/GUI 证据。
详见 H1-B1 交接 (`harness-summary-outcomes-handoff-20260908.md`)。

**仍未完成：** messages 上层仍需消费维护结果、重建投影、处理 planning failure；最终
prepared request 含 system/tools/reserved output 的 soft degraded / hard blocked 容量门禁
仍依赖 N03 接缝。公共白名单观察 DTO/UI 尚未接入。本切片不能标完整 H1 或 H-01 通过，
不改变 H-01–H-06 及其他联合验收项的 not_run。

### 7.4 H2-A：真实 SDK 生命周期核验与停止通道（2026-09-08）

历史核验安装的 `@earendil-works/pi-coding-agent` / `pi-ai` 版本为 0.84.4。测试使用真实
AgentSession、SessionManager、provider SSE parser、内置 compactor、retry 与工具调度；
仅替换每个 ModelRuntime 的传输为固定响应，凭据/资源/Session 为内存隔离，工具只向
mkdtemp 目录追加标记。没有读取真实凭据、扫描用户资源或调用外部模型。

| 已执行场景 | 真实观察 | Ling 的接线要求 |
| --- | --- | --- |
| 连续三次高 usage 工具调用 | 四次 turn_end 后才出现 threshold compaction；不是每次工具迭代都检查 | 不能仅开启 SDK auto-compaction 就声称支持长 Run 中途主动压缩 |
| 自动摘要失败 | prompt 可以正常返回，compaction_end 含失败及原始 provider 文案 | 分离任务结果和维护结果；公共观察只能投影白名单 reason |
| 摘要输出要求调用工具 | 被拒绝，不执行副作用、不安装摘要 | 摘要不获得工具执行权 |
| overflow 后一次 compact-and-retry | 已执行标记不重复；失败保留在 SDK history，但不进入 retry 模型上下文 | 保留原子执行事实，不用重试后的文本覆盖失败历史 |
| 第二次 overflow | 最多恢复一次；可以有无对应第二个 start 的失败 end | 不把 start/end 数量配对当成功证明，不无限重试 |
| 同毫秒 overflow | SDK timestamp <= compaction timestamp 的过滤可能省略第二个失败 end；最终 assistant 仍为 error | 还需检查真实末条执行失败；不能用时间戳或单个 compaction_end 代替 Host 事件序号和终态 |
| 摘要暂时失败重试与 backoff 取消 | 重试有界、不重跑完成任务；retry_finished 没有 success 字段 | retry_finished 不是成功结果，取消需覆盖 SDK 自己的定时器 |
| 手动 compact 正执行工具 | 先等待被取消工具清理，再压缩；不会自动续跑被中断 turn | 不在活跃工具/extension 回调里 await compact；续接由 Host 安全边界明确驱动 |
| 两个并发 Session | 取消一个摘要不影响另一个工具任务 | 每个运行独立控制器，不能全局 abort |

**取消反例及实现：** Ling 既有 task-boundary 已将用户取消传到模型 signal，但不足以
取消 SDK 的独立摘要控制器/backoff；固定传输故意忽略 signal 后迟到成功时，真实 SDK
仍安装了一个内存摘要条目。该反例在修改产品前得到 13 项中的 1 fail，不是推测。
现有 task-boundary 新增 createPiSessionStopper，由 adapter 的原 stopSession 入口复用：
先登记共享 Promise，再同步发出 abortCompaction 与 agent abort，等 SDK 真实空闲才结束；
保持同步取消、重入幂等和清理失败可见。压缩取消失败仍尝试 agent abort，失败不会变成成功。
未新建 Host 恢复器；SDK 内存摘要条目不是 Ling 的 SQLite checkpoint。

16 项专项（14 项真实 SDK 生命周期 + 2 项停止函数单测）通过；Runner 全量 78/78。
Runner/Daemon build:ci、typecheck:ci 通过。Daemon 全量 1590 项：1583 pass / 原 7 fail /
0 skip，和 H1-B1 失败名对比 added=[]、removed=[]。记录为 `/private/tmp/ling-h2-*.log`，
最终完整 Runner 为 ling-h2-runner-verified-20260908.log，Daemon 为
ling-h2-daemon-full-20260908.log，失败比较为 ling-h2-daemon-failure-comparison-20260908.json。
源码、SDK 文件指纹和详细限制见 `/private/tmp/ling-h2-pi-compaction-handoff-20260908.md`。

**仍不成立的完成声明：** adapter 的 compaction.enabled 仍为 false；尚无真正长模型任务
的中途压缩、Host 固定事件水位/摘要 lineage 安装、daemon restart 续接或 GUI 观察证据。
这些仍须和 U2/U3/N03 统一实现，不以本次 SDK fixture 成功替代。SDK 核验不证明摘要语义
准确、不证明最终 system/tools/output 预算足够，不改变 H-02/H-05/H-06 的 not_run。
本次没有新增产品决策，既有范围待答保持；不要重复实现已经验证的 task-boundary 取消保护。

### 7.5 H4-A：命令输出 Unicode 边界与线性裁剪（2026-09-08）

这次没有实现统一 token 预算。先在真实 `executeUnifiedBashTool` 上复现三个字符损坏反例：
按 8 KiB 截预览切开 emoji、256 字符脱敏缓存边界切开 surrogate pair、进程两次输出同一
UTF-8 字符时解码为 `���`。均在隔离临时目录执行真实 Node 命令；产物元数据使用内存
fixture，并实际检查写出的产物文件。不是模型、真实 SQLite、GUI 或 OS 沙盒验证。

将已有捕获、裁剪和 stream summary 提取到 `unified-exec-output.ts`，主执行文件仅接线：
每条 stdout/stderr 独立 StringDecoder，结束时 flush 剩余字节；脱敏缓存按完整 Unicode
字符切分；字节上限按 UTF-8 边界取连续前缀；第一次截断后不再用后来的 ASCII 填空。
事件分块按编码后字节偏移线性扫描，不再对长字符串反复从头计算 byteLength。
保留现有 8 KiB/4 KiB/2 MiB 上限、raw byteCount、toolCallId/stream/sequence、状态、
exitCode 和真实 artifact 引用；不把裁剪后的文本当执行完成事实。

新增模块 209 行，主执行文件由 877 行降至 688 行；不向 renderer 或 orchestrator 增加算法。
原 `renderUnifiedExecModelOutput` WIP 保留。既有 256 字符脱敏策略及产物权限策略未重写，
本切片不证明任意跨块 secret 的脱敏安全；完整单 secret 与既有审批/脱敏案例未回退。
lineCount 仍按既有有界产物内容统计，不能把它解释为超限原始流的完整行数。

三个最初的真实命令红测 0/3 -> 3/3；新有界红测 14 项中 10 fail -> 完整专项 17/17。
旧 2 MiB 测试因重复扫描运行近 3 分钟后精确停止，未当作通过；修复后的三项 2 MiB
字符边界测试约 6–18 ms/项，属于夹具观察，不代表模型或 GUI 性能。
既有命令执行/审批/超时/取消/产物/快照集成 10/10；Daemon build:ci/typecheck:ci 通过。
全量 1607 项：1600 pass / 原 7 fail / 0 skip，与 H2-A 比较 added=[]、removed=[]。

证据见 H4-A 交接 (`harness-unicode-output-handoff-20260908.md`) 和
`/private/tmp/ling-h4-unicode-*.log`。这次没有新 App、新截图或 packaged GUI 测试。
不改变 H-04/H-05/H-06 的联合 not_run，也不删除原 G/K/U/S 验收矩阵。

**后续状态（2026-09-08）：** MCP 普通/动态入口失败 details 丢失、bash SDK model context
与 Host 失败标记不一致，已按最新授权修复，见 §7.6。文件数量不再作为内部链路待答门禁。
H4 每结果/每请求累计 token 预算、权限内产物分页读取、artifact 创建失败语义与最终
prepared request 门禁仍待完整实现；N03/batch 内部实现范围已授权，不等于已经实现。

### 7.6 H4-B：Host 工具结果与 SDK 失败状态保真（2026-09-08）

安装的 Pi SDK 将 execute resolve 固定为成功，throw 则丢弃结构化 details。现在使用其
正式 tool_result hook，在每个 extension 安装实例的 WeakMap 中按规范化 content 对象、
toolCallId、toolName、details 身份消费一次 Host 结果。无全局调用 ID 表，不从模型正文或
任意 details 状态推断事实。bash、edit/write、普通/动态 MCP、媒体入口复用同一适配器；
拒绝不能变成功，SDK 异常/取消优先，空失败输出有明确失败文案。

移除仅在 translatePiEvent 猜失败的兜底，Host 观察与 SDK 下一次模型上下文现在使用同一状态。
该 hook 不裁剪内容；完整文本、图片和 details 仍进入原子 tool_end。统一模型结果预算、
产物按需读取与最终请求容量门禁仍未实现，不能标整个 H4 完成。

原真实 SDK 3 个反例先失败后通过；扩展专项 32/32，Runner 全量 110/110，build/typecheck
通过。测试使用真实 SDK Session/parser 与隔离固定传输，不调用外部模型/MCP 服务，也不构成
macOS packaged GUI 或完整恢复验收。证据见 output/internal-chain-results-lineage-handoff-20260908.md。

### 7.8 H4-C：最终模型视图容量与产物读取边界（2026-09-27）

Runner 现在在实际 SDK 组装阶段计算 system prompt、用户输入、工具 schema 和消息视图的
估算输入容量，并扣除模型 `maxTokens` 与 Host runtime overhead；首轮准备和每次后续模型
请求都在超限前失败，不能把超大的工具结果送到 provider。模型投影仍是副本，完整 Host
`tool_end` 证据不被改写。UTF-8 artifact 截断按字节边界回退到合法 UTF-8，保留明确的
truncation marker。

artifact metadata/content/preview 路由现在拒绝非本地 Origin；带 Origin 的请求还必须绑定
daemon 已知 workspace。content 单次 range 读取上限为 1 MiB，真实路径再次 realpath 校验，
符号链接不能越过 artifact 根目录。读取授权仍需复用 action/capability lineage；本轮没有把
artifact ID 本身当作 participant 授权，也没有宣称 H4 完成。

补充：Pi `context_compaction_start` 现在在 SDK 改写上下文前捕获有界消息快照；Daemon 将
脱敏快照写入 run-owned sealed artifact，并在 compaction event 中保留
`checkpointArtifactId`，而不是把完整快照重复写进 RunEvent。该 artifact 已进入后续
continuation replay 的 artifact refs，但 recovery 读取/重建模型视图尚未接通，不能将其
误报为 H2 完成。

证据：Runner 专项 192/192、artifact UTF-8/分段读取专项、Daemon 全量回归和 artifact API
cross-origin 回归通过。H2 的 checkpoint 状态提交、daemon restart 恢复和 packaged macOS
验收仍未完成。

### 7.9 H2-B：Run/Attempt checkpoint 持久化与重启防误重放（2026-09-27）

新增独立的 `run_compaction_checkpoints` 表（迁移 140），不复用 Thread/Item 的
`compaction_checkpoints`。每条记录绑定 Run、Attempt、`context_compaction_start` 的
RunEvent seq、pre-compaction snapshot artifact、受限 summary artifact/摘要、模型、策略指纹、
workspace provenance 水位、当前目标/约束以及未完成 tool/approval/question ID。
`(runId, attemptId, sourceEventSeq)` 去重，`(runId, predecessorId)` 与最新已提交前驱校验
限制唯一后继；`prepared → committed|blocked` 使用 revision CAS。提交必须仍由活跃
Run/Attempt 持有，旧 Attempt 不能迟到提交。

Daemon restart 在分派 Runner 之前读取最新 compaction event 和 checkpoint：缺记录、
归属不符、artifact/digest 缺失、权限指纹或 workspace 水位漂移、未决副作用均输出结构化
`checkpoint.*` 错误并终结旧 stale Run，不重新执行原始 prompt。即使测试注入了合法的
`committed` checkpoint，当前仍以 `checkpoint.reconstruction_unavailable` 拦下；这是有意
fail-closed，因为 SDK 压缩模型视图尚不能从 Host checkpoint 恢复。旧 Run 最终状态是
`failed`，不是可自动继续的成功/blocked 工作流步骤；UI 需要显示具体错误码。

本阶段是持久化与防误重放，**不是 H2 可恢复压缩**。接下来必须补上 SDK 下一次模型请求前的
安全边界、真实摘要的 Host 原子提交、从 checkpoint 重建模型视图和 fenced continuation，
然后才能开启 `session-factory.ts` 的自动 compaction。当前 `context_compaction_start/end`
只作 SDK 观察事实；不得把已有快照 artifact 当作已提交恢复点。专项验证：Core checkpoint
3/3、Daemon continuation integration 16/16、Core/Daemon build/typecheck 通过；这不替代
全量回归或 packaged macOS GUI 验收。

### 7.10 H2/H4 接续核验（2026-09-27）

H2 checkpoint 的幂等键仍是 `(runId, attemptId, sourceEventSeq)`，但重复创建时现在会比较
完整恢复身份，包括前驱、模型、策略、目标、约束及未决关联；不同内容不能静默复用旧行。
重启评估也重新核算 sealed snapshot/summary 的 SHA-256，并核验 payload 的 Run/Attempt、
模型、事件序号及内容类型。权限指纹漂移、workspace 水位变化、未知副作用和摘要篡改
均有反例测试；这些门禁不代表模型视图已经可恢复。

历史 Pi 0.84.4 SDK 测试确认：`agent_end` 后自动压缩的模型视图最后仍可能是 assistant，
新 Session 对该视图直接 `agent.continue()` 会以 `Cannot continue from message role: assistant`
拒绝，且不会发模型请求。恢复设计须区分已完成回答的 Host 收尾与工具循环中断续接；
不能把所有 committed checkpoint 简单塞进新 Session 后盲目 continue 或重发原 prompt。
Pi 的 `context` extension hook 虽是下一次请求前的异步模型视图边界，但 SDK 会捕获 hook
异常后继续遍历其他 handler；Host 提交失败不能只靠该 handler 抛错阻止 provider 请求。
接入 H2 时必须增加独立的 provider-dispatch fence，并把 checkpoint summary artifact 保存为可
验证的精确模型视图（含保留的工具对），再开放请求。此为下一实现单元，不是本节已交付功能。

H4 不带 `offset/limit` 的 artifact 内容请求已从同步整文件读取改为流式传输，保持完整
图片、视频和下载响应；显式范围请求仍受 1 MiB 限制。大于 2 MiB 的完整下载和分段读取
已有路由回归。Run artifact 列表、单项元数据、RunEvent 历史与 live SSE 均在公开出口
排除 Host-only `sealedPayload` 和其内容摘要；回归证明 SQLite 内部证据仍可读，公开出口
不携带密封正文或其指纹。
流式只解决 Daemon
的整文件内存占用，元数据过滤只解决这一条泄露路径，不等于已经完成每请求总传输预算或
participant/action 级授权。上述两项及 H2 的下一次模型请求前安全提交、真实摘要安装、
fenced continuation 仍未完成；不得开启 SDK 自动 compaction 或结算 packaged GUI。

验证：Core 专项 4/4、Core 全量 1001/1001、Runner 全量 193/193、Daemon 压缩恢复专项 3/3、artifact API
专项通过，Core/Daemon typecheck/build 通过。Daemon 全量在单文件并发（`--test-concurrency=1`）
下 2048/2048 通过；默认/四文件并发在此机器出现测试环境争用，不能用作代码回归结论。
仍没有最新 packaged macOS GUI 验收结论。

### 7.11 H2 SDK 工具轮次切点修正（2026-09-28）

真实 SDK fixture 复现：`keepRecentTokens=200` 且工具结果允许安全切点时，
`compaction_start` 出现在最后一个 `tool_execution_end` 之前，摘要请求后仍有任务模型请求；
相同高 usage 但最近工具结果挤占保留窗口时，SDK 虽在每轮尝试 threshold，却要到
`agent_end` 后才能安装摘要。两种情况都保留工具调用与结果配对；`enabled=false`
则两种时点都不压缩。另一个真实反例确认：中途摘要请求失败后，SDK 仍可能发送
下一次任务模型请求，`session.prompt()` 本身不报错。Host 不能只记录失败事件，
必须在 provider dispatch 上 fail closed。Runner 专项 21/21 通过。

因此 H2 的 provider-dispatch fence 必须覆盖**同一 Run 的每个后续模型请求**，
不能只在 `session.prompt()` 开始或 `agent_end` 之后检查。Host 提交失败时必须阻止
SDK 中途摘要后的下一次请求；即便 SDK 尚未找到 cut point，也不能把观察到的
`compaction_start` 当成已提交恢复点。H2 完整提交和 fenced recovery 仍未实现，
自动压缩继续关闭。

Daemon 已在 `before_provider_request` 回调增加保守准入：只要本次执行收到
`context_compaction_end` 且尚无可恢复的 Host checkpoint，后续任务请求以
`checkpoint.missing` 或 `checkpoint.compaction_failed` 拒绝。SDK extension 的异常
可能被吞，Runner 的独立 task boundary 会锁存 Host 回调失败并在实际传输前再校验。
这只是**防误续跑**，不生成摘要、不开启压缩，也不代表已可恢复；下一步才是
真实摘要和精确模型视图的原子提交，以及对应 checkpoint 成功后的门禁释放。

### 7.7 Attempt 内执行循环检测与共享诊断投影（2026-09-10）

根因不是普通 idle timeout 太长，而是 Runner 每产生一个事件都会刷新 idle 水位；重复的
工具调用、相同 `tool_update` 或短周期动作因此可以无限续命。Attempt fence 只负责拒绝旧
Attempt 的迟到写入，不能判断当前 Attempt 是否正在原地循环。循环检测必须属于当前
Attempt 的 Host 执行控制面，不能由模型文本、UI batch 数量或客户端计时器推断。

本设计借鉴 Codex 的执行可靠性原则，但不复制其 session 外形：

- 每个 Attempt 使用独立、有界计数器和取消信号；相同动作/结果、重复 update、短周期循环
  和无新 evidence 动作预算分别检测，Agent 叙述不重置进展。
- Host 必须先持久化结构化 `loop_detected` reason，再触发 AbortController；取消完成后由
  terminal fence 拒绝迟到 Runner 事件，不能让错误返回后的成功回调覆盖失败事实。
- `loop_detected` 折叠为独立 `runtime_diagnostic` ExecutionAction，保留 action/run/attempt/
  participant/workflowStep/sourceRefs。它是失败证据，不是 Agent 文本、命令成功或完成摘要。
- delegated step 对该结果返回结构化 `blocked/execution_loop_detected`；required participant
  fan-in 不得把它计为成功；原样 retry 必须拒绝，避免立即复现同一循环。
- TerminalReport 只读取原子 ExecutionAction 和其 unresolved risk；activity/command batch
  仍然只是可重建 UI 投影，不参与完成判断。

共享 Timeline 的 `diagnostic` renderer 同时服务普通会话、队友私聊、频道和频道子 Agent。
主行只展示自然文案、错误图标和“没有新增证据”；技术代码不作为用户主文案。默认展开的
详情仅显示循环种类、出现次数、无新证据动作数和可选周期长度，不展示原始工具参数、结果
或 fingerprint。三类顶层会话与嵌套子 Agent 必须保持同一 renderer key、ARIA disclosure
和失败色阶。

回归门槛：证明 `loop_detected.seq < run_error.seq`、Abort 后迟到事件不进入 SQLite、Run/
WorkUnit/Attempt 一致失败、delegated/fan-in/retry/TerminalReport 读取同一原子事实；Web E2E
覆盖普通、私聊、频道和嵌套子 Agent。最终交付仍需 macOS packaged GUI 真实重复循环、daemon
restart、SSE reconnect 和历史恢复验证，fixture/E2E 截图不能替代 packaged 证据。

## 8. 权限与未决事项

本批不 commit/push/PR，不修改同事工作区、真实 SQLite 或凭据，不部署新服务/向量库。
用户最新授权按现有设计连续完成普通/私聊归属、N03/batch、MCP/SDK 等内部链路，不再逐次确认
文件数量。该授权不代答 T2-B 强隔离、外部 Relay 目的地和 AR 自动批准策略的既有待决事项。
这些前置决定仍阻挡对应组合验收；写入审核失败时不能用 shell 写文件或修改同事树绕过。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | --- | --- | --- |
| Harness integration | plan-eng-review；用户最新范围选择 | 四项接缝、模块和失败/性能条件 | 1 | SCOPED_DESIGN | 复用现有控制面；H1-A 已验证，完整实现和联合验收未完成，不是完整交互审查 |

**VERDICT:** 四项纳入本批，自动提炼与语义检索按最新选择后置；不是 CLEARED 或完成证明。
**UNRESOLVED DECISIONS:** T2-B、Relay、AR 策略仍需独立决定；内部链路范围已确认。

### 2026-09-28 E5/H2/H4 实现状态更正：恢复模型视图与 artifact 访问边界

本日切片已把上一阶段列出的 H2 Host checkpoint 安装链路接通：Daemon 在验证
Run/Attempt、摘要 artifact、模型/策略指纹、workspace provenance 和副作用状态后，
把精确 sealed model view 传给 Pi Runner。Runner 在新建的空 Session 中只安装该视图，
不重放原始 prompt；assistant 末尾视图只做 Host 收尾，不调用 `agent.continue()`，
toolResult 末尾视图才继续一次模型工具循环。恢复视图的 toolCall/toolResult 配对、
末尾状态和容量均在 Runner 边界再次校验。Daemon continuation integration 17/17、
Runner adapter compaction recovery 专项通过；右侧私聊 UI 仍保持冻结。

H4 artifact 边界也已补齐一层：metadata/content/preview 路由必须携带显式 `cwd`，
带 workspace 的 artifact 查找优先使用该 workspace，不能从已打开的 sibling store 借用
同名 artifact；`runId`、`participantId`、`workflowStepId`、`actionId` 查询若存在，必须
与 artifact 的 Run/ExecutionAction refs 一致，否则返回 404。无范围完整下载超过 8 MiB
时返回结构化 `artifact_transfer_budget_exceeded`，范围读取仍最多 1 MiB；路径 realpath
和 symlink 根目录校验不变。

因此 H2 的 checkpoint/restart 防误重放与 H4 的 artifact 访问/下载边界已实现并有自动化
证据，但 H4 的完整模型上下文预算、所有工具入口的统一剩余容量门禁，以及 E6 最新 packaged
macOS、SSE reconnect、daemon restart GUI 矩阵仍未结算。不得把本节自动化通过写成整体 E6 完成。

### 2026-09-28 H4 模型视图耗尽边界

真实代码复现表明，原 `boundModelToolResults` 在累计 96 KiB 用完后会把较早的非空
`toolResult.content` 投影为 `[]`，没有截断标记。现在对每个结果预留“完整小结果或最短
截断标记”所需的最小字节；无法保留任何明确标记时 fail closed。实际 Provider dispatch
边界再次校验同一投影预算，避免 SDK context hook 报错后继续发送原始消息。完整 Host
`tool_end` 内容、状态与 details 仍不变。测试先红后绿，覆盖累计耗尽、标记预算不足、
小结果不被误拒、多段文本及图片上限；Runner build:ci 与全量 **203/203** 通过。
这只是 H4 模型视图的局部闭环，Host 侧跨工具的动态剩余容量、权限内 artifact 按需读取
联合案例和 E6 packaged GUI 仍未结算。
