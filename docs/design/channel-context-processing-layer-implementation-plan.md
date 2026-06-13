# Channel Context Processing Layer Implementation Plan

Status: detailed implementation plan.
Date: 2026-06-13

Related docs:

- [Channel Context Processing Layer](channel-context-processing-layer.md)
- [Channel Context Budget Manager](channel-context-budget-manager.md)
- [Ling Agent Session Control Plane](ling-agent-session.md)
- [Ling Agent Session Implementation Plan](ling-agent-session-implementation-plan.md)
- [Input Materialization Detailed Design](input-materialization-detailed-design.md)
- [Ling Memory v1](ling-memory-v1.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)

## Purpose

This plan turns the product-level Channel Context Processing Layer into small
implementation slices.

The goal is not to create another agent runtime, another permission system, or another
large transcript store. The goal is to make every prompt-producing path consume one
shared context pipeline:

```text
durable channel/workflow/memory/evidence state
  -> source collectors
  -> policy filters
  -> ranked candidate sections
  -> per-consumer Context View
  -> Context Pack renderer / runner packet
```

## Implementation Principles

- Prefer pure helpers before new storage.
- Reuse existing channel messages, summaries, materializations, artifacts, workflow
  packets, route metadata, and memory records.
- Keep Context Processing read-oriented. It may build temporary summaries or write
  auditable compaction artifacts only through existing summary/artifact paths.
- Keep permissions on approval/run layers. A Context View never grants a tool, file,
  shell, network, or memory-write permission.
- Keep runner behavior on the existing embedded Pi runner path.
- Keep default UI intelligent rather than diagnostic. Metadata belongs in explicit
  inspect/details surfaces.
- Keep raw logs and raw artifact bodies out of ordinary prompts by default.
- Separate memory recall eligibility from public quoting/display eligibility.
- Migrate consumers gradually, with compatibility wrappers until the old Context Pack
  builders are fully replaced.

## Current Code Anchors

| Area | Current anchor |
| --- | --- |
| Channel message entry | `packages/daemon/src/features/channels/messages.ts` |
| Turn envelope | `packages/daemon/src/features/channels/ling-agent-turn-envelope.ts` |
| Current Context Pack builders | `packages/daemon/src/features/channels/context-packs.ts` |
| Existing compaction helpers | `packages/daemon/src/features/channels/context-compaction.ts` |
| Ordinary AI replies | `packages/daemon/src/features/channels/ai-replies.ts` |
| Intent selector | `packages/daemon/src/features/channels/channel-intent-selector.ts` |
| Auto-route selector | `packages/daemon/src/features/channels/channel-message-router.ts` |
| Workflow orchestration | `packages/daemon/src/features/channels/orchestrator.ts` |
| Workflow selector decisions | `packages/daemon/src/features/channels/workflow-selector.ts` |
| Workflow step packets | `packages/daemon/src/features/channels/workflow-step-packets.ts` |
| Input materialization | `packages/daemon/src/features/channels/materialization/` |
| Memory prompt helpers | `packages/daemon/src/features/memory/prompt.ts` |
| Memory types | `packages/core/src/memory-types.ts` |
| Workflow evidence Web model | `apps/web/src/lib/workflow-progress.ts` |
| Channel activity drilldown | `apps/web/src/lib/channel-activity-drilldown.ts` |
| Channel E2E tests | `apps/web/e2e/channel.spec.ts` |
| Daemon channel tests | `packages/daemon/test/channel-workspace.test.mjs` |

## Target Contracts

Start in daemon-local modules. Move contracts to `packages/contracts` only after the
shape is stable across daemon and Web.

Suggested module:

```text
packages/daemon/src/features/channels/context-processing/
  sources.ts
  policies.ts
  views.ts
  render.ts
  evidence.ts
  memory.ts
  condenser.ts
```

### Source Contract

```ts
type ChannelContextSourceKind =
  | "turn"
  | "channel_state"
  | "recent_message"
  | "channel_summary"
  | "decision"
  | "handoff"
  | "active_work"
  | "materialized_input"
  | "memory"
  | "evidence"
  | "artifact"
  | "workflow_packet";

interface ChannelContextSource {
  readonly id: string;
  readonly kind: ChannelContextSourceKind;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly sourceRefIds: readonly string[];
  readonly title: string;
  readonly text?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly sensitivity: "normal" | "private" | "secret_adjacent";
  readonly freshness: "current_turn" | "recent" | "durable" | "archival";
}
```

### View Contract

```ts
type ChannelContextViewKind =
  | "ling_agent_channel_view"
  | "specialist_task_view"
  | "selector_view"
  | "workflow_proposal_view"
  | "workflow_step_view"
  | "private_chat_view"
  | "evidence_inspect_view";

interface ChannelContextView {
  readonly id: string;
  readonly kind: ChannelContextViewKind;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly consumerTeammateId?: string;
  readonly sections: readonly ChannelContextSection[];
  readonly sourceRefs: readonly ChannelContextSourceRef[];
  readonly dropped: readonly ChannelContextDroppedSource[];
  readonly budget: ChannelContextBudgetSnapshot;
  readonly metadata: ChannelContextViewMetadata;
}
```

### Section Contract

```ts
interface ChannelContextSection {
  readonly id: string;
  readonly role: "system" | "instruction" | "user" | "memory" | "evidence";
  readonly title: string;
  readonly text: string;
  readonly sourceRefIds: readonly string[];
  readonly visibility: "prompt" | "inspect_only";
  readonly quotePolicy: "public_ok" | "influence_only" | "inspect_only";
}
```

The `quotePolicy` field is the important addition over the current Context Pack shape:
memory or private context can influence a model without becoming text that Ling should
quote publicly.

## C0: Documentation And Compatibility Inventory

Type: design and read-only inventory.

### Goal

Keep design docs aligned before code changes and identify every current prompt assembly
path that must migrate.

### Work

- Keep this plan linked from the product-level Context Processing design.
- List all consumers currently calling `build*ContextPack` or hand-building prompt
  strings.
- Classify each consumer by target view kind.
- Identify any prompt path that bypasses `LingAgentTurnEnvelope`, materialization,
  protocol resolution, or memory audit events.

### Acceptance

- The implementation plan names all first-pass consumers.
- No code behavior changes in C0.
- `git diff --check` passes.

### Non-goals

- No refactor of prompt builders.
- No UI changes.
- No storage migration.

## C1: Source Collectors

Type: daemon pure helpers.

### Goal

Extract shared collectors for candidate context sources without changing rendered
prompts.

### Suggested files

```text
packages/daemon/src/features/channels/context-processing/sources.ts
packages/daemon/src/features/channels/context-processing/sources.test.mjs
```

### Collectors

