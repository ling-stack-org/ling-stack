# Lock-Aware Task Continuation and Computer Control Policy

## Status and source of truth

**Status:** Accepted for macOS and Windows Desktop.
**Updated:** 2026-07-31.
**Supersedes:** the earlier Governed Locked Computer Control proposal at this same path.

This document is the product policy for what Ling does when the operating system locks,
sleeps, unlocks or resumes. The policy is intentionally simpler than the superseded design:
Ling keeps non-visual task execution alive, pauses Computer Control at the native boundary,
and restores it only after a fresh unlocked readiness cycle.

## Decision

1. **Tasks continue while locked.** The daemon, active run, Shell, API calls, file work and
   other operations that do not require the interactive desktop remain alive.
2. **Computer Control pauses while locked.** The current provider call gate closes, input is
   fenced, the active provider generation and lease are retired, and no replacement locked
   generation is started.
3. **Unlock is a recovery hint, not authorization.** Ling creates a fresh normal generation
   only after the interactive session, system permissions, packaged artifacts, provider
   readiness and lease publication pass again.
4. **Secure surfaces are never controlled.** Ling does not operate loginwindow, Winlogon,
   password/PIN/biometric prompts, UAC secure desktop, Session 0 or automatic unlock flows.
5. **There is no “control while locked” switch.** This boundary is fixed product behavior,
   not a device preference, task grant or renderer command.

Confidence in this policy is **high**: the existing Desktop and Cua Driver coordinators
already implement the pause/resume lifecycle, and the macOS attended probe showed that
locked input is not delivered on the measured platform cell.

## Product outcome

The user can lock the computer without cancelling a long-running Ling task. If the task
reaches a step that needs GUI interaction, that step waits until the machine is unlocked and
Computer Control becomes ready again. Ling never types into or clicks the lock screen.

The Computer Control settings page explains this fixed behavior:

- Tasks keep running.
- Computer Control pauses.
- Control resumes automatically after unlock and fresh checks.

No authorization button, long-lived Switch, grant countdown or locked-active status is
shown.

## State and event semantics

| Event | Task/daemon | Computer Control | Recovery |
|---|---|---|---|
| `lock-screen` | Continue | Close gate, fence input, revoke lease, stop current provider generation | Wait for unlock |
| `suspend` / sleep | Process may be OS-suspended but is not intentionally cancelled | Same fail-closed retirement as lock | Wait for resume plus unlocked readiness |
| `unlock-screen` | Continue | Still unavailable while sleep/suspend is active or until fresh readiness succeeds | Recover only after suspend is also clear |
| `resume` | Continue | Still unavailable while the session is locked | Recover only after lock is also clear and the session is interactive |
| user/session switch | Continue non-visual work where valid | Stay paused; old session authority is invalid | Require the current interactive session and fresh readiness |
| Desktop shutdown/update | Stop according to normal Desktop lifecycle | Revoke and clean up | Normal next startup |

Duplicate and reordered OS events are expected. Lock and suspend are independent latched
boundaries: both must clear before recovery. `resume -> unlock` and `unlock -> resume` are
equivalent, and neither first event can reopen control alone. Unlock/resume is only a hint
and cannot reopen a retired generation. A lock that arrives during initial enable or later
recovery wins and retires the candidate generation.

## Authority and data flow

```text
macOS powerMonitor / Windows session observer
                  |
                  v
        DesktopRuntime serialized boundary
                  |
        +---------+----------+
        | lock / suspend     | unlock / resume
        v                    v
 close provider gate    mark recovery hinted
 fence input            verify interactive session
 revoke lease           recheck permissions/artifacts
 stop generation        create fresh generation + lease
        |                    |
        +---------+----------+
                  v
       daemon and ordinary task stay alive
```

The renderer has no mutation API that can override this boundary: the daemon exposes only a
read-only locked-state projection to it. Existing dormant compatibility authorization code
is Desktop-bridge authenticated and fixed `disabled_by_build` in packaged policy. Existing
Computer Use approvals continue to apply after recovery; unlocking does not grant or
auto-approve a tool call.

## Platform policy

### macOS

- `powerMonitor` lock/suspend events synchronously close the Computer Control path.
- Accessibility and Screen Recording are rechecked by normal provider readiness after
  unlock.
- The retained macOS 26.5.2 Apple Silicon probe proved same-session exact-window capture but
  not locked input acknowledgement. The result is
  `unsupported / locked_control_input_unavailable` and blocks any locked-control feature.
- loginwindow and system authentication surfaces remain outside Ling's control.

### Windows

- Windows x64 uses the same product behavior: task continues, Computer Control pauses.
- WTS disconnect, Winlogon, UAC secure desktop and Session 0 remain denied.
- Unlock/session-active hints may start fresh normal readiness; they never authorize input
  into Winlogon or reuse the old process/lease generation.
- Windows colleagues own final Windows real-machine acceptance. Positive locked input is no
  longer a release goal.

## Evidence policy

The disposable macOS probe and Windows denial harness are retained as negative security
evidence. They are not product runtime dependencies and cannot enable a feature flag. A
future proposal to control while locked would require a new design, new threat model and
new explicit product approval; editing the retained evidence is not a promotion path.

## Show, hide, disable and close semantics

| Condition | Settings surface | User action |
|---|---|---|
| Bundled Desktop Computer Control page | Show the three fixed lock-behavior rows | None |
| Computer Control Off | Keep the explanation visible | User may enable normal unlocked Computer Control |
| Computer Control waiting for unlock | Status card reports interactive session required | Unlock and recheck |
| Pure Web / external provider / unsupported platform | Follow the existing Computer Control surface rules | No lock-behavior mutation is exposed |

## Audit and privacy

Existing coordinator telemetry may record boundary reason, generation, readiness state and
cleanup outcome. It must not record screen pixels, window content, credentials, raw session
identifiers, passwords, PINs or biometric results. The settings page exposes product
behavior only, never process paths, bearer tokens or native session digests.

## Release gates

- Desktop tests prove lock/suspend calls the Computer Control suspension path.
- Tests prove lock/suspend does not stop or restart the daemon.
- Coordinator tests prove gate closure precedes input fencing and process/lease cleanup.
- Tests prove unlock/session-active creates at most one fresh generation and a relock wins.
- Tests prove reordered resume/unlock events remain gated until both boundaries clear.
- Tests prove a lock during initial provider enable is latched and reasserted.
- Daemon tests prove renderer authorization and revoke routes do not exist.
- The settings section contains no Switch or locked-control mutation command.
- macOS build/typecheck and focused tests pass locally.
- Windows source/build changes may land, but Windows real-machine acceptance remains owned
  by the Windows team.

## NOT in scope

- Controlling the screen while the computer is locked.
- Automatic unlock, password/PIN entry, loginwindow, Winlogon, UAC or secure-desktop input.
- Persistent locked-control preferences, per-task locked grants or a locked tool allowlist.
- Keeping an old provider process, lease or generation alive across lock/unlock.
- Changing ordinary task cancellation, approval or daemon shutdown semantics.
- DLL/native-addon conversion of the embedded Cua Driver.

## Unresolved decisions

There are no unresolved product or implementation decisions for this policy.
