# Lock-Aware Task Continuation and Computer Control Policy

## Status and source of truth

**Status:** Accepted for macOS and Windows Desktop.
**Updated:** 2026-07-31.
**Supersedes:** the fixed always-continue task policy at this same path. It does not restore
the superseded proposal to control the screen while locked.

This document defines two deliberately separate behaviors:

1. whether non-visual Agent work continues while the operating system is locked; and
2. the fixed security boundary that always pauses Computer Control while locked.

## Decision

1. **“Continue running while locked” is a persistent Desktop preference.** It defaults On
   to preserve current behavior on upgrade.
2. **On:** Agent reasoning, Shell, API, file operations and other non-visual work may
   continue while the machine is locked and awake.
3. **Off:** an active run pauses cooperatively at its next safe model/tool boundary. Ling
   does not kill the daemon, cancel the run or interrupt one atomic action already in
   progress. Unlock resumes the same run automatically.
4. **Computer Control always pauses.** The preference never authorizes screen capture,
   pointer/keyboard input, loginwindow, Winlogon, password/PIN/biometric prompts, UAC secure
   desktop, Session 0 or automatic unlock.
5. **Unlock is a recovery hint for Computer Control, not authorization.** Control returns
   only after both lock and suspend boundaries clear and a fresh normal Driver generation
   passes readiness.
6. **There is still no “control while locked” Switch.** The new Switch controls only
   non-visual task continuation.

Confidence is **high** for the embedded Pi runner path and Desktop preference lifecycle.
External opaque runners can be gated before run start, but an already-running external
process cannot provide model/tool safe-boundary callbacks unless that runner implements the
same continuation contract.

The shared implementation and macOS validation are complete. Remaining Windows real-machine validation is a
release acceptance gate, not unfinished product architecture; its evidence belongs in Desktop release artifacts.

## Product behavior

The Computer Control settings page shows:

- a persistent **Continue running while locked** Switch, On by default;
- a fixed **Computer Control pauses** row; and
- a fixed **Control resumes after unlock** row.

Turning the Switch Off while already locked pauses the active embedded run at its next safe
boundary. Turning it On while locked releases waiting non-visual work immediately. Neither
action resumes or authorizes Computer Control.

## State and event semantics

| Event/state | Switch On | Switch Off | Computer Control |
|---|---|---|---|
| unlocked and awake | Run normally | Run normally | Normal requested state |
| `lock-screen` | Continue non-visual work | Pause at next safe boundary | Close gate and retire active generation |
| `suspend` / sleep | OS may suspend processes; Ling does not cancel | Same, and remain cooperatively blocked | Same fail-closed retirement as lock |
| `unlock-screen` while suspended | Follow remaining suspend boundary | Remain blocked | Remain paused |
| `resume` while locked | Follow remaining lock boundary | Remain blocked | Remain paused |
| both boundaries clear | Continue | Resume same run automatically | Fresh normal readiness and generation |
| toggle On while locked | Already allowed | Release waiters immediately | Remain paused |
| toggle Off while locked | Block at next safe boundary | Already blocked | Remain paused |
| Desktop shutdown/update | Normal shutdown semantics | Normal shutdown semantics | Revoke and clean up |

Lock and suspend are independent latched boundaries. Both must clear before the daemon is
published as unlocked and before Computer Control recovery. Duplicate and reordered events
must be idempotent.

## Safe-boundary semantics

For the default embedded Pi runner, the cooperative gate is checked:

- before run/Agent start;
- before each provider/model request; and
- before each tool call.

An already-running single Shell command, API request or file mutation may finish atomically.
The next provider or tool boundary then waits. Cancellation still wins: a waiting run reacts
to its existing abort signal and does not become un-cancellable.

Idle and hard timeout budgets do not accumulate while a run is blocked only by this
preference. Ordinary user cancellation, Desktop shutdown and unrelated runtime failures
retain their existing behavior.

This timeout exemption is per run and starts only when that run actually waits at a safe
boundary. It is not inferred from process-wide gate state. Hard-timeout elapsed time uses a
monotonic clock so wall-clock corrections do not change the run budget.

## Authority and data flow

```text
Settings Renderer
  -> allowlisted main-window IPC
  -> DesktopRuntime
  -> local versioned preference file (default On)
  -> Desktop-bridge-authenticated daemon route
  -> process-wide cooperative continuation gate
  -> embedded Pi model/tool boundaries

OS lock/suspend observer
  -> DesktopRuntime probes the initial OS state, then latches lock/suspend immediately
  -> publishes aggregate locked state to the same daemon gate
  -> independently fences and retires Computer Control
```

