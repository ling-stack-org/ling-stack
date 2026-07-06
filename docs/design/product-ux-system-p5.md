# Product UX System P5

## Related Docs

- [P5 First Implementation Plan](product-ux-system-p5-implementation-plan.md)
- [P5 Next Inventory](product-ux-system-p5-next-inventory.md)
- [P5 Next Implementation Plan](product-ux-system-p5-next-implementation-plan.md)
- [P5 Status Semantics Follow-up](product-status-semantics-p5-followup.md)
- [P5 Status Semantics Follow-up Implementation Plan](product-status-semantics-p5-followup-implementation-plan.md)
- [Product UX Priorities P6](product-ux-priorities-p6.md)
- [Product UX Priorities P6 Implementation Plan](product-ux-priorities-p6-implementation-plan.md)
- [P7 Usage Closure](product-ux-usage-closure-p7.md)
- [P7 Usage Closure Detailed Design](product-ux-usage-closure-p7-detailed-design.md)
- [P7 Usage Closure Implementation Plan](product-ux-usage-closure-p7-implementation-plan.md)

## Summary

P5 follows the P4 local polish pass. The goal is to stop treating UX quality as
one-off page fixes and define a reusable, operational UX system for Ling's desktop Web
product.

Ling should keep reading as a local-first AI workspace: quiet, dense, scan-friendly, and
action-oriented. P5 is not a new visual identity, not a marketing redesign, and not the
P2 shell or navigation refactor. It is a cross-surface contract for how pages, actions,
states, dialogs, menus, and scroll regions should behave before further feature work
adds more UI.

Current status: first implementation slice completed on 2026-07-03 for shared display
components, image generation, automations, Settings workspace tools, sidebar action
menus, and channel / AI teammate creation dialogs. Later QA found that Image Generation
and Automations still need a status-semantics follow-up so stored states, scheduler
counts, and user-facing action labels do not contradict the user's next decision. The
remaining target surfaces should adopt these patterns incrementally rather than
reopening IA or backend behavior.

## Goals

- Make the first screen of every primary work surface explain the user job and the next
  action without exposing implementation vocabulary.
- Define shared UX rules for page headers, primary actions, list/detail workspaces,
  empty and blocked states, status badges, creation dialogs, action menus, scroll
  boundaries, and dark mode.
- Turn the P4 dialog/menu/status improvements into reusable component and style
  boundaries.
- Keep future UX work out of large cross-cutting files unless a focused extraction lands
  first.
- Preserve the current IA while improving visual consistency and interaction quality.

## Non-goals

- No backend API, contract, database, provider, media, automation, or scheduler behavior
  change.
- No new `ViewId`.
- No Work Board promotion to primary navigation.
- No AppShell/domain modularization in P5.
- No new global palette, typography system, animation system, or marketing-style visual
  redesign.
- No mobile acceptance scope.

## Product Language

Primary UI should use product nouns and outcomes:

- "Generation task" instead of "media job" in user-facing workflows.
- "Configure generation model" instead of provider transport or adapter language.
- "Enabled automation" for automation definitions; "running" belongs to runs.
- "Scheduled automation" for definitions watched by the scheduler; manual enabled
  automations are runnable but not scheduler watches.
- "From conversation" for automation creation sourced from a chat/conversation.
- "Workspace tools" for lower-frequency setup surfaces in Settings.

Technical language may remain only where it is diagnostic evidence or exact
configuration:

- Raw ids, transport, adapter, metadata, slice, run internals, and storage names belong in
  diagnostics, detail panels, logs, or support surfaces.
- Details may expose exact API concepts when users are configuring that system, such as
  MCP, GitHub, Linear, model provider, or runner.

## UX Rules

### Page Headers

- Header title names the work surface, not the implementation module.
- Supporting text summarizes count/status/action in one line.
- The right side has one primary action. Secondary actions use icon or compact buttons.
- Do not duplicate the same action in the page header and an adjacent empty state unless
  the empty state is the only visible content.

### Work Surfaces

