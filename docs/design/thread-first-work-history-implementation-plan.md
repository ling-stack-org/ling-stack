# Thread-First Work History Implementation Plan

Status: active implementation plan
Owner: thread, run history and diagnostics maintainers
Last verified: 2026-08-03

## Owning Contracts

- [Thread-First Work History](thread-first-work-history.md)
- [Thread-First Work History V2 Detailed Design](thread-first-work-history-v2-detailed-design.md)
- [Work History IA Cleanup](work-history-ia-cleanup.md)

The contracts and detailed design own the data model. This plan keeps only remaining
delivery work and migration safeguards.

## Current Baseline

- durable threads, turns, runs, events and source lineage exist;
- V1/V2 projections, evidence hydration, archive and fork foundations exist;
- run and approval truth remains in existing stores;
- conversation and diagnostics surfaces can navigate linked work without creating a
  second history database;
- archived and superseded records remain auditable while default product views stay quiet.

## Remaining Work

### Diagnostics Placement

- Finish the diagnostics-oriented placement of run, event, approval and artifact detail.
- Keep ordinary conversation history readable; technical execution detail opens on demand.
- Use one Inspector/Right Dock owner per surface and preserve source navigation.

### V2 Projection Closure

- Complete remaining V2 read-model and lazy-hydration paths.
- Reject stale hydration after thread, turn, run or workspace changes.
- Keep missing or deleted source state explicit without breaking historical records.

### Archive, Fork And Recovery

- Reconcile archive and fork lineage after restart and partial failure.
- Preserve source thread/turn identity and never rewrite historical run ownership.
- Keep destructive deletion separate from archive and protected by referential checks.

### Migration And Compatibility

- Keep existing V1 records readable while V2 projections are completed.
- Make all migrations idempotent and fail closed on ambiguous lineage.
- Do not use browser local state or metadata caches as history authority.

## Invariants

- Threads are conversation facts; runs are execution facts; links do not merge lifecycles.
- Run, event, approval and artifact stores remain authoritative.
- Superseded work is hidden from default views but remains auditable.
- Archive does not imply deletion, cancellation or loss of evidence.
- Forks preserve immutable source lineage and create new work identity.

## Verification

- Core and daemon tests cover migration, lineage, archive, fork, hydration and recovery.
- Web tests cover history navigation, diagnostics detail, stale/missing sources and internal
  scroll behavior.
- Compatibility fixtures verify existing V1 data remains readable and unchanged.

## Closure

Close after diagnostics placement and remaining V2 work are complete. Merge durable rules
into the owning contracts and delete this plan.
