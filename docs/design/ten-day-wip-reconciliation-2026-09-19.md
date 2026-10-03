# 十几天主线与 WIP 清算记录（2026-09-19）

## 目的

这份记录固定本轮实现的基线和边界，避免把已经进入本地 `main` 的内容重复搬运，
也避免把当前脏工作区中的旧结构误删或直接混入新主线。

## Git 基线与保护边界

| 项目 | 值 |
| --- | --- |
| 新开发分支 | `codex/ten-day-wip-cleanup` |
| 新分支基线 | `main@fa7783b9a2437d8e0ffa6be99d5a31b7b3decdfb` |
| 新分支 worktree | `/private/tmp/ling-stack-ten-day-wip-cleanup` |
| 原 WIP 分支 | `codex/retry-report-supersession@8b259da0ff4302b97c69f9ef65e221fd108e0ee0` |
| 原 WIP 工作区 | `$HOME/ling-stack` |
| 原 WIP 快照 | 71 个工作区条目：62 个已修改/删除，9 个未跟踪 |
| 远端操作 | 本轮未 push、未合并远程 PR、未改远程 `main` |

原工作区只作为证据和回溯来源，不在其上切分支、reset、clean、批量 stage 或提交。

## 已经在本地 main 的内容

以下主线不再从原 WIP 复制：

- Continuity / typed transcript / canonical timeline；
- 普通会话、队友私聊、频道共享 Timeline 投影；
- ExecutionAction、tool evidence、source refs、batch/disclosure；
- Harness durable continuation、Attempt fence、restart recovery；
- 自动审批、审批恢复、命令规则；
- TerminalReport 原子 evidence、retry/failure lineage；
- 多 Agent fan-in 与 evidence 校验；
- 频道工具 allowlist、命令审批设置和普通会话审批投影基础；
- 相关 localization、根 `package.json` 与设计文档。

原 WIP 中下列未跟踪文件与 `main` 内容完全一致，视为重复副本，不得再次移植；其中
`RuntimeApprovalDialogQueue` 是基线中已经被后续 Composer 设计取代的旧实验，不作为新入口：

- `apps/web/src/features/approvals/RuntimeApprovalDialogQueue.tsx`
- `apps/web/src/features/workspace/ChannelExecutionProposalEditor.tsx`
- `apps/web/e2e/ui2-channel-proposal-input-migration.spec.ts`
- 五份 Codex/typed-transcript/harness/sandbox 设计文档

## 尚未完成、需要在新分支继续的内容

### 1. 三种会话审批入口统一（本分支已开始修复）

基线 `main` 的真实接线是：

- 普通会话误接到 `RuntimeApprovalDialogQueue`；
- 频道和队友私聊仍使用 `RuntimeApprovalComposerGate`；
- 旧 `ConversationDecisionGate`、`RuntimeApprovalComposerGate` 和
  `ChannelExecutionProposalComposerGate` 仍然存在；
- `ChannelExecutionProposalEditor` 已存在，但与当前 typed timeline 的频道提案投影尚未
  完成闭环。

本分支已将普通会话切回 `RuntimeApprovalComposerGate`，并删除仅剩的旧
`RuntimeApprovalDialogQueue` 实现。三种会话现在复用同一个 runtime approval gate 和唯一
control owner；频道仍保留多 Agent 参与者语义，不把频道专属 proposal 误投影到普通会话或私聊。

这里不再引入全局 approval Dialog：它会抢焦点、改变 Composer 高度，并与 Codex-style
session-owned gate 及已有回归合同冲突。真正的 blocking approval 仍只在 owning session
的 Composer slot 展示。

### 2. 频道提案决策入口审计

原 WIP 的 `ChannelExecutionProposalDialog.tsx` 在 `main` 中不存在，不能直接恢复。现有
`ChannelExecutionProposalComposerGate` 已经复用 `ConversationDecisionGate`，并且频道回归合同
明确要求 proposal 只替换 owning channel 的 Composer。新分支不重新引入中心 Dialog，避免和
runtime approval 形成两个 control owner；后续只补齐 proposal 的 stale/concurrent decision、
cancel 和 participant isolation 回归。

### 3. 旧结构删除的处理原则

原 WIP 删除了以下文件，但新分支暂不直接删除：

- `apps/web/src/features/approvals/ConversationDecisionGate.tsx`
- `apps/web/src/features/approvals/RuntimeApprovalComposerGate.tsx`
- `apps/web/src/features/workspace/ChannelExecutionProposalComposerGate.tsx`
- `apps/web/src/lib/runtime-approval-ownership.ts`

这些删除只有在全部消费者迁移到新共享入口、类型检查和 UI 回归通过后，才作为单独提交执行。
它们目前在 `main` 中仍是有消费者的真实代码，不是可以凭“新设计”直接判定为废弃的文件。

## 本分支执行顺序

1. 先审计 approval/dialog 的真实 route → projection → renderer → decision endpoint 链，锁定
   三种会话的 owner、scope 和状态映射。
2. 以 `RuntimeApprovalComposerGate` 为共享外壳，确保普通会话、队友私聊和频道 runtime
   approval 接入同一 decision shell；
   不改变 daemon approval contract、SQLite 事实或 policy 语义。
3. 保留频道 proposal 的 Composer 接线并接入当前 `ChannelWorkflowProposalCards`，保留 proposal 与 runtime
   approval 的边界，补齐 stale/concurrent decision 和 participant isolation。
4. 只删除无消费者的旧 Dialog 文件；共享 ComposerGate、DecisionGate 和 ownership resolver
   不是旧骨架，不能因为“统一”而删除。
5. 运行 Web typecheck、相关单测、频道/私聊/普通会话 E2E；然后再做 macOS packaged GUI
   验收。逻辑测试通过不等于 packaged GUI 已完成。

## 完成门槛

- 三种会话只有一个可见的 approval control owner；
- 普通会话、私聊、频道都支持相同的 allow-once / allow-similar / deny / cancel 语义；
- 频道 proposal 仍严格限定在 owning channel 和 owning participant/run；
- approval、retry、SSE reconnect、daemon restart 不产生重复 action 或幽灵 pending；
- 所有事实来自 Host/daemon evidence，不能用 ready 文本、batch 数量或 UI 摘要判定完成；
- Web/Daemon 回归全绿，并完成真实 packaged macOS 案例后，才允许创建 PR。

## 不变边界

- 不改原 WIP 工作区；
- 不把原 WIP 中同名重复文件再次复制到新分支；
- 不直接修改远程 `main`，不自动合并或推送；
- 不用删除旧组件来掩盖尚未完成的接线；
- 不把 mock、fixture、build 或 reasoning summary 当作真实 macOS 验收证据。

## 本分支首个修复证据

变更：

- `ConversationHome` 改为与频道、队友私聊共享 `RuntimeApprovalComposerGate`；
- 普通会话重新把 `composerGateApprovals` 传给 Timeline 的非交互等待标记，避免重复审批卡；
- 删除无消费者的旧 `RuntimeApprovalDialogQueue`；
- 没有修改 Daemon/API/SQLite approval contract。

验证结果：

- Web typecheck：通过；
- Web 单元测试：338/338 通过；
- 普通会话审批 E2E（Allow once、Allow similar、Deny）：通过；
- 队友私聊审批 E2E（Allow similar、归属隔离）：通过；
- 频道 task proposal 与 runtime approval E2E：3/3 通过；
- Web UI 边界 lint：通过；
- 真实 packaged macOS、daemon restart、SSE reconnect 尚未在本记录中宣称完成。

## 当前未决判断

`sidebar-approval-proposal-dialogs-implementation-plan.md` 仍保留“频道 proposal 使用中心 Dialog”的
历史切片，但 `conversation-surface-contract.md`、`inline-runtime-approval-detailed-design.md` 和
现有 Playwright 合同都规定 proposal 使用 owning channel 的 Composer decision shell。为避免再次
出现两个 control owner，本分支暂以后一套为准：runtime approval 与 task proposal 都在共享
Composer slot 决策；只有在产品明确重新选择全局 Dialog 后，才另开设计变更，不在本修复中偷偷切换。

## 清理授权后的最终边界（2026-09-19）

用户已确认“以最新设计为主，旧实现可以清理”。这项授权只覆盖已经能证明被新设计取代的
WIP，不等于把所有 71 个工作区条目整体丢弃。

### 可以直接清理的 9 项

以下内容只存在于原 WIP 工作区，且已经被当前主线或 Composer-owned 设计取代：

1. `apps/web/src/features/approvals/RuntimeApprovalDialogQueue.tsx`：全局审批队列，
   被 owning session 的 `RuntimeApprovalComposerGate` 取代。
2. `apps/web/src/features/workspace/ChannelExecutionProposalDialog.tsx`：中心频道提案
   Dialog，会产生第二个 control owner，被频道 Composer decision shell 取代。
3. 原 WIP 中与 `main` 逐字相同的 7 个重复副本：
   - `apps/web/e2e/ui2-channel-proposal-input-migration.spec.ts`
   - `apps/web/src/features/workspace/ChannelExecutionProposalEditor.tsx`
   - `docs/design/conversation-codex-parity-visual-spec.md`
   - `docs/design/conversation-codex-style-transcript-implementation-plan.md`
   - `docs/design/conversation-typed-transcript-detailed-design.md`
   - `docs/design/ling-harness-gap-closure-implementation-plan.md`
   - `docs/design/platform-native-sandbox-v1-implementation-plan.md`

删除这些原 WIP 副本不会删除最新 `main` 中的对应内容；它们只是旧工作区里未被跟踪的
重复文件。执行前应保留可恢复快照，清理后用 `git status` 和路径哈希复核。

### 不能删除的 4 项

原 WIP 对以下共享组件的删除属于错误替代实现，应恢复到最新主线，而不是继续保留删除：

- `apps/web/src/features/approvals/ConversationDecisionGate.tsx`
- `apps/web/src/features/approvals/RuntimeApprovalComposerGate.tsx`
- `apps/web/src/features/workspace/ChannelExecutionProposalComposerGate.tsx`
- `apps/web/src/lib/runtime-approval-ownership.ts`

它们仍有真实消费者，并且是三种会话统一审批 UI 的基础。删除它们会直接违背当前设计。

### 不能整体丢弃的内容

原 WIP 中其余已跟踪修改不能按“旧”一次性回滚：其中混有频道提案并发/取消回归、
Codex 风格 transcript 投影、Full Access/Permission Preset 和 UI 验收用例。它们必须逐文件
对照最新 `main` 重新移植；不能用一次大合并掩盖不同设计的冲突。

## 与最新设计的冲突核验

当前清理分支基于 `main@fa7783b9`，与最新设计的核心边界一致：

- 三种会话共享同一 Composer-owned runtime approval gate；频道只额外保留多 Agent/提案语义。
- 事实来自 Host/daemon evidence 和 canonical timeline，不能用 ready 文本、batch 数量或
  UI 摘要判定完成。
- TerminalReport publication 与 workflow settlement 分离，harness 等公开 API 的真实报告，
  不放宽 daemon 的 fail-closed 规则。
- 不恢复全局 Dialog、不恢复旧 generation 全量重发布、不替换 workspace 根配置。

因此，本分支当前 3 个实现提交与最新设计没有结构性冲突；冲突只存在于原 WIP 的旧替代方案。

## 剩余工作量（不是 71 项功能）

清理后剩余 **5 个实现/验收闭环**，外加一次 PR 落地：

1. **频道提案闭环**：stale/concurrent decision、cancel、participant isolation，以及
   Composer proposal shell 的完整回归。
2. **Codex 风格 transcript 生产接线**：`tool_start/update/end` 折叠为稳定 action，
   command/exploration batching、activity summary 和 source refs 在三种会话及子 Agent
   统一 renderer 中真实落地。
3. **三种会话真实 GUI/CUA 验收**：普通会话、队友私聊、频道，核对审批、叙述、命令、文件
   变更、复制和收尾摘要的统一展示。
4. **Full Access / Permission Preset 真实验收**：设置入口、审批策略、Allow once / Allow
   similar / Deny / cancel 的真实浏览器与 macOS packaged 流程。
5. **恢复与发布复核**：PR/CI、远端 `main` hash、SSE reconnect、daemon restart、fan-in 和
   TerminalReport lineage 的最终回归；Windows 原生沙盒不计入本轮 macOS 完成门槛。

最终完成条件仍是：上述 5 个闭环均有源码/测试证据，且至少有一次真实 packaged macOS
GUI 证据；否则只能称为“设计完成”或“逻辑测试通过”，不能称为整体完成。

## Packaged Continuity 剩余失败的根因与处理

第一次修复 restricted-command helper 后，packaged harness 的最后一个失败是：

```text
terminal_reports: {"reports":[]}
```

这不是 fallback 报告被 SQLite 的 `effectiveOnly` 逻辑过滤，也不是 packaged daemon
没有写入报告。对失败包留下的同一份数据库做了三层核验：

1. `ling_terminal_reports` 已有一条 `status = 'fallback'`、`outcome_status = 'succeeded'`、
   `result_item_id` 非空的 workflow 报告；
2. 对应的 `conversation_items` 已有 `kind = 'terminal_report'` 且 payload 的 `reportId`
   与报告一致；
3. 使用当前 `SqliteRunStore.listTerminalReports({ channelId, effectiveOnly: true })`
   直接读取同一数据库可以得到该报告；现有 daemon API 回归也覆盖 committed/fallback 和
   generation 过滤。

实际时序是：workflow 的 Host completion gate 先提交 `succeeded`，随后
`maybeScheduleWorkflowTerminalReport` 异步执行 evidence barrier、synthesis/fallback 和
publication。因而 workflow endpoint 已经是 `succeeded` 时，terminal-report collection
短暂返回空集合是合法的中间状态；几百毫秒后报告才从公开 API 可见。原 packaged harness
把这个中间状态误判成永久失败。

处理方式是只改验收等待边界，不放宽 daemon 的 fail-closed 规则：harness 在 workflow gate
成功后轮询 terminal-report collection，直到公开 API 返回唯一的 succeeded report，再继续
检查每个 run 的 `tool_start/tool_end`、terminal item lineage 和 SQLite integrity。这样既
保留真实异步 publication 语义，也避免用“数据库最终会有记录”替代用户可见 API 证据。

本次对应修改：

- `apps/desktop/tests/run-packaged-continuity-smoke.mjs`：增加 terminal report publication
  的有界等待，并明确 workflow settlement 与 report publication 是两个 durable 步骤；
- daemon/core 源码没有为绕过验收而放宽 `effectiveOnly`、fallback 或 eligibility 规则；
- 现有 `packages/daemon/test/terminal-report-api.test.mjs` 已验证 fallback 报告可公开读取、
  developer-only synthesis metadata 会被剥离、历史 generation 只返回最新有效版本。

## Packaged macOS 验收结果

修正 harness 后使用真实 packaged app 重新运行：

- App：`$HOME/Applications/Ling Stack V3 TenDay QA Fixed.app`；
- Artifact：`/private/tmp/ling-v3-ten-day-qa-package-fixed/Ling-Stack-fixed-macos-arm64.zip`；
- 报告：`/private/tmp/ling-v3-ten-day-packaged-continuity-fixed-2/report.json`；
- 结果：`status = passed`，macOS arm64，真实 packaged daemon/app 流程。

已通过的检查包括：

- packaged app 启动、daemon readiness、release migration rollback/recovery；
- SSE disconnect/reconnect，reconnect replay 到 `ready`；
- 两个 required participant 的 workflow completion gate `verified`；
- terminal report 公开 API 返回唯一 succeeded report，且 `terminal_report` item lineage 正确；
- 每个 run 都有真实 `tool_start` 与 `tool_end` evidence；
- naked-ready 被 `required_operation_evidence_missing` 阻断；
- workspace default provider 缺失被阻断且无 workflow/run/side effect；
- restart safe checkpoint、no-checkpoint interruption、effect-unknown approval recovery；
- daemon restart 后 canonical replay 幂等、无重复 user item；
- SQLite foreign-key/integrity、workflow/step/run/evidence/report/result-item lineage 全部通过。

这次结果只证明当前 packaged 连续性与恢复链路已经达到本分支的验收门槛，不等于根工作区
原有 71 项 WIP 已经全部移植或解决；根工作区仍保持原样。

## 原 WIP 审计结论（不自动接入）

逐文件将原工作区内容与本地 `main` 比较后，发现：

- 多数未跟踪文件是 `main` 的逐字重复副本；
- 其余 UI WIP 包含将三种会话切回全局 Dialog、删除 ComposerGate，以及把
  `composerGateApprovals` 改名为 `dialogOwnedApprovals` 的整套替代方案；这与当前
  Composer-owned contract 冲突，本轮不移植；
- `packages/daemon/src/features/channels/terminal-report-coordinator.ts` 的 WIP 会在恢复时
  逐条重新发布所有 committed/fallback report，并删除“同一 source 只恢复最新 generation”的
  回归测试。这会重新引入旧 generation 重复结果，属于回退，明确不接入；
- 原 WIP 中删除 `ConversationDecisionGate`、`RuntimeApprovalComposerGate`、
  `ChannelExecutionProposalComposerGate` 和 ownership resolver 的动作，均没有满足消费者清零
  和新 adapter 证据，明确不接入。

因此本轮只提交了可验证的审批接线修复；其余 WIP 继续留在受保护的原工作区，等待逐项审计，
不会用一次大合并掩盖不同设计之间的冲突。

## E6 后续核对：N05 操作图与审批边界

截图 `N05 clean exact repro` 中，Ling 反复要求 `sourceQuote`，并明确“尚未开始执行”。
这不是命令已运行后的 UI 丢证据：选择器可以解析模型返回的外层 JSON，但模型输出的
`execution.operations` 缺少 v2 必需字段。Host binder 正确拒绝非来源绑定操作图；
原选择器没有针对这个结构错误的有界修复请求。

在独立、完整的 checkout 中，只给 `execute/workflow_proposal` 的非法 v2 图一次模型修复
机会，修复结果仍由同一个严格 Host binder 验证。修复失败、变成普通回复或伪造引用时，
保留原图并走结构化 clarify，不会以模型文本宣称已执行。专项回归覆盖“第二次合法图可进入
绑定”“第二次伪造 `sourceQuote` 仍被拒绝”及“重复坏图最多只请求两次”；
操作绑定、来源、能力阻塞四组定向回归合计 49/49 通过，Daemon 编译通过。
全量 Daemon 测试启动后有多组 API 用例长期未结算，已停止本次测试运行，不能
记为全量通过。原 `/private/tmp` 实施
快照有 3,692 个已追踪文件缺失、107 个已修改文件，不能把它当可构建的完整 worktree，
也不能将这些缺失文件当成待删除代码；旧根工作区 WIP 未动。

“允许类似命令”需另按安全边界验收：`node -e` 可执行任意脚本，Host 的可复用前缀
候选不会为它生成规则；Engineer 标准 profile 的 `requiredForTools: ["bash"]` 还要求
逐次审批。不能为达到 UI 截图效果而绕开 profile 或把 `node -e` 变成宽泛的持久规则。
使用 `node --test` 等受限候选复核时，还需明确标准 profile 是否允许规则抵扣逐次审批，
再同时验证第二次匹配、不匹配、拒绝、重启与 SQLite rule lineage。

这一节仅记录隔离 checkout 的源码/逻辑测试进展，不表示修复已合并到实施分支，也不表示
新的 packaged macOS GUI 已验收。E6 的视觉矩阵、SSE reconnect、daemon restart、
Allow similar 正反例及 TerminalReport generation 显示仍须按同一新包逐项留证。

频道 retry 报告的 generation 另有显示层错误：旧 UI 对
`reportId:evidenceFingerprint` 的最后一段调用 `parseInt`，字母开头时默认为 1。
现改用同 workspace/channel/thread/turn 下已提交的 canonical `terminal_report`
Item，并交叉核对报告 ID、来源、evidence fingerprint、outcome；缺失或冲突
不显示猜测的代数。Web 全量 348/348、类型检查及独立 lineage 测试 3/3 通过。
这仍是源码验证，不是当前隔离 checkout 的新 packaged GUI 证据。

### E6 packaged GUI 实测追加：原 N05 循环已绕过，但完整链路未通过

在隔离数据目录 `/private/tmp/ling-e6-safe-smoke-kl5rqs` 的 packaged macOS 客户端中，
以真实 `gpt-5.6-sol` 预设、Designer/Engineer 成员和 UI 发送同类 N05 请求：

- 旧 smoke 工作区的请求不再重复提示缺少 `sourceQuote`，进入两步工作流；Designer
  完成，Engineer 的 `node -e` **未运行**。Host 返回 `command_stop_unconfirmed`，
  SQLite 的 `host_command_settled` 显示该工作区先前的命令因 `cancelled` 进入
  `stop_unconfirmed`。这是持久安全阻断，不得为测试清除或绕开。
- 新建独立目录 `/private/tmp/ling-e6-n05-clean-T30H9N`，频道
  `channel_b0f83b3e-2b53-4f3a-aa0a-7c61e9568f7b` 绑定这个目录，原成员关系
  逐项保留。UI 自动化输入中文时，“检查”的首字移到消息末尾；这需要另以人工键盘
  复现，当前不能断言是产品输入法缺陷，也不能称其为原截图的逐字复测。
