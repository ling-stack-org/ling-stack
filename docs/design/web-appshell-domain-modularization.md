# Web AppShell Domain Modularization

## 1. Problem Statement

The Web client has already been split into feature presentation modules, but
`apps/web/src/app/AppShell.tsx` still owns most application state, side effects, and
cross-feature coordination.

Current shape:

```text
AppShell
  -> owns shell routing and layout
  -> owns workspace/channel/task/run/provider/teammate/media/mcp/approval state
  -> owns most API loading and mutation flows
  -> owns stream lifecycle
  -> owns cross-feature repair and refresh handoffs
  -> statically imports every major page
```

This creates two related problems:

1. Bundle growth. Vite/Rollup currently emits a large single application chunk because
   `AppShell` statically imports every major page and those pages import their full
   feature trees.
2. Coordination growth. `AppShell` is becoming a hidden global state container. Every
   new feature adds more state variables, refresh functions, mutation handlers, and
   cross-domain callbacks.

The bundle warning is the visible symptom. The deeper issue is unclear ownership between
domains.

## 2. Goals And Non-Goals

### Goals

- Keep current behavior, daemon API contracts, labels, and visual design stable.
- Make `AppShell` responsible for layout, view selection, and explicit cross-domain
  event routing only.
- Move domain state and domain side effects into typed domain controllers.
- Add page-level lazy loading so inactive views do not inflate the initial JavaScript
  chunk.
- Define a typed `AppEventRouter` contract so domains do not import or mutate each
  other.
- Add concurrency rules for stale responses, duplicate events, stream lifecycle, and
  workspace changes.
- Keep backend state as the source of truth. The Web refactor must not invent a second
  durable state model.
- Make every slice independently shippable and revertible.

### Non-Goals

- No Redux, Zustand, Jotai, React Router, TanStack Router, or new state/routing
  dependency in this plan.
- No daemon API changes.
- No visual redesign.
- No optimistic side effects in the first domain-controller slices.
- No global pub/sub event bus.
- No URL deep-link implementation in the first slice.
- No conversion of feature presentation components back into smart data loaders.

## 3. Target Architecture

Target shape:

```text
App
  -> AppShell
     -> useShellDomain()
     -> useWorkspaceDomain()
     -> useRunsDomain()
     -> useApprovalsDomain()
     -> useTeammatesDomain()
     -> useProvidersDomain()
     -> useMediaDomain()
     -> useMcpDomain()
     -> handleDomainEvent(event)
     -> LazyPageRenderer
        -> WorkspacePage
        -> RunsPage
        -> ApprovalsPage
        -> TeammatesPage
        -> ProvidersPage
        -> SettingsPage
        -> MediaPage
        -> McpPage
```

`AppShell` remains the coordinator, but it should no longer own domain internals.

### Directory Layout

```text
apps/web/src/
  app/
    AppShell.tsx
    lazy-pages.tsx
    domain-events.ts
    shell-domain.ts
    domain-controller.ts
    view-types.ts

  domains/
    workspace/
      use-workspace-domain.ts
      workspace-domain-types.ts
    runs/
      use-runs-domain.ts
      runs-domain-types.ts
    approvals/
      use-approvals-domain.ts
      approvals-domain-types.ts
    teammates/
      use-teammates-domain.ts
      teammates-domain-types.ts
    providers/
      use-providers-domain.ts
      providers-domain-types.ts
    media/
      use-media-domain.ts
      media-domain-types.ts
    mcp/
      use-mcp-domain.ts
      mcp-domain-types.ts

  features/
    workspace/
    runs/
    approvals/
    teammates/
    providers/
    settings/
    media/
    mcp/
```

Domain files own data and actions. Feature files remain presentation components.

### Shared Controller Shape

Every domain hook should return a consistent controller shape:

```ts
export interface DomainController<TState, TActions> {
  readonly state: TState;
  readonly actions: TActions;
  readonly refresh: () => Promise<void>;
  readonly isLoading: boolean;
  readonly error: DomainError | undefined;
  readonly clearError: () => void;
}
```

Domain controllers may expose additional focused refresh methods when a full refresh is
too broad:

```ts
export interface RunsActions {
  readonly selectRun: (runId: string) => Promise<void>;
  readonly refreshSelectedRun: () => Promise<void>;
  readonly refreshRunList: () => Promise<void>;
  readonly startRun: (request: unknown, options?: RunStartOptions) => Promise<void>;
  readonly cancelRun: (run: RunSession) => Promise<void>;
  readonly rerun: (run: RunSession) => Promise<void>;
}
```

Avoid a single untyped `dispatch(action: unknown)` API. Explicit method names keep call
sites readable and make slice migration easier.

## 4. Domain Ownership Matrix

Each domain must own a coherent slice of state and side effects. A domain can read
shared shell values such as `cwd`, active view, and selected ids through inputs, but it
must not mutate another domain directly.

| Domain | Owns | Does Not Own |
| --- | --- | --- |
| `shell` | active view, sidebar target, selected channel id, active teammate id, workspace cwd, sidebar collapse, global health, global error banner | runs, approvals, providers, workflows, teammate private data |
| `workspace` | channels, channel form/edit form, selected channel activity, tasks, task form/edit form, channel messages, channel files, channel protocol records, workflows and workflow steps, channel activity transitions | run event detail, provider CRUD, approval inbox, teammate private settings |
| `runs` | run list, selected run id, selected run, run events, run artifacts, assistant text derivation, runtime state for selected run, work-unit detail, run start/cancel/rerun, stream lifecycle | approval inbox ownership, provider settings, channel messages |
| `approvals` | approval inbox, selected approval id, resolving approval ids, approval policy loading/saving if settings is not split separately | run event loading, provider repair state, workflow state |
| `providers` | provider presets, templates, provider forms, check results, batch check state, repair focus, secret fetch status | run execution, approval resolution, MCP tool state |
| `teammates` | teammate roster, teammate create/update/delete, teammate channel memberships, teammate private messages, private attachments, teammate skills, memory scopes, teammate MCP bindings | channel protocol state, provider CRUD internals, run event detail |
| `media` | media jobs, media job artifacts, media form, media job run lifecycle | generic run artifacts, provider settings |
| `mcp` | MCP server list, tool discovery, server check/sync/delete/save busy state | teammate MCP binding ownership, approval policy |
| `externalWork` | external work status, CI triage records, workflow setup, secret setup, poll/reconcile/start/stop actions | generic workspace workflow orchestration, provider state |

### Ownership Rules

