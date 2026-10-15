# A28 — Teammate direct logical pause and terminal reconciliation

日期：2026-10-16。状态：细设计冻结，产品实现和新增行为验证尚未完成。

## 1. 问题、实测证据与范围

一次 Runner 调用结束，不等于一个逻辑私聊回复结束。真实 Host 已提交审批暂停或问答
yield 时，原回复仍属于原 teammate、私聊 Thread 和 canonical Turn，不应被改成失败，
更不能因模型有叙述就被当成成功。恢复执行真正终结后，必须回到同一消息完成收口。

Root 已运行 `packages/daemon/test/teammate-direct-logical-pause.test.mjs`，更正 fixture
前提后的日志是 `output/e6-20260928/a27-20261016/a28-corrected-first-logical-pause.log`：

- 六例中四项普通成功、失败、空结果、用户取消通过；两项 shutdown 业务断言失败。
- 两项均到达真实审批 checkpoint：revision 从 1 到 2，原 Attempt 为
  `lost/runtime_suspend`，Run / WorkUnit 仍为 `waiting_for_approval`。
- 但 SQLite 私聊消息被写为 `failed`，错误为 `Private execution failed.`。
- 测试有独立 home / workspace、真实 index stop、HTTP/SSE、SQLite reopen；
  不是用错误字符串或手写状态伪造暂停。本设计作者没有重新运行这些测试。

首跑的 fixture 失败不是上述业务 RED：`read_only` 会话策略把 workspace `read:ask`
归一为 allow。现有 fixture 已仅将 Agent profile 改为
`{mode:"standard",requiredForTools:["read"]}`，六例和原断言不变。

本 slice 不新增表、不迁移真实历史、不修改权限政策、不启用未完成的公共问答续跑，
不重写三种会话 UI、不改多 Agent fan-in，不把主 CI 作为门槛。主 CI 继续停用。

## 2. 已核对的现有链路

- `features/teammates/direct-replies.ts`：`await startRun` 返回后无条件调用
  `finishProjectedRun`；除了 succeeded / cancelled，存在 Run 就写 failed；
  其调用者除 ready 外全部调用 `onBlocked`。只改一个状态分支仍会误发终结 SSE。
- `direct-execution-projection.ts`：实时叙述落私聊消息，但 runtime update 目前
  只有消息 ID，不能单凭它抵御暂停后旧 Attempt 的晚回调。
- `direct-message-narration.ts`：GET 能从持久 RunEvents 补叙述与 segments，
  不负责生命周期。因此只修 live Promise，刷新/恢复仍可能不同步。
- `direct-run-owner.ts`：已有只读 owner 校验；Run 没有 turnId，必须读取
  `getLingTurnForRun` 和 Turn–Run link，不能从不存在的字段或线程最新指针推测。
- Core `approval-resume-store.ts`：`commitApprovalResumeSuspension` 在真实事务中
  原子提交 checkpoint revision、Attempt lost、资源释放及 runtime audit，保留逻辑状态。
- Core `user-input-wait-store.ts`：`commitUserInputYield` 原子提交 checkpoint、
  Run / Attempt yielded、WorkUnit waiting、清 activeAttemptId、释放原 fence 资源。
- `server/router.ts` 的 `maybeContinueRunInterventions` 与 `index.ts` 的
  `afterChannelRunTerminal` 已接普通执行/审批恢复/daemon recovery 的终结回调，
  但尚未收口私聊消息。函数名带 Channel 不代表只处理频道。

## 3. 模块与数据流

复用现有 owner、叙述、checkpoint parser 与 Core 事务事实。新增一个聚焦的
`features/teammates/direct-message-lifecycle.ts`，不向大型 router 塞入分类规则。
它包含只读事实装载与纯生命周期分类；live、GET、terminal reconciler 共用该分类。
持久化采用 Core 的短原子校验/条件更新，不把 Daemon UI 逻辑放进 SQLite mapper。

```text
live startRun settlement -----+
GET /teammates/:id/... -------+--> one synchronous readSnapshot
terminal/recovery hook -------+        |
                                      +-- message + owner + canonical Turn/Run
                                      +-- WorkUnit + original/current Attempt
                                      +-- approval/yield proofs + durable narration
                                              |
                                     pure lifecycle classification
                                       /          |           \
                                logical-open   terminal    indeterminate
                                   pending     exact result   preserve + diagnostic
                                       |          |
GET: return read-only DTO <-------------+----------+
live/terminal: guarded short commit --> invalidate private message view
```

新增的类型/helper 名称是计划，不代表已存在 API。具体职责：

