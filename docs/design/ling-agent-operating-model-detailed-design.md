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

Notifications use the existing event envelope and include `workItemId`, `workItemRevision`, `claimId`, `sourceRevision`, and `deliveryId` where applicable.

```text
workItem/created
workItem/claimed
workItem/status/changed
workItem/claim/expired
workItem/delivery/updated
workItem/feedback/received
externalAgent/registered
externalAgent/task/started
externalAgent/task/reconnected
externalAgent/task/unknown
github/subject/updated
```

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
| External Agent | handshake, capability mismatch, approval request, reconnect, replay, cancel, unknown effect and recursion rejection |
| GitHub | new head supersedes old review, duplicate event, CI failure follow-up, merge acceptance, stale review and unknown comment delivery |
| Memory/Skill | evidence-bound candidate, review, reject, expire and authority-preserving promotion |
| Recovery | Daemon restart, client reconnect, source change, Worktree conflict and active claim reconciliation |
| App Server | event replay, Work Item methods, delivery methods, scope checks, cursor resync and redaction |
