# Ling Typed Transcript：Codex 风格统一会话详细设计

Status: normative design v3.1；实现前冻结
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
approval | imageView | contextCompaction | subAgentActivity
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
  | "approval" | "imageView" | "contextCompaction" | "subAgentActivity"
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
    | "file" | "diff" | "image" | "context_snapshot" | "tool_call";
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

每个事实行和 batch 都必须保留 `actionId`、`runId`、`attemptId`、`participantId`、
`workflowStepId`、`sourceRefs`。主 feed 中的事实至少有一个同 thread 的
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

type ApprovalItem = ConversationTimelineItemBase & OperationLineageEnvelope & {
  readonly kind: "approval";
  readonly approvalId: string;
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
  readonly children: readonly (CommandExecutionItem | ExplorationItem)[];
};

type DiagnosticItem = ConversationTimelineItemBase & {
  readonly kind: "diagnostic";
  readonly code: "missing_lineage" | "scope_mismatch" | "revision_conflict"
    | "nested_depth_exceeded" | "unknown_item";
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

type ConversationTimelineItem =
  | MessageItem | ReasoningItem | PlanItem
  | CommandExecutionItem | ExplorationItem | FileChangeItem | ToolCallItem
  | ApprovalItem | ImageViewItem | ContextCompactionItem
  | SubAgentActivityItem | ActivityBatchItem | DiagnosticItem;
```

`ActivityBatchItem.children` 只能包含已投影的 atomic children，不能嵌套 batch。

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
  readonly onToggleDetail(id: string): void;
  readonly onOpenTrustedFile(ref: ConversationOperationSourceRef): void;
  readonly onOpenTrustedDiff(ref: ConversationOperationSourceRef): void;
  readonly onRetry(actionId: string): void;
  readonly onResolveApproval(approvalId: string, decision: "allow" | "deny"): void;
  readonly onFocusSource(ref: ConversationOperationSourceRef): void;
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

## 15. 已冻结的决策

1. 一个 canonical timeline + 一个 renderer registry，三种会话和子 Agent 统一。
2. Markdown 是叙述；Host evidence 才是事实。
3. 全量 SQLite 历史持久化，contextSegmentId 只来自显式 context snapshot。
4. batch 只做可逆 UI 投影，不新增 SQLite 表或摘要记录。
5. 未发布开发阶段直接切换，不保留旧 renderer 兼容层。
6. child timeline 最多一层；缺 evidence 返回结构化 blocked。
7. TerminalReport/fan-in 只读原子 evidence，绝不读取 batch 数量或 ready 文本。

No unresolved design decisions.
