# Scoped macOS Development Packaging Review

Status: independently reviewed source prerequisite; final artifact acceptance separate
Date: 2026-10-12
Baseline: `1db15206ebf8ff687cba14157e6d9c1888d18bc2`, plus the reviewed development-packaging changes

Two independent Codex reviewers returned `APPROVE_SCOPED_DEVELOPMENT_PACKAGING`:

- Native reviewer `01a12f6f-e090-74b1-a0b6-69ff057a0f9e`: all 15 Office native source/build/test inputs, including the standalone-Node confined test actor adjustment.
- Packaging reviewer `01a12f6f-e1dc-7320-ac3e-207a1c2b129b`: the fixed original publication/Builder/ASAR/ZIP/DMG chain, authored-import containment and actual runtime/OS rebinding. An unbound `dist` import was identified and replaced with the existing authored source constant; no guard was removed.

The fixed packaging closure has 35 roots and 1,211 unique inputs. Its reviewed aggregate is `73f6dbb4ff037878b110993573baedf308ea6b7e03bb739ce1c72ea1d74c3d95`; the 15 native inputs aggregate is `715c56bcc31a2f6fbf546e86c2a937702305675cd17e6f69136089f09a4b7c0f`. Both encode the fixed-order `[path, sha256]` pairs as JSON plus a newline. The JSON prerequisite was recorded only after these independent decisions and exact snapshot comparison, not generated or approved by the build pipeline.

The finite review applies only to Darwin arm64, Electron 44.5.1 / embedded Node 24.21.0 / uv 1.52.1, Darwin 25.6.0, `unsigned_dev`, ad-hoc signing and `provider=false`. Compiler, SDK settings and N-API headers are pinned to the measured local toolchain. A different source/toolchain/OS requires a new review; do not automatically refresh approvals.

The same reviewer separately approved moving `headers.root` to a non-personal canonical temporary toolchain directory. All four header files remained byte-identical; fresh compilation and both primitive suites use the relocated headers. No personal-path exemption was added to the public-repository check.

Fresh primitive suites passed 48/48 under Node and 48/48 under the actual Electron runtime, with identical source fingerprints. The authored-import regression covers missing and executable-poisoned generated modules; its synthetic dependencies provide no publication authority.

This is not exhaustive certification of all product/vendor code, SDK/linker/kernel trust, hostile same-UID isolation, Core safety, Developer ID, notarization, Gatekeeper, clean-machine acceptance or public distribution. Source checks retain `coreSafe=false` and other unverified runtime boundaries. Final signed App/archive bytes, notices and launch evidence must be checked separately through the original supported entry and release process.
