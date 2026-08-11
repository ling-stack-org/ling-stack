# Channel And Agent Governance Notifications

Status: partially implemented active contract
Date: 2026-06-20
Last verified: 2026-08-03
Owner: Governance notifications and conversation surfaces
Scope: Routing memory, skill, procedure, and health review events into user-visible
notification surfaces without polluting channel or private conversation history.

## Summary

Ling now has multiple governance queues that can produce review-worthy events:

```text
memory promotion inbox
+ memory health findings
+ skill candidates
+ procedure observation clusters
+ channel protocol and playbook candidates
```

Those queues are the authoritative state. They should remain the place where users
approve, reject, edit, archive, quarantine, or publish durable records.

The durable notification model, dedupe and channel-header visibility are implemented.
Teammate-private delivery and the cross-channel Ling Agent digest remain follow-up work.

The target shape is:

```text
governance source record
  -> notification delivery classifier
  -> deduped notification record
  -> delivery timing gate
  -> local surface by ownership:
       teammate private chat system message
       channel header notification
       workspace notification / Ling Agent summary
  -> deep link back to the authoritative review surface
```

The notification is a pointer and reminder. It is not the source of truth.

## Source Designs

This design extends:

- [Conversation Surface Contract](./conversation-surface-contract.md)
- [AI Teammate Private Workspace](ai-teammate-private-workspace.md)
- [Memory Health And Multi-Agent Memory Fan-In](memory-health-and-fanin.md)
- [Skill Candidates And Protocol Governance](skill-candidates-and-protocol-governance.md)
- [Daemon API](../daemon-api.md)

## Product Rule

Governance notifications improve Ling only if they stay scoped, deduped, and quiet.

```text
Notify where ownership is local.
Review where authority already lives.
Never convert notifications into chat spam.
Never interrupt an active private conversation.
```

Private teammate events belong near the teammate. Channel events belong near the channel.
Cross-channel or workspace-wide events belong near Ling Agent or a future workspace
notification center.

## Current Baseline

Already implemented:

- durable governance notification contracts, SQLite records, dedupe keys, status and
  delivery state;
- daemon list, summary, seen, dismiss and lifecycle reconciliation routes;
- channel-scoped projection and the header notification popover;
- Teammate direct messages support `authorType: "system"` and render as system messages.
- Direct chat already has durable private threads and message history.
- Channel header already owns attention/progress affordances and notification row badges.
- Memory promotion inbox and review actions exist.
- Memory health reports exist as read-only diagnostics.
- Skill candidates, procedure observation clusters, protocol candidates, and playbook
  candidates exist as review-oriented governance records.
- Existing design rules keep raw audit/debug details out of default conversation feeds.

Current gaps:

- teammate-private system-message delivery still needs quiet-window and active-reply
  coordination;
- cross-channel and workspace-level grouping still needs the Ling Agent digest owner;
- the current persisted `seen` state remains workspace-local rather than multi-user.

## Non-Goals

- No writing ordinary governance notifications into `conversation_items`.
- No channel feed system messages for ordinary memory, skill, or health review events.
- No AI auto-reply triggered by a governance notification.
- No approval, publish, archive, quarantine, or delete action performed by clicking a
  notification itself.
- No raw transcript, prompt, stdout, artifact body, secret value, or private teammate
  memory in a notification payload.
- No duplicate notification to every participant in a multi-agent workflow by default.
- No immediate teammate private chat push while the user is actively chatting or an AI
  teammate reply is running.
- No OS-level desktop notifications in the first slice.
- No global notification center required for the first slice.

## Routing Model

Route by the most local safe owner.

```text
source refs resolve to one teammate/direct thread
  -> teammate private chat system notification

source refs resolve to one channel
  -> channel header notification

source refs resolve to multiple teammates inside one channel
  -> channel header notification

source refs resolve to multiple channels or workspace-level state
  -> Ling Agent private chat summary, or future workspace notification center

source refs contain authority, security, approval, provider, secret, deploy,
or external-send risk
  -> authoritative governance surface first
  -> optional Ling Agent summary only when user action is required
```

