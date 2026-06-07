# Codex-Inspired Runtime Tools P2: Permission Requests And Shell Snapshots

## Status

P2A first slice implemented; P2B remains a design plan.

This document details P2 from
[Codex-Inspired Runtime Tools](codex-inspired-runtime-tools.md): add a durable
permission-request bridge and diagnostic shell snapshots while preserving Ling's
existing core-tool, approval, runner, daemon, Web, and CLI boundaries.

P2 is intentionally not a Codex app-server migration. It borrows two runtime mechanics:

- a runner can ask for narrowly scoped permission when it is blocked;
- shell execution can expose redacted diagnostic snapshots.

Both mechanics stay under Ling daemon ownership. They do not redefine core tools, grant
silent access, or make shell state authoritative.

## Related Docs

- [Codex-Inspired Runtime Tools](codex-inspired-runtime-tools.md)
- [Codex-Inspired Runtime Tools P0: Apply-Patch Implementation](codex-inspired-runtime-tools-p0-apply-patch-implementation.md)
- [Codex-Inspired Runtime Tools P1: Unified Exec For Bash Implementation](codex-inspired-runtime-tools-p1-unified-exec-implementation.md)
- [Codex-Inspired Runtime Tools P2A: Permission Requests Implementation](codex-inspired-runtime-tools-p2a-permission-requests-implementation.md)
- [CLI Run I/O and Completion P1](cli-run-io-completion-p1.md)
- [Core Tools, Runners, MCP Tools, and Plugin Boundary](core-tools-runtime-boundary.md)
- [Approval Policy](approval-policy.md)
- [Runtime Supervisor](runtime-supervisor.md)
- [Runner Registry](runner-registry.md)
- [Runner Adapters](runner-adapters.md)
- [MCP Status Boundaries P2](mcp-status-boundaries-p2.md)

## Scope

P2 has two related but independently shippable tracks:

| Track | Name | Can Land Before P1 Unified Exec? | Purpose |
| --- | --- | --- | --- |
| P2A | Permission requests | Yes | Turn blocked runner requests into durable approval records and safe continuation paths |
| P2B | Shell snapshots | Contract only before P1; implementation after P1 | Capture redacted execution diagnostics for active or recently completed shell commands |

The split matters. Permission requests can build on existing approvals and run
interventions. Shell snapshots need a real normalized exec model so they do not become
ad hoc bash log scraping.

## Non-Goals

- No Codex app-server, JSON-RPC, or config-model migration.
- No new Plugin Manager cards for core tools or runtime feature gates.
- No hidden mid-run prompt injection into an active runner session.
- No runner-owned policy mutation.
- No persistent change to workspace approval policy from a run-scoped request unless a
  later explicit settings flow adds it.
- No shell-only replacement for `read`, `grep`, `find`, or `ls`.
- No shell snapshot as durable state authority or resume source of truth.
- No raw secret values in permission requests, snapshots, events, logs, or artifacts.
- No terminal session replay feature in P2.

## Terminology

### Approval Request

An existing Ling durable approval record. It is owned by the daemon, visible from Web and
CLI, resolved by the user, and audited in run/control-plane events.

### Permission Request

A P2-specific approval payload where the runner asks for a scoped capability it does not
currently have. It is not a normal tool approval. Normal `bash`, `edit`, `write`, and
MCP tool approvals still use the existing approval path.

Examples:

- request one missing core tool for the next continuation;
- request a narrower write scope for a specific path;
- request a specific MCP tool that is not in the current run snapshot;
- request a runner capability that the workspace policy may allow in a follow-up run.

### Run-Scoped Grant

A durable result of an approved permission request. It applies only to the current run
lineage or a daemon-created continuation, not to the workspace default policy.

### Shell Snapshot

A bounded diagnostic artifact for a shell command. It may include command metadata,
status, duration, exit code, redacted output tails, and PTY visible text when available.
It is evidence, not source of truth.

## P2A: Permission Requests

### Problem

Today the runner can hit several different blocked states:

- the requested core tool is not in the run's allowed tool snapshot;
- the tool is present but workspace policy denies it;
- an MCP tool is not bound to the teammate or was not included in the run snapshot;
- write scope is too narrow for the path the runner wants to touch;
- the selected runner lacks a capability the task needs.

