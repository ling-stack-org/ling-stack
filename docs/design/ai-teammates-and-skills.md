# AI Teammates and Skills

Ling Stack needs a skills layer before it can safely support multi-agent work.

Tools are atomic capabilities such as `read`, `grep`, `bash`, `edit`, and `write`. Skills are task workflow templates such as planning, review, QA, security review, and release. AI teammates bind roles to skills, tools, provider capabilities, approval policy, and workflow state.

## Design Goals

- Let different AI teammates have different default skills.
- Keep skills as workflow templates, not direct execution permission.
- Support gstack-inspired defaults without vendoring gstack's long runtime `SKILL.md` files.
- Leave room for future `AGENTS.md` and custom user-defined skill packs.
- Ensure every skill execution still goes through allowed tools, provider capability checks, approval policy, and workflow state machines.

This design sits under the broader [Ling Framework](ling-framework.md). Memory-specific
behavior for teammates is covered by [Ling Memory v1](ling-memory-v1.md).
The concrete import, persona draft, Effective Skill UI, and skill-aware run implementation
slice is covered by [Ling Skill Import v1](ling-skill-import-v1.md). The workspace-level
grouping model for built-in and user-defined specialist rosters is covered by
[AI Councils](ai-councils.md). Automatic multi-teammate execution is covered by
[Multi-Agent Orchestrator](multi-agent-orchestrator.md).
The broader daemon and registry evolution is covered by
[Runtime Control Plane Roadmap](runtime-control-plane-roadmap.md).

## Model

```ts
interface SkillPack {
  id: string;
  source: "builtin" | "gstack" | "agents-md" | "custom";
  name: string;
  version: string;
  skills: SkillDefinition[];
  teammateTemplates: AiTeammateTemplate[];
  workflowTemplates: WorkflowTemplate[];
}

interface SkillDefinition {
  id: string;
  roleAffinity: AiTeammateRoleKey[];
  workflowPhase: SkillWorkflowPhase;
  promptFragments: string[];
  requiredTools: RunTool[];
  requiredProviderCapabilities: ProviderCapability[];
  approvalProfile: SkillApprovalProfile;
  stateEffects: SkillStateEffect[];
}

interface AiTeammateTemplate {
  id: string;
  roleKey: AiTeammateRoleKey;
  defaultSkillIds: string[];
  allowedTools: RunTool[];
  requiredProviderCapabilities: ProviderCapability[];
  approvalProfile: SkillApprovalProfile;
  systemPrompt: string;
}
```

The first implementation started as static, read-only metadata in `packages/core`. The
durable teammate workspace slice now adds SQLite-backed teammate instances, channel
memberships, skill bindings, memory-scope metadata, and direct private threads.

The Web UI still reads the built-in pack for template detail, but saving from the wizard
now creates a durable daemon-backed teammate. The wizard remains a draft input surface
until the user presses `Create teammate`; after save, the sidebar and management roster
come from daemon state.

The current Web slice models the future client flow without locking the backend schema:

```text
choose role template or blank
-> choose provider/model preset
-> fill teammate name and brief
-> choose channels; default private and channel memory scopes are provisioned automatically
-> create durable workspace teammate
```

This proves the product interaction for per-teammate model selection, channel binding, and
always-on scoped memory metadata without giving skills execution authority or bypassing
the coordinator/state-machine path.

## Teammate Persona Sources

The current implementation stores a thin `systemPrompt` on each durable teammate and lets
the private workspace settings edit it. That is the first persona layer.

The target model should allow per-teammate profile sources such as `AGENT.md` or
`persona.md`. These files can define role, behavior, tone, working preferences, and
long-term persona anchors. They should import into reviewed teammate profile drafts before
changing the durable teammate record.

Persona sources do not grant permission. The effective execution boundary remains:

```text
teammate policy
+ channel policy
+ provider capability
+ allowed tools
+ approval policy
+ state-machine legality
```

This keeps imported markdown from becoming an implicit tool, approval, or external-send
grant.

## Built-In Pack: `gstack-default`

`gstack-default` is a Ling-native template pack inspired by gstack's virtual engineering team model. It borrows the role, workflow, and generic skill taxonomy, not the full gstack runtime instruction files or machine-specific tools.

Default teammate templates:

- `Product Strategist`
- `Architect`
- `Engineer`
- `Designer`
- `QA`
- `Security`
- `Release`
- `Docs`

Default skills:

- `office-hours`
- `plan-ceo-review`
- `plan-eng-review`
- `plan-design-review`
- `plan-devex-review`
- `autoplan`
- `spec`
- `design-consultation`
- `design-shotgun`
- `design-html`
- `implement`
- `investigate`
- `health`
- `review`
- `design-review`
- `qa`
- `qa-only`
- `devex-review`
- `benchmark`
- `cso`
- `landing-report`
- `setup-deploy`
- `ship`
- `land-and-deploy`
- `canary`
- `document-generate`
- `document-release`
- `retro`
- `learn`

