# Execution And Orchestration Hardening

## Purpose

This document defines the follow-up hardening plan for the three execution designs that
are now implemented at their first useful slice:

- [Codex-Like Execution Experience](codex-like-execution.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)
- [Runner Registry](runner-registry.md)

The first implementation made the core flows real:

```text
LingThread / RunSession / ExecutionAction
WorkflowTemplate / ChannelWorkflow / ChannelWorkflowStep
RunnerRegistry / Pi default runner / runner audit fields
```

The next work is not a rewrite. It is a hardening layer that makes these flows safer,
more inspectable, and closer to a durable project-work experience.

Implementation detail plan:

- [Execution And Orchestration Hardening Implementation Plan](./state-machine-recovery.md)

## High-Level Design

### Product Goal

Make Ling Stack feel reliable when it does real project work:

```text
user asks for work
-> Ling creates a durable thread/workflow/run
-> risky actions have previews
-> execution results link back to evidence artifacts
-> multi-agent steps exchange explicit context packets
-> failures block or fail according to declared policy
-> runner selection is visible and deterministic
-> resume has a visible context preview before starting
```

### Architectural Principle

The hardening layer should keep existing ownership boundaries:

```text
RunnerRegistry owns runner resolution and runner audit.
Orchestrator owns workflow sequencing and step context.
Codex-like execution owns actions, evidence, threads, and resume.
Runtime supervisor owns work-unit lifecycle, cancellation, stale detection, and CAS.
Approval policy owns side-effect permission.
```

No hardening item should let a runner, teammate, or final assistant message silently
advance workflow state, approve side effects, mutate memory/persona, or change runner
defaults.

### Integrated Flow

Target execution flow after hardening:

```text
User starts task/thread/workflow
  -> RunnerRegistry resolves requested/effective runner
  -> Ling records runner audit fields
  -> Orchestrator builds step context packet when workflow-owned
  -> Runner emits proposed side effects
  -> ExecutionAction records preview artifacts and target refs
  -> User approves/denies
  -> Runner executes
  -> Ling links result artifacts and state transitions
  -> Thread/workflow evidence bundle includes runner, action, preview, result, and step context
  -> User can resume with a visible context preview
```

## Scope

### Included

Codex-like hardening:

- action preview/result artifacts,
- thread-first page,
- resume context preview,
- stale completion audit event.

Orchestrator hardening:

- step context packet,
- step output packet,
- failure/block policy,
- post-step gates.

RunnerRegistry hardening:

- workspace default runner settings,
- explicit fallback policy,
- runner audit UI.

### Excluded

- Codex app-server adapter.
- OpenClaw/ACP adapter.
- Parallel workflow execution.
- Model-generated workflow summaries without explicit approval or deterministic fallback.
- Global client state manager.
- Native runner resume as a prerequisite for Ling resume.

## Current Implementation Notes

Status as of 2026-06-05:

- stale completion audit, explicit runner fallback policy, runner audit UI, action
  preview/result artifacts, resume context preview, and orchestrator context/output
  packets are implemented as additive slices;
- workspace runtime runner settings are stored in `.ling-stack/runtime-settings.json`;
- action artifacts reuse the existing run artifact system and execution-action read
  model instead of adding an action artifact table;
- resume preview and resume execution share the same deterministic context builder;
- workflow context/output packets are run-linked JSON artifacts because `RunArtifact`
  currently requires a run/media/external-work owner;
- workflow step packet ids live in `ChannelWorkflowStep.metadata`, and the SQLite
  metadata parser must be updated for every new metadata key;
- failure policy and post-step gates are implemented in backend reconciliation and
  workflow-step approval cards;
- workspace step cards show workflow packet artifact chips plus policy/gate detail
  rows;
- workflow packet summaries are prepended to step prompts, including objective,
  dependency summaries, artifact ids, and approval gate summaries.

## Design 1: Codex-Like Hardening

### 1.1 Action Preview And Result Artifacts

Current state:

- `ExecutionAction` exists as an approval-backed read model.
- Contracts already include `previewArtifactIds` and `resultArtifactIds`.
- Approval cards render structured payload previews.
- Durable preview/result artifact linkage is implemented through run artifacts and
  read-model derivation.

Target state:

