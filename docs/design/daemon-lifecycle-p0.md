# Daemon Lifecycle and Doctor P0

## Status

Proposed for the Codex CLI borrowing P0 slice.

Related design docs:

- [CLI v0.1](cli-v0.1.md)
- [Daemon API](../daemon-api.md)
- [Architecture](../architecture.md)
- [Runtime supervisor](runtime-supervisor.md)
- [State machine recovery](state-machine-recovery.md)

Reference snapshot:

- Upstream `openai/codex` at `345cf6e`
- Relevant Codex areas: `doctor`, `exec`, `app-server`, `mcp`, and `completion`

## Problem

Ling Stack can run a foreground daemon today, and the CLI can call daemon APIs when that daemon is already reachable. That is not enough for a reliable local operator loop.

The current gaps are:

- `ling-stack daemon start` without `--foreground` is not implemented.
- `ling-stack daemon stop`, `restart`, and `logs` are not implemented.
- `ling-stack doctor` is an aggregate readiness summary, not a stable check-row diagnostic report.
- Doctor depends on a reachable daemon before it can explain why the daemon is not reachable.
- There is no daemon process state file that records pid, host, port, log path, or startup metadata.

This P0 turns daemon lifecycle and doctor into first-class local operations.

## Current Baseline

Implemented today:

- `packages/daemon/src/cli.ts` starts the daemon in the current process and handles `SIGINT` and `SIGTERM`.
- `packages/cli/src/index.ts` supports:
  - `ling-stack daemon status`,
  - `ling-stack daemon start --foreground`,
  - `ling-stack doctor`.
- `RuntimeSupervisor` writes `.ling-stack/runtime.lock` when a workspace runtime is opened.
- `/health` returns daemon reachability and `defaultWorkspaceCwd`.
- `/runtime/leases`, `/runtime/active`, `/runtime/stuck`, and related endpoints expose runtime diagnostics.

Important distinction:

- `.ling-stack/runtime.lock` is execution ownership for a workspace runtime.
- P0 daemon state is process lifecycle metadata for CLI start, status, stop, restart, logs, and doctor.

Do not merge these files. They answer different questions.

## Goals

- Support background daemon lifecycle:
  - `ling-stack daemon start`,
  - `ling-stack daemon status`,
  - `ling-stack daemon stop`,
  - `ling-stack daemon restart`,
  - `ling-stack daemon logs`.
- Make daemon lifecycle workspace-scoped through `--cwd`.
- Persist daemon process metadata in deterministic local files.
- Let doctor diagnose daemon-not-running, stale pid files, stale listeners, bad logs, workspace state, providers, channels, policy, runtime leases, stale work, Web reachability, and MCP status without mutating state.
- Replace aggregate doctor readiness with a stable check-row schema.
- Keep normal product commands on the existing HTTP daemon API.
- Preserve approval policy, provider preflight, secret redaction, and runtime ownership boundaries.

## Non-Goals

- No JSON-RPC app-server migration.
- No remote daemon management.
- No launchd, systemd, Windows service, or desktop packaging integration.
- No automatic repair mode in doctor.
- No hidden approval bypass for CLI runs.
- No force-kill by default.
- No cross-machine distributed lock.
- No raw secret values in daemon state, logs surfaced by doctor, JSON reports, SQLite, WORKFLOW files, or artifacts.

## Concept Model

```text
CLI lifecycle command
  |
  +--> .ling-stack/daemon/daemon.json   process metadata
  +--> .ling-stack/daemon/daemon.pid    fast pid lookup
  +--> .ling-stack/logs/daemon.log      daemon stdout/stderr
  |
  +--> HTTP /health probe               live process truth
  |
  +--> daemon process
          |
          +--> RuntimeSupervisor
                  |
                  +--> .ling-stack/runtime.lock
                  +--> SQLite work units, leases, semaphores
```

Lifecycle state is advisory. The health probe and process liveness check are the truth.

Runtime state is durable product state. The lifecycle commands must not directly mutate work unit, run, approval, lease, or semaphore rows.

## Files and Paths

All P0 paths are resolved from the effective CLI `--cwd`.

```text
.ling-stack/
  daemon/
    daemon.json
    daemon.pid
  logs/
    daemon.log
  runtime.lock
```

`runtime.lock` already belongs to `RuntimeSupervisor`. P0 should keep using it for runtime ownership diagnostics, but daemon lifecycle should write only under `.ling-stack/daemon/` and `.ling-stack/logs/`.

### `daemon.pid`

Purpose:

