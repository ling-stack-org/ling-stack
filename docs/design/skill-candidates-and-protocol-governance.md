# Skill Candidates And Protocol Governance

Status: Design direction; Skill Health, manual SkillCandidate review, candidate-to-draft,
ProcedureObservation jobs, usage telemetry, observation clusters, playbook routing, and
Channel Protocol Canvas read model implemented
Date: 2026-06-20
Scope: Ling-native reusable workflow candidate generation, duplicate/conflict governance,
channel protocol candidates, and skill health diagnostics.

Detailed implementation breakdown:
[Skill Candidates And Protocol Governance Implementation Plan](skill-candidates-and-protocol-governance-implementation-plan.md).

## Summary

Ling should support semi-automated skill generation, but it must not turn every useful
conversation lesson into a new active skill.

The target shape is:

```text
run / message / workflow output
  -> ProcedureObservation
  -> candidate router
  -> memory candidate
  -> channel protocol candidate
  -> channel/project playbook candidate
  -> automation candidate
  -> skill candidate
  -> review and health governance
  -> optional publication into the Skill Registry
```

The governing rule is conservative:

```text
Observe first.
Classify second.
Create candidates third.
Publish only after review, validation, and duplicate/conflict checks.
```

`SkillCandidate` is a governance module, not a runtime shortcut. It borrows the review
and health ideas from memory health, and it borrows the channel-level living-note idea
from Slack-style channel canvases. It does not replace the existing Skill Registry,
memory system, automations, channel workspace, approval policy, or runner resource loader.

## Source Designs

This design extends:

- [AI Teammates and Skills](ai-teammates-and-skills.md)
- [Ling Skill Import v1](ling-skill-import-v1.md)
- [Memory Health And Multi-Agent Memory Fan-In](memory-health-and-fanin.md)
- [Channel Workspace Design](channel-workspace.md)
- [Automations](automations.md)
- [Approval Policy](approval-policy.md)
- [Runtime Supervisor](runtime-supervisor.md)
- [Channel And Agent Governance Notifications](channel-and-agent-governance-notifications.md)
- [Daemon API](../daemon-api.md)

External product patterns are references, not runtime dependencies:

- explicit record-and-review flows that turn a user-approved procedure into an editable
  skill draft;
- pending-first workshop flows where a reviewer proposes skill updates but cannot execute
  tools or publish directly;
- channel canvas patterns where a channel owns durable operating notes, protocols, and
  alignment rules without converting every note into a workflow skill.

## Current Baseline

Already implemented in Ling:

- `SkillDefinition`, `SkillPack`, `SkillRegistryEntry`, `SkillImportDraft`, and
  `SkillRegistryReviewStatus` types.
- Built-in `gstack-default` skill definitions in `packages/core`.
- Skill import draft APIs under `/skills`.
- Teammate skill bindings and Effective Skill resolution.
- Run start validation for `requestedSkillId`.
- Selected skill prompt fragments, required tools, required provider capabilities, and
  approval profile merged into the runtime request only after executability checks.
- Pi runner resource loading with `noSkills: true`, so Ling controls skill injection
  instead of letting the underlying runner import host skills as execution authority.
- Memory candidates, review policy, `verifyBeforeUse`, promotion inbox, and
  `GET /memory/health`.
- Automations that compile into Ling threads, run sessions, approval-backed actions, and
  artifacts instead of a second runtime.
- Read-only Skill Health types, duplicate/conflict classifier, core report builder, shared
  contracts/API client helper, Web API wrapper, and `GET /skills/health`.
- Minimal read-only Skill Health panel in Settings > Skill Library.
- Durable manual `SkillCandidate` queue with SQLite tables, RunStore facet, shared
  contracts/API client helpers, daemon list/get/create/review routes, review audit records,
  and duplicate analysis during manual create.
- Candidate-to-draft route and Web review panel in Settings > Skill Library. Approved
  candidates can create normal `SkillImportDraft` records, but publication still uses the
  existing import draft publish route.
- Channel protocol candidates are mapped onto the existing `ChannelCollaborationProtocolDraft`
  model through `/channels/:id/protocol-candidates`. Approving applies the draft; rejecting
  cancels it. No second channel protocol table is introduced.
- Structured `ProcedureObservation` records with deterministic cluster ids, conservative
  candidate routing, SQLite storage, shared contracts/API client helpers, daemon
  `GET/POST /procedure-observations`, daemon `POST /procedure-observations/jobs`, and
  daemon `POST /skill-candidates/observe`. The observe/job routes create a pending
  candidate only when routing chooses `skill`, no blockers exist, duplicate analysis
  returns `no_overlap`, and the job is explicit/user-confirmed when it comes from the job
  path.
- Event-first local skill usage telemetry with SQLite storage, shared contracts/API
  client helpers, daemon `GET /skills/usage-events`, `GET /skills/usage-stats`, and
  daemon `POST /skills/:id/corrections`. Run selection and lifecycle transitions record
  selected/started/succeeded/failed/cancelled events; candidate draft and import publish
  record draft/published events; manual corrections record `user_corrected` events.
- Skill Health consumes usage stats and now flags never-used generated skills, high
  failure rates, and repeated user corrections. These findings are review prompts only,
  not automatic archive/disable/delete behavior.
- `ProcedureObservationCluster` read model over existing observations, with shared
  contracts/API client helpers and daemon `GET /procedure-observation-clusters` plus
  `GET /procedure-observation-clusters/:id`. Clusters are the review queue and duplicate
  pressure valve; they are not a second candidate table.
- `playbook` candidate route for channel-scoped workflow output that has reusable steps
  but should stay as a channel/project-local operating procedure instead of becoming a
  global skill.
- Read-only Channel Protocol Canvas API at `GET /channels/:id/protocol/canvas`, combining
  the effective protocol, draft protocol candidates, and channel-scoped protocol/playbook
  observation clusters for Web, Desktop, CLI, and future TUI clients.
