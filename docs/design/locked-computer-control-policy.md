# Governed Locked Computer Control

## Status

Implemented as a fail-closed product foundation; **not enabled on macOS or Windows**. The
shared contracts, Desktop coordinator, daemon grant/audit enforcement, Settings/PiP
projection and native-helper scaffolding now exist, but both packaged policies remain Off.
The current shipped safety baseline remains authoritative until every release gate in this
document passes:

- locking, suspending or losing the interactive session closes the call gate;
- the current provider generation and lease are revoked;
- requested Computer Control intent is retained only for a fresh post-unlock readiness pass;
- **Allow control while locked** remains visible but disabled in Settings.

The native helpers deliberately return negative locked attestation. In addition, the current
provider patch fences one complete mutating tool invocation rather than checking the epoch at
each low-level OS input emission. That is useful fail-closed groundwork, but it does not meet
the no-post-fence-input proof required for enablement. This document therefore does not
declare locked control available on either platform.

Implementation and evidence status:

| Boundary | Current result |
| --- | --- |
| Contracts, validators and packaged disabled policy | Implemented |
| Daemon grant registry, durable metadata audit and pre/post-call policy | Implemented behind fixed Off capability |
| Desktop serialized policy coordinator and authority rotation | Implemented; restricted generation launcher stays disabled |
| Settings authorization/revoke/countdown and PiP visibility | Implemented; production UI resolves to disabled |
| macOS native helper | Source and Apple Silicon build/content-free session probe implemented; attended locked capture/input proof not run |
| Windows native helper | Source, build/sign command and denial handoff implemented; Windows compilation and real-machine acceptance handed off |
| Per-OS-emission provider fence | Not implemented; current fence is mutating tool-call scoped |
| Product enablement | Off on both platforms |

## Decision

Locked Computer Control is one governed capability with four inseparable boundaries:

1. **Policy** decides whether the build, organization, device, run and requested time window
   permit locked operation.
2. **Local identity confirmation** proves that the interactive OS user explicitly armed the
   capability while the computer was unlocked.
3. **Audit** records the grant and every lifecycle transition without collecting screen
   content, keystrokes or biometric material.
4. **Platform security** proves that Ling remains inside the already-authorized user session
   and cannot target a login, credential, elevation or other secure desktop.

Removing any one of these would turn a disabled privacy row into an unsafe global bypass.
The implementation therefore ships them together or keeps the feature Off.

## Public Codex reference and boundary