| Collector | Source data | Notes |
| --- | --- | --- |
| `collectTurnSource` | `LingAgentTurnEnvelope` | Current message, mentions, file refs, links, materialization statuses. |
| `collectChannelStateSource` | channel record, protocol resolver | Id/name/path, effective protocol, language, roster identity. |
| `collectRecentConversationSources` | channel messages | Bounded visible conversation only; exclude pending assistant placeholders. |
| `collectActiveWorkSources` | proposals, workflows, steps, runs, approvals, interventions | Active or recently terminal work relevant to the current channel. |
| `collectMaterializedInputSources` | materialization registry/cache | Bounded previews and source refs; no raw binary dumps. |
| `collectEvidenceSources` | artifacts, route metadata, workflow packets | Metadata and safe snippets only. |
| `collectMemorySources` | memory recall result | Memory ids and rendered snippets after memory policy filtering. |

### Migration rule

Existing `context-packs.ts` may call the collectors internally while still returning the
old `ContextPack` shape. That avoids a broad first PR.

### Tests

- Current turn source includes attachment/link/file refs when present.
- Recent conversation excludes unrelated channels and pending assistant placeholders.
- Active work source includes pending approval ids for the current workflow/run.
- Materialized input source includes available text previews and metadata-only refs
  without pretending to have body text.
- Evidence source summarizes run/artifact metadata without raw full stdout.

### Acceptance

- No prompt text changes are required in C1.
- Source ids are stable and include enough data for future inspect surfaces.
- Collectors are deterministic for the same store snapshot.

## C2: Policy Filters And View Builder

Type: daemon pure helpers.

### Goal

Add the shared `buildChannelContextView` API and encode per-consumer visibility rules in
one place.

### Suggested files

```text
packages/daemon/src/features/channels/context-processing/views.ts
packages/daemon/src/features/channels/context-processing/policies.ts
packages/daemon/src/features/channels/context-processing/views.test.mjs
```

### API

```ts
interface BuildChannelContextViewInput {
  readonly kind: ChannelContextViewKind;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly consumerTeammateId?: string;
  readonly sourceMessageId?: string;
  readonly sources: readonly ChannelContextSource[];
  readonly providerBudget?: ChannelContextProviderBudget;
  readonly now: string;
}

function buildChannelContextView(input: BuildChannelContextViewInput): ChannelContextView;
```

### Policy matrix

| View | Must include | Must exclude |
| --- | --- | --- |
| `ling_agent_channel_view` | current turn, channel state, recent visible conversation, active work, safe materialized inputs, scoped memory | raw logs, private chat bodies, selector internals |
| `selector_view` | current turn, channel state, lightweight recent context, capability summaries | long history, raw memory text, raw evidence |
| `workflow_proposal_view` | current user goal, channel protocol, active decisions, materialized inputs | private memory, unrelated chatter, raw command output |
| `workflow_step_view` | workflow objective, step instruction, dependencies, output packets, selected memory | full discussion, unrelated branch transcripts |
| `specialist_task_view` | task objective, acceptance criteria, role-specific evidence summaries | all-agent prompt history, other teammate private memory |
| `private_chat_view` | private thread, teammate persona, teammate memory, explicit referenced channel refs | channel history by default |
| `evidence_inspect_view` | source refs, metadata, compact summaries, selected raw snippets | secrets and private content without explicit permission |

### Acceptance

- Each view kind has focused tests for allowed and excluded source classes.
- No view changes approval state or tool availability.
- A source may be dropped with a safe reason such as `budget`, `scope`, `sensitivity`,
  `raw_evidence`, or `unrelated`.

## C3: Render Compatibility Layer

Type: daemon prompt compatibility.

### Goal

Render a `ChannelContextView` into the existing `ContextPack`/prompt shape so current
consumers can migrate without rewriting model-call code all at once.

### Suggested files

```text
packages/daemon/src/features/channels/context-processing/render.ts
packages/daemon/src/features/channels/context-processing/render.test.mjs
```

### Work

- Add `renderChannelContextView(view)` for plain prompt text.
- Add `contextViewToContextPack(view, kind)` as a temporary adapter.
- Preserve existing safe metadata fields: provider/model ids, section ids, dropped ids,
  source-ref counts, compaction ids.
- Keep raw prompts out of persistent ordinary reply metadata.

### Consumer order

1. `buildChannelReplyContextPack` internally builds `ling_agent_channel_view`.
2. `buildChannelIntentSelectorContextPack` internally builds `selector_view`.
3. `buildChannelAutoRouteContextPack` internally builds `selector_view` with stricter
   ordinary-reply constraints.
4. `buildWorkflowStepContextPack` internally builds `workflow_step_view`.

### Acceptance

- Existing model call sites can still receive rendered prompt text.
- Existing inspect metadata does not start storing raw prompts.
- Golden tests prove section ordering is stable.

## C4: Reply And Selector Migration

Type: daemon behavior migration.

### Goal

Move ordinary Ling Agent replies, intent selector, and auto-route selector onto Context
Views while preserving user-visible behavior.

### Suggested files

```text
packages/daemon/src/features/channels/ai-replies.ts
packages/daemon/src/features/channels/channel-intent-selector.ts
packages/daemon/src/features/channels/channel-message-router.ts
packages/daemon/src/features/channels/context-packs.ts
```

### Work

- Replace bespoke recent-context assembly with `ling_agent_channel_view`.
- Ensure short follow-ups such as `400字`, `继续`, `改短点`, and attachment-only
  continuations see the same channel context as longer ordinary replies.
- Keep selector prompts lightweight with `selector_view`.
- Keep auto-route unable to create tasks, workflows, approvals, or memory authority
  changes.
- Record used-memory audit events exactly as before.

### Tests

- Short follow-up resolves against the previous topic.
- Attachment-dependent ordinary reply uses materialized input when available.
- Selector and final reply do not diverge on active work state.
- Ordinary reply does not include raw route internals or full logs.
- Memory usage events still record memory ids, channel id, teammate id, response id, and
  recall query.

### Acceptance

- The user never sees "no reply" solely because a message is short or contextual.
- The default visible author remains Ling Agent/coordinator unless a deliberate
  specialist-visible reply path is chosen.
- Context inspect metadata remains optional and compact.

## C5: Workflow Proposal And Step Migration

Type: daemon workflow migration.

### Goal

Move proposal generation and workflow step execution context onto Context Views without
changing workflow/run state machines.

### Suggested files

```text
packages/daemon/src/features/channels/ai-proposals.ts
packages/daemon/src/features/channels/proposal-workflows.ts
packages/daemon/src/features/channels/orchestrator.ts
packages/daemon/src/features/channels/workflow-step-packets.ts
packages/daemon/src/features/channels/context-packs.ts
```

### Work

- Build proposals from `workflow_proposal_view`.
- Build step runner packets from `workflow_step_view`.
- Convert dependency outputs into packet summaries and source refs before prompt use.
- Keep approval requests and run permissions outside Context Processing.
- Preserve workflow selector decisions as evidence/source refs, not prompt internals.

### Tests

- Proposal generation includes current user goal, materialized inputs, and active
  channel decisions.
- Workflow step context includes dependency output packets, not raw branch transcripts.
- Failed command evidence contributes exit code, concise error, tail, and artifact refs.
- Retry step context includes the relevant failure summary without replaying full logs.

### Acceptance

