# Conversation Plan And Goal Modes

Status: implementation design, first execution slice landed
Date: 2026-07-01

Related docs:

- [Ling Agent Session Control Plane](ling-agent-session.md)
- [Conversation Composer Unification](conversation-composer-unification.md)
- [Multi-Agent Slash Commands](multi-agent-slash-commands.md)
- [Codex-Inspired Settings And Permission Presets](codex-inspired-settings-permission-presets.md)
- [Runner Adapters](runner-adapters.md)
- [Runtime Control Plane Detailed Design](runtime-control-plane-detailed-design.md)
- [Channel Context Processing Layer Implementation Plan](channel-context-processing-layer-implementation-plan.md)
- [Conversation Plan History And Goal Completion Detailed Design](conversation-plan-history-and-goal-completion-detailed-design.md)

## Summary

Ling should add two Codex-inspired session controls:

- Plan Mode: a conversation mode that allows repo exploration and decision-complete
  planning, but forbids implementation and repo-tracked mutation.
- Goal Mode: a persisted thread goal with status, budget/accounting, pause/resume/clear,
  and later auto-continuation through Ling-owned run intervention and scheduler paths.

These controls belong to the conversation session and control plane. They are not skills,
not prompt-only conventions, and not replacements for the current permission presets.

The user-facing entry points should mirror the Codex screenshots:

```text
composer + menu
  -> Goal
  -> Plan Mode

composer bottom toolbar
  -> active "Plan" or "Goal" chip when selected

slash commands
  -> /plan
  -> /goal [objective|pause|resume|clear|status]
```

The `+` menu and `/` commands dispatch the same structured session actions. The model
may see the resulting context after the state changes, but it does not decide whether a
typed `/goal` is a command or whether Plan Mode is active.

## Implementation Notes, 2026-07-01

The first implementation slice now covers PR1 through the user-visible parts of PR5:

- `ConversationModeState` is persisted on `LingThread` and exposed through
  `GET/PATCH /threads/:id/mode`.
- Plan Mode state is overlaid into the effective run policy snapshot with
  `conversationMode: "plan"` and
  `planModeMutationPolicy: "deny_repo_tracked_mutation"`.
- daemon approval and runtime permission request paths fail closed in Plan Mode for
  repo-tracked mutation, write/edit actions, mutating shell commands, deployment/history
  changes, and permission expansion to side-effecting tools.
- channel workflow orchestration and direct workflow-step start fail closed while the
  channel root thread is in Plan Mode, so implementation workflows cannot be started by
  API calls or approvals until the user exits Plan Mode.
- channel task-run endpoints also fail closed while the channel root thread is in Plan
  Mode, preventing implementation runs from starting through direct API calls.
- `ling_thread_goals` is persisted by migration 87. The active-like statuses are
  `active`, `paused`, `blocked`, `usage_limited`, and `budget_limited`.
- `GET/PUT/PATCH/DELETE /threads/:id/goal` implements durable create, replace, pause,
  resume, complete, clear, and history-preserving replacement semantics.
- `/goal`, `/goal status`, `/goal pause`, `/goal resume`, `/goal clear`, and
  `/goal edit` are session commands. They do not create skill tasks or send ordinary
  prompt text.
- Plan Mode also blocks implementation-style skill slash commands in the channel
  composer. The draft remains visible and no task is created until the user exits Plan
  Mode or presses `Implement` on a proposed plan card.
- the channel composer renders a compact Goal floating panel above the input with
  Continue, Pause/Resume, Edit, Clear, and Expand details controls. The Goal chip and
  `+` menu row open the same editor path.
- Goal continuation is explicit and visible: the Continue button sends a normal channel
  message with `requestAiReply: true`. It is blocked while Plan Mode is active and while
  the goal is paused. Blocked or usage-limited goals can still be manually continued
  after the user decides the session is ready.
- `<proposed_plan>` blocks render as plan cards only for AI teammate replies. User
  literal examples stay as plain text.
