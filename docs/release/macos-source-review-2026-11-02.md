# macOS development packaging source review, 2026-11-02

This review covers `1047b00500ec478c5bf4594f25a97e73b8dd34a3` plus the
CI/security repairs and fixed-source corrections in this working-tree snapshot.
The scope is the existing Darwin arm64, `unsigned_dev`, ad-hoc, `provider=false`
source prerequisite. It is not approval of a final App, ZIP, DMG, public signing,
notarization, installed-user behavior or the entire product/vendor codebase.

## Independent source review

Separate Codex contexts reviewed the proposed bytes, not just the current Git
diff or an automatically refreshed approval map:

| Reader | Scope | Scoped decision |
| --- | --- | --- |
| `01a19b42-49cf-7b43-bb60-1932ee5273a6` | 216 changed/added/recovered Daemon source inputs, including admission, MCP buffering, shutdown, sessions, learning and memory | `APPROVE_SCOPED_DEVELOPMENT_PACKAGING` |
| `01a19b42-01dd-78c2-a64e-db9a2a87c39b` | 223 changed/added/recovered Core, contracts, runner-pi and plugin-sdk inputs | `APPROVE_SCOPED_DEVELOPMENT_PACKAGING` |
| `01a19b42-9579-7c21-990b-561cc0a95ea3` | Package/lock graph, nine active security patches, preserved prior repairs and optional provider boundary | `APPROVE_SCOPED_DEVELOPMENT_PACKAGING` |
| `01a19b41-9aa6-7831-9a35-95e1e6a981a6` | Desktop publication, authored closure, local-service IPC, Cua custody, leases, ASAR/gstack and exact source-record proposal | `APPROVE_SCOPED_DEVELOPMENT_PACKAGING` after the two corrections below |

The Daemon and Core-family reviewed aggregates are respectively
`a9ae81b8a9cc86d09031216c3fa08e1b5c39ba414776990ecf35f837f86af54f`
and `409b2725b3ee1d98ca42565612f32b89eb72f7a563acd7eafd539219fe95d9e4`.
These two aggregates encode path-sorted `[path, sha256]` pairs as JSON plus a
newline. The main reviewer separately checked the Seedance polling timeout,
abort and cleanup delta; its 42 targeted Provider regressions passed against
fresh isolated TypeScript output.

The final Desktop re-review independently checked the 40 recovered inputs,
all retained keys, local toolchain admission and the exact record proposal.
Its fixed-order 22-input Desktop delta aggregate is
`e73117bb876f7f7be5a1d9501f3e8f7ce0f054efe9f00264bd0591383a5dae59`.
The reader exercised the real validation functions without writing approval
files: the exact proposal and fresh evidence passed, all 40 stale-input probes
were rejected before observation, and an incorrect compiler version failed.

These are independent contexts on the same model host, not human or
cross-model approval. An attempted Claude Code outside review was unavailable
because authentication failed; it supplies no approval or clean-review claim.

## Findings and corrections

The first Desktop decision was `REQUEST_CHANGES` for two reproducible blockers:

1. The default local packaging reader called the toolchain observer without
   approved profiles. Its intentionally non-executing observation returned
   `compiler.version=null`, while fresh native evidence contained a version
   string. The exact evidence comparison therefore rejected a valid local
   build. The caller now passes the existing approved profiles and header
   digests. Identity checks still precede compiler execution, the admitted
   compiler's actual version is checked, and evidence equality is unchanged.
2. The fixed inventory omitted 40 reachable inputs, including nine old approved
   entries that were still imported. They are now explicit fixed inputs. All
   1,544 old approval keys are retained; no build-time dependency discovery,
   approval generator or automatic digest refresh was added.

The regressions were added and run before either correction. They reproduced
the real record/keyset mismatch, missing inputs and null-version failure.
The corrected default local lane passes its positive fresh-publication test
and rejects unreviewed compiler/SDK/header identities before compiler execution,
invalid profiles, a wrong reported version and changed native sources. Existing
strict-lane, private token, immutable-record and final-byte checks remain.

The test suite now also reads the actual committed-form Office record and checks
every packaging/native key and current digest without relying on a host
toolchain or synthesizing a replacement approval. Each recovered input is
covered by stale-byte rejection tests.

## Fixed closure and scope

The Babel 7.29.8 TypeScript AST audit retains all 43 authored roots and expands
literal runtime imports, value re-exports, `import()` and `require()` calls.
It resolves authored workspace exports and `dist` paths to the pinned source
inputs while retaining the established nonrecursive Main/IPC boundary.

The final fixed inventory contains 1,706 unique inputs. The audit parsed 1,630
authored files, reached 1,639 files and resolved 5,258 authored edges among
6,368 literal loads. No reachable input is missing, no authored import is
unresolved, no parse error remains, and no old approved input is removed.

Four nonliteral loads have separate boundaries. The existing archive reader
and Builder configuration retain their fixed selections. The two LanceDB loads
are optional external opt-ins, disabled by default: a configured provider may
execute in the Host, but its vendor/generated/native bytes are not included in
this source approval or the locked dependency graph. Pinning the authored loader
does not approve an arbitrary configured module.

