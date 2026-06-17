# Ling Agent Operation Cell UI

Status: implementation design patch for conversation UI
Date: 2026-06-14
Scope: channel conversation feed, Ling Agent session rows, multi-agent collaboration
projection, operation evidence, and interruption entry points

Related docs:

- [Ling Agent Session Control Plane](ling-agent-session.md)
- [Codex-Inspired Conversation Experience v1](codex-inspired-conversation-v1.md)
- [Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md)
- [Run Interruption And Continuation](run-interruption-continuation.md)
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [Conversation UI Framework And Copy Canon Implementation Plan](conversation-ui-framework-copy-implementation-plan.md)

## Summary

Ling Stack should merge two interaction models:

1. Codex-style operation cells: a running action is one semantic cell that mutates in
   place, commits once, and hides raw details behind evidence.
2. Multi-agent activity visibility, inspired by Grok-like agent surfaces: several
   specialist agents may work in parallel, but the user sees one coordinated task
   surface and one final answer, not a separate chat transcript for every agent.

The default channel feed is a cell stream, not a fixed report template. A turn may
contain coordinator text, operation rows, agent spans, artifact rows, or only an answer,
depending on the normalized events for that turn:

```text
user request
Ling Agent transcript
  TranscriptBlock[]
    coordinator text, only when useful
    OperationCell / AgentActivitySpan / ArtifactStrip as needed
    terminal result text, when there is a result to summarize
```

It should not read like this:

```text
Ling Agent started
Workflow event
Run event
Docs agent internal note
Engineer raw output
QA raw output
Collaboration card
Ling Agent completed
Right drawer duplicate
```

The product rule is simple: **one user task gets one visible work object**. Raw runtime
records, workflow ids, run ids, work-unit ids, JSON payloads, shell logs, provider
metadata, and packet artifacts are evidence, not first-level conversation concepts.

## Conversation UI Framework Boundary

Ling does not need to copy a terminal UI framework. Codex CLI uses a TUI renderer because
its product surface is a terminal; Ling is a Web application. The transferable layer is
the conversation rendering framework:

```text
raw runtime events
-> normalizer
-> semantic UI model
-> cell render contract
-> surface placement
```

This layer sits between daemon/runtime records and React components. It is responsible for
turning noisy event streams into user-facing cells before any component decides typography,
spacing, iconography, drawer width, or animation.

The first implementation can live in Web while the visible interaction is corrected, but
the layer is not a Web-only concept. The stable form should be a shared semantic
`ConversationTranscript` contract produced by daemon/core and consumed by Web, Desktop,
and CLI renderers:

```text
daemon/core projection
  -> ConversationTranscript / TranscriptBlock[]
  -> Web renderer
  -> Desktop renderer
  -> CLI/TUI renderer
```

CLI may render transcript blocks as terminal rows, but it must not become the owner of
conversation projection. Desktop may use native macOS styling, but it must consume the
same semantic transcript rather than copying Web grouping logic.

Non-goals:

- introducing `workflow`, `run`, `work-unit`, `packet`, or `raw event` as first-level user
  concepts;
- replacing the existing Web layout with a terminal-like UI;
- making the right drawer a second transcript;
- making the floating run popover a log viewer;
- changing storage before a projection model proves the UI contract.

## Complete UI Layer Contract

The missing layer is not another runtime abstraction. It is a Web UI projection layer
that turns existing conversation, workflow, run, approval, artifact, and teammate records
into a Codex-style transcript with Ling-specific multi-agent actors.

The target feed shape is deliberately heterogeneous:

```text
ConversationTurn
  UserMessageCell
  LingAgentTranscript
    blocks: TranscriptBlock[]
```

`TranscriptBlock` is an ordered stream. It can contain coordinator text,
assistant text, operation cells, agent activity spans, approval cells, artifact strips,
and raw/detail references. A block appears only when the underlying semantic event needs
that user-facing shape. Do not pad every turn into the same set of headings.

For single-agent work, a possible rendering is:

```text
User: 创建一个 login.html...

Ling Agent
可以，先创建 login.html，并做一次基础检查。

读取项目结构和现有入口 ˅
创建 login.html ˅
运行 2 条检查命令 ˄
  Searched for login.html | package.json | src in workspace
  Read package.json
  $ node --check login.html

login.html 已创建，检查通过。
产物 login.html · 变更 1 个文件 · 检查 2 项通过
```

For serial multi-agent work, a possible rendering is:

```text
Ling Agent
这个任务交给 Engineer 实现，QA 做验收。

Engineer
  查看项目结构 ˅
  修改 login.html ˅
  运行检查 ˄

QA
  验证页面 ˅
  截图检查 ˅

login.html 已创建，检查通过。协作队友：Engineer、QA。
```

For parallel multi-agent work, the default feed shows one compact branch per active
teammate and only the latest active row for each branch:

```text
Ling Agent
拆成两个并行任务：Engineer 实现，QA 准备验收。

Engineer
  正在修改 login.html

QA
  正在准备检查清单
```

The user's default reading path is the coordinator narrative and the latest state. Older
per-agent rows remain folded under the corresponding `AgentActivitySpan`.

These examples are illustrative only. They must not become string templates or parser
rules. The UI structure comes from the semantic projection, not from matching phrases
such as `确认需求` or `完成`.

## Raw Event Normalizer

The normalizer is the only layer allowed to understand raw runtime vocabulary. It consumes
daemon/channel/workflow/run records and produces semantic UI inputs.

```ts
type RawEventSource =
  | "message"
  | "intent_router"
  | "target_resolver"
  | "workflow"
  | "run"
  | "tool"
  | "file"
  | "approval"
  | "artifact"
  | "sub_agent"
  | "memory"
  | "interruption";

interface RawEventEnvelope {
  readonly id: string;
  readonly source: RawEventSource;
  readonly occurredAt: string;
  readonly channelId: string;
  readonly messageId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly workUnitId?: string;
  readonly agentId?: string;
  readonly payload: unknown;
}

interface NormalizedOperationInput {
  readonly turnId: string;
  readonly operationId: string;
  readonly actorId: string;
  readonly actorRole: "coordinator" | "agent" | "tool" | "system";
  readonly semanticKind: OperationKind;
  readonly status: OperationCellStatus;
  readonly displayText: string;
  readonly evidenceRefs: readonly string[];
  readonly rawEventIds: readonly string[];
}
```

Normalizer rules:

- Group events by user turn first, then operation, then actor.
- Use stable semantic operation ids, not raw event ids, as React keys.
- Collapse start/progress/complete events for the same operation into one active cell.
- Preserve every raw event behind `rawEventIds`; do not lose auditability.
- Convert internal vocabulary into user-facing verbs before it reaches React.
- Treat stale, duplicate, and out-of-order events as evidence unless they change the
  current user-facing state.
- Keep `intent_router` and `target_resolver` output internal by default. Surface it only
  when it changes the user's next action, for example "needs confirmation" or "cannot
  resolve target".

## Raw Event Mapping Table

