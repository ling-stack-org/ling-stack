# Orchestrator Advanced

Status: reference contract with active safe-concurrency follow-up
Owner: Ling maintainers
Last verified: 2026-11-10 (local implementation, targeted regression, real-provider smoke and production builds; release gates remain open)
Code anchors: daemon workflow compiler, smart scheduler and orchestrator listed below

## Purpose

This document defines advanced orchestrator slices built on the implemented serial
`autoplan-lite` engine.

Current source boundary:

- workflow steps are durable `ChannelWorkflowStep` rows;
- each step starts through the normal task/run coordinator;
- context/output packets, failure policy, pre-step gates, post-step gates, retry, cancel,
  and daemon restart recovery are implemented for serial execution;
- downstream steps start on explicit orchestrator ticks.

Basic smart branch scheduling and inline custom-template compilation already exist.
The product delivery stages are:

1. explicit side-effect classes, Host enforcement and safe parallel admission;
2. step-level isolated worktree execution and merge;
3. combined restart, cancellation, conflict and approval acceptance;
4. stored custom-template registry and authoring UI;
5. workflow graph visualization.

The complete implementation target also includes the cross-cutting Host budget track:

The single entry point for the complete target is
[Ling Multi-Agent Complete Target](ling-multi-agent-complete-target.md). This document remains
the English reference contract for orchestrator-specific details.

6. B1 trusted Host concurrency policy and strict configuration parsing;
7. B2 one durable workspace budget shared by ordinary Runs, workflow steps,
   delegations, approval resumes and continuations;
8. B3 installation-wide Host capacity with durable cross-workspace handoff;
9. B4 controlled isolated-write capacity at 2, 3 and 4 siblings;
10. B5 read-only policy visibility in the existing execution-engine settings surface.

Experience review is a separate observation path connected to the same settled Run. It may
produce a bounded candidate for memory, a channel method or a skill revision, but it never
changes workflow authority, grants a tool, publishes a skill or applies a candidate by itself.

These should not change the default serial behavior for unsafe work. The canonical
side-effect and UI rules live in
[Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md).
The active protocol and small-PR queue are maintained in the
[safe-concurrency detailed design](ling-multi-agent-safe-concurrency-detailed-design.md)
and [implementation plan](ling-multi-agent-safe-concurrency-implementation-plan.md).

## Implementation Status

Implemented locally in the current branch, not a release-acceptance claim:

- workflow step metadata persists and round-trips `branchGroupId`, `joinGroupId`,
  `dependencyMode`, `maxParallelSiblings`, and `templateVersion`;
- the orchestrator tick uses smart scheduling to start multiple eligible read-only steps
  when explicit safety/parallel policy and `maxParallelSiblings > 1` opt in, the
  actual Host capability is verified, and channel/resource/provider/runner budgets allow;
- smart scheduling stays serial when the budget is one, tools or Host safety are
  unverified, or an eligible effect lacks a verified isolated-round binding;
  approval/dependency/resource gates still control each candidate;
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
- P1 side-effect metadata, Host-enforced safety snapshots and atomic parallel admission
  are connected through the scheduler and normal Run/effect paths;
- P2 isolated execution, sealed branch results, deterministic integration, single-use
  approved target apply and owned-worktree cleanup are connected. Public selection stays
  off by default, macOS/Pi Host/enforced Tool Broker only, with default concurrency two and
  `candidate_only`; trusted Host configuration may freeze three or four siblings for a new
  round, while ordinary workflow write parallelism remains closed;
- P4 versioned registry lookup, frozen compilation and existing Skill Library authoring
  UI are locally committed. Saving or previewing a template does not start execution;
- P5 shared graph read model and same-turn graph/list UI are implemented locally.
  The graph is read-only and adds no execution authority.
- B1-B5 Host policy, workspace/Host capacity handoff, first-Pi queue integration,
  controlled 2/3/4 isolated-write selection and settings readback are implemented locally;
  the public isolated entry remains conservative and ordinary workspace writes remain serial.
- explicit text-conflict recovery has HTTP/API-client and Web dialog support. Discovery
  is read-only; planning and starting a generation-one successor are separate commands.
  Retired predecessor evidence remains available and cannot regain execution authority.

Local acceptance and remaining gates:

- P1-P5 all have local implementation and controlled browser/fixture acceptance coverage.
  Complete scoped Core/Daemon/Web/Contracts/API-client/shared UI/localization/runner-pi
  regressions, builds and Web lint pass. Unchanged-input shards are reused only after
  digest/preimage verification; existing platform/native/fixture skips remain explicit;
- recorded local regression covers real Git/SQLite and macOS real Pi SDK/Host with a
  credential-free scripted loopback Provider. One separate local real-provider smoke also
  completed provider check, a real Run, durable events and daemon restart readback; it does not
  represent every Provider or a packaged release. Production-build live
  browser E2E passed four local daemon/HTTP/SSE scenarios: cancel/offline reconnect/reload/
  Host drain/same-scenario restart, merge-approval UI/apply/TerminalReport/reload, explicit
  public candidate-only selection with unchanged target and desktop/narrow-width
  settled observation, and authored exact-pin creation followed by an explicit Pi start;
- after the original Host callback leaves the pending set,
  [isolation settlement](../../packages/daemon/src/features/channels/workflow-isolation-lifecycle.ts)
  triggers a durable, published `channel_workflow.isolation_settled` event in the `runs`
  domain. Notification is observation invalidation, not proof of a successful effect;
- the frozen-input Daemon suite passes under the repository's fixed shard plan, default
  deadlines and existing exclusions. Its separate `dependency-security.test.mjs` lane
  also passes; this is not a claim that the root security command's other packages ran;
- conflict recovery has separate incremental Web/shared UI/localization/Daemon regression
  and production-build browser evidence. Original sibling writes create a real Git text
  conflict; creating a plan starts no Run. Only a separate click starts the successor,
  with independent approvals, Runs/Attempts and worktrees. Same-database restart before
  start and after candidate completion preserves lineage, reports and Run counts; the
  target stays unchanged. Closing/reopening only observes, and desktop keyboard focus
  and narrow-width button wrapping are verified. The earlier complete frozen-input
  regression is not reused as a whole-suite claim for these later source changes;
- P5 graph projection filters and sorts before truncation, preserving the bounded node
  set and selection across refresh order changes. Keyboard names reuse the projected status;
  regression, real browser keyboard selection, narrow-list fallback and reduced-motion
  checks pass locally. Real-model Provider, packaged/cross-platform and review/CI/merge
  gates remain open. The
  local controlled-transport pass does not complete P3 release acceptance or open ordinary
  write parallelism.

The Web repair controller fences responses by workspace/channel/thread and daemon epoch,
retains the original idempotent request through ambiguous results, and requires read-only
discovery before explicit retry. A ready successor is not execution or target-apply authority.

Tool-list inference alone is not an artifact-only enforcement contract. No verified
artifact-only executor is available, so QA does not gain automatic parallel admission.

## Complete Target and Release Boundary

The full target is one Ling-owned execution path:

```text
user turn
  -> frozen workflow/template and safety plan
  -> trusted Host admission and durable capacity
  -> Run / WorkUnit / fenced Attempt
  -> optional isolated sibling worktrees
  -> branch evidence and deterministic fan-in
  -> approval-gated candidate or target apply
  -> TerminalReport and the same conversation turn
  -> optional Experience review candidate
```

The target is complete in code when every execution entry uses the same ownership, capacity,
approval, cancellation, recovery and evidence contracts; the Web keeps ordinary text flowing;
Graph is an inline, folded, read-only view only for actual collaboration or accepted parallel
dependencies; failures, approvals, retries and recovery actions remain on the conversation's
existing controls; and Experience review remains candidate-only until the user reviews it.

The target is release-complete only after the selected workflow/executor combinations have
real Provider, packaged desktop and platform acceptance, plus review, CI and merge gates.
Local fixtures, controlled Provider transport, TypeScript checks and production builds prove
the implementation boundary but do not replace those gates. Until then, Host keeps ordinary
workspace-write parallelism closed and exposes only the explicitly selected candidate-only
profile.

Current release evidence is tracked in the implementation plan: the local `v0.2.3` Desktop
candidate contract and development build pass, while the current source still requires a fresh
independent Office/codesign review closure and a genuine platform GStack selection before the
packaged gate can pass. Windows/Linux evidence, remote review, CI and merge remain separate
acceptance steps.

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

