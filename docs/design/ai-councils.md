# AI Councils

Status: Design draft
Scope: Workspace-level advisor groups for built-in and user-defined AI teammates,
default council seeding, channel attachments, workflow slot resolution, and cross-client
management surfaces

## Summary

Ling currently has one protected system coordinator, `ling_agent`, plus durable AI
teammates seeded from the `gstack-default` pack. That is enough for a small built-in
roster, but it does not scale to multiple built-in teams or user-defined groups.

The next product layer should be an AI Council:

```text
Ling Agent
  protected system coordinator
  visible default responder
  not a normal council member

AI Council
  managed group of AI teammates
  examples: Development Council, Design Council, Security Council
  owns member roster, routing hints, default workflows, channel availability,
  and group-level governance ceilings

AI Teammate
  durable workspace member
  owns profile, provider, skills, memory scopes, MCP bindings, tools, approvals
```

The default non-Ling built-in teammates should move under a built-in `development`
council. Future built-in councils can be added without changing the Ling Agent identity
model, and users can create custom councils from existing or newly created teammates.

## Product Vocabulary

User-facing copy can call this layer "Council" or "Advisor Council". Localized UI copy
should express an advisory council rather than a formal company team, because a council
may advise, review, or fan out work without being a standing organization unit.

Code should avoid product-copy drift:

```ts
type AiCouncilId = string;
interface AiCouncil {}
interface AiCouncilMember {}
interface AiCouncilTemplate {}
```

Use `council` in persistence and APIs. Avoid `team`, because `team` is overloaded with
human org membership, workspace ownership, and provider account concepts.

## Goals

- Put default built-in specialist teammates into a first-class Development Council.
- Keep Ling Agent outside normal council membership while allowing it to coordinate
  councils.
- Support future built-in councils such as Design, Security, Data, Release, Research, or
  Marketing without adding special-case sidebar logic for each one.
- Let users create custom councils and choose which teammates belong to them.
- Let a channel prefer a council for routing without making every channel message a
  hidden multi-agent run.
- Let a channel attach a whole council as a fast multi-teammate availability set.
- Let workflow templates resolve abstract slots such as `engineer` or `qa` through a
  selected council.
- Preserve current teammate, skill, memory, MCP, runner, and approval boundaries.
- Make council-level visibility, health, and drift explicit across Web and future desktop
  clients.

## Non-Goals

- No replacement of `AiTeammate`. Councils group teammates; they do not become agents.
- No shared all-council long-context prompt.
- No hidden agent-to-agent roundtable by default.
- No council-level permission grant that expands a teammate's tools, MCP access,
  credentials, provider access, deploy authority, or external-send authority.
- No automatic creation of new teammates when a user only wants to group existing ones.
- No hard dependency on gstack. The first built-in council is gstack-inspired, but the
  model must also support Ling-native and user-defined councils.
- No council-owned always-on memory in v1. Shared context comes from channels,
  workflow evidence, and explicit council notes, not from silent cross-member recall.

## Current State

Already implemented:

- `ai_teammates` persists durable teammate instances.
- `ling_agent` is a protected `system_teammate`.
- `teammate_skill_bindings` records per-teammate skill bindings.
- `teammate_channel_memberships` records channel membership.
- `teammate_memory_scopes` records private and channel memory scopes.
- built-in templates from `gstack-default` seed Product, Architect, Engineer, Designer,
  QA, Security, Release, and Docs teammates.
- `WorkflowTemplate` steps currently reference `teammateTemplateId` and `skillId`.
- Ling Agent Session owns the default channel message path and specialist selection.

The gap:

- default non-Ling agents are a flat roster;
- there is no durable group concept for "Development Council";
- there is no place to manage future built-in groups;
- channel routing can prefer a teammate, but not a group;
- workflows cannot resolve role slots through a selected group of actual teammate ids;
- clients cannot show "this teammate belongs to these councils" or "this channel uses this
  council by default" from a shared daemon contract.

## Core Model

### Council Template

