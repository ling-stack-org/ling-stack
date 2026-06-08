# Codex-Inspired Runtime Tools P2B: Shell Snapshots Implementation

## Status

P2B.1 is implemented for automatic unified exec lifecycle snapshots:

- shared core/contract shell snapshot types;
- daemon `exec_start` and `exec_end` JSON/text snapshot artifacts for approved unified
  exec `bash` calls when `runtimeTools.shellSnapshot` is enabled;
- read-only daemon list/detail APIs backed by snapshot artifacts;
- api-client methods;
- CLI `runs shell-snapshots` and `runs shell-snapshot` inspection commands;
- Web run-history read-only snapshot rendering;
- `ling-stack doctor` read-only shell snapshot diagnostics;
- focused daemon and CLI tests.

P2B can now be designed against the shipped P1 unified exec backend. The current
implementation already has daemon-owned `bash` execution, redacted output chunks,
bounded stdout/stderr artifacts, result artifacts, process-tree cancellation, and
runner-pi handled results. P2B should build on that backend instead of attaching to live
shells or scraping raw logs.

This document narrows the shell snapshot track from
[Codex-Inspired Runtime Tools P2: Permission Requests And Shell Snapshots](codex-inspired-runtime-tools-p2-permissions-shell-snapshots.md).

## Goal

Create bounded, redacted diagnostic snapshots for approved `bash` executions:

```text
unified exec accepts approved bash command
-> shell snapshot writer records lifecycle/output state
-> snapshots are stored as JSON/text artifacts
-> run events link snapshot artifacts to the same tool call
-> daemon exposes read-only snapshot list/detail views
-> CLI, Web, and doctor inspect snapshots without opening a shell
```

Snapshots are evidence. They are not terminal replay, process recovery state, or a
second execution log.

## Related Docs

- [Codex-Inspired Runtime Tools](codex-inspired-runtime-tools.md)
- [Codex-Inspired Runtime Tools P1: Unified Exec For Bash Implementation](codex-inspired-runtime-tools-p1-unified-exec-implementation.md)
- [Codex-Inspired Runtime Tools P2: Permission Requests And Shell Snapshots](codex-inspired-runtime-tools-p2-permissions-shell-snapshots.md)
- [Codex-Inspired Runtime Tools P2A: Permission Requests Implementation](codex-inspired-runtime-tools-p2a-permission-requests-implementation.md)
- [Codex-Inspired Runtime Tools P2B: Shell Snapshots Follow-Ups](codex-inspired-runtime-tools-p2b-shell-snapshots-follow-ups.md)
- [Core Tools, Runners, MCP Tools, and Plugin Boundary](core-tools-runtime-boundary.md)
- [Approval Policy](approval-policy.md)
- [CLI Run I/O and Completion P1](cli-run-io-completion-p1.md)
- [Runtime Supervisor](runtime-supervisor.md)

## Non-Goals

- No terminal replay.
- No live shell attach.
- No PTY implementation in the first P2B slice.
- No manual capture endpoint in the first P2B slice.
- No durable database table for snapshots in P2B.1.
- No use of snapshots as run recovery or resume source of truth.
- No shell-only replacement for `read`, `grep`, `find`, or `ls`.
- No Plugin Manager cards for shell snapshots or core tools.
- No raw secrets in snapshot JSON, text summaries, run events, logs, or API responses.
- No mutation endpoint in the first slice. Manual capture can wait until real debugging
  pressure proves it is needed.

## Deferred vs Permanent Non-Goals

Some first-slice exclusions are deferred follow-ups. Others should stay out of the shell
snapshot design permanently.

| Item | P2B.1 Decision | Later Direction |
| --- | --- | --- |
| PTY snapshots | Deferred | Optional follow-up after unified exec supports PTY. It must handle ANSI parsing, window size, resize, visible text, interaction boundaries, and redaction. |
| Manual capture | Deferred | Optional follow-up after automatic snapshots prove useful. It should be an explicit diagnostic action and must not mutate process state. |
| Durable snapshot table | Deferred | Optional index/cache only if artifact-backed lookup becomes too slow or needs retention/query semantics. It must not replace snapshot artifacts as evidence. |
| Run recovery source | Permanent non-goal | Do not use shell snapshots for run recovery, resume, or process reconstruction. Recovery belongs to run/work-unit state, events, runner contracts, and Runtime Supervisor. |

