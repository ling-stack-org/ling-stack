# Automations

## Status

Status: implemented active product contract
Owner: Automations domain
Last verified: 2026-08-03

Durable definitions, drafts, runs, templates, scheduler control, daemon routes, API client,
Web management, manual execution and standard Run/Approval integration are implemented.
Richer monitor sources, desktop notifications and external destinations remain bounded
follow-ups.

Related design docs:

- [Codex-like Execution](codex-like-execution.md)
- [Execution And Orchestration Hardening](execution-orchestration-hardening.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)
- [External Work Orchestration](external-work-orchestration.md)
- [Daemon Lifecycle and Doctor P0](daemon-lifecycle-p0.md)
- [CLI Run I/O and Completion P1](cli-run-io-completion-p1.md)

## Purpose

Automations let a user turn repeatable AI teammate work into durable scheduled,
manual, or monitor-driven runs.

The Codex product shape to borrow is the user-facing pattern:

```text
create an automation
-> choose a template such as daily brief, weekly review, or project monitor
-> run on demand or on schedule
-> inspect the resulting conversation, report, artifacts, and approvals
```

Ling should not copy a separate automation runtime. Automations must compile into the
same Ling product model that already handles real work:

```text
AutomationDefinition
  -> AutomationTrigger
  -> AutomationRun
  -> LingThread
  -> RunSession
  -> ExecutionAction
  -> EvidenceBundle and artifacts
```

## Problem Solved

Automations add repeatability to scoped tasks, workflows, approvals and thread history:

- "Give me a daily brief for this project every morning."
- "Review the week every Friday."
- "Monitor this project and tell me when there is something actionable."
- "Run this same teammate prompt whenever I ask, with the same policy and output shape."

Before this capability, those flows became ad hoc scripts or hidden daemon timers. The
implemented boundary keeps timers as triggers for durable Ling work instead of creating a
second task system.

## Current Baseline

Implemented foundations and product behavior:

- `LingThread` groups runs and exposes long-lived evidence and resume paths.
- `RunSession` and run events persist execution facts.
- `ExecutionAction` records approval-backed and tool-lifecycle actions.
- Approval policy gates risky local and external side effects.
- Runtime supervisor owns active work units, leases, cancellation, retry, stale completion
  handling, and startup recovery.
- External work background schedulers already demonstrate explicit process-local
  registration, non-overlapping ticks, idempotency, and safe stop/list behavior.
- Channel brief, channel decisions, context summaries, workflows, and external work
  records provide the local facts that daily and weekly reports can summarize.
- `AutomationDefinition`, drafts and `AutomationRun` are persisted in the standard store.
- daemon routes expose CRUD, preview, manual run and scheduler start/status/stop.
- the Web Automations page manages definitions, drafts, runs, templates and execution
  detail through the shared API client.
- scheduled and manual fires reuse normal Ling threads, runs, approvals and artifacts.

Remaining product work is limited to richer monitor sources, desktop notification policy,
export/report destinations and approval-backed external action proposals.

## Goals

- Provide a first-class Automations page for scheduled, manual, and monitor-driven AI
  teammate work.
- Make every automation fire auditable as an `AutomationRun`.
- Run automation work through normal Ling threads, runs, approvals, artifacts, and
  evidence bundles.
- Support built-in templates for:
  - daily brief,
  - weekly review,
  - project monitor.
- Keep scheduling local-first and workspace-scoped.
- Prevent duplicate scheduled runs after reloads, reconnects, daemon restarts, and laptop
  sleep/wake.
- Keep external sends, provider changes, Git mutations, deployments, credential changes,
  and high-cost media actions approval-gated.
- Make output destinations explicit: thread, channel message, artifact, notification, or
  external action proposal.

## Non-Goals

- No hidden autonomous bot that can create work outside durable Ling state.
- No automatic approval of side effects.
- No daemon-wide scan of every workspace on the machine.
- No cloud scheduler in the first local design.
- No webhook receiver for generic automations in v1.
- No replacement of `LingThread`, `RunSession`, workflow, or runtime supervisor state with
  Codex app-server internals.