- UI：继续使用现有私聊消息和共享会话组件，不根据文字判断完成。
- Daemon lifecycle：分类、叙述及最终用户可见结果；不启动工具、不审批、不释放 lease。
- Core persistence：在自身写事务内重验 observation、消息归属/link、状态和 proof revision；
  校验失败返回 stale，不执行无条件覆盖。不得新增通用任意事务逃生口。
- 路由/恢复 adapter：仅传入已提交的 Run identity，调用相同 reconciler、发布现有
  私聊 invalidation；HTTP response 是否存在不能影响持久化。
- 测试：保留现有六例，增加真实恢复和 proof 边界，不生产手写成功状态的假闭环。

## 4. 单 snapshot 的事实与 owner 检查

装载必须在一次同步 `store.readSnapshot` 内完成，不能 await；先重读 message，
不能用分页前、旧 callback 或旧 DTO 中的 linkedRunId 代替当前事实。

1. message 为 `ai-teammate`，workspace、teammate、directThread、author 匹配请求 scope。
2. directThread 确属此 teammate；canonical LingThread 的 kind 为 `teammate_direct`，
   teammate/workspace 匹配且不存在 channel/workflow 归属。
3. message.linkedRunId、Run ID、Run.teammateId / threadId 匹配；原 Run 的 canonical
   Turn 及 Turn–Run link 存在且同 owner。不得用 `thread.activeRunId` 或最新 Turn 替代。
4. 对本实现产生的 request snapshot，`linkedMessageId`、`sourceMessageId`、threadId、
   turnId、teammateId 必须对应真实来源；复用现有 input snapshot / source anchor
   校验。缺失或损坏时不补造 owner、不借另一个私聊消息的 source。
5. Run.workUnitId、WorkUnit.linkedRunId、workspace/participant 及对应 Attempt 的
   workUnitId/runtimeInstanceId/fencingToken 都必须一致。
6. 只读取这个 owner/Turn/Run 的 proof 和叙述；其他 Agent、频道或 sibling Turn 的
   waiting/terminal 记录不能满足条件。问答 requestId 由同 Turn canonical anchor 找到。

owner 不成立立即返回 indeterminate，不再扫描外部内容来“补齐”结果。

## 5. 分类与证据要求

分类结果至少区分 `active`、`logical_wait`、`terminal`、`indeterminate`。
`logical_wait` 带具体 proof kind/identity/revision；它不是任务成功，也不是授权凭证。
`pending` 是现有消息存储状态，不等同于“已证明安全暂停”。

### 5.1 正在运行、排队或正常持有审批

Run / WorkUnit / current Attempt 的 owner 与有效执行 fence 一致时，消息保持 pending。
活的审批等待仍须读取对应 approval、checkpoint、basis；不能因为 Run 字符串是
waiting 就承认一个 orphan 或异主的审批。没有进程记录不等于可释放执行权。

### 5.2 审批暂停：approval_wait

在同 snapshot 核对真实 `commitApprovalResumeSuspension` 对应的组合：

- Run、WorkUnit 均为 `waiting_for_approval`；checkpoint 为 pending 或 approved。
- approval ID、Run ID、toolCallId、actionType、checkpoint 对应字段完全一致。
  approval 状态与 checkpoint 相容，不把已拒绝/过期/取消审批当待恢复。
- `resumeBasis` 通过现有 schema/fingerprint 校验；basis.workUnitId 与 Run 一致，
  `priorAttemptId` 指向原暂停 Attempt，工具 side-effect fingerprint 与 approval 相符。
- 暂停 Attempt 为 `lost`，有 endedAt，`errorCode === runtime_suspend`，其完整 fence
  与关联 runtime suspension audit/checkpoint 一致；当前 activeAttemptId 不指向别人。
- checkpoint revision 与上述已提交审计来源相容；不能只用 revision 大于某个常数
  或只有 `errorMessage` 包含 suspend，就认作真实暂停。

分类为 `logical_wait/approval_wait`：保留正文、segments、原 message ID、linkedRunId
和 Turn，message pending、无伪失败。`signal.aborted` 仅描述 transport/runtime 状态。

### 5.3 审批恢复派发前暂停：resume_pre_dispatch

这是另一合法形态，不能套用 waiting_for_approval：Run / WorkUnit 为 running，
checkpoint 为 `resume_pending`，approval 为 approved。原审批 basis/side-effect
lineage 仍须成立；暂停 Attempt 必须取 `checkpoint.runnerResumeHandle.attemptId`，
而不是借 basis.priorAttemptId 或线程最新 Attempt。

