# Pi 1.1 / Expo 57 migration checkpoint, 2026-10-08

## User scope and base

The user explicitly requested integrating the security refresh and both migration
lanes with the existing E6 goal. Work remains on `codex/e6-safe-continuation` in
the dedicated E6 tree. Do not change the root checkout or another task's WIP.
Keep Mobile, Runner and Host source scopes independently reviewable. Save the
shared lockfile and both matching manifests atomically rather than committing
an importer/lock mismatch; any dependency rollback must regenerate the coherent
graph. Do not automatically enable the manually paused cloud CI.

Main/#521 was verified through live GitHub API and a successful bounded HTTP/1.1
fetch at `49554b07652c4311fade8ec8dee858dd364b85fe`, then normally merged as
`7da9ed7e`. Earlier H09 readonly checkpoint `d425b101` is preserved. Frozen install,
20 workspace build scripts, licenses and dependency-security regressions passed
in this tree. Main521 Runner full is 249/249 and H09 combined is 97/97; neither
certifies the later Pi/Expo graph. Mobile's build script produces no native App.
Live Dependabot open count was reread on 2026-10-09 as six, not zero; upstream-unfixed advisories
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

As of 2026-10-09, both dependency lanes are installed and implemented in the E6
tree, and the repaired joint gate passes. Source checkpoint c388a208 saved 30
files atomically, including the shared lockfile and matching manifests. Follow-up
bded3506 saved required-review inputs and the production-input test adapter.
Whole-Daemon final tests pass 3,672/3,672, zero fail/cancel/skip/todo; no migration
work has been pushed, merged or published.
Root owns dependency lock/install work; source owners have disjoint scopes.

### Installed graph and Mobile evidence

- Frozen install and the three dependency-security test groups passed; licenses
  checked 1,204 dependency versions. Existing image/cache backports remain active.
- Mobile tests are 34/34, Mobile typecheck passes, Expo install --check reports
  dependencies up to date, and expo-doctor passes 21/21. This is dependency/API
  verification, not a native build or device acceptance.
- AsyncStorage cleanup uses multiRemove with behavioral empty-list, namespace
  and error-propagation coverage. The old dotted binding-key ambiguity is an
  explicit separate migration concern; no persisted draft keys were rewritten.

### Pi and Host evidence

- SessionManager/public continuation and transcript adaptation are implemented.
  Anonymous OpenAI-compatible requests preserve explicit authHeader=false without
  leaking a private SDK placeholder to the wire or Host evidence. Custom headers
  and explicit Authorization are preserved; other provider APIs keep their
  authentication contract. Auth tests are 12/12 with actual Completions and
  Responses parsers/final fetch headers. Final Runner full tests on Node 22.22.1
  and 24.15.0 are both **294/294**, zero fail/cancel/skip/todo.
- Approval recovery passes 21/21. Four positive cases use actual SQLite reopen,
  production Coordinator/Orchestrator, real Pi SDK and loopback HTTP/SSE, checking
  the first request and exactly one command effect. The crash-after-tool-end case
  explicitly seeds that prior effect; it is not an original GUI execution.
- Host materializes only present JSON arguments and reads the completed approved
  result back from SQLite. The durable-write-loss negative case executes one
  real command, then refuses model dispatch and repeated effect replay. Startup
  scanning cannot replace an Attempt during the Harness pre-registration window.
- Fresh Daemon build and final workspace typecheck pass. Initial 12-file joint
  neighbors reported 139/141: two real recovered-tool progress cases failed with
  checkpoint.snapshot_unavailable. Their raw red log is retained. Public SDK
  compaction projection generates a new summary timestamp, including for a
  complete real old seal. Bind the restored projection to its source entry id
  and unchanged SDK summary proof, then restore only its metadata in the Host
  checkpoint capture. SDK journal/provider input/token budgeting and every tail
  message remain unchanged; a later compaction is not normalized as the old one.
  The real SDK lifecycle regression was red, then green for both a minimal seal
  and a complete timestamp/tokensBefore seal; public projection/provenance
  regressions are 10/10, including same-text/same-time new entry identity.