- No direct mutation of memory, persona, provider, tools, approval policy, or secrets from
  an automation prompt.
- No guarantee that missed local schedules run while the machine is off.

## Product Model

### AutomationDefinition

An `AutomationDefinition` is the durable user-created object.

```ts
type AutomationStatus = "enabled" | "disabled" | "paused" | "archived" | "error";

type AutomationKind =
  | "daily_brief"
  | "weekly_review"
  | "project_monitor"
  | "custom_prompt";

interface AutomationDefinition {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly threadId: string;
  readonly title: string;
  readonly description?: string;
  readonly kind: AutomationKind;
  readonly status: AutomationStatus;
  readonly trigger: AutomationTrigger;
  readonly target: AutomationTarget;
  readonly promptTemplate: AutomationPromptTemplate;
  readonly executionPolicy: AutomationExecutionPolicy;
  readonly outputPolicy: AutomationOutputPolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastRunId?: string;
  readonly nextRunAt?: string;
  readonly lastErrorMessage?: string;
}
```

Rules:

- Each automation owns one long-lived Ling thread.
- Each fire creates one `AutomationRun`.
- Each `AutomationRun` may create one Ling `RunSession`, or no run when the fire is
  skipped by idempotency, disabled state, or unchanged monitor input.
- The automation thread is the stable history surface. Low-level run history remains the
  execution log.
- `threadId` should use `LingThreadKind = "automation"`. This requires extending the
  existing `LingThreadKind` union instead of overloading `channel_discussion`.

### AutomationTrigger

```ts
type AutomationTrigger =
  | ManualAutomationTrigger
  | ScheduledAutomationTrigger
  | MonitorAutomationTrigger;

interface ManualAutomationTrigger {
  readonly type: "manual";
}

interface ScheduledAutomationTrigger {
  readonly type: "schedule";
  readonly timezone: string;
  readonly schedule: AutomationSchedule;
  readonly missedRunPolicy: "skip" | "run_one";
}

interface MonitorAutomationTrigger {
  readonly type: "monitor";
  readonly pollIntervalMs: number;
  readonly source: AutomationMonitorSource;
  readonly condition: AutomationMonitorCondition;
  readonly unchangedPolicy: "skip" | "record_noop";
}

type AutomationMonitorSource =
  | { readonly kind: "doctor_summary" }
  | { readonly kind: "runtime_stuck_work" }
  | { readonly kind: "pending_approvals"; readonly olderThanMs?: number }
  | { readonly kind: "external_work"; readonly channelId?: string }
  | { readonly kind: "github_ci"; readonly channelId: string };

type AutomationMonitorCondition =
  | { readonly kind: "any_change" }
  | { readonly kind: "count_above"; readonly field: string; readonly threshold: number }
  | { readonly kind: "status_matches"; readonly statuses: readonly string[] }
  | { readonly kind: "error_present" };
```

`AutomationSchedule` should start with a small, explicit shape instead of a full cron
parser:

```ts
type AutomationSchedule =
  | { readonly cadence: "daily"; readonly timeOfDay: string }
  | { readonly cadence: "weekly"; readonly weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; readonly timeOfDay: string }
  | { readonly cadence: "interval"; readonly everyMs: number };
```

Full cron can be a later compatibility layer if the product needs it.

### AutomationTarget

```ts
interface AutomationTarget {
  readonly scope: "workspace" | "channel" | "task" | "thread" | "external_work";
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly threadId?: string;
  readonly externalWorkId?: string;
  readonly cwd?: string;
}
```

Rules:

- `cwd` is resolved through the same workspace and channel-bound path rules used by runs
  and external work.
- A path escape blocks dispatch.
- A missing target marks the automation run `skipped` or `failed` with a visible reason,
  depending on whether the target was optional.

