# Channel Workspace v1.14 Activity Message Boundary

## Status

Planned and implemented as a Web-only slice after v1.13 Smart Composer.

v1.14 separates ordinary channel discussion from work/protocol/runtime events in the
Activity feed. Plain user and AI teammate messages render as quiet chat bubbles with a
compact inline avatar, author, and timestamp. Task, run, approval, workflow, decision,
handoff, context-summary, and state-transition events keep action rows and use a colored
left edge to show their category.

## Goals

- Keep one-line discussion such as "hello" from showing task, workflow, handoff, or
  decision buttons.
- Make ordinary messages feel like chat content, not command cards.
- Preserve event actions where they are meaningful: task cards, run cards, approval
  cards, workflow cards, protocol records, context summaries, and the Activity details
  drawer.
- Use color only as a secondary cue; labels such as `Task event`, `Run event`,
  `Approval event`, `Workflow`, `Decision log`, and `Handoff` remain visible.

## Non-Goals

- No daemon routes, schema changes, or persisted activity-event model.
- No removal of task creation. Users still create tasks from the composer `Task` mode,
  task detail, context summaries, and event triage.
- No hidden automatic workflow startup from ordinary discussion.

## Product Behavior

For `message` and `ai_reply` channel messages, Activity renders a compact author row
with the avatar, author, optional AI tag, timestamp, and body only. These messages do not
show `Details`, `Create task`, `Record decision`, `Create handoff`, `Create task with
context`, or workflow buttons inline. Mention tokens such as `@Designer` are styled with
the information blue token inside the message body so references remain easy to scan.

System or linked-task messages keep a neutral system treatment. Work items use the work
tone, approvals use the approval tone, decisions/handoffs/context summaries use the
protocol tone, and workflows/state transitions use the runtime tone.

Follow-up work from discussion should be explicit. The default path is switching the
composer to `Task` mode or using an event/context-summary action when the feed contains
an actual work artifact.

## Acceptance Criteria

- A sent ordinary discussion message shows no inline action buttons.
- AI teammate replies show no inline workflow or task-conversion buttons.
- Ordinary discussion keeps avatar, author, and timestamp in a single compact header row.
- Mention tokens in message bodies render in blue.
- Task, run, approval, protocol, workflow, and state-transition events keep their
  relevant action rows.
- Non-chat event categories are visually distinguishable by left-edge tone.
- Existing event details and triage flows continue to work from event cards.

## Test Plan

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web exec playwright test --grep "channel activity supports mentions, messages, files, links, and task creation|channel v1.1 protocol supports brief, decisions, handoffs, and context task creation|channel v1.2 handoff workflows can start steps and surface runtime context|channel activity derives task run approval transition and workflow events|channel activity triage actions create follow-up records and preserve local state"
git diff --check
```
