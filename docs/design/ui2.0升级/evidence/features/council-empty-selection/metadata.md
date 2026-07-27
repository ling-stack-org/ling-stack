# T13-P.2-D Council Empty Selection Evidence

## Scope

- Surface: Settings > Council Workspace
- State: underlying Council list populated, current filter returns no row, detail selection empty
- Viewports/themes: `1440x960 Ling Light`, `1280x800 Ling Dark`
- Contract: shared `EmptyState`, two real actions, compact layout, no clipped action text, no page overflow

## Verification

```text
ui2-council-empty-selection.spec.ts 2/2
Council/List/Settings selected 15/15
dark-mode.spec.ts 2/2
P.2 combined focused 15/15
P.2 broad App/Channel/Teammates/Archive/Dark/Release 161/161
Web typecheck passed
Web check:i18n passed
Web lint passed (OperationEmptyState=0/0)
Web production build passed
git diff --check passed
```

The first `1280x800` capture exposed clipped visible action labels after the compatibility adapter was removed.
The final focused owner uses the shared component's public root `className` to assign a two-column layout, with a
single-column fallback below `1120px`. The focused E2E now asserts both action labels fit their button boxes.

## Files

| File | SHA-256 |
|---|---|
| `1440x960-ling-light-council-empty-selection.png` | `a6abb85cb6500a0d2ef7694a8bf95598837ba7bf00391402dcf04aa5c0a71381` |
| `1280x800-ling-dark-council-empty-selection.png` | `60dd70da488cf5786078af747e56bfe736c4621703295e6b06ad562eca8aaaac` |

## Visual Review

- Shared EmptyState copy and both actions remain inside the Council detail surface.
- `Open AI Teammates` and `Create council` are fully visible at both target viewports.
- Search focus remains contained in the list toolbar.
- Light and Dark surfaces use semantic tokens without hard-coded repaint.
- No horizontal document overflow, action overlap, or nested scroll leak was observed.
