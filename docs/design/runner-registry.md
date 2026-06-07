# Runner Registry

## Purpose

This document defines the first multi-runner architecture slice for Ling Stack.

The immediate goal is not to add a second execution backend. The immediate goal is to
replace the daemon's current single runner dependency with a typed runner registry while
keeping Pi as the only effective runner and preserving current behavior.

Target shape:

```text
Ling session / work unit
  -> RunnerRegistry
    -> pi                   default, current backend
       (alias: pi-coding-agent)
    -> codex-app-server     future, feature-flagged backend
    -> openclaw-acp         future, external delegation backend
```

This document covers Slices 1-4 only:

- Slice 1: RunnerRegistry + Pi only, no behavior change.
- Slice 2: `requestedRunnerId`, `effectiveRunnerId`, and `fallbackReason` audit fields.
- Slice 3: teammate and run request support for runner selection, defaulting to Pi.
- Slice 4: runner conformance tests.

OpenClaw/ACP delegation is explicitly out of scope. A Codex app-server adapter can be
added later behind a feature flag after the registry contract is stable.

## Current Implementation Status

Implemented in the first backend slice:

- `packages/daemon/src/runtime/runners.ts` owns `RunnerRegistry`, Pi registration, and
  legacy `pi-coding-agent` -> `pi` normalization.
- Daemon execution paths resolve a runner through `runnerRegistry`; `dependencies.runner`
  remains as the Pi-compatible injection point.
- Run requests, task runs, channel replies, direct teammate replies, and teammate config
  accept optional `runnerId`.
- Work units and attempts persist `requestedRunnerId`, `effectiveRunnerId`, and
  `fallbackReason`; legacy `runnerId` remains the effective runner for compatibility.
- `run_created` and runtime work-unit events include additive runner audit metadata.
- Workspace runtime settings persist the default runner, allowed runners, and fallback
  policy in `.ling-stack/runtime-settings.json`.
- The Web Settings runtime panel edits default/allowed runner settings and fallback
  policy.
- The Web run detail and workflow-step cards display requested/effective runner metadata
  and fallback reason.
- `packages/daemon/test/runner-registry.test.mjs` covers default Pi resolution, legacy
  alias normalization, fallback, explicit missing runner rejection, and provider/tool
  conformance.
- `packages/daemon/test/runner-conformance.test.mjs` contains the first reusable
  normalized-runner conformance harness for lifecycle events, text streaming, tool event
  translation, approval interception, abort handling, provider failure surfacing, cleanup,
  and secret redaction.

Still out of scope for this slice:

- Codex app-server adapter.
- OpenClaw/ACP adapter.
- UI picker for non-Pi backends.

Adapter follow-up design:

- [Runner Adapters](runner-adapters.md) defines the feature-flagged Codex app-server
  and OpenClaw/ACP adapter slices, shared conformance requirements, session-handle
  rules, and approval/security boundaries.
- [Core Tools, Runners, MCP Tools, and Plugin Boundary](core-tools-runtime-boundary.md)
  defines why runner-supported tools are metadata and approval-policy inputs, not
  Plugin Manager entries.

Implemented follow-up hardening:

- [Execution And Orchestration Hardening](execution-orchestration-hardening.md) defined
  the RunnerRegistry hardening slice. Workspace default runner settings, explicit
  fallback policy, and runner audit UI are now implemented. Codex app-server and
  OpenClaw/ACP adapters remain out of scope.

## Original Baseline

Before this slice, the daemon already had a `RunnerAdapter` interface, but it was a
single injected object:

```ts
export interface RunnerAdapter {
  runTask(options: PiRunnerRunOptions): Promise<PiRunnerResult>;
}
```

`createDaemonServer()` resolved that single dependency with:

```ts
const runner = dependencies.runner ?? createPiRunner();
```

Run execution paths call `runner.runTask()` directly:

- task runs in `packages/daemon/src/features/runs/orchestrator.ts`,
- channel AI replies in `packages/daemon/src/features/channels/ai-replies.ts`,
- teammate direct replies in `packages/daemon/src/features/teammates/direct-replies.ts`.

Runtime records use a fixed `DEFAULT_RUNNER_ID = "pi-coding-agent"` for work units and
attempts. The extension registry separately reports the Pi runner as `runnerId: "pi"`.
That mismatch is harmless while only one backend exists, but it becomes ambiguous once
runner selection exists.

