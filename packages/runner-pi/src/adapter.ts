import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOLS } from "./constants.js";
import { translatePiEvent } from "./events.js";
import { TOOL_HYDRATION_CALL_TOOL_NAME, TOOL_HYDRATION_LOAD_TOOL_NAME } from "./extensions/tool-hydration.js";
import { createLingStackResourceLoader } from "./resource-loader.js";
import { fetchProvider } from "./provider-http.js";
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

    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
    });
    if (options.provider.apiKey) {
      await modelRuntime.setRuntimeApiKey(options.provider.provider, options.provider.apiKey);
    }

    this.registerCustomProviderIfNeeded(modelRuntime, options.provider);

    const model = modelRuntime.getModel(options.provider.provider, options.provider.model);
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
      ...(options.onMediaGenerationToolCall
        ? (options.mediaGenerationTools ?? []).filter((tool) => tool.targets.length > 0).map((tool) => tool.name)
        : []),
      ...(options.onToolHydrationRequest ? [TOOL_HYDRATION_LOAD_TOOL_NAME, TOOL_HYDRATION_CALL_TOOL_NAME] : []),
    ];

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
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
      const terminalFailure = findTerminalFailure(events);
      if (terminalFailure) {
        throw new Error(terminalFailure);
      }
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

  private registerCustomProviderIfNeeded(modelRuntime: ModelRuntime, provider: PiRunnerProviderConfig): void {
    if (!provider.baseUrl) {
      return;
    }

    const registration = {
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
          thinkingLevelMap: provider.thinkingLevelMap,
          input: [...(provider.input ?? ["text"])],
          contextWindow: provider.contextWindow ?? 128_000,
          maxTokens: provider.maxTokens ?? 16_384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: provider.compat,
        },
      ],
    };
    modelRuntime.registerProvider(provider.provider, registration);

    // The coding-agent SDK delegates the actual request to the composed
    // provider. Wrap only this provider's simple stream so concurrent runs do
    // not mutate globalThis.fetch while still giving OpenAI-compatible relays
    // an explicit Undici connect timeout.
    const registeredProvider = modelRuntime.getProvider(provider.provider);
    if (!registeredProvider) {
      return;
    }
    const streamSimple = registeredProvider.streamSimple.bind(registeredProvider);
    modelRuntime.registerProvider(provider.provider, {
      api: provider.api ?? "openai-completions",
      streamSimple: (model, context, streamOptions) => streamSimple(model, context, {
        ...streamOptions,
        fetch: streamOptions?.fetch ?? fetchProvider,
      }),
    });
  }
}

function findTerminalFailure(events: readonly PiRunnerEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "run_error") {
      return event.message;
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "message_end" && event.role === "assistant") {
      if (event.errorMessage) {
        return event.errorMessage;
      }
      if (event.stopReason?.toLowerCase() === "error") {
        return "Provider message ended with an error.";
      }
      return undefined;
    }
  }
  return undefined;
}

export function createPiRunner(): PiRunnerAdapter {
  return new PiRunnerAdapter();
}
