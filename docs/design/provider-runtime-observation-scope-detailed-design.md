# Provider runtime observation scope

## Accepted decision and module boundaries

The user answered `investigate-runtime-external-credential-scope` **A** in this
conversation on 2026-10-10. This is the actual answer, not an auto-selected
recommendation. It does not answer the separate H10 root-budget question.

Use existing Provider configuration authority, resolver, Runner and incident
stores. Do not introduce another Provider service or change model sessions.

| Boundary | Responsibility |
| --- | --- |
| Core Provider authority | Atomic preset/configuration-revision reads; local-secret writes increment the same durable revision |
| Daemon private scope module | Brand atomic reads and resolved connection objects; hold keyed effective-value proofs in Host memory only |
| Existing resolver | Materialize exactly the values used by the returned Runner provider; bind resolution and scope together |
| Actual Runner admission | Produce a distinct invocation receipt bound to Run/Attempt after all pre-call rejection gates |
| Observation fold / incident store | Attribute failures to that invocation, never a post-await preset reread; preserve history |
| Context / observer / team projections | Apply only currently validated observations, before result limits; no mutation of historical snapshots |
| Public UI / API | Safe lineage and current/historical/unknown meaning only; no credentials or private proofs |

## Guarantee

1. Scope includes the owning Store/Host epoch, durable configuration revision
   and actual connection/materialized credential tuple. Equal Provider IDs in
   different workspaces are not equal authority.
2. Local managed secret A→B→A changes durable configuration revision and must
   invalidate the original observation. A timestamp, ref or ordinary hash is
   not that revision.
3. External env/Keychain credentials use a Host-private keyed comparison of
   the effective API key and **all effective headers**, including secret-header
   values. A current read equal to the original read proves sampled equality
   only, not unchanged external mutation history or an atomic multi-header read.
4. Host restart, missing branded receipt, resolver failure or incomplete value
   proof means unknown. Unknown observations cannot affect current health or
   context budgets; normal Provider calls remain available under existing gates.
5. Private keyed proofs are not written to prompts, public events, incident
   summaries or exposed DTOs. Resolution objects already carry actual secrets
   for Runner use; the private scope must not retain a second raw-value copy.

## First implementation slice: resolution proof

The first module is `features/providers/runtime-observation-scope.ts`. It
captures the atomic configuration **before** materialization and binds the
opaque scope to the exact returned Runner provider object. A second lookup
after materialization cannot fabricate the old configuration/new revision pair.
Capture and current-value comparison revalidate the same configuration revision
after synchronous resolver work, including mutation during a resolver callback.
The revision and exact captured configuration must both match; a raw or cloned
configuration ticket does not acquire authority.

Scopes and tickets are nominal Host-owned objects checked by private WeakMaps.
Reflecting/serializing a scope exposes no proof or credential. Mutating or cloning
the resolved Runner provider loses its binding instead of borrowing the original
scope. Independent stores and fresh Host epochs cannot validate old scopes.
The binder accepts only internal resolver inputs and verifies the actual
materialization-source preset against the captured private configuration proof.
This detects accidental mixing of mutable preset copies; it is not protection
against arbitrary JavaScript already executing with Host authority.

Current comparison returns an explicit managed-generation match, sampled-value
match, changed, or unknown with bounded reasons. Errors or proof absence do not
alter the existing resolver's model-call authorization or successful output.
The existing resolver still runs the same preflight and materialization logic;
only its saved-preset read becomes the atomic configuration read where available.
There is no compatibility claim for an unbranded/missing proof.

When Host materialization has no nonempty runtime API key, Pi may use SDK ambient
credentials. Such a resolution deliberately has no complete observation proof;
normal calls retain their previous behavior. A Host-materialized tuple is not a
claim to have observed the SDK's final authentication headers or network bytes.

**A resolution proof is not an invocation receipt.** This slice does not by
itself permit incident publication or prove that a model request happened.
Preflight, SDK preparation, reconstruction and duplicate admission can reject
before any actual call. Keep those distinct from runtime Provider failures.

## Logical invocation admission and settlement

The per-run `runtime.streamSimple` wrapper is the common local seam for task,
SDK retry and compaction streams. `runTask` entry is too early; the SDK's Agent
extension hook alone is incomplete because compaction can bypass it.

