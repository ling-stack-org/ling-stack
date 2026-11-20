# Ling Agent Operating Model

- **Status** 目标态整合设计，待实施
- **Owner** Conversation、Teammate、Workflow、External Agent、GitHub Automation 与开发工具维护者
- **Last verified** 2026-11-20 against `origin/main@b8e76d858`
- **Document type** 产品整合合同
- **Detailed design** [Ling Agent Operating Model Detailed Design](ling-agent-operating-model-detailed-design.md)
- **Related contracts** [Channel Team Operating System](channel-team-operating-system.md) · [Ling Agent Session](ling-agent-session.md) · [Ling 多 Agent 完整目标设计](ling-multi-agent-complete-target.md) · [Automations](automations.md) · [GitHub Automation](github-automation.md) · [Ling App Server](ling-app-server.md)

## 1. Purpose

Ling 已有 Channel、Teammate、Task、Goal、Workflow、Run、Approval、Worktree、Review、Memory 和 Skill。Device Fabric 定义跨设备工作流的目标。本设计补足它们之间的整合边界，让用户可以从一条消息、一个 GitHub 事件或一个定时任务开始，得到一条可交接、可验证、可审计的 Agent 工作流。

本合同定义跨域工作项、派发归属、交付反馈和客户端投影。各领域负责自己的事务和执行事实。

## 2. Product Decision

**Agent Work Item** 用于跟踪来自用户对话、团队频道、GitHub Issue/PR、定时 Automation、外部 Agent 或设备任务的工作。Work Item 可关联 Goal、多个 Workflow Step、Run 与 Delivery，当前协调权来自其既有工作入口。

```text
Source event
  -> Task Intake
  -> Goal and acceptance
  -> Coordinator decision and accepted assignment
  -> Record the dispatch once
  -> Team attention / delegated execution
  -> WorkUnit and Run
  -> Approval / Worktree / Device lease
  -> Verify and Review
  -> Delivery
  -> Feedback, Memory and Learning review
```

Ling Agent 协调项目会话，Teammate 带自己的角色、技能、模型、工具和审批配置参与执行。Workflow 表达步骤依赖，Run 记录执行，WorkUnit 和 Attempt 管理实际派发与资源归属。Delivery 表示对外或对用户可确认的交付结果。

## 3. Existing Contracts and Integration Boundary

| Existing contract | Continues to own | This design adds |
| --- | --- | --- |
| Channel Team Operating System | observer mode、speaker lease、Risk Review、single narrator | Scoped team participation and shared evidence for the accepted work |
| Ling Agent Session | active-session routing、clarification、assignment、follow-up、final report | Cross-source Work Item identity and delivery feedback |
| Multi-Agent Orchestrator | workflow graph、step assignment、fan-out/fan-in、owner、capacity | Link the accepted Workflow, including optional deliberation stages and their evidence |
| Automations | schedule、monitor、external event and AutomationRun | Task intake source and duplicate subject identity |
| GitHub Automation | webhook/poll normalization and GitHub action policy | PR delivery acceptance and feedback loop to the source Thread |
| External Agent adapters | provider/runner-specific lifecycle | Federated Agent identity, capabilities and event mapping |
| Skills and Memory | source, revision, review, provenance and scope | Work Item-level selection and learning candidates |
| Ling App Server | Thread/Turn transport, events, approval requests and replay | Work Item and external-agent protocol methods |
| Device Fabric | graph coordinator, owner host, device journal and receipts | Device node as a Work Item execution target |

## 4. Work Item Model

### 4.1 Work Item

