# E6 integrated-main QA successor — 2026-10-26

Status: implementation and bounded preparation, not package/GUI acceptance,
formal approval or release.

## Preserve retained execution and package identities

The existing three fixed Human QA App identities are still retained. They must
not be overwritten to test the integrated `main` inputs or the new runtime.
The added selector `LING_DESKTOP_PACKAGE_HUMAN_QA=integrated-main` chooses only:

- App ID `com.lingstack.desktop.human-qa.integrated-main`;
- product `Ling Stack Integrated Main QA`;
- output `release/human-qa-integrated-main`.

There is no caller-supplied path/name/config. The ordinary and all three old QA
identities remain unchanged. The same private fresh publication, default ad-hoc
signer, final artifact hooks, fixed arm64 DMG/ZIP and `publish: never` path still
apply. Derived-environment and config-time substitutions to/from every retained
lane are rejected. This helper selects an identity; it does not itself prove
that the destination is unused. The actual build wrapper must reject an
existing destination and preserve the old App inventories/process ownership.

Regression evidence under `output/e6-20260928/p5-merged-input-review-20261026/`:
initial RED 103 pass / 16 fail; final GREEN **119/119**, actual exit 0. The
independent lane report SHA256 is
`46603fc72eaadd8407c102976260be945fcab593e3c5638594bf639da4f90409`.
No real package was produced by these test-only loader cases.

## Newly verified OS mismatch

The previous formal sandbox row binds Darwin 25.6.0. Actual `/usr/bin/uname -r`
returns **27.0.0**; `/usr/bin/sw_vers` reports macOS **27.0.1**, build `26A434`.
The first successor freeze failed before emitting any proposal or changing a
formal record. It is not valid to update only the Electron version.

The original production observation module was run under the fixed, hashed
Electron 44.9.1 / Node 24.22.0 / uv 1.52.1. Its current root-owned system files
show changed OS release, sandbox backend, dyld profile and codesign bytes. The
fixed codesign template and exact taskgated XML binding remain unchanged.
Observation is only identity evidence, not capability/enforcement certification.

A fresh offline Rust 1.97.1 build completed with actual exit 0 on this host,
using the unchanged 19 sandbox native inputs. Rust tests: **26 passed / 2
explicitly ignored**. Parser/framing smoke: **18/18**. Those two root-only real
capability tests are not passing evidence and have not been executed. Existing
new-runtime Office primitive evidence is 48/48 under standalone Node and 48/48
under Electron with its documented standalone test actor; no product sandbox
policy was relaxed.

## Frozen candidate, not effective approval

`successor-proposal/packet.json` SHA256:
`704ffd88f12eafeb78abb1e07c20c85f98bdd680a6a23fed821dcb1452d62dc7`.
The packet permanently remains `approved=false, approval=null`.

- Proposed Office record SHA256:
  `d751993c28beffcf3d0fb30540a4fc38b204ac2c5e05539df3ad2b8a493f2e11`.
- Proposed sandbox record SHA256:
  `a72e7ab31621c27cd48cbe8f10356921ed0ceca74a4a844a7e2c26af728e854f`.
- All 15 Office and 19 sandbox native sources are byte-identical to their prior
  formal records. Compiler, SDK and four Node headers also remain identical.
- Packaging closure: 1,621 inputs, 35 changed, seven newly included, none
  removed; the sandbox entry intentionally hashes the proposed sandbox row.

The candidate records carry the prior schema's approval field but are stored
only as explicitly proposed evidence; they are not installed product records.
Independent successor review and an explicit application of the user's standing
isolated-QA authorization are required before either formal row changes. This
does not stand in for the user's system authentication or release permission.

That bounded application is now complete: the independent successor report
SHA256 is `acdf3024a9b195de8eb851b3e53b339166e9ccfb1160249376eb97653d85d650`.
`standing-qa-successor-binding-application.md` records the existing direct user
authorization, exact predecessor/candidate hashes and remaining limitations.
The two formal rows now exactly match the candidates above. Both original
production readers passed on the applied pair, actual exit 0 (15/1,621 Office
inputs and 19 sandbox inputs); `successor-formal-source-readback.json` records
the result. The proposal packet and both predecessor copies remain unchanged.
This is source admission only; it does not count ignored controls as passed or
authorize starting an unreviewed successor execution wrapper.

## Resource construction without evicting old generations

The same approved local-bounded resource root remains selected, with its 12 GiB
logical-byte budget, 20 GiB free-space floor, single-writer lease and two retained
entries per artifact kind. Do not delete/move old generations, alter their
manifest hashes, change roots, or increase those limits to fit a new candidate.

The original retained P1 executable was actually revalidated by the current
`readExecutableBundle` with its exact existing selection, actual exit 0:
manifest `42e8edca…`, 29,635 files, 2,872 ms. Its browser activation is
`package-relative-only` and it has no model-acquisition receipt. This is current
admission/own-proof of that old object, not new-recipe/download-mode acceptance;
the selection and original resource bytes were not changed.

