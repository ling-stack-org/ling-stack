# Startup Readiness Chain

Status: Detailed design; Slices A-F implemented
Date: 2026-06-14
Scope: Daemon startup configuration loading, effective config warmup, workspace readiness, runtime readiness, and local service restart reporting.

## Summary

Ling Stack currently treats daemon reachability as readiness: once the HTTP server is
listening, `/health` can return `ok: true`. Configuration, workspace state, runtime
policy, provider refresh, automation schedulers, and plugin health are then loaded on
demand or warmed in background callbacks.

That is acceptable for a thin development daemon, but it is not enough for a Codex-like
local product. Startup should expose a clear chain:

```text
process live
-> config ready
-> workspace ready
-> runtime ready
-> background warmup complete or degraded
```

The important constraint is that these phases must not all block `/health`. A provider
network probe, unavailable keychain, malformed optional user config, or a slow
workspace scheduler should not make the daemon look dead. The daemon should be reachable
quickly, then expose detailed startup state through a separate status surface.

The restart answer is therefore:

- every daemon process start or restart creates a fresh startup attempt id,
- process config is resolved before HTTP listen,
- the default workspace effective config is loaded once from disk after listen and
  before CLI `restart` reports the daemon as ready,
- runtime policy is validated before any run can be claimed,
- optional network or scheduler warmups continue in the background and can leave the
  workspace `degraded` without making the process look dead.

No previous process snapshot is trusted across a restart. The first implementation can
keep startup status memory-only; each new process recomputes from the current
`~/.ling-stack` and `<workspace>/.ling-stack` files.

## Current Baseline

Implemented today:

- `createDaemonServer()` resolves process config and constructs registries before
  `server.listen()`.
- `DaemonServer.start()` only waits for the HTTP server to listen.
- `RunStoreRegistry.onStoreInitialized` starts provider refresh and automation
  schedulers asynchronously after a workspace store is opened.
- `GET /config/effective` reads user config, user settings, workspace settings, and
  runtime settings when requested.
- runtime settings are resolved when run/workflow/runtime code calls
  `loadWorkspaceRuntimeSettings()`.
- `ling restart` waits for daemon `/health` and the Web endpoint.

Missing today:

- no public startup diagnostics endpoint,
- no public API distinction between daemon live, config ready, workspace degraded,
  runtime blocked, and background warmup pending,
- no CLI restart output that reports config/runtime warmup separately from process
  reachability.

Implemented after this design:

- startup contracts live in `packages/contracts/src/startup.ts`,
- daemon owns `StartupStateRegistry` with bounded diagnostics and aggregate state,
- effective config resolution is reusable through `buildEffectiveConfigResponse()`,
- daemon startup can warm the explicit default workspace and cache an in-memory
  effective config snapshot,
- startup warmup validates runtime policy before marking the workspace ready or failed,
- `GET /startup/status` and `POST /startup/refresh` expose memory-only startup state,
- run creation gates through startup required phases and rejects invalid runtime policy
  before durable work-unit claim,
- optional warmups report provider, automation, external-work, and plugin startup
  phases without blocking daemon reachability.
- CLI and Web surfaces show startup readiness from `/startup/status`; top-level
  restart/status commands include phase summaries, doctor config adds daemon-owned
  startup rows when available, and Web Settings exposes diagnostics plus explicit
  refresh.

## Design Decisions For P0

These decisions make the design directly implementable and remove the major ambiguity
from the startup contract.

| Decision | P0 choice | Reason |
| --- | --- | --- |
| `/health` blocking | Do not block on workspace warmup | Operators need to know the process is alive even when workspace config is broken. |
| `DaemonServer.start()` resolution | Resolve after listen, but return a process whose readiness starts as `starting` until required default workspace phases finish | Avoids false daemon death while still letting CLI wait for the richer readiness state. |
| `ling restart` success gate | Wait for `/startup/status` terminal state for required phases, not only `/health` | Restart should answer "settings loaded and runtime usable?" instead of "port opened?". |
| Effective config cache | In-memory per workspace, refreshed on startup and explicit refresh | Avoids stale cross-process state while keeping first Web render cheap. |
| File watching | Out of P0 | Explicit refresh is easier to reason about and test. |
| Persisted diagnostics | Out of P0 except existing daemon logs | Memory-only status is enough for live restart/debug; doctor can recompute. |
| Optional warmups | Background, degraded on failure | Provider checks, plugin health, keychain availability, and schedulers must not block daemon reachability. |

