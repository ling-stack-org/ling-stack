import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import {
  providerCapabilities,
  readOnlyRunTools,
  type CreateSkillImportDraftInput,
  type RunTool,
  type SkillDefinition,
  type SkillImportWarning,
  type SkillPackSource,
  type SkillRegistryEntry,
} from "@ling-stack/core";
import { parseApprovalProfileObject } from "../../shared/approval-profile.js";
import { extractMarkdownTitle, firstMarkdownParagraph, parseMarkdownFrontmatter } from "../../shared/markdown.js";
import { isRecord, readOptionalString, readOptionalStringArray, readString } from "../../shared/validation.js";

export function parseSkillImportDraftRequest(
  value: unknown,
  existingSkills: readonly SkillRegistryEntry[],
): CreateSkillImportDraftInput {
  if (!isRecord(value)) {
    throw new Error("Skill import draft request must be a JSON object");
  }
  const content = readString(value, "content");
  const sourcePath = readOptionalString(value, "sourcePath");
  const source = readOptionalSkillPackSource(value, "source") ?? inferSkillImportSource(sourcePath, content);
  const requestedName = readOptionalString(value, "name");
  const knownSkillIds = new Set(existingSkills.map((skill) => skill.id));
  const parsed = parseSkillImportContent(content, sourcePath, requestedName);
  const seenDraftSkillIds = new Set<string>();
  const definitions = parsed.definitions.map((item) => {
    const warnings = [...(item.warnings ?? [])];
    if (knownSkillIds.has(item.definition.id) || seenDraftSkillIds.has(item.definition.id)) {
      warnings.push({
        code: "duplicate_skill_id",
        severity: "error",
        message: `Skill id already exists or appears more than once: ${item.definition.id}`,
      });
    }
    seenDraftSkillIds.add(item.definition.id);
    return { ...item, warnings };
  });
  const warnings: SkillImportWarning[] = [
    ...parsed.warnings,
    ...(definitions.length === 0 ? [{
      code: "missing_metadata" as const,
      severity: "error" as const,
      message: "No skill definitions could be parsed from the import source.",
    }] : []),
  ];
  return {
    source,
    sourcePath,
    packId: parsed.packId,
    name: requestedName ?? parsed.name,
    version: parsed.version,
    description: parsed.description,
    definitions,
    warnings,
  };
}

function parseSkillImportContent(
  content: string,
  sourcePath: string | undefined,
  requestedName: string | undefined,
): Pick<CreateSkillImportDraftInput, "packId" | "name" | "version" | "description" | "definitions"> & { readonly warnings: SkillImportWarning[] } {
  const trimmed = content.trim();
  if (!trimmed) {
    return {
      name: requestedName ?? "Imported skills",
      description: "",
      definitions: [],
      warnings: [{ code: "missing_metadata", severity: "error", message: "Import content is empty." }],
    };
  }
  if (trimmed.startsWith("{")) {
    return parseJsonSkillImport(trimmed, requestedName);
  }
  return parseMarkdownSkillImport(trimmed, sourcePath, requestedName);
}

function parseJsonSkillImport(content: string, requestedName: string | undefined): ReturnType<typeof parseSkillImportContent> {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Skill import JSON must be an object");
  }
  const rawSkills = Array.isArray(parsed.skills) ? parsed.skills : [parsed];
  const definitions = rawSkills
    .filter(isRecord)
    .map((raw, index) => normalizeJsonSkillDefinition(raw, `skills[${index}]`));
  const name = requestedName ?? readOptionalString(parsed, "name") ?? "Imported skill pack";
  return {
    packId: readOptionalString(parsed, "id"),
    name,
    version: readOptionalString(parsed, "version"),
    description: readOptionalString(parsed, "description") ?? `Draft imported from ${name}.`,
    definitions,
    warnings: skillPermissionWarnings(content),
  };
}

function normalizeJsonSkillDefinition(
  raw: Record<string, unknown>,
  location: string,
): { readonly definition: SkillDefinition; readonly warnings: readonly SkillImportWarning[] } {
  const warnings: SkillImportWarning[] = [];
  const id = readOptionalString(raw, "id") ?? slugSkillId(readOptionalString(raw, "name") ?? "custom-skill");
  const name = readOptionalString(raw, "name") ?? id;
  if (!raw.name || !raw.summary) {
    warnings.push({
      code: "missing_metadata",
      severity: "warning",
      message: "Skill definition is missing name or summary metadata.",
      location,
    });
  }
  const requiredTools = readStringArrayWithWarnings(raw, "requiredTools", supportedRunToolNames(), "unknown_tool", warnings, location) ?? [...readOnlyRunTools];
  const requiredProviderCapabilities = readStringArrayWithWarnings(
    raw,
    "requiredProviderCapabilities",
    [...providerCapabilities],
    "unknown_provider_capability",
    warnings,
    location,
  ) ?? ["chat", "reasoning"];
  return {
    definition: {
      id,
      name,
      summary: readOptionalString(raw, "summary") ?? `Custom skill ${name}.`,
      roleAffinity: readStringArrayWithWarnings(raw, "roleAffinity", supportedRoleKeys(), "unsupported_section", warnings, location) ?? ["custom"],
      workflowPhase: readSkillWorkflowPhase(raw, "workflowPhase", warnings, location),
      promptFragments: readOptionalStringArray(raw, "promptFragments") ?? [readOptionalString(raw, "prompt") ?? readOptionalString(raw, "description") ?? ""].filter(Boolean),
      requiredTools,
      requiredProviderCapabilities,
      approvalProfile: isRecord(raw.approvalProfile) ? parseApprovalProfileObject(raw.approvalProfile, `${location}.approvalProfile`) : { mode: "none" },
      stateEffects: readStringArrayWithWarnings(raw, "stateEffects", supportedSkillStateEffects(), "unsupported_section", warnings, location) ?? [],
    },
    warnings: [...warnings, ...skillPermissionWarnings(JSON.stringify(raw)).map((warning) => ({ ...warning, location }))],
  };
}

