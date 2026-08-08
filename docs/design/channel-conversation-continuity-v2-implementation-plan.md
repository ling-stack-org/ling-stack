# Channel Conversation Continuity v2 Implementation Plan

Status: S-1 merged in #422; S0 implemented; S1-S7 pending
Owner: conversation, channel context, Ling Agent Session, and storage maintainers
Date: 2026-08-08
Last verified: 2026-08-09

## Owning Contract

[Channel Conversation Continuity v2](channel-conversation-continuity-v2.md) is
authoritative for ownership, invariants, Thread/Turn/Item topology, segmentation,
projection, summary behavior, multi-agent recovery, and Channel Intent Decision v2.

This document defines delivery order, migration boundaries, tests, performance checks,
and completion evidence. It must not change the owning contract implicitly.

## Outcome

The implementation is complete when one user turn follows this path:

```text
create LingTurn + append user ConversationItem atomically
  -> assign ContextSegment
  -> build one versioned ConversationContextProjection
  -> resolve references and select intent v2
  -> reply / clarify / propose / execute
  -> append observable result items
  -> update turn terminal state
  -> proactively summarize stable history when policy triggers
```

All consumers must use the same projection version. `channel_messages`, v1 intent names,
and independent fixed recent-message windows must no longer be runtime authorities.

## Scope Challenge

### What already exists

| Existing foundation | Reuse decision |
| --- | --- |
| SQLite `ling_threads`, lineage fields, archive/pin, and metadata | Reuse and add explicit conversation surface fields. Do not create a parallel thread store. |
| SQLite `ling_turns` and `ling_turn_runs` | Reuse, but change creation semantics so ordinary user turns are durable. |
| `ensureChannelReplyThread` and channel branch root threads | Reuse as migration inputs, then make root-thread ownership explicit at ingest time. |
| `channel_messages` and message paging | Preserve ids during one-time conversion; replace runtime store with `conversation_items`. |
| Context Processing sources/views and Context Budget Manager | Reuse as the projector foundation; remove consumer-owned raw history scans. |
| `channel_context_summaries` and context compaction helpers | Reuse lessons and source-ref behavior; replace the table with coverage-aware conversation summaries. |
| Channel intent selector, TargetResolver, proposal/workflow adapters | Reuse validators and execution paths behind the v2 decision contract. |
| Workflow, run, approval, artifact, handoff, and memory tables | Keep as domain authorities; reference them from items and projections. |
| Conversation transcript projector and operation cells | Repoint to canonical items and domain refs; do not rebuild UI semantics in storage. |

### Minimum complete change

A prompt-only fix for issue #421 is insufficient. The minimum complete program is:

1. canonical Thread/Turn/Item persistence;
2. one context assignment and projection path;
3. intent v2 with TargetResolver gating;
4. proactive summaries and source-linked recovery;
5. multi-agent projection-version enforcement;
6. removal of old runtime authorities.

Each slice should be reviewable, but no partial slice that dual-writes two conversation
authorities may ship as the final state.

### Complexity verdict

This program touches more than eight files and several modules. One big-bang PR would be
hard to review and unsafe to diagnose. The plan therefore uses ordered vertical slices.
Each slice has one owner, explicit entry/exit criteria, and focused tests. Contract and
storage slices land before behavioral changes; UI diagnostics land after authority is
stable.

No new database, message broker, vector service, or external infrastructure is required.
SQLite transactions, existing Context Processing, and existing domain stores are the
boring and correct foundation.

## Delivery Strategy

Use one feature branch until the clean-break migration and runtime switch are both
complete. S1 and S2 are one non-shippable authority-cutover unit: S1 may develop the
migration/store behind tests, but the migration is registered only when S2 switches all
ingest and read paths. Every review checkpoint must pass its listed tests. Do not release
a build that writes both `channel_messages` and `conversation_items`.

```text
S-1 align #422 reply supervision with conversation-line semantics
  -> S0 contracts and fixtures
  -> S1 atomic storage migration and item store
  -> S2 turn lifecycle and thread topology
  -> S3 segmentation and shared projector
  -> S4 intent v2 and #421 regression
  -> S5 rolling summaries and fork snapshots
  -> S6 multi-agent version consistency
  -> S7 transcript/API cleanup and old authority removal
```