## Adopted source record

The exact-byte proposal was adopted only after the final Desktop approval.
It changes only `packagingSha256`: 350 old digest replacements, 162 added keys,
1,194 unchanged keys and zero removals. All 15 Office native inputs are unchanged.

| Input | SHA-256 |
| --- | --- |
| Previous Office record | `ac04e808149c55823e0fcd3826c4d28e98f0debcd98949238c87abba4d173f67` |
| Adopted Office record | `c6484690321c00509a63967756415899e1200b1570b3e49b93c6195a0e610ecf` |
| Retained sandbox record | `40179954f462a0a3b20df46324d8db4b0e2830a1430aae761c3935a17a94b4ec` |
| Final fixed inventory module | `7855899507a5a9154100726dc96a724afeb93d5f0c8294f1af4d48ca00448eb3` |
| Fixed-order packaging aggregate | `2a96fa510a210b50aa723ae0be59124148f7f7b1bf5cc336e07dbc23c4fa9ae4` |
| Unchanged Office native aggregate | `9c5f6a1a05fe63ab96de941432ec13166af8974ec52730934d5ac348c41a854e` |

The last two aggregates encode fixed-order `[path, sha256]` pairs as JSON plus a
newline. Schema, protocol, deployment target, headers, runtime, toolchain
profiles, signing and trust fields are not changed by this rebinding.
The prior codesign repair restores the exact historically reviewed primary
Darwin 25.6.0 row, retaining the separate Darwin 27.0.0 row. It removes the
duplicated OS identity without inventing a new approval or dropping either
previously reviewed platform.

## Verified evidence and limits

- All 1,871 adjacent source-input/projection/emitted-output, toolchain, authored
  import, hook, ASAR, archive, human-QA-lane and codesign publication contracts
  passed, with no failures or skips. Real esbuild is used where specified;
  synthetic native/signature fixtures are not final artifact acceptance.
- The complete Office publication suite passed 207/207 with no failures,
  cancellations or skips. This includes the actual record/keyset/digest
  regression, all recovered-input stale-byte checks and the default local lane.
  Synthetic compiler/signature cases remain contract tests, not signed artifacts.
- A fresh Office native build used the already approved local Xcode 26.6 /
  macOS 26.5 SDK profile and reviewed N-API headers. Primitive/publication/readback
  tests passed 48/48 under Node and 48/48 under actual Electron 44.9.1, with
  identical before/after source fingerprints and no skips.
- Actual Electron remains 44.9.1 / Node 24.22.0 / libuv 1.52.1. No runtime,
  compiler, SDK, header or OS profile is newly approved. The unreviewed default
  Command Line Tools installation is not substituted for the approved Xcode.
- Locale generation from all 55 catalogs was repeated twice. All 57 generated
  outputs were deterministic and byte-identical to the reviewed inputs.
- After adoption, the AST audit found all 1,706 entries unchanged against the
  record, with no missing input, unresolved authored import, parse error or
  removed approval. The record SHA-256 and fixed-order aggregate match the
  independently approved proposal exactly.
- Both the strict source reader and default local reader passed with the actual
  approved Xcode, SDK and headers, without observer mocks. Both accepted the
  freshly compiled native evidence; actual Electron runtime identity matched
  the existing record. Validation did not alter the approval file.
- The real codesign reader accepted distinct Darwin `25.6.0` and `27.0.0`
  identities, with no duplicate OS release. All non-packaging Office policy
  fields and all 15 native source digests remain identical to the prior record.

## Final scoped verdict

The development-packaging source prerequisite is independently approved,
adopted and verified, with no remaining blocking finding in this scope.
This does not certify the complete repository or hosted CI. No commit, push,
App, ZIP or DMG was produced or accepted by this source review. Signature,
protected-stage, Core-safety, notarization, clean-machine and GUI acceptance
remain separate checks, with no safety axis promoted by these source/test
results.

## Main integration follow-up

The fast-forward to main `d7227c83af77daf237e85845961cb54511d681f8`
changed one of the 1,706 pinned packaging inputs:
`packages/daemon/src/features/conversations/routes.ts`. Independent Codex reader
`01a19baa-9fcf-7972-9c42-4444e41a02cf` reviewed the complete route and its
permission-contract delta before returning
`APPROVE_SCOPED_DEVELOPMENT_PACKAGING` for that single replacement:

- Previous digest: `eaedfb788aa45c7dd1f82b06cbf848de4e2a9a6e6b09a6e6d93cbf1a8f3cefce`.
- Approved digest: `62120da8bc9bc780d2f67d2e68e2c9bb6da2ebe3dff5625a767d2cc029c16c68`.
- Updated Office record: `f16a4ac0080c6e52d7425001fb263da964cd96921f6e14f37d69f83ce1b73c52`.
- Updated fixed-order packaging aggregate: `a41c8aba22f80bcc823a2b268c80440741f697e989d9fe2be26b8a2addc8ad51`.

