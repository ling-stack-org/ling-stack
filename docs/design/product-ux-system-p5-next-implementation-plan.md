# Product UX System P5 Next Implementation Plan

## Summary

Continue P5 after the first shared-component adoption slice. The next work should be
planned as three independent implementation slices:

1. P5-A: Model Workbench route, status, and import clarity.
2. P5-B: Council Workspace and Work Board operational consistency.
3. P5-C: narrow conversation-surface polish only where evidence shows a concrete UX
   mismatch.

This plan does not change backend APIs, database schema, provider/media/automation/work
item state machines, navigation IA, or `ViewId`.

## Goals

- Finish the P5 inventory requirement with concrete owners and priorities.
- Continue adopting shared display primitives without creating a large design-system
  framework.
- Reduce large-file pressure by extracting feature components before visual migration.
- Keep product semantics stable: Model Workbench configures routes, Council Workspace
  manages councils, Work Board inspects work, conversations remain conversation-owned.

## Non-goals

- No P2 AppShell/domain modularization.
- No Work Board promotion to primary navigation.
- No model/provider runtime behavior changes.
- No media generation adapter work.
- No Council data model changes.
- No mobile acceptance.

## Key Changes

### P5-A: Model Workbench

- Extract focused components from `ProviderSettings.tsx` before adding UI behavior:
  - `ProviderWorkbenchHeader`
  - `ProviderRouteList`
  - `ProviderRouteRow`
  - `ProviderEditorPanel`
  - `ProviderModelImportPanel`
- Add `provider-workbench-view-models.ts` or an equivalent helper for:
  - route label,
  - capability label,
  - readiness/check label,
  - disabled reason,
  - missing secret wording,
  - import selection summary.
- Adopt shared primitives:
  - `PageActionHeader` for the workbench title/counts/actions.
  - `OperationEmptyState` for no providers, no fetched models, and missing secret
    blockers.
  - `StatusActionRow` for provider rows only if it still shows provider route and model
    distinction clearly.
  - `ActionMenuItem` for provider row menus.
- Preserve all existing behavior:
  - add/edit/save/delete/toggle provider,
  - check one provider,
  - batch check,
  - fetch models,
  - search models,
  - select visible,
  - clear selection,
  - import selected,
  - repair run,
  - same model through multiple base URLs.

### P5-B: Council Workspace And Work Board

- Council Workspace:
  - Use `PageActionHeader` for the page title, counts, refresh, and create action.
  - Convert create council from inline form to `CreateDialogShell + DialogSection`.
  - Use `OperationEmptyState` for no councils, no members, no eligible teammates, and no
    channel policy target.
  - Keep member list/detail logic feature-owned.
- Work Board:
  - Use `PageActionHeader` for non-embedded page header and keep Settings return mode.
  - Use `OperationEmptyState` for filtered empty, no active work, and empty detail guide.
  - Evaluate `StatusActionRow` for `WorkItemRow`; keep the existing row if status/action
    density gets worse.
  - Keep filters compact and avoid horizontal overflow at desktop widths.

### P5-C: Conversation Surfaces

- Do not refactor conversation shells.
- Only address concrete, test-backed issues:
  - duplicated primary actions,
  - empty/blocked copy,
  - disabled reason visibility,
  - menu icon/text alignment,
  - horizontal overflow,
  - dark-mode hardcoded surfaces.
- Avoid adding major behavior to `ConversationHome.tsx`, `WorkspaceClientView.tsx`, or
  `TeammatePrivateChatSurface.tsx`. Extract a narrow component first if needed.

## Module Boundaries

| Area | Allowed files | Protected files / rule |
| --- | --- | --- |
| Model Workbench | New `features/providers/*` components and helpers, focused provider CSS if needed | Do not add more major logic to `ProviderSettings.tsx` before extraction |
| Council Workspace | New council dialog/list/detail components, existing `CouncilWorkspacePanels` with focused changes | Keep full council list out of AI Teammates page |
| Work Board | `GlobalWorkBoardPage`, `WorkItemRow`, focused work-board CSS | Do not move Work Board to primary nav |
| Conversation surfaces | Narrow feature components only | Do not refactor `WorkspaceClientView.tsx` under P5 |
| Shared UI | `shared/components`, `page-shells.css`, `operation-states.css`, `action-menus.css`, `creation-dialogs.css` | Shared components must stay presentational |
| i18n | Copy keys only | No control flow or product rules in `i18n.tsx` |

## API / Types