验证 handle kind/runner/run/Attempt 的闭合归属、当前 WorkUnit 指针、Attempt 的
lost/runtime_suspend/endedAt、对应已提交 suspension audit 和 revision。
成立则 pending，表示恢复尚未完成；不意味着命令已执行，也不得触发再次工具派发。
handle 目前 mapper 只是 JSON cast，不能把存在 handle 当作通过 runtime validation。

### 5.4 已提交的必答问答 yield

真实 `getUserInputRequest(threadId, requestId)` 与 `getUserInputWait` 读取结果共同构成
输入证据；复用其 request/source/checkpoint hash、fingerprint、version、revision、
水位和时间校验。还必须核对：

- required request 为 pending 或 answered；wait 为与原 source 仍等待相容的 waiting
  或 resuming，不把 blocked/cancelled/resumed 当“仍在等用户”。answered 不等于已续跑。
- 原 Run / Attempt 都为 yielded；WorkUnit 为 waiting_for_input，activeAttemptId 已清；
  unit/run 双向 link 和 source.fence 的完整四元组对应原关闭执行。
- source workspace、private participant、canonical thread/Turn/item、task binding、cwd
  均匹配；run/attempt endedAt 与 checkpoint.quiescence.stoppedAt 一致。
- canonical question anchor、requestVersion 和已提交 lastRunEventSeq 属同一原 source；
  不把 successor 的事件水位或 fence 借给旧问答。wait 真正进入后继运行时按后继 lineage
  分类，不要求已接管的新 Attempt 继续满足原 waiting source 形态。

不能用 `findRequiredUserInputForAttempt` 寻找 committed wait：该方法只找
`wait_status IS NULL` 且要求 current owner，yield 后 activeAttemptId 已清。
`getUserInputWait` 证明提交后的 checkpoint，不是允许 UI 再执行一次 commit。

### 5.5 unknown / 损坏 proof / 未排空 writer

typed yield、Runner Promise settled、内存 activeRuns 为空、HTTP 断开，都不是安全
暂停证明。例如真实 required receipt 后有未配对 durable tool_start，Core 会拒绝
quiescence commit；Run/WorkUnit 和原 fence 必须仍被保留。

这种情况分类为 indeterminate，保留现有持久消息与 blocker，记录范围受限的诊断，
不得伪装 `logical_wait`、ready 或完成。原消息为 pending 可继续保留 pending，
但内部不能宣称“安全等待”，更不能在此释放 lease/Attempt、清 blocker、重启工具。
损坏的历史 failed 消息也不能在无 proof 时自动重置成 pending。
有效独立 terminal 事实可以收口已结束的后继执行；过期历史 checkpoint 不得反向
覆盖它。若当前 terminal 本身归属/状态矛盾，则仍为 indeterminate。

### 5.6 派发前真实取消的窄终结

取消入口可能已真实终结 `teammate_direct_reply` WorkUnit，但尚未创建 Run。
这不是允许 pre_dispatch 写任意 cancelled：Core reader 必须验证原消息、native
thread、canonical source/Turn/input snapshot 与 WorkUnit request 的完整归属；
WorkUnit 必须 cancelled 且有 endedAt。有 Attempt 时还须为真实 cancelled 且完整
fence 相符；没有 Attempt 时须无派发记录。仅此观察可用 reconcile 收口 cancelled。
GET 和有界启动修补复用同一 Core 事实，不创建 Run、不重派工具、不改历史。

## 6. 写入、SSE 与旧 callback

`store.readSnapshot` 使用 query_only，是只读事务。不得在其中调用 runtime updater，
也不能在 snapshot 返回后以原来的 `WHERE id = ?` 无条件写入。
持久更新必须经 Core 短写事务：重验同一 observation 的 message identity/link、owner、
Run/WorkUnit/Attempt 状态与 fence、相关 proof identity/revision，再条件更新。
有变化则拒绝旧 patch并重新读取/分类；不得静默跨新 Attempt 重试旧正文。
幂等命中同值不更改 updatedAt、不重复发布 invalidation。

live projection 在 writeReady 时捕获原 Run 与 Attempt 的完整 fence。每个叙述、错误、
ready、delta、settlement callback 的写入均需重新核对 captured fence 和当前 message link：

ready producer 必须携带它自己已捕获的完整 sourceFence；projection 缺少该payload，
或它与同 snapshot 的当前 Attempt 不一致时直接 no-op，不能从“最新 Attempt”反推权限。
排队仅传真实局部 Attempt 身份；duplicate caller 没有原 producer 权限，不伪造 fence。

