# Channel Team Operating System Task Plan - 2026-06-26

Status: historical planning checklist; superseded for current implementation by the
2026-06-27 remediation plan
Date: 2026-06-26

Source design:
[Channel Team Operating System](channel-team-operating-system.md).

Post-implementation audit:
[Channel Team Operating System Remediation Plan - 2026-06-27](channel-team-operating-system-remediation-plan-2026-06-27.md).

Current implementation rule:

- Do not execute the PR sequence in this file literally after the 2026-06-27 audit.
- Use the remediation plan as the current implementation source of truth.
- Keep this file only as the historical product-intent checklist and guardrail source.

This document is intentionally temporary. It captures the implementation checklist from
the 2026-06-26 design discussion so future implementation work does not drift from the
intended product and safety boundaries.

## Current Code And Design Baseline

Already present:

- Ling Agent Session is the product-level owner for channel turns.
- Channel messages persist turn input, thread placement, attachments, mentions, link
  previews, file refs, and reply status.
- Channel Context Processing defines per-consumer context views.
- Ling Memory has candidate, review, active, and quarantine concepts.
- Approval Policy and runtime approval requests gate risky side effects.
- Runtime Supervisor owns work units, attempts, recovery, and terminal state.
- Multi-Agent Orchestrator owns durable workflow steps, not free-form agent chat.
- Channel Auto Reply Router is already marked as an internal ordinary-answer module,
  not a product-level router.

Do not replace these systems. The Team Operating System sits above them.

## Implementation Principles

- Keep Ling Agent as the only main narrator and decision owner.
- Keep custom agent identity fixed unless the user changes it.
- Share summaries for collaboration, not raw private or sensitive content.
- Grant real code/file access through scoped read leases.
- Record notes automatically, but upgrade only through candidates, provisional rules, or
  review.
- Use existing Approval Policy for authority. Authority Ledger records facts only.
- Keep Experts UI compact in the main feed and detailed only when expanded.
- Do not implement Human Override in the first slice.

## Implementation Handoff For Another Codex

Use this document as the implementation checklist and
[Channel Team Operating System](channel-team-operating-system.md) as the product
contract.

The first implementation PR should be intentionally boring:

```text
contracts + inert persistence/read-model foundations
no automatic observer execution
no Ling Agent decision behavior change
no approval behavior change
no visible UI behavior change unless explicitly scoped
```

The first PR may add:

- shared contract types;
- migration-safe storage for channel team evidence or read models;
- mappers/parsers/tests for the new storage;
- feature-flagged or internal-only read APIs if needed for later slices;
- documentation updates that keep the MVP sequence current.

The first PR must not add:

- automatic multi-agent calls;
- visible all-agent chat;
- memory promotion;
- Provisional Rule behavior changes;
- Team Snapshot restore;
- Evaluation Harness;
- Human Override / turn controls;
- new approval allow/deny rules;
- Risk Review Gate enforcement before Approval Policy wiring is explicitly designed.

Recommended PR sequence:

| PR | Scope | Runtime behavior |
| --- | --- | --- |
| PR 1 | Contracts, storage skeleton, mappers, tests. | No behavior change. |
| PR 2 | Capability Manifest, runtime-only `AttentionPlan`, `AgentRelevanceCard` creation behind a flag. | No visible reply change. |
| PR 3 | `SpecialistNote` / Turn Evidence store and folded Experts read model. | Notes can be recorded, but do not affect Ling decisions. |
| PR 4 | Compact Experts UI projection. | Main feed shows one compact activity/folded panel only. |
| PR 5 | Agent Lifecycle with reliability/availability separation. | Affects scheduling weights only after evidence exists. |
| PR 6 | Risk Review Gate adapter into existing Approval Policy and approval requests. | High-risk actions may pause/block through existing approval/run flows. |
| PR 7 | Team Metrics settings view. | Inspectability only, no leaderboard. |
| PR 8 | Pattern Store / Provisional Rule v2. | Low-risk, TTL-bound behavior only. |
| PR 9 | Team Snapshot and Evaluation Harness v3. | Testable and reversible protocol changes. |

Implementation anchors:

| Area | Start here |
| --- | --- |
| Shared contracts | `packages/contracts/src/channels.ts`, or a new exported contracts file from `packages/contracts/src/index.ts`. |
| Teammate profile and fixed identity | `packages/contracts/src/teammates.ts`, `packages/daemon/src/features/teammates/schemas.ts`. |
| Channel turn envelope and Ling decision owner | `packages/daemon/src/features/channels/ling-agent-turn-envelope.ts`, `packages/daemon/src/features/channels/ling-agent-executor.ts`. |
| Context visibility and scoped sharing | `packages/daemon/src/features/channels/context-processing/types.ts`, `policies.ts`, `private-chat.ts`, `evidence.ts`. |
| Existing channel collaboration/protocol storage | `packages/core/src/storage/sqlite/channel-collaboration-store.ts`, `channel-protocol-store.ts`, `channel-collaboration-mappers.ts`, `channel-protocol-mappers.ts`. |
| SQLite migrations | `packages/core/src/storage/sqlite/migrations.ts`. |
| Approval action/risk contracts | `packages/contracts/src/approvals.ts`. |
| Approval runtime integration | `packages/daemon/src/features/runs/approvals.ts`, `packages/daemon/src/features/runs/action-classifier.ts`, `packages/core/src/approval-policy.ts`. |
| Runtime work units and events | `packages/daemon/src/runtime/supervisor.ts`, `packages/core/src/storage/sqlite/runtime-work-unit-store.ts`. |
| Provider/runtime observations | `packages/daemon/src/features/channels/provider-runtime-observations.ts`, `packages/daemon/src/runtime/runner-readiness.ts`. |
| Web/API client channel surfaces | `packages/api-client/src/endpoints/channels.ts`, `packages/daemon/src/features/channels/routes.ts`. |

Implementation guardrails:

- Do not put `SpecialistNote` into `runtime_events`; `runtime_events` are work-unit
  scoped execution events.
- Do not put raw notes directly into Ling Memory; only adopted or reviewed candidates may
  enter promotion flows.
- Do not let observers create visible `channel_messages`.
- Do not let `AttentionPlan` create approvals, runs, memory, or tool requests.
- Do not use majority voting to resolve conflicting notes.
- Do not treat quota, timeout, overload, or network failure as quality downgrade.
- Do not change `AiTeammate.roleKey`, prompt, provider, tools, or approval profile from
  observed channel behavior.
- Do not add a new approval policy engine. Risk Review Gate must map into existing
  Approval Policy and approval request/run intervention flows.

## First-Slice Default Decisions

Use these defaults unless a later design update explicitly changes them:

| Decision | First-slice default |
| --- | --- |
| `ChannelParticipationMode` auto-change | No permanent auto-change. Low-risk provisional changes may be proposed later, but not in PR 1. |
| Experts activity placement | Main feed gets one compact activity line or operation-cell header row; expanded details live in folded Experts/Evidence. |
| `SpecialistNote` persistence | Store in a channel evidence/read-model table, not `runtime_events`, not memory, not protocol drafts. |
| Pattern Store location | Channel protocol side first. Memory receives only reviewed or adopted candidates. |
| Turn Evidence retention | Default 30 days. Extend retained refs for adopted notes, approvals, memory candidates, or linked work artifacts. |
| Risk Review Gate first trigger set | Critical risk, destructive delete, reset-hard, force/protected push, deploy/production mutation, external send/account mutation, credential/provider secret/auth changes, runtime permission expansion, remote script execution, recursive permission mutation. |
| Agent Lifecycle UI | Not in the main chat. Show only in Team Metrics or agent settings. |
| Auto learning / Snapshot / Harness | Deferred but required for v2/v3. Do not implement before evidence and lifecycle foundations are stable. |
| First-slice contracts file | Prefer a new exported `packages/contracts/src/channel-team.ts` instead of expanding `channels.ts` further. Export it from `packages/contracts/src/index.ts`. |
| First-slice evidence table | Prefer one generic `channel_team_evidence_items` table for relevance cards, specialist notes, and risk signals before splitting into specialized tables. |
| Lifecycle incident storage | Add later as `channel_team_incidents` or equivalent only when PR 5 begins. Do not mix incidents into Turn Evidence. |

