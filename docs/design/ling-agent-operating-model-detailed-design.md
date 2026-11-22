# Ling Agent Operating Model 详细设计

- **Status** 目标态详细合同，运行时实现状态见 App Server 实施计划
- **Owner** Conversation、Core、Daemon、External Agent、GitHub Automation 与开发工具维护者
- **Last verified** 2026-11-22 against `origin/main@a9dd29921`
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
| Accepted scope change | Conversation input owner, Plan/Goal acceptance owner, and affected execution owners | Scoped admission hold, applicability decisions and accepted successor lineage |
| Progress across Runs | Goal supervision and Workflow coordinator | Current blocker, evidence delta, remaining budget and recovery owner |
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

The first authorized Thread binding sets the primary `threadId`. The first Workflow that owns primary assignment sets `workflowId` for that execution lineage. Handoffs to a different Thread, successor Workflows and linked deliberations add typed references to the originating owner, target and accepted revision. Current execution is resolved from the accepted revision, dispatch receipts and per-step leases. Work Item snapshots and events project each related Thread, Turn, Run, Item and Workflow only within that reference's own grants.

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
waiting_for_approval -> running | blocked | cancelled
waiting_for_input -> running | blocked | cancelled
verification_required -> running | review_required | blocked | failed
review_required -> running | delivery_pending | blocked | failed
delivery_pending -> delivered | blocked | failed
blocked -> planning | queued | running | verification_required | review_required | delivery_pending | cancelled | superseded
failed -> queued | blocked | cancelled | superseded
cancelled -> archived | candidate
superseded -> archived | candidate
delivered -> archived | candidate
```

`blocked` and `failed` return to an executable state only through an owner receipt that identifies new applicable evidence, an accepted successor Plan, or an explicitly authorized retry. `cancelled` and `superseded` close the current execution lineage. Their transition to `candidate` represents a new source revision or explicit follow-up with a new lineage and acceptance basis. It does not reopen historical execution or replay an old dispatch.

An intake state transition carries `workItemRevision`, `actor`, `sourceEventId`, an idempotency key, and claim or Goal references when present. A stale transition returns the current projection.

## 3. Intake Normalization

The intake path normalizes a bounded event, persists a candidate or returns an existing work item, and passes an accepted item to the existing coordinator. A source event already linked to a Task, Turn, Workflow or AutomationRun uses the existing record.

```text
receive source
  -> authenticate source
  -> normalize identity and revision
  -> resolve workspace and an authorized Thread when present
  -> resolve any explicit target and check its current binding
  -> check occurrence receipt and applicable revision
  -> parse objective and source facts
  -> apply source policy and safety classification
  -> create candidate or return existing Work Item
```

Source normalization rules:

- Channel messages use channel, thread, message and attachment identity. An edit has its own input revision and can propose a change to the already linked Work Item.
- GitHub sources preserve provider delivery IDs and source revisions. Repository ID, subject kind and number identify the stable subject. Base and head SHA describe the PR revision and its evidence basis.
- Automations use definition id, scheduled occurrence or monitor fingerprint and source revision. One occurrence or fingerprint can create at most one Work Item.
- External Agents use caller id, caller task id, submission key and context digest. The same caller submission can be observed through more than one transport without duplication.
- Device Fabric nodes use graph id, node id, graph revision and owner-host execution id. The project Work Item references the owner journal instead of owning device effects.

Normalization preserves untrusted content as bounded source data. It does not execute commands, parse source prose as policy, or grant tools.

### 3.1 Autonomous intake policy

Each configured source declares `manual`, `suggest`, or `auto_start`, defaulting to `manual`. The rule binds a workspace and an authorized source scope, such as a repository and label or a designated channel. `suggest` registers a candidate for the user to accept. `auto_start` submits a matching candidate to the existing coordinator within the configured time window, budget and concurrency. That decision may route to a clarification, a proposal, a direct run or a workflow. Scoped tools, approvals and actual dispatch still use normal admission.

The source rule is a versioned record rather than free-form configuration. Its public shape is:

```ts
interface AutonomousIntakePolicyV1 {
  readonly id: string;
  readonly revision: string;
  readonly workspaceId: string;
  readonly sourceKind: WorkItemSource["kind"];
  readonly sourceScope: string;
  readonly mode: "manual" | "suggest" | "auto_start";
  readonly enabled: boolean;
  readonly priority: "low" | "normal" | "high" | "urgent";
  readonly quietHours?: { readonly timeZone: string; readonly start: string; readonly end: string };
  readonly budget: { readonly maxConcurrent: number; readonly maxStartsPerWindow: number; readonly windowMs: number };
  readonly pauseReason?: string;
}

interface AutonomousIntakeEvaluation {
  readonly policyId: string;
  readonly policyRevision: string;
  readonly sourceEventId: string;
  readonly outcome: "manual" | "suggested" | "accepted" | "suppressed" | "paused" | "deduplicated";
  readonly reasonCode: string;
  readonly receiptId: string;
}
```

An evaluation freezes the policy revision, source scope and occurrence identity. `auto_start` can only produce a first dispatch intent after this receipt commits. Quiet hours, source pause, concurrency and budget produce a durable suppressed result that can be inspected and retried under a current policy. Scheduled daily or weekly coordination continues to use the existing Automation policy and its occurrence receipt, while this type governs whether the resulting Work Item may enter the coordinator.

Qualification and dispatch recheck the source policy and revision. Paused sources keep their history and pending suggestions. Direct user requests and existing automation dispatch keep their existing entry paths. Where an enabled source already started a Task or AutomationRun, link that dispatch to the inbox item.

### 3.2 Work Item Target Identity

A registered App Server GitHub repository can set an `intake` policy with `mode`, `enabled`, optional `requiredLabel` and `priority`, and a signed Automation `webhookSourceId`. The local operator can poll a page of open subjects using `github/intake/poll`. Without an explicit mode the poll records a manual evaluation. A suggested subject uses the existing intake Work Item and waits for acceptance.

The signed webhook route validates the immutable repository ID and commits its inbox event with the pending intake target. The Automation event worker rechecks its source revision and registered repository, reads the current subject from GitHub, and records the evaluation. Suggestions bind the Work Item, source occurrence and evaluation in one transaction. `github/intake/read` can recover the occurrence receipt by ID. Poll and webhook receipts have separate occurrence IDs and share the verified target identity.

Each workspace has one default Work Item binding for an exact target. The target is either a resolved Work Item ID or a GitHub subject identified by the verified GitHub instance, immutable repository ID, subject kind and number. An existing Work Item ID addresses that item directly. For GitHub, the adapter resolves an authorized repository-qualified URL, structured submission or an explicit Issue/PR number in a conversation with a single repository binding. An unresolved or ambiguous target uses clarification or an authorization outcome before implementation dispatch. Titles, matching descriptions, labels, branches and references copied from issue bodies are context for a proposal. Automatic binding requires an explicit target from authorized input or a verified source event.

    type WorkItemTarget =
      | { readonly kind: "work_item"; readonly workItemId: string }
      | {
          readonly kind: "github"
          readonly githubInstanceId: string
          readonly repositoryId: string
          readonly subjectKind: "issue" | "pull_request"
          readonly subjectNumber: number
        }

    interface WorkItemTargetIdentity {
      readonly workspaceId: string
      readonly target: WorkItemTarget
      readonly effort:
        | { readonly kind: "primary" }
        | { readonly kind: "independent"; readonly acceptanceReceiptId: string }
    }

Use the primary effort by default. An accepted independent-effort proposal supplies its own objective, Worktree, acceptance basis and receipt ID. Source delivery IDs and head revisions identify occurrences and revisions of this same target.

| Input | Owner route |
| --- | --- |
| Repeated occurrence or exact API retry | Resolve the existing source or request receipt. Project the same binding and accepted dispatch within the caller's current scope. |
| New request for a target with active work | Preserve the new source and requested intent on that Work Item. The current coordinator routes questions, follow-ups or a Plan change through the existing input and change rules. |
| Request for a completed target or a provider reopen | Resolve the same Work Item and preserve its completed receipts. A verified reopen supplies a new source revision. Another implementation proceeds through a newly accepted execution revision under the applicable source policy and original-owner reconciliation. |
| Explicit independent work for the same target | Require an authorized acceptance with its own objective, worktree and execution scope. The acceptance identifies one related Work Item and links it to the default binding. It has its own dispatch key and normal authorization. |

Source receipts remain distinct for webhook, poll, chat and client submissions. Append their provenance and authorized target links on the shared Work Item so each source can follow its own accepted result. GitHub Issue and PR identities remain independently addressable. A confirmed Delivery or an authorized typed relation can bind a PR's feedback to the implementing Work Item. An available default PR binding can point to that Work Item. Where a different live PR Work Item already exists, retain both ownership records, project the relationship only within its grant and route the conflict to the coordinator before accepting another dispatch. A close or reopen event updates source facts in provider order. Goal and Delivery outcomes continue to use their actual evidence owners.

Check source authority, credentials and the requested action grant before binding or dispatch. Apply current Work Item and Thread grants before returning an existing target or receipt. A denied or unavailable explicit target uses the same bounded target-unavailable projection. Thread, assignee, history and receipt references require their own grants. Access to one source authorizes only that source's projection. A repository transfer, redirected issue or cross-workspace reference is resolved and authorized by its provider owner before an existing binding can apply.

Use the existing source-key Work Item upsert for source-local observations. Add the unique workspace target binding and its accepted owner in the Work Item store. In one workspace-store transaction, check current source policy and target revision, resolve or create the default binding, attach the occurrence and commit any first accepted dispatch intent. Readiness and actual dispatch follow section 4.2. [Current source-key store](../../packages/core/src/storage/sqlite/work-item-store.ts) · [Automation event intake](../../packages/daemon/src/features/automations/event-worker.ts) · [External Work admission](../../packages/core/src/external-work-scheduler.ts)

## 4. Assignment and Dispatch Claim

### 4.1 Assignment authority

Ling Agent Session handles unassigned intake work, explicit user intent and active-session follow-ups. The existing Task assignee or accepted Workflow step provides an assignment when present. A device node remains assigned by its own graph coordinator. Work Item uses the accepted route and assignee, including their revision and scope. If the assignee or source becomes stale, the owning route decides how to clarify, block or reassign. [Coordinator entry](../../packages/daemon/src/features/channels/messages.ts) · [Workflow selection](../../packages/daemon/src/features/channels/channel-intent-selector.ts)

### 4.2 Dispatch admission and deduplication

The claim records one first dispatch for a workspace, logical Work Item and accepted execution revision. Every entry path resolves the target before creating an implementation Task, Turn or Run. Reuse an authoritative dispatch receipt when it already exists. Otherwise the target binding's owner records one accepted dispatch intent with the accepted route, input revision and policy. The dispatch owner uses that receipt's logical identity for admission, including after restart. Capabilities, capacity, Worktree and permissions are checked at the existing execution gate.

```text
normalize the source and resolve the target binding
  -> obtain or reference the existing assignment decision
  -> check revision, policy and prior receipt in the dispatch owner's transaction
  -> link existing dispatch, or persist and enqueue this first dispatch once
  -> let the existing Task, Workflow and Runtime Supervisor admit execution
