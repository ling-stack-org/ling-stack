import type { DelegationRuntimeRegistry } from "../features/harness/delegations/runtime-registry.js";
import type { ActiveRunRegistry, ActiveRunSuspensionRequest } from "./active-runs.js";
import { runSuspensionOrderFor } from "./run-suspension-order.js";
import type { MediaLocalExecutionRegistry } from "./media-local-executions.js";

/** One Host shutdown shared by every lifecycle domain; never aborts a sealed tree. */
export function createRunShutdownCoordinator(input: {
  readonly activeRuns: ActiveRunRegistry;
  readonly delegations: Pick<DelegationRuntimeRegistry, "stopAdmission" | "settle">;
  readonly mediaExecutions?: Pick<MediaLocalExecutionRegistry, "stopAdmission" | "abortOwned" | "waitForIdle">;
}) {
  let work: Promise<void> | undefined;
  const drain = async (cause: ActiveRunSuspensionRequest["cause"]): Promise<void> => {
    const failures: unknown[] = [];
    const attempt = async (action: () => void | Promise<void>): Promise<void> => {
      try { await action(); } catch (error) { failures.push(error); }
    };
    // This port is synchronous: do not leave a microtask gap before latching
    // ActiveRuns admission and asking the exact registered sources.
    try { input.delegations.stopAdmission(); } catch (error) { failures.push(error); }
    try { input.mediaExecutions?.stopAdmission(); } catch (error) { failures.push(error); }
    const requests = attempt(() => input.activeRuns.requestGracefulSuspension(cause));
    // Captured media callbacks hold parent local writers. Signal their local
    // transport now, not after waiting for the parent that needs them to drain.
    // This is neither remote cancellation nor evidence of physical settlement.
    try { input.mediaExecutions?.abortOwned(); } catch (error) { failures.push(error); }
    await requests;
    // These are the original entire executor/preflight lifetimes. Registry
    // removal or a fulfilled request alone cannot authorize resource close.
    await Promise.all([
      attempt(() => input.activeRuns.waitForIdle()),
      attempt(() => input.delegations.settle()),
      attempt(() => input.mediaExecutions?.waitForIdle() ?? Promise.resolve()),
    ]);
    // Preflight can register a late source while the first barrier is pending.
    await attempt(() => input.activeRuns.waitForGracefulSuspensionRequests());
    await attempt(() => runSuspensionOrderFor(input.activeRuns).waitForAllFinished());
    await attempt(() => input.activeRuns.verifyTerminalShutdownHandoffs());
    if (failures.length) throw new AggregateError(failures, "runtime_shutdown_unverified");
  };
  return Object.freeze({
    shutdown(cause: ActiveRunSuspensionRequest["cause"]): Promise<void> {
      if (work) return work;
      let resolve!: () => void, reject!: (error: unknown) => void;
      work = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      // Install single-flight before any original Host callback can re-enter.
      void drain(cause).then(resolve, reject);
      void work.catch(() => undefined);
      return work;
    },
  });
}