The practical P2B.1 target is narrow: automatic, bounded, redacted, artifact-backed
snapshots with read-only daemon/API and CLI inspection. Web and doctor inspection have
now landed as P2B-F1/F2 read-only follow-ups. The remaining post-P2B backlog is split in
[Codex-Inspired Runtime Tools P2B: Shell Snapshots Follow-Ups](codex-inspired-runtime-tools-p2b-shell-snapshots-follow-ups.md).

## Current Code Anchors

| Area | Current Anchor | P2B Use |
| --- | --- | --- |
| Unified exec types | `packages/core/src/exec/unified-exec-types.ts`, `packages/contracts/src/unified-exec.ts` | Source for command, environment, stream, artifact, and result shapes |
| Unified exec backend | `packages/daemon/src/features/runs/unified-exec.ts` | Add snapshot writer capture points beside output/result artifact writing |
| Artifact store | `RunStore.createArtifact`, `RunStore.listArtifacts`, `/runs/:runId/artifacts` | Store snapshots as artifacts, not a new table |
| Artifact content APIs | `/artifacts/:artifactId/content`, `/artifacts/:artifactId/preview` | Reuse for snapshot JSON/text content |
| Run events | `tool_update`, `artifact_created`, `tool_end` | Link snapshot artifacts to run/tool-call evidence |
| Runner-pi bash override | `packages/runner-pi/src/extensions/bash.ts` | No direct P2B change; runner still receives handled unified exec results |
| CLI run output | `packages/cli/src/run/output.ts`, `packages/cli/src/main.ts` | Add read-only snapshot commands and summaries |
| Web run history | `apps/web/src/features/runs/RunHistory.tsx` | Show snapshot links/details near `bash` tool events |

## Design Decisions

### 1. Snapshots Derive From Unified Exec

P2B must not observe arbitrary shell processes. It only captures commands executed by the
P1 unified exec backend for the `bash` core tool.

Allowed sources:

- `UnifiedExecRequest`;
- current process metadata owned by `executeUnifiedExec`;
- bounded redacted stream capture state;
- `UnifiedExecResult`;
- result/stdout/stderr artifact summaries.

Disallowed sources:

- raw daemon logs;
- Pi-owned shell internals;
- operating-system process inspection outside the child process started by unified exec;
- persisted snapshot content as recovery state.

### 2. Snapshots Are Artifact-Backed

P2B should store snapshot JSON and optional text summaries as run artifacts:

```text
.ling-stack/artifacts/<runId>/shell-snapshots/<toolCallId>/<sequence>.json
.ling-stack/artifacts/<runId>/shell-snapshots/<toolCallId>/<sequence>.txt
```

The JSON artifact is the source of truth for snapshot content. The text artifact is a
bounded human summary for CLI/Web display. Artifact metadata remains in the existing
store.

Do not add a snapshot table in P2B.1. A table is justified only if later usage needs
indexing beyond `runId`, `toolCallId`, and artifact path prefixes.

### 3. Use Stable Snapshot Ids

Use a deterministic id inside the snapshot payload:

```text
shell_snapshot:<runId>:<toolCallId>:<zero-padded-sequence>
```

The artifact id may remain store-generated. API callers should use `snapshot.id` for
snapshot detail routes and artifact ids for content routes.

### 4. Start With Non-PTY Snapshots

P1 currently rejects PTY requests as handled failures. P2B should still keep optional
terminal fields in the contract, but the first implementation should set:

```ts
terminal: undefined
command.pty: false
```

PTY visible text can land later after unified exec supports PTY. P2B should not block on
that.

### 5. Capture State Changes, Not Every Chunk

