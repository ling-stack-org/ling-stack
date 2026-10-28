# Ling Memory v1

Status: Design direction
Date: 2026-06-04
Scope: Scoped automatic recall, multi-agent memory ownership, retrieval provider interfaces, provenance, and promotion workflow

Detailed implementation breakdown:
[Memory Review Policy Implementation Plan](memory-review-policy-implementation.md).

Follow-up design for health diagnostics and workflow memory fan-in:
[Memory Health And Multi-Agent Memory Fan-In](memory-health-and-fanin.md).

## Summary

Ling Memory v1 turns the current memory-scope metadata into a real memory runtime for
multi-agent work. The first implementation does not install or require vector models.

The goal is not just "vector memory". The goal is scoped automatic recall:

```text
the right teammate
  gets the right context
  from the right memory layers
  with visible provenance
  without leaking unrelated private or channel context
```

Memory should help work move faster, but it must stay attributable, reviewable, and
bounded by teammate, channel, task, and approval policy.

## Background

The earlier agent-context-memory-framework used:

```text
BOOTSTRAP_INDEX.md
MEMORY.md hot index
memory/persona/core.md
memory/topics/*
memory/promoted/*
optional retrieval layer
source markers / provenance
approval gates
```

Ling Memory v1 adapts that model into a Ling-native runtime:

```text
workspace shared memory
channel memory
teammate private memory
task/run working memory
optional retrieval provider index
source provenance
promotion workflow
used-memory audit
```

This is a product and data model shift. Markdown can remain a source and import/export
format, but runtime recall should be backed by durable memory objects and scoped policy.

## Design Goals

- Make automatic recall useful by default.
- Keep memory ownership explicit across workspace, channel, teammate, and task.
- Let each teammate develop a private memory without diluting other teammates.
- Let channels accumulate decisions and working context without polluting global memory.
- Promote stable facts into shared memory only through a reviewable path.
- Support local or remote embeddings and rerankers only through optional retrieval providers.
- Show the user what memory was used for a reply or run.
- Keep source provenance available for every recalled memory.

## Non-Goals For v1

- No mandatory vector database.
- No default embedding model, embedding job, vector index, or rerank provider.
- No hidden ingestion of every chat, log, file, or attachment.
- No automatic cross-agent private memory sharing.
- No memory-derived permission grants.
- No secret-adjacent indexing.
- No hard-delete policy in the first memory slice.
- No claim that embedding hits are proof.

## Memory Layers

### Workspace Shared Memory

Purpose: stable project facts, architecture decisions, product decisions, workflow
conventions, and cross-channel rules.

Default access: teammates allowed by workspace policy.

Write policy: review or promotion required unless the memory is manually created by the
user.

Examples:

- "Runner backend defaults to embedded Pi coding-agent mode."
- "Provider routing order is teammate, explicit run, channel default, workspace selected."
- "MCP tool server setup lives under workspace Settings, not the homepage flow."

### Channel Memory

Purpose: context and decisions local to a channel.

Default access: teammates that are members of the channel or explicitly assigned to work
in that channel.

Write policy: channel discussions, decisions, briefs, attachments, and task outcomes can
create candidates. Stable channel decisions can be promoted to workspace shared memory.

Examples:

- Engineering channel architecture decisions.
- Design channel visual-system constraints.
- Release channel ship checklist decisions.

### Teammate Private Memory

Purpose: one teammate's persona, working preferences, private chat summaries, failure
patterns, and role-specific lessons.

Default access: only that teammate.

Write policy: private chat, direct feedback, teammate settings, and teammate-owned task
reflections can write candidates.

Examples:

- Engineer prefers small scoped patches and targeted tests.
- Designer flags nested cards and one-note palettes.
- QA remembers a recurring smoke path for a workspace.

### Task/Run Working Memory

Purpose: temporary context discovered during a run.

Default access: the current run and later review surfaces.

Write policy: created by the runtime supervisor and runner events. Can expire, be
archived, or be promoted.

Examples:

- Files inspected during a bug investigation.
- Local test commands that passed.
- Runtime errors and exact failure state.

## Memory Object

Draft schema:

```ts
type MemoryScopeType = "workspace" | "channel" | "teammate" | "task" | "run";

type MemorySourceType =
  | "manual"
  | "message"
  | "decision"
  | "doc"
  | "attachment"
  | "run-event"
  | "artifact"
  | "import";

type MemoryReviewState = "candidate" | "active" | "disabled" | "archived" | "rejected";

interface MemoryObject {
  id: string;
  workspaceId: string;
  scopeType: MemoryScopeType;
  ownerId: string;
  sourceType: MemorySourceType;
  sourceRefs: MemorySourceRef[];
  title: string;
  body: string;
  tags: string[];
  reviewState: MemoryReviewState;
  confidence: "low" | "medium" | "high";
  sensitivity: "normal" | "private" | "secret-adjacent";
  verifyBeforeUse: boolean;
  enabled: boolean;
  retrievalProviderId?: string;
  retrievalHandle?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

interface MemorySourceRef {
  kind: "message" | "task" | "run" | "artifact" | "file" | "url" | "manual";
  id: string;
  label?: string;
  excerptHash?: string;
}
```

## Recall Policy

A recall request is not just a vector query. It is a policy-bounded lookup.

Draft input:

```ts
interface MemoryRecallRequest {
  workspaceId: string;
  actorType: "local-user" | "ai-teammate" | "system";
  actorId: string;
  teammateId?: string;
  channelId?: string;
  taskId?: string;
  runId?: string;
  intent: "private-chat" | "channel-reply" | "task-run" | "review" | "search";
  query: string;
  maxResults: number;
}
```

Policy resolution:

```text
request
  -> resolve current teammate, channel, task, and run
  -> resolve allowed memory scopes
  -> exclude disabled, rejected, expired, and forbidden sensitivity records
  -> retrieve lexical candidates
  -> optionally call an installed retrieval provider
  -> apply final policy filter
  -> return recall bundle with provenance
```

Example allowed scopes:

```text
Engineer private chat:
  - teammate:engineer private memory
  - workspace shared memory
  - task/run memory only if linked from the current private thread

Engineer in Engineering channel:
  - teammate:engineer private memory
  - channel:engineering memory
  - workspace shared memory
  - current task/run memory

Designer in Engineering channel:
  - teammate:designer private memory
  - channel:engineering memory if Designer is a member or explicitly mentioned
  - workspace shared memory
```

## Context View Isolation

Memory recall isolation and context-view isolation are related but separate.

Recall isolation answers:

```text
Which memory objects may this request retrieve?
```

Context-view isolation answers:

```text
How may retrieved memory influence this model prompt or public reply?
```

Ling already stores memory with scoped ownership:

```text
workspace
channel
teammate
task
run
```

That is the right base. The Context Processing Layer must add the second boundary so a
memory item that is allowed for a teammate is not automatically public channel context.

Rules:

- Workspace memory may be used in channel and task views when active, relevant, and not
  secret-adjacent.
- Channel memory may be used only for that channel or explicitly linked tasks/runs.
- Teammate private memory may be used only by that teammate. In a public channel reply it
  may guide behavior, tone, or working preference, but sensitive private excerpts should
  not be quoted or revealed by default.
- Task/run memory may be used for linked work and evidence/review surfaces.
- Secret-adjacent memory is excluded from ordinary model context and belongs in review or
  health surfaces.
- Candidate memory is not recalled unless review policy explicitly allows it.

Example:

```text
Designer replying in Engineering channel:
  may use:
    - workspace memory
    - Engineering channel memory
    - Designer private memory
  must not use:
    - Engineer private memory
    - another channel's memory
    - secret-adjacent memory
  must not quote:
    - private Designer memory into the public channel unless it is shareable and relevant
```

This keeps the useful part of private teammate memory without turning it into accidental
cross-agent or public-channel leakage.

## Retrieval Pipeline

```text
query text
  -> daemon resolves durable workspace/teammate/channel/task/run ownership
  -> SQLite scope, review, sensitivity and health eligibility
  -> local FTS5 candidate narrowing over titles/body/tags/source labels/IDs
  -> optional retrieval provider search over active scoped memory chunks
  -> optional retrieval provider rerank
  -> provenance and policy filter
  -> prompt-sized recall bundle
```

The first implementation uses lexical search plus source filters. Vector search should
only appear through a configured retrieval provider when memory volume and fuzzy lookup
needs make keyword search insufficient.

Local recall uses the `ling-memory-v1-lexical-v3` policy. Its rebuildable FTS5 index
contains encoded Unicode character bigrams, retaining Chinese fragments and identifier
substrings; lexical scoring still owns ordering. MATCH expressions use generated tokens
and bound parameters. Eligibility precedes ranking and result limits. Empty browse is
explicit, and unsupported indexing retains the complete scoped streaming fallback.

