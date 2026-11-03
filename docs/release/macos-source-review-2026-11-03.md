# macOS development packaging dependency review, 2026-11-03

This review covers PR #633 at
`7f2fc754102f2c49e5e238ead027468f34da0023` plus its Builder compatibility
corrections, against main `b5713e56ccea5ab75c5c8450d4c8f275c20b1c70`.
It updates only the existing Darwin arm64, `unsigned_dev`, ad-hoc,
`provider=false` source prerequisite. It does not accept a final App, ZIP, DMG,
public signature, notarization, GUI behavior or release.

## Compatibility review

The seven proposed dependency updates are retained: Node types 26.6.6,
osx-sign 2.7.2, Electron 45.2.1, Electron Builder 26.18.0, Vite 8.3.5,
expo-doctor 1.21.5 and Babel parser 8.0.10. Builder is now pinned exactly to
26.18.0. Its installer, extractor and signing-trace consumers share the existing
version constant, while both Builder package-version checks remain strict.

Independent Codex context `01a1a05f-591b-77a1-86de-2bf4f7e4300e` found no
blocking dependency-graph or Builder-integration defect in these exact bytes.
The structured lock audit covered 20 importers, 1,391 packages, 1,395 snapshots
and 3,123 transitive dependency edges, with no dangling reference. All 22
overrides and nine security patches, including their hashes, remain intact.

The four pinned NSIS templates and the Windows toolset module are byte-identical
between the two Builder versions. Their existing hash guards are unchanged.
The NSIS source receipt changes its Builder version reference only, retaining
the compiler archive and license hashes. The other NSIS template change adds
`-NoProfile -NonInteractive` to four PowerShell calls without changing the macro
interface or fallback. Both signing callback contracts remain compatible.
Squirrel remains outside this review: its existing 26.15.3 package is not used
by the current `dir`/NSIS path, and its peer-version mismatch is not accepted
as a tested Squirrel configuration.

## Independent source and runtime decision

Separate Codex context `01a1a065-bf2b-74a0-b649-ec0012776b23` independently
reviewed the exact record proposal and returned `SCOPED SOURCE-REVIEW PASS`
before either persistent record was changed. These are independent contexts
on the same model host, not human or cross-model approval.

The source audit retains 43 roots and 1,706 unique fixed inputs. It parsed
1,630 authored files and reached 1,639, with no missing input, unresolved authored
import or parse error. The new version-constant imports target an already fixed
module, with no build-time approval discovery or new top-level write effect.
All 15 Office and 19 sandbox native input digests remain unchanged.

The actual Electron runtime is 45.2.1, with embedded Node 24.22.1 and libuv
1.52.1, on Darwin arm64. Both records change only their Electron and Node
runtime fields. Compiler, SDK, headers, deployment target, OS rows, trust,
signing, approval fields and false/unbound safety axes are unchanged.

The sandbox record was adopted first. The Office record then adopted exactly
the following nine existing packaging digest replacements. No key was added
or removed; the other 1,697 values are unchanged.

| Existing packaging input | Approved SHA-256 |
| --- | --- |
| `apps/desktop/package.json` | `27770142078674303ec055346be769f4d171a97d5f42360c3963cecfa40c31f4` |
| `pnpm-lock.yaml` | `35a0c8f7099c7c16121bd37543a201a297faec8150be658a74d86acc8f6e8170` |
| `packages/daemon/package.json` | `2a49fd5f9cfda243818930faa717ecaf660bde7374baf30e421022be15f40fcb` |
| `apps/desktop/scripts/distribution/installer-builder.mjs` | `4f67d19706b4f000a1ab90590932190fb6889803578d9bf0d9bfc38a7fab817d` |
| `apps/desktop/scripts/cua-driver-signing/electron-builder-mac-sign.mjs` | `7000392b8ca2f4151442773d8150fddcd1c758ab6ad5516a5a7dfdc098ea1ead` |
| `apps/desktop/scripts/cua-driver-signing/final-artifact-extractor.mjs` | `97e45821742403beaf936ebb5393633845b5be111e346266ec1f186af02efdc4` |
| `apps/desktop/scripts/cua-driver-signing/hooks.mjs` | `61a37e71e5f6df0b6113cc558eff86210dcf80eeb0d825d3060198d8eff7f76e` |
| `apps/desktop/scripts/cua-driver-signing/signing-trace.mjs` | `8d8403ecb6d2f3a8c9f7405d51535a61e3e048e4bd19d33cfeaa747ea380eb0e` |
| `native/sandbox/reviewed-codesign-source-v1.json` | `5e4e8cc68a68f4901244aa773ca04787805021f61c714ab64b52bf960c328572` |

The adopted Office record SHA-256 is
`b2c06d112ad73b76e85b7d5c32e4f811d27c4fb60d983f5c7aa3141bfbe9fac9`.
The fixed-order packaging aggregate is
`3868fd0e3b646024891db46aca47fe0dfcaefb0a851e5f4a5bb928b85670290b`.
The unchanged Office and sandbox native aggregates are respectively
`9c5f6a1a05fe63ab96de941432ec13166af8974ec52730934d5ac348c41a854e`
and `6770a6864706c68c41ed4998c826daeff7e33baf7d59d9d9cfca8a9b63da1dbd`.
Aggregates encode fixed-order `[path, sha256]` pairs as JSON plus a newline.

## Verification and limits

- Before adoption, the actual committed-form Office record test failed on the
  stale Desktop manifest digest. After adoption, all 1,706 packaging inputs
  and all native inputs match, and the exact record/field comparison permits
  only the independently reviewed changes above.
- The actual strict Office reader, default local Office reader and codesign
  reader accepted the final records and fresh native build evidence using the
  already approved local Xcode/SDK/header profile, without observer mocks or
  a new toolchain allowance.
- Office publication, codesign publication, authored-input and toolchain
  contract tests passed 227/227 with no skips. Their disposable synthetic
  compiler/signature cases do not establish final artifact acceptance.
- Fresh Office compilation passed. Primitive/publication/readback suites
  passed 48/48 under standalone Node and 48/48 under actual Electron 45.2.1,
  with equal before/after source fingerprints and no fixture residue. The
  first Electron run passed 47/48 because its confined actor used a symlinked
  Node path; that failed run was retained. Selecting the canonical standalone
  actor path through the existing test-only setting resolved it without
  changing source, tests or policy.
- The fresh sandbox build recorded 26 Rust passes and two existing ignored
  cases. Protocol suites passed 19/19, 10/10 and 18/18. Actual restricted-command
  dispatch with the fresh helper and Electron passed 15/15 without skips.
- Frozen dependency installation, the nine-package Daemon build graph and
  Desktop CI typecheck passed. Dependency-security regressions passed 173/173;
  release/extractor contracts passed 117/117. Installer/NSIS/signing-feasibility
  tests passed 36 cases, with four existing Windows-only cases skipped on macOS.
- License policy passed for 1,282 versions across 23 families. Windows execution,
  installer acceptance, complete hosted CI, final App/archive bytes, real signing,
  notarization, clean-machine and GUI acceptance remain separate checks.

No approval refresher, fallback reader, disabled guard or new safety capability
was introduced. Earlier reviews retain their historical snapshots and limits.