Snapshots should be sparse. `tool_update` already carries output chunks. P2B adds compact
state views:

- accepted/start snapshot;
- first-output snapshot;
- periodic active snapshot for long-running commands;
- timeout snapshot;
- cancellation snapshot;
- final exit snapshot.

Do not create a snapshot for every output chunk.

## Contract Shape

Add shared types in core/contracts:

```text
packages/core/src/exec/shell-snapshot-types.ts
packages/contracts/src/shell-snapshots.ts
```

Export them through `packages/core/src/index.ts` and `packages/contracts/src/index.ts`.

### Snapshot

```ts
type ShellSnapshotSource =
  | "exec_start"
  | "exec_first_output"
  | "exec_periodic"
  | "exec_timeout"
  | "exec_cancel"
  | "exec_end";

type ShellSnapshotStatus =
  | "starting"
  | "running"
  | "exited"
  | "cancelled"
  | "timed_out"
  | "failed";

interface ShellSnapshot {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly toolCallId: string;
  readonly approvalId?: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly source: ShellSnapshotSource;
  readonly status: ShellSnapshotStatus;
  readonly command: ShellCommandSnapshot;
  readonly process?: ShellProcessSnapshot;
  readonly terminal?: ShellTerminalSnapshot;
  readonly output: ShellOutputSnapshot;
  readonly artifacts: readonly ShellSnapshotArtifactSummary[];
  readonly redaction: ShellSnapshotRedactionSummary;
}
```

### Command

```ts
interface ShellCommandSnapshot {
  readonly cwd: string;
  readonly commandKind: "shell" | "argv";
  readonly commandPreview: string;
  readonly argvPreview?: readonly string[];
  readonly shell?: string;
  readonly pty: boolean;
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly environmentSummary: UnifiedExecEnvironmentSummary;
}
```

Use redacted command previews. Do not store raw command text if it contains secrets.

### Process

```ts
interface ShellProcessSnapshot {
  readonly pid?: number;
  readonly processGroupId?: number;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly signal?: string;
}
```

`pid` and `processGroupId` are diagnostic only. They must not be used to reattach after a
daemon restart.

### Terminal

```ts
interface ShellTerminalSnapshot {
  readonly rows?: number;
  readonly cols?: number;
  readonly visibleText?: string;
  readonly cursorRow?: number;
  readonly cursorCol?: number;
}
```

P2B.1 does not populate this for non-PTY commands.

### Output

```ts
interface ShellOutputSnapshot {
  readonly stdoutHead?: string;
  readonly stdoutTail?: string;
  readonly stderrHead?: string;
  readonly stderrTail?: string;
  readonly stdoutByteCount: number;
  readonly stderrByteCount: number;
  readonly stdoutLineCount?: number;
  readonly stderrLineCount?: number;
  readonly stdoutArtifactId?: string;
  readonly stderrArtifactId?: string;
  readonly truncated: boolean;
}
```

P1 has stream previews and output artifacts. P2B should extend the daemon's internal
stream capture with tail buffers so active snapshots can show recent output without
reading final artifacts before they exist.

### Artifact Summary

```ts
interface ShellSnapshotArtifactSummary {
  readonly artifactId: string;
  readonly role: "snapshot_json" | "snapshot_text" | "stdout" | "stderr" | "exec_result";
  readonly contentType: string;
  readonly sizeBytes: number;
}
```

Snapshot artifacts can reference unified-exec stdout/stderr/result artifacts when those
already exist. Active snapshots usually reference only their own JSON/text artifacts.

### Redaction Summary

```ts
interface ShellSnapshotRedactionSummary {
  readonly redacted: boolean;
  readonly extraSecretCount: number;
  readonly commandRedacted: boolean;
  readonly stdoutRedacted: boolean;
  readonly stderrRedacted: boolean;
  readonly environmentValuesStored: false;
}
```

The current redaction helpers do not expose a reliable match count. Do not invent one in
the first implementation.

### API Responses

