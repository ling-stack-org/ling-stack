# Conversation Surface Contract

Status: active shell/policy contract; typed transcript authority is v3.9.1 (v3.9 contract + interface-level component design)
Original date: 2026-06-28
Updated: 2026-09-01
Scope: normal conversation, channel root, channel branch, topic reply, teammate private
chat, run/thread detail, and future Desktop/PC conversation renderers

Related docs:

- [Conversation Typed Transcript — Detailed Design](conversation-typed-transcript-detailed-design.md)
- [Conversation Codex-Parity Visual Specification](conversation-codex-parity-visual-spec.md)
- [Conversation Codex-Parity Component Detailed Design](conversation-codex-parity-component-detailed-design.md)
- [Codex-style Typed Transcript Implementation Plan](conversation-codex-style-transcript-implementation-plan.md)
- [Conversation Surface Taxonomy](conversation-surface-taxonomy.md)
- [Conversation Surface Contract Implementation Plan](conversation-surface-contract-implementation-plan.md)
- [Conversation Composer Unification](conversation-composer-unification.md)
- [AI Teammate Private Workspace](ai-teammate-private-workspace.md)
- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)
- [Conversation Right Dock Workspace Tools](conversation-right-dock-workspace-tools.md)
- [Ling Agent TerminalReport Protocol](ling-agent-terminal-report-protocol.md)
- [Conversation Shared Capabilities](conversation-shared-capabilities.md)
- [Conversation Shared Capabilities Detailed Design](conversation-shared-capabilities-detailed-design.md)
- [Conversation Model Binding And Creation Validation](conversation-model-binding-and-creation-validation.md)
- [Conversation Media Generation Tools](conversation-media-generation-tools.md)

Typed item semantics, evidence ownership, renderer registry, batching, nested Agent
presentation and completion gates are owned by the v3.9.1 documents above. This contract
only defines surface scope, shell chrome, composer policy and Host callback boundaries;
it must not add a route-local transcript renderer or summary owner.

## Typed transcript override (v3.9.1)

For message, activity, command, file, tool, approval, child-agent, batching, and
completion presentation, v3.9.1 is the current authority. This surface contract still
defines shell and product-policy differences, but it must not add a route-local
renderer or second completion owner. Normal, teammate-private, and channel surfaces
must mount the shared `ConversationTimeline`; channel-only differences are roster,
topic/branch controls, and multi-Agent policy.

Historical sections below still use `MessageRow`, `EvidenceBundlePanel` and
`ConversationWorkCell` to describe the shipped pre-v3.6 baseline. They are migration
inputs, not target renderers or independent fact owners. During the v3.7 cutover:

- existing data adapters may be reused to create strict canonical items;
- production activity rendering moves to the shared `ConversationTimeline` registry;
- Composer, right dock and EnvironmentPopover may focus/open an owning row but may not
  duplicate its action summary, output, approval control or completion state;
- user/agent narrative uses the shared left-aligned document lane and the fact row status
  vocabulary is closed; a surface must not restore a right-side bubble or local status copy;
- after all surface parity fixtures pass, production WorkCell/activity callers are
  removed without a legacy renderer feature flag.

> **v3.7 topic scope override:** the channel list may retain
> `ChannelMessage.threadId = sourceMessage.id` as a legacy grouping index, but the typed
> transcript adapter must resolve a durable topic `LingThread.id` with
> `parentThreadId + anchorItemId` before mounting. It must not use the message id, a
> `topic:<id>` string, or `channel:<id>` as a synthetic transcript thread. Unresolved
> scope becomes `diagnostic(scope_mismatch)` and never falls back to the parent feed.

同样，历史章节中出现的“user message 右对齐”“assistant row 的独立 work cell”以及
“MessageRow/EvidenceBundlePanel/WorkCell”组合，只用于解释旧版本行为和迁移来源。v3.7
实现一律以左对齐 document lane、共享 `ConversationTimeline` 和单一 fact owner 为准；
实现者不得从历史章节复制这些几何或组件边界。若历史描述与本节 override 或视觉规范
冲突，以 v3.7 规范为准，不需要再保留兼容 CSS。

If any later paragraph conflicts with this override, the v3.9.1 typed transcript design
and visual specification win.

### Canonical type names

本文件后面的旧章节仍会出现 `ConversationSurfacePolicy`、`ConversationSurfaceView` 和
`ConversationRowView`。这些名称只描述 v3.6 及更早版本的迁移输入，不是 v3.7 的新 API。
实现代码统一使用 `ConversationInteractionPolicy`、`ResolvedConversationSurface` 和
`TimelineSnapshot`；旧类型不得在新 surface 中重新导出，也不得据此增加第二个 renderer。

## v3.7 Surface Adapter、Viewer 和状态所有权细化

这一节把“统一会话组件”落成可直接实现的接口。普通会话、队友私聊、频道
root/topic/branch 和 depth-1 子 Agent 都必须先解析成同一个 `ResolvedConversationSurface`，
再调用唯一的 `mountConversationTimeline`。surface 只提供 scope、policy、chrome 和 Host
回调；它不能自行排序、分组、解析 Markdown 或渲染第二份 activity。

```ts
type ResolvedConversationSurface = {
  readonly kind: "normal" | "private" | "channel_root" | "topic" | "branch" | "child";
  readonly workspaceId: string;
  readonly threadId: string;              // always a real LingThread.id
  readonly parentThreadId: string | null;
  readonly anchorItemId: string | null;
  readonly depth: 0 | 1;
  readonly policy: ConversationInteractionPolicy;
  readonly chrome: {
    readonly title: string;
    readonly participantIds: readonly string[];
  };
};

/** Shell-level controls; distinct from the Timeline renderer callbacks in the
 * typed transcript contract. These controls never render a second fact row. */
type ConversationSurfaceCallbacks = {
  readonly onFocusItem: (itemId: string) => void;
  readonly onOpenSourceRef: (
    ref: ConversationTrustedSourceRef,
    lineage: ConversationTimelineItemLineage,
  ) => Promise<void>;
  readonly onApprovalDecision: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
  readonly onStopRun: (runId: string) => Promise<void>;
  readonly onRetryAttempt: (attemptId: string) => Promise<void>;
};
```

`ConversationSurfaceCallbacks` 只由 shell/Composer/approval gate 使用；它不是
`ConversationTimelineCallbacks`，也不能通过 `renderFactActions` 注入 Timeline。Timeline
中的 approval/protocol row 只呈现状态、详情和 focus；allow/deny、stop、retry 各自只有
一个 shell 控件 owner。

Conversation detail 不再把裸 `TerminalReportDto[]` 当作可排序历史；它返回
`ConversationTerminalReportProjectionDto[]`，每项同时携带 `report`、`generation` 和
`resultItemId`，并由专用 `conversation_item(kind="terminal_report")` 锚定。surface 不得
按 `committedAt`、数组位置或 Markdown 内容选择结果，也不得把 TerminalReport 重新包装成
`assistant_message`。reply 使用 `assistant_message.presentationRole="reply_result"`；execute
使用唯一 `terminal_report` result Item，provider 的 `execution_summary` 只进入 audit/
synthesis。

滚动所有权也固定在 shell：`ConversationFeed`/`ConversationVirtualFeed` 是唯一的
`ConversationFeedViewport`，负责纵向 `overflow`、贴底、加载旧记录和历史 anchor。
`ConversationTimeline` 以及 depth-1 child、batch、fact detail 都是普通文档流，不得创建
第二个纵向滚动容器；这条规则适用于 normal、private、channel、topic、branch 和 child。

`onOpenSourceRef` 的第二个参数是 renderer 已经拥有的 lineage，不允许 callback 再从
路径字符串、surface 名称或当前选中项猜 scope。点击链路固定为：

```text
display-only ref
  -> daemon issue capability（workspace/thread/run/action/participant/step/ref）
  -> user click
  -> daemon redeem + TTL/epoch/realpath/permission 二次校验
  -> 专用 viewer
```

Host viewer 的目标不可混用：

| capability target | 唯一 viewer | 允许的结果 |
| --- | --- | --- |
| `open_file` | files/right-dock file preview | 查看或编辑单个文件 |
| `open_diff` | review/diff viewer | 结构化 diff、hunk、回到 owning row |
| `open_artifact` | artifact preview/review viewer | 完整日志、报告或生成物 |

