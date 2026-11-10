# Startup & Diagnostics Settings Panel

## Status

Status: design approved for implementation
Owner: Web / Daemon / Desktop
Last verified: 2026-10-26

## Background and competitive reference

Every competitor ships a health surface ("something is wrong, here's what to
do"). Ling's settings section `startup-diagnostics` is registered but marked
`pending: true` (`apps/web/src/features/settings/settings-shell-model.ts:96`)
and renders an empty shell; the CLI already has `doctor`, `status`, `logs`.
The information exists — users just cannot reach it, so first-run failures
(daemon not up, port conflict, provider misconfigured) are support black holes.

## Goal

Turn the pending stub into a real panel that answers, in order: Is the daemon
running and healthy? Which subsystems are degraded? What happened recently
(log tail)? And provides one-click actions: restart daemon, open logs,
copy diagnostics bundle.

## Design

### 1. Data: reuse, don't invent

- Daemon health: existing daemon status/control-plane endpoints (CLI `status`
  and `doctor` already consume them). Expose the same payload through the
  api-client (`GET /status` projection already exists for web bootstrap —
  verified via `apps/web` bootstrap flow).
- Subsystem checks: the CLI doctor's check list (workspace registry, keyring,
  provider reachability flag-only, MCP server pings, execution engine
  binaries) is ported into a daemon route
  `GET /diagnostics/doctor` that runs the *same* check modules — single source
  of truth in `packages/core`/daemon, CLI becomes a thin consumer.
- Log tail: bounded `GET /diagnostics/logs?lines=200` reading the daemon log
  file with the existing redaction pipeline (logs contain prompt metadata —
  same redaction rules as run evidence).

### 2. UI: three cards in the pending panel

1. **Daemon health card**: version, uptime, port, state; actions: Restart
   (calls existing restart route; desktop-owned lifecycle honored — on web
   without desktop the card shows the CLI hint instead).
2. **Doctor checks card**: check rows with pass/warn/fail + specific
   remediation text per failure (e.g. keyring unavailable → keychain migration
   hint from existing docs).
3. **Recent diagnostics card**: log tail viewer (monospace, capped, copy
   button) + "copy diagnostics bundle" (JSON of status + doctor + tail, to
   clipboard) for bug reports.

Removes `pending: true` from the section definition and deletes the empty
placeholder branch in `SettingsPage.tsx`.

### 3. Compatibility analysis

| Existing surface | Impact | Handling |
|---|---|---|
| CLI `doctor`/`status` | refactor to shared core | Check modules move to daemon-shared location; CLI output contract unchanged (its tests keep passing) — this is the one intentional refactor. |
| Settings shell | completes | Section id exists; flip `pending`, render panel. Navigation/i18n keys already reserved. |
| Desktop lifecycle ownership | honored | Restart button routes through the desktop bridge when present (same ownership the desktop README defines), otherwise hidden. |
| Run diagnostics panel (`SettingsRunDiagnosticsPanel`) | untouched | That panel is per-run evidence; this panel is system health. Cross-linked, not merged. |

### 4. Incompatible-case upgrade path

`/diagnostics/doctor` response carries `doctorVersion`; unknown check kinds
render as "unchecked" rather than fail. The CLI stays backward compatible by
consuming the same versioned payload.

## Implementation plan

1. Daemon: doctor route (shared check modules), log-tail route (bounded +
   redacted), restart already exists.
2. API client: diagnostics methods.
3. Web: three cards, i18n en-US + zh-CN, remove pending flag and placeholder.
4. Tests: daemon route tests (synthetic failing check → remediation text),
   redaction unit test on log tail, Playwright spec with mocked daemon:
   healthy state, failing keyring check state, log tail render, screenshot
   evidence for both states.

## Acceptance

- Healthy daemon: all checks green with versions (Playwright, screenshot).
- Injected keyring failure: warn state + remediation hint (Playwright,
  screenshot).
- Diagnostics bundle copies valid JSON (unit test); log tail is redacted
  (unit test).
- CLI doctor output unchanged (existing CLI tests green).
