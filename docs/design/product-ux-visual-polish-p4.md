# Product UX Visual Polish P4

## Summary

P4 starts after the product semantics pass. Ling should continue to read as a
local-first AI workspace: quiet, dense, scan-friendly, and honest about what each surface
can do. This is not a global redesign. It is a local UX and visual quality pass for the
surfaces where users still feel rough edges after P0/P1/P3.

The priority is to keep the current IA stable while improving everyday operations:
creation dialogs, generation task status, automation controls, sidebar menus, and desktop
layout stability.

## Goals

- Make channel and teammate creation share one clear dialog grammar.
- Replace misleading active generation wording in primary UI with "active / in progress"
  language while preserving durable status values.
- Make automation creation and scheduler controls quieter and easier to scan.
- Align sidebar object actions across channels, teammates, and recent conversations.
- Keep Settings stable and only fix concrete overflow, spacing, or row/subnav regressions.
- Stop adding UX polish directly into large cross-cutting files when a focused component
  or style module can own the change.

## Non-goals

- No backend API, contract, database, provider, media, or automation state-machine change.
- No new `ViewId`.
- No Work Board promotion to primary navigation.
- No mobile acceptance scope.
- No global visual redesign or new palette.
- No behavior changes to provider checks, media runtime resolution, scheduler runtime, or
  archive persistence.

## Product Rules

- One intent, one visible primary action per local surface.
- Creation flows show basic fields first and keep advanced policy/configuration collapsed.
- Empty, blocked, disabled, and active states must tell the user what they can do next.
- Runtime terms such as raw ids, transport, metadata, and adapter details stay in
  diagnostics or detail panels, not in primary task flows.
- "Queued" may remain a stored status, but task workbench summaries should use "Active" or
  "In progress" when they group queued/running/recoverable work.

## Target Surfaces

| Surface | P4 job | Boundary |
| --- | --- | --- |
| Channel create | Create a named shared work room and optionally invite teammates | Advanced runtime policy stays collapsed |
| AI teammate create | Create one teammate from a recommended role/model | Does not manage councils |
| Image Generation | Create, run, inspect, and retry generation tasks | Does not configure providers inline |
| Automations | Create repeatable work and control scheduler visibility | Does not rewrite scheduler behavior |
| Sidebar | Open objects and archive/hide them predictably | Does not delete data |
| Settings | Keep P3 sections stable and readable | No IA move in P4 |

## Module Boundaries

- `apps/web/src/shared/components/CreateDialogShell.tsx`
  owns the shared creation dialog frame, overlay, header, body, and footer.
- `apps/web/src/styles/creation-dialogs.css`
  owns shared channel/teammate creation dialog styling.
- Feature pages own domain-specific fields and callbacks.
- Media and automation view-model helpers own product labels and derived display state.
- `AppShell.tsx` remains route and modal mounting only.

## Hard Stops

- Do not add Work Board back to primary sidebar.
- Do not reintroduce full council lists into AI Teammates.
- Do not show generation models in chat/provider selectors.
- Do not add major behavior to `AppShell.tsx`, `AutomationsPage.tsx`,
  `SidebarNavigation.tsx`, `i18n.tsx`, `components.css`, `settings.css`, or
  `teammates.css` without extracting first.
- Do not make Check success the source of truth for whether a generation task will run.

## Acceptance Checklist

- [x] P4 design and implementation docs exist and are linked from Product Semantic
      Convergence.
- [x] Channel create and teammate create share the same dialog shell and have no desktop
      horizontal overflow.
- [x] Generation task summary and filter use Active/In progress language for grouped
      queued/running work.
- [x] Generation task disabled run buttons expose a clear reason.
- [x] Automation scheduler strip is visually quieter and creation flow hides advanced
      RRULE behind advanced settings.
- [x] Sidebar section menus and row actions align icons, labels, hover, focus, and click
      areas.
- [x] Settings remains on the P3 IA and shows no desktop horizontal overflow.

## Implementation Evidence

- Web typecheck passed with `corepack pnpm --filter @ling-stack/web typecheck`.
- E2E passed for `app.spec.ts channel.spec.ts teammates.spec.ts`.
- E2E passed for `media-jobs.spec.ts`; the wider media/automation/settings/dark-mode batch
  passed after updating old media status assertions, with automations, settings, and dark-mode
  green in the combined run.
- Desktop dev-server visual checks at `1440x960` and `1280x800` found no horizontal overflow
  on home, image generation, generation create dialog, automations, channel create, or teammate
  create.

## Risks

- Existing CSS import order can make shared dialog selectors override too broadly.
- `AutomationsPage.tsx` is already large; extraction should happen before adding more
  modal behavior.
- E2E assertions may still encode old labels such as `Queued`.

## Assumptions

- Desktop Web is the acceptance target.
- Current P0/P1/P3 semantic convergence is the baseline.
- P4 should be small and local enough to review without a broad shell refactor.
