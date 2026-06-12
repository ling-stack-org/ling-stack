# Ling Agent Session Implementation Plan

Status: implementation plan for the first product-control-plane slices
Date: 2026-06-12

Related docs:

- [Ling Agent Session Control Plane](ling-agent-session.md)
- [Channel Intent To Workflow Selector](channel-intent-workflow-selector.md)
- [Channel Auto Reply Router](channel-auto-reply-router.md)
- [Codex-Like Execution Experience](codex-like-execution.md)
- [Run Interruption And Continuation](run-interruption-continuation.md)
- [Inline Runtime Approval Detailed Design](inline-runtime-approval-detailed-design.md)
- [Thread-First Work History v2 Detailed Design](thread-first-work-history-v2-detailed-design.md)
- [Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md)

## Summary

This plan implements the Ling Agent session model without replacing the existing
workflow, run, approval, thread, or evidence primitives.

Implementation status:

- P1 initial projection helper is implemented in
  `packages/daemon/src/features/channels/ling-agent-session-view.ts`.
- P1 focused daemon tests cover open channel, draft task confirmation, active workflow
  approval wait, terminal workflow final result, and terminal failed run states.
- P2 initial coordinator ordering is implemented in
  `packages/daemon/src/features/channels/messages.ts`.
- P2 active-session handling queues additive follow-up instructions as durable
  `queue_followup` interventions before ordinary routing. Interrupt/redirect language
  returns a `requires_confirmation` active-session action and does not cancel the source
  run until a dedicated UI/endpoint confirms it.
- P3 initial terminal final report projection is implemented without a migration:
  daemon session views derive `finalResult` from workflow steps, linked runs, artifacts,
  and resolved approvals; Web completed workflow cards hide raw proposal/process rows by
  default and keep evidence expandable.
- P4 initial permission UX integration is implemented on the existing proposal and
  approval surfaces: pre-execution cards use permission-oriented task confirmation copy,
  while runtime approvals still resolve through durable `ApprovalRequest` records and do
  not mutate workspace approval policy.
- P5 initial execution is implemented with the built-in `ling_agent` identity for bounded
  single-step tasks when no configured specialist can run. The next profile slice should
  promote this identity into a protected system teammate that appears in roster, channel
  membership, mentions, and private chat.
- P6 initial Web acceptance hardening is implemented in `apps/web/e2e/channel.spec.ts`
  with regression coverage for executable task confirmation, filename-only continuation,
  ordinary chat routing, active run guidance/redirect interventions, inline runtime
  approvals, and terminal final reports.

The first implementation should add a product control-plane read model and route order:

```text
Ling Agent Session View
  -> active-session continuation / approval handling
  -> executable intent detection
  -> auto-start or workflow/task confirmation
  -> ordinary chat routing
  -> terminal final report
```

The goal is to make Ling feel like one coherent agent session while preserving the lower
layers that already enforce state, permissions, runner behavior, and audit.

## Implementation Principles

- Prefer derived views before new tables.
- Keep executable work on the existing workflow/run path.
- Keep permissions on the existing approval path.
- Treat proposal records as auditable task plans, not mandatory user-facing stop signs.
- Keep process details expandable, not default transcript content.
- Make Ling Agent a protected built-in system teammate and default executor identity, not
  a permission authority.
- Make user interjections durable interventions, not hidden prompt injection.
- Ship in narrow slices with daemon tests first, then Web behavior tests.

## Current Code Anchors

| Area | Current anchor |
| --- | --- |
| Channel message entry | `packages/daemon/src/features/channels/messages.ts` |
| Executable/collaboration detection | `packages/daemon/src/features/channels/channel-intent-selector.ts` |
| Ordinary chat routing | `packages/daemon/src/features/channels/channel-message-router.ts` |
| Proposal to workflow confirmation | `packages/daemon/src/features/channels/proposal-workflows.ts` |
| Workflow orchestration | `packages/daemon/src/features/channels/orchestrator.ts` |
| Workflow progress Web model | `apps/web/src/lib/workflow-progress.ts` |
| Conversation work cell Web model | `apps/web/src/lib/conversation-work-cell.ts` |
| Conversation work cell UI | `apps/web/src/shared/conversation/ConversationWorkCell.tsx` |
| Channel workspace UI | `apps/web/src/features/workspace/ChannelTaskWorkspace.tsx` |
| Inline approvals | `apps/web/src/lib/inline-approvals.ts`, `apps/web/src/features/approvals/InlineApprovalStrip.tsx` |
| Run interventions | `packages/daemon/src/features/runs/interventions.ts` |
| Execution actions | `packages/daemon/src/features/runs/execution-actions.ts` |
| Thread/evidence APIs | `packages/daemon/src/features/runs/thread-routes.ts` |