A template defines a reusable group blueprint. It is static source metadata, not durable
workspace state.

```ts
type AiCouncilTemplateSource = "builtin" | "gstack" | "workspace" | "custom";

interface AiCouncilTemplate {
  readonly id: string;
  readonly source: AiCouncilTemplateSource;
  readonly name: string;
  readonly summary: string;
  readonly defaultMemberSlots: readonly AiCouncilMemberSlotTemplate[];
  readonly defaultWorkflowTemplateIds: readonly string[];
  readonly routingHints: readonly AiCouncilRoutingHint[];
  readonly governanceProfile: AiCouncilGovernanceProfile;
}

interface AiCouncilMemberSlotTemplate {
  readonly slotKey: string;
  readonly label: string;
  readonly roleKey: AiTeammateRoleKey;
  readonly teammateTemplateId?: string;
  readonly required: boolean;
  readonly defaultEnabled: boolean;
}

interface AiCouncilRoutingHint {
  readonly trigger: string;
  readonly preferredSlotKey?: string;
  readonly preferredSkillId?: string;
  readonly workflowTemplateId?: string;
}

interface AiCouncilGovernanceProfile {
  readonly approvalProfile: SkillApprovalProfile;
  readonly deniedActions: readonly ApprovalActionType[];
  readonly maxVisibleParticipants: number;
  readonly allowExternalSend: boolean;
  readonly allowDeploy: boolean;
}
```

The built-in Development Council template should include slots:

```text
product-strategist -> Product Strategist
architect          -> Architect
engineer           -> Engineer
designer           -> Designer
qa                 -> QA
security           -> Security
release            -> Release
docs               -> Docs
```

`ling_agent` is not a default slot. It is the coordinator for council invocation.

### Durable Council

A durable council is workspace state created from a template or user input.

```ts
type AiCouncilStatus = "active" | "paused" | "archived";
type AiCouncilSource = "builtin" | "template" | "user";

interface AiCouncil {
  readonly id: string;
  readonly workspaceId: string;
  readonly templateId?: string;
  readonly source: AiCouncilSource;
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly status: AiCouncilStatus;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly coordinatorTeammateId: "ling_agent";
  readonly defaultWorkflowTemplateIds: readonly string[];
  readonly routingPolicy: AiCouncilRoutingPolicy;
  readonly governanceProfile: AiCouncilGovernanceProfile;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AiCouncilRoutingPolicy {
  readonly defaultMode: "ling_agent_only" | "prefer_council" | "explicit_mentions";
  readonly preferredWorkflowTemplateIds: readonly string[];
  readonly allowVisibleMultiReply: boolean;
  readonly selectorMode: "deterministic" | "model_assisted";
}
```

`coordinatorTeammateId` is explicit because future product variants may add more system
coordinators, but v1 should hard-code and validate `ling_agent`.

### Council Membership

Membership maps council slots to durable teammates.

```ts
type AiCouncilMemberSource = "template" | "user";

interface AiCouncilMember {
  readonly councilId: string;
  readonly teammateId: string;
  readonly slotKey: string;
  readonly roleLabel?: string;
  readonly source: AiCouncilMemberSource;
  readonly required: boolean;
  readonly enabled: boolean;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Rules:

- one teammate may belong to multiple councils;
- a council may contain multiple teammates with the same `roleKey`, but `slotKey` must
  be unique inside a council;
- disabling a member removes it from routing and workflow slot resolution, but does not
  disable the teammate globally;
- disabling a teammate makes all council memberships effectively unavailable;
- built-in template members can be hidden from a council only by explicit user override,
  not by bootstrap drift.

### Council Channel Policy

Channels should choose a preferred council independently from direct teammate membership.

```ts
interface ChannelCouncilPolicy {
  readonly channelId: string;
  readonly preferredCouncilId?: string;
  readonly attachedCouncilIds: readonly string[];
  readonly allowedCouncilIds: readonly string[];
  readonly defaultRoutingMode: "ling_agent_only" | "prefer_council" | "explicit_mentions";
  readonly visibleMultiReplyMaxParticipants: number;
}
```

This should live beside the existing channel collaboration protocol. Do not overload
`Channel.defaultTeammateId`; that field is already a legacy preferred specialist hint.

### Channel Attachments

A channel can attach either individual teammates or whole councils.

```text
Channel
  direct teammate memberships:
    teammate_channel_memberships

  council attachments:
    channel_council_policies.attachedCouncilIds

  effective channel specialists:
    direct memberships
    + enabled members from attached active councils
    - disabled teammates
    - disabled council members
    - channel policy exclusions