Required phases are `process_config`, `user_config`, `workspace_store`,
`effective_config`, `runtime_policy`, and `secret_resolver` capability construction.
Optional phases are `provider_warmup`, `automation_scheduler`,
`external_work_scheduler`, and `plugin_warmup`.

## Goals

- Keep `/health` fast and process-focused.
- Add a detailed startup status endpoint for user/workspace/runtime readiness.
- Load the default workspace effective config during daemon startup.
- Make startup diagnostics visible to CLI, Web Settings, and doctor.
- Preserve fail-open behavior for optional user config and fail-closed behavior for
  workspace execution policy.
- Do not silently repair or rewrite config during startup.
- Keep raw secrets out of startup snapshots, logs, status endpoints, and Web state.
- Keep Pi as the built-in runner default and continue using embedded Pi library mode.

## Non-Goals

- No app-server JSON-RPC migration.
- No cloud/team sync.
- No automatic user config creation on daemon startup.
- No provider live probe as a hard daemon startup blocker.
- No keychain setup or secret migration during startup.
- No destructive cleanup of stale runtime/workspace state during startup.

## State Model

Introduce a daemon-owned `StartupStateRegistry` with one record per canonical
workspace cwd. The default workspace cwd is warmed automatically; additional workspaces
get records when opened through Web, CLI, or RPC.

```ts
export type StartupPhase =
  | "process_config"
  | "user_config"
  | "workspace_store"
  | "effective_config"
  | "runtime_policy"
  | "secret_resolver"
  | "provider_warmup"
  | "automation_scheduler"
  | "external_work_scheduler"
  | "plugin_warmup";

export type StartupPhaseStatus =
  | "not_started"
  | "loading"
  | "ready"
  | "warming"
  | "degraded"
  | "failed";

export interface StartupDiagnostic {
  readonly level: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly phase: StartupPhase;
  readonly path?: string;
  readonly nextAction?: string;
}

export interface WorkspaceStartupStatus {
  readonly startupAttemptId: string;
  readonly cwd: string;
  readonly state: "starting" | "ready" | "degraded" | "failed";
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly phases: Readonly<Record<StartupPhase, StartupPhaseStatus>>;
  readonly diagnostics: readonly StartupDiagnostic[];
  readonly effectiveConfigLoadedAt?: string;
}
```

The aggregate state is derived:

- `starting`: required phases are still loading.
- `ready`: required phases are ready and optional warmup has no blocking failures.
- `degraded`: daemon can serve UI/API but one or more optional or workspace-scoped
  phases reported warning/degraded.
- `failed`: this workspace cannot safely execute runs because a required phase failed.

Diagnostic retention should be bounded per workspace. P0 can keep the newest 50
diagnostics and collapse repeated phase/code pairs by incrementing an internal count.
The public response should stay small and should not include raw exception stacks unless
the stack has been explicitly redacted and marked developer-only.

## Startup Sequence

Target P0 sequence:

```text
CLI or Desktop starts daemon process
-> resolve process config
-> construct registries, secret resolver, startup registry, store registry
-> bind HTTP server
-> mark process readiness = starting
-> warm default workspace required phases
   -> user config/settings read
   -> workspace store open/migrate
   -> effective config snapshot compute
   -> runtime policy validate
   -> secret resolver capability status compute
-> mark required readiness = ready/degraded/failed
-> start optional background warmups
   -> provider startup refresh
   -> automation scheduler restore
   -> external work scheduler restore
   -> plugin health snapshots
-> CLI restart prints final required state plus optional warmup summary
```

Important ordering rules:

1. User config is parsed before workspace effective config so runtime defaults can
   participate in field-level inheritance.
2. Workspace store opens before effective config because workspace settings live in
   SQLite.
3. Runtime policy validation happens after effective config because runner fallback
   policy depends on merged user/workspace sources.
4. Secret resolver capability status is checked before provider warmup, but provider
   secret values are not resolved until provider/run preflight needs them.
5. Run creation must check the required startup phases before claiming a work item.
6. Optional warmups may append diagnostics after the workspace is already ready.

