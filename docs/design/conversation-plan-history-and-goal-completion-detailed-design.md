# Conversation Plan History And Goal Completion Detailed Design

Status: implemented follow-up design
Date: 2026-07-01
Scope: proposed-plan history, channel aggregation, goal completion authority, token
fallback accounting, workflow conversion preview, and multi-hop Goal scheduling guardrails.

Related docs:

- [Conversation Plan And Goal Modes](conversation-plan-and-goal-modes.md)
- [Conversation Right Dock Workspace Tools](conversation-right-dock-workspace-tools.md)
- [Conversation Composer Unification](conversation-composer-unification.md)
- [Ling Agent Session Control Plane](ling-agent-session.md)
- [Channel Team Operating System](channel-team-operating-system.md)
- [Run Interruption And Continuation](run-interruption-continuation.md)
- [Runtime Control Plane Detailed Design](runtime-control-plane-detailed-design.md)

## Product Decision

Plan data is thread-owned. Channel plan history is a team aggregation read model.

```text
source thread
  -> canonical proposed plan artifact
  -> source message / turn / run evidence
  -> optional goal binding

channel
  -> aggregated plan index
  -> filters, grouping, and team visibility
  -> does not rewrite source-thread truth
```

This matches Ling's multi-agent model. A channel is the shared team room. A thread is the
place where the plan was produced, refined, accepted, and evidenced. Ling Agent can read
both the source thread and the channel aggregate because it is the coordinator. Teammate
agents can read the channel aggregate as observers and propose refinements, but they
must not silently overwrite canonical plans owned by another thread.

The design borrows product patterns rather than runtime code:

- [Slack threads](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions)
  for channel/thread separation: channel keeps shared visibility, thread keeps focused
  context.
