# Runner Adapters

## Purpose

This document defines how Ling Stack should add non-Pi execution backends after the
implemented `RunnerRegistry` slice.

Current boundary:

- Pi remains the default effective runner.
- `RunnerRegistry` resolves runner ids, aliases, allowed runners, provider/tool
  conformance, explicit/implicit fallback policy, and audit metadata.
- Runs, work units, attempts, workflow steps, Settings, and Run History already expose
  runner audit.
- `codex-app-server` and `openclaw-acp` are registered as disabled placeholder runners
  so settings, fallback, and audit can fail closed before real adapters are enabled.
- No Codex app-server or OpenClaw/ACP backend is enabled today.
- Model-provider integrations such as OpenAI, Anthropic/Claude, and Google/Gemini are
  not runner adapters by themselves. They remain provider presets unless they expose an
  external agent runtime with its own session, tools, events, artifacts, and approval
  semantics.

This document covers:

1. `codex-app-server` adapter;
2. `openclaw-acp` adapter;
3. the provider-vs-agent-runtime decision boundary for future Codex, OpenClaw, Hermes,
   Claude, Gemini, and similar integrations;
4. shared adapter conformance, security, audit, and rollout rules.

Detailed implementation slices live in
[External Agent Runner Adapters Implementation Plan](external-agent-runner-adapters-implementation-plan.md).

## Implementation Status

Implemented:

- default runner registry includes disabled `codex-app-server` and `openclaw-acp`
  registrations;
- disabled runner requests fail with `disabled_requested_runner` unless explicit fallback
  policy permits falling back to Pi;
- runtime settings still seed only enabled Pi as default/allowed runner;
- `/runners` can expose disabled future adapters for audit and UI display.
- future adapter registrations now include `featureFlag`, `capabilities`, and
  `disabledReason` metadata, so Settings can show why `codex-app-server` and
  `openclaw-acp` are unavailable.
- daemon config can express `runners.codexAppServer.enabled` and
  `runners.openclawAcp.enabled`, but the registrations still fail closed until a real
  adapter and conformance gate exist.
- Settings runtime runner UI shows disabled runner feature flags and disabled reasons
  while preventing disabled runners from being selected.
- sandbox profile contracts now define fail-closed backend verification, network policy,
  artifact import, secret-ref, and opaque session-ref gates without enabling a sandbox
  backend.

Still future:

- real Codex app-server health probe, stream adapter, approval bridge, and resume handle;
- real OpenClaw/ACP capability negotiation, client bridge, violation handling, and
  workspace-bound session lifecycle;
- wiring sandbox profile readiness into a concrete runner adapter after artifact import,
  network policy, and secret redaction conformance exists;
- adapter decision records for Hermes, Claude, Gemini, or other future runtimes only when
  they expose an executable agent session rather than only a model API;
- feature-flag UI that enables a non-Pi runner only after conformance passes.

## Principles

- Adapters are execution backends, not new orchestrators.
- Ling owns task/run/thread/workflow state.
- Ling owns approval policy, tool gating, and audit evidence.
- Runner backends may maintain opaque session handles, but they cannot be the source of
  truth for Ling state.
- Feature flags must keep new adapters disabled by default.
- Pi remains the fallback/default until a workspace explicitly enables another runner.

## Provider vs Agent Runtime Boundary

Ling has two integration layers. Do not collapse them.

| Integration target | Use provider preset when... | Use runner adapter when... | Planned shape |
| --- | --- | --- | --- |
| OpenAI / Claude / Gemini model APIs | Ling only needs a model endpoint, model id, base URL, API key, and provider API compatibility. | A vendor or wrapper exposes a full agent session with tool events, artifacts, cancellation, approval proposals, and resume handles. | Provider preset first; adapter only for a real agent server. |
| Codex server | Not applicable if the target is the Codex agent runtime rather than just an OpenAI model. | Ling delegates execution to a Codex app-server session and normalizes its stream/tool/artifact events. | Dedicated `codex-app-server` adapter, not ACP by default. |
| OpenClaw | Not applicable if OpenClaw is used as an external agent runtime. | OpenClaw exposes an ACP-compatible endpoint with capability negotiation and interceptable side effects. | `openclaw-acp` adapter through an ACP client bridge. |
| Hermes | Hermes only contributes memory/context files or runtime-native overlay content. | Hermes exposes an executable agent session API with stream events, tool proposals, workspace bounds, and resume/cancel support. | No runner id until a concrete Hermes agent protocol exists. |
| Other agent servers | They only proxy model calls with no durable session or tool lifecycle. | They own an agent session and can run tasks outside Ling unless bridged through Ling policy. | Add a dedicated adapter or ACP-compatible adapter after conformance. |

The rule is simple: providers supply model capability; runners execute work. Provider
presets can be selected per teammate, channel, or run without changing the runner.
Runner adapters change who owns task execution and therefore must pass the full
approval, workspace, artifact, cancellation, and audit contract.

## Shared Runner Contract

Every adapter must satisfy the normalized runner contract:

