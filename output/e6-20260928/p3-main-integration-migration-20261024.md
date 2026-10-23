# P3 main integration / migration evidence — 2026-10-24

Implementation tree: `/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack`.
Base local checkpoint `17af63ac`; merging verified main
`7bd33739852cec139822b33e12b4f8189b3964de` (PR585 and its predecessors).

## Confirmed cause and repair

Main used migration176 for work-summary PR bindings; E6 used it for delegation
budgets. Canonical work-summary188 and budget189 append history rather than
deleting or renaming either old176. Both source branches and all existing domain
facts remain. See the accompanying design for ownership and transaction details.

Independent review reproduced additional startup admission gaps: an FK-valid
ledger could contain invalid CHECK data, wrong Run/Attempt/artifact lineage, or
original reservations exceeding the frozen root/parent cap. Historical admission
now reuses runtime parsers plus integrity/FK and persistent relationship/cap
checks. It does not require transient spawning/reserved states, replay tools,
recalculate usage or mistake actual Provider overruns for invalid original caps.

## Captured actual exits

- Original new collision regressions: `p3-main-migration-regression-red-20261024.log`, exit1.
- First integration set: `p3-main-migration-regression-green-20261024.log`,48/48, exit0.
- Expanded marker/row-preservation set: `p3-main-migration-final-20261024.log`,55/55, exit0.
- Six invalid CHECK/ownership cases: `p3-main-ledger-data-red-20261024.log`,0/6, exit1,
  all caused by missing expected rejection, not fixture/import errors.
- Parser/lineage repair with migration, writer and Host bridge adjacency:
  `p3-main-ledger-data-green-20261024.log`,111/111, exit0.
- Real nested child released + parent settled + measured charge history:
  `p3-main-ledger-terminal-history-20261024.log`,1/1, exit0.
- Six original-cap overflow/NULL cases: `p3-main-ledger-cap-red-20261024.log`,0/6,
  exit1, all missing expected rejection. Final five-file combination:
  `p3-main-ledger-cap-green-20261024.log`,118/118, exit0, no skips.
- Final independent migration69/69 and Host custody9/9 both returned exit0.
  The reviewer additionally rejected a child charge above its parent allocation
  while accepting a legitimate measured Provider overrun. Final report SHA256:
  `f1aaab09ca7b1e3cc7f3b73e8525f76a065d63b20dcf7c2ac86a84d1aed7e6e4`.

Core, Daemon and Web integration builds returned actual exit0; the Web initially
failed because an opaque Host binding type pulled concrete SQLite declaration
dependencies into the browser. A pure type module fixes that declaration edge;
runtime WeakMap custody and permissions are unchanged. See
`p3-main-web-type-integration-20261024.md` for exact paths and hashes.
Shared UI chronology/summary/input adjacency passed135/135, exit0; Daemon
summary/compaction/HTML adjacency passed25/25, exit0. Localization audit passed
55/55 locales,6839 keys; both sides' catalog keys and translations were retained.

All database probes use fresh temporary Ling state/workspaces. The original
untracked daemon crash report and actual user/QA databases were not modified.
No PR, remote main merge, packaged GUI acceptance or release is claimed here.

## Additional main-delta repair and fixed packaging membership

The independent Daemon content review reproduced quadratic malformed HTML
scanning. Repeated incomplete tags exhausted the regression worker's2s budget on
the old source (`p3-main-html-budget-red-20261024.log`, actual exit1).
The scanner now returns a monotonically advancing cursor even without a complete
tag, used by body, closing-tag and text extraction passes. Complete quoted tags,
ordinary comparisons and single-layer entity decoding retain coverage; ambiguous
unterminated nested markup is not reinterpreted as trusted readable HTML.
Comments cannot supply a fake body boundary. Final Daemon typecheck exit0 and
HTML/compaction/summary combination27/27, actual exit0, no skips
(`p3-main-html-budget-green-20261024.log`). This is local parser evidence, not a
claim that all remote HTML/provider behavior has been validated.

The independent AST audit found9 real new authored runtime imports absent from
the fixed Office packaging list. Only those9 were added, growing1594 to1603;
type-only modules were not made runtime inputs. The new membership test failed
on the original list, actual exit1. The complete source-input suite then passed
1346/1346, actual exit0, no skips. This proves source/retention guards still apply,
not that new bytes have already received a formal Office hash or that a new
package has succeeded. Delta content review and the frozen QA packet remain
separate gates before packaging.

The Core/Providers delta review additionally reproduced Unicode case-fold offset
drift in MCP claim extraction. ASCII-only token search now reuses the existing
length-preserving helper for both scanning and warning line calculation. The
public semantic-profile regression failed before repair, actual exit1; the full
skill-source-sync suite passed14/14, actual exit0, and Core typecheck passed.
This fixes current source parsing, not a global GStack installation upgrade.
