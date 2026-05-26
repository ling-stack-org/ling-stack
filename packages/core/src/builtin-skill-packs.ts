import { readOnlyRunTools, type RunTool } from "./approval-policy.js";
import type { ProviderCapability } from "./provider-types.js";
import type {
  AiTeammateTemplate,
  SkillApprovalProfile,
  SkillDefinition,
  SkillPack,
  SkillWorkflowPhase,
  WorkflowStepTemplate,
  WorkflowTemplate,
} from "./skill-types.js";

export const GSTACK_DEFAULT_SKILL_PACK_ID = "gstack-default";

const chatReasoningCapabilities = ["chat", "reasoning"] as const satisfies readonly ProviderCapability[];
const toolCallingCapabilities = ["chat", "tool_call"] as const satisfies readonly ProviderCapability[];
const readOnlyTools = [...readOnlyRunTools] as const;
const codingTools = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const satisfies readonly RunTool[];
const testTools = ["read", "grep", "find", "ls", "bash"] as const satisfies readonly RunTool[];

const noApproval: SkillApprovalProfile = { mode: "none" };
const standardApproval: SkillApprovalProfile = {
  mode: "standard",
  risk: "medium",
  requiredForTools: ["bash", "edit", "write"],
};
const strictReleaseApproval: SkillApprovalProfile = {
  mode: "strict",
  risk: "critical",
  requiredForTools: ["bash", "edit", "write"],
  requiredForActions: ["git_commit", "git_push", "deploy", "external_send"],
};
const strictSecurityApproval: SkillApprovalProfile = {
  mode: "strict",
  risk: "high",
  requiredForActions: ["credential_change", "provider_change", "external_send", "deploy"],
};

function skill(input: {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly roleAffinity: readonly SkillDefinition["roleAffinity"][number][];
  readonly workflowPhase: SkillWorkflowPhase;
  readonly promptFragments: readonly string[];
  readonly requiredTools?: readonly RunTool[];
  readonly requiredProviderCapabilities?: readonly ProviderCapability[];
  readonly approvalProfile?: SkillApprovalProfile;
  readonly stateEffects?: readonly SkillDefinition["stateEffects"][number][];
}): SkillDefinition {
  return {
    requiredTools: input.requiredTools ?? readOnlyTools,
    requiredProviderCapabilities: input.requiredProviderCapabilities ?? chatReasoningCapabilities,
    approvalProfile: input.approvalProfile ?? noApproval,
    stateEffects: input.stateEffects ?? [],
    ...input,
  };
}

