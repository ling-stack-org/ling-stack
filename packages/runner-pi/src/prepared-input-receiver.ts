import { readPreparedPiInput } from "./prepared-input.js";
import type { PiRunnerPreparedInputReceipt, PiRunnerRunOptions } from "./types.js";
import { throwIfAborted } from "./utils.js";

/** Capture immutable identity before any asynchronous SDK or Host work. No callback during preparation. */
export function createPiPreparedInputReceiver(options: PiRunnerRunOptions) {
  const accept = options.onPreparedInputAccepted;
  if (accept === undefined) return undefined;
  const validId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (typeof accept !== "function" || !options.preparedInput || !validId(options.runId) || !validId(options.runnerAttemptId)) {
    throw new Error("Prepared input receipt requires frozen input and exact Run/Attempt identity");
  }
  const preparedInput = readPreparedPiInput(options.preparedInput);
  if (preparedInput.taskId !== options.task.id) throw new Error("Prepared input receipt task identity mismatch");
  const receipt: PiRunnerPreparedInputReceipt = Object.freeze({ schemaVersion: 1, boundary: "pi-session-ready",
    runId: options.runId, attemptId: options.runnerAttemptId, taskId: preparedInput.taskId,
    preparedInputFingerprint: preparedInput.fingerprint });
  return {
    preparedInput,
    /** Adapter calls only after session validation. The receipt is deliberately not a Run event. */
    async accept(signal: AbortSignal): Promise<void> {
      await waitForHostAcceptance(() => accept(receipt, signal), signal);
      throwIfAborted(signal);
    },
  };
}

/** Observe late rejection without allowing a cancelled receipt wait to resume execution. */
function waitForHostAcceptance(accept: () => void | Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      try { throwIfAborted(signal); } catch (error) { reject(error); }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    // Install rejection handling before invoking a potentially reentrant Host callback.
    void Promise.resolve().then(() => { throwIfAborted(signal); return accept(); }).then(
      () => { signal.removeEventListener("abort", onAbort); resolve(); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
