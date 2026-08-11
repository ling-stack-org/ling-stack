import {
  CurrentSessionCapabilityControl,
  type CapabilityAction,
  type CapabilityIssue,
  type StatusTone,
} from "../shared/ui/index.js";
import { Eye, EyeOff, Square } from "lucide-react";
import { useId } from "react";
import { useI18n, type Translate } from "../i18n.js";

export interface DesktopComputerUseControlSummary {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly status: "starting" | "running" | "waiting_for_approval" | "paused" | "stopping" | "succeeded" | "failed" | "cancelled";
  readonly targetLabel: string;
  readonly previewAvailable: boolean;
  readonly visible: boolean;
  readonly activePageId?: string;
  readonly pageCount: number;
}

export type DesktopComputerUseCommandFailureKind = "not-accepted" | "unavailable";
export type DesktopComputerUseVisibilityAction = "show" | "hide";

export function DesktopComputerUseControlSlot({
  summary,
  stopPending,
  stopFailure,
  visibilityPending,
  visibilityFailure,
  onToggleVisibility,
  onStop,
}: {
  readonly summary: DesktopComputerUseControlSummary;
  readonly stopPending: boolean;
  readonly stopFailure?: DesktopComputerUseCommandFailureKind;
  readonly visibilityPending?: DesktopComputerUseVisibilityAction;
  readonly visibilityFailure?: {
    readonly action: DesktopComputerUseVisibilityAction;
    readonly failureKind: DesktopComputerUseCommandFailureKind;
  };
  readonly onToggleVisibility: () => void;
  readonly onStop: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const stopFeedbackId = useId();
  const visibilityFeedbackId = useId();
  const stopping = summary.status === "stopping";
  const visibilityLabel = visibilityPending
    ? t(visibilityPending === "show" ? "Showing" : "Hiding")
    : summary.visible ? t("Hide") : t("Show");
  const stopLabel = stopPending || stopping ? t("Stopping") : t("Stop");
  const visibilityActionAvailable = summary.visible || (summary.previewAvailable && !stopping);
  const issue = buildCapabilityIssue({
    stopFailure,
    stopFeedbackId,
    visibilityFailure,
    visibilityFeedbackId,
    t,
  });
  const actions: CapabilityAction[] = [];
  if (visibilityActionAvailable) {
    actions.push({
      describedBy: issue?.id === visibilityFeedbackId ? visibilityFeedbackId : undefined,
      disabled: visibilityPending !== undefined,
      icon: summary.visible ? <EyeOff /> : <Eye />,
      id: "visibility",
      label: visibilityLabel,
      loading: visibilityPending !== undefined,
      onClick: onToggleVisibility,
      pressed: summary.visible,
    });
  }
  actions.push({
    describedBy: issue?.id === stopFeedbackId ? stopFeedbackId : undefined,
    disabled: stopPending || stopping,
    icon: <Square />,
    id: "stop",
    label: stopLabel,
    loading: stopPending || stopping,
    onClick: onStop,
    tone: "danger",
  });

  return (
    <CurrentSessionCapabilityControl
      actions={actions}
      aria-label={t("Computer Use preview controls")}
      className="desktop-computer-use-control"
      data-status={summary.status}
      issue={issue}
      label={summary.targetLabel}
      statusLabel={computerUseStatusLabel(summary.status, t)}
      tone={computerUseStatusTone(summary.status)}
    />
  );
}

function buildCapabilityIssue({
  stopFailure,
  stopFeedbackId,
  visibilityFailure,
  visibilityFeedbackId,
  t,
}: {
  readonly stopFailure?: DesktopComputerUseCommandFailureKind;
  readonly stopFeedbackId: string;
  readonly visibilityFailure?: {
    readonly action: DesktopComputerUseVisibilityAction;
    readonly failureKind: DesktopComputerUseCommandFailureKind;
  };
  readonly visibilityFeedbackId: string;
  readonly t: Translate;
}): CapabilityIssue | undefined {
  if (stopFailure) {
    return {
      attributes: {
        "aria-atomic": true,
        "aria-live": "assertive",
        "data-stop-error-kind": stopFailure,
      },
      id: stopFeedbackId,
      message: (
        <>
          <strong>{t("Unable to stop Computer Use")}</strong>
          <span>{stopFailureMessage(stopFailure, t)}</span>
        </>
      ),
      tone: "danger",
    };
  }
  if (!visibilityFailure) {
    return undefined;
  }
  return {
    attributes: {
      "aria-atomic": true,
      "aria-live": "assertive",
      "data-visibility-error-action": visibilityFailure.action,
      "data-visibility-error-kind": visibilityFailure.failureKind,
    },
    id: visibilityFeedbackId,
    message: (
      <>
        <strong>{visibilityFailureTitle(visibilityFailure.action, t)}</strong>
        <span>{visibilityFailureMessage(visibilityFailure.failureKind, t)}</span>
      </>
    ),
    tone: "danger",
  };
}

function visibilityFailureTitle(action: DesktopComputerUseVisibilityAction, t: Translate): string {
  return action === "show" ? t("Unable to show preview") : t("Unable to hide preview");
}

function visibilityFailureMessage(failureKind: DesktopComputerUseCommandFailureKind, t: Translate): string {
  return failureKind === "not-accepted"
    ? t("The preview request was not accepted. The task is still running. Try again.")
    : t("Desktop could not update the preview. The task is still running. Try again.");
}

function stopFailureMessage(failureKind: DesktopComputerUseCommandFailureKind, t: Translate): string {
  return failureKind === "not-accepted"
    ? t("The stop request was not accepted. The task may still be running. Try again.")
    : t("Desktop could not send the stop request. The task may still be running. Try again.");
}

function computerUseStatusLabel(status: DesktopComputerUseControlSummary["status"], t: Translate): string {
  return {
    starting: t("Starting"),
    running: t("Live"),
    waiting_for_approval: t("Approval required"),
    paused: t("Paused"),
    stopping: t("Stopping"),
    succeeded: t("Completed"),
    failed: t("Failed"),
    cancelled: t("Stopped"),
  }[status];
}

function computerUseStatusTone(status: DesktopComputerUseControlSummary["status"]): StatusTone {
  return {
    starting: "info",
    running: "success",
    waiting_for_approval: "warning",
    paused: "neutral",
    stopping: "warning",
    succeeded: "success",
    failed: "danger",
    cancelled: "neutral",
  }[status] as StatusTone;
}