```

Attaching a council is a fast availability reference, not a copy operation. The channel
should see the council's current enabled members at resolution time. If a user wants a
fixed one-time expansion, the product can expose a separate "copy members into channel"
action that creates ordinary `teammate_channel_memberships` records.

Rules:

- council attachment does not create private threads for every member;
- council attachment does not bind new skills to members;
- council attachment does not change member memory scopes by itself;
- preferred council is a routing default, while attached councils are availability sets;
- removing a council attachment removes the projected members from that channel but does
  not remove direct teammate memberships.

## Resolution Rules

Council execution context is always resolved, never assumed:

```text
user message / task / workflow
  -> Ling Agent turn envelope
  -> selected council:
       explicit mention
       channel preferred council
       workflow template default
       workspace default council
  -> effective council:
       active council
       enabled members
       active teammates
       channel policy
       member skill/tool/provider readiness
       governance ceilings
  -> selected member, visible multi-reply, or workflow
```

The effective council is read-only evidence for a turn. It must not mutate memberships,
bindings, or permissions.

### Permission Invariant

Council policy can restrict or require stronger approval. It cannot grant authority.

```text
effective member action =
  teammate allowed tools
  + teammate skill binding
  + provider capability
  + channel policy
  + workspace approval policy
  + council governance ceiling
  + runner capability
  + state-machine legality

council membership is not permission
```

Examples:

- If Engineer has `write` but council policy requires approval for `write`, the run asks.
- If Designer lacks `bash`, Development Council cannot grant Designer `bash`.
- If Security Council marks external-send as strict, every member inherits the stricter
  approval requirement for council-scoped work.

## Runtime Behavior

### Normal Channel Message

Ling Agent remains the visible default responder.

```text
message in channel
  -> Ling Agent replies directly when no specialist/council work is needed
  -> Ling Agent routes to one council member when a specialist is clearly needed
  -> Ling Agent proposes a workflow when multi-step work is needed
  -> Ling Agent asks for clarification or approval when routing is risky
```

A channel having a preferred council does not mean every message creates a multi-agent
workflow.

### Explicit Council Mention

Mentioning a council is a routing hint, not a command to summon every member.

```text
@Development Council review this plan
  -> Ling Agent creates a council-scoped turn
  -> route options:
       plan-eng-review with Architect
       plan-design-review with Designer
       autoplan-lite workflow if broad review is requested
       visible multi-reply only when user asks for multiple opinions
```

### Workflow Slot Resolution

Workflow templates should gradually move from `teammateTemplateId` to slot resolution.

```ts
interface WorkflowStepTemplate {
  readonly id: string;
  readonly name: string;
  readonly phase: SkillWorkflowPhase;
  readonly teammateTemplateId?: string; // legacy fallback
  readonly councilSlotKey?: string;     // preferred new path
  readonly skillId: string;
  readonly dependsOn?: readonly string[];
  readonly approvalGate?: SkillApprovalProfile;
}
```

Compilation:

```text
WorkflowTemplate + selected Council
  -> resolve each councilSlotKey to an enabled AiCouncilMember
  -> write resolved teammateId into ChannelWorkflowStep metadata
  -> run through existing task/run/approval path
