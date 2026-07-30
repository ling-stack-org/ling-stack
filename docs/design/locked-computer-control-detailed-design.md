# Governed Locked Computer Control Detailed Design

## Status and source of truth

This document details [Governed Locked Computer Control](locked-computer-control-policy.md).
The fail-closed cross-layer foundation is implemented, but platform enablement is not. Until
a platform passes the feasibility and release gates, runtime behavior remains lock = close
gate, revoke lease/generation, stop provider generation, and recover only after unlock.

Current implementation boundary (2026-07-31):

- shared contracts, daemon policy/registry/routes/audit, Desktop policy coordination,
  Settings/PiP presentation and provider-call pre/post fences are implemented;
- macOS native helper source compiles on Apple Silicon and emits only a content-free session
  summary; Windows helper source plus build/sign/denial handoff is present but not compiled
  or accepted on this macOS host;
- both helpers intentionally return negative locked capture/input attestation;
- the fixed-Off internal macOS DMG/ZIP has been rebuilt and locally verified with the
  embedded `ling-cua-driver`, strict App/provider signatures, matching Team ID, provider
  bundle identifier, hardened runtime and non-production package authority. The dormant
  locked-control helper remains a build/probe artifact until positive platform gates permit
  product staging;
- provider patch `0005-ling-provider-input-fence-v1.patch` holds one epoch permit around a
  complete mutating MCP tool invocation. It does not yet fence each underlying CGEvent,
  `SendInput`, UIA mutation or multi-step emission;
- `DesktopRuntime` publishes `disabled_by_build`, supplies no executable session digest and
  refuses to start a restricted generation. These are deliberate safety gates, not missing
  UI wiring.

## Goals

- Add a short-lived, task-scoped locked-control grant without creating a second Computer
  Use runtime, approval system or audit store.
- Make the renderer incapable of forging identity, platform capability or grant authority.
- Rotate authority at both lock and unlock so no input call crosses the security boundary.
- Keep login, credential, elevation and secure desktops permanently unreachable.
- Implement macOS and Windows contracts together while allowing per-platform release
  verdicts and Windows-team real-machine acceptance.
- Preserve the existing bundled `ling-cua-driver` / `ling-cua-driver.exe` package and
  provider lifecycle.

## What already exists

| Existing boundary | Reuse |
| --- | --- |
| `DesktopRuntime.observePowerMonitor()` | Keep lock/unlock/suspend/resume entry points; route them through a new policy coordinator before selecting suspend or restricted continuation |
| `CuaDriverDesktopCoordinator` generation, child, proxy and lease ownership | Extend with explicit normal/locked execution modes; do not add another provider supervisor |
| Authenticated Desktop bridge tuple and generation/sequence fencing | Carry platform capability and grant state through the same authority |
| Requested/effective bundled activation transaction | Keep provider activation independent from locked authorization |
| Existing run approvals, runtime permission requests and control-plane events | Continue to govern every action and project locked lifecycle metadata into them |
| Computer Use Stop audit and projection | Reuse its id/reason/acknowledgement shape for grant revoke and emergency stop; its bounded process-local audit array is not sufficient for locked-grant durability |
| Settings > Device > Computer Control controller/view model | Add a Privacy view model and narrow Desktop commands; no direct renderer/provider channel |
| Windows session observer and readiness adapter | Extend content-free session/desktop evidence; never infer support from `unlock-screen` alone |
| Darwin permission adapter | Keep TCC checks; add separate local-auth and locked-session probes because TCC is not locked-control proof |

## Module boundaries

