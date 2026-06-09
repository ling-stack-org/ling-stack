# Channel Auto Reply Router

Status: P0 implemented and validated; later work is message-level route explanation and local auto_route validation
Date: 2026-06-09

Related docs:

- [Channel Workspace Design](channel-workspace.md)
- [Multi-Agent Orchestration P4-P7 Detailed Design](multi-agent-orchestration-p4-p7-detailed-design.md)
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [AI Teammates and Skills](ai-teammates-and-skills.md)
- [AI Teammate Private Workspace](ai-teammate-private-workspace.md)

## Purpose

Channel discussion currently replies only when the user explicitly mentions an AI
teammate. This is safe, but it makes a channel with a default teammate feel silent when
the user asks ordinary questions such as:

```text
What does v0.1 Smoke acceptance mean?
```

This design adds a narrow channel message router:

```text
user channel message
  -> decide reply or no_reply
  -> choose one teammate
  -> create normal ai_reply message
```

It does not replace workflow orchestration and does not create a shared long-context
multi-agent chatroom.

## Current P0 Behavior

The Web composer still derives explicit AI reply requests only from mentions:

```ts
const shouldRequestAi = mentions.some((mention) => mention.kind === "ai-teammate");
```

Then it sends:

```ts
requestAiReply: shouldRequestAi
```

The daemon now applies the channel-level auto reply router after it persists the user
message:

- `@ProductStrategy hello` creates an explicit AI reply and records route evidence with
  `createdBy: "explicit_mention"`;
- `hello` and short acknowledgements create only a local-user channel message plus
  suppressed route evidence;
- `What is the acceptance scope?` creates no AI reply in `mentions_only`;
- the same question creates one ordinary `ai_reply` from the channel default teammate in
  `default_teammate`, if that teammate has a runnable provider;
- the same question can create one ordinary `ai_reply` from the model-selected teammate in
  `auto_route`, only when the daemon feature flag is enabled.

Auto-routed and default-teammate replies pass `proposalMode: "disabled"` and must not
create `ChannelExecutionProposal`, tasks, runs, workflows, branches, or approvals.

## Product Boundary

The auto reply router is a shaping-stage conversation feature.

It may:

- answer ordinary channel questions;
- route a question to the channel default teammate;
- route a question to one selected teammate in `auto_route` mode;
- produce explainable routing evidence;
- reuse the existing `createAiChannelReply` path for ordinary reply generation, with
  proposal extraction explicitly disabled for auto-routed messages.

It must not:

- create tasks;
- start runs;
- start or mutate workflows;
- grant tools, approvals, provider access, secrets, deploy authority, or external-send
  authority;
- activate memory;
- inject hidden prompts into a running Pi session;
- let every teammate speak by default;
- turn ordinary channel discussion into a multi-agent transcript.
- auto-create `ChannelExecutionProposal`, tasks, runs, branches, or workflow steps from an
  auto-routed ordinary reply.

## Relationship To Workflow Selector

Workflow P5 selector and channel auto reply router are related patterns but different
entry points.

| Concern | Workflow selector | Channel auto reply router |
| --- | --- | --- |
| Input | workflow graph, packets, step state | one channel message plus recent channel context |
| Output | selected workflow step, branch, handoff, or teammate evidence | `reply` or `no_reply`, selected teammate |
| Authority | unlock/start existing workflow step through orchestrator | create one ordinary `ai_reply` |
| Side effects | workflow state transition through state machines | channel message only |
| Default implementation | deterministic selector | deterministic channel rules |
| Future model use | model-assisted selector behind policy | model-assisted message route behind policy |

Do not reuse the workflow selector runtime directly for ordinary chat. Reuse only the
pattern: structured decision, validation, durable evidence, and safe fallback.

## Terms

- `defaultTeammateId`: who should normally represent the channel when no teammate is
  explicitly mentioned.
- `defaultProviderPresetId`: which provider/model preset should be used when the
  selected teammate does not have its own provider preset.
