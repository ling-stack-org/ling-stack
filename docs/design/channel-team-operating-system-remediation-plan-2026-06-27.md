# Channel Team Operating System Remediation Plan - 2026-06-27

Status: remediation implementation source of truth; R0-R7 implemented and targeted validation passed locally; review/ship pending
Date: 2026-06-27

Source docs:

- [Channel Team Operating System](channel-team-operating-system.md)
- [Channel Team Operating System Task Plan - 2026-06-26](channel-team-operating-system-task-plan-2026-06-26.md)

Current local implementation baseline after remediation:

- PRs #261-#269 added the channel-team contracts, stores, projections, APIs, metrics,
  lifecycle incidents, risk review adapter, pattern store, snapshots, and evaluation
  harness.
- The remediation now wires the previously-missing runtime, UI, availability, authority,
  and maturity boundaries as local code changes.
- Remaining work is validation, review, and ship hygiene. New Team OS concepts should not
  be added in this remediation branch.

## Audit Verdict

The current remediation branch has the Team OS spine implemented end to end for the first
slice: narrow risk review, pure runtime governor, evidence-only ObserverBus, folded
Experts UI, settings Team Metrics, provider availability ingestion, fact-only Authority
Ledger, and shadow-only Pattern/Snapshot/Evaluation maturity features.

Implemented foundations:

- `packages/contracts/src/channel-team.ts` and exported contracts.
- `channel_team_evidence_items` persistence and folded evidence read model.
- `channel_team_incidents` reliability/availability storage.
- `channel_team_patterns`, `channel_team_snapshots`, and evaluation run persistence.
- Core builders for attention, specialist notes, lifecycle, metrics, risk review,
  patterns, snapshots, and synthetic evaluation.
- Daemon read/write APIs for experts, metrics, patterns, snapshots, and evaluations.
- Risk Review adapter wired into run approval flow.

Still intentionally incomplete for later product slices:

- observer model calls that inspect real code/files and produce Specialist Notes;
- automatic memory promotion or protocol promotion;
- Team Snapshot restore/apply;
- real historical replay in the Evaluation Harness;
- Human Override turn-control UI.

## Implementation Audit Matrix

This matrix is the current source of truth for repair scope. If code evidence conflicts
with earlier task-plan wording, follow this matrix.

| Slice | Current state | Original deviation | Repair stance |
| --- | --- | --- | --- |
| R0 | Implemented. | Daemon suite was red on unrelated test drift. | Baseline fixes only; no Team OS behavior change. |
| R1 | Implemented. | Ordinary `git_push` was treated as Team Risk Review. | Narrow trigger set; no second approval engine. |
| R2 | Implemented. | Runtime plan type existed without a real governor. | Pure deterministic builder with canonical runtime plan shape. |
| R3 | Implemented. | Attention/gov builders were unused by real channel turns. | Feature-flagged daemon ObserverBus, evidence-only, no visible observer messages. |
| R4 | Implemented. | Components/endpoints existed, but live Web data flow was absent. | Live folded Experts near latest turn and Team Metrics in settings. |
| R5 | Implemented. | Provider/runtime failures were not ingested through `RunStore`. | Availability-only incidents; quality/reliability are not downgraded. |
| R6 | Implemented. | `AuthorityLedgerEntry` existed without a projection endpoint/read model. | Fact-only projection over existing approvals, runs, replies, and leases. |
| R7 | Implemented. | Pattern/snapshot/eval could imply more authority than they have. | Shadow guardrails plus tests for no protocol/memory/skill mutation. |

## Code-Audited Corrections And Implemented Outcome

The following corrections come from reading the current code. They override looser wording
elsewhere in this document.

1. R3 was not only missing tests. It was not wired at all.
   `packages/daemon/src/features/channels/ai-replies.ts` builds a turn envelope and then
   goes directly into memory recall, web context, and model execution. There is no
   ObserverBus hook and no channel-team feature flag passed into `createAiChannelReply`.
   Outcome: added feature-flagged `observer-bus.ts` wiring from the channel turn path.
2. `packages/daemon/src/config.ts` currently exposes only `channels.autoRoute` and
   `channels.intentSelector`. R3 must add `channels.teamObserverBus` and expose it through
   `/health` and websocket `initialize`/`daemon.health` via the resolved channel config.
   Outcome: added `channels.teamObserverBus`.
3. `AiTeammate` has fixed `roleKey` values but no capability manifest field. The first
   ObserverBus slice must infer capability manifests in one daemon helper. Do not expand
   teammate profile storage in R3 unless a separate migration is explicitly scoped.
   Outcome: capability inference stays in the ObserverBus slice.
4. `SqliteChannelTeamLifecycleStore` has `createAvailabilityIncident`, but `RunStore` and
   `SqliteRunStore` expose only incident list methods. R5 cannot be implemented cleanly
   until the shared store facet exposes create methods.
   Outcome: `RunStore` exposes lifecycle incident write methods and daemon ingestion uses
   those methods.
5. Web endpoints and API-client methods for Experts/Metrics exist, but
   `apps/web/src/api/channels.ts` has no wrapper functions and `WorkspaceClientView` has
   no fetch/render path. R4 is a live-data wiring task, not a component redesign.
   Outcome: Web wrappers, mock daemon routes, latest-turn Experts fetch, and settings
   Metrics rendering are wired.
6. `AuthorityLedgerEntry` is currently only a contract type. R6 must start as a pure
   projection over existing approval/run/lease facts; a durable table would be premature.
   Outcome: added pure Authority Ledger projection and daemon/API-client read endpoint.
7. Pattern, Snapshot, and Evaluation Harness storage exists. R7 must harden
   non-authoritative behavior before adding replay confidence or automatic learning.
   Outcome: added shadow guardrails to pattern/snapshot/diff/evaluation read models and
   tests proving no protocol, memory, or skill mutation.

## Recommended Repair Strategy

Implemented integration spine:

```text
R0 baseline
  -> R1 approval/risk boundary
  -> R2 pure runtime governor
  -> R5a lifecycle write surface
  -> R3a daemon ObserverBus writes evidence
       -> R4 Web can show real Experts/Metrics
       -> R5b availability can influence observer selection
       -> R6 authority facts can explain approvals
       -> R7 maturity features stay shadow-only
```

This order is now the repair record. Do not restart from the older PR order unless a
future audit explicitly reopens a slice.

### Corrected Execution Order

The old PR order is no longer accurate because R5 contains a small store-interface
prerequisite for R3 tests. The implemented order is:

```text
R0 baseline
  -> R1 risk-review boundary
  -> R2 runtime governor
  -> R5a lifecycle write surface only
  -> R3a ObserverBus evidence-only wiring
  -> R5b provider/runtime availability ingestion
  -> R4 live Experts/Metrics UI
  -> R6 Authority Ledger projection
  -> R7 non-authoritative hardening
```

R5a is intentionally small: add `createAvailabilityIncident` to `RunStore` and
`SqliteRunStore`, plus tests that list and create through the shared store. It should not
yet map provider errors or affect scheduling. R3a can then seed availability incidents in
daemon tests without reaching into SQLite internals.

R5b is the real ingestion work: map provider/runtime failures into short-lived
availability incidents and feed them into attention/runtime planning.

