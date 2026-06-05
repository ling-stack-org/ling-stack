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
- No Codex app-server or OpenClaw/ACP backend is enabled today.

This document covers:

1. `codex-app-server` adapter;
2. `openclaw-acp` adapter;
3. shared adapter conformance, security, audit, and rollout rules.

## Principles

- Adapters are execution backends, not new orchestrators.
- Ling owns task/run/thread/workflow state.
- Ling owns approval policy, tool gating, and audit evidence.
- Runner backends may maintain opaque session handles, but they cannot be the source of
  truth for Ling state.
- Feature flags must keep new adapters disabled by default.
- Pi remains the fallback/default until a workspace explicitly enables another runner.

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

## Adapter A: Codex App-Server

### Goal

Use a local or bundled Codex app-server as an execution backend while preserving Ling's
approval/audit/runtime model.

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

1. Extend runner conformance harness with adapter capability fixtures.
2. Add disabled registrations for `codex-app-server` and `openclaw-acp`.
3. Add health/capability routes for registered disabled runners.
4. Implement Codex app-server adapter behind feature flag.
5. Implement fake ACP conformance harness before real OpenClaw endpoint.
6. Add OpenClaw/ACP adapter behind feature flag.
7. Expose picker only for enabled, healthy, conformant runners.

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
