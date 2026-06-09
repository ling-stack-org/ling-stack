# Channel Intent To Workflow Selector

Status: deterministic workflow-proposal entry implemented; direct workflow and model intent selector remain future slices
Date: 2026-06-09

Related docs:

- [Channel Workspace Design](channel-workspace.md)
- [Channel Auto Reply Router](channel-auto-reply-router.md)
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [Multi-Agent Orchestration P4-P7 Detailed Design](multi-agent-orchestration-p4-p7-detailed-design.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)

## Purpose

Ling now has two adjacent but separate selectors:

```text
ordinary channel message
  -> channel auto reply router
  -> maybe one ordinary ai_reply

workflow graph step
  -> workflow selector
  -> next step / branch / handoff
```

The missing layer is the entry selector between them:

```text
ordinary channel message
  -> channel intent selector
  -> no_reply | single_reply | clarify | workflow_proposal | direct_workflow
  -> channel auto reply router or workflow selector entry
```

This layer decides whether a user message should stay as ordinary conversation or become
a workflow-shaped collaboration request. It does not make the channel a group chat and
does not let every teammate answer by default.

## Current Implementation

The first implementation is deterministic and uses existing Ling-native persistence:

- non-mentioned root channel messages pass through `selectChannelWorkflowIntent` before
  the ordinary auto reply router;
- clear multi-role requests and all-teammates requests create one draft
  `ChannelExecutionProposal`;
- the source message gets suppressed route evidence with reason
  `Workflow proposal created from channel intent`;
- no `ai_reply` is created for that source message;
- Web refreshes channel proposals after sending a message, so the proposal appears under
  the sent message in the existing conversation surface.

Implemented examples:

- `Architect 先拆，Engineer 实现，QA 验证` -> one draft execution proposal;
- `所有队友都回复我一下` -> one draft execution proposal, not all visible teammate
  replies.

Not implemented yet:

- separate `channel_intent_decisions` table;
- `clarify` question generation;
- validated `direct_workflow` start;
- model-assisted intent selection.

## Product Boundary

The channel remains the user's collaboration space. The default visible output is still
conversation, live progress, compact completed summaries, and expandable evidence.

The intent selector may:

- suppress messages that do not need an AI response;
- route ordinary questions to one selected teammate;
- ask one clarifying question when the task boundary is unclear;
- propose a multi-agent workflow when the user is asking for coordinated work;
- start a workflow only when the user request is explicit, safe, and policy-valid;
- pass structured workflow intent into the existing workflow graph compiler and selector.

It must not:

- make all teammates speak in the channel;
- create a shared long-context multi-agent transcript;
- expose raw selector JSON, prompts, scoring, or confidence numbers in ordinary UI;
- use the right drawer for ordinary route explanation or proposal explanation;
- let model output grant tools, approvals, provider access, credentials, deploy authority,
  external-send authority, or memory activation;
- execute tools directly from selector output;
- rewrite a running workflow graph;
- replace the existing workflow selector/runtime.

## Borrowed Patterns

Ling should borrow the design pattern, not the runtime.

| External pattern | What to borrow | What not to borrow |
| --- | --- | --- |
| SelectorGroupChat | A selector can choose a speaker or role from agent descriptions and context. | Do not put every agent in one shared long context and rotate visible speakers. |
| Swarm | Handoff should be structured: source, target, reason, payload, acceptance state. | Do not let free-form agent chatter decide authority or side effects. |
| GraphFlow | Work should be graph-controlled: order, parallelism, branch conditions, joins, loops. | Do not let ordinary channel messages bypass Ling's workflow graph/state machines. |

## Decision Contract

The channel intent selector returns a validated structured decision:

```ts
type ChannelIntentDecisionKind =
  | "no_reply"
  | "single_reply"
  | "clarify"
  | "workflow_proposal"
  | "direct_workflow";

type ChannelIntentReasonCode =
  | "explicit_teammate_mention"
  | "acknowledgement_or_closure"
  | "ordinary_question"
  | "channel_state_question"
  | "multi_role_request"
  | "all_teammates_request"
  | "ordered_work_request"
  | "missing_execution_target"
  | "explicit_workflow_start"
  | "policy_or_provider_unavailable"
  | "selector_validation_failed";

interface ChannelIntentDecision {
  readonly id: string;
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly kind: ChannelIntentDecisionKind;
  readonly createdBy: "deterministic" | "model";
  readonly reasonCode: ChannelIntentReasonCode;
  readonly userVisibleLabel?: string;
  readonly selectedTeammateId?: string;
  readonly clarifyQuestion?: string;
  readonly workflowIntent?: ChannelWorkflowIntent;
  readonly alternativesConsidered?: readonly ChannelIntentAlternative[];
  readonly validationState: "accepted" | "suppressed" | "requires_confirmation" | "rejected";
  readonly createdAt: string;
}

interface ChannelIntentAlternative {
  readonly kind: ChannelIntentDecisionKind;
  readonly selectedTeammateId?: string;
  readonly workflowTemplateId?: string;
  readonly reasonCode: ChannelIntentReasonCode;
}

interface ChannelWorkflowIntent {
  readonly goal: string;
  readonly requestedRoles: readonly ChannelWorkflowRequestedRole[];
  readonly suggestedGraphTemplateId?: string;
  readonly suggestedSteps?: readonly ChannelWorkflowIntentStep[];
  readonly requiresUserConfirmation: boolean;
  readonly approvalPolicy: "inherit_channel" | "require_explicit_approval";
}
```

`userVisibleLabel` is short UI copy such as `Auto routed`, `Workflow proposed`, or
`Clarification needed`. It must not contain confidence values.

## Decision Kinds

| Kind | Meaning | Allowed side effect |
| --- | --- | --- |
| `no_reply` | The message is an acknowledgement, social closure, or unrelated note. | Persist the user message; optionally persist suppressed evidence. |
| `single_reply` | One teammate should answer as normal channel conversation. | Use `default_teammate` or `auto_route` to create one normal `ai_reply`. |
| `clarify` | The request is likely work, but the scope is ambiguous. | One teammate asks one clarifying question. |
| `workflow_proposal` | The message asks for coordinated work or multiple roles. | Show a compact proposal in the conversation; wait for confirmation. |
| `direct_workflow` | The message explicitly asks to start a safe known workflow. | Create/start workflow through existing workflow routes, respecting approvals. |

`direct_workflow` is intentionally narrow. When in doubt, use `workflow_proposal` or
`clarify`.

## Routing Flow

```text
persist local-user message
  -> deterministic safety and spam filters
  -> explicit mention handling
  -> channel intent selector
     -> no_reply
     -> single_reply
        -> channel auto reply router
        -> one ordinary ai_reply
     -> clarify
        -> one ordinary ai_reply with a question
     -> workflow_proposal
        -> compact proposal in conversation
        -> user confirms / edits / cancels
        -> workflow graph compiler
        -> workflow selector
     -> direct_workflow
        -> validate policy, participants, graph template, approvals
        -> workflow graph compiler
        -> workflow selector
```

The user message should appear in the channel immediately. While selector and reply work
is pending, Web may show the existing local-only pending row such as `Thinking...`.

## Message Examples

| User message | Decision | Notes |
| --- | --- | --- |
| `好的` / `收到` / `谢谢` | `no_reply` | Do not spend model tokens or create teammate noise. |
| `频道里面都有谁？` | `single_reply` | One coordinator/default teammate can answer. |
| `这个 auto_route 为什么没回复？` | `single_reply` | One teammate explains current channel behavior. |
| `谁能处理这个？` | `single_reply` or `workflow_proposal` | If context is simple, answer. If there is a concrete work artifact, propose workflow. |
| `所有队友都回复我一下` | `workflow_proposal` | Do not make all teammates auto-speak. Convert to collaboration proposal or ask what decision the user wants. |
| `Architect 先拆，Engineer 实现，QA 验证` | `workflow_proposal` | If the artifact/scope is clear enough, proposal can be prefilled. |
| `开始让 Architect 拆这个 PR，然后 Engineer 改，QA 跑 e2e` | `direct_workflow` or `workflow_proposal` | Direct only if target artifact, permissions, and graph template are validated. |
| `帮我 push 合并代码` | `direct_workflow` with approvals | May require ship workflow and approval gates; never bypass destructive checks. |

## Workflow Proposal UX

Workflow proposals stay in the conversation surface, not the right drawer.

The compact proposal should show:

- proposed goal;
- roles/steps, for example `Architect -> Engineer -> QA`;
- whether user confirmation is required;
- primary actions: `Start`, `Edit`, `Cancel`;
- a short reason label such as `Detected multi-step work request`.

When the user starts it:

- active execution uses the existing conversation work cell and progress rows;
- status copy can say things like `Architect is defining implementation boundaries`,
  `Engineer is running step 2`, `QA is validating 2 checks`, `Blocked: waiting for file
  write approval`, or `Done: 3 steps completed, 1 artifact generated`;
