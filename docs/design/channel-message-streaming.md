# Channel Turn Streaming

Status: active Continuity v2 transport contract; deterministic reconnect and fresh
packaged SSE reconnect acceptance are green
Updated: 2026-08-25

Related docs:

- [Channel Conversation Continuity v2](channel-conversation-continuity-v2.md)
- [Conversation Surface Contract](conversation-surface-contract.md)
- [Ling Agent Session Control Plane](ling-agent-session.md)

## Purpose

Channel streaming is a live transport over the canonical conversation timeline. It does
not own history, intent, lineage, or recovery.

```text
LingThread
  -> LingTurn
     -> ConversationItem user/assistant/action/result rows
        -> item/turn API response
           -> SSE projection
              -> Web presentation
```

`conversation_items` is the only Channel timeline authority. The browser may optimistically
render a pending send, but it must replace that state from daemon item/turn responses and may
discard all local projections on refresh.

## HTTP Contract

### Read items

```http
GET /channels/:channelId/items?cwd=/path&limit=200&beforeSequence=123
GET /channels/:channelId/items?cwd=/path&threadId=thread_...
GET /channels/:channelId/items?cwd=/path&anchorItemId=item_...
```

- no selector selects the Channel Root;
- `threadId` is always a canonical `LingThread.id`;
- `anchorItemId` materializes or reuses the Topic anchored at that committed item;
- sending both selectors is a `400 bad_request`;
- pagination uses the stable per-Thread `sequence` cursor.

### Create a turn

```http
POST /channels/:channelId/turns?cwd=/path
POST /channels/:channelId/turns/stream?cwd=/path
```

The JSON and streaming routes accept the same request body:

```ts
type ChannelConversationSurface =
  | { kind: "channel_root" }
  | { kind: "thread"; threadId: string }
  | { kind: "topic"; anchorItemId: string };

interface CreateChannelTurnRequest {
  readonly idempotencyKey?: string;
  readonly surface?: ChannelConversationSurface;
  readonly contextSegmentId?: string;
  readonly body: string;
  readonly mentions?: readonly ChannelMention[];
  readonly attachmentIds?: readonly string[];
  readonly linkPreviewIds?: readonly string[];
  readonly fileRefs?: readonly ChannelMessageFileRef[];
  readonly requestAiReply?: boolean;
  readonly replyDisposition?: {
    readonly mode: "queue_followup";
    readonly activeRunId?: string;
  };
  readonly providerPresetId?: string;
  readonly teammateId?: string;
}
```

Omitted `surface` and `{ kind: "channel_root" }` both select the Channel Root. There is
no top-level `threadId` compatibility alias. Topic clients use `anchorItemId` only for the
initial lookup/materialization; later reads and sends use the returned canonical Thread id.

## SSE Events

| Event | Payload | Meaning |
| --- | --- | --- |
| `ready` | `{ thread, turn, userItem, assistantItems?, decorations }` | The accepted user item and any current assistant items are durable. |
| `reply_pending` | `{ sourceItemId, targetTeammateId, startedAt }` | The turn owns an idle reply lane and routing is in progress. |
| `run_linked` | `{ itemId, linkedRunId, activeReply? }` | An assistant item is linked to its supervised Run. |
| `delta` | `{ itemId, delta, body }` | The same pending assistant item gained visible text. |
| `done` | `ChannelConversationTurnResponse` | Dispatch reached its durable terminal state. |
| `blocked` | `ChannelConversationTurnResponse & { error? }` | Provider, teammate, policy, or runtime blocked the reply. |
| `error` | partial turn response plus `error` | Transport or reply processing failed after acceptance. |

Clients upsert by `ConversationItem.id`. They never create a second assistant row merely
because `ready`, `run_linked`, `delta`, and `done` arrive separately.

## Persistence And Reconnect

- the user item and owning `LingTurn` are created atomically;
- a streaming assistant item remains `pending` and is updated in place until committed,
  blocked, or failed;
- disconnecting a browser stops writes to that socket but does not cancel the Run;
- refresh reconstructs the feed from Items, Turns, and discardable decorations;
- control-plane reconnect resumes from the last applied durable sequence. If the server
  cannot prove a complete bounded replay from that cursor, it returns
  `control_plane_snapshot_required`; the client performs an authoritative snapshot
  handoff and does not acknowledge unseen events. The handoff reads sequence `S`, starts
  a provisional live subscription after `S` while buffering, refreshes canonical state
  through `S`, then advances the applied cursor and drains later events. Domain filters
  and other workspaces may create legal numeric sequence gaps; a per-workspace durable
  replay-state floor/latest watermark and the captured replay bound decide completeness.
  The watermark survives an empty event table; future event deletion must advance its
  floor atomically;
