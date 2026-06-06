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
const docsTools = ["read", "grep", "find", "ls", "edit", "write"] as const satisfies readonly RunTool[];
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
    id: "plan-devex-review",
    name: "Developer Experience Plan Review",
    summary: "Review developer-facing flows, onboarding friction, API ergonomics, and docs strategy before build.",
    roleAffinity: ["product", "architect", "docs"],
    workflowPhase: "plan",
    promptFragments: [
      "Evaluate the target developer persona, time-to-hello-world, setup path, and error recovery before implementation.",
      "Convert DX ambition into concrete acceptance criteria, docs requirements, and instrumentation points.",
    ],
    stateEffects: ["updates_plan"],
  }),
  skill({
    id: "autoplan",
    name: "Autoplan",
    summary: "Run product, design, engineering, and developer-experience reviews into one execution plan.",
    roleAffinity: ["product", "architect", "designer", "docs"],
    workflowPhase: "plan",
    promptFragments: [
      "Compile the relevant strategy, design, engineering, and DX checks before implementation starts.",
      "Surface unresolved taste decisions and scope tradeoffs as explicit gates instead of silently deciding.",
    ],
    stateEffects: ["creates_plan", "updates_plan", "creates_artifact"],
  }),
  skill({
    id: "spec",
    name: "Spec",
    summary: "Turn vague intent into a precise, executable spec with scope, constraints, and validation.",
    roleAffinity: ["product", "architect", "engineer"],
    workflowPhase: "plan",
    promptFragments: [
      "Read the relevant code and docs before drafting the spec.",
      "Produce an implementation-ready scope with non-goals, acceptance criteria, and failure modes.",
    ],
    stateEffects: ["creates_plan", "creates_task", "creates_artifact"],
  }),
  skill({
    id: "design-consultation",
    name: "Design Consultation",
    summary: "Create or refresh the product design system, visual language, and DESIGN.md direction.",
    roleAffinity: ["designer", "product"],
    workflowPhase: "design",
    promptFragments: [
      "Understand the product surface and audience before recommending visual language.",
      "Record durable design-system decisions in docs rather than leaving them as chat-only taste.",
    ],
    stateEffects: ["updates_plan", "creates_artifact"],
  }),
  skill({
    id: "design-shotgun",
    name: "Design Shotgun",
    summary: "Explore multiple design directions and capture structured tradeoffs before committing to one.",
    roleAffinity: ["designer", "product"],
    workflowPhase: "design",
    promptFragments: [
      "Generate several materially different design directions, not tiny color variants.",
      "Compare options through user workflow fit, visual hierarchy, and implementation cost.",
    ],
    stateEffects: ["creates_artifact"],
  }),
  skill({
    id: "design-html",
    name: "Design HTML",
    summary: "Turn an approved design direction into production-quality frontend code under approval policy.",
    roleAffinity: ["designer", "engineer"],
    workflowPhase: "implement",
    promptFragments: [
      "Implement the approved visual direction with responsive layout, real states, and accessible controls.",
      "Keep design implementation scoped to the selected surface and verify rendered behavior.",
    ],
    requiredTools: codingTools,
    requiredProviderCapabilities: toolCallingCapabilities,
    approvalProfile: standardApproval,
    stateEffects: ["starts_run", "requests_approval", "creates_artifact"],
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
    requiredTools: testTools,
    requiredProviderCapabilities: toolCallingCapabilities,
    approvalProfile: standardApproval,
    stateEffects: ["starts_run", "creates_artifact"],
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
    id: "health",
    name: "Health",
    summary: "Run the project's existing quality checks and summarize codebase health with trends and blockers.",
    roleAffinity: ["engineer", "qa", "architect"],
    workflowPhase: "review",
    promptFragments: [
      "Prefer the repository's existing typecheck, lint, test, and build commands over invented checks.",
      "Report health as actionable blockers, regressions, and missing validation, not a vanity score.",
    ],
    requiredTools: testTools,
    requiredProviderCapabilities: toolCallingCapabilities,
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
    id: "design-review",
    name: "Design Review",
    summary: "Audit the live UI for visual quality, interaction issues, and design regressions.",
    roleAffinity: ["designer", "qa", "engineer"],
    workflowPhase: "review",
    promptFragments: [
      "Review the rendered surface, not just component code.",
      "Call out visual hierarchy, spacing, responsive states, and interaction problems with reproducible evidence.",
    ],
    requiredTools: testTools,
    requiredProviderCapabilities: toolCallingCapabilities,
    approvalProfile: standardApproval,
    stateEffects: ["starts_run", "creates_artifact"],
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
    id: "qa-only",
    name: "QA Only",
    summary: "Test the product surface and return a structured bug report without making code changes.",
    roleAffinity: ["qa", "designer"],
    workflowPhase: "test",
    promptFragments: [
      "Exercise the real user flow and stop at a clear report; do not mutate source files.",
      "Include repro steps, expected behavior, actual behavior, and severity for every finding.",
    ],
    requiredTools: testTools,
    requiredProviderCapabilities: toolCallingCapabilities,
    approvalProfile: standardApproval,
    stateEffects: ["starts_run", "creates_artifact"],
  }),
  skill({
    id: "devex-review",
    name: "Developer Experience Review",
    summary: "Test onboarding, docs, CLI/API affordances, and error recovery from a developer's perspective.",
    roleAffinity: ["docs", "qa", "engineer"],
    workflowPhase: "test",
    promptFragments: [
      "Run the getting-started path like a new developer and measure friction from first contact to useful output.",
      "Compare observed DX against the plan, then report broken docs, setup traps, and unclear errors.",
    ],
    requiredTools: testTools,
    requiredProviderCapabilities: toolCallingCapabilities,
    approvalProfile: standardApproval,
    stateEffects: ["starts_run", "creates_artifact"],
  }),
  skill({
    id: "benchmark",
    name: "Benchmark",
    summary: "Measure performance-sensitive surfaces and compare results against an agreed baseline.",
    roleAffinity: ["qa", "engineer", "release"],
    workflowPhase: "test",
    promptFragments: [
      "Define the target pages, flows, or commands before measuring.",
      "Separate noisy timing evidence from real regressions and record the baseline used for comparison.",
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
    id: "landing-report",
    name: "Landing Report",
    summary: "Inspect release queue state, open work, and version-slot risk without mutating the workspace.",
    roleAffinity: ["release", "architect"],
    workflowPhase: "ship",
    promptFragments: [
      "Summarize what is already in flight before selecting a release path.",
      "Do not claim version slots, push commits, or merge work from a read-only landing report.",
    ],
    stateEffects: ["creates_artifact"],
  }),
  skill({
    id: "setup-deploy",
    name: "Setup Deploy",
    summary: "Document deployment configuration, production URLs, health checks, and release commands.",
    roleAffinity: ["release", "docs"],
    workflowPhase: "ship",
    promptFragments: [
      "Discover deploy configuration from repository files and documented platform settings.",
      "Treat deploy configuration changes as release-sensitive and keep production mutation behind explicit approval.",
    ],
    requiredTools: docsTools,
    approvalProfile: strictReleaseApproval,
    stateEffects: ["updates_docs", "requests_approval", "creates_artifact"],
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
    id: "land-and-deploy",
    name: "Land and Deploy",
    summary: "Coordinate merge, deploy handoff, CI verification, and post-merge production checks.",
    roleAffinity: ["release"],
    workflowPhase: "ship",
    promptFragments: [
      "Land only reviewed and approved work, then verify CI and production health before closing the loop.",
      "Treat git push, merge, deploy, and external notification as explicit approval-gated actions.",
    ],
    requiredTools: codingTools,
    requiredProviderCapabilities: toolCallingCapabilities,
    approvalProfile: strictReleaseApproval,
    stateEffects: ["prepares_release", "requests_approval", "creates_artifact"],
  }),
  skill({
    id: "canary",
    name: "Canary",
    summary: "Monitor a shipped surface for console errors, health failures, and performance regressions.",
    roleAffinity: ["release", "qa"],
    workflowPhase: "operate",
    promptFragments: [
      "Watch the deployed surface after release and compare against the expected healthy baseline.",
      "Escalate production anomalies with evidence, timestamps, and the rollback or mitigation decision needed.",
    ],
    requiredTools: testTools,
    requiredProviderCapabilities: toolCallingCapabilities,
    approvalProfile: standardApproval,
    stateEffects: ["starts_run", "creates_artifact"],
  }),
  skill({
    id: "document-generate",
    name: "Document Generate",
    summary: "Create missing documentation for a feature, module, or workflow from implementation evidence.",
    roleAffinity: ["docs", "engineer"],
    workflowPhase: "document",
    promptFragments: [
      "Read the code and existing docs before writing new documentation.",
      "Choose the right documentation shape: tutorial, how-to, reference, or explanation.",
    ],
    requiredTools: docsTools,
    approvalProfile: standardApproval,
    stateEffects: ["updates_docs", "requests_approval", "creates_artifact"],
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
    requiredTools: docsTools,
    requiredProviderCapabilities: chatReasoningCapabilities,
    approvalProfile: standardApproval,
    stateEffects: ["updates_docs", "creates_artifact"],
  }),
  skill({
    id: "retro",
    name: "Retro",
    summary: "Review recent engineering work, shipped outcomes, quality signals, and follow-up risks.",
    roleAffinity: ["docs", "release", "architect"],
    workflowPhase: "review",
    promptFragments: [
      "Summarize what changed, what validation caught, and which risks remain for the next slice.",
      "Separate team/process learnings from product or architecture decisions that should become durable docs.",
    ],
    stateEffects: ["creates_artifact"],
  }),
  skill({
    id: "learn",
    name: "Learn",
    summary: "Inspect and curate durable project learnings so future work can reuse prior decisions.",
    roleAffinity: ["docs", "product", "engineer"],
    workflowPhase: "operate",
    promptFragments: [
      "Look for previous decisions, pitfalls, and reusable project patterns before proposing new work.",
      "Treat learnings as evidence-backed context, not permission to silently change behavior.",
    ],
    stateEffects: ["creates_artifact"],
  }),
];

const gstackDefaultTeammates: readonly AiTeammateTemplate[] = [
  {
    id: "product-strategist",
    name: "Product Strategist",
    roleKey: "product",
    summary: "Frames the problem, scope, and product tradeoffs before build work.",
    defaultSkillIds: ["office-hours", "plan-ceo-review", "autoplan", "spec"],
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
    defaultSkillIds: ["plan-eng-review", "review", "spec", "autoplan"],
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
    defaultSkillIds: ["implement", "investigate", "review", "health", "design-html"],
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
    defaultSkillIds: ["plan-design-review", "design-consultation", "design-shotgun"],
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
    defaultSkillIds: ["qa", "qa-only", "investigate", "design-review", "devex-review", "benchmark"],
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
    defaultSkillIds: ["ship", "landing-report", "setup-deploy", "land-and-deploy", "canary", "document-release"],
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
    defaultSkillIds: ["document-generate", "document-release", "plan-devex-review", "retro", "learn"],
    allowedTools: docsTools,
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
  version: "0.2.0",
  description:
    "Ling-native templates inspired by gstack's multi-role engineering workflow and current generic skill taxonomy. This pack does not vendor gstack runtime SKILL.md files.",
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
