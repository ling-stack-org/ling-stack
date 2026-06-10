# Channel Intent To Workflow Selector

Status: P0-P6 implemented behind deterministic-first boundaries; model-assisted selection remains feature-gated
Date: 2026-06-10

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

The current implementation is deterministic by default and uses Ling-native persistence:

- non-mentioned root channel messages pass through `selectChannelWorkflowIntent` before
  the ordinary auto reply router;
- clear multi-role requests and all-teammates requests create one draft
  `ChannelExecutionProposal`;
- proposal confirmation uses the daemon-owned
  `POST /channel-proposals/:proposalId/confirm-workflow` adapter to create a real
  `ChannelWorkflow` plus ordered `ChannelWorkflowStep[]`;
- draft proposals can be edited in the conversation card before confirmation;
- unclear work-shaped requests create one clarify `ai_reply`, not a proposal/task/run;
- intent decisions are persisted in `channel_intent_decisions`, separate from ordinary
  `channel_message_route_decisions`;
- explicit workflow-start requests become validated prefilled proposals with
  `direct_workflow` intent evidence, but still require the user to click Start;
- model-assisted intent selection is available only behind
  `channels.intentSelector` / `LING_STACK_CHANNEL_INTENT_SELECTOR`, requires strict JSON,
  and falls back to deterministic routing on failure;
- no `ai_reply` is created for that source message;
- Web refreshes channel proposals/workflows after sending or confirming, so visible work
  stays in the existing conversation surface and progress rows.

Implemented examples:

- `Architect 先拆，Engineer 实现，QA 验证` -> one draft execution proposal;
- `所有队友都回复我一下` -> one draft execution proposal, not all visible teammate
  replies.

Implemented slices:

- P1 `workflow_proposal -> WorkflowGraph` adapter, so a proposal can start real
  multi-step channel workflow execution instead of one task run;
- P2 proposal edit before confirmation, including goal, roles, step order, assignee, and
  acceptance criteria;
- P3 `clarify`, so unclear work requests get one teammate question instead of an eager
  proposal or silence;
- P4 independent `channel_intent_decisions` persistence after the workflow adapter makes
  intent evidence more important;
- P5 `direct_workflow` as a validated, prefilled proposal-confirmation path. It must not
  start execution without explicit user confirmation;
- P6 model-assisted intent selector behind feature flag, strict JSON validation, and
  deterministic fallback.

## Product Boundary

The channel remains the user's collaboration space. The default visible output is still
conversation, live progress, compact completed summaries, and expandable evidence.

The intent selector may:

- suppress messages that do not need an AI response;
- route ordinary questions to one selected teammate;
- ask one clarifying question when the task boundary is unclear;
- propose a multi-agent workflow when the user is asking for coordinated work;
- prefill a direct workflow proposal only when the user request is explicit, safe, and
  policy-valid, then wait for confirmation;
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

## Response Language Resolution

Workflow entry should follow Codex's practical language boundary: user-readable text
matches the user's configured/preferred language, while evidence stays in its original
form. This is not a permission policy and not a global translation layer. It is a
lightweight response-language context used when Ling generates new user-facing text.

Resolution priority:

1. explicit runtime override from the current user message or proposal edit, for example
   `用英文回复`, `中文总结`, or an output-language field changed before confirmation;
2. project instruction from `AGENTS.md` or equivalent workspace guidance when it clearly
   requires a response language, for example `All responses must be in Chinese`;
3. channel response-language setting, when the channel intentionally differs from the
   workspace default;
4. workspace/settings response-language preference;
5. `follow_user`, inferred from the source message only when no stronger preference
   exists.

The resolved value should be carried as ordinary execution context, for example:

```ts
type ResponseLanguagePreference =
  | "follow_user"
  | "zh-CN"
  | "en-US"
  | "ja-JP"
  | "ko-KR"
  | "custom";

interface ResponseLanguageResolution {
  readonly language: string;
  readonly source:
    | "explicit_message"
    | "proposal_override"
    | "agents_md"
    | "channel_setting"
    | "workspace_setting"
    | "follow_user";
  readonly preserveEvidenceLanguage: true;
}
```

Apply the resolved language to:

- proposal title/body text that Ling generates;
- clarify questions;
- acceptance criteria, risk summary, and collaboration step summaries generated by the
  selector;
- workflow/run terminal summaries and user-facing progress summaries;
- user-facing final answers from workflow steps.

Do not translate:

- code, file paths, identifiers, command names, API fields, JSON keys, stack traces, test
  names, logs, shell output, tool output, or artifact contents;
- existing channel history, old proposals, old workflow evidence, or committed artifacts.

Workflow confirmation should copy the resolved language from the proposal into
`ChannelWorkflow.metadata`. Step run assembly can then include the language instruction
as part of the scoped run context. The instruction should say what the user-facing output
language is and that evidence stays original; it should not ask the model to rewrite raw
evidence.

Open implementation boundary:

- first slice may support `follow_user`, `zh-CN`, and `en-US` only;
- current implementation stores workspace/channel preferences as first-class fields,
  freezes the resolved proposal language on the proposal, and copies it into
  `ChannelWorkflow.metadata.responseLanguage` on confirmation;