```ts
interface AgentWorkItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly source: AgentWorkItemSource;
  readonly title: string;
  readonly objective: string;
  readonly status: AgentWorkItemStatus;
  readonly priority: "low" | "normal" | "high" | "urgent";
  readonly owner?: AgentOwner;
  readonly coordinatorId: "ling_agent";
  readonly threadId?: string;
  readonly taskId?: string;
  readonly goalId?: string;
  readonly workflowId?: string;
  readonly deliveryIds: readonly string[];
  readonly acceptanceRevision: string;
  readonly claimRevision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Sources include `channel_message`, `direct_message`, `github_issue`, `github_pull_request`, `github_check`, `automation`, `external_agent`, `device_graph_node`, and `local_user`. The source keeps the immutable external identity and a safe display projection. A source update never silently changes a Work Item objective. It creates a new intake revision or a follow-up.

### 4.2 Goal and acceptance

Every implementation Work Item has a Goal or a typed reason why no Goal is required. Acceptance criteria are immutable per revision and map to Run, Workflow, Artifact, Verification, Review, CI, or user decision evidence. A Goal can have several Work Items over time, while a Work Item belongs to one current Goal revision.

### 4.3 Assignment and dispatch claim

The existing coordinator decides who handles the work, including explicit user assignment and the follow-up path for an active session. An accepted Workflow owns the assignment of its steps. The Work Item shows the resulting owner and links the original Task, Turn, or Workflow.

A claim records or references the first dispatch of an accepted Work Item revision. If the source already owns a Task, Turn, or Workflow, use that owner's dispatch record. Each authorized WorkUnit and Attempt retains its own execution lease. One intake dispatch can therefore start a Workflow with multiple authorized participants. [Ling Agent Session](ling-agent-session.md#coordinator-decision-contract) · [Runtime Supervisor](runtime-supervisor.md)

## 5. Intake and Autonomous Work

Task intake normalizes work from configured sources and checks identity, scope and duplicates. Autonomous work lets a workspace bring an eligible item to Ling Agent without a new user message for every item. Configure it per source, such as one GitHub repository and a required label, an opted-in channel, or an automation trigger.

| Source setting | Behavior |
| --- | --- |
| `manual` | The user brings an item in explicitly. This is the default for a new intake source. |
| `suggest` | A matching event creates a visible inbox suggestion. User acceptance sends it to the existing coordinator. |
| `auto_start` | The workspace opts in to submit matching, sufficiently scoped items to the coordinator automatically, within the configured budget, hours and concurrency. |

For example, an issue tagged `agent-ready` can enter a configured repository's inbox. In `auto_start`, Ling Agent scopes the job and chooses an eligible Teammate or Workflow through the existing assignment path. The dispatch is recorded once even if both polling and webhook see the issue. Ambiguity leads to a clarification. Tool, file and GitHub actions follow their ordinary approval and verification policies. Progress and delivery link back to the work item and its authorized destination.

Pausing a source stops admission of new work from it. Accepted work is managed through the existing Run and Workflow controls. Previously configured automations and direct user requests keep their existing entry points.

## 6. Team Participation

The current team contract remains **single narrator, many observers**. A Work Item may have:

- one coordinator;
- one execution owner per active WorkUnit;
- many observers with bounded context leases;
- one speaker lease for a visible Agent response;
- one review owner for a required review gate.

The existing coordinator and Workflow selector use explicit mentions, structured task type and current capability. Inbox suggestions and observer notes can contribute context. The accepted assignment and runtime policy authorize execution.

When two intake attempts target the same revision, they resolve against one accepted dispatch. The receipt shows the assigned owner and the current execution reference.

### 6.1 Deliberation and Shared Evidence

A user can start a deliberation for a Work Item, or accept a Workflow with an explicit deliberation stage. Ling Agent can also suggest a round when an open decision has viable options with materially different consequences. An enabled project or Workflow policy can authorize a bounded round at a declared checkpoint. The entry shows the question, subject version, roster, read scope and budget. Architecture choices and conflicting review recommendations are typical subjects. Competing root-cause claims can lead to scoped verification. An AI Council can supply eligible specialists. Ling Agent assigns participants through the existing coordinator, with the Workflow owning its admitted steps. Visible replies follow the speaker lease. [AI Councils](ai-councils.md) · [Deliberation triggers](ling-agent-operating-model-detailed-design.md#52-deliberation-workflow)

1. Participants submit independent proposals. Each proposal identifies its option, tradeoffs and relevant evidence.
2. Assigned reviewers challenge the proposals against the accepted criteria. They can cite a Verify result, a Review finding or a scoped reproduction. Requests for further checks go through their normal execution and approval paths.
3. The accepted template can choose direct synthesis when the challenge resolves the issue. A vote is available when viable conflicting options remain and the template permits it. Participants submit independent ballots for the same frozen options and evidence. The host counts eligible ballots against the frozen quorum and support rule.
4. The coordinator shows the recommendation, reasons and unresolved dissent. An authorized decision owner records the chosen course. Any follow-up work enters the normal Turn or Workflow path with its accepted criteria and authorization.

The shared evidence board groups proposals, observations, challenges, references to trusted results and decision records by Work Item. Participants can consult and contribute within their granted scope. Entries show their author, subject version and sources. Corrections and conflicting observations have their own history. A prior decision stays visible with its original subject when the code or evidence changes. The board is useful for an ordinary investigation with several contributors as well as for a formal vote. Daemon stores and projects the board, and the original owners supply the status of Goal, Verify, Review and Delivery. [Shared evidence contract](ling-agent-operating-model-detailed-design.md#51-shared-evidence-board)

For example, two teammates may favor an API simplification while a required compatibility check still fails on the candidate. Ling can display the vote and the failing check together. The acceptance rule keeps the candidate blocked until the verifier records a passing check for the applicable candidate.

The scheduling references are AutoGen AgentChat's participant selection, fan-in and bounded termination, LangGraph's typed state reducers and checkpoint recovery, and Magentic-One's records of the task and its progress. Ling implements these patterns with its existing Workflow, Goal, evidence and recovery owners. [AutoGen AgentChat](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html) · [AutoGen GraphFlow](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/graph-flow.html) · [LangGraph reducers](https://docs.langchain.com/oss/python/langgraph/graph-api#reducers) · [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) · [Magentic-One](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html)

### 6.2 Stage Briefs and Participant Coordination

An accepted multi-Agent plan identifies stages, their owners, dependencies, outputs and acceptance checks. At start, each assigned Agent receives its scope and the inputs it needs. When a stage passes acceptance, changes, or becomes blocked, the Work Item carries a brief linked to the committed evidence. Downstream Agents receive the parts they need to continue. Observers receive the events relevant to their role and can submit a scoped note or recommendation. [Stage contract](ling-agent-operating-model-detailed-design.md#55-plan-stages-and-stage-briefs)

Assigned participants can ask each other a specific question while their tasks are running. Answers can point to a decision, artifact or check. The existing owner handles changes to scope, authorization or the assignment. A receiving Agent can identify a missing input on a handoff and request its correction. The authoritative handoff receipt identifies the accepted source revision and downstream owner. [Participant questions and handoff](ling-agent-operating-model-detailed-design.md#56-role-based-observation-and-peer-questions)

For example, when P01 freezes the replay contract, the P02 implementer receives the protocol decisions and QA receives the replay cases it can prepare. If P02 finds a transcript linked to an older candidate, it requests an updated check and can proceed with work that does not depend on it. A verified result can resolve a factual disagreement. If two compatible implementations remain and the choice materially affects delivery or maintenance, the coordinator can bring that specific decision to deliberation.

### 6.3 Coordination Cadence and Agent Messages

A `CoordinationRound` gives the Agents on a Work Item a shared checkpoint for kickoff, stage progress, acceptance, blockers or retrospective. Committed work events provide the default cadence. Projects can also configure daily or weekly checkpoints through Automations for a specified Work Item. Ling Agent or the recorded Workflow coordinator can invite participants by role and context lease. The resulting brief is available to the assigned Agents as scoped input for their next step, with progress, evidence, unresolved questions and accountable owners. [Round contract](ling-agent-operating-model-detailed-design.md#58-coordination-rounds-and-agent-messages)

A parent can send a child a targeted note, and assigned Agents can ask each other a question during work. Each message identifies its work item, subject version, sender and recipients. An open question can continue after a checkpoint ends. When a question blocks a required input or a handoff is returned, the Workflow holds the affected dependency while independent steps continue. The original Workflow admits downstream work after the receiving participant's handoff receipt and the current readiness checks.

Ling Agent coordinates changes to scope, assignment and authority. It receives a blocker when a question expires or Agents are waiting on each other. It can ask the user for required intent, send a disputed fact for verification or request handoff repair. An unresolved choice between viable options can lead to a deliberation suggestion. Automatic admission requires explicit project or Workflow authorization, current evidence and a bounded budget. [Trigger policy](ling-agent-operating-model-detailed-design.md#52-deliberation-workflow)

## 7. External Agent Federation

External Agents are registered as execution participants with a stable identity, adapter kind, protocol version, workspace scope, tool profile, approval mode, and event capabilities. Codex, Claude Code, LobeHub and other hosts use the same federation boundary.

The federation contract supports:

1. capability discovery and version negotiation;
2. project instruction and Worktree binding;
3. task submission with an immutable objective and acceptance snapshot;
4. bidirectional Turn and Item events;
5. approval and user-input requests;
6. cancellation, reconnect, replay and unknown outcome reporting;
7. artifact, Diff, Verification, Review and Handoff references;
8. explicit parent-child delegation lineage and recursion prevention.

An external Agent receives a bounded context projection. It does not receive raw Ling database access, credentials outside its scope, or an implicit permission increase. Its final response is an observation until the owning Daemon records the corresponding Run and evidence.

## 8. GitHub Development Delivery

GitHub is a Work Item source and a Delivery target. The canonical identity for a PR is repository, PR number, base SHA, head SHA, and source update revision.

```text
Issue or PR event
  -> Work Item candidate
  -> claim and Goal
  -> Worktree / Run
  -> Verify and Review
  -> PR update or comment
  -> CI / review event
  -> reconcile current head SHA
  -> accept, revise, supersede or block
