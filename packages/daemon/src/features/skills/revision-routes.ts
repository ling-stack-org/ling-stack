import type { IncomingMessage, ServerResponse } from "node:http";
import {
  providerCapabilities,
  readOnlyRunTools,
  riskyRunTools,
  SkillRevisionStoreError,
  type SkillDefinition,
  type SkillImportWarning,
  type SkillRegistryEntry,
} from "@ling-stack/core";
import type {
  ApprovalActionType,
  ApprovalRisk,
  SkillApprovalMode,
  SkillApprovalProfile,
  SkillEditableDefinition,
  SkillRevisionAuthorityDiff,
  SkillRevisionPreview,
  SkillRevisionPublishRequest,
  SkillRevisionPreviewRequest,
  ToolName,
} from "@ling-stack/contracts";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { flushSkillDefinitionRevisionNotices } from "./revision-notices.js";
import { listEffectiveSkillRegistryEntries } from "./registry.js";
import { skillPermissionWarnings } from "./schemas.js";

const toolNames = [...readOnlyRunTools, ...riskyRunTools] as readonly ToolName[];
const approvalModes = ["none", "standard", "strict"] as const satisfies readonly SkillApprovalMode[];
const approvalRisks = ["low", "medium", "high", "critical"] as const satisfies readonly ApprovalRisk[];
const approvalActionTypes = [
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "bash",
  "git_commit",
  "git_push",
  "external_send",
  "deploy",
  "media_cost",
  "credential_change",
  "provider_change",
  "workflow_step",
  "mcp_tool_call",
  "runtime_permission_request",
] as const satisfies readonly ApprovalActionType[];

type SkillRouteStore = ReturnType<RunStoreRegistry["getStore"]>;

export async function handleSkillRevisionRoute(input: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly config: ResolvedDaemonConfig;
  readonly store: SkillRouteStore;
  readonly controlPlaneEvents: ControlPlaneEventHub;
  readonly cwd: string;
  readonly skillId: string;
  readonly action: "revision-preview" | "revisions" | "revision-undo";
}): Promise<void> {
  if (input.action === "revisions" && input.request.method === "GET") {
    const skill = input.store.getSkillRegistryEntry(input.skillId)
      ?? listEffectiveSkillRegistryEntries(input.store).find(entry => entry.id === input.skillId);
    if (!skill) { writeJson(input.response, 404, { error: "skill_not_found" }); return; }
    writeJson(input.response, 200, { cwd: input.cwd, skillId: skill.id,
      revisions: input.store.listSkillDefinitionRevisions(skill.id) });
    return;
  }
  if (input.request.method !== "POST") {
    writeJson(input.response, 405, {
      error: "method_not_allowed",
      message: `${input.request.method} is not supported for /skills/:skillId/${input.action}`,
    });
    return;
  }

  try {
    const existing = requireEditableSkill(input.store, input.skillId);
    const body = await readJsonBody(input.request, input.config.maxBodyBytes);
    if (input.action === "revision-undo") {
      const record = readRecord(body, "Undo request must be a JSON object");
      const result = input.store.undoSkillDefinitionRevision(existing.id, {
        revisionId: readRequiredString(record, "revisionId"),
        expectedUpdatedAt: readRequiredString(record, "expectedUpdatedAt"),
        reason: readOptionalString(record, "reason"),
        confirmAuthorityChanges: readOptionalBoolean(record, "confirmAuthorityChanges"),
      }, new Date().toISOString());
      flushSkillDefinitionRevisionNotices(input.store, input.controlPlaneEvents, input.cwd);
      writeJson(input.response, 200, { cwd: input.cwd, ...result });
      return;
    }
    const request = parseSkillRevisionRequest(body, input.action === "revisions");
    if (existing.updatedAt !== request.expectedUpdatedAt || (request.expectedRevisionId !== undefined
      && input.store.getSkillDefinitionRevision(existing.id)?.id !== request.expectedRevisionId)) {
      writeJson(input.response, 409, {
        error: "skill_revision_conflict",
        message: "Skill changed after the editor was opened.",
      });
      return;
    }

    const preview = buildSkillRevisionPreview(existing, request.definition);
    if (input.action === "revision-preview") {
      writeJson(input.response, 200, { cwd: input.cwd, skillId: existing.id, preview });
      return;
    }
    if (!preview.canPublish) {
      writeJson(input.response, 409, {
        error: "skill_revision_invalid",
        message: "Skill revision contains blocking validation errors.",
        preview,
      });
      return;
    }
    if (preview.requiresConfirmation && !(request as SkillRevisionPublishRequest).confirmAuthorityChanges) {
      writeJson(input.response, 409, {
        error: "skill_revision_confirmation_required",
        message: "Skill authority changes require explicit confirmation.",
        preview,
      });
      return;
    }

    const now = new Date().toISOString();
    const sourceCandidateId = (request as SkillRevisionPublishRequest).sourceCandidateId;
    const candidate = sourceCandidateId ? input.store.getSkillCandidate(sourceCandidateId) : undefined;
    if (sourceCandidateId && (!candidate || candidate.status !== "approved_for_draft" ||
      candidate.targetSkillId !== existing.id || candidate.proposedAction !== "update_existing")) {
      writeJson(input.response, 409, { error: "skill_revision_invalid", message: "An approved correction for this skill is required." });
      return;
    }
    const draft = input.store.createSkillImportDraft({
      source: existing.source,
      ...(existing.sourcePath ? { sourcePath: existing.sourcePath } : {}),
      packId: existing.packId,
      name: preview.definition.name,
      ...(existing.version ? { version: existing.version } : {}),
      description: preview.definition.summary,
      definitions: [{
        definition: preview.definition,
        visibility: existing.visibility,
        warnings: preview.warnings,
      }],
      warnings: [],
    }, now);
    const skill = input.store.publishSkillRevisionDraft({
      draftId: draft.id,
      skillId: existing.id,
      expectedUpdatedAt: request.expectedUpdatedAt,
      expectedRevisionId: request.expectedRevisionId,
      actor: "local-user",
      reason: (request as SkillRevisionPublishRequest).reason,
      validationStatus: "schema_checked",
      sourceCandidateId,
      reviewedCandidateId: sourceCandidateId,
      sourceJobId: candidate?.sourceRefs.find(ref => ref.type === "learning-review")?.id,
    }, now);
    const revision = input.store.getSkillDefinitionRevision(skill.id);
    flushSkillDefinitionRevisionNotices(input.store, input.controlPlaneEvents, input.cwd);
    writeJson(input.response, 200, { cwd: input.cwd, draftId: draft.id, skill, revision });
  } catch (error) {
    if (error instanceof SkillRevisionStoreError) {
      writeJson(input.response, ["skill_revision_conflict", "skill_revision_confirmation_required"].includes(error.code) ? 409 : 400, {
        error: error.code,
        message: error.message,
      });
      return;
    }
    if (error instanceof SkillRevisionRequestError) {
      writeJson(input.response, error.statusCode, { error: error.code, message: error.message });
      return;
    }
    throw error;
  }
}