- No HTTP API changes.
- No contract or database changes.
- No route/ViewId changes.
- New TypeScript types may be added only for frontend view-model props or extracted
  component props.
- Existing provider and work item domain helpers remain the source of truth for runtime
  state.

## Test Plan

P5-A Model Workbench:

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- model-workbench.spec.ts`
- `corepack pnpm --filter @ling-stack/web test:e2e -- media-jobs.spec.ts app.spec.ts`
- Verify:
  - model route labels still distinguish same model across different base URLs,
  - search/select visible/clear/import selected all work,
  - chat-only providers stay out of generation runnable lists,
  - generation providers stay out of chat model selectors,
  - missing secret/check feedback remains clear.

P5-B Council Workspace and Work Board:

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- councils.spec.ts work-board.spec.ts settings.spec.ts dark-mode.spec.ts`
- Verify:
  - AI Teammates page does not show full council list,
  - Council Workspace still manages multiple councils and members,
  - Work Board remains Settings/contextual only,
  - empty states and detail actions stay product-facing,
  - dark mode uses tokens.

P5-C Conversation polish:

- Run only the focused spec for the touched surface plus:
  - `app.spec.ts`
  - `channel.spec.ts`
  - `teammates.spec.ts`
  - `dark-mode.spec.ts`
- Desktop browser check at `1440x960` and `1280x800` for touched surfaces.

## Risks

- `ProviderSettings.tsx` is already over 1400 lines; adding UI behavior there would make
  the next cleanup harder.
- `WorkspaceClientView.tsx` is over 4500 lines; P5 must not become a channel shell
  refactor.
- Work Board rows have dense domain actions. A generic row component could make them
  less readable if applied mechanically.
- Council Workspace create/member flows mix async state and local drafts; extraction must
  preserve save/error behavior.

## Hard Stops

- A change requires backend or persisted-state changes.
- A change needs a new route or `ViewId`.
- Work Board must move to primary navigation.
- Provider runtime/generation resolver behavior must change to complete a visual slice.
- Shared components need domain imports.
- A protected large file would gain major behavior without extraction.

## Assumptions

- P5-A should be implemented first.
- P5-B can follow after P5-A lands and passes focused e2e.
- P5-C should remain opportunistic and evidence-led.
- Desktop Web is the only acceptance scope.

## Implementation Evidence

Status: implemented locally; focused typecheck and e2e validation passed.

- P5-A extracted Model Workbench presentation into `ProviderWorkbenchHeader`,
  `ProviderRouteList`, `ProviderEditorPanel`, `ProviderModelImportPanel`, and
  `provider-workbench-view-models.ts`. `ProviderSettings.tsx` now keeps state,
  effects, save/check/import orchestration, and repair wiring only.
- P5-A adopted `PageActionHeader`, `OperationEmptyState`, and `ActionMenuItem`.
  Provider rows remain table-based because route/base URL/model distinction is
  more important than forcing a generic row shape.
- P5-B adopted `PageActionHeader`, `OperationEmptyState`, `CreateDialogShell`,
  and `DialogSection` in Council Workspace. Full council management remains only
  in Council Workspace.
- P5-B adopted `PageActionHeader` and `OperationEmptyState` in Work Board. Work
  Board remains Settings/contextual only, and dense `WorkItemRow` actions remain
  feature-owned.
- P5-C was limited to concrete conversation popover polish: compact empty-result
  styling for slash command and model search menus. `WorkspaceClientView.tsx`,
  `ConversationHome.tsx`, and `TeammatePrivateChatSurface.tsx` were not refactored.

Verification so far:

- `corepack pnpm --filter @ling-stack/web typecheck` passed after P5-A/B/C.
- `corepack pnpm --filter @ling-stack/web test:e2e -- model-workbench.spec.ts media-jobs.spec.ts app.spec.ts` passed: 29 tests.
- `corepack pnpm --filter @ling-stack/web test:e2e -- councils.spec.ts work-board.spec.ts settings.spec.ts dark-mode.spec.ts` passed: 18 tests.
- `corepack pnpm --filter @ling-stack/web test:e2e -- channel.spec.ts` passed: 93 tests.
- `corepack pnpm --filter @ling-stack/web test:e2e -- teammates.spec.ts` passed: 16 tests.
- Playwright CLI desktop walkthrough on the live Vite dev server at `http://127.0.0.1:5173/` found no document/body horizontal overflow on home, Settings workspace tools, Model Workbench, and Work Board at `1440x960`, and no overflow on Model Workbench / Work Board at `1280x800`.
