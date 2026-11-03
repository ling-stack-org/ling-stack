# Web Modularization

## Purpose

This document records the implemented behavior-preserving Web UI modularization and its
remaining ownership boundaries. Source status was checked on 2026-11-02; it does not
claim a fresh browser regression run.

The original pressure points were a single `App.tsx` coordinating state, pages, API
calls, and helpers, plus a monolithic stylesheet. The current shape is:

- `App.tsx` is an entry component; `app/AppShell.tsx` wires feature pages and domain
  controllers and retains cross-feature coordination.
- Presentation lives under `features/`, domain hooks under `domains/`, and pure helpers
  under `lib/`.
- `styles.css` aggregates ordered shared-package and Web styles. Desktop loads the same
  built Web client.

This is a behavior-preserving refactor. It is not a redesign.

## Original Slice Goals

- Keep the current visual direction and behavior unchanged.
- Split the Web UI into feature modules with explicit props and local helpers.
- Keep daemon API, routes, request bodies, and response shapes unchanged.
- Keep existing Playwright selectors and visible labels stable.
- Create reusable surfaces for the desktop shell.
- Avoid introducing a router, global state manager, or new dependency in this slice.

## Original Target Structure

This sketch records the initial extraction, not the complete current tree. Domain
controllers, feature pages, shared packages, and styles have since evolved beyond it.

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

`styles.css` is now the ordered Web style import surface. `main.tsx` imports this
aggregate and loads KaTeX CSS separately; the historical `forms.css` placeholder in the
sketch is not a current file.

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

## Original Migration Order

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

Current source ownership:

- `App.tsx` is now a thin entry component; the coordinator lives in
  `app/AppShell.tsx`.
- View copy is centralized in `app/view-types.ts`.
- Local storage, channel policy conversion, provider readiness/conversion, approval
  helpers, artifact helpers, event-data helpers, run evidence helpers, and tool constants
  live under `lib/`.
- Generic UI pieces `MetaRow`, `StatusBadge`, `AvatarInitial`, and
  `RunRepairHintBanner` live under `shared/components/`.
- Sidebar navigation lives under `features/navigation/`.
- AI teammate, Model Workbench, approval inbox, Media Jobs, Settings, Runs, and Workspace
  presentation live under their respective `features/` directories.
- State, loading, and mutation logic have also moved into domain hooks, including
  `useTeammatesDomain`, `useProvidersDomain`, `useApprovalsDomain`, `useMediaDomain`,
  `useSettingsDomain`, `useRunsDomain`, and `useWorkspaceDomain` under `domains/`.
- `AppShell` retains navigation, domain wiring, stream coordination, and cross-feature
  handoffs. Domain extraction is not complete.
- `ApprovalCard` is exported for run detail and inline pending approval surfaces.
- `ArtifactRow` lives under `shared/components/` because run evidence and media jobs both
  render artifact links.
- `styles.css` imports shared UI package styles and Web styles under `styles/`,
  `styles/features/`, `styles/shared/`, and `styles/app/` in a defined order. The original
  flat file list and reserved `forms.css` placeholder no longer describe this tree.
- Goal 2 is complete: feature presentation has moved out of `AppShell`, and CSS has a
  stable modular entry structure.

Follow-up implementation and remaining boundaries:

- [Web AppShell Domain Modularization](web-appshell-domain-modularization.md) defines
  domain-owned state controllers, concurrency rules, refresh/cache policy, stream
  lifecycle, and migration exit criteria. Page-level lazy loading, domain hooks, and
  typed `DomainEvent` handling are implemented. Cross-domain event handling remains in
  `AppShell.handleDomainEvent`, not a separate `AppEventRouter`; this is not a claim that
  all migration exit criteria are met.
- [Web API Facade Modularization](web-api-facade-modularization.md) owns the API boundary.
  `apps/web/src/api.ts` is already a compatibility barrel; request builders, form
  adapters, and domain endpoint wrappers now live under `apps/web/src/api/`.
- Source/test anchors: `apps/web/src/app/lazy-pages.tsx`,
  `apps/web/src/app/domain-events.ts`, `apps/web/src/domains/`,
  `apps/web/src/styles.css`, `apps/web/e2e/ui2-app-shell-state.spec.ts`, and
  `apps/web/e2e/api-adapters.spec.ts`.

## Non-Goals

These non-goals describe the original refactor scope, not features absent from the
current repository. Contracts extraction and Desktop have their own implementations.

- No daemon API changes.
- No visual redesign.
- No new state manager.
- No new routing library.
- No contracts package extraction in this slice.
- No desktop implementation.

## Web E2E Structure Guidance

The Web E2E suite is already split between `apps/web/e2e/app.spec.ts` and domain specs.
These tests run Playwright against the real Vite Web client, while daemon calls to
`http://127.0.0.1:17891/**` are mocked through shared support route handling. Treat them
as browser-level Web contract tests, not full daemon-process integration tests.

Shared support lives under `e2e/support/`, but its internal extraction remains partial:
`mock-state.ts` and `test-helpers.ts` re-export from `mock-daemon.ts`. Further splits
should establish support ownership without changing selectors, mock behavior, or setup
order.

Refactor the e2e structure incrementally when there is a real maintenance trigger:

- a new feature would add a large block of unrelated scenarios to `app.spec.ts`,
- merge conflicts in the file become frequent,
- mock daemon changes repeatedly affect unrelated domains,
- a domain can move cleanly with its helpers and fixtures, such as channel, workspace,
  runtime, model workbench, settings, external work, or media jobs.

The shared support entrypoints already exist:

```text
apps/web/e2e/
  app.spec.ts
  support/
    mock-daemon.ts
    mock-state.ts
    test-helpers.ts
```

Domain specs already include:

```text
apps/web/e2e/channel.spec.ts
apps/web/e2e/workspace.spec.ts
apps/web/e2e/runtime.spec.ts
apps/web/e2e/model-workbench.spec.ts
apps/web/e2e/settings.spec.ts
apps/web/e2e/external-work.spec.ts
apps/web/e2e/media-jobs.spec.ts
```

Each split must preserve visible labels, aria labels, CSS selectors used by tests, and
mock daemon response semantics unless the same change intentionally updates the affected
tests and product behavior.

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
- Web remains the reference client loaded by the implemented Electron shell.
