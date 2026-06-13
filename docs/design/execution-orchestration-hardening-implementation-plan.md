# Execution And Orchestration Hardening Implementation Plan

## Purpose

This document is the implementation-ready companion to
[Execution And Orchestration Hardening](execution-orchestration-hardening.md).
The main design defines the product and architecture direction. This file defines
the concrete slices, contracts, write points, UI surfaces, and tests needed to
implement the hardening work without changing existing behavior first.

The plan covers three areas:

- Codex-like hardening: action artifacts, thread page, resume preview, stale
  completion audit.
- Orchestrator hardening: step context/output packets, failure/block policy,
  post-step gates.
- RunnerRegistry hardening: workspace runner settings, explicit fallback policy,
  runner audit UI.

## Cross-Cutting Rules

Implementation rules:

- Prefer additive contracts first. Do not replace existing run, thread, approval,
  workflow, or runner records in the first slice.
- Backend remains source of truth. Web may cache and compose views, but daemon state
  decides statuses, runner resolution, approvals, and resume context.
- Ling resume must not depend on native runner resume. Native runner resume remains
  an optimization after the Ling thread/context contract is stable.
- Do not introduce mid-run prompt injection. User follow-up still queues durable
  guidance or starts a continuation through existing intervention/resume paths.
- Do not let runner output silently advance workflow state. Workflow movement must
  happen through orchestrator reconciliation and declared policies.
- Fail closed when preview redaction fails. If a side-effect preview cannot be safely
  redacted, create metadata-only preview and require approval with a redaction warning.
- Use JSON artifacts for large or evolving payloads before adding new SQLite tables.
  Promote to schema only after query patterns are clear.
- Keep Pi as the default effective runner unless workspace settings explicitly and
  validly choose another registered runner.

## Existing Anchors

Current contracts and code paths to extend:

| Area | Current Anchor |
| --- | --- |
| Run/thread/action contracts | `packages/core/src/run-types.ts` |
| Work unit contracts | `packages/core/src/runtime-supervisor-types.ts` |
| Workflow step contracts | `packages/core/src/workspace-types.ts` |
| Runner resolution | `packages/daemon/src/runtime/runners.ts` |
| Run orchestration | `packages/daemon/src/features/runs/orchestrator.ts` |
| Run cancellation/control | `packages/daemon/src/run-control.ts` |
| Run artifacts | `packages/daemon/src/features/runs/artifacts.ts` |
| Thread routes | `packages/daemon/src/features/runs/thread-routes.ts` |
| Execution action read model | `packages/daemon/src/features/runs/execution-actions.ts` |
| API client | `apps/web/src/api.ts` |
| Run UI | `apps/web/src/features/runs/RunHistory.tsx` |
| Workspace UI | `apps/web/src/features/workspace/WorkspaceClientView.tsx` |
| Settings UI | `apps/web/src/features/settings/SettingsPage.tsx` |

## Implemented Slices A-G

Status as of 2026-06-05:

| Slice | Status | Implementation Notes |
| --- | --- | --- |
| A. Stale completion audit event | Implemented | Adds `stale_runner_completion_ignored` run/runtime evidence without changing terminal state. |
| B. Explicit runner fallback policy | Implemented | Runtime settings are file-backed at `.ling-stack/runtime-settings.json`; defaults keep Pi and fail closed for explicit runner mistakes. |
| C. Runner audit UI | Implemented | Runs/settings surfaces show requested/effective runner, source, fallback allowance, and fallback reason. |
| D. Action preview/result artifacts | Implemented | Preview artifacts are created from approval paths; result ids are derived from existing `artifact_created` events by `toolCallId`. |
| E. Resume context preview | Implemented | `/threads/:threadId/resume-preview` and resume execution share one deterministic context builder; preview never creates a run. |
| F. Orchestrator context/output packets | Implemented | Workflow packets are run-linked JSON artifacts under the run artifact directory, referenced from workflow step metadata, shown as workspace step artifact chips, and summarized in downstream step prompts. |
| G. Failure policy and post-step gates | Implemented | Compiled workflow steps carry durable policy metadata; terminal run reconciliation applies policy; post-step gates pause downstream steps until workflow-step approval resolves; workspace step cards show policy/gate rows. |
| Thread-first Run History detail | Implemented | Runs now has an explicit thread detail mode with header/objective/status, lineage, action artifact chips, queued follow-ups/interventions, state transitions, source-run selection, resume context preview, and active-run resume guard. Workflow-step runs persist `workflowStepId` on the run session/request snapshot and can be queried through `/runs?workflowStepId=...`. |

Remaining hardening after A-G and workspace UI:

- optional workflow-owned artifact schema if querying packets without a run becomes important.

## Slice 1: Stale Completion Audit Event

### Goal

When a runner reports terminal completion after Ling already cancelled, failed, or
staled the run/work unit, preserve the durable state and append an audit event that
explains what was ignored.

This prevents a confusing silent no-op where the UI shows cancellation but evidence
does not explain that a late runner success arrived.

### Contract

Add a run event type:

```ts
type RunEventType =
  | ExistingRunEventType
  | "stale_runner_completion_ignored";
```

Payload:

```ts
interface StaleRunnerCompletionIgnoredPayload {
  readonly runId: string;
  readonly workUnitId?: string;
  readonly attemptId?: string;
  readonly reportedStatus: "succeeded" | "failed" | "cancelled";
  readonly currentRunStatus: RunStatus;
  readonly currentWorkUnitStatus?: WorkUnitStatus;
  readonly reason:
    | "terminal_state_changed"
    | "attempt_not_current"
    | "run_cancelled"
    | "work_unit_cancelled"
    | "work_unit_stale";
  readonly runnerId?: string;
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly fallbackReason?: RunnerFallbackReason;
  readonly reportedAt: string;
}
```

Runtime diagnostic event:

```ts
type RuntimeEventType =
  | ExistingRuntimeEventType
  | "stale_runner_completion_ignored";
```

