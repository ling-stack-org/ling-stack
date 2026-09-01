# Conversation Codex-Parity Visual Specification

Status: normative visual contract v3.9.1-final（extends v3.9）；implementation-ready（截图必须附 semantic/lineage 证据）
Date: 2026-09-01
Base: `origin/main` @ `63ab7c0e`
Related: [Conversation Typed Transcript — Detailed Design](conversation-typed-transcript-detailed-design.md)
Component implementation: [Conversation Codex-Parity Component Detailed Design](conversation-codex-parity-component-detailed-design.md)

Cross-surface ownership and implementation sequencing are defined in
[Conversation Surface Contract](conversation-surface-contract.md) and
[Codex-style Typed Transcript Implementation Plan](conversation-codex-style-transcript-implementation-plan.md).

这份规范只回答“用户看到什么、点击什么、如何保持简单好看”。数据权威、lineage、
completion 和 recovery 以详细设计为准。

Codex 的借鉴点是 renderer 分工而不是复制皮肤：消息/Markdown、命令执行、patch、
MCP 和本地路径各自有清晰的 renderer；Ling 额外加入 participant rail 和 approval
状态，但仍落入同一 row grammar。参考入口（只借鉴信息架构）：

- `codex-rs/tui/src/history_cell/messages.rs`：user/agent/reasoning 文档流；
- `codex-rs/tui/src/history_cell/exec.rs`：命令与 stdout/stderr；
- `codex-rs/tui/src/history_cell/patches.rs`：文件变更与 diff；
- `codex-rs/tui/src/history_cell/mcp.rs`：MCP 调用；
- `codex-rs/tui/src/markdown_render.rs`：Markdown、链接、本地路径。

Ling 不复制 TUI 的键盘布局、颜色或 provider session；Web/desktop 只复用“typed item
→ 专用 renderer → 可折叠详情”的原则。

## 1. 视觉法则

```text
one page
├── document lane：user/Agent Markdown、段落、list、code、path
├── fact rail：command/file/tool/approval/participant 的真实动作
└── shell chrome：header、Composer、EnvironmentPopover、可选 detail dock
```

不要给所有内容套方形卡片。叙述像文档，事实像小型 activity row，详情在原地展开。
视觉重量只在“需要用户处理”的 waiting/failed/blocked/approval 状态增加。

### 1.1 简单好看的基线

默认状态只保留三种视觉重量：

```text
document lane   = 正文排版（无外框、自然空白）
fact rail       = 轻量行（icon + 动作 + status）
attention       = 同一行的 tint/border + 可恢复控件
```

实现约束：

- 不给每一段正文套卡片；不把 message、command、summary 叠成多层方框；
- 同一行最多一个 disclosure，active/attention 行可默认展开一层；
- 成功历史收敛为一行，失败/等待才增加对比度和详情；
- 所有颜色都有文本状态和 icon 作为冗余，不能依靠红绿区分；
- row、batch、nested row 使用同一 8px spacing scale，避免每个 surface 自己调间距。

### 1.2 Codex 风格视觉 token（Ling 皮肤）

借鉴 Codex 的信息密度和“事实靠近动作”的布局，但不复制 Codex 的颜色或 TUI 皮肤。
所有 surface 只使用这一套 token：

| Token | 值 | 用途 |
| --- | --- | --- |
| `space-1..6` | `4/8/12/16/24/32px` | row、段落、section 间距 |
| `fact-icon` | `16px` | command/file/tool/approval kind |
| `nested-icon` | `14px` | depth-1 child |
| `row-min-height` | `28px` | pointer/keyboard hit target |
| `row-radius` | `6px` | 仅 hover/attention tint，不做重卡片 |
| `detail-radius` | `8px` | inline detail/pre block |
| `body-size` | `14px / 1.55` | 文档 lane |
| `fact-size` | `13px / 1.4` | factual rail |
| `mono-size` | `12px / 1.5` | command/output/code |
| `content-max` | `760px` | 正文可读宽度；事实行可占满 |
| `detail-max-height` | `240px` | inline bounded preview；超出显示展开/完整 artifact 入口 |

正文只用自然空白和排版层级；事实行只用 icon、动词、状态和一个 disclosure。
任何新组件如果需要自己的 spacing、radius 或 status 色，必须先证明 shared token
无法表达，否则视为 surface 分叉。

### 1.3 页面级组合

三个 surface 使用同一个页面骨架。`document lane` 和 `fact rail` 是同一条 DOM 流中的
语义分组，不是左右两列，也不是两个滚动容器：

```text
ConversationSurfaceShell
├─ Header（标题、参与者/模型提示）
├─ ConversationFeedViewport  ← 唯一纵向 overflow/scroll owner
│  └─ ConversationTimeline   ← 普通文档流，无纵向 overflow
│     ├─ document item：自然宽度，最多 760px
│     ├─ fact row：同一列，动词 + 状态 + disclosure
│     └─ depth=1 child：左侧 1px rail + 8px inset
├─ EnvironmentPopover（只绑定 active action）
└─ Composer（输入和 approval control 的唯一 owner）
```

页面级硬规则：

- Header、Timeline、Composer 可以是 shell 的三个区域，但只能有一个历史滚动容器；
  EnvironmentPopover 使用浮层定位，不能建立第二份历史列表。
- 文档 item 和事实 row 在同一垂直顺序中交错出现，不能把所有事实搬到右侧或底部。
- 事实 row 的最大内容宽度不受 760px 限制；命令/输出可占满时间线列，但不能撑破窗口。
- Composer 固定在时间线之后；它只负责输入、停止、重试和审批，不显示 action summary。
- child rail 只增加层次提示，不改变字体、row height、disclosure 或状态文案。

因此，“普通会话显示在右侧”“频道使用另一套卡片”都属于布局回归，而不是可接受的
surface 差异。

### 1.4 对齐、宽度和视觉重量

Codex 风格的重点是阅读顺序，不是把所有内容都做成气泡：

| 内容 | 对齐 | 首屏容器 | 允许的强调 |
| --- | --- | --- | --- |
| `userMessage` | 左对齐、与 Agent 共用 document column | 轻量作者标识 + 文档流，最大 `760px` | hover/edit 状态 |
| `agentMessage` / `reasoning` / `plan` | 左对齐 | 文档流，无 card chrome | 标题/列表/代码自身层级 |
| command/file/tool/approval | 左对齐、占满 timeline column | 28px+ fact row | active/attention tint |
| depth-1 child | 左对齐，增加 rail + inset | 复用上面两类容器 | participant label |

用户消息通过轻量作者标识表达身份，不靠右侧方形气泡表达身份；Agent 叙述和事实行同样
保持左侧阅读顺序。任何 surface 都不得通过 `justify-end`、独立 max-width 或 route CSS
改变同一 item 的 renderer geometry。

## 2. Row grammar

### 2.1 Fact row

```text
[16px icon]  Verb title · status                         [⌄]
             optional one-line detail / bounded tail
```

- icon 只表达 kind，不代替 status 文案；
- title 用动作动词：`Run pnpm test`、`Edited parser.ts`、`Read 8 items`；
- status 是可读文本：`Queued`、`Working`、`Waiting`、`Waiting for approval`、
  `Succeeded`、`Failed`、`Cancelled`、`Blocked`；`Waiting for approval` 只用于审批，
  其他等待原因使用 `Waiting` 加一行原因说明；