失败时仍显示 basename、完整路径 tooltip 和复制入口，但只生成
`diagnostic(blocked)`，不得静默降级成普通文件打开。daemon restart 会使旧 capability
失效；事实行仍从 SQLite 恢复，下一次点击重新签发。

状态所有权固定如下：

| 区域 | 唯一拥有 | 只能提供/明确禁止 |
| --- | --- | --- |
| `ConversationFeedViewport`（`ConversationFeed`/`ConversationVirtualFeed`） | 唯一纵向 overflow、贴底、历史 anchor、加载旧记录 | 只承载已投影 Timeline DOM；禁止读取 SQLite/SSE、排序 item 或判断完成 |
| `ConversationTimeline` | item、revision、disclosure、focus | focus/source callback；不得创建第二个纵向 overflow、不得拥有完成判定 |
| `Composer` / approval gate | 输入、stop、retry、allow/deny | 定位 owning row |
| `EnvironmentPopover` | 当前 active run/action 的两行 ambient hint | focus owning row |
| right dock / viewer | source ref 的预览 | 返回 Timeline |
| `terminalReport` result row / fan-in | atomic evidence 的结论 | lineage/source link；禁止在 Timeline 外再挂结果卡 |

同一 canonical fixture 在 normal/private/channel/topic/branch/child 中必须产生相同的
`itemKinds`、顺序、`rendererKeys`、状态文案、行高和 disclosure 数；只允许 shell title、
roster、participant rail 和 policy hints 不同。这个 fingerprint 是 cutover 的退出条件，
截图只能作为补充证据。

2026-07-30 model ownership update: private chat still has no composer model picker. A
user-created teammate uses its fixed model; a built-in teammate explicitly follows the
workspace default in private chat. This is a declared binding mode, not runtime fallback.

2026-07-30 settings-entry update: channel and teammate-private headers both keep a
persistent title-adjacent More menu. Settings must remain reachable when the effective
model is healthy. A model warning may deep-link to the Model section, but it is a repair
shortcut rather than the only settings entry.

2026-07-30 teammate identity update: the private-chat header keeps only avatar, teammate
name, and the title-adjacent More menu. Role translation belongs to teammate details and
must not occupy a persistent middle slot or push the More menu away from a short name.

2026-07-30 settings-shell parity update: channel and teammate-private settings use the
same shell grammar: a 58px back/title/subtitle header, a horizontal settings navigation,
and one bounded scrolling content region. Teammate settings must not retain the former
left navigation or a permanent configuration-summary sidebar. Teammate-specific fields
and current-tab save ownership remain unchanged.

## Purpose

This document is the shared conversation UI contract after the first shared surface slice
landed in PR #273.

The goal is to stop normal conversation, channel chat, private chat, and run/thread
detail from re-implementing their own message rows, empty states, evidence display,
source display, action bars, and width rules. The surfaces can still differ in policy and
surrounding chrome, but they must consume the same conversation primitives and state
vocabulary.

This is a product and implementation contract. Future UI work should change this
document first when it changes shared behavior.

## Shipped Baseline

The entries in this section describe the pre-v3.6 shared-surface baseline. They are kept
for migration traceability only. The v3.7 target is the single `ConversationTimeline`
registry and owner described above; no new implementation should add another WorkCell,
message bubble, activity summary, or route-local renderer.

The current shared UI slice established these baseline decisions:

- normal conversation created from the home composer moves into a conversation page
  after the first message instead of continuing as a home hero layout,
- teammate private chat uses the shared message row and empty-state treatment instead of
  a separate bubble surface,
- normal conversation preserves `threadId`, `turnId`, and `runId` from the transcript so
  compact work can attach to the owning assistant row,
- normal conversation renders a compact work cell only when that assistant row has a
  `runId` that maps to a real `RunSession`,
- teammate private chat renders a compact work cell only when an AI message has a
  `linkedRunId` that maps to a real run in the selected teammate scope,
- channel assistant turns keep teammate collaboration content above the copy, feedback,
  and topic-reply action row,
- evidence/source panels are quieter and avoid duplicate labels when no real source or
  search evidence exists,
- shared empty states are centered inside the feed viewport,
- `MessageActionBar`, `SourceIconStack`, and `TeammateAvatarStack` are shared Web
  primitives rather than page-local one-offs,
- surface policy defaults and action filtering live in `@ling-stack/conversation-ui-core`
  and are re-exported through the Web shared conversation API,
- "Expert" copy is no longer the product vocabulary for teammates.

The slice does not finish the full contract. Remaining work is evidence projection for
normal conversations, shared file/reference capability blocks, safe `turnId` or
thread-level work projection, and the active first-wave `conversation-ui-react`
extraction.

The next approved shared-capability phase adds structured Markdown, Mermaid, math,
latest-user-message editing, and real teammate-private execution. These capabilities
extend the same component and policy model; they do not create a parallel conversation
surface.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Surface | The product context rendering a conversation: normal, channel, topic, private, run/thread |
| Shell | The layout frame that owns feed height, composer placement, and optional status/drawer slots |
| Feed | The scrollable transcript viewport |
| Message row | A user, assistant, teammate, coordinator, or system message |
| Composer | The shared input surface for text, slash commands, files, guidance, model selection, and authorization controls |
| Turn | One user request and the assistant/work objects that answer it |
| Capability block | Evidence, source, file, approval, work cell, attachment, or preview attached to a turn |
| Policy | Surface-specific permissions that decide which capability blocks are visible or actionable |
| Chrome | App shell around the conversation: drawer, header, teammate roster, settings, floating activity |

The same component can render different surfaces, but surface policy decides what the
component is allowed to show.

## Conversation UI Kit Contract

Conversation UI should converge into one kit with four primitive families:

```text
surface primitives
  -> shell, feed, empty state, layout slots

message primitives
  -> row, avatar, meta, body, action bar

evidence primitives
  -> typed fact row, source icon stack, file/diff/artifact viewers

composer primitives
  -> shell, tokenized input, toolbar, permission menu, preview strip, status/guidance slots

workspace dock primitives
  -> right dock shell, launcher, page header, page stack, review queue, evidence/files/tool pages
```

Normal conversation, channel, and teammate private chat are not three UI systems. They
are three policy projections over the same kit.

| Primitive family | Shared behavior | Surface policy decides |
| --- | --- | --- |
| Surface | feed height, empty state, column width, composer alignment | channel drawer/activity chrome, private pane width, run detail richness |
| Message | row spacing, avatar sizing, action bar placement, hover/focus actions | topic reply availability, feedback availability, teammate stack visibility |
| Evidence | real-data rendering gate, compact vs rich disclosure, source icon stack | which evidence is private, channel-visible, or routed to run detail |
| Composer | shell, toolbar, input, preview chips, popovers, authorization control | `@` routing, model picker, read-only model status, active guidance behavior |

This kit boundary is a stronger rule than visual consistency. A surface may adapt data
before rendering, but it must not fork core UI semantics. If a future PC/Desktop surface
needs different chrome, it should provide different adapters and layout slots, not a new
message/composer/evidence model.

## Hard Rules

1. Shared components do not mean identical surfaces. They mean the same primitives,
   states, spacing tokens, and capability contracts.
2. Normal conversation, channel, private chat, and run/thread detail must not invent
   separate message row or empty state systems.
3. A capability block renders only when real evidence exists. Do not show "web search",
   "sources", "files", or "context" rows as decorative placeholders.
4. The message action row is the last visual layer of the current message/turn. Team
   activity, typed evidence, and references sit above it; the historical WorkCell name
   does not authorize a second v3.7 activity renderer.
5. Private chat is one-to-one. It must not expose `@` teammate routing or invite other
   teammates into the private thread.
6. Channel is the only default multi-teammate collaboration surface. Normal conversation
   can show selected model/assistant work, but not channel teammate rosters by default.
7. Topic reply is channel-specific. Do not show topic-reply controls in normal
   conversation or teammate private chat.
8. Typed evidence rows and viewers are shared capabilities, not run-thread-only UI. Surface
   policy decides whether they are inline, collapsed, or routed to detail. The historical
   `ConversationWorkCell` is only a migration adapter and must not be a v3.7 production
   renderer or completion owner.
