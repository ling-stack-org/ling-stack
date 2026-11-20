# Ling Agent Operating Model 详细设计

- **Status** 目标态详细设计，待实施
- **Owner** Conversation、Core、Daemon、External Agent、GitHub Automation 与开发工具维护者
- **Last verified** 2026-11-20 against `origin/main@b8e76d858`
- **Document type** 跨域状态、授权、事件与恢复详细设计
- **Contract** [Ling Agent Operating Model](ling-agent-operating-model.md)
- **Related contracts** [Ling Agent Session](ling-agent-session.md) · [Channel Team Operating System](channel-team-operating-system.md) · [Ling App Server Detailed Design](ling-app-server-detailed-design.md) · [GitHub Automation](github-automation.md) · [Ling Device Fabric](ling-device-fabric.md)

## 1. Responsibility Matrix

| Object | Canonical owner | Integration projection |
| --- | --- | --- |
| Source event | Channel, GitHub, Automation, External Work, Device Fabric owner | `WorkItemSource` with immutable external identity |
| Work Item | Core/Daemon work-item service | Intake, accepted dispatch, Goal, Delivery and feedback index |
| Assignment | Ling Agent Session, existing Task assignee or accepted Workflow | Selected route and assignee, with the source decision reference |
| Dispatch claim | The existing Task, Turn, Workflow or Automation dispatch owner | Reference to its receipt. A source without an existing dispatch records its first accepted handoff once. |
| Goal | Goal store and acceptance validator | Work Item acceptance revision and completion audit |
| Team participation | Channel Team Operating System | Observer, speaker, reviewer and execution projections |
| Workflow | Multi-Agent Orchestrator | Work Item graph and WorkUnit references |
| Shared evidence | Core Work Item evidence store and original evidence owners | Scoped board entries, their revisions and source references |
| Stage and handoff | Accepted Workflow and its dispatch owner | Stage briefs, dependency readiness and the handoff receipt |
| Coordination | Core Work Item coordination store and the assigned coordinator | Rounds, scoped messages, questions and their delivery receipts |
| Deliberation | Accepted Workflow, Runtime Supervisor and its decision owner | Phase, recommendation and recorded decision on the Work Item |
| Run/Attempt | Runtime Supervisor and Run store | Execution status and evidence |
| External Agent | External runner adapter and App Server | Federated identity, capability and lineage |
| Delivery | Destination-specific owner plus Core receipt | Target identity, digest, outcome and reconciliation |
| Learning candidate | Memory, Skill and Channel review owners | Provenance-bound candidate, never direct authority |

The integration layer can read these owners and append a Work Item event or index row in the same transaction as the source owner state when that state is required for deduplication. It cannot update domain status by copying a projected status back into the owner store.

## 2. Work Item Schema and State

```ts
type AgentWorkItemStatus =
  | "candidate"
  | "clarification_required"
  | "unclaimed"
  | "claimed"
  | "planning"
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "verification_required"
  | "review_required"
  | "delivery_pending"
  | "delivered"
  | "blocked"
  | "failed"
  | "cancelled"
  | "superseded"
  | "archived";

type AgentOwner = {
  readonly kind: "ling_agent" | "teammate" | "external_agent" | "device_host" | "workflow_step";
  readonly id: string;
  readonly claimId: string;
};

interface WorkItemSource {
  readonly kind: "channel_message" | "direct_message" | "github_issue" | "github_pull_request"
    | "github_check" | "automation" | "external_agent" | "device_graph_node" | "local_user";
  readonly externalId: string;
  readonly sourceRevision: string;
  readonly threadId?: string;
  readonly displayRef?: string;
  readonly contentDigest: string;
}
```

Work Item shows intake and delivery state. Once accepted work has an execution owner, the running, waiting, failure and cancellation states are projected from that owner's facts.

```text
candidate
  -> clarification_required | unclaimed | superseded
unclaimed
  -> planning | claimed | cancelled | superseded
planning
  -> claimed | clarification_required | blocked
claimed
  -> queued | blocked | cancelled
queued
  -> running | cancelled | blocked
running
  -> waiting_for_approval | waiting_for_input | verification_required
  -> review_required | delivery_pending | blocked | failed | cancelled
verification_required -> running | review_required | blocked | failed
review_required -> running | delivery_pending | blocked | failed
delivery_pending -> delivered | blocked | failed
delivered -> archived | candidate
```

`delivered -> candidate` represents a new source revision or explicit follow-up. It does not reopen historical execution.

An intake state transition carries `workItemRevision`, `actor`, `sourceEventId`, an idempotency key, and claim or Goal references when present. A stale transition returns the current projection.

## 3. Intake Normalization

The intake path normalizes a bounded event, persists a candidate or returns an existing work item, and passes an accepted item to the existing coordinator. A source event already linked to a Task, Turn, Workflow or AutomationRun uses the existing record.

```text
receive source
  -> authenticate source
  -> normalize identity and revision
  -> resolve workspace and Thread
  -> check duplicate subject and current revision
  -> parse objective and source facts
  -> apply source policy and safety classification
  -> create candidate or return existing Work Item
```

Source normalization rules:

- Channel messages use channel, thread, message and attachment identity. An edited message produces a new source revision and keeps the previous Work Item as history.
- GitHub subjects use repository, subject kind, number, base SHA, head SHA or event delivery id. A new head SHA always creates a new source revision for the same PR Work Item.
- Automations use definition id, scheduled occurrence or monitor fingerprint and source revision. One occurrence or fingerprint can create at most one Work Item.
- External Agents use caller id, caller task id, submission key and context digest. The same caller submission can be observed through more than one transport without duplication.
- Device Fabric nodes use graph id, node id, graph revision and owner-host execution id. The project Work Item references the owner journal instead of owning device effects.

Normalization preserves untrusted content as bounded source data. It does not execute commands, parse source prose as policy, or grant tools.

### 3.1 Autonomous intake policy

Each configured source declares `manual`, `suggest`, or `auto_start`, defaulting to `manual`. The rule binds a workspace and an authorized source scope, such as a repository and label or a designated channel. `suggest` registers a candidate for the user to accept. `auto_start` submits a matching candidate to the existing coordinator within the configured time window, budget and concurrency. That decision may route to a clarification, a proposal, a direct run or a workflow. Scoped tools, approvals and actual dispatch still use normal admission.

