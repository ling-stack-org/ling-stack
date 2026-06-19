# OpenAI Agents SDK Runtime Patterns

## Status

Design baseline for implementation planning.

This document records which OpenAI Agents SDK patterns Ling Stack should borrow, how
those patterns map onto the existing daemon-owned runtime, and which boundaries must not
move.

## Purpose

OpenAI Agents SDK is useful as a reference because it has clean primitives for:

- tracing an agent run as spans;
- pausing tool execution for human approval and resuming from run state;
- representing handoff to another specialist as a model-callable tool;
- reducing large tool surfaces with namespaces and deferred loading;
- binding an agent to a sandbox workspace with manifests, capabilities, sessions, and
  snapshots.

Ling should borrow those runtime patterns without replacing its product contract. Ling is
not just an agent loop. Ling owns durable workspace state, tasks, threads, workflows, work
units, approvals, artifacts, memory audit, runner selection, and recovery.

## Upstream Inputs

These upstream concepts were checked on 2026-06-18:

- [OpenAI Agents SDK overview](https://openai.github.io/openai-agents-python/)
- [Human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)
- [Handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- [Tracing](https://openai.github.io/openai-agents-python/tracing/)
- [Tools and hosted tool search](https://openai.github.io/openai-agents-python/tools/)
- [Sandbox Agents quickstart](https://openai.github.io/openai-agents-python/sandbox_agents/)
- [Sandbox Agents concepts](https://openai.github.io/openai-agents-python/sandbox/guide/)

Treat these as inspiration, not as a dependency. Sandbox Agents are still beta upstream.
Their names, defaults, and supported capabilities may change.

## Ling Baseline

The current Ling runtime contract already has the important product boundaries:

- [Runtime Supervisor](runtime-supervisor.md) owns work units, attempts, heartbeats,
  leases, semaphores, cancellation, retry, reconcile, and startup recovery.
- [Codex-Like Execution Experience](codex-like-execution.md) owns long-lived threads,
  approvals, execution actions, evidence bundles, and resume/redirect behavior.
- [Runner Registry](runner-registry.md) owns requested/effective runner resolution and
  conformance.
- [Runner Adapters](runner-adapters.md) defines future non-Pi execution backends.
- [Core Tools, Runners, MCP Tools, and Plugin Boundary](core-tools-runtime-boundary.md)
  keeps core tools, MCP tools, runners, and plugins separate.
- [Run Interruption And Continuation](run-interruption-continuation.md) forbids hidden
  mid-run prompt injection and uses queued follow-up or interrupt-and-redirect.

Those docs remain authoritative. This document adds a borrowed-pattern layer on top of
them.

## Core Decision

Ling should introduce a shared "agent runtime pattern" contract with five pieces:

```text
LingTrace
  -> spans for runs, tool calls, approvals, handoffs, sandbox work, artifacts

LingApprovalCheckpoint
  -> paused side-effect intent + durable approval + optional runner resume handle

LingHandoffIntent
  -> structured delegation proposal + filtered context + workflow linkage

LingToolSurfaceCatalog
  -> namespaces, descriptors, deferred materialization, policy overlay

LingSandboxProfile
  -> manifest, capabilities, session refs, snapshots, artifact import
```

These are Ling-owned contracts. A runner adapter may expose similar concepts, but the
adapter must normalize them into Ling records before they influence product state.

## Pattern 1: Trace And Span Event Model

### Problem

Ling currently has run events, runtime events, state transitions, approvals, execution
actions, artifacts, workflow events, and evidence bundles. That is the right durable
model, but debugging still requires stitching several records together.

Agents SDK tracing gives a useful shape: one trace represents an end-to-end workflow, and
spans represent nested operations such as model generation, tool calls, handoffs, and
guardrail checks.

### Ling Contract

Add a read-model-oriented trace contract:

```ts
type LingTraceSubjectKind =
  | "thread"
  | "run"
  | "work_unit"
  | "workflow"
  | "workflow_step"
  | "external_work"
  | "media_job";

type LingTraceSpanKind =
  | "workflow"
  | "workflow_step"
  | "agent_run"
  | "model_generation"
  | "tool_call"
  | "approval"
  | "handoff"
  | "sandbox"
  | "artifact"
  | "state_transition"
  | "memory"
  | "external_action"
  | "error";

interface LingTrace {
  readonly id: string;
  readonly workspaceId: string;
  readonly subjectKind: LingTraceSubjectKind;
  readonly subjectId: string;
  readonly title: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly status: "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";
}

interface LingTraceSpan {
  readonly id: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly kind: LingTraceSpanKind;
  readonly title: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly status: "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled" | "skipped";
  readonly refs: LingTraceRefs;
  readonly summary?: string;
  readonly redactedAttributes?: Record<string, unknown>;
}

interface LingTraceRefs {
  readonly threadId?: string;
  readonly runId?: string;
  readonly workUnitId?: string;
  readonly attemptId?: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly approvalId?: string;
  readonly executionActionId?: string;
  readonly artifactId?: string;
  readonly handoffId?: string;
  readonly sandboxSessionId?: string;
  readonly stateTransitionId?: string;
}
```

### Persistence Strategy

Start as a projection, not a new source of truth:

```text
run_events
runtime_events
state_transitions
approval_requests
execution_actions
artifacts
workflow_steps
run_interventions
  -> trace projector
  -> LingTrace + LingTraceSpan DTOs
```

Only add `trace_spans` storage after the projection proves useful and repeated rebuild
cost becomes real.

### Rules

- A trace span never makes a state transition legal. State machines still decide legality.
- Span status is derived from durable domain records.
- Trace attributes must be redacted before persistence or API output.
- Runner-native spans can be imported only after id normalization and redaction.
- Missing trace data must not block run completion.

### First UI

Use traces to improve existing evidence surfaces:

- thread evidence timeline grouped by trace spans;
- workflow step detail with nested run/tool/approval spans;
- runner conformance debug output;
- runtime diagnostics for stale or waiting work.

## Pattern 2: HITL Approval And Resume

### Problem

Agents SDK treats human approval as an intentional paused run. Tool execution stops before
the side effect, the application resolves the interruption, and the run resumes from the
same state.

Ling already has durable approval records and `waiting_for_approval` states. The missing
piece is an explicit checkpoint model that connects an approval to what can be resumed.

### Ling Contract

Introduce an approval checkpoint read/write model:

```ts
type ApprovalCheckpointStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled"
  | "resume_pending"
  | "resumed"
  | "resume_failed";

interface LingApprovalCheckpoint {
  readonly id: string;
  readonly workspaceId: string;
  readonly approvalId: string;
  readonly runId?: string;
  readonly workUnitId?: string;
  readonly attemptId?: string;
  readonly workflowStepId?: string;
  readonly actionId?: string;
  readonly status: ApprovalCheckpointStatus;
  readonly sideEffect: LingSideEffectClass;
  readonly previewArtifactId?: string;
  readonly resultArtifactId?: string;
  readonly runnerResumeHandle?: RunnerResumeHandle;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type LingSideEffectClass =
  | "workspace_read"
  | "workspace_write"
  | "shell"
  | "mcp_tool"
  | "provider_or_secret"
  | "external_delivery"
  | "deploy"
  | "cost";

interface RunnerResumeHandle {
  readonly runnerId: string;
  readonly handleKind: "none" | "opaque_state_ref" | "session_ref" | "snapshot_ref";
  readonly ref?: string;
  readonly expiresAt?: string;
  readonly conformance: "verified" | "unverified";
}
```

### Lifecycle

```text
runner proposes side-effect
  -> daemon classifies side-effect
  -> daemon creates approval request
  -> daemon creates approval checkpoint
  -> work unit/run enters waiting_for_approval
  -> user approves or denies
  -> checkpoint records decision
  -> runner resumes from verified handle or Ling continuation context
```

### Resume Semantics

There are two resume modes:

| Mode | Source | Use when |
| --- | --- | --- |
| Ling continuation resume | Ling thread, run, evidence, artifacts, and intervention context | Always available fallback |
| Runner-native resume | Verified opaque state from the runner adapter | Optional fidelity improvement |

Runner-native resume must pass conformance. If it cannot prove that approval was applied
before the side effect, the runner stays disabled for side-effect-capable tools.

### Partial Approval

An approval pause can contain more than one pending side effect. Ling should support
resolving them independently:

- approved actions may continue;
- denied actions return a model-visible denial reason;
- unresolved actions keep the run or work unit blocked;
- every decision is idempotent by approval id and action id.

### Rules

- Approval text cannot grant new tools, secrets, workspace scope, deployment authority, or
  external-send authority.
- Sticky approval decisions must be scoped to the run/checkpoint unless a separate
  workspace policy change is approved.
- Late runner success after denial/cancel is ignored and recorded as stale completion.
- Checkpoint records may refer to runner state, but they do not trust runner state as the
  Ling source of truth.

## Pattern 3: Structured Handoff Protocol

### Problem

Agents SDK represents handoffs as tools. The model can choose a destination specialist,
provide structured input, and the runtime can filter the context passed to the next
agent.

Ling already has channel handoffs, workflow handoff intents, workflow steps, selectors,
and multi-agent orchestration. The risk is letting a model-produced handoff directly
start hidden work or move workflow state.

### Ling Contract

Use one durable handoff intent shape across channel handoffs and workflow handoffs:

```ts
type LingHandoffIntentStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "compiled_to_workflow_step"
  | "started"
  | "completed"
  | "cancelled";

interface LingHandoffIntent {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceKind: "thread" | "run" | "workflow_step" | "channel_message" | "external_work";
  readonly sourceId: string;
  readonly fromParticipantId: string;
  readonly toParticipantId: string;
  readonly toRole: "product" | "architect" | "engineer" | "designer" | "qa" | "security" | "release" | "docs" | "custom";
  readonly reason: string;
  readonly expectedOutput: string;
  readonly priority: "low" | "normal" | "high";
  readonly status: LingHandoffIntentStatus;
  readonly inputPacketId?: string;
  readonly outputPacketId?: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly approvalGateId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

### Context Filtering

A handoff should carry a bounded input packet:

```ts
type LingContextRefKind =
  | "message"
  | "run"
  | "artifact"
  | "file"
  | "approval"
  | "state_transition"
  | "memory_candidate"
  | "external_work";

interface LingContextRef {
  readonly kind: LingContextRefKind;
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly redaction: "none" | "summary_only" | "metadata_only";
}

interface LingOmittedContextRef {
  readonly kind: LingContextRefKind;
  readonly id: string;
  readonly reason:
    | "not_relevant"
    | "over_budget"
    | "permission_denied"
    | "secret_adjacent"
    | "unsafe_for_role";
}

interface LingHandoffInputPacket {
  readonly id: string;
  readonly workspaceId: string;
  readonly handoffIntentId: string;
  readonly sourceSummary: string;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly allowedRefs: readonly LingContextRef[];
  readonly omittedRefs: readonly LingOmittedContextRef[];
  readonly requiredTools: readonly string[];
  readonly approvalProfile: SkillApprovalProfile;
}
```

The input packet is the Ling equivalent of an input filter. It is explicit, reviewable,
and can be regenerated.

### Rules

- A handoff proposal does not start a runner by itself.
- A handoff does not approve its own tools or workflow gates.
- Context transfer must be explicit and bounded.
- The receiving teammate gets the input packet, not the entire hidden transcript.
- Workflow compilation must write durable workflow and workflow-step records before any
  execution starts.

## Pattern 4: Tool Namespace And Deferred Loading

### Problem

Large tool surfaces waste context and make the model choose among too many low-level
schemas. Agents SDK's tool search and namespace pattern is useful because the model can
load a small group of relevant tools when needed.

Ling already separates core tools, MCP tools, plugins, and runner capabilities. The next
step is a catalog layer that lets a run expose a small searchable surface without
flattening every tool into the prompt.

### Ling Contract

```ts
type LingToolSurfaceKind = "core" | "mcp" | "plugin" | "runner" | "skill";

interface LingToolNamespace {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly kind: LingToolSurfaceKind;
  readonly ownerId?: string;
  readonly toolIds: readonly string[];
  readonly defaultApprovalProfile?: SkillApprovalProfile;
  readonly maxMaterializedTools: number;
}

interface LingToolDescriptor {
  readonly id: string;
  readonly namespaceId?: string;
  readonly name: string;
  readonly description: string;
  readonly schemaSummary: string;
  readonly fullSchemaArtifactId?: string;
  readonly sideEffect: LingSideEffectClass;
  readonly materialization: "immediate" | "deferred";
  readonly policyDecision: "allow" | "ask" | "deny";
}

interface LingToolLoadRequest {
  readonly id: string;
  readonly runId: string;
  readonly namespaceId?: string;
  readonly toolId?: string;
  readonly reason: string;
  readonly status: "proposed" | "materialized" | "denied" | "failed";
}
```

### Resolution Flow

```text
run request
  -> allowed core tools + selected MCP bindings + skill-required tools
  -> compile namespaces and descriptors
  -> materialize small prompt surface
  -> model requests namespace/tool load
  -> daemon checks policy and context budget
  -> materialize schema or reject over-budget
```

### Runner-Native Hydration Flow

P8 and P9 intentionally keep materialization as daemon/API/Web state. A runner does not
receive newly materialized schemas until it advertises a verified hydration capability.

```ts
interface LingRunnerToolHydrationCapability {
  readonly mode: "unsupported" | "daemon_hydrated";
  readonly supportsNamespaceSearch: boolean;
  readonly supportsToolHydration: boolean;
  readonly conformance: "unverified" | "verified";
  readonly maxHydratedToolsPerRun: number;
}

interface LingRunnerToolHydrationRequest {
  readonly runId: string;
  readonly runnerAttemptId: string;
  readonly scope:
    | { readonly kind: "namespace"; readonly namespaceId: string }
    | { readonly kind: "tool"; readonly toolId: string };
  readonly reason: string;
  readonly idempotencyKey: string;
}

interface LingRunnerHydratedToolSurface {
  readonly materializationId: string;
  readonly namespaceId: string;
  readonly toolIds: readonly string[];
  readonly budget: {
    readonly estimatedTokens: number;
    readonly inputBudgetTokens: number;
    readonly remainingBudgetTokens: number;
  };
}
```

`LingRunnerHydratedToolSurface` is a runner-only DTO. It may be extended with sanitized
`inputSchema` payloads for the active runner turn. The public P8/P9 materialization
response remains summary-only for Web/API and runtime evidence.

The runner-facing flow is:

```text
runner prompt gets small catalog/search surface
  -> model asks runner to load a namespace/tool
  -> runner sends a hydration request to daemon
  -> daemon resolves policy + context budget + idempotency
  -> daemon records materialization evidence
  -> daemon returns sanitized schema payload to runner
  -> runner may include that schema in the next model turn
```

Hydration is a transport mechanism, not an authority change. If a tool is `ask` or
`deny`, the hydrated schema can be visible to the model, but execution still goes through
the normal approval policy and side-effect gates.

### Rules

- Loading a tool schema does not authorize execution.
- Namespace membership does not override workspace approval policy.
- Core tools remain the stable product permission contract.
- MCP tools keep server identity and per-tool side-effect metadata.
- Plugin Manager can install a bundle, but explicit binding and policy still decide
  whether a run can see or use its tools.
- Deferred loading must be logged as a runtime event so evidence explains why a tool
  became available mid-run.
- Context budget rejection happens before the materialization runtime event and does not
  grant execution authority or inject a schema into the runner prompt.
- Runner-native hydration requires conformance before it can be selected; unverified
  runners continue using the daemon/API/Web-only materialization surface.
- The daemon must be the only schema hydration authority. Runners cannot self-materialize
  hidden MCP/plugin schemas from local config.
- Hydration responses may include schema payloads for the active runner turn, but runtime
  events and Web evidence must continue storing bounded summaries rather than raw schemas.
- P11 implements hydration in a fake conformance runner first, then in embedded Pi behind
  a feature flag. Other adapters remain unsupported until they pass the same conformance
  suite.

## Pattern 5: Sandbox Manifest And Capabilities

### Problem

Sandbox Agents bind an agent to a persistent workspace, a manifest for fresh sessions,
capabilities such as shell or filesystem tools, and session/snapshot resume choices.

Ling needs the same conceptual split for future sandbox-backed runners, but the sandbox
must not become the source of truth for Ling work.

### Ling Contract

```ts
type LingSandboxBackend = "none" | "local_unix" | "docker" | "hosted" | "external";

interface LingSandboxProfile {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly backend: LingSandboxBackend;
  readonly manifest: LingSandboxManifest;
  readonly capabilities: readonly LingSandboxCapability[];
  readonly defaultRunAs?: string;
  readonly networkPolicy: LingSandboxNetworkPolicy;
  readonly artifactImportPolicy: LingSandboxArtifactImportPolicy;
  readonly status: "draft" | "ready" | "blocked" | "disabled";
}

interface LingSandboxManifest {
  readonly workspaceRoot: string;
  readonly entries: readonly LingSandboxEntry[];
  readonly mounts: readonly LingSandboxMount[];
  readonly envRefs: readonly LingEnvRef[];
  readonly outputRoots: readonly string[];
}

interface LingSandboxEntry {
  readonly source: "workspace" | "artifact" | "generated" | "empty_dir";
  readonly fromRef?: string;
  readonly toPath: string;
  readonly mode: "read_only" | "read_write";
}

interface LingSandboxMount {
  readonly hostPathRef: string;
  readonly sandboxPath: string;
  readonly mode: "read_only" | "read_write";
}

interface LingEnvRef {
  readonly name: string;
  readonly valueRef: string;
  readonly required: boolean;
}

interface LingSandboxNetworkPolicy {
  readonly mode: "disabled" | "allowlist" | "open_with_approval";
  readonly allowedHosts?: readonly string[];
}

interface LingSandboxArtifactImportPolicy {
  readonly importMode: "none" | "explicit" | "auto_from_output_roots";
  readonly maxBytes?: number;
  readonly requireApprovalForWorkspaceWrites: boolean;
}

interface LingSandboxCapability {
  readonly id: "filesystem" | "shell" | "skills" | "memory" | "compaction" | "image_inspection";
  readonly enabled: boolean;
  readonly approvalProfile?: SkillApprovalProfile;
  readonly notes?: string;
}

interface LingSandboxSessionRef {
  readonly id: string;
  readonly sandboxProfileId: string;
  readonly backend: LingSandboxBackend;
  readonly backendSessionId?: string;
  readonly stateRef?: string;
  readonly snapshotArtifactId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}
```

### Boundary

```text
Ling daemon/runtime supervisor
  owns work unit, approval, trace, artifact, state machine, memory candidate

sandbox session
  owns isolated filesystem, process execution, sandbox-local files, sandbox-local state

artifact importer
  copies approved outputs back into Ling artifact roots with redaction and provenance
```

### Rules

- A sandbox manifest describes starting workspace inputs, not final Ling state.
- Sandbox state can seed resume, but Ling thread/run/work-unit state remains authoritative.
- Sandbox filesystem writes must be imported before the user treats them as Ling artifacts.
- Raw secrets must not be copied into manifests or snapshots.
- Network access defaults to disabled or allowlisted.
- Hosted sandbox providers require feature flags, doctor checks, and conformance tests.
- `local_unix` is acceptable for development, but it is not isolation. Docker or hosted
  backends are required before treating untrusted input as isolated.
- P12 targets Docker as the first real sandbox backend. Hosted and external backends stay
  future adapter decisions after Docker artifact import, network policy, and secret
  redaction conformance pass.

## Cross-Pattern Data Flow

The five patterns should compose like this:

```text
User starts work
  -> runtime supervisor creates work unit
  -> trace projector opens trace/workflow span
  -> runner receives bounded tool namespace catalog
  -> runner proposes side effect
  -> approval checkpoint pauses run
  -> trace records approval span
  -> user approves
  -> runner resumes or Ling starts continuation
  -> model proposes handoff
  -> Ling records handoff intent and input packet
  -> workflow step starts through normal runner path
  -> optional sandbox session executes isolated work
  -> artifact importer records outputs
  -> trace closes spans from durable state
```

## API Surface

Recommended API additions should be read-first:

```text
GET /traces?cwd=...&threadId=...
GET /traces/:id?cwd=...
GET /traces/:id/spans?cwd=...

GET /approval-checkpoints?cwd=...&runId=...
GET /approval-checkpoints/:id?cwd=...

GET /tool-surfaces?cwd=...&runId=...
POST /runs/:id/tool-load-requests

GET /sandbox-profiles?cwd=...
GET /sandbox-profiles/:id?cwd=...
GET /sandbox-sessions/:id?cwd=...
```

Mutation endpoints should wait until the read model and conformance tests are stable.

## Storage Strategy

Prefer additive tables or regenerated projections:

| Record | Initial storage | Long-term storage |
| --- | --- | --- |
| Trace | regenerated from existing events | optional `runtime_traces` |
| Span | regenerated from existing events | optional `runtime_trace_spans` |
| Approval checkpoint | new durable table linked to `approval_requests` | same |
| Handoff intent | converge existing channel/workflow records | unified handoff table if migration pays off |
| Tool namespace | generated from runtime settings/MCP/skills | cached catalog table if expensive |
| Sandbox profile | runtime settings or workspace config | `sandbox_profiles` table |
| Sandbox session ref | runner attempt metadata | `sandbox_sessions` table |

Do not add tables before the implementation slice needs write durability.

## Runner Conformance

Any future adapter that claims Agents-SDK-like capabilities must prove:

- trace import does not bypass Ling state;
- approval proposal pauses before side effects;
- denied approval prevents execution and returns a model-visible denial;
- resume after approval is idempotent;
- handoff proposals become Ling handoff intents, not hidden runner starts;
- deferred tool loading cannot bypass policy;
- runner-native schema hydration cannot bypass policy or context budget;
- sandbox artifacts import into Ling artifact roots;
- cancellation prevents late success from mutating terminal state;
- secrets are redacted from traces, manifests, snapshots, and artifacts.

## Security And Privacy

- Store opaque runner state as refs, not raw serialized blobs in public artifacts.
- Redact prompts, tool arguments, file paths, and outputs before exposing them outside the
  workspace.
- Never put API keys, bearer tokens, SSH keys, keychain values, or raw provider secrets in
  sandbox manifests, trace attributes, approval previews, or snapshots.
- Approval decisions must include actor, timestamp, target snapshot, and policy snapshot.
- External send, deploy, provider mutation, and credential mutation stay strict approval
  paths.

## What Not To Do

- Do not replace Runtime Supervisor with an Agents SDK run loop.
- Do not make OpenAI provider presets into runner adapters.
- Do not require Python in the main Ling daemon because Agents SDK is Python-first.
- Do not trust upstream sandbox state as Ling state.
- Do not materialize every MCP or plugin tool into the prompt.
- Do not add hidden mid-run prompt injection.
- Do not auto-start handoff targets from model text without durable workflow records.

## Implementation Entry Point

The staged implementation plan is
[OpenAI Agents SDK Runtime Patterns Implementation Plan](openai-agents-sdk-runtime-patterns-implementation-plan.md).