```

If a required slot is missing or blocked, workflow creation should fail with a clear
blocked reason before any step starts.

## Persistence Sketch

```sql
CREATE TABLE ai_councils (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  template_id TEXT,
  source TEXT NOT NULL,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  pinned INTEGER NOT NULL,
  hidden INTEGER NOT NULL,
  coordinator_teammate_id TEXT NOT NULL,
  default_workflow_template_ids_json TEXT NOT NULL,
  routing_policy_json TEXT NOT NULL,
  governance_profile_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY(coordinator_teammate_id) REFERENCES ai_teammates(id)
);

CREATE UNIQUE INDEX idx_ai_councils_workspace_slug
  ON ai_councils(workspace_id, slug);

CREATE INDEX idx_ai_councils_workspace_status
  ON ai_councils(workspace_id, status, hidden, pinned);

CREATE TABLE ai_council_members (
  council_id TEXT NOT NULL,
  teammate_id TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  role_label TEXT,
  source TEXT NOT NULL,
  required INTEGER NOT NULL,
  enabled INTEGER NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(council_id, slot_key),
  FOREIGN KEY(council_id) REFERENCES ai_councils(id) ON DELETE CASCADE,
  FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE
);

CREATE INDEX idx_ai_council_members_teammate
  ON ai_council_members(teammate_id);

CREATE TABLE channel_council_policies (
  channel_id TEXT PRIMARY KEY,
  preferred_council_id TEXT,
  attached_council_ids_json TEXT NOT NULL,
  allowed_council_ids_json TEXT NOT NULL,
  default_routing_mode TEXT NOT NULL,
  visible_multi_reply_max_participants INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY(preferred_council_id) REFERENCES ai_councils(id)
);
```

## Built-In Bootstrap

Bootstrap order:

```text
ensure Ling Agent
-> ensure built-in teammate templates
-> ensure Development Council
-> ensure Development Council member slots point at built-in teammate ids
-> ensure channel council policy defaults
```

Default behavior:

- new workspaces get `development` council;
- existing workspaces get `development` council during bootstrap without changing teammate
  personas, provider presets, memory scopes, channel memberships, or skill bindings;
- if a built-in teammate was tombstoned, the corresponding council slot is created as
  disabled/missing rather than resurrecting the teammate;
- deleting a custom council does not delete member teammates;
- archiving a built-in council hides it but records a retention tombstone, matching
  existing built-in teammate behavior.

## Client Compatibility

Council behavior must be daemon/core first. Web and future desktop clients should render
the same persisted state and effective read models.

Shared contract:

```text
Core/storage:
  ai_councils
  ai_council_members
  channel_council_policies
  effective council resolver
  council health resolver

Daemon API:
  list/get/update councils
  list/update members
  get effective council for channel/task/workflow
  get/update channel council policy
  emit audit/activity events

Clients:
  Web shell
  future desktop app
  future CLI or automation surfaces
```

Rules:

- no Council state should live only in Web component state, browser local storage, or
  route params;
- no runtime decision should depend on a Web-only selected row, expanded tree, or tab;
- desktop clients may present councils as a tree, split view, command palette, or separate
  window, but they must call the same daemon APIs;
- API responses should include stable ids, display names, member slot metadata, health
  findings, and resolved effective-member evidence so clients do not reimplement routing;
- activity/audit events should be client-neutral and not assume a browser URL as the only
  navigation target;
- client-specific layout language belongs in client sections, not in the storage or
  runtime contract.

Desktop-specific expectations:

- the desktop app can attach a council to a channel with the same API call as Web;
- desktop can show projected council members without materializing direct memberships;
- desktop can open member private chat or council workspace from the same ids;
- desktop can receive future local notifications for council health, blocked workflow
  slots, and approval gates from daemon events;
- desktop offline/cache behavior should treat effective council views as derived and
  refreshable, not as independently editable source of truth.

## Client Surfaces

These surfaces describe product affordances, not a Web-only layout. Web can implement them
inside the current app shell. A future desktop app can map the same concepts to native
navigation, split panes, command palettes, or separate windows.

### Navigation

Recommended structure:

```text
Ling Agent

Councils
  Development Council
    Product Strategist
    Architect
    Engineer
    Designer
    QA
    Security
    Release
    Docs
  Custom Council

