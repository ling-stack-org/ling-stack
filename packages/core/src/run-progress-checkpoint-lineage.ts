import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { buildEffectiveTeammateSkills, getEffectiveTeammateSkill } from "./effective-skills.js";
import { GSTACK_DEFAULT_SKILL_PACK_ID, listDefaultSkills } from "./builtin-skill-packs.js";
import { redactSecrets } from "./redaction.js";
import type { RunSession, RunStore } from "./run-types.js";
import { RunProgressCheckpointError, type RunProgressCheckpointLineage } from "./run-progress-checkpoint-types.js";
import { applyConversationModeToEffectiveRunPolicySnapshot, resolveSessionRunPolicy,
  type EffectiveRunPolicySnapshot, type ResolveSessionRunPolicyInput } from "./session-permissions.js";
import type { SkillApprovalProfile } from "./skill-types.js";

export type RunProgressLineageStore = Pick<RunStore, "getWorkUnit" | "getApprovalPolicy" | "getLingThread" | "getChannel"
  | "getProviderPreset" | "getAiTeammate" | "listTeammateSkillBindings" | "getSkillRegistryEntry"
  | "getLatestWorkspaceProvenanceWatermark">;

const executionKeys = ["schemaVersion", "runnerId", "input", "toolHydrationEnabled", "preparedInput", "usedMemory", "skillSourceContext"];
const inputKeys = ["cwd", "task", "provider", "tools", "mcpTools", "thinkingLevel", "reasoningSummary", "systemPrompt",
  "appendSystemPrompt", "agentDir", "runtimePaths", "runtimeToolFeatures", "mediaGenerationTools", "initialToolSurface", "hostCapabilityTools"];
const providerKeys = ["provider", "model", "displayName", "baseUrl", "api", "providerTransport", "authHeader", "reasoning",
  "thinkingLevelMap", "input", "contextWindow", "maxTokens", "compat"];
const preparedKeys = ["schemaVersion", "boundary", "taskId", "systemPrompt", "userPrompt", "model", "thinkingLevel", "tools", "fingerprint"];
const preparedModelKeys = ["id", "provider", "api", "baseUrl", "reasoning", "input", "contextWindow", "maxTokens", "compat", "thinkingLevelMap"];

/**
 * Capture actual local sources synchronously. The writer reuses this function
 * under its SQLite lock; consumers cannot substitute their own permission hash.
 * Pi schema/task-prompt assembly remains the Runner's strict receiver contract.
 */
