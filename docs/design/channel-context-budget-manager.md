# Channel Context Budget Manager

Status: P1-P5 foundation, P6A/P6D workflow compaction, P6B channel summary
compaction, P6C no-tools context-length retry, P7A/P7B1/P7B2/P7C/P7D protocol
resolver/API/draft storage/editor/Context Pack consumption, P8A workflow-step
evidence drilldown, P8B reply/selector inspect surfaces, and P8C workflow-step
budget diagnostics implemented
Date: 2026-06-10

Related docs:

- [Conversation Surface Contract](./conversation-surface-contract.md)
- [Channel Context Processing Layer](channel-context-processing-layer.md)
- [Channel Context Processing Layer Implementation Plan](channel-context-processing-layer-implementation-plan.md)
- [Provider Presets](provider-presets.md)
- [Channel Intent To Workflow Selector](channel-intent-workflow-selector.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)
- [Ling Memory v1](ling-memory-v1.md)
- [Skill Context Optimization](skill-context-optimization.md)

## Purpose

Ling channels should feel like a collaborative workspace without becoming an
AutoGen-style shared long-context group chat. The runtime needs one independent layer
that decides what context a teammate or workflow step may see, how much can fit in the
selected model, and what gets summarized when the budget is tight.

The broader [Channel Context Processing Layer](channel-context-processing-layer.md)
collects, filters, and renders per-agent Context Views. The `Context Budget Manager` is
the provider-budget and compaction sublayer inside that system.

```text
channel message / workflow step / private chat
  -> Context Processing Layer
  -> Context Budget Manager
  -> bounded Context Pack
  -> runner or no-tools reply path
```

This design keeps channel rules thin, makes compaction auditable, and supports custom
provider APIs whose context windows and tokenizer behavior may differ.

## Current State

Current Ling context assembly is bounded, but it should not be single-message-only:

- ordinary channel AI replies use a `channel_reply_context` pack: current turn envelope,
  effective channel protocol, bounded recent visible conversation, compacted channel
  context/source refs, active work state when relevant, materialized inputs, and scoped
  memory recall;
- private teammate chat uses a recent message window plus scoped memory recall;
- workflow steps use task prompts, skill fragments, selected memory, step summaries, and
  workflow packet/source-ref design;
- channel collaboration records already exist conceptually as context summaries,
  decisions, handoffs, workflow packets, source refs, and review-gated memory candidates.

Remaining design pressure:

- reply, selector, workflow proposal, workflow step, and active-run follow-up paths should
  share the same channel context section builders where possible;
- Context Views should be generated from shared source collectors instead of bespoke
  prompt assembly in each consumer;
- recent visible conversation is only a layer inside channel context, not the whole
  product boundary;
- UI should keep this invisible by default. Users see a continuous conversation and final
  results, not context-pack diagnostics.

Implemented foundation:

- provider context budgets resolve from existing `contextWindow` and `maxTokens` preset
  fields;
- known providers use explicit preset budgets, known provider families without a window
  use conservative estimates, and unknown custom OpenAI-compatible presets use a smaller
  default budget;
- Context Pack assembly and rendering are wired for ordinary channel replies,
  `visible_multi_reply`, channel intent selection, `auto_route` selection, and workflow
  steps;
- workflow-step Context Pack pre-run compaction creates auditable workflow packet summary
  artifacts when dependency context would otherwise be dropped;
- channel protocol resolution and P7B1 API cover existing channel fields:
  response language, auto-reply mode, and default teammate.
- channel protocol editor UI is available in the channel Context surface, and reply,
  selector, auto-route, and workflow-step Context Packs consume the effective protocol
  resolver.
- P8A workflow evidence and P8B reply-route inspect actions expose safe Context Pack
  metadata on demand without persisting ordinary reply prompts.
- P8B Context surface routing index lists recent reply-route and intent-selector
  decisions only after the user opens Context, and P8B safety tests assert intent inspect
  payloads stay limited to safe metadata.

## Definitions

| Term | Meaning |
| --- | --- |
| Channel Collaboration Protocol | A thin, user-editable channel rule layer. It describes how the channel should collaborate; it is not shared memory and does not store history. |
| Channel Context | The product-level context Ling Agent may use for a channel turn: current turn, channel state, recent visible conversation, compacted summaries, active work, materialized inputs, and relevant memory. |
| Context Pack | The bounded runtime bundle passed to one teammate reply, one private reply, one selector, or one workflow step. |
| Context Budget Manager | The service that builds, ranks, estimates, trims, and compacts a Context Pack for a selected provider/model. |
| Compaction | Replacing long raw context with summaries, decisions, handoffs, packet source refs, or artifact references. |
| Memory candidate | A review-gated proposal for durable shared or teammate memory. Compaction may create candidates, but cannot silently activate them. |

## Goals

- Keep every teammate/run under a provider-compatible context budget.
- Make context visibility explicit and auditable.
- Support different context budgets for channel replies, private teammate chat, selectors,
  and workflow steps.
- Resolve budgets per Context View, per consumer teammate, and per provider/model call.
  Do not use one global workspace token limit for all agents.
- Automatically compact runtime context when needed without silently changing channel
  rules or active memory.
- Preserve source references so compressed context can be inspected later.
- Support known, estimated, and unknown provider/model context windows.

## Non-Goals

- No global shared transcript that every teammate reads by default.
- No silent rewrite of the channel collaboration protocol.
- No silent activation of shared memory or teammate memory.
- No requirement that all providers expose accurate tokenizer APIs.
- No UI rewrite of the channel conversation surface.

## Context Visibility Levels

| Level | Used by | Includes | Excludes |
| --- | --- | --- | --- |
| `channel_reply_context` | ordinary single teammate replies | current turn envelope, channel id/name/bound path, effective protocol, current teammate identity, bounded recent visible conversation, compacted channel summaries/source refs, active work state when relevant, materialized inputs, scoped memory recall | full raw channel transcript, private teammate chats, hidden prompts, provider secrets, unrelated peer replies |
| `roster_compact` | `visible_multi_reply`, roster questions | current teammate identity, compact channel roster, selected visible participants, presence disclaimer | online/presence state, hidden peer replies, future peer replies |
| `capability_routing` | intent selector, workflow proposal builder | eligible teammates, roles, runnable provider status, relevant skills/capability summaries | private chats, hidden prompt text, raw provider secrets |
| `workflow_packet` | workflow step runs | objective, step metadata, acceptance criteria, decisions, handoffs, prior step summaries, source refs, selected memory | raw full transcript by default, unrelated private chat |
| `private_teammate_context` | teammate private chat | teammate persona, recent private messages, private-scoped memory | channel history unless explicitly promoted |

`visible_multi_reply` should use `roster_compact`. That gives each selected teammate a
clear answer to "who else is in this channel / who else is replying" without making them
claim they can see presence or read other teammates' not-yet-generated replies.

## Channel Collaboration Protocol

Every channel may have a default protocol generated from system templates and structured
channel settings.

Protocol examples:

- default response language;
- default teammate and auto-reply mode;
- visible multi-reply cap;
- execution preference such as `Architect -> Engineer -> QA`;
- privacy rules such as "do not automatically share private teammate chat";
- channel-specific style or review expectations.

The protocol is not a memory store:

- ordinary chat does not append to it;
- visible multi-reply reads it but does not mutate it;
- workflow execution reads it and creates summaries/decisions/handoffs elsewhere;
- AI-discovered long-term rules become candidates only;
- user confirmation is required before the protocol changes.