Implemented metadata (excerpt):

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
+ verified Host capability for the actual executor
+ no pending approval
+ no resource key conflict
+ runtime and provider budgets available
=> candidate may start in parallel
```

`workspace_write`, `external_mutation`, and `release` must remain serial by default even
when dependency graph and runtime budget would allow parallel starts. Isolated merge
already has a gated path for selected `workspace_write` steps; external mutation and
release stay serial regardless of local worktree isolation. Artifact-only admission still
requires a verified executor, not a template declaration. This is the
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

The protocol is implemented locally in the
[integration coordinator](../../packages/daemon/src/features/channels/workflow-integration-coordinator.ts)
and [merge apply path](../../packages/daemon/src/features/channels/workflow-merge-apply.ts).
It does not open general write parallelism or public target apply. Without a frozen,
Host-verified isolated-round binding, automatic parallel `workspace_write` remains a
policy violation; writing siblings must never share the target checkout.
The [detailed protocol](ling-multi-agent-safe-concurrency-detailed-design.md) defines the
Host execution binding, no-clobber ownership, immutable base, integration journal,
explicit first-version merge approval and Git/SQLite crash recovery requirements.

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

List projection is implemented. The local P5 graph/list view shares durable step ids,
selection, branch/join and approval facts through the
[shared read model](../../packages/conversation-ui-core/src/workflow-graph-model.ts).
Missing/cyclic/duplicate dependencies and disconnected observations remain unknown/stale;
narrow views fall back to the list. The graph only reuses existing protocol actions,
cannot edit accepted nodes/edges, and adds no execution authority or API. Local browser
keyboard/mobile checks pass; packaged and cross-platform accessibility acceptance remains
open. Graph rendering is not a scheduling prerequisite.

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

Implemented storage reuses skill-library source, visibility and review conventions:

- workflow templates use a [dedicated SQLite registry/version store](../../packages/core/src/storage/sqlite/workflow-template-registry-store.ts), not executable skill entries;
- saved versions are immutable, with CAS revisions, review state and exact id/version/digest pins;
- compilation freezes objective, prompts, policy/gates, dependencies, participants and
  skill/provider/runner references; start and effect gates recheck revocation;
- the [Skill Library authoring UI](../../apps/web/src/features/settings/WorkflowTemplatesSection.tsx)
  supports save/publish/preview and explicit workflow creation.

Preview creates no workflow, Task, Run or approval. Creation does not automatically
orchestrate; `autoStart` defaults to false. Do not store arbitrary executable code in templates.

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
  templateId | customTemplate | customTemplateId + customTemplateVersion + customTemplateDigest
  objective
  providerPresetId?
  runnerId?
  autoStart?

-> one Core writer transaction:
     validate template and freeze compilation
     create ChannelWorkflow(status=ready), steps, metadata and version pins
     resolve channel-root thread
     append canonical user turn/item
     bind sourceTurnId/sourceMessageId
     commit all records or roll back all records
-> return workflow + steps
```

Preview creates none of these execution records. Create records the explicit user
request but creates no Task, Run or approval and does not automatically orchestrate.

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

The items below describe local implementation, not release acceptance. Remaining work
follows the [five-stage implementation plan](ling-multi-agent-safe-concurrency-implementation-plan.md).

1. Add custom template parser and validator with no UI. Status: implemented for inline
   `customTemplate` JSON requests.
2. Add serial custom-template compile path. Status: implemented.
3. Add parallel scheduling behind smart scheduling. Status: implemented through channel
   `runtimePolicy.schedulingMode: "smart"`, `maxConcurrentRuns`, and compiled
   `maxParallelSiblings` metadata.
4. Add list UI for branch status. Status: implemented.
5. Add registry and authoring UI. Status: implemented locally; controlled browser save,
   publish, preview, CAS conflict and explicitly pinned creation pass.
6. Add graph/list visualization. Status: implemented locally; read-only, with local browser
   keyboard/mobile/reload checks passed. Packaged and cross-platform acceptance remain open.

## Exit Criteria

- Existing serial `autoplan-lite` tests continue passing unchanged.
- Parallel templates cannot duplicate step starts under repeated orchestrator ticks.
- Write-conflicting branches are blocked, queued, or kept serial by side-effect policy.
- Every started step has context/output packet evidence.
- Every custom template compile is deterministic and auditable.
- Workspace writers cannot auto-parallelize without the isolated worktree merge protocol
  and its explicit approval path. External mutation and release remain serial.
