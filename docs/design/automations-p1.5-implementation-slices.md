# Automations P1.5 Implementation Slices

## Status

Implementation-ready breakdown for
[Automations P1.5: Codex-Inspired Creation Experience](automations-p1.5-creation-experience.md).

This document is narrower than the product design. It answers:

- which slice should land first;
- which files and contracts are affected;
- which APIs are added or deferred;
- what each slice must test before moving on.

## Source Decisions

P1.5 borrows the Codex-facing creation pattern:

```text
View templates
Manual setup
Create through chat
```

It does not borrow Codex backend architecture. Ling keeps the current execution path:

```text
AutomationDraft
  -> validation and preview
  -> explicit confirmation
  -> AutomationDefinition
  -> AutomationRun
  -> LingThread
  -> RunSession
```

Implementation must preserve these rules:

- no creation path writes an `AutomationDefinition` without user confirmation;
- chat output is a proposal, never a durable command;
- `project_monitor` remains blocked until P2;
- output destinations remain `automation_thread` and `markdown_artifact`;
- prompt text cannot grant tools, secrets, MCP access, provider changes, memory scope, or
  approval bypass;
- no Codex app-server, JSON-RPC, or new runner path is introduced.

## Upstream Codex Reference Check

Checked `openai/codex` at commit `87b808bb570f01f4b6fc8485c5459052fac0e320`.

Relevant findings:

- The open-source repo does not contain a reusable desktop Automations page or a durable
  Automations product backend to copy.
- `automation_update` appears as a dynamic deferred tool exposed to a Codex thread, not
  as an open-source automation storage/runtime implementation.
- The app-server architecture is a broad JSON-RPC v2 surface around `thread`, `turn`,
  `item`, approvals, filesystem, process execution, skills, plugins, MCP, and remote
  control. It is too heavy for Ling P1.5.
- Codex app-server uses an explicit initialize gate, bounded queues/backpressure, and
  per-resource request serialization scopes. Those are useful references only if Ling's
  daemon later sees slow-client or concurrency pressure.
- Codex thread storage separates canonical history append from explicit metadata writes.
  That supports Ling's existing decision to keep `AutomationDefinition`, `AutomationRun`,
  and `AutomationDraft` as explicit records instead of inferring durable state from chat
  history.
- Codex routes user approvals and tool user-input requests as first-class request/response
  events. For Ling, the equivalent is a visible draft review and explicit confirm button,
  not model-written automation state.
- Codex cloud task code separates task creation, task status, dry-run apply/preflight,
  and final apply. That maps well to Ling's draft preview then confirm flow.

Borrow for P1.5:

- dynamic-tool style mental model for "chat can propose an automation";
- explicit `needs_user_input` and confirmation states;
- per-resource serialization if draft confirmation becomes concurrent;
- preflight/preview before durable write;
- thread linkage and metadata kept separate from transcript history.

Do not borrow for P1.5:

- app-server JSON-RPC transport;
- the full thread/turn/item protocol;
- cloud task backend;
- dynamic tool registration as the primary Web API;
- any new runner path.

## Current Baseline

P0/P1 already provide the anchors P1.5 should extend:

| Area | Current Anchor |
| --- | --- |
| Automation types | `packages/core/src/automation-types.ts` |
| Built-in template data | `packages/core/src/automation-templates.ts` |
| SQLite automations store | `packages/core/src/storage/sqlite-run-store.ts` |
| Public contracts | `packages/contracts/src/index.ts` |
| Daemon routes | `packages/daemon/src/features/automations/routes.ts` |
| Daemon schemas | `packages/daemon/src/features/automations/schemas.ts` |
| Automation context preview | `packages/daemon/src/features/automations/context.ts` |
| API client | `packages/api-client/src/client.ts` |
| Web API wrapper | `apps/web/src/api.ts` |
| Web domain state | `apps/web/src/domains/automations/use-automations-domain.ts` |
| Web page | `apps/web/src/features/automations/AutomationsPage.tsx` |
| Web styles | `apps/web/src/styles/automations.css` |
| Existing tests | `packages/core/test/automations-store.test.mjs`, `packages/daemon/test/automations-api.test.mjs`, `apps/web/e2e/app.spec.ts` |

