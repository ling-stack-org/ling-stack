# E6 checkpoint landing and continuation — 2026-10-07

## Live continuation update — 2026-10-08

The earlier #518-open/close-plan snapshots below are historical. GitHub now
confirms #518 merged at `6d8ae30c`, contained in remote main `8335905a`.
Shell-quote 1.12.0, locked MCP SDK 1.32.0 and runner-pi Undici 7.29.1 are
covered. The aggregate still has its unstarted payment failure; this is not
an all-GREEN CI verdict or a merge performed by this continuation.

Dependabot automatically closed #512–514 and #517 and removed their head refs.
This continuation performed neither action. #516 is now a new Undici 7.30.0
upgrade, not the old covered 7.29.1 change, so it remains open. New #520 is not
approved for major migration. Do not replay the old close authorization.

Recovery pagination and scheduled ownership/phase admission are implemented
and pass fresh **52/52** combined regressions, the original **96/96** broader
neighborhood, all **18** workspace typechecks and Daemon build. The full
Daemon suite also passed **3600/3600**, zero fail/skip/cancel/todo. These are
checkpoint-base receipts, not certification of newly integrated dependencies. See
[the recovery checkpoint](harness-recovery-discovery-checkpoint-2026-10-07.md)
for original failures, the canonical Task fixture correction and exact limits.
The new remote Core test-fixture optimization does not modify Office production
code; missing-parent V2, source-review/signing and macOS packaged gates remain
open. Overall D0/E1–E6, U/T and Harness remains active, without release.

## Scope and user decision

Implementation stays in `codex/e6-safe-continuation` in the dedicated E6 worktree.
The root checkout and unrelated WIP are not implementation inputs.

The user requested landing the accumulated implementation, inspecting the other
open PRs, and then continuing the active D0/E1–E6, U/T and Harness goal. The user
explicitly accepted **checkpoint landing without a release**, while the Office
missing-parent creation limitation remains open. This is not acceptance of
failing CI, automatic source approval, or a claim of completed GUI acceptance.

Pre-repair PR #507 source head: `56cfc5df386467a79895c108fafd9a4f4cdb023f`.
Observed base: `9f54053e9ce36d10350bf2affd5fcdb694be56b6`.
At this boundary the accumulated diff was 1623 files, 206881 insertions and
12121 deletions, with 138 commits not in that base. The latest nine-file
source-input checkpoint is not the size of the accumulated work.

## CI evidence and repair boundaries

