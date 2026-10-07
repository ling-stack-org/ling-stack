# Private execution input metadata seam

Date: 2026-09-30. Increment within E2/E4/E5/E6, not a replacement for the unified transcript plan.

## Evidence and ownership

The real packaged Engineer Run `run_bb0ff8a1-4b54-4eb3-a334-187919c9ebe3`
completed three reads, but the private detail exposed no context snapshots and
the shared projection correctly left the actions atomic. Unlike normal input,
the private source was ingested without freezing the rendered input. The normal
accepted-input store intentionally rejects private visibility and cannot be
reused by weakening its guards.

## Required chain

1. Core owns a dedicated immutable private execution input record on the existing
   `conversation_context_snapshots` table, with its own `snapshot_use` value.
   Private source/Turn/context assignment and the record commit in one transaction.
2. The record binds canonical Thread, Turn, source item and teammate owner. The
   actual rendered prompt and system prompt remain internal. Public metadata
   contains only the frozen segment/boundary and owned canonical source refs.
3. An internal-only RunRequest reference binds record id and fingerprint. Run
   preparation consumes the stored prompts, including on an idempotent replay.
   A replay lacking the record fails explicitly; historical input is not recaptured.
4. Private detail resolves only records referenced by visible owned Runs. It
   validates private owner/visibility, exact Turn/source/Run references and the
   consumed prompt before allowlisting public metadata. Reads create no records.
5. The existing shared canonical projection and batching remain unchanged. No
   private renderer, batch table or owner-bypass fallback is added.

## Verification

- Regression red/green: replay with changed rendered context still consumes the
  original private input and carries a stable fingerprint reference.
- Core: atomic rollback; local-user/system ownership; normal/channel/foreign
  scope rejection; immutable replay; missing/corrupt records; reopen recovery;
  no unredacted secrets; unchanged normal accepted-input guards.
- Daemon: real SQLite source/ref binding, public metadata only, missing/foreign/
  corrupt/mismatched references leave actions atomic without hiding history;
  projections write nothing. Request parsing cannot accept this internal ref.
- Shared projection: real private item/action anchors batch and expand reversibly.
- New packaged GUI: fresh Engineer reads, disclosure and no other participant;
  preserve build hash and exact lineage. The previous package's three-read probe
  remains failure evidence and is not retroactively relabeled as a pass.

Design decision verdict: no unresolved product choices. Implementation and the
above acceptance are pending; channel parity and the rest of E6 remain separate
required gates.

## Verified implementation increment

2026-09-30: the Core transaction, immutable replay, Run binding, private metadata
projection and shared batching seam are connected. The timeline's public Run DTO
retains execution identity/status and task identity/title, but excludes rendered
private task/request snapshots. Host Run storage remains unchanged for execution
and recovery. This is a detail-projection boundary, not a new authority ceiling.

The projection includes source-state and exact-visibility fingerprints derived
from the serialized input; private replay nests a read-only window within the
acceptance transaction. Missing or invalid records fail rather than recapture
old history. No normal accepted-input guard or renderer rule was relaxed.

Full gates: Core 1012/1012, Daemon 2085/2085, Web 359/359; desktop build, packaged
bundle and strict/deep ad-hoc signature verification passed. Fresh native GUI
marker `E6-P01-CONTEXT-20260930-02` completed three reads by Engineer, displayed one
reversible batch and disclosed the real source output. Evidence and exact lineage
are recorded in `output/e6-20260928/P-01/private-frozen-input-20260930.json`.

This read-batching subcheck passes; the complete P-01, channel, viewport/H2 and
remaining E6 gates do not. The prior unsnapshotted private Run is not recaptured
or relabeled. No commit, push or merge has been performed for this increment.
