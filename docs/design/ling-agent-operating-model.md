# Ling Agent Operating Model

- **Status** 目标态整合设计，待实施
- **Owner** Conversation、Teammate、Workflow、External Agent、GitHub Automation 与开发工具维护者
- **Last verified** 2026-11-20 against `origin/main@b8e76d858`
- **Document type** 产品整合合同
- **Detailed design** [Ling Agent Operating Model Detailed Design](ling-agent-operating-model-detailed-design.md)
- **Related contracts** [Channel Team Operating System](channel-team-operating-system.md) · [Ling Agent Session](ling-agent-session.md) · [Ling 多 Agent 完整目标设计](ling-multi-agent-complete-target.md) · [Automations](automations.md) · [GitHub Automation](github-automation.md) · [Ling App Server](ling-app-server.md)

## 1. Purpose

Ling 已经拥有 Channel、Teammate、Task、Goal、Workflow、Run、Approval、Worktree、Review、Memory、Skill 和 Device Fabric。它们目前分别由各自合同负责。本设计补足它们之间的产品整合边界，让用户可以从一条消息、一个 GitHub 事件或一个定时任务开始，得到一条可交接、可验证、可审计的 Agent 工作流。

本合同不替换已有单域状态机。它定义跨域对象、选择顺序、所有权转移、交付反馈和客户端投影。既有领域仍负责自己的事务和执行事实。

## 2. Product Decision

Ling 的产品主语是一个 **Agent Work Item**。它可以来自用户对话、团队频道、GitHub Issue/PR、定时 Automation、外部 Agent 或设备任务。一个 Work Item 可以包含多个 Goal、Workflow Step、Run 和 Delivery，但只能有一个当前协调者。

```text
Source event
  -> Task Intake
  -> Goal and acceptance
  -> Coordinator and claim
  -> Team attention / delegation
  -> WorkUnit and Run
  -> Approval / Worktree / Device lease
  -> Verify and Review
  -> Delivery
  -> Feedback, Memory and Learning review
```

Ling Agent 是产品级协调者。Teammate 是具有角色、技能、模型、工具和审批配置的参与者。Workflow 是有依赖的执行图。Run 是一次执行尝试。Delivery 是对外或对用户可确认的交付结果。任何单个 Agent 都不能跳过协调、审批、证据或交付状态。

## 3. Existing Contracts and Integration Boundary

| Existing contract | Continues to own | This design adds |
| --- | --- | --- |
| Channel Team Operating System | observer mode、speaker lease、Risk Review、single narrator | Task intake and claim inputs, team participation projection |
| Ling Agent Session | active-session routing、clarification、follow-up、final report | Cross-source Work Item identity and delivery feedback |
| Multi-Agent Orchestrator | workflow graph、step、fan-out/fan-in、owner、capacity | Work Item-to-workflow binding and claim lifecycle |
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

### 4.3 Owner and claim

There is one active owner claim. The owner can be Ling Agent, a Teammate, a Workflow participant, an External Agent, or a Device Fabric host. Claim ownership is separate from speaker identity. An observer can review a Work Item without owning it. A claim expires only through the persisted lease and recovery rules.

## 5. Intake and Autonomous Work

Task intake normalizes a source into a Work Item candidate. It performs source authentication, duplicate detection, workspace resolution, scope checks, priority calculation, and eligibility evaluation. Intake never starts a Run by itself.

The following policies are explicit workspace settings:

- whether unmentioned channel messages may become candidates;
- which Agent roles may claim each source type;
- whether a user confirmation is required before claim or before execution;
- priority, quiet hours, budgets and maximum concurrent claims;
- behavior for stale, superseded, failed and returned items;
- whether an external Agent may create a follow-up or only observe;
- whether a GitHub merge or CI failure can change Goal state.

Autonomous claim requires a matching capability, an available execution profile, a current workspace binding, a valid budget, no conflicting claim, and a source policy that allows automatic intake. Ambiguous requests become clarification items. A claim is visible before the first side effect.

## 6. Team Participation

The current team contract remains **single narrator, many observers**. A Work Item may have:

- one coordinator;
- one execution owner per active WorkUnit;
- many observers with bounded context leases;
- one speaker lease for a visible Agent response;
- one review owner for a required review gate.

Agent selection uses explicit mentions, structured task type, capabilities, current workload, source policy, and historical evidence. Semantic recall can discover candidates but cannot grant access, tools, or execution authority.

No Agent can claim a Work Item merely because it saw a message. The claim transaction records the candidate revision, owner identity, capability snapshot, expiry, and source event. A second claimant receives the current owner and a retry or review reason.

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
- approvals and user questions;
- Diff, Verify and Review evidence;
- Delivery status and external receipts;
- Handoff and next action;
- Memory or Skill candidates awaiting review.

The product can expose a task inbox, but it must preserve the same Thread, Goal, Run and evidence projections. A marketplace or external channel is a source and delivery surface, not a second authority system.

## 12. Acceptance Criteria

1. A channel, GitHub, automation, external-agent or device event can produce one deduplicated Work Item.
2. Only one owner claim is active, and claim conflicts are durable and visible.
3. Ling Agent remains the coordinator while Teammates and External Agents use bounded roles.
4. A Work Item can resume after connection loss without duplicating a known side effect.
5. PR, CI and Review events reconcile against the current head SHA.
6. A user can follow the same Work Item from source conversation to Run, Verification, Review and Delivery.
7. Learning candidates retain provenance and cannot expand authority.
8. The App Server and external-agent adapters expose Work Item, claim, delivery and feedback events through the existing event replay contract.
9. Device Fabric nodes keep execution ownership and receipts on the actual host.
10. LobeHub, Codex and Ling Web can act as clients without sharing persistence or bypassing Daemon authority.
