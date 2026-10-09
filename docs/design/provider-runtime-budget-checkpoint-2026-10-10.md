# Provider invocation numeric budget checkpoint

## Scope

Continue Provider D1's actual **A** choice in the dedicated
`codex/e6-safe-continuation` worktree. Logical invocation/snapshot privacy was
saved in `3e1f57d1`; its Daemon complete suite finished 3846/3846, exit 0.
That is the preceding source's receipt, not a new full-suite claim for this slice.
The root checkout and independent delegation-storage WIP remain untouched.

## Implemented

- `prepared-input.ts` now shares one input estimator between the capacity
  check and invocation evidence: latest system prompt, tool definitions and
  conversation, with the existing ASCII/3.5 and non-ASCII-codepoint/1.6 estimate.
- The budget is sampled from the actual SDK context **after** tool-result
  capacity projection. It reserves the selected model's maximum output and
  the existing 512-token runtime overhead. It does not describe wire maxTokens
  or billed usage, and 512 does not answer H10's separate root-budget decision.
- Each admitted stream owns its immutable seven-field `contextBudget`;
  settlement inherits that exact snapshot. No prompt, tools, payload, path,
  credential or fingerprint is retained in the budget.
- Host copies only the exact versioned key whitelist, validates finite safe
  integers and budget arithmetic, freezes its own copy, and requires settlement
  to preserve the same seven values. Missing/malformed/mutated numeric evidence
  removes window-learning evidence, not the independent availability fact.
- Existing auth/header resolution, invocation identity/dedup, capacity failure
  behavior and normal unknown-proof execution remain unchanged.

## Actual verification

| Gate | Result |
| --- | --- |
| Actual SDK numeric receipt against old Runner dist | RED 0/1, exit 1 |
| Same actual SDK test after implementation | GREEN 1/1, exit 0 |
| New Host contract against old Daemon dist | RED 2/4, exit 1 |
| Same Host contract after implementation | GREEN 4/4, exit 0 |
| Runner author focused numeric/identity/prepared checks | 111/111, exit 0 |
| Root final joint Node 22 | 214/214, exit 0 |
| Root final joint Node 24 | 214/214, exit 0 |
| Root Runner complete suite | 359/359, exit 0 |
| Runner and Daemon TypeScript builds | exit 0 |
| Independent eight-file numeric review | no new P1/P2 |

All final test processes actually finished; failure/cancel/skip/todo counts are
zero. SDK contexts include Unicode, current system/tools, fitted large tool
results, invalid capacity, retries, summary and concurrent streams. Real Pi
orchestrator/loopback/SQLite and persistence guards are included in the joint
214. These are not an external-model or packaged GUI acceptance.

Root raw receipts live in `output/e6-20260928/`:

- `t13a-runtime-budget-host-red-20261010.tap`
- `t13a-runtime-budget-host-green-20261010.tap`
- `t13a-runtime-budget-joint-node22-20261010.tap`
- `t13a-runtime-budget-joint-node24-20261010.tap`
- `t13a-runtime-budget-runner-full-20261010.tap`

The actual SDK author RED/GREEN and focused logs are named
`provider-invocation-budget-{red,green-original,focused-green,final}-20261010-*`.
They are preserved, not rerun or renamed into successful evidence.

## Remaining production gate

The new budget foundation does not fix the old cache by itself. Core atomic
provenance/keyset and Daemon scoped fold/projection are the next slices. Then
reply/route/intent/reviewer/reconstruction and summary/tool/observer/metrics/new
snapshot consumers must switch together. Original cache isolation REDs remain
open until the actual production paths consume the new facts.

No new product decision is needed for this slice. H10 remains independently
unanswered; fresh packaged macOS and native Mobile acceptance remain separate
unfinished gates. No push, release, cloud-CI change, real database/credential
mutation or historical-snapshot rewrite was performed.