## Effective Config Startup Snapshot

`/config/effective` remains the canonical explanation surface for values and sources.
Startup should reuse the same resolver path and cache the response shape in memory:

```ts
export interface EffectiveConfigStartupSnapshot {
  readonly cwd: string;
  readonly loadedAt: string;
  readonly source: "startup" | "manual_refresh";
  readonly response: EffectiveConfigResponse;
}
```

Cache rules:

- cache key is canonical workspace cwd,
- startup computes exactly one snapshot for the default workspace,
- opening a new workspace can compute that workspace on demand,
- `GET /config/effective?refresh=true` recomputes and replaces the cache,
- `POST /startup/refresh` recomputes required phases and may enqueue optional warmups,
- process restart discards all cached snapshots and recomputes from disk.

The snapshot is read-only explanation state. It must not write missing files, create
`~/.ling-stack`, repair malformed JSON, migrate localStorage, or normalize secrets.

## Startup Phases

### Phase 0: Process Config

Inputs:

- daemon config object,
- environment variables such as `LING_STACK_HOST`, `LING_STACK_PORT`,
  `LING_STACK_DEFAULT_WORKSPACE_CWD`,
- CLI-provided `--cwd`.

Behavior:

- resolve host, port, and default workspace cwd,
- create runner registry and extension registry,
- create secret resolver facade,
- create startup registry,
- record process config diagnostics.

Implementation target:

- `packages/daemon/src/config.ts` continues to own process config resolution.
- `packages/daemon/src/index.ts` constructs `StartupStateRegistry` beside the current
  runner, extension, store, provider refresh, automation, and scheduler registries.
- Process config errors that make binding impossible stay fatal; workspace-specific
  diagnostics are routed into startup status.

Failure policy:

- invalid host/port is process fatal before listen,
- invalid cwd path is a startup diagnostic and may make default workspace failed, but
  should not prevent the HTTP process from starting when the daemon can still report the
  problem.

### Phase 1: User Config

Inputs:

- `~/.ling-stack/config.json`,
- `~/.ling-stack/settings.json`,
- `LING_STACK_HOME`.

Behavior:

- resolve user paths,
- parse recognized user settings,
- sanitize `runtimeDefaults`,
- ignore unknown fields,
- store only recognized fields in the startup snapshot.

Failure policy:

- missing files are normal and resolve to built-ins,
- unreadable or malformed optional user files create warning diagnostics,
- invalid user runtime defaults are ignored field by field.

This phase answers the user's restart question directly: yes, user-level settings are
read on every daemon process start for the default workspace warmup. The daemon does not
keep using an old process snapshot after restart.

### Phase 2: Workspace Store

Inputs:

- canonical workspace cwd,
- `<workspace>/.ling-stack/ling-stack.sqlite`,
- existing workspace migrations.

Behavior:

- open the default workspace store,
- run schema migrations,
- read workspace settings,
- trigger workspace startup status creation.

Failure policy:

- SQLite open/migration failure marks this workspace `failed`,
- daemon process remains live,
- Web should show a repairable workspace error instead of a blank app.

### Phase 3: Effective Config

Inputs:

- sanitized user config and settings,
- workspace settings,
- workspace runtime settings,
- runner registry.

Behavior:

- generate `EffectiveConfigSnapshot` for the workspace,
- include value/source/path metadata,
- include diagnostics from user config and runtime resolution,
- cache the snapshot in memory for fast first Web render.

Rules:

- startup reads but does not write user config or workspace settings,
- `/config/effective` may refresh the snapshot if explicitly requested or if no
  snapshot exists,
- file watching is a later enhancement; first implementation can refresh on request.

The effective config snapshot should include the same path/source metadata already
returned by `GET /config/effective`, including:

- user root, config, settings, provider profile, plugin cache, and logs paths,
- workspace root, config, database, runtime settings, sessions, artifacts,
  attachments, plugin cache, and logs paths,
- source metadata for `workspaceCwd`, theme, locale, response language, and runtime
  fields,
- non-fatal diagnostics for optional user-layer JSON.

### Phase 4: Runtime Policy

Inputs:

- effective runtime settings,
- runner registry,
- workspace runtime file.

Behavior:

