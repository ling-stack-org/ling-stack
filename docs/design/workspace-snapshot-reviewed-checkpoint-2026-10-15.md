# A25 — Reviewed snapshot recovery checkpoint

Date: 2026-10-15. Baseline: local A24 commit `185c4745`.
This record supersedes the candidate design's pending-validation status for the
exact frozen input below. It is not overall E6, Office or GUI approval.

## Implemented contract

Record each attempted path before its first mutating call; verify kind, digest
and recorded permissions after apply and rollback. Ordinary failed requires all
planned paths to match their complete before state with no unresolved journal or
ownership error. Unknown partial/external states retain recovery_required,
journal, blob preimages and the currently owned recovery fence. No forced rollback.

Post-fenced request/journal publication atomically checks state plus request/fence
owner and epoch. Cleanup releases only its exact acquired owner/epoch. Successful
all-after reconciliation releases its own epoch only after its committed CAS.
Initial claim remains state-CAS; no new cross-process atomic claim is promised.

Queued workers wait on the actual prior local lock promise and recheck before
acquiring. Only an acquired queued operation can terminalize its own preflight
failure. Direct calls retain immediate 409 busy rejection. Same-request replay
does not repeat file effects; independently accepted waiters revalidate and
settle instead of becoming orphan requested rows. No new scheduler or table.

## Root actual verification

Contracts, Core and final Daemon TypeScript builds each returned actual exit 0.
Final eleven complete related files: Core two + Daemon nine, **38/38**, actual
exit 0, 3976.459083 ms; zero fail/cancelled/skipped/todo.
Current Desktop source-input regression: **364/364**, actual exit 0,
13746.568458 ms; zero fail/cancelled/skipped/todo.

Before/after 24-path source/design/test/inventory/dist manifest content is
identical, SHA-256:
`e55aa45f544e42e673f0d5550df1d4a65a3e2657145a0e5d666419dd20c931f9`.

| Evidence in output/e6-20260928/a25-20261015 | SHA-256 |
| --- | --- |
| final-complete-snapshot-matrix.log | 49b71e87b0fefe03dc6a982d67ea0d64c1eb3a1da33d0a1c631f2a14d66cb2d7 |
| desktop-final-current-source-inputs.log | 75a84cd66834e1beeee5ea85c1ac5e5aadfeb2800c8d5fbc747d38b967c2ae5f |
| final-independent-review-20261015.md | 4797336c344be66c52a94dff00a7788d859b240d3aecd4147c7567a9ab8b7c24 |

Root fully read and hashed the independent final report: scoped pass, zero
confirmed remaining findings, approved=false. The reviewer did not implement
the products and explicitly excluded their own public 299-line test from
independent test review. The original public/Core/independent regressions remain
unweakened; first RED logs and earlier matrices are separate, not extra final tests.

Desktop used real esbuild with 4107 runtime inputs, 1212 authored workspace inputs,
and zero runtime inputs from nine workspace dist trees. Native compiler/codesign
were synthetic; artifactExecuted=false. This is not packaged App acceptance.

## Boundaries and continuation

No new table, real data/credential mutation, main CI check/enable/wait, release,
Office approved record, reset, clean, stash, force push or unrelated writer change.
The restore coordinator remains a large single-feature file; no broad rewrite.
No kernel-atomic SQLite/filesystem transaction, ACL/xattr recovery, Full Access
isolation, strict FIFO, cross-process queue or actual crash-kill guarantee is added.

#549 was already merged to main `5da1152d`. A23/A24 and this successor are local
checkpoints only until separately pushed/merged. A26 accepted-plan history/CAS,
A18 controlled OS race, other named repairs, concrete Office user approval,
fresh QA package and twelve-class real macOS GUI acceptance remain open.
No unresolved product decision for this bounded A25 repair; total E6 goal active.
