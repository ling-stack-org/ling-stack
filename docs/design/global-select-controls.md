# Global Select Controls

## Summary

Ling uses two selection controls on desktop Web. The system standardizes visual
grammar without replacing reliable browser selection behavior where it is the
right fit.

## Control Taxonomy

### SelectControl

`SelectControl` renders a real HTML `select` inside a shared visual shell.
Use it for a short enum, filter, status, route, provider, model, teammate, or
resource choice where each option is self-explanatory.

- Keep native labels, form behavior, keyboard navigation, and Playwright
  `selectOption` support.
- Use `field` for settings, drawers, dialogs, and ordinary form rows.
- Use `compact` for filters, toolbars, dock controls, and row-level routing.
- The closed control is visually consistent; the opened option surface remains
  browser and OS native by design.

### RichChoiceSelect

`RichChoiceSelect` is for two to six fixed policy decisions whose options need
an icon, a concise label, and explanatory copy. It is not for dynamic provider,
model, file, teammate, or high-cardinality lists.

- Use a button trigger plus `listbox` and `option` semantics.
- Support Arrow keys, Home, End, Enter, Space, Escape, outside click, and focus
  restoration to the trigger.
- Default authorization and Sandbox settings are the initial consumers.

## Visual Rules

- `field` controls are 36px tall; `compact` controls are 32px tall.
- Both use the current surface, border, focus, disabled, and dark-theme tokens.
- A Lucide chevron is decorative and never replaces the native select's label
  or accessibility semantics.
- Local feature CSS may define layout width and grid placement, but may not
  redefine the common select border, background, focus, height, or disabled
  appearance.

## Keyboard And Focus Rules

`SelectControl` retains browser-native keyboard behavior. Tab moves focus into
the real `select`; Arrow keys, Home, End, typing, and platform accessibility
shortcuts remain owned by the browser and operating system.

`RichChoiceSelect` owns its lightweight listbox behavior:

- From the trigger, ArrowUp, ArrowDown, Home, and End open the list at the
  matching option. Enter and Space use the standard button activation path.
- Inside the listbox, ArrowUp, ArrowDown, Home, End, Enter, and Space move or
  commit the roving option focus.
- Escape and a committed choice close the list and restore trigger focus.
- A pointer press or focus move outside the control closes the list without
  stealing focus back from the next destination.

## Migration Inventory

All production TSX selection controls now flow through `SelectControl`, grouped by the
surface that owns their business behavior:

- Settings and skills: interface language, work intake, skill policy, source
  sync, and skill-library filters.
- Model workbench and integrations: provider filters, provider editor fields,
  MCP transport, and media job configuration.
- People and councils: teammate creation, profile/model/memory/task settings,
  council health filters, member routing, and channel attachment.
- Workspace and channels: channel creation/settings, task execution fields,
  protocol language, runtime policy, workflow proposal assignment, and owner
  inference.
- Operational surfaces: approvals routing, automation schedules, work-board
  filters and routing, run resumption, saved channel views, and right-dock
  plan filters.

Feature CSS may size the surrounding `.select-control` shell. It must not
style the nested native element directly. `apps/web/scripts/check-select-controls.mjs`
enforces that new production TSX cannot introduce a bare `<select>` outside
the shared implementation.

## Boundaries

- No backend, contract, persistence, or permission changes.
- No searchable or multi-select custom combobox in this slice.
- No mobile-specific acceptance work.
- Production TSX must use `SelectControl` rather than introduce new bare
  `select` elements, except inside `SelectControl` itself.