- A domain can accept read-only input from another domain through `AppShell`.
- A domain can emit a typed event after user intent or mutation success.
- A domain cannot call another domain controller directly.
- A domain refresh cannot emit a domain event.
- Shared derived view models should live in `lib/` only when they are pure and do not
  mutate state.

### Current AppShell Mapping

Current `AppShell` state can be grouped as follows:

| Current State Group | Target Domain |
| --- | --- |
| `activeView`, `activeSidebarTarget`, `channelSidebarOpen`, `daemonHealthy`, `form.cwd` | `shell` |
| `channels`, `selectedChannelId`, `channelForm`, `tasks`, `channelMessages`, `channelWorkflows` | `workspace` |
| `runs`, `run`, `events`, `artifacts`, `activeRunId`, `lookupRunId`, `resourceLeases`, `workUnits` | `runs` |
| `approvals`, `resolvingApprovals`, `approvalPolicy`, `approvalPolicyForm` | `approvals` or `settings` |
| `providers`, `providerTemplates`, `providerForm`, `providerCheck`, `editingProviderId` | `providers` |
| `aiTeammates`, teammate memberships, teammate private state | `teammates` |
| `mediaJobs`, `mediaJobArtifacts`, `mediaJobForm` | `media` |
| `mcpServers`, `mcpTools`, MCP busy state | `mcp` |
| external work status, CI triage, action details | `externalWork` |

## 5. AppEventRouter Contract

The Web app needs a communication mechanism, but it should be explicit event routing,
not free-form pub/sub.

### Event Flow

```text
User action or mutation succeeds inside a domain
  -> domain emits typed DomainEvent
  -> AppShell handles event in one switch statement
  -> AppShell calls explicit domain actions
  -> domains reload from daemon state
```

### Event Type

`apps/web/src/app/domain-events.ts` should define all cross-domain events:

```ts
export type DomainEvent =
  | { readonly type: "workspace.cwdChanged"; readonly cwd: string }
  | { readonly type: "view.openRequested"; readonly view: ViewId; readonly target?: SidebarTarget }
  | { readonly type: "run.started"; readonly runId: string; readonly channelId?: string; readonly taskId?: string }
  | { readonly type: "run.completed"; readonly runId: string; readonly channelId?: string; readonly taskId?: string }
  | { readonly type: "run.cancelled"; readonly runId: string; readonly channelId?: string; readonly taskId?: string }
  | { readonly type: "run.selected"; readonly runId: string }
  | { readonly type: "approval.resolved"; readonly approvalId: string; readonly runId?: string; readonly workflowStepId?: string }
  | { readonly type: "approval.policyUpdated" }
  | { readonly type: "provider.repairRequested"; readonly providerPresetId?: string; readonly sourceRunId?: string }
  | { readonly type: "task.repairRequested"; readonly taskId: string; readonly sourceRunId?: string }
  | { readonly type: "workflow.created"; readonly workflowId: string; readonly channelId: string }
  | { readonly type: "workflow.advanced"; readonly workflowId: string; readonly channelId: string; readonly runId?: string }
  | { readonly type: "workflow.cancelled"; readonly workflowId: string; readonly channelId: string; readonly runIds: readonly string[] }
  | { readonly type: "workflowStep.retried"; readonly workflowId: string; readonly workflowStepId: string; readonly channelId: string; readonly runId?: string }
  | { readonly type: "channel.messageSent"; readonly channelId: string }
  | { readonly type: "channel.filesChanged"; readonly channelId: string }
  | { readonly type: "teammate.updated"; readonly teammateId: string }
  | { readonly type: "mediaJob.started"; readonly mediaJobId: string }
  | { readonly type: "mediaJob.completed"; readonly mediaJobId: string }
  | { readonly type: "mcp.changed"; readonly serverId?: string }
  | { readonly type: "externalWork.changed"; readonly channelId?: string };
```

Events should be additive. Do not remove an event while a migration slice still depends
on it.

### Router Implementation

`AppShell` owns the router:

```ts
function handleDomainEvent(event: DomainEvent): void {
  switch (event.type) {
    case "workspace.cwdChanged":
      shell.actions.setWorkspaceCwd(event.cwd);
      workspace.actions.resetForCwd(event.cwd);
      runs.actions.resetForCwd(event.cwd);
      approvals.actions.resetForCwd(event.cwd);
      providers.actions.resetForCwd(event.cwd);
      teammates.actions.resetForCwd(event.cwd);
      media.actions.resetForCwd(event.cwd);
      mcp.actions.resetForCwd(event.cwd);
      void refreshInitialWorkspace(event.cwd);
      return;

    case "approval.resolved":
      void Promise.all([
        approvals.refresh(),
        event.runId ? runs.actions.refreshRun(event.runId) : runs.actions.refreshSelectedRun(),
        workspace.actions.refreshRuntimeForCurrentChannel(),
      ]);
      return;

    case "provider.repairRequested":
      shell.actions.openView("providers");
      providers.actions.focusProvider(event.providerPresetId);
      return;

    case "workflow.advanced":
    case "workflow.cancelled":
    case "workflowStep.retried":
      void Promise.all([
        workspace.actions.refreshChannelProtocol(event.channelId),
        workspace.actions.refreshChannelActivity(event.channelId),
        runs.actions.refreshRunList(),
        approvals.refresh(),
      ]);
      return;
  }
}
```

### Router Rules

- The router is the only place where one domain action can cause another domain action.
- Domains receive `emitEvent: (event: DomainEvent) => void` as an input.
- Domains do not subscribe to events directly.
- Events should represent completed user intent or completed mutation, not passive data
  loading.
- Refresh functions must not emit domain events.
- Event handlers can run refreshes in parallel, but should avoid direct writes to another
  domain's private state.
- Event handlers should be small. If a handler exceeds a few lines, move orchestration
  into a shell helper, not into a domain.

### Event Handler Table

| Event | Router Action |
| --- | --- |
| `workspace.cwdChanged` | reset all domains, abort stale requests/streams, refresh health/providers/channels/teammates/runs/approvals |
| `run.started` | open/select run when appropriate, refresh run list, refresh approvals, refresh workspace task/channel activity |
| `run.completed` | refresh selected run, run list, approvals, used memory, workspace task/channel activity |
| `run.cancelled` | refresh selected run, run list, approvals, runtime, workspace task/channel activity |
| `approval.resolved` | refresh approvals, selected run or target run, workspace runtime/activity |
| `provider.repairRequested` | open Providers view, focus provider, remember source run id for repair panel |
| `task.repairRequested` | open Workspace view, select task/channel, focus task edit surface |
| `workflow.created` | refresh channel protocol and activity |
| `workflow.advanced` | refresh channel protocol, workflow steps, runs, approvals |
| `workflow.cancelled` | refresh channel protocol, workflow steps, runs, approvals, runtime |
| `workflowStep.retried` | refresh workflow steps, runs, approvals |
| `channel.messageSent` | refresh channel messages and activity |
| `channel.filesChanged` | refresh channel files and link previews |
| `teammate.updated` | refresh teammates and affected memberships |
| `mediaJob.started` | refresh media jobs and approvals |
| `mediaJob.completed` | refresh media jobs and job artifacts |
| `mcp.changed` | refresh MCP servers/tools and affected teammate bindings if visible |
| `externalWork.changed` | refresh external work status and channel activity |

