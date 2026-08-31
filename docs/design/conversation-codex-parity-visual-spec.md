# Conversation Codex-Parity Visual Specification

Status: normative visual contract v3.1
Date: 2026-09-01
Base: `origin/main` @ `63ab7c0e`
Related: [Conversation Typed Transcript — Detailed Design](conversation-typed-transcript-detailed-design.md)

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

## 2. Row grammar

### 2.1 Fact row

```text
[16px icon]  Verb title · status                         [⌄]
             optional one-line detail / bounded tail
```

- icon 只表达 kind，不代替 status 文案；
- title 用动作动词：`Run pnpm test`、`Edited parser.ts`、`Read 8 items`；
- status 是可读文本：`Working`、`Succeeded`、`Failed`、`Waiting for approval`；
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
| 模型随口写出的 path | paragraph | 纯文本，不生成 `file://` 或 Host action |

同一 `agentMessage` 可以包含多个 content part；不能为了渲染方便把它们 flatten 成
一行，也不能把 code part 误归类为 `commandExecution`。

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
| `subAgentActivity` | participant | `Engineer · working` | nested timeline |
| `commandBatch` | terminal-stack | `Ran 4 commands` | exact children |
| `explorationBatch` | search-stack | `Read 8 items` | exact children |
| `diagnostic` | alert | `Activity unavailable` | repair/source refs |

## 4. Command and output

首屏至少显示真实命令摘要，不允许只写“执行中”：

```text
▣  Run pnpm test · Working                         [⌄]
   packages/ui › test/unit …
```

展开显示 exact command、cwd、stdout/stderr 的原始换行、exit code、duration、truncation
标记和 trusted artifact ref。成功最多 inline 5 行/800 字符，失败最多 12 行/1600 字符；
完整输出从同一 row 的 detail/raw action 打开。

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

## 5. 文件、路径和 diff

```text
▱  Edited parser.ts · +18 -4                    [⌄]
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

子 Agent 的叙述、计划、命令、文件和工具按父级相同顺序渲染；例如：

```text
Engineer  I will inspect parser.ts.                 (agentMessage)
          ⌁ Read src/parser.ts · Succeeded          (exploration)
          ▣ Run pnpm test · Failed · exit 1         (commandExecution)
          ⚠ Activity blocked · missing artifact     (diagnostic)
```

只有 `subAgentActivity` 这一层负责 participant label、lifecycle 和 rail；child item 不
再套一层“队友消息气泡”。深度超过 1 时显示结构化 blocked，而不是继续缩进导致乱码。

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

## 10. Responsive、density 和 a11y

| Token | 值/规则 |
| --- | --- |
| fact row hit target | ≥28px |
| icon | 16px；nested icon 14px |
| detail max height | 240px，超出 row 内滚动 |
| inline command tail | ≤40 lines、8KiB、64 chunks |
| activity region | 10 行后 `min(360px, 50vh)` |
| mobile/narrow | 隐藏次要 cwd/时间，保留 verb/status |
| reduced motion | 关闭插入/展开动画，保留状态变化 |

所有 disclosure 使用 native button + `aria-expanded`；状态必须有文本而非只用颜色；
`data-conversation-timeline-id`、`data-conversation-timeline-kind`、
`data-conversation-timeline-status`、`data-conversation-timeline-revision`、
`data-conversation-timeline-depth` 和 source ref 属性是稳定测试接口。

键盘路径必须与鼠标相同：Tab 进入 row，Enter/Space 切换唯一 disclosure，Escape 关闭
detail/popover，Enter 激活已授权的 file/diff ref。滚动容器只有一个；nested rail 不得
创建第二个 `overflow:auto` 容器。输出截断时显示 `truncated` 文本和完整 artifact 的
可访问名称。

## 11. 禁止的视觉回归

- 叙述被重新包成方形 WorkCell/bubble；
- 多条消息、列表或代码 fence 被 flatten 成一行；
- 命令没有真实动作描述或 stdout 被挤成一行；
- 一个 action 出现两次（assistant、WorkCell、TerminalReport、Composer）；
- 完成后又出现第二个红框 summary；
- 子 Agent 乱码、无动作描述或把 ready 文本当成功；
- activity rail、Composer、right dock 同时拥有同一个 approval 控件；
- 环境浮窗变成第二历史面板或 persistent summary。

## 12. Visual acceptance

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