function parseMarkdownSkillImport(
  content: string,
  sourcePath: string | undefined,
  requestedName: string | undefined,
): ReturnType<typeof parseSkillImportContent> {
  const frontmatter = parseMarkdownFrontmatter(content);
  const title = extractMarkdownTitle(content) ?? frontmatter.name ?? requestedName ?? (sourcePath ? basename(sourcePath, extname(sourcePath)) : "Custom Skill");
  const name = requestedName ?? title;
  const summary = frontmatter.description ?? firstMarkdownParagraph(content) ?? `Draft imported from ${sourcePath ?? "markdown"}.`;
  const id = slugSkillId(frontmatter.id ?? frontmatter.name ?? title);
  const warnings: SkillImportWarning[] = [
    ...skillPermissionWarnings(content),
    ...(!frontmatter.name && !extractMarkdownTitle(content) ? [{
      code: "missing_metadata" as const,
      severity: "warning" as const,
      message: "Markdown did not include a title or name; generated a skill name from the source.",
    }] : []),
  ];
  return {
    name,
    description: summary,
    definitions: [{
      definition: {
        id,
        name,
        summary,
        roleAffinity: ["custom"],
        workflowPhase: "operate",
        promptFragments: [content.slice(0, 12_000)],
        requiredTools: [...readOnlyRunTools],
        requiredProviderCapabilities: ["chat", "reasoning"],
        approvalProfile: { mode: "none" },
        stateEffects: [],
      },
      warnings,
    }],
    warnings: [{
      code: "unsupported_section",
      severity: "info",
      message: "Markdown imports are treated as workflow prompt drafts; tool and approval claims are ignored.",
    }],
  };
}

function readOptionalSkillPackSource(record: Record<string, unknown>, key: string): SkillPackSource | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!["builtin", "gstack", "workspace", "skill-directory", "agents-md", "custom"].includes(value)) {
    throw new Error(`${key} must be a supported skill source`);
  }
  return value as SkillPackSource;
}

function inferSkillImportSource(sourcePath: string | undefined, content: string): SkillPackSource {
  const name = sourcePath ? basename(sourcePath).toLowerCase() : "";
  if (name === "agents.md" || name === "agent.md") {
    return "agents-md";
  }
  if (name === "skill.md" || content.includes("---\nname:")) {
    return "skill-directory";
  }
  return "custom";
}

function readStringArrayWithWarnings<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  warningCode: SkillImportWarning["code"],
  warnings: SkillImportWarning[],
  location: string,
): T[] | undefined {
  const values = readOptionalStringArray(record, key);
  if (!values) {
    return undefined;
  }
  const allowedSet = new Set<string>(allowed);
  const accepted: T[] = [];
  for (const value of values) {
    if (allowedSet.has(value)) {
      accepted.push(value as T);
    } else {
      warnings.push({
        code: warningCode,
        severity: "error",
        message: `${key} contains unsupported value: ${value}`,
        location,
      });
    }
  }
  return accepted;
}

function readSkillWorkflowPhase(
  record: Record<string, unknown>,
  key: string,
  warnings: SkillImportWarning[],
  location: string,
): SkillDefinition["workflowPhase"] {
  const value = readOptionalString(record, key);
  if (!value) {
    return "operate";
  }
  const allowed = supportedWorkflowPhases();
  if (!allowed.includes(value as SkillDefinition["workflowPhase"])) {
    warnings.push({
      code: "unsupported_section",
      severity: "error",
      message: `${key} contains unsupported workflow phase: ${value}`,
      location,
    });
    return "operate";
  }
  return value as SkillDefinition["workflowPhase"];
}

function skillPermissionWarnings(content: string): SkillImportWarning[] {
  const lower = content.toLowerCase();
  const warnings: SkillImportWarning[] = [];
  if (/\b(grant|enable|allow|bypass).*\b(tool|tools|bash|write|edit|approval|permission|permissions)\b/.test(lower)) {
    warnings.push({
      code: "permission_like_instruction",
      severity: "warning",
      message: "Import mentions granting tools, permissions, or approvals; those claims are ignored.",
    });
  }
  if (/\b(secret|secrets|token|api key|credential|credentials)\b/.test(lower)) {
    warnings.push({
      code: "secret_reference",
      severity: "warning",
      message: "Import mentions secrets or credentials; secret access must be configured separately.",
    });
  }
  if (/\b(external-send|send externally|slack|github comment|deploy|push)\b/.test(lower)) {
    warnings.push({
      code: "external_send_claim",
      severity: "warning",
      message: "Import mentions external sends, deploys, or pushes; side effects still require policy and approvals.",
    });
  }
  return warnings;
}

function slugSkillId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `custom-skill-${randomUUID().slice(0, 8)}`;
}

function supportedRunToolNames(): readonly RunTool[] {
  return [...readOnlyRunTools, "bash", "edit", "write"] as const;
}

function supportedRoleKeys(): readonly SkillDefinition["roleAffinity"][number][] {
  return ["product", "architect", "engineer", "designer", "qa", "security", "release", "docs", "custom"];
}

function supportedWorkflowPhases(): readonly SkillDefinition["workflowPhase"][] {
  return ["discover", "plan", "design", "implement", "review", "test", "secure", "ship", "document", "operate"];
}

function supportedSkillStateEffects(): readonly SkillDefinition["stateEffects"][number][] {
  return ["creates_plan", "updates_plan", "creates_task", "updates_task", "starts_run", "requests_approval", "creates_artifact", "updates_docs", "prepares_release"];
}