- No workflow state machine migration is required.
- Workflow evidence remains expandable after terminal state.
- Context Processing does not auto-start work by itself; it only prepares context for
  the existing orchestration path.

## C6: Log And Evidence Filtering

Type: daemon evidence policy.

### Goal

Centralize how logs, command output, artifacts, and workflow evidence become prompt-safe
sources.

### Suggested files

```text
packages/daemon/src/features/channels/context-processing/evidence.ts
packages/daemon/src/features/channels/context-processing/evidence.test.mjs
```

### Rules

- Successful commands default to command name, exit code, changed-file summary, and
  artifact refs.
- Failed commands may include concise error summary and bounded stderr tail.
- Full stdout/stderr remains in durable artifacts and evidence inspect surfaces.
- Provider secrets, environment variables, tokens, and credential-adjacent strings are
  redacted before any prompt section.
- Repeated runtime heartbeats and route JSON are dropped from ordinary views.

### Tests

- Large stdout is replaced by summary and artifact ref.
- Failed stderr tail is bounded and redacted.
- Secret-like strings are not present in rendered prompt text.
- Evidence inspect view can include selected raw snippets only when policy allows it.

### Acceptance

- Normal replies do not become log replays.
- Evidence remains durable and inspectable on demand.
- Web default conversation UI does not gain new diagnostic rows.

## C7: Context Condenser

Type: daemon compaction policy.

### Goal

Add a condenser that can replace older or oversized sources with summaries/source refs
before provider context limits are exceeded.

### Suggested files

```text
packages/daemon/src/features/channels/context-processing/condenser.ts
packages/daemon/src/features/channels/context-processing/condenser.test.mjs
```

### Work

- Reuse existing provider budget estimation from Context Budget Manager.
- Keep current turn, approval/safety boundary, and active protocol immutable.
- Compact older visible conversation into temporary or durable channel summaries.
- Compact workflow dependency outputs into packet summaries.
- Compact long logs into error summary, tail, and artifact refs.
- Report dropped source ids and compaction ids for inspect surfaces.

### Storage boundary

Default first slice should prefer temporary in-request summaries. Durable summaries can be
written only through existing channel-summary or artifact mechanisms when already
available and auditable.

### Tests

- Current turn is never dropped.
- Channel protocol and teammate persona are never rewritten by compaction.
- Oversized logs are summarized before conversation history is dropped.
- `no-tools context-length retry` uses the same condenser policy.

### Acceptance

- Prompt size can be reduced without losing source attribution.
- The condenser does not mutate active memory or approval policy.
- Ordinary UI does not expose token counts by default.

## C8: Memory Use Isolation

Type: daemon memory policy.

### Goal

Separate "memory can be recalled for this agent" from "memory can be publicly quoted in
this surface".

### Suggested files

```text
packages/daemon/src/features/channels/context-processing/memory.ts
packages/daemon/src/features/channels/context-processing/memory.test.mjs
```

### Policy

| Memory scope | Recall eligibility | Public quote eligibility |
| --- | --- | --- |
| Workspace | Relevant workspace/channel/task views | Usually public if sensitivity allows. |
| Channel | Same channel or linked task/run | Public in that channel if sensitivity allows. |
| Teammate private | Owning teammate only | Influence-only by default in public channel. |
| Task/run | Linked workflow/run/step | Public only through task/run evidence rules. |
| Secret-adjacent | Review/health surfaces only | Never in ordinary prompt text. |
| Candidate | Review policy only | Not public until promoted/accepted. |

### Work

- Convert recalled memory into `ChannelContextSource` values with `sensitivity` and
  `quotePolicy`.
- Update prompt rendering so `influence_only` memory is not instructed to be quoted.
- Preserve existing used-memory audit events.
- Do not add a "memory off" toggle; memory remains enabled by default per teammate.

### Tests

- Ling Agent can use relevant workspace/channel memory in ordinary replies.
- Private teammate memory does not appear verbatim in public channel prompt sections.
- Secret-adjacent memory is excluded from ordinary Context Views.
- Used-memory audit events still include source ids and policy version.

### Acceptance

- Memory isolation remains per workspace/channel/teammate/task/run.
- Public channel replies do not leak private teammate memory excerpts by default.

#### C8A: Memory Eligibility Policy

Status: first implementation slice.

Goal: make `ChannelContextSource(kind="memory")` policy explicit before changing recall,
prompt rendering, storage, or Web surfaces. The first slice encodes whether a memory source
is usable as public quote, influence-only context, inspect-only evidence, or excluded from a
view.

Scope:

- Add a daemon-local memory eligibility module under
  `packages/daemon/src/features/channels/context-processing/memory.ts`.
- Classify memory sources by view kind, consumer teammate, source sensitivity, and
  source metadata such as `quotePolicy` or `publicQuoteEligible`.
- Route `sourceDropReasonForView` through this module for memory sources while preserving
  existing source filtering behavior.
- Cover Ling channel, private chat, specialist/workflow, selector/proposal, and evidence
  inspect views with daemon tests.

Non-goals:

- No DB schema migration.
- No memory recall ranking or storage changes.
- No prompt renderer migration yet.
- No Web UI change or new visible memory debug surface.
- No "memory off" switch; teammate memory remains enabled by default.

Policy detail:

| View | Public/channel memory | Private teammate memory | Secret-adjacent memory |
| --- | --- | --- | --- |
| Ling channel | Public quote unless metadata downgrades to influence-only. | Excluded from the public channel view. | Excluded. |
| Private chat | Influence-only for the owning teammate. | Influence-only only when `consumerTeammateId` matches. | Excluded. |
| Workflow/specialist step | Influence-only for the assigned teammate or step consumer. | Influence-only only when `consumerTeammateId` matches. | Excluded. |
| Selector/proposal | Excluded; selector/proposal should not route on raw memory excerpts. | Excluded. | Excluded. |
| Evidence inspect | Inspect-only. | Inspect-only. | Inspect-only. |

Acceptance:

- Public/channel memory can stay in `ling_agent_channel_view`.
- Private teammate memory is retained only for matching private/specialist/workflow
  consumers.
- Selector/proposal views do not include raw memory.
- Secret-adjacent memory is excluded from ordinary context views.
- Evidence inspect can keep memory metadata for explainability without making it ordinary
  prompt text.

#### C8B: Channel Reply Prompt And Audit Hardening

Status: second implementation slice.

Goal: use the C8A eligibility policy in the real ordinary channel reply path before
broader private-chat/task-run migration.

Scope:

- Convert recalled memory items into `ChannelContextSource(kind="memory")` values with
  source refs, sensitivity, scope metadata, score, matched terms, and quote policy hints.
- Render ordinary channel reply memory prompts from view-eligible memory only.
- Keep same-teammate private memory recallable for private/specialist/workflow views, but
  exclude it from `ling_agent_channel_view` prompt text.
- Record used-memory events only for memory ids that actually entered the prompt, and
  include both the recall policy version and memory-use-isolation policy version in the
  audit policy string.

Non-goals:

- No recall ranking change.
- No DB schema change for used-memory events.
- No private direct-message migration yet; that belongs to C10.
- No UI surface or debug row.

Acceptance:

- `/memory/recall` can still show scoped same-teammate private memory when allowed by
  recall policy.
- A public channel AI reply prompt does not include private teammate memory text.
- The used-memory audit event for a public channel reply contains only memory ids that
  entered the prompt.
- The used-memory audit `policyVersion` includes `memory_use_isolation_v1`.

## C9: Inspect Metadata And Web Surfaces

Type: daemon metadata plus Web optional details.

### Goal

Expose enough context evidence for debugging and user trust without adding default UI
noise.

### Suggested files

```text
packages/daemon/src/features/channels/workflow-coordination-routes.ts
apps/web/src/lib/workflow-progress.ts
apps/web/src/lib/channel-activity-drilldown.ts
apps/web/src/features/workspace/WorkspaceClientView.tsx
```

### Work

- Persist or expose safe metadata for route decisions and workflow evidence:
  context view kind, section ids, dropped ids, source-ref counts, compaction ids,
  provider/model ids when already stored.
- Keep raw prompts, hidden prompts, private chat content, provider secrets, and raw
  artifact bodies out of ordinary metadata.
- Render metadata only in explicit inspect/evidence/details surfaces.

### Tests

- Default conversation feed does not show section ids, token budgets, selector scores,
  or route JSON.
- Inspect/details can show compact section/source metadata.
- Mobile layout keeps evidence details behind explicit expansion.

### Acceptance

- The UI stays product-oriented by default.
- Developers can still inspect why a reply/workflow saw particular sources.

## C10: Direct Message And Private Chat Context

Type: daemon follow-up slice.

### Goal

Bring teammate direct messages and Ling Agent private chat onto the same Context View
model without making private chat part of public channel context.

### Suggested files

```text
packages/daemon/src/features/teammates/direct-messages.ts
packages/daemon/src/features/channels/context-processing/views.ts
```

### Work

- Build `private_chat_view` for teammate DMs.
- Include teammate persona, private thread history, and teammate private memory.
- Allow explicit referenced channel/workflow/task refs to enter as source refs.
- Do not implicitly promote private chat into channel summaries.

### Tests

- Private chat does not see unrelated channel history by default.
- Explicitly referenced channel work can be summarized into private chat context.
- Private memory remains scoped to the teammate.

### Acceptance

- Ling Agent can be private-chatted like a protected teammate.
- Private conversations do not leak into channel context unless explicitly referenced or
  promoted through an approved flow.

#### C10A: Direct Reply Memory Context View

Status: first direct-message implementation slice.

Goal: make teammate direct replies use the same memory eligibility and audit contract as
channel replies, without expanding the visible private-chat product surface.

Scope:

- Render direct-reply memory through `private_chat_view`.
- Keep same-teammate private memory eligible for the private prompt.
- Keep unrelated teammate memory and channel-scoped memory out of direct replies unless a
  later explicit reference/promotion flow adds source refs.
- Record used-memory events only for memory ids that actually enter the private prompt.
- Include `memory_use_isolation_v1` in direct-reply used-memory audit policy strings.

Non-goals:

- No direct-message attachment materialization migration; that remains M5b.
- No new private-chat Context View API or Web surface.
- No implicit channel history import.
- No memory storage or recall ranking changes.

Acceptance:

- A teammate private reply can use same-teammate private memory.
- A teammate private reply does not use another teammate's private memory.
- A teammate private reply does not use channel-scoped memory by default.
- Used-memory audit for direct replies includes only rendered memory ids and the memory
  isolation policy version.

## C11: Browser And E2E Acceptance

Type: Web/e2e verification.

### Goal

Verify product behavior, not internal debug details.

### Suggested tests

```text
apps/web/e2e/channel.spec.ts
```

### Scenarios

- A short follow-up after a previous channel topic produces a contextual Ling reply.
- A current-turn PDF/DOCX/text/image attachment is treated as conversation material when
  materialized.
- An active workflow follow-up sees the active work state.
- A completed workflow shows final report and expandable evidence, not raw process spam.
- Context inspect/details are hidden until opened.
- Mobile viewport does not expose diagnostic rows by default.

### Acceptance

- Product UX matches "one Ling Agent session" from the user's perspective.
- Context metadata is available only after explicit expansion.
- No browser test asserts raw prompt text.

## C12: Provider Capability Auto-Detection

Type: provider settings plus daemon budget resolver.

### Goal

Make automatic compaction feel like the default product behavior. Users should not have
to type context-window and max-output-token values for normal model setup, but the
runtime still needs effective per-model budgets before each Context View is rendered.

### Suggested files

```text
packages/core/src/provider-types.ts
packages/core/src/provider-templates.ts
packages/daemon/src/features/providers/schemas.ts
packages/daemon/src/features/providers/routes.ts
packages/daemon/src/features/channels/context-packs.ts
apps/web/src/features/providers/ProviderSettings.tsx
apps/web/src/lib/providers.ts
```

### Work

- Treat `contextWindow` and `maxTokens` as optional user overrides, not required setup
  fields.
- Add or derive a `ProviderModelCapabilitySnapshot` for effective runtime budgeting:
  registry/template value, provider metadata, health-check result, user override,
  runtime-observed downgrade, or conservative default.
- Show model capability state in Model Workbench as `Auto`, `Estimated`, `Conservative`,
  or `Custom override`.
- Move token inputs into an Advanced section and label them as overrides.
- Keep existing API fields backward-compatible so existing presets continue to load.
- Do not silently overwrite user override fields when health checks or runtime errors
  learn better capabilities.
- Feed the effective snapshot into Context Budget Manager for each Context View.

### Budget behavior

| Capability source | Budget mode | Behavior |
| --- | --- | --- |
| user override | `model_known` | Use the explicit override and mark the UI `Custom override`. |
| model registry/template | `model_known` | Use known values automatically. |
| provider metadata/check | `model_known` or `model_estimated` | Use detected values when confidence is high; otherwise reserve conservatively. |
| runtime observed context-length error | `model_estimated` | Lower effective budget for future calls; do not mutate user config. |
| no data for custom provider | `model_unknown` | Use small safe budget and compact early. |

### Tests

- Creating a custom provider with blank context/max-token fields succeeds.
- Known templates show automatic capability state without requiring manual token input.
- Advanced override values still produce `model_known` budgets.
- Unknown OpenAI-compatible providers resolve to `model_unknown` and compact early.
- A simulated context-length error lowers effective runtime budget for no-tools retry
  without changing persisted user override fields.
- Web E2E verifies the default sheet does not expose context/max-token inputs until the
  Advanced section is opened.

### Acceptance

- Model Workbench does not make users hand-enter token limits by default.
- Runtime budgeting remains deterministic and auditable.
- Multi-agent turns can resolve different budgets for Ling Agent, selectors,
  specialists, workflow steps, and condenser calls.
- Provider capability detection never grants tool permissions or changes approval policy.

#### C12A: Capability Snapshot Contract

