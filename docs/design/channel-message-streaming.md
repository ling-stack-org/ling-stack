# Channel Turn Streaming

Status: active Continuity v2 transport contract
Updated: 2026-08-10

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
- retrying an accepted turn with the same idempotency key returns the existing item;
- committed corrections create superseding items rather than mutating history.

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