## Context Pack Shape

The first implementation can use an internal TypeScript-only shape before adding durable
snapshots:

```ts
interface ContextPack {
  readonly kind:
    | "channel_reply"
    | "visible_multi_reply"
    | "intent_selector"
    | "workflow_step"
    | "private_teammate_reply";
  readonly providerPresetId?: string;
  readonly modelId?: string;
  readonly budget: ContextBudget;
  readonly sections: readonly ContextSection[];
  readonly sourceRefs: readonly ContextSourceRef[];
  readonly droppedSectionIds: readonly string[];
  readonly compactionIds: readonly string[];
}

interface ContextSection {
  readonly id: string;
  readonly role: "system" | "instruction" | "user" | "memory" | "evidence";
  readonly priority: "must_keep" | "high" | "medium" | "low";
  readonly text: string;
  readonly sourceRefIds?: readonly string[];
  readonly estimatedTokens?: number;
}

interface ContextBudget {
  readonly mode: "model_known" | "model_estimated" | "model_unknown";
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
  readonly reservedRuntimeOverheadTokens: number;
  readonly inputBudgetTokens: number;
}
```

The prompt assembler should still render normal provider requests. The Context Pack is
the auditable planning layer before rendering.

## Provider Compatibility

Ling supports custom APIs, so context budgeting cannot depend on one tokenizer.

The product should feel Codex-like: users configure a model and Ling automatically keeps
the context inside that model's usable window. That does not remove the need for budgets;
it moves budgets from user-facing setup into an internal capability resolver.

Budget modes:

| Mode | Source | Behavior |
| --- | --- | --- |
| `model_known` | provider preset/model registry exposes context window and output limit | use explicit token budget and adapter tokenizer when available |
| `model_estimated` | provider is known but tokenizer/window is incomplete | use conservative token estimates and smaller reserved output |
| `model_unknown` | custom API has no reliable limits | use a small default input budget and compact early |

Provider adapters should eventually expose:

```ts
interface ProviderContextCapabilities {
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly tokenizer?: "openai-compatible" | "anthropic-compatible" | "estimated";
  readonly supportsStructuredOutput?: boolean;
}
```

Capability resolution order:

1. User advanced overrides from the provider preset.
2. Built-in model registry or provider template values.
3. Provider metadata/model-list or health-check results when available.
4. Runtime-observed downgrades after context-length errors.
5. Conservative defaults for unknown custom APIs.

Effective budget is resolved at the point of use:

```text
Context View kind
  + consumer teammate
  + provider preset
  + model id
  + capability snapshot
  -> effective ContextBudget
```

This matters for multi-agent work:

| Consumer | Budget source |
| --- | --- |
| Ling Agent coordinator reply | Ling Agent or channel default provider preset. |
| Selector / auto-route | Selector provider if configured, otherwise coordinator provider with selector reserves. |
| Specialist teammate | That teammate's selected provider preset. |
| Workflow step runner | The step executor's provider preset and runner capability snapshot. |
| Fan-in / condenser call | Prefer the same provider/model that will consume the compacted view; use smaller caps for `model_unknown`. |

The same channel may produce several different Context Views and budgets in a single
turn. A selector can receive a small lightweight view while an Engineer step gets a
larger tool-running workflow view. Automatic compaction is per-view/per-call, not one
global channel summary shared by every model.

Fallback rules:

- unknown providers should never receive unbounded channel history;
- if a provider returns a context-length error before side effects, rebuild with a smaller
  budget and retry once for no-tools replies/selectors;
- workflow runs should build a valid packet before starting the runner instead of relying
  on after-failure retries;
- provider errors must not trigger protocol rewrites or memory authority changes.

Provider UI boundary:

- `contextWindow` and `maxTokens` remain optional advanced overrides in Provider Presets.
- Blank values mean automatic capability resolution.
- Model Workbench should show a compact capability state such as `Auto`, `Estimated`, or
  `Conservative`, not require users to hand-enter token limits.
- Developer/evidence surfaces may show the effective budget mode, context window,
  reserved output, and dropped/compacted section ids after the user opens details.

## Section Priority

Context Pack assembly should preserve context in this order. Not every consumer includes
every layer, but ordinary channel replies should include the channel context layers that
are relevant and within budget:

1. hard runtime/safety instructions and approval boundaries;
2. current turn envelope or workflow objective;
3. explicit user references and materialized inputs selected for this turn;
4. channel identity, bound workspace/path, and collaboration protocol rules relevant to
   this kind;
5. active work state, including proposal, workflow, run, approval, queued follow-up, or
   interrupt/redirect state when relevant;
6. current teammate persona and selected skill fragments;
7. acceptance criteria, open questions, and current gate instructions;
8. recent visible channel messages needed for short follow-ups and revisions;
9. compacted channel summaries, decisions, handoffs, workflow packet summaries, source
   refs, and artifact summaries;
10. scoped memory recall;
11. older raw discussion messages.

When the pack is over budget, trim from the bottom first, then compact medium-priority
sections into summaries/source refs. `must_keep` sections should fail fast instead of
being silently dropped.

## Compaction Rules

Automatic compaction may create temporary runtime summaries and durable collaboration
records, but the destinations are different:

| Destination | Can be automatic? | Activation rule |
| --- | --- | --- |
| Temporary Context Pack summary | Yes | scoped to the current request/run only |
| `ChannelContextSummary` | Yes, when source refs are explicit and the record is visible/auditable | usable as future context by normal selection policy |
| `ChannelDecision` | No for final decisions; AI may draft | user or policy-confirmed decision required |
| `ChannelHandoff` | Yes during orchestrated workflow transitions | must name source, target, expected output, and status |
| Workflow packet/source refs | Yes inside workflow state machine | tied to workflow/step ids |
| Shared or teammate memory | Candidate only | review gate before active memory use |
| Channel Collaboration Protocol | No silent updates | user edit or explicit confirmation only |

This boundary is the main guard against a channel protocol becoming a growing shared
memory file.

## Request Flows

### Ordinary Channel Reply

```text
message
  -> intent selector/default teammate
  -> Context Budget Manager kind=channel_reply
  -> minimal pack
  -> no-tools AI reply
```

The pack should not include a full roster unless the user asks about channel membership
or routing context.

### Visible Multi-Reply

```text
message asks multiple teammates to answer
  -> selector chooses bounded teammate ids
  -> one Context Pack per selected teammate
  -> each pack includes roster_compact + visible participants
  -> ordinary ai_reply messages
```

Each teammate can say it sees the channel roster and selected participants. It must also
say it does not know presence/online state or unseen peer replies when asked.

### Workflow Step

```text
accepted proposal/workflow
  -> orchestrator selects step
  -> Context Budget Manager kind=workflow_step
  -> packet with summaries, decisions, handoffs, source refs
  -> normal task/run coordinator
```

The step should not read an entire channel transcript unless the user explicitly selected
that transcript or no summary exists and it still fits the budget.

## Detailed Follow-Up Slices

The next slices should stay additive. The existing orchestrator state machine, resource
leases, approval policy, task/run coordinator, and workflow packet artifacts remain the
source of truth.

### P5 Workflow Step Context Pack

Purpose: route workflow-step prompt assembly through the same bounded Context Pack layer
already used by channel replies and selectors.

Entry point:

```text
prepareWorkflowStepStart()
  -> build workflow_step Context Pack
  -> render pack into the task prompt/run request
  -> create task/run through the existing coordinator
  -> create existing workflow step context artifact for evidence
```

The implementation should not add a second workflow launcher. It should replace the raw
`formatWorkflowStepTaskPrompt()` assembly with a rendered `workflow_step` Context Pack,
then keep the current task/run creation path intact.

Required pack sections:

| Section | Priority | Source | Notes |
| --- | --- | --- | --- |
| Runtime boundary | `must_keep` | static Ling instructions | Complete only this step; do not start later steps; approval policy remains external. |
| Workflow objective | `must_keep` | `ChannelWorkflow.objective` | The top-level user goal. |
| Step instruction | `must_keep` | `ChannelWorkflowStep.prompt` | Current step title, phase, skill, acceptance criteria, gate instructions. |
| Teammate identity | `high` | step assignee/template metadata | Role and skill context, not private teammate chat. |
| Dependency outputs | `high` | prior step output packets/fan-in summaries | Summaries and artifact refs first; raw artifact bodies only if explicitly selected later. |
| Decisions and handoffs | `high` | workflow selector decisions, handoff intents, channel decisions | Include status and source refs; avoid raw hidden selector prompts. |
| Channel protocol excerpt | `medium` | channel settings/protocol | Only rules relevant to this workflow step, such as language and review expectations. |
| Scoped memory recall | `medium` | active memory policy | Review-gated memory only; candidates stay out until promoted. |
| Recent visible discussion | `low` | channel messages | Only if no summary exists or the user explicitly selected the discussion. |
| Source refs | `low` | artifacts/messages/runs | Prefer ids, titles, paths, and summaries over full bodies. |

Budget behavior:

- `must_keep` over budget fails the step before starting the run, with a clear blocker.
- `low` sections drop first, then `medium`, then `high`.
- Dependency outputs should be summarized/ref-linked before old visible chat is included.
- Unknown custom providers use the conservative `model_unknown` budget and should not
  receive raw channel history.
- No workflow step should retry after side effects only because context was too long; it
  should build a valid packet before the run starts.

Evidence behavior:

- Keep writing the existing workflow step context artifact.
- Add Context Pack metadata to that artifact or link the artifact to a future
  `ContextPackSnapshot`; do not create a separate evidence system in P5.
- Persist dropped section ids and source refs so a later drilldown can explain why a
  step did not see a piece of context.

P5 acceptance checks:

- A workflow step task prompt is rendered from a `workflow_step` Context Pack.
- Prior step output packets are included as summaries/source refs, not blindly pasted.
- Private teammate chat is absent unless explicitly promoted by a future approved flow.
- Provider budget mode is visible in packet evidence.
- Existing orchestrator transition tests still pass without state-machine changes.

### P6 Automatic Compaction

Purpose: keep long-running channels and workflows useful without turning the channel
protocol into a growing memory file.

P6 should be implemented as a demand-driven backend slice. It should not add a periodic
background summarizer, a tuning dashboard, or a new visible chat behavior.

Initial trigger policy:

| Trigger | Action |
| --- | --- |
| Workflow starts and selected context is already over budget | Create a workflow-scoped packet summary before the first step starts. |
| Workflow step pack is over budget after dropping low-priority sections | Compact dependency outputs or old discussion into a summary with source refs. |
| Channel has a long visible discussion and no usable summary | Create a `ChannelContextSummary` only when a future reply/workflow needs it. |
| Provider returns a context-length error before side effects | Rebuild no-tools reply/selector pack with a smaller budget and retry once. |

The first implementation should avoid a background "summarize every N messages" job.
Demand-driven compaction is easier to audit and prevents silent channel growth.

P6 sub-slices:

| Slice | Scope | Notes |
| --- | --- | --- |
| P6A | Workflow-step pre-run compaction | If a `workflow_step` Context Pack is over budget after dropping optional sections, compact dependency outputs and old discussion before the run starts. |
| P6B | Demand-driven `ChannelContextSummary` creation | Create summaries only when a reply/workflow needs compressed channel discussion and source refs are explicit. |
| P6C | No-tools context-length retry | For no-tools replies/selectors only, retry once with a smaller pack after a context-length error before side effects. |
| P6D | Packet summary artifact | Store compacted workflow summaries in the existing workflow artifact tree before adding a new durable table. |

Compaction destinations:

| Destination | P6 behavior |
| --- | --- |
| Temporary pack summary | May be created in memory for one request/run. |
| `ChannelContextSummary` | May be created automatically when source refs are explicit and the summary is visible in context surfaces. |
| Workflow packet summary | May be created inside workflow artifacts and linked to the workflow/step. It is audit evidence, not a default conversation transcript block. |
| `ChannelDecision` | Draft only; final decisions require user or policy confirmation. |
| `ChannelHandoff` | Allowed during orchestrated transitions when source/target/expected output are explicit. |
| Memory candidate | Candidate only; never active memory without review. |
| Channel Collaboration Protocol | Never silently changed. |

Compaction request shape:

```ts
interface ContextCompactionRequest {
  readonly kind:
    | "workflow_step_pre_run"
    | "channel_summary_for_reply"
    | "reply_context_length_retry";
  readonly channelId: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly providerPresetId?: string;
  readonly budget: ContextBudget;
  readonly sourceSections: readonly ContextSection[];
  readonly sourceRefs: readonly ContextSourceRef[];
  readonly target:
    | "temporary_pack_summary"
    | "channel_context_summary"
    | "workflow_packet_summary";
}
```

Summary draft shape:

```ts
interface ChannelContextSummaryDraft {
  readonly channelId: string;
  readonly scope: "channel" | "workflow" | "workflow_step";
  readonly sourceRefs: readonly ContextSourceRef[];
  readonly summary: string;
  readonly decisionsMentioned: readonly string[];
  readonly openQuestions: readonly string[];
  readonly createdBecause:
    | "workflow_start_over_budget"
    | "workflow_step_over_budget"
    | "reply_context_length_retry"
    | "manual_context_compact";
}
```

Workflow packet summary shape:

```ts
interface WorkflowPacketSummary {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly workflowStepId?: string;
  readonly sourceRefs: readonly ContextSourceRef[];
  readonly summary: string;
  readonly dependencyOutputRefs: readonly {
    readonly workflowStepId: string;
    readonly outputArtifactId?: string;
    readonly resultSummary?: string;
  }[];
  readonly openQuestions: readonly string[];
  readonly droppedSectionIds: readonly string[];
  readonly generatedAt: string;
}
```

P6A workflow-step compaction flow:

```text
prepareWorkflowStepStart()
  -> build workflow_step Context Pack
  -> trim low/medium/high sections
  -> if still over budget:
       compact dependency outputs and old discussion
       write workflow packet summary artifact
       rebuild workflow_step Context Pack with compact summary section
  -> if must_keep still over budget:
       block step before creating task/run
  -> otherwise create task/run normally
```

P6A rules:

- Only compact sections with explicit source refs.
- Do not summarize private teammate chat.
- Do not read full artifact bodies in P6A unless the artifact is already a text summary
  produced by workflow packets/fan-in.
- `must_keep` sections are never summarized away.
- The resulting workflow-step task prompt must include the packet summary source ref and
  the dropped section ids in Context Pack metadata.

P6B channel summary flow:

```text
channel reply or workflow proposal needs context
  -> Context Pack builder detects no usable summary and over-budget visible discussion
  -> compact selected visible channel messages into ChannelContextSummary
  -> rebuild Context Pack with summary + source message refs
```