| Raw input | Normalized output | Default feed | Expanded detail | Raw/debug access |
| --- | --- | --- | --- | --- |
| user message committed | `UserMessageCell` | user text | attachments and referenced files | original message metadata |
| coordinator text delta/final | `CoordinatorMessageCell` | natural reply or final result | related operation link | raw model item when debug is enabled |
| intent/router decision | evidence on turn | hidden | route rationale only if user asked | classifier scores, candidates, payload |
| workflow created/updated | `OperationCell` / `plan` row | `已规划 N 步` | semantic steps | workflow JSON, ids |
| run started/progress/completed | active `OperationCell` mutation | current task state | row history | run events, attempt ids |
| tool call start/output/end | `OperationRow` | `读取文件`, `运行检查`, `搜索文档` | command/tool summary and bounded output | full stdout/stderr, tool JSON |
| file read/context packet | `read` row or evidence ref | hidden unless it explains action | file names, snippets if useful | packet payload, context ids |
| file write/patch/artifact | `edit` row plus `ArtifactStrip` | changed file summary | inline changed-file summary; full preview/diff can open result review | raw patch, artifact metadata |
| approval requested/resolved | `ApprovalCell` | waiting/approved/denied state | command/action and risk context | policy payload, request ids |
| sub-agent spawned/updated/completed | `AgentActivitySpan` | agent label and latest action | semantic process rows under the agent span | raw sub-thread events only |
| memory surfaced | memory evidence row | hidden unless it affects answer | memory title/source | raw memory ids and scoring |
| queued follow-up | active operation row | `Queued follow-up` | queued text preview | continuation request payload |
| interrupt/redirect | active operation state | `Stopped and redirected` | lineage and reason | cancellation/run lineage events |

## Codex-Inspired Disclosure Levels

Codex has more than `HistoryCell`, but the conversation feed should borrow these specific
UI layers:

| Layer | Ling translation | Default visibility |
| --- | --- | --- |
| committed history cells | committed user/coordinator/operation rows | visible |
| active cell | one mutable active operation per running span | visible, mutates in place |
| transcript detail | inline expanded operation, agent, source, and artifact detail | collapsed |
| bottom pane / composer | input, queue follow-up, interrupt/redirect, approval affordances | visible near composer |
| approval / ask user surfaces | explicit authority or missing-input requests | visible when blocking |
| artifact/status surfaces | product files, changed files, checks, active status | compact summary |

`OperationCell` remains the main Ling equivalent of a Codex `HistoryCell`, but Ling adds
`Actor` and `AgentActivitySpan` so multi-agent work does not become either raw internal
chat or a separate collaboration card system.

## Codex Source Alignment

The Codex source review on 2026-06-16 creates these Ling design constraints. These are
framework rules, not visual-copy rules.

| Codex source area | Observed mechanism | Ling rule |
| --- | --- | --- |
| `chatwidget.rs` | `active_cell` mutates while a tool/stream is in flight, then `flush_active_cell()` inserts the finalized cell into history. | A running operation updates the same `OperationCell`; terminal state commits the same cell instead of appending a replacement summary. |
| `chatwidget/transcript.rs` | `TranscriptState` owns `active_cell`, `active_cell_revision`, turn flags, and copyable agent markdown. | Keep turn state separate from visible copy. Do not infer UI structure by matching generated coordinator text. |
| `chatwidget/turn_lifecycle.rs` | `agent_turn_running` is derived turn state, independent of any one history cell or overlay. | Running popover/composer affordances derive from turn lifecycle and active cells, and must clear when the turn finishes. |
| `history_cell/mod.rs` | Each `HistoryCell` provides `display_lines`, `raw_lines`, and optional `transcript_lines`. | Every Ling cell needs display, expanded, and raw/detail render contracts. The main feed cannot be the raw/debug surface. |
| `exec_cell/model.rs` | `ExecCell` stores command calls keyed by `call_id`; output chunks append to that call; `complete_call` records output and duration. | Command/tool/file/check operations must have stable operation ids and update their own state in place. Stdout chunks update evidence, not the feed row list. |
| `exec_cell/render.rs` | Exec display switches `Running` to `Ran`/`You ran`; read/list/search calls coalesce into `Exploring`/`Explored`; tool output defaults to bounded lines. | Low-level exploration commands group under semantic rows. User-meaningful commands get compact rows with bounded inline output and full raw detail elsewhere. |
| `history_cell/search.rs` | `WebSearchCell` changes `Searching the web` to `Searched the web` by toggling cell state. | Lightweight browser/search/memory cells use the same status mutation pattern: running label becomes terminal label on the same row. |
| `pager_overlay.rs` | Transcript overlay owns committed cells plus a cached live tail derived from the current active cell; cache key changes on revision/animation/width. | Inline expanded detail can include live active detail, but it must not duplicate the main transcript. Raw/debug detail surfaces must refresh when a cell mutates if they are explicitly open. |
| `chatwidget/streaming.rs` | Assistant text deltas stream through a controller, then consolidate into one final markdown cell; reasoning deltas update status, not transcript. | Coordinator/assistant prose is streamed text inside the same turn transcript, not fixed start/end cards. Internal reasoning/status must not become default conversation rows. |

The transferable model is:

```text
raw event
  -> semantic cell route
  -> active mutable cell
  -> terminal committed cell
  -> display / expanded / raw render modes
```

The non-transferable part is Codex's terminal UI implementation. Ling should not clone
Ratatui layout, terminal keybindings, or English labels such as `Running` and `Ran`.

## Cell Render Contract

Every user-facing cell supports three render modes. Components may style these modes
differently, but they may not invent extra default content outside this contract.

```ts
interface ConversationCellRender {
  readonly display: DisplayLine[];
  readonly expanded?: ExpandedDetail;
  readonly raw?: RawDetailRef;
}

interface DisplayLine {
  readonly icon?: string;
  readonly text: string;
  readonly tone?: "normal" | "muted" | "success" | "warning" | "danger";
  readonly isActive?: boolean;
}

interface ExpandedDetail {
  readonly sections: readonly EvidenceSection[];
  readonly defaultOpenSectionIds: readonly string[];
}

interface RawDetailRef {
  readonly drawerTarget: string;
  readonly rawEventIds: readonly string[];
}
```

Render-mode rules:

- `display` is the default transcript. It must be short, stable, and user-readable.
- `expanded` is semantic detail. It can show command names, bounded output, changed files,
  checks, approvals, and branch summaries.
- `raw` is developer/support detail. It owns full JSON, raw events, provider metadata,
  ids, stdout/stderr, and packet payloads.
- Copy/export can choose `display`, `expanded`, or `raw`; the default user copy should not
  include raw event spam.
- Search should index `display` and selected `expanded` fields first; raw fields are debug
  search only.

## Surface Placement Contract

| Surface | Owns | Must not own |
| --- | --- | --- |
| Main conversation feed | user messages, coordinator narrative, operation display rows, active cell, final summary, artifact strip | raw event logs, duplicate collaboration cards, workflow/run ids |
| Floating run popover | current running state, active actor, elapsed time, interrupt affordance, latest one-line action, compact source icons while active | full transcript, raw output, historical collaboration record |
| Right drawer | completed-result review, changed/generated files, artifact preview, file preview, diff/review, source metadata, settings, explicit raw/debug support | active progress, operation process transcript, AgentActivitySpan history, a second copy of the main conversation, or the same inline evidence |
| Inline expansion | semantic evidence needed for normal audit: operation steps, commands, bounded output, files, checks, approvals, agent process rows, source summary | unbounded logs, JSON dumps, provider metadata |
| Source summary strip | compact evidence sources from tools, web, memory, files, and apps | operation history, raw events, internal helper tools |
| Modal / blocking view | approval, missing input, permission change, destructive confirmation | passive status or historical logs |
| Composer active-work affordance | normal send, queue follow-up, stop-and-redirect | hidden prompt injection or implicit interruption |

Placement rules:

- The same fact has one default surface.
- If main feed display already says an operation completed, the floating popover hides or
  moves to idle state.
- If inline expansion already exposes semantic evidence, the right drawer opens only for
  completed result review, file/diff/artifact preview, source metadata, or explicit
  raw/debug support. It must not reopen the same operation process as a second transcript.
- If a modal is blocking, status surfaces may stay visible but should not compete with the
  blocking decision.
