# Ling Typed Transcript：Codex 风格统一会话详细设计

Status: normative design v3.9.1-final（extends the v3.9 contract）；D0–E5 source implementation 与自动化闸门已通过，E6 packaged macOS 真实案例与证据仍待完成
Date: 2026-09-01
Design revision: Codex parity handoff 2026-09-01（component、scope、nested child 和无兼容入口已锁定）
Base: `origin/main` @ `ebfadd1b`（2026-09-03 已同步；实现进行中）
Scope: 普通会话、队友私聊、频道 root/topic/branch、depth-1 子 Agent、macOS 客户端
Owner: Conversation UI、conversation-ui-core、daemon runtime maintainers

本文件是 typed transcript 的唯一数据和语义规范。视觉细节见
[Conversation Codex-Parity Visual Specification](conversation-codex-parity-visual-spec.md)，
组件树、renderer props、状态所有权和迁移边界见
[Conversation Codex-Parity Component Detailed Design](conversation-codex-parity-component-detailed-design.md)，
工程步骤见
[Codex-style Typed Transcript Implementation Plan](conversation-codex-style-transcript-implementation-plan.md)。
频道/Topic/Branch 的持久化拓扑见
[Channel Conversation Continuity v2](channel-conversation-continuity-v2.md)，表面词汇见
[Conversation Surface Taxonomy](conversation-surface-taxonomy.md)。这两个文档定义存储和路由
边界；本文件只定义它们如何投影成同一 typed transcript。
旧版方案保留在 Git 历史，不再作为实现入口。组件级快照边界、exhaustive renderer
registry、EvidenceFold 算法和 surface adapter 的实现接口见组件细设计 §5.1–§5.2、§10.1、
§15 及 §25；这些接口不改变本文件定义的事实、lineage、completion 或 recovery 权威。

## 1. 目标

Ling 的会话应当像 Codex 一样安静、清楚、可恢复，同时保留 Ling 的 SQLite 历史、
多 Agent 协作和审批边界。用户在首屏就能回答三件事：

1. 说了什么（Markdown 叙述）；
2. 实际发生了什么（Host 事实）；
3. 下一步是否需要我处理（审批、失败、阻塞或重试）。

### 1.1 一句话设计

一个垂直时间线承载所有内容；模型只写文档式叙述，Host 只写带 lineage 的事实行；
同一个动作在 `start → update → end` 期间原地更新，完成后默认收敛为一行，只有需要
处理的状态才展开详情。普通会话、队友私聊、频道和 depth-1 子 Agent 只是同一时间线
的不同 scope/chrome，不是不同的渲染系统。

### 1.2 Codex-parity 的可观察结果

实现完成后，任何一个用户动作都应能在首屏形成下面的最小闭环：

```text
叙述：我先检查 parser.ts，再运行测试。
事实：▣ Run pnpm test · Working
事实：▣ Run pnpm test · Succeeded · exit 0
结果：execute turn 由一个 `terminalReport` 结构化结果收口；它不能复制命令行，
       可选的最终 `agentMessage` 只能是补充叙述，不能重复报告事实
```

“简单好看”不是截图风格，而是四个可测试的不变量：

1. 文档 lane 不套事实卡片；事实 rail 只显示 `icon + 动词 + 状态 + 一个 disclosure`。
2. 同一 `actionId` 只有一个 owning row；更新只改变 `revision`，不追加第二行。
3. 成功历史默认折叠，`running/waiting/failed/blocked` 才提高视觉重量。
4. 三种 surface 和子 Agent 的 `rendererKey/kind/status/order` 相同，差异只来自 chrome、
   policy 和 participant rail。

目标信息流：

```text
SQLite durable records + Host events + SSE deltas
             │
             ▼
       scoped canonical snapshot
             │
             ▼
  pure projector（排序、lineage、attempt、owner）
             │
             ▼
       atomic typed items
             │
             ▼
 reversible display batches（可选）
             │
             ▼
 ConversationTimeline + one renderer registry
             │
  normal / private / channel / topic / branch / child
```

### 1.3 “简单好看”的实现定义

v3.7 把审美要求翻译成三个可验收的层次，避免实现者用不同的卡片和文案各自解释
“像 Codex”：

```text
document lane  = 叙述和 Markdown，保留段落、列表、代码、路径结构
fact rail      = 真实动作，一行表达 icon + 动词 + 状态 + 一个 disclosure
shell chrome   = header / EnvironmentPopover / Composer，不拥有历史事实
```

实现时必须同时满足：

1. 一个 surface 只有一个 `ConversationFeedViewport` scroll owner；document lane、fact
   rail 和 nested rail 只是同一 DOM 流的语义分组，不能变成左右两列或第二个历史面板。
2. 同一 `actionId` 只有一个 owning row。`tool_update`、SSE 重连和 daemon restart
   只更新该行的 `revision/status/detail`，不创建“开始/完成”两张卡。
3. 成功历史默认收敛，进行中、等待、失败、取消和 blocked 才增加细节或操作控件；
   颜色只作辅助，文本和 icon 始终完整表达状态。
4. 普通、私聊、频道和子 Agent 使用同一 item union、projector、batch 函数和
   renderer registry。surface 只能改变 shell chrome、policy 和 participant rail。

因此“右侧方形消息”“Composer 下重复总结”“子 Agent 乱码或只有 ready 文本”都属于
契约违例，不是可以由 CSS 局部修补的视觉偏好。

### 1.4 v3.9.1-final 实现锁（开工者的一页合同）

这组规则是实现和 code review 的第一输入。后面的章节提供推导和边界，但不得重新解释
下面的 owner、顺序或完成权威。开发阶段允许一次性破坏旧的未发布渲染契约：不保留旧
WorkCell renderer、双写、feature flag 或“先兼容一下”的第二条路径。

#### 1.4.1 唯一数据流

```text
SQLite conversation_items + RunEvent/ExecutionAction + Approval/Artifact
                              + SSE delta
                                      │
                                      ▼
                         TimelineSourceSnapshot
                                      │  scoped coverage/cursor
                                      ▼
                               EvidenceFold
                         actionId/revision/fence
                                      │
                                      ▼
                     CanonicalTranscriptProjector
                  owner/attempt/order/lineage/result join
                                      │
                                      ▼
                         atomic TimelineSnapshot
                                      │
                                      ▼
                      reversible display projection
                         (command/exploration batch)
                                      │
                                      ▼
                    ConversationTimeline + registry
```

每一层只做一件事：source 读事实，fold 折叠生命周期，projector 生成原子 item，batch
只做展示压缩，Timeline 只渲染。React 不读取 raw source；surface 不排序、拼接或判断
完成；batch 不参与 completion、retry、fan-in 或 context；Composer/Popover/Right Dock
不拥有历史事实。

#### 1.4.2 三层命名和一个 owning row

```text
wire kind（snake_case）
  -> contract adapter
projection kind（camelCase closed union）
  -> renderer registry
stable rendererKey（dotted key）
```

所有事实 item 必须带 `actionId + runId + attemptId + participantId + workflowStepId`
（`workflowStepId=null` 表示 Host 明确没有 step）和 `sourceRefs`。同一 `actionId` 在
`tool_start → tool_update → tool_end`、SSE 重连和 daemon 重启中只有一个 owning row；
只更新 `revision/status/detail`。迟到、重复或同 revision 冲突事件进入 audit/diagnostic，
不得重新打开终态或追加第二行。

#### 1.4.3 统一时间线和视觉配方

```text
ConversationSurfaceShell
├─ Header（标题、参与者、policy hint）
├─ ConversationFeedViewport       唯一 overflow-y/scroll owner
│  └─ ConversationTimeline         普通文档流
│     ├─ document lane：user/agent/reasoning/plan/Markdown
│     ├─ fact rail：command/file/tool/approval/protocol
│     ├─ result：execute turn 的唯一 terminalReport
│     └─ nested rail：depth=1 子 Agent，同一 registry
├─ EnvironmentPopover              只显示 active action 两行
└─ Composer                        输入、停止、重试、审批控制
```

文档 lane 左对齐、无气泡卡片；事实 row 使用 `icon + 动作动词 + 文本状态 + 一个
disclosure`；成功历史默认收敛，`Working/Waiting/Failed/Blocked` 提高视觉重量但不
改变行类型。代码保留换行和缩进；模型路径只显示 basename + icon + tooltip/copy，只有
带 Host capability 的 source ref 才能打开文件、diff 或 artifact。任何 row/detail 不得
创建第二个纵向滚动容器。

#### 1.4.4 Reply、execute 和多 Agent

```text
reply turn
  └─ agentMessage(presentationRole=reply_result)

execute turn
  ├─ narration（可有多条 agentMessage/reasoning/plan）
  ├─ atomic Host facts（command/file/tool/approval）
  └─ outcome slot：Finalizing → terminalReport | diagnostic(blocked)
```

`execution_summary`、plan 进度、batch 数量和“我会执行/ready/done”都是叙述或辅助
信息，不能证明动作或任务完成。`terminalReport` 只由 Completion Gate 读取 atomic
evidence 后发布一次；fan-in 只有所有 required participant evidence 到齐，或缺失者均
有结构化 blocked，才允许 settle。

子 Agent 是 `subAgentActivity` participant span，不是另一套聊天产品。child narration
是 `agentMessage`，child command/file/tool 复用完全相同的 renderer；只增加 participant
label、1px rail 和 8px inset。可见深度最大为 1，depth=2 输出
`diagnostic(nested_depth_exceeded)`，不创建第三个 Timeline 或滚动区。

#### 1.4.5 三种 surface 的唯一差异

normal、teammate-private、channel root/topic/branch 解析到各自真实的
`LingThread.id`；depth-1 child 不创建新的可见 Thread，而是复用父级真实
`LingThread.id`，再用 `participantId + parentItemId` 形成 child scope。两者都加载同一种
`TimelineSnapshot`，调用一次 `mountConversationTimeline`。
允许不同的只有 title、roster、topic/branch chrome、participant rail、权限和 callback
可用性；`itemKinds/order/status/rendererKey/disclosure/row geometry/scroll owner` 必须
相同。Topic/Branch 不复制 parent transcript；不得用 `channel:<id>`、`topic:<id>` 或
message id 充当 transcript thread。

#### 1.4.6 实现闸门

```text
D0 contract + fixture
  → E1 evidence fold + invalidation
  → E2 atomic projector + reversible batch
  → E3 shared Timeline + Host viewer
  → E4 normal/private/channel/topic/branch/child cutover
  → E5 approval/retry/reconnect/restart/fan-in recovery
  → E6 packaged macOS real UI evidence
```

闸门按顺序关闭，任何一层失败都回到该层修复，不能用 CSS、截图或模型文本遮盖。E6
只有在每个案例同时拥有 `simulation=false`、build hash、截图、semantic-state、lineage
和脱敏日志时才通过。Windows 不属于本轮验收范围。

#### 1.4.7 Codex parity 开工锁（2026-09-01）

这一条是对实现者的最终短合同：Ling 借鉴 Codex 的 item 分层和 renderer 分工，但不复制
Codex 的 provider session、TUI 或存储表。所有 surface 和 child 都走同一条链：

```text
Host/SQLite facts
  -> typed adapter（wire kind 只转换一次）
  -> EvidenceFold（actionId + revision + terminal fence）
  -> CanonicalTranscriptProjector（scope/owner/attempt/order）
  -> atomic typed items
  -> optional reversible display batch
  -> ConversationTimeline + exhaustive renderer registry
```

必须同时满足：

1. `userMessage/agentMessage/reasoning/plan` 只进入 document lane；段落、列表、fenced
   code、路径和链接保留 Markdown 结构，不 flatten 成一行。
2. `commandExecution/fileChange/exploration/typed tool/approval/protocol` 只由 Host
   evidence 生成 fact row；首屏固定为 `icon + 动词 + 文本状态 + 一个 disclosure`。
3. `execute` turn 只有一个 `terminalReport`；`reply` turn 只有一个
   `agentMessage(presentationRole=reply_result)`。Composer、EnvironmentPopover、Right
   Dock 都不能复制这两个 outcome owner。
4. normal/private/channel/topic/branch 使用真实 Thread；child 使用父 Thread + participant
   span，深度只允许 1。child 的 narration、command、file、tool 复用同一 registry，不能再
   创建 child feed、child virtualizer 或第二个 scroll owner。
5. batch 只改变显示密度，不落 SQLite、不改变 `contextSegmentId`、不参与 completion/
   fan-in/retry/approval。
6. 开发阶段直接切换到新合同：不保留 legacy renderer、双写、feature flag 或 fallback
   JSX。无法补齐 lineage 的旧行只通过 strict adapter 变成 `diagnostic(blocked)`。

如果实现提案违反任一条，必须先改本文件、组件细设计和视觉规范，再改代码；不能在某个
surface 内临时增加第二套 renderer。

#### 1.4.8 Codex-style 内容合同（实现时直接照表）

`agentMessage` 不是一段必须整体渲染的字符串，而是一个保持顺序的 document part
序列。这样普通文本、列表、代码和路径可以得到正确的排版，同时不会因为“看起来像
命令”而越过 Host 事实边界：

```ts
type DocumentPart =
  | { readonly kind: "paragraph"; readonly markdown: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: "quote"; readonly markdown: string }
  | { readonly kind: "code"; readonly language: string | null; readonly code: string }
  | { readonly kind: "pathCandidate"; readonly basename: string; readonly fullPath: string };

type AgentMessageItem = {
  readonly kind: "agentMessage";
  readonly presentationRole: "narration" | "reply_result" | "execution_summary";
  readonly parts: readonly DocumentPart[];
};
```

固定转换规则：

1. Markdown parser 只产生 `DocumentPart`；它不能创建 `commandExecution`、`fileChange`、
   `mcpToolCall` 或 `terminalReport`。
2. fenced code 保留原始换行和缩进，未闭合 fence 在流式期间使用安全的 plain-mono
   renderer；收到闭合 fence 后原地升级，不产生第二条消息。
3. 路径候选默认是不可执行的 `pathCandidate`，只显示 basename、文件 icon、tooltip 和
   copy；只有 Host 签发的 `trustedSourceRef` 才能触发 `open_file/open_diff/open_artifact`。
4. `commandExecution`、`fileChange`、`exploration`、typed tool 和 approval 必须由
   `RunEvent`/`ExecutionAction`/Approval/Artifact 生成，并携带完整 lineage；模型叙述只
   能作为相邻文档说明。

同一 turn 的目标输出如下，后续实现和 UI fixture 必须以此为准：

```text
DocumentBlock  我先检查 parser.ts，再运行测试。
FactRow        ▣ Run pnpm test · Working                         [⌄]
FactRow        ▣ Run pnpm test · Succeeded · exit 0               [⌄]
ResultRow      ✓ Result · Succeeded · 2 files changed · 3 checks  [⌄]
```

子 Agent 只增加一层 participant rail，内容仍由同一 registry 渲染：

```text
NestedRail  QA
  DocumentBlock  我会复核测试输出。
  FactRow        ▣ Run pnpm test · Succeeded · exit 0              [⌄]
```

如果 child 只有“我会执行”或 `ready` 文本而没有 Host evidence，不能渲染为成功事实，
只能进入 `diagnostic(blocked)` 并让 fan-in 保持 waiting/blocked。该规则同时约束 normal、
private 和 channel，避免子 Agent 拥有另一套聊天语义。

## 2. 明确不做的事

- 不复制 Codex 的 provider runtime、session schema、TUI 或配色。
- 不新增 `session`、`batch`、`activity_summary` SQLite 表。
- 不把摘要、batch membership 或 UI disclosure 写回 `conversation_items`。
- 不用模型的“ready/done/我会执行”证明命令、文件、队友或任务已完成。
- 不再维护未发布旧客户端的兼容 renderer。旧 SQLite 行仍可读；缺字段时显示
  `diagnostic(blocked)`，不得猜默认值。
- 不让各 surface 自己分类文本、排序 SSE、拼命令日志或判断完成。
- 本轮验收目标是 packaged macOS；Windows 不在本设计范围。

## 3. Codex 借鉴边界

| Codex 原则 | Ling 实现 | 不复制 |
| --- | --- | --- |
| typed turn items | closed `ConversationTimelineItem` union | Codex protocol/session 表 |
| item 专用 renderer | exhaustive renderer registry | Codex TUI/键盘布局 |
| active cell 原地更新 | `actionId` + monotonic `revision` | provider 私有事件协议 |
| Markdown 与 command cell 分离 | document lane + factual rail | Codex 的单 Agent 假设 |
| completed history 可折叠 | 可逆 command/exploration batch | 持久化 batch 行 |
| child activity 可嵌套 | 同一 registry 的 `depth=1` | 第二套 child chat/session |

唯一 Ling-specific 增量是 participant span、fan-in、approval、trusted file/diff
Host action 和 environment popover；它们仍使用同一 item grammar。

## 4. 四条硬边界

### 4.1 事实权威

```text
agentMessage / reasoning = 模型叙述
RunEvent / ExecutionAction = Host 观察到的动作
Artifact / Approval / ParticipantSpan = 可追溯事实
TerminalReport / fan-in = 读取原子事实后的结论
```

模型可以说“我已经运行测试”，但只有带完整 lineage 的
`commandExecution(status=succeeded)` 才能证明测试成功。缺证据时必须是
`diagnostic(blocked)`，不能补一行成功摘要。

### 4.2 投影权威

`CanonicalTranscriptProjector` 是纯函数。输入是已经按 scope 合并的快照，输出是
原子 typed items。它可以校验 scope、anchor、顺序、attempt、owner 和 revision，
但不能读 SQLite、发网络请求、调用 provider 或修改状态。

#### 4.2.1 Anchor envelope 去重

`tool_call`、`tool_result`、`approval_request`、`approval_decision`、`artifact_ref` 和
`operation_state` 等 durable 行只是 canonical anchor，不是第二个可见事实。只要同一
`conversation_item` 已经有 owning `ExecutionAction` 或 supplemental typed evidence，
projector 必须抑制原始 envelope 的第二次渲染；主时间线只保留一条 owning row。若 envelope
没有可验证 owner，不能静默丢弃，而是输出一条 `diagnostic(blocked)`，明确指出缺少的
action、approval 或 artifact lineage。这样“请求/结果/总结”不会黏成三条重复记录，也不会
用隐藏 CSS 掩盖事实缺失。

```text
unmatched envelope
  -> diagnostic(blocked)
matched by action/supplemental evidence
  -> suppress envelope + render one typed owning row
```

去重只针对同一个 canonical item 的 owner 关系，不按文本、时间戳、命令字符串或
display batch 猜测；SSE 重连、retry 和 daemon restart 仍按 `actionId + revision` 合并。

### 4.3 渲染权威

普通、私聊、频道 root/topic/branch 和子 Agent 都调用同一个
`ConversationTimeline` 与 registry。surface adapter 只提供 scope、policy、shell
chrome 和 Host callbacks，不得重新注册 renderer、二次排序或增加第二个完成卡片。

### 4.4 展示优化权威

`commandBatch`、`explorationBatch` 是内存中的可逆 wrapper。它们不改变原子事实、
context 语义、审批结果、retry 选择、TerminalReport 或 fan-in。

