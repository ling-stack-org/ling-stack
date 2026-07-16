# Global Select Controls Implementation Plan

## Implementation

1. Add `SelectControl` and `RichChoiceSelect` under shared Web components and
   export both from the shared component barrel.
2. Add a final shared CSS layer for control tokens, native select shells, rich
   choice popovers, dark mode, and focus behavior.
3. Migrate every production `select` in `apps/web/src` to `SelectControl` while
   preserving its options, value, handlers, disabled state, labels, and local
   layout classes. The completed inventory contains 61 controls across 34
   production TSX files.
4. Use `compact` only for filters, toolbar controls, dock controls, and row
   routing; use `field` for all regular form rows.
5. Replace the settings-only choice menu with `RichChoiceSelect`; do not move
   dynamic resource pickers to the rich menu.
6. Remove broad bare-select visual overrides once the shared control owns the
   common appearance. Keep feature CSS only for layout constraints.
7. Add a source contract test that rejects bare production `select` tags outside
   the shared native control implementation. Run it through `check:select-controls`
   and the normal Web lint command.

## Verification

- Web typecheck, i18n audit, and `git diff --check`.
- Shared control tests cover native selection, disabled state, compact/field
  geometry, dark theme, and rich-choice keyboard behavior.
- Run Settings, model workbench, teammates, channel, work board, media, MCP,
  runs, and dark-mode Playwright coverage.
- Inspect the running desktop Web UI at 1280, 1440, and 1920 widths.
