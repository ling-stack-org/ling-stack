# AI Teammates and Skills

Ling Stack needs a skills layer before it can safely support multi-agent work.

Tools are atomic capabilities such as `read`, `grep`, `bash`, `edit`, and `write`. Skills are task workflow templates such as planning, review, QA, security review, and release. AI teammates bind roles to skills, tools, provider capabilities, approval policy, and workflow state.

## Design Goals

- Let different AI teammates have different default skills.
- Keep skills as workflow templates, not direct execution permission.
- Support gstack-inspired defaults without vendoring gstack's long runtime `SKILL.md` files.
- Leave room for future `AGENTS.md` and custom user-defined skill packs.
- Ensure every skill execution still goes through allowed tools, provider capability checks, approval policy, and workflow state machines.

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
-> choose channels and memory/file sources
-> create durable workspace teammate
```

This proves the product interaction for per-teammate model selection, channel binding, and
scoped memory metadata without giving skills execution authority or bypassing the
coordinator/state-machine path.

## Built-In Pack: `gstack-default`

`gstack-default` is a Ling-native template pack inspired by gstack's virtual engineering team model. It borrows the role and workflow shape, not the full gstack runtime instruction files.

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
- `implement`
- `investigate`
- `review`
- `qa`
- `cso`
- `ship`
- `document-release`

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

The page should behave like a client management view:

- list built-in teammate templates from `@ling-stack/core/builtin-skill-packs`,
- show each template's role, default skills, allowed tools, provider capabilities, system prompt, and approval profile,
- provide a four-step `Role -> Model -> Profile -> Scope` wizard that creates a durable
  workspace teammate through the daemon,
- prefer adapted default roles from `gstack-default`; if no template fits, allow `Start from blank` with a short description,
- let each teammate bind a different provider/model preset,
- let each teammate persist channel membership and memory-scope metadata,
- expose sidebar pin/hide controls backed by teammate settings,
- show the `autoplan-lite` workflow as a state-machine-gated sequence,
- keep strict skills such as `ship` and `cso` visibly marked as stricter approval paths.

This page must not imply more than the implemented persistence. Durable teammate
instances, channel memberships, skill bindings, memory-scope metadata, and private
threads exist. Custom skill-pack import, automatic memory recall, private attachments,
avatar uploads, and full channel/skill/memory editing inside the teammate workspace are
follow-up slices.

The durable persistence and private conversation implementation record is captured in
[Helio-Inspired AI Teammate Private Workspace](ai-teammate-private-workspace.md).

## Future Work

- Persist custom skill packs in the workspace database.
- Add daemon APIs for listing built-in and custom skill packs.
- Build richer UI controls for editing channel memberships, skill bindings, and memory
  scopes from the private workspace tabs.
- Add importers for `AGENTS.md` and compatible skill directories.
- Compile workflow templates into durable workflow and workflow-step state machines.
