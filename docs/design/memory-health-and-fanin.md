# Memory Health And Multi-Agent Memory Fan-In

Status: Design direction
Date: 2026-06-07
Scope: Ling-native memory health diagnostics, self-improving candidate metadata, and multi-agent workflow output fan-in.

Detailed implementation breakdown:
Memory Health And Multi-Agent Memory Fan-In.

## Summary

Ling should borrow the useful governance ideas from the Agent Context Memory Framework,
but it should not copy the framework's Markdown workspace layout into the runtime.

The framework is a context hygiene model for long-running agent workspaces:

```text
thin startup
+ hot persona
+ lazy topic memory
+ provenance
+ live verification for volatile facts
+ self-improving candidate lane
+ approval gates for risky self-evolution
```

Ling's product shape is different. Ling owns a Codex-like workspace and runtime:

```text
channels
+ teammates
+ tasks/runs
+ workflow steps
+ approval policy
+ durable memory objects
+ review state
+ used-memory audit
+ runtime supervisor
```

Therefore the adoption target is:

```text
framework principles
  -> Ling MemoryObject metadata
  -> Ling review policy and promotion inbox
  -> Ling workflow step outputs
  -> Ling health diagnostics
```

The adoption target is not:

```text
framework file tree
  -> BOOTSTRAP_INDEX.md
  -> MEMORY.md hot index as source of truth
  -> memory/topics/* as runtime store
```

Markdown can remain an import/export format and a reference source. Ling runtime memory
should remain database-backed, scoped, reviewable, and auditable.

## Source Designs

This design extends:

- [Ling Memory v1](ling-memory-v1.md)
- [Memory Review Policy Implementation Plan](memory-review-policy-implementation.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)
- [Execution And Orchestration Hardening](execution-orchestration-hardening.md)
- [Run Interruption And Continuation](run-interruption-continuation.md)
- [Codex-Like Execution Experience](codex-like-execution.md)
- [Channel And Agent Governance Notifications](channel-and-agent-governance-notifications.md)

The external framework should be treated as a reference design, not as a runtime
dependency.

## Current Baseline

Already implemented in Ling:

- Core `MemoryObject`, `MemoryReviewPolicy`, `MemoryReviewDecision`, and
  `UsedMemoryEvent` types.
- SQLite tables for memory objects, used-memory events, review decisions, review
  actions, review policy, and consolidation jobs.
- Scoped lexical recall for private chat, channel reply, task-run, review, and search
  intents.
- Task runs, direct replies, and channel replies can append a scoped used-memory prompt
  and record used-memory events.
- Promotion inbox and review actions can keep candidates, approve, reject, archive, or
  quarantine memory.
- Consolidation jobs can create candidates and intentionally do not silently activate
  memory.
- Workflow steps already produce context and output packet artifacts.

Current gaps:

- Memory candidates do not yet carry enough lifecycle metadata for self-improving
  records.
- There is no first-class memory health read model.
- Workflow step outputs are not automatically turned into reviewable memory candidates.
- Repeated lessons, stale lessons, superseded lessons, missing source refs, and duplicate
  candidates are not surfaced as memory hygiene issues.
- The promotion inbox is review-oriented, but not yet diagnostic-oriented.

## Product Rule

Memory improves Ling only when it remains inspectable.

```text
Consolidation can observe.
Consolidation can propose.
Consolidation can create candidates.
Review policy decides recall eligibility.
Approval policy decides side-effect authority.
```

Memory must never grant:

- tool access;
- approval bypass;
- provider access;
- deploy access;
- credentials;
- external-send authority;
- cross-scope private context access.

## Non-Goals

- No Markdown memory file tree as Ling's primary runtime store.
- No required `BOOTSTRAP_INDEX.md`, `TOOLS.md`, or `memory/topics/*` layout.
- No mandatory vector database.
- No mandatory embedding or rerank provider.
- No automatic mutation of teammate persona, workspace shared memory, approval policy,
  provider routing, tool routing, or permissions.
