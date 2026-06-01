# Channel Workspace v1.16 Channel Settings Panels

## Status

Planned and implemented as a Web-only slice after v1.15 Helio-Style Chat and Topics.

v1.16 applies the same simplified channel model to channel administration. Instead of
letting teammate membership, notification preferences, and runtime/channel record
settings blend into one form, the Settings surface is split into three explicit cards:
`Members`, `Notifications`, and `Channel management`.

## Goals

- Keep the Chat surface free of teammate and notification management controls.
- Make adding a teammate an explicit select-then-add action.
- Keep channel teammates visible as a compact member list with default/remove actions.
- Add MVP channel notification preferences without changing daemon contracts.
- Keep provider/path/runtime settings available in the same Settings surface.

## Product Behavior

`Members` shows the selected channel roster. Users choose an available workspace
teammate, then click `Add to channel`. Adding a teammate does not make that teammate the
default automatically. Each member row keeps `Set default` and `Remove from channel`
actions.

`Notifications` stores a browser-local channel preference:

- `All activity`
- `Mentions and approvals`
- `Muted`

The preference is scoped by `cwd + channelId` in localStorage and does not mutate daemon
state.

`Channel management` contains the existing persisted channel controls: run provider,
name, execution path, default AI teammate, runtime policy, refresh, and channel
creation.

## Acceptance Criteria

- Opening channel Settings shows separate member, notification, and management cards.
- Selecting a teammate alone does not add it until `Add to channel` is clicked.
- Member default and remove actions keep using existing teammate membership routes.
- Notification level changes persist locally for the selected channel.
- Existing channel create/update/runtime tests keep passing.

## Test Plan

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web exec playwright test --grep "channel settings can add remove and set default teammates|channel runtime policy and default teammate are visible and used when creating channels"
git diff --check
```