## Slice S-1: Align PR #422 Reply Supervision Bridge

Status: merged by PR #422 as `96b69101`; the Continuity v2 branch now rebases on that baseline before S0.

### Purpose

Reuse #422's read-only supervised reply Runs, durable FIFO interventions, streaming
projection, and cancellation without allowing its pre-v2 Channel-wide active-reply rule
to become a second authority.

### Changes

- Add optional request contract:

  ```ts
  interface ChannelReplyDisposition {
    readonly mode: "queue_followup";
    readonly activeRunId?: string;
  }
  ```

- Derive the bridge lane from `(workspaceId, channelId, conversationLineKey)` using
  `root`, `branch:<rootThreadId>`, `topic:<sourceMessageId>`, or `thread:<threadId>`.
- Recover the active Run's source message from `requestSnapshot.sourceMessageId` and
  require an exact conversation-line match.
- Queue only when `replyDisposition.mode === "queue_followup"`; remove the server fallback
  that intercepted every message merely because an active Channel reply existed.
- Preserve the lane owner for the first rapid submit so a second request with `mode` but
  no Run id can wait for its predecessor to link. Mode-only requests may follow only a live
  coordinator predecessor; without one they return to normal intent routing.
- Emit `activeRunId` from Web only for an authoritative active guidance target; emit
  `mode` without an id only for a pending rapid-submit predecessor.
- Add `ConversationActiveReplyTarget.sourceMessageId` and filter Web guidance through the
  persisted source ChannelMessage line. Keep Run `threadId` canonical rather than replacing
  it with a message-keyed Topic id.
- Resolve Branch continuations onto the Branch LingThread. For message-keyed Topics, retain
  the canonical Channel Root LingThread plus `sourceMessageId` until S2 materializes a Topic
  LingThread; do not create a temporary second thread authority in S-1.
- Claim the oldest pending intervention atomically in SQLite, without reading a fixed first
  page, and continue draining after a continuation start failure.
- Reject client-supplied Channel lineage fields on the public Run-intervention endpoint;
  validated Channel dispatch owns them.
- Keep ordinary reply Runs read-only with `tools=[]`; keep `LingTurn` as the eventual v2
  lifecycle owner.

### Authority boundary

S-1 does not create `ConversationItem`, does not dual-write timelines, and does not decide
`reply | execute`. An absent, stale, or cross-line disposition returns to the existing
intent selector. S1/S2 later replace the temporary Channel-surface lookup with explicit
canonical `LingThread` ownership without changing this request boundary.

### Required regression assertions

- same-line explicit guidance queues FIFO and preserves materialized inputs;
- a pending predecessor without a Run id waits and links to the same line;
- active Root reply plus unmarked file work reaches `direct_workflow` today and `execute`
  after S4;
- active Root reply plus Branch/Topic message does not join the Root FIFO;
- Branch continuation Run keeps the Branch Thread id;
- Topic continuation keeps canonical Run thread identity while its source message line stays
  isolated from Root and other Topics;
- Web active guidance is scoped by the current source ChannelMessage line;
- mode-only guidance with no live predecessor cannot attach to an arbitrary active Run;
- the 101st pending intervention is claimable and concurrent claims cannot duplicate it;
- a failed first continuation start does not strand the next FIFO item;
- public Run-intervention requests cannot inject `sourceMessageId` or `targetTeammateId`;
- no redirect-like phrase or other text heuristic creates a follow-up relation.

### Merge gate

- focused coordinator/dispatch and Channel integration tests pass;
- daemon and Web typechecks/builds pass;
- Web tests, lint, and i18n audit pass;
- full daemon suite has no changed-path regression; unrelated timing flakes must pass in
  isolated reruns and be reported rather than hidden;
- only after this gate should #422 merge, followed by rebasing the Continuity v2 branch
  and starting S0.

## Slice S0: Freeze Contracts And Golden Scenarios

Status: implemented on `codex/channel-intent-v2`; contracts, runtime guards, public JSON
fixture, and cross-package consumption checks pass.

