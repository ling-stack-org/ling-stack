# Ling Typed Transcript：Codex 风格统一会话详细设计

Status: normative design; ready for S0 baseline gate (R0-R8 implementation pending)
Date: 2026-08-30
Last verified: 2026-08-30
Owner: conversation UI、conversation-ui-core、daemon runtime maintainers
Supersedes: conflicting operation-renderer and surface-local activity sections in the
supporting conversation documents; those documents remain historical context unless
they explicitly link back here.

Related:

- [Conversation Codex-Parity Visual Specification](conversation-codex-parity-visual-spec.md)
- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation Activity Summary And Exploration Batching](conversation-activity-summary-and-exploration-batching-detailed-design.md)
- [Conversation Command Execution Batching](conversation-command-execution-batching-detailed-design.md)
- [Channel Conversation Continuity v2](channel-conversation-continuity-v2.md)
- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)

## 1. 目标和非目标

Ling 需要一个像 Codex 一样安静、可读、可恢复的会话，而不是把模型文本、命令
日志、文件 diff、审批、队友状态都塞进同一种卡片。目标是：

```text
用户消息 / Agent 叙述（文档流）
        ↓
真实 Host 事实（类型化 activity rail）
        ↓
同一套 renderer（普通、私聊、频道、子 Agent）
        ↓
可回放、可追溯、可恢复的 UI
```

目标体验：

- 普通文本保持段落、列表、代码围栏和空行，不再被方形 WorkCell 包住。
- 命令、文件、工具、审批和结果是小而明确的事实行；每行有 icon、动作描述、
  状态和可选展开，不把原始 JSON 当正文。
- `tool_start/update/end` 永远更新同一个事实行，不追加重复行。
- 普通会话、队友私聊、频道 root/topic/branch 和子 Agent 使用同一 item grammar、
  renderer registry 和行几何；差异只来自 surface policy/chrome。
- 所有事实可以从 UI 追溯到 SQLite 的 `ConversationItem`、Run、Attempt、
  `ExecutionAction`、Artifact、Approval、ParticipantSpan 和 source refs。

非目标：

- 不复制 Codex 的 session 数据库、provider runtime、TUI 或配色。
- 不新增 session/batch/activity SQLite 表，不把摘要或批次写回
  `conversation_items`。
- 不用模型的“ready/done/I will execute”文本证明执行完成。
- 不把 `contextSegmentId` 当作 activity/batch 分组键。
- 不为尚未开源的旧客户端保留第二套 renderer、旧 item spelling 或兼容 feature
  flag；开发阶段直接切到新协议。已有 SQLite 历史仍由 projector 读取，不需要旧 UI
  renderer 才能恢复。
- 本轮不做 Windows packaged QA；发布验收目标是 packaged macOS。

## 2. 核心原则

### 2.1 文本是叙述，Host evidence 是事实

模型产生的 `agentMessage` 只能说明它想做什么或它对结果的解释。只有持久化且带
lineage 的 Host 事实才能声明“运行了命令”“改了文件”“队友完成了步骤”。

```text
agentMessage: “我已经运行测试并修好了。”  -> 叙述
commandExecution(status=succeeded)          -> 命令事实
fileChange(status=succeeded)                 -> 文件事实
TerminalReport + required evidence           -> 完成判断
```

`reasoning` 只允许显式、安全、可展示的摘要，不是 chain-of-thought；prompt、隐藏
推理、selector score、token 统计和 provider 内部事件永远不进入默认 transcript。

### 2.2 一条 canonical timeline，多个 policy projection

```text
SQLite canonical records + SSE deltas
  ConversationItem / Run / Attempt / ExecutionAction / Artifact / Approval / Span
                              │
                              ▼
                 CanonicalTranscriptProjector（纯函数）
                              │
                              ▼
                 ConversationTimelineItem[]（可丢弃 read model）
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
          normal          private           channel
                                                │
                                                ▼
                                      child timeline depth=1
```

Surface adapter 只解析 scope、订阅 snapshot、选择 policy 和绑定 Host callback；它
不能重新排序、按文案分类、二次批处理、创建 completion summary 或切换 renderer。
批处理若启用，只能由共享的 `batchCanonicalTranscriptItems` display projector 在
canonical atomic projection 之后调用一次，不能由 normal/private/channel 各自决定。

### 2.3 一个事实、一个 owner、一个 renderer

- 一个逻辑 action 只有一个稳定 `actionId`，从 start 到 end 只有一个 DOM identity。
- 最终 `agentMessage` 只出现一个正常完成叙述位置。
- `TerminalReport` 负责事实和 lineage；它不再生成第二个“完成了”的摘要块。
- Artifact、Approval、EnvironmentPopover、batch 和 plan 只拥有自己的语义，不得
  抢占别人的完成所有权。
- 任何已知 item kind 都有一个 exhaustive registry entry；未知/损坏事实只落到
  明确的 `genericActivity(blocked)`，不能静默成功。

### 2.4 Codex 借鉴边界

Ling 借鉴 Codex 的信息架构，不复制 Codex 的运行时、会话数据库或终端 UI。可迁移
的是“typed item + 专用 renderer + active item 原地更新 + 可逆 disclosure”这四个
原则：