export function captureRunProgressCheckpointLineage(
  store: RunProgressLineageStore,
  run: RunSession,
  expectedPolicy?: EffectiveRunPolicySnapshot,
): { readonly lineage: RunProgressCheckpointLineage; readonly policySnapshot: EffectiveRunPolicySnapshot } {
  const request = record(run.requestSnapshot);
  const execution = readRunProgressFrozenExecution(run);
  const options = record(execution.input);
  const provider = record(options.provider);
  const unit = run.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
  const workspacePolicy = store.getApprovalPolicy();
  const thread = run.threadId ? store.getLingThread(run.threadId) : undefined;
  const channel = run.channelId ? store.getChannel(run.channelId) : undefined;
  const preset = run.providerPresetId ? store.getProviderPreset(run.providerPresetId) : undefined;
  if (!unit || unit.linkedRunId !== run.id || unit.workspaceId !== workspacePolicy.workspaceId
    || !run.contextViewId || !run.contextViewCreatedAt || run.threadId && !thread || run.channelId && !channel
    || run.providerPresetId && (!preset || !preset.enabled)) throw invalid("checkpoint.lineage_mismatch");
  const baseProfile = readProfile(request.approvalProfile);
  let approvalProfile = baseProfile;
  let skillSource: unknown = null;
  if (run.selectedSkillId) {
    if (request.requestedSkillId !== run.selectedSkillId || request.selectedSkillId !== undefined && request.selectedSkillId !== run.selectedSkillId
      || !run.teammateId) throw invalid("checkpoint.permission_drift");
    const teammate = store.getAiTeammate(run.teammateId);
    const entry = store.getSkillRegistryEntry(run.selectedSkillId);
    const builtin = listDefaultSkills(GSTACK_DEFAULT_SKILL_PACK_ID).find(skill => skill.id === run.selectedSkillId);
    const definition = builtin ?? (entry?.reviewStatus === "published" ? entry.definition : undefined);
    const bindings = store.listTeammateSkillBindings(run.teammateId);
    if (!teammate || teammate.status !== "active" || !definition) throw invalid("checkpoint.permission_drift");
    const effective = getEffectiveTeammateSkill(buildEffectiveTeammateSkills({ teammate, bindings, skills: [definition],
      channelAllowedTools: channel?.allowedTools, providerCapabilities: preset?.capabilities }), run.selectedSkillId);
    if (!effective?.executable) throw invalid("checkpoint.permission_drift");
    approvalProfile = mergeRunProgressApprovalProfiles(baseProfile, definition.approvalProfile);
    skillSource = { selectedSkillId: run.selectedSkillId, definition, reviewStatus: builtin ? "builtin" : entry!.reviewStatus,
      updatedAt: builtin ? null : entry!.updatedAt, binding: effective.binding,
      teammate: { id: teammate.id, status: teammate.status, allowedTools: teammate.allowedTools, approvalProfile: teammate.approvalProfile } };
  } else if (request.requestedSkillId !== undefined || request.selectedSkillId !== undefined) {
    throw invalid("checkpoint.permission_drift");
  }
  const policy = resolveSessionRunPolicy({ workspacePolicy,
    authorizationMode: selection(request, "authorizationMode", ["ask", "smart", "always"]),
    workspaceAccessMode: selection(request, "workspaceAccessMode", ["read_only", "workspace_write", "full_access"]),
    permissionPreset: selection(request, "permissionPreset", ["read_only", "workspace_collaboration", "full_access", "custom"]),
    permissionMode: selection(request, "permissionMode", ["ask_everything", "balanced", "workspace_write", "full_access", "custom"]),
    channelBoundPath: channel?.boundPath || run.cwd, approvalProfile,
  } satisfies ResolveSessionRunPolicyInput);
  const policySnapshot = applyConversationModeToEffectiveRunPolicySnapshot(policy.snapshot, thread?.conversationMode.mode);
  if (!isDeepStrictEqual(policySnapshot, request.effectivePolicySnapshot)
    || expectedPolicy !== undefined && !isDeepStrictEqual(policySnapshot, expectedPolicy)) throw invalid("checkpoint.permission_drift");
  const policySources = { schemaVersion: 1, workspacePolicy,
    thread: thread ? { id: thread.id, workspaceId: thread.workspaceId, mode: thread.conversationMode } : null,
    channel: channel ? { id: channel.id, status: channel.status, boundPath: channel.boundPath, allowedTools: channel.allowedTools } : null,
    skill: skillSource,
    provider: preset ? { id: preset.id, kind: preset.kind, providerId: preset.providerId, model: preset.model, api: preset.api,
      baseUrl: preset.baseUrl, providerTransport: preset.providerTransport, authHeader: preset.authHeader, reasoning: preset.reasoning,
      input: preset.input, contextWindow: preset.contextWindow, maxTokens: preset.maxTokens, compat: preset.compat,
      capabilities: preset.capabilities, enabled: preset.enabled, updatedAt: preset.updatedAt } : { frozenDescriptor: provider },
  };
  return { policySnapshot, lineage: {
    workspaceId: unit.workspaceId, contextViewId: run.contextViewId, contextViewCreatedAt: run.contextViewCreatedAt,
    ...(run.providerPresetId ? { providerPresetId: run.providerPresetId } : {}),
    providerName: run.providerName, providerModel: run.providerModel,
    providerConfigurationFingerprint: runProgressHashJson(provider), preparedExecutionFingerprint: runProgressHashJson(execution),
    acceptedInstructionsFingerprint: runProgressHashJson({ task: options.task, systemPrompt: options.systemPrompt,
      appendSystemPrompt: options.appendSystemPrompt ?? [], preparedInputFingerprint: record(execution.preparedInput).fingerprint }),
    policySnapshotFingerprint: runProgressHashJson(policySnapshot), policySourcesFingerprint: runProgressHashJson(policySources),
    workspaceProvenanceWatermark: store.getLatestWorkspaceProvenanceWatermark(unit.workspaceId),
  } };
}

/** Exactly the existing strict-rank merge, shared with the Host instead of another decisioner. */
export function mergeRunProgressApprovalProfiles(base: SkillApprovalProfile | undefined, required: SkillApprovalProfile): SkillApprovalProfile {
  const rank = (mode: SkillApprovalProfile["mode"]): number => mode === "strict" ? 2 : mode === "standard" ? 1 : 0;
  return { ...(!base || rank(required.mode) > rank(base.mode) ? required : base),
    requiredForTools: [...new Set([...(base?.requiredForTools ?? []), ...(required.requiredForTools ?? [])])],
    requiredForActions: [...new Set([...(base?.requiredForActions ?? []), ...(required.requiredForActions ?? [])])] };
}