## Validation Snapshot

Current targeted validation for the R0-R7 remediation branch:

| Command | Result | Coverage |
| --- | --- | --- |
| `corepack pnpm --filter @ling-stack/core build` | Passed. | core contracts/build |
| `corepack pnpm --filter @ling-stack/daemon build` | Passed. | daemon integration build |
| `corepack pnpm --filter @ling-stack/api-client build` | Passed. | API client contracts |
| `corepack pnpm --filter @ling-stack/web typecheck` | Passed. | Web TypeScript |
| `node --test packages/core/test/channel-team-risk-review.test.mjs packages/core/test/channel-team-runtime-governor.test.mjs packages/core/test/channel-team-lifecycle-store.test.mjs packages/core/test/channel-team-lifecycle.test.mjs packages/core/test/channel-team-authority-ledger.test.mjs packages/core/test/channel-team-pattern-store.test.mjs packages/core/test/channel-team-snapshot-harness.test.mjs packages/core/test/channel-team-metrics.test.mjs packages/core/test/channel-team-attention.test.mjs packages/core/test/channel-team-evidence-store.test.mjs` | Passed, 35/35. | R1/R2/R5/R6/R7 core behavior |
| `node --test packages/daemon/test/channel-team-authority-ledger-api.test.mjs packages/daemon/test/channel-team-experts-api.test.mjs packages/daemon/test/channel-team-metrics-api.test.mjs packages/daemon/test/channel-team-patterns-api.test.mjs packages/daemon/test/channel-team-snapshots-api.test.mjs` | Passed, 5/5. | R4/R6/R7 daemon APIs |
| `node --test --test-name-pattern "teamObserverBus|provider runtime failures|observer bus" packages/daemon/test/channel-workspace.test.mjs` | Passed, 6/6. | R3/R5 daemon turn-loop behavior |
| `corepack pnpm --dir apps/web exec playwright test e2e/channel.spec.ts -g "channel team experts fold"` | Passed, 1/1. | R4 folded Experts + settings Metrics |
| `git diff --check` | Passed. | whitespace/diff hygiene |

Historical full-suite baseline before later remediation slices:

| Command | Result |
| --- | --- |
| `@ling-stack/core test` | Passed, 234/234. |
| `@ling-stack/api-client test` | Passed, 36/36. |
| `@ling-stack/web typecheck` | Passed. |
| `@ling-stack/daemon test` | Passed, 443/443 after R0 fixes. |

Daemon failures observed before R0:

1. `workflow proposal context view maps supported source refs for shaping evidence`
   fails because the test store lacks `listChannelBranches`.
2. `channel branches follow archive restore and delete lifecycle` now sees an extra
   `"AI teammate is not configured for this channel."` message.
3. `teammate direct web search context blocks unsupported providers without fetching`
   no longer emits the expected Chinese blocked web-search delta.

These failures are not directly caused by the channel-team API surface, but they block a
clean remediation baseline and must be fixed first.

R0 local fixes:

- Added `listChannelBranches` to the context-processing test mock store.
- Narrowed the channel branch lifecycle assertions to local-user branch messages so the
  test verifies branch routing instead of incidental blocked AI replies.
- Added `allowPublicSearchFallback` to web evidence context building and disabled public
  fallback for private teammate direct replies. Shared channel replies still keep the
  existing public fallback behavior.

## Remediation Order

Do not add more channel-team concepts until these slices are complete.

### R0 - Restore Green Baseline

Goal: make `main` testable before changing channel-team runtime behavior.

Status: fixed locally in this remediation branch. Keep this as the first PR if the work
is split across machines.

Files changed:

- `packages/daemon/test/channel-context-processing.test.mjs`
- `packages/daemon/test/channel-workspace.test.mjs`
- `packages/daemon/src/features/teammates/direct-replies.ts`
- `packages/daemon/src/features/web/web-evidence-service.ts`
- `docs/design/ling-web-tools.md`

Completed tasks:

- Added `listChannelBranches` to the context-processing test mock store where required.
- Kept the extra blocked AI reply behavior and narrowed the branch lifecycle test to the
  local-user messages that prove branch routing.
- Restored private teammate direct unsupported-provider behavior by disabling public
  fallback on that surface, which restores the blocked web-search delta and avoids fetch.

Acceptance:

- `corepack pnpm --filter @ling-stack/daemon test` passes, 443/443.
- No channel-team runtime changes in this slice.

### R1 - Narrow Risk Review Gate

Goal: keep Risk Review Gate narrow and avoid turning ordinary `git_push` approvals into
risk-review-labeled approvals.

Status: implemented locally.

Original divergence:

- `packages/core/src/channel-team-risk-review.ts` adds a trigger for every
  `actionType === "git_push"`.
- The design says the first shipped trigger set is force push, protected-branch push,
  destructive actions, deploy/production mutation, external send/account mutation,
  credential/provider changes, runtime permission expansion, remote script execution,
  recursive permission mutation, and critical risk.

Files:

- `packages/core/src/channel-team-risk-review.ts`
- `packages/core/test/channel-team-risk-review.test.mjs`
- `packages/daemon/src/features/runs/approvals.ts`
- `packages/daemon/test/approval-policy-run.test.mjs`
- `packages/daemon/src/features/runs/action-classifier.ts`

Completed tasks:

- Removed the unconditional `git_push` risk-review trigger.
- Keep triggers for `git_force_push`, protected-looking branch push, critical risk, and
  other explicitly listed high-risk cases.
- Keep ordinary `git_push` under existing Approval Policy; it may still require approval,
  but it should not be called Risk Review unless the narrow trigger set matches.
- Added tests for:
  - ordinary `git push origin feature` does not produce Risk Review;
  - `git push origin main` produces protected branch Risk Review;
  - `git push --force-with-lease` remains critical Risk Review.

Acceptance:

- Risk Review is not a second approval system.
- Existing approval behavior remains intact for ordinary `git_push`.

### R2 - Implement Team Runtime Governor

Goal: centralize observer budget, timeout, fallback, late notes, and read-lease policy.

Status: core builder fixed locally in this remediation branch. Daemon turn-loop use of the
runtime plan remains R3.

Previous divergence:

- `TeamRuntimePlan` exists as a minimal type with `constraints`, but there is no builder
  or enforcement layer for the design's timeout/fallback/budget fields.

Allowed refactor:

- It is acceptable to replace the current minimal `TeamRuntimePlan` contract with the
  fuller design shape if that produces a cleaner implementation.
- Keep backward compatibility for any existing API response or store field if one exists;
  otherwise prefer the canonical design.

Files changed:

- `packages/contracts/src/channel-team.ts`
- `packages/core/src/channel-team-types.ts`
- `packages/core/src/channel-team-runtime-governor.ts`
- `packages/core/test/channel-team-runtime-governor.test.mjs`

Required shape:

```ts
interface TeamRuntimePlan {
  readonly id: string;
  readonly channelId: string;
  readonly turnId: string;
  readonly turnMode: ChannelTeamTurnMode;
  readonly attentionPlanId?: string;
  readonly maxObservers: number;
  readonly totalTimeoutMs: number;
  readonly perAgentTimeoutMs: number;
  readonly allowLateNotes: boolean;
  readonly allowFallbackProvider: boolean;
  readonly maxReadLeases: number;
  readonly budgetClass: "low" | "normal" | "high";
  readonly observers: readonly AgentObserverPlan[];
  readonly constraints: readonly string[];
  readonly createdAt: string;
}
```

