# Channel Workspace Design

## Status

Draft design for the next channel-focused Web UI slice.

This document is the tracking source for the channel feature. It should be updated when
the Web UI, daemon contract, or AI teammate persistence changes the channel behavior.

Related docs:

- [Web UI v0.1 Design](web-ui-v0.1.md)
- [Channel Workspace v1.1 Design and Implementation Plan](channel-workspace-v1.1.md)
- [Channel Workspace v1.2 Handoff Workflows](channel-workspace-v1.2.md)
- [Channel Workspace v1.3 Chat Experience](channel-workspace-v1.3.md)
- [Channel Workspace v1.4 Files and Run Artifacts](channel-workspace-v1.4.md)
- [Channel Workspace v1.5 Activity Events](channel-workspace-v1.5.md)
- [Channel Workspace v1.6 Activity Filters and Search](channel-workspace-v1.6.md)
- [Channel Workspace v1.7 Activity Saved Views and Attention Queue](channel-workspace-v1.7.md)
- [Channel Workspace v1.8 Activity Source Drilldown](channel-workspace-v1.8.md)
- [Channel Workspace v1.9 Activity Triage Actions](channel-workspace-v1.9.md)
- [Channel Workspace v1.10 Activity Layout Cleanup](channel-workspace-v1.10.md)
- [Channel Workspace v1.11 Surface Simplification](channel-workspace-v1.11.md)
- [Channel Workspace v1.12 Teammate Management](channel-workspace-v1.12.md)
- [Channel Workspace v1.13 Smart Composer](channel-workspace-v1.13.md)
- [Channel Workspace v1.14 Activity Message Boundary](channel-workspace-v1.14.md)
- [Channel Workspace v1.15 Helio-Style Chat and Topics](channel-workspace-v1.15.md)
- [Channel Workspace v1.16 Channel Settings Panels](channel-workspace-v1.16.md)
- [Channel Workspace v1.17 Teammate Dock and Hover Topic Actions](channel-workspace-v1.17.md)
- [Channel Workspace v1.18 Unified Composer Actions](channel-workspace-v1.18.md)
- [Channel Workspace v1.19 General Multi-Agent Studio and Execution Proposals](channel-workspace-v1.19.md)
- [Channel Workspace v1.20 Chat Composer Task Action Removal](channel-workspace-v1.20.md)
- [Channel Workspace v1.21 Codex-Style Chat Workspace](channel-workspace-v1.21.md)
- [Channel Workspace v1.22 Long Conversation Virtual Feed](channel-workspace-v1.22.md)
- [Channel Workspace v1.23 Explicit Task Selection](channel-workspace-v1.23.md)
- [Channel Workspace v1.24 Right Drawer Workspace](channel-workspace-v1.24.md)
- [Channel Workspace v1.25 Codex-Inspired Attention Popover](channel-workspace-v1.25.md)
- [Channel Workspace v1.26 Channel Branches](channel-workspace-v1.26.md)
- [Channel Workspace v1.27 Environment Surface](channel-workspace-v1.27-environment-surface.md)
- [Channel Workspace v1.27 Environment Surface Detailed Design](channel-workspace-v1.27-environment-surface-detailed-design.md)
- [Channel Workspace v1.27 Environment Surface First Implementation Plan](channel-workspace-v1.27-environment-surface-implementation-plan.md)
- [Channel Workspace v1.28 Environment Git Status](channel-workspace-v1.28-environment-git-status.md)
- [Channel Workspace v1.28 Environment Git Status Detailed Design](channel-workspace-v1.28-environment-git-status-detailed-design.md)
- [Channel Workspace v1.28 Environment Git Status Implementation Plan](channel-workspace-v1.28-environment-git-status-implementation-plan.md)
- [Channel Workspace v1.29 Layout Shell](channel-workspace-v1.29-layout-shell.md)
- [Conversation Surface Taxonomy](conversation-surface-taxonomy.md)
- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation Right Dock Workspace Tools](conversation-right-dock-workspace-tools.md)
- [Channel And Agent Governance Notifications](channel-and-agent-governance-notifications.md)
- [Channel Auto Reply Router](channel-auto-reply-router.md)
- [Channel Intent To Workflow Selector](channel-intent-workflow-selector.md)
- [Channel Context Processing Layer](channel-context-processing-layer.md)
- [Channel Context Processing Layer Implementation Plan](channel-context-processing-layer-implementation-plan.md)
- [Channel Context Budget Manager](channel-context-budget-manager.md)
- [Channel Team Operating System](channel-team-operating-system.md)
- [Codex-Inspired Conversation Experience v1](codex-inspired-conversation-v1.md)
- [Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md)
- [AI Teammates and Skills](ai-teammates-and-skills.md)
- [AI Teammate Private Workspace](ai-teammate-private-workspace.md)
- [Multi-Agent Collaboration Cards And Ambient Audit](multi-agent-collaboration-cards-and-ambient-audit.md)
- [Multi-Agent Collaboration Cards Implementation Plan](multi-agent-collaboration-cards-implementation-plan.md)
- [Multi-channel concurrency](multi-channel-concurrency.md)
- [State machines and recovery](state-machine-recovery.md)
- [Runtime Supervisor](runtime-supervisor.md)
- [Daemon API](../daemon-api.md)

External pattern references:

- [Slack canvases](https://slack.com/help/articles/203950418-use-posts-in-slack)
- [Slack canvases for tasks and alignment](https://slack.com/help/articles/14455334890259-Canvases--Take-notes-and-align-on-tasks)
- [Microsoft Teams Channel Agent](https://learn.microsoft.com/MicrosoftTeams/set-up-channel-agent-teams)
- [ChatGPT Projects](https://help.openai.com/en/articles/10169521-chatgpt-projects)
- [GitHub Copilot coding agent](https://docs.github.com/en/copilot/using-github-copilot/coding-agent/about-assigning-tasks-to-copilot)
- [OpenAI Codex open-source project](https://github.com/openai/codex)

## Problem

The current channel surface already supports a useful local loop:

```text
select channel
-> create task
-> choose provider
-> check or run task
-> inspect run and approvals
```

However, the product still reads too much like a configuration dashboard. The channel
does not yet feel like the primary workspace where a human and AI teammates coordinate
work. The missing pieces are:

- clear channel identity and purpose,
- visible channel members and default AI teammate,
- durable activity stream rather than only synthetic messages,
- a quiet chat-first channel surface with details in a right-side panel,
- member management, notifications, settings, tasks, files, and context reachable without
  taking over the chat surface,
- file/artifact access from the channel itself,
- an implementation checklist that keeps future slices aligned.

## Product Position

A Ling Stack channel is not a generic chat room and is not a coding-only task room.

A channel is a general multi-agent work studio. It can be a software workspace, film
production room, product planning room, content desk, operations room, research room, or
another domain-specific scene. Chat-like activity is only one representation of durable
work events. The durable objects are:

- channel configuration,
- AI teammate membership and defaults,
- coordinator and role assignments,
- execution proposals,
- collaboration records,
- tasks,
- runs,
- approvals,
- artifacts,
- runtime locks,
- state transitions.

The user should feel they are working in a focused studio with configurable AI teammates,
not messaging a bot in a stateless chat client.

## Design Goals

- Make the selected channel the default first screen for real work.
- Keep execution proposals and execution state more important than free-form chat.
- Make the default coordinator and available AI teammates visible and editable from the channel.
- Make multi-agent ownership and handoff visible before work starts.
- Keep provider, tools, approval profile, and runtime lock state inspectable before a run,
  with execution configuration following the assigned agent.
- Let files and run artifacts be reached from the channel without opening run history first.
- Preserve decisions, task context, and layered channel context so agents can continue
  work or ordinary chat without making the user restate the previous topic.
- Preserve the current local-first daemon contract and avoid implying cloud/team sync.
- Keep the implementation small enough to land in slices.

## Non-Goals

- Full Slack/Discord clone.
- Cloud organizations, billing, or realtime multi-user presence.
- Rich file explorer or in-browser code editor.
- Unbounded generic chat that bypasses channel messages, tasks, approvals, or run state.
- Broadcast-style multi-agent chat where every teammate posts visible messages by default.
- Automatic trust in uploaded files, Office macros, embedded scripts, or binary content.
- Automatic crawling, scraping, or AI ingestion of shared web links.
- Bypassing provider preflight, approval policy, or runtime lock checks.

## UX Model

The reference direction is Helio-like in structure, but Ling Stack-specific in behavior:

```text
left sidebar
  workspace navigation
  channels
  AI teammates
  direct messages

center channel
  header
  default chat surface
  quiet chat feed
  discussion composer

right details panel
  full-height selected task/run detail drawer
  files
  context/runtime
  approvals and run details
```

The center area should not start with setup forms once a channel exists. Setup and
configuration belong in compact drawers, inspectors, or dedicated settings views.
Chat is not a tab in the default channel workspace; it is the stable center surface.
Secondary channel surfaces open from the header `...` menu into an in-layout right panel.
The channel header uses borderless icon controls: the left drawer toggle, `#` identity
marker, `...`, teammate management, settings, attention queue, and details toggle all
share the same icon color and 18px glyph size. The attention queue icon should not carry
an overlaid numeric badge; progress and attention counts belong in the popover or detail
surfaces.
The left navigation is also a shared app drawer in the accepted channel chat direction:
expanded at 240px, collapsed to a 48px toolbar rail, and recoverable by hover/focus. It
does not switch back to the older global sidebar styling when the user opens model
workbench, runs, inbox, media jobs, AI teammates, or settings; those pages change the
center surface while preserving the same drawer geometry, row treatment, notification
badges, and bottom settings group. The right details surface is a full-height drawer
aligned to the top of the channel workspace, while the channel header and chat body occupy
only the center column. Avoid placing a second close button inside the right drawer; the
header show/hide icon owns that state.
The current channel remains visibly selected with a full-row neutral background, without
the older sidebar accent bar. AI teammate rows use circular initial avatars rather than
generic bot icons, and drawer header actions stay hidden until hover/focus so the surface
does not read like a busy toolbar by default. Channel and AI teammate row badges are
notifications only: no notification renders no trailing marker, unread renders a green
dot. Channel rows do not show numeric attention pills; opening a channel clears its
unread dot. AI teammate rows may keep counted attention pills for teammate-specific work.
Section header actions are icon-only; empty or loading sections must not flash legacy
`Create` text labels. They must not show generic online/active status dots. The bottom approval and Settings entries share
the accepted HTML bottom-group treatment: a divider above them and ordinary drawer rows, not legacy
warning-card or icon-only sidebar styling. Long AI teammate lists scroll inside the
teammate section so the bottom group remains visible.
Channel rows may own one level of channel branches. A channel branch is a product work
lane under the parent channel, not a Git branch. The section header `+` creates a
top-level channel; a hovered or focused channel row exposes row actions for `Create
branch` and `Archive channel`; a hovered or focused branch row exposes only `Archive
branch`. Branches render as an indented tree continuation below the parent channel, not as
nested cards or separate top-level channels. The detailed boundary between channel root,
channel branch, topic reply, teammate private chat, and future session surfaces lives in
[Conversation Surface Taxonomy](conversation-surface-taxonomy.md).

When the right details drawer is hidden, the chat body and composer expand back into the
available channel content area. If the attention queue is visible, wide viewports keep
the accepted HTML natural spacing between chat/composer and the popover, and very wide
collapsed-left layouts nudge the conversation column slightly toward that popover so the
surfaces read as one workspace. Narrower desktop widths align the chat body and composer
against the popover lane with a small safety gap, instead of keeping the conversation
centered while the popover is open. When the right details drawer is shown again, it
compresses the chat area and hides the attention popover while preserving the selected
detail view.

The attention popover keeps the accepted HTML typography scale: 14px/600 section titles,
12px/500 progress rows, 12px/400 secondary copy, 13px/600 attention item titles, and
compact 11px/600 status/meta chips. Progress status icons are 18px with 2.4px stroke so
check and waiting states have the same visual weight. It should not use heavier 760/780
text weights that make the popover read larger than the chat workspace.

### Channel Branches

Channel branches are a work-lane data model for splitting one channel into focused
execution history without creating another full channel.

Current product boundary: the normal channel workspace renders only real channel branches
under their parent channel. It must not render a synthetic `Main branch` /
`Default channel branch` row, and it must not render the conversation branch tree above
the feed. A hovered or focused channel row exposes `Create branch` for quick branch
creation. Work History / Run Diagnostics owns thread lineage, fork, pin, archive, search,
and filter controls. This keeps the collaboration surface focused on the current channel
instead of showing duplicate `Main branch` navigation in the chat view.

Rules:

- branches belong to exactly one parent channel,
- branches are one level deep,
- branches do not override provider, teammate, bound path, or runtime policy in the first
  implementation,
- branches use `ChannelBranch.rootThreadId` as the selected conversation scope; topic
  replies continue to use `ChannelMessage.threadId = sourceMessage.id` and are not branch
  navigation,
- creating a channel branch is available from the parent channel row,
- forking, pinning, archiving, and filtering work branches happens in Work History / Run
  Diagnostics, not the normal channel drawer,
- archiving a channel and archiving a branch remain separate actions,
- active branches render under their parent channel; archived branches are hidden from the
  default drawer and should be restorable from Settings archived-items management,
- archived channels and branches should be managed from Settings with `Restore` and
  `Delete` actions,
- delete is a separate irreversible operation and must not appear in the normal left
  drawer hover actions.

Do not use Git vocabulary for this feature. `Branch` in this context means a Ling channel
work lane, not repository state.

## External Pattern Benchmark

This is not a broad competitor survey. These patterns are enough to shape the channel
feature without copying another product's surface.

| Source | Useful pattern | Ling Stack adoption | Avoid |
| --- | --- | --- | --- |
| Slack canvases | A channel/DM can pin a living document with checklists, files, links, and task context. | Add a channel Brief/Canvas that captures goal, decisions, links, files, and acceptance criteria. | Do not make the canvas a generic rich document editor in the MVP. |
| Microsoft Teams Channel Agent | A channel can have a dedicated domain expert over channel context, with security and privacy boundaries. | Make the default AI teammate explicit and bound by channel context permissions. | Do not let an agent answer from private files, links, or attachments without explicit inclusion. |
| Teams tabs | A channel can expose specialized tabs instead of treating everything as messages. | Keep Activity, Tasks, Files, Brief, and Runtime as channel sub-surfaces. | Do not bury task state inside chat bubbles. |
| ChatGPT Projects | A project groups chats, files, instructions, and project-scoped memory. | Treat the channel Brief, messages, files, links, and tasks as scoped context. | Do not let channel memory bleed into unrelated channels or workspaces. |
| GitHub Copilot coding agent | Work is assigned, planned, executed, and returned for human review as a PR/task outcome. | Add assignment, handoff, review gates, and human final authority. | Do not let an AI teammate self-approve its own work or mark high-risk work done. |
| Role-based studios | Domains such as film, content, and product work use specialists like director, cinematographer, editor, PM, researcher, and reviewer. | Treat teammate roles as configurable domain roles instead of hard-coded coding roles. | Do not require a code/project vocabulary for every channel. |

Product decision:

```text
Channel = work scene + coordinator + role teammates + execution proposals
not
Channel = endless AI chat or coding-only task board
```

The channel should borrow the visible collaboration affordances from team chat products,
but the durable unit of work remains a Ling task/run with approvals and artifacts.

The accepted Web channel surface is a strict daylight workspace. Even if the broader app
theme is dark, the channel shell keeps white structural surfaces, black primary actions,
gray borders, and a single in-channel details panel so it matches the approved HTML
direction.

## First Screen

When a workspace has at least one channel, `/` should open into the selected channel.

The default selected channel should be:

1. the last locally selected channel, if it still exists,
2. otherwise the first active channel,
3. otherwise the first channel,
4. otherwise a compact empty state that creates the default channel.

The first viewport should show:

- channel name,
- bound path,
- daemon readiness,
- default provider readiness,
- default AI teammate,
- active runtime locks if any,
- the centered discussion feed,
- plain user and AI teammate messages,
- execution proposals attached to their source discussion when present,
- the right details panel when the user has it open,
- discussion composer with attachment, link, and mention support.

The first viewport should not show raw task, run, approval, handoff, workflow, or
state-transition audit cards by default. Those records are available from activity tools,
saved views, search, attention queue, and drilldown.

## Information Architecture

### Channel Header

The header owns identity and operational readiness.

Required fields:

- channel name,
- channel status: `active`, `paused`, `archived`,
- bound path,
- default provider preset,
- default AI teammate,
- runtime policy summary,
- active lock count,
- pending approval count.

Primary controls:

- members button,
- notifications button,
- pin/focus button,
- more menu.

The header should avoid large decorative artwork. It is an operational surface.

### Channel Center and Details Panel

The channel center is always Chat. Chat is not a tab and should not disappear when the
user opens a secondary channel surface.

Secondary channel surfaces are:

```text
Progress
Files
Context
Settings
```

These surfaces open from the compact header `...` menu into an in-layout right details
panel. The panel compresses the chat while visible and lets the chat expand when hidden.
The selected details surface is preserved while the panel is hidden.

The channel workspace hides the global app inspector. The right panel is the single
details surface for the selected channel, but it should not open with stale task state.
Chat is the default surface. A channel task detail appears only after the user explicitly
opens a task from attention, progress, activity, a task creation result, or a run repair
path. Task detail and approval detail are drill-down pages, not root drawer pages. The
client must not auto-select `tasks[0]` merely because a channel has historical tasks.
Floating progress and attention indicators are also channel-scoped: they use the
selected channel's task/run/approval ownership and stay hidden when the channel has no
current work, so an empty channel does not imply active progress.

Future details surfaces can include:

- `Plan`,
- `Approvals`,
- `Automations`.

Do not add these until there is a real data source and user workflow for them.

### Activity Tab

Purpose:

- show what happened in the channel,
- make runs and approvals visible as channel events,
- provide enough context to continue work.

Activity item types:

| Type | Source | Behavior |
| --- | --- | --- |
| Channel created | channel record | System event near the beginning |
| Member/default teammate changed | channel update | Shows previous and next default when known |
| User discussion message | channel message | Keeps requirements and questions in context |
| AI teammate reply | channel message/run | Clarifies requirements, answers questions, drafts next steps |
| Task created | task record | Opens task detail |
| Task status changed | task state transition | Shows status movement |
| Run started | run record/event | Opens run detail |
| Run finished | run record/event | Shows final status and artifacts |
| Approval requested | approval record | Opens approval inbox focused on run |
| Artifact created | artifact record | Opens file/artifact |

MVP can synthesize activity from existing tasks, runs, approvals, and state transitions.
Later, a durable `channel_events` table can replace synthesis.

Discussion messages are different from synthetic activity. If channel chat is part of
the shipped slice, user messages and AI replies need a durable message model or a clear
local-only prototype boundary. Do not pretend synthetic task/run events are a complete
chat history.

### Tasks Tab

Purpose:

- make tasks the main work queue for the channel,
- support fast run/check/review actions,
- keep provider and approval blockers visible.

Recommended grouping:

```text
todo / running / review / done / blocked / failed / cancelled
```

MVP can remain a single list with filters if columns are too heavy.

Tasks are channel-scoped durable work items. A task belongs to exactly one channel through
`task.channelId`, and different channels should maintain independent task lists,
selection state, runs, approvals, and attention items. The selected task detail belongs in
the `Tasks` surface and opens only after explicit user action; it should not occupy the
default chat view because that makes discussion feel like a secondary surface.

Task cards show:

- title,
- prompt preview,
- status,
- assigned/default teammate,
- provider,
- current run,
- last updated time,
- error/repair hint,
- actions: Check run, Run, Open run, Review.

### Files Tab

Purpose:

- expose channel outputs without forcing the user through Run History.

MVP data sources:

- run `summaryPath`,
- run `eventLogPath`,
- run artifacts from `/runs/:runId/artifacts`,
- user-uploaded channel attachments,
- user-shared links and link previews,
- media job artifacts when a media job is linked to a task/channel in the future.

File row fields:

- title,
- type: summary, event log, diff, markdown, image, video, pdf, office, link, json, log,
- source run/task,
- uploader when user-provided,
- size when known,
- created time,
- actions: Open, Download, Open run.
- for links: Open, Copy link, Create task from link, Refresh preview.

Current limitation:

- artifacts are run-scoped, not channel-scoped. The Web UI must derive channel files from
  runs whose `channelId` matches the selected channel.
- uploaded attachments are channel-scoped inputs, not run artifacts, until a task/run
  explicitly references or consumes them.
- shared links are channel-scoped remote references, not local files, until a task/run
  explicitly fetches or extracts their content.

### Attachments

Channels should support sending files, including images and common office documents.

Supported attachment classes:

| Class | Examples | MVP behavior | AI use boundary |
| --- | --- | --- | --- |
| Image | png, jpg, webp, gif | Upload, thumbnail, open/download | Can be passed to vision-capable providers only when selected explicitly. |
| PDF | pdf | Upload, metadata, open/download | Text extraction is a separate parsing step before AI can reason over content. |
| Office document | docx, xlsx, pptx | Upload, metadata, open/download | Parse text/tables/slides with a controlled extractor before AI use. |
| Text-like | txt, md, csv, json, log | Upload, preview, open/download | Can be attached to task context after size/redaction checks. |
| Archive/binary | zip, unknown binaries | Store only if allowed | No AI ingestion in MVP; never execute. |

Attachment actions:

- attach to discussion message,
- attach to task draft,
- preview metadata,
- open/download,
- remove before send,
- create task from attachment,
- include selected attachments as task context.

Storage boundary:

- store uploaded files under a workspace-owned `.ling-stack/attachments` directory or
  equivalent daemon-managed attachment store,
- persist metadata separately from binary bytes,
- never trust browser-provided MIME type alone,
- impose file size and count limits,
- block executable formats by default,
- never execute Office macros or embedded scripts,
- redact or preview extracted text before passing it to an AI provider when possible.

AI ingestion boundary:

- Uploading a file does not automatically make the file part of model context.
- The user must explicitly include attachments in a task or ask an AI teammate to inspect
  them.
- Images require a provider with image input capability.
- PDF/Word/Excel/PowerPoint require extraction before model use.
- Extracted text should become an auditable attachment-derived artifact or context record
  so later runs can explain what the model saw.

### Links and Web Previews

Channels should support sharing URLs with safe previews.

MVP link behavior:

- paste URL into the composer,
- detect URL tokens in message/task text,
- show a pending preview card,
- fetch only basic metadata through the daemon,
- render title, host, description, favicon, and preview image when available,
- allow Open and Copy link actions,
- show the link in the activity stream and Files tab.

Preview metadata sources:

- Open Graph tags,
- Twitter card tags,
- HTML title and meta description fallback,
- favicon fallback,
- final canonical URL after redirects, if allowed.

Security and privacy boundary:

- Do not fetch previews directly from the browser if the daemon owns workspace audit and
  network policy.
- Do not fetch private network addresses, localhost, link-local addresses, or metadata
  services.
- Enforce redirect limits, timeout limits, byte limits, content-type checks, and maximum
  preview image size.
- Strip tracking query parameters only for display if the original URL is preserved.
- Do not send cookies, local auth headers, provider keys, or workspace secrets.
- Mark preview failures clearly without blocking message send.
- Cache preview metadata by URL hash to avoid repeated external requests.

AI ingestion boundary:

- A link preview is metadata only.
- Sharing a link does not give AI permission to crawl the page.
- If the user asks an AI teammate to inspect a link, the UI should create an explicit
  link-inspection task or discussion run with a recorded URL snapshot.
- Web page extraction should be opt-in, size-limited, redaction-aware, and auditable.
- Authenticated pages, forms, checkout flows, account changes, and mutating browser
  actions are out of scope for automatic preview.

Recommended link UX:

```text
paste https://example.com/article
-> composer detects URL
-> preview card loads title, host, description, image
-> user can remove preview while keeping text
-> send message or create task
```

If preview fails:

```text
show URL chip + host + failure reason
allow send anyway
```

### Discussion and Mentions

The channel should support talking with AI teammates, but the interaction must stay tied
to the work model.

The Chat composer is one input surface for discussion:

- `Send` stores a normal discussion message.

`Send` is for:

- refining requirements,
- asking implementation or product questions,
- asking an AI teammate to identify ambiguity,
- getting acceptance criteria,
- discussing a failed run,
- summarizing a thread,
- drafting a plan before work becomes an execution proposal or a task.

The composer should support inline `@` mentions for discussion routing. AI mentions route
the next AI reply. Task creation is no longer a direct composer action; it is handled by
the `Tasks` panel for manual creation or by a user-confirmed execution proposal card.
For proposal-driven execution, the proposed task assignee is the source of truth:
provider, tools, approval profile, and execution blockers follow that assignee.

The composer should also support attachment controls and automatic link detection from
the same input. Link previews help
the human inspect what was shared, but link content is not fetched for AI use unless the
user explicitly asks for inspection.

Mention targets:

| Mention | MVP behavior | Future behavior |
| --- | --- | --- |
| `@Engineer`, `@Designer`, built-in AI teammate | On `Send`, route the next AI reply to that teammate. | Use persisted teammate instances and per-teammate memory/tools. |
| `@Development Council`, custom AI council | Not in MVP. | Route through the channel's attached council policy; Ling Agent selects a member, visible multi-reply, or council-scoped workflow. |
| `@local-teammate` draft | UI-only mention until teammate persistence exists. | Persist mention target and route to teammate instance. |
| `@user` | Highlight and notification metadata only. | Notify real workspace members when team sync exists. |
| `@channel` / `@all` | Not in MVP. | Add only with notification controls and abuse limits. |
| `@task` / `@run` | Optional autocomplete from visible tasks/runs. | Link messages to task/run discussion threads. |

Rules:

- If an AI teammate is mentioned for a discussion reply, that teammate should answer.
- If no AI teammate is mentioned and the channel has a coordinator/default teammate, the
  coordinator should decide whether to answer, ask a clarifying question, consult
  specialists, create a collapsed collaboration record, or simply record the message.
- Ordinary notes, status updates, and messages that do not need AI input should not
  trigger an AI reply just because a coordinator exists.
- If no default coordinator exists, the UI should store the message without AI response
  and offer a setup route to add/select a coordinator.
- A mention never grants new tools or provider capabilities.
- A mentioned teammate can only use the channel's allowed tools and the selected
  provider's capabilities.
- Future council attachment is a daemon/core policy, not Web-only state. A channel may
  attach a whole council as a projected availability set while still preserving Ling Agent
  as the visible coordinator; see [AI Councils](ai-councils.md).
- Provider resolution for a discussion reply is deterministic: mentioned teammate
  provider, explicit run provider, channel default provider, workspace selected provider,
  then first preflight-ready chat provider.
- Provider resolution for execution is stricter: it follows the confirmed proposal/task
  assignee. If the assignee provider is missing, failed, or not tool-capable, the task/run
  is blocked and the user must fix configuration or edit the assignee. Do not silently
  fall back to another teammate or provider.
- An attachment never grants file read permission outside the uploaded file itself.
- A link never grants network browsing permission beyond preview metadata.
- Discussion is read-only by default. File edits, shell commands, external sends, and
  deploy actions require converting the discussion into a task/run.
- AI replies should stay readable by default. When discussion produces executable work,
  the preferred path is a user-confirmed execution proposal. Manual task creation remains
  available from the `Tasks` panel, while event details and context-summary actions remain
  explicit secondary paths rather than inline conversion buttons on every message.

Recommended mention UX:

```text
type @
-> popover shows AI teammates first, then users, then task/run references
-> selecting a target inserts a token
-> token is stored as structured mention metadata, not only plain text
```

The plain text prompt remains readable if metadata is lost.

### Requirement Discussion Flow

AI teammate chat is valuable only if it improves work quality before execution.

Supported discussion jobs:

- clarify a vague request,
- ask the user 1-3 blocking questions,
- propose a smaller implementation slice,
- identify risks and missing acceptance criteria,
- convert the final discussion into one or more tasks,
- explain a failed run and propose a repair task,
- summarize decisions for later documentation.

The output of a good discussion is one of:

- a refined task prompt,
- an acceptance checklist,
- a plan summary,
- an execution proposal with assignee and acceptance criteria,
- a collapsed collaboration record showing which specialists contributed,
- a linked follow-up task,
- a decision note in the channel activity.

Do not make AI discussion a side channel that disappears from the channel record.

### General Studio Examples

The protocol is domain-neutral. Code and film channels share the same objects because
both need a scene, role teammates, a coordinator, an execution proposal, an assignee, and
auditable execution state.

Code channel:

```text
coordinator: Product / Architect
specialists: Frontend Engineer, Backend Engineer, Reviewer, QA, Security, Docs
proposal: simplify channel composer
assignee: Frontend Engineer
output: implementation, tests, review evidence, docs update
```

Film channel:

```text
coordinator: Director / Producer
specialists: Cinematographer, Scene Designer, Editor, Script Consultant
proposal: create rainy alley sci-fi scene plan
assignee: Director
output: logline, shot list, visual references, scene design notes
```

Adding a new teammate should not require changing the channel protocol. The new teammate
needs role metadata, prompt, provider, tools, approval profile, and optional channel
membership/default settings.

## Multi-Agent Collaboration Protocol

Multi-agent collaboration needs a protocol, not just multiple AI names in the sidebar.

The channel should answer these questions at all times:

- Who is the coordinator for this channel?
- Who owns the current objective?
- Which AI teammates are active, idle, blocked, or waiting for approval?
- What is the current stage of work?
- What context is each teammate allowed to use?
- What decision has already been made?
- Which specialists were consulted, and what did they contribute?
- What handoff is next?
- Who can approve completion?

Coordinator rules:

- The coordinator is the default AI participant for unmentioned messages that need AI
  input.
- The coordinator may consult specialists and summarize their input, but the default
  channel view should show one integrated reply rather than one visible message per
  consulted agent.
- Specialist messages become visible by default only when explicitly mentioned, when
  they disagree, when they identify a blocker/risk, or when user choice is required.
- The collaboration process should be available as a collapsed record for traceability.

### Channel Roster

The channel roster shows every available participant and their work role.

Roster fields:

- participant id,
- display name,
- kind: user, built-in teammate, local teammate draft, system,
- role: coordinator, product, architect, designer, engineer, reviewer, QA, security,
  docs, release, director, cinematographer, scene designer, editor, producer, script
  consultant, researcher, custom,
- default provider preset,
- allowed tools,
- default skills,
- approval profile,
- status: idle, thinking, running, waiting, blocked, done,
- current task/run when active,
- last activity.

MVP roster:

- local user,
- default AI teammate,
- built-in teammate templates,
- local teammate drafts as UI-only rows.

### Channel Collaboration Protocol

Each channel should have a thin collaboration protocol. It is similar in spirit to a
project instruction file, but scoped to one channel and generated from structured channel
settings plus optional user-edited rules.

The protocol may include:

- channel purpose and stable collaboration preferences;
- default teammate and `autoReplyMode`;
- response-language preference;
- visible multi-reply cap and participation rules;
- workflow preference, such as `Architect -> Engineer -> QA`;
- privacy rules, such as not sharing private teammate chat unless the user promotes it;
- review expectations that are stable for this channel.

The protocol must stay thin:

- ordinary chat does not append to it;
- workflow execution does not append logs or step summaries to it;
- AI-discovered rules can become candidates, but cannot silently rewrite it;
- user edits or explicit confirmation are required before durable protocol changes;
- current tasks, decisions, handoffs, summaries, and memory candidates live in their own
  records.

This keeps the protocol from becoming an unbounded shared memory file. Long discussion
history is compressed through `ChannelContextSummary`, `ChannelDecision`, `ChannelHandoff`,
workflow packets, source refs, and review-gated memory candidates instead.

### Context Pack and Budget

Each teammate reply or workflow step should receive a bounded Context Pack, not the whole
channel transcript and not only the latest message. Ordinary replies should feel
continuous because Ling Agent sees a layered channel context pack.

Context Pack levels:

| Level | Used by | Notes |
| --- | --- | --- |
| `channel_reply_context` | ordinary single teammate replies | current turn envelope, channel state, effective protocol, bounded recent visible conversation, compacted channel summaries/source refs, active work state when relevant, materialized inputs, scoped memory recall |
| `roster_compact` | visible multi-reply and roster questions | compact channel roster, selected visible participants, no online/presence claim |
| `capability_routing` | selector/proposal routing | eligible teammates, roles, runnable provider state, skill summaries |
| `workflow_packet` | workflow step execution | objective, step metadata, decisions, handoffs, summaries, source refs |

The [Channel Context Processing Layer](channel-context-processing-layer.md) owns context
source collection, filtering, per-agent views, evidence/log noise control, and memory-use
isolation. The [Channel Context Budget Manager](channel-context-budget-manager.md) owns
provider-aware budgeting and compaction inside that layer. It may automatically compact
runtime context, but it must not silently edit channel protocol or activate shared memory.

### Collaboration Stages

Every channel task or discussion thread should be able to move through a small set of
stages:

```text
discuss
clarify
plan
design
implement
review
qa
docs
done
blocked
cancelled
```

Stages are not a replacement for task/run status. They describe collaboration intent.

Mapping examples:

| Stage | Primary teammate | Output |
| --- | --- | --- |
| discuss | Product or default teammate | Problem framing and missing context |
| clarify | Product / Architect | Blocking questions and acceptance criteria |
| plan | Architect | Implementation plan and risk list |
| design | Designer | UI/UX constraints and interaction decisions |
| implement | Engineer | Code/docs changes and run artifacts |
| review | Reviewer / Architect | Findings, required changes, approval |
| qa | QA | Repro steps, test evidence, regressions |
| docs | Docs | Documentation updates and release notes |
| done | Human owner or reviewer | Final acceptance |

### Handoff Rules

Agents should hand off work explicitly.

Handoff record:

- from participant,
- to participant,
- reason,
- source message/thread/task/run,
- required input,
- expected output,
- due condition,
- created time,
- accepted/declined state.

Examples:

```text
Product -> Architect: requirements are stable; produce implementation plan.
Architect -> Engineer: plan approved; implement Phase 1 only.
Engineer -> Reviewer: code changed; review diff and missing tests.
Reviewer -> QA: review passed; verify user-visible workflow.
QA -> Docs: behavior verified; update docs.
Docs -> Human: docs synced; ready for final acceptance.
```

Handoff should appear in Activity and in the right Runtime/Protocol inspector.

### Decision Log

The channel needs a lightweight decision log so agents do not re-open settled questions.

Decision fields:

- title,
- decision,
- rationale,
- alternatives considered,
- owner,
- source message/thread,
- affected tasks/runs/files/links,
- created time,
- superseded by, when relevant.

Actions:

- create decision from message/thread,
- link decision to task,
- mark decision superseded,
- copy decision into docs.

### Channel Brief

The channel Brief is Ling Stack's version of a project canvas.

It should contain:

- channel objective,
- current scope,
- out-of-scope items,
- default AI teammate and active roster,
- acceptance criteria,
- key links,
- key attachments,
- current plan,
- open questions,
- decisions,
- active risks.

MVP can implement the Brief as a structured panel. It does not need rich text editing.

### Threads

Threads prevent the main channel from becoming unusable.

Thread types:

- requirement discussion,
- design review,
- failed run repair,
- task review,
- attachment/link discussion,
- decision discussion.

Thread actions:

- create task from thread,
- summarize thread,
- create decision from thread,
- link thread to task/run,
- close thread as resolved.

### Review Gates

Multi-agent work is incomplete until the required gates pass.

Default gates:

```text
plan review
implementation review
qa verification
docs sync
human acceptance
```

Optional gates:

```text
design review
security review
release approval
cost approval
external-send approval
```

Rules:

- The agent that produced work should not be the only approver of that work.
- Risky side effects still route through approval policy.
- Human acceptance remains the final authority for high-risk or release-like work.

### Conflict and Arbitration

If agents disagree, the channel should surface the conflict instead of blending answers.

Conflict record:

- participants,
- conflicting claims,
- evidence cited,
- affected decision/task,
- recommended arbitrator,
- resolution.

Default arbitrator:

- Architect for technical conflicts,
- Designer for interaction conflicts,
- Security for trust boundary conflicts,
- Human owner for product, scope, cost, and release conflicts.

### Context Permissions

Each teammate should receive only the context required for its stage.

Context classes:

- channel Brief,
- channel messages,
- selected thread,
- selected task,
- linked runs,
- uploaded attachments,
- shared links,
- extracted link/page content,
- run artifacts,
- project files,
- private notes.

Default:

- channel Brief and selected thread are visible to active AI teammates,
- attachments and links are visible as metadata,
- file contents, webpage bodies, and project files require explicit inclusion,
- private notes are never included unless a future permission model exists.

### Agent Status

The UI should expose why each agent is not moving.

Statuses:

```text
idle
thinking
asking_user
waiting_for_provider
waiting_for_approval
waiting_for_lock
running_task
reviewing
blocked
done
```

Blocked status must include a reason and one next action.

### Right Inspector

The right inspector replaces broad forms as the default way to inspect and edit channel
context.

Inspector modes:

```text
Members
Notifications
Settings
Runtime
```

#### Members

Shows:

- local user,
- default AI teammate,
- built-in teammate templates,
- local teammate drafts.

Actions:

- set default AI teammate,
- open AI teammate management,
- add local teammate draft,
- remove default teammate.

MVP boundary:

- built-in templates can be selected as `defaultTeammateId`,
- local teammate drafts remain UI-only until teammate persistence exists,
- channel membership beyond default teammate is UI-only unless persisted later.

#### Notifications

Notifications are local UI preferences in MVP.

Options:

```text
All activity
Mentions and approvals
Muted
```

Rules:

- `All activity`: badges for task, run, approval, and artifact updates.
- `Mentions and approvals`: badges only for approval-required items and explicit user-facing blockers.
- `Muted`: no sidebar badge except critical approval blockers.

Persistence:

- MVP can use local storage.
- Later, workspace settings can persist notification preferences by channel.

#### Settings

Settings edits the persisted channel record.

Fields:

- name,
- status,
- bound path,
- default provider preset,
- default AI teammate,
- allowed tools,
- runtime policy.

Danger actions:

- archive channel,
- delete channel.

Delete remains blocked when the daemon reports `channel_has_tasks`.

#### Runtime

Shows:

- active resource leases for the channel, bound path, or workspace,
- current active run,
- pending approvals,
- recent state transitions.

This inspector should reuse the existing runtime state data rather than introducing a
new daemon endpoint.

## Data Contract

### Existing Channel Shape

The channel model already includes:

```ts
interface Channel {
  id: string;
  workspaceId: string;
  name: string;
  status: "active" | "paused" | "archived";
  boundPath?: string;
  defaultProviderPresetId?: string;
  defaultTeammateId?: string;
  allowedTools: RunTool[];
  runtimePolicy: ChannelRuntimePolicy;
  createdAt: string;
  updatedAt: string;
}
```

The daemon parser and core store already accept `defaultTeammateId`. The Web form and
payload conversion must expose it.

Required Web form extension:

```ts
interface ChannelFormState {
  name: string;
  status: ChannelStatus;
  boundPath: string;
  defaultProviderPresetId: string;
  defaultTeammateId: string;
  allowedTools: ToolName[];
  runtimePolicy: ChannelRuntimePolicy;
}
```

Required API payload behavior:

- create: send `defaultTeammateId` only when non-empty,
- update: send `defaultTeammateId` or `null` to clear,
- `channelToForm`: map missing `defaultTeammateId` to `""`.

### Activity Model

MVP should not add a new table.

Use a derived activity builder in Web:

```text
channels + tasks + runs + approvals + stateTransitions + artifacts
-> ChannelActivityItem[]
```

Future durable model:

```ts
interface ChannelEvent {
  id: string;
  workspaceId: string;
  channelId: string;
  type: ChannelEventType;
  sourceType: "channel" | "task" | "run" | "approval" | "artifact" | "system";
  sourceId?: string;
  actorType: "user" | "teammate" | "runner" | "system";
  actorId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
```

Do not introduce this table until derived activity cannot satisfy the UI.

### Channel Message Model

Durable AI teammate chat needs a message model. Derived activity is enough for task/run
events, but it is not enough for user-authored discussion.

Recommended future model:

```ts
type ChannelMessageKind =
  | "user_message"
  | "ai_reply"
  | "system_note"
  | "decision_note";

type ChannelMessageIntent =
  | "discuss"
  | "task_draft"
  | "run_repair"
  | "decision";

interface ChannelMention {
  targetType: "user" | "teammate" | "task" | "run" | "channel";
  targetId: string;
  label: string;
  start: number;
  end: number;
}

interface ChannelMessage {
  id: string;
  workspaceId: string;
  channelId: string;
  threadId?: string;
  kind: ChannelMessageKind;
  intent: ChannelMessageIntent;
  authorType: "user" | "teammate" | "system";
  authorId?: string;
  body: string;
  mentions: ChannelMention[];
  attachmentIds: string[];
  linkPreviewIds: string[];
  linkedTaskId?: string;
  linkedRunId?: string;
  createdAt: string;
  updatedAt: string;
}
```

MVP options:

1. Local-only prototype: keep messages in browser state while proving the UI.
2. Durable slice: add `/channels/:id/messages` and persist messages in SQLite.
3. Task-first fallback: convert every discussion prompt into a draft task immediately.

Preferred path: durable slice for messages before claiming that channel chat is shipped.

### Channel Attachment Model

Attachments need their own metadata even if message storage is local-only at first.

Recommended future model:

```ts
type ChannelAttachmentKind =
  | "image"
  | "pdf"
  | "office"
  | "text"
  | "archive"
  | "binary";

interface ChannelAttachment {
  id: string;
  workspaceId: string;
  channelId: string;
  uploaderType: "user" | "teammate" | "system";
  uploaderId?: string;
  filename: string;
  contentType: string;
  detectedContentType?: string;
  kind: ChannelAttachmentKind;
  sizeBytes: number;
  storagePath: string;
  sha256: string;
  previewText?: string;
  extractionStatus?: "not_started" | "unsupported" | "pending" | "succeeded" | "failed";
  extractedArtifactId?: string;
  createdAt: string;
}
```

Attachment APIs can be added later:

```text
POST /channels/:id/attachments
GET /channels/:id/attachments
GET /attachments/:id/content
DELETE /attachments/:id
```

Do not reuse run artifact APIs directly for user uploads. Artifacts are outputs of work;
attachments are user-provided inputs or discussion context.

### Channel Link Preview Model

Links need durable metadata because preview fetching is an external network action.

Recommended future model:

```ts
type ChannelLinkPreviewStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "blocked";

interface ChannelLinkPreview {
  id: string;
  workspaceId: string;
  channelId: string;
  originalUrl: string;
  normalizedUrl: string;
  finalUrl?: string;
  urlHash: string;
  host: string;
  title?: string;
  description?: string;
  siteName?: string;
  faviconUrl?: string;
  imageUrl?: string;
  status: ChannelLinkPreviewStatus;
  failureReason?: string;
  fetchedAt?: string;
  createdAt: string;
}
```

Link preview APIs can be added later:

```text
POST /channels/:id/link-previews
GET /channels/:id/link-previews
POST /link-previews/:id/refresh
```

Do not store fetched page bodies in the preview record. If a page is explicitly inspected
for AI use, store the extracted content as a separate auditable context/artifact record.

### Collaboration Protocol Models

These models can be introduced after the first channel UI proves the need. Until then,
the Web UI can derive simplified protocol state from tasks, messages, runs, approvals,
and local UI state.

```ts
type ChannelCollaborationStage =
  | "discuss"
  | "clarify"
  | "plan"
  | "design"
  | "implement"
  | "review"
  | "qa"
  | "docs"
  | "done"
  | "blocked"
  | "cancelled";

type ChannelParticipantStatus =
  | "idle"
  | "thinking"
  | "asking_user"
  | "waiting_for_provider"
  | "waiting_for_approval"
  | "waiting_for_lock"
  | "running_task"
  | "reviewing"
  | "blocked"
  | "done";

interface ChannelParticipantState {
  id: string;
  workspaceId: string;
  channelId: string;
  participantType: "user" | "teammate" | "system";
  participantId: string;
  role: string;
  status: ChannelParticipantStatus;
  currentTaskId?: string;
  currentRunId?: string;
  blockedReason?: string;
  updatedAt: string;
}

interface ChannelHandoff {
  id: string;
  workspaceId: string;
  channelId: string;
  fromParticipantId: string;
  toParticipantId: string;
  stage: ChannelCollaborationStage;
  reason: string;
  sourceMessageId?: string;
  sourceTaskId?: string;
  sourceRunId?: string;
  expectedOutput: string;
  status: "pending" | "accepted" | "declined" | "completed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

interface ChannelDecision {
  id: string;
  workspaceId: string;
  channelId: string;
  title: string;
  decision: string;
  rationale: string;
  alternatives: readonly string[];
  ownerParticipantId?: string;
  sourceMessageId?: string;
  sourceThreadId?: string;
  linkedTaskIds: readonly string[];
  linkedRunIds: readonly string[];
  supersededByDecisionId?: string;
  createdAt: string;
  updatedAt: string;
}

interface ChannelBrief {
  id: string;
  workspaceId: string;
  channelId: string;
  objective: string;
  scope: string;
  outOfScope: string;
  acceptanceCriteria: readonly string[];
  keyLinkPreviewIds: readonly string[];
  keyAttachmentIds: readonly string[];
  openQuestions: readonly string[];
  riskNotes: readonly string[];
  updatedAt: string;
}
```

Do not add all of these tables at once. The recommended order is:

1. local roster and status derived from existing state,
2. channel Brief as a persisted structured object,
3. decision log,
4. handoff records,
5. participant state if derived state is insufficient.

### File Derivation

MVP file list:

```text
selected channel
-> runs where run.channelId === selectedChannel.id
-> for each run, list artifacts and known summary/event log paths
```

This can be implemented entirely in Web with existing run/artifact APIs.

## Component Plan

Current file:

```text
apps/web/src/features/workspace/WorkspaceClientView.tsx
```

Recommended split:

```text
apps/web/src/features/channels/
  ChannelWorkspace.tsx
  ChannelHeader.tsx
  ChannelTabs.tsx
  ChannelActivity.tsx
  ChannelTaskList.tsx
  ChannelFiles.tsx
  ChannelComposer.tsx
  ChannelMentionPicker.tsx
  ChannelAttachmentPicker.tsx
  ChannelLinkPreviewCard.tsx
  ChannelInspector.tsx
  ChannelRoster.tsx
  ChannelBriefPanel.tsx
  ChannelDecisionLog.tsx
  ChannelHandoffPanel.tsx
  channel-activity.ts
  channel-attachments.ts
  channel-collaboration.ts
  channel-files.ts
  channel-links.ts
  channel-mentions.ts
```

Migration can be incremental. Do not block MVP on moving every component.

### WorkspaceClientView Refactor Sequence

`WorkspaceClientView.tsx` is the channel workspace assembly point. It should stay as the
container that binds AppShell data/actions to channel UI surfaces, but it should stop
owning every leaf component and every domain-specific helper.

Refactor in staged slices:

1. Extract low-risk leaf surfaces first: environment page/dialogs, rename dialog,
   governance popovers, runtime diagnostics, task detail panels, thread replies, and
   activity filters. These components are mostly props-driven and do not own feed
   scroll state.
2. Extract medium-risk read/display surfaces before the chat core: workflow/proposal
   cards, protocol editor, inspector, routing evidence, and route-intent inspect. These
   surfaces can own local edit/loading state, but they must not change channel feed
   assembly, pending send, scroll anchoring, or composer snapshots.
3. Extract `ChannelComposer` after these surrounding surfaces. Keep draft snapshots, attachments,
   file refs, mentions, slash commands, and active-run guidance behind a narrow
   composer contract.
4. Extract `ChannelMessageFeed` and a `useChannelMessageFeed` hook last. This slice owns
   pending-send visibility, `Thinking...` continuity, virtualizer sizing, older-message
   loading, anchor retention, and jump-to-latest behavior; it needs focused e2e coverage.
5. Move pure projection helpers into `channel-*` modules only when their inputs/outputs
   are stable enough to test without rendering the whole workspace.

Current extraction state:

- Extracted leaf modules: `ChannelEnvironmentPage.tsx`, `ChannelRenameDialog.tsx`,
  `ChannelGovernanceNotificationsPopover.tsx`, `RuntimeDiagnosticsPanel.tsx`,
  `ThreadReplyPanel.tsx`, `ChannelActivityPanels.tsx`, `ChannelActivityToolsPanel.tsx`,
  `ChannelWorkThreadTree.tsx`, and `ChannelTaskPanels.tsx`.
- Extracted workflow/proposal module: `ChannelWorkflowProposalCards.tsx`, covering
  `WorkflowQueueCard`, `WorkflowStepCard`, `WorkflowStepContextEvidencePanel`,
  `WorkflowFinalSummary`, `ChannelExecutionProposalCard`, and
  `RequirementShapingSummary`.
- Extracted inspector/protocol module: `ChannelInspectorPanels.tsx`, covering
  `ChannelInspector`, `ChannelProtocolEditor`, routing evidence, and route-intent
  inspect details.
- Extracted detail/progress modules: `ChannelDetailOverlays.tsx`, covering
  `ConversationDetailOverlay`, `ChannelSourceDetailPanel`, and
  `ChannelApprovalDetailPanel`; and `ChannelProgressPanels.tsx`, covering
  `ProgressPopover`, `ChannelEnvironmentPopoverSection`, and context source group icons.
- Extracted settings/management module: `ChannelSettingsPanels.tsx`, covering
  channel notifications, AI council attachment/preference controls, channel teammate
  management, current channel/provider/runtime/workspace settings, and the shared channel
  workspace display helpers.
- Extracted composer module: `ChannelComposer.tsx`, covering the controlled composer
  shell, pending attachment preview strip, mention/slash pickers, active-run guidance,
  inline approvals, permission menu, and send/error controls. `WorkspaceClientView.tsx`
  still owns draft snapshots, file refs, upload/send actions, and active run state.
- Extracted composer draft controller hook: `useChannelComposerDraftController.ts`,
  covering draft/assets/mention/slash picker state, composer busy/send state, pending
  send preview state, composer refs, attachment preview URL cleanup, and composer feedback
  timeout lifecycle. `WorkspaceClientView.tsx` still owns `sendMessage`, run guidance
  actions, pending-send resolution, and channel-switch snapshot orchestration.
- Extracted message feed module: `ChannelMessageFeed.tsx`, covering feed item types,
  retain/signature helpers, the `useChannelMessageFeed` virtualizer/scroll hook,
  pending-send / `Thinking...` continuity, older-message loading, anchor retention, and
  jump-to-latest controls. Feed resets are scoped to channel changes and selected-channel
  notification state, not parent workspace-settings object identity, so refreshes do not
  clear older-message position, background attention toast, or jump-to-latest visibility.
  `WorkspaceClientView.tsx` still owns channel item assembly and activity/workflow/task
  render actions.
- Extracted right dock controller hook: `useChannelRightDockController.ts`, covering
  open/close mount timing, layout animation variables, width clamping, resize pointer
  handlers, main-width observation, and right-dock page requests.
- Extracted right dock content hook: `ChannelRightDockContent.tsx`, covering
  right-dock message/file/evidence/review projections, channel-scoped approval filtering,
  and the dock Activity tab composition. `WorkspaceClientView.tsx` still owns
  `WorkspaceRightDock` rendering and side-panel view state.
- Extracted activity controller hook: `useChannelActivityController.ts`, covering
  channel activity item projection, audit filter/search state, saved-view persistence and
  migration, filter counts, custom saved-view actions, and activity drilldown selection.
  `ChannelActivityWorkspace.tsx` now owns the Activity tab shell composition for activity
  tools, branch tree, message feed, thread replies, and the drilldown drawer.
  `WorkspaceClientView.tsx` still owns feed visibility rules, activity row rendering,
  target-opening side effects, and the concrete prop wiring for child surfaces. Saved-view
  initialization is scoped to selected-channel settings so parent error rerenders do not
  reset the drilldown drawer; the selected drilldown is also retained across transient
  activity refreshes so triage failure/retry state stays local to the drawer.
- Extracted work-thread controller hook: `useChannelWorkThreadsController.ts`, covering
  channel branch loading, fallback branch derivation from runs, branch search/tree
  projection, active branch reset, and fork/archive/pin mutations. `WorkspaceClientView.tsx`
  still consumes the active work-thread id for activity/feed filtering and still owns
  thread reply draft/send state.
- Extracted environment summary hook: `ChannelEnvironmentSummary.tsx`, covering
  local workspace/git/review/source/output summary assembly and progress popover row
  generation. `WorkspaceClientView.tsx` still owns environment page visibility and
  commit/review open handlers.
- Extracted progress summary hook: `ChannelProgressSummary.tsx`, covering workflow/task/run
  attention rows, pending approval row generation, and active progress source summary
  selection. `WorkspaceClientView.tsx` still owns progress popover open/render animation
  state.

Do not run a single broad "clean up the file" rewrite. Each slice must preserve existing
ARIA labels, test selectors, pending-state behavior, and channel routing semantics.

Minimum first slice:

- keep `WorkspaceClientView` as the container,
- extract `ChannelInspector`,
- add local tab state,
- add `defaultTeammateId` form support,
- add a files tab with derived rows.

The first chat-capable slice extracts `ChannelComposer` so Discuss and Task modes do not
get tangled with task creation logic.

The first attachment-capable slice should keep attachment upload isolated behind
`channel-attachments.ts` so binary handling, previews, and future extraction do not leak
into message or task rendering components.

The first link-capable slice should keep URL detection and preview fetching isolated
behind `channel-links.ts` so network policy and SSRF protections stay testable.

The first multi-agent slice should keep protocol derivation in `channel-collaboration.ts`.
Do not spread handoff, roster, and review-gate logic across visual components.

## Interaction Flows

### Create Channel

```text
no channel or existing selected channel
-> user clicks + beside Channels in the left sidebar
-> UI opens the New channel panel
-> user confirms Create channel
-> Web uses the selected channel as a template for path, provider, tools, and runtime policy when available
-> daemon creates channel
-> UI selects the new channel
```

If no provider is ready, channel creation is still allowed, but task run actions remain
blocked by provider readiness.

### Set Default AI Teammate

```text
open channel
-> open Members inspector
-> choose teammate template
-> PATCH /channels/:id defaultTeammateId
-> channel header and task composer update
```

If the selected teammate requires tools not allowed by the channel, show a warning but do
not silently widen tool permissions.

### Create Task From Composer

```text
type task prompt in the channel composer
-> optionally select @AI teammate from the mention popover
-> click Task
-> task is created in selected channel
-> activity item appears
-> task card appears
```

Future option:

```text
Create and run
```

This should stay disabled until provider preflight and channel status allow it.

### Discuss With AI Teammate

```text
open channel
-> user types @Engineer help refine this requirement
-> mention picker inserts structured teammate mention
-> user clicks Send
-> channel stores the user message
-> selected/default AI teammate replies with clarification, risks, and next steps
-> AI teammate may return an execution proposal when work is ready
-> user confirms the proposal or creates a manual task from the Tasks panel
```

Execution boundary:

- AI discussion can read the layered channel context pack and prior visible messages
  selected for that turn.
- AI discussion should not perform side effects.
- If the user asks the AI teammate to inspect files, run commands, edit files, or create
  artifacts, the UI should convert that request into a task/run flow.

### Promote Discussion to Task

```text
AI teammate proposes executable work from the discussion
-> proposal card shows assignee, acceptance criteria, tools, and risks
-> user confirms, edits later, or cancels
-> confirmation creates the task and starts the assignee PI run
```

Plain discussion messages should not show inline conversion buttons by default. If a
manual selected-message task flow returns, it should be behind selection or details UI
or the Tasks panel, and should preserve a link back to the source message/thread.

### Send Attachment

```text
open channel
-> click attachment button in composer
-> choose image, PDF, or Office file
-> daemon validates size, MIME, extension, and storage path
-> attachment appears at the top of the composer as a thumbnail or compact file card
-> user sends discussion message or creates task with attachment
-> attachment appears in Files tab and activity stream
```

If the user asks an AI teammate to inspect the attachment:

```text
@Engineer please review this PDF
-> UI checks whether the attachment can be parsed or sent to the selected provider
-> if unsupported, show the blocker
-> if supported, create a discussion/run context with explicit attachment references
```

For MVP, PDF and Office files can be upload/open/download only. AI-readable extraction
should be a separate implementation step unless a safe parser is already in place.

### Share Link

```text
open channel
-> paste URL into the Chat composer
-> composer detects the URL
-> daemon creates or reuses a link preview record
-> preview card shows host, title, description, and image when available
-> user sends the message
-> link appears in Activity and Files
```

If the user asks an AI teammate to inspect the link:

```text
@Research please inspect this article
-> UI shows that web content inspection is a separate action
-> user confirms Create link-inspection task or Include link in task context
-> daemon fetches/extracts page content under network policy
-> extracted content is stored as an auditable context/artifact record
```

MVP can ship with preview-only links. Full webpage extraction should be a separate slice.

### Run Multi-Agent Work

```text
open channel
-> user discusses unclear work with @Product or default teammate
-> AI asks blocking questions and drafts acceptance criteria
-> user creates task from discussion
-> Architect reviews plan
-> Engineer implements
-> Reviewer checks diff/behavior
-> QA verifies user-visible flow
-> Docs updates design/release docs
-> human owner accepts or reopens
```

The UI should show the current stage, active participant, next gate, and blockers. The
main thread should stay readable; stage changes, decisions, and handoffs appear as
structured activity items.

### Record Decision

```text
select message/thread
-> click Record decision
-> fill decision, rationale, alternatives
-> link affected tasks/runs/files/links
-> decision appears in Brief and Activity
```

Decisions should be easy to supersede. Do not mutate old decision text silently.

### Run Task

Preflight:

1. selected channel exists,
2. channel status is `active`,
3. provider is runnable and preflight-ready,
4. allowed tools are non-empty,
5. approval policy can handle risky tools,
6. resource lease policy allows the run or queues it.

If blocked, the UI should give one direct next action:

- open Model Workbench,
- open Approvals,
- unpause channel,
- wait for active lock,
- edit channel tools.

### Open Files

```text
open Files tab
-> Web derives channel runs
-> fetch or reuse run artifacts
-> show summary/log/artifact rows
-> Open run remains available for context
```

## Visual Direction

Keep the existing macOS-like client direction:

- quiet dark/light compatible surfaces,
- dense but readable task and run information,
- icons for header actions,
- tabs for channel subviews,
- segmented/radio controls for notification preferences,
- compact inspector rows instead of full-page forms,
- cards only for repeated objects such as tasks and files.

Web notes:

- channel Files tab sections, file/link cards, run artifact groups, and empty states must use strict console light/dark tokens; dark mode must not fall back to legacy translucent gray or glass panels.
- channel Files tab content should fill the available tab body instead of using a capped
  half-screen scroll region that leaves unused space below the working files.
- channel headers should not repeat obvious selected-channel state such as `active channel`;
  reserve header subtext for real warnings, blockers, or scoped context.
- channel creation belongs to the left sidebar `Channels` section through a `+` action.
  Selected-channel Settings only edits the current channel and must not show `Create
  channel` or `Create default` actions.
- channel Chat composer should stay visually quiet: no visible `Discuss` heading and no
  static helper sentence below the input. Placeholder text, icon buttons, drag overlay,
  and mention suggestions carry those affordances.
- channel Chat composer should render as one rounded input shell: the textarea owns the
  upper area, tool icons live inside the lower-left edge, and the send icon button lives
  inside the lower-right edge. Do not split the composer into a form-like textarea plus
  external action row.
- pending attachments and link previews should live at the top of that rounded composer
  shell, above the textarea. Image attachments render local thumbnails where possible;
  PDFs, Office/text files, and links render compact preview cards. The lower toolbar
  stays reserved for `+`, `@`, and send actions.
- refined composer direction: text-like structured references should move into the
  editable input flow as inline tokens. This includes slash commands, `@agent`
  mentions, workspace file refs, web URLs, and GitHub repository links. Repository URLs
  should render as compact provider tokens such as `openai/openai-agents-python`, with a
  GitHub icon and blue link color, instead of appearing as a detached card above the
  input. Keep the top-of-shell preview region only for binary attachments and rich
  thumbnail uploads that cannot fit naturally in the text baseline.
- pending mention chips must mirror the textarea content. If the corresponding `@label`
  or `@id` token is removed from the input, remove the chip immediately.
- ordinary chat message bodies should use the same strong text color as the author name
  with medium weight, while inline `@mentions` keep the blue information emphasis.
- ordinary chat messages should separate authors spatially without showing a default
  bubble background: local-user discussion messages align to the right, while AI
  teammate and system discussion replies align to the left. The lightweight neutral
  bubble boundary appears only on hover or keyboard focus. Work/protocol/run event cards
  do not use this split-chat layout.
- Activity filter panel chips, including attention chips, must also use strict console light/dark tokens; dark mode must not fall back to legacy pale chip fills.

Avoid:

- marketing hero layout,
- decorative-only orbital graphics,
- oversized empty cards,
- hidden setup forms that make the first workflow unclear,
- chat UI that hides task/run state.

## Empty and Error States

| State | UI |
| --- | --- |
| No daemon | Show reconnect action and keep cached/local UI inert |
| No provider | Channel visible, run actions route to Model Workbench |
| No channel | Show default channel create action |
| Paused channel | Composer visible, run buttons disabled |
| Archived channel | Read-only activity/tasks/files |
| Provider failed check | Show provider blocker and repair route |
| Pending approval | Show approval badge and focused action |
| Active lock | Show lock badge and affected resource |
| No files | Explain that files appear after runs create summaries or artifacts |
| Unsupported attachment | Store/open/download only, do not offer AI inspect |
| Oversized attachment | Reject with size limit and keep composer state intact |
| Link preview blocked | Show URL chip and blocker reason; allow sending text |
| Link preview failed | Show URL chip and retry action |
| Link inspection unsupported | Offer task creation only when extraction path exists |

## Implementation Tracker

Current MVP implementation status:

- durable channel messages are implemented with `/channels/:id/messages`,
- `@` mentions preserve structured AI teammate metadata,
- `Send` can request a no-tools, text-only AI reply and persists blocker replies,
- channel attachments are stored under `.ling-stack/attachments` with a 25MB/file allow-list policy,
- link previews are fetched by the daemon with SSRF protections and metadata-only storage,
- Web now exposes `Activity`, `Tasks`, `Files`, and `Context` tabs; ordinary discussion
  messages stay plain while tasks are created through proposal confirmation, the `Tasks`
  panel, task detail, context summaries, or event details,
- v1.1 now persists Channel Brief, Decision Log, Handoff, and Context Summary records,
  with Activity and inspector views synthesizing those protocol items,
- v1.2 now lets handoffs create explicit, user-started workflow/step records with
  task/run start, blocker visibility, Runtime inspector queue tracking, and a dedicated
  `Context` tab instead of a task-detail dock,
- task detail now lives in the `Tasks` tab instead of a persistent split pane beside
  channel Activity,
- v1.3 now implements the chat experience polish slice: sticky Activity composer,
  independent message scrolling, clearer send/AI/asset states, and English/Chinese
  channel copy cleanup,
- v1.4 now aggregates run artifacts, summary paths, and event log paths in the
  channel `Files` tab without adding artifact ingestion or backend routes,
- v1.5 now derives task, run, approval, state-transition, workflow, and
  workflow-step activity cards in the channel `Activity` timeline without adding
  durable channel events,
- v1.6 now adds local search, category filters, attention filters, chip counts, and
  no-match states to the derived Activity timeline without backend changes,
- v1.7 now adds local saved Activity views and a compact attention queue for blocked,
  failed, and pending items without backend changes,
- v1.8 now adds lightweight Activity source drilldown drawers without backend changes,
- v1.9 now adds lightweight Activity triage actions in the drilldown drawer without
  backend changes,
- v1.10 now implements an Activity layout cleanup slice that moves secondary controls
  behind progressive disclosure without backend changes,
- v1.11 now simplifies the default channel surface by hiding the workspace right
  inspector, removing the global top bar, relying on the left sidebar for channel
  switching, moving path/provider/runtime controls into Settings, moving theme/language
  controls into the main Settings section, labeling `Channel protocol` as `Context`,
  hiding empty attention state, removing the separate Activity title bar, pinning the
  composer to the bottom of the Activity panel, and folding composer extras into More
  without backend changes,
- v1.12 now adds channel teammate membership management behind channel Settings, allowing
  existing workspace teammates to be added to or removed from a channel and set as the
  selected channel's default teammate without adding backend contracts,
- v1.13 now removes the Activity composer `More` panel by making mentions, dropped or
  pasted files, and pasted URLs inline input behavior,
- v1.14 now separates ordinary chat bubbles from work/protocol/runtime cards: plain
  discussion and AI reply messages show no inline conversion/action buttons, while
  non-chat events keep relevant actions and use a colored left-edge category cue,
- v1.15 now makes the channel surface chat-first: primary tabs are `Chat` and `Files`,
  `Tasks` and `Context` are secondary channel views, Activity operations are folded
  into `Chat tools`, and plain chat messages can open a `threadId`-backed topic reply
  panel,
- v1.16 now reorganizes channel Settings into `Members`, `Notifications`, and
  `Channel management` cards. Adding a teammate is an explicit select-then-add action,
  notification preferences persist in browser-local storage by `cwd + channelId`, and
  channel creation moves to the left sidebar `Channels` `+` action so Settings only
  edits the selected channel,
- v1.17 now moves channel AI teammate membership management out of Settings into a
  dedicated header dock, and changes ordinary user/AI chat message chrome plus the topic
  reply affordance into hover/focus-only bubble UI with a far-right header-row icon
  tooltip,
- v1.18 now removes the Chat composer `Discuss` / `Task` segmented mode switch and uses
  a single input where `Send` creates discussion messages and `Task` creates tasks from
  the current input,
- v1.19 is the accepted design for a general multi-agent studio: channel discussion uses
  a coordinator plus specialist teammates, multi-agent work stays collapsed by default,
  agents may propose user-confirmed execution cards, and confirmation creates the task
  and starts the assignee's PI run with approval/runtime state visible in-channel,
- v1.20 now removes the Chat composer `Task` action. Chat stays discussion-only; manual
  task creation lives in the `Tasks` panel, and executable work from chat enters through
  user-confirmed proposal cards,
- v1.21 now ports the accepted Codex-style channel mockup: Chat is the fixed center
  surface, `Tasks` / `Files` / `Context` open in an in-layout right details panel from
  the header `...` menu, the attention queue is a header popover with collapsible
  progress, local-user chat hides name/time, AI chat hides timestamps, and the left
  sidebar removes the brand block while Settings moves to the bottom,
- v1.22 now keeps channel history durable while scaling long conversations: the daemon
  returns latest-first cursor pages as chronological display slices, the Web client
  loads latest `200` messages first, prepends `100` older messages on upward scroll, and
  virtualizes the merged visible activity feed so thousands of loaded messages do not
  become thousands of DOM nodes,
- v1.23 now makes task selection explicit: entering or switching channels no longer
  auto-selects the first task or opens a task detail drawer, and task detail appears only
  from explicit task creation/open actions. Progress and attention popovers are also
  derived from current-channel state and stay hidden for channels with no chat content.
  Current-channel teammate management is a transient popover: internal add/remove/default
  actions keep it open, outside click or Escape closes it, and opening it hides the
  attention/progress popover to prevent stacked popovers from stealing clicks. It is
  centered on the channel chat surface and follows the remaining chat area when the right
  details panel is open, instead of anchoring to the global right edge,
- v1.24 now turns the right detail surface into a Codex-like multi-page drawer. Root
  pages are `Progress`, `Files`, `Context`, and `Settings`; `Task detail` and `Approval
  details` are drill-down views opened from explicit work items. Settings edits only the
  current channel, progress is bound to current-channel work, run IDs and raw audit
  payloads stay out of the default channel detail UI, and run actions try to resolve back
  to the linked task inside the channel before falling back to the run page,
- v1.25 now refines the attention/progress popover with a Codex-inspired information
  hierarchy: available environment context first, compact progress rows second, attention
  counts and top actionable items third. It borrows Codex's glanceable floating status
  model without copying its single-agent repo assumptions, dark panel styling, or raw
  execution detail surface,
- v1.26 introduced channel branches as one-level product work lanes under a parent
  channel. A hovered or focused top-level channel row exposes `Create branch` and
  `Archive channel`; a hovered or focused branch row exposes only `Archive branch`.
  Branches do not override provider, teammate, path, or runtime policy in the first
  implementation. Archived channels and branches are recovered or permanently deleted from
  a Settings management surface, while the normal drawer only exposes reversible archive.
  The UI must not imply Git checkout, merge, push, or delete-branch operations,
- v1.27 proposes a channel Environment surface: the floating progress popover may show
  environment rows such as changes, local workspace, Git branch, commit/push affordance,
  browser, and sources, while the channel `...` menu gains an Environment page that uses
  the same full-page return pattern as Channel Settings. First implementation is
  read-only: no browser-side Git probes, no real commit/push, and no conflation between
  Ling channel branches and Git branches,
- v1.28 proposes a daemon-backed, read-only Git status source for the Environment
  surface. It fixes the v1.27 semantic gap by splitting real Git `Changes` from Ling
  `Review` queue items: `Changes` comes only from daemon Git status, while `Review`
  comes from right-dock Review projections. The Web client still must not run Git
  directly, and commit/push remains disabled until a later approval-gated mutation slice,
- the conversation surface taxonomy now fixes the naming boundary between channel root,
  channel branch, topic reply, teammate private chat, and future session views. Future
  session UI should be a `LingThread` view grouped by owner surface, not a new channel-like
  conversation store,
- the 2026-06-11 channel boundary hides synthetic normal-channel branch chrome introduced
  by v1.26. The left drawer shows real branches only after they exist, the channel-row
  `Create branch` action stays hover/focus scoped, the conversation surface no longer
  renders `Conversation branches`, and Work History / Run Diagnostics owns visible thread
  lineage and branch operations,
- the multi-agent orchestration experience now keeps v1.21/v1.25 as the compatibility
  boundary: shaping-stage specialist input can be visible in chat, live execution appears
  as mutable progress rows and popover state, terminal work folds into compact summaries,
  and selector/handoff/runtime evidence remains expandable instead of becoming a separate
  multi-agent transcript UI,
- the channel auto reply router is now split into its own design: ordinary channel
  messages may use `mentions_only`, `default_teammate`, or `auto_route`, with
  `auto_route` still daemon-feature-gated but now exposed to Web through runtime
  daemon capabilities rather than a build-time-only flag. This path creates only ordinary
  `ai_reply` messages and must not start
  workflows, tasks, runs, approvals, or memory authority changes. Route explanations belong to
  the message interaction layer: accepted replies may show `Default teammate` or
  `Auto routed`; suppressed or failed messages may expose a lightweight `Why no reply?`
  popover. Do not send route evidence into the default timeline, do not use the right
  drawer for ordinary route explanation, and do not show confidence numbers or raw
  selector JSON in the normal channel UI,
- the channel intent-to-workflow selector is now documented as the staged bridge from
  ordinary messages into workflow-shaped collaboration: `no_reply`, `single_reply`,
  `visible_multi_reply`, `clarify`, `workflow_proposal`, or validated
  `direct_workflow`. The design now separates AutoGen-style visible team discussion
  from workflow execution: pure requests like `所有队友都回复我一下` can create bounded
  one-round teammate replies in the channel, while requests like `所有队友协作实现/验证`
  still become user-confirmed workflow proposals. P1-P6 cover proposal-to-workflow graph
  execution, proposal edit, clarify, independent intent persistence, confirmed
  direct-workflow prefill, feature-gated model-assisted intent selection, and bounded
  visible multi-reply for discussion-only all-teammate requests. Durable multi-agent
  coordination uses explicit protocol records instead of shared long-context chat:
  context summaries, decisions, handoff cards, workflow handoff intents, workflow packets,
  source refs, and review-gated memory candidates,
- the channel context model now separates thin channel collaboration protocol, bounded
  Context Packs, automatic compaction, and review-gated memory. The protocol is generated
  from defaults plus structured channel settings and only changes through user edits or
  explicit confirmation. Runtime context is assembled by the Context Budget Manager so
  custom provider APIs can use known, estimated, or conservative unknown-model budgets
  without turning the channel into a shared long-context transcript,
- response language for generated workflow text is a channel/workspace preference, not a
  global translation pass. The default should come from Workspace Settings, a channel may
  override it, `AGENTS.md` or equivalent project instructions may impose a clearer
  workspace rule, and an explicit user/proposal override wins for the current work. The
  resolved language applies to user-facing generated proposal/clarify/summary text only;
  code, logs, command output, filenames, API fields, errors, and historical evidence
  remain in their original language. See
  [Channel Intent To Workflow Selector](channel-intent-workflow-selector.md#response-language-resolution),
- AI councils are now a daemon/core-backed channel attachment surface rather than Web-only
  roster state. Channel Settings can attach `Development Council` by reference, choose it
  as preferred, show restrict-only governance/capacity chips, and project enabled council
  members into the channel specialist list without writing direct
  `teammate_channel_memberships`. Confirmed workflow steps preserve proposal source
  evidence so progress can show `Development Council / <slot>` or direct teammate origin
  later. Council Workspace can also attach the selected council to a selected channel by
  updating `channel_council_policies`, and it owns custom council create/clone/settings,
  member management, and archive flows. Ling Agent remains the visible coordinator and
  cannot be added as a normal council member; see [AI Councils](ai-councils.md),
- AI attachment/link content ingestion, automatic multi-agent loops, custom workflow
  builder, Channel Brief AI generation, and server-side notification persistence remain
  future slices.

### Phase 1: Channel Contract and Design Shell

- [x] Add `defaultTeammateId` to `ChannelFormState`.
- [x] Include `defaultTeammateId` in Web create/update payloads.
- [x] Map `channel.defaultTeammateId` in `channelToForm`.
- [x] Add channel header default teammate chip.
- [ ] Add right inspector shell with Members, Notifications, Settings, Runtime modes.
- [x] Add composer action model: `Send`.
- [x] Add `@` mention parsing utilities for AI teammate targets.
- [x] Add attachment UI affordance in the composer.
- [x] Add URL detection and preview-card UI affordance in the composer.
- [x] Add e2e coverage for setting channel default teammate.
- [x] Update daemon/API docs if Web behavior changes request examples.

### Phase 2: AI Discussion MVP

- [x] Add channel composer with a unified `Send` action.
- [x] Add mention picker that lists AI teammates first.
- [x] Route discussion replies to the mentioned teammate or channel default teammate.
- [x] Keep discussion no-tools unless converted into a task.
- [x] Add an explicit task creation path from channel discussion context.
- [x] Decide first implementation: durable SQLite messages.
- [x] Add e2e coverage for `@Engineer` mention and manual task creation from the
  channel workspace.

### Phase 3: Multi-Agent Protocol MVP

- [x] Define v1.1 Brief, Decision Log, Handoff, and Context Summary plan in
  `docs/design/channel-workspace-v1.1.md`.
- [ ] Add channel roster derived from durable workspace teammates and selected channel defaults.
- [ ] Add participant status chips for idle/running/waiting/blocked states.
- [x] Add Channel Brief panel with objective, scope, acceptance criteria, risks, and open questions.
- [ ] Add lightweight collaboration stage state for discussion/task threads.
- [x] Add `Create decision from this` action for selected messages/threads.
- [ ] Add review gate labels for plan review, implementation review, QA, docs, and human acceptance.
- [x] Add e2e coverage for Brief save, decision logging, supersede, handoff, and context-task flow.

### Phase 4: Agent Handoff MVP

- [x] Add handoff activity item shape.
- [x] Add handoff panel showing from/to participant, reason, expected output, and status.
- [x] Add manual handoff action from task/thread.
- [x] Add `Start workflow` action from a handoff.
- [x] Persist handoff-driven `ChannelWorkflow` and `ChannelWorkflowStep` records.
- [x] Route workflow step start through task/run coordinator and `workflow_step` leases.
- [ ] Add conflict record UI for contradictory AI recommendations.
- [x] Add e2e coverage for handoff creation and completion without task status mutation.
- [x] Add e2e coverage for workflow queue, step task creation, blocked step display,
  and start-and-run workflow behavior.

### Phase 5: Attachment MVP

- [x] Add channel attachment metadata contract.
- [x] Add daemon-managed storage under workspace `.ling-stack/attachments`.
- [x] Add upload, list, content, and delete APIs.
- [x] Support image/open/download metadata and content serving.
- [x] Support PDF and Office upload/open/download without AI ingestion.
- [x] Add file size, extension, and executable-block checks.
- [x] Add Files tab rows for user-uploaded attachments.
- [x] Add e2e coverage for PDF and Office attachment upload.

### Phase 6: Attachment AI Ingestion

- [ ] Add image-to-vision-provider routing only for image-capable providers.
- [ ] Add safe text extraction for PDF.
- [ ] Add safe text/table extraction for docx/xlsx/pptx.
- [ ] Store extraction outputs as auditable derived artifacts or context records.
- [ ] Add explicit `include attachment in task context` controls.
- [ ] Add redaction/preview before provider send when possible.
- [ ] Add e2e coverage for attachment-to-task flow.

### Phase 7: Link Preview MVP

- [x] Add URL detection utilities for composer text.
- [x] Add link preview metadata contract.
- [x] Add daemon-side preview fetcher with SSRF protections.
- [x] Add preview cache behavior keyed by normalized channel URL.
- [x] Render link cards in composer pending state and Files.
- [ ] Add Copy link, Remove preview, and visible Refresh preview actions.
- [x] Add daemon coverage for blocked link previews and e2e coverage for successful previews.

### Phase 8: Link AI Ingestion

- [ ] Add explicit link-inspection task flow.
- [ ] Add safe webpage extraction under network policy.
- [ ] Store extracted page content as auditable context/artifact records.
- [ ] Add provider/context size checks before sending extracted content.
- [ ] Add e2e coverage for link-to-task flow.

### Phase 9: Channel Tabs

- [x] Add `Activity`, `Tasks`, and `Files` tabs.
- [x] Add `Channel protocol` tab for Brief, Decisions, Handoffs, and Runtime.
- [x] Move current task list into the `Tasks` tab.
- [x] Define v1.5 Activity Events plan in `docs/design/channel-workspace-v1.5.md`.
- [x] Build derived activity items from tasks/runs/approvals/state transitions.
- [x] Add no-events and no-files empty states.
- [x] Keep the unified composer in Activity so Tasks can focus on queue + detail.
- [x] Move task detail into the `Tasks` tab.
- [x] Add e2e coverage for tab switching through Activity/Files.

### Phase 10: Files and Artifacts

- [x] Define v1.4 files and run artifacts plan in `docs/design/channel-workspace-v1.4.md`.
- [x] Derive channel files from runs with matching `channelId`.
- [x] Fetch and show run artifacts in Files tab.
- [x] Show summary and event log paths when present.
- [x] Show channel attachments separately from run artifacts.
- [x] Show shared links separately from channel attachments and run artifacts.
- [x] Add Open/Download action for channel attachments.
- [x] Add e2e coverage for artifact visibility from channel.

### Phase 11: Member and Notification Persistence

- [x] Decide whether built-in teammate template IDs are valid persisted `defaultTeammateId` values.
- [x] Add teammate daemon/DB contract before persisting custom teammate instances.
- [ ] Store notification preferences in local storage for MVP.
- [ ] Consider workspace-level persistence after settings schema exists.

### Phase 12: Durable Channel Events

- [ ] Evaluate whether derived activity is insufficient.
- [ ] If needed, add `channel_events` contract, migration, and API.
- [ ] Backfill events from tasks/runs where useful.
- [ ] Add event idempotency rules for external channel sources.

### Phase 13: Chat Experience Polish

- [x] Define v1.3 chat experience plan in `docs/design/channel-workspace-v1.3.md`.
- [x] Make the Activity message feed independently scrollable.
- [x] Hide the Activity message feed scrollbar while preserving scroll behavior.
- [x] Pin the Activity message feed to the latest visible conversation item when entering
  or switching channels.
- [x] Keep pinned feeds at the latest item while a streamed AI reply updates the same
  message body.
- [x] Show a centered floating down-arrow button when the user scrolls away from the
  latest conversation item.
- [x] Let the Activity message feed start directly below the top divider with no extra
  top inset.
- [x] Keep the Activity composer sticky at the bottom of the channel conversation.
- [x] Add clear sending, failed-send retry, and AI reply pending/blocker states.
- [x] Show a local-only sent-message preview plus compact `Thinking...` status while the
  daemon is still routing or creating the first pending AI reply.
- [x] Keep pending attachments and URL previews inside the composer without switching
  tabs.
- [x] Keep task creation connected to the `Tasks` tab without keeping conversion buttons
  on every chat message.
- [x] Audit touched channel strings for English/Chinese i18n coverage.
- [x] Add e2e coverage for composer visibility, tab boundaries, task creation, asset
  preview states, and language switching.

### Phase 14: Activity Filters and Search

- [x] Define v1.6 Activity Filters and Search plan in
  `docs/design/channel-workspace-v1.6.md`.
- [x] Add activity item category, attention, and search metadata.
- [x] Add Activity search input, category chips, attention chips, and Clear.
- [x] Add no-match empty state without hiding the composer.
- [x] Reset Activity filters on channel switch.
- [x] Add e2e coverage for search, filters, counts, channel reset, and no-match state.

### Phase 15: Activity Saved Views and Attention Queue

- [x] Define v1.7 Activity Saved Views and Attention Queue plan in
  `docs/design/channel-workspace-v1.7.md`.
- [x] Add local saved view types and localStorage helpers scoped by `cwd + channelId`.
- [x] Add built-in Activity views and custom saved view chips.
- [x] Add Save view, Rename, and Delete actions for custom views.
- [x] Add compact Attention Queue with top blocked, failed, and pending items.
- [x] Add e2e coverage for saved views, reload persistence, channel isolation, queue
  navigation, and empty attention state.

### Phase 16: Activity Source Drilldown

- [x] Define v1.8 Activity Source Drilldown plan in
  `docs/design/channel-workspace-v1.8.md`.
- [x] Add Web-only drilldown detail model derived from existing Activity items.
- [x] Add `Details` entry points to Activity cards and Attention Queue items.
- [x] Add transient details drawer with source metadata, related objects, and actions.
- [x] Preserve Activity search, saved views, queue state, and composer state while the
  drawer opens and closes.
- [x] Add e2e coverage for drawer source details, navigation actions, queue details,
  state preservation, and i18n labels.

### Phase 17: Activity Triage Actions

- [x] Define v1.9 Activity Triage Actions plan in
  `docs/design/channel-workspace-v1.9.md`.
- [x] Add Web-only triage action, draft, and result model derived from drilldown items.
- [x] Add `Triage actions` entry point and inline forms inside the details drawer.
- [x] Support follow-up task, handoff, decision, and context-summary creation through
  existing APIs.
- [x] Show success confirmation with navigation to `Tasks` or `Channel protocol`.
- [x] Preserve Activity search, saved views, queue state, composer state, and drawer
  state during triage interactions.
- [x] Add e2e coverage for successful actions, failed retry state, state preservation,
  and i18n labels.

### Phase 18: Activity Layout Cleanup

- [x] Define v1.10 Activity Layout Cleanup plan in
  `docs/design/channel-workspace-v1.10.md`.
- [x] Replace the Activity saved-view chip row with a compact view selector.
- [x] Move category and attention filters behind an expandable filter panel.
- [x] Reduce empty Attention Queue chrome and preserve populated queue expansion.
- [x] Fold source metadata, related objects, and triage actions inside the details drawer.
- [x] Collapse composer AI teammate suggestions to default teammate plus mention entry.
- [x] Add e2e coverage for compact toolbar, filter panel, queue, drawer folds,
  composer, and i18n labels.

### Phase 19: Channel Surface Simplification

- [x] Define v1.11 Surface Simplification plan in
  `docs/design/channel-workspace-v1.11.md`.
- [x] Hide the workspace right inspector by default on the channel workspace route.
- [x] Remove the global top bar from the Web shell.
- [x] Remove the duplicate body channel selector and keep channel switching in the left
  sidebar.
- [x] Remove the separate workspace toolbar and keep Settings/New task as channel header
  actions.
- [x] Move workspace path, run provider, channel creation, and runtime policy controls
  behind an explicit Settings entry.
- [x] Move theme and language controls into the main Settings section.
- [x] Rename the Web tab label from `Channel protocol` to `Context` while preserving
  the existing protocol data model.
- [x] Move Activity saved-view management into the expanded filter panel.
- [x] Hide the empty Attention Queue row.
- [x] Remove the separate Activity title bar and merge refresh into the compact tab row.
- [x] Keep the Activity composer attached to the bottom while the message feed expands
  and scrolls independently.
- [x] Move composer mentions, attachments, links, Ask AI, media-provider notice, and
  allowed-tool tokens behind More while keeping pending assets and send state visible.

### Phase 20: Channel Teammate Management

- [x] Define v1.12 Teammate Management plan in
  `docs/design/channel-workspace-v1.12.md`.
- [x] Treat a channel as valid when it has no teammate members and no default teammate.
- [x] Load teammate-channel memberships for the workspace roster in the Web client.
- [x] Add a `Channel teammates` manager behind channel Settings.
- [x] Add existing workspace teammates to the selected channel without making them
  default automatically.
- [x] Set the selected channel default teammate from the channel teammate list.
- [x] Remove a teammate from the selected channel without deleting the durable teammate.
- [x] Prioritize selected-channel teammates in composer mention options.

### Phase 21: Smart Composer Simplification

- [x] Define v1.13 Smart Composer plan in
  `docs/design/channel-workspace-v1.13.md`.
- [x] Remove the Activity composer `More` / `Hide options` tool panel from the default
  chat workflow.
- [x] Replace the explicit mention picker with an inline `@` teammate suggestion popover.
- [x] Keep selected mentions visible as removable pending chips.
- [x] Attach dropped or pasted files through the existing channel attachment upload path.
- [x] Auto-create link previews from URLs in the message body without a separate
  `Preview link` action.
- [x] Request an AI discussion reply only when an AI teammate is explicitly mentioned.
  v1.19 supersedes this trigger with coordinator intent detection for unmentioned
  messages that need AI input.

### Phase 22: Activity Message Boundary Simplification

- [x] Define v1.14 Activity Message Boundary plan in
  `docs/design/channel-workspace-v1.14.md`.
- [x] Render ordinary user and AI discussion as plain chat bubbles without inline
  task/protocol/details buttons.
- [x] Remove the default bubble background and border from ordinary local-user chat
  messages while keeping right alignment and topic-reply hover affordance.
- [x] Keep task, run, approval, protocol, workflow, and state-transition activity cards
  actionable.
- [x] Add category-specific left-edge tones for work, approval, protocol, runtime, and
  system events.
- [x] Update e2e coverage so ordinary messages have no inline conversion controls and
  protocol mutations use event details or context-summary actions.

### Phase 23: Helio-Style Chat and Topic Replies

- [x] Define v1.15 Helio-Style Chat and Topics plan in
  `docs/design/channel-workspace-v1.15.md`.
- [x] Rename the default channel view from `Activity` to `Chat`.
- [x] Keep `Chat` and `Files` as primary tabs, with `Tasks` and `Context` available as
  secondary channel views.
- [x] Fold Activity search, saved views, filters, attention queue, and CI triage behind
  `Chat tools`.
- [x] Add a compact reply affordance to plain chat and AI reply messages.
- [x] Add a right-side topic reply panel that reads and writes existing
  `ChannelMessage.threadId` data.
- [x] Add e2e coverage for sending a topic reply through the channel message API.

### Phase 24: Channel Settings Panels

- [x] Define v1.16 Channel Settings Panels in
  `docs/design/channel-workspace-v1.16.md`.
- [x] Split channel Settings into member, notification, and management cards.
- [x] Change teammate addition from select-immediate-add to select-then-`Add to channel`.
- [x] Keep member default and remove actions on the channel roster.
- [x] Add browser-local notification preference controls scoped by `cwd + channelId`.
- [x] Keep provider, path, default teammate, runtime policy, and channel creation in
  `Channel management`.

### Phase 25: Teammate Dock and Hover Topic Actions

- [x] Define v1.17 Teammate Dock and Hover Topic Actions in
  `docs/design/channel-workspace-v1.17.md`.
- [x] Move channel teammate management behind a dedicated channel header action instead
  of channel Settings.
- [x] Keep channel Settings focused on notifications and channel/runtime management.
- [x] Hide ordinary chat bubble chrome and the topic reply affordance until hover or
  keyboard focus.
- [x] Show a compact far-right header-row icon and icon tooltip before opening the topic reply panel.
- [x] Split ordinary chat by speaker side without default bubble fills: local-user
  messages render on the right, AI teammate replies render on the left, hover/focus
  reveals a neutral boundary, and non-chat work cards keep the event-card timeline
  layout.

### Phase 26: Unified Composer Actions

- [x] Define v1.18 Unified Composer Actions in
  `docs/design/channel-workspace-v1.18.md`.
- [x] Remove the Chat composer `Discuss` / `Task` segmented control.
- [x] Keep one textarea for messages, mentions, file drops, pasted files, and URL
  previews.
- [x] Keep `Send` as the discussion action and `Task` as the explicit task creation
  action from the same input.
- [x] Derive task title from the prompt and assign the first selected AI teammate mention
  or the channel default teammate.
- [x] Superseded in v1.20: remove the direct composer `Task` action after execution
  proposal cards become the preferred discussion-to-execution path.

### Phase 27: General Multi-Agent Studio and Execution Proposals

- [x] Define v1.19 General Multi-Agent Studio in
  `docs/design/channel-workspace-v1.19.md`.
- [ ] Add a persisted execution proposal contract, migration, daemon API, and Web client
  methods.
- [ ] Add a safe `propose_task` tool/result contract for channel AI replies.
- [ ] Add coordinator participation rules for unmentioned messages: respond only when
  the message needs AI input, otherwise record without noise.
- [ ] Render proposed execution drafts as inline confirmation cards in Chat.
- [ ] Show collapsed multi-agent collaboration records on proposal cards and allow
  expansion for audit.
- [ ] Let the user edit, cancel, or confirm the proposed execution before durable task
  creation.
- [ ] On confirmation, create the task and start a PI run for the proposal/task assignee.
- [ ] Block confirmation when the assignee provider, tools, credentials, or approval
  profile are not runnable; do not silently fall back to another provider.
- [ ] Keep the user in the channel after confirmation and show task/run details in the
  right-side detail surface when available.
- [ ] Show PI approval cards in channel context when a run requests `bash`, `edit`,
  `write`, external sends, or domain-specific side-effect tools.

### Phase 28: Chat Composer Task Action Removal

- [x] Define v1.20 Chat Composer Task Action Removal in
  `docs/design/channel-workspace-v1.20.md`.
- [x] Remove the Chat composer `Task` button after execution proposals become the
  preferred discussion-to-execution path.
- [x] Keep manual task creation available from the `Tasks` panel.
- [x] Keep attachments, pasted files, links, and `@` mentions in the Chat composer for
  discussion messages.
- [x] Render pending attachments and links at the top of the Chat composer: images use
  thumbnail previews, while non-image files and links use compact cards.
- [x] Update e2e coverage so composer task creation is absent while manual task creation
  still works through the `Tasks` panel.

### Phase 29: Codex-Style Chat Workspace

- [x] Define v1.21 Codex-Style Chat Workspace in
  `docs/design/channel-workspace-v1.21.md`.
- [x] Make Chat the permanent center channel surface.
- [x] Move `Tasks`, `Files`, and `Context` into a right details panel opened from the
  header `...` menu.
- [x] Add an icon-only attention popover with collapsible progress preview.
- [x] Simplify chat message metadata: local-user messages omit name/time; AI chat omits
  timestamps; audit/event cards keep metadata.
- [x] Remove the left brand block and move Settings to the lower sidebar area.
- [x] Remove legacy section-title `Create` text labels from the left drawer so refresh
  states keep icon-only header actions.
- [x] Replace channel-row numeric attention badges with unread-only green dots that clear
  when the channel is opened.

### Phase 30: Long Conversation Virtual Feed

- [x] Define v1.22 Long Conversation Virtual Feed in
  `docs/design/channel-workspace-v1.22.md`.
- [x] Keep channel history durable and remove any UI-level history truncation semantics.
- [x] Add cursor pagination to channel messages with latest `200` as the default page and
  `100` older messages per upward load.
- [x] Return `hasMore` and `nextBeforeMessageId` from the channel message list response.
- [x] Virtualize the channel Activity chat feed and dynamically measure message/event
  rows.
- [x] Preserve scroll position when older messages are prepended and keep the existing
  jump-to-latest behavior when the user reads history.

### Phase 31: Right Drawer Workspace

- [x] Define v1.24 Right Drawer Workspace in
  `docs/design/channel-workspace-v1.24.md`.
- [x] Replace the old root right-side task view with `Progress`, `Files`, `Context`, and
  `Settings` drawer pages.
- [x] Keep task detail and approval detail as explicit drill-down pages.
- [x] Move current-channel notifications, teammate membership, and channel runtime
  settings into the Settings drawer page.
- [x] Keep run IDs and raw approval audit payloads out of default channel detail UI.
- [x] Route run actions back to the linked task drawer when the current channel state can
  resolve the task.

### Phase 32: Codex-Inspired Conversation Components

- [x] Define the cross-surface conversation design baseline in
  `docs/design/codex-inspired-conversation-v1.md`.
- [x] Define implementation-level shared component detail in
  `docs/design/codex-inspired-conversation-components-v1.md`.
- [ ] Consolidate normal conversation, channel, and private chat onto shared `MessageRow`,
  `ConversationFeed`, evidence bundle, compact work cell, and composer geometry.
- [ ] Keep private chat one-to-one with the selected teammate: no `@` routing to other
  teammates inside the private thread.
- [ ] Render run/thread work as compact summaries with folded memory, skill, tool,
  approval, file, runtime, and lineage evidence.
- [ ] Add targeted browser checks for left drawer stability, composer width consistency,
  centered empty states, folded evidence, and Model Workbench duplicate-column removal.

### Phase 33: Codex-Inspired Attention Popover

- [x] Define v1.25 attention/progress popover refinement in
  `docs/design/channel-workspace-v1.25.md`.
- [x] Add context rows above progress using only existing channel/workspace state.
- [x] Replace card-like progress preview with compact status rows.
- [x] Restyle top attention items as lightweight rows with one status pill.
- [x] Keep branch/change/commit-push state optional until a real workspace status source
  exists.
- [x] Add targeted browser checks for desktop, mobile, drawer-open, no-current-work, and
  Chinese-label popover states.

### Phase 33.1: Channel Environment Surface

- [x] Define the Environment surface design in
  `docs/design/channel-workspace-v1.27-environment-surface.md`.
- [x] Define implementation-level Environment surface detail in
  `docs/design/channel-workspace-v1.27-environment-surface-detailed-design.md`.
- [x] Define the first-version implementation plan in
  `docs/design/channel-workspace-v1.27-environment-surface-implementation-plan.md`.
- [x] Add Environment to the channel `...` menu using the same full-page return pattern
  as Channel Settings.
- [x] Add read-only Environment rows to the floating progress popover from existing
  channel workspace, review, browser, source, and artifact projections.
- [x] Make the Changes row open the right dock Review page.
- [x] Add a centered commit/push modal shell without executing Git.
- [x] Keep Git branch rows hidden unless a real workspace status source provides branch
  data.
- [x] Add focused browser checks for popover changes, Environment page open/back, Review
  navigation, empty output/source states, and commit modal open/close.

### Phase 33.2: Channel Environment Git Status

- [x] Define the v1.28 Environment Git status design in
  `docs/design/channel-workspace-v1.28-environment-git-status.md`.
- [x] Define implementation-level v1.28 detail in
  `docs/design/channel-workspace-v1.28-environment-git-status-detailed-design.md`.
- [x] Define the v1.28 implementation plan in
  `docs/design/channel-workspace-v1.28-environment-git-status-implementation-plan.md`.
- [x] Add read-only `WorkspaceGitStatus` contract types and api-client method.
- [x] Add daemon read-only Git status endpoint scoped to the selected channel execution
  path.
- [x] Parse branch, file counts, staged/unstaged/untracked/conflicted counts, and
  additions/deletions when safely available.
- [x] Load Git status in the channel Environment surface without browser-side Git probes.
- [x] Split Environment `Changes` and `Review` rows so real Git changes never mix with
  approval/runtime/evidence Review items.
- [x] Add mock daemon and e2e coverage for dirty, clean, review-only, not-git-repo, and
  unavailable states.

### Phase 34: Multi-Agent Orchestration Experience

- [x] Define the compatibility and experience boundary in
  `docs/design/multi-agent-orchestration-experience.md`.
- [x] Define smart collaboration cards, stream folding, and ambient audit boundaries in
  `docs/design/multi-agent-collaboration-cards-and-ambient-audit.md`.
- [x] Define collaboration task card state-machine boundary as a read model over workflow,
  step, run, approval, and lease state machines.
- [x] Add first implementation slice plan in
  `docs/design/multi-agent-collaboration-cards-implementation-plan.md`.
- [x] Split the first implementation-ready plans into
  `docs/design/multi-agent-orchestration-p1-workflow-graph-implementation-plan.md`,
  `docs/design/multi-agent-orchestration-p2-packets-implementation-plan.md`, and
  `docs/design/multi-agent-orchestration-p3-live-progress-implementation-plan.md`.
- [ ] Keep existing Codex-inspired conversation components as the UI baseline for live
  orchestration progress.
- [ ] Extend progress rows and terminal summaries for multi-step workflows without
  rebuilding the channel feed.
- [ ] Add expandable evidence for selector decisions, structured handoff intents, step
  output packets, approvals, artifacts, and raw runtime events.
- [ ] Add requirement shaping cards for unresolved multi-agent collaboration.
- [ ] Add collaboration task cards and step handoff cards over workflow/proposal records.
- [ ] Add compact progress projection in the right floating panel for active collaboration
  task cards.
- [ ] Add stream folding for serial steps and compact parallel branch progress.
- [ ] Add targeted browser checks for visible live progress, terminal folding, and
  evidence expansion.

### Phase 35: Response Language Context

- [x] Define response-language resolution in
  `docs/design/channel-intent-workflow-selector.md`.
- [x] Add a Workspace Settings response-language preference for generated user-facing
  text, separate from the Web UI locale switcher.
- [x] Add an optional channel-level response-language override that defaults to
  Workspace Settings.
- [ ] Let proposal editing override response language for the current proposal before
  confirmation.
- [x] Persist the resolved language on the proposal/workflow so later workflow steps do
  not have to guess from partial context.
- [x] Ensure generated proposal body, clarify questions, risk summary, acceptance
  criteria, collaboration step summaries, ordinary AI reply prompts, and workflow step
  prompts follow the resolved language.
- [ ] Extend terminal/run summary rendering to reuse the persisted workflow response
  language where summaries are generated outside the step prompt.
- [x] Preserve raw code, logs, shell output, errors, API fields, filenames, artifacts,
  and existing history in their original language.
- [x] Add targeted daemon tests for Workspace default, channel override, explicit user
  override, proposal/workflow persistence, and evidence-original-language instruction.
- [ ] Add browser coverage for channel override controls and proposal edit language
  override when proposal edit lands.

### Phase 36: Channel Context Budget Manager

- [x] Define the context protocol, budget manager, compaction boundary, and implementation
  slices in `docs/design/channel-context-budget-manager.md`.
- [x] Add `docs/design/channel-context-processing-layer.md` as the product-level context
  processing boundary above Context Pack assembly.
- [x] Add `docs/design/channel-context-processing-layer-implementation-plan.md` as the
  implementation-ready slice plan for source collectors, Context Views, evidence
  filtering, condenser policy, memory isolation, inspect metadata, and E2E coverage.
- [x] Add compact roster/visible participant context to `visible_multi_reply` prompts.
- [x] Add provider budget metadata and conservative estimation for custom provider APIs
  using existing provider preset context fields.
- [x] Define automatic model capability resolution so context window and max output token
  fields are advanced overrides, while runtime budgets remain per-view/per-provider.
- [x] Add minimal internal prompt context assembly for channel replies, including current
  teammate identity and roster-question detection.
- [x] Add internal Context Pack assembly for ordinary channel replies and selectors.
- [x] Route workflow-step prompt assembly through Context Pack without changing the
  orchestrator state machine.
- [x] Detail P6 automatic compaction design for demand-driven summaries, workflow packet
  summaries, and no-tools context-length retry.
- [x] Add automatic compaction into auditable summaries/packets, not into channel protocol
  or active memory.
- [x] Detail P7 protocol editing design for effective protocol resolution, API, UI
  boundary, and Context Pack consumption.
- [x] Detail P7 implementation checklist for resolver-first API, storage boundary, UI
  placement, and Context Pack consumption.
- [x] Implement P7A/P7B1 channel protocol resolver API for existing channel fields,
  validation, unsupported-field rejection, and revert.
- [x] Detail P7B2 deferred boundary for AI drafts, protocol-only field storage,
  versioning, apply, and rollback.
- [x] Detail P7C Context surface editor behavior, field controls, validation, reset, and
  default-chat boundary.
- [x] Detail P7D resolver-backed Context Pack consumption for replies, selectors,
  auto-route, and workflow steps.
- [x] Add protocol editing/confirmation UX in the Context surface for existing channel
  protocol fields.
- [x] Route reply, selector, auto-route, and workflow-step Context Pack builders through
  the P7 resolver without allowing builders to mutate protocol.
- [x] Add Settings deep-link to the Context protocol editor.
- [x] Detail P8A workflow-step Context Pack evidence drilldown design, including entry
  points, persisted artifact source, safe fields, failure states, and boundaries.
- [x] Add P8A workflow-step Context Pack evidence drilldown in the existing workflow
  evidence/detail surface.
- [x] Detail P8B reply/selector inspect action design, including explicit entry points,
  minimal metadata persistence, rendering rules, and safety boundaries.
- [x] Add P8B1 explicit inspect action for auto-replied and suppressed channel messages
  using existing route/intent evidence where available.
- [x] Add P8B2 safe reply/selector route metadata persistence for Context Pack kind,
  provider/model ids, section ids, dropped ids, source-ref counts, and compaction ids
  without storing ordinary reply prompts.
- [x] Add P8B3 Context surface `Routing` index for recent reply-route and
  intent-selector decisions, opened on demand without a permanent evidence drawer.
- [x] Add P8B4 safety tests and rendering boundary for intent inspect metadata: safe ids,
  outcome/action/teammate/proposal/workflow/reason only; no raw prompts, hidden prompts,
  private chat, provider secrets, raw artifact bodies, confidence badges, or tuning
  sample sets.
- [x] Add P8C workflow-step Budget diagnostics inside the existing Context Pack evidence
  detail: collapsed by default, provider/token budget fields and section estimates only,
  no normal-chat token counters, raw prompts, hidden prompts, or confidence badges.

### Phase 37: Channel Branches

- [x] Define v1.26 Channel Branches in `docs/design/channel-workspace-v1.26.md`.
- [x] Add daemon storage and API for channel-owned branch records with active/archived
  state.
- [x] Add left drawer rendering for one-level branch lists under parent channels.
- [x] Add row hover/focus actions: create branch and archive channel for parent channels,
  archive branch for branch rows.
- [x] Add branch archive confirmation and restore path without conflating branch archive
  with channel archive.
- [x] Add Settings archived-items management for archived channels and branches with
  restore and delete actions.
- [x] Add destructive delete confirmations for archived channels and archived branches,
  including linked-work counts when available.
- [x] Add targeted browser coverage for branch creation, branch archive, channel archive,
  restore, delete confirmation, and archived-hidden states.

### Phase 38: AI Council Attachments And Source Attribution

- [x] Define council grouping and future desktop compatibility in
  `docs/design/ai-councils.md`.
- [x] Seed the built-in Development Council from durable built-in teammates while keeping
  Ling Agent outside normal council membership.
- [x] Add daemon APIs for councils, council members, channel council policy, and effective
  channel council projection.
- [x] Attach councils to channels by reference without copying members into
  `teammate_channel_memberships`.
- [x] Show attached council routing mode, active-member capacity, restrict-only governance
  chips, and projected specialist source details in channel Settings.
- [x] Show council governance/capacity chips in the AI teammates management page.
- [x] Add read-only AI council health report for deterministic membership availability
  findings.
- [x] Show council health chips in Web channel Settings and AI teammates management.
- [x] Preserve proposal step sources into workflow step metadata so confirmed work keeps
  direct-vs-council attribution.
- [x] Add workflow `councilSlotKey` resolution through the selected council for built-in
  templates, custom templates, and workflow graphs.
- [x] Add a desktop/client compatibility pass over shared contracts and
  `packages/api-client` council endpoints.
- [x] Add targeted Web E2E coverage for channel council attachment and council member
  management by reference.
- [x] Add daemon negative coverage that council policy/member writes cannot grant tools,
  credentials, approval bypass, or runtime authority.
- [x] Add custom council create/clone/archive flows.
- [x] Add Council Workspace page with overview, create/clone/archive, member editing,
  health, and channel entry points.
- [x] Let Council Workspace attach the selected council to a selected channel through
  `channel_council_policies`, preserving attach-by-reference behavior instead of copying
  members into `teammate_channel_memberships`.
- [x] Add Council Workspace custom council settings for display name, description,
  pinned state, and active/paused status while keeping built-in councils clone-first.
- [ ] Add council health chips in Desktop surfaces.

## Validation Plan

Run these before landing channel UI changes:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web exec playwright test
corepack pnpm typecheck
git diff --check
```

Focused e2e scenarios:

- sidebar selection remains exclusive for Workspace, Tasks, Channels, AI teammates, and DMs,
- selecting a channel opens the channel workspace and not a generic dashboard,
- setting default teammate sends `defaultTeammateId`,
- `@` opens a mention picker with AI teammates before users,
- channel composer does not expose a `More` panel in the default Activity path,
- dropped or pasted files attach from the composer without expanding secondary controls,
- `Send` can produce an AI teammate reply without creating a task,
- unmentioned messages use coordinator intent detection instead of forcing an AI reply
  for ordinary notes,
- code and film channels can both express coordinator, specialist teammates, proposal,
  assignee, and execution state without changing the channel protocol,
- proposed execution cards show assignee, acceptance criteria, and collapsed
  collaboration steps,
- ordinary discussion messages do not expose inline task, decision, handoff, context, or
  details buttons,
- the Chat composer does not expose a direct `Task` action,
- creating a task from the `Tasks` panel preserves manual task creation without crowding
  ordinary chat,
- confirming an execution proposal creates the task, starts the assignee PI run, and
  leaves the user in channel context,
- assignee provider/tool/preflight blockers stop execution and do not silently fall back
  to a different provider,
- approval requests from PI runs are visible from channel context,
- channel roster shows active/default AI teammates and their blocked/running/waiting state,
- Channel Brief records objective, scope, acceptance criteria, decisions, and open risks,
- handoff and review gate activity is visible before a task is accepted as done,
- conflicting AI recommendations require explicit arbitration rather than being merged silently,
- image/PDF/Office attachment upload shows a Files tab row without starting a run,
- unsupported or oversized attachments fail with a clear blocker,
- attachment AI ingestion only appears when the parser/provider path is supported,
- pasted URLs render preview cards without forcing message send,
- private-network or unsupported URLs show a blocked preview state,
- link AI ingestion only appears after the user explicitly asks for inspection,
- paused channel disables run actions but keeps activity/tasks visible,
- Files tab shows artifacts for a run linked to the channel,
- Activity composer remains visible after the message list grows,
- message feed scrolls independently from the channel header and tabs,
- message feed does not show a visible scrollbar and defaults to the latest conversation
  position when the user enters a channel,
- streamed AI replies keep the feed pinned to the latest visible message while the user
  is already at the bottom,
- when the user scrolls away from the latest conversation item, a centered floating
  down-arrow returns the feed to the latest message without moving the composer,
- task, run, approval, protocol, workflow, and state-transition cards remain actionable
  and visually distinguishable from plain chat,
- channel English/Chinese language switching keeps tabs and composer controls readable,
- notification mode changes do not mutate daemon state in MVP,
- right inspector does not overlap or hide the task composer on desktop and mobile.

## Open Questions

- Implemented decision: built-in template references such as `engineer` are migrated to
  deterministic workspace teammate ids such as `teammate_builtin_engineer`. Channels and
  tasks should reference durable teammate ids going forward.
- MVP decision: the first AI mention wins task `assigneeTeammateId`; if no AI mention is
  present, task creation falls back to channel `defaultTeammateId`.
- v1.19 decision: for execution proposals, `assigneeTeammateId` is required and is the
  source of truth for PI provider, tools, approval profile, and blockers.
- v1.19 decision: no-mention messages are evaluated by the channel coordinator; ordinary
  records should not produce AI noise.
- MVP decision: Files includes user-uploaded attachments, shared links, and run artifact
  aggregation by channel. Artifact contents are not read or sent to AI context.
- MVP decision: allowed attachment formats are `png`, `jpg`, `jpeg`, `webp`, `gif`,
  `pdf`, `docx`, `xlsx`, `pptx`, `txt`, `md`, `csv`, `json`, and `log`.
- MVP decision: local channel attachments are limited to 25MB per file and 10
  attachment ids per message.
- MVP decision: message attachment/link references and upload `messageId` links must
  stay within the same channel.
- MVP decision: attachment download `Content-Type` is derived from the allow-listed file
  extension; the daemon does not trust client-supplied MIME type for serving content.
- Should PDF/Office extraction happen in the daemon, a plugin, or a separate worker?
- Should extracted attachment text be stored as an artifact, a message attachment
  preview, or a task context record?
- Should image attachments be available to all chat providers, or only providers that
  declare image input capability?
- MVP decision: Activity composer link previews are auto-created from URLs in the
  message body; the old explicit Preview link action is removed from the default channel
  chat path.
- MVP decision: link previews are daemon-side metadata fetches only and block localhost,
  private, link-local, and metadata-network addresses with redirect, timeout, and body
  size limits.
- Should link preview images be proxied through the daemon, cached locally, or loaded
  directly from the remote host?
- Should link extraction use a simple HTTP fetch first, or a browser/scraper worker only
  for explicit link-inspection tasks?
- When durable `channel_events` exists, should run events be duplicated into channel
  events or referenced by source ID only?
- Should notification preferences be per browser profile, per workspace, or per future
  cloud user?
- MVP decision: `/channels/:id/messages` is required and implemented before channel
  discussion is considered supported.
- MVP decision: AI discussion replies use a lighter no-tools text path and are persisted
  as channel messages; full run-style prompt/provider snapshots remain a future hardening
  item.
- MVP decision: `@Engineer` assigns the generated task when the user explicitly creates
  or converts a task.
- Should the Channel Brief be persisted before durable messages, or derived from pinned
  messages and decisions first?
- Which review gates are required for MVP: implementation review and QA only, or also
  plan review and docs sync?
- Should handoffs be first-class daemon records, or derived from task status transitions
  until workflows are durable?
- Who is the default final arbitrator in a single-user local workspace: the human user,
  Architect, or channel owner setting?

## Acceptance Criteria

The channel feature is ready for the next implementation slice when:

- a user can identify where they are, which project path is bound, which model will run,
  and which AI teammate owns the channel,
- task creation is available without opening a configuration page,
- a user can discuss unclear requirements with the channel default or mentioned AI
  teammate before creating a task,
- `@` mentions can target AI teammates and preserve structured mention metadata,
- a user can attach images, PDFs, and Office documents to channel messages or task
  drafts,
- uploaded files are visible in the channel Files tab as inputs, separate from run
  artifacts,
- AI can inspect attachments only through explicit, auditable ingestion paths,
- a user can share web links and see safe previews in the composer, activity stream, and
  Files tab,
- AI can inspect link content only through explicit, auditable link-inspection paths,
- a discussion can be converted into a task with clear acceptance criteria,
- multi-agent work has visible owner, stage, handoff, decision, review, and final
  acceptance state,
- run blockers point to one concrete repair action,
- channel members, notifications, settings, and runtime context are inspectable from the
  right side,
- channel files can be reached without first visiting Run History,
- the implementation does not imply cloud collaboration, even though local durable custom
  teammates now exist.
