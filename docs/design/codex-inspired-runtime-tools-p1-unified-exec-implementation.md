# Codex-Inspired Runtime Tools P1: Unified Exec For Bash Implementation

## Status

Implementation plan. No P1 code is shipped yet.

This document narrows P1 from
[Codex-Inspired Runtime Tools](codex-inspired-runtime-tools.md): introduce a
Ling-owned normalized execution backend for the `bash` core tool while preserving
Ling's product-facing core-tool, approval, runner, daemon, Web, CLI, and artifact
contracts.

P1 is a prerequisite for P2B shell snapshots. P1 does not implement shell snapshots.

## Goal

Make shell execution auditable, cancellable, bounded, and artifact-backed:

```text
runner proposes bash command
-> daemon classifies risk and evaluates approval policy
-> daemon creates or resolves approval before process start
-> daemon starts the process through a normalized exec backend only after approval
-> daemon streams bounded progress and records redacted artifacts
-> daemon returns a handled tool result to the runner
-> runner reports normal tool_end semantics without running the original bash tool
```

The important ownership change is that Ling daemon starts and stops the process. The
embedded Pi runner remains the model session owner, but `bash` execution moves under
Ling's approval, artifact, timeout, cancellation, and redaction path.

## Related Docs

- [Codex-Inspired Runtime Tools](codex-inspired-runtime-tools.md)
- [Codex-Inspired Runtime Tools P0: Apply-Patch Implementation](codex-inspired-runtime-tools-p0-apply-patch-implementation.md)
- [Codex-Inspired Runtime Tools P2: Permission Requests And Shell Snapshots](codex-inspired-runtime-tools-p2-permissions-shell-snapshots.md)
- [Codex-Inspired Runtime Tools P2A: Permission Requests Implementation](codex-inspired-runtime-tools-p2a-permission-requests-implementation.md)
- [Core Tools, Runners, MCP Tools, and Plugin Boundary](core-tools-runtime-boundary.md)
- [Approval Policy](approval-policy.md)
- [CLI Run I/O and Completion P1](cli-run-io-completion-p1.md)
- [Runner Registry](runner-registry.md)
- [Runner Adapters](runner-adapters.md)
- [Runtime Supervisor](runtime-supervisor.md)

## Non-Goals

- No P2B shell snapshot implementation.
- No Codex app-server, JSON-RPC, or config-model migration.
- No switch from embedded `@earendil-works/pi-coding-agent` to Pi CLI as the default
  runner.
- No conversion of `read`, `grep`, `find`, or `ls` into shell-only behavior.
- No new Plugin Manager cards for core tools or runtime feature gates.
- No process start before policy allow or user approval.
- No hidden mid-run prompt injection into the active model session.
- No raw secret values in events, logs, summaries, or artifacts.
- No terminal replay or durable shell state authority.

## Current Code Anchors

| Area | Current Anchor | P1 Use |
| --- | --- | --- |
| Core tool list | `packages/runner-pi/src/index.ts` | Keep `bash` as one of the seven built-in core tools |
| Runner approval hook | `createLingStackApprovalExtension` in `packages/runner-pi/src/index.ts` | Existing hook blocks or allows `bash`, but Pi still owns actual execution |
| Runner handled result path | `createLingStackFileMutationToolExtension` in `packages/runner-pi/src/index.ts` | Reuse the `edit`/`write` override pattern for a `bash` override |
| Daemon approval bridge | `packages/daemon/src/features/runs/approvals.ts` | Extend `createRunApprovalHandler` to execute approved `bash` requests through unified exec |
| Bash approval payload | `ApprovalPayload` in `packages/core/src/approval-types.ts` | Keep existing `type: "bash"` payload and add optional execution metadata |
| Risk classification | `classifyBashRiskFlags` in `packages/daemon/src/features/runs/action-classifier.ts` | Reuse for approval risk and command preview |
| Preview/result artifacts | `packages/daemon/src/features/runs/action-artifacts.ts` | Reuse preview artifacts and add exec-specific result/output artifacts |
| Run orchestration | `packages/daemon/src/features/runs/orchestrator.ts` | Use the run `AbortSignal`, event stream, artifact events, and resolved secret values |
| CLI run output | `packages/cli/src/run/output.ts` | Preserve JSONL stdout contract and keep progress on stderr |
| Web run history | `apps/web/src/features/runs/RunHistory.tsx` | Render command, output preview, and artifact links from normal run events |

## Design Decisions

### 1. `bash` Remains A Core Tool