Runtime event `data` should include the same payload plus the ignored run event id
when a run event was appended.

### Backend Write Points

Add helper:

```ts
function auditIgnoredRunnerCompletion(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly workUnit?: WorkUnit;
  readonly attempt?: WorkUnitAttempt;
  readonly reportedStatus: "succeeded" | "failed" | "cancelled";
  readonly reason: StaleRunnerCompletionIgnoredPayload["reason"];
  readonly now: string;
}): RunEventEnvelope | undefined;
```

Use the helper in:

- `packages/daemon/src/features/runs/orchestrator.ts` after `runner.adapter.runTask`
  resolves, before returning from the "already cancelled" branch.
- `packages/daemon/src/features/runs/orchestrator.ts` catch/finalization branches
  when terminal transition CAS fails because durable state is already terminal.
- `packages/daemon/src/run-control.ts` and
  `packages/daemon/src/features/runs/work-units.ts` only if a control path rejects
  a late terminal transition outside normal runner execution.

Do not call this from every progress event. It only applies to terminal reports.

### Idempotency

Prevent event spam with a deterministic key:

```text
stale-runner-completion:
  runId + workUnitId + attemptId + reportedStatus + currentRunStatus + currentWorkUnitStatus
```

First implementation can scan recent run events for the same key before appending.
If this grows hot, add a store-level diagnostic dedupe table later.

### UI

Run and thread evidence should render this as a diagnostic row:

```text
Ignored late runner success after run was cancelled.
Runner: pi
Attempt: attempt_...
```

It is diagnostic, not an error banner. The state remains whatever Ling had already
persisted.

### Tests

Daemon tests:

- late success after cancel leaves `RunSession.status === "cancelled"`;
- run event includes `stale_runner_completion_ignored`;
- runtime event includes the same diagnostic when `workUnitId` exists;
- duplicate late terminal reports do not append duplicate diagnostics;
- late completion from a non-current attempt is audited as `attempt_not_current`.

## Slice 2: Explicit Runner Fallback Policy

### Goal

Make runner resolution deterministic and visible:

- implicit product/workspace defaults may fall back to Pi when policy allows;
- explicit user/workflow runner choices fail closed by default;
- all fallback is audited in run/work-unit state and exposed to Web.

### Contracts

Add runtime settings:

```ts
interface WorkspaceRuntimeSettings {
  readonly workspaceId: string;
  readonly defaultRunnerId: string;
  readonly allowedRunnerIds: readonly string[];
  readonly explicitRunnerFallback: "disabled" | "allow_to_default";
  readonly implicitRunnerFallback: "disabled" | "allow_to_default";
  readonly updatedAt: string;
}
```

Add request source:

```ts
type RunnerRequestSource =
  | "product_default"
  | "workspace_default"
  | "teammate_default"
  | "workflow_step"
  | "run_request"
  | "user_explicit";
```

Extend daemon runner resolution input:

```ts
interface RunnerResolutionInput {
  readonly requestedRunnerId?: string;
  readonly defaultRunnerId?: string;
  readonly allowedRunnerIds?: readonly string[];
  readonly requestSource?: RunnerRequestSource;
  readonly explicitFallbackPolicy?: "disabled" | "allow_to_default";
  readonly implicitFallbackPolicy?: "disabled" | "allow_to_default";
  readonly providerApi?: PiRunnerProviderApi;
  readonly tools?: readonly string[];
}
```

Add optional audit detail:

```ts
interface RunnerResolutionAudit {
  readonly requestedRunnerId: string;
  readonly effectiveRunnerId: string;
  readonly requestSource: RunnerRequestSource;
  readonly fallbackAllowed: boolean;
  readonly fallbackReason?: RunnerFallbackReason;
  readonly resolvedAt: string;
}
```

Existing `RunSession` does not currently persist runner ids, while `WorkUnit`
does. First implementation should keep the durable audit on `WorkUnit` and the
run event/request snapshot, then add `RunSession.requestedRunnerId`,
`RunSession.effectiveRunnerId`, and `RunSession.fallbackReason` only if the UI
needs run-list queries without joining work units.

### API

Add:

```text
GET /runtime/settings?cwd=...
PATCH /runtime/settings?cwd=...
GET /runners?cwd=...
```

Responses:

```ts
interface RunnerListResponse {
  readonly cwd: string;
  readonly runners: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly status: "enabled" | "disabled";
    readonly aliases?: readonly string[];
    readonly supportedProviderApis?: readonly string[];
    readonly supportedTools?: readonly string[];
  }[];
}

interface RuntimeSettingsResponse {
  readonly cwd: string;
  readonly settings: WorkspaceRuntimeSettings;
}
```

`PATCH /runtime/settings` validation:

- `defaultRunnerId` must exist in `GET /runners` and be enabled;
- `allowedRunnerIds` can only include registered ids or aliases normalized to ids;
- if `allowedRunnerIds` is empty or omitted, seed to all enabled registered runners;
- never accept package names or adapter internals as runner ids.

### Resolution Rules

Classify source as explicit when it came from:

- user runner picker,
- run request `runnerId`,
- workflow step `metadata.requestedRunnerId`,
- teammate default explicitly set by the user.

Classify source as implicit when it came from:

- product default,
- workspace default,
- old request without runner id.

Default policy:

```text
explicitRunnerFallback = disabled
implicitRunnerFallback = allow_to_default
defaultRunnerId = pi
```

Decision table:

| Request | Policy | Result |
| --- | --- | --- |
| no runner id | implicit fallback allowed | resolve workspace default, fallback to Pi if needed |
| explicit unknown runner | explicit fallback disabled | fail with `unsupported_runner` |
| explicit disabled runner | explicit fallback disabled | fail with `unsupported_runner` |
| workflow step runner unsupported provider API | explicit fallback disabled | block/fail according to workflow policy |
| workspace default disabled | implicit fallback allowed | fallback to Pi with audit |

### Tests

Core/daemon tests:

- seeded settings return Pi default;
- explicit unknown runner fails closed;
- implicit missing runner falls back with `missing_requested_runner`;
- disabled default falls back only for implicit source;
- runner outside `allowedRunnerIds` fails closed;
- existing run requests without runner id keep using Pi.

Web tests:

- settings page cannot save unavailable default runner;
- fallback policy round-trips through API;
- run/work-unit surfaces display fallback reason.

## Slice 3: Runner Audit UI

### Goal

Make runner identity visible without exposing implementation details.

### Surfaces

| Surface | Initial Source | Display |
| --- | --- | --- |
| Run History detail | run + work unit + events | compact runner row |
| Runtime/Work Unit panel | `WorkUnit.requestedRunnerId/effectiveRunnerId` | runner row and fallback badge |
| Workflow step card | `ChannelWorkflowStep.metadata` | requested/effective runner |
| Thread evidence | evidence runs + runtime events | runner per run/step |
| Settings Runtime panel | runner settings endpoints | default runner and fallback policy |

### Display Rules

Compact row when no fallback:

```text
Runner: Pi
```

Fallback row:

```text
Runner: codex-app-server -> Pi
Fallback: unsupported_provider_api
```

Failure row:

```text
Runner: codex-app-server
Resolution failed: runner is disabled
```

Rules:

- show `displayName` first, stable id second only when useful;
- do not show package names as the primary label;
- show fallback warning badge only when `fallbackReason` exists;
- show provider API support only in expanded detail;
- handle old runs with no audit as `Runner: unknown legacy run`.

### Implementation Notes

Add a shared UI helper instead of repeating formatting:

```ts
interface RunnerAuditViewModel {
  readonly label: string;
  readonly requestedLabel?: string;
  readonly effectiveLabel?: string;
  readonly fallbackCode?: string;
  readonly fallbackMessage?: string;
  readonly isFallback: boolean;
  readonly isLegacy: boolean;
}
```

Likely location:

```text
apps/web/src/lib/runner-audit.ts
```

Use it from:

- `apps/web/src/features/runs/RunHistory.tsx`;
- `apps/web/src/features/workspace/WorkspaceClientView.tsx`;
- `apps/web/src/features/settings/SettingsPage.tsx`.

## Slice 4: Action Preview And Result Artifacts

### Goal

Risky actions need durable evidence before approval and durable results after
execution. The user should be able to inspect what was approved and what happened.

### Existing Contract

`ExecutionAction` already has:

```ts
readonly previewArtifactIds: readonly string[];
readonly resultArtifactIds: readonly string[];
```

`RunArtifact` already supports:

```ts
type ArtifactType = "file" | "diff" | "log" | "json" | "markdown" | "image" | "video";
```

### Backend Helper

Add:

```text
packages/daemon/src/features/runs/action-artifacts.ts
```

Core API:

```ts
function createExecutionActionPreviewArtifacts(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly approval: ApprovalRequest;
  readonly toolName: string;
  readonly toolArgs: unknown;
  readonly now: string;
  readonly extraSecrets?: readonly string[];
}): readonly RunArtifact[];

function linkExecutionActionResultArtifacts(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly toolCallId: string;
  readonly artifacts: readonly RunArtifact[];
  readonly now: string;
}): void;
```

If `ExecutionAction` stays a read model, linking can be derived from approvals,
tool call ids, and `artifact_created` events instead of writing an action table.
If derivation gets too complex, add a narrow projection table later:

```text
execution_action_artifacts(action_id, artifact_id, role, created_at)
role = preview | result
```

### Preview Builders

Start with three tools:

| Tool | Preview Artifact | Type |
| --- | --- | --- |
| `bash` | command, cwd, env redaction summary, path/risk hints | `json` |
| `edit` | unified diff preview from proposed edits | `diff` |
| `write` | target path, byte count, overwrite/create risk, safe content excerpt | `json` or `file` |

Naming:

```text
artifacts/{runId}/actions/{approvalId}/preview.json
artifacts/{runId}/actions/{approvalId}/preview.diff
artifacts/{runId}/actions/{toolCallId}/result-001.log
```

Titles:

```text
Action preview: bash
Action preview: edit path/to/file.ts
Action result: bash stdout
```

### Redaction Policy

Preview generation must call existing `redactSecrets()` with:

- provider secrets already resolved for the run;
- approval payload secrets;
- workspace credential references when available.

If redaction fails:

- do not include raw content;
- create metadata-only preview;
- include `redactionNotes`;
- keep approval required.

### Write Points

Preview artifacts are created in approval creation:

- `createRunApprovalHandler(...)` path in run orchestration;
- any future external tool approval path that is exposed as `ExecutionAction`.

Result artifacts are linked when `tool_end` artifacts are persisted:

- `persistExtractedArtifacts(...)` already creates artifacts from tool results;
- append or derive `ExecutionAction.resultArtifactIds` by matching
  `toolCallId` and run id.

### UI

Approval cards:

- show `Preview` artifact chips before approve/deny;
- show redaction warnings before approve;
- keep inline payload summary for quick scanning.

Action/evidence rows:

- show preview chips and result chips separately;
- show denied actions with preview artifacts and no result artifacts;
- show failed actions with result/error artifacts when captured.

### Tests

Daemon tests:

- `bash` approval creates JSON preview artifact;
- `edit` approval creates diff preview artifact;
- `write` preview redacts secret-looking content;
- denied action keeps preview and has no result artifact;
- executed action links result artifacts by `toolCallId`;
- artifact path traversal is rejected.

Web tests:

- approval card renders preview chips;
- action row renders result chips after tool end;
- redaction warning appears when preview is metadata-only.

## Slice 5: Resume Context Preview

### Goal

Before starting a manual resume, show exactly what Ling will feed into the next run.
Preview and actual resume must use the same source selection and context builder.

### API

Add route:

```text
POST /threads/:threadId/resume-preview?cwd=...
```

Current route parser already supports:

```text
/threads/:threadId
/threads/:threadId/evidence
/threads/:threadId/resume
```

Extend it with `resume-preview`.

### Contracts