```text
packages/contracts
  locked-computer-control.ts        wire types, validators, reason codes only

apps/desktop/main
  locked-computer-control/
    policy-coordinator.ts           serial state machine and grant lifetime
    identity-verifier.ts            platform-neutral interface
    capability-attestor.ts          platform-neutral probe interface
    daemon-client.ts                authenticated daemon projection/audit client
    native-bridge.ts                closed native identity/attestation contracts
    native-helper-bridge.ts         bounded child-process JSON bridge and session parser
    feasibility-probe.ts            non-promotional development evidence validator
  scripts/native/                   LocalAuthentication and UserConsentVerifier/WTS helpers
  desktop-runtime.ts                fixed-Off composition and OS-event delegation
  cua-driver/coordinator.ts         generation mode and restricted lease only

packages/daemon/src/features/computer-use
  locked-control-policy.ts          policy evaluation and action fence
  locked-control-registry.ts        memory authority + existing RunStore/control-plane audit projection
  locked-control-routes.ts          authenticated Desktop and renderer-safe routes

apps/web/src/domains/computer-control
  locked-control-view-model.ts      pure show/disable/copy/countdown projection
  use-computer-control-controller.ts narrow authorize/revoke methods

apps/web/src/features/settings/computer-control
  LockedComputerControlSection.tsx  Privacy row, explanation, confirm/revoke UI
```

The implementation may adjust names to existing conventions, but responsibilities must not
collapse into `desktop-runtime.ts`, `ComputerControlSettingsPage.tsx` or the already-large
provider coordinator. Native bindings may live in an existing Ling native-helper crate if
that is the established build boundary; they must not become renderer-loaded addons.

## Trust and authority model

```text
                         TRUSTED FOR
packaged policy -------- feature ceiling, TTL ceiling, locked tool-policy revision/digest
OS identity API -------- local user-presence result only
Desktop native adapter - OS user/session/desktop/capture/input facts
Desktop coordinator ---- grant secret, expiry timer, lock epoch, provider mode
daemon ----------------- workspace/run/session identity, approvals, tool eligibility, audit
renderer --------------- user intent only
Cua Driver ------------- execution only; no policy or grant authority
```

No single input is enough. Effective locked authority is the intersection:

```text
effectiveLocked = packagedPolicyAllows
               && platformCapability == supported_restricted
               && localIdentityVerified
               && grant.matches(currentAuthorityTuple)
               && grant.matches(activeRunAndComputerUseSession)
               && grant.authorizedNormalGeneration == fencedPreLockGeneration
               && desktopMonotonicNow < desktopGrantDeadline
               && daemonMonotonicNow < daemonGrantDeadline
               && wallClockNow < grant.expiresAt
               && currentLockEpoch == grant.authorizedLockEpoch
               && isCurrentPositiveAttestation(grant, attestation, runtime)
               && existingActivationAndApprovalAllow(action)
```

Every term defaults false when missing or unknown.

## Contracts

The exact TypeScript shapes are illustrative implementation contracts. Runtime validators
must reject unknown enum values, non-canonical timestamps, impossible booleans, oversized
arrays and mismatched platform fields.

### Packaged policy

```ts
interface LockedComputerControlPolicyV1 {
  readonly schemaVersion: 1;
  readonly mode: "disabled" | "task_grant_required";
  readonly maxGrantTtlSeconds: number; // packaged ceiling: 900
  readonly requireLocalUserVerification: true;
  readonly consumeOnUnlock: true;
  readonly suspendRevokes: true;
  readonly lockedToolPolicyRevision: string;
  readonly allowedLockedToolIdsSha256: string;
}
```

This policy is carried inside the signed Ling package/trust policy. A user setting or daemon
database row cannot raise its ceiling. The actual reviewed locked subset lives beside the
existing bundled Cua tool policy in one daemon policy module; its canonical ids are hashed
and must match the package revision/digest before locked mode is eligible. This avoids a
second drifting allowlist while keeping the signed package as the maximum authority. Future
provider tools are denied until both the reviewed table and signed digest are updated.

### Platform capability

```ts
type LockedCapabilityState =
  | "disabled_by_build"
  | "probe_required"
  | "unsupported"
  | "supported_restricted";

interface LockedComputerControlCapabilityV1 {
  readonly schemaVersion: 1;
  readonly platform: "darwin" | "win32";
  readonly state: LockedCapabilityState;
  readonly reason?: LockedControlReasonCode;
  readonly canCaptureSameUserDesktopWhileLocked: boolean;
  readonly canInjectSameUserDesktopWhileLocked: boolean;
  readonly canProveSessionContinuity: boolean;
  readonly secureSurfaceExcluded: boolean;
  readonly adapterVersion: string;
  readonly osVersion: string;
  readonly observedAt: string;
}
```

