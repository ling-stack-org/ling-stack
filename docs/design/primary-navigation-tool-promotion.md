# Primary Navigation Tool Promotion

## Status

Partially shipped. Plugin Manager and Media Production remain in primary navigation.
Inbox and Work Board are pending product capabilities; both primary-navigation
entries are hidden as of 2026-07-29. Their retained implementations stay available
only to contextual flows and focused development tests.

## Summary

Ling promotes `Plugin Manager` from Settings into the global desktop navigation.
Work Board is not currently a primary workflow and remains a pending product
capability. Existing code, data derivation, and contextual entry points are retained
without advertising it in the left sidebar.

The media entry is renamed from `Image Generation` to `Media Production` so the
navigation truthfully covers both image and video jobs.

This current-release decision supersedes the earlier Work Board promotion portion of
this document. Plugin Manager promotion remains effective.

## Target Navigation

```text
Primary navigation
  Media Production
  Plugin Manager
  Automations
```

Settings continues to contain configuration and maintenance surfaces such as
models, AI teammates, councils, authorization, external connections, MCP servers,
skills, archives, and diagnostics.

## Product Semantics

### Work Board

**Pending development.** Work Board is intended to become the global work ledger for
actionable work, blocked items, ownership, runs, approvals, and related channel
activity. Until its product workflow is complete, it has no primary-navigation item.
Contextual links may continue to open the retained implementation for internal
validation.

### Inbox

**Pending development.** Inbox/Review Queue still has retained Approvals domain and
UI code, but it is not a released primary workflow. The hidden entry must not be
visible, focusable, or announced by assistive technology. Approval decisions remain
available through their owning run or conversation context while the standalone
Inbox product flow is redesigned.

### Plugin Manager

Plugin Manager is a capability operations surface. It lists managed plugins and
supports refresh, validation, install, enable/disable, health checks, runtime
preview, and trusted preset application. Its `MCP settings` action explicitly
opens `Settings > MCP tool servers` because MCP server configuration remains a
Settings concern.

### Media Production

Media Production is the navigation label for the existing media job workspace.
The first implementation changes the entry label and icon only. Media job APIs,
operations, provider capability checks, and task terminology remain unchanged.

## Module Boundaries

- `SidebarNavigation.tsx` owns visible navigation order and active state.
- `view-types.ts` owns the top-level `plugins` view identity.
- `PluginManagerPage.tsx` owns the top-level plugin page shell.
- `PluginManagerSettingsPanel.tsx` remains the focused plugin management content
  during this slice; AppShell must not absorb its UI or action logic.
- `usePluginsDomain.ts` continues to own plugin state and mutations.
- `SettingsPage.tsx` no longer owns Work Board or Plugin Manager navigation.
- `GlobalWorkBoardPage.tsx` remains implemented but is not advertised in primary
  navigation while Work Board is pending development.
- `AppShell.tsx` performs only view, refresh, and callback wiring.

## State And Navigation

```text
Sidebar item
  -> ViewId
  -> AppShell activeView
  -> existing domain refresh
  -> focused page component
```

```text
Plugin Manager > MCP settings
  -> remember current app return target
  -> open Settings
  -> select MCP tool servers
```

Retained Inbox and Work Board routes may continue to be exercised by contextual
actions and focused development tests. These paths do not imply that either feature
is generally released.

## Non-goals

- No daemon API, contracts, database, or persistence changes.
- No plugin marketplace redesign.
- No Work Board behavior redesign.
- No media job page redesign or API rename.
- No mobile acceptance scope.
- No major behavior added to the large `AppShell.tsx`.
- No duplicate Settings shortcuts for the promoted surfaces.

## Acceptance Criteria

- The global sidebar order is Media Production, Plugin Manager, Automations.
- Inbox does not appear in the global sidebar.
- Work Board does not appear in the global sidebar.
- Plugin Manager keeps the global sidebar visible.
- Settings navigation no longer contains Work Board or Plugin Manager.
- Plugin operations keep their current real behavior.
- `MCP settings` opens the MCP tool server section inside Settings.
- Retained contextual approval and Work Board routes continue to function.
- Existing image and video jobs continue to work without API changes.
- Desktop widths 1280, 1440, and 1920 have no navigation wrapping or horizontal
  overflow.