### Routing Matrix

| Event shape | Default surface | Reason |
| --- | --- | --- |
| Private memory candidate from one direct thread | Teammate private chat | Review the teammate's own learning near that teammate. |
| Skill correction tied to one teammate/run | Teammate private chat | Ownership is agent-specific and should not pollute the channel. |
| Channel-scoped memory candidate | Channel header notification | The channel owns the review context. |
| Procedure cluster from one channel workflow | Channel header notification | The reusable procedure is channel-local until promoted. |
| Multi-agent fan-in inside one channel | Channel header notification | Pushing to every participant creates duplicate noise. |
| Channel protocol or playbook candidate | Channel header notification | These are channel operating records. |
| Workspace memory health backlog | Ling Agent or workspace notification | No single channel owns the backlog. |
| Cross-channel procedure cluster | Ling Agent or workspace notification | Coordination owner is global. |
| Permission or authority-like observation | Governance surface plus optional Ling Agent summary | Not a skill or memory review action. |

## Event Types

First slice event kinds:

```ts
type GovernanceNotificationKind =
  | "memory_candidate_ready"
  | "memory_candidate_stale"
  | "memory_cross_scope_review_required"
  | "memory_backlog_digest"
  | "memory_health_finding"
  | "skill_candidate_ready"
  | "procedure_cluster_ready"
  | "channel_protocol_candidate_ready"
  | "channel_playbook_candidate_ready";

type GovernanceNotificationSeverity =
  | "info"
  | "warning"
  | "action_required"
  | "critical";
```

First slice should only surface `warning`, `action_required`, and `critical` in the
channel header badge by default. `info` events can exist in the notification drawer or
digest, but they should not create header pressure.

## Memory Event Mapping

Memory has its own source events. Notification kinds should stay product-facing, while
source events stay close to MemoryObject, review, health, and consolidation state.

```ts
type MemoryGovernanceSourceEvent =
  | "candidate_created"
  | "candidate_review_required"
  | "candidate_stale"
  | "cross_scope_review_required"
  | "health_finding_created"
  | "review_backlog_threshold_crossed"
  | "review_resolved"
  | "active_memory_used";
```

Mapping:

- Private teammate candidate created:
  `memory_candidate_ready`, `action_required`, teammate private chat after quiet
  window. Action: open teammate Memory review.
- Channel candidate created:
  `memory_candidate_ready`, `action_required`, channel header notification. Action:
  open promotion inbox filtered to channel.
- Same-scope task/run candidate created:
  `memory_candidate_ready`, `info`, workflow summary or drawer only. Action: inspect
  only if the user opens details.
- Candidate older than stale threshold:
  `memory_candidate_stale`, `warning`, owner surface by scope. Action: keep, approve,
  reject, or archive.
- Cross-scope promotion needed:
  `memory_cross_scope_review_required`, `action_required`, target owner or Ling Agent
  if workspace-level. Action: inspect source refs before approval.
- Critical health finding created:
  `memory_health_finding`, `critical`, owner surface by scope. Action: open Memory
  Health finding.
- Non-critical health finding created:
  `memory_health_finding`, `warning`, owner surface by scope. Action: open Memory
  Health finding.
- Review backlog crosses threshold:
  `memory_backlog_digest`, `warning`, channel, teammate, or Ling Agent digest. Action:
  open filtered review queue.
- Review action resolves candidate:
  no new notification. Resolve the existing notification.
- Active memory used in a prompt:
  no notification. Show only in used-memory disclosure.

Do not notify for every memory write. The notification trigger is review pressure, stale
review pressure, health risk, or cross-scope risk.

### Memory Surface Resolution

Resolve memory notifications by scope before falling back to Ling Agent:

| Memory scope | Default notification surface |
| --- | --- |
| `teammate` or direct-thread-derived private candidate | Teammate private chat after quiet window |
| `channel` | Channel header notification |
| `task` or `run` with a parent channel | Channel header notification or workflow summary |
| `task` or `run` without a channel | Ling Agent or workspace notification |
| `workspace` | Ling Agent or workspace notification |

Private-to-channel promotion requires the target channel surface only after the source is
safe to reveal. Before that, notify the private teammate surface and route the review into
the memory approval surface.

### Memory Notification Copy Rules

Memory notifications must not copy memory bodies by default. Use short, bounded copy:

```text
Memory candidate ready
Engineer has a private memory candidate waiting for review.
Open Memory Review
```

Allowed fields:

- memory title when it is not private or sensitive;
- review state;
- scope type and owner label;
- health finding kind and severity;
- source ref labels, not raw source content.

Forbidden fields:

- full memory body;
- raw direct chat text;
- raw workflow output packet body;
- secret-adjacent values;
- private teammate notes in a channel notification.

## Durable Notification Record

Use a small durable record separate from source governance tables.

```ts
interface GovernanceNotification {
  readonly id: string;
  readonly workspaceId: string;
  readonly surface:
    | { readonly kind: "teammate_direct"; readonly teammateId: string; readonly threadId: string }
    | { readonly kind: "channel"; readonly channelId: string }
    | { readonly kind: "ling_agent"; readonly teammateId: string }
    | { readonly kind: "workspace" };
  readonly kind: GovernanceNotificationKind;
  readonly severity: GovernanceNotificationSeverity;
  readonly title: string;
  readonly summary: string;
  readonly sourceRefs: readonly GovernanceNotificationSourceRef[];
  readonly targetRoute: GovernanceNotificationRoute;
  readonly status: "unread" | "seen" | "dismissed" | "resolved";
  readonly deliveryStatus: "pending" | "delivered" | "suppressed";
  readonly deliveryBlockedReason?:
    | "active_private_chat"
    | "teammate_reply_running"
    | "recent_user_input"
    | "surface_muted"
    | "source_resolved";
  readonly deliverAfter?: string;
  readonly deliveredAt?: string;
  readonly dedupeKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt?: string;
}
```

Source refs should point to existing records, not duplicate their content:

```ts
type GovernanceNotificationSourceRef =
  | { readonly type: "memory"; readonly id: string }
  | { readonly type: "memory_health_finding"; readonly id: string }
  | { readonly type: "skill_candidate"; readonly id: string }
  | { readonly type: "procedure_cluster"; readonly id: string }
  | { readonly type: "channel_protocol_candidate"; readonly id: string }
  | { readonly type: "channel_playbook_candidate"; readonly id: string }
  | { readonly type: "run"; readonly id: string }
  | { readonly type: "workflow"; readonly id: string }
  | { readonly type: "workflow_step"; readonly id: string }
  | { readonly type: "message"; readonly id: string };
```

`targetRoute` should be route-like and client-owned, not a raw URL string. Web, Desktop,
CLI, and future TUI clients can project it into their own navigation.

```ts
type GovernanceNotificationRoute =
  | { readonly page: "memory_promotion_inbox"; readonly memoryId?: string; readonly channelId?: string; readonly teammateId?: string }
  | { readonly page: "memory_health"; readonly findingId?: string; readonly channelId?: string; readonly teammateId?: string }
  | { readonly page: "skill_candidate"; readonly candidateId: string }
  | { readonly page: "procedure_cluster"; readonly clusterId: string }
  | { readonly page: "channel_protocol_candidate"; readonly channelId: string; readonly candidateId: string }
  | { readonly page: "channel_playbook_candidate"; readonly channelId: string; readonly candidateId: string };
```

## Dedupe And Lifecycle

Notifications must be idempotent before write.

Suggested dedupe keys:

```text
memory candidate:
  workspaceId + surface + memoryId + reviewState

memory health finding:
  workspaceId + surface + finding.kind + finding.memoryId + finding.relatedMemoryIds

skill candidate:
  workspaceId + surface + skillCandidateId + status

procedure cluster:
  workspaceId + surface + procedureClusterId + status + recommendedAction

channel protocol/playbook candidate:
  workspaceId + surface + candidateId + status
```

If a source record changes materially, update the existing notification instead of
creating another row. If a source record reaches a terminal review state, mark the
notification `resolved`.

Source-to-notification lifecycle:

| Source state | Notification state |
| --- | --- |
| pending review / ready for review | `unread` or `seen` |
| user opens notification drawer | `seen` |
| user dismisses reminder only | `dismissed` |
| source approved/rejected/archived/quarantined/published/cancelled | `resolved` |
| source deleted by retention cleanup | `resolved` with minimal tombstone source ref |

Dismissal hides the reminder, not the source record. Review surfaces still show open
candidates until their own state changes.

## Delivery Timing

Notification creation and notification delivery are separate.

```text
source event occurs
  -> create/update durable notification immediately
  -> compute target surface
  -> deliver only when that surface will not interrupt active work
```

Channel header notifications are low-interruption because they do not write chat rows.
They can update the header summary as soon as the notification record exists, subject to
per-channel preferences.

Teammate private chat delivery is higher interruption because it creates a visible system
message in a conversational timeline. It must pass a quiet-window gate before writing the
direct message.

### Teammate Private Quiet-Window Gate

Deliver a teammate-private notification only when all are true:

```text
no pending or streaming teammate direct reply
AND no active direct reply work unit for this teammate/thread
AND no direct message or private workspace activity occurred in the recent quiet window
AND source record is still open and review-worthy
AND teammate notification preference allows this severity
```

Default quiet window:

```text
15 minutes after the latest teammate direct message or private workspace activity
AND 15 minutes after a direct reply reaches terminal state
```

The wider 15-minute default intentionally favors not interrupting an agent private
workspace. The important rule is behavioral: governance notifications should appear after
the private conversation has gone quiet, not merely between two fast turns.

Private workspace activity includes:

- local-user direct messages;
- AI teammate direct replies, including streamed deltas and terminal updates;
- direct reply interventions such as stop or continue;
- private workspace handoff or workspace-preparation activity tied to that thread.

If the gate fails, keep the notification `deliveryStatus: "pending"` and set
`deliverAfter` to the next eligible check time. Do not repeatedly create direct messages.
The scheduler can retry on:

- direct reply terminal state;
- direct thread opened after being idle;
- next notification summary refresh;
- daemon startup recovery.

If the source record resolves before delivery, mark the notification `resolved` and
`deliveryStatus: "suppressed"` with `deliveryBlockedReason: "source_resolved"`.

### Urgency Override

Only `critical` notifications may bypass the normal quiet window, and only when the event
is security, authority, approval, provider, credential, deploy, or external-send related.
Even then, the preferred surface is the authoritative governance or approval surface.
Private chat should receive a short summary only if it helps the user find the blocker.

## Channel UI

Channel governance events should render in the channel header, not the message feed.

Compact header state:

```text
# eng-platform        [Review 3] Memory 1 · Skill 1 · Protocol 1
```

If there are no actionable events, the header should not show a badge. Low-priority
`info` events can be available in the notification drawer but must not create default
pressure.

First Web implementation uses a header popover. The popover is intentionally separate
from both the canonical `conversation_items` timeline and the right-side task/review drawer: it can show review
pressure without rewriting conversation history or stealing the authoritative review
surface. It may support notification-level `seen` and `dismiss` mutations, but those
mutations affect only the notification projection; source memory, skill, protocol, and
playbook records remain authoritative.

Clicking the header entry opens the lightweight channel notification popover:

```text
Channel Review

[Action required] Skill candidate ready
Engineer produced a reusable UI verification flow.
Open Skill Candidate

[Warning] Memory candidate is stale
This channel has a candidate older than the review threshold.
Open Memory Health

[Info] Workflow fan-in created a memory candidate
Open Promotion Inbox
```