| Codex 机制 | Ling 对应设计 | 明确不复制 |
| --- | --- | --- |
| `userMessage` / `message` | `userMessage` / `agentMessage` 文档流 | 不把模型文字当执行事实 |
| `reasoning` / `plan` | 安全 reasoning 摘要、typed plan 行 | 不展示隐藏 chain-of-thought |
| `commandExecution` | `commandExecution` + `ExecutionAction` evidence | 不把 stdout chunk 变成消息 |
| `fileChange` | `fileChange` + trusted artifact/diff ref | 不让模型拼出的路径直接打开文件 |
| `mcpToolCall` / dynamic tool | typed tool fact row | 不把原始 JSON 放在首屏 |
| `collabAgentToolCall` / `subAgentActivity` | collaboration row + depth-1 nested timeline | 不为每个 Agent 造第二套聊天 UI |
| active history cell | `TimelineFactRow` 原地更新 | 不追加“完成摘要”替代原 action |
| TUI history renderer | Web/桌面共享 renderer registry | 不引入 Codex TUI 或 provider session schema |

本设计的唯一 Ling-specific 增量是 participant span、fan-in、approval 和
EnvironmentPopover。它们仍然服从同一 item grammar，不能成为第四条渲染管线。

Codex 参考锚点（仅作为信息架构证据，不是 Ling 的运行时依赖）：

- [`protocol/src/items.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/items.rs)：typed turn item。
- [`tui/src/history_cell/messages.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/history_cell/messages.rs)、
  [`exec.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/history_cell/exec.rs)、
  [`patches.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/history_cell/patches.rs)、
  [`mcp.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/history_cell/mcp.rs)：按事实类型拆分 renderer。
- [`tui/src/markdown_render.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/markdown_render.rs)：Markdown、链接和本地路径的结构化渲染。

### 2.5 默认层级与 disclosure

为了达到“简单好看”，每条 item 只在一个层级出现：

```text
L0 文档层       userMessage / agentMessage / 必要的最终叙述
L1 事实层       plan / command / file / tool / approval / child activity
L2 详情层       exact command、cwd、bounded output、diff hunk、source refs
L3 审计层       raw event、完整日志、provider metadata、冲突诊断
```

默认 feed 只展示 L0 + L1 的最小信息；L2 由同一行的 disclosure 控制打开，L3 只
在 run detail 或诊断入口可见。任何内容不能因为同时属于多个层级而复制一份。批次
只收起 L1 的相邻原子行，展开后必须恢复原子行，不得把 L2/L3 摘要重新写入正文。

### 2.6 Surface policy 与 transcript content 分离

三种会话不是三套内容协议，而是同一份 timeline 的三种外壳策略：

| Surface | 允许变化 | 不允许变化 |
| --- | --- | --- |
| 普通会话 | model picker、workspace header、mention 入口 | item kind、事实状态、行几何、批处理边界、完成判断 |
| 队友私聊 | teammate header、私聊权限、participant label | Markdown/代码、command/file/tool/approval renderer、恢复语义 |
| 频道 root/topic/branch | roster、topic controls、fan-in participant label | 同一 registry、同一 action identity、同一 disclosure、同一 scroll owner |

surface adapter 只能提供 `ConversationSurfacePolicy` 和回调。它不能把同一个
`commandExecution` 改成自己的 `workCell`、`activity` 或 `summary` 类型，也不能因为
频道是多 Agent 就再建一条渲染管线。子 Agent 只是父 timeline 内的 `depth=1` projection。

## 3. Durable history 与 session 边界

Ling 的历史结构保持：

```text
LingThread
  └─ LingTurn
       └─ ConversationItem（用户/Agent 可见的 canonical anchor）
            └─ Run / Attempt / ExecutionAction / Artifact / Approval / Span refs
```

每次 reload、SSE reconnect、daemon restart、retry 或 surface navigation 都从同一
组 canonical records 重建 projection。不要用“最近 8 条平铺消息”作为历史 authority；
那只能是一个已加载窗口。加载策略可以分页/虚拟化，但 cursor 必须是 durable
`threadSequence`，并能继续向前取旧 turns。任何窗口裁剪都必须在响应中携带
`beforeCursor`/`hasMore`，不能把“未加载”误报成“没有历史”。

`LingThread` 映射：

| 入口 | canonical thread | 备注 |
| --- | --- | --- |
| 普通会话 | `direct` root thread | 单 Agent 或普通 Ling Agent run |
| 队友私聊 | `direct` root thread | 固定一个 teammate，仍使用同一 transcript |
| 频道根 | `channel_root` | 多 Agent 协作的外层工作对象 |
| topic/branch | child thread | 明确 `parentThreadId`、anchor/fork lineage |
| 子 Agent | 不新建用户会话 | `ParticipantSpan` 挂在父 Run/Turn 下，timeline depth=1 |

频道的多 Agent 不是第三套 UI；它只是同一个 timeline 多了 participant span 和
fan-in policy。私聊保持一对一的路由/权限策略，但消息、事实行、代码、文件、审批
和恢复语义必须统一。