- Dense operational pages should prefer list/detail or grouped rows over decorative
  cards.
- Lists must keep row height stable when status badges, action icons, or loading state
  appear.
- Detail panes should explain the selected object, primary action, artifacts/output, and
  failure reason without requiring a second panel.
- Scroll belongs to the content pane or list pane, not the whole app shell.

### Empty, Blocked, and Disabled States

- Empty states say what is missing and provide the one next action.
- Blocked states say the cause and where to fix it.
- Disabled buttons must expose a reason through visible helper text, `title`, or aria
  text when the reason is not obvious from nearby copy.
- Success feedback can be lightweight and short-lived. Errors, blockers, and destructive
  warnings persist until resolved or dismissed.

### Creation Dialogs

- Creation flows use the shared grammar introduced in P4: title, short description,
  basic fields first, role/member selection next, advanced configuration collapsed, and
  one footer primary CTA.
- Dialogs must not create horizontal overflow at `1440x960` or `1280x800`.
- Advanced settings contain model, runtime policy, permissions, scheduling internals, or
  prompt details.
- Dialogs should not silently create durable data from ambiguous side-menu actions.

### Menus and Icon Actions

- Sidebar and row menus use a fixed icon cell and aligned text baseline.
- Icon-only actions use stable hit areas and tooltips or aria labels.
- Hover and focus states must not disable the target the user is trying to click.
- Archive/hide actions must keep current non-destructive semantics.

### Status and Feedback

- Status badges use product labels where the user is deciding what to do next.
- Stored states may keep backend names, but primary UI should map them to user-facing
  labels such as Ready, Active, Succeeded, Failed, or Needs attention.
- Count summaries must not mix stored states with product buckets. If a stored state is
  runnable but not actually running, primary UI should say ready to start, not active or
  in progress.
- Loading state is scoped to the initiated action unless the whole surface is blocked.

### Dark Mode

- P5 keeps the existing token system and does not introduce a new palette.
- New components must use existing semantic tokens and pass the same desktop checks in
  light and dark mode.
- Do not add one-off hardcoded light surfaces inside dark mode.

## Target Surfaces

| Surface | P5 focus |
| --- | --- |
| Home and conversation | First-screen clarity, model/action state, duplicate reply/action avoidance |
| Channels | Header/action stability, progress surfaces, composer overlays, branch/menu consistency |
| AI teammate private chat | Shared conversation visuals, guidance states, private workspace context |
| Image Generation | List/detail clarity, creation dialog consistency, runnable/blocked model states |
| Automations | Creation flow, scheduler strip, enabled/run distinction, detail actions |
| Settings | Workspace tool rows, subnav consistency, no horizontal overflow |
| Model Workbench | Provider route clarity, multi-model actions, generation/chat capability labels |
| Council Workspace | Council list/detail and member actions without leaking into AI Teammates page |
| Work Board | Contextual workspace tool status without primary nav promotion |

## Surface Inventory Contract

P5 implementation starts with an inventory pass. The inventory is not a bug dump; it is
the design contract for each surface before shared components are extracted.