- retrying an accepted turn with the same idempotency key returns the existing item;
- committed corrections create superseding items rather than mutating history.

SSE and local RPC share this replay evaluator and provisional lifecycle. A provisional
subscriber may buffer live events but cannot flush events or heartbeats. On complete
replay, the server emits the replay-ready boundary and then activates live delivery. On
snapshot-required or setup failure, it unregisters before closing. RPC must send the
typed subscribe result before replay/live notifications; a snapshot-required result
contains no `subscriptionId`.

The mounted client keeps two sequence watermarks:

```ts
interface ControlPlaneCursorState {
  readonly lastReceivedSeq: number;
  readonly lastAppliedSeq: number;
}
```

`lastReceivedSeq` is an in-memory transport diagnostic. It may move as bytes/events arrive
and may be reset when a provisional connection is abandoned. `lastAppliedSeq` is the
durable reconnect cursor and advances only after every canonical refresh triggered by the
event batch succeeds. A refresh failure therefore reconnects from the previous applied
sequence and receives the event again; it never acknowledges work the UI failed to
project.

Status vocabulary is scoped rather than globally interchangeable:

| Status | Owner | Meaning |
| --- | --- | --- |
| stream `ready` | Channel turn transport | accepted Item/Turn and current projection are durable |
| assistant delivery `ready` | `ConversationItem` payload | text is committed and renderable |
| Run `succeeded` | runner attempt | the process ended successfully; evidence still needs validation |
| workflow `succeeded` | Completion Evaluation | all required participant/evidence/fan-in rules passed |

Only the last row is workflow success. No transport or delivery status can substitute for
typed delegated evidence.

```text
event seq=N received
  -> lastReceivedSeq=N
  -> coalesce domains
  -> refresh canonical Channel/runtime projections
       success -> lastAppliedSeq=N
       failure -> keep lastAppliedSeq; close/retry from previous cursor
```

When bounded replay cannot prove completeness, snapshot handoff uses a barrier rather
than “refresh, then subscribe”:

```text
read snapshot sequence S
  -> establish provisional live subscription for > S
  -> buffer arriving events
  -> refresh canonical state covering <= S
       failure -> close provisional subscription; keep old applied cursor
       success -> set lastAppliedSeq=S; drain buffered events in sequence
```

The server owns replay completeness because it owns the retention floor and captured
upper bound. It queries through that bound with `limit + 1` and returns either an explicit
complete replay window or `control_plane_snapshot_required`; the client never treats a
fixed page size, numeric sequence contiguity, or an empty filtered page as proof that the
range is complete. A complete filtered-empty window advances through the proven upper
bound only after the replay-ready boundary; the client does not substitute the last
matching row. Neither replay nor snapshot handoff resubmits an accepted Turn or
restarts a Run/workflow.

## Reply Supervision

Root, Topic, and Branch Threads have independent reply lanes. The Web sends
`queue_followup` only for the active reply projected on the same canonical Thread. The
daemon validates `activeRunId`; stale, terminal, cross-channel, and cross-line targets
fall back to normal intent selection.

Queued guidance stays out of the transcript until its intervention starts. During the
persistence-to-classification gap, the daemon fence prevents a background refresh from
briefly exposing and retracting that guidance row.

## Safety

- hidden proposal markup and hidden reasoning never enter `delta.body`;
- raw prompts, secrets, and teammate-private memory never enter public decorations;
- streaming cannot grant tools, approvals, workspace scope, or external-send authority;
- `requestAiReply` and mentions are responder hints, not execution permission;
- intent remains `reply`, `clarify`, `workflow_proposal`, `execute`, or `no_reply` under
  the Continuity v2 contract.

## Acceptance

- normal replies emit `ready -> reply_pending -> ready -> run_linked -> delta -> done`;
- Topic initial reads use `anchorItemId`, then all later operations use canonical
  `threadId`;
- refresh during generation restores the same pending assistant item;
- pinned feeds follow growing text while manually scrolled feeds do not steal focus;
- Root, Topic, and Branch messages never capture another line's active reply;
- hidden proposal blocks do not appear in streamed text;
- the JSON and SSE routes produce the same durable Turn and Item lineage;
- no `/channels/:id/messages` compatibility route or message-store authority remains.