### 3.1 可恢复历史与选择性记忆

完整历史和模型本轮上下文是两个不同的投影：

```text
SQLite canonical history
  ├─ full replay / audit（可按 threadSequence 分页）
  └─ ContextPack(snapshotRevision, contextSegmentId)
       ├─ 最近 turns（保持原顺序）
       ├─ pinned facts / user decisions（带 sourceRefs）
       ├─ 相关旧 segment 的摘要 + anchor refs
       └─ 按需回查的原子 evidence
```

- SQLite 中的 `ConversationItem`、`RunEvent`、`ExecutionAction`、`Artifact`、
  `Approval` 和 `ParticipantSpan` 永不因 compaction 或摘要而删除；摘要只是可重建的
  read model，不能成为事实的唯一副本。
- `ContextPack` 必须带 `snapshotRevision`、`contextSegmentId` 和 source refs。模型
  可见的是选定上下文，不可见的历史仍可通过“查看上下文/加载更早内容”回查同一个
  canonical thread；回查结果不能改变已提交的 item 顺序。
- 选择性记忆的优先级固定为：用户明确 pin 的事实 > 当前 segment 最近 turns >
  有 source refs 的旧 segment 摘要 > 低置信相关检索。低置信检索只能作为提示，不能
  自动改变 thread、participant 或 action scope。
- `contextCompaction` 只记录快照边界和可恢复 cursor。恢复时先读取 canonical
  snapshot，再应用新 revision；客户端缓存、批次数量和模型自述都不能作为恢复依据。

这保证“聊久了不失忆”的定义是可验证的：历史可分页找回，关键事实可由 source refs
重新定位，模型每轮只接收选择性 `ContextPack`，而不是把最近 N 条消息误当成全部历史。

## 4. Typed item contract

下面的 union 是 framework-neutral 的 read model，不直接写入 SQLite：

```ts
type ConversationTimelineItemKind =
  | "userMessage"
  | "agentMessage"
  | "reasoning"
  | "plan"
  | "commandExecution"
  | "fileChange"
  | "exploration"
  | "mcpToolCall"
  | "dynamicToolCall"
  | "collabAgentToolCall"
  | "subAgentActivity"
  | "approval"
  | "imageView"
  | "contextCompaction"
  | "genericActivity"
  | "commandBatch"
  | "explorationBatch";

type ConversationTimelineItemStatus =
  | "pending"
  | "running"
  | "waiting"
  | "blocked"
  | "failed"
  | "cancelled"
  | "succeeded";

interface ConversationTimelineItemBase {
  readonly id: string;
  readonly kind: ConversationTimelineItemKind;
  readonly revision: number;          // numeric, monotonic, never a hash
  readonly threadSequence: number;   // canonical ordering spine
  readonly partIndex: number;        // projection-only tie breaker
  readonly depth: 0 | 1;              // 0 = surface timeline, 1 = child Agent timeline
  readonly turnId?: string;
  readonly itemId?: string;
  readonly status?: ConversationTimelineItemStatus;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
}

interface ConversationOperationLineage {
  readonly actionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly participantId: string;
  readonly workflowStepId: string | null;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
}
```

### 4.1 Typed payload 形状

`kind` 决定 renderer 能读取的字段；renderer 不允许从 `unknown` payload 猜类型。下面
的字段是最小可渲染契约，具体 API DTO 可以包含更多审计字段，但不能减少这些事实：

