# Ling Typed Transcript：Codex 风格统一会话详细设计

Status: normative design v3.5；implementation lock（contract 已冻结）
Date: 2026-09-01
Base: `origin/main` @ `63ab7c0e`
Scope: 普通会话、队友私聊、频道 root/topic/branch、depth-1 子 Agent、macOS 客户端
Owner: Conversation UI、conversation-ui-core、daemon runtime maintainers

本文件是 typed transcript 的唯一数据和语义规范。视觉细节见
[Conversation Codex-Parity Visual Specification](conversation-codex-parity-visual-spec.md)，
工程步骤见
[Codex-style Typed Transcript Implementation Plan](conversation-codex-style-transcript-implementation-plan.md)。
频道/Topic/Branch 的持久化拓扑见
[Channel Conversation Continuity v2](channel-conversation-continuity-v2.md)，表面词汇见
[Conversation Surface Taxonomy](conversation-surface-taxonomy.md)。这两个文档定义存储和路由
边界；本文件只定义它们如何投影成同一 typed transcript。
旧版方案保留在 Git 历史，不再作为实现入口。

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
结果：最终 agentMessage 解释结果，不能复制命令行
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

v3.5 把审美要求翻译成三个可验收的层次，避免实现者用不同的卡片和文案各自解释
“像 Codex”：

```text
document lane  = 叙述和 Markdown，保留段落、列表、代码、路径结构
fact rail      = 真实动作，一行表达 icon + 动词 + 状态 + 一个 disclosure
shell chrome   = header / EnvironmentPopover / Composer，不拥有历史事实
```

实现时必须同时满足：

1. 一条垂直时间线只有一个 scroll owner；document lane、fact rail 和 nested rail
   只是同一 DOM 流的语义分组，不能变成左右两列或第二个历史面板。
2. 同一 `actionId` 只有一个 owning row。`tool_update`、SSE 重连和 daemon restart
   只更新该行的 `revision/status/detail`，不创建“开始/完成”两张卡。
3. 成功历史默认收敛，进行中、等待、失败、取消和 blocked 才增加细节或操作控件；
   颜色只作辅助，文本和 icon 始终完整表达状态。
4. 普通、私聊、频道和子 Agent 使用同一 item union、projector、batch 函数和
   renderer registry。surface 只能改变 shell chrome、policy 和 participant rail。

因此“右侧方形消息”“Composer 下重复总结”“子 Agent 乱码或只有 ready 文本”都属于
契约违例，不是可以由 CSS 局部修补的视觉偏好。

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
commandBatch | explorationBatch | diagnostic
```

新增 kind 必须在同一个变更中增加：contract、registry entry、semantic selector、
component test、E2E fixture 和文档映射。未知 kind 只能落到 blocked diagnostic。

实现层先定义闭合的 kind union；renderer 不接受任意字符串：

```ts
type ConversationTimelineItemKind =
  | "userMessage" | "agentMessage" | "reasoning" | "plan"
  | "commandExecution" | "exploration" | "fileChange"
  | "mcpToolCall" | "dynamicToolCall" | "collabAgentToolCall"
  | "approval" | "imageView" | "contextCompaction" | "protocolEvent" | "subAgentActivity"
  | "commandBatch" | "explorationBatch" | "diagnostic";
```

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
    | "file" | "path" | "diff" | "image" | "context_snapshot" | "tool_call";
  readonly id: string;
  readonly label?: string;
  readonly path?: string;
  readonly hostTarget?: "open_file" | "open_diff" | "open_artifact" | "open_run";
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
    readonly status: "pending" | "running" | "succeeded" | "failed" | "blocked";
  }[];
};
```

`reasoning` 不是 chain-of-thought。prompt、隐藏推理、selector score、token 统计和
provider 内部事件永不进入 transcript。

### 5.4 事实 item

```ts
type CommandExecutionItem = ConversationTimelineItemBase & OperationLineageEnvelope & {
  readonly kind: "commandExecution";
  readonly command: string;
  readonly cwd?: string;
  readonly status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "blocked";
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

### 5.6 Batch 和 diagnostic item

```ts
type ActivityBatchItem = ConversationTimelineItemBase & OperationLineageEnvelope & {
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
  | ApprovalItem | ImageViewItem | ContextCompactionItem | ProtocolEventItem
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
  readonly policy: ConversationSurfacePolicy;
  readonly callbacks: ConversationTimelineCallbacks;
};

