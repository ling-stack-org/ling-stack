import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiRunnerProviderInvocationContextBudget, PiRunnerRunOptions, PiRunnerUserInputYieldDirective } from "./types.js";
import { readUserInputYieldDirective } from "./task-yield.js";
import { readUserInputRequestReceipt, readUserInputWaitMode } from "./user-input-request.js";
import { throwIfAborted } from "./utils.js";
import { assertPiModelContextCapacity, assertPreparedPiModelContext, estimatePiModelContextBudget, type PiRunnerPreparedInput } from "./prepared-input.js";
import { assertApprovedToolContinuationModelContext } from "./approved-tool-continuation.js";
import { applyReasoningSummaryModeToPayload } from "./reasoning-summary.js";
import { assertAcceptedTaskAnchor, hasCompactionSummary } from "./compaction-task-anchor.js";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { piTranscript } from "./session-transcript.js";
import { assertCompactionRecoveryModelContext } from "./compaction-recovery.js";
import { assertOrdinaryProgressRecoveryModelContext } from "./ordinary-progress-recovery.js";
import { bindPiProviderInvocationResolution, createPiProviderInvocation } from "./provider-invocation.js";
import { bindPiProviderBudgetResolution, createPiProviderBudgetInvocation } from "./provider-budget.js";
import { readDelegationInstructionDirective } from "./delegation-instruction.js";

/** Internal latch only. The public yielded outcome requires an idle SDK first. */
class PendingUserInputYield extends Error {
  constructor() { super("Required user input closes execution admission."); }
}

/**
 * Stop both SDK control paths, including compaction-owned retry timers. A closed
 * model signal alone cannot prevent an uncooperative summary from being installed.
 * Register the shared promise before invoking SDK callbacks; resolve only after
 * abort() proves SDK idle, and never turn a cleanup rejection into success.
 */
