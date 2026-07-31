# Lock-Aware Task Continuation Detailed Design

## Status and relationship

**Status:** Accepted, implemented and locally validated.
**Parent policy:** [Lock-Aware Task Continuation and Computer Control Policy](locked-computer-control-policy.md).

## Goals

- Persist a default-On preference for non-visual task continuation.
- Cooperatively pause the embedded run at safe boundaries when the preference is Off and
  the OS is locked/suspended.
- Resume the same run on unlock without spending idle/hard timeout budget while waiting.
- Keep Computer Control unconditionally fail-closed across lock/suspend.
- Use one shared macOS/Windows contract, with Windows real-machine acceptance handed off.

## Module boundaries

| Module | Responsibility |
|---|---|
| `apps/web/.../LockAwareComputerControlSection.tsx` | Switch state, optimistic UI and rollback feedback; no daemon token or locked-control authority |
| `apps/desktop/shared/desktop-capabilities.ts` | Typed Renderer-to-Desktop preference capability, independent from Cua Driver readiness |
| `apps/desktop/preload/main-window.ts` | Narrow IPC exposure only for validated packaged platforms |
| `apps/desktop/main/ipc.ts` | Main-window sender and boolean validation |
| `apps/desktop/main/locked-task-continuation/preference-store.ts` | v1 sanitize/default and atomic local persistence |
| `apps/desktop/main/locked-task-continuation/daemon-client.ts` | Desktop-token-authenticated state publication |
| `apps/desktop/main/desktop-runtime.ts` | Load-once preference, initial OS lock probe, serialized sync, lease heartbeat and aggregate lock/suspend state |
| `packages/daemon/.../locked-task-continuation-routes.ts` | Private mutation route and workspace/schema validation |
| `packages/daemon/src/runtime/locked-task-continuation.ts` | Process-wide cooperative gate and abortable waiters |
| `packages/daemon/src/features/runs/orchestrator.ts` | Run-start wait and timeout-budget suspension |
| `packages/runner-pi/src/extensions/task-continuation.ts` | Embedded Pi Agent/provider/tool safe boundaries |
| Cua Driver coordinator and locked-control policy | Independent fixed Computer Control fence/recovery |

The task preference does not reuse `desktop-preferences.json`; the preview coordinator
writes that document as a whole. A focused store avoids cross-feature lost updates.

## Preference lifecycle

### Read

1. Desktop Runtime loads once from `userData/locked-task-continuation-preference.json`.
2. Missing, invalid JSON, wrong schema or non-boolean content resolves to schema v1 On.
3. The Renderer requests only `{ continueWhileLocked }` through main-window IPC.
4. After daemon startup/restart, Desktop republishes the loaded preference and current
   aggregate lock state.

### Write

1. Renderer optimistically changes the Switch and disables it while saving.
2. IPC rejects non-main-window senders and non-boolean values.
3. Desktop serializes preference operations.
4. The focused store atomically writes the desired value.
5. Desktop publishes the desired value and current aggregate lock state to the daemon.
6. If the desired file write fails, Desktop keeps the previous value and returns a rejected
   command result.
7. If daemon publication fails after the desired value reached disk, Desktop attempts an
   atomic write of the previous value and best-effort republishes it.
8. If that rollback write also fails, the newly written value remains the durable truth;
   Desktop keeps it in memory and Renderer rereads it instead of showing a false rollback.
9. Renderer reconciles from Desktop after any rejected command and shows inline feedback.

Concurrent writes are ordered by invocation. The final invocation wins both in memory and
on disk.

## Desktop boundary synchronization

Desktop tracks two booleans:

```text
locked = systemSessionLocked || systemSuspended
blocked = locked && !continueWhileLocked
```

On lock/suspend, Desktop latches the boolean before awaiting anything and begins daemon
publication independently of Computer Control suspension. A slow preference read or HTTP
publication cannot delay the native control fence. The returned transition settles after
both paths settle so tests and diagnostics can observe failures.

On unlock/resume, Desktop clears only the matching latch and republishes `locked: false`
only after both latches are clear. Computer Control follows the same dual-boundary rule but
recovers through a fresh generation.