- 新目录的 `channel_intent_decisions` 最终为 `reply/accepted`，原因包含
  `Intent model output was unavailable or invalid; fail-open to an ordinary reply`；
  因此 N05 的一次非法操作图修复逻辑未覆盖该回退路径。Ling 的普通回复内的旧式
  `<ling_task_proposal>` 被 `ai-replies.ts` 提取成提案，来源是 Assistant 回复 Item；
  没有与提案关联、Host 接受的 participant manifest。UI 仍显示“允许开始此任务”，
  点击后 `proposal-workflows.ts` 正确拒绝 `required_participant_manifest_missing`。
  截图为 `evidence/n05-clean-participant-manifest-failure.png`。这条审批失败不是
  用户没有按按钮，也不能通过合成 manifest 或放松确认校验来掩盖。

结论：新包的某条请求不再卡在原 `sourceQuote` 循环，但真实 GUI 双 Agent 命令、
fan-in 和最终报告**尚未通过**。下一步先修统一准入：从普通回复提取的旧式提案
必须经同一 Host 操作/参与者绑定后才能成为可确认提案；否则只作为叙述展示，
不可出现可点击但必失败的“允许”。同时为 `reply` 回退、无 manifest 提案及中文
输入顺序分别补测试，再在无旧 journal 阻断的独立工作区重跑 Designer/Engineer
真实命令、审批、stdout/exit、两方 evidence 与 TerminalReport。不能把现有 49/49
定向测试或 packaged continuity smoke 当成这条 GUI 验收。

### E6 后续修复：无来源清单提案与参与者职责

`ai-replies.ts` 原先要求普通回复输出旧式 `<ling_task_proposal>`，随后直接以 Assistant
Item 为来源写入 `ChannelExecutionProposal`。该提案没有绑定到 Host 接受的意图决策及
participant manifest，确认时必然被 `required_participant_manifest_missing` 拒绝。现在
普通回复不再生成这种提案；即便模型仍输出旧块，流式和落库的可见正文都会剔除它。
可确认提案仍只由结构化意图选择、操作绑定和 Host 决策创建。回归先证实旧代码下
两项失败，修复后覆盖流式回复、显式提及、模型意图解析失败回退三种入口，3/3 通过。

频道测试文件全跑还揭露了另一处清单错误：模型意图路径调用
`createParticipantManifest` 时漏传参与者的 `stepAction`，使没有任何操作的第二位
Engineer 被误判为 synthesis，绕过必需操作检查并形成 blocked 提案。现在传入已选定
的协作动作；“无操作的执行参与者需要澄清”与“审阅参与者可以提交可追溯输出包”
两项相反边界均通过，Daemon 编译和 `channel-workspace.test.mjs` 全文件运行退出码为 0。

这些是源码与测试证据，运行中的旧 packaged App 尚未更新。下一步必须重打包、在独立
工作区按真实模型/UI 重新发送双 Agent 请求，核对问题/审批、工具事件、两方证据和
TerminalReport；上面的测试绿灯不代表 E6 完成。

### E6 新包真实双 Agent 复测与报告展示缺口

在新打包客户端（`/private/tmp/ling-e6-packaged-gate-20260923/report.json` 的
artifact SHA-256 为 `51001811b61d9dd3c288c1691baa555bbe7c7088906de320ec8dbe671b13cb15`）
和隔离工作区 `/private/tmp/ling-e6-safe-smoke-kl5rqs/user-data/workspace`，通过真实 UI
插入 `@Designer`、`@Engineer` 并发送双 Agent 请求。频道为
`channel_be153c80-82f5-427b-a542-1b47b2a00e3d`，workflow 为
`workflow_6b200196-b9c0-4459-adf1-f7f5ec6189a0`。Designer 的审阅 Run
`run_4c7c03c7-cb04-48b5-8b5a-c7f3f9445024` 先完成；Engineer Run
`run_e89ab9eb-274f-4fc7-8914-08522b114789` 收到逐次审批，审批
`approval_c4f5dc43-688f-4291-90f1-b6d6fb8b02b4` 为 `approve_once`，未建立
`node -e` 的可复用命令规则。Engineer 的 RunEvent 含一组 `tool_start`、两条
`tool_update`（stdout `E6-QA-PROOF`、stderr 为 Electron codesign 警告）及
`tool_end`；真实命令 exit 0。两个 WorkUnit attempt 均 succeeded，workflow 2/2
步骤 succeeded，唯一 generation 1 报告
`terminal_report_d86cfd5f-5f61-4f39-89c4-e1d4a04e244b` 的结果 Item 已提交。
报告是 `deterministic_fallback`，不是模型生成总结；不能把 2/2 成功误写成完整
E6 矩阵完成。

真实 GUI 展开报告时另发现展示缺口：参与者 contribution 中的 Markdown 原样露出，
审批 `check/operation` 与成员 `workflow_step/run` 的不同来源链接直接平铺成同名
重复项。原子来源引用必须保留。共享 renderer 现把 contribution 交给 Markdown
组件，并将无文件路径的元数据来源默认折叠，仍可展开追溯；文件/diff 链接保持直接
可见。静态回归先红后绿，Web 类型检查、349/349 单测和 `git diff --check` 通过。
既有频道 `terminal-report-privacy.spec.ts` 原先找不到模拟报告：模拟的报告列表
没有对应的频道分页 committed Item，当前 generation 校验正确地拒绝猜测。现仅在
该测试 fixture 补齐真实报告所需的 `terminal_report` Item 及完整来源、指纹和
generation，不放松产品侧校验；普通、私聊、频道公开/受限 6 个用例及新增频道
Markdown/来源折叠用例共 7/7 通过。此修复发生在新一轮源码和浏览器模拟测试，
尚未重打包到正在运行的专用客户端，不能宣称视觉问题已在新包关闭。

### E6 报告展示修复的新包与验收边界

报告 Markdown、来源折叠和模拟频道报告 fixture 的修复已进入隔离构建：

- 分支 `codex/e6-safe-continuation`，构建时 HEAD `3ffd2681`，包含未提交 WIP；
- ZIP：`/private/tmp/ling-e6-ui-fix-20260924/Ling-Stack-0.1.2-alpha.1-macos-arm64.zip`；
- ZIP SHA-256：`b6955527da92afa6aba27c39ebb3953b4db6c39336372fc757fb9b325ff563d5`；
- 隔离 packaged continuity 报告：`/private/tmp/ling-e6-ui-fix-gate-20260924/report.json`，
  `status=passed`，14/14 checks passed。检查覆盖 release migration recovery、SSE
  disconnect/reconnect、required participant gate、真实工具事件与 TerminalReport lineage、
  naked-ready/missing-provider 阻断、safe/no-checkpoint/effect-unknown restart 和 SQLite
  integrity；这仍是 harness，不是新包的真实模型 GUI 视觉测试；
- Web 模拟报告隐私及 Markdown/来源折叠 E2E 7/7 通过。频道 fixture 现在含 committed
  `terminal_report` Item，生产侧 generation 校验未放宽。

仍须在此新包的**隔离 userData** 下打开真实客户端，核对报告 Markdown、元数据来源
默认折叠/展开、文件链接、旧案例恢复，并为 E6 十二类场景逐例保存 screenshot、
semantic-state、thread/run/attempt/action lineage、脱敏日志、build hash 和
`simulation=false`。运行中的旧客户端 PID `27305` 指向旧包，不可作为新修复的视觉证据。
远端 `main` 尚未成功刷新；在此之前不得声称本分支与远端最新代码一致，也不得以
上述 14/14 与 7/7 宣称 E6 完成或进入 PR/合并。

本次独立复核重新运行 `terminal-report-privacy.spec.ts` 7/7 和报告 generation / timeline
专项单测 8/8；Daemon 的操作绑定、来源和频道工作区三个测试文件 251/251，
`git diff --check` 通过。这些是模拟和源码回归，不会替代真实 GUI。真实新包 GUI
尚未复核：Cua Driver 按
`com.lingstack.desktop` 启动新实例时，LaunchServices 实际选中了工作树旧包
`apps/desktop/release/mac-arm64/Ling Stack.app`（PID `45724`，独立 userData
`/private/tmp/ling-e6-gui-20260924.QU8uoa/user-data`），而以新 `.app` 的绝对路径
作为名称启动返回 `APP_NOT_INSTALLED`；精确路径的另一电脑控制入口返回 Mac 已锁定。
此旧包探针不纳入新包证据，也未修改原测试客户端的数据。恢复 E6 时先解锁 Mac，
确认能精确启动新 `.app` 且验证进程 executable 路径，再采集新包 GUI 案例；不要
复用该旧包探针或仅凭 bundle ID 推断包版本。远端 `main` 的两次只读查询分别遭遇
HTTP/2 framing error 和 GitHub 443 连接失败，未获取新的远端 SHA。

### 2026-09-24 续接核验（不计入 E6 GUI 案例）

- 审批联合回归 `approval-policy-run.test.mjs`、`approval-postcommit-response.test.mjs`、
  `approval-policy.test.mjs` 最终退出码 0，165/165 通过。持久决策后的 callback
  异常现在不会向客户端谎报“审批失败”；响应中的 `postCommit.status=deferred`
  仅表明后续投影需对账，**不代表命令执行成功或同进程自动恢复完成**。
- `git ls-remote origin refs/heads/main` 恢复可用，返回
  `7679003189711eaceb1f57ef39f2c8937f22a215`；本地 `origin/main` 与其一致。
  实施分支 `3ffd2681` 相对它 ahead 97、behind 0，仍有 19 个未提交路径。
  这只确定 Git 提交关系，不等于 WIP 已合并、CI 已通过或已发布。
- 新 ZIP 的 SHA-256 再核对为
  `b6955527da92afa6aba27c39ebb3953b4db6c39336372fc757fb9b325ff563d5`。
  当前桌面捕获是纯黑帧；旧包进程 PID `27305`、`45724` 仍在运行，未从新包
  路径启动。因此不能采集真实新包的视觉通过证据。
- 新附件 `codex-clipboard-6236431c-0bd7-4f96-bd63-fe1b8355b1b8.png`
  的临时路径已不存在；其具体反馈尚未分析，不得据此修改产品行为。

下一步需用户解锁 Mac 并重新附上该截图；然后精确确认新包进程 executable，按原
12 类 E6 清单逐例留存 `simulation=false` 证据。审批 deferred 的同进程对账/可见诊断
仍需验证；在这些退出条件满足前不提交 PR、合并或将本目标标为完成。

### 2026-09-24 自动化门槛补测与下一唯一续做点

- 侧栏审批测试先红后绿：重复的同一 `approval.id` 原先在普通会话、队友私聊、频道
  通知投影中按数组行重复计数，而 Composer gate 已按 ID 合并。现在三个侧栏投影按
  唯一 pending ID 计数；频道 E2E 的三个不同审批显示 `3 pending approvals`，
  不再要求与事实不符的通用 `Waiting for approval`。`sidebar-status-projections.spec.ts`
  与 `ui2-approvals.spec.ts` 合计 **20/20**；Web typecheck 退出码 0。
- Daemon 默认跨文件并发的确切失败为多个测试进程对同一默认工作区争夺
  `.ling-stack/runtime.lock`，四文件复现 **234/335 失败**，首个错误
  `runtime_already_running`。生产锁不能放宽。仅将 Daemon `test`/`test:ci`
  脚本设为跨文件串行；串行两文件 **98/98**，全套 **2016/2016** 通过，
  最终退出码 0（耗时约 489 秒）。未来若要恢复跨文件并行，须为每个测试进程
  分配独立默认工作区，而非禁用 Runtime Supervisor 锁。
- 全套第一次串行运行还发现 Harness 成功恢复 fixture 将 provider 的 `lastCheck`
  固定为 `2026-09-13T02:00:00.000Z`。超过启动重检的 24 小时门槛后，
  `fixture.invalid` 被重新探测为 `network_failed`，恢复派发在预检处被拒绝。
  成功恢复 fixture 改为当次时间，生产预检未放宽；Harness 集成用例 **12/12**，
  再跑 Daemon 全套 **2016/2016**。临时诊断探针已移除。
- 留存的产品风险：真实旧 Run 在恢复时若 provider 预检失败，现有控制器可反复扫描
  `stale` WorkUnit，而最终恢复失败原因不一定可见于会话；本轮未声称此路径已修好。
  后续须单独定义并验证“待人工修复的结构化 blocker / 重试”边界，避免把
  预检拒绝误报为成功或无限静默重试。
- macOS GUI 再探针仍不可作为新包验收：Cua Driver 的 Accessibility、Screen
  Recording 权限均为 true，但 `launch_app(com.lingstack.desktop)` 返回旧包 PID
  `45724`；进程 executable 确认为工作树 `apps/desktop/release/mac-arm64/Ling Stack.app`。
  其窗口 `32763` 的 AXWindow 未解析且 ScreenCaptureKit 窗口捕获失败；全桌面
  `3456×2234` 捕获内容为纯黑。新包实际位于
  `/private/tmp/ling-e6-ui-fix-20260924/mac-arm64/Ling Stack.app`，ZIP SHA-256
  仍为上文记录的 `b695…563d5`，但未从该可执行文件启动任何新 GUI 测试进程。
  原附件临时路径也仍不存在，不能猜测图片反馈或据旧包判断修复结果。

下一唯一续做点：先取得可读取的新截图与已解锁的 Mac，核实新包的进程 executable
路径，再在隔离 userData 下逐项补齐 12 类 E6 `simulation=false` GUI 证据；同时验证
审批 deferred 的同进程对账和上述 provider 恢复诊断。自动化全绿不是 E6 完成，
不得因此提交 PR、合并或结束目标。

### 2026-09-24 恢复预检失败的原子收尾（未提交 WIP）

- 定向测试先红后绿：provider check 返回 `network_failed` 时，旧实现仍把原 Run
  留在 `running`、WorkUnit 留在 `stale`，下次扫描再次派发；失败只进不记录错误的
  detached sink。新测试的首次失败断言是 `running !== failed`。
- 现在仅对 `daemon_recovery` 的 `provider_preflight_failed`，在原 Attempt 仍为
  `lost`、且 Run/WorkUnit/Task 及完整 fence 匹配时，通过 SQLite 单事务将三者
  结为 `failed`，保留旧 Attempt 为 `lost`。事务后写入 `run_error`、TerminalSummary、
  Thread 状态及控制面失效事件。Provider 修复后由用户显式 retry，不会每 5 秒
  静默重试；如果新的 Attempt 已接管，旧预检结果 CAS 拒绝，不能终结新执行。
- `@ling-stack/daemon build` 退出码 0；恢复/审批专项 **28/28**，Daemon 全套
  **2018/2018** 退出码 0，`git diff --check` 通过。这里的错误可见性仅由
  SQLite Run/WorkUnit/Task、RunEvent、TerminalSummary 和 Thread 断言证明，
  尚未通过 packaged GUI 人工确认。
- 尚需检查：其他非 provider 的恢复前失败仍可能走 detached sink；本次没有
  放宽 provider 预检，也没有声称 E5 所有故障类别或 E6 真实 GUI 已验收。

下一步仍是获取可读的新截图、核实新包 executable 和隔离 userData，以真实
`simulation=false` 的 12 类 GUI 案例验证；审批 deferred 的同进程对账也未完成。

### 2026-09-24 E6 新包 GUI 续接：工具文本、双队友和重启边界

上文“拿不到新包 GUI”的续做点已过时。当前隔离 QA App 是
`$HOME/Applications/Ling Stack E6 QA Artifact Review 20260924.app`，
启动可执行文件为该 App 的 `Contents/MacOS/Ling Stack`（PID `96028`），userData
为 `/private/tmp/ling-e6-qa-data-20260924-AnWEvK`。ZIP SHA-256 为
`f7505b1801d4937fcd978efa6bc66528989ac598e75bcbccbae6d6e5dc5e372c`，
副本 `app.asar` SHA-256 为
`861c04d784e7d11438a44efe13d8e95404b8c75388cbc86b00bdc4665f6c2f42`；
副本 ad-hoc 重签，`codesign --verify --deep --strict` 通过，不能替代正式签名验收。

- 首次 `printf E6-ARTIFACT-RECHECK` 在创建 Task/Run 前失败。
  `packaged-restricted-command-bootstrap.ts` 只固定 `node`，因此
  `restricted_command_executable_unavailable` 是该探针命令不支持，不是 helper
  消失。UI 却短暂显示“允许开始”，拒绝后同时留下失败叙述和重复诊断；此展示边界
  需另验，不得计为命令执行。
- 改用受支持的 `node -e`，经真实 `approve_once` 后执行得到 stdout
  `E6-ARTIFACT-RECHECK`。Host RunEvent 序列含 tool start/update/end、审批、
  prepared/settled；WorkUnit Attempt 和 workflow step succeeded。
  模型可见工具文本不再包含 artifact ID，原子 Host evidence 保留 ID；新包频道
  截图/AX 正文无内部 artifact ID。证据在
  `/private/tmp/ling-e6-qa-evidence-20260924/case-03b-rebuilt-tool-output/`。
- 新包又运行了**全新** Designer+Engineer required 双队友任务：Designer 叙述先完成，
  Engineer 经一次审批真实运行 `node -e`，stdout 为 `E6-TWO-AGENT-RECHECK`；
  两个 run/attempt/step 均 succeeded 后，workflow 2/2 和唯一 generation 1 报告
  succeeded。AX 与截图显示 depth-1 活动、命令、stdout 和最终状态，未暴露内部
  artifact ID。证据在
  `/private/tmp/ling-e6-qa-evidence-20260924/case-03c-rebuilt-two-agent/`。
  报告仍是 `deterministic_fallback`，不是模型生成终述。
- Daemon 完整测试在本次源码下 **2019/2019** 通过。专用 App 的旧 daemon
  PID `96032` 收到 SIGTERM 后，桌面自动启动 PID `37695`，频道重新导航后保留
  原两条 Run lineage 与 generation 1 唯一报告。重启头几秒的 Host capability 和
  Office Driver claim 出现 request failed/authority invalid，随后无持续错误日志；
  这只证明**已完成历史恢复**，尚未证明重启期间活动工具与重新注册后的 Host
  capability 可正常执行，不能给 E6 daemon-restart 全项 PASS。

下一唯一续做点：为 partial fan-in、重启中的活动执行/Host capability、SSE reconnect、
Allow similar 成败、retry/cancel、文件/MCP、copy/hover/折叠/窄窗/主题、权限设置、
depth-1 子 Agent 和审批 deferred 对账逐项补真实证据；若发现产品缺陷先修再重打包。
12 类完成前不提交 PR、不合并，也不把这几项局部通过说成 E6 完成。

### 2026-09-24 E6 命令详情流边界：新包渲染复测

先前真实 Engineer 命令的 `tool_update` 依次记录 stdout 和 stderr，但旧 UI 将
片段直接 `join("")`，把 `E6-PARTIAL-FANIN` 与 Electron/macOS 的 stderr
诊断粘成一段。修复使用共享 `formatCommandOutputTail`：同一 stream 的片段保持
相接，仅在 stdout/stderr 切换时加入明确边界；原始 Host 事件及顺序不变。
单测 3/3、三种会话的相关 Web E2E 7/7、Web typecheck、`git diff --check`
已通过；随后 `package:mac` 成功，ZIP SHA-256 为
`f48d31c26def00f5b422a555ca5bfbf84c3fbb670a217145cfbdcd76175bedcf`。

新包以独立 ad-hoc 重签的 `com.lingstack.desktop.qa.e6stream20260924`
启动，继续使用隔离 userData。Cua Driver 的 AX 能读取频道，但后台窗口
截图一直是旧首页帧，不能作为视觉证据。改由 Playwright 启动**同一打包 App**
并通过真实控件进入旧频道、展开 Engineer 和命令行：`fact.command` 的
`actionId=approval:approval_30cab0fb-0844-4c6e-adce-3d310c7496dd`，
详情显示 `stdout:\nE6-PARTIAL-FANIN\nstderr:\n...`。隔离 SQLite
`run_f04db8ab-bef0-485d-942c-fcb8bfc4895d` 的 seq 15/16 分别是
stdout/stderr，seq 20 是 `tool_end`。前后截图、局部特写、语义状态、
lineage 和脱敏日志在
`/private/tmp/ling-e6-qa-evidence-20260924/case-10-command-detail-stream-boundary/`。

此案例为**已有真实执行证据的新包渲染验收**，并非新包再次执行命令，也不能
替代其余 E6 场景。全窗图里的浮动“滚到底部”按钮压到命令详情下缘，需在
copy/hover/折叠/窄窗视觉矩阵再判定。截图完成后 Playwright 连接显示窗口关闭，
但 Electron 主进程仍在；没有足够证据将其归因于产品崩溃，需和外部窗口关闭、
自动化生命周期分别核对。旧 QA App 保留为 `... pre-stream.app`，原工作树未动。

### 2026-09-24 E6 Allow similar：真实审批与规则复用

继续使用上面的 packaged App、独立 userData 和同一 ZIP SHA-256。频道
`@Engineer` 的 `node --test e6-allow-similar.test.mjs` 等待审批时只显示
“允许一次/拒绝”：SQLite 中该 Run 的 `approvalProfile` 是
`standard + requiredForTools=[bash,edit,write]`，Host 对 mandatory approval
按策略禁止提议可持久复用的命令规则。点击“允许一次”后 Run succeeded；这不是
UI 漏掉按钮，也不能通过放宽 Engineer 的审批要求修复。