## Phase 0 - Contracts First

Goal: add shared types and documentation-only API shape without changing runtime behavior.

Candidate types:

```ts
type TurnMode =
  | "quick_answer"
  | "deep_review"
  | "safe_action"
  | "background_work";

type EvidenceGrade =
  | "inferred"
  | "observed"
  | "inspected"
  | "verified"
  | "reproduced";

type ChannelParticipationMode =
  | "observer"
  | "specialist"
  | "reviewer"
  | "executor"
  | "speaker"
  | "disabled";

type AgentQualityState =
  | "new"
  | "warming_up"
  | "active"
  | "trusted"
  | "watchlisted"
  | "degraded"
  | "quarantined"
  | "manual_only"
  | "retired";

type AgentAvailabilityState =
  | "healthy"
  | "slow"
  | "rate_limited"
  | "overloaded"
  | "offline"
  | "unknown";
```

Add contracts for:

- `AttentionPlan`
- `AgentObserverPlan`
- `TeamRuntimePlan`
- `AgentRelevanceCard`
- `SpecialistNote`
- `RiskReviewGate`
- `DissentSignal`
- `AgentConflict`
- `TeamFailureKind`
- `ModelSignature`
- `ReliabilityIncident`
- `AvailabilityIncident`
- `AuthorityLedgerEntry`

Acceptance:

- Types live in contracts/core surfaces, not Web-only files.
- No runtime selection behavior changes.
- Existing tests still pass.
- Provider/runtime failure contracts are separate from quality trust contracts.

## Phase 1 - Capability Manifest And Attention Plan

Goal: choose observer candidates from structured capability data, not brittle text rules.

Tasks:

- Add optional teammate capability manifest fields.
- Build runtime-only `AttentionPlan` for one channel turn.
- Use explicit signals, typed turn signals, capability manifests, historical stubs, and
  risk signals.
- Keep embedding/topic recall out of the MVP unless an existing retrieval path can be
  reused safely.

Acceptance:

- `AttentionPlan` is evidence only.
- It does not create messages, notes, runs, approvals, or memory.
- It can explain why each observer candidate was selected.

## Phase 2 - ObserverBus And Relevance Cards

Goal: let selected agents produce cheap, structured relevance signals.

Tasks:

- Add `AgentRelevanceCard` creation for L0 observers.
- Support status values: pending, completed, skipped, timeout, unavailable.
- Store enough evidence to populate folded Experts UI later.

Acceptance:

- Observers cannot write visible channel messages.
- Observers cannot request tools directly.
- Failure of an ordinary observer does not block Ling Agent reply.

## Phase 3 - Specialist Notes

Goal: add folded expert notes with evidence grade and source refs.

Tasks:

- Add `SpecialistNote` storage or a narrowly scoped channel evidence table.
- Record note summary, concerns, recommendations, confidence, source refs, and evidence
  grade.
- Support late notes after the main reply.

Acceptance:

- Store summaries and source refs by default, not raw hidden reasoning.
- Notes do not enter memory automatically.
- Notes do not grant permissions.

## Phase 4 - Experts UI

Goal: show multi-agent work without polluting the main transcript.

Main feed running state:

```text
[Experts] 3 active, 1 done, 1 delayed
```

Final folded state:

```text
[Frontend Experience][QA][Security] +5 Experts
```

Expanded panel:

- timeline;
- status per agent;
- note summary;
- evidence grade;
- inspected refs;
- failure reason if unavailable.

Acceptance:

- Main feed remains Ling Agent centered.
- No first-level visible message per observer.
- Completed state folds automatically.

## Phase 5 - Team Runtime Governor

Goal: centralize budget, timeout, fallback, and late-note policy.

Tasks:

- Compute `TeamRuntimePlan` from Turn Mode, Attention Plan, provider health, agent
  health, risk level, and channel settings.
- Enforce max observer count.
- Enforce per-agent timeout.
- Decide whether late notes are allowed.
- Decide whether fallback provider is allowed.

Acceptance:

- Agents do not choose independent timeout and fallback behavior.
- Low-priority observers cannot block main reply.
- Required Risk Review Gate can block high-risk action.

