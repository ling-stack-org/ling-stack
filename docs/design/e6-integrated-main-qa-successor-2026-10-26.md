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

This execution wrapper is **not implemented or reviewed yet**. It must first
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

## Direct continuation

1. Implement and independently review the owned-scratch, non-overwriting
   successor path. The exact source/runtime/OS proposal review and scoped
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
