# CLI v0.1 Design

## Status

Implemented for Milestone 6: CLI First Loop.

This design depends on:

- [Session persistence](session-persistence.md)
- [Provider presets](provider-presets.md)
- [Approval policy](approval-policy.md)
- [Ling UI 2.0 整体升级方案](./ui2.0升级/00-UI2.0整体升级方案.md)
- [Codex-Inspired Runtime Tools](codex-inspired-runtime-tools.md)

The current `packages/cli` package can initialize a workspace, diagnose readiness, manage providers, channels, channel runtime policy, tasks, runs, approvals, approval policy, daemon lifecycle, shell completion, and Web UI launch through daemon APIs.

## Goal

The CLI should let terminal users complete the same local workflow as the Web UI.

Minimum loop:

```text
ling-stack init
-> configure provider
-> create channel
-> create task
-> run task
-> stream events in terminal
-> inspect persisted run
-> approve or deny pending actions
-> open local web UI when useful
```

The CLI is not a separate runtime. It is a front door to the local daemon and the same `.ling-stack` state used by Web UI.

## Non-Goals

v0.1 CLI does not include:

- Cloud login.
- Multi-user workspaces.
- Remote daemon management.
- Dynamic object-id completion or shell-plugin installation.
- Full TUI.
- Desktop installation.
- Direct bypass of daemon policy.
- Secret storage beyond `env:` references.

## Current Baseline

Implemented today:

- `ling-stack init`
- `ling-stack doctor`
- `ling-stack daemon status/start/stop/restart/logs`
- `ling-stack provider list/add/show/check/update/remove`
- `ling-stack channel list/create/show/update/remove`
- `ling-stack task list/create/show/update/run/remove`
- `ling-stack run`
- `ling-stack runs list/show/events/cancel`
- `ling-stack approvals list/show/approve/deny`
- `ling-stack policy show/set/reset`
- `ling-stack completion bash|zsh|fish`
- `ling-stack ui`

Not implemented in the CLI contract:

- `daemon logs --follow`,
- dynamic completion for workspace object ids,
- structured `--output-schema`,
- desktop packaging and remote daemon management.

## Design Principles

- CLI calls daemon APIs instead of duplicating product logic.
- CLI output is readable by default and machine-readable with `--json`.
- CLI never prints raw API keys.
- CLI defaults to safe read-only tools.
- CLI should work before the desktop app exists.
- CLI commands should be stable enough to document in README.
- CLI should expose exact daemon errors instead of hiding them.
- CLI should expose channel concurrency and active lease state so stuck runs are diagnosable without opening Web.
- CLI run automation should keep stdout machine-consumable: default stdout is reserved for the final assistant text where possible, progress goes to stderr, and JSON mode emits JSONL only.

## Command Groups

```text
ling-stack init
ling-stack doctor

ling restart
ling status
ling logs
ling-stack restart
ling-stack status
ling-stack logs

ling-stack daemon start
ling-stack daemon status
ling-stack daemon stop
ling-stack daemon restart
ling-stack daemon logs

ling-stack provider add
ling-stack provider list
ling-stack provider show
ling-stack provider check
ling-stack provider update
ling-stack provider remove

ling-stack channel create
ling-stack channel list
ling-stack channel show
ling-stack channel update
ling-stack channel remove

ling-stack task create
ling-stack task list
ling-stack task show
ling-stack task update
ling-stack task run

ling-stack run
ling-stack runs list
ling-stack runs show
ling-stack runs events
ling-stack runs cancel

ling-stack approvals list
ling-stack approvals show
ling-stack approvals approve
ling-stack approvals deny

ling-stack policy show
ling-stack policy set
ling-stack policy reset

ling-stack ui
```

Aliases can be added later. v0.1 should prefer explicit commands.

## Codex CLI Borrowing Backlog

Reference snapshot: upstream `openai/codex` at `345cf6e`.

The goal is not to clone Codex CLI. Ling Stack should borrow the parts that harden the local operator loop: diagnostics, daemon lifecycle, run I/O contracts, completion, MCP status boundaries, and maintainable CLI module boundaries.