## 6. Concurrency Rules

The router is stable if it is explicit and latest-wins. It becomes risky if it turns
into a global pub/sub bus.

### Rules

1. Mutation success may emit a domain event.
2. User navigation may emit a domain event.
3. Passive refresh may not emit a domain event.
4. Polling tick may not emit a domain event.
5. Each domain loader must be latest-wins.
6. Workspace cwd change must abort in-flight requests and active streams owned by the
   previous cwd.
7. Stream completion must not overwrite newer selected state.
8. Duplicate events must be safe. Repeated refreshes may cost extra GETs but must not
   corrupt state.
9. The backend remains the concurrency authority through state machines, CAS,
   idempotency keys, approval gates, and resource leases.
10. The first implementation should avoid optimistic cross-domain state writes.

### Latest-Wins Loader Pattern

Each domain should keep a request sequence per logical resource:

```ts
function useLatestRequestGuard() {
  const seqRef = useRef(0);
  return {
    next(): number {
      seqRef.current += 1;
      return seqRef.current;
    },
    isCurrent(seq: number): boolean {
      return seq === seqRef.current;
    },
  };
}
```

Usage:

```ts
const runLoadGuard = useLatestRequestGuard();

async function refreshRun(runId: string): Promise<void> {
  const seq = runLoadGuard.next();
  const [run, events, artifacts] = await Promise.all([
    getRun(runId, cwd),
    getRunEvents(runId, cwd),
    listRunArtifacts(runId, cwd),
  ]);
  if (!runLoadGuard.isCurrent(seq)) {
    return;
  }
  setSelectedRun(run);
  setEvents(events.events);
  setArtifacts(artifacts.artifacts);
}
```

### Abort Policy

Use `AbortController` where the underlying operation supports it:

- SSE run streams.
- Future fetch wrappers if the api client accepts `signal`.
- Page-local searches or previews.

For current api-client methods that do not accept `signal`, use latest-wins guards.

### Coalescing Policy

Do not add a full scheduler in Slice 1. Add local coalescing only after duplicate refresh
cost becomes visible.

Minimal helper:

```ts
function createRefreshCoalescer(refresh: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  return () => {
    if (!inFlight) {
      inFlight = refresh().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  };
}
```

Use only for broad refreshes such as `approvals.refresh()` or `workspace.refresh()`.
Avoid coalescing selected-resource loads unless the resource id is part of the key.

### Cycle Prevention

The following is forbidden:

```text
refreshRuns()
  -> emits run.updated
  -> AppShell handles run.updated
  -> refreshRuns()
```

Only mutation completions and user intent emit events.

## 7. Refresh, Cache, And Freshness Policy

The Web app should be correct first and fast second. Initial domain slices should rely
on daemon state after mutations rather than optimistic local patching.

### Workspace CWD

`cwd` is the strongest cache boundary.

When cwd changes:

- abort active run stream,
- reset selected run and selected work-unit detail,
- clear channel messages, files, workflows, tasks, and external work status,
- clear selected approval and resolving approval map,
- clear provider repair state,
- clear media job selection,
- refresh health and baseline domain data for the new cwd.

Do not let data from the previous cwd remain visible in a domain after reset.

### View Switching

Switching views should preserve the last loaded domain state, but may trigger a targeted
freshness refresh.

| View | On Open |
| --- | --- |
| Workspace | refresh channels, runs, approvals, used memory, selected channel data |
| Runs | refresh run list and used memory; do not auto-load `/threads` unless user requests it |
| Providers | refresh provider templates and providers |
| MCP | refresh MCP servers and tools |
| Teammates | refresh teammates, channels, providers, MCP summary data |
| Media | refresh providers and media jobs |
| Approvals | refresh approvals |
| Settings | refresh approval policy and external work status |

### Mutation Freshness

| Mutation | Required Refresh |
| --- | --- |
| approve/deny approval | approvals, target run if any, channel activity/runtime if visible |
| start run | selected run, run list, approvals, workspace task/channel activity |
| cancel run | selected run, run list, approvals, runtime |
| create/edit/delete channel | channels, selected channel data if affected |
| create/edit/delete task | tasks, channel activity |
| send channel message | channel messages, channel activity |
| upload/delete channel file | channel files, link previews |
| start/orchestrate/cancel/retry workflow | channel protocol, workflow steps, runs, approvals, runtime |
| provider create/update/check | providers, provider templates if needed |
| teammate update | teammates, teammate memberships if affected |
| MCP server change | MCP servers/tools, teammate MCP bindings if visible |
| media job run | media jobs, approvals, media artifacts |

### Cache Scope

Use simple in-memory React state. Do not add persistent client cache in this plan.

Allowed cache:

- last loaded list per current cwd,
- selected resource detail,
- local form drafts,
- latest page state while view is hidden.

Not allowed:

- cross-cwd cache without explicit keying,
- client-side durable mutation queue,
- stale optimistic approvals,
- local replacement for daemon state machines.

## 8. Lazy Loading And Error Boundary

Page-level lazy loading is the first implementation slice because it reduces bundle
pressure without changing domain ownership.

### Lazy Page Module

Create `apps/web/src/app/lazy-pages.tsx`:

```tsx
import { lazy } from "react";

export const LazyWorkspaceClientView = lazy(() =>
  import("../features/workspace/index.js").then((module) => ({ default: module.WorkspaceClientView })),
);
export const LazyRunHistory = lazy(() =>
  import("../features/runs/index.js").then((module) => ({ default: module.RunHistory })),
);
export const LazySettingsPage = lazy(() =>
  import("../features/settings/index.js").then((module) => ({ default: module.SettingsPage })),
);
export const LazyAiTeammatesPage = lazy(() =>
  import("../features/teammates/index.js").then((module) => ({ default: module.AiTeammatesPage })),
);
export const LazyTeammateWorkspace = lazy(() =>
  import("../features/teammates/index.js").then((module) => ({ default: module.TeammateWorkspace })),
);
export const LazyProviderSettings = lazy(() =>
  import("../features/providers/index.js").then((module) => ({ default: module.ProviderSettings })),
);
export const LazyApprovalsPage = lazy(() =>
  import("../features/approvals/index.js").then((module) => ({ default: module.ApprovalsPage })),
);
export const LazyMediaJobsPage = lazy(() =>
  import("../features/media/index.js").then((module) => ({ default: module.MediaJobsPage })),
);
export const LazyMcpToolsPage = lazy(() =>
  import("../features/mcp/index.js").then((module) => ({ default: module.McpToolsPage })),
);
```

