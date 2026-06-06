import { readOnlyRunTools } from "./approval-policy.js";
import type {
  AutomationDraftField,
  AutomationExecutionPolicy,
  AutomationKind,
  AutomationOutputPolicy,
  AutomationPromptTemplate,
  AutomationTrigger,
} from "./automation-types.js";

export type BuiltinAutomationTemplateId =
  | "daily_brief"
  | "weekly_review"
  | "ci_failure_summary"
  | "release_note_draft"
  | "bug_scan"
  | "pr_risk_summary"
  | "ownership_suggestion"
  | "dependency_check";

export type BuiltinAutomationTemplateKind = Extract<AutomationKind, "daily_brief" | "weekly_review">;

export interface AutomationTemplateRequirement {
  readonly field: AutomationDraftField;
  readonly label: string;
  readonly required: boolean;
}

export interface BuiltinAutomationTemplate {
  readonly id: BuiltinAutomationTemplateId;
  readonly kind: AutomationKind;
  readonly title: string;
  readonly description: string;
  readonly category: "briefing" | "engineering" | "release" | "ownership";
  readonly tags: readonly string[];
  readonly requirements: readonly AutomationTemplateRequirement[];
  readonly defaultTrigger: AutomationTrigger;
  readonly defaultPromptTemplate: AutomationPromptTemplate;
  readonly defaultExecutionPolicy: AutomationExecutionPolicy;
  readonly defaultOutputPolicy: AutomationOutputPolicy;
}

const readOnlyExecutionPolicy: AutomationExecutionPolicy = {
  allowedTools: [...readOnlyRunTools],
  approvalProfile: { mode: "none" },
};

const markdownThreadOutputPolicy: AutomationOutputPolicy = {
  destinations: [{ type: "automation_thread" }, { type: "markdown_artifact" }],
  artifactFormat: "markdown",
};

const channelRequirements: readonly AutomationTemplateRequirement[] = [
  { field: "target", label: "Target channel or workspace", required: true },
  { field: "promptTemplate", label: "Evidence-bound prompt", required: true },
  { field: "outputPolicy", label: "Automation thread and markdown artifact", required: true },
];