- 原 Attempt 已 lost/yielded、已终结、或 successor 已取得执行权时，旧 callback no-op。
- 原消息已取消/终结/被替换时，不能被晚 delta 改回 pending，也不能覆盖新正文。
- 恢复后收口由 Host reconciler 根据当前持久事实完成，不借旧 Runner callback 的权限。
- live Promise settlement/catch 还须匹配它原先捕获的完整 Attempt fence；当前已换
  successor 或从未捕获 fence 时只读返回、不做 reconcile、不发终结帧。
  Host terminal/recovery入口不借旧 fence。
- catch 路径也须先分类/核 owner，不能将所有 abort 或异常无条件写 blocked。
- transport close 后不再向 response 写任何事件，但持久分类/收口仍正常执行。

`logical_wait` 与 `active` 的消息保持 pending，不调用 onDone 或 onBlocked；
关闭/结束 HTTP 传输本身不发送 done/error/blocked 的业务终结帧。
只有可信 terminal 分类才走最终 onDone 或原终结失败/取消语义；取消不是暂停。
indeterminate 仅记录诊断，不因旧 `else -> onBlocked` 伪终结。

## 7. 真正恢复后的 terminal reconciliation

原 `createAiTeammateDirectReply` Promise 暂停后已返回，恢复成功不会再进入它。
所以“暂停不误 failed”只是前半条链，不能到此验收。

1. 普通执行、审批恢复/拒绝、daemon recovery 的 afterRunTerminal 都调用同一
   私聊 reconciler；复用 router/index 现有共享入口，非私聊 Run 立即 no-op。
2. 以 terminalRun identity 定位其原 linkedMessageId，并重新装载完整 snapshot；
   不用 teammate 最新消息，也不为恢复创建第二条私聊回复或新 Turn。
3. 验真实 Run、WorkUnit 与最终 owning Attempt 的终结一致性；审批恢复还核当前
   checkpoint/continuation 终结 lineage。不能因 endedAt 或有最终叙述就视为 succeeded。
4. succeeded 使用同 owner durable narration：有正文或真实 generated media 才 ready；
   空正文且无 media 保持现有本地化 empty-result failed 语义。真实 failed、cancelled
   保留既有诊断和取消含义，不能为消掉红色错误而改成功。
5. 在短原子校验/条件更新后发布已有私聊 view invalidation。重复 hook、重复审批、
   重启扫描幂等，不重复正文、不重复消息、不重跑工具。
6. 若 terminal 已提交而进程在私聊更新前崩溃，下一次恢复对候选 linked pending 消息
   做有界幂等 reconciliation；GET 同时有只读事实投影兜底，不依赖旧 SSE/Promise存活。
   不全库轮询、不启动新的执行，不擅自批量迁移旧失败历史。
   首次 message link 尚未提交时，Core 需按原 linkedMessageId 定点核验唯一 canonical
   WorkUnit/Run；不能仅因 message.linkedRunId 为空就将已派发操作当作 pre_dispatch。

GET 与 live 最终 DTO 使用同一 classifier / narration projection：同 owner、同正文、
同状态，GET 不偷偷写数据库或启动恢复。持久状态最终一致由 Host reconciler负责。

### 7.1 真实恢复验收暴露的既有接缝

- Harness 审批恢复在 coordinator claim 成功时已拥有 target Attempt；Daemon 需在异步
  Runner preflight 前绑定该数据库 Attempt 的完整 fence 与 continuation。否则停机抛错时
  attempt 仍为空会落 generic WorkUnit failed，造成 Run running / WorkUnit failed 的分裂。
  停机在真实 tool_start 之前可用现有 `resume_pre_dispatch` 原子提交；有当前或无法归属的
  durable tool_start 则不得证明安全暂停、释放并重放。Core 在短事务内重核工具边界。
  成功暂停返回原 Run id，而不是 undefined，避免 coordinator 将物理返回当派发失败。
- HTTP 人工拒绝需和启动恢复一样接现有 `finalizeSuspendedApprovalDenial`。
  live 原 Runner 仍自行观察 durable denied；仅真正 suspended owner 由严格终结器收口。
- 私聊状态收口后的 invalidation 使用现有 `runs` 域：当前 UI 的 `teammates` 域仅刷新
  队友列表，不刷新已选私聊。无需新增 Desktop 协议或另建 UI 数据流。

## 8. 实现顺序与验收矩阵

顺序：保留业务 RED -> lifecycle reader/classifier -> guarded write 与旧 callback准入 ->
live / GET 接线 -> terminal/recovery reconciler -> 全文件及邻近回归 -> 独立审阅。
不并入 A27 权限轴修改；不以此文档代替产品实现、测试通过或 packaged GUI验收。

