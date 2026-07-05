# Product Semantic Convergence P1 IA

## Summary

P1 makes Ling's information architecture read as one product instead of a set of
implementation modules. The design keeps the visible shell simple:

```text
primary workflows
  -> Inbox, Image Generation, Automations
work objects
  -> channels, AI teammates, recent conversations
workspace tools
  -> Model Workbench, Teammate Management, Council Workspace, Work Board
contextual escalations
  -> empty states, errors, and attention items link to the right tool
```

This is not a full route rewrite. It is a product-semantics pass over labels, entry
placement, return paths, and tests so users can predict where work lives.

## Goals

- Keep primary navigation focused on high-frequency workflows.
- Keep channels, teammates, and recent conversations as object lists, not generic modules.
- Make Settings workspace tools the stable home for lower-frequency setup and management.
- Keep AI Teammates scoped to individual teammate management; Council Workspace owns full
  council management.
- Keep Work Board available but do not promote it to primary navigation in P1.
- Make contextual links point to the right product surface: generation setup to Model
  Workbench, attention/work routing to Inbox or Work Board, council setup to Council
  Workspace, teammate setup to AI Teammates.

## Non-goals

- No daemon API change.
- No database or migration change.
- No route deletion.
- No full visual redesign.
- No AppShell/domain modularization in P1.
- No mobile acceptance scope.
- No decision to promote Work Board to primary navigation.

## Current Findings

- The primary sidebar already exposes Inbox, Image Generation, and Automations.
- Channels, AI teammates, and recent conversations already appear as work-object lists.
- Settings workspace tools already expose Model Workbench, Teammate Management, Council
  Workspace, Work Board, and approval strategy.
- AI Teammates already removed the full Council list and keeps only a lightweight Council
  Workspace entry.
- Existing Work Board docs describe Work Board as a top-level navigation item. For this
  P1 convergence slice, Work Board stays in Settings workspace tools and contextual links.
  That is an intentional current-product override, not a deletion of Work Board.

## IA Model

### Primary Workflows

These are first-level sidebar destinations because they are frequent work loops:

| Surface | User job | Boundary |
| --- | --- | --- |
| Inbox | Review attention, approvals, and work requiring a decision | Not the full work ledger |
| Image Generation | Create and run image/video generation tasks | Not model/provider setup |
| Automations | Create and control scheduled/repeatable AI work | Not raw scheduler diagnostics |

### Work Objects

These are durable objects the user opens repeatedly:

| Object | User job | Boundary |
| --- | --- | --- |
| Channel | Shared project/work room | Not a single private chat |
| AI teammate | Single teammate and private workspace | Not a council list |
| Recent conversation | Direct conversation with Ling Agent | Not teammate direct chat |

### Workspace Tools

These live under Settings because they are lower-frequency setup or management surfaces:

| Tool | User job | Boundary |
| --- | --- | --- |
| Model Workbench | Configure model/provider routes and readiness | Not a chat surface |
| Teammate Management | Manage individual AI teammates, models, and private chat settings | Not Council Workspace |
| Council Workspace | Manage multi-teammate councils | Not the AI teammate page |
| Work Board | Inspect cross-workspace work state | Not primary nav in P1 |
| Approval strategy | Configure default authorization behavior | Not the Inbox queue itself |

### Contextual Escalations

Contextual links may open workspace tools directly when a user is already in a relevant
state:

- No generation model -> Model Workbench.
- Chat/coding provider not ready -> Model Workbench.
- Inbox item needs work-state context -> Work Board.
- Council member setup -> AI Teammates.
- Teammate council participation -> Council Workspace.

These links are shortcuts, not new primary navigation categories.

## Hard Stops

- Do not add Work Board back to the primary sidebar in P1.
- Do not remove the Work Board route or contextual links.
- Do not put the full Council list back into the AI Teammates page.
- Do not hide Model Workbench behind a generic Settings label when an error/empty state
  needs a direct repair path.
- Do not merge conversation home, channel messages, and teammate private chat semantics.
- Do not add major logic to `AppShell.tsx`; route changes must be prop wiring only.
- Do not add new visible raw terms such as `raw job`, `metadata`, `transport`, `slice`,
  or `scheduler registry` to primary user flows.

## Module Boundaries

- `apps/web/src/features/navigation/SidebarNavigation.tsx`
  owns first-level sidebar labels and object-list actions.
- `apps/web/src/features/settings/SettingsWorkspaceToolsPanel.tsx`
  owns workspace tool rows, descriptions, counts, and actions.
- `apps/web/src/app/view-types.ts`
  owns high-level page titles/descriptions only.
- `apps/web/src/app/AppShell.tsx`
  owns route selection and prop wiring only.
- `apps/web/src/features/teammates/AiTeammatesPage.tsx`
  owns individual teammate management and the lightweight Council Workspace entry.
- `apps/web/src/features/councils/*`
  owns full council list, creation, cloning, member management, and channel attachment.
- `apps/web/src/features/work-board/*`
  owns Work Board data presentation, not primary nav placement.

## API / Types

- No new HTTP API.
- No contract change.
- No persistent state change.
- Existing `ViewId` values can remain. P1 changes where entry points are presented, not
  whether routes exist.

## State / Data Flow

```text
sidebar primary workflow click
  -> AppShell activeView
  -> feature page
```

```text
Settings workspace tool click
  -> AppShell settingsWorkspaceToolView
  -> nested workspace tool page
  -> Settings left navigation highlights the active workspace tool
```

```text
contextual repair/action link
  -> AppShell open target tool/view
  -> preserve current work state where possible
```

## Test Plan

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts`
- `corepack pnpm --filter @ling-stack/web test:e2e -- teammates.spec.ts councils.spec.ts`
- Add or update assertions for:
  - primary sidebar contains Inbox, Image Generation, and Automations;
  - Work Board is reachable from Settings workspace tools and contextual Inbox links;
  - AI Teammates page does not show `AI Councils` tab or full council list;
  - Council Workspace still manages multiple councils;
  - Model Workbench remains directly reachable from generation/provider repair states.

## Risks

- Older Work Board docs describe a top-level Work Board route; implementation must not
  treat those older lines as a P1 instruction.
- `AppShell.tsx` and `i18n.tsx` are large; copy and route wiring should stay minimal.
- Moving labels without tests can make sidebar regressions feel like "nothing changed"
  or "the feature disappeared".

## Assumptions

- P1 is a product-semantics and IA pass, not a full visual redesign.
- Work Board remains useful enough to keep, but not frequent enough to promote in P1.
- Desktop Web is the acceptance target.

## Open Questions

- In P2, should Work Board become a primary sidebar workflow after its daily usage is
  clearer?
- Should Settings workspace tools split into "Setup" and "Operations" groups, or stay a
  single compact list for now?
- Should Model Workbench keep its English product name in Chinese UI, or should the
  visible Chinese label become only "模型工作台"?