Source writes and index refresh share a transaction. SQLite triggers mark direct writes
dirty; reads include those eligible dirty rows until refresh, so delayed indexing cannot
hide new knowledge or resurrect revoked facts. Index schema versions rebuild on open;
recall itself is read-only. Usage only changes `lastUsedAt`, not knowledge `updatedAt`.

The daemon shares one async recall service across private chat, channel replies, task
runs, workflow steps and manual queries. Automatic callers cannot grant scopes using an
unverified owner ID or inspection flags. Non-system teammates must belong to the selected
channel; task/run lineage must agree with its persisted owner. An unpersisted task request
can receive verified shared context but cannot claim task-specific memory. Explicit local
search/review keeps its management inspection semantics.

Selection audit reports strategy, scoped candidate work and selected IDs. It carries no
rejected title/body. `UsedMemoryEvent` records which sources were supplied to context;
it does not prove that the model adopted or verified a remembered conclusion. Packaged
runtime FTS5 availability and real embedding quality require separate acceptance.

Good embedding candidates:

- active workspace shared memory,
- active channel memory,
- active teammate private memory,
- reviewed task/run summaries,
- selected docs or decision records.

Poor embedding candidates:

- raw full chat transcripts,
- noisy logs,
- volatile runtime snapshots,
- large text dumps,
- secret-adjacent files,
- unreviewed imported skill or persona text.

## Prompt Builder Integration

Prompt construction should receive a typed recall bundle:

```ts
interface RecalledMemory {
  memoryId: string;
  scopeType: MemoryScopeType;
  ownerId: string;
  title: string;
  excerpt: string;
  sourceRefs: MemorySourceRef[];
  confidence: "low" | "medium" | "high";
  verifyBeforeUse: boolean;
}
```

Prompt order:

```text
system and teammate persona
-> task/channel instruction
-> allowed tool and approval policy
-> recalled memory bundle
-> user message or task prompt
```

Core persona should not depend on vector search. It must remain available through the
teammate profile and pinned/private memory.

## Used-Memory Audit

Every AI reply or run that uses memory should record a used-memory event:

```ts
interface UsedMemoryEvent {
  id: string;
  workspaceId: string;
  responseId?: string;
  runId?: string;
  teammateId?: string;
  channelId?: string;
  memoryIds: string[];
  recallQuery: string;
  policyVersion: string;
  createdAt: string;
}
```

UI should show:

```text
Used memory
  - Workspace decision: Provider routing order
  - Engineer private note: prefers targeted tests before broad build
  - Channel memory: Model Workbench width discussion
```

The first UI can be compact. The important part is that memory use is visible and
inspectable.

Conversation UI projection is covered by
[Conversation Memory Citations And Sources](conversation-memory-citations-and-sources.md).
The memory runtime remains authoritative for scope, review, recall, and used-memory audit;
the transcript layer should derive a message-level citation footer from `UsedMemoryEvent`
and `MemoryObject` instead of replacing the memory data model.

## Write And Promotion Flow

Memory should not write every token automatically. Writes should be candidate-based.
That does not mean every candidate needs a human click before it can help. The default
product should combine Codex-style background memory/reflection jobs with Ling-specific
policy gates so low-risk local memory can become useful without turning memory into a
manual triage burden.

```text
source event
  -> extract candidate
  -> assign scope
  -> attach source refs
  -> mark candidate
  -> classify by memory review policy
  -> auto-activate, hold as candidate, route to manual review, or quarantine
  -> active memory
```

Default write destinations:

| Source | Default destination |
| --- | --- |
| Private chat preference | Teammate private memory candidate |
| Channel decision | Channel memory candidate |
| Task run lesson | Task/run working memory candidate |
| Repeated stable project rule | Workspace shared memory candidate |
| Persona behavior update | Teammate private profile candidate |

Promotion should be explicit when crossing ownership boundaries:

```text
teammate private -> channel memory
channel memory -> workspace shared memory
task/run memory -> channel or workspace memory
```

Cross-boundary promotion must preserve source refs and should surface a review step.

## Memory Review Policy

Memory review is a policy classifier, not a blanket manual gate. Ling should support
three workspace-level modes:

| Mode | Behavior |
| --- | --- |
| `conservative` | Most extracted memories stay as candidates until reviewed. |
| `balanced` | Low-risk same-scope memories can become active; high-impact changes go to review. |
| `fast` | Same-scope memories auto-activate more often; cross-scope and sensitive changes still require review. |

Default mode should be `balanced`.