- No model-generated rewrite of workflow graphs.
- No injection of a new user prompt into an already-running Pi `session.prompt(...)`.
- No hidden cross-channel or cross-teammate memory sharing.
- No automatic deletion, redaction, merge, or semantic rewrite of memory evidence.

## Design Goals

- Give Ling a native memory health report that shows memory quality and risk.
- Turn repeated agent mistakes and useful post-task lessons into reviewable candidates.
- Let multi-agent workflow steps fan in their output as candidates without silently
  changing active memory.
- Preserve source refs from workflow step, run, artifact, message, and task records.
- Track whether a memory should be verified before use.
- Detect stale, duplicate, expired, superseded, and source-less candidates.
- Keep the UI review flow focused on high-impact decisions instead of every minor note.
- Keep vector retrieval optional and subordinate to provenance and review state.

## Concept Mapping

| Framework concept | Ling-native equivalent |
| --- | --- |
| Hot memory index | Active `MemoryObject` recall bundle plus teammate profile |
| Topic memory | Scoped workspace/channel/teammate memory objects with tags |
| Self-improving lane | Consolidation/reflection candidates with diagnostic metadata |
| Pending proposals | Promotion inbox items and review actions |
| Source refs | `MemorySourceRef[]` pointing to messages, tasks, runs, artifacts, files, or URLs |
| Verify-before-use | First-class `MemoryObject.verifyBeforeUse` plus prompt/rendering guard |
| Health scanner | Ling memory health read model and API |
| Approval gates | Memory review policy plus runtime approval policy |
| Retrieval layer | Optional `MemoryRetrievalProvider`, never authority |

## Self-Improving Candidate Metadata

Add `verifyBeforeUse` as a first-class `MemoryObject` field. It is a recall and prompt
safety attribute, not only self-improving metadata, because volatile operational facts can
exist in workspace, channel, teammate, task, and run memory.

Attach the remaining self-improving lifecycle fields through a companion table. A
companion table is preferred if the implementation can keep migrations small and typed.

```ts
type SelfImprovingMemoryKind =
  | "correction"
  | "reflection"
  | "workflow_lesson"
  | "tool_routing_lesson"
  | "runtime_recovery_lesson";

interface SelfImprovingMemoryMetadata {
  readonly memoryId: string;
  readonly kind: SelfImprovingMemoryKind;
  readonly trigger: string;
  readonly lesson: string;
  readonly useWhen: readonly string[];
  readonly doNotUseWhen: readonly string[];
  readonly validUntil?: string;
  readonly lastSeenAt?: string;
  readonly evidenceCount: number;
  readonly supersededBy?: string;
  readonly lastUsedAt?: string;
  readonly useCount: number;
}
```

The fields are intentionally operational:

- `trigger`: what produced the candidate.
- `lesson`: what should change next time.
- `useWhen`: positive recall boundaries.
- `doNotUseWhen`: false-positive boundaries.
- `validUntil`: expiry guard for facts likely to drift.
- `lastSeenAt` and `evidenceCount`: repeated-evidence tracking.
- `supersededBy`: narrow replacement handling.
- `lastUsedAt` and `useCount`: recall usefulness telemetry.

This metadata should not become an authority channel. It only improves candidate review,
recall quality, and diagnostics.

## Candidate Creation Sources

### Explicit User Corrections

When the user says a teammate got something wrong or gives a reusable correction:

```text
user correction
  -> teammate/private or workspace candidate
  -> source ref: direct message or channel message
  -> kind: correction
  -> reviewState: candidate
```

Workspace-level corrections should require manual review unless the user explicitly says
to remember that workspace rule.

### Post-Task Reflections

After a task/run reaches terminal state, Ling may propose a lesson only when there is
clear signal:

- repeated failure pattern;
- explicit run error and successful recovery;
- files/tests/commands that are likely reusable;
- user feedback after a run;
- QA or review step finds the same issue type repeatedly.