```text
ExecutionAction
  -> previewArtifactIds before approval
  -> resultArtifactIds after execution or failure
  -> targetRefs for run/task/thread/file/command/mcp/external object
  -> policySnapshot and risk classification
```

Preview artifacts should be generated before approval when the action has side effects.
Result artifacts should be linked after execution, denial, failure, or cancellation.

#### Preview Artifact Types

| Action Type | Preview Artifact |
| --- | --- |
| `bash` | command summary, cwd, env redaction summary, risk flags, affected-path estimate |
| `edit` | unified diff preview or structured file patch preview |
| `write` | target path, byte count, file type, overwrite/create risk, content preview when safe |
| `git_commit` | staged diff summary, files changed, commit message preview |
| `git_push` | local branch, remote, commits to push, protected-branch risk |
| `external_send` | target service, redacted payload, idempotency key, mutation endpoint |
| `deploy` | target environment, build artifact refs, rollback info if available |
| `media_cost` | legacy media approval preview: provider, operation, prompt/input summary, estimated cost token/unit info |
| `credential_change` | secret ref only, never raw value |
| `provider_change` | changed fields, previous/current non-secret summary |
| `mcp_tool_call` | server/tool name, arguments with redaction, declared approval risk |

#### Result Artifact Types

| Outcome | Result Artifact |
| --- | --- |
| approved and executed | stdout/stderr summary, changed files, generated files, tool result metadata |
| denied | denial reason, no side-effect marker |
| failed | normalized error, stderr/log snippet, redacted stack or API error |
| cancelled | cancellation reason, partial output marker |
| stale target | stale target evidence, current target snapshot |

### 1.2 Thread-First Page

Current state:

- Run History has a thread rail.
- Selecting a thread opens a thread-first detail mode inside Runs.
- Thread detail shows header/objective/status, active/last run, lineage, action
  preview/result artifacts, queued follow-ups/interventions, state transitions, source-run
  selection, and resume context preview.
- A standalone thread route remains optional; it is not required for the current
  hardening boundary.

Target state:

```text
Thread page
  -> thread header and status
  -> active run card
  -> run lineage timeline
  -> pending approvals/actions
  -> queued follow-ups/interventions
  -> evidence bundle
  -> artifacts
  -> resume composer with context preview
```

This should not replace Run History immediately. It should become the primary surface
for long-lived work while Run History remains the low-level attempt log.

### 1.3 Resume Context Preview

Current state:

- `POST /threads/:id/resume` starts a manual resume continuation.
- `POST /threads/:id/resume-preview` returns the exact deterministic context without
  creating a run.

Target state:

```text
Resume composer
  -> user writes instruction
  -> Preview context
  -> user sees source run, thread facts, bounded prior summaries, artifacts, pending actions
  -> Start resume
```

The preview should be deterministic and redacted. It should not call a model.

Suggested endpoint:

```http
POST /threads/:threadId/resume-preview?cwd=...
```

Request:

```ts
interface LingThreadResumePreviewRequest {
  readonly sourceRunId?: string;
  readonly instruction?: string;
  readonly includeArtifacts?: boolean;
}
```

Response:

```ts
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

`POST /threads/:id/resume` should reuse the same context builder so preview and start
cannot drift.

### 1.4 Stale Completion Audit Event

Current state:

- State-machine guards prevent late runner success from overwriting cancelled state.
- Dedicated `stale_runner_completion_ignored` run/runtime diagnostic events are
  implemented and covered by daemon tests.

Target state:

When a runner reports completion after the run/work unit is already terminal in a newer
state, Ling should persist a diagnostic event:

```text
stale_runner_completion_ignored
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
  readonly reason: "terminal_state_changed" | "attempt_not_current" | "run_cancelled" | "work_unit_cancelled";
  readonly runnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly reportedAt: string;
}
```

This event is evidence only. It must not change run status.

## Design 2: Orchestrator Hardening

### 2.1 Step Context Packet

Current state:

- Workflow steps persist metadata such as template step id, dependencies, teammate,
  skill, approval gate, runner, and provider override.
- Started workflow steps now link to context/output packet artifacts from metadata;
  packet summaries are now included in step prompt assembly without pasting large
  artifact contents.

Target state:

Each workflow step should have a deterministic context packet before it starts.

```text
ChannelWorkflowStep
  -> context packet
     -> workflow objective
     -> current step identity
     -> dependency outputs
     -> active decisions
     -> acceptance criteria
     -> linked artifacts
     -> runner/provider/tool constraints
     -> approval gates
