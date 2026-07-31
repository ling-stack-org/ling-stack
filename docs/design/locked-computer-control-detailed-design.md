# Lock-Aware Task Continuation Detailed Design

## Status and relationship

**Status:** Accepted and implemented by the existing Desktop/Cua Driver lifecycle, with UI
and regression-test hardening in this change.
**Parent policy:** [Lock-Aware Task Continuation and Computer Control Policy](locked-computer-control-policy.md).
**Supersedes:** the earlier locked-generation authorization design at this path.

## Goals

- Keep the daemon and non-visual Agent work alive across lock/sleep.
- Fence and retire Computer Control before a locked or non-interactive desktop can receive
  new input.
- Recover through a new provider generation after unlock; never reopen the old generation.
- Make the behavior understandable in Settings without exposing an unsafe control.
- Apply the same contract to macOS and Windows while leaving Windows real-machine
  acceptance to the Windows owner.

## What already exists

| Existing component | Reuse decision |
|---|---|
| `DesktopRuntime.observePowerMonitor()` | Keep the four Electron events and serialize them through the existing runtime boundary |
| `DesktopRuntime.suspendComputerControlForSystem()` | Reuse; it targets only the Cua Driver coordinator, not daemon/run lifecycle |
| `DesktopRuntime.resumeComputerControlForSystem()` | Reuse; unlock/resume is a recovery hint |
| `CuaDriverDesktopCoordinator.suspendForSystem()` | Reuse gate close, input fence, lease revoke and generation cleanup |
| `CuaDriverDesktopCoordinator.resumeForSystem()` | Reuse fresh `beginEnable()` and full readiness/lease publication |
| Windows session observer | Reuse `unlock`/`session_active` hints and race handling |
| bundled Computer Control settings page | Replace the locked-control action surface with fixed explanatory rows |
| native feasibility probes | Retain as negative evidence only; never invoke from product lock handling |

No second daemon, provider supervisor, new grant registry, new authentication flow or
renderer mutation API is required. The already-landed compatibility registry remains
packaged `disabled_by_build`; its dormant authorization action is reachable only through
the authenticated Desktop bridge, while the renderer surface is read-only.

## Module boundaries

```text
apps/desktop/main/desktop-runtime.ts
  Owns OS event wiring and keeps daemon lifecycle independent from Computer Control.

apps/desktop/main/cua-driver/coordinator.ts
  Owns provider gate, input fence, lease/process generation retirement and fresh recovery.

apps/desktop/main/cua-driver/provider-host.ts
  Owns the narrow child environment. On macOS it exposes only the fixed system PATH needed
  by upstream 0.8.3 to invoke /usr/sbin/screencapture by basename.

apps/web/src/features/settings/computer-control/
  Projects fixed lock behavior. No command, preference or grant state.

apps/desktop/scripts/*locked-control*
  Attended/native feasibility evidence tooling. Not linked into the lock runtime.
```

The existing `locked-computer-control` contracts and policy modules remain fail-closed for
compatibility with already-landed projections, but Settings cannot invoke their authorization
routes and packaged policy remains `disabled_by_build`. Removing that historical inert
contract is a separate compatibility migration, not required to enforce this policy.

## Runtime state machine

```text
                 lock / suspend / session lost
  READY ------------------------------------------------+
    |                                                    |
    | close gate synchronously                           v
    | fence input -> revoke lease -> stop generation   PAUSED
    |                                                    |
    |             unlock / resume / session active       |
    +<---- fresh readiness + fresh generation + lease ---+

  Any lock during RECOVERING -> close gate -> retire candidate -> PAUSED
  Desktop shutdown from any state -> revoke/stop -> STOPPED
```

`READY` describes Computer Control only. The daemon and Agent run are a parallel lifecycle
and remain alive throughout `PAUSED` and `RECOVERING`.

## Lock and suspend ordering

1. The native/Electron observer enters `DesktopRuntime`.
2. `closeCallGateForSecurityBoundary()` prevents new provider calls before any await.
3. The transition is serialized with existing coordinator work.
4. The provider host receives an input fence when supported.
5. Missing fence acknowledgement triggers immediate termination before normal cleanup.
6. The lease is revoked, proxy closed and current child generation stopped.
7. Projection becomes `interactive_session_required`; requested enable intent is retained.
8. The daemon and active task are not stopped or restarted.
9. If the event arrives while provider enable is still validating, the suspended state is
   latched; any candidate host/proxy is gated and retired before it can remain published.

Repeated lock and suspend events update the reason but cannot create another generation.

## Unlock and resume ordering

1. Desktop tracks lock and sleep as independent boundaries.
2. `resume` while still locked, or `unlock` while still suspended, cannot start recovery.
3. Recovery begins only after both boundaries are clear, then waits for any in-flight
   suspension, disable or crash-recovery cleanup.
4. The old generation remains invalid and cannot be reopened.
5. `beginEnable()` allocates a fresh monotonic generation.
6. Packaged artifact validation, platform permission/readiness, proxy startup and lease
   publication run through the normal path.
7. Calls are admitted only after readiness opens the new gate.
8. A duplicate unlock/session-active hint is ignored after recovery begins.
9. A relock during recovery queues immediate teardown of the candidate generation.

