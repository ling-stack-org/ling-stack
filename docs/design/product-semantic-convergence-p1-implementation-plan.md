# Product Semantic Convergence P1 Implementation Plan

## Summary

Implement P1 from [Product Semantic Convergence P1 IA](product-semantic-convergence-p1-ia.md).
This slice is a focused IA and copy convergence pass. It should make the existing entry
points feel deliberate without moving routes, changing data models, or doing an AppShell
refactor.

## Goals

- Make primary sidebar, work-object lists, Settings workspace tools, and contextual links
  each have a clear role.
- Tighten copy in Settings workspace tools so Model Workbench, Teammate Management,
  Council Workspace, Work Board, and Approval strategy read as low-frequency management
  tools.
- Keep direct repair paths from generation/provider failures to Model Workbench.
- Keep AI Teammates page clean: single teammate management plus lightweight Council
  Workspace entry only.
- Add regression tests for IA placement so future changes do not reintroduce duplicate
  Council or Work Board entries.

## Non-goals

- No daemon API or database changes.
- No route removal.
- No Work Board primary-nav promotion.
- No full visual redesign.
- No mobile acceptance.
- No AppShell modularization beyond route/prop wiring that already exists.

## Key Changes

1. Sidebar IA assertions:
   - Primary sidebar should show Inbox, Image Generation, and Automations.
   - Work Board should not be treated as a primary sidebar item in P1.
   - Channels, teammates, and recent conversations remain object lists.
2. Settings workspace tools:
   - Confirm and tighten descriptions for Model Workbench, Teammate Management, Council
     Workspace, Work Board, and Approval strategy.
   - Ensure nested tool views use the persistent Settings left navigation instead of a
     separate return row.
3. AI Teammates and Council Workspace:
   - Keep AI Teammates page free of the old `AI Councils` tab and full council list.
   - Keep only the lightweight Council Workspace entry.
   - Council Workspace remains the full management surface.
4. Contextual escalations:
   - Generation no-model state opens Model Workbench.
   - Inbox/attention states can open Work Board contextually.
   - Council Workspace can open AI Teammates for member management.
5. Copy cleanup:
   - Remove primary-flow technical terms if found: `raw job`, `metadata`, `slice`,
     `transport`, `scheduler registry`.
   - Keep technical terms only in diagnostics, API docs, or detail panels where users
     are intentionally inspecting internals.

## Module Boundaries

- `SidebarNavigation.tsx`
  handles sidebar presentation and should not know Settings workspace tool internals.
- `SettingsWorkspaceToolsPanel.tsx`
  handles workspace tool rows and product descriptions.
- `AiTeammatesPage.tsx`
  handles the lightweight Council Workspace entry only.
- `CouncilWorkspacePage.tsx` / `CouncilWorkspacePanels.tsx`
  handle complete council management.
- `ApprovalsPage.tsx`
  may keep contextual Work Board links.
- `AppShell.tsx`
  should only route/open the requested surface.
- `i18n.tsx`
  should receive copy-only additions; avoid using it as product logic.

## API / Types

- No new API.
- No contract change.
- No persistent data change.
- Existing route/view ids remain valid.

## State / Data Flow

```text
Primary sidebar
  -> activeView = approvals | media | automations
```

```text
Settings workspace tools
  -> settingsWorkspaceToolView = providers | teammates | councils | work_board
  -> nested tool page
  -> return row back to Settings tools
```

```text
Contextual escalation
  -> feature page detects repair/attention state
  -> AppShell opens Model Workbench / Work Board / AI Teammates / Council Workspace
```

## Test Plan

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts`
- `corepack pnpm --filter @ling-stack/web test:e2e -- teammates.spec.ts councils.spec.ts`
- Optional focused e2e updates:
  - Settings workspace tools can open Model Workbench, AI Teammates, Council Workspace,
    and Work Board, then return.
  - Sidebar does not expose Work Board as a P1 primary item.
  - AI Teammates page has no `AI Councils` tab or full council management UI.
  - Media no-model CTA opens Model Workbench.

## Implementation Slices

1. Audit current IA and test coverage.
2. Update Settings workspace tool descriptions and return-path copy if needed.
3. Update `view-types.ts` descriptions for Automations/Settings if stale.
4. Add or adjust e2e assertions for P1 IA boundaries.
5. Run typecheck and targeted e2e.
6. Update this plan's acceptance checklist with evidence.

## Acceptance Checklist

- [x] Product docs state P1 entry classes and Work Board placement.
- [x] Settings workspace tools read as low-frequency management, not random settings.
- [x] Work Board remains reachable but is not promoted to primary sidebar in P1.
- [x] AI Teammates page does not show full Council management.
- [x] Council Workspace remains fully reachable.
- [x] Contextual repair links still open the right tools.
- [x] No AppShell business logic added.
- [x] Settings teammate tool is renamed to `Teammate Management` / `队友管理`.

## Implementation Evidence

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts`
- `corepack pnpm --filter @ling-stack/web test:e2e -- teammates.spec.ts councils.spec.ts media-jobs.spec.ts`
- `corepack pnpm --filter @ling-stack/web exec playwright test channel.spec.ts --grep "global sidebar keeps fixed chrome"`
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts`
- `corepack pnpm --filter @ling-stack/web test:e2e -- approvals.spec.ts work-board.spec.ts dark-mode.spec.ts model-workbench.spec.ts channel.spec.ts`

## Risks

- Work Board docs and current P1 strategy disagree on primary-nav placement; this plan
  intentionally defers promotion.
- It is easy to "fix" IA by hiding useful routes. P1 should clarify routes, not remove
  them.
- Large file risk remains in `AppShell.tsx`, `i18n.tsx`, and sidebar/settings pages.

## Assumptions

- P1 is allowed to change labels, descriptions, and tests.
- P1 is not allowed to change daemon contracts or storage.
- Desktop Web remains the only acceptance target.

## Open Questions

- Should Settings workspace tools be grouped visually in P1, or is copy tightening enough?
- Should Work Board promotion require usage evidence or a separate product decision?