```

Merge is a user or repository-policy acceptance signal. It can complete a Goal only when the required criteria and current head evidence are satisfied. CI or review failure creates a follow-up on the same Work Item lineage. Evidence from an old head SHA never approves a newer head SHA.

## 9. Delivery and Feedback

Delivery is typed:

```text
thread_report
channel_reply
artifact
github_pull_request
github_comment
github_merge
device_receipt
external_agent_result
```

Every Delivery records its source Work Item, candidate revision, actor, target identity, content digest, status, external receipt when available, and reconciliation state. An unknown external delivery remains unknown and requires reconciliation before retry.

Feedback from a user, reviewer, CI check, device owner, or external Agent enters the Work Item as a new event or follow-up. It never mutates historical evidence. Learning, Memory, Skill revision and Agent profile changes remain reviewable candidate flows.

## 10. Memory, Skills and Learning

Work Item context can reference project rules, Skill revisions, Memory entries, external source snapshots and prior evidence. Each reference records scope, revision, checksum, source owner, and load policy.

Successful execution can produce an Experience candidate. The candidate must cite literal accepted evidence and its originating Work Item. It cannot directly change an Agent profile, tool set, approval policy, provider, or workspace access. Promotion uses the existing Memory, Skill and Channel review owners.

## 11. User Experience

The default surface shows one coordinator summary, one active Work Item status, one visible Agent reply where a speaker lease exists, and folded specialist activity. Users can open:

- intake source and claim owner;
- acceptance checklist;
- running Agents and WorkUnits;
- stage and coordination briefs, scoped messages, pending questions and handoff receipts;
- approvals and user questions;
- Diff, Verify and Review evidence;
- shared evidence, deliberation rationale, rounds and the recorded decision;
- Delivery status and external receipts;
- Handoff and next action;
- Memory or Skill candidates awaiting review.

The product can expose a task inbox, but it must preserve the same Thread, Goal, Run and evidence projections. A marketplace or external channel is a source and delivery surface, not a second authority system.

## 12. Acceptance Criteria

1. A channel, GitHub, automation, external-agent or device event can produce one deduplicated Work Item.
2. A Work Item revision resolves to one initial dispatch, including when two intake attempts arrive concurrently.
3. The existing coordinator and Workflow assignment decide who runs. Explicit assignment, active follow-ups and authorized parallel steps retain their current semantics.
4. A Work Item can resume after connection loss without duplicating a known side effect.
5. PR, CI and Review events reconcile against the current head SHA.
6. A user can follow the same Work Item from source conversation to Run, Verification, Review and Delivery.
7. Learning candidates retain provenance and cannot expand authority.
8. The App Server and external-agent adapters expose Work Item, claim, delivery and feedback events through the existing event replay contract.
9. Device Fabric nodes keep execution ownership and receipts on the actual host.
10. LobeHub, Codex and Ling Web can act as clients without sharing persistence or bypassing Daemon authority.
11. A user can start a scoped deliberation and inspect its options, evidence, tally, dissent and decision after reconnecting. A tie, incomplete quorum or stale subject is visible and keeps its own outcome.
12. Authorized contributors can add and correct evidence on the same Work Item without losing concurrent contributions. The board respects source visibility, and approvals and delivery acceptance continue to use their original owners.
13. A stage can hand its accepted result to the implementation and QA roles with the applicable context for each. A peer question or returned handoff holds only work that depends on the missing input. Replay returns the same accepted dispatch.
14. An enabled policy can start a scoped deliberation once for the current decision. Authoritative evidence can resolve the issue before ballot admission. An authorized decision after a tie preserves the tally and rationale.
15. Work events and authorized schedules create deduplicated rounds. Closing a round publishes one replayable brief with scoped evidence, blockers and action owners. Workflow admission governs any follow-up execution.
16. Participants can exchange a scoped message or question and recover its receipt on reconnect. Timeouts and dependency cycles route to the coordinator, and downstream readiness uses the current subject and evidence.