Only `supported_restricted` with all four booleans true can expose authorization. Static
package metadata can state that the probe exists, but only a fresh Desktop attestation can
state that it passed.

### Local identity result

```ts
interface LockedControlIdentityResultV1 {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly status: "verified" | "cancelled" | "failed" | "unavailable";
  readonly method: "device_owner_authentication" | "windows_user_consent";
  readonly verifiedAt?: string;
  readonly reason?: LockedControlReasonCode;
}
```

No username, biometric type, passcode, credential blob or OS token crosses into the
renderer or daemon. Desktop locally binds a successful result to its current OS session
identity proof.

### Grant authority

```ts
interface LockedComputerControlGrantV1 {
  readonly schemaVersion: 1;
  readonly grantId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
  readonly workspaceCwd: string;
  readonly runId: string;
  readonly computerUseSessionId: string;
  readonly platform: "darwin" | "win32";
  readonly desktopInstanceId: string;
  readonly desktopInstanceEpoch: number;
  readonly daemonAuthorityEpoch: string;
  readonly bridgeConnectionId: string;
  readonly authorizedNormalGeneration: number;
  readonly osSessionBindingDigest: string;
  /** Exactly the coordinator's currentLockEpoch + 1 at arm time. */
  readonly authorizedLockEpoch: number;
  readonly allowedLockedToolIdsDigest: string;
}
```

The full grant is memory-only in Desktop and daemon. Each process converts `ttlSeconds` into
its own monotonic deadline when the grant commits; `expiresAt` exists for UI/audit and is an
additional early-expiry check, never the only authority clock. Durable audit stores
`grantId`, scope ids, timestamps, build/adapter versions and digests, never the bearer
authority or OS credential material. App restart intentionally loses the grant.

### Locked attestation

```ts
interface LockedComputerControlAttestationV1 {
  readonly schemaVersion: 1;
  readonly grantId: string;
  readonly platform: "darwin" | "win32";
  readonly lockEpoch: number;
  readonly sessionBindingDigest: string;
  readonly sameUserSession: boolean;
  readonly userDesktopTargeted: boolean;
  readonly captureReady: boolean;
  readonly inputReady: boolean;
  readonly secureSurfaceExcluded: boolean;
  readonly providerGeneration: number;
  readonly sequence: number;
  readonly observedAt: string;
}
```

Attestation is sent only over the existing authenticated loopback Desktop bridge.
`providerGeneration` is a freshly reserved generation id: reserving it creates no process,
proxy, lease or executable authority. The coordinator starts that exact generation only
after attestation passes. Generation and sequence must be strictly monotonic. A negative
report immediately clears executable authority; it cannot be overwritten by a late positive
report from the same or older sequence.

`isCurrentPositiveAttestation` is one shared daemon predicate used before dispatch and again
before result projection. It requires exact equality for `grantId`, `platform`, `lockEpoch`,
`sessionBindingDigest` and `providerGeneration`; all five proof booleans must be true; the
sequence must equal the latest accepted sequence for that grant/generation; and the
content-free heartbeat must have been received within the monotonic freshness window.
`observedAt` is audit metadata and cannot replace the receiver's monotonic freshness timer.

## Reason codes

Use stable machine-readable codes and map them to localized UI copy:

- `locked_control_disabled_by_build`
- `locked_control_disabled_by_policy`
- `locked_control_probe_required`
- `locked_control_platform_unsupported`
- `locked_control_identity_cancelled`
- `locked_control_identity_failed`
- `locked_control_identity_unavailable`
- `locked_control_no_active_run`
- `locked_control_session_mismatch`
- `locked_control_secure_surface`
- `locked_control_capture_unavailable`
- `locked_control_input_unavailable`
- `locked_control_input_fence_timeout`
- `locked_control_grant_expired`
- `locked_control_grant_consumed`
- `locked_control_authority_rotated`
- `locked_control_suspend`
- `locked_control_user_switched`
- `locked_control_approval_required`
- `locked_control_audit_unavailable`
- `locked_control_commit_unconfirmed`

