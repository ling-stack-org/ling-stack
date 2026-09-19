# Conversation Codex-Parity Visual Specification

Status: normative renderer and interaction specification
Date: 2026-08-30
Owner: conversation UI maintainers
Related: [Ling Typed Transcript Detailed Design](conversation-typed-transcript-detailed-design.md)

本规范是视觉层的唯一入口。旧的 WorkCell、OperationCell、TerminalReport summary
样式只能作为历史截图参考；新实现必须使用本规范的 `ConversationTimeline` 和
`TimelineFactRow`，不能通过 CSS 隐藏旧 renderer 来达到“看起来统一”。

这份文档只规定“怎么显示”，不改变 Thread/Turn/Item、Run、Attempt、ExecutionAction
或 TerminalReport 的事实权威。目标不是像素复制 Codex，而是借鉴它的 typed item、专用
renderer、active cell 原地更新和 bounded disclosure，让 Ling 的多 Agent 仍然简单好看。

## 1. 视觉总结构

```text
ConversationSurfaceShell
├─ SurfaceHeader（surface policy chrome）
├─ ConversationFeed（唯一纵向滚动容器）
│  └─ ConversationTimeline
│     ├─ DocumentFlow
│     │  ├─ UserMessageRenderer
│     │  └─ AgentMessageRenderer
│     └─ ActivityRail
│        ├─ ReasoningRenderer / PlanRenderer
│        ├─ CommandRenderer / CommandBatchRenderer
│        ├─ ExplorationRenderer / ExplorationBatchRenderer
│        ├─ FileChangeRenderer
│        ├─ ToolRenderer（MCP / dynamic / collaboration）
│        ├─ ApprovalRenderer
│        ├─ ImageRenderer / ContextCompactionRenderer
│        └─ GenericBlockedRenderer
│           └─ SubAgentRenderer -> ConversationTimeline(depth=1)
├─ EnvironmentPopover（active run only）
└─ Composer
```

普通会话、队友私聊、频道 root/topic/branch 和 depth=1 子 Agent 共享上述组件。频道
可以增加 roster、mention、topic controls；私聊可以增加 teammate header；普通会话
可以增加 model controls。它们不能改变 item kind、renderer、状态文本、行几何或 scroll
ownership。

实现边界：

```ts
interface ConversationTimelineProps {
  readonly items: readonly ConversationTimelineItem[];
  readonly policy: ConversationSurfacePolicy;
  readonly depth: 0 | 1;
  readonly callbacks: ConversationTimelineCallbacks;
}
```

`ConversationTimeline` 只接收已经投影的 typed items；不得接收 raw SQLite、raw SSE、
page-local message array 或翻译后的标签。registry 必须对 `kind` exhaustive；缺少已知
renderer 直接 typecheck 失败，只有 `genericActivity` 可作为 blocked fallback。

每个事实行必须暴露可测试的语义属性：

```text
data-conversation-timeline="true"
data-conversation-timeline-kind
data-conversation-timeline-id
data-conversation-timeline-revision
data-conversation-timeline-status
data-conversation-timeline-depth
data-conversation-action-id / data-conversation-run-id
data-conversation-attempt-id / data-conversation-participant-id
data-conversation-workflow-step-id
```

这些属性来自 typed item 本身，不构成第二状态存储，也不能使用 array index。

## 1.1 Codex 风格的四条视觉纪律

1. 叙述像文档，事实像行，不把所有内容包成卡片。
2. 一个正在运行的 action 只有一行，更新原地发生，完成后仍是同一行。
3. 默认层只说“做了什么/现在什么状态”，精确命令、输出、路径和 diff 放在同一行
   的详情里。
4. 降噪只能折叠可恢复的原子事实，不能删除事实、改变顺序或改变完成判断。

因此，视觉验收不以“卡片数量少”为目标，而以“同一事实只出现一次、用户能在一眼
内理解状态、展开后能找回证据”为目标。

## 2. 两条视觉 lane

### DocumentFlow

`userMessage` 和 `agentMessage` 是透明文档流：段落之间留自然间距，列表保留列表
边界，代码围栏渲染为真正的 code block，链接和本地文件引用保持 inline 结构。没有
永久 card、shadow、彩色大背景或右侧操作栏。

### ActivityRail

事实行统一使用一个 `TimelineFactRow`：

```text
[16px semantic icon]  Verb-oriented action title          Status  [chevron]
                       optional metadata
                       expanded: bounded evidence detail
```

状态必须同时有 icon 和文字：`Working`、`Waiting`、`Completed`、`Failed`、`Cancelled`、
`Blocked`。颜色只做辅助，不能成为唯一状态信息。

### 2.1 Shared geometry tokens

实现先使用语义 token，避免每个 surface 产生一套“看起来差不多”的 CSS：