P0 detailed design lives in [Daemon Lifecycle and Doctor P0](daemon-lifecycle-p0.md).
P1 detailed design lives in [CLI Run I/O and Completion P1](cli-run-io-completion-p1.md).
P1 implementation breakdown lives in [CLI Run I/O and Completion P1](./cli-run-io-completion-p1.md).
P2 detailed design lives in [MCP Status Boundaries P2](mcp-status-boundaries-p2.md).
P2 implementation breakdown lives in [MCP Status Boundaries P2](./mcp-status-boundaries-p2.md).

### P0 Enabler: CLI Module Split

The current CLI implementation is concentrated in `packages/cli/src/index.ts`. That file
already contains command dispatch, argument parsing, daemon API calls, SSE parsing,
doctor aggregation, daemon foreground startup, Web UI launch, output formatting, and
domain-specific request builders.

Before adding daemon lifecycle and check-row doctor behavior, split the executable
entrypoint from the implementation and isolate new P0 daemon/doctor stateful behavior
into focused modules. This is a mechanical hardening step, not a framework migration.

Borrow from Codex at the boundary level:

- Keep a thin executable entrypoint.
- Keep command handlers separate from command parsing.
- Keep transport/API helpers separate from presentation.
- Keep doctor checks as data-producing units before rendering human or JSON output.
- Keep daemon lifecycle helpers separate from product commands that call the daemon HTTP API.

Do not borrow Codex wholesale:

- Do not switch to app-server JSON-RPC.
- Do not add a large CLI framework only to match Codex.
- Do not change command names, output contracts, or daemon API behavior during the split.

P0 module layout:

```text
packages/cli/src/
  index.ts
  main.ts
packages/cli/src/daemon/
  state.ts
  process.ts
  logs.ts

packages/cli/src/doctor/
  checks.ts
  report.ts
```

The existing command handlers may stay in `main.ts` for the P0 lifecycle/doctor slice
as long as the new daemon lifecycle and doctor check-row behavior does not add more
stateful code to the executable entrypoint. A full command-by-command split remains the
recommended follow-up before shell completion generation.

Acceptance criteria:

- `packages/cli/src/index.ts` only bootstraps `main()`.
- New daemon lifecycle state/process/log code lives under `packages/cli/src/daemon/`.
- New doctor check-row model lives under `packages/cli/src/doctor/`.
- Existing CLI tests pass without snapshot or output changes.
- The split does not introduce a command framework dependency.

### P0: Doctor and Daemon Lifecycle

- Replace the current aggregate `doctor` report with a flat check-row model:
  - `id`,
  - `category`,
  - `status`,
  - `summary`,
  - `details`,
  - `issues`,
  - `remediation`,
  - `durationMs`.
- Render the same check rows as human output and redacted JSON.
- Keep doctor read-only. It may inspect daemon state, workspace paths, SQLite health, provider readiness, keychain/secret status, active leases, stale runs, Web reachability, and WORKFLOW status, but it must not repair state or start long-lived services.
- Treat missing daemon state as `ok/not running`; treat stale pid/socket/listener state as `warning`; reserve `fail` for conditions that block normal CLI use.
- Implement background daemon lifecycle commands:
  - `ling-stack daemon start`,
  - `ling-stack daemon status`,
  - `ling-stack daemon stop`,
  - `ling-stack daemon restart`,
  - `ling-stack daemon logs`.
- Persist daemon pid, state, and log paths under `.ling-stack/` or the chosen runtime state directory, and have doctor inspect those files passively.

### P1: Run I/O and Automation Contract

Status: implemented.

Detailed design: [CLI Run I/O and Completion P1](cli-run-io-completion-p1.md).

- Add stdin-aware prompt handling:
  - `ling-stack run -` reads the prompt from stdin,
  - no prompt plus piped stdin reads the prompt from stdin,
  - prompt plus piped stdin appends the pipe as a fenced `<stdin>...</stdin>` context block.
- Reject invalid prompt encodings clearly; prompt input should be UTF-8, with BOM handling if implemented.
- Make `ling-stack run --json` a strict JSONL stream on stdout. Human progress, warnings, and recovery notices go to stderr.
- Add `--output-last-message <file>` so shell automation can capture the final assistant message without parsing the event stream.
- Consider `--output-schema <file>` after the runner supports structured final responses.
- Keep presentation logic in CLI event processors/printers, not in the runner or daemon orchestration path.

### P1: Completion

