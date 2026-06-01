# Channel Workspace v1.15 Helio-Style Chat and Topics

## Status

Planned and implemented as a Web-only slice after v1.14 Activity Message Boundary.

v1.15 continues the channel simplification work by making the default channel surface
read as chat first. The primary tabs become `Chat` and `Files`; `Tasks` and `Context`
remain available as secondary channel views. Operational controls such as Activity
search, saved views, attention queue, and CI triage move into a compact `Chat tools`
disclosure so the message timeline and bottom composer get more space.

The slice also adds lightweight topic replies. Existing `ChannelMessage.threadId`
support is reused: replying to a message opens a right-side topic panel, shows the root
message plus replies in that thread, and sends new replies with the root message id as
`threadId`.

## Goals

- Make the channel default feel closer to a quiet chat room than a dense operations
  dashboard.
- Keep files one click away while demoting task/context workbench views to secondary
  navigation.
- Preserve the existing Activity filters, attention queue, and CI triage for power users
  without showing them as always-on default chrome.
- Add a visible reply affordance for ordinary chat and AI reply messages.
- Keep topic replies durable by using the existing `threadId` contract.

## Non-Goals

- No daemon schema changes.
- No removal of task or context workflows.
- No full Slack/Helio parity: no topic resolution status, notification persistence, or
  thread-only timeline filtering in this slice.
- No attachment or link upload inside the topic panel; attachments still use the main
  channel composer.

## Product Behavior

The channel tab row now treats `Chat` and `Files` as primary. `Tasks` and `Context` are
still rendered, but as quieter secondary buttons under `More channel views`. Existing
actions that navigate to tasks or context continue to work.

The Chat view starts with a collapsed `Chat tools` row. Opening it reveals the existing
Activity saved view selector, search, filters, attention queue, and CI triage panel.
When filters are active or the attention queue is expanded, the disclosure can remain
open so the current state is not hidden.

Plain chat bubbles keep their quiet treatment from v1.14 and add only a compact `Reply`
affordance. The reply button opens a topic panel next to the timeline. The panel shows:

- the root message,
- current replies where `reply.threadId === root.id`,
- a compact text composer,
- send/error states.

Submitting a topic reply calls the existing create channel message path with `threadId`.
If the reply body includes a known `@Teammate` token, the Web client includes that
mention and can request an AI reply in the same topic.

## Acceptance Criteria

- The selected channel shows `Chat` and `Files` as the primary tabs.
- `Tasks` and `Context` remain reachable as secondary channel views.
- Activity search/filter/attention/CI controls are not always expanded on the default
  Chat surface.
- Ordinary chat still has no task/workflow/details conversion actions.
- Clicking `Reply` opens a topic panel with the root message and any replies.
- Sending from the topic panel persists a message with the root message id as
  `threadId`.
- AI replies inside a topic preserve the parent topic id.

## Test Plan

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web exec playwright test --grep "channel activity supports mentions, messages, files, links, and task creation|channel activity filter chips keep dark console tokens|channel activity derives task run approval transition and workflow events|channel activity triage actions create follow-up records and preserve local state|language switcher toggles Chinese and English UI labels"
git diff --check
```
