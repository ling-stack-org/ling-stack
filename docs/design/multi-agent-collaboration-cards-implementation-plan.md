# Multi-Agent Collaboration Cards Implementation Plan

Status: first implementation slice plan.
Date: 2026-06-13

Related docs:

- [Multi-Agent Collaboration Cards And Ambient Audit](multi-agent-collaboration-cards-and-ambient-audit.md)
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [Channel Context Processing Layer Implementation Plan](channel-context-processing-layer-implementation-plan.md)
- [Provider Presets](provider-presets.md)
- [Channel Context Budget Manager](channel-context-budget-manager.md)
- [State Machines and Recovery](state-machine-recovery.md)

## Purpose

This plan implements the first visible product loop from today's design work:

```text
provider capability auto
  -> CollaborationTaskCard read model
  -> compact progress projection
  -> existing ConversationWorkCell / right floating panel
  -> focused tests
```

It is intentionally narrow. Do not implement the full Context Processing Layer,
Requirement Shaping Card, new workflow storage, or a new workflow engine in this slice.

## Guardrails

- Collaboration task cards are read models over existing proposal/workflow/step/run/
  approval/packet records.
- Do not add a second workflow state machine.
- Do not rebuild the channel feed.
- Do not show raw ids, route JSON, context pack ids, token budgets, or raw logs in the
  default UI.
- Keep audit/debug metadata in existing evidence/detail surfaces.
- Keep token fields as optional provider overrides, not required setup.

## Existing Anchors

| Concern | Current anchor |
| --- | --- |
| Provider form state | `apps/web/src/lib/providers.ts` |
| Provider UI | `apps/web/src/features/providers/ProviderSettings.tsx` |
| Provider payload mapping | `apps/web/src/api/provider-payloads.ts` |
| Provider contracts | `packages/core/src/provider-types.ts`, `packages/contracts/src/providers.ts` |
| Provider templates | `packages/core/src/provider-templates.ts` |
| Context budget resolver | `packages/daemon/src/features/channels/context-packs.ts` |
| Workflow progress read model | `apps/web/src/lib/workflow-progress.ts` |
| Conversation work cell read model | `apps/web/src/lib/conversation-work-cell.ts` |
| Conversation work cell UI | `apps/web/src/shared/conversation/ConversationWorkCell.tsx` |
| Channel workspace assembly | `apps/web/src/features/workspace/WorkspaceClientView.tsx` |
| Channel e2e | `apps/web/e2e/channel.spec.ts` |
| Provider e2e | `apps/web/e2e/api-adapters.spec.ts`, `apps/web/e2e/settings.spec.ts` |
| Daemon channel tests | `packages/daemon/test/channel-workspace.test.mjs` |

## Phase CCI0: Baseline And Compatibility

Type: read-only.

### Work

- Confirm current provider preset form behavior for `contextWindow` and `maxTokens`.
- Confirm existing workflow progress model rows and attention popover rendering.
- Confirm existing workflow evidence/right-drawer drilldown remains available.

### Acceptance

- No behavior changes.
- Existing tests are identified before edits.

## Phase CCI1: Provider Capability Auto UI

Type: Web provider setup.

### Goal

Make context-window and max-output-token values optional advanced overrides.

### Work

- Keep `contextWindow` and `maxTokens` in persisted provider types for compatibility.
- Treat blank values as automatic in form-to-payload mapping.
- Move the inputs into an Advanced section in `ProviderSettings`.
- Add a compact capability status near model/provider setup:
  `Auto`, `Estimated`, `Conservative`, or `Custom override`.
- Existing templates may still prefill known values internally, but the UI should not
  force the user to understand token windows in the default path.

### Suggested model helper

```ts
type ProviderCapabilityUiState =
  | "auto"
  | "estimated"
  | "conservative"
  | "custom_override";

function deriveProviderCapabilityUiState(formOrProvider): ProviderCapabilityUiState;
```

### Tests

- Creating a custom provider with blank token fields succeeds.
- Existing provider with token values shows `Custom override`.
- Default sheet view does not show token inputs until Advanced is opened.
- Payload omits blank `contextWindow` and `maxTokens`.

### Non-goals

- No backend model metadata sync.
- No schema migration.
- No runtime-observed downgrade persistence.

## Phase CCI2: Collaboration Task Card Read Model

Type: Web read model first.

### Goal

Derive a product task-card model from existing workflow/proposal/step/run/approval data.

### Suggested file

```text
apps/web/src/lib/collaboration-task-card.ts
apps/web/src/lib/collaboration-task-card.test.ts
```