| token | 默认值 | 用途 |
| --- | --- | --- |
| `--conversation-feed-gutter` | `16px` | feed 左右内边距 |
| `--conversation-row-gap` | `8px` | 相邻事实行间距 |
| `--conversation-fact-icon` | `16px` | depth=0 icon |
| `--conversation-nested-icon` | `14px` | depth=1 icon |
| `--conversation-nested-rail` | `1px` | 子 Agent 唯一额外装饰 |
| `--conversation-detail-max-height` | `240px` | row detail bounded scroll |
| `--conversation-activity-max-height` | `min(360px, 50vh)` | 密集 activity 区域 |
| `--conversation-code-line-height` | `1.55` | code block |
| `--conversation-log-line-height` | `1.45` | command output |
| `--conversation-radius` | `8px` | detail/preview，不给普通 row 加卡片感 |

文字使用已有 Ling 字体 token；不要通过固定宽度、负 letter-spacing 或强制 nowrap
“修好”长中文/英文。状态、icon、title 和 detail 必须在窄窗口都能自然换行。

### 2.2 三层信息密度

```text
默认 feed（L0/L1）  标题 + icon + 状态 + 一行元数据
行内详情（L2）      exact command、cwd、bounded output、diff hunk、source refs
审计入口（L3）       完整日志、raw event、provider metadata、冲突诊断
```

L0/L1 不显示 workflow id、run id、JSON、绝对路径或重复的最终总结。L2 使用同一
事实行的 disclosure，不创建右侧第二个日志面板；L3 可以在 run detail/诊断页打开。

## 3. Item 到 renderer 映射

| kind | icon | compact title | detail |
| --- | --- | --- | --- |
| `userMessage` | 无 | 文档正文 | Markdown、附件、file refs |
| `agentMessage` | 无 | 文档正文 | Markdown、代码、链接、路径 |
| `reasoning` | muted spark | 安全摘要 | 仅显式 summary |
| `plan` | checklist | `Plan · 2/4 complete` | steps/current step |
| `commandExecution` | terminal | `Run/Ran <command>` | exact command、cwd、tail、exit、duration |
| `fileChange` | file/pencil | `Edited <basename>` | stats、trusted diff |
| `exploration` | search | `Read/Search <target>` | targets、bounded result |
| `mcpToolCall` | plug | server/tool | redacted input/result |
| `dynamicToolCall` | bolt | tool label | Host result |
| `collabAgentToolCall` | people/arrow | participant action | delegation/steer status |
| `approval` | shield | action + waiting/allowed/denied | decision evidence |
| `subAgentActivity` | participant | participant + lifecycle | same registry at depth 1 |
| `imageView` | image | caption/basename | bounded preview |
| `contextCompaction` | layers | `Context compacted` | snapshot/range |
| `genericActivity` | alert | `Activity unavailable` | redacted diagnostic only |
| `commandBatch` | terminal stack | `Ran N commands` | exact children |
| `explorationBatch` | search stack | `Read N items` | exact children |

## 4. 内容 renderer 规则

### Markdown、纯文本和代码

- 使用安全 Markdown AST，而不是 `textContent` 拼接。
- 段落、空行、list、blockquote、fence 必须保持结构；不得把多条消息 flatten 成一行。
- 代码块显示 language label、copy button；默认等宽字体，保留 indentation 和换行。
- 流式未闭合 fence 可先用 plain monospace，block close/turn commit 后再异步高亮。
- 高亮失败回退为 plain monospace，不能丢内容。
- 超过 300 行或 24KB 的代码使用 bounded detail，不阻塞整条 feed。

### Command execution

- Compact 行必须出现真实命令摘要和动作状态，例如 `运行 pnpm test · Working`，
  不能只写“执行中”。
- 展开显示 exact command、cwd、stdout/stderr 的原始换行、exit code、duration、
  truncation 标记和 trusted artifact refs。详情入口还必须能定位到该 action 的
  `tool_start`、`tool_update`、`tool_end` `run_event.id`，但这些审计 id 不进入首屏。
- 成功输出默认最多 5 行/800 字符；失败最多 12 行/1600 字符并优先 error tail；
  full output 通过同一 row 的 raw/detail action 打开。
- stdout chunk 更新原地 row，不创建新 chat bubble。

### File、path 和 diff

- 默认 `[file icon] parser.ts`，展示 basename，不让长绝对路径破坏布局。
- hover/focus 显示完整路径；可复制，但只有 trusted Host file ref 才能 activate。
- 点击调用 `Host.openTrustedFile(fileRef)` 或 `Host.openTrustedDiff(diffRef)`；未经
  验证的 `file://`、任意 URL 和模型拼出的 path 不可导航。
- fileChange 展示 `+18 -4` 等 stats；展开后是结构化 path + hunk + gutter diff。
- malformed diff 保留安全文本和 diagnostic，不假装成功或 silently disappear。

### Tool、approval 和 diagnostic

