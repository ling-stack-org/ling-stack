# macOS Locked Use

This standalone Swift package implements the protected-unlock native subsystem
for Ling. It requires macOS 14 or later. The Desktop product remains disabled
until its native backend, provider and signed package have completed real-machine
acceptance. See the [design and acceptance contract](../../../../docs/design/macos-locked-use.md).

## Build and offline checks

From the repository root, with Node.js and the macOS Swift/Clang toolchain:

```bash
./apps/desktop/native/locked-use/script/build_and_run.sh --verify
corepack pnpm --filter @ling-stack/desktop test:locked-use:mac
```

The first command builds release executables and `.app`/`.bundle` components,
applies ad hoc signatures, verifies the signatures, and runs deterministic policy,
authorization mechanism ABI and live kernel-verifier checks. It runs no system
authorization right, lock request, input interception, permission prompt or service
installation. The Run action in `.codex/environments/environment.toml` invokes it.
`--debug` runs the offline policy checker under LLDB after building.

The second command runs XCTest policy/transport/recovery and Guardian input tests.
It requires a complete Xcode installation with the XCTest SDK. The offline checker
does not substitute for these suites or for real GUI acceptance.

Build a signed component set using an existing signing identity:

```bash
node apps/desktop/scripts/build-locked-use.ts --identity='Developer ID Application: NAME (TEAMID)'
```

`dist/latest.json` names the output directory. `build-manifest.json` contains
artifact hashes and the checks performed. It always records product capability as
`disabled_by_build` and real-machine acceptance as `not_run`. The production
authorization-host verifier requires Developer ID; ad hoc signatures cannot supply
unlock authority.

For a local attended native test, an existing Apple Development identity is
sufficient to build the separate development validation profile:

```bash
node apps/desktop/scripts/build-locked-use.ts --validation-development --identity='Apple Development: NAME (ID)'
```

This profile is selected at compilation, uses the kernel's development signing
category with the same team/runtime/injection checks, and has an isolated Swift
build directory. Its Client accepts only `--validate --preflight` and
`--validate --attended`; it exposes no
Desktop task protocol. The Broker serves only validation, the installer refuses
production installation and promotion, and production manifests/release tools
reject its `development_validation` evidence. The build still performs no
installation or authentication evaluation. A successful identity check does not
establish authorization-host plug-in loading or real lock behavior.

## Components

| Component | Responsibility |
| --- | --- |
| `LingLockBroker` | Root IPC, audit-token/signature checks, one-use permit, lease and recovery fence |
| `LingLockAuth.bundle` | Authorization mechanism; denies without the Broker's current one-use permit |
| `Ling Guardian.app` | All-display shielding, independent watchdog, local input detection and relock |
| `Client.app` | Local identity verification, bounded task-bound JSON transport and external action barrier |
| `LingLockInstaller` | Installation plan, plug-in load test, exact policy backup, promotion and restore |

The JSON client accepts `session`, `status`, `identity`, `begin`, `check`,
`provider-attach`, `action-begin`, `action-end`, `end` and `release-status`.
Only the signed Desktop backend constructs
the grant binding. This protocol is not an approval or capability API for a
renderer. `end` requires provider shutdown proof from its owner before native
quiescence can be acknowledged. The Broker records the provider's kernel token
and code hash and independently watches its exact exit. A provider is registered
before MCP initialization; a lookup PID alone supplies no authority. EOF and
helper death do not establish external provider quiescence.

Protected GUI calls need an explicit process target. `get_window_state` also
requires a window ID; any supplied window must belong to that process and have
layer zero. The target must have a valid Apple-anchored signature and share the
owner's UID/Aqua session. Login, authorization, Ling host and guard processes, secure event
input, desktop-wide capture, foreground delivery, drag and cursor movement are
excluded. Use explicit element indices; opaque element tokens and CDP routing
overrides cannot be used in this mode. Input text stays out of privileged IPC.

## Administrator installation and recovery

