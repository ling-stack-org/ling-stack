import {
  CompactDesktopWindow,
  CompactWindowActionMenu,
  CompactWindowHeader,
  CompactWindowIconButton,
  CompactWindowStatusOverlay,
  StatusIndicator,
  type CompactWindowMenuAction,
  type CompactWindowState,
} from "@ling-stack/ui-react";
import {
  ExternalLink,
  EyeOff,
  LocateFixed,
  MonitorCog,
  RotateCw,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  createComputerUsePreviewTranslator,
  normalizeComputerUsePreviewLocale,
} from "./messages.js";
import type { ComputerUsePreviewController } from "./preview-controller.js";
import type { ComputerUsePreviewMediaController } from "./preview-media-controller.js";
import {
  createComputerUsePreviewViewModel,
  type ComputerUsePreviewActionId,
  type ComputerUsePreviewActionViewModel,
  type ComputerUsePreviewVisualState,
} from "./preview-view-model.js";

const PREVIEW_ACCESSIBLE_NAME_ID = "computer-use-preview-accessible-name";

export function ComputerUsePreviewApp({
  controller,
  mediaController,
}: {
  readonly controller: ComputerUsePreviewController;
  readonly mediaController: ComputerUsePreviewMediaController;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const { openCommandState, snapshot, stopCommandState } = state;
  const locale = normalizeComputerUsePreviewLocale(snapshot.locale);
  const t = useMemo(() => createComputerUsePreviewTranslator(locale), [locale]);
  const viewModel = useMemo(
    () => createComputerUsePreviewViewModel(snapshot, { openCommandState, stopCommandState }),
    [openCommandState, snapshot, stopCommandState],
  );
  const [menuOpen, setMenuOpen] = useState(false);

  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.title = t("windowTitle", { target: snapshot.targetLabel, status: viewModel.label });
  }, [locale, snapshot.targetLabel, t, viewModel.label]);

  useEffect(() => {
    void mediaController.sync(snapshot);
  }, [mediaController, snapshot]);

  useEffect(() => {
    setMenuOpen(false);
  }, [snapshot.sessionId]);

  useEffect(() => {
    const handleWindowBlur = () => controller.reportInteraction("focus", false);
    const previewRoot = document.getElementById("preview-root");
    const handlePointerEnter = () => controller.reportInteraction("hover", true);
    const handlePointerLeave = () => controller.reportInteraction("hover", false);
    window.addEventListener("blur", handleWindowBlur);
    previewRoot?.addEventListener("pointerenter", handlePointerEnter);
    previewRoot?.addEventListener("pointerleave", handlePointerLeave);
    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      previewRoot?.removeEventListener("pointerenter", handlePointerEnter);
      previewRoot?.removeEventListener("pointerleave", handlePointerLeave);
    };
  }, [controller]);

  const invokeAction = useCallback((action: ComputerUsePreviewActionId) => {
    void controller.invokeAction(action).catch(() => undefined);
  }, [controller]);
  const setVideoElement = useCallback((video: HTMLVideoElement | null) => {
    mediaController.setVideoElement(video ?? undefined);
  }, [mediaController]);
  const menuActions = useMemo<readonly CompactWindowMenuAction[]>(() => (
    viewModel.menuActions.map((action) => ({
      className: action.danger ? "menu-item danger" : "menu-item",
      disabled: action.disabled,
      icon: actionIcon(action.id),
      id: action.id,
      label: action.label,
      onSelect: () => invokeAction(action.id),
      separatorBefore: action.separatorBefore,
      tone: action.danger ? "danger" : "default",
    }))
  ), [invokeAction, viewModel.menuActions]);

  return (
    <CompactDesktopWindow
      className="preview-shell"
      content={snapshot.sourceKind === "display_media" ? (
        <div className="preview-frame">
          <video
            ref={setVideoElement}
            aria-label={t("livePreviewLabel")}
            autoPlay
            className="preview-video"
            muted
            playsInline
          />
        </div>
      ) : <FakePreviewFrame />}
      controlsVisibility={viewModel.controlsPersistent ? "persistent" : "hover-focus"}
      data-controls={viewModel.controlsPersistent ? "persistent" : "hover"}
      data-menu-open={menuOpen ? "true" : undefined}
      data-open-command={openCommandState}
      data-stop-command={stopCommandState}
      header={(
        <CompactWindowHeader
          actions={(
            <div className="preview-controls" aria-label={t("previewActionsLabel")} role="toolbar">
              {viewModel.primaryActions.map((action) => (
                <PreviewActionButton
                  key={action.id}
                  action={action}
                  invokeAction={invokeAction}
                />
              ))}
              <CompactWindowActionMenu
                actions={menuActions}
                contentClassName="preview-menu"
                label={t("morePreviewActionsLabel")}
                menuLabel={t("previewMenuLabel")}
                onOpenChange={setMenuOpen}
                open={menuOpen}
                triggerClassName="more-button"
              />
            </div>
          )}
          className="preview-header"
          status={(
            <StatusIndicator
              aria-label={t("previewAccessibleLabel", {
                target: snapshot.targetLabel,
                status: viewModel.label,
              })}
              id={PREVIEW_ACCESSIBLE_NAME_ID}
              label={viewModel.label}
              tone={viewModel.tone}
            />
          )}
          title={snapshot.targetLabel}
        />
      )}
      aria-labelledby={PREVIEW_ACCESSIBLE_NAME_ID}
      onBlurCapture={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          controller.reportInteraction("focus", false);
        }
      }}
      onFocusCapture={() => controller.reportInteraction("focus", true)}
      label={t("previewLabel", { target: snapshot.targetLabel })}
      state={compactWindowState(viewModel.state)}
      status={(() => {
        const issue = viewModel.commandIssue;
        const overlayAction = issue?.action ?? viewModel.overlayAction;
        return (
        <CompactWindowStatusOverlay
          action={overlayAction ? {
            actionId: overlayAction.id,
            className: "status-action",
            label: overlayAction.label,
            loading: overlayAction.disabled,
            onClick: () => invokeAction(overlayAction.id),
          } : undefined}
          ariaLive={issue ? "assertive" : viewModel.ariaLive}
          busy={issue ? false : viewModel.busy}
          className={`preview-status-overlay ${issue ? "prominent command-issue" : viewModel.overlayMode}`}
          detail={issue?.detail ?? viewModel.detail}
          label={issue?.label ?? viewModel.label}
          tone={issue?.tone ?? viewModel.tone}
        />
        );
      })()}
      visualState={viewModel.state}
    />
  );
}

