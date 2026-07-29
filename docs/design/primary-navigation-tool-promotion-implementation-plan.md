# Primary Navigation Tool Promotion Implementation Plan

## Status

Partially complete. Plugin Manager and Media Production changes are shipped. Inbox
and Work Board are **pending development** as of 2026-07-29; both left-sidebar
entries are hidden while retained domain code and contextual routes remain intact.

## Goal

Promote Plugin Manager to the global desktop navigation, keep Inbox and Work Board
out of the left sidebar until their product workflows are ready, and preserve backend
behavior.

## Slice 1: View And Page Boundary

- Add `plugins` to `ViewId`, titles, and descriptions.
- Add a lazy `PluginManagerPage` that composes the existing plugin management
  content and receives state/actions from `usePluginsDomain`.
- Refresh plugins when the top-level plugin view becomes active.
- Keep `AppShell.tsx` limited to lazy-page and callback wiring.

## Slice 2: Navigation And Settings Cleanup

- Update the global sidebar order to:
  `Media Production / Plugin Manager / Automations`.
- Hide the Inbox primary-navigation item without deleting Approvals domain, routes,
  or contextual decision flows.
- Hide the Work Board primary-navigation item without deleting its view, domain
  logic, or contextual entry points.
- Remove Work Board and Plugin Manager from Settings section navigation.
- Remove the Settings Work Board embedded view state and render branch.
- Keep retained Inbox and Work Board routes available only to contextual flows and
  focused pending-feature tests.
- Add a focused Settings-section request so Plugin Manager can open MCP tool
  server settings directly.

## Slice 3: Copy And Tests

- Add localized `Media Production` copy.
- Update navigation, Settings, Work Board, plugin, channel, and dark-mode E2E
  assertions.
- Add a source-level regression assertion that Settings does not expose the two
  promoted destinations.

## Verification

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web lint`
- `corepack pnpm --filter @ling-stack/web check:i18n`
- `corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts settings.spec.ts work-board.spec.ts plugins.spec.ts channel.spec.ts dark-mode.spec.ts`
- `git diff --check`
- Real dev-server checks at 1280, 1440, and 1920 desktop widths.

## Hard Stops

- Do not add plugin business logic to `AppShell.tsx`.
- Do not keep hidden duplicate Settings entry points.
- Do not rename backend media or plugin endpoints.
- Do not change Work Board item derivation, claim semantics, or approval behavior.
- Do not expose Inbox as a released primary-navigation workflow.
- Do not treat the retained Work Board prototype as a generally released feature.
- Do not modify unrelated dirty-worktree changes.
