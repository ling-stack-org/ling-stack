# Product Semantic Convergence

## Related Docs

- [Product Semantic Convergence P1 IA](product-semantic-convergence-p1-ia.md)
- [Product Semantic Convergence P1 Implementation Plan](product-semantic-convergence-p1-implementation-plan.md)
- [Product UX Visual Polish P4](product-ux-visual-polish-p4.md)
- [Product UX Visual Polish P4 Implementation Plan](product-ux-visual-polish-p4-implementation-plan.md)
- [Product UX System P5](product-ux-system-p5.md)
- [Product UX System P5 Implementation Plan](product-ux-system-p5-implementation-plan.md)
- [Product UX System P5 Next Inventory](product-ux-system-p5-next-inventory.md)
- [Product UX System P5 Next Implementation Plan](product-ux-system-p5-next-implementation-plan.md)
- [Settings Semantic Convergence P2](settings-semantic-convergence-p2.md)
- [Settings Semantic Convergence P3](settings-semantic-convergence-p3.md)
- [Settings Semantic Convergence P3 Implementation Plan](settings-semantic-convergence-p3-implementation-plan.md)
- [Conversation Surface Taxonomy](conversation-surface-taxonomy.md)
- [Provider Generation Runtime Resolver](provider-generation-runtime.md)
- [AI Councils](ai-councils.md)
- [Work Board, Review Queue, and Inline Approval Boundaries](work-board-review-queue.md)

## Summary

Ling should read as a local-first AI workspace, not as a chat shell, model settings
screen, or collection of internal diagnostic tables. This document defines the product
language and information-architecture boundary for the current convergence slice.

The near-term goal is to make visible surfaces tell the truth about what the product can
do now: conversations and channels coordinate work, AI teammates and councils organize
agents, Model Workbench configures model routes, generation tasks produce image/video
artifacts through connected adapters, automations run scheduled work, and Inbox/Work
Board handle attention and operational history.

## Goals

- Use user-facing nouns that match actual product jobs.
- Remove stale "slice", "metadata only", "raw job", and "not real generation" language
  from primary UI when the capability is now connected.
- Expose existing scheduler start/stop controls in Automations.
- Keep Model Workbench, Council Workspace, and Work Board understandable as workspace
  tools rather than random settings pages.
- Preserve conversation surface ownership: normal conversation, channel, topic reply,
  teammate private chat, and work/session threads must not share one overloaded meaning.
- Keep this slice frontend-first and additive: no daemon API, database, or state-machine
  change.

## Phase Status

| Phase | Scope | Status |
| --- | --- | --- |
| P0 | Product-truth copy and existing scheduler controls | Implemented |
| P1 | IA and entry-point convergence | Implemented |
| P2 | Long-term shell/domain modularization and possible Work Board promotion | Roadmap only |
| P4 | Local UX and visual polish after semantic convergence | Implemented |
| P5 | Cross-surface UX systemization and operational visual consistency | Implemented first slice |

## Non-goals

- No full visual redesign.
- No AppShell/domain modularization in this slice.
- No mobile acceptance scope.
- No new generation adapter, automation scheduler behavior, or provider contract.
- No deletion or migration of existing user data.

## Navigation Semantics

Primary navigation should focus on frequent work:

- Inbox: things requiring attention or decisions.
- Image Generation: create and run image/video generation tasks.
- Automations: create scheduled or repeatable AI work and control the local scheduler.
- Channels, AI teammates, and recent conversations: work objects, not generic modules.

Settings workspace tools should hold lower-frequency management surfaces:

- Model Workbench: configure model/provider routes and readiness.
- Teammate Management: manage individual AI teammates, models, and private chat settings.
- Council Workspace: manage multi-teammate councils.
- Work Board: inspect cross-workspace work state until it graduates to a primary route.

P1 refines this into four entry classes:

- Primary workflows: high-frequency work surfaces in the main sidebar.
- Work objects: channels, teammates, and conversations as durable user-owned objects.
- Workspace tools: lower-frequency setup and management in Settings.
- Contextual escalations: deep links from empty/error/attention states to the right tool.

## Product Language Rules

- Prefer "generation task" over "media job" in primary UI.
- Prefer "configure generation model" over "provider/media transport" in primary UI.
- Prefer "from conversation" over "through chat" for automation creation.
- Prefer "enabled" over "running" for automation definitions. Running belongs to runs.
- Keep raw ids, raw metadata, route diagnostics, and adapter details inside diagnostics,
  detail panels, logs, or support surfaces.
- When a capability is recognized but not runnable, say what the user can do next or why
  Ling cannot run it yet.

## Module Boundaries

- `apps/web/src/app/view-types.ts`
  owns high-level page titles and descriptions only.
- `apps/web/src/features/media/*`
  owns generation task list/detail/create UI and generation-oriented wording.
- `apps/web/src/features/automations/*`
  owns automation list/detail/create UI and scheduler controls.
- `apps/web/src/features/settings/SettingsWorkspaceToolsPanel.tsx`
  owns low-frequency workspace tool entry points.
- `docs/design/conversation-surface-taxonomy.md`
  remains the boundary for normal conversation, channel, topic reply, teammate private
  chat, and durable work/session threads.

`AppShell.tsx` should remain route and prop wiring. New business logic should land in
feature components, view-model helpers, or domain hooks.

## Hard Stops

- Do not move teammate private chat into normal conversation storage.
- Do not show generation-only models in conversation/chat model selectors.
- Do not describe an enabled automation definition as an actively running run.
- Do not make Check success the source of truth for generation runtime availability.
- Do not hide or remove existing Model Workbench, Council Workspace, Work Board, Inbox,
  generation, or automation functionality.
- Do not add major new behavior to already-large files without extracting first.

## Route Map

| Area | Product meaning | Current placement |
| --- | --- | --- |
| Conversations | Direct user-to-Ling Agent work conversation | recent conversations + home surface |
| Channels | Shared project/work room | sidebar object list |
| AI Teammates | Single teammate management and private workspaces | sidebar object list |
| Teammate Management | Low-frequency teammate setup and management | settings workspace tool |
| Council Workspace | Multi-teammate council management | settings workspace tool |
| Model Workbench | Model/provider route setup and readiness | settings workspace tool |
| Image Generation | Image/video generation task workspace | primary sidebar |
| Automations | Scheduled and repeatable AI work | primary sidebar |
| Inbox | Attention and approval queue | primary sidebar |
| Work Board | Cross-workspace operational ledger | settings workspace tool for this slice |

## Risks

- `AppShell.tsx`, `i18n.tsx`, `AutomationsPage.tsx`, `components.css`, and
  `teammates.css` are large and easy to make worse with small "just one more" changes.
- Existing e2e tests may still encode old copy such as hidden scheduler controls.
- Some docs still use "media job" as an API/storage term; that is acceptable in API
  documentation but not as the primary product label.

## Assumptions

- Desktop Web is the acceptance target.
- Product truth matters more than exposing implementation names.
- This slice may update wording and wiring but should not alter persistence or runtime
  state machines.