```

Suggested type:

```ts
interface ChannelWorkflowStepContextPacket {
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly templateStepId?: string;
  readonly generatedAt: string;
  readonly objective: string;
  readonly stepTitle: string;
  readonly stepPrompt: string;
  readonly teammateId?: string;
  readonly skillId?: string;
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly providerPresetId?: string;
  readonly dependencyStepIds: readonly string[];
  readonly dependencyOutputs: readonly WorkflowStepOutputRef[];
  readonly activeDecisionIds: readonly string[];
  readonly contextSummaryIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly warnings: readonly string[];
}

interface WorkflowStepOutputRef {
  readonly workflowStepId: string;
  readonly runId?: string;
  readonly status: ChannelWorkflowStep["status"];
  readonly summary: string;
  readonly artifactIds: readonly string[];
  readonly changedPaths: readonly string[];
}
```

The context packet can be stored as:

1. a JSON artifact linked from workflow step metadata, or
2. a dedicated `workflow_step_context_packets` table.

Recommendation: start with JSON artifact plus typed metadata fields. Move to a table if
querying context packets becomes important.

### 2.2 Step Output Packet

Each terminal workflow step should produce a deterministic output packet:

```ts
interface ChannelWorkflowStepOutputPacket {
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly runId?: string;
  readonly status: "succeeded" | "failed" | "cancelled" | "blocked" | "skipped";
  readonly completedAt: string;
  readonly summary: string;
  readonly terminalReason?: string;
  readonly artifactIds: readonly string[];
  readonly changedPaths: readonly string[];
  readonly approvalIds: readonly string[];
  readonly actionIds: readonly string[];
  readonly nextStepHints: readonly string[];
  readonly warnings: readonly string[];
}
```

This output packet is the dependency input for later steps, but it is not a generic
completion receipt. Execution and verification steps require verified `ExecutionAction`
refs for their immutable operation subset. Synthesis/review steps may use a sealed,
source-bound output packet. The shared delegated finalizer chooses the evidence class
from the immutable step requirement; a terminal Run or a model-authored `status` field
cannot choose it.

### 2.3 Failure And Block Policy

Legacy baseline:

- Terminal linked runs once completed/failed steps directly. The Continuity v2 completion
  path removes this shortcut: terminal Run state now only wakes delegated reconciliation.
- Orphaned claimed/running steps become blocked.
- Retry can restart blocked steps.

Target state:

Every template step has a declared failure policy.

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
```

Recommended defaults for `autoplan-lite`:

| Step | Run Failed | Approval Denied | Retryable |
| --- | --- | --- | --- |
| product-discovery | block_for_user | block_for_user | yes |
| product-review | block_for_user | block_for_user | yes |
| design-review | block_for_user | block_for_user | yes |
| engineering-review | block_for_user | block_for_user | yes |
| implementation | fail_workflow | block_for_user | yes |
| code-review | block_for_user | block_for_user | yes |
| qa | block_for_user | block_for_user | yes |
| ship | fail_workflow | block_for_user | yes |

Policy must be durable in workflow step metadata so recovery after daemon restart makes
the same decision.

Policy applies only after the shared finalizer produces a typed delegated outcome. It
cannot turn `Run.succeeded`, assistant `ready` text, or an approval decision into step
success. Workflow success is a separate Completion Evaluation over the immutable required
participant manifest, graph branches, operation evidence, dependencies, fan-in policy,
and termination policy.

### 2.4 Post-Step Gates

Current state:

- Pre-step approval gates exist.
- Tool/side-effect approval gates exist during runs.
- There is no explicit gate after a step completes before the next step starts.

Target state:

Templates can declare post-step gates:

```ts
interface WorkflowStepGate {
  readonly stage: "pre" | "post";
  readonly approvalProfile: SkillApprovalProfile;
  readonly title: string;
  readonly reason: string;
  readonly requiredForStatuses?: readonly ChannelWorkflowStep["status"][];
}
```

