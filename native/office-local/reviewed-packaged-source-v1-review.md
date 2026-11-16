# Scoped macOS Development Packaging Review

Current source prerequisite: [Companion and native runtime review](#companion-and-native-runtime-review-2026-11-17).
The [2026-11-03 dependency review](../../docs/release/macos-source-review-2026-11-03.md)
and the dated reviews below retain their historical evidence and scope.

## Companion and native runtime review, 2026-11-17

The Companion source closure retains 43 roots and contains 1,843 fixed packaging
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
All 1,843 packaging and 15 Office native inputs match this record. The sandbox
record and every runtime, toolchain, OS, signing and trust field retain the
approved values above.

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