Keep `SidebarNavigation`, `StatusBadge`, `MetaRow`, small shell UI, and global CSS eager.

### Suspense Fallback

Use a feature-neutral panel fallback:

```tsx
function PageLoadingFallback(): JSX.Element {
  return (
    <section className="panel">
      <div className="empty-state compact-empty">
        <Loader2 className="spin" />
        <span>{t("Loading view...")}</span>
      </div>
    </section>
  );
}
```

Do not use a full-page skeleton that changes layout. Keep sidebar stable.

### Chunk Error Boundary

Add a small error boundary for lazy chunk load failures:

```tsx
class LazyPageErrorBoundary extends Component<Props, State> {
  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <section className="panel">
          <div className="inline-error">
            <CircleAlert size={17} />
            <span>Failed to load this view.</span>
          </div>
          <button type="button" className="secondary-button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}
```

### Preload Policy

Do not preload every page on startup. That would defeat the bundle split.

Allowed preloads:

- preload a page after sidebar hover/focus,
- preload likely next page after successful mutation, for example Providers after a
  provider repair request,
- preload Runs after a run starts.

Optional helper:

```ts
export function preloadRunsPage(): void {
  void import("../features/runs/index.js");
}
```

### Build Targets

- Initial JS entry should stay below Vite's default 500 KB warning threshold.
- Vendor chunks may exceed 500 KB only if separated and documented.
- Route chunks should target below 350 KB where practical.
- CSS warning is lower priority than JavaScript initial chunk size.

## 9. Streaming Policy

Streaming flows need special treatment because they are not ordinary request/refresh
cycles.

Current stream owners:

- direct run stream from `streamRun`,
- task/channel run stream through run start actions,
- teammate direct message stream,
- future workflow step live stream surfaces.

### Rules

- A stream belongs to exactly one domain.
- A stream has one active owner at a time.
- A stream may update that domain's local active item incrementally.
- A stream may emit a domain event only when it starts, completes, fails, or is cancelled
  by user intent.
- Stream deltas must not emit cross-domain events.
- CWD change aborts streams from the old cwd.
- Starting a new run stream aborts the previous active run stream unless later product
  work explicitly supports multiple concurrent visible streams.

### Run Stream Lifecycle

```text
runs.actions.startRun(request)
  -> confirm permissions if needed
  -> abort previous run stream
  -> clear selected run detail
  -> stream ready -> emit run.started
  -> stream delta -> append event locally only
  -> approval requested -> refresh approvals directly or emit approval.requested later
  -> stream done -> load durable run bundle
  -> emit run.completed or run.cancelled or run.failed
```

The terminal event should be based on durable `GET /runs/:id` after stream completion
when possible.

### Teammate Stream Lifecycle

```text
teammates.actions.sendDirectMessage()
  -> stream ready -> set pending assistant message id
  -> delta -> update private thread local message
  -> done -> refresh direct thread messages
  -> emit teammate.updated only if roster or metadata changed
```

Direct message deltas should not cause workspace or runs refreshes.

### Stale Stream Protection

Each stream should carry a local `streamId`:

```ts
const activeStreamIdRef = useRef("");

async function startStream(): Promise<void> {
  const streamId = crypto.randomUUID();
  activeStreamIdRef.current = streamId;
  await streamRun(..., (message) => {
    if (activeStreamIdRef.current !== streamId) {
      return;
    }
    appendEvent(message.event);
  });
}
```

This prevents late deltas from a cancelled stream from changing the current view.

## 10. Migration Plan

The migration should avoid one large refactor. Each slice must be small enough to review
and revert independently.

### Slice 1: Page Lazy Split

Scope:

- Add `app/lazy-pages.tsx`.
- Replace static page imports in `AppShell` with lazy imports.
- Add `Suspense` fallback and lazy page error boundary.
- Keep all current state and handlers in `AppShell`.

No behavior change.

Validation:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
git diff --check
```

Smoke:

- open Workspace,
- open Runs,
- open Settings,
- open Teammates,
- open Providers.

Exit criteria:

- initial JS chunk below 500 KB or a documented vendor-only exception,
- no visible layout jump while lazy page loads,
- no page-load console errors.

Implementation status:

- Implemented in `apps/web/src/app/lazy-pages.tsx` with React lazy imports,
  `Suspense`, and a lazy page error boundary.
- `ApprovalCard` and `EventRow` were split out of page modules so shared eager surfaces
  do not pull `ApprovalsPage` or `RunHistory` into the initial entry.
- Verified `corepack pnpm --filter @ling-stack/web typecheck`.
- Verified `corepack pnpm --filter @ling-stack/web build`.
- Build evidence: initial Web JS changed from `784.67 kB` to `429.55 kB`.
- No `manualChunks` fallback was needed.

### Slice 2: DomainEvent And AppEventRouter Skeleton

Scope:

- Add `app/domain-events.ts`.
- Add `handleDomainEvent` in `AppShell`.
- Thread `emitEvent` as a prop only where needed.
- Do not move domain state yet.
- Convert 2-3 obvious cross-feature callbacks to events:
  - provider repair request,
  - approval resolved,
  - workflow advanced.

Validation:

- same as Slice 1,
- approval approve/deny smoke,
- provider repair handoff smoke.

Exit criteria:

- event types are typed,
- router is a switch statement in one file,
- no domain imports another domain controller.

Implementation status:

- Implemented `apps/web/src/app/domain-events.ts` with typed `DomainEvent` and
  `EmitDomainEvent`.
- Added `handleDomainEvent()` in `AppShell` as the single switch for the first
  cross-domain event routes.
- Routed provider repair requests through `provider.repairRequested`.
- Routed approval resolution follow-up refresh through `approval.resolved`.
- Routed workflow advance/cancel/retry/status refresh through `workflow.*` and
  `workflowStep.*` events.
- State ownership is intentionally unchanged in this slice.
- Verified `corepack pnpm --filter @ling-stack/web typecheck`.

### Slice 3: Runs Domain

Scope:

- Add `domains/runs/use-runs-domain.ts`.
- Move run list, selected run, events, artifacts, runtime detail, active stream, and run
  actions from `AppShell`.
- Keep `useRunControl` either inside runs domain or wrap it with a runs-domain facade.
- Expose `RunsController` to `AppShell`.

Suggested types:

```ts
export interface RunsState {
  readonly runs: readonly RunSession[];
  readonly selectedRunId: string;
  readonly selectedRun: RunSession | undefined;
  readonly events: readonly RunEventEnvelope[];
  readonly artifacts: readonly RunArtifact[];
  readonly assistantText: string;
  readonly runtime: RuntimeState;
  readonly isRunning: boolean;
  readonly isLoading: boolean;
}

