import type { HostFileMutationOperation } from "../../runtime/host-operation-effects.js";
import type { AttemptHostOperationTracker } from "../../runtime/attempt-host-operation-tracker.js";

export interface FileMutationAdmission {
  readonly operation: HostFileMutationOperation;
  /** Settle from Host effect entry and Core receipts, never from SDK text/results. */
  settle(): void;
}

/**
 * Reserve synchronously at the approval callback, before queueing or waiting.
 * The entered-effect latch lives inside the actual guarded callback: a rejected
 * gate is no-start, but a write followed by an observer/COMMIT failure is not.
 */
export function reserveFileMutationAdmission(
  tracker: AttemptHostOperationTracker,
  toolCallId: string,
): FileMutationAdmission {
  const handle = tracker.beginHostCall("file_mutation", toolCallId);
  const guarded = tracker.fileMutationOperation(handle);
  let effectEntered = false;
  let settlementAttempted = false;
  return Object.freeze({
    operation: Object.freeze({
      assertMayPrepare: () => guarded.assertMayPrepare(),
      bindHarnessExecution: (executionId: string) => guarded.bindHarnessExecution(executionId),
      effectGuard: Object.freeze({
        launch: <T>(effect: () => T): T => guarded.effectGuard.launch(() => {
          effectEntered = true;
          return effect();
        }),
        cleanup: <T>(effect: () => T): T => guarded.effectGuard.cleanup(effect),
      }),
    }),
    settle: (): void => {
      if (settlementAttempted) return;
      settlementAttempted = true;
      try {
        if (effectEntered) tracker.settleFileFromStore(handle);
        else tracker.settleNoStart(handle);
      } catch (error) {
        // Keep the original failure. markUnknown latches the in-memory blocker
        // even if the exact durable unknown write itself is unavailable.
        try { tracker.markUnknown(handle, "file_mutation_execution_unconfirmed"); } catch { /* fail closed */ }
        throw error;
      }
    },
  });
}
