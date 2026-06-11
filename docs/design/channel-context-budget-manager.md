# Channel Context Budget Manager

Status: P1-P4 foundation implemented for channel replies and selectors; workflow packets,
automatic compaction, protocol editing, and evidence UI remain future slices
Date: 2026-06-10

Related docs:

- [Channel Workspace Design](channel-workspace.md)
- [Channel Intent To Workflow Selector](channel-intent-workflow-selector.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)
- [Ling Memory v1](ling-memory-v1.md)
- [Provider Presets](provider-presets.md)

## Purpose

Ling channels should feel like a collaborative workspace without becoming an
AutoGen-style shared long-context group chat. The runtime needs one independent layer
that decides what context a teammate or workflow step may see, how much can fit in the
selected model, and what gets summarized when the budget is tight.

The `Context Budget Manager` is that layer.

```text
channel message / workflow step / private chat
  -> Context Budget Manager
  -> bounded Context Pack
  -> runner or no-tools reply path
```

This design keeps channel rules thin, makes compaction auditable, and supports custom
provider APIs whose context windows and tokenizer behavior may differ.

## Current State

Current Ling context assembly is intentionally narrow:

- ordinary channel AI replies use the current source message plus scoped memory recall;
- private teammate chat uses a recent message window plus scoped memory recall;
- workflow steps use task prompts, skill fragments, selected memory, step summaries, and
  workflow packet/source-ref design;
- channel collaboration records already exist conceptually as context summaries,
  decisions, handoffs, workflow packets, source refs, and review-gated memory candidates.

Missing pieces:

- no workflow-step Context Pack integration yet;
- no automatic channel-history compaction policy;
- no channel protocol editing/confirmation UX yet;
- no Context Pack evidence drilldown yet.

Implemented foundation:

- provider context budgets resolve from existing `contextWindow` and `maxTokens` preset
  fields;
- known providers use explicit preset budgets, known provider families without a window
  use conservative estimates, and unknown custom OpenAI-compatible presets use a smaller
  default budget;
- Context Pack assembly and rendering are wired for ordinary channel replies,
  `visible_multi_reply`, channel intent selection, and `auto_route` selection;
- prompt assembly can trim lower-priority Context Pack sections before rendering, but it
  does not yet create durable compaction records.

## Definitions

| Term | Meaning |
| --- | --- |
| Channel Collaboration Protocol | A thin, user-editable channel rule layer. It describes how the channel should collaborate; it is not shared memory and does not store history. |
| Context Pack | The bounded runtime bundle passed to one teammate reply, one private reply, one selector, or one workflow step. |
| Context Budget Manager | The service that builds, ranks, estimates, trims, and compacts a Context Pack for a selected provider/model. |
| Compaction | Replacing long raw context with summaries, decisions, handoffs, packet source refs, or artifact references. |
| Memory candidate | A review-gated proposal for durable shared or teammate memory. Compaction may create candidates, but cannot silently activate them. |

## Goals

- Keep every teammate/run under a provider-compatible context budget.
- Make context visibility explicit and auditable.
- Support different context budgets for channel replies, private teammate chat, selectors,
  and workflow steps.
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
| `minimal` | ordinary single teammate replies | channel id/name, current message, current teammate identity, resolved language, scoped memory recall | full roster, channel history, peer replies |
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

Fallback rules:

- unknown providers should never receive unbounded channel history;
- if a provider returns a context-length error before side effects, rebuild with a smaller
  budget and retry once for no-tools replies/selectors;
- workflow runs should build a valid packet before starting the runner instead of relying
  on after-failure retries;
- provider errors must not trigger protocol rewrites or memory activation.

## Section Priority

Context Pack assembly should preserve context in this order:

1. hard runtime/safety instructions and approval boundaries;
2. current user message or workflow objective;
3. explicit user references selected for this turn;
4. channel collaboration protocol rules relevant to this kind;
5. current teammate persona and selected skill fragments;
6. acceptance criteria, open questions, and current gate instructions;
7. active decisions and handoffs relevant to the channel/task;
8. source refs and artifact summaries;
9. scoped memory recall;
10. recent visible channel messages;
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

Initial trigger policy:

| Trigger | Action |
| --- | --- |
| Workflow starts and selected context is already over budget | Create a workflow-scoped packet summary before the first step starts. |
| Workflow step pack is over budget after dropping low-priority sections | Compact dependency outputs or old discussion into a summary with source refs. |
| Channel has a long visible discussion and no usable summary | Create a `ChannelContextSummary` only when a future reply/workflow needs it. |
| Provider returns a context-length error before side effects | Rebuild no-tools reply/selector pack with a smaller budget and retry once. |

The first implementation should avoid a background "summarize every N messages" job.
Demand-driven compaction is easier to audit and prevents silent channel growth.

Compaction destinations:

| Destination | P6 behavior |
| --- | --- |
| Temporary pack summary | May be created in memory for one request/run. |
| `ChannelContextSummary` | May be created automatically when source refs are explicit and the summary is visible in context surfaces. |
| Workflow packet summary | May be created inside workflow artifacts and linked to the workflow/step. |
| `ChannelDecision` | Draft only; final decisions require user or policy confirmation. |
| `ChannelHandoff` | Allowed during orchestrated transitions when source/target/expected output are explicit. |
| Memory candidate | Candidate only; never active memory without review. |
| Channel Collaboration Protocol | Never silently changed. |

Summary shape:

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

Failure behavior:

- If compaction fails before a run starts, block the workflow step with an actionable
  reason instead of starting an under-specified run.
- If compaction fails for an ordinary reply, continue with the minimal current-message
  pack when safe.
- If a provider lacks structured output support, accept a plain-text summary only after
  local validation confirms non-empty summary and source refs.

P6 acceptance checks:

- Compaction never edits channel protocol.
- Compaction never promotes memory.
- Summary records include source refs.
- Workflow steps can start from compacted dependency summaries.
- Context-length retry for no-tools replies/selectors is limited to one safe retry.

### P7 Channel Collaboration Protocol Editing

Purpose: make channel-level collaboration rules user-editable without confusing them with
memory, transcript, or hidden agent chat.

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

Protocol record shape can start as versioned JSON metadata:

```ts
interface ChannelCollaborationProtocol {
  readonly schemaVersion: 1;
  readonly responseLanguage?: "follow_user" | "workspace_default" | string;
  readonly autoReplyMode?: "mentions_only" | "default_teammate" | "auto_route";
  readonly defaultWorkflowPreference?: string;
  readonly visibleMultiReplyMaxParticipants?: number;
  readonly privacyRules?: readonly string[];
  readonly reviewRules?: readonly string[];
  readonly updatedBy: "user" | "system_template";
  readonly updatedAt: string;
}
```

P7 acceptance checks:

- Protocol edits require explicit user action.
- Protocol diffs are reviewable before save.
- Reverting to built-in defaults is possible.
- Ordinary messages and workflow outputs do not append to the protocol.
- Context Pack builders read protocol excerpts without mutating them.

### P8 Context Evidence Drilldown

Purpose: let users and developers inspect why a teammate or workflow step saw certain
context, while keeping the default conversation clean.

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

## Implementation Slices

| Slice | Scope | Notes |
| --- | --- | --- |
| P0 | Document the context protocol, budget manager, and compaction boundary. | This document. |
| P1 | Add compact context helpers for channel replies. Implemented. | Supports current teammate identity, compact roster, visible participants, and presence disclaimer. |
| P2 | Wire `visible_multi_reply` to `roster_compact`. Implemented. | Fixes teammate answers such as "I cannot see channel members" when the roster is known. |
| P3 | Add provider budget capability metadata and conservative estimator. Implemented. | Uses existing provider preset `contextWindow` and `maxTokens` fields plus fallback estimates for custom APIs. |
| P4 | Introduce internal `ContextPack` assembly for channel replies and selectors. Implemented. | Covers channel replies, `visible_multi_reply`, channel intent selector, and `auto_route` selector. |
| P5 | Route workflow-step prompt assembly through Context Pack. | Preserve existing orchestrator state machine and task/run coordinator. |
| P6 | Add automatic compaction into `ChannelContextSummary` and workflow packet summaries. | Keep source refs and visible audit records. |
| P7 | Add protocol editing/confirmation UX. | User-confirmed changes only; no silent growth. |
| P8 | Add context evidence drilldown and budget diagnostics for developers. | Keep out of default chat. |

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