- Fast pid lookup for status, stop, restart, and logs.

Contents:

```text
12345
```

Rules:

- The file contains only a base-10 pid and a trailing newline.
- If the pid is missing, invalid, or dead, lifecycle commands treat it as stale metadata.
- Stop and restart may remove stale pid files.
- Doctor reports stale pid files as warning and does not remove them.

### `daemon.json`

Purpose:

- Human and machine-readable lifecycle metadata.

Schema:

```json
{
  "schemaVersion": 1,
  "pid": 12345,
  "host": "127.0.0.1",
  "port": 17891,
  "url": "http://127.0.0.1:17891",
  "cwd": "/path/to/workspace",
  "defaultWorkspaceCwd": "/path/to/workspace",
  "startedAt": "2026-06-06T00:00:00.000Z",
  "pidPath": "/path/to/workspace/.ling-stack/daemon/daemon.pid",
  "statePath": "/path/to/workspace/.ling-stack/daemon/daemon.json",
  "logPath": "/path/to/workspace/.ling-stack/logs/daemon.log",
  "nodePath": "/path/to/node",
  "nodeVersion": "v24.0.0",
  "daemonCliPath": "/path/to/packages/daemon/dist/cli.js",
  "createdByPid": 12000
}
```

Rules:

- Do not store environment variables.
- Do not store secret refs unless they are already public configuration names.
- Do not store raw provider keys, MCP bearer tokens, OAuth tokens, GitHub tokens, or cookies.
- If the daemon exits cleanly through the CLI-managed process, the lifecycle manager removes `daemon.pid` and `daemon.json` only if the pid still matches.
- If the daemon exits without cleanup, status and doctor report stale metadata.

### `daemon.log`

Purpose:

- Capture background daemon stdout and stderr.
- Support `ling-stack daemon logs`.
- Give doctor a bounded, redacted diagnostic source.

Rules:

- Background `daemon start` appends to `daemon.log`.
- P0 does not need log rotation.
- `daemon logs` defaults to the last 200 lines.
- `daemon logs --follow` may be implemented in P0 if simple; otherwise leave it out and keep the command non-streaming.
- Doctor may report log file existence, size, modified time, and the last error-like line after redaction.

## Daemon Lifecycle Commands

### `ling-stack daemon start`

Purpose:

- Start the local daemon in the background.

Behavior:

1. Resolve `--cwd`, host, port, and runtime paths.
2. Ensure `.ling-stack/daemon/` and `.ling-stack/logs/` exist.
3. Read existing daemon state if present.
4. If `/health` succeeds for the target URL and reports `ling-stack-daemon`, print the existing URL and exit `0`.
5. If the pid exists but is dead, replace stale metadata.
6. If the pid is alive but `/health` fails, exit with `daemon_state_conflict` and do not kill the process.
7. If the port is occupied by a non-Ling service, exit with `port_in_use`.
8. Spawn the daemon detached with stdout/stderr appended to `daemon.log`.
9. Write `daemon.pid` and `daemon.json`.
10. Poll `/health` until ready or timeout.
11. On ready, print the daemon URL and exit `0`.
12. On timeout, keep the state files for diagnosis and exit `7`.

Default readiness timeout:

```text
5000 ms
```

Supported flags:

```text
--foreground       Run in the current terminal.
--host <host>      Default: 127.0.0.1.
--port <port>      Default: 17891.
--timeout <ms>     Optional P0 addition. Default: 5000.
```

Foreground behavior:

- `daemon start --foreground` keeps current behavior: daemon stdout/stderr stay attached to the terminal.
- It should still write matching lifecycle metadata when launched through `packages/cli`.
- On foreground process exit, the CLI removes lifecycle metadata if the pid still matches.

### `ling-stack daemon status`

Purpose:

- Report live daemon state.

Behavior:

1. Read `daemon.json` and `daemon.pid` if present.
2. Check whether the pid is alive.
3. Probe `/health`.
4. Report one of:
   - `running`,
   - `not_running`,
   - `stale_state`,
   - `state_conflict`,
   - `unreachable`,
   - `port_conflict`.

Exit codes:

| State | Exit |
| --- | --- |
| `running` | `0` |
| `not_running` | `3` |
| `unreachable` | `3` |
| `stale_state` | `4` |
| `state_conflict` | `4` |
| `port_conflict` | `4` |

Human output:

```text
Daemon: running
URL: http://127.0.0.1:17891
PID: 12345
State: .ling-stack/daemon/daemon.json
Log: .ling-stack/logs/daemon.log
Latency: 12ms
```

