import type {
  SkillPackExtensionMetadata,
  ToolDefaultApproval,
  ToolExtensionMetadata,
  ToolSideEffectLevel,
} from "@ling-stack/plugin-sdk";
import {
  defaultApprovalToolDecisions,
  readOnlyRunTools,
  riskyRunTools,
  type ApprovalToolDecision,
  type RunTool,
} from "./approval-policy.js";
import { listBuiltinSkillPacks } from "./builtin-skill-packs.js";

export const BUILTIN_EXTENSION_VERSION = "0.1.0";

export function listBuiltinToolExtensions(): readonly ToolExtensionMetadata[] {
  return allRunTools().map((tool) => createToolExtension(tool));
}

export function getBuiltinToolExtension(id: string): ToolExtensionMetadata | undefined {
  return listBuiltinToolExtensions().find((extension) => extension.manifest.id === id);
}

export function listBuiltinSkillPackExtensions(): readonly SkillPackExtensionMetadata[] {
  return listBuiltinSkillPacks().map((pack) => ({
    manifest: {
      id: `skill-pack:${pack.id}`,
      name: pack.name,
      version: pack.version,
      kind: "skill-pack",
      trustLevel: "internal",
      capabilities: [
        `skill-pack:${pack.id}`,
        ...pack.skills.map((skill) => `skill:${skill.id}`),
        ...pack.teammateTemplates.map((template) => `teammate-template:${template.id}`),
        ...pack.workflowTemplates.map((workflow) => `workflow-template:${workflow.id}`),
      ],
    },
    skillPackId: pack.id,
    source: pack.source,
    skillIds: pack.skills.map((skill) => skill.id),
    teammateTemplateIds: pack.teammateTemplates.map((template) => template.id),
    workflowTemplateIds: pack.workflowTemplates.map((workflow) => workflow.id),
  }));
}

export function getBuiltinSkillPackExtension(id: string): SkillPackExtensionMetadata | undefined {
  return listBuiltinSkillPackExtensions().find((extension) => extension.manifest.id === id);
}

function createToolExtension(tool: RunTool): ToolExtensionMetadata {
  const defaultApproval = defaultApprovalToolDecisions[tool];
  return {
    manifest: {
      id: `tool:${tool}`,
      name: toolDisplayName(tool),
      version: BUILTIN_EXTENSION_VERSION,
      kind: "tool",
      trustLevel: "internal",
      capabilities: [`tool:${tool}`, `side-effect:${toolSideEffectLevel(tool)}`],
      requiredApprovals:
        defaultApproval === "allow"
          ? undefined
          : [
              {
                decision: defaultApproval === "deny" ? "deny" : "ask",
                risk: tool === "bash" ? "high" : "medium",
                tools: [tool],
                reason: `${toolDisplayName(tool)} can modify local state and must pass approval policy.`,
              },
            ],
    },
    toolName: tool,
    sideEffectLevel: toolSideEffectLevel(tool),
    defaultApproval: toToolDefaultApproval(defaultApproval),
  };
}

function allRunTools(): RunTool[] {
  return [...readOnlyRunTools, ...riskyRunTools];
}

function toolSideEffectLevel(tool: RunTool): ToolSideEffectLevel {
  if ((readOnlyRunTools as readonly string[]).includes(tool)) {
    return "read";
  }
  if (tool === "bash") {
    return "write-network";
  }
  return "write";
}

function toToolDefaultApproval(decision: ApprovalToolDecision): ToolDefaultApproval {
  return decision;
}

function toolDisplayName(tool: RunTool): string {
  switch (tool) {
    case "read":
      return "Read";
    case "grep":
      return "Grep";
    case "find":
      return "Find";
    case "ls":
      return "List";
    case "bash":
      return "Bash";
    case "edit":
      return "Edit";
    case "write":
      return "Write";
  }
}