Qualification and dispatch recheck the source policy and revision. Paused sources keep their history and pending suggestions. Direct user requests and existing automation dispatch keep their existing entry paths. Where an enabled source already started a Task or AutomationRun, link that dispatch to the inbox item.

## 4. Assignment and Dispatch Claim

### 4.1 Assignment authority

Ling Agent Session handles unassigned intake work, explicit user intent and active-session follow-ups. The existing Task assignee or accepted Workflow step provides an assignment when present. A device node remains assigned by its own graph coordinator. Work Item uses the accepted route and assignee, including their revision and scope. If the assignee or source becomes stale, the owning route decides how to clarify, block or reassign. [Coordinator entry](../../packages/daemon/src/features/channels/messages.ts) · [Workflow selection](../../packages/daemon/src/features/channels/channel-intent-selector.ts)

### 4.2 Dispatch admission and deduplication

The claim records one first dispatch for a workspace, logical work item and accepted intake revision. Reuse the original dispatch receipt when it already exists. Otherwise record one accepted handoff with the source owner and link it to the normal dispatch path. Validate the accepted route, source revision and current policy together when committing the record. Capabilities, capacity, Worktree and permissions are also checked at the existing execution gate.

```text
normalize and deduplicate the source
  -> obtain or reference the existing assignment decision
  -> check revision, policy and prior receipt in the dispatch owner's transaction
  -> link existing dispatch, or record and enqueue this first dispatch once
  -> let the existing Task, Workflow and Runtime Supervisor admit execution
```

Concurrent deliveries or controller retries return the same receipt when the logical input matches. A different input or decision on an already accepted revision returns a conflict and current assignment. [Channel dispatch owner](../../packages/daemon/src/features/channels/channel-turn-dispatch-lifecycle.ts) · [Task claim at Run admission](../../packages/daemon/src/features/runs/concurrency.ts)

### 4.3 Execution recovery and reassignment

Work Item recovery follows the original dispatch reference. Expiry identifies a handoff to reconcile. Before another execution can start, the owning path checks the active Run, pending approval, leases and known or unknown effects. Use normal Session and Workflow operations for explicit reassignments, retries and cancellations. Each Workflow step keeps its own owner and execution lease. The inbox may prioritize which item to consider next, while assignment and recovery use the selected item's owning path.

## 5. Team Attention and Speaker Leases

The Attention Graph reads Work Item type, source, explicit mentions, active owner, Agent capability, current workload, risk and policy. It writes an `AttentionPlan` with observers, context depth, latency budget and review requirement.

The Speaker Lease is a short-lived durable projection tied to a Thread Turn. It contains speaker Agent id, source Turn, expected message revision and expiry. A speaker can publish one visible reply through the normal conversation input owner. Late or duplicate replies become folded observer evidence.

Execution ownership never follows a Speaker Lease automatically. The coordinator must create or select a Workflow/Run and the Daemon must perform normal admission.

Observer context levels remain those in Channel Team Operating System. Work Item source content is untrusted and scoped. A reviewer may see a captured Diff or artifact without seeing unrelated channel history.

### 5.1 Shared Evidence Board

The board is a Work Item view with an ordered log of contributions. Channel evidence, Verify, Code Assessment, CI and artifacts stay with their current stores. The board stores typed links to them and its own authored observations, proposals and challenges. References include the exact source ID, revision and digest where available. They are resolved by the source owner at the viewer's current scope. A board can collect evidence before a deliberation is started. [Team evidence store](../../packages/core/src/storage/sqlite/channel-team-evidence-store.ts) · [Channel context visibility](channel-context-processing-layer.md)

| Record | Required fields and ownership |
| --- | --- |
| Subject | Workspace, Work Item, accepted Work Item revision, linked Thread where present, Goal acceptance revision when applicable, and the frozen input digest. A code subject also carries the App Server candidate reference and digest. |
| Entry | Stable ID, entry revision, sequence within the Work Item, subject revision, kind, actor, source references, visibility, bounded summary and server timestamp. The server attaches Run, Attempt and Workflow step references for participant output. |
| Evidence link | Source owner and stable reference to an Artifact, Specialist Note, Verify result, Review finding or other authorized record. The owner supplies the result, evidence grade and applicability. |
| Correction | Target entry and expected entry revision, reason and replacement or withdrawal. The author or an authorized moderator can append it. A reader can inspect earlier revisions within the current visibility policy. |
| Decision link | The outcome and the source owner's accepted decision receipt. A reference points to the receipt for the accepted revision. |

Entry kinds are `observation`, `proposal`, `challenge`, `evidence_ref`, `correction`, `recommendation` and `decision_ref`. A proposal has an option ID and stated tradeoffs. A challenge points to an option or entry revision and records the objection. The recommendation references a sealed outcome. Ballots are stored as scoped round records. The read projection joins them after tally only for entitled viewers. Recommendation and decision records come from their respective owners. Claims inherit verified status only through matching source-owner evidence.

- Append checks the current Work Item revision, actor grant, referenced source scope and sender binding. Workflow output also checks the exact participant, step and current Attempt fence. Independent appends receive successive board sequence values in a transaction. A correction uses compare-and-set against the target entry revision. An identical retry returns the original receipt, and a conflicting payload using the same key returns `idempotency_conflict`.
- Contributions use the intersection of the Work Item, participant, source and caller scopes. The Context Processing Layer treats contribution text as data and builds prompt and reader views from scoped summaries and references. Synthesis, tally details, exports and replay follow those same scopes. A missing or withdrawn source has an unavailable reference. Where a summary cannot be safely projected with its permitted sources, the view withholds the summary.
- Each accepted mutation appends a content-minimal Control Plane event in the SQLite transaction. Board sequence orders entries within a Work Item. The App Server cursor covers the authorized projection across events. Clients can rebuild from a snapshot and apply entry revisions idempotently. A revoked client must renew authorization before receiving a new view.

### 5.2 Deliberation Workflow

The coordinator starts a deliberation under the admission policy below. A standalone request enters through the normal Work Item dispatch. A deliberation in an active Workflow uses that Workflow's assignment and step leases. The frozen inputs are the subject, question, acceptance criteria, participant identities and roles, policies, context scopes, round limit, deadline and token budget. The start receipt binds the selected template revision and current Work Item revision to the Workflow and roster. Required participants are resolved before admission. The daemon captures each effective Provider and model through the existing Runtime path.