## 5. Canonical item contract

### 5.1 Discriminant

```text
userMessage | agentMessage | reasoning | plan
commandExecution | exploration | fileChange
mcpToolCall | dynamicToolCall | collabAgentToolCall
approval | imageView | contextCompaction | protocolEvent | subAgentActivity
terminalReport | commandBatch | explorationBatch | diagnostic
```

新增 kind 必须在同一个变更中增加：contract、registry entry、semantic selector、
component test、E2E fixture 和文档映射。未知 kind 只能落到 blocked diagnostic。

实现层先定义闭合的 kind union；renderer 不接受任意字符串：

```ts
type ConversationTimelineItemKind =
  | "userMessage" | "agentMessage" | "reasoning" | "plan"
  | "commandExecution" | "exploration" | "fileChange"
  | "mcpToolCall" | "dynamicToolCall" | "collabAgentToolCall"
  | "approval" | "imageView" | "contextCompaction" | "terminalReport"
  | "protocolEvent" | "subAgentActivity"
  | "commandBatch" | "explorationBatch" | "diagnostic";
```

### 5.1.1 Codex item 对照表

Ling 只借鉴 Codex 的 item 分层和专用 renderer，不复用 Codex 的 session 或 provider
协议。下面的对照表是实现时唯一的命名映射；`source of truth` 表示事实从哪里来，
`completion authority` 表示什么可以证明完成。

| Codex item | Ling kind | renderer lane | source of truth | completion authority |
| --- | --- | --- | --- | --- |
| `userMessage` | `userMessage` | document | `conversation_item` | item 已 durable 接受 |
| `agentMessage` | `agentMessage` | document | `conversation_item`/stream | 只表示叙述，不证明动作 |
| `reasoning` | `reasoning` | document | safe summary | 不证明动作或完成 |
| `plan` | `plan` | structured document | durable plan step | 只更新计划节点 |
| `commandExecution` | `commandExecution` | fact rail | `RunEvent`/`ExecutionAction` | exit/status/evidence |
| `fileChange` | `fileChange` | fact rail | `ExecutionAction` + artifact/diff | file/diff evidence |
| `mcpToolCall` | `mcpToolCall` | fact rail | typed tool event/result | tool result evidence |
| `dynamicToolCall` | `dynamicToolCall` | fact rail | Host dynamic-tool event | Host result evidence |
| `collabAgentToolCall` | `collabAgentToolCall` | fact rail | delegation event + participant span | participant evidence |
| `subAgentActivity` | `subAgentActivity` | nested rail | participant span + child items | child atomic evidence |
| `imageView` | `imageView` | fact/document | image/artifact ref | artifact existence |
| `contextCompaction` | `contextCompaction` | document marker | context snapshot | snapshot persisted |
| Ling `TerminalReport` | `terminalReport` | result document | committed TerminalReport + final-result Item | Completion Gate + publication barrier |

Ling-specific `exploration`、`approval`、`protocolEvent`、`commandBatch`、
`explorationBatch` 和 `diagnostic` 仍进入同一 registry；它们分别表达读取、控制、
频道协议、可逆显示优化和失败诊断，不得伪装成 Codex 的 `agentMessage` 或
`commandExecution`。

### 5.1.2 Wire kind、projection kind 和 renderer key 的命名边界

实现同时存在三套名字，必须在 adapter 处一次性转换，不能让每个 surface 自己猜：

```text
SQLite / API wire kind（snake_case）
        -> contract adapter（校验、补齐 source/lineage）
Timeline projection kind（camelCase）
        -> renderer registry key（稳定 dotted key）
```

| 层 | 示例 | 责任 | 禁止 |
| --- | --- | --- | --- |
| durable wire | `assistant_message`、`terminal_report`、`tool_call` | SQLite 和 daemon/API 的持久化契约 | 直接交给 React renderer |
| timeline projection | `agentMessage`、`terminalReport`、`mcpToolCall` | `CanonicalTranscriptProjector` 的闭合 union | surface 自行新增字符串 kind |
| renderer key | `message.document`、`result.terminal`、`fact.tool` | registry、fingerprint、视觉回归 selector | 用 wire kind 作为 CSS/DOM 语义 |

当前映射的最小集合如下：

| Durable `ConversationItemKindV1` | Timeline `ConversationTimelineItemKind` | renderer key |
| --- | --- | --- |
| `user_message` | `userMessage` | `message.document` |
| `assistant_message` | `agentMessage` | `message.document` |
| `tool_call` / `tool_result` | `mcpToolCall`、`dynamicToolCall` 或对应 typed tool | `fact.tool` |
| `approval_request` / `approval_decision` | `approval` | `fact.approval` |
| `artifact_ref` | `fileChange`、`imageView` 或 artifact detail ref | `fact.file` / `fact.artifact` |
| `operation_state` | `protocolEvent` 或 action 状态的 supplemental evidence | `fact.protocol` |
| `system_event` | `protocolEvent`、`contextCompaction` 或 `diagnostic` | `fact.protocol` / `document.compaction` / `fact.diagnostic` |
| `terminal_report` | `terminalReport` | `result.terminal` |

这条边界解决两个容易混淆的问题：

1. `terminal_report` 是持久化事实类型，`terminalReport` 是 UI 投影类型；后者不能被
   当作新的 SQLite kind，也不能再回写 `conversation_items`。
2. `assistant_message` 的 `presentationRole` 决定它在 document lane 中是
   `narration`、`reply_result` 还是 `execution_summary`，但不会把它提升成
   `commandExecution` 或 `terminalReport`。只有 Host evidence 和 publication barrier
   能创建事实/结果行。

Contract adapter 必须在进入 projector 前完成以下校验：wire kind 属于
`conversationItemKindsV1`，payload 与 kind 匹配，`terminal_report` 能 join 到
`generation + resultItemId`，operation item 有完整 lineage。任何未知 wire kind、snake/
camel 混用或缺失 join 都生成 `diagnostic(unknown_item|owner_conflict)`，不能用
`as any`、文本标题或时间邻近猜一个 renderer。测试需同时断言三层名字，确保同一 fixture
在 normal/private/channel/topic/branch/child 中得到相同的 projection kind 和 renderer key。

### 5.2 位置和通用字段

```ts
type TimelinePosition = {
  readonly conversationItemId: string;
  readonly sequence: number;       // durable order cursor
  readonly partIndex: number;      // projection-only, 0 for persisted item
};

type ConversationOperationSourceRef = {
  readonly kind:
    | "conversation_item" | "run_event" | "execution_action" | "run" | "attempt"
    | "participant" | "workflow_step" | "work_unit" | "approval" | "artifact"
    | "file" | "path" | "diff" | "image" | "context_snapshot" | "context_view"
    | "tool_call";
  readonly id: string;
  readonly label?: string;
  readonly path?: string;
  readonly hostTarget?: "open_file" | "open_diff" | "open_artifact" | "open_run";
  readonly capabilityId?: string;
  readonly workspaceId?: string;
  readonly visibility?: "conversation" | "private" | "audit";
};

type ConversationTimelineItemBase = {
  readonly id: string;
  readonly kind: ConversationTimelineItemKind;
  readonly position: TimelinePosition;
  readonly revision: number;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
};

type OperationLineageEnvelope = {
  readonly actionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly participantId: string;
  readonly workflowStepId: string | null;
  /** Operation adapters must carry the same refs exposed by the base item. */
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
};
```

每个执行事实行和 batch 都必须保留 `actionId`、`runId`、`attemptId`、`participantId`、
`workflowStepId`、`sourceRefs`。`approval` 是独立的控制事实，始终保留
`approvalId`；只有它确实关联某个执行动作时才填写 `actionId/runId/attemptId`，不得
为了满足 UI 猜造 action。主 feed 中的执行事实至少有一个同 thread 的
`conversation_item` anchor。缺 anchor、跨 thread 或缺必填 lineage 时，事实仍可
出现在 audit/detail，但主 feed 只能显示 `diagnostic(blocked)`。

### 5.3 叙述 item

```ts
type MessageItem = ConversationTimelineItemBase & {
  readonly kind: "userMessage" | "agentMessage";
  readonly authorId?: string;
  readonly content: readonly ConversationContentPart[];
  readonly editable?: boolean;
};

type ConversationContentPart =
  | { readonly kind: "paragraph"; readonly markdown: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: "code"; readonly language?: string; readonly code: string }
  | { readonly kind: "pathCandidate"; readonly raw: string; readonly displayName: string }
  | { readonly kind: "fileRef"; readonly ref: ConversationOperationSourceRef; readonly label: string }
  | { readonly kind: "link"; readonly href: string; readonly label: string };

type ReasoningItem = ConversationTimelineItemBase & {
  readonly kind: "reasoning";
  readonly summary: string; // explicit safe summary only
};

type PlanItem = ConversationTimelineItemBase & {
  readonly kind: "plan";
  readonly title: string;
  readonly steps: readonly {
    readonly id: string;
    readonly label: string;
    readonly status: "pending" | "running" | "completed" | "blocked";
  }[];
};
```

实现 DTO 目前保留 `ConversationTimelineMessageItem.markdown` 原文；上面的
`ConversationContentPart[]` 是 renderer 在 Markdown AST 阶段得到的投影，不要求新增
持久化列。`pathCandidate` 只表示模型文本中识别出的展示候选：显示 basename、文件图标
和完整路径 tooltip，可复制但不可导航；只有同一个 item 的 Host `sourceRefs` 能把它升级
为 `fileRef`。这样既能保留段落、列表、fenced code 和本地 path 的结构，也不会把每个
换行拆成一条新的历史 item。`plan` 的 `completed` 只表示计划节点完成，不能映射为事实
行的 `Succeeded`。

`reasoning` 不是 chain-of-thought。prompt、隐藏推理、selector score、token 统计和
provider 内部事件永不进入 transcript。

### 5.4 事实 item

```ts
type TimelineWaitingReason =
  | "approval" | "dependency" | "fan_in" | "reconnect" | "evidence";

type CommandExecutionItem = ConversationTimelineItemBase & OperationLineageEnvelope & {
  readonly kind: "commandExecution";
  readonly command: string;
  readonly cwd?: string;
  readonly status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "blocked";
  readonly waitingReason?: TimelineWaitingReason;
  readonly outputTail?: readonly { readonly stream: "stdout" | "stderr"; readonly text: string }[];
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly detailRef?: ConversationOperationSourceRef;
};

type ExplorationItem = ConversationTimelineItemBase & OperationLineageEnvelope & {
  readonly kind: "exploration";
  readonly operation: "read" | "grep" | "find" | "ls" | "search";
  readonly title: string;
  readonly targets: readonly ConversationOperationSourceRef[];
  readonly resultSummary?: string;
};

type FileChangeItem = ConversationTimelineItemBase & OperationLineageEnvelope & {
  readonly kind: "fileChange";
  readonly change: "created" | "edited" | "deleted" | "renamed";
  readonly displayName: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly fileRef?: ConversationOperationSourceRef;
  readonly diffRef?: ConversationOperationSourceRef;
};

type ToolCallItem = ConversationTimelineItemBase & OperationLineageEnvelope & {
  readonly kind: "mcpToolCall" | "dynamicToolCall" | "collabAgentToolCall";
  readonly toolName: string;
  readonly providerLabel?: string;
  readonly inputSummary?: string;
  readonly resultSummary?: string;
  readonly detailRef?: ConversationOperationSourceRef;
};

type ApprovalItem = ConversationTimelineItemBase & {
  readonly kind: "approval";
  readonly approvalId: string;
  readonly actionId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly participantId?: string;
  readonly workflowStepId?: string | null;
  readonly title: string;
  readonly decision?: "allowed" | "denied" | "expired" | "cancelled";
};
```

`imageView`、`contextCompaction` 和 `diagnostic` 也必须保留 source refs；它们不拥有
命令、文件或 TerminalReport 的完成语义。

### 5.5 子 Agent item

```ts
type SubAgentActivityItem = ConversationTimelineItemBase & {
  readonly kind: "subAgentActivity";
  readonly actionId: string;
  readonly runId: string | null;
  readonly attemptId: string | null;
  readonly participantId: string;
  readonly workflowStepId: string | null;
  readonly label: string;
  readonly lifecycle: "started" | "running" | "waiting" | "interrupted"
    | "completed" | "blocked" | "errored";
  readonly childItems: readonly ConversationTimelineItem[];
};
```

子 Agent 运行启动前允许 `runId/attemptId=null`；一旦产生事实，两者必须同时存在。
子 timeline 使用同一 registry，`depth=1`；`depth=2` 变成
`diagnostic(nested_depth_exceeded)`。父 delegation anchor 不复制进子 timeline。

### 5.5.1 TerminalReport item：execute turn 的唯一终态结果

`TerminalReport` 是 Ling 相对于 Codex item 模型增加的结果 item。它不是第二个
activity panel，也不是 Timeline 外的 summary；daemon 在最终结果发布事务中把它和
final-result `conversation_item` 绑定，projector 只生成一个 `terminalReport` owning
row：

```ts
type TerminalReportItem = ConversationTimelineItemBase & {
  readonly kind: "terminalReport";
  readonly reportId: string;
  readonly generation: number;
  readonly outcome: "succeeded" | "failed" | "cancelled" | "blocked";
  readonly title: string;
  readonly summary: string;
  readonly changeRefs: readonly ConversationOperationSourceRef[];
  readonly verificationRefs: readonly ConversationOperationSourceRef[];
  readonly artifactRefs: readonly ConversationOperationSourceRef[];
  readonly participantRefs: readonly ConversationOperationSourceRef[];
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
};
```

显示规则：

- `reply` turn 没有执行事实时，最终 `agentMessage` 是结果；不额外生成
  `terminalReport`。
- `execute` turn 通过 Completion Gate 后，`terminalReport` 是唯一终态结果；provider 的
  final 文本只能作为它的 `summary` 输入或 audit evidence，不能再生成一条重复的最终
  assistant 卡片。
- 进度期的 `agentMessage`、plan 和 participant narration 可以保留，但不得把
  `ready/done/已完成` 当作终态，也不得复制 report 的 changes、verification 或 artifacts。
- report 只显示 bounded summary、changes、verification、artifacts 和 risks 的 source
  refs；完整命令输出仍由 owning fact row/artifact viewer 按需打开。

`terminalReport` 的 `generation`、`reportId` 和 `sourceRefs` 必须出现在 semantic state
与 lineage evidence 中。重复回调、SSE replay 或 daemon restart 只能更新同一 report row
的 revision，不能产生第二个结果。

投影接口必须显式接收 TerminalReport records，不能由 surface 从旧 WorkCell rows 或
assistant 文本临时拼出结果：

```ts
type CanonicalTerminalReportRecord = {
  readonly id: string;
  readonly generation: number;
  readonly revision: number;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly anchorItemId: string; // durable final-result conversation_item
  readonly committedAt: string;
  readonly outcome: TerminalReportItem["outcome"];
  readonly title: string;
  readonly summary: string;
  readonly changeRefs: readonly ConversationOperationSourceRef[];
  readonly verificationRefs: readonly ConversationOperationSourceRef[];
  readonly artifactRefs: readonly ConversationOperationSourceRef[];
  readonly participantRefs: readonly ConversationOperationSourceRef[];
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
};
```

projector 先按 `source kind + source id` 选择最高 committed generation，再验证
`workspaceId/threadId/turnId/runId/attemptId/anchorItemId`。同 generation 的 payload 冲突
产生 `diagnostic(owner_conflict)` 并 fail closed；低 generation 进入 audit，不进入主
Timeline。这个选择发生在 display batch 之前，renderer 和 surface 不得再次选 report。

### 5.6 Batch 和 diagnostic item

```ts
/**
 * A batch has a display identity, while its childActionIds keep the durable
 * Host identities. Do not alias this to OperationLineageEnvelope: the latter's
 * actionId names one real execution action.
 */
type ActivityBatchLineageEnvelope = {
  readonly actionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly participantId: string;
  readonly workflowStepId: string | null;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
};

type ActivityBatchItem = ConversationTimelineItemBase & ActivityBatchLineageEnvelope & {
  readonly kind: "commandBatch" | "explorationBatch";
  readonly actionIds: readonly string[];
  readonly childActionIds: readonly string[];
  readonly childItemIds: readonly string[];
  /** Display-only payload; children remain atomic facts and are never nested batches. */
  readonly batch: CommandBatchPayload | ExplorationBatchPayload;
};

type DiagnosticItem = ConversationTimelineItemBase & {
  readonly kind: "diagnostic";
  /** Closed UI reason; provider-specific codes stay behind diagnosticRef. */
  readonly code:
    | "missing_lineage"
    | "missing_anchor"
    | "scope_mismatch"
    | "revision_conflict"
    | "event_conflict"
    | "stale_revision"
    | "stale_or_duplicate"
    | "markdown_parse_failed"
    | "missing_context_source"
    | "owner_conflict"
    | "attempt_order_unknown"
    | "nested_depth_exceeded"
    | "unknown_item";
  readonly title: string;
  readonly detail?: string;
};

type ImageViewItem = ConversationTimelineItemBase & {
  readonly kind: "imageView";
  readonly artifactRef: ConversationOperationSourceRef;
  readonly alt: string;
};

type ContextCompactionItem = ConversationTimelineItemBase & {
  readonly kind: "contextCompaction";
  readonly summary: string;
  readonly snapshotRef?: ConversationOperationSourceRef;
};

/**
 * Channel/workflow lifecycle records use the factual row grammar but are not
 * execution evidence. They must never claim command/file/tool completion or
 * invent an operation lineage envelope.
 */
type ProtocolEventItem = ConversationTimelineItemBase & {
  readonly kind: "protocolEvent";
  readonly protocolKind: "decision" | "handoff" | "summary" | "workflow"
    | "workflow-step" | "task" | "run" | "state-transition";
  readonly title: string;
  readonly meta?: string;
  readonly description?: string;
};

type ConversationTimelineItem =
  | MessageItem | ReasoningItem | PlanItem
  | CommandExecutionItem | ExplorationItem | FileChangeItem | ToolCallItem
  | ApprovalItem | ImageViewItem | ContextCompactionItem | TerminalReportItem | ProtocolEventItem
  | SubAgentActivityItem | ActivityBatchItem | DiagnosticItem;
```

`ActivityBatchItem.batch` 只能引用已投影的 atomic children，不能嵌套 batch；实现层的
`ConversationTimelineCommandBatchItem`/`ConversationTimelineExplorationBatchItem` 分别
提供 `batch.commands`/`batch.children`，并同时保留 `childActionIds`、`childItemIds`。

### 5.7 Renderer 输入契约和稳定语义接口

渲染器只接收已经完成 scope、lineage、attempt 和 revision 校验的 item。它不接收
raw SSE、SQLite handle 或 provider payload。每个 renderer 的输入和输出必须满足：

