# Web Modularization

## Purpose

This document records the next Web UI refactor plan. The goal is to make the Web client
maintainable before adding GitHub automation, persistent AI teammate management, plugin
management, and a future desktop shell.

Current pressure points:

- `apps/web/src/App.tsx` owns application state, page routing, feature components, API
  orchestration, UI helpers, and pure formatting helpers.
- `apps/web/src/styles.css` owns global layout, feature styles, form controls, and
  component-specific rules.
- More features will make this shape harder to test and harder to reuse in desktop.

This is a behavior-preserving refactor. It is not a redesign.

## Goals

- Keep the current visual direction and behavior unchanged.
- Split the Web UI into feature modules with explicit props and local helpers.
- Keep daemon API, routes, request bodies, and response shapes unchanged.
- Keep existing Playwright selectors and visible labels stable.
- Create reusable surfaces for the future desktop shell.
- Avoid introducing a router, global state manager, or new dependency in this slice.

## Target Structure

```text
apps/web/src/
  app/
    AppShell.tsx
    view-types.ts
    workspace-state.ts

  features/
    navigation/
    workspace/
    teammates/
    runs/
    providers/
    media/
    approvals/
    settings/

  shared/
    components/
    constants/
    icons/

  lib/
    approvals.ts
    artifacts.ts
    channels.ts
    formatting.ts
    local-storage.ts
    providers.ts
    run-evidence.ts
    runtime-state.ts

  styles/
    base.css
    layout.css
    forms.css
    navigation.css
    workspace.css
    teammates.css
    runs.css
    providers.css
    media.css
    approvals.css
    settings.css
```

`styles.css` should become the stable import surface for ordered CSS imports. Feature
styles are split after component extraction is stable. `styles.css` remains the only
import used by the Vite entrypoint.

## Feature Boundaries

| Feature | Owns | Does not own |
| --- | --- | --- |
| `navigation` | Sidebar, view buttons, channel shortcuts, pinned/hidden teammate rows | Run/task/provider mutations |
| `workspace` | Main workspace surface, channel/task composer, first-run flow, right context panel | Provider setup internals |
| `teammates` | AI teammate wizard, template filters, workflow preview, inspector | Persistent teammate DB schema |
| `runs` | Run history, run detail, timeline, artifacts, runtime audit, repair hints | Provider CRUD |
| `providers` | Model Workbench, provider form, template grouping, provider readiness helpers | Secret value access |
| `media` | Media job list/create/run, media artifact rows, media approval surfacing | Generic run artifact logic |
| `approvals` | Approval inbox, approval card, payload summary, repair panel | Approval policy settings |
| `settings` | Approval policy page | Runtime execution |

Shared components should stay small and generic: badges, meta rows, avatar initials,
empty states, field rows, and status chips.

## State Strategy

Keep `App.tsx` or `AppShell.tsx` as the coordinator during the first slice.

Rules:

- Feature components receive explicit props and callbacks.
- Cross-feature actions stay in the coordinator, for example opening Model Workbench from
  a failed run or opening Approvals from workspace readiness.
- Pure helpers move to `src/lib` first.
- Feature-local transient state can live inside feature components when it is not shared.
- Do not introduce Redux, Zustand, React Router, or another state/routing library in this
  refactor.

## Migration Order

1. Move pure constants, formatters, provider readiness helpers, approval helpers, artifact
   helpers, and local-storage helpers out of `App.tsx`.
2. Extract shared stateless components such as `StatusBadge`, `MetaRow`, `AvatarInitial`,
   and simple icon helpers.
3. Extract `navigation`.
4. Extract feature pages in this order: `teammates`, `providers`, `approvals`, `media`,
   `runs`, `workspace`, `settings`.
5. Split CSS after component imports are stable.
6. Keep class names and aria labels stable unless each affected test is updated in the
   same change.

## Implementation Status

Current slice:

- `App.tsx` is now a thin entry component; the coordinator lives in
  `app/AppShell.tsx`.
- View copy is centralized in `app/view-types.ts`.
- Local storage, channel policy conversion, provider readiness/conversion, approval
  helpers, artifact helpers, event-data helpers, run evidence helpers, and tool constants
  live under `lib/`.
- Generic UI pieces `MetaRow`, `StatusBadge`, `AvatarInitial`, and
  `RunRepairHintBanner` live under `shared/components/`.
- Sidebar navigation lives under `features/navigation/`.
- AI teammate presentation now lives under `features/teammates/`; local draft state,
  default skill pack wiring, sidebar coordination, and pin/hide/delete callbacks stay in
  `AppShell`.
- Model Workbench presentation now lives under `features/providers/`; provider CRUD,
  check, batch check, repair handoff, and rerun coordination stay in `AppShell`.
- Approval inbox presentation now lives under `features/approvals/`; approval refresh,
  resolution, and repair-run routing stay in `AppShell`. `ApprovalCard` is exported for
  run detail and inline pending approval surfaces.
- Media Jobs presentation now lives under `features/media/`; media job load/create/run
  coordination stays in `AppShell`.
- `ArtifactRow` lives under `shared/components/` because run evidence and media jobs both
  render artifact links.
- Settings approval policy presentation now lives under `features/settings/`; approval
  policy load/save, workspace path, loading, and error coordination stay in `AppShell`.
- Runs presentation now lives under `features/runs/`; run loading, selection, rerun,
  approval resolution, provider repair, and task repair routing stay in `AppShell`.

- Workspace presentation now lives under `features/workspace/`; channel/task
  coordination, run orchestration, provider selection, and repair handoffs stay in
  `AppShell`.
- `styles.css` is now an ordered import surface for `styles/base.css`, `forms.css`,
  `navigation.css`, `workspace.css`, `runs.css`, `media.css`, `providers.css`,
  `settings.css`, `approvals.css`, `layout.css`, `teammates.css`, and `components.css`.
  The split preserves the previous cascade order; `forms.css` is intentionally reserved
  for later form-control refinement.
- Goal 2 is complete: feature presentation has moved out of `AppShell`, and CSS has a
  stable modular entry structure.

## Non-Goals

- No daemon API changes.
- No visual redesign.
- No new state manager.
- No new routing library.
- No contracts package extraction in this slice.
- No desktop implementation.

## Test Plan

Run after each meaningful extraction:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web exec playwright test
git diff --check
```

Regression coverage must preserve:

- Workspace readiness and repair hints.
- Channel runtime policy creation/edit visibility.
- Paused channel disabled run actions.
- Run detail state-transition timeline.
- Language switch persistence.
- AI teammate wizard and sidebar pin/hide behavior.
- Workspace path persistence and daemon default fallback.
- Model Workbench readiness and repair flow.
- Task provider preflight filtering.
- Approval inbox pending/expired behavior.
- Approval policy settings load/save behavior.
- Run artifacts and media job artifacts.
- Media cost approval flow.

## Assumptions

- This refactor follows the existing client-style UI direction.
- The first success metric is behavior-preserving modularity, not smaller files at any
  cost.
- Web remains the reference client for the future desktop shell.
