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
  Content aliases with changed case/Run IDs must also be rejected rather than
  counted as independent cases; check case/baseline content identity globally.
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
- Suite, case and baseline id/version each bind one content digest across the
  entire corpus; including digest in a case key is not enough to enforce this.
  A changed definition requires a new version, not another sample of the same
  version. The report carries a normalized input digest retaining source,
  evaluation, adjudication, candidate and cost lineage without exposing those
  references in the aggregate output. Array/record validation accepts only
  owned data properties and plain, dense arrays, not inherited substitutes.

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
  Missing human-pass, human-fail or severe-negative strata makes the dataset
  not assessed, even when the observed miss count is zero. One sample in each
  stratum only makes these ratios measurable; it is not statistical assurance.
- Thresholds use integer cross-comparison before display rounding. Optional
  costs and latency retain known/missing counts; absent facts are not zero cost.

This is a conservative implementation of the existing thresholds, not a new
model-driven decision policy. The real human authentication source, independent
repeat producer and storage/API projection still need implementation and
verification before any true calibration claim; enforcement remains disabled.
Observing zero severe misses does not prove zero population risk; uncertainty
depends on the number of severe-negative cases, not all 100 cases combined.

## Verification and next boundary

The initial contract preceded implementation and was not a GREEN claim.
Main7b Daemon full was collected to completion at 3600/3600 before adding
this module; it is not relabeled as a full run of the new graph. The final
standalone file is 42/42, and Root's independent four-file report/scheduler/
configuration/shutdown matrix is 67/67. The Core evaluation storage/migration
neighbor matrix is 11/11. Both have zero failure, cancellation, skip or todo;
counts overlap and are not summed. Root rebuilt Daemon with Node 22.22.1,
checked unchanged final source/test hashes, and confirmed no production caller
imports the module. Documentation/public-safety and diff checks passed.

Synthetic cases only prove statistics code. The module is not yet imported
by a runtime entry, so adding it does not authorize model calls or change
the original scheduler. Any later production import must also update the
fixed Office authored-source review closure and its real source-only build
regressions. No whole-product or GUI acceptance is claimed by this slice.

No unresolved policy decision is needed for this report-only slice. Genuine
adjudication, repetition persistence and model/provider execution remain
separate incomplete H09 work, not certificates manufactured by this function.

## Implementation checkpoint, not final acceptance

The first standalone implementation passed 39 synthetic tests. Feature-missing
RED, one incorrect conflict fixture and one transient TypeScript field-placement
failure are retained separately; none is mislabeled as a product regression.
Root then reproduced a real version-binding gap: three valid datasets changed
suite/case/baseline content at unchanged id/version, and the original module
accepted them. The initial probe's aliased observation fixtures triggered other
guards and are retained as fixture failures, not that semantic RED. Corrected
`h09-promotion-version-binding-root-semantic-red-20261008.tap` reports three
missing expected refusals. Three independent immutable-definition maps now
reject the same inputs: targeted GREEN 3/3, final standalone GREEN 42/42 and
Root neighborhood GREEN 67/67. The earlier 39-test pass is not used to certify
that correction. Raw phase logs and the Root receipt remain in the local
continuation evidence directory; no real dataset has been adjudicated.

## Next safe internal implementation

Implement `completed evaluation + append-only grades + sealed artifact`
to a strict, bounded readonly evidence projector and then this pure report.
Keep writing/producers outside that module. Check actual Run/root artifact
owner, byte digest, canonical grade digest, definition version, corpus manifest
and independent observation source; do not trust caller booleans. Missing
trusted human/repeat/frozen evidence produces diagnostics, not manufactured
qualifying samples. No provider, clock, Run mutation or configuration port.

New read-only inspection also confirms the current production gaps:

- Daemon has no discovered production `enqueueRunEvaluation` caller or generic
  evaluation API. H08 storage and rule worker are not a complete terminal-Run
  evaluation pipeline.
- Replacing the scheduler grade callback replaces the rule worker; it does not
  add per-grader dispatch/recovery. A completed evaluation is not claimable for
  a second grader. Keep rule, model and human jobs distinct.
- Existing runtime provider semaphores require an active Attempt/fence even
  for system owners. A terminal Attempt or evaluation concurrency limit is not
  provider quota admission. Custom-provider SDK pricing zero is not evidence
  of a free call; missing money facts must remain missing.

These findings do not block the readonly projector. Real model execution later
requires trusted human submission, frozen model/configuration, batch/day budgets,
repeat persistence/freeze and per-grader recovery. Do not close T9/H09 or enable
enforcement before those chains and actual calibrated data are verified.