9. Raw ids, provider metadata, token counts, workflow packet names, and JSON payloads are
   not default feed copy. They belong in expanded evidence or developer raw detail.
10. Surface-specific CSS may position the shared components, but must not redefine their
    product semantics.
11. Shared composer work must unify both behavior and style. Channel, normal
    conversation, and teammate private chat can differ by capability policy, but not by
    separate composer visual systems.
12. Channel is the only default surface with teammate `@` routing in the composer.
    Normal conversation and teammate private chat must not show `@` placeholder copy,
    mention buttons, or mention pickers.
13. Right-side workspace tools must use the shared Right Dock model. Channel, normal
    conversation, and teammate private chat may expose different pages, but they must not
    fork separate drawer, review, or evidence UI systems.
14. Executed-work final results consume the shared `TerminalReport` contract and project to
    one `terminalReport` result item inside the Timeline. Surfaces must not derive outcome,
    verification, participants, or artifacts from assistant copy or render a second result card.
15. Only the latest local-user message in the active scoped lane is editable in the first
    implementation. Editing supersedes the latest logical turn, keeps current workspace
    side effects, and starts again in the same thread or branch.
16. Teammate private chat is execution-capable when effective teammate tools, skills,
    MCP, workspace, runner, provider, authorization, and approval policy permit it. The
    private surface remains single-agent and does not render TerminalReport participants.
17. Rich message content uses an allowlisted structured parser and owned renderers. Raw
    HTML, arbitrary iframes, and untrusted script execution are forbidden.
18. Existing channel topic replies, LingThread forks, and queued run guidance remain the
    authorities for reply, branch, and next-run continuation. Shared-capability work must
    not introduce parallel replacements.
19. Multi-agent collaboration presentation is a read model over durable proposal,
    workflow, step, run, approval, lease, and artifact state. Requirement shaping,
    serial/parallel work, handoffs, and terminal summaries must render inside the one
    visible work object for the turn; UI projections cannot create a second workflow
    engine or authorize state transitions.
20. A conversation send has one cross-surface lifecycle: `submitting` ->
    `message_accepted` -> `reply_linked` -> `settled`. The Composer may accept guidance
    after `reply_linked`; it must not wait for the assistant reply to finish. Each accepted
    submit keeps its own request identity, so a later submit cannot invalidate an earlier
    request that is still receiving transport events. Channel `reply_pending` is an
    intermediate transport projection only for the message preparing a new reply; a queued
    follow-up skips it and returns durable queue disposition instead. Neither path adds
    another lifecycle state or execution object.
21. File paste is owned by the shared tokenized input. Clipboard files enter the same
    attachment upload path as the attach button and drag/drop. Clipboard HTML is never
    inserted into the editable transcript input.
22. Image and video generation use first-party Runner tools and the shared generated-media
    projection. Normal conversation, channel, and teammate private chat must not add
    keyword routing, separate MediaJob state machines, or surface-specific media cards.
    MediaJob remains the artifact owner; the conversation surface consumes a read model
    linked through the parent Run and child WorkUnit.
23. Pending local runtime approvals are owned by their conversation surface, not by a
    global blocking dialog. A background channel, normal conversation, or teammate
    private chat shows a visible green `Waiting for approval` label on its Sidebar row
    without interrupting the active conversation. When the user opens the owning session,
    one shared `RuntimeApprovalComposerGate` replaces that session's Composer and presents
    one localized action sentence plus direct deny/allow actions. The gate must not mount
    a page backdrop, trap focus outside the session, disable Sidebar navigation, or affect
    another session's Composer. The same ordered approval read model marks its owning Run
    as `composer_gate_pending`: the transcript may show one non-interactive localized
    status marker, but must not render an expandable WorkCell, approval operation rows,
    evidence groups, raw permission labels, or duplicate decision controls until the
    Composer-owned approval resolves. Complete payload and history remain available in
    Run detail and audit surfaces.
    Ownership resolution must use the linked Work Unit kind before teammate identity:
    `conversation_run` is a normal conversation and `teammate_direct_reply` is a private
    chat. A normal Ling Agent Run may carry `teammateId`, so that field alone must never
    move its approval into the teammate Sidebar or Composer.
24. Channel execution proposals render a compact transcript summary. An actionable
    proposal is a session-owned decision and replaces only its channel Composer, after any
    runtime approval gate. The shared decision shell shows one sentence naming task,
    assignee, and localized permission categories, followed only by deny and allow. The
    summary can select its proposal for the owning Composer. When a proposal exists, that
    summary is the only default
    feed representation of requirement shaping. Internal shaping status, teammate ids,
    and collaboration records remain audit data; only an actual unanswered user question
    may render as a separate compact decision-needed row. The compact summary is visually
    owned by `assigneeTeammateId`: it must render the assignee through the canonical
    teammate-avatar projection, including custom-avatar and deleted-teammate fallback
    behavior. It must not inherit or duplicate the source message author's avatar.
25. Channel, teammate-private-chat, and recent-conversation rows use one shared Sidebar
    object preview. Every preview shows the complete object name and its latest known
    activity time; it does not repeat the surface type already established by the Sidebar
    section. It may additionally show repository and
    branch context only when that object's effective execution workspace resolves to an
    available Git workspace distinct from the shared global workspace. Conversation
    context comes from its newest loaded Run; channel context uses its current workspace
    binding first, then a distinct latest-Run or explicit bound path; teammate-private-chat
    context uses the newest non-channel Run for that teammate. A shared-workspace Run is
    activity evidence, not durable object-level Git evidence, because its current branch
    may differ from the branch used by the historical Run. The
    Sidebar uses the existing workspace-change projection, deduplicates checks by working
    directory, never displays an absolute local path, and treats missing/non-Git/error
    results as absent optional metadata. Git context belongs to the rich preview rather
    than the title row, so it must not reduce title width or add horizontal scrolling.
26. A failed or blocked recent conversation uses the red status dot only as an unreviewed
    attention signal. Successfully entering that conversation acknowledges the current
    failure revision and removes the dot without changing the durable thread, Run, error,
    transcript, or retry state. The acknowledgement is local UI state keyed by workspace,
    conversation, and failure update time. Reloading the same revision keeps it hidden;
    a later failed or blocked revision must surface the dot again. Waiting-for-approval
    and running projections are live state and are never cleared by this acknowledgement.
27. A recent-conversation Sidebar row is a single-line object row. It renders the title
    only and must not add a redundant `Conversation` type subtitle. The row remains `32px`
    high with the icon and title sharing one vertical centerline; removing the subtitle
    must not move the title's horizontal origin. Its shared preview is viewport-bounded,
    has no internal scrollbar, and moves an overflowing line horizontally using the same
    fade-and-hover behavior as the Sidebar title.
28. Right Dock visibility is a shared projection across channel, normal conversation,
    and teammate private chat. Above `900px`, Details uses the existing inline resizable
    column. At `900px` and below, the dock, resize handle, and layout reservation are all
    absent; an unavailable dock cannot leave an active toolbar state or blank grid column.
    Surface-specific media queries must not independently hide only part of this state.

## Surface Capability Matrix

| Capability | Normal conversation | Channel root | Channel branch | Topic reply | Teammate private chat | Run/thread detail |
| --- | --- | --- | --- | --- | --- | --- |
| User/assistant messages | Yes | Yes | Yes | Yes | Yes | Yes |
| Shared `MessageRow` | Required | Required | Required | Required | Required | Required |
| Attachments | Yes | Yes | Yes | Limited | Yes | Yes |
| File references | Yes | Yes | Yes | Limited | Yes | Yes |
| Web/search source icons | When actual search occurred | When actual search occurred | When actual search occurred | When actual search occurred | When actual search occurred | When actual search occurred |
| Evidence bundle | Yes, compact | Yes, compact | Yes, compact | Compact, attached to source | Yes, compact/private | Rich |
| Work cell | Yes, compact | Yes | Yes | Only if promoted | Yes, compact/private | Rich |
| Approval state | Yes | Yes | Yes | Only if promoted | Yes | Yes |
| Multi-teammate activity | No by default | Yes | Yes | No by default | No | Only if linked from channel work |
| Teammate avatar stack | No by default | Yes | Yes | No by default | Selected teammate only | Contextual |
| `@` teammate routing | No by default | Yes | Yes | No by default | No | No by default |
| Topic reply action | No | Yes | Yes | Nested only | No | No |
| Edit latest own message | Yes | Yes | Yes | Yes, latest own reply | Yes | No by default |
| Structured Markdown / Mermaid / math | Yes | Yes | Yes | Yes | Yes | Yes |
| Tool execution | Yes | Yes | Yes | No by default; promote explicitly | Yes, single-agent | Yes |
| Image/video generation tools | When a runnable target exists | When a runnable target exists | When a runnable target exists | No by default | When a runnable target exists | Projection only |
| TerminalReport participants | No | Yes | Yes | No by default | No | Contextual |
| Raw runtime detail | Detail only | Developer/detail only | Developer/detail only | No by default | Detail only | Yes |
| Right Dock shell | Yes | Yes | Yes | No by default | Yes | Optional rich detail |