- `AGENTS.md` handling should be conservative. Do not build a natural-language policy
  engine; only carry clear project language instructions into the run context.

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

interface ChannelIntentDecision {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly action: ChannelIntentDecisionKind;
  readonly selectedTeammateId?: string;
  readonly proposalId?: string;
  readonly replyMessageId?: string;
  readonly workflowId?: string;
  readonly reason: string;
  readonly status: "accepted" | "suppressed" | "failed";
  readonly createdBy: "deterministic" | "model";
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
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
| `direct_workflow` | The message explicitly asks to start a safe known workflow. | Create a validated prefilled proposal or confirmation step; start only after explicit user confirmation. |

`direct_workflow` is intentionally narrow. In Ling it does not mean hidden auto-start.
It means the selector is allowed to prefill a known workflow start shape and present it
for confirmation. When in doubt, use `workflow_proposal` or `clarify`.

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
        -> show prefilled confirmation proposal
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
| `开始让 Architect 拆这个 PR，然后 Engineer 改，QA 跑 e2e` | `direct_workflow` or `workflow_proposal` | Direct means prefilled confirmed-start proposal, not no-confirm execution. |
| `帮我 push 合并代码` | `direct_workflow` with confirmation and approvals | May require ship workflow and approval gates; never bypass destructive checks. |

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

The channel intent selector never starts tools itself. P1 moves proposal confirmation
into daemon-owned workflow creation instead of the old Web-side `proposal -> task -> run`
compatibility behavior.

## P1 WorkflowGraph Adapter

P1 replaced the old single-task confirmation path with a daemon-owned adapter:

```text
ChannelExecutionProposal(draft)
  -> user clicks Start
  -> daemon validates proposal, teammates, providers, channel runtime policy
  -> compile ChannelWorkflow + ChannelWorkflowStep[]
  -> mark proposal accepted and link workflow id
  -> existing workflow orchestrator starts eligible first step
```

The adapter uses a side-effecting route rather than overloading PATCH:

```text
POST /channel-proposals/:proposalId/confirm-workflow?cwd=...
```

The response includes the updated proposal, workflow, steps, and optional blocker. Web
then refreshes the channel workflow/proposal/runs surfaces and renders the existing
active work cell.

Compilation rules:

- preserve proposal `title` as workflow title and proposal `prompt` as workflow goal;
- convert each `collaborationSteps[]` item into one `ChannelWorkflowStep`;
- preserve step order for ordered proposals such as `Architect -> Engineer -> QA`;
- use the step teammate as the step assignee, not only the proposal assignee;
- derive `dependencies` so each sequential step depends on the previous step;
- use existing workflow graph compiler/orchestrator types, not a new mini-runner;
- link proposal metadata to the workflow and source message for evidence drilldown;
- never start tools until the existing workflow orchestrator validates the first step.

Validation rules:

- channel must be active;
- proposal must be `draft`, `blocked`, or `run_failed`;
- each step teammate must exist, be active, visible enough for the channel surface, and
  be allowed in the channel or explicitly reported as missing;
- each step provider must pass the same preflight used by task/run startup;
- write/deploy/external-send authority still comes from existing approval policy;
- if a role is unavailable, block the proposal with readable copy instead of silently
  dropping the role. For example: `Architect is disabled or hidden. Enable it or edit the
  proposal before starting.`

Current behavior:

- `confirmChannelExecutionProposal` in Web calls the daemon workflow confirmation route;
- the daemon validates the proposal, compiles workflow steps, links the proposal to the
  workflow, and lets the existing workflow orchestrator start eligible work.

## P2 Proposal Edit UX

Proposal editing belongs in the conversation proposal card, not the right drawer.

The compact card keeps `Start` and `Cancel`, then adds `Edit` while status is `draft` or
`blocked`.

Editable fields:

- goal/title;
- prompt/scope;
- assignee/coordinator;
- ordered collaboration steps;
- step teammate;
- step action;
- step summary;
- acceptance criteria;
- required tools only as derived/read-only unless the user has a stronger tool editing
  surface later.

Editing should use existing `PATCH /channel-proposals/:id` persistence first. It should
not create workflow rows until `Start`.

Role availability behavior:

- active, visible, channel-eligible teammates are selectable;
- disabled/hidden teammates can be shown as unavailable labels when they were detected
  from the original message;
- unavailable roles should not be silently removed from the draft;
- Web may offer a link to AI teammate management, but it should not auto-enable teammates
  from this card.

Acceptance criteria:

- editing a proposal updates the card without creating tasks, runs, workflows, or route
  evidence;
- edited steps preserve order and are what P1 compiles;
- cancelling still leaves the original user message visible.

## P3 Clarify

`clarify` handles work-shaped messages that lack a concrete execution target.

Examples:

| User message | Clarify question |
| --- | --- |
| `让 Architect 拆一下，然后 Engineer 做` | `要拆解和实现的是哪个功能、文件、PR 或问题？` |
| `帮我安排一下几个 agent` | `你希望他们围绕哪个目标协作？` |
| `谁能处理这个？` with no visible artifact/context | `你说的“这个”具体指哪条消息、任务或文件？` |

Clarify output should be one ordinary `ai_reply` authored by the selected default or
coordinator teammate. It is not a proposal and does not create workflow rows.

Clarify should be chosen when:

- multiple roles are mentioned but no goal/artifact can be inferred;
- the user asks to start work but omits target file/branch/PR/task;
- the selector has competing interpretations and no safe default;
- required participant roles are missing and the user's intent depends on those roles.

Clarify must not ask multi-question forms. One concise question is enough.

## P4 Channel Intent Decisions

P0 reuses `channel_message_route_decisions` as suppressed evidence. That is acceptable
for proving behavior, but it mixes ordinary reply routing with workflow-entry intent.

P4 adds a separate intent evidence table:

```sql
CREATE TABLE IF NOT EXISTS channel_intent_decisions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  action TEXT NOT NULL,
  selected_teammate_id TEXT,
  proposal_id TEXT,
  reply_message_id TEXT,
  workflow_id TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Use it for:

- `clarify`, `workflow_proposal`, and `direct_workflow` decisions;
- linking source message -> proposal -> workflow;
- accepted, suppressed, and failed selector outcomes;
- idempotency by `source_message_id`.

Keep ordinary auto-reply decisions in `channel_message_route_decisions`. UI should still
show only accepted outcomes by default.

## P5 Direct Workflow

`direct_workflow` is a high-confidence confirmed-start proposal, not a hidden auto-run.

Trigger examples:

- `开始跑 Architect -> Engineer -> QA，目标是修复频道发送后闪烁`;
- `用 Architect 拆、Engineer 实现、QA 验证这个 PR，开始`;
- `帮我 push 合并代码` when the known ship workflow can be prefilled and approvals are
  available.

Behavior:

1. validate that a known graph shape can be built;
2. prefill proposal steps and target;
3. show the proposal with a stronger CTA such as `Start workflow`;
4. after user confirmation, call the P1 adapter;
5. if validation is incomplete, downgrade to `workflow_proposal` or `clarify`.

No message should directly start a workflow just because it says `开始`. The user
confirmation click is still required.

## P6 Model-Assisted Intent Selector

P6 comes last because deterministic behavior must be proven first.

Enable it only when:

- daemon feature flag is enabled;
- the message is eligible for channel intent selection;
- provider preflight passes.

Model contract:

```ts
interface ModelChannelIntentOutput {
  readonly action: ChannelIntentDecisionKind;
  readonly reason: string;
}
```

Validation:

- parse strict JSON only;
- reject unknown ids, unknown roles, unsafe actions, unavailable teammates, and unsupported
  templates;
- strip confidence values from user-visible UI;
- persist accepted/suppressed evidence;
- fallback to deterministic `single_reply`, `workflow_proposal`, `clarify`, or `no_reply`
  when validation fails.

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
- explicit start command plus known safe template -> `direct_workflow`, after validation
  and user confirmation.

Model-assisted intent selection is available behind policy/feature flag when deterministic
rules produce multiple valid candidates or the channel explicitly enables selector help.

## Evidence

Evidence should be durable but lightweight.

Current persistence:

```sql
CREATE TABLE IF NOT EXISTS channel_intent_decisions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  action TEXT NOT NULL,
  selected_teammate_id TEXT,
  proposal_id TEXT,
  reply_message_id TEXT,
  workflow_id TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Default UI should show only the accepted outcome. Suppressed/failed outcomes, raw JSON,
and prompt text are audit data, not normal conversation content.

## Safety Rules

- The selector output must be parsed as structured JSON and validated before any side
  effect.
- Side effects must be executed only by existing daemon routes/state machines.
- The selector cannot mutate approval policy, provider settings, teammate permissions,
  memory activation, tool scopes, secrets, branch state, or deploy state.
- `workflow_proposal` requires user confirmation before workflow creation.
- `direct_workflow` must still require explicit user confirmation before workflow
  creation.
- `direct_workflow` must downgrade to `workflow_proposal` or `clarify` when target
  artifact, graph template, participant, provider, approval, or policy validation is
  incomplete.
- Model-assisted decisions must be feature-gated and have deterministic fallback.
- Selector evaluation must be idempotent for a source message.

## Implementation Slices

| Slice | Scope | Runtime risk |
| --- | --- | --- |
| P0 | Deterministic workflow-proposal entry for clear multi-role channel messages. Implemented. | Low |
| P1 | `workflow_proposal -> WorkflowGraph` adapter and daemon confirmation route. Implemented. | Medium |
| P2 | Proposal `Edit` UI and validation before confirmation. Implemented. | Medium |
| P3 | `clarify` decision with one coordinator question. Implemented. | Low |
| P4 | Independent `channel_intent_decisions` persistence and source-message idempotency. Implemented. | Medium |
| P5 | `direct_workflow` as validated prefilled proposal plus confirmation. Implemented. | Medium |
| P6 | Model-assisted intent selector behind feature flag and deterministic fallback. Implemented. | Medium |

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