- `autoReplyMode`: how a channel decides whether ordinary non-mention messages should
  trigger an AI reply.

Provider resolution stays separate from teammate routing:

```text
selected teammate providerPresetId
-> current explicit run provider, if applicable
-> channel.defaultProviderPresetId
-> workspace selected provider
-> first ready provider
```

## Channel Setting

Add a channel-level mode:

```ts
export type ChannelAutoReplyMode =
  | "mentions_only"
  | "default_teammate"
  | "auto_route";
```

Semantics:

| Mode | Behavior |
| --- | --- |
| `mentions_only` | Current behavior. Only explicit AI teammate mentions trigger a reply. |
| `default_teammate` | Explicit mentions win. Otherwise ordinary reply-worthy messages route to `channel.defaultTeammateId`. |
| `auto_route` | Explicit mentions win. Otherwise the router decides `reply` or `no_reply` and chooses one teammate. |

Default must be `mentions_only` for existing channels and new channels unless the user
changes the setting.

Implementation priority:

- implement `auto_route` first because it is the desired channel behavior;
- keep `mentions_only` as the default and rollback-safe mode;
- keep `default_teammate` in the contract as a deterministic fallback mode, but do not
  block `auto_route` on a separate default-teammate-only release;
- gate `auto_route` until routing evidence, validation, and spam protection are in place.

## P0 Target: Auto Route First

P0 should implement the smallest safe `auto_route` path:

```text
channel autoReplyMode = auto_route
user sends ordinary channel question
-> deterministic suppression and candidate building
-> model-assisted route decision
-> Ling validates selected teammate/provider/policy
-> create one normal ai_reply
-> persist route decision evidence
```

The P0 target is not a free-form agent group chat. It is a message-level model-assisted
selector with one allowed side effect: creating a normal `ai_reply`.

P0 must treat `auto_route` as the first implementation target. `default_teammate` stays
in the contract because it is useful as deterministic fallback and future product mode,
but the implementation should not ship a default-teammate-only behavior and call that the
auto-routing milestone.

### P0 Compatibility Constraints

The current channel reply path can extract a hidden task proposal block and create a
`ChannelExecutionProposal`. That behavior is acceptable for explicit mention replies,
but not for auto-routed ordinary channel replies.

P0 should therefore add an explicit reply option such as:

```ts
type ChannelAiReplyProposalMode = "allow" | "disabled";
```

Rules:

- explicit AI mention keeps the existing proposal behavior unless a later design changes
  it;
- `auto_route` replies must pass `proposalMode: "disabled"`;
- `default_teammate` replies, if implemented in P0, should also default to
  `proposalMode: "disabled"` unless the user explicitly requested an actionable task;
- the AI reply system prompt for auto-routed replies must not ask the model to include
  the hidden `<ling_task_proposal>` block;
- the daemon must not create a `ChannelExecutionProposal` from an auto-routed reply body
  even if the model emits a proposal block anyway.

## Deterministic Default Teammate Mode

`default_teammate` is the deterministic subset of the router. It does not call a routing
model and does not choose among multiple candidates.

Flow:

```text
channel autoReplyMode = default_teammate
user sends ordinary root channel question
-> deterministic suppression
-> validate channel.defaultTeammateId
-> validate teammate membership/status/provider readiness
-> create one normal ai_reply from channel.defaultTeammateId
-> persist route decision evidence
```

Rules:

- explicit AI teammate mentions still win in every mode;
- no explicit mention plus `mentions_only` creates no reply;
- no explicit mention plus `default_teammate` routes only to `channel.defaultTeammateId`;
- if `channel.defaultTeammateId` is missing, disabled, hidden, not a channel member, or has
  no runnable provider, suppress the reply and record route evidence;
- use the same reply-worthy heuristic as `auto_route`;
- suppress short acknowledgements, repeated greetings, AI/system messages, thread replies
  outside P0 scope, and non-active channels;