type TimelineSemanticAttrs = {
  readonly id: `conversation-timeline-${string}`;
  readonly kind: ConversationTimelineItemKind;
  readonly status?: string;
  readonly revision: number;
  readonly depth: 0 | 1;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
};
```

DOM 必须同时暴露 `data-conversation-timeline-id`、`kind`、`status`、`revision` 和
`depth`。这些属性是测试和诊断接口，不是权限输入。renderer 不得从 `item.content`
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
| 队友私聊 | 一个 user + teammate scoped `surfaceKind="direct"` thread | 无；同一 pair 继续该 thread | 为每次发送新建 session 或复用频道历史 |
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
  readonly parentItemId?: string;
  readonly participantId?: string;
  readonly policy: ConversationSurfacePolicy;
};
```

`ConversationTimeline` 不接收 `channelId`、`anchorItemId` 或模型猜出的 target；它只接收
解析后的 `threadId` 和 canonical items。这样三种会话可以共享 renderer，而不会把路由
语义泄漏到渲染层。

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
| 最终自然语言 | 最终 `agentMessage` |
| 命令事实 | `commandExecution` |
| 文件事实 | `fileChange` + trusted diff/artifact |
| 工具事实 | 对应 typed tool item |
| 待审批控制 | Composer/dialog gate |
| 终态报告 | `TerminalReport` |
| UI 折叠 | Timeline local view state |

禁止同一 action 同时出现在 assistant bubble、WorkCell、TerminalReport summary 和
Composer 下方。路由可以组合消息和 Timeline，但事实列表必须只有一个 owner。

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
TerminalReport / fan-in   结论：只由 required atomic evidence 计算
        │
        ▼
final agentMessage        叙述：向用户解释结果和下一步
```

规则：

1. `plan` 的 step 状态只由对应 atomic evidence 映射；模型写“已完成”不会改变 step。
2. 一个 action 只能有一个 fact owner；同一命令不再同时出现在 assistant bubble、旧
   WorkCell、TerminalReport summary 和 Composer footer。
3. 没有 evidence 的 ready/完成文本仍作为 `agentMessage` 渲染，并在需要时附加
   `diagnostic(blocked)`；不得生成绿色成功行。
4. TerminalReport 是事实结论的唯一可见 owner；它引用 source refs，但不复制 command
   output。Composer 只拥有 approval control，不拥有完成摘要。
5. 排序使用 durable `sequence + partIndex`。计划可以先于执行出现，执行结束后 final
   message 才能解释结果；不得因“后来出现了总结”而把事实行移到别处。

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

`batch.actionId = actionIds[0]` 只是显示锚点，不是新事实。batch revision 是 child
revision 的最大值；completion/fan-in 永远读取 child actions。

### 9.5 批次拆分的确定性算法

批次投影使用单次线性扫描，任何边界都先 flush 再处理当前 item。边界判定不读取
文案、不读取可见行数，且返回可审计的 `splitReason`：

```text
for item in atomic:
  if item is not eligible: flush("kind_or_status")
  else if lineage(item) != lineage(openBatch): flush("lineage")
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

## 10. 统一渲染架构

```text
ConversationSurfaceShell（policy + chrome）
└── ConversationFeed（唯一滚动 owner）
    └── ConversationTimeline
        ├── MessageRenderer（user/agent Markdown）
        ├── FactRenderer（command/file/tool/approval/...）
        ├── BatchRenderer（可逆 disclosure）
        └── SubAgentRenderer
            └── ConversationTimeline(depth=1, same registry)
```

Timeline 只拥有 disclosure、focus 和 scroll anchor 本地状态：

```ts
type ConversationTimelineProps = {
  readonly items: readonly ConversationTimelineItem[];
  readonly policy: ConversationSurfacePolicy;
  readonly depth: 0 | 1;
  readonly callbacks: ConversationTimelineCallbacks;
};

type ConversationTimelineCallbacks = {
  readonly onOpenSourceRef?: (ref: ConversationTrustedSourceRef) => void;
  readonly loadPreview?: (ref: ConversationOperationSourceRef) => Promise<unknown>;
  readonly renderSubAgentAvatar?: (item: ConversationTimelineSubAgentItem) => ReactNode;
  /** Surface controls are rendered in the owning fact-row disclosure. */
  readonly renderFactActions?: (item: ConversationTimelineRowItem) => ReactNode;
};
```

Timeline 不接收 SQLite handle、raw SSE、provider payload 或 daemon client；Host action
由 surface adapter 注入，并在进入 callbacks 前完成 trusted path/permission 检查。

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

`ConversationTimeline` 是唯一的 scroll owner，并以稳定 item id 保存 anchor：

