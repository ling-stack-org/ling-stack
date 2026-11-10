# A27 — Preserve authorization and workspace access through request adapters

## Problem and boundaries

`authorizationMode` and `workspaceAccessMode` are independent first-class selections.
The existing `permissionPreset` / `permissionMode` projection is lossy for combinations
such as ask + workspace_write, ask + full_access, and smart + read_only. Reconstructing
only that projection can change the request's meaning without changing its UI selection.
The current finding is missing request fields, not demonstrated OS escape or unauthorized effects.

The private composer/client/schema/service already carry both axes. Two router callbacks
drop them before `createAiTeammateDirectReply`. The shared manual-resume builder copies
legacy permission fields from its source snapshot but drops the independent fields;
ordinary, private and channel resume use that builder. Normal prepared-request storage
and existing-run request spreading already retain the axes and should not be rewritten.

## Required implementation

- UI/client/types: retain the existing typed contract; no new control or authority source.
- Private collection and SSE router adapters: forward both parsed fields to the existing
  reply constructor, alongside the existing preset and Full Access confirmation.
- Shared manual-resume builder: read the source snapshot's validated independent fields
  and preserve them in the new RunRequest. A preview remains read-only; execution and a
  persisted normal prepared request must use the same source selection.
  Validate both stored selections before normal input/turn/prepared-snapshot creation;
  a rejected source must not leave behind a newly accepted user input.
- Shared fork-run builder: preserve the same validated axes for all three surfaces.
  Normal fork keeps its existing explicit removal of the parent's Full Access receipt:
  preserving the access selection must cause an unconfirmed child to be rejected, not
  silently downgrade its selection or resurrect historical permission confirmation.
- Orchestrator/Core policy: retain the existing authoritative resolver. Re-read current
  workspace policy and approval profile at execution; preserve workspace deny, empty
  write paths for first-class read_only, Full Access confirmation and Host capability gates.
  Do not copy the source's effective policy as fresh authority or grant permissions from text.
- Persistence: keep the original source Run unchanged. No new table, migration, provider
  session, general request copier, or compatibility layer is needed for this adapter repair.

Missing source axes keep the existing missing-field contract. Do not infer or fabricate
a new selection from UI labels, narrative, an effective-policy display, or an arbitrary
request body's override of a stored resume source. A present source axis is constrained
to Core's existing closed enum; malformed data must not be silently treated as authority.
Preserving selection does not mean preserving past authorization when current policy tightens.

## Adjacent lifecycle evidence repair

The real prepared-retry regression reaches the current workspace deny. An immediate
policy denial records `approval_requested` and `approval_denied` for audit, without
entering a durable Run wait. Existing event-type-only projections incorrectly enter a
WorkUnit wait, fail its Attempt, and leave the still-running Run unable to commit.

Use one read-only approval-event predicate shared by WorkUnit, Thread and the event-side
hard-timeout pause. It verifies the stored Approval belongs to this Run and matches the
stored Run lifecycle: pending/waiting, approved/running, denied-or-expired/failed.
Captured pre-wait Run objects are not current authority. Preserve both audit events;
an immediately denied operation does not itself end the logical task. A genuine wait's
approval, denial and expiry keep their existing transitions. Missing, foreign or resolved
request evidence cannot manufacture a wait or terminate another pending wait.

This does not change policy decisions, user approval rules, tool execution, fence checks,
or logical wait timeout suspension. It removes false lifecycle consequences from audit.

## Verification

Use isolated owned home/workspaces, real public HTTP, real Daemon execution composition,
SQLite and a deterministic no-effects Runner. Assert the actual Run request and effective
policy snapshots, not just callback arguments or HTTP 200. Keep every original RED raw.

Cover both private entry points; normal/private/channel manual resume; ask + workspace_write;
confirmed ask + full_access; smart + read_only; current workspace deny and approval-profile
restrictions; preview without execution; normal prepared/retry behavior; canonical selections
and the existing missing-axis behavior. A malformed source must not acquire permissions.
No real Provider, credential, Keychain, daily database or OS tool effect is needed.

After RED, repair the smallest shared adapters, fresh-build Daemon, run complete focused and
relevant neighboring files, verify current Desktop input coverage, and obtain independent
product review before the limited local checkpoint. This is not packaged macOS acceptance
or E6 completion. Main CI remains disabled and outside the gate.

No unresolved product decision remains for this slice; implementation and behavioral
verification are pending and tracked in the continuation ledger.
