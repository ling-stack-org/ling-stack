# Automations Implementation Plan

## Status

Priority breakdown for [Automations](automations.md).

This document is the implementation-ready plan. It does not replace the product design.
The goal is to make Automations shippable as small, reviewable slices without introducing
a second scheduler core or bypassing Ling's existing run, approval, and evidence model.

## Source Design

Authoritative product behavior lives in:

- [Automations](automations.md)
- [Codex-like Execution](codex-like-execution.md)
- [Execution And Orchestration Hardening](execution-orchestration-hardening.md)
- [External Work Orchestration](external-work-orchestration.md)
- [Daemon Lifecycle and Doctor P0](daemon-lifecycle-p0.md)
- [CLI Run I/O and Completion P1](cli-run-io-completion-p1.md)
- [Automations P1.5 Creation Experience](automations-p1.5-creation-experience.md)
- [Automations P1.5 Implementation Slices](automations-p1.5-implementation-slices.md)

Implementation must preserve these boundaries:

- automation work still creates normal Ling threads and run sessions;
- every side effect still goes through normal approval policy;
- scheduler state is process-local, durable automation history is SQLite-backed;
- no generic background crawler;
- no Codex app-server state migration;
- no project monitor in the first implementation slice.

## Priority Decision

The first useful product cut is **manual automations with built-in templates**, not
background scheduling.

Recommended priority:

```text
P0 Manual Automations
  -> durable definitions
  -> automation thread
  -> context preview
  -> manual run
  -> Web empty state/list/detail

P1 Local Scheduler
  -> explicit scheduler start/list/stop
  -> daily/weekly timers
  -> idempotent scheduled fire

P1.5 Creation Experience
  -> template library
  -> manual setup
  -> chat-assisted draft confirmation

P2 Project Monitor
  -> monitor sources
  -> fingerprints
  -> finding artifacts

P3 Rich Outputs
  -> notifications
  -> external action proposal destinations
  -> workflow-template automations
```

Reason:

- P0 validates whether users understand and want the Automations product surface.
- P0 reuses the strongest existing Ling primitives: threads, runs, artifacts, approvals,
  and context preview.
- P1 scheduler is only safe after P0's idempotency and run linkage are proven.
- P1.5 improves the product creation surface without changing the P0/P1 execution
  model.
- P2 monitor is meaningfully more complex because it needs source fingerprints and
  no-op/finding history.

## Cross-Cutting Rules

Implementation rules:

- Add contracts before UI.
- Keep P0 manual-run only. Do not sneak in timers.
- Keep built-in templates deterministic and plain data.
- Store raw template config and output policy as JSON only where query patterns are not
  stable yet.
- Create one automation Ling thread per automation definition.
- Reuse `executeRunRequest` for execution; do not create a second runner path.
- Create context preview artifacts before starting a run.
- Never let automation prompt text grant tools, secrets, memory scope, MCP access, or
  approval bypass.
- Do not add external sends in P0. Represent that later as approval-backed external action
  proposals.
- Keep Web page operational: list, create from templates, preview, run, inspect recent
  runs. Avoid marketing copy.

## Existing Anchors

Current code paths to extend:

| Area | Current Anchor |
| --- | --- |
| Run/thread contracts | `packages/core/src/run-types.ts` |
| Store implementation and migrations | `packages/core/src/storage/sqlite-run-store.ts` |
| Shared DTO package | `packages/contracts/src/index.ts` |
| Daemon HTTP router | `packages/daemon/src/server/routes.ts` |
| Run execution | `packages/daemon/src/features/runs/orchestrator.ts` |
| Thread helpers | `packages/daemon/src/features/runs/threads.ts` |
| Run artifacts | `packages/daemon/src/features/runs/artifacts.ts` |
| External scheduler pattern | `packages/daemon/src/features/external-work/background-scheduler.ts` |
| API client | `packages/api-client/src/client.ts` |
| Web API wrapper | `apps/web/src/api.ts` |
| Web view registry | `apps/web/src/app/view-types.ts`, `apps/web/src/app/lazy-pages.tsx` |
| Web navigation | `apps/web/src/features/navigation/SidebarNavigation.tsx` |
| Web feature pages | `apps/web/src/features/*` |
| CLI command dispatch | `packages/cli/src/main.ts` |
| CLI command metadata | `packages/cli/src/completion/command-spec.ts` |

