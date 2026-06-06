# Memory Review Policy Implementation Plan

## Status

Implementation breakdown for [Ling Memory v1](ling-memory-v1.md), focused on
memory review policy, promotion inbox, and reflection/consolidation jobs.

Current implementation status: MRP.1-MRP.5 and the first MRP.7 surface are implemented for core types, SQLite
storage, deterministic policy classification, daemon contracts, API client methods,
promotion-inbox/review HTTP routes, and explicit consolidation-job candidate creation.
MRP.6 is partially implemented by existing active-only recall and used-memory audit.
A later global review center remains future work.

This document is the patch plan. It does not replace the Memory v1 boundary
design. The goal is to make candidate writes useful without turning every memory
into a manual review task, while preserving Ling's teammate, channel, workspace,
approval, and audit boundaries.

## Source Design

Authoritative behavior lives in:

- [Ling Memory v1](ling-memory-v1.md)
- [Codex-Like Execution Experience](codex-like-execution.md)
- [Approval Policy](approval-policy.md)
- [AI Teammates and Skills](ai-teammates-and-skills.md)

Implementation must preserve these boundaries:

- memory can never grant tools, approvals, provider access, deploy access,
  credentials, or external-send permission;
- reflection/consolidation jobs can create candidates, but cannot silently mutate
  workspace shared memory or teammate persona;
- promotion across teammate, channel, task/run, and workspace scopes requires
  explicit policy classification and source refs;
- memory review can borrow approval-card UI patterns, but it is not runtime tool
  approval and should usually be asynchronous;
- active recall must only use memories allowed by scope, sensitivity, review
  state, and workspace policy;
- vector or semantic retrieval remains optional and cannot become the source of
  truth for policy.

## Current Baseline

Already implemented:

- `MemoryObject`, `UsedMemoryEvent`, and `MemoryRetrievalProvider` core types.
- SQLite-backed `memory_objects` and `memory_used_events`.
- `GET/POST/PATCH /memory`, `POST /memory/recall`, and `GET /memory/used`.
- Lexical `recallMemory()` with scope and sensitivity filters.
- Task runs append a scoped memory prompt and record used-memory events.
- Teammate and workspace UI surfaces show memory scopes, memory objects, and used
  memory summaries.
- `vectorRetrieval.status = "not_installed"` is exposed as an optional future
  capability.

Current remaining gaps:

- `createMemoryObject()` still defaults to `reviewState: "active"` when the caller
  does not specify a review state; extracted job paths must keep setting review state
  explicitly.
- Automatic startup/idle scheduling for consolidation jobs is not enabled.
- Cross-scope promotion still needs a richer source-inspection flow.
- The Web review surface exists first in the teammate memory tab; a global review
  center is not built yet.
- Quarantine is represented as `reviewState: "disabled"` plus decision/sensitivity
  metadata, not as a separate `quarantined` review state.

## Target Concepts

### Review Modes

Workspace memory review mode:

```ts
type MemoryReviewMode = "conservative" | "balanced" | "fast";
```

Default: `balanced`.

Meaning:

| Mode | Behavior |
| --- | --- |
| `conservative` | Most extracted memories remain candidates until reviewed. |
| `balanced` | Low-risk same-scope memories can become active; high-impact items go to review. |
| `fast` | Same-scope memories auto-activate more often; cross-scope and sensitive items still require review. |

### Policy Outcome

```ts
type MemoryReviewOutcome =
  | "auto-active"
  | "auto-candidate"
  | "manual-review"
  | "quarantine";
```

Outcome rules:

- `auto-active`: may enter active recall immediately with source refs and audit.
- `auto-candidate`: stored as a candidate, visible, not default recalled.
- `manual-review`: routed to the promotion inbox before active/shared/persona use.
- `quarantine`: blocked from recall and promotion until inspected or discarded.

### Candidate Decision

Add a decision object so policy behavior can be explained after the fact:

```ts
interface MemoryReviewDecision {
  readonly outcome: MemoryReviewOutcome;
  readonly mode: MemoryReviewMode;
  readonly reasonCode: string;
  readonly reason: string;
  readonly confidence: "low" | "medium" | "high";
  readonly requiresManualReview: boolean;
  readonly quarantineReason?: string;
  readonly targetReviewState: MemoryReviewState;
  readonly targetSensitivity: MemorySensitivity;
  readonly sourceRefs: readonly MemorySourceRef[];
}
```

The first implementation can store this as JSON metadata on `memory_objects` or
as a separate audit table. Prefer a separate audit table if the patch is already
touching SQLite migrations.

### Promotion Inbox Item

The inbox should be a read model over reviewable memories plus their latest policy
decision. The first implementation lists candidates by default and keeps
manual-review/quarantine decisions visible through the decision, reason, and
recommended action fields. It does not have to be a separate table in the first
patch if `memory_objects` has enough fields.