- Manual cluster-to-protocol candidate API at
  `POST /channels/:id/protocol-candidates/from-cluster/:clusterId`. It only accepts
  same-channel `ready_for_review` clusters with `routeKind: channel_protocol`; `playbook`
  and other cluster routes remain separate review surfaces.
- Settings > Skill Library renders candidate clusters and exposes a manual
  "Create protocol candidate" action only for ready same-channel `channel_protocol`
  clusters.
- Channel-local playbook candidates have a dedicated SQLite table, shared contracts/API
  client helpers, daemon list/from-cluster/review routes under
  `/channels/:id/playbook-candidates`, and a Settings > Skill Library manual "Create
  playbook candidate" action for ready same-channel `playbook` clusters. Approving marks
  the candidate `active`; it does not create a global Skill or Memory object.
- Settings > Skill Library also lists channel-local playbook candidates across channels,
  shows their steps, validation checks, positive/negative triggers, source refs, and review
  reason, and lets the reviewer approve or reject draft playbook candidates without
  leaving the governance surface.

Current gaps:

- No implemented automatic post-run hook or transcript-derived candidate generation. The
  next-slice design below defines the gates, but the code path remains explicit/manual.
- No implemented automatic candidate routing from run completion, workflow fan-in, or
  selected transcript snippets. The implemented job path is explicit/idempotent only.
- No implemented automatic correction-to-update-candidate job yet. Correction telemetry
  is recorded and surfaced through health; a reviewer can create an update candidate.
- No implemented automatic observation-to-protocol-draft or observation-to-playbook-draft
  creation yet. Channel/protocol/playbook clusters are surfaced for review; a reviewer can
  manually convert a ready `channel_protocol` cluster into a protocol candidate and a
  ready `playbook` cluster into a channel-local playbook candidate.

## Product Rule

Skill generation improves Ling only when it reduces repeated work without increasing
authority ambiguity.

```text
A generated skill can suggest a workflow.
A generated skill cannot grant tools.
A generated skill cannot bypass approvals.
A generated skill cannot alter provider, secret, external-send, or channel access policy.
A generated skill cannot silently override built-in or imported skills.
```

The default action is not "create a new skill." The default action is:

```text
reject as not reusable
or append evidence to an existing candidate
or update/supersede an existing Ling-generated candidate
or route to memory/channel/automation/approval
```

New active skills are the last resort.

## Non-Goals

- No automatic publication of generated skills.
- No automatic mutation of built-in skills.
- No automatic mutation of externally imported or user-managed skill directories.
- No hidden background skill learning from every transcript.
- No automatic tool, MCP, provider, secret, approval, external-send, or deploy grant.
- No conversion of every channel rule into a skill.
- No model-generated rewrite of workflow graphs or approval policy.
- No runner-native skill loading as the source of truth.
- No deletion or semantic rewrite of existing skills without user review.
- No global skill marketplace or remote sync in this slice.

## Module Boundary

This should be a new module that sits beside existing governance modules.

```text
packages/core
  skill candidate types
  candidate routing helpers
  duplicate/conflict classifier
  skill health report builder

packages/daemon
  observation ingestion routes
  candidate review routes
  health routes
  optional post-run observation jobs

apps/web
  skill candidate review surface
  skill health panel
  channel protocol canvas surface
```

It should not live inside memory, skills, automations, or channel code as a hidden
subfeature. Those modules remain owners of their durable records.

| Concern | Owner | Skill candidate module role |
| --- | --- | --- |
| Active skill registry | Skill Registry | Propose draft/update/supersede actions |
| Imported skills | Skill Import | Compare and wrap; never mutate automatically |
| Memory lessons | Memory | Route non-procedural lessons away from skills |
| Channel operating rules | Channel workspace | Propose protocol candidates, not skills |
| Scheduled repeat work | Automations | Propose automation candidates |
| Permission changes | Approval policy/tool policy | Block or route to explicit policy review |
| Runtime execution | Runs/Runtime Supervisor | Observe output and usage; never bypass checks |

## Core Model

The model has three layers:

```text
ProcedureObservation
  raw evidence about a repeated or useful procedure

ReusableProcedureCandidate
  abstract candidate with destination decided by the router

SkillCandidate / ChannelProtocolCandidate / AutomationCandidate / MemoryCandidate
  destination-specific review object
```

Ling should persist observations separately from candidates. This prevents one run from
directly manufacturing a skill and gives the system room to merge evidence before review.

## ProcedureObservation

`ProcedureObservation` records what happened and why it may be reusable.

```ts
type ProcedureObservationSource =
  | "explicit_user_request"
  | "user_correction"
  | "successful_tool_chain"
  | "repeated_pattern"
  | "workflow_step_output"
  | "multi_agent_handoff"
  | "manual_recording";

type ProcedureObservationSignal =
  | "save_as_skill"
  | "next_time_instruction"
  | "correction_phrase"
  | "long_successful_sequence"
  | "same_sequence_repeated"
  | "handoff_stabilized"
  | "user_approved_recording";

interface ProcedureObservation {
  readonly id: string;
  readonly workspaceId: string;
  readonly clusterId: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly source: ProcedureObservationSource;
  readonly signals: readonly ProcedureObservationSignal[];
  readonly title: string;
  readonly summary: string;
  readonly normalizedGoal: string;
  readonly positiveTriggers: readonly string[];
  readonly negativeTriggers: readonly string[];
  readonly procedureSteps: readonly ProcedureStep[];
  readonly validationSteps: readonly ProcedureValidationStep[];
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
  readonly confidence: "low" | "medium" | "high";
  readonly reusableScore: number;
  readonly routeKind?: CandidateRouteKind;
  readonly routeReasonCode?: string;
  readonly routeBlockers: readonly CandidateRouteBlocker[];
  readonly createdAt: string;
}

interface ProcedureStep {
  readonly title: string;
  readonly instruction: string;
  readonly requiredTools: readonly string[];
  readonly expectedEvidence?: string;
}

interface ProcedureValidationStep {
  readonly title: string;
  readonly commandOrCheck: string;
  readonly expectedResult: string;
}
```

Observation creation should be selective:

- explicit user phrases such as "save this as a skill", "next time do this", or "以后都按这个";
- user corrections that describe a repeatable procedure, not a one-off preference;
- a long successful tool chain with clear validation evidence;
- the same procedure pattern appearing across several runs or teammates;
- a multi-agent handoff pattern that stabilizes into a repeatable protocol;
- a user-approved recording session.

Weak signals should only increment evidence on an existing observation cluster. They should
not create new review noise.

### Observation Clustering And Creation Gates

Every observation should join an observation cluster before any candidate is created.
The cluster is the dedupe unit for generation, and should be derived from normalized,
non-secret metadata:

```text
cluster key =
  workspaceId
  + destination hint
  + scope hint
  + normalized goal
  + trigger signature
  + procedure step signature
  + required tool signature
```

Cluster inputs must be redacted and bounded. Store source refs and short evidence
summaries, not raw transcripts, full prompts, secret values, or arbitrary artifact bodies.

Candidate generation gates:

| Signal shape | Default behavior |
| --- | --- |
| Explicit "save this as a skill/protocol" from the user | create observation and route immediately |
| User-approved recording session | create observation and route immediately |
| Selected run manual extraction | create observation; route only after user confirmation |
| Same successful procedure appears in at least 2 runs | append evidence; route when validation evidence is stable |
| Same weak pattern appears only once | append evidence only, no candidate |
| User correction is a one-off preference | route to memory or reject |
| Procedure asks for more tools, approvals, secrets, provider access, deploy, or external-send authority | route to policy review or reject |

`reusableScore` is advisory. It should help sort review queues, but it must not publish or
activate anything. A practical first scoring model can stay lexical:

```text
explicit user save/recording       +50
repeat across another run          +20
clear validation evidence          +15
negative trigger present           +10
same teammate/channel only          +5
permission expansion requested     hard block
missing validation evidence        hard block for skill candidate
```

Generation should prefer merging evidence into an existing cluster over creating a new
candidate. A new candidate is allowed only when the cluster has a clear destination,
passes safety checks, and does not overlap an active or pending record above the duplicate
threshold.

The implemented Phase 2 surface exposes clusters as a read model over existing
`ProcedureObservation` rows:

```ts
type ProcedureObservationClusterStatus =
  | "collecting"
  | "ready_for_review"
  | "blocked"
  | "routed_elsewhere";

type ProcedureObservationClusterRecommendedAction =
  | "append_evidence"
  | "create_skill_candidate"
  | "create_channel_protocol_candidate"
  | "create_playbook_candidate"
  | "create_memory_candidate"
  | "create_automation_candidate"
  | "policy_review"
  | "dismiss";

interface ProcedureObservationCluster {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly routeKind: CandidateRouteKind;
  readonly status: ProcedureObservationClusterStatus;
  readonly recommendedAction: ProcedureObservationClusterRecommendedAction;
  readonly observationCount: number;
  readonly reusableScore: number;
  readonly routeBlockers: readonly CandidateRouteBlocker[];
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
}
```

Clusters deliberately do not mutate destination records. A `ready_for_review` playbook or
protocol cluster means "show this to a reviewer"; it does not mean "create a draft now."

## Candidate Router

The router decides where an observation belongs.

```text
facts / preferences / historical lessons
  -> memory candidate

channel collaboration rules / role division / default handoff protocol
  -> channel protocol candidate

channel/project-local repeatable workflow output
  -> playbook candidate

scheduled, monitored, or manually repeatable trigger
  -> automation candidate

tool access, approval, provider, secret, external-send, deploy permission
  -> approval or runtime policy review, not skill

concrete reusable procedure with steps, triggers, non-triggers, and validation
  -> skill candidate
```

Candidate routing should produce a reason code:

```ts
type CandidateRoute =
  | { readonly kind: "memory"; readonly reasonCode: string; readonly confidence: "low" | "medium" | "high" }
  | { readonly kind: "channel_protocol"; readonly reasonCode: string; readonly confidence: "low" | "medium" | "high" }
  | { readonly kind: "playbook"; readonly reasonCode: string; readonly confidence: "low" | "medium" | "high" }
  | { readonly kind: "automation"; readonly reasonCode: string; readonly confidence: "low" | "medium" | "high" }
  | { readonly kind: "skill"; readonly reasonCode: string; readonly confidence: "low" | "medium" | "high" }
  | { readonly kind: "approval_policy_review"; readonly reasonCode: string; readonly confidence: "low" | "medium" | "high" }
  | { readonly kind: "reject"; readonly reasonCode: string; readonly confidence: "low" | "medium" | "high" };
```

Router decisions should include structured blockers for UI display:

```ts
type CandidateRouteBlocker =
  | "insufficient_evidence"
  | "one_off_preference"
  | "missing_validation"
  | "missing_negative_trigger"
  | "duplicate_existing_skill"
  | "conflicts_with_pending_candidate"
  | "permission_expansion"
  | "unsafe_or_secret_adjacent";
```

The router should not ask "can this become a skill?" first. It should ask "what durable
record type is the least powerful correct home for this lesson?"

Default routing rules:

| Destination | Required shape | Reject or reroute when |
| --- | --- | --- |
| Memory | fact, preference, project convention, durable lesson | it contains ordered execution steps or tool authority |
| Channel protocol | role division, handoff rule, review rule, channel default | it needs scheduled execution or tool calls |
| Playbook | channel-scoped workflow output with reusable steps and existing authority envelope | it should be globally reusable or scheduled |
| Automation | trigger/cadence plus expected output | it requires new approval/tool/provider authority |
| Skill | repeatable procedure with triggers, non-triggers, steps, validation, stable tools | it is only a fact, channel norm, or permission request |
| Approval policy review | request changes execution authority | it is phrased as a workflow but actually relaxes safety |
| Reject | one-off, ambiguous, unsafe, duplicate without new evidence | there is no durable value |

For multi-agent channels, channel protocol is the default home for coordination behavior.
A skill candidate is justified only when the behavior contains a reusable procedure that a
future agent can execute with the existing tool and approval envelope.