On macOS, Electron's unlock signal provides the hint. On Windows, either Desktop power
events or the authenticated WTS/session observer may provide it; both converge on the same
serialized coordinator.

## Task continuation boundary

`DesktopRuntime.suspendComputerControlForSystem()` never calls
`daemon.stopOwnedDaemon()`, cancels a run, interrupts Shell, or mutates task approvals. A GUI
tool request that arrives after the call gate closes fails/waits according to the existing
Computer Use runtime. Non-GUI task work continues under its original run authority.

Only normal Desktop shutdown/update invokes daemon cleanup. This separation is covered by a
regression assertion on daemon start/stop counters.

## Settings projection

`LockAwareComputerControlSection` has no props and no access to the controller. It renders
three rows:

1. Tasks keep running — status `Continues`.
2. Computer Control pauses — status `Paused while locked`.
3. Control resumes after unlock — status `Automatic`.

The component must not import `Switch`, dialogs, locked projections or Desktop command APIs.
The main Computer Control status can still show `Interactive session required` while locked.

## Native evidence and provider environment

The macOS attended probe uses a disposable AppKit target with an exact PID/window id. It
records content-free booleans and hashes. The retained 26.5.2 arm64 result is:

- same-user session binding: pass;
- exact-window locked capture: pass;
- secure-surface exclusion: pass;
- AX input acknowledgement: fail;
- background pixel input acknowledgement: fail;
- verdict: `unsupported / locked_control_input_unavailable`.

Upstream embedded Cua Driver 0.8.3 invokes `screencapture` by basename. The managed child
environment does not inherit the caller PATH; on macOS it supplies only
`/usr/bin:/bin:/usr/sbin:/sbin`. This is required for normal capture and does not widen the
lock boundary.

## Concurrency invariants

- One suspension/recovery promise owns the transition at a time.
- Requested Computer Control intent survives lock; executable authority does not.
- Generation numbers never go backwards or reopen after retirement.
- Gate closure happens before asynchronous fence/cleanup.
- Lock wins over unlock when the session becomes non-interactive again.
- Sleep-resume and lock-unlock are independent; both must be clear before recovery.
- A boundary raised during initial enable remains latched until that candidate is retired.
- Shutdown wins over all recovery hints.
- Daemon authority is independent from provider generation authority.

## Failure matrix

| Failure | Fail-closed action | User-visible recovery | Test |
|---|---|---|---|
| input fence timeout | kill provider, revoke lease | unlock/recheck | coordinator fence-timeout test |
| lease revoke/proxy cleanup failure | retain cleanup debt, do not start replacement | restart/repair | existing cleanup-debt tests |
| duplicate unlock events | start at most one fresh generation | automatic | session-hint tests |
| relock during fresh enable | tear down candidate generation | wait for next unlock | relock-during-resume test |
| permissions revoked while locked | fresh readiness remains unavailable | grant access after unlock | readiness tests |
| daemon unexpectedly stops on lock | regression failure | none; ship blocked | Desktop runtime daemon counter test |
| renderer tries to enable locked control | mutation route is absent; backend fixed Off | none | daemon API plus static component tests |

No listed failure can silently enable input on a locked/secure surface.

## Test coverage map

```text
OS EVENT -> DESKTOP RUNTIME -> CUA COORDINATOR -> PROVIDER/LEASE
  lock        [★★★]             [★★★] gate first   [★★★] fence + cleanup
  suspend     [★★★]             [★★★] retire       [★★★] no reused lease
  unlock      [★★★]             [★★★] one enable   [★★★] fresh generation
  resume→unlock [★★★]           [★★★] remain gated [★★★] fresh only after both
  lock during enable [★★★]      [★★★] latched stop [★★★] candidate removed
  relock      [★★]              [★★★] queued stop  [★★★] candidate removed

TASK LIFECYCLE                              SETTINGS USER FLOW
  daemon not stopped on lock [★★★]           fixed explanation [★★★ source contract]
  daemon stops on shutdown   [★★★]           no Switch/command  [★★★ source contract]
```

Attended OS probes supplement automated tests; they do not replace them.

## Performance

Lock handling performs bounded local cleanup and no network polling loop. Unlock runs one
normal readiness cycle. Duplicate hints are coalesced, so event storms cannot create
unbounded provider processes or lease publications. No additional background service,
database or renderer polling is introduced.

## Migration from the superseded design

- Remove the persistent `allowLockedComputerUse` preference and its focused writer.
- Remove the renderer Switch, confirmation dialog and set-enabled IPC.
- Revert proposed daemon `userOptIn` state and automatic grant arming.
- Remove renderer `/authorize` and `/revoke`; keep only the read-only projection. Preserve
  the dormant authenticated Desktop mutation path as fail-closed compatibility code.
- Keep packaged `disabled_by_build` and existing fail-closed compatibility contracts.
- Keep the corrected native session probe and negative evidence.
- Keep the system-only PATH fix required by embedded provider 0.8.3.

## NOT in scope

- Positive locked input support on any platform.
- Credential entry or secure desktop automation.
- Removing every historical locked-control contract from public wire schemas.
- New daemon persistence, audit storage or identity verification.
- Windows real-machine acceptance by the macOS owner.

## Unresolved decisions

There are no unresolved decisions. Historical contract removal may be considered only with
a separate compatibility plan.