Logs and UI must not substitute free-form native error strings for these codes. `reason` is
absent on successful `supported_restricted`, `verified`, `armed` and `active_locked` states
and required on every negative, unavailable, paused or failed state. Validators enforce
those state/reason combinations.

## State machine

```text
                         policy/probe unsupported
                     +------------------------------+
                     v                              |
                 UNAVAILABLE                        |
                     | capability becomes supported |
                     v                              |
OFF --authorize--> VERIFYING --cancel/fail--------> OFF
 |                    |
 |                    | verified + active scope
 |                    v
 |                  ARMED --TTL/revoke/authority--> OFF
 |                    |
 |                    | OS lock: close gate first
 |                    v
 |                ATTESTING --unknown/fail---------> REVOKING --> OFF
 |                    |
 |                    | fresh same-session proof
 |                    v
 |               ACTIVE_LOCKED --unlock/suspend/--> REVOKING --> OFF
 |                    |            proof loss
 |                    |
 |                    +-- action needs approval ---> PAUSED_LOCKED
 |                                                  |
 +<------------------------ unlock/revoke -----------+
```

All transitions are serialized by one Desktop policy coordinator. State changes never run
directly in `powerMonitor` listeners, IPC handlers or provider callbacks.

## Authorization flow

1. Renderer requests authorization with no supplied TTL, user id, run id or platform facts.
2. Daemon resolves exactly one active run/Computer Use session in the current workspace and
   creates an expiring pending intent. Zero or multiple active sessions fail closed because
   Settings has no task selector. The intent is not executable authority.
3. Desktop sender-checks the request and snapshots current package policy, intent revision,
   bridge tuple, provider generation, lock epoch, OS session binding and capability.
4. Desktop opens the OS-owned identity prompt only while the session is unlocked and active.
5. On success, Desktop rechecks every snapshot. Any change discards the result.
6. Desktop sends an authenticated prepare request. Daemon rechecks scope/revisions, writes
   the required durable audit and returns one prepared grant id/TTL. Prepared is not armed
   and expires quickly if the flow stops.
7. Desktop installs its memory grant and monotonic deadline, then sends an idempotent commit.
   Daemon installs its memory grant/deadline and projects Armed only if the prepared intent
   is still current. If acknowledgement is indeterminate, Desktop reconciles by request and
   grant id; mismatch revokes local state. Neither partial state can create a locked lease.
8. UI refreshes from daemon projection. It never considers the IPC return itself proof of
   an armed grant.

Double-clicks and concurrent tabs share one single-flight authorization transaction. A
second request receives the current pending/result projection and cannot create a longer or
broader grant.

## Lock transition flow

```text
powerMonitor lock / native session observer
  -> close daemon tool-call gate synchronously
  -> serialize transition and increment lockEpoch
  -> fence new calls and drain/cancel bounded in-flight calls
  -> revoke normal provider lease/generation
  -> evaluate grant against current run/authority/expiry
       no -> current suspend/stop behavior
       yes -> reserve fresh locked generation id (no process/lease yet)
              -> native locked capability attestation bound to reserved id
                fail/unknown -> revoke grant + suspend/stop
                pass -> start the exact reserved restricted generation
                        pass locked provider readiness
                        publish locked lease bound to grant/epoch/attestation
                        daemon intersects locked allowlist + approvals
                        reopen only restricted call gate
```

The normal generation is never reused. This eliminates an ABA race where a call accepted
while unlocked completes after the OS has locked.

In-flight GUI mutation has a short cancellation/drain budget. If acknowledgement does not
arrive within the budget, Ling kills the owned provider generation and records an
unacknowledged transition. Safety wins over preserving the call result.

Closing the daemon gate is not enough for a request already inside `host.exchange()`. The
release target therefore requires a Desktop-owned, one-way input-fence control channel
served by a thread independent from the MCP executor. Every low-level CGEvent/SkyLight,
`SendInput`, UIA mutation and each step of a multi-event sequence must acquire/check the
current input epoch immediately around the OS emission. On lock, the native observer fences
the epoch and acknowledges only after no old-epoch emission is active. If acknowledgement
misses its small hard deadline, Desktop uses retained-handle immediate termination
(`SIGKILL`/Job Object termination) rather than the normal graceful provider shutdown window.