```ts
interface LingThreadResumePreviewRequest {
  readonly sourceRunId?: string;
  readonly instruction?: string;
  readonly includeArtifacts?: boolean;
}

interface LingThreadResumePreviewResponse {
  readonly cwd: string;
  readonly thread: LingThread;
  readonly sourceRun: RunSession;
  readonly context: ResumeContextPreview;
}

interface ResumeContextPreview {
  readonly title: string;
  readonly instruction: string;
  readonly sourceRunId: string;
  readonly priorRunIds: readonly string[];
  readonly includedEventCount: number;
  readonly includedApprovalCount: number;
  readonly includedArtifactIds: readonly string[];
  readonly pendingActionIds: readonly string[];
  readonly contextText: string;
  readonly redactionNotes: readonly string[];
  readonly warnings: readonly string[];
}
```

### Shared Builder

Replace the private resume-only assembly with:

```ts
function buildLingThreadResumeContext(input: {
  readonly store: RunStore;
  readonly thread: LingThread;
  readonly body: unknown;
  readonly mode: "preview" | "execute";
}): {
  readonly sourceRun: RunSession;
  readonly context: ResumeContextPreview;
  readonly runRequest: RunRequest;
}
```

Rules:

- preview mode must not create a run;
- execute mode should use the same `sourceRun`, `instruction`, and selected
  artifacts as preview mode for identical input;
- active non-terminal thread still returns a conflict warning for preview, but
  execute mode fails until policy explicitly allows concurrent resume;
- `includeArtifacts` should include artifact ids in the preview, not raw file
  contents, until artifact redaction is implemented.

### Context Text Shape

Use deterministic sections:

```text
Thread
- title
- objective
- status

Resume instruction
...

Prior runs
- run id, status, timestamps, runner audit

Recent terminal evidence
- result summary
- approvals
- artifacts

Pending actions
- action id, status, risk
```

### UI

Initial surface:

- add preview button/composer in Run History thread/evidence panel;
- show context preview in a side panel or modal;
- start resume from preview response.

Later surface:

- move this into the thread-first page from Slice 6.

### Tests

Daemon tests:

- preview does not create a run;
- preview and resume choose the same source run;
- sourceRunId override works;
- active thread preview returns warning, execute fails;
- redaction notes appear when sensitive refs are omitted.

Web tests:

- clicking preview shows context text;
- starting resume after preview calls `/threads/:id/resume`;
- pending action ids are visible before resume.

## Slice 6: Thread-First Page

Status as of 2026-06-05: implemented as a thread detail mode inside the existing
Runs surface. This intentionally avoids React Router and keeps AppShell selection
state unchanged. A standalone route remains optional product polish, not a blocker
for the hardening slice.

### Goal

Provide one durable page for project-work continuity. Runs remain execution attempts;
thread is the long-lived work container.

### First Implementation Boundary

Do not introduce React Router just for this. Add a thread detail mode inside the
existing Runs surface or AppShell view selection:

```text
Runs
  -> selected run detail
  -> selected thread detail
```

The thread page can coexist with Run History until usage proves it should replace
run-centric navigation.

### Data Loading

Use existing/new endpoints:

```text
GET /threads?cwd=...
GET /threads/:threadId?cwd=...
GET /threads/:threadId/evidence?cwd=...
POST /threads/:threadId/resume-preview?cwd=...
POST /threads/:threadId/resume?cwd=...
GET /execution-actions?cwd=...&threadId=...
GET /artifacts/:artifactId/content?cwd=...
```

### Layout

Required sections:

- header: title, objective, status, active/last run;
- lineage: prior runs with status and timestamps;
- workflow linkage when `workflowStepId` exists;
- actions: preview/result artifacts and approval status;
- queued follow-ups/interventions;
- evidence: event/approval/artifact counts per run plus thread state transitions;
- resume composer: instruction input, preview, start resume.

Implemented boundary:

- selecting a thread in the Run history rail opens `ThreadDetailPanel`;
- evidence is loaded from `GET /threads/:threadId/evidence`;
- per-run interventions are loaded from `GET /runs/:runId/interventions` and treated as
  supplemental audit, so an intervention fetch failure does not hide thread evidence;
- resume preview and execute use `sourceRunId`, and the UI exposes a source-run selector
  instead of relying on an implicit `lastRunId`;
- active non-terminal threads keep preview available but disable `Resume thread`; the
  daemon remains the final guard and rejects active-thread execution.

### State Rules

- If thread has active non-terminal run, show active-run controls and disable
  manual resume start.
- If thread is terminal, allow resume preview.
- If thread is blocked, show blocker and next unblocking action first.
- If evidence load fails, do not hide thread header.

### Tests

Browser smoke:

- open Runs page;
- select a thread;
- evidence loads without `/threads` 404;
- resume preview opens and does not start a run;
- active thread disables resume action.

Automated coverage:

- `apps/web/e2e/app.spec.ts` covers terminal thread detail, action preview/result
  artifact chips, queued follow-up audit, state transition evidence, resume preview,
  resume execution, and active-thread resume disablement.

## Slice 7: Orchestrator Context And Output Packets

### Goal

Each workflow step should start from an explicit, durable context packet and produce
an explicit output packet for downstream steps. Do not rely on unstated prompt history.

### Contracts

```ts
interface ChannelWorkflowStepContextPacket {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly objective: string;
  readonly stepTitle: string;
  readonly stepPrompt: string;
  readonly dependencies: readonly WorkflowStepOutputRef[];
  readonly priorOutputArtifactIds: readonly string[];
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly providerPresetId?: string;
  readonly approvalGate?: SkillApprovalProfile;
  readonly generatedAt: string;
}

interface WorkflowStepOutputRef {
  readonly workflowStepId: string;
  readonly runId?: string;
  readonly status: ChannelWorkflowStep["status"];
  readonly resultSummary?: string;
  readonly outputArtifactId?: string;
  readonly artifactIds: readonly string[];
}

interface ChannelWorkflowStepOutputPacket {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly runId?: string;
  readonly status: ChannelWorkflowStep["status"];
  readonly resultSummary?: string;
  readonly artifactIds: readonly string[];
  readonly runnerAudit?: RunnerResolutionAudit;
  readonly generatedAt: string;
}
```

