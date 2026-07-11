# Ling Agent TerminalReport Implementation Plan

Status: implemented; final verification and rollout in progress
Date: 2026-07-11
Source design: [Ling Agent TerminalReport Protocol](ling-agent-terminal-report-protocol.md)

Related docs:

- [Ling Agent Session Control Plane](ling-agent-session.md)
- [Ling Agent Session Implementation Plan](ling-agent-session-implementation-plan.md)
- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)
- [Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md)
- [Execution And Orchestration Hardening Implementation Plan](execution-orchestration-hardening-implementation-plan.md)
- [Conversation Surface Contract](conversation-surface-contract.md)

## Objective

Replace the current workflow terminal path:

```text
last non-generic workflow-step resultSummary
  -> deterministic Done / Result message
```

with an evidence-backed, validated, durable terminal report path:

```text
terminal workflow / run / executed turn
  -> TerminalReportEvidenceSnapshot
  -> deterministic fallback or model synthesis
  -> TerminalReport validation
  -> durable report record
  -> one Ling coordinator publication
  -> final_result conversation projection
```

The implementation must preserve the current workflow, run, approval, operation,
artifact, and transcript records. The first slices are additive and must not require a
flag-day migration.

## Locked Implementation Decisions

This plan resolves the implementation choices left open by the detailed design.

1. **Domain types live in core.** Add focused modules instead of expanding the already
   large `workspace-types.ts` or `run-types.ts` files.
2. **Wire DTOs live in contracts.** API, Web, Desktop, and future CLI consumers use
   `packages/contracts/src/terminal-reports.ts`.
3. **Use a first-class SQLite table immediately.** Artifact-only persistence cannot
   cleanly support cross-run workflow reports, source-generation uniqueness, publication
   ownership, or lookup by channel/thread.
4. **Store snapshot and report bodies as JSON columns.** Keep the table narrow and allow
   schema evolution without normalizing every report section into relational tables.
5. **Initial synthesis uses the existing runner adapter.** Run a read-only, no-tools
   `channel_terminal_report` work unit through Ling's configured provider.
6. **Initial structured output is strict JSON plus validation.** Current runner adapters
   do not expose a common final-output JSON schema capability. Add native structured
   output only after adapter capability design exists.
7. **One repair attempt maximum.** Invalid output gets one validation-error retry, then
   deterministic fallback.
8. **Fallback ships before model synthesis.** This proves evidence collection,
   persistence, idempotency, publication, and UI independently from model quality.
9. **Feature flag during rollout.** Add `channels.terminalReports`; keep it disabled until
   fallback publication passes focused daemon/Web acceptance, then enable by default
   before removing the old path.
10. **No historical prose parsing or automatic backfill.** Existing terminal messages
    remain history. New reports apply to newly terminal work.

## Initial Runtime Budgets

Use explicit bounded defaults in the first implementation:

| Budget | Default |
| --- | --- |
| Reporting barrier deadline | 5 seconds |
| Reporting barrier poll interval | 250 milliseconds |
| Synthesis attempt timeout | 45 seconds |
| Maximum synthesis attempts | 2 total |
| Snapshot steps | 100 |
| Snapshot operations | 200 |
| Snapshot checks | 100 |
| Snapshot artifacts | 100 |
| Snapshot participants | 20 |
| Snapshot risks | 50 |
| Per summary field | 2,000 characters |
| Total rendered synthesis input | provider-budgeted, target under 24,000 tokens |

Truncation must add diagnostics and preserve source counts. It must not silently turn an
incomplete snapshot into a fully verified report.

## Existing Anchors

