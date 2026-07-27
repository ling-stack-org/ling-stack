# P6A.4 Channel Settings, Overlay And Dock Evidence

## Scope

- Function IDs: `CHANNEL-SETTINGS-001`, `CHANNEL-OVERLAY-001`, `CHANNEL-DOCK-001`.
- Surface: Channel Settings five-tab utility page, Channel create/rename/governance/inline detail overlays,
  and every reachable Right Dock launcher/deep page.
- Branch: `codex/ui2-desktop-coverage-foundation`.
- HEAD while captured: `0a0b8050` with a dirty mixed Desktop/UI2 working tree.
- Date: 2026-07-19.

## Implemented Contract

- Channel Settings uses one shared Tabs owner for General, Workspace, Members, Councils and Health. Every tab has
  one bounded scroll owner and stable loading, empty, busy, failure and long-content geometry.
- Rename uses the shared Dialog and restores focus to `More channel views` after one Escape. Governance uses the
  shared modal Popover and restores focus to its trigger without a document-level listener.
- Approval/context detail remains an in-feed Inspector rather than creating a second global modal owner.
- The Dock launcher, page header, Back, Close, empty state and list controls are package-owned. Channel review,
  plan, workspace change, browser, activity and terminal projections remain focused Web domain components.
- Review, Plans, Files, Activity, Browser and Terminal expose reachable loaded/failure/detail states. Back only
  changes the Dock page stack; Close collapses the Dock.
- Dock width uses the shared controller. Resizing keeps pointer capture, clamps width and does not create document
  overflow or capture the entrance animation halfway through.
- Settings/Overlay/Dock visuals use Ling semantic tokens in focused CSS. `components.css` no longer owns the
  utility header, Settings main layout or the workspace-change badge breakpoint.

## Automated Evidence

Current post-CSS-closeout verification:

- `@ling-stack/ui-react`: `40/40` package tests.
- `@ling-stack/conversation-ui-react`: `10/10` package tests.
- `ui2-channel-settings-overlay-dock.spec.ts`: `7/7`.
- Web typecheck, i18n audit, UI 2.0 lint guards and `git diff --check`: passed.
- UI 2.0 lint budgets: legacy z-index `92/97`; high literal z-index `24/25`.

The last combined product regression before the owner-only CSS move passed `144/144`. The closeout changed no JSX,
state, fixture, API or shared-package behavior; the focused `7/7` and all static/package gates were rerun after the
move. A later change to any of those behavior owners must rerun the complete combined set rather than citing this
owner-only exception.

The focused spec verifies all five tabs, keyboard tab navigation, notification label containment, rename/governance
Escape and focus restoration, Dock launcher order, Back/Close, Dark containment, Settings loading/empty/error/scoped
busy, inline approval Inspector, every Dock launcher, long diff/detail content, resize and runtime console errors.

## Runtime And Fixtures

- Served artifact: source through the Playwright-managed real Vite dev server.
- URL: `http://127.0.0.1:4174/`.
- Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web exec playwright test \
  e2e/ui2-channel-settings-overlay-dock.spec.ts
