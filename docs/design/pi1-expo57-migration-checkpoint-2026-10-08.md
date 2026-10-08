# Pi 1.1 / Expo 57 migration checkpoint, 2026-10-08

## User scope and base

The user explicitly requested integrating the security refresh and both migration
lanes with the existing E6 goal. Work remains on `codex/e6-safe-continuation` in
the dedicated E6 tree. Do not change the root checkout or another task's WIP.
Save separate commits so the two dependency migrations remain independently
reviewable/revertible. Do not automatically enable the manually paused cloud CI.

Main/#521 was verified through live GitHub API and a successful bounded HTTP/1.1
fetch at `49554b07652c4311fade8ec8dee858dd364b85fe`, then normally merged as
`7da9ed7e`. Earlier H09 readonly checkpoint `d425b101` is preserved. Frozen install,
20 workspace build scripts, licenses and dependency-security regressions passed
in this tree. Main521 Runner full is 249/249 and H09 combined is 97/97; neither
certifies the later Pi/Expo graph. Mobile's build script produces no native App.
Live Dependabot open count remains six, not zero; upstream-unfixed advisories
are not dismissed. Keep the two existing compatibility patches installed.

## Lane P: Pi 1.1.0

Exact-pin both `@earendil-works/pi-ai` and `pi-coding-agent` to 1.1.0 together.
Node 22.22.1 satisfies upstream's >=22.19 requirement. Do not merely compile
away a changed type while leaving session restoration pointed at obsolete
mutable state. SessionManager must be the future provider-history authority;
use the official append/restore plus refreshContext path. Preserve Host-owned
prepared task/context integrity, approval receipts, tool allowlists, MCP proxy,
input yielding, compaction anchors and actual effect admission.

Adapt TranscriptContext at the exact provider boundary using upstream's formal
transcript conversion helpers. Revalidate actual first dispatched provider
request for prepared input, approval continuation and compaction recovery.
Audit turn/settle/context-edit behavior, SDK retry and cancellation semantics,
tool duration and Azure provider mapping. Do not turn Pi codemode, built-in
MCP/image tools or cache warming into new default Ling capabilities.

Verification includes Runner full tests, real SDK + loopback HTTP provider
requests, Daemon durable continuation/approval/compaction/provider neighbors,
cancel-not-success and **tool effects at most once** across approval recovery.
Stubbed Daemon runTask tests alone do not prove real SDK first-request behavior.
No paid/live provider request is required for local protocol verification.
Fresh signed/package and original 12-case macOS gates remain open afterwards.

## Lane M: supported Expo SDK57 pairing

Stay on stable Expo 57.0.27 and its ~57 native module family; do not upgrade to
58 `next`/React Native RC. Use the actual SDK57 bundledNativeModules matrix:
React/DOM 19.2.3, RN 0.86.3, AsyncStorage 2.2.0, safe-area ~5.7.0, screens
~4.26.0, local Mobile TypeScript ~6.0.3. Existing React type alias may remain
in the compatible 19.2 family, while root tooling stays separate.

React 19.2.8's inspected release/comparison concerns RSC/Flight/server functions,
not an established vulnerable client `react` runtime in this Mobile App. RN's
inspected renderer is built with 19.2.3. Matching the officially supported SDK
pair is evidence-driven, not a blanket downgrade of security patches. Preserve
the security overrides/backports and rerun them on the new dependency graph.

AsyncStorage 3's `removeMany` is not available on 2.2.0: migrate draft cleanup
to `multiRemove`, preserve workspace namespace isolation, empty-list no-op and
failure propagation with behavioral tests, not only a source regex. Update the
existing UI contract assertion to the correct 2.x API rather than deleting it.

Run frozen install, Mobile typecheck and all tests, Expo install --check and
doctor; record specific network/non-version failures rather than suppressing
all checks. Native permission, secure-store/device key, pairing, foreground/
background and camera flows require a rebuilt native Dev Client/device test;
unit/Metro checks are not that acceptance. Do not modify credentials, real
Keychain/defaults or create OS accounts for this migration.

## Current status

Both lanes are implementation work in progress, not complete or published.
Root owns dependency lock/install work; source owners have disjoint scopes.
No policy decision remains to start the prescribed SDK57 pairing. Real Mobile
device availability and the existing Office/Keychain trust evidence are still
acceptance prerequisites, not excuses to substitute synthetic acceptance.
