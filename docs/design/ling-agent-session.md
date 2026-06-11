# Ling Agent Session Control Plane

Status: design baseline for the product-level session model
Date: 2026-06-11

Related docs:

- [Ling Agent Session Implementation Plan](ling-agent-session-implementation-plan.md)
- [Channel Intent To Workflow Selector](channel-intent-workflow-selector.md)
- [Channel Auto Reply Router](channel-auto-reply-router.md)
- [Codex-Like Execution Experience](codex-like-execution.md)
- [Run Interruption And Continuation](run-interruption-continuation.md)
- [Inline Runtime Approval Detailed Design](inline-runtime-approval-detailed-design.md)
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)
- [Thread-First Work History v2 Detailed Design](thread-first-work-history-v2-detailed-design.md)

## Summary

The user-facing product model is Ling Agent sessions, not selectors, auto-routes,
workflows, proposals, runs, or approval tables. Workflows, runs, approvals, artifacts,
and route decisions are implementation and audit primitives. They surface only as
process, permission prompts, final summaries, and optional evidence details.

Ling Agent is the always-available session owner and fallback executor. Specialist
teammates are optional collaborators. Missing specialists may produce a visible
recommendation, but must not prevent executable work when Ling Agent can safely run it
through existing workflow, run, approval, and evidence paths.

Target user experience:

```text
user asks Ling to do something
-> Ling Agent understands whether this is chat, work, continuation, or approval
-> Ling Agent shows the needed task confirmation or asks one clarifying question
-> Ling Agent uses specialists when useful and available
-> execution flows through workflow/run/approval
-> active process stays visible while running
-> terminal process collapses into a final result report
-> evidence remains expandable
```

## Problem

The current channel design exposes too much of the implementation model:

- ordinary chat, executable work, and continuation are split across auto-route, selector,
  proposal, workflow, run, and thread surfaces;
- a request like "create README.md in this path" can be misread as a Docs answer instead
  of a task that needs write permission;
- after execution, the UI can leave raw process or proposal rows above the conversation
  instead of replacing them with a final task report;
- follow-up text can miss the prior executable context and get treated as a new ordinary
  chat message;
- when no specialist teammate matches the request, the product has no obvious default
  executor even though Ling itself can safely execute through the existing run path.

These are not isolated selector bugs. They point to a missing product-level owner: the
Ling Agent session.

## Product Model

Ling Agent owns the conversation session. It is the product-level coordinator that:

- receives every user message in the active Ling collaboration surface;
- decides whether the message is ordinary chat, executable work, a continuation, an
  approval-related response, or a clarification;
- chooses one or more specialist teammates when they improve the work;
- falls back to direct execution when no specialist is required or available;
- turns executable intent into a confirmable task or workflow;
- keeps running process visible without making internals the default transcript;
- reports terminal results in user language;
- links evidence for audit.

The user should not need to understand:

- selector;
- auto-route;
- workflow graph;
- proposal internals;
- run id;
- workflow step id;
- approval request id;
- route decision ids.

Those names can remain in developer docs, logs, diagnostics, and evidence drawers.

## Non-Goals

- Do not remove workflow, run, approval, thread, evidence, or route-decision primitives.
- Do not bypass the existing runner path. Ling Agent work still runs through
  `RunnerRegistry`, Pi by default, and the normal run lifecycle.
- Do not add a second approval system.
- Do not let Ling Agent self-grant tools, write scopes, MCP access, credentials, deploy
  authority, external-send authority, provider access, or memory activation.
- Do not inject follow-up prompts into an active Pi `session.prompt(...)`.
- Do not make multi-agent collaboration a shared long-context group chat.
- Do not force users to create custom specialist teammates before Ling can execute common
  file, code, command, or documentation tasks.
- Do not expose raw selector confidence, JSON, prompt text, scoring, or route internals in
  the default channel feed.

## Architecture Layers

Ling Agent is an ownership layer above existing execution primitives.

```text
Ling Agent Session
  product control plane:
  intent, context continuity, worker selection, progress narrative, final report

Workflow
  orchestration layer:
  steps, dependencies, handoffs, gates, fan-out, fan-in

Run
  execution layer:
  one runner attempt against one scoped objective

Approval
  permission layer:
  task confirmation, runtime permission requests, tool approvals, external action gates

Evidence and Audit
  durable trace:
  events, actions, artifacts, decisions, diagnostics, packets, summaries
```

