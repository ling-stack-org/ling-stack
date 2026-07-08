# Orchestrator Advanced

## Purpose

This document defines the next orchestrator slices after the implemented serial
`autoplan-lite` engine.

Current production boundary:

- workflow steps are durable `ChannelWorkflowStep` rows;
- each step starts through the normal task/run coordinator;
- context/output packets, failure policy, pre-step gates, post-step gates, retry, cancel,
  and daemon restart recovery are implemented for serial execution;
- downstream steps start on explicit orchestrator ticks.

The remaining advanced scope is:

1. parallel workflow branches;
2. user or product-defined auto-startable workflow templates;
3. explicit side-effect classes and safe parallel policy;
4. future isolated worktree merge for parallel workspace writes.

These should not change the default serial behavior for unsafe work. The canonical
side-effect and UI rules live in
[Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md).

## Implementation Status

Implemented in the current future-hardening slice:

- workflow step metadata persists and round-trips `branchGroupId`, `joinGroupId`,
  `dependencyMode`, `maxParallelSiblings`, and `templateVersion`;
- the orchestrator tick uses smart scheduling to start multiple eligible read-only steps
  when step metadata opts in with `maxParallelSiblings > 1` and channel
  `maxConcurrentRuns` has budget;
- default smart scheduling still falls back to a single started step per tick when the
  budget is one, tools are unknown, approvals are pending, or any eligible step is
  side-effectful;
- `dependencyMode` supports `all_succeeded`, `all_terminal`, and `any_succeeded`;
- dependency output refs include `branchGroupId` for downstream context packets;
- orchestration responses can return `startedSteps` and `waitingApprovals` for UI/audit.
- `POST /channels/:channelId/workflows` accepts an inline `customTemplate` JSON object
  with `schemaVersion: 1`, validates unique step ids, dependency existence, DAG shape,
  teammate/template resolution, executable skill binding, runner policy, unsafe
  auto-start confirmation, and channel parallel limits before creating durable workflow
  steps.
- compiled custom template steps persist `workflowTemplateId`, `templateVersion`,
  `templateStepId`, dependency metadata, branch/join metadata, provider/runner
  metadata, step policy, gates, and explicit `autoStart` settings.

Still future:

- stored `customTemplateId` registry lookup and authoring UI for custom templates;
- graph visualization of branch groups and fan-in.
- side-effect class and grouped parallel policy metadata on every built-in and custom
  workflow step;
- isolated worktree merge protocol for safe parallel `workspace_write` branches.

## Non-Goals

- No OpenClaw/ACP delegation. Runner backend selection is owned by
  [Runner Adapters](runner-adapters.md).
- No hidden model-generated workflow mutations. Template compilation is deterministic.
- No automatic side-effectful step start after daemon restart without an explicit user or
  policy-controlled orchestrator tick.
- No global queue replacement. Advanced orchestration must continue to use the existing
  run coordinator, leases, semaphores, approvals, and runner audit.

## Slice OA.1: Parallel Branches

### Goal

Allow independent workflow steps to run concurrently when:

- their dependencies are terminal-success or explicitly skipped;
- their pre-step gates are approved or not required;
- the channel/runtime policy allows concurrency;
- resource leases and runtime semaphores are available.

Serial templates remain the default.

### Data Model

Additive metadata on `ChannelWorkflowStep.metadata`:

```ts
interface ChannelWorkflowStepMetadata {
  readonly dependsOnStepIds?: readonly string[];
  readonly branchGroupId?: string;
  readonly joinGroupId?: string;
  readonly dependencyMode?: "all_succeeded" | "all_terminal" | "any_succeeded";
  readonly maxParallelSiblings?: number;
}
```

Rules:

- `dependsOnStepIds` stays the authoritative dependency edge list.
- `branchGroupId` is UI and scheduling grouping metadata, not a dependency edge.
- `joinGroupId` marks fan-in steps that summarize branch outputs.
- `dependencyMode` defaults to `all_succeeded`.
- `skip_if_optional` dependencies count as satisfied only when the downstream step allows
  skipped dependencies through policy.

