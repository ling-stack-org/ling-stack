import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOLS } from "./constants.js";
import { TOOL_HYDRATION_CALL_TOOL_NAME, TOOL_HYDRATION_LOAD_TOOL_NAME } from "./extensions/tool-hydration.js";
import { createLingStackResourceLoader } from "./resource-loader.js";
import type { PiRunnerRunOptions } from "./types.js";
import { throwIfAborted } from "./utils.js";

/** One SDK assembly path for preparation and execution; does not prompt a model. */
export async function createInitializedPiSession(options: PiRunnerRunOptions, bindRuntime: (runtime: ModelRuntime) => void): Promise<AgentSession> {
  throwIfAborted(options.signal);
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStore: new InMemoryModelsStore() });
  if (options.provider.apiKey) await modelRuntime.setRuntimeApiKey(options.provider.provider, options.provider.apiKey);
  bindRuntime(modelRuntime);
  const model = modelRuntime.getModel(options.provider.provider, options.provider.model);
  if (!model) throw new Error(`Pi model not found: ${options.provider.provider}/${options.provider.model}`);
  const cwd = options.cwd;
  const agentDir = options.agentDir ?? options.runtimePaths?.piDir ?? join(cwd, ".ling-stack", "pi");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1 },
    transport: options.provider.providerTransport ?? "auto" });
  const resourceLoader = await createLingStackResourceLoader(options, agentDir, settingsManager);
  throwIfAborted(options.signal);
  const activeTools = [
    ...(options.tools ?? DEFAULT_TOOLS),
    ...(options.mcpTools?.map((tool) => tool.registeredName) ?? []),
    ...(options.hostCapabilityTools?.map(tool => tool.name) ?? []),
    ...((options.initialToolSurface?.mediaGeneration ?? Boolean(options.onMediaGenerationToolCall))
      ? (options.mediaGenerationTools ?? []).filter((tool) => tool.targets.length > 0).map((tool) => tool.name) : []),
    ...((options.initialToolSurface?.toolHydration ?? Boolean(options.onToolHydrationRequest)) ? [TOOL_HYDRATION_LOAD_TOOL_NAME, TOOL_HYDRATION_CALL_TOOL_NAME] : []),
  ];
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model,
    thinkingLevel: options.thinkingLevel ?? "medium", tools: activeTools, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd), settingsManager });
  return session;
}
