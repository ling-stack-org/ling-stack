# Channel Message Streaming

## Problem

Channel discussion replies currently behave differently from private teammate chat:

- private chat creates a durable pending AI message and streams `delta` events into it;
- channel chat creates a pending AI message, runs completion in the background, then replaces the body only when the runner finishes.

This makes channel Ling Agent replies feel like a batch job instead of a GPT/Codex-style live conversation.

## Product Behavior

Sending a channel message from the composer should start a normal Ling Agent channel turn and show the assistant reply as it is generated. The user should not need to select a special route, workflow, selector, or debug mode. The channel remains durable: refreshing the page during generation should show the latest persisted partial AI message.

The existing JSON `POST /channels/:id/messages` remains supported for API compatibility. The Web app should prefer the streaming endpoint for composer sends.

Streaming changes only the transport and UI cadence; it must not make the reply
stateless. The daemon should build the same Ling Agent reply context for streamed and
non-streamed sends, including bounded recent same-channel history before the latest turn.
Short follow-ups such as `400字`, `继续`, or `改短点` should therefore continue the
visible prior topic instead of being treated as isolated new prompts.

While a pending AI reply has no visible text yet, the Web feed should show a
generic `Thinking...` status with a spinner. As soon as `delta.body` is non-empty,
the same bubble must render that body instead of a generic pending label.

If the channel feed is already pinned to the latest item, streamed `delta.body`
updates must keep the feed pinned to the bottom as the same message grows. If
the user has intentionally scrolled upward to read history, streaming updates
must not steal focus; the existing jump-to-latest affordance remains the recovery
path.

## HTTP Contract

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
| `delta` | `{ messageId, delta, body }` | A visible text delta was appended to the durable AI message. `body` is the full visible body so far. |
| `done` | `{ message, aiReply?, aiReplies?, autoStartedWorkflow? }` | The channel turn reached its terminal persisted state. |
| `blocked` | `{ message, aiReply?, aiReplies?, error? }` | The reply could not continue because of provider, teammate, or runtime blocking. |
| `error` | `{ message?, aiReply?, aiReplies?, error }` | The stream itself failed after the request started. Persisted messages, if any, are included. |

## Persistence And Reconnect

`delta` updates the same `ChannelMessage` row with `status: "pending"`. `done` updates the same row to `ready`, `blocked`, or `failed`. The browser stream is only a live transport; the SQLite channel message store remains the source of truth.

If the browser disconnects, the daemon should stop writing to that client but should not treat the disconnect as user cancellation for channel replies. Explicit cancellation remains a separate runtime control concern.

## Hidden Proposal Safety

Channel replies may contain hidden `<ling_task_proposal>...</ling_task_proposal>` blocks. Streaming must never reveal those blocks in the visible chat body. The daemon streams only the visible prefix before any hidden proposal block and finalizes the hidden proposal through the existing `extractChannelExecutionProposal` path.

## Multi-Reply Behavior

When a channel turn intentionally creates multiple AI replies, the stream may emit multiple `ready` events and `delta` events tagged by `messageId`. Clients should upsert by id instead of assuming a single assistant bubble.

## Acceptance

- `POST /channels/:id/messages/stream` streams `ready -> delta -> done` for a normal Ling Agent reply.
- The visible AI message body updates during generation and is persisted through `GET /channels/:id/messages`.
- Hidden proposal blocks are not present in any streamed `delta` body.
- Existing non-streaming `POST /channels/:id/messages` continues to work.
- The Web composer consumes the stream and updates the existing message bubble rather than inserting duplicate assistant messages.
- Pending AI bubbles show `Thinking...` only before visible body text exists; they do not hide streamed body text behind a static pending label.
- While pinned to latest, long streamed AI replies keep the message feed at the bottom without requiring manual scrolling.
- Streamed and non-streamed channel replies include recent conversation context, while excluding the current pending assistant placeholder.