- validate effective runner policy,
- make explicit fallback fail-closed unless configured otherwise,
- expose the resolved default runner and fallback policy through startup status.

Failure policy:

- invalid user runtime defaults warn and fall back,
- invalid workspace runtime file marks `runtime_policy=failed` and blocks run creation,
- run/workflow startup must check runtime policy phase before claiming work.

Run creation gate:

```text
POST /runs
-> ensure startup required phases for cwd are terminal
-> if missing status, compute required phases on demand
-> if runtime_policy failed, reject before work-item claim
-> if startup is starting, wait a short bounded interval or return retryable 503
-> if optional phases are degraded, continue and rely on provider/run preflight
```

The run gate must not auto-repair runtime settings. It should return a clear error code,
such as `runtime_policy_invalid` or `startup_not_ready`, and a repair next action.

### Phase 5: Secret Resolver

Inputs:

- composite secret resolver,
- environment resolver,
- keychain resolver facade.

Behavior:

- verify that resolver objects are present,
- do not resolve every provider secret value during daemon startup,
- expose resolver capability status:
  - `env` available,
  - `keychain` available/unavailable,
  - `local_provider_compat` readable.

Failure policy:

- keychain unavailable is degraded, not process fatal,
- raw secret values never appear in diagnostics,
- provider-specific secret checks remain provider/run preflight work.

Startup status reports resolver capabilities only. It may say `env` is available,
`keychain` is unavailable, or `local_provider_compat` exists. It must not scan every
configured provider secret at startup and must not include names or values that were not
already present as configured refs.

### Phase 6: Background Warmup

Warmup phases:

- provider startup refresh,
- automation scheduler restore,
- external-work scheduler restore,
- plugin health/load snapshots.

Behavior:

- start after workspace store opens,
- report `warming`, `ready`, or `degraded`,
- append bounded diagnostics,
- never block `/health`.

Failure policy:

- provider refresh failure degrades provider readiness only,
- automation restore failure degrades automation only,
- plugin warmup failure degrades plugin surfaces only,
- run creation still enforces its own provider/runtime checks.

Provider warmup should reuse the existing `ProviderStartupRefreshService` behavior:
only enabled, chat-capable, non-media providers with configured required refs are
checked; stale or missing last checks are refreshed; failures are recorded as provider
check results and startup diagnostics, not daemon process failures.

## API Surface

### `GET /health`

Keep `/health` process-focused.

```json
{
  "ok": true,
  "service": "ling-stack-daemon",
  "defaultWorkspaceCwd": "/path/to/workspace",
  "readiness": "ready"
}
```

`readiness` should be the process-level readiness:

- `starting`: HTTP is up, default workspace warmup has not reached a terminal startup
  state yet.
- `ready`: required daemon internals are ready.
- `degraded`: daemon is reachable but default workspace startup has warnings or
  degraded optional phases.

Do not put full diagnostics in `/health`; clients should use `/startup/status`.

### `GET /startup/status`

```http
GET /startup/status?cwd=/path/to/workspace
```

Response:

```json
{
  "cwd": "/path/to/workspace",
  "startupAttemptId": "startup_20260614_000000_abc123",
  "state": "degraded",
  "startedAt": "2026-06-14T00:00:00.000Z",
  "updatedAt": "2026-06-14T00:00:01.000Z",
  "phases": {
    "process_config": "ready",
    "user_config": "ready",
    "workspace_store": "ready",
    "effective_config": "ready",
    "runtime_policy": "ready",
    "secret_resolver": "degraded",
    "provider_warmup": "warming",
    "automation_scheduler": "ready",
    "external_work_scheduler": "not_started",
    "plugin_warmup": "ready"
  },
  "diagnostics": [
    {
      "level": "warning",
      "code": "secret_store_unavailable",
      "phase": "secret_resolver",
      "message": "Keychain secret store is unavailable in this runtime.",
      "nextAction": "Use env: refs or configure desktop keychain support."
    }
  ],
  "effectiveConfigLoadedAt": "2026-06-14T00:00:00.900Z"
}
```

Rules:

- read-only,
- no secret values,
- bounded diagnostics,
- missing `cwd` defaults to daemon default workspace cwd,
- unknown workspaces can trigger a best-effort startup status load.