The template materializes a bounded graph with admitted read-only participant steps and explicit fan-in points. Challenge rounds have a finite count declared at start. A further round after the graph closes requires a new accepted request linked to the earlier outcome. Typical roles are proposer, challenger and voter. The roster records each participant once and can allow one participant to serve several roles. Runtime Supervisor admits every step with the appropriate scope and capacity. Source evidence that needs an actual command or a browser check is produced through the existing Verify and Tool Broker path under its normal policy.

Ling Agent evaluates a concrete open decision at a checkpoint with committed inputs. The evaluation identifies the affected dependency, the current criteria and the smallest unresolved condition. Resolve missing user intent, required handoff inputs and disputed facts through their own owners before considering a choice among the remaining viable options.

| Checkpoint | Evaluation input and next action |
| --- | --- |
| Plan review | Identify unclear intent or acceptance criteria. Ask the user for a preference that the project record cannot supply. Compare viable plans when there is a consequential choice within the accepted scope. |
| Verify and Review conflict | Check the candidate, covered assertion and reproduction. Route disputed facts to the existing Verify or Review owner. A remaining tradeoff between supported remedies can qualify for deliberation. |
| Blocked stage or repeated failure | Use a changed blocker, a new diagnostic result or a newly recorded repeated failure. First resolve missing inputs or check the competing diagnoses. Compare recovery options if the blocker leaves a material choice. |
| Returned handoff | Repair missing, inaccessible or stale inputs with their owners. Evaluate a decision when current inputs still support more than one way to meet the downstream contract. |
| Scheduled checkpoint | Evaluate a recorded open decision when the configured coordination round closes with current evidence. The schedule supplies the checkpoint and its identity. |

| Entry | Admission |
| --- | --- |
| User request or accepted stage | Admit through the declared question, scope and participant policy. An explicit proposal stage can collect initial options within that scope. |
| Coordinator suggestion | Default for a decision raised during work. Show the question, viable options, evidence, applicable policy, roles and budget. Recheck the decision revision and grants when an authorized actor accepts the suggestion. |
| Configured automatic start | Requires an enabled project policy or an already accepted Workflow stage, with the checkpoint, decision kind and read-only scope declared. Daemon verifies option viability, required evidence, eligible roles, limits and available capacity at admission. |

Authorized project settings editors manage the versioned policy. An accepted Workflow can select an authorized preset or further restrict its scope. Freeze the effective policy revision on admission. Manual mode admits explicit requests and accepted deliberation stages. Suggest mode also evaluates the configured checkpoints and records suggestions for acceptance. The default suggestion policy covers the checkpoints in the table, with scheduled checkpoints enabled by their linked schedule. Auto-start mode admits matching decisions under the granted scope and limits. Deliberation admission has its own grant.

    type DeliberationCheckpoint =
      | "plan_review"
      | "verify_review_conflict"
      | "blocked_stage_changed"
      | "handoff_returned"
      | "repeated_failure"
      | "scheduled_checkpoint"

    type DecisionMateriality = "low" | "medium" | "high"
    type DeliberationDecisionKind =
      | "plan_or_contract"
      | "implementation_tradeoff"
      | "recovery_tradeoff"
      | "review_disposition"

    interface DeliberationTriggerPolicyV1 {
      readonly mode: "manual" | "suggest" | "auto_start"
      readonly allowedTriggers: readonly DeliberationCheckpoint[]
      readonly allowedDecisionKinds: readonly DeliberationDecisionKind[]
      readonly minimumViableOptions: number
      readonly minimumParticipants: number
      readonly requiredRoleIds: readonly string[]
      readonly minDecisionMateriality: DecisionMateriality
      readonly maxEvidenceAgeMs?: number
      readonly maxChallengeRounds: number
      readonly cooldownMs: number
      readonly ballotMode: "disabled" | "when_unresolved"
      readonly decisionOwner: { readonly kind: "ling_agent" | "user" }
        | { readonly kind: "assigned_role"; readonly roleId: string }
      readonly budget: { readonly maxTokens: number; readonly maxDurationMs: number }
    }

    interface DeliberationTriggerEvaluation {
      readonly workItemId: string
      readonly decisionId: string
      readonly subjectRevision: string
      readonly decisionRevision: string
      readonly policyRevision: string
      readonly decisionKind: DeliberationDecisionKind
      readonly decisionMateriality?: DecisionMateriality
      readonly checkpoint: DeliberationCheckpoint
      readonly checkpointRef: string
      readonly outcome: "clarify" | "verify" | "handoff_repair" | "suggest" | "start" | "defer" | "suppress"
      readonly reasonCode: string
      readonly reasonSummary: string
      readonly optionRefs: readonly string[]
      readonly evidenceRefs: readonly string[]
      readonly existingRoundId?: string
    }

Decision materiality measures the consequences of choosing between viable options. The order is `low < medium < high`. A local, easily reversible change is low. A module contract or a meaningful change to maintenance cost or test scope is medium. Public behavior, persistent data, permission boundaries, external effects or difficult rollback can make a choice high. The evaluation records the applicable impact and evidence. `minDecisionMateriality` sets the threshold for a spontaneous suggestion or automatic start. It defaults to medium.

Suggestions and automatic admission require at least two viable options and at least two distinct eligible participants. The effective policy also checks required roles and the accepted template. The default permits one challenge pass. Automatic admission requires explicit checkpoint and decision kind allowlists, an authorized decision owner, a finite budget and a declared cooldown for another revision of the same decision. The effective budget is bounded by the project, accepted Workflow and remaining Work Item limits. Runtime admission reserves capacity for each step from that budget. Voting requires the `when_unresolved` policy and the accepted roster and ballot rules.

Apply the current accepted subject, candidate, source visibility and required evidence at each admission, ballot freeze and decision. An optional maximum age adds a time limit measured from the source owner's evidence timestamp. At a plan checkpoint, viability is evaluated against the available plan evidence and constraints for that checkpoint. Implementation and delivery use their own required checks when a candidate exists.

Store the evaluation with its checkpoint receipt and Work Item decision revision. The stable decision ID names the question and its affected dependency. A materially changed relevant option or evidence snapshot, a changed accepted subject, or an accepted follow-up can create a linked successor revision. The tuple of Work Item, decision ID and decision revision admits at most one round. Bind its receipt to the subject digest and policy revision. Replayed notifications and concurrent callers resolve to the same record. A deferred admission can retry within its deadline and policy when capacity becomes available. Cooldown, insufficient scope, evidence, budget or options produce a reason visible to the coordinator.