- 每行最多一个 disclosure；没有 detail 就不显示按钮；
- row hit target ≥28px，focus ring 与 hover 规则一致；
- active/blocked 默认展开一层 bounded detail，成功历史默认折叠。

### 2.2 Document flow

- `userMessage`、`agentMessage`、子 Agent narration 不进入 fact-row shell；
- 段落之间保留空行，list 使用真实 list marker；
- fenced code 保留换行、缩进和 language label，默认等宽字体；
- 流式内容更新同一个 message id，不创建第二个“正在输入”气泡；
- 本地文件先显示 basename + file icon，hover/focus 才显示完整路径。

### 2.3 Text / code / path 判定

正文不通过“看起来像代码”的关键词猜测类型，而由 content part 或 Markdown AST
决定：

| 输入 | 首选 renderer | 关键规则 |
| --- | --- | --- |
| 普通纯文本/段落 | `paragraph` | 保留段落边界和空行，允许自然换行 |
| Markdown list/quote/link | 对应 AST renderer | 保留 marker、缩进和可访问名称 |
| fenced code | `code` | 保留换行/缩进，显示 language label + copy |
| 未闭合 fence 的流式片段 | plain monospace | 先安全显示，结束后再高亮 |
| 已验证本地文件 ref | `fileRef` | basename + icon；hover/focus 完整路径；可打开 |
| 模型随口写出的 path | display-only `pathCandidate`（parser 的 `local_file` token） | basename + icon + 完整路径 tooltip/copy；不生成 `file://` 或 Host action |

同一 `agentMessage` 可以包含多个 content part；不能为了渲染方便把它们 flatten 成
一行，也不能把 code part 误归类为 `commandExecution`。

### 2.4 文档 lane 的排版规则

- 连续两个换行保留为一个段落间距，单个换行在窄屏自然折行，不强制每行生成 item；
- list/quote 使用语义 HTML（`ol`/`ul`/`blockquote`），禁止用空格伪造缩进；
- inline code 与 fenced code 使用相同 mono token，但 fenced code 才显示 language
  label、copy 和 bounded horizontal scroll；
- 空正文不渲染空 bubble；流式空片段只保留一个 `agentMessage` placeholder，收到首个
  part 后原地替换；
- markdown 解析失败时保留安全纯文本并生成 `diagnostic(markdown_parse_failed)`，不
  把整条消息送进 fact rail。

### 2.5 Result row

`terminalReport` 是 execute turn 的结果文档，不是命令列表的另一种包装：

```text
[✓] Result · Succeeded · 2 files changed · 3 checks passed       [⌄]
```

- 只由已提交的 Completion Gate、TerminalReport 和 final-result Item 投影；
- 默认显示一行 outcome + 关键计数，展开后显示 bounded summary、changes、verification、
  artifacts 和 risks 的 source refs；完整 stdout/stderr 仍回到 owning fact row 或 artifact
  viewer；
- `reply` turn 使用最终 `agentMessage`，不生成 result row；`execute` turn 不在 result row
  后再渲染重复的最终 assistant summary；
- 状态使用与 fact row 相同的 machine/value 文案和无障碍 label，颜色只做辅助。

### 2.6 Render-once 边界

同一个 canonical item 只能在 Timeline 中生成一次 owning row。以下区域只提供控制或
定位，不能再复制历史内容：

| 区域 | 允许显示 | 禁止复制 |
| --- | --- | --- |
| `ConversationTimeline` | item、状态、详情、disclosure | — |
| `Composer` / approval gate | 输入、停止、重试、allow/deny | command/output/summary |
| `EnvironmentPopover` | 当前 active run 的两行 ambient hint | 历史动作、TerminalReport |
| Right Dock / viewer | 当前 source ref 的完整预览 | 第二个 action row 或 completion |
| `terminalReport` row / fan-in | atomic evidence 结论 | batch count、命令输出全文、Timeline 外的第二张结果卡 |

如果同一 `actionId` 在两个区域出现，视觉验收必须判定为 duplicate-owner 回归，即使
两处内容完全相同。修复入口应回到 projector/owner 映射，而不是在 CSS 中隐藏其中一处。

## 3. Typed renderer map

| Kind | icon | 首屏标题示例 | 默认详情 |
| --- | --- | --- | --- |
| `userMessage` | user | 文档流 | Markdown |
| `agentMessage` | agent | 文档流 | Markdown |
| `reasoning` | spark | `Reasoning` | safe summary |
| `plan` | checklist | `Plan · 2/4 complete` | step list |
| `commandExecution` | terminal | `Run pnpm test` | command/cwd/tail/exit |
| `exploration` | search | `Read src/` | targets/result |
| `fileChange` | file | `Edited parser.ts` | stats/diff |
| `mcpToolCall` | plug | `Search docs` | redacted input/result |
| `dynamicToolCall` | bolt | tool label | bounded Host result |
| `collabAgentToolCall` | people | `Delegated to QA` | participant/status |
| `approval` | shield | `Waiting for approval` | decision |
| `imageView` | image | caption/basename | bounded preview |
| `contextCompaction` | layers | `Context compacted` | snapshot/range |
| `terminalReport` | checkmark/alert | `Result · Succeeded` | bounded summary, changes, verification, artifacts |
| `protocolEvent` | protocol | lifecycle/decision title | structured protocol detail |
| `subAgentActivity` | participant | `Engineer · working` | nested timeline |
| `commandBatch` | terminal-stack | `Ran 4 commands` | exact children |
| `explorationBatch` | search-stack | `Read 8 items` | exact children |
| `diagnostic` | alert | `Activity unavailable` | repair/source refs |

renderer key 必须稳定，例如 `message.document`、`fact.command`、`fact.file`、
`fact.tool`、`fact.approval`、`result.terminal`、`batch.command`、`batch.exploration`、
`agent.nested`。`terminalReport` 是 execute turn 的唯一结果 row；reply turn 不生成
该 kind。
key 是 fingerprint 的一部分；surface 只能改变 policy/chrome，不能改变 key。

视觉层永远不显示 SQLite/API 的 wire kind。`terminal_report` 只在 durable payload 和
 lineage 中出现，进入 Timeline 后显示为 `Result · Succeeded`，其 DOM 使用
`data-conversation-timeline-kind="terminalReport"`、
`data-conversation-timeline-renderer-key="result.terminal"`。同理，
`assistant_message` 经过 `presentationRole` 投影成 document row，而不是把 snake_case
名称或 provider 原始 JSON泄露给用户。这样视觉简化不会牺牲可审计性，也不会让不同
surface 因 wire 字段差异产生不同 renderer。

### 3.1 组合示例：一个 timeline，四种 row

一个真实 turn 在 UI 中只允许出现以下组合，不再叠加旧 workflow 卡片：

```text
document lane
  Agent: 我先检查解析器，然后运行测试。

fact rail
  ⌁ Read src/parser.ts · Succeeded                 [⌄]
  ▣ Run pnpm test · Working                         [⌄]
  ▱ Edited parser.ts · +18 -4 · Succeeded          [⌄]

result lane
  Result · Succeeded · 2 files changed · tests passed                 [⌄]

nested rail (depth=1, same registry)
  Engineer  我会复核失败用例。
            ▣ Run pnpm test -- --filter parser · Failed · exit 1  [⌄]
```

约束如下：

- 文档 lane 不显示 `message-bubble` 外框；段落、list、fence 和 path 由 Markdown/content
  part 保留结构；
