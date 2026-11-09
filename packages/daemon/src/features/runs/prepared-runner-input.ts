import { createHash } from "node:crypto";
import { resolveAutomaticMemoryRecallScope } from "../memory/recall-service.js";
import { isDeepStrictEqual } from "node:util";
import { isHostCapabilityToolDefinitionV1 } from "@ling-stack/contracts";
import { redactSecrets, type RunStore, type SkillDefinition, type SkillSourceRuntimeContext } from "@ling-stack/core";
import { assertPreparedPiTaskInput, DELEGATION_TOOL_NAMES, readPreparedPiInput, type PiRunnerPreparedInput, type PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { HttpError } from "../../errors.js";
import { isRecord } from "../../shared/validation.js";
import type { RunRequest } from "./schemas.js";
import { inlineProviderDescriptor } from "../conversations/normal-conversation-prepared-provider.js";

const inputKeys = ["cwd", "task", "provider", "tools", "mcpTools", "thinkingLevel", "reasoningSummary", "systemPrompt",
  "appendSystemPrompt", "agentDir", "runtimePaths", "runtimeToolFeatures", "mediaGenerationTools", "initialToolSurface", "hostCapabilityTools", "readonlyToolsProfile", "isolatedToolsProfile"] as const;
const isolatedToolNames = ["read", "grep", "find", "ls", "write", "edit"] as const;
type PreparedOptions = Omit<Pick<PiRunnerRunOptions, (typeof inputKeys)[number]>, "tools"> & { readonly tools?: RunRequest["tools"] };
export interface SkillDefinitionRuntimeSnapshot {
  readonly skillId: string;
  readonly revisionId?: string;
  readonly definitionHash: string;
}

export function captureSkillDefinitionSnapshot(store: RunStore, definition: SkillDefinition): SkillDefinitionRuntimeSnapshot {
  const head = store.getSkillDefinitionRevision(definition.id);
  return { skillId: definition.id, ...(head && isDeepStrictEqual(head.afterDefinition, definition) ? { revisionId: head.id } : {}),
    definitionHash: `sha256:${createHash("sha256").update(JSON.stringify(definition)).digest("hex")}` };
}

export interface PreparedRunnerInput {
  readonly schemaVersion: 1;
  readonly runnerId: string;
  readonly input: PreparedOptions;
  readonly toolHydrationEnabled: boolean;
  readonly preparedInput: PiRunnerPreparedInput;
  readonly usedMemory?: RunRequest["preselectedMemoryUse"];
  readonly skillSourceContext?: SkillSourceRuntimeContext;
  readonly skillDefinitionSnapshot?: SkillDefinitionRuntimeSnapshot;
}

/** Capture only model input and provenance. Never persist callbacks, secrets, leases or approvals. */
export function capturePreparedRunnerInput(input: {
  readonly runnerId: string;
  readonly options: PiRunnerRunOptions;
  readonly preparedInput: PiRunnerPreparedInput;
  readonly usedMemory?: RunRequest["preselectedMemoryUse"];
  readonly skillSourceContext?: SkillSourceRuntimeContext;
  readonly skillDefinitionSnapshot?: SkillDefinitionRuntimeSnapshot;
}): PreparedRunnerInput {
  if (input.options.isolatedToolsProfile !== undefined) assertLiveIsolatedOptions(input.options);
  const options = Object.fromEntries(inputKeys.map((key) => [key, input.options[key]]));
  if (input.options.isolatedToolsProfile) options.tools ??= [...isolatedToolNames];
  options.provider = inlineProviderDescriptor(input.options.provider);
  return readPreparedRunnerInput(json({ schemaVersion: 1, runnerId: input.runnerId, input: options,
    toolHydrationEnabled: input.options.initialToolSurface?.toolHydration ?? Boolean(input.options.onToolHydrationRequest),
    preparedInput: input.preparedInput, usedMemory: input.usedMemory, skillSourceContext: input.skillSourceContext, skillDefinitionSnapshot: input.skillDefinitionSnapshot }), input.options);
}

/** Rebind credentials and current policy only after matching the frozen non-secret configuration. */
export function restorePreparedRunnerOptions(
  payload: PreparedRunnerInput, current: PiRunnerRunOptions,
): PiRunnerRunOptions {
  if (payload.input.readonlyToolsProfile !== current.readonlyToolsProfile ||
    payload.input.isolatedToolsProfile !== current.isolatedToolsProfile) {
    throw new HttpError(409, "workflow_safety_mismatch", "The prepared Host tool producer profile changed.");
  }
  if (payload.input.isolatedToolsProfile !== undefined) {
    payload = readPreparedRunnerInput(payload, current);
    try {
      assertLiveIsolatedOptions(current);
    } catch {
      throw new HttpError(409, "workflow_safety_mismatch", "The current Host isolated-files binding is unavailable or incompatible.");
    }
    if (!sameToolSelection(payload.input.tools ?? isolatedToolNames, current.tools ?? isolatedToolNames)) {
      throw new HttpError(409, "prepared_tool_capability_changed", "The prepared Host isolated-files tool selection changed.");
    }
  }
  if (!isDeepStrictEqual(payload.input.provider, json(inlineProviderDescriptor(current.provider)))) {
    throw new HttpError(409, "prepared_provider_configuration_changed", "Prepared provider configuration changed; start a new turn.");
  }
  const mcpTools = (payload.input.mcpTools ?? []).map((frozen) => {
    const live = current.mcpTools?.find((tool) => tool.registeredName === frozen.registeredName);
    // Default approval and side-effect risk are current Host policy, not model schema.
    const schema = (tool: typeof frozen) => { const { defaultApproval: _approval, sideEffectLevel: _risk, ...rest } = tool; return json(rest); };
    if (!live || !isDeepStrictEqual(schema(live), schema(frozen))) {
      throw new HttpError(409, "prepared_mcp_tool_changed", "A prepared MCP tool was revoked or its schema changed.");
    }
    return { ...frozen, defaultApproval: live.defaultApproval, sideEffectLevel: live.sideEffectLevel };
  });
  const frozenSurface = payload.input.initialToolSurface;
  const currentSurface = current.initialToolSurface;
  if (payload.toolHydrationEnabled && !(currentSurface?.toolHydration ?? Boolean(current.onToolHydrationRequest)) ||
    frozenSurface?.userInput === true && currentSurface?.userInput !== true ||
    frozenSurface?.delegation === true && currentSurface?.delegation !== true ||
    frozenSurface?.nativeFileCreate !== undefined && currentSurface?.nativeFileCreate !== frozenSurface.nativeFileCreate ||
    !requiredRuntimeToolFeaturesRemainAvailable(payload.input.runtimeToolFeatures, current.runtimeToolFeatures)) {
    throw new HttpError(409, "prepared_tool_capability_changed", "Prepared runtime tool capabilities changed.");
  }
  for (const tool of payload.input.mediaGenerationTools ?? []) {
    const live = current.mediaGenerationTools?.find((item) => item.name === tool.name);
    if (!live || tool.targets.some((target) => !live.targets.some((item) => isDeepStrictEqual(json(item), target)))) {
      throw new HttpError(409, "prepared_media_tool_changed", "A prepared media target was revoked or its schema changed.");
    }
  }
  for (const tool of payload.input.hostCapabilityTools ?? []) {
    const live = current.hostCapabilityTools?.find(item => item.name === tool.name);
    if (!live || !isHostCapabilityToolDefinitionV1(live) || !isDeepStrictEqual(json(live), tool)) {
      throw new HttpError(409, "prepared_host_capability_changed", "A prepared Host capability was revoked or its schema changed.");
    }
  }
  return { ...current, ...payload.input, provider: current.provider, mcpTools, hostCapabilityTools: payload.input.hostCapabilityTools ?? [], preparedInput: payload.preparedInput,
    onToolHydrationRequest: payload.toolHydrationEnabled ? current.onToolHydrationRequest : undefined };
}

/** Frozen text is not an entitlement to expired/revoked/foreign Memory. No fresh selection. */
export function assertPreparedRunnerMemoryCurrent(store: RunStore, request: RunRequest, payload: PreparedRunnerInput): void {
  const ids = payload.usedMemory?.memoryIds ?? [];
  if (ids.length === 0) return;
  const scope = resolveAutomaticMemoryRecallScope(store, { teammateId: request.teammateId, channelId: request.task.channelId,
    taskId: request.task.id, intent: "task-run", query: "" },
  request.workflowStepId ? { workflowStepId: request.workflowStepId } : undefined);
  const eligible = scope ? store.getEligibleMemoryIdsForRecall(scope, ids) : [];
  if (eligible.length !== ids.length) throw new HttpError(409, "prepared_memory_unavailable", "A prepared Memory source is no longer eligible.");
}
export function readPreparedRunnerInput(value: unknown, request: Pick<PiRunnerRunOptions, "cwd" | "task">): PreparedRunnerInput {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.runnerId !== "string" || !value.runnerId ||
    typeof value.toolHydrationEnabled !== "boolean" || !isRecord(value.input) ||
    Object.keys(value).some((key) => !["schemaVersion", "runnerId", "input", "toolHydrationEnabled", "preparedInput", "usedMemory", "skillSourceContext", "skillDefinitionSnapshot"].includes(key)) ||
    Object.keys(value.input).some((key) => !(inputKeys as readonly string[]).includes(key)) ||
    value.input.cwd !== request.cwd || !isDeepStrictEqual(value.input.task, json(request.task)) ||
    !isRecord(value.input.provider) || "apiKey" in value.input.provider || "headers" in value.input.provider ||
    !isDeepStrictEqual(redactSecrets(value), value)) throw new Error("Invalid prepared execution payload");
  const prepared = readPreparedPiInput(value.preparedInput);
  if (value.input.isolatedToolsProfile !== undefined && value.input.isolatedToolsProfile !== "host_isolated_files_v1") {
    throw new Error("Invalid prepared Host isolated-files profile");
  }
  if (value.input.isolatedToolsProfile === "host_isolated_files_v1" && (value.runnerId !== "pi"
    || value.toolHydrationEnabled || !isNarrowIsolatedSurface(value.input)
    || !sameToolSelection(value.input.tools ?? isolatedToolNames, prepared.tools.map(tool => tool.name))
    || !prepared.tools.every(isIsolatedPreparedTool))) throw new Error("Invalid prepared Host isolated-files tool surface");
  if (value.input.readonlyToolsProfile !== undefined && value.input.readonlyToolsProfile !== "host_readonly_v1") {
    throw new Error("Invalid prepared Host read profile");
  }
  if (value.input.readonlyToolsProfile === "host_readonly_v1" && (value.runnerId !== "pi"
    || prepared.tools.some(tool => !["read", "grep", "find", "ls", "request_user_input"].includes(tool.name))
    || value.toolHydrationEnabled)) throw new Error("Invalid prepared Host read tool surface");
  if (value.skillDefinitionSnapshot !== undefined) {
    const snapshot = value.skillDefinitionSnapshot;
    if (!isRecord(snapshot) || typeof snapshot.skillId !== "string" || !snapshot.skillId ||
      typeof snapshot.definitionHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(snapshot.definitionHash) ||
      (snapshot.revisionId !== undefined && (typeof snapshot.revisionId !== "string" || !snapshot.revisionId)) ||
      Object.keys(snapshot).some(key => !["skillId", "revisionId", "definitionHash"].includes(key)) ||
      (isRecord(value.skillSourceContext) && snapshot.skillId !== value.skillSourceContext.skillId)) {
      throw new Error("Invalid prepared skill definition snapshot");
    }
  }
  if (value.skillSourceContext !== undefined) {
    const context = value.skillSourceContext;
    if (!isRecord(context) || typeof context.skillId !== "string" || !context.skillId || typeof context.loaded !== "boolean") {
      throw new Error("Invalid prepared skill source context");
    }
    if (context.resourceBinding !== undefined) {
      const binding = context.resourceBinding;
      if (!isRecord(binding) || Object.keys(binding).length !== 4 ||
        !["manifestChecksum", "sourceChecksum"].every(key => typeof binding[key] === "string" && /^sha256:[a-f0-9]{64}$/.test(binding[key])) ||
        typeof binding.upstreamRevision !== "string" || !/^[a-f0-9]{40}$/.test(binding.upstreamRevision) ||
        typeof binding.adaptationRevision !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(binding.adaptationRevision) ||
        context.sourceKind !== "gstack-skill-directory" || !context.loaded || context.truncated || binding.sourceChecksum !== context.sourceChecksum) {
        throw new Error("Invalid prepared skill resource binding");
      }
    }
  }
  const preparedNativeCreateSelected = prepared.tools.some(tool => tool.name === "write" && isNativeCreateWriteTool(tool));
  if (value.input.initialToolSurface !== undefined || preparedNativeCreateSelected) {
    const surface = value.input.initialToolSurface;
    const surfaceRecord = isRecord(surface) ? surface : undefined;
    const delegationSelected = prepared.tools.filter(tool => (DELEGATION_TOOL_NAMES as readonly string[]).includes(tool.name)).map(tool => tool.name);
    const delegationSurfaceMatches = surfaceRecord?.delegation === undefined ||
      (surfaceRecord?.delegation === (delegationSelected.length > 0) &&
        (surfaceRecord.delegation === false || delegationSelected.length === DELEGATION_TOOL_NAMES.length &&
          DELEGATION_TOOL_NAMES.every(name => delegationSelected.includes(name))));
    const nativeCreateSelected = preparedNativeCreateSelected;
    const nativeSurfaceMatches = nativeCreateSelected
      ? surfaceRecord?.nativeFileCreate === true
      : surfaceRecord?.nativeFileCreate === undefined || surfaceRecord?.nativeFileCreate === false;
    const delegationSurfaceRequired = delegationSelected.length > 0 && surfaceRecord?.delegation !== true;
    if (!surfaceRecord || Object.keys(surfaceRecord).some(key => !['mediaGeneration', 'toolHydration', 'userInput', 'nativeFileCreate', 'delegation'].includes(key)) ||
      Object.values(surfaceRecord).some(selected => typeof selected !== "boolean") ||
      surfaceRecord.userInput !== undefined && prepared.tools.some(tool => tool.name === "request_user_input") !== surfaceRecord.userInput ||
      !delegationSurfaceMatches || delegationSurfaceRequired || !nativeSurfaceMatches) {
      throw new Error("Invalid prepared user-input tool surface");
    }
  }
  if (value.input.hostCapabilityTools !== undefined && (!Array.isArray(value.input.hostCapabilityTools) ||
    !value.input.hostCapabilityTools.every(isHostCapabilityToolDefinitionV1) ||
    new Set(value.input.hostCapabilityTools.map(tool => tool.name)).size !== value.input.hostCapabilityTools.length)) {
    throw new Error("Invalid prepared Host capability surface");
  }
  assertPreparedPiTaskInput(prepared, request.task);
  if (value.usedMemory !== undefined && (!isRecord(value.usedMemory) || !Array.isArray(value.usedMemory.memoryIds) ||
    value.usedMemory.memoryIds.length > 20 || !value.usedMemory.memoryIds.every((id) => typeof id === "string" && id) ||
    new Set(value.usedMemory.memoryIds).size !== value.usedMemory.memoryIds.length ||
    typeof value.usedMemory.recallQuery !== "string" || typeof value.usedMemory.policyVersion !== "string" ||
    Object.keys(value.usedMemory).some((key) => !["memoryIds", "recallQuery", "policyVersion"].includes(key)))) throw new Error("Invalid prepared memory evidence");
  if (value.input.tools !== undefined && (!Array.isArray(value.input.tools) ||
    !value.input.tools.every((tool) => ["read", "bash", "edit", "write", "grep", "find", "ls"].includes(tool)))) {
    throw new Error("Invalid prepared execution core tools");
  }
  // Malformed serialized option types must not make it as far as SDK dispatch.
  for (const key of ["tools", "appendSystemPrompt"]) if (value.input[key] !== undefined &&
    (!Array.isArray(value.input[key]) || !(value.input[key] as unknown[]).every((item) => typeof item === "string"))) {
    throw new Error("Invalid prepared execution string list");
  }
  for (const key of ["mcpTools", "mediaGenerationTools"]) if (value.input[key] !== undefined &&
    (!Array.isArray(value.input[key]) || !(value.input[key] as unknown[]).every(isRecord))) throw new Error("Invalid prepared execution tool list");
  if (value.input.reasoningSummary !== undefined &&
    !["auto", "concise", "detailed", "none"].includes(String(value.input.reasoningSummary))) {
    throw new Error("Invalid prepared reasoning summary mode");
  }
  return structuredClone(value) as unknown as PreparedRunnerInput;
}
function json<T>(value: T): T { return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T; }