### AutomationPromptTemplate

```ts
interface AutomationPromptTemplate {
  readonly templateVersion: number;
  readonly systemPurpose?: string;
  readonly promptMarkdown: string;
  readonly contextSelectors: readonly AutomationContextSelector[];
  readonly maxContextItems?: number;
}

type AutomationContextSelector =
  | { readonly kind: "channel_brief"; readonly channelId?: string }
  | { readonly kind: "recent_runs"; readonly limit: number }
  | { readonly kind: "pending_approvals"; readonly limit: number }
  | { readonly kind: "recent_artifacts"; readonly limit: number }
  | { readonly kind: "state_transitions"; readonly limit: number }
  | { readonly kind: "external_work"; readonly status?: string; readonly limit: number }
  | { readonly kind: "doctor_summary" }
  | { readonly kind: "mcp_status" };
```

Context construction must be deterministic and redacted. It should not call a model
before showing the actual run prompt or context preview.

### AutomationExecutionPolicy

```ts
interface AutomationExecutionPolicy {
  readonly teammateId?: string;
  readonly requestedSkillId?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly allowedTools?: readonly string[];
  readonly approvalProfile?: unknown;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly maxConcurrentRuns: 1;
  readonly concurrencyPolicy: "skip" | "queue";
}
```

Rules:

- `maxConcurrentRuns` is fixed at `1` in v1.
- If a scheduled tick fires while a prior automation run is active, the new fire becomes
  `skipped` or `queued` according to the automation's concurrency policy.
- Provider readiness, allowed tools, MCP access, memory recall, approval profile, and
  secrets are re-resolved for every run.
- Trigger text does not grant permissions.

### AutomationOutputPolicy

```ts
interface AutomationOutputPolicy {
  readonly destinations: readonly AutomationOutputDestination[];
  readonly requireApprovalForExternalDestinations: true;
  readonly artifactRetention: "normal" | "pinned";
}

type AutomationOutputDestination =
  | { readonly type: "automation_thread" }
  | { readonly type: "channel_message"; readonly channelId: string }
  | { readonly type: "artifact"; readonly artifactKind: "markdown_report" | "json_summary" }
  | { readonly type: "local_notification" }
  | { readonly type: "external_action_proposal"; readonly service: "github" | "linear" | "email" | "slack" };
```

Internal Ling thread and channel outputs can be automatic. External outputs must be
represented as proposed external actions and pass through approval.

### AutomationRun

```ts
type AutomationRunStatus =
  | "queued"
  | "skipped"
  | "running"
  | "waiting_for_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

interface AutomationRun {
  readonly id: string;
  readonly automationId: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly threadId: string;
  readonly runId?: string;
  readonly triggerType: AutomationTrigger["type"];
  readonly scheduledFor?: string;
  readonly firedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly status: AutomationRunStatus;
  readonly idempotencyKey: string;
  readonly contextPreviewArtifactId?: string;
  readonly outputArtifactIds: readonly string[];
  readonly skipReason?: string;
  readonly errorMessage?: string;
}
```

Idempotency key:

```text
automation:<automationId>:<triggerType>:<scheduledFor-or-manual-request-id>:<templateVersion>
```

The key prevents duplicate fires from browser reconnects, daemon restart recovery, and
sleep/wake timer bursts.

## Built-In Templates

### Daily Brief

Default trigger:

```ts
{ type: "schedule", schedule: { cadence: "daily", timeOfDay: "09:00" }, missedRunPolicy: "skip" }
```

Default context:

- Current channel brief.
- Open tasks in the target channel.
- Runs and state transitions from the last 24 hours.
- Pending approvals.
- New artifacts.
- External work records that changed since the last brief.

Default output:

- Markdown report artifact.
- Automation thread message.
- Optional channel message.

Safety:

- Does not start fix runs.
- Does not post externally.
- Does not mutate tasks unless a later explicit action proposal is approved.