```ts
interface MemoryPromotionInboxItem {
  readonly memory: MemoryObject;
  readonly decision?: MemoryReviewDecision;
  readonly sourceSummary: string;
  readonly recommendedAction:
    | "approve"
    | "edit_and_approve"
    | "keep_candidate"
    | "reject"
    | "quarantine";
}
```

## Patch Sequence

The slice should land as eight small patches.

```text
MRP.1 core review policy types
MRP.2 SQLite schema and store APIs
MRP.3 policy engine
MRP.4 promotion inbox API
MRP.5 reflection/consolidation job skeleton
MRP.6 run and chat integration
MRP.7 Web review surface
MRP.8 tests and docs alignment
```

## MRP.1 Core Review Policy Types

### Files

Update:

```text
packages/core/src/memory-types.ts
packages/core/src/workspace-types.ts
packages/core/src/index.ts
```

### Responsibilities

Core should own stable review vocabulary, not daemon route-specific DTOs.

Add:

- `MemoryReviewMode`;
- `MemoryReviewOutcome`;
- `MemoryReviewDecision`;
- `MemoryPromotionInboxItem`;
- `MemoryReviewAction`;
- optional `MemoryObject.reviewReason`, `confidence`, `verifyBeforeUse`, and
  `expiresAt` if the implementation chooses to align with the full design schema.

Suggested action type:

```ts
type MemoryReviewAction =
  | "approve"
  | "edit_and_approve"
  | "keep_candidate"
  | "reject"
  | "archive"
  | "quarantine";
```

Keep `MemoryReviewState` compatible:

```ts
type MemoryReviewState =
  | "candidate"
  | "active"
  | "disabled"
  | "archived"
  | "rejected";
```

Do not add `quarantined` to `MemoryReviewState` unless the UI and recall filters
are updated in the same slice. A simpler first implementation can represent
quarantine with `reviewState: "disabled"` plus `sensitivity: "secret-adjacent"`
and a review-decision reason.

## MRP.2 SQLite Schema And Store APIs

### Files

Update:

```text
packages/core/src/storage/sqlite-run-store.ts
packages/core/test/ai-teammate-workspace.test.mjs
```

### Schema

Add durable review policy settings. Short term, this can live in runtime settings
or workspace settings JSON. Long term, prefer a first-class table:

```sql
CREATE TABLE memory_review_policy (
  workspace_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  auto_active_same_scope INTEGER NOT NULL,
  auto_active_user_explicit INTEGER NOT NULL,
  require_manual_for_workspace INTEGER NOT NULL,
  require_manual_for_persona INTEGER NOT NULL,
  require_manual_for_cross_scope INTEGER NOT NULL,
  quarantine_secret_adjacent INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
```

Add review decision audit:

```sql
CREATE TABLE memory_review_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  mode TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  confidence TEXT NOT NULL,
  target_review_state TEXT NOT NULL,
  target_sensitivity TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Add optional review action audit:

```sql
CREATE TABLE memory_review_actions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_review_state TEXT NOT NULL,
  next_review_state TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  edited_memory_json TEXT,
  reason TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### Store APIs

Add methods on `RunStore`:

```ts
getMemoryReviewPolicy(workspaceId?: string): MemoryReviewPolicy;
updateMemoryReviewPolicy(input: MemoryReviewPolicyUpdateInput, now: string): MemoryReviewPolicy;
recordMemoryReviewDecision(input: CreateMemoryReviewDecisionInput, now: string): MemoryReviewDecision;
listMemoryPromotionInbox(options: ListMemoryPromotionInboxOptions): MemoryPromotionInboxItem[];
applyMemoryReviewAction(
  input: ApplyMemoryReviewActionInput,
  now: string,
): { memory: MemoryObject; action: MemoryReviewActionRecord };
```

Important migration rule:

- manual memory created by explicit user API may still default to `active`;
- extracted memory candidates from jobs or runtime summaries must pass through the
  review policy and should not depend on `createMemoryObject()` defaulting active.

## MRP.3 Policy Engine

### Files

Add:

```text
packages/core/src/memory-review-policy.ts
```

Update:

```text
packages/core/src/index.ts
packages/core/test/memory-review-policy.test.mjs
```

### Input

```ts
interface ClassifyMemoryCandidateInput {
  readonly policy: MemoryReviewPolicy;
  readonly candidate: CreateMemoryObjectInput;
  readonly sourceKind:
    | "manual_user"
    | "private_chat"
    | "channel_decision"
    | "task_run_summary"
    | "reflection_job"
    | "persona_source"
    | "import";
  readonly sourceScopeType: MemoryScopeType;
  readonly targetScopeType: MemoryScopeType;
  readonly crossesScopeBoundary: boolean;
  readonly userExplicitRemember: boolean;
  readonly confidence: "low" | "medium" | "high";
}
```