- fact rail 的首屏文本必须包含动词和状态，不能只显示“执行中”或“已完成”；
- nested rail 只增加 participant label/rail，子 Agent 的 narration、command、file、
  tool 仍复用相同 renderer key、row height、disclosure 和 a11y 属性；
- `agentMessage` 与事实 row 可以相邻，但一个 action 不能在两处重复；
- summary、Composer footer 和 EnvironmentPopover 都不能再复制事实 row 的正文或输出；
  `terminalReport` 本身就是 Timeline 内唯一的 execute 结果 row，不能在 Timeline 外再挂
  一个同内容的 TerminalReport card。

这是视觉验收的最小单元：同一 canonical fixture 在 normal/private/channel/child 中
必须得到相同的 row 组合和 renderer fingerprint，只允许外围标题、roster、participant
rail、权限提示不同。

## 4. Command and output

首屏至少显示真实命令摘要，不允许只写“执行中”：

```text
▣  Run pnpm test · Working                         [⌄]
   packages/ui › test/unit …
```

展开显示 exact command、cwd、stdout/stderr 的原始换行、exit code、duration、truncation
标记和 trusted artifact ref。daemon 的 bounded tail 上限为 40 行/8KiB/64 chunks；首屏
成功最多显示 5 行/800 字符，失败最多 12 行/1600 字符。超过首屏上限时由同一 row 的
`Show more` 展开 bounded tail，完整输出通过 trusted artifact 打开，不创建第二个纵向
滚动容器。

`tool_update` 更新同一 `data-conversation-timeline-id`，不能追加 stdout 气泡。active
row 保持可见；completed batch 不包含 active command。

每个 command row 的首屏文案必须能回答“做了什么”：

```text
▣  Run node scripts/check.mjs · Succeeded                 [⌄]
   exit 0 · 2.4s · apps/web
```

`Running node …`、`I will run …` 只能是叙述或 pending 状态，不能替代真实 command
evidence。没有 command、exit 或 Host source ref 时使用 `Activity unavailable`，不伪造
成功。

动作标题由 typed payload 生成，不从模型叙述复制。标题模板固定为：

| Kind | 动词模板 | 示例 |
| --- | --- | --- |
| command | `Run {commandSummary}` | `Run pnpm test` |
| read | `Read {targetSummary}` | `Read src/parser.ts` |
| search | `Search {querySummary}` | `Search "terminal fence"` |
| file create/edit/delete | `{Created|Edited|Deleted} {basename}` | `Edited parser.ts` |
| MCP/dynamic tool | `{toolVerb} {target}` | `Search GitHub issues` |
| delegation | `Delegated to {participant}` | `Delegated to QA` |

模板缺少可安全显示的参数时使用 tool label；不得退化成只有 `Running…`、`Done` 或
provider 原始 JSON 的行。

## 5. 文件、路径和 diff

```text
▱  Edited parser.ts · +18 -4 · Succeeded        [⌄]
```

- 首屏不显示长绝对路径；
- hover/focus tooltip 显示完整路径并支持复制；
- 只有 Host 授权的 `open_file`/`open_diff` ref 可点击；
- 未验证 path 只能作为文本，不能 `file://` 跳转；
- diff 使用结构化 gutter/hunk，解析失败保留安全文本并显示 diagnostic。

点击能力来自 Host 签发的 capability ref，而不是来自路径字符串本身。模型写出的
`/workspace/src/app.ts` 与 Host 验证的 `fileRef` 必须拥有不同的 semantic state：前者
可复制、不可导航；后者才有 `data-conversation-timeline-host-target="open_file"`，
并且 Host callback 仍需在执行时重做 workspace/scope/permission 校验。三种 surface
以及 depth-1 child 只能调用这一套 trust adapter。

## 6. Batches 和 disclosure

```text
▣  Ran 4 commands · 28s                      [展开]
   └─ pnpm lint                 exit 0 · 4.1s
   └─ pnpm test                 exit 0 · 9.8s
```

batch 默认折叠，展开后恢复 exact child order。它没有独立 completion state；批次数量
不参与 fan-in。跨 Agent、run、attempt、retry、workflow step、approval、失败动作或
consequential action 立即拆分。1–2 个 child 保持普通 row，避免为了短列表增加控件。

## 7. Nested Agent

```text
Engineer ─┐
          ├─ I will inspect the parser.       (agentMessage)
          ├─ ⌁ Read src/parser.ts             (exploration)
          └─ ▣ Run pnpm test · Succeeded       (commandExecution)
QA       ─┘
```

子 Agent 是同一个 `ConversationTimeline(depth=1)`，只有 participant label 和 1px rail
增加层次感。不能生成 child-specific bubble、独立 WorkCell 或第二滚动区域。

`subAgentActivity` 自己只有一个 group disclosure，不再包卡片：首次实时运行时展开；
`waiting/blocked/errored` 保持展开；重新载入历史时，只有全部 child 都是安全终态且没有
用户 focus 的 completed group 默认折叠。用户手动展开/折叠后，以稳定 `item.id` 保持状态，
后续 revision 不得强制切换。group 展开后 child 的 fact row 仍各自使用原 disclosure。

子 Agent 的叙述、计划、命令、文件和工具按父级相同顺序渲染；例如：

```text
Engineer  I will inspect parser.ts.                 (agentMessage)
          ⌁ Read src/parser.ts · Succeeded          (exploration)
          ▣ Run pnpm test · Failed · exit 1         (commandExecution)
          ⚠ Activity blocked · missing artifact     (diagnostic)
```

只有 `subAgentActivity` 这一层负责 participant label、lifecycle 和 rail；child item 不
再套一层“队友消息气泡”。深度超过 1 时显示结构化 blocked，而不是继续缩进导致乱码。

participant rail 只占 1px + 8px inset，不改变 child item 的字体、row 高度和 disclosure
规则。participant label 在该 span 的第一行显示一次；后续 child rows 不重复头像或
“队友消息”气泡。child narration 可以是普通 Markdown，也可以和父级一样包含 code、
path 和 links。

### 7.1 Nested Agent 的状态和事实边界

子 Agent 的 lifecycle（started/running/waiting/completed/blocked/errored）只显示在
`subAgentActivity` 的 participant rail。子 Agent 的每个真实动作仍单独渲染为
`commandExecution`、`fileChange`、typed tool 或 `diagnostic`，并携带自己的
`actionId/runId/attemptId`。父级只能在 required child evidence 到齐或收到结构化
blocked 后显示 fan-in 结论；“子 Agent 已准备好”不是完成证据。

子 Agent 的 narration 是普通 `agentMessage`，不是系统状态，也不是事实摘要。例如：

```text
Engineer  我发现 parser.ts 的边界条件可能导致空 token。
          ▣ Run pnpm test -- --filter parser · Succeeded · exit 0
          ▱ Edited parser.ts · +6 -1
```

如果子 Agent 没有产生任何 Host evidence，就只显示 narration 加
`Activity unavailable · blocked`，不能渲染绿色成功或把 ready 文本提升为动作。

## 8. EnvironmentPopover

浮窗只表达当前 ambient 状态：

```text
Working · Engineer editing parser.ts
ling-stack · feature/transcript
```

最多两行；active revision 原地更新；run settled 后消失。它不能重复 final answer、
TerminalReport、summary、command output 或 memory footer。source icon 只 focus 对应 row。

Popover 的布局是 shell chrome，不是历史卡片：