普通会话在同一隔离工作区执行相同命令时，Host 提议精确前缀
`[node,--test,e6-allow-similar.test.mjs]`，SQLite 决策集包含
`approve_once/approve_command_rule/deny`。打包 UI 的“允许选项”下拉菜单
实际显示“允许类似命令”；点击后 `approval_c3d07d12-43a2-4a86-b956-7353fb952138`
以 `approve_command_rule` 解决，规则
`approval_rule_c97acc29-fb60-4792-91e2-c90a316a257a` 持久化。第一次 Run
`run_fac44cf9-77e7-4040-8bd3-95f12cdea3ed` 完成真实 Host 命令、工具结果；
同会话第二次同命令的 Run `run_39febddf-6b15-4697-adca-0ace6db2913f`
仍有 `tool_start/host_command_prepared/host_command_settled/tool_update/tool_end`，
审批请求数为 0，测试 1/1 通过。截图与 SQLite lineage 在
`/private/tmp/ling-e6-qa-evidence-20260924/case-11-allow-similar/`。

此案例只证明受限前缀的**正例和复用**；`node -e` 不允许建立宽泛复用规则，
其“允许一次”已经单独验证。完整的风险/拒绝反例、SSE/restart、文件/MCP、
权限设置及窄窗/主题等 E6 仍未完成。完成页还有独立英文
`The task completed.`，视觉上像第二份总结；应在最终报告展示矩阵中厘清
TerminalReport 与 Agent 最终回答的呈现，不能给“无重复总结”签通过。

### E6 状态型结果行与新包复核

普通会话的 `follow_user` 先前固定落到 `en-US`；已改为根据当前消息调用
`inferUserLanguage`，显式语言设置仍优先。新的中文 Run
`run_6596371a-8e24-4567-a430-07b160366749` 与持久化的 turn 报告
`terminal_report_2738cf2f-6c60-4b30-8166-78ab88c0ee9f` 均为 `zh-CN`。
确定性 fallback 的结果投影不再复述用户请求。旧的英文报告仍保持原貌，
不做历史改写。

真实 packaged GUI 还暴露了另一个缺口：最新的状态型报告没有详情分区，
但点击后仍展开空白；标题“任务已完成。”旁重复显示 generation/1 agents/成功。
Renderer 现在只对**没有可见详情且没有摘要**的报告使用紧凑静态状态行；
有变更、验证、风险、来源或多 Agent 详情的报告仍保留展开和 lineage。
Web 定向测试 6/6、类型检查与 `git diff --check` 通过。重新 `package:mac`
成功，ZIP SHA-256 为
`0d3fdcaa1a4c0594b305e438ce351aeb6b31ebbdd8f488df7337913430b26cf7`；
独立 QA 副本 `$HOME/Applications/Ling Stack E6 QA Compact Review.app`
经 ad-hoc 重签，`codesign --verify --deep --strict` 通过。

新包重开相同隔离历史时，单个 root Timeline 的最新报告为静态
`任务已完成。`，无空展开、重复状态和跳到最新按钮；hover 才展示复制，
真实点击后系统剪贴板为 `# 任务已完成。`。Run/Attempt、命令 actionId、
Host tool_start/update/end 与 TerminalReport generation 1 的 SQLite 关系已对齐。
新包截图、语义状态、lineage、脱敏事件摘要和 `simulation=false` 清单在
`/private/tmp/ling-e6-qa-evidence-20260924/case-12-compact-zh-outcome/`。

这条 Run 在上一个 QA 构建中真实执行，本次只是**新包渲染与历史恢复复验**；
macOS 原生窗口捕获暂时失败，截图来自同一 packaged Electron 的渲染进程，
不冒充 Cua 原生截图。其余 E6 场景及最终 CI、PR、合并仍未完成。

### E6 活动执行中的 renderer/SSE reconnect 复验

为验证不是只在完成后重新读取历史，隔离 QA 工作区新增了无副作用的
`e6-sse-delay.test.mjs`，通过真实 packaged 客户端运行
`node --test e6-sse-delay.test.mjs`，并在 Host 已批准、Timeline 明确显示
`running` 后立即刷新 renderer。刷新前和刷新后观察到相同的
`run_56793fc5-8433-4127-8ff0-84b6bca0c652`、同一 command action 和同一
Attempt，刷新后仍为 `running`，没有创建第二个 tool action 或报告。命令自然
完成后测试 `1/1` 通过，最终只生成一个 TerminalReport
`terminal_report_8811c893-5412-4c18-be57-b7de2c5f7707`。

SQLite 事件时间明确覆盖：`tool_start:9`、`approval_requested:10`、
`approval_approved:12`、`host_command_prepared:13`、
`host_command_settled:14`、`tool_update:15`、`tool_end:18`、
`run_end:78`、`result:79`；一次 Run、一次 Attempt、一次 start/update/end、
一次 TerminalReport。该案例证明的是**活动 renderer reload/SSE reconnect 的
连续性**，不是 daemon 进程重启或 Host capability 重注册。证据在
`/private/tmp/ling-e6-qa-evidence-20260924/case-13-sse-reconnect-active/`，
包含截图、语义状态、lineage、脱敏事件和 `simulation=false` 清单。

### E6 daemon 重启后的 Desktop capability authority 续接

活动命令中重启 daemon 的旧 Run `run_37cf22d0-6635-469c-9b5d-64d2b2998d00`
以 `runtime_interrupted_no_checkpoint` 失败。其 Host journal 的 settlement 为
`stop_unconfirmed`：`leaderExited=true`、`stdioClosed=true`、`stopReason=cancelled`，
但后代状态仍为 `unverified`。这是已约定的 fail-closed 事实；不得清理 SQLite、
按进程列表猜测解锁或把这次失败记作自动续跑成功。旧线程和 Run 的持久状态已是
`failed`、`active_run_id` 为空。侧栏短暂仍显示运行中需要另行复测刷新投影。

同一次重启的 Desktop 启动日志记录了 daemon ready 后 Host capability 和 Office
Driver claim 的短暂 `authority_invalid`。两个常驻桥此前仅靠 4/5 秒的定时心跳
向新 daemon 重新发布 availability。已在两个 claim loop 中对明确的 authority-invalid
错误立即重新发布，保留原心跳兜底；网络错误、其他审批/权限拒绝不因此自动放行。
新增的两条回归先在 60 秒心跳配置下失败，再在修复后通过；Desktop 定向 9/9、
完整 Node 测试 1143 passed/3 skipped、三项 TypeScript typecheck 与
`git diff --check` 通过。这些是源码测试，尚不是新 packaged GUI 验收。

下一步：用新包和**新的隔离工作区**验证重启后两个 capability 重新注册及后续
独立命令可运行；原被阻断工作区继续保持 fail-closed。补齐案例 14 的
`case.json`、lineage、脱敏日志，并检查侧栏更新。不得用新目录的成功掩盖旧目录
的风险状态，也不得把本节当成 E6 全矩阵或最终 CI/PR 完成。

### E6 接续构建与自动化闸门

在 `codex/e6-safe-continuation@3ffd2681` 的未提交实现上重新执行当前源码闸门：

- Desktop Host/Office 与 packaged intent 定向测试 17/17，通过；完整 Desktop Node
  测试 1145 passed、3 skipped、0 failed；三项 Desktop TypeScript typecheck 通过。
- Daemon 全量测试 2020/2020，通过；Web 单测 353/353，通过；`git diff --check` 通过。
- `package:mac` 成功；审批 post-commit 独立 owner 修复后已重新打包，当前候选 ZIP 为
  `apps/desktop/release/Ling-Stack-0.1.2-alpha.1-macos-arm64.zip`，SHA-256
  `5c7b16524c6dd384350d8da279edf28bc300d0b4074403b6054f41b532d6714a`；
  主程序 SHA-256 `5eaf479a442c815b1c0bbe5943c202011a031078f8c876b592fe0bbdfaebc2df`。
  `codesign --verify --deep --strict` 通过。这些哈希标识本轮新构建，不能与先前
  已安装 QA 副本或先前 ZIP 混用。
- 审批 post-commit 回调原先将 Run、workflow、media 串行相依；现在三个独立
  owner 都被尝试，任一失败仍由路由返回已持久化的 decision 和 deferred 对账状态。
  新增 owner 隔离测试，审批 post-commit 定向 4/4 通过。同进程 deferred 自动重试
  尚未完成，不能把该测试当成审批恢复的全部证据。
- 只读 `git ls-remote origin refs/heads/main` 返回
  `7679003189711eaceb1f57ef39f2c8937f22a215`；本地 `main@fa7783b9` 是
  实施基线，不应称其为远端最新。根工作区的其他未提交 WIP 未修改。

当前 Mac 仍锁屏，原生 UI 控制明确返回需要用户手动解锁；本次没有启动/切换
新包做 GUI 操作，也没有生成新的 `simulation=false` 案例。新包只是候选构建，
待解锁后仍须沿用隔离数据、精确核验 executable 与构建哈希，完成案例 14 和
其余 E6 矩阵的截图、语义状态、SQLite lineage、脱敏日志与 `case.json`。
此前 `desktop_capabilities.rebound` 的进程级日志与新包源码回归是恢复链路证据，
不替代新包完整 GUI 验收。

### E6 接续：审批事务边界与事件去重

在 `codex/e6-safe-continuation` 的未提交 WIP 上，审批回调故障注入继续发现两个
持久化缺口，均先以失败测试复现再修复：

- 普通 `createApprovalRequest` 原先先写 request，再写 checkpoint；checkpoint
  写入失败会留下没有 checkpoint 的待审批请求。现在 request、checkpoint 和
  LingThread metadata 同一 SQLite savepoint 回滚。审批决议的普通 allow once、
  deny、expire、cancel 原先也可能留下已决请求和旧 checkpoint；现同一事务回滚。
  Core 回归覆盖故障后的 pending/无请求状态及修复后重试，Core 全量 992/992 通过。
- `approval.resolved` control-plane 事件原先在重试时可重复追加。现在按审批 ID
  使用存储层原有的 idempotency key，故障重试只保留一个持久事件；Daemon
  control-plane/审批恢复定向 38/38、Daemon 全量 2021/2021 通过。SSE 仍是按 seq 重放的传送语义，不能
  因此宣称所有 owner 的副作用已完成。

本次源码改动后已重新执行 `package:mac`，ad-hoc codesign 严格校验通过：ZIP
`apps/desktop/release/Ling-Stack-0.1.2-alpha.1-macos-arm64.zip` 的 SHA-256 为
`3eb0ceec4f1c1272f86a70b0dc08985b283cb77758b023bb2e8a72507e687668`，
主可执行文件 SHA-256 为
`435e4231a0aa3cd6a9f1152cbd6f2428e89d8108fb87afab3726b21a41ebc3f1`。
最新 Cua Driver 桌面捕获仍是纯黑帧，旧包 PID 27305 没有可见窗口，不能把该
捕获算作新包 UI 证据，也未从新包路径启动进程。`postCommit=deferred` 目前仍缺同进程按
owner 的自动对账；不能盲重放全部回调或把一个定时器当 durable recovery。截图
`codex-clipboard-6236431c-0bd7-4f96-bd63-fe1b8355b1b8.png` 的临时路径不可读，
其内容仍未纳入判断。没有产生新包的 `simulation=false` 证据；待用户重新上传
截图并解锁 Mac 后继续验证。若此后再改源码，本节新 ZIP 哈希也会失效。

### E6 接续：人工拒绝恢复与 checkpoint 完整扫描

继续用持久化故障场景验证审批恢复。已修复：人工 `local-user` 拒绝的 suspended
Run 原先不在启动恢复扫描内，且拒绝终态仅承认自动审核；现在在原 Attempt 已失联、
Run 尚待审批的条件下，将 Run/WorkUnit/Task 一次性收束为 failed，不执行被拒绝的
命令，重复扫描不增加 Attempt 或重复拒绝事件。此处恢复丢失 Attempt 的终态提交使用
Host/system fence，不借用已失效的用户执行 fence。

扫描原先对 approved、resume_pending、denied 各取最多 500 条；旧记录可能永远
得不到恢复。现在 SQLite 按 `(created_at DESC, id DESC)` 稳定排序，并以相同键
分页；即使 created_at 相同也不跳过记录。Core 相同时间戳分页测试、Daemon 第
501 条拒绝恢复测试，以及人工拒绝真实 SQLite/Run 测试先红后绿。当前 Core
全量 993/993、Daemon 全量 2023/2023、`git diff --check` 通过。

上述是源码恢复证据，不是 packaged GUI 验收。修改后旧 ZIP 哈希失效；下一步
先生成新包，再核验同进程 deferred owner 对账及 E6 十二类隔离 GUI 案例。
缺失的临时截图需要重新上传，不能从文件名推断内容。

本轮 `package:mac` 已完成，新的候选 ZIP
`apps/desktop/release/Ling-Stack-0.1.2-alpha.1-macos-arm64.zip` SHA-256 为
`105bf1db94351135e39fdea2f81af76870a4c338becff5f27285b19abb0db072`；
包内主程序 SHA-256 为
`abb7195d241468d06c6d34e958dc6788c16bceb84045990d8979890adc8f8afc`。
`codesign --verify --deep --strict` 通过。Cua Driver daemon 正常运行，
Accessibility 和 Screen Recording 权限均为 true，但新的全桌面截图依然是
`3456×2234` 纯黑帧。不能用它证明任何真实 UI 案例通过；本节没有启动新包
执行 E6 GUI 动作，也没有产生新的 `simulation=false` 案例。

接着审查审批 owner 边界：Run 有 Attempt/checkpoint 恢复，workflow 有状态门，
external work 的状态同步可重查；media 的批准回调会派发异步外部工作，不能
简单定时重放整个 `onApprovalResolved`。`postCommit=deferred` 的逐 owner
持久对账和 effect-unknown 处理仍未完成，不能据现有 HTTP 200 宣称闭环。

### E5 延伸设计：审批决议后的逐 owner 对账

审批决议是已提交事实，随后执行的回调不是事实。对每个新决议在同一个 SQLite
事务里建立三类待办：Run 才有的 `decision_event`、唯一归属的 `owner`、以及
`control_plane_event`。一条审批只允许 Run、workflow、media、external
其中一个 owner，不允许一次失败的 callback 抑制另一个独立待办。行以
`approvalId + effectKind` 为唯一键，保留 revision、claim token/期限、
尝试数和最后的结构化错误；重启扫描读取行，不靠 HTTP 响应或内存定时器。

执行门槛：先持久化 Run 的审批事件，再执行 Run 续接；每个效果单独 claim/CAS
并读回实际 owner 状态。Run 只走已有 checkpoint/Attempt fence，workflow
按当前 step 的预/后置 gate 状态重算，external 只同步本地 action 状态；
control-plane event 使用审批 ID 幂等键。所有 owner 回调必须能重复观察，
但不能因重试重新执行真实命令。媒体拆成审批状态投影与外部提交：仅在
`waiting_for_approval` 且已批准时转 `queued`；外部操作一旦进入可能已提交
但缺少可恢复 handle 的窗口，标记 `effect_unknown` 等待人工处理，不通过
`onApprovalResolved` 的整体重放重新发单。终态 media job 不隐式重试。

恢复闸门：对可证明未越过副作用边界的 owner 允许有界自动重试；`claimed`
过期时先重查持久 owner 证据，无法证明未执行则阻断。列表必须分页，恢复
不能只读最近 500 条。HTTP 的 `postCommit=deferred` 应提供可追溯的未完成
effect，而不是把已提交审批误报为失败；同进程与 daemon restart 使用同一
持久扫描器。完成证据包括决议事务故障注入、重复请求、并发 claim、断电/重启、
media effect-unknown、SSE reconnect 与真实 packaged GUI。

### 2026-09-25 接续：审批逐 owner 待办的存储切片（尚未完成 E5/E6）

在 `codex/e6-safe-continuation` 的未提交 WIP 上，新迁移 139 建立
`approval_postcommit_effects`，并在审批决议的同一 SQLite savepoint 中按
`approvalId + effectKind` 写入 Run 决议事件、唯一执行 owner、control-plane
事件。Run 关联的 workflow step 仅是 lineage，不会另立一个执行 owner。
存储 API 支持稳定分页、CAS claim/settle、带 revision 的过期 claim 恢复；
媒体 owner 的过期 claim 禁止被重排为自动待办。HTTP 人工决议已逐项领取、
独立提交；媒体回调异常保守标记 `effect_unknown`，不得重放外部派发。

故障注入测试先证明重启后无待办，再在实现后验证关闭/重开仍有三条原子待办，
且 ledger 插入失败会回滚审批决议；并发 token、错误 token、过期 lease 与
旧 revision 均有定向断言。Core 全量 **995/995**、Daemon 全量 **2023/2023**
在本切片主要实现后通过；后续新增的 expired-claim 定向断言亦通过。
旧版 schema fixture 已显式移除迁移 139，不把旧版快照冒充最新 schema。

**仍未实现：** daemon 同进程/重启扫描器对 pending/expired-claimed 的逐 owner
状态证据核对及安全恢复；系统审核、过期、取消等非 HTTP 人工决议路径也需要
确认效果结算。Run 事件 crash-window 的去重须核对持久事实，媒体缺失可恢复
handle 时只能 `effect_unknown`。当前表内 pending 不能被视作已完成，不能重打包
作为 E6 候选。新附图临时路径仍不可读，需要重新上传；Mac 原生桌面捕获纯黑，
还没有 12 类 `simulation=false` GUI 验收。本切片修改后的旧 ZIP hash 已失效。

唯一续做起点：先为 daemon restart/claimed crash-window 增加失败测试；实现共享
owner 对账器和有界扫描，不能直接重放 `syncMediaJobForApprovalDecision`；随后
重新执行 Core/Daemon/GUI 验收并生成新包。不要把本段存储层通过当作 E5/E6 完成。

### 2026-09-25 状态更正：持久对账扫描已接通，客户端验收仍未完成

上一节的“daemon 扫描器未实现”和“唯一续做起点”是当时的历史快照，**不再是当前状态**。
当前 WIP 已在 daemon 启动及同进程每 10 秒接通逐 store 的待办扫描：分别处理
`pending` 和过期 `claimed`，按 SQLite 稳定键分页，并在 Run 审批事件已持久化时
避免重复追加。人工 HTTP 审批在决议事务提交后逐项对账，异常时返回已提交但
`postCommit=deferred` 的可查询状态；系统审核、过期和取消产生的决议待办由同一
扫描器读取。媒体 `ling-pending:*` 是本地占位，不是供应商 handle；扫描器不得
以它证明可恢复，也不得重新发单。

本轮先红后绿的故障测试还覆盖了另一处重启窗口：媒体 owner 待办已经
`completed`，job 是 `queued`，但没有持久的外部 handle。原会话媒体启动扫描
会把它当作普通待派发任务；现在共享恢复门将其隔离为 `effect_unknown`，
并验证 SQLite 关闭/重开后的会话媒体扫描不会再次派发。此保守处理可能需要
人工核对供应商状态，不声称外部操作一定已发生。Core 本轮全量 996/996；
另一个先红后绿的回归发现取消审批已有 `approval_cancelled` 事件，却被扫描器
误补成 `approval_denied`；现按决议终态匹配事件，取消仍是取消，control-plane
决议字段也保留 `cancelled`。定向恢复测试 6/6、最终源码 Core 全量
996/996、Daemon 全量 2031/2031、Desktop 类型检查和 `git diff --check`
通过。新包生成与真实 GUI 验收仍待本轮最终结果记录。

此前 SHA-256 为 `105bf1db…` 的 ZIP 对应旧源码，**不能用作当前验收包**。
余下闸门是重新 `package:mac`、签名/哈希，以及最新 packaged App 中
12 类 `simulation=false` 案例的截图、
SQLite lineage 和脱敏日志。临时截图 `codex-clipboard-6236431c-0bd7-4f96-bd63-fe1b8355b1b8.png`
当前不可读，需要重新上传才可判断其中是否有新增要求；本节没有新增 GUI 通过证据。

### 2026-09-25 新包与启动验收阻塞

最终源码 `package:mac` 成功；ZIP
`apps/desktop/release/Ling-Stack-0.1.2-alpha.1-macos-arm64.zip` 的 SHA-256 为
`86f18287a53c437c3f71e72fdffd075224ed06e7223d2362ff7d87a07313dc2e`，
包内主程序为 `bf53f085f880eb31f353f5d48df07a612232f96606207f619e82330670265389`。
`codesign --verify --deep --strict` 对新包及独立 QA 副本均通过。第一次打包曾因
`SqliteRunStore` 公共声明引用私有 SQLite 实现类，令 Web 缺少 `node:sqlite`
类型而失败；将方法签名收束到公开 `RunStore` 契约后，Web 完整构建和 macOS
重新打包通过。此改动仅限 TypeScript 声明边界。

真实 UI 仍**阻塞**，不是通过：新建且未覆盖旧案例的
`$HOME/Applications/Ling Stack E6 PostCommit QA 20260925.app`
以独立 bundle ID 经 Cua Driver 后台启动，返回 PID 但没有窗口，进程随即退出；
不带额外参数重复启动也一样。`~/Library/Logs/DiagnosticReports/`
在 10:31、10:34、10:42、10:46、10:47 的对应 `Ling Stack-*.ips`
记录 `EXC_BREAKPOINT/SIGTRAP`，栈停在 Electron/V8 早期初始化。副本初次
重签名遗漏原包的 JIT entitlement；恢复三项原始 entitlement 并严格验签后
仍崩溃，所以不能把遗漏 entitlement 宣称为唯一根因。另一次原 bundle ID 的
启动被 LaunchServices 解析到既有 9 月 22 日同 ID QA 副本，**不作为新包测试**。