| Concern | Current anchor |
| --- | --- |
| Step terminal reconciliation | `packages/daemon/src/features/channels/orchestrator.ts` |
| Terminal coordinator message | `packages/daemon/src/features/channels/workflows.ts` |
| Workflow evidence aggregation | `packages/daemon/src/features/channels/workflows.ts#buildWorkflowEvidence` |
| Step output packets | `packages/daemon/src/features/channels/workflow-step-packets.ts` |
| Session final result compatibility view | `packages/daemon/src/features/channels/ling-agent-session-view.ts` |
| Existing terminal-summary regression | `packages/daemon/test/workflow-terminal-summary.test.mjs` |
| Channel AI model invocation | `packages/daemon/src/features/channels/ai-replies.ts` |
| Strict JSON model patterns | `packages/daemon/src/features/channels/channel-message-router.ts`, `channel-intent-selector.ts` |
| Runtime work-unit kinds | `packages/core/src/runtime-supervisor-types.ts` |
| Runtime work-unit route validation | `packages/daemon/src/runtime/routes.ts` |
| SQLite store composition | `packages/core/src/storage/sqlite-run-store.ts` |
| SQLite migrations | `packages/core/src/storage/sqlite/migrations.ts` |
| API DTOs | `packages/contracts/src/*.ts` |
| Work-cell terminal rows | `packages/conversation-ui-core/src/work-cell-view-model.ts#terminalReportRows` |
| Workflow work-cell projection | `apps/web/src/lib/workflow-progress.ts` |
| Run/thread work-cell projection | `apps/web/src/lib/conversation-work-cell.ts` |
| Shared transcript renderer | `apps/web/src/shared/conversation/blocks/TranscriptBlockView.tsx` |
| Shared work-cell renderer | `apps/web/src/shared/conversation/blocks/ConversationWorkCell.tsx` |
| Web acceptance | `apps/web/e2e/channel.spec.ts`, normal/private conversation specs |

## Target Module Boundaries

```text
packages/core/src/
  terminal-report-types.ts
  terminal-report-validation.ts
  terminal-report-fallback.ts
  terminal-report-projection.ts

packages/contracts/src/
  terminal-reports.ts

packages/core/src/storage/sqlite/
  terminal-report-store.ts
  terminal-report-mappers.ts

packages/daemon/src/features/channels/
  terminal-report-evidence.ts
  terminal-report-prompt.ts
  terminal-report-synthesis.ts
  terminal-report-coordinator.ts
  terminal-report-publisher.ts
  terminal-report-routes.ts

packages/conversation-ui-core/src/
  terminal-report-view-model.ts

apps/web/src/shared/conversation/blocks/
  TerminalReportBlock.tsx
  TerminalReportParticipants.tsx
```

Responsibilities:

- Core types and validation remain pure and storage-independent.
- Core fallback/projection operates only on typed snapshots/reports.
- Daemon collects store evidence and owns provider/runtime integration.
- Contracts expose stable response DTOs, not SQLite row shapes.
- Conversation UI core converts the report into semantic render rows.
- React components render view models and preserve disclosure state.

## Delivery Sequence

| Slice | Deliverable | Runtime behavior change | Dependency |
| --- | --- | --- | --- |
| TR0 | Baseline fixtures and acceptance matrix | None | None |
| TR1 | Core/contracts protocol and validation | None | TR0 |
| TR2 | Durable report storage and APIs | None | TR1 |
| TR3 | Evidence snapshot and deterministic fallback | Internal only | TR2 |
| TR4 | Reporting coordinator and fallback publication behind flag | Flagged | TR3 |
| TR5 | Model synthesis and repair fallback | Flagged | TR4 |
| TR6 | Shared conversation projection and Web UI | Flagged | TR4 |
| TR7 | Normal/private-chat coverage and rollout enablement | User-visible default | TR5-TR6 |
| TR8 | Legacy cleanup and hardening | Removes old ownership | TR7 |

Each slice should be a separate PR unless a later slice is mechanically tiny and all
preceding gates already pass.

## TR0: Baseline Fixtures And Acceptance Matrix

### Goal

Freeze current behavior and create report fixtures before changing persistence or UI.

### Changes

Add fixtures representing:

1. single-run edit plus one passing typecheck;
2. multi-step/multi-agent workflow with changed files and checks;
3. QA failure followed by Engineer round two;
4. approved post-step gate and final workflow success;
5. blocked approval;
6. cancelled run with partial artifact;
7. no-artifact/no-participant completion;
8. PR/commit/service-status evidence;
9. invalid synthesis output with fallback;
10. secret-adjacent evidence excluded from visible fields.

Target files:

```text
packages/core/test/fixtures/terminal-reports/*.json
packages/daemon/test/fixtures/terminal-reports/*.json
apps/web/src/shared/conversation/fixtures/conversation-transcript-fixtures.ts
docs/design/ling-agent-terminal-report-implementation-plan.md
```