The drawer should group by source type:

```text
Action required
  Skill candidates
  Protocol / playbook candidates

Warnings
  Memory health
  Stale review items

Resolved
  Recently handled items
```

The default channel feed remains:

```text
messages
+ AI replies
+ operation cells
+ compact run summaries
+ explicit approval prompts when approval is part of the active work
```

It does not include governance notification rows.

## Teammate Private Chat UI

Single-teammate private events can render as direct chat `system` messages because the
existing direct message model already supports them.

Example:

```text
System
Engineer produced a memory candidate from this private workspace.
Review it in Engineer -> Memory.
```

Rules:

- The message body must be short.
- It must link to the source review surface.
- It must not request an AI reply.
- It must be delivered only after the private quiet-window gate passes.
- It must not include source record bodies when those bodies are private or sensitive.
- It must not include raw transcript text.

For private events, the direct message row is a visibility surface. The memory or skill
candidate remains authoritative.

First daemon implementation uses an internal flush helper rather than a broad background
scheduler. The helper scans pending `teammate_direct` notifications, checks the 15-minute
quiet-window gate, writes at most a short direct `system` message, then marks the
notification `delivered`. If the gate is blocked, the notification remains `pending` with
`deliverAfter` and a blocked reason. The helper runs before governance notification reads
and before teammate direct thread/message reads; direct-message POST does not run it, so a
fresh user message cannot immediately trigger an inserted system notification.

## Ling Agent And Workspace Routing

Ling Agent should receive only events that have no more local owner.

Use Ling Agent for:

- workspace memory health backlog;
- cross-channel candidate clusters;
- cross-channel skill or protocol conflicts;
- authority/security review summaries that need coordination;
- notification digests when channel volume is high.

Do not use Ling Agent for:

- ordinary channel-scoped memory candidates;
- ordinary channel workflow fan-in;
- ordinary channel protocol or playbook candidates;
- teammate-private candidates.

This keeps Ling Agent from becoming a global garbage can.

First implementation delivers Ling Agent-owned governance notifications as one private
chat `system` digest per flush, not one chat row per source record. Workspace-scope
memory candidates route to `surface.kind = "ling_agent"` with `teammateId = "ling_agent"`;
the daemon then writes a bounded digest in Ling Agent's direct thread and marks each
notification `delivered`. Channel and teammate-local events stay on their local surfaces
and are not included in the Ling Agent digest.

## Notification Preferences

First slice can reuse or extend channel notification settings:

```text
All review events
Action required only
Digest only
Muted
```

Suggested mapping:

| Preference | Behavior |
| --- | --- |
| All review events | Header shows `warning`, `action_required`, and `critical`; drawer also lists `info`. |
| Action required only | Header shows `action_required` and `critical`; warnings stay in drawer. |
| Digest only | Header shows one digest row, grouped by day or source type. |
| Muted | No header badge except `critical`; drawer remains accessible. |

Per-channel preferences must not affect teammate private notifications. Teammate private
notification tuning can live in single-agent settings later.

## API Sketch

Read:

```http
GET /governance-notifications?cwd=/path/to/workspace&surface=channel&channelId=channel_...
GET /governance-notifications?cwd=/path/to/workspace&surface=teammate_direct&teammateId=teammate_...
GET /governance-notifications/summary?cwd=/path/to/workspace
```

Mutate notification-only state:

```http
POST /governance-notifications/:id/seen?cwd=/path/to/workspace
POST /governance-notifications/:id/dismiss?cwd=/path/to/workspace
```

Do not expose a public route that lets clients create arbitrary governance notifications
in the first slice. Creation should be daemon-owned and triggered by source governance
state transitions or explicit review jobs.

## Implementation Architecture

Keep the notification pipeline split by responsibility so Web and future PC/Desktop
clients consume the same daemon projection.