JSON output:

```json
{
  "status": "running",
  "ok": true,
  "daemonUrl": "http://127.0.0.1:17891",
  "pid": 12345,
  "statePath": "/path/to/.ling-stack/daemon/daemon.json",
  "logPath": "/path/to/.ling-stack/logs/daemon.log",
  "health": {
    "ok": true,
    "service": "ling-stack-daemon"
  },
  "issues": []
}
```

### `ling-stack daemon stop`

Purpose:

- Stop the CLI-managed daemon.

Behavior:

1. Read lifecycle metadata.
2. If no running daemon exists, print `Daemon: not running` and exit `0`.
3. Probe `/runtime/active?cwd=<cwd>` when the daemon is reachable.
4. If active work exists, exit `4` with `daemon_has_active_work` unless `--force` is provided.
5. Send `SIGTERM` to the recorded pid.
6. Wait for process exit up to the timeout.
7. Remove lifecycle metadata if the pid still matches.
8. If the process does not exit, return `7` and leave metadata for diagnosis.

Supported flags:

```text
--force          Stop even when active work is reported.
--timeout <ms>   Default: 5000.
```

P0 should not send `SIGKILL` by default. A future `--kill` can be added after explicit review.

### `ling-stack daemon restart`

Purpose:

- Restart the CLI-managed daemon.

Behavior:

1. Run `daemon stop` semantics.
2. If stop fails because active work exists, fail unless `--force` is provided.
3. Run `daemon start` semantics with the same host, port, cwd, and timeout.

Supported flags:

```text
--force
--host <host>
--port <port>
--timeout <ms>
```

### `ling-stack daemon logs`

Purpose:

- Print daemon logs without opening files manually.

Behavior:

1. Read `daemon.json` for `logPath`.
2. Fall back to `.ling-stack/logs/daemon.log` if state is missing.
3. Print the last `--lines` lines.
4. If the log file is missing, exit `4` with `daemon_log_missing`.

Supported flags:

```text
--lines <n>      Default: 200.
--follow         Optional in P0.
```

JSON mode:

- `daemon logs --json` prints:

```json
{
  "logPath": "/path/to/.ling-stack/logs/daemon.log",
  "lines": ["..."]
}
```

## Doctor P0

Doctor must be safe to run in a broken workspace. It should collect evidence and remediation, not repair anything.

### Command Shape

```text
ling-stack doctor
ling-stack doctor --summary
ling-stack doctor --all
ling-stack doctor --ascii
ling-stack doctor --json
```

Global `--json` may continue to work, but doctor-specific flags should be accepted after the command.

### Report Schema

```ts
type DoctorStatus = "ok" | "warning" | "fail";

interface DoctorReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly overallStatus: DoctorStatus;
  readonly cwd: string;
  readonly daemonUrl: string;
  readonly checks: readonly DoctorCheck[];
}

interface DoctorCheck {
  readonly id: string;
  readonly category: string;
  readonly status: DoctorStatus;
  readonly summary: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly issues: readonly DoctorIssue[];
  readonly remediation?: string;
  readonly durationMs: number;
}

interface DoctorIssue {
  readonly severity: DoctorStatus;
  readonly cause: string;
  readonly measured?: string;
  readonly expected?: string;
  readonly remedy?: string;
  readonly fields?: readonly string[];
}
```