```ts
type TimelineRendererProps<T extends ConversationTimelineItem = ConversationTimelineItem> = {
  readonly item: T;
  readonly depth: 0 | 1;
  readonly expanded: boolean;
  readonly policy: ConversationInteractionPolicy;
  readonly callbacks: ConversationTimelineCallbacks;
};

type ConversationTimelineItemStatus =
  | "pending" | "running" | "waiting" | "succeeded"
  | "failed" | "cancelled" | "blocked";

type TimelineStatusKey = ConversationTimelineItemStatus | "reconnecting";

type TimelineSemanticAttrs = {
  readonly id: `conversation-timeline-${string}`;
  readonly kind: ConversationTimelineItemKind;
  /** Stable dotted key used by the exhaustive renderer registry/fingerprint. */
  readonly rendererKey: string;
  /** Stable machine value used by selectors; never localized. */
  readonly status?: TimelineStatusKey;
  /** Localized copy is derived once by the shared renderer. */
  readonly statusText?: string;
  readonly revision: number;
  readonly depth: 0 | 1;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
};
```

每个 item row 必须同时暴露 `data-conversation-timeline-id`、
`data-conversation-timeline-kind`、`data-conversation-timeline-renderer-key`、
`data-conversation-timeline-status`、`data-conversation-timeline-revision` 和
`data-conversation-timeline-depth`；Timeline root 另暴露整条流的
`data-conversation-timeline-renderer-keys`。`data-status` 使用稳定 machine value，用户看到的
`Queued/Working/...` 由同一个 renderer 做本地化；测试应同时检查 machine value 和
可见文本。这些属性是测试和诊断接口，不是权限输入。renderer 不得从 `item.content`
推断动作状态，也不得根据 surface 名称切换另一套视觉组件。

## 6. 持久化、上下文和 session 边界

Ling 采用“全部历史持久化、按需投影”的模型，而不是最近 8 条平铺消息：

```text
LingThread
  └── LingTurn
      └── ConversationItem（完整顺序）
          ├── Run / Attempt
          ├── RunEvent / ExecutionAction
          ├── Artifact / Approval
          └── ParticipantSpan / ContextSnapshot
```

- SQLite 是事实源；SSE 只是增量传输，不是排序权威。
- reload、resume、SSE reconnect、daemon restart 都从 durable snapshot 重建同一
  projection fingerprint。
- `contextSegmentId` 只属于 context snapshot/运行快照。它不能由模型猜测，也不能
  因为 UI 把几次 read 合并成 batch 就改变。
- 选择性记忆是 projector 的输入策略：保留全量可追溯历史，同时为当前 turn 选择
  相关 segment、最近摘要和 source refs。摘要可以帮助模型，但不能替代原子事实。
- 新 run/attempt 必须显式关联 `threadId`、`turnId`、`runId`、`attemptId`；不再由
  UI 根据时间或文本拼接 session。

### 6.1 Surface 到 `LingThread` 的确定性映射

“普通会话、私聊、频道”是产品入口，不是三套历史存储。进入 Timeline 前，surface
adapter 必须先解析出一个 canonical `LingThread.id`，再读取同一份 turn/item/evidence
快照。映射规则如下：

| Surface | `LingThread` 映射 | 允许的父级/锚点 | 不允许 |
| --- | --- | --- | --- |
| 普通会话 | 一个 workspace-scoped `surfaceKind="work"` thread | 无；后续 turn 继续该 thread | 以最近 N 条消息临时拼 session |
| 队友私聊 | 一个 user + teammate scoped `surfaceKind="direct"` thread | 无；同一 pair 继续该 thread | 为每次发送新建 session、复用频道历史，或使用 `private:<teammateId>` 等 synthetic thread |
| 频道 root | 一个 `surfaceKind="channel_root"` thread | channel 是外层容器 | `thread_id = NULL` 的隐式 owner |
| Topic | `surfaceKind="topic"` 子 thread | `parentThreadId + parentTurnId + anchorItemId` | 把 parent 消息复制进 Topic transcript |
| Branch/fork | `surfaceKind="branch"` 子 thread | `parentThreadId + parentTurnId + forkContextSnapshotId` | 让 parent 后续写入改写 branch 历史 |
| depth-1 子 Agent | 父 thread 内的 `ParticipantSpan`/`subAgentActivity` | parent item + participant/run/attempt | 创建第二个可见滚动区或 child-specific session |

Topic 和 Branch 必须由用户或已验证的产品动作显式创建；根 thread 内的语义换话题只
改变 `contextSegmentId`，不自动创建可见子 thread。Branch 在创建点记录不可变的
`forkContextSnapshotId`，之后独立追加 turns/items。Topic 的 anchor 仍只在 parent timeline
显示，子 timeline 通过 `sourceRefs` 回链，而不是渲染一份副本。

surface adapter 的最小输出是：

```ts
type ResolvedConversationSurface = {
  readonly threadId: string;
  readonly kind: "normal" | "private" | "channel_root" | "topic" | "branch" | "child";
  readonly parentThreadId: string | null;
  readonly anchorItemId: string | null;
  readonly workspaceId: string;
  readonly depth: 0 | 1;
  readonly policy: ConversationInteractionPolicy;
};

/**
 * A child Agent is a participant span inside the parent's Thread, not a new
 * user-visible Thread. Keeping this distinction explicit prevents a surface
 * adapter from inventing `child:<id>` or `private:<id>` transcript identities.
 */
type ConversationScopeIdentity =
  | {
      readonly kind: "thread";
      readonly threadId: string; // real LingThread.id
      readonly parentThreadId: string | null;
      readonly anchorItemId: string | null;
    }
  | {
      readonly kind: "child";
      readonly threadId: string; // parent's real LingThread.id
      readonly parentThreadId: string;
      readonly anchorItemId: string;
      readonly participantId: string;
      readonly depth: 1;
    };
```

私聊若解析不到持久化 `LingThread.id` 必须 fail closed：显示
`diagnostic(scope_mismatch)` 并提供重新加载/创建私聊 thread 的入口。不得把 teammate id、
route 参数或当前时间拼成临时 thread；否则 reload、resume 和 lineage 会再次分叉。

`ConversationTimeline` 不接收 `channelId`、模型猜出的 target 或 synthetic id；它只接收
解析后的 `ConversationScopeIdentity`（child 时仍指向父级真实 Thread）和 canonical items。
这样三种会话及嵌套 child 可以共享 renderer，而不会把路由语义泄漏到渲染层。

### 6.2 `contextSegmentId` 的权威分配

`contextSegmentId` 是 turn 的上下文投影字段，不是 message、batch 或 renderer 字段。
分配采用“显式优先、结构其次、模型提议、服务端提交”的单向流程：

```text
user explicit segment/topic/branch
            │ no
            ▼
structural relation (reply, quote, retry, approval, active run)
            │ no
            ▼
permission-filtered model proposal (candidate ids only)
            ▼
ContextSegmentationPolicy validates + commits TurnContextAssignment
```

1. 用户显式选择已有 segment，或显式创建 Topic/Branch 时，选择是最终权威。
2. 回复、引用、审批、steer、retry、resume、tool result 和明确的 domain correlation
   由规则确定性继承，不调用模型。
3. 规则无法判定时，模型只能在服务端提供的 candidate ids 中返回
   `continue`、`switch_existing`、`propose_new` 或 `uncertain`；模型不能写入 segment，
   不能发明 id，也不能读取无权限 segment。
4. `ContextSegmentationPolicy` 校验 scope、权限、置信度和 evidence item ids 后，原子
   写入 `TurnContextAssignment`。拒绝或不确定时沿用上一有效 segment；若当前 thread
   没有上一有效 segment，则创建 `provisional` segment，并产生可追溯 diagnostic。绝不
   因 UI 合并几次 read 而改变 assignment。

### 6.3 全量历史与选择性上下文

SQLite 保存完整 `LingThread → LingTurn → ConversationItem → RunEvent/ExecutionAction`
历史。UI 可以用 cursor 只加载可见窗口，但分页边界必须由 durable `sequence` 和
coverage watermark 定义，不能用“最近 8 条”截断事实。模型上下文是对完整历史的选择性
投影：当前 segment 的摘要、最近相关 turns、显式 source refs 和权限允许的 memory
facts；摘要缺失时回读原子 items，不把摘要当作命令或文件事实。

因此“聊久了会不会失忆”的答案分成两层：

- **存储层不会失忆**：历史、attempt、revision、artifact 和 source refs 全部可恢复；
  reload、resume、SSE reconnect、daemon restart 都从同一 durable snapshot 重建。
- **上下文层不会盲目膨胀**：每个 turn 只投影相关 segment，但任何选择都有
  `contextSegmentId`、coverage watermark 和 source refs，可审计、可回读、可纠正。

### 6.4 Session 边界不是 provider session

`LingThread` 是产品和持久化连续性；provider 的临时 session、Pi loop 或 adapter
实例只是某次 Run 的执行资源。provider 重启、切换或失效不创建新的用户会话，也不能
丢失旧 turn。恢复流程总是：读取 thread/turn → fold durable evidence → 重新创建 provider
执行上下文（如需要）→ 继续追加同一 thread 的新 attempt。

## 7. 生命周期、identity 和 evidence fold

### 7.1 状态机

```text
pending -> running -> succeeded | failed | cancelled
                 \-> waiting -> running | blocked
```

### 7.2 `tool_start/update/end`

1. `tool_start` 创建稳定 `actionId`/`toolCallId` 和 `revision=1`。
2. `tool_update` 只追加到同一 action 的 bounded evidence，并提升 revision。
3. 第一个被 durable store 接受的 `tool_end` 是 terminal fence；之后的 update/end
   只能记录为 stale/duplicate diagnostic，不能 reopen。
4. 每次接受的 revision 都发出 live invalidation；UI 通过 id 原地更新，不追加消息。
5. stdout/stderr 只保留 bounded tail，完整输出通过 trusted artifact ref 访问。

排序使用 `ConversationItem.sequence + partIndex`；revision 只用于同一实体的更新，
不得替代 canonical sequence。

### 7.3 Retry、reconnect 和 restart

- retry 创建新 `attemptId`；最新有效 attempt 进入主 lane，旧 attempt 只留 audit。
- SSE 重连按 entity id + revision 幂等合并，乱序不会改变结果。
- daemon restart 从 SQLite 重新 fold，不能依赖内存 batch 或最后一条 SSE。
- equal-revision 不同 payload 是冲突 diagnostic；低 revision 是 stale，不覆盖现值。

### 7.4 Evidence fold 的可执行不变量

所有入口（初始 snapshot、SSE delta、reconnect replay、daemon restart replay）都调用同一
纯 fold。实现可以使用 Map，但必须满足下面的伪代码和不变量：

```text
fold(snapshot, delta):
  for entity in delta ordered by (sequence, revision, entityId):
    current = state[entity.entityId]
    if current is terminal:
      append diagnostic(stale_or_duplicate, source=entity)
      continue
    if entity.revision < current.revision:
      append diagnostic(stale_revision, source=entity)
      continue
    if entity.revision == current.revision and entity.payload != current.payload:
      append diagnostic(revision_conflict, source=entity)
      continue
    state[entity.entityId] = mergeEvidence(current, entity)
    if entity.kind == tool_end:
      state[entity.entityId].terminalFence = entity.revision
    emitInvalidation(entity.entityId, entity.revision)
  return state
```

硬性不变量：

- 同一 `actionId` 在所有输入顺序下最多有一个可见事实 item 和一个 terminal fence；
- `revision` 单调递增，equal-revision 冲突不覆盖现值；
- terminal fence 之后的迟到事件只能进入 audit/diagnostic；
- fold 不依赖内存 batch、可见行数、最后一条 SSE 或模型 ready 文本；
- 对同一 durable snapshot 重放两次，得到的 item fingerprint 必须完全相同。

### 7.5 事件幂等键和冲突处理

每个 Host 事件都必须带有稳定 `eventId`、`entityId`、`actionId`、`revision`、
`sequence` 和 `emittedAt`。`eventId` 用于去重，`entityId + revision` 用于同一 action
的版本合并；`emittedAt` 只能用于诊断，不能参与排序。

```ts
type RunEvidenceEnvelope = {
  readonly eventId: string;
  readonly entityId: string;
  readonly actionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly participantId: string;
  readonly workflowStepId: string | null;
  readonly sequence: number;
  readonly revision: number;
  readonly kind: "tool_start" | "tool_update" | "tool_end";
  readonly payload: unknown; // decoded and validated before fold
  readonly emittedAt: string;
};
```

处理顺序固定为：先按 `eventId` 去重，再按 `entityId + revision` 做幂等合并，最后
按 `sequence` 投影。相同 `eventId` 的 payload 不一致是 `diagnostic(event_conflict)`；
相同 entity 的 equal revision 不同 payload 是 `diagnostic(revision_conflict)`。这两类
冲突都不能覆盖已接受事实，也不能让 UI 产生第二个 action row。`payload` 在进入
fold 前必须通过 provider/daemon adapter 的 discriminated-union 校验，未识别事件只
能进入 audit diagnostic。

### 7.6 事件接受矩阵

实现不能让每个 SSE handler 自行决定“追加还是更新”。所有入口都按同一张表处理：

| 输入 | Durable 行为 | 主 Timeline | Audit/diagnostic |
| --- | --- | --- | --- |
| 首个 `tool_start` | 创建 entity/action，`revision=1` | 创建一个 pending/running row | 无 |
| 新 `tool_update` | 追加 bounded evidence，revision 增加 | 原 row 原地更新 | 完整输出仅 artifact |
| 首个有效 `tool_end` | 写 terminal fence | 原 row 原地变为终态 | 无 |
| 重复 `eventId` | 幂等忽略 | 不变 | 可计数，不生成第二 row |
| 低 revision | 不覆盖 | 不变 | `stale_revision` |
| equal revision 不同 payload | 不覆盖 | 不变 | `revision_conflict` |
| terminal 后 update/end | 不 reopen | 不变 | `stale_or_duplicate` |
| SSE reconnect replay | 按 id/revision fold | 保持同 row、focus、disclosure | 仅真实冲突可见 |
| daemon restart replay | 从 SQLite 重建 | fingerprint 与重启前一致 | 旧 Host capability 失效 |

这张表同时约束普通、私聊、频道和 child。surface adapter 只能提供 scope，不能改变
事件接受规则。

## 8. 排序、lineage、owner 和完成

### 8.1 单 owner

一个逻辑事实只有一个 owner：

| 语义 | 唯一 owner |
| --- | --- |
| 普通 `reply` 结果 | 最终 `agentMessage` |
| 命令事实 | `commandExecution` |
| 文件事实 | `fileChange` + trusted diff/artifact |
| 工具事实 | 对应 typed tool item |
| 待审批控制 | Composer/dialog gate |
| `execute` 终态报告 | 唯一 `terminalReport` item |
| UI 折叠 | Timeline local view state |

禁止同一 action 同时出现在 assistant bubble、WorkCell、`terminalReport` summary 和
Composer 下方。路由可以组合消息和 Timeline，但事实列表必须只有一个 owner；
`TerminalReport` 本身只能通过 `terminalReport` item 进入 Timeline，不能由 Timeline 外的
独立 summary component 再渲染一次。

### 8.2 TerminalReport / fan-in

完成判断只读取原子 evidence：

```text
required participant ids
  ├─ terminal action evidence
  ├─ explicit structured blocked result
  └─ durable approval/lease outcome
             │
             ▼
       TerminalReport / fan-in
```

“ready”文本、batch 数量、可见行数、最后一个 SSE 事件都不能单独让任务成功。
缺 required participant evidence 时状态只能是 `waiting` 或结构化 `blocked`。

### 8.3 计划层与事实层的分层

计划（`plan`）和真实执行（`commandExecution`、`fileChange`、typed tool item）都在一条
canonical timeline 中，但永远不是同一种 item，也不能互相“补完成”：

```text
agentMessage / plan       叙述：打算做什么、步骤是什么
        │
        ▼
ExecutionAction evidence  事实：命令、cwd、stdout/stderr、exit、diff、tool result
        │
        ▼
Completion Gate + publication barrier
        │
        ▼
terminalReport item       execute 结论：只由 required atomic evidence 计算
```

规则：

1. `plan` 的 step 状态只由对应 atomic evidence 映射；模型写“已完成”不会改变 step。
2. 一个 action 只能有一个 fact owner；同一命令不再同时出现在 assistant bubble、旧
   WorkCell、TerminalReport summary 和 Composer footer。
3. 没有 evidence 的 ready/完成文本仍作为 `agentMessage` 渲染，并在需要时附加
   `diagnostic(blocked)`；不得生成绿色成功行。
4. `execute` turn 的 `terminalReport` 是事实结论的唯一可见 owner；它引用 source refs，
   但不复制 command output。Composer 只拥有 approval control，不拥有完成摘要。
5. 排序使用 durable `sequence + partIndex`。计划可以先于执行出现；`reply` 的 final
   message 或 `execute` 的 `terminalReport` 在完成后出现；不得因“后来出现了总结”而把
   事实行移到别处。

## 9. Display-only batching

### 9.1 统一规则

batch 在 canonical atomic projection 之后、Timeline 之前执行一次。它们：

- 不落 SQLite；
- 保留所有 child item、`actionIds`、lineage 和 source refs；
- 可展开恢复精确原子顺序；
- 不参与 completion、fan-in、retry、approval 或 context 分段；
- running/waiting/failed/blocked/consequential action 不隐藏关键证据。

### 9.2 commandBatch

只合并相邻、成功、低风险、同一 `agent/participant + run + attempt + workflowStep`
的命令；至少 3 个 child 才显示 batch。以下边界必须 flush：

- agent、run、attempt、retry/resume/repair/validation、workflow step 或 work unit 改变；
- approval、failure、cancel、timeout、blocked 或 active action；
- edit/write、git commit/push、deploy、external send、credential/provider change；
- message、plan、file、exploration、MCP、browser、artifact 或 handoff；
- 缺 action identity、anchor、attempt 或 source refs。

### 9.3 explorationBatch

只合并相邻、成功、同 lineage 的 `read/grep/find/ls`。默认至少 3 个 child；search
和外部 MCP 首先保持 standalone。UI 合并不改变 `contextSegmentId`。

### 9.4 Batch identity

```text
commandBatch:{participantId}:{runId}:{attemptId}:{firstActionId}
explorationBatch:{participantId}:{runId}:{attemptId}:{firstActionId}
```

`batch.actionId` 使用上面的稳定 display identity；它不是持久化的
`ExecutionAction.actionId`，也不能被当成新的命令事实。`actionIds`/`childActionIds`
仍保存每个真实 child 的 action identity，`sourceRefs` 仍保存每个 child 的可追溯引用。
同一批次只允许来自同一 participant、run、attempt 和 workflow step，因此
`runId/attemptId/participantId/workflowStepId` 是该批次的共同 lineage；无法证明共同
lineage 时不生成 batch。batch revision 是 child revision 的最大值；completion/fan-in
永远读取 child actions。

为了避免 batch identity 与 Host action identity 混淆，UI 和测试必须使用不同的字段：

```text
data-conversation-timeline-id = batch.actionId       // display wrapper identity
data-child-action-ids        = actionIds.join(",")   // durable child identities
sourceRefs                   = union(child.sourceRefs)
```

batch display identity 只能由 projector 计算，不能写入 SQLite，也不能在 retry、approval、
TerminalReport 或 fan-in 中作为 action/run 完成依据。