Status: implemented for static `bash`, `zsh`, and `fish` scripts.

Detailed design: [CLI Run I/O and Completion P1](cli-run-io-completion-p1.md).

- Add `ling-stack completion <bash|zsh|fish>` after CLI command metadata is stable.
- If the CLI remains hand-parsed, generate and test static completion scripts rather than pretending completion will stay automatic.
- If command/help maintenance keeps growing, revisit a structured parser such as commander, yargs, clipanion, or cac so completion and help output come from one command model.

### P2: MCP Status Boundaries

Detailed design: [MCP Status Boundaries P2](mcp-status-boundaries-p2.md).
Implementation breakdown: [MCP Status Boundaries P2](./mcp-status-boundaries-p2.md).

- Keep persisted MCP server config separate from runtime/auth state.
- MCP status checks should create a short-lived connection/snapshot, collect server info/tools/resources/auth status, then tear it down.
- Secret values and OAuth tokens must stay in Keychain or explicit secret refs; they must not be written to WORKFLOW files, SQLite rows, logs, doctor JSON, or run artifacts.
- Stdio MCP launching should separate protocol ownership from process placement: the broker owns MCP methods, while the launcher owns child process/stdin/stdout placement.

### Not Borrowing Yet

- Do not replace the Ling daemon HTTP API with Codex app-server JSON-RPC just to match Codex. Borrow the internal separation instead: transport/client handling, request processors, slow-client backpressure, initialize/handshake gates, and serialization scopes where Ling has a concrete concurrency problem.
- Do not add a hidden bypass around approval policy for CLI convenience. CLI runs remain product runs through daemon policy.

## Global Options

```text
--daemon-url <url>   Default: http://127.0.0.1:17891
--cwd <path>         Default: process.cwd()
--json               Print machine-readable JSON
--no-color           Disable color
--verbose            Print request and diagnostic context
--help               Show help
```

Environment variables:

```text
LING_STACK_DAEMON_URL=http://127.0.0.1:17891
LING_STACK_HOST=127.0.0.1
LING_STACK_PORT=17891
```

If both `--daemon-url` and `LING_STACK_DAEMON_URL` are set, the CLI flag wins.

## Output Modes

Default output:

- compact tables for lists,
- labeled blocks for detail,
- live stream for runs,
- concise errors.

JSON output:

- exact API response where practical,
- no color,
- no progress spinners,
- one valid JSON object per command.

Example:

```bash
ling-stack provider list --json
```

```json
{
  "providers": []
}
```

## Exit Codes

```text
0  success
1  generic failure
2  bad CLI usage
3  daemon unreachable
4  daemon returned error or doctor found the workspace not ready
5  approval denied
6  run failed
7  timeout
```

The CLI should print a stable error code from the daemon when available.

Example:

```text
error: provider_not_found
message: Provider preset not found: provider_local_relay
```

## Daemon Interaction

The CLI should not open SQLite directly in normal operation. It should call daemon APIs.

Allowed exceptions:

- `ling-stack init` can create a local `.ling-stack` directory before daemon exists.
- `ling-stack daemon start` starts the daemon process.
- diagnostics may inspect local paths read-only when daemon is unavailable.

Recommended API client files:

```text
packages/cli/src/api/client.ts
packages/cli/src/api/providers.ts
packages/cli/src/api/channels.ts
packages/cli/src/api/tasks.ts
packages/cli/src/api/runs.ts
packages/cli/src/api/approvals.ts
```

The CLI API client should be shared in shape with the Web UI client where practical, but do not prematurely create a shared package until duplication becomes real.

### `ling-stack doctor`

Doctor checks daemon health, providers, channels, tasks, approval policy, and active runtime leases. Active leases do not always mean failure because a run may be in progress, but they are shown explicitly so a stale lock can be diagnosed.

Output includes:

```text
Runtime leases: 0 active
```

JSON output includes:

```json
{
  "runtime": {
    "activeLeases": 0
  }
}
```

## Command Details

### `ling-stack init`

Purpose:

- create local Ling Stack runtime directory,
- create default config,
- create disabled provider templates,
- optionally start daemon.

Command:

```bash
ling-stack init
ling-stack init --cwd /path/to/project
ling-stack init --with-provider-templates
```

Creates:

```text
.ling-stack/
  ling-stack.sqlite
  sessions/
  artifacts/
  logs/
  pi/
```

Default provider templates:

- OpenAI,
- Claude,
- local OpenAI-compatible relay,
- Doubao / Ark,
- DeepSeek / DPV4-compatible,
- MiniMax,
- GLM / Zhipu.

Templates should be disabled until configured with model, base URL where needed, and `apiKeyRef`.

Output:

```text
Initialized Ling Stack at .ling-stack
Next:
  ling-stack provider add openai-compatible ...
  ling-stack daemon start
```

### `ling-stack doctor`

Purpose:

- diagnose whether the local workspace is ready to run a task,
- keep terminal users aligned with the Web UI readiness state,
- print the next concrete repair action when readiness is blocked.

Command:

```bash
ling-stack doctor
ling-stack doctor --json
```

Calls:

```http
GET /health
GET /providers?cwd=/path/to/workspace
GET /channels?cwd=/path/to/workspace
GET /tasks?cwd=/path/to/workspace
GET /approval-policy?cwd=/path/to/workspace
```

Readiness checks:

- daemon reachable,
- workspace path selected,
- provider presets exist,
- at least one enabled chat-capable non-media provider has configured secrets,
- at least one runnable provider has `lastCheck.ok === true`,
- at least one channel exists,
- at least one channel has a default provider or a preflight-ready provider exists for explicit run selection,
- task count is visible for context but does not block readiness,
- approval policy is reachable.

Human output:

```text
Ling Stack doctor
Daemon: ok http://127.0.0.1:17891 (12ms)
Workspace: /path/to/ling-stack
Providers: 3 total, 2 runnable, 1 preflight ready
Channels: 1 total, 1 with default provider
Tasks: 4 total
Approval policy: ok
Ready: yes
```

When not ready, append `Next:` lines with one or more concrete commands, for example:

```text
Ready: no
Next:
  ling-stack provider check-all
```

JSON output:

```json
{
  "ok": false,
  "daemon": {
    "ok": true,
    "url": "http://127.0.0.1:17891",
    "elapsedMs": 12,
    "service": "ling-stack-daemon"
  },
  "workspace": {
    "cwd": "/path/to/ling-stack"
  },
  "providers": {
    "total": 3,
    "runnable": 2,
    "preflightReady": 1,
    "unchecked": 1,
    "failed": 1
  },
  "channels": {
    "total": 1,
    "withDefaultProvider": 1
  },
  "tasks": {
    "total": 4
  },
  "approvalPolicy": {
    "ok": true
  },
  "next": ["ling-stack provider check-all"]
}
```

Exit behavior:

- exit `0` when the workspace is ready,
- exit `3` when the daemon is unreachable,
- exit `4` when daemon is reachable but workspace readiness is blocked.

### `ling restart`

Purpose:

- restart the local Ling Stack development stack: daemon plus Web UI.
- hide `launchd`, pid files, raw process kills, and port checks behind one command.

Command:

```bash
ling restart
ling restart --force
ling restart --skip-build
ling-stack restart
```

Behavior:

- local-only; never restarts production or remote services,
- builds local runtime packages in source checkouts unless `--skip-build` is used,
- uses the installed local service manager when available,
- waits for daemon `/health` and Web UI readiness,
- refuses active daemon work by default when it can be verified; `--force` is the explicit override.

Related design: [Local Service Manager](local-service-manager.md).

### `ling status`

Purpose:

- show local daemon and Web UI readiness, manager labels, PIDs, URLs, and log paths.

Command:

```bash
ling status
ling-stack status --json
```

### `ling logs`

Purpose:

- read local daemon/Web logs without requiring users to remember launchd stdout paths.

Command:

```bash
ling logs
ling logs --service daemon --lines 100
ling logs --service web
```

### `ling-stack daemon start`

Purpose:

- start the local daemon for CLI and Web UI.

Command:

```bash
ling-stack daemon start
ling-stack daemon start --host 127.0.0.1 --port 17891
ling-stack daemon start --foreground
```

Current behavior:

- `--foreground` runs daemon in current terminal.
- without `--foreground`, Ling starts the governed detached daemon process and persists
  workspace-scoped lifecycle metadata.

### `ling-stack daemon status`

Purpose:

- check daemon health.

Command:

```bash
ling-stack daemon status
```

Calls:

```http
GET /health
```

Output:

```text
Daemon: ok
URL: http://127.0.0.1:17891
Service: ling-stack-daemon
```

### `ling-stack daemon stop`

Purpose:

- stop a daemon started by Ling Stack.

The command stops only a daemon whose persisted process identity and live process checks
match. It refuses unsafe ownership or active-work cases unless the explicit force policy
allows the requested transition.

## Provider Commands

### `ling-stack provider add`

Command:

```bash
ling-stack provider add openai-compatible \
  --name "Local Relay" \
  --provider-id local-relay \
  --model dpv4 \
  --base-url http://127.0.0.1:3000/v1 \
  --api openai-completions \
  --api-key-ref env:LOCAL_RELAY_API_KEY \
  --capability chat \
  --capability reasoning
```

Calls:

```http
POST /providers
```

Rules:

- raw `--api-key` is not accepted for persistent presets,
- `--api-key-ref` is required when provider needs auth,
- capabilities can be repeated,
- default `--enabled true`.

### `ling-stack provider list`

Command:

```bash
ling-stack provider list
ling-stack provider list --json
```

Calls:

```http
GET /providers
```

Table columns:

```text
ID | Kind | Name | Model | Enabled | Secret | Health
```

### `ling-stack provider show <id>`

Calls:

```http
GET /providers/:id
```

Output must not show raw secrets.

### `ling-stack provider check <id>`

Calls:

```http
POST /providers/:id/check
```

Output:

```text
Provider: Local Relay
Status: ok
Checked: 2026-05-20T10:00:00.000Z
```

### `ling-stack provider update <id>`

Command:

```bash
ling-stack provider update provider_local_relay --model dpv4 --enabled true
```

Calls:

```http
PATCH /providers/:id
```

### `ling-stack provider remove <id>`

Calls:

```http
DELETE /providers/:id
```

If the provider is in use, daemon should reject with a stable error.

## Channel Commands

Channel commands use the daemon channel APIs and never write SQLite directly.

### `ling-stack channel create`

Command:

```bash
ling-stack channel create \
  --name engineering \
  --path /path/to/ling-stack \
  --provider provider_local_relay \
  --status active \
  --write-lock-scope boundPath \
  --max-concurrent-runs 1
```

Calls:

```http
POST /channels
```

Default allowed tools:

```text
read, grep, find, ls
```

Runtime policy flags:

```text
--status active|paused|archived
--write-lock-scope boundPath|channel|workspace
--max-concurrent-runs <n>
--read-only-parallel / --no-read-only-parallel
--queue-on-conflict / --no-queue-on-conflict
```

### `ling-stack channel list`

Calls:

```http
GET /channels
```

### `ling-stack channel show <id>`

Calls:

```http
GET /channels/:id
```

### `ling-stack channel update <id>`

Calls:

```http
PATCH /channels/:id
```

The same runtime policy flags accepted by `channel create` are accepted by `channel update`.

### `ling-stack channel remove <id>`

Calls:

```http
DELETE /channels/:id
```

## Task Commands

Task commands use the daemon task APIs and can start a persisted task through the run stream.

### `ling-stack task create`

Command:

```bash
ling-stack task create \
  --channel engineering \
  --title "Inspect daemon API" \
  --prompt "Read the daemon package and summarize the routes."
```

Calls:

```http
POST /tasks
```

Options:

```text
--channel <id>
--title <text>
--prompt <text>
--prompt-file <path>
```

Prompt text can also be supplied as positional text. To execute a task, use `ling-stack task run <id> --provider <providerPresetId>`.

### `ling-stack task list`

Command:

```bash
ling-stack task list --channel engineering --status running
```

Calls:

```http
GET /tasks?channelId=...&status=...
```

### `ling-stack task show <id>`

Calls:

```http
GET /tasks/:id
```

### `ling-stack task update <id>`

Calls:

```http
PATCH /tasks/:id
```

### `ling-stack task run <id>`

Command:

```bash
ling-stack task run task_123 --provider provider_local_relay
```

Equivalent to:

```bash
ling-stack run --task task_123 --provider provider_local_relay
```

Execution and storage semantics:

- task and channel are loaded from the CLI `--cwd` workspace,
- runner execution uses the channel `boundPath` when present,
- the `/runs` request sends `workspaceCwd=<--cwd>` and `cwd=<channel.boundPath>`, so run history remains in the Ling Stack workspace while tools operate inside the bound project.

## Run Commands

### `ling-stack run`

Purpose:

- start a run directly or from a task.

Direct prompt mode:

```bash
ling-stack run \
  --cwd . \
  --provider provider_local_relay \
  --title "Inspect repo" \
  "List files and summarize this repo."
```

Task mode:

```bash
ling-stack run --task task_123
```

Options:

```text
--cwd <path>
--task <id>
--title <text>
--provider <providerPresetId>
--tool read
--tool grep
--tool find
--tool ls
--thinking off|minimal|low|medium|high|xhigh
--system-prompt <text>
--append-system-prompt <text>
--skip-preflight
--json
```

Default tools:

```text
read, grep, find, ls
```

Risky tools:

```text
write, edit, bash
```

`write`, `edit`, and `bash` should create approval requests and pause before execution.

Provider preflight:

- CLI defaults to the same provider preflight as daemon product runs.
- `run` and `task run` block if the selected provider preset has no successful saved provider check.
- `--skip-preflight` is an explicit debug flag. The CLI sends `skipProviderPreflight: true` to the daemon so direct daemon enforcement and CLI behavior stay aligned.
- `--skip-preflight` must remain visible in help output and must not bypass approval policy or hard provider compatibility rules.

Output behavior:

- print `runId` when `ready` event arrives,
- stream assistant text,
- show tool calls as compact timeline rows,
- show approval requests prominently,
- print final status and event count.

Example:

```text
Run: run_123
Status: running

[assistant] Reading project files...
[tool read] README.md ok
[tool grep] "POST /runs" ok

Status: succeeded
Events: 12
```

### `ling-stack runs list`

Calls:

```http
GET /runs
```

Note: `GET /runs` is not in the first session persistence design, but CLI needs it for usability. Add it when run history grows beyond direct `GET /runs/:id`.

Columns:

```text
ID | Status | Task | Provider | Started | Ended
```

### `ling-stack runs show <id>`

Calls:

```http
GET /runs/:id
```

Output:

- run metadata,
- task snapshot,
- provider/model,
- status,
- paths to event log and summary.

### `ling-stack runs events <id>`

Calls:

```http
GET /runs/:id/events
```

Options:

```text
--after-seq <number>
--limit <number>
--type <event_type>
--raw
--json
```

Default output should be semantic. `--raw` prints event envelopes.

### `ling-stack runs cancel <id>`

Calls:

```http
POST /runs/:id/cancel
```

If daemon only supports best-effort cancellation, CLI output must say so.

## Approval Commands

### `ling-stack approvals list`

Command:

```bash
ling-stack approvals list --status pending
ling-stack approvals list --status pending --media-job-id media_job_...
```

Calls:

```http
GET /approvals?status=pending
GET /approvals?status=pending&mediaJobId=media_job_...
```

Columns:

```text
ID | Status | Risk | Action | Owner | Title | Created
```

### `ling-stack approvals show <id>`

Calls:

```http
GET /approvals/:id
```

Output must include:

- action type,
- risk,
- command/path/destination,
- diff or preview when available,
- run id,
- task id,
- status.

### `ling-stack approvals approve <id>`

Command:

```bash
ling-stack approvals approve approval_123 --reason "Diff is scoped."
```

Calls:

```http
POST /approvals/:id/approve
```

### `ling-stack approvals deny <id>`

Command:

```bash
ling-stack approvals deny approval_123 --reason "Do not push yet."
```

Calls:

```http
POST /approvals/:id/deny
```

If an approval is critical, the CLI should require an explicit confirmation flag:

```bash
ling-stack approvals approve approval_critical --confirm-critical
```

### `ling-stack policy show`

Purpose:

- inspect the workspace approval policy from terminal.

Calls:

```http
GET /approval-policy?cwd=/path/to/workspace
```

Default output includes workspace id, updated time, a tool decision table, and allowed write paths.

### `ling-stack policy set`

Command:

```bash
ling-stack policy set --tool bash=ask --tool write=deny
ling-stack policy set --write-path . --write-path docs
```