Runtime-only gstack commands such as `gstack-upgrade`, browser-cookie import,
gbrain sync/setup, iOS device automation, and other host-specific tools remain outside
the built-in Ling pack until Ling has first-class capability and approval models for
those surfaces.

## Template Defaults And Durable Overrides

Built-in teammate templates should behave as template defaults plus durable user
overrides, not as seed-once records that drift permanently after first creation.

When a built-in template gains a default skill, existing built-in teammates should
backfill the missing template binding unless the user has explicitly overridden that
skill. Backfill must be non-destructive:

- preserve existing enabled/disabled state for template bindings;
- preserve custom user-added skill bindings;
- avoid recreating tombstoned built-in teammates;
- avoid resetting teammate persona, provider, channel, or memory settings;
- keep active runs on the skill snapshot they started with.

This keeps Ling closer to Codex-style effective capability resolution while preserving
Ling's durable teammate and audit model.
The implementation breakdown lives in
[Runtime Control Plane Short-Term Implementation Plan](runtime-control-plane-short-term-implementation-plan.md).

Default workflow:

```text
autoplan-lite:
  product discovery
  -> product review
  -> design review
  -> engineering review
  -> implementation
  -> code review + QA
  -> ship
```

## Safety Rules

Skills do not grant execution authority. A skill can require tools and provider capabilities, but the run can only proceed when all of these layers agree:

1. The AI teammate is allowed to use the skill.
2. The skill-required tools are available for the run.
3. The provider has the required capabilities.
4. Approval policy allows, asks for, or denies risky tools.
5. The workflow state machine allows the next transition.

`ship`, `cso`, and release-like workflows use stricter approval profiles by default. Ordinary `Engineer` templates do not include `ship` or `cso` as default skills.

## Web Management Slice

`apps/web` includes an `AI Teammates` page for the `gstack-default` pack.

The current management view follows the Stitch `Ling Stack Strict Daylight UX v3`
direction. It is intentionally a quiet management surface, not a separate AI workbench
or marketing page:

- the page uses a two-column desktop layout: workspace teammates on the left and default
  role templates on the right,
- workspace teammate rows show avatar, name, provider/channel summary, provider readiness
  dot, and compact row actions,
- default role cards open a right-side role detail Sheet,
- `Add teammate` opens a right-side Sheet instead of replacing the page,
- Sheets use strict daylight styling: pure white surfaces, `#111111` primary text,
  `#6B6B6B` secondary text, `#E5E5E5` borders, `#F5F5F5` hover/selected state, and
  radius no larger than 8px,
- role detail explains what the role does, best-fit scenarios, default skills, and safety
  boundaries; system prompt, tools, provider capabilities, and workflow remain folded in
  advanced details,
- creating a teammate is blocked when the selected provider preset is not runnable, with
  a direct path back to the Model Workbench.

The page should behave like a client management view:

- list built-in teammate templates from `@ling-stack/core/builtin-skill-packs`,
- show each template's role, default skills, allowed tools, provider capabilities, system prompt, and approval profile,
- provide a right-side Sheet with `Role -> Model -> Basic information -> Advanced settings`
  sections that creates a durable workspace teammate through the daemon,
- prefer adapted default roles from `gstack-default`; if no template fits, allow `Start from blank` with a short description,
- let each teammate bind a different provider/model preset,
- let each teammate persist channel membership and memory-scope metadata,
- expose sidebar pin/hide controls backed by teammate settings,
- show the `autoplan-lite` workflow as a state-machine-gated sequence,
- keep strict skills such as `ship` and `cso` visibly marked as stricter approval paths.

This page must not imply more than the implemented persistence. Durable teammate
instances, channel memberships, skill bindings, memory-scope metadata, and private
threads exist. The private workspace can edit channel memberships and bind or disable
built-in or custom skills for a teammate. Custom skill import drafts, publish-to-registry,
persona import UI, teammate workspace `requestedSkillId` task creation, and Effective
Skill blocked-reason display exist. Optional vector retrieval provider installation,
global skill-aware task controls, and full memory editing inside the teammate workspace
are follow-up slices.

The durable persistence and private conversation implementation record is captured in
[Helio-Inspired AI Teammate Private Workspace](ai-teammate-private-workspace.md).

## Multi-Agent Skill Management Design

External agent frameworks converge on the same core lesson: agent collaboration works
when handoffs, tools, guardrails, and task state are explicit. OpenAI Agents SDK models
handoffs and guardrails as first-class runtime concepts. LangGraph recommends graph-like
supervisor, network, and handoff patterns for multi-agent state. AutoGen teams formalize
group chat and termination conditions. CrewAI separates agents, tasks, tools, crews, and
flows so execution does not depend on a free-form chat loop.

Relevant references:

- [OpenAI Agents SDK handoffs](https://openai.github.io/openai-agents-js/guides/handoffs/)
- [OpenAI Agents SDK guardrails](https://openai.github.io/openai-agents-js/guides/guardrails/)
- [LangGraph multi-agent systems](https://langchain-ai.github.io/langgraph/concepts/multi_agent/)
- [AutoGen AgentChat teams](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/teams.html)
- [CrewAI crews](https://docs.crewai.com/concepts/crews)

### Product Model

Ling Stack should use three layers:

1. Workspace Skill Library.
   The library stores built-in skills, future imported `AGENTS.md` skills, and future
   custom skill definitions. A skill definition is a workflow template with prompts,
   required tools, provider capability requirements, approval profile, state effects,
   and compatibility metadata.
2. Teammate Skill Bindings.
   A teammate binding says whether one teammate may use a skill template by default.
   Bindings can come from a template or user edit, and can be disabled without deleting
   the library definition.
3. Effective Capability View.
   The runtime computes what can actually execute by intersecting teammate bindings,
   teammate allowed tools, provider capabilities, channel runtime policy, approval
   policy, and workflow state-machine position.

The Web UI should never present "skill enabled" as "permission granted". A bound skill
means the teammate can propose or start that workflow only when the effective capability
check passes.

### Execution Model

Multi-agent work should be Flow-first:

```text
task/workflow created
-> state machine selects next step
-> coordinator assigns teammate + skill
-> effective capability check
-> scoped prompt builder
-> run starts with explicit tools and approvals
-> artifact/event/state transition is persisted
-> next teammate receives filtered handoff context
```

The teammate should not self-call another teammate by private chat. Cross-agent
handoffs must be durable workflow events with a source step, target teammate, skill id,
filtered context, and approval profile.

### Trust Boundaries

- Private chat is private by default. It is not part of a channel or workflow handoff
  unless the user promotes a message, summary, or task.
- Channel membership provisions that teammate's own channel brief and decision memory
  scopes. It does not expose another teammate's private memory, another channel's memory,
  or workflow/task memory without an explicit reviewed handoff.
- A skill can request tools, but final tool availability comes from the effective
  capability check.
- Strict skills such as `ship` and `cso` must surface higher approval requirements
  before a run starts.
- Imported or custom skills start as disabled drafts until parsed, reviewed, and bound.

### Implementation Plan

Phase 1 is now implemented as the private workspace binding editor: use existing
`teammate_skill_bindings`, show the built-in library, bind or disable skills per teammate,
manually add custom `source: "user"` skill ids, delete manually added bindings, and persist
through `PUT /teammates/:id/skills`. Template-default `source: "template"` bindings are
protected by the store and cannot be deleted; users can only disable them.

Phase 2 is implemented as the Effective Skills read model:

```ts
interface EffectiveTeammateSkill {
  skillId: string;
  teammateId: string;
  bound: boolean;
  enabled: boolean;
  executable: boolean;
  blockedReasons: string[];
  requiredTools: string[];
  missingTools: string[];
  missingProviderCapabilities: string[];
  approvalProfile: SkillApprovalProfile;
}
```

Phase 3 is implemented at the daemon/runtime layer for skill-aware task and workflow
starts. A task may include
`requestedSkillId`; the runner resolves the teammate, validates effective capability,
merges skill prompt fragments, required tools, and approval profile, then records the
selected skill on the run.

Phase 4 is implemented as Ling Skill Import v1. It persists custom skill definitions and
import drafts, then upgrades the private workspace UI around the existing runtime
foundation. The supported v1 inputs are Ling-native JSON plus reviewed markdown/`SKILL.md`
imports; `AGENTS.md`/`AGENT.md`/`persona.md` enter as teammate persona drafts. The importer
produces drafts, parse warnings, required tool previews, provider capability previews, and
approval previews before any teammate can bind or run imported definitions. PATCH-style
draft editing and deeper custom skill editing remain follow-ups. See
[Ling Skill Import v1](ling-skill-import-v1.md).

### Failure Modes To Avoid

- Free-form agent-to-agent loops that create hidden work, hidden context transfer, or
  no durable state.
- Treating a skill file as executable permission. Skill text is a template, not an auth
  grant.
- Letting private chat memory silently leak into channel tasks or cross-agent handoffs.
- Letting imports run immediately. Imported skills need review, diff, and explicit bind.
- Mixing template defaults with user overrides without source and enabled state.

## Future Work

- Persist custom skill packs in the workspace database.
- Add daemon APIs for listing built-in and custom skill packs.
- Add the Effective Skills read model and blocked-reason UI.
- Build richer UI controls for reviewing and managing memory content from the private
  workspace tabs. Memory availability itself remains always on for AI teammates.
- Add importers for `AGENTS.md` and compatible skill directories.
- Compile workflow templates into durable workflow and workflow-step state machines; see
  [Multi-Agent Orchestrator](multi-agent-orchestrator.md).