## Phase 6 - Risk Review Gate

Goal: preserve a contrary risk view before dangerous side effects without creating a
second approval system or a product-level dissent panel.

MVP required triggers are intentionally narrow:

- `risk === "critical"`;
- deploy or production/environment mutation;
- external sends or account mutations;
- credential, token, keychain, provider-secret, auth, or provider configuration changes;
- runtime permission expansion for `write_scope`, `runner_capability`, or unavailable
  MCP/tool capabilities;
- force push, protected-branch push, reset-hard, destructive delete, disk mutation,
  recursive permission change, external mutation, or remote script execution risk flags.

Acceptance:

- Risk Review Gate is not triggered for every ordinary disagreement.
- Internal `DissentSignal` remains available as structured contrary evidence.
- High-risk review unavailable blocks or asks for explicit confirmation.
- Review result maps into existing approval/run intervention flows.

## Phase 7 - Authority Ledger

Goal: record authority facts without creating a second policy engine.

Ledger records:

- authority request id;
- source turn id;
- agent id;
- authority type: read lease, reply lease, run lease, approval, external action;
- scope;
- policy decision ref;
- approval id when present;
- expiry;
- terminal status;
- side effects and artifact refs.

Acceptance:

- Approval Policy remains the rule layer.
- Authority Ledger never contains new allow/deny rules.
- Ledger references existing approval and runtime records.

## Phase 8 - Resilience Layer

Goal: handle partial multi-agent failure explicitly without confusing availability
failure with agent quality.

Failure kinds:

- provider quota exhausted;
- provider overloaded;
- network unavailable;
- model capability mismatch;
- context overflow;
- agent timeout;
- tool denied;
- lease expired;
- partial failure.

Add:

- short-lived `AvailabilityIncident`;
- scoped `AgentAvailabilityState`;
- provider/model circuit-breaker state;
- fallback-provider eligibility checks;
- late-note behavior for slow providers.

Acceptance:

- Ordinary observer failure folds into Experts.
- Required risk-review failure follows risk-specific behavior.
- Quota, timeout, overload, and network failures do not create memory or protocol
  candidates.
- Provider/runtime failures never downgrade agent quality trust.
- Availability incidents expire by TTL and only affect short-lived routing.
- Fallback providers must satisfy the required capability and risk scope.

## Phase 8.5 - Agent Lifecycle And Reliability Decay

Goal: prevent weak or misleading models from dominating collaboration while allowing
models, prompts, and agents to recover after updates.

Add:

- scoped `AgentQualityState`;
- `ModelSignature` with provider, model, model version, prompt version, and capability
  hash where available;
- `ReliabilityIncident` with evidence refs, severity, capability scope, expiry, and
  recovery requirement;
- quality-state derivation from active incidents instead of permanent labels;
- model-signature change handling that re-warms the affected scope;
- manual-only and quarantine transitions.

Quality downgrade signals:

- verified contradiction;
- fabricated source;
- unsafe or permission-expanding advice;
- misleading high-risk guidance;
- repeated low-value notes in the same scope;
- explicit user feedback that a note was misleading or harmful.

Decay policy:

- low-value notes decay in 7-14 days;
- verified contradictions decay in 14-30 days;
- unsafe or misleading high-risk guidance decays in 30-90 days and requires recovery
  evidence before high-risk eligibility;
- privacy, permission, or security boundary violations do not automatically return to
  trusted.

Acceptance:

- Trust is scoped by capability, not global.
- `trusted` for one scope never implies `trusted` for Risk Review Gate.
- `new`, `warming_up`, `watchlisted`, and `degraded` states cannot be sole
  reviewers for high-risk actions.
- Majority voting cannot outrank higher-grade evidence from a scoped-trusted reviewer.
- Model or prompt version changes reduce old incident weight and move affected scope to
  warm-up, rather than fully clearing high-risk history.

## Phase 9 - Learning Without Pollution

Status: v2 maturity feature. Do not treat as an MVP launch blocker.

Goal: record useful patterns without silently mutating long-term authority.

Prerequisites:

- Turn Evidence retention and expiry are stable;
- `SpecialistNote` adoption/rejection is measurable;
- Agent Lifecycle and reliability/availability separation are working;
- Team Metrics can explain why a pattern is proposed.

Add:

- Turn Evidence Store;
- Pattern Store;
- Promotion Inbox integration;
- Provisional Rule with TTL;
- Decay/forgetting jobs;
- Shadow Protocol evidence.

Acceptance:

- Raw notes can be recorded automatically.
- Pattern candidates can be generated automatically.
- Low-risk provisional rules can run with TTL.
- Long-term memory/protocol/skill changes require review or explicit confirmation.
- Authority-changing behavior never auto-promotes.

## Phase 10 - Team Metrics And Snapshots

Status: Team Metrics belongs in v2. Snapshots belong in v3 unless the state shape has
already stabilized.

Goal: make the team inspectable without creating a leaderboard, then make mature team
state diffable and restorable.

Metrics UI location:

```text
Channel Settings -> Metrics
```

Sections:

- Team Health Summary;
- Agent Performance;
- Attention Graph Insights;
- Risk Review;
- Learning Queue.

Snapshot UI location:

```text
Channel Settings -> Team -> Snapshots
```

Acceptance:

- Metrics show health and concrete reasons, not a single agent score.
- Snapshot diff can explain protocol/attention changes.
- Restore is explicit and auditable.
- Snapshot is not implemented before roster, lifecycle, provisional rules, and risk
  settings have stable storage shapes.

## Phase 11 - Evaluation Harness

Status: v3 maturity feature. Required before protocol rules become aggressive, but not
required for MVP launch.

Goal: replay protocol changes before they affect live channel behavior.

Prerequisites:

- enough historical turns exist for meaningful replay;
- Risk Review Gate, Team Metrics, and provisional rules have stable semantics;
- evaluation expectations are explicit enough to avoid false confidence.

Start with developer/admin tooling:

```text
Protocol -> Test Rules -> Run against last 50 turns
```

Test cases:

- destructive input must trigger Risk Review Gate;
- ordinary quick question must not summon excessive observers;
- active run follow-up must route to follow-up or interrupt handling;
- high-risk review unavailable must not proceed silently.

Acceptance:

- Harness can run synthetic cases and recent historical turns.
- Shadow Protocol candidates include replay evidence.
- Protocol changes that affect live routing should eventually pass harness replay before
  promotion.

## Deferred: Turn Controls / Human Override

Do not implement in MVP.

Record only as future evaluation:

```text
Auto
Quick
Deep Review
Safe Mode
No Experts
```

These would be per-turn preferences, not permission grants. They should wait until
Team Runtime Governor, Risk Review Gate, and Experts UI are stable.

## Old Design Handling

Do not delete historical docs unless there is a broken or actively misleading link.

For old documents:

- mark as historical or superseded where needed;
- add a pointer to `channel-team-operating-system.md`;
- keep lower-level docs such as auto-reply router and collaboration cards as module or
  historical context;
- prefer new canonical links from Ling Agent Session and Channel Workspace.

## Verification Checklist

Before implementation PRs:

- `git diff --check`
- contract exports compile if new files are added under `packages/contracts/src`;
- docs link grep for new files
- targeted TypeScript build for contracts/core if types are added
- daemon tests for any new store/routes
- Web typecheck and targeted e2e for Experts UI
- approval-policy/run tests for Risk Review Gate and Authority Ledger wiring

## Remaining Implementation Choices

These are not product-direction questions. They are local code-shape choices to verify
against the current repo before each PR.

Default choices:

- use `packages/contracts/src/channel-team.ts` for new shared team operating contracts;
- export the file from `packages/contracts/src/index.ts`;
- use `channel_team_evidence_items` as the first channel evidence table unless existing
  store patterns strongly favor a narrower name;
- use `provider-runtime-observations` first for provider/runtime availability signals;
- use runner readiness only for lower-level runner capability and startup health;
- expanded Experts panel should show summary, evidence grade, source refs, status, and
  expiry; it should not show hidden reasoning, raw private content, or full logs by
  default.

Only revisit these defaults if local code evidence shows they conflict with existing
module boundaries or migration patterns.