- proposed plans are durable in `ling_thread_proposed_plans` and exposed through
  `GET/POST/PUT/PATCH /threads/:id/proposed-plans...`; AI teammate `<proposed_plan>`
  replies are upserted as plan artifacts.
- plan `Save` persists without execution; channel-only `Convert to workflow` creates a
  draft channel workflow and one queued step; `Implement` exits Plan Mode, creates a
  channel task with `requestedSkillId: "plan-acceptance"`, and posts a visible channel
  message linking the accepted plan source. `Refine plan` keeps or enters Plan Mode and
  sends a visible follow-up scoped to the proposed plan.
- Terminal runs now update the active goal ledger: `lastRunId`, run/turn evidence refs,
  elapsed time, token usage when provider usage is present, `budget_limited` when a
  token budget is reached, and `usage_limited` when provider quota or rate-limit failures
  stop the run.
- Goal continuation has a conservative automatic path through existing run interventions:
  after a successful ordinary run, an active goal may queue and start one visible
  `queue_followup` continuation. It does not chain from continuation runs.

Deferred from this first execution slice:

- right-dock proposed-plan history and richer plan browsing;
- multi-hop autonomous Goal Mode scheduling beyond the current single-hop continuation
  guard.

The follow-up implementation on this branch covers PR6 plus the conservative PR7
guardrails:

- right-dock proposed-plan history now supports thread and channel scopes with status
  filtering, source jump, and detail fallback.
- channel proposed-plan aggregation is a read model; canonical mutation still resolves
  back to the source thread plan artifact.
- goal completion uses `POST /threads/:threadId/goal/complete`; direct PATCH to
  `complete` is rejected so completion stores actor, reason, summary, and evidence.
- token accounting prefers provider usage and falls back to a labeled local estimate.
- `Convert to workflow` opens a preview/edit dialog and saves a draft workflow without
  starting execution.
- guarded automatic Goal continuation may chain up to three visible follow-ups, stops
  after repeated no-evidence turns, and marks `blocked` only after the same blocker is
  observed across three goal turns.

Follow-up decisions, 2026-07-01:

- proposed-plan data ownership is thread-scoped. The canonical artifact belongs to the
  source thread, source turn/message, and optional active goal. Channel-level plan
  history is an aggregation read model for team visibility, not the source of truth.
- channel aggregation is required for multi-agent work. Ling Agent and teammate agents
  may read the channel plan index, but teammate agents should propose refinements instead
  of overwriting canonical source-thread plans.
- Ling Agent may mark a goal `complete` only after a requirement-by-requirement evidence
  audit proves the objective is achieved. User completion may force complete with an
  explicit reason. System statuses such as `budget_limited` and `usage_limited` remain
  system-owned.
- goal accounting should use provider-reported token usage when present and local
  estimated usage as a fallback when providers omit usage. Estimated usage is acceptable
  for budget control but must be marked as estimated, not treated as billing truth.
- right-dock plan history should open the source message when available and also show a
  focused plan detail panel. If the source message is unavailable, the detail panel is the
  fallback.
- channel `Convert to workflow` should open a preview/confirmation drawer before saving a
  draft graph. Saving the draft must not start execution.
- multi-hop Goal scheduling must stay conservative: at most three automatic continuations
  in a chain, stop after repeated no-evidence progress, and mark `blocked` only after the
  same blocker repeats for three goal turns.

## Codex Reference Semantics

Ling should borrow the product semantics, not the Codex runtime.

### Plan Mode

Codex implements Plan Mode as a collaboration mode, not as the `update_plan` todo tool.
The open-source reference has these useful properties:

- `ModeKind::Plan` is one of the TUI-visible collaboration modes.
- the Plan preset injects a Plan-specific developer instruction template;
- the Plan preset can set a Plan-specific reasoning effort;
- Plan Mode allows non-mutating exploration;
- Plan Mode forbids editing files, applying patches, running rewriting formatters,
  migrations, codegen, or any side-effectful command whose purpose is doing the work;
- the final plan is rendered through a structured `<proposed_plan>` block;
- Plan Mode can request user input before finalizing a plan.

