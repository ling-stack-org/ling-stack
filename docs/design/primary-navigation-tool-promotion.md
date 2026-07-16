# Primary Navigation Tool Promotion

## Summary

Ling promotes `Work Board` and `Plugin Manager` from Settings into the global
desktop navigation. These surfaces are operational workspaces that users may open
repeatedly during normal work; they are not low-frequency configuration forms.

The media entry is renamed from `Image Generation` to `Media Production` so the
navigation truthfully covers both image and video jobs.

This decision supersedes the older Settings P3/P10 placement that kept Work Board
and Plugin Manager inside Settings. It aligns with the resolved Work Board IA in
`review-queue-work-board-detailed-design.md`.

## Target Navigation

```text
Primary navigation
  Inbox
  Media Production
  Work Board
  Plugin Manager
  Automations
```

Settings continues to contain configuration and maintenance surfaces such as
models, AI teammates, councils, authorization, external connections, MCP servers,
skills, archives, and diagnostics.

## Product Semantics

### Work Board

Work Board is the global work ledger. It is used to review actionable work,
blocked items, ownership, runs, approvals, and related channel activity. It keeps
the global sidebar visible and may open contextual work objects in their existing
surfaces.

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

Work Board scope requests from Inbox continue to open the same top-level Work
Board page and preserve the requested scope.

## Non-goals

- No daemon API, contracts, database, or persistence changes.
- No plugin marketplace redesign.
- No Work Board behavior redesign.
- No media job page redesign or API rename.
- No mobile acceptance scope.
- No major behavior added to the large `AppShell.tsx`.
- No duplicate Settings shortcuts for the promoted surfaces.

## Acceptance Criteria

- The global sidebar order is Inbox, Media Production, Work Board, Plugin Manager,
  Automations.
- Work Board and Plugin Manager keep the global sidebar visible.
- Settings navigation no longer contains Work Board or Plugin Manager.
- Plugin operations keep their current real behavior.
- `MCP settings` opens the MCP tool server section inside Settings.
- Work Board links from Inbox open the top-level Work Board.
- Existing image and video jobs continue to work without API changes.
- Desktop widths 1280, 1440, and 1920 have no navigation wrapping or horizontal
  overflow.
