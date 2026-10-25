import { isDeepStrictEqual } from "node:util";
import { isHostCapabilityToolDefinitionV1 } from "@ling-stack/contracts";
import { redactSecrets, type RunStore, type SkillSourceRuntimeContext } from "@ling-stack/core";
import { assertPreparedPiTaskInput, DELEGATION_TOOL_NAMES, readPreparedPiInput,
  type PiRunnerPreparedInput, type PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { HttpError } from "../../errors.js";
import { isRecord } from "../../shared/validation.js";
import type { RunRequest } from "./schemas.js";
import { inlineProviderDescriptor } from "../conversations/normal-conversation-prepared-provider.js";

const inputKeys = ["cwd", "task", "provider", "tools", "mcpTools", "thinkingLevel", "reasoningSummary", "systemPrompt",
  "appendSystemPrompt", "agentDir", "runtimePaths", "runtimeToolFeatures", "mediaGenerationTools", "initialToolSurface", "hostCapabilityTools"] as const;
type PreparedOptions = Omit<Pick<PiRunnerRunOptions, (typeof inputKeys)[number]>, "tools"> & { readonly tools?: RunRequest["tools"] };
export interface PreparedRunnerInput {
  readonly schemaVersion: 1;
  readonly runnerId: string;
  readonly input: PreparedOptions;
  readonly toolHydrationEnabled: boolean;
  readonly preparedInput: PiRunnerPreparedInput;
  readonly usedMemory?: RunRequest["preselectedMemoryUse"];
  readonly skillSourceContext?: SkillSourceRuntimeContext;
}

/** Capture only model input and provenance. Never persist callbacks, secrets, leases or approvals. */
export function capturePreparedRunnerInput(input: {
  readonly runnerId: string;
  readonly options: PiRunnerRunOptions;
  readonly preparedInput: PiRunnerPreparedInput;
  readonly usedMemory?: RunRequest["preselectedMemoryUse"];
  readonly skillSourceContext?: SkillSourceRuntimeContext;
}): PreparedRunnerInput {
  const options = Object.fromEntries(inputKeys.map((key) => [key, input.options[key]]));
  options.provider = inlineProviderDescriptor(input.options.provider);
  return readPreparedRunnerInput(json({ schemaVersion: 1, runnerId: input.runnerId, input: options,
    toolHydrationEnabled: input.options.initialToolSurface?.toolHydration ?? Boolean(input.options.onToolHydrationRequest),
    preparedInput: input.preparedInput, usedMemory: input.usedMemory, skillSourceContext: input.skillSourceContext }), input.options);
}

/** Rebind credentials and current policy only after matching the frozen non-secret configuration. */
export function restorePreparedRunnerOptions(
  payload: PreparedRunnerInput, current: PiRunnerRunOptions,
): PiRunnerRunOptions {
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
  if (payload.toolHydrationEnabled && !(current.initialToolSurface?.toolHydration ?? Boolean(current.onToolHydrationRequest)) ||
    payload.input.initialToolSurface?.userInput === true && current.initialToolSurface?.userInput !== true ||
    payload.input.initialToolSurface?.delegation === true && current.initialToolSurface?.delegation !== true ||
    (payload.input.initialToolSurface?.nativeFileCreate === true) !== (current.initialToolSurface?.nativeFileCreate === true) ||
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
  const eligible = store.getEligibleMemoryIdsForRecall({ teammateId: request.teammateId, channelId: request.task.channelId,
    taskId: request.task.id, intent: "task-run", query: "" }, ids);
  if (eligible.length !== ids.length) throw new HttpError(409, "prepared_memory_unavailable", "A prepared Memory source is no longer eligible.");
}
export function readPreparedRunnerInput(value: unknown, request: Pick<PiRunnerRunOptions, "cwd" | "task">): PreparedRunnerInput {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.runnerId !== "string" || !value.runnerId ||
    typeof value.toolHydrationEnabled !== "boolean" || !isRecord(value.input) ||
    Object.keys(value).some((key) => !["schemaVersion", "runnerId", "input", "toolHydrationEnabled", "preparedInput", "usedMemory", "skillSourceContext"].includes(key)) ||
    Object.keys(value.input).some((key) => !(inputKeys as readonly string[]).includes(key)) ||
    value.input.cwd !== request.cwd || !isDeepStrictEqual(value.input.task, json(request.task)) ||
    !isRecord(value.input.provider) || "apiKey" in value.input.provider || "headers" in value.input.provider ||
    !isDeepStrictEqual(redactSecrets(value), value)) throw new Error("Invalid prepared execution payload");
  const prepared = readPreparedPiInput(value.preparedInput);
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
  if (value.input.initialToolSurface !== undefined) {
    const surface = value.input.initialToolSurface;
    if (!isRecord(surface) || Object.keys(surface).some(key => !["mediaGeneration", "toolHydration", "userInput", "delegation", "nativeFileCreate"].includes(key)) ||
      Object.values(surface).some(selected => typeof selected !== "boolean") ||
      surface.userInput !== undefined && prepared.tools.some(tool => tool.name === "request_user_input") !== surface.userInput ||
      prepared.tools.filter(tool => (DELEGATION_TOOL_NAMES as readonly string[]).includes(tool.name)).length
        !== (surface.delegation === true ? DELEGATION_TOOL_NAMES.length : 0)) {
      throw new Error("Invalid prepared user-input tool surface");
    }
  }
  const write = prepared.tools.find(tool => tool.name === "write");
  if (write) {
    const rawParameters: unknown = write.parameters;
    const parameters = isRecord(rawParameters) ? rawParameters : {};
    const properties = isRecord(parameters.properties) ? parameters.properties : {};
    const native = parameters.additionalProperties === false && parameters.anyOf === undefined
      && isDeepStrictEqual(parameters.required, ["path", "content"])
      && isDeepStrictEqual(Object.keys(properties).sort(), ["content", "path"]);
    const selected = isRecord(value.input.initialToolSurface) && value.input.initialToolSurface.nativeFileCreate === true;
    if (native !== selected) throw new Error("Invalid prepared native-create tool surface");
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

function requiredRuntimeToolFeaturesRemainAvailable(
  frozen: PiRunnerRunOptions["runtimeToolFeatures"],
  current: PiRunnerRunOptions["runtimeToolFeatures"],
): boolean {
  return (["requestPermissions", "unifiedExec", "shellSnapshot"] as const)
    .every((feature) => frozen?.[feature] !== true || current?.[feature] === true);
}
