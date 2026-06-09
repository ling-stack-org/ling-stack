# Multi-Agent Orchestration P1 Workflow Graph Implementation Plan

Status: implemented P1 backend slice on 2026-06-09

Implemented scope:

- Added `WorkflowGraph` core/contracts types.
- Added workflow-level `ChannelWorkflowMetadata` and SQLite `metadata_json` persistence.
- Added daemon graph validation and deterministic graph-to-workflow compilation.
- Preserved existing `ChannelWorkflowStep` execution, approval, lease, and orchestrator
  behavior.

Deferred:

- Selector, structured handoff, wait nodes, graph rewrites, graph registry, and durable
  tick-count enforcement for `termination.maxTicks`.

Source design:

- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)
- [Orchestrator Advanced](orchestrator-advanced.md)

## Purpose

This plan turns the workflow graph direction into a small additive backend slice.

The goal is not to replace the existing durable workflow-step engine. The goal is to add a
versioned graph contract that compiles into the existing `ChannelWorkflow` and
`ChannelWorkflowStep` rows.

```text
WorkflowGraph
  -> deterministic compiler
  -> ChannelWorkflow
  -> ChannelWorkflowStep metadata
  -> existing orchestrator tick
```

## Guardrails

- Keep Pi as the default runner for each step.
- Keep `ChannelWorkflowStep` as the executable durable unit.
- Keep graph compilation deterministic.
- Do not let a model rewrite a running graph.
- Do not add selector, structured handoff, or parallel fan-in execution in this slice.
- Do not change the channel conversation UI in this slice.
- Do not bypass approval policy, resource leases, workflow-step gates, or run preflight.

## Existing Anchors

| Concern | Current code |
| --- | --- |
| Workflow and step types | `packages/core/src/workspace-types.ts` |
| Built-in workflow template types | `packages/core/src/skill-types.ts` |
| Built-in `autoplan-lite` | `packages/core/src/builtin-skill-packs.ts` |
| Template compilation | `packages/daemon/src/features/channels/workflow-templates.ts` |
| Orchestrator tick | `packages/daemon/src/features/channels/orchestrator.ts` |
| Workflow routes | `packages/daemon/src/features/channels/workflows.ts` |
| SQLite workflow storage | `packages/core/src/storage/sqlite-run-store.ts` |
| Current daemon workflow tests | `packages/daemon/test/channel-workspace.test.mjs` |

Current state already includes:

- `ChannelWorkflowStepMetadata.dependsOnStepIds`;
- `branchGroupId`, `joinGroupId`, `dependencyMode`, and `maxParallelSiblings`;
- custom inline workflow templates with `dependsOn` DAG validation;
- deterministic orchestrator ticks through existing run coordination.

P1 should formalize that graph shape without making the first implementation larger than
the current engine can safely support.

## Phase G0: Baseline Verification

Type: read-only.

Run before schema work:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/web typecheck
```

Confirm:

- existing `autoplan-lite` compilation still creates the expected steps;
- custom templates reject duplicate ids, missing dependencies, and dependency cycles;
- serial orchestrator behavior remains stable.

## Phase G1: Core Graph Types

Type: additive types.

Add:

```text
packages/core/src/workflow-graph-types.ts
```

Export from:

```text
packages/core/src/index.ts
```

Define:

```ts
export type WorkflowGraphNodeKind = "step" | "join";

export type WorkflowEdgeConditionKind =
  | "always"
  | "all_succeeded"
  | "all_terminal"
  | "any_succeeded";

export interface WorkflowGraph {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly summary?: string;
  readonly entryNodeId: string;
  readonly nodes: readonly WorkflowGraphNode[];
  readonly edges: readonly WorkflowGraphEdge[];
  readonly termination: WorkflowTerminationPolicy;
  readonly maxParallelSteps?: number;
}

export interface WorkflowGraphNode {
  readonly id: string;
  readonly kind: WorkflowGraphNodeKind;
  readonly name: string;
  readonly prompt: string;
  readonly teammateTemplateId?: string;
  readonly teammateId?: string;
  readonly skillId?: string;
  readonly providerPresetId?: string;
  readonly requestedRunnerId?: string;
  readonly branchGroupId?: string;
  readonly joinGroupId?: string;
  readonly policy?: WorkflowStepPolicy;
  readonly gates?: readonly WorkflowStepGate[];
  readonly autoStart?: boolean;
}

export interface WorkflowGraphEdge {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly condition: WorkflowEdgeCondition;
}

export interface WorkflowEdgeCondition {
  readonly kind: WorkflowEdgeConditionKind;
}

export interface WorkflowTerminationPolicy {
  readonly success: "all_terminal" | "all_required_succeeded";
  readonly onFailedRequiredNode: "block_for_user" | "fail_workflow";
  readonly onApprovalDenied: "block_for_user" | "fail_workflow";
  readonly maxTicks?: number;
}
```

Keep future node kinds out of the accepted type until implemented:

- `selector`,
- `handoff`,
- `wait`.

Those should be introduced by P4/P5 later.

## Phase G2: Workflow Metadata

Type: additive persistence.

Current `ChannelWorkflowStep` already has `metadata_json`. P1 needs workflow-level graph
source metadata so graph provenance is visible without reading every step.

Add to `packages/core/src/workspace-types.ts`:

```ts
export interface ChannelWorkflowMetadata {
  readonly workflowGraphId?: string;
  readonly workflowGraphSchemaVersion?: number;
  readonly workflowGraphArtifactId?: string;
  readonly termination?: WorkflowTerminationPolicy;
  readonly maxParallelSteps?: number;
}
```

Extend:

```ts
interface ChannelWorkflow {
  readonly metadata?: ChannelWorkflowMetadata;
}