### Changes

- Add shared contract types for:
  - `ConversationItem` and typed payloads;
  - thread surface/relation fields;
  - `ContextSegment` and `TurnContextAssignment`;
  - `ConversationContextSummary` and snapshot metadata;
  - projection metadata/version;
  - `ChannelIntentDecisionV2`.
- Add the v2 action contract used by golden fixtures:
  - `reply` replaces `single_reply` at the S4 cutover;
  - `execute` replaces `direct_workflow` at the S4 cutover.
- Keep the current v1 contract isolated until S4. Do not add conversion aliases between
  v1 and v2 or persist mixed-version decisions.
- Define one fixture suite for the approved continuity scenarios before changing runtime
  behavior.

### Golden scenarios

1. Long-form article request followed by `需要，开始吧` stays conversational.
2. Explicit `把文章保存到 README.md` becomes executable file work.
3. Explicit local write without a target clarifies with `missingFields=["target"]`.
4. A new snake-game request after an unrelated clarification receives a fresh segment.
5. `方案 B 就这样定` switches to or continues the existing architecture segment.
6. An explicit reply/quote inherits the referenced segment.
7. A formal Topic creates a child thread; a natural topic shift creates a segment.
8. A branch inherits a snapshot and does not copy parent items.
9. A private teammate memory never appears in another agent's public channel projection.
10. A stale agent result is rejected or rebased when its relevant projection changes.

### Exit criteria

- Contracts build and serialize deterministically.
- V2 contracts reject old enum values; current v1 runtime remains isolated until the S4
  clean-break switch.
- Golden fixtures are data-only and usable by core, daemon, and eval tests.

## Slice S1: Atomic Storage Migration And Conversation Item Store

### Target tables

- extend `ling_threads` with:
  - `surface_kind`;
  - `relation_kind`;
  - `anchor_item_id`;
  - `fork_context_snapshot_id`;
  - `next_item_sequence`.
- add:
  - `conversation_items`;
  - `context_segments`;
  - `turn_context_assignments`;
  - `conversation_context_summaries`;
  - `conversation_context_snapshots`.

### Required indexes

```text
conversation_items(thread_id, sequence) UNIQUE
conversation_items(turn_id, sequence)
conversation_items(channel_id, created_at)
conversation_items(thread_id, idempotency_key) UNIQUE WHERE key IS NOT NULL
ling_threads(channel_id) UNIQUE WHERE surface_kind='channel_root' AND archived_at IS NULL
context_segments(thread_id, state, last_active_turn_id)
turn_context_assignments(turn_id, revision) UNIQUE
conversation_context_summaries(thread_id, segment_id, status, covered_through_sequence)
```

### Migration algorithm

Develop and test the migration in S1, but register it only with the S2 runtime cutover.
When activated, run it in one SQLite transaction:

1. Create the new tables and thread columns.
2. Ensure each channel has exactly one root `channel_discussion` thread and mark it
   `surface_kind=channel_root`, `relation_kind=root`.
3. Convert message-keyed topic reply groups into child topic threads with
   `anchor_item_id` resolved after item import.
4. Preserve existing `channel_messages.id` values as imported item ids.
5. Map messages to explicit threads:
   - known branch root thread -> branch thread;
   - message-keyed topic -> generated topic thread;
   - otherwise -> channel root thread.
6. Create one imported user turn per local-user message. Attach assistant replies through
   existing intent/route reply references when available. Put unmatched legacy system or
   assistant items into explicit imported system turns instead of guessing.
7. Create a default segment per imported thread and committed assignments for imported
   turns.
8. Rebuild message foreign-key columns in attachments, previews, decisions, handoffs,
   proposals, route records, and other referencing tables as item references while
   preserving ids.
9. Convert usable legacy context summaries to the new table when their source item range
   is complete; mark incomplete ranges invalidated so they can be rebuilt.
10. Verify counts, unique ids, thread ownership, sequence continuity, and foreign refs.
11. Drop `channel_messages` and obsolete `channel_context_summaries` only after all checks
    pass inside the transaction.

No runtime dual-read or dual-write adapter is allowed. The migration may read the legacy
tables once; production runtime code after migration cannot.