## P0 Scope: Manual Automations

P0 should ship this exact user flow:

```text
open Automations
-> choose Daily Brief or Weekly Review
-> select target channel
-> preview deterministic context
-> save automation
-> click Run
-> Ling creates AutomationRun and normal RunSession
-> user sees report/evidence through automation detail and thread/run links
```

P0 includes:

- durable automation definitions;
- durable automation runs;
- `LingThreadKind = "automation"`;
- built-in `daily_brief` and `weekly_review` templates;
- deterministic context preview artifacts;
- manual run endpoint;
- Web page with empty state, create flow, list, detail, preview, and manual run;
- API client and contract DTOs;
- daemon/core/web tests.

P0 excludes:

- local scheduler timers;
- project monitor;
- local notifications;
- external action destinations;
- cron syntax;
- desktop scheduler opt-in;
- CLI commands, unless backend/Web lands faster than expected and there is time for a
  small follow-up.

## P0.1 Core Contracts

### Files

Add:

```text
packages/core/src/automation-types.ts
```

Update:

```text
packages/core/src/index.ts
packages/core/src/run-types.ts
packages/contracts/src/index.ts
```

### Contracts

Move the stable types from [Automations](automations.md) into `automation-types.ts`:

```ts
export type AutomationStatus = "enabled" | "disabled" | "paused" | "archived" | "error";
export type AutomationKind = "daily_brief" | "weekly_review" | "project_monitor" | "custom_prompt";
export type AutomationRunStatus = "queued" | "skipped" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";
```

P0 should only allow these create kinds:

```ts
type P0CreateAutomationKind = "daily_brief" | "weekly_review" | "custom_prompt";
```

Keep `project_monitor` in the type only if it is useful for forward-compatible read
models. The P0 create schema should reject it with `project_monitor_not_implemented`.

Add IDs:

```ts
export function createAutomationId(): string;
export function createAutomationRunId(): string;
```

Extend `LingThreadKind`:

```ts
export type LingThreadKind =
  | "task"
  | "channel_discussion"
  | "teammate_direct"
  | "workflow_step"
  | "external_work"
  | "automation";
```

### RunStore Interface

Extend `RunStore` with:

```ts
createAutomationDefinition(input: CreateAutomationDefinitionInput, now: string): AutomationDefinition;
getAutomationDefinition(automationId: string): AutomationDefinition | undefined;
listAutomationDefinitions(options?: ListAutomationDefinitionsOptions): AutomationDefinition[];
updateAutomationDefinition(automationId: string, input: UpdateAutomationDefinitionInput, now: string): AutomationDefinition | undefined;
archiveAutomationDefinition(automationId: string, now: string): AutomationDefinition | undefined;

createAutomationRun(input: CreateAutomationRunInput, now: string): AutomationRun;
getAutomationRun(automationRunId: string): AutomationRun | undefined;
findAutomationRunByIdempotencyKey(idempotencyKey: string): AutomationRun | undefined;
listAutomationRuns(options?: ListAutomationRunsOptions): AutomationRun[];
updateAutomationRun(automationRunId: string, input: UpdateAutomationRunInput, now: string): AutomationRun | undefined;
```

Do not add monitor snapshot methods in P0. They belong to P2.

### Tests

Add core tests in:

```text
packages/core/test/automations-store.test.mjs
```

Required cases:

- create automation definition creates a stable id and default enabled/disabled status;
- automation thread id is stored;
- list filters by `status`, `kind`, and `channelId`;
- archive changes status to `archived` without deleting runs;
- create automation run enforces unique idempotency key;
- update automation run can link `runId` and output artifact ids.

## P0.2 SQLite Store and Migration

### Files

Update:

```text
packages/core/src/storage/sqlite-run-store.ts
```

### Tables

Add the P0 tables:

```sql
CREATE TABLE IF NOT EXISTS automation_definitions (
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

CREATE TABLE IF NOT EXISTS automation_runs (
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
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_automation_definitions_status ON automation_definitions(status);
CREATE INDEX IF NOT EXISTS idx_automation_definitions_kind ON automation_definitions(kind);
CREATE INDEX IF NOT EXISTS idx_automation_definitions_channel ON automation_definitions(channel_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_automation ON automation_runs(automation_id, fired_at);
CREATE INDEX IF NOT EXISTS idx_automation_runs_run ON automation_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs(status);
```

### Mapping Rules

- Parse all JSON columns with the existing safe JSON parsing style used elsewhere in
  `sqlite-run-store.ts`.
- If a JSON column is corrupted, return a readable error rather than silently dropping the
  record.
- Keep `output_artifact_ids_json` as `[]` for new runs.
- Store `trigger_json` for manual automations as `{ "type": "manual" }` when the user
  creates an on-demand-only automation.

### Migration Rules

- Use the existing migration helper pattern in `sqlite-run-store.ts`.
- P0 must not rewrite existing tables.
- P0 must not backfill old runs into automations.

## P0.3 Built-In Templates

### Files

Add:

```text
packages/core/src/automation-templates.ts
packages/daemon/src/features/automations/templates.ts
```

### Template Contract

Core should expose template metadata that Web can render without daemon-only code:

```ts
interface BuiltinAutomationTemplate {
  readonly kind: "daily_brief" | "weekly_review";
  readonly title: string;
  readonly description: string;
  readonly defaultTrigger: AutomationTrigger;
  readonly defaultPromptTemplate: AutomationPromptTemplate;
  readonly defaultExecutionPolicy: AutomationExecutionPolicy;
  readonly defaultOutputPolicy: AutomationOutputPolicy;
}
```

P0 template defaults:

| Template | Trigger | Output | Starts run automatically |
| --- | --- | --- | --- |
| Daily Brief | manual in P0, daily in P1 | automation thread + markdown artifact | only when user clicks Run |
| Weekly Review | manual in P0, weekly in P1 | automation thread + markdown artifact | only when user clicks Run |

Do not expose Project Monitor as selectable in P0. It can appear disabled only if the UI
needs to hint future work, but the safer default is to hide it until P2.

### Prompt Boundaries

Template prompts must say:

- summarize facts from supplied context only;
- do not claim unseen external state;
- do not mutate files, GitHub, providers, memory, or tasks;
- propose follow-ups as text unless an approved action path exists.

## P0.4 Context Preview Builder

### Files

Add:

```text
packages/daemon/src/features/automations/context.ts
packages/daemon/src/features/automations/artifacts.ts
```

### Responsibility

`context.ts` builds deterministic context for preview and run execution. It must not call
a model.

Proposed interface:

```ts
interface AutomationContextBuildInput {
  readonly store: RunStore;
  readonly automation: AutomationDefinition;
  readonly now: string;
  readonly mode: "preview" | "run";
}

interface AutomationContextBuildResult {
  readonly renderedPrompt: string;
  readonly contextMarkdown: string;
  readonly selectedRefs: readonly AutomationContextRef[];
  readonly warnings: readonly string[];
}
```

P0 selectors:

| Selector | Source |
| --- | --- |
| `channel_brief` | `store.getChannelBrief(channelId)` or existing channel brief API/store method |
| `recent_runs` | `store.listRuns({ threadId/channelId, limit })` when available; otherwise bounded workspace runs |
| `pending_approvals` | `store.listApprovalRequests({ status: "pending" })` filtered to target |
| `recent_artifacts` | bounded artifacts from selected recent runs |
| `state_transitions` | bounded channel/task/run transitions |
| `external_work` | bounded external work records for channel |

If any selector is not cheaply available in store methods, P0 should skip it with a
warning instead of adding broad new query surfaces.

### Context Preview Artifact

Create a JSON or Markdown artifact before a manual run:

```json
{
  "schemaVersion": 1,
  "automationId": "automation_...",
  "automationRunId": "automation_run_...",
  "renderedPrompt": "...",
  "contextMarkdown": "...",
  "selectedRefs": [],
  "warnings": []
}
```

Use the existing run artifact system only after a `RunSession` exists. Before run
creation, P0 has two options:

- create a `RunArtifact` after the run is created and attach it immediately;
- or store context preview JSON on `automation_runs.context_preview_artifact_id` only after
  `runId` exists.

Recommended P0 path: create the `RunSession` first, then create a run-linked context
preview artifact before invoking the runner. This keeps artifacts on the existing table
and avoids a generic automation artifact owner in P0.

## P0.5 Manual Run Orchestration

### Files

Add:

```text
packages/daemon/src/features/automations/run.ts
```

Update:

```text
packages/daemon/src/features/runs/orchestrator.ts
packages/daemon/src/features/runs/threads.ts
```

### Flow

Manual run should use the existing detached run execution path:

```text
POST /automations/:id/run
-> load automation
-> reject archived/disabled unless force flag is explicitly added later
-> compute idempotency key
-> return existing AutomationRun if idempotency key already exists
-> ensure automation LingThread exists
-> create AutomationRun queued
-> build deterministic context
-> build RunRequest
-> executeRunRequest(..., createDetachedRunExecutionSink())
-> update AutomationRun with runId/status
-> sync terminal status through afterRunTerminal callback
```

Do not stream the run directly from P0 automation endpoint. Return run ids and let Web
subscribe through existing run/thread surfaces.

### RunRequest Mapping

Automation run request should set:

```ts
{
  cwd: target.cwd,
  workspaceCwd: target.cwd,
  task: {
    id: `automation-${automation.id}`,
    title: automation.title,
    prompt: renderedPrompt,
    channelId: automation.channelId
  },
  threadId: automation.threadId,
  providerPresetId: automation.executionPolicy.providerPresetId,
  teammateId: automation.executionPolicy.teammateId,
  requestedSkillId: automation.executionPolicy.requestedSkillId,
  requestedRunnerId: automation.executionPolicy.runnerId,
  tools: automation.executionPolicy.allowedTools,
  approvalProfile: automation.executionPolicy.approvalProfile
}
```

If `executeRunRequest` does not currently accept an existing `threadId`, add that
capability narrowly. Do not create a special automation runner.

### Status Sync

Map terminal run status to automation run status:

| Run status | AutomationRun status |
| --- | --- |
| `succeeded` | `succeeded` |
| `failed` | `failed` |
| `cancelled` | `cancelled` |

When a run enters `waiting_for_approval`, automation run should also become
`waiting_for_approval`.

First implementation can sync:

- immediately after run creation;
- in `afterRunTerminal`;
- optionally from approval/run event hooks if already easy.

Do not block P0 on perfect live status mirroring. The durable linked `runId` is the
source of detailed truth.

## P0.6 Daemon Routes and Schemas

### Files

Add:

```text
packages/daemon/src/features/automations/schemas.ts
packages/daemon/src/features/automations/routes.ts
packages/daemon/src/features/automations/index.ts
```

Update:

```text
packages/daemon/src/server/routes.ts
packages/daemon/src/context.ts
```

### Endpoints

P0 endpoints:

```http
GET /automations?cwd=...
POST /automations?cwd=...
GET /automations/:automationId?cwd=...
PATCH /automations/:automationId?cwd=...
DELETE /automations/:automationId?cwd=...

POST /automations/:automationId/preview?cwd=...
POST /automations/:automationId/run?cwd=...

GET /automation-runs?cwd=...&automationId=...
GET /automation-runs/:automationRunId?cwd=...
POST /automation-runs/:automationRunId/cancel?cwd=...
```

P0 can implement `DELETE` as archive. Avoid physical delete.

### Create Schema

Required:

- `kind`
- `title`
- `channelId` or explicit workspace target

Optional:

- `description`
- `trigger`, default manual
- `promptTemplate`, default from template
- `executionPolicy`
- `outputPolicy`

Validation:

- reject unknown kind;
- reject `project_monitor` in P0;
- reject raw secrets;
- reject external output destinations in P0;
- reject path escapes;
- validate referenced channel, teammate, provider preset, skill, and runner if supplied.

### Responses

Use object wrappers:

```ts
interface AutomationMutationResponse {
  readonly cwd: string;
  readonly automation: AutomationDefinition;
  readonly thread?: LingThread;
}

interface AutomationRunMutationResponse {
  readonly cwd: string;
  readonly automation: AutomationDefinition;
  readonly automationRun: AutomationRun;
  readonly thread: LingThread;
  readonly run?: RunSession;
}
```

## P0.7 Contracts and API Client

### Files

Update:

```text
packages/contracts/src/index.ts
packages/api-client/src/client.ts
apps/web/src/types.ts
apps/web/src/api.ts
```

### API Client Methods

Add:

```ts
listAutomations(cwd, options?)
createAutomation(cwd, input)
getAutomation(cwd, automationId)
updateAutomation(cwd, automationId, input)
archiveAutomation(cwd, automationId)
previewAutomation(cwd, automationId, input?)
runAutomation(cwd, automationId, input?)
listAutomationRuns(cwd, options?)
getAutomationRun(cwd, automationRunId)
cancelAutomationRun(cwd, automationRunId)
```

Keep method names product-level. Do not expose implementation words like "timer" in P0.

## P0.8 Web Surface

### Files

Add:

```text
apps/web/src/features/automations/AutomationsPage.tsx
apps/web/src/features/automations/AutomationTemplatePicker.tsx
apps/web/src/features/automations/AutomationDetail.tsx
apps/web/src/features/automations/index.ts
apps/web/src/domains/automations/use-automations-domain.ts
apps/web/src/styles/automations.css
```

Update:

```text
apps/web/src/app/view-types.ts
apps/web/src/app/lazy-pages.tsx
apps/web/src/app/AppShell.tsx
apps/web/src/features/navigation/SidebarNavigation.tsx
apps/web/src/styles.css
apps/web/src/i18n.tsx
```

### UI Requirements

P0 page:

```text
Automations
  template actions: Daily Brief, Weekly Review, Custom Prompt
  list: status, kind, target, last run, last outcome
  detail: trigger, target, prompt/context preview, output policy, recent runs
  actions: Preview, Run, Pause/Enable, Archive
```

Design constraints:

- Do not make a landing page.
- Empty state should be a useful creation surface with three template actions.
- Use icons for template actions.
- Show run links into existing Threads/Runs pages.
- Show pending approval count by reading linked run approvals.
- Keep cards shallow. Do not nest cards inside cards.

P0 can skip:

- calendar picker;
- cron editor;
- notification settings;
- monitor condition builder;
- external destination editor.

### State Management

`use-automations-domain.ts` should own:

- loading definitions;
- loading runs for selected automation;
- creating from template;
- previewing;
- manual running;
- archiving;
- optimistic selection only after daemon success.

Do not put automation domain state into `AppShell` beyond selected view and refresh hooks.

## P0.9 Tests

### Core Tests

```bash
corepack pnpm --filter @ling-stack/core test
```

Required test file:

```text
packages/core/test/automations-store.test.mjs
```

Cases:

- create/list/get/update/archive definitions;
- create/list/get/update runs;
- idempotency conflict returns existing run or store-level duplicate signal;
- malformed stored JSON fails readably.

### Daemon Tests

```bash
corepack pnpm --filter @ling-stack/daemon test
```

Required test file:

```text
packages/daemon/test/automations-api.test.mjs
```

Cases:

- create daily brief automation;
- create weekly review automation;
- reject project monitor in P0;
- preview returns deterministic context without starting a run;
- manual run creates `AutomationRun`, `LingThread`, `RunSession`, and context preview
  artifact;
- duplicate idempotency key returns existing automation run;
- disabled/archived automation cannot be manually run unless a later explicit override is
  added;
- manual run inherits approval policy and does not bypass risky tools.

### API Client Tests

Update:

```text
packages/api-client/test/client.test.mjs
```

Cases:

- methods build expected paths and query strings;
- archive uses `DELETE`;
- run/preview use `POST`.

### Web Tests

Update:

```text
apps/web/e2e/app.spec.ts
```

Cases:

- Automations nav item opens page;
- empty state shows Daily Brief and Weekly Review;
- create Daily Brief calls daemon and shows detail;
- Preview shows context section;
- Run shows linked automation run/run id.