export const builtinAutomationTemplates: readonly BuiltinAutomationTemplate[] = [
  {
    id: "daily_brief",
    kind: "daily_brief",
    title: "Daily Brief",
    description: "Summarize the latest channel context, recent runs, approvals, and external work.",
    category: "briefing",
    tags: ["daily", "summary", "workspace"],
    requirements: channelRequirements,
    defaultTrigger: { type: "manual" },
    defaultPromptTemplate: {
      templateVersion: 1,
      systemPurpose:
        "Produce a concise daily project brief from supplied Ling context only. Do not mutate files, GitHub, providers, memory, tasks, or secrets.",
      promptMarkdown: [
        "Write today's brief for this Ling workspace target.",
        "",
        "Use only the supplied context. If evidence is missing, say so explicitly.",
        "Include: key changes, open approvals, recent run outcomes, risks, and recommended follow-ups as plain text.",
      ].join("\n"),
      contextSelectors: [
        { kind: "channel_brief" },
        { kind: "recent_runs", limit: 8 },
        { kind: "pending_approvals", limit: 8 },
        { kind: "external_work", limit: 8 },
        { kind: "recent_artifacts", limit: 8 },
      ],
      maxContextItems: 32,
    },
    defaultExecutionPolicy: readOnlyExecutionPolicy,
    defaultOutputPolicy: markdownThreadOutputPolicy,
  },
  {
    id: "weekly_review",
    kind: "weekly_review",
    title: "Weekly Review",
    description: "Review the week across decisions, runs, approvals, and external work.",
    category: "briefing",
    tags: ["weekly", "review", "decisions"],
    requirements: channelRequirements,
    defaultTrigger: { type: "manual" },
    defaultPromptTemplate: {
      templateVersion: 1,
      systemPurpose:
        "Produce a weekly review from supplied Ling context only. Do not mutate files, GitHub, providers, memory, tasks, or secrets.",
      promptMarkdown: [
        "Write this week's project review for this Ling workspace target.",
        "",
        "Use only the supplied context. Include shipped work, unresolved blockers, decisions, risky areas, and next-week follow-ups.",
      ].join("\n"),
      contextSelectors: [
        { kind: "channel_brief" },
        { kind: "state_transitions", limit: 16 },
        { kind: "recent_runs", limit: 16 },
        { kind: "pending_approvals", limit: 12 },
        { kind: "external_work", limit: 16 },
        { kind: "recent_artifacts", limit: 12 },
      ],
      maxContextItems: 64,
    },
    defaultExecutionPolicy: readOnlyExecutionPolicy,
    defaultOutputPolicy: markdownThreadOutputPolicy,
  },
  {
    id: "ci_failure_summary",
    kind: "custom_prompt",
    title: "CI Failure Summary",
    description: "Summarize failed CI windows and suggest likely repair paths with evidence.",
    category: "engineering",
    tags: ["ci", "failure", "triage"],
    requirements: channelRequirements,
    defaultTrigger: { type: "manual" },
    defaultPromptTemplate: {
      templateVersion: 1,
      systemPurpose:
        "Triage CI failures from supplied Ling and external work context only. Do not push, merge, retry jobs, or mutate external systems.",
      promptMarkdown: [
        "Summarize current CI failure risk for this target.",
        "",
        "Use only supplied evidence. Group failures by likely root cause, name missing evidence, and propose the smallest next verification step.",
      ].join("\n"),
      contextSelectors: [
        { kind: "channel_brief" },
        { kind: "external_work", limit: 12 },
        { kind: "recent_runs", limit: 12 },
        { kind: "recent_artifacts", limit: 12 },
        { kind: "pending_approvals", limit: 8 },
      ],
      maxContextItems: 48,
    },
    defaultExecutionPolicy: readOnlyExecutionPolicy,
    defaultOutputPolicy: markdownThreadOutputPolicy,
  },
  {
    id: "release_note_draft",
    kind: "custom_prompt",
    title: "Release Note Draft",
    description: "Draft release notes from merged work, decisions, and known changes.",
    category: "release",
    tags: ["release", "notes", "changelog"],
    requirements: channelRequirements,
    defaultTrigger: { type: "manual" },
    defaultPromptTemplate: {
      templateVersion: 1,
      systemPurpose:
        "Draft release notes from supplied Ling evidence only. Do not invent shipped items or publish externally.",
      promptMarkdown: [
        "Draft release notes for this workspace target.",
        "",
        "Separate user-visible changes, fixes, operational notes, and unresolved risks. Mark every uncertain item as needing verification.",
      ].join("\n"),
      contextSelectors: [
        { kind: "state_transitions", limit: 24 },
        { kind: "external_work", limit: 24 },
        { kind: "recent_runs", limit: 16 },
        { kind: "recent_artifacts", limit: 16 },
      ],
      maxContextItems: 80,
    },
    defaultExecutionPolicy: readOnlyExecutionPolicy,
    defaultOutputPolicy: markdownThreadOutputPolicy,
  },
  {
    id: "bug_scan",
    kind: "custom_prompt",
    title: "Bug Scan",
    description: "Inspect recent runs and artifacts for likely regressions with evidence.",
    category: "engineering",
    tags: ["bugs", "regression", "risk"],
    requirements: channelRequirements,
    defaultTrigger: { type: "manual" },
    defaultPromptTemplate: {
      templateVersion: 1,
      systemPurpose:
        "Scan supplied Ling context for plausible regressions. Do not modify files or run external actions.",
      promptMarkdown: [
        "Identify likely regressions or fragile areas in this target.",
        "",
        "Prioritize concrete evidence: failing runs, recent artifacts, unresolved approvals, state transitions, and external work signals.",
      ].join("\n"),
      contextSelectors: [
        { kind: "recent_runs", limit: 20 },
        { kind: "recent_artifacts", limit: 20 },
        { kind: "pending_approvals", limit: 12 },
        { kind: "state_transitions", limit: 20 },
      ],
      maxContextItems: 72,
    },
    defaultExecutionPolicy: readOnlyExecutionPolicy,
    defaultOutputPolicy: markdownThreadOutputPolicy,
  },
  {
    id: "pr_risk_summary",
    kind: "custom_prompt",
    title: "PR Risk Summary",
    description: "Summarize current PR risk, missing evidence, and review focus.",
    category: "engineering",
    tags: ["pr", "review", "risk"],
    requirements: channelRequirements,
    defaultTrigger: { type: "manual" },
    defaultPromptTemplate: {
      templateVersion: 1,
      systemPurpose:
        "Summarize pull request risk from supplied Ling and external work context only. Do not comment, approve, or merge.",
      promptMarkdown: [
        "Write a PR risk summary for this target.",
        "",
        "List high-risk files or behaviors, missing tests, stale evidence, and the next review questions. Keep claims tied to supplied context.",
      ].join("\n"),
      contextSelectors: [
        { kind: "external_work", limit: 20 },
        { kind: "recent_runs", limit: 16 },
        { kind: "recent_artifacts", limit: 16 },
        { kind: "pending_approvals", limit: 8 },
      ],
      maxContextItems: 64,
    },
    defaultExecutionPolicy: readOnlyExecutionPolicy,
    defaultOutputPolicy: markdownThreadOutputPolicy,
  },
  {
    id: "ownership_suggestion",
    kind: "custom_prompt",
    title: "Ownership Suggestion",
    description: "Suggest responsible owners based on context, decisions, and recent work.",
    category: "ownership",
    tags: ["owners", "handoff", "responsibility"],
    requirements: channelRequirements,
    defaultTrigger: { type: "manual" },
    defaultPromptTemplate: {
      templateVersion: 1,
      systemPurpose:
        "Suggest ownership from supplied Ling evidence only. Do not assign users or mutate tasks.",
      promptMarkdown: [
        "Suggest ownership for open work in this target.",
        "",
        "Base suggestions on channel brief, decisions, external work, and recent runs. Mark low-confidence suggestions clearly.",
      ].join("\n"),
      contextSelectors: [
        { kind: "channel_brief" },
        { kind: "external_work", limit: 20 },
        { kind: "state_transitions", limit: 20 },
        { kind: "recent_runs", limit: 12 },
      ],
      maxContextItems: 64,
    },
    defaultExecutionPolicy: readOnlyExecutionPolicy,
    defaultOutputPolicy: markdownThreadOutputPolicy,
  },
  {
    id: "dependency_check",
    kind: "custom_prompt",
    title: "Dependency Check",
    description: "Review recent dependency or tool changes for operational risk.",
    category: "engineering",
    tags: ["dependencies", "tools", "risk"],
    requirements: channelRequirements,
    defaultTrigger: { type: "manual" },
    defaultPromptTemplate: {
      templateVersion: 1,
      systemPurpose:
        "Review dependency and tool risk from supplied Ling evidence only. Do not install, upgrade, or change configuration.",
      promptMarkdown: [
        "Review dependency and tool risk for this target.",
        "",
        "Call out changed dependencies, missing lockfile evidence, failed install/build runs, and concrete follow-up checks.",
      ].join("\n"),
      contextSelectors: [
        { kind: "recent_runs", limit: 16 },
        { kind: "recent_artifacts", limit: 20 },
        { kind: "external_work", limit: 16 },
        { kind: "pending_approvals", limit: 8 },
      ],
      maxContextItems: 64,
    },
    defaultExecutionPolicy: readOnlyExecutionPolicy,
    defaultOutputPolicy: markdownThreadOutputPolicy,
  },
];

export function getBuiltinAutomationTemplate(templateId: BuiltinAutomationTemplateId | BuiltinAutomationTemplateKind): BuiltinAutomationTemplate {
  const template = builtinAutomationTemplates.find((item) => item.id === templateId || item.kind === templateId);
  if (!template) {
    throw new Error(`Builtin automation template not found: ${templateId}`);
  }
  return template;
}