### 9.5 批次拆分的确定性算法

批次投影使用单次线性扫描，任何边界都先 flush 再处理当前 item。边界判定不读取
文案、不读取可见行数，且返回可审计的 `splitReason`：

```ts
type BatchSplitReason =
  | "narration"
  | "kind"
  | "participant"
  | "run"
  | "attempt"
  | "workflow_step"
  | "context_scope"
  | "approval"
  | "retry"
  | "non_adjacent"
  | "non_terminal"
  | "consequential"
  | "missing_lineage";
```

```text
for item in atomic:
  if item is not eligible: flush(splitReason(item))
  else if lineage(item) != lineage(openBatch): flush(splitReason(left, item))
  else if item.sequence != previous.sequence + 1: flush("non_adjacent")
  else if consequential(item): flush("consequential")
  append(item)
flush("end")
```

`splitReason` 只存在 projection/debug 结果，不落 SQLite，也不显示给普通用户。
它必须在 component test 中覆盖 agent/run/attempt/workflow step、approval、失败、
取消、retry、resume、repair、validation、write/edit、commit/push、deploy、MCP、
browser、artifact、handoff 和缺 source ref 等边界。active item 永远单独显示，不能
被已经打开的 batch 吸收。

实现级诊断结果和可逆展开接口固定如下：

```ts
type BatchSplitBoundary = {
  readonly beforeItemId: string;
  readonly afterItemId: string | null;
  readonly reason: BatchSplitReason;
};

type DisplayBatchProjection = {
  readonly items: readonly ConversationTimelineItem[];
  readonly boundaries: readonly BatchSplitBoundary[];
};

projectDisplayBatches(atomic, context) -> DisplayBatchProjection
expandDisplayBatch(item) -> readonly ConversationTimelineItem[]
```

`batchCanonicalTranscriptItems` 只返回 `DisplayBatchProjection.items`。若没有已提交的
`contextSegmentIdByItemId`，必须保持所有候选为原子行，并在相邻候选之间记录
`context_scope`；不能因 run/participant 元数据相同就猜测可以合并。展开结果必须保留
原始 child 的 canonical 顺序、`actionId` 与 `sourceRefs`，不得读取 batch 数量或重建另一
份事实模型。

## 10. 统一渲染架构

```text
ConversationSurfaceShell（policy + chrome）
└── ConversationFeedViewport（唯一纵向 overflow/scroll owner）
    └── ConversationTimeline（无纵向 overflow，只拥有 item/disclosure/focus）
        ├── MessageRenderer（user/agent Markdown）
        ├── FactRenderer（command/file/tool/approval/...）
        ├── BatchRenderer（可逆 disclosure）
        └── SubAgentRenderer
            └── ConversationTimeline(depth=1, same registry)
```

Timeline 只拥有 disclosure、focus 和稳定 anchor id；实际滚动与 anchor measurement 由
外层 `ConversationFeedViewport` 统一执行：

```ts
type ConversationTimelineProps = {
  /** One immutable, already-scoped snapshot per render. */
  readonly snapshot: TimelineSnapshot;
  /** Surface interaction policy; never inferred by a renderer from the route. */
  readonly policy: ConversationInteractionPolicy;
  readonly depth: 0 | 1;
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly cwd?: string;
  readonly callbacks: ConversationTimelineCallbacks;
};

// `ConversationTimelineCallbacks` is the canonical type defined in §10. It is
// referenced here rather than re-declared, so a surface cannot grow a second
// callback contract by accident.
```

Timeline 不接收 SQLite handle、raw SSE、provider payload 或 daemon client；Host action
由 surface shell 注入，并在进入 callbacks 前完成 trusted path/permission 检查。审批、
停止和重试控件由 Composer/approval gate 唯一拥有；Timeline 只显示状态和详情，不接受
会重新分叉控制权的 `renderFactActions` callback。

### 10.1 Exhaustive registry 与嵌套规则

registry 是唯一 kind 到 renderer 的映射，新增 kind 必须在编译期被迫补齐：

```ts
type TimelineRenderer = (props: TimelineRendererProps) => React.ReactNode;

const RENDERERS: Record<ConversationTimelineItemKind, TimelineRenderer> = {
  userMessage: renderMessage,
  agentMessage: renderMessage,
  reasoning: renderReasoning,
  plan: renderPlan,
  commandExecution: renderCommand,
  exploration: renderExploration,
  fileChange: renderFileChange,
  mcpToolCall: renderToolCall,
  dynamicToolCall: renderToolCall,
  collabAgentToolCall: renderToolCall,
  approval: renderApproval,
  imageView: renderImage,
  contextCompaction: renderCompaction,
  terminalReport: renderTerminalReport,
  protocolEvent: renderProtocolEvent,
  subAgentActivity: renderSubAgent,
  commandBatch: renderCommandBatch,
  explorationBatch: renderExplorationBatch,
  diagnostic: renderDiagnostic,
};
```

TypeScript 不允许新增 union member 却遗漏 registry entry。运行时来自旧数据或未知
provider 的 kind 只能通过 `diagnostic(unknown_item)`，不能 `as any` 回退到消息气泡。
`subAgentActivity` 只递归一次：它向 registry 传入 `depth=1`，并在 `depth=2` 生成
`diagnostic(nested_depth_exceeded)`。递归 child 与父级共享同一个 scroll owner、disclosure
状态模型和 stable selectors。

### 10.2 统一渲染的最小 fingerprint

为证明三种会话没有暗中分叉，component/E2E fixture 必须记录：

```ts
type TimelineFingerprint = {
  readonly kinds: readonly ConversationTimelineItemKind[];
  readonly ids: readonly string[];
  readonly rendererKeys: readonly string[];
  readonly statusTexts: readonly string[];
  readonly depth: readonly number[];
};
```

同一 fixture 在 normal/private/channel/topic/branch/child 的 fingerprint 必须一致；允许
变化的只有 surface chrome（标题、roster、mention policy）和 depth-1 participant rail。

### 10.3 Scroll、focus 和 disclosure 不变量

`ConversationFeedViewport` 是 surface 唯一的纵向 scroll owner；`ConversationTimeline`
只维护稳定 item id、disclosure/focus state，并把 anchor measurement 交给外层 viewport：

1. 用户距离底部超过 24px 时，新的 agentMessage 或 tool_update 不得抢滚动位置；
2. 用户在底部时，新增内容只通过一个 `requestAnimationFrame` 贴底，不能由多个
   `useEffect` 重复 `scrollTo`；
3. resize、字体加载或 batch 展开只修正当前 anchor 的相对偏移，不跳到历史顶部；
4. SSE reconnect、daemon restart 和 retry 只能更新同一 id 的 row，不得触发第二个
   scroll container；
5. focus 在 disclosure、trusted file action 和 retry 后仍保持可见，`Escape` 关闭
   detail/popover 后回到 owning row。

这些规则属于 shared feed viewport + Timeline 组合，不允许 normal/private/channel
各自实现一份滚动逻辑。`ConversationTimeline`、batch、fact detail 和 depth-1 child 都不得
设置纵向 `overflow:auto|scroll` 或自己的 scroll anchor。

### 10.4 统一 renderer 的组合契约

“统一会话组件”不是让每个 surface 传一份不同的 JSX，而是固定一条组合链：

```text
ResolvedConversationSurface
  -> TimelineSnapshot + policy + Host callbacks
  -> ConversationTimeline(snapshot, callbacks)
      -> renderTimelineItem(item, depth)
          -> document renderer / fact renderer / result renderer / batch renderer / nested renderer
```

组合契约只有三类输入：

1. `snapshot`：已经完成 scope、owner、attempt、revision 校验的 immutable items，以及
   `activeRun`、`canonicalRevision`、`sseCursor` 和 context lookup；
2. `policy`：可见性、是否允许 retry/open-file/approval，以及 surface 的外围 chrome；
3. `callbacks`：由 Host 注入的动作入口。renderer 不能自己读取路由、SQLite、SSE 或
   provider 状态。

每个 item 只能被组合链消费一次，并且只能产生一个 owning row。`agentMessage`、
`reasoning`、`plan` 和子 Agent narration 进入 document lane；`commandExecution`、
`fileChange`、tool、approval、protocol 和 diagnostic 进入 fact rail；`terminalReport`
进入 result lane；`subAgentActivity` 只增加 participant rail 并递归调用同一个
`ConversationTimeline`。不得再包一层旧 `MessageRow`/`WorkCell`，也不得由 surface 在
Timeline 外追加 summary、TerminalReport 或第二个 activity panel。

为避免“看起来统一、实际上分叉”，实现必须提供一个 surface-agnostic factory：

```ts
type ConversationTimelineMount = {
  readonly node: React.ReactNode;
  readonly fingerprint: TimelineFingerprint;
};

function mountConversationTimeline(
  input: ConversationTimelineMountInput, // canonical shape defined in §17.5
): ConversationTimelineMount {
  // I/O, scope validation, canonical projection, and optional batching happen
  // before this composition boundary. The mount itself is deliberately pure.
  return {
    node: <ConversationTimeline {...input} />,
    fingerprint: fingerprintTimeline(input.snapshot.items),
  };
}
```

`mountConversationTimeline` 只负责把已经解析好的 `TimelineSnapshot` 交给唯一
`ConversationTimeline`。它不接收 `channelId`、原始事件或多份 rows；surface adapter 在
mount 之前把 `ResolvedConversationSurface.policy/depth` 映射成同一份
`ConversationTimelineMountInput`。这样可以把“解析 scope”和“渲染 timeline”彻底分开，
避免调用方为了传入频道/私聊差异而复制一套 JSX。

上面的伪代码表达的是所有权而不是要求复制函数名：projection、batch 和 registry
只能各有一个实现。normal/private/channel/topic/branch/child 只负责构造
`ResolvedConversationSurface`，不能按 kind 自己分支渲染。相同 fixture 的
`fingerprint` 必须一致；任何差异都必须能归因到 `policy` 或 shell chrome，并在测试中
显式列出。

### 10.5 一次动作的可见生命周期

为了让用户始终看到“动作描述 → 进行中 → 结果”，同一 action 的可见生命周期固定为：

```text
agentMessage（可选叙述）
  -> commandExecution/tool/file row（Queued/Working）
      -> 同一 row 的 revision 更新（输出、状态、duration）
          -> Succeeded/Failed/Cancelled/Blocked
```

`agentMessage` 只解释意图，不能占据 action 的事实位置。没有 `ExecutionAction` 或
Host evidence 的“我会执行/已完成”仍是叙述；如果该叙述声称完成而 required evidence
缺失，projector 追加 `diagnostic(blocked)`，但不生成成功事实行。`tool_update`、retry
和 reconnect 都更新原 row 的 semantic id，不得插入新的“执行中”或“完成总结”行。

这条生命周期也适用于 depth-1 子 Agent：子 Agent 可以先输出 narration，再产生自己的
command/file/tool rows，最后由父级 fan-in 根据 atomic evidence 结论。子 Agent 不得用
一条 ready 文本、一个 plan step 或一个 batch 数量替代事实。

### 10.6 Shared surface adapter contract（实现接口）

三种会话和 depth-1 子 Agent 的差异只允许存在于 adapter 输入，不能进入 renderer。
实现时每个 surface 先构造同一形状的 `ResolvedConversationSurface`，再调用唯一的
`mountConversationTimeline`。下面的接口是约束边界，不要求把类型放进同一个文件：

```ts
type ResolvedConversationSurface = {
  readonly kind: "normal" | "private" | "channel_root" | "topic" | "branch" | "child";
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly anchorItemId: string | null;
  readonly workspaceId: string;
  readonly depth: 0 | 1;
  readonly policy: ConversationInteractionPolicy;
};

type ConversationTimelineCallbacks = {
  /** Focus/open controls only; approval, stop and retry stay in Composer. */
  readonly onFocusItem?: (itemId: string) => void;
  readonly onOpenSourceRef?: (
    ref: ConversationTrustedSourceRef,
    lineage: ConversationTimelineItemLineage,
  ) => void | Promise<void>;
  readonly loadPreview?: (ref: ConversationOperationSourceRef) => Promise<unknown>;
  readonly renderSubAgentAvatar?: (item: ConversationTimelineSubAgentItem) => ReactNode;
};

type ConversationTimelineMount = {
  readonly node: ReactNode;
  /** Stable semantic keys, not a pixel hash. Used for surface parity tests. */
  readonly fingerprint: {
    readonly rendererKeys: readonly string[];
    readonly itemKinds: readonly ConversationTimelineItemKind[];
    readonly itemIds: readonly string[];
    readonly disclosureCount: number;
  };
};
```

`mountConversationTimeline` 的实现顺序固定为：

1. surface adapter 校验 scope，并拒绝缺失 `threadId`/`workspaceId` 的 snapshot；
2. adapter 从同一 durable snapshot 生成 canonical atomic items；
3. adapter 至多调用一次 `batchCanonicalTranscriptItems` 生成可逆 display wrapper；
4. mount 将已经完成校验的 snapshot、policy 和 §10 的 canonical callbacks 交给
   `ConversationTimeline`，由
   exhaustive registry 渲染；
5. mount 同时计算 fingerprint，供 normal/private/channel/topic/branch/child 的 parity
   测试使用。mount 不执行 I/O、排序、完成判断或 capability 签发。

`ConversationVirtualFeed` 不再提供 `renderItem` fallback。virtualizer 只能调用
`renderVirtualRow -> ConversationTimeline`，normal/private/channel/topic/branch/child 都把
完整 snapshot 交给这个唯一 root；fixture 若需逐行断言，应直接调用纯 projector/registry。
这样不会出现“旧 per-item callback 没有被调用、但仍作为第二条渲染入口存在”的过渡状态，
也符合开发阶段直接切换新合同的决定。

adapter 不得导出 renderer、排序器、batch 函数或第二个 scroll owner。它只能提供
scope、policy、外围 chrome 和 Host callback。`node` 之外的 summary、TerminalReport、
approval control 或 environment 状态都不能作为 mount 的副产物。

#### 10.6.1 Source-ref upgrade boundary

文件引用分成三个不可混淆的阶段：

```text
model text / persisted fileRefs
  -> display-only path ref（basename + tooltip + copy）
  -> Host adapter 验证 workspace/thread/run/action/permission
  -> minted trusted ref（open_file/open_diff/open_artifact）
```

升级函数必须是纯的、可测试的 adapter，输入包括当前 surface scope 和 Host 返回的
capability；不能根据路径字符串自行添加 `hostTarget`。renderer 只允许把
`ConversationTrustedSourceRef` 传回 Host，普通 `path` ref 的按钮必须 disabled 或改为
复制动作。normal、private、channel 和 child 都调用同一升级函数，不能各自实现
`file://`、cwd 拼接或 callback 参数转换。

特别是 action lineage helper 不得因为 `file target` 或字符串后缀就预填
`hostTarget="open_file"`；只有 capability registry 返回的 opaque `capabilityId` 才能
把 display-only ref 升级为 trusted ref。这样可以避免“看起来像文件”被误当成 Host 事实。

#### 10.6.2 Surface parity invariant

同一 fixture 在四个 surface 中必须满足：

```text
fingerprint.rendererKeys  ==
fingerprint.itemKinds     ==
fingerprint.itemIds       ==
fingerprint.disclosureCount
```

允许变化的只有 shell title、roster、participant rail 和 policy hints。任何新增差异
必须先更新本节和对应的 parity fixture；不能通过在某个 route 增加临时 `MessageBubble`
或 `WorkCell` 来“修”截图。

### 10.7 UI 状态所有权

为了避免同一结果在 Timeline、Composer、浮窗和右侧 dock 重复出现，UI 状态按所有者
拆分：

| 状态 | 唯一 owner | 是否持久化 | 能否证明完成 |
| --- | --- | --- | --- |
| item kind/status/revision/lineage | canonical snapshot | 是 | 是，仅 factual item |
| batch membership | pure display projector | 否 | 否 |
| scroll position/anchor measurement | `ConversationFeedViewport` view state | 否 | 否 |
| disclosure/focus/anchor id | `ConversationTimeline` view state | 否 | 否 |
| 输入草稿/附件/stop/approval control | Composer | 草稿按现有策略 | 否，approval decision 除外 |
| 当前 active run 提示 | `EnvironmentPopover` | 否 | 否 |
| 文件/命令完整详情 | owning row 或 trusted detail dock | durable ref | 只引用，不另判定 |

`terminalReport` 是 atomic evidence 的唯一终态 result item，不是第二份 action list；
普通 `reply` 的 final `agentMessage` 解释结果，而 `execute` 的 provider final 文本只能
作为 report summary 的输入或 audit evidence，不能在 report 后再绘制一条重复结果。
两者都不复制 command output、文件统计或 approval 控件。
任何新 UI 区域若需要展示已有事实，必须 focus/open owning row，而不是复制正文。

## 11. 内容和视觉语义

### 11.1 Markdown、纯文本和代码

- 使用 allowlisted Markdown AST；段落、空行、list、blockquote、fence 不得 flatten。
- 代码块保留缩进和换行，显示 language label 与 copy；高亮失败回退 plain monospace。
- 流式未闭合 fence 先用 plain monospace，commit 后再高亮；不能把半截代码当 action。
- 外部 URL 仅允许 `http/https`；模型文本中的本地 path 可以被识别成 display-only
  `pathCandidate`，但必须经过同 item 的 Host ref/capability 才能点击。

### 11.2 文件路径和 diff

- 首屏显示 `[file icon] parser.ts`，不让绝对路径撑宽布局。
- hover/focus 显示完整路径并可复制；只有 `hostTarget=open_file/open_diff` 才可导航。
- `fileChange` 显示 `+18 -4`；展开是结构化 diff，malformed diff 显示 diagnostic。

#### 11.2.1 Trusted Host ref 约束

`hostTarget` 不是模型可以填写的普通字符串，而是 Host/daemon 在事实折叠阶段签发
的能力标记。模型正文、模型 tool 参数和未验证的 `fileRefs` 只能产生
`{ kind: "path", label, path, visibility: "conversation" }`，不能产生可点击 ref。
只有同时满足以下条件，adapter 才能把它升级为可操作的 `file`/`diff` ref：

1. 路径由 daemon 在当前 workspace 根目录内规范化，拒绝 `..`、符号链接逃逸和
   workspace 外路径；artifact/diff id 必须存在于当前 `runId` 的 durable records。
2. ref 的 `threadId`、`runId`、`attemptId`、`participantId` 与当前 snapshot scope
   一致，并且有同 thread 的 `conversation_item` anchor。
3. `open_file` 只允许已存在或已由该 action 创建的文件；`open_diff` 只允许
   `fileChange` action 的结构化 diff；`open_artifact` 只允许已登记 artifact。
4. Host callback 在执行前再次校验 workspace、thread、run、action 和 permission；
   前端 DOM 中的 path、label、`data-*` 属性不能作为授权输入。

规范化后的 ref 形状如下：