### Store behavior

- Allocate item sequence by atomically incrementing `ling_threads.next_item_sequence`.
- Return the existing item for a repeated idempotency key.
- Permit payload/revision updates only while status is `pending`.
- Require supersession for committed corrections.
- Batch-resolve domain refs for timeline and context projection reads.

### Exit criteria

- Core migration fixtures cover empty, root-only, topic, branch, mixed, and partially
  linked legacy data.
- A failed validation rolls back the entire migration.
- Item append, retry, paging, supersession, and concurrent sequence allocation tests pass.
- The new store has no adapter that writes back into `channel_messages`.

## Slice S2: Turn Lifecycle And Explicit Thread Topology

### Changes

- At channel ingest, resolve or create the explicit root/topic/branch thread before item
  persistence.
- Append the user item and create its `LingTurn` in one transaction.
- Make every accepted local-user input create a turn before intent selection.
- Associate assistant, tool, approval, operation, and artifact items with the owning turn.
- Mark ordinary reply turns terminal without manufacturing a run.
- Update topic creation to store parent thread, parent turn, and anchor item.
- Update branch creation to store parent lineage now and snapshot id in S5.
- Repoint transcript and thread APIs to explicit thread ids.
- Move the existing reactive compaction fallback to the new summary store. S5 later adds
  proactive thresholds, watermarks, and stale-result handling.
- Register the S1 migration only after these ingest/read paths are ready, then remove the
  old message store interface in the same cutover.

### State transition

```text
input accepted
  -> append user item + LingTurn(open)
  -> process
     -> reply/no_reply terminal
     -> clarify blocked or terminal-by-policy
     -> proposal open/blocked
     -> execute linked to run lifecycle
  -> append terminal observable item
  -> reconcile LingTurn status
```

### Exit criteria

- Ordinary chat, clarification, proposal, and executable work all have a durable turn.
- Topic anchors remain in the parent timeline and are not copied.
- Branches contain only post-fork items.
- Resume/fork/archive/search continue to use authoritative thread/turn rows.
- No runtime store interface exposes `createChannelMessage` or `listChannelMessages`.

## Slice S3: Context Segmentation And Shared Projection

### Components

- `ContextSegmentationPolicy`:
  - deterministic reply/quote/work-correlation inheritance;
  - permission-filtered candidate selection;
  - bootstrap view from current turn, thread shared core, candidate cards, and explicit
    refs before an active segment is known;
  - model proposal parser and allowlist validation;
  - provisional promotion, switch, correction, and supersession.
- `ConversationContextProjector`:
  - shared core collector;
  - active segment collector;
  - recent unsummarized tail;
  - current turn/materialized inputs;
  - role evidence and memory filtering;
  - explicit cross-segment refs;
  - projection version and source refs.
- Adapters for selector, reply, TargetResolver, proposal, workflow step, specialist, and
  inspect views.

### Cutover rule

After S3, no consumer may call a raw `list...Messages(limit=N)` helper to construct model
context. Paging for UI remains allowed; context construction goes through the projector.

### Permission rules

- Filter candidate segments and source refs before any model sees them.
- Include visibility scope in the projection-version fingerprint.
- Fail closed when a ref becomes deleted, private, secret-adjacent, or stale.
- Do not store raw prompt text in the projection metadata.

### Exit criteria

- All context consumers record one projection version for the same turn.
- Segment proposals cannot invent ids or cross permission boundaries.
- Assignment correction invalidates derived projections without editing source items.
- The fixed 6/8/30-message context windows are removed from model-facing consumers.

## Slice S4: Intent v2 And Issue #421 Closure

### Changes

- Replace v1 selector parsing and persistence with `ChannelIntentDecisionV2`.
- Rebuild `channel_intent_decisions` in a dedicated transaction, remove all v1 rows, and
  expose only source turn/item/segment/projection references.
- Make `reply` the ordinary answer and content-generation outcome.
- Make `execute` the only direct bounded execution outcome.
- Run TargetResolver only for validated execution/proposal target kinds.
- Validate clarification output:
  - at least one `missingField`;
  - a question naming the missing product decision;
  - no generic target clarification for independently answerable content.
