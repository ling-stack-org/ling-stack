# Conversation Surface Taxonomy

Status: design boundary for normal conversation, channel, branch, topic reply, private chat, and future session surfaces
Date: 2026-06-25
Last updated: 2026-06-28

Related docs:

- [Conversation Surface Contract](./conversation-surface-contract.md)
- [Thread-First Work History](thread-first-work-history.md)
- [Thread-First Work History V2 Detailed Design](thread-first-work-history-v2-detailed-design.md)
- [AI Teammate Private Workspace](ai-teammate-private-workspace.md)
- [Channel Context Processing Layer](channel-context-processing-layer.md)
- [Channel Auto Reply Router](channel-auto-reply-router.md)

## Purpose

Ling now has several conversation-like surfaces that look similar in the UI but must not
share the same product meaning:

- a normal conversation started from the home composer,
- a channel root conversation,
- a channel branch,
- a topic reply under one channel message,
- a teammate private chat,
- a durable work/session thread.

This document fixes the vocabulary and ownership boundaries so future "session" work does
not blur channel messages, channel branches, topic replies, private chats, and
`LingThread` continuity into one overloaded concept.

## Positioning

The existing architecture is still the right shape:

```text
NormalConversation owns a user-started assistant conversation from the home composer.
Channel owns the room and shared governance.
ChannelBranch owns a named lane inside that room.
ChannelMessage owns visible chat records.
Topic reply owns a lightweight side conversation under one message.
Teammate private chat owns private user-to-teammate conversation.
LingThread owns durable continuity, runs, turns, artifacts, and resume/fork lineage.
```

No new top-level storage aggregate is required for "session" as a product word. A session
should be a user-facing view over `LingThread`, scoped to one owner surface.

## Surface Map

| Surface | User-facing meaning | Primary storage | Scope owner | Default visibility |
| --- | --- | --- | --- | --- |
| Normal conversation | The conversation created after sending from the home composer | `LingThread` + turn/message/evidence records | User + selected workspace | Private to the user unless explicitly shared/promoted |
| Channel root | The main shared room for a project or work area | `Channel` + root `ChannelMessage` rows | `Channel` | Public inside the channel |
| Channel branch | A named lane under one channel, such as `test` or `Model routing fix` | `ChannelBranch.rootThreadId` + `LingThread` + branch-scoped `ChannelMessage.threadId` rows | Parent `Channel` | Public inside the channel, filtered to the branch |
| Topic reply | A lightweight side discussion under one message | `ChannelMessage.threadId = sourceMessage.id` | Source `ChannelMessage` | Public inside the channel, nested under the source message |
| Teammate private chat | A private conversation with one teammate | Teammate direct thread/message store | Teammate + user | Private to that direct chat |
| Work/session thread | A durable unit the user can resume, fork, audit, or search | `LingThread` and related turn/run/evidence tables | Depends on owning surface | Shown through the owning surface and Work History |

## Ownership Rules

### Normal Conversation

The home screen is only the pre-send entry surface. After the user sends the first message
from the home composer, Ling creates or opens a normal conversation and switches from the
home landing layout into the conversation page layout.

Normal conversation is that post-send conversation page. It is not a channel, not a
private teammate chat, and not only a run detail page. It owns the user's direct assistant
conversation and should use the same conversation capability blocks as other surfaces:

- user and assistant messages,
- attachments and file references,
- evidence blocks when memory, web, files, tools, or context were actually used,
- compact work cells when the conversation triggers runs, approvals, file changes, or
  long-running work,
- detailed work/evidence drill-down through the linked `LingThread` or work history view.

Normal conversation must not:

- keep rendering as the home landing/hero layout after the first message exists,
- show channel teammate rosters or multi-teammate collaboration activity by default,
- expose topic-reply controls that only make sense inside channels,
- pretend a run thread is the only place where work cells or evidence can appear.

### Channel

`Channel` remains the durable collaboration room. It owns:

- name and lifecycle,
- workspace binding and bound path,
- default provider and default teammate references,
- allowed tools and runtime policy,
- channel protocol, brief, decisions, playbooks, and governance state,
- channel-scoped memory and generated skill candidates,
- uploaded files, link previews, tasks, approvals, and channel-visible artifacts.

It is not a single conversation. It is the container for root messages, branches, topic
replies, and work/session threads.

### ChannelBranch

`ChannelBranch` is a product lane, not a Git branch and not a hidden channel. It owns only:

- branch label,
- lifecycle state,
- `rootThreadId`.

It must not own separate provider defaults, teammate rosters, bound paths, tool policy,
runtime policy, channel protocol, memory scopes, or generated skills. Those stay on the
parent `Channel`.

Selecting a channel branch means:

```text
selected channel = parent channel
selected conversation = ChannelBranch.rootThreadId
```

Sending a channel message while the branch is selected writes:

```text
ChannelMessage.channelId = parent channel id
ChannelMessage.threadId = ChannelBranch.rootThreadId
```

Listing the selected branch filters to that `rootThreadId`. Listing the root channel must
exclude branch-root messages while keeping root topic replies attached to their source
messages.

### Topic Reply

A topic reply is message-level discussion. It is lighter than a channel branch and should
not become a navigation lane.

Topic reply messages use:

```text
ChannelMessage.threadId = source channel message id
```

This keeps replies attached to the source bubble and avoids creating a separate
`ChannelBranch` or `LingThread` unless a later workflow explicitly promotes the discussion.

Topic replies should not trigger ordinary channel auto-reply by default. If future work
adds topic-level Ling replies, it needs an explicit route policy so every small side thread
does not become an always-on agent surface.

### Teammate Private Chat

Private chat is a separate surface for user-to-teammate conversation. It can influence the
teammate's behavior through private memory policy, but it is not public channel context by
default.

Private chat is one-to-one with the selected teammate. It must not support `@` mentions that
route the message to other teammates or invite other teammates into the same private thread.
If the user needs multi-teammate discussion, the UI should route them to a channel,
channel branch, or explicit workflow surface.

Private chat can still render common conversation capability blocks:

- attachments and file references,
- compact evidence when the selected teammate used memory, web, files, tools, or context,
- compact work cells when the private chat creates or continues work,
- approval or blocked-state rows when a side effect requires confirmation.

Private chat must not:

- appear in channel context unless explicitly referenced or promoted,
- quote private memory into channel replies by default,
- bypass channel, task, run, or approval state machines for side effects.

### LingThread

`LingThread` is the continuity object. It owns durable session semantics:

- title, objective, status, pin/archive state,
- parent/child lineage,
- turns,
- run attempts,
- artifacts,
- approvals and evidence links,
- resume/fork search and audit surfaces.

`LingThread` should not become a competing visible room model. Product surfaces may show a
"session", "branch", "work thread", or "conversation" label, but the durable object remains
`LingThread`.

## Identifier Semantics

The current `ChannelMessage.threadId` field is intentionally reused across multiple
message scopes. Callers must distinguish them by reference shape:

| `ChannelMessage.threadId` value | Meaning | Behavior |
| --- | --- | --- |
| undefined | Root channel message | Belongs to root channel feed |
| `ChannelBranch.rootThreadId` | Branch-root lane message | Belongs to selected channel branch |
| source `ChannelMessage.id` | Topic reply under one message | Belongs under the source message |
| other `LingThread.id` | Work/session-linked message | Treat through Work History or explicit owner metadata |

Do not infer the meaning from the string prefix alone. Resolve against known channel
branches and source messages before deciding UI placement, auto-reply behavior, or context
scope.

## Reply Policy

Default Ling reply behavior should follow the surface:

| Surface | Ordinary Ling reply default | Rationale |
| --- | --- | --- |
| Normal conversation | Allowed inside that conversation | The user explicitly started a direct assistant conversation from the home composer |
| Channel root | Allowed by channel routing policy | Root channel is the main collaboration conversation |
| Channel branch | Allowed by channel routing policy, scoped to branch `rootThreadId` | Branch is a focused lane, not a silent side panel |
| Topic reply | Suppressed by default | Side replies are lightweight and should not fan out automatically |
| Teammate private chat | Allowed inside the private chat only | Private conversation is explicitly directed at one teammate |
| Work/session thread | Allowed when resuming or continuing that thread | Continuity belongs to `LingThread` |

Suppression copy should name the surface. For example, topic replies can say automatic
replies currently run only in channel root and channel branches, not in message-level
topics.

## Context Policy

Context assembly must be scoped before selecting recent messages:

| Active surface | Default recent conversation scope |
| --- | --- |
| Normal conversation | That conversation's `LingThread` turns plus explicitly linked workspace/file/context evidence |
| Channel root | Root channel messages and their attached root topic replies, excluding channel branch lanes |
| Channel branch | Messages where `threadId = ChannelBranch.rootThreadId` |
| Topic reply | Source message plus messages where `threadId = sourceMessage.id` |
| Teammate private chat | That teammate direct thread only |
| Work/session thread | `LingThread` turns, linked run evidence, and explicitly linked channel context |

Shared channel governance may still apply to branch and topic surfaces:

- provider fallback,
- channel protocol,
- allowed tools and approval policy,
- selected channel memory after policy filtering,
- files or artifacts explicitly linked to the message or run.

Private teammate memory remains private by default. It can influence teammate behavior only
through the memory policy boundary defined in the Channel Context Processing Layer.

## Shared UI Contract

The taxonomy defines product ownership. The shared component and capability contract is
defined in [Conversation Surface Contract](conversation-surface-contract.md).

Implementation rule:

```text
taxonomy decides what the surface means
surface policy decides what the surface may show
shared conversation components decide how it renders
```

This means:

- normal conversation, channel, teammate private chat, and run/thread detail should use
  shared message rows, feed, empty state, action bar, evidence, source, attachment, and
  compact work primitives;
- channel-only policy still controls teammate activity, topic reply, channel roster, and
  teammate mention routing;
- private chat still forbids `@` routing and public channel leakage even when it reuses
  the same shared components;
- work cells and evidence are not run-thread-only UI. They can appear in normal
  conversation and private chat when actual work or evidence exists.

## Future Session Product Boundary

If Ling adds a visible "Sessions" view, it should be a filtered view over `LingThread`, not
a new conversation store.

The view can group sessions by owner:

```text
Sessions
  Channel sessions
    channel root session
    channel branch session
    task/workflow session
  Private sessions
    teammate direct session
  Normal conversations
    home composer conversation
  Automation sessions
    automation heartbeat thread
```

The session view may provide resume, fork, archive, pin, search, and evidence inspection.
It must not duplicate channel settings, teammate settings, provider defaults, runtime
policy, or memory scopes. Those stay on their owning surface.

## Anti-Confusion Rules

- Do not call a channel branch a Git branch.
- Do not make a channel branch inherit or clone channel configuration.
- Do not use topic replies as branch navigation.
- Do not show private chat content in public channel context unless explicitly promoted.
- Do not allow private chat `@` mentions to route to other teammates.
- Do not treat work cells or evidence as run-thread-only UI; normal conversation and
  private chat can render them when real work or evidence exists.
- Do not create a new session store while `LingThread` can represent the continuity object.
- Do not decide auto-reply behavior from `threadId` presence alone.
- Do not query channel root context as "all channel messages" once branches exist.

## Implementation Implications

The current branch silence and context mixing bug class is a boundary bug, not an
architecture failure. The fix should be scoped:

1. Resolve the active surface before listing messages or building context.
2. Treat `ChannelBranch.rootThreadId` as branch-root conversation scope.
3. Keep topic replies suppressed unless explicitly enabled.
4. Keep root channel feeds from absorbing branch-root messages.
5. Add regression tests for normal conversation, root channel, channel branch, topic reply,
   and private chat context boundaries.