```ts
interface RunnerAdapter {
  runTask(options: PiRunnerRunOptions): Promise<PiRunnerResult>;
}
```

Adapter packages may have richer internal protocols, but they must normalize into:

- assistant text deltas;
- thinking deltas when available;
- tool start/update/end events;
- approval requests routed through Ling approval policy;
- artifacts emitted through Ling artifact APIs;
- cancellation through `AbortSignal`;
- terminal result or structured error.

## Runner Metadata

Each registered runner needs stable metadata:

```ts
interface RunnerRegistration {
  readonly id: string;
  readonly displayName: string;
  readonly status: "enabled" | "disabled";
  readonly aliases?: readonly string[];
  readonly supportedProviderApis?: readonly string[];
  readonly supportedTools?: readonly RunTool[];
  readonly capabilities?: readonly RunnerCapability[];
  readonly featureFlag?: string;
}

type RunnerCapability =
  | "stream_text"
  | "stream_thinking"
  | "tool_events"
  | "approval_interception"
  | "artifacts"
  | "native_resume"
  | "workspace_patch"
  | "mcp_tools";
```

Registration rules:

- a disabled runner cannot be selected unless the feature flag enables it;
- aliases normalize to canonical ids before persistence;
- unsupported provider API/tool combinations fail closed unless policy allows fallback;
- every fallback persists `requestedRunnerId`, `effectiveRunnerId`, and `fallbackReason`.

## Session Handles

Some backends have native sessions. Ling should store them as opaque adapter metadata:

```ts
interface RunnerSessionHandle {
  readonly runnerId: string;
  readonly backendSessionId: string;
  readonly resumeTokenRef?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}
```

Storage options:

- short term: `RunSession.requestSnapshot.runnerSessionHandle`;
- better long term: `runner_sessions` table linked to `threadId`, `runId`, and
  `workspaceId`.

Rules:

- opaque handles are never rendered as primary UI labels;
- secret-like tokens use secret refs, not raw stored values;
- native resume is optional. Ling resume context remains the universal fallback.

## Sandbox Profiles

Sandbox profiles describe an execution boundary. They do not create Ling state, grant
tool authority, or make a disabled runner selectable.

Initial profile kinds:

| Backend kind | Meaning | Status |
| --- | --- | --- |
| `local_unix` | A local process boundary with Ling-owned artifact import paths. | Development diagnostics only; not strong isolation |
| `docker` | A container-backed execution boundary. | P12 backend doctor/run-plan adapter exists; runner binding disabled until conformance |
| `hosted` | A hosted sandbox provider such as E2B, Modal, Runloop, Vercel, Cloudflare, or OpenAI. | Disabled until adapter decision and conformance |
| `external` | A runner-owned sandbox exposed through an agent protocol. | Disabled until capability negotiation proves Ling gates |

Rules:

- profiles must verify backend behavior before readiness can become `ready`;
- network defaults to disabled, or an explicit non-wildcard allowlist;
- artifacts must be imported into Ling-owned artifact roots and redacted before appearing
  as Ling artifacts;
- injected secrets use `env:` or `keychain:` refs, never raw manifest values;
- session refs are opaque diagnostics, not user-facing labels or execution authority.
- Docker P12 verifies only disabled networking (`--network none`) and produces a run plan;
  allowlist networking, container execution endpoints, and runner binding remain separate
  follow-up slices.

Required blocker codes for any future sandbox-backed runner:

```text
sandbox_profile_missing
sandbox_backend_unverified
sandbox_artifact_import_unverified
sandbox_network_policy_unverified
```

## Adapter A: Codex App-Server

### Goal

Use a local or bundled Codex app-server as an execution backend while preserving Ling's
approval/audit/runtime model.
This adapter is separate from Ling's own long-term app-server-like control-plane
layering, which is covered by
[Runtime Control Plane Long-Term Implementation Plan](runtime-control-plane-long-term-implementation-plan.md).

### Feature Flag

```json
{
  "runners": {
    "codexAppServer": {
      "enabled": false,
      "baseUrl": "http://127.0.0.1:xxxxx",
      "launchMode": "external"
    }
  }
}
```

Do not expose `codex-app-server` in user-facing pickers until:

- health check passes;
- conformance passes;
- approval interception is proven for side-effecting tools;
- cancellation and stale completion tests pass.

### Request Mapping

Ling run request:

```text
cwd
task title/prompt
provider preset
tools
approval profile
mcp tools
resume context
```

Codex app-server request:

```text
workspace path
model/provider config
instruction/messages
tool policy
session handle?
event stream
```

The adapter maps:

- Ling task prompt -> Codex instruction/messages;
- Ling provider preset -> Codex provider config or server-side model selector;
- Ling allowed tools -> Codex tool allowlist;
- Ling approval request -> Ling approval API;
- Codex events -> normalized `PiRunnerEvent` stream.

### Approval Boundary

Codex may have its own approval model. Ling must remain authoritative:

- if Codex asks approval, adapter converts it to Ling approval request;
- if Ling denies, adapter reports denial to Codex and blocks the action;
- if Codex cannot pause before side effect, the runner must not be enabled for write
  tools;