The important boundary:

```text
Ling Agent decides what should happen next.
Workflow/run execute only through existing state machines.
Approval decides whether side effects may happen.
Evidence records what happened.
```

## Session Ownership

A Ling Agent session is the active product owner for a conversation lane. In v1, the
session can be derived from existing channel, thread, workflow, and run records. A later
slice may persist first-class `ling_agent_sessions` rows if derived state becomes too
fragile.

Suggested durable shape if first-class storage is needed:

```ts
type LingAgentSessionStatus =
  | "open"
  | "shaping"
  | "ready_for_confirmation"
  | "running"
  | "waiting_for_approval"
  | "reporting"
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled"
  | "archived";

interface LingAgentSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly threadId?: string;
  readonly objective: string;
  readonly status: LingAgentSessionStatus;
  readonly owner: "ling_agent";
  readonly activeWorkflowId?: string;
  readonly activeRunId?: string;
  readonly activeApprovalIds: readonly string[];
  readonly lastUserMessageId?: string;
  readonly lastResultSummary?: string;
  readonly evidenceBundleId?: string;
  readonly responseLanguage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Rules:

- Ling Agent is always present for the session.
- A session may delegate to specialists, but delegation does not transfer authority to
  bypass workflow/run/approval.
- At most one active execution should own the primary session lane unless a workflow graph
  explicitly allows parallel branches.
- Session status is derived from active workflow/run/approval state, not browser state.
- The final result report belongs to the session, even when the underlying work was done
  by a specialist step.

## Session State Machine

```text
open
  -> shaping
  -> ready_for_confirmation
  -> running
  -> waiting_for_approval
  -> running
  -> reporting
  -> succeeded

running
  -> blocked | failed | cancelled

running
  -> continuation_requested
  -> running | cancelled -> running
```

State meanings:

| State | Meaning | User-facing surface |
| --- | --- | --- |
| `open` | Session has no active task. | Normal composer. |
| `shaping` | Ling Agent is clarifying or planning. | One concise question or plan card. |
| `ready_for_confirmation` | Executable task/workflow is prepared. | Confirmation card with required permissions. |
| `running` | Workflow/run is active. | Mutable process row, progress popover, optional detail drawer. |
| `waiting_for_approval` | Existing approval system is blocking execution. | Inline approval strip near active context. |
| `reporting` | Work reached terminal state and Ling Agent is producing final summary. | Short "preparing result" state if needed. |
| `succeeded` | Final result report is ready. | Collapsed result cell plus optional evidence. |
| `blocked` | Work cannot proceed without user or environment change. | Blocker report and next action. |
| `failed` | Work failed after execution. | Failure report with evidence and retry action. |
| `cancelled` | User or system cancelled the active work. | Cancelled summary and continuation options. |

The `reporting` state is important. It prevents a terminal workflow from leaving only raw
process UI. Ling Agent should produce a user-facing final result, then the process rows
collapse under evidence.

## Intent Handling

Ling Agent Coordinator is the public entry point. The existing selector and auto-route
logic become internal modules.

```text
persist user message
-> attach message to Ling Agent session
-> if active work exists, classify as approval response, queued follow-up, or redirect
-> otherwise classify as ordinary chat, executable work, or collaboration request
-> call internal modules as needed:
   - ordinary reply router
   - executable intent detector
   - workflow proposal builder
   - workflow selector
   - specialist selector