```

- Locale: `en-US`.
- Mock daemon fixtures: Engineering Channel, pending approval, governance notification, plan lineage, workspace
  changes, files, activity, browser and terminal summaries, plus deterministic empty/error/busy routes.
- No backend API, contract, database, route, permission policy or state-machine change was required.

## Screenshots

| File | Theme / viewport | SHA-256 | Reachable state |
|---|---|---|---|
| `1440x960-ling-light-channel-settings-general.png` | `ling-light`, 1440x960 | `150c54553cb871a0c3ce7a48cd7f5895b9e7e7a3c9e6f3c9a9b5f14f89a1c764` | General tab, shared fields and notification segmented control. |
| `1440x960-ling-light-channel-settings-general-error.png` | `ling-light`, 1440x960 | `cc12d075af69ec7094bedd4440ff5f7f0e27650dbe36f7a2cb75555ec29109c8` | Save failure remains in the owning Settings field/surface. |
| `1440x960-ling-light-channel-settings-empty-error.png` | `ling-light`, 1440x960 | `55a24931bdc6fcf47a8e1bedb0b58c50da8e1eabb59c59ceaf9f135c652ed463` | Health error plus Members/Councils empty states and scoped controls. |
| `1440x960-ling-light-channel-governance-open.png` | `ling-light`, 1440x960 | `bfe7d13a00e602b3edb94b2b0c30b37b0ab53c02fd6671f431422bae5a62634e` | Governance modal Popover anchored below the Channel toolbar. |
| `1440x960-ling-light-channel-dock-launcher.png` | `ling-light`, 1440x960 | `bb3541ce4c84f9d6d2cfee5153b34f15ff5eeae34372e8719f037766b82f509e` | Package-owned launcher after the Dock reaches its stable width. |
| `1440x960-ling-light-channel-dock-review-detail.png` | `ling-light`, 1440x960 | `1d977273dda6c56d03510884ab529a0a6f09821cd9eb62793cea7035956dc4fa` | Review item detail and long diff remain inside the Dock scroll owner. |
| `1440x960-ling-light-channel-dock-deep-states.png` | `ling-light`, 1440x960 | `010d6509092b6d65b0acb07e844ef6e1ade47faf7cbb95fabe4ad701b98faa81` | Files, Activity, Browser and Terminal loaded/failure/detail coverage. |
| `1280x800-ling-dark-channel-settings-workspace.png` | `ling-dark`, 1280x800 | `cb2ab93b6478f1dfa96e336abbef9fdeba7ba4ce883a3c69f7298641b0f6e71a` | Workspace tab fields remain contained in the dense viewport. |
| `1280x800-ling-dark-channel-settings-members-empty.png` | `ling-dark`, 1280x800 | `26a3d620dd17b9713da5bf2a3b60de779f53b13358a1f9cc00dc284d61598289` | Members empty state with no hard-coded light surface. |
| `1280x800-ling-dark-channel-rename-failure.png` | `ling-dark`, 1280x800 | `154d789df416272b5f2c8c92f9086d04e048844b3e34e2ef053770d6c6e90329` | Rename error persists inside the shared Dialog. |
| `1280x800-ling-dark-channel-dock-plans.png` | `ling-dark`, 1280x800 | `74428d1cd881bc48f77423b51008cbb4b0a1e384e280739487e224ebcc0049cb` | Plans list remains within Dock width and viewport bounds. |
| `1280x800-ling-dark-channel-dock-plan-detail-resized.png` | `ling-dark`, 1280x800 | `9bfec7eb64c9b1a3a70199c622641cabe93ba5c42bbb952e7d24b59b257650ae` | Plan detail after horizontal resize; long content stays internally contained. |

All PNG files were checked at the dimensions encoded in their filenames. Original-size inspection found no document
overflow, overlapping controls, clipped action labels, theme leakage or mid-transition capture. These screenshots use
mocked product data rendered by the production React/CSS path; they do not prove a real daemon, Desktop host or
provider connection.

## CSS Ownership Proof

- `components.css`: `11,457 -> 11,388` lines.
- `channel-header.css`: `128 -> 189` lines; owns the Settings/Environment utility header.
- `channel-settings.css`: `540 -> 545` lines; owns the Settings main grid and surface layout.
- `channel-right-dock/workspace-changes.css`: remains the only owner of the narrow badge behavior.
- Total Web CSS: `46,020 -> 46,017` lines.
- The focused files contain zero color literals, `!important`, Theme Pack ID selectors and `transition: all`.

## Completion And Next Slice

`CHANNEL-SETTINGS-001`, `CHANNEL-OVERLAY-001` and `CHANNEL-DOCK-001` satisfy the UI 2.0 `verified` gate.
The next product slice is `P6B Normal Conversation`; Channel behavior and this evidence remain its comparison
baseline and must not be rewritten as part of that migration.
