# Expo SDK57 unsigned JSI QA capsule, 2026-10-10

## Scope and current verdict

This continues the saved [native readiness checkpoint](mobile-expo57-native-readiness-checkpoint-2026-10-09.md)
and [Pi/Expo migration](pi1-expo57-migration-checkpoint-2026-10-08.md), not a
second migration. Only the temporary QA project is transformed. Installed vendor
sources, the product App permissions, credentials, real Keychains, and the
independent delegation-writer WIP are unchanged. No platform installation,
signing, provisioning, device installation or cloud-CI enablement occurred.

Preparation and its regression gates are passed. Native compilation and device
acceptance remain **BLOCKED**, not PASS. The overall E6 goal is still active.

## Implemented boundary

[The preparation helper](../../apps/mobile/scripts/prepare-unsigned-jsi-capsule.mjs)
accepts only a real temporary Ling Mobile capsule with explicit installed JSI
and reviewed React Native roots. It refuses repeat preparation and unexpected
upstream script anchors before rewriting generated consumers.

- EXConstants keeps its actual upstream config helper, capsule `.xcode.env` and
  resource layout. Its login shell is removed; shell and Node preload variables
  are cleared. The existing App configure-phase transformation is retained.
- JSI package-local inputs are copied into the QA project. The nested
  `env -i xcodebuild` receives explicit unsigned CLI settings; parent environment
  flags alone are not the evidence. Device and Simulator SDK/destination behavior
  is preserved. XCFramework consumers all point to the copied package, and
  generated Build-before-Copy ordering is unchanged.
- A receipt records the complete immutable input inventory, hashes, copied
  runner, generated consumers, RN version and Header realpaths/bytes. Drift,
  unreviewed inputs, escaped writable-root links and unsafe generated-path
  characters reject before helper dispatch.
- Generated files are backed up before changes. A generated-consumer write
  failure preserves backups and a `partial` receipt with the exact written paths;
  partial/prepared receipts cannot run. This is not a multi-file transaction or
  protection against unrestricted same-user writers.

The boundary is JSI generated-write relocation and explicit unsigned nested
settings, **not whole-build OS/cache isolation**. The upstream helper still
receives real HOME; no claim is made that Xcode never internally reads Keychain.
The receipt is QA bookkeeping, not an authenticated production approval manifest.

## Regression evidence

[The standard tests](../../apps/mobile/test/unsigned-jsi-capsule.test.mjs) use
installed upstream shell scripts with a synthetic child that always exits 73.
It records actual argv but never creates a fake framework or signs a binary.
Constants tests run the real helper against shallow/deep synthetic bundles.

The initial new failure was an incorrect test expectation, not a weakened guard:
the generated-consumer traversal is sorted. Before the injected debug-xcconfig
write failure, project.pbxproj, the XCFramework input-file list and copy script
had already been written. The corrected assertion requires precisely those
three paths, checks their backups and the failing file's backup, retains the
original failing bytes, and verifies partial refusal and zero child dispatch.
Original failing logs are retained, including full Mobile 46/47 and Node24 12/13.

All receipts below are under ignored output/e6-20260928:

| Gate | Actual terminal result | Raw receipt |
| --- | --- | --- |
| Node22 unsigned preparation focused | 13/13, exit0, no skips/cancels | mobile57-unsigned-jsi-focused-accepted-20261010.tap |
| Node22 Mobile full, includes new focused tests | 47/47, exit0, no skips/cancels | mobile57-unsigned-jsi-mobile-full-accepted-20261010.tap |
| Node24 unsigned preparation focused | 13/13, exit0, no skips/cancels | mobile57-unsigned-jsi-node24-accepted-20261010.tap |
| Real existing capsule verification | ready; 95 immutable inputs, 47 consumers, 3 Headers | mobile57-unsigned-jsi-actual-verification-20261010.json |

Root and an independent read-only reviewer both called the verifier on the
already prepared real capsule; it was not prepared a second time. Root also
verified the installed source bytes and equality of the copied/current runner.
All compilation/signing/installation flags remain false. The exact private
capsule path and preparation receipt remain in ignored output, not this document.

## Real native environment gate remains open

The prior real generic iOS build-settings request ended exit64 with an ineligible
iOS destination. SDK directory presence does not prove a usable destination;
do not relabel this as absent SDK files or a successful compilation.

A new read-only per-command `DEVELOPER_DIR` probe used the documented
`xcodebuild -checkFirstLaunchStatus`, not `-runFirstLaunch`. It ended **exit69**
with empty stdout/stderr, preserved in
`mobile57-native-first-launch-readonly-20261010.log`. The empty log is not success
and does not identify a specific missing component or license requirement.
No initialization, component download, global toolchain switch or device probe
was performed. Native build authority and environment evidence must pass before
actual unsigned compilation; signing/install and device acceptance are separate.

## Next gate and unresolved choices

No SDK57 pairing decision remains open. The dependency migration and saved Pi
SDK/loopback recovery tests are not rerun or treated as new GUI evidence.
Native destination/initialization, actual compilation and current-device receipts
remain incomplete; this helper does not bypass those gates. Fresh macOS packaged
12-case acceptance and Office formal review/isolated-Keychain gates also remain.

The separate Provider external-credential semantics choice and H10 root-budget
choice are still unanswered. This native slice selects neither, enables no
dynamic child and changes no production Provider cache. No remote push, advisory
dismissal, release or overall goal completion is claimed.