| Phase | Frozen inputs and committed output |
| --- | --- |
| Propose | Participants see the same authorized question and criteria and submit independent options with evidence and tradeoffs. A fan-in step seals the eligible options and references for challenge. |
| Challenge | Each participant submits bounded objections, alternatives or evidence against those options. The final fan-in seals the option IDs, relevant evidence versions, subject digest and criteria in a ballot snapshot. It uses the common authorized context of the eligible voters. If required evidence falls outside this context, the round reports the missing scope or evidence. |
| Vote | When the effective policy permits voting and at least two viable options still present a material tradeoff after challenge, the Workflow admits one ballot step per eligible voter on the same current snapshot. Each ballot has the snapshot digest, authorized voter, one option or abstention, and a bounded rationale with evidence references. Ballot choices and tallies remain sealed from other voters while the round is open. |
| Tally and summarize | The host closes the admitted ballot set and computes the outcome. The Workflow selects direct synthesis when the vote conditions are unmet. Synthesis records the basis and dissent and identifies an unresolved choice or missing evidence for the decision owner. The accepted completion rules determine required steps for the selected path. |
| Decide | The authorized owner records how to proceed with the current subject. The result contributes to Plan or Goal context. Any follow-up with side effects is admitted through its normal Turn or Workflow, with that action's authority and acceptance checks. |

The phase is a view of Workflow steps and sealed outputs. Run status, cancellation and recovery retain their original owners. An exhausted stage budget, deadline, missing participant or invalidated snapshot is reported with a typed reason and the evidence collected so far. The Workflow applies its accepted required-participant and failure policy. A late result from an expired or superseded Attempt can be examined in its Run history and cannot enter a closed ballot set.

### 5.3 Tally, Decision and Applicability

- The host validates the exact round, ballot snapshot digest, voter identity and logical ballot receipt. A unique constraint on the round and canonical voter permits one accepted ballot. Exact retries retrieve the original receipt. A different ballot for the same voter reports the committed entry to that voter within scope. The host uses stable roster identities even when the display name or transport changes.
- The default weight is one per eligible voter. The default quorum is a majority of the frozen roster by voter count. An eligible abstention contributes to quorum and adds no support to an option. A recommendation requires support from more than half of the total eligible weight. A template may set positive integer weights or a stricter minimum quorum or support threshold before start. The host uses integer arithmetic and records the tally, missing ballots and abstentions.
- After all ballot steps resolve or the deadline arrives, the host closes and tallies the round in one store transaction. Ballot admission uses the server deadline and the current open state in that store. The close transaction first checks cancellation and current subject applicability. It reports `cancelled` or `stale` as applicable, then `insufficient_evidence` for missing required ballots, missing quorum or inaccessible required evidence. A tie or support below threshold yields `no_consensus`. If the supported option fails a required check or has an active required review blocker, the outcome is `blocked` with references to those records. An eligible option that meets the rule yields a `recommendation`. The sealed result includes the policy revision, input digest, tally and dissent references. Further deliberation uses a new round that links the earlier result.
- Resolve the accepted decision policy to an authorized user, Ling Agent or one explicitly assigned role before admission. Check that actor's current authority and the selected option against the outcome revision at decision time. An authorized owner can select an eligible option after a tie or defer the decision. Preserve the original tally and dissent and record the rationale and current evidence for a selection after a tie, an override or a deferral. If authority, user preference or required evidence is missing, wait for the applicable owner, input or check. Changes to accepted scope or criteria follow the existing Plan or Goal acceptance path. Approvals, Tool Broker, Verify, Review, CI and Delivery evaluate their own evidence.
- Subject changes, candidate drift, a changed acceptance revision or correction/withdrawal of evidence referenced by the sealed input makes the result stale for current use. Additional unrelated observations remain available on the board. Close and decision transactions compare the current subject and relevant source revisions to the sealed input. History retains the earlier options, result and receipt under their original scope.

### 5.4 Recovery and Projected Access

When the daemon restarts, it reloads the subject, admitted Workflow, stage snapshots, accepted ballots, stored receipts and remaining deadline and budget. The existing Runtime reconciles interrupted Runs. Phase, canonical tally and decision are recovered from records with unique keys for the round and accepted receipt. Cancel stops new stage admission and uses the existing stop and terminal evidence for active steps. Handoff records the current Work Item and board revision, sealed outcome when present, open question and original Workflow reference.

App Server and Ling clients use the same evidence projection. A protocol-visible board is bound to the Work Item's authorized Thread. A client reads a filtered snapshot and uses the work item or Thread subscription to catch up. Snapshots and retention follow the existing workspace store and cursor rules. If related evidence body retention expires, a remaining reference identifies it as unavailable. A stale or unauthorized reference cannot support a new recommendation or decision. Archive retains permitted decision and source references according to the Work Item and source retention policies.

While a ballot is sealed, its public Run and Item projections expose authorized phase and progress. Ballot text, rationale and intermediate results use the ballot scope across live deltas, artifacts and replay. The voter can retrieve its own accepted receipt. Closing the round publishes the scoped tally and dissent, with individual records available according to the accepted visibility policy.

### 5.5 Plan Stages and Stage Briefs

Plan preview binds each proposed stage, such as P01, to an explicit stable stage ID, goal and acceptance revision, required Workflow steps, dependencies, owner, recipients, expected outputs and acceptance conditions. On acceptance, the Workflow owns the steps and the Work Item projects their progress. A stage with several steps completes through the accepted fan-in conditions and required evidence for those steps. A display title or a checkbox in model text is descriptive input to this process. [Plan conversion](../../packages/core/src/storage/sqlite/proposed-plan-action-store.ts) · [Workflow completion](multi-agent-orchestrator.md)

| Event | Stage brief |
| --- | --- |
| Stage starts | Accepted scope, upstream decisions, input references, expected outputs and checks for the assigned participant. |
| Stage passes acceptance | Committed outcome, output version, artifact and verification references, decisions, remaining conditions and the input required by each successor. |
| Stage is blocked or its evidence changes | Current reason, missing or superseded references, affected successors and the participant who can resolve it. Independent steps remain eligible under their own conditions. |