P1 changes the implementation of `bash`, not the product contract.

The core tool set remains:

```ts
type RunTool = "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write";
```

Approval policy, channel tool allowlists, teammate tool allowlists, skill required tools,
runner supported-tool metadata, and run request snapshots keep using `bash`. Unified exec
is the daemon implementation behind that tool.

### 2. Daemon Owns Process Start

The daemon must be the only component that starts a P1 `bash` process. That gives Ling a
single place to enforce:

- approval before side effects;
- process-tree cancellation;
- timeout and idle-timeout handling;
- stdout/stderr bounding;
- secret redaction;
- artifact creation;
- control-plane and run event audit.

If the daemon cannot handle a `bash` request while the P1 feature gate is enabled, the
request fails closed. It must not fall back to Pi's original shell executor after
approval.

### 3. Runner-Pi Uses A `bash` Override

P0 already uses a tool override for `edit` and `write`. P1 should add the same shape for
`bash`:

```text
createLingStackBashToolExtension(options)
-> register bash tool
-> call options.onApprovalRequired(...)
-> require decision.handledResult for approved commands while unifiedExec is enabled
-> return normalizeHandledToolResult(decision.handledResult)
```

The existing approval-only listener can remain for non-overridden tools. Once the `bash`
override is active, it must not let Pi run the original `bash` implementation.

### 4. Policy Allow Is Still A Gate

Approval gating means a command cannot start until Ling has made a policy decision. If
policy says `allow`, the daemon may execute immediately without a pending user approval.
If policy says `ask`, the daemon creates a durable approval and waits. If policy says
`deny`, the daemon records the denial path and does not start a process.

### 5. Exec Artifacts Do Not Require An Approval Id

Some allowed commands will not have a user approval record. P1 should write exec artifacts
under a tool-call path that works with or without approval:

```text
.ling-stack/artifacts/<runId>/unified-exec/<toolCallId>/result.json
.ling-stack/artifacts/<runId>/unified-exec/<toolCallId>/stdout.txt
.ling-stack/artifacts/<runId>/unified-exec/<toolCallId>/stderr.txt
```

When a user approval exists, result metadata should include `approvalId`, and the approval
view may link to the same result artifact ids. Preview artifacts can continue using the
existing approval action path.

### 6. P1 Uses Existing Run Event Types

Do not add new run event types for the first slice. Use:

- `tool_update` for bounded execution progress;
- `artifact_created` for exec result/output artifacts;
- normal `tool_end` from the runner once the handled result returns.

The `tool_update.partialResult` payload should be shaped as `UnifiedExecOutputChunk` or a
small progress summary. JSON CLI mode already prints event envelopes to stdout; human
mode should only print verbose progress to stderr.

## Contract Shape

P1 should add shared types in contracts and re-export any pure types needed by core or
daemon. A practical first placement is:

```text
packages/contracts/src/unified-exec.ts
packages/contracts/src/index.ts
packages/core/src/exec/unified-exec-types.ts
```

If duplication becomes annoying, keep the canonical definitions in `@ling-stack/core`
and type-export them through `@ling-stack/contracts`, matching nearby approval/runtime
patterns.

### Request

```ts
type UnifiedExecCommand =
  | {
      readonly kind: "shell";
      readonly command: string;
      readonly shell?: string;
    }
  | {
      readonly kind: "argv";
      readonly argv: readonly string[];
    };

interface UnifiedExecRequest {
  readonly runId: string;
  readonly taskId: string;
  readonly toolCallId: string;
  readonly approvalId?: string;
  readonly cwd: string;
  readonly command: UnifiedExecCommand;
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly pty?: boolean;
  readonly maxInlineBytes?: number;
  readonly environment?: UnifiedExecEnvironmentPolicy;
  readonly startedBy: "run_tool";
}
```

P1 may accept Pi's current `bash` payload as shell command input first:

```ts
{ command: string }
```

`argv` support can be added in the same data model even if no model-facing tool schema
uses it yet. It prevents the daemon API from baking in shell string execution forever.

### Environment Summary

```ts
type UnifiedExecEnvironmentMode = "inherit_minimal" | "inherit_run" | "explicit";

interface UnifiedExecEnvironmentPolicy {
  readonly mode: UnifiedExecEnvironmentMode;
  readonly extraEnv?: Record<string, string | undefined>;
}

interface UnifiedExecEnvironmentSummary {
  readonly mode: UnifiedExecEnvironmentMode;
  readonly cwd: string;
  readonly keys: readonly string[];
  readonly redactedKeys: readonly string[];
  readonly pathEntryCount?: number;
}
```