1. 用户距离底部超过 24px 时，新的 agentMessage 或 tool_update 不得抢滚动位置；
2. 用户在底部时，新增内容只通过一个 `requestAnimationFrame` 贴底，不能由多个
   `useEffect` 重复 `scrollTo`；
3. resize、字体加载或 batch 展开只修正当前 anchor 的相对偏移，不跳到历史顶部；
4. SSE reconnect、daemon restart 和 retry 只能更新同一 id 的 row，不得触发第二个
   scroll container；
5. focus 在 disclosure、trusted file action 和 retry 后仍保持可见，`Escape` 关闭
   detail/popover 后回到 owning row。

这些规则属于 shared timeline，不允许 normal/private/channel 各自实现一份滚动逻辑。

### 10.4 统一 renderer 的组合契约

“统一会话组件”不是让每个 surface 传一份不同的 JSX，而是固定一条组合链：

```text
ResolvedConversationSurface
  -> ConversationTimeline(items, policy, callbacks)
      -> renderTimelineItem(item, depth)
          -> document renderer / fact renderer / batch renderer / nested renderer
```

组合契约只有三类输入：

1. `items`：已经完成 scope、owner、attempt、revision 校验的 canonical 或 display-only
   batch item；
2. `policy`：可见性、是否允许 retry/open-file/approval，以及 surface 的外围 chrome；
3. `callbacks`：由 Host 注入的动作入口。renderer 不能自己读取路由、SQLite、SSE 或
   provider 状态。

每个 item 只能被组合链消费一次，并且只能产生一个 owning row。`agentMessage`、
`reasoning`、`plan` 和子 Agent narration 进入 document lane；`commandExecution`、
`fileChange`、tool、approval 和 diagnostic 进入 fact rail；`subAgentActivity` 只增加
participant rail 并递归调用同一个 `ConversationTimeline`。不得再包一层旧
`MessageRow`/`WorkCell`，也不得由 surface 在 timeline 外追加 summary、TerminalReport
或第二个 activity panel。

为避免“看起来统一、实际上分叉”，实现必须提供一个 surface-agnostic factory：

```ts
type ConversationTimelineMount = {
  readonly timeline: React.ReactNode;
  readonly fingerprint: TimelineFingerprint;
};

function mountConversationTimeline(
  surface: ResolvedConversationSurface,
  snapshot: CanonicalConversationSnapshot,
  callbacks: ConversationTimelineCallbacks,
): ConversationTimelineMount {
  const atomic = projectCanonicalItems(snapshot, surface.threadId);
  const visible = batchCanonicalTranscriptItems(atomic);
  return {
    timeline: <ConversationTimeline items={visible} policy={surface.policy}
      depth={surface.kind === "child" ? 1 : 0} callbacks={callbacks} />,
    fingerprint: fingerprintTimeline(visible),
  };
}
```

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
  readonly onOpenSourceRef?: (ref: ConversationTrustedSourceRef) => void;
  readonly loadPreview?: (ref: ConversationOperationSourceRef) => Promise<unknown>;
  readonly renderSubAgentAvatar?: (item: ConversationTimelineSubAgentItem) => ReactNode;
  readonly renderFactActions?: (item: ConversationTimelineRowItem) => ReactNode;
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
4. mount 将已经完成校验的 snapshot 和 callbacks 交给 `ConversationTimeline`，由
   exhaustive registry 渲染；
5. mount 同时计算 fingerprint，供 normal/private/channel/topic/branch/child 的 parity
   测试使用。mount 不执行 I/O、排序、完成判断或 capability 签发。

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
| disclosure/focus/scroll anchor | `ConversationTimeline` view state | 否 | 否 |
| 输入草稿/附件/stop/approval control | Composer | 草稿按现有策略 | 否，approval decision 除外 |
| 当前 active run 提示 | `EnvironmentPopover` | 否 | 否 |
| 文件/命令完整详情 | owning row 或 trusted detail dock | durable ref | 只引用，不另判定 |

`TerminalReport` 是 atomic evidence 的投影结论，不是第二份 action list；final
`agentMessage` 解释结果，但不复制 command output、文件统计或 approval 控件。
任何新 UI 区域若需要展示已有事实，必须 focus/open owning row，而不是复制正文。

## 11. 内容和视觉语义

### 11.1 Markdown、纯文本和代码

- 使用 allowlisted Markdown AST；段落、空行、list、blockquote、fence 不得 flatten。
- 代码块保留缩进和换行，显示 language label 与 copy；高亮失败回退 plain monospace。
- 流式未闭合 fence 先用 plain monospace，commit 后再高亮；不能把半截代码当 action。
- 外部 URL 仅允许 `http/https`；本地 path 必须经过 Host ref 才能点击。

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