interface CreateChannelWorkflowInput {
  readonly metadata?: ChannelWorkflowMetadata;
}

interface UpdateChannelWorkflowInput {
  readonly metadata?: ChannelWorkflowMetadata | null;
}
```

SQLite:

- add `channel_workflows.metadata_json TEXT`;
- add typed parse/serialize helpers;
- reject unknown top-level metadata values in parser by omitting them, not throwing during
  read;
- validate writes before persistence.

Do not add a new graph table in P1. If registry lookup and graph authoring later require
searchable graph records, add that in a separate slice.

## Phase G3: Graph Validation

Type: backend pure functions.

Add:

```text
packages/daemon/src/features/channels/workflow-graph.ts
```

Functions:

```ts
export function validateWorkflowGraph(graph: WorkflowGraph): void;
export function compileWorkflowGraph(input: CompileWorkflowGraphInput): CompiledWorkflowGraph;
```

Validation rules:

- `schemaVersion` must be `1`;
- `entryNodeId` must reference an existing node;
- node ids and edge ids must be unique;
- every edge endpoint must exist;
- graph must be a DAG in P1;
- every non-entry node must have at least one inbound edge;
- every node must be reachable from `entryNodeId`;
- `step` and `join` nodes must resolve a teammate or teammate template;
- every `skillId` must be executable for the resolved teammate;
- `maxParallelSteps` must not exceed channel runtime policy;
- unsupported future node kinds fail with `workflow_graph_node_kind_unsupported`.

P1 graph edges should compile to existing step metadata:

```text
edge condition always/all_succeeded -> dependencyMode: all_succeeded
edge condition all_terminal         -> dependencyMode: all_terminal
edge condition any_succeeded        -> dependencyMode: any_succeeded
```

If inbound edges on a node declare mixed conditions, fail closed in P1.

## Phase G4: Compiler Integration

Type: daemon route behavior.

Update:

```text
packages/daemon/src/features/channels/workflow-templates.ts
packages/daemon/src/features/channels/workflows.ts
```

Add a compile request shape:

```ts
interface WorkflowGraphCompileRequest {
  readonly workflowGraph: WorkflowGraph;
  readonly title?: string;
  readonly objective: string;
  readonly createdBy?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly autoStart?: boolean;
  readonly confirmUnsafeAutoStart?: boolean;
}
```

Route behavior:

- `POST /channels/:channelId/workflows` accepts exactly one of `templateId`,
  `customTemplateId`, `customTemplate`, or `workflowGraph`;
- graph compilation creates one `ChannelWorkflow`;
- graph compilation creates one `ChannelWorkflowStep` per graph node;
- graph node ids persist as `metadata.templateStepId` for compatibility until a dedicated
  `graphNodeId` field exists;
- graph id/version persist on workflow metadata;
- graph dependency edges persist as `metadata.dependsOnStepIds`.

Do not start the workflow automatically in the compile route beyond existing
`autoStart` semantics. Starting remains an orchestrator tick.

## Phase G5: Termination Policy Wiring

Type: orchestrator behavior.

Update:

```text
packages/daemon/src/features/channels/orchestrator.ts
```

P1 behavior:

- default current behavior when workflow metadata has no termination policy;
- if termination policy exists, use it when deciding whether to `block` or `fail` the
  workflow after a required step fails;
- enforce `maxTicks` only if an existing tick counter is available.

Do not add a tick counter table in P1 unless implementation discovers an existing durable
counter. If no counter exists, leave `maxTicks` as validated metadata and implement
enforcement in a later recovery slice.

## Phase G6: Tests

Add or extend daemon tests in:

```text
packages/daemon/test/channel-workspace.test.mjs
```

Minimum cases:

- valid graph compiles into workflow and steps;
- duplicate node ids fail;
- missing edge endpoint fails;
- cycle fails;
- unsupported `selector` node kind fails in P1;
- graph step with missing teammate fails;
- graph step with skill not bound to teammate fails;
- graph `maxParallelSteps` above channel limit fails;
- compiled dependency edges produce expected `dependsOnStepIds`;
- existing `autoplan-lite` behavior remains unchanged.

Core tests:

```text
packages/core/test/skill-packs.test.mjs
packages/core/test/ai-teammate-workspace.test.mjs
```

Add parser/round-trip coverage for `ChannelWorkflowMetadata`.

## Non-Goals

- No selector coordinator.
- No structured handoff intent.
- No model-authored running graph rewrites.
- No graph visualization.
- No new conversation UI.
- No replacement of `CustomWorkflowTemplate`.
- No runtime import of Microsoft Agent Framework or AutoGen.

## Validation

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/daemon typecheck
corepack pnpm --filter @ling-stack/web typecheck
git diff --check
```