Examples:

| Observation | Route | Reason |
| --- | --- | --- |
| "This repo keeps `WORKFLOW.md` local and publishes `WORKFLOW.example.md`." | Memory | durable repo fact and policy reminder |
| "In this channel, Architect reviews before Engineer implements." | Channel protocol | multi-agent operating protocol |
| "After a channel workflow finishes, collect test and rollout evidence in this order." | Playbook | channel-local repeatable procedure |
| "Every Friday produce a project health report." | Automation | trigger and output cadence |
| "Use bash without asking next time." | Approval policy review or reject | permission change, not skill |
| "When fixing web UI, run typecheck and Playwright screenshot checks." | Skill candidate | reusable workflow with validation |

## Observation Job Design

Observation jobs are sidecar governance jobs. The implemented MVP is an explicit daemon
route, not an automatic background hook. Future automatic jobs may run after a
user-visible action has already completed, but they must never change the active run
prompt, approval policy, provider selection, teammate bindings, or registry state.

There are four ingestion lanes:

| Lane | Trigger | Input allowed | Candidate behavior |
| --- | --- | --- | --- |
| Manual observation | Explicit API/UI action | Structured observation form | Route immediately |
| Explicit post-run save | User says "save as skill/protocol" or approves a recording | Bounded run/tool metadata plus user confirmation source ref | Route immediately |
| Repeated pattern evidence | Same structured procedure signature appears across runs/teammates | Cluster key, tool names, terminal status, validation artifact refs | Evidence-only until gates pass |
| Correction evidence | User correction against a skill or run | Correction event metadata and optional structured correction summary | Health finding first; update candidate only after review |

Jobs must consume structured summaries, not raw conversation logs. Acceptable post-run
inputs are:

- run id, task id, channel id, teammate id, selected skill id, terminal status;
- tool names, tool result status, bounded command labels, and artifact ids;
- validation command/check labels and pass/fail outcome;
- explicit user confirmation refs such as a message id or review action id;
- existing `SkillUsageEvent` counters and health findings.

Forbidden inputs:

- full transcripts, full prompts, raw stdout/stderr bodies, raw artifact bodies;
- secret values, provider payloads, approval credentials, token-like strings;
- model-generated authority changes such as "allow bash next time";
- inferred deploy, external-send, secret, MCP, provider, or approval grants.

### Job Idempotency

Every observation job must be idempotent before it writes anything:

```text
observationJobKey =
  workspaceId
  + source
  + runId/messageId/reviewActionId
  + destination hint
  + normalized goal signature
```

If the exact job key already produced an observation, the job returns the existing
observation. If a different job key maps to the same cluster, it appends another
observation to the cluster and lets duplicate analysis decide whether a destination
candidate already exists.

Multi-agent jobs also include `channelId` and a normalized participant-role signature in
the cluster key. This prevents the same workflow fan-in from producing one skill per
teammate.

### Generation Thresholds

The first automated slice should use these gates:

| Signal | Observation | Candidate |
| --- | --- | --- |
| Explicit "save this as a skill" | create | create pending skill candidate if duplicate decision is `no_overlap` |
| Explicit "save this as channel rule/protocol" | create | create channel protocol draft/candidate |
| User-approved recording | create | create pending skill candidate if validation and negative triggers exist |
| Single successful run without explicit save | create only when job is enabled | evidence-only |
| Two or more successful runs in same cluster | create/append | pending candidate only if validation evidence is stable and no duplicate/conflict |
| User correction with one-off preference | create optional memory observation | no skill candidate |
| Repeated correction against same skill | usage health finding | update candidate only after reviewer chooses action |
| Any permission expansion text | create optional policy-review observation | no skill/protocol candidate |

Weak evidence can make the review queue better, but it cannot manufacture active
behavior. Even pending candidates should be avoided when the signal is weak, duplicate,
or authority-adjacent.

### Automatic Candidate Generation Next Slice

Automatic generation should mean "turn bounded evidence into a review candidate," not
"turn transcripts into executable behavior."

The next implementation slice should introduce a small generation orchestrator over the
existing `ProcedureObservation` and cluster model:

```text
source event
  -> bounded observation input
  -> idempotent observation job
  -> cluster update
  -> candidate generation decision
  -> append evidence OR create pending candidate OR route elsewhere
```

It should not introduce a background transcript crawler. Every source event must be one
of these bounded inputs:

- explicit user save or user-approved recording;
- run terminal event with structured tool labels, validation labels, artifact refs, and
  terminal status;
- selected transcript snippet after the user explicitly chooses the snippet;
- workflow fan-in summary that already has channel, participant, and role metadata;
- usage/correction health finding that already summarizes repeated failures.

Generation writes a decision record for every generation attempt. When the same request
creates a destination candidate, the persisted decision includes that candidate id:

```ts
interface CandidateGenerationDecision {
  readonly id: string;
  readonly workspaceId: string;
  readonly observationId: string;
  readonly clusterId: string;
  readonly source:
    | "explicit_user_save"
    | "approved_recording"
    | "post_run_terminal"
    | "selected_transcript_snippet"
    | "workflow_fanin"
    | "correction_health";
  readonly route: CandidateRoute;
  readonly decision:
    | "append_evidence"
    | "create_skill_candidate"
    | "create_channel_protocol_candidate"
    | "create_playbook_candidate"
    | "create_memory_candidate"
    | "create_automation_candidate"
    | "policy_review"
    | "reject";
  readonly blockers: readonly CandidateRouteBlocker[];
  readonly duplicateDecision?: SkillDuplicateDecision;
  readonly reason: string;
  readonly createdCandidateId?: string;
  readonly createdAt: string;
}
```

The decision record is for auditability and replay. It is not user-facing authority.
`duplicateDecision` is present only when duplicate analysis actually ran; routed-elsewhere
or policy-review paths must not pretend they passed duplicate analysis.

Generation rules:

| Source | Required before candidate creation | Default if not met |
| --- | --- | --- |
| Explicit user save | structured steps, validation or explicit user-provided reason, duplicate decision `no_overlap` or `update_existing` | append evidence or show duplicate/update review |
| Approved recording | positive trigger, negative trigger, steps, validation, no permission expansion | append evidence |
| Post-run terminal event | at least 2 successful observations in the same cluster, stable validation evidence, no active duplicate | evidence-only |
| Selected transcript snippet | user confirmation plus bounded extraction summary | evidence-only until confirmed |
| Workflow fan-in | one channel owner and stable participant roles | route to channel protocol/playbook, not global skill |
| Correction health | repeated correction health finding and reviewer-selected action | create update candidate only after review |

Duplicate and conflict behavior stays stricter than generation:

- exact `procedureSignature` match appends evidence to the existing cluster or candidate;
- similarity `>= 0.65` against an active or pending skill blocks new skill candidate
  creation and creates a conflict/update review path instead;
- built-in skills receive patch suggestions or wrapper candidates only;
- external/imported skills receive wrapper or overlay candidates only;
- Ling-generated skills can receive update/supersede candidates after review;
- no candidate can expand tools, approvals, providers, secrets, channels, deploy, or
  external-send authority.

### Runtime Invocation Boundary

Automatic generation and runtime skill invocation are separate phases.

After a generated skill is reviewed and published, it still enters the normal Skill
Registry and Effective Skill path. Runtime selection remains subject to:

- teammate skill binding;
- channel allowed tools;
- provider capability checks;
- approval profile checks;
- existing run request validation;
- Skill Health findings that may mark the skill stale, conflicting, or risky.

The next runtime-facing improvement should be a suggestion, not automatic invocation:

```ts
interface SkillInvocationSuggestion {
  readonly skillId: string;
  readonly reason: string;
  readonly confidence: "low" | "medium" | "high";
  readonly blockers: readonly CandidateRouteBlocker[];
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
}
```

Suggestions may prefill a review surface or explain why a skill looks relevant. They must
not inject `requestedSkillId` into an active run without the same user-visible selection
path used today.

Usage, expiry, and correction policy:

- generated active skills become stale health findings after 90 days without use unless
  pinned;
- repeated failures or user corrections become health findings, not automatic archives;
- corrections can propose update candidates only after a reviewer chooses that route;
- invocation statistics should be windowed for dashboards but rebuilt from source events;
- stale or failing generated skills stay visible until reviewed, superseded, archived, or
  pinned.

### Channel Protocol Routing

Channel protocol candidates should be generated from collaboration rules, not from
procedural tool workflows. Route to `channel_protocol` when the observation primarily
describes:

- default teammate assignment or role split inside a channel;
- handoff order, review order, or workflow coordination between multiple agents;
- channel response rules such as "design review must happen before implementation";
- repeated collaboration failure that can be fixed by a channel-local rule.

Do not route to `channel_protocol` when the observation asks for tool access, provider
changes, secret access, deploy behavior, or external mutation. Those belong to explicit
policy/runtime review.

### Playbook Routing

`playbook` is the channel/project-local home for procedures that are useful but should not
be promoted into a workspace-wide skill. Route to `playbook` when an observation is a
`workflow_step_output`, has a `channelId`, and contains concrete `procedureSteps`.

The key distinction:

```text
channel protocol = coordination rule or operating norm
playbook = local procedure/checklist produced by a channel workflow
skill = reusable execution template that may be selected by future runs after review
```

Playbooks can later become a skill candidate only through explicit review and duplicate
checks. They do not grant tools, change approvals, or bind teammates.

### PC/Desktop Compatibility

Desktop and PC clients should treat observation jobs as daemon-owned governance state:

- render review queues through shared contracts and the API client;
- deep-link to source refs, not SQLite rows;
- never parse raw local transcripts in the renderer;
- never write `ProcedureObservation`, `SkillCandidate`, or protocol draft tables directly.

The Desktop alpha can reuse the Web review surface. A native desktop queue can come later
as a pure client over the same routes.

## SkillCandidate

`SkillCandidate` is a review object. It is not an active skill.

```ts
type SkillCandidateStatus =
  | "pending"
  | "needs_edit"
  | "approved_for_draft"
  | "published"
  | "rejected"
  | "quarantined"
  | "superseded"
  | "expired";

type SkillCandidateOrigin =
  | "ling-generated"
  | "recording"
  | "manual-draft"
  | "import-overlay";

type SkillCandidateAction =
  | "create_new"
  | "update_existing"
  | "append_evidence"
  | "supersede_existing"
  | "create_wrapper"
  | "reject";

interface SkillCandidate {
  readonly id: string;
  readonly workspaceId: string;
  readonly origin: SkillCandidateOrigin;
  readonly targetSkillId?: string;
  readonly proposedAction: SkillCandidateAction;
  readonly status: SkillCandidateStatus;
  readonly title: string;
  readonly summary: string;
  readonly roleAffinity: readonly string[];
  readonly workflowPhase: string;
  readonly positiveTriggers: readonly string[];
  readonly negativeTriggers: readonly string[];
  readonly procedureSteps: readonly ProcedureStep[];
  readonly validationSteps: readonly ProcedureValidationStep[];
  readonly requiredTools: readonly string[];
  readonly requiredProviderCapabilities: readonly string[];
  readonly approvalProfileHint?: string;
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
  readonly duplicateAnalysis: SkillDuplicateAnalysis;
  readonly safetyFindings: readonly SkillCandidateSafetyFinding[];
  readonly usageHints?: SkillCandidateUsageHints;
  readonly reviewNotes: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
  readonly supersededBy?: string;
}

interface SkillCandidateSourceRef {
  readonly type:
    | "message"
    | "run"
    | "task"
    | "workflow-step"
    | "artifact"
    | "recording"
    | "import-draft"
    | "skill";
  readonly id: string;
  readonly label?: string;
  readonly url?: string;
}

interface SkillCandidateUsageHints {
  readonly likelyUseWhen: readonly string[];
  readonly likelyDoNotUseWhen: readonly string[];
  readonly expectedFrequency?: "rare" | "occasional" | "frequent";
}
```