Use cases:

- require user review after `engineering-review`,
- require user review before `implementation` consumes design output,
- require release confirmation after `qa`,
- require ship confirmation after deterministic final summary.

Approval payload:

```ts
interface WorkflowStepApprovalPayload {
  readonly type: "workflow_step";
  readonly gateStage: "pre" | "post";
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly templateStepId?: string;
  readonly contextArtifactId?: string;
  readonly outputArtifactId?: string;
}
```

Post-step approval should transition:

```text
step.succeeded
  -> waiting_for_post_approval
  -> approval approved
  -> step.closed
  -> next step eligible
```

If the existing state machine cannot represent `waiting_for_post_approval` or `closed`,
use current `waiting_for_approval` with gate metadata in the first implementation. Add
new statuses only if the UI ambiguity becomes too high.

## Design 3: RunnerRegistry Hardening

### 3.1 Workspace Default Runner Settings

Current state:

- `pi` is the product default.
- Requests and teammates can carry optional `runnerId`.
- The final storage location for workspace default runner is still open.

Target state:

Workspace runtime settings should own runner defaults:

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

Recommended defaults:

```json
{
  "defaultRunnerId": "pi",
  "allowedRunnerIds": ["pi"],
  "explicitRunnerFallback": "disabled",
  "implicitRunnerFallback": "allow_to_default"
}
```

Rationale:

- Explicit user selection should fail closed when unavailable.
- Implicit selection from legacy/default paths may fallback to `pi` with audit.
- Settings belong to workspace runtime configuration, not provider presets and not
  approval policy.

Suggested APIs:

```http
GET /runtime/settings?cwd=...
PATCH /runtime/settings?cwd=...
GET /runners?cwd=...
```

`GET /runners` should list registry metadata, enabled state, provider/tool support, and
whether each runner passes current conformance status if known.

### 3.2 Explicit Fallback Policy

Resolution input should distinguish where the request came from:

```ts
type RunnerRequestSource =
  | "product_default"
  | "workspace_default"
  | "teammate_default"
  | "workflow_step"
  | "run_request"
  | "user_explicit";

interface RunnerResolutionInput {
  readonly requestedRunnerId?: string;
  readonly defaultRunnerId: string;
  readonly requestSource: RunnerRequestSource;
  readonly fallbackPolicy: RunnerFallbackPolicy;
}

interface RunnerFallbackPolicy {
  readonly explicit: "disabled" | "allow_to_default";
  readonly implicit: "disabled" | "allow_to_default";
}
```

Rule:

```text
requestSource == user_explicit or run_request with explicit runnerId
  -> explicit fallback policy
otherwise
  -> implicit fallback policy
```

Fallback event:

```ts
interface RunnerFallbackAudit {
  readonly requestedRunnerId: string;
  readonly effectiveRunnerId: string;
  readonly requestSource: RunnerRequestSource;
  readonly reason: RunnerFallbackReason;
  readonly policy: RunnerFallbackPolicy;
}
```

Fallback remains additive audit data. It must never silently change runner identity.

### 3.3 Runner Audit UI

Runner audit should be visible wherever execution evidence is inspected:

| Surface | Fields |
| --- | --- |
| Run Detail | requested runner, effective runner, fallback reason, provider API support |
| Runtime/Work Unit panel | attempt runner id, requested/effective runner, fallback reason |
| Workflow step card | requested/effective runner for the step |
| Thread evidence | runner per run and per workflow step |
| Settings Runtime panel | default runner, allowed runners, fallback policy |

Display rules:

- If requested and effective runner match, show one compact runner row.
- If fallback occurred, show a warning badge and reason.
- If runner is unknown or disabled, show fail-closed reason rather than hiding the row.
- Never show package internals as the primary user label. Use stable ids and display
  names.

## Detailed Implementation Plan

### Slice A: Codex-Like Action Artifacts

Backend:

1. Add preview artifact builder helpers under `packages/daemon/src/features/runs/`.
2. Generate preview artifacts when creating approval requests for `bash`, `edit`, and
   `write`.
3. Link generated preview artifact ids through `ExecutionAction.previewArtifactIds`.
4. Link result artifact ids from tool outputs and daemon artifact extraction through
   `ExecutionAction.resultArtifactIds`.