Extend step metadata:

```ts
interface ChannelWorkflowStepMetadata {
  readonly contextArtifactId?: string;
  readonly outputArtifactId?: string;
  readonly outputArtifactIds?: readonly string[];
}
```

`outputArtifactIds` already exists and can remain as a multi-artifact convenience.
`outputArtifactId` is the canonical packet.

### Storage

Store packets as JSON artifacts first:

```text
.ling-stack/artifacts/{runId}/workflows/{workflowId}/steps/{stepId}/context.json
.ling-stack/artifacts/{runId}/workflows/{workflowId}/steps/{stepId}/output.json
```

Because `RunArtifact` is currently run/media/external-work oriented, choose one of
two implementation paths:

1. short-term: create a run-linked artifact when a step creates a run, and attach
   packet ids to step metadata;
2. better additive schema: allow `RunArtifact` to include optional `workflowId` and
   `workflowStepId`.

Choose path 1 for first implementation unless Web artifact queries require workflow
artifact listing without a run.

### Builders

Add:

```text
packages/daemon/src/features/channels/workflow-step-packets.ts
```

Functions:

```ts
function buildWorkflowStepContextPacket(input: {
  readonly store: RunStore;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly now: string;
}): ChannelWorkflowStepContextPacket;

function buildWorkflowStepOutputPacket(input: {
  readonly store: RunStore;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly run?: RunSession;
  readonly now: string;
}): ChannelWorkflowStepOutputPacket;
```

Write context packet:

- after the run has been created and `RunSession` is durable, because current
  `RunArtifact` ownership requires a run/media/external-work owner;
- attach the context artifact id to `ChannelWorkflowStep.metadata.contextArtifactId`;
- keep packet IO failure from corrupting the already-created run. Blocking before run
  creation requires either a workflow-owned artifact schema or a preflight packet table.

Write output packet:

- when linked run reaches terminal status;
- when user manually marks step skipped/cancelled;
- when post-step gate blocks the workflow after run success.

Storage parser requirement:

- update `parseOptionalChannelWorkflowStepMetadata()` whenever metadata fields are
  added. SQLite stores JSON, but the read model filters known fields; missing parser
  entries will silently drop newly written ids.

### Prompt Assembly

Implemented prompt assembly prepends a deterministic context section to the task prompt:

```text
Workflow context packet: artifact_<id> | pending until run starts

Objective:
...

Dependencies:
...

Current step:
...
```

The prompt section includes objective, dependency summaries, dependency run ids,
output artifact ids, and approval gate summaries. It does not paste large artifact
content. Because the context packet artifact is written after the run is durable, a
fresh step prompt uses `pending until run starts` until metadata has a
`contextArtifactId`; downstream dependency output artifact ids are already available
from prior terminal steps.

### Tests

Daemon tests:

- first step context contains workflow objective and no dependencies;
- dependent step context includes prior output ref;
- output packet is created for succeeded run;
- downstream step includes previous output packet id.

## Slice 8: Failure Policy And Post-Step Gates

### Implementation Status

Backend and workspace UI are implemented:

- `autoplan-lite` compiled steps persist `metadata.policy`;
- planning/review/QA run failures block for user repair;
- implementation and ship run failures fail the workflow;
- post-step gates use `metadata.activeGateStage = "post"` plus
  `metadata.postStepApprovalId`;
- workflow-step approval payloads carry `gateStage`;
- approval cards label pre-step and post-step approvals;
- workspace step cards show packet artifact chips, failure policy rows, and gate rows;
- restart-specific post-gate recovery is covered by a daemon regression test.

### Goal

Workflow behavior should be declared, durable, and restart-safe. A failed planning
step may block for user repair; a failed implementation step may fail the workflow;
a successful step may still require a post-step gate before downstream work starts.

### Contracts

```ts
type WorkflowStepFailurePolicy =
  | "block_for_user"
  | "fail_workflow"
  | "cancel_workflow"
  | "skip_if_optional";

interface WorkflowStepPolicy {
  readonly onRunFailed: WorkflowStepFailurePolicy;
  readonly onRunCancelled: WorkflowStepFailurePolicy;
  readonly onApprovalDenied: WorkflowStepFailurePolicy;
  readonly retryable: boolean;
  readonly maxRetries?: number;
}

interface WorkflowStepGate {
  readonly stage: "pre" | "post";
  readonly approvalProfile: SkillApprovalProfile;
  readonly title: string;
  readonly reason: string;
  readonly requiredForStatuses?: readonly ChannelWorkflowStep["status"][];
}
```

Extend metadata:

```ts
interface ChannelWorkflowStepMetadata {
  readonly policy?: WorkflowStepPolicy;
  readonly gates?: readonly WorkflowStepGate[];
  readonly activeGateStage?: "pre" | "post";
  readonly postStepApprovalId?: string;
}
```

### Default Policy

For `autoplan-lite`:

| Step Type | onRunFailed | onRunCancelled | onApprovalDenied | Post Gate |
| --- | --- | --- | --- | --- |
| planning/review | `block_for_user` | `block_for_user` | `block_for_user` | optional |
| implementation | `fail_workflow` | `block_for_user` | `block_for_user` | optional |
| verification | `block_for_user` | `block_for_user` | `block_for_user` | optional |

If template has no policy, default to current behavior plus explicit metadata:

```text
onRunFailed = block_for_user
onRunCancelled = block_for_user
onApprovalDenied = block_for_user
retryable = true
```

### State Handling

First implementation should reuse existing step statuses:

- `waiting_for_approval` for pre/post gates;
- `blocked` for user repair;
- `failed` for workflow-failing terminal state;
- `cancelled` for cancellation.

Do not add a new `waiting_for_post_gate` status in the first slice. Use
`metadata.activeGateStage = "post"` and approval payload metadata.