### Contract

```ts
export type CollaborationTaskCardMode =
  | "ready_for_confirmation"
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "summarizing"
  | "completed"
  | "failed"
  | "cancelled";

export interface CollaborationTaskCardModel {
  readonly id: string;
  readonly workflowId?: string;
  readonly proposalId?: string;
  readonly title: string;
  readonly mode: CollaborationTaskCardMode;
  readonly executionMode: "serial" | "parallel" | "mixed";
  readonly currentOwnerLabel?: string;
  readonly steps: readonly CollaborationStepCardModel[];
  readonly blocker?: string;
  readonly nextAction?: CollaborationNextActionModel;
}
```

### Derived status rules

| Card mode | Rule |
| --- | --- |
| `ready_for_confirmation` | Proposal exists and no workflow has started. |
| `queued` | Workflow exists, no active run, no blocker, at least one queued eligible step. |
| `running` | Any required step or linked run is active. |
| `waiting_for_approval` | Pending approval exists for active workflow/step/run. |
| `blocked` | Workflow or required current step is blocked. |
| `summarizing` | Workflow terminal state exists but no final display summary is available. |
| `completed` | Workflow succeeded or all required steps succeeded with summary. |
| `failed` | Workflow failed. |
| `cancelled` | Workflow cancelled. |

### Serial / parallel / fan-in summary rules

- Serial: show completed previous steps, one active step, and the next waiting step.
- Parallel: show branch-group rows or one row per active branch, capped to 3-6 rows for
  compact projection.
- Fan-in: show fan-in waiting until required terminal outputs exist; then show synthesis
  active/done.

### Tests

- Ready proposal maps to `ready_for_confirmation`.
- Running workflow maps to `running` with current owner.
- Pending approval maps to `waiting_for_approval`.
- Blocked required step maps to `blocked` and exposes one blocker.
- Succeeded workflow maps to `completed`.
- Parallel workflow produces branch summary rows without exposing raw ids.

### Non-goals

- No daemon endpoint in the first slice unless Web derivation becomes impractical.
- No new persistence table.
- No state transition writes.

## Phase CCI3: Compact Progress Projection

Type: Web presentation model.

### Goal

Render the right floating panel / attention popover as a compact progress summary for the
active collaboration task card.

### Suggested files

```text
apps/web/src/lib/collaboration-progress-projection.ts
apps/web/src/lib/collaboration-progress-projection.test.ts
apps/web/src/features/workspace/WorkspaceClientView.tsx
```

### Contract

```ts
export interface CollaborationProgressProjection {
  readonly taskTitle: string;
  readonly status: CollaborationTaskCardMode;
  readonly currentOwnerLabel?: string;
  readonly progressItems: readonly CollaborationProgressItem[];
  readonly blocker?: string;
  readonly nextAction?: CollaborationNextActionModel;
}
```

### Display rules

- Show 3-6 progress rows.
- Use check/running/waiting/blocked states.
- Show at most one blocker or next action.
- Hide audit/debug fields.
- Clicking opens smart details, not raw debug.

### Tests

- Long workflow is capped to 6 rows.
- Active step is included.
- Blocker is visible when present.
- Completed steps render before active/waiting rows.
- No raw ids appear in projection labels.

## Phase CCI4: Conversation Work Cell Integration

Type: Web integration.

### Goal

Use the collaboration task card model in existing conversation surfaces without
rebuilding the feed.

### Work

- Adapt `CollaborationTaskCardModel` into `ConversationWorkCellViewModel` where possible.
- Keep existing `WorkflowProgressModel` as the source for workflow evidence/details until
  the new model proves stable.
- Deduplicate represented step/run rows from the default feed as P3 already does.
- Add compact progress projection to the right floating panel or attention popover.

### Tests

- Active workflow still appears as one work cell.
- Right floating panel shows compact progress projection.
- Opening details still reaches workflow evidence/right drawer.
- Completed workflow folds into a compact summary.

### Non-goals

- No new full-screen workflow inspector.
- No raw audit rows in the default channel feed.

## Phase CCI5: Validation