### Default Classifier

Rules:

1. If candidate is secret-adjacent, return `quarantine`.
2. If candidate implies tools, approvals, provider access, deploy, credentials, or
   external-send authority, return `quarantine`.
3. If source is `persona_source` or target affects teammate profile/persona,
   return `manual-review`.
4. If target scope is `workspace` and the user did not explicitly confirm,
   return `manual-review`.
5. If candidate crosses teammate/channel/task boundaries, return `manual-review`.
6. If confidence is low or conflict is detected, return `manual-review`.
7. If user explicitly said remember this inside the current scope, return
   `auto-active` unless a prior rule blocked it.
8. In `conservative`, return `auto-candidate` for remaining extracted items.
9. In `balanced`, return `auto-active` for low-risk same-scope task/run working
   memory and high-confidence explicit preferences; otherwise `auto-candidate`.
10. In `fast`, return `auto-active` for same-scope non-sensitive candidates;
    otherwise `auto-candidate`.

The classifier must be deterministic and testable. Do not call models inside the
policy engine.

## MRP.4 Promotion Inbox API

### Files

Update:

```text
packages/daemon/src/features/memory/routes.ts
packages/daemon/src/features/memory/schemas.ts
packages/api-client/src/client.ts
packages/contracts/src/index.ts
docs/daemon-api.md
```

### Routes

Add:

```http
GET /memory/review-policy?cwd=/path/to/workspace
PATCH /memory/review-policy?cwd=/path/to/workspace
GET /memory/promotion-inbox?cwd=/path/to/workspace
POST /memory/:id/review?cwd=/path/to/workspace
```

Review request:

```json
{
  "action": "edit_and_approve",
  "editedMemory": {
    "title": "Provider routing order",
    "body": "Provider routing resolves teammate, explicit run, channel default, then workspace selected.",
    "scopeType": "workspace",
    "ownerId": "workspace_default",
    "sensitivity": "normal"
  },
  "reason": "Stable workspace rule confirmed by user."
}
```

Response:

```json
{
  "memory": { "...": "..." },
  "action": { "...": "..." }
}
```

Rules:

- `approve` records an explicit local review action and moves a reviewable candidate
  to `active`; scope and sensitivity still control recall eligibility.
- `edit_and_approve` validates and stores the edited memory fields before activation.
- `keep_candidate` preserves `candidate`.
- `reject` sets `reviewState: "rejected"`.
- `archive` sets `reviewState: "archived"`.
- `quarantine` disables recall and records a quarantine reason.

## MRP.5 Reflection/Consolidation Job Skeleton

### Files

Add:

```text
packages/core/src/memory-consolidation-types.ts
packages/daemon/src/features/memory/consolidation.ts
```

Update:

```text
packages/core/src/run-types.ts
packages/core/src/storage/sqlite-run-store.ts
packages/contracts/src/index.ts
packages/api-client/src/client.ts
packages/daemon/src/features/memory/routes.ts
packages/daemon/src/features/memory/schemas.ts
packages/daemon/src/server/router.ts
docs/daemon-api.md
```

### Job Shape

```ts
type MemoryConsolidationJobKind =
  | "private_chat_summary"
  | "channel_decision_summary"
  | "task_run_lesson"
  | "workspace_consolidation";

type MemoryConsolidationJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
```

Minimum job record:

```ts
interface MemoryConsolidationJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: MemoryConsolidationJobKind;
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly status: MemoryConsolidationJobStatus;
  readonly createdCandidateIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

### Execution Model

Start with explicit triggers:

```http
POST /memory/consolidation-jobs?cwd=/path/to/workspace
GET /memory/consolidation-jobs?cwd=/path/to/workspace
```

Do not add automatic startup scheduling until:

- policy engine tests are passing;
- promotion inbox exists;
- quarantine and secret filters are in place;
- source refs are shown in UI;
- jobs are configurable off per workspace/channel/teammate.

When automatic scheduling is added, make it Codex-like but Ling-bounded:

```text
daemon startup or idle window
  -> enqueue bounded memory job
  -> read scoped events/artifacts/messages
  -> extract candidates
  -> classify with memory review policy
  -> store active/candidate/manual-review/quarantine result
  -> record job and decision audit