-> render one product outcome
```

User-visible outcomes:

- ordinary answer from Ling Agent or one selected teammate;
- one clarifying question;
- executable task confirmation card;
- multi-step collaboration proposal;
- queued follow-up confirmation;
- stop-and-redirect confirmation;
- inline permission request;
- final result report.

Internal outcomes:

- `single_reply`;
- `visible_multi_reply`;
- `workflow_proposal`;
- `direct_workflow`;
- `SelectorDecision`;
- `ChannelMessageRouteDecision`;
- `ExecutionAction`;
- `ApprovalRequest`;
- `RunIntervention`.

Internal outcomes are audit data. They are not the user mental model.

## Worker Selection And Fallback

Ling Agent can use three execution patterns.

### 1. Ling Agent Direct Execution

Use when:

- the task is single-step or can be safely scoped by Ling Agent;
- no specialist teammate is configured;
- specialists would add overhead without changing the outcome;
- the user explicitly asks Ling to handle it.

Examples:

- create or edit a README;
- run a known test command;
- inspect a local file and summarize;
- update a small doc section;
- apply a narrow code fix when no specialist policy is needed.

### 2. Specialist Delegation

Use when:

- the channel has a relevant specialist with a runnable provider;
- the task clearly maps to a role such as Docs, Engineer, QA, Security, Release, or
  Designer;
- a specialist has different tools, prompt, skill, or approval profile that changes the
  work boundary.

Delegation creates workflow steps or scoped runs. The specialist does not own approval
authority.

### 3. Multi-Agent Workflow

Use when:

- the user asks for ordered collaboration;
- planning, implementation, QA, review, and release are separate phases;
- fan-out/fan-in or handoffs are useful;
- the work is risky enough that role separation improves quality.

If a requested specialist is missing, Ling Agent may show:

```text
No dedicated Engineer teammate is configured for this channel. Ling Agent can handle this
task with the current workspace permissions, or you can add an Engineer teammate for
future runs.
```

This is a recommendation, not a blocker, unless policy requires that role.

## Permission And Approval Boundary

Permissions are not approved all at session start. Ling uses two approval moments:

### 1. Pre-Execution Task Confirmation

Before starting executable work, Ling Agent should show the bounded task scope:

```text
Need write permission to create /path/README.md for this task.
Start task?
```

This confirms intent and starts the existing workflow/run path. It does not grant broad
workspace permission.

The confirmation card should include:

- action summary;
- target path, command, MCP tool, or external target;
- derived required tools such as `write`, `edit`, `bash`, or `mcp_tool_call`;
- selected executor, usually Ling Agent or a specialist;
- policy note if runtime approval may still be required.

### 2. Runtime Approval Requests

When a running tool call or permission escalation needs approval, the existing approval
system creates a durable request:

```text
runner proposes edit/write/bash/MCP/external action
-> daemon creates ApprovalRequest / ExecutionAction
-> run waits when policy requires ask
-> inline approval appears near active session
-> user approves or denies
-> run resumes, blocks, or continues through a linked continuation
```

Rules:

- Ling Agent cannot approve its own requests.
- Runtime approval does not mutate workspace approval policy.
- Grants are scoped to the run or continuation.
- External sends, deploys, credentials, provider changes, paid media actions, and broad
  filesystem changes remain explicit approvals.
- Review Queue and Work Board remain separate external/background work surfaces. Inline
  runtime approval is for the active local run.

## Continuation Rules

User messages during active work must be explicit session events, not hidden prompt
injection.

When active work is running:

- short status questions can get an ordinary Ling Agent status answer from durable state;
- additive guidance becomes a queued follow-up;
- direction-changing guidance becomes stop-and-redirect;
- approval responses resolve approval requests through the existing approval endpoint;
- unrelated chat can stay ordinary chat without mutating the active run.

Allowed flows:

```text
active run + user says "also update the docs"
-> create queued follow-up
-> active run finishes
-> continuation run starts with explicit lineage
```

```text
active run + user says "stop, use the daemon API instead"
-> create interrupt request
-> cancel source run
-> preserve partial output and evidence
-> start continuation run with source lineage
```

Forbidden flows:

- appending the new text into the active Pi prompt;
- silently merging interjection text into current run context;
- letting stale runner completion overwrite cancelled/interrupted state;
- granting new tools because the interjection asked for them.

## UI Visibility Model

Default channel feed:

- user messages;
- Ling Agent or selected teammate ordinary replies;
- confirmation cards;
- one active mutable process cell;
- inline approval prompt when relevant;
- final result report.

Hidden by default but expandable:

- selector decisions;
- auto-route decisions;
- workflow graph internals;
- step packets;
- raw run events;
- tool logs;
- approval payload JSON;
- artifacts and diagnostics.

Terminal behavior:

```text
active process cell
-> terminal run/workflow
-> Ling Agent final result report
-> collapse process detail under evidence
```

Final reports should include:

- what changed or was produced;
- files, artifacts, commands, or checks when relevant;
- whether approvals were used or denied;
- blockers or follow-up actions;
- a link to evidence.

They should not include raw internal ids unless the user expands evidence.

## Migration From Selector And Auto-Route

No existing primitive needs to be deleted.

| Current concept | New role under Ling Agent Session |
| --- | --- |
| Channel auto reply router | Internal ordinary-chat router used by Ling Agent. |
| Channel intent selector | Internal executable/collaboration detector used by Ling Agent. |
| Workflow selector | Internal workflow-step coordinator. |
| Workflow proposal | Confirmation card implementation detail. |
| Run | Execution attempt implementation detail. |
| Approval request | Permission gate implementation detail with inline active surface. |
| Thread / Work History | Durable lineage and evidence surface. |

Routing priority should become:

```text
Ling Agent Coordinator
  -> active-session continuation / approval response handling
  -> executable intent handling
  -> workflow/collaboration proposal handling
  -> ordinary chat routing
  -> no-reply suppression