```ts
interface ConversationDocumentItem extends ConversationTimelineItemBase {
  readonly kind: "userMessage" | "agentMessage";
  readonly markdown: string;
  readonly attachments: readonly ConversationAttachmentRef[];
}

interface ConversationOperationFactItem extends ConversationTimelineItemBase, ConversationOperationLineage {
  readonly kind:
    | "commandExecution" | "fileChange" | "exploration"
    | "mcpToolCall" | "dynamicToolCall" | "collabAgentToolCall" | "approval"
    | "subAgentActivity";
  readonly title: string;                 // verb-oriented, localized at render time
  readonly detail?: ConversationFactDetail;
}

interface ConversationMetaFactItem extends ConversationTimelineItemBase {
  readonly kind: "reasoning" | "plan" | "imageView" | "contextCompaction" | "genericActivity";
  readonly title: string;
  readonly detail?: ConversationFactDetail;
  /**
   * Meta facts may be turn-level and have no action identity. If they describe a
   * participant or a blocked operation, the projector must attach a complete lineage;
   * the renderer may never invent one.
   */
  readonly lineage?: ConversationOperationLineage;
}

type ConversationFactItem = ConversationOperationFactItem | ConversationMetaFactItem;

interface ConversationBatchItem extends ConversationTimelineItemBase, ConversationOperationLineage {
  readonly kind: "commandBatch" | "explorationBatch";
  /**
   * Derived batch identity. It is not executable and must be prefixed with
   * `batch:`. `actionIds` contains the real ExecutionAction identities.
   */
  readonly actionId: string;
  readonly actionIds: readonly string[];  // ordered, unique, never inferred from count
  readonly children: readonly ConversationOperationFactItem[];
  readonly defaultExpanded: boolean;
}

type ConversationOperationSourceKind =
  | "conversationItem"
  | "runEvent"
  | "executionAction"
  | "artifact"
  | "approval"
  | "participantSpan"
  | "terminalReport";

interface ConversationOperationSourceRef {
  readonly kind: ConversationOperationSourceKind;
  readonly id: string;
  readonly label?: string;
  /** Only a Host-verified reference may activate a file, diff, or artifact. */
  readonly trusted?: boolean;
  /** Host event revision/sequence for audit; only present for run_event refs. */
  readonly eventRevision?: number;
  readonly eventSeq?: number;
}

interface ConversationAttachmentRef {
  readonly id: string;
  readonly kind: "file" | "image" | "video";
  readonly name: string;
  readonly trustedRef?: string;
}

type ConversationFactDetail =
  | { readonly type: "command"; readonly command: string; readonly cwd?: string; readonly outputTail?: string; readonly exitCode?: number; readonly outputTruncated?: boolean }
  | { readonly type: "file"; readonly path: string; readonly trustedFileRef?: string; readonly diffRef?: string; readonly additions?: number; readonly deletions?: number }
  | { readonly type: "tool"; readonly toolName: string; readonly redactedInput?: string; readonly redactedResult?: string }
  | { readonly type: "approval"; readonly decision?: "allowed" | "denied"; readonly reason?: string }
  | { readonly type: "diagnostic"; readonly message: string };

interface ConversationSurfacePolicy {
  readonly surface: "normal" | "private" | "channel_root" | "topic" | "branch" | "child";
  readonly showRoster: boolean;
  readonly showMentions: boolean;
  readonly showModelControls: boolean;
  readonly density: "default" | "dense";
}

interface ConversationTimelineCallbacks {
  onToggleDetail(id: string): void;
  onOpenTrustedFile(ref: string): void;
  onOpenTrustedDiff(ref: string): void;
  onRetry(actionId: string): void;
  onResolveApproval(approvalId: string, decision: "allow" | "deny"): void;
  onFocusSource(sourceRef: ConversationOperationSourceRef): void;
}
```

`ConversationSurfacePolicy` 只控制 shell chrome 和可见性，不得改变 item kind、状态、
排序或完成语义；`ConversationTimelineCallbacks` 只接收稳定 id/ref，不接收数组下标、
basename、翻译文案或 raw provider payload。这样三个 surface 与 depth-1 子 Agent 能共用
同一组件而不产生隐含的第二状态存储。

约束：

1. `id` 是 renderer/DOM identity；`actionId` 是执行事实 identity；二者可以不同，但
   同一 action 在 start/update/end 期间必须保持同一 `actionId` 和 `id`。
2. `revision` 只递增，不把 hash、时间戳或 SSE 到达次数当作 revision。
3. `sourceRefs` 只引用 Host 已验证的记录；模型给出的 URL/path 只能作为普通文本。
4. `children` 是 projection 的只读快照，不能被 UI 改写，也不能参与 completion。

稳定 id 规则固定为：原子 action 使用 `action:{actionId}`；文档 item 使用
`item:{conversationItemId}`；derived batch 使用 `batch:{scope}:{runId}:{firstActionId}`。
`revision` 变化只能更新同一 id 的 payload，不能因为 status、output 或 surface 改变而
创建第二个 row。React key、disclosure state 和 SSE merge 都必须使用这些稳定 id。

每个 operation row 和每个 derived batch 必须携带完整 lineage：
`actionId`、`runId`、`attemptId`、`participantId`、`workflowStepId`、`sourceRefs`。
缺 lineage 时不能从时间戳、数组下标、翻译后的标题或模型文本猜；anchor 有效但
lineage 损坏时展示 blocked diagnostic，anchor 缺失/跨 thread 时只进 redacted
diagnostic/detail，不伪造位置。

### 4.2 Codex item 到 Ling item

| Codex 概念 | Ling item | 事实来源 | 默认显示 |
| --- | --- | --- | --- |
| `userMessage` | `userMessage` | `ConversationItem` | 文档流 |
| `message` | `agentMessage` | committed assistant item | 文档流 |
| `reasoning` | `reasoning` | explicit safe summary | 静音事实行 |
| `plan` | `plan` | typed plan/workflow projection | checklist 行 |
| `commandExecution` | `commandExecution` | `ExecutionAction` + folded events | terminal 行 |
| `fileChange` | `fileChange` | action + artifact/diff refs | file/diff 行 |
| read/search | `exploration` | read/search evidence | search 行 |
| MCP call | `mcpToolCall` | MCP tool evidence | tool 行 |
| dynamic tool | `dynamicToolCall` | Host tool evidence | tool 行 |
| collaboration call | `collabAgentToolCall` | delegate/steer evidence | participant 行 |
| agent span | `subAgentActivity` | `ParticipantSpan` | depth-1 timeline |
| image preview | `imageView` | artifact/media record | image 行 |
| compaction | `contextCompaction` | context snapshot | continuity marker |

