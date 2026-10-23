# P3 main Daemon delta — independent content review

2026-10-24. Reviewer: real independent agent `/root/p3_main_office_closure_audit`.

**Final selected-scope result: the one confirmed HTML reliability finding was repaired and independently rechecked on the final helper hash below. No confirmed remaining finding in these 12 Daemon source inputs. This is not whole-tree approval or package/GUI verification.**

## Superseding repair follow-up — 2026-10-24

The reviewer read the complete new 171-line helper and complete final 46-line security test after the
primary agent's repair. `readHtmlTag` now returns `next`, and all three scanning callers move forward
to it; malformed named tails cannot repeatedly rescan the suffix. Completed quoted tags and comment
boundaries remain handled, plain `2 < 3` and `x < y` survive, and script/style removal was not bypassed.

Final helper SHA256: `7f60e054030a40f98cc4f9af2eff4e7f2cec62c6e8ccd01748ad6514b64478c2`.
Final security-test SHA256: `1b1dc1886e68e202c5c2f2a22ca7fb8fc38bd5b9e7ec05788a436ea1d37f23c8`.
The other 11 source hashes in this report are unchanged in the final inventory.

An independent direct-authored-source probe repeated the four malformed scanner paths after repair:
120000 / 150000 / 120006 / 120014 input bytes completed in **1.307 / 1.470 / 1.088 / 0.635 ms**,
with comparison/comment/entity assertions passing, **actual exit 0**. An earlier supplemental probe
incorrectly required exactly one raw whitespace where this helper intentionally emits two before caller
normalization; its assertion was corrected without a production change, and is not claimed as a product defect.

Primary RED/GREEN logs were inspected: the old scanner's worker timed out at 2004.7 ms (one failure),
and the final four-file combination reports **27 passed, zero failed/cancelled/skipped**. The reviewer
did not rerun that suite or claim an independently captured parent-process exit code from its log.
These are `p3-main-html-budget-red-20261024.log` and `p3-main-html-budget-green-20261024.log`.

The reviewer additionally read the complete fixed-list/membership-test delta against `17af63ac`:
exactly the nine audited paths were added; roots and retained-byte/hash/source guards were not weakened.
Final fixed-list SHA256 is `be1e759cde00fe1f23e013bd965554738cb36b4791e7099cd1f83c3548dd34b3`.
This selected-delta review is not a fresh full read of all 1603 inputs.

The original finding and reproduction below are retained as history. Its open-gate wording is superseded
by this follow-up for the exact repaired hashes only. Final 1603-row/99-delta inventory is recorded in
`p3-main-office-closure-audit-final-20261024.json`; it is not an approved manifest or QA acceptance.

## Scope, baseline and custody

Authorized tree: `/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack`.
The reviewer did not implement or alter production files, update the fixed list/manifest, build/package, access real databases, send model/API requests or mutate Git. Only this report and the earlier inventory/provenance artifacts were written.

Scope is exactly **12 current Daemon production files**: six pre-existing changed files, five new work-summary files and the new shared HTML-text helper. There are five—not six—runtime files under `features/work-summary/`; with the shared helper these are six new inputs. Core sources/migrations and DMG custody remain other reviewers' scope.

For each of the six existing sources, SHA256 of `git show 17af63ac:<path>` was checked against the prior approved manifest and matched. This report reuses that recorded, previously full-reviewed baseline rather than claiming a fresh full read of the entire existing Daemon. The reviewer read **every line of the complete current main delta** from that baseline, then read relevant current caller/guard/helper/test context. The two small existing files `context-compaction-projection.ts` and `workspace-changes.ts` were additionally read completely. All six new files were read completely.

## Confirmed finding

### [P1] Malformed HTML can synchronously block the shared Daemon through repeated suffix scans

File: `packages/daemon/src/shared/html-text.ts:112` (readHtmlTag through line 138).
Affected callers: `findBodyContentRange` lines 70–89, `stripUnreadableHtml` lines 32–64 and `findClosingTag` lines 93–102.

`readHtmlTag` scans to the end when a tag name starts but no matching `>` is found. Each caller then advances by only one character and tries the next `<`. A string such as `"<a ".repeat(n)` therefore causes repeated scans of the remaining suffix: quadratic synchronous work, not a bounded linear tokenization pass. This is reachable from `extractReadableHtmlText(fetched.body)` in the real channel link-body materializer. Its default allowed link body is **1 MiB** (`materialization/budgets.ts:29`); the network abort timeout no longer applies once synchronous parsing starts.

The reviewer reproduced this using the **actual authored helper**, loaded with Node native TypeScript stripping, not copied/reimplemented logic and not a live external request:

| Input size | Measured synchronous time |
| --- | ---: |
| 3,000 bytes | 9.989 ms |
| 6,000 bytes | 27.265 ms |
| 12,000 bytes | 86.384 ms |
| 24,000 bytes | 425.895 ms |
| 48,000 bytes | 1,567.181 ms |

The 48 KB probe delayed a scheduled `setImmediate` by **1,568.509 ms** in that Node process. Both bounded probes returned **actual exit 0**. The 1 MiB maximum was **not** benchmarked; no larger-input timing is fabricated. Even a body much smaller than the admitted maximum demonstrably blocks the event loop.

Reproduction command:

```sh
node --experimental-strip-types --input-type=module <<'NODE'
import { stripUnreadableHtml } from "./packages/daemon/src/shared/html-text.ts";
const html = "<a ".repeat(16000);
const started = performance.now();
const tick = new Promise(resolve => setImmediate(() => resolve(performance.now() - started)));
stripUnreadableHtml(html);
console.log({ synchronousMs: performance.now() - started, setImmediateDelayMs: await tick });
NODE
```

Required repair: retain the unreadable-tag/entity safety behavior but make malformed-tag scanning monotonic with a bounded/linear work budget, so an unterminated tag cannot restart a full suffix scan at each later opening marker. Apply the guarantee across all three scanning callers, including body finding and closing-tag searches. Add malformed/quoted/unterminated long-input regression coverage plus the existing whitespace-closing-script and one-layer decoding cases. A fetch timeout, a smaller display `maxChars`, or catching the eventual error does not prevent the synchronous block.

This finding applies to helper SHA256 `7e1618867d99492f1fa3e4e2027215108581cad50ce88e4a6bdf39910703db4b`. A changed helper requires a new exact-byte follow-up review before this finding can be marked closed.

## Files and exact coverage

### Existing source deltas

| Source | Current SHA256 | Coverage |
| --- | --- | --- |
| `packages/daemon/src/features/conversations/context-compaction-projection.ts` | `864e2ff72cf2af7eca0c8bc3aa54130324aef31e20b02de703166888dfe5cbe4` | Full exact delta vs `17af63ac`, plus surrounding consumers; baseline SHA matched approved manifest |
| `packages/daemon/src/features/channels/link-previews.ts` | `d87e359dc8ac94dadf6263519e722ca703f800079244ee2effbd1095dfcaf73f` | Full exact delta vs `17af63ac`, plus surrounding consumers; baseline SHA matched approved manifest |
| `packages/daemon/src/features/channels/materialization/extractors/link-body.ts` | `eeecdf0ff22e53f14ded1d4965b188e0595575d0e6fba0f9cc5a2d7bffb9f4c5` | Full exact delta vs `17af63ac`, plus surrounding consumers; baseline SHA matched approved manifest |
| `packages/daemon/src/features/previews/workspace-changes.ts` | `911aa998f89e9bb0dc92614a7cc731d724b9a101e717ee1aa72838bb9addf314` | Full exact delta vs `17af63ac`, plus surrounding consumers; baseline SHA matched approved manifest |
| `packages/daemon/src/features/web/web-search-adapters.ts` | `4e4447bdc6d62f38723c60c6b2c1a387aeb9bc648063f6f08af108e4577ff6e7` | Full exact delta vs `17af63ac`, plus surrounding consumers; baseline SHA matched approved manifest |
| `packages/daemon/src/server/router.ts` | `f29ce746d9507fb727ef98124ad6778005092a79254b071de8a725dc8ea2c6ae` | Full exact delta vs `17af63ac`, plus surrounding consumers; baseline SHA matched approved manifest |

All six baseline checks matched the corresponding manifest row. Their exact old/current hashes are also retained in `p3-main-office-closure-audit-20261024.json`; no source was silently accepted by following `dist/`.

### New sources read completely

| Source | Current SHA256 | Coverage |
| --- | --- | --- |
| `packages/daemon/src/features/work-summary/cache.ts` | `2e52b3b890ba2e5794f0a1efc16226c95e6fa06463f3d86dc207b76b71ec59a3` | Complete current file read |
| `packages/daemon/src/features/work-summary/git-summary.ts` | `536971ef4ce30127491831498f8658e0e37a5b79ec342bcc6de69f3313fd6d88` | Complete current file read |
| `packages/daemon/src/features/work-summary/pull-requests.ts` | `b1cc41a5d55fc7e1583783c07cd77a3c0df168aec42c7a6e7fdb3d726d3daa79` | Complete current file read |
| `packages/daemon/src/features/work-summary/routes.ts` | `f1a9f0dcca770af1852c7ef49a77b8f6991d1b881d9746881885476893d3bdfd` | Complete current file read |
| `packages/daemon/src/features/work-summary/service.ts` | `d81d750e08f96ab7ece9fa190b919e2cd6bd9de640f1dee6e11b7e95c2d89c93` | Complete current file read |
| `packages/daemon/src/shared/html-text.ts` | `7f60e054030a40f98cc4f9af2eff4e7f2cec62c6e8ccd01748ad6514b64478c2` | Complete current file read, including final scanner repair |