P6B rules:

- Only visible channel messages may become a channel summary.
- The summary target should reuse the existing `ChannelContextSummary` model:
  - `targetType="thread"` for discussion summaries;
  - `targetType="task"` when the summary is explicitly tied to a task/proposal.
- `sourceMessageIds` and `decisionIds` must be populated where available.
- `authorType="system"` for automatic compaction.
- The summary is visible in Context surfaces and can be edited or superseded through
  existing context-summary flows later.
- Implementation status: implemented for no-tools reply/selector retry paths through
  demand-driven `ChannelContextSummary` creation; no background summarizer is added.

P6C no-tools retry flow:

```text
no-tools AI reply / selector call
  -> provider returns context-length error before any side effect
  -> rebuild pack with smaller input budget
  -> drop optional sections and use summaries if available
  -> retry once
```

P6C rules:

- Applies only to no-tools reply/selector paths.
- Does not apply to workflow steps after a task/run starts.
- Does not retry tool-running work, write actions, approvals, deploys, or external sends.
- The retry should persist or log compacted decision metadata only if that path already
  persists route/selector evidence.
- Implementation status: implemented as a single retry after a provider context-length
  error, with a smaller degraded Context Pack and compaction ids recorded only in
  existing route/selector evidence metadata.

Compaction model call:

- Prefer the same provider preset that would receive the final pack.
- If the provider is `model_unknown`, use a smaller compaction input cap.
- Require a deterministic local validator:
  - non-empty summary;
  - all referenced source refs exist;
  - no new source refs invented by the model;
  - no protocol edits;
  - no active memory writes.
- If structured output is unavailable, accept plain text only after wrapping it into the
  validated local draft shape.

Failure behavior:

- If compaction fails before a run starts, block the workflow step with an actionable
  reason instead of starting an under-specified run.
- If compaction fails for an ordinary reply, continue with a current-turn-only degraded
  pack only when safe; this is a fallback, not the default product context.
- If a provider lacks structured output support, accept a plain-text summary only after
  local validation confirms non-empty summary and source refs.

Implementation files:

| Concern | Suggested file |
| --- | --- |
| Request/draft types and validators | `packages/daemon/src/features/channels/context-compaction.ts` |
| Workflow-step pre-run integration | `packages/daemon/src/features/channels/workflows.ts` |
| Workflow summary artifacts | `packages/daemon/src/features/channels/workflow-step-packets.ts` or a sibling helper |
| Channel summary persistence | existing `ChannelContextSummary` store/routes |
| Tests | `packages/daemon/test/channel-workspace.test.mjs` |

P6 acceptance checks:

- Compaction never edits channel protocol.
- Compaction never promotes memory.
- Summary records include source refs.
- Workflow steps can start from compacted dependency summaries.
- Context-length retry for no-tools replies/selectors is limited to one safe retry.

### P7 Channel Collaboration Protocol Editing

Purpose: make channel-level collaboration rules user-editable without confusing them with
memory, transcript, or hidden agent chat.

P7 should be implemented after P6 because Context Pack builders need to prove which
protocol fields are actually consumed. The first P7 slice should make the protocol
editable and auditable; it should not make agents silently rewrite it.

Protocol sources, highest precedence first:

1. explicit user instruction in the current message;
2. channel protocol override saved by the user;
3. channel settings such as language preference, auto-reply mode, default teammate, and
   visible multi-reply cap;
4. workspace/user language preference;
5. built-in Ling defaults;
6. teammate-specific instructions such as an edited agent file, scoped to that teammate.

The current-message instruction may override behavior for that turn, but it should not
silently persist into the channel protocol.

Editing UX boundary:

- Primary entry: the channel Context surface.
- Secondary entry: channel Settings can link to the same protocol editor.
- Default chat should show only a short confirmation/event when the protocol changes.
- AI may draft a proposed protocol change, but the user must confirm it.
- Do not use a tuning dashboard or route-evidence drawer for protocol editing.

Protocol storage:

The current `Channel` model has explicit fields for response language, auto-reply mode,
and default teammate, but it does not have a generic metadata bag. The first
implementation should reuse those existing fields. Protocol-only fields should remain
read-only defaults until a narrow `channel_collaboration_protocols` table is added.

Do not store opaque protocol JSON on the channel unless the core channel model first adds
an explicit versioned protocol field. If edit history, AI drafts, source refs, or rollback
ship in the same slice, use the narrow table instead.

Protocol record shape:

```ts
interface ChannelCollaborationProtocol {
  readonly schemaVersion: 1;
  readonly channelId: string;
  readonly responseLanguage?: "workspace" | "follow_user" | "zh-CN" | "en-US";
  readonly autoReplyMode?: "mentions_only" | "default_teammate" | "auto_route";
  readonly defaultTeammateId?: string;
  readonly defaultWorkflowPreference?: "manual" | "architect_engineer_qa" | string;
  readonly visibleMultiReplyMaxParticipants?: number;
  readonly privacyRules?: readonly string[];
  readonly reviewRules?: readonly string[];
  readonly updatedBy: "local-user" | "system_template";
  readonly updatedAt: string;
}
```

Protocol edit draft shape:

```ts
interface ChannelCollaborationProtocolDraft {
  readonly channelId: string;
  readonly baseVersion?: string;
  readonly proposedPatch: Partial<ChannelCollaborationProtocol>;
  readonly reason: string;
  readonly createdBy: "local-user" | "ai-draft";
  readonly sourceRefs: readonly ContextSourceRef[];
}
```

Field mapping:

| Protocol field | Existing source | P7 behavior |
| --- | --- | --- |
| `responseLanguage` | `Channel.responseLanguage` and workspace setting | Editing this field should write the existing channel response-language setting or a protocol override, not duplicate conflicting state. |
| `autoReplyMode` | `Channel.autoReplyMode` | Editing should use the existing channel update path and keep feature-flag validation for `auto_route`. |
| `defaultTeammateId` | `Channel.defaultTeammateId` | Editing should validate active teammate membership/visibility. |
| `visibleMultiReplyMaxParticipants` | channel runtime/protocol setting | If no storage exists yet, add as protocol override rather than hard-coding in selector logic. |
| `privacyRules` | protocol override only | Inform Context Pack builders; never grant access to private chats by itself. |
| `reviewRules` | protocol override only | Inform workflow-step/reply prompts; does not create approvals by itself. |
| `defaultWorkflowPreference` | protocol override only | Used to prefill proposals; does not auto-run workflows. |

API shape:

```text
GET   /channels/:channelId/protocol
PATCH /channels/:channelId/protocol
POST  /channels/:channelId/protocol/drafts
POST  /channels/:channelId/protocol/drafts/:draftId/apply
POST  /channels/:channelId/protocol/revert
```

API rules:

- `GET` returns the effective protocol plus sources for each field.
- `PATCH` is for direct user edits only.
- AI-created drafts require `apply`; they cannot mutate the channel directly.
- `revert` restores built-in/channel-setting defaults without deleting decisions,
  handoffs, summaries, or memory candidates.
- Protocol updates should emit a normal channel event/activity item, not a chat reply.

UI boundary:

- Primary location: Channel `Context` surface.
- Settings may link to the same editor for response language, auto-reply mode, and
  default teammate.
- The default conversation may show a compact "protocol updated" activity event after
  save, but not the full diff.
