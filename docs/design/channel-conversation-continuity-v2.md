# Channel Conversation Continuity v2

Status: approved design baseline; S-1 and S0 merged; S1+S2 and S3 implemented and locally verified; S4-S7 pending
Date: 2026-08-08
Last verified: 2026-08-10
Scope: channel conversation persistence, Thread/Turn/Item topology, context segmentation,
context projection, rolling summaries, multi-agent recovery, and Channel Intent Decision v2

Related docs:

- [Ling Agent Session Control Plane](ling-agent-session.md)
- [Channel Context Processing Layer](channel-context-processing-layer.md)
- [Channel Context Processing Layer Implementation Plan](channel-context-processing-layer-implementation-plan.md)
- [Channel Context Budget Manager](channel-context-budget-manager.md)
- [Channel Intent To Workflow Selector](channel-intent-workflow-selector.md)
- [Thread-First Work History v2 Detailed Design](thread-first-work-history-v2-detailed-design.md)
- [Conversation Memory Citations And Sources](conversation-memory-citations-and-sources.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)

## Decision Summary

Ling keeps SQLite. The current failure is not that durable history is missing. The failure
is that durable records do not form one logical conversation timeline and each consumer
builds a different short context window.

The long-term model is:

```text
Channel                         collaboration, membership, permissions, protocol
└── LingThread                  one durable conversation line
    └── LingTurn                one user-intent lifecycle
        └── ConversationItem    ordered observable input, output, action, and result
```

The approved decisions are:

1. `conversation_items` becomes the canonical conversation timeline and eventually
   replaces `channel_messages`. `channel_messages` is not expanded into a universal item
   table.
2. `LingTurn` is created for every accepted user turn, including ordinary conversation.
   Whether work executes is a turn outcome, not the condition for creating a turn.
3. Channel root, explicit topic, and branch are separate `LingThread` surfaces with
   explicit lineage. A topic or branch does not copy the parent transcript.
4. `contextSegmentId` is a reversible semantic working-set assignment inside a thread.
   It is not another thread and it is not privately chosen by each agent.
5. One `ConversationContextProjector` builds all selector, reply, target-resolution,
   workflow, and specialist views from the same committed sources.
6. Rolling summaries are proactive, versioned, coverage-aware, and source-linked. A
   provider context-length error remains a fallback signal, not the primary trigger.
7. Multi-agent recovery uses shared core facts plus role-relevant evidence and
   permission-allowed private memory. No agent receives the full raw transcript by
   default.
8. `ChannelIntentDecision.schemaVersion` moves directly to v2. In this pre-release phase
   there are no v1 aliases or dual-read compatibility paths. `single_reply` becomes
   `reply`; `direct_workflow` becomes `execute`.
9. An ordinary `reply` may use a supervised `RunSession` with `tools=[]` and read-only
   workspace policy for streaming, cancellation, FIFO guidance, recovery, and diagnostics.
   The owning `LingTurn` remains the business lifecycle authority; the Run is not a second
   conversation authority.
10. An active reply never captures a whole Channel. Follow-up routing requires a typed
    client disposition and server validation against the same conversation line. Without
    that structural relation, the message continues through normal intent selection.

## Problem And Evidence