- Keep runtime approval, tool, sandbox, provider, and workspace policy unchanged.
- Remove old enum literals, v1 parsing, aliases, and old query filters from core,
  contracts, API client, daemon, tests, and Web diagnostics.

### Required regression assertions

```text
article -> "需要，开始吧"
  action=reply
  TargetResolver local-file path not called
  no generic clarification

article -> "保存到 README.md"
  action=execute
  execution.kind=file_create or file_edit
  validated target README.md

bad clarification -> unrelated snake game
  new or switched segment
  decision independent of old missing-field state
  no repeated generic clarification
```

### Exit criteria

- Every issue #421 acceptance case passes with deterministic provider fixtures.
- Existing explicit local-write safety tests still pass.
- Database and API return schema v2 only.
- `rg 'single_reply|direct_workflow'` returns only migration notes or historical design
  sections explicitly marked as superseded.

## Slice S5: Proactive Summaries And Fork Snapshots

### Changes

- Add a summary coordinator that watches committed stable ranges per segment.
- Apply the soft and hard budget thresholds from the owning design through versioned
  policy.
- Persist typed summaries with contiguous coverage watermarks and source refs.
- Reject late results when assignment, visibility, or projection versions changed.
- Invalidate and rebuild summaries after assignment correction.
- Create a `ConversationContextSnapshot` at branch creation and attach its id to the child
  thread.
- Keep one stricter context-length retry as a fallback and emit a health incident.

### Exit criteria

- Long conversations summarize before provider rejection in deterministic budget tests.
- Recent raw tail plus summary can reconstruct goals, decisions, constraints, open
  questions, and source refs.
- A late or stale summary cannot overwrite a newer summary.
- Branch reconstruction uses snapshot refs and never clones parent items.

## Slice S6: Multi-Agent Context Version Consistency

### Changes

- Include projection version, segment id, item watermark, and source refs in every agent
  request and handoff packet.
- Provide every agent the same shared core, then add role-specific evidence.
- Enforce teammate-private memory and private-chat isolation.
- On result fan-in, compare consumed projection with current projection:
  - accept if changed refs are unrelated;
  - rebase metadata-only results when safe;
  - rerun or reject when relevant facts changed.
- Restore new/resumed agents from summary, recent tail, active work, and allowed memory.

### Exit criteria

- Two agents on one turn agree on shared goal, decisions, constraints, and segment.
- Private data leakage fixtures fail closed.
- Stale relevant results cannot silently commit into the current turn.
- Handoffs remain source-linked and contain no hidden model reasoning.

## Slice S7: Transcript, API, Diagnostics, And Cleanup

### Changes

- Project conversation transcript blocks from `conversation_items` plus domain refs.
- Replace message endpoints/types with item/turn endpoints or a stable compatibility-free
  API rename appropriate for the pre-release product.
- Update safe Context inspect details with:
  - thread/turn/segment ids;
  - projection version;
  - summary coverage;
  - source refs;
  - dropped/redacted counts.
- Add a user correction action for the effective segment in advanced context details.
- Remove old stores, mappers, selectors, tests, and documentation claims that make
  `channel_messages` or fixed windows authoritative.
- Update implementation status only after all acceptance suites pass.

### Exit criteria

- Web refresh, streaming, topic, branch, operation cell, and evidence views read the new
  contracts.
- Context diagnostics never expose raw prompts, private memory, secrets, or hidden
  reasoning.
- No old timeline table or v1 intent runtime path remains.

## Test Coverage Plan

### Code paths and user flows