## Goals

- Keep Pi as the default and only enabled runner in the first implementation.
- Introduce a daemon-local `RunnerRegistry` that resolves runners by id.
- Preserve the current `runTask()` behavioral contract for Pi.
- Record requested runner, effective runner, and fallback decisions in durable runtime
  state.
- Let teammates and direct run requests select a runner without making clients depend on
  concrete runner packages.
- Add conformance tests that any future runner must pass before it can be enabled.
- Keep approval policy, provider resolution, MCP tool access, resource leases,
  cancellation, artifact extraction, and runtime supervisor semantics owned by Ling.

## Non-Goals

- No Codex app-server adapter in Slices 1-4.
- No OpenClaw/ACP adapter in Slices 1-4.
- No switch from embedded `@earendil-works/pi-coding-agent` to Pi CLI.
- No external plugin loading or marketplace runner install flow.
- No change to provider preset semantics.
- No change to media provider routing.
- No UI redesign. UI may display runner metadata only after backend fields exist.
- No silent fallback to a different runner without durable audit fields.

## Terminology

| Term | Meaning |
| --- | --- |
| Runner | A coding-agent execution backend that can run a Ling task and stream normalized events. |
| Runner adapter | The concrete TypeScript object implementing Ling's runner contract. |
| Runner registry | Daemon-local resolver from runner id to runner adapter and metadata. |
| Requested runner | The runner selected by a run request, teammate config, or default policy. |
| Effective runner | The runner actually used after resolution and fallback. |
| Fallback reason | Durable explanation for why the effective runner differs from the requested runner. |
| Pi runner | The current embedded `@earendil-works/pi-coding-agent` adapter. |

## Runner Ids

Use stable, product-facing ids. Do not expose package names as the primary ids.

Recommended ids:

| Runner | Id | Status |
| --- | --- | --- |
| Embedded Pi coding agent | `pi` | Default, enabled now |
| Codex app-server | `codex-app-server` | Reserved, disabled until later slice |
| OpenClaw ACP/external delegation | `openclaw-acp` | Reserved, out of scope |

The current runtime value `pi-coding-agent` should be treated as a legacy alias for `pi`
during migration.

## Registry Contract

The registry should be a small daemon/runtime abstraction, not a broad plugin system.

```ts
export interface RunnerRegistry {
  get(id: string): RegisteredRunner | undefined;
  list(): readonly RegisteredRunner[];
  resolve(input: RunnerResolutionInput): RunnerResolution;
}

export interface RegisteredRunner {
  readonly id: string;
  readonly displayName: string;
  readonly status: "enabled" | "disabled";
  readonly adapter: RunnerAdapter;
  readonly supportedProviderApis: readonly PiRunnerProviderApi[];
  readonly supportedTools: readonly string[];
}

export interface RunnerResolutionInput {
  readonly requestedRunnerId?: string;
  readonly defaultRunnerId: string;
  readonly allowFallback: boolean;
}

export interface RunnerResolution {
  readonly requestedRunnerId: string;
  readonly effectiveRunnerId: string;
  readonly runner: RegisteredRunner;
  readonly fallbackReason?: RunnerFallbackReason;
}

export interface RunnerFallbackReason {
  readonly code:
    | "missing_requested_runner"
    | "disabled_requested_runner"
    | "unsupported_provider_api"
    | "unsupported_tool";
  readonly message: string;
}
```

The initial implementation can be simpler than the full interface if only Pi is
registered, but it should keep the same vocabulary so Slice 5 does not require another
schema change.

## Resolution Rules

Runner resolution must be deterministic:

1. If a run request explicitly sets `runnerId`, use it as `requestedRunnerId`.
2. Else if the resolved teammate has a configured `runnerId`, use that.
3. Else use the workspace default runner.
4. Else use the product default runner, `pi`.

If the requested runner is available and supports the requested provider/tools, it is the
effective runner.

If the requested runner is missing or disabled:

- for Slices 1-4, fallback to `pi` only when fallback is explicitly allowed by the
  resolution policy,
- otherwise fail the request with a clear `unsupported_runner` error.

Fallback must never be silent. When fallback occurs, persist:

```json
{
  "requestedRunnerId": "codex-app-server",
  "effectiveRunnerId": "pi",
  "fallbackReason": {
    "code": "disabled_requested_runner",
    "message": "Runner codex-app-server is not enabled; using default runner pi."
  }
}
```