- [GitHub Projects](https://docs.github.com/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects)
  for aggregation: issue/PR remains the work item's identity, while project views
  aggregate, filter, and group.
- [Codex Goal tool semantics](https://github.com/openai/codex/blob/main/codex-rs/ext/goal/src/spec.rs)
  and
  [Codex Goal continuation prompt](https://github.com/openai/codex/blob/main/codex-rs/ext/goal/templates/goals/continuation.md):
  an agent may mark a goal complete, but only after a strict completion audit with
  current evidence. Pause/resume and system limit statuses are not agent-owned.

## Current State

The first Plan/Goal slice already shipped:

- `ConversationModeState` on Ling threads.
- Plan Mode UI and `/plan`.
- Plan Mode daemon enforcement.
- `ling_thread_goals` and `/goal` lifecycle.
- durable `ling_thread_proposed_plans`.
- proposed plan card actions: Save, Refine, Implement, Convert to workflow.
- goal accounting from terminal runs.
- one visible single-hop automatic continuation.

This follow-up implementation adds:

- right-dock plan history and richer browsing;
- channel-level plan aggregation;
- explicit goal completion authority and audit metadata;
- estimated-token fallback when providers omit usage;
- workflow conversion preview before draft graph creation;
- guarded multi-hop Goal scheduling.

## Ownership Model

### Canonical Owner

Each proposed plan has a canonical owner:

```ts
interface ProposedPlanOwnership {
  readonly threadId: string;
  readonly sourceTurnId?: string;
  readonly sourceMessageId?: string;
  readonly sourceRunId?: string;
  readonly goalId?: string;
}
```

The source thread owns:

- the plan body;
- version lineage;
- accepted/archived/superseded status;
- links to source message, turn, run, artifacts, task, and workflow;
- completion or implementation evidence.

### Channel Aggregation

Channel aggregation is a read model:

```ts
interface ChannelProposedPlanIndexItem {
  readonly planId: string;
  readonly channelId: string;
  readonly threadId: string;
  readonly goalId?: string;
  readonly sourceAgentId?: string;
  readonly ownerAgentId?: string;
  readonly title: string;
  readonly status: ProposedPlanArtifactStatus;
  readonly version?: number;
  readonly updatedAt: string;
  readonly sourceAvailable: boolean;
}
```

The channel index may be materialized or computed from thread records. Either way, it is
not an authority for mutation. Mutations resolve back to the canonical plan artifact by
`planId` and must apply source-thread rules.

## Authority Matrix

| Actor | Can read thread plan | Can read channel aggregate | Can create plan | Can refine | Can accept | Can archive | Can complete goal |
| --- | --- | --- | --- | --- | --- | --- | --- |
| User | Yes | Yes | Yes | Yes | Yes | Yes | Yes, with optional reason |
| Ling Agent | Yes | Yes | Yes | Yes | Only through explicit user action path | No silent archive | Yes, with evidence audit |
| Teammate agent | Scoped | Yes, observer | Yes, as proposal | Yes, as linked refinement | No | No | No, unless delegated by Ling Agent policy |
| System | Yes | Yes | No | No | No | No | No, but may set `budget_limited` or `usage_limited` |

Rules:

- Accepted plans are immutable as accepted records. Refinement creates a new version or
  child plan; it does not rewrite the accepted artifact.
- Teammate agents should produce linked refinements, not overwrite a plan generated by
  another agent or thread.
- User actions have final authority for accept, archive, force complete, and clear.
- Ling Agent may mark goal complete only after evidence proves the full objective is
  achieved.
- System-owned statuses are reserved for runtime and provider state.

## Proposed Plan Data Model

Extend the existing `ProposedPlanArtifact` shape in a backward-compatible migration.

```ts
interface ProposedPlanArtifact {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly channelId?: string;
  readonly goalId?: string;
  readonly sourceAgentId?: string;
  readonly ownerAgentId?: string;
  readonly sourceTurnId?: string;
  readonly sourceMessageId?: string;
  readonly sourceRunId?: string;
  readonly parentPlanId?: string;
  readonly supersededByPlanId?: string;
  readonly planGroupId?: string;
  readonly version?: number;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly status: "draft" | "accepted" | "superseded" | "archived";
  readonly savedAt?: string;
  readonly acceptedAt?: string;
  readonly convertedAt?: string;
  readonly archivedAt?: string;
  readonly archivedReason?: string;
  readonly acceptedTaskId?: string;
  readonly acceptedWorkflowId?: string;
  readonly acceptedWorkflowStepId?: string;
  readonly acceptedRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Recommended migration fields:

```sql
ALTER TABLE ling_thread_proposed_plans ADD COLUMN channel_id TEXT;
ALTER TABLE ling_thread_proposed_plans ADD COLUMN goal_id TEXT;
ALTER TABLE ling_thread_proposed_plans ADD COLUMN source_agent_id TEXT;
ALTER TABLE ling_thread_proposed_plans ADD COLUMN owner_agent_id TEXT;
ALTER TABLE ling_thread_proposed_plans ADD COLUMN parent_plan_id TEXT;
ALTER TABLE ling_thread_proposed_plans ADD COLUMN superseded_by_plan_id TEXT;
ALTER TABLE ling_thread_proposed_plans ADD COLUMN plan_group_id TEXT;
ALTER TABLE ling_thread_proposed_plans ADD COLUMN version INTEGER;
ALTER TABLE ling_thread_proposed_plans ADD COLUMN archived_at TEXT;
ALTER TABLE ling_thread_proposed_plans ADD COLUMN archived_reason TEXT;

CREATE INDEX idx_ling_thread_proposed_plans_channel
ON ling_thread_proposed_plans(workspace_id, channel_id, updated_at);

CREATE INDEX idx_ling_thread_proposed_plans_goal
ON ling_thread_proposed_plans(workspace_id, goal_id, updated_at);
```

If the storage layer avoids broad `ALTER TABLE` migrations in one slice, PR6 may start
with `channel_id`, `goal_id`, `parent_plan_id`, `superseded_by_plan_id`, and
`archived_at`, then add `ownerAgentId` and version metadata later.

## Status Transitions

| From | To | Allowed actor | Rule |
| --- | --- | --- | --- |
| `draft` | `accepted` | User action | Link task/workflow/run; set `acceptedAt`. |
| `draft` | `archived` | User action | Set `archivedAt`; keep source links. |
| `draft` | `superseded` | User or Ling refinement path | Requires `supersededByPlanId`. |
| `accepted` | `archived` | User action | Hides from default view; keeps accepted evidence. |
| `accepted` | `superseded` | Not directly | Create a new version; keep accepted record stable. |
| `superseded` | `archived` | User action | Cleanup view only. |
| `archived` | `draft` | User action | Restore if no accepted link exists. |

Default plan history filtering:

- show `draft` and `accepted`;
- fold `superseded` under the latest plan version;
- hide `archived`;
- provide filters for All, Draft, Accepted, Superseded, Archived.

## Version Model

When a plan is refined, create a new artifact:

```text
Plan group: plan_group_123
  v1 draft      plan_a
  v2 supersedes plan_a -> plan_b
  v3 accepted   plan_c
```

Rules:

- A new `<proposed_plan>` that revises a prior plan is a complete replacement, not a
  patch.
- Accepted versions stay immutable.
- `parentPlanId` records local lineage.
- `planGroupId` groups versions across refinements.
- `supersededByPlanId` points from old plan to new plan.
- If the user asks to refine an accepted plan, create `vN+1` as a draft and keep the
  accepted plan linked to its task/workflow/run.

## Right-Dock Plan History

Add a `Plans` page to the shared right dock.

```text
RightDockShell
  Plans
    This thread
    This channel
    By goal
    By agent
```

Thread view:

- shows plans whose `threadId` matches the current thread;
- sorted by `updatedAt desc`;
- source message jump is the primary action;
- detail panel remains open when jumping.

Channel view:

- shows aggregated plans for the selected channel;
- groups by active goal first, then by source thread;
- shows agent/source chips only when useful;
- does not allow silent cross-thread overwrites.

Plan row:

```text
[status] Title
Goal excerpt or source thread title
Agent/source · updated time · version
```

Plan detail:

- title, status, version, source thread, source message;
- body Markdown;
- linked task/workflow/run;
- evidence refs;
- actions: Open source, Save, Refine, Implement, Convert to workflow, Archive.

Source jump fallback:

- if `sourceMessageId` is visible, jump to the message and open detail;
- if the message exists but is outside the loaded window, load the surrounding slice and
  then jump;
- if source is unavailable, open detail and show `Source unavailable`.

## Goal Completion Model

Goal completion has two paths.

### User Completion

`/goal complete [reason]` and the Goal panel `Complete` action mark the active-like goal
complete.

Required behavior:

- if a reason is supplied, store it;
- if no reason is supplied, allow completion but record actor as `local-user`;
- attach recent evidence refs when available;
- never delete goal history;
- completion stops continuation.

### Ling Agent Completion

Ling Agent may mark a goal complete after a strict audit:

1. derive requirements from the objective, accepted plans, referenced docs, tasks, and user
   instructions;
2. identify authoritative evidence for every requirement;
3. inspect the current state, not just prior conversation memory;
4. classify each requirement as proven, contradicted, incomplete, weak, or missing;
5. call the goal-completion path only when every required item is proven and no required
   work remains.

Agent completion must store:

```ts
interface GoalCompletionMetadata {
  readonly completedBy: "ling-agent";
  readonly completedReason: string;
  readonly completionVerificationSummary: string;
  readonly completionEvidenceRefs: readonly GoalEvidenceRef[];
}
```

If evidence is weak or missing, Ling Agent must continue work, ask for user input, or
mark `blocked` only after the blocked threshold is reached.

### Goal Data Additions

```ts
type GoalCompletionActor = "local-user" | "ling-agent";
type GoalUsageSource = "provider" | "estimated" | "mixed";

interface LingThreadGoal {
  readonly completedBy?: GoalCompletionActor;
  readonly completedReason?: string;
  readonly completionVerificationSummary?: string;
  readonly usageSource?: GoalUsageSource;
}
```

Recommended migration:

```sql
ALTER TABLE ling_thread_goals ADD COLUMN completed_by TEXT;
ALTER TABLE ling_thread_goals ADD COLUMN completed_reason TEXT;
ALTER TABLE ling_thread_goals ADD COLUMN completion_verification_summary TEXT;
ALTER TABLE ling_thread_goals ADD COLUMN usage_source TEXT;
```

## Token Usage Fallback

Provider-reported usage is authoritative. Local estimated usage is a budget-control
fallback when the provider omits token usage.

Rules:

- if provider usage exists, record `usageSource: "provider"`;
- if only estimated usage exists, record `usageSource: "estimated"`;
- if a goal has both provider and estimated deltas across runs, record
  `usageSource: "mixed"`;
- estimated usage may trigger `budget_limited`;
- estimated usage must be labeled in UI and evidence as estimated, not billing truth.

Budget UI:

```text
Budget: 42.3K / 50K tokens
Source: estimated
```

Estimate source should reuse existing tokenizer capability metadata:

```text
openai-compatible
anthropic-compatible
estimated
```

The first fallback can use the existing context-budget estimator. A later slice can add
provider-specific tokenizers if the estimate error becomes too large.

## Workflow Conversion Preview

`Convert to workflow` should open a preview drawer before creating or saving a workflow
graph.

Preview drawer contents:

- generated workflow title;
- proposed steps;
- teammate/owner per step when inferred;
- dependencies;
- input/output expectations;
- risks or missing data;
- source plan link.

Actions:

- `Save draft workflow`: creates a draft workflow and queued steps, but does not execute.
- `Edit draft`: lets the user adjust title/steps before saving.
- `Cancel`: no mutation.

Rationale:

- direct draft creation is fast but can create noisy low-quality workflows;
- preview keeps the transition visible and avoids treating every plan as an executable
  graph;
- saving a draft is still non-executing, so it remains safe in Plan Mode only when the
  action is explicitly framed as artifact conversion, not implementation.

## Multi-Hop Goal Scheduling

PR5 shipped only single-hop automatic continuation. The guarded follow-up now broadens
that path after PR6 makes plan/goal state visible enough to audit.

Default guards:

- active goal only;
- Plan Mode must not be active;
- paused, blocked, usage-limited, budget-limited, complete, cleared, and replaced goals
  do not auto-continue;
- no pending approval;
- latest run is terminal;
- token/time budget permits another turn;
- each continuation is visible as a queued follow-up, work item, or run intervention;
- do not inject hidden mid-run prompts.

Loop limits:

- at most three automatic continuations in one chain;
- user manual `Run goal` resets the chain counter;
- stop after two consecutive continuations with no new evidence refs, no changed files,
  no new accepted plan, no new artifact, and no meaningful status transition;
- mark `blocked` only after the same blocker repeats for three goal turns;
- provider quota or rate-limit failure marks `usage_limited`;
- budget exhaustion marks `budget_limited`.

Continuation state may be stored on the goal or a separate ledger:

```ts
interface GoalContinuationState {
  readonly goalId: string;
  readonly chainId: string;
  readonly automaticTurnCount: number;
  readonly noEvidenceTurnCount: number;
  readonly repeatedBlockerCount: number;
  readonly lastBlockerKey?: string;
  readonly lastContinuationRunId?: string;
  readonly updatedAt: string;
}
```

## API Additions

Thread-owned plan APIs remain canonical:

```text
GET    /threads/:threadId/proposed-plans
GET    /threads/:threadId/proposed-plans/:planId
PATCH  /threads/:threadId/proposed-plans/:planId
POST   /threads/:threadId/proposed-plans/:planId/refine
POST   /threads/:threadId/proposed-plans/:planId/accept
POST   /threads/:threadId/proposed-plans/:planId/archive
```

Channel aggregation APIs are read models:

```text
GET /channels/:channelId/proposed-plans?scope=channel
GET /channels/:channelId/proposed-plans?scope=thread&threadId=...
GET /channels/:channelId/proposed-plans?goalId=...
GET /channels/:channelId/proposed-plans?agentId=...
```

Goal completion APIs:

```text
POST /threads/:threadId/goal/complete
```

Request:

```json
{
  "actor": "local-user",
  "reason": "All PR6 design decisions are documented.",
  "evidenceRefs": [{ "kind": "turn", "id": "turn_..." }]
}
```

Ling-agent completion should use an internal actor path or validated daemon call that
requires `completionVerificationSummary` and evidence refs.

## Implementation Slices

### PR6: Plan History And Goal Completion

Changes:

- extend proposed-plan fields for channel aggregation and version lineage;
- add channel proposed-plan read APIs;
- add right-dock Plans page with This thread / This channel filters;
- add source jump plus detail fallback;
- add goal completion metadata and `/goal complete`;
- allow Ling Agent completion only with evidence refs and verification summary;
- add provider-usage-first, estimated-token fallback accounting;
- change `Convert to workflow` to preview drawer before draft save.

Boundaries:

- no multi-hop automatic scheduling;
- no direct teammate overwrite of canonical plans;
- no execution from workflow preview;
- no billing claims from estimated usage.

Verification:

- thread plan list remains canonical and stable;
- channel aggregate shows plans from multiple source threads;
- teammate refinement creates a linked new plan, not an overwrite;
- accepted plan cannot be silently superseded;
- source jump works when message is loaded;
- source unavailable opens detail fallback;
- user `/goal complete` records actor/reason/evidence;
- Ling Agent completion without evidence is rejected;
- estimated usage increments budget and labels source;
- workflow conversion preview can save a draft without starting execution.

### PR7: Guarded Multi-Hop Goal Scheduling

Changes:

- add continuation chain state;
- allow automatic continuation chains up to the configured limit;
- stop on no-evidence threshold;
- mark blocked after three same-blocker goal turns;
- expose chain status in Goal panel/right dock;
- keep all continuation work visible as queued follow-up, work item, or intervention.

Boundaries:

- no hidden prompt injection;
- no continuation while Plan Mode is active;
- no continuation while approvals are pending;
- no continuation for paused, blocked, budget-limited, usage-limited, complete, cleared,
  or replaced goals;
- no unbounded autonomous loops.

Verification:

- automatic chain stops after three continuations;
- manual Run goal resets the chain counter;
- no-evidence turns stop the chain before repeated noise;
- repeated blocker marks `blocked` only on the third matching blocker;
- budget and provider limits stop continuation;
- every continuation has visible user-facing evidence.

## Open Decisions

No blocking product decision remains for PR6 or the conservative PR7 implementation.
The remaining work is operational tuning: validate the continuation depth and
no-evidence thresholds against real usage, then adjust constants if the shipped defaults
are too eager or too conservative.