const gstackDefaultSkills: readonly SkillDefinition[] = [
  skill({
    id: "office-hours",
    name: "Office Hours",
    summary: "Challenge the product premise, clarify demand, and frame the work before implementation.",
    roleAffinity: ["product"],
    workflowPhase: "discover",
    promptFragments: [
      "Find the real user pain, the status quo, and the smallest high-leverage next slice.",
      "Prefer hard tradeoffs and explicit scope over broad brainstorming.",
    ],
    stateEffects: ["creates_plan"],
  }),
  skill({
    id: "plan-ceo-review",
    name: "CEO Plan Review",
    summary: "Review scope and strategy before the team spends engineering time.",
    roleAffinity: ["product"],
    workflowPhase: "plan",
    promptFragments: [
      "Decide whether to expand, hold, reduce, or redirect scope.",
      "Surface the one product decision that most affects user value.",
    ],
    stateEffects: ["updates_plan"],
  }),
  skill({
    id: "plan-eng-review",
    name: "Engineering Plan Review",
    summary: "Lock architecture, data flow, edge cases, and the test plan before implementation.",
    roleAffinity: ["architect", "engineer"],
    workflowPhase: "plan",
    promptFragments: [
      "Identify irreversible decisions, state ownership, and integration boundaries.",
      "Require a concrete validation path before build work starts.",
    ],
    stateEffects: ["updates_plan"],
  }),
  skill({
    id: "plan-design-review",
    name: "Design Plan Review",
    summary: "Review UX direction, visual system, hierarchy, and interaction gaps before UI build.",
    roleAffinity: ["designer", "product"],
    workflowPhase: "design",
    promptFragments: [
      "Check whether the interface is a useful product surface, not a decorative mockup.",
      "Call out layout, hierarchy, and responsiveness decisions that must be settled.",
    ],
    stateEffects: ["updates_plan"],
  }),
  skill({
    id: "implement",
    name: "Implementation",
    summary: "Turn an approved plan into scoped code changes while preserving approval and state boundaries.",
    roleAffinity: ["engineer"],
    workflowPhase: "implement",
    promptFragments: [
      "Implement only the approved slice and keep unrelated refactors out of scope.",
      "Use state machines, approval policy, and tool boundaries as hard constraints.",
    ],
    requiredTools: codingTools,
    requiredProviderCapabilities: toolCallingCapabilities,
    approvalProfile: standardApproval,
    stateEffects: ["starts_run", "requests_approval", "creates_artifact"],
  }),
  skill({
    id: "investigate",
    name: "Investigate",
    summary: "Trace a bug or failure from evidence to root cause before proposing fixes.",
    roleAffinity: ["engineer", "qa", "security"],
    workflowPhase: "review",
    promptFragments: [
      "Reproduce or locate evidence before changing code.",
      "Separate symptoms, root cause, and fix validation.",
    ],
    requiredTools: testTools,
    approvalProfile: standardApproval,
    stateEffects: ["starts_run", "creates_artifact"],
  }),
  skill({
    id: "review",
    name: "Code Review",
    summary: "Find behavioral bugs, missing tests, risky assumptions, and production failure modes.",
    roleAffinity: ["architect", "engineer", "security"],
    workflowPhase: "review",
    promptFragments: [
      "Find concrete issues first, ordered by severity and backed by file references.",
      "Prefer defects and missing validation over style commentary.",
    ],
    stateEffects: ["creates_artifact"],
  }),
  skill({
    id: "qa",
    name: "QA",
    summary: "Exercise the built experience, verify user-facing behavior, and capture regressions.",
    roleAffinity: ["qa", "designer"],
    workflowPhase: "test",
    promptFragments: [
      "Test the real surface, not just static code paths.",
      "Record failures as reproducible scenarios with expected and actual behavior.",
    ],
    requiredTools: testTools,
    requiredProviderCapabilities: toolCallingCapabilities,
    approvalProfile: standardApproval,
    stateEffects: ["starts_run", "creates_artifact"],
  }),
  skill({
    id: "cso",
    name: "Security Review",
    summary: "Review trust boundaries, secrets, supply chain, and high-impact abuse paths.",
    roleAffinity: ["security"],
    workflowPhase: "secure",
    promptFragments: [
      "Focus on exploitable paths and false-positive reduction.",
      "Do not perform credential, deploy, or external-send actions without explicit approval.",
    ],
    approvalProfile: strictSecurityApproval,
    stateEffects: ["creates_artifact", "requests_approval"],
  }),
  skill({
    id: "ship",
    name: "Ship",
    summary: "Prepare release checks, commits, pushes, PRs, and deploy handoff under strict approval.",
    roleAffinity: ["release"],
    workflowPhase: "ship",
    promptFragments: [
      "Synchronize with the base branch, run the agreed validation, and publish only approved changes.",
      "Git push, deploy, and external notifications require explicit approval gates.",
    ],
    requiredTools: codingTools,
    requiredProviderCapabilities: toolCallingCapabilities,
    approvalProfile: strictReleaseApproval,
    stateEffects: ["prepares_release", "requests_approval", "creates_artifact"],
  }),
  skill({
    id: "document-release",
    name: "Document Release",
    summary: "Update product and technical documentation so shipped behavior remains discoverable.",
    roleAffinity: ["docs", "release"],
    workflowPhase: "document",
    promptFragments: [
      "Document shipped behavior, public interfaces, and user-visible workflow changes.",
      "Keep docs as a source of truth for later implementation and support.",
    ],
    requiredTools: ["read", "grep", "find", "ls", "edit", "write"],
    requiredProviderCapabilities: chatReasoningCapabilities,
    approvalProfile: standardApproval,
    stateEffects: ["updates_docs", "creates_artifact"],
  }),
];

const gstackDefaultTeammates: readonly AiTeammateTemplate[] = [
  {
    id: "product-strategist",
    name: "Product Strategist",
    roleKey: "product",
    summary: "Frames the problem, scope, and product tradeoffs before build work.",
    defaultSkillIds: ["office-hours", "plan-ceo-review"],
    allowedTools: readOnlyTools,
    requiredProviderCapabilities: chatReasoningCapabilities,
    approvalProfile: noApproval,
    systemPrompt: "You are Ling Stack's product strategist. Clarify demand, scope, and value before execution.",
  },
  {
    id: "architect",
    name: "Architect",
    roleKey: "architect",
    summary: "Owns architecture, data flow, state boundaries, and validation strategy.",
    defaultSkillIds: ["plan-eng-review", "review"],
    allowedTools: readOnlyTools,
    requiredProviderCapabilities: chatReasoningCapabilities,
    approvalProfile: noApproval,
    systemPrompt: "You are Ling Stack's architect. Make state, ownership, and testing decisions explicit.",
  },
  {
    id: "engineer",
    name: "Engineer",
    roleKey: "engineer",
    summary: "Implements approved tasks and investigates failures within approval policy.",
    defaultSkillIds: ["implement", "investigate", "review"],
    allowedTools: codingTools,
    requiredProviderCapabilities: toolCallingCapabilities,
    approvalProfile: standardApproval,
    systemPrompt: "You are Ling Stack's engineer. Build the approved slice and keep all side effects auditable.",
  },
  {
    id: "designer",
    name: "Designer",
    roleKey: "designer",
    summary: "Reviews product UI, interaction quality, visual hierarchy, and workflow ergonomics.",
    defaultSkillIds: ["plan-design-review", "qa"],
    allowedTools: readOnlyTools,
    requiredProviderCapabilities: chatReasoningCapabilities,
    approvalProfile: noApproval,
    systemPrompt: "You are Ling Stack's designer. Protect usability, hierarchy, and interaction clarity.",
  },
  {
    id: "qa",
    name: "QA",
    roleKey: "qa",
    summary: "Verifies behavior, regression scenarios, and user-facing workflows.",
    defaultSkillIds: ["qa", "investigate"],
    allowedTools: testTools,
    requiredProviderCapabilities: toolCallingCapabilities,
    approvalProfile: standardApproval,
    systemPrompt: "You are Ling Stack's QA teammate. Test real behavior and report reproducible failures.",
  },
  {
    id: "security",
    name: "Security",
    roleKey: "security",
    summary: "Reviews trust boundaries, secrets, approvals, and abuse cases.",
    defaultSkillIds: ["cso", "review"],
    allowedTools: readOnlyTools,
    requiredProviderCapabilities: chatReasoningCapabilities,
    approvalProfile: strictSecurityApproval,
    systemPrompt: "You are Ling Stack's security teammate. Find exploitable paths and protect trust boundaries.",
  },
  {
    id: "release",
    name: "Release",
    roleKey: "release",
    summary: "Prepares release checks and publication steps under strict approval.",
    defaultSkillIds: ["ship", "document-release"],
    allowedTools: codingTools,
    requiredProviderCapabilities: toolCallingCapabilities,
    approvalProfile: strictReleaseApproval,
    systemPrompt: "You are Ling Stack's release teammate. Publish only approved, validated changes.",
  },
  {
    id: "docs",
    name: "Docs",
    roleKey: "docs",
    summary: "Keeps product, API, and workflow documentation aligned with shipped behavior.",
    defaultSkillIds: ["document-release"],
    allowedTools: ["read", "grep", "find", "ls", "edit", "write"],
    requiredProviderCapabilities: chatReasoningCapabilities,
    approvalProfile: standardApproval,
    systemPrompt: "You are Ling Stack's documentation teammate. Keep docs concise, accurate, and implementation-backed.",
  },
];