```text
source governance records
  -> source adapters
  -> routing resolver
  -> dedupe key builder
  -> notification store
  -> lifecycle resolver
  -> delivery scheduler
  -> surface projections
  -> Web / PC app / CLI clients
```

Module ownership:

```text
packages/contracts
  GovernanceNotification DTOs
  summary/list/mutation response types
  route-like target types

packages/core
  notification core types
  SQLite store facet
  routing resolver
  dedupe key builder
  lifecycle resolver

packages/daemon
  memory source adapter
  skill/procedure source adapters
  notification read APIs
  notification state mutation APIs
  teammate-private delivery scheduler

packages/api-client
  typed list/summary/seen/dismiss helpers

apps/web
  channel header badge
  channel notification drawer
  teammate direct system-message rendering
  route projection for targetRoute

apps/desktop or future PC app
  renderer consumes contracts and API client
  native shell may show OS notifications only from daemon summaries
  notification clicks open targetRoute, never perform review actions
```

The implementation should avoid a direct dependency from Memory, Skill, or Channel UI
modules to a specific client surface. Source adapters emit notification intents; the
routing resolver decides the surface; clients render projections.

### Source Adapter Contract

Each source adapter converts authoritative domain state into a bounded notification
intent.

```ts
interface GovernanceNotificationIntent {
  readonly kind: GovernanceNotificationKind;
  readonly severity: GovernanceNotificationSeverity;
  readonly sourceRefs: readonly GovernanceNotificationSourceRef[];
  readonly preferredSurface?: GovernanceNotification["surface"];
  readonly title: string;
  readonly summary: string;
  readonly targetRoute: GovernanceNotificationRoute;
}
```

Adapters must not:

- read raw transcripts;
- include raw source bodies;
- inspect UI state;
- write direct messages;
- decide Web or PC layout.

### Resolver Contract

The resolver owns stable routing:

```text
intent.sourceRefs
  -> source scope lookup
  -> privacy check
  -> target surface
  -> dedupe key
  -> create/update notification
```

The resolver is the only place that decides whether a source belongs to teammate private
chat, channel header, Ling Agent, or workspace notification. This prevents memory,
skill, and procedure features from reimplementing routing differently.

### Delivery Scheduler Contract

The scheduler owns side effects after the notification row exists:

```text
notification row
  -> channel summary update: immediate projection
  -> teammate direct system message: quiet-window gated delivery
  -> Ling Agent digest: grouped digest delivery
```

Channel and workspace projections should read from the notification store. They should
not require delivery into a chat table.

## PC/Desktop Compatibility

Treat the future PC/Desktop app as a first-class client from the first slice.

Shared rules:

- All public notification shapes live in `packages/contracts`.
- All client calls go through daemon routes and `packages/api-client`.
- `targetRoute` is a structured route object, not a Web URL.
- Renderers must not read SQLite or core stores directly.
- Renderers must not parse memory bodies, transcripts, or logs to infer notification
  state.
- Notification clicks open the relevant route/detail surface only.
- Review actions still call Memory, Skill, Protocol, or Playbook review APIs.
- OS notifications are optional shell projections over daemon summaries; they are not the
  authoritative notification store.

Desktop/PC app can reuse the Web renderer first. A native notification surface can come
later as long as it consumes the same list and summary routes.

Do not build:

- a Desktop-only notification table;
- Desktop-only dedupe logic;
- Desktop renderer access to `packages/core` storage;
- OS notification actions that approve, reject, publish, archive, or dismiss source
  records without opening the daemon-backed review surface.

Compatibility tests once Desktop exists:

- Desktop imports contracts and API client only.
- Desktop renderer cannot access SQLite-backed stores.
- Desktop renders channel and teammate notification summaries from daemon responses.
- Clicking a native notification opens `targetRoute` and performs no review mutation.
- Web and Desktop show the same unresolved counts for the same daemon workspace.

## Implementation Slices

### GN.1 Durable Model And Projection

Files:

```text
packages/contracts/src/*
packages/core/src/*
packages/core/src/storage/sqlite/*
packages/daemon/src/features/*
```