```ts
type TrustedHostRef = ConversationOperationSourceRef & {
  readonly kind: "file" | "diff" | "artifact";
  readonly hostTarget: "open_file" | "open_diff" | "open_artifact";
  readonly capabilityId: string; // Host/daemon minted; never model supplied
  readonly workspaceId: string;
};
```

不可升级的模型 path 仍显示 basename、文件图标和完整路径 tooltip，支持复制但没有
导航动作。升级失败或 scope 不一致时保留 `diagnostic(blocked)`/audit source ref，
不得静默变成一个猜测的可点击链接。这个边界必须由 normal、private、channel 三个
surface 共用同一个 adapter 和测试，不允许 route-local 的 `file://` 处理。

### 11.3 Fact row

每行只有：`icon(16px) + verb title + text status + optional disclosure`。状态必须有
文本（Working、Succeeded、Blocked 等），不能只靠颜色。详情在同一行内展开，不创建
第二个气泡、第二个 WorkCell 或第二个滚动区域。

### 11.4 EnvironmentPopover

只显示 active run 的 ambient 状态，最多两行，例如：

```text
Working · Engineer editing parser.ts
ling-stack · feature/transcript
```

run settled 后消失；不重复 final answer、TerminalReport、command output、summary 或
memory footer。点击 source icon 只 focus owning timeline row。

## 12. 多 Agent 和三种会话统一

三种会话不是三套 transcript：

| Surface | 共享 | 允许差异 |
| --- | --- | --- |
| 普通 | timeline、renderer、row geometry、composer primitives | shell title、model policy |
| 私聊 | 同上 | 单 participant、无 roster/mention |
| 频道 | 同上 | roster、topic/branch、multi-agent policy |
| 子 Agent | 同上，`depth=1` | participant label + 1px rail |

频道的多 Agent 只是多了 participant spans 和 fan-in；子 Agent 的 narration、plan、
command、file、tool 仍然是同一个 renderer registry。surface policy 不得改变 item
含义、顺序、status 或 disclosure 语义。

## 13. 模块边界

```text
packages/contracts
  typed item / lineage / source ref / revision DTO
packages/conversation-ui-core
  canonical projector / batching / surface policy / pure view models
packages/daemon
  evidence fold / snapshot-delta / TerminalReport / fan-in atomic consumers
apps/web/src/shared/conversation/timeline
  ConversationTimeline / registry / row renderers / a11y selectors
apps/web/src/features/*
  surface adapters / scope / callbacks / composer wiring
apps/desktop
  packaged shell / daemon lifecycle / trusted Host file actions
```

禁止 shared UI 读取 SQLite、解析 raw SSE、调用 provider、做审批或完成判断。禁止
surface route 自己维护 `WorkCell`、`MessageBubble` 或第二个 renderer map。

### 13.1 迁移策略：保留事实，替换投影

本轮不是重写 SQLite、Run 或 provider session。迁移采用 adapter-first cutover：

```text
existing ConversationItem / RunEvent / ExecutionAction
  -> strict snapshot adapter（先新增并测试）
  -> shared projector + Timeline（与旧 caller 并行对比 fingerprint）
  -> normal/private/channel/child 逐一切换 mount
  -> 删除旧 WorkCell/activity renderer 的 production caller
  -> 删除只为旧 renderer 服务的兼容 selector/state
```

允许短期并存的是“旧 caller 与新 Timeline 的测试对照”，不允许用户界面同时渲染
两份结果。因为产品尚未开源和发布，不保留旧 renderer 的运行时 feature flag；旧
SQLite 行通过 strict adapter 读取，缺 lineage 时 fail closed。每个 surface cutover
必须先有 parity fixture，再删除旧 caller，避免一次性大改后无法定位语义回归。

## 14. 验收标准

- 同一 fixture 在 normal/private/channel/topic/branch/child 得到相同 item kind、顺序、
  lineage 和 renderer fingerprint；差异只在 shell policy 与 depth-1 rail。
- start/update/end、SSE reconnect、daemon restart、retry 都保持同一 action identity 和
  terminal fence。
- 普通叙述保留段落、列表、代码和 path；事实行有动作描述、状态、icon、detail。
- `reply` turn 以最终 `agentMessage` 收口；`execute` turn 以唯一 `terminalReport` result
  item 收口，二者都不能在 Timeline 外重复渲染。
- 不再出现旧 workflow skeleton、重复 summary、Composer 下方重复结果或方形气泡。
- 任何缺 evidence、缺 anchor、跨 scope、fan-in 不完整的场景都明确显示 blocked/waiting。
- batch 可以展开恢复原子 child；不会改变 completion、fan-in 或 context semantics。
- packaged macOS 真实客户端完成命令、文件、审批、失败、取消、retry、SSE reconnect、
  daemon restart、多 Agent fan-in 和 nested narration 验收。

### 14.1 证据可追溯性

任何 UI 截图都必须能通过 `semantic-state.json → item.id → sourceRefs → SQLite/Host
record` 反查。验收脚本输出以下 fingerprint：

```text
surface, threadId, turnId, itemId, kind, actionId, runId, attemptId,
participantId, workflowStepId, revision, status, rendererKey, sourceRefIds
```

缺少任一 required lineage 的执行事实不得被测试标成 succeeded；只能标成
`blocked`/`diagnostic`，并保留可修复的 source ref。未关联执行动作的 approval 以
`approvalId` 作为自己的 authority，不得被强行补成 command evidence。

## 14.2 实现级契约（v3.7 增量）

本节把“Codex 风格、简单好看”收敛为实现者可以直接照着写的边界。它不新增
SQLite 表，也不引入第二套 session；只是把现有 durable records、daemon evidence
和 shared Timeline 的交接格式固定下来。若实现与本节冲突，先更新本节，再改代码。

### 14.2.1 Snapshot、identity 和刷新

`ConversationTimeline` 的历史输入只接受一个不可变 `TimelineSnapshot`；`policy` 和
Host callbacks 是控制依赖，不是第二份历史。surface adapter 必须在一次渲染周期内提供
同一份 snapshot，禁止分别读取 message、action、approval 再在 JSX 中拼接：

```ts
type TimelineSnapshot = {
  readonly scope: {
    readonly kind: "normal" | "private" | "channel_root" | "topic" | "branch" | "child";
    readonly workspaceId: string;
    readonly threadId: string;
    readonly parentThreadId: string | null;
    readonly anchorItemId: string | null;
    readonly depth: 0 | 1;
  };
  readonly items: readonly ConversationTimelineItem[];
  readonly activeRun: ActiveRunSnapshot | null;
  readonly canonicalRevision: number;
  readonly sseCursor: string | null;
  readonly contextSegmentIdByItemId: ReadonlyMap<string, string>;
};
```

#### Snapshot 分层（唯一允许的两个层次）

`TimelineSnapshot` 只表示已经完成 scope、owner、attempt、revision 和 display projection
的渲染输入。daemon/API 可以使用另一个只读结构承载原始 durable records，但它不能直接
交给 React，也不能和 `TimelineSnapshot` 使用同一个类型名：

```ts
type TimelineSourceSnapshot = {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly coverage: {
    readonly firstSequence: number;
    readonly lastSequence: number;
    readonly completeBefore: boolean;
    readonly completeAfter: boolean;
  };
  readonly conversationItems: readonly ConversationItemSnapshot[];
  readonly executionActions: readonly ExecutionActionSnapshot[];
  readonly approvals: readonly ApprovalSnapshot[];
  readonly artifacts: readonly ArtifactSnapshot[];
  readonly participantSpans: readonly ParticipantSpanSnapshot[];
  readonly terminalReports: readonly TerminalReportSnapshot[];
  readonly revisionWatermark: number;
};

function projectTimelineSnapshot(
  source: TimelineSourceSnapshot,
  surface: ResolvedConversationSurface,
): TimelineSnapshot {
  // Pure adapter: validate scope/coverage, fold evidence, select latest attempt,
  // project atomic items, then optionally add display-only batches.
}
```

固定的数据流是：

```text
TimelineSourceSnapshot（durable 原始记录）
  -> evidence fold / scope / owner / attempt 校验
  -> atomic typed items
  -> 可逆 display batch（可选）
  -> TimelineSnapshot（唯一 React 输入）
  -> mountConversationTimeline
```

`coverage` 只用于分页和重连的连续性，不改变 item 顺序；`contextSegmentId` 只从已提交
的 context assignment 进入最终 snapshot。任何 surface 都不得绕过这条链路，把
`conversationItems`、`executionActions` 或 `terminalReports` 单独传进 JSX。

`workspaceId` 同样是 `ConversationTimelineScope`、`ResolvedConversationSurface` 和 Host
capability scope 的必填字段；renderer 只把它作为 lineage 的 authority，绝不从 cwd 或路径
猜测。surface adapter 在创建 snapshot 前完成 workspace/thread 一致性校验。实现包中的字段名保持如下对应关系，避免设计字段
和 TypeScript DTO 形成第二套语义：`TimelinePosition.sequence` 对应
`ConversationTimelineItemBase.threadSequence`，`TimelinePosition.conversationItemId`
对应 `itemId`，而 `partIndex` 保持不变。历史章节中的 `ConversationSurfacePolicy` 仅是
迁移期术语，v3.7 代码一律使用 `ConversationInteractionPolicy`，不得重新导出旧名称。

`ActiveRunSnapshot` 的最小形状固定如下；它只驱动 EnvironmentPopover，不证明 action
完成：

```ts
type ActiveRunSnapshot = {
  readonly runId: string;
  readonly status: "pending" | "working" | "waiting" | "reconnecting";
  readonly workspaceLabel: string;
  readonly cwd: string | null;
  readonly branch: string | null;
  readonly modelLabel: string | null;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
};
```

`ActiveRunSnapshot.status="working"` 是 ambient chrome 文案；事实行仍使用
`ConversationTimelineItemStatus="running"` 并显示 `Working`。两者指向同一 run，但
Popover 不拥有 action status，也不能据此完成 TerminalReport。

稳定 identity 的规则是：

```text
conversation item  -> item.id
execution fact     -> actionId（同一 action 的 DOM id 永不改变）
participant span   -> participantSpan.id
display batch      -> batch kind + participantId + runId + firstActionId
```

`revision` 只表示同一 identity 的内容更新，不得用来生成新 row。接受的
`tool_update` 必须触发该 identity 的 invalidation；React key、`data-conversation-timeline-id`
和展开/focus 状态都保持不变。reconnect 或 daemon restart 只替换 snapshot，不得追加
“恢复完成”气泡。

### 14.2.2 Host capability 生命周期

本地路径是否可点击不由 Markdown、`file://` 字符串或 `hostTarget` 文案决定，而由
Host/daemon 签发的短期 capability 决定。流程固定为：

```text
模型/历史 path（只读）
        │
        ▼
display ref：basename + tooltip + copy
        │  Host 根据 durable artifact/file/diff 校验后签发
        ▼
trusted ref：capabilityId + scope + expiresAt
        │  用户点击；Host 在 callback 前再次校验
        ▼
open_file / open_diff / open_artifact
```

能力契约：

```ts
type ConversationHostCapability = {
  readonly capabilityId: string;       // opaque random id; never model supplied
  readonly capabilityTarget: "open_file" | "open_diff" | "open_artifact";
  readonly refId: string;
  readonly scope: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly runId: string;
    readonly actionId: string;
    readonly participantId: string;
  };
  readonly issuedAt: string;
  readonly expiresAt: string;          // default <= 5 minutes
  readonly daemonEpoch: string;        // restart invalidates old capabilities
};
```

签发条件：路径经过 workspace realpath/symlink 校验，ref 与当前 thread/run/action/
participant 一致，且 artifact/diff 已存在于 durable records。回调条件：重新读取
当前 scope、permission 和 realpath，并检查 capability 未过期、`daemonEpoch` 未变化、
`refId` 仍属于 action。`attemptId` 继续由 canonical item/source lineage 追踪；它不是
workspace-file callback 的独立授权字段，因为 `actionId` 在当前 `runId` 内已经唯一。
任一检查失败都显示 `diagnostic(blocked)`，不降级为路径跳转。
daemon 重启后旧 capability 全部失效；Timeline 仍可恢复事实，用户再次点击时由
adapter 重新申请 capability。这样既不持久化 token，也不会让历史截图成为授权凭据。

### 14.2.3 频道 scope 与 protocol event

频道协议事件必须绑定真实的 root `LingThread.id`。`channel:<channelId>` 只能作为日志
或临时诊断字符串，禁止作为 Timeline scope、`threadId` 或 source ref：

```text
channel root  -> resolved rootThreadId（持久化 LingThread.id）
topic         -> resolved topicThreadId + parentThreadId + anchorItemId
branch        -> resolved branchThreadId + forkContextSnapshotId
protocol row  -> owning threadId + anchorItemId + sourceRefs
```

`ChannelMessageRenderersInput` 必须提供 `channelDiscussionRootThreadId`，或调用一个返回同等
信息的 `resolveChannelThread` adapter。解析不到真实 id 时：

1. 不渲染成功的 protocol fact；
2. 生成 `diagnostic(scope_mismatch)`，保留 channel/activity source ref；
3. UI 提供“重新加载频道”而不是静默使用 synthetic id。

频道 root/topic/branch 的 adapter 只负责得到 `ResolvedConversationSurface`，随后走同一
`mountConversationTimeline`。这样 decision、handoff、summary、workflow/task/run 生命周期
虽然是 `protocolEvent`，仍然可以从 UI 行回链到实际 SQLite thread 和 anchor。

### 14.2.4 Recovery 和 completion fence

所有输入路径（初始 snapshot、SSE delta、reconnect replay、daemon restart replay）都
经过同一个 evidence fold。验证顺序固定为：

```text
eventId 去重
  -> entityId + revision 合并
  -> terminal fence 检查
  -> durable snapshot 更新
  -> live invalidation
  -> pure projector
  -> display batch（可选）
```

以下状态永远由 atomic evidence 计算，而不是 visible rows：

| 结论 | 必须存在 | 缺失时 |
| --- | --- | --- |
| command succeeded | `commandExecution` + exit/status + source ref | `blocked` |
| participant completed | required participant terminal evidence | `waiting` |
| participant blocked | structured blocked result + source ref | `blocked` |
| TerminalReport/fan-in settled | 全部 required participant 结论 | 不发布 settled |
| retry latest | 新 attempt terminal fence | 旧 attempt 仅 audit |

`ready`、`done`、plan step、batch 数量、最后一个 SSE 或 Composer 文案都不能越过 fence。
旧 attempt 的迟到 end/update 只写 audit diagnostic；主 lane 继续显示最新 attempt。

### 14.2.5 视觉组件的最小组合

实现只允许下面这一棵树，避免再次出现“外层一套、频道一套、子 Agent 一套”：

```text
ConversationSurfaceShell
├─ Header / roster（surface chrome）
├─ ConversationFeedViewport（唯一纵向 scroll owner）
│  └─ ConversationTimeline（无纵向 overflow）
│     ├─ document renderer：user/agent/reasoning/plan
│     ├─ fact renderer：command/exploration/file/tool/approval/protocol/diagnostic
│     ├─ result renderer：terminalReport（execute turn only）
│     ├─ batch renderer：display-only disclosure
│     └─ sub-agent renderer：participant rail + Timeline(depth=1)
├─ EnvironmentPopover（只绑定 active action）
└─ Composer（输入、停止、重试、approval control）
```

首屏只保留三种视觉重量：正文自然排版、事实轻量行、需要处理的状态 tint。事实行
固定为 `icon + 动作动词 + 文本状态 + 一个 disclosure`；成功历史默认收敛，active/
failed/waiting/blocked 才展开 bounded detail。Composer、EnvironmentPopover 和
Timeline 外部区域都不得复制事实正文或输出；`terminalReport` result row 只在
Timeline 内出现一次。子 Agent 只增加 participant label 和 1px
rail，不能改变 renderer key、row height、字体或 scroll owner。

### 14.2.6 实现完成判定

“代码写完”必须同时通过四层证据，任何一层缺失都不能宣布完成：

1. **Contract**：closed union、strict lineage、真实 `LingThread.id`、Host capability 和
   exhaustive registry typecheck 通过。
2. **Semantic**：同一 fixture 在 normal/private/channel/topic/branch/child 的 kind、
   order、status、renderer key、disclosure count 和 stable id 一致。
3. **Recovery**：retry、SSE reconnect、daemon restart、approval 和 fan-in 从 durable
   atomic evidence 收敛到同一 fingerprint。
4. **Packaged UI**：真实 macOS 客户端保存 screenshot、semantic-state、lineage、
   redacted logs 四件套；mock 或浏览器截图只能标为 simulation。

视觉 review 只检查是否符合 document/fact/nested 的简单层级，不能覆盖前面三层失败。

## 15. v3.7 Codex-parity 实现细化

此前 v3.5/v3.6 已经锁定事实、lineage 和统一 renderer 的方向；v3.7 只把实现边界再收紧，避免
“看起来像 Codex”却在运行时重新分叉。它不新增持久化表，不改变 provider session，也
不改变三种会话的产品权限。任何代码实现都必须能在下面四张图和三张表中找到唯一归属。

### 15.1 事件到可见行的唯一转换

模型文字只是叙述，Host 事件才是动作事实。一个动作从产生到结束只能沿一条链路进入
Timeline：

```text
agentMessage（可选意图）
       │
       ▼
tool_start ──┐
tool_update ─┼─> durable RunEvent/ExecutionAction
tool_end   ──┘             │
                           ▼
                 evidence fold（去重、revision、terminal fence）
                           │
                           ▼
                 canonical command/file/tool item
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
       单独事实行                   可逆 display batch
       （active/attention）          （仅相邻安全终态）
```

| 输入 | 唯一事实 owner | 首屏必须显示 | 禁止的替代物 |
| --- | --- | --- | --- |
| `agentMessage` / `reasoning` | document item | Markdown 文档流 | “已执行”成功徽章 |
| `tool_start/update/end` | `commandExecution`/typed tool | 动词、状态、icon | 追加 start/finish 两行 |
| 文件写入或 diff | `fileChange` + artifact/diff ref | basename、统计、状态 | 模型 path 变成链接 |
| approval | `approval` + Composer gate | `Waiting for approval` | Timeline 和 Composer 两个按钮 |
| child participant | `subAgentActivity` + child items | participant + lifecycle | ready 文本当完成 |
| `terminalReport` / fan-in | atomic evidence projection | 结论或 waiting/blocked | batch 数量或 plan step、Timeline 外的第二张结果卡 |

每个 `tool_update` 只接受 `revision > currentRevision` 的更新；接受后发出按
`actionId` 定位的 invalidation。React key、DOM id、展开状态和焦点都不变。terminal
fence 之后的迟到事件只能写 audit diagnostic，不能重新打开事实行。

### 15.2 三种会话和子 Agent 的 scope 映射

Surface 只解析 scope，不能为同一份 canonical item 另写 renderer：

