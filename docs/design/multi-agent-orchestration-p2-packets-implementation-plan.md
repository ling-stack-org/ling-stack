# Multi-Agent Orchestration P2 Packet Standardization Implementation Plan

Status: implemented P2 packet-contract slice on 2026-06-09

Implemented scope:

- Extended context/output packet contracts with graph, teammate, skill, source refs,
  selector/handoff ids, blockers, and changed paths.
- Added packet readers that fail closed on missing files, bad JSON, or wrong schema.
- Made packet artifact writes idempotent when the referenced packet artifact still exists.
- Kept packet JSON out of workflow list endpoints; raw packet content remains artifact
  evidence loaded explicitly.

Deferred:

- Dedicated workflow-step evidence route, automatic page-load repair, memory fan-in usage,
  selector decisions, and structured handoff intents.

Source design:

- [Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md)
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [Execution And Orchestration Hardening Implementation Plan](execution-orchestration-hardening-implementation-plan.md)
- [Memory Health And Multi-Agent Memory Fan-In](memory-health-and-fanin.md)

## Purpose

This plan standardizes workflow step context/output packets for the next multi-agent
orchestration slices.

Context and output packets already exist as run-linked JSON artifacts. P2 should turn them
from useful hardening artifacts into a stable contract that graph, handoff, selector,
fan-in, memory candidates, and UI evidence can all reference.

```text
workflow step
  -> context packet before useful execution
  -> run / artifacts / approvals
  -> output packet after terminal reconciliation
  -> downstream context, fan-in, evidence, memory candidates
```

## Guardrails

- Packets are evidence and context, not permissions.
- Packets must not grant tools, approval, credentials, provider access, deploy access, or
  external-send authority.
- Packets must not silently mutate memory, teammate persona, workflow graph, or channel
  policy.
- Packet creation failure must not overwrite terminal workflow state.
- Do not inline large packet JSON into list endpoints.
- Do not summarize raw transcript text into hidden downstream context in this slice.
- Do not add a `workflow_step_packets` table in this phase. Packet bodies remain JSON
  artifacts; workflow and step metadata carry packet refs and summaries.
- Keep domain packet types in core and exported DTO packet types in contracts so daemon,
  Web, Desktop, and CLI do not invent parallel packet schemas.

## Existing Anchors

| Concern | Current code |
| --- | --- |
| Packet domain types | `packages/core/src/workspace-types.ts` today; move grouped packet refs and packet bodies to `packages/core/src/workflow-packet-types.ts` |
| Packet API DTOs | `packages/contracts/src/workflows.ts` today; move exported packet DTOs to `packages/contracts/src/workflow-packets.ts` |
| Packet artifacts | `packages/daemon/src/features/channels/workflow-step-packets.ts` |
| Orchestrator output write | `packages/daemon/src/features/channels/orchestrator.ts` |
| Workflow-step metadata ids | `packages/core/src/workspace-types.ts` |
| Artifact storage | `packages/daemon/src/features/runs/artifacts.ts` |
| Run artifacts route | `packages/daemon/src/features/runs/routes.ts` |
| Memory fan-in plan | `docs/design/memory-health-and-fanin-implementation-plan.md` |
| Web evidence work cell | `apps/web/src/lib/conversation-work-cell.ts` |
| Web artifact display | `apps/web/src/shared/components/ArtifactRow.tsx` |

Current packet fields:

- `ChannelWorkflowStepContextPacket` stores objective, step prompt, dependency refs,
  prior output artifact ids, runner/provider data, approval gate, and generated time.
- `ChannelWorkflowStepOutputPacket` stores workflow/step/run ids, step status, summary,
  artifacts, runner audit, and generated time.
- `ChannelWorkflowStepMetadata` stores `contextArtifactId`, `outputArtifactId`, and
  `outputArtifactIds`.

Target ownership:

```text
core/contracts types
  -> artifact JSON packet body
  -> ChannelWorkflowStep.metadata packet refs
  -> right drawer / evidence projection
```

Metadata may keep legacy fields such as `contextArtifactId` and `outputArtifactId`, but
new code should prefer a grouped packet-ref helper so packet provenance is not scattered
across unrelated metadata fields.

Migration rule:

- dedicated packet files are the target location for new packet types;
- existing `workspace-types.ts` and `workflows.ts` may re-export during migration;
- avoid adding new packet contracts to the already-large workflow type files unless the
  type is a narrow compatibility alias.

## Phase PK0: Baseline Verification

Type: read-only.

Confirm current behavior:

- context packets are created for started workflow steps;
- output packets are created after terminal run reconciliation;
- packet artifact ids round-trip through step metadata;
- downstream step prompts reference prior packet ids;
- memory fan-in only creates candidates, not active memory.

Commands:

```bash
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/core test
```

## Phase PK1: Contract Versioning

Type: additive type changes.

Update:

```text
packages/core/src/workspace-types.ts
```

Keep `schemaVersion: 1`, but expand optional fields so future slices can attach graph,
selector, and handoff evidence without changing artifact shape again.

Add to `ChannelWorkflowStepContextPacket`:

```ts
readonly graphId?: string;
readonly graphNodeId?: string;
readonly teammateId?: string;
readonly skillId?: string;
readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
readonly selectorDecisionIds?: readonly string[];
readonly handoffIntentIds?: readonly string[];
```

Add to `ChannelWorkflowStepOutputPacket`:

```ts
readonly graphId?: string;
readonly graphNodeId?: string;
readonly teammateId?: string;
readonly skillId?: string;
readonly decisions?: readonly string[];
readonly blockers?: readonly string[];
readonly changedPaths?: readonly string[];
readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
readonly selectorDecisionIds?: readonly string[];
readonly handoffIntentIds?: readonly string[];
```

Add:

```ts
export type WorkflowPacketSourceRefType =
  | "channel_message"
  | "channel_brief"
  | "channel_decision"
  | "context_summary"
  | "task"
  | "run"
  | "workflow"
  | "workflow_step"
  | "artifact"
  | "approval";

export interface WorkflowPacketSourceRef {
  readonly type: WorkflowPacketSourceRefType;
  readonly id: string;
  readonly label?: string;
}
```

Do not add `rawTranscript` or `rawMessages` fields in P2.

## Phase PK2: Packet Builder Standardization

Type: daemon helper changes.

Update:

```text
packages/daemon/src/features/channels/workflow-step-packets.ts
```

Add helpers:

```ts
export function buildWorkflowPacketSourceRefs(input: ...): readonly WorkflowPacketSourceRef[];
export function readWorkflowStepContextPacketArtifact(input: ...): ChannelWorkflowStepContextPacket | undefined;
export function readWorkflowStepOutputPacketArtifact(input: ...): ChannelWorkflowStepOutputPacket | undefined;
export function extractWorkflowStepChangedPaths(input: ...): readonly string[];
```

Builder behavior:

- context packet includes `graphId` and `graphNodeId` when workflow/step metadata has them;
- context packet includes teammate, skill, source refs, and dependency output refs;
- output packet includes decisions/blockers only from durable step/run fields, not raw
  model text parsing;
- changed paths are derived from existing artifacts when deterministic;
- packet readers validate `schemaVersion === 1`;
- parse failures return `undefined` and can append diagnostic evidence later, but they do
  not throw during list/read UI paths.

## Phase PK3: Idempotency And Repair

Type: backend behavior.

Current packet writes are artifact writes. P2 should make regeneration safe.

Rules:

- If `metadata.contextArtifactId` exists and the artifact file exists, do not rewrite it.
- If metadata exists but the artifact file is missing, regenerate with the same kind and
  update metadata with the new artifact id.
- If `metadata.outputArtifactId` exists and the artifact file exists, do not rewrite it
  unless an explicit repair path is called.
- If output packet creation failed after terminal state, retrying orchestrator recovery may
  regenerate packet evidence without changing terminal state.

Potential helper:

```ts
export function ensureWorkflowStepPacketArtifacts(input: {
  readonly store: RunStore;
  readonly workflowStepId: string;
  readonly now: string;
}): {
  readonly contextArtifactId?: string;
  readonly outputArtifactId?: string;
  readonly repaired: boolean;
};
```

Do not add automatic filesystem repair on every channel page load. Keep repair in
orchestrator/recovery or explicit diagnostic flows.

## Phase PK4: API And Evidence Surfacing

Type: additive read surfaces.

Do not inline packet JSON into:

```text
GET /channels/:id/workflows
GET /workflows/:id/steps
```

Those routes should continue returning metadata artifact ids.

Add or reuse detail routes so the right drawer can load packet content on demand:

- existing artifact preview/content route if adequate;
- otherwise a workflow-step evidence route that returns packet summaries and artifact links.

Preferred first shape:

```http
GET /workflow-steps/:id/evidence?cwd=/path
```

Response:

```ts
interface WorkflowStepEvidenceResponse {
  readonly workflowStep: ChannelWorkflowStep;
  readonly contextPacket?: ChannelWorkflowStepContextPacket;
  readonly outputPacket?: ChannelWorkflowStepOutputPacket;
  readonly packetArtifacts: readonly RunArtifact[];
  readonly linkedRun?: RunSession;
  readonly linkedArtifacts: readonly RunArtifact[];
  readonly approvals: readonly ApprovalRequest[];
}
```

If the existing thread evidence route already covers enough fields for the UI slice, defer
this route until P3/P7 needs it.

## Phase PK5: Web Evidence Model

Type: presentation model only.

Update or add:

```text
apps/web/src/lib/workflow-step-evidence.ts
apps/web/src/lib/conversation-work-cell.ts
apps/web/src/shared/conversation/ConversationEvidenceBundlePanel.tsx
```

Presentation rules:

- packet summary rows are evidence, not main feed copy;
- context packet shows objective, step, dependency count, source refs, and runner/provider;
- output packet shows result summary, status, artifact count, blockers, changed paths;
- raw JSON opens only through artifact preview/download, not default row content;
- missing packet shows a diagnostic row rather than an empty broken component.

## Phase PK6: Tests

Core tests:

- packet types accept graph/source/handoff optional fields;
- metadata parser round-trips packet artifact ids and future graph fields.

Daemon tests:

- context packet includes source refs and graph node metadata when available;
- output packet includes blockers on failed/blocked terminal steps;
- changed paths are deterministic for file/diff artifacts;
- packet readers reject wrong schema versions without crashing;
- repair regenerates missing packet artifacts without changing workflow step status;
- list routes do not inline packet JSON.

Web tests:

- packet evidence rows render in expanded details;
- missing packet artifact renders a diagnostic state;
- raw JSON is not visible until explicit artifact open/download.

## Non-Goals

- No memory auto-activation.
- No selector implementation.
- No handoff intent implementation.
- No raw transcript summarization.
- No packet-based permission grant.
- No large packet JSON in list endpoints.

## Validation

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/web typecheck
git diff --check
```