The wrapper issues a distinct Host-only logical admission only after the awaited
payload hook, cancellation/Host latch, prepared-input validation, projected
context immutability and reasoning-payload conversion all pass. The actual
request Model and explicit stream API-key/header/environment overrides must be
provably consistent with the captured Host provider. Mismatch or missing proof
means observation unknown, not a model-call denial. Each stream is independent;
repeat payload hooks do not generate another identity. This is not evidence that
HTTP/WebSocket bytes were sent, nor a per-HTTP-retry counter.

Observe the same stream's `result()` Promise, without consuming its iterator.
Only an admitted stream's Provider error can produce a private failure fact;
preparation, local callbacks, Host rejection, cancellation and malformed results
cannot. The settlement carries the exact admission lineage and sampled time.
Time reversal is unknown rather than fabricated monotonic wall time.

Settlement contains existing bounded `PiProviderErrorDiagnostic` categories,
status and known codes, never raw error text. This avoids late credential rereads
for redaction when A rotates to B, and does not retain a second credential copy.
Free-form prose about a context error is not an authoritative context failure.

Daemon binds each authentic admission to the original private resolution scope,
Run/Attempt and role, then emits an opaque immutable failure handle. It validates
settlement lineage, ignores duplicate/reused identities, and retains only safe
classification constants. No scope/private proof is written to RunEvents or
public DTOs. Callback failures/async rejections are drained without changing
execution authorization. Lifetime dedup is bounded to 4096 identities and 128
pending streams per observer; exceeding diagnostic bounds makes observation
unknown while execution continues normally.

The initial production connection adds the private observer to the trusted Pi
orchestrator path and carries failures through the channel reply's private sink.
External adapters without this conformance remain unknown. Persisted prepared
execution cannot synthesize a new private receipt; live provider identity and
callbacks must survive continuation reconstruction. Reviewer and direct selector
calls still require their own observer connections before the final cutover.

## Required subsequent production chain

- After preparation awaits, replace provider and scope together. Preserve the
  existing prepared-input rejection on non-secret configuration changes.
- At actual runTask/resumeTask admission, capture the actual provider object
  and existing Run/Attempt lineage. Each retry, JSON repair and Reviewer call
  gets its own invocation identity; a preview/preflight does not count.
- Thread the Host-only receipt through reply/route/intent wrappers. An old
  Run.providerSnapshot or current preset read cannot reconstruct this receipt.
- All three context-error producers and four availability producers consume
  original invocation facts. Display/storage errors before provider dispatch
  must not create a Provider availability incident.
- Context budget consumption validates current workspace/configuration/value
  scope. Expired observations are discarded before minimum-window merging as
  well as reads; preserve the existing six-hour `>` expiry boundary.
- Durable incident history must be distinguishable from current applicable
  observations without storing raw credentials. Core/private metadata and
  atomic publication will be implemented before observer/team cutover. Filter
  before pagination/limits; preserve historical incidents and saved snapshots.

## Required verification

Use synthetic credentials and disposable SQLite only. No real env/Keychain
value is printed or modified.

- Actual resolver output and private scope use the same API-key/header read.
- Same ID in different stores, configuration revision, endpoint and context
  changes, deletion/recreation and managed A→B→A cannot match the old scope.
- External key/header changes are detected; external A→B→A is explicitly a
  sampled match. Missing/read-failed proofs are unknown, not normal-call bans.
- Configuration mutation during materialization or current sampling refuses
  mismatched proof; original read is never paired with a later revision.
- Scope serialization, forged/cloned tickets, mutated provider values and a
  new authority epoch cannot disclose or borrow proof.
- An actual adapter call A followed by configuration B and A's late error
  cannot poison B's context budget or health. Web/preparation awaits and
  continuation/Reviewer/retry seams retain their exact existing semantics.
- Node22/24 focused, affected resolver/Runner/Host regressions, broader relevant
  gates and independent review must pass before the cutover is called complete.

## Completion boundary

Implementation is in progress. This design records the accepted A guarantee,
not completion of the runtime cache, incident consumers or E6. The existing
two address/context baseline REDs remain real until the full producer/consumer
chain is connected. Fresh packaged macOS acceptance remains blocked by its
separate formal Office review input; no unsigned/old mixed package bypass is
introduced. H10 budget, native environment and Office isolated-Keychain decisions
are not silently settled here.
