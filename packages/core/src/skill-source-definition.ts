import { parseDocument } from "yaml";
import { readOnlyRunTools, type RunTool } from "./approval-policy.js";
import type {
  AiTeammateRoleKey, SkillAgentMetadata, SkillDefinition, SkillRegistryEntry,
  SkillSourceFrontMatter, SkillSourceKind, SkillSourceWarning,
} from "./skill-types.js";

interface SkillSourceDefinitionInput {
  readonly markdown: string;
  readonly skillDirectoryName: string;
  readonly frontMatter: SkillSourceFrontMatter;
  readonly agentMetadata?: SkillAgentMetadata;
  readonly warnings: readonly SkillSourceWarning[];
}

export function parseSkillFrontMatter(markdown: string): {
  readonly frontMatter: SkillSourceFrontMatter;
  readonly warnings: readonly SkillSourceWarning[];
} {
  const text = splitMarkdownFrontMatter(markdown).frontMatter;
  const invalid = (message: string) => ({
    frontMatter: {},
    warnings: [{ code: "missing_metadata" as const, severity: "warning" as const, message, location: "SKILL.md" }],
  });
  if (!text.trim()) return invalid("SKILL.md has no YAML front matter.");
  const document = parseDocument(text);
  if (document.errors.length) return invalid(`SKILL.md front matter parse error: ${document.errors[0].message}`);
  let raw: unknown;
  try { raw = document.toJS({ maxAliasCount: 100 }); }
  catch { return invalid("SKILL.md front matter exceeds YAML alias limits."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid("SKILL.md front matter must be an object.");
  const value = raw as Record<string, unknown>;
  const optionalString = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
  const frontMatter = { name: optionalString(value.name), description: optionalString(value.description) };
  const warnings: SkillSourceWarning[] = [];
  if (!frontMatter.name) warnings.push({
    code: "missing_metadata", severity: "warning", message: "SKILL.md front matter is missing name.", location: "SKILL.md:name",
  });
  if (!frontMatter.description) warnings.push({
    code: "missing_metadata", severity: "info", message: "SKILL.md front matter is missing description.", location: "SKILL.md:description",
  });
  return { frontMatter, warnings };
}

export function splitMarkdownFrontMatter(markdown: string): { readonly frontMatter: string; readonly body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontMatter: "", body: normalized };
  const end = /\n---(?:\n|$)/g;
  end.lastIndex = 3;
  const match = end.exec(normalized);
  if (!match) return { frontMatter: "", body: normalized };
  return { frontMatter: normalized.slice(4, match.index), body: normalized.slice(end.lastIndex) };
}

export function previewSkillSourceDefinition(
  skillId: string,
  source: SkillSourceDefinitionInput & { readonly root: { readonly sourceKind: SkillSourceKind } },
  existing?: SkillRegistryEntry,
): SkillDefinition {
  if (!existing) return normalizeDefinitionFromSource(skillId, source);
  if (source.root.sourceKind !== "gstack-skill-directory" || !isSourceManagedSkill(existing)) return existing.definition;
  return refreshSourceManagedSkillDefinition(existing.definition, source.frontMatter, source.agentMetadata);
}

export function isSourceManagedSkill(entry: SkillRegistryEntry): boolean {
  return (entry.source === "builtin" || entry.source === "gstack") && !isLingNativeSkillId(entry.id);
}

export function isLingNativeSkillId(id: string): boolean {
  return id === "implement" || id === "checkpoint";
}

export function refreshSourceManagedSkillDefinition(
  definition: SkillDefinition, frontMatter: SkillSourceFrontMatter, agentMetadata?: SkillAgentMetadata,
): SkillDefinition {
  const description = frontMatter.description ?? agentMetadata?.shortDescription;
  // Source text updates routing content, never the host-reviewed capability or approval policy.
  return {
    ...definition,
    name: frontMatter.name ?? agentMetadata?.displayName ?? definition.name,
    summary: description ? firstLine(description) : definition.summary,
    promptFragments: description ? [description] : definition.promptFragments,
  };
}

function normalizeDefinitionFromSource(skillId: string, source: SkillSourceDefinitionInput): SkillDefinition {
  const summary = source.frontMatter.description ?? source.agentMetadata?.shortDescription ?? `Source-backed skill imported from ${source.skillDirectoryName}.`;
  return {
    id: skillId,
    name: source.frontMatter.name ?? source.agentMetadata?.displayName ?? skillId.split("-").filter(Boolean).map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(" "),
    summary: firstLine(summary), roleAffinity: inferRoleAffinity(skillId, summary), promptFragments: [summary],
    requiredTools: inferRequiredTools(source), requiredProviderCapabilities: ["chat", "reasoning"],
    approvalProfile: source.warnings.some((warning) => warning.code === "destructive_command" || warning.code === "external_send_claim")
      ? { mode: "strict", risk: "high", requiredForTools: ["bash", "edit", "write"], requiredForActions: ["external_send", "deploy"] }
      : source.warnings.some((warning) => warning.code === "host_specific_tool" || warning.code === "unsupported_tool")
        ? { mode: "standard", risk: "medium", requiredForTools: ["bash"] } : { mode: "none" },
    stateEffects: [],
  };
}

function inferRoleAffinity(skillId: string, summary: string): readonly AiTeammateRoleKey[] {
  const text = `${skillId} ${summary}`.toLowerCase();
  if (text.includes("security") || text.includes("cso")) return ["security"];
  if (["deploy", "ship", "release", "land"].some((word) => text.includes(word))) return ["release"];
  if (text.includes("doc")) return ["docs"];
  if (text.includes("design")) return ["designer"];
  if (text.includes("qa") || text.includes("test")) return ["qa"];
  if (["office", "discover", "plan", "spec"].some((word) => text.includes(word))) return ["product", "architect"];
  if (["implement", "build", "code", "debug", "investigate"].some((word) => text.includes(word))) return ["engineer"];
  return ["custom"];
}

function inferRequiredTools(source: SkillSourceDefinitionInput): readonly RunTool[] {
  const tools = new Set<RunTool>(readOnlyRunTools);
  if (source.warnings.some((warning) => warning.code === "host_specific_tool" || warning.code === "destructive_command")) tools.add("bash");
  if (source.markdown.includes("apply_patch") || /\b(edit|write)\b/i.test(source.markdown)) { tools.add("edit"); tools.add("write"); }
  return [...tools];
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}