export interface RunsActions {
  readonly selectRun: (runId: string) => Promise<void>;
  readonly refreshRunList: () => Promise<void>;
  readonly refreshSelectedRun: () => Promise<void>;
  readonly refreshRun: (runId: string) => Promise<void>;
  readonly startRun: (request: unknown, options?: RunStartOptions) => Promise<void>;
  readonly cancelRun: (run: RunSession) => Promise<void>;
  readonly rerun: (run: RunSession) => Promise<void>;
  readonly resetForCwd: (cwd: string) => void;
}
```

Exit criteria:

- `AppShell` no longer imports `getRun`, `getRunEvents`, `listRuns`,
  `listRunArtifacts`, `streamRun`, or run runtime APIs directly.
- Runs page behavior unchanged.
- Stream abort and full-access confirmation still work.

Implementation status:

- Added `apps/web/src/app/domain-controller.ts`.
- Added `apps/web/src/lib/use-latest-request.ts`.
- Added `apps/web/src/domains/runs/use-runs-domain.ts`.
- Moved run list state, selected run, run events, run artifacts, assistant text,
  latest status derivation, stream lifecycle, run loading, run list refresh, and run
  cancellation control behind `RunsController`.
- `AppShell` now consumes `runsDomain.state` and `runsDomain.actions` instead of owning
  those run fields directly.
- Verified `corepack pnpm --filter @ling-stack/web typecheck`.
- Verified `corepack pnpm --filter @ling-stack/web build`.
- Follow-up seam resolved in Slice 5: channel artifact previews now load through
  `WorkspaceController`, so `AppShell` no longer imports `listRunArtifacts`.

### Slice 4: Approvals Domain

Scope:

- Add `domains/approvals/use-approvals-domain.ts`.
- Move approval list, selected approval, resolving map, approval policy if not kept in
  Settings, and approval resolution actions.
- Emit `approval.resolved` after successful approval/denial.

Suggested types:

```ts
export interface ApprovalsState {
  readonly approvals: readonly ApprovalRequest[];
  readonly selectedApprovalId: string;
  readonly resolving: Readonly<Record<string, ApprovalResolution>>;
  readonly isLoading: boolean;
}

