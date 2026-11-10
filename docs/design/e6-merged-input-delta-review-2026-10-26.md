# E6 merged-input delta review and toolchain repair — 2026-10-26

Status: source checkpoint and scoped real build evidence; not E6 completion,
new Office approval, packaged GUI acceptance, remote merge or release.

## Frozen baseline and independent scope

Merge baseline: `d63f8a6b709572167625243af3e4706ba2515a0c`, integrating
`4ca3f9de16903cdfb4b89322dfcbcf690a1ff861` into `083b5148`.
Evidence directory: `output/e6-20260928/p5-merged-input-review-20261026/`.

The unapproved `frozen-inputs.json` has SHA256
`c1c5a725c1cd184abb94338d4809a15fee1f8a4466fba51323e5c60ca4668d9e`.
All 15 native Office inputs are unchanged. The 1,621-path packaging closure has
34 changed and seven newly included inputs, zero removals, and 1,580 unchanged
inputs. Newly included in the closure does not necessarily mean new to Git.
The packet also preserves 40 resource inputs and exact current/previous copies.
It is never an approval or an updater of the existing approved manifest.

Independent review is split between desktop/build boundaries, runtime/catalog/
lockfile behavior and resource producers. All three reports are complete.
Desktop review found the P2 below, now repaired and independently rechecked.
Runtime review found no confirmed issue in its assigned 24 inputs. Resource
review read all 41 current inputs to EOF and checked their previous delta, with
no confirmed finding; its report SHA256 is
`0be750f8c5de701896a96fe7c5e836014c03aa0c159cffc26386431d7c390d7d`.
Its own-proof matrix permits reuse only for the original verified object and
identical source content, not new compiler/recipe/download-mode/GUI acceptance.
The runtime lockfile coverage is complete parsing, graph/delta checking, not a
claim of manually rereading every unchanged dependency line. The original whole
content review remains applicable only to byte-identical inputs.

## P2: portable toolchain admission before execution

The new schemaVersion 2 reader previously launched tool discovery before checking
the native/packaging closure. Its observer executed the compiler selected by
`xcrun`/`DEVELOPER_DIR` before hashing and matching that compiler. A later rejection
could not undo execution. This was a latent build-admission gap: the retained
real approved row is schemaVersion 1, not an enabled remote-model exploit.

Repair:

- Validate the full native/packaging closure before discovery, and preserve the
  existing post-observation checks.
- Read compiler/SDK/header identities without running the candidate compiler.
- Validate all reviewed profiles, exact compiler/SDK identity and actual headers
  before allowing the bounded version probe.
- Rehash compiler, SDK and headers afterward, then match the actual version.
- Policy-free observation has no compiler execution authority; version fields
  are explicitly null rather than values obtained from an unadmitted program.

Exact reviewed repair inputs:

| Path | SHA256 |
| --- | --- |
| `apps/desktop/scripts/packaged-office-native-review.mjs` | `addac34a75f291d5c27fc048c54a2b0f0c1caa63231b3dea8423c754ef5d27b6` |
| `apps/desktop/scripts/packaged-office-native-toolchain.mjs` | `f1f063f77e8b0eb7fa8f864a992abaf851c20bd1bd643b428d5fae6bd766e674` |
| `apps/desktop/tests/packaged-office-native-publication.test.mjs` | `52f3c32531252c4bbbce99883ac11faa9f31c973505f481600a839ff9972d09b` |

`compiler-guard-red.tap` preserves three behavior failures plus one temporary
instrumentation-shape failure. The first name-filter invocation did not execute
the nested cases and is not RED or passing proof. Instrumentation now preserves
the original signing-counter shape. The final three-file combination completed
with actual exit 0: **1,497/1,497**, zero failures/cancellations/skips. It includes
five probe-time mutation/version cases and positive publication/token guards.
The independent repair supplement SHA256 is
`a663f1207c7ba09af73b94bf5a7159bbfeb92dda4a43be81e7c873d7daee8e5f`;
no remaining confirmed finding in that narrow scope. These tests use disposable
synthetic compiler/signature fixtures, not real package signatures.

This is hash-before-exec with revalidation, not atomic held-file execution or
protection from an unrestricted Full Access/same-UID host process. Compiler
dependencies, complete SDK/OS trust and final package acceptance are separate.

## Real source reproduction and runtime evidence

Managed source reproduction completed with actual exit 0, 23,941 ms. The exact
new source manifest is
`sha256:25e50f1790d789b85d7c99f808a41726f922029b5f8a92874383c9912fc0a384`,
producer adaptation `ling-deed66429fe06b1c16cc8e1af39c56467afd44aab233a3653ae2f102df923831`.
All 3,714 files and 57 skills verified without metadata substitution. Compared
with the retained old source manifest, every file record is identical: zero
changed/added/removed; producer identity alone differs. The original source and
executable selection remained unchanged. Only this invocation's owned scratch
was removed by its managed owner. This does not prove a new native/resource/
browser/executable generation or allow old compiled resources to inherit new
recipe/compiler review.

The installed Electron binary was absent after the frozen-lock install; the
official package loader downloaded its fixed binary. Actual Node-mode readback:
Electron **44.9.1**, embedded Node **24.22.0**, uv **1.52.1**, Darwin arm64.
Executable SHA256:
`ab18c7c9505311f76d8a34bac53a0bffa0e742f4673b002ad3c88314025ab841`.

Fresh standalone Office compilation used the original exact compiler, SDK,
headers and all 15 unchanged native inputs. Independent Node tests passed
**48/48**. First Electron tests passed 47/48: the confined actor selected Electron
without its Framework read roots because the probe omitted the already-supported
`OFFICE_LOCAL_TEST_ACTOR_NODE` setting. No product/sandbox policy was changed.
The original failure remains under `native-runtime-compatibility/electron/`.
Only Electron tests were rerun, with the documented standalone Node test actor,
against the same binary: **48/48**, actual exit 0, unchanged source fingerprints,
zero fixture residue. Compilation and the passing Node suite were not repeated.
Receipts distinguish real primitive/ABI evidence from Host containment or GUI.

## Remaining gates and direct continuation

The approved Office record remains byte-identical, SHA256
`9a5b4b066228e73650882ee050925c8be767f5b8b6d6b54861fdd480977c22ce`.
No source review was silently refreshed. Both old runtime rows still pin
Electron 44.8.0; the newly observed tuple therefore needs an explicit reviewed
rebinding before a new isolated QA package may rely on it.

1. Freeze the exact successor inputs after the completed three-way delta review,
   and apply only independently reviewed isolated-QA source/runtime binding.
   Preserve the original unapproved packet and its failed-input history.
2. Determine resource-proof reuse by identity and scope. Existing managed
   source/native/resource kinds already have two durable entries; do not delete
   retained generations, weaken the cap or multiply roots to evade the 12 GiB
   budget. The source-only scratch proof is not a new selected executable.
3. Build a non-overwriting QA package without touching retained Apps/Hosts or
   unknown effects. Continue only missing P3 cases after manual macOS unlock.
4. H09 still needs an authorized provider path that proves the hard output cap;
   do not run the pilot through the already-known uncapped CPA route.
5. Finish requirement-level acceptance and final PR/remote-main verification.
   Main CI stays disabled; Windows, global GStack upgrades and release remain
   out of scope. No accepted N03 thirteen-turn case or R03 unknown effect is
   replayed by this checkpoint.