- Root reran the fresh-built 12-file joint gate after that repair: **141/141**,
  no fail/cancel/skip/todo, including actual child-process crash and SQLite
  restart recovery. Do not weaken prefix/tail, prepared-input or effect guards.
- The initial full Daemon result was 3,670/3,672, with two old test transports
  still reading context.tools. The production adapter already used transcript
  tools. Correct that test to the public getCurrentTools API and also compare
  final wire tool names against both SDK tools and Host frozen descriptors;
  preserve one-request, selected/unselected and yielded/succeeded assertions.
  The affected production-input/prepared-input neighbors pass 60/60. The final
  full rerun passes **3,672/3,672**, no fail/cancel/skip/todo, exit 0. Keep the
  original full red log; do not label it as the final passing result.

### Desktop bundle and source-review admission

Fresh Desktop bundle build passes; it is not a packaged GUI acceptance. Initial
Desktop unit tests were 1,858 pass / 2 fail / 3 Windows-only skips. The source
copies included every new module, but the **formal required-review inventory**
omitted provider-request-auth.ts, session-continuation.ts and session-transcript.ts.
Add these as mandatory hashed review inputs, not as automatically approved code.
Keep the source resolver strict and do not create a real approval manifest.

Actual esbuild metafile tests prove each new leaf's source hash/bytes and zero
workspace dist inputs. Nine missing-digest, changed-byte and missing-source
cases reject before compiler/sign/helper-normalize/esbuild. Both Node 22 and 24
source-review neighbors pass 259/259. Root's final full Desktop unit run is
**1,874 pass / 0 fail / 0 cancel / 3 Windows-only skips**, 1,877 total; this is
not Windows OS acceptance or real native publication approval.

Local receipts and raw logs are under output/e6-20260928; the sole continuation
entry is CONTINUE-HERE.md. Runner-only passes do not substitute for the joint
gate. The verified dependency/runtime/API and source-admission checkpoints are
saved, with final full Runner/Daemon/Desktop terminal results. This is not
publication or GUI acceptance. Do not claim that the old dependency graph
certifies this one.

| Final local gate | Result | Evidence in output/e6-20260928 |
| --- | --- | --- |
| Runner Node 22 / Node 24 | each 294/294 | pi110-runner-node22-combined-final-20261009.tap; node24 counterpart |
| Host recovery joint gate | 141/141 | pi1-daemon-joint-neighbors-progress-final-20261009.tap |
| Daemon Node 22 full | 3,672/3,672 | pi1-expo57-daemon-full-green-20261009.tap |
| Desktop Node 22 full | 1,874 pass, 3 Windows-only skips | pi1-expo57-desktop-node-full-green-20261009.tap |
| Final workspace typecheck | exit 0 | pi1-expo57-progress-final-workspace-typecheck-20261009.log |
| Fresh Desktop bundle | exit 0, not packaged GUI | pi1-expo57-desktop-bundle-build-20261009.log |
| Frozen install / security / licenses | exit 0; groups 8/1/9; 1,204 versions | pi1-expo57-final-frozen-install-20261009.log; final-security TAP; final-licenses log |

### Upgrade and acceptance policy

Do not silently regenerate old 0.84 prepared receipts under Pi 1.1's changed
prompt assembly. An incompatible paused run fails closed; recovery requires a
new user turn under the new assembly, while retaining old history. No legacy
renderer or old-Pi execution compatibility layer is added. Azure's provider id
and azure-openai-responses API id are different concepts; no unverified user
database rewrite is authorized.

No SDK57 pairing decision remains. Native Dev Client rebuild/device acceptance,
fresh macOS packaged E6 cases, and the existing Office/Keychain/Harness gates
remain open. A readonly environment probe found that the currently selected
toolchain cannot locate simctl (xcrun exit 72); this does not establish that no
Xcode is installed. Do not change the global toolchain, credentials or Keychains
to make the device gate appear complete. Cloud CI stays manually paused; do not dismiss the six upstream or
version-based security alerts merely because local tests pass.
