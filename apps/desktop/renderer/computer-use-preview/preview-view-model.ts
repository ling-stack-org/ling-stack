import type { ComputerUsePipRendererSnapshot } from "../../shared/desktop-capabilities.js";
import {
  createComputerUsePreviewTranslator,
  type ComputerUsePreviewTranslate,
} from "./messages.js";

export type ComputerUsePreviewVisualState =
  | "live"
  | "connecting"
  | "reconnecting"
  | "paused"
  | "approval_required"
  | "stopping"
  | "completed"
  | "stopped"
  | "failed"
  | "stop_failed"
  | "permission_required";

export type ComputerUsePreviewTone = "success" | "neutral" | "warning" | "danger";

export type ComputerUsePreviewActionId = "open" | "reset" | "settings" | "retry" | "hide" | "close" | "stop";

export interface ComputerUsePreviewActionViewModel {
  readonly id: ComputerUsePreviewActionId;
  readonly label: string;
  readonly danger: boolean;
  readonly disabled: boolean;
  readonly loading?: boolean;
  readonly separatorBefore?: boolean;
}

export type ComputerUsePreviewStopCommandState = "idle" | "pending" | "failed";
export type ComputerUsePreviewOpenCommandState = "idle" | "pending" | "failed";

export interface ComputerUsePreviewTransientState {
  readonly stopCommandState?: ComputerUsePreviewStopCommandState;
  readonly openCommandState?: ComputerUsePreviewOpenCommandState;
}

export interface ComputerUsePreviewCommandIssue {
  readonly label: string;
  readonly detail: string;
  readonly tone: "danger";
  readonly action: ComputerUsePreviewActionViewModel;
}

export interface ComputerUsePreviewViewModel {
  readonly state: ComputerUsePreviewVisualState;
  readonly label: string;
  readonly detail?: string;
  readonly tone: ComputerUsePreviewTone;
  readonly overlayMode: "compact" | "prominent";
  readonly controlsPersistent: boolean;
  readonly busy: boolean;
  readonly ariaLive: "polite" | "assertive";
  readonly primaryActions: readonly ComputerUsePreviewActionViewModel[];
  readonly menuActions: readonly ComputerUsePreviewActionViewModel[];
  readonly overlayAction?: ComputerUsePreviewActionViewModel;
  readonly commandIssue?: ComputerUsePreviewCommandIssue;
}

export function createComputerUsePreviewViewModel(
  snapshot: ComputerUsePipRendererSnapshot,
  transient: ComputerUsePreviewTransientState = {},
): ComputerUsePreviewViewModel {
  const t = createComputerUsePreviewTranslator(snapshot.locale);
  const presentation = presentationFor(snapshot, transient, t);
  const actions = actionsFor(snapshot, transient, t);
  const commandIssue = transient.openCommandState === "failed" ? {
    label: t("openTaskFailedLabel"),
    detail: t("openTaskFailedDetail"),
    tone: "danger" as const,
    action: action("open", t("tryOpenTaskAgainAction")),
  } : undefined;
  return {
    ...presentation,
    detail: transient.stopCommandState && transient.stopCommandState !== "idle"
      ? presentation.defaultDetail
      : detailFor(snapshot, presentation.label, presentation.defaultDetail),
    overlayMode: presentation.state === "live" ? "compact" : "prominent",
    controlsPersistent: presentation.state !== "live",
    ...actions,
    overlayAction: transient.stopCommandState === "failed"
      ? action("stop", t("tryStopAgainAction"), true)
      : undefined,
    commandIssue,
  };
}

interface PreviewPresentation {
  readonly state: ComputerUsePreviewVisualState;
  readonly label: string;
  readonly defaultDetail?: string;
  readonly tone: ComputerUsePreviewTone;
  readonly busy: boolean;
  readonly ariaLive: "polite" | "assertive";
}