用精确路径绑定原始新包后，确实得到它自身的 PID/警告窗口，内容为
`http://127.0.0.1:17891` 已有不兼容的其他 Ling daemon。该端口由既有 QA
客户端占用，未结束或修改它。原包并非已证实“启动即崩溃”，但尚无法进入
会话 UI；独立副本的崩溃原因仍需查明。没有生成任何新包的
`simulation=false` GUI 案例。旧 QA 副本及其数据未修改，当前 WIP 未提交。

### 2026-09-25 E6 真实客户端首例与续问：发现未过项

上一节“无真实 GUI 案例”是启动排查时的快照，现已由独立副本
`$HOME/Applications/Ling Stack E6 Isolated 20260925.app` 及隔离端口
`127.0.0.1:17907` 跑通真实 UI。隔离工作区为
`/private/tmp/ling-e6-isolated-v2-workspace.o5h4l5`；既有 `17891` QA daemon
没有停止或修改。通过真实 composer 粘贴与发送，Ling 创建 `todo.py` 和
`README.md`；SQLite Run `run_c5b2655c-e0b7-4f21-96e6-ec10563cd3ed` 为
`succeeded`，两个 `write` 和一次 `bash` 有 `tool_start/tool_end` 证据，
Host 命令结算为 `completed`，命令退出码 0。磁盘上两个文件存在。

同一 Run 中模型两次发出 `find {}`，缺必需的 `pattern`，工具真实返回
`isError=true`。旧版 TerminalReport 把任一失败 action 提升为整个 Run
`failed`，使 UI 同时显示“文件已编辑/命令成功”和“任务执行失败”。已新增
先红后绿回归测试，在 `terminal-report-evidence.ts` 将“成功 Run 同时有失败
及成功 action”归为 `partially_succeeded`，保留失败 operation 与 risk；只有
失败 action 的旧用例仍为 `failed`。相关 TerminalReport 测试 54/54 通过。
**此源码修复尚未重新打包并验证 GUI，旧副本的失败报告不会被追改。**

第二轮在同一真实会话追问文件、验证命令与未解决错误。新的 Run
`run_c531a773-9bcc-4fef-a0c4-6df1333e686d` 正确回忆文件和命令，
但回答“目前未发现未解决的错误”，漏掉两次 `find` 校验失败及可见的
TerminalReport。其持久 `normalConversationContext.renderedHistory` 长 1206
字符，包含 `todo.py`，不包含 `Validation failed` 或“任务执行失败”。
`normal-conversation-context-hydrator.ts` 目前只纳入用户和助手叙述，
没有将当前作用域内的 Host TerminalReport/action 风险投影为上下文事实。
因此连续追问的“关键事实一致”验收**未通过**；不能只凭文件记忆说
Continuity E6 通过。修复时需从可见、同 thread/turn、同 fingerprint 的
已提交报告读取原子证据，并在 context budget/segment/隐私边界内投影，
避免复制 UI 文本或把模型自述当工具事实。再测时必须同时验证旧报告风险
被后续有效证据如何标记/更正，不能简单把历史错误删掉。

随后在源码中补了只读 Host 报告事实投影：只取共享 projector 已准入的
`terminal_report` anchor，核对其有效 generation、已发布 item ID、workspace、
thread、turn、source、outcome 与重新计算的 evidence fingerprint；只把
报告状态和 conversation-visible 的未解决风险以 context 角色放进同一个
whole-Turn 预算。旧/隐藏/不匹配的报告不能越界回流；报告文本不写回
`conversation_items`。正常上下文与 TerminalReport 相关测试合计 **57/57**
通过。Daemon 全量随后 **2033/2034**：仅
`harness-continuation-integration.test.mjs` 整文件失败，汇总未给具体断言；
该文件单独重跑 **14/14** 通过。故全量本次不能记为绿，暂列待复现的
整套运行不稳定项。**这仍是源码验证，不是重新打包后的 GUI 复测**；旧运行快照不会被
回写，需新一轮连续追问验证模型实际读入此事实。

唯一续做起点：检查新的 context 投影在公开/私有与 supersession 边界的
剩余测试，再重新打包最新源码，跑连续追问和 E6 其余隔离 GUI 用例。当前不提交 PR、
不合并，也不宣称 12 类案例完成。临时附件
`codex-clipboard-6236431c-0bd7-4f96-bd63-fe1b8355b1b8.png` 仍不可读；
截图内容需要重新上传才能评估其中是否另有要求。

### 2026-09-25 E6 新包真实连续追问：报告折叠修复，错误原因仍需复测

隔离客户端数据库原报告 generation 1 为 `failed`，新源码第一次重启重算的
generation 2 错误地变成 `succeeded`，但两条失败 `find` action 和未解决风险均未消失。
两份 snapshot 的原子操作相同，差异只有 snapshot ID、终态、生成时间及指纹。
根因是 `deriveAtomicUnitStatus` 已产生 `partially_succeeded`，上层
`deriveCompositeAtomicTerminalState` 只识别 `succeeded`/`failed`/`blocked`/`cancelled`，
把部分成功单元折成了成功。普通会话 Turn 回归测试先红后绿；相关 40/40 和
Daemon 全量 2033/2033 通过。

重新打包的 ZIP SHA-256 为
`fdc58805a008404820a5ea8a79355c6c7155d69a084062356ca500592ef112d2`。
已用独立副本 `Ling Stack E6 Outcome QA 20260925.app`、原隔离工作区和端口
`17907` 启动；前一个专用 QA 副本正常退出，既有 `17891` 未动。启动重算生成
generation 3，SQLite 终态为 `partially_succeeded`，UI 风险仍为 2 条。
真实 composer 发第三轮追问时没有提示错误名；新 Run
`run_25033e8a-d719-4e3e-bf7f-5d29f067098f` 的持久上下文同时含部分成功
终态与 `find` 风险，模型回答承认两条未解决风险，未再误称“没有错误”。
GUI 截图在 `/private/tmp/ling-e6-qa-evidence.VzZ9J0/`，Run 为
`simulation=false` 的真实 packaged App 操作，尚未覆盖 E6 的全部 12 类案例。

该轮还发现风险摘要仅是 `find: <工作区路径>`，未暴露 RunEvent 中明确的
`Validation failed ... pattern: must have required properties pattern`，因此模型
误将它概括成环境/终端风险。源码已追加严格格式的必填参数校验摘要投影，
仅保留工具名与字段名，不把原始工具输出复制到报告或后续上下文；回归测试
先红后绿，并断言忽略同一工具输出后续的注入文本。相关测试 40/40 再次通过，
第二次 Daemon 全量仍在运行。**该摘要修复尚未重新打包，当前 generation 3
不证明精确错误原因已经在 GUI 生效。**下一步必须等全量结果，重新打包并
重启专用副本，核对 generation 4 风险与新一轮模型回答，再继续剩余 E6 案例。

### 2026-09-25 E6 generation 4 GUI 与第四轮追问：N-03 局部复测通过

本节覆盖上节的“尚未重打包”历史快照。最新 ZIP
`apps/desktop/release/Ling-Stack-0.1.2-alpha.1-macos-arm64.zip` 的 SHA-256 为
`9a3726453428a6c3d75754ca2daf1fa32cae9980ec80fc9d02554f48f9896432`；
本轮使用专用 packaged 客户端
`$HOME/Applications/Ling Stack E6 Validation QA 20260925.app`，
PID `64128`、daemon PID `64145`、隔离端口 `17907`、原隔离工作区
`/private/tmp/ling-e6-isolated-v2-workspace.o5h4l5`，没有触碰 `17891`。
旧附件临时路径不可读，但这不是要求用户复述本轮正在执行的验收的理由；
已从本检查点和现存客户端证据直接接续。

真实客户端打开最近会话后，generation 4 的唯一有效 TerminalReport
`terminal_report_5bfab715-2981-43c3-ac75-a4459c3ebf2c` 在 GUI 中显示
“任务已部分完成”、2 个 changes、2 条 risk，两条风险均为
`find: missing required pattern argument`。SQLite `report_json` 的
`outcome.status=partially_succeeded`、`risks.length=2` 和两条 summary 与界面一致；
result Item 为 `result_terminal_report:terminal_report_5bfab715-2981-43c3-ac75-a4459c3ebf2c`。
初始可见截图是
`/private/tmp/ling-e6-qa-evidence.VzZ9J0/gen4-open-attempt.png`
（SHA-256 `1fd593a4809c5d1015c0d5c48521c0670599645c8c46c96f7c94bf493b6416d3`）。

第四轮通过同一客户端真实 composer 发送追问，**用户输入没有给出 `pattern` 字段名**，
要求不执行新命令或修改文件，只说明两条风险原因并与已完成工作区分。Run
`run_18e10639-eaf9-4b04-8ba4-ae1954a2e092` 对应 Turn
`turn_normal_7922a7d37108abaec2519549ccc61d77d099b840c9fe8a279f7340124f66bc13`，
`status=succeeded`，runner resolution 为 `pi→pi`、模型 `gpt-5.5`。
本轮持久 `normal_conversation_accepted_input` 的 hydration entry 与
`normal_conversation_prepared_execution` 的 runner prompt 都包含 Host 投影的
`partially_succeeded` 和两条精确风险；RunEvent 只有叙述事件，无 `tool_start`，
与“不运行新命令”一致。GUI 最终回答指出两次 `find` 缺必需 `pattern` 参数，
同时区分 `todo.py`、`README.md` 创建成功、Python add/list 验证成功和工具风险仍在。
终态截图为 `/private/tmp/ling-e6-qa-evidence.VzZ9J0/fourth-turn-complete.png`
（SHA-256 `967d9b027c447a80170b8b6b2107b0d6e40392e058b77641a07e487cf35ec756`）。
这证明本条连续上下文的精确原因链在 packaged GUI 中通过，**不代表 E6 全部通过**。

执行口径更正：E6 清单当前有 **20 个 case ID**，先前多处“12 类”是旧统计。
本轮只覆盖 `N-03` 的一个真实连续追问/重开片段；`N-03` 的“超过 8 条消息”
与其余 19 项仍需按完整清单逐项结算，尤其 active SSE/restart、审批恢复、
多 Agent fan-in、私聊/频道一致性、长历史和窄窗。当前 WIP 仍未提交、未建 PR、未合并。

### 2026-09-25 E6 N-01：裸 URL 吞入中文句子，源码已修、GUI 待重包

继续在同一旧 packaged 客户端创建独立普通会话，真实 composer 输入标题、段落、列表、
inline/fenced code、`https://example.com；以及本地文件路径 .../todo.py`。
助手的标题/段落/列表/代码块及本地文件 chip 在 GUI 中有各自结构，但用户消息
把 `；以及本地文件路径` 吞进了网页链接，AX 目标变成
`example.xn--com;-e65fpdu52b44gj2uxxnjiejv1m`；**没有点击这个错误链接**。
旧包截图为 `/private/tmp/ling-e6-qa-evidence.VzZ9J0/n01-malformed-url-before-fix.png`
（SHA-256 `53a61e14d7e29fcc69555ee9c9bd3da832d7ab3bec2c3d9dfeea4bec8e846591`）。
SQLite `conversation_items` 的原始 `body` 正确，未被改写；composer parser 也正确
截出 `https://example.com`。根因在共享 `parseMessageBody`：GFM 对裸 URL 的
`link.url` 包含后续中文，渲染层直接信任其目标。只在共享 UI-core 的裸 GFM 链接
和 plain-text linkification 入口按自然语言边界拆分；显式 Markdown 国际化 URL 保留。
新增测试先红后绿，UI-core **184/184**、Web unit **353/353** 通过；源码直接
复现现只产生 `https://example.com` 链接、独立中文正文和 workspace 文件 token。

**N-01 仍是 fail / 待复测，不是 pass。** `package:mac` 的源码构建阶段通过，
但 Electron Builder 在 macOS packaging 阶段访问 `20.205.243.166:443`
返回 `ETIMEDOUT`，整个命令退出 1；现有 ZIP 哈希仍是上一节的
`9a372645…`，旧 `.app` 也未被替换。须网络/缓存恢复后重新生成完整包、
严格验签，再在真实 packaged 客户端重开该会话，核对链接的显示名、tooltip、
可点击目标和中文正文/路径均正确，随后继续 N-01 其余断言及 E6 其他案例。

### 2026-09-25 E6 N-01 新包重开复测：裸 URL 边界通过，整项未结算

此前 Electron Builder 下载超时已恢复，重新执行 `package:mac` 成功；新 ZIP
`apps/desktop/release/Ling-Stack-0.1.2-alpha.1-macos-arm64.zip` SHA-256 为
`89b7c2e09843adfd5f91ceb7efbbbe878450c30d7408494feea1c726e51d9738`，
与旧包 `9a372645…` 不同。构建产物和专用 QA 副本均通过
`codesign --verify --deep --strict`。专用客户端重启为 PID `17935`、daemon
PID `17965`，仍只监听隔离端口 `127.0.0.1:17907`；原工作区
`/private/tmp/ling-e6-isolated-v2-workspace.o5h4l5` 和既有历史保留，未触碰
`17891`。旧专用 App 保存在
`$HOME/Applications/Ling Stack E6 Validation QA 20260925.old-app-backup`。

替换副本首次启动时漏带原 QA App 的 `LSEnvironment`，仅打开了默认首页；
随即正常退出、从备份核对并补回 `LING_STACK_DAEMON_URL` 与
`LING_STACK_DEFAULT_WORKSPACE_CWD`，重新 ad-hoc 签名并严格验签后再启动。
不能把首次默认首页当作隔离验收证据。第二次启动的最近对话确认为原隔离
历史，重开 N-01 排版会话后的原生截图为
`/private/tmp/ling-e6-qa-evidence.VzZ9J0/n01-new-package-reopen-real.png`
（SHA-256 `c3781bc819cc1a09cf9b6f4f76574982558f615e1d37f44a488c79d8edd41946`）。
AX 树同时出现 `AXLink (example.com) [help="https://example.com"]`、独立
`；以及本地文件路径` 文本和 `todo.py` 文件按钮；旧版误造的 punycode 链接
不再出现，且未点击外部链接。截图中的标题、独立段落、编号列表、行内代码、
`python` 代码块也保持结构。由此只把 N-01 的裸 URL/中文边界与重开显示
记为真实 packaged GUI 局部通过；N-01 其余断言和 E6 其他 case ID 仍待逐项
验收，不提交 PR、不合并。

### 2026-09-25 E6 N-01 lineage 补核（仍未整项通过）

对隔离 SQLite 只读核验，当前 packaged 窗口（客户端 PID `17935`、窗口
`37960`）显示的排版会话对应 `ling_threads.id =
thread_08c71ff6-3f59-4115-88fa-ba9829a4f9ee`，`surface_kind=direct`、
`relation_kind=root`。本轮 `ling_turns.id =
turn_normal_3cc3bf5870dedbb1789819241e2b167778d770d0ecb93d70fd59ac42a952b70e`；
`run_sessions.id = run_86916ae4-c3ec-400c-95f0-d2f9263825ff`，
`work_unit_attempts.id = work_unit_attempt_ef0f8182-6cb7-4c3b-9cbb-b5e3c21018c8`。
`conversation_items` 仅有 sequence 1 的 `user_message` 与 sequence 2 的
`assistant_message`，两者均为 committed；Run 以 seq 83 的 `result` 结束，
状态 succeeded。这只证明该纯文本轮次有持久化来源，不证明 N-01 所有 UI
断言或其余 E6 用例通过。

再次读取真实窗口的截图为
`/private/tmp/ling-e6-qa-evidence.VzZ9J0/n01-lineage-snapshot.png`
（SHA-256 `d122bea4c5ccea32e3b62738e1cf19ca49c9295a5b134eef30061a3e5adb8894`）。
先前已真实点击复制：剪贴板包含标题、两个段落、代码和链接，原剪贴板已恢复；
后台 AX/像素点击未生效，获授权的短暂前台点击才成功，不能将后台输入失败
记成 Ling 复制失败。完整的 `case.json`、`semantic-state.json`、
`lineage.json`、脱敏日志及悬停/路径权限断言仍待补齐，N-01 保持局部通过。

### 2026-09-25 E6 N-02 状态错配与新包复测（仍未整项通过）

专用客户端旧包的后台 AX 已切到小项目会话，但截图仍缓存排版会话旧帧；
获用户授权将该窗口短暂置前后，真实截图
`/private/tmp/ling-e6-qa-evidence.VzZ9J0/n02-foreground-confirmed-partial.png`
才与 AX 一致。隔离 SQLite 中 generation 4 的
`terminal_report_5bfab715-2981-43c3-ac75-a4459c3ebf2c`
为 `partially_succeeded`，旧包却将该事实行读作“已阻止”。
根因是共享投影将部分完成映射成 blocked；频道旧适配还会从 WorkCell 状态
推断为 succeeded。两层均已改为保留已校验 TerminalReport 的原始 outcome，
补了独立状态文案、警告图标与测试。回归先红后绿：UI-core 185/185、
频道模拟端到端 8/8、Web 类型检查与 `git diff --check` 通过；
全量 Daemon 2033/2033 在本次修复前已通过。

最新 `package:mac` 成功，ZIP SHA-256 为
`65ded4025b1555ab4c0622155a4aa3d43a9b3bc6b6a789b46170cccb1730615c`，
App 严格验签通过。保留旧 QA 副本后替换专用
`Ling Stack E6 Validation QA 20260925.app`，恢复原隔离环境变量并重新签名；
新的客户端 PID `38205`、daemon PID `38229` 仅监听 `127.0.0.1:17907`。
最初 LaunchServices 误选已备份的旧包，旧 daemon 因而退出；退出该误启动实例、
注销两个旧副本并明确注册新包后，核对实际进程路径才继续验收。
新包截图
`/private/tmp/ling-e6-qa-evidence.VzZ9J0/n02-new-package-partial-status.png`
（SHA-256 `a8cb947f11d9bfa2738e918a401339ebb50117d191686421d38c3f97fc023f02`）
显示“任务已部分完成。 · Partially completed”、黄色图标、generation 4、
2 changes 与 2 risks。截图还显示内部 `find content` 和补丁计划附件进入报告展开区，
需要继续审查其可见性边界。N-02 所需的 read×3、diff、命令等完整断言和
证据四件套尚未齐全，不能记为通过；E6 20 个 case ID 尚未全部结算，
暂不提交 PR 或合并。

### 2026-09-25 E6 N-02 内部附件越界修复与真实新包复测（仍未整项通过）

同一隔离数据库中，generation 4 的报告把 `runId/.../find-content.md` 工具内容副本、
`.ling-stack/provenance/.../forward-plan.json` 与 `inverse-plan.json` 当作交付附件。
`RunArtifact` 记录了这些真实证据，但旧投影只按少数标题过滤，缺少 Host 对内部存储路径
的可见性分类。修复后，Host 在 TerminalReport evidence 中保留原始 artifact 和 lineage，
把 run 存储、provenance、harness、workflow 路径的附件引用标为 `developer_only`，
且不把这类引用附到公开 step/operation；真实工作区文件的 Changed path 仍来自原子动作。
共享 UI 投影同时按结构化路径处理旧报告，清除附件和重复来源引用，保留文件变更。

回归先红后绿：Daemon 相关 41/41、conversation-ui-core 186/186、三种会话的
Playwright 报告隐私 8/8、Core/Daemon/Web 类型检查通过。新的 macOS ZIP SHA-256 为
`8ffb94e0ff3129ee553716d330f37e848c42efc2c5e0e842b37f710df857a065`。
独立副本 `$HOME/Applications/Ling Stack E6 Artifact QA 20260925.app`
使用新包自己的 `ElectronAsarIntegrity`，只继承旧 QA 副本的隔离环境变量并重签；
启动后 PID `67247`、daemon PID `67259`，只监听 `127.0.0.1:17907`。
第一次复制整个旧 `Info.plist` 导致旧 asar 哈希与新包不符、Electron SIGTRAP；
已据 crash report 和两包哈希定位，并用新包原始 plist 重建副本，未改源码或旧 QA 包。

新客户端同一会话截图为
`/private/tmp/ling-e6-qa-evidence.VzZ9J0/n02-artifact-new-package-open.png`。
隔离 SQLite 最新 generation 5 仍是 `partially_succeeded`；evidence artifacts 为 17，
报告公开 artifacts 从 generation 4 的 11 降为 0，而 changes 仍为 2、risks 仍为 2。
截图展示 `Changes 2`、`Risks 2`，不再展示 `find content`、forward/inverse plan；
用户前台已恢复。此项只是 N-02 的内部附件边界局部通过，read×3、diff、命令等断言、
证据四件套及 E6 其余 20 个 case ID 尚未结算，未提交 PR、未合并。

### 2026-09-26 E6 N-02：审批等待误显失败，已修并在新 macOS 包复测

同一隔离小项目的下一轮真实请求新增 `tests/test_todo.py`，先读取 `todo.py`、
`README.md`，写出测试文件，再请求运行
`python3 -m unittest discover -s tests -v`。旧包在审批等待时同时展示审批卡和
“Ling 助手暂时无法完成这次请求。”；当时 `ling_turns` 与 Run 均为
`waiting_for_approval`，不是失败。批准后原 Turn 成功、命令退出码 0，两个测试通过。
旧包的等待态截图是
`/private/tmp/ling-e6-qa-evidence.VzZ9J0/n02-new-turn-approval-foreground.png`，
终态截图是
`/private/tmp/ling-e6-qa-evidence.VzZ9J0/n02-new-turn-success-foreground.png`。

