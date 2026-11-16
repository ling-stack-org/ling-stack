# macOS protected Computer Use

## Contract

Locked Use runs GUI actions in the current user's completed Aqua session under
full-display shields. macOS authentication is completed by a signed, non-UI
Authorization Plug-in only after a root Broker consumes a short, single-use
permit. This is a protected temporary unlock. No account password, credential
cache, or reusable unlock token is stored by Ling.

This design extends [lock-aware continuation](locked-computer-control-policy.md)
for an explicitly installed Darwin backend. That policy remains the default for
builds without verified native acceptance, and for Windows/Linux. The
**Continue running while locked** preference remains independent.

## Authority and lifecycle

1. An unlocked local user authorizes the current run and Computer Use session.
   Ling's existing identity verifier, daemon grant, session digest, Desktop
   instance/epoch, bridge authority, lock epoch and provider generation bind the
   authorization. Grants are never a persistent preference.
2. A lock closes normal provider admission synchronously and fences/retires its
   generation. A protected native session is started only for that grant.
3. The installed Broker verifies live audit-token peer identity, signing team,
   signing identifier, hardened runtime and injection entitlements. Guardian
   and watchdog must cover every display and report healthy input interception
   before the authorization mechanism can claim and consume its permit.
4. Guardian requests authentication from the verified Apple loginwindow. It
   clears the unique selected field and submits only a bounded confirmation
   event; it never reads a password. Broker observes the original session
   becoming unlocked before allowing actions. The managed unlock cannot resume
   the normal provider or mint another grant.
5. Only a fresh restricted provider generation may run. Its lease is bound to
   the grant; daemon pre/post action fences and the native action gate must both
   accept it. Revocation closes admission before asynchronous cleanup.
6. Turn completion, TTL, local keyboard/pointer input, sleep, user switch,
   authority rotation, loss of either guard, permission loss or IPC disconnect
   stops actions and relocks. Shields stay until relock/quiescence is observed.
   A failed service restart recovers the durable relock fence; it never restores
   an unlock permit. Manual unlock ends the protected episode.

The native lease has a 300-second ceiling (stricter than the 900-second daemon
grant ceiling), 3-second guard heartbeat limit, 5-second permit and bounded
startup. It uses monotonic uptime. A recovered lease cannot be transferred to a
new Desktop or provider generation.

## Native components and source

