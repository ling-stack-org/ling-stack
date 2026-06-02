# Channel Workspace v1.22 Long Conversation Virtual Feed

## Status

Implemented across daemon contracts, SQLite storage, and the Web channel chat surface.
This slice keeps channel history durable while making long conversations cheap to view.

## Intent

Channel chat should scale like a long-running working thread. History remains persisted
in `.ling-stack/ling-stack.sqlite`, but the Web page should not render every historical
message into the DOM. Entering a channel shows the latest conversation, scrolling upward
loads earlier history, and ordinary chat scrolling remains smooth with thousands of
loaded messages.

## Message History Contract

`GET /channels/:id/messages` supports cursor pagination:

- `limit` defaults to `200` and is clamped to the existing daemon hard limit of `500`,
- `beforeMessageId` loads messages older than the referenced message,
- `threadId` continues to scope topic replies,
- responses include `messages`, `hasMore`, and `nextBeforeMessageId`.

The store reads newest-first internally with `limit + 1`, then returns messages in
chronological order for display. Same-timestamp messages use SQLite row order as the
stable tie-breaker. Invalid cursors return a bad-request response instead of silently
showing an empty page.

## Web Feed Behavior

The Activity chat feed uses a virtual list:

- first channel load requests the latest `200` messages,
- reaching the top loader row requests `100` older messages,
- older pages are prepended with id-based deduplication,
- the visible scroll position is restored after prepending so the conversation does not
  jump,
- when pinned to the latest item, new messages keep the feed at the bottom,
- when the user is reading history, new messages do not steal focus and the existing
  floating down-arrow returns to the latest conversation item.

The virtualizer runs over the merged visible activity feed, so ordinary chat, execution
proposal cards, context summaries, and audit/event cards share the same rendering budget.
Search and activity filters do not auto-load older pages; they operate over the currently
loaded history to avoid unexpected jumps while filtering.

## Validation

The long-history regression suite should cover:

- latest `200` messages are returned by default and displayed in chronological order,
- cursor pagination loads earlier messages without duplicates,
- same-timestamp messages keep stable order across pages,
- invalid cursors return a bad request,
- a 3000-message channel renders only the visible virtual rows,
- jumping to latest and loading older history preserve the expected scroll behavior.

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web test:e2e
git diff --check
```
