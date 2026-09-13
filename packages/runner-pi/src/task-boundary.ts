import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiRunnerRunOptions, PiRunnerUserInputYieldDirective } from "./types.js";
import { readUserInputYieldDirective } from "./task-yield.js";
import { throwIfAborted } from "./utils.js";
import { assertPreparedPiModelContext } from "./prepared-input.js";
import { assertApprovedToolContinuationModelContext } from "./approved-tool-continuation.js";
import { applyReasoningSummaryModeToPayload } from "./reasoning-summary.js";

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
export function createPiTaskBoundary(options: PiRunnerRunOptions) {
  const stop = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  let failure: Error | undefined;
  let yieldRequest: PiRunnerUserInputYieldDirective | undefined;
  const pendingYield = new PendingUserInputYield();
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
    ...(options.onTaskContinuationBoundary ? {
      onTaskContinuationBoundary: async (boundary) => {
        try {
          assertOpen();
          const directive = await options.onTaskContinuationBoundary?.(boundary);
          assertOpen();
          if (directive !== undefined) {
            yieldRequest = readUserInputYieldDirective(directive);
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
  };

  return {
    options: guardedOptions,
    assertOpen,
    get failure(): Error | undefined { return failure; },
    get yieldRequest(): PiRunnerUserInputYieldDirective | undefined { return yieldRequest; },
    /** Guard this run's runtime, including built-in and custom providers. */
    bindModelRuntime(runtime: ModelRuntime): void {
      const streamSimple = runtime.streamSimple.bind(runtime);
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
              assertPreparedPiModelContext(options.preparedInput!, model, context);
            }
          }
          catch (error) {
            failure ??= error instanceof Error ? error : new Error("Invalid Pi prepared input");
            stop.abort(failure);
            throw failure;
          }
        } : undefined;
        verifyInitialInput?.();
        firstRequest = false;
        return streamSimple(model, context, {
          ...streamOptions,
          signal: streamOptions?.signal ? AbortSignal.any([signal, streamOptions.signal]) : signal,
          onPayload: async (payload, requestModel) => {
            assertOpen();
            const next = await streamOptions?.onPayload?.(payload, requestModel);
            // The awaited SDK hook may have swallowed the Host failure. Never
            // let the provider send a prepared payload after that rejection.
            assertOpen();
            verifyInitialInput?.();
            const candidate = next ?? payload;
            const summaryPayload = applyReasoningSummaryModeToPayload(candidate, requestModel.api, options.reasoningSummary);
            return summaryPayload ?? next;
          },
        });
      };
    },
  };
}
