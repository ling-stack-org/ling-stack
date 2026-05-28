# Channel Workspace Design

## Status

Draft design for the next channel-focused Web UI slice.

This document is the tracking source for the channel feature. It should be updated when
the Web UI, daemon contract, or AI teammate persistence changes the channel behavior.

Related docs:

- [Web UI v0.1 Design](web-ui-v0.1.md)
- [AI Teammates and Skills](ai-teammates-and-skills.md)
- [Multi-channel concurrency](multi-channel-concurrency.md)
- [State machines and recovery](state-machine-recovery.md)
- [Daemon API](../daemon-api.md)

External pattern references:

- [Slack canvases](https://slack.com/help/articles/203950418-use-posts-in-slack)
- [Slack canvases for tasks and alignment](https://slack.com/help/articles/14455334890259-Canvases--Take-notes-and-align-on-tasks)
- [Microsoft Teams Channel Agent](https://learn.microsoft.com/MicrosoftTeams/set-up-channel-agent-teams)
- [ChatGPT Projects](https://help.openai.com/en/articles/10169521-chatgpt-projects)
- [GitHub Copilot coding agent](https://docs.github.com/en/copilot/using-github-copilot/coding-agent/about-assigning-tasks-to-copilot)

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
- channel tabs for activity, tasks, and files,
- right-side inspector for members, notifications, settings, and runtime context,
- file/artifact access from the channel itself,
- an implementation checklist that keeps future slices aligned.

## Product Position

A Ling Stack channel is not a generic chat room.

A channel is an AI teammate workroom bound to a local project scope. Chat-like activity is
only one representation of durable work events. The durable objects are:

- channel configuration,
- AI teammate membership and defaults,
- tasks,
- runs,
- approvals,
- artifacts,
- runtime locks,
- state transitions.

The user should feel they are working in a focused project room, not messaging a bot in a
stateless chat client.

## Design Goals

- Make the selected channel the default first screen for real work.
- Keep task creation and task execution more important than free-form chat.
- Make the default AI teammate visible and editable from the channel.
- Make multi-agent ownership and handoff visible before work starts.
- Keep provider, tools, approval profile, and runtime lock state inspectable before a run.
- Let files and run artifacts be reached from the channel without opening run history first.
- Preserve decisions and task context so agents can continue work without re-litigating
  the same assumptions.
- Preserve the current local-first daemon contract and avoid implying cloud/team sync.
- Keep the implementation small enough to land in slices.

## Non-Goals

- Full Slack/Discord clone.
- Cloud organizations, billing, or realtime multi-user presence.
- Rich file explorer or in-browser code editor.
- Persistent custom teammate instances before the teammate daemon/DB contract exists.
- Unbounded generic chat that bypasses channel messages, tasks, approvals, or run state.
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
  tabs: activity / tasks / files
  task-aware activity stream
  discussion/task composer

right inspector
  members
  notifications
  settings
  runtime context
```

The center area should not start with setup forms once a channel exists. Setup and
configuration belong in compact drawers, inspectors, or dedicated settings views.

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

Product decision:

```text
Channel = context + coordination + task execution
not
Channel = endless AI chat
```

The channel should borrow the visible collaboration affordances from team chat products,
but the durable unit of work remains a Ling task/run with approvals and artifacts.

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
- the selected channel tab,
- discussion/task composer.

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

### Channel Tabs

Tabs are:

```text
Activity
Tasks
Files
```

`Activity` is the default tab.

Future tabs can include:

- `Plan`,
- `Brief`,
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

Composer modes:

```text
Discuss
Task
```

`Discuss` is for:

- refining requirements,
- asking implementation or product questions,
- asking an AI teammate to identify ambiguity,
- getting acceptance criteria,
- discussing a failed run,
- summarizing a thread,
- drafting a plan before work becomes a task.

`Task` is for:

- creating a durable task,
- assigning an AI teammate,
- attaching files as task context,
- attaching links as task context,
- running through provider preflight and approval policy,
- producing auditable run events and artifacts.

The composer should support `@` mentions in both modes.
The composer should also support attachment controls in both modes. In Discuss mode,
attachments are part of the conversation context. In Task mode, selected attachments are
included as task inputs only after validation.

The composer should support automatic link detection in both modes. Link previews help
the human inspect what was shared, but link content is not fetched for AI use unless the
user explicitly asks for inspection.

Mention targets:

| Mention | MVP behavior | Future behavior |
| --- | --- | --- |
| `@Engineer`, `@Designer`, built-in AI teammate | In Discuss mode, route the next AI reply to that teammate. In Task mode, set the task assignee/default teammate. | Use persisted teammate instances and per-teammate memory/tools. |
| `@local-teammate` draft | UI-only mention until teammate persistence exists. | Persist mention target and route to teammate instance. |
| `@user` | Highlight and notification metadata only. | Notify real workspace members when team sync exists. |
| `@channel` / `@all` | Not in MVP. | Add only with notification controls and abuse limits. |
| `@task` / `@run` | Optional autocomplete from visible tasks/runs. | Link messages to task/run discussion threads. |

Rules:

- If no AI teammate is mentioned in Discuss mode, the channel default AI teammate should
  answer.
- If no default AI teammate exists, the UI should ask the user to choose one or route to
  the `Engineer` template as a temporary local default.
- A mention never grants new tools or provider capabilities.
- A mentioned teammate can only use the channel's allowed tools and the selected
  provider's capabilities.
- An attachment never grants file read permission outside the uploaded file itself.
- A link never grants network browsing permission beyond preview metadata.
- Discuss mode is read-only by default. File edits, shell commands, external sends, and
  deploy actions require converting the discussion into a task/run.
- AI replies should include a direct `Create task from this` or `Draft acceptance
  criteria` action when the discussion produces executable work.

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
- a linked follow-up task,
- a decision note in the channel activity.

Do not make AI discussion a side channel that disappears from the channel record.

## Multi-Agent Collaboration Protocol

Multi-agent collaboration needs a protocol, not just multiple AI names in the sidebar.

The channel should answer these questions at all times:

- Who owns the current objective?
- Which AI teammates are active, idle, blocked, or waiting for approval?
- What is the current stage of work?
- What context is each teammate allowed to use?
- What decision has already been made?
- What handoff is next?
- Who can approve completion?

### Channel Roster

The channel roster shows every available participant and their work role.

Roster fields:

- participant id,
- display name,
- kind: user, built-in teammate, local teammate draft, system,
- role: product, architect, designer, engineer, reviewer, QA, security, docs, release,
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

Minimum first slice:

- keep `WorkspaceClientView` as the container,
- extract `ChannelInspector`,
- add local tab state,
- add `defaultTeammateId` form support,
- add a files tab with derived rows.

The first chat-capable slice should also extract `ChannelComposer` so Discuss and Task
modes do not get tangled with task creation logic.

The first attachment-capable slice should keep attachment upload isolated behind
`channel-attachments.ts` so binary handling, previews, and future extraction do not leak
into message or task rendering components.

The first link-capable slice should keep URL detection and preview fetching isolated
behind `channel-links.ts` so network policy and SSRF protections stay testable.

The first multi-agent slice should keep protocol derivation in `channel-collaboration.ts`.
Do not spread handoff, roster, and review-gate logic across visual components.

## Interaction Flows

### Create Default Channel

```text
no channel
-> user clicks Create default
-> Web picks first preflight-ready provider if available
-> Web picks Engineer teammate template as default when available
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
write title and prompt
-> click Create task
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
-> composer is in Discuss mode
-> user types @Engineer help refine this requirement
-> mention picker inserts structured teammate mention
-> user sends message
-> channel stores the user message
-> selected/default AI teammate replies with clarification, risks, and next steps
-> user clicks Create task from this when ready
```

Execution boundary:

- AI discussion can read channel context and prior messages.
- AI discussion should not perform side effects.
- If the user asks the AI teammate to inspect files, run commands, edit files, or create
  artifacts, the UI should convert that request into a task/run flow.

### Convert Discussion to Task

```text
select message or thread
-> click Create task from this
-> task composer opens with summarized prompt and acceptance criteria
-> assignee defaults to mentioned AI teammate or channel default teammate
-> user confirms Create task or Create and run
```

The converted task should preserve a link back to the source message/thread when the
message model exists.

### Send Attachment

```text
open channel
-> click attachment button in composer
-> choose image, PDF, or Office file
-> daemon validates size, MIME, extension, and storage path
-> attachment appears in composer
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
-> paste URL into Discuss or Task composer
-> composer detects the URL
-> daemon creates or reuses a link preview record
-> preview card shows host, title, description, and image when available
-> user sends the message or creates a task
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
- Discuss mode can request a no-tools, text-only AI reply and persists blocker replies,
- channel attachments are stored under `.ling-stack/attachments` with a 25MB/file allow-list policy,
- link previews are fetched by the daemon with SSRF protections and metadata-only storage,
- Web now exposes `Activity`, `Tasks`, and `Files` tabs plus discussion-to-task conversion,
- AI attachment/link content ingestion, handoff records, decision logs, Channel Brief, and notification persistence remain future slices.

### Phase 1: Channel Contract and Design Shell

- [x] Add `defaultTeammateId` to `ChannelFormState`.
- [x] Include `defaultTeammateId` in Web create/update payloads.
- [x] Map `channel.defaultTeammateId` in `channelToForm`.
- [x] Add channel header default teammate chip.
- [ ] Add right inspector shell with Members, Notifications, Settings, Runtime modes.
- [x] Add composer mode model: `Discuss` and `Task`.
- [x] Add `@` mention parsing utilities for AI teammate targets.
- [x] Add attachment UI affordance in the composer.
- [x] Add URL detection and preview-card UI affordance in the composer.
- [ ] Add e2e coverage for setting channel default teammate.
- [x] Update daemon/API docs if Web behavior changes request examples.

### Phase 2: AI Discussion MVP

- [x] Add channel composer with Discuss/Task segmented control.
- [x] Add mention picker that lists AI teammates first.
- [x] Route Discuss mode to the mentioned teammate or channel default teammate.
- [x] Keep Discuss mode no-tools unless converted into a task.
- [x] Add `Create task from this` action for selected user messages.
- [x] Decide first implementation: durable SQLite messages.
- [x] Add e2e coverage for `@Engineer` mention and discussion-to-task conversion.

### Phase 3: Multi-Agent Protocol MVP

- [ ] Add channel roster derived from built-in teammates, local drafts, and selected channel defaults.
- [ ] Add participant status chips for idle/running/waiting/blocked states.
- [ ] Add Channel Brief panel with objective, scope, acceptance criteria, risks, and open questions.
- [ ] Add lightweight collaboration stage state for discussion/task threads.
- [ ] Add `Create decision from this` action for selected messages/threads.
- [ ] Add review gate labels for plan review, implementation review, QA, docs, and human acceptance.
- [ ] Add e2e coverage for stage visibility and decision logging.

### Phase 4: Agent Handoff MVP

- [ ] Add handoff activity item shape.
- [ ] Add handoff panel showing from/to participant, reason, expected output, and status.
- [ ] Add manual handoff action from task/thread.
- [ ] Add conflict record UI for contradictory AI recommendations.
- [ ] Add e2e coverage for handoff creation and conflict display.

### Phase 5: Attachment MVP

- [x] Add channel attachment metadata contract.
- [x] Add daemon-managed storage under workspace `.ling-stack/attachments`.
- [x] Add upload, list, content, and delete APIs.
- [x] Support image/open/download metadata and content serving.
- [x] Support PDF and Office upload/open/download without AI ingestion.
- [x] Add file size, extension, and executable-block checks.
- [x] Add Files tab rows for user-uploaded attachments.
- [ ] Add e2e coverage for PDF and Office attachment upload.

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
- [x] Move current task list into the `Tasks` tab.
- [ ] Build derived activity items from tasks/runs/approvals/state transitions.
- [x] Add no-events and no-files empty states.
- [ ] Keep task composer visible on Activity and Tasks.
- [x] Keep composer visible across channel tabs.
- [x] Add e2e coverage for tab switching through Activity/Files.

### Phase 10: Files and Artifacts

- [ ] Derive channel files from runs with matching `channelId`.
- [ ] Fetch and show run artifacts in Files tab.
- [ ] Show summary and event log paths when present.
- [ ] Show channel attachments separately from run artifacts.
- [ ] Show shared links separately from channel attachments and run artifacts.
- [ ] Add Open, Download, and Open run actions.
- [ ] Add e2e coverage for artifact visibility from channel.

### Phase 11: Member and Notification Persistence

- [ ] Decide whether built-in teammate template IDs are valid persisted `defaultTeammateId` values.
- [ ] Add teammate daemon/DB contract before persisting custom teammate instances.
- [ ] Store notification preferences in local storage for MVP.
- [ ] Consider workspace-level persistence after settings schema exists.

### Phase 12: Durable Channel Events

- [ ] Evaluate whether derived activity is insufficient.
- [ ] If needed, add `channel_events` contract, migration, and API.
- [ ] Backfill events from tasks/runs where useful.
- [ ] Add event idempotency rules for external channel sources.

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
- Discuss mode can produce an AI teammate reply without creating a task,
- `Create task from this` preserves the source discussion in the task prompt or link,
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
- notification mode changes do not mutate daemon state in MVP,
- right inspector does not overlap or hide the task composer on desktop and mobile.

## Open Questions

- MVP decision: built-in teammate template IDs such as `engineer` are valid persisted
  `defaultTeammateId` values. A future teammate instance table can introduce stable
  custom teammate IDs without changing built-in template IDs.
- MVP decision: the first AI mention wins task `assigneeTeammateId`; if no AI mention is
  present, task creation falls back to channel `defaultTeammateId`.
- MVP decision: Files includes user-uploaded attachments and shared links now; run
  artifact aggregation by channel remains a future slice.
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
- MVP decision: link previews can be created from explicit Preview link action or
  auto-created from pasted URLs on send.
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
- the implementation does not imply cloud collaboration or persistent custom teammates
  before those contracts exist.
