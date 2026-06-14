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
2. Multi-agent branch visibility, inspired by Grok-like agent surfaces: several
   specialist agents may work in parallel, but the user sees one coordinated task
   surface and one final answer, not a separate chat transcript for every agent.

The default channel feed should read like this:

```text
user request
Ling Agent coordinator message, only when useful
active operation cell
  compact multi-agent branch rows
  compact operation rows
terminal Ling Agent summary
folded evidence summary
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

The target feed shape is:

```text
ConversationTurn
  UserMessageCell
  CoordinatorMessageCell
  AgentActivitySpan[]
    AgentHeader
    OperationCell[]
      OperationDisplayLine
      TranscriptDetail?
    ActiveCell?
  CoordinatorSummaryCell
  ArtifactStrip?
```

For single-agent work:

```text
User: 创建一个 login.html...

Ling Agent:
确认需求：创建 login.html，包含邮箱、密码、记住我和登录按钮。

读取项目结构和现有入口 ˅
创建 login.html ˅
运行 2 条检查命令 ˄
  Searched for login.html | package.json | src in workspace
  Read package.json
  $ node --check login.html

Ling Agent:
完成：login.html 已创建。检查通过。

产物 login.html · 变更 1 个文件 · 检查 2 项通过
```

For serial multi-agent work:

```text
Ling Agent:
确认需求：创建 login.html。该任务交给 Engineer 实现。

Engineer
  查看项目结构 ˅
  修改 login.html ˅
  运行检查 ˄

QA
  验证页面 ˅
  截图检查 ˅

Ling Agent:
完成：login.html 已创建。检查通过。协作队友：Engineer、QA。
```

For parallel multi-agent work, the default feed shows one compact branch per active
teammate and only the latest active row for each branch:

```text
Ling Agent:
拆成两个并行任务：Engineer 实现，QA 准备验收。

Engineer
  正在修改 login.html

QA
  正在准备检查清单
```

The user's default reading path is the coordinator narrative and the latest state. Older
per-agent rows remain folded under the corresponding `AgentActivitySpan`.

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

| Raw input | Normalized output | Default feed | Expanded detail | Raw/detail drawer |
| --- | --- | --- | --- | --- |
| user message committed | `UserMessageCell` | user text | attachments and referenced files | original message metadata |
| coordinator text delta/final | `CoordinatorMessageCell` | natural reply or final result | related operation link | raw model item when debug is enabled |
| intent/router decision | evidence on turn | hidden | route rationale only if user asked | classifier scores, candidates, payload |
| workflow created/updated | `OperationCell` / `plan` row | `已规划 N 步` | semantic steps | workflow JSON, ids |
| run started/progress/completed | active `OperationCell` mutation | current task state | row history | run events, attempt ids |
| tool call start/output/end | `OperationRow` | `读取文件`, `运行检查`, `搜索文档` | command/tool summary and bounded output | full stdout/stderr, tool JSON |
| file read/context packet | `read` row or evidence ref | hidden unless it explains action | file names, snippets if useful | packet payload, context ids |
| file write/patch/artifact | `edit` row plus `ArtifactStrip` | changed file summary | diff/file preview | raw patch, artifact metadata |
| approval requested/resolved | `ApprovalCell` | waiting/approved/denied state | command/action and risk context | policy payload, request ids |
| sub-agent spawned/updated/completed | `AgentActivitySpan` | agent label and latest action | branch transcript summary | sub-thread raw events |
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
| transcript detail | expanded operation detail or raw/detail drawer | collapsed |
| bottom pane / composer | input, queue follow-up, interrupt/redirect, approval affordances | visible near composer |
| approval / ask user surfaces | explicit authority or missing-input requests | visible when blocking |
| artifact/status surfaces | product files, changed files, checks, active status | compact summary |

`OperationCell` remains the main Ling equivalent of a Codex `HistoryCell`, but Ling adds
`Actor` and `AgentActivitySpan` so multi-agent work does not become either raw internal
chat or a separate collaboration card system.

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
| Floating run popover | current running state, active actor, elapsed time, interrupt affordance, latest one-line action | full transcript, raw output, historical collaboration record |
| Right drawer | deep detail, raw/debug transcript, file preview, diff, cross-task Progress/Files/Context/Settings pages | a second copy of the main conversation or the same inline evidence |
| Inline expansion | semantic evidence needed for normal audit | unbounded logs, JSON dumps, provider metadata |
| Modal / blocking view | approval, missing input, permission change, destructive confirmation | passive status or historical logs |
| Composer active-work affordance | normal send, queue follow-up, stop-and-redirect | hidden prompt injection or implicit interruption |

Placement rules:

- The same fact has one default surface.
- If main feed display already says an operation completed, the floating popover hides or
  moves to idle state.
- If inline expansion already exposes semantic evidence, the right drawer opens only for
  deeper raw/detail, not the same content.
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
- The right drawer is for raw/deep/cross-task drilldown, not a duplicate of expanded
  inline evidence.
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

## User-Facing Cell Roles

| Role | Default feed behavior | Detail behavior |
| --- | --- | --- |
| `UserMessageCell` | durable user message | attachments and file refs can expand inline |
| `CoordinatorMessageCell` | Ling Agent narrative, plan, clarification, or final result | no raw logs; links to the related operation when needed |
| `OperationCell` | one compact task/process cell, active or terminal | expands to semantic operation rows and evidence |
| `AgentBranchRow` | one compact row per participating teammate | expands to branch-specific output and evidence |
| `ApprovalCell` | visible only when user authority is needed | expands to command/action payload and policy context |
| `EvidenceDetail` | never shown by default | exact files, commands, outputs, raw events, JSON, logs |

`Workflow`, `Run`, `WorkUnit`, `Attempt`, `Packet`, and `RouteDecision` are data model
and audit terms. They should not appear as default UI labels in the main feed.

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

Default message patterns:

| Situation | Pattern | Example |
| --- | --- | --- |
| Scope confirmation | `确认需求：{task}。` | `确认需求：创建 login.html，包含邮箱、密码和登录按钮。` |
| Safe delegation | `{task} 交给 {agent}。` | `实现交给 Engineer，验收交给 QA。` |
| Parallel split | `拆成 {n} 个并行任务：{agent-task-list}。` | `拆成两个并行任务：Engineer 实现，QA 准备验收。` |
| Clarification | `需要确认：{question}` | `需要确认：登录页是否要接入真实 API？` |
| Blocked | `阻塞：{reason}。{next-action}` | `阻塞：缺少写入权限。批准后继续修改文件。` |
| Waiting approval | `等待审批：{action}` | `等待审批：运行 pnpm install。` |
| Completed | `完成：{result}。{verification}` | `完成：login.html 已创建。检查通过。` |
| Interrupted | `已中断：{reason}。` | `已中断：按新的方向重新处理。` |
| Cancelled | `已取消：{task}。` | `已取消：未继续运行检查。` |

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
Ling Agent：确认需求：创建 login.html。
Engineer：正在修改 login.html。
QA：等待实现完成后验收。
Ling Agent：完成：login.html 已创建。检查通过。协作队友：Engineer、QA。
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
  readonly summary: string;
  readonly activeOperation?: OperationRow;
  readonly operationRows: readonly OperationRow[];
  readonly agentBranches: readonly AgentBranchRow[];
  readonly evidenceSummary: EvidenceSummary;
  readonly evidenceKey: string;
  readonly updatedAt: string;
}

interface OperationRow {
  readonly id: string;
  readonly kind: OperationKind;
  readonly status: OperationCellStatus;
  readonly label: string;
  readonly summary?: string;
  readonly durationMs?: number;
  readonly evidenceKey?: string;
}

interface AgentBranchRow {
  readonly id: string;
  readonly teammateId: string;
  readonly teammateName: string;
  readonly roleLabel?: string;
  readonly status: OperationCellStatus;
  readonly currentAction?: string;
  readonly resultSummary?: string;
  readonly evidenceKey?: string;
}
```