Inputs:

- Turn Mode;
- Attention Plan;
- provider/runtime availability;
- agent lifecycle state;
- risk review requirement;
- channel settings when available.

Rules:

- Low-priority observers never block the main reply.
- Required Risk Review can block high-risk side effects.
- `offline` and `overloaded` observers are skipped.
- `slow` observers may become late-note candidates.
- fallback provider must satisfy the required capability and risk scope.
- budget limits must be deterministic and testable.

Acceptance:

- Core tests cover quick answer, deep review, safe action, slow observer, offline
  observer, and risk-review-required behavior.
- No automatic model calls yet; this slice only computes and exposes the plan.

### R3 - Wire ObserverBus Into Ling Agent Turn Loop

Goal: create bounded observer evidence automatically without allowing observers to reply
or request tools.

Status: implemented locally.

Original divergence:

- `buildChannelTeamAttentionPlan` and `buildAgentRelevanceCardEvidenceInputs` exist, but
  no daemon channel turn path calls them.

Files changed/inspected:

- `packages/daemon/src/features/channels/ling-agent-turn-envelope.ts`
- `packages/daemon/src/features/channels/ling-agent-executor.ts`
- `packages/daemon/src/features/channels/channel-message-router.ts`
- `packages/daemon/src/features/channels/ai-replies.ts`
- `packages/daemon/src/features/channels/channel-teammate-availability.ts`
- `packages/core/src/storage/sqlite/channel-team-evidence-store.ts`

Completed tasks:

- Add a feature-flagged ObserverBus step after TurnEnvelope/context preparation and
  before Ling Agent final decision.
- Generate `AttentionPlan` from channel teammates, participation mode, capability
  manifests, turn signals, and lifecycle state.
- Persist only `agent_relevance_card` evidence in the first ObserverBus slice.
- Do not call observer models in this slice unless explicitly scoped later.
- Do not create visible `channel_messages`.
- Do not create approvals, runs, memory, or tool requests.

Acceptance:

- A normal channel turn can produce bounded internal relevance evidence.
- Ling Agent reply behavior is unchanged.
- Disabling the feature flag produces no evidence.
- Tests assert observers cannot create visible messages.

### R4 - Wire Experts And Metrics UI

Goal: make the existing UI components visible from real data without polluting the main
conversation.

Status: implemented locally.

Original divergence:

- `ChannelTeamExpertsSummary` and `ChannelTeamMetricsPanel` exist, and daemon/api-client
  endpoints exist, but the live workspace/settings data flow does not fetch and render
  them.

Files changed/inspected:

- `apps/web/src/api/channels.ts`
- `apps/web/src/app/AppShell.tsx`
- `apps/web/src/features/workspace/ConversationHome.tsx`
- `apps/web/src/features/workspace/ChannelTeamExpertsSummary.tsx`
- `apps/web/src/features/workspace/ChannelTeamMetricsPanel.tsx`
- `apps/web/e2e/app.spec.ts` or targeted channel/team settings e2e.

Completed tasks:

- Fetch folded Experts for the active turn or operation cell only.
- Render one compact Experts line in the main conversation or operation cell header.
- Add expanded details with summaries, evidence grade, status, and source refs only.
- Fetch Team Metrics in channel settings, not the main feed.
- Keep metrics as reasons and health diagnostics, not a score/rank UI.

Acceptance:

- No first-level per-agent chat messages.
- Empty experts render nothing.
- Expanded experts do not expose hidden reasoning, raw private content, or full logs.
- Web typecheck passes.
- Add a targeted e2e or component-level test with mock daemon data.

### R5 - Availability Incident Ingestion

Goal: make provider/runtime failures affect short-lived availability routing, not quality.

Status: implemented locally.

Original divergence:

- Reliability and availability incidents are separated in storage and lifecycle logic, but
  provider/runtime observations are not yet fed into availability incidents as part of
  channel-team scheduling.

Files changed/inspected:

- `packages/daemon/src/features/channels/provider-runtime-observations.ts`
- `packages/daemon/src/runtime/runner-readiness.ts`
- `packages/core/src/storage/sqlite/channel-team-lifecycle-store.ts`
- `packages/core/src/channel-team-lifecycle.ts`
- `packages/daemon/src/features/channels/channel-teammate-availability.ts`

Completed tasks:

- Convert provider quota, overload, network, timeout, and capability mismatch into
  short-lived `AvailabilityIncident`.
- Never create `ReliabilityIncident` from provider/runtime failure.
- Assign deterministic TTLs:
  - timeout/slow: minutes;
  - quota/rate limit: provider-specific reset or short TTL;
  - overloaded/offline: short TTL with circuit-breaker style refresh.
- Feed availability state into `AttentionPlan` and `TeamRuntimePlan`.

Acceptance:

- Tests prove quota/timeout/offline do not change `AgentQualityState`.
- Attention and runtime plan skip or delay unavailable observers.

### R6 - Authority Ledger Projection

Goal: record authority facts without adding a second policy engine.

Status: implemented locally.

Original state:

- Approval requests, runtime events, leases, and run records already contain most facts.
- There is no clear `AuthorityLedgerEntry` projection for channel-team usage.

Implemented approach:

- Prefer a projection over existing approval/run/lease records before creating a new
  durable table.
- If a table is needed later, it must be append-only and fact-only.

Files changed/inspected:

- `packages/contracts/src/channel-team.ts`
- `packages/core/src/run-types.ts`
- `packages/core/src/storage/sqlite-run-store.ts`
- `packages/daemon/src/features/runs/approvals.ts`
- `packages/daemon/src/features/runs/permission-requests.ts`

Acceptance:

- Ledger never decides allow/deny.
- Ledger references existing policy decisions and approval ids.
- Risk Review entries map to approval/run intervention facts.

### R7 - Harden Pattern, Snapshot, And Evaluation Maturity Features

Goal: keep early v2/v3 features useful but non-authoritative until foundations are stable.

Status: implemented locally.

Original state:

- Pattern Store, Snapshot, and Evaluation Harness exist earlier than the original staging.
- They appear mostly read-model/admin-level and do not auto-promote authority, which is
  acceptable.

Completed tasks:

- Keep Pattern Store inspect-only for permanent behavior: candidates and provisional
  rules are stored as shadow artifacts and do not mutate channel protocol, memory, skills,
  or runtime authority.
- Keep Snapshot restore explicit: snapshot diff includes `restoreRequiresExplicitApply`
  and snapshot records carry shadow guardrails.
- Keep Evaluation Harness synthetic: evaluation runs carry shadow guardrails and are not
  used to change routing, lifecycle, protocol, memory, or skills.
- Add API/core tests around non-mutation boundaries before adding any richer replay
  behavior.

Acceptance:

- No memory/protocol/skill promotion happens automatically.
- No snapshot restore mutates live state without explicit apply.
- Harness results are not used to enable aggressive routing yet.

## Refactor Permission

Refactor is allowed where the current implementation shape blocks the intended design.

Use these triggers:

- Prefer a small patch when the change only exposes an existing store method, adds a
  feature flag, or wires an existing endpoint/component.
- Extract a focused helper when new logic would add more than one concern to
  `ai-replies.ts`, `WorkspaceClientView.tsx`, or a channel-team core module.
- Refactor before behavior when a file would otherwise mix selection, persistence,
  provider error classification, and UI projection in one place.
- Stop and update this plan before any rewrite that changes channel message ownership,
  Ling Agent reply semantics, Approval Policy behavior, or teammate profile storage.

Allowed refactors:

- Replace the minimal `TeamRuntimePlan` with the fuller canonical shape.
- Split channel-team core modules if a single file starts mixing runtime planning,
  evidence folding, lifecycle, and metrics.
- Move UI fetch state into a focused hook/domain instead of adding more logic directly to
  `WorkspaceClientView.tsx`.
- Add a daemon `observer-bus.ts` module rather than wiring attention, runtime planning,
  and evidence writes directly into `ai-replies.ts`.

Not allowed without a separate design update:

- visible all-agent group chat by default;
- observer model calls that can write channel messages;
- automatic memory promotion;
- automatic protocol or permission mutation from Pattern Store;
- second approval policy engine;
- hidden raw reasoning storage;
- quality downgrade from provider/runtime failure.

## Completion Definition

The remediation is complete when:

- daemon, core, api-client, and web typecheck/test gates pass;
- Risk Review is narrow and maps into existing approval/run flows;
- Team Runtime Governor computes deterministic budget/fallback/late-note policy;
- ObserverBus records bounded internal evidence without changing Ling Agent reply
  ownership;
- Experts UI is actually rendered from live folded evidence;
- Team Metrics is available in settings and does not present a leaderboard;
- availability failures affect only availability routing;
- Pattern/Snapshot/Harness remain non-authoritative until explicitly promoted.

## Suggested PR Plan

| PR | Scope | Must pass |
| --- | --- | --- |
| R0 | Fix current daemon test failures. | `@ling-stack/daemon test` |
| R1 | Narrow Risk Review Gate. | core risk tests, daemon approval tests |
| R2 | Team Runtime Governor core builder. | core governor tests |
| R3 | ObserverBus inert turn-loop evidence. | daemon channel turn tests |
| R4 | Experts/Metrics live UI wiring. | web typecheck, targeted e2e |
| R5 | Availability incident ingestion. | core lifecycle tests, daemon provider observation tests |
| R6 | Authority Ledger projection. | daemon approval/run projection tests |
| R7 | Snapshot/Harness maturity hardening. | core snapshot/evaluation tests |

## What Already Exists

Reuse these foundations. Do not rebuild parallel systems.

| Need | Existing implementation to reuse | Rule |
| --- | --- | --- |
| Per-turn owner and final decision | Ling Agent turn envelope, executor, and channel message router. | Ling Agent stays the only main narrator. |
| Context visibility | Channel Context Processing and private chat views. | Observer evidence must use scoped context views or bounded summaries. |
| Work lifecycle | Runtime Supervisor work units, attempts, and runtime events. | Team state may reference work units, but observer notes are not runtime events. |
| Approval authority | Approval Policy, approval requests, run intervention records. | Risk Review is a label/reason projected into existing approval flow. |
| Team evidence persistence | `channel_team_evidence_items` and folded evidence projection. | Use for relevance cards, notes, and risk signals before adding tables. |
| Lifecycle state | `channel_team_incidents` and lifecycle builders. | Keep availability separate from quality/reliability. |
| Experts and metrics APIs | daemon experts/metrics routes plus api-client surfaces. | Wire UI to existing APIs before inventing new endpoints. |
| Pattern/Snapshot/Evaluation | Pattern store, snapshots, synthetic evaluation run storage. | Keep inspect-only until runtime foundations are real. |

## Target Runtime Shape

The complete remediation should converge on this flow:

```text
User ChannelMessage
  -> LingAgentTurnEnvelope
  -> Context Processing Layer
  -> Turn Mode
  -> AttentionPlan
       uses teammate membership, fixed role, capability manifest, lifecycle,
       mentions, files, attachments, active work, risk signals
  -> TeamRuntimeGovernor
       enforces observer count, timeout, read leases, fallback, late notes
  -> ObserverBus
       writes bounded internal evidence only
  -> Folded Experts Projection
       compact UI summary and detailed inspect panel
  -> Ling Agent Decision
       answer / clarify / workflow / approval wait / no reply
  -> Existing Approval Policy + Runtime Supervisor
       side effects remain under existing authority gates
```

The important product invariant remains:

```text
observers can influence evidence,
but only Ling Agent or explicit workflow ownership can create visible replies or side effects.
```

## Detailed Implementation Tasks

This section preserves the implementation detail that guided the repair. The current
status is the audit matrix and task checklist above; historical "problem" wording below
describes the pre-remediation state unless a slice explicitly says otherwise.

### R1 Detailed Plan - Risk Review Gate

Problem:

`packages/core/src/channel-team-risk-review.ts` currently marks every
`actionType === "git_push"` as Risk Review. That is too broad. Ordinary branch pushes
may still require existing approval, but they must not become Team Risk Review.

Implementation:

1. Remove the unconditional `git_push` trigger from `addActionTypeTriggers`.
2. Keep `git_force_push` and protected-looking branch push detection inside bash payload
   command/risk-flag parsing.
3. Keep `critical_risk`, deploy/production mutation, external send/account mutation,
   credential/provider change, runtime permission expansion, remote script execution,
   recursive permission mutation, reset-hard, and destructive delete.
4. If action classification already marks ordinary `git_push` as an approval action,
   leave that behavior in Approval Policy. Only the Team Risk Review reason changes.
5. Do not create a new approval policy or second allow/deny decision.

Tests:

- `packages/core/test/channel-team-risk-review.test.mjs`
  - ordinary `actionType: "git_push"` with command `git push origin feature` returns
    `not_required`;
  - `git push origin main` returns `required` with `protected_branch_push`;
  - `git push --force-with-lease` returns `required`, `critical`, and `git_force_push`.
- `packages/daemon/test/approval-policy-run.test.mjs`
  - force push still upgrades into an explicit approval request;
  - ordinary push approval behavior remains owned by existing Approval Policy.

Verification:

```text
corepack pnpm --filter @ling-stack/core test -- channel-team-risk-review
corepack pnpm --filter @ling-stack/daemon test -- approval-policy-run
```

### R2 Detailed Plan - Team Runtime Governor

Problem:

`TeamRuntimePlan` exists as a minimal contract shape. It does not yet compute observer
budget, timeout, late-note policy, fallback allowance, or read-lease limits.

Implementation:

1. Add a pure core builder, preferably `packages/core/src/channel-team-runtime-governor.ts`.
2. Expand or replace `TeamRuntimePlan` with the canonical shape in contracts/core.
3. Keep the first slice pure: no model calls, no daemon turn-loop side effects, no storage
   writes unless needed for read-model tests.
4. Inputs:
   - turn mode;
   - attention plan;
   - availability state;
   - lifecycle state;
   - risk-review decision;
   - optional channel settings.
5. Outputs:
   - selected observers;
   - max observer count;
   - total and per-agent timeouts;
   - late-note allowance;
   - fallback provider allowance;
   - max read leases;
   - deterministic constraints list.