The renderer cannot call the daemon mutation route directly. The route accepts only the
Desktop bridge token and the configured workspace. It has no method for authorizing locked
Computer Control.

## Persistence and privacy

- Preference file: `locked-task-continuation-preference.json` under Desktop `userData`.
- Schema v1 stores only `continueWhileLocked: boolean` and defaults On when missing or
  malformed.
- Writes are serialized, atomic and mode `0600` where supported.
- It is intentionally separate from Computer Use preview preferences so whole-object saves
  cannot overwrite each other.
- Daemon state is owned by one ephemeral Desktop instance and renewed as a 15-second lease;
  Desktop releases it on normal shutdown and the daemon expires it after a crash.
- No cloud account, screen data, credentials, raw session identifier or task content is
  stored.
- A save failure keeps the previous preference. A daemon sync failure attempts to restore
  it; if the rollback write itself fails, the newly written file remains authoritative and
  Settings rereads that durable value instead of claiming a false rollback.

## Platform policy

### macOS

- Electron `powerMonitor` supplies lock/suspend/unlock/resume signals.
- Startup reads `IOConsoleLocked` before first daemon publication; an unknown result is
  treated as locked until a real boundary event resolves it.
- The daemon and non-visual run remain owned by Desktop across lock while macOS remains
  awake.
- Accessibility and Screen Recording are rechecked only for fresh unlocked Computer
  Control recovery.
- loginwindow and system authentication surfaces remain outside Ling authority.

### Windows

- Windows x64 uses the same preference and daemon gate contract.
- WTS/session signals converge on the same lock/suspend state and fresh unlocked recovery.
- Startup checks `LogonUI` in Desktop's current session before first publication and uses
  the same unknown-means-locked fallback.
- Winlogon, UAC secure desktop and Session 0 remain denied.
- Windows colleagues own final real-machine acceptance; the shared TypeScript/product path
  is implemented here.

## Show, hide, disable and close semantics

| Condition | Settings surface | Behavior |
|---|---|---|
| packaged macOS/Windows Desktop | Show persistent Switch plus two fixed safety rows | Switch remains available independently of Cua Driver readiness |
| Computer Control Off | Keep section visible | Preference remains independent of normal control On/Off |
| machine locked | Keep saved value; no locked-control action appears | Change takes effect at next safe boundary |
| pure Web / no Desktop capability | Show read-only explanation according to existing page rules | Do not pretend a Web-only Switch was persisted |
| Settings closed or Desktop restarted | No reset | Reload the local saved preference |

## Release gates

- Preference tests cover default, sanitization, atomic persistence and concurrent writes.
- IPC/preload tests prove only the main window can read/write the preference.
- Daemon route tests prove Desktop-token, method, workspace and schema enforcement and no
  Renderer CORS authority.
- Gate tests cover default-open, lock blocking, unlock/toggle release and abort cleanup.
- Runner tests cover Agent, provider and tool boundaries without interrupting tool results.
- Runtime tests cover initial locked startup, dual lock/suspend latches, toggle On while
  locked, durable rollback failure and Desktop lifecycle release.
- Daemon tests cover lease heartbeat ownership, expiry and explicit owner release.
- Timeout regressions prove only a run that actually waits receives idle/hard budget
  suspension and hard-time accounting uses monotonic elapsed time.
- Computer Control regression tests continue proving lock/suspend fences control and does
  not stop the daemon.
- macOS build/typecheck and focused tests pass locally.
- Windows source/build may land before Windows real-machine acceptance.

## NOT in scope

- Screen capture or input while locked.
- Automatic unlock or credential/security-surface interaction.
- A persistent locked-control grant, identity-confirmed locked session or locked tool
  allowlist.
- Interrupting an already-running atomic Shell/API/file action merely because the screen
  locked.
- Making an opaque external runner cooperatively pausable without a boundary callback.
- DLL/native-addon conversion of the embedded Cua Driver.
- Windows ARM64 or Linux Desktop support.

## Unresolved decisions

There are no unresolved decisions for the default embedded runner and Desktop product
scope. Cooperative mid-run pause for third-party opaque runners is a documented extension
boundary, not a release blocker.
