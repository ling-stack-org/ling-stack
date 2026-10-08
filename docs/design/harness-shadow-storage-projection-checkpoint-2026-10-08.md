# H09 bounded storage projection, 2026-10-08

## Locked slice

Follow the next internal gate of
[the promotion report checkpoint](harness-shadow-promotion-report-checkpoint-2026-10-08.md).
Read completed evaluations, exact immutable grade IDs and sealed artifacts through
four synchronous readonly ports: `getRun`, `getRunEvaluation`,
`getRunEvaluationGrade`, `getArtifact`. No list, clock, provider, configuration,
enqueue, scheduler or Run mutation. The Core grade getter is an exact lookup,
not a filtering wrapper around the unbounded grade list.

The request pins a root Run and a manifest artifact ID plus its **byte** digest.
The manifest belongs to that root and binds a sealed frozen-grader artifact and
an explicit list of evaluation idempotency keys and optional model/human grade
IDs plus canonical grade digests. Grade artifact references must also be pinned
by byte digest in the manifest. There is no implicit latest grade selection.

For every evaluation, recompute its complete immutable enqueue key, walk the
actual Run parent chain to the declared root, require a completed evaluation and
terminal Run, and check all four suite/case/baseline/candidate artifacts.
Suite/case/baseline may belong only to that exact root or evaluation Run;
candidate belongs only to the evaluation Run. Grade artifacts follow the same
exact owner boundary, not arbitrary siblings. Recompute grade canonical digest
separately from artifact `SHA256(JSON.stringify(payload))`.

The model grade's raw artifact is a digest-pinned repeat manifest:
`kind=shadow_model_observations`, schema 1, evaluation ID/key, frozen grader digest,
and exact observation artifact references. Each observation binds that same
evaluation/key/configuration and records its declared invocation/provider-request
identity, verdict/severity and optional nonnegative safe-integer costs. Reused
artifact, invocation or provider-request identities are refused, not new samples.
These declared identities are **not authenticated invocation evidence**.

Bound work before reading: at most 500 cases, 64 observations per case and 10,000
observations overall; parent depth 100; each JSON artifact at most 1 MiB, all
unique artifact payloads at most 16 MiB, and bounded plain JSON trees. Reject
truncation, sparse/accessor input, conflicting identities and unknown envelope
fields. Missing records yield explicit `not_assessed` diagnostics; corrupted or
conflicting records refuse the complete report rather than filtering out failures.

The existing exact artifact getter parses one SQLite JSON row before this
projector can apply its limits. The existing Run getter likewise parses its
stored task/provider/request snapshots; a narrow TypeScript return type does
not change its SQL projection. These are post-read processing bounds, **not a
hard pre-parse memory bound** on those legacy getters. Ordinary artifact rows do
not have the grade table's no-update/no-delete triggers. Integrity is checked
against pinned byte digests, including a fresh end-of-read verification, not
asserted from a supposed SQLite immutability guarantee. This synchronous slice
also does not claim an atomic cross-row SQLite snapshot transaction.

## Authority and missing producers

There is no trusted adjudication registry or independent invocation producer in
the current production graph. A sealed hash, `graderType=human`,
`adjudicationStatus`, or an artifact's claimed actor/request ID cannot replace it.
This slice therefore reports integrity-verified **declared** grade/observation
counts and costs separately, but does not project them into qualifying human or
independent-repeat samples. The pure report receives verified case identities
with missing human/repeat evidence, and stays `not_assessed`, `report-only`,
`shadow`, `enforcementAuthorized=false`, `humanEvidenceAuthenticated=false`.
No `authenticated=true` override or synthetic fallback is accepted.

Missing frozen evidence cannot construct a report; return a diagnostic with
`report=null`. Any invalid/missing corpus member also prevents a partial report.
The sealed manifest pins inclusion, not completeness of the real production
population. Stored optional money facts remain missing, not zero. Aggregate
money/token totals are declared storage facts, not a calibrated provider bill.

## Verification gate

Use actual temporary SQLite enqueue/claim/start/complete/append/reopen roundtrips,
not only in-memory records. Prove no SQL changes or terminal Run changes during
projection; reject cross-owner, hash/key/version/grade drift, replayed invocation
identities and malformed/unbounded inputs. Keep honest missing human/repeat/cost
diagnostics. Do not call a model, change the real user database or claim GUI
acceptance. No production caller/export is added in this slice, so it does not
change the packaged Daemon closure; a later caller must update the fixed Office
authored-source review list and run its actual source-only build regression.

No new policy choice is needed for this integrity-only slice. Trusted human
submission, authenticated invocation production, frozen real model/budgets and
per-grader recovery are still unresolved H09 implementation gates; this document
does not close T9 or authorize enforcement.