Rules:

| Input condition | Governor behavior |
| --- | --- |
| `quick_answer` | zero or one low-latency observer; no blocking observers. |
| `deep_review` | multiple observers allowed within budget; late notes allowed. |
| `safe_action` with Risk Review required | required reviewer can block risky side effects. |
| observer `offline` or `overloaded` | skip observer and record constraint. |
| observer `slow` | include only as late-note candidate unless required. |
| no compatible provider | skip or mark fallback constraint; do not lower quality state. |
| fallback provider available | allow only if capability and risk scope match. |

Tests:

- `quick_answer` suppresses normal observers.
- `deep_review` admits multiple normal observers but respects max budget.
- `safe_action` preserves required reviewer.
- `slow` observer becomes late-note candidate.
- `offline`/`overloaded` observer is skipped.
- Risk Review required adds a blocking constraint.

Verification:

```text
corepack pnpm --filter @ling-stack/core test -- channel-team-runtime-governor
```

### R3 Detailed Plan - ObserverBus Wiring

Problem:

Attention builders exist, but channel turns do not automatically produce internal
observer evidence.

Implementation:

1. Add a daemon config flag:
   - `channels.teamObserverBus?: boolean`;
   - env: `LING_STACK_CHANNEL_TEAM_OBSERVER_BUS`;
   - default: `false`;
   - expose it under `/health.features.channels.teamObserverBus`.
2. Add a focused daemon module:
   - preferred file: `packages/daemon/src/features/channels/observer-bus.ts`;
   - exported function: `runChannelObserverBusForTurn(...)`;
   - inputs: `store`, `channel`, `sourceMessage`, `turnEnvelope`, `providerPresetId`,
     `now`, optional runtime settings;
   - output: a small result with `attentionPlan`, `runtimePlan`, `createdEvidenceIds`,
     `skippedObserverIds`, and `constraints`.
3. Call the module from `completeAiChannelReply` after `turnEnvelope` exists and before
   memory/web/model work. The call must be best-effort: if ObserverBus throws, log internal
   runtime/evidence-safe failure only and keep the Ling Agent reply path unchanged.
4. Build candidates from `listEffectiveChannelAiTeammateEntries(store, channel)`.
   - exclude Ling Agent itself;
   - preserve fixed teammate identity;
   - use teammate capability manifest fields if they exist;
   - first fallback for custom roles may map `roleKey` to broad capability scopes, but
     this mapping must be isolated in one helper and covered by tests.
5. Derive first-slice turn signals from typed local inputs, not brittle prose matching:
   - source message id/body as a `message` source ref;
   - mentions and selected teammates;
   - attachment/link/file-ref presence;
   - active run/guidance payload;
   - explicit risk signals only when already classified by existing risk/approval paths.
6. Compute `AttentionPlan`, then pass it through `buildChannelTeamRuntimePlan`.
7. Persist only `agent_relevance_card` evidence for `runtimePlan.observers`.
8. Do not call observer models yet unless a later explicit slice adds it.
9. Do not create visible `channel_messages`, approvals, runs, memories, tool requests, or
   protocol drafts.

Canonical turn identity:

- Use the triggering local-user `sourceMessage.id` as `turnId` for the first ObserverBus
  slice.
- Store the AI reply `pending.id` only as a source/link ref if needed. The team turn starts
  when the user message enters the channel; the AI reply is the Ling Agent's visible
  outcome for that turn.
- Web R4 must fetch Experts with this source-message turn id when rendering near the
  latest AI reply. Do not invent a second turn id based on the reply message.

First-slice privacy and scope:

- Relevance-card summaries are deterministic selection explanations, not model-generated
  notes.
- Do not store raw source message body, hidden prompt text, private thread content,
  provider secrets, or full logs in the evidence payload.
- Store source refs such as `{ type: "message", id: sourceMessage.id }`,
  attachment ids, link-preview ids, and file-ref ids so the folded UI can explain what was
  considered without leaking raw content.
- Read leases are not needed in R3a because no observer receives code/file contents or
  calls a model. Add scoped read leases only when later Specialist Notes actually inspect
  files.

Capability inference for R3a:

| `AiTeammate.roleKey` | Capability scopes | Default participation |
| --- | --- | --- |
| `product` | `product`, `planning`, `prioritization` | `specialist` |
| `architect` | `architecture`, `system_design`, `protocol` | `specialist` |
| `engineer` | `code`, `implementation`, `debugging` | `specialist` |
| `designer` | `design`, `ux`, `frontend` | `specialist` |
| `qa` | `testing`, `quality`, `regression` | `reviewer` |
| `security` | `security`, `risk`, `approval` | `reviewer` |
| `release` | `release`, `deploy`, `operations` | `reviewer` |
| `docs` | `docs`, `writing`, `knowledge` | `specialist` |
| `custom` | `general` | `observer` |

Keep this mapping private to `observer-bus.ts` or a sibling helper and cover it with unit
tests. Do not use prose keyword matching in random call sites.

Typed signal extraction for R3a:

| Source | Signal |
| --- | --- |
| Mentioned AI teammate | `user_mention` with that teammate id and message source ref. |
| Attachment present | `file` scope `attachment` with attachment source refs. |
| Workspace file refs present | `file` scopes `code`, `docs`, or `general` based on ref metadata when available. |
| Link previews present | `topic` scope `research` or `general` with link-preview source refs. |
| Explicit existing risk review decision | `risk` scope from trigger codes. |
| No structured signal | `default` scope `general`. |

This is not a content classifier. If a richer topic router is needed later, it should reuse
an existing retrieval/classification path with tests.

First-slice defaults:

| Choice | Default |
| --- | --- |
| Feature flag | Off by default. Tests enable it explicitly. |
| Turn mode | `quick_answer` for ordinary discussion; `safe_action` only when existing risk review is required; `deep_review` only when explicit channel setting or test input asks for it. |
| Candidate source | Effective channel teammates and effective council specialists only. |
| Observer model calls | Not allowed. |
| Evidence visibility | `internal`. Folded read-model may expose bounded summaries. |
| Failure behavior | Non-blocking for ordinary observers; no visible reply change. |

First-slice data flow:

```text
turn envelope
  -> observer bus feature gate
  -> effective channel teammates
  -> typed turn signals
  -> AttentionPlan
  -> TeamRuntimePlan
  -> relevance card evidence inputs
  -> channel_team_evidence_items (internal)
  -> folded experts projection (read-only)
```

R3a test fixture shape:

1. Start daemon with `channels.teamObserverBus: false`, send a message that gets a normal
   inline Ling reply, and assert zero `channel_team_evidence_items`.
2. Start daemon with `channels.teamObserverBus: true`, create one active channel teammate
   membership, send a message, and assert one bounded `agent_relevance_card` for the
   source-message turn id.
3. Seed an availability incident through `RunStore.createAvailabilityIncident`, send a
   turn, and assert offline/overloaded observers are skipped or marked unavailable without
   changing quality state.
4. Count visible `channel_messages` before and after the turn. The only new visible
   messages should be the user's message and Ling Agent's AI reply.
5. Force ObserverBus to throw through a test hook or malformed candidate and assert the
   reply still reaches the same ready/blocked status the old path would have produced.