`genericActivity` 是唯一 fallback，文案固定为 `Activity unavailable` / `活动不可用`，
状态必须是 blocked 或 diagnostic；不得把未知 payload `JSON.stringify` 到正文。

Renderer 层统一使用 camelCase kind（`commandBatch`、`explorationBatch`）。当前
`ConversationWorkCellItem` 中的 `command_batch`、`exploration_batch` 只允许在一次性
migration adapter 中读取，进入 `ConversationTimeline` 前必须归一化，不能让两种
spelling 同时成为 production contract。

### 4.3 Canonical snapshot 与 SSE delta

UI 接收的是 daemon 组装后的 canonical snapshot；SSE 只提供可合并的增量，不是排序
权威：

```ts
interface CanonicalConversationSnapshot {
  readonly threadId: string;
  readonly snapshotRevision: number;
  readonly threadSequenceWatermark: number;
  readonly turns: readonly ConversationItemSnapshot[];
  readonly actions: readonly ExecutionActionSnapshot[];
  readonly artifacts: readonly ArtifactSnapshot[];
  readonly approvals: readonly ApprovalSnapshot[];
  readonly participantSpans: readonly ParticipantSpanSnapshot[];
}

interface CanonicalConversationDelta {
  readonly entity: "turn" | "item" | "action" | "artifact" | "approval" | "participantSpan";
  readonly entityId: string;
  readonly revision: number;
  readonly patch: unknown;
}
```

`mergeCanonicalTranscriptInputs` 必须满足幂等性、单调 revision 和交换收敛：重复 delta
不改变输出，旧 delta 不覆盖新状态，输入顺序改变不会改变 projection。损坏的 delta
只产生可见 diagnostic，不得丢弃整个 thread，也不得由 React 侧以 `updatedAt` 或
到达顺序补排序。`tool_start`、每次 `tool_update` 和 `tool_end` 的真实 `run_event.id`
必须写入同一个 action 的 `sourceRefs`；这样 UI 的一个 `actionId` 可以反查完整事件链，
而不是只能反查最后一个聚合 DTO。

`patch` 在进入 core 前必须通过按 `entity` 分派的 contract validator。validator 可以
把未知字段保留在审计层，但不得把 `unknown` payload 直接交给 renderer；无法验证的
delta 生成 `genericActivity(blocked)`，并保留冲突双方的 source refs。

### 4.4 现有执行模型到目标模型的迁移

目标 lineage 是 UI 事实契约；它不等于当前 `ExecutionAction` DTO 已经具备所有字段。
实现必须先在 daemon/core 做明确映射：

| 目标字段 | 当前常见来源 | 缺失时的处理 |
| --- | --- | --- |
| `actionId` | `ExecutionAction.id` / `toolCallId` | 不能用数组 index；缺失则 blocked diagnostic |
| `runId` | `ExecutionAction.runId`、RunSession | 不跨 run 猜测；缺失则不进主 feed |
| `attemptId` | run attempt lineage | 旧数据没有时进入 audit，不能参与 retry 主投影 |
| `participantId` | `workUnitId` / ParticipantSpan | 由 daemon 关联；React 不按 teammate 名称猜测 |
| `workflowStepId` | workflow step relation | 无关系时保留 `null`，不能用标题代替 |
| `sourceRefs` | RunEvent、ExecutionAction、Artifact、Approval | 每个 visible fact 至少有一个 Host source ref |
| `revision` | action/event fold revision | 不使用时间戳、hash 或 SSE 到达次数 |

因此 R1/R2 的第一项不是“在 JSX 加字段”，而是验证这些字段能否从现有持久化记录
稳定推导；若不能，补的是 daemon/contract adapter，而不是 UI 临时拼接。

## 5. Ordering、attempt 与 ownership

### 5.1 唯一排序主轴

```text
ConversationItem.sequence  -> threadSequence
多个事实挂同一 anchor    -> partIndex
相同 cursor               -> stable id（仅最后的 deterministic tie-break）
```

禁止使用 wall-clock timestamp、SSE arrival order 或 React array index 决定顺序。
同一 snapshot 换输入顺序必须得到 byte-equivalent projection；replay 旧 delta 必须不
改变输出。

### 5.2 最新 attempt 主投影

普通主 feed 对每个 `(turnId, participantId)` 只显示最新 committed attempt。旧的
retry/resume/repair/validation attempt 保留在 audit/detail，并且不能与最新 attempt
批处理。attempt 选择必须由 durable run lineage 决定，而不是“最后抵达的事件”。

### 5.3 owner arbitration

每个 action、approval、artifact、terminal report 只能被一个可见 block 拥有：

```text
candidate facts
  -> validate thread/turn/anchor
  -> resolve owning run/participant
  -> claim one owner
  -> duplicate owner => diagnostic, no second visible fact
```

这解决“已编辑文件后又出现一块总结”“TerminalReport 与 WorkCell 重复”“审批在
Composer 和 feed 同时出现”等问题。CSS 隐藏不是去重方案。

### 5.4 Context segment 的权威边界

`contextSegmentId` 是上下文投影/运行快照的字段，不是 activity item 或 batch 的字段。
它描述“这一轮模型看到的上下文窗口属于哪个连续片段”，不描述“UI 把哪几行折叠
在一起”。因此：