For normal side-effect tools that are already available and set to `ask`, the existing
approval flow is sufficient. P2 targets the other cases: the runner needs a way to ask
for a capability without mutating policy, bypassing the daemon, or injecting new
instructions into a live session.

### Design Principles

- Permission requests are daemon-owned approvals.
- Approval can grant only the scope requested, or less.
- Denial is a normal runner result, not an exception that crashes orchestration.
- Approval does not silently change workspace policy.
- If the active runner cannot safely consume the grant, the daemon creates or suggests a
  continuation instead of modifying the live session.
- The request payload must be specific enough for Web and CLI review.

### Request Shape

Add a new approval payload variant in core:

```ts
type RuntimePermissionRequestKind =
  | "core_tool"
  | "write_scope"
  | "mcp_tool"
  | "runner_capability";

interface RuntimePermissionRequestPayload {
  readonly type: "runtime_permission_request";
  readonly requestKind: RuntimePermissionRequestKind;
  readonly requestedByRunId: string;
  readonly requestedByToolCallId?: string;
  readonly reason: string;
  readonly requestedScope: RuntimePermissionScope;
  readonly currentScope: RuntimePermissionScopeSnapshot;
  readonly proposedContinuation?: RuntimePermissionContinuationPlan;
}

type RuntimePermissionScope =
  | {
      readonly kind: "core_tool";
      readonly tools: readonly RunTool[];
    }
  | {
      readonly kind: "write_scope";
      readonly paths: readonly string[];
      readonly operation: "read_write" | "create" | "update" | "delete";
    }
  | {
      readonly kind: "mcp_tool";
      readonly serverId: string;
      readonly toolName: string;
      readonly sideEffectLevel: string;
      readonly defaultApproval: string;
    }
  | {
      readonly kind: "runner_capability";
      readonly runnerId: string;
      readonly capability: string;
    };

interface RuntimePermissionScopeSnapshot {
  readonly tools: readonly RunTool[];
  readonly allowedWritePaths: readonly string[];
  readonly mcpToolRefs: readonly string[];
  readonly runnerId: string;
}

interface RuntimePermissionContinuationPlan {
  readonly mode: "same_run_if_supported" | "queue_followup" | "interrupt_redirect";
  readonly toolDelta?: readonly RunTool[];
  readonly writePathDelta?: readonly string[];
  readonly mcpToolDelta?: readonly string[];
  readonly reason: string;
}
```

The payload should store normalized relative paths where possible. It must not store
raw secret values, environment values, bearer tokens, or full command output.

### Runner Contract

Add an optional runner callback:

```ts
interface PiRunnerPermissionRequest {
  readonly runId: string;
  readonly toolCallId?: string;
  readonly requestKind: RuntimePermissionRequestKind;
  readonly reason: string;
  readonly requestedScope: RuntimePermissionScope;
}

interface PiRunnerPermissionDecision {
  readonly approved: boolean;
  readonly approvalId?: string;
  readonly reason?: string;
  readonly grant?: RuntimePermissionGrant;
}

interface PiRunnerRunOptions {
  readonly onPermissionRequired?: (
    request: PiRunnerPermissionRequest,
  ) => PiRunnerPermissionDecision | Promise<PiRunnerPermissionDecision>;
}
```

P2 must not require all runners to implement this immediately. Runner registry
metadata should expose support:

```ts
interface RunnerRuntimeFeatureSupport {
  readonly requestPermissions?: boolean;
  readonly shellSnapshots?: boolean;
}
```

If a runner does not support permission requests, the daemon should turn the blocked
state into a clear denied result or a queued follow-up suggestion.

### Daemon Flow

1. Runner reports a permission request through `onPermissionRequired`.
2. Daemon validates the request against the run snapshot and workspace policy.
3. Daemon creates an approval request with `runtime_permission_request` payload.
4. Web/CLI render the scope delta and proposed continuation.
5. User approves, denies, or leaves it pending.
6. Daemon records the decision and produces a run-scoped grant or denial.
7. Runner receives a normalized decision.
8. If the grant cannot be consumed in the active session, daemon uses the continuation
   plan to create a follow-up run or interrupt redirect.