## Composer Capability Matrix

The composer follows the separate
[Conversation Composer Unification](conversation-composer-unification.md) contract.
Summary:

| Capability | Normal conversation | Channel root/branch | Teammate private chat |
| --- | --- | --- | --- |
| Shared composer shell/style | Required | Required | Required |
| `/` command picker | Yes | Yes | Yes |
| Teammate `@` picker | No | Yes | No |
| File upload and drag/drop | Yes | Yes | Yes |
| Pending assets and file refs | Yes | Yes | Yes, private-scoped |
| Model picker | Yes | No | No |
| Read-only model status | Optional | Optional | Yes if useful |
| Authorization picker | Yes, locked while active | Yes, locked while active | Yes, locked while active |
| Active work guidance | Yes | Yes | Yes |
| Inline approval strip | Yes | Yes | Yes |

Normal conversation can select model and authorization. Teammate private chat can select
authorization but cannot change model from the composer; the effective private model is
owned by teammate settings and may be shown read-only in the composer. The persistent
private-chat Settings entry opens the full teammate settings surface, where editable
teammates may switch binding mode or fixed model.
Teammate Management keeps `Open chat` as the primary row action and exposes `Edit teammate`
in the row menu. That command opens the same full settings surface on the Profile section;
it must not create a second teammate editor or bypass protected-field rules.

Channel keeps model selection out of the composer. Channel Settings owns one `Ling Agent
model` for Ling Agent replies and channel-owned routing. Other built-in teammates continue
to follow the workspace model, while fixed teammates keep their own model. Channel
membership does not create a per-channel teammate-model override.

Authorization is not hidden on channel. Channel, normal conversation, and teammate
private chat all show the same four permission presets: `read_only`,
`workspace_collaboration`, `full_access`, and `custom`. Defaults come from settings; a
custom configured policy resolves to `custom`. Once a message is sent and a run/model call
is active, the authorization control stays visible but locked. The active execution uses
the request/effective-policy snapshot captured before start; UI changes cannot mutate it
mid-run.

Active work guidance always targets a real cancellable `RunSession` and persists through
the existing `RunIntervention` queue. Ordinary channel replies use that standard
`RunSession` contract; the linked `channel_ai_reply` WorkUnit remains a supervision
projection and cannot become a second execution authority. Whenever any teammate reply is
active, the Composer remains the ordinary channel input and does not add a separate target
selector. The daemon is the sole reply-target authority: no AI mention routes through Ling
Agent, one AI mention targets that teammate, and multiple AI mentions return to Ling Agent
for coordination rather than fan-out. The Web may project the resolved active reply for
stop-button state, but it must not send an independent teammate selection.

Every non-empty Composer submission is persisted as an ordinary channel user message. Root,
each Branch, each message-keyed Topic, and each explicit Thread expose independent reply lanes.
The Web sends an explicit `queue_followup` disposition only for the currently projected active
reply on that line. The daemon validates the exact `activeRunId` against the Run's persisted
`requestSnapshot.sourceMessageId`; a different line cannot capture the message. Within one line,
the FIFO still follows the root source Run even when the message targets a different idle
teammate. Message text never implies interruption. Only an empty Composer submit or an explicit
Run detail action can stop the active reply on that line. No second guidance queue,
continuation protocol, business table, or per-teammate parallel lane is permitted.

The first targeted reply may spend time materializing attachments, links, or routing intent
before its `RunSession` exists. During only that pre-link window, the daemon holds a
process-local pending-reply lane keyed by workspace, channel, and conversation line. A rapid
later submission may follow that existing predecessor without an `activeRunId`, wait for the
owner's real Run linkage, and then append its normal durable `queue_followup`; target identity
never creates another lane. A mode-only request with no live predecessor does not search for an
arbitrary active Run and returns to normal intent routing. The lane stores
no message body, is released when dispatch fails or produces no Run, and is cleared during
daemon shutdown. It is concurrency coordination only: channel messages, `RunSession`, and
`RunIntervention` remain the sole durable sources of truth.

The Web send lifecycle reserves that channel lane synchronously. A later submission sees any
older unsettled submission as its predecessor even before `reply_pending` or `run_linked`
arrives, so its first visual frame is the guidance queue rather than a transcript bubble.
When `followup_queued` arrives, the optimistic guidance rekeys to the durable intervention id
and remains as a confirmed bridge until the authoritative intervention snapshot appears or
the source message enters the transcript. The handoff must never expose an empty or duplicate
intermediate frame.
The daemon also fences the source Item between Turn persistence and dispatch
classification. `GET /channels/:id/items` excludes a fenced Item until either the Turn
owns the reply lane or its durable `queue_followup` exists. A refresh can therefore
never expose a queued source Item during the persistence gap and then retract it.

A `queue_followup` created from an already-persisted channel user message retains both
`sourceMessageId` and `targetTeammateId` for audit and execution. Until its intervention has
`startedAt`, that message is excluded from transcript projections and appears once in the
Composer guidance queue. At `starting_continuation` it leaves the queue and enters the
transcript; cancellation before start keeps it out of the transcript. Background activity
refresh keeps retained feed content visible and must not reopen initial-loading chrome after
the channel scope has loaded once.

Runs and WorkUnits may arrive in separate refresh responses. When a Run references a
`workUnitId` whose WorkUnit has not arrived yet, default chat treats its ownership as
unresolved and does not render a runtime card. Audit/detail views may still expose it. Once
the WorkUnit arrives, the normal visible-work rules decide whether the card belongs in chat;
this fail-closed projection prevents completed reply supervision from flashing for one frame.

The intervention payload carries the durable channel `sourceMessageId`; it must not recover
that relationship by parsing an idempotency key. Each continuation creates one deterministic
pending Agent message before execution. Its continuation WorkUnit owns that source user
message and links to the pending Agent message, while the continuation Run retains
`parentRunId` and `interventionId`. Every successful, failed, cancelled, blocked, or empty
continuation therefore resolves to one visible message terminal state instead of completing
only in the detached runtime sink.

The daemon publishes the compact active-reply target only after both the `RunSession` and
its supervising WorkUnit are durably linked. `queued`, `running`, and
`waiting_for_approval` are all active reply states; `queued` is expected at the first
`reply_linked` event and must already unlock the Composer for guidance or stop. This event
contains only identifiers, scope, status, and timestamps. Channel targets include
`sourceMessageId` for conversation-line projection while `threadId` remains the canonical
LingThread id. It cannot contain prompts,
provider snapshots, raw output, or credentials.

The Web may use that SSE target while the authoritative conversation/channel/private
runtime refresh catches up. Reconciliation merges by `runId`; it does not fabricate a
complete `RunSession`, change domain ids, or create a second execution authority. A fetched
Run detail may replace the list snapshot only when its `updatedAt` is newer; an older detail
must never make a terminal reply look active again. Once guidance mode has ended, the
channel target resets to Ling Agent so a later unmentioned message does not inherit a stale
teammate choice.

## Component Contract

### ConversationShell

Owns:

- feed viewport height,
- composer placement,
- optional header slot,
- optional status strip slot,
- optional floating activity/drawer slot,
- shared max-width and alignment rules.

Does not own:

- channel membership,
- teammate settings,
- provider selection,
- daemon fetching,
- route state,
- app-level side navigation.

Rules:

- feed and composer align to the same text column,
- normal conversation, channel, and private chat use the same width rhythm unless the
  surrounding chrome compresses them,
