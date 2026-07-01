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

## Follow-up Tuning Detailed Design

These follow-ups are not required for the shipped PR6/PR7 behavior. They make the
behavior easier to tune, easier to trust, and easier to browse once real multi-agent
usage produces longer histories.

### Continuation Threshold Observability

Current defaults are intentionally conservative:

- `maxAutomaticContinuationDepth = 3`;
- `maxNoEvidenceContinuations = 2`;
- `sameBlockerBeforeBlocked = 3`.

Do not tune these numbers blindly. First record why every automatic continuation either
started or stopped.

```text
terminal run
  -> evaluate goal continuation guards
      -> start visible queued follow-up
      -> or write stop event with reason
  -> update goal chain counters
  -> show chain state in Goal panel
```

Stop reasons should be explicit and stable:

```ts
type GoalContinuationStopReason =
  | "max_depth"
  | "no_evidence_threshold"
  | "same_blocker_threshold"
  | "plan_mode_active"
  | "pending_approval"
  | "active_run_exists"
  | "latest_run_not_terminal"
  | "goal_not_active"
  | "budget_limited"
  | "usage_limited"
  | "manual_stop"
  | "unknown";
```

Recommended event shape:

```ts
interface GoalContinuationEvent {
  readonly id: string;
  readonly goalId: string;
  readonly chainId: string;
  readonly sourceRunId: string;
  readonly continuationRunId?: string;
  readonly decision: "started" | "stopped";
  readonly stopReason?: GoalContinuationStopReason;
  readonly continuationDepth: number;
  readonly noEvidenceContinuationCount: number;
  readonly sameBlockerCount: number;
  readonly blockerFingerprint?: string;
  readonly evidenceDelta: {
    readonly newEvidenceRefs: number;
    readonly changedFiles: number;
    readonly acceptedPlans: number;
    readonly artifacts: number;
    readonly statusChanged: boolean;
  };
  readonly createdAt: string;
}
```

The first implementation can avoid a new table if run intervention metadata is already
sufficient for local debugging. Add a durable event table only when the UI or tuning
dashboard needs historical aggregate queries.

Tuning policy:

- collect at least 20 automatic continuation chains before changing defaults;
- increase `maxAutomaticContinuationDepth` only when chains often stop at depth 3 with
  fresh evidence still appearing;
- decrease `maxAutomaticContinuationDepth` only when depth 3 mostly produces no new
  evidence or repeated blocker events;
- increase `maxNoEvidenceContinuations` only for workflows that legitimately need one
  "check again" turn after a quiet run;
- decrease `sameBlockerBeforeBlocked` only if repeated blockers are already specific and
  stable enough to avoid false blocked states.

Goal panel display:

```text
Goal active
Continuation: 2 / 3
Last auto-stop: no new evidence (2 / 2)
Evidence delta: 0 refs, 0 files, 0 artifacts
```

Verification:

- a started continuation records `decision: "started"` and visible follow-up/run ids;
- every guard failure records one stable `stopReason`;
- no-evidence stop is visible in the Goal panel;
- same-blocker stop includes the blocker fingerprint;
- manual `Run goal` resets the chain counter and starts a new chain id;
- changing threshold constants updates tests without changing API contracts.

### Workflow Preview Owner Inference

Workflow conversion should suggest owners, not silently assign irreversible work. The
preview remains the user approval surface.

Owner inference reads signals in this order:

1. explicit step owner in the plan text, for example `Owner: Ling Engineer`;
2. proposed-plan `ownerAgentId`, then `sourceAgentId`;
3. step keywords mapped to teammate roles, for example UI/frontend/backend/docs/test;
4. file or path mentions, for example `apps/web`, `packages/daemon`, `docs/`;
5. prior workflow steps in the same channel with similar title/path/category;
6. channel teammate role and council specialist membership;
7. fallback to unassigned.

Recommended preview shape:

```ts
interface WorkflowConversionStepPreview {
  readonly title: string;
  readonly description?: string;
  readonly suggestedOwnerId?: string;
  readonly ownerConfidence: "high" | "medium" | "low" | "none";
  readonly ownerReason?: string;
  readonly sourceSignals: readonly string[];
  readonly dependsOnStepIndexes: readonly number[];
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly risks: readonly string[];
}
```

Confidence rules:

- `high`: explicit owner or path/category maps to exactly one available teammate;
- `medium`: role keyword and teammate role match, but no file/path evidence;
- `low`: inferred from prior workflow history or weak keyword match;
- `none`: no credible owner signal.