export function createPiSessionStopper(session: Pick<AgentSession, "abortCompaction" | "abort">): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () => {
    if (stopping) return stopping;
    let resolveStop!: () => void;
    let rejectStop!: (error: unknown) => void;
    stopping = new Promise<void>((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
    // Keep immediate cancellation semantics while making synchronous reentry idempotent.
    void (async () => {
      try {
        session.abortCompaction();
      } finally {
        await session.abort();
      }
    })().then(resolveStop, rejectStop);
    return stopping;
  };
}

/**
 * Own cancellation outside SDK extension callbacks: Pi reports some callback
 * exceptions as diagnostics and continues. This per-run latch closes model
 * admission even when that happens; it is not a durable pause/checkpoint.
 */
export function createPiTaskBoundary(options: PiRunnerRunOptions, readTaskContext?: () => {
  readonly systemPrompt: string;
  readonly messages: readonly unknown[];
  readonly acceptedTaskPrompt: string;
  readonly sessionId: string;
  readonly preparedInput: PiRunnerPreparedInput;
} | undefined) {
  const stop = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  let failure: Error | undefined;
  let yieldRequest: PiRunnerUserInputYieldDirective | undefined;
  const delegationInstructions = new Map<string, string>();
  const pendingYield = new PendingUserInputYield();
  const latchFailure = (error: unknown): never => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    stop.abort(failure);
    throw failure;
  };
  const withoutLiveDelegationInstructions = (context: Parameters<typeof piTranscript>[0]) => {
    if (!delegationInstructions.size) return context;
    const transcript = piTranscript(context);
    return { messages: transcript.messages.filter(message => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return true;
      const identity = Object.getOwnPropertyDescriptor(message, "delegationInstruction")?.value;
      const id = identity && typeof identity === "object" && !Array.isArray(identity)
        ? Object.getOwnPropertyDescriptor(identity, "messageId")?.value : undefined;
      return typeof id !== "string" || delegationInstructions.get(id) !== JSON.stringify(message);
    }) };
  };
  const assertOpen = (): void => {
    throwIfAborted(options.signal);
    if (failure) throw failure;
    if (yieldRequest) throw pendingYield;
    throwIfAborted(signal);
  };
  // Pi may prepare an entire parallel batch before executing any member.
  // Every actual Host dispatch must recheck admission, not only preparation.
  const guard = <Args extends unknown[], Result>(callback: (...args: Args) => Result) =>
    (...args: Args): Result => { assertOpen(); return callback(...args); };
  const guardedOptions: PiRunnerRunOptions = {
    ...options,
    signal,
    ...(options.onToolBefore ? { onToolBefore: guard(options.onToolBefore) } : {}),
    ...(options.onApprovalRequired ? { onApprovalRequired: guard(options.onApprovalRequired) } : {}),
    ...(options.onPermissionRequired ? { onPermissionRequired: guard(options.onPermissionRequired) } : {}),
    ...(options.onToolHydrationRequest ? { onToolHydrationRequest: guard(options.onToolHydrationRequest) } : {}),
    ...(options.onMcpToolCall ? { onMcpToolCall: guard(options.onMcpToolCall) } : {}),
    ...(options.onHostCapabilityCall ? { onHostCapabilityCall: guard(options.onHostCapabilityCall) } : {}),
    ...(options.onMediaGenerationToolCall ? { onMediaGenerationToolCall: guard(options.onMediaGenerationToolCall) } : {}),
    ...(options.onDelegationToolCall ? { onDelegationToolCall: async request => {
      try {
        assertOpen();
        const receipt = await options.onDelegationToolCall!(request);
        // Abort/required-input closes admission even when a Host callback settles late.
        assertOpen();
        return receipt;
      } catch (error) {
        // Expected refusals are structured receipts. An unexpected Host error
        // may follow a durable mutation and must not become SDK retry narration.
        if (!options.signal?.aborted && error !== pendingYield) {
          failure ??= error instanceof Error ? error : new Error("Delegation Host request failed.");
          stop.abort(failure);
        }
        throw error;
      }
    } } : {}),
    ...(options.onUserInputRequest ? {
      onUserInputRequest: async (request) => {
        try {
          assertOpen();
          const mode = readUserInputWaitMode(request.input);
          const receipt = await options.onUserInputRequest!(request);
          // Cancellation/current latch wins over a callback arriving late.
          assertOpen();
          const accepted = readUserInputRequestReceipt(receipt, mode);
          if (accepted.kind === "user_input_required") {
            yieldRequest = accepted;
            stop.abort(pendingYield);
          }
          return accepted;
        } catch (error) {
          if (!options.signal?.aborted && error !== pendingYield) {
            failure ??= error instanceof Error ? error : new Error("User input Host request failed.");
            stop.abort(failure);
          }
          throw error;
        }
      },
    } : {}),
    ...(options.onTaskContinuationBoundary ? {
      onTaskContinuationBoundary: async (boundary, modelView) => {
        try {
          assertOpen();
          const raw = await options.onTaskContinuationBoundary?.(boundary, modelView);
          assertOpen();
          if (raw !== undefined && directiveKind(raw) === "delegation_instructions") {
            if (boundary !== "before_provider_request") throw new Error("Delegation instructions require a provider boundary.");
            const directive = readDelegationInstructionDirective(raw);
            for (const message of directive.messages) {
              const id = message.delegationInstruction.messageId;
              const serialized = JSON.stringify(message);
              const previous = delegationInstructions.get(id);
              if (previous !== undefined && previous !== serialized) {
                throw new Error("Delegation instruction identity changed before provider dispatch.");
              }
              delegationInstructions.set(id, serialized);
            }
            return directive;
          }
          if (raw !== undefined) {
            yieldRequest = readUserInputYieldDirective(raw);
            stop.abort(pendingYield);
            throw pendingYield;
          }
        } catch (error) {
          // Explicit user cancellation keeps its AbortError semantics. A Host
          // boundary failure must survive the SDK's error-and-continue hooks.
          if (!options.signal?.aborted && error !== pendingYield) {
            failure ??= error instanceof Error ? error : new Error(String(error));
            stop.abort(failure);
          }
          throw error;
        }
      },
    } : {}),
    onTaskContinuationDirectiveFailure: latchFailure,
  };

  return {
    options: guardedOptions,
    assertOpen,
    get failure(): Error | undefined { return failure; },
    get yieldRequest(): PiRunnerUserInputYieldDirective | undefined { return yieldRequest; },
    /** Guard this run's runtime, including built-in and custom providers. */
    bindModelRuntime(runtime: ModelRuntime): void {
      const streamSimple = runtime.streamSimple.bind(runtime);
      const associateInvocation = bindPiProviderInvocationResolution(runtime, options);
      const associateBudget = bindPiProviderBudgetResolution(runtime, options);
      let firstRequest = true;
      runtime.streamSimple = (model, context, streamOptions) => {
        assertOpen();
        const verifyInitialInput = firstRequest && options.preparedInput ? () => {
          try {
            if (options.approvedToolContinuation) {
              assertApprovedToolContinuationModelContext(
                options.preparedInput!,
                options.provider,
                options.approvedToolContinuation,
                model,
                context,
              );
            } else {
              assertPreparedPiModelContext(options.preparedInput!, model, withoutLiveDelegationInstructions(context), {
                allowRestoredMessages: Boolean(options.compactionRecovery || options.ordinaryProgressRecovery),
              });
            }
            if (options.compactionRecovery) assertCompactionRecoveryModelContext(options.compactionRecovery, context);
            if (options.ordinaryProgressRecovery) assertOrdinaryProgressRecoveryModelContext(options.ordinaryProgressRecovery, context);
          }
          catch (error) {
            failure ??= error instanceof Error ? error : new Error("Invalid Pi prepared input");
            stop.abort(failure);
            throw failure;
          }
        } : undefined;
        verifyInitialInput?.();
        let modelContext: typeof context;
        try {
          const taskContext = readTaskContext?.();
          if (taskContext && taskContext.sessionId !== undefined && streamOptions?.sessionId === taskContext.sessionId) {
            assertPreparedPiModelContext(taskContext.preparedInput, model, context, { allowRestoredMessages: true });
            if (firstRequest && options.compactionRecovery) assertCompactionRecoveryModelContext(options.compactionRecovery, context);
            if (firstRequest && options.ordinaryProgressRecovery) assertOrdinaryProgressRecoveryModelContext(options.ordinaryProgressRecovery, context);
          }
          if (taskContext && getCurrentSystemPrompt(piTranscript(context).messages) === taskContext.systemPrompt && hasCompactionSummary(taskContext.messages)) {
            assertAcceptedTaskAnchor(context.messages, taskContext.acceptedTaskPrompt);
          }
          modelContext = assertPiModelContextCapacity(model, context);
          if (firstRequest && options.ordinaryProgressRecovery) {
            // No lossy extra capacity projection may silently change the committed ordinary view.
            assertOrdinaryProgressRecoveryModelContext(options.ordinaryProgressRecovery, modelContext);
          }
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error("Pi model context capacity check failed");
          stop.abort(failure);
          throw failure;
        }
        // The provider receives a projected copy. A late payload hook must
        // not be able to mutate that copy after prepared-input validation.
        const dispatchedContext = JSON.stringify(modelContext);
        firstRequest = false;
        let contextBudget: PiRunnerProviderInvocationContextBudget | undefined;
        if (options.onProviderInvocationAdmitted || options.onProviderInvocationSettled) {
          try { contextBudget = estimatePiModelContextBudget(model, modelContext); }
          catch { /* Diagnostic evidence is optional; do not introduce another model-call gate. */ }
        }
        const invocation = createPiProviderInvocation(options, () =>
          options.signal?.aborted || streamOptions?.signal?.aborted ? "cancelled"
            : failure || yieldRequest || stop.signal.aborted ? "local_rejected" : undefined, contextBudget);
        const budget = createPiProviderBudgetInvocation(options, () =>
          options.signal?.aborted || streamOptions?.signal?.aborted ? "cancelled"
            : failure || yieldRequest || stop.signal.aborted ? "local_rejected" : undefined, error => {
          failure ??= error instanceof Error ? error : new Error("Provider budget authority failed");
          stop.abort(failure);
        });
        const observeLocalCallbackFailure = <Args extends unknown[]>(callback: (...args: Args) => void | Promise<void>) =>
          async (...args: Args): Promise<void> => {
            try { await callback(...args); }
            catch (error) { invocation.rejectLocally(); throw error; }
          };
        const onPayload: NonNullable<NonNullable<typeof streamOptions>["onPayload"]> = async (payload, requestModel) => {
          try {
            assertOpen();
            const next = await streamOptions?.onPayload?.(payload, requestModel);
            // The awaited SDK hook may have swallowed the Host failure. Never
            // let the provider send a prepared payload after that rejection.
            assertOpen();
            verifyInitialInput?.();
            if (JSON.stringify(modelContext) !== dispatchedContext) {
              failure ??= new Error("Pi prepared input changed after model context projection");
              stop.abort(failure);
              throw failure;
            }
            const candidate = next ?? payload;
            const summaryPayload = applyReasoningSummaryModeToPayload(candidate, requestModel.api, options.reasoningSummary);
            const reservedPayload = budget.authorize(summaryPayload ?? candidate, requestModel);
            // This wrapper also covers SDK summary streams without an Agent
            // extension hook. It observes logical admission, not network I/O.
            invocation.admit(requestModel);
            return options.providerBudget ? reservedPayload : summaryPayload ?? next;
          } catch (error) {
            invocation.rejectLocally();
            throw error;
          }
        };
        associateInvocation(onPayload, invocation);
        associateBudget(onPayload, budget);
        const requestStream = streamSimple(model, modelContext, {
          ...streamOptions,
          ...(streamOptions?.onResponse ? { onResponse: observeLocalCallbackFailure(streamOptions.onResponse) } : {}),
          ...(streamOptions?.onProviderStreamEvent
            ? { onProviderStreamEvent: observeLocalCallbackFailure(streamOptions.onProviderStreamEvent) } : {}),
          signal: streamOptions?.signal ? AbortSignal.any([signal, streamOptions.signal]) : signal,
          onPayload,
        });
        const guardedStream = budget.guardResult(requestStream);
        invocation.observe(guardedStream);
        return guardedStream;
      };
    },
  };
}

function directiveKind(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