At fixed public Codex commit
[`88ec932e`](https://github.com/openai/codex/commit/88ec932e96e4d18c5701664e726b1c8b18454af1),
`ComputerUseRequirementsToml` contains the independent requirement
`allow_locked_computer_use: Option<bool>`
([source](https://github.com/openai/codex/blob/88ec932e96e4d18c5701664e726b1c8b18454af1/codex-rs/config/src/config_requirements.rs#L745-L754)).
That proves only that locked-computer use is governed separately from installing Computer
Use. It does **not** publish Codex Desktop's local-authentication UI, runtime enforcement,
platform adapter or audit implementation. Ling adopts the separable-policy principle and
defines its own public contracts without depending on a private Codex API.

## Product outcome

When a platform has passed feasibility and release acceptance, an unlocked user with one
active Computer Use session may choose **Authorize for this task**. Ling performs an OS-owned
local identity check and creates a short-lived, memory-only grant bound to:

- the local OS user and graphical session;
- the Ling installation and signed Desktop build;
- one workspace, run and Computer Use session;
- the current authenticated Desktop/daemon authority tuple;
- the current normal provider generation and the next lock transition;
- a maximum 15-minute expiry.

The grant does not enable Computer Control, add tools, change teammate bindings or approve an
action. Every tool call still passes the existing tool registry, approval policy, activation
revision and lease-generation fences. A call that needs new interactive approval pauses
until unlock; it is never auto-approved because the screen is locked.

On lock, Ling closes the existing call gate before deciding whether locked continuation is
allowed. It also fences provider-local input through a control path independent from the MCP
executor, so an already-dispatched click/type cannot continue behind the closed daemon gate;
missing fence acknowledgement immediately terminates the owned provider. A valid grant and
a fresh platform attestation may then open a new restricted locked generation. On unlock,
Ling closes that generation and consumes the grant. The next lock requires a new local
identity confirmation.

## Why the grant is task-scoped

A persistent global switch would let a stale choice survive a different task, account,
workspace or app version. The Privacy row therefore expresses two different facts:

- **Device capability/policy:** whether this Ling build may offer the feature;
- **Ephemeral authorization:** whether the current task is armed for one lock transition.

The user never stores a permanent blanket approval. Fifteen minutes is a ceiling, not a
guarantee: quit, suspend, user switch, authority rotation, update, provider restart, policy
change or any failed proof revokes the grant earlier.

## Threat model

The design protects against:

- an agent continuing after an accidental lock without explicit prior consent;
- an in-flight input call racing across the unlocked-to-locked boundary;
- a renderer, stale daemon, stale provider process or old grant replaying authority;
- Fast User Switching, Remote Desktop reconnect, Windows Session 0 or input-desktop change;
- a Ling restart/update or provider generation change preserving a stale grant;
- a platform reporting only “locked” without proving which user session remains targeted;
- an action bypassing the existing approval and audit path while locked;
- UI copy claiming support when the platform probe is missing, stale or failed.

Out of scope are a compromised OS kernel, local administrator/root, malicious accessibility
software already trusted by the OS, physical attacks that defeat device security, and
forensic screen/keystroke recording. Ling must not claim protection against those actors.

## Platform security boundary

### Invariants shared by macOS and Windows

Ling must never:

- unlock the machine, type a password/PIN, store login credentials or dismiss a lock screen;
- interact with login, password-change, credential-provider, elevation or secure-attention
  surfaces;
- move control to a different user, graphical session, desktop or remote connection;
- run a privileged service solely to evade the normal interactive-session boundary;
- treat a configuration value, Electron event or cached readiness report as proof that
  capture and input are still possible;
- fall back to an external `cua-driver` executable or a provider outside Ling's signed tuple.

The platform adapter must produce a content-free, generation-fenced capability report that
separately proves capture, input, session continuity and secure-surface exclusion. Unknown is
not supported.

### macOS

- Identity confirmation uses an OS-owned `LocalAuthentication` prompt with device-owner
  authentication. Ling receives only success, cancellation or failure; it receives no
  biometric data or passcode.
- Accessibility and Screen Recording permission remain mandatory but are not sufficient
  proof of locked operation.
- A native probe must demonstrate that the packaged Ling/Cua tuple can capture and inject
  only into the same logged-in Aqua user session after lock, without addressing the
  loginwindow or an authentication UI.
- Apple does not provide a Ling-specific public guarantee that these operations remain
  available while locked. Until the probe and a reviewed OS-version matrix pass, macOS
  reports `probe_required` or `unsupported` and the row stays disabled.

### Windows

- Identity confirmation uses the OS-owned Windows Hello/User Consent Verifier flow. Ling
  receives only the verification result.
- Winlogon, UAC secure desktop, credential UI, Session 0, a non-default input desktop and a
  different WTS session are always denied.
- `SendInput`/UI Automation success on the normal user desktop does not prove that input can
  reach that desktop after Windows switches to Winlogon. The native probe must prove the
  exact supported behavior on the signed `ling-cua-driver.exe` tuple.
- No UIAccess helper, service, scheduled task or credential-provider integration is added by
  this feature. If the standard Medium-IL process cannot satisfy the proof, Windows reports
  `unsupported`; it does not weaken the boundary.
- Windows code is in implementation scope. Real-machine Windows acceptance remains owned by
  the Windows team.

Relevant public platform references:

- [Electron `powerMonitor` lock/unlock events](https://www.electronjs.org/docs/latest/api/power-monitor)
- [Apple LocalAuthentication `evaluatePolicy`](https://developer.apple.com/documentation/localauthentication/lacontext/evaluatepolicy(_:localizedreason:reply:))
- [Windows UserConsentVerifier](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverifier)
- [Windows `OpenInputDesktop`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openinputdesktop)
- [Windows `SendInput` and UIPI](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
- [Windows Session 0 isolation](https://learn.microsoft.com/en-us/windows/win32/services/service-changes-for-windows-vista)

## Authority and data flow

```text
unlocked user -> Settings: Authorize for this task
       |
       v
Desktop verifies: build policy + active run + platform capability
       |
       v
OS-owned local identity prompt
       |
       +-- cancel/fail --------------------------> no grant; audit result only
       |
       v
memory-only task grant + durable metadata audit
       |
       v
OS lock event -> close call gate -> provider-local input fence/kill -> retire generation
       |
       v
fresh session/capture/input/secure-surface attestation
       |
       +-- any unknown/change/failure ------------> revoke; current safe baseline
       |
       v
restricted locked generation -> existing approval/tool execution path
       |
       v
unlock / TTL / quit / suspend / authority change -> close gate -> revoke -> audit
```

Desktop is the authority for OS identity and session evidence. The daemon remains the
authority for run identity, policy evaluation, tool eligibility, approvals and durable
audit. The renderer is only a presentation/controller client. Cua Driver never decides
whether a grant exists.

## Show, hide, disable and close semantics

| Condition or action | Privacy row | User action | Grant/effective behavior |
| --- | --- | --- | --- |
| Packaged bundled Desktop, probe not released | Show disabled: “Not available in this version” | None | Current lock-revokes baseline |
| Platform/build reports `unsupported` or `probe_required` | Show disabled with reason | Recheck only | No grant can be created |
| Organization/device policy forbids it | Show disabled: “Managed by policy” | None | Any grant is revoked |
| Computer Control Off | Show disabled: “Turn on Computer Control first” | None | No grant |
| No active eligible Computer Use session | Show disabled: “Start a task first” | None | No grant |
| Supported, active task, unlocked | Show Off with **Authorize for this task** | Opens explanation and OS identity prompt | Success creates one short-lived grant |
| Grant armed, still unlocked | Show “Authorized · expires in …” plus Revoke | Revoke | No locked tools yet |
| Computer becomes locked | Settings may be inaccessible | No new authorization while locked | Gate closes; only a fresh restricted generation may resume |
| Grant expires or proof changes while locked | Settings inaccessible | None | Gate closes and grant revokes immediately |
| Unlock | Show Off with consumed/revoked status | May authorize again | Fresh normal generation; no automatic re-arm |
| Close Settings or hide Ling window | Hidden with its window | None | Grant remains until its explicit revocation conditions |
| Quit Ling, restart, update or switch account | Closed | None | Grant revokes and does not restore |
| Pure Web, Linux or non-bundled mode | Computer Control page follows existing surface rules | None | No locked-control feature |

Closing Settings is not a security signal and does not silently change consent. Ling must
make an armed grant visible outside Settings through the existing Computer Use preview and
an OS-native notification/status indicator. **Revoke** and **Stop Computer Use** remain
available while the app window is visible. Quitting the app is an explicit hard revoke.

## Audit policy

Ling reuses the existing control-plane/run evidence and Computer Use audit surfaces. It does
not create an unrelated second audit database. Required events are:

- capability evaluated;
- authorization requested, verified, cancelled or failed;
- grant armed, entered locked execution, expired, revoked or consumed;
- gate closed/opened and provider generation rotated;
- action allowed, paused for approval or denied by locked policy;
- recovery to unlocked mode.

Events contain ids, versions, state transitions, reason codes and content-free platform
facts. They must not contain screenshots, raw keystrokes, biometric/passcode data, window
contents or OS authentication secrets. Existing tool-call audit remains authoritative for
the action itself.

## Release gates

A platform may change the Privacy row from disabled only when all are true:

1. Native feasibility probe proves same-user capture and input while excluding secure
   surfaces on every supported OS line.
2. Local identity verification has a signed, fail-closed platform adapter.
3. Policy/grant contracts, generation rotation, audit and UI are implemented together.
4. Lock/unlock/suspend/user-switch/authority-race tests pass, including a disposable native
   target proving no old-epoch input after lock-fence acknowledgement.
5. A packaged coexistence smoke proves no external provider is used or modified.
6. macOS has local packaged acceptance; Windows has Windows-team signed real-machine
   acceptance.
7. A feature flag and immediate rollback path restore the current lock-revokes behavior.

The release verdict is per platform. macOS passing does not enable Windows, and the reverse
is also true.

## NOT in scope

- Unlocking, logging in, entering credentials, controlling loginwindow/Winlogon/UAC or
  bypassing secure attention.
- A persistent global “always allow while locked” preference.
- Authorization that survives app restart, update, OS user switch or more than one lock
  transition.
- Background control without an already-active Computer Use run.
- New provider downloads, new privileged services, DLL/native-addon rewrites of Cua Driver,
  or changing the bundled executable names.
- A general per-application allowlist. Application-scoped enforcement may be added later,
  but locked execution remains bounded by one existing run/session and existing approvals.
- Cloud identity, account password prompts or storing biometric material.

## Unresolved decisions

There are no unresolved product or architecture decisions for implementation planning.
Whether either OS can pass the required native feasibility proof is intentionally an
evidence gate, not a design assumption. Failure means the product remains safely Off on
that platform.