The implemented patch currently closes admission and holds a permit around the complete
mutating tool call in `registry.invoke()`. Its acknowledgement proves that those tool calls
have returned, not that every underlying OS emission independently checked the epoch. Until
that lower-level fence and disposable-target test exist, the restricted generation launcher
must remain disabled even if native feasibility later looks positive.

Acceptance uses a disposable native target with an event log to assert that no input from
the old epoch occurs after the lock fence is acknowledged, including click/type/drag/replay
loops and a deliberately blocked MCP request. The measured lock-event-to-fence-ack interval
is a release gate. OS input already completed before the native lock observer fired is not
misreported as post-lock execution.

## Unlock and recovery

Unlock always closes the restricted gate, revokes the locked lease, stops the locked
provider generation and consumes the grant before normal readiness begins. A fresh normal
generation can become ready using the existing activation transaction. Locked results that
arrive later fail the generation/activation revision checks and cannot update run state.

`resume` after system suspend is not equivalent to unlock continuation. Suspend revokes the
grant; normal post-resume readiness starts with no locked authority.

## Tool and approval enforcement

Daemon evaluates every call in this order:

```text
current provider lease/generation?
  -> activation revision still effective?
  -> if locked: current grant + attestation + allowedLockedToolIds?
  -> existing teammate/run tool scope?
  -> existing approval/risk policy?
  -> provider proxy call
  -> post-result generation + activation + grant + expiry + attestation check
  -> project result or discard as stale
```

- Locked grant never changes `requestedEnabled` or `effectiveEnabled`.
- No approval is synthesized from identity verification.
- If policy requires a new approval while locked, the call becomes
  `locked_control_approval_required` and waits for unlock or expires according to existing
  run semantics.
- Stop, revoke and emergency fencing commands remain available independent of the locked
  tool allowlist.
- A tool result cannot commit after expiry/revoke/unlock even if provider execution finished.

### Initial locked tool policy

The initial `locked-cua-tools-v1` subset is fixed here rather than deferred to
implementation. It is a subset of the existing reviewed bundled `0.8.3` surface:

| Policy | Exact tool ids | Locked behavior |
| --- | --- | --- |
| Allow to reach existing approval policy | `check_permissions`, `health_report`, `get_screen_size`, `get_desktop_state`, `get_window_state`, `get_cursor_position`, `get_accessibility_tree`, `list_apps`, `list_windows`, `page`, `bring_to_front`, `click`, `double_click`, `drag`, `hotkey`, `move_cursor`, `press_key`, `right_click`, `scroll`, `set_value`, `type_text`, `start_session`, `end_session` | Existing read/mutation approval and run scope still decide; a prompt pauses while locked |
| Always deny while locked | `get_config`, `get_agent_cursor_state`, `get_recording_state`, `kill_app`, `launch_app`, `replay_trajectory`, `set_agent_cursor_enabled`, `set_agent_cursor_motion`, `set_agent_cursor_style`, `set_config`, `start_recording`, `stop_recording`, `zoom`, `check_for_update`, `install_ffmpeg` | Return locked-policy denial; unlock is required |
| Unknown/future tool | every id not in the exact allow row | Fail closed until design, daemon policy and signed digest are all reviewed |

“Allow” here means only that the call may continue to the existing approval policy. It does
not make capture or input read-only, auto-approved or available to a run that did not already
have the tool. The canonical sorted allow ids and policy revision are hashed into
`allowedLockedToolIdsSha256`; the package and daemon must agree exactly.

## Platform adapters

### Darwin adapter

Responsibilities:

- call `LocalAuthentication` with device-owner authentication from the Desktop main/native
  boundary;
- compute a non-reversible binding for the console user, audit session and Aqua session;
- observe lock/unlock/session resign/become-active changes in addition to Electron events;
- prove capture readiness without storing a frame;
- prove input delivery to a disposable, Ling-owned test surface during feasibility and to
  the authorized user session during runtime without targeting loginwindow/authentication UI;
- explicitly deny when session ownership or secure-surface exclusion cannot be proven.