/** No normalization: hash the durable parser envelope in its original JSON field order. */
export function readRunProgressFrozenExecution(run: RunSession): Record<string, unknown> {
  const request = record(run.requestSnapshot);
  const execution = record(request.runnerExecutionInput);
  const options = record(execution.input), provider = record(options.provider), prepared = record(execution.preparedInput);
  const task = record(options.task), snapshotTask = record(run.taskSnapshot);
  // Run stores a full durable Task row; the frozen model boundary owns only
  // these four semantic input fields, as the existing Host/Runner parser does.
  const modelTask = { id: snapshotTask.id, title: snapshotTask.title, prompt: snapshotTask.prompt,
    ...(snapshotTask.channelId === undefined ? {} : { channelId: snapshotTask.channelId }) };
  if (execution.schemaVersion !== 1 || execution.runnerId !== "pi" || typeof execution.toolHydrationEnabled !== "boolean"
    || Object.keys(execution).some(key => !executionKeys.includes(key)) || Object.keys(options).some(key => !inputKeys.includes(key))
    || Object.keys(provider).some(key => !providerKeys.includes(key)) || options.cwd !== run.cwd
    || !isDeepStrictEqual(task, modelTask) || task.id !== run.taskId
    || ![task.id, task.title, task.prompt].every(value => typeof value === "string")
    || task.channelId !== undefined && typeof task.channelId !== "string"
    || provider.provider !== run.providerName || provider.model !== run.providerModel
    || prepared.schemaVersion !== 1 || prepared.boundary !== "pi-model-context" || prepared.taskId !== run.taskId
    || Object.keys(prepared).sort().join(",") !== [...preparedKeys].sort().join(",")
    || !["systemPrompt", "userPrompt", "thinkingLevel", "fingerprint"].every(key => typeof prepared[key] === "string")
    || !isRecord(prepared.model) || Object.keys(prepared.model).some(key => !preparedModelKeys.includes(key))
    || prepared.model.id !== run.providerModel || prepared.model.provider !== run.providerName
    || !Array.isArray(prepared.tools) || prepared.tools.some(tool => !isRecord(tool) || typeof tool.name !== "string"
      || !tool.name.trim() || typeof tool.description !== "string" || !isRecord(tool.parameters)
      || Object.keys(tool).some(key => !["name", "description", "parameters", "constrainedSampling"].includes(key)))
    || new Set(prepared.tools.map(tool => tool.name)).size !== prepared.tools.length) throw invalid("checkpoint.lineage_mismatch");
  const { fingerprint, ...body } = prepared;
  if (fingerprint !== runProgressHashJson(body)) throw invalid("checkpoint.lineage_mismatch");
  assertRunProgressPayloadSecretFree(execution);
  return execution;
}

export function runProgressHashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function assertRunProgressPayloadSecretFree(value: unknown): void {
  const comparable = structuredClone(value);
  const scrub = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { item.forEach(scrub); return; }
    for (const [key, child] of Object.entries(item)) {
      if (/^(?:fingerprint|digest|.*Fingerprint|.*Digest|.*Sha256|fencingToken)$/u.test(key)) (item as Record<string, unknown>)[key] = "[REDACTED]";
      else scrub(child);
    }
  };
  scrub(comparable);
  if (!isDeepStrictEqual(redactSecrets(comparable), comparable)) throw invalid("checkpoint.snapshot_unavailable");
}

function selection<K extends keyof ResolveSessionRunPolicyInput>(request: Record<string, unknown>, key: K, allowed: readonly string[]): ResolveSessionRunPolicyInput[K] {
  const value = request[key];
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) throw invalid("checkpoint.permission_drift");
  return value as ResolveSessionRunPolicyInput[K];
}

function readProfile(value: unknown): SkillApprovalProfile | undefined {
  if (value === undefined) return undefined;
  const profile = record(value);
  if (!["none", "standard", "strict"].includes(String(profile.mode)) || Object.keys(profile).some(key =>
    !["mode", "risk", "requiredForTools", "requiredForActions"].includes(key)) || ["requiredForTools", "requiredForActions"].some(key =>
    profile[key] !== undefined && (!Array.isArray(profile[key]) || !profile[key].every((item: unknown) => typeof item === "string")))) {
    throw invalid("checkpoint.permission_drift");
  }
  return profile as unknown as SkillApprovalProfile;
}
function invalid(code: ConstructorParameters<typeof RunProgressCheckpointError>[0]): RunProgressCheckpointError { return new RunProgressCheckpointError(code); }
export function isRunProgressRecord(value: unknown): value is Record<string, unknown> { return isRecord(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function record(value: unknown): Record<string, unknown> { if (!isRecord(value)) throw invalid("checkpoint.lineage_mismatch"); return value; }