### Scheduler Algorithm

`POST /workflows/:workflowId/orchestrate` becomes a bounded reconciliation tick:

1. Load workflow and steps.
2. Recover approved post-step gates before selecting new work.
3. Compute eligible steps:
   - status is `queued` or approved `waiting_for_approval`;
   - dependencies satisfy `dependencyMode`;
   - no pending pre-step approval;
   - no active workflow-step lease for that step.
4. Sort eligible steps by `position`, then `branchGroupId`, then id.
5. Start up to `parallelStartBudget` steps.
6. For each candidate, call the existing `prepareWorkflowStepStart`.
7. Let the normal run coordinator decide write-lock/resource conflicts.
8. Return all started/blocked/skipped step results, not just one step.

Default budget:

```ts
parallelStartBudget = 1
```

Advanced templates opt into:

```ts
parallelStartBudget = smartDecision.parallelLimit
```

### Resource Safety

Parallel scheduling does not bypass the existing safeguards:

- `workflow_step` resource lease prevents duplicate step starts.
- run coordinator channel/write leases prevent unsafe concurrent writes.
- runtime semaphores still limit provider and runner concurrency.
- side-effect approvals remain per action and per step.
- post-step gates block fan-out/fan-in until resolved.

If a step is eligible but cannot start because the run coordinator queues or blocks it,
the workflow step should remain auditable:

- queued run conflict: keep workflow step `running` only when a run was created;
- hard conflict before run creation: mark step `blocked`;
- transient resource conflict: keep step `queued` and return `not_started`.

### Side-Effect Safety

Dependency independence is necessary but not sufficient for automatic parallel work.
Every parallel candidate must also declare a side-effect class and parallel policy.

Target metadata:

```ts
type WorkflowStepSideEffectClass =
  | "analysis_readonly"
  | "test_artifact_only"
  | "workspace_write"
  | "external_mutation"
  | "release";

interface WorkflowStepParallelPolicy {
  readonly autoParallel: boolean;
  readonly maxParallelSiblings?: number;
  readonly resourceKeys?: readonly string[];
  readonly requiresArtifactOnly?: boolean;
  readonly cancelSiblingsOnFailure?: boolean;
}
```

Default scheduler rule:

```text
autoParallel=true
+ sideEffectClass in analysis_readonly | test_artifact_only
+ no pending approval
+ no resource key conflict
+ runtime and provider budgets available
=> candidate may start in parallel
```