## Durable State

Add durable audit fields to work unit and attempt records.

Recommended fields:

```ts
interface WorkUnit {
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly fallbackReason?: RunnerFallbackReason;
}

interface WorkUnitAttempt {
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId: string;
  readonly fallbackReason?: RunnerFallbackReason;
}
```

Keep the existing `runnerId` field during migration:

- For new rows, write `runnerId` as the effective runner id for backward compatibility.
- Prefer `effectiveRunnerId` in new code.
- Treat existing `runnerId = "pi-coding-agent"` as `effectiveRunnerId = "pi"` when reading.
- Do not rewrite old rows in a broad migration unless a schema migration is already
  required.

## Request and Teammate Configuration

Add optional runner selection where the user or product model naturally owns the choice.

```ts
interface RunRequest {
  readonly runnerId?: string;
}

interface AiTeammate {
  readonly runnerId?: string;
}
```

Default behavior:

- If neither field is set, use `pi`.
- If teammate config sets a runner, use it for that teammate's runs and replies.
- If a direct run request sets `runnerId`, it overrides teammate default for that run.

The API should reject unknown runner ids unless fallback is explicitly enabled for the
request path. The first backend implementation can keep fallback disabled for explicit
user-selected runner ids, because silently running a different agent backend is a bad
audit story.

## Event Contract

Slices 1-4 should keep the current Pi event shape:

```ts
type RunnerEvent =
  | "run_start"
  | "turn_start"
  | "turn_end"
  | "assistant_text_delta"
  | "assistant_thinking_delta"
  | "tool_start"
  | "tool_update"
  | "tool_end"
  | "message_end"
  | "run_end"
  | "run_error";
```

The registry should not normalize events itself. Each adapter translates native backend
events into Ling runner events. The orchestrator stores and streams the normalized events.

The event payload should include `effectiveRunnerId` on lifecycle events after Slice 2:

```ts
{
  "type": "run_start",
  "runnerId": "pi",
  "taskId": "task_...",
  "provider": "openai",
  "model": "gpt-..."
}
```

## Approval and Tool Boundary

Approval remains outside runner ownership.

Runners can request tool execution or emit tool events, but Ling owns:

- approval policy resolution,
- user or auto-review decision recording,
- allowed tools per channel/skill,
- MCP access checks,
- artifact redaction,
- durable audit logs.

Future runners must prove that side-effecting operations are interceptable before they
run. A runner that cannot stop before `bash`, `edit`, `write`, or external mutation must
not be enabled for normal Ling task runs.

Runner settings may display supported core tools, but the runner does not own their
authorization. Approval policy remains the source of truth for `allow`, `ask`, and
`deny` decisions.

## Package Shape

Recommended package/module additions:

```text
packages/daemon/src/runtime/runners.ts
packages/daemon/test/runner-registry.test.mjs
packages/daemon/test/runner-conformance.test.mjs
```

Keep `packages/runner-pi` as the Pi adapter owner.

Do not move `PiRunnerAdapter` into daemon. The daemon registry should compose runner
adapters; concrete runner packages should keep backend-specific imports isolated.

## Slice 1: RunnerRegistry + Pi Only

Implementation steps:

1. Add `RunnerRegistry` and `createDefaultRunnerRegistry()`.
2. Register only Pi:

   ```ts
   createDefaultRunnerRegistry({
     pi: createPiRunner(),
   });
   ```

3. Replace `DaemonContext.runner` with `DaemonContext.runnerRegistry`.
4. In run/reply execution paths, resolve the runner before calling `runTask()`.
5. Keep effective behavior identical: no request can select another runner yet.
6. Keep existing tests passing without fixture changes unless they asserted the injected
   dependency shape directly.

Acceptance criteria:

- Pi runs still execute through `PiRunnerAdapter`.
- SSE event stream is unchanged except for additive metadata if Slice 2 is included.
- Existing approval, MCP, cancellation, and artifact tests pass.
- No UI changes are required.

## Slice 2: Runner Audit Fields

Implementation steps:

1. Add read/write support for `requestedRunnerId`, `effectiveRunnerId`, and
   `fallbackReason`.
2. Persist these fields on work units and attempts.
3. Continue writing legacy `runnerId` as `effectiveRunnerId`.
4. Normalize old `pi-coding-agent` values to `pi` at read boundaries where new code needs
   stable ids.