- create at most one AI reply for the source message;
- use `proposalMode: "disabled"` unless the user explicitly mentioned a teammate and the
  existing explicit-reply path owns the behavior;
- do not create tasks, runs, workflow steps, channel branches, approvals, memory
  activation, or `ChannelExecutionProposal`.

Evidence:

```ts
{
  mode: "default_teammate",
  action: "reply" | "no_reply",
  selectedTeammateId: channel.defaultTeammateId,
  createdBy: "deterministic",
  status: "accepted" | "suppressed" | "failed",
  reason: "Default teammate answered a reply-worthy channel question."
}
```

`default_teammate` does not need the `channels.autoRoute` feature gate because it does
not spend selector-model tokens. It should still be rollback-safe because the default
channel mode remains `mentions_only`, and changing the setting back immediately disables
ordinary-message replies.

### Trigger Rules

Always reply:

- the message explicitly mentions an AI teammate;
- the message has `requestAiReply: true` from an existing client path.

Run `auto_route` when all are true:

- message is authored by `local-user`;
- message kind is `message`;
- message intent is `discuss`;
- message has no explicit AI teammate mention;
- channel `autoReplyMode` is `auto_route`;
- channel has at least one active AI teammate candidate;
- message looks reply-worthy.

Never reply:

- message is authored by `ai-teammate` or `system`;
- message kind is `ai_reply`, `system`, or `task_link`;
- message is in a thread reply panel unless P0 explicitly supports thread replies;
- message is empty after trimming text and attachments;
- message is a short acknowledgement;
- message is a repeated greeting or repeated short prompt in the recent window;
- channel status is not `active`;
- no active teammate candidate remains after validation;
- provider preflight cannot resolve a runnable provider.

### Reply-Worthy Heuristic

P0 should run deterministic suppression before calling a model. The model should not be
called for obvious no-reply cases.

Reply-worthy:

- contains `?` or `？`;
- starts with common ask verbs such as `what`, `how`, `why`, `can`, `should`, `is`,
  `do`, `help`, `explain`, `define`, `summarize`;
- Chinese question markers such as `什么`, `怎么`, `为什么`, `是否`, `能不能`,
  `可以吗`, `是什么`, `怎么做`;
- message has attachments or links plus a question marker;
- message length is above a small threshold and is not a status fragment.

Not reply-worthy:

- `ok`, `okay`, `k`, `yes`, `no`, `thanks`, `done`, `收到`, `好的`, `嗯`, `好`,
  `可以`, `行`, `谢谢`;
- greetings shorter than a threshold, such as `hi`, `hello`, `你好`, `你好?`, when the
  same user has sent a similar greeting recently;
- messages that are only file paths, raw ids, or status fragments.

The goal is not perfect natural language understanding. It is to avoid silence for clear
questions while preventing noisy bot behavior.

### Candidate Builder

Candidate selection must be deterministic before the model sees options.

Inputs:

- active teammates in the channel;
- `channel.defaultTeammateId`;
- teammate role, display name, description, and skill summaries;
- provider readiness;
- channel allowed tools and approval profile summaries;
- recent channel activity only as bounded summary, not raw long context.

Candidate rules:

- explicit AI mention bypasses `auto_route` and chooses that teammate;
- disabled, paused, hidden, or non-member teammates are excluded;
- teammates without a runnable provider are excluded;
- the default teammate is included and marked as preferred when valid;
- no more than a small bounded candidate set should be sent to the model;
- if one candidate remains and the message is reply-worthy, the router may accept a
  deterministic route without a model call if the feature policy allows it.

### Model Route Prompt

The model call must be narrow and JSON-only. It should not receive tool authority,
approval authority, or full run logs.

Prompt ingredients:

```text
System:
You are Ling's channel message router. Decide whether one AI teammate should reply to
the latest user channel message. Return strict JSON only. You cannot create tasks,
start workflows, grant permissions, or ask multiple teammates to speak.

Context:
- channel name and brief
- latest user message
- concise recent-message summary
- candidates with id, label, role, description, skill summary, provider readiness
- policy notes and suppression rules

Return:
ChannelAutoRouteModelOutput JSON
```