1. 默认沿用当前 thread segment；普通词汇漂移不能自动创建新 thread 或改变历史语义。
2. context projector/host 可以根据 durable anchor、显式 compaction 和用户选择生成
   `suggestedContextSegmentId`，但模型只能建议，不能直接写入 canonical context。
3. 用户明确选择“新话题/分支/从这里继续”时，Host 创建 child thread 或新的 segment，
   写入 parent/anchor/fork lineage；这和 batch、participant span 完全独立。
4. `contextCompaction` 只标记快照边界和可恢复范围，不得把旧消息物理删除，也不得让
   renderer 把 compaction 当作 completion summary。

```text
message/action projection ──┐
                            ├─ context snapshot (contextSegmentId)
UI batching ────────────────┘        ↑
                                     │
                       user/host authority only
                       model = suggestion, never writer
```

## 6. Action lifecycle、revision 和 evidence fold

一个 action 的事件生命周期：

```text
未见 action + tool_start  -> id=action:{actionId}, revision=r, running
tool_update               -> 同 id、revision=r+1，替换可变 payload
tool_end                  -> 同 id、revision=r+2，terminal
旧/重复 revision           -> 可见投影不变，写 diagnostic
terminal 后迟到事件        -> 忽略，不得 reopen
equal revision payload 冲突 -> fail closed，source_conflict
```

状态机：

```text
pending -> running -> succeeded
                  ├-> failed
                  ├-> cancelled
                  ├-> blocked
                  └-> waiting -> running | blocked
```

`eventSeq` 只排序 action 内部 output chunks；numeric `revision` 才用于 stale-update
拒绝。`revisionKey` 可以作为 memo/detail invalidation key，但不能作为顺序 authority。
`tool_update` 必须触发 live evidence/revision invalidation，防止 UI 继续显示旧输出。

当前 `RunEventType` 没有独立的 `blocked` 事件类型时，不要为了 UI 新增平行事件协议。
结构化 blocked 结果应由现有 `tool_end`/participant outcome 的 validated payload 归一化
为 `status="blocked"`，并携带 `blockerCode`、`blockerMessage` 与完整 lineage；只有在
contract review 明确批准后才可增加新的持久化事件类型。

只有 Host terminal result 或结构化 `blocked` evidence 才能满足完成条件。模型文本
`ready`、`started`、`I will execute`、`done` 都不能满足 completion/fan-in。

### 6.1 Delegated action 的结构化结果

orchestrator 对每个 delegated action 只接受两种可结算结果：

```ts
type DelegatedOutcome =
  | {
      readonly outcome: "succeeded";
      readonly actionId: string;
      readonly runId: string;
      readonly attemptId: string;
      readonly participantId: string;
      readonly workflowStepId: string;
      readonly evidenceRefs: readonly ConversationOperationSourceRef[];
    }
  | {
      readonly outcome: "blocked";
      readonly actionId: string;
      readonly runId: string;
      readonly attemptId: string;
      readonly participantId: string;
      readonly workflowStepId: string;
      readonly blockerCode: string;
      readonly blockerMessage: string;
      readonly evidenceRefs: readonly ConversationOperationSourceRef[];
    };
```

只有 `agentMessage`/`ready` 而没有上述结构化结果时，orchestrator 必须把 participant
保持为 `waiting`，超过超时窗口则转成 `blocked` 并说明缺少 evidence。UI 可以显示子
Agent 的叙述，但不能显示 `succeeded`、给 fan-in credit 或生成最终完成总结。

## 7. Canonical projector

纯函数调用图固定为：

```text
snapshot + SSE delta
      │
      ▼
merge by durable id + numeric revision
      │
      ▼
scope/anchor validation
      │
      ▼
latest attempt + owner arbitration
      │
      ▼
child placement + canonical sort
      │
      ▼
atomic ConversationTimelineItem[]
      │
      ▼
display-only batching（只调用一次）
      │
      ▼
ConversationTimeline
```

建议 API（名称可调整，但职责不能合并）：

```ts
mergeCanonicalTranscriptInputs(current, incoming)
projectCanonicalConversationTimeline(input): readonly ConversationTimelineItem[] // atomic only
batchCanonicalTranscriptItems(items): readonly ConversationTimelineItem[] // display wrapper
```

生产 canonical projector 只接受 canonical snapshot；不接受 page-local message array、
翻译文案、raw SSE payload 或 `ConversationWorkCellRow`，并且**永远不在函数内部 batching**。
调用方必须显式执行一次 `batchCanonicalTranscriptItems`，再把结果交给 Timeline。旧
WorkCell 只能作为迁移测试 adapter，在所有 production caller 切完后删除。

投影顺序：

1. 校验 workspace/thread/surface scope。
2. 将每个事实 join 到 canonical `threadSequence` 和 anchor item。
3. 选择最新 committed attempt。
4. 执行 owner arbitration。
5. 将 child participant span 放在父 anchor 下，递归投影但最大深度为 1。
6. 以 `sequence, partIndex, stable id` 排序。
7. canonical projector 返回 atomic items；最后由 display projector 一次性应用可逆
   command/exploration batch。任何 completion、fan-in、TerminalReport、context 选择
   都在这一步之前读取 atomic items。