### Weekly Review

Default trigger:

```ts
{ type: "schedule", schedule: { cadence: "weekly", weekday: 5, timeOfDay: "17:00" }, missedRunPolicy: "run_one" }
```

Default context:

- Channel decisions.
- Completed, failed, cancelled, and blocked runs from the last 7 days.
- Landed external work and open follow-ups.
- Approval decisions.
- Error clusters and stale work.
- High-signal artifacts.

Default output:

- Markdown report artifact.
- Automation thread message.
- Optional pinned channel summary.

Safety:

- Can propose follow-up tasks.
- Cannot silently create or assign tasks in v1 unless the user enables and approves that
  output action.

### Project Monitor

Default trigger:

```ts
{ type: "monitor", pollIntervalMs: 300000, unchangedPolicy: "skip" }
```

Default monitor sources:

- Daemon doctor summary.
- Runtime stuck work.
- Pending approvals older than threshold.
- External work poll summaries.
- GitHub CI triage records when the channel has GitHub external work configured.

Default output:

- No-op skip when nothing changed.
- Finding artifact when a condition becomes true.
- Automation thread message.
- Optional local notification.

Safety:

- Monitor ticks may read local and external status.
- Monitor ticks must not start runners by default.
- Starting a follow-up run from a monitor finding requires an explicit automation setting
  and normal approval gates.

## Execution Flow

### Manual Run

```text
user clicks Run
-> daemon creates AutomationRun with manual idempotency key
-> daemon builds deterministic context preview artifact
-> daemon creates or reuses automation LingThread
-> daemon starts RunSession with the rendered prompt
-> runner emits events and actions
-> approvals pause execution when needed
-> final report is written as artifacts and thread output
```

### Scheduled Run

```text
workspace automation scheduler is registered
-> scheduler computes nextRunAt using timezone
-> setTimeout fires
-> daemon claims automation scheduled slot by idempotency key
-> daemon creates AutomationRun
-> daemon starts the normal manual-run path
-> scheduler records nextRunAt and last fire outcome
```

Scheduled ticks use `setTimeout`, not `setInterval`, so slow runs cannot overlap.

### Monitor Tick

```text
monitor timer fires
-> read source snapshot
-> compare with last durable monitor fingerprint
-> if unchanged, skip or record noop
-> if changed, create AutomationRun
-> either write finding artifact only or start a normal Ling run according to policy
```

## Daemon Scheduler Model

Definitions are durable. Timers are process-local.

```text
.ling-stack/ling-stack.sqlite
  automation_definitions
  automation_runs
  automation_monitor_snapshots

daemon process
  AutomationSchedulerRegistry
    id -> timer, running flag, nextRunAt, lastError
```

Registration rules:

- The daemon only schedules automations for the effective workspace `cwd`.
- `GET /automations` reads durable definitions without starting timers.
- `POST /automations/scheduler/start` registers process-local timers for enabled
  automations in that workspace.
- `GET /automations/scheduler` lists process-local scheduler state.
- `POST /automations/scheduler/stop` stops timers but does not delete definitions or run
  history.
- Future desktop packaging may call scheduler start for the active workspace after user
  login or explicit setting opt-in.

This mirrors the external-work background scheduler boundary: explicit registration,
inspectable process state, durable work records, and no hidden daemon-wide crawler.

## API Surface

Planned daemon endpoints:

```http
GET /automations?cwd=...
POST /automations?cwd=...
GET /automations/:automationId?cwd=...
PATCH /automations/:automationId?cwd=...
DELETE /automations/:automationId?cwd=...

POST /automations/:automationId/run?cwd=...
POST /automations/:automationId/preview?cwd=...
GET /automation-runs?cwd=...&automationId=...
GET /automation-runs/:automationRunId?cwd=...
POST /automation-runs/:automationRunId/cancel?cwd=...

POST /automations/scheduler/start?cwd=...
GET /automations/scheduler?cwd=...
POST /automations/scheduler/stop?cwd=...
```

