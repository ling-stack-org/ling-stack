# Scoped macOS Development Packaging Review

Status: independently reviewed source prerequisite; final artifact acceptance separate
Date: 2026-10-13
Current reviewed source: `37bbdf6de05c691fa6949543657d04e84dd17342`, comprising main `5bf2659bd11925b0e12fb459febcfde5c18688a6`, PR #537 `51f46a9ea1b128ac9d94243dd571f823f9a18fab` and compatibility correction `921c240b`

## Current Dependency Compatibility Review

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

The current fixed packaging aggregate is `21877f37a6bf4d6e5cce77d19deba032e53cb4b9b0f64dc23bcf0c8f2f037db2`. The unchanged Office native aggregate is `715c56bcc31a2f6fbf546e86c2a937702305675cd17e6f69136089f09a4b7c0f`. Both encode the fixed-order `[path, sha256]` pairs as JSON plus a newline. The original reader rejected the stale record before this explicit review; no build-time discovery, approval updater or guard bypass was added.

This is a compatible subset of the grouped dependency proposal: diff 9.0.0, docx 9.9.0 and OfficeParser 8.1.1 are retained, while Pi 0.84.4, the existing Expo 57 mobile manifest, Mermaid 11.17.2 and Undici 7.30.0 remain. Lockfile changes also include Express-owned transitive major updates, `content-disposition` 1.1.0 to 2.0.1 and `content-type` 1.0.5 to 2.1.0; the packaging reviewer checked their Express API smoke. They are not described as minor/patch-only updates. All seven security patches and their bindings remain intact.

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