The feasibility probe is a development/acceptance executable or native-helper command. It
does not ship as an end-user unlock mechanism and must not automate credentials.

Current Darwin helper status: `LocalAuthentication`, console/Aqua session digest and
lock-state summary are implemented. Attestation remains deliberately negative; the helper
is not wired into a promotable product capability or packaged acceptance claim.

### Win32 adapter

Responsibilities:

- invoke `Windows.Security.Credentials.UI.UserConsentVerifier` from the signed Desktop/native
  boundary;
- bind WTS session id, logon-session identity and input desktop identity without logging raw
  user/account identifiers;
- observe WTS lock/unlock, disconnect/reconnect, logon/logoff and user-switch transitions;
- reject Session 0, Winlogon, `WinSta0\\Winlogon`, UAC secure desktop, non-default input
  desktop and mismatched WTS session;
- prove capture and input behavior for the standard Medium-IL signed tuple;
- remain unsupported rather than introducing UIAccess/service escalation when proof fails.

The Windows implementation and automated fixtures are part of this plan; signed
real-machine acceptance is handed to the Windows team.

Current Win32 helper status: `UserConsentVerifier`, WTS state, logon-session digest and input
desktop checks are implemented in source. The build script can apply a real Authenticode
certificate when supplied; it never fabricates one. The content-free denial harness and
commands live in
[`docs/release/locked-computer-control-windows-handoff.md`](../release/locked-computer-control-windows-handoff.md).
Attestation remains deliberately negative and Windows PASS is not claimed.

## IPC and routes

Renderer-safe Desktop capability adds only intent methods:

```ts
interface LockedComputerControlDesktopCapability {
  authorizeCurrentTask(): Promise<{ accepted: boolean; reason?: string }>;
  revokeCurrentGrant(): Promise<{ accepted: boolean; reason?: string }>;
}
```

The response means the command was handled, not that policy is now effective. UI must
refresh the canonical daemon projection.

Daemon adds:

- a renderer-readable projection nested under the canonical Computer Control setup;
- an authenticated Desktop grant/attestation/revoke route under the existing bridge token;
- no renderer endpoint that accepts identity/session evidence;
- no provider-facing policy route.

All mutations require request ids and expected projection revisions. Authorize and revoke
share one owner fence with existing Computer Control enable/disable/check actions so an Off
transaction cannot race an authorization into existence.

## Projection and persistence

Renderer projection contains only:

```ts
interface LockedComputerControlProjectionV1 {
  readonly schemaVersion: 1;
  readonly capability: LockedCapabilityState;
  readonly phase: "off" | "verifying" | "armed" | "active_locked" | "paused";
  readonly reason?: LockedControlReasonCode;
  readonly grantId?: string;
  readonly runId?: string;
  readonly computerUseSessionId?: string;
  readonly issuedAt?: string;
  readonly expiresAt?: string;
  readonly lockedSince?: string;
  readonly auditId?: string;
}
```

The current grant authority is process memory only. Durable RunStore/control-plane storage
records audit events and a terminal projection for troubleshooting; the bounded in-memory
`ComputerUseProjectionRegistry.stopAudits` array is diagnostic compatibility data, not the
durability boundary. Daemon startup normalizes any non-terminal persisted projection to Off
with reason `locked_control_authority_rotated`.

The database migration is additive and rollback-safe. An older Desktop/daemon ignores the
optional projection and continues the current lock-revokes behavior. A newer daemon paired
with an older Desktop reports `probe_required`, never supported.

## Audit events

| Event | Required metadata | Forbidden payload |
| --- | --- | --- |
| `locked_control_capability_evaluated` | audit id, platform/build/adapter, state, reason, timestamp | frame pixels, window titles |
| `locked_control_authorization_requested` | audit id, intent id, run/session ids, TTL ceiling | identity credential data |
| `locked_control_identity_resolved` | status, method class, reason, timestamp | biometric type/template, passcode |
| `locked_control_grant_armed` | grant id, scope ids, expiry, authority/generation digests | bearer secret |
| `locked_control_entered` | grant id, lock epoch, locked generation, attestation booleans | screenshot/input content |
| `locked_control_action_denied` | tool id, tool-call id, reason, existing approval id when present | raw keystrokes |
| `locked_control_grant_revoked` | trigger, acknowledgement, terminal timestamp | native auth error dump |
| `locked_control_recovered_unlocked` | old/new generation, result | screen content |