- completed work collapses into the normal compact summary;
- selector, handoff, packet, run, approval, and artifact evidence remains expandable from
  the existing evidence surfaces.

Do not add a tuning dashboard, route evidence drawer, confidence badge, or raw decision
viewer to ordinary channel UI.

## Workflow Selector Entry

`workflow_proposal` and `direct_workflow` should pass a normalized intent into the
workflow layer:

```ts
interface ChannelWorkflowSelectorEntry {
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly intentDecisionId: string;
  readonly goal: string;
  readonly requestedRoles: readonly ChannelWorkflowRequestedRole[];
  readonly graphTemplateId?: string;
  readonly constraints: {
    readonly requireUserConfirmation: boolean;
    readonly approvalPolicy: "inherit_channel" | "require_explicit_approval";
    readonly allowedToolScopes: readonly string[];
    readonly allowedProviderPresetIds: readonly string[];
  };
}
```

The workflow layer then:

1. validates the selected teammates and provider readiness;
2. resolves or compiles a `WorkflowGraph`;
3. creates `ChannelWorkflow` / `ChannelWorkflowStep` rows;
4. lets the existing workflow selector choose the next eligible step;
5. records selector and handoff evidence through existing workflow evidence APIs.

The channel intent selector never starts tools itself.

## Deterministic First

The first implementation should be deterministic and conservative:

- explicit AI mention -> `single_reply` to mentioned teammate;
- acknowledgement / very short closure -> `no_reply`;
- question about channel state, teammates, settings, files, context, or current work ->
  `single_reply`;
- contains multiple role names or ordered work verbs such as `先`, `然后`, `验证`,
  `review`, `implement`, `QA` -> `workflow_proposal`;
- asks all teammates to speak -> `workflow_proposal`, not multi-speaker chat;
- missing artifact, branch, file, or acceptance target -> `clarify`;
- explicit start command plus known safe template -> `direct_workflow`, after validation.

Model-assisted intent selection can be added later behind policy/feature flag when
deterministic rules produce multiple valid candidates.

## Evidence

Evidence should be durable but lightweight.

Suggested persistence:

```sql
CREATE TABLE IF NOT EXISTS channel_intent_decisions (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_by TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  selected_teammate_id TEXT,
  workflow_intent_json TEXT,
  alternatives_json TEXT,
  validation_state TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Default UI should show only the accepted outcome. Suppressed, rejected, alternatives, raw
JSON, and prompt text are audit data, not normal conversation content.

## Safety Rules

- The selector output must be parsed as structured JSON and validated before any side
  effect.
- Side effects must be executed only by existing daemon routes/state machines.
- The selector cannot mutate approval policy, provider settings, teammate permissions,
  memory activation, tool scopes, secrets, branch state, or deploy state.
- `workflow_proposal` requires user confirmation before workflow creation.
- `direct_workflow` must downgrade to `workflow_proposal` when target artifact, graph
  template, participant, provider, approval, or policy validation is incomplete.
- Model-assisted decisions must be feature-gated and have deterministic fallback.
- Selector evaluation must be idempotent for a source message.

## Implementation Slices

| Slice | Scope | Runtime risk |
| --- | --- | --- |
| C0 | This design doc and cross-links. | None |
| C1 | Deterministic `ChannelIntentSelector` contract, reason codes, and persistence. | Low |
| C2 | Compact workflow proposal UI in the conversation surface. | Medium |
| C3 | Workflow selector entry adapter to existing graph templates/compiler. | Medium |
| C4 | Model-assisted intent selection behind daemon feature flag and policy validation. | Medium |
| C5 | Evidence polish in existing expandable workflow evidence surfaces. | Low |

## Acceptance Criteria

- Ordinary questions still produce at most one teammate reply.
- `所有队友都回复我一下` never creates multiple visible teammate replies by default.
- Multi-role requests produce a compact proposal before multi-agent work starts.
- Direct workflow starts only happen through validated existing workflow routes.
- Active work uses existing progress rows and completed work collapses into a summary.
- No right-drawer route explanation, tuning dashboard, confidence display, or raw JSON is
  introduced in ordinary channel UI.

## Non-Goals

- Building a multi-agent group chat.
- Replacing `channel-auto-reply-router.md`.
- Replacing the P5 workflow selector.
- Adding model-assisted workflow selection before deterministic intent routing exists.
- Adding a route tuning UI or sample-set dashboard.
- Showing confidence numbers in the channel.