```text
run terminal event
  -> optional consolidation job
  -> task/run working memory candidate
  -> source refs: run, task, artifacts, runtime events
```

### Multi-Agent Workflow Step Output

Each workflow step already has a step output packet. The memory fan-in path should consume
that packet, not the raw transcript by default.

```text
workflow step succeeded
  -> output packet artifact
  -> fan-in classifier
  -> channel/task/run candidate
  -> promotion inbox if cross-scope or high-impact
```

Default destinations:

| Step type | Default candidate destination |
| --- | --- |
| Product/design/architecture decision | Channel memory candidate |
| Implementation lesson | Task/run working memory candidate |
| QA finding | Task/run or channel memory candidate |
| Release/ship decision | Channel memory candidate |
| Cross-workspace rule | Workspace candidate requiring manual review |
| Teammate behavior update | Teammate private candidate requiring manual review |

## Fan-In Pipeline

```text
terminal workflow step
  -> read output packet
  -> extract candidate summary
  -> attach source refs
  -> classify candidate
  -> create candidate memory
  -> record review decision
  -> show in workflow summary and promotion inbox
```

The first implementation should be deterministic and narrow. It can create one candidate
per terminal step only when the output packet has a non-empty result summary.

Do not summarize raw messages in the first fan-in slice. Raw transcript summarization can
come later through explicit consolidation jobs.

## Health Diagnostics

Add a read-only diagnostic surface:

```http
GET /memory/health?cwd=/path/to/workspace
GET /memory/health?cwd=/path/to/workspace&scopeType=channel&ownerId=channel_...
```

Draft response:

```ts
type MemoryHealthSeverity = "info" | "warning" | "critical";

type MemoryHealthFindingKind =
  | "missing_source_refs"
  | "expired_candidate"
  | "volatile_without_verify_before_use"
  | "duplicate_candidate"
  | "superseded_active_memory"
  | "secret_adjacent_recallable"
  | "authority_changing_claim"
  | "cross_scope_without_review"
  | "stale_candidate"
  | "high_review_backlog";

interface MemoryHealthFinding {
  readonly id: string;
  readonly kind: MemoryHealthFindingKind;
  readonly severity: MemoryHealthSeverity;
  readonly memoryId?: string;
  readonly relatedMemoryIds: readonly string[];
  readonly title: string;
  readonly detail: string;
  readonly recommendedAction:
    | "inspect"
    | "add_source_ref"
    | "keep_candidate"
    | "archive"
    | "reject"
    | "quarantine"
    | "merge_manually"
    | "review_policy";
}

interface MemoryHealthReport {
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly scopeType?: MemoryScopeType;
  readonly ownerId?: string;
  readonly summary: {
    readonly activeCount: number;
    readonly candidateCount: number;
    readonly reviewRequiredCount: number;
    readonly quarantinedCount: number;
    readonly findingsBySeverity: Record<MemoryHealthSeverity, number>;
  };
  readonly findings: readonly MemoryHealthFinding[];
}
```

### Diagnostic Rules

First implementation rules:

- `missing_source_refs`: candidate or active memory has no source refs and was not manual.
- `expired_candidate`: `validUntil` is earlier than report time.
- `volatile_without_verify_before_use`: memory tags or text mention ports, processes,
  branches, providers, deployment, or service state without `verifyBeforeUse`.
- `duplicate_candidate`: same normalized title/body/scope appears more than once.
- `superseded_active_memory`: memory marked as superseded remains active.
- `secret_adjacent_recallable`: secret-adjacent memory is enabled or active.
- `authority_changing_claim`: memory text appears to grant permissions or approval bypass.
- `cross_scope_without_review`: memory source scope and target scope differ without a
  manual-review decision.
- `stale_candidate`: candidate has not changed after a configurable age threshold.
- `high_review_backlog`: manual-review/quarantine backlog exceeds configured threshold.

These diagnostics should not modify memory. They only produce findings and recommended
actions.

## Review And Approval Boundary