Important distinction:

```text
Plan Mode = collaboration mode and safety posture
update_plan = progress/checklist tool
```

Ling must preserve this distinction. A Ling checklist/progress surface must not toggle
Plan Mode, and Plan Mode must not be implemented as a checklist helper.

### Goal Mode

Codex exposes thread goals through a persisted thread-goal API and TUI actions:

```text
/goal [<objective>|clear|edit|pause|resume]
```

The reference behavior worth borrowing:

- a goal requires a saved/persisted session;
- a goal has an objective and status;
- visible statuses include active, paused, blocked, usage limited, budget limited, and
  complete;
- goal summaries show objective, time used, token usage, and optional token budget;
- paused, blocked, or usage-limited goals can prompt the user to resume after session
  resume;
- replacing an unfinished goal requires confirmation;
- completed goals may be replaced without treating old work as unfinished.

Ling should not copy Codex storage or app-server RPC. Ling already owns threads, turns,
runs, approvals, artifacts, and runtime supervision. Goal Mode should become a Ling-owned
thread/session primitive.

## Product Model

### Plan Mode

Plan Mode is a temporary mode for the current conversation surface. It changes what the
next user turn can cause:

```text
Default mode
  -> user asks for work
  -> coordinator may answer, clarify, propose, or execute depending on policy

Plan Mode
  -> user asks for work
  -> coordinator researches and asks/refines
  -> coordinator produces proposed_plan
  -> no implementation run starts until the user exits Plan Mode or chooses "Implement"
```

Plan Mode is allowed on:

- normal conversation threads;
- channel root or branch composers;
- teammate private threads, when the teammate has a runnable read-only context;
- future Desktop conversation surfaces.

Plan Mode is not a durable goal by itself. It can produce a plan artifact, and that plan
can later become:

- a normal follow-up user turn;
- a channel workflow proposal;
- a task;
- a thread goal objective;
- a design document.

### Goal Mode

Goal Mode is a persisted target for a thread. It answers "what are we continuing until
done?". It does not change the historical `LingThread.objective`, which describes the
thread's origin or owner-level task.

```text
LingThread.objective
  -> source objective for the thread or task

LingThreadGoal.objective
  -> active persisted goal the session is currently trying to satisfy
```

A thread can have at most one active goal. Historical goals should remain auditable after
clear/replace/complete.

Goal Mode is allowed only when Ling has a durable thread id. If the conversation is still
an unsaved local draft, Goal should be disabled with a message equivalent to:

```text
Goals need a saved Ling thread.
Send the first message or open a persisted thread before setting a goal.
```

### Combined State

Plan Mode and Goal Mode can coexist, but they have different authority.

| State | Meaning | Execution behavior |
| --- | --- | --- |
| Plan only | "Work out how to do this." | No repo-tracked mutation. Produces plan artifacts. |
| Goal only | "Keep working toward this objective." | May execute under normal permission policy and goal scheduler rules. |
| Plan + Goal | "Plan the next step toward this goal." | No mutation until Plan Mode exits. Goal remains active. |

If both are active, Plan Mode wins for mutation policy. The visible composer should show
both chips, with Plan first because it constrains the next turn.

## UI Design

### Plus Menu

The composer `+` menu should gain session controls alongside attachment and plugin
actions:

```text
Add
  File and folder
  Goal          Set a goal Ling will keep working toward
  Plan Mode     Plan first, then implement after review

Plugins
  Documents
  PDF
  Spreadsheets
  Presentations
```

Rules:

- `Goal` opens a compact objective editor when no goal exists.
- `Goal` opens a goal summary/actions menu when a goal exists.
- `Plan Mode` is a toggle. Selecting it activates Plan Mode immediately.
- when Plan Mode is active, the menu row becomes `Exit Plan Mode`.
- disabled rows must explain the blocker, for example no persisted thread or read-only
  enforcement unavailable.

The menu dispatches local structured actions, not text insertion.

### Toolbar Chips

The composer bottom toolbar should render active state chips after the authorization
control and before the model/thinking area.