- empty state is centered inside the feed area,
- shell must not add marketing/landing content after the first message exists.

### ConversationFeed And ConversationVirtualFeed

Own:

- the single vertical `ConversationFeedViewport` scroll owner,
- loading older rows,
- empty state placement,
- scroll-to-latest affordance,
- virtual row placement when needed.

Rules:

- entering a conversation opens at latest,
- loading older messages preserves scroll position,
- active/streaming rows update in place,
- an optimistic send and its acknowledged conversation turn retain one render identity;
  domain message and turn IDs remain unchanged,
- while the user remains pinned to latest, text revisions and measured row-height changes
  schedule at most one tail reconciliation per animation frame; explicit user scroll
  disables follow until the user returns to latest,
- channel Composer clearance is virtual feed `paddingEnd`, not duplicated viewport or row
  padding,
- virtualized and non-virtualized feeds must preserve row width and action placement,
- empty state copy is surface-specific, but the visual component is shared.

### Conversation Send Lifecycle

Channel, normal conversation, and teammate private chat use the same owner-scoped send
lifecycle:

- `submitting`: that request has not yet been accepted; its immutable payload snapshot is
  protected from duplicate submission, but an already-unlocked channel reply may accept a
  second guidance request without globally locking the Composer,
- `message_accepted`: the user message is durable; its optimistic reply projection remains
  attached to that exact message until dispatch or a terminal no-reply result takes over,
- `reply_linked`: a durable run/work-unit target exists; the Composer unlocks and its next
  non-empty submit is guidance while an empty submit is stop,
- `settled`: the reply is terminal and transient targets are cleared,
- `failed_before_accept`: the original draft and pending assets are restored.

Failures after `message_accepted` never restore the original payload because the message
may already be durable. Concurrent request identities remain independently valid; an owner
change rejects stale events from the previous surface, and duplicate active targets merge by
`runId`. Clearing or restoring one request snapshot must not overwrite text or assets entered
for a later request.

Channel streaming emits `reply_pending` after message acceptance and canonical target
resolution only when that message owns an idle channel lane. It occurs before materialization,
intent selection, provider preparation, or Run creation and contains only `sourceMessageId`,
`targetTeammateId`, and `startedAt`. A message that finds an active lane skips this event and
returns its durable `followup_queued` disposition, so it cannot flash a false thinking row.

### MessageRow

Owns:

- actor avatar or spacer,
- message body,
- attachment strip,
- compact evidence/source hooks,
- blocked/failed note,
- footer action anchor.

Rules:

- local user messages align right,
- assistant/teammate/coordinator messages align left,
- channel and teammate private chat render the local user avatar; normal conversation
  intentionally renders no user or Ling Agent avatar,
- repeated actor names are hidden when they add no information,
- avatar size is compact and close to body text scale,
- AI labels are not repeated when the teammate avatar and surface already identify the
  speaker,
- streaming updates mutate one row, not multiple bubbles,
- optimistic pending state and acknowledged pending state use the same `MessageRow`, body
  typography and strong text color; only the spinner uses muted color,
- the shared 13px pending spinner uses a 5px first-line offset; rows must not vertically
  center the entire text block to compensate,
- ordinary conversation body text uses 15px, 550 weight and the semantic strong text token
  on all three desktop surfaces,
- blocked and failed rows remain visible with an actionable reason.

### MessageActionBar

Owns:

- copy,
- feedback,
- edit latest local-user message where policy allows,
- retry or regenerate where policy allows,
- topic reply where policy allows,
- explicit thread fork where policy allows,
- focus/hover visibility,
- inline success/error feedback for the action itself.

Rules:

- action row is visually below body, evidence, sources, and teammate activity,
- action row is hidden until hover/focus unless the action is state-critical,
- icon-only actions require `aria-label`, `title`, and keyboard reachability,
- duplicate page-local copy/reply buttons must be removed when the shared action bar is
  present.
- edit is computed by the scoped surface adapter; the action bar must not infer latest
  message ownership from DOM position,
- editing replaces the message body with the shared inline composer without collapsing
  work/evidence rows below it,
- historical user messages do not show Edit in the first implementation.

### TeammateAvatarStack

Owns:

- compact visual list of participating teammates,
- overflow count such as `+4`,
- tooltip/detail trigger when supported.

Rules:

- use actual teammate avatars when available,
- fall back to stable initials only when no avatar exists,
- no outer decorative frame around normal circular avatars,
- overflow count must have spacing and must not visually stick to the last avatar,
- product copy should say teammates only when text is necessary; the avatar stack can
  stand alone in compact rows.

### SourceIconStack

Owns:

- collapsed icons for web, file, memory, tool, artifact, and app sources,
- overflow count,
- tooltip labels,
- opening the expanded evidence/source menu when supported.

Rules:

- no visible border around normal source icons unless the icon is the active/focused
  control,
- stack icons like teammate avatars instead of scattering them across the row,
- render only when an actual source exists,
- do not render a `web_search` text label when no web search ran.

### EvidenceBundlePanel

Owns:

- collapsed evidence summary,
- expandable sections,
- severity state,
- structured evidence item rendering.

Rules:

- collapsed summary is short text or icon stack, not a mini dashboard,
- approval needed, blocked, failed, and permission denied must be visible before expand,
- memory/file/web/tool sections appear only when used,
- raw provider/runtime metadata stays in expanded or developer detail,
- evidence is attached to the owning turn, not duplicated in a right drawer by default.

### WorkCell

Owns:

- compact active/completed work state,
- operation rows,
- teammate activity spans,
- approval/blocked/failed state,
- artifact/file/check summary.

Rules:

- one user task gets one default visible work object,
- running state mutates to terminal state in place,
- channel teammate activity belongs above the message action row,
- normal conversation and private chat may render compact work cells when actual work
  happened,
- a successful text-only chat run is not visible work. WorkCell appears only for tool or
  execution actions, non-approved approvals, files/artifacts, durable changes/risks, or a
  failed/approval-blocked run,
- generic successful verification summaries such as `1 check passed` do not create a
  WorkCell by themselves,
- run/thread detail can render the richest version of the same work contract.

The operation shell owns alignment, not content padding. Every visual child is rendered
through a semantic head, body, or static-content slot. Static status content uses the
shared operation-cell inline inset on both sides; consumers must not rely on parent padding
or add screenshot-specific margins.

## Surface Policies

### Normal Conversation

Normal conversation is the post-send page created from the home composer.

Required behavior:

- switch away from the home hero layout after the first message,
- render user and assistant rows through shared components,
- show compact evidence/work/source blocks when actual data exists,
- align user and assistant rows to the shared conversation width,
- keep composer anchored to the conversation page.

Must not:

- show channel teammate roster by default,
- show topic-reply controls,
- require opening run thread detail just to see basic evidence,
- keep home-only visual copy after messages exist.

### Channel Root And Channel Branch

Channel surfaces own multi-teammate collaboration.

Required behavior:

- show teammate activity in the turn when teammates contributed,
- place teammate activity above the action row,
- support topic reply only where channel policy allows,
- preserve channel branch context as a separate lane,
- use "teammate" copy, not "expert" copy.

Must not:

- duplicate work summary as both card and raw run row,
- show source/evidence rows with no source/evidence,
- leak branch messages into root context.

### Topic Reply

Topic reply is a lightweight side conversation attached to a channel message.

Required behavior:

- attach replies to the source message,
- avoid default auto-reply fan-out,
- show compact evidence only if the topic reply actually used evidence.

Must not:

- become a channel branch,
- expose global channel teammate activity by default,
- appear in normal conversation or private chat controls.

### Teammate Private Chat

Private chat is direct user-to-teammate conversation.

Required behavior:

- use shared message row, empty state, evidence, attachment, and action primitives,
- preserve selected teammate identity,
- show compact evidence/work when the private teammate used memory, tools, files, or
  approvals,
- resolve and execute the selected teammate's permitted tools, skills, MCP, provider,
  runner, direct workspace, authorization snapshot, and approval policy,
- render private execution with the shared operation and approval components,
- render the shared `terminalReport` outcome, changes, verification, artifacts, risks, and
  references without a Participants section,
- keep private chat empty state centered.

Must not:

- expose `@` teammate routing,
- show other teammate avatar stacks,
- automatically publish private memory or private evidence into channel context,
- bypass approvals for side effects.

