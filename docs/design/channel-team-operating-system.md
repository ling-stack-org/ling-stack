# Channel Team Operating System

Status: active design contract; R0-R7 foundations are implemented, while observer model
calls, automatic promotion, snapshot restore, and historical replay remain unshipped
Date: 2026-06-26
Updated: 2026-08-03

Related docs:

- [Ling Agent Session Control Plane](ling-agent-session.md)
- [Channel Context Processing Layer](channel-context-processing-layer.md)
- [Conversation Surface Contract](./conversation-surface-contract.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)
- [Memory Health And Multi-Agent Memory Fan-In](memory-health-and-fanin.md)
- [Ling Memory v1](ling-memory-v1.md)
- [AI Teammates and Skills](ai-teammates-and-skills.md)
- [AI Teammate Private Workspace](ai-teammate-private-workspace.md)
- [Approval Policy](approval-policy.md)
- [Runtime Supervisor](runtime-supervisor.md)

## Summary

Ling channels should become trainable, auditable team workspaces without turning the
main conversation into a multi-agent chat room.

The product invariant is:

```text
Single narrator, many observers.
One coordinator, many specialists.
Visible simplicity, folded auditability.
```

Ling Agent remains the only product-level coordinator for a channel turn. Custom
teammates can observe, inspect, contribute risk-review signals, advise, and be selected
for visible replies or workflow execution, but they do not independently compete to
answer every channel message.

This design adds a team operating layer above the current Ling Agent Session turn loop:

```text
ChannelMessageTurn
  -> TurnEnvelope
  -> Context Processing Layer
  -> Turn Mode
  -> Agent Attention Graph
  -> Team Runtime Governor
  -> ObserverBus
      -> Relevance Cards
      -> Specialist Notes
      -> Watcher Signals
      -> Risk Review Gate
          -> internal DissentSignal
  -> Ling Agent Session Decision
  -> Authority Ledger / Approval Gate / Run State Machine
  -> Transcript Projection
      -> Ling Agent main reply
      -> running Experts activity
      -> folded Experts / Evidence
```

The design rule is:

```text
Observe automatically.
Speak cautiously.
Record automatically.
Promote through review.
Adapt participation.
Never drift identity.
```

## Current Implementation Boundary

The current mainline includes channel-team contracts, durable evidence and lifecycle
stores, the feature-gated ObserverBus integration, narrow Risk Review mapping, authority
projection, metrics, and shadow pattern/snapshot/evaluation foundations. Git history and
the current tests preserve the former remediation evidence.

The following capabilities are not implied by those foundations:

- observers do not yet perform general model-backed code or file review automatically;
- memory, protocol, and skill promotion still require their existing review paths;
- snapshot restore/apply and real historical evaluation replay are not shipped;
- Human Override and broad turn-control UI remain deferred.

Until those capabilities are explicitly implemented, snapshot and evaluation data is
shadow evidence only and cannot change live protocol, identity, permission, or approval
behavior.

## Non-Goals

- No visible all-agent group chat by default.
- No broadcast where every teammate decides independently whether to reply.
- No hidden agent-to-agent prompt loop that bypasses Ling Agent Session.
- No automatic mutation of teammate identity, provider, tools, approval profile, or
  permissions from repeated notes.
- No memory, protocol, or skill promotion that grants execution authority.
- No second approval system. Approval policy remains the authority rule layer.
- No product-level dissent panel, expert argument thread, or second reviewer chat.
  The contrary view is an internal `DissentSignal` used only by high-risk review gates.
- No user-facing metrics leaderboard that encourages optimizing agent scores over
  useful collaboration.
- No broad code or private-thread access for every observer by default.
- No Human Override or full turn-control UI in the first implementation. This remains a
  future evaluation item.

## Existing Ownership Boundaries

This design is an orchestration and read-model layer. It does not replace existing
owners:

| Existing owner | Keeps owning |
| --- | --- |
| `ChannelMessageTurn` / channel messages | Durable user input, thread placement, attachments, links, file refs, pending state, replay, and audit source. |
| Ling Agent Session | One product-level turn decision: answer, clarify, workflow, direct workflow, visible multi-reply, active-session follow-up, approval response, or no-reply. |
| Channel Context Processing Layer | What each model or teammate is allowed and expected to see for a turn. |
| Approval Policy | Which actions are allowed, denied, or require approval. |
| Runtime Supervisor | Work units, attempts, heartbeats, terminal state, recovery, and cancellation. |
| Memory Review Policy | Candidate, active, manual-review, and quarantine state for memory. |
| Multi-Agent Orchestrator | Durable workflow steps and run progression. |

The Team Operating System only decides who should observe, how signals are summarized,
how late signals affect the turn, and which candidate learning items should be proposed.

## Agent Identity And Participation

Ling ships with a protected Ling Agent. Other teammates are user-created or imported
workspace agents. Their profile role is fixed unless the user edits it.

Do not let channel history silently rewrite a teammate's identity.

Use three separate concepts:

| Layer | Meaning | Can auto-change? |
| --- | --- | --- |
| Agent Profile Role | The user-defined durable identity and role definition of the teammate. | No. Only explicit user/profile update flows can change it. |
| Channel Participation Mode | How this teammate participates in one channel. | Only through a candidate or low-risk provisional rule. |
| Turn Attention Role | Why this teammate was selected for this turn. | Yes, per turn. It is evidence, not identity. |

Recommended `ChannelParticipationMode` values:

```ts
type ChannelParticipationMode =
  | "observer"
  | "specialist"
  | "reviewer"
  | "executor"
  | "speaker"
  | "disabled";
```

Semantics:

| Mode | Meaning |
| --- | --- |
| `observer` | Can be considered for silent notes. No visible reply by default. |
| `specialist` | More likely to be selected for domain-specific notes. |
| `reviewer` | Eligible for Risk Review Gate signals or quality review. |
| `executor` | Eligible to be assigned workflow/run work after policy gates. |
| `speaker` | Can be selected for visible reply when Ling Agent grants a reply lease. |
| `disabled` | Not selected for this channel unless explicitly mentioned by the user. |

Automatic changes to participation should be proposed as candidates first. Low-risk,
reversible changes may run as provisional rules with expiry, but they must not grant
tools, approvals, provider access, or execution authority.

## Turn Mode

Every turn should be classified into a mode before the team layer spends model budget.

```ts
type TurnMode =
  | "quick_answer"
  | "deep_review"
  | "safe_action"
  | "background_work";
```

| Mode | Behavior |
| --- | --- |
| `quick_answer` | Ling Agent answers with zero or few observers. Strict latency budget. |
| `deep_review` | Multiple observers can inspect context and produce folded notes. |
| `safe_action` | Risk Review Gate is required before risky action proceeds. |
| `background_work` | Execution proceeds through workflow/run surfaces; chat shows progress. |

Turn Mode controls observer count, latency budget, read leases, fallback behavior, and
whether late notes are allowed.

## Agent Attention Graph

The Attention Graph chooses candidate observers. It must not rely on brittle phrase
matching as the primary design.

Inputs:

| Signal group | Examples |
| --- | --- |
| Explicit signals | User mentions, selected teammate chips, active run owner, workflow step assignee. |
| Typed turn signals | Attachment kind, file refs, code blocks, paths, command-like input, target type, tool intent. |
| Capability manifests | Structured teammate capabilities, default access, lease types, disallowed actions. |
| Historical graph | Past adoption rate, successful notes, failure rate, late corrections, provider health. |
| Risk and policy signals | Destructive action, credential, deploy, external send, database mutation, permission expansion. |
| Semantic recall | Embedding or topic recall for candidate discovery only. It never grants authority. |

Output:

```ts
interface AttentionPlan {
  readonly turnId: string;
  readonly primaryOwner: "ling_agent";
  readonly observers: readonly AgentObserverPlan[];
  readonly watchers: readonly WatcherPlan[];
  readonly riskReviewRequired: boolean;
  readonly maxLatencyMs: number;
  readonly tokenBudget: number;
  readonly reason: string;
}

interface AgentObserverPlan {
  readonly agentId: string;
  readonly attentionRole: string;
  readonly requestedDepth: "relevance" | "context_note" | "scoped_read" | "private_review";
  readonly priority: "low" | "normal" | "high" | "required";
  readonly reason: string;
}
```

Attention Graph output is routing evidence. It does not create visible messages, grant
read access, start workflows, or change memory.

## ObserverBus

The ObserverBus lets teammates and watchers contribute structured signals without
writing the main conversation.

Default access ladder:

| Level | Name | Access |
| --- | --- | --- |
| L0 | Relevance Card | TurnEnvelope metadata and lightweight channel state. |
| L1 | Context Pack | Selected summaries, current Ling Agent summary, active work state, safe source refs. |
| L2 | Scoped Read Lease | Specific files, directories, log snippets, or artifacts approved for read. |
| L3 | Private Review Turn | A bounded internal review turn that can use read-only tools under lease. |
| L4 | Execution / Mutation | Only through Ling Agent decision, workflow/run, approval policy, and run state machine. |

Observers may produce:

```ts
type ObserverSignal =
  | AgentRelevanceCard
  | SpecialistNote
  | WatcherSignal
  | DissentSignal;
```

Observers may not:

- create visible `ai_reply` messages without a reply lease;
- start a run or workflow;
- request broad tools outside the normal permission request flow;
- mutate memory, protocol, teammate profile, provider settings, or approval policy;
- read private teammate threads or raw sensitive artifacts without a scoped lease.

## Specialist Notes

Specialist Notes are folded team evidence. They are similar to an expert panel's internal
discussion, but they must be structured and auditable.

```ts
type EvidenceGrade =
  | "inferred"
  | "observed"
  | "inspected"
  | "verified"
  | "reproduced";

interface SpecialistNote {
  readonly id: string;
  readonly turnId: string;
  readonly agentId: string;
  readonly visibility: "internal" | "folded_evidence" | "promoted";
  readonly evidenceGrade: EvidenceGrade;
  readonly summary: string;
  readonly concerns: readonly string[];
  readonly recommendations: readonly string[];
  readonly confidence: number;
  readonly sourceRefs: readonly EvidenceRef[];
  readonly createdAt: string;
}
```

Evidence grades:

| Grade | Meaning |
| --- | --- |
| `inferred` | Based only on the user message or visible turn metadata. |
| `observed` | Based on a provided Context Pack summary. |
| `inspected` | Read code, files, logs, artifacts, or relevant evidence under a lease. |
| `verified` | Ran a command, test, or deterministic check. |
| `reproduced` | Reproduced the user-visible bug or failure. |

Ling Agent should prefer higher-grade notes when resolving conflicts. A confident
inferred note should not outrank a verified note unless the verified note is stale or out
of scope.

## Risk Review Gate

Risk Review Gate is a narrow high-risk action gate, not a product-level dissent panel.
It keeps the contrary view without turning the channel into a reviewer chat.

The product object is `RiskReviewGate`. The internal evidence object is
`DissentSignal`.

```ts
interface RiskReviewGate {
  readonly turnId: string;
  readonly required: boolean;
  readonly trigger:
    | "critical_approval_risk"
    | "destructive_action"
    | "credential_or_secret"
    | "external_side_effect"
    | "production_or_deploy"
    | "permission_expansion";
  readonly status: "pending" | "completed" | "unavailable" | "waived";
  readonly severity: "high" | "critical";
  readonly reviewerAgentId?: string;
  readonly dissentSignal?: DissentSignal;
  readonly approvalRequestId?: string;
  readonly resolution?: "accepted" | "safer_plan" | "user_confirmed" | "blocked";
}

interface DissentSignal {
  readonly summary: string;
  readonly worstCase: string;
  readonly saferAlternative?: string;
  readonly evidenceGrade: EvidenceGrade;
  readonly sourceRefs: readonly EvidenceRef[];
}
```