```

Concurrent deliveries or controller retries return the same receipt when the logical input matches. Distinct occurrences for the same target link to the current assignment and use the follow-up or scope-change path for their new intent. If the execution owner is on another host, the Work Item store retains the admitted intent and its logical identity while the adapter reconciles the exact owner receipt. An unconfirmed outcome holds another dispatch. In a legacy conflict with multiple live owners, expose the conflict within scope and reconcile their outstanding effects before a further dispatch can be accepted. [Channel dispatch owner](../../packages/daemon/src/features/channels/channel-turn-dispatch-lifecycle.ts) · [Task claim at Run admission](../../packages/daemon/src/features/runs/concurrency.ts)

### 4.3 Execution recovery and reassignment

Work Item recovery follows the original dispatch reference. Expiry identifies a handoff to reconcile. Before another execution can start, the owning path checks the active Run, pending approval, leases and known or unknown effects. Use normal Session and Workflow operations for explicit reassignments, retries and cancellations. Each Workflow step keeps its own owner and execution lease. The inbox may prioritize which item to consider next, while assignment and recovery use the selected item's owning path.

### 4.4 In-flight Inputs and Accepted Plan Revisions

The Conversation/Turn owner commits each authenticated user input with its source, target and idempotent receipt. The accepted Work Item scope, Plan, Goal and active Attempt are separate revision bases. Untrusted issue text, tool output and teammate messages can propose context through their own routes. Only a current authorized input or accepted policy can place a Work Item admission hold.

| Input during work | Owning action |
| --- | --- |
| Status question | Answer promptly using the current authorized committed progress or brief, with a conversational source receipt when entered in chat. Use the current read projection even while the execution Turn is active. |
| Ordinary follow-up | Record it in the durable queue by default. Explicit steering may join the current Turn at its supported safe input boundary within accepted scope. The owning input path records the disposition. |
| Reply to a pending user question | Use the referenced user-input record and its own revision, eligibility and continuation checks. A permission or approval decision uses the corresponding authorized decision path. |
| Explicit stop | Address the current Turn or affected Workflow through its existing interruption or cancellation owner. The stop receipt tracks the outcome of already admitted effects. |
| Explicit authorized change to the running objective, constraints, acceptance criteria or dependencies | Create a proposed change and a durable admission hold for the affected stages and downstream dependencies. If the user identifies the Work Item and the impact is still being resolved, hold the smallest execution scope that contains the possible affected work. The coordinator shows the proposal and asks for material missing intent. |
| Ambiguous statement, another task or external source update | Clarify an unclear request, or use the normal queue and intake for separate work. A source update can supply a proposal or create a source revision. Scope changes use Plan/Goal acceptance. |

The input owner routes a requirement change with its input receipt, Work Item ID, current accepted Plan/Goal references and proposed impact to the existing owner. For an explicit authoritative delta, record the input and hold before affected new writes or dispatches may pass the next admission boundary. The initial hold is conservative and the coordinator narrows it only against the accepted dependency graph. The hold needs no new execution authority. A competing start, tool call or approval resume checks the hold and relevant revision when it acquires authority. An action admitted before the hold stays with its original owner, drains at its safe boundary or enters reconciliation for an unknown result. The owner preserves uncommitted work and effect receipts. An interrupted Attempt releases its write lease through its existing lifecycle.

Where the input and affected admission owner share the workspace store, commit the input receipt and hold in the same transaction. Across ownership stores, persist a hold intent with the input and reconcile it against the affected owner's durable acknowledgement using the same operation identity. Affected admission checks use the pending intent or the owner's current hold fence. If a remote owner cannot participate in that check, expose the hold as pending until its acknowledgement and reconcile the old scope's outstanding actions before admitting a successor. Restore pending intent and acknowledgment before retrying a scope change after restart. Live events reflect those facts for readers.

Build a proposed successor against the current accepted Work Item, Plan and Goal revisions. The proposal carries the source input receipt, changed requirement IDs, affected stage and dependency IDs, disposition for active steps, and the current evidence applicability checks. `plan/accept` uses a compare-and-set on the acceptance basis and accepted proposal. It commits one linked successor for the source input and accepted revision. Concurrent acceptance or resume rechecks the current accepted revision and hold. Repeated acceptance returns the existing receipt. Competing proposals targeting the same basis remain visible and require revalidation against any newly accepted scope. Releasing a proposal's hold after acceptance, authorized withdrawal or rejection checks any other pending holds over those stages and the applicable scope.

Apply the effect to the original owning path. For a changed Workflow graph, compile a successor Workflow from the accepted Plan revision, with explicit import of applicable outputs or references to still-running independent stages under their original owners. It has a fresh assignment and admission for changed work. The prior graph and its completion audit retain their own identity. A retained step completes under its original assignment and supplies a result to the successor only through a declared evidence dependency, rechecked by the acceptance owner. A superseded step can settle its effects and publish history under its original binding. It cannot satisfy a successor criterion, admit new affected work or transfer its permission to the successor. Startup locates any unconsumed acceptance receipt and reconciles the hold, predecessor and successor through the original owners before releasing the affected admission.

| Changed input | Revalidate or repeat | Eligible carry-forward |
| --- | --- | --- |
| Candidate digest or PR head | Recheck candidate-bound Verify, Review, CI, snapshots, code-specific decisions and handoffs against the current candidate. Record a fresh check or a source-owner revalidation supported by the evidence contract. | Unchanged plan contracts, decision inputs and artifacts whose applicable basis excludes the edited candidate. |
| Accepted requirement, contract, dependency or Goal criterion | Follow the affected edges transitively. Reaccept changed scope and rerun or revalidate outputs, decisions, handoffs and gates that cite the changed input. | Independent accepted stages and evidence whose declared inputs, policy, source visibility and acceptance conditions still match. |
| Evidence source correction, withdrawal or unavailability | Re-evaluate dependent criteria and decision eligibility immediately. Keep reason and provenance of the prior result. | Other evidence with current ownership, scope and applicability. |
| Assignee, authorization or lease change | Revalidate role and execution bindings. Settle outstanding effects and issue new grants through the assigning owner where allowed. Invalidate pending deliveries or approvals whose binding no longer applies. | Approved outputs that are still accessible and applicable. Any new admission needs its own valid grant and receipt. |
| Additional message or cosmetic Plan text | Advance the input or display revision. Keep the current accepted basis unless the acceptance owner identifies a material change. | Existing current scope, typed evidence and authorized running work. |

For example, a P02 change to replay implementation refreshes P02 and QA candidate-bound checks while the accepted P01 interface contract remains usable. A user change to the P01 response contract holds P01's affected writes and P02 and QA dependencies on that contract. A separate QA fixture that has a verified independent basis can finish in its original Run. P02 can reuse retained patches as candidate inputs after revalidation. The successor acceptance uses only results that satisfy its revised contract.

[Plan acceptance and scope](conversation-plan-and-goal-modes.md) · [Ownership and recovery](runtime-supervisor.md) · [App Server Turn control](ling-app-server-detailed-design.md)

### 4.5 Progress Across Runs

Use the existing Attempt execution loop detector for repetitive tool activity and Goal supervision for autonomous continuation. The Work Item/Workflow coordinator derives progress from authorized outcome records across all Runs contributing to a required stage or dependency. A delta counts when it advances a declared criterion, resolves a prerequisite or materially narrows an open blocker through applicable evidence, an accepted decision or a committed plan change. The disposition must identify which obligation changed and the owner evidence. Narration, heartbeats, repeated test output, changing providers and additional observations of the same failure leave that obligation's progress unchanged. Progress on a different branch does not reset the retry count for the blocked dependency.

Resolve observations against a stable Work Item, affected stage or dependency, and canonical blocker cause. The owning Verify assertion, Review finding or reconciliation reason supplies the structured identity and basis. Link equivalent reports to the same blocker only when the owner confirms that they describe the same unresolved condition. Keep their source revisions and timestamps on the evidence board. A changed candidate or a renamed finding is insufficient by itself to create another decision or reset a continuation counter. When relevant evidence changes the blocking condition or option set, the owner records the new revision under its original lineage.

Evaluate newly committed outcomes and eligible continuation checkpoints under the existing Goal and Workflow limits. Charge elapsed and model/tool usage to the accepted Work Item/Goal and its policy. An automatic continuation is counted once at owner admission and reconciled once with its resulting evidence delta. Re-observing it, restarting the daemon, or switching an Attempt, participant or adapter retains the relevant counters, spend and deadline. For Goals, apply the configured `maxContinuations` and `maxNoEvidenceContinuations` and their existing budget rules. Work Items without a Goal use the accepted Workflow retry bounds and Work Item budget. An unbounded or unspecified retry policy requires explicit follow-up.

When the next automatic step exceeds the allowance, or the blocker needs a user decision, policy repair or effect reconciliation, park that automatic path with a typed reason, affected criteria, last verified delta, remaining budget and recovery owner. Keep independent eligible work under its own gates. Resume through a current evidence delta or an authorized continuation or Plan change, within the owner's current authority and remaining limits. Pausing automation preserves open questions, write leases and effect receipts for their owning lifecycles.

[Goal supervision](../../packages/core/src/goal-supervision.ts) · [Execution loop detector](../../packages/daemon/src/features/runs/execution-loop-detector.ts)

## 5. Team Attention and Speaker Leases

### 5.1 Work Item Control

Work Item control is a durable admission latch over the current accepted Work Item lineage. It reuses the existing Task, Turn, Workflow, Run, Approval, Delivery and Automation owners. It does not create a second execution state machine.

The control owner stores one control receipt, control generation, requested action and reason for the current Work Item revision. Actions are pause, resume and cancel. A pause blocks new Tool, Run, Workflow, WorkUnit, External Agent task, device-node action, continuation, paid deliberation, Delivery, Automation and coordination-round admissions that target the paused lineage. Existing owners are asked to reach safe boundaries. A cancel blocks the same admissions and settles or reconciles already accepted effects before the lineage becomes cancelled. An independent effort with its own accepted scope is not stopped unless its own control is addressed.

The effective projection is active, pausing, paused, cancelling, cancelled or blocked. A control request returns its receipt after the latch is committed. It includes unresolved owner receipts, pending approvals, unknown effects, queued deliveries and the recovery owner. Every admission checks the current Work Item revision and control generation. A stale control or old queue item returns the current projection and cannot clear a newer hold.

Pause and cancel use idempotent requests with the Work Item, expected revision, expected control generation and caller grant. The control transaction appends the Control Plane event before asking each original owner to stop or reconcile. The owners keep their existing fence and effect semantics. Restart restores the latch before any new admission. Resume creates a new control generation only after the current Plan, Goal, Worktree, permissions, unresolved effect and independent requirement holds are revalidated. Resume does not clear a Plan admission hold, restart a cancelled step or replay an unknown external action.

The App Server capability is workItem.control. It exposes workItem/pause, workItem/resume and workItem/cancel plus workItem/control/updated. A client can inspect the current control receipt and blocker through workItem/read. The user-visible state distinguishes a requested stop, a safe drain, a settled cancellation and an unresolved effect.

Control does not make the Work Item unreadable. During `pausing`, `paused` or `cancelling`, the following operations remain admissible when their caller has the ordinary grant and they do not start new execution: status/read, snapshot, subscribe/replay, evidence read, deliberation read/cancel, reconciliation, diagnostics, control retry, and owner-driven close or settle. Existing coordination rounds may accept a bounded status or blocker message, answer an already-open question, return a handoff, append evidence needed for reconciliation, or publish a closing brief. These writes carry the current control generation and are marked as drain activity. `coordination/start`, a new deliberation, a new question or handoff admission, a new recipient delivery, and any decision that would release downstream execution are rejected with the current control receipt. An owner may commit a decision needed to close an already admitted read-only round, but its consumer remains held until resume and revalidation. `deliberation/read` is always observational. This split lets Agents report and repair a handoff without silently reopening the work.

The `WorkItemControlProjection` in the public Work Item contract is the read model for this latch. Its generation, receipt, unresolved effects and recovery owner are part of every authorized Work Item snapshot. Control writes use `expectedWorkItemRevision` and `expectedControlGeneration`; an old receipt cannot clear a newer hold.

### 5.2 Work Item and Thread Retention

Thread hard-delete preview and commit must recheck the current Work Item relationships in one transaction. The delete is blocked when a current Plan, Goal acceptance, pending approval, active continuation, required evidence, accepted Workflow, Delivery or unknown effect still relies on that Thread. The caller must first rehome the current basis to another authorized Thread, archive the Work Item, or settle the owner effect. Historical references can become unavailable tombstones under the source retention policy, with their content and grants removed from projections.

The delete transaction compares the preview revision with the current Thread and Work Item dependency revisions. A stale preview cannot delete a newly linked successor or active delivery. A permitted delete emits a scoped tombstone and revokes Thread-derived projections while keeping the Work Item receipt and source identity addressable to callers that still have Work Item authority.

The Attention Graph reads Work Item type, source, explicit mentions, active owner, Agent capability, current workload, risk and policy. It writes an `AttentionPlan` with observers, context depth, latency budget and review requirement.

The Speaker Lease is a short-lived durable projection tied to a Thread Turn. It contains speaker Agent id, source Turn, expected message revision and expiry. A speaker can publish one visible reply through the normal conversation input owner. Late or duplicate replies become folded observer evidence.

Execution ownership never follows a Speaker Lease automatically. The coordinator must create or select a Workflow/Run and the Daemon must perform normal admission.

Observer context levels remain those in Channel Team Operating System. Work Item source content is untrusted and scoped. A reviewer may see a captured Diff or artifact without seeing unrelated channel history.

### 5.3 Shared Evidence Board

The board is a Work Item view with an ordered log of contributions. Channel evidence, Verify, Code Assessment, CI and artifacts stay with their current stores. The board stores typed links to them and its own authored observations, proposals and challenges. References include the exact source ID, revision and digest where available. They are resolved by the source owner at the viewer's current scope. A board can collect evidence before a deliberation is started. [Team evidence store](../../packages/core/src/storage/sqlite/channel-team-evidence-store.ts) · [Channel context visibility](channel-context-processing-layer.md)

| Record | Required fields and ownership |
| --- | --- |
| Subject | Workspace, Work Item, applicable intake or accepted Work Item revision, linked Thread where present, Goal acceptance revision when applicable, and the frozen input digest. A code subject also carries the App Server candidate reference and digest. |
| Entry | Stable ID, entry revision, sequence within the Work Item, subject revision, kind, actor, source references, visibility, bounded summary and server timestamp. The server attaches Run, Attempt and Workflow step references for participant output. |
| Evidence link | Source owner and stable reference to an Artifact, Specialist Note, Verify result, Review finding or other authorized record. The owner supplies the result, evidence grade and applicability. |
| Correction | Target entry and expected entry revision, reason and replacement or withdrawal. The author or an authorized moderator can append it. A reader can inspect earlier revisions within the current visibility policy. |
| Decision link | The outcome and the source owner's accepted decision receipt. A reference points to the receipt for the accepted revision. |

Entry kinds are `observation`, `proposal`, `challenge`, `evidence_ref`, `correction`, `recommendation` and `decision_ref`. A proposal has an option ID and stated tradeoffs. A challenge points to an option or entry revision and records the objection. The recommendation references a sealed outcome. Ballots are stored as scoped round records. The read projection joins them after tally only for entitled viewers. Recommendation and decision records come from their respective owners. Claims inherit verified status only through matching source-owner evidence.

- Append checks the current Work Item revision, actor grant, referenced source scope and sender binding. Workflow output also checks the exact participant, step and current Attempt fence. Independent appends receive successive board sequence values in a transaction. A correction uses compare-and-set against the target entry revision. An identical retry returns the original receipt, and a conflicting payload using the same key returns `idempotency_conflict`.
- Contributions use the intersection of the Work Item, participant, source and caller scopes. The Context Processing Layer treats contribution text as data and builds prompt and reader views from scoped summaries and references. Synthesis, tally details, exports and replay follow those same scopes. A missing or withdrawn source has an unavailable reference. Where a summary cannot be safely projected with its permitted sources, the view withholds the summary.
- Each accepted mutation appends a content-minimal Control Plane event in the SQLite transaction. Board sequence orders entries within a Work Item. The App Server cursor covers the authorized projection across events. Clients can rebuild from a snapshot and apply entry revisions idempotently. A revoked client must renew authorization before receiving a new view.

### 5.4 Deliberation Workflow

The coordinator starts deliberation under the configured admission policy and the current work phase.

| Placement | Admission and return |
| --- | --- |
| Before Plan acceptance, including Plan Mode | Use coordinator-owned read-only requirement shaping with a bounded input, roster and evidence. Return the decision or unresolved options to the plan proposal. Plan Mode keeps its restrictions on Workflow starts, step starts and tracked mutations. |
| Declared decision point in an accepted Workflow | Compile the read-only decision steps and the consuming dependency into the graph at Plan acceptance. Admit them through the accepted assignment and step leases. The dependency receives a typed receipt at the declared checkpoint. |
| Unexpected decision during execution | Start a linked, read-only deliberation Workflow through ordinary admission on the same Work Item. Bind the originating Workflow, graph revision, step and decision. An existing dependency that accepts the decision receipt can evaluate it within the frozen graph. Otherwise the receipt enters the Work Item as advisory evidence. A graph, scope or criteria change requires an accepted successor Plan. |
| Standalone deliberation request outside Plan Mode | Enter through the normal Work Item and read-only Workflow dispatch. The recorded decision attaches to its Work Item and can inform later work through its normal acceptance path. |

Freeze the subject, question, acceptance criteria, participant identities and roles, policies, context scopes, round limit, deadline and token budget. The start receipt binds the selected template, intake or accepted revision and roster to the shaping operation or admitted Workflow. Daemon resolves required participants and captures effective Provider/model identity through the existing Runtime path. [Requirement shaping](multi-agent-app-detailed-design.md#requirement-shaping-protocol) · [Plan Mode guard](conversation-plan-and-goal-modes.md) · [Frozen Workflow graph](multi-agent-orchestrator.md)

Shaping can collect read-only proposals and challenges and synthesize them into a scoped plan input. Formal ballots use an admitted read-only deliberation Workflow outside Plan Mode. A ballot for a planning decision can run at a decision point in the accepted Plan when that Plan requires it. A standalone decision can also use its own authorized Workflow outside Plan Mode. Shaping records the options, evidence and any authorized planning choice for proposal acceptance.

A Workflow deliberation template materializes a bounded graph with admitted read-only participant steps and explicit fan-in points. Challenge rounds have a finite count declared at start. A further round after the graph closes requires a new accepted request linked to the earlier outcome. Typical roles are proposer, challenger and voter. The roster records each participant once and can allow one participant to serve several roles. Runtime Supervisor admits every step with the appropriate scope and capacity. Source evidence that needs an actual command or a browser check is produced through the existing Verify and Tool Broker path under its normal policy.

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
| Decide | The authorized owner commits a typed decision receipt for the current subject. The target Plan or original Workflow dependency evaluates that receipt with its normal acceptance and dispatch checks. |

The phase is a view of shaping contributions or Workflow steps and sealed outputs. Run status, cancellation and recovery retain their original owners. An exhausted stage budget, deadline, missing participant or invalidated snapshot is reported with a typed reason and the evidence collected so far. The Workflow applies its accepted required-participant and failure policy. A late result from an expired or superseded Attempt can be examined in its Run history and cannot enter a closed ballot set.

The decision receipt records the Work Item, decision and decision revision, sealed outcome revision, subject and evidence basis, actor and policy revision, and one disposition. A `selected` disposition includes the eligible option and rationale. A `deferred` disposition names the missing condition and recovery owner. A `replan_required` disposition carries the proposed revision and reason. For a Workflow consumer, pin its ID, immutable graph revision, dependency ID and current input revisions. For a planning consumer, pin the requirement-shaping or proposal receipt. The consumer compares those references with its current ownership, policy and acceptance criteria and commits applicability once per receipt and target revision.

A recommendation informs the coordinator. An applicable `selected` receipt can satisfy a declared decision dependency only when that dependency accepts the receipt's evidence contract and its remaining requirements pass. The original Workflow still owns dispatch. A `deferred` or `replan_required` receipt leaves a required dependency blocked with its reason. Changing the authorized work uses the Plan/Goal acceptance transition in section 4.4 and the next dispatch uses its own authority. For example, after a linked review of two P02 compatibility strategies, the coordinator can record an applicable choice for the P02 decision point. A proposal to change the promised P01 response fields instead goes through a successor Plan. Existing Verify, Review and tool controls still evaluate the candidate and action.

### 5.5 Tally, Decision and Applicability

- The host validates the exact round, ballot snapshot digest, voter identity and logical ballot receipt. A unique constraint on the round and canonical voter permits one accepted ballot. Exact retries retrieve the original receipt. A different ballot for the same voter reports the committed entry to that voter within scope. The host uses stable roster identities even when the display name or transport changes.
- The default weight is one per eligible voter. The default quorum is a majority of the frozen roster by voter count. An eligible abstention contributes to quorum and adds no support to an option. A recommendation requires support from more than half of the total eligible weight. A template may set positive integer weights or a stricter minimum quorum or support threshold before start. The host uses integer arithmetic and records the tally, missing ballots and abstentions.
- After all ballot steps resolve or the deadline arrives, the host closes and tallies the round in one store transaction. Ballot admission uses the server deadline and the current open state in that store. The close transaction first checks cancellation and current subject applicability. It reports `cancelled` or `stale` as applicable, then `insufficient_evidence` for missing required ballots, missing quorum or inaccessible required evidence. A tie or support below threshold yields `no_consensus`. If the supported option fails a required check or has an active required review blocker, the outcome is `blocked` with references to those records. An eligible option that meets the rule yields a `recommendation`. The sealed result includes the policy revision, input digest, tally and dissent references. Further deliberation uses a new round that links the earlier result.
- Resolve the accepted decision policy to an authorized user, Ling Agent or one explicitly assigned role before admission. Check that actor's current authority and the selected option against the outcome revision at decision time. An authorized owner can select an eligible option after a tie or defer the decision. Preserve the original tally and dissent and record the rationale and current evidence for a selection after a tie, an override or a deferral. If authority, user preference or required evidence is missing, wait for the applicable owner, input or check. Changes to accepted scope or criteria follow the existing Plan or Goal acceptance path. Approvals, Tool Broker, Verify, Review, CI and Delivery evaluate their own evidence.
- Close and decision transactions check the sealed subject and the relevant input revisions and evidence scope. A change to that basis makes the result stale for current use. Candidate-bound decisions require the matching candidate. A carry-forward decision follows the applicability checks in section 4.4. History retains previous options, results, receipts and additional board observations under their authorized scope.

### 5.6 Recovery and Projected Access

When the daemon restarts, it reloads the subject, admitted shaping operation or Workflow, stage snapshots, accepted ballots, stored receipts and remaining deadline and budget. The existing Runtime reconciles interrupted Runs. Phase, canonical tally and decision are recovered from records with unique keys for the round and accepted receipt. Cancel stops new admission to the shaping operation or Workflow and uses its existing stop and terminal evidence. Handoff records the current Work Item and board revision, sealed outcome when present, open question and applicable shaping or Workflow reference.

App Server and Ling clients use the same evidence projection. Workspace and Work Item grants permit the Work Item snapshot and subscription, including before a Thread is linked. Thread-backed fields, actions and a Thread subscription additionally check the current Thread grant. The board withholds references outside the caller's scope. Snapshots and retention follow the existing workspace store and cursor rules. If related evidence body retention expires, a remaining reference identifies it as unavailable. A stale or unauthorized reference cannot support a new recommendation or decision. Archive retains permitted decision and source references according to the Work Item and source retention policies.

While a ballot is sealed, its public Run and Item projections expose authorized phase and progress. Ballot text, rationale and intermediate results use the ballot scope across live deltas, artifacts and replay. The voter can retrieve its own accepted receipt. Closing the round publishes the scoped tally and dissent, with individual records available according to the accepted visibility policy.

### 5.7 Plan Stages and Stage Briefs

Plan preview binds each proposed stage, such as P01, to an explicit stable stage ID, goal and acceptance revision, required Workflow steps, dependencies, owner, recipients, expected outputs and acceptance conditions. On acceptance, the Workflow owns the steps and the Work Item projects their progress. A stage with several steps completes through the accepted fan-in conditions and required evidence for those steps. A display title or a checkbox in model text is descriptive input to this process. [Plan conversion](../../packages/core/src/storage/sqlite/proposed-plan-action-store.ts) · [Workflow completion](multi-agent-orchestrator.md)

| Event | Stage brief |
| --- | --- |
| Stage starts | Accepted scope, upstream decisions, input references, expected outputs and checks for the assigned participant. |
| Stage passes acceptance | Committed outcome, output version, artifact and verification references, decisions, remaining conditions and the input required by each successor. |
| Stage is blocked or its evidence changes | Current reason, missing or superseded references, affected successors and the participant who can resolve it. Independent steps remain eligible under their own conditions. |

Derive the brief from committed owner records and reuse Workflow output and context packets. The brief includes Work Item, accepted Plan and stage identity, subject and candidate references, source step or Run revision, scoped evidence, outstanding conditions and the next owner. For parallel work it references each accepted required result. An optional prose summary cites those records. Create one brief per Work Item, Plan revision, stage and committed source event. Deliver each role's projection once per brief and recipient. For example, implementation receives the accepted interface and input artifacts while QA receives the contract assertions and the candidate to verify. A changed Plan or candidate revalidates the affected dependency and preserves the earlier brief as history. The Workflow edge or existing assignment owns dispatch. [Step output packet](../../packages/daemon/src/features/channels/workflow-step-packets.ts) · [Successor context](../../packages/daemon/src/features/channels/context-processing/workflow-steps.ts)

### 5.8 Role-based Observation and Peer Questions

The existing Attention Plan can match role, accepted stage and event. For example, QA can receive a candidate-ready or acceptance-change signal, and the Plan owner can receive a question about scope. Each receiver gets the relevant authorized brief and source references. Observer Bus supplies scoped signals and recommendations. An admitted read-only review or an execution step follows the accepted assignment. Replay reprojects the signal without another paid observation or execution. [Observer Bus](../../packages/daemon/src/features/channels/observer-bus.ts) · [Observer scopes](channel-team-operating-system.md)

An assigned participant can send a targeted question to another participant in the same Work Item. The question stores its ID, sender grant, responsible respondent, stage and subject revision, affected input or dependency IDs, permitted source references, deadline and current revision. The ask and the corresponding message are committed together. A reply checks the responding grant and the question's open revision and commits one answer or escalation and its receipt. A question can reference its originating round and remain open until its own deadline after that round closes. Changes to the accepted Plan, assignments or tool scopes go to their respective owners.

The Workflow validates any wait against a required dependency of the affected step. A wait that would create a dependency cycle is rejected and escalated. An unreachable respondent or expired deadline also produces an escalation. The Workflow records one blocker for the question with its reason, affected edge and recovery owner. Ling Agent can route the blocker to a participant, request a check or ask the user. A reply with a superseded subject or an expired deadline stays in the originating history when available. The current dependency requires an applicable answer or an accepted resolution and the Workflow's ordinary readiness checks. On reconnect the question, blocker and any accepted reply use their original identities.

### 5.9 Handoff Acceptance and Repair

The Workflow prepares a handoff for the downstream dependency using the accepted source brief, required inputs and expected output, source candidate and evidence, source and target stage revisions, and the assigned receiving participant. It records the material on its existing handoff intent. Daemon derives the receiver from the authenticated grant or the bound Workflow step and current Attempt. A declared automated handoff can use the same Workflow acceptance path when its checks pass. [Existing handoff acceptance](../../packages/daemon/src/features/channels/workflow-handoffs.ts)

- Acceptance compares the expected intent revision and the current stage, candidate and evidence contract. One accepted receipt binds the source outcome, target stage, dependency, recipient and applicable revisions. Concurrent valid acceptance of the same revision resolves to that receipt. The original Workflow rechecks readiness and dispatches through the existing step claim and deduplication key.
- Return compares the expected intent revision and the current downstream dependency. It can record that the offered source material is stale. The receipt identifies the missing condition and repair owner. Typed reasons include `missing_artifact`, `required_check_incomplete`, `candidate_stale`, `scope_unavailable` and `upstream_effect_unknown`. The affected edge waits. A correction links the previous intent to an updated source revision and uses normal validation for a fresh acceptance.
- A live write lease, a pending approval or an unknown external effect uses the original owner's recovery path before transfer or retry. If the subject drifts after acceptance, the receipt remains visible as history. The Workflow revalidates against the current dependency before admitting any further step.

The handoff view projects these milestones from their owning records.

| Milestone | Evidence |
| --- | --- |
| `accepted` | Accepted handoff receipt. The target can still be waiting on capacity, approval, another dependency or a current admission hold. |
| `dispatch_admitted` | The target Workflow start owner has recorded its step claim for this accepted basis. Project its exact Task and Run as they are linked. |
| `started` | The Runtime owner recorded start for the linked Run and current Attempt. Later outcomes continue through that Run and the Workflow completion check. |

Commit the accepted handoff and durable eligibility for downstream reconciliation together. The normal Workflow tick and startup reconciler use the same step start owner, expected stage and assignment revisions and dispatch identity. If acceptance is recorded with no start claim, recheck readiness and claim the eligible step once. If a claim or Run already exists, reconstruct its admission and start facts from that owner and resume only through its recovery rules. A prepared dispatch with an unknown start or effect holds the affected dependency until the original owner reconciles it. Missing notifications or client replay use the restored projection. [Step start owner](../../packages/core/src/workflow-step-start-owner.ts) · [Admission release proof](../../packages/core/src/workflow-step-admission.ts) · [Runtime start evidence](../../packages/daemon/src/runtime/work-units.ts)

On unavailability or revocation, the coordinator records the reason and proposes reassignment through the existing Task or Workflow owner. An authorized reassignment compares the current assignment and stage revisions and resolves the old lease, approval and effect status. A change to an immutable participant requirement uses a successor Plan. The new participant receives a current scoped brief, assignment and handoff receipt through ordinary admission. Pending questions that remain applicable are linked to a fresh question revision and delivery for that participant. Superseded work, expired or inaccessible questions and unconfirmed effects keep their blockers and history for the appropriate owner. The old respondent can supply historical evidence within their grant, while current replies and writes require the current assignment and Attempt. An expired connection alone gives the existing owner time to reconcile. During deliberation, use the frozen roster and ballot failure policy, or open a successor round with a fresh authorized roster.

### 5.10 Coordination Rounds and Agent Messages

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

A committed event starts at most one round of its configured kind for the Work Item. Automation schedules may provide daily or weekly checkpoints or retrospectives through the admission in section 5.9. The accepted Plan controls which checks gate execution. Additional invited Agent turns use the existing participant, budget and Runtime admission paths.

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

Each recipient's delivery is identified by message ID and recipient ID and binds the admitted assignment and subject when dispatched. Recheck grant, applicability and the target's input authority before reaching the safe input boundary. An idle participant can receive a new Turn only through an authorized follow-up. The message body enters prompt context as scoped task data.

Message acceptance commits the message and makes its recipient delivery `queued`. `delivered` requires a durable receiver receipt for inclusion in the actual input accepted by the target Runner, tied to the Run/Attempt and prepared input basis. With a verified in-turn steering path, use its equivalent input receipt. Work Item observation or successful publication is a separate fact. If an adapter cannot establish delivery after an ambiguous call, report `delivery_unconfirmed` and reconcile with that adapter. Retry the same queued delivery only with current authorization and proof it is safe to do so. Pending delivery can close as `expired`, `superseded` or `scope_revoked`; a completed delivery remains a historical fact. A reply is a separate question-owner receipt. [Prepared input receiver](../../packages/daemon/src/features/runs/user-input-continuation-receiver.ts)

### 5.11 Scheduled Coordination Admission

An Automation with the `coordination_round` action configures a checkpoint or retrospective for one explicit Work Item in the same workspace store. A Workflow or Goal selection resolves to that Work Item when configuring the schedule. Keep the Automation's real, authorized Thread as the home for managing its definition and occurrence log. The target Work Item uses its own scope and can be observed before it has a linked Thread. The home Thread grants neither Work Item access nor execution authority. Check both bindings at admission and expose each projection under its own grants.

Reuse the existing recurrence, time zone and missed-run calculation. The occurrence key is `(workspaceId, automationId, scheduledFor)`, where `scheduledFor` is the scheduler's canonical UTC instant. At a due timer, enter the coordination action before generic Automation run preparation. Use the same SQLite transaction and existing AutomationRun idempotency key for the following operations.

1. Look up the terminal occurrence receipt. An exact retry returns its authorized result, including the original round ID when applicable. Its identity survives schedule edits and process restarts.
2. Compare the enabled definition, expected revision and due instant. An eligible tick checks the current target, policy, subject revision and coordinator authority. A temporarily failed store operation rolls back and follows the scheduler's error and retry path.
3. On admission write a terminal `succeeded` AutomationRun with a completion time, the open `CoordinationRound` referencing that run, its deadline and its content-minimal Control Plane event. Set the deadline once from the actual admission time and configured round duration. Uniqueness on the occurrence and its round linkage preserves one result. The terminal AutomationRun receipt means the round was created, and the round owns its later messages, deadline and close. Its result is presented through existing Automation history and the authorized Work Item projection.
4. If the enabled tick reaches a target or policy that cannot currently admit a round, write a terminal `skipped` AutomationRun with a typed reason such as `coordination_target_unavailable`, `coordination_policy_denied` or `coordination_subject_unavailable`. Skip reason visibility follows the owner grant. A pause or edit that superseded the dispatched timer is handled by the current scheduler generation.

This action writes a terminal occurrence directly. Agent participation, when authorized, is admitted independently through the existing Workflow and Runtime paths. A user-triggered Run now uses the same atomic action and the existing manual Automation receipt key. Schedule advancement follows the committed scheduled occurrence. If the process stops before commit, any remaining due slot follows the existing `skip` or `run_one` policy for unadmitted occurrences. If it stops after commit, a repeat tick sees the original terminal receipt and startup reopens the existing round projection and restores its deadline. An already expired open round uses the ordinary close or invalidation path. Transport replay consumes the committed event and its existing identity. [Automation scheduler](../../packages/daemon/src/features/automations/scheduler.ts) · [AutomationRun store](../../packages/core/src/storage/sqlite/automation-store.ts) · [Transactional Control Plane append](../../packages/core/src/storage/sqlite/control-plane-store.ts)

The implementation stores the schedule binding, occurrence receipt, open round and close brief in the same workspace SQLite store. A timer restart reads the round deadline rather than generating a new Run. A paused Work Item commits a typed `skipped` occurrence. Closing a round appends a brief and terminal coordination record atomically, and a changed Work Item control generation produces an `inputs_changed` close reason.

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
  readonly githubInstanceId: string;
  readonly repositoryId: string;
  readonly repository: string;
  readonly kind: "issue" | "pull_request" | "check" | "review" | "comment" | "release";
  readonly numberOrName: string;
  readonly baseRef?: string;
  readonly baseSha?: string;
  readonly headSha?: string;
  readonly sourceRevision: string;
}
```