| Surface | `ResolvedConversationSurface.threadId` | 允许的额外 chrome | 不得做的事 |
| --- | --- | --- | --- |
| 普通会话 | 普通 `LingThread.id` | 标题、模型提示 | 右侧 message bubble、第二 WorkCell |
| 队友私聊 | 私聊 `LingThread.id` | 队友头像/名称 | 私聊专属事实卡、`@` 路由 |
| 频道 root | 持久化 root `LingThread.id` | roster、频道操作 | `channel:<id>` synthetic scope |
| topic | topic `LingThread.id` + parent/anchor | topic 标题、返回 parent | 复制 parent transcript |
| branch | branch `LingThread.id` + fork snapshot | branch 标识 | 用 channel id 代替 branch thread |
| depth-1 child | 父级 thread + participant span | 1px rail、participant label | child-specific bubble/scroll owner |

解析不到真实 thread 时必须输出 `diagnostic(scope_mismatch)`。`channel:<channelId>` 仅可
出现在日志或诊断中，永远不能进入 Timeline snapshot、source ref 或 completion 输入。

### 15.3 文件能力的双目标契约

“打开文件的 Host 目标”和“用户选择的编辑器目标”是两个字段，不能复用一个
`target` 字符串：

```ts
type WorkspaceFileCapabilityTarget = "open_file" | "open_diff" | "open_artifact";
type WorkspaceFileAppTarget = "vscode" | "cursor" | "zed" | "system";

type WorkspaceFileCapabilityRequest = {
  readonly capabilityTarget: WorkspaceFileCapabilityTarget;
  readonly refId: string;
  readonly scope: { readonly workspaceId: string; readonly threadId: string;
    readonly runId: string; readonly actionId: string; readonly participantId: string };
};

type WorkspaceFileOpenRequest = {
  /** Existing API field; semantically the user-selected app target. */
  readonly target: WorkspaceFileAppTarget;
  readonly capabilityId: string;
};
```

前端先用 `capabilityTarget` 请求短期 opaque capability，再把 `capabilityId` 和用户选择
的 `appTarget` 交给 Host。Host 回调前重新检查 realpath、workspace/thread/run/action/
participant、permission、TTL 和 daemon epoch。任何失败都保留可复制的 display-only path，
并显示 `diagnostic(blocked)`；不得静默按 `open_file` 处理 diff/artifact。

### 15.4 简洁视觉的状态机

每个 factual row 的首屏状态只有一套词汇，状态转移不改变 row 身份：

```text
Queued ──> Working ──> Succeeded
   │          │  ├──> Failed
   │          │  ├──> Cancelled
   │          │  └──> Waiting for approval ──> Working | Blocked
   └────────────────────────────────────────> Blocked
```

- `Queued`/`Succeeded` 默认收敛为一行；`Working` 默认展开 bounded tail；
  `Waiting`/`Failed`/`Blocked` 默认展开一层可恢复详情。
- row 固定为 `icon + 动作动词 + 文本状态 + 一个 disclosure`。颜色只有 tint，不能
  单独承担状态语义。
- 叙述、命令、文件、工具和 TerminalReport 不互相复制正文。Composer 只拥有输入、
  stop/retry 和 approval action；EnvironmentPopover 只拥有当前 ambient 状态。
- child 只增加 participant rail 和 label，复用父级 renderer key、字体、行高、disclosure
  和唯一滚动容器；depth=2 统一显示 `diagnostic(nested_depth_exceeded)`。

### 15.5 开工前必须锁定的证据

实现 PR 进入代码前，先为同一 fixture 生成以下四份预期，作为失败测试和 UI selector
的基准：

```text
fixture.json        canonical item + lineage + scope
semantic-state.json kind/status/revision/depth/rendererKey
lineage.json        item/action/run/attempt/participant/source refs
visual-contract.md  document/fact/nested/attention 的首屏样例
```

同一 fixture 在 normal/private/channel/topic/branch/child 中的 `itemKinds`、顺序、
stable ids、`rendererKeys`、状态文案和 disclosure 数必须相同；差异只写入 shell chrome、
policy hints 和 participant rail。未通过这份 parity fixture 时，不得删除旧 caller，也
不得以截图认定“统一完成”。

### 15.6 实际 renderer 绑定与简洁布局

为了避免“同一个 kind 在不同页面被画成不同东西”，下面的表是实现的唯一绑定。`lane`
描述语义位置，`rendererKey` 描述代码 registry；两者都必须在 fingerprint fixture 中
出现。

| kind | lane | rendererKey | 首屏状态 | 默认 disclosure |
| --- | --- | --- | --- | --- |
| `userMessage` / `agentMessage` | document | `message.document` | 无状态徽章 | 否 |
| `reasoning` | document | `message.reasoning` | `Thinking`（安全摘要） | 否 |
| `plan` | structured document | `document.plan` | `Plan · {step summary}` | 仅有未完成 step 时 |
| `commandExecution` | fact rail | `fact.command` | `Run {command} · {status}` | active/attention 时 |
| `exploration` | fact rail | `fact.exploration` | `Read/Search {target} · {status}` | active/attention 时 |
| `fileChange` | fact rail | `fact.file` | `Edited/Created {basename} · {status}` | 有 diff/多文件时 |
| typed tool | fact rail | `fact.tool` | `{verb} {target} · {status}` | 有输入/结果时 |
| `approval` | fact rail | `fact.approval` | `Waiting for approval` 或决策结果 | waiting/attention 时 |
| `protocolEvent` | fact rail | `fact.protocol` | 动词 + 协议状态 | 有描述时 |
| `subAgentActivity` | nested rail | `agent.nested` | participant + lifecycle | 有 child items 时 |
| batch | display rail | `batch.command` / `batch.exploration` | `Ran N commands` / `Read N items` | 可逆展开 |
| `diagnostic` | attention rail | `diagnostic.blocked` | `Activity unavailable · Blocked` | 默认一层 |

布局规则固定为：

```text
document:  max-width 760px；自然段/列表/代码保留原结构；不使用 message bubble
fact:      100% 宽度的轻量单行；左侧 16px icon，中心动词/状态，右侧一个 disclosure
detail:    同一 row 内展开；stdout/stderr 只显示 bounded tail，不创建内部滚动容器
nested:    父 row 下 1px participant rail；child 复用同一字体、行高和 renderer registry
```

事实行的状态词是闭集：`Queued`、`Working`、`Waiting`、`Waiting for approval`、
`Succeeded`、`Failed`、`Cancelled`、`Blocked`。其中 `Waiting for approval` 仅表示审批
等待，依赖/fan-in/证据不足使用 `Waiting` 并显示原因。`Done`、`Ready`、`Processed` 只能
作为模型叙述或旧数据诊断，不能作为事实行的完成状态。颜色只提供 tint；icon、文本和
`aria-label` 必须独立表达同一状态。输出超过首屏界限时显示截断提示和 trusted artifact action，而不是把
终端内容塞进第二个可滚动面板。

这里的 `Queued` 是用户看到的 copy；内部状态枚举仍可使用既有的 `pending`，只在 shared
renderer 的状态映射层转换，避免把展示文案变化误当成 SQLite/API schema 迁移。

### 15.7 状态所有权矩阵

同一事实只能由一个区域拥有，其他区域最多提供定位入口：

| 区域 | 允许拥有 | 明确禁止 |
| --- | --- | --- |
| `ConversationFeedViewport` | 唯一纵向 overflow、贴底和历史 anchor | 只承载已投影 DOM；禁止读取 SQLite/SSE、排序 item、判断 fan-in |
| `ConversationTimeline` | item、revision、disclosure、focus | 建立第二个纵向 overflow、读取 SQLite/SSE、判断 fan-in、签发 capability |
| `EnvironmentPopover` | 当前 `activeRunId/actionId` 的两行 ambient hint | 历史 action、TerminalReport、完成摘要 |
| `Composer` / approval dialog | 输入、stop、retry、approval decision | 复制 command/output/status、第二个 approval row |
| `terminalReport` result row | atomic evidence 的终态结论 | 读取 batch 数量、复制 command output、在 Timeline 外重复渲染 |
| right dock / artifact preview | source ref 的预览 | 重新创建 timeline row 或改变 completion |

如果一个 UI 需求无法归入上表，先新增 typed item 或更新 owner，再写 JSX；不得在某个
surface 中临时追加 summary。这样可以直接阻断“上面还在等待、下面已经完成”“已编辑文件
后又出现一份红色总结”等重复状态。

### 15.8 开工用的最小实现契约

下面的契约是实现者可以直接转换为 TypeScript 类型、DOM selector 和 component test 的
最小闭环。它不是新的持久化模型；所有字段都来自 `TimelineSnapshot` 或其纯投影。

```ts
type TimelineRenderModel = {
  readonly item: ConversationTimelineItem;
  readonly lane: "document" | "fact" | "nested" | "attention";
  readonly rendererKey: string;
  readonly statusText?:
    | "Queued"
    | "Working"
    | "Waiting"
    | "Waiting for approval"
    | "Succeeded"
    | "Failed"
    | "Cancelled"
    | "Blocked";
  readonly defaultExpanded: boolean;
  readonly hasDisclosure: boolean;
};

function projectRenderModel(item: ConversationTimelineItem, depth: 0 | 1): TimelineRenderModel {
  // Pure: no route, I/O, provider payload, or Host authorization.
  // The registry is exhaustive over item.kind.
}
```

每个 item 的 DOM 结构固定为一层 owning row，测试只依赖语义属性，不依赖像素或文案翻译：

```text
ConversationTimeline[data-conversation-timeline]
├─ article[data-kind=userMessage|agentMessage]              document lane
├─ article[data-kind=commandExecution][data-action-id]     fact rail
│  ├─ header: icon + verb + status
│  └─ details: optional bounded tail/diff/tool result
└─ article[data-kind=subAgentActivity][data-depth="1"]      nested rail
   └─ ConversationTimeline(depth=1, same registry)
```

必须满足：

1. 一个 `actionId` 只有一个 `article` 和一个 React key；`revision` 只改变属性和详情；
   start/update/end、reconnect、restart 不追加第二个 article。
2. `document` item 不拥有 fact-row 的边框、状态 tint、disclosure 或命令输出；代码、
   列表和路径结构由 `ConversationContentPart`/Markdown AST 保留。
3. `fact`/`attention` item 的首屏标题来自 typed payload，固定为动作动词 + 状态；
   缺 payload、anchor 或 lineage 时只能是 `Activity unavailable · Blocked`。
4. 详情只在 owning row 内展开。bounded tail 超过 240px 时显示截断提示和 trusted
   artifact 入口，不能创建局部纵向 `overflow` 容器。
5. `subAgentActivity` 只增加 participant rail 和 `depth=1`；child item 复用同一
   `rendererKey`、状态文案、行高、disclosure 和滚动 owner。`depth=2` 直接生成
   `diagnostic(nested_depth_exceeded)`。

状态 copy 只在 renderer 做一次映射，避免 surface 自己发明文案：

```text
pending   -> Queued
running   -> Working
waiting + approval   -> Waiting for approval
waiting + other      -> Waiting
succeeded -> Succeeded
failed    -> Failed
cancelled -> Cancelled
blocked   -> Blocked
```

`Done`、`Ready`、`Processed` 只能作为模型叙述或旧数据 diagnostic，永远不能进入事实
行的成功状态。这个映射应有单独的纯函数测试，并在 normal/private/channel/child 的
parity fixture 中比较结果。

### 15.9 一次真实 turn 的目标输出

这是实现和 macOS 真实验收共用的最小视觉样例；它说明层级和所有权，不规定具体颜色：

```text
我先检查 parser.ts，再运行测试。

⌁ Read src/parser.ts · Succeeded                         [Details]
▣ Run pnpm test · Working                              [Details]
  packages/ui › test/unit …
▱ Edited parser.ts · Succeeded · +18 -4                 [Details]

Engineer
  我复核了空 token 的边界条件。
  ▣ Run pnpm test -- --filter parser · Failed · exit 1   [Details]
```

展开/折叠、SSE 更新、daemon 重启或 retry 只改变同一行的 `revision/status/detail`。
`reply` turn 的最终 `agentMessage` 解释结果；`execute` turn 则追加唯一的
`terminalReport` result row。两者都不复制命令、文件统计或 approval 控件。
Composer 只显示输入和当前控制动作，EnvironmentPopover 只显示 active run 的两行 ambient
hint。这个样例在普通、私聊和频道中必须拥有相同的 item 顺序和 renderer fingerprint，
频道只额外显示 roster/participant rail。

## 16. 已冻结的决策

1. 一个 canonical timeline + 一个 renderer registry，三种会话和子 Agent 统一。
2. Markdown 是叙述；Host evidence 才是事实。
3. 全量 SQLite 历史持久化，contextSegmentId 只来自已提交的
   `TurnContextAssignment`/`ContextSnapshot`；显式选择、结构规则和受限模型提议都必须
   经 `ContextSegmentationPolicy` 校验后才能成为 assignment，UI batch 和原始模型文本
   永远不能直接写入。
4. batch 只做可逆 UI 投影，不新增 SQLite 表或摘要记录。
5. 未发布开发阶段直接切换，不保留旧 renderer 兼容层。
6. child timeline 最多一层；缺 evidence 返回结构化 blocked。
7. TerminalReport/fan-in 只读原子 evidence，绝不读取 batch 数量或 ready 文本。
8. 所有 surface 和 depth-1 子 Agent 通过同一个 timeline mount/renderer registry；
   surface 只提供 scope、policy、chrome 和 Host callbacks。
9. 普通消息使用 document lane；动作使用 fact rail；任何旧 workflow skeleton、第二
    summary owner 或 route-local renderer 都不属于 v3.7。
10. 频道 protocol event 必须使用真实 `LingThread.id`；禁止 `channel:<channelId>` 作为
    Timeline scope。无法解析时 fail closed 为 `diagnostic(scope_mismatch)`。
11. trusted file/diff/artifact ref 使用短期 Host capability；daemon restart 使旧 token
    失效，事实仍从 SQLite 恢复，点击时重新签发。
12. 所有 surface 与 depth-1 子 Agent 必须通过同一个 `mountConversationTimeline`，并以
    semantic fingerprint、lineage 和真实 packaged macOS 证据验收。
13. v3.7 只替换 transcript projection 和 renderer，不重写 durable SQLite/Run 数据；
    旧 WorkCell 仅可作为迁移期对照，不能作为 production 第二 owner。
14. “简单好看”固定为 document lane、fact rail、attention state 三档视觉重量；不得
    为 normal/private/channel/child 新增 surface-specific row grammar。

No unresolved design decisions for v3.7. Implementation deviations must update this
document before code changes.

## 17. v3.7 实施细化：Host 权威、专用查看器和单一 surface cutover

本节把上一版已经冻结的原则落实到三个容易被“临时实现”绕开的边界。它们是
实现进入 packaged macOS 验收前的硬门槛。

### 17.1 Source ref 的两阶段信任

模型正文中的路径永远是 display-only。Host 事实中的文件、diff、artifact ref 也不能
仅凭前端传来的 `scope` 获得信任。打开流程固定为：

```text
atomic item sourceRef
       │
       ├─ issue: daemon 从 SQLite 验证 workspace/thread/run/action/participant/step/ref
       │        + realpath + permission，签发短期 opaque capability
       ▼
trusted ref（只带 capabilityId，不把 token 写回历史）
       │
       ├─ preview: POST /workspace-files/preview（body 带 capabilityId + transcriptScope）
       │          daemon 二次验证 capability、realpath、TTL、daemonEpoch、permission
       └─ click: daemon 二次验证 capability、realpath、TTL、daemonEpoch、permission
       ▼
专用 Host viewer：open_file / open_diff / open_artifact
```

右侧 Dock 的文件预览属于同一 trusted source ref，不能退回无 capability 的
`GET /workspace-files/preview`。只有没有 transcript scope 的普通工作区浏览才可使用
GET 适配器；一旦 Timeline item 携带 capability，预览和外部打开都必须走 capability-bound
POST，并在响应中保留同一 `displayPath`/line focus。capability 和 transcript scope 不放入
URL，避免进入访问日志。

签发授权必须验证以下关系，不能只比较路径字符串：

| 关系 | 验证来源 | 失败结果 |
| --- | --- | --- |
| workspace → cwd | `LingThread.workspaceId` 与已注册 workspace root | `scope_mismatch` |
| thread → run/turn | `RunSession.threadId`、`LingTurn.threadId` | `scope_mismatch` |
| action → run | durable `ExecutionAction`/RunEvent fold | `missing_lineage` |
| participant/step → action | action lineage 或 participant span | `owner_conflict` |
| ref → action/artifact | action `sourceRefs/targetRefs`、`RunArtifact` | `missing_context_source` |
| permission → target | 当前 Host permission snapshot | `blocked` |

`open_file` 只允许文件查看/编辑目标；`open_diff` 必须进入 review/diff viewer；
`open_artifact` 必须进入 artifact preview/review viewer。专用 viewer 可以复用同一个
Right Dock，但不能把 diff/artifact 静默降级成普通文件，也不能在 Timeline 再造一行。

### 17.2 Surface cutover 的唯一输出

每个 surface adapter 只能把以下对象交给 `mountConversationTimeline`：

```ts
type ResolvedConversationSurface = {
  readonly kind: "normal" | "private" | "channel_root" | "topic" | "branch" | "child";
  readonly workspaceId: string;
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly anchorItemId: string | null;
  readonly depth: 0 | 1;
  readonly policy: ConversationInteractionPolicy;
  readonly chrome: { readonly title: string; readonly participantIds: readonly string[] };
};
```

adapter 不得导出 renderer、排序器、Markdown parser、batch 函数或第二个 scroll owner。
一次 canonical turn 只能生成一个 Timeline snapshot；频道旧 `turn.blocks`、WorkCell
operation block、TerminalReport summary 和 Composer summary 必须先归一化进 snapshot，
再由唯一 registry 绘制。保留旧 block 作为 migration adapter 时，它不能同时挂载到生产
DOM；缺少 strict lineage 的历史行转为 `diagnostic(blocked)`。

### 17.3 恢复和完成判定的原子读取

`TerminalReport` 和 multi-agent fan-in 只读取 canonical projector 输出中的 atomic
operation evidence：

```text
required participant evidence
  ├─ all terminal succeeded          → settled/succeeded
  ├─ any terminal failed/cancelled   → failed/cancelled
  ├─ structured blocked              → blocked
  └─ missing/active participant      → waiting
```

`ready`、`done`、plan step、batch 数量、子 Agent 的自然语言都不能改变上述结果。SSE
重连和 daemon restart 先从 SQLite 重建 action map，再以 `actionId + revision` 更新同一
DOM row；terminal fence 后的 late event 只能进入 audit。新的 capability 只在恢复后的
click 发生时重新签发，旧 daemon epoch 的 token 一律失效。

### 17.4 Codex-parity 视觉验收口径

Codex 的可借鉴点是信息分层，而不是复制内部 session：

```text
document lane   Markdown / agentMessage / reasoning
fact rail       command / file / tool / approval / protocol
nested rail     participant + 同一 registry 的 depth-1 child
ambient shell   EnvironmentPopover / Composer / Right Dock
```

document lane 不使用方形消息气泡；fact rail 只显示 `icon + 动作 + 状态 + 一个
disclosure`；成功历史默认收敛；active/attention 才展开 bounded detail。所有状态同时
由文字、icon 和 `aria-label` 表达，不能只依赖颜色。这个口径适用于普通、私聊、频道
root/topic/branch 和子 Agent，surface 只改变 chrome、participant rail 和权限提示。