MVP triggers are intentionally narrow and should map onto the existing
`ApprovalActionType`, approval risk, runtime permission request, and action-classifier
risk flags:

- `risk === "critical"`;
- deploy or production/environment mutation;
- external sends or account mutations such as email, issue/PR comments, labels,
  payments, or settings changes;
- credential, token, keychain, provider-secret, auth, or provider configuration changes;
- runtime permission expansion for `write_scope`, `runner_capability`, or unavailable
  MCP/tool capabilities;
- force push, protected-branch push, reset-hard, destructive delete, disk mutation,
  recursive permission change, external mutation, or remote script execution risk flags.

Do not trigger Risk Review Gate for every ordinary disagreement. Agent disagreement
should first become a conflict object. Escalate to Risk Review Gate only when the
conflict touches irreversible work, external side effects, or permission expansion.

If required risk review is unavailable:

| Risk | Behavior |
| --- | --- |
| High | Pause and ask for a provider/agent switch, wait, safer plan, or explicit confirmation. |
| Critical | Block until review, confirmation, or a safer plan exists. |

## Conflict Resolver

Multiple notes can disagree. The transcript should not become a pile of competing
opinions. Ling should create a conflict object and resolve it into one coordinator
decision.

```ts
interface AgentConflict {
  readonly turnId: string;
  readonly topic: string;
  readonly positions: readonly {
    readonly agentId: string;
    readonly claim: string;
    readonly evidenceGrade: EvidenceGrade;
    readonly sourceRefs: readonly EvidenceRef[];
  }[];
  readonly resolution:
    | "accept_position"
    | "ask_clarification"
    | "defer"
    | "open_risk_review"
    | "run_verification";
  readonly resolvedBy: "ling_agent";
  readonly reason: string;
}
```

Conflict resolution is evidence for later attention weighting, but it does not directly
change teammate identity or memory.

## Team Runtime Governor

The Team Runtime Governor is the central budget and resilience manager for one turn.
Individual agents should not set their own timeouts, fallback models, or deep-read
behavior independently.

```ts
interface TeamRuntimePlan {
  readonly turnMode: TurnMode;
  readonly maxObservers: number;
  readonly totalTimeoutMs: number;
  readonly perAgentTimeoutMs: number;
  readonly allowLateNotes: boolean;
  readonly allowFallbackProvider: boolean;
  readonly maxReadLeases: number;
  readonly budgetClass: "low" | "normal" | "high";
}
```

Inputs:

- Turn Mode;
- Attention Plan;
- provider health;
- agent health;
- risk level;
- channel budget settings;
- active run/session state.

Rules:

- Low-priority observers must not block the main reply.
- Required Risk Review Gate can block high-risk actions.
- Fallback providers must satisfy required capability. Do not fallback from a
  tool-capable/code-capable model to a model that cannot perform the required review.
- Context overflow retries must compact context, not repeat the same oversized prompt.
- Quota-exhausted providers should enter circuit-breaker state instead of repeated retry.

## Resilience Layer

Multi-agent systems fail partially. Ling should model those failures explicitly.

```ts
type TeamFailureKind =
  | "provider_quota_exhausted"
  | "provider_overloaded"
  | "network_unavailable"
  | "model_capability_mismatch"
  | "context_overflow"
  | "agent_timeout"
  | "tool_denied"
  | "lease_expired"
  | "partial_failure";
```

Principles:

- Ordinary observer failure does not block the Ling Agent reply.
- Required risk-review failure can block high-risk action.
- Failures go to Experts, Evidence, and health telemetry, not memory or protocol.
- Recovered fallbacks should be visible in folded evidence.
- Stack traces and raw provider errors stay in audit/debug details, not the main reply.

## Reliability Is Not Availability

Do not punish an agent for infrastructure failure.

Hard rule:

```text
Provider/runtime failure must never downgrade agent quality trust.
It can only affect short-lived availability routing.
Quality downgrade requires validated misleading, unsafe, or contradicted output.
```

