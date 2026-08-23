# Channel Context Processing Layer

## Status

Design baseline.

Related docs:

- [Channel Conversation Continuity v2](channel-conversation-continuity-v2.md)
- [Channel Context Budget Manager](channel-context-budget-manager.md)
- [Channel Context Processing Layer Implementation Plan](channel-context-processing-layer-implementation-plan.md)
- [Ling Agent Session Control Plane](ling-agent-session.md)
- [Input Materialization Detailed Design](input-materialization-detailed-design.md)
- [Ling Memory v1](ling-memory-v1.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [Provider Presets](provider-presets.md)

This document defines the product and runtime boundary for channel context processing.
It extends the existing [Channel Context Budget Manager](channel-context-budget-manager.md)
without replacing the current channel, workflow, memory, or evidence stores.

[Channel Conversation Continuity v2](channel-conversation-continuity-v2.md) is
authoritative for the canonical Thread/Turn/Item timeline, context segments, shared
projection version, coverage-aware summaries, and multi-agent recovery. This document
continues to own source eligibility, per-consumer view shape, filtering, redaction, and
budget boundaries.

## Problem

Ling channels are becoming real agent sessions, not stateless chat rooms. The current
system already has useful lower-level pieces:

- channel messages and attachments;
- channel collaboration protocol;
- context packs and provider budgets;
- channel summaries, decisions, handoffs, workflow packets, and artifacts;
- scoped Ling Memory;
- workflow/run/approval evidence.

The gap is that different consumers can still assemble context differently:

```text
selector prompt
reply prompt
workflow proposal prompt
workflow step prompt
private teammate prompt
```

When each path decides what to include on its own, the user sees broken collaboration:

- the selector understands the previous topic but the final reply does not;
- Ling Agent sees active work but a specialist receives only the latest message;
- logs or raw command output can become too heavy if naively appended;
- private teammate memory can be recalled correctly but quoted into the wrong surface;
- workflow evidence can be durable while ordinary replies feel stateless.

## Product Principle

Channel Context is a candidate context set, not a prompt dump.

```text
raw channel data
  -> candidate context sources
  -> filter, rank, compact, and budget
  -> per-consumer Context View
  -> model prompt or runner packet
```

Ling Agent owns how the product responds and coordinates. The Context Processing Layer
owns what a model is allowed and expected to see for one turn.

## Borrowed Patterns

Ling should borrow patterns, not runtimes:

| Source | Pattern to borrow | Ling adaptation |
| --- | --- | --- |
| Codex / OpenAI compaction | Preserve recent interaction, compact older context, keep evidence separate. | Long channel history and command output become summaries/source refs before prompt use. |
| OpenHands condenser | A dedicated component condenses history before the agent consumes it. | Add a Context Condenser below Ling Agent and above model prompts. |
| LangChain multi-agent context engineering | Decide what each agent sees; subagents can receive task-specific context only. | Build per-agent Context Views instead of giving every teammate the same channel dump. |
| Microsoft Agent Framework context providers and middleware | Inject typed context sources into agent sessions through a controlled layer. | Treat channel state, memory, artifacts, and active work as separate providers feeding one context pipeline. |
| OpenClaw-style project rooms | Room context, visible/backstage participation, and noise control. | Channels behave like focused work rooms with coordinator-owned visibility and evidence. |

## Architecture

```text
Canonical Channel Context Store
  messages
  attachments and materializations
  channel protocol and settings
  summaries, decisions, handoffs
  proposals, workflows, runs, approvals
  artifacts and logs
  scoped memory refs
        |
        v
Context Processing Layer
  source collection
  relevance ranking
  policy filtering
  log/evidence filtering
  memory usage isolation
  budget estimation
  compaction
        |
        v
Per-consumer Context View
  Ling Agent view
  specialist teammate view
  selector view
  workflow proposal view
  workflow step view
  private chat view
        |
        v
model prompt / runner packet / evidence metadata
```

The layer should be deterministic where possible. Model calls may help summarize or
compact large inputs, but local policy must decide scope, sensitivity, source refs, and
whether a compacted item can be used.

Provider-backed segmentation and durable-summary generation are advisory preprocessing,
not dispatch ownership. Both calls run with short policy deadlines and cancellation. A
segmentation timeout commits the conservative bootstrap assignment. A summary timeout
keeps the last committed summary and uses a deterministic, permission-filtered recent
tail within the resolved provider budget. If required current-turn input cannot fit, the
caller publishes a typed visible blocker instead of leaving the source turn open.

These calls run inside the daemon-owned Channel turn dispatcher, never inside an HTTP/SSE
response lifecycle. Their committed assignment/summary records are recovery checkpoints.
If the daemon exits after an external inference returns but before its record commits,
the read-only inference may be repeated; canonical writes remain idempotent and no
assistant item, Run, or workflow may be duplicated. Cancellation caused by a client
disconnect is not propagated into Context Processing.

### Conversation continuity input

Context consumers must not independently scan fixed recent-message windows. The canonical
input is a versioned projection:

```text
ConversationItems + domain records + ContextSegment assignment + summaries
  -> permission and visibility filter
  -> ConversationContextProjector
  -> Channel Context View
  -> Context Budget Manager
  -> model prompt / runner packet
```

Selector, reply, TargetResolver, workflow proposal, workflow step, and specialist views
may request different sections and budgets. They must still share the same thread, turn,
segment assignment, projection version, and source-ref authority.

## Candidate Context Sources

The layer can collect these sources, but does not include all of them by default:

| Source | Default behavior |
| --- | --- |
| Current turn envelope | Always included when valid. |
| Channel state | Include channel id/name, bound path, response language, protocol excerpt, and current teammate identity. |
| Recent visible conversation | Include a bounded window for short follow-ups and revisions. |
| Channel summaries | Include relevant compacted summaries and source refs when history is long. |
| Decisions and handoffs | Include relevant active or stable decisions. |
| Active work | Include current proposal, workflow, run, approval, queue follow-up, or redirect state when related. |
| Attachments and links | Include safe materialized previews, metadata, and source refs. |
| Files | Include user-selected file refs or safe summaries; do not silently read arbitrary file bodies. |
| Logs and command output | Include only filtered summaries, exit status, stderr tail, and source refs by default. |
| Memory | Include scoped and relevant recall bundle after memory policy filtering. |
| Raw evidence | Store durably and reference by id; do not default into prompts. |

## Context Views

The same canonical channel context can render different views:

| View | Consumer | Includes | Excludes |
| --- | --- | --- | --- |
| `ling_agent_channel_view` | Ling Agent ordinary reply and coordination | current turn, channel protocol, recent visible conversation, active work state, relevant summaries, materialized inputs, scoped memory | full raw logs, unrelated private chats, hidden prompts |
| `specialist_task_view` | Engineer/Docs/QA/Design specialists | task objective, acceptance criteria, relevant channel background, role-specific source refs, needed evidence summaries | full channel transcript, other specialists' private memory |
| `selector_view` | intent selector, auto-route, participant selector | current turn, lightweight channel metadata, candidate teammate capability summaries, minimal recent context | long logs, attachment bodies, raw memory text |
| `requirement_shaping_view` | requirement shaping coordinator and invited specialists | current user goal, relevant decisions, role-specific summaries, selected source refs, active risks, known permission boundary | raw all-agent transcript, unrelated private memory, long logs, tool output bodies |
| `workflow_proposal_view` | proposal builder | current user goal, channel protocol, active decisions, relevant summaries, tool/risk boundary | unrelated conversation and private memory |
| `workflow_step_view` | workflow step runner | workflow objective, step instruction, dependencies, output packets, source refs, selected memory | raw full discussion by default |
| `private_chat_view` | teammate private chat | private thread history, teammate persona, teammate private memory, workspace memory when allowed | channel history unless explicitly referenced/promoted |
| `evidence_inspect_view` | user-opened evidence/debug surfaces | metadata, source refs, compact summaries, selected raw snippets | secrets, private chat content without permission |

No view grants tool access, approvals, filesystem permission, or memory authority. Those
remain separate policy layers.

## Log And Evidence Filtering

Channel Context Pack is not a log replay buffer.

Default prompt input should not include:

- complete stdout/stderr;
- repeated heartbeat/runtime events;
- selector JSON or route internals;
- full terminal scrollback;
- complete build/test logs when the command succeeded;
- binary attachment text dumps;
- provider secrets, environment variables, tokens, or credential-adjacent strings.

Default prompt input may include:

- command name and exit code;
- concise failure summary;
- last relevant stderr lines;
- changed file summary;
- artifact ids and source refs;
- user-visible final result;
- a short explanation of what evidence exists and where it lives.

If the user asks "why did it fail?", "show the log", or "what did the command output?",
the layer can build an evidence-focused view with selected raw snippets. The raw artifact
stays outside normal chat context.

## Context Condenser

The condenser handles long contexts before model prompts exceed the selected provider
budget.

Rules:

1. Keep the current user turn and safety/approval boundary.
2. Keep recent visible conversation before older raw history.
3. Replace older discussion with `ChannelContextSummary` plus source refs.
4. Replace long logs with error summary, tail, and artifact refs.
5. Replace workflow branch outputs with output packets and fan-in summaries.
6. Keep memory recall bounded and source-attributed.
7. Never compact by silently editing channel protocol, teammate persona, approval policy,
   or active memory.

Compaction output must name:

- source refs;
- what was summarized;
- what was dropped;
- confidence or verification status when available;
- whether the summary is temporary for one request or durable channel context.

## Memory Use Isolation

Ling already stores memory with scoped ownership. Context Processing adds a second
policy boundary: recalled memory is not automatically public context.

| Memory layer | Context behavior |
| --- | --- |
| Workspace memory | Eligible for channel and task views when relevant and active. |
| Channel memory | Eligible only for that channel or explicitly linked tasks/runs. |
| Teammate private memory | Eligible only for that teammate. In channel replies it may influence behavior, but sensitive/private excerpts should not be quoted publicly by default. |
| Task/run memory | Eligible for linked work and review/evidence views. |
| Secret-adjacent memory | Excluded from ordinary model context by default; visible only in review/health surfaces. |
| Candidate memory | Not recalled unless the review policy explicitly allows it. |

Every model response or run that uses memory should continue recording used-memory audit
events with memory ids, recall query, teammate id, channel id, and response/run id.

## Multi-Agent Rules

Multi-agent orchestration must use Context Views, not shared prompt history.

Rules:

- Ling Agent receives the coordinator view.
- Specialists receive role/task-specific views.
- Handoffs carry structured packets and source refs, not hidden free-form chat.
- Backstage agent discussion summarizes into channel-visible progress or final result.
- Visible multi-reply is opt-in or coordinator-selected for shaping decisions.
- Fan-in reads durable output packets and selected evidence, not raw branch transcripts.
- Private teammate chat does not automatically become channel context.

This prevents the common multi-agent failure mode where every agent sees a different,
hand-built prompt and the system loses the thread.

## UI Boundary

The default UI should stay intelligent, not diagnostic.

Context Processing supports ambient audit: the system records source refs, dropped
sections, compaction ids, memory usage, and evidence links, but the default product UI
renders only the user-facing meaning of those records.

Visibility layers:

| Layer | Default visibility | Examples |
| --- | --- | --- |
| Product | visible | Ling replies, collaboration cards, active progress, final summaries, permission prompts, blockers |
| Smart details | user-expanded | teammate contributions, handoff summaries, artifacts, changed files, approvals, evidence groups |
| Audit/debug | advanced only | context section ids, token budgets, selector scores, raw route JSON, raw prompts, raw logs |

Users should see:

- continuous Ling Agent replies;
- requirement shaping cards and execution task cards;
- active work progress;
- folded step handoff summaries;
- final summaries;
- optional evidence expansion;
- memory/evidence usage when they open details.

Users should not see by default:

- context section ids;
- token budgets;
- selector scores;
- raw context pack JSON;
- route decision internals;
- long logs.

Developer/debug surfaces may expose safe metadata, section ids/counts, dropped section
ids, compaction ids, and source-ref counts.

## Implementation Slices

Detailed implementation plan:
[Channel Context Processing Layer Implementation Plan](channel-context-processing-layer-implementation-plan.md).

| Slice | Scope |
| --- | --- |
| C1 | Extract shared context source collectors for current turn, channel state, recent messages, active work, materialized inputs, memory, and evidence refs. |
| C2 | Add `ContextView` types for Ling Agent, specialist task, selector, workflow proposal, workflow step, private chat, and evidence inspect. |
| C3 | Move reply/selector/workflow prompt assembly onto shared Context Processing APIs. |
| C4 | Add log/evidence filtering: command status, stderr tail, artifact refs, and safe snippets. |
| C5 | Add condenser policies for older discussion, long logs, and workflow packet summaries. |
| C6 | Add memory-use policy that separates recall eligibility from public quoting/display eligibility. |
| C7 | Add safe inspect metadata for developer/debug surfaces without default UI noise. |
| C8 | Add provider/model capability auto-detection so budgets are automatic by default and token fields are advanced overrides. |

## Acceptance Criteria

- A short follow-up such as `400字`, `继续`, or `改短点` resolves against the relevant
  channel context before Ling Agent asks for a missing topic.
- Ordinary replies, selectors, workflow proposals, and workflow steps share context
  source builders where practical.
- No default prompt includes full raw terminal logs or repeated runtime events.
- A failed command can contribute exit status, concise error summary, stderr tail, and
  source refs.
- Specialist teammates receive task/role-specific Context Views, not the entire channel.
- Teammate private memory is not exposed to other teammates or public channel replies by
  default.
- Full evidence remains durable and inspectable on demand.
- Context metadata stays out of the default conversation UI.

## Open Decisions

- Exact tuning of the rolling-summary and recent-tail policy after measuring provider
  budgets. The initial baseline is defined in Channel Conversation Continuity v2; this is
  a versioned policy parameter, not an ownership decision.
- Whether ordinary reply context metadata should be persisted for all replies or only
  stored for route/inspect/debug paths.
- Whether memory public-quoting eligibility needs a new explicit field beyond existing
  `sensitivity` and `verifyBeforeUse`.
- Whether log filtering should be centralized in the evidence/artifact layer or inside
  Context Processing.
- Exact capability snapshot storage boundary for provider metadata versus runtime-observed
  context-length downgrades.