Create request:

```json
{
  "title": "Daily project brief",
  "kind": "daily_brief",
  "channelId": "channel_...",
  "trigger": {
    "type": "schedule",
    "timezone": "Asia/Shanghai",
    "schedule": { "cadence": "daily", "timeOfDay": "09:00" },
    "missedRunPolicy": "skip"
  },
  "outputPolicy": {
    "destinations": [
      { "type": "automation_thread" },
      { "type": "artifact", "artifactKind": "markdown_report" }
    ],
    "requireApprovalForExternalDestinations": true,
    "artifactRetention": "normal"
  }
}
```

Manual run response:

```json
{
  "automationRun": {},
  "thread": {},
  "run": {},
  "contextPreviewArtifact": {}
}
```

## CLI Surface

P1 CLI automation should reuse the strict output rules from the CLI run I/O design.

```bash
ling-stack automations list
ling-stack automations create daily-brief --channel channel_... --time 09:00 --timezone Asia/Shanghai
ling-stack automations run automation_...
ling-stack automations runs --automation automation_...
ling-stack automations scheduler start
ling-stack automations scheduler status
ling-stack automations scheduler stop
```

Rules:

- `--json` prints JSON only on stdout.
- Human progress goes to stderr.
- Commands must not require the Web UI.
- Create and patch commands must not accept raw secret values.

## Web Surface

Top-level page:

```text
Automations
  Header: title, status summary, scheduler state
  Empty state:
    - Daily Brief
    - Weekly Review
    - Project Monitor
  List:
    - title
    - kind
    - enabled/paused/error
    - target
    - next run
    - last outcome
    - pending approvals
  Detail:
    - trigger
    - prompt and context preview
    - output destinations
    - recent runs
    - evidence
    - actions and approvals
```

Creation flow:

1. Choose a template.
2. Choose target workspace/channel.
3. Choose trigger.
4. Preview context.
5. Choose output destinations.
6. Save disabled or save and enable.

The page should not describe the feature with marketing copy. It should open directly
into the usable automation list and template choices.

## State Machines

Automation definition:

```text
enabled
-> paused
-> enabled
-> disabled
-> archived

enabled
-> error
-> paused | enabled
```

Automation run:

```text
queued
-> skipped
queued
-> running
running
-> waiting_for_approval
waiting_for_approval
-> running
running
-> succeeded | failed | cancelled
waiting_for_approval
-> failed | cancelled
```

State updates must use compare-and-set rules. A late runner result must not change a
cancelled automation run to succeeded.

## Storage

Suggested initial tables:

```sql
CREATE TABLE automation_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT,
  thread_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  target_json TEXT NOT NULL,
  prompt_template_json TEXT NOT NULL,
  execution_policy_json TEXT NOT NULL,
  output_policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_id TEXT,
  next_run_at TEXT,
  last_error_message TEXT
);

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  channel_id TEXT,
  thread_id TEXT NOT NULL,
  run_id TEXT,
  trigger_type TEXT NOT NULL,
  scheduled_for TEXT,
  fired_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  context_preview_artifact_id TEXT,
  output_artifact_ids_json TEXT NOT NULL,
  skip_reason TEXT,
  error_message TEXT,
  FOREIGN KEY(automation_id) REFERENCES automation_definitions(id)
);

CREATE TABLE automation_monitor_snapshots (
  automation_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  snapshot_artifact_id TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(automation_id) REFERENCES automation_definitions(id)
);

CREATE INDEX idx_automation_definitions_status ON automation_definitions(status);
CREATE INDEX idx_automation_definitions_next_run ON automation_definitions(next_run_at);
CREATE INDEX idx_automation_runs_automation ON automation_runs(automation_id, fired_at);
CREATE INDEX idx_automation_runs_status ON automation_runs(status);
```

JSON columns are acceptable in the first slice because trigger, prompt, and output policy
will evolve. Public API DTOs should remain typed even if SQLite stores JSON.