```ts
interface ShellSnapshotListResponse {
  readonly runId: string;
  readonly snapshots: readonly ShellSnapshotListItem[];
}

interface ShellSnapshotListItem {
  readonly id: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly source: ShellSnapshotSource;
  readonly status: ShellSnapshotStatus;
  readonly commandPreview: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly artifactId: string;
  readonly textArtifactId?: string;
}

interface ShellSnapshotResponse {
  readonly snapshot: ShellSnapshot;
  readonly artifactId: string;
  readonly textArtifactId?: string;
}
```

## Artifact Format

### JSON Artifact

Path:

```text
<runId>/shell-snapshots/<toolCallId>/<sequence>.json
```

Content:

```json
{
  "id": "shell_snapshot:run_123:tool_abc:000003",
  "runId": "run_123",
  "toolCallId": "tool_abc",
  "sequence": 3,
  "source": "exec_periodic",
  "status": "running",
  "command": {
    "cwd": "/workspace",
    "commandKind": "shell",
    "commandPreview": "pnpm test",
    "shell": "bash",
    "pty": false,
    "environmentSummary": {
      "mode": "inherit_minimal",
      "cwd": "/workspace",
      "keys": ["HOME", "LANG", "LING_STACK_RUN_TOOL", "PATH", "SHELL", "TERM", "TMPDIR"],
      "redactedKeys": [],
      "pathEntryCount": 12
    }
  },
  "output": {
    "stdoutTail": "last bounded stdout text",
    "stderrTail": "",
    "stdoutByteCount": 1234,
    "stderrByteCount": 0,
    "truncated": false
  },
  "redaction": {
    "redacted": false,
    "extraSecretCount": 0,
    "commandRedacted": false,
    "stdoutRedacted": false,
    "stderrRedacted": false,
    "environmentValuesStored": false
  }
}
```

### Text Artifact

Path:

```text
<runId>/shell-snapshots/<toolCallId>/<sequence>.txt
```

Content should be a compact report:

```text
Shell Snapshot shell_snapshot:run_123:tool_abc:000003
Status: running
Source: exec_periodic
CWD: /workspace
Command: pnpm test
Duration: 12400ms

stdout tail:
...

stderr tail:
...
```

The text artifact is generated from the redacted JSON snapshot, not from raw output.

## Capture Points

### `exec_start`

Write after approval/policy allow and after request normalization. If spawn fails, this
snapshot may be followed immediately by `exec_end` with `status: failed`.

Fields available:

- command preview;
- cwd;
- approval id if any;
- timeout/idle timeout;
- environment summary.

### `exec_first_output`

Write after the first stdout or stderr data is ingested. This tells users the command is
alive without waiting for process exit.

### `exec_periodic`

Write at most once every 5 seconds while the process is active. Skip periodic snapshots
if no output, duration, or process state changed since the previous snapshot.

### `exec_timeout`

Write when command timeout or idle timeout triggers process termination.

### `exec_cancel`

Write when the run abort signal asks unified exec to terminate the process.

### `exec_end`

Write after stdout/stderr flush and before returning the handled result. Include
`exitCode`, `signal`, `durationMs`, and references to final unified-exec result/stdout/stderr
artifacts when available.

## Bounds

Recommended first limits:

| Field | Limit |
| --- | --- |
| `commandPreview` | 4 KiB |
| each `argvPreview` item | 1 KiB |
| `argvPreview` count | 64 |
| `stdoutHead` / `stderrHead` | 8 KiB each |
| `stdoutTail` / `stderrTail` | 32 KiB each |
| `terminal.visibleText` | 32 KiB |
| snapshot frequency | one per 5 seconds unless state changes |
| snapshots per tool call | 100 |
| text artifact size | 128 KiB |

If limits are exceeded, keep JSON valid and set `output.truncated: true`.

## Daemon Implementation

### Module Layout

Recommended files:

```text
packages/daemon/src/features/runs/shell-snapshots.ts
packages/daemon/src/features/runs/shell-snapshot-routes.ts
```