GitHub issue [#421](https://github.com/tianxiaochannel-oss88/ling-stack/issues/421)
shows the immediate product failure:

- a conversational continuation such as `需要，开始吧` is interpreted as
  `direct_workflow/file_create`;
- file target validation then asks for a path that the user never intended to provide;
- the generic clarification becomes recent context and influences later unrelated turns;
- the same request can behave differently in a fresh channel because it has a different
  short recent-message window.

The current implementation persists the underlying messages and decisions. It still
constructs different views:

```text
ordinary reply            -> recent 6 messages
intent selector           -> recent 8 messages, bodies truncated
workflow proposal         -> recent 6 messages
TargetResolver            -> up to 30 messages
context-error compaction  -> selects from 30, keeps 20, renders a recent subset
```

This creates four coupled problems:

1. **Continuity:** long conversations feel forgotten even though SQLite still contains
   the history.
2. **Consistency:** selector, reply, resolver, summary, and specialist agents see
   different evidence.
3. **Contamination:** an incorrect clarification or unrelated root-channel topic can
   enter every later fixed window.
4. **Recovery:** a new agent or resumed session has no single authoritative projection to
   rebuild.

The root cause is therefore broader than one prompt or enum value. Ling needs a canonical
conversation model and a shared context projection boundary.

## Goals

- Keep every observable conversation event durable, ordered, and recoverable.
- Let users continue, resume, fork, inspect, and correct a conversation without losing
  its source evidence.
- Keep key goals, decisions, constraints, open questions, active work, and source refs
  consistent across agents.
- Prevent unrelated root-channel topics and incorrect clarifications from contaminating
  later turns.
- Preserve typed workflow, run, approval, artifact, and memory authority in their
  existing domain stores.
- Make context selection auditable without exposing prompts, secrets, or hidden model
  reasoning.
- Make incorrect segmentation and summary decisions reversible.

## Non-Goals

- Do not send the full raw transcript to every model or agent.
- Do not store or expose hidden chain-of-thought.
- Do not merge Channel membership, permission, workflow, run, approval, artifact, or
  memory authority into `conversation_items`.
- Do not make keyword matching the primary topic-switch or execution classifier.
- Do not make the Web client a conversation store or context owner.
- Do not retain runtime aliases for v1 intent names during pre-release development.

## Canonical Ownership

| Concept | Authority | Responsibility |
| --- | --- | --- |
| `Channel` | channel store | members, roles, policy, protocol, workspace binding |
| `LingThread` | thread store | durable conversation line, lifecycle, lineage, archive/fork/resume |
| `LingTurn` | turn store | one user or system intent lifecycle and its terminal outcome |
| `ConversationItem` | conversation item store | ordered observable timeline and stable references |
| `ContextSegment` | context continuity store | semantic working-set boundary within one thread |
| `TurnContextAssignment` | context continuity store | auditable, reversible turn-to-segment assignment |
| `ConversationContextSummary` | context continuity store | compact typed facts with coverage watermark and source refs |
| Workflow/run/approval/artifact tables | existing domain stores | authoritative business and execution state |
| `ConversationContextProjector` | daemon/core projection service | permission-filtered per-consumer context views |
| `ConversationTranscript` | daemon/core read model | user-visible semantic blocks and evidence references |

`ConversationItem` provides ordering and public metadata. It references domain records;
it never copies their mutable authority. For example, an approval item points to an
`approval_request` record, and the approval table remains authoritative for whether work
may proceed.

## Thread Topology

### Surface mapping

| Channel surface | Ling mapping | Lineage |
| --- | --- | --- |
| Channel root | exactly one `LingThread(surfaceKind="channel_root")` | no parent |
| Explicit topic | child `LingThread(surfaceKind="topic")` | parent thread, parent turn, anchor item |
| Branch/fork | child `LingThread(surfaceKind="branch")` | parent thread, parent turn, fork context snapshot |

```text
Channel
└── Root LingThread
    ├── Topic LingThread
    │   └── topic-only turns and items
    └── Branch LingThread
        └── post-fork turns and items
```

Recommended thread fields:

```ts
type LingThreadSurfaceKind =
  | "channel_root"
  | "topic"
  | "branch"
  | "direct"
  | "work";

type LingThreadRelationKind = "root" | "topic" | "branch";

interface LingThreadContinuity {
  readonly surfaceKind: LingThreadSurfaceKind;
  readonly relationKind: LingThreadRelationKind;
  readonly parentThreadId?: string;
  readonly parentTurnId?: string;
  readonly anchorItemId?: string;
  readonly forkContextSnapshotId?: string;
}
```

Rules:

- The root feed reads the root thread. Root items no longer use `thread_id = NULL` as
  implicit ownership.
- A topic anchors to one parent item. The anchor remains in the parent timeline; it is not
  duplicated into the topic.
- A branch records a compact context snapshot at the fork boundary. It inherits the
  effective context before that boundary, then evolves independently.
- Topic and branch creation are explicit user or product actions. Semantic topic changes
  inside the root do not silently create visible child threads.
- A channel may contain many work threads, but only one active non-archived
  `channel_root` thread.

### Root-level topic isolation

Users will still discuss unrelated work in the root without creating a formal topic.
`ContextSegment` isolates those working sets while preserving one root transcript.

```text
Root LingThread
  Segment A: Issue #421 diagnosis
  Segment B: long-term context architecture
  Segment C: unrelated UI task
```

### S-1 reply-supervision bridge

PR #422 supplies a useful pre-v2 supervision layer for ordinary replies. The bridge is
accepted only with the following boundaries:

```ts
interface ChannelReplyDisposition {
  readonly mode: "queue_followup";
  readonly activeRunId?: string;
}
```

The temporary conversation-line key is derived structurally from the persisted Channel
surface:

```text
root                         -> root
branch root LingThread       -> branch:<rootThreadId>
message-keyed topic          -> topic:<sourceMessageId>
other explicit thread        -> thread:<threadId>
```

Rules:

- the pending-reply lane key is `(workspaceId, channelId, conversationLineKey)`, never
  the entire Channel and never the selected teammate;
- `activeRunId` means “queue behind this exact active reply Run” and is accepted only when
  the Run's persisted `requestSnapshot.sourceMessageId` resolves to the same line;
- omitting `activeRunId` is allowed only for a rapid-submit predecessor whose Run has not
  linked yet; the line-scoped coordinator waits for that link. If no live predecessor lane
  exists, the daemon returns to normal intent routing and never searches for another active Run;
- omitting `replyDisposition` means the message is a new turn and must continue through
  normal intent selection even when another reply is active;
- a stale, terminal, missing, cross-Channel, or cross-line Run id cannot cause queueing;
- `ConversationActiveReplyTarget.sourceMessageId` is projected from the Run snapshot and Web
  filters guidance by the persisted source ChannelMessage line. `RunSession.threadId` remains
  the canonical LingThread id, so a Root reply is not presented as a Branch or Topic target;
- continuation context is rebuilt from the guidance message. Branch continuations retain the
  Branch LingThread; message-keyed Topics temporarily retain the canonical Channel Root
  LingThread plus explicit `sourceMessageId` until Topic LingThread materialization lands in S2;
- the store atomically claims the oldest pending intervention without a fixed history-page
  window; concurrent terminal callbacks cannot claim the same item, and a failed start
  continues draining the next FIFO item;
- public Run-intervention requests cannot provide channel lineage fields. Only validated
  Channel dispatch writes `sourceMessageId` and `targetTeammateId`;
- no text keyword or model guess may manufacture `queue_followup`.

This bridge does not add a second timeline or delay the S1/S2 authority cutover. Until
`ConversationItem` becomes canonical, existing Channel message ids are source references
only. At S2 the same structural line relation is resolved from explicit `LingThread`
ownership, and at S4 the typed disposition remains separate from `reply | execute` intent.

## Turn Boundary

`LingTurn` becomes the durable intent boundary for ordinary conversation and executable
work.

Creation rules:

- create a turn before selector or reply routing for every accepted local-user input;
- create system-originated turns for automation, external work updates, workflow steps,
  or review actions when they form an independent lifecycle;
- link queue follow-up, redirect, retry, resume, or validation turns through
  `sourceTurnId` and existing run-link records;
- mark an ordinary successful reply turn as terminal even when it has no run;
- when an ordinary reply uses a supervised read-only Run, link that Run as execution and
  recovery evidence without transferring turn ownership to the Run;
- keep tool calls, approvals, artifacts, and terminal results inside the owning turn;
- never infer turn boundaries from assistant wording.

This supersedes the earlier rule in Thread-First Work History v2 that created `LingTurn`
only for executable work. That rule prevents ordinary conversation from sharing the same
recovery, segmentation, and summary model.

The turn lifecycle remains independent from execution:

```text
accepted user item
  -> LingTurn(open)
  -> context assignment and projection
  -> reply | clarify | propose | execute | no_reply
     -> no run: terminal turn
     -> run: existing run/approval lifecycle
  -> terminal item(s)
  -> LingTurn(succeeded | failed | blocked | cancelled | superseded)
```

## Conversation Item Model

### Envelope plus typed payload

The selected item design is one stable envelope with typed payloads and domain refs.

```ts
type ConversationItemKind =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "approval_request"
  | "approval_decision"
  | "handoff"
  | "operation_state"
  | "artifact_ref"
  | "system_event";

type ConversationItemStatus =
  | "pending"
  | "committed"
  | "failed";

type ConversationItemVisibility =
  | "channel"
  | "thread_participants"
  | "agent_private"
  | "operator";

interface ConversationItem {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly sequence: number;
  readonly kind: ConversationItemKind;
  readonly status: ConversationItemStatus;
  readonly actorType: "local_user" | "ling_agent" | "teammate" | "system";
  readonly actorId?: string;
  readonly visibility: ConversationItemVisibility;
  readonly visibilityOwnerId?: string;
  readonly payload: ConversationItemPayload;
  readonly domainRefs: readonly DomainRef[];
  readonly idempotencyKey?: string;
  readonly revision: number;
  readonly supersedesItemId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly committedAt?: string;
}
```

Typed payloads live in shared contracts. Runtime code switches on `kind`; it does not
inspect arbitrary JSON fields or generated prose to infer structure.

The user-message payload preserves mentions, attachment ids, link-preview ids, and typed
workspace file refs so migration never discards materialized-input or routing evidence. An
empty body is valid only when one of those input refs is present. The assistant-message
payload keeps `pending | ready | blocked | failed` delivery state separate from the item
commit state so streaming and visible blocker rows can be projected without overloading
timeline persistence semantics.

### Ordering and mutation

- `sequence` is monotonic within a thread and unique with `thread_id`.
- SQLite allocates the next sequence atomically by incrementing a thread-owned cursor in
  the same transaction as item insertion.
- `idempotencyKey` prevents duplicate writes after retries or reconnects.
- A pending streamed assistant message may update its payload and revision until commit.
- A committed item's payload and ordering are immutable. Corrections append a replacement
  with `supersedesItemId`; the projector derives which item is effective from the
  supersession chain.
- Tool call and tool result are separate items linked through a domain/source ref.
- Domain state transitions append observable items, while the domain table remains the
  authority.

### Storage direction

`conversation_items` replaces `channel_messages` as the timeline source of truth.
Message ids can be preserved during one-time migration, but runtime dual-write and
dual-read are prohibited.

Message-adjacent tables move from `message_id` to `item_id` references. Heterogeneous
domain refs use typed `(type, id)` values instead of polymorphic foreign keys.

## Context Segment Model

### Meaning

`contextSegmentId` answers one question:

> Which prior goals, decisions, constraints, open questions, and evidence should be
> automatically considered for this turn?

It is assigned to the turn. Items inherit the turn assignment; they are not classified
independently.

```ts
interface ContextSegment {
  readonly id: string;
  readonly threadId: string;
  readonly state: "provisional" | "active" | "merged" | "archived";
  readonly label?: string;
  readonly createdFromTurnId: string;
  readonly lastActiveTurnId: string;
  readonly mergedIntoSegmentId?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

### Ownership

The decision is hybrid but not a three-way vote:

1. User explicit selection is authoritative.
2. Structural relationships apply deterministic inheritance.
3. A model may propose semantic continuation, switch, or a new segment.
4. `ContextSegmentationPolicy` validates and commits the assignment.

No individual specialist agent may create its own authoritative assignment.

### Deterministic inheritance

The policy does not call a model when:

- the item replies to or quotes a known item;
- the turn is an approval, steer, queued follow-up, redirect, retry, or tool result tied
  to an existing turn;
- the user explicitly switches to a known segment;
- the user explicitly creates a topic or branch, which creates a new thread instead;
- a domain correlation id unambiguously binds the turn to active work.

These are structural rules, not keyword rules.

### Model proposal

When structural evidence is insufficient, the model receives permission-filtered segment
cards, not the full transcript. It must return one of:

```ts
type ContextSegmentProposal =
  | { action: "continue"; segmentId: string; antecedentTurnId?: string; confidence: number; evidenceItemIds: readonly string[] }
  | { action: "switch_existing"; segmentId: string; antecedentTurnId?: string; confidence: number; evidenceItemIds: readonly string[] }
  | { action: "propose_new"; confidence: number; relatedSegmentIds: readonly string[]; reason: string }
  | { action: "uncertain"; candidateSegmentIds: readonly string[] };
```

The model may choose only server-provided candidate ids. It cannot read inaccessible
segments or invent an authoritative id.

Segment selection has a bootstrap view to avoid circular dependency:

```text
current user turn
  + permission-filtered thread shared core
  + bounded candidate segment cards
  + explicit reply/quote/work refs
  -> ContextSegmentationPolicy
  -> effective assignment
  -> normal per-segment ConversationContextProjection
```

The bootstrap view is not a general reply or execution context. It exists only to select
the working set and records the candidate source refs it used.

### Provisional state and correction

New semantic segments begin as `provisional` when confidence is insufficient for a hard
boundary. They become active after a second related turn, a concrete work object, or an
explicit user confirmation.

Assignments are append-only and supersedable:

```ts
interface TurnContextAssignment {
  readonly id: string;
  readonly turnId: string;
  readonly segmentId: string;
  readonly status: "provisional" | "committed";
  readonly revision: number;
  readonly decisionSource: "user" | "structural" | "model_policy";
  readonly confidence?: number;
  readonly antecedentTurnId?: string;
  readonly evidenceRefs: readonly DomainRef[];
  readonly policyVersion: string;
  readonly supersedesAssignmentId?: string;
  readonly createdAt: string;
}
```

Correcting an assignment does not edit raw items. It invalidates affected summaries and
creates a new assignment revision and projection version. The effective assignment is the
highest valid revision in the supersession chain; older rows remain unchanged.

### Granularity rule

A new fact is not automatically a new segment. Create or switch segments when bringing
the current segment's goal and decisions into the next turn would mislead rather than
help.

Examples:

| Turn | Result |
| --- | --- |
| `先别修，继续分析 #421` | continue the issue segment |
| `还有一个问题，最近 8 条是不是会失忆` | new context-architecture segment, linked back to #421 by source ref |
| `方案 B 就这样定` | continue the context-architecture segment |
| `回到 #421，现在直接修` | switch to the existing issue segment |
| `为上下文架构正式建一个 Topic` | create a child thread, not another hidden segment |

## Shared Context Projection

### One owner

All context consumers call `ConversationContextProjector`. Consumers may request a view
kind and budget, but they cannot independently scan raw recent messages.

```text
committed ConversationItems + domain records + assignments + summaries + memory
        |
        v
permission and visibility filter
        |
        v
ConversationContextProjector
  shared core
  active segment
  recent unsummarized tail
  current turn and materialized inputs
  role-relevant evidence
  allowed memory
  explicit cross-segment refs
        |
        v
selector | reply | resolver | proposal | workflow step | specialist | inspect
```

Every projection carries:

```ts
interface ConversationContextProjectionMetadata {
  readonly projectionVersion: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly segmentId: string;
  readonly throughItemSequence: number;
  readonly summaryIds: readonly string[];
  readonly sourceRefs: readonly DomainRef[];
  readonly policyVersion: string;
  readonly visibilityFingerprint: string;
}
```

`projectionVersion` is derived from thread revision, effective assignment revision,
summary versions, visibility scope, and the item sequence watermark. Runs and agent
requests store this version with their input evidence.

### Shared core and role views

Every eligible agent receives the same shared core:

- current goal or topic;
- confirmed decisions and constraints;
- open questions and risks;
- active work and pending approvals;
- current rolling summary;
- source refs.

Then the projector adds only role-relevant evidence and permission-allowed private
memory. A specialist does not receive all peer transcripts, private memories, raw logs,
or unrelated segments.

### TargetResolver boundary

TargetResolver consumes the same projection and structured candidates. It does not scan a
different 30-message window.

Local file target validation runs only when the validated intent outcome requests a local
file or workspace side effect. A conversation subject such as an article is not promoted
to a filesystem target merely because the user said `写` or `开始`.

## Rolling Summaries

### Summary shape

A durable summary is typed, scoped, versioned, and source-linked:

```ts
interface ConversationContextSummary {
  readonly id: string;
  readonly threadId: string;
  readonly segmentId?: string;
  readonly scope: "segment" | "thread_core" | "work";
  readonly status: "active" | "superseded" | "invalidated";
  readonly version: number;
  readonly coveredFromSequence: number;
  readonly coveredThroughSequence: number;
  readonly objective?: string;
  readonly decisions: readonly string[];
  readonly constraints: readonly string[];
  readonly openQuestions: readonly string[];
  readonly activeWorkRefs: readonly DomainRef[];
  readonly sourceRefs: readonly DomainRef[];
  readonly supersedesSummaryId?: string;
  readonly policyVersion: string;
  readonly createdAt: string;
}
```

The summary does not contain secrets, hidden reasoning, raw provider prompts, full logs,
or private teammate content outside its visibility scope.

### Trigger policy

Initial defaults are policy values, not schema constants:

- soft asynchronous trigger when one segment has at least 32 unsummarized completed
  turns or its eligible raw context exceeds 30% of the resolved input budget;
- compact the oldest stable range and leave at least the most recent 8 completed turns
  raw;
- synchronous hard compaction when the candidate projection exceeds 70% of input budget;
- target a post-compaction projection below 55% so current input, tools, and output retain
  headroom;
- a provider context-length error may perform one stricter retry and records a health
  incident. It must not be the normal time summaries are first created.

The provider-aware Context Budget Manager supplies the input budget. Unknown providers
use its conservative budget class.

### Coverage and concurrency

- A summary covers a contiguous sequence range and records the exact watermark.
- New items after the watermark do not invalidate the summary.
- A late summary result may commit only if its source range and assignment versions still
  match. Otherwise it is discarded and regenerated.
- A corrected segment assignment inside the covered range invalidates the affected
  summary and schedules a rebuild.
- Summary replacement uses `supersedesSummaryId`; historical source refs remain
  inspectable.

## Branch Context Snapshots

A branch must not clone parent items. It records a source-linked snapshot:

```ts
interface ConversationContextSnapshot {
  readonly id: string;
  readonly threadId: string;
  readonly segmentId: string;
  readonly projectionVersion: string;
  readonly throughItemSequence: number;
  readonly summaryIds: readonly string[];
  readonly sourceRefs: readonly DomainRef[];
  readonly policyVersion: string;
  readonly createdAt: string;
}
```

The child thread can reconstruct its inherited starting context from the snapshot and
parent source refs. Later parent changes do not silently rewrite the child branch.

## Multi-Agent Recovery And Consistency

Rules:

- Ling Agent is the single assignment and narration owner.
- Specialists may propose relevant segment or source refs but cannot commit assignment.
- Every agent request includes `contextProjectionVersion` and source refs.
- A result based on an older version is accepted only when changed context is unrelated;
  otherwise the coordinator rebases, reruns, or rejects it.
- A new or resumed agent reconstructs from the thread core, active segment summary,
  recent tail, active work, and its allowed memory.
- Handoffs contain typed facts and source refs, not hidden free-form reasoning.
- Private teammate chat and memory remain private unless explicitly promoted through a
  permission-checked visible item.

This gives all agents recoverable and consistent selective memory without pretending
that every agent permanently remembers every raw message.

## Channel Intent Decision v2

### Action contract

```ts
type ChannelIntentDecisionAction =
  | "no_reply"
  | "reply"
  | "visible_multi_reply"
  | "clarify"
  | "workflow_proposal"
  | "execute";

interface ChannelIntentDecisionV2 {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceTurnId: string;
  readonly sourceItemId: string;
  readonly contextSegmentId: string;
  readonly contextProjectionVersion: string;
  readonly action: ChannelIntentDecisionAction;
  readonly selectedTeammateIds: readonly string[];
  readonly proposalId?: string;
  readonly resultItemIds: readonly string[];
  readonly workflowId?: string;
  readonly reason: string;
  readonly clarification?: {
    readonly missingFields: readonly string[];
    readonly question: string;
  };
  readonly execution?: {
    readonly kind: "file_create" | "file_edit" | "open_local_target" | "run_command";
    readonly targetKind: "file" | "directory" | "command" | "workspace";
    readonly targetRef?: DomainRef;
  };
  readonly status: "accepted" | "suppressed" | "failed";
  readonly createdBy: "deterministic" | "model_policy";
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Rules:

- `reply` owns ordinary answers and in-conversation content generation.
- `execute` means the user requested bounded executable work. It does not itself bypass
  proposal, tool, sandbox, permission, or approval policy.
- Content generation remains `reply` unless the user explicitly requests a file,
  workspace mutation, command, or other external side effect.
- TargetResolver runs only after `execute`, or after a proposal path that explicitly
  requires a typed target.
- `clarify` requires structured `missingFields` and a question that names the missing
  product decision. A generic target question with no missing field is invalid.
- A concrete, independently answerable request cannot inherit a prior clarification as a
  hidden lock.
- `no_reply` truly means no user-visible reply is needed. It is not a disguised fallback
  to ordinary reply routing.
- Active-run approval, queue, steer, and redirect handling remains a higher-priority
  session path only when a typed structural relation names the target Run or pending
  predecessor. Mere presence of an active Run in the Channel is insufficient.
- A missing or rejected active-run relation falls back to normal intent selection; it does
  not become an implicit `reply`, `execute`, or clarification decision.

Because Ling is pre-release, v1 decision rows are removed during the v2 migration.
Runtime code accepts only schema v2 and exposes no old enum aliases.

## Persistence Shape

The exact migration is owned by the implementation plan. The target relational shape is:

```text
ling_threads
  + surface_kind
  + relation_kind
  + anchor_item_id
  + fork_context_snapshot_id
  + next_item_sequence

ling_turns
  + effective context assignment through turn_context_assignments

conversation_items
  UNIQUE(thread_id, sequence)
  UNIQUE(thread_id, idempotency_key) WHERE idempotency_key IS NOT NULL

context_segments
  thread_id, state, label, created_from_turn_id, last_active_turn_id

turn_context_assignments
  turn_id, segment_id, status, source, evidence, policy_version, supersedes

conversation_context_summaries
  scope, coverage watermark, typed facts, source refs, version, supersession

conversation_context_snapshots
  projection version, item watermark, summary ids, source refs

channel_intent_decisions
  schema v2 source turn/item/segment/projection fields
```

## Invariants

1. Every committed user item belongs to exactly one thread and one user-intent turn.
2. Every item has a stable per-thread sequence.
3. Every accepted user turn has exactly one effective context assignment.
4. A model never commits arbitrary segment ids or bypasses visibility filtering.
5. Selector, reply, resolver, workflow, and agent views share one projection version.
6. Summaries never become safety, permission, approval, or business-state authority.
7. Source refs can recover the evidence behind every summary and agent result.
8. Topic and branch inheritance never copies the parent transcript.
9. Committed items are corrected by supersession, not destructive overwrite.
10. Domain state remains authoritative in its domain table.
11. An active reply can accept guidance only from the same structurally identified
    conversation line and only through an explicit typed disposition.

## Failure Modes

| Failure | Required behavior |
| --- | --- |
| Model proposes an inaccessible segment | reject proposal; use structural/current fallback; record safe diagnostic |
| Two turns create sequence numbers concurrently | serialize cursor allocation in one SQLite transaction |
| Summary completes after assignment correction | reject late result by assignment/projection version |
| Agent returns against stale projection | accept only if changed refs are unrelated; otherwise rebase or rerun |
| Explicit local write has no target | structured clarify with `missingFields=["target"]` |
| Conversational article continuation says `开始` | remain `reply`; do not call file TargetResolver |
| Root reply is active while a Branch message arrives | reject cross-line queueing; run Branch intent/reply independently |
| `activeRunId` is stale, terminal, or belongs to another line | ignore the queue relation and continue normal intent selection |
| New unrelated root request follows bad clarification | assign/switch segment before intent; do not inherit clarification as task state |
| Private memory is selected for public channel view | fail closed before rendering; record redacted policy rejection |
| Summary generation fails | keep raw source refs and recent tail; retry asynchronously; do not lose history |
| Item append retries after disconnect | idempotency key returns existing item and sequence |

## Acceptance Criteria

- Issue #421 article continuation remains conversational and produces no local-file target
  clarification.
- A new unrelated root request after a clarification receives a fresh or correctly
  matched segment and does not inherit the old missing-field state.
- Explicit local-file requests without a target still clarify safely.
- Root, topic, and branch each resolve to an explicit `LingThread`.
- Every user turn creates a `LingTurn`, including ordinary questions and replies.
- Selectors, replies, TargetResolver, workflows, and specialists record the same context
  projection version for one turn.
- Long conversations proactively summarize before a provider rejects context length.
- A user can inspect summary source refs and recover original committed items.
- Segment corrections invalidate derived summaries without mutating raw items.
- A resumed or newly joined agent receives shared core facts plus role-scoped evidence,
  without private cross-agent leakage.
- No runtime `single_reply` or `direct_workflow` value remains after v2 migration.

## Open Implementation Parameters

These values are intentionally policy settings, not unresolved architecture:

- exact soft/hard summary thresholds after measuring real provider budgets;
- provisional-segment promotion confidence and second-turn window;
- how much segment correction UI is exposed by default versus advanced context details;
- whether all context projection metadata is persisted or only projections used by a
  model, run, fork, or inspect request.

The architecture has no unresolved ownership decision. These parameters can be tuned
behind versioned policy without changing the data model.