Output schema:

```ts
interface ChannelAutoRouteModelOutput {
  readonly action: "reply" | "no_reply";
  readonly teammateId?: string;
  readonly confidence: number;
  readonly reason: string;
  readonly alternativesConsidered: readonly ChannelMessageRouteAlternative[];
}
```

Required behavior:

- choose `no_reply` for acknowledgements, repeated greetings, ambiguous status fragments,
  or messages that do not need AI;
- choose exactly one teammate when replying;
- explain the reason in one short sentence;
- include alternatives considered without chain-of-thought;
- never include hidden prompts, raw reasoning, or permission claims.

### Validation

Ling validates the model output before creating an AI reply:

- JSON must parse and match schema;
- `action=reply` requires a valid `teammateId`;
- selected teammate must be in the candidate set;
- selected teammate must still be active in the channel;
- provider resolution must still pass preflight;
- confidence below threshold becomes `no_reply`;
- invalid output becomes `no_reply` by default;
- optional fallback to the default teammate is allowed only when explicit policy enables
  it and the default teammate is in the valid candidate set;
- model output cannot create tasks, workflows, approvals, tools, credentials, external
  sends, or memory activation.

### Loop And Spam Protection

P0 needs simple guardrails:

- do not auto-reply to AI-authored messages;
- at most one auto reply per source message;
- idempotency key should include `sourceMessage.id` and selected teammate id;
- if a pending or ready AI reply already exists for the source message, do not create a
  second one;
- suppress repeated short greetings within a small recent-message window;
- do not auto-reply when the default teammate has an active pending reply in the same
  channel if runtime semaphore budget is exhausted.

## P0 Evidence Requirement

Because `auto_route` is implemented first, routing evidence is part of P0 rather than a
later polish slice.

Add durable route decisions:

```ts
export type ChannelMessageRouteDecisionStatus =
  | "accepted"
  | "suppressed"
  | "failed";

export type ChannelMessageRouteDecisionCreatedBy =
  | "explicit_mention"
  | "deterministic"
  | "model";

export interface ChannelMessageRouteDecision {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly mode: ChannelAutoReplyMode;
  readonly action: "reply" | "no_reply";
  readonly selectedTeammateId?: string;
  readonly selectedProviderPresetId?: string;
  readonly confidence?: number;
  readonly reason: string;
  readonly alternativesConsidered: readonly ChannelMessageRouteAlternative[];
  readonly status: ChannelMessageRouteDecisionStatus;
  readonly createdBy: ChannelMessageRouteDecisionCreatedBy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelMessageRouteAlternative {
  readonly teammateId?: string;
  readonly label: string;
  readonly score?: number;
  readonly reason: string;
}
```

User-facing route explanation should stay message-level and collapsed by default:

```text
Product Strategy · Default teammate
```

For `auto_route`, show a compact provenance label:

```text
QA · Auto routed
```

For suppressed or failed source messages, expose a small message-level entry point only
when useful:

```text
Not auto-replied
Why no reply?
```

Clicking the entry point may open a small popover anchored to the source message. Do not
send route explanations into the default timeline and do not put ordinary route
explanations in the right drawer. The explanation should translate durable route decision
fields into user-readable copy:

- `accepted`: the selected teammate replied through `Default teammate` or `Auto routed`.
- `suppressed`: Ling decided the message looked like an acknowledgement, note, repeat, or
  otherwise not a request for an AI reply.
- `failed`: Ling could not safely create an auto reply, for example because no runnable
  teammate/provider exists or selector output failed validation.

Keep `confidence`, `alternativesConsidered`, raw selector JSON, prompts, and scoring
payloads as backend/debug evidence only. They are useful for tests and diagnostics, but
they are not ordinary channel UI copy.