## Safety Boundary

Automations inherit all existing Ling safety rules:

- Read-only context gathering is allowed by policy.
- File writes, shell commands, Git commits, Git pushes, external sends, deployments,
  credential changes, provider changes, and high-cost media operations require normal
  approvals.
- External destinations create proposed actions. They do not execute inline.
- Raw secrets are never stored in automation definitions, run rows, artifacts, logs,
  scheduler state, or doctor JSON.
- Automation prompts cannot grant tools, MCP access, provider capabilities, memory scope,
  or approval bypass.
- Monitor triggers cannot silently start fix runs unless an explicit policy enables it and
  the resulting run still passes normal approval gates.
- Disabled or archived automations must never schedule new timers.

## Relationship To Existing Systems

### Codex-like execution

Automations are a source of Ling runs, not a replacement for the execution model. Every
automation run should be inspectable through thread evidence, action artifacts, and run
history.

### Multi-agent orchestrator

An automation can later target a workflow template instead of a single teammate prompt.
The automation still owns the trigger and run history; the orchestrator owns step
sequencing.

### External work

External work background schedulers are source-specific ingestion loops. Generic
automations are user-facing scheduled work. They can share scheduler utilities, but they
should keep separate durable records because their product meanings are different.

### Daemon lifecycle

Daemon lifecycle state is not automation state. `daemon stop` stops timers because the
process exits, but it must not edit `automation_definitions` or pretend scheduled runs
were cancelled.

## Borrowing Boundary From Codex

Borrow:

- User-facing templates for daily brief, weekly review, and project monitor.
- On-demand and scheduled run concepts.
- Strict automation CLI output conventions from non-interactive execution.
- App-server ideas only when Ling has concrete pressure around reconnect, slow clients,
  initialization gates, or serialization scopes.

Do not borrow:

- A separate Codex app-server state model as the source of truth.
- Hidden turn state as the automation history.
- Any approval bypass just because a run is scheduled.

## Delivery Status And Follow-Ups

### P0: Durable model and manual automations - implemented

- Add core types and SQLite migrations.
- Extend `LingThreadKind` with `automation`.
- Add CRUD endpoints and manual run endpoint.
- Add deterministic context preview artifact.
- Add built-in daily brief and weekly review templates.
- Add Web empty state and list/detail shell.
- Add tests for CRUD, idempotent manual run, context preview, and approval inheritance.

### P1: Local scheduler - implemented

- Add `AutomationSchedulerRegistry`.
- Add scheduler start/list/stop endpoints.
- Compute `nextRunAt` with timezone support.
- Add non-overlapping scheduled ticks.
- Add missed run policy.
- Add CLI commands.
- Add tests for duplicate registration, sleep/wake burst idempotency, stop behavior, and
  no hidden side effects.

### P2: Project monitor - partially implemented

- Add monitor sources for doctor, runtime stuck work, pending approvals, and external work
  summaries.
- Add monitor fingerprint storage.
- Add finding artifacts.
- Add local notification output.
- Add Web monitor cards and no-op history.

### P3: Rich outputs and desktop integration - deferred

- Add desktop scheduler opt-in.
- Add notification preferences.
- Add exportable report artifacts.
- Add external action proposal destinations.
- Add workflow-template automations through the orchestrator.

## Regression Contract

The maintained regression suite must continue to prove:

- Creating a daily brief creates an automation definition and automation thread.
- Manual run creates exactly one automation run for one idempotency key.
- Scheduled duplicate fire returns the existing automation run.
- Disabled automation cannot be run by scheduler.
- Manual run still works when scheduler is stopped.
- Context preview is deterministic and redacted.
- External output destinations create approval-backed action proposals, not direct sends.
- Cancelling the underlying Ling run marks the automation run cancelled.
- Late runner completion does not overwrite cancelled automation run state.
- `--json` CLI automation commands print JSON-only stdout.
