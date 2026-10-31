# E6 main integration checkpoint — 2026-10-26

## Scope and status

Only `ling-e6-continuation/ling-stack`, branch
`codex/e6-safe-continuation`. Integrate main `4ca3f9de16903cdfb4b89322dfcbcf690a1ff861`
into pre-merge `083b5148c7c405914d0332d55c99be133fab45ea`.
Backup ref: `codex/e6-pre-main-20261026-083b5148`.

This is a source checkpoint, not E6 completion, new Office approval, a new QA
package, remote PR merge or release. Main CI remains disabled by user policy.
The unrelated `apps/web/.catalog-consumer-4gQEBm/` is not part of this work.

## Resolved integration boundaries

- Keep DMG custody strict for the owned image. Unrelated APFS multi-disk and
  kernel Cryptex inventories occupy devices without acquiring detach authority.
- Preserve authenticated Builder-skipped paths, including directory segments;
  reject Builder macros before copying literal authenticated files.
- Preserve local-bounded and hosted-ephemeral storage as explicit, independently
  checked policies. Pin hosted receipt `mountPath` to the live canonical path
  before a recorded path can select the lease-lock location.
- Keep detached stage hashes, browser roots and both actual browser acquisition
  routes. Use the shared non-overwriting publication helper. Its regression
  verifies that another writer's `KEEP` and both error causes survive failure.
- Keep the original directory-output parser unchanged. The candidate pipeline
  uses `build-shell-parser-binary.mjs` for binary/provenance output. Both use the
  E6 allowlisted compiler environment. Binary builds verify copied inputs before
  compilation, build twice and reject input/output drift.
- Remove exactly 133 duplicate fixed review-list entries. Keep all 1,621 unique
  paths, first occurrence order, and every unique input from both parents. The
  existing uniqueness and exact-key assertions were not weakened.
- Native max/ultra levels remain distinct through contracts, request persistence,
  continuation recovery, Runner adapter and Web selection.

## Executed verification

Evidence root: `output/e6-20260928/p5-main-integration-20261026/`.
All commands, outputs, exits and checkpoints are preserved under that root.

| Evidence | Actual outcome and limits |
| --- | --- |
| 001 | Frozen-lock installation exit 0; no lock rewrite |
| 002/003 | Initial/replayed native baseline: 195 pass, 1 obsolete boundary-extraction failure |
| 004/005 | Binary environment and copied-input regressions RED, exact replay retained |
| 010/011 | Hosted receipt-path mutation RED, exact replay retained |
| 018 | Final conflict-adjacent native checks: 202/202, exit 0 |
| 007 | Fresh Daemon/dependency build exit 0 |
| 008 | Fresh-build reasoning/recovery/browser/security contracts: 126/126, exit 0 |
| 009 | Web consumer/dependency typecheck exit 0 |
| 014/015 | Duplicate review-list baseline/replay: 220 pass, 17 fail, 3 skip |
| 016 | After exact deduplication: 339 pass, 0 fail, 3 skip, exit 0 |
| 017 | 106 changed/new script syntax checks and immutable provenance, exit 0 |
| 019 | Desktop Main/preload/renderer typecheck exit 0 |

The three skipped browser-publication pipeline cases require their managed
resource lease; they are not acceptance passes. Compiler/signature and hosted-job
identities are synthetic where stated by the fixtures. These checks do not prove
real parser/resource builds, native package signatures or GUI behavior.
007–009 preceded the later resource-script/list corrections; their narrow actual
outcomes are historical evidence, not fresh full-combination acceptance.

Independent read-only review found the hosted `mountPath` gap, confirmed its
repair, and then confirmed exact duplicate-only removal and preservation of both
parents' unique inputs. No remaining confirmed issue in the specified conflict
scope; this is not full content review of the new combination.

## Approval and live-client boundary

The approved Office manifest is byte-identical to pre-merge HEAD, SHA256
`9a5b4b066228e73650882ee050925c8be767f5b8b6d6b54861fdd480977c22ce`.
All 15 native source inputs remain unchanged. Of the 1,614 historical packaging
rows, 34 changed; the fixed closure now has 1,621 unique inputs. These deltas
require review, not an automatic hash refresh. The actual production reader
rejects the old approval with `packaged_office_native_source_review_invalid`.

Built-in Computer Use returned a locked Mac twice. No GUI input was sent, no
fallback unlock was attempted, and N01 remains `not_run`. The retained App and
its history/unknown execution states were not stopped, overwritten or migrated.
N03's thirteen turns/task/reopen proof remains accepted for its original package;
do not replay it or pretend it validates a package built from these new inputs.

## Continue without restarting completed work

1. Preserve this local merge checkpoint and verify its parents. No remote PR
   creation/merge or release is implied by saving it.
2. Carry out delta-specific Office/resource review and determine which P1/P2
   proofs the new input identities affect. Do not automatically repeat all old
   suites, nor inherit approval from either parent.
3. After manual macOS unlock, continue only still-missing P3 real-client cases.
   Keep R03 unknown effects and retained Hosts untouched; full safe restart is
   still unproved.
4. Continue P4 H09 only with a provider path that proves the hard output cap.
   Do not silently send paid evaluations through the known uncapped CPA route.
5. Finish P5 final review/PR/verified remote merge after required gates. Windows,
   global gstack upgrades, main-CI enablement and publishing remain out of scope.