Status: detailed implementation slice.

Goal: introduce one effective capability shape that runtime budget code can consume
without treating persisted provider override fields as required setup.

Contract:

```ts
type ProviderModelCapabilitySource =
  | "user_override"
  | "model_registry"
  | "provider_template"
  | "provider_metadata"
  | "health_check"
  | "runtime_observed"
  | "conservative_default"
  | "non_chat";

type ProviderModelCapabilityConfidence = "known" | "estimated" | "conservative";

interface ProviderModelCapabilitySnapshot {
  readonly chatEligible: boolean;
  readonly providerPresetId?: string;
  readonly providerKind?: ProviderKind;
  readonly providerApi?: ProviderApi;
  readonly modelId?: string;
  readonly source: ProviderModelCapabilitySource;
  readonly confidence: ProviderModelCapabilityConfidence;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly tokenizer: "openai-compatible" | "anthropic-compatible" | "estimated";
  readonly supportsStructuredOutput: boolean;
  readonly observedAt?: string;
  readonly reason?: string;
}
```

Resolution priority:

1. Explicit user override fields on `ProviderPreset`.
2. Runtime-observed downgrade for the same provider/model if newer than the base source.
3. Model registry or bundled provider template values.
4. Provider metadata or successful health-check capability data.
5. Known-provider family estimates.
6. Conservative defaults for unknown OpenAI-compatible/custom providers.

Rules:

- user overrides are never overwritten by detection or runtime observations;
- runtime observations can reduce effective limits but cannot increase above a user
  override;
- bundled template capability should only promote a provider to `known` when the
  configured provider/model still matches the template identity; custom model ids fall
  back to provider-family estimates or conservative defaults;
- every prompt-producing path stores enough budget metadata to explain which source won;
- media-only providers skip chat context budgeting and should return an explicit
  non-chat capability state to UI callers instead of fake chat limits. The non-chat
  state uses `chatEligible: false`, `source: "non_chat"`, and omits chat budget token
  values.

Acceptance:

- blank `contextWindow` and `maxTokens` remain valid persisted provider values;
- `resolveProviderModelCapabilitySnapshot` returns a deterministic snapshot for
  configured, template, and unknown providers;
- snapshot source/confidence can map directly to Model Workbench labels:
  `Auto`, `Estimated`, `Conservative`, and `Custom override`.

#### C12B: Budget Resolver Integration

Status: detailed implementation slice after C12A.

Goal: feed the capability snapshot into Context Budget Manager and Context Pack builders
without changing prompt text or permissions.

Scope:

- replace direct `providerPreset.contextWindow/maxTokens` reads in
  `resolveProviderContextCapabilities` with capability snapshot resolution;
- expose `capabilitySource` and `capabilityConfidence` in context budget metadata for
  inspect surfaces;
- use smaller reserved output for selectors and larger defaults for workflow/condenser
  calls through the existing `ContextPackKind`;
- keep existing context-window constants as fallback values only;
- keep `ContextBudgetMode` compatibility:
  - `known` source -> `model_known`;
  - `estimated` source -> `model_estimated`;
  - `conservative_default` -> `model_unknown`.

Non-goals:

- no new LLM call to estimate budgets;
- no automatic retry loop change;
- no prompt copy rewrite;
- no UI token counters in default channel feed.

Acceptance:

- channel replies, selectors, private replies, workflow proposals, workflow steps, and
  condenser calls all use the same snapshot resolver;
- existing context-pack tests continue to pass;
- inspect payload can explain budget source without exposing raw provider secrets.

#### C12C: Runtime-Observed Downgrade

Status: detailed implementation slice after C12B.

Goal: handle provider context-length failures by lowering future effective budgets for
the same provider/model without mutating user configuration.

Trigger:

- provider call fails with a classified context-length/token-limit error;
- failure occurs after Context Processing has built a prompt or context pack;
- provider/model identity is known.

State:

- first slice may keep observations in daemon-local memory for the running process;
- durable observation storage is optional and should be added only when repeated
  restart loss becomes a real product issue;
- observed records should include provider preset id, model id, previous effective
  context window, new effective context window, failure code, and timestamp.

Policy:

- downgrade only, never upgrade from runtime error handling;
- cap the new context window conservatively, for example 75% of the estimated attempted
  input plus reserved output, rounded down;
- expire observations after a bounded period or provider edit;
- user override remains authoritative, but no-tools retry may still compact more
  aggressively for that single failing request.

Acceptance:

- a simulated context-length error changes the next effective snapshot source to
  `runtime_observed`;
- persisted provider fields remain unchanged;
- no approval, tool, file, network, or memory policy changes.

#### C12D: Model Workbench UX

Status: detailed implementation slice after C12A/C12B.

Goal: keep model setup simple by default and make manual token fields clearly advanced
overrides.

Current baseline:

- token fields already live under `Advanced model limits`;
- empty values are represented as `Auto`;
- UI already has basic labels for `Auto`, `Estimated`, `Conservative`, and
  `Custom override`.

Required polish:

- map the real capability snapshot source/confidence to the visible state instead of
  deriving only from kind/api/manual fields;
- show `Custom override` when either override field is present;
- show `Conservative` for unknown compatible/custom models with no known limits;
- show `Estimated` for known provider families whose exact model limit is not known;
- show `Auto` for registry/template/provider metadata known limits;
- do not show context/max-token inputs in the default form body;
- include short helper copy that these fields are overrides, not required setup.

Acceptance:

- creating a custom OpenAI-compatible provider with blank token fields succeeds;
- selecting a bundled known template shows automatic capability state;
- editing manual limits changes the state to `Custom override`;
- Web E2E opens Advanced before asserting token inputs.

#### C12E: Implementation And Test Slices

Status: detailed implementation plan.

Recommended PR sequence:

1. `C12A-contract`
   - add capability snapshot types/helper in core or daemon-local provider utilities;
   - add unit tests for user override, template known, known-family estimate, and
     unknown conservative defaults.
2. `C12B-budget`
   - wire snapshot resolution into `context-packs.ts`;
   - update context inspect metadata tests for source/confidence.
3. `C12C-observed`
   - add runtime observed downgrade registry and narrow classifier tests;
   - keep persistence out unless the implementation needs restart survival.
4. `C12D-web`
   - connect Model Workbench state to the resolved capability snapshot or an API-exposed
     derived state;
   - add Web E2E for Advanced override visibility.

Validation:

- core/provider capability resolver tests;
- daemon context budget tests for each consumer kind;
- provider settings schema tests for blank token fields and manual override;
- targeted Model Workbench E2E;
- `corepack pnpm --filter @ling-stack/web typecheck`;
- `corepack pnpm --filter @ling-stack/daemon typecheck`;
- `git diff --check`.

## Recommended PR Sequence

