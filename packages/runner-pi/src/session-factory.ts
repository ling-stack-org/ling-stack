import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOLS } from "./constants.js";
import { TOOL_HYDRATION_CALL_TOOL_NAME, TOOL_HYDRATION_LOAD_TOOL_NAME } from "./extensions/tool-hydration.js";
import { isUserInputToolSurfaceEnabled } from "./extensions/user-input.js";
import { DELEGATION_TOOL_NAMES, isDelegationToolSurfaceEnabled } from "./extensions/delegation.js";
import { createLingStackResourceLoader } from "./resource-loader.js";
import type { PiRunnerRunOptions } from "./types.js";
import { throwIfAborted } from "./utils.js";

/** One SDK assembly path for preparation and execution; does not prompt a model. */
export async function createInitializedPiSession(options: PiRunnerRunOptions, bindRuntime: (runtime: ModelRuntime) => void): Promise<AgentSession> {
  throwIfAborted(options.signal);
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false, signal: options.signal });
  if (options.provider.apiKey) await modelRuntime.setRuntimeApiKey(options.provider.provider, options.provider.apiKey);
  bindRuntime(modelRuntime);
  const model = modelRuntime.getModel(options.provider.provider, options.provider.model);
  if (!model) throw new Error(`Pi model not found: ${options.provider.provider}/${options.provider.model}`);
  const requestedLevel = options.thinkingLevel ?? "medium";
  if ((requestedLevel === "max" || requestedLevel === "ultra") &&
    (!model.reasoning || options.provider.thinkingLevelMap?.[requestedLevel] !== requestedLevel)) {
    throw new Error(`Selected model does not declare reasoning level ${requestedLevel}`);
  }
  const reasoningEffortDisabled = options.provider.compat?.supportsReasoningEffort === false ||
    (model.compat && "supportsReasoningEffort" in model.compat && model.compat.supportsReasoningEffort === false);
  const thinkingFormat = model.compat && "thinkingFormat" in model.compat ? model.compat.thinkingFormat : undefined;
  if ((requestedLevel === "max" || requestedLevel === "ultra") && model.api === "openai-completions" && reasoningEffortDisabled) {
    throw new Error("Selected model disables reasoning_effort on its Chat Completions endpoint");
  }
  if ((requestedLevel === "max" || requestedLevel === "ultra") && model.api === "openai-completions" &&
    (thinkingFormat === "qwen-chat-template" || thinkingFormat === "chat-template")) {
    throw new Error(`Reasoning level ${requestedLevel} is not supported by the ${thinkingFormat} adapter configuration`);
  }
  const nativeEffortApi = ["openai-responses", "openai-codex-responses", "openai-completions"].includes(model.api);
  const adaptiveAnthropic = model.api === "anthropic-messages" && model.compat &&
    "forceAdaptiveThinking" in model.compat && model.compat.forceAdaptiveThinking === true;
  if ((requestedLevel === "ultra" && !nativeEffortApi) ||
    (requestedLevel === "max" && !nativeEffortApi && !adaptiveAnthropic)) {
    throw new Error(`Reasoning level ${requestedLevel} is not supported by the ${model.api} adapter configuration`);
  }
  // Apply the declared native effort to this session, including built-in models.
  // Pi 1.1 has no ultra slot, so bridge it through max without mutating the catalog.
  const sessionModel = requestedLevel === "max" || requestedLevel === "ultra"
    ? { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, max: requestedLevel },
      ...(model.api === "openai-completions" ? { compat: { ...model.compat, supportsReasoningEffort: true } } : {}) }
    : model;
  const cwd = options.cwd;
  const agentDir = options.agentDir ?? options.runtimePaths?.piDir ?? join(cwd, ".ling-stack", "pi");
  const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: options.hostCompactionEnabled === true }, retry: { enabled: true, maxRetries: 1 },
    transport: options.provider.providerTransport ?? "auto" });
  const resourceLoader = await createLingStackResourceLoader(options, agentDir, settingsManager);
  throwIfAborted(options.signal);
  const activeTools = [
    ...(options.tools ?? DEFAULT_TOOLS),
    ...(options.mcpTools?.map((tool) => tool.registeredName) ?? []),
    ...(options.hostCapabilityTools?.map(tool => tool.name) ?? []),
    ...(isUserInputToolSurfaceEnabled(options) ? ["request_user_input"] : []),
    ...(isDelegationToolSurfaceEnabled(options) ? DELEGATION_TOOL_NAMES : []),
    ...(options.runtimeToolFeatures?.requestPermissions ? ["request_permission"] : []),
    ...((options.initialToolSurface?.mediaGeneration ?? Boolean(options.onMediaGenerationToolCall))
      ? (options.mediaGenerationTools ?? []).filter((tool) => tool.targets.length > 0).map((tool) => tool.name) : []),
    ...((options.initialToolSurface?.toolHydration ?? Boolean(options.onToolHydrationRequest)) ? [TOOL_HYDRATION_LOAD_TOOL_NAME, TOOL_HYDRATION_CALL_TOOL_NAME] : []),
  ];
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: sessionModel,
    thinkingLevel: requestedLevel === "ultra" ? "max" : requestedLevel, tools: activeTools, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd), settingsManager });
  return session;
}