根因在普通会话详情投影：`waiting_for_approval` 被折成展示用 `blocked`，空白
Assistant 消息因而填入通用失败文案。Host 的 Run/Turn/审批事实不变；仅将等待审批
投影为非终态 `running`，由专用审批 action/card 表示等待。新增 Daemon 回归用例先红
后绿，`narration-owner.test.mjs` 17/17；Desktop `package:mac` 成功，候选 ZIP
SHA-256 为 `52c148c944ac67c5d065cb27253c8940a9cbc61ddc4279b698cd87335f86191d`。

新隔离副本为 `$HOME/Applications/Ling Stack E6 Approval QA 20260925.app`，
同构建 `app.asar` SHA-256 为
`056d53c2eb3669323ccd025faa1b3b0b7522078282d292a8fe75dddec72103d1`。
只继承隔离环境键、保留新包自身 `ElectronAsarIntegrity`，并通过严格签名校验。
首次 QA 副本错误地额外改动 `CFBundleName`，在 Electron 初始化阶段 SIGTRAP；
恢复原值并重签后，PID `20083` 与隔离 daemon PID `20542` 正常启动，仍只使用
`127.0.0.1:17907`。未修改隔离数据库或原测试历史来制造通过。
本次源码改动后的 Daemon 全量回归为 2035/2035，零失败。

新包同一普通会话再发只读测试命令，Turn
`turn_normal_ab8811fd29e433f85ed62919401125a643ccd16ac1a240e28536bf0cfd905282`、
Run `run_ebbed4fb-b3db-4be1-90e1-8ff72b90a548`，审批
`approval_6ebeb445-e1c2-4e1d-b319-f920167499dc`。真实等待态截图
`/private/tmp/ling-e6-qa-evidence.VzZ9J0/n02-approval-fixed-new-package.png`
（SHA-256 `a9b5d3e9d01ba7e5f5aebf75d0996f1e880ebd1bad37fafac3740c2fd7221dd6`）
显示审批卡、等待动作与非失败的“正在思考”；批准一次后，RunEvent 有
`approval_approved`、`tool_update`、`tool_end`，命令 exit 0、2 tests OK，
Turn `succeeded`，TerminalReport `succeeded`。终态截图
`/private/tmp/ling-e6-qa-evidence.VzZ9J0/n02-approval-fixed-success-new-package.png`
（SHA-256 `aeba3cd14d51de614da9b4c27fda931494e844073fa4a0f59b0580002bd568fd`）。
每次短暂前台截图后均核对并恢复 ChatGPT 为前台。此处只结算审批等待误显失败的
真实 GUI 回归；本子案例的 `case.json`、`semantic-state.json`、`lineage.json` 和
脱敏日志记录在 `/private/tmp/ling-e6-qa-evidence.VzZ9J0/n02-approval-waiting/`，
未知 renderer/virtualizer 内部字段明确为 `null`，未从截图猜测。N-02 整项的
read×3、diff viewer 和对应完整证据，以及 E6 其余 case ID 仍未全部完成。
中文界面底部仍显示英文 `Help me approve`，需在 E6 本地化/设置项
检查中结算，不能把此局部成功视为整项通过。

### 2026-09-26 E6 N-02：三次读取、三份 diff 与命令证据（跨包重开）

隔离小项目的真实 Run `run_df5a7cab-7b0b-41ad-84d1-ba982be46b39`
保留三次独立读取 `todo.py`、`README.md`、`tests/test_todo.py`，随后编辑这三个
文件并运行 `python3 -m unittest discover -s tests -v`。三次读取之间存在模型叙述，
按 batching 边界保持三个原子动作是正确行为。Host 存有三份对应的 `.diff`
artifact；此前普通会话 `fileChange` 投影未携带 `changePreview`，导致 UI 有
“查看 diff 详情”入口却打不开真实差异。现已修复
`canonical-transcript-projector.ts` 的 artifact-to-action 关联，且禁止跨 action/
scope 误关联；对应测试先红后绿，conversation-ui-core 187/187、Web 类型检查与
`git diff --check` 通过。

新打包 ZIP SHA-256 为
`f80fe6e8c4a85749fd10fcf982a075482bf035b4378f7a1c1f0b4ffa6538b9ef`。
独立签名 QA 客户端
`$HOME/Applications/Ling Stack E6 Diff QA 20260926.app` 以独立
`LING_STACK_HOME` 启动，重开同一持久 Run 后实际点击三处 diff 入口，均显示
各自文件的差异；命令详情显示 cwd、两项测试通过，Host exit code 为 0。
证据四件套在 `/private/tmp/ling-e6-qa-evidence.VzZ9J0/n02-read3-diff/`；其中
`case.json` 明确 `simulation=false`、执行包和查看包不同，以及尚未运行的断言。
所有 JSON 均通过 `jq` 语法校验，五张引用截图的 SHA-256 与记录一致。
专用客户端短暂置前复核后，小项目会话截图为
`/private/tmp/ling-e6-qa-evidence.VzZ9J0/n02-foreground-refreshed.png`；
随后核对 ChatGPT 再次为前台。Cua 对目标窗口的精确 z-order 验证返回 partial
（辅助 `Window` 窗口排在前面），因此只以截图内容和前台进程读回作证，
不宣称该精确窗口激活验证通过。

此项是同一 Run 的跨包重开验证，不是一个新包完成执行全程；
`allN02PhasesInOnePackage` 与 E6 全矩阵仍标 `not_run`。中文界面的
`Help me approve` 仍需单独处理。未提交、推送或合并。

### 2026-09-26 E6 审批文案目录断链：源码/新包已修，GUI 仍待验

新包中的中文审批模式仍显示英文 `Help me approve`。根因是 Web 的旧
`zh-CN.ts` 已有“帮我审批”，但 `I18nProvider` 实际加载的是
`@ling-stack/localization` 编译目录，规范 `zh-CN.json` 漏了该键；
未修前新增的编译目录回归测试得到英文并失败。已在规范 en-US/zh-CN 目录补键，
其余 53 个目录仅机械同步键、source revision 和 source hash，保留原有译文。
自动翻译服务连接超时，因此新键在其余语言暂以英文回退，不冒充完整翻译。

修复后 `@ling-stack/localization` 目录检查为 55/55、6547 keys，测试 11/11；
Web `check:i18n`、`git diff --check`、macOS `package:mac` 均通过。新 ZIP SHA-256
`c069f99b23638cf39af429ae45bde12725e29a6e3e5a341e8f9b9a9001799b92`；
严格签名校验通过，并从实际 app bundle 的 Web asset 和 `app.asar` 中文目录
读回目标键与中文译文。

独立 QA 包 `$HOME/Applications/Ling Stack E6 Locale QA 20260926.app`
首次指向旧隔离项目时 daemon code 1；以打包二进制复现到明确的
`runtime_already_running`：该项目已由旧 QA daemon PID 69251、端口 17907
占有。未终止旧 daemon，也未改持久数据库。第二个独立实例使用新临时工作区与
用户根、端口 17915，客户端 PID 3008、daemon PID 3012；启动日志确认
`daemon.ready`、`daemon.connected`、`main_window.loaded`。其窗口 ID 38903 在
当前 macOS 会话下无法获得可证明的 AX/像素帧（前台进程读回也为空），
所以**新包 GUI 中文显示仍为 `not_run`**，不能以包内字符串或启动日志冒充截图。
原 N-02 客户端、Run 和截图保持不变；再次可用的桌面会话中应优先只读捕获
此新包的 Composer，核实显示“帮我审批”，再继续 E6 其余 case。

### 2026-09-26 E6 接续：新包中文实测与三类会话回归

上一段“新包 GUI 中文显示仍为 `not_run`”已被后续实测更新。独立 Locale QA
客户端 PID 3008、窗口 38903 短暂置前后，原生窗口截图
`/private/tmp/ling-e6-locale-help-approve-foreground-20260926.png` 与同一窗口
AX 控件均显示“已选择授权模式 帮我审批”，不再显示英文按钮文案；操作后已验证
ChatGPT PID 84715、窗口 36552 恢复前台。该客户端未配置聊天模型，因此这仅结算
中文审批文案的 packaged GUI 子项，不是 N-02 或 E6 全案例通过。
该前台截图的 SHA-256 为
`d232b4f171388261db2d48b842fd06f12af4c53c01bb7284df0542aadff67b3e`。

三种会话的完整浏览器回归起初为 160/163。逐项查明：普通会话 Full Access
测试仍查找旧按钮文案；频道已接受的提案显示了点击无效的“View task”；开发态
多 Agent 样例虽注入 TerminalReport，却缺同 thread/turn/fingerprint 的已提交
`terminal_report` Item，按现有事实门禁应被隐藏。已分别更新测试定位、仅在
提案可操作时显示入口，并给开发态样例补齐内部一致的 Item 锚点及投影接线，
**没有放宽生产报告门禁**。定向 3/3、Web 单元 353/353、Web 类型检查以及
普通会话/频道/队友私聊 E2E 163/163 均通过；`git diff --check` 通过。
随后全仓 `corepack pnpm typecheck` 与 `corepack pnpm test` 均以 exit 0 结束。

旧 Diff QA 客户端 PID 69247 在本次复核时已不再运行，原窗口 38835 返回
`window_id_not_found`；既有 N-02 截图仍保留在
`/private/tmp/ling-e6-qa-evidence.VzZ9J0/n02-foreground-refreshed.png`。
未重启旧客户端或改动其持久 Run。上述 Web 源码修改发生在 Locale QA 包构建
**之后**，因此该包的 SHA-256 只证明中文文案子项；后续完整 E6 GUI 验收必须
重新打包最新源码。当前没有提交、推送、PR 或合并。

### 2026-09-26 E6 最新包复核：普通会话实图与私聊捕获边界

最新源码在 `codex/e6-safe-continuation@3ffd2681` 加未提交 WIP 上重新打包，
macOS arm64 ZIP SHA-256 为
`a9dc073f71b6496fe442dac2ba2e9e08ce4776dda95d4a5ea1fa1f39ad2909ac`，
DMG SHA-256 为
`3440422d4d4d392eb632d5754776813487d2dbe978cedd6b350a7a177811a282`；
App bundle 的 `codesign --verify --deep --strict` 通过。隔离客户端
`Ling Stack E6 Latest QA 20260926.app`（PID 34932、窗口 39168、端口 17916）
在 `/private/tmp/ling-e6-latest-qa.zDpIer/workspace` 打开已有的小项目普通会话。
短暂前台刷新后，真实窗口截图
`/private/tmp/ling-e6-latest-conversation1-front.png`（SHA-256
`5e0ddf45b55c9940ad5b0d065437197f1cec86843fd8ace8f3426da7fa0d3eac`）
可见 `python3 -m unittest discover -s tests -v`、两个测试 `ok`、`OK`、
退出码 0、完成状态、文件变更，以及中文“帮我审批”。这是最新包对**已有 Run 的
重开显示**核验，不是该包内从头执行 N-02 全阶段；不能因此将 N-02 或 E6 判为完成。

串行全仓测试 `corepack pnpm --workspace-concurrency=1 -r test` 已走到末尾并结束；
观察到 Core 2035/2035、remote-client 9/9、mobile 28/28、CLI 68/68 的
最终摘要均无失败，Web 353/353、remote-protocol 40/40 及 typecheck 另行通过。
这次续接工具只保留了末尾测试输出，没有保留聚合命令的最终 shell exit code，
因此不能以此单独宣称全仓闸门完整通过。

继续检查私聊时，Cua Driver 无障碍树的主标题已变为 `Engineer`，但后台窗口捕获
仍显示上一普通会话的旧帧；短暂 `delivery_mode=foreground` 点击的恢复速度快于
Electron 重绘，截图仍未更新。Cua Driver 的只读 typed browser bind 返回
`browser_route_unavailable`，不能用同窗口 CDP 页面截图补证。依用户授权，
将**精确的 QA App bundle ID** 短暂置前、等候重绘、由 Cua Driver 捕获，
再恢复 ChatGPT PID 84715 前台后，已取得可信私聊窗口实图：
`/private/tmp/ling-e6-latest-private-reply-front.png`（SHA-256
`2c9879f7811fb0eb4d5686771eecd165f093b6a3c37cc994af1cb167d5e1664e`）。
图中只有 Engineer 回复，正文与两行 `python` fenced code 分开渲染，用户消息在右，
Engineer 消息在左，没有其他队友消息或工具行。

只读 SQLite 核验：`teammate_direct_messages` 的本轮用户和 AI 消息均绑定
`teammate_builtin_engineer`、同一 `dm_thread_a007aee1-bff0-4c70-b27c-4814159b91e2`；
`ling_threads` 归属 `thread_071c598b-b950-4ce7-b9f2-5e45baf077fa`，kind 为
`teammate_direct`、surface 为 `direct`、状态 `succeeded`；
`turn_19a52abc-699e-4285-95af-d5fce9afc81c` 与
`run_44ecb0e7-4ba9-4406-bfda-1d0d41ca1f2a` 均归属 Engineer。
该 Run 的事件只有 message/turn/run 生命周期及文本 delta，没有工具事件。

本次输入投递**不干净**：第一次后台 `type_text` 报 `delivery_failed`，
紧接着的前台重试之后 Composer 内出现重复提示词，随后 AX 发送按钮实际
提交了重复文本。是否存在迟到的后台输入尚未证实；也可能是 Ling 编辑器处理，
尚未归因；不能把此轮记为输入路径通过。P-01 仅记录“私聊归属、回复和代码排版”
局部通过，等价 N-02 的命令/文件任务、复制/hover 和重复输入根因仍待验。
没有修改源码或其他客户端数据，也未提交、推送或合并。

同一 Engineer 私聊再做一轮连续追问时，只调用**一次**前台 `type_text`，
没有后台失败后重试。客户端在后台的 AX/截图仍一度保留旧帧，但短暂置前刷新后，
Composer 正文与预期完全一致；一次 AX 发送后，SQLite 中用户消息原文恰好一次、
同一 `dm_thread_a007aee1-bff0-4c70-b27c-4814159b91e2` 的 Engineer 回复为
“收到第二次”，对应 `run_0886ab2f-4166-497f-b2e7-ce0b3f91703f`；
该 Run 仍只有文本和生命周期事件，没有工具事件。最终前台截图
`/private/tmp/ling-e6-latest-private-second-reply-front.png` 的 SHA-256 为
`d0edfff84b407b5270d4eb047950949fd22ad6262bef34a8e450291bebee880e`，
展示了连续两轮私聊、用户右侧与 Engineer 左侧、代码块及第二轮纯文本回复。
ChatGPT 再次恢复前台。此轮缩小了重复输入的原因范围：单次前台输入不复现，
但首次后台调用返回 `delivery_failed` 时究竟有无迟到输入，仍需 Cua 投递层证据；
不能据此直接判定 Ling 编辑器存在重复写入 bug。P-01 的连续纯文本/排版/归属
局部通过，完整命令/文件等价矩阵仍未结算。

### 2026-09-26 E6 P-01：私聊审批锚点与重复行的真实复测

在隔离 QA workspace 的 Engineer 私聊执行新的只读任务：顺序读取
`README.md`、`todo.py`、`tests/test_todo.py`，再运行
`python3 -m unittest discover -s tests -v`。Run
`run_7e07a668-bab9-4fe0-b562-6bbbcda9a21f` 中 3 组 read 的
`tool_start/tool_end` 均存在；命令在 `approval_requested`（seq 105）暂停，
审批 `approval_dbb53ab1-8827-45ba-9971-30198296706b` 经真实客户端选择
`approve_once` 后为 `approved`，随后 `approval_approved`、`tool_update`、
`tool_end` 和成功终态都已入 SQLite。测试输出为 2 项通过、exit 0，未写工作区文件。
等待截图 `/private/tmp/ling-e6-latest-p01-approval-front.png` 的 SHA-256 为
`6721db1f122942fffa68b049304e7503ca6c6a497457cb994d465bc9320da3c0`。

旧包终态前台截图 `/private/tmp/ling-e6-p01-terminal-front.png`（SHA-256
`007d9e0d128e4c2e5de437b8aa39062b86f735b07e66001b150d7846f0b86ae6`）
仍显示 `Activity unavailable`：审批记录和 RunEvent 已持久化，但该 Turn 的
`conversation_items` 只有 `user_message`，没有 `approval_request`/
`approval_decision`；共享 adapter 原来只查这两种 Item，导致审批缺锚点诊断。
Host 的 `ExecutionAction` 已有同审批 ID、Run、toolCallId、participant 和真实用户
Item 锚点，因此 adapter 现在只在上述身份唯一匹配且锚点属于同 workspace/thread
（已知 action turnId 时也必须同 Turn）时复用，不补造 Item 或放宽 projector 的
缺锚点门禁。第一版新包证明诊断消失，
但额外审批行跑到最终总结之后；第二版再以同一 action 承载审批状态，抑制这条
重复、错序的 supplemental 行。独立审批 Item 仍按原规则显示。

最终 macOS ZIP SHA-256 为
`1564465dfec8ac8939c7e907d944d970d17def8c03be237bef716c4a7590df38`，
独立签名 QA 副本为
`$HOME/Applications/Ling Stack E6 Anchor QA 20260926.app`；
`codesign --verify --deep --strict` 通过，`app.asar` 与最新 release 完全同哈希。
该包重开同一私聊后，前台终态截图
`/private/tmp/ling-e6-p01-terminal-final-bottom.png`（SHA-256
`b82441d95e299aa43c27e7628660ba07c206860812a196610f7aa40ef5cbccfc`）
显示 3 条 read、命令事实行、2 项测试通过的总结；无 `Activity unavailable`、
无总结后的独立审批行。ChatGPT 已恢复前台。`canonical-transcript-snapshot.test.mjs`
19/19、`canonical-transcript-projector.test.mjs` 58/58、Web typecheck 与 diff check
均通过；测试覆盖普通/私聊/频道的 pending/approved 和身份不匹配 fail-closed。
之后完整 `corepack pnpm --workspace-concurrency=1 -r test` 已以退出码 0 结束。

**结算边界**：这是新包对真实旧 Run 的重开投影验证，非在最终包里重走
pending→allow 的完整阶段。P-01 的 hover/copy、文件修改等价任务及首次后台输入
重复原因仍未结算；E6 的 20 个 case ID 也未全部通过。此轮未提交、推送或合并。

### 2026-09-26 E6 P-01：私聊审批卡误入右侧窄列

真实客户端截图显示待审批卡被挤到私聊右侧窄列、正文折行裁切。根因是
`TeammatePrivateChatSurface` 在待审批时用裸 `RuntimeApprovalComposerGate` 替换
正常 Composer；后者自带第 1 列、第 2 行的 `.teammate-private-composer-owner`，
审批卡没有这个布局容器，由 CSS Grid 自动放到后续列。现使审批卡复用同一
owner，不改变审批决策、运行或 SQLite 数据。`app.spec.ts` 增加 owner 归属和
主内容列几何断言：修复前 1/1 失败，修复后 1/1 通过；相关审批 E2E 12/12、
Web typecheck、Desktop build 与 diff check 通过。

修复版 macOS `dir` 包在
`/private/tmp/ling-e6-approval-layout.xoNKmg/mac-arm64/Ling Stack.app`，
`app.asar` SHA-256 为 `b56e94f16763f323ff2f07bb37c2dad033492cead8667e0d8b33ed9189e27143`，
`codesign --verify --deep --strict` 通过。**此包尚未替换/启动专用 QA 客户端，
因此真实 packaged GUI 重演与 E6 验收仍未通过**；截图中另见的
`Activity unavailable` 需继续按审批锚点事实链核对，不能由本次布局修复结算。

### 2026-09-26 E6 P-01：内部 provenance artifact 误入公开会话时间线

对 Engineer 私聊真实 Run `run_59b275b9-ca28-4073-9e1c-8881b56dcd22` 的只读投影中，
6 次审批均能归属各自的真实 action；另有 6 条 artifact 缺锚点诊断，来自 3 次文件修改
产生的 `Workspace forward/inverse patch plan`。这些 `.ling-stack/provenance/...` JSON
是 Host 用于恢复/撤销的内部证据，带 `sealedPayload`，不应作为会话交付物或伪造
conversation-item 锚点。原普通/私聊详情把 `listArtifacts` 全量返回，时间线便将其
当成可见 artifact 并报 `missing_anchor`。

现新增共享 Host artifact 可见性投影：普通/私聊 DTO 排除内部存储路径，且从所有
公开 artifact 移除 `sealedPayload`；TerminalReport 证据沿用同一内部路径判定。
共享前端 adapter 对普通、私聊、频道及 depth-1 子 Agent 再过滤内部 artifact；
真正的 workspace artifact 若缺锚点，仍显示 fail-closed 诊断。回归先失败后通过：
Web canonical snapshot 20/20、普通/私聊详情 24/24、TerminalReport evidence 25/25、
privacy 6/6，Daemon build 与 Web typecheck 通过，`git diff --check` 通过。
**尚未在修复版 packaged macOS App 重走文件修改任务；不能将此项标为 E6 通过。**