Direct Teammates
  teammates not shown through an expanded council
```

Rules:

- Ling Agent stays outside the council tree.
- The same teammate can appear in multiple councils; use membership context in the row.
- Hidden/disabled teammates should not disappear silently from council health.
- A teammate private chat remains reachable from both council member rows and the global
  teammate roster.

### Council Workspace

Selecting a council opens a council workspace, not a group chat by default.

```text
Council header:
  name, description, status, provider/skill health summary

Overview:
  current members, default workflows, recent council-scoped work

Members:
  slot, teammate, role, provider readiness, skill health, enabled state

Workflows:
  allowed workflow templates and slot resolution preview

Routing:
  trigger phrases, channel defaults, visible multi-reply policy

Channels:
  where this council is preferred or allowed

Governance:
  approval ceilings, denied actions, external-send/deploy posture

Settings:
  rename, pin, hide, archive, clone as custom
```

The page should show actionable health:

- `missing_required_member`
- `member_provider_blocked`
- `member_effective_skill_blocked`
- `workflow_slot_unresolved`
- `council_policy_stricter_than_member`
- `orphaned_member_teammate`

### Channel Settings

Add a council section:

```text
Attached councils: Development Council
Preferred council: Development Council
Routing mode: Ling Agent only | Prefer council | Explicit mentions
Allowed councils: Development, Security
Visible multi-reply max: 1..N
```

Default should be conservative:

- ordinary messages still go to Ling Agent;
- executable work may prefer the channel council for specialist routing;
- attaching `Development Council` projects its enabled members into the channel without
  copying them into direct teammate memberships;
- multi-reply requires explicit user request or workflow selection.

## API Sketch

```text
GET    /ai-councils?cwd=...
POST   /ai-councils?cwd=...
GET    /ai-councils/:id?cwd=...
PATCH  /ai-councils/:id?cwd=...
DELETE /ai-councils/:id?cwd=...

GET    /ai-councils/:id/members?cwd=...
PUT    /ai-councils/:id/members?cwd=...
PATCH  /ai-councils/:id/members/:slotKey?cwd=...

GET    /ai-councils/:id/effective?channelId=...&cwd=...
GET    /ai-councils/health?cwd=...

GET    /channels/:id/council-policy?cwd=...
PUT    /channels/:id/council-policy?cwd=...
```

Creation should support two paths:

```ts
interface CreateAiCouncilInput {
  readonly templateId?: string;
  readonly displayName: string;
  readonly description?: string;
  readonly memberInputs?: readonly CreateAiCouncilMemberInput[];
  readonly cloneFromCouncilId?: string;
}
```

Do not let council creation silently change teammate permissions or skill bindings.

## Interaction With Skills

Skills remain bound to teammates. Councils can recommend or require workflow templates, but
they should not duplicate teammate skill bindings in v1.

The effective council view can show skill coverage:

```text
Development Council
  plan-eng-review -> Architect, Engineer
  design-review   -> Designer, QA
  qa              -> QA
  ship            -> Release