Events and artifacts store only the summary. They must not store raw environment values.
The implementation can still build the real process environment internally.

### Output Chunk

```ts
interface UnifiedExecOutputChunk {
  readonly toolCallId: string;
  readonly stream: "stdout" | "stderr";
  readonly sequence: number;
  readonly text: string;
  readonly byteCount: number;
  readonly redacted: boolean;
  readonly truncated: boolean;
  readonly ts: string;
}
```

Chunks are for live progress only. They must be bounded and redacted before entering the
run event stream.

### Artifact Summary

```ts
interface UnifiedExecArtifactSummary {
  readonly artifactId: string;
  readonly role: "result" | "stdout" | "stderr" | "combined";
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly redacted: boolean;
  readonly truncated: boolean;
}
```

P1 result JSON is always written. Stdout and stderr text artifacts should be written when
the stream is non-empty or exceeds inline limits. The stored artifact content is redacted
content, never raw process output.

### Result

```ts
type UnifiedExecStatus = "succeeded" | "failed" | "timed_out" | "cancelled";

interface UnifiedExecResult {
  readonly status: UnifiedExecStatus;
  readonly runId: string;
  readonly taskId: string;
  readonly toolCallId: string;
  readonly approvalId?: string;
  readonly cwd: string;
  readonly command: UnifiedExecCommand;
  readonly environmentSummary: UnifiedExecEnvironmentSummary;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdout: UnifiedExecStreamSummary;
  readonly stderr: UnifiedExecStreamSummary;
  readonly artifacts: readonly UnifiedExecArtifactSummary[];
}

interface UnifiedExecStreamSummary {
  readonly byteCount: number;
  readonly lineCount?: number;
  readonly preview: string;
  readonly truncated: boolean;
  readonly artifactId?: string;
}
```

The handled tool result returned to Pi should include a compact text summary and the
structured result in `details`:

```ts
{
  content: [{ type: "text", text: "Command exited 0 in 1234ms." }],
  details: { unifiedExec: result },
  isError: result.status !== "succeeded"
}
```

## Approval Payload Extension

Keep the existing `ApprovalPayload` bash variant compatible:

```ts
{
  readonly type: "bash";
  readonly cwd: string;
  readonly command: string;
  readonly riskFlags: readonly string[];
}
```

P1 can add optional fields without breaking existing clients:

```ts
{
  readonly type: "bash";
  readonly cwd: string;
  readonly command: string;
  readonly riskFlags: readonly string[];
  readonly exec?: {
    readonly commandKind: "shell" | "argv";
    readonly timeoutMs?: number;
    readonly idleTimeoutMs?: number;
    readonly pty?: boolean;
    readonly environmentSummary?: UnifiedExecEnvironmentSummary;
  };
}
```

Approval cards should keep showing the familiar command/cwd/risk information. The
optional exec metadata is for diagnostics and future richer UI.

## Daemon Flow

### Policy Deny

```text
receive bash request
-> normalize command/cwd
-> create approval payload and risk classification
-> evaluate approval policy
-> create denied approval evidence if current path already does so
-> emit approval_requested + approval_denied
-> return handled error result
-> do not spawn
```

The user-visible result should be a normal denied tool result. No process artifacts are
created because no process started.

### Policy Ask

```text
receive bash request
-> create approval request and preview artifact
-> transition run to waiting_for_approval
-> wait for approval decision with orchestrator AbortSignal
-> if approved, transition back to running and execute
-> if denied/expired/cancelled, return handled error result
```

Approved execution starts after the approval decision event has been recorded.

### Policy Allow

```text
receive bash request
-> evaluate policy as allow
-> create exec record metadata
-> execute immediately through unified exec
-> emit artifact_created events
-> return handled result
```

No user approval is needed, but the exec result artifacts and tool events still provide
evidence.

### Exec Runner

Recommended daemon module:

```text
packages/daemon/src/features/runs/unified-exec.ts
```

Recommended responsibilities:

- normalize Pi `bash` params into `UnifiedExecRequest`;
- resolve `cwd` under the workspace root rules already used by runs;
- build a minimal process environment and redacted environment summary;
- spawn the process;
- stream bounded, redacted `stdout` and `stderr` chunks;
- maintain head/tail previews without unbounded memory;
- write redacted result and output artifacts;
- kill the process tree on cancellation or timeout;
- return a `PiRunnerToolHandledResult`.

