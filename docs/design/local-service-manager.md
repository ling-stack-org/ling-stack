# Local Service Manager

Status: P0 implemented.

## Goal

`ling restart` should be the operator-facing command for restarting the local Ling
Stack development services. Users should not need to know whether the current
machine uses `launchd`, CLI-managed daemon state, pid files, `lsof`, or raw
process kills.

The command is intentionally local-only. It does not restart production services,
remote machines, deployed workers, databases, or external integrations.

## Product Contract

Primary commands:

```bash
ling restart
ling status
ling logs
```

Equivalent long-form commands:

```bash
ling-stack restart
ling-stack status
ling-stack logs
```

Existing lower-level commands remain valid:

```bash
ling-stack daemon restart
ling-stack daemon status
ling-stack daemon logs
ling-stack ui
```

The top-level local stack commands own both daemon and Web UI status. Lower-level
commands keep their narrow scope.

## Restart Semantics

`ling restart` means:

1. Build the daemon package when running from a Ling Stack source checkout.
2. Restart the local daemon service.
3. Restart the local Web UI service.
4. Wait for daemon `/health`.
5. Wait for Web UI HTTP readiness.
6. Print a short result with URLs, manager type, and PIDs.

Runtime safety:

- Restart refuses active daemon work by default when active work can be verified.
- `--force` restarts anyway.
- `--skip-build` skips the local runtime package build step for fast local retries.
- `--timeout <ms>` controls readiness waits.

## Service Manager Detection

P0 supports the current macOS development setup:

```text
com.lingstack.local.daemon
com.lingstack.local.web
```

When both LaunchAgent labels are installed, `ling restart` uses:

```bash
launchctl kickstart -k gui/<uid>/com.lingstack.local.daemon
launchctl kickstart -k gui/<uid>/com.lingstack.local.web
```

The command reads launchd status with:

```bash
launchctl print gui/<uid>/<label>
```

It treats launchd as the source of truth for PIDs and log paths. Local pid files
under `logs/` or `.ling-stack/daemon/` are not trusted for launchd-managed
services because they can drift after external restarts.

If launchd labels are missing, P0 does not silently start an unmanaged Web UI
process. It returns a clear error and points users to lower-level commands. This
avoids creating competing daemon/Web processes on the same ports.

## Canonical Worktree Binding

LaunchAgent-managed development services should bind to the canonical local source
checkout, not to a temporary Git worktree. On this machine the canonical checkout is:

```text
/Users/example/ling-stack
```

Temporary worktrees may be useful for parallel branches, but they should not become the
default daemon/Web service root. If a temporary worktree is used during a merge or smoke
test, the service manager must be restored to the canonical checkout once that checkout is
clean and synced to `origin/main`.

Operational rules:

- LaunchAgent `WorkingDirectory`, stdout path, and stderr path should point at the same
  canonical checkout.
- The Web UI should bind `127.0.0.1:5173` with strict-port behavior so a stale process
  fails clearly instead of drifting to `5174`.
- Before switching the LaunchAgent root, preserve unrelated dirty work with a branch,
  stash, or patch file. Do not reset a user's in-progress work to make the service root
  clean.
- A stale service from another worktree is a service-manager problem, not an application
  readiness success. `ling status` should surface the actual launchd working directory in
  diagnostics.

## Status Semantics

`ling status` reports:

- daemon manager and label,
- daemon PID from launchd when available,
- daemon URL and health status,
- Web UI manager and label,
- Web UI PID from launchd when available,
- Web UI URL and HTTP status.

It exits `0` only when both daemon and Web UI are ready.

## Logs Semantics

`ling logs` reads local service logs without requiring users to remember paths.

Options:

```bash
ling logs --service daemon
ling logs --service web
ling logs --service all
ling logs --lines 200
```

P0 reads launchd stdout/stderr paths when available, with fallback to:

```text
logs/local-daemon.log
logs/local-web.log
```

`--follow` is intentionally not implemented in P0.

## Non-Goals

- No production or remote environment restart.
- No install/uninstall of LaunchAgent plists.
- No background service migration from launchd to another manager.
- No hidden force restart of active work unless `--force` is explicit.

## Follow-Ups

- `ling web restart` for Web-only restarts.
- `ling daemon restart` alias normalization in help output.
- LaunchAgent install/repair commands.
- Cross-platform service manager support.