Existing persisted tool-call and run events remain the action audit. Locked lifecycle events
are appended through the same RunStore/control-plane path and reference those ids instead of
duplicating tool arguments. The existing Computer Use Stop `auditId` and acknowledgement
shape may be reused, but its process-local registry record cannot satisfy the arm durability
gate.

## Fail-closed matrix

| Failure | Immediate behavior | User-visible result | Recovery |
| --- | --- | --- | --- |
| Capability report absent/stale | Deny authorization | Not available / Recheck | Fresh Desktop probe |
| Identity API unavailable/cancelled | No grant | Verification unavailable/cancelled | Retry while unlocked |
| Run ends before identity returns | Discard success | Task ended | Start/choose active task |
| Lock arrives during verification | Cancel and deny | Authorization not completed | Unlock and retry |
| Normal call active at lock | Close gate; bounded drain then kill generation | Task may pause | Locked re-attestation or unlock |
| Provider input fence does not acknowledge | Immediately terminate retained child/process group; do not enter locked mode | Control stopped for safety | Unlock and start a fresh normal generation |
| Session/user/desktop digest changes | Revoke immediately | Control paused for safety | Unlock/current user readiness |
| Secure surface detected or unknown | Revoke immediately | Secure screen cannot be controlled | Return to normal user desktop |
| Attestation heartbeat missing | Lease expires; gate hidden | Control unavailable | Fresh attestation only |
| Daemon/Desktop restarts | Memory grant lost | Authorization expired | Reauthorize |
| Audit write fails during prepare | Do not arm | Could not authorize safely | Retry after storage recovery |
| Prepare/commit acknowledgement is lost | No locked lease; reconcile idempotently or revoke | Authorization could not be confirmed | Retry while unlocked |
| Audit write fails during emergency revoke | Revoke in memory first; bounded audit retry | Control stopped; audit warning | Durable reconciliation |
| Renderer closes | No policy change | Indicator remains elsewhere | Reopen Settings or Stop |
| OS suspends | Revoke | Authorization expired | Resume, normal readiness, reauthorize |
| Provider/tool unknown to signed allowlist | Deny | Action not allowed while locked | Unlock or update reviewed policy |

## UI detailed behavior

The Privacy section remains on the canonical Computer Control page. It does not become a
generic settings toggle.

1. Disabled states show one sentence explaining build, policy, Computer Control, active-task
   or platform constraints. They do not show a clickable fake switch.
2. Eligible Off state shows **Authorize for this task** and the active task name/id summary.
3. Confirmation dialog states scope, one-lock consumption, maximum expiry, approval behavior
   and permanent secure-surface exclusions before opening OS verification.
4. Armed state shows an absolute expiry plus a live countdown and **Revoke**.
5. Active locked status is also visible in PiP/preview and an OS notification/status item,
   because Settings may be hidden.
6. Unlock shows a terminal “Authorization used”/“Revoked” result, then returns to Off.
7. Deep links into the page keep the existing bundled surface visibility rules.

The countdown is presentation-only. Desktop and daemon independently derive monotonic
deadlines from the committed TTL and also enforce the wall-clock expiry; changing the wall
clock cannot extend a grant.

## Concurrency and ordering

- One serialized Desktop policy queue owns authorize, revoke, lock, unlock, suspend, quit,
  provider restart and bridge-authority change.
- Authorize snapshots a revision and performs compare-and-swap after the async OS prompt.
- Authorize sets `authorizedLockEpoch` to the checked `currentLockEpoch + 1`; overflow or any
  epoch change before grant installation rejects the request.
- Lock closes the call gate synchronously before any async native probe.
- Reserving a locked generation is non-executable. Failure abandons the id permanently; a
  successful attestation may start only that exact id.
- Daemon grant registry keys by workspace + run + Computer Use session and accepts one live
  grant only.