export interface ApprovalsActions {
  readonly refresh: (options?: ListApprovalsOptions) => Promise<void>;
  readonly selectApproval: (approvalId: string) => void;
  readonly resolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => Promise<void>;
  readonly resetForCwd: (cwd: string) => void;
}
```

Exit criteria:

- `AppShell` no longer imports `listApprovals`, `approveApproval`, or
  `denyApproval` directly.
- Resolving state remains per approval id.
- Approval resolution refreshes run detail through `AppEventRouter`, not direct runs
  imports.

Implementation status:

- Added `apps/web/src/domains/approvals/use-approvals-domain.ts`.
- Moved approval inbox state, selected approval id, resolving map, external action
  details, external action busy state, approval refresh, approve/deny, and external
  action execute/cancel actions behind `ApprovalsController`.
- `AppShell` no longer imports `listApprovals`, `approveApproval`, `denyApproval`,
  `getExternalWorkAction`, `executeExternalWorkAction`, or
  `cancelExternalWorkAction` directly.
- Approval resolution emits `approval.resolved` through `handleDomainEvent`.
- Approval policy remains in Settings/AppShell for now; that is intentional because the
  policy edit surface has not moved into a Settings domain yet.
- Verified `corepack pnpm --filter @ling-stack/web typecheck`.
- Verified `corepack pnpm --filter @ling-stack/web build`.

### Slice 5: Workspace Domain

Scope:

- Add `domains/workspace/use-workspace-domain.ts`.
- Move channels, tasks, channel messages, files, protocol records, workflows, workflow
  steps, channel activity transitions, selected task, channel forms.
- Keep view-level composition in feature components.
- Emit events for workflow created/advanced/cancelled/retried, message sent, files
  changed, task repair requested.

Suggested subcontrollers inside workspace domain:

```text
workspace.channels
workspace.tasks
workspace.messages
workspace.files
workspace.protocol
workspace.workflows
workspace.activity
```

This domain is large. It can be split internally before leaving `AppShell` entirely.

Exit criteria:

- `AppShell` no longer imports channel/task/workflow APIs directly.
- selected channel reset rules are inside workspace domain.
- workflow actions refresh through explicit events.

Implementation status:

- Added `apps/web/src/domains/workspace/use-workspace-domain.ts`.
- Phase 1 moved channel/task ownership into `WorkspaceController`: channels,
  selected channel id, channel create/edit forms, task list, selected task id, task
  create/edit forms, and task run provider selection.
- Phase 2 moved the large selected-channel read model into `WorkspaceController`:
  messages with older-page loading, channel files/link previews, channel protocol
  records, workflows and workflow steps, channel run artifact previews, activity
  transitions, and used-memory audit.
- Workspace loaders use latest-wins keyed request guards so stale channel/cwd refreshes
  cannot overwrite newer selected-channel state.
- `resetForCwd()` and `resetSelectedChannelActivity()` now clear workspace-owned state
  on cwd/channel changes instead of leaving old channel data in `AppShell`.
- `AppShell` still owns channel/task/workflow mutation command composition where the
  command needs providers, runs, approvals, or teammate context. Those commands now
  mutate Workspace state through controller actions, and remain the next cleanup target
  before the strict "no channel/task/workflow API imports" exit criterion is fully met.
- Verified `corepack pnpm --filter @ling-stack/web typecheck`.
- Verified `corepack pnpm --filter @ling-stack/web build`.

### Slice 6: Providers Domain

Scope:

- Move provider list, templates, forms, check state, batch check, secret fetch, repair
  focus.
- Expose `focusProvider(providerPresetId?: string)`.
- Handle `provider.repairRequested` event.

Exit criteria:

- `AppShell` no longer imports provider CRUD/check APIs directly.
- provider repair from Runs opens Providers and focuses the right provider.

Implementation status:

- Added `apps/web/src/domains/providers/use-providers-domain.ts`.
- Moved provider list, templates, provider form/editing state, check result state,
  batch-check state, save success message, repair run focus, provider refresh,
  draft preflight, create/update/delete, provider check, batch check, and secret load
  behind `ProvidersController`.
- Provider save still applies the saved provider to the current run/channel through an
  `applyProviderToRun(provider)` callback owned by `AppShell`, so the Providers domain
  does not mutate Workspace state directly.
- `AppShell` no longer imports provider CRUD/check/list/secret APIs directly.
- Provider repair continues to route through `provider.repairRequested`, then
  `handleDomainEvent()` opens Providers and focuses the matching preset.
- Verified `corepack pnpm --filter @ling-stack/web typecheck`.
- Verified `corepack pnpm --filter @ling-stack/web build`.

### Slice 7: Teammates Domain

Scope:

- Move teammate roster, create/update/delete, pin/hide, memberships, private workspace
  refresh and private direct stream actions where practical.
- Keep `TeammateWorkspace` presentation local state local unless shared.

Because `TeammateWorkspace.tsx` is itself large, use two steps:

1. roster and sidebar ownership,
2. selected teammate private workspace ownership.

Exit criteria:

- `AppShell` no longer imports teammate CRUD or membership APIs directly.
- teammate updates refresh sidebar and selected teammate view through one domain.

Implementation status:

- Added `apps/web/src/domains/teammates/use-teammates-domain.ts`.
- Moved teammate roster state, loading state, teammate create/disable/hard-delete,
  settings update, pin/hide, teammate channel membership loading, and channel membership
  replacement behind `TeammatesController`.
- Creation setup remains complete: template defaults, default channel memberships,
  default skills, and memory scopes are applied in the domain before refreshing the
  roster.
- `AppShell` no longer imports teammate CRUD or membership APIs directly.
- Shell view changes are explicit callbacks (`openTeammate`, `closeTeammateIfActive`),
  so the Teammates domain does not own navigation state.
- `TeammateWorkspace.tsx` private-workspace local state intentionally remains in the
  feature component for this slice.
- Verified `corepack pnpm --filter @ling-stack/web typecheck`.
- Verified `corepack pnpm --filter @ling-stack/web build`.

### Slice 8: Media, MCP, External Work Domains

Scope:

- Move remaining lower-coupled domains:
  - media jobs,
  - MCP servers/tools,
  - external work status and CI triage.

Exit criteria:

- `AppShell` has no direct media/MCP/external-work API imports.
- Settings and Workspace receive domain controllers as props.

Implementation status:

- Added `apps/web/src/domains/media/use-media-domain.ts`.
- Added `apps/web/src/domains/mcp/use-mcp-domain.ts`.
- Added `apps/web/src/domains/external-work/use-external-work-domain.ts`.
- Moved media job list, artifact loading, media form, selected job, create job, and
  run job actions behind `MediaController`; approval follow-up remains a callback into
  Approvals.
- Moved MCP server/tool list, busy state, add/save/check/sync/delete actions behind
  `McpController`.
- Moved external work status, CI triage, workflow setup, token configure/delete, and
  poll/reconcile/start/stop actions behind `ExternalWorkController`.
- `AppShell` no longer imports media, MCP, or external-work APIs directly.
- Verified `corepack pnpm --filter @ling-stack/web typecheck`.
- Verified `corepack pnpm --filter @ling-stack/web build`.

### Slice 9: AppShell Shrink Pass

Scope:

- Remove unused derived state from `AppShell`.
- Move remaining pure derived selectors into domain files or `lib/`.
- Keep `AppShell` limited to:
  - `useShellDomain`,
  - domain controller creation,
  - event router,
  - view rendering,
  - full-access modal wiring if not moved to runs domain.

Exit criteria:

- `AppShell.tsx` line count reduced materially from the current 4000+ lines.
- Direct API imports in `AppShell` are limited to shell-only APIs, ideally health only.
- `AppShell` imports page components only through `lazy-pages.tsx`.

Implementation status:

- AppShell was reduced from the previous 4000+ line shape to about 2822 lines after
  extracting page lazy loading and domain controllers.
- `AppShell` imports page components only through `apps/web/src/app/lazy-pages.tsx`.
- Direct API imports for providers, approvals, media, MCP, external work, selected-run
  loading/streaming, channel read models, and teammate CRUD/memberships have been
  removed from `AppShell`.
- Remaining direct API imports are concentrated in shell health, approval policy settings,
  runtime/work-unit diagnostics, and Workspace mutation/workflow command composition.
  These are the next shrink target if the strict "health only" ideal is enforced.
- Verified `corepack pnpm --filter @ling-stack/web typecheck`.
- Verified `corepack pnpm --filter @ling-stack/web build`.

### Slice 10: Strict Shell Cleanup

Scope:

- Move remaining Workspace mutation/workflow command composition out of `AppShell`.
- Move approval policy settings state out of `AppShell`.
- Move runtime/work-unit diagnostics state out of `AppShell`.
- Keep `AppShell` as the explicit router and coordinator, not a domain state container.

Non-goals:

- Do not add Redux, Zustand, or another global store.
- Do not let domains import or call each other directly.
- Do not hide cross-domain behavior behind implicit pub/sub.
- Do not change page UX while moving ownership.

Target AppShell responsibilities:

```text
AppShell
  -> workspace cwd bootstrap
  -> view selection
  -> sidebar state
  -> domain controller creation
  -> handleDomainEvent(event)
  -> lazy page rendering
  -> modal shell wiring