### 17.5 Source snapshot 与 surface mount 的运行时接口

实现不再把“message list、operation rows、protocol blocks、TerminalReport”分别传给 React。
daemon/API adapter 先构造 `TimelineSourceSnapshot`，再由纯 projector 生成
`TimelineSnapshot`；Web 只消费后者：

```ts
// `TimelineSourceSnapshot` is defined once in §14.2.1.
type ConversationTimelineMountInput = {
  readonly snapshot: TimelineSnapshot;
  readonly policy: ConversationInteractionPolicy;
  readonly depth: 0 | 1;
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly cwd?: string;
  readonly callbacks: ConversationTimelineCallbacks;
};
```

`TimelineSourceSnapshot` 只含 durable records 和已接受的 live revision；它不含 route JSX、
display batch、展开状态、环境浮窗文案或 Composer 状态。`projectTimelineSnapshot()` 固定
执行：

```text
validate scope/coverage
  -> canonical atomic projection
  -> latest-attempt/owner resolution
  -> display-only batching
  -> renderer registry
  -> semantic fingerprint
```

surface adapter 不得在 mount 前后再拼接历史内容。分页加载只扩展 snapshot coverage；
它不能把当前页第一行当作新的排序起点，也不能跨 coverage gap 组成 batch。缺页时在边界
保留稳定 continuation marker，加载完成后再重新计算相邻 batch。

`mountConversationTimeline()` 只执行最后一步：把 canonical `TimelineSnapshot` 和已经由
surface policy 决定的 renderer callbacks 交给 registry，并返回 semantic fingerprint。它
不再次排序、投影、读取 durable records 或创建 batch。

### 17.6 Source-ref callback 的 lineage 形状

每次文件、diff 或 artifact 打开都必须绑定 owning item 的 lineage。callback 不能只收到
一个 trusted path：

```ts
type ConversationTimelineItemLineage = {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly conversationItemId: string;
  readonly runId: string | null;
  readonly attemptId: string | null;
  readonly actionId: string | null;
  readonly participantId: string | null;
  readonly workflowStepId: string | null;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
};
```

这里不重新定义 callbacks；使用 §10 的 canonical `ConversationTimelineCallbacks`。

renderer 只把当前 item 的 lineage 原样交给 callback；它不签发 token，也不补默认值。
daemon 的 issue endpoint 以 SQLite 重新验证 lineage/ref 关系，redeem endpoint 再验证
capability、TTL、daemon epoch、permission 和 realpath。任何一步失败只影响导航，不改变
已经持久化的 Timeline 事实。

### 17.7 频道和 nested Agent 的唯一投影

频道旧的 `turn.blocks`、workflow skeleton、operation transcript block 可以继续作为读旧
数据的 adapter 输入，但生产 DOM 只允许下面一个出口：

```text
channel turn + protocol records + participant spans + actions
  -> one TimelineSnapshot
  -> one mountConversationTimeline()
```

不得先渲染 `turn.blocks` 再追加 Timeline，也不得为 run activity、workflow step 或
TerminalReport 各 mount 一次 Timeline。proposal/approval 的交互控件进入其 owning row 的
disclosure；coordinator narration 进入 `agentMessage`；workflow/handoff/decision 进入
`protocolEvent`；子 Agent narration 和事实进入一个 `subAgentActivity.childItems`。

depth-1 child 不拥有独立 fetch、scroll、batch、status-copy 或 source-ref callback。它
继承父 Timeline 的 registry、view store 和 callbacks，只增加 participant rail。depth-2
请求在 projector 阶段变成 `diagnostic(nested_depth_exceeded)`，不能在 React 中继续递归。

### 17.8 终态、恢复和完成世代

为了防止“上面还在等待、下面已经开始下一任务”，每个 attempt 都有一个 durable
completion generation。TerminalReport/fan-in 只读取最高 committed generation：

```text
generation g atomic evidence
  -> all required participants terminal or structured blocked
  -> commit TerminalReport(g)
  -> terminal fence(g)
  -> later events only audit
```

retry 创建 `g+1`/新 attempt；主 Timeline 只投影最新有效 generation，旧 generation 进入
audit。SSE reconnect 和 daemon restart 从 SQLite 重建 action map 和 generation，禁止以
请求计数、固定 sleep、visible batch 数或 agentMessage 中的 “done/ready” 推断完成。

### 17.9 开工 fixture 与验收证据格式

实现从同一份 canonical fixture 开始，避免 normal/private/channel 各自编造输入。fixture
是测试数据，不是新的运行时存储；它必须能由 SQLite/Host 记录回放得到，并且不包含真实
token、绝对用户路径或 provider secret。

```json
{
  "fixtureId": "codex-parity-basic-01",
  "simulation": true,
  "scope": {
    "workspaceId": "workspace:test",
    "threadId": "thread:root",
    "kind": "normal",
    "parentThreadId": null,
    "anchorItemId": null,
    "depth": 0
  },
  "items": [
    {
      "id": "item:assistant:1",
      "kind": "agentMessage",
      "sequence": 1,
      "parts": ["paragraph", "code", "fileRef"]
    },
    {
      "id": "action:read:1",
      "kind": "exploration",
      "sequence": 2,
      "actionId": "action:read:1",
      "runId": "run:1",
      "attemptId": "attempt:1",
      "participantId": "participant:ling",
      "workflowStepId": null,
      "status": "succeeded",
      "sourceRefIds": ["ref:file:parser"]
    }
  ]
}
```

每个 surface 的 `semantic-state.json` 至少包含以下字段；字段名是测试接口，不能用本地化
文案替代：

```json
{
  "surface": "channel_root",
  "threadId": "thread:root",
  "canonicalRevision": 7,
  "sseCursor": "cursor:7",
  "timeline": {
    "itemKinds": ["agentMessage", "exploration", "commandExecution"],
    "itemIds": ["item:assistant:1", "action:read:1", "action:cmd:1"],
    "rendererKeys": ["message.document", "fact.exploration", "fact.command"],
    "statusValues": ["none", "succeeded", "running"],
    "statusTexts": ["", "Succeeded", "Working"],
    "disclosureCount": 2,
    "scrollOwnerCount": 1
  }
}
```

`lineage.json` 必须能从每一个事实行回链到 `threadId → turnId → itemId → actionId →
runId/attemptId → participantId/workflowStepId → sourceRefs`。packaged macOS 的 `case.json`
还要写明 `simulation=false`、客户端 bundle/version/hash、真实输入、起止时间和 daemon
epoch；`logs.redacted.txt` 只能保留状态、id、revision、事件类型和错误码，必须移除 token、
cookie、用户主目录、完整命令参数中的 secret 和文件内容。

一条验收记录只有在以下关系同时成立时才算有效：

```text
screen row data-*  -> semantic-state.itemIds
semantic-state.itemIds -> lineage.json
lineage.sourceRefs -> durable SQLite / Host evidence
run/attempt terminal fence -> TerminalReport / fan-in conclusion
```

截图、semantic state、lineage 和脱敏日志任一缺失，或 `simulation=true`，都只能标为调试
证据，不能标为 packaged acceptance。这样“简单好看”的视觉结果与“真实发生过”的 Host
事实被明确分开，后续实现和审查可以逐项复现。

## 18. 实现者的最终检查表

在开始修改任一 surface 前，必须逐项成立：

- 输入是一个 `TimelineSnapshot`，不是多份 message/action/block 列表；
- 输出是一次 `mountConversationTimeline()`，不是多个局部 Timeline/WorkCell；
- `actionId + revision` 对应一个 DOM row，terminal fence 后不 reopen；
- 文件、diff、artifact 使用不同 capability target 和专用 viewer；
- source-ref callback 带完整 owning lineage，Host issue/redeem 都重新验证；
- batch 仅作用于 atomic items 的显示副本，不参与 context、TerminalReport 或 fan-in；
- normal/private/channel/topic/branch/child 的 renderer fingerprint 一致；
- packaged macOS 案例同时保存截图、semantic state、lineage 和脱敏日志。

上述任一项缺失时，状态必须记为 implementation incomplete；单测通过或局部截图好看都
不能替代这份闭环。

## 19. D0 当前代码到 v3.7 的 breaking contract

本节是实现开工时必须先完成的 contract delta。它来自对当前代码的逐项核对，不是新的
产品范围：当前 `ConversationItemV1` 没有专用 `terminal_report` kind，TerminalReport
publisher 会把报告 Markdown 写成 `assistant_message`；内部 `LingTerminalReportRecord`
虽然有 `generation` 和 `publishedMessageId`，Web 使用的 `TerminalReportDto` 却没有
generation 或 final-result item identity。这样的 API 无法让 projector 在 retry、SSE
重连和 daemon restart 后可靠选择最高 committed generation，也无法区分模型叙述和
Host result。依赖 `committedAt`、数组顺序或正文内容猜测都不允许。

项目仍在开发阶段，因此 v3.7 采用一次性 contract/schema migration，不保留旧
`assistant_message` TerminalReport renderer、双写或运行时 feature flag。迁移旧开发数据
不等于兼容旧 renderer：迁移完成后，生产路径只读新 contract。

### 19.1 Canonical final-result item

`conversation_items` 的 closed union 增加一个持久化 anchor：

```ts
const conversationItemKindsV1 = [
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "approval_request",
  "approval_decision",
  "handoff",
  "operation_state",
  "artifact_ref",
  "terminal_report",
  "system_event",
] as const;

type ConversationTerminalReportPayloadV1 = {
  readonly reportId: string;
  readonly generation: number;
  readonly sourceKind: "workflow" | "run" | "turn";
  readonly sourceId: string;
  readonly evidenceFingerprint: string;
  readonly outcomeStatus:
    | "succeeded" | "partially_succeeded" | "blocked" | "failed" | "cancelled";
};
```

该 Item 使用 `actorType="system"`，因为它是 Host committed result，不是 Agent 自述；
`domainRefs` 至少包含 `terminal_report`、`turn`、原始 source 和适用的 `run/workflow`。
它的 payload 只保存 join/校验所需字段，不复制报告 Markdown、命令输出或 artifact 内容。
可见标题、summary、changes、verification 和 risks 从对应的 committed report DTO 读取。

`resultItemId` 使用由 `reportId` 推导的稳定 id；同一 report 的重放只能命中同一个 Item。
新 generation 创建新 report 和新 result Item，并通过 `supersedesItemId` 指向上一代 result
Item。主 Timeline 只投影最高 committed generation；旧 generation 仍在 audit 中可追溯。

### 19.2 Conversation detail projection

generation 属于 `LingTerminalReportRecord` 的 publication metadata，不应硬塞回
`TerminalReport` 内容模型。Conversation detail API 改为返回显式 join view：

```ts
type ConversationTerminalReportProjectionDto = {
  readonly report: TerminalReportDto;
  readonly generation: number;
  readonly resultItemId: string;
};

type ConversationDetailResponse = {
  // other canonical records omitted
  readonly conversationItems: readonly ConversationItemV1[];
  readonly terminalReports: readonly ConversationTerminalReportProjectionDto[];
};
```

projector 的 join key 固定为
`terminal_report.payload.reportId == terminalReports[].report.id`，并校验 generation、
thread、turn、source、evidence fingerprint 和 `resultItemId` 全部一致。以下情况一律输出
`diagnostic(blocked)`，不得退回 Markdown assistant message：

- result Item 找不到 report，或 report 没有 committed/fallback 状态；
- Item/report generation 不一致；
- `resultItemId`、thread、turn 或 evidence fingerprint 不一致；
- 同一 source/generation 有两个 committed result Item；
- 最高 generation 没有 final-result Item anchor。

内部字段 `publishedMessageId` 重命名为 `resultItemId`；SQLite migration 可以在事务内把
旧列映射到新列，但迁移后 daemon/core/Web 不保留双字段、双读或双 renderer。频道需要的
可见 `ChannelMessage` grouping 由 adapter 从 result Item 派生，不再让“消息发布”成为
TerminalReport 的事实 owner。

### 19.3 Assistant text segmentation

Codex 风格的关键不是 Markdown 样式，而是 provider 文本和 Host Item 不被聚合成一条
含糊消息。每个 provider text segment 在 tool/action 边界提交为独立
`assistant_message` Item；streaming 只更新当前 segment 的 revision：

```text
agent text segment A -> assistant_message(narration)
tool call/result      -> canonical tool/action anchors
agent text segment B -> assistant_message(narration or terminal text)
TerminalReport commit -> terminal_report result Item
```

`ConversationAssistantMessagePayloadV1` 增加 Host-assigned `presentationRole`：

```ts
type ConversationAssistantPresentationRoleV1 =
  | "narration"
  | "reply_result"
  | "execution_summary";
```

- `narration`：工具前后用于解释正在做什么，始终作为 `agentMessage` 可见；
- `reply_result`：没有 executed-work report 的普通回答，是 reply turn 的唯一结果；
- `execution_summary`：provider 在真实执行后的最终文本，可用于 TerminalReport synthesis
  或 audit；一旦同 turn 的 `terminal_report` committed，默认 Timeline 不再渲染它。

角色由 daemon 根据已接受的 atomic evidence 和 turn finalization 写入，不由模型输出标签，
也不通过正文关键词分类。若 executed work 已终态但 report 尚未 committed，Timeline 在
同一 turn outcome slot 显示轻量 `Finalizing result` protocol state；report committed 后
原位替换为 `terminalReport` row。report 失败则替换为可恢复的 blocked diagnostic，不能
重新显示一张未经验证的模型成功总结。

### 19.4 Atomic publication transaction

TerminalReport 的 publication barrier 必须一次提交下面四个结果：

```text
validate highest generation + Completion Gate
  -> commit LingTerminalReportRecord(g)
  -> append terminal_report ConversationItem(resultItemId, g)
  -> link supersedesItemId / resultItemId
  -> append outbox + invalidation
  -> COMMIT
```

任一步失败都整体回滚；不能出现 report committed 但无 result Item，或 Item 可见但 report
仍是 draft。唯一性约束至少覆盖 `(source_kind, source_id, generation)` 和
`result_item_id`。事务提交后 projector 只需纯 join，不需要等待第二个 endpoint 或用固定
sleep 猜 publication 是否完成。

一次性迁移旧开发数据时，只转换能通过 `terminal_report` domain ref 唯一关联 report、
turn 和 source 的 assistant Item；无法证明关系的旧行保留在 audit，并在主 Timeline
生成 blocked diagnostic。不得根据 Markdown 标题、时间邻近或正文相似度推断 report。

### 19.5 实现中的 D0 slice（未验收基线）

当前实现 worktree 正在把上述 contract 接入以下边界。以下内容描述目标实现形状和当前
WIP，不表示已经通过完整 typecheck、集成测试或 packaged macOS 验收；后续阶段必须在这些
边界上增量实现，不能重新引入“报告即 assistant Markdown”的旁路：

1. contracts closed union 包含 `terminal_report`，assistant payload 包含 Host 写入的
   `presentationRole`；旧开发 caller 在写入边界被规范化为 `narration`，不会产生第二种
   renderer 或第二份历史。
2. `ling_terminal_reports.result_item_id` 是唯一 publication identity；migration 127
   将已有开发数据库的 `published_message_id` 原子重命名，且对 result item 建唯一索引。
3. workflow/run publisher 生成 `result_terminal_report:{reportId}` 的 system Item，payload
   只保存 report join 校验字段；正文、changes、verification、artifact 仍只从 report
   DTO 读取。
4. `conversation-ui-core` 的纯 projector 在同一 source 上选择最高 committed generation，
   严格校验 result Item 的 generation、source、turn、fingerprint；缺 anchor 或冲突只输出
   diagnostic，不回退到 assistant 文本。
5. renderer registry 将 projection kind `terminalReport` 固定映射到 `result.terminal`；
   execute turn 的 `execution_summary` 在 result commit 后被抑制，reply turn 的
   `reply_result` 仍作为唯一文本结果显示。

这段 WIP 只有在 D0 executable gate、Web typecheck 和定向 daemon/API 测试全部通过后，
才能称为完成 D0 contract/result-anchor gate；它不代表 E1 evidence fold、E4 全 surface
切换或 E6 packaged macOS 验收已经完成。

### 19.6 D0 executable gate

D0 必须先用失败测试锁定以下事实，再开始 E1 业务实现：

1. `conversationItemKindsV1` 和 payload validator 接受 `terminal_report`；
2. conversation detail projection 暴露 `generation + resultItemId`；
3. reply fixture 只显示 `reply_result`，execute fixture 只显示一个
   `result.terminal` outcome owner；
4. `narration` 在 child/parent 中继续可见，`execution_summary` 在 report commit 后被抑制；
5. highest committed generation、missing join、duplicate generation 和 fingerprint mismatch
   都有确定性结果；
6. semantic fingerprint 包含 `result.terminal/reportId/generation/resultItemId`；
7. normal/private/channel/topic/branch/child 使用同一 fixture 得到相同结果。

这组 contract 完成后，TerminalReport 才真正成为与 Codex typed result item 等价的 Ling
结果层，而不是换了样式的 assistant Markdown。

## 20. v3.8 Codex-parity 实现蓝图

本节是实现者的直接输入。它把“像 Codex 一样简单好看”拆成可编译的类型、唯一的
数据流、稳定的 DOM 结构和可复现的验收证据。v3.8 不改变 v3.7 已冻结的 SQLite
拓扑、Thread 映射、`contextSegmentId` 规则或 completion authority；它只把剩余实现
边界写成不可猜测的工程契约。

### 20.1 一次 turn 的唯一数据流

```text
Host event / SQLite row / SSE delta
        │
        ▼
TimelineSourceSnapshot（原始事实 + coverage + watermark）
        │  daemon：scope、redaction、dedupe、revision、terminal fence
        ▼
EvidenceFold（每个 actionId 只有一个当前 revision）
        │
        ▼
CanonicalTranscriptProjector（纯函数）
        │  owner、attempt、context、lineage、order、result anchor
        ▼
TimelineSnapshot（只含已校验 atomic typed items）
        │
        ├─ optional display-only batching（不落库）
        ▼
ConversationTimeline（唯一历史 owner）
        │
        ├─ document lane：Markdown / code / path
        ├─ fact rail：command / file / tool / approval / protocol
        ├─ result lane：execute turn 的 terminalReport
        └─ nested rail：depth=1 child，复用同一 registry
```

`TimelineSourceSnapshot` 不得直接传给 React；`TimelineSnapshot` 不得再执行 I/O、排序、
完成判断或事实猜测。任何 surface、Composer、EnvironmentPopover 或 Right Dock 都只能
消费已经投影的 snapshot 或其稳定 source ref。

### 20.2 最小类型形状（实现契约）

以下字段是最小集合，字段名和语义固定；可以增加与产品无关的扩展字段，但不能删除、
改名或把事实字段降级为可选猜测值：