- provider/credential/deploy operations require Ling critical approval.

### Resume

Supported modes:

1. native Codex resume using `RunnerSessionHandle`;
2. Ling explicit resume context fallback.

Native resume must pass the same tests as fallback resume:

- continuation lineage;
- stale completion audit;
- approval policy;
- cancellation;
- no hidden state mutation.

### Failure Modes

| Failure | Behavior |
| --- | --- |
| app-server unavailable | `unsupported_runner` or fallback according to policy |
| stream disconnect | fail run with structured error; stale late completion ignored |
| approval bridge unavailable | fail closed for side-effecting tools |
| native resume rejected | fall back to explicit Ling resume context when allowed |
| workspace mismatch | reject before run creation |

### Tests

- health and capability probe;
- normalized text/thinking/tool event stream;
- approval pause/approve/deny;
- write denied before side effect;
- abort propagates to app-server;
- late success after cancel records stale audit only;
- native resume handle lifecycle;
- secret redaction in request snapshots and runtime events.

## Adapter B: OpenClaw / ACP

### Goal

Delegate a Ling run to an external OpenClaw/ACP-compatible agent while Ling keeps
workspace state, approvals, audit, and orchestration.

### Integration Shape

```text
Ling Run
  -> RunnerRegistry
    -> openclaw-acp adapter
      -> ACP client
        -> OpenClaw/external agent session
```

The adapter is a client bridge. It does not embed OpenClaw as a nested Ling runtime.

### Feature Flag

```json
{
  "runners": {
    "openclawAcp": {
      "enabled": false,
      "endpoint": "http://127.0.0.1:xxxxx",
      "workspaceMode": "bound_path"
    }
  }
}
```

### Capability Negotiation

The ACP endpoint must report:

- supported tool categories;
- whether tool calls are interceptable before side effects;
- artifact/event schema version;
- cancellation support;
- session/resume support;
- workspace path constraints.

If negotiation is missing or incomplete:

- allow read-only runs only, or
- fail closed if the requested run includes write/deploy/provider/credential tools.

### Approval Boundary

OpenClaw/ACP must not bypass Ling approvals:

- side-effectful tool proposals become Ling approval requests;
- approval result is sent back to the ACP session;
- if ACP reports a side effect without a prior approval proposal, Ling marks the run
  failed and records a policy violation event;
- repeated violations disable the runner for the workspace until explicit repair.

### Workspace Boundary

The adapter must enforce:

- `cwd` is inside the workspace/bound path;
- artifacts are copied into Ling artifact roots, not referenced only by remote paths;
- raw external session logs are treated as untrusted evidence;
- no external agent can mutate provider secrets directly.

### Resume

OpenClaw/ACP native sessions are optional:

- store `backendSessionId` only as adapter metadata;
- explicit Ling resume context remains the fallback;
- external memory/persona state is never silently promoted into Ling teammate memory.

### Failure Modes

| Failure | Behavior |
| --- | --- |
| ACP endpoint unavailable | fail or fallback according to runner policy |
| missing capability negotiation | read-only only or fail closed |
| unapproved side effect | fail run and emit policy violation evidence |
| remote session lost | fail run; resume through Ling context if possible |
| remote artifact inaccessible | mark artifact import failed; keep run evidence |

### Tests

- fake ACP server conformance harness;
- capability negotiation gates write tools;
- approval proposal/approve/deny round trip;
- unapproved side-effect violation fails closed;
- cancellation closes remote session;
- remote artifacts are imported and redacted;
- native resume handle is optional and never required for Ling resume.

## Shared Rollout Plan

Use the detailed implementation plan as the source of truth for PR-sized slices. The
high-level order is:

1. keep disabled registrations for `codex-app-server` and `openclaw-acp`;
2. add shared readiness/doctor contracts before real adapters;
3. extract reusable runner conformance helpers;
4. implement a fake ACP server before wiring real OpenClaw;
5. add shared approval, workspace-boundary, tool-surface, and artifact bridges;
6. implement `openclaw-acp` behind feature flag, readiness, and conformance gates;
7. implement `codex-app-server` as a dedicated adapter, not ACP by default;
8. write a Hermes decision record before adding any Hermes runner id;
9. expose picker options only for enabled, healthy, conformant runners.

## Security Requirements

- No adapter can access raw provider secrets outside the existing secret resolver.
- No adapter can perform writes without Ling approval interception.
- No adapter can mark Ling workflow steps terminal directly.
- No adapter can silently create or mutate Ling memory/persona.
- All adapter errors must be structured and auditable.
- All external logs and artifacts are untrusted until copied into Ling artifact storage.

## Exit Criteria

- Pi behavior unchanged when no feature flag is enabled.
- Unknown/disabled adapter ids fail closed unless fallback policy explicitly allows Pi.
- Adapter conformance covers stream, tool, approval, cancellation, artifact, error, and
  secret-redaction behavior.
- Web runner picker only shows healthy enabled adapters.
- Runner audit surfaces show requested/effective runner, source, fallback policy, and
  adapter failure reason.
