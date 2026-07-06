# Product UX System P5 Next Inventory

## Summary

This document fills the P5 inventory gap after the first implementation slice. The first
slice already landed shared presentation primitives and adopted them in image
generation, automations, Settings workspace tools, sidebar menus, and channel / AI
teammate creation dialogs. P5-A/B/C have now been implemented locally; keep this
inventory as the pre-implementation rationale and use the implementation plan evidence
section for the current shipped state. A later desktop QA pass found that Image
Generation and Automations still need a status-semantics follow-up for counts, grouping,
and action wording; see [P5 Status Semantics Follow-up](product-status-semantics-p5-followup.md).

The next P5 work should not start by changing code. The remaining target surfaces need a
clear inventory and slice order because several owners are large files. The most valuable
next slice is Model Workbench, followed by Council Workspace and Work Board. Conversation
surfaces should remain mostly deferred unless a narrow shared-state issue appears.

## Inventory Result

| Surface | Current P5 state | Main gap | Proposed owner | Large-file risk | P5 priority |
| --- | --- | --- | --- | --- | --- |
| Image Generation | First slice adopted `PageActionHeader`, `OperationEmptyState`, `StatusActionRow`, and `DialogSection`. | Status grouping still mixes runnable stored states with active/in-progress language; buttons need start/retry/generating wording. | `features/media/*` view-models and focused CSS. | Low after extraction. | Follow-up needed |
| Automations | First slice extracted create dialogs and adopted shared header, empty state, status rows, and scheduler strip. | Header and scheduler strip still blur enabled definitions, scheduled watches, and recent run health. | `AutomationCreateDialogs`, `AutomationExecutionInspector`, `AutomationListPane`, `automation-view-models`. | Medium, but page is now 356 lines. | Follow-up needed |
| Settings workspace tools | First slice adopted `StatusActionRow` and preserved legacy selectors. | No immediate UX gap; keep as reference implementation. | `SettingsWorkspaceToolsPanel`. | Medium because `settings.css` is large. | Done for now |
| Sidebar menus | First slice adopted `ActionMenuItem`. | No immediate UX gap; continue using fixed icon cell for future menus. | `SidebarNavigation` plus `action-menus.css`. | High if more behavior is added to `SidebarNavigation`. | Done for now |
| Channel creation | First slice adopted `CreateDialogShell` and `DialogSection`. | No immediate UX gap; keep channel runtime fields advanced. | `ChannelCreateDialog`. | Low. | Done for now |
| AI teammate creation | First slice adopted `CreateDialogShell` and `DialogSection`. | No immediate UX gap; keep recommended prefill but explicit create. | `TeammateCreateDrawer`. | Low. | Done for now |
| Model Workbench | Not migrated to P5 shared patterns. | Header, empty states, provider rows, route labels, check feedback, model import controls, and row menus are all in one large component. | Extract provider workbench components and view-model helpers before adopting shared UI. | High: `ProviderSettings.tsx` is over 1400 lines. | P5-A |
| Council Workspace | IA is correct, but visual language still uses local panels and inline create form. | Needs shared header, compact list/detail rows, cleaner create dialog, and consistent empty/member states. | `CouncilWorkspacePage`, `CouncilWorkspacePanels`, possible `CouncilCreateDialog`. | Medium: page + panels are about 1100 lines combined. | P5-B |
| Work Board | IA is correct and remains Settings/contextual, but page uses bespoke header, empty state, filters, and detail action layout. | Needs shared header/empty/action-row grammar without promoting Work Board to primary nav. | `GlobalWorkBoardPage`, `WorkItemRow`, focused `work-board.css` updates. | Medium/high: `GlobalWorkBoardPage.tsx` is over 800 lines. | P5-B |
| Home / normal conversation | Not migrated to P5 shared primitives. | First screen should remain conversation-owned; avoid blurring normal conversation with channel/private chat. | `ConversationHome` and conversation-specific helpers only. | High: `ConversationHome.tsx` is over 1000 lines. | P5-C, narrow only |
| Channels | Major interaction surfaces are already heavily covered by e2e; P5 first slice touched creation and feed background feedback only. | Do not use P5 to refactor channel shell. Only fix concrete empty/blocking/menu inconsistencies. | Focused channel components, not `WorkspaceClientView`. | Very high: `WorkspaceClientView.tsx` is over 4500 lines. | P5-C, narrow only |
| AI teammate private chat | Creation and IA are improved; private chat surface is still feature-owned. | Shared conversation visuals may be useful later, but teammate identity/model readiness must remain private-chat owned. | `TeammatePrivateChatSurface` and existing teammate subcomponents. | Medium: under 800 lines but close enough to avoid broad changes. | P5-C, narrow only |