```text
CODE PATHS                                             USER FLOWS
[S-1] route supervised reply guidance                 [E2E] active reply boundaries
  ├── explicit same-line activeRunId                     ├── same-line guidance -> FIFO
  ├── pending predecessor without Run id                 ├── Root active + Branch -> independent
  ├── stale/cross-line relation rejected                 ├── active reply + file work -> execute path
  └── continuation target Thread preserved               └── rapid submit before Run link

[S1] append item                                      [E2E] ordinary long conversation
  ├── allocate sequence                                  ├── article request -> continuation
  ├── retry same idempotency key                          ├── later unrelated request
  ├── pending -> committed                                └── resume after restart
  ├── supersede committed item
  └── rollback on migration validation                 [E2E] explicit conversation surfaces
                                                          ├── root thread
[S2] ingest turn                                          ├── topic from anchor item
  ├── root/topic/branch resolution                        └── branch from context snapshot
  ├── create user item + LingTurn atomically
  ├── ordinary terminal without run                    [E2E] execution safety
  └── executable turn linked to run                       ├── content reply without file target
                                                          ├── explicit local write
[S3] assign and project                                    ├── missing target clarification
  ├── structural inheritance                              └── approval remains runtime-gated
  ├── model candidate allowlist
  ├── provisional -> active                            [EVAL] semantic continuity
  ├── correction/supersession                             ├── continue current segment
  ├── permission filter                                   ├── switch existing segment
  └── stable projection version                           ├── propose new segment
                                                          └── distinguish content from file work
[S4] intent v2
  ├── reply
  ├── clarify with missing fields                      [SECURITY] multi-agent isolation
  ├── workflow proposal                                   ├── shared core consistency
  ├── execute -> typed TargetResolver                     ├── private teammate memory blocked
  └── no_reply terminal                                   └── stale result rejected/rebased

[S5] summary/snapshot
  ├── soft asynchronous trigger
  ├── hard synchronous trigger
  ├── late result rejection
  ├── assignment invalidation
  ├── context-length fallback retry
  └── branch snapshot reconstruction
```

### Core tests

Add focused cases under `packages/core/test/` for:

- migration, counts, rollback, foreign references, and old-table removal;
- monotonic sequence allocation under concurrent append attempts;
- idempotent item retry and committed-item supersession;
- thread root uniqueness and topic/branch lineage;
- turn assignment uniqueness and supersession;
- summary coverage, replacement, invalidation, and snapshot reads.

### Daemon tests

Add focused cases under `packages/daemon/test/` for:

- S-1 conversation-line lane isolation, explicit disposition validation, rapid-submit
  linking, normal intent fallthrough, and continuation Thread lineage;
- channel ingest creates user item, turn, and effective segment assignment atomically;
- selector, reply, resolver, proposal, and specialist receive one projection version;
- structural reply/quote/work inheritance;
- model proposal allowlist and permission rejection;
- issue #421 article, continuation, unrelated request, and explicit file variants;
- actionable clarification validation;
- proactive summary trigger and stale result rejection;
- multi-agent shared-core and private-memory isolation;
- context-length fallback remains one bounded retry.

### Contract and API tests

- Serialize every item payload kind and intent v2 variant.
- Reject unknown schema versions, old intent enum values, invalid visibility owners, and
  malformed domain refs.
- Verify item paging by `(threadId, sequence)` and stable cursor behavior.

### Eval suite

Prompt/model changes require an eval set, not only deterministic parser tests. Add cases
for Chinese and English continuations, topic switches, ambiguous pronouns, content
generation, explicit artifact creation, local file operations, command requests, and
malicious attempts to name inaccessible segment ids.

Compare:

- segment action accuracy;
- false new-segment rate;
- false continuation rate;
- content-versus-execution accuracy;
- clarification actionability;
- permission-boundary rejection rate.

### Web E2E

Add or extend channel E2E coverage for:

- active reply guidance shown only on the current Root/Topic/Branch Thread;
- a conversation surviving enough turns to trigger a summary and then resuming;
- root/topic/branch navigation with no duplicated anchor or inherited item rows;
- streaming item commit and reconnect idempotency;
- segment correction in advanced context details;
- issue #421 visible regression flow;
- context source inspection without raw/private leakage.

### Verification commands

Run narrow tests first, then broader packages:

```bash
corepack pnpm --filter @ling-stack/remote-protocol build
corepack pnpm --filter @ling-stack/contracts test
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test
corepack pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts
```

Use focused `node --test --test-name-pattern` and Playwright `-g` commands during each
slice. Run full package suites before authority cutover and before final cleanup.

## Failure Mode Matrix