## P1: Session View Projection

### Goal

Add a `LingAgentSessionView` read model that derives one coherent session state from
existing channel messages, proposals, workflows, runs, approvals, interventions, and
thread evidence.

Do not add `ling_agent_sessions` storage in P1.

### Contract

Start with a pure builder that can run in daemon or Web tests:

```ts
type LingAgentSessionViewStatus =
  | "open"
  | "shaping"
  | "ready_for_confirmation"
  | "running"
  | "waiting_for_approval"
  | "reporting"
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled";

interface LingAgentSessionView {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly status: LingAgentSessionViewStatus;
  readonly owner: "ling_agent";
  readonly objective: string;
  readonly activeWorkflowId?: string;
  readonly activeRunId?: string;
  readonly pendingApprovalIds: readonly string[];
  readonly pendingInterventionIds: readonly string[];
  readonly confirmation?: LingAgentConfirmationView;
  readonly progress?: LingAgentProgressView;
  readonly finalResult?: LingAgentFinalResultView;
  readonly evidenceRefs: readonly LingAgentEvidenceRef[];
}
```

Suggested source location:

```text
packages/daemon/src/features/channels/ling-agent-session-view.ts
apps/web/src/lib/ling-agent-session-view.ts
```

Prefer a shared contract in `packages/contracts` only after the shape is proven.

### Derivation Rules

- Draft executable proposal -> `ready_for_confirmation`.
- Non-terminal workflow or run -> `running` or `waiting_for_approval`.
- Pending inline-eligible approval for active run/channel -> `waiting_for_approval`.
- Terminal workflow/run without a final report -> `reporting`.
- Terminal workflow/run with final result -> `succeeded`, `blocked`, `failed`, or
  `cancelled`.
- No active work and no draft proposal -> `open`.

### Daemon Work

- Add a pure projection helper.
- Add focused tests for proposal, active run, waiting approval, terminal succeeded,
  terminal failed, and no-work states.
- If an endpoint is needed, add a read-only endpoint such as:

```text
GET /channels/:channelId/ling-agent-session?cwd=...
```

Do not make this endpoint an authority for approval, run, or workflow state.

### Web Work

- Use the view to decide which conversation work cell, confirmation card, approval strip,
  and final report should be visible.
- Keep legacy proposal/workflow/runs loaded until the view is stable.
- Do not remove existing evidence links.

### Tests

```bash
corepack pnpm --filter @ling-stack/daemon typecheck
corepack pnpm --filter @ling-stack/daemon exec node --test --test-name-pattern "ling agent session view" test/channel-workspace.test.mjs
```

## P2: Coordinator Entry Order

Status: implementation corrected. Ling Agent now treats intent-selector `no_reply` as
"not executable work" and continues into ordinary reply handling instead of ending the
channel message. Ordinary root messages, auto-route fallbacks, model-selected ordinary
routes, and deterministic clarify questions render from `ling_agent`. Suppressed
ordinary-route and intent-selector evidence is retained for diagnostics but no longer
renders as route/intent chrome in the default feed.

### Goal

Make channel message handling look like one Ling Agent Coordinator entry point, while
reusing the existing selector and router modules internally.

Target priority:

```text
persist user message
-> active-session handling
-> executable intent selector
-> workflow/collaboration selector
-> ordinary chat auto-route
-> no reply
```

### Daemon Work

Refactor `packages/daemon/src/features/channels/messages.ts` toward a small coordinator
function:

```ts
async function handleLingAgentChannelMessage(input: LingAgentChannelMessageInput): Promise<LingAgentChannelMessageResult> {
  const active = await maybeHandleActiveSessionMessage(input);
  if (active) return active;

  const intent = await selectChannelWorkflowIntent(input);
  if (intent.action !== "single_reply" && intent.action !== "no_reply") {
    return renderIntentOutcome(input, intent);
  }

  return maybeRouteOrdinaryReply(input);
}
```

This is a shape, not the exact API. The important change is ownership and ordering.

