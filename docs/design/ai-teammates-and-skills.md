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

The first implementation is static and read-only in `packages/core`. It deliberately does not add daemon API or SQLite tables yet.

The Web UI can read the built-in pack and expose a management surface, but any added teammate is only a local UI draft until the daemon and database contract exists.

The current Web slice models the future client flow without locking the backend schema:

```text
choose role template or blank
-> choose provider/model preset
-> fill teammate name and brief
-> choose channels and memory/file sources
-> create local draft
```

This is intentionally UI state only. It proves the product interaction for per-teammate model selection, channel binding, and scoped memory/file configuration without giving skills execution authority or bypassing the coordinator/state-machine path.

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
- provide a four-step `Role -> Model -> Profile -> Scope` wizard that creates a local draft in UI state only,
- prefer adapted default roles from `gstack-default`; if no template fits, allow `Start from blank` with a short description,
- let each draft bind a different provider/model preset,
- let each draft record intended channel membership and memory/file sources,
- expose lightweight sidebar pin/hide controls for teammate presence,
- show the `autoplan-lite` workflow as a state-machine-gated sequence,
- keep strict skills such as `ship` and `cso` visibly marked as stricter approval paths.

This page must not imply persistence before a daemon API exists. Saving teammate instances, editing bindings, importing custom packs, and assigning teammates to channels are follow-up slices.

## Future Work

- Persist custom skill packs in the workspace database.
- Add daemon APIs for listing built-in and custom skill packs.
- Persist Web-created teammate instances and allow assigning skills to teammates.
- Add importers for `AGENTS.md` and compatible skill directories.
- Compile workflow templates into durable workflow and workflow-step state machines.