Memory review is not runtime tool approval.

```text
runtime approval
  -> blocks side effects before they happen

memory review
  -> blocks candidates from becoming active, shared, or persona-affecting
```

Recommended gate mapping:

| Change | Gate |
| --- | --- |
| Create same-scope task/run candidate | Automatic, report briefly |
| Create self-improving candidate | Automatic, report in health/review surfaces |
| Activate same-scope low-risk task/run memory | Policy-controlled |
| Approve a generated candidate for active recall | User review gate |
| Promote task/run memory to channel memory | Manual review |
| Promote channel memory to workspace memory | Manual review |
| Change teammate persona/profile | Manual review |
| Change tools, approvals, providers, credentials, deploy, external-send | Not a memory action; runtime/settings approval only |
| Delete, redact, or rewrite evidence | Strong explicit approval |

## Governance Modes

Ling should expose three user-facing memory governance modes. These modes map onto the
existing memory review policy engine, but the product language should be clearer than the
internal `conservative`, `balanced`, and `fast` names.

| Product mode | Internal policy shape | Behavior |
| --- | --- | --- |
| Manual approval | `conservative` | Generated memory is stored as candidate and waits for user approval before active recall. |
| Assisted approval | `balanced` | Low-risk same-scope task/run memory may become active by policy; generated self-improving and fan-in memory stays candidate by default. |
| Automatic local learning | `fast` with hard guardrails | Same-scope, non-sensitive, non-authority-changing memory may auto-activate; cross-scope, workspace, persona, sensitive, and permission-like changes still require review. |

Default:

```text
workspace default: Assisted approval
fan-in experiment default: Manual approval
```

Configuration should be scoped:

- workspace default;
- channel override;
- teammate override;
- workflow-template override;
- fan-in feature flag per workflow template.

Hard guardrails apply in every mode:

- no automatic cross-scope promotion;
- no automatic persona/profile mutation;
- no automatic workspace shared memory from generated candidates;
- no automatic activation of secret-adjacent memory;
- no memory-derived tool, provider, credential, deploy, approval, or external-send authority;
- no candidate injection into normal task-run recall before it becomes active.

## Manual Approval Contract

Manual approval is the safest memory governance mode and should also be the review path
used by assisted and automatic modes whenever a candidate crosses a protected boundary.

Approval object:

```text
memory candidate
  + current scope
  + requested target scope
  + review decision
  + source refs
  + health findings
  + recommended action
```

Manual approval must show source refs before the user can approve a generated candidate.
If source refs are missing, the primary action should be `keep candidate`, `reject`, or
`quarantine`, not `approve`.

Actions:

| Action | Effect |
| --- | --- |
| Approve | Candidate becomes active in its current approved scope. |
| Edit and approve | User edits title/body/tags/scope/sensitivity, then candidate becomes active. |
| Keep candidate | Candidate remains stored but is not normal recall input. |
| Reject | Candidate is rejected and excluded from recall. |
| Quarantine | Candidate is disabled and requires explicit future inspection. |
| Archive | Candidate leaves the active review queue but remains available for audit. |

Strong manual approval is required for:

- cross-scope promotion;
- workspace shared memory created from generated candidates;
- teammate persona/profile changes;
- sensitive or secret-adjacent content;
- conflicting or low-confidence memory;
- missing source refs;
- authority-like claims about tools, permissions, providers, credentials, deploy, approval,
  or external-send.

Manual approval should be asynchronous by default. In this document, "do not interrupt"
means Ling should not create a runtime blocking approval prompt that stops an active
workflow while waiting for memory review. The normal approval path is a dedicated memory
review surface where the user can inspect candidates when convenient.

Batch actions are allowed only for low-risk same-scope candidates with source refs and no
critical health findings. Batch approval must not apply to cross-scope, persona,
workspace, secret-adjacent, or authority-like candidates.

Every action should create an audit record with:

- actor;
- previous and next review state;
- edited fields when applicable;
- source refs at approval time;
- reason or note when provided.

