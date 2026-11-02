import { DesktopDaemonLifecycleError } from "./daemon-lifecycle.js";

export interface DesktopExitLifecycleOptions {
  readonly shutdown: () => Promise<void>;
  readonly quit: () => void;
  readonly exit: (exitCode: number) => void;
  readonly onShutdownError?: (error: unknown) => void;
}

export interface DesktopExitLifecycle {
  requestExit(exitCode?: number): Promise<void>;
  isCleanupComplete(): boolean;
  isExitRequested(): boolean;
}

export interface DesktopStartupOpenAttempt {
  isCurrent(): boolean;
  requestExit(exitCode?: number): void;
}

export interface DesktopStartupOpenCoordinatorOptions {
  readonly requestExit: (exitCode: number) => void;
}

export interface DesktopStartupOpenCoordinator {
  run(
    open: (attempt: DesktopStartupOpenAttempt) => Promise<boolean>,
  ): Promise<boolean>;
  stopAcceptingAndWait(): Promise<void>;
}

/**
 * Shares concurrent main-window opens and gives shutdown a synchronous
 * invalidation point before it starts releasing process-owned resources.
 * Exit requests raised inside an open are deferred until that open has
 * settled, so shutdown can never wait on the operation that requested it.
 */
export function createDesktopStartupOpenCoordinator(
  options: DesktopStartupOpenCoordinatorOptions,
): DesktopStartupOpenCoordinator {
  let accepting = true;
  let generation = 0;
  let activeOpen: Promise<boolean> | undefined;

  return {
    run(open) {
      if (!accepting) {
        return Promise.resolve(false);
      }
      if (activeOpen) {
        return activeOpen;
      }

      const openGeneration = generation;
      let deferredExitRequested = false;
      let deferredExitCode = 0;
      const attempt: DesktopStartupOpenAttempt = {
        isCurrent: () => accepting && generation === openGeneration,
        requestExit: (exitCode = 0) => {
          if (!attempt.isCurrent()) {
            return;
          }
          deferredExitRequested = true;
          deferredExitCode = mergeExitCode(deferredExitCode, exitCode);
          accepting = false;
          generation += 1;
        },
      };
      const pending = Promise.resolve().then(async () => {
        try {
          const opened = await open(attempt);
          return attempt.isCurrent() ? opened : false;
        } catch (error) {
          if (!attempt.isCurrent()) {
            return false;
          }
          throw error;
        }
      });
      const tracked = pending.finally(() => {
        if (activeOpen === tracked) {
          activeOpen = undefined;
        }
        if (deferredExitRequested) {
          options.requestExit(deferredExitCode);
        }
      });
      activeOpen = tracked;
      return tracked;
    },
    stopAcceptingAndWait() {
      if (accepting) {
        accepting = false;
        generation += 1;
      }
      const pending = activeOpen;
      return pending
        ? pending.then(
            () => undefined,
            () => undefined,
          )
        : Promise.resolve();
    },
  };
}

/**
 * Serializes every primary-process exit through one awaited shutdown. Normal
 * exits retain Electron's ordinary quit lifecycle; failure exits use the
 * requested process code only after owned resources have been released.
 */
export function createDesktopExitLifecycle(
  options: DesktopExitLifecycleOptions,
): DesktopExitLifecycle {
  let requestedExitCode = 0;
  let exitPromise: Promise<void> | undefined;
  let cleanupComplete = false;

  const requestExit = (exitCode = 0): Promise<void> => {
    requestedExitCode = mergeExitCode(requestedExitCode, exitCode);
    // Install the single flight before shutdown or diagnostic callbacks can
    // synchronously request exit again.
    exitPromise ??= Promise.resolve().then(async () => {
      try {
        await options.shutdown();
      } catch (error) {
        const retainedHost = error instanceof DesktopDaemonLifecycleError
          && (error.code === "stop_blocked" || error.code === "stop_unconfirmed");
        try {
          options.onShutdownError?.(error);
        } catch {
          // Diagnostics cannot authorize exit or change the Host stop result.
        }
        if (retainedHost) {
          // A finite observation failure is not a permanent stopped verdict.
          // A later explicit quit may recheck the same original Host; this
          // does not itself retry, release resources or start a successor.
          exitPromise = undefined;
          requestedExitCode = 0;
          return;
        }
        requestedExitCode = mergeExitCode(requestedExitCode, 1);
      }
      cleanupComplete = true;
      if (requestedExitCode === 0) {
        options.quit();
      } else {
        options.exit(requestedExitCode);
      }
    });
    return exitPromise;
  };

  return {
    requestExit,
    isCleanupComplete: () => cleanupComplete,
    isExitRequested: () => exitPromise !== undefined,
  };
}

export async function runDesktopStartup(input: {
  readonly start: () => Promise<void>;
  readonly requestExit: (exitCode: number) => Promise<void>;
  readonly onStartupError: (error: unknown) => void;
}): Promise<void> {
  try {
    await input.start();
  } catch (error) {
    try {
      input.onStartupError(error);
    } catch {
      // Startup diagnostics are best effort; owned resources still must stop.
    }
    await input.requestExit(1);
  }
}

function mergeExitCode(current: number, requested: number): number {
  if (current !== 0) {
    return current;
  }
  return Number.isSafeInteger(requested) && requested >= 0 && requested <= 255
    ? requested
    : 1;
}