Before the first daemon publication, Desktop probes the current interactive-session state
because Electron may have emitted the lock transition before this process started. macOS
reads `IOConsoleLocked`; Windows checks `LogonUI` in Desktop's current session. An unknown
probe result is treated as locked until a real unlock/resume transition arrives. This is a
fail-closed startup rule for Switch Off, not permission to interact with a lock screen.

## Daemon gate state machine

```text
                     lock && preference Off
  ALLOWED ----------------------------------------------> BLOCKED
     ^                                                       |
     | unlock, resume with both latches clear,                |
     | or preference toggled On                               |
     +-------------------------------------------------------+

  cancellation from BLOCKED -> reject waiter with existing run abort reason
```

The gate owns a monotonic revision and a set of abortable waiters. Repeated identical state
updates do not increment revision. Any transition to allowed releases and unregisters all
waiters.

The private route is:

```text
POST /computer-use/locked-task-continuation/desktop/state
X-Ling-Desktop-Bridge-Token: <Desktop token>

{
  "workspaceCwd": "<configured workspace>",
  "desktopInstanceId": "<ephemeral Desktop owner>",
  "leaseTtlMs": 15000,
  "continueWhileLocked": false,
  "locked": true
}
```

It removes CORS response headers, rejects missing/wrong Desktop authority, rejects methods
other than POST, rejects extra/invalid fields and requires the configured workspace.

State is a Desktop lifecycle lease, not immortal daemon state. Desktop renews the
15-second lease on a 5-second heartbeat and explicitly calls the private `.../release`
route during shutdown. The daemon accepts release only from the current
`desktopInstanceId`. If Desktop crashes or disconnects, lease expiry clears the stale owner
and resets the gate to default allowed/unlocked so an abandoned Desktop cannot strand
future daemon work indefinitely. Each loopback publication has a four-second request
deadline, shorter than the heartbeat interval, so a stalled daemon cannot accumulate an
unbounded queue of renewals or hold shutdown forever.

## Embedded runner safe boundaries

The orchestrator waits once at `run_start`. The embedded Pi resource loader additionally
registers waits at:

1. `before_agent_start`;
2. `before_provider_request`; and
3. `tool_call` before execution.

This produces cooperative semantics:

- an in-flight provider response or atomic tool action finishes;
- the next provider/tool boundary waits;
- no partial file write or force-killed Shell child is introduced by this preference; and
- unlock or toggling On resumes the same runner invocation.

External runner adapters receive the run-start gate through the orchestrator. An external
runner already executing cannot be paused mid-run unless it consumes the optional
`onTaskContinuationBoundary` callback. This limitation is surfaced in design rather than
hidden behind process suspension.

## Timeout and heartbeat behavior

- Idle and hard timeout accounting pauses only when that specific run actually enters
  `waitForTaskContinuation()`. A globally blocked gate does not pause unrelated work that
  has not reached a continuation boundary.
- While a run is actually waiting, idle checks refresh its local activity baseline rather
  than cancelling it.
- Hard timeout uses a monotonic `performance.now()` budget. It subtracts only active
  elapsed time and cannot gain or lose budget when the wall clock jumps.
- The orchestrator records `locked_task_continuation_waiting` and `..._resumed` heartbeat
  events at an actual wait.
- User cancellation and existing abort flows reject the waiter immediately.

The run/status model is not changed to a new public `paused` state in this slice. The run
remains active and cooperative waiting is visible through runtime heartbeat diagnostics.

## Computer Control remains separate

The Cua Driver path still does all of the following on every lock/suspend regardless of the
Switch:

1. close the call gate;
2. fence input;
3. revoke lease and retire the current generation;
4. deny login/security surfaces; and
5. recover only after both system boundaries clear and fresh readiness succeeds.

The new preference has no reference to locked-control grants, capability attestation,
identity verification or a restricted Driver generation. Existing dormant locked-control
compatibility code remains packaged `disabled_by_build` and cannot be reached from the new
Renderer capability.

## UI projection

The section renders:

1. **Continue running while locked** — persistent Switch when Desktop capability exists;
2. **Computer Control pauses** — fixed warning badge; and
3. **Control resumes after unlock** — fixed informational badge.

In pure Web/no Desktop capability mode, it renders read-only managed-by-Desktop guidance
and never pretends a Switch was saved. The Switch capability is exposed independently from
the optional `computerControl` provider capability, so a packaged Desktop can manage task
continuation even while Cua Driver readiness is unavailable. Load failure retains the
explicit default-On copy; after a save/sync rejection Renderer rereads Desktop's durable
truth and falls back to the prior checked state only if that read also fails.

## Concurrency invariants

- One load promise reads the preference; later callers see the current mutable value, not a
  stale initially-resolved object.
- One preference/sync queue preserves publication order across rapid toggles and reordered
  lock events.
- Lock/suspend booleans latch before asynchronous work.
- Initial publication waits for the OS state probe; unknown startup state fails closed.
- One Desktop owner and expiring lease prevent stale external-daemon state from living
  beyond Desktop's lifecycle.
- A task publication failure cannot skip Computer Control suspension.
- Both system boundaries must clear before publishing unlocked.
- Toggle On while locked releases task waiters but never calls Computer Control resume.
- Cancellation removes a waiter and cannot later resurrect a cancelled run.
- Shutdown keeps existing daemon/provider ownership semantics.

## Failure matrix

| Failure | Behavior | User-visible result |
|---|---|---|
| missing/malformed preference | sanitize to default On | Switch shows On |
| atomic file save fails | keep previous preference | inline save error |
| daemon publication fails during toggle | roll back saved/in-memory value and best-effort republish previous | Switch rolls back |
| daemon publication and rollback write both fail | keep the newly persisted value as durable truth | Switch rereads and shows the saved value plus error feedback |
| daemon unavailable during startup | startup/recovery path reports existing daemon failure | no false persisted confirmation |
| initial OS lock probe is unknown | publish locked until an observed boundary resolves state | Off cannot accidentally continue from a false unlocked startup |
| Desktop exits or crashes | explicit release or lease expiry resets the abandoned owner | no permanent daemon block from stale Desktop state |
| loopback daemon request stalls | abort publication before the next heartbeat | bounded queue and shutdown delay |
| lock publication fails | Computer Control still fences; diagnostic records task-sync failure | current daemon state remains conservative only if previously synced |
| cancellation while waiting | abort and remove waiter | normal cancellation result |
| duplicate/reordered OS events | serialized aggregate state | no early resume |
| external opaque runner mid-run | no synthetic process freeze | documented run-start-only limitation |

## Test coverage

- Desktop preference store: default, sanitize, mode, atomic and last-write-wins.
- Desktop client: URL, bridge header, body and response invariant validation.
- Desktop Runtime: load-once/start sync, initial locked probe, Off plus dual boundaries, On
  while locked, durable rollback failure and lifecycle release.
- IPC/preload: main-window authority, boolean validation and capability shape.
- Daemon route: token, method, workspace, CORS and state response.
- Gate: default allowed, block/release, lease expiry/owner release and abort cleanup.
- Embedded runner: all three callbacks and no tool-result suppression.
- Existing Computer Control tests: lock/suspend fence, fresh recovery and daemon lifetime.
- Web source contract: task Switch exists; locked-control commands remain absent.

## Performance

Preference I/O occurs on first read and explicit changes. State publication occurs on
startup/restart, relevant OS boundaries, explicit changes and a low-frequency five-second
lease heartbeat. Gate waiting remains promise-based. Timeout accounting uses the existing
run timer plus monotonic active-time bookkeeping; it adds no busy polling.

## NOT in scope

- Locked-screen capture/input or credentials.
- New public run status/event schemas for `paused_while_locked`.
- Mid-run cooperative pause for an external runner that does not implement callbacks.
- Cross-device/cloud synchronization of this preference.
- Windows real-machine acceptance by the macOS owner.

## Unresolved decisions

There are no unresolved implementation decisions for the embedded Pi product path. A
future third-party runner conformance level may require the optional boundary callback, but
that does not block this slice.
