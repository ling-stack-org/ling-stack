# CLI v0.1 Design

## Status

Draft for Milestone 6: CLI First Loop.

This design depends on:

- [Session persistence](session-persistence.md)
- [Provider presets](provider-presets.md)
- [Approval policy](approval-policy.md)
- [Web UI v0.1](web-ui-v0.1.md)

The current `packages/cli` package is a placeholder. It prints help and returns `Command not implemented yet` for all real commands.

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
- Shell plugin/autocomplete generation.
- Full TUI.
- Desktop installation.
- Direct bypass of daemon policy.
- Secret storage beyond `env:` references.

## Current Baseline

Implemented today:

```text
ling-stack --help
ling-stack help
```

Not implemented yet:

- daemon start/status helpers,
- init,
- provider commands,
- channel commands,
- task commands,
- run commands,
- approval commands,
- UI launcher.

## Design Principles

- CLI calls daemon APIs instead of duplicating product logic.
- CLI output is readable by default and machine-readable with `--json`.
- CLI never prints raw API keys.
- CLI defaults to safe read-only tools.
- CLI should work before the desktop app exists.
- CLI commands should be stable enough to document in README.
- CLI should expose exact daemon errors instead of hiding them.

## Command Groups

```text
ling-stack init

ling-stack daemon start
ling-stack daemon status
ling-stack daemon stop

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

ling-stack ui
```

Aliases can be added later. v0.1 should prefer explicit commands.

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
4  daemon returned error
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

### `ling-stack daemon start`

Purpose:

- start the local daemon for CLI and Web UI.

Command:

```bash
ling-stack daemon start
ling-stack daemon start --host 127.0.0.1 --port 17891
ling-stack daemon start --foreground
```

v0.1 recommended behavior:

- `--foreground` runs daemon in current terminal.
- without `--foreground`, either start a detached process or print the exact foreground command if detached process management is not implemented yet.

Do not pretend background service management is implemented if it is not.

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

v0.1 note:

This requires process ownership tracking. If not implemented, return a clear message:

```text
Daemon stop is not implemented yet. Stop the foreground process with Ctrl-C.
```

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
  --path /Users/tianxiao/ling-stack \
  --provider provider_local_relay
```

Calls:

```http
POST /channels
```

Default allowed tools:

```text
read, grep, find, ls
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
```

Calls:

```http
GET /approvals?status=pending
```

Columns:

```text
ID | Risk | Action | Run | Title | Created
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

Local CLI config can live in:

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
3. `.ling-stack/config.json`,
4. built-in defaults.

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
- `--prompt-file -` may read stdin later, but not required for v0.1,
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

Options:

1. stream JSONL event envelopes to stdout,
2. or return a final JSON object after run completes.

Recommendation for v0.1:

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


## Module Plan

Recommended files:

```text
packages/cli/src/index.ts
packages/cli/src/commands/init.ts
packages/cli/src/commands/daemon.ts
packages/cli/src/commands/provider.ts
packages/cli/src/commands/channel.ts
packages/cli/src/commands/task.ts
packages/cli/src/commands/run.ts
packages/cli/src/commands/runs.ts
packages/cli/src/commands/approvals.ts
packages/cli/src/commands/ui.ts
packages/cli/src/api/client.ts
packages/cli/src/output/table.ts
packages/cli/src/output/json.ts
packages/cli/src/output/errors.ts
packages/cli/src/sse.ts
packages/cli/src/config.ts
packages/cli/src/args.ts
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
- `run --json` emits JSONL only,
- `runs events` paginates,
- `approvals approve/deny` sends reason payload,
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

Recommendation: foreground first. Background process management is platform-specific and can wait until desktop packaging or a service manager design exists.

### JSON Run Output

Question: should `ling-stack run --json` output final JSON or JSONL events?

Recommendation: JSONL events. Runs are streams, and automation can consume one event per line.

### Channel and Task Timing

Question: should CLI channel/task commands be implemented before Web UI?

Recommendation: implement minimal channel/task commands after their daemon APIs exist. Do not make CLI write SQLite directly as a shortcut.

### UI Launcher

Question: should `ling-stack ui` start the web server?

Recommendation: in development, print or run `corepack pnpm --filter @ling-stack/web dev`. In packaged desktop later, it should open the bundled UI.