function PreviewActionButton({
  action,
  invokeAction,
}: {
  readonly action: ComputerUsePreviewActionViewModel;
  readonly invokeAction: (action: ComputerUsePreviewActionId) => void;
}) {
  return (
    <CompactWindowIconButton
      className="primary-action"
      data-action-id={action.id}
      disabled={action.disabled}
      icon={actionIcon(action.id)}
      label={action.label}
      loading={action.loading}
      onClick={() => invokeAction(action.id)}
      variant={action.danger ? "danger" : "ghost"}
    />
  );
}

function FakePreviewFrame() {
  return (
    <div className="preview-frame">
      <div className="fake-page" aria-hidden="true">
        <div className="fake-toolbar"><i /><i /><i /><span /></div>
        <div className="fake-body"><aside /><article><b /><b /><b /><b /></article></div>
        <div className="fake-cursor" />
      </div>
    </div>
  );
}

function compactWindowState(state: ComputerUsePreviewVisualState): CompactWindowState {
  if (state === "live") {
    return "live";
  }
  if (state === "connecting" || state === "reconnecting" || state === "stopping") {
    return "busy";
  }
  if (state === "completed" || state === "stopped") {
    return "terminal";
  }
  return "attention";
}

function actionIcon(action: ComputerUsePreviewActionId) {
  return {
    open: <ExternalLink />,
    hide: <EyeOff />,
    reset: <LocateFixed />,
    settings: <MonitorCog />,
    retry: <RotateCw />,
    close: <X />,
    stop: <Square />,
  }[action];
}
