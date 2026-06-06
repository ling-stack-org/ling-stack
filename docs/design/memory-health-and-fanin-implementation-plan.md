# Memory Health And Multi-Agent Memory Fan-In Implementation Plan

Status: Implementation breakdown
Date: 2026-06-07
Source design: [Memory Health And Multi-Agent Memory Fan-In](memory-health-and-fanin.md)

## Purpose

This plan breaks the memory health and workflow fan-in design into small, reviewable
implementation slices.

The goal is to add diagnostics and candidate creation without weakening Ling's multi-agent
boundaries:

```text
workflow step output
  -> candidate memory
  -> health / review surface
  -> policy or manual activation
  -> scoped active recall
```

The implementation must not become:

```text
workflow step output
  -> automatically injected into the next agent
```

That would create a hidden prompt loop and would conflict with Ling's Codex-like runtime
model.

## Guardrails

- Candidates are not normal task-run recall input.
- Fan-in must create candidates, not active memory.
- Cross-scope promotion requires review.
- Persona/profile changes require review.
- Workspace shared memory requires review unless explicitly confirmed by the user.
- Memory cannot grant tools, approvals, provider access, deploy access, credentials, or
  external-send authority.
- Memory health is read-only unless the route name explicitly says it creates proposals.
- No Markdown memory file tree becomes the source of truth.
- No vector provider is required.
- No raw transcript summarization in the first fan-in slice.

## Recommended First Slice

The first implementation should stop at read-only diagnostics and user review. It should
not enable workflow fan-in or automatic local learning.

Include:

- MF.0 baseline verification;
- MF.1 core health and `verifyBeforeUse` types;
- MF.2 additive SQLite metadata;
- MF.3 read-only health engine;
- MF.4 `GET /memory/health`;
- MF.7 minimal Web health surface;
- MF.4.5 teammate Memory candidate review if existing review surfaces are not enough.

Exclude:

- workflow fan-in;
- `POST /memory/health/proposals`;
- `automatic_local_learning`;
- vector retrieval;
- candidate auto-activation beyond existing policy behavior;
- candidate injection into normal task-run recall.

Default assumptions for the first slice:

- health findings are generated on demand, not persisted;
- stale candidate threshold is 30 days;
- teammate settings -> Memory -> Candidates / Review is the primary approval surface;
- workspace/channel/workflow surfaces only summarize and deep-link into candidate review.

This slice is intentionally useful but behavior-preserving: it should expose memory quality
and review actions without changing how multi-agent runs assemble prompts.

## Existing Surfaces To Reuse

Core:

```text
packages/core/src/memory-types.ts
packages/core/src/memory-review-policy.ts
packages/core/src/memory-consolidation-types.ts
packages/core/src/storage/sqlite-run-store.ts
packages/core/test/ai-teammate-workspace.test.mjs
```

Daemon:

```text
packages/daemon/src/features/memory/routes.ts
packages/daemon/src/features/memory/consolidation.ts
packages/daemon/src/features/memory/prompt.ts
packages/daemon/src/features/channels/orchestrator.ts
packages/daemon/src/features/channels/workflow-step-packets.ts
packages/daemon/src/server/router.ts
```

Web:

```text
apps/web/src/api.ts
apps/web/src/types.ts
apps/web/src/shared/components/UsedMemorySummary.tsx
apps/web/src/features/teammates/*
apps/web/src/features/settings/*
apps/web/src/features/runs/*
```

## Phase MF.0: Baseline Verification

Type: read-only preparation.

Tasks:

- Confirm current memory migrations are stable.
- Confirm `POST /memory/consolidation-jobs` always stores candidates first.
- Confirm normal run recall only uses enabled active memory.
- Confirm workflow step output artifacts are created on terminal success.

Commands:

```bash
pnpm --filter @ling-stack/core test
pnpm --filter @ling-stack/daemon typecheck
pnpm --filter @ling-stack/web typecheck
```

Exit criteria:

- Existing tests pass.
- No schema migration is started before the baseline is known.

## Phase MF.1: Core Types

Type: additive types only.

Files:

```text
packages/core/src/memory-types.ts
packages/core/src/index.ts
packages/core/src/memory-health.ts
```

Add:

```ts
export type SelfImprovingMemoryKind =
  | "correction"
  | "reflection"
  | "workflow_lesson"
  | "tool_routing_lesson"
  | "runtime_recovery_lesson";

export interface SelfImprovingMemoryMetadata {
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

export type MemoryHealthSeverity = "info" | "warning" | "critical";

export type MemoryHealthFindingKind =
  | "missing_source_refs"
  | "expired_candidate"
  | "volatile_without_verify_before_use"
  | "duplicate_candidate"
  | "superseded_active_memory"
  | "secret_adjacent_recallable"
  | "authority_changing_claim"
  | "stale_candidate"
  | "high_review_backlog";
```

Also add `verifyBeforeUse` to `MemoryObject`, `CreateMemoryObjectInput`, and
`MemoryObjectUpdateInput`.

Do not:

- Add untyped `metadata_json` to `MemoryObject`.
- Change recall behavior.
- Add vector retrieval.

Tests:

- Type export smoke coverage in existing core tests if needed.

Exit criteria:

- TypeScript compiles with no behavior changes.

## Phase MF.2: SQLite Metadata Storage

Type: additive migration and store APIs.

Files:

```text
packages/core/src/storage/sqlite-run-store.ts
packages/core/test/memory-review-store.test.mjs
```

Add table:

```sql
ALTER TABLE memory_objects ADD COLUMN verify_before_use INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS memory_self_improving_metadata (
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

Add store methods:

```ts
getMemorySelfImprovingMetadata(memoryId: string): SelfImprovingMemoryMetadata | undefined;
upsertMemorySelfImprovingMetadata(input: UpsertMemorySelfImprovingMetadataInput): SelfImprovingMemoryMetadata;
listMemorySelfImprovingMetadata(options?: {
  readonly workspaceId?: string;
  readonly memoryId?: string;
  readonly kind?: SelfImprovingMemoryKind;
  readonly limit?: number;
}): SelfImprovingMemoryMetadata[];
```

Validation rules:

- `memoryId` must reference an existing memory object.
- `useWhen` and `doNotUseWhen` must be arrays of non-empty strings.
- `evidenceCount` and `useCount` must be non-negative integers.
- `supersededBy` must not equal `memoryId`.
- `verifyBeforeUse` must be persisted on the owning memory object.

Do not:

- Backfill existing memories automatically.
- Auto-activate any candidate.

Tests:

- Insert/read/update metadata.
- Reject negative counts.
- Reject missing memory id.
- Preserve memory object review state.

Exit criteria:

- Additive migration is idempotent.
- Existing memory tests still pass.

## Phase MF.3: Health Engine

Type: read-only core logic.

Files:

```text
packages/core/src/memory-health.ts
packages/core/src/index.ts
packages/core/test/memory-review-store.test.mjs
```

Add:

```ts
interface BuildMemoryHealthReportInput {
  readonly memories: readonly MemoryObject[];
  readonly latestDecisionsByMemoryId?: ReadonlyMap<string, MemoryReviewDecision | undefined>;
  readonly metadataByMemoryId?: ReadonlyMap<string, SelfImprovingMemoryMetadata | undefined>;
  readonly generatedAt: string;
  readonly staleCandidateDays?: number;
  readonly backlogWarningThreshold?: number;
  readonly limit?: number;
}
```

First findings:

- `missing_source_refs`
- `expired_candidate`
- `volatile_without_verify_before_use`
- `duplicate_candidate`
- `superseded_active_memory`
- `secret_adjacent_recallable`
- `authority_changing_claim`
- `stale_candidate`
- `high_review_backlog`

Implementation detail:

- Use deterministic IDs for findings from kind + memory id + related ids.
- Keep string matching conservative for volatile and authority-changing claims.
- Sort findings by severity, kind, memory id.
- Do not add `cross_scope_without_review` until source scope and target scope evidence is
  persisted in a reliable typed shape.

Do not:

- Mutate memory.
- Create proposals.
- Call models.

Tests:

- One test per finding kind.
- Report summary counts.
- Deterministic ordering.

Exit criteria:

- Health report can be generated entirely from store read models.

## Phase MF.4: Health API

Type: read-only daemon/API client.

Files:

```text
packages/daemon/src/features/memory/routes.ts
packages/daemon/src/server/router.ts
apps/web/src/api.ts
apps/web/src/types.ts
```

Route:

```http
GET /memory/health?cwd=/path/to/workspace
GET /memory/health?cwd=/path/to/workspace&scopeType=channel&ownerId=channel_...
```

Behavior:

- Resolve store from `cwd`.
- Load memory objects in scope.
- Load latest review decisions for those memories.
- Load self-improving metadata for those memories.
- Return health report.

Do not:

- Add proposal creation in this phase.
- Add Web mutation actions.

Tests:

- Missing cwd behavior follows existing memory route conventions.
- Scope filters work.
- Disabled/quarantined records appear in findings when relevant.

Exit criteria:

- The health endpoint is read-only and stable.

## Phase MF.5: Consolidation Metadata

Type: candidate creation metadata.

Files:

```text
packages/daemon/src/features/memory/consolidation.ts
packages/daemon/src/features/memory/schemas.ts
packages/core/test/ai-teammate-workspace.test.mjs
```

Extend consolidation job request parsing with optional fields:

```ts
readonly selfImproving?: {
  readonly kind: SelfImprovingMemoryKind;
  readonly trigger: string;
  readonly lesson: string;
  readonly useWhen: readonly string[];
  readonly doNotUseWhen: readonly string[];
  readonly validUntil?: string;
};
readonly verifyBeforeUse?: boolean;
```

Behavior:

- Create memory candidate exactly as today.
- If `selfImproving` is present, write companion metadata for the created candidate.
- Default `evidenceCount` to `sourceRefs.length || 1`.
- Default `useCount` to `0`.
- Default `lastSeenAt` to `now`.
- Store `verifyBeforeUse` on the memory object, not only on self-improving metadata.

Do not:

- Activate candidates.
- Infer metadata from raw transcripts.
- Allow metadata to override review policy classification.

Tests:

- Consolidation job with metadata creates candidate + metadata.
- Consolidation job without metadata behaves exactly as before.
- Secret-adjacent and authority-changing candidates still classify to quarantine.

Exit criteria:

- Existing consolidation behavior is backward compatible.

## Phase MF.4.5: User Review Gate

Type: user-controlled memory eligibility.

Files:

```text
packages/daemon/src/features/memory/routes.ts
apps/web/src/api.ts
apps/web/src/features/teammates/*
apps/web/src/features/settings/*
apps/web/src/shared/components/*
```

Behavior:

- Reuse existing memory review actions: approve, keep candidate, reject, archive, and
  quarantine.
- Show source refs before approval.
- Make approval change recall eligibility only by changing memory review state through
  existing store review APIs.
- Keep side-effect authority outside memory review.
- Support edit-and-approve through existing memory update inputs before changing review
  state.
- Support batch actions only for low-risk same-scope candidates with source refs and no
  critical health findings.
- Make the teammate Memory tab the primary review surface for one agent's candidates.
- Use workspace, channel, and workflow summary surfaces as filtered entry points into the
  same candidate review model.

User-facing actions:

| Action | Effect |
| --- | --- |
| Approve | Candidate becomes active within its current scope. |
| Edit and approve | User edits candidate fields, then candidate becomes active within the approved scope. |
| Keep candidate | Candidate remains stored but is not normal recall input. |
| Reject | Candidate is rejected and excluded from recall. |
| Quarantine | Candidate is disabled and requires explicit future inspection. |
| Archive | Candidate is hidden from active review flow but retained for audit. |

Strong manual approval cases:

- cross-scope promotion;
- generated workspace shared memory;
- teammate persona/profile update;
- sensitive or secret-adjacent content;
- missing source refs;
- conflicting or low-confidence memory;
- authority-like claims about tools, permissions, providers, credentials, deploy, approval,
  or external-send.

Do not:

- Create a runtime approval request for every candidate.
- Auto-approve generated candidates.
- Approve cross-scope promotion without showing source refs.
- Batch-approve protected-boundary candidates.
- Block running workflows with a runtime approval prompt for ordinary reviewable
  candidates.
- Let approval imply tools, permissions, providers, credentials, deploy, or external-send
  access.

Tests:

- Approving a candidate makes it active in the same scope.
- Edit-and-approve persists edited fields and then activates.
- Keeping a candidate keeps it out of normal task-run recall.
- Reject/quarantine/archive keep memory out of normal recall.
- Source refs are returned with candidate review payloads.
- Batch approval rejects cross-scope, persona, workspace, secret-adjacent, and
  authority-like candidates.
- Ordinary candidates do not create runtime approval requests.
- Teammate Memory review and workspace/channel/workflow filtered views operate on the
  same candidate records.

Exit criteria:

- A user can make a candidate eligible for active scoped recall without changing any
  runtime approval boundary.

## Phase MF.4.6: Governance Mode Controls

Type: product controls over memory review policy.

Files:

```text
packages/core/src/memory-types.ts
packages/core/src/workspace-types.ts
packages/core/src/storage/sqlite-run-store.ts
packages/daemon/src/features/memory/routes.ts
apps/web/src/features/settings/*
apps/web/src/features/teammates/*
```

Expose three product modes:

| Product mode | Internal policy |
| --- | --- |
| `manual_approval` | `conservative` |
| `assisted_approval` | `balanced` |
| `automatic_local_learning` | `fast` plus hard guardrails |

Configuration scope:

- workspace default;
- channel override;
- teammate override;
- workflow-template override;
- fan-in feature flag per workflow template.

Behavior:

- Default workspace mode is `assisted_approval`.
- Default fan-in experiment mode is `manual_approval`.
- `automatic_local_learning` still cannot auto-activate cross-scope, workspace shared,
  persona/profile, sensitive, secret-adjacent, or authority-changing candidates.
- Mode changes should be visible in settings and included in memory health reports.

Do not:

- Rename existing internal enum unless the implementation can migrate cleanly.
- Treat `automatic_local_learning` as permission to bypass review for generated fan-in
  candidates across scopes.
- Let mode changes alter runtime tool approval policy.

Tests:

- Product modes map deterministically to review policy.
- Workspace default applies when no override exists.
- More specific override wins over workspace default.
- Automatic mode still quarantines secret-adjacent and authority-changing candidates.
- Fan-in defaults to manual approval even when workspace default is assisted.

Exit criteria:

- Users can choose memory governance mode without changing runtime approval boundaries.

## Phase MF.4.7: Policy Tuning Suggestions

Type: read-only recommendations plus explicit user-applied settings changes.

Files:

```text
packages/core/src/memory-health.ts
packages/core/src/memory-types.ts
packages/core/src/storage/sqlite-run-store.ts
packages/daemon/src/features/memory/health.ts
apps/web/src/features/settings/*
```

Signals:

- candidate creation count by source, scope, channel, teammate, and workflow template;
- review action counts by action;
- manual-review and quarantine backlog age;
- duplicate and stale finding rates;
- active memories later archived, rejected, or superseded;
- recall usage count for approved memories;
- rejected/quarantined rate for automatically activated memories.

Output:

```ts
type MemoryPolicyTuningSuggestionKind =
  | "keep_manual"
  | "move_to_assisted"
  | "allow_automatic_same_scope"
  | "tighten_thresholds"
  | "disable_fan_in"
  | "review_backlog";

interface MemoryPolicyTuningSuggestion {
  readonly id: string;
  readonly kind: MemoryPolicyTuningSuggestionKind;
  readonly scopeType?: MemoryScopeType;
  readonly ownerId?: string;
  readonly workflowTemplateId?: string;
  readonly title: string;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly recommendedMode?: "manual_approval" | "assisted_approval" | "automatic_local_learning";
}
```

Behavior:

- Suggestions are generated from persisted memory, review, and health data.
- Applying a suggestion is an explicit settings action.
- Suggestions should appear in settings and health surfaces, not inside normal task/run
  prompts.

Do not:

- Automatically change governance mode.
- Loosen hard guardrails.
- Use model-generated confidence as the only evidence for a mode change.
- Enable fan-in globally from a suggestion.

Tests:

- High reject/quarantine rate recommends manual approval.
- Low candidate volume with high approval rate can recommend assisted approval.
- High duplicate/noise rate can recommend disabling fan-in for a workflow template.
- Applying a suggestion requires an explicit settings update path.

Exit criteria:

- Ling can explain why a governance mode should be kept, tightened, or loosened without
  changing it automatically.

## Phase MF.6: Workflow Step Fan-In

Type: deterministic candidate creation from terminal step output.

Default state: disabled behind a workspace setting or feature flag.

First rollout scope: `autoplan-lite` workflows only. Other workflow templates can opt in
later after health diagnostics and promotion inbox behavior are stable.

Files:

```text
packages/daemon/src/features/channels/orchestrator.ts
packages/daemon/src/features/channels/workflow-step-packets.ts
packages/daemon/src/features/memory/consolidation.ts
packages/core/src/run-types.ts
```

Trigger:

```text
workflow step transitions to succeeded
  AND workflow template is autoplan-lite
  AND memory fan-in feature flag is enabled
  AND output packet artifact exists
  AND resultSummary is non-empty
  AND no existing memory candidate was created for this workflowStepId
```

Candidate:

```text
scopeType:
  channel for product/design/architecture/release decision-like steps
  task or run for implementation/QA lessons by default

reviewState:
  candidate

sourceRefs:
  workflow id
  workflow step id
  run id
  task id
  output artifact id
```

Idempotency:

- Add a source ref or metadata marker that includes `workflowStepId`.
- Before creating a candidate, search existing memory source refs for that step id.
- A retry or startup recovery must not create duplicate candidates.

Do not:

- Fan in failed steps in the first slice.
- Summarize raw messages.
- Inject candidate into the next step.
- Auto-promote to workspace memory.

Tests:

- Succeeded step creates one candidate.
- Re-running orchestration does not create a duplicate.
- Candidate has source refs.
- Candidate is not included in normal task-run recall.
- Cross-scope destination requires manual-review decision.

Exit criteria:

- Fan-in is safe under retry and startup recovery.

## Phase MF.7: Web Health Surface

Type: read-only UI first, review actions second.

Files:

```text
apps/web/src/features/settings/*
apps/web/src/features/teammates/*
apps/web/src/features/runs/*
apps/web/src/shared/components/*
apps/web/src/styles/*
```

First UI:

- compact health summary;
- critical findings list;
- link to promotion inbox or memory item;
- no mutation buttons except existing review actions where already available.

Avoid:

- A large dashboard.
- Cards inside cards.
- Showing candidates as if they were active memory.
- Blocking normal workflow execution on non-critical health warnings.

Tests:

- Existing Playwright smoke still passes.
- Health panel handles empty report.
- Health panel handles critical findings without layout overflow.

Exit criteria:

- Users can see memory health without being forced into review flow.

## Phase MF.8: Proposal Creation

Type: optional follow-up after read-only health is stable.

Route:

```http
POST /memory/health/proposals?cwd=...
```

Allowed:

- Create memory candidates from findings.
- Create review proposals from findings.

Forbidden:

- Approve.
- Activate.
- Reject.
- Archive.
- Quarantine.
- Merge.
- Delete.
- Redact.

Exit criteria:

- Proposal creation cannot change active recall eligibility.

## Release Gates

Before enabling workflow fan-in by default:

- `pnpm --filter @ling-stack/core test`
- `pnpm --filter @ling-stack/daemon typecheck`
- `pnpm --filter @ling-stack/web typecheck`
- targeted tests for memory health and fan-in idempotency
- manual smoke of one workflow that reaches terminal success
- verify promotion inbox does not show duplicate candidates
- verify normal task-run recall excludes candidates
- verify `autoplan-lite` experiment does not create more than one candidate per terminal
  step

## Rollback Plan

If health diagnostics are noisy:

- keep API but hide Web panel;
- tune finding thresholds;
- leave existing memory recall untouched.

If fan-in creates bad candidates:

- disable fan-in feature flag;
- keep candidates as candidates;
- archive or reject bad candidates through review actions;
- do not run destructive cleanup.

If migration causes issues:

- metadata table is additive and can be ignored;
- existing memory objects remain readable;
- recall should not depend on metadata table availability.

## Implementation Order

Recommended order:

1. MF.0 baseline verification.
2. MF.1 core types.
3. MF.2 SQLite metadata.
4. MF.3 read-only health engine.
5. MF.4 read-only health API.
6. MF.7 read-only Web health surface.
7. MF.4.5 user review gate.
8. MF.4.6 governance mode controls.
9. MF.4.7 policy tuning suggestions.
10. MF.5 consolidation metadata.
11. MF.6 `autoplan-lite` workflow fan-in behind a setting or feature flag.
12. MF.8 proposal creation only after health findings are useful.

This order intentionally delays fan-in until the health/reporting path can show what was
created and why.

## Final Safety Check

The feature is safe only if all of these stay true:

- fan-in output starts as candidate memory;
- candidates are not normal recall input;
- source refs are mandatory for generated candidates;
- cross-scope promotion is reviewed;
- health diagnostics are read-only by default;
- memory never changes authority boundaries.