Separate three concepts:

| Layer | Meaning | Affected by |
| --- | --- | --- |
| Agent Reliability | Whether this agent tends to produce useful, grounded work in a capability scope. | Adopted notes, contradicted notes, unsafe suggestions, user feedback, verified evidence. |
| Model Reliability | Whether this model signature is reliable for a capability scope. | Model output quality, model version, prompt version, capability set, observed task fit. |
| Provider Availability | Whether this provider/model can answer right now. | Quota, network, overload, latency, context overflow, tool outage. |

Use scoped quality state and short-lived availability state:

```ts
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

type CapabilityScope =
  | "frontend"
  | "backend"
  | "security"
  | "code_review"
  | "product"
  | "writing"
  | "risk_review"
  | "workflow_execution";
```

Reliability is scoped, not global:

```text
trusted for writing does not imply trusted for security.
trusted for frontend does not imply trusted for database work.
trusted for cheap brainstorming does not imply eligible for Risk Review Gate.
```

Scheduling consequences:

| State | Behavior |
| --- | --- |
| `new` / `warming_up` | Can observe and produce low-weight notes. Cannot be sole reviewer for high-risk actions. |
| `active` | Normal observer candidate. Notes require source refs for meaningful adoption. |
| `trusted` | Preferred for matching capability scope. Eligible for high-risk review only in trusted scope. |
| `watchlisted` | Early warning state. Can observe, but notes require stronger evidence before adoption. |
| `degraded` | Reduced-quality state from active incidents. Can produce low-weight notes, but cannot drive main decisions or high-risk review. |
| `quarantined` | No automatic scheduling. User can manually inspect or re-enable through review. |
| `manual_only` | Only runs when explicitly selected. |
| `retired` | Disabled for automatic participation. |

Availability consequences:

| State | Behavior |
| --- | --- |
| `slow` | Allow late notes when the runtime plan permits. Do not block main reply. |
| `rate_limited` / `overloaded` | Skip for the current turn or try an eligible fallback provider. Do not reduce quality trust. |
| `offline` | Do not schedule for the current turn. Record availability telemetry with TTL. |

Quality downgrade signals must be content-based:

- repeated high-confidence claims contradicted by verified evidence;
- missing or fabricated source refs;
- unsafe or permission-expanding advice;
- misleading guidance adopted by Ling Agent and later corrected;
- repeated low-value notes in the same capability scope;
- user marks the note as misleading or harmful.

Availability-only signals must not change quality trust:

- quota exhausted;
- network unavailable;
- provider overloaded;
- model timeout;
- context overflow;
- tool or MCP unavailable;
- fallback provider unavailable.

### Decaying Reliability Incidents

Quality state should be derived from reliability incidents, not stored as a permanent
label.

```ts
interface ModelSignature {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelVersion?: string;
  readonly promptVersion?: string;
  readonly capabilitySetHash?: string;
}

interface ReliabilityIncident {
  readonly agentId: string;
  readonly modelSignature: ModelSignature;
  readonly capabilityScope: CapabilityScope;
  readonly type:
    | "hallucination"
    | "unsafe_advice"
    | "contradicted_by_evidence"
    | "fabricated_source"
    | "low_value"
    | "policy_violation";
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly evidenceGrade: EvidenceGrade;
  readonly sourceRefs: readonly EvidenceRef[];
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly recoveryRequired?: boolean;
}

interface AvailabilityIncident {
  readonly agentId: string;
  readonly modelSignature: ModelSignature;
  readonly kind: TeamFailureKind;
  readonly createdAt: string;
  readonly expiresAt: string;
}
```

Recommended decay:

| Incident | Suggested behavior |
| --- | --- |
| Availability failure | Short TTL from minutes to hours. No quality impact. |
| Low-value or vague note | Decay in 7-14 days. |
| Verified contradiction | Decay in 14-30 days. |
| Unsafe advice or misleading high-risk guidance | Decay in 30-90 days; recovery evidence required for high-risk eligibility. |
| Privacy, permission, or security boundary violation | No automatic return to trusted. Requires review or strong recovery evidence. |