const autoplanLiteSteps: readonly WorkflowStepTemplate[] = [
  {
    id: "product-discovery",
    name: "Product Discovery",
    phase: "discover",
    teammateTemplateId: "product-strategist",
    skillId: "office-hours",
  },
  {
    id: "product-review",
    name: "Product Review",
    phase: "plan",
    teammateTemplateId: "product-strategist",
    skillId: "plan-ceo-review",
    dependsOn: ["product-discovery"],
  },
  {
    id: "design-review",
    name: "Design Review",
    phase: "design",
    teammateTemplateId: "designer",
    skillId: "plan-design-review",
    dependsOn: ["product-review"],
  },
  {
    id: "engineering-review",
    name: "Engineering Review",
    phase: "plan",
    teammateTemplateId: "architect",
    skillId: "plan-eng-review",
    dependsOn: ["product-review"],
  },
  {
    id: "implementation",
    name: "Implementation",
    phase: "implement",
    teammateTemplateId: "engineer",
    skillId: "implement",
    dependsOn: ["design-review", "engineering-review"],
    approvalGate: standardApproval,
  },
  {
    id: "code-review",
    name: "Code Review",
    phase: "review",
    teammateTemplateId: "architect",
    skillId: "review",
    dependsOn: ["implementation"],
  },
  {
    id: "qa",
    name: "QA",
    phase: "test",
    teammateTemplateId: "qa",
    skillId: "qa",
    dependsOn: ["implementation"],
    approvalGate: standardApproval,
  },
  {
    id: "ship",
    name: "Ship",
    phase: "ship",
    teammateTemplateId: "release",
    skillId: "ship",
    dependsOn: ["code-review", "qa"],
    approvalGate: strictReleaseApproval,
  },
];

const gstackDefaultWorkflows: readonly WorkflowTemplate[] = [
  {
    id: "autoplan-lite",
    name: "Autoplan Lite",
    summary: "A Ling-native, gstack-inspired product -> design -> engineering -> implementation -> review/QA -> ship workflow.",
    steps: autoplanLiteSteps,
  },
];

export const gstackDefaultSkillPack: SkillPack = {
  id: GSTACK_DEFAULT_SKILL_PACK_ID,
  source: "gstack",
  name: "gstack default",
  version: "0.1.0",
  description:
    "Ling-native templates inspired by gstack's multi-role engineering workflow. This pack does not vendor gstack runtime SKILL.md files.",
  skills: gstackDefaultSkills,
  teammateTemplates: gstackDefaultTeammates,
  workflowTemplates: gstackDefaultWorkflows,
};

const builtinSkillPacks: readonly SkillPack[] = [gstackDefaultSkillPack];

export function listBuiltinSkillPacks(): readonly SkillPack[] {
  return [...builtinSkillPacks];
}

export function getBuiltinSkillPack(id: string): SkillPack | undefined {
  return builtinSkillPacks.find((pack) => pack.id === id);
}

export function listDefaultTeammateTemplates(packId: string): readonly AiTeammateTemplate[] {
  return getBuiltinSkillPack(packId)?.teammateTemplates ?? [];
}

export function listDefaultSkills(packId: string): readonly SkillDefinition[] {
  return getBuiltinSkillPack(packId)?.skills ?? [];
}
