# Runner Adapters

> 2026-10-18 design change: endpoint-based Codex/OpenClaw activation and rollout
> sections below are historical and superseded by
> [Native Execution Engines](native-execution-engines.md). Legacy endpoint flags
> are being retired; native selection requires an explicit profile and current
> acceptance. Implementation is tracked in the linked native plan.

## Purpose

This document defines how Ling Stack should add non-Pi execution backends after the
implemented `RunnerRegistry` slice.

Current boundary:

- Pi remains the default effective runner.
- `RunnerRegistry` resolves runner ids, aliases, allowed runners, provider/tool
  conformance, explicit/implicit fallback policy, and audit metadata.
- Runs, work units, attempts, workflow steps, and Run History retain runner audit.
- `codex-app-server` and `openclaw-acp` remain feature-gated external runners and fail
  closed until endpoint, readiness, and conformance gates pass.
- No external runner is enabled by default or shown in ordinary Settings.
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
  `disabledReason` metadata, so internal diagnostics and audit clients can explain why
  `codex-app-server` and `openclaw-acp` are unavailable.
- daemon config can express `runners.codexAppServer.enabled` and
  `runners.openclawAcp.enabled`, but registrations fail closed until endpoint and
  readiness gates pass. Tool execution is controlled separately by a code-owned,
  adapter-revision-bound conformance receipt; workspace config cannot self-assert it.
- external adapter receipts currently curate only `read`, `grep`, `find`, and `ls` with
  `none/workspace_read` side effects. Runner-native command, edit, write, network,
  secret, delivery, and MCP effects remain disabled.
- every external tool proposal is checked against the active Run tool list, curated
  receipt, side-effect class, adapter revision, evidence commit, abort propagation,
  Attempt fencing, and workspace boundary before Ling publishes normalized evidence.
- the old external-runner `conformancePassed` config boolean has been removed. Missing
  receipts, revision drift, undeclared tools, and side-effectful proposals fail closed.
- ordinary Settings uses Pi implicitly and does not expose runner selection, feature
  flags, readiness blockers, or fallback controls;
- sandbox profile contracts now define fail-closed backend verification, network policy,
  artifact import, secret-ref, and opaque session-ref gates without enabling a sandbox
  backend.

Still future:

- daemon-managed connection setup or service launch instead of manual endpoint wiring;
- automatic readiness and capability probes that persist endpoint evidence rather than
  trusting the remaining manually entered `readinessPassed` bootstrap flag;
- full command/edit/write parity through Ling's durable ToolExecution broker. It remains
  blocked until the external protocol supports a real pre-side-effect Host round trip;
- safe fallback behavior with clear requested/effective runner audit;
- OpenAI Agents SDK adapter decision refresh after platform-native sandbox policy and
  runner hydration observability are implemented;
- wiring sandbox profile readiness into a concrete runner adapter after artifact import,
  network policy, and secret redaction conformance exists;
- adapter decision records for Hermes, Claude, Gemini, or other future runtimes only when
  they expose an executable agent session rather than only a model API;
- a user-facing runner picker only after at least two runners are healthy, conformant,
  capability-complete, and suitable for the same product workflows.

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
| OpenAI Agents SDK | Ling only needs OpenAI model access through an existing provider preset. | Ling wraps the SDK behind a sidecar that exposes sessions, tools, approvals, artifacts, cancellation, sandbox/workspace boundaries, and resume handles. | Deferred design record only; no runner id until P14/P15 hardening and conformance gates pass. |
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

`message_end` may carry a sanitized final assistant `text` plus bounded terminal metadata:
`stopReason`, a generic `errorMessage`, and an allowlisted `contentKinds` list. Consumers
use streamed `assistant_text_delta` content first and fall back to final text only when no
deltas were emitted. Adapters must not expose the full raw provider message, provider
payload fields, secrets, or reasoning text, and must not duplicate final text after a
streamed response. A chat consumer treats an otherwise successful run with neither delta
text nor final text as an output-compatibility failure.

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
| `platform_native` | OS-enforced local sandboxing, selected per host platform. | macOS doctor/run-plan exists; Pi readiness binding is feature-gated; in-process Pi is not OS-wrapped yet |
| `docker` | A container-backed execution boundary. | Optional adapter exists; not the default Ling desktop/local path |
| `hosted` | A hosted sandbox provider such as E2B, Modal, Runloop, Vercel, Cloudflare, or OpenAI. | Disabled until adapter decision and conformance |
| `external` | A runner-owned sandbox exposed through an agent protocol. | Disabled until capability negotiation proves Ling gates |