Derive the brief from committed owner records and reuse Workflow output and context packets. The brief includes Work Item, accepted Plan and stage identity, subject and candidate references, source step or Run revision, scoped evidence, outstanding conditions and the next owner. For parallel work it references each accepted required result. An optional prose summary cites those records. Create one brief per Work Item, Plan revision, stage and committed source event. Deliver each role's projection once per brief and recipient. For example, implementation receives the accepted interface and input artifacts while QA receives the contract assertions and the candidate to verify. A changed Plan or candidate revalidates the affected dependency and preserves the earlier brief as history. The Workflow edge or existing assignment owns dispatch. [Step output packet](../../packages/daemon/src/features/channels/workflow-step-packets.ts) · [Successor context](../../packages/daemon/src/features/channels/context-processing/workflow-steps.ts)

### 5.6 Role-based Observation and Peer Questions

The existing Attention Plan can match role, accepted stage and event. For example, QA can receive a candidate-ready or acceptance-change signal, and the Plan owner can receive a question about scope. Each receiver gets the relevant authorized brief and source references. Observer Bus supplies scoped signals and recommendations. An admitted read-only review or an execution step follows the accepted assignment. Replay reprojects the signal without another paid observation or execution. [Observer Bus](../../packages/daemon/src/features/channels/observer-bus.ts) · [Observer scopes](channel-team-operating-system.md)

An assigned participant can send a targeted question to another participant in the same Work Item. The question stores its ID, sender grant, responsible respondent, stage and subject revision, affected input or dependency IDs, permitted source references, deadline and current revision. The ask and the corresponding message are committed together. A reply checks the responding grant and the question's open revision and commits one answer or escalation and its receipt. A question can reference its originating round and remain open until its own deadline after that round closes. Changes to the accepted Plan, assignments or tool scopes go to their respective owners.

The Workflow validates any wait against a required dependency of the affected step. A wait that would create a dependency cycle is rejected and escalated. An unreachable respondent or expired deadline also produces an escalation. The Workflow records one blocker for the question with its reason, affected edge and recovery owner. Ling Agent can route the blocker to a participant, request a check or ask the user. A reply with a superseded subject or an expired deadline stays in the originating history when available. The current dependency requires an applicable answer or an accepted resolution and the Workflow's ordinary readiness checks. On reconnect the question, blocker and any accepted reply use their original identities.

### 5.7 Handoff Acceptance and Repair

The Workflow prepares a handoff for the downstream dependency using the accepted source brief, required inputs and expected output, source candidate and evidence, source and target stage revisions, and the assigned receiving participant. It records the material on its existing handoff intent. Daemon derives the receiver from the authenticated grant or the bound Workflow step and current Attempt. A declared automated handoff can use the same Workflow acceptance path when its checks pass. [Existing handoff acceptance](../../packages/daemon/src/features/channels/workflow-handoffs.ts)

- Acceptance compares the expected intent revision and the current stage, candidate and evidence contract. One accepted receipt binds the source outcome, target stage, dependency, recipient and applicable revisions. Concurrent valid acceptance of the same revision resolves to that receipt. The original Workflow rechecks readiness and dispatches through the existing step claim and deduplication key.
- Return compares the expected intent revision and the current downstream dependency. It can record that the offered source material is stale. The receipt identifies the missing condition and repair owner. Typed reasons include `missing_artifact`, `required_check_incomplete`, `candidate_stale`, `scope_unavailable` and `upstream_effect_unknown`. The affected edge waits. A correction links the previous intent to an updated source revision and uses normal validation for a fresh acceptance.
- A live write lease, a pending approval or an unknown external effect uses the original owner's recovery path before transfer or retry. If the subject drifts after acceptance, the receipt remains visible as history. The Workflow revalidates against the current dependency before admitting any further step.

### 5.8 Coordination Rounds and Agent Messages

`CoordinationRound` records a scoped checkpoint for the Agents assigned to a Work Item. It reuses Automation scheduling, Attention Plan visibility and Control Plane events. Ling Agent or the recorded Workflow coordinator owns the round. The execution owner retains assignment and dispatch.

    type CoordinationRoundKind =
      | "kickoff"
      | "checkpoint"
      | "stage_review"
      | "incident_sync"
      | "retrospective"

    type CoordinationRoundStatus = "open" | "closed" | "cancelled" | "stale"
    type CoordinationTrigger =
      | { readonly kind: "event"; readonly sourceEventId: string }
      | { readonly kind: "schedule"; readonly automationId: string; readonly scheduledFor: string;
          readonly automationRunId: string }
      | { readonly kind: "manual"; readonly requestReceiptId: string }

    interface CoordinationRound {
      readonly id: string
      readonly workspaceId: string
      readonly workItemId: string
      readonly workflowId?: string
      readonly stageId?: string
      readonly coordinatorId: string
      readonly kind: CoordinationRoundKind
      readonly status: CoordinationRoundStatus
      readonly subjectRevision: string
      readonly policyRevision: string
      readonly trigger: CoordinationTrigger
      readonly participantRoleIds: readonly string[]
      readonly participantIds: readonly string[]
      readonly agendaRefs: readonly string[]
      readonly inputRefs: readonly string[]
      readonly throughMessageSequence?: number
      readonly outputBriefId?: string
      readonly decisionCandidateIds: readonly string[]
      readonly actionItemIds: readonly string[]
      readonly revision: string
      readonly createdAt: string
      readonly deadlineAt: string
      readonly closedAt?: string
      readonly closeReason?: "owner_closed" | "deadline" | "cancelled" | "inputs_changed"
    }

| Kind | Default trigger and recipients | Brief |
| --- | --- | --- |
| `kickoff` | Plan acceptance. The coordinator and assigned implementers and reviewers receive the scope relevant to their roles. | Accepted outcomes, owners, dependencies and checks for the first eligible steps. |
| `checkpoint` | A checkpoint declared in the accepted Plan, a manual request or a configured schedule. Stage and dependency owners receive updates. | Progress since the previous checkpoint, evidence changes and the next eligible work. |
| `stage_review` | A committed stage acceptance. Successor roles and the coordinator receive the result. | Accepted outputs and evidence, remaining conditions and the related stage briefs. |
| `incident_sync` | A new or changed canonical blocker, including handoff return or unknown outcome. The affected owners and coordinator receive the relevant facts. | Missing input or unresolved effect, affected dependencies, recovery owner and next checkpoint. |
| `retrospective` | A terminal Workflow state or an explicitly configured schedule. Contributors and the coordinator review outcomes. | Evidence-backed observations and action items with one accountable owner and a tracking reference. |