### Baseline Assertions

- Current terminal coordinator reply still preserves the full final step summary.
- Current workflow/session views expose changed paths, checks, approvals, and artifacts.
- Current Web work-cell `terminalReportRows` is empty and does not yet own final result
  rendering.
- Existing process-history disclosure behavior remains the visual baseline.

### Verification

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/web typecheck
```

### Exit Gate

Fixtures and acceptance assertions are committed without changing production behavior.

## TR1: Protocol Types, DTOs, And Validation

### Goal

Create a stable typed contract and fail-closed validator before any report is persisted.

### Core Changes

Add:

```text
packages/core/src/terminal-report-types.ts
packages/core/src/terminal-report-validation.ts
packages/core/src/terminal-report-fallback.ts
packages/core/src/terminal-report-projection.ts
```

`terminal-report-types.ts` contains:

- `TerminalReportSourceRef`;
- `TerminalReportEvidenceSnapshot` and nested evidence types;
- `TerminalReport` and nested semantic result types;
- `LingTerminalReportRecord`;
- create/update/list input types;
- id helpers and status enums.

`terminal-report-validation.ts` contains:

- structural parsing from `unknown`;
- snapshot/report validation;
- claim-to-evidence validation;
- privacy validation;
- stable validation error codes;
- deterministic evidence fingerprint calculation.

`terminal-report-fallback.ts` initially exports pure function signatures and can land
with minimal behavior. Full fallback composition is completed in TR3.

`terminal-report-projection.ts` contains compatibility adapters:

```ts
function terminalReportToLingAgentFinalResultView(...): LingAgentFinalResultView;
function terminalReportToTranscriptBlock(...): TranscriptBlock;
```

Keep daemon-local compatibility types until TR6; avoid circular dependencies by defining
pure intermediate projection types in core where needed.

### Contracts Changes

Add:

```text
packages/contracts/src/terminal-reports.ts
```

Export:

- `TerminalReportResponse`;
- `TerminalReportListResponse`;
- `TerminalReportInspectResponse`;
- report/snapshot DTOs needed by Web;
- no SQLite-specific fields.

Update:

```text
packages/contracts/src/index.ts
packages/core/src/index.ts
```

### Validation Rules Implemented In TR1

- schema version and enum validation;
- non-empty ids and titles;
- unique section item ids;
- source refs resolve inside the snapshot;
- terminal outcome compatibility;
- `passed`/`failed` checks require check evidence;
- changed paths and line counts require matching evidence;
- participant activity requires workflow/run/contribution evidence;
- PR/commit/deployment claims require external refs;
- secret-adjacent source content cannot become visible copy.

### Tests

Add:

```text
packages/core/test/terminal-report-validation.test.mjs
packages/core/test/terminal-report-fingerprint.test.mjs
packages/core/test/terminal-report-projection.test.mjs
```

### Verification

```bash
corepack pnpm --filter @ling-stack/contracts typecheck
corepack pnpm --filter @ling-stack/core test
```

### Exit Gate

All protocol fixtures either validate successfully or fail with the expected stable code.
No daemon path creates a report yet.

## TR2: Durable Storage And Store API

### Goal

Persist report lifecycle and idempotency independently from channel-message prose.

### Migration

Add migration constant and table in:

```text
packages/core/src/storage/sqlite/migrations.ts
```

Target schema:

```sql
CREATE TABLE IF NOT EXISTS ling_terminal_reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT,
  thread_id TEXT,
  turn_id TEXT,
  source_message_id TEXT,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  outcome_status TEXT,
  language TEXT NOT NULL,
  evidence_snapshot_json TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  report_json TEXT,
  synthesis_mode TEXT,
  prompt_version TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  validation_codes_json TEXT NOT NULL DEFAULT '[]',
  published_message_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT,
  UNIQUE (workspace_id, source_kind, source_id, generation)
);