Tests:

- feature flag off creates no team evidence;
- feature flag on creates bounded relevance evidence for eligible channel teammates;
- observer evidence never creates visible `channel_messages`;
- Ling Agent final reply body and status remain unchanged;
- unavailable observers are skipped when lifecycle state says offline/overloaded.
- ObserverBus failure does not block the main reply and does not create partial visible
  output.

Verification:

```text
corepack pnpm --filter @ling-stack/daemon build
corepack pnpm --filter @ling-stack/daemon test -- channel-workspace
corepack pnpm --filter @ling-stack/core test -- channel-team-attention
```

### R4 Detailed Plan - Experts And Metrics UI

Problem:

`ChannelTeamExpertsSummary` and `ChannelTeamMetricsPanel` exist but are not wired into the
live workspace/settings flow.

Actual code state:

- Endpoint handlers exist:
  - `packages/daemon/src/features/channels/team-experts.ts`;
  - `packages/daemon/src/features/channels/team-metrics.ts`.
- API client methods exist in `packages/api-client/src/endpoints/channels.ts`.
- Web components exist:
  - `apps/web/src/features/workspace/ChannelTeamExpertsSummary.tsx`;
  - `apps/web/src/features/workspace/ChannelTeamMetricsPanel.tsx`.
- Missing Web wiring:
  - `apps/web/src/api/channels.ts` does not expose wrapper functions;
  - `WorkspaceClientView` has no state/effect for experts or metrics;
  - settings side panel does not render `ChannelTeamMetricsPanel`;
  - main feed/operation-cell surface does not render `ChannelTeamExpertsSummary`.

Implementation:

1. Add `apps/web/src/api/channels.ts` wrappers around the already-existing daemon client
   methods:
   - `getChannelTeamExpertsProjection(cwd, channelId, turnId, options)`;
   - `getChannelTeamMetricsProjection(cwd, channelId, options)`.
2. Fetch folded Experts for the active channel/turn or operation cell, not for every
   historical message.
   - first implementation target: latest pending/ready AI reply turn in the active thread;
   - do not issue one request per historical message;
   - refresh after channel message send/stream completion and side-panel refresh.
3. Render one compact Experts activity row near the current operation cell or latest
   assistant turn.
   - If no operation cell hook is obvious, place it below the newest AI reply block as a
     single folded panel.
   - If this creates `WorkspaceClientView` bloat, extract a focused hook such as
     `useChannelTeamEvidence` instead of adding more raw effects to the large view file.
4. Expanded state shows:
   - agent display name;
   - participation/attention role;
   - evidence grade;
   - status;
   - bounded summary;
   - source refs.
5. Fetch Team Metrics in channel settings or a team diagnostics panel, not in the main
   feed.
   - first placement: channel side panel settings stack, below teammate management and
     above destructive channel management;
   - refresh with the side-panel refresh button;
   - render nothing when there is no selected channel.
6. Present metrics as health and routing explanations, not agent scores or rankings.

UI rules:

- Empty Experts data renders nothing.
- Loading state must be quiet and non-blocking.
- Expanded panel must not reveal hidden reasoning, raw private notes, raw logs, secrets,
  or private-thread content.
- Main chat remains clean; no per-agent message bubbles.

Tests:

- component or e2e with mock daemon Experts data renders compact row;
- empty response renders no row;
- expanded details show evidence grade/source refs;
- metrics panel renders reasons/health, not leaderboard copy.
- no request storm: test or code review should show one experts request per selected
  active turn, not per virtualized feed item.

Verification:

```text
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test
```

If no web unit test command exists for this package, use the existing targeted e2e command
for workspace/channel settings.

### R5 Detailed Plan - Availability Incident Ingestion

Problem:

Availability incident storage exists, but provider/runtime failures are not yet converted
into scheduling input.

Actual code state:

- `SqliteChannelTeamLifecycleStore` has `createAvailabilityIncident` and
  `createReliabilityIncident`.
- `RunStore` currently exposes `listReliabilityIncidents` and `listAvailabilityIncidents`,
  but not create methods, so daemon code cannot write incidents through the shared store
  contract.
- `provider-runtime-observations.ts` currently records context-window observations in
  process memory only; it does not persist team availability incidents.
- `deriveAgentLifecycleState` already keeps availability separate from quality.

Implementation:

Split R5 into two slices so R3 can land without a broad provider-error refactor.

R5a - store write surface:

1. Add `createAvailabilityIncident` to the relevant core store facet and `RunStore`.
2. Add the `SqliteRunStore` delegate to the existing `SqliteChannelTeamLifecycleStore`.
3. Add `createReliabilityIncident` only if a current caller needs it. Provider/runtime
   failure ingestion should use availability only.
4. Add tests that create and list availability incidents through `RunStore`, not the
   private SQLite lifecycle store.

R5b - runtime ingestion and routing:

1. Convert provider quota, rate limit, overload, timeout, network unavailable, readiness
   failure, and capability mismatch into `AvailabilityIncident`.
2. Never create `ReliabilityIncident` or lower `AgentQualityState` for provider/runtime
   failures.
3. Add a daemon mapper, preferably in `provider-runtime-observations.ts` or a sibling:
   - input: provider preset, optional teammate/agent id, error code/message, observed time;
   - output: `CreateAvailabilityIncidentInput | undefined`;
   - no direct raw string matching outside this mapper.
4. Assign TTLs by failure class:
   - timeout/slow: minutes;
   - quota/rate limit: provider reset if known, otherwise short TTL;
   - overload/offline/readiness failure: short circuit-breaker TTL;
   - capability mismatch: until config changes or check refresh.
5. Feed active availability state into AttentionPlan and TeamRuntimeGovernor.
   - for provider-level incidents, apply to teammates using the affected provider preset;
   - for agent-level incidents, apply only to that teammate;
   - for model-signature incidents, apply only when provider/model signature matches.

TTL defaults:

| Failure kind | State | TTL |
| --- | --- | --- |
| timeout | `slow` first, `overloaded` only after repeated recent timeouts | 5-15 minutes |
| quota/rate limit | `rate_limited` | provider reset if known, otherwise 15-30 minutes |
| provider overload / 5xx storm | `overloaded` | 5-15 minutes |
| network unavailable | `offline` or `overloaded` depending on scope | 2-10 minutes |
| capability mismatch | `offline` for the incompatible capability path | until config/check refresh, or short TTL if uncertain |

Do not deduplicate by deleting old rows in the first slice. Prefer listing active incidents
by TTL and letting repeated observations create auditable rows; later compaction can be a
separate maintenance task.

Mapper boundary:

- Use structured runner/provider error codes where they exist.
- If only an error message is available, normalize it in one tested mapper. Do not scatter
  provider-message substring checks across reply, readiness, and observer code.
- Unknown provider failures should produce `kind: "unknown"` with a short TTL only when
  the failure clearly affects provider availability. They must not lower agent quality.

Tests:

- `RunStore` exposes lifecycle incident create/list methods consistently.
- quota/rate-limit incident changes availability only;
- timeout/overload incident does not change quality state;
- expired incident no longer suppresses observer selection;
- capability mismatch excludes only the incompatible capability path;
- runtime governor skips offline/overloaded observers.

Verification:

```text
corepack pnpm --filter @ling-stack/core test -- channel-team-lifecycle
corepack pnpm --filter @ling-stack/daemon test -- provider
```

### R6 Detailed Plan - Authority Ledger Projection

Problem:

The design needs an audit view of authority decisions, but adding a second policy engine
would be wrong.

Actual code state:

- Approval requests already carry action type, risk, payload, status, run/workflow refs,
  and Risk Review metadata after R1.
- Runtime permission requests already create approval requests and can produce grants for
  continuations.
- Resource leases and runtime work units already record ownership, scope, expiry, and
  terminal release facts.
- `AuthorityLedgerEntry` exists in contracts as a basic fact shape, but there is no
  projection builder or endpoint.

Implementation:

1. Add a pure projection builder before adding storage:
   - preferred file: `packages/core/src/channel-team-authority-ledger.ts`;
   - input: approvals, resource leases, run interventions, work units/runs where needed;
   - output: `AuthorityLedgerEntry[]`.
2. Prefer a projection over existing approval requests, run interventions, permission
   requests, leases, and runtime work-unit state.
3. Extend `AuthorityLedgerEntry` only as needed for references, not policy:
   - `refType`;
   - `refId`;
   - optional `decisionRef`;
   - optional `riskReviewTriggerCodes`;
   - optional `policySnapshotRef` if an existing id exists.
4. Add a daemon read endpoint if UI/API needs it; it must not decide allow/deny.
   Suggested route: `GET /channels/:id/team-authority-ledger?cwd=...`.
5. Each entry references existing ids:
   - approval request id;
   - run id or work unit id;
   - permission request id;
   - risk review trigger code;
   - actor and timestamp.
6. If a durable table is eventually needed, make it append-only and populated from the
   same facts. Do not write policy outcomes from two places.

Projection mapping:

| Existing fact | Ledger authority | Ledger status |
| --- | --- | --- |
| pending approval request | `approval` | `requested` |
| approved approval request | `approval` | `granted` |
| denied approval request | `approval` | `denied` |
| active resource lease | `read` or `run` based on lease resource type | `granted` |
| released lease | `read` or `run` | `revoked` or `expired` based on release/expiry |
| run intervention pending | `run` | `requested` |
| runtime permission grant via approval | `run` or `approval` | `granted` |

The ledger may explain why a risky action was paused. It must never answer whether a new
action is allowed.

Tests:

- approval request projects into ledger entry;
- Risk Review trigger appears as reason/trigger code;
- denied approval projects as denied fact;
- ledger endpoint cannot alter approval state;
- ordinary push approval remains Approval Policy, not Risk Review, after R1.
- ledger output is deterministic for the same stored facts.

Verification:

```text
corepack pnpm --filter @ling-stack/daemon test -- approval
corepack pnpm --filter @ling-stack/core test
```

### R7 Detailed Plan - Pattern, Snapshot, Evaluation Maturity

Problem:

Pattern Store, Snapshot, and Evaluation Harness landed early. They must remain
non-authoritative until ObserverBus, Runtime Governor, lifecycle, and risk boundaries are
stable.

Actual code state:

- Pattern, snapshot, and evaluation storage already exists.
- Snapshot/evaluation APIs exist and are useful for inspection, but they should not be
  treated as replay-grade confidence gates yet.
- The current evaluation harness is synthetic. It cannot validate real ObserverBus
  behavior until R3 writes evidence and R5 availability state is routed through planning.

Implementation:

1. Add API/docs copy that Pattern Store is inspect-only in this version.
2. Keep snapshot restore explicit and reversible; no automatic live-state mutation.
3. Keep evaluation harness synthetic until it can replay real ObserverBus and Governor
   behavior.
4. Do not auto-promote patterns into memory, protocol, skills, or permissions.
5. Add maturity flags/status fields only if docs/API copy is not enough:
   - `synthetic`;
   - `shadow_only`;
   - `requires_review`;
   - `not_authoritative`.
6. Add tests around non-mutation boundaries before adding any richer replay behavior.

Do not add real historical replay in this remediation unless R3 and R5 have already
landed. Otherwise the harness will replay a fake runtime and create false confidence.

Tests:

- Pattern create/list does not change channel protocol automatically;
- Snapshot restore preview does not mutate live state;
- Evaluation run result does not alter routing or lifecycle state;
- memory/protocol/skill promotion remains candidate/review-gated.

Verification:

```text
corepack pnpm --filter @ling-stack/core test -- channel-team-pattern
corepack pnpm --filter @ling-stack/core test -- channel-team-snapshot
corepack pnpm --filter @ling-stack/daemon test -- channel-team
```

## Test Coverage Map

```text
R0 Baseline
  [TESTED] daemon full suite: 443/443
  [TESTED] private direct unsupported web_search blocks without fetch
  [TESTED] shared channel web_search public fallback still works

R1 Risk Review
  [TESTED] ordinary git push stays ordinary approval, not Risk Review
  [TESTED] protected branch push triggers Risk Review
  [TESTED] force push creates explicit Risk Review approval

R2 Runtime Governor
  [TESTED] quick answer budget
  [TESTED] deep review budget
  [TESTED] slow/offline/overloaded observer routing
  [TESTED] risk-review-required blocking constraint
  [TESTED] fallback provider capability and high-risk scope constraints

R3 ObserverBus
  [TESTED] feature flag off produces no evidence
  [TESTED] feature flag on persists relevance cards only
  [TESTED] source message id is the canonical team turn id
  [TESTED] observers cannot create visible channel messages

R4 UI
  [TESTED] compact Experts row is fetched for the latest visible assistant turn only
  [TESTED] expanded Experts details use bounded evidence summaries
  [TESTED] Team Metrics stays in settings and avoids ranking/leaderboard UI

R5 Availability
  [TESTED] RunStore create/list availability incident surface
  [TESTED] provider/runtime failures create availability incidents only
  [TESTED] availability can affect observer selection
  [TESTED] no quality downgrade from quota/network/overload

R6 Authority Ledger
  [TESTED] projection references existing approval/run/reply/lease facts
  [TESTED] projection cannot decide policy

R7 Maturity
  [TESTED] patterns/snapshots/evals carry shadow guardrails
  [TESTED] patterns/snapshots/evals do not create protocol drafts, memories, or skills
```

## Failure Modes To Cover

| Area | Failure | Required behavior |
| --- | --- | --- |
| R1 Risk Review | Ordinary push incorrectly labeled high-risk | Existing approval may still apply, but Team Risk Review is not shown. |
| R1 Risk Review | Force push misses trigger | Approval request includes Risk Review trigger and critical risk. |
| R2 Governor | Slow observer blocks quick answer | Observer becomes late note or is skipped. |
| R2 Governor | Fallback provider lacks capability | Fallback is denied with constraint, not silently used. |
| R3 ObserverBus | Observer writes visible message | Test fails; only evidence rows are allowed. |
| R3 ObserverBus | Feature flag off still writes evidence | No evidence should be created. |
| R4 UI | Experts panel exposes private/raw notes | UI must render folded summaries only. |
| R4 UI | Metrics become a leaderboard | Metrics copy and layout must frame health/reasons, not score competition. |
| R5a Store | Daemon bypasses `RunStore` to write incidents | Add shared store methods; do not reach into private SQLite sub-stores. |
| R5 Availability | Provider quota downgrades quality | Availability only; quality state unchanged. |
| R5 Availability | Expired outage still suppresses observer | TTL expiry must remove suppression. |
| R6 Ledger | Ledger starts deciding allow/deny | Ledger remains projection only. |
| R7 Harness | Synthetic eval enables aggressive routing | Results remain inspect-only until real replay gates exist. |

