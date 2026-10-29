# Conversation Position Navigation

Status: implementation; runtime acceptance tracked in the pull request
Owner: Web conversation surfaces (also reused by Desktop)
Last verified: 2026-10-29 (implementation contract; runtime acceptance is separate)

## Product contract

Ordinary conversations, channels and teammate private chats share one quiet navigation
rail at the edge of the message viewport. User and assistant messages with text or
source references have markers. Hover or keyboard focus shows the actual sender's
avatar, name and a bounded text
excerpt. Users use their profile; Ling Agent uses its built-in identity; teammate
messages use that teammate's identity. Identity in the main transcript continues to
follow the [surface contract](conversation-surface-contract.md).

The interaction follows OpenClaw's
[ChatPositionRail](https://github.com/openclaw/openclaw/blob/70beb83502dfedfbc9b695cb92e185fcb2534b78/ui/src/styles/chat/message-layout.css):
12px marker pitch, 8px resting ticks, 12/16/24/32px hover-neighbor widths, 100ms ease
for ticks and 240ms ease-out for rail appearance. Ling supplies its theme colors,
avatar components, type, rounding and elevation. Reduced-motion disables transitions
and destination highlighting. Forced-colors retains marker and preview visibility.

The rail appears when at least two markers exist, the loaded transcript overflows,
the viewport is at least 360px high and its frame at least 560px wide. It occupies at
most 45% of the feed height. Long rails scroll independently and render a bounded
marker window. Small panes and
short conversations use the ordinary transcript scroll controls.

## Ownership and navigation

- The index is rebuilt from the owning surface's already-scoped `TimelineSnapshot`.
  No new persistence, model calls, backend endpoint or second history store is added.
- Message segments share a logical marker and retain their locator IDs. Tools,
  reasoning and synthetic waiting placeholders do not become preview messages.
- Preview text is rendered as plain text, capped at 140 Unicode code points of message
  text with an ellipsis appended when truncated. Links and HTML remain inert. The
  navigation does not expose hidden/private context.
- `mountConversationTimeline` composes the shared rail; surface adapters supply the
  sender identity and existing cancel-follow/locate callback.
- Clicking or pressing Enter uses `ConversationTimelineItemLocator` to mount the
  destination through the existing virtualizer, focuses it and highlights it briefly.
  Reading position ownership is handed back to the surface after the jump.
- Arrow keys, Home and End move a single roving tab stop; Escape dismisses the
  preview and returns focus to the transcript. Preview cards are noninteractive.
- The index covers loaded history. Channel pagination remains owned by the channel
  feed; loading older messages adds their markers without creating a second loader.
- A conversation/scope change retires pending navigation and preview state.

Bookmarks are outside this first slice. Main transcript identity, approvals, execution
state and context-compaction behavior remain owned by their existing contracts.

## Verification

`apps/web/test/conversation-position-markers.test.mjs` covers message membership,
segmented identity, exclusions and Unicode-safe excerpts. The navigation Playwright
suite covers motion, identity, virtual-history jumps, reading stability, keyboard
access, scope changes, narrow panes, reduced motion and Light/Dark screenshots.

Related: [performance and virtualization](conversation-performance-deferral-and-virtualization.md).