function isNativeCreateWriteTool(tool: PiRunnerPreparedInput["tools"][number]): boolean {
  const parameters = tool.parameters;
  return isRecord(parameters) && parameters.required instanceof Array &&
    parameters.required.length === 2 && parameters.required.includes("path") && parameters.required.includes("content") &&
    !Object.hasOwn(parameters, "anyOf") && parameters.additionalProperties === false;
}

function assertLiveIsolatedOptions(options: PiRunnerRunOptions): void {
  if (options.isolatedToolsProfile !== "host_isolated_files_v1" || !isNarrowIsolatedSurface(options) ||
    typeof options.onToolBefore !== "function" || typeof options.onIsolatedToolCall !== "function") {
    throw new Error("Invalid prepared Host isolated-files binding");
  }
}

function isNarrowIsolatedSurface(input: unknown): boolean {
  if (!isRecord(input) || input.readonlyToolsProfile !== undefined) return false;
  const tools = input.tools === undefined ? isolatedToolNames : input.tools;
  if (!Array.isArray(tools) || !tools.every(name => (isolatedToolNames as readonly unknown[]).includes(name)) ||
    new Set(tools).size !== tools.length) return false;
  if (["mcpTools", "hostCapabilityTools", "mediaGenerationTools"].some(key => input[key] !== undefined &&
    (!Array.isArray(input[key]) || input[key].length !== 0))) return false;
  for (const [key, allowed] of [
    ["initialToolSurface", ["mediaGeneration", "toolHydration", "userInput", "nativeFileCreate", "delegation"]],
    ["runtimeToolFeatures", ["requestPermissions", "unifiedExec", "shellSnapshot"]],
  ] as const) {
    const flags = input[key];
    if (flags !== undefined && (!isRecord(flags) || Object.entries(flags).some(([name, enabled]) =>
      !(allowed as readonly string[]).includes(name) || enabled !== false && enabled !== undefined))) return false;
  }
  // Approval stays live in the Host handler; these other producers may not enter this profile.
  return ["onMcpToolCall", "onHostCapabilityCall", "onMediaGenerationToolCall", "onToolHydrationRequest",
    "onDelegationToolCall", "onUserInputRequest", "onPermissionRequired"].every(key => input[key] === undefined);
}