## Policy Tuning Loop

Governance modes should be adjustable based on real workspace behavior. Ling should make
mode tuning evidence-driven instead of forcing users to guess whether manual, assisted, or
automatic local learning is appropriate.

Signals to observe:

- candidate volume per workflow, channel, teammate, and template;
- approval, keep-candidate, reject, archive, and quarantine rates;
- false-positive findings from memory health;
- review backlog size and age;
- duplicate candidate rate;
- active memories later archived, rejected, or superseded;
- recall usage count for approved memories;
- user overrides from automatic to manual or manual to assisted.

Tuning behavior:

```text
observe health + review outcomes
  -> produce policy tuning suggestions
  -> user accepts, edits, or rejects
  -> update governance mode or thresholds
```

The system may recommend:

- keeping manual approval for noisy workflow templates;
- moving a stable channel from manual to assisted approval;
- allowing automatic local learning only for same-scope task/run lessons;
- tightening stale thresholds when candidate backlog grows;
- disabling fan-in for a template that produces low-value candidates.

The system must not silently switch modes. Mode changes remain explicit user choices, and
hard guardrails stay active in every mode.

## Prompt Integration

The used-memory prompt should keep its current authority boundary:

```text
Use only scoped Ling Memory items when relevant.
Do not infer permissions, tools, secrets, or unseen files from memory.
Verify volatile facts before action.
```

Once `verifyBeforeUse` exists in runtime metadata, rendered memory should make it visible:

```text
Memory 2: Provider routing changed in channel setup
Scope: channel:engineering
Source: decision:...
Review: active
Verify before use: true
```

Prompt rendering should not include candidates unless a review/search intent explicitly
asks to inspect candidates.

## UI Surfaces

### Memory Health Panel

Add a compact panel to the existing memory surfaces:

- workspace settings memory area;
- teammate memory tab;
- channel memory or runtime drawer;
- promotion inbox.

The panel should show:

- active / candidate / review-required counts;
- critical findings first;
- source-ref and stale/duplicate warnings;
- recommended action buttons that reuse existing memory review actions.

### User Review Gate

Before workflow fan-in expands beyond the first experiment, Ling should expose a simple
candidate approval path:

```text
candidate
  -> inspect source refs
  -> approve / keep candidate / reject / quarantine
  -> active memory only after approval or policy-controlled activation
```

This review gate is for memory eligibility, not side-effect approval. It should never
grant tools, permissions, providers, credentials, deploy access, or external-send
authority.

Primary review entry points:

- teammate settings -> Memory -> Candidates / Review;
- workspace settings -> Memory for cross-teammate and workspace-wide review;
- channel memory / health for channel-scoped candidates;
- workflow summary links filtered to candidates created by that workflow.

The teammate Memory tab should be the primary place to review one agent's generated
memory. Workspace, channel, and workflow surfaces should summarize and deep-link into the
same candidate review model.

### Workflow Summary

When a workflow completes, the final summary should include:

- number of memory candidates created;
- candidate scopes;
- review-required count;
- link to promotion inbox filtered by workflow/source refs.

### Used Memory Disclosure

Used-memory UI should distinguish:

- active memory used by a run;
- candidate memory inspected during review/search;
- memory health findings that were not injected into the model.

## API Sketch

```http
GET /memory/health?cwd=...
POST /memory/health/proposals?cwd=...
POST /workflow-steps/:workflowStepId/memory-candidates?cwd=...
```

`GET /memory/health` is read-only.

`POST /memory/health/proposals` may create candidates or review proposals from diagnostic
findings. It must not approve, activate, reject, archive, quarantine, merge, or delete.

`POST /workflow-steps/:workflowStepId/memory-candidates` can be used by orchestrator
reconciliation or a manual action to fan in a terminal step's output packet.

First implementation note:

```text
ship read-only health + teammate memory review first
defer proposals, workflow fan-in, automatic local learning, and vector retrieval
```