```text
[+] [@] [Custom v] | [Plan] [Goal]                       [model] [send]
```

Plan chip:

- icon: checklist/sliders style, matching the screenshot direction;
- label: `Plan`;
- action: opens Plan Mode menu with `Exit`, `View latest plan`, and optional reasoning
  override;
- tooltip: "Plan mode: Ling can inspect and ask, but cannot implement yet."

Goal chip:

- icon: target;
- label: `Goal`;
- action: opens goal summary with objective, status, time/tokens if known, and actions;
- tooltip: active objective excerpt.

Chip rules:

- chips are state indicators, not decorative tags;
- chips must survive draft edits and attachment changes;
- chips must be included in the same shared composer contract for channel, normal
  conversation, and teammate private surfaces;
- chips must not be rendered as large cards inside the composer.

### Slash Commands

Ling already treats slash commands as local control-plane syntax. Plan and Goal commands
should extend that registry with session commands.

Required commands:

```text
/plan
/plan off
/plan status
/goal <objective>
/goal status
/goal pause
/goal resume
/goal clear
```

Optional later commands:

```text
/goal edit
/goal budget 50000
/goal complete
/goal block <reason>
```

Dispatch rules:

- session commands have higher precedence than skill commands with the same id;
- `/plan` without args toggles Plan Mode on;
- `/plan off` exits Plan Mode;
- `/plan status` sends no model message and opens or prints the current state;
- `/goal <objective>` sets or replaces the goal after confirmation if the existing goal is
  unfinished;
- `/goal status` shows the goal summary;
- `/goal pause`, `/goal resume`, and `/goal clear` mutate only goal state;
- unknown `/goal ...` subcommands should show command help, not send prompt text.

The parser should represent these as a separate intent family:

```ts
type ComposerSlashIntent =
  | SkillSlashIntent
  | SessionSlashIntent
  | { kind: "none" };

type SessionSlashIntent =
  | { kind: "session_command"; command: "plan"; action: "enable" | "disable" | "status"; raw: string }
  | {
      kind: "session_command";
      command: "goal";
      action: "set" | "status" | "pause" | "resume" | "clear";
      objective?: string;
      raw: string;
    };
```

This is a design shape, not a required exported type name. The invariant is that session
commands do not route through task creation or skill selection.

### Proposed Plan Rendering

A Plan Mode response can contain one structured plan artifact. The UI should render it as
a durable `ProposedPlan` block or artifact, not as unstructured assistant prose.

Minimum fields:

```ts
interface ProposedPlanArtifact {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly sourceTurnId?: string;
  readonly sourceMessageId?: string;
  readonly sourceRunId?: string;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly status: "draft" | "accepted" | "superseded" | "archived";
  readonly savedAt?: string;
  readonly acceptedAt?: string;
  readonly convertedAt?: string;
  readonly acceptedTaskId?: string;
  readonly acceptedWorkflowId?: string;
  readonly acceptedWorkflowStepId?: string;
  readonly acceptedRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Actions:

- `Implement`: exits Plan Mode, creates a task/workflow/run depending on surface and plan
  shape, and links back to the plan artifact.
- `Refine`: stays in Plan Mode and sends a follow-up turn scoped to the plan.
- `Save`: persists without execution.
- `Convert to workflow`: channel-only, creates or previews a `ChannelWorkflow`.

The first implementation stores proposed plans in `ling_thread_proposed_plans`. The
remaining follow-up is not durability; it is richer browsing/history and right-dock
surfacing.

## Data Model

### Conversation Mode State

Plan Mode belongs to the conversation thread/session, not to a single run. Store it in a
small state object attached to the thread or surface-specific conversation record:

```ts
type ConversationModeKind = "default" | "plan";