```text
┌ Working · Engineer editing parser.ts ┐
│ ling-stack · feature/transcript       │
└───────────────────────────────────────┘
```

它只绑定当前 active `runId/actionId`。active action 变化时原地更新；terminal fence 或
run settled 后关闭。任何历史事实、summary 或 approval control 都必须回到 Timeline 的
唯一 owner，避免浮窗、右侧 dock、Composer 同时重复一份结果。

## 9. Surface parity

| Surface | 允许的 chrome | 不允许的差异 |
| --- | --- | --- |
| 普通 | header、model hint、environment | 独立 message bubble/activity renderer |
| 私聊 | teammate avatar/name | 私聊专属事实卡或第二 summary |
| 频道 | roster、topic/branch controls | 频道专属 item grammar |
| 子 Agent | participant label、depth rail | child-specific renderer/scroll owner |

同一 fixture 必须拥有相同 kind、row geometry、状态文案和 disclosure 行为。surface policy
只能控制权限、可见性和外围 chrome。

视觉回归的最低比较单位是 renderer fingerprint，而不是截图像素完全相同：

```text
same fixture
  -> kinds / order / stable ids / status text / disclosure count  (must match)
  -> shell title / roster / participant rail / policy hints         (may differ)
```

### 9.1 状态与交互矩阵

| 状态 | 首屏 | 默认 detail | 可执行动作 |
| --- | --- | --- | --- |
| pending | 动作 + `Queued` | 否 | 取消（若 Host 支持） |
| running | 动作 + `Working` | bounded live tail | 停止/展开 |
| waiting (approval) | 动作 + `Waiting for approval` | 是 | allow/deny（Composer 唯一 owner） |
| waiting (dependency/fan-in) | 动作 + `Waiting` | 是 | 仅查看缺失证据 |
| succeeded | 动作 + `Succeeded` | 否 | 展开/复制/打开 trusted ref |
| failed | 动作 + `Failed` | 是 | 重试/查看完整 artifact |
| cancelled | 动作 + `Cancelled` | 否 | 查看原因 |
| blocked | `Activity unavailable`/`Blocked` | 是 | 修复 source/重试 |

状态必须同时由文本、icon 和可访问名称表达；颜色只是 tint。active 状态更新时 row
identity 不变，hover/focus 不丢失。

视觉 copy 的 `Queued` 对应内部既有的 `pending` 状态；`Waiting`/`Waiting for approval`
都来自内部 `waiting`，由 `waitingReason` 决定文案和可执行动作。这只是 shared renderer
的显示映射，不要求新增或改写持久化状态值。

## 10. Responsive、density 和 a11y

| Token | 值/规则 |
| --- | --- |
| fact row hit target | ≥28px |
| icon | 16px；nested icon 14px |
| detail max height | 240px bounded preview；超出用 `Show more`/完整 artifact，不增加纵向滚动 owner |
| inline command tail | ≤40 lines、8KiB、64 chunks |
| dense activity | 通过安全终态 batching 和 `subAgentActivity` group disclosure 收敛；不设置局部 max-height/`overflow-y` |
| mobile/narrow | 隐藏次要 cwd/时间，保留 verb/status |
| reduced motion | 关闭插入/展开动画，保留状态变化 |

所有 disclosure 使用 native button + `aria-expanded`；状态必须有文本而非只用颜色；
`data-conversation-timeline-id`、`data-conversation-timeline-kind`、
`data-conversation-timeline-renderer-key`、
`data-conversation-timeline-status`、`data-conversation-timeline-revision`、
`data-conversation-timeline-depth` 和 source ref 属性是稳定测试接口。

键盘路径必须与鼠标相同：Tab 进入 row，Enter/Space 切换唯一 disclosure，Escape 关闭
detail/popover，Enter 激活已授权的 file/diff ref。滚动容器只有一个；nested rail 不得
创建第二个 `overflow:auto` 容器。输出截断时显示 `truncated` 文本和完整 artifact 的
可访问名称。

### 10.1 空态、加载态和未知数据

- 首次加载：Timeline 保留一个非事实的 skeleton，不创建假的 command/file row；
- 增量等待：使用 `agentMessage` 的轻量 placeholder，不显示“命令已执行”；
- 无历史：显示文档式 empty state，不能显示空 WorkCell 或 summary 卡；
- 未知 kind/缺 lineage：显示 `diagnostic`，标题为 `Activity unavailable`，并提供
  可复制的 source id；
- reconnect/restart：保留原 row 的状态，显示短暂 `Reconnecting` shell hint，恢复后
  原地清除 hint，不追加第二个 action。

### 10.2 实现级视觉契约

为了让实现和截图验收使用同一套语言，Timeline 的 DOM 结构固定为下面的最小形状。
类名可以按现有代码命名，但语义属性和层级不能改变：

```html
<div data-conversation-timeline="true">
  <article data-conversation-timeline-kind="agentMessage" class="document-item">
    <div class="markdown-body">…</div>
  </article>
  <article data-conversation-timeline-kind="commandExecution"
           data-conversation-timeline-status="running"
           data-conversation-timeline-revision="3"
           class="fact-row">
    <span class="fact-icon" aria-hidden="true">▣</span>
    <span class="fact-title">Run pnpm test</span>
    <span class="fact-status">Working</span>
    <button aria-expanded="true">Details</button>
    <div class="fact-detail">…bounded output…</div>
  </article>
</div>
```

实现约束：

1. `document-item` 不使用 fact-row 的边框、背景或右侧 action 区；正文最大宽度为
   `760px`，段落/list/code/path 按 Markdown 语义排版。
2. `fact-row` 是单列、全宽、最小高度 `28px` 的轻量行；首屏必须同时出现动作动词和
   文本状态。唯一 disclosure 使用原生 `button`，详情仍是该 row 的子节点。
3. active/attention 行只增加 tint、左侧状态标记和 bounded detail，不增加另一张卡；
   成功历史默认折叠，1–2 个安全动作不强行套 batch 控件。
4. `subAgentActivity` 只增加 `participant rail (1px)`、label 和 `8px` inset；child
   row 的 icon、字体、状态文案和 disclosure 与父 timeline 完全相同。
5. `EnvironmentPopover` 和 Composer 不得出现在 `[data-conversation-timeline]` 的历史
   DOM 中，也不得复制其文本；它们只通过 stable id focus owning row。

### 10.3 简洁视觉状态表

同一事实行只允许以下状态表达，避免频道、私聊和普通会话各自发明文案：

| 状态 | icon 语义 | 首屏文案 | 默认展开 |
| --- | --- | --- | --- |
| queued | clock | `Queued` | 否 |
| working | spinner/terminal | `Working` | 是（bounded tail） |
| waiting (approval) | shield | `Waiting for approval` | 是 |
| waiting (dependency/fan-in) | clock/people | `Waiting` | 是 |
| succeeded | check | `Succeeded` | 否 |
| failed | alert | `Failed` | 是 |
| cancelled | stop | `Cancelled` | 否 |
| blocked | lock/alert | `Activity unavailable` | 是 |

状态颜色只作为 tint；文本、icon、`aria-label` 和 `data-*` 必须同时表达相同语义。
同一 action 从 `working` 变为终态时只更新 status/revision，不改变 DOM id、行位置或
用户当前展开状态。

### 10.4 渲染组件拆分

实现组件应按语义拆分，而不是按 surface 拆分：

