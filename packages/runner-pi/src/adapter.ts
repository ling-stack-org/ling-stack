import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { translatePiEvents } from "./events.js";
import { createInitializedPiSession } from "./session-factory.js";
import { assertPreparedPiSession, capturePreparedPiInput, type PiRunnerPreparedInput } from "./prepared-input.js";
import { createPiPreparedInputReceiver } from "./prepared-input-receiver.js";
import { fetchProvider } from "./provider-http.js";
import { createPiSessionStopper, createPiTaskBoundary } from "./task-boundary.js";
import { PiRunnerYielded } from "./task-yield.js";
import type { PiRunnerEvent, PiRunnerProviderConfig, PiRunnerResult, PiRunnerRunOptions } from "./types.js";
import { formatTaskPrompt, throwIfAborted } from "./utils.js";

export class PiRunnerAdapter {
  /** Assemble exact SDK input without executing, emitting Run events, or persisting a session. */
  async prepareTaskInput(options: PiRunnerRunOptions): Promise<PiRunnerPreparedInput> {
    const session = await createInitializedPiSession(options, (runtime) => {
      this.registerCustomProviderIfNeeded(runtime, options.provider);
      const noModelRequest = (): never => { throw new Error("Model execution is forbidden during input preparation"); };
      runtime.streamSimple = noModelRequest;
      runtime.stream = noModelRequest;
    });
    try {
      throwIfAborted(options.signal);
      return capturePreparedPiInput(session, options);
    } finally {
      session.dispose();
    }
  }

  /** Resolves only on completion; required input rejects with PiRunnerYielded after SDK idle. */
  async runTask(options: PiRunnerRunOptions): Promise<PiRunnerResult> {
    const sourceSignal = options.signal;
    const inputReceiver = createPiPreparedInputReceiver(options);
    if (inputReceiver) options = { ...options, preparedInput: inputReceiver.preparedInput };
    const boundary = createPiTaskBoundary(options);
    options = boundary.options;
    const events: PiRunnerEvent[] = [];
    const emit = (event: PiRunnerEvent): void => {
      events.push(event);
      options.onEvent?.(event);
    };

    throwIfAborted(options.signal);

    const session = await createInitializedPiSession(options, (modelRuntime) => {
      this.registerCustomProviderIfNeeded(modelRuntime, options.provider);
      boundary.bindModelRuntime(modelRuntime);
    });
    const cwd = options.cwd;

    const stopSession = createPiSessionStopper(session);
    const onAbort = (): void => {
      // Wait outside the tool/extension callback; awaiting here can deadlock
      // the very SDK work whose completion makes the session idle.
      void stopSession().catch(() => undefined);
    };
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const unsubscribe = session.subscribe((event) => {
      for (const translated of translatePiEvents(event)) emit(translated);
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
      assertPreparedPiSession(session, options);
      if (inputReceiver) {
        // Host persistence is outside SDK extension hooks, whose failures can be swallowed.
        await inputReceiver.accept(options.signal!);
        boundary.assertOpen();
        assertPreparedPiSession(session, options);
      }
      await session.prompt(formatTaskPrompt(options.task), { source: "rpc" });
      await session.waitForIdle();
      boundary.assertOpen();
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
      let stopFailure: Error | undefined;
      try {
        await stopSession();
        await session.waitForIdle();
      } catch (failure) {
        // Even a non-Error/falsy rejection means cleanup was not proven.
        stopFailure = failure instanceof Error ? failure : new Error("Runner SDK cleanup failed.");
      }
      if (!stopFailure && !boundary.failure && !sourceSignal?.aborted && boundary.yieldRequest) {
        // Only SDK settlement is proven here. The Host must separately verify
        // its executor jobs and captured fence before persisting a checkpoint.
        throw new PiRunnerYielded(boundary.yieldRequest, new Date().toISOString());
      }
      let failure = boundary.failure ?? stopFailure ?? error;
      if (!boundary.failure && !stopFailure && sourceSignal?.aborted) {
        try { throwIfAborted(sourceSignal); } catch (cancelled) { failure = cancelled; }
      }
      emit({
        type: "run_error",
        taskId: options.task.id,
        message: failure instanceof Error ? failure.message : String(failure),
      });
      throw failure;
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