`apps/desktop/native/locked-use` is a standalone Swift package. Its Broker,
Guardian/watchdog, installer, peer verification, authorization mechanism and
policy tests derive from the MIT-licensed
[open-computer-use](https://github.com/iFurySt/open-computer-use) Locked Use
subsystem at commit `e25be21caa0ea489316f6be6635d2a4766c4cd0b`.
The package records provenance and its license. Ling uses
`com.lingstack.locked-use.*`, `LingLockAuth.bundle`, and
`/Library/Application Support/LingStack/LockedUse`; it does not trust upstream or
Codex component identifiers. The native code remains separate from Electron and
the bundled Cua Driver.

The administrator installer verifies signed components, enrolls the intended
user/client, records the original `system.login.screensaver` rule in root-owned
storage and performs a separate plug-in load check before attaching an OR branch.
The original native authentication path remains present. Restore compares the
current semantic policy to the recorded installed policy; concurrent policy
changes are not overwritten. Incomplete installation keeps its recovery journal.

Building and testing never installs components or changes authentication rules.
Installation, promotion and removal are separate explicit administrator actions.
The production authorization-host verifier requires Developer ID. An explicit
development validation build instead uses Apple's development validation category
for the attended native fixture. It retains team, live runtime/signature and
injection checks. Only the compiler selects this profile: its Broker refuses
production service, its Client exposes no Desktop task protocol, and its installer
refuses production installation and promotion. Its distinct manifest cannot pass
production installation, release preparation or Desktop's helper verifier. This
permits local development with an existing Apple Development identity without
declaring production capability. Ad hoc builds supply only offline/negative
identity evidence. Neither profile is installed by building it.

## Runtime boundary

The Desktop coordinator owns provider generation reservations, fenced retirement,
restricted launch and stop. Native status is content-free and bound to the lease,
session, grant and generation. A native bridge is injected only by a trusted
packaged composition with exact acceptance evidence; environment flags or a
renderer request cannot promote capability. At startup on packaged Darwin,
`main.ts` reads the optional signed-resource
`locked-use/release-authority.json`. The authority has an exact schema,
`nativeAcceptance: "passed"`, the expected Developer ID team and an independently
approved build-manifest SHA-256. Missing, replaced, malformed or unaccepted
authority leaves the backend absent. The installed component directory cannot
self-promote. The authority's exact bytes must also match the SHA-256 pinned by
`lingLockedUseReleaseAuthoritySha256` in the signed app.asar's `package.json`.
A valid authority still has to pass the installed helper's live
status probe before `supported_restricted` is published.

When the backend is present, the Desktop publishes the content-free capability
and then promotes the canonical daemon policy through the private
Desktop-bridge route. The daemon accepts promotion only for the fixed
task-grant policy, allowlist revision/digest, 900-second ceiling and required
local verification, unlock consumption and suspend revocation. This promotion
does not create a grant. Missing components/evidence retain
`disabled_by_build` or `probe_required`.

Attestation must reflect both native shield health and actual provider
capture/input readiness. The restricted provider is started with action
admission closed. Desktop internally initializes its lazy MCP host using the
fixed client protocol, then reuses the normal live readiness check. The daemon
reattaches to that retained session without initializing a second child. The
live readiness snapshot and native status are checked first, then the daemon
attestation is accepted, and only then is action admission opened.
A successful build, signature, screenshot, mock or upstream test
alone cannot produce `supported_restricted`. During the managed unlock the
normal generation must stay retired. After native revocation the provider must
be fenced and quiesced before the final native release ACK.

The restricted proxy admits allowlisted `tools/call` requests, initialization,
ping, tool discovery and lifecycle notifications. Other MCP methods are denied.
Closing its admission gate is terminal for that generation; a late readiness
response cannot reopen it or publish an initialization result after revocation.

Protected capture uses `get_window_state` with an explicit PID and window ID.
Input must name a PID; a supplied window must belong to it and have layer zero.
The native gate verifies the signed target's user and Aqua audit session, excludes
loginwindow, authorization UI, screensavers, the Ling host and its guards, and rejects secure
event input. It retains the target's kernel token and code hash across the action
and revalidates them before accepting completion. PID reuse cannot transfer that
action. Tool name, PID and window ID are the only target fields in privileged IPC;
input text, selectors and page content stay in the provider protocol.

Desktop-wide capture, windowless input, foreground delivery, drag and cursor
movement are unavailable in protected mode. Opaque element tokens and CDP routing
overrides are excluded because they can select another window; explicit element
indices remain available. Application/window discovery returns metadata, and
`list_windows` requires a PID filter. These argument restrictions apply in addition
to the shared tool allowlist and ordinary tool approvals.

## Implementation plan and acceptance

1. Import the bounded native subsystem with Ling identity and license; build the
   standalone targets, authorization bundle and ABI tests without system writes.
2. Add a content-free native client and TypeScript bridge with bounded framing,
   request IDs, session/grant/generation binding, cancellation and disconnect.
3. Add reserved restricted generation lifecycle at the Desktop coordinator;
   retain default denial until a trusted backend supplies positive evidence.
4. Exercise native state/permit/recovery/policy tests and TypeScript authority,
   generation and cancellation boundaries, plus owning package typechecks.
5. Administrator-installed, exact-build acceptance: cold plug-in load, locked
   GUI capture and acknowledged input, all-display shields, physical input
   takeover, turn end/TTL, sleep/wake, user switch, guard/Broker/provider death,
   component replacement, display hotplug and uninstall/restore. Retain separate
   reports for source tests, local signing and packaged/real lock behavior.

Product capability remains unavailable until step 5 is recorded for the current
OS build and signed components. Private macOS session/lock behavior and the
authorization host remain compatibility risks requiring real-machine acceptance.

## Implementation boundary

The standalone native targets, authorization bundle, installer/restore commands,
task-bound JSON client, Desktop restricted-generation composition, action gates
and periodic attestation publication are implemented. The packaged entrypoint
now performs the release-authority lookup and passes a verified backend into
`DesktopRuntime`; ordinary development packages and packages without the
authority remain disabled. The main-window preload
exposes explicit authorization and revocation commands. Their IPC accepts only
the trusted local document's main frame, takes no grant parameters and revokes
authorization if its sender navigates away during local verification. The native
component build and [offline checker](../../apps/desktop/native/locked-use/README.md) perform no
system installation or authorization evaluation. Desktop and daemon retain their
disabled default policies unless the signed release authority and live native
probe both pass; there is still no renderer-controlled promotion or visible
authorization control in ordinary builds.

The Desktop composition accepts a trusted backend with verified helper identity,
exact accepted capability/policy, canonical tool digest and live target-readiness
facts. A fixture can exercise this composition; it does not constitute packaged
acceptance. The release composition must also promote the daemon's disabled policy
through a trusted boot boundary. No environment or renderer switch does this.

The installed helper is fixed at `Client.app/Contents/MacOS/LingLockedUseClient`
under the administrator-owned component directory. The installer retains its
build manifest beside it. A native-client factory pins the release-approved
manifest digest, checks root ownership and non-writable ancestry, verifies the
helper's SHA-256 and Developer ID requirement, and rejects injection entitlements.
These checks run before each helper spawn. Neither an installed manifest nor a
verified helper declares capture/input acceptance or promotes the daemon policy.

### Provider lifetime and recovery

The native helper owns the Broker socket while Cua remains a direct Desktop child
to preserve its TCC responsibility chain. Restricted children watch the helper's
actual PID with their existing kernel exit watcher. Desktop registers the child
before sending MCP initialization. Registration supplies a lookup PID, never an
identity: the Broker obtains the kernel audit token (including PID version),
checks the enrolled user's audit session, Developer ID team, fixed provider
identifier, hardened runtime and injection entitlements, and installs an exact
process-exit watch with identity checks on both sides of registration.

The Broker retains the full task binding and a monotonic deadline. Readiness
checks carry no external action authority. External action begin/end operations
require that binding and the registered live child; a lease cannot attach a
second child or generation. The root recovery journal persists registration
before replying. After provider exit, or helper exit before any child has been
registered, the Broker can establish external quiescence independently. Helper
exit with a live registered provider waits for that exact provider's exit. Socket
closure alone never proves process exit. No root process termination is performed
using a client-supplied PID.

A Broker restart restores only a revocation fence. It reattaches the exit watch
to the exact recorded token, or recognizes that the original process has exited
when its PID is absent or belongs to a different token. Unavailable identity
inspection retains the shields. Legacy journals without task/provider state keep
their conservative explicit-drain requirement. A process which was spawned but
never registered cannot obtain an action admission, including after helper death
or a late initialization response. Guard release additionally requires drained
unlock work and observed relock; provider exit alone never releases guards.

### Attended validation and release

The installed signed client has a separate, explicit attended validation mode.
It uses a disposable AppKit window, AX acknowledgement, ScreenCaptureKit pixels
and isolated Keychain items, then records evidence through its authenticated
Broker connection. It waits for a normal manual unlock and retries Keychain
cleanup before recording the final phase. It does not inspect user windows or
Keychain records. Running the build does not run attended validation.

`prepare-locked-use-release.ts` verifies the exact native manifest, root validation
record, provider identity and the named reviewer's 19-case physical-screen/fault
checklist. Each passing case names an evidence file and its SHA-256. Templates
contain only `not_run` results. Preparation reads the installed report through
the signed installer's read-only `validation-report` command; it neither installs
nor promotes the service.

The resulting authority and acceptance-provenance resources enter the existing
production Cua signing pipeline via the build-only `LING_LOCKED_USE_RELEASE_ROOT`
input. The fixed builder configuration retains its provider seals and ASAR
integrity fuses and pins both resources in package metadata. After signing, it
compares the packaged provider's Developer ID, runtime flags, injection
entitlements and code-directory hash with the accepted code. Signing timestamps
may change file bytes; different executable code fails the package check. No
runtime environment input enables this backend. Source tests or fixtures cannot
generate acceptance by themselves. Ordinary builds contain no accepted release
authority. The complete real-machine matrix in step 5 remains required for the
exact OS and signed build.

The root component-validation record covers OS build and Broker/Guardian/plugin/
Client hashes, and binds the reporting Client's kernel token and code hash.
Promotion configuration retains the Client hash; legacy configuration without it
requires fresh acceptance. Desktop/provider identity and readiness require separate
packaged evidence. A root record alone cannot enable the Desktop capability.

The first packaged integration candidate still needs an attended bootstrap path
that exercises the packaged Desktop/provider without declaring ordinary product
acceptance. Release preparation currently validates completed evidence; it does
not create that path. Native fixture acceptance and offline composition tests do
not satisfy the packaged GUI case. Until the candidate path and its real-machine
matrix are complete, the end-to-end product target remains unfinished.

The build entrypoint reports policy, negative authorization ABI and kernel task
identity checks separately from XCTest. Complete XCTest requires Xcode's SDK;
Command Line Tools without `XCTest` cannot run it. No offline check certifies real
shield coverage, input isolation, native lock behavior or uninstall/restore on an
installed machine.
