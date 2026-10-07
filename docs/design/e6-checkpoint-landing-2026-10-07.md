# E6 checkpoint landing and continuation — 2026-10-07

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

Pending at document creation. Read the authoritative PR state, actual merge
commit and remote main before reporting a merge. A checkpoint merge is not a
deployment, product release, completion of Office creation, or completion of
the active goal. Record final merge hashes and continuation evidence separately.