| PR | Scope | Risk |
| --- | --- | --- |
| CP0 | Docs and compatibility inventory | Low |
| CP1 | Source collectors behind current Context Pack builders | Low |
| CP2 | View builder and render adapter, no behavior change | Medium |
| CP3 | Reply/selector migration | Medium |
| CP4 | Workflow proposal/step migration | Medium |
| CP5 | Evidence filtering and condenser | Medium-high |
| CP6 | Memory quote policy and audit hardening | Medium |
| CP7 | Inspect metadata/Web details and E2E | Medium |
| CP8 | Provider/model capability auto-detection and advanced overrides | Medium |
| CP9 | Private chat/direct-message context view | Medium |

## Follow-Up Implementation Slices

These are intentionally separate from the collaboration-card UI slices. They should not
be mixed into CCI8/CCI9 because they affect runtime prompt construction, caching, or
developer diagnostics.

### CP10: Daemon Collaboration Card Read Model

Goal: expose a stable daemon-side read model for collaboration cards and final reports
only after the Web-derived model proves stable.

Scope:

- derive from existing proposal/workflow/step/run/approval/artifact records;
- cache only product fields needed by Web/mobile clients;
- invalidate on workflow, step, run, approval, and artifact changes;
- keep Web derivation as compatibility fallback.

Non-goals:

- no new workflow state machine;
- no permission or approval changes;
- no raw prompt/log/context persistence in the card payload.

Detailed design:

The daemon read model should be a product projection, not a new source of truth.

Suggested endpoint shape:

```text
GET /channels/:channelId/collaboration-cards
GET /workflows/:workflowId/collaboration-card
```

Suggested payload:

```ts
interface DaemonCollaborationCard {
  readonly id: string;
  readonly source: "proposal" | "workflow";
  readonly proposalId?: string;
  readonly workflowId?: string;
  readonly title: string;
  readonly objective: string;
  readonly mode: CollaborationTaskCardMode;
  readonly executionMode: "serial" | "parallel" | "mixed";
  readonly participants: readonly CollaborationParticipantView[];
  readonly steps: readonly CollaborationStepView[];
  readonly finalReport?: CollaborationFinalReportView;
  readonly blocker?: string;
  readonly nextAction?: string;
  readonly updatedAt: string;
}
```

Invalidation:

- proposal created/updated/cancelled/accepted;
- workflow created/status updated;
- workflow step status/run/link/summary/blocker updated;
- run terminal state updated;
- approval created/resolved;
- artifact attached to a linked run/step;
- final report packet created/updated if introduced later.

Compatibility:

- Web keeps its local derivation as fallback until daemon projection is proven stable;
- daemon and Web schemas should share labels and mode rules;
- API must not expose raw context section ids, token budgets, route JSON, selector
  scores, or log paths by default.

Acceptance:

- daemon card matches current Web-derived card for active, blocked, completed, and failed
  workflows;
- cache invalidates when step/run/approval/artifact state changes;
- Web can render from daemon payload without changing user-visible behavior;
- no permission grants or approval state transitions are performed by the read model.

### CP11: Full Context Processing Migration

Goal: migrate Ling replies, selectors, proposals, workflow steps, and specialist tasks
onto shared source collectors and context view builders.

Scope:

- source collectors for channel history, durable turns, attachments, links, files,
  workflow evidence, memory, and compacted summaries;
- role-specific views for Ling Agent, specialists, selectors, and condensers;
- model-aware budget planning with graceful compaction;
- strict isolation for private teammate memory.

Non-goals:

- no new `agent_sessions` runtime;
- no hidden cross-channel context transfer;
- no default UI token counters or selector scores.

Detailed design:

The migration should happen by runtime surface, not as a single rewrite.

Shared pipeline:

```text
source collectors
  -> source refs
  -> context sections
  -> model-aware budget planner
  -> compaction / condensation
  -> role-specific context view
  -> prompt/render adapter
```

Collectors:

- channel messages and durable Ling turns;
- topic replies;
- attachments and materialized file/link summaries;
- workflow/proposal/decision/handoff evidence;
- run artifacts and concise terminal summaries;
- channel memory and teammate-private memory with isolation rules;
- compacted channel summaries.

Context views:

| View | Consumer | Includes | Excludes |
| --- | --- | --- | --- |
| `ling_agent_reply` | default Ling replies | recent channel context, user turn, relevant materialized inputs, allowed memories | raw logs, private teammate memory not addressed to Ling |
| `selector` | speaker/route selection | intent signals, mentions, membership, compact channel state | raw attachments, long logs, generated answers |
| `proposal` | executable task proposal | user request, relevant constraints, materialized inputs, channel policy | full channel transcript when summarized context is enough |
| `workflow_step` | specialist execution | objective, scoped step input, dependencies, evidence refs, allowed memory | unrelated channel chatter, other teammate private memory |
| `condenser` | compaction | old context window and source refs | provider secrets, raw private memory unless explicitly allowed |

Budget rules:

- infer provider/model context limits where available;
- use conservative defaults only as internal planner input;
- never require users to configure context window in default provider setup;
- drop/debug metadata must be inspectable, not shown by default.

Migration sequence:

1. Add collector interfaces behind existing Context Pack builders.
2. Build view adapters that emit the same prompt content as today.
3. Migrate ordinary Ling replies.
4. Migrate selector/proposal generation.
5. Migrate workflow-step packets.
6. Add condenser/compaction integration.
7. Add inspect coverage and regression E2E.

Acceptance:

- short follow-up messages resolve against same-channel context;
- attachments/materialized inputs are available to the relevant agent without user asking
  again;
- specialist prompts receive scoped views, not full raw channel history;
- token-heavy logs are summarized or excluded unless specifically relevant;
- memory isolation remains per teammate and per visibility boundary.

#### CP11A: Compatibility Foundation Slice

Status: first implementation slice.

Goal: introduce the shared Context Processing module without changing user-visible
prompt behavior.

This slice deliberately keeps existing builder entry points as the public runtime API:

```text
buildChannelReplyContextPack
buildChannelIntentSelectorContextPack
buildChannelAutoRouteContextPack
buildWorkflowStepContextPack
```

The builders may now construct a daemon-local `ChannelContextView` internally, then adapt
that view back into the existing `ContextPack` shape. This gives the runtime one place to
attach source/view/drop metadata while preserving the current model-call path.

Scope:

- add daemon-local Context Processing contracts and pure helpers;
- add turn, channel-state, recent-conversation, and workflow-step source collectors;
- add a minimal view builder with per-view source filters;
- add a render/adapter helper that converts prompt-visible view sections back into
  `ContextPack` sections;
- migrate current Context Pack builders only through the compatibility adapter.

Non-goals:

- no prompt copy rewrite;
- no proposal/workflow state-machine change;
- no runtime permission or approval change;
- no persistent context cache;
- no UI inspect surface yet;
- no LLM condenser or generated summary.

Acceptance:

- existing `ContextPack` callers continue to receive the same kind of prompt text and
  metadata;
- source ids are stable enough for future inspect surfaces;
- selector/reply/workflow-step paths can be migrated incrementally in later slices;
- tests cover source collection, view filtering, and adapter behavior.

#### CP11B: Reply And Selector Shared Sources

Status: implementation slice after CP11A.

