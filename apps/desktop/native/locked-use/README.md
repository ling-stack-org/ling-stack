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
`disabled_by_build` and real-machine acceptance as `not_run`. Apple Development and
ad hoc builds cannot satisfy the modern authorization-host Developer ID check.

## Components

| Component | Responsibility |
| --- | --- |
| `LingLockBroker` | Root IPC, audit-token/signature checks, one-use permit, lease and recovery fence |
| `LingLockAuth.bundle` | Authorization mechanism; denies without the Broker's current one-use permit |
| `Ling Guardian.app` | All-display shielding, independent watchdog, local input detection and relock |
| `Client.app` | Local identity verification, bounded task-bound JSON transport and external action barrier |
| `LingLockInstaller` | Installation plan, plug-in load test, exact policy backup, promotion and restore |

The JSON client accepts `session`, `status`, `identity`, `begin`, `check`,
`action-begin`, `action-end` and `end`. Only the signed Desktop backend constructs
the grant binding. This protocol is not an approval or capability API for a
renderer. `end` requires provider shutdown proof from its owner before native
quiescence can be acknowledged. EOF and helper death do not establish external
provider quiescence.

## Administrator installation and recovery

These are separate system maintenance operations. Building never performs them.
The installer requires a root-owned staging tree, a matching signed team and a
positive plug-in load test. The staging manifest must match the target architecture,
record the Developer ID kernel-identity check, and hash the signed Client executable.
Ad hoc or development-only manifests cannot be installed. Prepare the intended component set for review before
authorizing installation. Its fixed targets are:

- `/Library/Application Support/LingStack/LockedUse`
- `/Library/Security/SecurityAgentPlugins/LingLockAuth.bundle`
- `/Library/LaunchDaemons/com.lingstack.locked-use.broker.plist`
- Authorization rights `system.login.screensaver` and the Ling remote/load-check rights

The installer command interface is:

```text
LingLockInstaller install <root-owned-component-directory> <console-uid> validation
LingLockInstaller promote
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
Broker/Guardian/plugin hashes, observed relock/release and subsequent manual
unlock. The Desktop JSON client does not produce a GUI/Keychain validation report;
the attended provider validation harness and accepted packaged release authority
remain release prerequisites. The packaged backend is present but stays disabled
without that authority and a live supported native status. Production installation
without matching evidence stays unavailable.

If the native client dies while an external provider may still execute input, the
Broker retains the revocation fence and guards. Automated recovery from this case
requires an independently verified provider lifetime; it remains a release blocker.
A reboot destroys the old GUI session and authorization work and starts a new boot
epoch. Do not remove guards or edit recovery records to manufacture quiescence.

The source and license inventory is in [UPSTREAM.md](UPSTREAM.md) and [LICENSE](LICENSE).