## P1 Scope: Local Scheduler

Only start P1 after P0 manual automations works.

### Files

Add:

```text
packages/daemon/src/features/automations/scheduler.ts
```

Update:

```text
packages/daemon/src/index.ts
packages/daemon/src/context.ts
packages/daemon/src/features/automations/routes.ts
```

### Behavior

```text
POST /automations/scheduler/start
-> load enabled scheduled automations for cwd
-> register process-local timers
-> compute nextRunAt
-> no overlapping ticks
-> fire automation through the same P0 manual run path
```

Endpoints:

```http
POST /automations/scheduler/start?cwd=...
GET /automations/scheduler?cwd=...
POST /automations/scheduler/stop?cwd=...
```

Rules:

- explicit start only;
- no daemon-wide scan;
- `setTimeout`, not `setInterval`;
- duplicate start returns existing scheduler state;
- scheduler stop never deletes definitions or runs;
- scheduler fire uses idempotency key based on scheduled slot.

### P1 Web

Add a scheduler status strip on Automations page:

- scheduler stopped/running/error;
- next run;
- start scheduler;
- stop scheduler.

Do not auto-start scheduler just because Web opened.

### P1 CLI

Add a thin CLI control surface over the same daemon endpoints:

```bash
ling-stack automations scheduler start
ling-stack automations scheduler status
ling-stack automations scheduler stop
```

CLI must not create a second scheduler, scan workspaces, or auto-start timers. It should
only call the explicit daemon endpoints for the current `--cwd`, support `--json`, and
render process-local scheduler state in human-readable output.

### P1 Tests

- duplicate scheduler registration does not create duplicate timers;
- stop clears timers;
- scheduled fire creates one automation run;
- sleep/wake burst still creates one run per scheduled slot;
- disabled automation is ignored;
- scheduler failure stores readable last error.
- CLI scheduler start/status/stop call the expected daemon endpoints and preserve JSON
  output.

## P2 Scope: Project Monitor

Only start P2 after P1 scheduler is stable.

### Additions

- `automation_monitor_snapshots` table;
- monitor source readers:
  - doctor summary,
  - runtime stuck work,
  - pending approvals,
  - external work summary,
  - GitHub CI triage records;
- fingerprint builder;
- finding artifact writer;
- no-op run history for `record_noop`;
- Web monitor condition builder.

### Rules

- Monitor ticks read state first.
- If unchanged, skip by default.
- If changed, create finding artifact.
- Do not start fix runs by default.
- Starting a follow-up run from a monitor finding is a separate approval-sensitive setting.

## P3 Scope: Rich Outputs

P3 should wait until at least one real user has used P0/P1.

Candidates:

- local notifications;
- desktop scheduler opt-in;
- external action proposal destinations;
- workflow-template automations through Multi-Agent Orchestrator;
- report export options;
- automation thread pinning;
- automation health badges in sidebar.

## Explicit Deferrals

Do not implement in the first automation branch:

- generic cron parser;
- cloud scheduling;
- webhook receiver;
- external message sending;
- project monitor;
- auto-generated task creation;
- task assignment;
- memory consolidation automation;
- model-generated scheduler edits;
- app-server JSON-RPC adoption.

These deferrals are important. If they enter P0, the branch becomes too wide and loses the
ability to verify the product surface quickly.

## Suggested Branch Scope

Recommended branch:

```text
codex/automations-p0-manual
```

Recommended commit grouping:

```text
1. core automation contracts and store
2. daemon automation CRUD/preview/manual-run API
3. web automations page and template flow
4. docs/tests alignment
```

If a single branch grows too large, split after commit 2. Backend P0 can land before the
Web page if API tests prove the flow.

## Verification Checklist

Before landing P0:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e
git diff --check
```

Manual smoke:

```text
1. Open Web.
2. Open Automations.
3. Create Daily Brief for a channel.
4. Preview context.
5. Run manually.
6. Open linked Thread/Run.
7. Confirm evidence, context artifact, approvals, and final output are visible.
```

P0 is done only when a user can create and manually run a daily brief without touching
CLI commands or editing local JSON by hand.