A committed event starts at most one round of its configured kind for the Work Item. Automation schedules may provide daily or weekly checkpoints or retrospectives. A Workflow or Goal schedule references its explicitly bound Work Item. An unresolved binding yields a skipped Automation result with a reason. Use the existing `AutomationRun` receipt and the occurrence identity `automationId` plus `scheduledFor` for deduplication. The scheduled action is limited to the coordination command. The accepted Plan controls which checks gate execution. Additional invited Agent turns use the existing participant, budget and Runtime admission paths. [Automation occurrence admission](../../packages/daemon/src/features/automations/run.ts)

The coordinator and the configured deadline use the same close transition. Closing checks the open round revision, current subject and policy, and seals the message sequence and evidence references for the brief. One transaction writes the terminal round, brief reference, action references and their Control Plane events. At a deadline, the brief records missing responses and unresolved questions. Cancellation or invalidation commits the terminal reason and retains authorized input and message history. Only the publish operation creates a current brief. A question linked to the round keeps its own deadline and applicability. A later reply is a Work Item message linked to the question, with the brief preserving the state captured at close. The brief references committed stage packets, results and decisions. It includes progress, blockers, open decisions and owned next steps, with the caller's current scope applied to each source and summary.

Round contributions and directed messages use a bounded `CoordinationMessage`. Parent input, child status and peer notes can be addressed during active work by a sender with the corresponding Work Item grant. Completion remains the Run or Workflow result. Wait and follow-up use the existing owner controls.

    type CoordinationMessageKind =
      | "note"
      | "status"
      | "question"
      | "answer"
      | "blocker"
      | "decision_candidate"
      | "action_update"

    interface CoordinationMessage {
      readonly id: string
      readonly roundId?: string
      readonly workItemId: string
      readonly stageId?: string
      readonly subjectRevision: string
      readonly senderId: string
      readonly senderAttemptId?: string
      readonly recipientIds: readonly string[]
      readonly kind: CoordinationMessageKind
      readonly bodySummary: string
      readonly sourceRefs: readonly string[]
      readonly questionId?: string
      readonly inReplyToMessageId?: string
      readonly sequence: number
      readonly revision: string
      readonly createdAt: string
    }

Daemon binds the sender to the authenticated actor or admitted Attempt. It resolves recipients against the accepted assignment or round roster and verifies the stage, subject and source scopes. Message bodies and references are visible to the sender, named recipients and actors with explicit coordination or audit grants, within their current scope. Writes use the method limits negotiated by App Server and the active context budget. A round append compares the open lifecycle revision. Parallel appends allocate distinct sequences without advancing that revision. Close and append serialize in the same store, so the sealed brief includes each contribution that committed before close. Question and answer messages are created by the question owner. Handoff state and acceptance are read from their Workflow receipts.

Each recipient's delivery is identified by message ID and recipient ID. Recheck the recipient grant and current applicability before the normal safe input boundary. An idle participant can receive a new Turn only through an authorized follow-up. Live notifications, replay and presence changes update the reader's view. Actual input admission uses the durable delivery identity and the existing conversation or Workflow receipt. Messages enter prompt context as scoped task data. Scope, ownership, permissions and acceptance changes use their existing owners.

## 6. External Agent Federation Protocol

External Agents use the Ling App Server protocol or a runner adapter. The federation facade adds Work Item identity and capability mapping.

### 6.1 Registration

```ts
interface ExternalAgentRegistration {
  readonly agentId: string;
  readonly adapterKind: "ling-app-server" | "codex-app-server" | "claude-agent" | "acp" | "mcp" | "custom";
  readonly protocolVersion: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  readonly workspaceScopes: readonly string[];
  readonly toolScopes: readonly string[];
  readonly approvalModes: readonly string[];
  readonly source: "local" | "workspace" | "managed";
  readonly version: string;
}
```

Registration is metadata. It does not create an executable permission. The Daemon resolves a runnable binding and approval profile for each Work Item.

### 6.2 Submission

```ts
interface ExternalAgentTaskSubmission {
  readonly workItemId: string;
  readonly workItemRevision: string;
  readonly objective: string;
  readonly acceptanceSnapshot: unknown;
  readonly workspaceId: string;
  readonly worktreeId?: string;
  readonly instructionManifestDigest: string;
  readonly skillSnapshot?: unknown;
  readonly parentLineage?: readonly string[];
  readonly idempotencyKey: string;
}
```

The adapter freezes the submission before dispatch. The external process receives only the projected context and capabilities. The adapter maps its event stream to `WorkItem`, `Turn`, `Run`, `Item`, `Approval`, `Artifact`, `Verification`, `Review`, and `Handoff` references.

### 6.3 Parent-child and recursion

Every federated task has `callerId`, `sourceWorkItemId`, `parentRunId`, `lineageDigest`, and `dispatchDepth`. A controller may delegate to an external Agent only when its policy allows that adapter kind. A child cannot submit the same objective and source digest back to its parent lineage. Depth, fan-out, time, token, and budget limits are enforced before dispatch.

### 6.4 Disconnect and unknown outcome

The adapter retains the original submission and Run fence. A connection loss changes observation state. It does not authorize a retry. Reconnect asks the external Agent for its current submission receipt and event cursor. A missing or conflicting receipt becomes `unknown_outcome` and requires owner reconciliation.

## 7. GitHub Delivery Loop

### 7.1 Subject identity

```ts
interface GitHubDeliverySubject {
  readonly repository: string;
  readonly kind: "issue" | "pull_request" | "check" | "review" | "comment" | "release";
  readonly numberOrName: string;
  readonly baseSha?: string;
  readonly headSha?: string;
  readonly sourceRevision: string;
}
```

The current head SHA is part of every Review, Verify, CI and Delivery acceptance. A result for an old SHA remains historical evidence and cannot approve or complete the current Work Item.

### 7.2 GitHub delivery projection

```text
unclaimed
  -> claimed
  -> workspace_preparing
  -> queued
  -> running
  -> review_required
  -> ci_pending
  -> delivery_pending
  -> delivered

review_required -> revision_requested | approved | blocked
ci_pending -> passed | failed | cancelled | stale
revision_requested -> queued
failed -> queued | blocked
stale -> queued
```

