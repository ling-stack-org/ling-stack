import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { translatePiEvents } from "./events.js";
import { createInitializedPiSession } from "./session-factory.js";
import { assertPreparedPiSession, capturePreparedPiInput, type PiRunnerPreparedInput } from "./prepared-input.js";
import { installApprovedToolContinuation, readApprovedToolContinuation } from "./approved-tool-continuation.js";
import { createCompactionRecoveryCheckpointProjector, installCompactionRecoveryView } from "./compaction-recovery.js";
import { installOrdinaryProgressRecoveryView, readOrdinaryProgressRecoveryView } from "./ordinary-progress-recovery.js";
import { projectCompactionTaskView } from "./compaction-task-anchor.js";
import { createPiPreparedInputReceiver } from "./prepared-input-receiver.js";
import { fetchProvider } from "./provider-http.js";
import { createPiSessionStopper, createPiTaskBoundary } from "./task-boundary.js";
import { assertUserInputExecutionHandler } from "./extensions/user-input.js";
import { assertDelegationExecutionHandler } from "./extensions/delegation.js";
import { PiRunnerYielded } from "./task-yield.js";
import { createPiToolBoundaryObservation } from "./tool-boundary-observation.js";
import { DEFAULT_TOOLS } from "./constants.js";
import type { PiProviderErrorDiagnostic } from "./provider-error-diagnostic.js";
import type { PiRunnerEvent, PiRunnerProviderConfig, PiRunnerResult, PiRunnerRunOptions } from "./types.js";
import { formatTaskPrompt, throwIfAborted } from "./utils.js";
import { continuePiSession, isPiHostResumeControl } from "./session-continuation.js";
import { frozenPiConversation } from "./session-transcript.js";
import { resolvePiProviderRequestAuth } from "./provider-request-auth.js";

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
    assertUserInputExecutionHandler(options);
    assertDelegationExecutionHandler(options);
    if (options.ordinaryProgressRecovery !== undefined) {
      if (options.compactionRecovery || options.approvedToolContinuation) {
        throw new Error("Pi ordinary progress recovery cannot be combined with compaction or approved tool continuation");
      }
      if (!options.preparedInput || !options.runId || !options.runnerAttemptId || !options.onEvent || !options.onTaskContinuationBoundary) {
        throw new Error("Pi ordinary progress recovery requires prepared input, Run/Attempt identity, durable events, and a Host admission fence");
      }
      // Capture before SDK/backend awaits: a caller cannot rewrite the recovery baseline during setup.
      options = { ...options, ordinaryProgressRecovery: { schemaVersion: 1,
        modelView: readOrdinaryProgressRecoveryView(options.ordinaryProgressRecovery) } };
    }
    if (options.hostCompactionEnabled && (!options.runId || !options.runnerAttemptId
      || !options.onEvent || !options.onTaskContinuationBoundary)) {
      throw new Error("Host compaction requires Run/Attempt identity, durable events, and a provider admission fence");
    }
    const sourceSignal = options.signal;
    const replacedToolNames = new Set([...(options.mcpTools?.map(tool => tool.registeredName) ?? []),
      ...(options.mediaGenerationTools?.map(tool => tool.name) ?? []), ...(options.hostCapabilityTools?.map(tool => tool.name) ?? [])]);
    const builtinReads = new Set((options.tools ?? DEFAULT_TOOLS)
      .filter(name => ["read", "grep", "find", "ls"].includes(name) && !replacedToolNames.has(name)));
    const toolObservation = options.onToolBoundaryObservation && options.runId && options.runnerAttemptId
      ? createPiToolBoundaryObservation(options.runId, options.runnerAttemptId) : undefined;
    if (toolObservation) {
      options.onToolBoundaryObservation!(toolObservation.receipt);
      const onToolBefore = options.onToolBefore;
      options = { ...options, onToolBefore: request => {
        toolObservation.enter(request.toolCallId, request.toolName);
        return onToolBefore?.(request) ?? { allowed: true };
      } };
    }
    const inputReceiver = createPiPreparedInputReceiver(options);
    if (inputReceiver) options = { ...options, preparedInput: inputReceiver.preparedInput };
    let session: Awaited<ReturnType<typeof createInitializedPiSession>> | undefined;
    const acceptedTaskPrompt = options.preparedInput?.userPrompt ?? formatTaskPrompt(options.task);
    let frozenAuthority: PiRunnerPreparedInput | undefined;
    let recoveryCheckpointProjector: ((messages: readonly unknown[]) => readonly unknown[]) | undefined;
    const captureTaskModelView = (): readonly unknown[] | undefined => {
      if (!session || !frozenAuthority) return undefined;
      const conversation = frozenPiConversation(session.state.messages, frozenAuthority);
      return captureCompactionContext(projectCompactionTaskView(
        recoveryCheckpointProjector ? recoveryCheckpointProjector(conversation) : conversation, acceptedTaskPrompt));
    };
    const hostBoundary = options.onTaskContinuationBoundary;
    const boundary = createPiTaskBoundary((options.hostCompactionEnabled || options.ordinaryProgressRecovery) && hostBoundary
      ? { ...options, onTaskContinuationBoundary: async (point) => {
          if (point !== "before_provider_request") return hostBoundary(point);
          toolObservation?.enterProviderBoundary();
          try {
            return await hostBoundary(point, session ? captureTaskModelView() : undefined);
          } finally {
            toolObservation?.leaveProviderBoundary();
          }
        } }
      : options, () => session && frozenAuthority ? { systemPrompt: frozenAuthority.systemPrompt, messages: session.state.messages,
          acceptedTaskPrompt, sessionId: session.sessionId, preparedInput: frozenAuthority } : undefined);
    options = boundary.options;
    const events: PiRunnerEvent[] = [];
    let sdkSettlement: { readonly aborted: boolean } | undefined;
    const emit = (event: PiRunnerEvent): void => {
      if (event.type === "tool_start") toolObservation?.enter(event.toolCallId, event.toolName);
      events.push(event);
      options.onEvent?.(event);
    };

    throwIfAborted(options.signal);

    session = await createInitializedPiSession(options, (modelRuntime) => {
      this.registerCustomProviderIfNeeded(modelRuntime, options.provider);
      boundary.bindModelRuntime(modelRuntime);
    });
    const cwd = options.cwd;

    const stopSession = createPiSessionStopper(session);
    if (options.compactionRecovery && options.approvedToolContinuation) {
      throw new Error("Pi compaction recovery cannot be combined with approved tool continuation");
    }
    // Verify the frozen system/model/tool assembly while the session is still
    // empty, then install only the Host-sealed SDK view for restart recovery.
    assertPreparedPiSession(session, options);
    frozenAuthority = capturePreparedPiInput(session, options);
    let compactionRecoveryMode: "complete" | "continue" | undefined;
    let ordinaryProgressRecoveryMode: "complete" | "continue" | undefined;
    const onAbort = (): void => {
      // Wait outside the tool/extension callback; awaiting here can deadlock
      // the very SDK work whose completion makes the session idle.
      void stopSession().catch(() => undefined);
    };
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_settled") sdkSettlement = { aborted: event.aborted };
      if ((event.type === "message_start" || event.type === "message_end" || event.type === "message_update")
        && isPiHostResumeControl(event.message)) return;
      for (const translated of translatePiEvents(event)) {
        if (translated.type === "tool_end") {
          if (builtinReads.has(translated.toolName) && (!translated.isError || translated.toolName === "read")) {
            toolObservation?.completeBuiltinRead(translated.toolCallId, translated.toolName);
          }
          toolObservation?.completeTool(translated.toolCallId, translated.toolName);
        }
        if (translated.type === "context_compaction_start") {
          const contextSnapshot = captureTaskModelView();
          emit(contextSnapshot === undefined ? translated : { ...translated, contextSnapshot });
        } else if (translated.type === "context_compaction_end" && translated.outcome === "sdk_installed") {
          // Pi installs the SDK view before emitting compaction_end. Capture
          // the same frozen-task projection used by the model context hook.
          // Keep the exact summary/view private so the Host can seal it before
          // admitting another task request. Public RunEvents carry only status.
          const compactedModelView = captureTaskModelView();
          const compactedSummary = event.type === "compaction_end" ? event.result?.summary : undefined;
          emit(compactedModelView && typeof compactedSummary === "string" && compactedSummary.trim()
            ? { ...translated, compactedModelView, compactedSummary } : translated);
        } else {
          emit(translated);
        }
      }
    });

    emit({
      type: "run_start",
      taskId: options.task.id,
      cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });

    let sdkCleanupFailed = false;
    try {
      throwIfAborted(options.signal);
      if (!options.compactionRecovery) {
        assertPreparedPiSession(session, options);
      }
      if (inputReceiver) {
        // Host persistence is outside SDK extension hooks, whose failures can be swallowed.
        await inputReceiver.accept(options.signal!);
        boundary.assertOpen();
        assertPreparedPiSession(session, options);
      }
      if (options.compactionRecovery) {
        compactionRecoveryMode = installCompactionRecoveryView(session, options.compactionRecovery, acceptedTaskPrompt);
        recoveryCheckpointProjector = createCompactionRecoveryCheckpointProjector(session, options.compactionRecovery);
      }
      if (options.ordinaryProgressRecovery) {
        ordinaryProgressRecoveryMode = installOrdinaryProgressRecoveryView(session, options.ordinaryProgressRecovery, acceptedTaskPrompt);
      }
      const recoveryMode = ordinaryProgressRecoveryMode ?? compactionRecoveryMode;
      if (recoveryMode === "complete") {
        if (ordinaryProgressRecoveryMode) {
          // Recheck original Host authority after backend/setup awaits even without a provider request.
          await options.onTaskContinuationBoundary?.("before_agent_start");
          boundary.assertOpen();
        }
        // Pi's compacted view may end with a complete assistant turn. Calling
        // continue() here is invalid and would risk replaying a side effect.
      } else if (recoveryMode === "continue") {
        await options.onTaskContinuationBoundary?.("before_agent_start");
        boundary.assertOpen();
        await continuePiSession(session);
      } else if (options.approvedToolContinuation) {
        if (!options.preparedInput) {
          throw new Error("Approved tool continuation requires prepared input evidence.");
        }
        const continuation = readApprovedToolContinuation(options.approvedToolContinuation);
        await options.onTaskContinuationBoundary?.("before_agent_start");
        boundary.assertOpen();
        installApprovedToolContinuation(session, options.preparedInput, options.provider, continuation);
        await continuePiSession(session);
      } else {
        await session.prompt(formatTaskPrompt(options.task), { source: "rpc" });
        await session.waitForIdle();
      }
      boundary.assertOpen();
      if (recoveryMode !== "complete" && (!sdkSettlement || sdkSettlement.aborted)) {
        throw new Error("Pi session did not reach a non-aborted SDK settlement");
      }
      const terminalFailure = findTerminalFailure(events);
      if (terminalFailure) {
        throw terminalFailure;
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
        sdkCleanupFailed = true;
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
        ...(failure instanceof PiProviderResponseError && failure.errorDiagnostic
          ? { errorDiagnostic: failure.errorDiagnostic } : {}),
      });
      throw failure;
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      unsubscribe();
      session.dispose();
      if (!sdkCleanupFailed) toolObservation?.finish();
    }
  }

  private registerCustomProviderIfNeeded(modelRuntime: ModelRuntime, provider: PiRunnerProviderConfig): void {
    if (!provider.baseUrl) {
      return;
    }

    const requestAuth = resolvePiProviderRequestAuth(provider);
    const registration = {
      name: provider.displayName ?? provider.provider,
      baseUrl: provider.baseUrl,
      apiKey: requestAuth.registrationApiKey,
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
        headers: requestAuth.requestHeaders(streamOptions?.headers),
        fetch: streamOptions?.fetch ?? fetchProvider,
      }),
    });
  }
}