5. Include runner resolution metadata in runtime events.

Acceptance criteria:

- New work units show requested and effective runner ids.
- Existing work units created before the migration still render and recover.
- If fallback is forced in a unit test, the reason is durable and visible through store
  reads.

## Slice 3: Runner Selection

Implementation steps:

1. Add optional `runnerId` to run request parsing and shared contracts.
2. Add optional `runnerId` to teammate configuration.
3. Resolve runner priority:

   ```text
   run request runnerId
   -> teammate runnerId
   -> workspace default runner
   -> pi
   ```

4. Reject unknown explicit runner ids with `unsupported_runner`.
5. Do not expose Codex/OpenClaw choices until their adapters exist.

Acceptance criteria:

- Omitting runner id still selects Pi.
- Teammate runner id flows into run, channel reply, and direct reply work units.
- Explicit unknown runner id fails before creating a running attempt.
- Explicit `pi` behaves the same as omitted runner id.

## Slice 4: Runner Conformance Tests

Status: implemented as a daemon-local normalized-runner harness using a fake conformant
adapter. The harness does not call real Pi or live providers, and it can be reused as the
gate for future backends.

Create a reusable test harness for runner adapters. The harness should run against Pi
first, then become the gate for future backends.

Minimum conformance cases:

| Case | Required behavior |
| --- | --- |
| start/end lifecycle | emits start and terminal events exactly once |
| text streaming | emits assistant text deltas or final assistant text |
| tool event translation | emits normalized tool start/end events for tool calls |
| approval gate | side-effect tools call Ling approval before execution |
| abort before start | respects pre-aborted signal |
| abort during run | stops work and returns/throws a normalized cancellation |
| provider failure | surfaces provider errors without corrupting work unit state |
| cleanup | removes listeners and releases resources after terminal state |
| secret redaction | does not leak raw API keys in events or artifacts |

The conformance harness should use fake providers/tools where possible. Tests should not
depend on real OpenAI, Anthropic, Pi cloud state, or user credentials.

## Failure Modes

| Failure | Required behavior |
| --- | --- |
| Unknown runner requested | fail with `unsupported_runner` unless fallback is explicitly allowed |
| Runner disabled | fail or fallback with durable `fallbackReason` |
| Runner does not support provider API | fail before starting attempt |
| Runner does not support required tool | fail before starting attempt |
| Runner crashes after attempt starts | mark attempt failed/lost through existing runtime recovery |
| Fallback occurs | persist requested/effective ids and reason |
| Legacy row has `pi-coding-agent` | read as Pi-compatible legacy value |

## Rollout Plan

Recommended order:

1. Slice 1 and Slice 2 can ship together if schema changes are small.
2. Slice 3 should ship after backend audit fields are visible in tests.
3. Slice 4 should be added before implementing Codex app-server.
4. Codex app-server should remain feature-flagged until it passes conformance.

The safest first PR is:

```text
RunnerRegistry + Pi-only registration + runner audit vocabulary
```

That PR should intentionally avoid user-visible runner selection if the schema churn is
already large.

## Relationship to Existing Designs

- [Pi Coding Agent Integration](../pi-coding-agent-integration.md) remains the Pi backend
  contract.
- [Runtime Supervisor](runtime-supervisor.md) remains the owner of work unit lifecycle,
  heartbeats, cancellation, and stale recovery.
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md) owns multi-teammate sequencing;
  each orchestrated step still resolves a runner through this registry.
- [Internal Registry and Plugin SDK](internal-registry-plugin-sdk.md) remains the
  capability discovery layer. RunnerRegistry is the executable daemon resolver, not a
  replacement for extension metadata.
- [Provider Presets](provider-presets.md) remain the source of model/provider config.

## Open Questions

- Should workspace default runner live in workspace settings, daemon config, or approval
  policy state?
- Should fallback be globally disabled for explicit user-selected runner ids?
- Should `runnerId` in existing API responses be deprecated immediately or kept as an
  alias for `effectiveRunnerId` for one release?
- Should conformance tests live in daemon tests only, or should each runner package export
  its own test fixture?

Recommended default answers:

- Put workspace default runner in workspace settings, not provider presets.
- Disable fallback for explicit user-selected runner ids.
- Keep `runnerId` as an alias for one release.
- Keep the harness in daemon tests first, then extract only if a second runner package
  needs it.
