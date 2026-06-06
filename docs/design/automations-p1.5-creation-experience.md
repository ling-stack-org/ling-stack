# Automations P1.5: Codex-Inspired Creation Experience

## Status

Proposed product and implementation design for the next Automations slice.

This builds on:

- [Automations](automations.md)
- [Automations Implementation Plan](automations-implementation-plan.md)
- [Automations P1.5 Implementation Slices](automations-p1.5-implementation-slices.md)

P0/P1 already establish durable automation definitions, manual runs, automation threads,
local scheduler start/list/stop, and Web navigation. P1.5 improves the creation
experience without changing the execution model.

## Product Decision

Borrow Codex's user-facing creation pattern, not its backend architecture.

The shape to borrow:

```text
Automations page
  -> View templates
  -> Manual setup
  -> Create through chat
```

The Ling boundary to preserve:

```text
template/manual/chat input
  -> AutomationDraft
  -> validation and context preview
  -> explicit user confirmation
  -> AutomationDefinition
  -> AutomationRun
  -> LingThread + RunSession + artifacts
```

No creation path should bypass `AutomationDefinition`, approval policy, run sessions,
or automation thread history.

## Problem

Current P0/P1 Automations prove the backend and basic page, but the creation surface is
still too narrow:

- built-in templates are visible, but the user cannot browse a richer template library;
- custom/manual setup is not a first-class flow;
- chat cannot yet turn natural language intent into an auditable automation draft;
- editing prompt, target, schedule, and output shape is not ergonomic enough for repeated
  real use.

The desired experience is closer to:

- "Use this template for a weekly release note."
- "Manually create a daily project brief."
- "Through chat, turn my sentence into a scheduled automation, then let me confirm it."

## Goals

- Add three explicit creation modes:
  - template creation,
  - manual setup,
  - chat-assisted creation.
- Represent all creation paths as an `AutomationDraft` before saving.
- Make the draft reviewable and editable before it becomes an `AutomationDefinition`.
- Let users preview deterministic context before creating or running.
- Keep the Automations page operational and work-focused, not a landing page.
- Reuse the existing P0/P1 backend execution and scheduler model.
- Make chat creation safe by requiring explicit confirmation before durable write.

## Non-Goals

- No P2 project monitor implementation in this slice.
- No hidden agent-created automations.
- No direct schedule changes from ordinary chat without a confirmation draft.
- No cron editor.
- No cloud scheduler.
- No external destination sends.
- No Codex app-server or JSON-RPC migration.
- No new runner path.

## Creation Modes

### 1. Template Creation

User flow:

```text
open Automations
-> click View templates
-> select a template card
-> draft opens with prefilled title, prompt, trigger, target, and output
-> user edits fields
-> preview context
-> create automation
```

Template cards should behave like high-quality prompt presets. Each card should show:

- icon;
- short title;
- concise natural-language prompt summary;
- default cadence;
- default context selectors;
- risk or limitation note when useful.

Initial template library:

| Template | Default Trigger | Purpose |
| --- | --- | --- |
| Daily Brief | Daily 09:00 or manual | Summarize channel/project state, recent runs, approvals, and risks. |
| Weekly Review | Weekly Friday | Summarize PRs, releases, incidents, reviews, and follow-ups. |
| CI Failure Summary | Manual | Summarize failed CI windows and suggest likely repair paths. |
| Release Note Draft | Weekly/manual | Draft release notes from merged PRs and known changes. |
| Bug Scan | Manual | Inspect recent commits/runs for likely regressions with evidence. |
| Dependency Drift | Weekly/manual | Compare dependencies or SDK versions and suggest safe upgrades. |
| PR Risk Summary | Manual | Summarize current PR risk and missing evidence. |
| Ownership Suggestion | Manual | Suggest responsible owners based on files, CODEOWNERS, and history. |

Only enable templates whose required context exists. For unavailable templates, show a
disabled card with the missing prerequisite.

### 2. Manual Setup

User flow:

```text
open Automations
-> click Manual setup
-> enter title and prompt
-> choose target channel/project
-> choose trigger
-> choose output location
-> preview
-> create
```

Manual setup is for users who know exactly what they want. It should not require an
agent call.

Required fields:

- title;
- prompt;
- target channel or workspace target;
- trigger type;
- output policy.

Optional fields:

- description;
- teammate;
- provider preset;
- requested skill;
- allowed tools;
- approval mode;
- context selector tuning.

The UI should keep advanced execution policy collapsed by default.

### 3. Chat-Assisted Creation

User flow:

```text
open Automations
-> click Create through chat
-> user describes the automation
-> agent extracts a draft
-> Ling shows structured draft
-> user edits or asks follow-up
-> preview context
-> user confirms
-> save AutomationDefinition
```

Example user input:

```text
每天早上 9 点总结 Engineering 频道，重点看失败运行、待审批、最近 artifacts 和风险，
用中文输出到自动化线程。
```