These are separate system maintenance operations. Building never performs them.
The installer requires a root-owned staging tree, a matching signed team and a
positive plug-in load test. The staging manifest must match the target architecture,
record the compiled profile's kernel-identity check, and hash the signed Client
executable. Production installation requires the Developer ID profile. The
development validation installer accepts only its matching development manifest
and the `validation` installation mode. Ad hoc manifests are never installable.
Both profiles use the same fixed system namespace and cannot be installed together.
Prepare the intended component set for review before authorizing installation.
Its fixed targets are:

- `/Library/Application Support/LingStack/LockedUse`
- `/Library/Security/SecurityAgentPlugins/LingLockAuth.bundle`
- `/Library/LaunchDaemons/com.lingstack.locked-use.broker.plist`
- Authorization rights `system.login.screensaver` and the Ling remote/load-check rights

The installer command interface is:

```text
LingLockInstaller install <root-owned-component-directory> <console-uid> validation
LingLockInstaller promote
LingLockInstaller validation-report
LingLockInstaller recover
LingLockInstaller reconcile-stopped-guards
LingLockInstaller uninstall
```

`install` backs up the exact existing screensaver rule, tests plug-in loading and
adds an OR branch preserving native authentication. It installs `Client.app` and
`build-manifest.json` with the Broker, Guardian and installer. Public components
are root-owned and readable/executable by the enrolled user; recovery journals
remain private. Desktop independently pins the release-approved manifest digest
and verifies the installed helper's digest, Developer ID, hardened runtime and
empty entitlements before each spawn. This identity check supplies no GUI acceptance.
Interrupted installation keeps
its recovery plan. `recover` restores a matching recorded policy and removes owned
artifacts; it refuses to overwrite concurrent policy changes. `uninstall` first
requires a fully stopped/released lease. `reconcile-stopped-guards` only addresses
missing release acknowledgements after kernel-observed guard exit; it cannot
certify external provider shutdown or restore an unlock permit.

`promote` requires a root Broker validation report matching the OS build and
Broker/Guardian/plugin/Client hashes, observed relock/release and subsequent
manual unlock. Configuration without an accepted Client hash remains unavailable.
`validation-report` only reads the private installed report; it does not acquire
the installation lock or create a staging directory.

If the native client dies while an external provider may still execute input, the
Broker retains the revocation fence and guards until that exact provider exits.
The exit watch and durable journal work independently of the helper. A fresh,
verified observer can confirm root release, but cannot acquire an unlock permit.
A reboot destroys the old GUI session and authorization work and starts a new boot
epoch. Do not remove guards or edit recovery records to manufacture quiescence.

## Attended native validation

After explicit administrator installation in validation mode, run the installed
signed Client from the enrolled user's unlocked Aqua session:

```text
/Library/Application Support/LingStack/LockedUse/Client.app/Contents/MacOS/LingLockedUseClient --validate --preflight
/Library/Application Support/LingStack/LockedUse/Client.app/Contents/MacOS/LingLockedUseClient --validate --attended
```

`--preflight` is read-only and prints structured blockers for the current Aqua
session, Client Accessibility/Screen Recording, Guardian Accessibility/Input
Monitoring, signed components, client approval and installed authentication
rules. It does not contact the Broker or modify system configuration. Guardian
is invoked only to read its permission state. Preflight does not require prior
production promotion; `ready: true` does not enable the Desktop capability.
Run it before `--attended`; a nonzero result means the attended run should not
be started yet.

The Client requires Accessibility and Screen Recording permission. Guardian also
requires its documented Accessibility/Input Monitoring grants. The harness asks
for local identity verification, opens a disposable owned counter window, and
waits for a normal manual lock. It verifies acknowledged AX input, PID-targeted
mouse input, changed ScreenCaptureKit pixels and isolated Keychain records under
the shields. It then verifies observed relock/release and a normal manual unlock,
checks Keychain again, removes the records and records the final native result.
Failures request relock and retry isolated Keychain cleanup after normal unlock;
timeouts or incomplete cleanup never produce final acceptance.

The development validation profile uses this same attended entrypoint, but its
report cannot promote the service or qualify a production release. Uninstall the
validation component set before installing a production component set.