- The editor should show:
  - current effective values;
  - field source (`message`, `channel override`, `channel setting`, `workspace`, `default`);
  - proposed diff before save;
  - reset/revert action.

Context Pack integration:

- Builders should consume a normalized effective protocol object.
- Builders must not mutate protocol.
- A current-message instruction can override rendered behavior for one request but must
  not persist unless the user explicitly saves it.
- Protocol privacy rules may narrow context visibility; they must not widen access to
  private chats, hidden teammate prompts, provider secrets, or unreviewed memory.

P7 sub-slices:

| Slice | Scope | Notes |
| --- | --- | --- |
| P7A | Effective protocol resolver | Normalize channel settings, workspace language, defaults, and overrides into one read-only object. |
| P7B | Protocol API | Add read/update/draft/apply/revert endpoints with validation. |
| P7C | Context surface editor | Add a small editor in the existing Context surface; no default chat UI rewrite. |
| P7D | Context Pack consumption | Route reply/selector/workflow-step builders through the resolver. |

P7 implementation checklist:

1. P7A resolver first:
   - Add a daemon-side `channel-protocol` helper that returns an
     `EffectiveChannelCollaborationProtocol`.
   - Resolve each field with a source label:
     `current_message`, `channel_setting`, `workspace_setting`, `default`, or
     `teammate_instruction`.
   - Include only read-only computation in P7A; it must not write channel settings,
     create summaries, change memory, or emit chat messages.
   - Existing fields should resolve from existing storage:
     `Channel.responseLanguage`, `Channel.autoReplyMode`, `Channel.defaultTeammateId`,
     and workspace `responseLanguage`.
   - Protocol-only fields without storage should resolve to defaults until P7B adds a
     durable override path.

2. P7B API in two small cuts:
   - P7B1: implement `GET /channels/:channelId/protocol`, direct `PATCH`, and `revert`
     for fields that already have storage on `Channel` or workspace settings.
   - P7B1 must not accept protocol-only fields that have no durable storage yet; return
     a validation error instead of silently dropping them.
   - P7B2: add AI draft/apply endpoints and protocol-only storage for
     `privacyRules`, `reviewRules`, `defaultWorkflowPreference`, and
     `visibleMultiReplyMaxParticipants`.
   - P7B2 stores protocol-only fields in a narrow
     `channel_collaboration_protocols` table with version/source metadata and
     `channel_collaboration_protocol_drafts` for staged proposals. It must not invent a
     generic channel metadata bag.

3. P7C UI surface:
   - Put the editor in the existing Channel `Context` surface.
   - Channel Settings may deep-link to the same editor for language, auto-reply mode,
     and default teammate.
   - The default conversation may show a compact "protocol updated" activity event after
     save, but it should not show the full protocol diff or raw context evidence.
   - Show field source, current value, proposed value, validation errors, and reset.
   - Do not add a right-drawer evidence UI in P7; that remains P8.

4. P7D Context Pack consumption:
   - Replace ad hoc reads of language, auto-reply mode, default teammate, and protocol
     excerpt text with the resolver output.
   - Context Pack builders can read the effective protocol but cannot mutate it.
   - Current-message instructions can override the rendered behavior for one request,
     but only an explicit save can persist a protocol change.
   - Privacy rules may narrow visible context; they must never widen access to private
     teammate chat, hidden prompts, provider secrets, raw artifacts, or unreviewed
     memory candidates.

P7B2 storage/apply boundary:

P7B2 adds protocol-only storage and AI draft/apply endpoints while preserving the P7B1
direct-editor boundary. Fields already backed by `Channel` can still be edited directly;
protocol-only fields are written only by applying a draft, so ordinary messages,
summaries, workflow output, and Context Pack assembly cannot silently mutate protocol.

P7B2 adds all of these together:

- a narrow `channel_collaboration_protocols` store/table, keyed by channel id and
  version;
- direct storage for protocol-only fields:
  `defaultWorkflowPreference`, `visibleMultiReplyMaxParticipants`, `privacyRules`, and
  `reviewRules`;
- AI draft records with `sourceRefs`, `baseVersion`, `proposedPatch`, `reason`,
  `createdBy`, and expiration/status;
- an explicit apply endpoint that checks the draft base version before writing;
- rollback/revert support that can restore the previous protocol-only record without
  touching channel messages, decisions, handoffs, summaries, tasks, or memory candidates.

P7B2 must still not add:

- a generic channel metadata bag;
- silent protocol edits from ordinary messages, workflow outputs, summaries, or memory
  consolidation;
- automatic workflow execution from `defaultWorkflowPreference`;
- privacy rules that grant broader context access than the channel already permits.

P7C detailed UI design:

P7C belongs in the existing channel Context surface. It is a settings/control surface,
not a new participant in the default chat and not the P8 evidence drilldown.

Recommended layout:

| Region | Content | Notes |
| --- | --- | --- |
| Header | "Collaboration protocol", last updated time, reset action | Keep compact; do not use hero or marketing copy. |
| Editable fields | Response language, auto-reply mode, default teammate | These map to P7B1 API fields. |
| Read-only direct-editor fields | Workflow preference, visible multi-reply cap, privacy rules, review rules | Direct editor shows the effective values; changes to these fields come through draft/apply, not normal `PATCH`. |
| Field source | `channel_setting`, `workspace_setting`, `default`, `current_message`, `teammate_instruction` | Source labels come from the resolver response. |
| Review strip | Pending diff, validation errors, Save, Cancel | Show only after the user changes a value. |

P7C interaction rules:

- On open, call `GET /channels/:channelId/protocol` and render the effective protocol.
- Edits stay local until Save.
- Save calls `PATCH /channels/:channelId/protocol` with only changed P7B1 fields.
- Reset calls `POST /channels/:channelId/protocol/revert` after user confirmation.
- If `PATCH` rejects `auto_route` because the feature flag is disabled, keep the user's
  local selection visible and show the backend error near the field.
- If `PATCH` rejects `defaultTeammateId`, refresh the teammate list and keep the editor
  open.
- On success, refresh the protocol response and clear local pending diff.
- The chat timeline may receive a compact activity event later, but P7C does not require
  one.

P7C field controls:

| Field | Control | Values |
| --- | --- | --- |
| `responseLanguage` | select/menu | `workspace`, `follow_user`, `zh-CN`, `en-US` |
| `autoReplyMode` | segmented control or select | `mentions_only`, `default_teammate`, `auto_route` |
| `defaultTeammateId` | teammate picker | Active, non-hidden teammates only; allow clearing. |
| protocol-only fields | read-only rows | Display defaults and "not editable yet" state. |

P7C acceptance checks:

- Editing response language changes the same value returned by the existing channel
  settings API.
- Revert returns response language to workspace/default behavior and auto-reply mode to
  `mentions_only`.
- Unsupported protocol-only fields cannot be edited from the UI.
- The default chat feed does not show raw protocol JSON, field sources, or context
  evidence.
- The editor works if the channel has no default teammate configured.

P7D detailed Context Pack consumption design:

P7D should replace scattered channel-setting reads with the effective protocol resolver,
while keeping all builders read-only.

Initial integration points:

| Path | Current behavior to replace | P7D behavior |
| --- | --- | --- |
| Ordinary AI reply | Reads channel/workspace language directly. | Resolve protocol once, render response language and protocol excerpt from it. |
| `visible_multi_reply` | Uses roster and reply mode decisions directly. | Include effective protocol summary for each visible reply participant. |
| channel intent selector | Reads response language/default mode through local helpers. | Use resolver output for language, auto-reply mode, and default teammate. |
| `auto_route` selector | Uses channel auto-reply mode and teammate references directly. | Use resolver output and source labels in route evidence metadata. |
| workflow proposal/step | Uses proposal language and workflow-step context separately. | Use resolver output when creating proposal text and workflow-step Context Pack sections. |

P7D implementation sequence:

1. Add a small adapter that converts `EffectiveChannelCollaborationProtocolResult` into
   reusable Context Pack sections.
2. Update ordinary channel replies to use the resolver for response language first,
   leaving existing language inference as fallback only for current-message
   `follow_user`.
3. Update intent selector and `auto_route` paths to use the same resolved
   `autoReplyMode` and `defaultTeammateId`.
4. Update workflow proposal and workflow-step pack assembly to include a compact
   protocol section with source labels.
5. Remove duplicated prompt text that separately describes channel language/default
   teammate once tests prove the resolver path covers it.

P7D Context Pack section shape:

```ts
interface ChannelProtocolContextSection {
  readonly id: "channel_collaboration_protocol";
  readonly priority: "high";
  readonly sourceRefs: readonly ContextSourceRef[];
  readonly text: string;
  readonly metadata: {
    readonly responseLanguage: ChannelResponseLanguage;
    readonly responseLanguageSource: ChannelProtocolFieldSource;
    readonly autoReplyMode: ChannelAutoReplyMode;
    readonly autoReplyModeSource: ChannelProtocolFieldSource;
    readonly defaultTeammateId?: string;
    readonly defaultTeammateSource: ChannelProtocolFieldSource;
  };
}
```

P7D rules:

- Protocol sections are readable guidance, not memory.
- The section may be dropped only if a path can still honor required language and route
  behavior through structured request fields.
- Privacy rules can only remove or redact candidate context sections.
- Builders must not call `PATCH /protocol`, create protocol drafts, or write protocol
  storage.
- Current-message instructions override rendered behavior for that request only and must
  be represented as `source="current_message"` in local metadata if surfaced.

P7D acceptance checks:

- All reply/selector/workflow-step paths can explain which protocol values were used.
- Existing response-language tests continue to pass after removing ad hoc reads.
- `auto_route` disabled behavior remains feature-flag gated.
- Workflow-step Context Pack artifacts include the protocol section source metadata.
- No protocol state changes occur during Context Pack assembly.

P7 implementation status:

- P7A implemented: daemon-side resolver returns effective protocol values and field
  sources without mutating channel state.
- P7B1 implemented: `GET /channels/:channelId/protocol`,
  `PATCH /channels/:channelId/protocol`, and
  `POST /channels/:channelId/protocol/revert` cover existing `Channel` fields only.
- P7B1 daemon tests cover source precedence, validation, unsupported protocol fields,
  `auto_route` feature gating, teammate availability, and revert.
- P7B2 implemented: protocol-only overrides are stored separately from channel fields,
  AI/local drafts are persisted with source refs/base version/reason/status, and applying
  a draft is the only write path for protocol-only fields.
- P7C implemented: the channel Context surface includes a protocol editor for
  response language, auto-reply mode, and default teammate; protocol-only fields remain
  read-only defaults.
- P7D implemented: ordinary replies, visible multi-replies, intent selector,
  `auto_route`, and workflow-step Context Packs include resolver-backed protocol
  sections; workflow context artifacts preserve protocol section metadata.
- Settings deep-link to the protocol editor implemented: Settings opens the existing
  channel Context/Protocol surface instead of creating a duplicate editor.

P7 acceptance checks:

- Protocol edits require explicit user action.
- Protocol diffs are reviewable before save.
- Reverting to built-in defaults is possible.
- Ordinary messages and workflow outputs do not append to the protocol.
- Context Pack builders read protocol excerpts without mutating them.
- AI draft protocol changes cannot apply without user confirmation.
- Protocol privacy rules never widen context access.

### P8 Context Evidence Drilldown

Purpose: let users and developers inspect why a teammate or workflow step saw certain
context, while keeping the default conversation clean. P8 remains deferred until P6
settles which summaries/snapshots are persisted and P7 settles where protocol state
lives.

P8 should start with workflow-step evidence because workflow steps already persist a
Context Pack snapshot in the workflow context artifact. Ordinary replies and selectors
should remain deferred until there is a deliberate persistence/debug policy for those
paths.

P8 should not add:

- selector confidence badges;
- raw prompt text in the normal chat feed;
- tuning sample sets;
- a permanent right-drawer panel dedicated to route evidence;
- token counts in ordinary messages.

Evidence entry points:

| Entry | Shows | Default visibility |
| --- | --- | --- |
| Workflow step detail | pack kind, provider budget mode, kept/dropped section labels, source refs | Expandable from workflow evidence/details. |
| Context surface | protocol, summaries, decisions, handoffs, memory candidates | User-opened context page/surface. |
| Developer diagnostics | estimated tokens, budget mode, dropped section ids, compaction ids | Debug/developer mode only. |
| Reply evidence | source message and minimal pack metadata | Only when an evidence/debug flag or explicit inspect action exists. |

Snapshot policy:

- Persist workflow-step Context Pack snapshots or equivalent metadata because workflow
  runs are auditable work.
- Do not persist every ordinary chat reply snapshot by default.
- For ordinary replies/selectors, persist only suppressed decision evidence already
  required by routing or a small metadata record when debug evidence is enabled.

P8 sub-slices:

| Slice | Scope | Notes |
| --- | --- | --- |
| P8A | Workflow-step Context Pack drilldown | Show persisted workflow-step Context Pack evidence from the existing workflow context artifact. |
| P8B | Reply/selector inspect action | Deferred; add only explicit inspect action/debug flag, not default persistence for every reply. |
| P8C | Developer budget diagnostics | Deferred; expose deeper token/budget fields only in developer/debug surfaces. |

P8A detailed design:

P8A is an inspectable details view for one workflow step. It explains what the step saw,
what was dropped, and which durable source refs back the visible evidence. It must not
show raw runner prompts in the normal chat feed.

P8A entry points:

| Entry | Behavior |
| --- | --- |
| Workflow queue card | Add a compact "Context" / "Inspect context" action for steps with `metadata.contextArtifactId`. |
| Workflow evidence detail | Show a Context Pack section inside the existing workflow evidence/detail surface. |
| Context surface runtime tab | Link from the workflow step row to the same inspectable detail. |

P8A should not introduce a new permanent drawer. It should reuse the current expandable
workflow detail surface or inline disclosure already used for workflow evidence.

P8A data source:

```text
ChannelWorkflowStep.metadata.contextArtifactId
  -> artifact JSON
  -> ChannelWorkflowStepContextPacket.contextPack
```

Required displayed fields:

| Field | User-facing display |
| --- | --- |
| `contextPack.kind` | Context Pack kind, expected `workflow_step`. |
| `contextPack.providerPresetId` / `modelId` | Provider/model summary, with missing values shown as `unknown`. |
| `contextPack.budget.mode` | Budget mode: `model_known`, `model_estimated`, or `model_unknown`. |
| `estimatedInputTokens/inputBudgetTokens` | Developer-level compact number; hide behind details if the normal user view is crowded. |
| `sections[]` | Kept section ids, role, priority, source refs, and protocol metadata when present. |
| `droppedSectionIds[]` | Dropped section labels/ids with a plain explanation that lower-priority sections were trimmed first. |
| `compactionIds[]` | Links/ids for workflow packet summary artifacts created by P6A/P6D. |
| `sourceRefs[]` | Durable refs grouped by type: workflow, workflow step, artifact, summary, decision, handoff. |
| protocol metadata | `responseLanguage`, `autoReplyMode`, `defaultTeammateId`, and their source labels from P7D. |

