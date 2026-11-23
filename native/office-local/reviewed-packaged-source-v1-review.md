# Scoped macOS Development Packaging Review

Current source prerequisite: [Cold-start resource authentication rebind](#cold-start-resource-authentication-rebind),
which carries forward the [Official plugin packaging source closure](#official-plugin-packaging-source-closure).
The [2026-11-03 dependency review](../../docs/release/macos-source-review-2026-11-03.md)
and the dated reviews below retain their historical evidence and scope.

## Cold-start resource authentication rebind

Date 2026-11-23. This development packaging record binds source commit
`77aaa790f724baa6e6f4caa3bb10316765fc6cf2`. Packaged macOS and Windows each have a
180-second resource authentication deadline. A valid resource receipt starts the
separate 20-second service-readiness deadline.

The only changed fixed packaging input is
`apps/desktop/main/daemon-lifecycle.ts`, whose digest is
`93b3423c29ba834ca7211f9b154286cb459616751f536bca48302a2ecdb709d3`.
All other 2,012 packaging inputs and all 15 Office native inputs still match the prior
record. The updated record is 260,282 bytes, and the fixed-order packaging aggregate is
`4eed3e6f07ea4a43e1e84ba7d702d352ebb50744c7bb5f8a2248b687755613b7`.
The updated record SHA-256 is
`cae50b780f148108a0ef65b946c7f5fd7fba1527be2fe938019f58f08da879a6`.

Independent Codex context `01a2089e-d773-7a81-8a86-40676888cbf2` recomputed the
fixed digests, reviewed the startup deadlines and returned `VERDICT: CLEAN` for
this development packaging record. Desktop type checking and all 56 focused
lifecycle tests passed. The hosted daemon measurements used to set the resource
deadline are recorded in [Independent Plugin Packaging](../../docs/design/plugin-independent-packaging.md#候选构建证据).

## Official Plugin Packaging Source Closure

Date 2026-11-23. The source prerequisite binds `4596ab2614ba2a4217c8a8f24b05128229a1c5a4`
for Darwin arm64 with `unsigned_dev`, ad-hoc signing and the no-bundled-provider
build lane. The inventory covers the App Server client, plugin download and
verification code, Desktop plugin trust inputs, and dependencies identified
from the fixed authored roots.

The record covers 2,013 packaging inputs, including 66 new paths and 158 changed
digests. All 15 Office native source digests and the toolchain, headers, runtime,
signing and trust fields match the preceding record. The digest map uses one
entry per line within the existing 262,144-byte reader limit.

Independent Codex context `01a207d4-0b52-7631-911c-e0819e5f1455` verified the fixed
inventory, every candidate digest and metadata preservation, and returned
`VERDICT: CLEAN` for this scoped development source binding. A strict packaging
fixture used real esbuild and observed the authored download, verification and
cache modules in the emitted daemon. System signing and installed-app behavior
require separate runtime evidence.

Record SHA-256 `31aefdc05b9b9c6e1d19685ff1b3eae1786d42422f6b03efdce5b76cfb25a864`.
Packaging aggregate `6a2718044d0dad1b75e8438ba23b3b7d41e5211ae7b681f012dcf676ba55c435`.
The preceding record SHA-256 was
`fc450f98173497ea0a6c73d37d32430bc551df30ac385749284e9411496993ca`.

## Managed Worktree Integration Source Closure

Date: 2026-11-18. This source closure binds the integrated main commit
`a56ea0a3f8addb57667a718b33a58ad217d37e72`. The 44 authored roots resolve
6,206 literal authored edges across 1,864 parsed files.
The source audit found zero unresolved literal imports and zero parse errors.

The fixed inputs include nine reachable managed worktree runtime sources and
three Desktop setup authorization sources. The new routes retain workspace
and local-origin admission. Desktop script setup uses the existing Main
confirmation and bridge-token flow. The loopback Origin projection applies
to the owned file documents and the configured local daemon.

The 1,947 packaging inputs include 12 added paths and 91 changed digests.
The changed entries comprise 29 exact main inputs, 6 integrated inputs,
55 generated locale catalogs, and the fixed input list. The 15 Office
native inputs, toolchain profiles, headers, runtime and signing entries retain
their existing digests and values. The record occupies 262,101 of 262,144
bytes.

Record SHA-256 `fc450f98173497ea0a6c73d37d32430bc551df30ac385749284e9411496993ca`.
Packaging aggregate `47c4de4cc5c6eb09d8bb920d1bf3cc489496fd3e6a057cde82098bddfd055252`.
Fixed-list SHA-256 `e3f919d536dea92f7310241f91839b8897b97abd4dac94450ff7dbca4f8aad38`.
The prior record SHA-256 was `dba559d7574cf707af255ec269f24e1fd31d9d976810a9ce56d8b67e1965944f`.

## Main #732 Integration Source Closure

Date: 2026-11-18. This scoped rebind follows the integration of main commit
`bba53def82ff0278856722e793b854928e1b161d` into the code-assessment branch.
It is limited to the fixed Office authored-source list, its digest record and
this review narrative. It does not change Office native inputs, runtime,
toolchain, SDK/header, signing, approval or trust fields.

The AST closure uses the fixed 44 authored roots with Babel 7.29.12. It parsed
1,855 authored files and resolved 6,147 literal authored edges with no unresolved
imports or parse errors. Four non-literal optional/dynamic edges remain outside
the literal closure: the signing artifact extractor's `require`, the macOS
packaging script's dynamic import, and two optional LanceDB imports. They are
not converted into packaging approval by this record.

The fixed list contains 1,935 packaging inputs: 42 newly reachable
authored paths, 141 changed digests including the list itself, 1,752 unchanged
digests and no removals. The initial integration provenance review counts 116 main-tree
bytes, 7 integrated bytes, 55 generated localization inputs, 2 branch bytes
and the literal fixed-list update. All 15 Office native source digests are
unchanged. The record is 260,563 bytes, below the reader's 262,144-byte bound.

The review record SHA-256 is
`dba559d7574cf707af255ec269f24e1fd31d9d976810a9ce56d8b67e1965944f`;
the fixed-list SHA-256 is
`577b71f79b847c24b99a6fe829a7e59f9b9fe69b80858ad92ad345698e24b4f9`;
the fixed-order packaging aggregate is
`5d76626c3a3ff141ef6b1eafedd5f555f2f9ec6a52fb4ae2fde5b8427ef6e988`;
the unchanged 15-input native aggregate is
`9c5f6a1a05fe63ab96de941432ec13166af8974ec52730934d5ac348c41a854e`.
Aggregates encode the fixed-order `[path, sha256]` pairs as JSON plus a
newline. The prior record SHA-256 was
`27ebf5b1f0c9d5d498072b655cc050c440ca4f701b4e82770decdbc41d0ec4d7`.

The Desktop bridge supplies a loopback Origin for absent or opaque Origin headers
from the owned top-level file documents. The Companion request routes remain
limited. Code assessment preparation skips lifecycle hook configuration and
the tool-free runner policy excludes hooks at execution. These three inputs
are captured by the same fixed source list.

## Assessment and Locked Use integration

The record binds the packaging sources at `cc25ca94429a26110f2ec6969434aeea6121dbc8`.
The 1,893 fixed packaging inputs are the union of the assessment closure
recorded at `109f54905` and the Locked Use integration at `7e1242c7b`.
The six Locked Use entries retain the mainline digests. All 15 Office native
inputs keep their existing digests.

Inputs unique to the integrated tree are the 55 catalogs generated from the
combined message sources, the fixed input list, the two product version
sources, shared redaction, the Chrome pairing route and controller, and the
daemon router and loopback predicate, and the assessment Diff capture. Pairing requires a directly connected
loopback client and an allowed Chrome extension before preflight or pairing;
bearer authentication still applies when configured. The redaction inputs
preserve public status and counts while removing credential values. Capture
excludes files when redaction changes Diff line anchors.

The record SHA-256 is
`27ebf5b1f0c9d5d498072b655cc050c440ca4f701b4e82770decdbc41d0ec4d7`.
The fixed-order packaging aggregate is
`a9de11c34e534c6336c2a00a2a463e73c94bdf292662ee5e6bf80c7cb09954bc`;
the unchanged Office native aggregate is
`9c5f6a1a05fe63ab96de941432ec13166af8974ec52730934d5ac348c41a854e`.
The schema, review identity, approval and trust fields, runtime, toolchains,
headers and signing are unchanged. These hashes bind source inputs for the
existing review reader. They confer no build, signing or publication authority.

## Companion and native runtime review, 2026-11-17

The Companion source closure retains 44 roots and contains 1,872 fixed packaging
inputs, including its explicit native window and capability modules. Scoped
review covered the Companion changes and deterministic compilation of the 55
locale catalogs before adopting their exact input bindings. The Office 15 and
sandbox 19 native inputs remain byte-identical to their reviewed records.

Independent Codex context `native_packaging_prerequisites` returned
`SCOPED SOURCE-REVIEW PASS` for the exact native prerequisite proposal before
either persistent record was changed. This is a separate context on the same
model host, not human or cross-model approval, and is not a clean-review
certificate for the full pull request.

Both records bind Darwin arm64, Electron 45.3.1, embedded Node 24.22.2 and libuv
1.52.1. The sandbox record changes only its Electron and Node fields. The Office
record makes the same two changes, binds that sandbox record, and retains both
SDK 26.5 profiles while adding this exact local profile:

| Field | Reviewed value |
| --- | --- |
| Profile | `local-xcode27.2-sdk27.2-arm64` |
| Compiler | `Apple clang version 21.0.0 (clang-2100.4.1.1)` |
| Compiler SHA-256 | `fc5e3cbba6ad54059295cad716aacb05ace8235f5f7a6031f1d8c15d24bd6d66` |
| SDK | `macosx27.2`, version `27.2` |
| SDK settings SHA-256 | `82165b15ee21419d4cffaba8895797391b908ac9499ba70f561f3e1bd16758d6` |

The reviewer compared the fixed native inputs, candidate field differences,
Apple compiler signature and existing OS identities, and the native ABI and
publication contracts. The compiler's strict signature verifies as
`com.apple.clang` with the Apple Software Signing chain; the containing Xcode
27.2 bundle also passes strict signature verification. All four N-API headers
are unchanged. Office uses N-API 8, C++17 and deployment target 13.0; it does not
link to Node's internal ABI. The local Darwin 27.0.0 backend, codesign and dyld
profile identities match the existing `additionalOs` row.

Fresh evidence covers 48/48 Office tests under standalone Node and 48/48 under
the actual Electron runtime, with equal source fingerprints and no fixture
residue. The fresh sandbox build passes 26 Rust tests with two existing ignored
cases; process, input-read and codesign protocol suites pass 19/19, 10/10 and
18/18. Restricted dispatch using the actual Electron executable and its exact
resource digests passes 15/15, including write/network refusal. Launch-unknown
contracts pass 2/2. No source, test, observer or approval mechanism was changed
to obtain these results.

The exact approved sandbox record SHA-256 is
`3b6404b32c2e52166fb581744c4fccb1232e21e4cd847b0dd936032f7f1be3bf`;
the approved Office record SHA-256 is
`f888550f1a89ca8d3015372e9b019b72ae1c15130236c89d0443395252cee7f1`.
The sandbox record is adopted first. All other source pins, OS rows, trust,
signing and false/unbound safety axes are unchanged. This finite prerequisite
review does not accept final App/archive bytes, public signing, notarization,
clean-machine behavior, root-only capability observers or full Host protection.

Integration of main `86f057874` (#715) changes only the fixed
`packages/remote-protocol/package.json` input: four test/typecheck scripts select
the migrated TypeScript suites. Its production build scripts, exports,
dependencies, source and production compiler configuration are unchanged. The
new test configuration uses `noEmit`; it does not add a runtime import edge.
The same independent context separately returned `SCOPED SOURCE-REVIEW PASS`
for the exact candidate before adoption. Only that packaging input digest
changes, to `ed97b6e2218a30e5bd17788c7a5a6a1498d490a68dbbadc35d730a5ce6ca093a`;
the resulting Office record SHA-256 is
`a3bb786d0f0b7147171fdb804423cf87c8c9d5ed375bdb066f501d8b54e607d2`.
All 1,872 packaging and 15 Office native inputs match this record. The sandbox
record and every runtime, toolchain, OS, signing and trust field retain the
approved values above.

Integration of `eda498d93` (`fix(desktop): allow companion teammate lookup`)
changes only the fixed `apps/desktop/main/companion-window.ts` input. Its network
filter and route check allow the owned top-level Companion document to project
GET `/teammates` requests while retaining null Origin for nested, non-GET,
unowned and foreign requests. The paired `companion-window.test.ts` assertions
cover the top-level positive and nested-path negative; the targeted suite passed
3/3. There are no import, dependency, native input, runtime/toolchain/OS,
signing/trust or false/unbound safety-field changes. Only the packaging digest
changes from `3062e1ebb53f9810d6d3bf5739811ad56c22da71becc1876ac3513c816af5d4e`
to `2d8a1e31745263876c573bb5d6a53c3fa38c9aa97ff6bb1518bf3684a800e43e`.
The exact Office record SHA-256 is
`c1af02b777c71acde3bcfd222b04ba1035f0051f60fd6ed3d77f23b2617b26da` and the
fixed packaging aggregate is
`48fb0d593fd30d3c612b141f1ac364e2235bf381f0601e46db1c60aa2de84d08`. All
1,872 packaging and 15 Office native inputs match this record.

Integration of main `44f7a0dd6` (#719) binds the conversation change-summary
runtime closure already present on the base branch. It changes only these fixed
Office packaging inputs: `packages/contracts/src/workspace-changes.ts`,
`packages/daemon/src/features/runs/thread-routes.ts`, and
`packages/daemon/src/server/routes.ts`. The change adds the conversation-file
summary projection and its route wiring; it does not change Office native
sources, packaging tools, runtime/toolchain/OS identities, signing, or trust
fields. The three packaging digests are refreshed from
`efb0337fe87c237e4cbc4df3cd05b2e5edd99e914177362c6238bdaec3e4c862`,
`29c677132fe57f9b1709cbc1c3aa478c7ec00542c49146ab22fa2aa0157567ae`, and
`ac8e5ea32b807995ffd2715da4e77f80f088c0b52a89bdd29653a14ccbf2a2ed` to
`29d96be654be2c22c7b7429529de9cf67b80a8ae0e29990af932d21eff5a52c6`,
`ac2e04146c264b564acac1ec4c032d5a7a6d3f0845e5278a4b01778ea3957056`, and
`10a8e27a8ce2b8ba65ed6135c4117d76338c61f4da5036dd6d7efa5b83cad627`.
The exact Office record SHA-256 is
`860c9de9e463c9167f2e71459b018d2416f3333ee9b2c18db8856d519b5705f7` and the
fixed packaging aggregate is
`7f407ee163e0277b6e9b38b4ed7d9fa080526523b4e0140e1fae13e2ba38f21d`. All
1,872 packaging and 15 Office native inputs match this record.

## Final Branch Record Rebind

Date: 2026-11-18. The final PR #731 source tree before this record-only update is `fd57e0099`. Four existing packaging inputs had stale recorded digests after the reviewed assessment implementation: `packages/core/src/storage/sqlite/code-assessment-comments-migration.ts` (`9c666d30b352ed25376b18f1db97edc1ee28ac905343c9ba6891444c6e627c22`), `packages/core/src/storage/sqlite/code-assessment-migration.ts` (`42c28069b828968295a9df9eb0d2ff1b1092a853d59eb71ca307f3481c1c1790`), `packages/daemon/src/features/code-assessments/service.ts` (`4711e54f974d08be54afd59d20983fd525e5ee91200f7f034427b9bb8c9ebb27`) and `packages/daemon/src/features/code-assessments/snapshot.ts` (`b0a20fa8c9c050da1ccf51880bfb768428376605cc1d74d1129df52a3726be48`). The previously recorded values for these four entries were stale; `packages/daemon/src/server/router.ts` remains bound to its already corrected final value `37ec78bb33e6fe91a3793ca5795f676e4e35447e47548a2243a8a499a8f5ea9d`.

The record-only rebind changes four existing packaging digests and adds no paths. All other packaging and Office native digests, approval/trust values, toolchain profiles, runtime and signing fields remain unchanged. The reviewed JSON SHA-256 is `12182e90c1aeef51a03498144a25d459931538097672459faa2d27d2a704d3e9`; the fixed-order packaging aggregate is `98b388f47aa6fc577974b52a51e1b3e18da9754e05e04ddfc1a72288e196a67b`; the unchanged 15-input Office native aggregate is `9c5f6a1a05fe63ab96de941432ec13166af8974ec52730934d5ac348c41a854e`. Aggregates encode the record's fixed-order `[path, sha256]` pairs as JSON plus a newline.

This update only restores the checked-in source record to the final branch bytes. It does not create an Office native grant, lease, publication or signing authority, and it does not establish App/archive, platform, signature or GUI acceptance.


## Assessment Source Prerequisite Review

Date: 2026-11-17. Reviewed feature source: `d9bd55a20499fb442d3dd61280c3a0daf7034f0e`, tree `42ffd81985bcff7fae230c013bfce45bcf05de15`, against main `27a9ccb23c59bcb890d556767f175830717b94cc`.

Two independent Codex contexts reviewed the assessment runtime closure and source semantics before the static record was adopted. The Babel 7.29.12 AST audit followed 43 authored roots, parsed 1,780 files and resolved 5,861 authored literal edges without unresolved imports or parse errors. The fixed list retains all 1,841 prior inputs and appends 15 assessment contract, persistence and daemon inputs. Explicit type-only edges remain excluded. Integrated main `86f057874596bb80ea372cfd9ec3210658e5f6e7` adds one reviewed Remote Protocol manifest digest change for its TypeScript test scripts; production exports, dependencies, build inputs and runtime sources are unchanged.

The 1,856-entry packaging map has 15 added keys, 68 changed digests, 1,773 unchanged digests and no removals. The changes bind 12 tracked source/manifest/version inputs, 55 generated locale data files and the fixed list itself. Each locale adds 105 string messages without changing prior values. The final list is a literal-only extension with SHA-256 `8296f674934d844a9233df1d91a73d5aa8ae7075115cd6a2a2555b001995bbab`; its unchanged roots and prior path order were checked separately.

The reviewed JSON SHA-256 is `f1ce942d92bb02aad97602c45d529631f401a76b20f8d899469d7175dd055a8d`. The fixed-order packaging aggregate is `965557151d41c13576c93e4d9d9989e655c20c54bd7ae20b876efda031baee82`; the unchanged 15-input native aggregate is `9c5f6a1a05fe63ab96de941432ec13166af8974ec52730934d5ac348c41a854e`. Aggregates encode the record's fixed-order `[path, sha256]` pairs as JSON plus a newline.

Assessment execution uses tool-free text-model Runs and creates no Office native grant, lease, publication or signing authority. All native hashes, schema, approval/trust values, toolchain profiles, headers, runtime and signing fields retain their existing values. The reader, import containment, publication guards and test assertions are unchanged. This source prerequisite review does not establish final App/archive, platform, signature or GUI acceptance.


## Historical baseline, 2026-10-13

Status: independently reviewed source prerequisite; final artifact acceptance separate
Date: 2026-10-13
Historical reviewed source: `37bbdf6de05c691fa6949543657d04e84dd17342`, comprising main `5bf2659bd11925b0e12fb459febcfde5c18688a6`, PR #537 `51f46a9ea1b128ac9d94243dd571f823f9a18fab` and compatibility correction `921c240b`

## Historical Dependency Compatibility Review

Two independent Codex reviewers approved the exact proposed source bytes before the persistent record was changed:

- Office compatibility reviewer `01a133c2-9504-7e03-95a3-a0a4d5204732` returned `APPROVE_SCOPED_SOURCE_COMPATIBILITY`: OfficeParser 8 asynchronous text conversion, preserved parser budgets and blocked errors, post-conversion cancellation check, real DOCX/XLSX/PPTX processing and diff 9 compatibility. Cancellation prevents publishing the result; it does not claim forced interruption of conversion computation.
- Packaging/lock reviewer `01a133c2-9736-7ce1-b470-0e16332aaa1a` returned `APPROVE_SCOPED_DEVELOPMENT_PACKAGING`: exactly four changed packaging inputs out of 1,211; the other 1,207 inputs, 15 Office native inputs, 19 sandbox inputs and 35-root inventory remain unchanged. This approval permits only the four input digest replacements and this current review narrative/aggregate update.

The approved replacements are:

| Packaging input | SHA-256 |
| --- | --- |
| `packages/daemon/src/features/channels/materialization/extractors/office.ts` | `ea075b8f4f36b6c8f72cfe46e7972efb7921e2c765a1b18996d3ec7d8a9eb942` |
| `packages/daemon/src/features/office-documents/artifacts.ts` | `720d02ac9b948f2618e1219925ecff4fda4755839738700f1db93936710abe7f` |
| `packages/daemon/package.json` | `9daa4ffc9dc8d1f0b30bb52ec44d5204db68739b7e7b97fa915862f466214201` |
| `pnpm-lock.yaml` | `2b411405825673eee46fd1e099def6944744e830cb5cd6b3fbf28db30b49c799` |

The historical fixed packaging aggregate is `21877f37a6bf4d6e5cce77d19deba032e53cb4b9b0f64dc23bcf0c8f2f037db2`. The unchanged Office native aggregate is `715c56bcc31a2f6fbf546e86c2a937702305675cd17e6f69136089f09a4b7c0f`. Both encode the fixed-order `[path, sha256]` pairs as JSON plus a newline. The original reader rejected the stale record before this explicit review; no build-time discovery, approval updater or guard bypass was added.

The desktop license-material correction in PR #624 changes the fixed `pnpm-lock.yaml` input to `f8888021f9d124c5d5979857ab1fb8531f22a6c45095e23eed16147a72d59cad`. The change removes the legacy `exceljs -> unzipper -> binary -> buffers/chainsaw` notice gap and is covered by the distribution-material regression tests; the review record now binds that exact lockfile byte set.

This is a compatible subset of the grouped dependency proposal: diff 9.0.0, docx 9.9.0 and OfficeParser 8.1.1 are retained, while the historical packaging snapshot retained Pi 0.84.4, the existing Expo 57 mobile manifest, Mermaid 11.17.2 and Undici 7.30.0. The current source tree has both Pi packages pinned to 1.1.0; this review record remains a historical 0.84.4 packaging statement. Lockfile changes also include Express-owned transitive major updates, `content-disposition` 1.1.0 to 2.0.1 and `content-type` 1.0.5 to 2.1.0; the packaging reviewer checked their Express API smoke. They are not described as minor/patch-only updates. All seven security patches and their bindings remain intact.

Fresh local evidence includes a complete serial workspace build, workspace typechecks, 196 targeted Daemon tests, 250 Runner tests, 87 MCP tests, 242 desktop custody/guard tests, 33 dependency security tests and the license policy over 1,224 versions/23 families. Actual Electron 44.7.0 / embedded Node 24.21.0 / uv 1.52.1 passed seven real HTTP/Office format/cancellation/error regressions. Four real Chromium tests passed with mock Daemon fixtures; these are not real-model or packaged-App acceptance. Three screenshots remain local, not part of the reviewed source closure.

Runtime, compiler, SDK settings, four header digests, Darwin 25.6.0, codesign pins, trust/protection fields, `unsigned_dev`, ad-hoc signer and `provider=false` are unchanged. False/unbound safety axes are not raised. E6/PR #533 remains excluded. No new App, ZIP or DMG is accepted, and no public signing, notarization, Windows, full protection or public-distribution acceptance is claimed. Prior native evidence below is historical, not a fresh rebuild of this dependency snapshot.

## Historical Runtime Rebinding (#528)

The prior reviewed source was `1271a827bf0314ba7b36f2ceff8122b33bc52590`, comprising main `6ddd5e6b75e314cc0fbeee370991c70c7383a0ff`, PR #528 `ce64e48dbd09aca76857b71efdc39e93bee16be5` and the resource-contract test correction.

Independent Codex reviewers returned `APPROVE_SCOPED_DEVELOPMENT_PACKAGING` for the exact proposed deltas before the persistent records were changed:

- Office native reviewer `01a132f2-62d1-7022-8bda-0c5941cdc518`: all 15 unchanged Office inputs and actual Electron 44.7.0 / embedded Node 24.21.0 / uv 1.52.1 compatibility, retaining the measured compiler, SDK, headers and OS.
- Sandbox native reviewer `01a1331d-e538-7a53-b82e-3e26858fc13b`: all 19 unchanged codesign inputs, actual Rust 1.97.1, Darwin 25.6.0, backend/codesign/template identities and original Host proof chain. Only the sandbox record's Electron field may change to 44.7.0.
- Packaging reviewer `01a1331d-e657-7b51-b2c7-b05237111aa8`: the fixed 35-root, 1,211-input authored closure, lockfile dependency changes, seven retained security patches and original publication/Builder/ASAR/ZIP/DMG guards. The Office record may change only its Electron field, lockfile digest and sandbox-review digest.

The first packaging review correctly requested changes because updating Office alone would leave the original codesign Host proof bound to Electron 44.5.1. The additional sandbox review resolved this prerequisite without changing production code or weakening a guard.

The approved lockfile SHA-256 is `c0c19a698126ca96503276dc17da3e2a1cd4eae3f35c9c7ba679cde9034b29d2`. The updated sandbox review SHA-256 is `1396c5916fec69b2ce5340ab53ce494b928d2ecef3eb1745aa8a7a91fe0f9d16`; the updated Office review SHA-256 is `b568bb535fb94c32fcc9c70a4755722bd37869708ee873ac44d7c3250c1e0b74`. The current fixed packaging aggregate is `0216bfc2572f1d49b157f74740886dcf9bb9e480f92430639913a586d1fcc16c`. The Office native aggregate remains `715c56bcc31a2f6fbf546e86c2a937702305675cd17e6f69136089f09a4b7c0f`. Aggregates encode the fixed-order `[path, sha256]` pairs as JSON plus a newline.

Fresh Office primitive suites passed 48/48 under Node and 48/48 under the actual Electron runtime. The fresh sandbox evidence build recorded 26 Rust passes and two ignored cases, 19 process-handshake passes, ten input-read passes and 18 codesign rejection-protocol passes. These are bounded build/protocol facts, not runtime Host certification or full protection acceptance.

This rebinding applies only to the recorded Darwin arm64 host, Electron 44.7.0 / Node 24.21.0 / uv 1.52.1, Darwin 25.6.0, the unchanged pinned toolchain, `unsigned_dev`, default ad-hoc signer and `provider=false`. False/unbound safety axes remain unchanged. PR #527 and E6/PR #533 are excluded. No final App, ZIP or DMG is accepted by this source review; each must be freshly built and verified separately after integration.

## Historical Source Review

The 2026-10-12 baseline was `1db15206ebf8ff687cba14157e6d9c1888d18bc2`, plus the reviewed development-packaging changes. Two independent Codex reviewers returned `APPROVE_SCOPED_DEVELOPMENT_PACKAGING`:

- Native reviewer `01a12f6f-e090-74b1-a0b6-69ff057a0f9e`: all 15 Office native source/build/test inputs, including the standalone-Node confined test actor adjustment.
- Packaging reviewer `01a12f6f-e1dc-7320-ac3e-207a1c2b129b`: the fixed original publication/Builder/ASAR/ZIP/DMG chain, authored-import containment and actual runtime/OS rebinding. An unbound `dist` import was identified and replaced with the existing authored source constant; no guard was removed.

The historical fixed packaging closure had 35 roots and 1,211 unique inputs. Its reviewed aggregate was `73f6dbb4ff037878b110993573baedf308ea6b7e03bb739ce1c72ea1d74c3d95`; the 15 native inputs aggregate was `715c56bcc31a2f6fbf546e86c2a937702305675cd17e6f69136089f09a4b7c0f`. Both encode the fixed-order `[path, sha256]` pairs as JSON plus a newline. The JSON prerequisite was recorded only after these independent decisions and exact snapshot comparison, not generated or approved by the build pipeline.

The historical finite review applied only to Darwin arm64, Electron 44.5.1 / embedded Node 24.21.0 / uv 1.52.1, Darwin 25.6.0, `unsigned_dev`, ad-hoc signing and `provider=false`. Compiler, SDK settings and N-API headers remain pinned to the measured local toolchain. A different source/toolchain/OS requires a new review; do not automatically refresh approvals.

The same reviewer separately approved moving `headers.root` to a non-personal canonical temporary toolchain directory. All four header files remained byte-identical; fresh compilation and both primitive suites use the relocated headers. No personal-path exemption was added to the public-repository check.

Fresh primitive suites passed 48/48 under Node and 48/48 under the actual Electron runtime, with identical source fingerprints. The authored-import regression covers missing and executable-poisoned generated modules; its synthetic dependencies provide no publication authority.

This is not exhaustive certification of all product/vendor code, SDK/linker/kernel trust, hostile same-UID isolation, Core safety, Developer ID, notarization, Gatekeeper, clean-machine acceptance or public distribution. Source checks retain `coreSafe=false` and other unverified runtime boundaries. Final signed App/archive bytes, notices and launch evidence must be checked separately through the original supported entry and release process.
