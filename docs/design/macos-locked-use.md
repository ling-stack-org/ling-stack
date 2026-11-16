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
Ad hoc and Apple Development builds can exercise ABI/build tests; the modern
authorization-host verifier requires Developer ID for executable unlock authority.

## Runtime boundary

The Desktop coordinator owns provider generation reservations, fenced retirement,
restricted launch and stop. Native status is content-free and bound to the lease,
session, grant and generation. A native bridge is injected only by a trusted
packaged composition with exact acceptance evidence; environment flags or a
renderer request cannot promote capability. Missing components/evidence retain
`disabled_by_build` or `probe_required`.

Attestation must reflect both native shield health and actual provider
capture/input readiness. A successful build, signature, screenshot, mock or
upstream test alone cannot produce `supported_restricted`. During the managed
unlock the normal generation must stay retired. After native revocation the
provider must be fenced and quiesced before the final native release ACK.

The restricted proxy admits allowlisted `tools/call` requests, initialization,
ping, tool discovery and lifecycle notifications. Other MCP methods are denied.
Closing its admission gate is terminal for that generation; a late readiness
response cannot reopen it or publish an initialization result after revocation.

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
and periodic attestation publication are implemented. The main-window preload
exposes explicit authorization and revocation commands. Their IPC accepts only
the trusted local document's main frame, takes no grant parameters and revokes
authorization if its sender navigates away during local verification. The native
component build and [offline checker](../../apps/desktop/native/locked-use/README.md) perform no
system installation or authorization evaluation. Desktop and daemon retain their
disabled default policies. The current Desktop entrypoint registers no production
backend or visible authorization control.

The Desktop composition accepts a trusted backend with verified helper identity,
exact accepted capability/policy, canonical tool digest and live target-readiness
facts. A fixture can exercise this composition; it does not constitute packaged
acceptance. The release composition must also promote the daemon's disabled policy
through a trusted boot boundary. No environment or renderer switch does this.

The native helper owns the Broker socket while the Cua provider is a separate
process. Only successful provider fence/shutdown followed by explicit native `end`
can acknowledge external quiescence. The Broker is configured to reject helper
process death as drain evidence. If that helper dies first, the Broker retains its
relock fence and guards; automatic recovery needs an independently verified
provider lifetime. That recovery, the attended GUI/Keychain validation producer,
packaged backend/policy registration, authorization UI and step 5 remain open.

The root component-validation record covers OS build and Broker/Guardian/plugin
hashes. Desktop/client/provider identity and readiness require separate packaged
evidence. A root record alone cannot enable the Desktop capability.

The build entrypoint reports policy, negative authorization ABI and kernel task
identity checks separately from XCTest. Complete XCTest requires Xcode's SDK;
Command Line Tools without `XCTest` cannot run it. No offline check certifies real
shield coverage, input isolation, native lock behavior or uninstall/restore on an
installed machine.