| Code path | Production failure | Test | Handling | User-visible result |
| --- | --- | --- | --- | --- |
| item append | retry duplicates message | idempotency/concurrency core test | return existing item | one message only |
| sequence allocator | concurrent writers collide | concurrent append core test | SQLite transaction retries/fails atomically | bounded retry, no reorder |
| migration | legacy ref cannot map | rollback fixture | abort transaction with exact diagnostic | daemon does not start on half-migrated DB |
| segment model | proposes hidden segment id | permission daemon test | reject before commit | current context or actionable clarification |
| projection | one source deleted mid-build | stale-source daemon test | rebuild or fail closed | bounded retry/error, no leaked content |
| intent | conversational `开始` becomes file create | issue #421 regression | `reply`; skip file resolver | article continues normally |
| clarify | model gives generic question | clarification validation test | reject/downgrade/fallback with missing field | specific question or direct answer |
| summary | late result overwrites current facts | version race test | reject and reschedule | no stale memory |
| branch | parent changes after fork | snapshot reconstruction test | child remains bound to fork snapshot | stable branch history |
| agent fan-in | result used old relevant facts | stale-result test | rebase, rerun, or reject | coordinator reports current result only |
| privacy | private memory enters public view | security fixture | fail closed and audit rejection | no private excerpt |
| context budget | provider still rejects | fallback retry test | one stricter retry and health incident | concise recoverable error if retry fails |

No listed critical path is allowed to have both silent failure and no automated test.

## Performance Plan

### Query budgets

- Timeline paging is index-only by thread and sequence before payload/domain hydration.
- Projection reads one active assignment, current summary, recent tail, and bounded domain
  refs. It does not scan the full thread.
- Batch domain ref hydration by type to avoid N+1 reads.
- Segment candidate cards use recent active segments and explicit refs. Do not render all
  historical segments for every turn.
- Summary coordinator scans coverage watermarks, not full payload bodies, to find work.

### SQLite contention

- Keep sequence allocation and item insert in a short transaction.
- Never perform model calls, summary generation, attachment extraction, or domain
  hydration while holding a write transaction.
- Persist late async results only after version validation in a new short transaction.

### Measurements

Capture safe metrics:

- projection build duration and source counts;
- item append transaction duration/retry count;
- unsummarized turn/token estimate and summary lag;
- summary generation success/stale-discard/failure counts;
- segment continue/switch/new/provisional/correction counts;
- intent action distribution and clarification validation failures;
- context-length fallback frequency.

Do not log raw item bodies, prompts, secrets, or private memory in metrics.

## Parallelization Strategy

The authority cutover is mostly sequential because contracts, storage, ingest, and
projection share the same core modules. Parallel work begins only after S3 stabilizes.

| Step | Modules touched | Depends on |
| --- | --- | --- |
| S-1 #422 bridge alignment | request contracts, Channel reply dispatch/lane, continuation, Web guidance | PR #422 head |
| S0 contracts/fixtures | `packages/contracts`, shared fixtures | none |
| S1 storage migration/items | `packages/core/storage`, core tests | S0 |
| S2 turn/thread ingest | `packages/daemon/channels`, `packages/core` | S1 |
| S3 segmentation/projector | `packages/daemon/channels/context-processing`, core continuity store | S2 |
| S4 intent v2 | channel selector/resolver, contracts/API client | S3 |
| S5 summaries/snapshots | context processing, continuity store | S3 |
| S6 multi-agent consistency | orchestrator/handoffs/context views | S3, S5 |
| S7 transcript/API/UI cleanup | transcript projector, API client, Web | S4, S5, S6 |

Execution lanes:

```text
Prerequisite: S-1 -> merge #422 -> rebase Continuity v2 branch
Lane A: S0 -> S1 -> S2 -> S3
After S3:
  Lane A: S4 intent v2
  Lane B: S5 summaries/snapshots
After A + B:
  Lane A: S6 multi-agent consistency
  Lane B: prepare S7 transcript/API fixtures
Final: merge S6, then complete S7 and run full cutover verification
```

Conflict warning: S4 and S5 both touch Context Processing contracts. Freeze projection
interfaces at the end of S3 and keep implementation files separate before parallel work.

## Implementation Tasks