export function isSkillEditable(entry: SkillRegistryEntry): boolean {
  if (entry.reviewStatus === "archived" || entry.source === "builtin" || entry.source === "gstack" || entry.source === "workspace") {
    return false;
  }
  return entry.source === "custom" || entry.source === "skill-directory" || entry.source === "agents-md";
}

function requireEditableSkill(store: SkillRouteStore, skillId: string): SkillRegistryEntry {
  const existing = store.getSkillRegistryEntry(skillId)
    ?? listEffectiveSkillRegistryEntries(store).find((entry) => entry.id === skillId);
  if (!existing) {
    throw new SkillRevisionRequestError(404, "skill_not_found", `Skill not found: ${skillId}`);
  }
  if (!isSkillEditable(existing)) {
    throw new SkillRevisionRequestError(409, "skill_not_editable", "This skill is managed by a read-only source.");
  }
  return existing;
}

function parseSkillRevisionRequest(value: unknown, publish: boolean): SkillRevisionPreviewRequest | SkillRevisionPublishRequest {
  const record = readRecord(value, "Skill revision request must be a JSON object");
  const expectedUpdatedAt = readRequiredString(record, "expectedUpdatedAt");
  const definitionRecord = readRecord(record.definition, "definition must be a JSON object");
  const definition: SkillEditableDefinition = {
    name: readRequiredString(definitionRecord, "name"),
    summary: readRequiredString(definitionRecord, "summary"),
    promptFragments: readStringArray(definitionRecord, "promptFragments", { required: true, allowEmpty: false }),
    requiredTools: readEnumArray(definitionRecord, "requiredTools", toolNames),
    requiredProviderCapabilities: readEnumArray(definitionRecord, "requiredProviderCapabilities", providerCapabilities),
    approvalProfile: readApprovalProfile(definitionRecord.approvalProfile),
  };
  return publish
    ? { expectedUpdatedAt, expectedRevisionId: readOptionalString(record, "expectedRevisionId"), definition,
        reason: readOptionalString(record, "reason"), sourceCandidateId: readOptionalString(record, "sourceCandidateId"),
        confirmAuthorityChanges: readOptionalBoolean(record, "confirmAuthorityChanges") }
    : { expectedUpdatedAt, expectedRevisionId: readOptionalString(record, "expectedRevisionId"), definition };
}

function buildSkillRevisionPreview(existing: SkillRegistryEntry, editable: SkillEditableDefinition): SkillRevisionPreview {
  const definition: SkillDefinition = {
    id: existing.definition.id,
    name: editable.name.trim(),
    summary: editable.summary.trim(),
    roleAffinity: existing.definition.roleAffinity,
    promptFragments: editable.promptFragments.map((item) => item.trim()).filter(Boolean),
    requiredTools: unique(editable.requiredTools),
    requiredProviderCapabilities: unique(editable.requiredProviderCapabilities),
    approvalProfile: normalizeApprovalProfile(editable.approvalProfile),
    stateEffects: existing.definition.stateEffects,
  };
  const warnings: SkillImportWarning[] = skillPermissionWarnings(definition.promptFragments.join("\n\n"));
  if (!definition.name) {
    warnings.push({ code: "missing_metadata", severity: "error", message: "Skill name is required." });
  }
  if (!definition.summary) {
    warnings.push({ code: "missing_metadata", severity: "error", message: "Skill summary is required." });
  }
  if (definition.promptFragments.length === 0) {
    warnings.push({ code: "missing_metadata", severity: "error", message: "At least one instruction block is required." });
  }
  const authorityDiff = buildAuthorityDiff(existing.definition, definition);
  return {
    definition,
    warnings,
    authorityDiff,
    requiresConfirmation: authorityDiff.changed,
    canPublish: !warnings.some((warning) => warning.severity === "error"),
  };
}