## 14.2 实现级契约（v3.5 增量）

本节把“Codex 风格、简单好看”收敛为实现者可以直接照着写的边界。它不新增
SQLite 表，也不引入第二套 session；只是把现有 durable records、daemon evidence
和 shared Timeline 的交接格式固定下来。若实现与本节冲突，先更新本节，再改代码。

### 14.2.1 Snapshot、identity 和刷新

`ConversationTimeline` 只接受一个不可变 `TimelineSnapshot`。surface adapter 必须在
一次渲染周期内提供同一份 snapshot，禁止分别读取 message、action、approval 再在 JSX
中拼接：

```ts
type TimelineSnapshot = {
  readonly scope: {
    readonly kind: "normal" | "private" | "channel_root" | "topic" | "branch" | "child";
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

`workspaceId` 仍然是 `ResolvedConversationSurface` 和 Host capability scope 的必填字段，
但不重复放进 renderer-only 的 `ConversationTimelineScope`；surface adapter 在创建 snapshot
前完成 workspace/thread 一致性校验。实现包中的字段名保持如下对应关系，避免设计字段
和 TypeScript DTO 形成第二套语义：`TimelinePosition.sequence` 对应
`ConversationTimelineItemBase.threadSequence`，`TimelinePosition.conversationItemId`
对应 `itemId`，而 `partIndex` 保持不变。本文中的 `ConversationSurfacePolicy` 是产品层
别名，代码统一使用 `ConversationInteractionPolicy`。

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
  readonly target: "open_file" | "open_diff" | "open_artifact";
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

`ChannelMessageRenderersInput` 必须提供 `channelRootThreadId`，或调用一个返回同等
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
├─ ConversationTimeline（唯一 scroll owner）
│  ├─ document renderer：user/agent/reasoning/plan
│  ├─ fact renderer：command/exploration/file/tool/approval/protocol/diagnostic
│  ├─ batch renderer：display-only disclosure
│  └─ sub-agent renderer：participant rail + Timeline(depth=1)
├─ EnvironmentPopover（只绑定 active action）
└─ Composer（输入、停止、重试、approval control）
```

首屏只保留三种视觉重量：正文自然排版、事实轻量行、需要处理的状态 tint。事实行
固定为 `icon + 动作动词 + 文本状态 + 一个 disclosure`；成功历史默认收敛，active/
failed/waiting/blocked 才展开 bounded detail。Composer、EnvironmentPopover、
TerminalReport 都不得复制事实正文或输出。子 Agent 只增加 participant label 和 1px
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

## 15. 已冻结的决策

1. 一个 canonical timeline + 一个 renderer registry，三种会话和子 Agent 统一。
2. Markdown 是叙述；Host evidence 才是事实。
3. 全量 SQLite 历史持久化，contextSegmentId 只来自显式 context snapshot。
4. batch 只做可逆 UI 投影，不新增 SQLite 表或摘要记录。
5. 未发布开发阶段直接切换，不保留旧 renderer 兼容层。
6. child timeline 最多一层；缺 evidence 返回结构化 blocked。
7. TerminalReport/fan-in 只读原子 evidence，绝不读取 batch 数量或 ready 文本。
8. 所有 surface 和 depth-1 子 Agent 通过同一个 timeline mount/renderer registry；
   surface 只提供 scope、policy、chrome 和 Host callbacks。
9. 普通消息使用 document lane；动作使用 fact rail；任何旧 workflow skeleton、第二
    summary owner 或 route-local renderer 都不属于 v3.5。
10. 频道 protocol event 必须使用真实 `LingThread.id`；禁止 `channel:<channelId>` 作为
    Timeline scope。无法解析时 fail closed 为 `diagnostic(scope_mismatch)`。
11. trusted file/diff/artifact ref 使用短期 Host capability；daemon restart 使旧 token
    失效，事实仍从 SQLite 恢复，点击时重新签发。
12. 所有 surface 与 depth-1 子 Agent 必须通过同一个 `mountConversationTimeline`，并以
    semantic fingerprint、lineage 和真实 packaged macOS 证据验收。
13. v3.5 只替换 transcript projection 和 renderer，不重写 durable SQLite/Run 数据；
    旧 WorkCell 仅可作为迁移期对照，不能作为 production 第二 owner。
14. “简单好看”固定为 document lane、fact rail、attention state 三档视觉重量；不得
    为 normal/private/channel/child 新增 surface-specific row grammar。

No unresolved design decisions for v3.5. Implementation deviations must update this
document before code changes.