function presentationFor(
  snapshot: ComputerUsePipRendererSnapshot,
  transient: ComputerUsePreviewTransientState,
  t: ComputerUsePreviewTranslate,
): PreviewPresentation {
  if (snapshot.runtimeStatus === "failed") {
    return presentation("failed", t("failedLabel"), t("computerUseFailedDetail"), "danger", false, "assertive");
  }
  if (snapshot.runtimeStatus === "succeeded") {
    return presentation("completed", t("completedLabel"), t("computerUseCompletedDetail"), "success");
  }
  if (snapshot.runtimeStatus === "cancelled") {
    return presentation("stopped", t("stoppedLabel"), t("computerUseStoppedDetail"), "neutral");
  }
  if (snapshot.runtimeStatus === "stopping") {
    return presentation("stopping", t("stoppingLabel"), t("waitingForStopConfirmationDetail"), "neutral", true);
  }
  if (transient.stopCommandState === "pending") {
    return presentation("stopping", t("stoppingLabel"), t("requestingStopDetail"), "neutral", true);
  }
  if (transient.stopCommandState === "failed") {
    return presentation(
      "stop_failed",
      t("stopFailedLabel"),
      t("stopFailedDetail"),
      "danger",
      false,
      "assertive",
    );
  }
  if (snapshot.sourceStatus === "permission_denied") {
    return presentation(
      "permission_required",
      t("permissionRequiredLabel"),
      t("permissionRequiredDetail"),
      "warning",
      false,
      "assertive",
    );
  }
  if (snapshot.sourceStatus === "failed") {
    return presentation("failed", t("failedLabel"), t("previewCaptureFailedDetail"), "danger", false, "assertive");
  }
  if (snapshot.runtimeStatus === "waiting_for_approval") {
    return presentation(
      "approval_required",
      t("approvalRequiredLabel"),
      t("approvalRequiredDetail"),
      "warning",
      false,
      "assertive",
    );
  }
  if (snapshot.runtimeStatus === "paused") {
    return presentation("paused", t("pausedLabel"), t("computerUsePausedDetail"), "neutral");
  }
  if (snapshot.sourceStatus === "stalled" || snapshot.sourceStatus === "ended") {
    return presentation("reconnecting", t("reconnectingLabel"), t("reconnectingDetail"), "warning", true);
  }
  if (
    snapshot.runtimeStatus === "starting" ||
    snapshot.sourceStatus === "idle" ||
    snapshot.sourceStatus === "connecting" ||
    !snapshot.frameReady
  ) {
    return presentation("connecting", t("connectingLabel"), t("connectingDetail"), "neutral", true);
  }
  return presentation("live", t("liveLabel"), undefined, "success");
}

function presentation(
  state: ComputerUsePreviewVisualState,
  label: string,
  defaultDetail: string | undefined,
  tone: ComputerUsePreviewTone,
  busy = false,
  ariaLive: "polite" | "assertive" = "polite",
): PreviewPresentation {
  return { state, label, defaultDetail, tone, busy, ariaLive };
}

function detailFor(
  snapshot: ComputerUsePipRendererSnapshot,
  label: string,
  fallback: string | undefined,
): string | undefined {
  const message = snapshot.statusDetail?.trim();
  if (message && message.toLocaleLowerCase() !== label.toLocaleLowerCase()) {
    return message;
  }
  return fallback;
}

function actionsFor(
  snapshot: ComputerUsePipRendererSnapshot,
  transient: ComputerUsePreviewTransientState,
  t: ComputerUsePreviewTranslate,
): Pick<ComputerUsePreviewViewModel, "primaryActions" | "menuActions"> {
  const primaryActions: ComputerUsePreviewActionViewModel[] = [
    action(
      "open",
      t("openTaskAction"),
      false,
      transient.openCommandState === "pending",
      false,
      transient.openCommandState === "pending",
    ),
    action("hide", t("hideAction")),
  ];
  const menuActions: ComputerUsePreviewActionViewModel[] = [
    action("reset", t("resetPositionAction")),
  ];
  if (snapshot.canOpenSettings) {
    menuActions.push(
      action("settings", t("screenSettingsAction")),
      action("retry", t("retryCaptureAction")),
    );
  }
  menuActions.push(action("close", t("closeWindowAction")));
  if (snapshot.canStop) {
    menuActions.push(action(
      "stop",
      transient.stopCommandState === "failed" ? t("tryStopAgainAction") : t("stopComputerUseAction"),
      true,
      transient.stopCommandState === "pending",
      true,
    ));
  }
  return { primaryActions, menuActions };
}

function action(
  id: ComputerUsePreviewActionId,
  label: string,
  danger = false,
  disabled = false,
  separatorBefore = false,
  loading = false,
): ComputerUsePreviewActionViewModel {
  return {
    id,
    label,
    danger,
    disabled,
    ...(separatorBefore ? { separatorBefore: true } : {}),
    ...(loading ? { loading: true } : {}),
  };
}