The existing builders expressly permit invocation-owned scratch outputs. A
successor build can keep new source/native/resource/browser/executable stages
inside that one lease's scratch until the new QA App has copied and verified
them. The old durable stages and current selection remain immutable baseline
evidence. The output App is the requested packaged artifact, not a third
retained resource-stage generation. The ordinary byte checkpoints/watchdog
still apply to every intermediate under the resource root; this is not an OS
quota or protection from unrestricted same-UID/Full Access processes.

The execution wrapper is now implemented and independently reviewed within its
static scope, but has not been frozen or run. It must first
freeze its source, selected tools and predecessor inventories; retain exact
build/selection/publication receipts; reject pre-existing output; restore only
its own temporary selection; and settle its owned build processes before
owner-authorized scratch cleanup. Unknown cleanup/ownership must remain a
failure, not a reason to remove a lock or relabel an old generation. Scratch
source reproduction must be real; equal content must not be used to substitute
metadata or inherit new-recipe/native/download-mode acceptance.

One necessary prerequisite is now implemented and tested: the managed build
supervisor requires a final absence observation and direct close before scratch
cleanup; unknown/live/unfinished consumers retain the lease. Output failures,
including asynchronous EPIPE and paused-open CLI pipes, no longer bypass that
supervision. See `e6-managed-build-settlement-2026-10-26.md` for the exact 33-test
evidence and process-group-only limitations. This does **not** supply the
wrapper's remaining consumer inventory, selection/output ownership or container
verification, and no resource cache cleanup/build has run.

### Temporary selection ownership prerequisite

`qa-temporary-selection.mjs` now owns a temporary swap of the fixed selection
pointer, not approval of a bundle. It authenticates the existing lease, captures
candidate JSON bytes and the required lease environment before the first await,
pins the predecessor's inode/mode/exact bytes and checksum, and retains that
original node in an exclusive custody directory. Publication and restoration
use exclusive links; a foreign replacement is not overwritten.

Before moving the original pointer it creates a fixed scratch review hold.
`lease.release()` refuses cleanup while **any node** exists at that marker.
Successful process settlement alone is insufficient to remove referenced
scratch. Only a successful owned-pointer restoration removes its own marker.
Concurrent restoration callers share one promise, including a cached failure.
If restoration partially succeeds and then fails, the marker stays and recovery
requires explicit inspection; `restoration.json` is not standalone cleanup
authority. File fsync is used, but directory fsync/order under power loss has
not been certified. Controlled/cooperating writers are the scope, not arbitrary
unrestricted same-UID programs.

The two mutable-input tests failed before the fix (0/2), and the eight-caller
restoration fixture exposed seven racing failures before single-flight was
added. Final focused combination: **38/38**, actual exit 0, 26,940 ms, no
cancelled/skipped tests. This includes a real exited child with exit 0 and an
observed absent group whose persistent selection hold still prevents removal
of its scratch and lease. These tests use isolated fixtures; they did not swap
the real selection, clean the real cache, build a successor or validate a GUI.
The full wrapper and actual resource/package acceptance below are still open.
The independent ownership review is complete with no remaining confirmed
finding on these five exact source/test inputs; report SHA256
`1d69169032b39960a7422a3b29534243f36c083451a00bdab491195111b8e55e`.
Its earlier test-status cut is superseded by the final 38/38 tool receipt, not
by changing the report or claiming the reviewer reran those fixtures.

## Direct continuation

1. The failure-staging checkpoint and accurate source-only rebind below are
   complete. Save the archive-registry repair below and freeze the reviewed
   owned-scratch successor at the resulting clean HEAD.
   The exact source/runtime/OS proposal review and scoped
   standing-authorization application are complete; do not regenerate them
   without an affected input change.
2. Preserve all resource admission limits. Recompute exact logical capacity
   before native admission; scratch ownership does not waive its fixed 6 GiB
   reservation or the root's 12 GiB limit. Only independently verified,
   reconstructible cache cleanup may be considered, not old-generation eviction.
3. Verify new resource/compiler/download-mode behavior and actual package
   identity, then continue missing P3 GUI combinations. Do not replay accepted
   N03 thirteen-turn history or old R03 unknown effects.
4. H09 still needs a proven hard-cap provider route and genuine user system
   authentication for its human evaluation workflow. Final requirement audit,
   PR and remote-main merge remain open. Main CI remains off; Windows, global
   GStack upgrades and release remain out of scope.

Computer Use was refreshed through the built-in interface: application inventory
is available, but binding either the retained observation QA or ordinary Human
QA window returned server `-10005 timeoutReached`. No GUI input was sent, no
fallback was used, and this result is not proof of a lock screen or an App
failure. Continue non-GUI preparation instead of repeatedly touching old Runs.

## Failure-staging prerequisite and changed source recipe

Six builders previously removed their working inputs in unconditional `finally`
blocks, including after compiler/Git/render failure or timeout. They now retain
failed staging for the outer managed owner to settle. Source/native/resource
staging is inside `lease.scratchPath/tmp`, including artifact-output invocations;
normal success retains the original local cleanup behavior. `completed` is a
successful builder marker, not proof that every successful subprocess descendant
has drained. This change does not strengthen the controlled-process boundary to
whole-host or unrestricted same-UID containment.