- Generation, activation revision, grant id, lock epoch and attestation sequence are checked
  both before provider dispatch and before result projection.
- Duplicate revoke is idempotent; duplicate arm with the same request id returns the first
  result; a different request cannot extend expiry while one is pending.
- Prepare/commit/reconcile is idempotent by request id + grant id + expected revision.
  Prepared intent is never executable and has a short bounded expiry.

## Performance budgets

Locked policy is not on unrelated MCP or Web requests. For Computer Use calls:

- pre-call locked policy evaluation: p95 under 2 ms, no native call and no database query;
- identity prompt: user-driven and excluded from runtime latency, single-flight;
- lock event to synchronous call-gate closure: target under 10 ms;
- native lock event to provider input-fence acknowledgement: target under 50 ms, hard
  acceptance ceiling 100 ms; timeout takes the immediate-termination path;
- negative attestation to lease removal: target under 100 ms;
- attestation heartbeat: content-free, no faster than once per second, lease expiry no more
  than three missed intervals;
- audit writes batch only non-critical diagnostics; arm must wait for durable audit, revoke
  must execute in memory before durable retry.

## Test design

```text
CONTRACTS
  validators: every valid state + unknown enums + impossible combinations + bounds
       |
       v
DESKTOP POLICY STATE MACHINE
  authorize success/cancel/fail
  double request / stale OS result / lock during prompt
  lock -> close -> provider input fence/kill -> rotate -> attest -> restricted generation
  every revoke trigger / idempotent cleanup / late callback rejection
       |
       v
DAEMON ENFORCEMENT
  route auth + revision CAS + memory grant recovery
  allowlist + activation + approval intersection
  pre-call and post-result stale fences
  durable audit failure behavior
       |
       v
WEB VIEW MODEL / CONTROLLER
  show/hide/disabled matrix + countdown + rapid actions + stale refresh
       |
       v
PACKAGED NATIVE INTEGRATION [E2E]
  macOS local-auth + lock/unlock + same-session proof + secure-surface denial
  Windows Hello + WTS/input desktop + Winlogon/UAC/Session-0 denial
  disposable target proves no old-epoch input after lock-fence acknowledgement
       |
       v
RELEASE ACCEPTANCE
  external provider coexistence + quit/update/restart + Stop + audit export
```

No test may automate or record a real OS password/PIN. Native acceptance uses an attended
test account and OS-owned verification UI. Secure-surface tests assert denial from
content-free desktop/session identity, not interaction with the credential surface.

## Migration, rollout and rollback

1. **Implemented:** contracts and inert capability projection with packaged policy
   `disabled`.
2. **Partially implemented:** native helper/probe scaffolding; attended positive feasibility
   remains open on both platforms. The helper is deliberately not staged into fixed-Off
   product packages.
3. **Implemented:** identity/coordinator/daemon enforcement/audit scaffolding while the
   product flag remains Off.
4. **Implemented:** UI disabled/eligible states and external PiP visibility; production
   builds still resolve to disabled.
5. **Open:** implement per-OS-emission fencing and run macOS attended packaged acceptance.
6. **Handoff ready, execution open:** Windows code/build/sign/denial bundle exists; Windows
   stays Off until Windows-team compile and real-machine acceptance.
7. **Open:** public release remains a separate product decision after every platform gate.

Rollback flips the per-platform locked-control package/feature gate Off. Runtime immediately
revokes any grant and returns to the already-shipped lock-suspend path; it does not need a
database downgrade or Cua Driver replacement.

## NOT in scope

- Automatic unlock, login credentials, loginwindow/Winlogon/UAC/secure desktop control.
- Persistent grants, multiple lock transitions, unattended authorization creation or cloud
  identity confirmation.
- General app allowlist/product UI, UIAccess/service escalation, provider rewrite or a new
  Computer Use runtime.
- Windows ARM64, Linux or pure Web support.
- Windows real-machine sign-off by the macOS implementation owner.

## Unresolved decisions

No architecture decision is unresolved. Native platform feasibility is deliberately a
measured release gate. If a platform cannot prove same-user locked capture and input while
excluding secure surfaces, the correct implementation result is `unsupported`, not another
architecture or a weakened policy.