The agent may propose:

```json
{
  "title": "Engineering Daily Brief",
  "kind": "daily_brief",
  "trigger": {
    "type": "schedule",
    "timezone": "Asia/Shanghai",
    "schedule": { "cadence": "daily", "timeOfDay": "09:00" },
    "missedRunPolicy": "skip"
  },
  "target": {
    "channelId": "channel_engineering"
  },
  "promptTemplate": {
    "promptMarkdown": "Write a Chinese daily brief for Engineering..."
  },
  "outputPolicy": {
    "destinations": [{ "type": "automation_thread" }, { "type": "markdown_artifact" }],
    "artifactFormat": "markdown"
  }
}
```

The agent must not save this directly. It creates an `AutomationDraft` only.

## AutomationDraft

Add a draft layer between user intent and durable automation definitions.

```ts
type AutomationDraftSource = "template" | "manual" | "chat";

type AutomationDraftStatus =
  | "draft"
  | "needs_user_input"
  | "ready_for_confirmation"
  | "confirmed"
  | "discarded";

interface AutomationDraft {
  readonly id: string;
  readonly source: AutomationDraftSource;
  readonly status: AutomationDraftStatus;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly title?: string;
  readonly description?: string;
  readonly kind?: AutomationKind;
  readonly trigger?: AutomationTrigger;
  readonly target?: AutomationTarget;
  readonly promptTemplate?: AutomationPromptTemplate;
  readonly executionPolicy?: AutomationExecutionPolicy;
  readonly outputPolicy?: AutomationOutputPolicy;
  readonly missingFields: readonly AutomationDraftField[];
  readonly warnings: readonly AutomationDraftWarning[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly proposedByRunId?: string;
  readonly proposedByThreadId?: string;
}
```

Drafts can start in memory for P1.5 if the UI confirms in the same session. If chat
creation spans reloads or multiple turns, drafts should be persisted in SQLite.

Recommended P1.5 approach:

- persist drafts;
- archive or discard stale drafts;
- keep confirmed draft linked to the created `AutomationDefinition`.

## Validation Rules

Every draft must be validated before creation:

- known `kind`;
- `project_monitor` remains rejected until P2;
- title is non-empty;
- prompt is non-empty;
- target channel exists when `channelId` is supplied;
- target path stays inside workspace;
- trigger is manual or schedule only;
- schedule has timezone and valid daily/weekly/interval fields;
- output destinations are limited to automation thread and markdown artifact;
- no raw secrets;
- no external sends;
- requested teammate, provider, skill, and runner exist if supplied;
- prompt cannot grant tools, secrets, approval bypass, memory scope, provider changes, or
  MCP access.

Validation output should distinguish:

- blocking errors: creation disabled;
- warnings: creation allowed but user must see caveat;
- missing fields: ask for input or highlight field.

## Chat Creation Safety

Chat creation has stricter rules than template/manual creation because a model is
involved.

Rules:

- agent output is a proposal, not a command;
- proposal must be rendered as structured fields;
- durable creation requires a user click;
- model text cannot set hidden fields not shown to the user;
- model text cannot enable risky tools or lower approval policy;
- model text cannot create external destinations;
- model text cannot create or mutate secrets;
- if target, schedule, or output are ambiguous, status becomes `needs_user_input`.

The confirmation event should be audited:

```text
AutomationDraft confirmed
-> AutomationDefinition created
-> LingThread created
-> optional context preview artifact created
```

## UI Structure

### Page Header

Automations page header:

```text
Automations
Run chat on demand or on schedule.

[View templates] [Create through chat v]
```

The dropdown can include:

- Create through chat;
- Manual setup.

### Template Modal

Template modal:

```text
Automation templates
[Manual setup] [Close]

2-column card grid
scrollable list
```

Card behavior:

- click card creates a draft from template;
- selected template opens draft panel;
- template text should be specific and evidence-bound;
- cards should not use long marketing copy.

### Manual Setup Modal

Manual setup modal:

```text
Title
Prompt

Target: channel/project
Schedule: manual/daily/weekly/interval
Output: automation thread + markdown artifact
Advanced: teammate/provider/tools/approval

[Preview] [Create]
```

Use compact controls:

- menus for target, schedule, output;
- segmented controls for trigger type;
- text area for prompt;
- icons where obvious.

### Chat Creation Drawer/Modal

Chat creation can use a modal with split behavior:

```text
left: chat transcript
right: structured draft
bottom: Preview / Confirm Create
```

For P1.5, keep it simpler:

```text
large prompt input
Generate draft
structured draft form
Preview
Create
```

Full multi-turn chat can come after the draft pipeline is stable.

## API Shape

P1.5 can add:

```http
GET /automation-templates?cwd=...
POST /automation-drafts?cwd=...
GET /automation-drafts/:draftId?cwd=...
PATCH /automation-drafts/:draftId?cwd=...
POST /automation-drafts/:draftId/preview?cwd=...
POST /automation-drafts/:draftId/confirm?cwd=...
DELETE /automation-drafts/:draftId?cwd=...
```

