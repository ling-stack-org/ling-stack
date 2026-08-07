# Channel Message Streaming

## Problem

Channel discussion replies currently behave differently from private teammate chat:

- private chat creates a durable pending AI message and streams `delta` events into it;
- channel chat creates a pending AI message, runs completion in the background, then replaces the body only when the runner finishes.

This makes channel Ling Agent replies feel like a batch job instead of a GPT/Codex-style live conversation.

## Product Behavior

Sending a channel message from the composer should start a normal Ling Agent channel turn and show the assistant reply as it is generated. The user should not need to select a special route, workflow, selector, or debug mode. The channel remains durable: refreshing the page during generation should show the latest persisted partial AI message.

The existing JSON `POST /channels/:id/messages` remains supported for API compatibility. The Web app should prefer the streaming endpoint for composer sends.

The current message-body stream is a compatibility transport. The target product stream
is a shared semantic transcript stream that can be consumed by Web, Desktop, Mobile
through its constrained Gateway, and CLI/TUI-style clients:

```text
daemon/core channel records and run events
  -> ConversationTranscript snapshot
  -> transcript delta stream
  -> Web renderer / Desktop renderer / CLI renderer
```

Clients may render the same transcript differently, but they should not re-run intent
routing, workflow/run grouping, active-cell lifecycle, or message-body phrase detection.
That interpretation belongs in the daemon/core projection layer and the shared contracts.

Streaming changes only the transport and UI cadence; it must not make the reply
stateless. The daemon should build the same Ling Agent layered channel context for
streamed and non-streamed sends: current turn envelope, channel state, effective protocol,
bounded recent visible conversation, compacted channel context, active work state when
relevant, materialized inputs, and scoped memory recall. Short follow-ups such as `400字`,
`继续`, or `改短点` should therefore continue the visible prior topic instead of being
treated as isolated new prompts.

That context is owned by the [Channel Context Processing Layer](channel-context-processing-layer.md),
not by the streaming transport. SSE only delivers the visible body updates for the same
durable Ling Agent turn.

Transcript projection is owned by the shared conversation contract described in
[Contracts and API Client](contracts-api-client.md), not by the Web component tree. Web can
host the first implementation while the visual design stabilizes, but the contract must be
portable to Desktop and CLI before the projection becomes a permanent API.

While a pending AI reply has no visible text yet, the Web feed should show a
generic `Thinking...` status with a spinner. As soon as `delta.body` is non-empty,
the same bubble must render that body instead of a generic pending label.
The initial optimistic row remains visible after user-message acknowledgement only while
dispatch is unresolved. The daemon emits `reply_pending` before slow routing work only for a
message that owns an idle channel lane. If an active reply exists, the terminal stream event
returns `followup_queued`; Web removes the optimistic transcript row and projects the durable
intervention in the guidance queue instead.

If the channel feed is already pinned to the latest item, streamed `delta.body`
updates must keep the feed pinned to the bottom as the same message grows. If
the user has intentionally scrolled upward to read history, streaming updates
must not steal focus; the existing jump-to-latest affordance remains the recovery
path.

## HTTP Contract

### Compatibility: Message Body Stream

```http
POST /channels/:id/messages/stream?cwd=/path/to/project
Accept: text/event-stream
Content-Type: application/json
```

The request body is the same as `POST /channels/:id/messages`.

SSE events:

| Event | Payload | Semantics |
| --- | --- | --- |
| `ready` | `{ message, aiReply?, aiReplies? }` | The local user message and one or more pending durable AI messages now exist. |
| `reply_pending` | `{ sourceMessageId, targetTeammateId, startedAt }` | The accepted message owns the idle channel lane and is preparing a reply. Queued follow-ups do not emit it. This is not a Run or persistence object. |
| `run_linked` | `{ messageId, linkedRunId, activeReply? }` | The durable pending AI message is linked to its real Run and supervising WorkUnit. |
| `delta` | `{ messageId, delta, body }` | A visible text delta was appended to the durable AI message. `body` is the full visible body so far. |
| `done` | `{ message, aiReply?, aiReplies?, replyDispatch?, autoStartedWorkflow? }` | The channel turn reached its persisted dispatch state. `followup_queued` keeps the message out of the transcript until continuation start. |
| `blocked` | `{ message, aiReply?, aiReplies?, error? }` | The reply could not continue because of provider, teammate, or runtime blocking. |
| `error` | `{ message?, aiReply?, aiReplies?, error }` | The stream itself failed after the request started. Persisted messages, if any, are included. |

### Target: Transcript Snapshot And Delta Stream

The target API should expose transcript state as a durable read model:

```http
GET /channels/:id/transcript?cwd=/path/to/project
Accept: application/json
```

Suggested response:

```ts
interface ChannelConversationTranscriptResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly transcript: ConversationTranscript;
  readonly sequence: number;
}
```

The live stream can be a separate endpoint or an extension of the existing send stream.
The important part is the event model:

| Event | Payload | Semantics |
| --- | --- | --- |
| `transcript_snapshot` | `{ transcript, sequence }` | Full current transcript for initial load or reconnect. |
| `turn_started` | `{ turnId, sequence }` | A user turn now owns a transcript container. |
| `block_started` | `{ turnId, block, sequence }` | A semantic block exists, for example coordinator text, operation cell, command row, approval, or agent span. |
| `block_delta` | `{ turnId, blockId, patch, sequence }` | The same block mutates in place. Text deltas, stdout chunks, status changes, and evidence growth update the existing block. |
| `block_completed` | `{ turnId, blockId, status, patch?, sequence }` | The block is terminal and should remain as a committed transcript block. |
| `turn_completed` | `{ turnId, status, sequence }` | The turn is terminal. Active popovers should clear unless another active turn exists. |
| `error` | `{ error, sequence? }` | The stream failed. Persisted transcript state remains the source of truth. |

This mirrors the useful part of Codex's `Thread / Turn / Item` model without copying its
JSON-RPC app-server wholesale. Ling's names can remain `ConversationTranscript`,
`ConversationTurn`, and `TranscriptBlock`.

## Persistence And Reconnect

`delta` updates the same `ChannelMessage` row with `status: "pending"`. `done` updates the same row to `ready`, `blocked`, or `failed`. The browser stream is only a live transport; the SQLite channel message store remains the source of truth.

The constrained mobile surface uses the same semantic transcript model through the
Remote Gateway described in [Ling Mobile Remote Access](mobile-remote-access.md). It does
not receive the broad channel SSE route or pass `cwd`. The Gateway maps an opaque approved
workspace id to the local store, projects a redacted snapshot/delta stream, and keeps the
daemon as the only state authority.

Remote text sends carry a durable `(gatewayId, deviceEpoch, commandId)` receipt. The receipt,
the local-user channel message, and a bounded Mobile dispatch intent are committed in one
daemon transaction before asynchronous conversational reply work starts. A reconnect that
retries the same command therefore returns the original message result instead of creating
a duplicate message or duplicate visible reply. A different request body with the same
command id is an explicit idempotency conflict.

If the browser disconnects, the daemon should stop writing to that client but should not treat the disconnect as user cancellation for channel replies. Explicit cancellation remains a separate runtime control concern.

The same rule applies to Mobile: a phone network drop never cancels a PC run or changes its
state. The phone re-authenticates, resumes from its last acknowledged remote sequence, and
requests a fresh snapshot when the cursor is too old. Mobile V0 has no offline mutation
queue, so an unsent draft is local UI state rather than an eventually replayed command.

For transcript streaming, the daemon persists the underlying channel/run/workflow records
and rebuilds the transcript snapshot from those records. The transcript stream itself is
not the source of truth. Reconnect should request a snapshot at or after the last observed
sequence and then continue with deltas. If delta replay is unavailable, clients must
replace their local transcript with the latest snapshot.

## Hidden Proposal Safety

Channel replies may contain hidden `<ling_task_proposal>...</ling_task_proposal>` blocks. Streaming must never reveal those blocks in the visible chat body. The daemon streams only the visible prefix before any hidden proposal block and finalizes the hidden proposal through the existing `extractChannelExecutionProposal` path.

## Multi-Reply Behavior

When a channel turn intentionally creates multiple AI replies, the stream may emit multiple `ready` events and `delta` events tagged by `messageId`. Clients should upsert by id instead of assuming a single assistant bubble.

## Collaboration Stream Folding

For multi-agent collaboration, streaming is still a live transport, not permanent process
spam and not a collaboration-card-specific model.

Default rules:

- requirement shaping streams update the same shaping card until Ling Agent posts a
  compact summary or asks a clarifying question;
- execution step streams update the active `OperationCell` or `AgentActivitySpan` row;
- when a step reaches terminal state, the same row changes status and remains folded in
  the transcript;
- parallel branch streams expose one latest-action row per active agent, with prior
  semantic actions folded under that agent span;
- raw runtime stream events stay in evidence/details, not the default feed.

See
[Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)
for the current product-level transcript behavior.

## Acceptance

- `POST /channels/:id/messages/stream` streams `ready -> reply_pending -> ready -> run_linked -> delta -> done` for a normal Ling Agent reply.
- `reply_pending.targetTeammateId`, the pending AI message author, WorkUnit, Run, and daemon
  dispatch lane use the same canonical identity; no mention is `ling_agent`.
- The visible AI message body updates during generation and is persisted through `GET /channels/:id/messages`.
- Hidden proposal blocks are not present in any streamed `delta` body.
- Existing non-streaming `POST /channels/:id/messages` continues to work.
- The Web composer consumes the stream and updates the existing message bubble rather than inserting duplicate assistant messages.
- Pending AI bubbles show `Thinking...` only before visible body text exists; they do not hide streamed body text behind a static pending label.
- While pinned to latest, long streamed AI replies keep the message feed at the bottom without requiring manual scrolling.
- Streamed and non-streamed channel replies include the same layered channel context, while excluding the current pending assistant placeholder.
- Multi-agent collaboration streams fold into task/step summaries after terminal state
  instead of leaving raw process streams in the default feed.
- Future transcript streams expose turn/block lifecycle events where running blocks mutate
  in place and terminal blocks commit without being deleted.
- Web and Desktop consume the same transcript snapshot/delta contract. CLI may render the
  same model as text or TUI, but it does not own the conversation projection.
- Mobile consumes the same semantic snapshot/delta contract through an authenticated
  Remote Gateway; it never receives arbitrary daemon routes, local paths, raw tool output,
  or artifact bytes.
- Repeating a Mobile `commandId` after a disconnect creates one and only one durable local
  user message.
