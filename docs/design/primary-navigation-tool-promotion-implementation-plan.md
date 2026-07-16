# Primary Navigation Tool Promotion Implementation Plan

## Goal

Promote Work Board and Plugin Manager to the global desktop navigation, remove
their Settings-owned routes, and rename the media navigation entry without
changing backend behavior.

## Slice 1: View And Page Boundary

- Add `plugins` to `ViewId`, titles, and descriptions.
- Add a lazy `PluginManagerPage` that composes the existing plugin management
  content and receives state/actions from `usePluginsDomain`.
- Refresh plugins when the top-level plugin view becomes active.
- Keep `AppShell.tsx` limited to lazy-page and callback wiring.

## Slice 2: Navigation And Settings Cleanup

- Update the global sidebar order to:
  `Inbox / Media Production / Work Board / Plugin Manager / Automations`.
- Remove Work Board and Plugin Manager from Settings section navigation.
- Remove the Settings Work Board embedded view state and render branch.
- Route Inbox Work Board actions to the top-level Work Board while preserving
  the requested scope.
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
- Do not modify unrelated dirty-worktree changes.