`workspace_write`, `external_mutation`, and `release` must remain serial by default even
when dependency graph and runtime budget would allow parallel starts. This is the
required bridge between the existing `maxParallelSiblings` implementation and the safer
product policy described in
[Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md#step-side-effect-model).

### Isolated Worktree Merge Boundary

Parallel workspace writes require a separate merge protocol:

```text
integration base
  -> isolated worktree per writing step
  -> branch-local patch and verification artifacts
  -> merge coordinator
  -> conflict report or clean integration branch
  -> approval before applying to the main workspace
```

Until that protocol exists, automatic parallel `workspace_write` is a policy violation,
not a scheduler optimization. The advanced scheduler may reserve metadata fields for
worktree ids, branch names, merge packets, and verification artifact refs, but it must
not start multiple writing siblings against the same workspace.

### Output Merge

Fan-in steps consume dependency output packets. The fan-in context packet includes:

- every dependency `workflowStepId`;
- run ids;
- terminal status;
- canonical `outputArtifactId`;
- additional artifact ids;
- result summaries;
- branch group ids.

The orchestrator must not merge free-form model text into a hidden summary. Any aggregate
summary is either:

1. a fan-in workflow step output packet, or
2. a deterministic activity rollup derived from durable step metadata.

### UI

Workspace workflow cards should show:

- branch group chips;
- parallel running count;
- blocked branch count;
- fan-in/join step indicator;
- "Advance" action result with multiple started steps.

The first UI can remain list-based. A graph view is optional polish.

### Tests

Backend tests:

- two independent read-only steps start in one orchestrator tick when budget permits;
- write steps sharing a bound path do not run concurrently;
- pre-step gate prevents one branch while another branch starts;
- post-step gate blocks fan-in until approved;
- failed optional branch with `skip_if_optional` lets fan-in start on a later tick;
- daemon restart does not duplicate running branch starts;
- cancel workflow aborts all active branch runs and pending branch approvals.

Web tests:

- workflow card shows multiple active branch steps;
- blocked branch and running branch can coexist without stale UI state;
- advance action displays all started steps.

## Slice OA.2: Custom Auto-Startable Templates

### Goal

Let Ling compile user or product-defined workflow templates into durable workflow steps
without changing orchestrator invariants.

### Template Schema

Use a versioned JSON shape first. Markdown authoring can compile into this shape later.

```ts
interface CustomWorkflowTemplate {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly maxParallelSteps?: number;
  readonly autoStartDefault?: boolean;
  readonly steps: readonly CustomWorkflowTemplateStep[];
}

interface CustomWorkflowTemplateStep {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly teammateTemplateId?: string;
  readonly teammateId?: string;
  readonly skillId?: string;
  readonly providerPresetId?: string;
  readonly requestedRunnerId?: string;
  readonly dependsOn?: readonly string[];
  readonly branchGroupId?: string;
  readonly policy?: WorkflowStepPolicy;
  readonly gates?: readonly WorkflowStepGate[];
  readonly autoStart?: boolean;
}
```

Validation:

- step ids are unique and stable;
- dependency ids exist and form a DAG;
- every step resolves to a teammate or teammate template;
- skill ids must be executable for the resolved teammate;
- requested runner ids must pass RunnerRegistry settings;
- side-effectful tools require approval policy or explicit gate;
- template `maxParallelSteps` cannot exceed workspace/channel limits.

### Storage

Prefer the existing skill registry as the initial owner:

- built-in templates come from skill packs;
- custom templates are skill-registry entries with `kind = "workflow_template"`;
- compiled workflow rows store `workflowTemplateId` and `templateVersion`.

Do not store arbitrary executable code in templates.

### Auto-Start Policy

Auto-start should be explicit and fail closed:

- built-in safe templates may set `autoStartDefault = true`;
- custom templates default to `false`;
- a template with write/deploy/credential/provider-change tools requires an explicit
  user confirmation before auto-start can be enabled;
- daemon restart never auto-starts new side-effectful steps unless the user clicks
  `Advance` or a durable policy allows it.

### Compile Flow

```text
POST /channels/:channelId/workflows
  templateId/customTemplateId
  objective
  providerPresetId?
  runnerId?
  autoStart?

-> validate template
-> create ChannelWorkflow(status=ready)
-> create ChannelWorkflowStep rows
-> attach deterministic metadata
-> return workflow + steps
```

### Tests

- valid custom template compiles to expected steps and dependencies;
- cycles are rejected;
- unknown teammate/skill/runner is rejected with structured errors;
- explicit runner fallback policy is honored;
- unsafe auto-start requires confirmation;
- custom template with parallel branches starts only within budget;
- template version is persisted on compiled steps;
- retry preserves original compiled metadata.

## Rollout

1. Add custom template parser and validator with no UI. Status: implemented for inline
   `customTemplate` JSON requests.
2. Add serial custom-template compile path. Status: implemented.
3. Add parallel scheduling behind smart scheduling. Status: implemented through channel
   `runtimePolicy.schedulingMode: "smart"`, `maxConcurrentRuns`, and compiled
   `maxParallelSiblings` metadata.
4. Add list UI for branch status.
5. Add authoring UI only after backend validation and tests are stable.

## Exit Criteria

- Existing serial `autoplan-lite` tests continue passing unchanged.
- Parallel templates cannot duplicate step starts under repeated orchestrator ticks.
- Write-conflicting branches are blocked, queued, or kept serial by side-effect policy.
- Every started step has context/output packet evidence.
- Every custom template compile is deterministic and auditable.
- Unsafe classes cannot auto-parallelize without the isolated worktree merge protocol and
  an explicit user or policy approval path.
