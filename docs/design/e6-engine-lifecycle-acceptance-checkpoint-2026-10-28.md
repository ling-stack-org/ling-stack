# Engine lifecycle acceptance checkpoint — 2026-10-28

This is a source/checkpoint status, not a declaration of completed E6 or GUI.
The implementation has moved to `ling-design-parity/ling-stack` on the same
`codex/e6-safe-continuation` branch. Current increments and QA input bindings are
recorded in [the 2026-10-29 checkpoint](design-parity-implementation-checkpoint-2026-10-29.md);
the evidence below remains the historical 2026-10-28 result.

## Saved repairs

The original engine view/Host lifecycle race fixes are `8cd5db5f` and `3de11693`.
Independent review then found two follow-ups, each now saved and pushed:

- `5ec88864`: finite operation-specific client budgets: discovery 20 seconds,
  install 5 minutes, ordinary management requests still 10 seconds. The same
  cancellation, authority, synchronous POST and no-automatic-retry contracts hold.
- `afd55a9a`: three literal managed-engine runtime sources explicitly enter the
  fixed Office review list. Registration does not itself approve source bytes.

The focused regression had two unchanged RED runs (1 pass / 7 fail), then 8/8
GREEN. Existing API neighbors passed 16/16. Required full adjacent API + Office
source/publication matrix subsequently completed **1,559/1,559**, exit0, in
capture007. Old capture004 remains incomplete and retained, not rewritten green.
Its unchanged native command was rerun with a finite 180-second command budget;
no assertion was relaxed. Native compilation/signatures in that matrix are
synthetic; real esbuild/source/publication checks are explicitly distinguished.

Capture008 passed the five API/Daemon/Web/Desktop main/preload TypeScript
projects. Desktop tsc emitted twelve untracked auxiliary JS files. Since the
preflight showed none existed before this check, Root recoverably moved only
those exact owned emissions into the evidence directory, comparing bytes before
and after. The unrelated catalog fixture was preserved. This is not cleanup of
user source, and future Desktop type-only checks should use `--noEmit`.

## QA-only frozen input map

The independent exact map closure covers 1,641 packaging sources: three added,
60 changed (55 generated catalogs and five other sources), 1,578 unchanged,
none removed. The 15 native sources remain unchanged. Prior full content review
of unchanged inputs is reused; only real changed-input coverage is claimed.

Under the user's existing isolated-QA standing authorization, only the formal
row's packaging map changed. The proposal remains `approved:false`.
The unchanged reader actually accepts full-row SHA256
`756adde96bfdb69a5915e106f43ae1459b0961a90a81d02f20bfb346ba98af85`.
This does not permit a signed/notarized public release.

## Remaining acceptance and merge boundary

The old App was source `3d5b0174`, not these repairs. It was normally quit through
the built-in Computer Use native menu; Main and launcher each exited0, with the
owned processes and port17928 subsequently absent. The old failure evidence and
profile history remain intact. Whole-output preservation and the new reviewed
package are still separate steps; no new GUI pass is claimed here.

Finish current-byte review, a fresh package, then affected native single-file,
ask-first, scope/recovery/final ownership and engine-settings cases. After those
required gates pass, prepare/review the PR, merge, and read back actual remote
main. Do not add new features to this batch. Any remaining E6 work must be listed
as unfinished, not silently called complete by a checkpoint merge. Do not
activate main CI, publish, upgrade global gstack, or test Windows.

Detailed receipts and reports live in
`output/e6-20260928/engine-lifecycle-successor-20261028/`.