```

The first implementation intentionally does not silently activate job output. It still
runs the policy classifier and records the policy decision, but maps `auto-active` to
`auto-candidate` with `reasonCode: "consolidation_candidate_only"`. This preserves the
candidate-only boundary for Reflection/Consolidation Jobs while keeping the audit trail
explainable.

No job may send external messages, access raw secrets, mutate persona, mutate
approval policy, or change tool/provider access.

## MRP.6 Run And Chat Integration

### Files

Update:

```text
packages/daemon/src/features/runs/orchestrator.ts
packages/daemon/src/features/teammates/direct-replies.ts
packages/daemon/src/features/channels/ai-replies.ts
packages/daemon/src/features/memory/prompt.ts
```

### Recall Rules

- `active` memories are eligible for default recall.
- `candidate` memories are not default recalled.
- `manual-review` candidates can be referenced only when a user explicitly
  chooses to include them for a specific run.
- `quarantine` items are never recalled.
- `verifyBeforeUse` memories should be rendered with a prompt instruction to
  re-check source state before relying on them.

### Used-Memory Audit

Keep `UsedMemoryEvent` required whenever recalled memory enters a prompt.
Extend it later with:

- `reviewStateAtUse`;
- `decisionId`;
- `sourceRefCount`;
- `verifyBeforeUse`.

Do not wait for these extensions to ship the first inbox slice.

## MRP.7 Web Review Surface

### Files

Update:

```text
apps/web/src/features/teammates/TeammateWorkspace.tsx
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/api.ts
apps/web/src/i18n.tsx
```

Add a review surface in the memory tab first. A later global review center can
reuse the same components.

### UI Contract

Each card should show:

- title and excerpt;
- target scope and owner;
- source refs;
- latest policy decision and reason;
- confidence and sensitivity;
- recommended action;
- approve, edit and approve, keep candidate, reject, archive, quarantine.

Use the same design language as approval cards, but copy should say memory review,
not approval, to avoid implying a runtime side effect is blocked.

Default notification behavior:

- show inbox count in memory tab;
- no modal/popup for normal candidates;
- stronger attention only for persona, workspace shared memory, conflict, or
  sensitivity-boundary items.

## MRP.8 Tests And Docs Alignment

### Core Tests

Add:

```text
packages/core/test/memory-review-policy.test.mjs
packages/core/test/memory-review-store.test.mjs
```

Required cases:

- explicit same-scope "remember this" becomes `auto-active` in balanced mode;
- workspace shared memory from reflection job becomes `manual-review`;
- cross-channel promotion becomes `manual-review`;
- teammate persona update becomes `manual-review`;
- secret-adjacent candidate becomes `quarantine`;
- permission/tool/provider/deploy inference becomes `quarantine`;
- low-confidence candidate becomes `manual-review`;
- fast mode auto-activates same-scope non-sensitive candidate;
- conservative mode leaves extracted memory as candidate;
- rejected and quarantined items are excluded from recall.

### Daemon Tests

Add or extend:

```text
packages/daemon/test/memory-api.test.mjs
packages/daemon/test/run-memory-recall.test.mjs
```

Required cases:

- list/update review policy;
- list promotion inbox;
- approve candidate;
- edit and approve candidate;
- reject candidate;
- quarantine candidate;
- active memory appears in run prompt and used-memory audit;
- candidate memory does not appear in run prompt by default.

### Web Tests

Add targeted component or Playwright tests after the API exists:

- inbox count appears;
- review card renders source refs and decision reason;
- approve/edit/reject actions update the list;
- candidate does not show under used-memory until approved.

### Documentation

Update:

- [Ling Memory v1](ling-memory-v1.md) implementation status;
- [Daemon API](../daemon-api.md) memory endpoints;
- Web copy in `apps/web/src/i18n.tsx`;
- README link only after the feature is user-visible.

## Rollout Order

Recommended ship order:

1. Core types, policy engine, and tests.
2. SQLite policy/decision/action persistence.
3. Manual promotion inbox API.
4. UI for reviewing existing/manual candidates.
5. Run recall hardening to exclude candidates by default.
6. Explicit consolidation job trigger.
7. Automatic bounded scheduling.
8. Optional retrieval-provider integration.

Do not ship automatic reflection jobs before the promotion inbox and quarantine
path exist.

## Acceptance Criteria

This implementation slice is complete when:

- a workspace has a visible memory review mode;
- low-risk same-scope memory can become active without manual review under
  `balanced`;
- workspace shared memory, persona updates, cross-scope promotion, conflicts,
  and sensitive items route to the promotion inbox;
- secret-adjacent and authority-changing candidates are quarantined and never
  recalled;
- active memory appears in run recall with used-memory audit;
- candidate and quarantined memory do not appear in default run recall;
- every review action records source refs and an auditable decision;
- reflection/consolidation jobs can create candidates but cannot mutate persona,
  approvals, tools, providers, credentials, deploy access, or external-send
  authority.

## Non-Goals

- No default vector database or embedding job.
- No gbrain dependency in this slice.
- No native Codex memory pipeline dependency.
- No automatic persona rewrite.
- No cross-workspace memory sharing.
- No secret indexing.
- No runtime approval bypass.
- No global review center requirement before the first memory-tab inbox works.
