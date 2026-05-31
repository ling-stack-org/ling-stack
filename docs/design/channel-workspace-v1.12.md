# Channel Workspace v1.12 Teammate Management

## Status

Planned and implemented as a Web-only slice after v1.11 Surface Simplification.

v1.12 makes channel teammate membership explicit. A channel starts with no required AI
teammates; users add workspace teammates to a channel and optionally choose one default
teammate.

## Goals

- Let a channel show which AI teammates belong to it.
- Let the user add and remove existing workspace teammates from the selected channel.
- Let the user set the selected channel's default teammate from the channel membership
  list.
- Keep removal scoped to membership only; removing a teammate from a channel does not
  delete the durable teammate or erase historical work.
- Keep the simplified v1.11 Activity surface intact by placing teammate management behind
  channel Settings instead of a permanent inspector.

## Non-Goals

- No new daemon routes or SQLite schema.
- No deletion of AI teammate entities from the channel surface.
- No permissions matrix, online presence, notification settings, or human organization
  membership.
- No automatic multi-agent orchestration.

## Product Behavior

Channel Settings includes a `Channel teammates` section above operational channel
settings.

The section shows:

- current channel teammate rows,
- each teammate's display name and model label,
- the channel default marker when the teammate is default,
- `Set default`,
- `Remove from channel`,
- an add control for workspace teammates not yet in the channel,
- a shortcut to the AI Teammates page when no workspace teammates exist or more setup is
  needed.

Adding a teammate joins the teammate to the selected channel but does not automatically
make that teammate the channel default. The user chooses the default explicitly.

Setting a default updates the selected channel's `defaultTeammateId` through the existing
teammate channel membership route.

Removing a teammate from a channel removes only that membership. If the removed teammate
was the channel default, the default teammate is cleared by the existing daemon behavior.

Composer mention options prioritize teammates already in the selected channel, then show
other mentionable teammates.

## Data Boundary

v1.12 reuses:

- `GET /teammates/:id/channels`,
- `PUT /teammates/:id/channels`,
- `Channel.defaultTeammateId`.

The Web client loads teammate memberships for the current workspace roster and derives the
selected channel roster locally. No channel-level membership endpoint is added in this
slice.

## Acceptance Criteria

- A channel can render with no teammate members and no default teammate.
- Channel Settings can add a workspace teammate to the selected channel.
- Channel Settings can set any channel member as the default teammate.
- Channel Settings can remove a teammate from the selected channel without deleting the
  teammate from the workspace roster.
- The header default teammate chip updates after setting or clearing the channel default.
- The Activity layout and bottom composer behavior from v1.11 remain unchanged.

## Test Plan

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web exec playwright test --grep "channel settings can add remove and set default teammates|channel activity keeps the composer visible while the message feed scrolls|language switcher toggles Chinese and English UI labels|theme switcher supports system, light, and dark preferences"
git diff --check
```

Rendered QA:

- desktop viewport: open channel Settings, verify empty channel teammates state, add a
  teammate, set default, remove a teammate,
- mobile viewport: Settings remains readable and teammate rows do not overflow,
- console: no relevant errors or warnings.