5. Keep existing approval APIs compatible.

Contracts:

- Reuse existing `ExecutionAction.previewArtifactIds` and `resultArtifactIds`.
- Add action preview metadata only if artifact ids are insufficient for Web rendering.

Web:

- Render preview/result artifact chips in approval cards and thread evidence.
- Add "Preview" and "Result" sections to action detail rows.

Tests:

- approval for `bash` creates preview artifact,
- `write` preview artifact redacts content when needed,
- denied action has no result artifact but has denial evidence,
- executed action links result artifacts,
- artifact path traversal remains blocked.

### Slice B: Thread Page And Resume Preview

Backend:

1. Add `POST /threads/:id/resume-preview`.
2. Extract shared `buildLingThreadResumeContext()` used by both preview and resume.
3. Ensure preview and resume use the same source run resolution.
4. Include redaction notes and warnings.

Contracts:

- Add `LingThreadResumePreviewRequest`.
- Add `LingThreadResumePreviewResponse`.
- Add `ResumeContextPreview`.

Web:

- Implemented inside Runs as the first shell target.
- Shows thread status, lineage, evidence, actions, artifacts, queued follow-ups, and
  resume context preview.
- Existing Run History thread rail links into this view.

Tests:

- preview does not start a run,
- resume after preview uses same source run/context builder,
- terminal thread can resume,
- active thread cannot start conflicting manual resume without policy decision,
- redaction notes appear when context includes sensitive refs.

### Slice C: Stale Completion Audit

Backend:

1. Detect stale terminal runner reports at the point where state transition is rejected.
2. Append `stale_runner_completion_ignored` run event and runtime event when possible.
3. Include runner audit metadata.
4. Ensure event append is idempotent per run/attempt/reported terminal status.

Tests:

- late success after cancel preserves `cancelled`,
- stale diagnostic event is persisted,
- duplicate late success does not spam duplicate diagnostics,
- thread status remains cancelled or failed according to current durable state.

### Slice D: Orchestrator Context And Output Packets

Backend:

1. Add typed context packet builder.
2. Generate context packet after the workflow-owned run is durable, because current
   artifacts are run-owned.
3. Store context packet as JSON artifact and link id in workflow step metadata.
4. When a linked Run reaches terminal status, invoke the shared delegated finalizer. It
   generates an output packet only for the evidence class declared by the immutable step
   requirement and commits the packet/outcome/step transition atomically.
5. Feed dependency output packets into downstream context packet.

Contracts:

- Add optional `contextArtifactId` and `outputArtifactId` to workflow step metadata
  contracts if not already expressible.
- Add `GET /workflow-steps/:id/context` only if Web needs direct loading without reading
  artifacts through existing artifact APIs.

Web:

- Show "Context" on workflow step card.
- Show dependency outputs and warnings before `Advance`.
- Show output packet in final summary.

Tests:

- first step context contains workflow objective,
- dependent step context includes prior output packet,
- artifacts referenced by dependency are scoped to same channel/workflow,
- metadata parser preserves context/output artifact ids.

### Slice E: Orchestrator Failure Policy And Post-Step Gates

Backend:

1. Add failure policy fields to compiled step metadata. Implemented.
2. Apply policy in terminal run reconciliation. Implemented.
3. Add gate stage metadata to workflow-step approval payload. Implemented.
4. Add post-step gate handling after terminal step success. Implemented.
5. Keep recovery deterministic by reading durable policy metadata. Implemented with
   ordinary reconciliation and restart-specific regression coverage.

Web:

- Show policy outcome on blocked/failed step.
- Show pre/post gate label.
- Add "Approve post-step" UX through existing approval surfaces.

Tests:

- planning failure blocks,
- implementation failure fails workflow,
- post-step approval prevents next step from starting,
- post-step approval allows downstream start after approval,
- run cancellation follows `onRunCancelled`,
- approval denial follows `onApprovalDenied`,
- post-step approval after daemon restart continues workflow correctly,
- skipped optional step allows downstream step to start on a later orchestrator tick.

### Slice F: Runner Settings And Fallback Policy

Backend:

1. Add workspace runtime settings storage.
2. Add `GET/PATCH /runtime/settings`.
3. Add `GET /runners`.
4. Extend runner resolution input with request source and fallback policy.
5. Fail explicit missing runner when explicit fallback is disabled.
6. Preserve Pi default for existing requests.

Contracts:

- Add `WorkspaceRuntimeSettings`.
- Add `RunnerListResponse`.
- Add `RunnerResolutionAudit` if current fallback reason is not enough for UI.

Web:

- Add Runtime Runner section in Settings.
- Add runner audit rows in Run Detail and Work Unit panel.
- Show fallback warning badge.

Tests:

- default runtime settings seed to Pi,
- explicit unknown runner fails closed,
- implicit missing runner can fallback with audit when policy allows,
- Web settings round-trip does not allow unavailable runner as default,
- runner audit appears in run/work-unit responses.

## Data Model Summary

New or hardened data objects:

```text
ExecutionAction.previewArtifactIds
ExecutionAction.resultArtifactIds
ResumeContextPreview
stale_runner_completion_ignored event
ChannelWorkflowStepContextPacket
ChannelWorkflowStepOutputPacket
WorkflowStepPolicy
WorkflowStepGate
WorkspaceRuntimeSettings
RunnerFallbackAudit
```

The first implementation should prefer additive fields and JSON artifacts over invasive
schema changes. Add dedicated tables only when query patterns require them.

## Recommended Build Order

1. Stale completion audit event.
2. Runner explicit fallback policy.
3. Runner audit UI.
4. Action preview/result artifacts for `bash`, `edit`, `write`.
5. Resume context preview endpoint and Web preview.
6. Thread-first page.
7. Orchestrator context/output packets.
8. Orchestrator failure policy.
9. Post-step gates.
10. Workspace runtime runner settings UI.

Reasoning:

- Stale audit and fallback policy are small but improve safety immediately.
- Action artifacts and resume preview improve user trust before larger UI work.
- Thread page depends on evidence/action previews.
- Orchestrator context packets should land before post-step gates because gates should
  show what the user is approving.
- Runtime settings UI is safest after fallback behavior is already enforced.

## Validation Plan

Run for all hardening slices:

```bash
git diff --check
corepack pnpm typecheck
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/web build
```

Add targeted browser smoke for UI slices:

- approval card shows preview/result artifacts,
- thread page loads evidence and resume preview,
- workflow step context is visible before start,
- post-step gate blocks next step,
- runner audit warning appears when fallback occurs,
- settings cannot select unavailable runner as default.

## Risk Register

| Risk | Mitigation |
| --- | --- |
| Preview artifacts leak secrets | redaction before persistence; fail closed on high-risk preview failure |
| Thread page duplicates Run History complexity | thread page owns lineage/evidence; Run History remains attempt log |
| Resume preview drifts from real resume | shared context builder for preview and start |
| Workflow context packet becomes model-generated noise | deterministic packet first; model summary only later and approval-gated |
| Failure policy surprises users | show policy on step card before execution |
| Post-step gates create too much friction | only enable on high-risk steps by template metadata |
| Runner fallback hides wrong backend | explicit fallback disabled by default and fallback warning in UI |
| Schema churn blocks iteration | use additive fields and JSON artifacts first |

## Success Criteria

Codex-like hardening is successful when:

- users can see preview artifacts before approving risky actions,
- users can inspect result artifacts after actions complete,
- users can open a thread-first page without hunting through run attempts,
- users can preview resume context before starting a continuation,
- stale runner completion is auditable, not just ignored.

Orchestrator hardening is successful when:

- every workflow step starts with a visible context packet,
- downstream steps consume upstream output packets,
- failed steps block or fail according to durable policy,
- post-step gates can pause the workflow before the next step starts,
- restart recovery makes the same policy decisions.
- execution-backed steps never succeed from `ready` prose or Run terminal status alone,
- workflow fan-in succeeds only after all immutable required participants and their
  outcome-specific evidence verify,
- daemon restart and client reconnect rebuild the same result without rerunning an
  effect-unknown side effect or creating a second completion authority.

RunnerRegistry hardening is successful when:

- workspace runtime settings own default runner choice,
- explicit runner selection fails closed unless explicitly allowed,
- fallback is visible in run/work-unit/thread evidence,
- the UI makes requested/effective runner identity obvious.