- MCP/dynamic/collaboration row 显示 tool/server/participant 和状态，展开才显示经过
  redaction 的 input/result 与 source refs；source refs 缺失时显示 `Blocked`，不能
  用模型 narration 补一条“完成”。
- pending approval 只有一个 live control；resolved approval 变为一个 immutable history
  row。禁止 feed、Composer、right dock 同时出现三份操作按钮。
- blocked/failed row 要显示用户下一步：retry、repair、查看 detail 或无法继续；raw
  stack/JSON 进入 detail，不污染首屏。

## 5. Batches、nested agent 和环境浮窗

### Batches

completed batch 默认折叠，展开恢复 exact atomic children；running/waiting/failed/
blocked 不隐藏关键证据。Batch 只做视觉降噪，不改变 completion、fan-in、TerminalReport
或 context semantics。

### Nested agent

子 Agent 复用同一个 `ConversationTimeline`，只增加 participant label 和一条 1px rail：

```text
Engineer  ─┐
            ├─ agentMessage（文档流）
            ├─ commandExecution（事实行）
            └─ fileChange（事实行）
QA        ─┘
```

最多嵌套一层；不要为每个子 Agent 做独立聊天气泡、独立 WorkCell 或独立 renderer map。

### EnvironmentPopover

- 只显示 active run 的 ambient 状态，最多两行。
- 示例：`Working · Engineer editing parser.ts` / `ling-stack · feature/transcript`。
- active revision 原地更新，run settled 后消失。
- 不重复 final answer、TerminalReport、summary、command output 或 memory footer。
- source icon 点击 focus owning timeline row；不能打开第二个历史日志面板。

## 6. 密度、滚动和可访问性

| 项 | 规则 |
| --- | --- |
| fact row hit target | ≥28px |
| nested icon | 14px + 1px rail |
| detail max height | 240px，超出只在 row 内滚动 |
| activity region | 10 行后 `min(360px, 50vh)` |
| command tail | ≤64 chunks、40 lines、8KiB inline |
| feed | 一个 vertical scroll owner，`scrollLeft=0` |
| active animation | 只有 active row；completed 后停止 |
| reduced motion | 去掉 shimmer/smooth transition，保留 status/focus |

键盘：真实 button + `aria-expanded`；Enter/Space 展开；Escape 收起；focus 返回触发
元素。live region 只播报 approval/blocked/failed/completed 等用户可行动变化，不播报
每个 token 或 stdout chunk。所有 hover action 都必须有 keyboard/focus 等价路径。

## 7. 反模式（必须拒绝）

- 普通 Agent 文本外再包一个方形 WorkCell。
- 在 Composer 下追加一块“总结”，或在 fileChange 后再次重复同一完成文本。
- 把 command stdout 的每个 chunk 渲染成独立消息。
- 用翻译后的 `已读取`、`read_only` 或数组 index 做分类/React key。
- 频道、私聊、普通会话各自维护不同 renderer。
- 通过 CSS 隐藏第二个 owner，而不是在 projector 做 owner arbitration。
- 未有 Host evidence 就显示 `Completed` 或 `ready`。

## 7.1 典型状态快照

```text
普通回答
  Ling：这是一个普通文本答案，保留段落、列表和代码块。

命令执行
  ▣ 运行 pnpm test                         进行中  ›
    展开后：cwd · stdout tail · stderr tail · exit · duration

多 Agent
  ↗ 协作 2 位 Agent                      进行中  ›
    ├─ Engineer · 编辑 parser.ts          完成  ›
    └─ QA       · 等待测试证据             等待  ›

失败
  ! 运行 pnpm test                         失败  ›  重试
    展开后：exit 1 · error tail · 可重试原因
```

同一 turn 不能再在 Composer 下追加一块 summary，也不能在 fileChange 后追加第二个
TerminalReport 卡片。最终叙述只由 `agentMessage` owner 输出，事实行只由对应
`ExecutionAction`/`Artifact`/`Approval` owner 输出。

## 8. Visual acceptance

同一 fixture 在 normal/private/channel/topic/branch/child 必须保持：

```text
same kind + same id + same order + same status + same renderer + same detail limits
```

允许差异只有 surface chrome、participant label、mention/roster、model selector 和
policy-controlled visibility。视觉回归至少覆盖 plain answer、streaming、command、file
diff、approval、failure、retry、serial/parallel child、long code、malformed diff、
reduced motion、中文/英文长文案。

验收还必须记录以下语义快照，而不只是截图：

- 每个 row 的 `kind/id/revision/status/depth`；
- operation/batch 的 `actionId/runId/attemptId/participantId/workflowStepId/sourceRefs`；
- 展开前后 atomic child 数量和顺序完全一致；
- normal/private/channel/topic/branch/child 在同一 fixture 上的 renderer 名称相同；
- feed 只有一个纵向 scroll owner，Composer 不承载 transcript summary。