- If multiple agents are active, the floating popover summarizes the coordinator view and
  the main feed shows bounded `AgentActivitySpan` rows.

## Visual Contract

The accepted visual target is:

- design system: `Ling Stack Strict Daylight UX v3 - Channel Drawer v1.24`;
- Stitch project: `projects/3112180709682189824`;
- Stitch screen reference: `频道会话 - Strict Codex Transcript v1`;
- style: Strict Daylight, pure white surfaces, Inter typography, monochrome hierarchy;
- sidebar: the locked v3 Chinese Ling Stack sidebar;
- conversation body: borderless transcript, not a dashboard or card stack.

Default conversation feed rules:

- User messages may use compact bubbles.
- Coordinator messages are plain text with the Ling Agent identity.
- Operation group rows are muted inline rows with a small icon and disclosure chevron.
- Expanded operation detail is indented text; it is not a panel.
- Command output may use one compact code block because it is evidence output.
- Active cells update in place; they do not append a new card or toast for every event.
- Agent spans use small labels, avatars, and faint lane lines, not cards.
- Artifact strips may have a very light product affordance; operation logs may not.
- The right drawer is for completed result review, file/diff/artifact preview, settings,
  and explicit raw/debug support. It is not where normal `OperationCell` process detail
  lives.
- Do not show `workflow`, `run`, `work-unit`, `packet`, `attempt`, selector ids, raw
  event labels, provider metadata, token budgets, or JSON in the default feed.

The feed must avoid four-layer repetition:

```text
Coordinator message
+ collaboration card
+ right drawer duplicate
+ raw event log
```

The intended replacement is:

```text
Coordinator narrative
+ operation/agent transcript rows
+ expandable evidence
+ artifact strip
```

## Transcript Visual Polish v4 Addendum

This addendum captures the approved follow-up direction from the Strict Daylight v3 /
Strict Codex Transcript v4 mockup. It is a UI-layer patch, not a new information model.

### Inline Operation Detail

`OperationCell` detail belongs in the main transcript. The default row is compact; the
expanded state reveals semantic process rows in place.

Rules:

- Expand/collapse happens on the operation row itself.
- Expanded content is indented transcript text, not a bordered panel, card, or drawer.
- Commands, tool calls, file modifications, checks, approvals, bounded output excerpts,
  source counts, and agent process rows can appear inline.
- Completion freezes the same `OperationCell` as a committed folded row. The final
  coordinator summary is appended after it; it must not replace it.
- Normal audit should be possible without opening the right drawer.
- Full raw payloads, provider metadata, ids, unbounded logs, and complete stdout/stderr
  remain explicit raw/debug access.

### Result Summary And Artifact Strip

The terminal transcript must show useful outputs in the same turn, immediately after the
coordinator terminal text.

Default shape:

```text
产物 1 · 变更 3 个文件 · 检查 4 项通过

产物
  login.html  HTML · 已创建
  login-preview.png  图片 · 1280×720

变更
  apps/web/src/login.html  +86 -0
  apps/web/src/styles/login.css  +24 -0
```

Rules:

- Show the compact result summary even when no drawer is opened.
- Artifact rows are plain transcript rows with small type/icon affordances, not chips or
  cards.
- Changed-file rows can show path, action, and concise diff stats.
- Check rows can show status and command/check name.
- The right drawer may show full file preview, diff review, generated artifact preview,
  and audit/review details after the task completes. It must not repeat the same artifact
  strip as the first visible drawer content.

### Inline Image And Screenshot Preview

Images and screenshots produced by a task are first-class transcript artifacts.

Rules:

- Show a small inline thumbnail under the result/artifact section.
- Thumbnail size is constrained and stable; it must not push text into overlap or resize
  the transcript during load.
- Clicking a thumbnail opens a larger preview/lightbox with filename, dimensions when
  available, close action, and optional open/download action.
- The lightbox is a preview surface, not a second transcript or progress surface.
- If the same image also appears in the right drawer, the drawer version is for file
  review after completion, not for operation process reading.

### Active Shimmer Motion

Use shimmer / scanning highlight / breathing shimmer only to indicate active work.

Rules:

- Apply to active status text or the active operation row background mask only; do not
  animate completed rows, artifacts, final summaries, images, or the full transcript.
- Cycle: `3000ms` total, about `800ms` left-to-right sweep and `2200ms` rest.
- Visual weight: very light neutral highlight on Strict Daylight surfaces. It should feel
  like a subtle breathing status, not a loading skeleton.
- Running state examples: active coordinator thinking line, active `OperationCell`, active
  agent latest-action row, and floating popover latest-action text.
- Terminal transition removes shimmer on the same row when state changes to succeeded,
  failed, blocked, cancelled, or interrupted.
- Respect `prefers-reduced-motion: reduce` by disabling the sweep and using static tone
  or spinner state instead.

### Right Drawer Boundary After v4

The right drawer is a completed-result and review surface:

- `Files`: generated files, changed files, file preview, diff preview.
- `Review`: completed-task audit/review details, approval decisions, checks, and artifact
  review when needed.
- `Settings`: channel/runtime settings.
- Explicit raw/debug detail can be opened from developer/support affordances, but it is
  not a normal user reading path.

The drawer must not own:

- active progress;
- operation process transcript;
- agent process history;
- completed operation rows already available inline;
- copied coordinator start/final text;
- a root `Progress` page.

## User-Facing Cell Roles

| Role | Default feed behavior | Detail behavior |
| --- | --- | --- |
| `UserMessageCell` | durable user message | attachments and file refs can expand inline |
| `CoordinatorMessageCell` | Ling Agent narrative, plan, clarification, or final result | no raw logs; links to the related operation when needed |
| `OperationCell` | one compact task/process cell, active or terminal | expands to semantic operation rows and evidence |
| `AgentActivitySpan` | one compact latest-action row per participating teammate | expands to prior semantic actions and evidence refs |
| `ApprovalCell` | visible only when user authority is needed | expands to command/action payload and policy context |
| `SourceSummaryStrip` | compact source icons in active popover or inline detail surfaces | expands inline or in metadata detail to source names, urls, tool/app metadata, and related operation refs |
| `MemoryCitationFooter` | compact used-memory footer under the owning coordinator/agent message | expands to memory title, scope, source refs, recall policy, and used-memory event ids |
| `EvidenceDetail` | collapsed by default inside the owning transcript row | exact files, commands, bounded outputs, checks, approvals, source refs; raw events, JSON, and logs only through explicit raw/debug access |

`Workflow`, `Run`, `WorkUnit`, `Attempt`, `Packet`, and `RouteDecision` are data model
and audit terms. They should not appear as default UI labels in the main feed.

Memory citations and source summaries follow
[Conversation Memory Citations And Sources](conversation-memory-citations-and-sources.md).
Memory citation is answer evidence. Source summary is context inventory. OperationCell is
execution evidence.

## Coordinator Message Contract

Ling Agent is the coordinator and user-facing narrator. Its messages are for:

- confirming scope when the user needs confidence that work started correctly;
- asking a clarification when intent or safety is unclear;
- explaining a blocked state in human terms;
- summarizing the final result and next action.

Ling Agent messages are not for:

- repeating operation status already shown in an `OperationCell`;
- listing every specialist step;
- telling the user to open a separate evidence drawer when inline evidence already exists;
- exposing workflow, run, work-unit, packet, or selector ids.

Rules:

- A user turn with executable work renders one `ConversationTurnAssistantTranscript`.
  The start copy, operation cell, and terminal copy are segments inside the same Ling
  Agent transcript row. They must not render as two separate Ling Agent replies with
  duplicated avatar/header chrome.
- A started task should not create both a coordinator "start" message and a separate
  "work started" cell unless the coordinator message carries meaningful planning or
  safety context.