`auto_route` should remain feature-flagged until route decisions and suppression behavior
are proven in E2E and daemon tests.

## Data Contract

P0 foundation contract:

```ts
interface Channel {
  readonly autoReplyMode?: ChannelAutoReplyMode;
}

interface CreateChannelInput {
  readonly autoReplyMode?: ChannelAutoReplyMode;
}

interface UpdateChannelInput {
  readonly autoReplyMode?: ChannelAutoReplyMode | null;
}
```

Storage:

```text
channels.auto_reply_mode TEXT NOT NULL DEFAULT 'mentions_only'
```

P0 route decision contract:

```text
channel_message_route_decisions
```

Use a separate table rather than overloading `ChannelMessage` because suppressed
decisions have no AI reply message.

Minimum table shape:

```text
id TEXT PRIMARY KEY
workspace_id TEXT NOT NULL
channel_id TEXT NOT NULL
source_message_id TEXT NOT NULL
reply_message_id TEXT
mode TEXT NOT NULL
action TEXT NOT NULL
selected_teammate_id TEXT
selected_provider_preset_id TEXT
confidence REAL
reason TEXT NOT NULL
alternatives_json TEXT NOT NULL
status TEXT NOT NULL
created_by TEXT NOT NULL
error_message TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

Indexes:

```text
idx_channel_message_route_decisions_source(source_message_id, created_at)
idx_channel_message_route_decisions_channel(channel_id, created_at)
```

Core store API should add:

```ts
createChannelMessageRouteDecision(input, now)
updateChannelMessageRouteDecision(id, input, now)
listChannelMessageRouteDecisions(options)
getChannelMessageRouteDecision(id)
```

`reply_message_id` is optional because suppressed and failed decisions have no reply. If
the AI reply is created after the decision, update the decision once the pending reply
message exists.

## API Contract

Channel create/update:

```text
POST /channels?cwd=...
PATCH /channels/:channelId?cwd=...
```

Accept `autoReplyMode`.

Channel message create:

```text
POST /channels/:channelId/messages?cwd=...
```

Keep existing `requestAiReply` for explicit client behavior. The daemon should derive
auto routing when `requestAiReply` is false.

P0 evidence route:

```text
GET /channels/:channelId/message-route-decisions?cwd=...&sourceMessageId=...
```

or include decision refs in an existing channel message evidence endpoint if that exists
when implementation starts.

## Feature Gate Contract

`auto_route` needs a real gate because it can spend model tokens and create replies
without an explicit mention.

Daemon config should add:

```ts
interface ChannelFeatureConfig {
  readonly autoRoute?: boolean;
}