本轮从上述源码重新执行 `package:mac` 成功，ZIP SHA-256 为
`087c7b1809ef949f3cfe10209b256dfced194995bf2343e11cde00a96cfda11c`，
`app.asar` 为 `80ac49c5727050ed4810d51db9c31b5d267b534dc4ef54b0ce8d868d86ea1c44`，
Web `index.html` 为 `72569752f7fed8623df584dfcf3c121eab6f75eba21a323fdee8042d031d2f2a`；
`codesign --verify --deep --strict` 通过。隔离临时用户数据和工作区上的 packaged
continuity smoke 报告位于
`/private/tmp/ling-e6-packaged-continuity-HH1a9Hd5/report.json`，状态 `passed`：
启动、迁移恢复、SSE 断开/重连、safe/no-checkpoint/effect-unknown restart、SQLite
lineage 与 daemon restart 检查均通过。运行中的原 QA 客户端 PID 36412/36427
未替换、未退出；该自动 smoke 没有截图、hover/copy 或真实审批点击，不能代替
E6 的完整 GUI 案例矩阵。

另外使用原 QA daemon 的只读私聊详情（仍含 43 个旧公开 artifact，其中 6 个
内部 provenance）喂给当前共享前端投影，结果为 17 个可见 item、0 条诊断。
这证明前端保护能处理真实历史形状，但尚不是新包 GUI 的视觉验收。
本轮随后执行 `corepack pnpm --workspace-concurrency=1 -r test`，19 个 workspace
项目的测试链以退出码 0 结束；Web `check:i18n` 通过。测试覆盖不能替代
上述尚缺的真实客户端截图和交互阶段。
普通/私聊审批 Composer 与 TerminalReport 状态的针对性 Playwright E2E 另为 3/3。

后续只读审计发现 `automation-context/` 与 `external-work/` 同样属于 Host 内部输入材料，
不能作为会话交付 artifact。现将这两类保留路径纳入 Host 公开 DTO 与共享
TerminalReport 可见性判定；`media_jobs/` 的真实输出继续可见。新增回归先失败后通过：
Daemon artifact/TerminalReport 26/26、Web canonical snapshot 20/20、TerminalReport
privacy 7/7。**此改动发生在上述 ZIP 打包之后，旧哈希不代表当前源码；需重新打包、
验签并在真实客户端重演，不能据源码测试结算 P-01 或 E6。**

本次从最新源码重新执行 `package:mac`，退出码 0；新 ZIP SHA-256 为
`aeb081d1a101e7714d28d9c78e0557731c61525d708ca22cfef16b7f551ff253`，
`app.asar` 为 `723f44ba8c3f5cb13ce757167bbdce9c2a2d59784e93987e66e778ab538b00c6`，
Web `index.html` 为 `9a070b044480f15f399b2f4f5548611b6e0d8b95796948a4c889a01ba014179c`；
`codesign --verify --deep --strict` 与 `git diff --check` 均通过。私聊审批卡主列
几何定向 Playwright 1/1、Daemon 与 Web typecheck 通过。运行中的专用 QA
客户端仍是旧前端，故这些结果仍不能代替真实 packaged GUI 复测。
对该新包执行隔离 packaged continuity smoke，结果 `status=passed`，验证了启动、
恢复、SSE 重连、daemon restart 与终态报告；原专用 QA 客户端 PID 36412/36427
保持运行、未替换。最新 artifact/TerminalReport 定向回归分别为 26/26、7/7、20/20。
此自动 smoke 未真实点击审批卡，也未保存 E6 GUI 截图，不能将 P-01 或完整 E6
标记为通过。

本次额外执行全量 Web Playwright（单 worker）：1,035 通过、67 失败、26 未运行，
耗时约 39 分钟，**E6/PR 门槛为红**。失败分布在旧 Dialog/标题栏选择器、
频道会话与提案、设置/Profile、媒体等，不可一概称为产品回归或测试过时。
已按根因定向结算三个测试簇：自动化标题栏被 portal 到页面容器外（1/1 通过）；
无公开详情的 TerminalReport 应为静态行、复制仍可用（4/4 通过）；
频道文件恢复 mock 缺少已提交且与报告同 fingerprint 的 result Item，Host
按 lineage 隐藏报告正确，补齐 mock 后成功/失败恢复（2/2 通过）。
其余失败仍待逐项归因与回归，不能据这三个局部通过推算全量绿。
专用 QA 客户端仍未重启；真实审批卡位置、新包内部 artifact 与 E6 20 项
截图/语义状态/SQLite lineage 仍待验收。下一步先核对过时 Dialog 测试与新
Composer 契约的覆盖映射，再处理真实会话回归，并在获准重启专用 QA 客户端后
重走 pending→allow 与文件修改。当前不提交 PR、不合并。

### 2026-09-27 E6 接续：右侧布局不重做，Web E2E 分批归因

私聊审批卡主列几何修复维持既有 1/1 定向验证，本轮未重新修改布局。上次
Playwright 全量仍为 1,035 通过、67 失败、26 未运行，不能按局部通过上调
E6 或 PR 闸门。本轮第一批 304 通过、10 失败后按根因处理旧模型/标题栏/暗色/
语言选择器、智囊团重复入口和普通会话导航回执竞态；导航回执用例原连续
3/3 失败，修复后 3/3 通过。第二批 81 项为 75 通过、6 失败；Settings
标题栏、授权名称、推理摘要面板与频道摘要按钮状态已定向修正。

剩余 fork-and-run 用例中，mock 已验证 child Thread、Turn、Run、primary
turn-run link，页面也显示 `Working on Implement child branch immediately.` 与
`Working`；失败只来自断言查找已移除的 `Task in progress` 卡片名称。断言现按
共享时间线的 running 事实行定位；`runtime.spec.ts` 与 `settings.spec.ts`
合跑 **36/36**，Web `typecheck:ci` 与 `git diff --check` 通过。下一步继续
分批结算其他 E2E，再从最新源码重新打包、验签，做真实 packaged macOS
截图/semantic/SQLite lineage/脱敏日志四件套。此前仅凭
`app.asar=723f44ba…` 判定“对应旧源码”不准确：打包配置把 Web UI 单独放在
`Contents/Resources/web`，`app.asar` 相同不能证明 Web UI 新旧；应核对整包及
`Resources/web` 构建资源。专用 QA 客户端仍未替换或重启。

追加扫描：Web 全量按 10 失败阈值在 482/1,128 停止，472 通过、10 失败、
646 未运行；后半 shard 在 115/563 停止，105 通过、10 失败、448 未运行，
两次结果不能相加充当全量通过。频道三处和会话面板三处旧断言仍把已收起的
Summary 标为 pressed；频道两处旧 `.message-bubble` 已更新为共享时间线的
protocol/approval 事实行，详情与重试定向 **3/3** 通过。`channel.spec.ts` 的
Summary 定向 **3/3** 通过。旧 `ui2-channel-proposal-input-migration.spec.ts`
只测试正式设计排除的编辑 Dialog，已从本分支删除；新 Composer gate 的
摘要重选、Allow/Deny、无 Edit/旧 Dialog 已由 `channel.spec.ts` 覆盖。
其他扫描红项分开记录：媒体预览 loading/Vite 开发客户端控制台错误、Sidebar
Recent 高度变化、智囊团延迟加载可见性、Full Access 旧“选择即确认”断言。
这些尚未逐项结算；没有据此变更产品 UI 或上调 E6 状态。

### 2026-09-27 E6 接续检查点：右侧布局冻结、测试入口归因

本轮遵用户要求没有重做右侧审批卡布局。仅调整 Web E2E 的过时合同：
协议重置 Dialog 关闭后再跨频道导航；Summary 隐藏时不要求 `aria-pressed`
为 true，空间恢复后不额外点击以免反向关闭；普通会话 identity 断言跟随
`initialReasoningSummary`、`initialAuthorizationMode` 的真实依赖；频道审批和
执行提案分别按 Composer gate 而非旧 Dialog 验证；blocked workflow step
按 Start/Start + run/Cancel 与 blocker 文本验证；Council/Media 的 loading
改为显式 Promise gate，避免 350–420ms 瞬态断言。相关定向复验已通过，
Web typecheck、production build 与 `git diff --check` 均通过。

生产预览完整扫描在 629/1126 通过、20 失败、477 未运行及一个非用例错误时
触发失败阈值。**不能据此判定 20 个产品故障**：同一批 20 个红项在 Vite
开发服务器下复跑 **20/20 通过**。其中多 Agent display-only demo 在
`channelWorkCellDemoFixtureEnabled()` 由 `import.meta.env.DEV` 明确限制，
生产预览下不存在；`public-asset-url` 用例也显式验证开发服务器资源路径。
因此这套 E2E 目前混有 dev-only 和 production 预览假设，不能把生产预览
运行视为唯一验收入口，也不能放开生产包的 demo 注入开关来迁就测试。

唯一续做起点：完成当前开发服务器下的 1126 项完整扫描，结算其实际红项；
再按最新源码重新打 macOS 包、核对 `Resources/web`/`app.asar`/签名，在
隔离 QA 客户端完成 E6 20 case 的真实截图、semantic-state、SQLite lineage
和脱敏日志。以上测试结果未替代 packaged GUI 验收；不提交、推送或合并。

### 2026-09-27 E6 新包启动与验收接续

右侧审批卡布局继续冻结，本轮没有改相关 UI/源码。旧 QA 客户端
`com.lingstack.desktop.e6anchorqa20260926` 已确认退出。最新 ZIP SHA-256 为
`3106fb7929a0340250047cb7d644f8200407381a8c9dcea3b1fe5ae385a82828`；
独立副本位于 `$HOME/Applications/Ling Stack E6 Latest Review 20260927.app`，
其 `app.asar=723f44ba8c3f5cb13ce757167bbdce9c2a2d59784e93987e66e778ab538b00c6`、
`Resources/web/index.html=1be4492aa84b0f2810481f754e049e0362221f16dea16f787fa6bfcfb9cb6e85`。
副本初始把 `CFBundleName` 和 `CFBundleDisplayName` 同时改成长 QA 名时，
Electron 启动触发 `SIGTRAP`（崩溃报告 `$HOME/Library/Logs/DiagnosticReports/Ling Stack-2026-09-27-050126.ips`）；
仅将两项恢复为标准 `Ling Stack` 并对该独立副本重新签名后，进程 PID 31020、
窗口 40302 正常产生，QA daemon `GET /health` 返回 `ok=true/readiness=ready`。
这证明启动与副本元数据组合相关，尚未单独隔离两个名称字段，不能断言是其中
某一个字段的 Electron 根因；未改 release 原包、旧 QA 副本或产品源码。

隔离 packaged continuity smoke 已保存到
`output/e6-20260927-packaged-continuity/report.json`，14/14 检查通过，覆盖启动、
迁移恢复、SSE 断开/重连、三种 restart 结果与 SQLite lineage。此 smoke 使用隔离
fixture/relay，只证明真实 packaged 进程链及数据事实，不是 20 个 E6 GUI 案例。
目前 Mac 锁屏，Cua Driver 对窗口 40302 返回 `ax_window_unresolved`、
`px_capture_unavailable`，另一 GUI 入口也明确要求用户手动解锁；
因此截图、hover/copy、审批点击及 N/P/C/A/R/F 等真实 GUI 案例仍为 `not_run`。
已请求用户解锁，之后从该窗口继续采集 screenshot/semantic-state/SQLite lineage/
脱敏日志，不以健康检查或 smoke 报告冒充 GUI 验收。本轮未提交、推送或合并。

### 2026-09-27 E6 最新源码与新包回归（GUI 仍待解锁）

右侧审批卡布局保持冻结，未再次改动。Web 完整 E2E 在修复媒体视频预览
`NETWORK_NO_SOURCE` 偶发永久 loading 后，第二轮为 **1127/1127 通过、0 失败、
0 跳过**；结果位于 `output/e6-20260927-web-e2e-postfix.json`。此前导入主题单次
超时在独立重复 10/10 中未复现，没有据此改产品代码。仓库 typecheck、文档链接、
许可证、公开仓库安全、依赖安全、本地化与 diff check 均通过。

最新 macOS ZIP 的 SHA-256 为
`2590c58a70db5c12eed279c75958799033b08ac90da27279de27991bdcf7caf0`，
`app.asar` 为 `b875d31fb0316d8fa3361a8a20dff587124c81cb01a08b9f33c040b29836f4d0`；
包内 `Resources/web` 与当前 Web 构建一致，`codesign --verify --deep --strict` 通过。
对此新包重新运行独立用户数据/工作区的 packaged continuity smoke，报告
`output/e6-20260927-packaged-continuity-postfix/report.json` 为 **14/14 通过**，
包含 SSE 断连/重连、三种 restart、SQLite lineage 与 daemon restart；未触碰仍在运行的
旧专用 QA 客户端 PID 31020。另有 Core 45/45、Daemon 45/45、Desktop 17/17
项定向回归通过。

真实窗口 40302 仍存在，但系统会话报告 `CGSSessionScreenIsLocked=Yes`，Cua Driver
返回 `ax_window_unresolved`，窗口截图亦不可获取；目前无法可信地执行
hover/copy、审批点击或截图验收。
因此 E6 的 20 个真实 GUI case ID **仍未结算**，不能把自动化 1127/1127 或
packaged smoke 14/14 称为 E6 完成。解锁后先让最新包进入隔离 QA 客户端，
保留旧历史，再按 §6.3 逐项记录 screenshot、semantic-state、SQLite lineage、
脱敏日志和 `case.json`。本轮未提交、推送或合并。

为解锁后继续，已在后台从最新 `release/mac-arm64` 复制独立测试 App 到
`$HOME/Applications/Ling Stack E6 Postfix QA 20260927.app`，只给副本设置唯一
bundle ID `com.lingstack.desktop.e6postfixqa20260927`，保留标准显示名 `Ling Stack`
以避开上轮自定义名称启动异常，并重新临时签名。副本 `app.asar` 与
`Resources/web/index.html` 的哈希均与最新 release 对应文件一致，深度验签通过。
**副本尚未启动；旧 QA 客户端和历史未被替换。**

### 2026-09-27 E5/H1 续做：真实回复输入预算门禁

目标附件的 E5 还包括摘要失败、单次长 Run 压缩、Memory 新鲜度与统一工具结果预算；
不能将 E6 当作唯一剩项。按当前源码复核，Memory 召回已按 scope/健康状态筛选并有
超过 500 条、中文词法、撤回等回归；Pi `session-factory.ts` 仍设置
`compaction.enabled=false`，H2 未闭环；H4 仍没有跨工具统一模型结果预算与按需读取。
原频道 hard 摘要虽有 typed execution result，`messages.ts` 未消费该结果形成最终容量门禁。

本轮先落地 H1 的一段必要链路：频道无工具回复在摘要、Web 证据、Memory 和 system
文本全部拼装之后、创建 Run 之前，按选定模型输入预算检查实际 prepared input；
无有效预算或超额 protected pack/完整输入显式 blocked；未声明容量的兼容模型
沿用 Host 的 8,192-token 保守窗口（不是精确容量承诺），小输入可继续，超出
保守预算则 blocked。context-length 后的
compacted retry 也走同一检查，不能绕过。新纯策略 4/4、SQLite/Host 集成 1/1
（超预算不调用 provider、不创建 Run）、摘要/Memory/12 轮历史相关定向共 55/55，
频道全量首轮 223/223，Daemon build:ci 与 diff check 通过。随后核对真实 QA provider
为未声明容量的 `openai-compatible` 模型；此前严格未知容量拒绝会使正常频道回复阻断，
因此已将其调整为上述保守门禁，并撤回为迁就严格门禁而增加的测试 fixture 容量字段。
最后调整后 Daemon build:ci、预算纯策略/集成 5/5、未知模型视觉摘要、hard 摘要与
context-length retry 定向 3/3、diff check 通过。频道全量 223/223 属于调整前一次运行，
不能冒充最终代码的全量复测；后续与 H1 其余链路合并后再跑完整套件。

**H1 仍未完成**：hard 摘要的 typed 失败结果尚需进入可追溯观察/恢复与最终预算判定，
其他执行入口的 system/tools 预算和 H2/H4 仍待实现。由于上述源码变更发生在上一节
ZIP/QA 副本准备之后，那个包与副本现在是旧构建，不能用于本轮变更的 packaged GUI
验收；待可靠性链路收敛后重新打包、验签、替换隔离副本。Mac 仍锁屏，E6 真实 GUI
案例仍未结算。本轮未提交、推送或合并。

### 2026-09-27 E5/H1 接续：hard 摘要结果与当前输入保护

右侧私聊审批卡布局没有再次改动；其主列几何定向 Playwright 重新运行 **1/1 通过**。
真实 packaged GUI 尚未在最终源码重演，不能据此结算 E6。

hard 摘要的 typed `completed`、`generation_failed` 等结果现记录在已认领的
`channel_turn_dispatch` attempt 的 fenced `work_unit_progress` 事件；无法压缩的
`no_eligible_prefix` 也记录。摘要规划异常不再吞为 `undefined`，交由派发 worker
产生可见 blocker。摘要失败后仍使用已提交摘要与权限过滤后的当前投影，最终
prepared-input budget gate 决定能否创建回复 Run；失败不授权丢弃事实。

针对性回归先发现一个实际安全缺口：`buildContextPack` 过去会将 `priority=must_keep`
的当前用户输入当作可丢弃的 `summarize` section，长请求因而可能在模型未收到原文时
显示成功。新增测试修复前失败（应保留的 section 实际为 `[]`）；现预算不足时
保留该 section 并标记 `overBudget`，上层显式阻断，不能静默缩短当前要求。
成功摘要、失败后预算内回复、无可压缩前缀且超预算阻断三项集成/定向回归 **3/3**；
Daemon `build:ci` 与频道相关完整测试 **364/364** 通过。Daemon 全量随后
**2044/2044** 通过；该全量启动后又补了一个只影响事件归属的细节：在摘要异步等待
之前捕获派发 attempt fence，防止旧结果错误记到新 attempt。最终源码的 `build:ci`
及摘要/预算定向 **3/3** 再次通过，全量测试尚未对这个最后细节重新运行。
没有提交、推送、合并。

下一步仍是 E5 的单次长 Run 压缩与统一模型工具结果预算；Pi SDK 的自动阈值压缩
在当前依赖的行为是 **agent run 结束后** 才触发，直接把
`session-factory.ts` 的 `compaction.enabled` 改为 `true` 不能证明长任务中途安全压缩。
真实 SDK 隔离生命周期测试本轮再跑 **16/16**，其中同时确认手动 compact 会中断活跃
工具且不会自动续跑、overflow 仅有界重试、取消须覆盖独立摘要请求。
H4 入口复核也确认 Pi 0.84.4 的 `tool_result` hook 替换 `content` 后，SDK 使用替换值
形成后续 `tool_execution_end`；不能直接在现有 Hook 裁剪并把该事件仍称为完整 Host
证据。下一切片要把完整原子事实与有界模型视图分离，再统一 read/search/exec/MCP/dynamic。
这些链路收敛后才重新打包、验签、做 E6 20 个真实 GUI case 的四件套。

### 2026-09-27 E5/H2 接续：压缩生命周期的原子证据（未开启自动压缩）

右侧私聊审批卡布局保持冻结；本切片没有修改 UI。Pi SDK 0.84.4 的
`compaction_start/end` 与 assistant `message_end.usage` 已通过 Runner 白名单投影
进入 typed RunEvent；Host 从当前执行 fence 填入 `attemptId`，SQLite 保存有序事件。
公开事件仅包含触发原因、`sdk_installed/aborted/failed`、SDK 是否打算 retry、
整数 token 计数和桥接策略版本，不包含摘要正文、provider 原始错误或 SDK Session。
`sdk_installed` 明确只表示 SDK 内存摘要已安装，**不是 Host 可恢复 checkpoint**。

真实 SDK fixture 覆盖成功/失败与私有内容不外泄；Core 回归证明跨连接读回顺序、
旧 Attempt 无法追加结束事件；Daemon fixture 验证 Runner→Host 归属。
Contracts 85/85、Runner 184/184、Core 执行准入 23/23、Daemon continuation
14/14、Daemon 全量 2044/2044，相关三包 `build:ci` 与 `git diff --check` 通过。
未测试真实模型或 packaged GUI；没有提交、推送或合并。

仍须完成：单次 Run 中途安全压缩的模型边界、Host checkpoint 内容和 CAS、
审批/必答/取消让出与 daemon restart 续接。不能只打开 `compaction.enabled`：
SDK 在工具轮次之间也可能触发 threshold 压缩，是否成功取决于安全 cut point；
手动 `compact()` 会中断活跃工具且不会自动续跑。H-02/H-05/H-06 与 E6 仍为 `not_run`。

### 2026-09-28 E5/H2/H4 接续：检查点身份、证据校验与 artifact 流式读取

右侧 UI 保持冻结，未重复修改。Run compaction checkpoint 的重复创建现核对完整恢复
身份（模型、策略、目标、约束、前驱和未决关联），而非只靠事件键返回旧行；回归先红后绿。
Daemon 恢复评估复算 sealed snapshot/summary 摘要并核对 payload lineage，权限漂移、
workspace 水位变化、未知副作用和摘要篡改均 fail closed。没有开启自动压缩。

H4 的 artifact 无范围内容请求曾同步读取整文件；现改为有背压的流，保留媒体和下载
完整响应；显式范围仍限制 1 MiB。2 MiB 完整响应与范围读取专项通过。Run artifact
列表/单项元数据、RunEvent 历史和 live SSE 现也不再传出 `sealedPayload` 或其 SHA-256
指纹（回归先红后绿），
Host SQLite 事实未改。这**不是**
participant/action 授权或每请求总传输预算的完成证明。真实 SDK 新增反例说明
`agent_end` 后压缩视图末尾可能是 assistant，重启后不能盲目 `agent.continue()`。