Calls:

```http
PATCH /approval-policy?cwd=/path/to/workspace
```

Request body is partial:

```json
{
  "toolDecisions": {
    "bash": "ask",
    "write": "deny"
  },
  "allowedWritePaths": [".", "docs"]
}
```

`--tool` accepts `allow`, `ask`, or `deny` decisions. `--write-path` entries are stored as policy scopes; relative paths resolve from the run execution `cwd`.

### `ling-stack policy reset`

Purpose:

- restore the default read-only auto-allow policy,
- require approval for `bash`, `edit`, and `write`,
- reset allowed write paths to `["."]`.

## UI Command

### `ling-stack ui`

Purpose:

- open or print the Web UI URL.

Command:

```bash
ling-stack ui
ling-stack ui --open
ling-stack ui --port 5173
```

v0.1 behavior:

- if web dev server is not running, print start command,
- if daemon is not running, print daemon start command,
- if both are running and `--open` is set, open browser.

Do not hide missing server state.

## Config

Local CLI config follows the two-layer model in
[Two-Layer Configuration](two-layer-configuration.md). Workspace config can live in:

```text
.ling-stack/config.json
```

Suggested shape:

```json
{
  "daemonUrl": "http://127.0.0.1:17891",
  "defaultProviderPresetId": "provider_local_relay",
  "defaultChannelId": "engineering",
  "defaultTools": ["read", "grep", "find", "ls"]
}
```

Config precedence:

1. CLI flags,
2. environment variables,
3. workspace `.ling-stack/config.json` or workspace runtime settings,
4. user `~/.ling-stack/config.json`,
5. built-in defaults.

Do not store raw secrets in config.

## Prompt Input

For commands that accept prompts:

```bash
ling-stack run "short prompt"
ling-stack run --prompt-file prompt.md
ling-stack task create --prompt "short prompt"
ling-stack task create --prompt-file prompt.md
```

Rules:

- if both inline prompt and `--prompt-file` are present, return bad CLI usage,
- `--prompt-file -` and `run -` read stdin,
- if positional prompt text is present and stdin is piped, append stdin as a `<stdin>...</stdin>` context block,
- prompt files should be read as UTF-8.

## Streaming Output

The CLI consumes the same SSE event envelope as Web UI.

Mapping:

| Event | CLI output |
| --- | --- |
| `ready` | print run id |
| `run_start` | print status line |
| `assistant_text_delta` | stream text |
| `assistant_thinking_delta` | hidden unless `--verbose` |
| `tool_start` | print tool start row |
| `tool_update` | hidden unless `--verbose` |
| `tool_end` | print tool completion row |
| `approval_requested` | print approval block and command to approve/deny |
| `run_end` | print succeeded |
| `run_error` | print failed with message |
| `result` | print summary |

If stream disconnects after `runId` is known:

- call `GET /runs/:id/events?afterSeq=<lastSeq>`,
- print recovered events,
- report that live stream disconnected if run is still active.

## JSON Output for Runs

For `ling-stack run --json`, do not mix progress text into stdout.

```bash
ling-stack run --json
```

prints JSONL event envelopes, one per line.

This is easier for automation:

```bash
ling-stack run --json "Inspect repo" | jq 'select(.type=="run_error")'
```

## Risky Tool Handling

Default CLI behavior:

- only read-only tools are allowed.

If user requests risky tools:

```bash
ling-stack run --tool bash "Run tests"
```

Expected behavior:

```text
run enters waiting_for_approval
approval request is shown in CLI or Web Approvals
approved request resumes the Pi tool call
denied request returns a blocked tool result before the side effect
```

The CLI must not add a hidden bypass for normal product runs. Any future development-only bypass has to be explicitly labeled and remain outside the default path.


## Module Boundary

The historical implementation grew as a single-file CLI. P0 and P1 split the executable
entrypoint, daemon lifecycle, doctor checks, run I/O and completion metadata into focused
modules. Further extraction should follow ownership pressure rather than old phase numbers.

Implemented P0 file shape:

```text
packages/cli/src/index.ts
packages/cli/src/main.ts
packages/cli/src/daemon/state.ts
packages/cli/src/daemon/process.ts
packages/cli/src/daemon/logs.ts
packages/cli/src/doctor/checks.ts
```