### Reconciliation

When linked run terminal event arrives:

1. load step and durable `metadata.policy`;
2. if run succeeded, check post-step gates;
3. if post gate exists, create approval, set step `waiting_for_approval`, set
   `metadata.activeGateStage = "post"`, do not start downstream steps;
4. if run failed/cancelled, apply policy;
5. write output packet for every terminal or blocked outcome;
6. update workflow status from step statuses.

Policy outcomes:

```text
block_for_user -> step blocked, workflow blocked
fail_workflow -> step failed, workflow failed
cancel_workflow -> step cancelled, workflow cancelled
skip_if_optional -> step skipped, workflow may continue
```

### Recovery

Daemon startup recovery must not infer gates from template code only. It must read
durable step metadata:

- pending pre/post approval id;
- active gate stage;
- policy;
- linked run status;
- context/output artifact ids.

Recovery rules:

- if step is `waiting_for_approval` and approval is still pending, do nothing;
- if approval was approved while daemon was down, continue reconciliation;
- if post gate was approved, start eligible downstream steps;
- if approval was denied/expired, apply `onApprovalDenied`.

### UI

Workflow step card:

- show failure policy in expanded details;
- show pre/post gate label;
- show blocker reason with primary unblocking action;
- show output packet artifact chip.

Approval card:

- label post-step gates as `Post-step approval`;
- include step title, previous run status, and downstream impact.

### Tests

Daemon tests:

- planning step failure blocks workflow;
- implementation step failure fails workflow;
- post-step approval prevents next step from starting;
- post-step approval allows downstream start after approval;
- cancellation policy blocks by default;
- approval denial follows `onApprovalDenied`;
- post-step approval after daemon restart continues workflow;
- skipped optional step allows downstream step to start on a later orchestrator tick.

Web tests:

- workflow card shows post gate label;
- blocked step shows policy-derived blocker;
- output packet artifact chip appears after terminal reconciliation.

## Development Notes For Slices A-F

These notes are the per-slice development specs. They are intentionally shorter
than standalone designs, but precise enough to start implementation and review.

Use this rule before opening each slice:

```text
Read the main slice section.
Read the matching development note below.
Implement only that slice's additive contract.
Run the slice-specific tests plus the shared validation matrix.
Do not opportunistically implement later slices.
```

### Slice A: Stale Completion Audit Event

Primary objective:

- preserve terminal Ling state when late runner completion arrives;
- leave durable evidence explaining the ignored completion.

Likely files:

| File | Change |
| --- | --- |
| `packages/core/src/run-types.ts` | add `stale_runner_completion_ignored` run event type |
| `packages/core/src/runtime-supervisor-types.ts` | add runtime event type if runtime diagnostics need first-class filtering |
| `packages/daemon/src/features/runs/orchestrator.ts` | audit late terminal runner result after cancellation or failed CAS |
| `packages/daemon/src/run-control.ts` | reuse helper when control path rejects terminal transition |
| `packages/daemon/src/features/runs/work-units.ts` | keep work-unit stale/terminal rejection audited where applicable |
| `packages/daemon/src/features/runs/__tests__/*` | daemon regression tests |

Implementation sequence:

1. Add the event type and payload helper.
2. Add idempotent append helper near run-control/orchestrator code.
3. Wire helper into the runner success branch before returning on already-cancelled run.
4. Wire helper into terminal transition failure paths only after proving the failure is
   caused by current terminal state or non-current attempt.
5. Add evidence rendering only if current run/timeline UI hides unknown event types.

Event append constraints:

- never transition run/work-unit state inside the audit helper;
- never throw from the audit helper if diagnostic append fails;
- include `attemptId` and current durable statuses whenever available;
- dedupe by `runId + workUnitId + attemptId + reportedStatus + current statuses`;
- keep the original terminal state authoritative.

Test checklist:

- cancelled run plus late runner success remains cancelled;
- cancelled work unit plus late runner success remains cancelled;
- event appears once after duplicate late completions;
- non-current attempt completion is audited and ignored;
- no audit event is written for normal success.

Exit criteria:

- stale completion has visible durable evidence;
- existing cancellation behavior does not change;
- tests prove both run state and work-unit state remain terminal.

### Slice B: Explicit Runner Fallback Policy

Primary objective:

- make runner fallback policy explicit;
- preserve Pi default for existing requests;
- fail closed when a user/workflow explicitly asks for an unsupported runner.

Likely files:

| File | Change |
| --- | --- |
| `packages/core/src/runtime-supervisor-types.ts` | shared settings/fallback contract if exported from core |
| `packages/daemon/src/runtime/runners.ts` | resolution source, allowed runners, explicit/implicit fallback policy |
| `packages/daemon/src/runtime/store-registry.ts` or store layer | workspace settings load/save |
| `packages/daemon/src/server/router.ts` | route `GET/PATCH /runtime/settings`, `GET /runners` |
| `packages/daemon/src/features/runs/orchestrator.ts` | pass request source into runner resolution |
| `apps/web/src/api.ts` | typed API client methods |
| daemon/core tests | policy and compatibility tests |

Development decisions to lock before coding:

- settings storage location: file-backed workspace runtime settings at
  `.ling-stack/runtime-settings.json`; user-level defaults may seed missing workspace
  fields under [Two-Layer Configuration](two-layer-configuration.md), but the workspace
  runtime settings file remains the execution authority once written;
- default settings: `defaultRunnerId = "pi"`,
  `implicitRunnerFallback = "allow_to_default"`,
  `explicitRunnerFallback = "disabled"`;
- request source classification must be assigned before calling
  `RunnerRegistry.resolve()`, not inferred after fallback;
- explicit workflow step runner means explicit fallback policy, even if the runner id
  came from a template.

Resolution rules to implement:

```text
if requestSource is explicit:
  allowFallback = explicitRunnerFallback === "allow_to_default"
else:
  allowFallback = implicitRunnerFallback === "allow_to_default"

if requestedRunnerId not in allowedRunnerIds:
  fail with unsupported_runner before fallback

if fallback happens:
  effectiveRunnerId must be defaultRunnerId
  fallbackReason must be persisted to work unit/run audit
```

Compatibility checks:

- old requests with no runner id still resolve to Pi;
- legacy `pi-coding-agent` aliases normalize to `pi`;
- unknown explicit runner returns a structured daemon error;
- disabled workspace default falls back only when implicit fallback allows it;
- changing fallback policy does not mutate old run records.

Test checklist:

- settings seed and round-trip;
- explicit unknown runner fails closed;
- implicit missing runner falls back with audit;
- unsupported provider API follows explicit/implicit policy;
- invalid default runner cannot be saved;
- existing teammate/run request tests keep passing without runner selection.

Exit criteria:

- fallback policy is visible in API response;
- every fallback has `requestedRunnerId`, `effectiveRunnerId`, and `fallbackReason`;
- explicit runner mistakes do not silently run on Pi unless policy opts in.

### Slice C: Runner Audit UI

Primary objective:

- show runner identity and fallback reason in the places users inspect execution;
- avoid exposing package internals as primary labels.

Likely files:

| File | Change |
| --- | --- |
| `apps/web/src/lib/runner-audit.ts` | shared view model and formatting |
| `apps/web/src/features/runs/RunHistory.tsx` | run detail runner row |
| `apps/web/src/features/runs/RunTimeline.tsx` | event/timeline diagnostic if useful |
| `apps/web/src/features/workspace/WorkspaceClientView.tsx` | workflow step runner row |
| `apps/web/src/features/settings/SettingsPage.tsx` | runtime runner settings surface |
| `apps/web/src/api.ts` | consume runner/settings endpoints from Slice B |
| `apps/web/src/i18n.tsx` | labels and fallback copy |

Implementation sequence:

1. Build `RunnerAuditViewModel` in a shared helper.
2. Render read-only audit rows in Runs and workflow cards first.
3. Add Settings Runtime controls only after Slice B endpoints exist.
4. Add fallback warning badge and compact no-fallback row.
5. Add legacy/unknown state for old runs.

Display rules:

- no fallback: `Runner: Pi`;
- fallback: `Runner: requested -> effective` plus reason badge;
- legacy: `Runner: unknown legacy run`;
- disabled/missing runner errors: show resolution failure text, not a blank row;
- never use npm package names as the main UI label.

Concurrency/data rules:

- Web must not infer fallback by comparing strings alone when `fallbackReason` is
  present;
- if runtime state refresh and run list disagree, prefer freshest runtime/work-unit
  state in expanded detail and keep run row compact;
- settings save should use request-id or latest-request guard to avoid old responses
  overwriting newer selections.

Test checklist:

- run with no fallback displays compact row;
- fallback run displays warning badge and reason;
- old run without audit displays legacy state;
- settings page rejects unavailable runner;
- settings page round-trips default runner and policies.

Exit criteria:

- users can answer "which runner actually executed this?" from run detail;
- fallback is impossible to miss on run/workflow evidence surfaces.

### Slice D: Action Preview And Result Artifacts

Primary objective:

- persist what the user approved before side effects;
- persist what happened after tool execution;
- keep redaction and artifact path safety stronger than UI convenience.

Likely files:

| File | Change |
| --- | --- |
| `packages/daemon/src/features/runs/action-artifacts.ts` | new preview/result artifact helper |
| `packages/daemon/src/features/runs/artifacts.ts` | reuse content type, path, redaction helpers |
| `packages/daemon/src/features/runs/orchestrator.ts` | create preview before approval, link results after `tool_end` |
| `packages/daemon/src/features/runs/execution-actions.ts` | derive preview/result artifact ids |
| `packages/core/src/run-types.ts` | only add metadata if current `ExecutionAction` fields are insufficient |
| `apps/web/src/features/approvals/*` | preview artifact chips in approval cards |
| `apps/web/src/features/runs/*` | action result artifact chips in evidence rows |

Implementation phases:

1. D1 preview artifacts for `bash`, `edit`, `write`.
2. D2 result artifact linkage from existing `persistExtractedArtifacts()`.
3. D3 Web rendering for preview/result chips.
4. D4 expand to git/external actions later, after D1-D3 are stable.

Preview builder rules:

- `bash`: JSON only, include command, cwd, risk flags, redaction notes;
- `edit`: diff artifact when a safe diff can be generated;
- `write`: metadata JSON by default, content excerpt only when redaction succeeds;
- if preview cannot be generated safely, create metadata-only preview and require
  approval with warning;
- no preview artifact may point outside `.ling-stack/artifacts`.

Result linkage rules:

- match result artifacts by `runId + toolCallId`;
- keep `ExecutionAction` as a read model. Derive `previewArtifactIds` from approval
  payload/event metadata and `resultArtifactIds` from existing `artifact_created`
  events rather than adding an action artifact table;
- denied/expired/cancelled actions keep preview artifacts and no result artifacts;
- failed actions can have result/error artifacts;
- artifact extraction remains best-effort, but linking must not claim missing
  artifacts exist.

Security checklist:

- call `redactSecrets()` before writing preview content;
- include provider/workspace secret values where available;
- never write raw env values to preview JSON;
- path traversal must fail closed;
- large content should be truncated with size metadata.

Test checklist:

- `bash` approval creates preview JSON;
- `edit` approval creates preview diff;
- `write` preview redacts secret-looking content;
- denied action has preview and no result;
- successful action links result artifact ids;
- artifact content route still blocks traversal.

Exit criteria:

- approval UI can show durable preview artifacts before approval;
- action evidence can show durable result artifacts after execution;
- redaction failure degrades to metadata-only preview, not raw content leakage.

### Slice E: Resume Context Preview

Primary objective:

- show the exact resume context before starting a continuation run;
- force preview and execute paths to share the same builder.

Likely files:

| File | Change |
| --- | --- |
| `packages/core/src/run-types.ts` | request/response/context preview contracts |
| `packages/daemon/src/server/routes.ts` | parse `/threads/:id/resume-preview` |
| `packages/daemon/src/features/runs/thread-routes.ts` | preview route and shared builder |
| `apps/web/src/api.ts` | `previewLingThreadResume()` client |
| `apps/web/src/features/runs/RunHistory.tsx` | first preview surface |
| `apps/web/src/features/runs/RunHistory.tsx` | thread-first detail mode now owns the primary preview/resume UI |

Builder constraints:

- implement `buildLingThreadResumeContext()` once;
- preview mode returns context only and never creates a run;
- execute mode calls the same builder and then starts run;
- identical input must select identical `sourceRun`;
- active non-terminal thread returns warning in preview and blocks execute;
- artifact inclusion initially means ids and summaries, not raw content.

Context selection rules:

```text
if sourceRunId provided:
  use that run if it belongs to the thread
else if thread.lastRunId exists:
  use lastRunId
else:
  use newest terminal run in thread
```

Warnings:

- active run exists;
- source run has no reusable provider snapshot;
- pending actions exist;
- artifacts omitted or metadata-only due to redaction;
- thread evidence is empty or partially unavailable.

Test checklist:

- preview does not create a run;
- preview and resume use same source run;
- sourceRunId outside thread fails;
- active thread preview warns and execute fails;
- redaction notes and pending action ids appear;
- Web preview button does not call resume endpoint.

Exit criteria:

- user can inspect resume context before starting;
- resume behavior cannot drift from preview behavior.

### Slice F: Orchestrator Context And Output Packets

Primary objective:

- make workflow step input/output durable and explicit;
- let downstream steps consume upstream output through packet references instead of
  hidden prompt history.

Likely files:

| File | Change |
| --- | --- |
| `packages/core/src/workspace-types.ts` | context/output packet contracts and metadata ids |
| `packages/core/src/storage/sqlite-run-store.ts` | metadata JSON parser allowlist for packet ids |
| `packages/daemon/src/features/channels/workflow-step-packets.ts` | new builders |
| `packages/daemon/src/server/router.ts` | attach context packet from orchestrated `onRunReady` |
| `packages/daemon/src/features/channels/orchestrator.ts` | terminal run callback writes output packet |
| `apps/web/src/features/workspace/WorkspaceClientView.tsx` | step context/output chips |
| daemon channel workflow tests | dependency and recovery tests |

Pre-implementation search:

```bash
rg -n "startChannelWorkflowStep|retryChannelWorkflowStep|ChannelWorkflowStep" packages/daemon/src packages/core/src apps/web/src
```

Packet ownership rules:

- context packet is generated once the run exists, before the runner performs useful
  step work in the normal path;
- output packet is generated after linked run terminal reconciliation;
- dependency output refs must belong to the same workflow;
- if context packet generation fails after run creation, keep the run authoritative
  and leave packet repair to recovery tooling;
- do not paste large artifact content into prompts by default.

Metadata rules:

```ts
metadata.contextArtifactId = canonical context packet artifact
metadata.outputArtifactId = canonical output packet artifact
metadata.outputArtifactIds = canonical output packet plus additional user-facing artifacts
```

Storage detail:

```text
.ling-stack/artifacts/{runId}/workflows/{workflowId}/steps/{workflowStepId}/context.json
.ling-stack/artifacts/{runId}/workflows/{workflowId}/steps/{workflowStepId}/output.json
```

Because `RunArtifact` still requires exactly one run/media/external-work owner, packet
artifacts are run-linked in this slice. If workflow packet listing without a run
becomes a Web requirement, add workflow ownership to the artifact schema instead of
duplicating packet tables.

Prompt assembly rules:

- include objective, current step prompt, dependency summaries, artifact ids;
- include runner audit when already resolved;
- include approval gate summary, not approval secrets;
- never use output packet as permission to bypass approval policy.

Recovery rules:

- startup recovery reads durable metadata first;
- missing context packet for not-yet-started step can be regenerated;
- missing output packet for terminal linked run can be regenerated idempotently;
- output packet id should not change if packet already exists unless explicit repair
  is requested.

Test checklist:

- first step context includes workflow objective;
- dependent step context includes prior output ref;
- cross-workflow dependency is rejected;
- terminal run creates output packet;
- metadata parser preserves `contextArtifactId`, `outputArtifactId`, and
  `outputArtifactIds`;
- restart recovery does not duplicate packet artifacts when repair mode is added.

Exit criteria:

- every started workflow step has a context packet;
- every terminal workflow step has an output packet or an explicit blocker;
- downstream prompt assembly can be explained from stored packet ids.

## Validation Matrix

Run after every slice:

```bash
git diff --check
corepack pnpm typecheck
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
```

Run after Web changes:

```bash
corepack pnpm --filter @ling-stack/web build
```

Browser smoke after UI slices:

- Runs page loads;
- selecting a run still works;
- selecting a thread does not produce `/threads` 404;
- approval preview artifacts render;
- runner fallback warning renders;
- resume preview opens without starting a run.

## Recommended Build Order

1. Stale completion audit event.
2. Explicit runner fallback policy and settings storage.
3. Runner audit UI.
4. Action preview/result artifacts for `bash`, `edit`, and `write`.
5. Resume context preview endpoint and first Web preview surface.
6. Thread-first page inside Runs.
7. Orchestrator context/output packets.
8. Failure/block policy and post-step gates.

This order keeps early slices low-risk and makes later orchestration work easier to
debug because stale completions, runner resolution, and action evidence are already
visible.

## Open Decisions Before Implementation

- Whether `RunSession` should persist runner audit fields immediately or derive them
  from `WorkUnit` for one release.
- Whether workflow JSON artifacts should extend `RunArtifact` with workflow ownership
  fields or stay linked only through step metadata initially.
- Whether thread-first page should be nested in Runs or become a first-class app tab
  after AppShell domain modularization.
- Whether post-step gates should be template-defined only or user-editable in the
  workflow UI.