### Policy Evaluation

Permission requests still pass through existing policy.

Rules:

- A workspace-level `deny` remains deny. A permission request cannot override it.
- A skill approval profile can require stricter approval but cannot silently grant.
- Write scopes must remain within channel/workspace boundaries.
- MCP tool requests require the server and tool to exist in the catalog and pass MCP
  secret-status readiness checks.
- Runner capability requests require the runner to be registered and allowed by runtime
  settings.
- Approving a permission request grants at most the requested scope.

### Continuation Semantics

P2 should avoid live prompt injection. There are three safe outcomes:

| Outcome | Use When | Behavior |
| --- | --- | --- |
| `same_run_if_supported` | Runner can safely consume the grant without changing tool registry | Return grant to runner |
| `queue_followup` | Active session cannot gain tools dynamically, but current run can finish | Queue a continuation with expanded run-scoped snapshot |
| `interrupt_redirect` | Current run is blocked and should stop | Cancel source run and start continuation with expanded run-scoped snapshot |

The continuation prompt should be daemon-authored and factual. It should summarize the
approved scope and link the approval id. It must not inject arbitrary user text into the
active runner session.

### Grant Shape

```ts
interface RuntimePermissionGrant {
  readonly id: string;
  readonly approvalId: string;
  readonly runId: string;
  readonly lineageRootRunId?: string;
  readonly scope: RuntimePermissionScope;
  readonly mode: "same_run" | "continuation";
  readonly expiresAt?: string;
}
```

Grants should be stored as approval-linked evidence, not as workspace policy. A future
settings flow may offer "make this policy permanent", but P2 should not include it.

### API Surface

P2 can reuse existing approval endpoints and add read-only views:

```http
GET /permission-requests?cwd=...&runId=...
GET /permission-requests/:id?cwd=...
```

Approval resolution remains:

```http
POST /approvals/:id/approve?cwd=...
POST /approvals/:id/deny?cwd=...
```

The new endpoints are convenience read models over approval requests, grants, and linked
continuations. They should not introduce a second approval system.

### Web Behavior

Web approval cards should render:

- request kind;
- current scope;
- requested scope;
- policy blockers, if any;
- proposed continuation mode;
- approve/deny buttons using existing approval endpoints.

If a permission request leads to a continuation, the run timeline should show both the
approval and the created follow-up run.

### CLI Behavior

CLI should expose permission requests through existing approval commands first:

```text
ling-stack approvals list
ling-stack approvals show <approval-id>
ling-stack approvals approve <approval-id>
ling-stack approvals deny <approval-id>
```

Optional later sugar:

```text
ling-stack permissions list --run <run-id>
ling-stack permissions show <permission-request-id>
```

CLI output must preserve the P1 stdout/stderr contract. JSON mode prints JSON only.

### Failure Modes

| Failure | Behavior |
| --- | --- |
| Malformed request | Deny before approval; record readable runner result |
| Workspace policy denies scope | Create denied approval/action if current flow records denied attempts; no user override |
| Approval denied | Return normal denial to runner; no continuation |
| Approval expires | Return normal expired denial; no continuation |
| Runner cannot consume approved grant | Create or suggest continuation according to plan |
| Continuation creation fails | Approval remains approved but grant status is `failed_to_materialize`; run records error |
| Requested MCP tool missing | Fail closed with status-only diagnostic |
| Request includes secrets | Redact and fail closed if the secret is required for user display |

## P2B: Shell Snapshots

### Problem

When `bash` execution hangs, streams a lot of output, or fails late, users need a compact
diagnostic view: what command ran, where it ran, whether it had a PTY, what it last
printed, and why it stopped. Raw logs are too large and often contain secrets. Full
terminal replay would be too heavy for P2.

Shell snapshots provide bounded evidence for Web, CLI doctor, and debugging.

### Dependency On P1 Unified Exec

P2B should not implement shell snapshots against ad hoc bash events. It should wait for
the normalized `bash` exec backend from
[Codex-Inspired Runtime Tools P1: Unified Exec For Bash Implementation](codex-inspired-runtime-tools-p1-unified-exec-implementation.md).

Before unified exec exists, this document is the target contract only. The only safe
pre-P1 implementation is a no-op diagnostics shape that reports `unavailable`.