The GitHub adapter normalizes webhook, poll and manual import into one source identity. Duplicate deliveries return the existing Work Item and AutomationRun. A new head SHA supersedes pending review and verification for the old SHA while retaining their evidence.

### 7.3 Acceptance

Merge acceptance requires:

- current Work Item and PR head SHA;
- all required Goal criteria;
- required Verify results for the current candidate;
- required Review disposition;
- current CI result or an explicit repository policy exception;
- no pending Approval, unknown external effect, or active conflicting Worktree owner;
- an authorized user or repository policy decision.

The adapter records a merge receipt and lets Goal completion perform its normal evidence audit. A merge webhook after completion produces a source update, not a second completion.

## 8. Memory, Skills and Experience Candidates

The Work Item context builder returns source refs, instruction manifest, Skill snapshot, relevant Memory entries and current evidence. Each item is loaded according to its own scope and policy.

After a successful Work Item, the learning adapter can create:

```ts
interface ExperienceCandidate {
  readonly workItemId: string;
  readonly sourceRunId: string;
  readonly evidenceRefs: readonly string[];
  readonly procedure?: string;
  readonly correction?: string;
  readonly targetScope: "user" | "workspace" | "channel" | "teammate" | "skill";
  readonly sourceRevision: string;
  readonly status: "draft" | "reviewed" | "applied" | "rejected" | "expired";
}
```

Promotion uses Memory, Skill or Channel review. No candidate may change the current Work Item's permission profile, approval policy, provider, tool set, or Worktree scope.

## 9. Events and App Server Methods

The App Server adds these protocol projections to the existing Thread/Turn methods.

`workItem/accept` submits an authorized request for the current item revision through the coordinator and returns its receipt. `workItem/cancel` calls the existing owner for active work. External runner dispatch requires the assigned route and its receipt.

```text
workItem/create
workItem/read
workItem/list
workItem/accept
workItem/clarify
workItem/cancel
workItem/subscribe
workItem/delivery/read
workItem/feedback/add
externalAgent/register
externalAgent/capabilities/read
externalAgent/task/start
externalAgent/task/reconnect
externalAgent/task/cancel
delivery/read
github/subject/read
github/delivery/reconcile
```