Run narrow checks first:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
git diff --check
```

Focused tests to add or update:

- provider settings blank token fields and Advanced overrides;
- collaboration task card status derivation;
- compact progress projection row capping;
- channel e2e for active workflow compact progress;
- channel e2e for blocked/approval progress state.

## First-Slice Acceptance

- Users can create/edit a provider without seeing token fields in the default path.
- Advanced provider overrides remain available.
- Active collaboration work has a derived task card state.
- The right floating panel shows a compact progress checklist for active work.
- Default channel feed does not show raw audit/debug fields.
- Existing workflow evidence remains reachable through details.

## Deferred

- Requirement Shaping Card implementation.
- Full daemon-side task-card endpoint.
- Runtime-observed provider capability persistence.
- Per-branch stream expansion UI for all parallel workflows.
- Context Processing CP1-CP9 implementation.

## Phase CCI6: Right Panel Collaboration Task Card

Status: second implementation slice.

### Goal

Make the channel right-side Progress panel use `CollaborationTaskCardModel` as the
primary product surface for workflow-backed collaboration.

The right panel should answer these questions without exposing orchestration internals:

- What is Ling coordinating?
- Who owns the current step?
- Is the work serial, parallel, or mixed?
- What is done, active, waiting, blocked, or failed?
- What should the user do next?

### Scope

Implement Web UI only:

- derive task cards from existing `ChannelWorkflow`, `ChannelWorkflowStep`, `Run`, and
  `Approval` records;
- render active/recent cards in the existing `ChannelProgressPanel`;
- clicking a card opens the existing workflow evidence work cell;
- keep legacy task/run/approval summary cards below the collaboration card until the
  product card fully replaces them in a later slice.

Do not add:

- a daemon endpoint;
- a new persistence table;
- a second workflow engine;
- raw context pack, selector, route, token, or log rows in default UI.

### Right Panel Layout

```text
Progress

Collaboration task
  [status badge] [serial/parallel/mixed]
  title
  objective
  owner / next action / blocker
  compact step list, max 6 rows
  click -> Workflow evidence

Task / latest run / approvals
Attention
Approvals
CI triage
```

When `selectedWorkflowWorkCell` is open, the panel can continue showing workflow
evidence above or instead of the product card. The product card remains the default
entry point.

### Display Rules

- Show at most 3 task cards in the right panel, sorted by actionable priority then
  updated time.
- For each card, show at most 6 step rows.
- Step row labels use teammate label, step title, optional summary, and product state.
- Use product labels:
  - `Ready`
  - `Running`
  - `Waiting`
  - `Blocked`
  - `Completed`
  - `Failed`
  - `Cancelled`
- Use execution labels:
  - `Serial`
  - `Parallel`
  - `Mixed`
- Show one blocker line when blocked.
- Show one next-action line when available.
- Hide raw ids, source refs, token budgets, route JSON, selector decisions, and log paths.

### Interaction Rules

- Card click opens the existing workflow evidence detail by setting the selected workflow
  id.
- Approval rows still open the approval panel.
- Task/run cards still open existing task/run panels.
- No action button inside the task card should start or mutate workflow state in this
  slice; this keeps state changes delegated to existing workflow/run/approval controls.

### Acceptance

- Active/blocked/completed workflow cards appear in the right Progress panel.
- The card shows owner, execution mode, progress count, next action or blocker, and up
  to 6 step rows.
- Clicking the card opens the existing workflow evidence details.
- Default panel text contains no raw workflow ids, run ids, context ids, token budgets,
  or route/debug vocabulary.
- Existing channel and model workbench e2e remain green.

### Tests

- Add or update channel e2e to cover:
  - running workflow card;
  - blocked workflow card with blocker line;
  - clicking the card opens `Workflow evidence`;
  - raw ids are absent from the product card.

### Deferred From CCI6

- Feed-level task card rendering.
- Per-branch expandable stream transcript.
- Requirement shaping card.
- Daemon-side cached collaboration card endpoint.

## Phase CCI7: Feed Collaboration Task Card And Completion Folding

Status: third implementation slice.

### Goal

Make the default channel feed read like a collaboration timeline instead of exposing
workflow machinery.

Workflow-backed activity should still be represented by one existing
`ConversationWorkCell`, but the copy, active rows, and details entry point should be
driven by `CollaborationTaskCardModel`.

### Scope

Implement Web presentation only:

- derive a feed work-cell model from the existing collaboration task card plus workflow
  progress model;
- keep the existing `ConversationWorkCell` container, details loading, and workflow
  evidence drawer;
- hide run diagnostics from the default collaboration card surface;
- keep raw workflow/run/context/debug records inside details or developer surfaces;
- fold completed workflows into one final-result summary, with step/evidence detail
  available on demand.

Do not add:

- a daemon endpoint;
- a second workflow state machine;
- a new task-card table;
- a new permission or approval model;
- visible selector, auto-route, context pack id, token, log-path, or raw id rows in the
  default feed.

### Feed Display Rules

```text
Collaboration in progress / blocked / complete
  title
  product summary
  mode / step progress / pending approvals
  active rows only while work is active
  Details -> existing Workflow evidence