JSON output:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-06T00:00:00.000Z",
  "overallStatus": "fail",
  "cwd": "/path/to/workspace",
  "daemonUrl": "http://127.0.0.1:17891",
  "checks": [
    {
      "id": "daemon.health",
      "category": "daemon",
      "status": "fail",
      "summary": "daemon is not reachable",
      "details": {
        "url": "http://127.0.0.1:17891"
      },
      "issues": [
        {
          "severity": "fail",
          "cause": "health probe failed",
          "remedy": "Run ling-stack daemon start."
        }
      ],
      "remediation": "Run ling-stack daemon start.",
      "durationMs": 1003
    }
  ]
}
```

### Check Set

P0 checks:

| Check id | Category | Failure meaning |
| --- | --- | --- |
| `system.node` | system | Node runtime cannot run the CLI or daemon. |
| `workspace.paths` | workspace | `.ling-stack` paths are missing or not writable when required. |
| `workspace.sqlite` | workspace | SQLite cannot be opened or migrated. |
| `daemon.process_state` | daemon | pid/state/log metadata is stale or malformed. |
| `daemon.health` | daemon | target daemon URL is unreachable or not Ling Stack. |
| `daemon.logs` | daemon | log file is missing, unreadable, or contains recent fatal startup errors. |
| `web.health` | web | configured dev Web UI is unreachable. Warning by default. |
| `providers.configured` | providers | no enabled chat-capable provider is configured. |
| `providers.secrets` | providers | required provider secrets are missing. |
| `providers.preflight` | providers | no runnable provider has a successful last check. |
| `channels.configured` | channels | no active channel exists. |
| `channels.default_provider` | channels | active channels lack default providers. Warning when explicit `--provider` can still run. |
| `approval_policy.load` | policy | approval policy cannot be loaded. |
| `runtime.leases` | runtime | active leases exist. Warning unless stale or blocking. |
| `runtime.stale_work` | runtime | stale work units or stale leases require reconciliation. |
| `mcp.servers` | mcp | MCP server config is malformed or status probe fails. |
| `mcp.secrets` | mcp | required MCP secret refs are missing. |
| `external_work.workflow` | external-work | bound WORKFLOW file is invalid. Warning unless it blocks configured background work. |

Rules:

- `daemon.process_state` reports `ok` when no lifecycle files exist.
- `daemon.health` reports `fail` when the daemon is required for normal CLI use and cannot be reached.
- `web.health` is `warning` unless the user explicitly requests UI readiness.
- Active leases are not automatically failure. They become warning when they are old, stale, or explain a blocked run.
- Doctor must continue collecting local checks after daemon checks fail.
- Doctor must redact secrets in all human and JSON output.

### Human Output

Default:

```text
Ling Stack doctor

Daemon
  fail  daemon.health          daemon is not reachable
  ok    daemon.process_state   no daemon state file found

Workspace
  ok    workspace.paths        runtime paths exist
  ok    workspace.sqlite       database opens

Next:
  ling-stack daemon start