```

If no enabled council member can run a selected skill, the run blocks before starting.

Future extension: `council_skill_policy` may define "this council may only use these
skills", but it should still be a restriction layer, not a grant layer.

## Interaction With Memory

V1 should avoid council-owned always-on memory. It is too easy to create hidden leakage
between teammates.

Allowed in v1:

- council description and explicit notes;
- channel context selected for the current turn;
- workflow evidence packets;
- member private memory used only by that member's own run;
- run inspector evidence showing which context each member received.

Deferred:

- reviewed council memory candidates;
- explicit shared council memory scopes;
- user-managed council knowledge base;
- cross-member recall summaries with provenance and opt-in review.

## Security And Governance

Council changes can affect routing and future execution, so they need audit records.

Audit events:

- council created, renamed, archived, cloned;
- member added, removed, enabled, disabled, slot changed;
- channel preferred council changed;
- council routing mode changed;
- governance profile changed;
- workflow slot resolution failed or changed.

Protected rules:

- Ling Agent cannot be removed from its coordinator role.
- Ling Agent cannot be added as a normal council member in v1.
- Built-in Development Council can be hidden or archived, but not hard-deleted without a
  retention tombstone.
- A council cannot own credentials or provider accounts.
- A council cannot bypass teammate-level MCP authorization.

## Rollout Plan

1. Documentation and type contracts.
   Add `AiCouncil` design, built-in Development Council template, and runtime invariants.

2. Storage.
   Add `ai_councils`, `ai_council_members`, and `channel_council_policies` tables.

3. Bootstrap.
   Seed Development Council after built-in teammates, preserving tombstones and user
   overrides.

4. Read APIs and health.
   List councils, members, effective council, and health findings.

5. Channel attachment policy.
   Add attached councils, preferred council, and routing mode controls without changing
   ordinary Ling Agent replies.

6. Shared client DTOs.
   Keep council list, effective council, health findings, and channel policy responses
   stable enough for Web and desktop clients.

7. Web information architecture.
   Add Councils navigation section and Council Workspace overview/members/settings pages.

8. Desktop compatibility pass.
   Verify the same APIs can support native navigation, separate windows, cached effective
   views, and local notification/event rendering without Web-only state.

9. Workflow slot resolution.
   Let `WorkflowStepTemplate` resolve `councilSlotKey` through selected council, with
   `teammateTemplateId` as migration fallback.

10. Custom councils.
   Create, clone, edit, archive, and member management.

11. Runtime routing.
   Let Ling Agent use effective council evidence when selecting a specialist, visible
   multi-reply, or workflow.

## Test Plan

Core:

- built-in Development Council seeds once and preserves existing teammates;
- tombstoned built-in teammate leaves a missing/disabled council slot;
- one teammate can belong to multiple councils;
- archiving a council does not delete teammates;
- effective council excludes disabled members and disabled teammates;
- effective channel specialists combine direct teammates and projected attached council
  members without duplicating records;
- council governance can only tighten approval/tool posture.

Daemon:

- council CRUD validates workspace and unique slug;
- member replacement validates teammate ids and slot uniqueness;
- channel council policy rejects missing/archived councils;
- attaching and detaching a council changes effective channel specialists but does not
  mutate `teammate_channel_memberships`;
- workflow compilation blocks on missing required slot;
- audit events are emitted for routing-affecting changes.

Client contract:

- council list, effective council, health, and channel policy APIs contain enough stable
  data for both Web and desktop clients;
- client-neutral audit/activity events do not require browser URLs;
- effective council views are derived and refreshable, not independently writable.

Web:

- Ling Agent remains visible outside council tree;
- Development Council expands to built-in members;
- council health shows missing provider/skill/member issues;
- channel settings show preferred council without changing ordinary chat reply behavior;
- custom council create/edit/archive flows do not mutate teammate permissions.

Desktop:

- desktop can attach or detach a council from a channel through the same daemon API;
- desktop can render projected council members without copying direct memberships;
- desktop can open council workspace and member private chat from stable ids;
- desktop can cache effective council views and refresh them after daemon events.

Runtime:

- ordinary message still replies as Ling Agent;
- explicit council mention routes through effective council;
- selected specialist run receives only that member's allowed context;
- workflow step stores resolved teammate id and council snapshot evidence;
- denied tool remains denied even when council workflow suggests it.

## Open Questions

- Should the first client release rename the existing `AI Teammates` navigation item to
  `Councils`, or add `Councils` above it while keeping `AI Teammates` as management?
- Should a channel have exactly one preferred council, multiple ordered preferred
  councils, or one preferred council plus many attached councils?
- Should custom council creation default to reusing existing teammates or cloning template
  teammates into new durable instances?
- Should built-in teammate visibility be primarily controlled from teammate settings or
  council membership settings?
- Should visible multi-reply use a council-specific transcript surface, or keep all
  replies folded into the existing channel feed evidence model?
- Should the desktop app expose Council Workspace as a normal workspace page, a detachable
  window, or both?