| Surface | User job | First-screen contract | Primary action | Empty or blocked state | Scroll owner | Component boundary |
| --- | --- | --- | --- | --- | --- | --- |
| Home and conversation | Start or continue work with Ling Agent | Conversation area, composer, selected model state, and recent context are visible without setup jargon | Send message | No conversation history should invite a first message, not a settings detour | Message thread | Conversation shell and composer stay outside P5 shared components unless duplicated in channels/private chat |
| Channels | Coordinate work in a durable room | Channel title, progress context, members/teammates, messages, and composer remain stable when popovers open | Send message or create channel when empty | No channels state opens the same create dialog used by channel actions | Message thread and sidebar object list | Channel create dialog may adopt shared creation dialog sections |
| AI teammate private chat | Work directly with one teammate | Teammate identity, model readiness, private thread, and management affordance are clear | Send message or create teammate when empty | No teammate state opens teammate create flow; model missing state routes to Model Workbench | Private thread and teammate list | Shared conversation visuals can be reused, but teammate identity remains feature-owned |
| Image Generation | Create and run image/video generation tasks | Task list, detail output, model readiness, and create/run action communicate whether real generation can happen | Create generation task or configure generation model | Missing model routes to Model Workbench; unsupported model says recognized but not runnable | Task list and detail pane | Generation status labels and disabled reasons belong in media view-models |
| Automations | Create repeatable work and control scheduler | Enabled automations, recent runs, scheduler state, and create options are visible without mixing definitions and runs | Use template or create automation | No automations state offers template/manual/from conversation paths; scheduler stopped state offers start | Automation list and run/detail pane | Scheduler strip and creation sections can become shared only after feature extraction |
| Settings | Manage lower-frequency workspace setup | Workspace tools, profile/interface, permissions, integrations, skills, archive, and maintenance read as management rows | Open selected tool | Missing setup explains which tool fixes it; no generic diagnostics on first screen | Settings content pane | Workspace tool rows may adopt status/action row pattern |
| Model Workbench | Configure model routes and readiness | Provider routes, capability labels, check state, and multi-model import controls are visible and distinguish routes | Add provider or import selected models | No provider state explains route setup; missing secret state explains how to configure | Provider list and details | Capability labels use provider runtime helpers, not local UI guesses |
| Council Workspace | Manage multiple councils and members | Council list, selected council detail, members, health, and channel links stay inside council workspace | Create or clone council | No council state offers create/import only here, not in AI Teammates | Council list and detail pane | Council membership actions remain council-owned |
| Work Board | Inspect cross-workspace operational state | Work items, status filters, lineage, and context links show why work needs attention | Open item or related context | Empty state says there is no active work; it does not become a task creator | Work list and detail pane | Contextual entry only; no primary-nav assumptions |

The inventory for each surface must record evidence before implementation:

- Current first-screen screenshot source: dev server, built dist, or other served artifact.
- Product-language issues: stale internal terms, misleading status, or duplicate actions.
- Interaction issues: dead click targets, hover/focus instability, disabled actions without reasons.
- Layout issues: horizontal overflow, nested cards, unstable row height, scroll ownership.
- Large-file risk: whether the target page or CSS file is already protected by the Hard Stops.

## Shared Pattern Contracts

Shared patterns are allowed only when at least two surfaces need the same behavior. They
must stay presentational and accept feature-owned labels, actions, and disabled reasons.

### PageActionHeader

Purpose:

- Provide a consistent title, one-line summary, optional status, and one primary action.
- Reduce duplicated header/empty-state CTAs.

Use for:

- Image Generation, Automations, Settings tool panels, Council Workspace, Work Board.

Do not use for:

- Message thread headers that need live participant/model/composer state.

Design contract:

- Left side: title, summary, optional compact status.
- Right side: one primary action, then secondary icon or compact actions.
- Primary action must expose disabled reason when unavailable.
- Header must not become a card inside a card.

### OperationEmptyState

Purpose:

- Standardize empty, blocked, and configuration-required states.

Use for:

- No generation model, no tasks, no automations, no provider routes, no archived items,
  no work-board items.

Design contract:

- One short title names the missing object or blocker.
- One sentence says what happens after the user fixes it.
- One primary action points to the exact fixing surface.
- Optional secondary action can be dismiss/help only; no action clusters.

### StatusActionRow

Purpose:

- Align status badge, short reason, and row-level actions in dense operational lists.

Use for:

- Provider routes, generation tasks, automation rows, workspace tool rows, inbox/work
  items.

Design contract:

- Stable row height and fixed action area.
- Status label is product-facing; diagnostic detail can appear in title/details.
- Row loading state belongs to the action that initiated it.
- Rows with the same model but different route must show the route label.

### DialogSection

Purpose:

- Keep create/edit dialogs readable without bespoke nested layout for every feature.

Use for:

- Channel create, AI teammate create, automation create, generation task create, provider
  import flows where applicable.

Design contract:

- Sections are ordered: essentials, participants/role/model, optional behavior, advanced.
- Advanced starts collapsed unless it contains a required validation error.
- Footer has one primary CTA and at most one neutral cancel/secondary action.
- Dialog content owns vertical scroll; page shell behind it does not shift.

### ActionMenuItem

Purpose:

- Normalize icon/text alignment and destructive/non-destructive semantics for row menus.

Use for:

- Sidebar object menus, list row menus, provider/automation/generation item actions.

Design contract:

- Fixed icon cell, text baseline alignment, stable hit area, and aria label.
- Archive/hide actions must not use delete language unless data is actually deleted.
- Hover/focus styles must not remove pointer events from the visible target.

## Visual Density And Interaction Standards

P5 keeps Ling dense and calm. It does not introduce a new visual identity.

- Radius: keep existing token radius; cards and repeated rows should stay at 8px or less
  unless the existing component already uses a smaller value.
- Row density: dense rows should target a stable 36-44px minimum hit area, with icon
  cells large enough for native controls.
- Icon sizing: row/action icons should use one local size per component, usually 16px or
  18px, centered in a fixed cell.
- Button hierarchy: one primary action per surface section; secondary actions use compact
  buttons or icons with labels/tooltips.
- Scrollbars: list/detail panes own scroll; hover-only thin scrollbars must reserve space
  or use stable gutter so content does not shift.
- Horizontal overflow: no desktop surface may require horizontal page scroll at
  `1440x960` or `1280x800`.
- Cards: use cards for repeated items or modal content only. Do not nest cards to create
  page sections.
- Dark mode: use existing semantic tokens only. New components need light/dark parity
  before adoption.

## P5 Acceptance Matrix

| Slice | Design evidence | Code evidence when implemented | Stop condition |
| --- | --- | --- | --- |
| Inventory | Surface table includes first-screen screenshot source and issue classification | No code changes required | Inventory reveals P2 route/shell change is needed |
| Shared boundaries | Pattern has two or more adoption targets and no domain logic | Component/CSS module is focused and covered by targeted e2e | Pattern starts absorbing feature state or runtime rules |
| Targeted adoption | Surface has before/after acceptance notes | Typecheck, focused e2e, and desktop screenshot checks pass | Change requires backend/API/state-machine work |

## Module Boundaries

- Shared presentational components belong under `apps/web/src/shared/components`.
- Feature-specific view-models own product labels and derived display state.
- Focused CSS modules should own new visual systems, for example `page-shells.css`,
  `operation-states.css`, or `action-menus.css`.
- Feature pages own domain callbacks and data wiring.
- `AppShell.tsx` remains route and modal mounting only.
- `i18n.tsx` receives copy keys only and must not become control flow.

## Hard Stops

- Do not implement P2 AppShell/domain modularization under P5.
- Do not move Work Board into primary navigation.
- Do not reintroduce full council management inside AI Teammates.
- Do not show generation-only providers in chat model selectors.
- Do not add major new behavior to `AppShell.tsx`, `AutomationsPage.tsx`,
  `SidebarNavigation.tsx`, `SkillLibrarySettingsPanel.tsx`, `i18n.tsx`,
  `components.css`, `settings.css`, `teammates.css`, or `sidebar.css` without first
  extracting a focused component or style module.
- Do not change runtime behavior while polishing product language or layout.

## Acceptance Checklist

- [x] P5 design and implementation docs exist and are linked from Product Semantic
      Convergence.
- [x] P5 inventory covers all target surfaces and records inconsistencies by surface.
- [x] Shared UI boundaries are proposed before any code adoption.
- [x] No P5 plan promotes Work Board or changes navigation IA.
- [x] Future implementation slices include typecheck, targeted e2e, and desktop
      dev-server screenshots at `1440x960` and `1280x800`.

## Assumptions

- Desktop Web remains the acceptance target.
- P4 is the current visual baseline.
- P5 is a UX-systemization track, not a broad visual redesign.
- P2 shell/domain modularization remains a separate roadmap track.