The classifier returns one of four outcomes:

| Outcome | Meaning |
| --- | --- |
| `auto-active` | Safe enough to enter active recall immediately, with source refs and audit. |
| `auto-candidate` | Stored as a candidate, visible in memory surfaces, but not default recalled. |
| `manual-review` | Routed to the promotion inbox or review center before active/shared/persona use. |
| `quarantine` | Blocked from recall and promotion until explicitly inspected or discarded. |

Suggested default policy:

| Candidate type | Default outcome |
| --- | --- |
| User explicitly says "remember this" inside the current scope | `auto-active` unless sensitive or permission-related |
| Current run files, commands, and test summary | `auto-active` as task/run working memory, preferably with expiry |
| Teammate private preference from direct chat | `auto-candidate`; `auto-active` only when high-confidence and non-sensitive |
| Channel-local decision with clear source | `auto-candidate` or channel `auto-active` under `fast` mode |
| Repeated task/run lesson seen 2-3 times | `auto-candidate`, then policy-assisted promotion |
| Workspace shared memory | `manual-review` unless the user explicitly confirmed it |
| Cross-scope promotion | `manual-review` |
| Teammate persona/profile update | `manual-review` |
| Conflicting or low-confidence memory | `manual-review` |
| Private, sensitive, or secret-adjacent content | `manual-review` or `quarantine` depending on sensitivity |
| Permission, tool, approval, provider, deploy, credential, or external-send inference | `quarantine`; memory must never grant authority |

The promotion inbox should therefore prioritize high-impact review items instead of
interrupting on every memory candidate. The first Web read model may still list all
candidate memories so users have one place to inspect, edit, approve, reject, or keep
them as candidates; manual-review and quarantine decisions should be called out with
stronger attention. It should focus on:

- workspace shared memory;
- cross-channel, cross-teammate, or task/run-to-workspace promotion;
- persona/profile changes;
- conflicts and low-confidence candidates;
- private or sensitivity-boundary candidates;
- any candidate that would otherwise affect default recall outside its source scope.

Manual review should borrow the Codex approval-card interaction pattern:

```text
inspect source refs
-> edit title/body/scope/sensitivity
-> approve, reject, archive, or keep as candidate
```

But it is not the same as runtime approval. Tool approvals block a side effect before it
happens. Memory manual review blocks a candidate from becoming active, shared, or
persona-affecting. It should usually be asynchronous and low-interruption. It should
only interrupt a current run when the run is about to rely on a memory candidate that is
not yet active and policy requires explicit confirmation.

Reflection or consolidation jobs may create candidates automatically, but they must not:

- silently write workspace shared memory;
- silently write active memory;
- mutate teammate persona or profile;
- grant tools, approvals, provider access, deploy access, credentials, or external-send
  permission;
- access or index secrets;
- leak private teammate or channel context across scopes.

The follow-up [Memory Health And Multi-Agent Memory Fan-In](memory-health-and-fanin.md)
design keeps this candidate-only boundary and adds diagnostics for stale, duplicate,
expired, source-less, secret-adjacent, and authority-changing memory records.

## AGENT.md And Persona Memory

Per-teammate persona files can become source material:

```text
.ling-stack/teammates/engineer/AGENT.md
  -> parse
  -> teammate profile draft
  -> review
  -> durable teammate profile
```

Boundary:

```text
AGENT.md can define behavior and style.
AGENT.md cannot grant tools, approvals, secrets, or external-send authority.
```

Tool and approval permissions remain in teammate policy, channel policy, and kernel state.

## APIs

First API shape:

```http
GET /memory?cwd=/path/to/workspace&scopeType=channel&ownerId=channel_...
POST /memory?cwd=/path/to/workspace
PATCH /memory/:id?cwd=/path/to/workspace
POST /memory/recall?cwd=/path/to/workspace
GET /memory/used?cwd=/path/to/workspace&runId=run_...
GET /memory/review-policy?cwd=/path/to/workspace
PATCH /memory/review-policy?cwd=/path/to/workspace
GET /memory/promotion-inbox?cwd=/path/to/workspace
POST /memory/:id/review?cwd=/path/to/workspace
```

The API should return source refs and review state. It should not return secret-adjacent
content unless explicitly permitted by policy.

## Storage

Draft tables:

```sql
CREATE TABLE memory_objects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  review_state TEXT NOT NULL,
  confidence TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  verify_before_use INTEGER NOT NULL,
  enabled INTEGER NOT NULL,
  retrieval_provider_id TEXT,
  retrieval_handle TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX idx_memory_scope
  ON memory_objects(workspace_id, scope_type, owner_id, review_state, enabled);

CREATE TABLE memory_used_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  response_id TEXT,
  run_id TEXT,
  teammate_id TEXT,
  channel_id TEXT,
  memory_ids_json TEXT NOT NULL,
  recall_query TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Retrieval storage can be local, remote, or pluggable. The memory object should not assume
a specific embedding model or vector database.

## UI Surfaces

### Teammate Memory Tab

- Shows private memory.
- Shows recall policy.
- Shows recent used-memory records.
- Allows disabling a memory object.
- Allows creating a manual teammate memory note.

### Channel Memory Tab Or Panel

- Shows channel decisions, briefs, and active memory.
- Shows candidate memories from channel discussion and task outcomes.
- Allows promote to workspace shared memory.

### Workspace Memory Page

- Shows shared memory.
- Shows promotion inbox.
- Shows source, review state, sensitivity, and enabled state.
- Allows search and filtering by scope, teammate, channel, source, and tag.

### Reply/Run Used-Memory Surface

- Shows compact "Used memory" under a reply or in run details.
- Opens source refs for inspection.
- Flags `verifyBeforeUse` memories.

## Phased Implementation

### Phase 1: Durable Memory Objects

- Add memory object storage and API.
- Add manual create/update/disable.
- Add memory tabs that show real objects.
- Keep recall manual or lexical only.

### Phase 2: Scoped Recall

- Add recall policy resolver.
- Add lexical retrieval and prompt builder integration.
- Add used-memory event logging.
- Show used-memory UI for private chat and task runs.

### Phase 3: Retrieval Provider Interface

- Add `MemoryRetrievalProvider` interface for optional embedding, vector search, and rerank providers.
- Expose "Vector retrieval: Not installed / Optional" in memory settings.
- Do not ship a default provider, download model files, start embedding jobs, or require a vector database.
- Keep provenance and review state in the final policy filter for any provider results.

### Phase 4: Candidate Writes And Promotion

- Extract memory candidates from private chat, channel decisions, and task/run summaries.
- Add memory review policy with `conservative`, `balanced`, and `fast` modes.
- Add promotion inbox that prioritizes high-impact `manual-review` candidates while
  still allowing the first Web read model to list ordinary candidates for inspection.
- Add cross-scope promotion flow with source inspection and edit-before-approve.
- Keep reflection/consolidation jobs candidate-only. They may run the review classifier
  and record that a candidate was low-risk, but `auto-active` classifications are stored
  as `auto-candidate` until a user or later policy surface promotes them.

### Phase 5: Persona Sources

- Add per-teammate `AGENT.md` or profile import.
- Parse into profile drafts.
- Keep permission policy separate from persona text.

## Risk Controls

| Risk | Control |
| --- | --- |
| Private memory leaks to another teammate | Scope resolver excludes other teammate owners by default |
| Channel memory leaks to unrelated work | Channel membership or explicit task assignment required |
| Vector hit is treated as fact | Used memory includes provenance and high-risk actions require source inspection |
| Noisy auto-ingestion degrades memory quality | Review policy routes low-risk items to auto-active, normal items to candidates, and high-impact items to manual review |
| Shared memory gets polluted by one-off facts | Promotion workflow required for shared memory |
| Persona drift from automatic summaries | Persona updates become profile candidates, not automatic rewrites |
| Secret-adjacent data gets indexed | Sensitivity filter blocks indexing and recall |

## Acceptance Criteria

Ling Memory v1 is ready when:

- a teammate can answer with automatically recalled private, channel, and workspace memory,
- the recall bundle respects teammate, channel, task, and sensitivity policy,
- the UI shows what memory was used,
- every recalled item has source refs,
- memory can be disabled without deleting source history,
- retrieval providers can be enabled without making provider results the source of truth.

Promotion from channel or task/run memory into shared workspace memory is a later Phase 4
flow, not part of the first v1 skeleton.

## Open Decisions

1. Should private chat memory be summarized automatically?
   Recommendation: create candidates automatically, but require narrow auto-accept policy
   or user review before active use.
2. Which embedding provider should be first?
   Recommendation: none in v1. Ship the retrieval provider interface first, keep lexical
   recall as the default, and let customers install providers later.
3. Should memory source excerpts be stored inline?
   Recommendation: store short excerpts plus source refs and hashes, not full source copies.