`shell-snapshots.ts` owns pure-ish snapshot creation plus artifact writes. Routes own
read-only artifact lookup and response shaping.

### Snapshot Writer

Add a writer object used by `executeUnifiedExec`:

```ts
interface ShellSnapshotWriter {
  capture(input: ShellSnapshotCaptureInput): ShellSnapshotCaptureResult | undefined;
  markFirstOutput(stream: "stdout" | "stderr"): void;
  maybeCapturePeriodic(input: ShellSnapshotCaptureInput): ShellSnapshotCaptureResult | undefined;
}
```

The writer keeps:

- next sequence number;
- last capture time;
- snapshot count;
- whether first output was captured;
- last state hash for no-op suppression.

The writer should return `undefined` when a capture is suppressed by bounds or feature
gate.

### Unified Exec Integration

`executeUnifiedExec` should call the writer at these points:

```text
after request normalization -> exec_start
after spawn succeeds -> update process pid metadata
on first stdout/stderr ingest -> exec_first_output
periodic timer or output ingest -> exec_periodic
timeout kill path -> exec_timeout
abort listener -> exec_cancel
after flush/result artifact write -> exec_end
```

Keep command execution authoritative. Snapshot artifact write failures are diagnostic
failures, not command failures, except when redaction fails.

### Stream Capture Changes

P1's `StreamCaptureSnapshot` is internal to `unified-exec.ts`. P2B should extend internal
capture state with:

- head buffer;
- tail buffer;
- redaction flags by stream;
- byte/line counts;
- truncation flags.

Do not change `UnifiedExecStreamSummary` unless Web/CLI need the new fields directly.
Snapshots can use the richer internal state.

### Artifact Events

Emit normal `artifact_created` events for snapshot JSON/text artifacts:

```ts
{
  artifact,
  artifactId: artifact.id,
  toolCallId,
  toolName: "bash",
  role: "shell_snapshot",
  snapshotId: snapshot.id,
  snapshotSource: snapshot.source,
  snapshotStatus: snapshot.status
}
```

No new run event type is required in P2B.1.

## API Surface

Add read-only routes:

```http
GET /runs/:runId/shell-snapshots?cwd=...
GET /runs/:runId/shell-snapshots?cwd=...&toolCallId=...
GET /runs/:runId/shell-snapshots/:snapshotId?cwd=...
```

Implementation notes:

- parse snapshot routes beside `parseRunRoute`;
- locate the run store through `RunStoreRegistry.findStoreForRun`;
- list artifacts whose paths include `/shell-snapshots/`;
- parse JSON artifacts to produce list/detail responses;
- fail closed if a snapshot artifact path escapes the artifact root;
- return `404 snapshot_not_found` for missing ids;
- do not open a shell, inspect a process, or mutate runtime state.

Manual capture is deferred. If added later, it should be a separate `POST` route and must
not change process state.

## API Client

Add methods:

```ts
listRunShellSnapshots(runId: string, cwd?: string, toolCallId?: string): Promise<ShellSnapshotListResponse>
getRunShellSnapshot(runId: string, snapshotId: string, cwd?: string): Promise<ShellSnapshotResponse>
```

The client should not fetch artifact content automatically. Web and CLI can request text
or JSON artifact content through the existing artifact endpoints.

## CLI Surface

Add read-only commands:

```text
ling-stack runs shell-snapshots <run-id> [--tool-call <toolCallId>]
ling-stack runs shell-snapshot <run-id> <snapshot-id>
```

List output:

```text
Shell snapshots for run_123:
ID                                      Tool Call       Source         Status     Age
shell_snapshot:run_123:tool_abc:000001 tool_abc        exec_start     starting   12s
shell_snapshot:run_123:tool_abc:000004 tool_abc        exec_end       exited     1s
```

Detail output:

- status/source;
- command preview;
- cwd;
- duration/exit code/signal;
- stdout/stderr tails;
- artifact ids.

JSON CLI mode should print the daemon response as JSON only.

## Doctor Surface

Doctor remains read-only. Add a warning check only after the route exists:

- active or recently completed unified exec commands with no final snapshot;
- snapshot artifact JSON parse failures;
- snapshot artifacts that reference missing stdout/stderr/result artifacts;
- stale active snapshot older than the periodic threshold for a running command.

Doctor must not trigger manual capture by default.

## Web Surface

P2B can fit into existing run history before a dedicated snapshot panel exists.

Implemented first UI:

- In run evidence, show a "Shell snapshots" panel for the selected run.
- Fetch snapshots through the read-only list API.
- Link to JSON/text snapshot artifacts.
- Show compact fields: status, source, sequence, command preview, tool call, duration,
  and exit code.
- Keep raw/unbounded output out of the page; artifact preview remains user-triggered.

Follow-up UI:

- Add a snapshot timeline grouped by `toolCallId`.
- Show active command status and last output tail.
- Add filters for `source` and `status`.

Do not present snapshots as replay or recovery.

## Feature Gate

Extend runtime tool features:

```ts
interface RuntimeToolFeatureFlags {
  readonly requestPermissions?: boolean;
  readonly unifiedExec?: boolean;
  readonly shellSnapshot?: boolean;
}
```

Recommended default:

- `shellSnapshot`: off until P2B contract, daemon tests, redaction tests, and at least
  CLI/API smoke coverage pass.

When disabled:

- unified exec continues to run normally;
- no shell snapshot artifacts are created;
- snapshot list endpoint may return an empty list or `feature_disabled`, but it must not
  inspect live process state.

## Implementation Slices

### P2B.1 Core And Contract Types

Files:

- `packages/core/src/exec/shell-snapshot-types.ts`
- `packages/core/src/index.ts`
- `packages/contracts/src/shell-snapshots.ts`
- `packages/contracts/src/index.ts`

Tasks:

- Add snapshot/source/status/command/process/output/redaction types.
- Add list/detail response types.
- Keep fields additive.

Status: implemented.

Acceptance:

- Contracts build.
- Existing P1 unified exec types remain unchanged unless optional references are needed.

### P2B.2 Daemon Snapshot Builder

Files:

- `packages/daemon/src/features/runs/shell-snapshots.ts`
- `packages/daemon/src/features/runs/unified-exec.ts`

Tasks:

- Implement snapshot id/sequence generation.
- Implement redacted command and output snapshot creation.
- Implement JSON/text artifact writing under `/shell-snapshots/`.
- Emit `artifact_created` events with `role: "shell_snapshot"`.
- Suppress captures when feature gate is off.

Status: implemented for automatic `exec_start` and terminal `exec_end` snapshots.

Acceptance:

- Allowed `bash` runs create `exec_start` and `exec_end` snapshot artifacts.
- Denied `bash` approvals create no shell snapshots because no process starts.

### P2B.3 Active Output Snapshots

Files:

- `packages/daemon/src/features/runs/unified-exec.ts`
- `packages/daemon/src/features/runs/shell-snapshots.ts`

Tasks:

- Extend internal stream capture with tail buffers.
- Capture first-output and periodic snapshots.
- Capture timeout/cancel snapshots before process termination completes.
- Enforce frequency and count limits.

Status: deferred.

Acceptance:

- Long-running commands produce bounded periodic snapshots.
- Long output does not create unbounded memory growth or snapshot spam.

### P2B.4 Read-Only Daemon API

Files:

- `packages/daemon/src/server/routes.ts`
- `packages/daemon/src/server/router.ts`
- `packages/daemon/src/features/runs/shell-snapshots.ts`
- `packages/api-client/src/client.ts`

Tasks:

- Add route parsing.
- Add list/detail handlers.
- Add api-client methods.
- Reuse artifact content/preview APIs for body content.

Status: implemented.

Acceptance:

- Listing snapshots works after daemon restart when `cwd` is provided.
- Missing run/snapshot/artifact responses are readable 404s.

### P2B.5 CLI Commands

Files:

- `packages/cli/src/main.ts`

Tasks:

- Add `runs shell-snapshots`.
- Add `runs shell-snapshot`.
- Support JSON mode without non-JSON stdout.
- Keep human output compact and artifact-id oriented.

Status: implemented.

Acceptance:

- CLI can list and show snapshots for a completed run.
- CLI does not open a shell or trigger capture.

### P2B.6 Web Integration

Files:

- `apps/web/src/features/runs/RunHistory.tsx`
- `apps/web/src/lib/data.ts`
- shared artifact preview components if needed

Status: implemented as P2B-F1.

Tasks:

- Fetch shell snapshots for the selected run through the read-only API.
- Show snapshot count, source/status, command preview, tool call, duration, exit code,
  and JSON/text artifact links.
- Render empty or unavailable state without breaking run detail.

Acceptance:

- Users can reach snapshot artifacts from run history.
- UI does not display unbounded output inline.

### P2B.7 Doctor Diagnostics

Files:

- `packages/cli/src/main.ts`
- daemon route helpers if a compact health endpoint becomes necessary

Status: implemented as P2B-F2 without a new daemon health endpoint.

Tasks:

- Add read-only warning checks for missing/failed snapshot APIs and artifact pairs.
- Report runner capability and recent run snapshot health.
- Avoid any manual capture side effects.

Acceptance:

- Doctor can report snapshot health.
- Doctor does not mutate runtime state.

### P2B.8 Tests

Files:

- `packages/core/test/*shell-snapshot*.test.mjs`
- `packages/daemon/test/*shell-snapshot*.test.mjs`
- `packages/cli/test/*shell-snapshot*.test.mjs`
- Web focused tests only if UI is touched

Tasks:

- Add contract serialization tests.
- Add daemon tests for allow/ask/deny/nonzero/timeout/cancel/long output/redaction.
- Add API list/detail tests.
- Add CLI JSON/human output tests.
- Add Web rendering tests if snapshot links are surfaced.

Acceptance:

- No raw configured secret appears in events, artifacts, API responses, CLI output, or
  Web fixture output.
- Snapshots are not used for run recovery after daemon restart.

## Test Matrix

| Case | Expected Snapshot Behavior |
| --- | --- |
| `bash=allow`, success | `exec_start`, optional output snapshots, `exec_end` |
| `bash=ask`, approved | Snapshots include approval id |
| `bash=ask`, denied | No snapshots, because no process starts |
| `bash=deny` | No snapshots, handled denial only |
| nonzero exit | Final snapshot status `failed`, exit code present |
| timeout | `exec_timeout` and final `timed_out` evidence |
| cancellation | `exec_cancel` evidence if possible; run remains `cancelled` |
| long stdout/stderr | Tail/head bounded; artifacts redacted and bounded |
| secret in command/output | Redacted in snapshot JSON/text/events/API/CLI/Web |
| daemon restart | Existing snapshot artifacts readable with `cwd`; no process recovery |
| feature gate off | No snapshot artifacts, unified exec still works |

## Acceptance Criteria

P2B is complete when:

- approved daemon-owned `bash` executions create bounded shell snapshot artifacts;
- denied commands that never spawn create no shell snapshots;
- snapshots are derived from unified exec request/output/result state;
- snapshots include command, cwd, status, timing, output head/tail, artifact refs, and
  redaction summary;
- Web and CLI can inspect snapshots through read-only APIs;
- doctor reports snapshot health without opening shells or mutating state;
- snapshots contain no raw secrets;
- snapshots remain diagnostic evidence, not durable process state or recovery input.

## Open Questions

- Should the first implementation create text artifacts for every snapshot, or only for
  final snapshots and large periodic snapshots?
- Should list endpoints parse every snapshot JSON artifact on demand, or cache compact
  list metadata in artifact titles once usage grows?
- Should shell snapshots include `tool_update` chunk sequence ranges, or is timestamp and
  output tail enough for diagnostics?
- Should cancelled runs always attempt a final `exec_end` snapshot after abort, or is
  `exec_cancel` plus unified exec result artifact enough?