- [x] **T0 (P0)**: align #422 supervised reply Runs with typed, conversation-line scoped
  follow-up routing and target Thread lineage.
  - Verify: focused daemon dispatch/integration tests, Web guidance tests, builds/typecheck,
    lint, i18n, and full-suite regression audit.
- [x] **T1 (P1, human: ~1 day / Codex: ~1-2 hours)**: define v2 contracts and golden fixtures.
  - Verify: contracts build and fixture parser tests.
- [ ] **T2 (P1, human: ~3 days / Codex: ~4-6 hours)**: implement transactional schema migration and `ConversationItemStore`.
  - Verify: core migration, rollback, sequence, idempotency, paging, and supersession tests.
- [ ] **T3 (P1, human: ~2 days / Codex: ~3-4 hours)**: create every user `LingTurn` and map root/topic/branch explicitly.
  - Verify: daemon ingest and thread-lineage tests.
- [ ] **T4 (P1, human: ~3 days / Codex: ~5-7 hours)**: implement segmentation policy and shared projector; remove raw fixed-window consumers.
  - Verify: projection consistency, permission, correction, and consumer adapter tests.
- [ ] **T5 (P1, human: ~2 days / Codex: ~3-4 hours)**: cut intent decisions to v2 and close issue #421.
  - Verify: daemon regression suite, explicit file safety, clarification actionability, and eval cases.
- [ ] **T6 (P2, human: ~2 days / Codex: ~3-5 hours)**: add proactive summaries, coverage watermarks, stale-result rejection, and fork snapshots.
  - Verify: budget, race, invalidation, reconstruction, and fallback tests.
- [ ] **T7 (P2, human: ~2 days / Codex: ~3-5 hours)**: enforce multi-agent projection versions and private-memory isolation.
  - Verify: shared-core, stale fan-in, handoff, and security fixtures.
- [ ] **T8 (P2, human: ~2 days / Codex: ~3-4 hours)**: switch transcript/API/Web diagnostics and remove old runtime authorities.
  - Verify: package suites, channel E2E, old-symbol search, and migration smoke.

## NOT In Scope

- A new vector database or embedding service. Candidate segment selection starts with
  structured recency, explicit refs, and model-assisted cards.
- Cloud synchronization or cross-device conflict resolution for SQLite.
- Full manual segment administration in the default conversation UI. The first correction
  control belongs in advanced Context details.
- Exposing raw prompts, hidden reasoning, full logs, or private teammate memory.
- Replacing workflow, run, approval, artifact, or Ling Memory stores.
- Backward-compatible aliases for intent v1 or a runtime dual-read period.
- Reworking unrelated conversation visual design beyond fields needed to inspect and
  correct continuity.

## Documentation Closure

Before declaring the program complete:

1. Update the status of the owning design with verified implementation slices.
2. Reconcile Channel Context Processing, Intent Selector, Ling Agent Session, and
   Thread-First Work History docs with shipped contracts.
3. Update `implementation-status.md` with exact tests and commit references.
4. Remove superseded implementation-plan bullets rather than leaving duplicate active
   plans.
5. Close issue #421 only after its visible Web flow and daemon persistence assertions
   both pass.

## Unresolved Decision Verdict

No architecture or ownership decision is unresolved.

Summary thresholds, provisional promotion confidence, and default correction UI
visibility are versioned policy parameters. The initial values in the owning design are
the implementation baseline and can be tuned from measured evidence without changing the
schema.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | --- | --- | --- |
| CEO Review | `/plan-ceo-review` | Scope and strategy | 0 | not run | Not required for this architecture correction |
| Codex Review | `/codex review` | Independent second opinion | 0 | not run | Not requested |
| Eng Review | `/plan-eng-review` | Architecture and tests | 1 | CLEAR | 19 architecture, code-quality, test, and performance findings folded into S0-S7 |
| Design Review | `/plan-design-review` | UI and UX gaps | 0 | not run | UI changes are limited to later advanced Context details |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | Not required for the design baseline |

**VERDICT:** ENG CLEARED. S-1 and S0 are implemented; S1-S7 retain the reviewed delivery
order and exit criteria.

NO UNRESOLVED DECISIONS