This fixed fixture does not certify the packaged Desktop/Cua provider, physical
screen coverage or the fault matrix. Build and offline checks never invoke it.

## Packaged attended candidate

A production-signed validation candidate exercises Desktop's restricted provider
before final release authority exists. Its separate entrypoint has no ordinary
Desktop startup or renderer. It does not advertise a daemon capability or accept
caller-supplied tools. It captures and presses only its separate signed counter
fixture, observes input acknowledgement and changed decoded window pixels, then
drains the provider, confirms native relock/release and waits for manual unlock.

First complete the production native fixture acceptance and explicitly promote
the installed native service. This native promotion does not supply Desktop
release authority. Prepare a candidate using the exact native component set and
the provider signed by the production Cua pipeline:

```text
node apps/desktop/scripts/prepare-locked-use-validation.ts --components=/absolute/signed-components --provider=/absolute/signed-provider --output=/absolute/fresh-candidate
```

Pass that directory as `LING_LOCKED_USE_VALIDATION_ROOT` to the existing production
Cua packaging command, together with its normal signing and provider inputs.
Do not set `LING_LOCKED_USE_RELEASE_ROOT` for a candidate. The builder pins
`validation-candidate.json`, chooses the separate main entrypoint and preserves
the already signed counter fixture. The signing hook verifies its identity and
hash before exclusion from outer re-signing; the after-sign check verifies it
again alongside the provider. The fixture is neither installed nor granted
authority over other applications.

Run the packaged app's executable directly in the enrolled user's unlocked
session, with the single argument `--validate-locked-use-attended`. Terminal JSON
phases indicate when to lock and unlock manually. Reports and the two fixture PNGs
are written under a fresh `locked-use-validation` directory in the app's data
directory; Chromium uses a separate per-run subdirectory. A passing
`packaged-gui-validation.json` satisfies only the packaged GUI review case. It
retains `productCapability: disabled_by_build`. Cancellation, unknown provider
drainage, missing permissions, unchanged pixels or an unobserved manual unlock
produce no passing report. Neither the build nor the ordinary app launches this
attended run.

Apple Development validation components cannot host an external provider or
qualify a production candidate. They remain usable for the local native attended
fixture described above.

## Release evidence and packaging

Create a fresh review template without producing acceptance:

```bash
corepack pnpm --filter @ling-stack/desktop prepare:locked-use:release --template /absolute/review/checklist.json
```

An identified reviewer records the 19 acceptance cases for the exact OS/native
build and signed provider. Each passing case references a relative evidence file
inside the review directory and its SHA-256. The `packaged_gui_capture_input` case
must reference the candidate's passing JSON report; preparation checks its OS,
native manifest and provider code identity. Once all required evidence exists,
an administrator can run the preparation command:

```text
node apps/desktop/scripts/prepare-locked-use-release.ts --components=/absolute/signed-components --provider=/absolute/accepted-signed-provider --checklist=/absolute/review/checklist.json --output=/absolute/fresh-release-evidence
```

Preparation checks Developer ID/team, hardened runtime, injection entitlements,
the native root report, manifests and evidence hashes. It writes only the new
output directory's `release-authority.json` and `acceptance-provenance.json`.
It does not install components or promote the Broker.

The existing production Cua packaging command consumes that directory through
`LING_LOCKED_USE_RELEASE_ROOT`, alongside its normal signing/provider inputs:

```bash
node apps/desktop/scripts/cua-driver-electron-package.mjs --platform darwin -- --mac dmg zip --arm64
```

The fixed builder configuration adds both resources and their signed metadata
pins while retaining provider seals, signing hooks and ASAR integrity fuses. The
after-sign check requires the packaged provider's accepted code-directory hash,
Developer ID team and runtime/entitlement policy. Other signing lanes reject a
release-evidence directory. Final signed-package acceptance and notarization
remain release operations; preparation does not establish them. Missing accepted
authority or a live supported native status keeps Desktop disabled.

The source and license inventory is in [UPSTREAM.md](UPSTREAM.md) and [LICENSE](LICENSE).