Do not put process execution in Web or runner-pi. Runner-pi should only route the request
to daemon-owned callbacks.

## Cancellation And Timeouts

There are three separate stop paths:

| Stop Path | Meaning | Result |
| --- | --- | --- |
| Run cancellation | User or orchestrator cancels the run | Kill process tree, throw/propagate `AbortError`, run becomes `cancelled` |
| Hard run timeout | Existing orchestrator hard timeout fires | Same as run cancellation |
| Command timeout | Per-command timeout fires | Kill process tree, return handled result with `status: "timed_out"` and `isError: true` |

Process-tree termination should be explicit. On Unix-like platforms, spawn with a process
group where possible and terminate the group. If process-group kill fails, fall back to
the direct child kill and record the failure in result metadata. Tests should cover at
least the normal process-group kill path.

## Output, Redaction, And Artifacts

P1 must never write raw secrets to events, logs, summaries, or artifacts.

Rules:

- redact output before it enters `tool_update`;
- redact output before writing artifacts;
- keep event previews bounded;
- keep in-memory buffers bounded with head/tail previews;
- count raw bytes for diagnostics, but do not store raw bytes;
- record whether redaction happened and whether output was truncated;
- include artifact ids in the handled result details.

Recommended first limits:

| Limit | Default |
| --- | --- |
| Inline preview per stream | 8 KiB |
| Tool update chunk text | 4 KiB |
| Max artifact size per stream before truncation | 2 MiB |
| Default command timeout | 10 minutes |
| Approval timeout | Existing approval timeout |

The exact values can be config-backed later. P1 should start with constants and tests.

## Runner-Pi Integration

Add feature-gated runtime support:

```ts
export interface PiRunnerRuntimeToolFeatures {
  readonly requestPermissions?: boolean;
  readonly unifiedExec?: boolean;
}
```

When `unifiedExec` is enabled:

- register `createLingStackBashToolExtension(options)` before or instead of the
  approval-only listener for `bash`;
- require `options.onApprovalRequired`;
- call `onApprovalRequired` with `toolName: "bash"`;
- require an approved decision to include `handledResult`;
- return `normalizeHandledToolResult(decision.handledResult)`;
- fail closed if approval is approved but no handled result is returned.

When `unifiedExec` is disabled, preserve today's behavior: approval hook gates the call,
then Pi executes the original `bash` tool.

## Web And CLI Implications

### Web

P1 does not require a new settings surface.

Expected Web behavior:

- approval cards keep rendering command, cwd, risk, and preview artifacts;
- run history shows `bash` `tool_update` previews in existing event rows;
- artifact links expose `exec-result.json`, `stdout.txt`, and `stderr.txt`;
- no Plugin Manager entry appears for unified exec.

### CLI

P1 must preserve the CLI run I/O contract:

- `--json` stdout remains JSONL event envelopes only;
- human progress and approval summaries go to stderr;
- long shell output is not dumped to stdout by the CLI printer;
- artifact ids and compact summaries appear in event payloads.

The CLI may add later convenience commands to inspect exec artifacts, but P1 does not
need a new command.

## Implementation Slices

### P1.1 Types And Feature Gate

Files:

- `packages/contracts/src/unified-exec.ts`
- `packages/contracts/src/index.ts`
- `packages/core/src/exec/unified-exec-types.ts`
- `packages/core/src/index.ts`
- `packages/runner-pi/src/index.ts`

Tasks:

- Add unified exec request/result/output/artifact types.
- Add optional `ApprovalPayload.type === "bash"` exec metadata.
- Add `runtimeToolFeatures.unifiedExec`.
- Keep all changes additive.

Acceptance:

- Existing approval payloads still typecheck.
- Existing P0/P2A tests still pass with the feature gate off.

### P1.2 Daemon Exec Backend

Files:

- `packages/daemon/src/features/runs/unified-exec.ts`
- `packages/daemon/src/features/runs/action-artifacts.ts`
- `packages/daemon/src/features/runs/approvals.ts`

Tasks:

- Implement command normalization.
- Implement process spawning with cwd/env summary.
- Implement bounded stdout/stderr capture.
- Implement redacted result/output artifacts.
- Implement timeout and process-tree cancellation.
- Return a `PiRunnerToolHandledResult`.

Acceptance:

- Approved `bash` commands are executed by daemon.
- Denied commands never spawn.
- Nonzero commands return `isError: true` with result artifacts.

### P1.3 Runner-Pi Bash Override

Files:

- `packages/runner-pi/src/index.ts`

Tasks:

- Add `createLingStackBashToolExtension`.
- Register it when `runtimeToolFeatures.unifiedExec` is enabled.
- Ensure the original Pi `bash` executor is not called in unified-exec mode.
- Preserve current behavior when the gate is off.

Acceptance:

- Feature gate off: existing behavior stays unchanged.
- Feature gate on: approved commands require daemon handled results.

### P1.4 Orchestrator Wiring

Files:

- `packages/daemon/src/features/runs/orchestrator.ts`
- `packages/daemon/src/features/runs/approvals.ts`
- `packages/daemon/src/config.ts`

Tasks:

- Enable `runtimeToolFeatures.unifiedExec` behind a daemon/runtime feature flag.
- Pass the orchestrator `AbortSignal` into unified exec.
- Stream `tool_update` progress through existing run events.
- Append `artifact_created` events for result/output artifacts.

Acceptance:

- Cancelling a run kills an active daemon-owned shell process.
- Timeout and cancellation produce distinct result semantics.

### P1.5 Web And CLI Summaries

Files:

- `packages/cli/src/run/output.ts`
- `apps/web/src/features/approvals/ApprovalCard.tsx`
- `apps/web/src/features/runs/RunHistory.tsx`

Tasks:

- Render compact unified exec summaries when present.
- Link result/output artifacts from existing artifact surfaces.
- Keep JSON CLI stdout clean.

Acceptance:

- Human CLI output stays readable.
- JSON CLI output remains machine-readable JSONL.
- Web shows the command result without raw unbounded output.

## Test Plan

### Core And Contracts

- Bash approval payload remains backward compatible.
- Unified exec result types serialize without optional-field ambiguity.
- Redaction helper removes configured secret values from result summaries.

### Daemon Unit Tests

- Policy denial does not spawn a process.
- Policy allow runs a command and records result artifacts.
- Policy ask waits for approval and then runs.
- Approval denial after ask does not spawn a process.
- Nonzero exit returns `status: "failed"` and `isError: true`.
- Command timeout kills the process tree and returns `status: "timed_out"`.
- Run cancellation kills the process tree and the run becomes `cancelled`.
- Long stdout/stderr is bounded in events and artifact-backed.
- Secret values are redacted from events and artifacts.
- Empty stdout/stderr still produces a complete result JSON artifact.

### Runner-Pi Tests

- Feature gate off keeps current approval-only `bash` behavior.
- Feature gate on calls the daemon approval/exec handler.
- Feature gate on fails closed if approval is approved without `handledResult`.
- Feature gate on never calls Pi's original `bash` executor.

### CLI Tests

- `--json` prints event envelopes only to stdout while shell progress goes through events.
- Human mode prints compact tool summaries to stderr.
- Nonzero shell command sets the expected run/output failure state.

### Web Tests

- Approval card renders bash command/cwd/risk.
- Run history renders compact exec result details.
- Artifact links are shown for long output.
- No Plugin Manager entry appears for `bash` or unified exec.

### Regression Tests

- `read`, `grep`, `find`, and `ls` remain separate core tools.
- P0 patch-shaped `edit`/`write` still use daemon handled results.
- P2A `request_permission` remains gated and does not mutate active prompt/tool registry.

## Acceptance Criteria

P1 is complete when:

- every approved `bash` command is executed by daemon-owned unified exec;
- no `bash` process starts before policy allow or user approval;
- every command records cwd, command form, environment summary, start/end time, duration,
  status, exit code or signal, stdout/stderr summaries, and result artifacts;
- cancellation and hard run timeout terminate the active process tree;
- command timeout is reported as a tool failure, not confused with user run cancellation;
- long stdout/stderr is bounded in events and stored as redacted artifacts;
- secrets are redacted in events, logs, summaries, and artifacts;
- CLI JSON stdout remains JSONL-only;
- Web and CLI can inspect compact results and artifact links;
- P2B shell snapshots remain deferred until this backend is shipped.

## Open Questions

- Should P1 create auto-approved approval records for policy-allowed `bash` commands, or
  keep approvals only for ask/deny paths and rely on exec artifacts for allow-path
  evidence?
- Should PTY support land in P1.1, or should P1 first support non-PTY command execution
  and reserve PTY for a follow-up before P2B?
- Should command timeout be configurable per workspace, per run request, or only via
  daemon config in the first slice?
- Should stdout/stderr artifacts always be written for non-empty streams, or only when
  output exceeds inline limits?
