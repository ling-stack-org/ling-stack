# Dark Mode Surface Convergence

Status: active design contract; homepage direction approved, product-wide implementation authorized
Date: 2026-07-31
Scope: Ling Dark on Web and Desktop, beginning with the conversation homepage

Related docs:

- [Dark Mode Surface Convergence Implementation Plan](dark-mode-surface-convergence-implementation-plan.md)
- [Ling Dark Built-in Theme](ui2.0升级/themes/04-Ling-Dark内置主题.md)
- [Design Tokens And Themes](ui2.0升级/foundations/02-Design-Tokens与主题.md)
- [Web And Desktop Surface Specification](ui2.0升级/foundations/05-Web与Desktop表面规范.md)

## Purpose

Ling Dark currently renders as several unrelated dark themes inside one window. Some
legacy Web aliases still resolve to pure black or near-black values while newer UI2
components consume the built-in Theme Pack tokens. Settings exposes the problem most
clearly: the shell, page sections, controls, tables, and overlays can each use a different
dark level even when they are visually part of one surface.

This contract replaces the old pure-black direction with a quiet neutral-gray workspace.
It defines one surface hierarchy, one token authority, and a staged migration that can be
visually approved on the homepage before changing Settings or the rest of the product.

## Approval Decision

On 2026-07-31 the `1440x960` and `1280x800` homepage pilot was accepted as the visual
baseline. The approval removes the Settings migration gate and authorizes the same
surface hierarchy across every Web and Desktop product surface. The approval does not
authorize layout, information-architecture, business-state, API, or storage changes.

## User Problem

The current dark appearance has three product defects:

1. Large pure-black regions visually split adjacent content instead of creating useful
   hierarchy.
2. Components using `--ling-*` tokens and components using legacy aliases such as
   `--app-bg` or `--surface-panel` no longer agree on the same surface.
3. Existing dark-mode tests prove only that a color is dark. Pure black therefore passes
   even when the page has no coherent depth model.

The desired result is not a brighter dark theme. It is a more continuous one: the user
should perceive one workspace with restrained depth, not a collage of black rectangles
and unrelated grays.

## Product Character

Ling Dark is a desktop productivity theme:

- neutral, quiet, and work-focused,
- solid rather than glassy,
- dense enough for repeated use,
- low in decorative contrast,
- explicit only where focus, selection, warning, or elevation matters.

It is not an "AI dark tech" theme. It must not rely on pure black, blue-purple gradients,
glowing borders, translucent cards, or large saturated status fields for personality.

## Token Authority

The built-in Theme Pack is the canonical source of color values:

- `packages/ui-react/src/theme/built-ins/ling-dark.ts`
- `packages/ui-react/src/styles/themes/built-in-themes.css`

Web aliases in `apps/web/src/styles/base.css` are compatibility names only. They must
eventually resolve to the active `--ling-*` tokens and must not define an independent dark
palette.

The homepage pilot temporarily scoped compatibility aliases by
`data-ui-surface="home"`. Product-wide approval removed that bridge: dark compatibility
aliases now resolve to the active Theme Pack globally, and feature CSS selects semantic
roles rather than owning another palette.

## Surface Hierarchy

| Role | Canonical token | Ling Dark value | Use |
| --- | --- | --- | --- |
| App | `--ling-bg-app` | `#111315` | window and primary canvas ground |
| Sidebar | `--ling-bg-sidebar` | `#141618` | persistent navigation |
| Panel | `--ling-bg-panel` | `#171a1d` | page panels, rows, compact cards |
| Composer | `--ling-bg-composer` | `#191c20` | message input and composition surfaces |
| Elevated | `--ling-bg-elevated` | `#1d2024` | popovers, menus, drawers, floating controls |
| Subtle | `--ling-bg-subtle` | `#22262b` | hover, grouped controls, quiet secondary fill |
| Pressed | `--ling-bg-pressed` | `#2c3137` | pressed and strongly selected controls |

The hierarchy is semantic, not a requirement to show every level on every page. A simple
page should normally use two or three levels. Adding a container only to display another
shade is not allowed.

## Pure Black Boundary

`#000000` is not a product surface. It is allowed only as a color ingredient for:

- modal scrims and media lightbox surroundings,
- shadows with alpha,
- video or image letterboxing when the media itself requires it,
- code syntax colors where a token explicitly owns the value.

App backgrounds, Settings shells, page sections, tables, inputs, drawers, menus, and
empty states must not resolve to opaque pure black.

## Surface Rules

### App And Shell

- The browser document, AppShell, and empty page ground use App.
- The sidebar uses Sidebar, with one restrained divider from the content surface.
- A page must not paint a full opaque Panel over App unless the page is intentionally a
  contained management surface.
- Nested page sections stay unframed unless they are a repeated item, a modal, or a real
  tool boundary.

### Panels And Controls

- Rows and compact repeated items use Panel or remain transparent over Panel.
- Inputs and composers use Composer or Panel according to their interaction role.
- Popovers, menus, drawers, and floating action surfaces use Elevated.
- Hover uses Subtle. Pressed or strong selection uses Pressed or the theme selection
  token.
