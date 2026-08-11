import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useI18n } from "../i18n.js";
import { CurrentSessionHeaderCapabilityPortal } from "../shared/current-session/CurrentSessionHeaderCapability.js";
import {
  DesktopComputerUseControlSlot,
  type DesktopComputerUseCommandFailureKind as CommandFailureKind,
  type DesktopComputerUseControlSummary as ComputerUseSummary,
  type DesktopComputerUseVisibilityAction as VisibilityAction,
} from "./DesktopComputerUseControlSlot.js";
import { useDesktopComputerUseHostLayoutReporter } from "./use-desktop-computer-use-host-layout-reporter.js";

const DESKTOP_COMMAND_TIMEOUT_MS = 10_000;
const DESKTOP_STOP_CONVERGENCE_TIMEOUT_MS = 10_000;
const DESKTOP_VISIBILITY_CONVERGENCE_TIMEOUT_MS = 10_000;

type DesktopCommandResult = Awaited<ReturnType<NonNullable<Window["lingDesktop"]>["computerUse"]["stop"]>>;

type StopRequestState =
  | {
      readonly requestId: number;
      readonly sessionId: string;
      readonly status: "pending";
    }
  | {
      readonly requestId: number;
      readonly sessionId: string;
      readonly status: "failed";
      readonly failureKind: CommandFailureKind;
    };

type VisibilityRequestState =
  | {
      readonly requestId: number;
      readonly sessionId: string;
      readonly action: VisibilityAction;
      readonly status: "pending";
    }
  | {
      readonly requestId: number;
      readonly sessionId: string;
      readonly action: VisibilityAction;
      readonly status: "failed";
      readonly failureKind: CommandFailureKind;
    };

interface PendingStopRequest {
  readonly requestId: number;
  readonly sessionId: string;
  readonly conversationId: string;
}

interface PendingVisibilityRequest extends PendingStopRequest {
  readonly action: VisibilityAction;
  readonly targetVisible: boolean;
}

