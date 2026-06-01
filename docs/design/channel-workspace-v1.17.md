# Channel Workspace v1.17 Teammate Dock and Hover Topic Actions

## Status

Implemented in the Web client only. This slice changes channel administration
placement and the topic reply affordance without adding daemon contracts.

## Intent

v1.17 keeps the default channel chat surface quieter while making channel AI teammate
management easier to find. The user should not have to open channel Settings to manage
the channel roster, and ordinary chat rows should not show a reply control until the
row is the active hover or keyboard focus target.

## Interaction Model

The channel header now has a dedicated `AI teammate management` action. Opening it shows
the existing channel teammate card as a standalone dock below the header. Channel
Settings remains responsible for notifications, provider/path/runtime configuration,
and channel creation/editing.

Plain chat and AI reply messages still support `ChannelMessage.threadId` topic replies,
but the message chrome and reply action are no longer always visible. A normal chat row
keeps only the avatar, author, timestamp, and body visible by default. AI teammate
blocked replies follow the same default, revealing their warning-tinted boundary only on
hover or focus. Hovering or focusing that row reveals the lightweight message bubble
boundary plus a compact right-edge action bubble. Hovering or focusing the icon shows the
`Reply in topic` tooltip, and activating it opens the existing topic reply panel.

## Non-Goals

- No new teammate persistence or membership API.
- No server-side notification preference storage.
- No threaded message layout inside the main feed.
- No changes to non-chat event cards or their action rows.

## Validation

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web exec playwright test --grep "channel settings can add remove and set default teammates|channel activity supports mentions, messages, files, links, and task creation|language switcher toggles Chinese and English UI labels"
corepack pnpm --filter @ling-stack/web build
git diff --check
```