- A completed task should have one final result surface. Prefer a terminal
  `CoordinatorMessageCell` plus the same task's terminal `OperationCell`, not multiple
  completion reminders.
- If the `OperationCell` summary already says the task completed, the coordinator
  message should add outcome information, not repeat counts.

## Ling Agent Copy Canon

Ling Agent copy follows the same product principle as the cell model: default text should
describe the user's task, current action, result, or required decision. It should not
describe the UI system itself.

Core rules:

- Use concise Chinese first. Keep English only for product, file, command, model, provider,
  and teammate names.
- First-person wording is allowed when it is the most natural user-facing sentence.
- Do not use empty self-announcement or explain the UI mechanism, for example
  `细节放在折叠证据里`, `主会话会同步状态`, or `查看右侧抽屉了解完整细节`.
- Do not expose internal nouns in default copy: `workflow`, `run`, `work-unit`, `packet`,
  `attempt`, `raw event`, selector ids, provider metadata, token budgets, or JSON.
- Use active, observable verbs: `确认`, `拆分`, `交给`, `读取`, `修改`, `运行`, `检查`,
  `等待`, `完成`, `阻塞`, `取消`, `中断`.
- Keep status text stable while active cells mutate. Prefer replacing the row body over
  appending new near-duplicate lines.
- If a fact already appears in an operation row, coordinator copy should add judgement or
  result, not repeat the same status.

Message examples, not required prefixes:

| Situation | Pattern | Example |
| --- | --- | --- |
| Scope context | natural acknowledgement or plan, only when useful | `可以，先创建 login.html，并做一次基础检查。` |
| Safe delegation | natural delegation sentence | `实现交给 Engineer，验收交给 QA。` |
| Parallel split | compact split sentence | `拆成两个并行任务：Engineer 实现，QA 准备验收。` |
| Clarification | direct question | `登录页是否要接入真实 API？` |
| Blocked | reason plus next action | `缺少写入权限。批准后继续修改文件。` |
| Waiting approval | action that needs authority | `等待审批：运行 pnpm install。` |
| Completed | result and useful verification | `login.html 已创建，检查通过。` |
| Interrupted | what changed and what follows | `已按新的方向停止当前处理。` |
| Cancelled | cancellation result | `已取消，未继续运行检查。` |

No implementation may parse these strings to decide whether a message is start,
terminal, delegated, or blocked. That structure must come from turn/cell metadata.

Operation row copy:

| Operation kind | Running | Succeeded | Failed/blocked |
| --- | --- | --- | --- |
| `plan` | `规划步骤` | `已规划 {n} 步` | `规划受阻：{reason}` |
| `read` | `读取项目结构` | `已读取 {target}` | `无法读取 {target}` |
| `edit` | `修改 {file}` | `已修改 {count} 个文件` | `修改失败：{reason}` |
| `run_command` | `运行 {command}` | `检查通过` or `命令完成` | `检查失败：{command}` |
| `search` | `搜索 {target}` | `已搜索 {target}` | `搜索失败：{reason}` |
| `approval` | `等待审批：{action}` | `审批已通过` | `审批被拒绝` |
| `verify` | `检查 {target}` | `{count} 项检查通过` | `{count} 项检查失败` |
| `handoff` | `{agent} 处理中` | `{agent} 完成` | `{agent} 阻塞：{reason}` |
| `watch` | hidden by default | hidden by default | `监控发现问题：{summary}` |

Surface-specific copy rules:

| Surface | Copy shape | Max default length | Forbidden |
| --- | --- | --- | --- |
| Coordinator message | natural sentence, result-oriented | 1-3 short sentences | empty self-announcement, UI explanation, raw ids |
| Operation row | verb + object + state | one line | paragraphs, raw stdout, JSON |
| Agent span | `{agent} · {latest action}` | one line per agent | full agent transcript by default |
| Floating run popover | `{actor} · {elapsed} · {latest action}` | one line plus optional action icon | history, logs, completed summaries |
| Inline expanded detail | semantic evidence bullets | bounded section | unbounded logs, provider metadata |
| Right drawer raw detail | technical labels and exact payloads | folded sections | repeated coordinator summary |
| Approval modal | action + scope + consequence | title plus options | vague `continue?` prompts |

Approval copy must be explicit:

```text
等待审批：运行 pnpm install。

允许本次运行
允许本会话内同类命令
拒绝，并说明下一步
```

Bad approval copy:

```text
是否继续？
处理权限请求
执行操作
```

Examples to reject in review:

```text
主agent：主会话会同步关键状态和最终结果。
协作记录：workflow run work-unit 已完成。
查看右侧抽屉了解完整细节。
当前 raw event packet 已写入。
Agent finished task successfully.
```

Accepted replacements:

```text
Ling Agent：可以，先创建 login.html。
Engineer：正在修改 login.html。
QA：等待实现完成后验收。
Ling Agent：login.html 已创建，检查通过。协作队友：Engineer、QA。
产物 login.html · 变更 1 个文件 · 检查 2 项通过
```

Copy regression rules:

- Snapshot tests should pin coordinator start, active operation, blocked, approval,
  completed, interrupted, multi-agent parallel, and drawer-open states.
- E2E checks should reject visible default text containing `workflow`, `run`, `work-unit`,
  `packet`, `raw event`, `attempt`, `selector`, or JSON braces in the main feed.
- Tests should assert no visible UI-mechanism coordinator phrasing in generated UI fixtures.
- Tests should assert the right drawer title and sections do not duplicate the coordinator
  final summary.

## OperationCell Model

`OperationCell` is the Web translation of Codex's `HistoryCell` idea. It is not a raw
event row. It is a semantic projection of lower-level records.

```ts
type OperationCellStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "failed"
  | "cancelled"
  | "succeeded";

type OperationKind =
  | "plan"
  | "read"
  | "edit"
  | "run_command"
  | "search"
  | "approval"
  | "verify"
  | "handoff"
  | "watch";

interface OperationCell {
  readonly id: string;
  readonly sourceMessageId: string;
  readonly coordinatorMessageId?: string;
  readonly title: string;
  readonly status: OperationCellStatus;
  readonly displayLabel: string;
  readonly terminalLabel?: string;
  readonly summary: string;
  readonly activeOperation?: OperationRow;
  readonly operationRows: readonly OperationRow[];
  readonly agentSpans: readonly AgentActivitySpan[];
  readonly evidenceSummary: EvidenceSummary;
  readonly evidenceKey: string;
  readonly updatedAt: string;
}

interface OperationRow {
  readonly id: string;
  readonly kind: OperationKind;
  readonly status: OperationCellStatus;
  readonly label: string;
  readonly activeLabel?: string;
  readonly terminalLabel?: string;
  readonly summary?: string;
  readonly durationMs?: number;
  readonly evidenceKey?: string;
}

interface AgentActivitySpan {
  readonly id: string;
  readonly teammateName: string;
  readonly roleLabel?: string;
  readonly status: OperationCellStatus;
  readonly currentAction?: string;
  readonly resultSummary?: string;
  readonly evidenceKey?: string;
}
```

The UI can derive this model from current workflow, run, approval, artifact, and
legacy collaboration records before adding new storage. Labels are state-derived:
`activeLabel` renders while running, and `terminalLabel` replaces it on the same row
after success, failure, cancellation, or blocking.

## OperationCell Micro-Spec

`OperationCell` is a transcript group, not a card. It should feel like a compact CLI/TUI
history cell adapted to Web typography.

Geometry:

| Token | Value | Rule |
| --- | --- | --- |
| row min-height | 28px | compact transcript row; do not grow on hover |
| row vertical gap | 2px | adjacent operation rows stay visually connected |
| group top gap | 8px | separates operation group from coordinator text |
| icon slot | 16px | status icon only; no colored badge container |
| chevron slot | 16px | shown only when expanded detail exists |
| content indent | 24px | expanded detail aligns under row text, not under icon |
| nested indent | 16px | command output, files, checks, and branch details |
| max row width | parent text column | do not stretch into drawer gutter |

Default row structure:

```text
[status icon] [label text] [muted metadata] [chevron]
```

No outer border, no card background, no pill button, no shadow. Hover may only reveal a
subtle text color change and focus outline for keyboard users.

State visual table:

| Status | Icon guidance | Text tone | Motion | Chevron behavior |
| --- | --- | --- | --- | --- |
| `queued` | `Clock3` or hollow dot | muted | none | available if detail exists |
| `running` | spinner or pulsing dot | primary | subtle spinner only | available; active row stays in place |
| `waiting_for_approval` | `CircleAlert` | warning text only | none | detail opens approval context |
| `blocked` | `OctagonAlert` | warning/danger | none | detail opens reason and next action |
| `failed` | `CircleX` | danger | none | detail opens failed check/output |
| `cancelled` | `Ban` | muted | none | detail opens lineage if useful |
| `succeeded` | `CircleCheck` | muted success | none | detail opens evidence |

Operation kind icon table:

| Kind | Suggested icon | Example label |
| --- | --- | --- |
| `plan` | `ListChecks` | `规划 3 步` |
| `read` | `FileSearch` | `读取项目结构` |
| `edit` | `PencilLine` | `修改 login.html` |
| `run_command` | `Terminal` | `运行 pnpm typecheck` |
| `search` | `Search` | `搜索相关文件` |
| `approval` | `ShieldCheck` | `等待审批：运行 pnpm install` |
| `verify` | `BadgeCheck` | `检查通过` |
| `handoff` | `Users` | `Engineer 处理中` |
| `watch` | `Activity` | hidden unless it changes next action |

Chevron rules:

- Collapsed rows use a right-facing chevron.
- Expanded rows use a down-facing chevron.
- Rows with no semantic detail do not show a chevron.
- Clicking the row label or chevron toggles expansion.
- Keyboard focus uses the row as one target; Enter/Space toggles expansion.
- Running rows can be expanded, but expansion must not create new active rows.

Expanded detail order:

```text
Operation row
  Summary
  Commands
  Files
  Checks
  Approvals
  Artifacts
  Agent branch details
```

Section limits:

| Detail section | Default max | Overflow behavior |
| --- | --- | --- |
| summary | 2 lines | truncate with ellipsis |
| commands | 3 commands | remaining commands counted |
| command output | 5 lines per command | full output through explicit raw/debug access |
| changed files | 6 files | remaining files counted |
| checks | 5 checks | show failed checks first |
| approvals | 3 decisions | most recent first |
| artifacts | 4 items | remaining artifacts counted |
| agent activity history | latest 3 semantic actions per agent | older semantic actions stay folded under the same agent span |
| raw event ids | hidden | explicit raw/debug access only |

Command detail shape:

```text
  $ pnpm typecheck
    0 errors
    completed in 2.4s
```

File detail shape:

```text
  修改 login.html
  新增 apps/web/src/login.html
```

Check detail shape:

```text
  检查通过 pnpm typecheck
  检查失败 pnpm test --filter login
```

Update behavior:

- `running` mutates the same row text and status icon.
- Running labels and terminal labels are two states of the same row. Example:
  `正在连接浏览器` becomes `已连接浏览器`; it must not append a second row.
- New semantic actions append under the same `OperationCell` only when they are new
  user-visible steps.
- Raw stdout chunks do not append rows. They update bounded command output in expanded
  detail or raw detail.
- `succeeded`, `failed`, `blocked`, `cancelled`, and `interrupted` are terminal for the
  visible row unless a linked redirect creates a new operation.

Command/tool row rules:

- User-meaningful commands can show one command row in the transcript.
- Read/list/search commands should coalesce into an exploration/read-context row unless
  one command changes the user's next action.
- Command output is bounded in inline expanded detail. Full stdout/stderr, exit code,
  raw command array, environment, and call ids belong in explicit raw/debug access.
- Output chunks mutate the command row's evidence; they do not create visible rows.
- Completion records duration and status on the same row.

## AgentActivitySpan Micro-Spec

`AgentActivitySpan` makes multi-agent work visible without turning each teammate into a
separate default transcript.

Default row structure:

```text
[avatar] [agent name] [status] [latest action]
```

Visual rules:

- Use a faint vertical lane line only when two or more agent spans are visible.
- Agent rows are not cards and do not have individual backgrounds.
- Avatar size is 20px; name uses label text; latest action is body text.
- Completed agents collapse to one result line unless expanded.
- Failed or blocked agents remain visible until coordinator summary resolves the task.

Display variants:

| Variant | Default display | Detail behavior |
| --- | --- | --- |
| single delegated agent | show agent label only if delegation matters | operation rows remain primary |
| serial agents | show completed prior agent and active current agent | prior history folded under each agent |
| parallel agents | show one latest-action row per active agent | each row expands independently |
| completed collaboration | show names in final coordinator summary and artifact strip | branch details stay folded |
| direct teammate chat | teammate owns the conversation surface | not an `AgentActivitySpan` |

Ordering rules:

- Preserve the first semantic appearance order of participating agents inside the
  workflow transcript. Status changes may change row tone, but they must not reorder
  spans by severity, state, or label.
- The coordinator terminal line uses the same agent order as the visible
  `AgentActivitySpan` rows.

State table:

| Agent status | Default text | Visibility |
| --- | --- | --- |
| queued | `{agent} · 等待开始` | visible only if parallel plan was announced |
| running | `{agent} · {latest action}` | visible and mutable |
| waiting_for_approval | `{agent} · 等待审批` | visible until resolved |
| blocked | `{agent} · 阻塞：{reason}` | visible and emphasized |
| failed | `{agent} · 失败：{summary}` | visible until coordinator handles it |
| cancelled | `{agent} · 已取消` | visible only if user initiated or affects result |
| succeeded | `{agent} · {result summary}` | collapses after coordinator summary |

Latest-action update rules:

- Each agent has one mutable latest-action line.
- Tool/event spam updates evidence, not the latest-action line, unless it changes the
  user's understanding of progress.
- If an agent emits a useful assistant summary, use that as `resultSummary`.
- If an agent only emits tool activity, synthesize a semantic action from the tool kind.
- Do not show raw agent internal reasoning by default.
- Completion changes the default row state; it does not delete the agent's process.
  Historical semantic actions remain available behind that agent row.
- Do not surface generic internal step verbs as user-facing latest actions. `Consult`,
  `Review`, `Coordinate`, `Coordinated`, `Reviewed`, and `flagged_risk` are fallback
  implementation labels, not conversation copy.

History folding:

```text
Engineer · login.html 已创建
  查看项目结构
  修改 login.html
  检查通过
```

Lifecycle:

```text
running:
Engineer
  正在修改 login.html

completed, default:
Engineer
  修改 login.html 完成

completed, expanded:
Engineer
  查看项目结构
  修改 login.html
  运行检查
```

Coordinator message projection:

- Start and terminal coordinator messages are semantic display bodies in the default
  transcript. Generated request text such as `开始 workflow: ... Smoke ID: ...` is not
  repeated back to the user.
- Start copy confirms scope and delegation.
- Terminal copy reports the result and, when applicable, the teammate names.
- Raw coordinator message text can remain reachable through audit/detail surfaces, but
  not in the default conversation reading path.

Folded history limits:

- show latest 3 semantic actions by default;
- keep failed/blocked action pinned even if older;
- show changed files and checks before raw tool events;
- semantic sub-agent history expands inline under the agent row;
- raw sub-thread transcript is raw/debug access only.

Parallel behavior:

- Sort active agents by coordinator-declared order, not event arrival order.
- If more than 3 agents are active, show the first 3 plus `另有 {n} 个队友处理中`.
- The floating run popover summarizes the coordinator state, not every agent.

## Floating Run Popover Micro-Spec

The floating run popover is an ambient status surface. It is not a drawer, transcript, or
collaboration record.

Default shape:

```text
[spinner/status] {actor} · {elapsed} · {latest action} [stop]
```

Placement:

- Desktop: top-right of the channel work area, never covering the composer.
- Drawer open: hide the popover or reduce it to a one-line header status inside the drawer
  chrome; do not show both full popover and drawer progress.
- Mobile: collapse into the composer status strip.

State behavior:

| Operation state | Popover behavior | Primary action |
| --- | --- | --- |
| no active work | hidden | none |
| queued | hidden unless user has queued follow-up | edit queued input |
| running | visible | stop/interrupt |
| waiting_for_approval | visible but points to approval surface | review approval |
| blocked | visible until user sees blocker | resolve blocker |
| failed | visible briefly, then main feed owns failure | view failed row |
| cancelled | hide after terminal feed row commits | none |
| succeeded | hide after final summary/artifact strip commits | none |

Content rules:

- Show one actor. For single-agent work use the executing agent. For multi-agent work use
  `Ling Agent` when coordination is the useful state, or the specific active agent when
  only one branch is currently changing.
- Latest action is one short phrase, not a sentence.
- Inline details max at one extra line; do not show command output.
- Elapsed time updates without changing layout width significantly.
- Completed state must not linger as a second success message.

Actions:

| Action | When visible | Behavior |
| --- | --- | --- |
| stop/interrupt | `running`, `waiting_for_approval`, `blocked` when interruptible | opens confirmation only if destructive or multi-agent fanout is active |
| queue follow-up | when composer has draft during active work | queues continuation; visible in active `OperationCell` |
| redirect | after user chooses stop-and-redirect | creates linked continuation operation |
| view approval | `waiting_for_approval` | focuses approval surface |
| view result/files | after terminal result when files, diffs, screenshots, or review details exist | opens right drawer result review or file preview |
| raw/debug detail | only from explicit developer/support affordance | opens raw/debug detail |

Do not put `workflow`, `run`, raw ids, stdout, or agent history in the popover.

## Right Drawer Result Review Micro-Spec

The right drawer is a completed-result viewer and current-channel workspace. It must not
become a second main conversation or the default way to read operation process.

Root pages:

| Root page | Purpose | Default content |
| --- | --- | --- |
| Files | generated and changed files | changed files, generated files, image/file previews, diffs |
| Review | completed-task review | checks, approval decisions, artifact review, final audit notes |
| Settings | current-channel configuration | channel teammate/runtime/provider settings |

There is intentionally no `Progress` root page. Active progress is owned by the floating
popover; completed or durable process is owned by the main transcript. Operation process
detail is read inline through `OperationCell` and `AgentActivitySpan` expansion.

Result detail pages are drill-down pages opened from explicit artifact, file, approval,
review, source-metadata, or raw/debug actions. They are not root tabs.

Result review structure:

```text
结果详情
  Files
  Diff / Preview
  Checks
  Approvals
  Artifacts
  Sources
  Raw/debug refs
```

Field rules:

| Section | Allowed fields | Forbidden |
| --- | --- | --- |
| Files | path, action, diff stats, artifact link, preview availability | copied artifact strip as the whole page |
| Diff / Preview | rendered image/file preview, text diff, binary metadata | operation process transcript |
| Checks | command/check name, status, duration, failure excerpt | full unbounded logs |
| Approvals | action, scope, decision, actor, timestamp | vague approval labels |
| Artifacts | name, type, size, preview availability | duplicate artifact strip copy |
| Sources | source label, type, target URL/file/app/tool metadata, related operation refs | repeated source explanations from coordinator text |
| Raw/debug refs | event id, source, timestamp, JSON payload | visible by default in root drawer |

Drawer copy rules:

- Drawer titles use nouns: `文件变更`, `预览`, `审核`, `审批详情`, `Raw detail`.
- The drawer may show internal ids only inside folded raw sections.
- The drawer should not repeat the final result sentence if the main feed already has the
  final summary.
- The drawer can show exact command/output text only when the user explicitly opens
  raw/debug detail. Normal file/review pages should not become command transcripts.

Navigation rules:

- Opening a file, result review, source metadata, or raw/debug detail preserves the main
  conversation scroll position.
- Closing the drawer returns the center feed to full width.
- Opening the drawer hides the floating run popover unless the drawer is on a non-progress
  root page and active work needs attention.
- Drawer back navigation returns from detail to the previous root page.
- Mobile drawer becomes a full-screen sheet but keeps the same content contract.

Duplication guard:

- If text appears in `CoordinatorMessageCell.display`, it should not appear verbatim in
  drawer Summary.
- If an operation row appears in the main feed, the drawer should not show a Timeline that
  copies the same row. Use inline expansion for semantic operation history.
- If inline expanded detail shows command output, drawer file/review pages should not
  duplicate it. Full command output is raw/debug detail only.
- If an artifact strip lists files, drawer Files shows previews/diffs, not the same list as
  the first visible section.

## Event-To-Operation Mapping

The main feed maps implementation events into stable semantic rows:

| Lower-level input | Operation row | Default copy |
| --- | --- | --- |
| workflow compiled | `plan` | `已规划 3 步` |
| file read / context packet | `read` | `已读取项目上下文` |
| file write / patch artifact | `edit` | `已修改 README.md` |
| command start/end | `run_command` | `已运行 pnpm typecheck` |
| web/search/tool lookup | `search` | `已搜索文档` |
| approval requested | `approval` | `等待审批` |
| approval resolved | `approval` | `审批已通过：写入 README.md` |
| test/check artifact | `verify` | `检查通过：web typecheck` |
| specialist step started | `handoff` branch row | `Docs 正在审阅` |
| watcher/monitor event | `watch` | hidden unless it changes next action |

Default row text must be user-readable and short. Raw command strings, stdout, JSON,
stack traces, provider metadata, token budgets, packet ids, and event ids go into
`EvidenceDetail`.

## Status Copy Canon

Codex's TUI does not treat `active`, `queued`, and `done` as default transcript
copy. Those states drive a cell lifecycle, while the visible row uses a semantic
verb phrase owned by that cell:

- search: `Searching the web` mutates into `Searched the web`;
- command: `Running <cmd>` mutates into `Ran <cmd>`;
- grouped context gathering: `Exploring` mutates into `Explored`;
- the bottom running indicator stays short, usually `Working`, and only adds
  concise details when they help the user interrupt or inspect the task.

Ling should follow the same rule in localized product copy:

| Internal lifecycle | Default transcript copy | Meta/status chip |
| --- | --- | --- |
| queued/open | `等待开始：{semantic action}` only when no better action exists | hidden by default |
| running/claimed | `正在{semantic action}` or the latest action text | hidden by default |
| waiting_for_approval | `等待审批：{approval/action}` | visible until resolved |
| blocked | `阻塞：{reason/action}` | visible |
| failed | `未完成：{reason/action}` | visible |
| cancelled/superseded | `已停止：{action}` | visible only when it affects outcome |
| succeeded/skipped | `{semantic action}` or `已完成：{action}` when no action verb exists | hidden by default |

Implementation rules:

- `Done`, `Active`, `Queued`, and `Completed` are internal lifecycle words, not
  default row copy for the main transcript.