```

- Active cards show the current owner, next action or blocker, and compact step progress.
- Waiting cards show one approval-oriented row instead of raw approval ids.
- Blocked/failed cards show the blocker or failure summary.
- Completed cards do not keep streaming/process rows visible; they show the final result
  summary and let the user expand evidence only when needed.
- The default card should not present disabled diagnostics buttons.

### Acceptance

- Active workflow feed items still collapse represented workflow steps/runs into one
  visible card.
- The visible card uses collaboration labels rather than raw workflow labels.
- Completed workflow feed items show a final-result summary without active progress rows.
- Details still opens existing workflow evidence.
- Existing right-panel collaboration task card behavior remains unchanged.
- Channel e2e covers active and completed feed cards.

## Phase CCI8: Requirement Shaping Card

Status: fourth implementation slice.

### Goal

Make the pre-confirmation stage feel like Ling is shaping a requirement, not dumping raw
agent-to-agent discussion or a low-level route/proposal object.

This slice reuses the existing `ChannelExecutionProposal` draft as the source of truth.
It changes only the default presentation of a draft proposal.

### Scope

Implement Web presentation only:

- render `proposal.status === "draft"` as a compact requirement shaping card;
- show goal, scope, involved teammates, acceptance checks, risks, and open next action;
- keep the existing edit, cancel, and `Authorize and start task` controls;
- keep accepted proposals hidden from the default feed unless chat tools are open;
- keep the existing proposal mutation and confirm-workflow path.

Do not add:

- a new shaping table;
- a second proposal state machine;
- background specialist execution;
- raw selector/route/context/debug fields in the default card.

### Display Rules

```text
Ling is shaping the task
  title
  goal / proposed scope
  participants and contribution summary
  acceptance checks
  risk or missing boundary
  next action: authorize, edit, or cancel
```

- Collaboration summaries are visible by default as concise rows.
- Full details stay collapsed behind the existing collaboration disclosure.
- Permission confirmation remains visible for executable proposals.
- Long prompt/risk/criteria text wraps inside the card.

### Acceptance

- Draft proposal cards use requirement-shaping labels instead of raw task/proposal copy.
- The card still supports edit/save, cancel, and authorize/start.
- Collaboration participants are visible without opening raw audit/debug details.
- Confirming the card still creates the same workflow.
- Existing task confirmation e2e remains green with updated product copy.

## Phase CCI9: Final Ling Report

Status: fourth implementation slice.

### Goal

When a workflow finishes, the default feed should show a final Ling report: what happened,
what changed, what remains blocked, and where to open evidence.

This is a presentation read model over existing `CollaborationTaskCardModel` and
`WorkflowProgressModel`.

### Scope

Implement Web presentation only:

- add a final-report section to completed/failed/blocked collaboration work cells;
- derive the report from terminal step summaries, evidence stats, blockers, and existing
  workflow progress groups;
- keep details and evidence loading unchanged;
- keep raw logs and diagnostics behind explicit details/developer surfaces.

Do not add:

- a new persisted final report table;
- an LLM summarization pass;
- daemon-side report generation;
- new workflow transitions.

### Display Rules

```text
Final Ling report
  Outcome
  Evidence / changed files
  Blocker or next action
```

- Completed cards show outcome and evidence/change counts.
- Blocked/failed cards show blocker/failure and next action.
- The report stays compact: 2-4 rows.
- The old active progress stream remains hidden after terminal state.

### Acceptance

- Completed collaboration feed cards show `Final Ling report`.
- The report includes outcome and evidence/change information when available.
- Blocked or failed cards include blocker/failure as the user-actionable row.
- Opening workflow evidence still works.

## Deferred After CCI9

- Per-branch expandable stream transcript for all parallel workflows.
- Daemon-side cached collaboration card/report endpoint.
- Requirement shaping persistence beyond existing proposal records.
- LLM-authored final summary generation.

## Follow-Up Design: Collaboration Experience Enhancements

Status: detailed follow-up design for future implementation slices.

These slices improve the product experience without changing the current workflow/run/
approval state machines. They are intentionally separated from the CCI8/CCI9 PR so the
current collaboration-card work can land first.

### CCI10: Parallel Workflow Branch Expansion

Goal: let users inspect one parallel execution branch without turning the default channel
feed into multiple raw streams.

This is not channel branching. It is workflow-internal branching for one collaboration
task:

```text
Workflow task
  -> Engineer branch
  -> Designer branch
  -> QA branch
  -> Ling fan-in summary