Current extension rule:

```text
packages/cli/src/dispatch.ts
packages/cli/src/args.ts
packages/cli/src/config.ts
packages/cli/src/errors.ts
packages/cli/src/api/client.ts
packages/cli/src/output/table.ts
packages/cli/src/output/json.ts
packages/cli/src/output/errors.ts
packages/cli/src/sse.ts
packages/cli/src/commands/init.ts
packages/cli/src/commands/daemon.ts
packages/cli/src/commands/doctor.ts
packages/cli/src/commands/provider.ts
packages/cli/src/commands/channel.ts
packages/cli/src/commands/task.ts
packages/cli/src/commands/run.ts
packages/cli/src/commands/runs.ts
packages/cli/src/commands/approvals.ts
packages/cli/src/commands/policy.ts
packages/cli/src/commands/external-work.ts
packages/cli/src/commands/ui.ts
```

Avoid a large CLI framework unless argument parsing becomes painful. A small parser is enough for v0.1; add a library later if needed.

## Backend Dependencies

| CLI feature | Required backend |
| --- | --- |
| `daemon status` | `GET /health` |
| provider commands | provider APIs |
| channel commands | channel APIs |
| task commands | task APIs |
| `run` | `POST /runs` |
| `runs show/events` | run read APIs |
| `runs cancel` | cancel API |
| approvals commands | approval APIs |
| policy commands | approval policy API |
| `ui` | Web dev server or packaged web app |

The CLI can ship incrementally as APIs land.

## Test Plan

Unit tests:

- argument parsing,
- config precedence,
- daemon URL resolution,
- prompt file reading,
- output formatting,
- error mapping,
- SSE parsing,
- JSONL output mode.

Command tests with mock daemon:

- `daemon status` handles ok and unreachable daemon,
- `provider add/list/check` calls correct endpoints,
- `run` sends `providerPresetId`,
- `run --skip-preflight` sends `skipProviderPreflight: true`,
- `run --json` emits JSONL only,
- `runs events` paginates,
- `approvals approve/deny` sends reason payload,
- `policy show/set/reset` calls `GET/PATCH /approval-policy`,
- unsafe tools are rejected without explicit flag.

Manual smoke:

```bash
corepack pnpm build
node packages/daemon/dist/cli.js
node packages/cli/dist/index.js daemon status
node packages/cli/dist/index.js provider list
node packages/cli/dist/index.js run --cwd . --provider provider_local_relay "Say hello"
```

## Implementation Checklist

1. Add command router.
2. Add global option parsing.
3. Add config loader.
4. Add daemon API client.
5. Add table and JSON output helpers.
6. Add SSE parser.
7. Implement `daemon status`.
8. Implement `init`.
9. Implement provider commands.
10. Implement direct `run`.
11. Implement `runs show`.
12. Implement `runs events`.
13. Implement approval commands.
14. Implement channel commands after backend APIs land.
15. Implement task commands after backend APIs land.
16. Implement `ui` helper.
17. Add tests with mock daemon.
18. Run `corepack pnpm typecheck`.
19. Run `corepack pnpm build`.
20. Do a manual smoke test.

## Open Decisions

### CLI Framework

Question: should v0.1 use a CLI framework such as Commander or Clipanion?

Recommendation: start small. The current command set is simple enough to parse directly. Add a framework only when nested options and help generation become costly.

### Background Daemon

Question: should `ling-stack daemon start` daemonize in v0.1?

Recommendation: foreground remains the simplest development path, but background lifecycle is now a required CLI hardening follow-up. Implement it with explicit pid/state/log files first; desktop packaging or service-manager integration can come later.

### JSON Run Output

Question: should `ling-stack run --json` output final JSON or JSONL events?

Recommendation: JSONL events only. Runs are streams, automation can consume one event per line, and non-JSON progress belongs on stderr.

### Channel and Task Timing

Question: should CLI channel/task commands be implemented before Web UI?

Recommendation: implement minimal channel/task commands after their daemon APIs exist. Do not make CLI write SQLite directly as a shortcut.

### UI Launcher

Question: should `ling-stack ui` start the web server?

Recommendation: in development, print or run `corepack pnpm --filter @ling-stack/web dev`. In packaged desktop later, it should open the bundled UI.