The current Web `createFromTemplate` path creates automations immediately. P1.5 should
replace that with draft-first creation.

## Slice Order

The product-visible priority is templates, manual setup, then chat. The implementation
order should still start with a thin draft core because both templates and manual setup
need the same review form and validation.

```text
P1.5a Draft Core
  -> shared draft contracts
  -> validation helper
  -> confirm adapter to existing create automation path

P1.5b Template Creation
  -> richer template library
  -> template modal
  -> template draft review

P1.5c Manual Setup
  -> manual draft form
  -> schedule/output controls
  -> preview and confirm

P1.5d Draft Persistence
  -> SQLite automation_drafts
  -> draft CRUD API
  -> draft preview API
  -> confirmation audit link

P1.5e Chat-Assisted Creation
  -> constrained extraction
  -> daemon-side draft proposal
  -> explicit user confirmation

P1.5f Polish and Regression
  -> disabled states
  -> audit badges
  -> e2e coverage
```

P1.5b and P1.5c may initially use client-held drafts if P1.5d is not ready, but they
must still render a visible draft review before confirmation. P1.5e must not ship before
P1.5d because chat proposals need persistence, validation, and audit linkage.

## P1.5a Draft Core

### Goal

Create one shared draft shape and validation path so template and manual creation do not
duplicate state.

### Files

Update:

```text
packages/core/src/automation-types.ts
packages/core/src/index.ts
packages/contracts/src/index.ts
packages/daemon/src/features/automations/schemas.ts
apps/web/src/types.ts
```

Optional new file:

```text
packages/core/src/automation-drafts.ts
```

### Contracts

Add:

```ts
export type AutomationDraftSource = "template" | "manual" | "chat";

export type AutomationDraftStatus =
  | "draft"
  | "needs_user_input"
  | "ready_for_confirmation"
  | "confirmed"
  | "discarded";

export type AutomationDraftField =
  | "title"
  | "kind"
  | "trigger"
  | "target"
  | "promptTemplate"
  | "outputPolicy";

export interface AutomationDraftWarning {
  readonly code: string;
  readonly message: string;
  readonly field?: AutomationDraftField;
}

export interface AutomationDraft {
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
  readonly confirmedAutomationId?: string;
  readonly discardedAt?: string;
}
```

Add a pure helper:

```ts
validateAutomationDraft(draft: AutomationDraft): AutomationDraft;
```

Validation should not touch SQLite or the model. It should only derive:

- `missingFields`;
- `warnings`;
- `status`.

### Confirmation Adapter

Add a mapping helper that converts a validated draft to the existing create request:

```ts
automationDraftToCreateRequest(draft: AutomationDraft): CreateAutomationDefinitionInput;
```

It must fail if:

- draft status is not `ready_for_confirmation`;
- required fields are missing;
- kind is `project_monitor`;
- trigger is monitor;
- output includes anything other than automation thread or markdown artifact.

### Tests

Core tests:

- incomplete draft returns `needs_user_input`;
- valid template/manual draft returns `ready_for_confirmation`;
- `project_monitor` returns blocking warning or error;
- secret-like fields are rejected or warned before conversion;
- conversion fails unless draft is ready.

## P1.5b Template Creation

### Goal

Replace immediate template creation with:

```text
View templates
-> select template
-> draft review opens
-> preview
-> confirm create
```

### Files

Update:

```text
packages/core/src/automation-templates.ts
packages/contracts/src/index.ts
packages/daemon/src/features/automations/routes.ts
apps/web/src/domains/automations/use-automations-domain.ts
apps/web/src/features/automations/AutomationsPage.tsx
apps/web/src/styles/automations.css
```

Recommended new Web components:

```text
apps/web/src/features/automations/AutomationTemplateModal.tsx
apps/web/src/features/automations/AutomationDraftPanel.tsx
```

### Template Metadata

Expand `BuiltinAutomationTemplate` from two simple templates into richer card metadata:

```ts
interface BuiltinAutomationTemplate {
  readonly id: string;
  readonly kind: BuiltinAutomationTemplateKind;
  readonly title: string;
  readonly summary: string;
  readonly description: string;
  readonly category: "briefing" | "review" | "quality" | "release" | "maintenance";
  readonly defaultTrigger: AutomationTrigger;
  readonly defaultPromptTemplate: AutomationPromptTemplate;
  readonly defaultExecutionPolicy: AutomationExecutionPolicy;
  readonly defaultOutputPolicy: AutomationOutputPolicy;
  readonly requirements: readonly AutomationTemplateRequirement[];
  readonly riskNote?: string;
}
```

Initial enabled templates should stay conservative:

- Daily Brief;
- Weekly Review;
- CI Failure Summary;
- Release Note Draft;
- Bug Scan;
- Dependency Drift;
- PR Risk Summary;
- Ownership Suggestion.

If a template depends on context Ling cannot currently provide, return it disabled with
a clear requirement reason instead of hiding it.

### Web Behavior

Change the page header to:

```text
Automations
Run chat on demand or on schedule.

[View templates] [Create through chat v]
```

Template click should call:

```text
createDraftFromTemplate(templateId)
```

not:

```text
createAutomation(...)
```

The draft panel must show:

- title;
- prompt;
- target channel;
- trigger;
- output policy;
- warnings;
- Preview button;
- Create button.

### API Decision

For this slice, it is acceptable to keep template retrieval inside existing
`GET /automations?cwd=...` because that response already returns `templates`.

Do not add `GET /automation-templates` unless the template library grows enough to need
filtering or pagination.

### Tests

Daemon/API tests:

- list automations includes richer templates;
- disabled templates include requirement reason;
- template data never includes external destinations or write-capable default tools.

Web tests:

- View templates opens the modal;
- clicking a template opens a draft instead of creating immediately;
- Create is disabled until required fields are valid;
- confirming the draft creates exactly one automation.

## P1.5c Manual Setup

### Goal

Add a first-class manual form for users who already know the title, prompt, target, and
schedule.

### Files

Recommended new Web component:

```text
apps/web/src/features/automations/AutomationManualSetupModal.tsx
```

Update:

```text
apps/web/src/domains/automations/use-automations-domain.ts
apps/web/src/features/automations/AutomationsPage.tsx
apps/web/src/styles/automations.css
```

### Form Fields

Required:

- title;
- prompt;
- target channel or workspace target;
- trigger;
- output policy.

Optional:

- description;
- teammate;
- provider preset;
- requested skill;
- allowed read-only tools;
- approval profile;
- context selectors.

Keep advanced execution policy collapsed by default.

### Trigger Controls

Supported in P1.5:

- manual;
- daily time;
- weekly weekday and time;
- interval with bounded minimum.

Still excluded:

- cron syntax;
- monitor trigger;
- cloud schedule;
- external notification destinations.

### Preview

If P1.5d has not landed yet, manual setup can show a local prompt/selector preview but
must label it as field preview only. The real deterministic context preview should land
with the draft preview endpoint in P1.5d.

Once P1.5d lands, `Preview` should call:

```http
POST /automation-drafts/:draftId/preview?cwd=...
```

### Tests

Web tests:

- Manual setup opens from the create dropdown;
- title/prompt/target validation is visible;
- daily and weekly controls produce valid `AutomationTrigger`;
- monitor/cron choices are not available;
- confirming creates one automation and one automation thread.

## P1.5d Draft Persistence and APIs

### Goal

Make drafts durable, auditable, and previewable before enabling chat-assisted creation.

### Files

Update:

```text
packages/core/src/automation-types.ts
packages/core/src/storage/sqlite-run-store.ts
packages/contracts/src/index.ts
packages/api-client/src/client.ts
apps/web/src/api.ts
packages/daemon/src/server/routes.ts
packages/daemon/src/features/automations/routes.ts
packages/daemon/src/features/automations/schemas.ts
packages/daemon/test/automations-api.test.mjs
packages/core/test/automations-store.test.mjs
packages/api-client/test/client.test.mjs
```

Optional new files:

```text
packages/daemon/src/features/automations/drafts.ts
packages/daemon/src/features/automations/draft-routes.ts
```

### Store Methods

Extend `RunStore`:

```ts
createAutomationDraft(input: CreateAutomationDraftInput, now: string): AutomationDraft;
getAutomationDraft(draftId: string): AutomationDraft | undefined;
listAutomationDrafts(options?: ListAutomationDraftsOptions): AutomationDraft[];
updateAutomationDraft(draftId: string, input: UpdateAutomationDraftInput, now: string): AutomationDraft | undefined;
discardAutomationDraft(draftId: string, now: string): AutomationDraft | undefined;
confirmAutomationDraft(draftId: string, automationId: string, now: string): AutomationDraft | undefined;
```

### SQLite Migration

Add:

```sql
CREATE TABLE IF NOT EXISTS automation_drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  missing_fields_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  proposed_by_run_id TEXT,
  proposed_by_thread_id TEXT,
  confirmed_automation_id TEXT,
  discarded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY(confirmed_automation_id) REFERENCES automation_definitions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_automation_drafts_status
ON automation_drafts(workspace_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_automation_drafts_confirmed_automation
ON automation_drafts(confirmed_automation_id);
```

### API

Add:

```http
GET /automation-drafts?cwd=...
POST /automation-drafts?cwd=...
GET /automation-drafts/:draftId?cwd=...
PATCH /automation-drafts/:draftId?cwd=...
POST /automation-drafts/:draftId/preview?cwd=...
POST /automation-drafts/:draftId/confirm?cwd=...
DELETE /automation-drafts/:draftId?cwd=...
```

Contracts:

```ts
interface CreateAutomationDraftRequest {
  readonly source: AutomationDraftSource;
  readonly templateId?: string;
  readonly prompt?: string;
  readonly partialAutomation?: Partial<CreateAutomationRequest>;
}

interface AutomationDraftMutationResponse {
  readonly cwd: string;
  readonly draft: AutomationDraft;
}

interface AutomationDraftPreviewResponse {
  readonly cwd: string;
  readonly draft: AutomationDraft;
  readonly context: AutomationContextPreview;
}

interface ConfirmAutomationDraftResponse {
  readonly cwd: string;
  readonly draft: AutomationDraft;
  readonly automation: AutomationDefinition;
  readonly thread?: LingThread;
}
```

### Confirm Semantics

`POST /automation-drafts/:draftId/confirm` must:

1. reload the latest draft from SQLite;
2. validate again server-side;
3. reject if not `ready_for_confirmation`;
4. create exactly one `AutomationDefinition`;
5. create or link exactly one automation `LingThread`;
6. update draft status to `confirmed`;
7. set `confirmed_automation_id`;
8. return the draft, automation, and thread.

Repeated confirm should not create a second automation. It should return the already
confirmed automation if `confirmed_automation_id` is present.

### Preview Semantics

Draft preview should reuse the existing context builder. If the context builder currently
requires a full `AutomationDefinition`, create an internal unsaved definition-like object
from the draft after validation.

Preview must not:

- create `AutomationRun`;
- create `RunSession`;
- write output artifacts unless the existing preview path intentionally records a preview
  artifact after confirmation.

### Tests

Core tests:

- create/list/update/discard drafts;
- invalid JSON reads fail readably;
- confirm links draft to automation;
- repeated confirm is idempotent;
- stale discarded draft cannot confirm.

Daemon tests:

- draft CRUD requires `cwd`;
- template/manual draft validates without a runner;
- preview returns context without creating automation run;
- confirm creates exactly one automation and thread;
- project monitor draft is rejected;
- external destination and raw secrets are rejected.

API client tests:

- client methods encode `cwd` and draft ids correctly;
- confirm response is typed.

## P1.5e Chat-Assisted Creation

### Goal

Turn natural language into an auditable draft proposal without allowing the model to
write durable automation state directly.

### Files

Recommended new daemon files:

```text
packages/daemon/src/features/automations/chat-draft.ts
packages/daemon/src/features/automations/chat-draft-prompt.ts
```

Update:

```text
packages/daemon/src/features/automations/routes.ts
packages/daemon/src/features/automations/schemas.ts
apps/web/src/domains/automations/use-automations-domain.ts
apps/web/src/features/automations/AutomationsPage.tsx
```

Recommended new Web component:

```text
apps/web/src/features/automations/AutomationChatCreateModal.tsx
```