```text
ConversationTimeline
├─ DocumentItem
│  ├─ MarkdownBody
│  ├─ CodeBlock
│  └─ LocalPathRef
├─ TimelineFactRow
│  ├─ FactIcon / FactTitle / FactStatus
│  └─ FactDisclosure -> CommandDetail | DiffDetail | ToolDetail | ApprovalStatusDetail
├─ TimelineBatchRow -> exact atomic children
└─ SubAgentActivity -> participant rail + ConversationTimeline(depth=1)

Composer / approval gate
└─ allow / deny / stop / retry controls（各自唯一 owner，Timeline 不复制按钮）
```

`NormalConversationFeed`、`TeammatePrivateChatFeed` 和频道组件只能传 items、policy、
callbacks 和 shell chrome，不得各自拥有 `CommandRow`、`FileRow`、Markdown parser 或
status copy。CSS token 也只从 shared timeline 导出；surface stylesheet 只能调整 header、
roster、Composer 和页面边距。

## 11. 禁止的视觉回归

- 叙述被重新包成方形 WorkCell/bubble；
- 多条消息、列表或代码 fence 被 flatten 成一行；
- 命令没有真实动作描述或 stdout 被挤成一行；
- 一个 action 出现两次（assistant、WorkCell、TerminalReport、Composer）；
- 完成后又出现第二个红框 summary；
- 子 Agent 乱码、无动作描述或把 ready 文本当成功；
- activity rail、Composer、right dock 同时拥有同一个 approval 控件；
- 环境浮窗变成第二历史面板或 persistent summary。

## 12. 视觉 review checklist

每个 renderer 合入前必须回答：

1. 首屏是否能用一个动作动词和一个状态说明“做了什么/现在怎样”；
2. 是否能在不展开的情况下区分叙述和事实；
3. 展开是否仍在同一 row 内，且不会复制 summary、output 或 approval；
4. dark/light、键盘、reduced-motion、窄窗口是否保留同一语义层级；
5. 同一 fixture 在 normal/private/channel/child 的 renderer key 和 geometry 是否一致。

## 13. v3.7 视觉实现细化

这一版把“简单好看”变成实现者可以逐项检查的交互契约。Codex 的可借鉴点是信息层级
和 item 专用 renderer，不是把所有内容做成同样的卡片。视觉实现必须先满足语义，再
调整颜色和间距。

### 13.1 四个时刻，只有一个历史 owner

```text
首屏加载       -> document skeleton（不造假 action）
动作进行中     -> 同一 fact row：动词 + Working + bounded tail
动作结束       -> 同一 fact row：Succeeded/Failed/Cancelled + disclosure
重连/重启恢复  -> 同一 fact row：短暂 Reconnecting，恢复后原地清除
```

`ConversationTimeline` 是四个时刻唯一的历史 owner。Composer、EnvironmentPopover、
right dock 和 Timeline 外部区域可以聚焦或打开 owning row，但不能复制 row 文案、输出、
文件统计或完成状态。`terminalReport` 作为 execute turn 的 result row 也只能在 Timeline
内出现一次。任何第二份历史列表都视为视觉回归。

### 13.2 单行 anatomy 与文案规则

事实行固定为：

```text
[kind icon]  [verb title] · [text status]                 [Details]
             [optional one-line detail / bounded tail]
```

动词由 typed payload 生成，而不是从模型句子截取：

| kind | 标题模板 | 例子 |
| --- | --- | --- |
| command | `Run {commandSummary}` | `Run pnpm test` |
| exploration | `{Read\|Search} {targetSummary}` | `Read src/parser.ts` |
| fileChange | `{Created\|Edited\|Deleted} {basename}` | `Edited parser.ts` |
| tool | `{toolVerb} {target}` | `Search GitHub issues` |
| delegation | `Delegated to {participant}` | `Delegated to QA` |

缺少安全 payload 时显示 `Activity unavailable` + blocked 状态，不降级成只有
`Running…`、`Done` 或 provider JSON 的行。一个 action 的 start/update/end 永远只占
一行，revision 更新不得改变 DOM id、排序、焦点或用户已展开的 detail。

### 13.3 统一 surface 的唯一差异

```text
ResolvedConversationSurface
  -> canonical snapshot
  -> one projector + optional display batch
  -> ConversationTimeline（same registry）
  -> surface shell/policy/chrome
```

普通会话、队友私聊、频道 root/topic/branch 和 depth-1 child 的 `rendererKeys`、item
顺序、状态文案、行高和 disclosure 数必须一致。只允许标题、roster、participant rail、
权限提示不同。禁止在任何 surface 中新增 `MessageBubble`、`WorkCell`、`CommandRow`、
Markdown parser 或第二个 scroll owner。

### 13.4 EnvironmentPopover 交互契约

浮窗是“现在正在发生什么”的环境提示，不是历史摘要：

```text
Working · Engineer editing parser.ts
ling-stack · feature/transcript
```

- 只绑定一个 `activeRunId` 和其当前 `actionId`，active revision 到来时原地更新；
- 最多两行，长 cwd 使用 basename/branch 截断，hover/focus 才显示完整值；
- run 进入 terminal fence 后关闭，不保留“刚刚完成”的 summary；
- 点击浮窗中的 source 只 focus Timeline owning row，不复制详情；
- 没有 active run 时不渲染空框，也不显示旧 run、TerminalReport 或 memory footer；
- `reconnecting` 只显示短暂 shell hint，恢复后清除，不追加“恢复完成”消息。

### 13.5 disclosure 与折叠规则

默认只展开需要用户处理的内容：

| 状态/数量 | 首屏行为 | 说明 |
| --- | --- | --- |
| 1–2 个安全终态动作 | 保持普通 row | 不为了短列表制造 batch 控件 |
| ≥3 个相邻安全终态 read/command | 一个 batch header | 展开恢复 exact child order |
| active action | 独立 row，默认 bounded detail | 不能被已完成 batch 吸收 |
| failed/waiting/blocked | 独立 attention row，默认展开一层 | 详情和恢复动作仍在 owning row |
| consequential action | 永远独立 row | 不允许被“Ran N”隐藏 |

展开只改变本地 disclosure 状态，不改变 canonical item、context segment、completion、
fan-in 或 retry 选择。成功历史的折叠是可逆的显示优化，不是数据合并。

### 13.6 内容类型的视觉验收

同一个 `agentMessage` 可以含多个 content part，必须保持语义结构：

```text
paragraph -> 自然换行与段落间距
list      -> 真实 ul/ol marker
code      -> fenced code、语言标签、copy、保留缩进换行
fileRef   -> basename + icon；hover/focus 完整路径；Host capability 后才可打开
link      -> http/https 安全链接
```

未闭合 code fence 在流式阶段先用 plain monospace，解析结束后再高亮；解析失败保留
纯文本并生成 `diagnostic(markdown_parse_failed)`。任何 path 字符串都不能自行升级成
`file://`，避免模型叙述与 Host 事实混淆。

### 13.7 滚动、折叠和高度的实现边界

“简单好看”最容易被局部滚动和重复折叠破坏，因此实现只允许下面的所有权关系：