```

`--summary`:

```text
Ling Stack doctor: fail
Daemon: 1 fail, 1 ok
Workspace: 2 ok
Next: ling-stack daemon start
```

`--ascii` uses plain labels only:

```text
[fail] daemon.health daemon is not reachable
```

### Redaction

Doctor must redact:

- URL credentials,
- query params likely to contain secrets,
- authorization headers,
- cookie values,
- provider API keys,
- MCP bearer tokens,
- OAuth access and refresh tokens,
- keychain secret values,
- GitHub and Linear tokens,
- raw command output lines that contain known secret values.

Doctor may show:

- secret ref names such as `env:LOCAL_RELAY_API_KEY` or `keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN`,
- booleans like `configured: true`,
- counts,
- file paths under the workspace,
- host and port.

## Process and Runtime Interaction

Stopping the daemon is not the same as reconciling work.

P0 rules:

- CLI lifecycle commands may signal the daemon process.
- CLI lifecycle commands must not edit run rows, work unit rows, approval rows, leases, or semaphore slots directly.
- The daemon's own shutdown path remains responsible for active in-process cleanup.
- Startup recovery remains owned by `RuntimeSupervisor`.
- Doctor may recommend reconcile commands, but it must not run them.

## Error Codes

Use existing CLI exit codes where possible:

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `2` | Bad CLI usage. |
| `3` | Daemon unreachable or not running for commands that require a live daemon. |
| `4` | Daemon returned an error, doctor found the workspace not ready, or lifecycle state is inconsistent. |
| `6` | Run failed. |
| `7` | Timeout. |

Recommended stable error strings:

```text
daemon_unreachable
daemon_not_running
daemon_state_stale
daemon_state_conflict
daemon_has_active_work
daemon_start_timeout
daemon_stop_timeout
daemon_log_missing
port_in_use
doctor_not_ready
```

## Implementation Plan

0. Split the executable entrypoint and isolate new P0 modules.
   - Keep `index.ts` as a thin executable bootstrap.
   - Move the existing implementation behind `main.ts`.
   - Add lifecycle-specific modules under `packages/cli/src/daemon/`.
   - Add doctor-specific modules under `packages/cli/src/doctor/`.
   - Do not introduce a CLI framework dependency in this split.
   - Run the existing CLI tests before and after adding lifecycle behavior.

1. Add daemon lifecycle path helpers.
   - Prefer a small helper near CLI code first.
   - Promote to `@ling-stack/core` only if daemon or tests need the same helper.

2. Add lifecycle state read/write utilities.
   - Parse `daemon.pid`.
   - Parse and validate `daemon.json`.
   - Detect alive pid with `process.kill(pid, 0)`.
   - Probe `/health` with timeout.

3. Implement `daemon start`.
   - Preserve current `--foreground`.
   - Add detached background start.
   - Append stdout/stderr to `.ling-stack/logs/daemon.log`.
   - Wait for readiness.

4. Implement `daemon status`, `stop`, `restart`, and `logs`.
   - Keep commands deterministic and scriptable.
   - Do not prompt interactively.
   - Use `--force` for active-work stop/restart.

5. Replace doctor internals with check rows.
   - Keep current readiness facts.
   - Add local fallback checks when daemon is unreachable.
   - Add redacted JSON report.

6. Add tests.
   - Existing CLI tests pass after the no-behavior-change split.
   - Unit tests for lifecycle state parsing and stale pid handling.
   - CLI tests with a temporary cwd and port.
   - Doctor snapshot or structured JSON tests.

7. Update docs.
   - `cli-v0.1.md`.
   - `daemon-api.md` for current `/health` fields and optional P0 lifecycle fields.
   - `architecture.md` for the process lifecycle versus runtime supervisor boundary.
   - `state-machine-recovery.md` for stop/restart and read-only doctor recovery boundaries.
   - `runtime-supervisor.md` only if runtime ownership behavior changes.
   - Track deeper command-by-command CLI splitting as a follow-up before shell completion generation.

## Test Plan

Unit tests:

- Parse valid `daemon.pid`.
- Reject malformed `daemon.pid`.
- Parse valid `daemon.json`.
- Reject `daemon.json` with missing pid, bad URL, or mismatched paths.
- Dead pid is stale.
- Alive pid plus failed health is `state_conflict`.
- No pid and no state is `not_running`.
- Doctor redacts secret-like fields.
- Doctor JSON has stable `schemaVersion`, `overallStatus`, and `checks`.

CLI integration tests:

- `daemon start --foreground` still starts and exits on signal.
- `daemon start` starts a background daemon and writes pid/state/log files.
- Repeated `daemon start` against a healthy daemon exits `0` and prints the URL.
- `daemon status --json` reports `running`.
- `daemon logs --lines 20` prints bounded log output.
- `daemon stop` stops the daemon and removes matching pid/state files.
- `daemon restart` stops and starts with the same URL.
- `doctor --json` continues when the daemon is down.
- `doctor --summary --ascii` produces no ANSI or non-ASCII status glyphs.

Manual smoke:

```bash
corepack pnpm --filter @ling-stack/cli build
corepack pnpm --filter @ling-stack/daemon build
node packages/cli/dist/index.js --cwd /tmp/ling-p0-smoke init
node packages/cli/dist/index.js --cwd /tmp/ling-p0-smoke daemon start
node packages/cli/dist/index.js --cwd /tmp/ling-p0-smoke daemon status --json
node packages/cli/dist/index.js --cwd /tmp/ling-p0-smoke doctor --summary --ascii
node packages/cli/dist/index.js --cwd /tmp/ling-p0-smoke daemon logs --lines 20
node packages/cli/dist/index.js --cwd /tmp/ling-p0-smoke daemon restart
node packages/cli/dist/index.js --cwd /tmp/ling-p0-smoke daemon stop
```

## Open Decisions

### Log Follow

Question: should `daemon logs --follow` be part of P0?

Recommendation: implement only if it stays small. Non-following bounded logs are enough for P0 doctor and lifecycle debugging.

### Stop With Active Work

Question: should `daemon stop` refuse when active work exists?

Recommendation: yes. Default stop should refuse with `daemon_has_active_work`; `--force` should be explicit.

### State Path Scope

Question: should daemon process state be workspace-local or global?

Recommendation: workspace-local for P0. Ling Stack is currently workspace-first, and `--cwd` already selects the local runtime paths. A future desktop app may add a global process registry that points to workspace daemons.

### Health Payload

Question: should `/health` include pid, version, host, port, and startedAt?

Recommendation: yes if cheap. Lifecycle commands can work from local state alone, but richer health makes status and doctor more reliable.

## Completion Criteria

P0 is complete when:

- `ling-stack daemon start/status/stop/restart/logs` work from a clean workspace.
- `ling-stack daemon start --foreground` still works.
- Stale pid/state files are visible and diagnosable.
- `ling-stack doctor` emits check-row human output.
- `ling-stack doctor --json` emits a redacted stable schema.
- Doctor can run and explain useful next steps even when the daemon is down.
- Tests cover lifecycle state, command behavior, doctor schema, and redaction.