Preview UI:

```text
Step 1: Add daemon API
Owner: Ling Engineer  Confidence: high
Reason: packages/daemon path mention and backend step wording

[Owner dropdown] [Edit step] [Remove]
```

Boundaries:

- owner inference never starts execution;
- saving a draft workflow stores editable owner suggestions only;
- low-confidence suggestions must be visually different from confirmed owners;
- if no teammate matches, show `Unassigned` rather than inventing an owner;
- teammate agents may propose refinements, but user action remains authoritative for
  saving the workflow draft.

Verification:

- explicit `Owner:` text wins over path and history signals;
- path-only inference creates a suggested owner with a reason;
- ambiguous owner matches downgrade confidence instead of picking randomly;
- no owner signal results in `Unassigned`;
- editing owner in the preview persists into the draft workflow;
- canceling the preview leaves no workflow mutation.

### Plan Lineage Browser

The current Plans page lists artifacts and supports status, agent, and goal filters. A
lineage browser becomes useful once a single goal has many refinements from multiple
agents.

Lineage read model:

```ts
interface ProposedPlanLineageGroup {
  readonly planGroupId: string;
  readonly goalId?: string;
  readonly latestPlanId: string;
  readonly acceptedPlanId?: string;
  readonly versions: readonly ProposedPlanLineageVersion[];
}

interface ProposedPlanLineageVersion {
  readonly planId: string;
  readonly parentPlanId?: string;
  readonly supersededByPlanId?: string;
  readonly version: number;
  readonly status: ProposedPlanArtifact["status"];
  readonly title: string;
  readonly threadId: string;
  readonly sourceMessageId?: string;
  readonly sourceAgentId?: string;
  readonly ownerAgentId?: string;
  readonly updatedAt: string;
}
```

Default presentation:

```text
Goal: Ship plan/goal modes
plan_group_123
  v4 accepted   Ling Agent     Jul 01 22:04
  v3 superseded Backend Agent  Jul 01 21:50
  v2 superseded local user     Jul 01 21:32
  v1 superseded Ling Agent     Jul 01 21:20
```

Thread and channel behavior differ:

- thread view shows only versions owned by the current source thread;
- channel view aggregates versions across source threads and groups first by goal, then
  by `planGroupId`;
- accepted versions stay visible even when superseded drafts are folded;
- archived versions stay hidden by default and appear only under explicit archived/all
  filters.

Source navigation:

- clicking a version opens the detail panel;
- `Open source` jumps to `sourceMessageId` when loaded;
- if the message is outside the loaded window, load the surrounding slice before jumping;
- if the source is unavailable, keep the detail open and show `Source unavailable`.

Mutation rules:

- accepted plan content is immutable;
- refining an accepted plan creates a new draft version in the same `planGroupId`;
- direct edit of an accepted record is rejected;
- cross-agent refinement creates a linked version, not an overwrite.

Verification:

- versions are sorted by version desc and remain stable when timestamps tie;
- folded superseded versions can be expanded;
- accepted versions remain visible in default current view;
- archived versions are hidden unless requested;
- source jump works for loaded messages;
- unloaded source jump requests a surrounding slice before fallback;
- channel lineage groups plans from multiple threads without changing canonical owner.

### Follow-up Implementation Slices

PR8: Continuation Observability And Tuning

- Add continuation event/metadata recording.
- Add stop reason projection to Goal panel/right dock.
- Keep thresholds as constants until enough real data exists.
- Verify every guard records a reason and no hidden continuation is introduced.

PR9: Workflow Owner Inference Preview

- Add owner inference helper and confidence model.
- Extend workflow conversion preview with owner dropdowns and reasons.
- Persist edited owner suggestions into the draft workflow only after user save.
- Verify explicit, path-based, ambiguous, and unassigned cases.

PR10: Plan Lineage Browser

- Add lineage grouping read helper for existing proposed-plan fields.
- Extend Plans page with grouped versions and expand/collapse behavior.
- Keep thread-owned canonical mutation rules unchanged.
- Verify long refinement chains, archived filters, and source navigation fallback.

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
The follow-up shape is specified above as PR8-PR10. The only remaining operational
decision is empirical tuning: validate continuation stop reasons and evidence deltas
against real usage before changing the shipped defaults. Do not change continuation
thresholds from taste alone.
