# Channel Context Processing Layer Implementation Plan

Status: active implementation plan
Owner: channel context and Ling Agent session maintainers
Last verified: 2026-11-17 (target branch: source citation callers and durable context-view lineage)

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

The target branch also now has a single daemon summary coordinator boundary for generated
summary replacement and checkpoint installation. It rejects a late summary through the
existing source fence/CAS, renders source items through the shared evidence redactor, and
redacts generated objective, decision, constraint and open-question fields before they are
committed. Conversation reply/quote references are checked against the exact effective
item, scope and consumer visibility; rejected references are omitted from prompt assembly
and returned as id-only diagnostics. The source-level quote policy helper is wired into
proposal source-reference projection and the channel/workflow context-pack callers, so
dropped, influence-only and inspect-only sources do not become public evidence. Rebuildable
view lineage is now persisted in SQLite with a view-shape fingerprint, restart-readable
projection metadata and CAS/older-projection rejection. Daemon startup now reconstructs
conversation projections from durable sources and reports current/reconstructed/stale/
blocked lineage without rewriting an active Run's contextViewId. The recovery report now
rehydrates private-chat, workflow-proposal and workflow-step views from durable records,
preserving the persisted contextViewId and checking the view-shape fingerprint without
writing a replacement. Channel reply/selector/specialist/inspect views still rebuild their
prompt-specific envelope on the next Host request; Web/security and packaged acceptance
remain open.

## Remaining Work

### Condensation Ownership

- Keep the summary coordinator as the only daemon owner for model summary generation,
  replacement and checkpoint installation; storage remains the CAS and invalidation owner.
- Keep source objects durable while allowing compact projections to be regenerated.
- Record why content was condensed or dropped without storing secret-bearing raw output.

### Quote Eligibility

- Conversation reply/quote item checks and id-only rejection diagnostics are implemented.
- Proposal source-reference projection and channel/workflow context-pack callers now use the
  source-level helper; private-chat views retain the same source policy and durable lineage.
- Continue rejecting stale, deleted, private or policy-blocked sources before prompt
  assembly, with accepted source references preserved.

### Persistence And Recovery

- Persist rebuildable view lineage separately from prompt bodies; the SQLite migration and
  reopen path now restore projection metadata and the private/proposal/workflow surface views
  without making a cached view the source of truth.
- Ensure late materialization and stale requests cannot overwrite a newer context view;
  the lineage store now rejects older projections and mismatched CAS writes. The daemon
  restart reconciliation worker rebuilds the canonical conversation projection from
  durable messages, assignments, summaries and visibility policy. It leaves changed
  lineage untouched for Host-owned re-materialization, so active Runs cannot silently
  adopt a different contextViewId.
- Keep migrations idempotent and backward compatible with existing channel and thread
  records.

### Redaction Ownership

- Summary prompt rendering and durable summary fields use the shared evidence redactor.
- Centralize the remaining prompt, API and artifact redaction policy.
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

- Core tests cover budget selection, source eligibility, compaction and redaction; the
  lineage test covers SQLite reopen, older-projection rejection and matching-CAS rejection.
- Daemon tests cover source citation filtering, persistence wiring, late-result rejection and
  scoped reads.
- Web tests cover source detail, empty/stale/error states and channel/direct-message parity.
- Security fixtures verify that secrets and private-scope sources do not cross boundaries.

The target branch adds startup recovery coverage: Core/Daemon typechecks pass, the
context lineage/projector/context-processing set is green, and the recovery fixture
covers SQLite reopen, current projection reconstruction, private/proposal view
rehydration, stale metadata detection and fail-closed missing-source handling. Startup
recovery is a local source check; it does not replace browser, security, packaged or
live-provider acceptance.

## Closure

When all remaining items are implemented, move the durable decisions into the owning
contract, update [Implementation Status](implementation-status.md), and delete this plan.