interface ConversationModeState {
  readonly threadId: string;
  readonly mode: ConversationModeKind;
  readonly activatedAt?: string;
  readonly activatedBy?: "local-user" | "system" | "workflow";
  readonly reasoningEffortOverride?: string;
  readonly latestProposedPlanId?: string;
}
```

Rules:

- Plan Mode does not grant permissions.
- Plan Mode is part of the input envelope for the next turn.
- Plan Mode state is visible in the composer even before a model response.
- Exiting Plan Mode does not delete proposed plan artifacts.

### Thread Goal

Add a goal-owned data model instead of expanding `LingThread.objective`.

```ts
type LingThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete"
  | "cleared"
  | "replaced";

interface LingThreadGoal {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly objective: string;
  readonly status: LingThreadGoalStatus;
  readonly tokenBudget?: number;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly clearedAt?: string;
  readonly replacedByGoalId?: string;
  readonly lastRunId?: string;
  readonly blockedReason?: string;
  readonly completionEvidenceRefs: readonly GoalEvidenceRef[];
}

type GoalEvidenceRef =
  | { readonly kind: "run"; readonly id: string }
  | { readonly kind: "turn"; readonly id: string }
  | { readonly kind: "artifact"; readonly id: string }
  | { readonly kind: "approval"; readonly id: string }
  | { readonly kind: "workflow"; readonly id: string };
```

Storage:

```sql
CREATE TABLE ling_thread_goals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  token_budget INTEGER,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  time_used_seconds INTEGER NOT NULL DEFAULT 0,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  last_run_id TEXT,
  blocked_reason TEXT,
  replaced_by_goal_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cleared_at TEXT
);

CREATE INDEX idx_ling_thread_goals_thread_status
ON ling_thread_goals(workspace_id, thread_id, status, updated_at);
```

Only one goal per thread should be active-like at a time:

```text
active-like = active | paused | blocked | usage_limited | budget_limited
```

SQLite can enforce this through application logic first. A partial unique index can be
added later if the storage layer standardizes partial-index migrations.

## API Design

Daemon routes:

```text
GET    /threads/:threadId/mode
PATCH  /threads/:threadId/mode

GET    /threads/:threadId/goal
PUT    /threads/:threadId/goal
PATCH  /threads/:threadId/goal
DELETE /threads/:threadId/goal

GET    /threads/:threadId/proposed-plans
POST   /threads/:threadId/proposed-plans
GET    /threads/:threadId/proposed-plans/:planId
PUT    /threads/:threadId/proposed-plans/:planId
PATCH  /threads/:threadId/proposed-plans/:planId
POST   /threads/:threadId/proposed-plans/:planId/save
POST   /threads/:threadId/proposed-plans/:planId/accept
POST   /threads/:threadId/proposed-plans/:planId/refine
POST   /threads/:threadId/proposed-plans/:planId/convert-workflow
```

Request examples:

```json
{
  "mode": "plan",
  "reasoningEffortOverride": "medium"
}
```

```json
{
  "objective": "补设计，然后细设计，同时覆盖 /plan 和 /goal 会话入口",
  "tokenBudget": 50000,
  "replaceExisting": false
}
```

Important response behavior:

- `GET /goal` returns `{ goal: null }` when no goal exists.
- setting a goal on an unsaved/unknown thread returns `409 thread_not_persisted`.
- setting a new goal while an unfinished goal exists returns `409 goal_replace_required`
  unless `replaceExisting: true` is supplied.
- `DELETE /goal` clears the active-like goal, but does not delete history.
- `PATCH /goal { status: "complete" }` requires evidence refs or explicit user actor.

## Runner And Control-Plane Enforcement

### Plan Mode Policy

Plan Mode must be fail-closed at the daemon/control-plane layer. Developer instructions are
useful, but they are not enforcement.

When `ConversationModeState.mode === "plan"`:

- run requests should use a Plan policy overlay;
- file edit/write/apply-patch actions are denied;
- repo-tracked mutation commands are denied unless marked as safe dry-run;
- formatters, migrations, and codegen are denied when they would rewrite tracked files;
- tests/builds/checks may run only when the action classifier marks them non-mutating or
  cache/build-output-only;
- approvals must not be offered to bypass Plan Mode for implementation actions. The user
  must exit Plan Mode or choose an explicit Implement action.

This is stricter than the current `read_only` permission preset. Today, `read_only` maps
to `ask_everything`, which can still ask before mutation. Plan Mode should deny
implementation mutation by policy.

Plan policy should compile to a runtime snapshot field such as:

```ts
interface EffectiveRunPolicySnapshot {
  readonly mode: SessionPermissionMode;
  readonly conversationMode?: "default" | "plan";
  readonly planModeMutationPolicy?: "deny_repo_tracked_mutation";
}
```

The exact field names can differ, but the audit must show why an action was denied.

### Goal Continuation Policy

Goal Mode must not become hidden infinite execution. Auto-continuation should wait until a
later slice and use explicit controls:

- goal must be active;
- Plan Mode must not be active;
- latest run must be terminal;
- no pending approval is waiting;
- token/time budget must allow another continuation;
- blocked count must stay below the configured threshold;
- scheduler must create a visible queued follow-up or work item, not hidden prompt
  injection.

Continuation should reuse existing semantics:

```text
goal scheduler
  -> queue follow-up intervention or work item
  -> normal run orchestration
  -> run/turn/artifact evidence
  -> update goal accounting/status