## Behavioral/content checks performed

- New work-summary HTTP routes require explicit `cwd`, run the existing origin/trusted-workspace guard before store access, use only `getInitializedStore`, and bound PR POST bodies to 4096 bytes. The six-line router insertion delegates all methods to these guarded routes.
- Work-summary service uses the project store, caps thread/channel/direct collections at 500, deduplicates canonical worktree paths, inspects at most 20 paths with four-way concurrency and exposes truncation. Direct bindings are used only for direct threads; channel references do not become private-thread bindings.
- Git summary uses the existing bounded 15-second/1 MiB Git executor and disables configured fsmonitor/hooks for its read commands. It limits untracked reads to 200 files, 1 MiB per file and 8 MiB aggregate; partial scans suppress claimed complete line/file totals. Unborn/detached branches, binary data, renames and staged-delete/restored paths were checked against the current tests and code.
- PR URLs are canonicalized and restricted to HTTPS github.com without credentials/ports and a positive safe PR number. Tokens are only used against the fixed api.github.com origin with redirect rejection and an 8-second timeout. The in-memory cache scopes values by normalized PR URL and token hash; failed reads are not cached as successful zero snapshots. The related SQLite attachment store bounds stored PRs to 30.
- Summary CI derives from the returned head SHA and keeps absent/paginated checks unknown; it does not turn missing authentication into success. Real GitHub/API availability was not tested.
- Context compaction now validates the linked turn before recording the earliest assistant anchor, preventing another turn's stale item from consuming the run's anchor. Existing blocked/failed/revision/source-ref behavior is unchanged in the delta.
- The changed workspace diff path uses the net HEAD-to-final-working-tree baseline and preserves opaque/binary/truncated entries; staged/unstaged reversal does not double-count lines. Existing path resolution guards remain in place. No claim is made that every pre-existing filesystem race or protected-host actor boundary was re-audited here.
- HTML entity decoding is single-layer with explicit named sets and valid numeric codepoint checks. The new HTML scanner removes whitespace-terminated script/style blocks, but its malformed-input complexity finding above remains open.
- Generated localization outputs were checked in the separate inventory audit through exact reconstruction from the compiler template and current catalog data. All 55 locale outputs and both generated entry modules matched. This is generated-source provenance, not 55 separate manual translation reviews.

## Supporting sources and tests inspected

Read in current authored form: `shared/local-workspace-access.ts`, `previews/workspace-file-preview.ts`, the Git executor entry/helper in `workspaces/managed-worktrees.ts`, `core/storage/sqlite/work-summary-store.ts`, `contracts/src/work-summary.ts`, materialization caller/budget context, and the changed HTML-link/web-search call sites.

The following tests were read completely; this reviewer did **not** rerun their full suites or use their source alone as runtime proof:

| Test | SHA256 |
| --- | --- |
| `packages/daemon/test/work-summary.test.mjs` | `bc6e3a103eb43c6b63d119aaec0506685890df4b2e2e207af95168bd90b3e5b3` |
| `packages/daemon/test/work-summary-routes.test.mjs` | `5d7e204f2036a3032f640102e36da5716914e72ba47a9f25bb00f8b0e2f9a676` |
| `packages/daemon/test/html-text-security.test.mjs` | `1b1dc1886e68e202c5c2f2a22ca7fb8fc38bd5b9e7ec05788a436ea1d37f23c8` |

The pure-helper malformed-input probes described above are the only new runtime execution performed by this review. No build, production network request, live Daemon/App scenario, model invocation or database operation was performed.

## Limits and remaining gate

This is selected **Daemon content-delta** coverage, not the earlier inventory-only audit and not a new full-content read of all 1600 inputs. Dedicated Core/migration, DMG, generated-provenance and source-list review coverage must still be joined by exact final hashes. The helper finding must be repaired and independently checked on new bytes. Only then can the primary agent freeze a new QA-only review packet under standing authorization. Nothing here authorizes release or substitutes for actual macOS packaged GUI acceptance.