### Snapshot Shape

```ts
interface ShellSnapshot {
  readonly id: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly createdAt: string;
  readonly source: "exec_start" | "exec_update" | "exec_end" | "manual_diagnostic";
  readonly status: "starting" | "running" | "exited" | "cancelled" | "timed_out" | "failed";
  readonly command: ShellCommandSnapshot;
  readonly process?: ShellProcessSnapshot;
  readonly terminal?: ShellTerminalSnapshot;
  readonly output?: ShellOutputSnapshot;
  readonly redaction: ShellSnapshotRedactionSummary;
}

interface ShellCommandSnapshot {
  readonly cwd: string;
  readonly commandPreview: string;
  readonly argvPreview?: readonly string[];
  readonly shell?: string;
  readonly pty: boolean;
  readonly timeoutMs?: number;
}

interface ShellProcessSnapshot {
  readonly pid?: number;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly durationMs?: number;
}

interface ShellTerminalSnapshot {
  readonly rows?: number;
  readonly cols?: number;
  readonly visibleText?: string;
  readonly cursorRow?: number;
  readonly cursorCol?: number;
}

interface ShellOutputSnapshot {
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
  readonly stdoutArtifactId?: string;
  readonly stderrArtifactId?: string;
  readonly truncated: boolean;
}

interface ShellSnapshotRedactionSummary {
  readonly redacted: boolean;
  readonly ruleCount: number;
  readonly extraSecretCount: number;
}
```

### Artifact Placement

Snapshots should be artifacts, not a new durable state table in P2:

```text
.ling-stack/artifacts/<runId>/shell-snapshots/<toolCallId>/<sequence>.json
.ling-stack/artifacts/<runId>/shell-snapshots/<toolCallId>/<sequence>.txt
```

The JSON artifact is the structured contract. The text artifact is a bounded human
summary for Web and CLI display.

### Capture Points

Minimum capture points:

- command accepted after approval and before process start;
- first output chunk or PTY attach;
- periodic update for long-running commands;
- cancellation request;
- timeout;
- process exit.

P2 should not capture every output chunk as a snapshot. Raw output remains streamed and
artifact-backed according to unified exec rules.

### Bounds

Default limits:

- `commandPreview`: 4 KiB;
- `argvPreview`: 64 args, each 1 KiB;
- `visibleText`: 32 KiB;
- `stdoutTail`: 32 KiB;
- `stderrTail`: 32 KiB;
- one snapshot per 5 seconds for active commands unless state changes;
- at most 100 snapshots per tool call.

If a limit is exceeded, set `truncated: true` and keep artifact content valid.

### Redaction

Snapshots must call the shared redaction helper with:

- provider secret values resolved for the run;
- MCP secret values resolved for called MCP servers, if any;
- known secret patterns;
- authorization header patterns;
- user-configured redaction values when available.

Snapshots must not include:

- raw environment values;
- raw request headers;
- OAuth tokens;
- bearer tokens;
- API keys;
- secret refs resolved to values.

Environment summaries may include variable names and counts, not values.

### API Surface

Read-only endpoints:

```http
GET /runs/:runId/shell-snapshots?cwd=...
GET /runs/:runId/shell-snapshots/:snapshotId?cwd=...
```

These endpoints read artifact metadata/content and return status-only data. They should
not open live shells, attach to processes, or mutate runtime state.

Manual capture, if added, should be a diagnostic event routed through the daemon:

```http
POST /runs/:runId/shell-snapshots/capture?cwd=...
```

Manual capture is allowed only for active runs owned by the daemon runtime. It records an
artifact; it does not change process state.

### Web Behavior

Web can show snapshots in run/action detail:

- current command status;
- cwd;
- duration;
- exit code or signal;
- bounded output tail;
- PTY visible text when available;
- linked stdout/stderr artifacts.

The UI should label snapshots as diagnostics, not as replay or recovery.

### CLI Behavior

CLI should keep snapshots read-only:

```text
ling-stack runs shell-snapshots <run-id>
ling-stack runs shell-snapshot <run-id> <snapshot-id>
```

Optional doctor integration:

- show count of active commands with stale snapshots;
- show last snapshot age;
- warn when snapshot artifacts failed to write.

Doctor must not open a shell or capture a new snapshot by default.

### Failure Modes

| Failure | Behavior |
| --- | --- |
| Snapshot artifact write fails | Record best-effort warning; do not fail command execution unless approval evidence depends on it |
| Redaction fails | Fail closed for snapshot artifact; command execution can continue |
| Output exceeds bounds | Truncate with metadata |
| Run is cancelled | Final snapshot records cancellation status if possible |
| Daemon restarts | Existing snapshots remain artifacts; active process state is not reconstructed from them |
| Snapshot endpoint sees missing artifact | Return readable 404 with run/action context |

## Feature Gates

P2 should use runtime feature flags, not Plugin Manager state:

```ts
interface RuntimeToolFeatureFlags {
  readonly requestPermissions?: boolean;
  readonly shellSnapshot?: boolean;
}
```

Recommended defaults:

- `requestPermissions`: off until runner conformance tests pass;
- `shellSnapshot`: off until unified exec exists and snapshot redaction tests pass.

Feature gate state should appear in runtime diagnostics and request snapshots.

## Implementation Slices

### P2.1 Core Types

- Add permission request payload and grant types.
- Add shell snapshot types.
- Add feature flag fields to runtime settings or runtime diagnostics.
- Keep all new fields additive.

### P2.2 Daemon Permission Request Bridge

Detailed implementation plan:
[Codex-Inspired Runtime Tools P2A: Permission Requests Implementation](codex-inspired-runtime-tools-p2a-permission-requests-implementation.md).

- Add `createRunPermissionRequestHandler`.
- Reuse approval store and approval events.
- Add read-only `/permission-requests` views.
- Add run-scoped grant materialization.
- Add continuation planning through existing run intervention mechanisms.

### P2.3 Runner-Pi Permission Contract

- Add optional `onPermissionRequired`.
- Surface unsupported dynamic grants clearly.
- Do not dynamically mutate active Pi tool registry unless Pi exposes a safe API.
- Prefer queued follow-up or interrupt redirect for expanded tool sets.

### P2.4 Web And CLI Permission Surfaces

- Render permission request approval cards.
- Include current scope, requested scope, and continuation plan.
- Extend CLI approval summaries for `runtime_permission_request`.

### P2.5 Shell Snapshot Artifacts

- Implement only after unified exec has a normalized execution result and output model.
- Create bounded JSON/text artifacts.
- Add read-only run snapshot endpoints.
- Add Web/CLI rendering.

### P2.6 Tests And Docs Alignment

- Add tests for durable permission approvals, denial, expiration, and continuation.
- Add tests that workspace `deny` cannot be overridden by a permission request.
- Add tests that no raw secrets appear in permission payloads or shell snapshots.
- Add tests that shell snapshots are artifacts and do not drive run recovery.
- Add regression tests that core tools remain outside Plugin Manager.

## Acceptance Criteria

P2A is complete when:

- a runner can create a durable permission request approval;
- Web and CLI can inspect and resolve that approval through existing approval endpoints;
- denied and expired requests are delivered back to the runner as normal denials;
- workspace `deny` and write-scope boundaries cannot be bypassed;
- approved expanded scopes are run-scoped or continuation-scoped, not workspace policy;
- no active-run prompt injection is used to deliver the decision;
- no raw secret values appear in request payloads, events, or artifacts.

P2B is complete when:

- shell snapshot artifacts are created for approved `bash` executions;
- snapshots are bounded, redacted, and linked to run/tool-call evidence;
- Web and CLI can inspect snapshots without opening live shells;
- doctor can report snapshot status read-only;
- snapshots are not used as durable state authority or recovery source;
- daemon restart does not treat snapshots as process state.

## Open Questions

- Should approved permission grants expire at run completion, thread completion, or a
  fixed short TTL?
- Should "make this permanent" be a later settings action linked from an approved
  request?
- Should permission requests support multiple requested scopes, or force one approval
  per scope for clearer audit?
- Should shell snapshots store both JSON and text artifacts, or render text from JSON on
  demand?
- Should manual snapshot capture be exposed in Web first, CLI first, or deferred until
  users hit real debugging pressure?