```

This prevents an executable request from being answered by Docs with shell instructions
before Ling has a chance to create a confirmable task.

## Implementation Slices

Detailed implementation slices are tracked in
[Ling Agent Session Implementation Plan](ling-agent-session-implementation-plan.md).

### P0: Documentation And Boundary Alignment

- Add this design as the product-level owner.
- Mark selector and auto-route docs as internal module docs.
- Keep current workflow/run/approval docs as lower layers.

### P1: Session Projection

- Build a `LingAgentSessionView` from existing channel proposals, workflows, runs,
  approvals, and thread evidence.

### P2: Coordinator Entry Order And Active-Session Intake

- Route all non-mention channel messages through Ling Agent Coordinator first.
- Let coordinator call the intent selector and auto-route router internally.
- Ensure executable intent wins over ordinary chat routing.
- Keep route/selector evidence available only in diagnostics/evidence.

- Add composer choices for queued follow-up vs stop-and-redirect when a session is active.
- Persist interventions through the existing run-intervention design.

### P3: Terminal Final Report

- Add a terminal `finalResult` projection for completed workflow/run cells.
- Collapse terminal process rows by default after final report generation.
- Show continuation lineage in evidence and final reports.

### P4: Permission Prompt Integration

- Make pre-execution confirmation copy permission-oriented.
- Render active local approvals through the inline runtime approval surface.
- Keep external/background approvals in Review Queue or Work Board.
- Preserve the existing approval policy; task confirmation does not grant broad future
  runtime actions.

### P5: Fallback Executor And Specialist Recommendation

- Add Ling Agent as a built-in teammate-like executor when no specialist is required or
  no configured specialist can run the bounded task.
- If a specialist is missing, show a recommendation but do not block safe work.
- Preserve specialist delegation when configured and useful.

### P6: First-Class Session Storage If Needed

- Add `ling_agent_sessions` only if derived projections cannot reliably support active
  state, terminal reporting, and continuation.
- Until then, avoid adding storage that duplicates workflow/run/thread authority.

## Acceptance Criteria

- A request to create or edit a file creates a permission-oriented task confirmation, not
  a Docs reply with a shell snippet.
- A filename-only follow-up can resolve against recent same-session work context before
  ordinary chat routing.
- Missing Engineer, Docs, QA, or Release teammates do not block safe work that Ling Agent
  can execute through current policy.
- Pre-execution confirmation scopes the task but does not approve all future actions.
- Runtime tool requests still create durable approval records and use inline approval for
  active local runs.
- User interjections during active work become queued follow-up or interrupt-and-redirect
  records, not hidden prompt injection.
- Completed work produces a final Ling Agent result report.
- Completed process UI collapses by default, with evidence expandable.
- Selector, route, workflow, run, and approval internals do not appear as the default user
  mental model.
- Existing workflow/run/approval tests remain the compatibility boundary.

## Open Decisions

Unresolved product boundary decisions: none. Ling Agent Session is the user-facing owner;
workflow, run, approval, and evidence stay as lower-level primitives.

Implementation decisions to settle per slice:

- whether `LingAgentSessionView` can remain a derived read model or needs first-class
  `ling_agent_sessions` storage;
- where final report generation lives: daemon projection, runner terminal summary, or Web
  presentation layer backed by evidence;
- whether Ling Agent direct execution uses a dedicated built-in teammate id or a separate
  executor identity;
- which exact UI copy distinguishes task confirmation from runtime approval without
  making users learn the approval system.
