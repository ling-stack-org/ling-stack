import type {
  ComputerUsePipRendererSnapshot,
  LingComputerUsePreviewCapabilities,
} from "../../shared/desktop-capabilities.js";
import { subscribeWithInitialRead } from "../../shared/initial-state-subscription.js";
import type {
  ComputerUsePreviewActionId,
  ComputerUsePreviewOpenCommandState,
  ComputerUsePreviewStopCommandState,
} from "./preview-view-model.js";

const RENDERER_COMMAND_TIMEOUT_MS = 10_000;

export interface ComputerUsePreviewControllerState {
  readonly snapshot: ComputerUsePipRendererSnapshot;
  readonly openCommandState: ComputerUsePreviewOpenCommandState;
  readonly stopCommandState: ComputerUsePreviewStopCommandState;
}

export interface ComputerUsePreviewController {
  dispose(): void;
  getState(): ComputerUsePreviewControllerState;
  invokeAction(action: ComputerUsePreviewActionId): Promise<void>;
  reportInteraction(kind: "hover" | "focus", active: boolean): void;
  start(): void;
  subscribe(listener: () => void): () => void;
}

export function createComputerUsePreviewController(input: {
  readonly capabilities: LingComputerUsePreviewCapabilities | undefined;
  readonly fallbackSnapshot: ComputerUsePipRendererSnapshot;
}): ComputerUsePreviewController {
  let state: ComputerUsePreviewControllerState = {
    snapshot: input.fallbackSnapshot,
    openCommandState: "idle",
    stopCommandState: "idle",
  };
  let openRequestSequence = 0;
  let stopRequestSequence = 0;
  let stopConvergenceTimeoutId: number | undefined;
  let unsubscribeSnapshot: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const interactionState = { hover: false, focus: false };

  const emit = (nextState: ComputerUsePreviewControllerState): void => {
    state = nextState;
    listeners.forEach((listener) => listener());
  };

  const setStopCommandState = (stopCommandState: ComputerUsePreviewStopCommandState): void => {
    if (state.stopCommandState === stopCommandState) {
      return;
    }
    emit({ ...state, stopCommandState });
  };

  const setOpenCommandState = (openCommandState: ComputerUsePreviewOpenCommandState): void => {
    if (state.openCommandState === openCommandState) {
      return;
    }
    emit({ ...state, openCommandState });
  };

  const clearStopConvergenceTimeout = (): void => {
    if (stopConvergenceTimeoutId !== undefined) {
      window.clearTimeout(stopConvergenceTimeoutId);
      stopConvergenceTimeoutId = undefined;
    }
  };

  const resetStopCommandState = (invalidateRequest: boolean): void => {
    clearStopConvergenceTimeout();
    if (invalidateRequest) {
      stopRequestSequence += 1;
    }
    if (state.stopCommandState !== "idle") {
      emit({ ...state, stopCommandState: "idle" });
    }
  };

  const applySnapshot = (next: ComputerUsePipRendererSnapshot | undefined): void => {
    const nextSnapshot = next ?? input.fallbackSnapshot;
    const sessionChanged = nextSnapshot.sessionId !== state.snapshot.sessionId;
    const terminalOrStopping =
      nextSnapshot.runtimeStatus === "stopping" ||
      nextSnapshot.runtimeStatus === "succeeded" ||
      nextSnapshot.runtimeStatus === "failed" ||
      nextSnapshot.runtimeStatus === "cancelled";
    if (sessionChanged || terminalOrStopping) {
      clearStopConvergenceTimeout();
      stopRequestSequence += 1;
      openRequestSequence += 1;
      emit({ snapshot: nextSnapshot, openCommandState: "idle", stopCommandState: "idle" });
      return;
    }
    emit({ ...state, snapshot: nextSnapshot });
  };

  const startStopConvergenceTimeout = (requestSequence: number, sessionId: string): void => {
    clearStopConvergenceTimeout();
    stopConvergenceTimeoutId = window.setTimeout(() => {
      stopConvergenceTimeoutId = undefined;
      if (
        requestSequence !== stopRequestSequence ||
        state.snapshot.sessionId !== sessionId ||
        state.stopCommandState !== "pending"
      ) {
        return;
      }
      setStopCommandState("failed");
    }, RENDERER_COMMAND_TIMEOUT_MS);
  };

  const requestStop = async (capabilities: LingComputerUsePreviewCapabilities): Promise<void> => {
    if (state.stopCommandState === "pending") {
      return;
    }
    const sessionId = state.snapshot.sessionId;
    const requestSequence = ++stopRequestSequence;
    setStopCommandState("pending");
    try {
      const result = await waitForRendererCommand(capabilities.requestStop());
      if (requestSequence !== stopRequestSequence || state.snapshot.sessionId !== sessionId) {
        return;
      }
      if (!result.accepted) {
        setStopCommandState("failed");
        return;
      }
      startStopConvergenceTimeout(requestSequence, sessionId);
    } catch {
      if (requestSequence !== stopRequestSequence || state.snapshot.sessionId !== sessionId) {
        return;
      }
      setStopCommandState("failed");
    }
  };

  const requestOpenOwner = async (capabilities: LingComputerUsePreviewCapabilities): Promise<void> => {
    if (state.openCommandState === "pending") {
      return;
    }
    const sessionId = state.snapshot.sessionId;
    const requestSequence = ++openRequestSequence;
    setOpenCommandState("pending");
    try {
      const result = await waitForRendererCommand(capabilities.openOwnerConversation());
      if (requestSequence !== openRequestSequence || state.snapshot.sessionId !== sessionId) {
        return;
      }
      setOpenCommandState(result.accepted ? "idle" : "failed");
    } catch {
      if (requestSequence !== openRequestSequence || state.snapshot.sessionId !== sessionId) {
        return;
      }
      setOpenCommandState("failed");
    }
  };

  const invokeAction = async (action: ComputerUsePreviewActionId): Promise<void> => {
    const capabilities = input.capabilities;
    if (!capabilities) {
      return;
    }
    if (action === "open") {
      await requestOpenOwner(capabilities);
    } else if (action === "reset") {
      await waitForRendererCommand(capabilities.resetPosition());
    } else if (action === "settings") {
      await waitForRendererCommand(capabilities.openScreenPermissionSettings());
    } else if (action === "retry") {
      await waitForRendererCommand(capabilities.retryCapture());
    } else if (action === "hide") {
      await waitForRendererCommand(capabilities.hide());
    } else if (action === "close") {
      await waitForRendererCommand(capabilities.close());
    } else if (action === "stop") {
      await requestStop(capabilities);
    }
  };

  return {
    dispose: () => {
      unsubscribeSnapshot?.();
      unsubscribeSnapshot = undefined;
      openRequestSequence += 1;
      resetStopCommandState(true);
      listeners.clear();
    },
    getState: () => state,
    invokeAction,
    reportInteraction: (kind, active) => {
      if (interactionState[kind] === active) {
        return;
      }
      interactionState[kind] = active;
      input.capabilities?.reportInteraction({ kind, active });
    },
    start: () => {
      if (unsubscribeSnapshot || !input.capabilities) {
        return;
      }
      unsubscribeSnapshot = subscribeWithInitialRead({
        read: () => input.capabilities!.getSnapshot(),
        subscribe: (listener) => input.capabilities!.onSnapshotChanged(listener),
        onValue: applySnapshot,
      });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function waitForRendererCommand<T>(command: Promise<T>): Promise<T> {
  let timeoutId: number | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timeoutId = window.setTimeout(
        () => reject(new Error("computer_use_renderer_command_timeout")),
        RENDERER_COMMAND_TIMEOUT_MS,
      );
      command.then(resolve, reject);
    });
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}
