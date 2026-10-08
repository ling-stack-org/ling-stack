# H09 shadow promotion analysis — 2026-10-08

## Scope and existing plan

This is the first independent internal slice of T9/H09 in
[the Harness plan](ling-harness-gap-closure-implementation-plan.md), Grader
Policy / G15 / G18. H08's append-only grades and low-priority scheduler exist;
the default worker still executes only the deterministic rule grader. A grade's
free-text `adjudicationStatus` does not authenticate a human. This slice does
not claim all of H09, model transport, evaluation APIs, real calibration or
packaged acceptance is complete.

Add a pure `buildShadowPromotionReport` in Daemon's evaluation directory and
fixed synthetic dataset tests. It receives readonly projected evidence, not a
Store, provider, clock, callback or Run controller. It has no I/O, database
mutation, terminal transition or configuration update. The report always states
`authority: report-only`, `modelGate: shadow`, `enforcementAuthorized: false`.
Threshold satisfaction is arithmetic, never an enforcement grant. No new table
or migration is needed for this report.

## Input and identity contract

- A single frozen grader definition binds grader id/version, prompt digest,
  exact model/version, sampling digest and rubric digest. Its canonical digest
  uses the existing Core evaluation JSON helper. A report cannot mix versions.
- Each case retains suite/case/baseline id/version/digest and candidate digest,
  plus completed evaluation and human adjudication references. Case identity
  excludes Run/evaluation/artifact/observation row IDs. Repeated execution
  cannot inflate the unique-case denominator. One case identity with different
  candidates or conflicting adjudications is invalid, not a best-result choice.
- Repeats are explicit independent observations with stable observation IDs,
  source references, the frozen definition digest, verdict/severity and optional
  cost/latency facts. Replaying an identical ID counts once; a changed replay is
  invalid. Matching outputs from two distinct observations remain two samples.
- The existing grade unique key is `(evaluation, type, grader id, version)`;
  it cannot persist a second same-version stochastic result for one evaluation.
  These offline observations are a separate projected input contract. Do not
  alter grader identity/version to bypass that constraint, and do not pretend
  the existing table now supports repeated samples.
- Artifact byte digests and canonical grade/configuration digests use different
  algorithms in existing storage. Neither can be substituted for the other.
  Runtime validation must be bounded, reject malformed/non-finite inputs and
  prevent duplicate, conflicting or mixed-version facts from becoming evidence.

## Locked conservative arithmetic

At least 100 unique, fully human-adjudicated pass/fail cases are required.
For each unique case:

- A severe miss is human fail at error/critical severity with any model pass;
  count that case once, and require zero.
- A false block is human pass with any model fail; divide by the number of
  human-pass cases, not all cases. The inclusive limit is 1%.
- Agreement requires at least two independent observations, all with valid
  pass/fail and identical verdict/severity. Divide agreeing cases by all
  adjudicated cases. The inclusive minimum is 95%.
- Missing human adjudication, missing repeat/frozen lineage, abstain/error or
  conflicting input cannot become qualifying evidence. A zero denominator is
  unmeasured, not 0%. Missing severe-case coverage is explicitly reported.
- Thresholds use integer cross-comparison before display rounding. Optional
  costs and latency retain known/missing counts; absent facts are not zero cost.

This is a conservative implementation of the existing thresholds, not a new
model-driven decision policy. The real human authentication source, independent
repeat producer and storage/API projection still need implementation and
verification before any true calibration claim; enforcement remains disabled.

## Verification and next boundary

At creation this document is a locked implementation contract, not GREEN.
First preserve the pending main7b Daemon full result before rebuilding its
dependency graph. Then run fixed dataset, malformed-input, denominator,
duplicate/replay, frozen-version, abstain/error and exact-threshold tests;
independently review the module. Synthetic cases only prove statistics code.
The module is not yet imported by a runtime entry, so adding it does not
authorize model calls or change the original scheduler. Any later production
import must also update the fixed Office authored-source review closure and
its real source-only build regressions.

No unresolved policy decision is needed for this report-only slice. Genuine
adjudication, repetition persistence and model/provider execution remain
separate incomplete H09 work, not certificates manufactured by this function.