The candidate should be publishable only by creating or updating a Skill Registry draft.
The review flow should still pass through existing registry publication and teammate
binding rules.

```text
SkillCandidate
  -> approved_for_draft
  -> SkillImportDraft or registry draft
  -> publish to SkillRegistryEntry
  -> bind to teammate
  -> Effective Skill validates runtime executability
```

## ChannelProtocolCandidate

Some repeated behavior belongs to the channel, not to a skill.

`ChannelProtocolCandidate` is the Ling version of a channel canvas entry: a living
protocol attached to a channel, visible to humans and teammates, and eligible for review.
The conceptual model below describes the product semantics. The current public DTO does
not introduce a second table or wire shape: `ChannelProtocolCandidate` is an alias of
`ChannelCollaborationProtocolDraft`, with `draft`, `applied`, `cancelled`, and `stale`
as the persisted lifecycle states.

```ts
type ChannelProtocolCandidateStatus =
  | "pending"
  | "active"
  | "rejected"
  | "archived"
  | "superseded";

type ChannelProtocolKind =
  | "role_division"
  | "handoff_rule"
  | "review_rule"
  | "default_workflow"
  | "communication_norm"
  | "artifact_policy";

interface ChannelProtocolCandidate {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly kind: ChannelProtocolKind;
  readonly status: ChannelProtocolCandidateStatus;
  readonly title: string;
  readonly body: string;
  readonly appliesToTeammateIds: readonly string[];
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
  readonly reviewNotes: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly supersededBy?: string;
}
```

Channel protocols should be rendered as channel context and coordination guidance. They
should not directly grant tools, approvals, provider access, or external-send rights.

The Channel Protocol Canvas read model combines:

- effective protocol settings and sources;
- draft protocol candidates waiting for approve/reject;
- channel-scoped `channel_protocol` and `playbook` observation clusters;
- section health summaries for clients that need a compact canvas view.

The canvas endpoint is read-only. It gives Web/Desktop a stable channel canvas without
letting the renderer inspect SQLite or interpret raw transcripts.

## Generated Skill Boundaries

Ling needs an explicit provenance boundary.

| Skill source | Automated action allowed | Automated action blocked |
| --- | --- | --- |
| `builtin` / Ling default | Produce product patch suggestion or wrapper candidate | Modify, disable, or supersede automatically |
| `skill-directory` / external import | Produce overlay, wrapper, or local note candidate | Edit source files or publish replacement automatically |
| `agents-md` import | Produce reviewed draft hints | Treat persona text as executable skill authority |
| `custom` user-managed | Suggest update candidate | Apply update without review |
| `ling-generated` | Append evidence, update candidate, supersede candidate after review | Auto-publish or bypass duplicate checks |

This keeps user-owned and externally owned skill sources stable. Ling-generated skills can
evolve, but only through the candidate and registry review lane.

## Duplicate And Conflict Governance

Duplicate detection must exist in the MVP. Without it, automated skill generation will
eventually create a skill junk drawer.

The classifier should check four layers:

```text
identity duplicate
  same skill id, source checksum, or canonical title

trigger duplicate
  same user intent or activation phrase cluster

procedure duplicate
  same normalized goal, required tools, and step sequence

scope conflict
  overlapping triggers but incompatible approval profile, required tools, channel scope,
  teammate role, or validation expectation
```

```ts
type SkillDuplicateDecision =
  | "no_overlap"
  | "append_evidence"
  | "update_existing"
  | "conflict_review"
  | "reject_duplicate";

interface SkillDuplicateAnalysis {
  readonly decision: SkillDuplicateDecision;
  readonly similarityScore: number;
  readonly matchedSkillIds: readonly string[];
  readonly matchedCandidateIds: readonly string[];
  readonly triggerOverlap: readonly string[];
  readonly conflictingFields: readonly string[];
  readonly rationale: string;
}
```

Default thresholds:

| Similarity | Default decision |
| --- | --- |
| `>= 0.85` | merge/update existing or append evidence |
| `0.65 - 0.85` | conflict review |
| `< 0.65` | may propose new candidate |

Uncertainty should bias away from new skill creation.

Use two signatures, not only one fuzzy score:

```text
identity signature =
  canonical title
  + source kind
  + source path/checksum when present

procedure signature =
  normalized goal
  + positive trigger set
  + negative trigger set
  + ordered step titles
  + required tool set
  + validation check set
  + scope tuple(workspace, channel, teammate role)
```

The deterministic signature catches obvious duplicates. The similarity score catches
near-duplicates and conflicts. Both should be persisted in the duplicate analysis so later
review and health jobs can explain why Ling merged, blocked, or escalated a candidate.

Duplicate decisions should be operational, not just diagnostic:

| Decision | Meaning | Allowed next action |
| --- | --- | --- |
| `no_overlap` | no meaningful active or pending overlap | candidate may enter review |
| `append_evidence` | same procedure, no behavior change | append refs to existing candidate/skill health note |
| `update_existing` | same goal, improved steps or validation | create update/wrapper draft after review |
| `conflict_review` | overlapping trigger with incompatible procedure or scope | block draft until reviewer resolves conflict |
| `reject_duplicate` | no new evidence or value | reject or close as duplicate |

Candidate creation should be idempotent on `clusterId + procedure signature`. Repeated
observations should update evidence counts and source refs. They should not create
parallel pending candidates with the same activation intent.

Hard publish blockers:

- active skill or pending candidate similarity `>= 0.65` without explicit conflict
  resolution;
- same scope has two active skills with the same trigger cluster;
- candidate lacks `validationSteps`;
- candidate lacks `negativeTriggers`;
- candidate requests permission expansion;
- candidate safety scanner returns a critical finding;
- target skill source is built-in or external and the action is direct mutation.

## Safety Scanner

The scanner should run before a candidate reaches review and again before publication.