### Active-Session Handling

If a session has active run/workflow state:

- approval-looking responses should resolve approval through existing endpoints only when
  unambiguous and explicitly supported;
- additive instructions should become `queue_followup`;
- direction-changing instructions should become `interrupt_redirect`;
- ordinary status questions can answer from durable state;
- unrelated chat can fall through to ordinary chat without changing the run.

The first slice may implement only classification and UI affordance. It does not need to
auto-resolve approvals from natural language.

Implemented initial behavior:

- additive follow-up text such as `完成后也更新 docs` creates a durable
  `queue_followup` run intervention and appends intervention audit events;
- redirect text such as `停，改用 daemon API` returns a `requires_confirmation`
  active-session action, but does not create an intervention or cancel the source run;
- both paths run before executable selector and ordinary auto-route, so they do not create
  route decisions or execution proposals.

### Guardrails

- Auto-route must not run before executable intent detection.
- Intent-selector `no_reply` is not terminal; it falls through to ordinary chat routing.
- `Channel.defaultTeammateId` must not become the visible ordinary-chat author. It is a
  preferred specialist hint for assignment, workflow participation, and evidence.
- Explicit AI teammate mentions and explicit visible multi-reply requests are the paths
  where specialist teammates appear as visible reply authors.
- Suppressed/no-reply route decisions and intent-selector decisions must not render under
  ordinary user messages.
- Missing runnable providers produce a visible blocked Ling reply, not silent no-reply.
- `ChannelMessageRouteDecision` remains ordinary-chat evidence only.
- `ChannelIntentDecision` remains executable/collaboration evidence only.
- No selector or router output can grant tools or start side effects directly.

### Tests

Add daemon tests for:

- file create request creates proposal, no ordinary route decision;
- README follow-up resolves recent target before ordinary route;
- ordinary question still creates one visible Ling Agent reply when a runnable provider is
  available, even if a default teammate is configured;
- acknowledgement, punctuation, and repeated greeting still create a visible Ling outcome;
- active run follow-up creates or previews intervention instead of ordinary reply.

## P3: Terminal Final Report

Status: initial implementation complete. Reports are deterministic projections over
existing workflow/run/artifact/approval records; no final report table or model-generated
summary is introduced in this slice.

### Goal

When workflow/run execution reaches terminal state, Ling Agent should produce one final
result report and collapse process detail by default.

### Contract

```ts
interface LingAgentFinalResultView {
  readonly title: string;
  readonly summary: string;
  readonly outcome: "succeeded" | "blocked" | "failed" | "cancelled";
  readonly changedPaths: readonly string[];
  readonly artifactIds: readonly string[];
  readonly checks: readonly LingAgentResultCheck[];
  readonly approvals: readonly LingAgentResultApprovalSummary[];
  readonly nextActions: readonly string[];
  readonly evidenceRefs: readonly LingAgentEvidenceRef[];
}
```

### Source Priority

Build final reports from durable data, not transient UI state:

1. workflow terminal `resultSummary`;
2. terminal workflow step summaries and output packets;
3. linked run terminal summaries;
4. artifacts, changed paths, approvals, execution actions, and diagnostics;
5. fallback deterministic summary if no generated summary exists.

### Daemon Work

- Add a deterministic final report builder first.
- Optionally persist final report later if recomputation becomes expensive.
- Avoid model-generated final reports in the first slice unless the existing runner output
  already provides a terminal summary.

### Web Work

- Render completed work as one `ConversationWorkCell` in completed mode.
- Move raw workflow/run/proposal process details behind evidence expansion.
- Do not show both raw process cards and final report as default rows for the same work.

### Tests

Add tests for:

- completed workflow has a final result;
- blocked workflow carries blocker and next action;
- approval-denied run mentions denied approval in summary;
- evidence expansion still links to workflow steps, runs, artifacts, and approvals.

## P4: Permission UX Integration

Status: initial implementation needs one follow-up slice. The first slice updated Web
confirmation copy and tested the existing inline runtime approval path. The next slice
must allow clearly scoped local executable requests to auto-accept their proposal and
start the existing workflow/run path, while still using durable runtime approvals for
side effects.

### Goal

Separate intent acceptance, optional pre-execution confirmation, and runtime approval
without making the user learn workflow/run/approval internals.

### Auto-Start Policy