The synthetic parser timeout regression failed before the fix (expected one
retained stage, actual zero). Final five-file focused suite: **23/23**, actual
exit 0, 460.872959 ms, no failure/cancellation/skip. This uses compiler/admission
fixtures, not real native compilation, artifact-output failure cleanup, OS drain
or GUI acceptance. Final receipt and independent review are in the existing
`p5-merged-input-review-20261026` evidence directory; review SHA256:
`39b495f18a428cbe700639616bc3dde4867307ad2691bdc0900d4a6abf9a9c27`.

Because the source builder hashes itself, the repair changes the recipe to
`ling-35d2bce87d68a986b352980d196e383a1ed1ea9bc6684d7edcc5d5a2ca64be5c`.
The reviewed pin remains unchanged. Next, genuinely fetch/render the fixed
upstream object under the original resource lease, retain its actual manifest,
compare every file record with the predecessor, review the changed producer and
actual object, and only then bind the accurate new source pin. The collector's
old metadata recovery is not new-recipe approval; the wrapper requires a real
source generation with `reconstructed === false`.

Wrapper and cache reviews are static scoped evidence, not an executed build.
No real cache cleanup, new resource build, new package or GUI acceptance follows
from this checkpoint alone. Prior 38-test selection and 33-test settlement
results remain valid and are not rerun without an affected-input change.

### Actual new source generation and binding

The seven-file repair was saved and pushed as `6b2a53dd`; remote readback matched
the full SHA. The source recipe preview then actually generated the fixed
upstream object under the same resource root. The v2 preview failed because it
omitted the production verifier's mandatory `expectedSkillIds`; its real exit 1
and failure log remain in `source-recipe-preview-run-v2`. No source pin changed
on that failure. The small preview correction passes the fixed lock inventory,
retains the actual manifest before verification and uses a distinct v3 directory.

V3 completed with actual exit 0, **20,162 ms**, direct child 74729 closed/exit 0,
POSIX group absent, output settled and lease released. The original builder and
the production verifier checked the full generated source. The actual manifest
is `sha256:46d0b73ac3efa12039ea2332f03782b9d940cdd47c3798bf99cd75406166f866`.
All 3,714 file records, 57 skills, and all non-recipe manifest fields equal the
previous actual object; `reconstructed` is false. Independent review rehashed
the manifest/recipe, deep-compared the complete manifests and checked the 212
input pins plus command/policy/settlement receipts. It did not claim to rehash
already released scratch file bytes.

`reviewed-source-bundle.json` now binds this actual new source and recipe only;
its historical pair remains documented and in Git. The checkout identity test
first failed with the old recipe (0/1); after accurate binding, it and the source
collector focused tests passed **7/7**, no failure/cancellation/skip, 154.505083
ms. That checkout conversion fixture is not Windows runtime acceptance. Neither
changed source-review file belongs to the formal Office packaging input closure.

### Archive-registry failure path repair

The archive collector previously created its internal temporary directory beside
the output and always removed it in `finally`. Its real `registryPlan(source, home)` launches an
inventory-bound Node subprocess with a 30-second timeout and uses that temporary
home. A failed/timed-out registry call has the same early-cleanup concern as the
six repaired builders. It now uses the same lease-scratch/failure-retention
contract: failed staging stays inside the authenticated lease's scratch, while
normal success cleans only after exclusive publication has completed.

The new fixture uses a real isolated local-bounded lease and artifact-output
admission, then injects `ETIMEDOUT` without starting a registry subprocess. The
valid RED failed because `home` had been removed; GREEN preserves its file,
checks its exact lease-scratch placement and empty artifact directory, and
confirms that explicit owner release removes it. An earlier fixture setup failed
on the macOS `/var` alias; canonicalizing that test path preceded the real RED.
The successful collection case also checks its captured home is removed, so the
old output-parent assertion does not become a vacuous cleanup check.

The three-file collection/inspection/materialization combination completed with
actual exit 0: **18 passed, 8 skipped, 0 failed**, 90,289.908125 ms; managed child
76087 closed/exit 0, group absent, output settled and lease released after
93,878 ms. The eight inspection cases require real resource/archive inputs and
are not passing evidence. The test-only success-home assertion was added after
that cut. The final targeted success/failure collector cases then completed
**2/2**, actual exit 0, 12,089.021625 ms; managed child 76353 closed/exit 0,
group absent, output settled and lease released after 14,233 ms. These are
synthetic archive/registry fixtures, not a real registry subprocess, download or
OS-descendant acceptance. `archive-registry-final-verification.json` retains
the exact cuts and actual receipt summary.
No source recipe input changed: the accurately rebound `ling-35d2...be5c` pair
remains current, so its real generation is not repeated for this collector fix.

Do not mechanically change the archive inspector: it creates its receipt-writing
stage only after all ZIP inspections have been awaited; no registry process uses
that temporary directory. The next fix must follow actual consumers, not merely
the presence of a `finally`. Source-only rebind does not grant native/resource/
archive/executable/packaged acceptance. No Go cache cleanup or new QA package has
run, and P3/H09/final PR/main merge remain open.