```

Default UI:

- show the task as one `CollaborationTaskCard`;
- summarize parallel branches as compact rows;
- show one blocker or user action at the task level;
- keep raw run streams, context ids, and logs out of the feed.

Expanded UI:

- clicking a branch row expands only that branch;
- branch detail shows owner, state, latest concise stream line, terminal summary,
  changed/evidence count, blocker, and handoff target when available;
- branch expansion is local UI state and can be reset on navigation;
- opening evidence still uses the existing workflow evidence drawer.

State rules:

- branch state is derived from `ChannelWorkflowStep` plus linked run/approval state;
- optional branches do not block the parent card unless the workflow graph marks them
  required;
- fan-in appears only after required branches reach terminal allowed states;
- a failed required branch makes the parent card `blocked` or `failed` according to the
  existing workflow state.

Acceptance:

- parallel workflows still appear as one feed card by default;
- branch rows can be expanded one at a time without exposing raw ids;
- completed branch streams fold into branch summaries;
- blocked branches show the blocker and next action;
- details/evidence remain reachable through existing drawer controls.

Non-goals:

- no channel-tree branch changes;
- no new workflow engine;
- no persisted UI expansion state in this slice;
- no mobile-specific layout until mobile product definition is ready.

### CCI11: Rich Final Ling Report

Goal: upgrade the current read-model final report into a more complete outcome summary
without fabricating facts.

Current CCI9 behavior:

- derives outcome, evidence/change counts, blocker, and next action from existing records;
- does not call an LLM;
- does not persist a separate report.

Future rich report behavior:

- optionally generate a natural-language final report after workflow terminal state;
- use only trusted sources: terminal step summaries, output packets, changed artifacts,
  approvals, test/check records, blockers, and user-visible objective/criteria;
- cite changed paths and validation commands only when the underlying artifact/run record
  exists;
- when evidence is missing, say the report has no recorded evidence rather than guessing;
- keep the generated report editable/regenerable only through explicit user action.

Suggested sections:

```text
Outcome
Changed
Validated
Blockers / risks
Next action
```

Generation rules:

- completed workflows must include outcome and changed/evidence summary;
- blocked workflows must lead with blocker and next action;
- failed workflows must include failure reason if captured, otherwise a clear missing
  evidence note;
- cancelled workflows must not imply work completed;
- private teammate memory must not be quoted by default.

Storage options:

- first slice can keep the rich report as a derived UI summary;
- later slice may persist a `final_report` output packet linked to the workflow;
- persisted reports must remain invalidatable if terminal evidence changes.

Acceptance:

- final report is clear enough to answer "what happened?" without opening details;
- changed files and validation are shown only when backed by durable evidence;
- blocked/failed reports tell the user what can unblock the task;
- opening workflow evidence shows the source records.

Non-goals:

- no automatic claim that tests passed without run evidence;
- no raw log excerpts in the default report;
- no hidden LLM retry loop in the first rich-report slice.

### CCI12: Requirement Shaping Persistence

Goal: move beyond styling draft proposals as shaping cards only when the product needs
durable pre-execution collaboration state.

Current CCI8 behavior:

- reuses `ChannelExecutionProposal(status: draft)`;
- shows goal, acceptance, participants, boundary, and next action;
- edits continue through the existing proposal update API.

Future persistence behavior:

- introduce an explicit shaping record only if draft proposal data cannot represent open
  questions, user clarifications, and multi-turn requirement shaping cleanly;
- keep shaping state terminal once converted to proposal/workflow;
- link shaping records to source messages, visible teammate contributions, proposal id,
  and eventual workflow id;
- preserve existing proposal/workflow confirmation paths.

Candidate states:

```text
collecting_context
collecting_teammate_input
needs_user_clarification
ready_for_confirmation
converted_to_task
dismissed
```

Data boundaries:

- store product summaries and open questions, not raw selector JSON;
- store source refs and contribution ids for evidence, not full private memory quotes;
- keep permission grants out of shaping records;
- conversion to task still uses proposal confirmation and runtime approvals.

Acceptance:

- shaping can survive reload before task confirmation;
- user clarifications attach to the shaping card;
- conversion produces the same executable proposal/workflow path;
- dismissed shaping cards do not hide underlying messages from audit surfaces.

Non-goals:

- no separate agent session runtime;
- no replacement of `ChannelExecutionProposal`;
- no automatic execution from shaping state without explicit executable intent/confirmation.