For clear executable work, Ling Agent should create proposal evidence, auto-accept it,
and start the existing task/run or workflow path immediately when required tools are not
denied:

```text
user asks for clear executable work
-> create ChannelExecutionProposal with requiredTools
-> mark it accepted and persist autoStartReason evidence
-> call the existing proposal-to-workflow/run adapter
-> runtime write/edit/bash approvals still follow workspace policy
```

Auto-start is allowed for explicit executable work when:

- the target file, command, task scope, or first inspection step is explicit enough to
  create a bounded run;
- a runnable executor is available;
- required tools are not `deny` under workspace approval policy;
- the resulting run request can be represented through existing proposal/workflow/run
  state and approval policy.

Auto-start must fall back to clarification, confirmation, or blocked proposal when:

- required scope is missing and cannot be inspected safely inside a run;
- the model cannot confidently resolve target, content, or acceptance;
- no runnable executor/provider is available;
- one or more required tools are `deny` under workspace approval policy;
- a workspace/channel policy explicitly requires confirmation before run creation.

### Pre-Execution Confirmation

Use confirmation copy only when auto-start is not allowed. Copy should be permission
oriented, such as:

```text
Need write permission to create /path/README.md for this task.
Start task?
```

The confirmation card should include:

- concrete action;
- target path, command, or MCP tool;
- required tool family: `write`, `edit`, `bash`, `mcp_tool_call`;
- executor: Ling Agent or specialist teammate;
- note that runtime approval may still be requested.

The card should not be shown for every ordinary clear task. It is a scope/risk gate, not
the normal start mechanism.

### Runtime Approval

Runtime approval stays on existing durable approval records:

```text
ApprovalRequest / ExecutionAction
-> InlineApprovalStrip for active local work
-> Review Queue or approval page as fallback
```

Rules:

- no mutation of workspace approval policy from task confirmation;
- no second approval store;
- Ling Agent may auto-accept a start proposal only under the Auto-Start Policy above;
  it must never auto-approve runtime `ApprovalRequest` records;
- high-risk or external actions stay governed by runtime approval policy; `ask` pauses at
  the tool call, `allow` proceeds, and `deny` blocks.

### Code Anchors

- confirmation card data from proposal/session view;
- `apps/web/src/lib/inline-approvals.ts` for active approval selection;
- `apps/web/src/features/approvals/InlineApprovalStrip.tsx` for active local approval UI;
- `apps/web/src/features/approvals/ApprovalCard.tsx` for detailed payload rendering.

### Tests

Add tests for:

- clear file create auto-starts through proposal/workflow/run and then waits on runtime
  `write` approval when policy is `ask`;
- clear file edit auto-starts through proposal/workflow/run and then waits on runtime
  `edit` approval when policy is `ask`;
- clear project command auto-starts through proposal/workflow/run and then waits on
  runtime `bash` approval when policy is `ask`;
- high-risk file/delete/push/deploy/provider/credential requests auto-start only when
  required tools are not denied; runtime approval policy still gates the side effect;
- incomplete creation requests ask one clarifying question and do not create an ordinary
  "I cannot execute" reply;
- runtime approval still resolves through existing approval endpoint;
- approving a runtime permission does not change workspace policy.

### P4A Follow-Up Slice: Auto-Start Execution

Implement auto-start as a follow-up to the existing P4 permission UX work:

- add an auto-start eligibility helper beside executable intent detection;
- persist proposal evidence before any run/workflow starts;
- mark eligible proposals `accepted` and persist auto-start reason in decision/workflow
  evidence, such as `autoStartReason`;
- call the existing proposal-to-workflow/run adapter rather than adding a new runner
  entry point;
- render running progress immediately instead of a stale confirmation card;
- keep runtime approval behavior unchanged.

P4A must not teach the ordinary answer router to create work. It belongs to Ling Agent
Session after executable detection and before ordinary answer mode.

### P4A Detailed Implementation Contract

P4A is a daemon coordinator change, not a Web shortcut. The user message handler should
make the start decision after executable intent detection and before ordinary answer
routing.

Required order:

```text
persist user message
-> build LingAgentSessionView
-> handle active-session approval/follow-up/redirect cases
-> detect executable or collaboration intent
-> create ChannelExecutionProposal when intent is executable
-> evaluate auto-start eligibility
-> if allowed: call confirmChannelExecutionProposalWorkflow service directly
-> if denied by risk/policy: leave proposal as draft/blocked and render confirmation
-> if incomplete: ask one clarifying question and do not create an ordinary answer
-> only then allow ordinary answer routing
```

