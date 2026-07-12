# Settings Archived Items Category Tabs P14.2

## Related Docs

- [Ling Design System](ling-design-system.md)
- [Settings Full Surface Productization P10](settings-full-surface-productization-p10.md)
- [Settings Archived Items Permanent Delete P14](settings-archived-items-permanent-delete.md)
- [P14.2 Implementation Plan](settings-archived-items-category-tabs-p14.2-implementation-plan.md)

## Summary

Settings > Archived items uses one category tab row and one active list. Conversations,
AI teammates, channels, and branches are mutually exclusive management views; rendering
all four vertically creates multiple scroll regions and makes the page increasingly hard
to scan as archived data grows.

## Layout

- The panel begins with category tabs. Settings navigation already names the surface, so
  it does not repeat an `Archived items` heading or manual refresh action.
- Reuse the compact Settings subnav pattern for `Conversations`, `AI Teammates`,
  `Channels`, and `Branches`.
- Each tab includes a numeric count. Zero-count tabs remain selectable.
- Do not add an `All` tab because the object names, restore consequences, and delete
  confirmations differ by category.
- Render only one list below the tabs. It keeps the P14.1 single-line
  `name / archived time / actions` row grammar.
- The active list owns the only internal scroll boundary and uses
  `max-height: min(520px, calc(100vh - 310px))`. Short lists shrink naturally.
- The last selected category is a local presentation preference. First use defaults to
  Conversations.

## Search

- Keep a compact search field visible beside the category tabs for every category.
- Search matches the visible object name. Branch search matches both parent channel and
  branch names.
- The input expands inside the tab toolbar without resizing the list.
- Switching category or pressing Escape clears the query while keeping the field visible.
- No matches use one compact empty row. Do not render an explanatory card.

## Interaction Rules

- Restore and Delete remain local to Settings and keep existing confirmations and
  loading/error behavior.
- Counts update from controller state after refresh, restore, or delete.
- If the active category becomes empty, keep it selected and show its compact empty
  state; do not move the user unexpectedly.
- Opening a category never changes Settings route or reveals the main application shell.

## Acceptance Criteria

- Four category tabs are visible and only one archived list exists at a time.
- The selected category survives a reload when local storage is available.
- Search stays visible and never searches across categories.
- Long data sets use one internal scroll region with no horizontal overflow at
  `1440x960` and `1280x800`.
- Light and dark themes use existing Settings tokens.

## Non-Goals

- No API, schema, retention, restore, or permanent-delete changes.
- No two-column card grid, accordion layout, or secondary left navigation.
- No cross-category bulk actions or global archived-data search.
