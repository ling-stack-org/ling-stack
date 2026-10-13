# Expo SDK57 current-source native readiness, 2026-10-09

The [2026-10-10 unsigned-capsule checkpoint](mobile-expo57-unsigned-capsule-checkpoint-2026-10-10.md)
supersedes the pending EXConstants/nested-JSI script boundary below. Preparation
and regression tests now pass; actual native compilation/device acceptance do
not. The rest of this page records the original preparation and exit64 evidence.

## Source and boundaries

This is subsequent acceptance work for the already saved
[Pi/Expo migration](pi1-expo57-migration-checkpoint-2026-10-08.md), not a
second migration. Source is local commit
`c35a3d6b0dfed06cf652ad8119df0760fd7db290` on the E6 continuation branch.
An archive of Mobile and its workspace sources was extracted to a temporary
capsule; the implementation tree and independent writer WIP were not changed.
No signing, provisioning, device installation, App launch or hardware-key test
was performed. No manually paused cloud CI was enabled.

The capsule reuses the installed fixed dependency graph through node_modules
symlinks. It is not a separate OS identity or a guarantee of all-write isolation.
Pod preparation wrote ordinary verified artifact caches in the shared ReactNative
cache. Vendor-generated build caches may also use the linked dependency directory.
These are not application user data, credentials or tracked product-source edits.

## Actual new receipts

| Check | Result |
| --- | --- |
| Initial Mobile manifest/app configuration | Capsule SHA equals current tree |
| iOS autolinking search | exit0; LingSecureDeviceKeyModule points to capsule source; no duplicate module |
| Fixed Expo57.0.27 template | SHA256 a0ce3367faa0029d374a268e6856be4bdec103b0a4031f8172879fd254def44c |
| iOS-only prebuild, no-install | exit0; manifest and app configuration remain unchanged |
| Pod installation | exit0; 103 dependencies, 102 pods, including LingSecureDeviceKey |
| Generated provider | Imports LingSecureDeviceKey |
| Xcode workspace list | exit0; LingMobile and LingSecureDeviceKey schemes present |
| Generic iOS unsigned build-settings request | exit64; target unavailable, no compilation started |

Podfile SHA256 is a8e666e0015f9396d78695195a4a02cf4d40070f0842fbb7a4b68b3ba5300094;
Podfile.lock is 316a65d7ab1fa312d57a05089388ce6ced2a1eb82edd1b1604d4c684016e5a36.
The copied LingSecureDeviceKeyModule.swift source is
e6984e18ed4499446c6ce4cc39a33041ff79a12d5c437936f47fdf3dc0611238.
Raw logs and the redacted target-selection error are in ignored output/e6-20260928.

## Verified failure, not a missing-SDK assumption

The command uses the real workspace/scheme, Debug, iphoneos, generic/platform=iOS,
disableAutomaticPackageResolution and explicit CODE_SIGNING_ALLOWED=NO,
CODE_SIGNING_REQUIRED=NO, empty CODE_SIGN_IDENTITY/DEVELOPMENT_TEAM/profile.
Xcode says the generic destination is ineligible: "iOS 26.5 is not installed.
Please download and install the platform from Xcode > Settings > Components."

A subsequent read-only check nevertheless lists iphoneos26.5 and
iphonesimulator26.5 SDKs, with the iPhoneOS SDK directory present. simctl reports
no installed runtimes. Thus SDK files exist, but the requested destination is
not usable; do not claim absent SDK files or a completed native build. Platform
component diagnosis/installation remains separate from the existing dependency
pairing decision. No platform download or global toolchain switch was performed.

## Build-script boundaries before future compilation

The generated App configure phase used a login shell. Only this capsule phase
was changed to /bin/bash --noprofile --norc; explicit Node22 and non-login outer
commands avoid loading user shell initialization. Generated pbxproj SHA is
13a7002d21f874b8599e1b1e80b64da5c4700b1c8a75643c32086b670159b881.
This is an explicit harness-environment transformation, not a product-code fix.

Read-only review found another EXConstants login-shell phase and a nested
ExpoModulesJSI env-i xcodebuild that does not forward parent signing flags.
It can write vendor Products/DerivedData/SwiftPM/generated caches. Parent-level
NO flags alone therefore do not certify every nested build as unsigned. Before
an actual compile, cover the remaining login shell and nested signing boundary
in an isolated harness and review its resulting scripts. Unread helpers are not
treated as reviewed. No synthetic source/packaging approval row was created.

## Verdict and next gate

Migration and local tests remain passed and saved. Native readiness preparation
above is real new evidence; current-source native compilation and physical-device
acceptance remain incomplete. The current native slice is BLOCKED, not PASS.
Resolve the Xcode destination/component issue and nested build boundary, then
attempt unsigned compilation before separately authorized signing/install and
hardware-key/permission/foreground-background acceptance. The existing macOS
Office source/packaging review and isolated Keychain gates are unchanged.
No SDK57 version-pairing choice remains open; environment/signing authority and
actual build/device evidence still matter. The overall E6 goal remains active.
