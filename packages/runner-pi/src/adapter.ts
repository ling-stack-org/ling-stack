import { join } from "node:path";
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOLS } from "./constants.js";
import { translatePiEvent } from "./events.js";
import { TOOL_HYDRATION_CALL_TOOL_NAME, TOOL_HYDRATION_LOAD_TOOL_NAME } from "./extensions/tool-hydration.js";
import { createLingStackResourceLoader } from "./resource-loader.js";
import type { PiRunnerEvent, PiRunnerProviderConfig, PiRunnerResult, PiRunnerRunOptions } from "./types.js";
import { formatTaskPrompt, throwIfAborted } from "./utils.js";

export class PiRunnerAdapter {
  async runTask(options: PiRunnerRunOptions): Promise<PiRunnerResult> {
    const events: PiRunnerEvent[] = [];
    const emit = (event: PiRunnerEvent): void => {
      events.push(event);
      options.onEvent?.(event);
    };

    throwIfAborted(options.signal);

    const authStorage = AuthStorage.inMemory();
    if (options.provider.apiKey) {
      authStorage.setRuntimeApiKey(options.provider.provider, options.provider.apiKey);
    }

    const modelRegistry = ModelRegistry.inMemory(authStorage);
    this.registerCustomProviderIfNeeded(modelRegistry, options.provider);

    const model = modelRegistry.find(options.provider.provider, options.provider.model);
    if (!model) {
      throw new Error(`Pi model not found: ${options.provider.provider}/${options.provider.model}`);
    }

    const cwd = options.cwd;
    const agentDir = options.agentDir ?? options.runtimePaths?.piDir ?? join(cwd, ".ling-stack", "pi");
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
      transport: options.provider.providerTransport ?? "auto",
    });
    const resourceLoader = await createLingStackResourceLoader(options, agentDir, settingsManager);
    const activeTools = [
      ...(options.tools ?? DEFAULT_TOOLS),
      ...(options.mcpTools?.map((tool) => tool.registeredName) ?? []),
      ...(options.onToolHydrationRequest ? [TOOL_HYDRATION_LOAD_TOOL_NAME, TOOL_HYDRATION_CALL_TOOL_NAME] : []),
    ];

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: options.thinkingLevel ?? "medium",
      tools: activeTools,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    });

    const onAbort = (): void => {
      void session.abort();
    };
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const unsubscribe = session.subscribe((event) => {
      const translated = translatePiEvent(event);
      if (translated) {
        emit(translated);
      }
    });

    emit({
      type: "run_start",
      taskId: options.task.id,
      cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });

    try {
      throwIfAborted(options.signal);
      await session.prompt(formatTaskPrompt(options.task), { source: "rpc" });
      throwIfAborted(options.signal);
      emit({
        type: "run_end",
        taskId: options.task.id,
        messageCount: session.state.messages.length,
      });
      return {
        taskId: options.task.id,
        events,
        messages: session.state.messages as readonly unknown[],
      };
    } catch (error) {
      emit({
        type: "run_error",
        taskId: options.task.id,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      unsubscribe();
      session.dispose();
    }
  }

  private registerCustomProviderIfNeeded(modelRegistry: ModelRegistry, provider: PiRunnerProviderConfig): void {
    if (!provider.baseUrl) {
      return;
    }

    modelRegistry.registerProvider(provider.provider, {
      name: provider.displayName ?? provider.provider,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      api: provider.api ?? "openai-completions",
      headers: provider.headers,
      authHeader: provider.authHeader,
      models: [
        {
          id: provider.model,
          name: provider.model,
          api: provider.api ?? "openai-completions",
          baseUrl: provider.baseUrl,
          reasoning: provider.reasoning ?? true,
          input: [...(provider.input ?? ["text"])],
          contextWindow: provider.contextWindow ?? 128_000,
          maxTokens: provider.maxTokens ?? 16_384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: provider.compat,
        },
      ],
    });
  }
}

export function createPiRunner(): PiRunnerAdapter {
  return new PiRunnerAdapter();
}