Projector 必须 total：单条损坏事实不能丢掉整条会话。输出 valid typed item 或 visible
blocked diagnostic；无 anchor 的事实进入 detail/audit，不用 synthetic sequence 补位。

## 8. Batching 规则

batch 是可逆的显示 wrapper，不是事实，不是 completion oracle。无需新增 SQLite 表，
也不写回 `conversation_items`。

`commandBatch` 和 `explorationBatch` 只能合并相邻 atomic children，且必须完全相同：

```text
thread + turn + run + attempt + participant + workflowStep
```

并且不能跨越：

- agent、run、attempt、retry/resume/repair/validation role；
- workflow step、approval boundary、失败/取消/超时/blocked action；
- file mutation、deploy、credential、network send 等 consequential action；
- active action 或缺少稳定 action identity/source refs 的 row。

`commandBatch` 只接受低风险、已结束的命令；`explorationBatch` 只接受相邻成功的
read/grep/find/ls。默认至少 3 个 child 才折叠成 batch；1–2 个保持 atomic row。展开
必须按原顺序恢复每个 child 和其 lineage。

batch id 示例：

```text
batch:command:{participantScope}:{runId}:{firstActionId}
batch:exploration:{participantScope}:{runId}:{firstActionId}
```

batch 的 `actionId` 是上述 `batch:` 前缀的派生 identity；`actionIds`、`sourceRefs`、
`revision` 是 child projection 的派生值，且 batch 的 source refs 必须包含全部 child
`run_event` refs。TerminalReport、
fan-in、上下文选择都不能读取 batch 数量或 batch status。

## 9. Completion、fan-in 和审批

### 9.1 Delegated execution

orchestrator 不能因为 Agent 返回“ready/我会执行”就结束 delegated action。每个 required
participant 必须：

```text
terminal atomic evidence
      OR
structured blocked evidence(participant/run/attempt/step/blocker/sourceRefs)
```

缺 evidence 时 parent 仍是 waiting/blocked；UI 可以展示 Agent 的 narration，但不能显示
成功。

### 9.2 Multi-agent fan-in

```text
required participant set
       │
       ├─ terminal evidence      -> credit
       ├─ structured blocked     -> blocked outcome
       └─ no/partial evidence    -> parent remains waiting
```

fan-in 读取原子 evidence，不读取 batch count、plan checkmark、child narration 或
TerminalReport prose。participant、run、attempt、workflow step 必须一致。

### 9.3 Approval

pending approval 只有一个 live control（当前产品选 shared blocking dialog；如实现分支
仍采用 Composer-owned gate，必须先更新 surface contract，不能两个同时存在）。resolved
decision 只生成一个 immutable historical `approval` item。审批等待期间 operation row
显示 non-interactive marker，不在 feed 重复挂第二套按钮。

## 10. Shared renderer 和视觉边界

只有两个基础视觉 primitive：

```text
TimelineDocumentItem  = userMessage / agentMessage / structured Markdown
TimelineFactRow       = 所有 Host evidence、plan、approval、batch、diagnostic
```

统一布局：

```text
ConversationSurfaceShell（surface policy chrome）
├─ Header（可选：roster/topic/teammate/model/mentions）
├─ ConversationFeed（唯一 page-level vertical scroll owner）
│  └─ ConversationTimeline(depth=0)
│     ├─ DocumentFlow：userMessage / agentMessage
│     ├─ FactRail：plan、command、file、tool、approval、image、compaction
│     └─ subAgentActivity
│        └─ ConversationTimeline(depth=1，同一 registry）
├─ EnvironmentPopover（仅 active run）
└─ Composer（输入、附件、pending decision）
```

普通文本不能渲染成方形消息卡；事实行也不能变成右侧第二列表。长内容只在 row
自己的 bounded detail 内滚动。具体颜色、icon、间距、代码和 path 规则见视觉规范。

### 10.1 目标输出样例

这些样例是组件验收的文字版快照。实际 UI 可以使用中文或英文，但层级和信息量必须
保持一致：

```text
用户：把 parser.ts 的空行问题修好，并运行测试

Ling：我先检查现有格式化规则，然后修改并验证。

⌕ 读取 parser.ts                              完成   ›
▣ 编辑 parser.ts  +6 -2                       完成   ›
▣ 运行 pnpm test                               完成   ›
   └─ 展开：命令、cwd、exit 0、耗时、最多 5 行输出

Ling：已修复空行处理，测试通过。
```

禁止的输出是：

```text
我已经完成了
[WorkCell: Edited parser.ts]
[TerminalReport: tests passed]
[Composer 下方再来一块总结]
```

后者把同一事实交给了三个 owner，正是旧界面出现“文件后重复总结、输入框下再重复”
的根因。

多 Agent 只在父事实行下增加 participant rail，不能改变外层几何：