function sameToolSelection(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left) && left.length === right.length && new Set(left).size === left.length &&
    left.every(name => right.includes(name));
}

/** Reject legacy mutation/regex schemas too; SDK session fingerprint validation still owns exact schema identity. */
function isIsolatedPreparedTool(tool: PiRunnerPreparedInput["tools"][number]): boolean {
  if (!(isolatedToolNames as readonly string[]).includes(tool.name)) return false;
  if (!["grep", "write", "edit"].includes(tool.name)) return true;
  const schema = tool.parameters;
  if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties) || !Array.isArray(schema.required)) return false;
  const properties = schema.properties;
  if (tool.name === "grep") return schema.required.includes("literal") && isRecord(properties.literal) &&
    properties.literal.type === "boolean" && properties.literal.const === true;
  const fields = tool.name === "write" ? ["path", "content"] : ["path", "edits"];
  if (!sameToolSelection(schema.required, fields) || !sameToolSelection(Object.keys(properties), fields) ||
    ["anyOf", "oneOf", "allOf", "$ref"].some(key => schema[key] !== undefined) ||
    !isRecord(properties.path) || properties.path.type !== "string") return false;
  if (tool.name === "write") return isRecord(properties.content) && properties.content.type === "string";
  const edits = properties.edits;
  if (!isRecord(edits) || edits.type !== "array" || edits.minItems !== 1 || !isRecord(edits.items)) return false;
  const item = edits.items;
  const itemProperties = item.properties;
  return item.type === "object" && sameToolSelection(item.required, ["oldText", "newText"]) && isRecord(itemProperties) &&
    sameToolSelection(Object.keys(itemProperties), ["oldText", "newText"]) &&
    ["oldText", "newText"].every(key => isRecord(itemProperties[key]) && itemProperties[key].type === "string");
}

function requiredRuntimeToolFeaturesRemainAvailable(
  frozen: PiRunnerRunOptions["runtimeToolFeatures"],
  current: PiRunnerRunOptions["runtimeToolFeatures"],
): boolean {
  return (["requestPermissions", "unifiedExec", "shellSnapshot"] as const)
    .every((feature) => frozen?.[feature] !== true || current?.[feature] === true);
}