## Findings

### P5-A: Model Workbench Is The Next Best Slice

Model Workbench is both user-visible and structurally risky. It still concentrates
provider list, editor, model discovery, import selection, row menus, status chips,
repair surfaces, and feedback in `ProviderSettings.tsx`.

P5 should first extract view and helper boundaries before visual adoption:

- `ProviderWorkbenchHeader` for title, counts, refresh, add, and batch check.
- `ProviderRouteList` for provider rows, route labels, row actions, and selection.
- `ProviderEditorPanel` for create/edit fields and save/check feedback.
- `ProviderModelImportPanel` for search, select visible, clear, and import selected.
- `provider-workbench-view-models.ts` for product labels, route summaries, status
  reasons, and check feedback mapping.

Use shared patterns after extraction:

- `PageActionHeader` for the workbench header.
- `OperationEmptyState` for no provider / no model / missing secret states.
- `StatusActionRow` for provider route rows when it does not hide route distinctions.
- `ActionMenuItem` for row menus.
- `DialogSection` only if the provider editor is shown as a dialog or drawer-like panel.

Hard stop: do not add more provider import/check logic directly to `ProviderSettings.tsx`.

### P5-B: Council Workspace And Work Board Are Good Second Slice Targets

Council Workspace and Work Board are lower risk than Model Workbench but still important
for operational trust. They should adopt shared header, empty, row, and dialog grammar
without changing IA.

Council Workspace:

- Keep full council list/detail only in Council Workspace.
- Convert inline create council form into `CreateDialogShell + DialogSection`.
- Use shared empty states for no councils, no selected council, no members, and no
  eligible teammates.
- Keep member management and channel policy domain logic in council feature files.

Work Board:

- Keep Work Board as a Settings workspace tool and contextual entry.
- Use `PageActionHeader` for title/summary/refresh in non-embedded mode.
- Use `OperationEmptyState` for filtered empty and no-work states.
- Evaluate `StatusActionRow` for Work Board rows only if row density and action grouping
  remain readable.
- Do not change work item derivation, claim/release/heartbeat behavior, or routing APIs.

### P5-C: Conversation Surfaces Need Narrow, Evidence-Led Work

Home conversation, channel conversation, and AI teammate private chat are not ready for a
shared shell migration under P5. They have different ownership rules and large state
surfaces.

Allowed P5-C work:

- Copy cleanup for blocked/empty/model states.
- Shared empty-state visual treatment only where it does not hide conversation
  ownership.
- Menu/icon alignment and disabled reason fixes.
- Screenshot/e2e coverage for horizontal overflow or repeated CTAs.

Hard stop: do not use P5 to refactor `WorkspaceClientView.tsx` or merge normal
conversation, channel, and private chat shells.

## Recommended Next Slice

Start with P5-A: Model Workbench route and status clarity.

Why:

- It is still a frequent source of product confusion: chat model vs generation model,
  one model through multiple routes, missing secret, and check result wording.
- It is the largest remaining UX surface that has not adopted shared P5 patterns.
- It has a clear extraction path that reduces architecture debt before visual changes.

Minimum landing scope:

- Extract provider workbench header, provider route list, model import panel, and
  provider editor section components.
- Adopt shared header, empty state, action menu, and compact row grammar where it does
  not reduce route clarity.
- Preserve multi-model import, search, select visible, clear selection, provider check,
  create/update/delete/toggle, and run repair behavior.

## Assumptions

- Desktop Web remains the only P5 acceptance target.
- No API, database, provider runtime, generation resolver, or Work Board routing changes
  are part of P5.
- Existing dirty worktree changes are preserved.
- P5 should reduce large-file risk; it should not use shared components as a reason to
  hide more logic in protected files.