Goal: move reply/selector source collection into `context-processing` so Ling ordinary
reply, intent selector, and auto-route selector see the same channel state, recent
conversation, current turn, and active work metadata.

Scope:

- centralize recent-message source collection outside `context-packs.ts`;
- add active work sources for draft proposals, active workflows, visible workflow steps,
  linked runs, and pending approvals;
- attach active work sources to `ling_agent_channel_view` and `selector_view`;
- keep the existing prompt sections unchanged in this slice;
- keep active work details as source metadata for later inspect/context migration.

Non-goals:

- no new user-facing active-work card;
- no selector prompt copy changes;
- no workflow/proposal generation rewrite;
- no hidden auto-start or permission grant;
- no durable context cache.

Acceptance:

- short reply and selector context builders use the same recent-message source helper;
- active work source refs are present in the view/read model layer without appearing as
  raw logs or route JSON in rendered prompts;
- existing reply/selector behavior tests keep passing;
- new tests cover active work source collection and view filtering.

#### CP11C: Workflow Proposal Context View

Status: implementation slice after CP11B.

Goal: let proposal creation use the shared Context Processing source model for durable
shaping evidence without changing proposal generation heuristics or workflow execution.

Scope:

- add a daemon-local `workflow_proposal_view` builder;
- collect current turn, prior channel context, and active work sources for proposal
  creation;
- convert supported source refs into existing proposal `shaping.sourceRefs`;
- keep attachment/link/file materialization details inside view metadata until a shared
  source-ref contract supports them;
- keep prompt/title/participant/tool derivation unchanged.

Non-goals:

- no LLM proposal generator;
- no new proposal/shaping table;
- no automatic approval or workflow start behavior changes;
- no raw prompt or route JSON persistence;
- no new user-facing debug UI.

Acceptance:

- draft proposals retain source message evidence and can include workflow/run/step refs
  when created as follow-up work;
- materialized current-turn inputs are represented in view metadata without being
  fabricated as protocol source refs;
- existing direct workflow and workflow proposal tests keep passing.

#### CP11D: Workflow Step Context View Extraction

Status: implementation slice after CP11C.

Goal: move workflow-step prompt assembly into the shared Context Processing layer while
preserving the existing `buildWorkflowStepContextPack` runtime API and rendered prompt
behavior.

Scope:

- add a daemon-local `workflow_step_view` builder;
- move workflow runtime boundary, objective, current step, approval gates, dependency
  evidence, selector decisions, handoff intents, and context-summary sections into the
  workflow-step view builder;
- keep the channel collaboration protocol section as a shared compatibility input until
  protocol context is migrated separately;
- keep old `ContextPack` output by adapting prompt-visible view sections back through
  the compatibility wrapper;
- preserve workflow, step, run, artifact, selector-decision, handoff-intent, and
  compaction source refs.

Non-goals:

- no workflow state-machine change;
- no approval or permission behavior change;
- no new runner/session abstraction;
- no UI inspect surface;
- no durable context cache;
- no prompt copy rewrite.

Acceptance:

- workflow-step prompts keep the same section ids, ordering, and user-visible text;
- dependency artifact/run refs remain present in old `ContextPack.sourceRefs`;
- selector decision and handoff intent refs remain present for evidence/audit callers;
- compacted dependency summaries still replace verbose dependency sections when the
  provider budget requires compaction;
- existing workflow orchestration and context compaction tests keep passing.

#### CP11E: Materialized Input And Evidence Sources

Status: implementation slice after CP11D.

Goal: represent attachments, links, workspace file refs, artifacts, and workflow packet
evidence as first-class Context Processing sources without turning the default product UI
into a debug surface or changing prompt text.

Scope:

- collect current-turn materialized inputs from the Ling turn envelope:
  attachments, link previews, and workspace file refs;
- preserve materialization status, content kind, preview availability, truncation state,
  and failure reason as source metadata;
- collect workflow-step evidence from linked run artifacts, context packet artifacts,
  output packet artifacts, and declared dependency output artifact refs;
- keep evidence source text concise and bounded; raw artifact bodies and full logs stay in
  artifact/inspect routes;
- attach materialized input sources to reply, selector, and proposal views;
- attach workflow evidence sources to workflow-step views.

Non-goals:

- no new OCR/PDF/Office/link extraction implementation;
- no raw artifact body reads in Context Processing;
- no prompt copy rewrite;
- no UI inspect drawer;
- no new persistent context cache;
- no permission, approval, or runner behavior change.

Acceptance:

- current-turn attachments, links, and workspace file refs appear as `materialized_input`
  sources with stable refs and bounded text;
- workflow-step context views expose linked artifact/workflow-packet sources for later
  inspect and audit;
- legacy `ContextPack` rendering remains compatible and does not expose raw evidence
  sections by default;
- tests cover materialized input source collection and workflow evidence source
  collection.

#### CP11F: Evidence Filtering Policy

Status: implementation slice after CP11E.

Goal: centralize prompt-safe evidence formatting so command output, logs, artifacts, and
workflow packets share one filtering policy before future condenser and inspect surfaces
reuse them.

Scope:

- add a daemon-local evidence policy module;
- classify workflow context/output artifacts as `workflow_packet` evidence;
- keep normal artifact evidence to metadata summaries and source refs;
- mark log artifacts as secret-adjacent for ordinary views;
- provide bounded command evidence formatting for future runner/log integrations;
- redact secret-like values before any command stderr/stdout tail can become prompt text.

Non-goals:

- no raw artifact body reads;
- no inspect UI;
- no durable evidence cache;
- no workflow state-machine change;
- no runner event-log parser;
- no condenser integration yet.

Acceptance:

- artifact summaries include type/path/size metadata without raw body content;
- failed command evidence may include a bounded, redacted stderr tail;
- successful command evidence omits raw stdout by default and keeps artifact refs;
- existing Context View behavior remains compatible.

#### CP11G: Context Condenser Policy

Status: implementation slice after CP11F.

Goal: add a source-level condenser that can shrink oversized Context View sources and
drop low-priority old evidence before model/provider limits are hit, while keeping active
collaboration boundaries stable.

Scope:

- add a daemon-local condenser policy module under Context Processing;
- protect current-turn, channel-state, active-work, workflow, and workflow-step sources
  from automatic condensation/drop;
- condense oversized old source text into a bounded redacted preview with source refs;
- drop low-priority old sources only for budget reasons and report dropped source ids;
- expose deterministic compaction ids and condenser counts in Context View metadata;
- wire condenser into `buildChannelContextView` behind an explicit opt-in setting.

Non-goals:

- no default prompt behavior change for existing view builders;
- no durable summary writes or channel-summary mutation;
- no replacement of existing workflow dependency packet compaction;
- no runner/session/approval/permission behavior change;
- no UI debug surface or token-count display;
- no LLM summarization call inside the condenser.

Policy:

- immutable boundary sources are retained even when they exceed configured source limits;
- older evidence/artifact/workflow-packet sources are condensed before conversation
  history is dropped;
- when `maxSources` is exceeded, archival/durable evidence is dropped before recent
  conversation and materialized current-turn inputs;