Evidence, deliberation and Agent coordination use the optional `workItem.evidence`, `workItem.deliberation` and `workItem.coordination` capabilities. These methods require a Work Item ID and the applicable workspace, Thread and Work Item grants. The list views use opaque cursors bound to the caller and filters. Agent ballots and Workflow result packets enter through their dispatched step and fence. [App Server receipts and scopes](ling-app-server-detailed-design.md#2-协议标识方法与结果)

Mutations carry `expectedWorkItemRevision` and `idempotencyKey`, plus the applicable stage, subject and target revisions. Subject revision binds the accepted scope, Plan and Goal acceptance revisions, and the current candidate or input versions. The server derives actor identity from the authenticated grant or bound Attempt. It checks current access and action scope before disclosing an existing receipt. An exact retry by an authorized caller returns the committed receipt and entity reference. A different payload with the same scoped key returns `idempotency_conflict`. For a new write, compare the expected revisions and the current Attempt fence, then commit the mutation, receipt and event together. Work Item and stage revisions represent their owners' state. A message append uses its own sequence and leaves other participants eligible to append to the same round revision.

| Method | Additional input and effect |
| --- | --- |
| `workItem/evidence/read` | Work Item ID and optional page cursor. Returns visible entries, board revision and a resume cursor for the authorized view. |
| `workItem/evidence/append` | Subject digest and bounded contribution. Corrections include target ID and expected entry revision. Requires a contribution grant. |
| `workItem/deliberation/start` | Authorized template revision, subject digest and accepted question or stage reference. An accepted suggestion supplies its decision ID and expected decision revision. The coordinator returns the round and Workflow receipt after admission. |
| `workItem/deliberation/read` | Decision or round ID and optional page cursor. Returns the visible trigger evaluation, phase, budget state, sealed outcome and decision as available. |
| `workItem/deliberation/cancel` | Round ID and expected round revision. The Workflow owner returns its stop request receipt. |
| `workItem/deliberation/decide` | Round ID, expected sealed outcome revision and the decision with its reason when required. The decision owner checks the current subject and commits the accepted receipt. |
| `workItem/stage/read` | Stage ID and optional revision. Returns the accepted stage contract, current owner, dependencies and status. |
| `workItem/stage/brief/read` | Stage ID and optional brief ID. Returns the currently visible projection of that brief, or the latest brief, with source revisions and applicability. |
| `workItem/coordination/start` | Kind, subject revision, stage if applicable, requested participant roles, agenda and deadline within the accepted policy. The coordinator receives the round receipt. Scheduled starts enter through the linked Automation occurrence. |
| `workItem/coordination/read` | Round ID. Returns the visible roster, status and revision, sealed brief and action items when published. Messages are available by round. |
| `workItem/coordination/close` | Round ID, expected round revision and subject, plus publish or cancel disposition. Requires the coordinator grant. Publish returns the committed brief ID. Cancel takes a reason and commits the terminal receipt. |
| `workItem/message/send` | Recipient IDs or authorized role selectors, stage when applicable, subject revision, kind (`note`, `status`, `blocker`, `decision_candidate` or `action_update`), bounded summary and source refs. Include the round ID and expected open round revision for a contribution. Returns the message receipt and delivery references within scope. |
| `workItem/message/read` | Message ID. Returns the currently visible message and its applicable delivery status. |
| `workItem/message/list` | Optional round or stage ID and page cursor. Returns ordered messages in the caller's scope. |
| `workItem/question/ask` | Responsible respondent, subject revision, affected dependencies, bounded question, source refs and reply deadline. Include stage and open round revisions when applicable. Returns one question and message receipt. |
| `workItem/question/read` | Question ID. Returns the visible question, reply status, current revision and related blocker. |
| `workItem/question/reply` | Question ID, expected question revision and subject, bounded answer or typed escalation, and source refs. Returns the reply or blocker receipt. |
| `workItem/handoff/read` | Handoff ID or stage pair. Returns the source brief, target requirement, validation and current receipt. |
| `workItem/handoff/accept` | Handoff ID, expected handoff and target stage revisions and current subject. Acceptance binds the authenticated recipient to the checked source revision. The existing Workflow owns subsequent dispatch. |
| `workItem/handoff/return` | Handoff ID, expected handoff and target stage revisions, current target subject, typed missing condition and source refs. Returns the repair receipt for that dependency. |

Notifications use the existing event envelope and include `workItemId`, `workItemRevision`, `claimId`, `sourceRevision`, and `deliveryId` where applicable.

```text
workItem/created
workItem/claimed
workItem/status/changed
workItem/claim/expired
workItem/delivery/updated
workItem/feedback/received
workItem/evidence/updated
workItem/deliberation/updated
workItem/stage/updated
workItem/brief/updated
workItem/coordination/updated
workItem/message/updated
workItem/question/updated
workItem/handoff/updated
externalAgent/registered
externalAgent/task/started
externalAgent/task/reconnected
externalAgent/task/unknown
github/subject/updated
```

These notifications carry IDs and revisions for an authorized read. `workItem/brief/updated` identifies the stage or round and its brief ID. `workItem/deliberation/updated` identifies the decision revision and includes a round ID when admitted. The Work Item snapshot includes visible active round, decision, question and handoff references. Use `workItem/subscribe` or the authorized Thread subscription for catch-up with the same Control Plane cursor, scope and redaction as live delivery. A reconnect can recover messages and results by ID and reuse existing receipts. Input delivery and downstream execution use their own admission paths.

## 10. Persistence and Recovery

Use existing Thread, Task, Goal, AutomationRun, Workflow, Run, Approval, Worktree, Delivery, and Control Plane owners. Add an integration record only where an existing owner cannot express source identity, claim revision, delivery receipt, or feedback lineage.

Candidate tables or records:

```text
agent_work_items
agent_work_item_events
agent_deliveries
external_agent_registrations
external_agent_submissions
```

Every record includes workspace scope, owner, revision, created/updated times, source identity, and retention policy. Work Item stores the accepted dispatch reference or a first-intake receipt where the source has no existing dispatch. The existing owner owns its execution claim and lease. Work Item event append participates in the source or dispatch transaction for deduplication. External Delivery and unknown outcomes use their own intent/receipt/reconciliation records.

Evidence entries, sealed rounds, ballots and decision receipts use Work Item-scoped relations in the same workspace SQLite store. Their lifecycle migrations cover opening existing work items with an empty board, replay across restart and concurrent submission. Workflow and source evidence stay addressable through their existing keys. Section 5 defines the commit and recovery rules for these relations.

Coordination rounds, messages, stage briefs and peer questions use Work Item-scoped relations. Enforce unique occurrence keys for round admission and one brief per applicable stage event or published round. Enforce unique message sequences and receipts, plus one delivery per message and recipient. Extend the existing Workflow handoff intent and acceptance receipt for stage and candidate binding. A migration can open existing Work Items with empty coordination projections. Persist deadlines and pending deliveries so Daemon can resume them through their owners after restart. Round close, brief publication and their content-minimal Control Plane events share one transaction. An interrupted delivery retries with the existing input receipt key after checking current scope and applicability.

Recovery rules:

- a duplicate source returns the existing Work Item;
- a stale dispatch reference is visible and follows the source owner's recovery;
- a Run continues through Runtime Supervisor recovery;
- an external Agent disconnect does not retry the effect;
- a GitHub head change supersedes old pending checks;
- a Delivery with unknown outcome waits for reconciliation;
- follow-up uses the explicit accepted Task, Turn or Workflow and its normal continuation path;
- archived Work Items retain source, delivery and evidence references.

## 11. Detailed Acceptance Matrix

| Area | Required test |
| --- | --- |
| Intake | duplicate channel edit, duplicate webhook, monitor fingerprint, external submission and device node all create one current Work Item |
| Dispatch | webhook or client retries share one receipt, explicit assignment and active follow-up stay with the current coordinator, a parallel Workflow retains per-step leases, and stale or unknown dispatch waits for reconciliation |
| Autonomous intake | default manual, user acceptance of suggestions, opted-in scoped auto-start, pause, quiet hours and budget limits, and an existing AutomationRun linked without launching twice |
| Team | observer cannot speak, speaker lease expiry, late reply, reviewer read lease and execution ownership |
| Shared evidence | simultaneous appends both survive, correction CAS rejects a stale revision, retries return the same receipt, restricted refs and derived text stay scoped through live read, replay, reconnect and revocation |
| Stage and peer coordination | stage identity binds the accepted Plan, required parallel results close the stage, the role-scoped brief reaches the proper successor, a question holds only its dependency, and timeout and mutual wait produce one blocker with a recovery owner |
| Coordination cadence and messages | event and scheduled occurrence deduplication, concurrent contribution and close ordering, atomic brief publication, cancellation and stale history, a reply after close, duplicate delivery after restart, and current scope checks on receipt retry including revoked roles |
| Returned handoff | a stale candidate or missing input is returned with its reason, corrected evidence is revalidated, concurrent acceptance resolves to one receipt, one current dispatch follows from the original dependency, and an unknown effect stays with its original owner |
| Deliberation admission | clarification, verification and repair precede consideration of viable choices, default suggests and authorized automatic admission uses one receipt, materiality and role thresholds, cooldown and budget are enforced, and new relevant evidence can supersede an earlier decision revision |
| Deliberation | frozen subject, same ballot snapshot, roster/quorum and weights, sealed ballot visibility on live and replay, abstention, tie, missing evidence, late or duplicate ballot, bounded termination, source or candidate drift, and restart during vote and tally |
| Decision handoff | recorded recommendation and dissent can be inspected, a required failing check blocks a highly supported option, an explicit decision routes through the original owner, and a vote cannot grant tools or satisfy an Approval, Verify or Delivery condition |
| External Agent | handshake, capability mismatch, approval request, reconnect, replay, cancel, unknown effect and recursion rejection |
| GitHub | new head supersedes old review, duplicate event, CI failure follow-up, merge acceptance, stale review and unknown comment delivery |
| Memory/Skill | evidence-bound candidate, review, reject, expire and authority-preserving promotion |
| Recovery | Daemon restart, client reconnect, source change, Worktree conflict and active claim reconciliation |
| App Server | event replay, Work Item methods, delivery methods, scope checks, cursor resync and redaction |