```

Everything else should be owned by a domain controller or a small shell controller.

#### Slice 10A: Workspace Command Controller

Problem:

- `WorkspaceController` owns channel/task/workflow read models and state.
- `AppShell` still composes some channel/task/workflow mutations because commands need
  provider, run, approval, or teammate context.

Design:

Create a command-facing layer inside the workspace domain:

```ts
interface WorkspaceCommandController {
  readonly createChannel: (input: ChannelFormState) => Promise<void>;
  readonly updateChannel: (id: string, input: ChannelFormState) => Promise<void>;
  readonly createTask: (input: TaskFormState) => Promise<void>;
  readonly updateTask: (id: string, input: TaskEditFormState) => Promise<void>;
  readonly startTaskRun: (taskId: string, input: TaskRunCommandInput) => Promise<void>;
  readonly startWorkflowStep: (stepId: string, input: WorkflowStepCommandInput) => Promise<void>;
  readonly orchestrateWorkflow: (workflowId: string) => Promise<void>;
  readonly cancelWorkflow: (workflowId: string) => Promise<void>;
}
```

Inputs from other domains stay explicit:

```ts
interface WorkspaceCommandInputs {
  readonly getProviderForRun: () => ProviderPreset | undefined;
  readonly getApprovalProfile: () => ApprovalPolicy;
  readonly refreshRuns: () => Promise<void>;
  readonly emitEvent: EmitDomainEvent;
}
```

Rules:

- Workspace domain can receive callbacks from `AppShell`.
- Workspace domain must not import Providers, Runs, Approvals, or Teammates domains.
- Command completion emits typed `DomainEvent`.
- Refreshes use latest-wins request guards.

Exit criteria:

- `AppShell` no longer imports channel/task/workflow mutation APIs.
- `AppShell` no longer owns task/workflow command busy state.
- Workflow created/advanced/cancelled/retried events still refresh Runs, Approvals,
  Runtime, and Workspace through `handleDomainEvent`.

#### Slice 10B: Settings Shell Controller

Problem:

- Approval policy settings and runtime settings are still shell-owned.

Design:

Create `domains/settings/use-settings-domain.ts` or `app/use-shell-settings.ts`.

Own:

- daemon health state if not kept directly in AppShell;
- approval policy load/save/form;
- runtime diagnostics/settings load/save;
- work-unit diagnostics actions;
- settings page save status/errors.

Exit criteria:

- `AppShell` imports only shell bootstrap APIs or no APIs;
- `SettingsPage` receives a `SettingsController`;
- approval policy and runtime settings updates emit domain events when they affect Runs
  or Approvals.

#### Slice 10C: Runtime Diagnostics Controller

Problem:

- Runtime diagnostics and work-unit actions are cross-cutting but not true shell state.

Design:

Create `domains/runtime/use-runtime-domain.ts`.

Own:

- `getRuntimeDiagnostics`;
- `listResourceLeases`;
- `listWorkUnits`;
- `getWorkUnit`;
- `cancelWorkUnit`;
- `retryWorkUnit`;
- `reconcileWorkUnit`;
- state transition filters if they remain runtime-focused.

Events:

```ts
| { readonly type: "runtime.refreshed" }
| { readonly type: "workUnit.cancelled"; readonly workUnitId: string; readonly runId?: string }
| { readonly type: "workUnit.retried"; readonly workUnitId: string; readonly runId?: string }
| { readonly type: "workUnit.reconciled"; readonly workUnitId: string }
```

Exit criteria:

- `AppShell` no longer imports runtime/work-unit APIs.
- Run and Workspace refresh after runtime actions happens through `handleDomainEvent`.

#### Slice 10D: Import Guard

Add a lightweight static check:

```bash
rg -n 'from "../api\\.js"' apps/web/src/app/AppShell.tsx
```

Allowed only if the remaining import is explicitly listed in this document. The target
end state is zero direct API imports in `AppShell`.

Optional stricter check:

```bash
rg -n 'listRuns|streamRun|listApprovals|listChannels|createChannel|startChannelWorkflowStep|listProviders|listMediaJobs|listMcp|listExternalWork' apps/web/src/app/AppShell.tsx
```

#### Slice 10 Tests

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web build`
- Run History thread e2e.
- Workspace workflow e2e.
- Settings runtime/approval policy smoke.
- `wc -l apps/web/src/app/AppShell.tsx` decreases or remains stable with fewer direct
  imports.
- direct API import guard passes.

Implementation order:

1. Extract Runtime diagnostics controller first. It has the fewest dependencies.
2. Extract Settings controller.
3. Extract Workspace command controller.
4. Add import guard once migration is complete.

## 11. Test And Performance Exit Criteria

