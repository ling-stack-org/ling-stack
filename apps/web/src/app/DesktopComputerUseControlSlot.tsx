import { Eye, EyeOff, LoaderCircle, Square } from "lucide-react";
import { useId } from "react";
import { useI18n, type Translate } from "../i18n.js";

export interface DesktopComputerUseControlSummary {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly status: "starting" | "running" | "waiting_for_approval" | "paused" | "stopping" | "succeeded" | "failed" | "cancelled";
  readonly targetLabel: string;
  readonly visible: boolean;
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
}): JSX.Element {
  const { t } = useI18n();
  const stopFeedbackId = useId();
  const visibilityFeedbackId = useId();
  const stopping = summary.status === "stopping";
  const visibilityLabel = visibilityPending
    ? t(visibilityPending === "show" ? "Showing" : "Hiding")
    : summary.visible ? t("Hide") : t("Show");
  const stopLabel = stopPending || stopping ? t("Stopping") : t("Stop");
  const visibilityActionAvailable = !stopping || summary.visible;

  return (
    <aside
      className="desktop-computer-use-control"
      aria-label={t("Computer Use preview controls")}
      data-status={summary.status}
    >
      <span className="desktop-computer-use-control-dot" aria-hidden="true" />
      <span className="desktop-computer-use-control-label">
        <strong title={summary.targetLabel}>{summary.targetLabel}</strong>
        <small role="status" aria-live="polite" aria-atomic="true">
          {computerUseStatusLabel(summary.status, t)}
        </small>
      </span>
      <span className="desktop-computer-use-control-actions">
        {visibilityActionAvailable ? (
          <button
            type="button"
            className="desktop-computer-use-control-action"
            disabled={visibilityPending !== undefined}
            aria-busy={visibilityPending !== undefined}
            aria-describedby={visibilityFailure ? visibilityFeedbackId : undefined}
            aria-label={visibilityLabel}
            title={visibilityLabel}
            onClick={onToggleVisibility}
          >
            <span className="desktop-computer-use-control-action-icon" aria-hidden="true">
              {visibilityPending
                ? <LoaderCircle className="spin" size={15} />
                : summary.visible ? <EyeOff size={15} /> : <Eye size={15} />}
            </span>
            <span className="desktop-computer-use-control-action-label">{visibilityLabel}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="desktop-computer-use-control-action danger"
          disabled={stopPending || stopping}
          aria-busy={stopPending || stopping}
          aria-describedby={stopFailure ? stopFeedbackId : undefined}
          aria-label={stopLabel}
          title={stopLabel}
          onClick={onStop}
        >
          <span className="desktop-computer-use-control-action-icon" aria-hidden="true">
            {stopPending || stopping ? <LoaderCircle className="spin" size={15} /> : <Square size={14} />}
          </span>
          <span className="desktop-computer-use-control-action-label">{stopLabel}</span>
        </button>
      </span>
      {visibilityFailure || stopFailure ? (
        <span className="desktop-computer-use-control-feedback-stack">
          {visibilityFailure ? (
            <span
              id={visibilityFeedbackId}
              className="desktop-computer-use-control-label desktop-computer-use-control-feedback"
              role="alert"
              aria-live="assertive"
              aria-atomic="true"
              data-visibility-error-action={visibilityFailure.action}
              data-visibility-error-kind={visibilityFailure.failureKind}
            >
              <strong>{visibilityFailureTitle(visibilityFailure.action, t)}</strong>
              <small>{visibilityFailureMessage(visibilityFailure.failureKind, t)}</small>
            </span>
          ) : null}
          {stopFailure ? (
            <span
              id={stopFeedbackId}
              className="desktop-computer-use-control-label desktop-computer-use-control-feedback"
              role="alert"
              aria-live="assertive"
              aria-atomic="true"
              data-stop-error-kind={stopFailure}
            >
              <strong>{t("Unable to stop Computer Use")}</strong>
              <small>{stopFailureMessage(stopFailure, t)}</small>
            </span>
          ) : null}
        </span>
      ) : null}
    </aside>
  );
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