CREATE INDEX IF NOT EXISTS idx_ling_terminal_reports_channel_thread
ON ling_terminal_reports(workspace_id, channel_id, thread_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ling_terminal_reports_fingerprint
ON ling_terminal_reports(workspace_id, evidence_fingerprint);
```

Keep report and snapshot JSON bounded by validation before writes.

### Store Modules

Add:

```text
packages/core/src/storage/sqlite/terminal-report-store.ts
packages/core/src/storage/sqlite/terminal-report-mappers.ts
```

Update:

```text
packages/core/src/storage/sqlite-run-store.ts
packages/core/src/run-types.ts
packages/core/src/storage/sqlite/select-sql.ts
```

Store API:

```ts
createTerminalReportDraft(input, now): LingTerminalReportRecord;
getTerminalReport(id): LingTerminalReportRecord | undefined;
getTerminalReportForSource(sourceKind, sourceId, generation): LingTerminalReportRecord | undefined;
listTerminalReports(options): LingTerminalReportRecord[];
updateTerminalReportDraft(id, expectedFingerprint, update, now): LingTerminalReportRecord;
commitTerminalReport(id, expectedStatus, report, synthesis, now): LingTerminalReportRecord;
markTerminalReportPublished(id, messageId, now): LingTerminalReportRecord;
failTerminalReport(id, code, validationCodes, now): LingTerminalReportRecord;
```

### Concurrency And Idempotency

- The source/generation unique constraint decides report ownership.
- Create races return the existing source-generation record.
- Draft updates use expected fingerprint/status compare-and-set behavior.
- Publication stores `published_message_id`; repeated recovery returns the existing
  message instead of creating another.
- A committed report is immutable except for publication metadata.

### Tests

Add:

```text
packages/core/test/terminal-report-store.test.mjs
packages/core/test/terminal-report-migration.test.mjs
packages/core/test/terminal-report-idempotency.test.mjs
```

Test reopen/migration, concurrent logical creates, fingerprint CAS, commit immutability,
and publication idempotency.

### Verification

```bash
corepack pnpm --filter @ling-stack/core test
```

### Exit Gate

The store can create, commit, list, reopen, and publish report records without any daemon
integration or user-visible change.

## TR3: Evidence Snapshot And Deterministic Fallback

### Goal

Build a complete source-backed report without invoking a model.

### Evidence Collector

Add:

```text
packages/daemon/src/features/channels/terminal-report-evidence.ts
```

Inputs:

```ts
collectWorkflowTerminalReportEvidence(store, workflowId, options);
collectRunTerminalReportEvidence(store, runId, options);
collectTurnTerminalReportEvidence(store, turnId, options);
```

Workflow collection should reuse `buildWorkflowEvidence()` and output packets. Do not
duplicate selector/handoff/artifact traversal in a second Web-only path.

Collection rules:

- objective/language comes from source turn/workflow/session state;
- terminal state comes only from state machines;
- participants include only actual steps/runs or promoted contributions;
- checks normalize execution actions, check artifacts, and completion verification;
- changed paths come from output packets, diff/file artifacts, and successful edits;
- approvals use durable request/checkpoint state;
- missing expected verification creates `not_run`/`unknown` evidence and an unverified
  risk;
- private/secret-adjacent content is redacted before snapshot creation;
- enforce the initial runtime budgets and record truncation diagnostics.

### Fallback Builder

Complete:

```text
packages/core/src/terminal-report-fallback.ts
```

Fallback must aggregate all steps. It must not select only the latest `resultSummary`.

Rules:

- outcome title/summary from objective and terminal state;
- changes grouped by behavior/code/docs/configuration when deterministic evidence allows;
- verification mirrors exact evidence status;
- participants aggregate rounds by agent;
- artifacts dedupe by stable id;
- risks include blockers, failed checks, unknown/not-run expected checks, and truncation;
- all fields retain source refs.

### Daemon Tests

Add:

```text
packages/daemon/test/terminal-report-evidence.test.mjs
packages/daemon/test/terminal-report-fallback.test.mjs
```

Extend:

```text
packages/daemon/test/workflow-terminal-summary.test.mjs
```

The existing test should continue proving long runner text is preserved as step evidence,
while new assertions prove fallback aggregates the workflow instead of copying it as the
entire report.

### Verification

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
```

### Exit Gate

Every real-scenario fixture produces a valid fallback report with no unsupported claims.
No report is published yet.

## TR4: Reporting Coordinator And Flagged Fallback Publication

### Goal

Integrate terminal reporting into workflow/run lifecycle using deterministic fallback
only. This is the first user-visible slice, behind a disabled-by-default feature flag.

### Configuration

Update:

```text
packages/daemon/src/config.ts
packages/contracts/src/runtime.ts
packages/daemon/src/server/router.ts
```

Add:

```ts
channels.terminalReports?: boolean;
```

Environment compatibility:

```text
LING_STACK_CHANNEL_TERMINAL_REPORTS
```

Expose the resolved flag in `/health`.

### Runtime Work Unit

Update:

```text
packages/core/src/runtime-supervisor-types.ts
packages/daemon/src/runtime/routes.ts
```

Add work-unit kind:

```text
channel_terminal_report
```

The work unit initially records evidence collection, fallback generation, validation,
commit, and publication. TR5 adds provider execution to the same work unit kind.

### Coordinator

Add:

```text
packages/daemon/src/features/channels/terminal-report-coordinator.ts
packages/daemon/src/features/channels/terminal-report-publisher.ts
```

Coordinator responsibilities:

1. resolve source owner/session/turn;
2. check terminal state and reporting barrier;
3. claim or reuse source generation;
4. collect snapshot and fingerprint;
5. create/update draft;
6. build fallback report;
7. validate and commit;
8. publish one Ling coordinator message;
9. record work-unit terminal state and diagnostics.

### Reporting Barrier

Implement as asynchronous work-unit processing, not a blocking HTTP request loop.

Barrier checks:

- workflow/step state reconciled;
- post-step approval state settled;
- output packet/artifact import attempted;
- required fan-in terminal;
- active execution actions settled or deadline reached.

At 5 seconds, continue with available evidence and add an `unverified` risk.

### Integration Points

Replace direct calls to `maybeCreateWorkflowTerminalCoordinatorReply()` in:

```text
packages/daemon/src/features/channels/orchestrator.ts
packages/daemon/src/features/channels/workflows.ts
```

with:

```text
maybeScheduleTerminalReport(...)
```

When the flag is disabled, keep the current terminal coordinator reply unchanged.

### Publication

First publication renderer converts structured fallback report into natural markdown.
The message remains `kind: "ai_reply"`, authored by `ling_agent`, linked to the anchor
run where available.

Publication rules:

- report record is committed before message creation;
- message creation and `published_message_id` update are retry-safe;
- recovery checks `published_message_id` first;
- do not detect existing reports by body regex;
- artifact strips remain separate from the message body.

### Session View

Update:

```text
packages/daemon/src/features/channels/ling-agent-session-view.ts
```

Derivation:

- terminal source without committed report -> `reporting`;
- committed report -> terminal outcome state;
- `LingAgentFinalResultView` derives from the committed report when available;
- current derivation remains fallback when the flag is disabled or no report exists.

### Tests

Add:

```text
packages/daemon/test/terminal-report-coordinator.test.mjs
packages/daemon/test/terminal-report-publication.test.mjs
packages/daemon/test/terminal-report-recovery.test.mjs
```

Verify flag off compatibility, flag on fallback publication, no duplicates, approval
barrier, startup recovery, and reporting state.

### Exit Gate

With the feature flag enabled in tests, successful/failed/blocked/cancelled workflows
publish one valid fallback-backed final result. With the flag disabled, behavior is
unchanged.

## TR5: Model Synthesis And Repair Fallback

### Goal

Add Codex-like semantic synthesis without making model availability part of workflow
correctness.

### Modules

Add:

```text
packages/daemon/src/features/channels/terminal-report-prompt.ts
packages/daemon/src/features/channels/terminal-report-synthesis.ts
```

### Provider And Runner Resolution

Resolve in order:

1. Ling Agent system teammate provider preset;
2. channel default provider preset;
3. source run provider preset only when policy permits reuse;
4. no model -> deterministic fallback.

Use `RunnerRegistry.resolve()` with:

- requested Ling runner;
- `tools: []`;
- fallback allowed according to existing implicit runner policy;
- `thinkingLevel: "low"` initially;
- no approval or side-effect capability.

Use `resolveProviderForRun()` and the current `runner.adapter.runTask()` pattern from
channel router/intent selector.

### Prompt Contract

System prompt:

```text
You are Ling Agent's terminal report synthesizer.
Return one strict JSON object matching TerminalReport draft schema.
Use only supplied evidence.
Do not claim tests, changes, participants, approvals, commits, PRs, deployments, or
service state without matching source refs.
Omit empty sections.
Do not call tools or propose additional execution.
```

User prompt contains:

- prompt version `terminal-report-v1`;
- objective and language;
- bounded snapshot JSON;
- allowed source-ref ids;
- exact JSON shape and enum vocabulary;
- writing rules.

### Parsing

Start with a shared strict JSON helper instead of copying router/selector parsers again:

```text
packages/daemon/src/features/channels/model-json.ts
```

It accepts only one top-level object. No markdown-fence stripping in v1.

### Retry

Attempt 1:

- 45-second timeout;
- parse and validate.

Attempt 2 only when output is parseable/invalid or schema-invalid:

- include stable validation codes and allowed refs;
- ask for corrected JSON only;
- no additional evidence or tools.

Fallback immediately when:

- provider/runner resolution fails;
- policy blocks evidence transmission;
- attempt times out;
- both attempts fail validation.

### Runtime Evidence

Record developer-only metadata:

- provider preset and model;
- requested/effective runner;
- attempt count;
- validation codes;
- fallback reason;
- synthesis latency.

Do not store hidden reasoning or full provider payloads.

### Tests

Add fake-runner scenarios:

- valid structured report;
- invalid JSON then repaired JSON;
- unsupported success claim then repaired report;
- timeout -> fallback;
- provider unavailable -> fallback;
- secret-adjacent leak -> validation rejection and fallback;
- source-ref hallucination -> rejection.

Target:

```text
packages/daemon/test/terminal-report-synthesis.test.mjs
```

### Exit Gate

Model synthesis improves report structure for multi-step fixtures, while every failure
path still commits and publishes a valid deterministic fallback.

## TR6: API, Shared Projection, And Web UI

### Goal

Render the structured report without parsing the published message body and without
duplicating operation/artifact UI.

### API

Add routes:

```text
GET /terminal-reports/:reportId?cwd=...
GET /channels/:channelId/terminal-reports?cwd=...&threadId=...
```

Files:

```text
packages/daemon/src/features/channels/terminal-report-routes.ts
packages/daemon/src/features/channels/routes.ts
packages/contracts/src/terminal-reports.ts
packages/api-client/src/endpoints/terminal-reports.ts
packages/api-client/src/index.ts
```

Default list/detail DTOs exclude raw synthesis prompt, provider payload, and
developer-only refs.

### Conversation UI Core

Add:

```text
packages/conversation-ui-core/src/terminal-report-view-model.ts
```

View model responsibilities:

- outcome display lines;
- optional change rows;
- verification rows with exact status;
- participant summary rows;
- risk rows;
- reference/evidence links;
- artifact strip ids, not duplicate nested artifacts;
- revision key based on committed report id/fingerprint.

Populate existing `terminalReportRows` in:

```text
apps/web/src/lib/workflow-progress.ts
apps/web/src/lib/conversation-work-cell.ts
```

Do not add another report-shaped property to `ConversationOperationCellViewModel` unless
typed block projection proves `terminalReportRows` insufficient. The target transcript
path should carry the report id and typed `final_result` block.

### React UI

Add:

```text
apps/web/src/shared/conversation/blocks/TerminalReportBlock.tsx
apps/web/src/shared/conversation/blocks/TerminalReportParticipants.tsx
```

Integrate with:

```text
apps/web/src/shared/conversation/blocks/ConversationWorkCell.tsx
apps/web/src/shared/conversation/blocks/TranscriptBlockView.tsx
apps/web/src/shared/conversation/transcript/types.ts
apps/web/src/shared/conversation/transcript/renderer-registry.ts
```

UI rules:

- completed process shell remains independently expandable;
- final summary renders outside the inner process shell;
- participant names use the existing blue teammate treatment;
- artifact strip renders below the report;
- verification status uses compact text/icon rows, no nested cards;
- empty sections do not render;
- expanding the final result does not expand individual operation rows;
- report text uses normal conversation typography;
- raw ids/provider metadata remain detail-only.

### Web E2E

Extend:

```text
apps/web/e2e/channel.spec.ts
```

Add focused cases:

- final outcome plus changes and checks;
- participants only for actual multi-agent work;
- Engineer second round remains in process history;
- artifacts below final result;
- no duplicate changed/check counts;
- outer completed process remains expanded/collapsible according to current UX rules;
- individual operation disclosures preserve state;
- no empty risk/participant headings.

### Verification

```bash
corepack pnpm --filter @ling-stack/conversation-ui-core typecheck
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web exec playwright test apps/web/e2e/channel.spec.ts -g "terminal report|multi-agent result|artifact strip"
```

### Exit Gate

The demo/fixture and a real terminal workflow both render the same structured report
shape, with no prose parsing and no duplicate artifact/process presentation.

## TR7: Direct Run, Normal Conversation, Private Chat, And Default Enablement

### Goal

Apply the report protocol consistently outside channel workflows and enable it by
default after real acceptance.

### Direct Run

Schedule a source kind `run` report for terminal executed work that is not owned by a
workflow.

Do not generate reports for plain conversational replies with no run/tool evidence.

### Normal Conversation

Update conversation completion projection so executed turns can reference a committed
report id and show compact final result/evidence.

Likely anchors:

```text
packages/daemon/src/features/conversations/*
packages/contracts/src/conversations.ts
packages/api-client/src/endpoints/conversations.ts
apps/web/src/domains/conversations/use-conversation-domain.ts
apps/web/src/app/AppShell.tsx
```

### Teammate Private Chat

Use source kind `run` or `turn` under the private thread. Keep evidence scoped to that
teammate/private conversation and do not expose channel participants.

Likely anchors:

```text
packages/daemon/src/features/teammates/direct-messages.ts
packages/daemon/src/features/teammates/direct-replies.ts
packages/core/src/storage/sqlite/teammate-direct-store.ts
packages/api-client/src/endpoints/teammates.ts
apps/web/src/features/teammates/TeammatePrivateChatSurface.tsx
apps/web/src/features/teammates/TeammateWorkspace.tsx
```

### Enablement Gate

Before changing the default flag to true, run one real scenario for each:

1. single-agent direct file edit;
2. multi-agent channel workflow;
3. QA failure plus Engineer second round;
4. approval wait then success;
5. model synthesis unavailable fallback;
6. normal conversation executed work;
7. teammate private executed work.

Confirm:

- report facts match durable evidence;
- report publication is unique;
- service restart does not duplicate;
- process/artifact UI matches the agreed design;
- synthesis latency and fallback rate are acceptable.

Then change `channels.terminalReports` default to true while retaining an explicit
disable flag for rollback.

### Verification

```bash
corepack pnpm --filter @ling-stack/contracts typecheck
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web test:e2e
```

### Exit Gate

All executed-work surfaces use the same report protocol by default. Plain answers remain
plain answers.

## TR8: Legacy Cleanup And Hardening

### Goal

Remove old ownership only after the new protocol is the default and recovery-tested.

### Cleanup

- Remove `workflowTerminalCoordinatorReplyBodyIsPresent()` body-regex idempotency.
- Remove the last-step-only terminal coordinator wrapper as a primary path.
- Keep a small emergency fallback renderer inside terminal-report fallback code.
- Stop deriving Web final summary from the last workflow-step `resultSummary` when a
  committed report exists.
- Remove duplicate changed/check counts from report-adjacent workflow UI.
- Consolidate strict JSON helpers used by router, selector, and terminal report synthesis
  where behavior is identical.
- Move compatibility projection code out of `ling-agent-session-view.ts` once callers use
  the shared report contract.

### Recovery Hardening

- Startup recovery schedules missing reports for terminal sources when the feature is
  enabled.
- Recovery never backfills historical sources older than the rollout watermark unless an
  explicit maintenance command requests it.
- A committed unpublished report is published once.
- A draft with stale fingerprint is regenerated.
- A failed synthesis record can retry deterministically without creating a new generation.

### Observability

Expose internal metrics/log summaries:

- reports scheduled/committed/published;
- model/fallback mode counts;
- validation failure counts by code;
- duplicate publication prevented;
- reporting barrier timeout count;
- synthesis latency percentiles;
- snapshot truncation count.

### Exit Gate

No production path depends on terminal message body parsing or the last step summary as
the workflow-wide final result.

## Test Ownership Matrix

| Layer | Required coverage |
| --- | --- |
| Contracts | DTO typecheck and schema compatibility |
| Core | parser, validator, fingerprint, fallback, projection, storage, migration |
| Daemon | evidence collection, barrier, synthesis, fallback, publication, recovery, flag compatibility |
| Conversation UI core | report-to-view-model projection and empty-section behavior |
| Web unit/typecheck | renderer props, disclosure state, artifact placement |
| Web E2E | real conversation/workflow result shape and interaction |
| Manual real scenario | provider output quality, service restart, actual artifacts/tests/participants |

## Required Acceptance Scenarios

### Scenario A: Single-Agent Edit

Evidence:

- one run;
- one edited file;
- one passing typecheck;
- no specialist participant.

Expected:

- concise outcome/change/verification;
- no participants heading;
- artifact below summary;
- process history independently expandable.

### Scenario B: Multi-Agent Success

Evidence:

- Architect, Engineer, Designer, QA actual runs;
- two changed files;
- passing tests;
- final artifact.

Expected:

- one Ling final report;
- contribution summary for four agents;
- no raw peer transcript;
- all claims traceable.

### Scenario C: Engineer Round Two

Evidence:

- Engineer succeeds;
- QA fails;
- Engineer runs again;
- QA passes.

Expected:

- process history keeps both Engineer rounds;
- final participants aggregate Engineer contribution;
- verification reports the final QA result and preserves failed attempt in evidence.

### Scenario D: Approval Closure

Evidence:

- post-step approval pending;
- approval granted;
- workflow/step reconciled to succeeded.

Expected:

- no success report while approval is pending;
- exactly one report after reconciliation;
- approved record remains audit evidence without a duplicate approval card.

### Scenario E: Synthesis Failure

Evidence:

- valid terminal snapshot;
- model timeout or invalid JSON.

Expected:

- deterministic report commits;
- work remains succeeded/failed according to source state;
- fallback reason is developer-only;
- no visible error banner solely because synthesis failed.

## Rollback Plan

During TR4-TR7:

1. Set `LING_STACK_CHANNEL_TERMINAL_REPORTS=false`.
2. Keep report records and evidence; do not delete them.
3. Restore current terminal coordinator message path automatically.
4. Web ignores report blocks when the daemon does not expose them.
5. No workflow/run/approval state rollback is required because report generation is
   downstream and read-only.

After TR8, keep the deterministic TerminalReport fallback even if model synthesis is
disabled. Do not return to last-step-only aggregation.

## PR And Commit Boundaries

Recommended branch/PR sequence:

```text
1. terminal-report-contracts
2. terminal-report-storage
3. terminal-report-evidence-fallback
4. terminal-report-coordinator-publication
5. terminal-report-model-synthesis
6. terminal-report-conversation-ui
7. terminal-report-all-surfaces-rollout
8. terminal-report-legacy-cleanup
```

Do not mix broad conversation UI refactors, runner adapter redesign, unrelated workflow
changes, or artifact preview redesign into these PRs.

## Final Verification Gate

Before declaring the implementation complete:

```bash
corepack pnpm --filter @ling-stack/contracts typecheck
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/conversation-ui-core typecheck
corepack pnpm --filter @ling-stack/conversation-ui-react typecheck
corepack pnpm --filter @ling-stack/api-client typecheck
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web test:e2e
git diff --check
```

Additionally verify against real provider/runtime data:

- report contents match actual changed files and checks;
- report does not claim unrun tests;
- participant list matches actual runs;
- artifact/PR/commit links resolve;
- fallback works with provider disabled;
- daemon restart does not duplicate publication;
- old `tmp/` or unrelated worktree residue is not included in implementation PRs.

## Unresolved-Decision Verdict

No unresolved product or architecture decision blocks implementation.

The plan deliberately defers native provider JSON-schema output support. Initial strict
JSON parsing plus one repair attempt is sufficient because deterministic fallback remains
authoritative. Native structured output can be added later as an adapter optimization
without changing the `TerminalReport` protocol, storage, validation, or UI.