- Disabled state changes foreground and affordance; it does not create another black
  surface.

### Borders And Shadows

- `--ling-border-default` separates adjacent controls or real ownership boundaries.
- Do not outline every section. Spacing and background continuity establish the default
  hierarchy.
- Strong borders are reserved for focus, selected objects, destructive confirmation, or
  high-consequence state.
- Shadows communicate actual elevation only. Dark shadows remain low-alpha and must not
  create black halos around ordinary cards.

### Text

- Strong text is reserved for page identity, current object identity, and primary value.
- Default text carries ordinary content.
- Muted text carries secondary metadata that is still useful.
- Soft text is limited to tertiary metadata and placeholders; it must not carry required
  instructions or error recovery.
- Dark-mode cleanup must not solve density problems by adding more gray explanations.

### Status

- Success, warning, danger, and information use the Theme Pack status foreground,
  background, and border triplets.
- Normal or healthy state remains visually quiet and should usually have no persistent
  status surface.
- Status color never replaces text, icon, or accessible naming.

## Homepage Pilot Contract

The first implementation slice is limited to the empty conversation homepage:

- App and content ground use App.
- Sidebar uses Sidebar.
- The composer uses Composer.
- Shortcut controls use Panel and Subtle hover.
- Text and borders use the Theme Pack tokens.
- The existing information architecture, shortcuts, model selection, permission control,
  file attachment, send behavior, and first-run behavior do not change.
- No gradient, glow, artwork, blur, or decorative dark-mode asset is added.

The pilot uses the existing `data-ui-surface="home"` attribute. Settings, channel,
private chat, media, automation, and management surfaces remain outside this slice.

## Settings Migration Contract

The homepage screenshots are accepted. Settings migration must now be organized by
ownership layer rather than page-by-page overrides:

1. Settings shell: document ground, left navigation, content root, dividers.
2. Shared controls: input, select, segmented control, switch, button, menu, dialog.
3. Shared data surfaces: toolbar, table header, row, empty state, drawer.
4. Settings modules: profile, interface, model workbench, teammate management, skills,
   permissions, personalization, plugins, archived items, and pending diagnostics.
5. Overlays and Desktop: dialogs, popovers, toasts, native titlebar, scrollbars, first
   paint, and restored windows.

Module CSS may define geometry and feature-specific state. It must not introduce another
base dark palette.

## Accessibility And State Coverage

- Default body text must meet WCAG AA against its owning surface.
- Muted text must remain readable at the shipped font size; critical instructions cannot
  use the soft text level.
- Focus-visible must be present on keyboard interaction without illuminating the entire
  row or page.
- Hover, focus, selected, pressed, disabled, loading, warning, danger, popover, and dialog
  states must be checked on their actual owning surface.
- Reduced motion changes animation only, not contrast or state visibility.

## Acceptance

### Homepage Pilot

- `html[data-theme="dark"][data-ui-surface="home"]` uses the Theme Pack surface ladder.
- App, Sidebar, Panel/shortcut, and Composer resolve to distinct intended tokens.
- No visible opaque homepage surface resolves to `rgb(0, 0, 0)`.
- The document has no horizontal or vertical shell overflow at `1440x960` and
  `1280x800`.
- Keyboard focus is visible on shortcuts and composer controls.
- Browser console and `pageerror` remain empty.
- Real screenshots are reviewed before any Settings migration starts.

### Product-Wide Completion

- Legacy Web aliases no longer own independent dark values.
- Settings and all primary product surfaces use the same semantic ladder.
- First paint and restored Desktop windows use the same resolved theme as React.
- Screenshot and computed-style tests prove token ownership and useful hierarchy, not
  merely low RGB values.

## Full Surface Matrix

The product-wide migration covers:

- AppShell, sidebar, collapsed rail, titlebar, navigation menus, and first run,
- normal conversation, channel, branch/topic surfaces, teammate private chat, shared
  composer, message states, Right Dock, terminal, and artifact preview,
- Settings shell and every reachable Settings module,
- model workbench, teammate management, councils, skill library, plugins, automations,
  media production, media jobs, approvals, runs, threads, profile, archived items, and
  pending diagnostic entry points,
- dialogs, drawers, popovers, menus, tooltips, toasts, scrollbars, loading, empty, error,
  warning, destructive, disabled, selected, hover, pressed, and keyboard-focus states,
- Desktop first paint, native titlebar, restored windows, and PiP/compact surfaces.

Hidden or pending product entries are verified through their existing direct test entry
points. This theme migration does not make them visible or change their product status.

## Hard Stops

- Do not replace Theme Pack tokens with page-local hex values.
- Do not preserve the temporary homepage-only bridge after global alias convergence.
- Do not add blur, gradients, glow, or background artwork to make dark mode feel richer.
- Do not alter layout, business behavior, persistence, API, daemon, or SQLite semantics.
- If a surface requires a new semantic role beyond this hierarchy, update this contract
  and the Theme Pack schema before adding a local color.
