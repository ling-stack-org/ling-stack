# Channel Workspace v1.13 Smart Composer

## Status

Planned and implemented as a Web-only slice after v1.12 Teammate Management.

v1.13 removes the expanded composer tools panel from the default channel workflow. The
composer now treats mentions, files, and links as inline input behavior instead of
secondary controls.

## Goals

- Keep the Activity message area larger by removing the permanent `More` tool path.
- Let users type `@` in the composer and choose an AI teammate from inline suggestions.
- Let dropped or pasted files attach directly to the pending message.
- Let URLs pasted into the message body create link previews automatically before send.
- Keep pending mentions, attachments, link previews, upload state, blocked URLs, and retry
  state visible.

## Non-Goals

- No new daemon routes, file formats, or SQLite schema.
- No rich slash command framework.
- No AI ingestion of files or webpages by default.
- No browser/scraper worker for link inspection; previews remain daemon metadata fetches.

## Product Behavior

The channel composer keeps only the mode switcher, the textarea, a compact file icon, and
the send/create button visible.

Typing `@` opens a small suggestion popover above the textarea. Selecting a teammate
inserts `@Name` into the text and adds a pending mention chip. Discussion messages request
an AI reply only when an AI teammate is selected as a mention.

Dropping files onto the textarea, pasting files from the clipboard, or using the compact
file icon all call the existing attachment upload path. The pending attachment chip stays
visible until sent or removed.

Pasting a URL into the message body schedules an automatic link preview. Ready, blocked,
and failed preview states appear in the pending asset row. Send remains disabled while an
attachment or link preview is still uploading.

The old explicit `Paste URL`, `Preview link`, `Ask AI`, media-provider notice, and
allowed-tool token controls are not part of the Activity composer path. Operational
provider/tool details remain available in channel Settings and task creation surfaces.

## Data Boundary

v1.13 reuses the existing client and daemon contracts:

- `POST /channels/:id/attachments`,
- `POST /channels/:id/link-previews`,
- `POST /channels/:id/messages`,
- `mentions`, `attachmentIds`, `linkPreviewIds`, and `requestAiReply` message fields.

No backend behavior changes are required. The client only changes when those existing
calls are triggered.

## Acceptance Criteria

- The Activity composer no longer shows a `More` or `Hide options` control.
- Typing `@` opens teammate suggestions without leaving the textarea.
- Selecting a teammate inserts the mention and shows a removable pending mention chip.
- Dragging and dropping a file onto the composer uploads it through the channel attachment
  path and shows a pending attachment chip.
- Pasting a URL into the message body creates a pending link preview without pressing a
  separate Preview action.
- Blocked private-network URLs remain visible as blocked preview chips and do not navigate
  away from Activity.
- Existing failed-send retry behavior still preserves the draft.

## Test Plan

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web exec playwright test --grep "channel activity supports mentions, messages, files, links, and task creation|channel URL preview blocked state stays in Activity and still allows sending text|channel activity derives timeline details without leaking other channels"
git diff --check
```

Rendered QA:

- desktop viewport: type `@`, select a teammate, paste a URL, drop a file, and send,
- mobile viewport: verify the composer remains attached to the bottom and suggestion
  popover does not obscure the send controls,
- console: no relevant errors or warnings.
