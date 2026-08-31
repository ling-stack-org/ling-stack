# Codex Window Shell Parity

Status: approved for local implementation; no push or PR in this slice

## Intent

Align Ling's built-in Desktop shell with the supplied Codex reference without
copying unavailable product actions. macOS, Windows and Web Desktop share the
same application chrome, Sidebar geometry, Header ownership and semantic color
hierarchy.

## Contract

- The application chrome is one full-width `48px` layout row. Body surfaces
  begin at `y=48px` and never render behind it.
- Expanded Sidebar width is `292px`; collapsed width is a real `48px` compact
  rail. Collapse is an atomic component switch, not a text-compression
  animation or a blank left margin.
- Light built-in shell colors are main `#ffffff`, Sidebar `#e6e4df`, selected
  `#d9d8d5`, hover `#deddda`, divider `#ededed`, strong text `#191c1f`.
- Dark built-in shell colors are main `#1f1f1f`, Sidebar `#282725`, selected
  `#3a3936`, hover `#32312f`, divider `#41403d`, strong text `#f4f4f4`.
- The expanded Sidebar starts with New conversation and has no static product
  name or brand row above it.
- While expanded, the titlebar leading segment uses the Sidebar background.
  When collapsed, that segment joins the main titlebar background; only the
  `48px` compact rail below keeps the Sidebar background.
- macOS traffic lights start at `12,17`; the navigation control is `32x32` at
  `84,8`. Windows uses frameless native-resizable geometry plus renderer-owned
  minimize, maximize/restore and close controls. Web renders no OS controls.
- The titlebar only contains existing Ling surface titles and actions. No fake
  Back, Forward, Search, Notification or brand menu is allowed.
- Renderer localization bootstrap is text-free and the macOS native title stays
  empty, including page-title updates and Sidebar transitions.

## Interfaces

- Generalize the existing Desktop titlebar provider so Web and Windows use the
  same window placement as macOS.
- Add a Windows-only `windowControls` Desktop capability with state read,
  state subscription, minimize, maximize/restore toggle and close commands.
- Window-control IPC accepts only the current main renderer sender and emits
  state after maximize, unmaximize, restore and system Snap changes.
- No daemon, database, approval or workspace protocol changes are permitted.

## Acceptance

- Geometry tests prove a `48px` titlebar, `292px -> 48px` Sidebar states,
  `y=24px` control centers, one Header owner, a functional compact rail and no
  horizontal overflow.
- Light/Dark screenshots cover Home expanded/collapsed, active conversation and
  Settings at `1280x800` and `1440x960`.
- Startup and repeated collapse/expand frame capture expose no transient product
  title or compressed Sidebar text.
- The compact rail contains only icon-first shortcuts backed by existing Ling
  actions. It never duplicates the titlebar Sidebar toggle and never mounts
  expanded labels, object rows or section menus.
- Windows acceptance covers resize, double-click maximize, Snap, minimize,
  maximize/restore and close on a real Windows host before cross-platform
  completion is claimed.
- Localization, Web/Desktop tests, package signatures and source/bundle hashes
  bind the final artifacts to the delivered source.