Build:

- shared notification types;
- SQLite table and store facet;
- summary builder grouped by surface, kind, severity, and status;
- source lifecycle resolver that can mark notifications resolved.

Tests:

- create notification idempotently by dedupe key;
- update existing notification on source status change;
- mark resolved when source reaches terminal review state;
- source refs do not duplicate private content.

### GN.2 Teammate Private Delivery

Files:

```text
packages/daemon/src/features/teammates/*
apps/web/src/features/teammates/*
```

Build:

- internal helper to create a direct chat system message from a notification;
- quiet-window scheduler for teammate-private notification delivery;
- route single-teammate memory and skill events to that helper;
- render source deep links in the private chat row.

Tests:

- single-teammate event creates one system message;
- repeated delivery does not duplicate direct messages;
- pending or streaming direct reply defers delivery;
- recent direct message or private workspace activity defers delivery for 15 minutes;
- resolved source suppresses an undelivered notification;
- no AI reply is requested;
- private event is not exposed in channel notification queries.

### GN.3 Channel Header Notifications

Files:

```text
apps/web/src/features/workspace/*
apps/web/src/features/channels/*
apps/web/src/styles/*
packages/api-client/src/*
```

Build:

- channel notification summary API client;
- header badge/summary;
- lightweight drawer or popover;
- deep links to Memory, Skill Library, Protocol, or Playbook review surfaces.

Tests:

- channel event shows in header and drawer;
- channel event does not create a channel message;
- resolved source clears the actionable count;
- narrow and desktop widths do not overflow.

### GN.4 Ling Agent / Workspace Digest

Files:

```text
packages/daemon/src/features/teammates/*
apps/web/src/features/teammates/*
apps/web/src/features/workspace/*
```

Build after GN.1-GN.3 are stable:

- route cross-channel and workspace notifications to Ling Agent or workspace summary;
- digest low-priority events;
- keep critical authority/security events visible without duplicating routine channel
  reminders.
- first implementation uses Ling Agent private `system` digest messages for
  `ling_agent` notifications and keeps source review actions in the authoritative
  review surfaces.

Tests:

- cross-channel event does not appear in every channel;
- Ling Agent receives one digest for grouped events;
- per-channel event remains local to its channel.

## Failure Modes

| Failure mode | Guardrail |
| --- | --- |
| Ling Agent becomes a dumping ground | Route local channel events to channel header, not Ling Agent. |
| Channel feed becomes noisy | Never write ordinary notifications into `conversation_items`. |
| Private chat gets interrupted mid-turn | Gate direct system messages on idle thread and no running reply. |
| Same cluster appears once per agent | Dedupe by cluster id and route to the channel owner. |
| User dismisses reminder and loses work | Dismiss notification only; source governance queue remains authoritative. |
| Private memory leaks into channel | Require source scope check before channel delivery. |
| Notification claims an action happened | Body says "ready for review"; actual state comes from source record. |
| Stale badge remains after review | Source lifecycle resolver marks notification `resolved`. |

## Rollout Order

Recommended order:

```text
1. GN.1 durable notification model and summary projection
2. GN.3 channel header notification surface for existing candidates/findings
3. GN.2 teammate private system messages for single-agent events
4. GN.4 Ling Agent/workspace digest for cross-channel events
```

Channel header comes before Ling Agent digest because it removes the highest-volume event
class from Ling Agent before cross-channel summaries exist.

## Open Decisions

- Should the 15-minute teammate private quiet window be workspace-configurable in the
  first implementation, or hard-coded until usage data exists?
- Should `seen` be per browser profile or persisted per workspace user identity before
  multi-user sync exists?
- Should dismissed notifications reappear when the source record changes from `warning`
  to `action_required`?
- Should Ling Agent digest be implemented as direct chat `system` messages or as a
  future workspace notification center row? Current answer: direct chat `system` digest
  first; workspace notification center can later consume the same daemon projection.