The route adds explicit permission-contract version checking and propagates
schema version 2. Validation still occurs before conversation creation or
execution; legacy compatibility and explicit full-access confirmation remain.
The reader checked all 1,706 digests and found only this mismatch, but did not
run tests or a build. The parent adopted exactly the approved value and verified
that all 1,706 current input digests now match. No other approval field, native
digest, runtime, toolchain, signing or trust axis changed. Earlier test results
above describe the pre-integration snapshot, not a hosted CI result for this
integrated revision. Final remote acceptance is a separate merge prerequisite.

## Main 0.2.1 integration follow-up

The subsequent fast-forward to main
`3cab8088d5bde474e990148f9c93d6c8ee422e9c` retained the upstream 0.2.1
release metadata and sandbox review correction. Independent Codex reader
`01a19c55-5924-7231-b6e9-38b1436b18bf` read the complete Desktop manifest
and confirmed that its only upstream change is `version: 0.2.0 -> 0.2.1`.
Scripts, dependencies, entrypoint, build hooks and signing settings are unchanged.
The existing CI/security changes in the root manifest are separate from this
single-input decision.

The reader independently recomputed all 1,706 fixed input digests, confirmed
43 unique roots, no duplicate inputs or approval keys, no missing or extra
keys, and exactly one mismatch. It returned `ALLOW_SINGLE_DIGEST_REPLACEMENT`
before the parent applied this explicit replacement:

- Input: `apps/desktop/package.json`.
- Previous digest: `0432cb7fe2a9e637cdfdd1bb1368d5d238315f7c3b172338ab1f7f713706c52f`.
- Approved digest: `3da4c7d68ed543b5cdfca3042113db761c5bf9b9cbd9902be26fd55dad0c64cc`.
- Updated Office record: `3b6da167a1f7854a1e610ea484095b078160a38ceae6a0f35103eefae40f3bf9`.
- Updated fixed-order packaging aggregate: `47b7c19053d844277cd6a83d60846f6756a15e95a43e74ffb0c2aae2a484105b`.

All other Office record fields and native digests remain byte-identical to the
preceding approved snapshot. The parent rechecked all 1,706 current digests
against the replacement before adoption. This reader performed static source
and digest verification, not a new build, native/toolchain or Electron run,
GUI check, artifact acceptance or hosted CI. The preceding runtime test results
remain historical evidence for their recorded inputs. The approval still covers
only Darwin arm64, `unsigned_dev`, ad-hoc, `provider=false` source prerequisites;
no public signing, notarization, final artifact, deployment or release is approved.

## Main dependency integration follow-up

The merge of main `af6978a6a831b33839d6add511ac441f0c1e0f19` retains its
dependency updates. Independent Codex reader
`01a19d38-78e4-72d3-b448-3dfca6720f88` reviewed both complete manifests and
the merged lock graph before approving three explicit digest replacements.
The Desktop and Daemon manifest changes are dependency-only; their scripts,
entrypoints, hooks and signing settings are unchanged.

The first lock review requested removal of one unreferenced
`minimalistic-assert@1.0.1` snapshot without package metadata. The parent removed
only that entry. The same reader verified the exact deletion and the final
lock digest, then returned no findings for that fix verification and allowed
the lock digest replacement. All 1,467 snapshots have package metadata and
all 3,505 dependency references resolve. The nine security patches, 22 overrides
and Expo/MCP/zod branches are preserved.

| Input | Approved SHA-256 |
| --- | --- |
| `apps/desktop/package.json` | `12d420c1ed401229bd93981fa900165f0c6353899261d16bcc7d8784a49910d1` |
| `packages/daemon/package.json` | `72ec2f4d9364649d83a3ecbd9e2e5b2b6b22cca28507d4e93f484b9f4d747c6e` |
| `pnpm-lock.yaml` | `2277ac3be1d2745c47e074561c66e9150b4c5f4d17dcd95d34fbdd74c0936735` |

The parent adopted exactly those three values and recomputed every current
input, including the generated localization files: all 1,706 packaging inputs
and 15 native inputs match, with no missing or extra key. All other record
fields are unchanged. The updated Office record SHA-256 is
`2fbed48ef821f7bf4ef8b2a4ab277fc4685e437925823c8b093e2bedd8a0847a`;
its fixed-order packaging aggregate is
`bf77a3f9ba40691252abe36dedb06053b91e36f5df4d0beb7c049da122463727`.

This was a static, independent-context review, not a cross-model or human
approval. The parent separately completed frozen installation and the
15-workspace Daemon/CLI/Web build. The reader did not run tests, native tools,
Electron, GUI or hosted CI. Earlier test results remain evidence for their
recorded snapshots, not final-head CI acceptance. The source prerequisite is
still limited to Darwin arm64, `unsigned_dev`, ad-hoc, `provider=false`;
no signing, notarization, runtime or toolchain axis is promoted.