PR acceptance pins the current head SHA and the target branch with its base SHA. The provider adapter supplies both from the authorized repository. Each evidence record declares its applicable basis. A head or base update changes that basis in place on the same PR lineage and retains its earlier observations. [Work Item identity](#32-work-item-target-identity)

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

The GitHub adapter normalizes webhook, poll and manual import into one target identity and their respective occurrence receipts. Exact retries return the committed records. Confirm the current subject with the provider before applying out-of-order or conflicting updates. A new head supersedes candidate-bound review and verification. A base update re-evaluates the evidence that depended on the previous base, including the affected baseline rules and integration checks.

### 7.3 Acceptance

Merge acceptance requires:

- current Work Item, candidate and provider-observed PR revision;
- all required Goal criteria;
- required Verify results for the current candidate;
- required Review disposition;
- applicable evidence for each required check or a recorded policy exception for that check;
- no pending Approval, unknown external effect, or active conflicting Worktree owner;
- an authorized user or repository policy decision.

Ling-initiated merges also require the provider guard in section 7.4. For a merge performed directly on GitHub, reconcile the actual result and independently evaluate applicable evidence under the accepted policy. The adapter records a verified merge receipt and lets Goal completion perform its normal evidence audit. A repeated merge observation follows the original receipt.

### 7.4 CI Evidence and Merge Guard

    interface GitHubCiEvidence {
      readonly githubInstanceId: string
      readonly repositoryId: string
      readonly pullRequestNumber: number
      readonly workItemAcceptanceRevision: string
      readonly candidateRef: string
      readonly baseRef: string
      readonly baseOid: string
      readonly headOid: string
      readonly basis: "head" | "integration" | "merge_group"
      readonly testedObject: { readonly kind: "commit" | "tree"; readonly oid: string }
      readonly proofRef: string
      readonly mergeGroup?: { readonly oid: string; readonly membershipProofRef: string }
      readonly requiredPolicyRevision: string
      readonly checkIdentity: string
      readonly providerRecordRef: string
      readonly runId?: string
      readonly runAttempt?: number
      readonly outcome: string
      readonly coverageRefs: readonly string[]
    }

Freeze the repository, PR, current `baseRef`, base and PR head OIDs, Work Item acceptance and candidate, and effective required-check policy revision. The policy names each required check, trusted App or integration identity and applicable workflow or ruleset, test coverage and accepted basis. Match source identity and the provider's effective run and attempt. Record the check identity, run ID, `run_attempt` when available, outcome and proof of the actual tested commit or tree. A configured trusted CI workflow can supply that proof. A provider-attested check subject is sufficient where the trusted execution contract establishes that the job tested that subject. The event type, job title and reported `head_sha` locate evidence for further checks.

| Required check basis | Applicability |
| --- | --- |
| Head | The repository policy explicitly declares the check independent of base. The job tests the current PR head, and its source, policy, effective attempt and coverage are current. A base advance alone preserves that result. |
| Integration | Test the current integration commit or tree for the exact base and PR head, such as the provider's current PR preview. A new base or a changed tested integration object reopens the required check even with the same PR head. |
| Merge group | Test the provider-created current merge group commit or tree. Bind the group and target queue entry using provider-owned evidence, including the group base and authorized PR membership. A rebuilt group needs its own evidence even with the same PR head. |

Require the current applicable outcome for each required check. A rerun that changes the effective attempt reopens the gate until the current result is known. Where GitHub carries job results across attempts, use the trusted current aggregate and prove coverage for the same tested basis. Deduplicate observations by provider record and attempt and reconcile conflicting or late notifications against the provider's current state. Missing or ambiguous subject, origin, policy or coverage is `ci_pending` with a typed reason. Draft preview and scoped-out jobs use the accepted policy's coverage rules. A prior result stays visible with its own check basis. CI summaries and failure triage support diagnosis. [Actions event and checkout subjects](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) · [Run attempt jobs](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt) · [Current CI triage](../../packages/core/src/external-work-ci-triage.ts)

Record the accepted merge intent and re-read current subject and effective repository protections at dispatch. The provider must enforce the accepted check policy at execution time for Ling to initiate a merge. For a policy that requires a tested integration or group, use an enforced merge queue with the required group checks or a verified provider operation that atomically checks the tested basis. Queue admission can precede evidence for the generated group. GitHub then creates the group and enforces its checks before updating the target. Establish the queue capability and its required workflows on the actual repository before selecting that path.

For a policy that explicitly accepts current, up-to-date head evidence, strict up-to-date branch protection and effective provider-required checks can guard a direct merge. Pin the expected head in the provider request. GitHub's direct merge `sha` compares the PR head. Exact integration acceptance uses the integration guard above. The authenticated principal must use the enforced path with bypass disabled. Where the provider's effective rules cannot enforce part of the accepted policy, use a configured provider-required trusted gate for that proof. Until such a guard is verified, the work item waits for repository-side action and can reconcile an externally observed merge as a separate fact. [Direct merge head guard](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request) · [Required checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging) · [Merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)

Keep request acceptance, enqueue and actual merge as separate provider facts. Discover queue API support for the configured host and API version. Where GitHub exposes `merge-async`, select explicit `merge_queue`, pin the expected head and disable rules bypass. Repositories can also use their authorized queue entry and report that provider receipt. Record available request or queue identifiers, and after a timeout use the original intent and provider state to reconcile the result before another request can be admitted. An actual merge receipt binds the PR and applicable provider evidence to the committed result. If the repository reports a merge with insufficient evidence for the applicable guard or tested basis, keep the merge fact and the separate CI or Goal blocker visible. [Asynchronous merge lifecycle](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously)

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

The canonical public method and notification registry is the table in [Ling App Server 详细设计](ling-app-server-detailed-design.md#2-协议标识方法与结果). The list below groups the Work Item-facing methods by domain. Methods marked by an optional capability remain public App Server methods, not private domain RPCs. The App Server table and generated schema must be updated together.

The App Server adds these protocol projections to the existing Thread/Turn methods.

`workItem/create` and external submission may supply an explicit Work Item ID or repository-qualified GitHub target. The Daemon resolves stable identity from the authorized source. A request for an independent effort carries its own proposal through the existing acceptance path. An existing binding returns the visible Work Item and the caller's occurrence receipt. Applicable intent changes follow the existing input owner.

`workItem/accept` submits an authorized request for the current item revision through the coordinator and returns its receipt. `workItem/cancel` calls the existing owner for active work. External runner dispatch requires the assigned route and its receipt.

`github/subject/read` returns the visible current PR revision, per-check applicability and delivery readiness, with source proof references. `github/delivery/reconcile` re-reads the authorized provider and updates the original delivery intent and outcome. Reconciliation reports pending, enqueued, merged or unresolved under the original receipt and scope.

```text
workItem/create
workItem/read
workItem/list
workItem/accept
workItem/clarify
workItem/cancel
workItem/pause
workItem/resume
workItem/subscribe
workItem/unsubscribe
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

Evidence, deliberation and Agent coordination use the optional `workItem.evidence`, `workItem.deliberation` and `workItem.coordination` capabilities. These methods require a Work Item ID and the applicable workspace and Work Item grants. Thread-backed fields and commands additionally check Thread authority. The list views use opaque cursors bound to the caller and filters. Agent ballots and Workflow result packets enter through their admitted input or dispatched step and fence. [App Server receipts and scopes](ling-app-server-detailed-design.md#2-协议标识方法与结果)

Mutations carry `expectedWorkItemRevision` and `idempotencyKey`, plus the applicable stage, subject and target revisions. The subject binds the applicable accepted scope, Plan and Goal acceptance revisions, and the candidate or input versions used for that operation. The server derives actor identity from the authenticated grant or bound Attempt. It checks current access and action scope before disclosing an existing receipt. An exact retry by an authorized caller returns the committed receipt and entity reference. A different payload with the same scoped key returns `idempotency_conflict`. For a new write, compare the expected revisions and current Attempt fence, then commit the mutation, receipt and event together. A new execution admission also checks any hold scoped to it. Work Item and stage revisions represent their owners' state. A message append uses its own sequence and leaves other participants eligible to append to the same round revision.

| Method | Additional input and effect |
| --- | --- |
| `workItem/evidence/read` | Work Item ID and optional page cursor. Returns visible entries, board revision and a resume cursor for the authorized view. |
| `workItem/evidence/append` | Subject digest and bounded contribution. Corrections include target ID and expected entry revision. Requires a contribution grant. |
| `workItem/deliberation/start` | Authorized template revision, subject digest and question, proposal or stage reference. An accepted suggestion supplies its decision ID and expected decision revision. The coordinator returns the round and the admitted shaping or Workflow receipt. |
| `workItem/deliberation/read` | Decision or round ID and optional page cursor. Returns the visible trigger evaluation, phase, budget state, sealed outcome and decision as available. |
| `workItem/deliberation/cancel` | Round ID and expected round revision. The shaping or Workflow owner returns its stop request receipt. |
| `workItem/deliberation/decide` | Round ID, expected sealed outcome revision and the decision with its reason when required. The decision owner checks the current subject and commits the accepted receipt. |
| `workItem/stage/read` | Stage ID and optional revision. Returns the accepted stage contract, owner, dependencies, status and applicable admission hold or continuation blocker. |
| `workItem/stage/brief/read` | Stage ID and optional brief ID. Returns the currently visible projection of that brief, or the latest brief, with source revisions and applicability. |
| `workItem/coordination/start` | Kind, subject revision, stage if applicable, requested participant roles, agenda and deadline within the accepted policy. The coordinator receives the round receipt. Scheduled starts enter through the atomic Automation admission in section 5.9. |
| `workItem/coordination/read` | Round ID. Returns the visible roster, status and revision, sealed brief and action items when published. Messages are available by round. |
| `workItem/coordination/close` | Round ID, expected round revision and subject, plus publish or cancel disposition. Requires the coordinator grant. Publish returns the committed brief ID. Cancel takes a reason and commits the terminal receipt. |
| `workItem/message/send` | Recipient IDs or authorized role selectors, stage when applicable, subject revision, kind (`note`, `status`, `blocker`, `decision_candidate` or `action_update`), bounded summary and source refs. Include the round ID and expected open round revision for a contribution. Returns the message receipt and delivery references within scope. |
| `workItem/message/read` | Message ID. Returns the visible message and per-recipient delivery status with its admitted input reference, unconfirmed state or terminal reason where present. Question answers use the separate question receipt. |
| `workItem/message/list` | Optional round or stage ID and page cursor. Returns ordered messages in the caller's scope. |
| `workItem/question/ask` | Responsible respondent, subject revision, affected dependencies, bounded question, source refs and reply deadline. Include stage and open round revisions when applicable. Returns one question and message receipt. |
| `workItem/question/read` | Question ID. Returns the visible question, reply status, current revision and related blocker. |
| `workItem/question/reply` | Question ID, expected question revision and subject, bounded answer or typed escalation, and source refs. Returns the reply or blocker receipt. |
| `workItem/handoff/read` | Handoff ID or stage pair. Returns the source brief, target requirement, validation, acceptance receipt and the linked dispatch and Runtime start milestones. |
| `workItem/handoff/accept` | Handoff ID, expected handoff and target stage revisions and current subject. Acceptance binds the authenticated recipient to the checked source revision. The existing Workflow owns subsequent dispatch. |
| `workItem/handoff/return` | Handoff ID, expected handoff and target stage revisions, current target subject, typed missing condition and source refs. Returns the repair receipt for that dependency. |

Notifications use the existing event envelope and include `workItemId`, `workItemRevision`, `claimId`, `sourceRevision`, and `deliveryId` where applicable.

```text
workItem/created
workItem/control/updated
workItem/thread/linked
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

These notifications carry IDs and revisions for an authorized read. `workItem/brief/updated` identifies the stage or round and its brief ID. `workItem/deliberation/updated` identifies the decision revision and includes a round ID when admitted. `workItem/message/updated` and `workItem/handoff/updated` invalidate scoped views when their milestones advance. `workItem/stage/updated` covers affected admission holds even if another part of the Work Item is still running. The Work Item snapshot includes visible current Plan revisions and admission holds, recovery and progress references, and active round, decision, question and handoff references.

`workItem/subscribe` targets the workspace and Work Item. With a Thread attachment, `workItem/thread/linked` records the source owner's link even if the caller may only see the Work Item side. The authorized Thread subscription may deliver the same event ID under its own cursor for client deduplication. Connection-scoped `workItem/unsubscribe`, `workItem/replay/ready` and `workItem/resync/required` follow the App Server subscription contract. Reconnect uses the current scope and can recover messages and results by ID without dispatching new work. Input delivery and downstream execution use their own admission paths. [App Server subscription contract](ling-app-server-detailed-design.md)

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

Enforce a unique default Work Item per verified GitHub target and workspace and preserve independent source occurrence receipts. Approved separate efforts have their own acceptance identities and related targets. Retain a scoped binding or tombstone according to the owner retention policy so delayed source delivery continues through reconciliation. The Work Item store and execution owner use the same durable dispatch intent and compare its accepted revision when linking an execution receipt.

Evidence entries, sealed rounds, ballots and decision receipts use Work Item-scoped relations in the same workspace SQLite store. Their lifecycle migrations cover opening existing work items with an empty board, replay across restart and concurrent submission. Workflow and source evidence stay addressable through their existing keys. Section 5 defines the commit and recovery rules for these relations.

Coordination rounds, messages, stage briefs and peer questions use Work Item-scoped relations. Enforce unique occurrence keys for round admission and one brief per applicable stage event or published round. Enforce unique message sequences and receipts, plus one delivery per message and recipient. Extend the existing Workflow handoff intent and acceptance receipt for stage and candidate binding. A migration can open existing Work Items with empty coordination projections. Persist deadlines and pending deliveries so Daemon can resume them through their owners after restart. Round close, brief publication and their content-minimal Control Plane events share one transaction. An interrupted delivery retries with the existing input receipt key after checking current scope and applicability.

Scope change holds bind their source input and acceptance revision to affected owner stages or Runs. Acceptance and release reference the durable Plan/Goal owner receipt and any unresolved effects. A restarted owner restores holds before attempting affected dispatch or continuation. The active revision projection advances from committed owner facts. Persist the Goal or Workflow continuation counts, budget and last verified delta with owner-scoped checkpoint IDs so repeated recovery reads and observer reports do not restart the allowance.

Recovery rules:

- a duplicate source returns its original scoped receipt and a new explicit source for the same target inherits the current Work Item binding;
- a stale dispatch reference is visible and follows the source owner's recovery;
- a Run continues through Runtime Supervisor recovery;
- an external Agent disconnect does not retry the effect;
- a GitHub head, base, merge group or effective check-attempt change re-evaluates its applicable evidence;
- a committed scheduled coordination occurrence restores the same round and deadline or its skipped reason;
- a Delivery with unknown outcome waits for reconciliation;
- follow-up uses the explicit accepted Task, Turn or Workflow and its normal continuation path;
- archived Work Items retain source, delivery and evidence references.

## 11. Detailed Acceptance Matrix

| Area | Required test |
| --- | --- |
| Intake | duplicate channel edit, duplicate webhook, monitor fingerprint, external submission and device node all create one current Work Item |
| Target identity | concurrent webhook, poll, chat and Codex references to the same Issue or PR resolve one default Work Item and one dispatch intent, exact retries return the original receipts, independent effort uses explicit acceptance, private duplicate targets keep scoped privacy, and close/reopen or an authorized PR link preserves history and owner fences |
| Dispatch | webhook or client retries share one receipt, explicit assignment and active follow-up stay with the current coordinator, a parallel Workflow retains per-step leases, and stale or unknown dispatch waits for reconciliation |
| In-flight input and change | ordinary follow-up leaves accepted scope intact, explicit P01 change holds affected P02/QA admissions, old running effects and uncommitted patches survive safely, independent QA work continues, a duplicate acceptance resolves once, stale approvals and old outcomes stay outside new acceptance, and a candidate-only change repeats only its bound checks |
| Progress across Runs | one failure observed by QA, Review and the brief is one blocker, switches and restarts preserve continuation counts, genuine applicable progress changes the affected condition, exhausted retries park automatic work with the responsible owner and a recovery condition |
| Autonomous intake | default manual, user acceptance of suggestions, opted-in scoped auto-start, pause, quiet hours and budget limits, and an existing AutomationRun linked without launching twice |
| Team | observer cannot speak, speaker lease expiry, late reply, reviewer read lease and execution ownership |
| Shared evidence | simultaneous appends both survive, correction CAS rejects a stale revision, retries return the same receipt, restricted refs and derived text stay scoped through live read, replay, reconnect and revocation |
| Stage and peer coordination | stage identity binds the accepted Plan, required parallel results close the stage, the role-scoped brief reaches the proper successor, a question holds only its dependency, and timeout and mutual wait produce one blocker with a recovery owner |
| Coordination cadence and messages | event and scheduled occurrence deduplication, concurrent contribution and close ordering, atomic brief publication, cancellation and stale history, a reply after close, duplicate delivery after restart, and current scope checks on receipt retry including revoked roles |
| Scheduled coordination admission | crash before and after occurrence transaction, repeated timer and committed skip with no round, same-workspace target without its own Thread, late slot follows the missed-run policy, and restart restores the original round and deadline with zero Runner dispatches from the scheduled action |
| Returned handoff | a stale candidate or missing input is returned with its reason, corrected evidence is revalidated, concurrent acceptance resolves to one receipt, one current dispatch follows from the original dependency, and an unknown effect stays with its original owner |
| Delivery and handoff recovery | queued message lacks prompt-delivery proof until the receiver accepts it, unknown delivery reconciles without replay, a crash between acceptance and dispatch or between dispatch and observation restores the same eligible owner, and reassignment revalidates grants and pending questions without transferring approvals |
| Deliberation admission | clarification, verification and repair precede consideration of viable choices, default suggests and authorized automatic admission uses one receipt, materiality and role thresholds, cooldown and budget are enforced, and new relevant evidence can supersede an earlier decision revision |
| Deliberation | frozen subject, same ballot snapshot, roster/quorum and weights, sealed ballot visibility on live and replay, abstention, tie, missing evidence, late or duplicate ballot, bounded termination, source or candidate drift, and restart during vote and tally |
| Decision handoff | recorded recommendation and dissent can be inspected, a required failing check blocks a highly supported option, an explicit decision routes through the original owner, and a vote cannot grant tools or satisfy an Approval, Verify or Delivery condition |
| Deliberation placement | read-only shaping in Plan Mode, predeclared decision receipt, unexpected linked read-only Workflow with the original graph preserved, and an accepted successor for a material change |
| External Agent | handshake, capability mismatch, approval request, reconnect, replay, cancel, unknown effect and recursion rejection |
| GitHub | new head supersedes old review, same-head base advance preserves head-only evidence and reopens integrated checks, regenerated group and effective run attempt require current proof, wrong-source check and unknown basis stay pending, provider protects the read-to-merge race, enqueue differs from merge, and request timeout reconciles the original intent |
| Memory/Skill | evidence-bound candidate, review, reject, expire and authority-preserving promotion |
| Recovery | Daemon restart, client reconnect, source change, Worktree conflict and active claim reconciliation |
| App Server | event replay, Work Item methods, delivery methods, scope checks, cursor resync and redaction |