P8A section rendering:

- Render section id, role, priority, estimated tokens, and source-ref labels.
- Do not render full section text by default.
- For safe sections, a short text preview can be shown only if it is already stored in
  the context artifact and is not a private/hidden/secrets source.
- The protocol section may show metadata fields and source labels, not hidden prompts.
- Dropped sections should show ids and priority only; do not reconstruct dropped text.

P8A safety boundary:

- Never fetch or display provider secrets, private teammate messages, hidden teammate
  prompts, raw artifact bodies, or unreviewed memory candidates.
- Do not show raw runner prompt text in the normal chat feed.
- Do not show selector confidence scores.
- Do not infer missing evidence from current channel state; use the persisted context
  artifact snapshot for the selected workflow step.
- If the context artifact is missing or malformed, show a blocked/empty evidence state
  instead of falling back to live prompt reconstruction.

P8A UI states:

| State | Behavior |
| --- | --- |
| No context artifact | Show "No persisted context snapshot for this step." |
| Loading artifact | Show compact loading row inside the workflow detail. |
| Artifact load failed | Show the artifact id and error message; keep workflow actions usable. |
| Context Pack present | Show summary chips first, then expandable sections/source refs. |
| Compaction present | Show compaction ids and link/open actions for summary artifacts where existing artifact UI supports it. |

P8A acceptance checks:

- A workflow step with `contextArtifactId` can show its Context Pack kind, budget mode,
  kept sections, dropped section ids, compaction ids, and source refs.
- The `channel_collaboration_protocol` section shows P7 protocol metadata and source
  labels when present.
- A compacted workflow step links the context pack to the workflow packet summary
  artifact id.
- Missing/malformed context artifacts do not crash the workflow panel.
- The default chat feed remains unchanged.
- Evidence does not expose private teammate chat, hidden prompts, provider secrets, raw
  artifact bodies, or unreviewed memory.

P8B deferred boundary:

- Add only an explicit inspect action for reply/selector evidence.
- Do not persist full Context Pack snapshots for every ordinary reply by default.
- Do not add route confidence badges to normal messages.
- Do not create tuning sample sets.

P8B detailed design:

P8B is an explicit inspection path for ordinary channel reply and selector decisions. It
answers questions like "why did this message get an AI reply?", "why did no one reply?",
and "why was this teammate selected?". It should not try to expose the full prompt or
turn every reply into a persisted workflow-style context artifact.

P8B initial scope should prioritize auto-reply and selector evidence:

| Scope | P8B behavior | Deferred |
| --- | --- | --- |
| Auto-reply created | Explain reply mode, selected teammate, source message, provider/model summary, and route reason. | Full rendered prompt. |
| Auto-reply suppressed | Explain suppression reason and the deterministic/model selector inputs that are safe to show. | Confidence badges. |
| `auto_route` teammate selection | Explain candidate ids/labels, selected teammate, source refs, and reason. | Tuning sample sets. |
| Workflow-intent proposal selection | Link to proposal/workflow evidence where available. | Replacing proposal UI. |
| Ordinary manual teammate reply | Show only minimal context metadata when explicit inspect/debug persistence exists. | Default full Context Pack persistence. |

P8B should be implemented in four small cuts:

| Slice | Scope | Notes |
| --- | --- | --- |
| P8B1 | Message inspect action | Reuse existing "Why no reply?" / route evidence affordances and add an explicit inspect action for auto-replied messages. |
| P8B2 | Minimal reply/selector metadata | Persist or reuse only safe metadata needed for inspect: source message id, route mode, selected teammate, reason, pack kind, section ids, dropped ids, source-ref counts, provider/model ids. |
| P8B3 | Context surface index | Optionally list recent reply/selector decisions in the Context surface; no right drawer and no always-visible badges. |
| P8B4 | Safety and retention policy | Keep raw prompts, hidden teammate prompts, private chat, provider secrets, raw artifact bodies, and unreviewed memory out of the inspect payload. |

P8B entry points:

| Entry | Behavior |
| --- | --- |
| Auto-replied message evidence | Add a compact "Why this reply?" / "Inspect route" action near existing message evidence controls. |
| Suppressed auto-reply row | Reuse "Why no reply?" and enrich it with safe selector metadata where available. |
| Context surface | Show a recent decision list only when the user opens Context; it should not be a permanent drawer. |
| Developer/debug mode | May link to the raw persisted decision id, but still not raw prompts or provider secrets. |

P8B metadata shape should be intentionally smaller than P8A's workflow context packet:

```ts
interface ChannelReplyInspectMetadata {
  readonly schemaVersion: 1;
  readonly sourceMessageId: string;
  readonly replyMessageId?: string;
  readonly routeDecisionId?: string;
  readonly intentDecisionId?: string;
  readonly mode: "mentions_only" | "default_teammate" | "auto_route" | "visible_multi_reply";
  readonly outcome: "replied" | "suppressed" | "proposed_workflow" | "failed";
  readonly selectedTeammateId?: string;
  readonly selectedTeammateLabel?: string;
  readonly reason: string;
  readonly providerPresetId?: string;
  readonly modelId?: string;
  readonly contextPack?: {
    readonly kind: string;
    readonly sectionIds: readonly string[];
    readonly droppedSectionIds: readonly string[];
    readonly sourceRefCounts: Readonly<Record<string, number>>;
    readonly compactionIds: readonly string[];
  };
  readonly sourceRefs: readonly ContextSourceRef[];
  readonly createdAt: string;
}
```

P8B persistence policy:

- Reuse existing route/intent decision persistence first.
- Add a small metadata record only when existing records cannot answer the inspect
  question.
- Do not persist `ContextSection.text` for ordinary replies by default.
- Do not persist the rendered prompt for ordinary replies.
- Do not persist selector confidence as a normal UI field. If a backend model result has
  confidence internally, hide it from default UI and avoid teaching users to tune by a
  fake precision number.
- Retention can follow the same lifecycle as channel messages/route decisions; it should
  not create a separate long-lived memory object.

P8B rendering rules:

- Show human-readable outcome first: replied, suppressed, proposed workflow, or failed.
- Show selected teammate and route mode when available.
- Show reason text only if it was produced for user-visible evidence or deterministic
  router output; otherwise summarize the reason locally from safe fields.
- Show Context Pack metadata as section ids/counts only.
- Source refs should be grouped by type and label, not raw object payload.
- Default chat should show only a compact inspect affordance; details open on demand.

P8B safety boundary:

- Do not show raw prompts, hidden teammate prompts, private teammate chat, provider
  secrets, raw artifact bodies, or unreviewed memory candidates.
- Do not reconstruct missing context from current channel state; inspect should use the
  persisted decision/metadata from the time of the reply decision.
- Do not add a permanent evidence drawer.
- Do not add tuning datasets or sample labels.
- Do not turn route evidence into active memory.

P8B UI states:

| State | Behavior |
| --- | --- |
| No decision metadata | Show "No inspectable route evidence for this message." |
| Loading evidence | Show compact loading row near the message evidence/detail surface. |
| Evidence load failed | Show the decision id/message id and a retry action. |
| Suppressed reply | Show suppression reason, mode, and safe source refs. |
| Reply created | Show selected teammate, provider/model, mode, reason, and safe Context Pack ids/counts. |

P8B acceptance checks:

- A message that was auto-replied can explain mode, selected teammate, reason,
  provider/model, and safe Context Pack section ids/counts.
- A message that was intentionally not auto-replied can explain the suppression reason
  without showing selector confidence badges.
- Existing "Why no reply?" behavior continues to work and becomes the first P8B surface.
- Ordinary chat does not show raw prompts, token counts, or route JSON by default.
- No full Context Pack snapshot is persisted for every ordinary reply by default.
- Missing/malformed decision metadata does not break message rendering.

P8C detailed design:

- Developer diagnostics may show exact token estimates, provider budget fields, and
  dropped section internals.
- Keep these diagnostics behind workflow evidence details or debug/developer surfaces,
  not ordinary messages.
- P8C should reuse P8A's data model where possible instead of creating another evidence
  schema.

P8C initial scope:

| Scope | Behavior | Deferred |
| --- | --- | --- |
| Workflow-step Context Pack evidence | Add a collapsed `Budget diagnostics` details block under the existing workflow Context Pack evidence. | Global diagnostics dashboard. |
| Provider budget fields | Show mode, tokenizer, context window, reserved output, runtime overhead, input budget, estimated input, usage, and over-budget state. | Provider-specific tokenizer exactness claims. |
| Section estimates | Show section id, role, priority, estimated tokens, and ref count. | Raw section text. |
| Dropped/compacted evidence | Show dropped section ids and compaction ids/counts already stored in the packet. | Raw compaction artifact body inline. |

P8C rendering rules:

- Default collapsed state; the user must open `Inspect context`, then open
  `Budget diagnostics`.
- Show numeric token estimates only inside the workflow evidence surface.
- Preserve P8B boundaries: no confidence badges, no tuning sample sets, no raw selector
  JSON, and no ordinary-message token counters.
- If an older context artifact lacks budget fields, render `Not recorded` rather than
  crashing.

P8 implementation status:

- P8A implemented: workflow-step cards expose an explicit "Inspect context" action for
  steps with `metadata.contextArtifactId`, loading workflow evidence on demand.
- P8A implemented: workflow evidence details include a `Context Pack` group derived from
  persisted workflow-step context packets.
- P8A keeps the default chat feed unchanged and renders section ids, roles, priorities,
  source refs, dropped ids, compaction ids, and protocol metadata without full section
  text or raw runner prompts.
- P8B1 implemented: auto-replied channel messages expose an explicit "Why this reply?"
  inspect action, and suppressed/failed route evidence keeps the existing "Why no reply?"
  action.
- P8B2 implemented: route decisions may store safe Context Pack metadata only
  (`kind`, provider/model ids, section ids, dropped ids, source-ref counts, and compaction
  ids). They do not store full ordinary reply prompts or section text.
- P8B3 implemented: the channel Context surface has a `Routing` index for recent
  reply-route and intent-selector decisions. It is opened by the user, renders inline in
  the Context surface, and does not introduce a permanent right drawer.
- P8B4 implemented: daemon tests assert intent inspect payloads do not expose raw
  prompts, message bodies, hidden prompts, private messages, raw artifact bodies,
  provider secrets, context packs, confidence, or scores.
- P8C implemented for workflow-step Context Pack evidence: budget diagnostics are
  collapsed by default and show provider budget fields, usage, section token estimates,
  dropped section ids, and compaction ids without raw prompt or section text. There are
  still no route confidence badges, tuning sample sets, or developer budget diagnostics
  in normal chat.

P8 acceptance checks:

- Users can answer "why did this workflow step not see X?" from source refs/dropped
  sections.
- The default chat UI stays unchanged except links/events already used for workflow
  evidence.
- Evidence never exposes provider secrets, private teammate chat, or raw hidden prompts.
- Diagnostics are explainable without showing internal confidence scores.

## Evidence and UI

The normal channel conversation should stay clean. Context evidence belongs in expandable
details:

- Context surface/page can show protocol, summaries, decisions, handoffs, and memory
  candidates.
- Work progress rows can link to the Context Pack snapshot or selected source refs.
- Ordinary chat should not display token counts, raw prompt text, selector JSON, or
  confidence values by default.
- Workflow context packets, output packets, fan-in summaries, packet counts, and packet
  artifact ids must not render as standalone transcript cards in the normal conversation.
  They remain durable workflow evidence and may appear only after an explicit evidence or
  developer-diagnostics action. User-facing output files continue to render through the
  normal artifact strip below the terminal report.

## Implementation Slices

| Slice | Scope | Notes |
| --- | --- | --- |
| P0 | Document the context protocol, budget manager, and compaction boundary. | This document. |
| P1 | Add compact context helpers for channel replies. Implemented. | Supports current teammate identity, compact roster, visible participants, and presence disclaimer. |
| P2 | Wire `visible_multi_reply` to `roster_compact`. Implemented. | Fixes teammate answers such as "I cannot see channel members" when the roster is known. |
| P3 | Add provider budget capability metadata and conservative estimator. Implemented. | Uses existing provider preset `contextWindow` and `maxTokens` fields plus fallback estimates for custom APIs. |
| P4 | Introduce internal `ContextPack` assembly for channel replies and selectors. Implemented. | Covers channel replies, `visible_multi_reply`, channel intent selector, and `auto_route` selector. |
| P5 | Route workflow-step prompt assembly through Context Pack. Implemented. | Preserves existing orchestrator state machine and task/run coordinator. |
| P6 | Add automatic compaction into `ChannelContextSummary` and workflow packet summaries. Implemented. | Keeps source refs and visible audit records. |
| P7 | Add protocol editing/confirmation UX. Implemented. | User-confirmed changes only; no silent growth. |
| P8 | Add context evidence drilldown and budget diagnostics for developers. Implemented. | Kept out of default chat. |

Recommended order:

1. P5 first, because workflow steps are the main missing Context Pack consumer.
2. P6 second, because P5 exposes the real places where compaction is needed.
3. P7 after P5/P6, because protocol editing must know which fields are actually consumed.
4. P8 after at least P5, because workflow-step evidence is the first durable snapshot
   worth exposing.

## Test Plan

- Unit test context priority trimming with known, estimated, and unknown provider budgets.
- Unit test `visible_multi_reply` prompt sections include current teammate, compact roster,
  selected visible participants, and the no-presence/no-hidden-peer boundary.
- Unit test ordinary single replies do not include full roster by default.
- Unit test workflow packets preserve decisions/handoffs/source refs while trimming raw
  old transcript messages.
- Integration test context-length fallback for no-tools replies with a fake small-budget
  provider.
- Regression test that compaction never writes active memory or edits the channel protocol
  without explicit confirmation.

## Open Decisions

- Should P5 embed Context Pack metadata into the existing workflow step context artifact,
  or introduce a separate `ContextPackSnapshot` record for workflow steps immediately?
- Which exact channel settings fields should be mirrored into protocol JSON versus kept
  as structured columns/settings only?
- Should automatic `ChannelContextSummary` creation remain demand-driven indefinitely, or
  add an explicit background compaction job after workflow-step compaction is proven?
- What developer-mode flag should expose reply/selector Context Pack diagnostics without
  making route evidence a normal user-facing surface?