| 区域 | 允许的行为 | 禁止的行为 |
| --- | --- | --- |
| `ConversationFeedViewport` | 唯一纵向滚动、贴底、历史 anchor | surface 再创建第二个 history viewport |
| `ConversationTimeline` | 普通文档流、item/disclosure/focus | 自己或子 row、batch、child 创建 `overflow-y` |
| fact detail | 正常文档流中的 bounded tail；必要时 `Show more` | 内嵌纵向 terminal viewport |
| batch | 一个 disclosure，展开 exact children | 自己再包一层 WorkCell/card 或改变排序 |
| code/diff | 仅允许水平滚动 | 横向滚动撑破页面或产生第二历史列 |
| EnvironmentPopover | 浮层定位，最多两行 ambient hint | 变成历史摘要、结果面板或第三个 activity list |

高度规则固定为：普通正文不设固定高度；事实行最小 28px；active/attention detail 的
bounded preview 最大 240px；超过上限通过同一 owning row 的 `Show more` 或 trusted
artifact 打开。高密度历史通过安全 batching、completed child group disclosure 和外层
Feed viewport 浏览，不给 Timeline、batch、child 或 command detail 增加纵向 max-height。

折叠状态只存在 Timeline view state，并以 `item.id`/稳定 batch id 为 key。snapshot
刷新、revision 更新、SSE reconnect、daemon restart 和 retry 不得把用户已经展开的 row
重置成另一行，也不得因为 batch 变长而复制 header。这样可以同时保持 Codex 式的安静
首屏和 Ling 所需的完整可追溯性。

### 13.8 旧 bubble class 的迁移规则

`MessageRow` 当前仍会输出 `message-bubble-own`、`message-bubble-peer` 等历史 class，
因为它们被现有测试和外部 surface selector 用作身份标记。它们在 v3.7 不再代表几何或
视觉样式：当 row 属于 `tone="document"` 时，shared CSS 必须强制以下规则：

- own/peer 使用同一个 leading-column + content-column 网格，内容均 `justify-self:start`；
- `message-content` 透明、无 border/radius/shadow，宽度占满 document column；
- avatar（若 policy 允许）始终位于 leading column；normal surface 隐藏 avatar 时，
  content 回到唯一的第一列；
- surface stylesheet 不得通过 `.message-bubble-own` 恢复右对齐、背景或独立 max-width。

因此 selector 迁移可以分两步完成：先把断言从“own bubble 外观”改为
`message-bubble-document + data-has-avatar + justify-self:start`，再在 E4 删除不再
需要的 legacy class。不能为了让旧截图通过而把 document row 重新变成气泡。

## 14. Visual acceptance

每个真实 packaged macOS case 至少提供：

```text
screen-01.png       active/initial
screen-02.png       expanded/final/recovery
semantic-state.json stable selectors + accessibility
lineage.json        item/action/run/attempt/participant/source refs
logs.redacted.txt   app + daemon logs without secrets
```

截图只证明视觉；semantic state 证明 item kind/status；lineage 证明事实来源。三者缺一
不能称为“Codex 风格实现完成”。

验收截图至少包含四个视角：普通会话 document + fact、私聊同 fixture、频道多 Agent
nested rail、active/failed/approval attention state。只展示一个成功 command row 不足以
证明共享组件、Markdown、批次、恢复和多 Agent 都已正确。

## 15. v3.7 组件级视觉蓝图

### 15.1 页面 composition

所有 conversation surface 使用同一纵向阅读结构；“lane”是语义，不是并排栏：

```text
ConversationShell
├─ Header / environment trigger                         shell chrome
├─ ConversationFeedViewport                             only vertical scroll owner
│  └─ ConversationTimeline                              no vertical overflow
│     ├─ User document                                  no bubble card
│     ├─ Agent document                                 Markdown
│     ├─ Fact row                                       icon + verb + status
│     │  └─ disclosure                                  bounded detail
│     ├─ Result row                                      execute terminalReport only
│     │  └─ disclosure                                  summary/changes/verification refs
│     ├─ Nested participant rail                        depth=1
│     │  ├─ child Agent document                        same renderer
│     │  └─ child fact row                              same renderer
│     └─ Final Agent document                           reply only; no duplicate report
├─ EnvironmentPopover                                   active ambient only
├─ Composer / approval gate                             controls only
└─ Right Dock                                           source viewer only
```

Document 与 fact row 的左边缘统一；nested rail 只增加 `8px` inset。普通、私聊和频道
不得改变正文宽度、fact row anatomy、状态 copy 或 disclosure 位置。

### 15.2 视觉 token 与密度

首轮实现使用现有 Ling 设计 token，不增加新的色板：

| 元素 | 约束 |
| --- | --- |
| Timeline column | `max-width: 760px`；窄窗 `width: 100%` |
| document gap | 段落 `8px`；item 间 `12px` |
| fact row | 最小高 `28px`；水平 gap `8px`；radius `6px` 仅 attention tint |
| icon | depth 0 为 `16px`；depth 1 为 `14px` |
| participant rail | `1px`、低对比；label 只出现一次 |
| code/diff | `12px/1.5` monospace；只允许水平 overflow |
| detail | 首屏最大 `240px`；超出使用 `Show more`/artifact，不创建纵向 viewport |

`Succeeded` 行默认无背景；`Working` 只有轻微 active tint；`Waiting/Failed/Blocked` 使用
attention tint 和文本状态。禁止用大圆角卡、整块红框或强饱和背景表达终态。

### 15.3 文本、Markdown、代码和路径

内容按 parser 输出的结构渲染，不按换行字符粗暴拼接：

| content part | renderer | fallback |
| --- | --- | --- |
| paragraph | Markdown paragraph | 原始文本，保留换行 |
| list | 真实 `ul/ol/li` | 原始 Markdown，不黏成一行 |
| fenced code | code block + language/copy | plain monospace，保留缩进 |
| inline code | inline code token | plain text |
| local path | basename + file icon + tooltip/copy | display-only，不可导航 |
| trusted file ref | 同上 + Host action | blocked 时仍可复制 |
| diff ref | file row → review viewer | 不降级成普通文件 |

流式阶段未闭合 fence 使用 plain monospace；fence 完成后在相同 message item 内切换
renderer，不创建第二条消息。Markdown parse 失败保留可读文本，并产生 diagnostic 供
审计；不得把正文压成一行或把代码当普通段落。

### 15.4 Fact row 与 batch 的首屏规则

```text
⌁ Read src/parser.ts · Succeeded                         Details
▣ Run pnpm test · Working                               Details
▱ Edited parser.ts · +18 -4 · Succeeded                 Review
◇ Search GitHub issues · Succeeded                      Details
```

- 动词和 target 来自 typed payload；状态来自 shared status mapper；
- row 只有一个 disclosure/action 区；`Review` 仍属于同一个 owning row；
- 1–2 个相邻成功动作保持独立；≥3 个符合条件的动作才出现 batch；
- active、waiting、failed、blocked、approval、retry boundary 和 consequential action 永不
  被 batch 吸收；
- batch 展开后 child 仍使用原始 renderer，但不增加卡片、头像或纵向滚动。

### 15.5 Nested Agent 展示

```text
Engineer ─┐  我先检查 parser 的 token 边界。
          ├─ ⌁ Read parser.ts · Succeeded
          ├─ ▣ Run parser test · Failed · exit 1
          └─ 我定位到空 token 分支。
```

participant lifecycle 只显示一次；子 Agent narration 使用普通 `agentMessage`，真实动作
使用父级相同的 fact renderer。父级 fan-in 未满足时保持 `Waiting`；child ready 文本不会
使父级显示成功。depth=2 显示一条轻量 `Blocked` diagnostic，而不是继续缩进。