export function DesktopComputerUseBridge({
  selectedConversationId,
  surfaceKind,
  hostRef,
}: {
  readonly selectedConversationId?: string;
  readonly surfaceKind?: "channel" | "normal_conversation" | "teammate_direct";
  readonly hostRef: RefObject<HTMLElement | null>;
}) {
  const { locale } = useI18n();
  const capabilities = window.lingDesktop?.computerUse;
  const [summary, setSummary] = useState<ComputerUseSummary | undefined>();
  const [stopRequest, setStopRequest] = useState<StopRequestState | undefined>();
  const [visibilityRequest, setVisibilityRequest] = useState<VisibilityRequestState | undefined>();
  const stopRequestSequenceRef = useRef(0);
  const pendingStopRequestRef = useRef<PendingStopRequest | undefined>(undefined);
  const stopConvergenceTimeoutIdRef = useRef<number | undefined>(undefined);
  const visibilityRequestSequenceRef = useRef(0);
  const pendingVisibilityRequestRef = useRef<PendingVisibilityRequest | undefined>(undefined);
  const visibilityConvergenceTimeoutIdRef = useRef<number | undefined>(undefined);
  const activeSummarySessionIdRef = useRef<string | undefined>(undefined);
  const selectedConversationIdRef = useRef(selectedConversationId);
  selectedConversationIdRef.current = selectedConversationId;

  const clearStopConvergenceTimeout = useCallback((): void => {
    if (stopConvergenceTimeoutIdRef.current !== undefined) {
      window.clearTimeout(stopConvergenceTimeoutIdRef.current);
      stopConvergenceTimeoutIdRef.current = undefined;
    }
  }, []);

  const invalidateStopRequest = useCallback((): void => {
    clearStopConvergenceTimeout();
    stopRequestSequenceRef.current += 1;
    pendingStopRequestRef.current = undefined;
    setStopRequest(undefined);
  }, [clearStopConvergenceTimeout]);

  const clearVisibilityConvergenceTimeout = useCallback((): void => {
    if (visibilityConvergenceTimeoutIdRef.current !== undefined) {
      window.clearTimeout(visibilityConvergenceTimeoutIdRef.current);
      visibilityConvergenceTimeoutIdRef.current = undefined;
    }
  }, []);

  const invalidateVisibilityRequest = useCallback((): void => {
    clearVisibilityConvergenceTimeout();
    visibilityRequestSequenceRef.current += 1;
    pendingVisibilityRequestRef.current = undefined;
    setVisibilityRequest(undefined);
  }, [clearVisibilityConvergenceTimeout]);

  useEffect(() => {
    capabilities?.reportLocale(locale);
  }, [capabilities, locale]);

  useEffect(() => {
    capabilities?.reportSelectedDeckOwner(selectedConversationId && surfaceKind
      ? { surfaceKind, ownerId: selectedConversationId }
      : undefined);
  }, [capabilities, selectedConversationId, surfaceKind]);

  useEffect(() => {
    return () => capabilities?.reportSelectedDeckOwner(undefined);
  }, [capabilities]);

  useEffect(() => {
    if (!capabilities) {
      activeSummarySessionIdRef.current = undefined;
      invalidateStopRequest();
      invalidateVisibilityRequest();
      setSummary(undefined);
      return;
    }
    const unsubscribe = capabilities.onSummaryChanged((nextSummary) => {
      const nextSessionId = nextSummary?.sessionId;
      const sessionChanged = nextSessionId !== activeSummarySessionIdRef.current;
      const pendingVisibilityRequest = pendingVisibilityRequestRef.current;
      const visibilityReached = Boolean(
        nextSummary
        && pendingVisibilityRequest
        && nextSummary.sessionId === pendingVisibilityRequest.sessionId
        && nextSummary.conversationId === pendingVisibilityRequest.conversationId
        && nextSummary.visible === pendingVisibilityRequest.targetVisible,
      );
      activeSummarySessionIdRef.current = nextSessionId;
      if (sessionChanged || (nextSummary && stopProjectionOwnsLifecycle(nextSummary.status))) {
        invalidateStopRequest();
        invalidateVisibilityRequest();
      } else if (visibilityReached) {
        invalidateVisibilityRequest();
      }
      setSummary(nextSummary);
    });
    return () => {
      unsubscribe();
      activeSummarySessionIdRef.current = undefined;
      invalidateStopRequest();
      invalidateVisibilityRequest();
    };
  }, [capabilities, invalidateStopRequest, invalidateVisibilityRequest]);

  useEffect(() => {
    invalidateStopRequest();
    invalidateVisibilityRequest();
  }, [invalidateStopRequest, invalidateVisibilityRequest, selectedConversationId]);

  useDesktopComputerUseHostLayoutReporter(capabilities, hostRef);

  if (
    !capabilities
    || !summary
    || summary.conversationId !== selectedConversationId
    || !isHeaderPresentationStatus(summary.status)
  ) {
    return null;
  }
  const stopPending = stopRequest?.sessionId === summary.sessionId && stopRequest.status === "pending";
  const stopFailure = stopRequest?.sessionId === summary.sessionId && stopRequest.status === "failed"
    ? stopRequest.failureKind
    : undefined;
  const visibilityPending = visibilityRequest?.sessionId === summary.sessionId
    && visibilityRequest.status === "pending"
    ? visibilityRequest.action
    : undefined;
  const visibilityFailure = visibilityRequest?.sessionId === summary.sessionId
    && visibilityRequest.status === "failed"
    && summary.visible !== (visibilityRequest.action === "show")
    ? { action: visibilityRequest.action, failureKind: visibilityRequest.failureKind }
    : undefined;
  const requestVisibility = async (action: VisibilityAction): Promise<void> => {
    if (
      pendingVisibilityRequestRef.current
      || activeSummarySessionIdRef.current !== summary.sessionId
      || selectedConversationIdRef.current !== summary.conversationId
    ) {
      return;
    }
    const requestId = visibilityRequestSequenceRef.current + 1;
    visibilityRequestSequenceRef.current = requestId;
    const pendingRequest = {
      requestId,
      sessionId: summary.sessionId,
      conversationId: summary.conversationId,
      action,
      targetVisible: action === "show",
    } satisfies PendingVisibilityRequest;
    pendingVisibilityRequestRef.current = pendingRequest;
    setVisibilityRequest({ requestId, sessionId: summary.sessionId, action, status: "pending" });
    try {
      const result = await waitForDesktopCommand(
        action === "show" ? capabilities.show(summary.sessionId) : capabilities.hide(summary.sessionId),
      );
      if (!isCurrentVisibilityRequest(
        pendingRequest,
        visibilityRequestSequenceRef.current,
        pendingVisibilityRequestRef.current,
        activeSummarySessionIdRef.current,
        selectedConversationIdRef.current,
      )) {
        return;
      }
      if (!result.accepted) {
        pendingVisibilityRequestRef.current = undefined;
        setVisibilityRequest({
          requestId,
          sessionId: summary.sessionId,
          action,
          status: "failed",
          failureKind: "not-accepted",
        });
        return;
      }
      clearVisibilityConvergenceTimeout();
      visibilityConvergenceTimeoutIdRef.current = window.setTimeout(() => {
        visibilityConvergenceTimeoutIdRef.current = undefined;
        if (!isCurrentVisibilityRequest(
          pendingRequest,
          visibilityRequestSequenceRef.current,
          pendingVisibilityRequestRef.current,
          activeSummarySessionIdRef.current,
          selectedConversationIdRef.current,
        )) {
          return;
        }
        pendingVisibilityRequestRef.current = undefined;
        setVisibilityRequest({
          requestId,
          sessionId: summary.sessionId,
          action,
          status: "failed",
          failureKind: "unavailable",
        });
      }, DESKTOP_VISIBILITY_CONVERGENCE_TIMEOUT_MS);
    } catch {
      if (!isCurrentVisibilityRequest(
        pendingRequest,
        visibilityRequestSequenceRef.current,
        pendingVisibilityRequestRef.current,
        activeSummarySessionIdRef.current,
        selectedConversationIdRef.current,
      )) {
        return;
      }
      clearVisibilityConvergenceTimeout();
      pendingVisibilityRequestRef.current = undefined;
      setVisibilityRequest({
        requestId,
        sessionId: summary.sessionId,
        action,
        status: "failed",
        failureKind: "unavailable",
      });
    }
  };
  const requestStop = async (): Promise<void> => {
    if (
      pendingStopRequestRef.current
      || activeSummarySessionIdRef.current !== summary.sessionId
      || selectedConversationIdRef.current !== summary.conversationId
    ) {
      return;
    }
    const requestId = stopRequestSequenceRef.current + 1;
    stopRequestSequenceRef.current = requestId;
    const pendingRequest = {
      requestId,
      sessionId: summary.sessionId,
      conversationId: summary.conversationId,
    } satisfies PendingStopRequest;
    pendingStopRequestRef.current = pendingRequest;
    setStopRequest({ requestId, sessionId: summary.sessionId, status: "pending" });
    try {
      const result = await waitForDesktopCommand(capabilities.stop(summary.sessionId));
      if (!isCurrentStopRequest(
        pendingRequest,
        stopRequestSequenceRef.current,
        pendingStopRequestRef.current,
        activeSummarySessionIdRef.current,
        selectedConversationIdRef.current,
      )) {
        return;
      }
      if (!result.accepted) {
        pendingStopRequestRef.current = undefined;
        setStopRequest({
          requestId,
          sessionId: summary.sessionId,
          status: "failed",
          failureKind: "not-accepted",
        });
        return;
      }
      clearStopConvergenceTimeout();
      stopConvergenceTimeoutIdRef.current = window.setTimeout(() => {
        stopConvergenceTimeoutIdRef.current = undefined;
        if (!isCurrentStopRequest(
          pendingRequest,
          stopRequestSequenceRef.current,
          pendingStopRequestRef.current,
          activeSummarySessionIdRef.current,
          selectedConversationIdRef.current,
        )) {
          return;
        }
        pendingStopRequestRef.current = undefined;
        setStopRequest({
          requestId,
          sessionId: summary.sessionId,
          status: "failed",
          failureKind: "unavailable",
        });
      }, DESKTOP_STOP_CONVERGENCE_TIMEOUT_MS);
    } catch {
      if (!isCurrentStopRequest(
        pendingRequest,
        stopRequestSequenceRef.current,
        pendingStopRequestRef.current,
        activeSummarySessionIdRef.current,
        selectedConversationIdRef.current,
      )) {
        return;
      }
      clearStopConvergenceTimeout();
      pendingStopRequestRef.current = undefined;
      setStopRequest({
        requestId,
        sessionId: summary.sessionId,
        status: "failed",
        failureKind: "unavailable",
      });
    }
  };
  return (
    <CurrentSessionHeaderCapabilityPortal>
      <DesktopComputerUseControlSlot
        summary={summary}
        stopPending={stopPending}
        stopFailure={stopFailure}
        visibilityPending={visibilityPending}
        visibilityFailure={visibilityFailure}
        onToggleVisibility={() => void requestVisibility(summary.visible ? "hide" : "show")}
        onStop={() => void requestStop()}
      />
    </CurrentSessionHeaderCapabilityPortal>
  );
}