The UI can derive this model from current workflow, run, approval, artifact, and
legacy collaboration records before adding new storage.

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
| command output | 5 lines per command | full output in right drawer raw detail |
| changed files | 6 files | remaining files counted |
| checks | 5 checks | show failed checks first |
| approvals | 3 decisions | most recent first |
| artifacts | 4 items | remaining artifacts counted |
| agent branch history | latest 3 semantic actions per agent | full branch transcript in drawer |
| raw event ids | hidden | drawer only |

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
- New semantic actions append under the same `OperationCell` only when they are new
  user-visible steps.
- Raw stdout chunks do not append rows. They update bounded command output in expanded
  detail or raw detail.
- `succeeded`, `failed`, `blocked`, `cancelled`, and `interrupted` are terminal for the
  visible row unless a linked redirect creates a new operation.

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

State table:

| Agent status | Default text | Visibility |
| --- | --- | --- |
| queued | `{agent} · 等待开始` | visible only if parallel plan was announced |
| running | `{agent} · {latest action}` | visible and mutable |
| waiting_for_approval | `{agent} · 等待审批` | visible until resolved |
| blocked | `{agent} · 阻塞：{reason}` | visible and emphasized |
| failed | `{agent} · 失败：{summary}` | visible until coordinator handles it |
| cancelled | `{agent} · 已取消` | visible only if user initiated or affects result |
| succeeded | `{agent} · 完成：{result}` | collapses after coordinator summary |

Latest-action update rules:

- Each agent has one mutable latest-action line.
- Tool/event spam updates evidence, not the latest-action line, unless it changes the
  user's understanding of progress.
- If an agent emits a useful assistant summary, use that as `resultSummary`.
- If an agent only emits tool activity, synthesize a semantic action from the tool kind.
- Do not show raw agent internal reasoning by default.

History folding:

```text
Engineer · 完成：login.html 已创建
  查看项目结构
  修改 login.html
  检查通过
```

Folded history limits:

- show latest 3 semantic actions by default;
- keep failed/blocked action pinned even if older;
- show changed files and checks before raw tool events;
- raw sub-thread transcript opens only in right drawer detail.

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
| view detail | only when drawer is closed and detail is not inline | opens right drawer to deep detail |

