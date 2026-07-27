# P4.2 Sidebar Object Row Evidence

## Capture Context

- Date: `2026-07-19`
- Branch: `codex/ui2-desktop-coverage-foundation`
- Base HEAD: `0a0b8050`
- Working tree: dirty; Desktop/Computer Use and UI 2.0 work remain intentionally preserved together
- Served artifact: Playwright-managed real Vite development server at `http://127.0.0.1:4174`, not `dist`
- Browser: Playwright Chromium
- Data source: deterministic `mockDaemon` fixture with channels, two AI teammates and four conversations
- Locale: `en-US`

Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm exec playwright test \
  e2e/ui2-sidebar-object-rows.spec.ts
```

## Screenshots

| File | Viewport | Theme Pack | State |
|---|---|---|---|
| `1440x960-ling-light-expanded.png` | `1440x960` | `ling-light` | Expanded rail, selected channel, teammate actions and long recent title |
| `1280x800-ling-dark-collapsed-tooltip.png` | `1280x800` | `ling-dark` | 48px compact rail, 26px channel identity and channel Tooltip |

SHA-256:

```text
dc8571be94a7fc183f833de40701fb3d555fd6d5877d8a4053290a162dec4203  1280x800-ling-dark-collapsed-tooltip.png
3ddf1c4b3988c72e1713b725031ef025a03ac29f8cc3360d9f3928c3986374f5  1440x960-ling-light-expanded.png
```

## Verified Behavior

- Channel, AI teammate and recent-conversation objects share `SidebarObjectRow` without moving domain callbacks into the component.
- Shared Button exposes stable `leading/label/trailing` slots and public layout variables; Feature CSS does not select primitive internal classes.
- Expanded teammate avatar is no wider than `24px`, keeps at least `4px` label spacing and exposes a `32px` archive action.
- Long recent titles stay inside the row and the Sidebar has no horizontal overflow.
- Compact rail remains `48px`; its selected channel button is at least `36px`, channel identity is `26px` with `display: grid`, and row actions are hidden.
- Hovering the compact channel opens the shared Tooltip to the right of the rail.
- Both screenshots were taken after the Channel composer became visible, so neither is a loading transition frame.
- Browser console errors and page errors: `0` unexpected.

## Automated Evidence

- `@ling-stack/ui-react`: `37/37` tests passed.
- P4 Sidebar target set: `7/7` passed.
- Focused object-row browser spec: `2/2` passed.
- Combined final browser run: `9/9` passed.
- Web i18n, UI 2.0 import/facade lint, typecheck and `git diff --check` passed.

## Remaining Scope

- This verifies the object-row and expanded/collapsed geometry slice only.
- `SIDEBAR-CHANNEL-001`, `SIDEBAR-TEAMMATE-001` and `SIDEBAR-RECENT-001` still include
  StatusIndicator migration, loading/stale/empty states and section disclosure motion; those Function IDs remain open.
- First Run has no confirmed production trigger and remains `inventory`.
- Chromium Web evidence does not replace Windows DPI/high-contrast or signed Desktop package evidence.