### Run/Thread Detail

Run/thread detail is the rich inspection surface for durable work.

Required behavior:

- render the richest version of the same work/evidence contract,
- preserve raw/debug affordances for developer/support use,
- link back to the owning conversation turn.

Must not:

- be the only place normal conversations can see evidence,
- duplicate the same terminal result in both feed and detail as two separate product
  objects,
- redefine shared message row or action bar behavior.

## State Contract

All surfaces use the same state vocabulary:

| State | Meaning | UI rule |
| --- | --- | --- |
| `empty` | no messages in this surface | centered shared empty state |
| `loading` | first page loading | centered loading affordance |
| `loading_older` | older messages loading | top loader that preserves scroll |
| `ready` | committed row | normal row |
| `thinking` | assistant/model has accepted the turn but no text is final | one pending row or compact status, not multiple placeholders |
| `streaming` | text is arriving | mutate same row |
| `running` | work/tool/run is active | mutate same work cell |
| `waiting_for_approval` | user action required | visible state-critical action |
| `blocked` | cannot proceed without fix/confirmation | visible reason and next action |
| `failed` | terminal failure | visible reason and retry path when safe |
| `cancelled` | user or policy stopped it | neutral stopped state |
| `superseded` | a newer user-message revision replaced this logical turn | hidden from default transcript; visible in audit detail |
| `editing` | latest local-user message is in the inline editor | keep row geometry stable and lock duplicate edit actions |
| `succeeded` | terminal success | quiet terminal state |

For identity switches inside an already loaded workspace, request activity does not automatically become a visible `loading` state. The feed hides the previous identity's snapshot, suppresses the empty state until the new first page commits, and only renders rows whose workspace and conversation owner match the selected surface.

Do not invent page-local labels such as `complete-card`, `experts-running`, or
`web_search_pending` as UI state. Those may be implementation details inside evidence,
but the shared renderer receives the common state vocabulary.

## Historical v3.6 Data Contract (migration input only)

> 本节保留旧字段，方便 adapter 对照。v3.7 新代码不得直接消费这里的
> `ConversationTurnView`/`ConversationSurfaceView`，必须先转换到
> `ResolvedConversationSurface + TimelineSnapshot`。

The Web can continue deriving this from existing stores during the next slice, but the
view model should converge toward this shape:

```ts
type ConversationSurfaceKind =
  | "normal_conversation"
  | "channel_root"
  | "channel_branch"
  | "topic_reply"
  | "teammate_direct"
  | "run_thread";

type ConversationCapabilityKind =
  | "attachment"
  | "file_reference"
  | "web_source"
  | "memory_source"
  | "tool_source"
  | "artifact"
  | "approval"
  | "work_cell"
  | "teammate_activity";

interface ConversationSurfacePolicy {
  readonly surface: ConversationSurfaceKind;
  readonly allowTopicReply: boolean;
  readonly allowTeammateMentions: boolean;
  readonly allowMultiTeammateActivity: boolean;
  readonly showChannelRoster: boolean;
  readonly evidenceMode: "none" | "compact" | "rich";
  readonly workCellMode: "none" | "compact" | "rich";
  readonly rawDetailMode: "hidden" | "developer" | "rich";
}

interface ConversationTurnView {
  readonly id: string;
  readonly surface: ConversationSurfaceKind;
  readonly userMessageId?: string;
  readonly rows: readonly ConversationRowView[];
  readonly capabilities: readonly ConversationCapabilityView[];
  readonly actions: readonly ConversationActionView[];
  readonly status: ConversationTurnStatus;
}
```

Generated media is an additive capability view, not a message-text convention:

```ts
interface ConversationGeneratedMediaView {
  readonly mediaJobId: string;
  readonly runId: string;
  readonly messageId?: string;
  readonly operation: "image_generate" | "video_generate";
  readonly status: "queued" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";
  readonly targetDisplayName: string;
  readonly artifacts: readonly ConversationArtifactView[];
  readonly errorMessage?: string;
}
```

The daemon derives this view from durable parent Run, child MediaJob WorkUnit, MediaJob,
and MediaJob artifacts. Web adapters never infer generation ownership from assistant text or
tool-event wording. Refresh and reconnect rebuild the same projection from storage.

Policy is explicit. Components should not infer policy from route name, message text, or
whether `threadId` is present.

## Historical v3.6 Detailed Surface View Contract (migration input only)

> 下面的 `rows`、`workCell`、`floatingActivity` 是旧投影的输入形状。它们不能直接进入
> 生产 DOM；统一入口是 `mountConversationTimeline()`，重复内容必须在 adapter 阶段归一化。

Shared conversation UI should receive an already-scoped surface view. It should not fetch
daemon state, resolve channel membership, inspect teammate settings, or guess context from
message text.

Target shape:

```ts
interface ConversationSurfaceView {
  readonly surface: ConversationSurfaceKind;
  readonly ownerId: string;
  readonly policy: ConversationSurfacePolicy;
  readonly rows: readonly ConversationRowView[];
  readonly emptyState: ConversationEmptyStateView;
  readonly composer?: ConversationComposerView;
  readonly floatingActivity?: ConversationFloatingActivityView;
}

interface ConversationRowView {
  readonly id: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly role: "user" | "assistant" | "system" | "teammate" | "coordinator";
  readonly authorId?: string;
  readonly authorLabel?: string;
  readonly body: string;
  readonly status: ConversationTurnStatus;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly attachments?: readonly ConversationCapabilityView[];
  readonly evidence?: ConversationEvidenceView;
  readonly workCell?: ConversationWorkCellView;
  readonly teammateActivity?: ConversationTeammateActivityView;
  readonly actions?: readonly ConversationActionView[];
}
```

Current Web implementation state:

- `ConversationTranscriptMessage` already carries `threadId`, `turnId`, and `runId`.
- `ConversationDetailResponse` already carries `turns`, `runs`, and `messages`.
- `AppShell` preserves `threadId`, `turnId`, and `runId` when it maps transcript
  messages into `ConversationHomeMessage`.
- `ConversationHome` receives `ConversationHomeDetailContext` with the selected
  `threadId`, `turns`, and `runs`.
- The first compact-work pass intentionally attaches work by exact `message.runId`
  only. `threadId` is used to anchor an already-matched run, not to attach every run in
  the thread to every assistant message.
- Turn-level and thread-level fallback remain future projector work. They require an
  explicit turn-run relation and tests that prove the UI will not duplicate a thread's
  work cell under multiple assistant rows.

Without a row-level run or future explicit turn-run relation, the correct default is to
render no compact work/evidence block.

## Capability Rendering Gates

Capability blocks render only when the surface view provides real capability data.

| Capability | Minimum required data | Render when absent |
| --- | --- | --- |
| Source icon stack | At least one source item with kind and label, and either an actual source reference or a state reason | Render nothing |
| Web source | Search/open-url evidence with result URL, query, citation, or blocked/degraded reason | Render nothing, including no `web_search` label |
| File reference | File path, uploaded file id, artifact id, or composer file reference | Render nothing |
| Memory evidence | Used memory event, memory source id, or promoted note reference | Render nothing |
| Tool evidence | Tool call/run event/evidence item tied to the row turn or run | Render nothing |
| Work cell | Run, workflow, approval, artifact, check, or operation state tied to `turnId`, `runId`, or `threadId` | Render nothing |
| Teammate activity | Channel-scoped teammate span tied to the current channel turn | Render nothing outside channel surfaces |
| Approval state | Approval/checkpoint requiring action or showing terminal result | Render nothing unless tied to the row turn or run |

Do not synthesize capability blocks from assistant prose, markdown headings, fixed
templates, or inferred keywords. Copy can mention that a tool was used, but the UI block
needs structured data.

## Row Ordering Contract

Every assistant, teammate, coordinator, and system row follows the same slot order:

```text
avatar / author affordance
  -> body
  -> attachments
  -> compact work cell
  -> evidence/source summary
  -> teammate activity
  -> blocked/failed/approval state
  -> action bar
```

Rules:

- the action bar is always the last visual layer of the row or turn,
- status-critical approval/blocked controls remain visible even when ordinary actions are
  hover/focus only,
- teammate activity is channel-only by default and sits above the action bar,
- evidence and work cells stay attached to the owning turn instead of moving into a
  default right drawer duplicate,