function buildAuthorityDiff(beforeDefinition: SkillDefinition, afterDefinition: SkillDefinition): SkillRevisionAuthorityDiff {
  const before = authoritySnapshot(beforeDefinition);
  const after = authoritySnapshot(afterDefinition);
  const requiredToolsChanged = !sameStringSet(before.requiredTools, after.requiredTools);
  const requiredProviderCapabilitiesChanged = !sameStringSet(before.requiredProviderCapabilities, after.requiredProviderCapabilities);
  const approvalProfileChanged = JSON.stringify(normalizeApprovalProfile(before.approvalProfile)) !== JSON.stringify(normalizeApprovalProfile(after.approvalProfile));
  return {
    changed: requiredToolsChanged || requiredProviderCapabilitiesChanged || approvalProfileChanged,
    requiredToolsChanged,
    requiredProviderCapabilitiesChanged,
    approvalProfileChanged,
    before,
    after,
  };
}

function authoritySnapshot(definition: SkillDefinition) {
  return {
    requiredTools: [...definition.requiredTools],
    requiredProviderCapabilities: [...definition.requiredProviderCapabilities],
    approvalProfile: normalizeApprovalProfile(definition.approvalProfile),
  };
}

function readApprovalProfile(value: unknown): SkillApprovalProfile {
  const record = readRecord(value, "approvalProfile must be a JSON object");
  const mode = readEnum(record, "mode", approvalModes);
  if (mode === "none") {
    return { mode };
  }
  const risk = readOptionalEnum(record, "risk", approvalRisks);
  const requiredForTools = readOptionalEnumArray(record, "requiredForTools", toolNames);
  const requiredForActions = readOptionalEnumArray(record, "requiredForActions", approvalActionTypes);
  return {
    mode,
    ...(risk ? { risk } : {}),
    ...(requiredForTools ? { requiredForTools } : {}),
    ...(requiredForActions ? { requiredForActions } : {}),
  };
}

function normalizeApprovalProfile(profile: SkillApprovalProfile): SkillApprovalProfile {
  if (profile.mode === "none") {
    return { mode: "none" };
  }
  return {
    mode: profile.mode,
    ...(profile.risk ? { risk: profile.risk } : {}),
    ...(profile.requiredForTools ? { requiredForTools: unique(profile.requiredForTools).sort() } : {}),
    ...(profile.requiredForActions ? { requiredForActions: unique(profile.requiredForActions).sort() } : {}),
  };
}

function readRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SkillRevisionRequestError(400, "skill_revision_invalid", message);
  }
  return value as Record<string, unknown>;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new SkillRevisionRequestError(400, "skill_revision_invalid", `${key} must be a non-empty string`);
  }
  return value.trim();
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  return record[key] === undefined ? undefined : readRequiredString(record, key);
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new SkillRevisionRequestError(400, "skill_revision_invalid", `${key} must be a boolean`);
  }
  return value;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
  options: { readonly required: boolean; readonly allowEmpty: boolean },
): string[] {
  const value = record[key];
  if (!Array.isArray(value) || (options.required && value.length === 0) || value.some((item) => typeof item !== "string")) {
    throw new SkillRevisionRequestError(400, "skill_revision_invalid", `${key} must be an array of strings`);
  }
  const normalized = unique(value.map((item) => item.trim()).filter((item) => options.allowEmpty || Boolean(item)));
  if (options.required && normalized.length === 0) {
    throw new SkillRevisionRequestError(400, "skill_revision_invalid", `${key} must include at least one value`);
  }
  return normalized;
}

function readEnum<T extends string>(record: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = record[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new SkillRevisionRequestError(400, "skill_revision_invalid", `${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function readOptionalEnum<T extends string>(record: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  if (record[key] === undefined) return undefined;
  return readEnum(record, key, allowed);
}

function readEnumArray<T extends string>(record: Record<string, unknown>, key: string, allowed: readonly T[]): T[] {
  return readOptionalEnumArray(record, key, allowed) ?? [];
}

function readOptionalEnumArray<T extends string>(record: Record<string, unknown>, key: string, allowed: readonly T[]): T[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !allowed.includes(item as T))) {
    throw new SkillRevisionRequestError(400, "skill_revision_invalid", `${key} contains unsupported values`);
  }
  return unique(value as T[]);
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return [...new Set(left)].sort().join("\u0000") === [...new Set(right)].sort().join("\u0000");
}

class SkillRevisionRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SkillRevisionRequestError";
  }
}