```ts
type SkillCandidateSafetyFindingCode =
  | "permission_like_instruction"
  | "approval_bypass"
  | "secret_reference"
  | "external_send_claim"
  | "prompt_injection_pattern"
  | "system_prompt_reference"
  | "curl_pipe_shell"
  | "destructive_command"
  | "unknown_tool"
  | "missing_validation"
  | "missing_negative_triggers"
  | "overbroad_scope";

interface SkillCandidateSafetyFinding {
  readonly code: SkillCandidateSafetyFindingCode;
  readonly severity: "info" | "warning" | "critical";
  readonly message: string;
  readonly location?: string;
  readonly recommendation: string;
}
```

Critical findings quarantine the candidate. A quarantined candidate can be inspected, but
it cannot be published until edited and rescanned.

## Skill Health

Skill health should mirror memory health: read-only diagnostics first, mutation through
review actions later.

```ts
type SkillHealthFindingKind =
  | "duplicate_clusters"
  | "conflicting_triggers"
  | "shadowed_skill"
  | "never_used_skill"
  | "stale_candidate"
  | "high_failure_rate_skill"
  | "high_user_correction_skill"
  | "external_overlap_generated_skill"
  | "superseded_but_active"
  | "missing_validation_steps"
  | "missing_negative_triggers";

interface SkillHealthFinding {
  readonly id: string;
  readonly kind: SkillHealthFindingKind;
  readonly severity: "info" | "warning" | "critical";
  readonly skillIds: readonly string[];
  readonly candidateIds: readonly string[];
  readonly title: string;
  readonly description: string;
  readonly recommendedAction:
    | "review"
    | "merge"
    | "supersede"
    | "disable"
    | "archive"
    | "add_validation"
    | "add_negative_triggers"
    | "reject_candidate";
}

interface SkillHealthReport {
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly summary: {
    readonly totalSkills: number;
    readonly activeSkills: number;
    readonly generatedSkills: number;
    readonly pendingCandidates: number;
    readonly duplicateClusters: number;
    readonly conflictCount: number;
    readonly staleCandidates: number;
    readonly highFailureRateSkills: number;
  };
  readonly findings: readonly SkillHealthFinding[];
}
```

The first implementation should be read-only, like memory health. Review actions can be a
later slice.

## Usage, Failure, Expiry, And Correction Feedback

Skill governance needs telemetry, but only as local product state.

```ts
interface SkillUsageStats {
  readonly skillId: string;
  readonly useCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly lastUsedAt?: string;
  readonly lastFailureAt?: string;
  readonly lastUserCorrectionAt?: string;
  readonly correctionCount: number;
}
```

Suggested rules:

- mark generated candidates stale after 30 days without review;
- mark generated active skills stale after 90 days without use unless pinned;
- flag skills with high failure or high correction rates;
- append correction evidence to the relevant candidate or generated skill;
- require review before disabling or archiving active skills;
- do not auto-delete skills based on telemetry.

Expiry should change review priority, not silently remove behavior.

Capture telemetry as events first, then aggregate into stats. This keeps the read model
repairable and avoids making run execution depend on a mutable counter.

```ts
type SkillUsageEventKind =
  | "selected"
  | "started"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "user_corrected"
  | "draft_created"
  | "published"
  | "superseded";

interface SkillUsageEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly skillId?: string;
  readonly candidateId?: string;
  readonly runId?: string;
  readonly teammateId?: string;
  readonly channelId?: string;
  readonly kind: SkillUsageEventKind;
  readonly reason?: string;
  readonly createdAt: string;
}
```

Telemetry-driven actions must stay review-backed:

| Signal | Health finding | Default action |
| --- | --- | --- |
| high failures after repeated selection | `high_failure_rate_skill` | review or add validation |
| repeated user corrections | `high_user_correction_skill` | create update candidate |
| generated skill unused for 90 days | `never_used_skill` or stale finding | review for archive, do not auto-disable |
| published candidate superseded | `superseded_but_active` if old skill remains active | review old skill for archive |
| duplicate generated skill is used less than older skill | `external_overlap_generated_skill` | merge or reject generated duplicate |

Stats can expire from dashboards, but source events should be retained according to the
workspace retention policy. Health should prefer recent evidence when ranking findings,
while still showing long-lived active conflicts.

## Review Lifecycle

Skill candidates should use a review lane parallel to memory promotion inbox.

```text
observation collected
  -> router chooses skill
  -> duplicate/conflict scan
  -> safety scan
  -> candidate pending
  -> reviewer chooses:
       reject
       keep pending
       edit
       append evidence to existing
       create wrapper
       supersede generated skill
       approve as registry draft
  -> registry draft publish
  -> teammate binding
  -> effective skill runtime check
```

Review actions should be auditable:

```ts
type SkillCandidateReviewAction =
  | "keep_pending"
  | "request_changes"
  | "approve_for_draft"
  | "reject"
  | "quarantine"
  | "supersede";

interface SkillCandidateReviewRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly candidateId: string;
  readonly action: SkillCandidateReviewAction;
  readonly actor: "user" | "system";
  readonly previousStatus: SkillCandidateStatus;
  readonly nextStatus: SkillCandidateStatus;
  readonly reason?: string;
  readonly createdAt: string;
}
```

## API Surface Sketch

Candidate review:

```http
GET /skill-candidates?cwd=/path/to/project&status=pending
GET /skill-candidates/:id?cwd=/path/to/project
POST /skill-candidates?cwd=/path/to/project
POST /skill-candidates/:id/review?cwd=/path/to/project
POST /skill-candidates/:id/draft?cwd=/path/to/project
```

Skill health:

```http
GET /skills/health?cwd=/path/to/project
GET /skills/health?cwd=/path/to/project&limit=50
```

Channel protocol candidates:

```http
GET /channels/:id/protocol-candidates?cwd=/path/to/project
POST /channels/:id/protocol-candidates?cwd=/path/to/project
POST /channels/:id/protocol-candidates/:candidateId/review?cwd=/path/to/project
GET /channels/:id/protocol?cwd=/path/to/project
```

Channel-local playbook candidates:

```http
GET /channels/:id/playbook-candidates?cwd=/path/to/project
POST /channels/:id/playbook-candidates/from-cluster/:clusterId?cwd=/path/to/project
POST /channels/:id/playbook-candidates/:candidateId/review?cwd=/path/to/project
```

The API should return source refs, duplicate analysis, and safety findings in the list
view so the UI can explain why a candidate is blocked.

## UI Surface

MVP surfaces:

- a Skill Candidates review panel under Settings > Skill Library;
- a read-only Skill Health panel with duplicate and conflict findings;
- a channel Protocol Canvas panel showing active protocols and pending protocol
  candidates;
- candidate detail with source refs, proposed trigger text, negative triggers, validation
  steps, duplicate analysis, and scanner findings.

The UI should avoid "magic learning" language. It should say what Ling observed, what it
proposes, what conflicts with it, and what the user can approve.

Current MVP state:

- Settings > Skill Library shows Skill Health and open candidates in one governance
  surface.
- Pending or needs-edit candidates can be approved only after the backend review gate
  accepts them.
- `approved_for_draft` candidates can create a normal import draft from the Web panel.
- Publishing remains a separate import-draft action; approval does not publish or bind
  the candidate.

## Implementation Slices

### Slice 1: Read-Only Types And Health

Status: implemented for read-only health backend/client/Web scope on 2026-06-20.
Manual candidate persistence and protocol-candidate aliasing were added in later slices;
observation jobs and transcript-derived candidate generation are still future work.

- Add core types for observations, skill candidates, duplicate analysis, and health
  reports.
- Add read-only health builder over existing Skill Registry entries.
- Expose `GET /skills/health`.
- Add tests for duplicate clusters, conflicting triggers, shadowed skills, missing
  validation, and stale candidates.

### Slice 2: Candidate Persistence And Manual Review

Status: implemented for durable manual `skill_candidates`, review records, review gates,
and candidate-to-import-draft creation. `procedure_observations` remains deferred until
automated observation exists.

- Add SQLite tables for `skill_candidates` and review records.
- Add candidate list/detail/review APIs.
- Support manual candidate creation from an explicit user request or selected run.
- Keep publication as a separate registry draft action.

### Slice 3: Observation Jobs

- Status: implemented for explicit/idempotent observation APIs, manual observation jobs,
  conservative routing, skill-only candidate creation gates, and usage telemetry. Hidden
  post-run hooks and transcript-derived generation remain deferred.

- Add post-run observation jobs for explicit save phrases, corrections, successful tool
  chains, repeated patterns, and multi-agent handoff stabilization.
- Persist observations first, merge by observation cluster, then route into candidates.
- Add router reason codes and blockers for memory, channel protocol, automation, skill,
  policy review, and reject destinations.
- Keep weak signals as evidence-only unless a cluster crosses explicit generation gates.

### Slice 4: Channel Protocol Canvas

Status: implemented as `/channels/:id/protocol-candidates` over existing
`ChannelCollaborationProtocolDraft` records, plus read-only observation clusters,
`playbook` route kind, `GET /channels/:id/protocol/canvas`, and manual
`POST /channels/:id/protocol-candidates/from-cluster/:clusterId` conversion for ready
`channel_protocol` clusters. Channel-local playbook candidates are implemented through
the destination-specific `channel_playbook_candidates` table and
`/channels/:id/playbook-candidates` routes. Automatic observation-to-draft creation and a
native Desktop playbook review UI remain deferred.

- Reuse existing channel protocol and draft tables.
- Add channel protocol candidate API aliases for list/create/review.
- Add channel-scoped cluster read model for protocol/playbook observations.
- Add Channel Protocol Canvas read model for shared Web/Desktop/API clients.
- Add channel-local playbook candidate API for ready `playbook` clusters.
- Add Settings playbook candidate review panel for approve/reject and source evidence.
- Render active protocols into channel context without granting authority.

### Slice 5: Publish And Supersede Flow

Status: partially implemented for approved candidate-to-import-draft creation. Wrapper,
supersede, usage/error/correction telemetry, and post-publish candidate status updates are
future work.

- Keep approved skill candidates flowing through registry import drafts.
- Support wrapper candidates for external/imported skills.
- Support superseding Ling-generated skills after review.
- Add usage/error/correction stats into health findings.

## MVP Hard Rules

- No automatic publish.
- No direct mutation of built-in or external/imported skills.
- No new generated skill when active or pending similarity is `>= 0.65` unless conflict
  review resolves it.
- No active duplicate trigger cluster in the same scope.
- No publish without validation steps.
- No publish without negative triggers.
- No permission expansion through generated skill text.
- No hidden cross-channel or cross-teammate sharing.
- No auto-delete based on usage telemetry.

## Open Questions

- Should generated skills be workspace-wide by default, or channel-scoped until promoted?
  Resolved for MVP: generated candidates inherit the narrowest observed scope; workspace
  promotion requires review.
- Should channel protocol candidates share the memory promotion inbox UI, or have a
  separate channel canvas queue? Resolved for MVP: keep the channel protocol draft lane
  separate from memory promotion.
- What similarity engine is acceptable for MVP: lexical normalization only, embeddings as
  optional enhancement, or both? Resolved for MVP: lexical signatures and deterministic
  token overlap first; embeddings can be an advisory enhancement after deterministic
  blockers exist.
- Should manual recording create a `SkillCandidate` directly, or always create a
  `ProcedureObservation` first for consistency? Resolved for current manual API: direct
  `SkillCandidate` creation is allowed; automated transcript recording should create
  `ProcedureObservation` first.
- Should generated skills require a human-authored summary before publication? Resolved
  for MVP: yes for publish; pending candidates may keep model-authored summaries labeled
  as generated.

## Decision

Start with a standalone governance module.

The first slice should not generate skills automatically. It should ship the health and
duplicate/conflict model first, then add candidate persistence and review. This matches
the memory health pattern and directly addresses the largest long-term risk: duplicate,
conflicting, stale generated skills becoming harder to trust than no generated skills at
all.