Request examples:

```ts
interface CreateAutomationDraftRequest {
  readonly source: "template" | "manual" | "chat";
  readonly templateId?: string;
  readonly prompt?: string;
  readonly partialAutomation?: Partial<CreateAutomationDefinitionInput>;
}

interface ConfirmAutomationDraftResponse {
  readonly cwd: string;
  readonly draft: AutomationDraft;
  readonly automation: AutomationDefinition;
  readonly thread: LingThread;
}
```

If implementation time is tight, template and manual drafts can be client-side first.
Chat-created drafts should be daemon-side because they need validation, audit, and model
proposal boundaries.

## Agent Flow for Chat Drafts

P1.5 should not require a new general-purpose agent runtime.

Recommended flow:

```text
POST /automation-drafts { source: "chat", prompt }
-> daemon builds a constrained extraction prompt
-> normal Ling run or lightweight provider call extracts draft JSON
-> validate JSON
-> store draft with proposedByRunId
-> return draft + warnings
```

The extraction prompt must instruct:

- produce JSON only;
- do not invent channel IDs;
- ask for missing fields instead of guessing;
- do not include raw secrets;
- do not request external destinations;
- keep tools and approval policy unchanged unless user explicitly chooses in UI.

If structured extraction fails:

- return `needs_user_input`;
- include a readable error;
- preserve the user's original text.

## Data Model Additions

SQLite table:

```sql
CREATE TABLE IF NOT EXISTS automation_drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  missing_fields_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  proposed_by_run_id TEXT,
  proposed_by_thread_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_automation_id TEXT,
  discarded_at TEXT
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_automation_drafts_status
ON automation_drafts(workspace_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_automation_drafts_confirmed_automation
ON automation_drafts(confirmed_automation_id);
```

## Web State

Extend `use-automations-domain` with:

- templates;
- active draft;
- draft validation state;
- draft preview state;
- creation mode;
- template modal state;
- chat/manual modal state.

Keep `AppShell` limited to view selection and callbacks.

## Template Content Guidelines

Templates must be evidence-bound:

- cite concrete Ling facts when possible;
- say "unknown" or "not found" when evidence is missing;
- avoid pretending to inspect external state;
- propose follow-ups as text;
- avoid broad refactors or cleanup by default;
- prefer small, reversible recommendations;
- never mutate files or external systems directly.

Good template prompt shape:

```text
Task: summarize the latest CI failures and unstable tests.

Rules:
- Use only supplied Ling context.
- Cite run IDs, test names, logs, artifact names, or file paths when present.
- Distinguish observed failures from hypotheses.
- Suggest the smallest next repair step.
- If evidence is insufficient, say what is missing.
```

Bad template prompt shape:

```text
Find all bugs and fix them automatically.
```

## Rollout Plan

### Slice 1: Template Library Refresh

- Add richer template metadata.
- Add template modal.
- Create draft from selected template.
- Keep confirmation path local and deterministic.

### Slice 2: Manual Setup

- Add manual setup modal.
- Validate fields.
- Preview context.
- Confirm creates `AutomationDefinition`.

### Slice 3: Draft Persistence

- Add `AutomationDraft` types and SQLite persistence.
- Add draft CRUD endpoints.
- Link confirmed draft to automation.

### Slice 4: Chat-Assisted Draft

- Add chat prompt input.
- Generate draft proposal.
- Validate and render structured fields.
- Confirm before creation.

### Slice 5: Polish and Audit

- Add warning badges.
- Add draft discard/retry.
- Add e2e coverage for all three modes.
- Update docs and screenshots.

## Testing

Core tests:

- draft create/update/discard/confirm;
- invalid JSON columns fail readably;
- confirmed draft links to created automation;
- stale draft filtering.

Daemon tests:

- template draft validates without runner;
- manual draft validates and confirms;
- chat draft never creates automation before confirmation;
- project monitor draft remains blocked;
- raw secret fields are rejected;
- external destinations are rejected;
- ambiguous chat input returns missing fields.

Web tests:

- View templates opens card grid;
- selecting template opens draft;
- manual setup creates an automation after preview;
- chat input produces a draft but does not create until confirm;
- disabled create button when required fields are missing;
- scheduler controls still work after new creation flow.

CLI tests:

- no new CLI required for P1.5 unless draft APIs become useful from scripts.

## Completion Criteria

P1.5 is complete when:

- Automations page has `View templates`, `Manual setup`, and `Create through chat`;
- all three modes produce a visible `AutomationDraft`;
- user can edit title, prompt, target, schedule, and output before confirmation;
- confirmation creates exactly one `AutomationDefinition` and one automation thread;
- chat-assisted mode cannot create or modify automation state without explicit confirm;
- P0/P1 manual run and scheduler behavior still pass unchanged.