The manual Web route remains the same:

```text
POST /channel-proposals/:proposalId/confirm-workflow?cwd=...
```

Auto-start should call the same daemon service function that powers that route,
`confirmChannelExecutionProposalWorkflow`, with a server-side caller. Do not add a second
workflow compiler, task runner, or hidden run creation path.

#### Eligibility Helper

Add a small pure helper near executable intent handling:

```ts
type LingAutoStartRisk = "low" | "medium" | "high";

type LingAutoStartBlockReason =
  | "missing_target"
  | "missing_content"
  | "ambiguous_acceptance"
  | "high_risk_action"
  | "external_side_effect"
  | "credential_or_provider_change"
  | "approval_policy_change"
  | "deploy_release_publish"
  | "git_push_or_merge"
  | "broad_delete_or_move"
  | "missing_executor"
  | "policy_requires_confirmation";

interface LingAutoStartDecision {
  readonly allowed: boolean;
  readonly risk: LingAutoStartRisk;
  readonly reason: string;
  readonly blockReason?: LingAutoStartBlockReason;
}
```

The helper must be deterministic from normalized intent, proposal data, channel policy,
workspace approval policy, executor availability, and current session state. It should
not depend on model prose after the proposal is already built.

Allowed by default:

- create or edit one or a small set of named local files;
- update a known docs/code section where target and acceptance are clear;
- run a narrow local command such as a test, typecheck, lint, or smoke command;
- inspect/read/summarize local project state when tool execution is required;
- explicit push/merge/deploy/release requests when the needed tool family is not denied;
  runtime approval policy gates the mutation step.

Runtime-gated by default:

- broad deletes, moves, cleanups, or filesystem rewrites;
- Git push, merge, release, deploy, publish, or external-send work;
- credential, provider, plugin, approval-policy, memory-authority, or permission-scope
  changes;
- paid actions, account mutations, or actions against external services.

These classes do not automatically block run creation. They raise risk and should cause
the runner to hit runtime approval when the workspace policy is `ask`. They block only
when the required tool family is `deny` or no supported runtime gate exists.

Denied before run creation:

- required tool family is `deny` under workspace approval policy;
- no runnable executor/provider is available;
- missing target, missing content, ambiguous command, or unclear acceptance that cannot
  be safely resolved by an initial inspection step.

#### Proposal And State Semantics

Do not add a new proposal status for the first P4A slice.

Use existing states:

```text
draft proposal
  -> accepted + linkedWorkflowId when auto-start succeeds
  -> draft or blocked when confirmation is required or validation fails
  -> cancelled or superseded through existing user actions
```

Auto-start evidence should be auditable without a schema migration:

- `ChannelExecutionProposal.status = "accepted"` means the plan was accepted, whether by
  user click or auto-start policy;
- `linkedWorkflowId` links to the started workflow;
- `channel_intent_decisions` should record that the accepted outcome came from Ling Agent
  Session auto-start, including `LingAutoStartDecision.reason` and any block reason;
- workflow metadata may include `sourceProposalId`, `sourceMessageId`,
  `autoStartSource: "ling_agent_session"`, and `autoStartReason` when metadata is
  available;
- proposal schema changes are deferred unless evidence cannot be reconstructed from
  intent decisions plus workflow metadata.

#### Confirmation And Clarification Semantics

When auto-start is denied because scope is incomplete, do not create a proposal card that
contains guessed work. Ask one targeted clarification question.

When auto-start is denied because run-start policy blocks execution, keep or create the
proposal card and render it as a start gate. The card should explain the concrete block
reason:

- `tool_denied`: "Workspace policy denies bash/edit/write for this task."
- `missing_executor`: "No runnable executor/provider is available."
- `missing_target`: "The target is missing and cannot be safely inspected."
- `policy_requires_confirmation`: "Workspace/channel policy requires confirmation before
  run creation."

#### Runtime Approval Semantics

Auto-start is not runtime approval.

The first side-effecting tool call still flows through existing approval records:

```text
auto-started workflow running
-> runner requests write/edit/bash/MCP
-> ApprovalRequest or ExecutionAction is created
-> policy ask pauses the run
-> inline approval strip appears
-> user approves or denies
```

P4A must not:

- mutate workspace approval policy;
- pre-grant `write`, `edit`, `bash`, MCP, external-send, deploy, or credential authority;
- let Ling Agent approve its own runtime request;
- hide approval denial inside a final report without showing the blocked state.

#### Web Rendering Contract

For auto-started work:

- hide the proposal confirmation card from the default feed once the linked workflow is
  running;
- show one active mutable process cell;
- show inline runtime approval when the run is waiting for approval;
- collapse completed process detail under the Ling Agent final report;
- keep proposal, intent decision, workflow, run, and approval evidence available through
  expansion.

For confirmation-required work:

- show the proposal card with the block reason and concrete required permission family;
- do not show a running process cell until the user starts it;
- after user confirmation, reuse the same rendering path as auto-started work.

#### Minimum Tests

Daemon tests should cover:

- clear file create intent creates a proposal, auto-confirms it through
  `confirmChannelExecutionProposalWorkflow`, and links a workflow;
- clear file edit intent does the same with required tool `edit`;
- narrow test command intent does the same with required tool `bash`;
- runtime approval policy `ask` still creates a waiting approval after auto-start;
- high-risk Git push/deploy/delete/provider/credential requests auto-start when required
  tools are not denied and then rely on runtime approval policy for the side effect;
- required tool `deny` creates a blocked/confirmation proposal and does not auto-start;
- missing target/content asks clarification and does not create an ordinary answer;
- ordinary non-executable chat still reaches the ordinary answer router.

Web tests should cover:

- auto-started work shows running progress instead of a stale confirmation card;
- waiting runtime approval appears inline for an auto-started task;
- confirmation-required work still shows the proposal card;
- terminal auto-started work collapses process detail under the final report.

## P5: Ling Agent Built-In Executor

### Goal

Let Ling Agent execute safe work when no specialist teammate is configured or required.
Specialists remain optional collaborators.

### Executor Identity

Initial implementation uses the protected built-in executor identity:

```ts
const LING_AGENT_EXECUTOR_ID = "ling_agent";
```

P5 represents Ling Agent as a built-in executor in channel proposal and workflow paths.
P7 promotes the same identity into a protected system teammate profile. This keeps the
existing proposal, workflow, run, approval, artifact, and evidence state machines
unchanged. It does not introduce a second approval authority.

### Selection Rules

Use Ling Agent direct execution when:

- the task is single-step or can be scoped without specialist judgment;
- no matching specialist is available in the channel with the required tools;
- the user addresses Ling directly;
- the selected specialist has no runnable provider but the workspace has a runnable
  provider for Ling Agent;
- policy does not require a specialist role.

Use specialists when:

- the user explicitly names one;
- channel default teammate is relevant and runnable;
- a workflow step requires a role;
- specialist skill/profile materially changes the prompt, tool scope, or approval gates.

### Missing Specialist UX

Show a non-blocking recommendation only when useful:

```text
No dedicated Engineer teammate is configured. Ling Agent can handle this task now, or you
can add an Engineer teammate for future runs.
```

Do not show this for every ordinary task.

### Tests

Add tests for:

- file creation with no runnable Docs teammate creates a `ling_agent` proposal and
  auto-starts when the scope is clear and required tools are not denied;
- code edit with no runnable Engineer teammate creates a `ling_agent` proposal and
  auto-starts when the scope is clear and required tools are not denied;
- ambiguous fallback proposals clarify; policy-denied fallback proposals remain
  `ready_for_confirmation` or blocked;
- an accepted/auto-started fallback proposal creates a workflow step assigned to
  `ling_agent`;
- the started run receives only the proposal's task-scoped required tools.

- no Docs teammate, README create still uses Ling Agent executor;
- no Engineer teammate, simple code edit can use Ling Agent executor;
- explicit teammate mention still selects that teammate when runnable;
- missing required specialist blocks only when workflow policy says the role is required.

## P6: Web Acceptance And Regression Matrix

Initial implementation status: complete for the first Ling Agent session acceptance
matrix. The Web E2E suite now covers the high-risk user-facing seams; broader live smoke
can stay as a release checklist item.

### Required User Flows

1. Create file:

```text
User: 在 /tmp/example 下创建 README.md
Expected: confirmation card with write scope, not Docs shell snippet.
```

2. Filename-only continuation:

```text
Prior work: created /tmp/example/README.md
User: 在 README.md 中添加一句测试语句
Expected: edit confirmation for /tmp/example/README.md.
```

3. Ordinary question:

```text
User: 这个 workspace 里面都有谁？
Expected: one ordinary Ling Agent answer.
```

4. Active follow-up:

```text
Active run exists.
User: 完成后也更新 docs
Expected: queued follow-up affordance/intervention, not hidden prompt injection.
```

5. Stop and redirect:

```text
Active run exists.
User: 停，改用 daemon API
Expected: interrupt-and-redirect affordance/intervention.
```

6. Runtime approval:

```text
Run asks to edit a file.
Expected: inline approval strip near active session, durable approval evidence.
```

7. Terminal report:

```text
Workflow succeeds.
Expected: final Ling Agent result report, process detail collapsed, evidence expandable.
```

### Suggested Validation Commands

Narrow backend checks:

```bash
corepack pnpm --filter @ling-stack/daemon typecheck
corepack pnpm --filter @ling-stack/daemon exec node --test test/channel-workspace.test.mjs
corepack pnpm --filter @ling-stack/daemon exec node --test test/approval-policy-run.test.mjs
```

Web checks after UI slices:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts
```

Always run:

```bash
git diff --check
```

## P7: Protected Ling Agent Teammate Profile

### Goal

Make Ling Agent visible and usable as the default built-in teammate instead of a hidden
fallback. Ling Agent should feel like a normal teammate in roster, channel membership,
mentions, and private chat, while keeping system-owned lifecycle and permission boundaries.

### Profile Contract

Use one canonical identity everywhere:

```ts
const LING_AGENT_ID = "ling_agent";
```

The profile must expose at least:

```ts
interface LingAgentSystemProfile {
  readonly id: "ling_agent";
  readonly kind: "system_teammate";
  readonly displayName: string;
  readonly avatar?: LingAgentAvatarConfig;
  readonly description?: string;
  readonly protected: true;
  readonly removable: false;
  readonly editableFields: readonly ["displayName", "avatar", "description", "userInstructions"];
  readonly userInstructions?: LingAgentUserInstructionsRef;
}
```

Implementation may start with a virtual profile and later migrate to durable storage if
personalization requires it.

### Channel Rules

- New channels include Ling Agent by default.
- Existing channels synthesize or migrate Ling Agent membership if missing.
- UI must not expose remove, delete, disable, archive, or hide actions for Ling Agent.
- Channel settings should not ask users to choose Ling Agent as a default teammate; Ling
  Agent is always the coordinator. Preferred specialist remains separate.
- Mention picker includes Ling Agent.
- Private teammate chat can open Ling Agent using the same conversation shell as other AI
  teammates.

### Personalization Rules

Allowed:

- display name;
- avatar image, initials, color, or accent;
- short description;
- user-added Ling Agent instructions.

Not allowed:

- changing `id = "ling_agent"`;
- deleting, disabling, archiving, hiding, or removing Ling Agent from a channel;
- editing the built-in product-owned Ling Agent instruction document;
- granting tools, provider access, memory authority beyond protected defaults,
  credentials, deploy authority, or external-send authority;
- bypassing Ling Agent Session auto-start/confirmation policy, runtime approval, runner
  registry, or audit.

### Instruction Layering

Represent the system instruction and user addition as separate sources:

```text
LING_AGENT.md
LING_AGENT.user.md
```

`LING_AGENT.md` is product-owned and versioned with the app. `LING_AGENT.user.md` is
workspace/user-owned preference material. Prompt assembly should order product rules before
user additions, and conflicts must resolve in favor of product rules.

### Tests

Add coverage for:

- new channel includes Ling Agent membership;
- old channel without explicit membership renders Ling Agent anyway;
- remove/delete/disable actions are unavailable for Ling Agent;
- display name/avatar personalization changes presentation but not stored author id;
- user-added instructions are included after built-in instructions;
- user-added instructions cannot bypass approvals or change protected lifecycle;
- Ling Agent private chat opens and replies through the normal teammate conversation path.

## P8: Always-On Teammate Memory And Ling Agent Memory Panel

### Goal

Make memory a default teammate capability rather than a setup toggle. Every AI teammate
has isolated private memory, channel membership provisions that teammate's own channel
memory, and Ling Agent exposes protected coordinator memory in its teammate Memory panel.

### Storage Rules

- Every AI teammate gets `private-chat-summary` and `private-notes`.
- Every channel membership gets `channel-brief` and `channel-decisions` for that teammate
  and channel.
- Default scopes are synthesized/backfilled on teammate creation, teammate listing,
  channel membership changes, and memory-scope reads.
- Default scopes cannot be removed or disabled. Compatibility clients may send
  `enabled:true`; `enabled:false` is rejected.
- Ling Agent scopes are protected system memory and cannot be replaced through the normal
  teammate memory endpoint.

### UI Rules

- Creation and settings surfaces must not show memory source checkboxes or off switches.
- The Memory tab shows scope status as active and explains that review controls manage
  content, not recall availability.
- Ling Agent sees the Memory tab even though other protected lifecycle tabs remain hidden.
- Empty states say memory is being prepared, not that memory is disabled.

### Tests

Add coverage for:

- built-in Ling Agent has private and channel scopes after channel creation;
- newly created teammates have private scopes by default;
- channel membership adds channel scopes;
- `enabled:false` is rejected at store and daemon API boundaries;
- replacing a subset of scopes preserves all required defaults;
- protected Ling Agent memory remains visible but not replaceable.

## PR Slicing

Recommended order:

1. P1 projection helper and daemon tests.
2. P2 coordinator entry ordering and regression tests.
3. P3 final report projection and Web completed-cell behavior.
4. P4 permission copy plus inline approval integration polish.
5. P5 Ling Agent built-in executor.
6. P4A auto-start policy for clear executable work.
7. P6 Web E2E and smoke hardening.
8. P7 protected Ling Agent teammate profile and personalization.
9. P8 always-on teammate memory and Ling Agent Memory panel.

Avoid combining P2 routing changes with P3 Web final-report UI in the same PR unless the
diff stays small. Routing bugs and UI-collapse bugs have different failure modes.

## Data Migration Policy

P1-P8 plus P4A should not require database migrations.

Allowed without migration:

- derived session view;
- new TypeScript helper types;
- final result projection built from existing records;
- UI copy and view-model changes;
- metadata fields inside existing proposal/workflow/run metadata only when already
  versioned and guarded.

Require a separate migration proposal if:

- final reports need durable persistence;
- Ling Agent sessions need first-class storage;
- executor identity cannot fit existing teammate/workflow metadata;
- auto-start/confirmation cards need a new durable decision record beyond existing
  proposals.
- Ling Agent personalization requires durable profile or instruction storage that cannot be
  represented as a virtual profile plus existing workspace settings.

## Acceptance Criteria

- Users see Ling Agent process and results, not selector/auto-route/workflow/run names.
- Executable requests become durable proposal evidence before ordinary chat routing.
- Explicit executable requests auto-start through existing workflow/run paths when
  executor/provider/scope is available and required tools are not denied.
- Ambiguous requests clarify; policy-denied requests show confirmation/blocking instead
  of auto-starting.
- High-risk side effects such as Git push/merge, deploy/release/publish, broad delete,
  external send, or credential/provider changes are runtime-gated by approval policy
  rather than blocked before run creation.
- Confirmation cards, when shown, name the concrete permission family and target.
- Runtime tool approval still uses existing durable approvals.
- Missing specialists do not block safe Ling Agent direct execution.
- Ling Agent appears as a protected built-in teammate in every channel.
- Ling Agent private chat is available through the teammate conversation surface.
- Ling Agent display name/avatar/user-added instructions are customizable without changing
  `ling_agent` identity or approval behavior.
- AI teammate memory is always on, per-teammate, and not user-disableable.
- Ling Agent protected coordinator memory is visible in its Memory panel.
- Active follow-ups and redirects use durable intervention semantics.
- Completed work shows one final result report by default.
- Evidence remains expandable and complete.
- No product behavior depends on hidden runner memory or browser state.
- No slice creates a second approval system or bypasses runner registry.

## Open Decisions

Product boundary decisions: none for this plan.

Implementation decisions to close during P1-P8 plus P4A:

- exact location of the shared `LingAgentSessionView` type after the first daemon/Web
  slice proves the shape;
- whether final reports should be persisted or recomputed;
- whether the protected Ling Agent profile is virtual, durable, or migrated from a seeded
  teammate row;
- where user-added `LING_AGENT.user.md` instructions are stored and versioned;
- exact Web copy for pre-execution confirmation versus runtime approval.