## Store/API Patch Slices

### MF.1 Metadata Types

Files:

```text
packages/core/src/memory-types.ts
packages/core/src/memory-consolidation-types.ts
packages/core/src/index.ts
```

Add self-improving metadata and health report types.

### MF.2 SQLite Storage

Files:

```text
packages/core/src/storage/sqlite-run-store.ts
packages/core/test/ai-teammate-workspace.test.mjs
```

Add `verify_before_use` to `memory_objects`, then add one optional companion table for
self-improving lifecycle fields:

```sql
ALTER TABLE memory_objects ADD COLUMN verify_before_use INTEGER NOT NULL DEFAULT 0;

CREATE TABLE memory_self_improving_metadata (
  memory_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  trigger TEXT NOT NULL,
  lesson TEXT NOT NULL,
  use_when_json TEXT NOT NULL,
  do_not_use_when_json TEXT NOT NULL,
  valid_until TEXT,
  last_seen_at TEXT,
  evidence_count INTEGER NOT NULL,
  superseded_by TEXT,
  last_used_at TEXT,
  use_count INTEGER NOT NULL
);
```

Do not move core `MemoryObject` into an untyped JSON blob.

### MF.3 Health Engine

Files:

```text
packages/core/src/memory-health.ts
packages/daemon/src/features/memory/health.ts
```

Build findings from memory objects, latest review decisions, review actions, and optional
self-improving metadata.

### MF.4 HTTP Routes And Client

Files:

```text
packages/daemon/src/features/memory/routes.ts
packages/daemon/src/server/router.ts
apps/web/src/api.ts
apps/web/src/types.ts
```

Add read-only health API first. Keep proposal creation separate from reporting.

### MF.5 Workflow Fan-In

Files:

```text
packages/daemon/src/features/channels/orchestrator.ts
packages/daemon/src/features/channels/workflow-step-packets.ts
packages/daemon/src/features/memory/consolidation.ts
```

After a workflow step reaches terminal success and an output packet exists, create at most
one candidate from the result summary.

The source refs should include:

- workflow id;
- workflow step id;
- run id;
- output packet artifact id;
- task id when available.

### MF.6 Web Surface

Files:

```text
apps/web/src/features/settings/*
apps/web/src/features/teammates/*
apps/web/src/features/runs/*
apps/web/src/shared/components/*
```

Add a compact memory health panel and review actions. Avoid making the UI a full
dashboard in the first slice.

### MF.7 Tests And Docs

Tests should cover:

- missing source refs;
- duplicate candidates;
- authority-changing claim quarantine;
- secret-adjacent recall exclusion;
- expired candidate finding;
- workflow step output fan-in creates a candidate only once;
- fan-in preserves source refs;
- candidates are not injected into normal task-run recall.

## Rollout Plan

1. Ship read-only memory health types and API.
2. Add compact Web health panel and a user review gate for approving, keeping, rejecting,
   or quarantining candidates.
3. Add self-improving metadata for newly created consolidation candidates.
4. Add workflow step output fan-in behind a workspace setting or feature flag, default
   off, and limited to `autoplan-lite` until the diagnostics prove useful.
5. Later, evaluate optional retrieval provider integration only when lexical recall
   misses enough useful memory to justify it.

## Open Questions

- Should health findings be persisted for audit, or generated on demand only?
- What is the default stale threshold for candidates: 14 days, 30 days, or workspace
  policy-controlled?
- Should a human be able to disable fan-in per channel, per workflow template, or per
  teammate?

## Decision

Adopt the framework's governance ideas as Ling-native memory health and fan-in features.
Do not adopt the framework's file layout as Ling runtime architecture.

The correct Ling implementation path is:

```text
self-improving lessons
  -> memory candidates
  -> health diagnostics
  -> promotion inbox
  -> scoped active recall only after policy allows it
```

This keeps Ling aligned with its Codex-like design: explicit runs, durable artifacts,
state machines, approval gates, and visible memory use.
