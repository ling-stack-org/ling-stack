# Channel Workspace v1.19 General Multi-Agent Studio

## Status

Implemented first slice. This document records the channel semantics for a general
multi-agent studio: role-based AI teammates discuss work, produce a user-confirmed
execution proposal, and only then enter the PI task/run boundary.

The implemented v1.19 slice covers persisted execution proposals, daemon proposal APIs,
AI reply proposal extraction, compact proposal cards, cancel, create-and-run confirmation,
assignee-provider blocking, linked task/run status, and collapsed collaboration records.
Inline proposal editing remains a planned follow-up.

## Intent

A channel is a work scene, not a coding-only task room. The same protocol should support
a code channel with architect, engineer, reviewer, and QA teammates, or a film channel
with director, cinematographer, scene designer, editor, and producer teammates.

Normal channel flow is:

```text
human discusses work in a channel
-> coordinator agent decides whether to respond, ask, or consult specialists
-> coordinator returns one integrated reply
-> optional collapsed collaboration record shows which agents were consulted
-> agent proposes "start handling" / "create and run" when execution is clear
-> user confirms or edits the proposal
-> task is created and a PI run starts for the assignee agent
-> approvals, run state, failures, and completion are shown in the channel
```

This keeps the visible channel calm while preserving a durable boundary for execution,
approval, artifacts, and recovery.

## Product Model

`Channel` is a work scene. It can represent software, film, product, content, operations,
research, or another domain. Channel behavior should not assume coding vocabulary.

`Agent / Teammate` is a configurable role in that scene. It owns identity, role, system
prompt, default provider, tools, approval profile, and status. New roles can be added to
a channel without changing the channel protocol.

`Coordinator` is the channel's default organizing agent. It reads the message, decides
whether to answer, invite specialists, ask the user for a choice, or produce a proposal.
It does not execute side effects directly.

`Collaboration record` is a collapsed process trace, not a chat transcript. It can show
actions such as "consulted architect", "consulted cinematographer", "reviewer flagged a
risk", or "generated proposal" without making every agent post visible messages.

`Proposal` is the bridge from discussion to execution. Agents may propose executable work,
but they may not directly create tasks, start runs, write files, call external services,
or approve themselves.

`Task` is the user-confirmed executable work item. It owns title, prompt, context,
acceptance criteria, assignee teammate, status, and later run links.

`Run / PI` is the execution layer. A run starts a scoped PI session for one task and one
assignee agent. It owns tool calls, approvals, artifacts, logs, and terminal result.

Channels do not own permanent private PI processes, and agents do not keep always-on PI
sessions. A PI session starts only when a confirmed task run begins.

## Participation Rules

The channel should not let every agent speak by default.

- `@teammate`: route the next AI reply to that teammate.
- No `@` with a configured coordinator: the coordinator uses intent detection. It should
  answer questions, clarify requirements, and propose executable work, but it should not
  reply to ordinary notes that are only meant to be recorded.
- No `@` and no coordinator: store the message without AI response and show a setup route.
- Specialist agents contribute through the coordinator unless the user explicitly mentions
  them or their output contains a blocker, disagreement, or required user choice.

Default visible response:

```text
Coordinator integrated reply
Collaboration: consulted Architect, Reviewer (collapsed)
Proposal: Start handling...
```

Expanded collaboration should be available for audit, but the default chat must remain
readable.

## Proposal Contract

The first agent-side capability should be `propose_task`, not `create_task`.

`propose_task` is safe because it does not mutate workspace state, create durable tasks,
start runs, execute tools, inspect files, or write outputs. It only creates or returns a
structured draft that the Web client can render as a confirmation card.

Proposals should be persisted independently from messages so they can be accepted,
cancelled, superseded, retried, or linked to a task/run without losing history.

Draft shape:

```ts
interface ChannelExecutionProposal {
  id: string;
  channelId: string;
  sourceMessageId: string;
  proposedByTeammateId: string;
  title: string;
  prompt: string;
  assigneeTeammateId: string;
  acceptanceCriteria: readonly string[];
  collaborationSteps: readonly {
    teammateId: string;
    action: "coordinated" | "consulted" | "reviewed" | "flagged_risk";
    summary: string;
  }[];
  requiredTools?: readonly string[];
  riskSummary?: string;
  status: "draft" | "accepted" | "cancelled" | "superseded" | "blocked" | "run_failed";
  linkedTaskId?: string;
  linkedRunId?: string;
}
```

Confirmation card actions:

- `Start handling` / `Create and run`: create the task and start a PI run for the assignee.
- `Cancel`: mark the proposal cancelled without creating a task.
- `Edit`: planned follow-up that lets the user revise title, prompt, assignee, and
  criteria before confirmation.

If the assignee agent has no runnable provider, missing credentials, unsupported tools, or
a blocked approval profile, confirmation should stop at a visible blocker. Do not silently
fall back to another provider or teammate. The user must fix the assignee configuration or
edit the proposal assignee.

## Execution Boundary

Task proposal does not require approval. Task creation and run start require explicit
user confirmation through the proposal card.

When a task is run, effective execution configuration follows the assignee teammate:

- assignee teammate provider,
- assignee teammate allowed tools,
- assignee teammate approval profile,
- selected channel allowed tools and runtime policy,
- provider/runtime capability checks,
- task-specific requested tools.

Side-effect tools remain approval-gated:

- `read`, `grep`, `find`, `ls`: safe read-only tools.
- `bash`, `edit`, `write`, external sends, or domain-specific side effects: PI must pause
  and create an approval request.

Approval records should carry `channelId`, `taskId`, `runId`, `toolCallId`, and
`proposalId` when available. The channel can then show what PI wants to do, why it wants
permission, and which proposal/run caused the request.

After confirmation the user should stay in the channel. The proposal card becomes a
status card with running, waiting for approval, blocked, failed, or completed state. The
right side can show task/run details while the chat stays in place. A full run detail view
remains available through an explicit action.

## Examples

Code channel:

```text
User: Simplify the channel composer and make task creation less noisy.
Coordinator: consults Product, Frontend, Reviewer.
Proposal:
  title: Simplify channel composer task flow
  assignee: Frontend Engineer
  acceptance: ordinary chat stays plain; execution proposals are explicit; e2e updated
```

Film channel:

```text
User: We need a short sci-fi scene in a rainy alley.
Coordinator: consults Director, Cinematographer, Scene Designer.
Proposal:
  title: Create rainy alley sci-fi scene plan
  assignee: Director
  acceptance: logline, shot list, visual references, scene design notes
```

Both channels use the same protocol because the channel only cares about roles,
proposals, assignees, execution state, and approvals. The domain-specific output comes
from agent prompts, tools, and artifacts.

## Multi-Agent and Multi-Channel PI Sessions

Multiple agents can discuss in a channel without starting PI.

When execution starts:

```text
Frontend Engineer on task A -> run_1 -> PI session 1
Film Director on task B -> run_2 -> PI session 2
```

These runs are separate PI sessions with separate run ids, task snapshots, approval
records, artifacts, and status transitions. They share the daemon coordinator and runner
adapter, but not conversational state.

Conflicts are resolved by resource leases:

- same task: blocked by `task:<taskId>`,
- serial channel: blocked by `channel:<channelId>`,
- write/bash/edit on same repo path: blocked by `bound_path:<realpath>` by default,
- workspace-wide write scope: blocked by `workspace:<workspaceId>`.

Read-only runs may run in parallel when the channel policy allows it. Write-capable runs
on the same workspace should not run concurrently unless the channel explicitly narrows
write lock scope and accepts that risk.

## Non-Goals

- No automatic task creation or run start without user confirmation.
- No direct `create_task` tool for discussion agents in the first slice.
- No always-on PI process per channel or per agent.
- No broadcast mode where every available agent posts visible chat messages by default.
- No silent provider fallback when the assignee agent is not runnable.
- No bypass of provider preflight, channel runtime policy, resource leases, or approval
  policy.
- No automatic file or webpage body ingestion through proposals.

## Implemented Slice

1. Added a persisted `ChannelExecutionProposal` contract, store methods, migration, API,
   and Web client methods.
2. Allowed channel AI replies to emit safe `propose_task` results and store a proposal
   linked to the source message and proposing teammate.
3. Rendered proposals as inline confirmation cards with collapsed collaboration records,
   cancel, create-and-run, blocked, run-failed, and linked-run states.
4. On confirmation, the Web client creates the task, starts the existing PI run path for
   the assignee teammate, and writes task/run ids back to the proposal.
5. Kept the user in the channel after confirmation, with run/task detail shown in the
   right inspector and full run opening behind an explicit action.
6. Added e2e coverage for the channel execution proposal flow, including blocked assignee
   provider handling and create-and-run behavior.

## Follow-Up Work

- Add inline proposal editing before confirmation.
- Show PI approval requests directly on the proposal card when available.
- Broaden coverage with non-code channel fixtures such as a film-channel role set.

## Validation

Validation for this slice:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web exec playwright test --grep "agent proposes a task|channel execution proposal"
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/daemon test
git diff --check
```