### Required Commands Per Slice

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
git diff --check
```

For slices touching daemon contracts or shared package types:

```bash
corepack pnpm typecheck
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
```

### Browser Smoke Matrix

Use targeted Playwright or Browser plugin smoke for these flows:

| Slice | Smoke |
| --- | --- |
| Lazy loading | open every sidebar page; no chunk load error; no console pageerror |
| Runs domain | select run, load detail, evidence, artifacts, resume composer visible when applicable |
| Approvals domain | approve/deny pending approval, run detail refreshes |
| Workspace domain | select channel, send message, create task, start workflow, cancel/retry workflow step |
| Providers domain | create/check provider, provider repair handoff from failed run |
| Teammates domain | open teammate, send private message, save settings, update memberships |
| Media domain | create media job, run job, load artifacts |
| MCP domain | add/check/sync/delete server where test fixtures allow |
| External work domain | load status, configure workflow, read CI triage records |

### Performance Criteria

Measure after Slice 1 and after final AppShell shrink:

```bash
corepack pnpm --filter @ling-stack/web build
du -sh apps/web/dist/assets/*
```

Targets:

- initial JS entry chunk below 500 KB,
- page chunks below 350 KB where practical,
- no Vite chunk warning for the initial app entry,
- lazy route chunks named or identifiable enough for debugging,
- no new runtime console errors in page smoke.

### Final Implementation Validation

- Verified `corepack pnpm --filter @ling-stack/web typecheck`.
- Verified `corepack pnpm --filter @ling-stack/web build`.
- Verified `git diff --check`.
- Browser smoke via Playwright opened `http://127.0.0.1:5174/` and clicked
  Model Workbench, Tool Access, Runs, Inbox, Media Jobs, AI Teammates, and Settings
  with no `console.error` or `pageerror`.
- Final build emitted separate lazy chunks for Providers, MCP, Runs, Approvals, Media,
  AI Teammates, Settings, Teammate Workspace, and Workspace.
- Final initial JS evidence: `dist/assets/index-BvgvwR52.js` is `453.07 kB`
  (`133.22 kB` gzip), with no Vite large chunk warning.
- `AppShell.tsx` line count after extraction: `2822`.

### Code Health Criteria

Track these after each domain migration:

```bash
wc -l apps/web/src/app/AppShell.tsx
rg -n "from \"../api\\.js\"" apps/web/src/app/AppShell.tsx
rg -n "listRuns|listApprovals|listChannels|listProviders|streamRun" apps/web/src/app/AppShell.tsx
```

Targets:

- `AppShell` line count decreases slice by slice.
- Domain-specific API imports disappear from `AppShell`.
- Cross-domain behavior routes through `handleDomainEvent`.
- Domain refresh functions do not emit events.

## Implementation Details By Chapter

This section turns the eleven design chapters into concrete implementation work.

### 1. Problem Statement Implementation

Add a baseline comment block to this document only. Do not add runtime code that tracks
file size or chunk size in the app.

Baseline facts at design time:

- `AppShell.tsx` is over 4000 lines.
- It has many `useState` entries covering multiple domains.
- The production build currently emits a large initial `index-*.js` chunk.
- `vite.config.ts` has no custom chunk strategy.

### 2. Goals And Non-Goals Implementation

Every PR in this migration should include:

- which goal it advances,
- which non-goals it preserves,
- before/after build chunk summary when touching lazy loading.

Do not combine state-manager adoption with this migration.

### 3. Target Architecture Implementation

Create the shared domain-controller helper first:

```ts
// apps/web/src/app/domain-controller.ts
export interface DomainError {
  readonly scope: "load" | "mutation" | "stream";
  readonly message: string;
  readonly retryLabel?: string;
}

export interface DomainController<TState, TActions> {
  readonly state: TState;
  readonly actions: TActions;
  readonly refresh: () => Promise<void>;
  readonly isLoading: boolean;
  readonly error: DomainError | undefined;
  readonly clearError: () => void;
}
```

This file must stay generic and free of feature imports.

### 4. Domain Ownership Matrix Implementation

For each domain migration:

1. Create domain types.
2. Move state variables.
3. Move load functions.
4. Move mutation functions.
5. Replace `AppShell` props with controller fields.
6. Delete direct API imports from `AppShell`.

Do not move presentation-only local state unless it is shared outside the feature.

### 5. AppEventRouter Implementation

Create `domain-events.ts` before moving domains. First use should be small:

```ts
export type EmitDomainEvent = (event: DomainEvent) => void;
```

Domain hooks accept it:

```ts
export function useApprovalsDomain(input: {
  readonly cwd: string;
  readonly emitEvent: EmitDomainEvent;
}): ApprovalsController;
```

Event emission:

```ts
await approveApproval(cwd, approvalId, reason);
input.emitEvent({ type: "approval.resolved", approvalId, runId });
```

Router handling stays in `AppShell`.

### 6. Concurrency Implementation

Add reusable hooks:

```text
apps/web/src/lib/use-latest-request.ts
apps/web/src/lib/use-abortable-operation.ts
```

Keep them React-only and browser-safe.

`useLatestRequest` should support keyed resources:

```ts
const latestRunRequest = useLatestKeyedRequest();
const token = latestRunRequest.next(runId);
if (!latestRunRequest.isCurrent(runId, token)) return;
```

Use keyed guards for:

- selected run id,
- selected channel id,
- selected teammate id,
- selected media job id,
- selected provider id.

### 7. Refresh/Cache/Freshness Implementation

Add reset methods to every domain before migrating `cwd`:

```ts
resetForCwd(nextCwd: string): void
```

`workspace.cwdChanged` handler must call every reset before starting refreshes.

Do not rely on React unmount to clear stale domain data.

### 8. Lazy Loading Implementation

Slice 1 can be implemented without touching domain hooks.

Potential optimization:

- Split `TeammateWorkspace` and `AiTeammatesPage` into separate lazy imports even though
  both export from `features/teammates/index.ts`. If Rollup keeps them in one chunk,
  import from direct file paths instead.
- Keep `PageInspector` eager only if it is cheap. If inspector imports grow, lazy-load it
  behind the collapsed panel.
- Add manual chunking only after dynamic import. Prefer code splitting from imports over
  Rollup config tricks.

Manual chunking fallback:

```ts
// apps/web/vite.config.ts
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) {
            return "vendor-react";
          }
          if (id.includes("node_modules/lucide-react")) {
            return "vendor-icons";
          }
        },
      },
    },
  },
});
```

Use this only if lazy page imports still leave an oversized initial chunk.

### 9. Streaming Implementation

Move run streaming into `useRunsDomain` with a stream token and abort controller.

Do not let `AppShell` own `abortRef` after Runs domain migration.

Stream events:

- `run.started` emitted on ready,
- `run.completed` emitted after durable reload,
- `run.cancelled` emitted after durable reload reports cancelled,
- stream errors become `DomainError` with `scope: "stream"`.

### 10. Migration Implementation

Recommended implementation PR sequence:

1. `web lazy page chunks`
2. `web domain event router skeleton`
3. `web runs domain controller`
4. `web approvals domain controller`
5. `web workspace domain controller phase 1: channels/tasks`
6. `web workspace domain controller phase 2: messages/files/protocol/workflows`
7. `web providers domain controller`
8. `web teammates domain controller phase 1: roster/sidebar`
9. `web teammates domain controller phase 2: private workspace`
10. `web media/mcp/external domains`
11. `web appshell shrink pass`

Do not merge multiple high-risk domain moves into one PR.

### 11. Test/Performance Implementation

Add optional bundle report script later:

```json
{
  "scripts": {
    "build:report": "corepack pnpm build && node scripts/report-web-bundles.mjs"
  }
}
```

The first version can simply list asset names and sizes from `dist/assets`.

Do not add CI blocking thresholds until lazy splitting is merged and baseline is stable.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Stale request overwrites newer selected state | latest-wins guards per resource |
| Event cycles | refresh never emits events |
| Hidden coupling moves from AppShell into domains | domains never import other domains |
| Large one-shot refactor breaks UI flows | migrate one domain per slice |
| Lazy chunk load failure leaves blank page | page error boundary with reload action |
| CWD switch leaks old workspace data | reset all domains before refreshing new cwd |
| Streams update stale views | stream id guard and abort on cwd/run change |
| AppShell remains too large after lazy split | explicit line-count and direct-API-import exit criteria |

## Open Questions

- Should `approvalPolicy` live in `approvals` or a separate `settings` domain?
  Recommendation: keep policy in `approvals` until Settings owns more than approval
  policy.
- Should external work be part of `workspace` or its own domain?
  Recommendation: keep it separate once extracted, but wire selected channel through
  `AppShell`.
- Should domain controllers use React Context?
  Recommendation: not initially. Pass controllers explicitly from `AppShell` to pages.
  Introduce context only when prop threading becomes noisy after boundaries are stable.
- Should deep links be added with this work?
  Recommendation: no. Add a separate URL/deep-link slice after shell/domain state is
  stable.

## Success Definition

This migration is successful when:

- `AppShell` is a shell, not a domain state container.
- Initial Web JS no longer triggers the Vite large chunk warning.
- Runs, approvals, workspace, providers, teammates, media, MCP, and external work each
  have clear data/action ownership.
- Cross-domain behavior is visible in `handleDomainEvent`.
- CWD changes and stream cancellation do not leak stale state.
- Existing Web smoke flows continue to pass after each slice.