### `POST /startup/refresh`

Optional follow-up endpoint:

```http
POST /startup/refresh?cwd=/path/to/workspace
```

Use only for explicit user/CLI refresh. It should:

- recompute effective config,
- re-open or verify workspace store,
- refresh runtime policy,
- optionally enqueue provider/plugin warmup,
- not mutate config files.

## CLI And Web Behavior

### `ling restart`

Current behavior waits for daemon `/health` and Web readiness. Target behavior:

```text
Local stack restarted
Daemon build: ok
Daemon: ready (http://127.0.0.1:17891)
  Config: ready
  Workspace: ready /Users/tianxiao/ling-stack
  Runtime: ready defaultRunner=pi
  Warmup: provider_warmup=warming, automation_scheduler=ready
Web: ready (http://127.0.0.1:5173)
```

Restart success should mean:

- daemon process is reachable,
- required default workspace phases are `ready`, `degraded`, or `failed`,
- if required state is `failed`, the command exits non-zero and prints next actions,
- optional warmups can still be `warming` and should be shown explicitly.

If startup is degraded:

```text
Daemon: degraded (http://127.0.0.1:17891)
  Config: warning user_config_invalid_json
  Runtime: ready defaultRunner=pi
  Next: ling doctor config
```

### `ling status`

Should read:

- `/health` for process reachability,
- `/startup/status` for default workspace readiness,
- launchd/process metadata when available.

### `ling doctor config`

Should include startup phases as read-only check rows:

- user config load,
- user settings load,
- workspace store load,
- effective config snapshot,
- runtime policy,
- secret resolver capability.

Doctor must not repair or create config.

### Web

On first render:

- request `/config/effective` for values,
- request `/startup/status` for readiness banners and diagnostics,
- show degraded startup state as a settings/diagnostics surface, not as a modal that
  blocks normal navigation unless the workspace store or runtime policy failed.

## Implementation Slices

### Slice A: Startup State Registry

- Add `StartupStateRegistry` in daemon, likely under
  `packages/daemon/src/startup/state.ts`. Implemented.
- Add phase/status/diagnostic contracts. Implemented.
- Add daemon context field.
- Add unit tests for aggregate state derivation and diagnostic bounds. Implemented.

### Slice B: Default Workspace Warmup

- Add `packages/daemon/src/startup/warmup.ts`. Implemented.
- During `DaemonServer.start()`, call warmup for `resolvedConfig.defaultWorkspaceCwd`
  after HTTP listen. `/health` may show `starting`; `ling restart` waits on
  `/startup/status`. Partially implemented: explicit default workspace warmup now runs
  after HTTP listen; public `/startup/status` remains Slice C.
- Open store, read user/workspace layers, generate effective config snapshot. Implemented.
- Mark warmup phases in `StartupStateRegistry`. Implemented.
- Keep optional provider/scheduler warmups detached from required warmup completion.

### Slice C: Startup Status API

- Add contracts/API client DTOs, likely `packages/contracts/src/startup.ts` and API
  client methods `getStartupStatus()` / `refreshStartupStatus()`. Implemented.
- Add `GET /startup/status`. Implemented.
- Add optional `POST /startup/refresh`. Implemented.
- Extend `/health` with lightweight `readiness`. Implemented.

### Slice D: Runtime Policy Gate

- Store runtime policy phase in startup status. Implemented.
- Teach run/workflow startup to reject with a clear `runtime_policy_invalid` error
  before claiming work. Implemented for HTTP, RPC, workflow, intervention, and
  automation starts that flow through `executeRunRequest()`.
- Add tests for invalid workspace runtime settings blocking runs while user defaults
  remain warning-only. Implemented for startup warmup and direct run creation.

### Slice E: Background Warmup Reporting

- Wire provider startup refresh into startup phases. Implemented:
  `provider_warmup` moves through `warming` to `ready` or `degraded`, and failed
  checks add bounded diagnostics without exposing secrets.
- Wire automation scheduler startup into startup phases. Implemented:
  `automation_scheduler` reports `ready` when schedule restoration completes and
  `degraded` when restoration throws.
- Add external-work/plugin warmup phase placeholders if not implemented yet.
  Implemented: `external_work_scheduler` is marked `ready` when no durable auto-restore
  work is pending; `plugin_warmup` validates bundled plugin descriptors and reports
  `degraded` only on descriptor/package load failures.