## Parallelization Strategy

Recommended split for multiple Codex worktrees:

| Lane | Slices | Modules touched | Depends on |
| --- | --- | --- | --- |
| A | R1 Risk Review | `packages/core`, `packages/daemon/src/features/runs`, daemon approval tests | R0 |
| B | R2 Runtime Governor | `packages/contracts`, `packages/core` | R0 |
| C | R5a Lifecycle write surface | `packages/core` | R0 |
| D | R3 ObserverBus | daemon channel turn loop, evidence store, core attention/governor | R2 + R5a |
| E | R5b Availability ingestion | `packages/core`, `packages/daemon/src/features/channels`, runtime readiness | R3 recommended |
| F | R4 UI wiring | `apps/web`, `packages/api-client`, existing daemon read APIs | R3 for live evidence; can mock before R3 |
| G | R6 Authority Ledger | `packages/contracts`, daemon runs/approvals APIs | R1 recommended |
| H | R7 Maturity hardening | core pattern/snapshot/eval modules, daemon docs/API notes | R2/R3 recommended |

Execution order:

1. Land R0 first.
2. R1, R2, and R5a can run in parallel after R0.
3. R3 should run after R2 and R5a so ObserverBus uses the real governor and shared
   lifecycle store surface.
4. R5b can run after R3, or immediately after R5a if it does not depend on ObserverBus
   candidate mapping yet.
5. R4 can start with mocked data, but live polish should wait for R3 evidence shape.
6. R6 can run after R1.
7. R7 should run last so maturity flags match the real runtime behavior.

Conflict flags:

- R2 and R3 both touch channel-team contracts/types. Merge R2 first or coordinate the
  `TeamRuntimePlan` shape explicitly.
- R1 and R6 both touch approval/run projection language. Keep R1 policy behavior and R6
  audit projection separate.
- R4 and R3 both define folded Experts UI fields. Prefer contracts/API schema from R3 if
  conflicts appear.

## Not In Scope For This Remediation

- Visible all-agent group chat by default.
- Observer model calls that can request tools or write visible messages.
- Automatic memory, protocol, permission, or skill promotion.
- Human Override turn-control UI.
- A new approval allow/deny engine.
- Raw hidden reasoning storage or display.
- Ranking agents by a single score.
- Downgrading model/agent quality because a provider had quota, timeout, overload, or
  network failure.

## Implementation Tasks

- [x] **R0 (P1)** - Restore daemon green baseline.
  - Files: `packages/daemon/src/features/web/web-evidence-service.ts`,
    `packages/daemon/src/features/teammates/direct-replies.ts`,
    `packages/daemon/test/channel-context-processing.test.mjs`,
    `packages/daemon/test/channel-workspace.test.mjs`,
    `docs/design/ling-web-tools.md`.
  - Verify: `corepack pnpm --filter @ling-stack/daemon test`.
- [x] **R1 (P1)** - Narrow Risk Review Gate and preserve existing Approval Policy.
  - Files: `packages/core/src/channel-team-risk-review.ts`,
    `packages/core/test/channel-team-risk-review.test.mjs`,
    `packages/daemon/test/approval-policy-run.test.mjs`.
  - Verify: core risk-review tests passed, 6/6; daemon force-push approval test passed, 1/1.
- [x] **R2 (P1)** - Add pure Team Runtime Governor and canonical runtime plan shape.
  - Files: `packages/contracts/src/channel-team.ts`, `packages/core/src/channel-team-types.ts`,
    `packages/core/src/channel-team-runtime-governor.ts`, core tests.
  - Verify: governor test suite passed, 6/6.
- [x] **R5a (P1)** - Expose lifecycle incident create methods through `RunStore`.
  - Files: `packages/core/src/run-types.ts`,
    `packages/core/src/storage/sqlite-run-store.ts`,
    `packages/core/test/channel-team-lifecycle-store.test.mjs`.
  - Verify: create/list availability incidents through `RunStore`, not private SQLite
    lifecycle store internals.
- [x] **R3 (P1)** - Wire feature-flagged ObserverBus into channel turn loop.
  - Files: `packages/daemon/src/config.ts`,
    `packages/daemon/src/server/router.ts`,
    `packages/daemon/src/features/channels/observer-bus.ts`,
    `packages/daemon/src/features/channels/ai-replies.ts`,
    `packages/daemon/test/channel-workspace.test.mjs`.
  - Verify: health flag exposure, feature flag on/off evidence tests, source-message
    `turnId`, unchanged reply status/body, and no visible observer messages.
- [x] **R4 (P2)** - Wire Experts and Metrics UI to live data.
  - Files: `apps/web/src/api/channels.ts`,
    `apps/web/src/features/workspace/WorkspaceClientView.tsx`,
    existing `ChannelTeamExpertsSummary.tsx`,
    existing `ChannelTeamMetricsPanel.tsx`,
    `apps/web/e2e/support/mock-daemon.ts`,
    targeted e2e/component tests.
  - Verify: web typecheck, no per-message request storm, compact Experts row, settings
    Team Metrics panel.
- [x] **R5b (P1)** - Ingest provider/runtime failures as availability incidents only.
  - Files: `packages/daemon/src/features/channels/provider-runtime-observations.ts`,
    `packages/daemon/src/features/channels/observer-bus.ts`,
    `packages/core/src/channel-team-lifecycle.ts`.
  - Verify: lifecycle store API tests, daemon provider observation tests, no quality
    downgrade from quota/network/overload.
- [x] **R6 (P2)** - Add Authority Ledger projection over existing authority facts.
  - Files: `packages/contracts/src/channel-team.ts`,
    `packages/core/src/channel-team-authority-ledger.ts`,
    daemon read endpoint if UI needs it,
    approval/run projection tests.
  - Verify: projection tests prove fact-only behavior and no approval state mutation.
- [x] **R7 (P2)** - Harden Pattern/Snapshot/Evaluation maturity boundaries.
  - Files: `packages/core/src/channel-team-types.ts`,
    `packages/contracts/src/channel-team.ts`,
    `packages/core/src/channel-team-snapshot-harness.ts`,
    SQLite pattern/snapshot mappers and stores,
    core/API pattern/snapshot/evaluation tests.
  - Verify: shadow guardrails plus no protocol, memory, or skill mutation.

## Unresolved Decisions

No product decision is currently blocked. The implementation direction is:

- R1 narrowed ordinary `git_push`; protected branch and force push still trigger Risk Review.
- R2 refactored `TeamRuntimePlan` to the fuller canonical shape and added a pure core governor.
- R3 is feature-flagged and evidence-only first.
- R4 renders Experts in the work surface and Team Metrics in settings/diagnostics.
- R5 keeps availability separate from quality.
- R6 remains a projection, not policy.
- R7 stays non-authoritative through explicit shadow guardrails.
