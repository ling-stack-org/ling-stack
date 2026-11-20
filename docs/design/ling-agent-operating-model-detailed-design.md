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

The coordinator starts a deliberation from an authorized user request or a stage selected in an accepted Workflow template. A standalone request enters through the normal Work Item dispatch. A stage in an active Workflow uses that Workflow's assignment and step leases. The frozen inputs are the subject, question, acceptance criteria, participant identities and roles, policies, context scopes, round limit, deadline and token budget. The start receipt binds the selected template revision and current Work Item revision to the Workflow and roster. Required participants are resolved before admission. The daemon captures each effective Provider and model through the existing Runtime path.

The template materializes a bounded graph with admitted read-only participant steps and explicit fan-in points. Challenge rounds have a finite count declared at start. A further round after the graph closes requires a new accepted request linked to the earlier outcome. Typical roles are proposer, challenger and voter. The roster records each participant once and can allow one participant to serve several roles. Runtime Supervisor admits every step with the appropriate scope and capacity. Source evidence that needs an actual command or a browser check is produced through the existing Verify and Tool Broker path under its normal policy.

| Phase | Frozen inputs and committed output |
| --- | --- |
| Propose | Participants see the same authorized question and criteria and submit independent options with evidence and tradeoffs. A fan-in step seals the eligible options and references for challenge. |
| Challenge | Each participant submits bounded objections, alternatives or evidence against those options. The final fan-in seals the option IDs, relevant evidence versions, subject digest and criteria in a ballot snapshot. It uses the common authorized context of the eligible voters. If required evidence falls outside this context, the round reports the missing scope or evidence. |
| Vote | A vote-enabled template admits one ballot step per eligible voter using the same sealed snapshot. Each ballot has the snapshot digest, authorized voter, one option or abstention, and a bounded rationale with evidence references. Ballot choices and tallies remain sealed from other voters while the round is open. |
| Tally and summarize | The host closes the ballot set and computes the outcome. A synthesis step can explain the result and retain dissent with its source references. A template without voting can synthesize directly from the sealed proposals and challenges. |
| Decide | The authorized owner records how to proceed with the current subject. The result contributes to Plan or Goal context. Any follow-up with side effects is admitted through its normal Turn or Workflow, with that action's authority and acceptance checks. |

The phase is a view of Workflow steps and sealed outputs. Run status, cancellation and recovery retain their original owners. An exhausted stage budget, deadline, missing participant or invalidated snapshot is reported with a typed reason and the evidence collected so far. The Workflow applies its accepted required-participant and failure policy. A late result from an expired or superseded Attempt can be examined in its Run history and cannot enter a closed ballot set.

### 5.3 Tally, Decision and Applicability

- The host validates the exact round, ballot snapshot digest, voter identity and logical ballot receipt. A unique constraint on the round and canonical voter permits one accepted ballot. Exact retries retrieve the original receipt. A different ballot for the same voter reports the committed entry to that voter within scope. The host uses stable roster identities even when the display name or transport changes.
- The default weight is one per eligible voter. The default quorum is a majority of the frozen roster by voter count. An eligible abstention contributes to quorum and adds no support to an option. A recommendation requires support from more than half of the total eligible weight. A template may set positive integer weights or a stricter minimum quorum or support threshold before start. The host uses integer arithmetic and records the tally, missing ballots and abstentions.
- After all ballot steps resolve or the deadline arrives, the host closes and tallies the round in one store transaction. Ballot admission uses the server deadline and the current open state in that store. The close transaction first checks cancellation and current subject applicability. It reports `cancelled` or `stale` as applicable, then `insufficient_evidence` for missing required ballots, missing quorum or inaccessible required evidence. A tie or support below threshold yields `no_consensus`. If the supported option fails a required check or has an active required review blocker, the outcome is `blocked` with references to those records. An eligible option that meets the rule yields a `recommendation`. The sealed result includes the policy revision, input digest, tally and dissent references. Further deliberation uses a new round that links the earlier result.
- The decision owner is an authorized user or Ling Agent acting under the accepted decision policy. The normal owner validates the selected option and its criteria and records one decision per accepted outcome. A different choice or a deferral records the reason and evidence. No-consensus and insufficient-evidence results can request clarification or new checks. If a decision requires changes to accepted scope or criteria, the owner records a new acceptance revision through the existing Plan or Goal path. Approvals, Tool Broker, Verify, Review, CI and Delivery continue to evaluate their own evidence.
- Subject changes, candidate drift, a changed acceptance revision or correction/withdrawal of evidence referenced by the sealed input makes the result stale for current use. Additional unrelated observations remain available on the board. Close and decision transactions compare the current subject and relevant source revisions to the sealed input. History retains the earlier options, result and receipt under their original scope.