- a row can omit any slot whose data is missing.

## Normal Conversation Detailed Design

Normal conversation is the simplest product surface, not the least capable surface.

Required data path for Slice 2B:

```text
ConversationDetailResponse.messages
  -> preserve threadId / turnId / runId in ConversationHomeMessage
  -> build maps from ConversationDetailResponse.turns and runs
  -> attach compact work only when a row has runId that matches a real run
  -> preserve turnId/threadId for future explicit projector matching
  -> render through shared MessageRow, EvidenceBundlePanel, WorkCell, SourceIconStack,
     and MessageActionBar policy
```

Current first-pass matching:

1. `message.runId` must match `RunSession.id`.
2. The matched run must have a usable `threadId`, or the selected conversation
   `threadId` must provide the anchor.
3. `message.turnId` is preserved for future projector work, but does not currently attach
   a run by itself.
4. `message.threadId` is preserved for ownership and future detail linking, but must not
   be used as a broad per-row fallback that duplicates all thread runs.

Rendering rules (v3.7 target; the pre-v3.6 geometry is historical only):

- user and assistant messages share the left-aligned document lane; identity comes from
  lightweight author metadata, not a right-side square bubble,
- assistant messages do not show a Ling Agent avatar or repeat the Ling Agent label on
  every ordinary reply,
- assistant rows can show copy/feedback only when the action state exists,
- compact work/evidence appears only when matched to real detail data,
- normal conversation does not show topic reply,
- normal conversation does not show channel roster or multi-teammate collaboration by
  default,
- the empty state is shared, but copy is normal-conversation specific.

If no `runs` or evidence records exist for a plain answer, the normal conversation renders
only the message rows. That is correct.

## Channel Detailed Design

Channel is the default multi-teammate collaboration surface.

Required behavior:

- root and branch messages share the same row primitives,
- branch selection changes the scoped feed, not the shared renderer,
- topic reply exists only through channel policy,
- teammate avatar/activity stacks render only when channel turn data contains real
  teammate participation,
- channel root must not absorb branch-root messages,
- channel branch must not clone channel settings or teammate policy.

Channel can use richer local orchestration data than normal conversation, but the
rendered blocks must still use shared primitives. Page-local channel code can build the
view model; it should not redefine action bars, source stacks, or message row semantics.

## Teammate Private Chat Detailed Design

Private chat is a one-to-one surface with the selected teammate.

Required behavior:

- preserve selected teammate identity in the row avatar/header,
- render compact evidence/work only for that private thread and selected teammate,
- never show `@` teammate routing,
- never show other teammate avatar stacks,
- never auto-promote private evidence into channel context,
- keep create-task actions scoped to the selected teammate and approval policy.

Current first-pass matching:

1. the row must be an AI teammate message,
2. the row must carry `linkedRunId`,
3. `linkedRunId` must match a real `RunSession`,
4. the run must have `threadId`,
5. if the run carries `teammateId`, it must equal the selected teammate id.

Private chat may use the same capability blocks as normal conversation, but the scope is
stricter. A private row cannot import channel evidence unless the user explicitly linked
or promoted that evidence.

## Run/Thread Detail Detailed Design

Run/thread detail is the rich inspection mode for the same underlying capability data.

Required behavior:

- show rich work cell, rich evidence, raw detail, run events, artifacts, and approvals,
- link back to the owning conversation row or turn,
- keep raw provider/runtime detail out of the main feed by default,
- avoid duplicating the final answer as a second product object.

Run/thread detail can render more data than compact surfaces, but it must not own a
separate visual language for message rows, source icons, action bars, or empty states.

## Empty State Contract

Empty states use a shared visual component with surface-specific copy.

| Surface | Primary empty-state meaning | Copy boundary |
| --- | --- | --- |
| Normal conversation | The user has not sent a message in this conversation | Direct assistant conversation, no teammate roster |
| Channel root | The channel has no root messages yet | Team room and channel collaboration |
| Channel branch | The branch lane has no messages yet | Focused lane under the current channel |
| Topic reply | The message has no side replies yet | Lightweight message-level discussion |
| Teammate private chat | The user has not chatted with this teammate yet | One-to-one teammate conversation |
| Run/thread detail | The thread has no visible run detail yet | Work history or inspection state |

Rules:

- empty state is centered inside the feed viewport,
- private and channel empty states share layout but not copy,
- empty state must not render channel teammate rosters in private or normal surfaces,
- empty state must not expose actions the surface policy forbids.

## Package Extraction Readiness

Shared package extraction can start when these conditions are true in Web. They are now
true enough for first-wave composer/message/feed/action/identity/feedback components:

- normal conversation, channel, and private chat consume the same action policy helper,
- normal conversation, channel, and private chat consume the same composer root props or
  a deliberately documented adapter superset,
- `MessageActionBar`, `SourceIconStack`, and `TeammateAvatarStack` have stable props,
- composer authorization, model picker/status, active guidance, and attachment preview
  props are stable across at least two surfaces,
- compact evidence/work view models are no longer page-local guesses,
- tests cover policy filtering and absence gates for real vs missing capability data,
- no extracted component imports daemon route modules, channel stores, teammate settings,
  or app shell navigation.

The first package should contain pure contracts and policy helpers. React extraction
should come after at least two Web surfaces use the same props without adapter-specific
exceptions.

## Visual Contract

Shared visual rules:

- message column and composer align,
- composer shell, toolbar, send button, pending asset strip, popovers, and focus states
  use one shared visual system across normal conversation, channel, and teammate
  private chat,
- pending images, files, links and file references stay in one non-wrapping row; overflow
  scrolls horizontally inside the strip and never expands the page or wraps into a second
  Composer row,
- user and assistant messages align to the same left document column,
- avatars are compact and actual where available,
- icon stacks overlap cleanly with stable spacing,
- no redundant "teammate" label when the avatar stack already occupies that slot,
- no decorative border around ordinary avatar/source icons,
- action bars appear on hover/focus and remain keyboard reachable,
- status-critical controls remain visible,
- titles in evidence/source rows may use semantic accent color, but the surface must not
  collapse into a one-note palette,
- text must not overlap or require horizontal scrolling outside code/log blocks,
- the final visible message keeps at least 38px clearance above the channel composer.

## Regression Contract

Every future slice touching conversation UI should keep or add focused tests for:

- normal conversation switches to conversation surface after send,
- normal conversation row width matches the shared shell,
- private chat empty state shares the centered conversation empty state,
- private chat does not expose `@` teammate routing,
- channel teammate activity renders above the action row,
- execute turns end with the shared `terminalReport` result row; reply turns end with the
  final assistant document, and neither may be duplicated outside the Timeline,
- source icons render only for actual sources,
- `web_search` text does not render when no search occurred,
- avatar/source overflow counts do not collide with the stack,
- copy/feedback/topic actions are hover/focus reachable,
- evidence/work cells render in compact mode outside run/thread detail,
- reduced or missing avatar data falls back to stable initials without broken layout.
- edit appears only on the latest local-user message in the scoped surface lane,
- edited turns keep workspace changes while old reply/work evidence moves to audit-only
  projection,
- normal and teammate-private TerminalReports omit Participants while channel reports keep
  actual participant avatars,
- private chat can render real Read/Edit/Shell/Check operations under effective policy,
- Mermaid and structured Markdown render through the same body renderer on channel,
  normal, private, and topic surfaces,
- invalid or incomplete Mermaid falls back to source without breaking the transcript.
- pending text does not change size, weight or color when the server acknowledges it,
- optimistic send acknowledgement does not replace the virtual row identity,
- a channel message that owns an idle lane receives canonical `reply_pending` before costly
  routing work; a queued follow-up receives no false pending projection and moves directly to
  the durable guidance queue,
- a pinned channel feed follows in-place streaming growth while user-scrolled history
  keeps its visible anchor,
- four pending images remain one internally scrollable Composer row on normal, channel and
  teammate-private surfaces,
- pasted files are prevented from entering the contenteditable DOM and use the same
  attachment controller as selected or dropped files; both clipboard `files` and
  file-kind `items` are recognized, while text paste accepts plain text only,
- the tokenized editor remains `contenteditable=plaintext-only`, and all pending images
  render through the same `ComposerPendingAssetStrip` card geometry on every surface,