- A row should not show both a semantic title and a generic status chip when the
  title already communicates the state.
- `AgentActivitySpan.stateLabel` is reserved for waiting, blocked, failed, or
  cancelled states. Running and completed spans rely on the latest action row.
- Operation row `meta` is reserved for approval/failure/blocker diagnostics,
  command snippets, or bounded evidence hints. It must not repeat lifecycle enum
  values.
- The same row may mutate from running wording to terminal wording. Completion
  freezes the row; it does not append a second `Done` row.

## Active Lifecycle

Operation cells follow a single mutable lifecycle:

```text
user message committed
-> operation cell created as queued/running
-> operation rows and AgentActivitySpan rows mutate in place
-> evidence bundle grows behind the disclosure
-> terminal status commits once
-> final coordinator summary appears or updates
```

Rules:

- Active work updates the existing `OperationCell`; it does not append a new runtime row
  for every event.
- A running command, tool, approval, or specialist step may change the current row in
  place.
- Completion should commit the same cell, not create a second completion surface.
- Late/stale completion events are evidence only when the visible state has already moved
  to cancelled, interrupted, or superseded.

## Multi-Agent Branch Display

Multi-agent work should be visible as branches inside the operation, not as independent
chat bubbles. This is an information-architecture rule, not a requirement to clone any
specific product UI.

Default branch row:

```text
Docs       完成       已审阅 README 文案
Engineer   运行中     正在修改 API client
QA         等待       等待实现完成后验收
```

Expanded branch detail:

```text
Docs
  result summary
  changed files
  checks
  evidence links
  raw detail only if requested
```

Rules:

- Specialist teammates can be visible, but they do not own the top-level conversation
  unless the user directly chats with that teammate.
- The final answer is synthesized by Ling Agent unless the user explicitly asks for
  separate specialist opinions.
- Branch rows should use user-facing roles such as `Docs`, `Engineer`, `QA`, `Security`,
  not internal workflow step ids.
- Watchers and monitors are hidden by default. They surface only when they block, fail,
  request approval, or change the next action.

## Evidence Detail

Evidence is still first-class, but it is not first-level conversation.

Inline folded evidence can show:

- changed files;
- checks;
- approval decisions;
- compact agent activity outputs;
- artifact links;
- context/evidence counts.

Deep detail can show:

- command and stdout/stderr;
- raw run event stream;
- workflow packet JSON;
- provider/model metadata;
- token budget and context trim diagnostics;
- raw artifacts and logs.

Right drawer behavior:

- Use the drawer for completed result review, file/diff/artifact preview, settings, or
  explicit raw/debug navigation.
- Do not make the drawer the only way to inspect the same evidence already available in
  inline transcript detail.
- Do not render a separate "open work evidence" button inside an operation group that
  already has expandable evidence summary.

## Source Summary Strip

Codex Desktop's environment popover has a useful pattern: it summarizes sources from
structured turn items, not from assistant prose. Ling should use the same idea without
copying the exact UI.

`SourceSummaryStrip` is an evidence summary, not a transcript cell that explains progress.
It answers "what external or contextual sources were involved?" with compact icons and
tooltips.

Source inputs:

| Input event | Source kind | Default icon | Detail target |
| --- | --- | --- | --- |
| MCP/tool call from a user-meaningful server | `tool` or `app` | app logo, plugin icon, or tool glyph | tool detail, MCP server metadata, related operation |
| web search/open page/find in page | `web` | globe | browser/open url, web search detail |
| memory recall or project memory citation | `memory` | memory glyph | memory citation detail |
| file/doc/image attachment or referenced workspace file | `file` | file glyph | file preview or artifact detail |
| generated artifact used as context | `artifact` | artifact glyph | artifact detail |

Filtering rules:

- Do not show internal helper tools as sources: `node_repl`, projector/internal daemon
  helpers, raw shell wrappers, setup/cleanup glue, event normalizers, or hidden model
  routing helpers.
- Do not infer sources from coordinator text. Sources come from structured event,
  attachment, memory, tool, browser, and artifact records.
- Deduplicate by stable semantic key: tool server/app id, normalized URL, memory id,
  workspace file path, or artifact id.
- Prefer user-facing names from plugin/app metadata. If no metadata exists, use a short
  sanitized server or host label. Raw ids appear only in drawer raw detail.
- Keep failed or cancelled source attempts only when they affected the user-visible result
  or blocker.

Lifecycle:

```text
turn started
  -> sourceRefs empty
tool/web/memory/file event observed
  -> append or update sourceRef on the owning operation/agent span
active popover
  -> shows compact source icons while the turn is active
turn completed
  -> sourceRefs freeze as committed evidence summary
source metadata detail
  -> shows source name, type, target, related operation, and raw detail ref
```

Placement:

- Main feed does not show a standalone `Sources` card.
- Operation expanded detail may show a short source count or inline icon strip when it
  helps normal audit.
- The right floating popover may show compact icons because it is already an active status
  surface.
- Source metadata detail may live in the right drawer, but only as metadata/review. It
  must not repeat the main transcript, OperationCell rows, AgentActivitySpan history, or
  final coordinator result.
- Used-memory detail belongs to the owning message's memory citation footer first. Source
  summary may count memory as a source group, but must not duplicate the footer contents.

## User Input During Active Work

The composer has three distinct behaviors while an operation is active:

| User intent | UI action | Runtime behavior |
| --- | --- | --- |
| ordinary new topic | `Send new message` | creates a new conversation turn |
| add guidance after current work | `Queue follow-up` | creates a queued continuation request |
| stop current direction | `Stop and redirect` | interrupts/cancels source work and starts linked continuation |

Rules:

- Do not silently inject text into an active run.
- Do not make normal Send an implicit interrupt.
- If the active runtime cannot accept steering, queue or restore the user input with a
  visible state.
- The active `OperationCell` should show pending queued follow-ups or redirect state in
  one compact row.

## Deduplication Rules

One fact should have one default surface.

Do not show:

- a coordinator start message plus a workflow started row plus a run started row for the
  same fact;
- a coordinator completed message plus a legacy collaboration completion surface plus a
  raw run terminal row with the same summary;
- a right drawer button that duplicates an inline evidence disclosure;
- subagent completion reminders when the branch row already shows `完成`;
- blank completed shell/code execution rows.

Keep visible:

- a concise final result;
- blocked reason;
- approval needed;
- failed/cancelled/interrupted state;
- which teammate or branch owns visible work;
- changed files and check counts;
- the next action the user can take.

## Implementation Slices

Phase 1 implementation is limited to the core message framework:

```text
ConversationTranscriptTurn
  -> coordinator text blocks
  -> OperationCell blocks
  -> AgentActivitySpan blocks
  -> terminal text blocks
  -> ArtifactStrip blocks
```

P0-P8 and the main-feed parts of P11 belong to Phase 1. P9 and P10 are later surface
work. They must consume the transcript model after it is stable; they must not define the
message structure or become a workaround for missing operation/agent history.

### P0. Normalizer Contract

Add a pure projection normalizer before React rendering. It accepts raw event envelopes and
returns semantic UI inputs without changing storage.

Acceptance:

- raw workflow/run/tool/sub-agent events are grouped by turn, operation, and actor;
- UI components receive no raw `workflow`, `run`, `work-unit`, `packet`, or router labels
  for default display;
- duplicate start/progress/completion events collapse into one active operation model;
- raw event ids remain reachable through `RawDetailRef`.

### P1. Projection Model

Add a `ConversationOperationCellViewModel` builder that derives operation cells from
existing workflow, run, approval, artifact, and legacy collaboration data. Keep all raw
records unchanged.