async function waitForDesktopCommand(command: Promise<DesktopCommandResult>): Promise<DesktopCommandResult> {
  let timeoutId: number | undefined;
  try {
    return await new Promise<DesktopCommandResult>((resolve, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error("desktop_command_timeout")), DESKTOP_COMMAND_TIMEOUT_MS);
      command.then(resolve, reject);
    });
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

function stopProjectionOwnsLifecycle(status: ComputerUseSummary["status"]): boolean {
  return status === "stopping" || status === "succeeded" || status === "failed" || status === "cancelled";
}

function isHeaderPresentationStatus(status: ComputerUseSummary["status"]): boolean {
  return status === "starting"
    || status === "running"
    || status === "waiting_for_approval"
    || status === "paused"
    || status === "stopping";
}

function isCurrentStopRequest(
  request: PendingStopRequest,
  currentRequestId: number,
  pendingRequest: PendingStopRequest | undefined,
  activeSessionId: string | undefined,
  selectedConversationId: string | undefined,
): boolean {
  return currentRequestId === request.requestId
    && pendingRequest?.requestId === request.requestId
    && activeSessionId === request.sessionId
    && selectedConversationId === request.conversationId;
}

function isCurrentVisibilityRequest(
  request: PendingVisibilityRequest,
  currentRequestId: number,
  pendingRequest: PendingVisibilityRequest | undefined,
  activeSessionId: string | undefined,
  selectedConversationId: string | undefined,
): boolean {
  return currentRequestId === request.requestId
    && pendingRequest?.requestId === request.requestId
    && pendingRequest.action === request.action
    && activeSessionId === request.sessionId
    && selectedConversationId === request.conversationId;
}