- Keep all warmup failures non-fatal unless they are required for a specific action.
  Implemented.

### Slice F: CLI And Web Surfaces

Goal: make the startup chain visible without changing the daemon readiness model.
This slice is a presentation and operator-contract slice; it must reuse
`/startup/status` and must not recompute or repair config from clients.

CLI behavior:

- `ling restart` still waits for daemon `/health` and Web reachability, then waits for
  `/startup/status` to leave `starting` for the current workspace.
- Required startup failure makes `ling restart` exit non-zero after printing the failed
  phase, bounded diagnostic code, and next action.
- Optional warmup states can remain `warming` or `degraded`; restart prints them but
  does not fail solely because of optional degradation.
- `ling status` prints the same startup summary when the daemon is reachable:
  workspace state, required phase summary, optional warmup summary, and newest
  diagnostics.
- `ling daemon status` remains a thin process health check. It may show the
  lightweight `/health.readiness` value, but it must not call `/startup/status`.

Doctor behavior:

- `ling doctor config` adds read-only startup phase rows when the daemon is reachable:
  `startup.user_config`, `startup.workspace_store`, `startup.effective_config`,
  `startup.runtime_policy`, and `startup.secret_resolver`.
- Optional warmups appear as warning rows only when degraded or failed.
- Doctor does not call `/startup/refresh`; it reports the process snapshot that the
  daemon currently owns. If the daemon is unreachable, pure filesystem config checks
  keep their existing status and startup rows are omitted.

Web behavior:

- AppShell loads `GET /startup/status` beside `GET /config/effective` after the daemon
  is healthy and a workspace cwd is known.
- Settings gets a startup diagnostics section with phase rows, newest diagnostics, and
  a Refresh action that calls `POST /startup/refresh`.
- Refresh updates the diagnostics panel and the effective-config panel, but it does not
  create or repair config files.
- Startup failure is shown in Settings as workspace/runtime repair information. It is
  not a blocking modal; run creation remains blocked by the daemon run gate.

Implementation notes:

- Put CLI fetch/format helpers near local service lifecycle code so `restart`,
  `status`, and `daemon status` do not duplicate phase grouping.
- Use required and optional phase arrays from the startup contract semantics, not from
  localized display text.
- Keep all displayed diagnostics secret-safe; clients print only `code`, `message`,
  `phase`, and `nextAction`.

Implemented.

### Slice G: Documentation And Operator Contract

- Add startup status target API notes to daemon docs once implemented.
- Cross-link startup readiness from two-layer config, runtime inheritance, and keychain
  docs.
- Keep README documentation index updated so operators can find the restart contract.

## Test Plan

Daemon tests:

- `/health` is fast and returns process readiness,
- `/startup/status` returns default workspace phases,
- malformed user config creates warning diagnostics,
- missing user config resolves to built-ins,
- invalid workspace runtime settings marks runtime policy failed,
- provider warmup failure degrades provider phase without failing health,
- startup diagnostics never include raw secret values.

CLI tests:

- `ling restart` reports startup status when daemon is ready,
- degraded startup prints next action,
- `ling doctor config` includes startup phase rows,
- daemon-not-running still produces useful lifecycle diagnostics.

Web tests:

- first render can show config values from effective config snapshot,
- startup degraded banner links to settings diagnostics,
- runtime policy failure blocks run actions with repair copy,
- refresh startup status does not mutate config.

## Open Decisions

No P0-blocking decisions remain. Deferred choices:

- Whether to add file watching after explicit refresh proves insufficient.
- Whether to persist last startup diagnostics under `.ling-stack/daemon/` for offline
  post-mortems.
- Whether Web should poll optional warmups continuously or stop after required phases
  are terminal and refresh on user action.

## Related

- [Daemon Lifecycle and Doctor P0](daemon-lifecycle-p0.md)
- [Two-Layer Configuration](two-layer-configuration.md)
- [Runtime, Provider, and Secrets Inheritance](runtime-provider-secrets-inheritance.md)
- [Secrets and Keychain](secrets-keychain.md)
- [CLI v0.1](cli-v0.1.md)
- [Daemon API](../daemon-api.md)