### 15.6 EnvironmentPopover

Popover 只在存在 active action 时出现，最多两行：

```text
Working · Engineer editing parser.ts
ling-stack · feature/transcript
```

它不显示历史列表、最终总结、文件统计、approval 控件或 memory footer。active action
切换时原地更新；terminal fence 后关闭；reconnect 时可短暂显示 `Reconnecting`，恢复后
清除。点击只聚焦 Timeline owning row，不复制 row。

### 15.7 视觉验收截图组合

packaged macOS 的最终检查不能只拍一个成功结果。至少保存：

1. 普通会话：paragraph/list/fenced code/display-only path/trusted path；reply 的 final
   `agentMessage` 与 execute 的单一 `terminalReport` result row；
2. 普通会话：read batch、active command update、file diff；
3. 私聊：复用同一 fixture，验证 geometry/fingerprint parity；
4. 频道：两位 participant，各含 narration、command/file/tool；
5. 频道：partial fan-in、structured blocked、depth-2 blocked；
6. approval：waiting、deny、expired；
7. recovery：retry、SSE reconnect、daemon restart；
8. shell：EnvironmentPopover、dark/light、reduced motion、窄窗口。

每张截图必须能关联同目录的 `semantic-state.json` 和 `lineage.json`；无法回链事实的漂亮
截图一律视为 mock，不计入完成。

### 15.8 Turn outcome slot

每个 turn 只有一个结果位置，避免“已编辑文件后又出现红框总结、输入框下再重复一次”：

```text
reply turn
  └─ agentMessage(role=reply_result)

execute turn
  ├─ agentMessage(role=narration)          可有多条，解释过程
  ├─ fact rows                             真实 command/file/tool evidence
  └─ outcome slot
      ├─ Finalizing result                 report publication 尚未完成
      ├─ terminalReport                    highest committed generation
      └─ diagnostic(blocked)               publication/join 失败
```

`execution_summary` 是 provider 的终态文本，不拥有第二个可见结果。TerminalReport
committed 后它只保留为 synthesis/audit 输入；Timeline、Composer、EnvironmentPopover 和
Right Dock 都不渲染它。outcome slot 的 identity 绑定 `turnId`，从 finalizing 切换为 result
或 blocked 时原位更新，不在底部追加新卡，也不改变用户当前 scroll anchor。

结果行仍遵守 Codex 风格的低重量表达：成功是无背景的一行，失败/blocked 才使用轻量
attention tint；展开显示结构化 changes、verification、artifacts 和 risks，不复制每条
命令输出。这样“最终说明”和“真实执行事实”在语义上分层，视觉上仍保持一个连续文档流。

### 15.9 v3.8 Codex-parity 视觉实现表

这一表是设计到 CSS/React 的最后一道翻译层。实现者先满足表中的几何和语义，再调整
品牌色；不能为了复刻截图而恢复旧 WorkCell 或右侧气泡。

| 区域 | 默认几何 | 首屏内容 | 交互/状态 | 明确禁止 |
| --- | --- | --- | --- | --- |
| document lane | 左对齐，最大 760px，无背景 | Markdown 段落、list、code、path | 流式在同一 item 原地更新 | bubble、`justify-end`、把换行 flatten |
| fact rail | 单列、最小 28px、16px icon | 动词 + target + 文本状态 | 一个 disclosure；active/attention 默认开 | 只显示“运行中/完成”、多层卡片 |
| result lane | 与 fact rail 同列，低重量 | `Result · status · counters` | 一个 disclosure；仅 execute turn | 第二份 summary、Composer 结果卡 |
| nested rail | 1px rail + 8px inset | participant label 一次 + 同一 item renderer | group disclosure；depth=1 | child bubble、第二滚动容器 |
| EnvironmentPopover | 浮层、最多两行 | active action + workspace/branch | active revision 原地更新，terminal fence 后关闭 | 历史列表、TerminalReport、approval 控件 |
| Composer | 时间线之后，固定输入区 | 输入、停止、重试、审批 | 控制动作，不拥有历史事实 | action summary、stdout、结果重复 |

视觉状态只使用 shared mapper 的闭集：`Queued`、`Working`、`Waiting`、`Waiting for
approval`、`Succeeded`、`Failed`、`Cancelled`、`Blocked`。图标、文本、`aria-label` 和
`data-conversation-timeline-status` 必须表达同一状态；颜色只是 tint。

#### 15.9.1 首屏信息密度和折叠阈值

```text
1–2 个相邻安全终态 action  -> 直接显示两行以内的 fact row
≥3 个相邻、同 lineage、安全终态 read/command -> 一个 batch header
active/failed/waiting/approval/consequential -> 独立 row + bounded detail
```

成功历史不设置固定高度；单个 detail 预览最多 240px，stdout/stderr 最多 40 行/8KiB。
超出部分使用同一 row 的 `Show more` 或 trusted artifact，绝不产生第二个纵向
`overflow-y`。展开状态只保存在 Timeline view state，以稳定 item/batch id 为 key，刷新、
重连和 retry 不得丢失用户当前 disclosure。

#### 15.9.2 Codex item 到 Ling renderer 的可见映射

```text
userMessage / agentMessage / reasoning / plan -> document.*
command / exploration / file / tool / approval -> fact.*
terminalReport                              -> result.terminal
subAgentActivity                            -> agent.nested
commandBatch / explorationBatch             -> batch.*
unknown / missing lineage                   -> fact.diagnostic (Blocked)
```

wire kind、projection kind 和 `rendererKey` 只在 adapter 处转换一次。DOM 不暴露
`assistant_message`、`terminal_report` 等 SQLite 名称；验收通过
`data-conversation-timeline-kind`、`data-conversation-timeline-renderer-key`、稳定 id、
status、revision 和 source ref 检查语义。

#### 15.9.3 三种 surface 的视觉等价性

同一 canonical fixture 在 normal、private、channel/topic/branch 和 child 中必须拥有相同
的 `kind/order/status/rendererKey/disclosureCount/row geometry`。允许变化的只有 shell
标题、roster、participant rail、权限提示和可用的 Host callback。任何 surface 重新定义
`CommandRow`、Markdown parser、status copy、batch 函数或 scroll owner，都视为 parity 失败。

## 16. v3.9.1-final 视觉实现锁

这一节是 UI 开工时的默认答案，避免把 Codex 的“清楚”误解成复制颜色或把所有内容做成
卡片。实现者只需要组合下面三种视觉 primitive：`DocumentBlock`、`FactRow`、`ResultRow`。
`NestedRail` 只是布局 wrapper，不是第四种消息组件。

### 16.1 三种 primitive

```text
DocumentBlock
  author/meta（可选）
  Markdown body（段落、list、quote、code、link、path）

FactRow
  16px icon · Host-derived verb + safe target · text status · one disclosure
  optional bounded detail（原地展开）

ResultRow
  check/alert icon · Result · status · counters · one disclosure
  execute turn only; reply turn never creates it
```

`FactRow` 不显示模型叙述，`DocumentBlock` 不伪装命令事实。一个 `actionId` 只能挂在一个
`FactRow`（或一个可逆 batch header）上；batch 展开后恢复同一 child rows，不产生新的
owner。`ResultRow` 是 execute turn 的唯一 outcome owner。

### 16.2 详细几何和状态