Rules:

- profiles must verify backend behavior before readiness can become `ready`;
- network defaults to disabled, or an explicit non-wildcard allowlist;
- artifacts must be imported into Ling-owned artifact roots and redacted before appearing
  as Ling artifacts;
- injected secrets use `env:` or `keychain:` refs, never raw manifest values;
- session refs are opaque diagnostics, not user-facing labels or execution authority.
- Platform-native local sandboxing is the default direction, following Codex's local
  sandbox model: OS-enforced filesystem/process/network boundaries plus explicit approval
  gates for escaped operations. Current Pi binding verifies readiness and passes a
  sandbox DTO only; real OS-wrapped execution requires a child-process/tool-execution
  wrapper before untrusted code is considered isolated.
- Docker P12 verifies only disabled networking (`--network none`) and produces a run plan;
  allowlist networking, container execution endpoints, and runner binding remain separate
  follow-up slices. Docker is optional and should not become the default runner binding
  path just because the adapter exists.

Platform-native policy profiles should stay product-level and enforceable. The initial
set should mirror the local execution choices users already understand:

| Policy profile | Filesystem posture | Network posture | Default use |
| --- | --- | --- | --- |
| `read_only` | Workspace read-only plus imported artifacts. | Disabled unless explicitly approved. | Inspection, planning, code review |
| `workspace_write` | Writes only through approved workspace paths or artifact import. | Disabled unless explicitly approved. | Narrow coding tasks |
| `trusted_local` | Broader local writes, still audited and approval-gated. | Explicit allowlist only. | Maintainer-controlled local repair |
| `danger_full_access` | No sandbox claim; relies on explicit user approval. | Host network. | Emergency/manual override only |

These profiles are user-facing policy names, not backend names. A backend may implement a
profile only when doctor checks and conformance evidence prove that the claimed file,
process, network, artifact-import, and secret-redaction behavior is enforceable on the
host platform.

The Settings label `Sandbox settings` is currently a separate Ling permission-boundary
control. It may select read-only, workspace-write, or full-access behavior for approvals
and file tools, but it must not be presented as OS isolation while Pi still runs
in-process. Commands that cannot be proven to stay inside the workspace remain approval
gated until the platform-native execution wrapper is real and conformant.

Required blocker codes for any future sandbox-backed runner:

```text
sandbox_profile_missing
sandbox_backend_unverified
sandbox_artifact_import_unverified
sandbox_network_policy_unverified
sandbox_policy_unverified
sandbox_os_unsupported
sandbox_execution_wrapper_missing
```

## Adapter A: Codex App-Server

### Goal

Use a local or bundled Codex app-server as an execution backend while preserving Ling's
approval/audit/runtime model.
This adapter is separate from Ling's own long-term app-server-like control-plane
layering, which is covered by
[Runtime Control Plane Long-Term Implementation Plan](./runtime-control-plane-roadmap.md).

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
6. land P14/P15 sandbox policy and hydration observability before any SDK-backed runner;
7. implement `openclaw-acp` behind feature flag, readiness, and conformance gates;
8. implement `codex-app-server` as a dedicated adapter, not ACP by default;
9. refresh the OpenAI Agents SDK adapter decision before adding any SDK runner id;
10. write a Hermes decision record before adding any Hermes runner id;
11. expose a picker only after at least two enabled, healthy, conformant, capability-
    complete runners are available for the same product workflows.

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
- Any future Web runner picker is withheld until at least two healthy, enabled,
  conformant, capability-complete adapters are available.
- Runner audit surfaces show requested/effective runner, source, fallback policy, and
  adapter failure reason.
