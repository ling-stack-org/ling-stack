# Channel Context Processing Layer Implementation Plan

Status: active implementation plan
Owner: channel context and Ling Agent session maintainers
Last verified: 2026-08-03

## Owning Contract

[Channel Context Processing Layer](channel-context-processing-layer.md) is authoritative
for the domain model, source taxonomy, policy and API behavior. This plan tracks only the
remaining delivery work.

[Channel Conversation Continuity v2](channel-conversation-continuity-v2.md) now owns the
canonical timeline, segment assignment, projection version, rolling-summary coverage,
and multi-agent recovery changes. That delivery completed on `main` in PR #432. Do not
reintroduce those changes as isolated additions to this older remaining-work list.

## Current Baseline

Implemented foundations include:

- channel and direct-message context views assembled from durable sources;
- budget-aware selection, compaction evidence and source references;
- materialized attachment and workspace-file inputs;
- user override and freshness handling;
- redaction and source filtering before prompt and UI projection;
- daemon read models and shared Web context surfaces.

## Remaining Work

### Condensation Ownership

- Define one owner for summary generation, replacement and invalidation.
- Keep source objects durable while allowing compact projections to be regenerated.
- Record why content was condensed or dropped without storing secret-bearing raw output.

### Quote Eligibility

- Apply one eligibility policy to quoted messages, direct-message context and channel
  context sources.
- Reject stale, deleted, private or policy-blocked sources before prompt assembly.
- Preserve source references for accepted quotes and explicit rejection reasons for
  diagnostics.

### Persistence And Recovery

- Reconcile generated context views after daemon restart without making a cached view the
  source of truth.
- Ensure late materialization and stale requests cannot overwrite a newer context view.
- Keep migrations idempotent and backward compatible with existing channel and thread
  records.

### Redaction Ownership

- Centralize prompt, API and artifact redaction policy.
- Keep raw secrets, private teammate memory and unrelated channel context out of generated
  summaries, evidence and default UI.
- Make redaction failures fail closed and observable without leaking the rejected value.

## Invariants

- Durable messages, memory, artifacts, workflows and approvals remain authoritative.
- The browser never becomes a second context store.
- Context assembly cannot grant tools, providers, credentials or approval bypass.
- Direct-message context cannot leak into a channel or another teammate scope.
- User-authored overrides remain explicit, attributable and reversible.

## Verification

- Core tests cover budget selection, source eligibility, compaction and redaction.
- Daemon tests cover persistence, restart recovery, late-result rejection and scoped reads.
- Web tests cover source detail, empty/stale/error states and channel/direct-message parity.
- Security fixtures verify that secrets and private-scope sources do not cross boundaries.

## Closure

When all remaining items are implemented, move the durable decisions into the owning
contract, update [Implementation Status](implementation-status.md), and delete this plan.