```

Do not inject a secret mid-run prompt into a running agent. If the user changes goal while
a run is active, use queued follow-up or interrupt-and-redirect based on the visible run
intervention model.

## Context Injection

Plan and Goal state should enter the coordinator envelope as structured context:

```ts
interface TurnEnvelope {
  readonly conversationMode?: ConversationModeState;
  readonly activeGoal?: LingThreadGoal;
  readonly latestProposedPlan?: ProposedPlanArtifact;
}
```

Prompting rules:

- Plan Mode instructions are system/developer policy generated by Ling, not user text.
- Goal objective is user-provided data and must be treated as task context, not as higher
  priority instructions.
- Proposed plan content is prior artifact context. It can guide execution only after the
  user accepts/implements it.
- Skill instructions remain scoped to the selected skill. They must not override Plan Mode
  mutation denial.

## Boundary With Existing Systems

### Slash Commands

The existing slash command design remains correct: slash parsing is a local control-plane
boundary. Plan/Goal commands add a new command family but do not change the skill-task
path.

| Command family | Examples | Dispatch owner |
| --- | --- | --- |
| Session commands | `/plan`, `/goal pause` | conversation/session controller |
| Skill commands | `/review`, `@QA /qa` | task creation and skill selection |
| Future UI commands | `/settings`, `/approval` | local UI/router |

### Permission Presets

Plan Mode is not a fifth permission preset.

Permission presets answer "what could this run do if it executes?". Plan Mode answers
"are we allowed to execute implementation at all?". Both must appear in the effective
snapshot because they constrain different layers.

### Workflow

Plan artifacts can become workflow proposals, but Plan Mode itself is not a workflow.

Channel-only conversion can call the existing workflow template/graph compiler after the
user accepts a plan. Normal conversation can create a task or direct run instead. Private
teammate chat can send a private follow-up scoped to that teammate.

### Goal And Thread Metadata

`LingThread.metadata` may cache goal summary fields for fast lists, such as active goal
status or excerpt. The authoritative goal state belongs in `ling_thread_goals`.

Do not use thread metadata as safety authority. Runtime checks must load the goal record
and the effective mode/policy snapshot.

## Implementation Roadmap

Ship this as five PRs. Do not combine Plan Mode, Goal Mode, and auto-continuation in
one change set.

### PR1: Plan/Goal Protocol And Read Models

Goal: give Web and daemon stable objects before any execution behavior changes.

Changes:

- Add `ConversationModeState`, `LingThreadGoal`, and `ProposedPlanArtifact` types.
- Add daemon routes:
  - `GET /threads/:id/mode`
  - `PATCH /threads/:id/mode`
  - `GET /threads/:id/goal`
  - `PUT /threads/:id/goal`
  - `PATCH /threads/:id/goal`
  - `DELETE /threads/:id/goal`
- Add Web/mock-daemon fixtures for empty and active Plan/Goal state.
- Add read slots that can render Plan/Goal state without changing run behavior.
- Do not connect runner execution, proposed-plan acceptance, or goal continuation.

Verification:

- core type tests cover the new state shapes;
- daemon route tests cover null/empty state and basic updates;
- Web mock-daemon fixtures render no-mode, Plan active, no-goal, and Goal active states.

### PR2: Plan Mode UI And `/plan`

Goal: match the screenshot-level product behavior: the user can choose Plan Mode, see the
active chip, use `/plan`, and receive a proposed plan block.

Changes:

- Add `Plan Mode` and `Exit Plan Mode` to the composer `+` menu.
- Add a compact `Plan` chip to the composer toolbar.
- Add session slash commands:
  - `/plan`
  - `/plan off`
  - `/plan status`
- Persist per-thread `ConversationModeState`.
- Route `/plan` as a session command, not a skill task and not ordinary prompt text.
- Inject Plan Mode developer instructions into the next turn.
- Render `<proposed_plan>` as a proposed plan artifact/block.

Boundaries:

- Plan Mode is not a permission preset.
- Plan Mode is not the `update_plan` todo/checklist tool.
- `/plan` must not send an ordinary user prompt after it mutates mode state.

Verification:

- selecting Plan Mode shows the chip and changes the menu row to Exit Plan Mode;
- `/plan` toggles the same state as the menu;
- `/plan status` opens or prints mode status without creating a task;
- a Plan Mode response with `<proposed_plan>` renders as a proposed plan block;
- exiting Plan Mode preserves the proposed plan artifact.

### PR3: Plan Mode Enforcement

Goal: make Plan Mode safe at the daemon/control-plane layer, not only through
instructions.

Changes:

- Add `conversationMode: "plan"` or equivalent to the run request/effective policy
  snapshot.
- Add a Plan policy overlay in daemon action classification.
- Deny implementation mutations before approval:
  - edit/write/apply-patch;
  - formatters that rewrite tracked files;
  - migrations/codegen that update tracked files;
  - side-effectful commands whose purpose is implementing the plan.
- Keep read/search/static inspection and safe tests/builds available when classified as
  non-mutating or build-cache-only.
- Do not offer an approval path that bypasses Plan Mode. The user exits Plan Mode or uses
  an explicit Implement action.

Verification:

- Plan Mode allows reading and searching files;
- Plan Mode denies file edits, patch application, and format rewrites;
- denial reasons appear in run evidence/audit;
- Default mode behavior is unchanged.

### PR4: Goal Lifecycle And `/goal`

Goal: implement Goal as a persisted thread-level object with explicit user controls.

Changes:

- Add `ling_thread_goals` storage and store APIs.
- Add `Goal` to the composer `+` menu.
- Add a compact `Goal` chip to the composer toolbar.
- Add session slash commands:
  - `/goal <objective>`
  - `/goal status`
  - `/goal pause`
  - `/goal resume`
  - `/goal clear`
- Require confirmation before replacing an unfinished goal.
- Inject the active goal into turn context as user-provided objective data, not as a
  higher-priority instruction.

Boundaries:

- Do not mutate `LingThread.objective`.
- Disable Goal when there is no persisted thread.
- Clearing a goal updates state and preserves history; it does not delete records.

Verification:

- setting a goal creates one active-like goal for the thread;
- replacing an unfinished goal requires confirmation;
- pause/resume/clear update state without deleting history;
- active goal appears in composer and thread detail;
- `/goal status` shows the summary without sending ordinary prompt text.

### PR5: Plan Acceptance And Goal Continuation

Goal: connect plans and goals to execution while keeping every transition visible and
auditable.

Changes:

- Add proposed plan actions:
  - `Implement`;
  - `Refine`;
  - `Save`;
  - channel-only `Convert to workflow`.
- Link accepted proposed plans to the created task, workflow, or run.
- Add goal accounting:
  - token/time usage;
  - `budget_limited`;
  - `usage_limited`;
  - completion evidence refs.
- Add optional goal continuation through visible queued follow-up/work item creation.
- Reuse run intervention/work item paths; do not inject hidden mid-run prompts.

Continuation gates:

- active goal;
- Plan Mode is not active;
- no pending approval;
- latest run is terminal;
- token/time budget allows another continuation;
- blocked/loop guard allows another attempt.

Verification:

- `Implement` exits Plan Mode and starts the correct surface-specific flow;
- `Refine` stays in Plan Mode;
- channel conversion creates a workflow proposal or workflow graph preview;
- goal accounting updates from run usage;
- active goal cannot auto-continue while Plan Mode is active;
- continuation is visible as queued follow-up or work item;
- completion requires user action or evidence refs.

Recommended order:

```text
PR1 -> PR2 -> PR3 -> PR4 -> PR5
```

The first 2026-07-01 implementation followed this order. PR5 ships durable proposed-plan
storage/actions, task acceptance, draft workflow conversion, manual continuation,
single-hop automatic goal continuation through visible run interventions, and goal
accounting. The follow-up implementation ships PR6 and the conservative PR7 guardrails
described above.

## Testing Strategy

Core tests:

- slash parser recognizes `/plan`, `/plan off`, `/goal pause`, and `/goal <objective>`;
- session commands take precedence over skill commands;
- goal store enforces one active-like goal per thread;
- replacement confirmation is required for unfinished goals;
- Plan Mode policy denies edit/write/apply-patch actions.

Daemon tests:

- `GET/PATCH /threads/:id/mode`;
- `GET/PUT/PATCH/DELETE /threads/:id/goal`;
- `GET/POST/PUT/PATCH /threads/:id/proposed-plans...`;
- proposed-plan `save/refine/accept/convert-workflow` actions persist strong task or
  workflow links;
- unsaved thread goal attempts return `thread_not_persisted`;
- Plan Mode run request carries policy snapshot;
- Plan Mode blocks workflow orchestration and direct workflow-step start for the channel
  root thread;
- Plan Mode blocks channel task-run endpoints for the channel root thread;
- goal state updates after run completion do not mutate `LingThread.objective`.

Web tests:

- `+` menu shows Goal and Plan Mode rows;
- selecting Plan Mode shows toolbar chip and changes row to Exit Plan Mode;
- selecting Goal opens editor or summary depending on state;
- slash picker shows `/plan` and `/goal`;
- `/goal status` opens summary without sending ordinary prompt text;
- Plan + Goal active state renders both chips without layout shift.
- proposed-plan cards render `Save`, `Convert to workflow`, `Refine plan`, and
  `Implement`.

End-to-end tests:

- Plan Mode can inspect files and produce a proposed plan;
- Plan Mode blocks file edit attempts;
- accepted plan starts implementation only after explicit user action;
- Save and Convert persist a proposed plan and create a draft workflow without hidden run
  execution;
- active goal survives thread reload;
- paused goal does not auto-continue;
- active goal plus Plan Mode does not auto-continue until Plan exits.
- successful active goal run queues and starts visible automatic continuations within the
  configured chain guard;
- goal accounting is idempotent for repeated terminal sync of the same run.
- provider quota or rate-limit failures move the active goal to `usage_limited`.

## Open Decisions

No blocking product decision remains for the shipped first slice or the implemented
Plan History / Goal Completion / guarded continuation follow-up. The decisions above are specified in
[Conversation Plan History And Goal Completion Detailed Design](conversation-plan-history-and-goal-completion-detailed-design.md).

Remaining scope is later tuning, not product ambiguity:

- tune the continuation depth and no-evidence thresholds against real usage;
- add richer teammate/owner inference inside workflow conversion previews;
- add deeper plan lineage browsing when multiple agents produce long refinement chains.

These are non-blocking follow-ups. The shipped behavior already includes right-dock plan
history, explicit `/goal complete`, estimated-token budget fallback, workflow conversion
preview, and guarded visible Goal continuation chains. Follow-up design details live in
[Conversation Plan History And Goal Completion Detailed Design](conversation-plan-history-and-goal-completion-detailed-design.md#follow-up-tuning-detailed-design).