interface DaemonConfig {
  readonly channels?: ChannelFeatureConfig;
}
```

Resolved default:

```text
channels.autoRoute = false
```

Behavior:

- when disabled, channel create/update should reject or normalize `autoReplyMode:
  "auto_route"` to avoid persisted settings that appear enabled but never run;
- the Web settings surface should hide `auto_route` or show it disabled when daemon
  capabilities say the feature is unavailable;
- test config and local dogfood config may enable it explicitly;
- `mentions_only` behavior must be identical whether the feature flag is enabled or
  disabled.

If the implementation does not yet have a capabilities endpoint for daemon feature flags,
P0 can keep Web `auto_route` hidden and cover the behavior through daemon/API tests first.

## Current Code Entry Points

Current implementation facts to preserve:

- Web root composer currently sets `requestAiReply` from explicit AI teammate mentions in
  `apps/web/src/features/workspace/WorkspaceClientView.tsx`.
- Web thread replies use the same mention-derived `requestAiReply`; P0 should keep thread
  replies out of auto-routing unless explicitly included.
- The daemon creates a local-user `ChannelMessage` first in
  `packages/daemon/src/features/channels/messages.ts`, then calls `createAiReply` only
  when `requestAiReply` is true.
- `createAiChannelReply` in `packages/daemon/src/features/channels/ai-replies.ts` already
  resolves teammate/provider and starts a `channel_ai_reply` work unit.
- `createAiChannelReply` also currently asks for and extracts hidden task proposals; this
  must become opt-in for auto-routed replies as described above.
- Channel create/update parsing lives in
  `packages/daemon/src/features/channels/schemas.ts`.
- Channel storage mapping lives in `packages/core/src/storage/sqlite-run-store.ts`; adding
  `auto_reply_mode` must update insert, update, select, mapping, and migrations together.
- Web form defaults and payload shaping live in `apps/web/src/lib/channels.ts` and
  `apps/web/src/api/channel-payloads.ts`.
- Web contract types are re-exported from `apps/web/src/types.ts`, so the source of truth
  remains `packages/contracts/src/channels.ts`.

The first implementation should add a new channel router module instead of pushing route
logic into the React composer. The Web should continue to send `requestAiReply` only for
explicit mentions; the daemon derives `auto_route` after persisting the user message.

## Daemon Design

Add a narrow module:

```text
packages/daemon/src/features/channels/channel-message-router.ts
```

Suggested API:

```ts
export interface ChannelMessageRouteInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly runnerRegistry: RunnerRegistry;
  readonly secretResolver: SecretResolver;
  readonly config: ResolvedDaemonConfig;
  readonly requestedProviderPresetId?: string;
  readonly requestedTeammateId?: string;
}

export type ChannelMessageRouteResult =
  | {
      readonly action: "no_reply";
      readonly reason: string;
      readonly confidence?: number;
      readonly alternativesConsidered: readonly ChannelMessageRouteAlternative[];
      readonly createdBy: "deterministic" | "model";
    }
  | {
      readonly action: "reply";
      readonly teammateId: string;
      readonly providerPresetId?: string;
      readonly reason: string;
      readonly confidence: number;
      readonly alternativesConsidered: readonly ChannelMessageRouteAlternative[];
      readonly createdBy: "explicit_mention" | "deterministic" | "model";
    };
