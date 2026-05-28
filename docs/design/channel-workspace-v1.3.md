# Channel Workspace v1.3 Chat Experience Design and Implementation Plan

## Status

Planned v1.3 slice after the channel workspace MVP, v1.1 protocol records, and v1.2
handoff workflows.

The broader channel source of truth remains [Channel Workspace Design](channel-workspace.md).

## Summary

v1.3 makes the channel feel like a real chat workspace without adding another execution
runtime. The prior slices added durable messages, attachments, link previews, protocol
records, handoffs, workflows, and task/run links. The next problem is product shape:
the Activity tab should stay focused on conversation, while Tasks, Files, and Channel
protocol each own their heavier work surfaces.

The product rule is:

```text
v1.3 polishes channel chat ergonomics.
It does not add automatic multi-agent loops, file/webpage ingestion, notification
persistence, or a custom workflow builder.
```

The Web UI should keep the user in the channel conversation by default, make the
composer always reachable, show message and AI reply state clearly, and preserve the
existing task/run/provider/approval boundaries.

## Context

v1.2 moved the largest protocol surface behind the `Channel protocol` tab and moved task
detail into the `Tasks` tab. That fixed the most visible crowding, but the Activity tab
still needs a sharper contract:

- Activity is the channel discussion surface.
- Tasks owns task queue, task detail, and task execution controls.
- Files owns attachments, shared links, and future run artifacts.
- Channel protocol owns Brief, Decisions, Handoffs, Runtime, and workflow queue.

This slice is mostly Web structure, state feedback, and i18n cleanup. Existing daemon
messages, attachments, link previews, tasks, protocol, and workflow APIs remain the
data sources.

## Product Goals

- Keep Activity centered on channel chat and lightweight activity references.
- Keep the composer visible at the bottom of Activity even when message history grows.
- Let the message feed scroll independently from the channel shell.
- Make sending, AI replying, upload, link preview, and retry states visible.
- Keep pending attachments, URLs, and `@` mentions inside the composer without forcing
  tab switches.
- After creating a task from a message, show clear confirmation and provide a direct
  route to the new task in the `Tasks` tab.
- Make channel strings work consistently in English and Chinese.
- Keep existing e2e selectors stable: `.channel-options`, `article.task-detail`, and
  `Task inspector`.

## Non-Goals

- No automatic multi-agent loop or background scheduler.
- No custom workflow builder.
- No attachment, Office, PDF, image, or webpage body ingestion into AI context.
- No notification persistence.
- No new daemon public API unless a current Web-only state cannot be represented safely.
- No broad app shell redesign outside the channel workbench.
- No decorative chat redesign that hides provider, approval, task, or runtime state.

## UX Decisions

### 1. Activity Owns Conversation

The Activity tab should contain:

- channel message feed,
- lightweight task/run/workflow references when useful,
- composer,
- transient send/reply/upload/link-preview feedback.

The Activity tab should not contain:

- full task detail,
- full protocol panels,
- workflow step editor,
- file manager detail,
- persistent right-side panels that reduce the message lane.

If a user needs detail, the UI should route them to the owning tab.

### 2. Tasks Owns Task Detail

Task cards can appear as lightweight references in Activity, but selecting or opening a
task switches to `Tasks` and focuses the selected task. The task detail remains inside
the `Tasks` tab.

Discussion-to-task flow:

```text
open message action
-> Create task from this
-> task is created with source message context
-> Activity shows confirmation
-> confirmation action opens Tasks tab with the created task selected
```

### 3. Channel Protocol Owns Collaboration Protocol

`Channel protocol` stays beside `Activity`, `Tasks`, and `Files`.

Protocol sub-surfaces:

- Brief,
- Decisions,
- Handoffs,
- Runtime / Workflow queue.

The Activity tab can show concise protocol timeline items, but editing and inspection
belong to the protocol tab.

### 4. Composer Is Sticky Within Activity

The composer should be fixed or sticky within the Activity surface, not globally fixed
to the browser window. It should remain visible while the feed scrolls.

Target structure:

```text
channel workbench
  header
  channel tabs
  activity shell
    message feed        # independently scrollable
    composer status     # upload/link/reply/send feedback
    composer            # sticky bottom within Activity
```

The message feed should have stable min-height and overflow rules so file chips, link
cards, long messages, and empty states do not resize the whole app shell unexpectedly.

### 5. Sending State Is Explicit

Message sending should have visible state transitions:

```text
draft
-> sending
-> sent
-> failed with retry
```

AI reply requests should have separate state:

```text
AI teammate queued / replying
-> reply message persisted
or
-> blocker message or retry action
```

The user message should not be lost if AI reply fails. Provider or runtime blockers
should be visible and actionable without pretending a reply succeeded.

### 6. Pending Assets Stay Non-Disruptive

Attachments and URLs are part of composing a message. Adding them should not switch to
Files or Channel protocol.

Composer pending assets:

- show upload/progress/error per attachment,
- show link preview loading/success/blocked/failed per URL,
- allow removing pending assets before send,
- allow sending text even when a preview is blocked,
- keep MVP metadata-only behavior for files and links.

Files still summarizes uploaded attachments and shared links after they exist.

### 7. Mentions Stay Predictable

`@` mention picker behavior:

- AI teammates appear before other participant-like options.
- The channel default teammate is highlighted when present.
- The picker should not cover the send button on small screens.
- Keyboard selection, mouse selection, and Escape close should be supported.
- Mentions must be rendered from structured data when available, not only raw text.

### 8. English And Chinese Must Be First-Class

The channel workbench now has enough surface area that hard-coded copy becomes a product
bug.

Rules:

- All user-facing channel strings should go through the existing i18n dictionary.
- New v1.3 strings must have English and Chinese entries in the same change.
- Fallback text can be English only for developer-facing ids, not visible UI labels.
- E2E tests should avoid brittle language-specific assertions unless the scenario is
  explicitly validating language switching.
- Existing selectors must remain semantic or class-based where tests depend on them.

## Public Interfaces

No new daemon routes are planned.

No existing wire shapes should change:

- `ChannelMessage`
- `ChannelAttachment`
- `ChannelLinkPreview`
- `ChannelBrief`
- `ChannelDecision`
- `ChannelHandoff`
- `ChannelContextSummary`
- `ChannelWorkflow`
- `ChannelWorkflowStep`
- task `assigneeTeammateId`
- channel `defaultTeammateId`

If implementation finds a gap, prefer Web-only client state first. Only add a public
API if the state must survive refresh and cannot be derived from existing records.

## Web State Model

v1.3 can use local UI state for transient interaction feedback:

```ts
type ComposerSendState = "idle" | "sending" | "failed";
type AiReplyState = "idle" | "requested" | "replying" | "blocked" | "failed";
type PendingAssetState = "queued" | "uploading" | "ready" | "blocked" | "failed";
type PendingPreviewState = "detecting" | "fetching" | "ready" | "blocked" | "failed";
```

Durable data still comes from existing loaders:

- channel messages,
- attachments,
- link previews,
- tasks,
- protocol records,
- workflows and steps.

Refresh should not duplicate optimistic messages. If a sent message returns from the
daemon, the UI should reconcile by id or client nonce if one already exists. If no nonce
exists in the current contract, keep optimistic rendering strictly local and replace it
after the message list refreshes.

## Implementation Plan

### Phase 1: Activity Layout

- Introduce a focused Activity layout shell around message feed and composer.
- Make the feed independently scrollable.
- Keep the composer sticky at the bottom of the Activity surface.
- Ensure empty state, long messages, pending assets, and link cards do not push the
  composer out of reach.
- Keep task detail and protocol detail out of Activity.

### Phase 2: Composer Feedback

- Add send state, failure banner, retry, and dismiss behavior.
- Add AI reply pending/blocker feedback separate from message send state.
- Add pending attachment and pending link preview status rows inside the composer.
- Keep mention picker placement stable on desktop and mobile widths.

### Phase 3: Task Conversion Feedback

- After `Create task from this`, show a compact confirmation with the task title or id.
- Add an action that switches to `Tasks` and selects the created task.
- Keep Activity on chat unless the user explicitly opens the task.
- Preserve `assigneeTeammateId` derivation from first AI mention or channel default.

### Phase 4: i18n Cleanup

- Move channel-specific hard-coded visible strings into the i18n dictionary.
- Add English and Chinese entries for new Activity, composer, task conversion, and
  protocol navigation text.
- Add or adjust tests so language switching does not break channel controls.

### Phase 5: Tests And Docs

- Add focused Web e2e for Activity layout and interaction feedback.
- Update `docs/design/channel-workspace.md` tracker.
- Update `docs/design/web-ui-v0.1.md` if user-visible behavior changes.
- Avoid daemon/core/api-client tests unless implementation touches shared contracts or
  daemon behavior.

## Test Plan

Web e2e:

- Activity composer remains visible at the bottom after enough messages exist to scroll.
- Message feed scrolls without moving the channel header or tabs.
- Sending a message shows a transient sending state and then a durable message.
- Failed message send shows retry and does not clear the draft unexpectedly.
- Requesting an AI reply shows an AI reply pending state and then a persisted reply or
  visible blocker.
- Uploading PDF/DOCX/XLSX/PPTX while in Activity keeps the user in Activity and later
  shows the files in `Files`.
- Pasting a URL shows preview loading/success or blocked/failed state without switching
  tabs.
- Mention picker lists AI teammates first and highlights the channel default teammate.
- `Create task from this` shows confirmation and can open the created task in `Tasks`.
- Activity does not render full `article.task-detail` by default.
- `Channel protocol` remains a peer tab and protocol detail does not occupy Activity.
- English/Chinese language switching keeps channel tabs, composer controls, and task
  conversion controls readable.

Regression commands:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web exec playwright test
corepack pnpm typecheck
git diff --check
```

If implementation changes contracts, daemon routes, or shared store behavior, expand to:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client test
```

## Rollout Plan

1. Land this design document as the v1.3 scope baseline.
2. Implement Activity layout and composer stickiness first.
3. Add send, AI reply, asset, and task-conversion feedback.
4. Complete i18n cleanup for touched channel strings.
5. Run Web e2e and type/build checks.
6. Update docs with implemented notes and mark tracker items complete.

## Future Work

Keep these out of v1.3:

- automatic multi-agent loop,
- workflow builder,
- attachment and webpage body ingestion,
- persistent notifications,
- durable `channel_events`,
- richer threaded replies,
- channel Brief AI generation,
- cross-channel context reuse.