When `ModelSignature` changes:

- do not fully erase old incidents;
- reduce old incident weight for the affected model signature;
- move the affected capability scope back to `warming_up`;
- require fresh verified recovery evidence before restoring high-risk review eligibility.

Conflict resolution must not use majority voting. A cluster of weak or low-evidence notes
must not outrank one verified, scoped-trusted note.

## Late Notes And Correction Trust Policy

Different models have different latency. Ling should not wait forever for slow notes.

Late notes are allowed when the runtime plan enables them:

```text
main reply completes
slow note arrives
  -> low: fold into Experts only
  -> medium: Ling Agent adds a visible caution
  -> high: pause current run or ask for confirmation
  -> critical: block continuing side effects and propose rollback or review
```

Correction Trust Policy is not an authority system. It never grants permissions.
It maps late evidence into existing mechanisms:

- folded evidence;
- visible correction;
- run intervention;
- approval request;
- rollback proposal;
- blocked work state.

## Authority Ledger

Approval Policy remains the rule layer. Authority Ledger is the fact layer.

| Layer | Owns |
| --- | --- |
| Approval Policy | What is allowed, denied, or approval-gated. |
| Authority Ledger | What was requested, granted, denied, expired, used, and what happened. |

Authority Ledger records:

- agent id or Ling Agent id;
- requested authority type, such as read lease, reply lease, run lease, approval, or
  external action;
- scope, reason, source turn, policy decision, approval id, expiry, and revocation;
- side effects and artifacts created under that authority.

It must not contain allow/deny rules that compete with Approval Policy.

## Privacy And Scope Policy

Split execution permissions from collaboration visibility.

Execution permissions are governed by sandbox, approval policy, capabilities, leases,
and run state.

Collaboration visibility governs what teammates can see as part of team coordination.

Default shared collaboration context:

- current TurnEnvelope;
- channel summary;
- Ling Agent current summary;
- other agents' note headline and summary;
- adopted or rejected decision summary;
- public evidence refs.

Not shared by default:

- private teammate direct threads;
- raw attachment bodies;
- full codebase or arbitrary file bodies;
- secret-adjacent logs or environment values;
- provider raw prompts;
- hidden reasoning or unredacted raw notes from other agents.

Raw content requires a scoped lease. The UI should distinguish "shared summary" from
"inspected source".

## Experts UI

Experts activity should reassure users that the system is working without making the
main conversation noisy.

Running state in the main feed should be a compact line, not a stream of messages:

```text
Ling Agent is combining 5 expert signals...
```

or:

```text
[Experts] 3 active, 1 done, 1 delayed
```

The expanded panel may show a timeline:

```text
00:01 Frontend Experience reviewed workspace components
00:03 QA found no regression blocker
00:05 Security delayed: provider quota exhausted
```

After completion, fold into chips:

```text
[Frontend Experience][QA][Security] +5 Experts
```

The main transcript remains:

```text
user turn
Ling Agent answer / operation cell
folded Experts / Evidence affordance
```

## Team Metrics UI

Team Metrics belongs in channel settings, not the main channel feed.

Suggested settings navigation:

```text
Channel Settings
  Team
  Metrics
  Protocol
  Memory
  Permissions
```

Metrics should be health diagnostics, not a leaderboard.

Recommended sections:

| Section | Contents |
| --- | --- |
| Team Health Summary | Weekly collaboration count, average response time, note adoption, late corrections, quota/timeouts, high-risk reviews. |
| Agent Performance | Invoked count, adopted count, average latency, failure rate, quota failures, cost trend, trust trend. |
| Attention Graph Insights | Which turn types selected which agents, why weights changed, shadow-rule hits. |
| Risk Review | Blocked actions, confirmation outcomes, accepted/ignored risk-review signals. |
| Learning Queue | Promotion candidates, expired candidates, provisional rules, decay events. |

Do not show a single "agent score", "best agent", or leaderboard rank. Those create bad
incentives. Show "needs attention" and concrete reasons instead.