```

`handleChannelMessagesCollection` flow:

```text
create local-user message
-> if explicit requestAiReply, route as explicit mention and call createAiReply(proposalMode=allow)
-> else routeChannelMessageReply(...)
-> if route.action == reply, call createAiReply(proposalMode=disabled)
-> return { message, aiReply? }
```

Provider resolution should stay in or near the existing reply path. The router chooses a
teammate; the reply path chooses the runnable provider from teammate/channel/workspace
policy.

Router model calls:

- should not call workflow selector code;
- should not create a task/run/workflow work unit for the route decision itself;
- may reuse the registered runner adapter with `tools: []` and a router-only prompt if
  that is the smallest current integration path;
- must persist route evidence before returning, whether the model accepts, suppresses, or
  fails;
- must bound prompt context to the latest source message, compact recent message summary,
  channel brief, and candidate summaries.

The reply work unit remains `channel_ai_reply`. The router decision is evidence, not a
runtime execution unit, unless a later observability design introduces a dedicated
`channel_auto_route_decision` work unit kind.

## Web Design

Channel Settings should show:

```text
Auto reply
[Mentions only]
[Default teammate]
[Auto route]
```

Labels:

- `Mentions only`: AI replies only when explicitly mentioned.
- `Default teammate`: unanswered channel questions go to the default teammate.
- `Auto route`: Ling chooses whether and who should answer.

UX rules:

- if `default_teammate` is selected with no default teammate, show an inline blocker;
- if `auto_route` is feature-disabled, show it as unavailable or hidden;
- do not add a composer mode switch;
- do not add visible instructional text to the main channel feed;
- route explanation is message-level and lightweight, not a right-drawer drilldown;
- do not expose confidence numbers, raw selector JSON, or candidate scoring in ordinary
  channel UI.

## Implementation Slices

P0 implementation shipped in this order:

1. Contract/storage for `autoReplyMode` and route decisions.
2. Deterministic router and evidence persistence with no model call.
3. Proposal-disabled AI reply path and idempotency guard.
4. Model-assisted route call behind `channels.autoRoute`.
5. Web settings and mock daemon support.
6. E2E and daemon tests.

The composer remains mention-driven. Ordinary-message routing is daemon-side policy after
message persistence, which keeps rollback simple and keeps explicit mention behavior
separate from auto-routing behavior.

### P0-A Contract And Storage

Files:

- `packages/core/src/workspace-types.ts`
- `packages/core/src/run-types.ts`
- `packages/contracts/src/channels.ts`
- `packages/core/src/storage/sqlite-run-store.ts`
- `packages/daemon/src/features/channels/schemas.ts`
- `packages/api-client/src/client.ts`

Implemented:

- add `ChannelAutoReplyMode`;
- add `autoReplyMode` to channel types;
- add SQLite column and migration defaulting to `mentions_only`;
- parse create/update payloads;
- return `autoReplyMode` in channel responses.
- add route decision types and store method contracts, even if the evidence API is wired
  in P0-C.

Validation:

- create/update rejects unknown modes;
- existing channels read as `mentions_only`;
- clearing mode returns to `mentions_only`.

### P0-B Deterministic Router

Files:

- `packages/daemon/src/features/channels/channel-message-router.ts`
- `packages/daemon/src/features/channels/messages.ts`
- `packages/daemon/src/features/channels/ai-replies.ts` if idempotency needs tightening
- daemon route/store tests under the existing daemon/core test pattern

Implemented:

- keep explicit mentions behavior unchanged;
- suppress obvious `no_reply` messages before model calls;
- build and validate teammate candidates for `auto_route`;
- route non-mention questions to `defaultTeammateId` when mode is `default_teammate`,
  if that mode is included in the same slice;
- suppress short acknowledgements, repeated greetings, AI/system messages, and invalid
  teammates;
- avoid duplicate replies for the same source message.
- return a route result without calling the model while P0-C evidence storage is being
  wired; this makes the deterministic layer independently testable.

Validation:

- explicit mention still replies;
- ordinary question does not reply in `mentions_only`;
- ordinary question enters auto-route only in `auto_route`;
- ordinary question replies through `default_teammate` only when that mode is enabled;
- short acknowledgement does not call the model;
- repeated greeting does not call the model or create repeated AI replies;
- AI reply message does not trigger another reply.

### P0-C Route Decision Store

Files:

- `packages/core/src/workspace-types.ts`
- `packages/core/src/run-types.ts`
- `packages/contracts/src/channels.ts`
- `packages/core/src/storage/sqlite-run-store.ts`
- `packages/daemon/src/features/channels/channel-message-router.ts`
- `packages/daemon/src/features/channels/routes.ts` or a dedicated evidence route module
- `packages/daemon/src/server/router.ts`
- `packages/api-client/src/client.ts` if the Web consumes the evidence route in P0

Implemented:

- add `channel_message_route_decisions`;
- persist explicit mention, deterministic suppression, deterministic route, model route,
  model suppression, and failure decisions;
- include selected teammate, selected provider, confidence, reason, and alternatives;
- keep raw model payload out of the main feed.

Validation:

- a suppressed message still has inspectable decision evidence;
- an accepted route links to the source message and selected AI reply;
- invalid model output is recorded as failed or suppressed.

### P0-D Model-Assisted Auto Route

Files:

- `packages/daemon/src/config.ts`
- `packages/daemon/src/context.ts` only if route dependencies need a new context shape
- `packages/daemon/src/features/channels/channel-message-router.ts`
- `packages/daemon/src/features/channels/messages.ts`
- `packages/daemon/src/features/channels/ai-replies.ts`

Implemented:

- feature-flag `auto_route`;
- add `proposalMode` or equivalent to `createAiChannelReply` and disable proposal
  extraction for auto-routed replies;
- build bounded prompt context from the source message, recent summary, channel brief,
  teammate candidates, and policy notes;
- request strict JSON output;
- validate structured output;
- create one AI reply only after validation;
- fail closed to `no_reply` on invalid output unless fallback policy explicitly allows a
  valid default teammate fallback.

Validation:

- model-selected teammate creates one AI reply;
- `no_reply` model output creates no AI reply;
- invalid JSON creates no AI reply and records evidence;
- low confidence creates no AI reply;
- unknown teammate creates no AI reply;
- selected teammate without runnable provider creates no AI reply.
- auto-routed reply body containing a proposal block does not create a
  `ChannelExecutionProposal`.

### P0-E Web Settings

Files:

- `apps/web/src/features/workspace/WorkspaceClientView.tsx`
- `apps/web/src/types.ts`
- `apps/web/src/lib/channels.ts`
- `apps/web/src/api/channel-payloads.ts`
- `apps/web/src/i18n.tsx`
- API/client channel form helpers as needed
- `apps/web/e2e/support/mock-daemon.ts`

Implemented:

- add `autoReplyMode` to channel form state;
- render setting in right drawer channel settings;
- allow `auto_route` when feature flag is enabled;
- keep default `mentions_only`;
- show route mode as channel-level behavior, not composer mode.

Validation:

- changing mode persists after refresh;
- `auto_route` unavailable state is clear when feature-disabled;
- composer behavior remains unchanged for explicit mentions.

### P0-F E2E

Add coverage around the screenshot scenario:

- channel with default teammate and `mentions_only`: ordinary question does not create
  AI reply;
- channel with multiple active teammates and `auto_route`: ordinary question creates one
  AI reply from the model-selected teammate;
- model `no_reply` creates no AI reply;
- invalid model output creates no AI reply and records failure/suppression evidence;
- repeated `hello?` does not call the model or spam several AI replies;
- explicit `@teammate` still replies in every mode.
- auto-routed reply does not create a channel execution proposal, task, run, workflow step,
  or channel branch.

### P1 Default Teammate Mode Polish

The `default_teammate` design is defined above as a deterministic router mode. It may be
implemented with P0 if cheap, but it is not the first product target. If deferred, keep
the remaining work as a follow-up:

- ordinary question replies only in `default_teammate`;
- ordinary question does not reply in `mentions_only`;
- show a blocker when `default_teammate` has no default teammate;
- changing mode persists after refresh;
- channel with default teammate and `default_teammate`: ordinary question creates one AI
  reply from that teammate;

### P2 Message-Level Route Explanation And Local Auto Route Validation

After P0 proves the route behavior:

- expose a compact route explanation entry from the source message or AI reply footer;
- show `Default teammate`, `Auto routed`, `Not auto-replied`, or `Auto reply failed`
  without adding timeline noise;
- open a small anchored popover for the human-readable reason when the user asks why;
- do not use the right drawer for ordinary route explanation;
- do not display selector confidence numbers or raw JSON in ordinary UI;
- validate the local product flow with `LING_STACK_CHANNEL_AUTO_ROUTE=1`: setting becomes
  selectable, a normal message reaches the selector, one teammate replies, and failure
  cases explain themselves at the message level.

Regression coverage should stay pragmatic. Do not build a separate tuning product or
sample dashboard in this slice. When a real message is misclassified, add the minimal
daemon regression test that preserves the corrected boundary.

## Suggested Verification

P0:

```bash
git diff --check
corepack pnpm --filter @ling-stack/contracts build
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon build
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web exec playwright test e2e/runtime.spec.ts --grep "auto reply"
```

P0 should add daemon route/store tests for route decisions and model-output validation.

## Open Questions

- Should `default_teammate` reply to topic replies in the first slice, or only root
  channel messages?
- What is the exact repeated greeting suppression window?
- Should `auto_route` ever choose the channel default teammate as a fallback when model
  output is invalid, or should it always fail closed?
- Should route decisions be attached to message drilldown or conversation work-cell
  evidence first?