| 项目 | 固定规则 |
| --- | --- |
| 列布局 | 单列；document 和 fact 交错；所有 surface 左对齐 |
| 正文宽度 | `max-width: 760px`，超宽窗口保持可读行长 |
| 事实行 | `min-height: 28px`，16px icon，8px 间距，最多一个 disclosure |
| 成功态 | 轻量无背景行，默认折叠 |
| active/waiting | 同一行显示 `Working`/`Waiting`，默认打开 bounded detail |
| failed/blocked | 同一行 attention tint + 文本原因 + 可恢复控件（若有） |
| command output | 首屏 bounded tail；完整内容走同一行的 Show more 或 artifact viewer |
| 嵌套 child | 1px 左 rail + 8px inset；最多 depth=1；不改变字号和 row height |
| 滚动 | 只有 `ConversationFeedViewport` 有 `overflow-y`；Timeline/detail/batch 禁止建立纵向滚动 |

状态文案是闭集：`Queued`、`Working`、`Waiting`、`Waiting for approval`、`Succeeded`、
`Failed`、`Cancelled`、`Blocked`。icon、文本、`aria-label` 和 `data-*` 必须一致；颜色
只作为辅助，不能靠红绿或 spinner 让用户猜状态。

### 16.3 文档、代码和本地路径

- 连续空行保留为段落间距；list 使用真实 `ul/ol`，不能用空格伪造缩进。
- fenced code 保留换行、缩进和语言标签；未闭合 fence 在流式阶段以安全等宽文本原地更新。
- 普通文本中的本地路径显示 `file icon + basename`，hover/focus 显示完整路径并提供复制。
- 路径候选不可直接跳转；只有带 workspace/thread/run/action lineage 的 Host capability
  source ref 才能打开 file/diff/artifact viewer。
- Markdown 解析失败时保留安全纯文本并增加一行 `Blocked` diagnostic，不把全文压成事实行。

### 16.4 浮窗、输入区和完成结果

```text
EnvironmentPopover（active action 时存在，最多两行）
  Working · Engineer editing parser.ts
  ling-stack · feature/transcript

Composer（固定在 feed 之后）
  draft / send / stop / retry / approval controls
```

Popover 只展示 active run 的 ambient hint，terminal fence 后关闭；reconnect 只能短暂显示
`Reconnecting`。Composer 只拥有控制，不显示 action summary、stdout、文件统计或
TerminalReport。execute 的 `ResultRow` 必须留在 Timeline 中，不能再在输入框下方追加一份
“完成总结”。

### 16.5 视觉验收的最小 DOM 证据

每个 owning row 必须同时暴露：

```text
data-conversation-timeline-id
data-conversation-timeline-kind
data-conversation-timeline-renderer-key
data-conversation-timeline-status
data-conversation-timeline-revision
data-conversation-thread-id
data-conversation-run-id
data-conversation-attempt-id
data-conversation-participant-id
```

Feed 根节点必须能证明 `scrollOwnerCount=1`。在 normal/private/channel/topic/branch/child
上使用同一 fixture 时，除 shell/roster/participant rail 外的 DOM fingerprint 必须一致。
只提供 screenshot、没有 semantic 和 lineage 的结果不能作为 v3.9.1-final 的通过证据。

## 17. v3.9.1-final Codex-style 简洁配方（开工版）

Codex 的可借鉴点是信息分层和 renderer 边界，不是复制 TUI 的颜色。实现时只允许下面
三种可见 primitive；`NestedRail` 是布局 wrapper，不是第四套消息组件：

```text
DocumentBlock = author/meta（可选） + Markdown AST
FactRow       = 16px icon + Host 动词/目标 + 文本状态 + 一个 disclosure
ResultRow     = check/alert + Result + outcome/counters + 一个 disclosure
```

### 17.1 首屏与折叠算法

```text
1–2 个相邻、安全终态、同 lineage 的 read/command -> 普通 fact row（最多两行）
≥3 个相邻、安全终态、同 lineage 的 read/command -> 一个可逆 batch header
active / waiting / approval / failed / cancelled / blocked / consequential -> 永不隐藏
```

单个 detail 的 bounded preview 默认 ≤240px；command stdout/stderr 首屏最多 5 行/800
字符，失败最多 12 行/1600 字符，完整 tail 由同一 row 的 `Show more` 或 trusted artifact
打开。任何 detail、batch 或 nested child 都不能创建第二个 `overflow-y`。

### 17.2 统一文案和 icon

| kind | icon | 标题模板 | 状态来源 |
| --- | --- | --- | --- |
| command | terminal | `Run {commandSummary}` | Host action/exit |
| exploration | search | `Read/Search {targetSummary}` | Host read/search |
| file | file | `{Created/Edited/Deleted} {basename}` | file/diff evidence |
| tool | plug/bolt/people | `{verb} {target}` / `Delegated to {participant}` | typed tool result |
| approval | shield | `Waiting for approval` | approval state |
| terminalReport | check/alert | `Result · {status} · {counters}` | Completion Gate |

标题缺少安全目标时使用 provider/tool label，不能退化成只有 `Running…`、`Done` 或
`I will run …`。颜色、spinner 和 icon 都是辅助信息，`aria-label`、可见状态和
`data-conversation-timeline-status` 必须表达同一 machine value。

### 17.3 三种 surface 和 child 的视觉等价性

normal、private、channel/topic/branch 和 depth-1 child 采用同一个 document/fact/result
row grammar。允许不同的只有 shell title、roster、participant rail、policy hint 和
callback 可用性。以下内容一律回到同一 Timeline owning row：

- action start/update/end 和命令输出；
- file/diff/artifact 变化；
- child Agent narration、command、tool 和 terminalReport；
- approval、retry、stop 的状态和结果。

Composer 只放输入和控制，EnvironmentPopover 只放当前 active action 的最多两行 ambient
hint，Right Dock 只放被点击 source ref 的完整预览。它们不得各自复制 summary、output、
TerminalReport 或历史 activity。

### 17.4 视觉验收的最小证据

每个 surface 用同一 fixture，比较以下字段而不是要求像素完全相同：

```text
kind / order / stable id / status / revision / rendererKey
lineage ids / disclosureCount / scrollOwnerCount
```

截图只证明几何；`semantic-state.json` 证明 typed rows；`lineage.json` 证明事实来源；
脱敏日志证明 reconnect/restart/approval 的实际事件。缺任一项都不能把“看起来像 Codex”
标为完成。

### 17.5 Surface-level document composition

视觉上的“一个文档流”必须对应一个真实 DOM/状态 owner。以下结构不满足规范，即使每个
局部 row 都使用了同一个 renderer：

```text
MessageRow -> Timeline(message + facts)
MessageRow -> Timeline(message + facts)
ProtocolCard -> Timeline(protocol fact)
RunCard -> Timeline(run facts)
```

目标结构是：

```text
ConversationFeedViewport
  -> ConversationTimeline (one real LingThread)
       -> DocumentBlock
       -> FactRow
       -> DocumentBlock
       -> NestedRail (depth=1, same registry)
       -> ResultRow
```

author、time、edited、attachments、references 和 message actions 都是 shared
`DocumentBlock` 的 metadata/resource/interaction，不是外层气泡或第二张卡。protocol
actions 也必须落在 owning `FactRow` 的 typed control slot 或唯一 dialog；不能在 Timeline
下面再挂 route-local button strip。视觉验收须同时断言 `timelineOwnerCount=1`，否则不能
称为 normal/private/channel 已统一。