### 5.4 Recovery and Projected Access

When the daemon restarts, it reloads the subject, admitted Workflow, stage snapshots, accepted ballots, stored receipts and remaining deadline and budget. The existing Runtime reconciles interrupted Runs. Phase, canonical tally and decision are recovered from records with unique keys for the round and accepted receipt. Cancel stops new stage admission and uses the existing stop and terminal evidence for active steps. Handoff records the current Work Item and board revision, sealed outcome when present, open question and original Workflow reference.

App Server and Ling clients use the same evidence projection. A protocol-visible board is bound to the Work Item's authorized Thread. A client reads a filtered snapshot and uses the work item or Thread subscription to catch up. Snapshots and retention follow the existing workspace store and cursor rules. If related evidence body retention expires, a remaining reference identifies it as unavailable. A stale or unauthorized reference cannot support a new recommendation or decision. Archive retains permitted decision and source references according to the Work Item and source retention policies.

While a ballot is sealed, its public Run and Item projections expose authorized phase and progress. Ballot text, rationale and intermediate results use the ballot scope across live deltas, artifacts and replay. The voter can retrieve its own accepted receipt. Closing the round publishes the scoped tally and dissent, with individual records available according to the accepted visibility policy.

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

Evidence and deliberation methods are optional negotiated capabilities. All methods check the linked Thread and Work Item scope. Mutations require the expected Work Item revision and an idempotency key, and return the committed revision and entity reference. Agent ballots and Workflow result packets enter through their dispatched step and fence. [App Server receipts and scopes](ling-app-server-detailed-design.md#2-协议标识方法与结果)

| Method | Additional input and effect |
| --- | --- |
| `workItem/evidence/read` | Work Item ID and optional page cursor. Returns visible entries, board revision and a resume cursor for the authorized view. |
| `workItem/evidence/append` | Subject digest and bounded contribution. Corrections include target ID and expected entry revision. Requires a contribution grant. |
| `workItem/deliberation/start` | Authorized template revision, subject digest and accepted question or stage reference. The coordinator returns the round and Workflow receipt after admission. |
| `workItem/deliberation/read` | Round ID and optional page cursor. Returns the visible phase, budget state, sealed outcome and decision when available. |
| `workItem/deliberation/cancel` | Round ID and expected round revision. The Workflow owner returns its stop request receipt. |
| `workItem/deliberation/decide` | Round ID, expected sealed outcome revision and the decision with its reason when required. The decision owner checks the current subject and commits the accepted receipt. |

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
externalAgent/registered
externalAgent/task/started
externalAgent/task/reconnected
externalAgent/task/unknown
github/subject/updated
```

Evidence and deliberation notifications carry IDs and versions for an authorized read. Replay applies the same scope and redaction as live delivery. A reconnect reads the final board snapshot and phase or decision without starting work.

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
| Deliberation | frozen subject, same ballot snapshot, roster/quorum and weights, sealed ballot visibility on live and replay, abstention, tie, missing evidence, late or duplicate ballot, bounded termination, source or candidate drift, and restart during vote and tally |
| Decision handoff | recorded recommendation and dissent can be inspected, a required failing check blocks a highly supported option, an explicit decision routes through the original owner, and a vote cannot grant tools or satisfy an Approval, Verify or Delivery condition |
| External Agent | handshake, capability mismatch, approval request, reconnect, replay, cancel, unknown effect and recursion rejection |
| GitHub | new head supersedes old review, duplicate event, CI failure follow-up, merge acceptance, stale review and unknown comment delivery |
| Memory/Skill | evidence-bound candidate, review, reject, expire and authority-preserving promotion |
| Recovery | Daemon restart, client reconnect, source change, Worktree conflict and active claim reconciliation |
| App Server | event replay, Work Item methods, delivery methods, scope checks, cursor resync and redaction |