- successful text-only chat runs do not expose WorkCell status or generic check summaries,
- runners that emit only final assistant text still produce one visible response without
  duplicating providers that already emitted text deltas,
- reasoning-only or structurally empty successful responses never become assistant body
  text and fail provider readiness with `empty_response`.
- a successful conversation run with a persisted `ConversationGeneratedMedia` projection may
  have an empty assistant body: the media block is the visible result. Normal conversation,
  initial channel reply, queued channel continuation and teammate private chat must not turn
  that tool-only result into an empty-response error or synthetic acknowledgement. A successful
  run with neither visible text nor generated-media projection still fails at message level.
- while a conversation feed is pinned to the latest turn, late layout growth from generated
  media, previews, fonts, or other asynchronous content must preserve that bottom pin. The
  complete outer message row must remain scrollable above the Composer boundary; measuring an
  inner WorkCell or text block is not sufficient overlap evidence. If the user has intentionally
  scrolled away from the latest turn, asynchronous growth must not pull them back to the bottom.

## Implementation Slice Status

> 这些 Slice 的 `implemented` 状态记录的是 v3.6 shared-surface baseline，不等于
> v3.7 typed transcript 已完成。v3.7 cutover 后，WorkCell、旧 operation block 和
> summary 只能作为 adapter 输入；是否完成以 canonical Timeline fingerprint、atomic
> recovery 和 packaged macOS evidence 为准。

### Slice 2A: Contract And Component Boundary

Goal: make the shared component boundary explicit before more visual work.

Detailed execution plan:

- [Conversation Surface Contract Implementation Plan](conversation-surface-contract-implementation-plan.md)

Work:

- `MessageActionBar` is formalized as the shared policy-filtered row action primitive,
- `TeammateAvatarStack` is formalized as the shared compact teammate identity stack,
- `SourceIconStack` is formalized as the shared compact source identity stack,
- align `ConversationFeed` and `ConversationVirtualFeed` props around shared labels,
- document and test surface policy defaults.

Acceptance:

- normal conversation, channel, and private chat import the same action/avatar/source
  primitives,
- no surface-specific action row duplicates copy/reply/feedback,
- policy tests prove private chat cannot render channel-only controls.

Status: implemented in the current branch.

### Slice 2B: Capability Parity

Goal: make shared capabilities available where the product says they exist.

Work:

- normal conversation renders compact work cells from exact `message.runId` matches,
- private chat renders compact work cells from exact `linkedRunId` matches scoped to the
  selected teammate,
- make file/reference/source blocks use shared primitives,
- keep run/thread detail as rich mode rather than a separate product model.

Acceptance:

- normal conversation can show evidence/work without navigating to run detail,
- private chat can show evidence/work for the selected teammate only,
- channel still owns multi-teammate collaboration.

Status: implemented. Normal conversation and private chat use exact run linkage for compact
WorkCell projection, and shared reference/file previews preserve the real-data rendering
gate.

### Slice 2C: Visual Regression Guard

Goal: stop repeated screenshot-driven drift.

Work:

- add fixture-like E2E states for normal, channel, private, empty, evidence, source,
  teammate activity, action row, and overflow icons,
- add selectors for shared primitives,
- keep screenshots optional until fixture stability is good, but enforce DOM and layout
  invariants now.

Acceptance:

- tests fail if action row moves above teammate activity,
- tests fail if private chat grows `@` routing,
- tests fail if source rows render with no sources,
- tests fail if normal conversation stays in home layout after send.

Status: focused DOM/E2E regression coverage is implemented for the touched normal,
channel, private, action, source, and linked-run paths.

### Slice 2D: Shared Composer

Goal: make input surfaces part of the same Conversation UI Kit instead of page-local
composer systems.

Detailed execution plan:

- [Conversation Composer Unification](./conversation-composer-unification.md)

Work:

- create a shared composer shell, toolbar, preview strip, popover treatment, and send/stop
  slot,
- keep channel as the functional baseline for `/`, `@`, attachments, active guidance, and
  stop/follow-up,
- keep normal conversation as the visual baseline for floating shadow, rounded shell, and
  focused input treatment,
- render four-preset authorization on channel, normal conversation, and teammate private
  chat,
- lock authorization while a run/model call/direct reply is active,
- keep model picker limited to normal conversation,
- keep teammate private chat model status read-only when shown,
- keep normal conversation and teammate private chat free of `@` teammate routing.

Acceptance:

- all three surfaces render the shared composer root,
- channel still supports `/`, `@`, active guidance, attachments, and stop/follow-up,
- normal conversation shows model picker and authorization,
- teammate private chat shows authorization and no model picker,
- active execution disables authorization until the next turn/run,
- shared composer CSS owns shell, toolbar, popovers, preview chips, and send button
  tokens.

Status: implemented. Channel, normal conversation, and teammate private chat render the
shared composer shell, tokenized input, permission menu, and surface-specific slots while
retaining their distinct routing capabilities.

### Slice 2E: Shared Rich Content And Latest Message Edit

Goal: complete shared message-body and interaction parity.

Detailed design and execution plan:

- [Conversation Shared Capabilities Detailed Design](conversation-shared-capabilities-detailed-design.md)
- [Conversation Shared Capabilities](./conversation-shared-capabilities.md)

Work:

- add structured Markdown, Mermaid, math, references, and streaming-safe rich blocks,
- add latest-local-user-message Edit to the shared action bar,
- persist revisions and supersession without deleting old work evidence,
- rerun in the same thread and current workspace,
- hide superseded projection rows from the default transcript.

Status: implemented. Structured GFM, Mermaid, KaTeX, safe references, streaming boundaries,
latest-message editing, revision persistence, supersession, and same-lane replacement are
covered by package tests and surface E2E.

### Slice 2F: Teammate Private Execution Parity

Goal: make private chat use the shared execution UI and actual teammate runtime policy.

Work:

- replace the hardcoded empty tool list with effective teammate execution resolution,
- link private runs to shared WorkCell, approval, artifact, and TerminalReport components,
- keep the surface single-agent and suppress TerminalReport Participants.

Status: implemented. Teammate private chat resolves effective tools and permissions, runs
through the supervised runtime, projects approval/artifact/TerminalReport state through the
shared WorkCell, and suppresses Participants.

### Slice 3: Package Extraction

Goal: make Web and future Desktop/PC consume the same conversation semantics.

Work:

- pure surface policy and action filtering live in `packages/conversation-ui-core`,
- move app-agnostic React components to `packages/conversation-ui-react`,
- keep daemon fetching, routing, membership, settings, and policy outside the package.

Acceptance:

- fixture transcript data can render without channel app state,
- package imports do not reach into daemon/API route modules,
- Desktop can start from the same transcript contract instead of copying Web logic.

Status: core-only extraction and first-wave React component extraction are implemented.
`packages/conversation-ui-react` owns first-wave shared
composer/message/feed/action/identity/feedback primitives, while Web adapters remain in
`apps/web`.

Detailed package boundaries, component migration map, renderer-slot strategy, dependency
guards, and validation commands are defined in
[Conversation UI Package Extraction Implementation Plan](./conversation-surface-contract-implementation-plan.md).

## v3.7 Decision Disposition

The former open transcript decisions are resolved so implementation cannot preserve a
second UI path by accident:

- the floating activity surface becomes the shared `EnvironmentPopover` shell slot. It
  shows only the current ambient run/action and never becomes a channel-only history or
  summary panel;
- no `turnId` or thread-level time/text fallback may attach work. Projection requires an
  explicit turn-run/action relation and a same-thread conversation-item anchor;
- thread work appears in its owning typed row. Full detail can open through a trusted
  run/artifact ref; there is no separate thread summary strip;
- production `ConversationWorkCell` activity rendering is removed after surface parity
  cutover. Preview, file and diff primitives may later move packages without changing
  the one Timeline/registry ownership;
- semantic fingerprint tests are mandatory now. Packaged macOS screenshots plus
  semantic state, lineage and redacted logs are the release gate; whether pixel snapshots
  also run on every CI job is tooling policy, not a product-design blocker.

Latest-message editing retains current workspace state, stays in the same thread/branch,
and hides superseded work from the default transcript while preserving audit evidence.
There are no unresolved product or architecture decisions for the v3.7 implementation.