### Flow

```text
POST /automation-drafts { source: "chat", prompt }
-> daemon builds constrained extraction prompt
-> existing Ling/provider path extracts draft JSON
-> daemon validates JSON
-> daemon stores AutomationDraft with proposedByRunId when available
-> Web renders structured draft
-> user edits or confirms
```

The model may fill:

- title;
- kind;
- prompt text;
- trigger;
- target hint if explicitly named and resolvable;
- context selector suggestions;
- output policy within allowed destinations.

The model may not fill:

- hidden approval bypass;
- secrets;
- external destinations;
- write-capable tool grants;
- unknown channel ids;
- provider or runner changes unless the user explicitly selected them in UI.

### Extraction Prompt Rules

The extraction prompt must say:

- output JSON only;
- do not invent ids;
- if target, schedule, or output is ambiguous, return missing fields;
- use supplied channel/template metadata only;
- never include raw secrets;
- never request external sends;
- never request tools outside the displayed UI.

### Failure Behavior

If extraction fails:

- create or return a draft with status `needs_user_input`;
- preserve the original user prompt;
- show a user-readable warning;
- do not create an automation.

### Tests

Daemon tests:

- chat draft does not create an automation before confirm;
- ambiguous prompt returns missing fields;
- hallucinated channel id is rejected;
- model-proposed external destination is rejected;
- model-proposed approval bypass is rejected;
- extraction failure preserves user prompt and returns `needs_user_input`.

Web tests:

- Create through chat opens modal;
- Generate draft renders structured fields;
- Create remains disabled until draft is valid;
- Confirm creates one automation;
- closing the modal does not silently save.

## P1.5f Polish and Regression

### Goal

Make the feature feel stable enough to use repeatedly.

### Required UX States

- empty template library;
- disabled template with missing requirement;
- draft with missing title;
- draft with invalid schedule;
- preview loading;
- confirm loading;
- confirm success;
- confirm failure;
- discarded draft;
- already confirmed draft;
- chat extraction failure.

### Regression Checks

Run:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web test:e2e
git diff --check
```

For targeted early slices, the minimum gate is:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/web typecheck
git diff --check
```

## Implementation Status: 2026-06-06

Implemented in this slice:

- `AutomationDraft` core contracts, validation helpers, and confirm adapter.
- Richer built-in template metadata with stable `templateId` values while keeping
  non-core templates as `custom_prompt`.
- Durable `automation_drafts` SQLite table and `RunStore` CRUD/confirm/discard methods.
- Daemon draft APIs:
  `GET/POST /automation-drafts`,
  `GET/PATCH/DELETE /automation-drafts/:draftId`,
  `POST /automation-drafts/:draftId/preview`,
  `POST /automation-drafts/:draftId/confirm`.
- Draft preview reuses the existing automation context builder and does not create
  automation runs.
- Draft confirmation creates one automation thread and one automation definition, and
  repeated confirmation returns the existing confirmed automation.
- Web Automations creation surface now exposes template, manual, and chat modes; all
  three create a visible draft review before confirmation.
- Chat-assisted creation stores a proposal draft only. It never creates or mutates an
  automation definition without the explicit confirm action.

Validation added:

- core SQLite draft lifecycle test;
- daemon draft API preview/confirm/idempotency/chat-boundary test;
- api-client draft route/body test;
- web Automations e2e updated to the draft-first template flow.

## Ship Boundaries

### Good P1.5 MVP

P1.5 can be considered usable when:

- `View templates` opens a richer template modal;
- selecting a template opens a draft review instead of creating immediately;
- `Manual setup` creates a draft with validation;
- draft confirmation creates exactly one automation;
- chat-assisted creation is either absent or draft-only with explicit confirmation;
- P0/P1 run, preview, archive, and scheduler behavior still pass.

### Not Required for P1.5

- multi-turn draft repair chat;
- cron editor;
- project monitors;
- cloud scheduler;
- external notifications;
- external action destinations;
- general Codex-style app-server transport.

## Main Risk

The main risk is letting chat creation become a hidden write path. The guardrail is
simple: model output can only create or update `AutomationDraft`; only the user's confirm
action can create `AutomationDefinition`.