Core 全量 1001/1001、Runner 全量 193/193、Daemon 单文件并发全量 2048/2048、
Core/Daemon build/typecheck 和 `git diff --check` 通过。Daemon 默认与四文件并发在
此机出现环境争用；孤立重跑相同审批案例通过，因此最终使用单文件并发结果。
H2 下一步是下一次模型请求前的独立 provider-dispatch fence、真实摘要/精确模型视图
原子 checkpoint，以及区分“已完成收尾”和“工具循环续接”的恢复。H4 剩余
授权与总预算。E6 20 个最新 packaged macOS GUI case 尚未完成，不得宣称验收通过。

### 2026-09-28 E5/H2 真实 SDK 切点反例

此前把 threshold 压缩概括为“只在 `agent_end` 后”不准确。Pi 0.84.4 在每次
工具轮次与下一次 assistant 请求之间也尝试压缩；当最近工具结果大于保留窗口时，
无法形成可用 cut point，才推迟到结束。真实 SDK fixture 用
`keepRecentTokens=200` 复现最后一个工具执行前压缩，摘要请求后继续任务请求；
同文件另一用例保留无切点时的结束后压缩，并证明 `enabled=false` 两者都不触发。
中途摘要失败后 SDK 仍可能继续下一次任务请求，故 provider dispatch 必须独立拒绝
未提交 checkpoint 的请求。专项 21/21 通过。右侧 UI 未改；Host 提交、
fenced recovery 和 E6 GUI 均未结算。

Daemon 的 `before_provider_request` 现对本 Run 已结束却尚未提交 Host checkpoint 的
压缩边界 fail closed（成功摘要映射 `checkpoint.missing`，失败/取消映射
`checkpoint.compaction_failed`）。现有 Runner task boundary 会把 Host 回调失败锁存到
实际 provider transport 前。Runner 全量 196/196、Daemon 串行全量 2048/2048、
Daemon build:ci、continuation integration 17/17、`git diff --check` 均通过；
此门禁不等于真实 checkpoint 已提交或自动压缩可开启。

### 2026-09-28 E5/H2/H4 实现继续：恢复视图安装与 artifact 访问边界

H2 已从“只阻止误续跑”推进到可验证的 Host 恢复：Daemon 读取并校验 sealed
compaction checkpoint 后，把精确 model view 传入新的 Pi Session，不重放原始 prompt。
assistant 末尾只收尾、不发送 provider 请求；toolResult 末尾才继续一次工具循环。恢复
视图的 toolCall/toolResult 配对、末尾状态、容量、Run/Attempt lineage 均在 Runner 边界
再次校验。Daemon continuation integration 17/17，Runner adapter compaction recovery
专项通过。右侧私聊 UI 未重复修改。

H4 artifact 路由现在要求显式 `cwd`，同名 artifact 不再从已打开的 sibling workspace
store 解析；可选 `runId`、`participantId`、`workflowStepId`、`actionId` 必须能由 Run
或 ExecutionAction refs 证明归属，否则 404。完整无范围下载超过 8 MiB 返回
`artifact_transfer_budget_exceeded`，范围读取最多 1 MiB；realpath/symlink 根目录校验
保留。新增边界回归覆盖缺 cwd、错误 Run/action 和超预算下载。

本次仍不宣称 E6 完成：H4 的全工具入口模型上下文剩余容量门禁、最新 packaged macOS
GUI、SSE reconnect、daemon restart 和 20-case 视觉矩阵仍待真实验收；不提交 PR、不合并。

### 2026-09-28 E6 接续：审批 post-commit 迁移冲突修复与新包

真实 packaged macOS 的临时文件审批首次重演暴露 `no such table:
approval_postcommit_effects`。根因不是审批回调本身，而是旧分支已占用 SQLite migration
version 139（`create_delegation_tree`），新表也错误复用 139；数据库记录了该版本但表并
不存在，导致迁移被误判为已完成。现将 post-commit ledger 正式迁移改为 version 144，
并增加“版本已记录但表缺失”自修复检查；新增冲突回归覆盖删除表、伪造旧 139 记录后重开
store 的场景。Core approval-policy 定向回归 **76/76** 通过，随后包含 checkpoint、
approval recovery、compaction 和 continuation 的聚焦回归为 Core **83/83**、Runner
**43/43**、Daemon **160/160**。

从当前未提交 WIP 重新打包 `package:mac` 成功，arm64 ZIP SHA-256 为
`5f64cb03c6c2c451149933e1d7935613362cd01705c23d25e85c35f99979c80e`，DMG SHA-256 为
`1e3142041fea8c0a6561652d34d54b0d32e92e80c88b5f7f450d6789b557d893`；构建 `.app` 通过
`codesign --verify --deep --strict`。第一次打包因 Electron 下载网络超时退出 1，重试后成功，
不把失败包当作新包证据。

当前 macOS 会话仍处于锁屏，Cua Driver 返回 `Mac is locked`，所以尚未用真实客户端重启
或点击审批，也没有用 `open`、AppleScript、kill 等方式绕过 UI 验收。右侧私聊布局本轮
保持冻结；解锁后只补迁移修复对应的审批→文件证据→终态截图、SQLite version 144/table
读回，再按 E6 20 个 case 的剩余顺序继续。未提交、推送或合并。

同日继续 H4 的模型视图耗尽边界：3 条非空工具结果、总预算 40 bytes 的旧投影把前两条
直接变成 `[]`；现在每条被裁剪的结果必须有明确标记，标记预算不足则在 Provider 前拒绝，
完整小结果照常保留。Runner 全量 **203/203**、`build:ci` 与 `git diff --check` 通过；
细节记于 `harness-context-reliability-integration.md`。此改动后再次执行 macOS `package:mac`
成功，新 ZIP SHA-256 为 `c5955cf45eba029d329928d37f25e1bcb1917d8076dc341b56c92f9ed7056a1e`，
DMG 为 `47cc4bfa27c8fedb140bab58c2817cde240e70076312a024fef5461bc99e1bcc`，
`.app` 严格验签通过。Mac 此时仍锁屏，**尚未启动或交互验收这个新包**；上段旧包
哈希不得再用于最新源码的 E6 结论。

### 2026-09-28 E5/H4 接续：按实际剩余容量裁剪模型视图

右侧私聊布局保持冻结，本切片没有重做 UI。Runner 原先把 SDK 的工具结果固定裁至
24 KiB/项、96 KiB/请求，然后仅检查整份模型输入容量；小上下文模型即使进一步裁剪
结果即可继续，也会在 Provider 前被拒。审批恢复的首个请求还有第二处接缝：SDK
`context` hook 已裁剪大型结果，但 prepared-input 校验仍拿完整 Host 结果比较，误报
“approved tool continuation changed”。两项均由新增测试先红复现。

现在 Provider 边界基于 system、tools 和当前消息估算剩余容量，对 transport-only
工具结果视图进一步收紧，保留每条非空结果的明确截断标记；Host/SDK 原始工具事实
不被修改。审批恢复校验与 SDK 固定投影对齐，随后才执行动态收紧。另对投影副本
做发送前指纹复核，阻止后续 hook 修改 system/tools/messages 逃过 prepared-input
校验。Runner `build:ci` 与全量 **205/205** 通过，`git diff --check` 通过。

这只结算 H4 的模型发送边界，不代表 Host 跨工具统一 artifact 预览/按需读取和
E5/H2 自动压缩已完成。最新 macOS 包仍是上文 `c5955c...` 版本，**不包含本切片**；
必须在其余可靠性链路完成后重新打包并用真实客户端验收，不能沿用旧包截图。

### 2026-09-28 E5/H2 接续：压缩前未结束工具门禁

Host 的 `commitInstalledRunCompaction` 已检查 `activeToolCallIds`，但 Orchestrator
原来恒传 `[]`，让一个只有 `tool_start`、没有 `tool_end` 的 Run 仍提交恢复 checkpoint。
新增 Daemon 集成反例先在旧构建上失败，确实观察到错误提交；现在从已持久化的
`tool_start/tool_end` 事件跟踪本 Attempt 的活动计数和孤立结束事件，再把未配对 ID
传给提交门禁。未结束工具被判 `checkpoint.effect_unknown`，下次模型请求被拒；
已完整结束工具的对照用例仍可提交。Daemon continuation integration **17/17**、
串行全量 **2049/2049**（exit 0）和 `build:ci` 通过。自动压缩仍关闭，尚未做真实 SDK→Host→SQLite→重启的同包联测，
因此不将 H2 或 E6 标为完成。

### 2026-09-28 E5/H2 接续：三种恢复权属与自动压缩准入

右侧私聊审批卡布局已冻结，本节未修改 UI。先红复现：已提交压缩 checkpoint 的
`conversation_run`、`teammate_direct_reply` 在 SQLite 重开时被 Core 的旧
`task_run` 专属保留条件先标为失败，Daemon 恢复扫描又只看 `task_run`；即使扩充扫描，
Orchestrator 原先仍要求真实 Task 行。现在 Core 保留受 enforce Harness 管理的普通/私聊
Run，Daemon 只扫描 `task_run`、`conversation_run`、`teammate_direct_reply`，并以
Run/WorkUnit/Attempt fence 和现有幂等键唯一接管。无真实 Task 行时使用冻结的
`taskSnapshot`，仅对非 `task_run` 的 daemon recovery 放行；频道
`channel_ai_reply` 仍由 channel dispatch 的 stale child 替换流程拥有，不双重接管。

集成反例修前普通/私聊 2 项失败、修后 2 项通过；频道排他 1 项通过，相关 Core、
Daemon、频道定向套件合计 74/74。Runner 增加 Host 自动压缩显式 opt-in：默认关闭，
只有 enforce continuation、稳定 `contextViewId`、真实 Pi Runner，且带 Run/Attempt
身份、事件回调和 provider admission fence 才开启。SDK Session 开关测试先红后绿，
缺门禁时拒绝启动；`RunRequest` 类型不接受该 Host-owned 开关。Runner 全量 207/207、
Core 全量 1002/1002、Daemon 串行全量 2052/2052 通过。随后新增私聊队友归属
防串线校验，普通/私聊/频道/私聊错配定向 4/4 和 `build:ci` 通过。Core 全量首次的
3 项迁移测试失败源于模拟回退仍断言最高版本为 134/138，而当前 schema 已到 144；
测试改为检查目标旧版本存在、新版本缺失，17/17 定向及全量复测通过，不回退真实迁移。

**未结算**：真实 Pi SDK→Host→SQLite 的自动压缩长工具循环、
失败/取消/重启且无重复副作用的同包联测；最新源码重新打包、验签和 E6 packaged GUI
20-case 证据。旧包 `c5955c...` 不包含本节，不能用于本节的 GUI 结论。未提交、推送或合并。

同日追加 H2 反例：SDK 压缩后可继续工具循环；若压缩 checkpoint 后已有成功
`tool_start/tool_end`，旧恢复校验会误判为 `verified` 并可能重跑该工具。测试先红，
现按 RunEvent sequence 分页核对 checkpoint 后续进度，跨 1000 条 benign 事件仍能
发现完成工具并返回 `checkpoint.effect_unknown`。对应设计已补入
`harness-context-reliability-integration.md` §4.1：后续需在压缩后的每个安全工具轮次
提交 progress checkpoint，恢复只能从最新安全视图继续；当前 fail-closed 门禁不等于
该进度链已实现。新增专项 4/4、Daemon `build:ci`、`git diff --check` 通过；此后未重跑
2052 项全量，不能把先前全量结果冒充新门禁的完整回归。

### 2026-09-28 E5/H2 接续：工具轮次 progress checkpoint 与跨 Attempt 恢复

右侧私聊布局继续冻结，未修改 UI。Runner 在 `before_provider_request` 将 Host-only 的
SDK 模型视图传给 Daemon；压缩后每轮工具完成时，Host 核对新工具配对、视图前缀、
未决审批/问题/命令、权限与运行所有权，在下一次模型请求之前把视图和 RunEvent 水位
封存为现有 `run_compaction_checkpoints` 的 successor。旧压缩摘要不再能跨过已完成工具
重新执行。恢复验证会沿 predecessor 检查 sealed digest、事件中的工具 ID、原始压缩
安装事实，并只安装最新安全视图。daemon restart 的新 Attempt 可以在已核验的恢复
输入下推进旧 Attempt 视图；未授权的跨 Attempt 接管被拒绝。无需新 SQLite 表。

新增反例和真实链路：真实 Pi SDK 恢复后执行 `read`，第二次模型请求前 SQLite 已提交
进度 checkpoint；再次重启只从该 checkpoint 继续，已完成工具不重放；另有连续两轮
工具、错误模型视图、无授权跨 Attempt、取消后不提交的回归。真实 Pi SDK 的 14 次工具
长循环触发自动压缩并继续执行；恢复后的工具取消等待收束且无第二次请求。失败的内置
`read` 被保留为错误事实、允许模型继续纠正；失败的 consequential tool 仍 fail closed。
Runner 全量 210/210、Harness 定向 29/29、Core checkpoint 定向 4/4、Core 全量与
Daemon 串行全量重新运行通过。`git diff --check` 通过。测试使用本地隔离 SQLite 与无网络
真实 SDK provider 传输，不是用户凭据、真实外部模型或 packaged GUI。

**未结算**：自动压缩、失败/取消/重启混合于同一次真实 Host Run 的无重复副作用
联测；E6 20 个 case 的最新 packaged macOS 四件套。旧 QA App 不含本次改动，
不能用于验收。本轮未提交、推送或合并。

### 2026-09-28 E6 新包普通会话 N-01 接续检查点

右侧私聊审批卡布局已有主列容器修复及修复前红、修复后绿的几何回归；按用户要求冻结，
不再重复改动。专用新客户端 `Ling Stack E6 Progress QA 20260928.app` 使用独立
`userData`、工作区和端口 17928，已在真实 packaged GUI 中运行。N-01 同一
`thread_3929b3ae-0b1f-484f-ad83-c07ffe7b449e` 连续三轮真实模型回复均成功；
`output/e6-20260928/N-01/` 保存 `terminal.png`、`plain-path-followup.png`、
`short-turn.png`、`reopened.png`。可见 Markdown 标题、段落、列表、inline/fenced
Python、链接、纯文本路径 basename/icon、用户与 Agent 轨道，以及重开后历史。
专用 SQLite 中每轮各有一条用户和助手 Item；第一轮 138 条 RunEvent 且无工具调用。

**N-01 仅局部通过**：路径 hover 完整地址、复制按钮/复制内容、完整
`semantic-state.json`、`lineage.json` 与脱敏日志仍待补齐。下一步只补这些断言与
证据四件套，然后推进 N-02 的真实 read×3、command start/update/end、文件 diff；
H2 另需自动压缩与失败/取消/重启混合于同一次真实 Host Run 的无重复副作用联测。
不能把此前 Core/Daemon/Runner 全量单测、旧包截图或本轮 N-01 局部结果当作 E6 通过。
同轮补证：短答的复制按钮在指向消息后出现；后台 AX/像素点击未写剪贴板，
经此前允许的短暂前台点击后读回 `收到`，QA App 随即退回后台。`N-01/` 已补
`case.json`、`semantic-state.json`、`lineage.json`、`logs.redacted.txt`，其中未知
renderer/viewport 字段明确 `null`，整体仍为 `not_run`，不以文件齐全冒充断言通过。
随后 macOS 切换到另一 Space，驱动对窗口 832 返回 `off_space_or_ax_unresolved` 并
拒绝后台操作；N-02 尚未发送提示。已在隔离 QA 工作区准备三个无敏感数据的输入文件，
等待可操作窗口后让真实客户端 Agent 读取并完成代码/测试。期间继续 H2 同 Run 联测。

### 2026-09-28 E6 N-02 接续：真实两轮任务、Run diff 出口及新包点击验证

上一检查点之后，专用 packaged macOS 客户端在同一 Thread 完成两轮真实任务：首轮
分别读取三个输入文件、创建小型 Python 项目并经审批运行 8 项测试；续问读取已有文件，
两次失败编辑保留为事实，随后两次编辑成功，经审批运行 10 项测试。两轮 Run 均为
`succeeded`，但续问的 TerminalReport 因两次失败尝试保留 `partially_succeeded` 和
2 条风险；测试成功不应抹掉失败历史。`output/e6-20260928/N-02/` 留有运行、审批、
终态、编辑行和差异查看的真实截图及四件套记录。

新发现：续问成功编辑动作已有各自的 `resultArtifactIds` 和真实 `text/x-diff`，
Web 投影的专项测试也通过，但 Daemon `projectConversationArtifacts()` 在普通/私聊
详情出口先过滤全部 `${runId}/...` 内部 artifact，使 GUI 只有“打开路径”。新增
Daemon 出口、普通会话和私聊回归，先红后绿；现在只放行同 Run、唯一编辑/写入
动作明确关联的 `.diff/.patch` 元数据，仍剥离 sealed payload 和摘要，未归属
Run 内部文件继续隐藏。定向 28/28、Daemon 全量 2064/2064、打包与严格验签通过。
最新 ZIP SHA-256 为 `8760ca4a63b50fa85d5d13668eea809871459453383c3cc84c7e9a56602a3175`；
专用 App 保留原 userData 重启，已在真实 GUI 展开两条成功编辑行并点击各自的
“查看 diff 详情”，右侧显示真实红绿差异。新包点击截图见 `screen-26-real-diff-verified.png`
与 `screen-28-real-tests-diff-open.png`。原 QA App 移至
`$HOME/.codex/ling-qa-app-backups/Ling Stack E6 Progress QA 20260928.pre-daemon-diff-fix.app`，
可恢复；未清理历史数据。

**N-02 仍未整项通过**：两轮执行先于最新包，最新包重开验证 diff；实时命令
`tool_start/tool_update/tool_end` 的同一行变化、全部布局/披露语义及“全阶段同一
最新包”尚未完整证明。E6 全 20 case 和 H2 同 Run 自动压缩+失败/取消/重启
混合联测仍未完成。右侧私聊布局依用户要求冻结，不再重复修改。本轮未提交、推送或合并。

### 2026-09-28 E6 N-02 新包实时命令输出复测

旧包真实命令 `run_9c2f0167-09e7-4efe-aae5-54018bd3de25` 的三段短输出，直到命令结束
才生成一条 `tool_update`。根因是 Daemon 命令输出脱敏前固定保留 256 字符，短行一直留在
缓冲。现在完整安全行可立即脱敏并发出；跨行 Authorization 值和显式多行密钥仍保留到
安全边界。专项先红后绿，21/21；Daemon 全量 2067/2067 与 `build:ci` 通过。

新 macOS 包 ZIP SHA-256 `05609198520ab31cbc2bd2ce747a7dd471ac06c316957ef1b70d2868ff921d32`，
`app.asar` SHA-256 `9a86dea26ef1b8974afebec905250570bf4267d226d5eb50b9b20d3f1f0faf51`。
专用客户端保留隔离 userData 与历史受控重启，旧 App 备份为
`$HOME/.codex/ling-qa-app-backups/Ling Stack E6 Progress QA 20260928.pre-stream-fix.app`；
新副本严格验签通过。在真实 GUI 的同一 Thread 新增运行
`run_17fb015b-8471-41ac-b13d-ea0cdd81307d`：操作行仍显示“处理中”时，AX 已显示
`E6-N02-LIVE-A`。SQLite 随后在 seq 11/12/13 分别记录相隔约 8 秒的 A/B/C 三条
`tool_update`，seq 17 才 `tool_end`；Run 成功、退出码 0。故“短输出只在结束后出现”的
原问题已由真实 packaged GUI 和持久证据复测通过。运行中各阶段截图未落盘，不能冒充
完整截图证据。

N-02 整项仍未结算：所有阶段在同一最新包的重新执行、完整折叠/展开与 viewport
归属断言仍缺；E6 的 20 项案例和 H2 同 Run 混合联测仍未完成。右侧布局继续冻结；
本轮未提交、推送或合并。

同一最新包另起隔离 Thread `thread_ff83e1b2-d8e1-4c94-9eed-082b4c50cbb5` 的
完整小项目复测。真实 Host Run `run_a196711f-31eb-433a-b6cb-2414053a7244` 已产生
三次独立 `read`、一次目录列举、一次目标测试文件不存在的失败读取和一次成功的两文件
`write`；指定的 `python3 -m unittest discover -s tests -v` 曾请求审批。此处原记载的
`waiting_for_approval` 已过时：首张审批 `approval_99fc6d6c-6041-496a-8c89-c32c8fc0885f`
于 13:18:58 UTC 过期，Run 变为 `failed`；旧包又错误写出第二张 `pending` 审批
`approval_9ae90018-15ab-4f71-b58e-5b74b7547eb2`，其后也于 13:49:21 UTC 过期。
未点击批准、未执行该命令，不能将此 Run 当成 N-02 成功。窗口回到当前 Space 后的真实截图
为 `output/e6-20260928/N-02/screen-32-expired-approval-old-package.png`，可见失败和
`Activity unavailable`，不是命令结果。