```text
↗ 协作 2 位 Agent                              进行中 ›
  ├─ Engineer · 编辑 parser.ts                 完成 ›
  │   └─ 运行 pnpm test                        完成 ›
  └─ QA       · 检查回归                       等待 ›
```

`ready`、`我会执行` 或 `已开始` 等 narration 可以显示，但只要没有 terminal evidence，
父行必须保持 `进行中/等待/阻塞`，不能显示成功。

## 11. Nested sub-agent

`subAgentActivity` 不是私聊，不是频道卡，也不是另一套 transcript。它只增加：

1. participant label/avatar；
2. 一条 1px nesting rail；
3. 同一个 `ConversationTimeline(depth=1)`。

子 Agent 可以产生自己的 `agentMessage` 叙述、reasoning summary、plan、command/file/tool
fact 和最终 narration；但默认只展示有用户价值的内容，隐藏 prompt、raw provider
metadata 和内部 chatter。最大 depth=1；更深 lineage 进 detail/audit，避免 UI 套娃。

## 12. EnvironmentPopover

EnvironmentPopover 是 active run 的 ambient 状态，不是历史日志：

```text
[spinner] Working · Engineer editing parser.ts
           ling-stack · codex/typed-transcript-v2 · write policy
```

最多两行、去重 source icons、随 active run 原地更新，run settled 后消失。它不能重复
final answer、TerminalReport、command output、memory footer；点击 source 只 focus 对应
timeline row。

## 13. ContextSegmentId 与 selective memory

`contextSegmentId` 由 context projection / run snapshot 决定：

```text
canonical history -> context selector -> ContextPack(snapshot, contextSegmentId)
                                           │
                                           └─ model input only
```

它不是用户活动 batch 的身份，也不是 renderer 依据。自动换话题采用三层策略：

1. 用户显式创建 topic/branch：强制新 segment/thread。
2. 规则判断高置信切题（标题、实体、时间间隔、显式“换个话题”）：建议新 segment，
   但不移动已持久化事实。
3. 模型判断：只能提供低权限 suggestion，不能直接改写 history 或 action scope。

没有足够证据时继续当前 segment；上下文选择可回溯旧 segment，不能因 UI batch 改变
语义。`contextSegmentId` 缺失时使用 canonical thread/turn scope，不用 batch id 补齐。

## 14. 恢复与一致性

```text
snapshot(cursor)
  -> merge newer revisions
  -> project
  -> preserve disclosure/focus by stable id
```

必须满足：

- reconnect/restart 后 item id、顺序、status 与 canonical snapshot 一致；
- lower revision 被忽略；equal revision payload conflict fail-closed；
- terminal action 不被迟到 provider event reopen；
- batch id 在 segment 增长时保持不变，disclosure state 不丢；
- active action 不会被错误塞进 completed batch；
- context refresh 与 activity evidence refresh 独立 invalidation；
- stale hydration 不能覆盖更新的 output/diff/media。

恢复的 UI 只保存稳定 id 的 disclosure/focus，不保存数组索引、翻译文案或 batch 位置。
reload、SSE reconnect、daemon restart 的第一帧可以短暂显示 `waiting`，收到 canonical
snapshot 后必须收敛到同一 status/revision；不能凭客户端缓存直接显示成功。

## 15. 验收不变量

```text
同一 snapshot + 不同输入顺序          => 相同 projection
同一 action + update                   => 相同 id、更高 revision
terminal action + late event            => terminal 保持不变
缺 anchor/lineage                       => diagnostic，不猜位置
required child 无 terminal evidence     => parent 不得 succeeded
batch 展开                              => 恢复所有 atomic child
三种 surface 同 fixture                 => 相同 kind/id/order/renderer
```

如果实现需要新增第二 timeline、route-specific renderer、batch completion shortcut、
按文案分类、跨 scope batching 或无 trusted ref 的本地文件跳转，必须先修改本设计，
不能用局部 workaround 绕过。

## 16. Definition of done

```text
durable fact
  -> typed projection
  -> one shared renderer
  -> in-place revision
  -> replayable UI
```

设计本身没有未决架构决策；实现、回归和 packaged macOS 证据尚未完成，全部由下一份
implementation plan 负责。

## 17. 实现入口与迁移顺序

当前仓库仍有 `ConversationWorkCell`、route-local activity summary 和旧 selector。
它们是迁移输入，不是新协议的一部分。实现按下面的依赖顺序进行：

```text
contracts / fixtures
        ↓
daemon evidence fold + revision
        ↓
conversation-ui-core projector + batching
        ↓
shared ConversationTimeline + renderer registry
        ↓
normal / private / channel / child surface cutover
        ↓
reconnect/restart/fan-in + packaged macOS evidence
```

每一步都必须先有 focused test，再切换下游 caller。迁移完成的硬指标是：

- 生产代码中不再直接渲染 `ConversationWorkCell`；
- 不再存在 route-local renderer map、summary owner 或第二个 activity scroll owner；
- 所有三种 surface 的 fixture 产生相同 kind/id/order/status；
- 旧 SQLite `LingThread → LingTurn → ConversationItem` 历史仍可由 projector 回放；
- 没有为了兼容未发布客户端而保留旧 renderer 或旧 selector。