const MAX_COMPACTION_CONTEXT_SNAPSHOT_BYTES = 512 * 1024;

function captureCompactionContext(messages: readonly unknown[]): readonly unknown[] | undefined {
  try {
    const snapshot = structuredClone(messages);
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_COMPACTION_CONTEXT_SNAPSHOT_BYTES) return undefined;
    return snapshot;
  } catch {
    return undefined;
  }
}

/** Only the latest assistant terminal response decides failure after SDK retries. */
function findTerminalFailure(events: readonly PiRunnerEvent[]): Error | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "run_error") {
      return new PiProviderResponseError(event.message, event.errorDiagnostic);
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "message_end" && event.role === "assistant") {
      if (event.errorMessage) {
        return new PiProviderResponseError(event.errorMessage, event.errorDiagnostic);
      }
      if (event.stopReason?.toLowerCase() === "error") {
        return new PiProviderResponseError("Provider message ended with an error.", event.errorDiagnostic);
      }
      return undefined;
    }
  }
  return undefined;
}

class PiProviderResponseError extends Error {
  constructor(message: string, readonly errorDiagnostic: PiProviderErrorDiagnostic | undefined) {
    super(message);
  }
}

export function createPiRunner(): PiRunnerAdapter {
  return new PiRunnerAdapter();
}
