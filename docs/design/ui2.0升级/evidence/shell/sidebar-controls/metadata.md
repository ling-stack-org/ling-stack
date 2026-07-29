# P4.5 Sidebar Controls Evidence

## Capture Context

- Date: `2026-07-19`
- Branch: `codex/ui2-desktop-coverage-foundation`
- Base HEAD: `0a0b8050`
- Working tree: dirty; Desktop/Computer Use and UI 2.0 work remain intentionally preserved together
- Served artifact: Playwright-managed real Vite development server at `http://127.0.0.1:4174`, not `dist`
- Browser: Playwright Chromium
- Data source: deterministic `mockDaemon` fixture with one channel, one teammate, no recent conversations and one failed work item
- Locale: `en-US`

Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm exec playwright test \
  e2e/ui2-sidebar-controls.spec.ts
```

## Screenshots

| File | Viewport | Theme Pack | State |
|---|---|---|---|
| `1440x960-ling-light-disabled-danger-menu.png` | `1440x960` | `ling-light` | Work Board selected; recent actions Portal open with disabled danger action |
| `1280x800-ling-dark-collapsed-tooltip.png` | `1280x800` | `ling-dark` | 48px compact rail; Automations focus Tooltip; reduced motion |

SHA-256:

```text
1d3a85edaaa058bc6ac07972e540e957e283bb209f43b82c76c97fe8e237d5b8  1280x800-ling-dark-collapsed-tooltip.png
3d2eef56049a9f9a47ae8af88cbab49a972a206f1156470b73009d50f66a435d  1440x960-ling-light-disabled-danger-menu.png
```

## Verified Behavior

- Primary navigation contains one ordered five-action group, uses shared Button and exposes exactly one `aria-current=page`.
- Expanded primary actions are at least `36px`; compact rail actions remain `36px` and hide only the visible label.
- Section menu triggers use shared IconButton at `32px`, keep an accessible name and expose controlled Radix open state.
- Menu content is Portal-backed, remains inside the viewport, closes with Esc and restores focus to the trigger.
- Disabled archive-all remains disabled, uses danger tone and explains why through its title.
- Compact rail hides section menus instead of overlapping the 32px disclosure trigger with the rail preview.
- Tooltip is Portal-backed, supports hover and keyboard focus, switches rapidly without duplicate tooltip nodes and stays right of the rail.
- Reduced motion computes `animation-name: none` for the Tooltip while preserving focus and final content.
- Browser console errors and page errors: `0` unexpected.
- Both screenshots were inspected at original resolution; no overlap, horizontal overflow, theme leakage or clipped overlay was found.

## CSS Cleanup Evidence

- Removed the unowned legacy `.sidebar-section-menu-popover`, `.sidebar-section-menu.open`,
  `.sidebar-section-menu-copy` and `.sidebar-section-menu-rich-*` selector family from Web source.
- Removed stale Sidebar-specific ActionMenu classes from `ActionMenuItem`; provider menus keep their real `action-menu-item-*` owner.
- `layout.css`: `2123 -> 1955` lines.
- `components.css`: `16695 -> 16647` lines.
- `sidebar.css`: `1960 -> 1850` lines.
- `action-menus.css`: `93 -> 87` lines.
- Focused `app/sidebar-ui2.css`: `187 -> 209` lines and owns current menu trigger/compact rail behavior.
- No new color literal, `!important`, Theme Pack ID selector or feature-level Radix import was added.

## Automated Evidence

- Focused Sidebar controls: `2/2` passed.
- Controls + object rows + list states + section disclosure: `8/8` passed.
- App selection, disclosure/menu and archive targets: `3/3` passed.
- Channel compact rail/pending state, channel menu and teammate menu targets: `4/4` passed.
- Browser evidence asserts Portal ownership, keyboard focus, Esc, active, disabled, danger, rapid tooltip switch,
  reduced motion, hit area and overflow.

## Remaining Scope

- This verifies `SIDEBAR-PRIMARY-001`, `SIDEBAR-MENU-001` and `SIDEBAR-TOOLTIP-001` for desktop Web.
- All seven Sidebar Function IDs are now verified; broad CSS file decomposition still remains a U13 architecture task.
- First Run has no confirmed production trigger and remains `inventory`.
- Chromium Web evidence does not replace Windows DPI/high-contrast or signed Desktop package evidence.