| 路径 | 必须证明的行为 | 证据方法 |
|---|---|---|
| 现有两项 approval shutdown | 同 message/Turn pending，checkpoint真实推进，无伪terminal SSE | 保留两项 RED，真实 index stop + SQLite reopen + GET |
| 现有四项 terminal控制 | 成功/失败/空成功/用户取消不退化 | 原六例完整运行，不删断言 |
| bash审批恢复终结 | 同消息从pending到ready或真实失败，工具exactly once，重复恢复幂等 | 真实请求->shutdown->重启->HTTP approve->Host工具->terminal事务 |
| resume_pre_dispatch停止 | running形态下lost/runtime_suspend仍pending，不重复派发 | 真实coordinator/claim/suspend事务 barrier，不手写status |
| committed required yield | 原owner/Turn pending、问答水位正确、刷新一致 | 内部opt-in真实receipt/PiRunnerYielded/Core commit |
| 未配对durable tool evidence | 无wait proof，不冒成功/安全等待，不释放原fence | 复用user-input-pause-production的真实quiescence拒绝路径 |
| 损坏/异主/过期proof | 不借其他Agent/Turn/Attempt，不伪ready或修历史 | 有限定向负例，真实Store边界校验 |
| 晚callback与接管竞争 | 旧delta/error/settlement不能覆写successor或取消状态 | 原captured fence，真实接管/终结后再投递旧callback |
| terminal落库后崩溃 | 重启或只读GET能找回正确状态，持久收口幂等 | 真实terminal先提交、reopen、不依赖原Promise |

恢复测试不能给当前 read-shutdown fixture 直接 approve 后期待成功：
`ApprovalResumeCoordinator.resumeAfterApproval` 目前明确只支持 payload.type=bash，
且 Runner 必须声明对应 hostApprovalContinuation。应新增独立 bash fixture，用 owned
marker 的 Host 副作用次数验证 exactly once；不调用手工 markRunSucceeded伪造结果。

默认私聊 HTTP 当前未打开 `enableUserInputPause`；公开
`user_input_answer` continuation 仍由 orchestrator 返回
`user_input_continuation_coordinator_required`。本 slice可用已存在的内部opt-in生产执行链
验证 committed yield，但不能据此宣称公共问答完整续跑已完成，亦不为测试绕过409。

## 9. 决策、风险和完成门槛

本 slice 无待用户决策：采用已授权的原子事实、同owner/Turn、暂停非终结、恢复同消息、
无proof不放权原则。实现细节和以下验证仍待完成，不算产品决策已验证：

- 新 guarded write 必须在 Core 边界成立；只加 Daemon if检查不抵御跨进程竞争。
- terminal hook 不能只接普通路由而漏审批恢复/daemon recovery；也不能仅修GET掩盖SQLite。
- 新 lifecycle模块保持职责聚焦，不进一步扩大 direct-replies.ts/router/index大文件逻辑。
- read的暂停通过不代表所有工具可恢复；内部yield通过不代表公共问答coordinator已接通。
- 本地目标测试通过与真实macOS packaged验收分开记录；主CI停用不反复查询或等待。

完成门槛：既有六例及新增真实恢复/proof/late-callback回归通过、SQLite/GET/live结果一致、
无重复工具效果、独立审阅无未处理的本slice阻断问题。到此才可称A28实现完成；
不自动等同E6总体完成、正式发布或Office全量审核通过。

## 10. 实测后补充：已 claim 的 preparation 与未知工具效果

新六例首跑证明 HTTP deny 没有调用已存在的 suspended-denial terminal owner；
另在真实 resume claim 后立即 shutdown，异步 preflight 先失败而局部 target Attempt 尚未
绑定，generic catch 只失败 WorkUnit、Run 仍 running。修复必须在异步 preflight 前绑定并
校验真实 claim 的 full fence/continuation；调用已有原子 suspension，不能手写 Run/WU。

Daemon 的“未看到 tool_start”只读预检不能作为跨连接最终保证。
Root 新增真实 claim + durable tool_start 的 Core transaction 负例，首跑拒绝断言失败；
因此 `commitApprovalResumeSuspension(resume_pre_dispatch)` 必须在自己的写锁中再查
当前 target 的 durable start（无归属 start 也拒绝）。已有 effect 不能被标成安全重试，
拒绝时保留原状态、checkpoint revision、资源和未知效果事实。

live Promise settlement 显式要求原捕获 fence；缺 fence 不能因参数 undefined 借用 Host
reconciler 权限。Host terminal/recovery 仍按当前持久事实收口。完整 fence 不匹配时只读，
不写 CAS、不发 terminal 帧。产品源码、局部测试及真实 packaged GUI 验收继续分开记录。