```ts
type TimelineSourceSnapshot = {
  scope: ResolvedConversationSurface;
  conversationItems: readonly CanonicalConversationItem[];
  actions: readonly CanonicalExecutionAction[];
  approvals: readonly CanonicalApprovalRecord[];
  artifacts: readonly CanonicalArtifactRecord[];
  participantSpans: readonly CanonicalParticipantSpan[];
  terminalReports: readonly CanonicalTerminalReportProjection[];
  sourceRevision: string;
  sourceSequence: number;
  sseCursor: string | null;
};

type TimelineSnapshot = {
  scope: ConversationTimelineScope;
  items: readonly ConversationTimelineItem[];
  activeRun: ActiveRunSnapshot | null;
  canonicalRevision: number;
  sseCursor: string | null;
  contextSegmentIdByItemId: ReadonlyMap<string, string>;
};

type OperationLineage = {
  actionId: string;
  runId: string;
  attemptId: string;
  participantId: string;
  workflowStepId: string | null;
  sourceRefs: readonly ConversationOperationSourceRef[];
};
```

`userMessage`、`agentMessage`、`reasoning`、`plan` 可以只携带自己的
`conversation_item` anchor；所有 command/file/tool/exploration/child action 必须携带
完整 `OperationLineage`。缺任一项时 projector 输出 `diagnostic(blocked)`，不得生成
绿色成功行。

### 20.3 EvidenceFold：start/update/end 原地收敛

```text
key = actionId
revision = monotonic integer
terminalFence = first accepted terminal end

tool_start  -> create {status: running, revision: r}
tool_update -> replace same key when r > current.revision
tool_end    -> replace same key and set terminalFence when first terminal end arrives
late event  -> audit diagnostic; never reopen the row
equal-conflict / stale -> reject + audit; never append a second row
```

每个被接受的 update 都必须先写 durable `RunEvent/ExecutionAction`，再发按
`actionId + revision` 定位的 invalidation。UI 读到的是 fold 后的 atomic action，不是 SSE
到达顺序。输出只保留脱敏 bounded tail（40 行、8KiB、64 chunks）；完整日志使用
trusted artifact ref 延迟打开。

### 20.4 Canonical projector：七步纯函数算法

实现必须保持单次线性扫描，且按以下顺序执行：

1. 校验 `workspaceId + real LingThread.id`，过滤 scope 外记录；
2. 以 `ConversationItem.sequence + partIndex + stable id` 排序，拒绝重复 sequence；
3. 以 `actionId` 选择最高 revision，校验 action 与 conversation item owner；
4. 按 `turnId/attemptId/attemptNumber` 选择最新有效 attempt，旧 attempt 留在 audit；
5. 折叠 tool envelope、approval、artifact 和 participant span，缺 owner 生成 blocked；
6. 绑定最高 committed TerminalReport 与 `resultItemId`，execute turn 抑制
   `execution_summary`；reply turn 只保留 `reply_result`；
7. 得到 atomic items 后，最后一次调用 display-only batching，并生成 fingerprint。

禁止按文本相似度、时间邻近、数组位置、batch 数量或 SSE 到达顺序推断 owner、结果、
context segment 或完成状态。

### 20.5 Renderer 组合：一条时间线，三类视觉行

`mountConversationTimeline` 的输入和输出固定为：

```ts
type ConversationTimelineMountProps = {
  snapshot: TimelineSnapshot;
  policy: ConversationInteractionPolicy;
  callbacks: ConversationSurfaceCallbacks;
  renderChild: (item: ConversationTimelineSubAgentItem) => ReactNode;
};

// pure composition: no DB, network, sorting, batching or completion logic
function mountConversationTimeline(props: ConversationTimelineMountProps): ReactNode;
```

渲染层只做三件事：根据 closed union 选择 exhaustive renderer、把稳定字段写入
`data-conversation-timeline-*` selector、把唯一的 disclosure/focus callback 传给 owning
row。它不能创建 action、改变状态、拼接 summary 或决定 approval。

```text
ConversationTimeline
├─ DocumentItem       user / agent / reasoning / plan / compaction
│  ├─ MarkdownBody
│  ├─ CodeBlock        保留 fence、语言、缩进和 copy
│  └─ LocalPathRef     basename + icon；trusted ref 才能 open
├─ TimelineFactRow    command / exploration / file / tool / approval / protocol / diagnostic
├─ TerminalReportRow  execute turn 唯一 outcome slot
├─ TimelineBatchRow   只包 exact atomic children
└─ SubAgentActivity   participant label + 1px rail + depth=1 Timeline
```

document item 无背景、无右侧气泡、最大宽度 760px；fact row 是最小 28px 的单列轻量行，
首屏固定为 `icon + 动作动词 + 文本状态 + 一个 disclosure`。成功默认折叠，active、
waiting、failed、blocked 默认展开一层 bounded detail；任何状态不得只用颜色表达。

### 20.6 三种 surface 和子 Agent 只换 scope/chrome

```text
normal       -> ResolvedConversationSurface(kind=normal)
private      -> ResolvedConversationSurface(kind=private)
channel      -> ResolvedConversationSurface(kind=channel_root|topic|branch)
child        -> ResolvedConversationSurface(kind=child, depth=1)
                         │
                         └── same projector → same batch → same registry
```

surface adapter 只提供 `threadId/policy/chrome/callbacks`。normal/private/channel/child 在同一
fixture 上必须得到相同的 `kind/order/rendererKey/status/disclosure`；可以不同的只有标题、
roster、participant rail 和权限提示。Topic/Branch 必须传真实 `LingThread.id` 与 anchor，
不能使用 `channel:<id>`、`topic:<id>` 或 message id 充当 transcript thread。

子 Agent 的 narration 是普通 `agentMessage`；真实命令、文件、工具继续是父级相同的 fact
renderer。`subAgentActivity` 只负责 participant label、lifecycle 和 rail。depth=2 只显示
`diagnostic(nested_depth_exceeded)`，不再增加缩进或第二个滚动容器。

### 20.7 Codex-parity 内容规则

| 内容 | 首屏 | 展开/点击 | 事实边界 |
| --- | --- | --- | --- |
| paragraph/list/quote | Markdown 文档流 | 无需展开 | 只是模型叙述 |
| fenced code | 等宽、保留换行/缩进、语言标签 | copy + bounded horizontal scroll | 不是命令事实 |
| 模型路径 | basename + file icon | tooltip/copy 完整路径 | 不可导航、不生成 `file://` |
| trusted file/diff/artifact | basename + icon + 可访问名称 | Host capability viewer | callback 再校验 scope/realpath/epoch |
| command/tool | 动作动词 + 状态 | 同一 row disclosure | 必须有 Host evidence |
| terminalReport | `Result · status · counters` | summary/changes/verification/artifacts | Completion Gate + atomic publication |

未闭合 code fence 在流式阶段用 plain monospace；解析完成后在同一个 message id 内切换，
不追加第二条消息。Markdown 解析失败保留纯文本并产生 diagnostic。

### 20.8 Batching、滚动和 EnvironmentPopover

批次只在 atomic projection 完成后运行：

```text
1–2 个相邻安全终态 read/command -> 普通 fact rows
≥3 个相邻安全终态同 lineage   -> 一个可逆 batch header
active / waiting / failed / blocked / approval / consequential -> 永远独立
```

batch header 只显示精确 child 数量（如 `Read 8 items`、`Ran 3 commands`），展开后恢复
exact child order。它没有 completion state，不写 SQLite，不改变 `contextSegmentId`，也不
参与 fan-in/TerminalReport。页面只有一个 `ConversationFeedViewport` 纵向滚动 owner；
detail 预览最多 240px，超出用同一 row 的 `Show more` 或 artifact viewer，不能创建内嵌
terminal scroll。

EnvironmentPopover 只绑定当前 `activeRunId/actionId`，最多两行：

```text
Working · Engineer editing parser.ts
ling-stack · feature/transcript
```

active revision 原地更新；run 进入 terminal fence 后关闭；reconnect 只显示短暂
`Reconnecting` shell hint。浮窗、Composer、Right Dock 不得复制 Timeline 的动作、输出、
summary、TerminalReport 或 approval control；点击 source 只 focus owning row。

### 20.9 Completion、恢复和 fan-in

每个 turn 只有一个 outcome slot：

```text
reply turn   -> agentMessage(role=reply_result)
execute turn -> Finalizing result | terminalReport | diagnostic(blocked)
```

`terminalReport` 必须在同一 publication transaction 中提交 report、result Item、
supersession link 和 invalidation。只显示最高 committed generation。fan-in 只有在所有
required participant evidence 到齐，或每个缺失 participant 都有结构化 blocked 后才可
settle；`ready` 文本、plan step 数量、batch count 和模型总结都不能完成任务。

SSE reconnect 与 daemon restart 都从 durable snapshot 重建同一 `actionId + revision +
terminalFence`；旧 attempt 只进 audit，晚到 end 只进 diagnostic。任何恢复路径都不能
追加第二个 action row、第二个 TerminalReport 或重复 final summary。

### 20.10 实现提交与验收证据

每个实现 commit 必须说明下面的映射，并同时提交对应测试：

```text
typed kind
  -> source of truth
  -> projector / fold function
  -> rendererKey + data-* selector
  -> owning callback/viewer
  -> unit/component/integration/packaged evidence
```

packaged macOS 每个案例固定保存：

```text
case.json             simulation=false、build、thread/turn/run/attempt、输入
screen-01.png         active/initial
screen-02.png         expanded/final/recovery
semantic-state.json   kind、id、status、revision、rendererKey、scrollOwnerCount
lineage.json          item/action/run/attempt/participant/workflow/sourceRefs
logs.redacted.txt     事件类型、状态、revision、错误码；无 token、cookie、secret、文件内容
```

至少覆盖 normal/private/channel、child narration+command、read batch、file diff、approval、
failed→retry、SSE reconnect、daemon restart、partial→complete fan-in 和 depth-2 blocked。
`simulation=true` 或缺少 lineage 的截图只能算调试证据。

### 20.11 迁移和定义完成

开发阶段直接切换到 v3.9 contract：不保留旧 WorkCell/activity renderer、旧
TerminalReport-as-assistant-message 路径、双写或 feature flag。旧 SQLite 行只通过 strict
adapter 读取；无法证明 lineage 的记录显示 blocked diagnostic。实现完成必须同时满足：

- 五份权威设计互相链接，使用同一术语和阶段编号；
- 三种 surface 和 depth-1 child 的 fingerprint 一致；
- 每个事实行有完整 lineage，action 更新原地收敛；
- execute turn 只有一个 `terminalReport` outcome，reply turn 只有一个 `reply_result`；
- batch 可逆、不落库、不参与完成；
- 单一 scroll owner、无右侧方形 bubble、无 Composer/Popover 重复 summary；
- E1–E5 相关测试全绿，E6 packaged macOS 证据四件套齐全。

未决设计：无。任何实现偏差必须先修改本节和对应视觉/计划文档，再改代码；不得在
surface 内加入临时例外。

## 21. v3.9.1-final 开工补充设计（2026-09-01）

这一节是实现者开始改代码时的最短、最具体输入。它把 Codex 的“typed item + 专用
renderer”原则落到 Ling 的 durable facts、multi-Agent 和 Host capability 上；如果本节
与旧版历史段落冲突，以本节和 §1.4 实现锁为准。它不新增 SQLite 表，也不新增 provider
session。

### 21.1 四条可见通道和唯一 owner

```text
document lane  = 模型/用户叙述（可读，但不是事实）
fact rail      = Host 真实动作（可审计，必须有 lineage）
result lane    = execute turn 的唯一 terminalReport
shell chrome   = Composer / EnvironmentPopover / viewer（只控制或定位）
```

| 可见内容 | 唯一来源 | 唯一 renderer | 可以证明什么 | 明确禁止 |
| --- | --- | --- | --- | --- |
| `userMessage`、`agentMessage`、`reasoning`、`plan` | `conversation_items`/safe summary/plan snapshot | `document.*` | 叙述、计划或上下文变化 | 证明命令、文件或任务完成 |
| `commandExecution`、`exploration`、`fileChange`、typed tool、`approval` | `RunEvent`、`ExecutionAction`、Approval、Artifact | `fact.*` | 对应 action 的状态和证据 | 从模型文案或 batch 数量猜成功 |
| `terminalReport` | Completion Gate + committed report + final-result item | `result.terminal` | execute turn 的最终 outcome | 再追加 assistant summary 或结果卡 |
| `subAgentActivity` | participant span + child atomic items | `agent.nested` + 同一 registry | participant 生命周期和 child 事实 | 把 `ready/done` 当 fan-in 完成 |
| `Composer`、`EnvironmentPopover`、Right Dock | 当前 active action / trusted source ref | shell/viewer | 控制、ambient hint、预览 | 复制历史 action/output/report |

任何一条事实无法给出 `actionId/runId/attemptId/participantId/workflowStepId/sourceRefs`
的完整关系时，主 Timeline 只能显示 `diagnostic(blocked)`；不得退化成绿色成功行。

### 21.2 Codex item 到 Ling 的闭合映射

实现必须一次性通过 contract adapter 完成 `wire kind → projection kind → rendererKey`，
禁止 surface 直接消费 wire kind 或把未知 kind fallback 为 `agentMessage`：

```text
user_message             -> userMessage          -> message.document
assistant_message        -> agentMessage         -> message.document
reasoning_summary        -> reasoning            -> document.reasoning
plan_snapshot            -> plan                 -> document.plan
command_execution        -> commandExecution     -> fact.command
exploration              -> exploration          -> fact.exploration
file_change              -> fileChange           -> fact.file
mcp_tool_call            -> mcpToolCall          -> fact.tool
dynamic_tool_call        -> dynamicToolCall      -> fact.tool
collab_agent_tool_call   -> collabAgentToolCall  -> fact.tool
approval_*               -> approval             -> fact.approval
image/artifact           -> imageView             -> document.image
context_compaction       -> contextCompaction     -> document.compaction
participant_span         -> subAgentActivity     -> agent.nested
terminal_report          -> terminalReport       -> result.terminal
unknown/missing lineage  -> diagnostic(blocked)  -> fact.diagnostic
```

`agentMessage` 可以有多个 content part（段落、list、quote、fenced code、path candidate、
trusted file ref）。Markdown AST 只决定文档排版；它永远不能创建 `commandExecution`、
`fileChange` 或 `terminalReport`。

### 21.3 一次 render cycle 的确定性算法

```text
TimelineSourceSnapshot（可能 partial）
  1. 校验 thread/scope/cursor coverage
  2. EvidenceFold：按 actionId 折叠 start/update/end，拒绝旧 revision 和 terminal fence 后事件
  3. CanonicalTranscriptProjector：按 durable sequence/partIndex 排序，绑定 owner/attempt/lineage
  4. Completion join：按 turnId 选择最高 committed generation 的 terminalReport
  5. Display projection：只对相邻、同 lineage、安全终态 item 计算可逆 batch
  6. renderer registry：每个 visible item 只映射一个 rendererKey
  7. 输出 semantic DOM + lineage snapshot
```

这条链是纯函数边界。React 不读取 SQLite/SSE，不排序、不去重、不判断 fan-in；batch
不改变 `contextSegmentId`、completion、retry 或 approval。相同输入 snapshot 必须得到
相同 `kind/order/status/rendererKey/disclosureCount`，否则 fixture 失败。

### 21.4 Surface、Thread 和 child 的确定性映射

| surface | `LingThread` 绑定 | 允许的额外 chrome | 不允许的实现 |
| --- | --- | --- | --- |
| normal | 当前正常会话真实 `LingThread.id` | 标题、模型/权限提示 | 右侧 bubble、独立 WorkCell |
| private | 用户与 teammate 的真实私聊 `LingThread.id` | teammate avatar/name、私聊 policy | 私聊专用事实卡、第二 renderer |
| channel root | channel root 的真实 `LingThread.id` | roster、channel controls | `channel:<id>` synthetic thread |
| topic | durable topic child `LingThread.id` + `parentThreadId` + `anchorItemId` | topic header/reply control | 用 message id 或 parent feed 代替 topic thread |
| branch | fork 后真实 `LingThread.id` + immutable fork snapshot | branch header | 把 parent transcript 复制到 branch |
| child | participant span 的 child snapshot，`depth=1` | participant label + 1px rail | depth=2 Timeline、child-specific renderer |

所有入口先构造 `ResolvedConversationSurface`，再调用一次 `mountConversationTimeline`。
无法解析真实 thread 或 scope 时返回 `diagnostic(scope_mismatch)`，不猜默认值。

### 21.5 `contextSegmentId` 的选择顺序

```text
用户显式选择
  > 结构化规则（topic/branch/turn boundary）
  > 受权限与 scope 约束的模型候选
  > 服务端 ContextSegmentationPolicy 提交
```

只有服务端提交的 `TurnContextAssignment`/`ContextSnapshot` 才能写入
`contextSegmentIdByItemId`。模型候选未通过 scope、权限或冲突校验时保持 `null` 并显示
原子 item；UI batch、摘要、相邻文本相似度和 renderer 都不能创建或改写 segment。

### 21.6 状态和失败的唯一表达

事实状态闭集为 `Queued/Working/Waiting/Waiting for approval/Succeeded/Failed/Cancelled/Blocked`。
`ready`、`done`、`已完成`、`执行中` 等模型文本只能落在 document lane 或 diagnostic
detail。以下情况统一 fail closed：

- partial source coverage：保留已知事实，缺失部分为 `Waiting`，不提前 settle；
- missing/跨 scope lineage：`Activity unavailable · Blocked`，保留 sourceRefs 供审计；
- 同一 generation payload 冲突：原 row 保持原状态，新增 `owner_conflict` diagnostic；
- terminal fence 后 late event：只写 audit diagnostic，不重开 row 或 result；
- depth=2 child：`nested_depth_exceeded`，不创建第三个 Timeline。

实现、组件测试、E2E 和 packaged evidence 都必须验证这些 fail-closed 结果，不能只验收
成功截图。

### 21.7 “调用一次 Timeline”的语义边界

`normal/private/channel/topic/branch` 的“一次”按 surface viewport 计，不按 message、turn、
workflow、run 或 activity row 计。当前把 shared `ConversationTimeline` 分别嵌入多条
`MessageRow`/activity caller 的过渡实现仍然有多个 transcript owner，不满足本设计。

目标数据流是：

```text
one real LingThread
  -> one TimelineSourceSnapshot
  -> one atomic/display projection
  -> one ConversationFeedViewport
  -> one ConversationTimeline composition
       -> many document/fact/result rows
       -> depth-1 child rail (same registry, not another surface)
```

消息 actor、created/edited metadata、attachment/path/web/memory resources，以及 copy/edit/
feedback/reply/create-task affordance 必须进入 shared message presentation/typed interaction
contract。protocol action 必须是 Host 验证过的 enum + typed callback。它们都不能要求
surface 继续套一层 route-local `MessageRow`、证据卡或任意 `ReactNode` action slot。

E4 只有在每个 viewport 同时满足 `timelineOwnerCount=1`、`scrollOwnerCount=1`、
`syntheticThreadCount=0`、`actionOwnerCount(actionId)=1`、`resultOwnerCount(turnId)<=1` 后才
完成。细接口和删除顺序见组件细设计 §28，实现任务和测试文件见实施计划 §4.14。