根因是 `createRunApprovalHandler` 仅将 `host_` 工具视为 Host 审批；真实 Host `bash`
与 brokered `write/edit` 创建审批时落入无 Attempt fence 的普通写入。新增失败 Run 后
重复审批的红测后，三者共享 `createExecutionApprovalRequest` 与 fenced Run 状态转移；
Core 对遗留 pending 的 `approve_once` 和命令规则批准均在 SQLite UPDATE 内拒绝
terminal Run，API 返回 409 `approval_execution_stale`。Core 审批 77/77、Daemon
命令风险 7/7、Daemon 审批 API 97/97 通过。修复后的新包和完整 N-02 GUI 仍待验证；
不得沿用旧包截图宣称通过。

### 2026-09-29 E6 N-02 接续：新包真实任务与审批竞态

隔离 QA 客户端（`app.asar` SHA-256 `ab226765e4a7b4a1ff87a66df8aaa153f15aa112169767e62674d0a7bb5bd847`）内，Thread
`thread_f5238182-1e59-46d7-b862-4454698263e2` 的真实 Run
`run_c06ef9f2-80e4-4ae4-8e9b-a3b6e4416d65` 已完成：三次独立读取、两文件编辑、一次
`python3 -m unittest discover -s tests -v` 审批和实际执行；25 项测试通过，退出码 0。
GUI 的命令展开和文件预览分别见 `output/e6-20260928/N-02/screen-38-command-expanded.png`
与 `screen-39-file-preview.png`。随后两条 A/B/C 输出 Run
`run_df1f3c99-30ae-4ebc-9536-3b6b5157e68f`、
`run_dcdde477-ec83-48af-a10c-188e9e0d54cd` 均成功，各有三条 SQLite `tool_update`。
`screen-41-live-a-running.png` 的文件名误导：抓取时命令已完成，不能算运行态截图。

还发现另一审批竞态：审批插入后，若 fenced Run 状态转移失败，原路径留下 `pending`。
现在失败分支将审批取消，记录 `approval_cancelled`，系统取消的 `resolved_by` 为 NULL，
不冒称用户取消。Core/Daemon 相关 188 项回归通过。本段源码修复尚未进入上述安装包；
必须以重新打包、安装后真实 GUI 和运行中截图继续验收。右侧布局不再重复修改；
N-02、E6 全 20 项与 H2 同 Run 联测仍未结算。

审批竞态新包的在线下载两次分别遇到 `ETIMEDOUT` 和 600 秒请求超时；本机已有
Electron 44.1.1 arm64 缓存 ZIP，SHA-256 与安装依赖的 `checksums.json` 一致。
打包配置只在显式设置 `LING_E6_QA_ELECTRON_DIST` 时校验并使用这一 ZIP，默认发布
路径不变。新包 ZIP SHA-256 为
`b3be6d035400db3065fc8d9ec61178f3394adf9eac7ee45d788a44239f9d69b0`，
`app.asar` 为 `7bc28b5cc52f8aaa0e15afc52567ef404cff813d9479618ae5b53fda1ae626fd`；
严格签名校验通过。旧专用 App 已移至
`$HOME/.codex/ling-qa-app-backups/Ling Stack E6 Progress QA 20260928.pre-postwait-race.app`，
原隔离 userData 未改。使用相同 `--user-data-dir` 重启后，真实 GUI 重开了原会话历史。

新包 Run `run_32bebdf5-fa70-4209-bf97-f3759fd97cc2` 通过 GUI 请求一条
`E6-N02-FINAL-A/B/C` 长输出命令；审批前截图为
`output/e6-20260928/N-02/screen-42-postwait-package-approval.png`。选择“允许一次”后，
`screen-43-final-a-live.png` 明确显示命令“处理中”、输出仅 A；同时 SQLite Run
仍是 `running`、`tool_start` seq 6、首条 `tool_update` seq 11、尚无 `tool_end`。
这才是可信的运行态 A 截图，不等同于之前误标的 screen-41。B/C 与终态仍待继续核验。

### 2026-09-29 E6 N-02 最新包小项目与审批并发反例

同一最新签名包的长输出 Run 最终 `succeeded`，持久化 B/C 更新及 `tool_end`，
GUI `screen-44-final-terminal.png` 显示三行与退出码 0。新建普通会话
`thread_96ce010a-6fcc-48c3-a73a-d482e56ea7da` 的真实 Run
`run_d583a948-386d-4dd7-bc00-74718d472c2c` 分三次 `read` 验收输入，
一次 `write` 创建 `qa_taskbook_v3.py` 与 `tests/test_qa_taskbook_v3.py`；
`screen-45` 为真实 GUI 审批，允许一次后命令退出 0，34 项 unittest 通过。
`screen-46` 是终态，`screen-47` 展开两文件操作，`screen-48` 打开源码预览。

同 Thread 续问 Run `run_d70fa2bd-28dc-48b9-a36b-6b940c4324b0` 已分别读取并
精确编辑上述两文件，RunEvent seq 160/164 分别持久化 `text/x-diff`。但模型同一轮
并行发起 unittest 与 `git diff` 两个 `bash`：前者进入 `waiting_for_approval`，
后者再次试图做 `running → waiting_for_approval`，围栏拒绝，审批
`approval_5f72eb8b-68a7-4914-a04e-22f036f3c3a4` 系统取消；seq 204/205
为 `approval_cancelled` 与失败 `tool_end`，不是用户拒绝。随后 macOS 锁屏，
测试审批 `approval_08adb2f5-80a4-4e09-b0ba-706f19c5e8f7` 未能经 GUI 点击，
在 19:14:29Z 到期，该 Run 失败；`screen-49` 只证明到期前审批卡曾出现，
不能作为测试通过证据。只读追踪确认单 Run 的并发 Host 审批缺少串行准入，
不能简单把第二个失败当成 Agent 选择错误。已新增两条回归：并发先后批准、
首项拒绝后不再创建第二审批；第一条在修复前实测多出一张审批（2 ≠ 1），
修复后两条通过。Daemon 按 Run 串行进入审批回调，并在下一请求准入前复查
Run 活跃状态及 AbortSignal，不放宽原 Attempt 围栏。Daemon 构建、审批套件
99/99、恢复与 Host 权属 44/44、定向取消场景 4/4 通过；这些仍是源码验证，
未进入当前安装包。另已从该源码构建一个**尚未安装**的隔离 macOS QA 包：
`/private/tmp/ling-e6-approval-qa-package.hrd1ME/`，ZIP SHA-256
`2aae476bafce388bdf0c418897b6edd42d35716d5c83e0c98370840ffb8d8776`，
`app.asar` SHA-256
`717e75a326f40a1eeb94149d981364e935ab1372ddf17665189a873af1072622`，
`codesign --verify --deep --strict` 通过。签名是 ad-hoc，本轮没有做 Apple 公证；
原 QA 客户端与隔离数据未替换。待 macOS 解锁后安装此包并重走 GUI 并发审批反例。
N-02 保持 `not_run`：解锁后需在最新包打开两处真实 diff 并核对 viewport 归属，
再以新的续问 Run 完成测试，且继续 E6 20 项与 H2 同 Run 联测。未改右侧私聊布局，
未提交、推送或合并。

### 2026-09-29 E6 N-02 并行审批取消边界补验

对上述单 Run 串行审批再补一条真实 Daemon API 回归：两条并行 Bash 中首张
审批待答时取消 Run，等 SSE 结束后核对原审批变为 `cancelled`、没有第二张审批，
Run 保持 `cancelled`。定向 1/1、`approval-policy-run` 全套 100/100、
`harness-continuation-integration` 29/29、`git diff --check` 通过。该测试
只验证源码和隔离 SQLite，不替代修复包的真实 GUI 复测；专用客户端仍为旧包，
本机 GUI 读取仍报告 macOS 锁屏，N-02 与 E6 状态不变。

### 2026-09-29 E5/H2 真实 SDK 自动压缩进入 Host 检查点

新增独立 Daemon 集成测试 `run-compaction-host-integration.test.mjs`：隔离 SQLite
Host Run 使用真实 Pi SDK、12 个不同的内置 `read` 和无网络模拟 provider，触发
自动摘要请求；同一 Run 在压缩后继续执行工具，最终检查 SQLite 的
`context_compaction_end`、已完成工具事件、最新 committed progress checkpoint
及其 sealed artifact。最初测试因重复读取同一路径触发执行环检测，改为不同文件；
随后发现小 contextWindow 配合 SDK 默认 `keepRecentTokens=20000` 没有可压缩切点，
改用足够大的真实上下文输入后测试通过。Harness 既有 29 项与新增用例合计
30/30、`git diff --check` 通过。此项证明自动压缩→Host 持久化的真实接缝，
**还不证明**失败、取消、daemon restart 混合于同一 Run 的无重复副作用；
该联合联测与 E6 packaged GUI 继续待做。

### 2026-09-29 Daemon 全量回归与审批夹具对齐

全量首跑暴露 TerminalReport 两项旧夹具在 Run 结束后才“批准”，与新的终态
审批围栏冲突；调整为 Run 活跃时批准，再结束 Run，保留“审批不是操作事实”的
原断言。第二轮还暴露控制面夹具绕过 Daemon Store 注册、让重开恢复关闭孤立 Run，
以及 Host 取消测试把“请求中已持久化的批准”误当成“已授予执行权限”。前者改用
Daemon-owned Store，后者分别断言请求前取消不创建审批、请求中取消只抛
`AbortError` 而不返回执行许可。四个失败点均定向复测通过；最终
`node --test --test-reporter=tap --test-concurrency=1 test/*.test.mjs` 为
**2074/2074 通过、0 失败**，`git diff --check` 通过。未改变 Core 的
“终态 Run 不可新批准”规则，也未把审批记录当工具执行。该全量结果是 Daemon
源码回归，不是 H2 失败/取消/重启同 Run 联测或 E6 packaged GUI 验收。

### 2026-09-29 E5/H2 同 Run 失败、取消与重启联测

新增真实 Pi SDK + Host + SQLite 的**隔离进程**联测：同一 Run 自动压缩后，
先记录一次失败的内置 `read`，再成功 `write` 测试 marker；Host 在下一次模型请求
前封存包含该写入的 progress checkpoint。第一场景杀死子进程模拟 Daemon 崩溃，
重启恢复只发出一次后续模型请求，失败读取和成功写入各保留一条 `tool_end`，
marker 未重写。第二场景在相同位置发送用户取消，再重启恢复扫描；Run 保持
`cancelled`，不派发 Runner，原失败和写入事实仍各一条。两场景均核对失败读取
确实发生在 `context_compaction_end` 之后，且不使用用户凭据或真实工作区。
`run-compaction-host-integration` 加两条 restart/cancel 用例 **3/3 通过**。
本节补的是此前缺少的同 Run 源码联测；最新全量 2074/2074 统计发生于新增
restart/cancel 文件之前，不能冒称已覆盖它们。真实外部模型和 E6 packaged GUI
仍待验收，N-02 状态不变。

### 2026-09-29 新增 H2 联测后的 Daemon 全量复测

包含上述自动压缩、崩溃恢复与取消恢复三个新用例的 Daemon 全量测试已完成：
`node --test --test-reporter=tap --test-concurrency=1 test/*.test.mjs` 为
**2076/2076 通过、0 失败、0 取消、0 跳过**。这只证明当前源码回归；
尚未安装并行审批修复的新 QA 包，也未完成 N-02 及 E6 20 个真实客户端案例。
macOS 当前虽列出专用窗口在本 Space，但桌面捕获为黑屏，窗口截图失败且 AX
窗口无法解析；未对不可观察的界面发送输入，等待系统解锁后继续。

### 2026-09-29 当前 WIP 的仓库静态门禁复测

在 `codex/e6-safe-continuation`、保留全部现有 WIP 的状态下，根仓库
`corepack pnpm typecheck`（19 个 workspace 项目）、`corepack pnpm build`
（19 个 workspace 项目）和 `corepack pnpm check:docs`（272 个 Markdown 文件）
均以退出码 0 完成；`git diff --check` 也通过。构建和静态检查不能替代
E6 最新包的真实 GUI 证据。再次读取专用 QA 窗口仍为无有效帧、无 AX 控件，
桌面截图纯黑；本轮没有重启或替换客户端，也没有操作待审批 Run。

同一源码的包级回归另有 Core **1003/1003**、Runner Pi **210/210**、
Web 单测 **356/356** 通过；Desktop 单测 **1148 项中 1145 通过、3 跳过、
0 失败**。这四组结果由当前工作树重新运行取得，未借用此前旧包统计。
Web Playwright 首轮全量 **1126/1127 通过**，唯一失败发生在 Quick Theme
Studio 测试：宽泛的 `getByText` 同时匹配可见 Toast 与读屏器 live announcer。
页面本身只有一个可见 Toast；已将断言收窄至 Notifications 区域，相关文件
**2/2 通过**。测试断言修正后正在重新运行全量，尚不能宣称全量通过。
根仓库 `corepack pnpm lint` 退出码 0；其中多数包的 lint 脚本只是占位，
Web 的 UI import、控件、overlay、图标、动效与 feedback 规则确有执行。
`check:i18n`（55 个 locale 与 Web 审计）、`check:licenses`（1223 个依赖版本）
及 `check:dependency-security`（9/9）均通过。`check:public` 首轮发现本账本
三处个人 macOS 用户名路径；只将这三处改成 `$HOME` 后复跑通过，扫描 3892 个文件。
这次文档脱敏不改变备份文件或隔离 QA 数据。修正测试断言后的 Web Playwright
第二轮全量已在同一当前工作树完成：**1127/1127 通过，退出码 0**。这仍是
mock daemon 的浏览器回归，不是 E6 最新 packaged macOS 的真实 GUI 验收。

### 2026-09-29 E6 N-02 当前签名包的 GUI 接续

在独立 userData 不变的前提下，当前专用 macOS App 已更新为 ZIP SHA-256
`89351307b115649b7d6b9312d47334e0f43205eb1b72b9a20247e903f831e024`；
安装包内 `app.asar` 为 `717e75a326f40a1eeb94149d981364e935ab1372ddf17665189a873af1072622`，
Web `index.html` 为 `1795dcf76fff861640cadc2c61ae8819cb8df5ff574717ddfeb0355f25d529fd`。
当前包包含临时 `tool:` 行淘汰修复；源码 Web 单测此前为 **357/357** 且构建通过，
这两项不能替代本段客户端证据。

同一小项目 Thread 的新 GUI Run `run_e3f59384-e407-4e4c-a8c7-0de68ba1b382`
在一轮内产生两个不同的 bash `tool_start`（seq 29/30）。两张审批经客户端
“允许一次”后均持久化为 `approved`；`tool_end` 分别在 seq 42/50，Run 为
`succeeded`。真实命令事实是 unittest **37 项 OK、退出码 0**，独立计数命令
输出 `1`、退出码 0。最新包的前台终态截图
`output/e6-20260928/N-02/screen-67-new-package-terminal-frontmost.png`
每个新调用各显示一条完成行，没有旧的“处理中”幽灵行；切换到另一会话再重开后的
`screen-68-new-package-reopened-terminal.png` 仍各一条、无运行中行。
后台捕获的 `screen-63/64/66` 是 WindowServer 旧帧，仅作诊断，不列入验收。

同一当前包还从早先失败续问的两条成功编辑行分别打开真实红/绿 diff：
`screen-69-latest-package-v3-source-diff.png` 对应 `qa_taskbook_v3.py`，
`screen-70-latest-package-v3-tests-diff.png` 对应测试文件。文件归属与可展开
内容得到真实 GUI 证明，独立 viewport/root virtualizer 数量仍未读回。

发现另一独立缺口：本 Run 的 TerminalReport
`terminal_report_1c4ada19-639d-4e76-80fe-3beab9d9b918` 的 evidence snapshot
包含两条 operation、零条 check，因此将两项验证标成 `unknown`，并说未提供
unittest 明细及计数 stdout；但同一 Run 的 `tool_end` 和上方 Agent 消息实际包含
`37 tests ... OK` 与 `1`。这是报告证据投影与会话事实不一致，不能用报告里的
“输出不可得”覆盖原子工具事实，需继续排查并修复。QA 输入的 AX 值还曾与
后台旧帧不一致，发送后形成同一条用户消息内的重复提示文本；这是本轮驱动/渲染
观察到的缺口，后续 UI 验收应以当前前台帧和 SQLite Turn 同时核对，避免重复发送。

**N-02 仍未整项结算**：新的并行审批、成功续问命令和两个 diff 已补证，
但 per-row viewport 归属、全部阶段在同一最新签名包重跑，以及上述 TerminalReport
投影缺口未完成；E6 20 项与 H2 packaged GUI 总门禁也不宣称通过。右侧私聊布局
继续冻结，本轮未提交、推送或合并 WIP。

### 2026-09-29 E6 N-02 报告证据修复与新包局部验收

前述 `unknown` 报告缺口已在源码层补足：Daemon 把 `python3 -m unittest`
真实命令结果折成 Host check，Core 不再允许模型把该 check 降级或漏报。
相关 Core 全量 **1004/1004**、Daemon 全量 **2077/2077** 通过，
`git diff --check` 通过；这些是源码回归，不代替客户端验收。新 macOS ZIP
SHA-256 为 `47114a303d2cce241962f03189dd29e4c7e50531f58a514f73b79c246a3f25f5`，
安装 `app.asar` 为 `6ed93ad1b5b27344102819d0b57ad37d60dec521682235118409a5ed2858574c`，
独立 userData 保留，已通过 `codesign --verify --deep --strict`。

新包同一隔离 Thread 的新 Turn
`turn_normal_61053c7120674aa72c4cd9aaafae4c04cc2220c4d5babb87594028f8a4b4831b`
只有一条 committed 用户 Item，虽然输入驱动曾把重复文案拼在同一条消息中；
没有再次发送测试提问。Run `run_c06f5e95-138f-4ea7-b0c3-e863b7d84d19`
经一次 `approve_once` 执行 `python3 -m unittest discover -s tests -v`，
`tool_start` seq 6、`tool_update` seq 11/12、`tool_end` seq 16，
退出码 0，stderr 记录 **37 tests / OK**。新 TerminalReport
`terminal_report_a030f84e-e534-4d5c-ae6f-3a6f638b1815` 是 generation 1、
`committed/succeeded`，evidence snapshot 的一条 Host check 与报告 verification
均为 `passed`。旧报告仍保留原始 `unknown`，不回写历史。

客户端的报告按钮经点击后，AX 从 `Expand details` 变成 `Collapse details`，
且 AX 中出现展开内容；但同一窗口 PNG 仍停在收起的旧帧，桌面捕获当时显示
Chrome 在前台，因此 `output/e6-20260928/N-02/screen-71-report-expanded-ax-stale-window-frame.png`
仅是诊断图，不是“展开报告”的合格 GUI 截图。其后 QA 进程不再运行，尚无证据
判断退出原因。四件套已补记本次 lineage 与截图限制。**N-02 保持 `not_run`**：
需在可验证的新鲜前台帧下补报告展开图、逐行 viewport 归属，并在同一最新包
完成其余阶段；E6 全 20 项与 H2 packaged GUI 仍未完成。右侧私聊布局继续冻结，
未提交、推送或合并。

### 2026-09-30 E6 QA 启动隔离警戒

专用 QA 进程退出后，用 bundle ID 调用 `cua-driver launch_app` 会重新启动签名包，
但该接口不携带此前 QA 所需的 `LING_STACK_DAEMON_URL`、
`LING_STACK_DEFAULT_WORKSPACE_CWD` 等每进程环境变量。一次这样的重启
（PID 97297）打开了默认 Ling 的 `Application Support/Ling Stack` 配置目录，
界面出现旧频道，而不是 N-02 隔离工作区。**未在该实例点击审批、发送消息或执行
测试操作**；发现后停止驱动，退出该误启实例需单独确认。不能把这个窗口的
截图或状态记为 N-02 证据，也不能再用无环境参数的 bundle ID 启动来续测。
原隔离数据 `/private/tmp/ling-e6-qa-userdata.NBCJ2x/` 仍存在，后续须先核验
实际进程的 userData、端口 17928 与工作区归属，才允许继续 GUI 操作。

### 2026-09-30 最新包独立生命周期补证

在**另建临时 userData、Ling home、工作区和动态端口**下，针对上述最新签名包
运行仓库现有 `run-packaged-continuity-smoke.mjs`，结果 `passed`，14/14 检查通过。
覆盖 release migration recovery、SSE 断线/重连、canonical lineage、裸 `ready`
阻断、缺 provider 阻断、安全审批检查点重启、无检查点重启、effect-unknown
重启及 daemon 重启后的重放幂等。报告见
`output/e6-20260928/H2/packaged-continuity-20260930.json`；其 ZIP SHA-256
与 N-02 当前包一致，为 `47114a303d2cce241962f03189dd29e4c7e50531f58a514f73b79c246a3f25f5`。
首个预迁移启动失败注入进程在 5 秒清理窗口后由脚本 `SIGKILL` 收尾，其余
检查通过；不能据此宣称所有退出均优雅完成。

该脚本使用 mock provider 和 API/SQLite 语义断言，没有真实模型，也没有可见
GUI 截图；因此只是 E5/H2 生命周期补证，**不结算 H2 同 Run 自动压缩与
失败/取消/重启混合联测，也不结算 E6 的 20 个 packaged GUI case**。

同一 WIP checkout 的 H2 定向源码联测重新执行为 **3/3**：真实 Pi SDK
自动压缩后 Host checkpoint 提交、崩溃重启不重放已封存写入、取消后重启不派发
Runner。根工作区实际脚本是 `corepack pnpm build`（没有根级 `build:ci`）；
完整 workspace build 本次退出码 0。上述结果都不改变 E6 GUI 的 `not_run`。