Acceptance:

- a workflow/run pair produces one operation cell;
- no raw `workflow`, `run`, or `work-unit` labels are shown in the default feed;
- terminal workflow and terminal run summaries dedupe into one task surface.

### P2. Active Cell Updates

Route active workflow/run updates into one mutable conversation cell.

Acceptance:

- command/tool/approval progress updates the same visible cell;
- no extra runtime rows appear for routine events;
- stale completions do not override cancelled/interrupted visible state.

### P3. AgentActivitySpan Projection

Render participating teammates as compact `AgentActivitySpan` rows inside the operation
cell.

Acceptance:

- multi-agent work shows agent status without separate teammate chat spam;
- agent detail expands inline with semantic process rows;
- final Ling Agent summary synthesizes the result.

### P4. Evidence Detail Boundary

Move command output, raw events, JSON, provider metadata, and logs into
`EvidenceDetail`.

Acceptance:

- default feed remains readable with collapsed evidence;
- expanding the operation row/group shows enough file/check/artifact detail for normal
  audit;
- explicit raw/debug access is still available for support and developer diagnostics.

### P5. Composer Active-Work Actions

Expose ordinary send, queued follow-up, and stop-and-redirect as distinct actions.

Acceptance:

- user text during active work is not silently injected;
- queued follow-up is visible on the active operation;
- interrupt redirect preserves lineage and evidence.

### P6. Copy And Regression Guard

Add UI tests/smoke checks for the no-duplication and copy-canon contracts.

Acceptance:

- no `Open work evidence` button appears when inline evidence exists;
- one terminal task produces at most one coordinator final message and one operation
  cell;
- no raw event spam appears in the default channel feed;
- multi-agent completion does not add duplicate completion reminders;
- default feed copy contains no visible `workflow`, `run`, `work-unit`, `packet`,
  `attempt`, `selector`, or `raw event` labels;
- coordinator fixtures contain no UI-mechanism phrasing such as `主会话会同步状态` or
  `查看右侧抽屉了解完整细节`;
- right drawer result-review fixtures do not repeat the coordinator final summary.

### P7. OperationCell Microstructure

Replace card-like workflow/run displays with the borderless transcript row structure.

Acceptance:

- operation groups render without outer border, card background, pill shell, or shadow;
- each row has a stable icon slot, label text, optional muted metadata, and optional
  chevron;
- row height, hover state, and active spinner do not cause layout shift;
- expanded detail appears as indented transcript content, not a nested panel;
- command output is bounded to the row limits defined in this document;
- rows with no semantic detail do not show a disclosure affordance.

Expanded detail v1 acceptance:

- detail groups render as transcript sections (`Changed`, `Checks`, `Evidence`,
  `Attention`) with no card border, background, chip shell, or dashboard header;
- group headers may show a short count, but they must not describe UI mechanics or where
  to find deeper logs;
- rows show only user-semantic text by default: file path, check name, failed reason,
  approval state, or bounded output excerpt;
- raw artifact types such as `file`, `diff`, `json`, `log`, and terminal storage names
  are not visible row metadata in the main transcript;
- successful terminal states are represented by the row tone or artifact strip, not by
  visible `succeeded` / `completed` status words;
- if a row title and description are the same apart from owner prefix or punctuation, keep
  one visible line and remove the row chevron;
- evidence links render as plain transcript links; they must not become chips, cards, or
  a second report surface;
- the same fact should not be repeated across coordinator text, operation row, expanded
  row, and drawer. When duplication is unavoidable in legacy data, prefer the most useful
  semantic surface and hide raw/internal variants.

Command/tool/file detail row v1:

- `ExecutionAction` rows may appear inside expanded `Evidence` when they carry a
  user-meaningful command, file, tool, approval, or output artifact reference.
- Workflow evidence may include `ExecutionAction[]` as a read-model projection from
  linked runs. This is not new workflow storage; it lets workflow transcripts keep the
  same folded command/file/check process rows as thread-backed runs.
- Each action row keeps one default label. Its expanded detail may show up to 5 bounded
  lines:
  - one command line as `$ {command}`;
  - up to 3 file paths touched by the action;
  - one tool/server label when it is user-meaningful;
  - one output summary such as `2 outputs recorded`.
- The inline detail never shows tool call ids, run ids, work-unit ids, artifact ids,
  event ids, raw JSON/log paths, provider metadata, environment variables, or full
  stdout/stderr.
- If more details exist than fit in the 5-line cap, show a count summary instead of
  streaming more rows.
- Failed actions may show the bounded failure summary inline because it changes the
  user's next action. Successful actions should avoid generic `succeeded` copy.

### P8. AgentActivitySpan Rendering

Render multi-agent work as compact agent spans inside the same task transcript.

Acceptance:

- serial work shows only the relevant completed/current teammate rows;
- parallel work shows one mutable latest-action line per active teammate;
- completed teammate history folds to the latest semantic actions and does not emit
  separate completion reminders;
- failed, blocked, or approval-waiting teammates remain visible until the coordinator
  resolves the task;
- more than three active teammates collapse with an overflow count;
- semantic sub-agent process stays inline behind the agent row; raw sub-agent transcript
  is raw/debug access only.

### P9. Floating Run Popover Boundary

Later surface, not Phase 1.

Keep the right floating status surface, but restrict it to ambient active-work state.

Acceptance:

- hidden when no active work exists;
- visible during running, waiting approval, or blocked states;
- hides after final coordinator summary and artifact strip commit;
- shows one actor, elapsed time, one latest-action phrase, and a small action control;
- never shows command output, raw ids, workflow/run labels, or branch history;
- when the right drawer is open, the popover either hides or reduces to a drawer header
  status, but does not duplicate drawer progress.

### P10. Right Drawer Detail Boundary

Later surface, not Phase 1.

Keep the right drawer as a completed-result review/workspace surface, not a duplicate
transcript.

Acceptance:

- drawer root pages are `Files`, `Review`, and `Settings`; active progress remains in the
  floating popover and durable process remains in the main transcript;
- operation process detail does not open as a drawer page; it expands inline in the
  transcript;
- drawer file/review pages do not repeat the coordinator final message;
- drawer does not provide a copied operation timeline; semantic operation history belongs
  to inline expansion;
- drawer `Files`, `Diff / Preview`, `Checks`, `Approvals`, `Artifacts`, `Sources`, and
  `Raw/debug refs` follow the field rules above;
- raw ids and JSON are folded by default and never appear in the drawer root page;
- opening the drawer preserves main feed scroll position and hides conflicting popover
  progress.

### P11. State Fixture Matrix

Implementation should ship with story fixtures or screenshot fixtures for the states that
caused regressions in this design cycle.

Required fixtures:

| Fixture | Must show | Must not show |
| --- | --- | --- |
| single-agent running | active operation row mutating in place | running modal or duplicate run row |
| single-agent completed | final coordinator result plus terminal operation rows | lingering floating success popover |
| serial multi-agent | coordinator handoff, current agent, folded prior agent | legacy collaboration surface |
| parallel multi-agent | latest action per active teammate | full sub-agent transcripts as default feed |
| waiting approval | approval row and blocking affordance | vague `continue?` copy |
| blocked | human-readable blocker and next action | raw exception as default row |
| interrupted redirect | cancelled source plus linked continuation | hidden prompt injection |
| drawer open | detail/raw sections only | copied main transcript |
| popover active | one-line active status | command output or branch history |
| artifact result | artifact strip and file detail path | duplicate artifact list in drawer root |

No unresolved product decisions remain for this design patch. Exact component names,
React file placement, and pixel tuning can be decided during implementation as long as the
surface contracts, copy canon, and no-duplication guards above remain intact.