Do not put `workflow`, `run`, raw ids, stdout, or agent history in the popover.

## Right Drawer Detail Micro-Spec

The right drawer is a detail viewer and current-channel workspace. It must not become a
second main conversation.

Root pages:

| Root page | Purpose | Default content |
| --- | --- | --- |
| Progress | current-channel active work and attention | latest operation status, pending approvals, blockers |
| Files | artifacts and attachments | changed files, generated files, previews |
| Context | decisions, memory, handoffs | brief, decisions, referenced context |
| Settings | current-channel configuration | channel teammate/runtime/provider settings |

Operation detail pages are drill-down pages, opened from explicit operation, artifact,
approval, or raw-detail actions. They are not root tabs.

Operation detail structure:

```text
操作详情
  Summary
  Timeline
  Commands
  Files
  Checks
  Approvals
  Artifacts
  Raw events
```

Field rules:

| Section | Allowed fields | Forbidden |
| --- | --- | --- |
| Summary | operation title, terminal status, owner, started/ended time | repeated coordinator final summary |
| Timeline | semantic events with timestamps | full main conversation rows |
| Commands | command, cwd, exit code, duration, bounded output | unrelated shell history |
| Files | path, action, diff preview, artifact link | raw packet ids as labels |
| Checks | command/check name, status, duration, failure excerpt | full unbounded logs |
| Approvals | action, scope, decision, actor, timestamp | vague approval labels |
| Artifacts | name, type, size, preview availability | duplicate artifact strip copy |
| Raw events | event id, source, timestamp, JSON payload | visible by default in root drawer |

Drawer copy rules:

- Drawer titles use nouns: `操作详情`, `Raw detail`, `文件变更`, `审批详情`.
- The drawer may show internal ids only inside folded raw sections.
- The drawer should not repeat `完成：...` if the main feed already has the final summary.
- The drawer can show exact command/output text because the user explicitly asked for detail
  by opening it.

Navigation rules:

- Opening an operation detail preserves the main conversation scroll position.
- Closing the drawer returns the center feed to full width.
- Opening the drawer hides the floating run popover unless the drawer is on a non-progress
  root page and active work needs attention.
- Drawer back navigation returns from operation detail to the previous root page.
- Mobile drawer becomes a full-screen sheet but keeps the same content contract.

Duplication guard:

- If text appears in `CoordinatorMessageCell.display`, it should not appear verbatim in
  drawer Summary.
- If an operation row appears in the main feed, drawer Timeline may show a shorter timestamped
  event, not the same row copy.
- If inline expanded detail shows command output, drawer Commands may show the full output,
  but should not duplicate the bounded snippet at the top.
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

## Active Lifecycle

Operation cells follow a single mutable lifecycle:

```text
user message committed
-> operation cell created as queued/running
-> operation rows and agent branch rows mutate in place
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
- compact agent branch outputs;
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

- Use the drawer for deep raw/detail navigation or cross-task work board views.
- Do not make the drawer the only way to inspect the same evidence already available in
  inline transcript detail.
- Do not render a separate "open work evidence" button inside an operation group that
  already has expandable evidence summary.

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

### P3. Multi-Agent Branch Rows

Render participating teammates as compact branch rows inside the operation cell.

Acceptance:

- multi-agent work shows branch status without separate teammate chat spam;
- branch detail expands inline;
- final Ling Agent summary synthesizes the result.

### P4. Evidence Detail Boundary

Move command output, raw events, JSON, provider metadata, and logs into
`EvidenceDetail`.

Acceptance:

- default feed remains readable with collapsed evidence;
- expanding the operation row/group shows enough file/check/artifact detail for normal
  audit;
- raw/detail drawer is still available for support and developer diagnostics.

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
- right drawer detail fixtures do not repeat the coordinator final summary.

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
- raw sub-agent transcript opens only through drawer detail.

### P9. Floating Run Popover Boundary

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

Keep the right drawer as a detail/workspace surface, not a duplicate transcript.

Acceptance:

- drawer root pages remain `Progress`, `Files`, `Context`, and `Settings`;
- operation detail pages open only from explicit drill-down actions;
- drawer `Summary` does not repeat the coordinator final message;
- drawer `Timeline` uses timestamped semantic events, not copied main-feed rows;
- drawer `Commands`, `Files`, `Checks`, `Approvals`, `Artifacts`, and `Raw events`
  follow the field rules above;
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
| parallel multi-agent | latest action per active teammate | full sub-agent transcripts |
| waiting approval | approval row and blocking affordance | vague `continue?` copy |
| blocked | human-readable blocker and next action | raw exception as default row |
| interrupted redirect | cancelled source plus linked continuation | hidden prompt injection |
| drawer open | detail/raw sections only | copied main transcript |
| popover active | one-line active status | command output or branch history |
| artifact result | artifact strip and file detail path | duplicate artifact list in drawer root |

No unresolved product decisions remain for this design patch. Exact component names,
React file placement, and pixel tuning can be decided during implementation as long as the
surface contracts, copy canon, and no-duplication guards above remain intact.
