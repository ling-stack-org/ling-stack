# Memory Review Policy Implementation Plan

Status: active implementation plan
Owner: memory governance and recall maintainers
Last verified: 2026-08-03

## Owning Contracts

- [Ling Memory v1](ling-memory-v1.md)
- [Memory Health And Fan-In](memory-health-and-fanin.md)

## Current Baseline

MRP.1-MRP.5 and the first MRP.7 product surface are implemented for memory candidates,
review state, promotion, health findings and scoped read models. Active-only recall and
used-memory audit provide part of MRP.6.

## Remaining Work

### Recall Audit

- Join recalled memory, policy decision and final use into one attributable audit view.
- Distinguish considered, excluded and used memories without storing unnecessary prompt or
  response bodies.
- Make stale, disabled, private and superseded memory exclusion observable.

### Review Surface Decision (Closed)

- Workspace review remains embedded in the existing memory, channel and teammate ownership
  surfaces. The learning/index work does not introduce a separate global review center.
- Keep normal/empty health states quiet and technical fields folded.

### Lifecycle Reconciliation

- Reconcile source changes, review decisions and recall eligibility after restart.
- Keep candidate, review and published-memory links idempotent.
- Preserve source provenance and scope when memory is edited, promoted or superseded.

## Safety Invariants

- Recall never grants tools, credentials, file access or approval bypass.
- Private teammate memory does not enter unrelated channel or workspace scope.
- Automatic analysis may propose candidates but cannot publish shared memory without the
  configured review decision.
- Browser visibility and vector-search results are not authority.
- Secret-adjacent and denied sources remain excluded from indexing and recall.

## Verification

- Core tests cover review transitions, scope, supersession and recall eligibility.
- Daemon tests cover idempotency, restart reconciliation and redacted audit reads.
- Web tests cover pending/generated/ignored or equivalent review states, empty states,
  actions, keyboard behavior and stale failure handling.

## Closure

Close when recall audit is complete and the global review-surface decision is recorded.
Move durable policy into the owning contracts and delete this plan.
