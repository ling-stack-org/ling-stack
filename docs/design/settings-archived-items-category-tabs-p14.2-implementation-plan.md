# Settings Archived Items Category Tabs P14.2 Implementation Plan

## Related Docs

- [Settings Archived Items Category Tabs P14.2](settings-archived-items-category-tabs-p14.2.md)
- [Settings Archived Items Permanent Delete P14](settings-archived-items-permanent-delete.md)
- [Settings Full Surface Productization P10](settings-full-surface-productization-p10.md)

## Implementation

1. Add a Web-only `ArchivedCategoryId` and derive the four Settings subnav options from
   archived controller counts.
2. Remove the duplicate panel title/refresh header, then replace the four vertical groups
   with one `SettingsSubnav`, one active tabpanel, and the existing compact row components.
3. Persist the selected category under `ling-stack.settings.archived-category`, falling
   back to Conversations when the value is absent, inaccessible, or invalid.
4. Keep current-category name filtering directly visible beside the category tabs. Clear
   the query on category change or Escape without collapsing the field.
5. Replace the four 280px scroll regions with one list capped at 520px and retain compact
   loading, empty, and no-result rows.
6. Update P10/P14 documentation and i18n copy without changing controller or daemon
   behavior.

## Verification

- Static: `git diff --check`, Web i18n audit, and Web typecheck.
- Browser: Settings, channel archive, and dark-mode E2E.
- Assert four tab counts, one tabpanel/list, category persistence, always-visible
  current-category search and reset behavior, count updates after restore/delete, one
  vertical scroll region, and no
  Settings-shell regression.
- Validate `1440x960` and `1280x800` without horizontal overflow.

## Boundaries

- Keep archive mutations in `useArchivedSettingsController`.
- Keep category/search state inside `ArchivedSettingsPanel`.
- Reuse `SettingsSubnav`; do not introduce another segmented-control component.
- Preserve current conversation, teammate, channel, and branch confirmation semantics.