- source refs for kept sources remain attached to the view;
- dropped source ids are retained in `view.dropped` with reason `budget`.

Acceptance:

- current-turn and active-work sources are never condensed or dropped by the condenser;
- long evidence/log-like source text is bounded and secret-like strings are redacted;
- source refs remain present for kept condensed sources;
- condenser metadata records compaction ids, condensed count, and dropped count only when
  explicitly enabled;
- existing workflow context compaction tests continue to pass unchanged.

### CP12: Developer Inspect And Debug Surfaces

Goal: make context/route/budget evidence available on demand without polluting the
default conversation.

Scope:

- explicit inspect actions for workflow step context packs;
- debug-only reply/selector metadata when enabled;
- developer budget diagnostics behind advanced surfaces;
- E2E coverage that default UI stays clean.

Non-goals:

- no default persistence of every ordinary chat reply snapshot;
- no raw logs in product cards;
- no provider secrets or credential-adjacent values in inspect payloads.

Detailed design:

Inspect surfaces should answer developer questions without becoming the product UI.

Surfaces:

- workflow evidence drawer: context pack summaries for workflow steps;
- developer diagnostics panel: budget planner details and source-ref counts;
- explicit "Inspect context" action on advanced/details rows;
- route/selector inspect only when debug evidence is enabled or a decision was suppressed.

Default hidden fields:

- token budget numbers;
- raw context section ids;
- selector scores and route JSON;
- raw prompt text;
- log paths;
- provider secrets;
- private teammate memory body.

Allowed inspect fields:

- source type and human label;
- source count and estimated size;
- kept/dropped section category;
- compaction id or summary title when available;
- model/provider selected for a context view;
- safety/policy reason for excluded sources;
- linked evidence/artifact ids only inside developer surfaces.

UX rules:

- product cards link to evidence/details, not directly to raw debug;
- developer inspect affordances are secondary and visually quiet;
- missing evidence should say what is missing and how the runtime can capture it later;
- failed materialization/context extraction should show a natural summary first, detailed
  reason only in inspect.

Acceptance:

- default channel feed contains no route/debug/token/context ids;
- workflow evidence can show a readable context summary for each step;
- developer view can answer "why did this context get included/dropped?";
- E2E covers both clean default UI and explicit inspect visibility.

#### CP12A: Workflow Context Inspect Payload

Status: first implementation slice for CP12.

Goal: expose a prompt-safe, structured context inspect summary on workflow evidence
responses so developers can answer "what context did this step receive?" without reading
raw prompt text or log artifacts.

Scope:

- derive inspect data from the existing workflow step context packet artifact;
- attach `contextInspect` to each workflow evidence step and workflow-step evidence
  response;
- include product-safe metadata: availability, context artifact id, generated time,
  provider/model ids, budget summary, section ids, source-ref labels, dropped section ids,
  and compaction ids;
- explicitly record that raw prompt text and raw logs are not included;
- keep the existing evidence endpoints and details navigation as the inspect surface.

Non-goals:

- no new default feed/right-panel debug UI;
- no raw prompt section text;
- no raw artifact body/log reads;
- no route JSON or selector score dump;
- no persistent inspect cache;
- no workflow state-machine, runner, approval, or permission behavior change.

Payload rules:

- if no context artifact exists, return `availability=missing_context_artifact`;
- if the artifact exists but cannot be parsed, return `availability=unreadable_context_packet`;
- if the packet exists but lacks a context pack snapshot, return
  `availability=missing_context_pack`;
- if the snapshot exists, return `availability=available` with bounded metadata only;
- source refs include type/id/label because the explicit workflow evidence surface is an
  inspect surface, but raw source bodies remain excluded.

Acceptance:

- workflow evidence includes `contextInspect` for every step;
- available inspect payloads show kept section ids, dropped section ids, compaction ids,
  source-ref count, and budget summary;
- missing/unreadable contexts produce a natural availability state instead of an empty
  object;
- default collaboration cards remain free of raw context/debug fields;
- tests cover available and missing context inspect payloads.

#### CP12B: Web Context Inspect Details

Status: implementation slice after CP12A.

Goal: make the existing explicit workflow evidence/details surfaces consume
`contextInspect` so developers can inspect context inclusion, dropped sections, budget
summary, compactions, and source refs without Web reading raw context packet prompt
sections by default.

Scope:

- update workflow evidence detail rows to prefer `contextInspect` over direct context
  packet snapshots;
- update the existing per-step `Inspect context` disclosure to render `contextInspect`
  when available;
- preserve backward compatibility with older daemons by falling back to the existing
  context packet renderer when `contextInspect` is missing;
- show clear availability states for missing, unreadable, or missing-pack context;
- include a quiet safety row stating raw prompt text/logs/artifact bodies are excluded.

Non-goals:

- no default channel feed or collaboration-card debug rows;
- no new route/API surface;
- no raw prompt text rendering;
- no raw log/artifact body rendering;
- no mobile-specific layout changes;
- no workflow/run/approval state changes.

Acceptance:

- workflow evidence details show context availability, budget summary, kept/dropped
  section ids, source refs, compaction ids, and safety boundary from `contextInspect`;
- the explicit `Inspect context` panel uses the same payload when available;
- older daemon responses without `contextInspect` continue to render the existing packet
  view;
- default collaboration task cards still do not contain raw context/debug fields;
- Web typecheck passes.

## Global Acceptance Criteria

- Ling Agent ordinary replies, selectors, proposals, workflow steps, and specialist task
  packets use shared source collectors where practical.
- Short contextual user turns resolve against the relevant channel context instead of
  being treated as isolated chat.
- Default prompts do not include full raw logs, repeated runtime events, route JSON, or
  raw artifact bodies.
- Failed runs can contribute concise failure context while preserving full evidence in
  artifacts.
- Specialists receive role/task-specific Context Views, not full shared prompt history.
- Private teammate memory can influence only the allowed teammate and is not publicly
  quoted by default.
- Context Processing never grants permissions, starts tools, edits files, mutates memory,
  or changes runner policy.
- Default UI stays clean; inspect/details surfaces carry metadata only on demand.

## Explicit Non-Goals

- No new `agent_sessions` runtime.
- No replacement of workflow/run/approval storage.
- No separate prompt-history table in the first implementation.
- No hidden cross-channel context transfer.
- No automatic publication of private teammate chat into channel context.
- No default UI token counters, selector scores, route internals, or context section
  debug rows.
- No migration away from the embedded Pi library runner.
- No new permission model.

## Open Decisions

- Whether `ChannelContextView` contracts should move to `packages/contracts` after CP2
  or stay daemon-local through CP4.
- Exact provider-class thresholds for recent visible conversation before condenser
  activation.
- Whether durable context summaries should be created during ordinary replies or only
  during workflow/run evidence paths.
- Whether memory public quote eligibility needs a stored field or can derive from
  existing sensitivity/review policy in v1.
- Whether evidence redaction belongs permanently in Context Processing or should migrate
  into the artifact/evidence layer after the first implementation.