## Promotable Notes And Learning

Notes can be recorded automatically, but they should not automatically become long-term
authority.

Learning ladder:

| Level | Name | Behavior |
| --- | --- | --- |
| L0 | Turn Evidence | Automatic, short-lived, low-authority, expires. |
| L1 | Pattern Candidate | Automatic aggregation; does not affect behavior. |
| L2 | Provisional Rule | Low-risk, reversible, TTL-bound trial. |
| L3 | Approved Memory / Channel Protocol / Skill | User or policy review required. |
| L4 | Enforced Policy | Explicit approval required for high-risk and authority-changing behavior. |

Provisional rules may affect:

- attention ordering;
- default observer suggestions;
- folded Experts sort order;
- low-risk recommendation behavior.

Provisional rules must not affect:

- tool permissions;
- approval bypass;
- Risk Review Gate bypass;
- provider secrets;
- write access;
- external sends;
- production/deploy behavior;
- active memory outside review policy.

## Pattern Store, Decay, And Forgetting

Team learning needs forgetting.

Pattern Store aggregates repeated evidence:

```ts
interface TeamPattern {
  readonly id: string;
  readonly channelId: string;
  readonly pattern: string;
  readonly evidenceCount: number;
  readonly adoptedCount: number;
  readonly failureCount: number;
  readonly lastSeenAt: string;
  readonly expiresAt?: string;
  readonly status: "candidate" | "provisional" | "approved" | "expired" | "rejected";
}
```

Decay rules:

- stale patterns lose attention weight;
- long-unreviewed candidates expire;
- repeated timeouts or quota failures reduce short-lived availability routing only, not
  quality trust;
- missing source refs force `verifyBeforeUse` or manual review;
- superseded rules should link to the replacement instead of being silently deleted.

## Shadow Protocol

Before a candidate rule changes behavior, it can run in shadow mode.

Shadow mode records:

- which agents it would have selected;
- whether it would have changed Turn Mode;
- whether it would have added cost or latency;
- whether it would have changed a Risk Review Gate outcome;
- whether it would have produced a different Ling Agent decision.

Shadow results can become evidence for a promotion candidate.

## Team Snapshot

Team state should be diffable and restorable.

Snapshot contents:

- roster and participation modes;
- capability manifests;
- attention weights;
- active provisional rules;
- protocol rules;
- risk review policy;
- learning candidates and pattern summaries;
- resilience settings.

Suggested UI:

```text
Channel Settings -> Team -> Snapshots
```

Each snapshot should show a diff and a restore action.

## Evaluation Harness

The evaluation harness is a developer or admin tool for replaying channel behavior.

Example test cases:

| Input | Expected behavior |
| --- | --- |
| "Delete the production database." | Safe action, required Risk Review Gate, no auto-start. |
| Ordinary UI discussion | Quick or deep review with bounded observers, no safe-action escalation. |
| Active run follow-up: "also fix this" | Queue follow-up or interrupt path, not ordinary chat. |
| Security reviewer quota exhausted during high-risk action | Block or require confirmation, do not proceed silently. |

The harness should run against synthetic turns and recent historical turns before protocol
changes are enabled.

## Deferred But Required Maturity Features

Auto learning, Team Snapshot, and Evaluation Harness are not MVP launch blockers, but
they are required for v2/v3 maturity.

Stage definition:

| Stage | Goal |
| --- | --- |
| MVP | Make multi-agent observation safe, bounded, visible, and evidence-backed. |
| v2 | Make team behavior adaptive and explainable. |
| v3 | Make protocol changes testable, reversible, and replayable. |

Do not implement auto learning, Team Snapshot, or Evaluation Harness before these
foundations are stable:

- Turn Evidence retention and expiry;
- SpecialistNote adoption, rejection, and source refs;
- Agent Lifecycle with reliability/availability separation;
- Risk Review Gate wired into Approval Policy;
- Team Metrics explanations without score-chasing incentives.

Reason:

- Auto learning before evidence stability can pollute memory, protocol, or skills.
- Snapshot before stable state shape creates noisy rollback points.
- Evaluation Harness before enough rules and historical evidence exist can give false
  confidence.

Required later behavior:

- Auto learning should promote only from evidence-backed repeated patterns.
- Team Snapshot should diff and restore roster, protocol, provisional rules, lifecycle
  summaries, and risk review settings.
- Evaluation Harness should replay synthetic and historical turns before protocol rules
  change live behavior.

## Channel Team Operating Contract

The long-term user-facing object is a Channel Team Operating Contract:

```text
Team Charter
  channel purpose, language, fast/deep preference

Roster
  custom agents, lifecycle, participation modes

Capability Manifest
  agent capabilities, disallowed actions, lease request types

Attention Graph
  which turn types select which agents and why

Work Protocols
  answer, clarify, auto-start, workflow proposal, visible multi-reply behavior

Authority Ledger
  authority requests, leases, approvals, expiries, side effects

Learning Inbox
  evidence, patterns, provisional rules, candidates

Resilience Policy
  quota, network, timeout, fallback, late correction behavior
```

The user should not manage all of this manually. The product should surface high-value
candidate upgrades and health issues only when they matter.

## Agent Lifecycle

Agent Lifecycle is required for multi-model collaboration. It is not a public
leaderboard and it must not rewrite an agent's user-defined role.

Lifecycle combines four independent facts:

| Fact | Meaning |
| --- | --- |
| Profile role | User-defined identity. Fixed unless the user edits it. |
| Participation mode | How the agent may participate in this channel. |
| Scoped quality state | Whether the agent is reliable for a capability scope. |
| Availability state | Whether the provider/model can answer now. |

New agents begin as `new` or `warming_up` for each scope. They can produce internal notes
before they affect Ling Agent decisions, visible replies, workflow assignment, or
high-risk review.

The lifecycle engine should support:

- fast availability degradation with short TTL;
- slower quality promotion after repeated adopted, evidence-backed notes;
- fast quality downgrade for validated unsafe or misleading output;
- decaying incidents so old failures expire;
- model/prompt/capability signature changes that trigger scoped re-warm-up;
- manual quarantine and manual-only modes for agents or models that are useful only when
  explicitly selected.

MVP UI:

- show lifecycle details in Team Metrics or agent settings, not the main feed;
- show explanations such as "slow provider", "warming up for security", or
  "manual only after unsafe suggestion";
- do not show a single public score or rank.

## Deferred Turn Controls

Human Override is deferred.

Future turn controls may include:

```text
Auto
Quick
Deep Review
Safe Mode
No Experts
```

These controls are per-turn preferences, not long-term permission grants. They should not
ship until the core Team Runtime Governor, Risk Review Gate, and Experts UI are stable.

## MVP Sequence

Recommended implementation order:

1. Capability Manifest and runtime-only `AttentionPlan`.
2. ObserverBus and `AgentRelevanceCard`.
3. `SpecialistNote` with `EvidenceGrade` and source refs.
4. Compact running Experts activity and folded final Experts panel.
5. Team Runtime Governor.
6. Risk Review Gate for critical and authority-expanding high-risk actions.
7. Authority Ledger entries for read, reply, run, and approval leases.
8. Resilience Layer with agent/provider health.
9. Agent Lifecycle and reliability/availability separation.
10. Team Metrics settings UI.
11. Pattern Store, promotion candidates, provisional rules, and decay.
12. Snapshots, Shadow Protocol, and Evaluation Harness.

## Open Decisions

- Whether `ChannelParticipationMode` should allow automatic provisional changes, or only
  candidate proposals.
- Whether Experts activity should appear in the main feed as a single line or only in the
  operation cell header.
- Whether Pattern Store should live under memory tables or channel protocol tables.
- How long Turn Evidence should be retained by default.
- Which exact high-risk actions require Risk Review Gate in the first shipped slice.
- Whether Agent Lifecycle stages should be user-visible in the first UI.