The branch subsequently integrated `main@69ed481a` (#511) through a normal merge.
Conflict resolution retains Node 22.22.1, four real macOS daemon shards, Linux
fail-closed contracts, the real macOS helper/Seatbelt lane and bootstrap evidence.
The new workflow contract tests retain all nine aggregation lanes, scanner
boundaries and unique step IDs; duplicated `policy` steps from the automatic
merge were removed. Local combined CI/scanner contracts pass 138/138 with zero
failures, cancellations, skips or todos. Markdown and public-safety checks pass.
This is local merge-integration evidence, not a remote complete CI result.

The next main update `328bb10a` (#515) is also integrated. Long-running Linux
and macOS jobs now honor cancellation; the quality gate still executes and
rejects incomplete evidence. The combined CI/scanner contracts pass 139/139.

PR #507 was moved from Draft to Ready to execute its complete CI tier.
Run `37578906324` executed real runners: common checks, dependency policy,
build, typecheck, unit/Web checks, Linux contracts, the real macOS helper and
Seatbelt lane, and daemon shards 1 and 3 passed. Daemon shards 0 and 2 failed;
the aggregate failed, and the run's final overall conclusion was `cancelled`.
It is **not** a complete CI pass. Its raw failure logs remain in the local E6
evidence directory; neither cancelled status nor subsequent results erase them.

Three failing daemon leaf cases were identified:

| Case | Root-cause boundary | Required repair evidence |
| --- | --- | --- |
| Original Office composition export contract | The module added fixed lease guards and an original-store runtime reader; the old exact export assertion omitted them. | Exact exports, fake/clone/getter/proxy refusal and no raw custody access remain asserted. |
| Protected Host source hooks | A captured prepared-binding check now rejects manufactured flags earlier than the older preparation check. | Assert the precise earlier error and zero physical/native launch for every refusal; do not accept arbitrary errors. |
| Real Office SDK bytes through SQLite effects | The V1 SDK publication fixture implicitly created missing directories after directory creator admission had moved behind verified authority. | Keep real SDK bytes, SQLite effects, hashes and closure assertions in a clearly existing-directory fixture. Missing-parent creation remains a separate open product gate. |

The daemon dependency graph was freshly rebuilt using Node 22.22.1 before the
targeted repairs. Final repair and complete CI results must be tied to the new
PR head; the old run and the source-input 400-test neighborhood cannot certify
that head on their own.

Root then ran all three repaired files together: **55/55 passed**, with zero
failure/cancellation/skip/todo. Independent owner neighborhoods were 100/100 for
the two authority/source-hook repairs and 209/209 for the writer/resource/replay
boundary. These overlap and are not added together. Production source was not
changed by these repairs. Markdown checked 298 files, public safety checked 4334
files, and whitespace checks passed. Complete hosted CI remains necessary.

## Other PR: dependency compatibility

PR #509 at `aec024d06cc156840dcd14d2bf77369d6f334fbb` had two actual CI root
failures: Mermaid 12 introduced an EPL-2.0 dependency rejected by existing
policy, and OfficeParser 8 removed the synchronous `toText()` API still used
by Ling. Expo 58 also required a native/module cohort different from the
unchanged Expo 57 modules and React Native version in that PR.

The dependency repair uses a separate worktree. It retains compatible upgrade
candidates while keeping Mermaid 11, OfficeParser 7.8 and Pi 0.84, and the Expo
57 / React 19.2.8 mobile cohort. Mobile explicitly pins React DOM 19.2.8 as a
development-only peer so optional Expo tooling cannot resolve a mismatched React
DOM 19.3 peer or add a web runtime dependency to the native-only mobile contract.
The shared conversation React package explicitly pairs its React/React DOM 19.3
development peers; the original dependency PR otherwise resolved a mismatched
React 19.3 / React DOM 19.2.8 pair and crashed eight UI test files.
Existing security overrides and patches remain unchanged. The major upgrades
are not claimed implemented; accepting EPL or migrating SDK/native APIs requires
their own review and tests, not a policy bypass.

## Open work after checkpoint landing

1. **Office missing-parent creation remains functionally blocked.** The original
   production route selects the V2 chain for missing ancestors. Missing reviewed
   native artifacts or unknown controlled-actor coverage reject before native
   write admission. Do not fall back to recursive legacy creation to hide the
   limitation. The existing-directory SDK positive is not this product test.
2. Finish controlled Keychain actor coverage, independent vendor/toolchain/SDK/
   default-signer review, actual production source approval and final signed
   App/ZIP/DMG validation. No production approved row is created by landing.
3. Finish the same-package Electron/CLI/MCP formats, Core lease barriers and the
   remaining twelve-category macOS Computer Use acceptance with actual package
   identity, screenshots, lineage and `simulation=false`.
4. **Harness recovery pagination:** the new recovery coordinator reads the same
   first 500 scheduled continuations and first 500 stale work units each scan.
   Skipped rows do not advance discovery. A cancelled Run can leave a prepared
   scheduled continuation that permanently occupies this prefix; enough such
   rows can starve a later eligible continuation. This affects explicitly enabled
   continuation recovery, not the default `off` mode. Repair bounded discovery
   with stable cursors or fenced retirement; keep existing admission checks and
   test more than 500 rows, duplicates, cancellation and restart.

Completed source-input/DMG checks, duration formatting, R03 and accepted right-side
UI repairs are not restarted unless a concrete new regression requires it.

## Landing result

PR #507 was normally merged at `097fecf41b9b446d12507a92d6fde49c30cad147`
on 2026-10-07. Independently read PR merge metadata and remote main matched.
The exact head `9095046fe14f521843fcdf84484bcaf5a8a114d9` passed all 13 jobs
of complete hosted CI run `37601272795`. No administrator bypass, force push,
history rewrite, release, or production source approval was performed.

Dependabot subsequently closed #509 and deleted its remote branch, then opened
#516 and #517. The timeline identifies `dependabot[bot]`, not this task, as the
actor. All authored compatibility repairs and ancestry are preserved in the
human-maintained successor #518. Its final head is
`3e90887a4f66d2ca936988102bc9596a785172a6`; the seven-file package/lock diff
also includes the compatible Undici 7.29.1 patch and its generated lockfile.
Main's source, `diff` dependency, runtime policy and CI settings remain intact.

The preceding combined baseline passed frozen install, license/security,
workspace build/typecheck, 921 UI/Runner/Mobile tests and 161 Office SDK/MCP
tests. Its hosted CI `37604911694` passed all 13 jobs at `4333d73a`. The final
Undici patch separately passed frozen install, Runner build/typecheck and
249 Runner tests, license and dependency-security regressions.

**#518 remains unmerged.** At final head, run `37608185769` executed and passed
all 12 validation jobs, including Unit/Web, four real macOS Daemon shards,
helper/Seatbelt and Linux contracts. Its aggregate quality job `112756258578`
failed before execution: `runner_id=0`, no steps, and the official annotation
states account payments failed or the spending limit needs increasing. The
overall run is **failure**, not green. Restore account availability before
rerunning only the failed aggregate; do not loop reruns or bypass this gate.
No failure log exists for that unstarted job; saved job metadata and annotations
are the actual receipts.

After #518 passes and actually merges, independently verify main and the locked
shell-quote 1.12 / MCP SDK 1.32 / Undici 7.29.1 coverage, then close #512–514
and #516 as authorized, without deleting branches. Retain #517 for major
migration: its real CI rejects elkjs/EPL-2.0 and Pi 1.0 API compilation. Those
major upgrades and all Dependabot security alerts are not claimed completed.

While awaiting that gate, a focused 501-row, equal-timestamp SQLite WorkUnit
pagination regression reproduced the existing repeated-first-500 discovery
defect. It is an original RED, not an implemented pagination repair or Daemon
dispatch/packaged acceptance proof. The bounded fair-recovery plan remains the
next implementation, followed by the still-open Office and macOS gates above.

The dedicated E6 worktree fast-forwarded to checkpoint main; the root checkout
and unrelated WIP were not changed. The checkpoint is not a deployment, product
release, completion of Office creation, or completion of the active goal.
